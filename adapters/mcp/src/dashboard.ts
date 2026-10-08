import type { OpenCodeGateway } from "./opencode.js";
import type { ProjectBoardService } from "./taskboard.js";
import { READ_PAYLOAD_BYTES, jsonBytes } from "./content.js";
import { isRecord } from "./types.js";

export type Inventory = Awaited<ReturnType<OpenCodeGateway["readDashboardInventory"]>>;
export type Session = Awaited<ReturnType<OpenCodeGateway["readDashboardSession"]>>;
export type Tasks = Awaited<ReturnType<ProjectBoardService["readDashboardTasks"]>>;
export type DashboardReader = {
  inventory(): Promise<Inventory>;
  session(session: Inventory["sessions"][number]): Promise<Session>;
  board(): Promise<Tasks>;
  activity(ids: Set<string>): Promise<unknown>;
};

/** Read-only projection surface shared by the browser dashboard and the MCP app.
 * The adapter wires one collector behind this contract; both transports stay thin. */
export type DashboardControl = {
  overview(): unknown;
  refresh(): Promise<unknown>;
  session(sessionId: string): Promise<unknown>;
};

export type UiService = {
  kind: "dashboard" | "mcp-app";
  generation: string;
  adapterVersion?: string;
};
type Source = { observed_at: string | null; last_success_at: string | null; complete: boolean; error: string | null };
const source = (): Source => ({ observed_at: null, last_success_at: null, complete: false, error: null });
const operational = (s: Session) => s.backend_activity !== "idle" || s.pending_input.permissions + s.pending_input.questions > 0 || s.turns.some(t => t.active || t.state === "submitted");

/** One volatile cache per owned project runtime. HTTP reads never collect. */
export class DashboardCollector {
  private inventory?: Inventory;
  private sessions: Session[] = [];
  private unknown: Array<{ session_id: string; title: string; parent_session_id: string | null; archived: boolean }> = [];
  private tasks: Tasks = [];
  private recent: unknown = null;
  private sources = { sessions: source(), discovery: source(), board: source(), activity: source() };
  private lastDiscovery = -Infinity;
  private lastBoard = -Infinity;
  private revision = 0;
  private collecting?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(readonly project: { id: string; name: string }, public generation: string,
    private readonly reader: DashboardReader, private readonly now = Date.now) {}

  resetGeneration(generation: string) {
    if (this.generation === generation) return;
    this.generation = generation;
    this.sessions = []; this.unknown = []; this.tasks = []; this.inventory = undefined; this.recent = null;
    this.sources = { sessions: source(), discovery: source(), board: source(), activity: source() };
    this.lastDiscovery = this.lastBoard = -Infinity; this.revision++;
  }

  private async read(name: keyof DashboardCollector["sources"], collect: () => Promise<boolean>) {
    const generation = this.generation;
    try {
      const complete = await collect();
      if (generation !== this.generation) return;
      const time = new Date(this.now()).toISOString();
      this.sources[name] = { observed_at: time, last_success_at: time, complete,
        error: complete ? null : "READ_COVERAGE_INCOMPLETE" };
    } catch {
      if (generation !== this.generation) return;
      this.sources[name] = { ...this.sources[name], complete: false, error: "SOURCE_UNAVAILABLE" };
    }
  }

