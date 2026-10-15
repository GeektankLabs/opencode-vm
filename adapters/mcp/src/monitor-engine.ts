import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogAvailable,
  fallbackChain,
  isRecoveryProviderAdmission,
  newStartCandidates,
  resolveRecoveryChain,
  runtimeIdentityKey,
} from "./agent-control.js";
import type { RecoveryPolicyView } from "./agent-control.js";
// The shared recovery-policy resolver lives exactly once in TypeScript
// (agent-control.ts, Welle B / concept §4.4 R2). Re-exported here for the
// existing engine API; there is deliberately no second engine-local
// implementation and no reimplementing filter semantics elsewhere.
export { catalogAvailable, fallbackChain };
import {
  appendRecoveryResolution,
  defaultInvestigationConfig,
  defaultInvestigationState,
  digest,
  investigationWorkerFor,
  monitorDecision,
  monitorHistory,
  monitorLog,
  pushRecoveryAttempt,
  readEpisode,
  readRegistrySnapshot,
  recordRepair,
  refreshInvestigationProjections,
  withRegistry,
  workerIndexDigest,
} from "./monitor.js";
import type {
  InvestigationEpisodeState,
  InvestigationEvidenceEntry,
  InvestigationWorkerState,
  MonitorInvestigationConfig,
  MonitorWorkerErrorMarker,
  MonitorWorkerRecord,
  RecoveryEpisode,
} from "./monitor.js";
import { isRecord } from "./types.js";
import type {
  MonitorRecord,
  RegistrySnapshot,
} from "./monitor.js";
import type {
  AbortSessionTurnResult,
  CreateSessionResult,
  PendingInput,
  RuntimeOptions,
  RuntimeUpdateResult,
  SendMessageResult,
  SessionDetailsResult,
  SessionProgressResult,
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

// V2 §13 (task_a234c341 / package task_e67c39cf) — investigation constants.
const HEARTBEAT_FRESH_MS = 90_000; // 3× the 30 s heartbeat period
const OBSERVER_LEASE_TTL_MS = 15_000;
const OBSERVER_PROBE_THROTTLE_MS = 30_000; // Z1: one probe batch per monitor per window
const CLAIM_STUCK_INTERVAL_FACTOR = 10;

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
    options: { mode: "recent"; limit: number } | { mode: "latest_checkpoint"; limit: number },
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
  /** V2 §13.4 optional: attributable in-flight tool observations (existing
   * backend capability; absent gateways degrade evidence to `inconclusive`). */
  getSessionProgress?(sessionId: string, messageId?: string): Promise<SessionProgressResult>;
  getCombinedPendingInput(sessionId: string): Promise<PendingInput>;
  getSessionHistory?(sessionId: string, limit: number, before?: string): Promise<{ messages: Array<{ id: string; role: string; text: string }> }>;
  sendMessage(sessionId: string, message: string, attachments?: string[]): Promise<SendMessageResult>;
  abortSessionTurn(sessionId: string): Promise<AbortSessionTurnResult>;
  getSessionRuntimeOptions(sessionId?: string): Promise<RuntimeOptions>;
  updateSessionRuntime(sessionId: string, patch: Partial<SessionRuntime>): Promise<RuntimeUpdateResult>;
};

/** Full Schema-4 policy view for recovery resolution (Welle B): the additive
 * optional fields carry profileFallbacks/strategies/routing/revision. A
 * reduced view without `routing` keeps the legacy regime unchanged. */
export type MonitorPolicyView = RecoveryPolicyView;

export type MonitorEngineDeps = {
  project: string;
  gateway: MonitorGatewayLike;
  board?: MonitorBoardLike;
  readPolicy: () => Promise<MonitorPolicyView>;
  now?: () => number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** V2 §13.8: this engine instance's runtime generation (claim fencing +
   * investigation episode attribution). Defaults to "unknown" (never treated
   * as a sufficient process identity). */
  engineGeneration?: string;
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
  | "investigated"
  | "investigation-deferred"
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
/** Welle B §4.6 (operator-approved): a restarted episode requires the EXPLICIT
 * operator trigger on a monitor parked by chain exhaustion/unconfiguration —
 * never a hidden automatic reset. */
const RESTARTABLE_EXHAUSTION_REASONS = new Set([
  "recovery-chain-exhausted",
  "final-fallback-unconfigured",
  "final-fallback-unavailable",
  "profile-fallback-unconfigured",
  // task_f2d0ccc6: a runtime-unavailable park (unconfigured profile, or every
  // stored slot manually disabled) must stop lying after the operator fixes the
  // cause and a healthy admitted dispatch succeeds — the label then clears and
  // work returns to active. Recovery episodes are unaffected (none exists on
  // this park), so the extra set entry changes no trigger/restart semantics.
  "runtime-unavailable",
]);
/** Version of the MANAGEMENT role/context contract. Bumping it re-primes once. */
const PRIMING_CONTRACT = "mgmt-v4";

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
  return code === "TASKBOARD_UNAVAILABLE" || code === "BACKEND_UNAVAILABLE" || code === "ACTIVITY_UNAVAILABLE"
    || isDeterministicReadFailure(error);
}
/** Deterministic contract/validation rejections are not fixed by waiting. */
function isDeterministicReadFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code === "INVALID_ARGUMENT" || code === "UNSUPPORTED_CONFIGURATION";
}

export class MonitorEngine {
  private readonly project: string;
  private readonly gateway: MonitorGatewayLike;
  private readonly board?: MonitorBoardLike;
  private readonly readPolicy: () => Promise<MonitorPolicyView>;
  private readonly now: () => number;
  private readonly log: (level: "info" | "warn" | "error", message: string) => void;
  private readonly engineGeneration: string;
  private waking = false;
  /** Wave A bounded streak logging: silent tick paths name themselves once and
   * then only periodically, with first time and count visible — never per tick. */
  private readonly streaks = new Map<string, { first: number; count: number }>();

  private logStreak(key: string, now: number, message: (count: number, firstAt: string) => string, every = 60): void {
    const streak = this.streaks.get(key);
    if (!streak) {
      this.streaks.set(key, { first: now, count: 1 });
      this.log("info", message(1, new Date(now).toISOString()));
      return;
    }
    streak.count += 1;
    if (streak.count % every === 0) this.log("info", message(streak.count, new Date(streak.first).toISOString()));
  }

  private clearStreak(key: string): void {
    this.streaks.delete(key);
  }

  /**
   * QC F-B1 (waveB-qc SHAeffd6d1c6): a sanctioned resume must leave the visible
   * park state behind, otherwise the §4.6 transparency itself lies after a
   * successful continuation. The reset is scoped EXCLUSIVELY to this engine's
   * own recovery-park reasons (the RESTARTABLE_EXHAUSTION_REASONS set):
   * deliberate foreign parks (dispatch-uncertain, repair-budget-exhausted or
   * any other reason) and the scheduler state stay untouched, and no
   * successful mutation ever unparks an uncertain send.
   */
  private resumeRecoveryPark(record: MonitorRecord, via: "recovery-continued" | "dispatch-reconciled" | "healthy-dispatch", now: number): void {
    const reason = record.state.parked_reason;
    if (reason === undefined || !RESTARTABLE_EXHAUSTION_REASONS.has(reason)) return;
    record.state.work = "active";
    record.state.parked_reason = undefined;
    monitorHistory(record, "recovery-park-resumed", { resumed_from: reason, via }, now);
    this.log("info", `recovery park resumed monitor=${record.id} from=${reason} via=${via}`);
  }

  constructor(deps: MonitorEngineDeps) {
    this.project = deps.project;
    this.gateway = deps.gateway;
    if (deps.board) this.board = deps.board;
    this.readPolicy = deps.readPolicy;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    // "unknown" is never treated as a sufficient process identity (V2 §13.8:
    // PID without generation/start evidence is not ownership proof).
    this.engineGeneration = deps.engineGeneration ?? "unknown";
  }

