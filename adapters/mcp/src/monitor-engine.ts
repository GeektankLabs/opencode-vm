import { randomUUID } from "node:crypto";
import {
  digest,
  monitorHistory,
  monitorLog,
  readEpisode,
  readRegistrySnapshot,
  recordRepair,
  withRegistry,
} from "./monitor.js";
import { isRecord } from "./types.js";
import type {
  MonitorRecord,
  RegistrySnapshot,
} from "./monitor.js";
import type {
  AbortSessionTurnResult,
  CreateSessionResult,
  RuntimeOptions,
  RuntimeUpdateResult,
  SendMessageResult,
  SessionDetailsResult,
  SessionRuntime,
  SessionStatusResult,
} from "./types.js";

/**
 * W3 Monitor Engine — wake loop and bounded business actions.
 *
 * One engine owner per project runs the wake loop; the MCP tools operate on the
 * same registry. Every wake is single-flight, performs at most ONE bounded
 * business action, and never blindly resends a non-idempotent dispatch. The
 * engine reuses the existing OpenCode gateway (v1 runner, WAL receipts, native
 * abort, runtime updates) — it is not a second platform.
 */

export type MonitorBoardTask = {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  updated_at?: unknown;
  updated?: unknown;
  description?: unknown;
};
export type MonitorJournalEntry = {
  sequence?: unknown;
  entry_id?: unknown;
  appended_at?: unknown;
  text?: unknown;
};
export type MonitorBoardLike = {
  getTask(taskId: string): Promise<MonitorBoardTask>;
  getManagementHistory(
    taskId: string,
    options: { mode: "recent"; limit?: number } | { mode: "latest_checkpoint" },
  ): Promise<{
    entries?: MonitorJournalEntry[];
    checkpoint?: { entry_id?: unknown; sequence?: unknown } | null;
  }>;
  getDocuments?(taskId: string): Promise<{ documents?: Array<{ role?: unknown; path?: unknown; revision?: unknown }> }>;
};
export type MonitorGatewayLike = {
  createSession(title: string): Promise<CreateSessionResult>;
  getSessionDetails(sessionId: string, includeArchived?: boolean): Promise<SessionDetailsResult>;
  getSessionStatus(sessionId: string, messageId?: string): Promise<SessionStatusResult>;
  getSessionHistory?(sessionId: string, limit: number, before?: string): Promise<{ messages: Array<{ id: string; role: string; text: string }> }>;
  sendMessage(sessionId: string, message: string, attachments?: string[]): Promise<SendMessageResult>;
  abortSessionTurn(sessionId: string): Promise<AbortSessionTurnResult>;
  getSessionRuntimeOptions(sessionId?: string): Promise<RuntimeOptions>;
  updateSessionRuntime(sessionId: string, patch: Partial<SessionRuntime>): Promise<RuntimeUpdateResult>;
};

export type MonitorPolicyView = {
  finalFallback: { mode: "total" | "degrading"; selection: { provider_id: string; model_id: string; variant?: string } } | null;
  profiles: Partial<Record<string, { provider_id: string; model_id: string; variant?: string } | null>>;
};

export type MonitorEngineDeps = {
  project: string;
  gateway: MonitorGatewayLike;
  board?: MonitorBoardLike;
  readPolicy: () => Promise<MonitorPolicyView>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
};

export type WakeOutcome =
  | "no-due"
  | "skipped"
  | "noop-unchanged"
  | "noop-trigger"
  | "board-unavailable"
  | "read-backoff"
  | "read-exhausted"
  | "busy-held"
  | "runtime-unavailable"
  | "dispatched"
  | "dispatch-reconciled"
  | "dispatch-uncertain"
  | "compaction-continued"
  | "recovery-continued"
  | "recovery-parked"
  | "expired"
  | "error";

export type CanonicalSummary = {
  digest: string;
  task: { id: string; title: string; status: string; updated: string | null };
  checkpoint: string | null;
  newest_decision: string | null;
  decisions_since_digest: number;
  documents: Array<{ role: string; path: string; revision: string | null }>;
  coverage: "complete" | "partial";
};

const READ_FINGERPRINT = "canonical-read";

function iso(now: number): string {
  return new Date(now).toISOString();
}
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string")
    return (error as { code: string }).code;
  return undefined;
}
function isPersistentReadFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code === "TASKBOARD_UNAVAILABLE" || code === "BACKEND_UNAVAILABLE" || code === "ACTIVITY_UNAVAILABLE";
}

export class MonitorEngine {
  private readonly project: string;
  private readonly gateway: MonitorGatewayLike;
  private readonly board?: MonitorBoardLike;
  private readonly readPolicy: () => Promise<MonitorPolicyView>;
  private readonly now: () => number;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;
  private waking = false;

