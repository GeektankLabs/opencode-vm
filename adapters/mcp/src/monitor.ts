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
const RECOVERY_CANDIDATE_STATUSES: readonly string[] = ["selected", "skipped_current_failure", "skipped_attempted", "skipped_disabled", "skipped_provider_scope", "skipped_unavailable"];
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
  /** V2 §13.2/F4: time basis of the CURRENT dispatch episode, captured when a
   * genuinely NEW dispatch receipt is applied (rebind/reconcile). Absent on
   * legacy records — creation time stays the flagged fallback anchor. */
  dispatch_at?: string | null;
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

// ---------------------------------------------------------------------------
// Adaptive progress / investigation (task_a234c341 V2 §13, package e67c39cf).
// All clocks, cooldowns, evidence and claims live PER WORKER EPISODE
// (worker_key + dispatch_receipt); monitor-level fields are DERIVED
// projections only. Investigation results are never progress.
// ---------------------------------------------------------------------------

export const INVESTIGATION_DEFAULTS = {
  first_check_s: 3600,
  cooldown_s: 3600,
  ladder_s: [7200, 14400, 28800],
  budget: { max_duration_ms: 300_000, max_calls: 10, max_bytes: 262_144, call_timeout_ms: 3_000, daily_budget: 24 },
} as const;

/** Documented hard caps: degenerate configurations fail closed (V2 §13.3). */
export const INVESTIGATION_LIMITS = {
  seconds_min: 60,
  seconds_max: 604_800,
  max_duration_ms: 3_600_000,
  max_calls: 100,
  max_bytes: 1_048_576,
  call_timeout_ms_min: 250,
  call_timeout_ms_max: 15_000,
} as const;

export type InvestigationTaskType = "default" | "long_runner" | "milestoned";

export type MonitorInvestigationConfig = {
  schema: 1;
  config: {
    first_check_s: number;
    cooldown_s: number;
    ladder_s: [number, number, number];
    budget: { max_duration_ms: number; max_calls: number; max_bytes: number; call_timeout_ms: number; daily_budget: number };
  };
  task: {
    task_type: InvestigationTaskType;
    expected_milestone: string | null;
    milestone_due_at: string | null;
  };
};

export function defaultInvestigationConfig(): MonitorInvestigationConfig {
  return {
    schema: 1,
    config: {
      first_check_s: INVESTIGATION_DEFAULTS.first_check_s,
      cooldown_s: INVESTIGATION_DEFAULTS.cooldown_s,
      ladder_s: [...INVESTIGATION_DEFAULTS.ladder_s] as [number, number, number],
      budget: { ...INVESTIGATION_DEFAULTS.budget },
    },
    task: { task_type: "default", expected_milestone: null, milestone_due_at: null },
  };
}

function secondsField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < INVESTIGATION_LIMITS.seconds_min || value > INVESTIGATION_LIMITS.seconds_max)
    throw new Error(`investigation.${label} must be an integer between ${INVESTIGATION_LIMITS.seconds_min} and ${INVESTIGATION_LIMITS.seconds_max} seconds`);
  return value;
}

