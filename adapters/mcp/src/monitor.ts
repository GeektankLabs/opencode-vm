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
 * requests, bounded run history and bounded logs, plus the additive W2
 * cooperative identity metadata (monotonic M alias high-water, per-monitor
 * worker ordinals and worker records with owner/receipt/context/lifecycle).
 * All writers (engine service and MCP tools) serialize through a cooperating
 * mkdir lock and CAS with a monotonic generation counter; publication is
 * atomic (tmp + rename). Aliases are cooperative identity, not authentication.
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

/**
 * Welle B (be951293, concept §4.5/§4.4-R2): a finite recovery episode with
 * persistent attempted FULL runtime identities (provider/model/variant).
 * Purely additive behind the existing `recovery` state — survives wakes,
 * adapter restarts and policy revisions (union carried, never forgotten for
 * still-permitted candidates) and closes only on a successful fallback step.
 * `recovery_resolution` is the bounded engine-canonical resolved-candidate
 * projection (labels, identities, per-candidate skip status, policy revision)
 * that the Hub later reads without reimplementing any filter semantics.
 */
export type RecoveryAttemptEntry = {
  at: string;
  identity: string;
  category: string;
  fingerprint: string;
  outcome: "current_failure" | "update_unverified" | "dispatched" | "dispatch_uncertain" | "send_failed";
};

export type RecoveryEpisode = {
  started_at: string;
  policy_revision: number | null;
  attempts: RecoveryAttemptEntry[];
};

export type RecoveryResolutionCandidate = { label: string; identity: string; status: string };

export type RecoveryResolutionEntry = {
  at: string;
  policy_revision: number | null;
  regime: string;
  entry_profile: string;
  candidates: RecoveryResolutionCandidate[];
  selected_identity: string | null;
  reason: string;
};

export const RECOVERY_ATTEMPT_LIMIT = 24;
export const RECOVERY_RESOLUTION_LIMIT = 8;
const RECOVERY_ATTEMPT_OUTCOMES: readonly string[] = ["current_failure", "update_unverified", "dispatched", "dispatch_uncertain", "send_failed"];
const RECOVERY_CANDIDATE_STATUSES: readonly string[] = ["selected", "skipped_current_failure", "skipped_attempted", "skipped_provider_scope", "skipped_unavailable"];
const RECOVERY_CHAIN_REASONS: readonly string[] = ["selected", "chain_empty", "chain_exhausted"];

function boundedToken(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max && !/[\s\x00-\x1f\x7f]/u.test(value);
}

/**
 * QC F-B2 (waveB-qc SHAeffd6d1c6): additive Welle-B fields are validated when
 * present and fail closed like every other registry shape (a hand-corrupted
 * episode must not crash recover() at runtime), while old records without the
 * fields and explicit nulls stay valid (pure round-trip compatibility).
 */
function recoveryAttemptShapeOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return validIso(value.at) && boundedToken(value.identity, 256) && boundedToken(value.category, 64) &&
    typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/.test(value.fingerprint) &&
    RECOVERY_ATTEMPT_OUTCOMES.includes(value.outcome as string);
}

function recoveryEpisodeShapeOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!validIso(value.started_at)) return false;
  const revision = value.policy_revision;
  if (revision !== null && revision !== undefined && !(Number.isSafeInteger(revision) && (revision as number) >= 0)) return false;
  if (!Array.isArray(value.attempts) || value.attempts.length > RECOVERY_ATTEMPT_LIMIT) return false;
  return value.attempts.every(recoveryAttemptShapeOk);
}