  constructor(deps: MonitorEngineDeps) {
    this.project = deps.project;
    this.gateway = deps.gateway;
    if (deps.board) this.board = deps.board;
    this.readPolicy = deps.readPolicy;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  /** One deterministic scan; at most one bounded action per call. */
  async tick(): Promise<WakeOutcome> {
    if (this.waking) return "skipped";
    this.waking = true;
    try {
      const now = this.now();
      const snapshot = await this.snapshot();
      const due = snapshot.registry.monitors
        .filter((monitor) => monitor.scheduler.enabled && monitor.state.work !== "stopped")
        .filter((monitor) => monitor.wake_request !== null || (monitor.scheduler.next_run_at ?? 0) <= now)
        .sort((a, b) => {
          const triggerA = a.wake_request ? 0 : 1;
          const triggerB = b.wake_request ? 0 : 1;
          if (triggerA !== triggerB) return triggerA - triggerB;
          return (a.scheduler.next_run_at ?? 0) - (b.scheduler.next_run_at ?? 0) || a.id.localeCompare(b.id);
        });
      const next = due[0];
      if (!next) return "no-due";
      return await this.wakeOne(next.id, now);
    } finally {
      this.waking = false;
    }
  }

  private async snapshot(): Promise<RegistrySnapshot> {
    return readRegistrySnapshot(this.project);
  }

  private async wakeOne(id: string, now: number): Promise<WakeOutcome> {
    const claimed = await withRegistry(
      this.project,
      (registry) => {
        const monitor = registry.monitors.find((entry) => entry.id === id);
        if (!monitor) return;
        if (monitor.run.active) {
          monitorHistory(monitor, "wake-skipped", { reason: "run-active" }, now);
          monitor.scheduler.next_run_at = now + monitor.scheduler.interval_seconds * 1000;
          return;
        }
        monitor.run = { active: true, started_at: iso(now), action: null };
        monitor.updated_at = iso(now);
        return registry;
      },
      { now },
    );
    const monitor = claimed.monitors.find((entry) => entry.id === id);
    if (!monitor || !monitor.run.active || monitor.run.started_at !== iso(now)) {
      return "skipped";
    }
    try {
      return await this.runWake(id, now, monitor);
    } catch (error) {
      await this.release(id, now, "error", (monitorRecord) => {
        const message = error instanceof Error ? error.message : "monitor wake failed";
        monitorLog(monitorRecord, "error", message, now);
        monitorHistory(monitorRecord, "error", { message: message.slice(0, 160) }, now);
      });
      this.log("error", `monitor wake failed: ${error instanceof Error ? error.message : "unknown"}`);
      return "error";
    }
  }

  private async release(
    id: string,
    now: number,
    action: string | null,
    mutate?: (monitor: MonitorRecord) => void,
  ): Promise<void> {
    await withRegistry(
      this.project,
      (registry) => {
        const monitor = registry.monitors.find((entry) => entry.id === id);
        if (!monitor) return;
        monitor.run = { active: false, started_at: null, action: action ?? monitor.run.action };
        monitor.updated_at = iso(now);
        if (
          monitor.scheduler.expiry_at !== null &&
          now >= monitor.scheduler.expiry_at &&
          monitor.scheduler.enabled
        ) {
          monitor.scheduler.enabled = false;
          monitor.scheduler.next_run_at = null;
          monitorHistory(monitor, "expired", { at: iso(now) }, now);
        } else if (monitor.scheduler.enabled) {
          monitor.scheduler.next_run_at = now + monitor.scheduler.interval_seconds * 1000;
        }
        mutate?.(monitor);
        return registry;
      },
      { now },
    );
  }

  private async runWake(id: string, now: number, monitor: MonitorRecord): Promise<WakeOutcome> {
    // ---- canonical snapshot (bounded, honest coverage) ----
    const canonical = await this.snapshotCanonical(id, now, monitor);
    if (canonical.kind === "unavailable") return "board-unavailable";
    if (canonical.kind === "read-backoff") return "read-backoff";
    if (canonical.kind === "read-exhausted") return "read-exhausted";

    const summary = canonical.summary;
    const previously = monitor.state.last_seen_digest;
    const triggered = monitor.wake_request !== null;
    const decisionsSince = canonical.decisionsSince;

    // ---- WAL reconciliation before ANY next admission / no-op shortcut ----
    // An unreconciled non-idempotent dispatch is never silently overridden by
    // the unchanged shortcut: it is reconciled or parked first.
    if (monitor.dispatch_wal && monitor.dispatch_wal.message_id === null) {
      const walSession = await this.ensureSession(monitor, now);
      if (walSession.kind === "session-error") {
        await this.release(id, now, null, (record) => {
          monitorHistory(record, "session-unavailable", { reason: walSession.reason }, now);
        });
        return "error";
      }
      const reconciled = await this.reconcileDispatch(monitor, walSession.sessionId);
      if (reconciled.kind === "found") {
        await this.release(id, now, "dispatch-reconciled", (record) => {
          if (record.dispatch_wal) record.dispatch_wal.message_id = reconciled.messageId;
          monitorHistory(record, "dispatch-reconciled", { message_id: reconciled.messageId }, now);
          record.state.last_seen_digest = summary.digest;
          record.wake_request = null;
          this.appendDecisionSummary(record, summary, decisionsSince, now);
        });
        return "dispatch-reconciled";
      }
      await this.release(id, now, "dispatch-uncertain", (record) => {
        record.state.work = "parked_input_required";
        record.state.parked_reason = "dispatch-uncertain";
        record.wake_request = null;
        monitorHistory(record, "dispatch-uncertain", { action_id: record.dispatch_wal?.action_id ?? null }, now);
      });
      return "dispatch-uncertain";
    }

    // Cheap unchanged path: no model call, no note growth. A pending trigger is
    // consumed with a single bounded receipt entry.
    if (summary.digest === previously && !triggered) {
      await this.release(id, now, null);
      return "noop-unchanged";
    }

    // ---- technical state gate (busy alone never aborts) ----
    const session = await this.ensureSession(monitor, now);
    if (session.kind === "session-error") {
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "session-unavailable", { reason: session.reason }, now);
      });
      return "error";
    }
    const status = await this.gateway.getSessionStatus(session.sessionId, monitor.dispatch_wal?.message_id ?? undefined);
    if (status.pending_input.permissions + status.pending_input.questions > 0) {
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "busy-held", { reason: "pending-input" }, now);
      });
      return "busy-held";
    }

    // ---- evidenced blocked-error recovery / compaction (never on busy alone) ----
    const evidenced = classifyEvidence(status);
    if (evidenced.kind === "blocked") {
      if (evidenced.category === "context_input_length") return this.compactionContinue(id, now, monitor, session.sessionId, summary);
      return this.recover(id, now, monitor, session.sessionId, evidenced);
    }
    if (status.backend_activity !== "idle" || status.state === "running") {
      // Retrying/waiting/active progress is not a blocked error; busy alone is
      // never a stop or abort reason. One bounded receipt entry, then reschedule.
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "activity-observed", { activity: status.backend_activity, state: status.state }, now);
      });
      return "busy-held";
    }

    // ---- dispatch one bounded action (changed canonical or operator trigger) ----
    const runtime = await this.resolveRuntime(monitor);
    if (runtime.kind === "unavailable") {
      await this.release(id, now, "runtime-unavailable", (record) => {
        record.state.work = "parked_input_required";
        record.state.parked_reason = "runtime-unavailable";
        record.wake_request = null;
        monitorHistory(record, "runtime-unavailable", { reason: runtime.reason }, now);
      });
      return "runtime-unavailable";
    }
    if (runtime.kind === "switched" || runtime.kind === "already") {
      const actionId = `wake_${randomUUID().replaceAll("-", "")}`;
      const prompt = this.buildWakePrompt(monitor, summary, decisionsSince, actionId, triggered);
      const wal = await withRegistry(
        this.project,
        (registry) => {
          const record = registry.monitors.find((entry) => entry.id === id);
          if (!record) return registry;
          record.dispatch_wal = { action_id: actionId, at: iso(now), prompt_digest: digest(prompt), message_id: null };
          record.run.action = "dispatch";
          record.updated_at = iso(now);
          return registry;
        },
        { now },
      );
      if (!wal.monitors.some((entry) => entry.id === id && entry.dispatch_wal?.action_id === actionId)) {
        return "skipped";
      }
      let result: SendMessageResult;
      try {
        result = await this.gateway.sendMessage(session.sessionId, prompt);
      } catch (error) {
        const code = errorCode(error);
        if (code === "SUBMISSION_UNCERTAIN") {
          const reconciled = await this.reconcileDispatch(monitor, session.sessionId);
          await this.release(id, now, reconciled.kind === "found" ? "dispatch-reconciled" : "dispatch-uncertain", (record) => {
            if (record.dispatch_wal) record.dispatch_wal.message_id = reconciled.kind === "found" ? reconciled.messageId : null;
            record.state.last_seen_digest = summary.digest;
            record.wake_request = null;
            if (reconciled.kind === "found") {
              monitorHistory(record, "dispatch-reconciled", { message_id: reconciled.messageId }, now);
              this.appendDecisionSummary(record, summary, decisionsSince, now);
            } else {
              record.state.work = "parked_input_required";
              record.state.parked_reason = "dispatch-uncertain";
              monitorHistory(record, "dispatch-uncertain", { action_id: actionId }, now);
            }
          });
          return reconciled.kind === "found" ? "dispatch-reconciled" : "dispatch-uncertain";
        }
        await this.release(id, now, null, (record) => {
          monitorHistory(record, "dispatch-failed", { code: code ?? "unknown" }, now);
        });
        return "error";
      }
      await this.release(id, now, "dispatched", (record) => {
        if (record.dispatch_wal && record.dispatch_wal.action_id === actionId) record.dispatch_wal.message_id = result.message_id;
        record.state.last_seen_digest = summary.digest;
        record.wake_request = null;
        monitorHistory(record, triggered ? "noop-trigger" : "dispatched", { message_id: result.message_id, action_id: actionId }, now);
        this.appendDecisionSummary(record, summary, decisionsSince, now);
      });
      return triggered ? "noop-trigger" : "dispatched";
    }
    await this.release(id, now, null);
    return "noop-unchanged";
  }

  private appendDecisionSummary(
    monitor: MonitorRecord,
    summary: CanonicalSummary,
    decisionsSince: number,
    now: number,
  ): void {
    monitor.state.watermark = summary.newest_decision ?? monitor.state.watermark;
    monitorHistory(
      monitor,
      "checkpoint-observed",
      { checkpoint: summary.checkpoint, newest_decision: summary.newest_decision, decisions_since: decisionsSince, coverage: summary.coverage },
      now,
    );
  }

  // ------------------------------------------------------------------ reads

  private async snapshotCanonical(
    id: string,
    now: number,
    monitor: MonitorRecord,
  ): Promise<
    | { kind: "ok"; summary: CanonicalSummary; decisionsSince: number }
    | { kind: "unavailable" }
    | { kind: "read-backoff" }
    | { kind: "read-exhausted" }
  > {
    if (!this.board) {
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "board-unavailable", undefined, now);
      });
      return { kind: "unavailable" };
    }
    try {
      const task = await this.board.getTask(monitor.anchor.task_id);
      const recent = await this.board.getManagementHistory(monitor.anchor.task_id, { mode: "recent", limit: 20 });
      const checkpoint = await this.board.getManagementHistory(monitor.anchor.task_id, { mode: "latest_checkpoint" });
      let documents: CanonicalSummary["documents"] = [];
      let coverage: CanonicalSummary["coverage"] = "complete";
      if (this.board.getDocuments) {
        try {
          const docs = await this.board.getDocuments(monitor.anchor.task_id);
          documents = (docs.documents ?? []).slice(0, 4).map((doc) => ({
            role: typeof doc.role === "string" ? doc.role : "unknown",
            path: typeof doc.path === "string" ? doc.path : "",
            revision: asString(doc.revision),
          }));
        } catch {
          coverage = "partial";
        }
      } else {
        coverage = "partial";
      }
      const entries = Array.isArray(recent.entries) ? recent.entries : [];
      const newest = entries.length > 0 ? entries[entries.length - 1] : undefined;
      const newestId = asString(newest?.entry_id) ?? (newest?.sequence !== undefined ? String(newest.sequence) : null);
      const checkpointId =
        asString(checkpoint.checkpoint?.entry_id) ??
        (checkpoint.checkpoint?.sequence !== undefined ? String(checkpoint.checkpoint.sequence) : null);
      const watermark = monitor.state.watermark ?? "";
      const decisionsSince = entries.filter((entry) => {
        const at = asString(entry.appended_at);
        return at !== null && at > watermark;
      }).length;
      const summary: CanonicalSummary = {
        digest: digest({
          task: { id: asString(task.id) ?? monitor.anchor.task_id, status: asString(task.status) ?? "unknown", updated: asString(task.updated_at) ?? asString(task.updated) },
          checkpoint: checkpointId,
          newest: newestId,
          documents: documents.map((doc) => `${doc.role}:${doc.path}:${doc.revision ?? ""}`),
        }),
        task: {
          id: asString(task.id) ?? monitor.anchor.task_id,
          title: asString(task.title) ?? monitor.id,
          status: asString(task.status) ?? "unknown",
          updated: asString(task.updated_at) ?? asString(task.updated),
        },
        checkpoint: checkpointId,
        newest_decision: newestId,
        decisions_since_digest: decisionsSince,
        documents,
        coverage,
      };
      const hadEpisode = monitor.read_episodes[READ_FINGERPRINT] !== undefined;
      if (hadEpisode) {
        await withRegistry(
          this.project,
          (registry) => {
            const record = registry.monitors.find((entry) => entry.id === id);
            if (!record) return registry;
            readEpisode(record, READ_FINGERPRINT, "success", now);
            record.updated_at = iso(now);
            return registry;
          },
          { now },
        );
      }
      return { kind: "ok", summary, decisionsSince };
    } catch (error) {
      const persistent = isPersistentReadFailure(error);
      const decision = await withRegistry(
        this.project,
        (registry) => {
          const record = registry.monitors.find((entry) => entry.id === id);
          if (!record) return registry;
          const episode = readEpisode(record, READ_FINGERPRINT, persistent ? "persistent" : "transient", now);
          monitorHistory(
            record,
            episode.outcome === "exhausted-alert" ? "read-exhausted" : "read-backoff",
            { persistent, message: (error instanceof Error ? error.message : "read failed").slice(0, 120) },
            now,
          );
          if (episode.outcome === "exhausted-alert") monitorLog(record, "warn", "canonical read episode exhausted; dependent monitor action held back", now);
          record.run = { active: false, started_at: null, action: record.run.action };
          if (
            record.scheduler.expiry_at !== null &&
            now >= record.scheduler.expiry_at &&
            record.scheduler.enabled
          ) {
            record.scheduler.enabled = false;
            record.scheduler.next_run_at = null;
            monitorHistory(record, "expired", { at: iso(now) }, now);
          } else if (record.scheduler.enabled) {
            record.scheduler.next_run_at = now + record.scheduler.interval_seconds * 1000;
          }
          record.updated_at = iso(now);
          return registry;
        },
        { now },
      );
      const record = decision.monitors.find((entry) => entry.id === id);
      const last = record?.history[record.history.length - 1];
      return last?.type === "read-exhausted" ? { kind: "read-exhausted" } : { kind: "read-backoff" };
    }
  }

  // --------------------------------------------------------------- sessions

  private async ensureSession(
    monitor: MonitorRecord,
    now: number,
  ): Promise<{ kind: "ok"; sessionId: string } | { kind: "session-error"; reason: string }> {
    if (monitor.session.session_id) {
      try {
        const details = await this.gateway.getSessionDetails(monitor.session.session_id);
        if (details.id === monitor.session.session_id) return { kind: "ok", sessionId: details.id };
      } catch {
        // fall through to rebind below
      }
    }
    try {
      const created = await this.gateway.createSession(`Monitor ${monitor.title}`);
      await withRegistry(
        this.project,
        (registry) => {
          const record = registry.monitors.find((entry) => entry.id === monitor.id);
          if (!record) return registry;
          record.session = { session_id: created.session_id, title: created.title, primed_at: iso(now) };
          monitorHistory(record, "session-primed", { session_id: created.session_id }, now);
          record.updated_at = iso(now);
          return registry;
        },
        { now },
      );
      return { kind: "ok", sessionId: created.session_id };
    } catch (error) {
      return { kind: "session-error", reason: errorCode(error) ?? "creation-failed" };
    }
  }

  // ---------------------------------------------------------------- runtime

  private async resolveRuntime(
    monitor: MonitorRecord,
  ): Promise<{ kind: "already" } | { kind: "switched" } | { kind: "unavailable"; reason: string }> {
    const policy = await this.readPolicy();
    const resolved = await this.resolveProfileSelection(policy, monitor.runtime_profile);
    if (!resolved) return { kind: "unavailable", reason: `profile ${monitor.runtime_profile} not configured` };
    const catalog = await this.gateway.getSessionRuntimeOptions(monitor.session.session_id ?? undefined);
    if (!catalogAvailable(catalog, resolved)) {
      return { kind: "unavailable", reason: `profile ${monitor.runtime_profile} configured but unavailable or incomplete` };
    }
    const details = await this.gateway.getSessionDetails(monitor.session.session_id!);
    const current = {
      provider_id: details.provider_id,
      model_id: details.model_id,
      variant: details.variant,
    };
    if (
      current.provider_id !== undefined &&
      current.model_id !== undefined &&
      current.provider_id === resolved.provider_id &&
      current.model_id === resolved.model_id &&
      (resolved.variant === undefined || current.variant === resolved.variant)
    ) {
      return { kind: "already" };
    }
    const updated = await this.gateway.updateSessionRuntime(monitor.session.session_id!, {
      provider_id: resolved.provider_id,
      model_id: resolved.model_id,
      ...(resolved.variant !== undefined ? { variant: resolved.variant } : {}),
    });
    const verified = await this.gateway.getSessionDetails(monitor.session.session_id!);
    if (
      updated.state !== "updated" ||
      verified.provider_id !== resolved.provider_id ||
      verified.model_id !== resolved.model_id
    ) {
      throw new Error("runtime update could not be verified");
    }
    return { kind: "switched" };
  }

  private async resolveProfileSelection(
    policy: MonitorPolicyView,
    profile: string,
  ): Promise<{ provider_id: string; model_id: string; variant?: string } | null> {
    const entry = policy.profiles[profile];
    return entry ? { ...entry } : null;
  }

  // -------------------------------------------------------------- recovery

  private async recover(
    id: string,
    now: number,
    monitor: MonitorRecord,
    sessionId: string,
    evidence: { fingerprint: string; category: string },
  ): Promise<WakeOutcome> {
    // Operational recovery is not a production-code repair; the W2 budget is
    // applied through the deterministic classifier below.
    const kind = classifyRepairKind(evidence.category);
    const decision = await withRegistry(
      this.project,
      (registry) => {
        const record = registry.monitors.find((entry) => entry.id === id);
        if (!record) return registry;
        const outcome = recordRepair(record, evidence.fingerprint, kind, false, now);
        monitorHistory(record, "recovery-classified", { kind, outcome: outcome.outcome, fingerprint: evidence.fingerprint }, now);
        record.recovery = { active: true, started_at: iso(now), last_error_fingerprint: evidence.fingerprint };
        record.run.action = "recovery";
        record.dispatch_wal = null;
        record.updated_at = iso(now);
        return registry;
      },
      { now },
    );
    const record = decision.monitors.find((entry) => entry.id === id);
    const lastEntry = record?.history[record.history.length - 1];
    const budgetOutcome = lastEntry && isRecord(lastEntry.detail) ? lastEntry.detail.outcome : undefined;
    if (budgetOutcome === "parked" && kind === "production-code") {
      await this.release(id, now, "recovery-parked", (m) => {
        m.state.work = "parked_input_required";
        m.state.parked_reason = "repair-budget-exhausted";
        m.recovery.active = false;
        monitorHistory(m, "repair-budget-exhausted", { fingerprint: evidence.fingerprint }, now);
      });
      return "recovery-parked";
    }

    const aborted = await this.abortAndVerify(sessionId, id, now);
    if (aborted.kind !== "cleared") {
      await this.release(id, now, null, (m) => {
        m.recovery.active = false;
        monitorHistory(m, "recovery-held", { abort: aborted.state }, now);
      });
      return "recovery-parked";
    }

    const policy = await this.readPolicy();
    const chain = fallbackChain(policy, monitor.runtime_profile);
    if (chain.length === 0) {
      await this.release(id, now, "recovery-parked", (m) => {
        m.state.work = "parked_input_required";
        m.state.parked_reason = "final-fallback-unconfigured";
        m.recovery.active = false;
        monitorHistory(m, "final-fallback-unconfigured", { fingerprint: evidence.fingerprint }, now);
      });
      return "recovery-parked";
    }
    const catalog = await this.gateway.getSessionRuntimeOptions(sessionId);
    const attempted: string[] = [];
    let selected: { provider_id: string; model_id: string; variant?: string } | null = null;
    for (const candidate of chain) {
      const identity = `${candidate.provider_id}/${candidate.model_id}`;
      if (attempted.includes(identity)) continue;
      attempted.push(identity);
      if (catalogAvailable(catalog, candidate)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      await this.release(id, now, "recovery-parked", (m) => {
        m.state.work = "parked_input_required";
        m.state.parked_reason = "final-fallback-unavailable";
        m.recovery.active = false;
        monitorHistory(m, "final-fallback-unavailable", { attempted }, now);
      });
      return "recovery-parked";
    }
    const updated = await this.gateway.updateSessionRuntime(sessionId, {
      provider_id: selected.provider_id,
      model_id: selected.model_id,
      ...(selected.variant !== undefined ? { variant: selected.variant } : {}),
    });
    const verified = await this.gateway.getSessionDetails(sessionId);
    if (
      updated.state !== "updated" ||
      verified.provider_id !== selected.provider_id ||
      verified.model_id !== selected.model_id
    ) {
      await this.release(id, now, null, (m) => {
        m.recovery.active = false;
        monitorHistory(m, "recovery-update-unverified", { attempted }, now);
      });
      return "error";
    }
    const actionId = `recovery_${randomUUID().replaceAll("-", "")}`;
    const prompt = this.buildRecoveryPrompt(monitor, evidence, actionId);
    await withRegistry(
      this.project,
      (registry) => {
        const m = registry.monitors.find((entry) => entry.id === id);
        if (!m) return registry;
        m.dispatch_wal = { action_id: actionId, at: iso(now), prompt_digest: digest(prompt), message_id: null };
        m.updated_at = iso(now);
        return registry;
      },
      { now },
    );
    let result: SendMessageResult;
    try {
      result = await this.gateway.sendMessage(sessionId, prompt);
    } catch (error) {
      const code = errorCode(error);
      await this.release(id, now, code === "SUBMISSION_UNCERTAIN" ? "dispatch-uncertain" : null, (m) => {
        m.recovery.active = false;
        if (code === "SUBMISSION_UNCERTAIN") {
          m.state.work = "parked_input_required";
          m.state.parked_reason = "dispatch-uncertain";
          monitorHistory(m, "dispatch-uncertain", { action_id: actionId }, now);
        } else {
          monitorHistory(m, "recovery-continue-failed", { code: code ?? "unknown" }, now);
        }
      });
      return code === "SUBMISSION_UNCERTAIN" ? "dispatch-uncertain" : "error";
    }
    await this.release(id, now, "recovery-continued", (m) => {
      if (m.dispatch_wal && m.dispatch_wal.action_id === actionId) m.dispatch_wal.message_id = result.message_id;
      m.recovery.active = false;
      monitorHistory(m, "recovery-continued", {
        message_id: result.message_id,
        fallback: `${selected.provider_id}/${selected.model_id}`,
        fingerprint: evidence.fingerprint,
      }, now);
    });
    return "recovery-continued";
  }

  private async compactionContinue(
    id: string,
    now: number,
    monitor: MonitorRecord,
    sessionId: string,
    summary: CanonicalSummary,
  ): Promise<WakeOutcome> {
    const status = await this.gateway.getSessionStatus(sessionId);
    if (status.backend_activity !== "idle" || status.pending_input.permissions + status.pending_input.questions > 0) {
      await this.release(id, now, null, (m) => {
        monitorHistory(m, "compaction-held", { activity: status.backend_activity }, now);
      });
      return "busy-held";
    }
    const actionId = `compact_${randomUUID().replaceAll("-", "")}`;
    const prompt = this.buildRecoveryPrompt(monitor, { fingerprint: "context_input_length", category: "context_input_length" }, actionId, summary);
    await withRegistry(
      this.project,
      (registry) => {
        const m = registry.monitors.find((entry) => entry.id === id);
        if (!m) return registry;
        m.dispatch_wal = { action_id: actionId, at: iso(now), prompt_digest: digest(prompt), message_id: null };
        m.updated_at = iso(now);
        return registry;
      },
      { now },
    );
    try {
      const result = await this.gateway.sendMessage(sessionId, prompt);
      await this.release(id, now, "compaction-continued", (m) => {
        if (m.dispatch_wal && m.dispatch_wal.action_id === actionId) m.dispatch_wal.message_id = result.message_id;
        monitorHistory(m, "compaction-continued", { message_id: result.message_id }, now);
        m.state.last_seen_digest = summary.digest;
        m.wake_request = null;
      });
      return "compaction-continued";
    } catch (error) {
      const code = errorCode(error);
      await this.release(id, now, code === "SUBMISSION_UNCERTAIN" ? "dispatch-uncertain" : null, (m) => {
        if (code === "SUBMISSION_UNCERTAIN") {
          m.state.work = "parked_input_required";
          m.state.parked_reason = "dispatch-uncertain";
          monitorHistory(m, "dispatch-uncertain", { action_id: actionId }, now);
        } else {
          monitorHistory(m, "compaction-continue-failed", { code: code ?? "unknown" }, now);
        }
      });
      return code === "SUBMISSION_UNCERTAIN" ? "dispatch-uncertain" : "error";
    }
  }

  private async abortAndVerify(
    sessionId: string,
    id: string,
    now: number,
  ): Promise<{ kind: "cleared"; state: string } | { kind: "held"; state: string }> {
    let abort: AbortSessionTurnResult;
    try {
      abort = await this.gateway.abortSessionTurn(sessionId);
    } catch (error) {
      await this.release(id, now, null, (m) => {
        monitorHistory(m, "recovery-abort-failed", { code: errorCode(error) ?? "unknown" }, now);
      });
      return { kind: "held", state: "abort-failed" };
    }
    if (abort.state === "aborted" || abort.state === "no_active_turn") {
      const pending = await this.gateway.getSessionStatus(sessionId);
      if (pending.pending_input.permissions + pending.pending_input.questions > 0) {
        return { kind: "held", state: "pending-input" };
      }
      return { kind: "cleared", state: abort.state };
    }
    return { kind: "held", state: abort.state };
  }

  private async reconcileDispatch(
    monitor: MonitorRecord,
    sessionId: string,
  ): Promise<{ kind: "found"; messageId: string } | { kind: "missing" }> {
    const actionId = monitor.dispatch_wal?.action_id;
    if (!actionId || !this.gateway.getSessionHistory) return { kind: "missing" };
    try {
      const page = await this.gateway.getSessionHistory(sessionId, 10);
      for (const message of page.messages) {
        if (message.role !== "user") continue;
        const preview = typeof message.text === "string" ? message.text : "";
        if (preview.includes(`[MONITOR-ACTION ${actionId}]`) || preview.includes(`[MONITOR-RECOVERY ${actionId}]`) ||
            preview.includes(`[MONITOR-COMPACT ${actionId}]`)) {
          return { kind: "found", messageId: message.id };
        }
      }
    } catch {
      return { kind: "missing" };
    }
    return { kind: "missing" };
  }

  // --------------------------------------------------------------- prompts

  private buildWakePrompt(
    monitor: MonitorRecord,
    summary: CanonicalSummary,
    decisionsSince: number,
    actionId: string,
    triggered: boolean,
  ): string {
    const parts = [
      `[MONITOR-ACTION ${actionId}]`,
      `Monitor ${monitor.id} (${monitor.title}) wake${triggered ? " (operator trigger)" : ""}.`,
      `Canonical anchor task: ${summary.task.id} — "${summary.task.title}" (status ${summary.task.status}${summary.task.updated ? `, updated ${summary.task.updated}` : ""}).`,
      `Latest checkpoint: ${summary.checkpoint ?? "unknown"}; newest journal decision: ${summary.newest_decision ?? "unknown"}; decisions since last wake: ${decisionsSince}.`,
      `Bound documents: ${summary.documents.length ? summary.documents.map((doc) => `${doc.role}=${doc.path}${doc.revision ? `@${doc.revision}` : ""}`).join(", ") : "none registered"} (coverage ${summary.coverage}).`,
      `Autonomy profile: ${monitor.autonomy_profile}. Continue the canonical task contract within its authorized scope. Take at most one bounded step; read the actual canonical C/P, checkpoint and newer operator decisions before acting. Missing input or a real decision must be reported as INPUT_REQUIRED; do not invent scope. Task-done status is never inferred from technical turn completion.`,
    ];
    return parts.join("\n");
  }

  private buildRecoveryPrompt(
    monitor: MonitorRecord,
    evidence: { fingerprint: string; category: string },
    actionId: string,
    summary?: CanonicalSummary,
  ): string {
    const parts = [
      `[MONITOR-${evidence.category === "context_input_length" ? "COMPACT" : "RECOVERY"} ${actionId}]`,
      `Monitor ${monitor.id} (${monitor.title}) operational recovery.`,
      evidence.category === "context_input_length"
        ? "The previous request was rejected for input length. Do not resubmit the rejected request; rely on the verified native compaction result and continue the same task context exactly once with the recovery summary."
        : `The worker stopped with an evidenced blocked error (${evidence.fingerprint}; category ${evidence.category}). Continue the same task context in this session; do not duplicate already admitted work.`,
      summary ? `Canonical anchor task: ${summary.task.id}; checkpoint: ${summary.checkpoint ?? "unknown"}.` : `Canonical anchor task: ${monitor.anchor.task_id}.`,
      "Re-establish the task from the canonical C/P, checkpoint and receipts before the next bounded step; report a precise INPUT_REQUIRED if a real decision is needed. Already executed changes remain; no rollback is claimed.",
    ];
    return parts.join("\n");
  }
}