/** Normalizes operator input; degenerate values fail closed (never silently clamped). */
export function validateInvestigationConfigInput(input: unknown): MonitorInvestigationConfig {
  const next = defaultInvestigationConfig();
  if (input === undefined || input === null) return next;
  if (typeof input !== "object") throw new Error("investigation config must be an object");
  const raw = input as Record<string, unknown>;
  if (raw.first_check_s !== undefined) next.config.first_check_s = secondsField(raw.first_check_s, "first_check_s");
  if (raw.cooldown_s !== undefined) next.config.cooldown_s = secondsField(raw.cooldown_s, "cooldown_s");
  if (raw.ladder_s !== undefined) {
    if (!Array.isArray(raw.ladder_s) || raw.ladder_s.length !== 3)
      throw new Error("investigation.ladder_s must be exactly 3 values");
    const ladder = raw.ladder_s.map((entry, index) => secondsField(entry, `ladder_s[${index}]`)) as [number, number, number];
    if (!(ladder[0] < ladder[1] && ladder[1] < ladder[2]))
      throw new Error("investigation.ladder_s must be strictly increasing");
    next.config.ladder_s = ladder;
  }
  if (raw.budget !== undefined) {
    if (typeof raw.budget !== "object" || raw.budget === null) throw new Error("investigation.budget must be an object");
    const budgetRaw = raw.budget as Record<string, unknown>;
    const bounded = (key: string, cap: number): number => {
      const value = budgetRaw[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > cap)
        throw new Error(`investigation.budget.${key} must be a positive integer <= ${cap}`);
      return value;
    };
    if (budgetRaw.max_duration_ms !== undefined) next.config.budget.max_duration_ms = bounded("max_duration_ms", INVESTIGATION_LIMITS.max_duration_ms);
    if (budgetRaw.max_calls !== undefined) next.config.budget.max_calls = bounded("max_calls", INVESTIGATION_LIMITS.max_calls);
    if (budgetRaw.max_bytes !== undefined) next.config.budget.max_bytes = bounded("max_bytes", INVESTIGATION_LIMITS.max_bytes);
    if (budgetRaw.call_timeout_ms !== undefined) {
      const value = budgetRaw.call_timeout_ms;
      if (typeof value !== "number" || !Number.isSafeInteger(value) ||
          value < INVESTIGATION_LIMITS.call_timeout_ms_min || value > INVESTIGATION_LIMITS.call_timeout_ms_max)
        throw new Error(`investigation.budget.call_timeout_ms must be an integer between ${INVESTIGATION_LIMITS.call_timeout_ms_min} and ${INVESTIGATION_LIMITS.call_timeout_ms_max}`);
      next.config.budget.call_timeout_ms = value;
    }
  }
  if (raw.task_type !== undefined || raw.expected_milestone !== undefined || raw.milestone_due_at !== undefined) {
    if (raw.task_type !== undefined) {
      if (raw.task_type !== "default" && raw.task_type !== "long_runner" && raw.task_type !== "milestoned")
        throw new Error("task_contract.task_type must be default|long_runner|milestoned");
      next.task.task_type = raw.task_type;
    }
    if (raw.expected_milestone !== undefined) {
      if (raw.expected_milestone !== null && (typeof raw.expected_milestone !== "string" || raw.expected_milestone.length < 1 || raw.expected_milestone.length > 200))
        throw new Error("task_contract.expected_milestone must be a string (1..200) or null");
      next.task.expected_milestone = raw.expected_milestone ?? null;
    }
    if (raw.milestone_due_at !== undefined) {
      if (raw.milestone_due_at !== null && !validIso(raw.milestone_due_at))
        throw new Error("task_contract.milestone_due_at must be an ISO timestamp or null");
      next.task.milestone_due_at = raw.milestone_due_at ?? null;
    }
  }
  // Compatibility guard: optional aggregate budgets must never make the
  // contracted first check or cooldown unreachable (V2 §13.3).
  if (raw.daily_budget !== undefined) {
    // F1: persisted and enforced as a rolling 24 h window on EXECUTED
    // investigations (deferred runs never count).
    const daily = raw.daily_budget;
    if (typeof daily !== "number" || !Number.isSafeInteger(daily) || daily < Math.ceil(86_400 / next.config.cooldown_s))
      throw new Error(`investigation.daily_budget must be >= ceil(86400 / cooldown_s) = ${Math.ceil(86_400 / next.config.cooldown_s)}`);
    next.config.budget.daily_budget = daily;
  }
  return next;
}

export type InvestigationEvidenceEntry = { kind: string; source: string; at: string; digest: string };

export type InvestigationEpisodeState = {
  started_at: string;
  finished_at: string | null;
  outcome: "long_work_evidenced" | "no_progress_evidenced" | "inconclusive" | "aborted_budget" | null;
  evidence: InvestigationEvidenceEntry[];
  expected_milestone: string | null;
  wait_reason: string | null;
  worker_key: string | null;
  dispatch_receipt: string | null;
  generation_source: "runtime_json" | "heartbeat" | null;
  generation_value: string | null;
};

export type InvestigationWorkerState = {
  worker_key: string;
  dispatch_receipt: string | null;
  anchored_at: string | null;
  anchor_source: "dispatch" | "creation" | "reconciled" | null;
  last_progress_at: string | null;
  last_tool_digest: string | null;
  cooldown_until: number | null;
  next_deep_check_at: number | null;
  backoff_stage: number;
};

export type InvestigationObserverLease = { owner: string; lease_until: number; generation: number };