function recoveryResolutionShapeOk(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > RECOVERY_RESOLUTION_LIMIT) return false;
  for (const entry of value) {
    if (!isRecord(entry) || !validIso(entry.at)) return false;
    const revision = entry.policy_revision;
    if (revision !== null && revision !== undefined && !(Number.isSafeInteger(revision) && (revision as number) >= 0)) return false;
    if (!boundedToken(entry.regime, 32) || !boundedToken(entry.entry_profile, 32)) return false;
    if (!Array.isArray(entry.candidates) || entry.candidates.length > 8) return false;
    for (const candidate of entry.candidates) {
      if (!isRecord(candidate) || !boundedToken(candidate.label, 96) || !boundedToken(candidate.identity, 256)) return false;
      if (typeof candidate.status !== "string" || !RECOVERY_CANDIDATE_STATUSES.includes(candidate.status)) return false;
    }
    if (entry.selected_identity !== null && !boundedToken(entry.selected_identity, 256)) return false;
    if (typeof entry.reason !== "string" || !RECOVERY_CHAIN_REASONS.includes(entry.reason)) return false;
  }
  return true;
}

export function pushRecoveryAttempt(episode: RecoveryEpisode, entry: RecoveryAttemptEntry): void {
  episode.attempts.push(entry);
  if (episode.attempts.length > RECOVERY_ATTEMPT_LIMIT)
    episode.attempts.splice(0, episode.attempts.length - RECOVERY_ATTEMPT_LIMIT);
}

export function appendRecoveryResolution(monitor: MonitorRecord, entry: RecoveryResolutionEntry): void {
  monitor.recovery_resolution = [...(monitor.recovery_resolution ?? []), entry];
  if (monitor.recovery_resolution.length > RECOVERY_RESOLUTION_LIMIT)
    monitor.recovery_resolution.splice(0, monitor.recovery_resolution.length - RECOVERY_RESOLUTION_LIMIT);
}

/**
 * W2 cooperative worker identity. A worker record is additive metadata behind a
 * short alias; it never grants authority and is not an authenticated caller
 * guarantee. `reserved` means a non-idempotent create is about to be attempted;
 * the record becomes `active` only after the real create response is observed.
 */
export type MonitorWorkerLifecycle = "reserved" | "active" | "idle" | "archived";
export type MonitorWorkerRecord = {
  worker_key: string;
  alias: string;
  monitor_id: string;
  manager_alias: string;
  creator_manager_session_id: string | null;
  created_at: string;
  runtime_session_id: string | null;
  creation_receipt: string | null;
  dispatch_receipt: string | null;
  /** Latest observed terminal assistant message of a dispatched worker; proves
   * a fresh result/receipt delta for the manager without a subscription. */
  result_receipt: string | null;
  scope: string | null;
  worktree: string | null;
  task_id: string | null;
  context_path: string;
  lifecycle: MonitorWorkerLifecycle;
  last_synthesis_at: string | null;
  updated_at: string;
  /**
   * Wave A (be951293): a conservatively observed terminal failure of this
   * worker's own dispatched turn, correlated through its dispatch receipt.
   * Purely additive: the lifecycle enum stays unchanged, older readers ignore
   * the field and older records simply have none. The manager wakes exactly
   * once per distinct terminal error through the lifecycle/updated_at/
   * result_receipt digest transition this marking accompanies. Reactivating a
   * worker (reuse/rebind) clears it to null: it always describes the CURRENT
   * dispatch episode, never a stale previous one (QC F1).
   */
  last_error?: MonitorWorkerErrorMarker | null;
};

export type MonitorWorkerErrorMarker = {
  at: string;
  category: string;
  fingerprint: string;
  /** Terminal assistant message id of the correlated failed turn, null when
   * the gateway exposed none (explicit, never inferred). */
  receipt: string | null;
};

/**
 * be951293 gate fix (2026-10-10): settled observation of the CURRENT admitted
 * dispatch receipt on an unchanged board. The unchanged/no-op shortcut never
 * re-read the manager session, so a dispatch that was admitted and THEN ended
 * terminally failed stayed invisible (live: silent noop-unchanged loop, no
 * recovery, no park). The engine watches each distinct receipt exactly once
 * and records the settled outcome here. Outcome semantics (QC G1): `healthy`
 * is written ONLY for verified terminal health (idle, no pending input,
 * `completed`, no provider evidence); `held` records an ENGINE-DECIDED
 * convergence (real recovery park or hold) and never claims anything about
 * the receipt's own terminality — unconfirmed states keep the watch open.
 * Purely additive: absent on legacy records, validated fail-closed when
 * present, bounded to one entry.
 */