  /** One deterministic scan; at most one bounded action per call. */
  async tick(): Promise<WakeOutcome> {
    if (this.waking) {
      this.logStreak("wake-skipped", this.now(), (count, firstAt) =>
        `wake tick skipped: engine already waking (streak ${count}, since ${firstAt})`);
      return "skipped";
    }
    this.waking = true;
    try {
      const now = this.now();
      const snapshot = await this.snapshot();
      const due = snapshot.registry.monitors
        .filter((monitor) => monitor.scheduler.enabled && monitor.state.work !== "stopped")
        .filter((monitor) => (monitor.wake_request !== null && monitor.scheduler.enabled)
          || (monitor.abort_request !== null && monitor.scheduler.enabled)
          || (monitor.scheduler.next_run_at ?? 0) <= now)
        .sort((a, b) => {
          const rank = (monitor: MonitorRecord) => (monitor.abort_request ? 0 : monitor.wake_request ? 1 : 2);
          const rankA = rank(a);
          const rankB = rank(b);
          if (rankA !== rankB) return rankA - rankB;
          return (a.scheduler.next_run_at ?? 0) - (b.scheduler.next_run_at ?? 0) || a.id.localeCompare(b.id);
        });
      const next = due[0];
      if (!next) {
        this.logStreak("no-due", now, (count, firstAt) =>
          count === 1 ? `wake no-due: no enabled monitor due (since ${firstAt})`
            : `wake no-due streak: ${count} ticks, first ${firstAt}`);
        return "no-due";
      }
      this.clearStreak("no-due");
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
        // V2 §13.8: every claim carries owner identity (fencing). Fields are
        // additive; release() drops them with the claim.
        monitor.run = {
          active: true,
          started_at: iso(now),
          action: null,
          owner_pid: process.pid,
          ...(this.engineGeneration !== "unknown" ? { owner_generation: this.engineGeneration } : {}),
        };
        // V2 §13.1/§13.2: sync per-worker investigation episodes (anchor init
        // from creation fallback) BEFORE the due evaluation reads them.
        this.syncWorkerInvestigation(monitor, now);
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
    // Observe bounded own-worker completion first so a finished dispatched
    // worker changes the worker index before the change/no-op decision.
    if (await this.observeWorkers(monitor, now)) {
      const observed = await readRegistrySnapshot(this.project);
      const synced = observed.registry.monitors.find((entry) => entry.id === id);
      if (synced) monitor.workers = synced.workers;
    }
    // ---- operator abort request: verified native abort, no canonical read ----
    if (monitor.abort_request) {
      const ensured = await this.ensureSession(monitor, now);
      if (ensured.kind === "session-error") {
        await this.release(id, now, null, (record) => {
          monitorHistory(record, "session-unavailable", { reason: ensured.reason }, now);
        });
        return "error";
      }
      const aborted = await this.abortAndVerify(ensured.sessionId, id, now);
      if (aborted.kind === "cleared") {
        await this.release(id, now, "run-aborted", (record) => {
          record.abort_request = null;
          monitorHistory(record, "run-aborted", { abort: aborted.state, source: "operator-request" }, now);
        });
        return "recovery-parked";
      }
      await this.release(id, now, "run-abort-uncertain", (record) => {
        monitorHistory(record, "run-abort-uncertain", { abort: aborted.state, source: "operator-request" }, now);
      });
      return "recovery-parked";
    }

    // ---- canonical snapshot (bounded, honest coverage) ----
    const canonical = await this.snapshotCanonical(id, now, monitor);
    if (canonical.kind === "unavailable") return "board-unavailable";
    if (canonical.kind === "read-backoff") return "read-backoff";
    if (canonical.kind === "read-exhausted") return "read-exhausted";

    const summary = canonical.summary;
    const previously = monitor.state.last_seen_digest;
    const triggered = monitor.wake_request !== null;
    const operatorTriggered = triggered && !monitor.wake_request!.reason.startsWith("investigation-due:");
    const decisionsSince = canonical.decisionsSince;
    // Worker creation/receipt/lifecycle/synthesis deltas must reach the manager
    // as a wake, not be swallowed by the unchanged-board no-op (W4 wake progress).
    const workerDigest = workerIndexDigest(monitor);
    const previousWorkerDigest = monitor.state.worker_digest ?? null;

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
          record.state.worker_digest = workerDigest;
          record.wake_request = null;
          this.reanchorAfterReconciliation(record, now);
          this.resumeRecoveryPark(record, "dispatch-reconciled", now);
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

    // ---- P5 (V2 §13.3/§13.7): adaptive investigation due — evaluated BEFORE
    // the no-op shortcut AND the busy gate, so a due read-only investigation is
    // never absorbed by `noop-unchanged` or `busy-held` (V2 §13.7, C1b). The
    // investigation is this wake's one bounded action and performs zero sends.
    const dueWorker = this.investigationDue(monitor, now);
    if (dueWorker && !operatorTriggered) {
      return await this.runInvestigation(id, monitor, dueWorker, now);
    }

    // Cheap unchanged path: no model call, no note growth. A pending trigger or
    // a changed worker index (creation/receipt/lifecycle/synthesis) is not a
    // no-op and proceeds to a bounded wake. be951293 gate fix: an unchanged
    // board may only be a no-op when the current admitted dispatch receipt has
    // no unobserved terminal outcome — otherwise the watch below runs first,
    // so a turn that failed AFTER admission still reaches evidence/recovery.
    const unchangedBoard = summary.digest === previously && workerDigest === previousWorkerDigest && !triggered;
    const dispatchedReceipt = monitor.dispatch_wal?.message_id ?? null;
    const observedReceipt = monitor.state.receipt_observation?.receipt ?? null;
    if (unchangedBoard && (dispatchedReceipt === null || observedReceipt === dispatchedReceipt)) {
      await this.release(id, now, null, (record) => {
        // QC-F2 (waveA-qc SHA765c4f03): cause-specific merge keys — never mix
        // different noop causes into one count that only names the first reason.
        monitorDecision(
          record,
          "noop-unchanged",
          { reason: "canonical-and-worker-index-unchanged" },
          "noop-unchanged:canonical-and-worker-index-unchanged",
          now,
        );
      });
      return "noop-unchanged";
    }
    if (unchangedBoard && dispatchedReceipt !== null) {
      return await this.observeUnchangedReceipt(id, now, monitor, summary, dispatchedReceipt);
    }

    // ---- technical state gate (busy alone never aborts) ----
    const session = await this.ensureSession(monitor, now);
    if (session.kind === "session-error") {
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "session-unavailable", { reason: session.reason }, now);
      });
      return "error";
    }
    // A (re)bind inside this wake must not leave the in-flight view on the stale
    // claim snapshot: later steps of the same wake (runtime resolution, priming
    // decision) use the session the registry actually holds now.
    if (monitor.session.session_id !== session.sessionId || (monitor.session.priming_digest ?? null) !== session.primingDigest) {
      monitor.session = { ...monitor.session, session_id: session.sessionId, priming_digest: session.primingDigest };
    }
    const status = await this.gateway.getSessionStatus(session.sessionId, monitor.dispatch_wal?.message_id ?? undefined);
    const pending = await this.combinedPending(session.sessionId);
    if (!pending) {
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "busy-held", { reason: "pending-coverage-unavailable" }, now);
      });
      return "busy-held";
    }
    if (pending.permissions + pending.questions > 0) {
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "busy-held", { reason: "pending-input" }, now);
      });
      return "busy-held";
    }

    // ---- evidenced blocked-error recovery / compaction (never on busy alone) ----
    const evidenced = classifyEvidence(status);
    if (evidenced.kind === "blocked") {
      if (evidenced.category === "context_input_length") return this.compactionContinue(id, now, monitor, session.sessionId, summary);
      return this.recover(id, now, monitor, session.sessionId, evidenced, summary, session.primingDigest);
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
      // Priming is digest-gated: a new/rebound session, a changed anchor,
      // autonomy/runtime profile or document revision re-primes once; an
      // unchanged context keeps the wake short (no full priming per tick).
      const priming = this.primingDigest(monitor, summary);
      // Fresh digest from ensureSession: a rebind inside this very wake resets it
      // to null, so the brand-new session is primed in the same admitted message.
      const prime = session.primingDigest !== priming;
      const prompt = this.buildWakePrompt(monitor, summary, decisionsSince, actionId, triggered, prime);
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
            record.state.worker_digest = workerDigest;
            record.wake_request = null;
            if (reconciled.kind === "found") {
              monitorHistory(record, "dispatch-reconciled", { message_id: reconciled.messageId }, now);
              this.reanchorAfterReconciliation(record, now);
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
        record.state.worker_digest = workerDigest;
        record.wake_request = null;
        if (prime) this.recordPriming(record, priming, now);
        // Welle B §4.5 (R1 scoping): a healthy admitted wake closes a still-open
        // recovery episode — the fallback step evidently worked, the Primary is
        // free again on the very next normal wake, with NO cooldown and without
        // forgetting anything mid-EPISODE (this wake observed no blocked error).
        if (record.recovery_episode) {
          record.recovery_episode = null;
          monitorHistory(record, "recovery-episode-closed", { reason: "healthy-wake" }, now);
        }
        this.resumeRecoveryPark(record, "healthy-dispatch", now);
        monitorHistory(record, triggered ? "noop-trigger" : "dispatched", { message_id: result.message_id, action_id: actionId, primed: prime }, now);
        this.appendDecisionSummary(record, summary, decisionsSince, now);
      });
      return triggered ? "noop-trigger" : "dispatched";
    }
    await this.release(id, now, null, (record) => {
      monitorDecision(
        record,
        "noop-unchanged",
        { reason: "runtime-resolved-without-dispatch" },
        "noop-unchanged:runtime-resolved-without-dispatch",
        now,
      );
    });
    return "noop-unchanged";
  }

  /**
   * W4 minimal existing-path observation, Wave A-extended: poll a bounded number
   * of dispatched own workers (active + dispatch receipt + runtime session)
   * through the existing session-status gateway WITH the worker's own
   * dispatch_receipt as the correlation argument, so only the worker's own
   * turn is ever attributed (foreign or manually driven turns are not).
   *
   * A terminal completed turn is marked `idle` with a fresh `result_receipt`.
   * A terminal FAILED turn (classifyEvidence blocked, category `unknown`
   * included — observation may use the full classifier) is marked
   * conservatively `idle` plus an additive error marker (category, fingerprint,
   * time, correlated receipt, explicit null when none). Both change hashed
   * fields, so workerIndexDigest moves and the existing W4 mechanism wakes the
   * manager exactly once per distinct terminal error; an already-marked worker
   * leaves the candidate set, so repeated observation of the same state writes
   * nothing (idempotent, no endless delta wake). No lifecycle enum value is
   * added. Observation never routes providers: unknown, fachlich, pending and
   * aborted evidence is held as an honest named note, not a fallback decision.
   * Unobservability (status read failure) stays unobservability — it is logged,
   * never a silent continue. No subscription, no new timer, cadence unchanged.
   */
  private async observeWorkers(monitor: MonitorRecord, now: number): Promise<boolean> {
    const candidates = (monitor.workers ?? [])
      .filter((worker) => worker.lifecycle === "active" && worker.runtime_session_id && worker.dispatch_receipt)
      .slice(0, 5);
    if (candidates.length === 0) return false;
    type Observation =
      | { kind: "mark-complete"; worker: MonitorWorkerRecord; resultReceipt: string }
      | { kind: "mark-failed"; worker: MonitorWorkerRecord; resultReceipt: string | null; marker: MonitorWorkerErrorMarker }
      | { kind: "note"; worker: MonitorWorkerRecord; type: string; reason: string; extra?: Record<string, unknown> };
    const observations: Observation[] = [];
    for (const worker of candidates) {
      const sessionId = worker.runtime_session_id as string;
      const dispatchReceipt = worker.dispatch_receipt as string;
      let status: SessionStatusResult;
      try {
        status = await this.gateway.getSessionStatus(sessionId, dispatchReceipt);
      } catch (error) {
        const code = (errorCode(error) ?? "unknown").slice(0, 64);
        observations.push({ kind: "note", worker, type: "worker-observe-error", reason: "status-read-failed", extra: { code } });
        this.log("warn", `worker status read failed monitor=${monitor.id} worker=${worker.worker_key} alias=${worker.alias} code=${code}`);
        continue; // unobservable now; never a silent completion, never a fabricated event
      }
      if (status.backend_activity !== "idle") continue; // running turn: cadence, nothing decided yet
      if (status.state === "completed") {
        const resultReceipt = status.assistant_message_ids.at(-1) ?? null;
        if (resultReceipt === null) {
          observations.push({ kind: "note", worker, type: "worker-observe-held", reason: "completed-without-terminal-receipt" });
          continue;
        }
        observations.push({ kind: "mark-complete", worker, resultReceipt });
        continue;
      }
      if (status.state === "failed") {
        const evidenced = classifyEvidence(status);
        if (evidenced.kind === "blocked") {
          const resultReceipt = status.assistant_message_ids.at(-1) ?? null;
          observations.push({
            kind: "mark-failed",
            worker,
            resultReceipt,
            marker: { at: iso(now), category: evidenced.category, fingerprint: evidenced.fingerprint, receipt: resultReceipt },
          });
        } else if (status.error_details && status.error_details.length > 0) {
          observations.push({ kind: "note", worker, type: "worker-observe-held", reason: "failed-aborted-terminal-no-provider-evidence" });
        } else {
          observations.push({ kind: "note", worker, type: "worker-observe-held", reason: "failed-without-error-evidence" });
        }
        continue;
      }
      if (status.state === "aborted") {
        observations.push({ kind: "note", worker, type: "worker-observe-held", reason: "turn-aborted" });
        continue;
      }
      if (status.pending_input.permissions + status.pending_input.questions > 0) {
        observations.push({ kind: "note", worker, type: "worker-observe-held", reason: "turn-input-required" });
        continue;
      }
      observations.push({
        kind: "note",
        worker,
        type: "worker-observe-held",
        reason: status.state === "unknown" ? "turn-not-attributable" : "turn-not-terminal",
        ...(status.task_status_reason ? { extra: { evidence: status.task_status_reason } } : {}),
      });
    }
    if (observations.length === 0) return false;
    let changed = false;
    await withRegistry(
      this.project,
      (registry) => {
        const monitorRecord = registry.monitors.find((entry) => entry.id === monitor.id);
        if (!monitorRecord) return registry;
        for (const observation of observations) {
          const record = monitorRecord.workers?.find((entry) => entry.worker_key === observation.worker.worker_key);
          // Idempotence across racing writers: only an still-own active worker is marked or noted.
          if (!record || record.lifecycle !== "active") continue;
          if (record.runtime_session_id !== observation.worker.runtime_session_id || record.dispatch_receipt !== observation.worker.dispatch_receipt) {
            monitorHistory(monitorRecord, "worker-observation-superseded", {
              worker_key: record.worker_key, session_id: observation.worker.runtime_session_id,
              dispatch_receipt: observation.worker.dispatch_receipt,
            }, now);
            changed = true; // Refresh the in-flight view from the newer index.
            continue;
          }
          if (observation.kind === "note") {
            monitorDecision(
              monitorRecord,
              observation.type,
              { worker_key: record.worker_key, alias: record.alias, reason: observation.reason, ...(observation.extra ?? {}) },
              `${observation.type}:${record.worker_key}:${observation.reason}`,
              now,
            );
            continue;
          }
          if (observation.kind === "mark-complete") {
            record.lifecycle = "idle";
            record.result_receipt = observation.resultReceipt;
            record.updated_at = iso(now);
            monitorRecord.updated_at = iso(now);
            // V2 §13.4/§10-A8: a receipt-correlated terminal worker result is
            // ENGINE-SIDE evidence of professional progress (A). It resets the
            // worker's progress clock, cooldown and backoff ladder to stage 0.
            // Investigation results never do this (V2 §13.4).
            const cfg = this.effectiveInvestigationConfig(monitorRecord).config;
            const inv = monitorRecord.investigation ??= defaultInvestigationState();
            const workerState = investigationWorkerFor(inv, record.worker_key, record.dispatch_receipt);
            workerState.last_progress_at = iso(now);
            workerState.backoff_stage = 0;
            workerState.cooldown_until = null;
            workerState.next_deep_check_at = now + cfg.first_check_s * 1000;
            if (workerState.anchored_at === null) {
              workerState.anchored_at = record.dispatch_at ?? record.created_at;
              workerState.anchor_source = record.dispatch_at ? "dispatch" : "creation";
            }
            // V2 §13.3/F1: genuine A evidence achieves a declared milestone.
            if (inv.milestone && inv.milestone.achieved_at === null) inv.milestone.achieved_at = iso(now);
            refreshInvestigationProjections(inv);
            monitorHistory(monitorRecord, "worker-observed-complete", {
              worker_key: record.worker_key,
              alias: record.alias,
              result_receipt: observation.resultReceipt,
            }, now);
            changed = true;
            continue;
          }
          record.lifecycle = "idle";
          record.result_receipt = observation.resultReceipt;
          record.last_error = observation.marker;
          record.updated_at = iso(now);
          monitorRecord.updated_at = iso(now);
          monitorHistory(monitorRecord, "worker-observed-failed", {
            worker_key: record.worker_key,
            alias: record.alias,
            dispatch_receipt: record.dispatch_receipt,
            category: observation.marker.category,
            fingerprint: observation.marker.fingerprint,
            result_receipt: observation.resultReceipt,
          }, now);
          changed = true;
          this.log(
            "info",
            `worker terminal failure observed monitor=${monitor.id} worker=${record.worker_key} alias=${record.alias} category=${observation.marker.category} fingerprint=${observation.marker.fingerprint.slice(0, 16)} receipt=${observation.resultReceipt ?? "none"}`,
          );
        }
        return registry;
      },
      { now },
    );
    return changed;
  }

  /**
   * be951293 gate fix (2026-10-10): unchanged-board receipt watch.
   *
   * The unchanged/no-op shortcut never re-read the manager session, so an
   * admitted dispatch whose turn later ended terminally failed stayed
   * invisible forever (live AITL case 2026-10-10: provider_header_timeout
   * swallowed in a silent noop-unchanged loop — no recovery, no park). This
   * watch runs at most once per DISTINCT receipt (state.receipt_observation),
   * correlates the status read through the dispatch receipt exactly like the
   * normal flow, and reuses the existing machinery unchanged: pending-input
   * SafeHold, W2 budget, provider admission, native abort verification, the
   * shared Schema-4 chain resolution, WAL handling. No new fallback semantics.
   *
   * Convergence rules (bounded, no loops on a quiet board):
   * - verified terminal health ONLY (idle, no pending, `completed`, no
   *   provider evidence) settles the watch as healthy and closes an open
   *   episode exactly like a healthy wake (§4.5 R1) — QC G1: unknown/
   *   submitted/aborted/bare-failed are NOT reliable terminal evidence,
   *   never settle, and stay open as one transparent merged decision so a
   *   later terminal outcome of the same receipt is still observed;
   * - blocked → the existing recover()/compactionContinue() path runs; a real
   *   park settles the watch (park state stays transparently visible), a
   *   dispatched recovery/continuation moves the watch to the new receipt;
   * - held aborts and holds without provider admission settle the watch
   *   instead of retrying side-effectful aborts every interval (deliberate
   *   divergence from the changed-board retry loop, which keeps its existing
   *   behavior); chain-advancing errors (update-unverified, send-failed) do
   *   NOT settle — the finite episode advances until it parks;
   * - pending input, an active turn or an unconfirmed state stays a merged
   *   bounded decision, never per-tick history growth.
   */
  private async observeUnchangedReceipt(
    id: string,
    now: number,
    monitor: MonitorRecord,
    summary: CanonicalSummary,
    dispatchedReceipt: string,
  ): Promise<WakeOutcome> {
    const session = await this.ensureSession(monitor, now);
    if (session.kind === "session-error") {
      await this.release(id, now, null, (record) => {
        monitorHistory(record, "session-unavailable", { reason: session.reason }, now);
      });
      return "error";
    }
    if (monitor.session.session_id !== session.sessionId || (monitor.session.priming_digest ?? null) !== session.primingDigest) {
      monitor.session = { ...monitor.session, session_id: session.sessionId, priming_digest: session.primingDigest };
    }
    const status = await this.gateway.getSessionStatus(session.sessionId, dispatchedReceipt);
    const pending = await this.combinedPending(session.sessionId);
    if (!pending || pending.permissions + pending.questions > 0) {
      const reason = !pending ? "pending-coverage-unavailable" : "pending-input";
      await this.release(id, now, null, (record) => {
        monitorDecision(
          record,
          "receipt-watch",
          { reason, receipt: dispatchedReceipt },
          `receipt-watch:${dispatchedReceipt}:${reason}`,
          now,
        );
      });
      return "busy-held";
    }
    const evidenced = classifyEvidence(status);
    if (evidenced.kind === "blocked") {
      if (evidenced.category === "context_input_length") {
        // A still-active continuation turn must not settle the watch; retries
        // stay bounded by the same convergence as the changed-board flow.
        return await this.compactionContinue(id, now, monitor, session.sessionId, summary);
      }
      const outcome = await this.recover(id, now, monitor, session.sessionId, evidenced, summary, session.primingDigest);
      if (outcome === "recovery-parked") {
        // A real park is terminal and transparently visible; a hold (no
        // provider admission, held abort) settles without a park. Either way
        // the quiet board must not retry side-effectful recovery each tick —
        // the operator trigger stays the sanctioned restart.
        await this.settleReceiptWatch(id, dispatchedReceipt, now);
      }
      return outcome;
    }
    if (status.backend_activity !== "idle" || status.state === "running") {
      await this.release(id, now, null, (record) => {
        monitorDecision(
          record,
          "receipt-watch",
          { reason: "turn-active", receipt: dispatchedReceipt },
          `receipt-watch:${dispatchedReceipt}:turn-active`,
          now,
        );
      });
      return "busy-held";
    }
    if (status.state !== "completed") {
      // QC G1 fix: unknown/submitted/input_required/aborted (and any failed
      // state without provider evidence, already classified `none` above) is
      // NOT reliable terminal evidence. Settling here would swallow a later
      // terminal outcome of the SAME receipt (0 reads, no recovery). The
      // watch stays open: each tick re-reads once and names the observed
      // state in one transparent merged decision until verified terminal
      // health or a recovery decision exists. Aborted is therefore named and
      // visible, never reinterpreted as healthy.
      await this.release(id, now, null, (record) => {
        monitorDecision(
          record,
          "receipt-watch",
          { reason: "receipt-not-confirmed-terminal", receipt: dispatchedReceipt, state: status.state },
          `receipt-watch:${dispatchedReceipt}:not-confirmed-terminal`,
          now,
        );
      });
      return "busy-held";
    }
    // Verified terminal health: idle, no pending input, `completed`, no
    // provider evidence. Only THIS settles the watch as healthy; a healthy
    // receipt closes an open recovery episode exactly like a healthy wake
    // (§4.5 R1).
    await this.release(id, now, null, (record) => {
      record.state.receipt_observation = { receipt: dispatchedReceipt, outcome: "healthy", at: iso(now) };
      if (record.recovery_episode) {
        record.recovery_episode = null;
        monitorHistory(record, "recovery-episode-closed", { reason: "receipt-observed-healthy" }, now);
      }
      this.reanchorAfterReconciliation(record, now);
      monitorDecision(
        record,
        "noop-unchanged",
        { reason: "receipt-observed-healthy" },
        "noop-unchanged:receipt-observed-healthy",
        now,
      );
    });
    return "noop-unchanged";
  }

  /** Settles the unchanged-board receipt watch for one distinct receipt. */
  private async settleReceiptWatch(id: string, receipt: string, now: number): Promise<void> {
    await withRegistry(
      this.project,
      (registry) => {
        const record = registry.monitors.find((entry) => entry.id === id);
        if (!record) return registry;
        record.state.receipt_observation = { receipt, outcome: "held", at: iso(now) };
        monitorDecision(
          record,
          "receipt-watch",
          { reason: "settled-held", receipt },
          `receipt-watch:${receipt}:settled-held`,
          now,
        );
        return registry;
      },
      { now },
    );
  }

  // --------------------------------------------------- investigation (V2 §13)

  private effectiveInvestigationConfig(monitor: MonitorRecord): MonitorInvestigationConfig {
    return monitor.investigation_config ?? defaultInvestigationConfig();
  }

  /**
   * V2 §13.1/§13.2: per-worker episode sync. A worker gets an investigation
   * state on first sight; a dispatch_receipt change starts a NEW episode with
   * a fresh anchor. Anchor (§13.2): the actual dispatch is not recorded
   * engine-side per worker, so the documented creation fallback
   * (`worker.created_at`) is used; only when even that is missing does the
   * anchor become "reconciled" at first observation (counted, transparent).
   * The first deep check happens T_first AFTER the anchor — never immediately.
   */
  private syncWorkerInvestigation(monitor: MonitorRecord, now: number): void {
    const workers = monitor.workers ?? [];
    const withReceipt = workers.filter((worker) => worker.dispatch_receipt &&
      (worker.lifecycle === "active" || (worker.lifecycle === "idle" && worker.result_receipt && !worker.last_synthesis_at)));
    if (withReceipt.length === 0 && !monitor.investigation) return;
    const inv = monitor.investigation ??= defaultInvestigationState();
    // Only current, eligible dispatch episodes own a clock. Historic episode
    // evidence/history and worker results survive; stale clocks cannot wake.
    inv.workers = inv.workers.filter((state) => withReceipt.some((worker) => worker.worker_key === state.worker_key));
    const cfg = this.effectiveInvestigationConfig(monitor).config;
    for (const worker of withReceipt) {
      const state = investigationWorkerFor(inv, worker.worker_key, worker.dispatch_receipt);
      if (state.anchored_at === null) {
        // V2 §13.2/F4 anchor preference: the dispatch-correlated time basis
        // captured at rebind; creation time only as the flagged legacy
        // fallback (never resets without a genuinely new receipt).
        if (worker.dispatch_at) {
          state.anchored_at = worker.dispatch_at;
          state.anchor_source = "dispatch";
        } else if (worker.created_at) {
          state.anchored_at = worker.created_at;
          state.anchor_source = "creation";
        } else {
          state.anchored_at = iso(now);
          state.anchor_source = "reconciled";
          inv.counters.anchor_unknown_total += 1;
          monitorDecision(
            monitor,
            "investigation-anchor-unknown",
            { worker_key: worker.worker_key, anchor: iso(now) },
            `investigation-anchor-unknown:${worker.worker_key}:${(worker.dispatch_receipt ?? "none").slice(0, 24)}`,
            now,
          );
        }
        state.next_deep_check_at = Date.parse(state.anchored_at) + cfg.first_check_s * 1000;
      }
    }
    refreshInvestigationProjections(inv);
  }

  /**
   * V2 §13.3: the due worker for this wake (oldest due first, one
   * investigation per wake). Holds: parked/stopped work, open recovery
   * (clock hold, §13.5), unresolved dispatch WAL (uncertain writes reconcile
   * first), an open episode, and the not-yet-anchored initial window.
   */
  private investigationDue(monitor: MonitorRecord, now: number): InvestigationWorkerState | null {
    const inv = monitor.investigation;
    if (!inv || monitor.state.work !== "active" || monitor.recovery.active) return null;
    if (monitor.dispatch_wal && monitor.dispatch_wal.message_id === null) return null;
    if (inv.episode && inv.episode.finished_at === null) return null;
    const anchored = inv.workers
      .filter((state) => state.anchored_at !== null && (monitor.workers ?? []).some((worker) =>
        worker.worker_key === state.worker_key && worker.dispatch_receipt !== null && worker.dispatch_receipt === state.dispatch_receipt &&
        (worker.lifecycle === "active" || (worker.lifecycle === "idle" && worker.result_receipt && !worker.last_synthesis_at))))
      .sort((a, b) => (a.next_deep_check_at ?? Number.MAX_SAFE_INTEGER) - (b.next_deep_check_at ?? Number.MAX_SAFE_INTEGER));
    const clockDue = anchored.filter((worker) => (worker.next_deep_check_at ?? Number.MAX_SAFE_INTEGER) <= now)[0] ?? null;
    if (clockDue) return clockDue;
    // V2 §13.3/F1: an UNACHIEVED, OVERDUE and not-yet-handled milestone on a
    // `milestoned` contract pulls the earliest anchored worker forward ONCE
    // per deadline value (no due loop — the handling is recorded and a
    // CHANGED deadline may trigger again). Cheap checks are unaffected.
    const task = this.effectiveInvestigationConfig(monitor).task;
    if (task.task_type === "milestoned" && task.expected_milestone && task.milestone_due_at) {
      const dueMs = Date.parse(task.milestone_due_at);
      const milestone = inv.milestone ?? { overdue_handled_for: null, overdue_handled_at: null, achieved_at: null };
      if (!Number.isNaN(dueMs) && dueMs <= now && milestone.achieved_at === null && milestone.overdue_handled_for !== task.milestone_due_at) {
        return anchored[0] ?? null;
      }
    }
    return null;
  }

  /**
   * V2 §13.5: after an admitted reconciliation step (healthy dispatch,
   * recovery-continued, verified-healthy receipt) the worker clocks RE-ANCHOR
   * at the reconciliation completion (new episode); `last_progress_at` is
   * NEVER touched and `backoff_stage` stays unchanged (no false reset).
   */
  private reanchorAfterReconciliation(monitor: MonitorRecord, now: number): void {
    const inv = monitor.investigation;
    if (!inv || inv.workers.length === 0) return;
    const cfg = this.effectiveInvestigationConfig(monitor).config;
    for (const worker of inv.workers) {
      worker.anchored_at = iso(now);
      worker.anchor_source = "reconciled";
      worker.next_deep_check_at = now + cfg.first_check_s * 1000;
      worker.cooldown_until = null;
    }
    refreshInvestigationProjections(inv);
  }

  /**
   * V2 §13.3/§13.4: one budgeted, strictly read-only investigation for the
   * due worker episode. Sends zero messages, routes nothing, never counts as
   * progress. Positive long-work evidence is deliberately narrow (V2 §13.4):
   * (a) attributable in-flight tool progress delta on the worker's OWN
   * dispatch receipt (optional `getSessionProgress`), (c) a newly admitted
   * dispatch episode since the previous investigation. Merely stale running,
   * unattributable activity or board bookkeeping is `inconclusive`.
   */
  private async runInvestigation(
    id: string,
    monitor: MonitorRecord,
    dueWorker: InvestigationWorkerState,
    now: number,
  ): Promise<WakeOutcome> {
    const { config, task } = this.effectiveInvestigationConfig(monitor);
    const evidence: InvestigationEvidenceEntry[] = [];
    let outcome: InvestigationEpisodeState["outcome"] = null;
    let waitReason: string | null = null;
    const worker = (monitor.workers ?? []).find((entry) => entry.worker_key === dueWorker.worker_key) ?? null;
    const receipt = worker?.dispatch_receipt ?? null;
    const sessionId = worker?.runtime_session_id ?? null;
    let callsUsed = 0;
    let toolDigest: string | null = null;
    let episodeAdvanced = false;
    let bytesUsed = 0;
    const startedMs = now;
    const invState = monitor.investigation!;

    // ---- F1: daily rolling budget (24 h window over EXECUTED runs). A run
    // over the limit is DEFERRED — transparently, with the exact window end as
    // the next due time; it never counts, never creates an episode, and the
    // cheap checks continue unaffected.
    const dailyLimit = config.budget.daily_budget;
    const recentWindow = (invState.recent_investigations ?? []).filter((entry) => now - entry < 86_400_000);
    if (recentWindow.length >= dailyLimit) {
      const windowEnd = Math.min(...recentWindow) + 86_400_000;
      await withRegistry(
        this.project,
        (registry) => {
          const record = registry.monitors.find((entry) => entry.id === id);
          if (!record) return registry;
          const inv = record.investigation!;
          const current = record.workers?.find(entry => entry.worker_key === dueWorker.worker_key);
          if (current && current.runtime_session_id === sessionId && current.dispatch_receipt === dueWorker.dispatch_receipt && current.lifecycle === worker?.lifecycle) {
            const state = investigationWorkerFor(inv, dueWorker.worker_key, dueWorker.dispatch_receipt);
            state.next_deep_check_at = windowEnd;
            state.cooldown_until = null;
            refreshInvestigationProjections(inv);
          }
          if (record.wake_request?.reason.startsWith("investigation-due:") &&
              digest(record.wake_request) === digest(monitor.wake_request)) record.wake_request = null;
          record.run = { active: false, started_at: null, action: "investigation-deferred" };
          if (record.scheduler.enabled) record.scheduler.next_run_at = now + record.scheduler.interval_seconds * 1000;
          monitorDecision(
            record,
            "investigation-deferred",
            { reason: "daily-budget", window_used: recentWindow.length, limit: dailyLimit, next_check: iso(windowEnd) },
            `investigation-deferred:${dueWorker.worker_key}:${(dueWorker.dispatch_receipt ?? "none").slice(0, 24)}:daily-budget`,
            now,
          );
          return registry;
        },
        { now },
      );
      this.log("info", `investigation deferred (daily budget) monitor=${id} worker=${dueWorker.worker_key} next=${iso(windowEnd)}`);
      return "investigation-deferred";
    }

    // ---- F2: budgeted, timeout-guarded read admission. Bytes are counted
    // after each response (the endpoints are contractually bounded metadata
    // snapshots — no raw content is requested) and admitted BEFORE the next
    // call; the timeout bounds OUR wait per call, the backend keeps its own
    // transport timeout. A blocked admission never issues the call.
    let investigationAborted = false;
    const callGate = async <T>(label: string, call: () => Promise<T>): Promise<T | null> => {
      if (investigationAborted) return null;
      if (this.now() - startedMs >= config.budget.max_duration_ms || callsUsed >= config.budget.max_calls || bytesUsed >= config.budget.max_bytes) {
        investigationAborted = true;
        outcome = "aborted_budget";
        evidence.push({ kind: "budget_exhausted", source: "admission", at: iso(now), digest: `c${callsUsed}/b${bytesUsed}`.slice(0, 16) });
        return null;
      }
      callsUsed += 1;
      try {
        const result = await withCallTimeout(call(), config.budget.call_timeout_ms, label);
        bytesUsed += Buffer.byteLength(JSON.stringify(result) ?? "null");
        return result;
      } catch (error) {
        const code = errorCode(error);
        evidence.push({ kind: code === "CALL_TIMEOUT" ? "call_timeout" : "read_failed", source: label, at: iso(now), digest: (code ?? "unknown").slice(0, 16) });
        outcome = "aborted_budget";
        investigationAborted = true;
        return null;
      }
    };

    if (!worker || !receipt) {
      outcome = "no_progress_evidenced";
    } else if (receipt !== dueWorker.dispatch_receipt) {
      // (c) new dispatch episode admitted after the previous investigation.
      evidence.push({ kind: "new_dispatch_episode", source: "worker_registry", at: iso(now), digest: digest({ r: receipt }).slice(0, 16) });
      outcome = "long_work_evidenced";
      waitReason = "worker re-dispatched after the previous investigation";
      episodeAdvanced = true;
    } else if (worker.lifecycle === "idle" && worker.result_receipt && !worker.last_synthesis_at) {
      evidence.push({ kind: "terminal_result_pending_synthesis", source: "worker_registry", at: iso(now), digest: digest({ r: worker.result_receipt }).slice(0, 16) });
      outcome = "long_work_evidenced";
      waitReason = "worker result awaiting manager synthesis";
    } else if (worker.lifecycle === "active" && sessionId && receipt) {
      // (a) attributable tool progress via the optional progress capability.
      if (this.gateway.getSessionProgress) {
        const progress = await callGate("get_session_progress", () => this.gateway.getSessionProgress!(sessionId!, receipt));
        if (progress) {
          toolDigest = digest(progress.in_flight_tools.map((tool) => [tool.call_id, tool.status, tool.finished_at ?? null]));
          if (dueWorker.last_tool_digest !== null && toolDigest !== dueWorker.last_tool_digest) {
            evidence.push({ kind: "attributable_tool_progress", source: "get_session_progress", at: iso(now), digest: toolDigest.slice(0, 16) });
            outcome = "long_work_evidenced";
            waitReason = "attributable in-flight tool progress on the worker's own dispatch receipt";
          }
          // First observation records the baseline only: a delta needs two
          // points, so this round stays inconclusive (stale running alone is
          // never long-work evidence, V2 §13.4).
        }
      } else {
        evidence.push({ kind: "progress_telemetry_unavailable", source: "gateway", at: iso(now), digest: "none" });
      }
      if (outcome === null && !this.gateway.getSessionProgress && !investigationAborted) {
        // Attribution impossible without telemetry; a bounded status read
        // names the observed state honestly (one extra call, still in budget).
        const status = await callGate("get_session_status", () => this.gateway.getSessionStatus(sessionId!, receipt));
        if (status) {
          evidence.push({ kind: `status_${status.backend_activity}`, source: "get_session_status", at: iso(now), digest: digest({ s: status.state }).slice(0, 16) });
        }
      }
      // (b) F1: receipt-correlated checkpoint evidence — a bounded scan of the
      // task's recent management journal for the worker's own receipt tokens.
      // Without text access this records the precise evidence boundary and
      // claims nothing.
      if (outcome === null && this.board && !investigationAborted && receipt) {
        const page = await callGate("get_management_history", () =>
          this.board!.getManagementHistory(monitor.anchor.task_id, { mode: "recent", limit: 20 }));
        if (page) {
          const entries = Array.isArray(page.entries) ? page.entries.slice(0, 20) : [];
          const tokens = [receipt, worker.result_receipt].filter((token): token is string => typeof token === "string" && token.length > 0);
          let matched = false;
          let textSeen = false;
          for (const entry of entries) {
            const text = typeof entry.text === "string" ? entry.text.slice(0, 2_000) : "";
            if (text.length > 0) textSeen = true;
            if (text.length > 0 && tokens.some((token) => text.includes(token))) { matched = true; break; }
          }
          if (matched) {
            evidence.push({ kind: "receipt_correlated_checkpoint", source: "management_journal", at: iso(now), digest: digest({ r: tokens[0] }).slice(0, 16) });
            outcome = "long_work_evidenced";
            waitReason = "receipt-correlated checkpoint in the management journal";
          } else {
            evidence.push({ kind: "checkpoint_evidence_unavailable", source: "management_journal", at: iso(now), digest: textSeen ? "no-match" : "no-text" });
          }
        }
      }
    }

    if (outcome === null) {
      const attributionBlocked = evidence.some((entry) => entry.kind === "progress_read_failed" ||
        entry.kind === "status_read_failed" || entry.kind === "progress_telemetry_unavailable" || entry.kind === "call_timeout");
      outcome = attributionBlocked || worker?.lifecycle === "active" ? "inconclusive" : "no_progress_evidenced";
    }

    const finishedMs = this.now();
    const finished = iso(finishedMs);
    await withRegistry(
      this.project,
      (registry) => {
        const record = registry.monitors.find((entry) => entry.id === id);
        if (!record) return registry;
        const inv = record.investigation ??= defaultInvestigationState();
        // A worker investigation is not a manager acknowledgement of board or
        // worker changes. Preserve that delta and any concurrent operator wake.
        if (record.wake_request?.reason.startsWith("investigation-due:") &&
            digest(record.wake_request) === digest(monitor.wake_request)) record.wake_request = null;
        inv.last_investigation_at = finished;
        inv.recent_investigations = [
          ...(inv.recent_investigations ?? []).filter((entry) => finishedMs - entry < 86_400_000),
          finishedMs,
        ].slice(-128);
        inv.counters.investigations_total += 1;
        if (outcome === "inconclusive") inv.counters.inconclusive_total += 1;
        const current = record.workers?.find(entry => entry.worker_key === dueWorker.worker_key);
        const episodeCurrent = current && current.runtime_session_id === sessionId &&
          current.dispatch_receipt === dueWorker.dispatch_receipt && current.lifecycle === worker?.lifecycle;
        let state: InvestigationWorkerState | null = null;
        if (episodeCurrent) {
          // F1: exactly ONE overdue-triggered investigation per deadline value —
          // afterwards only the normal clocks (or a CHANGED deadline) fire again.
          const milestone = inv.milestone ??= { overdue_handled_for: null, overdue_handled_at: null, achieved_at: null };
          if (task.task_type === "milestoned" && task.expected_milestone && task.milestone_due_at) {
            const dueMs = Date.parse(task.milestone_due_at);
            if (!Number.isNaN(dueMs) && dueMs <= finishedMs && milestone.achieved_at === null) {
              milestone.overdue_handled_for = task.milestone_due_at;
              milestone.overdue_handled_at = finished;
            }
          }
          state = investigationWorkerFor(inv, dueWorker.worker_key, dueWorker.dispatch_receipt);
          state.last_tool_digest = toolDigest ?? state.last_tool_digest;
          if (outcome === "long_work_evidenced") {
            state.backoff_stage = Math.min(3, state.backoff_stage + 1);
            state.next_deep_check_at = finishedMs + config.ladder_s[Math.min(2, state.backoff_stage - 1)]! * 1000;
            state.cooldown_until = null;
          } else {
            // Cooldown from the investigation END; the progress clock is
            // untouched (V2 §13.3 — never a already-past deadline, no due loop).
            state.cooldown_until = finishedMs + config.cooldown_s * 1000;
            state.next_deep_check_at = state.cooldown_until;
          }
          if (episodeAdvanced && worker?.dispatch_receipt) {
            // Follow the worker into its new episode (fresh anchor per §13.2).
            state.dispatch_receipt = worker.dispatch_receipt;
            state.anchored_at = worker.created_at ?? finished;
            state.anchor_source = worker.created_at ? "creation" : "reconciled";
            state.next_deep_check_at = Date.parse(state.anchored_at) + config.first_check_s * 1000;
            state.cooldown_until = null;
          }
          refreshInvestigationProjections(inv);
          inv.episode = {
            started_at: iso(now),
            finished_at: finished,
            outcome,
            evidence: evidence.slice(0, 6),
            expected_milestone: task.expected_milestone,
            wait_reason: outcome === "long_work_evidenced" ? waitReason : null,
            worker_key: dueWorker.worker_key,
            dispatch_receipt: dueWorker.dispatch_receipt,
            generation_source: this.engineGeneration !== "unknown" ? "runtime_json" : null,
            generation_value: this.engineGeneration !== "unknown" ? this.engineGeneration : null,
          };
        } else {
          monitorHistory(record, "investigation-superseded", {
            worker_key: dueWorker.worker_key, session_id: sessionId,
            dispatch_receipt: dueWorker.dispatch_receipt, outcome,
            evidence: evidence.slice(0, 3).map(entry => entry.kind),
          }, now);
        }
        // Release the wake claim this investigation consumed (V2 §13.8
        // hygiene: a finished action never leaves an active claim behind).
        record.run = { active: false, started_at: null, action: "investigation" };
        if (record.scheduler.expiry_at !== null && finishedMs >= record.scheduler.expiry_at && record.scheduler.enabled) {
          record.scheduler.enabled = false;
          record.scheduler.next_run_at = null;
          monitorHistory(record, "expired", { at: finished }, now);
        } else if (record.scheduler.enabled) {
          record.scheduler.next_run_at = finishedMs + record.scheduler.interval_seconds * 1000;
        }
        monitorDecision(
          record,
          "investigation",
          { outcome, worker_key: dueWorker.worker_key, wait_reason: outcome === "long_work_evidenced" ? waitReason : null },
          `investigation:${dueWorker.worker_key}:${(dueWorker.dispatch_receipt ?? "none").slice(0, 24)}:${outcome}`,
          now,
        );
        monitorHistory(record, `investigation-${outcome}`, {
          worker_key: dueWorker.worker_key,
          stage: state?.backoff_stage ?? null,
          next_deep_check_at: state?.next_deep_check_at ?? null,
          evidence: evidence.slice(0, 3).map((entry) => entry.kind),
        }, now);
        return registry;
      },
      { now: finishedMs },
    );
    this.log("info", `investigation outcome=${outcome} monitor=${id} worker=${dueWorker.worker_key} stage-read-only`);
    return "investigated";
  }

  /**
   * V2 §13.7 (Z1-corrected): two-phase minimal independent observer.
   *
   * Phase 1 (registry-only): due evaluation, lease acquisition, stuck-own-
   * claim visibility, and the `wake_request` handover of a due investigation.
   *
   * Phase 2 (bounded probe lane): while a wake is IN FLIGHT (`run.active`),
   * perform tightly bounded, receipt-correlated status probes for the
   * monitor's own active workers — at most 3 probes per run, throttled to one
   * batch per 30 s per monitor (`observer_probe_at`), each call bounded by the
   * configured `call_timeout_ms`. Probes are READ-ONLY status reads correlated
   * by the worker's OWN dispatch receipt (no foreign sessions, no arguments,
   * no content); they persist fresh evidence as merged decisions even while
   * the previous wake blocks on its own await — without touching worker state
   * machines, without marking progress, and without any send/recovery/abort/
   * claim release. Execution still happens ONLY through the wake path; the
   * probe lane documents, it does not act.
   */
  async observe(): Promise<void> {
    const now = this.now();
    const engineId = `${process.pid}:${this.engineGeneration}`;
    type Probe = { workerKey: string; sessionId: string; receipt: string };
    const probePlan: Array<{ monitorId: string; timeoutMs: number; probes: Probe[] }> = [];
    await withRegistry(
      this.project,
      (registry) => {
        for (const monitor of registry.monitors) {
          if (!monitor.scheduler.enabled || monitor.state.work === "stopped") continue;
          if (
            monitor.run.active && monitor.run.started_at &&
            (monitor.run.owner_generation ?? "") === this.engineGeneration &&
            now - Date.parse(monitor.run.started_at) > monitor.scheduler.interval_seconds * 1000 * CLAIM_STUCK_INTERVAL_FACTOR
          ) {
            monitorDecision(
              monitor,
              "wake-claim-stuck",
              { reason: "own-claim-extended", since: monitor.run.started_at },
              `wake-claim-stuck:${monitor.id}:own`,
              now,
            );
          }
          this.syncWorkerInvestigation(monitor, now);
          const inv = monitor.investigation;
          if (!inv) continue;
          const lease = inv.observer_lease;
          if (lease && lease.owner !== engineId && lease.lease_until > now) continue;
          inv.observer_lease = { owner: engineId, lease_until: now + OBSERVER_LEASE_TTL_MS, generation: registry.generation };
          const due = this.investigationDue(monitor, now);
          if (due && !monitor.wake_request) {
            monitor.wake_request = { requested_at: iso(now), reason: `investigation-due:${due.worker_key}` };
            monitorDecision(
              monitor,
              "observer-investigation-due",
              { worker_key: due.worker_key },
              `observer-investigation-due:${monitor.id}:${due.worker_key}:${(due.dispatch_receipt ?? "none").slice(0, 24)}`,
              now,
            );
          }
          // Z1 probe lane: only while a wake is in flight, throttled, bounded.
          if (monitor.run.active && now - (inv.observer_probe_at ?? 0) >= OBSERVER_PROBE_THROTTLE_MS) {
            const probes: Probe[] = (monitor.workers ?? [])
              .filter((worker) => worker.lifecycle === "active" && worker.runtime_session_id && worker.dispatch_receipt)
              .slice(0, 3)
              .map((worker) => ({ workerKey: worker.worker_key, sessionId: worker.runtime_session_id as string, receipt: worker.dispatch_receipt as string }));
            if (probes.length > 0) {
              inv.observer_probe_at = now;
              probePlan.push({
                monitorId: monitor.id,
                timeoutMs: this.effectiveInvestigationConfig(monitor).config.budget.call_timeout_ms,
                probes,
              });
            }
          }
        }
        return registry;
      },
      { now },
    );
    for (const plan of probePlan) {
      for (const probe of plan.probes) {
        let activity = "unknown";
        let state = "unknown";
        let failure: string | null = null;
        try {
          const status = await withCallTimeout(
            this.gateway.getSessionStatus(probe.sessionId, probe.receipt),
            plan.timeoutMs,
            "observer-probe",
          );
          activity = status.backend_activity;
          state = status.state;
        } catch (error) {
          failure = (errorCode(error) ?? "unknown").slice(0, 24);
        }
        await withRegistry(
          this.project,
          (registry) => {
            const monitor = registry.monitors.find((entry) => entry.id === plan.monitorId);
            if (!monitor) return registry;
            // Idempotent attribution: only the still-own active worker is named.
            const worker = (monitor.workers ?? []).find((entry) => entry.worker_key === probe.workerKey);
            if (!worker || worker.lifecycle !== "active" || worker.dispatch_receipt !== probe.receipt) return registry;
            monitorDecision(
              monitor,
              "observer-probe",
              failure
                ? { worker_key: probe.workerKey, receipt: probe.receipt.slice(0, 24), error: failure }
                : { worker_key: probe.workerKey, receipt: probe.receipt.slice(0, 24), activity, state },
              `observer-probe:${monitor.id}:${probe.workerKey}:${probe.receipt.slice(0, 24)}`,
              this.now(),
            );
            return registry;
          },
          { now: this.now() },
        );
        if (failure) this.log("warn", `observer probe failed monitor=${plan.monitorId} worker=${probe.workerKey} error=${failure}`);
      }
    }
  }

  /**
   * V2 §13.8: boot-time recovery of orphaned wake claims. Release requires
   * PROOF the owner is gone: the claim carries an owner_generation that
   * matches the recorded heartbeat generation AND that heartbeat is stale.
   * A fresh heartbeat of the claim's owner generation is treated as a
   * possibly still-living old engine — NEVER released (A11b). Legacy claims
   * without owner identity are never released on identity grounds (PID alone
   * is not sufficient process identity); they stay visible as
   * `wake-claim-stuck`. An unresolved uncertain dispatch is reconciled
   * through the existing WAL path first; an unresolved WAL parks
   * `dispatch-uncertain` (never a silent release). No parallel recovery:
   * the sweep runs under the same registry CAS before the wake loop starts.
   */
  async recoverAbandonedClaims(): Promise<number> {
    const now = this.now();
    const heartbeat = await readEngineHeartbeat(this.project, now);
    const orphaned: Array<{ id: string; ownerGeneration: string }> = [];
    await withRegistry(
      this.project,
      (registry) => {
        for (const monitor of registry.monitors) {
          if (!monitor.run.active) continue;
          const ownerGeneration = monitor.run.owner_generation ?? null;
          if (ownerGeneration === null) {
            monitorDecision(monitor, "wake-claim-stuck", { reason: "claim-without-owner-identity" }, `wake-claim-stuck:${monitor.id}:no-identity`, now);
            continue;
          }
          if (ownerGeneration === this.engineGeneration) continue; // possibly living engine (own generation)
          if (!heartbeat || heartbeat.generation !== ownerGeneration) {
            monitorDecision(monitor, "wake-claim-stuck", { reason: "no-heartbeat-evidence", owner_generation: ownerGeneration }, `wake-claim-stuck:${monitor.id}:no-hb`, now);
            continue;
          }
          if (heartbeat.fresh) {
            // A11b: a fresh heartbeat of the owner generation also covers a
            // still-living old engine — never release.
            monitorDecision(monitor, "wake-claim-stuck", { reason: "heartbeat-fresh-owner-generation" }, `wake-claim-stuck:${monitor.id}:fresh-hb`, now);
            continue;
          }
          orphaned.push({ id: monitor.id, ownerGeneration });
        }
        return registry;
      },
      { now },
    );
    let recovered = 0;
    for (const orphan of orphaned) {
      const snapshot = await readRegistrySnapshot(this.project);
      const monitor = snapshot.registry.monitors.find((entry) => entry.id === orphan.id);
      if (!monitor || !monitor.run.active) continue;
      let reconciledMessageId: string | null = null;
      if (monitor.dispatch_wal && monitor.dispatch_wal.message_id === null && monitor.session.session_id) {
        const reconciled = await this.reconcileDispatch(monitor, monitor.session.session_id);
        if (reconciled.kind === "found") reconciledMessageId = reconciled.messageId;
      }
      await withRegistry(
        this.project,
        (registry) => {
          const record = registry.monitors.find((entry) => entry.id === orphan.id);
          if (!record || !record.run.active) return registry;
          let uncertain = false;
          if (record.dispatch_wal && record.dispatch_wal.message_id === null) {
            if (reconciledMessageId !== null) {
              record.dispatch_wal.message_id = reconciledMessageId;
              monitorHistory(record, "dispatch-reconciled", { message_id: reconciledMessageId, via: "claim-recovery" }, now);
            } else {
              uncertain = true;
              record.state.work = "parked_input_required";
              record.state.parked_reason = "dispatch-uncertain";
              monitorHistory(record, "dispatch-uncertain", { action_id: record.dispatch_wal.action_id, via: "claim-recovery" }, now);
            }
          }
          record.run = { active: false, started_at: null, action: "claim-recovery" };
          if (record.scheduler.expiry_at !== null && now >= record.scheduler.expiry_at && record.scheduler.enabled) {
            record.scheduler.enabled = false;
            record.scheduler.next_run_at = null;
            monitorHistory(record, "expired", { at: iso(now) }, now);
          } else if (record.scheduler.enabled) {
            record.scheduler.next_run_at = now + record.scheduler.interval_seconds * 1000;
          }
          monitorHistory(record, "wake-claim-recovered", {
            owner_generation: orphan.ownerGeneration,
            heartbeat_generation: heartbeat?.generation ?? null,
            uncertain,
          }, now);
          return registry;
        },
        { now },
      );
      recovered += 1;
      this.log("info", `wake claim recovered monitor=${orphan.id} owner_generation=${orphan.ownerGeneration}`);
    }
    return recovered;
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
      const checkpoint = await this.board.getManagementHistory(monitor.anchor.task_id, { mode: "latest_checkpoint", limit: 1 });
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
      const deterministic = isDeterministicReadFailure(error);
      const code = errorCode(error) ?? null;
      const decision = await withRegistry(
        this.project,
        (registry) => {
          const record = registry.monitors.find((entry) => entry.id === id);
          if (!record) return registry;
          const episode = readEpisode(record, READ_FINGERPRINT, persistent ? "persistent" : "transient", now);
          monitorHistory(
            record,
            episode.outcome === "exhausted-alert" ? "read-exhausted" : "read-backoff",
            { persistent, deterministic, code, message: (error instanceof Error ? error.message : "read failed").slice(0, 120) },
            now,
          );
          if (deterministic) {
            monitorLog(record, "error",
              `canonical read rejected by deterministic contract error ${code ?? "unknown"}; dependent monitor action held back`, now);
          } else if (episode.outcome === "exhausted-alert") {
            monitorLog(record, "warn", "canonical read episode exhausted; dependent monitor action held back", now);
          }
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
  ): Promise<{ kind: "ok"; sessionId: string; primingDigest: string | null } | { kind: "session-error"; reason: string }> {
    if (monitor.session.session_id) {
      try {
        const details = await this.gateway.getSessionDetails(monitor.session.session_id);
        if (details.id === monitor.session.session_id)
          return { kind: "ok", sessionId: details.id, primingDigest: monitor.session.priming_digest ?? null };
        return { kind: "session-error", reason: "session-identity-mismatch" };
      } catch (error) {
        if (errorCode(error) !== "SESSION_NOT_FOUND")
          return { kind: "session-error", reason: errorCode(error) ?? "session-read-failed" };
        // Only a confirmed missing old runtime permits canonical re-creation.
      }
    }
    try {
      const created = await this.gateway.createSession(`Monitor ${monitor.title}`);
      await withRegistry(
        this.project,
        (registry) => {
          const record = registry.monitors.find((entry) => entry.id === monitor.id);
          if (!record) return registry;
          // A rebound session is a brand-new, empty context: its priming state is
          // reset so the very next admitted message carries the role block.
          record.session = { session_id: created.session_id, title: created.title, primed_at: iso(now), priming_digest: null };
          monitorHistory(record, "session-primed", { session_id: created.session_id }, now);
          record.updated_at = iso(now);
          return registry;
        },
        { now },
      );
      return { kind: "ok", sessionId: created.session_id, primingDigest: null };
    } catch (error) {
      return { kind: "session-error", reason: errorCode(error) ?? "creation-failed" };
    }
  }

  // ---------------------------------------------------------------- runtime

  private async resolveRuntime(
    monitor: MonitorRecord,
  ): Promise<{ kind: "already" } | { kind: "switched" } | { kind: "unavailable"; reason: string }> {
    const policy = await this.readPolicy();
    // task_f2d0ccc6: the shared NEW-START candidate formation. Disabled slots
    // (manual per-slot pause) are skipped BEFORE any provider request — the
    // stored selection survives and is never turned into a synthetic error or
    // an attempt record. Order of active slots is preserved; the legacy regime
    // walks the entry primary plus the fixed design/review resolution map and
    // never mixes in the global final stage.
    const candidates = newStartCandidates(policy, monitor.runtime_profile);
    if (candidates.length === 0) return { kind: "unavailable", reason: `profile ${monitor.runtime_profile} not configured` };
    const catalog = await this.gateway.getSessionRuntimeOptions(monitor.session.session_id ?? undefined);
    const details = await this.gateway.getSessionDetails(monitor.session.session_id!);
    const current = {
      provider_id: details.provider_id,
      model_id: details.model_id,
      variant: details.variant,
    };
    for (const candidate of candidates) {
      if (candidate.disabled) continue;
      if (!catalogAvailable(catalog, candidate.tuple)) {
        return { kind: "unavailable", reason: `profile ${monitor.runtime_profile} enabled slot ${candidate.label} configured but unavailable or incomplete` };
      }
      if (
        current.provider_id !== undefined &&
        current.model_id !== undefined &&
        current.provider_id === candidate.tuple.provider_id &&
        current.model_id === candidate.tuple.model_id &&
        (candidate.tuple.variant === undefined || current.variant === candidate.tuple.variant)
      ) {
        return { kind: "already" };
      }
      const updated = await this.gateway.updateSessionRuntime(monitor.session.session_id!, {
        provider_id: candidate.tuple.provider_id,
        model_id: candidate.tuple.model_id,
        ...(candidate.tuple.variant !== undefined ? { variant: candidate.tuple.variant } : {}),
      });
      const verified = await this.gateway.getSessionDetails(monitor.session.session_id!);
      if (
        updated.state !== "updated" ||
        verified.provider_id !== candidate.tuple.provider_id ||
        verified.model_id !== candidate.tuple.model_id ||
        // Welle B: the variant is part of the full identity — never send under an
        // unverified variant (concept §4.5, fails through the existing
        // recovery-update-unverified/error path instead of a silent mismatch).
        (candidate.tuple.variant !== undefined && verified.variant !== candidate.tuple.variant)
      ) {
        throw new Error("runtime update could not be verified");
      }
      return { kind: "switched" };
    }
    return { kind: "unavailable", reason: `profile ${monitor.runtime_profile} configured but every stored slot is manually disabled` };
  }

  // -------------------------------------------------------------- recovery

  private async recover(
    id: string,
    now: number,
    monitor: MonitorRecord,
    sessionId: string,
    evidence: { fingerprint: string; category: string },
    summary?: CanonicalSummary,
    sessionPrimingDigest?: string | null,
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

    // Recovery admission (concept §4.1 Ziffer 2, selection contract): provider
    // routing happens ONLY for the explicit terminal provider-error set.
    // unknown/fachlich errors and everything else stay an honest named hold —
    // no abort side effects, no runtime routing, no dispatch. The W2 repair
    // budget accounting above ran unchanged.
    if (!isRecoveryProviderAdmission(evidence.category)) {
      await this.release(id, now, null, (m) => {
        m.recovery.active = false;
        monitorDecision(
          m,
          "recovery-held",
          { reason: "no-provider-error-admission", category: evidence.category, fingerprint: evidence.fingerprint.slice(0, 16) },
          `recovery-held:no-provider-error-admission:${evidence.fingerprint}`,
          now,
        );
      });
      this.log("info", `recovery held: category=${evidence.category} is not provider-error admission (no routing)`);
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

    // ---- Welle B shared resolution: full Schema-4 policy view, persistent
    // finite episode attempts (provider/model/variant), Provider-Skip gate
    // with central evidence semantics, engine-canonical resolution
    // projection for the (later read-only) Hub. Legacy regime keeps today's
    // fallbackChain semantics; the failed current runtime and already
    // attempted identities are never re-jumped inside a failing episode.
    const policy = await this.readPolicy();
    const currentDetails = await this.gateway.getSessionDetails(sessionId);
    const currentIdentity = currentDetails.provider_id && currentDetails.model_id
      ? runtimeIdentityKey({
        provider_id: currentDetails.provider_id,
        model_id: currentDetails.model_id,
        ...(currentDetails.variant !== undefined ? { variant: currentDetails.variant } : {}),
      })
      : null;
    const triggeredRestart = monitor.wake_request !== null
      && monitor.state.work === "parked_input_required"
      && RESTARTABLE_EXHAUSTION_REASONS.has(monitor.state.parked_reason ?? "");
    const catalog = await this.gateway.getSessionRuntimeOptions(sessionId);
    let episode: RecoveryEpisode;
    let carriedFrom: RecoveryEpisode | null = null;
    if (triggeredRestart && record?.recovery_episode) {
      carriedFrom = record.recovery_episode;
      episode = { started_at: iso(now), policy_revision: policy.revision ?? null, attempts: [] };
    } else if (record?.recovery_episode) {
      // Policy revision alone neither ends the failing episode nor forgets
      // unchanged identities (§4.5 R1); the union is the persisted set itself.
      episode = {
        started_at: record.recovery_episode.started_at,
        policy_revision: policy.revision ?? record.recovery_episode.policy_revision ?? null,
        attempts: record.recovery_episode.attempts.map((entry) => ({ ...entry })),
      };
    } else {
      episode = { started_at: iso(now), policy_revision: policy.revision ?? null, attempts: [] };
    }
    const attemptedIdentities = new Set(episode.attempts.map((entry) => entry.identity));
    if (currentIdentity && !attemptedIdentities.has(currentIdentity)) {
      pushRecoveryAttempt(episode, { at: iso(now), identity: currentIdentity, category: evidence.category, fingerprint: evidence.fingerprint, outcome: "current_failure" });
      attemptedIdentities.add(currentIdentity);
    }
    const chain = resolveRecoveryChain(policy, {
      entryProfile: monitor.runtime_profile,
      catalog,
      evidenceCategory: evidence.category,
      evidenceProviderId: currentDetails.provider_id ?? null,
      attempted: [...attemptedIdentities],
      currentIdentity,
    });
    // Persist the episode plus the engine-canonical resolution projection
    // BEFORE any side effect (§4.4 R2): the Hub later reads this bounded
    // projection instead of ever reimplementing filter semantics.
    const resolutionEntry = {
      at: iso(now),
      policy_revision: chain.policy_revision,
      regime: chain.regime,
      entry_profile: chain.entry_profile,
      candidates: chain.candidates.slice(0, 8).map((entry) => ({ label: entry.label, identity: entry.identity, status: entry.status })),
      selected_identity: chain.selected_identity,
      reason: chain.reason,
    };
    await withRegistry(
      this.project,
      (registry) => {
        const m = registry.monitors.find((entry) => entry.id === id);
        if (!m) return registry;
        m.recovery_episode = episode;
        appendRecoveryResolution(m, resolutionEntry);
        if (carriedFrom) monitorHistory(m, "recovery-episode-restarted", { operator_trigger: true, previous_attempts: carriedFrom.attempts.length }, now);
        monitorHistory(m, "recovery-resolved", {
          revision: chain.policy_revision,
          regime: chain.regime,
          entry_profile: chain.entry_profile,
          selected: chain.selected_identity,
          candidates: chain.candidates.slice(0, 8).map((entry) => `${entry.label}=${entry.status}`),
        }, now);
        m.updated_at = iso(now);
        return registry;
      },
      { now },
    );
    const selected = chain.selected;
    const attemptedList = episode.attempts.map((entry) => entry.identity);
    if (!selected) {
      const onlyUnavailable = chain.candidates.length > 0 && chain.candidates.every((entry) => entry.status === "skipped_unavailable");
      // task_f2d0ccc6: a chain exhausted ONLY by manually disabled slots gets
      // its own honest reason — the exit is the explicit operator re-enable,
      // never an automatic retry bypassing the pause (not restartable).
      const onlyDisabled = chain.candidates.length > 0 && chain.candidates.every((entry) => entry.status === "skipped_disabled");
      const reason = chain.reason === "chain_empty"
        ? (chain.regime === "per_profile" ? "profile-fallback-unconfigured" : "final-fallback-unconfigured")
        : onlyDisabled ? "recovery-chain-disabled"
          : onlyUnavailable ? "final-fallback-unavailable" : "recovery-chain-exhausted";
      await this.release(id, now, "recovery-parked", (m) => {
        m.state.work = "parked_input_required";
        m.state.parked_reason = reason;
        m.recovery.active = false;
        monitorHistory(m, reason, {
          fingerprint: evidence.fingerprint.slice(0, 16),
          attempted: attemptedList.slice(0, 24),
          skips: resolutionEntry.candidates.filter((entry) => entry.status.startsWith("skipped_")).map((entry) => `${entry.identity}=${entry.status}`).slice(0, 8),
        }, now);
      });
      this.log("warn", `recovery parked with visible reason=${reason} monitor=${id} revision=${chain.policy_revision ?? "unknown"}`);
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
      verified.model_id !== selected.model_id ||
      (selected.variant !== undefined && verified.variant !== selected.variant)
    ) {
      await this.release(id, now, null, (m) => {
        m.recovery.active = false;
        // An unverified switch is a failed attempt of this full identity —
        // it is never silently re-jumped inside the failing episode (§4.5).
        if (m.recovery_episode && chain.selected_identity) {
          pushRecoveryAttempt(m.recovery_episode, { at: iso(now), identity: chain.selected_identity, category: evidence.category, fingerprint: evidence.fingerprint, outcome: "update_unverified" });
        }
        monitorHistory(m, "recovery-update-unverified", { attempted: m.recovery_episode?.attempts.map((entry) => entry.identity).slice(0, 24) ?? attemptedList }, now);
      });
      return "error";
    }
    const actionId = `recovery_${randomUUID().replaceAll("-", "")}`;
    const priming = summary ? this.primingDigest(monitor, summary) : null;
    // The digest comes from ensureSession, not from the stale claim snapshot, so
    // a rebind in this wake re-primes instead of running the role block late.
    const currentDigest = sessionPrimingDigest !== undefined ? sessionPrimingDigest : (monitor.session.priming_digest ?? null);
    const prime = priming !== null && currentDigest !== priming;
    const prompt = this.buildRecoveryPrompt(monitor, evidence, actionId, summary, prime);
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
        // The selected identity is recorded as attempted in BOTH outcomes: a
        // possibly admitted (uncertain) send must never loop into another
        // provider inside the same failing episode; a failed send is a real
        // attempt. Neither is blindly resent — WAL reconciliation rules.
        if (m.recovery_episode && chain.selected_identity) {
          pushRecoveryAttempt(m.recovery_episode, {
            at: iso(now),
            identity: chain.selected_identity,
            category: evidence.category,
            fingerprint: evidence.fingerprint,
            outcome: code === "SUBMISSION_UNCERTAIN" ? "dispatch_uncertain" : "send_failed",
          });
        }
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
      // The episode STAYS OPEN after an admitted fallback step: its attempts
      // keep protecting against re-attempts until a healthy wake proves the
      // recovery worked and closes it (Primary is then free again, no cooldown).
      if (m.recovery_episode && chain.selected_identity) {
        pushRecoveryAttempt(m.recovery_episode, { at: iso(now), identity: chain.selected_identity, category: evidence.category, fingerprint: evidence.fingerprint, outcome: "dispatched" });
      }
      this.reanchorAfterReconciliation(m, now);
      this.resumeRecoveryPark(m, "recovery-continued", now);
      if (prime && priming) this.recordPriming(m, priming, now);
      monitorHistory(m, "recovery-continued", {
        message_id: result.message_id,
        fallback: `${selected.provider_id}/${selected.model_id}`,
        variant: selected.variant ?? null,
        fingerprint: evidence.fingerprint,
        primed: prime,
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
    const pending = await this.combinedPending(sessionId);
    if (!pending) {
      await this.release(id, now, null, (m) => {
        monitorHistory(m, "compaction-held", { reason: "pending-coverage-unavailable" }, now);
      });
      return "busy-held";
    }
    if (status.backend_activity !== "idle" || pending.permissions + pending.questions > 0) {
      await this.release(id, now, null, (m) => {
        monitorHistory(m, "compaction-held", { activity: status.backend_activity }, now);
      });
      return "busy-held";
    }
    const actionId = `compact_${randomUUID().replaceAll("-", "")}`;
    // Compaction is context loss: the MANAGEMENT role block is always repeated,
    // bounded to this one admitted continuation.
    const priming = this.primingDigest(monitor, summary);
    const prompt = this.buildRecoveryPrompt(monitor, { fingerprint: "context_input_length", category: "context_input_length" }, actionId, summary, true);
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
        this.recordPriming(m, priming, now);
        monitorHistory(m, "compaction-continued", { message_id: result.message_id, primed: true }, now);
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

  private async combinedPending(sessionId: string): Promise<PendingInput | null> {
    try {
      const pending = await this.gateway.getCombinedPendingInput(sessionId);
      if (!pending || typeof pending.permissions !== "number" || typeof pending.questions !== "number") return null;
      if (!Number.isFinite(pending.permissions) || !Number.isFinite(pending.questions)) return null;
      if (pending.permissions < 0 || pending.questions < 0) return null;
      // Descendant coverage that could not be verified must never be read as
      // a clean zero: surface it through the existing fail-closed hold branch.
      if ((pending as { coverage?: unknown }).coverage === "unknown") return null;
      return pending;
    } catch {
      return null;
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
      const pendingAfter = abort.pending_input_after;
      if (!pendingAfter || typeof pendingAfter.permissions !== "number" || typeof pendingAfter.questions !== "number"
          || !Number.isFinite(pendingAfter.permissions) || !Number.isFinite(pendingAfter.questions)
          || pendingAfter.permissions < 0 || pendingAfter.questions < 0) {
        return { kind: "held", state: "pending-coverage-unavailable" };
      }
      if (pendingAfter.permissions + pendingAfter.questions > 0) {
        return { kind: "held", state: "pending-input" };
      }
      if (abort.activity_after !== "idle") {
        return { kind: "held", state: "activity-not-idle" };
      }
      const fresh = await this.combinedPending(sessionId);
      if (fresh && fresh.permissions + fresh.questions > 0) {
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

  /** Stable identity of the priming context: role contract, anchor, autonomy and
   * runtime profile plus the bound document revisions. A change re-primes once;
   * an unchanged digest keeps the wake short (no full priming per tick). */
  private primingDigest(monitor: MonitorRecord, summary: CanonicalSummary): string {
    return digest({
      contract: PRIMING_CONTRACT,
      anchor: summary.task.id,
      autonomy: monitor.autonomy_profile,
      runtime: monitor.runtime_profile,
      documents: summary.documents.map((doc) => `${doc.role}:${doc.path}:${doc.revision ?? ""}`),
    });
  }

  /** One-time MANAGEMENT role/context block. It references canonical sources by
   * path and revision instead of duplicating their content, and it is sent at
   * most once per priming digest — never on every tick. */
  private buildPrimingBlock(monitor: MonitorRecord, summary: CanonicalSummary): string {
    const documents = summary.documents.length
      ? summary.documents.map((doc) => `${doc.role}=${doc.path}${doc.revision ? `@${doc.revision}` : ""}`).join(", ")
      : "none registered";
    return [
      `[MANAGEMENT-PRIMING ${PRIMING_CONTRACT}]`,
      `Mission: drive the commissioned development actively to the agreed result within your operator-set autonomy profile — decide permitted matters yourself, task and supervise your own worker sessions, remove obstacles, initiate the next steps; pure status observation is not delivery. Role: MANAGEMENT for monitor ${monitor.id} — coordinate, never implement; delegate analysis, implementation and tests to separate worker sessions through the existing interfaces. Management decisions and control stay serial.`,
      `Audiences: (a) the external operator's commissioned orchestration within real auth/scope; (b) explicitly established OpenCode monitor/manager sessions for a work package or master task. Ordinary implementation sessions do not use this binding; tool visibility is not authorization. Rules are cooperative — no technical enforcement, caller-identity proof or BLOCKED guarantee is claimed.`,
      `Master anchor: ${summary.task.id} — "${summary.task.title}". Resolve Master/Work-Package → member tickets → their sessions with existing tools only (list_project_tasks, get_project_task links/documents, get_task_management_history, list_sessions, get_session_status); no second assignment store.`,
      `Canonical context, read on demand and never duplicated here: ${documents}; the anchor task's management journal. Keep task state, journal checkpoints and the compact context current after every decided step. Journal entries are appended only through the board's management-note interface (add_task_management_note); never create, edit, chmod, replace or delete journal files under the board's management-journal directory with shell or any tool — report persistence unverified instead.`,
      `Autonomy profile ${monitor.autonomy_profile}: apply its operator-contract scope. Sandbox covers the explicitly assigned test estate (harness, test code and tests, test services/DB/containers/images, assigned cleanup and rebuild); product source and semantics are out of scope, production, foreign or unknown targets never. Autonomy governs decision latitude; execution/standard/deep/design/review are separate runtime model profiles resolved from project policy with readback — never conflate them.`,
      `Ownership: delegate only to your own root worker sessions — create fresh ones or reuse ones verifiably created by you (creation receipt/registry identity, never the title); never take over, steer or relabel foreign existing sessions; never use native subtasks for management work, including internal parallel research. Workers decide their own subtask use inside existing scope and permissions; no extra enablement, no micromanagement. No parallel sub-managers.`,
      `Delegated authorization: within documented grants you may concretize an existing authorization and re-task a worker without a new human loop; the prior contract supplies authority, silence never does. Never bypass or auto-approve a real host/security permission or a denied connector action; escalate those and any unclear target or scope.`,
      `Worker failures: analyse from the exact receipt, safe error details and originals; report visibly — task/session/work, error class and evidenced cause, impact, recovery attempt and budget, blocker, next action; a failed turn differs from busy and from an externally still-running job. Terminal timeout/quota follows the configured project fallback policy (read it; never substitute a model yourself) with idle / no-pending-input / catalog / update-readback / one-send / reconcile / no-duplicate discipline. A worker's business input_required: resolve with a normal same-session follow-up once the actual decision exists in profile/scope; a genuine operator decision escalates as INPUT_REQUIRED; a pending security permission is never answered or bypassed.`,
      `Self-steering: never write to this management session or its own monitor binding (no self-target send, runtime switch, archive or rename). Never change your own monitor/autonomy/runtime/expiry/scheduler state, approval or taskboard/management-tool settings, create/spawn or reprioritize board tasks, or self-authorize — recommend instead via attention/journal. Reads, journal/compact-context upkeep, additive non-authorizing notes, own worker control with configured fallback, and legitimate INPUT_REQUIRED parking remain permitted. The technical guard is a separate pending decision; the rule binds regardless.`,
      `Cadence: at most one bounded step per wake; each wake runs the wake duty loop — load your persistent context and worker index; reconcile actual session/order states and open or uncertain receipts without duplicate orders; fully read new originals against receipts and synthesize key findings continuously, even while a worker stays alive; analyse errors/blockers, fix within scope or task a separate worker correction with the configured fallback continuation and readback, never inventing causes or runtimes; decide and dispatch the next permitted step serially; escalate only real operator decisions; after secured handover archive finished own sessions and remove their context files per contract; update journal, compact context and worker index for the next resume. When nothing relevant changed, end briefly without new orders (bounded no-op). Never infer task completion from a technical turn end.`,
      `Routing and self-heal, every dispatch (new task or follow-up): resolve the matching enabled model profile fresh from the current project policy and set the target runtime explicitly with full provider/model/variant readback BEFORE the send — the session's current runtime is never proof of the desired profile; never rely on a cached or historical policy revision. Never switch a healthy, actively working session mid-turn; when the desired runtime differs, act only at a controlled idle boundary, never a busy send or an unsupported mid-turn switch. A generic or inconclusive answer earns at most the bounded supported read-retry, otherwise a named blocker. Before a recovery, correlate the current receipt/output/error/activity first; on a confirmed timeout/quota read the current policy and continue the SAME authorized order through the currently allowed fallback chain with verified runtime readback and no duplicate effects; unknown is never a blind retry and busy alone is not a stall. Correct an evidenced wrong inherited default after a failed start explicitly, and respect real security and business parks. The global final stage is sticky only across later regular monitor wakes; the explicit single-order interactive recovery keeps its existing final-once path — no hot loop, no invented final, no budget or right change.`,
    ].join("\n");
  }

  /** Records the priming contract actually delivered with an admitted message.
   * Called only inside the existing release mutation of that same wake, so a
   * priming is never claimed for an unconfirmed send. */
  private recordPriming(record: MonitorRecord, priming: string, now: number): void {
    record.session.priming_digest = priming;
    record.session.primed_at = iso(now);
    monitorHistory(record, "manager-primed", { contract: PRIMING_CONTRACT, digest: priming.slice(0, 16) }, now);
  }

  /** Bounded, metadata-only worker index for the wake prompt (no secrets, no
   * arguments). Keeps the most recent 20 workers and reports any omission. */
  private workerIndexLine(monitor: MonitorRecord): string {
    const workers = monitor.workers ?? [];
    if (workers.length === 0) return "none";
    const shown = workers.slice(-20);
    const parts = shown.map((worker) => {
      const task = worker.task_id ? `/${worker.task_id}` : "";
      const runtime = worker.runtime_session_id ? `@${worker.runtime_session_id}` : "";
      const synth = worker.last_synthesis_at ? `~${worker.last_synthesis_at}` : "";
      const error = worker.last_error ? `!${worker.last_error.category}` : "";
      return `${worker.alias}:${worker.lifecycle}${error}${runtime}${task}${synth}`;
    });
    const omitted = workers.length - shown.length;
    return `${parts.join("; ")}${omitted > 0 ? ` (+${omitted} older omitted)` : ""}`;
  }

  private buildWakePrompt(
    monitor: MonitorRecord,
    summary: CanonicalSummary,
    decisionsSince: number,
    actionId: string,
    triggered: boolean,
    prime: boolean,
  ): string {
    const mission = [
      `[MONITOR-ACTION ${actionId}] MANAGEMENT wake${triggered ? " (operator trigger)" : ""} · monitor ${monitor.id} · master ${summary.task.id} "${summary.task.title}" (${summary.task.status}).`,
      `Delta: checkpoint ${summary.checkpoint ?? "none"}; newest decision ${summary.newest_decision ?? "none"}; decisions since last wake ${decisionsSince}; documents ${summary.documents.length ? summary.documents.map((doc) => `${doc.role}@${doc.revision ?? "unversioned"}`).join(",") : "none"} (coverage ${summary.coverage}).`,
      `Worker index: ${this.workerIndexLine(monitor)}`,
      `Mission: 1) verify progress of this master/work package, 2) read the current worker and receipt results, 3) decide and execute exactly ONE next permitted step, delegating implementation/tests to a worker session, 4) analyse blockers and resolve or escalate them within the existing grants, 5) if nothing relevant changed, end briefly (bounded no-op) without duplicate orders.`,
      `Blocked park: reconcile originals and try 2–3 already-authorized viable alternatives first; never synthesize YOLO/reset/delete/security approvals.`,
      `Reads: journal checkpoint/tail first; open canonical C/P only when a listed revision changed. Report INPUT_REQUIRED only for a real missing decision; keep state, journal and compact context updated.`,
    ];
    return prime ? `${this.buildPrimingBlock(monitor, summary)}\n\n${mission.join("\n")}` : mission.join("\n");
  }

  private buildRecoveryPrompt(
    monitor: MonitorRecord,
    evidence: { fingerprint: string; category: string },
    actionId: string,
    summary?: CanonicalSummary,
    prime = false,
  ): string {
    const parts = [
      `[MONITOR-${evidence.category === "context_input_length" ? "COMPACT" : "RECOVERY"} ${actionId}]`,
      `Monitor ${monitor.id} MANAGEMENT operational recovery.`,
      evidence.category === "context_input_length"
        ? "The previous request was rejected for input length. Do not resubmit the rejected request; rely on the verified native compaction result and continue the same management context exactly once with the recovery summary."
        : `A turn stopped with an evidenced blocked error (${evidence.fingerprint}; category ${evidence.category}). Continue the same management context in this session; delegate the actual work again instead of executing it here, and do not duplicate already admitted work.`,
      summary ? `Canonical anchor task: ${summary.task.id}; checkpoint: ${summary.checkpoint ?? "unknown"}.` : `Canonical anchor task: ${monitor.anchor.task_id}.`,
      "Re-establish the state from the canonical C/P references, the journal checkpoint and the worker receipts before the next bounded step; report a precise INPUT_REQUIRED if a real decision is needed. Already executed changes remain; no rollback is claimed.",
      "Before declaring a total blocked park, reconcile the original references and evaluate 2–3 already-authorized plausible alternative ways within the existing authorized scope; choose and pursue the first viable one instead of running an exhaustive checklist. Never derive YOLO/reset/delete/security approvals from synthesized options, and do not treat a single narrow reviewer negative finding as a global impossibility judgement.",
    ];
    const body = parts.join("\n");
    return prime && summary ? `${this.buildPrimingBlock(monitor, summary)}\n\n${body}` : body;
  }
}

// ------------------------------------------------------------------ helpers

/** V2 §13.8 heartbeat evidence: the engine's own boot/liveness record
 * (`<project>/.opencode-vm/monitor/heartbeat.json`, written by the service
 * every 30 s). Freshness is content-time based (`at`), never assumed. */
async function readEngineHeartbeat(project: string, nowMs: number): Promise<{ generation: string; at: number; fresh: boolean } | null> {
  const path = join(project, ".opencode-vm", "monitor", "heartbeat.json");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return null;
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || parsed.schema !== 1 || typeof parsed.generation !== "string" || parsed.generation.length < 1 || typeof parsed.at !== "string") return null;
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at)) return null;
    return {
      generation: parsed.generation,
      at,
      fresh: nowMs - at < HEARTBEAT_FRESH_MS,
    };
  } catch {
    return null;
  }
}

/** F2: bounds OUR wait for one investigation read. The backend keeps its own
 * transport timeout — this is the conservative engine-side guarantee. */
function withCallTimeout<T>(call: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`investigation call timed out: ${label}`), { code: "CALL_TIMEOUT" })), timeoutMs);
  });
  void call.catch(() => undefined); // the losing promise is never unhandled
  return Promise.race([call, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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

// Welle B: catalogAvailable and fallbackChain now live exactly once in
// agent-control.ts (shared recovery-policy resolver, re-exported at the top of
// this file). The former engine-local duplicates were removed — behavior for
// the legacy regime is unchanged.
