import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./types.js";

/**
 * W3 Monitor Engine — persistent registry + deterministic state machines.
 *
 * The registry is the single canonical truth for every monitor: scheduler
 * state, work state, run/technical activity, runtime profile reference,
 * autonomy profile, activity cursors, repair budget, read episodes, wake
 * requests, bounded run history and bounded logs. All writers (engine service
 * and MCP tools) serialize through a cooperating mkdir lock and CAS with a
 * monotonic generation counter; publication is atomic (tmp + rename).
 */

export const MONITOR_SCHEMA = 1;
export const MONITOR_HISTORY_LIMIT = 200;
export const MONITOR_LOG_LIMIT = 200;
export const MONITOR_REPAIR_LIMIT = 2;
export const DEFAULT_MONITOR_INTERVAL_SECONDS = 60;
const READ_BACKOFF_MS = [15_000, 45_000, 120_000];
const LOCK_STALE_MS = 10_000;

export type MonitorWorkState =
  | "active"
  | "parked_input_required"
  | "complete_pass"
  | "stopped";
export type MonitorAutonomyProfile = "conservative" | "sandbox" | "mvp" | "yolo";
export type MonitorRuntimeProfile =
  | "deep"
  | "standard"
  | "execution"
  | "design"
  | "review";

export type MonitorHistoryEntry = {
  at: string;
  type: string;
  detail?: Record<string, unknown>;
};
export type MonitorLogEntry = { at: string; level: "info" | "warn" | "error"; message: string };

export type MonitorRepairEntry = {
  at: string;
  kind: "production-code" | "excluded";
  evidenced_progress: boolean;
  note?: string;
};

export type MonitorRecord = {
  id: string;
  title: string;
  anchor: { task_id: string };
  scheduler: {
    enabled: boolean;
    interval_seconds: number;
    next_run_at: number | null;
    expiry_at: number | null;
  };
  autonomy_profile: MonitorAutonomyProfile;
  runtime_profile: MonitorRuntimeProfile;
  session: { session_id: string | null; title: string | null; primed_at: string | null };
  state: { work: MonitorWorkState; parked_reason?: string; last_seen_digest: string | null; watermark: string | null };
  cursors: Record<string, string>;
  budget: Record<string, { no_progress: number; entries: MonitorRepairEntry[] }>;
  read_episodes: Record<
    string,
    { attempts: number; next_at: number | null; exhausted_at: string | null; alerted: boolean }
  >;
  run: { active: boolean; started_at: string | null; action: string | null };
  recovery: { active: boolean; started_at: string | null; last_error_fingerprint: string | null };
  dispatch_wal: {
    action_id: string;
    at: string;
    prompt_digest: string;
    message_id: string | null;
  } | null;
  wake_request: { requested_at: string; reason: string } | null;
  history: MonitorHistoryEntry[];
  logs: MonitorLogEntry[];
  created_at: string;
  updated_at: string;
};

export type MonitorRegistry = {
  schema: 1;
  generation: number;
  monitors: MonitorRecord[];
};

export type RegistrySnapshot = { registry: MonitorRegistry; path: string };

export function monitorRegistryDirectory(project: string): string {
  return join(project, ".opencode-vm", "monitor");
}
export function monitorRegistryPath(project: string): string {
  return join(monitorRegistryDirectory(project), "registry.json");
}

function emptyRegistry(): MonitorRegistry {
  return { schema: MONITOR_SCHEMA, generation: 0, monitors: [] };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function monitorId(): string {
  return `monitor_${randomUUID().replaceAll("-", "")}`;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value);
}

export function defaultMonitorRecord(
  title: string,
  taskId: string,
  overrides: {
    interval_seconds?: number;
    autonomy_profile?: MonitorAutonomyProfile;
    runtime_profile?: MonitorRuntimeProfile;
    expiry_at?: number | null;
  },
  now: number,
): MonitorRecord {
  const at = new Date(now).toISOString();
  return {
    id: monitorId(),
    title,
    anchor: { task_id: taskId },
    scheduler: {
      enabled: true,
      interval_seconds: overrides.interval_seconds ?? DEFAULT_MONITOR_INTERVAL_SECONDS,
      next_run_at: now + (overrides.interval_seconds ?? DEFAULT_MONITOR_INTERVAL_SECONDS) * 1000,
      expiry_at: overrides.expiry_at ?? null,
    },
    autonomy_profile: overrides.autonomy_profile ?? "mvp",
    runtime_profile: overrides.runtime_profile ?? "deep",
    session: { session_id: null, title: null, primed_at: null },
    state: { work: "active", last_seen_digest: null, watermark: null },
    cursors: {},
    budget: {},
    read_episodes: {},
    run: { active: false, started_at: null, action: null },
    recovery: { active: false, started_at: null, last_error_fingerprint: null },
    dispatch_wal: null,
    wake_request: null,
    history: [],
    logs: [],
    created_at: at,
    updated_at: at,
  };
}