export type MonitorReceiptObservation = {
  receipt: string;
  outcome: "healthy" | "held";
  at: string;
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
  session: { session_id: string | null; title: string | null; primed_at: string | null; priming_digest?: string | null };
  state: {
    work: MonitorWorkState;
    parked_reason?: string;
    last_seen_digest: string | null;
    watermark: string | null;
    /** Bounded digest of the worker index observed at the last admitted wake. */
    worker_digest?: string | null;
    /** be951293 gate fix: settled terminal observation of the current dispatch receipt. */
    receipt_observation?: MonitorReceiptObservation | null;
  };
  cursors: Record<string, string>;
  budget: Record<string, { no_progress: number; entries: MonitorRepairEntry[] }>;
  read_episodes: Record<
    string,
    { attempts: number; next_at: number | null; exhausted_at: string | null; alerted: boolean }
  >;
  run: { active: boolean; started_at: string | null; action: string | null };
  recovery: { active: boolean; started_at: string | null; last_error_fingerprint: string | null };
  /** Welle B additive persistence (see RecoveryEpisode docs); absent on legacy records. */
  recovery_episode?: RecoveryEpisode | null;
  recovery_resolution?: RecoveryResolutionEntry[] | null;
  dispatch_wal: {
    action_id: string;
    at: string;
    prompt_digest: string;
    message_id: string | null;
  } | null;
  wake_request: { requested_at: string; reason: string } | null;
  abort_request: { requested_at: string; reason?: string } | null;
  history: MonitorHistoryEntry[];
  logs: MonitorLogEntry[];
  created_at: string;
  updated_at: string;
  alias?: string;
  worker_high_water?: number;
  workers?: MonitorWorkerRecord[];
};

export type MonitorRegistry = {
  schema: 1;
  generation: number;
  monitors: MonitorRecord[];
  alias_high_water?: number;
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
    session: { session_id: null, title: null, primed_at: null, priming_digest: null },
    state: { work: "active", last_seen_digest: null, watermark: null },
    cursors: {},
    budget: {},
    read_episodes: {},
    run: { active: false, started_at: null, action: null },
    recovery: { active: false, started_at: null, last_error_fingerprint: null },
    dispatch_wal: null,
    wake_request: null,
    abort_request: null,
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
  if (registry.alias_high_water !== undefined &&
    (!Number.isSafeInteger(registry.alias_high_water) || (registry.alias_high_water as number) < 0)) return false;
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
    // be951293 gate fix: additive receipt observation fails closed like every
    // other optional field (QC F-B2 pattern).
    const observation = monitor.state.receipt_observation;
    if (observation !== undefined && observation !== null) {
      if (!isRecord(observation) ||
        typeof observation.receipt !== "string" || (observation.receipt as string).length < 1 || (observation.receipt as string).length > 256 ||
        !(["healthy", "held"] as const).includes(observation.outcome as never) ||
        !validIso(observation.at)) return false;
    }
    if (!Array.isArray(monitor.history) || !Array.isArray(monitor.logs)) return false;
    if (!validIso(monitor.created_at) || !validIso(monitor.updated_at)) return false;
    if (monitor.alias !== undefined &&
      (typeof monitor.alias !== "string" || !/^M[1-9][0-9]*$/.test(monitor.alias))) return false;
    if (monitor.worker_high_water !== undefined &&
      (!Number.isSafeInteger(monitor.worker_high_water) || (monitor.worker_high_water as number) < 0)) return false;
    if (monitor.workers !== undefined && !workersShapeOk(monitor.id as string, monitor.workers)) return false;
    // QC F-B2: additive Welle-B recovery fields fail closed when present.
    if (monitor.recovery_episode !== undefined && monitor.recovery_episode !== null && !recoveryEpisodeShapeOk(monitor.recovery_episode)) return false;
    if (monitor.recovery_resolution !== undefined && monitor.recovery_resolution !== null && !recoveryResolutionShapeOk(monitor.recovery_resolution)) return false;
  }
  return true;
}