export type MonitorInvestigationState = {
  schema: 1;
  last_progress_at: string | null;
  last_investigation_at: string | null;
  cooldown_until: number | null;
  backoff_stage: number;
  next_deep_check_at: number | null;
  episode: InvestigationEpisodeState | null;
  workers: InvestigationWorkerState[];
  counters: { investigations_total: number; inconclusive_total: number; anchor_unknown_total: number };
  /** Rolling 24 h window of executed investigation times (epoch ms) for the
   * optional daily budget; deferred (not executed) runs never append. */
  recent_investigations?: number[];
  /** Milestone tracking (V2 §13.3/F1): one overdue-triggered investigation
   * PER deadline value; achievement via genuine A evidence only. */
  milestone?: { overdue_handled_for: string | null; overdue_handled_at: string | null; achieved_at: string | null } | null;
  /** Z1: throttle for the observer's bounded probe lane (epoch ms of the last
   * probe batch). Probes run ONLY while a wake is in flight. */
  observer_probe_at?: number | null;
  observer_lease?: InvestigationObserverLease | null;
};

export function defaultInvestigationState(): MonitorInvestigationState {
  return {
    schema: 1,
    last_progress_at: null,
    last_investigation_at: null,
    cooldown_until: null,
    backoff_stage: 0,
    next_deep_check_at: null,
    episode: null,
    workers: [],
    counters: { investigations_total: 0, inconclusive_total: 0, anchor_unknown_total: 0 },
    recent_investigations: [],
    milestone: { overdue_handled_for: null, overdue_handled_at: null, achieved_at: null },
    observer_probe_at: null,
    observer_lease: null,
  };
}

const INVESTIGATION_WORKERS_MAX = 8;
const INVESTIGATION_EVIDENCE_MAX = 6;

function investigationWorkerShapeOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.worker_key !== "string" || !/^worker_[0-9a-f]{32}$/.test(value.worker_key)) return false;
  if (value.dispatch_receipt !== null && typeof value.dispatch_receipt !== "string") return false;
  if (value.anchored_at !== null && !validIso(value.anchored_at)) return false;
  if (value.anchor_source !== null && !["dispatch", "creation", "reconciled"].includes(String(value.anchor_source))) return false;
  if (value.last_progress_at !== null && !validIso(value.last_progress_at)) return false;
  if (value.last_tool_digest !== null && (typeof value.last_tool_digest !== "string" || !/^[0-9a-f]{64}$/.test(value.last_tool_digest))) return false;
  for (const field of ["cooldown_until", "next_deep_check_at"] as const) {
    if (value[field] !== null && (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]))) return false;
  }
  if (typeof value.backoff_stage !== "number" || !Number.isSafeInteger(value.backoff_stage) || value.backoff_stage < 0 || value.backoff_stage > 3) return false;
  return true;
}