// ------------------------------------------------------------------ helpers

export function classifyEvidence(status: SessionStatusResult): { kind: "blocked"; fingerprint: string; category: string } | { kind: "none" } {
  if (status.state !== "failed") return { kind: "none" };
  const details = status.error_details ?? [];
  const detail = details.length > 0 ? details[details.length - 1] : undefined;
  if (!detail) return { kind: "none" };
  const category = typeof detail.category === "string" ? detail.category : "unknown";
  if (category === "aborted") return { kind: "none" };
  const fingerprint = digest({ category, name: detail.name ?? null, code: detail.code ?? null });
  return { kind: "blocked", fingerprint, category };
}

const OPERATIONAL_CATEGORIES = new Set([
  "provider_header_timeout",
  "provider_response_stream_error",
  "provider_error",
  "provider_timeout",
  "provider_quota",
  "provider_auth",
  "context_input_length",
  "context_overflow",
  "output_length",
  "structured_output",
  "content_filter",
  "aborted",
  "unknown",
]);

/**
 * Deterministic W2-r43 classification: provider/context/abort classes are
 * operational recovery and excluded from the production-code repair counter
 * (as are reads, result fetch, receipts, docs, plans, tests, fixtures,
 * harnesses and infrastructure). Categories outside that operational set are
 * a work/product failure and count as production-code repair attempts.
 */