function workersShapeOk(monitorId: string, workers: unknown): workers is MonitorWorkerRecord[] {
  if (!Array.isArray(workers)) return false;
  const keys = new Set<string>();
  const aliases = new Set<string>();
  for (const worker of workers) {
    if (!isRecord(worker)) return false;
    if (typeof worker.worker_key !== "string" || !/^worker_[0-9a-f]{32}$/.test(worker.worker_key)) return false;
    if (typeof worker.alias !== "string" || !/^M[1-9][0-9]*-[A-Z]+$/.test(worker.alias)) return false;
    if (worker.monitor_id !== monitorId) return false;
    if (typeof worker.manager_alias !== "string" || !/^M[1-9][0-9]*$/.test(worker.manager_alias)) return false;
    if (typeof worker.context_path !== "string" || worker.context_path.length < 1) return false;
    if (!(["reserved", "active", "idle", "archived"] as const).includes(worker.lifecycle as never)) return false;
    for (const field of ["creator_manager_session_id", "runtime_session_id", "creation_receipt", "dispatch_receipt", "result_receipt", "scope", "worktree", "task_id", "last_synthesis_at"] as const) {
      const value = worker[field];
      if (value !== null && typeof value !== "string") return false;
    }
    // Additive Wave A error marker: unknown to older readers, validated only
    // when present so a hand-corrupted marker fails closed like every other field.
    if (worker.last_error !== undefined && worker.last_error !== null) {
      if (!isRecord(worker.last_error)) return false;
      if (!validIso(worker.last_error.at) ||
        typeof worker.last_error.category !== "string" || (worker.last_error.category as string).length < 1 || (worker.last_error.category as string).length > 64 ||
        typeof worker.last_error.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(worker.last_error.fingerprint as string)) return false;
      if (worker.last_error.receipt !== null && typeof worker.last_error.receipt !== "string") return false;
    }
    if (!validIso(worker.created_at) || !validIso(worker.updated_at)) return false;
    if (keys.has(worker.worker_key) || aliases.has(worker.alias)) return false;
    keys.add(worker.worker_key);
    aliases.add(worker.alias);
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

/**
 * Wave A (be951293): bounded structured decision entry. Repeated occurrences
 * of the SAME decision (same type and merge key) update the most recent entry
 * for that key in place, keeping first/last time and count visible instead of
 * appending per tick and evicting meaningful entries during a long quiet or
 * held streak. A null merge key always appends. Detail values must be safe
 * bounded tokens (codes, aliases, digests) — never raw messages, prompts or
 * credentials.
 */
export function monitorDecision(
  monitor: MonitorRecord,
  type: string,
  detail: Record<string, unknown>,
  mergeKey: string | null,
  now = Date.now(),
): void {
  const at = new Date(now).toISOString();
  if (mergeKey !== null) {
    for (let index = monitor.history.length - 1; index >= 0; index -= 1) {
      const entry = monitor.history[index]!;
      if (entry.type === type && isRecord(entry.detail) && entry.detail.merge === mergeKey) {
        entry.detail = { ...entry.detail, last_at: at, count: (typeof entry.detail.count === "number" ? entry.detail.count : 1) + 1 };
        return;
      }
    }
  }
  monitor.history.push({
    at,
    type,
    detail: { ...detail, ...(mergeKey !== null ? { merge: mergeKey } : {}), first_at: at, last_at: at, count: 1 },
  });
  if (monitor.history.length > MONITOR_HISTORY_LIMIT)
    monitor.history.splice(0, monitor.history.length - MONITOR_HISTORY_LIMIT);
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

/**
 * W2 identity allocation and context layout. All metadata changes go through
 * `withRegistry` (existing mkdir lock + generation CAS + atomic rename); there
 * is deliberately no second store and no unlocked registry mutation. Aliases
 * are monotonic high-water marks and are never reused, so archived context
 * removal cannot cause a collision. Aliases are cooperative once-only identity,
 * not authentication.
 */

export function managerAliasFor(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("invalid manager alias ordinal");
  return `M${ordinal}`;
}

export function workerAliasFor(managerAlias: string, ordinal: number): string {
  if (!/^M[1-9][0-9]*$/.test(managerAlias)) throw new Error("invalid manager alias");
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("invalid worker alias ordinal");
  let n = ordinal;
  let letters = "";
  while (n > 0) {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return `${managerAlias}-${letters}`;
}

export function monitorWorkersDirectory(project: string): string {
  return join(project, ".opencode-vm", "monitor", "workers");
}
export function monitorWorkerContextPath(project: string, monitorId: string, workerKey: string): string {
  return join(monitorWorkersDirectory(project), monitorId, `${workerKey}.md`);
}
export function monitorManagerContextPath(project: string, monitorId: string): string {
  return join(monitorWorkersDirectory(project), monitorId, "manager.md");
}

function findMonitorOrThrow(registry: MonitorRegistry, monitorId: string): MonitorRecord {
  const monitor = registry.monitors.find((entry) => entry.id === monitorId);
  if (!monitor) throw new Error("monitor not found in this project registry");
  return monitor;
}

function findOwnedWorkerOrThrow(
  registry: MonitorRegistry,
  monitorId: string,
  workerKey: string,
): { monitor: MonitorRecord; worker: MonitorWorkerRecord } {
  const monitor = findMonitorOrThrow(registry, monitorId);
  const worker = (monitor.workers ?? []).find((entry) => entry.worker_key === workerKey);
  if (!worker) throw new Error("worker not found for this monitor");
  if (worker.monitor_id !== monitorId) throw new Error("worker belongs to a foreign monitor");
  return { monitor, worker };
}

export function ensureManagerAlias(registry: MonitorRegistry, monitor: MonitorRecord): string {
  if (monitor.alias) return monitor.alias;
  const next = (registry.alias_high_water ?? 0) + 1;
  registry.alias_high_water = next;
  monitor.alias = managerAliasFor(next);
  return monitor.alias;
}

export async function assignMonitorAlias(
  project: string,
  monitorId: string,
  options: { now?: number; expected?: number } = {},
): Promise<{ monitor_id: string; alias: string; generation: number }> {
  const now = options.now ?? Date.now();
  let alias = "";
  const registry = await withRegistry(
    project,
    (draft) => {
      const monitor = findMonitorOrThrow(draft, monitorId);
      alias = ensureManagerAlias(draft, monitor);
      monitor.updated_at = new Date(now).toISOString();
      return draft;
    },
    { ...(options.expected !== undefined ? { expected: options.expected } : {}), now },
  );
  return { monitor_id: monitorId, alias, generation: registry.generation };
}

export type WorkerCreateInput = {
  creator_manager_session_id?: string | null;
  runtime_session_id?: string | null;
  task_id?: string | null;
  scope?: string | null;
  worktree?: string | null;
};

export type WorkerReservation = { worker_key: string; alias: string; context_path: string; generation: number };

/**
 * Reserve a worker identity and alias *before* a non-idempotent create. The
 * record starts `reserved`; only a confirmed create response makes it `active`.
 */
export async function reserveWorker(
  project: string,
  monitorId: string,
  input: WorkerCreateInput = {},
  options: { now?: number; expected?: number } = {},
): Promise<WorkerReservation> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  let reserved!: WorkerReservation;
  const registry = await withRegistry(
    project,
    (draft) => {
      const monitor = findMonitorOrThrow(draft, monitorId);
      const managerAlias = ensureManagerAlias(draft, monitor);
      const ordinal = (monitor.worker_high_water ?? 0) + 1;
      monitor.worker_high_water = ordinal;
      const workerKey = `worker_${randomUUID().replaceAll("-", "")}`;
      const record: MonitorWorkerRecord = {
        worker_key: workerKey,
        alias: workerAliasFor(managerAlias, ordinal),
        monitor_id: monitorId,
        manager_alias: managerAlias,
        creator_manager_session_id: input.creator_manager_session_id ?? null,
        created_at: at,
        runtime_session_id: input.runtime_session_id ?? null,
        creation_receipt: null,
        dispatch_receipt: null,
        result_receipt: null,
        scope: input.scope ?? null,
        worktree: input.worktree ?? null,
        task_id: input.task_id ?? null,
        context_path: monitorWorkerContextPath(project, monitorId, workerKey),
        lifecycle: "reserved",
        last_synthesis_at: null,
        updated_at: at,
      };
      monitor.workers = [...(monitor.workers ?? []), record];
      monitor.updated_at = at;
      reserved = { worker_key: workerKey, alias: record.alias, context_path: record.context_path, generation: 0 };
      return draft;
    },
    { ...(options.expected !== undefined ? { expected: options.expected } : {}), now },
  );
  reserved.generation = registry.generation;
  return reserved;
}

export async function confirmWorkerCreation(
  project: string,
  monitorId: string,
  workerKey: string,
  input: { runtime_session_id: string; creation_receipt: string },
  options: { now?: number; expected?: number } = {},
): Promise<MonitorWorkerRecord> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  let result!: MonitorWorkerRecord;
  await withRegistry(
    project,
    (draft) => {
      const { monitor, worker } = findOwnedWorkerOrThrow(draft, monitorId, workerKey);
      if (worker.lifecycle !== "reserved") throw new Error("worker creation already resolved");
      worker.runtime_session_id = input.runtime_session_id;
      worker.creation_receipt = input.creation_receipt;
      worker.lifecycle = "active";
      worker.updated_at = at;
      monitor.updated_at = at;
      result = worker;
      return draft;
    },
    { ...(options.expected !== undefined ? { expected: options.expected } : {}), now },
  );
  return result;
}

/**
 * Reconcile an uncertain create after a reset: readback either confirms the
 * created runtime (-> active with receipt) or proves it absent (-> archived,
 * no orphan active record). It never spawns a second create.
 */
export async function reconcileWorkerCreate(
  project: string,
  monitorId: string,
  workerKey: string,
  input: { outcome: "created" | "absent"; runtime_session_id?: string | null; creation_receipt?: string | null },
  options: { now?: number; expected?: number } = {},
): Promise<MonitorWorkerRecord> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  let result!: MonitorWorkerRecord;
  await withRegistry(
    project,
    (draft) => {
      const { monitor, worker } = findOwnedWorkerOrThrow(draft, monitorId, workerKey);
      if (worker.lifecycle !== "reserved") throw new Error("worker creation already resolved");
      if (input.outcome === "created") {
        if (!input.runtime_session_id) throw new Error("confirmed create requires the observed runtime session id");
        worker.runtime_session_id = input.runtime_session_id;
        worker.creation_receipt = input.creation_receipt ?? null;
        worker.lifecycle = "active";
      } else {
        worker.runtime_session_id = null;
        worker.creation_receipt = null;
        worker.lifecycle = "archived";
      }
      worker.updated_at = at;
      monitor.updated_at = at;
      result = worker;
      return draft;
    },
    { ...(options.expected !== undefined ? { expected: options.expected } : {}), now },
  );
  return result;
}

/**
 * Reuse or rebind an own worker after a runtime loss. Reuse targets an idle or
 * archived own worker; rebind replaces the runtime reference for an active
 * worker whose runtime is gone. Foreign workers are always refused by key.
 */
export async function reuseWorker(
  project: string,
  monitorId: string,
  workerKey: string,
  input: { runtime_session_id: string; dispatch_receipt?: string | null },
  options: { now?: number; expected?: number } = {},
): Promise<MonitorWorkerRecord> {
  return rebindOwnWorker(project, monitorId, workerKey, input, options, ["idle", "archived"]);
}

export async function rebindWorker(
  project: string,
  monitorId: string,
  workerKey: string,
  input: { runtime_session_id: string; dispatch_receipt?: string | null },
  options: { now?: number; expected?: number } = {},
): Promise<MonitorWorkerRecord> {
  return rebindOwnWorker(project, monitorId, workerKey, input, options, ["active", "idle", "archived"]);
}

async function rebindOwnWorker(
  project: string,
  monitorId: string,
  workerKey: string,
  input: { runtime_session_id: string; dispatch_receipt?: string | null },
  options: { now?: number; expected?: number },
  allowed: MonitorWorkerLifecycle[],
): Promise<MonitorWorkerRecord> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  let result!: MonitorWorkerRecord;
  await withRegistry(
    project,
    (draft) => {
      const { monitor, worker } = findOwnedWorkerOrThrow(draft, monitorId, workerKey);
      if (!allowed.includes(worker.lifecycle)) throw new Error(`worker cannot be rebound from ${worker.lifecycle}`);
      worker.runtime_session_id = input.runtime_session_id;
      if (input.dispatch_receipt !== undefined) worker.dispatch_receipt = input.dispatch_receipt;
      // QC-F1 (waveA-qc SHA765c4f03): reactivating starts a fresh episode — the
      // previous terminal failure marker must not render as the NEW dispatch's
      // current error. History keeps the audited observation; the record clears.
      worker.last_error = null;
      worker.lifecycle = "active";
      worker.updated_at = at;
      monitor.updated_at = at;
      result = worker;
      return draft;
    },
    { ...(options.expected !== undefined ? { expected: options.expected } : {}), now },
  );
  return result;
}