  tick(): Promise<void> {
    if (this.collecting) return this.collecting;
    const generation = this.generation;
    this.collecting = (async () => {
      const time = this.now();
      const board = time - this.lastBoard >= 15000 ? this.read("board", async () => {
        this.lastBoard = time;
        const tasks = await this.reader.board();
        if (generation !== this.generation) return false;
        this.tasks = tasks; return tasks.length <= 500;
      }) : Promise.resolve();
      if (time - this.lastDiscovery >= 15000 || !this.inventory) {
        await this.read("discovery", async () => {
          this.lastDiscovery = time;
          const inventory = await this.reader.inventory();
          if (generation !== this.generation) return false;
          this.inventory = inventory; return inventory.complete;
        });
      }
      await this.read("sessions", async () => {
        if (!this.inventory) throw new Error("No inventory");
        const items = this.inventory.sessions;
        const result: Session[] = [];
        let offset = 0, failed = false;
        const deadline = this.now() + 10000;
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (offset < items.length && this.now() <= deadline) {
            const item = items[offset++];
            if (!item) break;
            try { result.push(await this.reader.session(item)); }
            catch {
              failed = true;
              const previous = this.sessions.find(s => s.session_id === item.id);
              if (previous) result.push(previous);
            }
          }
        }));
        if (generation !== this.generation) return false;
        // Budget gaps must preserve known rows, never hide earlier activity.
        if (offset < items.length) {
          failed = true;
          for (const item of items.slice(offset)) {
            const previous = this.sessions.find(s => s.session_id === item.id);
            if (previous) result.push(previous);
          }
        }
        this.sessions = result;
        const known = new Set(result.map(s => s.session_id));
        this.unknown = items.filter(item => !known.has(item.id)).map(item => ({ session_id: item.id,
          title: item.title.slice(0,240), parent_session_id: item.parentID ?? null, archived: Boolean(item.time.archived) }));
        return !failed && offset >= items.length && result.length <= 200 && result.filter(operational).length <= 50;
      });
      await this.read("activity", async () => {
        const recent = await this.reader.activity(new Set(this.sessions.map(s => s.session_id)));
        if (generation !== this.generation) return false;
        this.recent = recent; return true;
      });
      await board;
      this.revision++;
    })().finally(() => { this.collecting = undefined; });
    return this.collecting;
  }

  start() {
    this.stopped = false;
    const run = async () => {
      const started = Date.now();
      await this.tick();
      if (!this.stopped) this.timer = setTimeout(run, Math.max(0, 5000 - (Date.now() - started)));
    };
    void run();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }

  /** One row of evidence: Board, backend activity, correlated turns and runtime
   * stay separate; missing freshness downgrades the row to unknown, never idle. */
  private sessionRow(s: Session, freshBoard: boolean, rowFresh: boolean) {
    const direct = this.tasks.flatMap(task => task.links.filter(link => link.session_id === s.session_id)
      .map(link => ({ task_id: task.task_id, session_id: s.session_id, message_id: link.message_id,
        scope: link.message_id ? "message" : "session", source: "board_link" })));
    const inherited = s.parent_session_id ? this.tasks.filter(task => task.links.some(link => link.session_id === s.parent_session_id))
      .filter(task => !direct.some(link => link.task_id === task.task_id))
      .map(task => ({ task_id: task.task_id, session_id: s.session_id, message_id: null,
        scope: "parent_indirect", source: "board_parent_link" })) : [];
    const associations = [...direct, ...inherited];
    const latest = s.turns.at(-1);
    return { ...s, state: rowFresh ? s.pending_input.permissions + s.pending_input.questions > 0 ? "input_required" : s.backend_activity === "retry" ? "retry" : s.backend_activity === "busy" ? "running" : latest?.state === "submitted" ? "submitted" : s.turns.some(t => t.active || t.state === "submitted") ? "unknown" : "idle" : "unknown",
      operational: operational(s), freshness: rowFresh ? "fresh" : "stale",
      binding_state: !freshBoard ? "unknown" : associations.length ? "known" : "unbound",
      current_turn_unbound: latest ? !direct.some(a => a.message_id === latest.user_message_id) : null,
      associations,
      anomaly: s.archived && operational(s) ? "ARCHIVED_ACTIVE" : null };
  }

  private sourceFresh(name: keyof DashboardCollector["sources"], time = this.now()) {
    const value = this.sources[name];
    const age = value.observed_at ? Math.max(0, time - Date.parse(value.observed_at)) : null;
    const threshold = name === "board" || name === "discovery" ? 45000 : 15000;
    return value.error === null && age !== null && age <= threshold && value.complete;
  }

  private recentFor(sessionId: string) {
    return isRecord(this.recent) && Array.isArray(this.recent.recent)
      ? this.recent.recent.filter((event): event is Record<string, unknown> =>
          isRecord(event) && event.session_id === sessionId).slice(-10).reverse()
      : [];
  }

  /** Fresh single-session read for the read-only MCP app; one admitted session,
   * bounded to its correlated turns and up to ten metadata events. */
  async readSessionDetail(sessionId: string) {
    const item = this.inventory?.sessions.find(session => session.id === sessionId);
    if (!item) return { found: false as const };
    const session = await this.reader.session(item);
    return { found: true as const, observed_at: new Date(this.now()).toISOString(),
      row: this.sessionRow(session, this.sourceFresh("board"), true), recent: this.recentFor(sessionId) };
  }

  snapshot(summary = false) {
    const time = this.now();
    const sources = Object.fromEntries(Object.entries(this.sources).map(([name, value]) => {
      const age = value.observed_at ? Math.max(0, time - Date.parse(value.observed_at)) : null;
      const threshold = name === "board" || name === "discovery" ? 45000 : 15000;
      return [name, { ...value, age_ms: age, stale_after_ms: threshold,
        state: value.error ? "degraded" : age === null ? "unknown" : age > threshold ? "stale" : "fresh" }];
    }));
    const fresh = (name: string) => sources[name]?.state === "fresh" && sources[name]?.complete;
    const sessions = this.sessions.map(s => this.sessionRow(s,
      fresh("board"), fresh("sessions") && time - Date.parse(s.observed_at) <= 15000));
    const active = sessions.filter(s => s.operational);
    const attention = active.filter(s => s.state === "input_required" || s.state === "unknown" || s.anomaly);
    const taskIds = new Set(active.flatMap(s => s.associations.map(a => a.task_id)));
    const complete = fresh("sessions") && fresh("discovery");
    const base = { schema_version: 1, project: this.project, generation: this.generation,
      snapshot_id: `${this.generation}:${this.revision}`, generated_at: new Date(time).toISOString(), sources,
      counts: { active_sessions: complete ? active.length : null, known_active_sessions: active.length,
        attention_sessions: complete ? attention.length : null, active_tasks: complete && fresh("board") ? taskIds.size : null },
      coverage: { sessions_complete: complete, bindings_complete: fresh("board"), recent_complete: false },
      capabilities: { all_session_scope: true, task_links: fresh("board"), prepared_attention: false },
      attention: attention.slice(0, 10).map(s => ({ session_id: s.session_id, state: s.state, anomaly: s.anomaly })) };
    if (summary) return base;
    return { ...base, sessions, unknown_sessions: this.unknown, tasks: this.tasks.filter(task => sessions.some(s => s.associations.some(a => a.task_id === task.task_id))), recent: this.recent };
  }
}