function shapeOk(registry: unknown): registry is MonitorRegistry {
  if (!isRecord(registry)) return false;
  if (registry.schema !== MONITOR_SCHEMA) return false;
  if (!Number.isSafeInteger(registry.generation) || (registry.generation as number) < 0) return false;
  if (!Array.isArray(registry.monitors)) return false;
  const ids = new Set<string>();
  for (const monitor of registry.monitors) {
    if (!isRecord(monitor)) return false;
    if (typeof monitor.id !== "string" || !/^monitor_[0-9a-f]{32}$/.test(monitor.id)) return false;
    if (ids.has(monitor.id)) return false;
    ids.add(monitor.id);
    if (typeof monitor.title !== "string" || monitor.title.length < 1 || monitor.title.length > 160) return false;
    if (!isRecord(monitor.anchor) || typeof monitor.anchor.task_id !== "string") return false;
    if (!isRecord(monitor.scheduler) || typeof monitor.scheduler.enabled !== "boolean") return false;
    if (!Number.isSafeInteger(monitor.scheduler.interval_seconds) ||
      (monitor.scheduler.interval_seconds as number) < 5 ||
      (monitor.scheduler.interval_seconds as number) > 86_400) return false;
    if (!(["conservative", "sandbox", "mvp", "yolo"] as const).includes(monitor.autonomy_profile as never)) return false;
    if (!(["deep", "standard", "execution", "design", "review"] as const).includes(monitor.runtime_profile as never)) return false;
    if (!isRecord(monitor.state) ||
      !(["active", "parked_input_required", "complete_pass", "stopped"] as const).includes(monitor.state.work as never)) return false;
    if (!Array.isArray(monitor.history) || !Array.isArray(monitor.logs)) return false;
    if (!validIso(monitor.created_at) || !validIso(monitor.updated_at)) return false;
  }
  return true;
}

export async function readRegistrySnapshot(project: string): Promise<RegistrySnapshot> {
  const path = monitorRegistryPath(project);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error("unsafe monitor registry");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!shapeOk(parsed)) throw new Error("invalid monitor registry");
    return { registry: parsed, path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { registry: emptyRegistry(), path };
    throw error;
  }
}