export async function setWorkerLifecycle(
  project: string,
  monitorId: string,
  workerKey: string,
  lifecycle: Extract<MonitorWorkerLifecycle, "idle" | "archived">,
  options: { now?: number; expected?: number } = {},
): Promise<MonitorWorkerRecord> {
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  let result!: MonitorWorkerRecord;
  await withRegistry(
    project,
    (draft) => {
      const { monitor, worker } = findOwnedWorkerOrThrow(draft, monitorId, workerKey);
      worker.lifecycle = lifecycle;
      if (lifecycle === "archived") worker.last_synthesis_at = at;
      worker.updated_at = at;
      monitor.updated_at = at;
      result = worker;
      return draft;
    },
    { ...(options.expected !== undefined ? { expected: options.expected } : {}), now },
  );
  return result;
}

export async function setWorkerSynthesis(
  project: string,
  monitorId: string,
  workerKey: string,
  at: string,
  options: { now?: number; expected?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  await withRegistry(
    project,
    (draft) => {
      const { monitor, worker } = findOwnedWorkerOrThrow(draft, monitorId, workerKey);
      worker.last_synthesis_at = at;
      worker.updated_at = new Date(now).toISOString();
      monitor.updated_at = new Date(now).toISOString();
      return draft;
    },
    { ...(options.expected !== undefined ? { expected: options.expected } : {}), now },
  );
}

export async function listWorkers(project: string, monitorId: string): Promise<MonitorWorkerRecord[]> {
  const snapshot = await readRegistrySnapshot(project);
  const monitor = findMonitorOrThrow(snapshot.registry, monitorId);
  return monitor.workers ?? [];
}

export async function getWorker(
  project: string,
  monitorId: string,
  workerKey: string,
): Promise<MonitorWorkerRecord | null> {
  const snapshot = await readRegistrySnapshot(project);
  const monitor = findMonitorOrThrow(snapshot.registry, monitorId);
  return (monitor.workers ?? []).find((entry) => entry.worker_key === workerKey) ?? null;
}

/**
 * Bounded, deterministic digest of a monitor's worker index. The engine folds
 * this into its wake-change detection so a worker creation/receipt/lifecycle/
 * synthesis delta reaches the manager as a wake instead of being swallowed by
 * the unchanged-board no-op.
 */
export function workerIndexDigest(monitor: MonitorRecord): string {
  return digest(
    (monitor.workers ?? []).map((worker) => ({
      k: worker.worker_key,
      a: worker.alias,
      l: worker.lifecycle,
      r: worker.runtime_session_id,
      c: worker.creation_receipt,
      d: worker.dispatch_receipt,
      rr: worker.result_receipt,
      s: worker.last_synthesis_at,
      u: worker.updated_at,
    })),
  );
}