export function classifyRepairKind(category: string): "production-code" | "excluded" {
  return OPERATIONAL_CATEGORIES.has(category) ? "excluded" : "production-code";
}

export function catalogAvailable(
  catalog: RuntimeOptions,
  selection: { provider_id: string; model_id: string; variant?: string },
): boolean {
  const provider = catalog.providers.find((entry) => entry.provider_id === selection.provider_id);
  if (!provider) return false;
  const model = catalog.models.find(
    (entry) => entry.provider_id === selection.provider_id && entry.model_id === selection.model_id,
  );
  if (!model) return false;
  if (selection.variant !== undefined) {
    const variants = model.variants ?? [];
    if (variants.length > 0 && !variants.includes(selection.variant)) return false;
  }
  return true;
}

export function fallbackChain(
  policy: MonitorPolicyView,
  monitorProfile: string,
): Array<{ provider_id: string; model_id: string; variant?: string }> {
  const order: string[] =
    monitorProfile === "design" || monitorProfile === "review"
      ? ["standard", "execution"]
      : monitorProfile === "deep"
        ? ["standard", "execution"]
        : ["execution"];
  const chain: Array<{ provider_id: string; model_id: string; variant?: string }> = [];
  if (policy.finalFallback && policy.finalFallback.mode === "degrading") {
    for (const profile of order) {
      const entry = policy.profiles[profile];
      if (entry) chain.push({ ...entry });
    }
  }
  if (policy.finalFallback) chain.push({ ...policy.finalFallback.selection });
  return chain;
}