export function investigationShapeOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.schema !== 1) return false;
  for (const field of ["last_progress_at", "last_investigation_at"] as const) {
    if (value[field] !== null && !validIso(value[field])) return false;
  }
  for (const field of ["cooldown_until", "next_deep_check_at"] as const) {
    if (value[field] !== null && (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]))) return false;
  }
  if (typeof value.backoff_stage !== "number" || !Number.isSafeInteger(value.backoff_stage) || value.backoff_stage < 0 || value.backoff_stage > 3) return false;
  if (value.episode !== undefined && value.episode !== null) {
    const episode = value.episode;
    if (!isRecord(episode) || !validIso(episode.started_at)) return false;
    if (episode.finished_at !== null && !validIso(episode.finished_at)) return false;
    if (episode.outcome !== null && !["long_work_evidenced", "no_progress_evidenced", "inconclusive", "aborted_budget"].includes(String(episode.outcome))) return false;
    if (!Array.isArray(episode.evidence) || episode.evidence.length > INVESTIGATION_EVIDENCE_MAX) return false;
    for (const entry of episode.evidence) {
      if (!isRecord(entry) || typeof entry.kind !== "string" || entry.kind.length < 1 || entry.kind.length > 64 ||
          typeof entry.source !== "string" || entry.source.length < 1 || entry.source.length > 64 ||
          !validIso(entry.at) || typeof entry.digest !== "string" || entry.digest.length > 64) return false;
    }
    if (episode.expected_milestone !== null && typeof episode.expected_milestone !== "string") return false;
    if (episode.wait_reason !== null && typeof episode.wait_reason !== "string") return false;
    if (episode.worker_key !== null && (typeof episode.worker_key !== "string" || !/^worker_[0-9a-f]{32}$/.test(episode.worker_key))) return false;
    if (episode.dispatch_receipt !== null && typeof episode.dispatch_receipt !== "string") return false;
    if (episode.generation_source !== null && !["runtime_json", "heartbeat"].includes(String(episode.generation_source))) return false;
    if (episode.generation_value !== null && (typeof episode.generation_value !== "string" || episode.generation_value.length < 1 || episode.generation_value.length > 128)) return false;
  }
  if (!Array.isArray(value.workers) || value.workers.length > INVESTIGATION_WORKERS_MAX) return false;
  if (!value.workers.every(investigationWorkerShapeOk)) return false;
  if (!isRecord(value.counters)) return false;
  for (const field of ["investigations_total", "inconclusive_total", "anchor_unknown_total"] as const) {
    if (typeof value.counters[field] !== "number" || !Number.isSafeInteger(value.counters[field]) || value.counters[field] < 0) return false;
  }
  if (value.observer_lease !== undefined && value.observer_lease !== null) {
    const lease = value.observer_lease;
    if (!isRecord(lease) || typeof lease.owner !== "string" || lease.owner.length < 1 || lease.owner.length > 160 ||
        typeof lease.lease_until !== "number" || !Number.isSafeInteger(lease.lease_until) ||
        typeof lease.generation !== "number" || !Number.isSafeInteger(lease.generation) || lease.generation < 0) return false;
  }
  // V2 §13.3/F1: rolling daily-budget window + milestone tracking.
  if (value.recent_investigations !== undefined && value.recent_investigations !== null) {
    if (!Array.isArray(value.recent_investigations) || value.recent_investigations.length > 128) return false;
    if (!value.recent_investigations.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0)) return false;
  }
  if (value.milestone !== undefined && value.milestone !== null) {
    const milestone = value.milestone;
    if (!isRecord(milestone)) return false;
    for (const field of ["overdue_handled_for", "overdue_handled_at", "achieved_at"] as const) {
      if (milestone[field] !== null && typeof milestone[field] !== "string") return false;
    }
    if (milestone.overdue_handled_at !== null && !validIso(milestone.overdue_handled_at)) return false;
    if (milestone.achieved_at !== null && !validIso(milestone.achieved_at)) return false;
  }
  if (value.observer_probe_at !== undefined && value.observer_probe_at !== null &&
      (typeof value.observer_probe_at !== "number" || !Number.isSafeInteger(value.observer_probe_at))) return false;
  return true;
}

export function investigationConfigShapeOk(value: unknown): boolean {
  if (!isRecord(value) || value.schema !== 1) return false;
  try {
    const validated = validateInvestigationConfigInput({
      first_check_s: isRecord(value.config) ? value.config.first_check_s : undefined,
      cooldown_s: isRecord(value.config) ? value.config.cooldown_s : undefined,
      ladder_s: isRecord(value.config) ? value.config.ladder_s : undefined,
      budget: isRecord(value.config) ? value.config.budget : undefined,
      task_type: isRecord(value.task) ? value.task.task_type : undefined,
      expected_milestone: isRecord(value.task) ? value.task.expected_milestone : undefined,
      milestone_due_at: isRecord(value.task) ? value.task.milestone_due_at : undefined,
    });
    // Exact-shape check: values must round-trip identically (no silent normalization drift).
    const stored = value as MonitorInvestigationConfig;
    return JSON.stringify(stored.config) === JSON.stringify(validated.config) &&
      JSON.stringify(stored.task) === JSON.stringify(validated.task);
  } catch {
    return false;
  }
}

/** Per-worker get-or-create with episode reset on dispatch_receipt change (V2 §13.1). */
export function investigationWorkerFor(
  investigation: MonitorInvestigationState,
  workerKey: string,
  dispatchReceipt: string | null,
): InvestigationWorkerState {
  let state = investigation.workers.find((entry) => entry.worker_key === workerKey);
  if (!state) {
    state = {
      worker_key: workerKey,
      dispatch_receipt: dispatchReceipt,
      anchored_at: null,
      anchor_source: null,
      last_progress_at: null,
      last_tool_digest: null,
      cooldown_until: null,
      next_deep_check_at: null,
      backoff_stage: 0,
    };
    investigation.workers.push(state);
    if (investigation.workers.length > INVESTIGATION_WORKERS_MAX)
      investigation.workers.splice(0, investigation.workers.length - INVESTIGATION_WORKERS_MAX);
    return state;
  }
  if (state.dispatch_receipt !== dispatchReceipt) {
    // New dispatch episode: fresh clock, prior episode stays in this bounded
    // record's past values only (stage restarts at 0 for the new episode).
    state.dispatch_receipt = dispatchReceipt;
    state.anchored_at = null;
    state.anchor_source = null;
    state.last_tool_digest = null;
    state.cooldown_until = null;
    state.next_deep_check_at = null;
    state.backoff_stage = 0;
  }
  return state;
}