const UI_PROJECTION_BYTES = READ_PAYLOAD_BYTES - 4096;

/** Bounded, deterministic projection for the shared Repo Live UI. Rows are kept
 * by priority (operational sessions, tasks, idle sessions, unknown rows, recent
 * events) under the structured read budget; anything omitted is counted in an
 * explicit truncation object — never silently dropped or replaced by a verdict. */
export function boundedUiProjection(snapshot: ReturnType<DashboardCollector["snapshot"]>, service: UiService) {
  if (!("sessions" in snapshot)) throw new Error("Repo Live UI projection requires the detail snapshot.");
  const activity = isRecord(snapshot.recent) && Array.isArray(snapshot.recent.recent)
    ? { ...snapshot.recent, recent: [...snapshot.recent.recent] as unknown[] } : null;
  const base = { ...snapshot, sessions: [] as unknown[], unknown_sessions: [] as unknown[], tasks: [] as unknown[],
    recent: activity ? { ...activity, recent: [] as unknown[] } : null, service, truncation: null as unknown };
  let remaining = UI_PROJECTION_BYTES - jsonBytes(base);
  const take = <T>(items: T[]) => {
    const kept: T[] = []; let omitted = 0;
    for (const item of items) {
      const cost = jsonBytes(item) + 1;
      if (cost <= remaining) { kept.push(item); remaining -= cost; } else omitted++;
    }
    return { kept, omitted };
  };
  const operationalRows = take(snapshot.sessions.filter(session => session.operational));
  const tasks = take(snapshot.tasks);
  const idleRows = take(snapshot.sessions.filter(session => !session.operational));
  const unknown = take(snapshot.unknown_sessions ?? []);
  const events = take(activity?.recent ?? []);
  const omittedTotal = operationalRows.omitted + idleRows.omitted + tasks.omitted + unknown.omitted + events.omitted;
  return { ...base,
    sessions: [...operationalRows.kept, ...idleRows.kept],
    tasks: tasks.kept,
    unknown_sessions: unknown.kept,
    recent: activity ? { ...activity, recent: events.kept } : null,
    truncation: omittedTotal === 0 ? null : { sessions: operationalRows.omitted + idleRows.omitted, tasks: tasks.omitted,
      unknown_sessions: unknown.omitted, recent: events.omitted, reason: "READ_RESPONSE_BUDGET" as const } };
}

/** Shared read-only control wiring for the adapter: overview, refresh and one
 * session detail all lazily collect once and then at most every 2s. A detail
 * call before the first collection therefore still sees the admitted inventory
 * instead of reporting an in-scope session as missing. */
export function createDashboardControl(collector: DashboardCollector, service: UiService,
  now: () => number = Date.now): DashboardControl {
  let lastTick = 0;
  const ensureCollected = async () => {
    if (now() - lastTick > 2000) { lastTick = now(); await collector.tick(); }
  };
  return {
    overview: () => boundedUiProjection(collector.snapshot(false), service),
    refresh: async () => { await ensureCollected(); return boundedUiProjection(collector.snapshot(false), service); },
    session: async (sessionId: string) => {
      await ensureCollected();
      const detail = await collector.readSessionDetail(sessionId);
      return detail.found
        ? { found: true, service, observed_at: detail.observed_at, session: detail.row, recent: detail.recent }
        : { found: false, service };
    },
  };
}