async function acquireLock(directory: string, now: number): Promise<() => Promise<void>> {
  const lock = join(directory, ".lock");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      const owner = join(lock, "owner");
      await writeFile(owner, `${process.pid}\n${now}\n`, { mode: 0o600 });
      return async () => {
        await rm(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await lstat(lock);
        if (now - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("monitor registry lock could not be acquired");
}

async function publishRegistry(directory: string, path: string, registry: MonitorRegistry): Promise<void> {
  const tmp = join(directory, `.registry.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  const serialized = JSON.stringify(registry, null, 2) + "\n";
  await writeFile(tmp, serialized, { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Serialized read-modify-write with a monotonic generation (CAS). The mutator
 * receives a deep clone and must return the next registry; `expected` may pin
 * the generation observed by the caller and rejects a concurrent change.
 */
export async function withRegistry(
  project: string,
  mutate: (registry: MonitorRegistry) => MonitorRegistry | void | Promise<MonitorRegistry | void>,
  options: { expected?: number; now?: number } = {},
): Promise<MonitorRegistry> {
  const directory = monitorRegistryDirectory(project);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(project);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("unsafe monitor project root");
  const release = await acquireLock(directory, options.now ?? Date.now());
  try {
    const snapshot = await readRegistrySnapshot(project);
    if (options.expected !== undefined && snapshot.registry.generation !== options.expected) {
      throw new Error("monitor registry changed concurrently");
    }
    const draft: MonitorRegistry = JSON.parse(JSON.stringify(snapshot.registry));
    const next = (await mutate(draft)) ?? draft;
    next.generation = snapshot.registry.generation + 1;
    if (!shapeOk(next)) throw new Error("monitor registry mutation produced an invalid shape");
    await publishRegistry(directory, snapshot.path, next);
    return next;
  } finally {
    await release();
  }
}

export function monitorHistory(monitor: MonitorRecord, type: string, detail?: Record<string, unknown>, now = Date.now()): void {
  monitor.history.push({ at: new Date(now).toISOString(), type, ...(detail ? { detail } : {}) });
  if (monitor.history.length > MONITOR_HISTORY_LIMIT)
    monitor.history.splice(0, monitor.history.length - MONITOR_HISTORY_LIMIT);
}
export function monitorLog(monitor: MonitorRecord, level: "info" | "warn" | "error", message: string, now = Date.now()): void {
  const redacted = message.replace(/[\r\n]+/g, " ").slice(0, 300);
  monitor.logs.push({ at: new Date(now).toISOString(), level, message: redacted });
  if (monitor.logs.length > MONITOR_LOG_LIMIT)
    monitor.logs.splice(0, monitor.logs.length - MONITOR_LOG_LIMIT);
}

export type RepairDecision =
  | { outcome: "recorded"; counters: { no_progress: number } }
  | { outcome: "progress-reset"; counters: { no_progress: number } }
  | { outcome: "excluded" }
  | { outcome: "parked"; counters: { no_progress: number } };

/**
 * Deterministic W2-r43 repair accounting. Only production-code repairs of the
 * same fingerprint count; management/reads/result fetch/receipts/docs/plans/
 * tests/fixtures/harness/infrastructure are excluded and never count or park.
 * Evidenced progress resets the no-progress series; history is retained.
 */
export function recordRepair(
  monitor: MonitorRecord,
  fingerprint: string,
  kind: "production-code" | "excluded",
  evidencedProgress: boolean,
  now: number,
): RepairDecision {
  const bucket = monitor.budget[fingerprint] ?? { no_progress: 0, entries: [] };
  if (kind === "excluded") {
    bucket.entries.push({ at: new Date(now).toISOString(), kind, evidenced_progress: false });
    if (bucket.entries.length > 50) bucket.entries.splice(0, bucket.entries.length - 50);
    monitor.budget[fingerprint] = bucket;
    return { outcome: "excluded" };
  }
  if (evidencedProgress) {
    bucket.entries.push({ at: new Date(now).toISOString(), kind, evidenced_progress: true });
    if (bucket.entries.length > 50) bucket.entries.splice(0, bucket.entries.length - 50);
    bucket.no_progress = 0;
    monitor.budget[fingerprint] = bucket;
    return { outcome: "progress-reset", counters: { no_progress: 0 } };
  }
  if (bucket.no_progress >= MONITOR_REPAIR_LIMIT) {
    monitor.budget[fingerprint] = bucket;
    return { outcome: "parked", counters: { no_progress: bucket.no_progress } };
  }
  bucket.no_progress += 1;
  bucket.entries.push({ at: new Date(now).toISOString(), kind, evidenced_progress: false });
  if (bucket.entries.length > 50) bucket.entries.splice(0, bucket.entries.length - 50);
  monitor.budget[fingerprint] = bucket;
  return { outcome: "recorded", counters: { no_progress: bucket.no_progress } };
}

export type ReadEpisodeDecision =
  | { outcome: "success" }
  | { outcome: "backoff"; next_at: number; attempts: number }
  | { outcome: "exhausted-alert" };

/**
 * Finite causal read episode: bounded backoff, success ends the episode, only
 * persistently current unavailability holds dependent steps back. Read errors
 * never become worker FAIL/PASS and never touch the repair counter.
 */
export function readEpisode(
  monitor: MonitorRecord,
  fingerprint: string,
  result: "success" | "transient" | "persistent",
  now: number,
): ReadEpisodeDecision {
  const episode = monitor.read_episodes[fingerprint] ?? { attempts: 0, next_at: null, exhausted_at: null, alerted: false };
  if (result === "success") {
    delete monitor.read_episodes[fingerprint];
    return { outcome: "success" };
  }
  episode.attempts += 1;
  const backoff = READ_BACKOFF_MS[Math.min(episode.attempts - 1, READ_BACKOFF_MS.length - 1)] ?? READ_BACKOFF_MS[READ_BACKOFF_MS.length - 1]!;
  episode.next_at = now + backoff;
  let decision: ReadEpisodeDecision = { outcome: "backoff", next_at: episode.next_at, attempts: episode.attempts };
  if (episode.attempts >= READ_BACKOFF_MS.length && !episode.alerted) {
    episode.alerted = true;
    episode.exhausted_at = new Date(now).toISOString();
    decision = { outcome: "exhausted-alert" };
  }
  monitor.read_episodes[fingerprint] = episode;
  return decision;
}