/** Recomputes the DERIVED monitor-level projections from per-worker state. */
export function refreshInvestigationProjections(investigation: MonitorInvestigationState): void {
  const cooldowns = investigation.workers.map((entry) => entry.cooldown_until).filter((value): value is number => value !== null);
  const nexts = investigation.workers.map((entry) => entry.next_deep_check_at).filter((value): value is number => value !== null);
  const progresses = investigation.workers.map((entry) => entry.last_progress_at).filter((value): value is string => value !== null);
  investigation.cooldown_until = cooldowns.length > 0 ? Math.min(...cooldowns) : null;
  investigation.next_deep_check_at = nexts.length > 0 ? Math.min(...nexts) : null;
  // Most-stale progress across workers (monitor-wide projection must not mask
  // a hung worker, V2 §13.1): earliest last_progress_at.
  investigation.last_progress_at = progresses.length > 0 ? progresses.slice().sort()[0]! : null;
  const dueWorker = investigation.workers
    .filter((entry) => entry.anchored_at !== null)
    .sort((a, b) => (a.next_deep_check_at ?? Number.MAX_SAFE_INTEGER) - (b.next_deep_check_at ?? Number.MAX_SAFE_INTEGER))[0];
  investigation.backoff_stage = dueWorker ? dueWorker.backoff_stage : 0;
}

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
  run: { active: boolean; started_at: string | null; action: string | null; owner_pid?: number; owner_generation?: string };
  recovery: { active: boolean; started_at: string | null; last_error_fingerprint: string | null };
  /** Welle B additive persistence (see RecoveryEpisode docs); absent on legacy records. */
  recovery_episode?: RecoveryEpisode | null;
  recovery_resolution?: RecoveryResolutionEntry[] | null;
  /** task_a234c341 V2 §13: adaptive progress/investigation state (additive, fail-closed). */
  investigation?: MonitorInvestigationState | null;
  /** V2 §13.3: configurable starting values + task contract (additive, validated). */
  investigation_config?: MonitorInvestigationConfig | null;
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
    // V2 §13.8 claim fencing: owner identity fields validated when present
    // (legacy claims without identity stay valid; the recovery path treats
    // them as provably-unknown, never as sufficient process identity).
    if (!isRecord(monitor.run)) return false;
    if (monitor.run.owner_pid !== undefined &&
      (typeof monitor.run.owner_pid !== "number" || !Number.isSafeInteger(monitor.run.owner_pid) || monitor.run.owner_pid <= 0)) return false;
    if (monitor.run.owner_generation !== undefined &&
      (typeof monitor.run.owner_generation !== "string" || (monitor.run.owner_generation as string).length < 1 || (monitor.run.owner_generation as string).length > 128)) return false;
    // V2 §13: adaptive investigation state + config fail closed when present.
    if (monitor.investigation !== undefined && monitor.investigation !== null && !investigationShapeOk(monitor.investigation)) return false;
    if (monitor.investigation_config !== undefined && monitor.investigation_config !== null && !investigationConfigShapeOk(monitor.investigation_config)) return false;
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
    // V2 §13.2/F4: additive dispatch time basis, validated when present.
    if (worker.dispatch_at !== undefined && worker.dispatch_at !== null && !validIso(worker.dispatch_at)) return false;
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
      if (input.dispatch_receipt !== undefined) {
        // V2 §13.2/F4: a genuinely NEW dispatch receipt starts a fresh time
        // basis (dispatch_at). Re-binding with the SAME receipt never resets
        // the anchor; creation time remains the flagged legacy fallback only.
        if (worker.dispatch_receipt !== input.dispatch_receipt) {
          worker.dispatch_receipt = input.dispatch_receipt;
          worker.dispatch_at = at;
        }
      }
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
