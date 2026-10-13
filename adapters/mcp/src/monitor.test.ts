import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignMonitorAlias,
  confirmWorkerCreation,
  defaultInvestigationConfig,
  defaultInvestigationState,
  defaultMonitorRecord,
  digest,
  getWorker,
  investigationWorkerFor,
  listWorkers,
  managerAliasFor,
  MONITOR_HISTORY_LIMIT,
  RECOVERY_ATTEMPT_LIMIT,
  RECOVERY_RESOLUTION_LIMIT,
  monitorDecision,
  monitorHistory,
  monitorManagerContextPath,
  monitorRegistryPath,
  monitorWorkerContextPath,
  monitorWorkersDirectory,
  readEpisode,
  readRegistrySnapshot,
  reconcileWorkerCreate,
  recordRepair,
  rebindWorker,
  refreshInvestigationProjections,
  reserveWorker,
  reuseWorker,
  setWorkerLifecycle,
  setWorkerSynthesis,
  validateInvestigationConfigInput,
  withRegistry,
  workerAliasFor,
  workerIndexDigest,
} from "./monitor.js";
import {
  MonitorEngine,
  catalogAvailable,
  classifyEvidence,
  classifyRepairKind,
  fallbackChain,
} from "./monitor-engine.js";
import { resolveRecoveryChain } from "./agent-control.js";
import type { MonitorBoardLike, MonitorGatewayLike, MonitorPolicyView } from "./monitor-engine.js";
import type { AbortSessionTurnResult, CorrelatedErrorDetail, RuntimeOptions, SessionStatusResult } from "./types.js";

const TASK = "task_11111111-1111-4111-8111-111111111111";

function runtimeOptions(): RuntimeOptions {
  return {
    agents: ["build"],
    providers: [
      { provider_id: "deep-provider", name: "Deep" },
      { provider_id: "fallback-provider", name: "Fallback" },
      { provider_id: "standard-provider", name: "Standard" },
    ],
    models: [
      { provider_id: "deep-provider", model_id: "deep-model", name: "deep", variants: [] },
      { provider_id: "deep-provider", model_id: "deep-fb", name: "deepfb", variants: [] },
      { provider_id: "fallback-provider", model_id: "fallback-model", name: "fb", variants: [] },
      { provider_id: "standard-provider", model_id: "standard-model", name: "std", variants: [] },
    ],
    truncated: false,
  };
}

function okStatus(overrides: Partial<SessionStatusResult> = {}): SessionStatusResult {
  return {
    session_id: "ses_monitor",
    backend_activity: "idle",
    state: "completed",
    pending_input: { permissions: 0, questions: 0 },
    assistant_message_ids: [],
    ...overrides,
  };
}

type FakeState = {
  taskStatus: string;
  taskUpdated: string;
  entries: Array<{ sequence: number; entry_id: string; appended_at: string }>;
  checkpoint: { sequence: number; entry_id: string } | null;
  sends: string[];
  sendsFail: string | null;
  abortResults: string[];
  abortState: "aborted" | "no_active_turn" | "abort_uncertain";
  updates: Array<Record<string, unknown>>;
  status: SessionStatusResult;
  history: Array<{ id: string; role: string; text: string }>;
  runtime: { provider_id: string; model_id: string; variant?: string };
  dropVariant: boolean;
  combinedPending: { permissions: number; questions: number; coverage?: "session" | "session+descendants" | "unknown" } | null;
  combinedQueue: Array<{ permissions: number; questions: number } | null>;
  combinedThrows: boolean;
  abortPendingAfter: { permissions: number; questions: number } | null;
  abortActivityAfter: "idle" | "busy" | "retry";
  readFailCode: string | null;
  lostSessionId: string | null;
  createdSessionId: string;
  statusCalls: Array<{ session_id: string; message_id: string | null }>;
  statusFor?: (sessionId: string, messageId?: string) => SessionStatusResult;
};

function fakes(state: FakeState) {
  const gateway: MonitorGatewayLike = {
    async createSession(title: string) {
      return { project: { id: "p", name: "p" }, session_id: state.createdSessionId, title, agent: "build", provider_id: "deep-provider", model_id: "deep-model", state: "created" };
    },
    async getSessionDetails(sessionId?: string) {
      const id = sessionId ?? "ses_monitor";
      if (state.lostSessionId && id === state.lostSessionId) throw new Error("Could not inspect OpenCode session.");
      return {
        id,
        title: "Monitor",
        created: 1,
        updated: 2,
        activity: "idle",
        agent: "build",
        provider_id: state.runtime.provider_id,
        model_id: state.runtime.model_id,
        ...(state.runtime.variant !== undefined && !state.dropVariant ? { variant: state.runtime.variant } : {}),
        pending_input: { permissions: 0, questions: 0 },
      };
    },
    async getSessionStatus(sessionId: string, messageId?: string) {
      state.statusCalls.push({ session_id: sessionId, message_id: messageId ?? null });
      if (state.statusFor && sessionId !== "ses_monitor") return state.statusFor(sessionId, messageId);
      return state.status;
    },
    async getCombinedPendingInput() {
      if (state.combinedThrows) throw new Error("combined pending coverage unavailable");
      if (state.combinedQueue.length > 0) return state.combinedQueue.shift()!;
      return state.combinedPending ?? state.status.pending_input;
    },
    async getSessionHistory() {
      return { messages: state.history };
    },
    async sendMessage(_sessionId: string, message: string) {
      if (state.sendsFail) throw Object.assign(new Error(state.sendsFail), { code: state.sendsFail });
      state.sends.push(message);
      return { session_id: "ses_monitor", message_id: `msg_${"a".repeat(32)}`, state: "submitted" };
    },
    async abortSessionTurn() {
      state.abortResults.push(state.abortState);
      const result: AbortSessionTurnResult = {
        session_id: "ses_monitor",
        state: state.abortState,
        observed_at: new Date(0).toISOString(),
        activity_after: state.abortActivityAfter,
        pending_input_after: state.abortPendingAfter ?? { permissions: 0, questions: 0 },
      };
      if (state.abortPendingAfter === null) {
        delete (result as { pending_input_after?: unknown }).pending_input_after;
      }
      return result;
    },
    async getSessionRuntimeOptions() {
      return runtimeOptions();
    },
    async updateSessionRuntime(_sessionId: string, patch: Record<string, unknown>) {
      state.updates.push(patch);
      state.runtime = {
        provider_id: String(patch.provider_id),
        model_id: String(patch.model_id),
        ...(patch.variant !== undefined ? { variant: String(patch.variant) } : {}),
      };
      return {
        session_id: "ses_monitor",
        previous: { agent: "build", provider_id: "deep-provider", model_id: "deep-model", variant: "" },
        current: { agent: "build", provider_id: String(patch.provider_id), model_id: String(patch.model_id), variant: "" },
        state: "updated",
      };
    },
  };
  const board: MonitorBoardLike = {
    async getTask() {
      return { id: TASK, title: "Anchor", status: state.taskStatus, updated_at: state.taskUpdated };
    },
    async getManagementHistory(_taskId: string, options: { mode: "recent" | "latest_checkpoint"; limit: number }) {
      if (state.readFailCode) throw Object.assign(new Error("History limit must be between 1 and 50."), { code: state.readFailCode });
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50)
        throw Object.assign(new Error("History limit must be between 1 and 50."), { code: "INVALID_ARGUMENT" });
      if (options.mode === "latest_checkpoint") return { checkpoint: state.checkpoint };
      return { entries: state.entries };
    },
    async getDocuments() {
      return { documents: [] };
    },
  };
  return { gateway, board };
}

async function setup(): Promise<{ project: string; cleanup: () => Promise<void> }> {
  const project = await mkdtemp(join(tmpdir(), "ocvm-monitor-test-"));
  return { project, cleanup: () => rm(project, { recursive: true, force: true }) };
}

function baseState(): FakeState {
  return {
    taskStatus: "in_progress",
    taskUpdated: "2026-10-07T00:00:00.000Z",
    entries: [{ sequence: 1, entry_id: "e1", appended_at: "2026-10-07T00:00:00.000Z" }],
    checkpoint: { sequence: 1, entry_id: "e1" },
    sends: [],
    sendsFail: null,
    abortResults: [],
    abortState: "aborted",
    updates: [],
    status: okStatus(),
    history: [],
    runtime: { provider_id: "deep-provider", model_id: "deep-model" },
    dropVariant: false,
    combinedPending: null,
    combinedQueue: [],
    combinedThrows: false,
    abortPendingAfter: { permissions: 0, questions: 0 },
    abortActivityAfter: "idle",
    readFailCode: null,
    lostSessionId: null,
    createdSessionId: "ses_monitor",
    statusCalls: [],
  };
}

const policyConfigured: MonitorPolicyView = {
  finalFallback: { mode: "total", selection: { provider_id: "fallback-provider", model_id: "fallback-model" } },
  profiles: { deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null, execution: null },
};
const policyUnconfigured: MonitorPolicyView = { finalFallback: null, profiles: { deep: { provider_id: "deep-provider", model_id: "deep-model" } } };

test("registry: CAS generation, concurrent rejection, invalid shapes and atomic publication", async () => {
  const { project, cleanup } = await setup();
  try {
    const created = await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 1000);
      monitorHistory(monitor, "created", undefined, 1000);
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(created.generation, 1);
    await assert.rejects(
      withRegistry(project, () => undefined, { expected: 0 }),
      /changed concurrently/,
    );
    const second = await withRegistry(project, (registry) => {
      registry.monitors[0]!.title = "M2";
      return registry;
    }, { expected: 1 });
    assert.equal(second.generation, 2);
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.generation, 2);
    assert.equal(snapshot.registry.monitors[0]!.title, "M2");
    const raw = JSON.parse(await readFile(monitorRegistryPath(project), "utf8"));
    assert.equal(raw.schema, 1);
    await assert.rejects(
      withRegistry(project, (registry) => {
        (registry.monitors[0] as { id: string }).id = "monitor_bad";
        return registry;
      }),
      /invalid shape/,
    );
  } finally {
    await cleanup();
  }
});

test("budget: production-code max 2 without progress parks, exclusions never count, progress resets, history retained", async () => {
  const { project, cleanup } = await setup();
  try {
    const created = await withRegistry(project, (registry) => {
      registry.monitors.push(defaultMonitorRecord("M", TASK, {}, 1000));
      return registry;
    });
    const monitor = created.monitors[0]!;
    assert.equal(recordRepair(monitor, "fp1", "excluded", false, 1).outcome, "excluded");
    assert.equal(recordRepair(monitor, "fp1", "excluded", false, 2).outcome, "excluded");
    assert.equal(monitor.budget.fp1?.no_progress, 0);
    assert.equal(recordRepair(monitor, "fp1", "production-code", false, 3).outcome, "recorded");
    assert.equal(monitor.budget.fp1?.no_progress, 1);
    assert.equal(recordRepair(monitor, "fp1", "production-code", false, 4).outcome, "recorded");
    assert.equal(monitor.budget.fp1?.no_progress, 2);
    assert.equal(recordRepair(monitor, "fp1", "production-code", false, 5).outcome, "parked");
    assert.equal(monitor.budget.fp1?.entries.length, 4);
    assert.equal(recordRepair(monitor, "fp1", "production-code", true, 6).outcome, "progress-reset");
    assert.equal(monitor.budget.fp1?.no_progress, 0);
    assert.ok(monitor.budget.fp1!.entries.some((entry) => entry.evidenced_progress === true));
    assert.equal(monitor.budget.fp1?.entries.length, 5, "history retained across progress");
  } finally {
    await cleanup();
  }
});

test("read episode: backoff, success ends, exhaustion alert once, never touches the repair counter", async () => {
  const { project, cleanup } = await setup();
  try {
    const created = await withRegistry(project, (registry) => {
      registry.monitors.push(defaultMonitorRecord("M", TASK, {}, 1000));
      return registry;
    });
    const monitor = created.monitors[0]!;
    const first = readEpisode(monitor, "read", "transient", 10);
    assert.equal(first.outcome, "backoff");
    assert.equal(monitor.budget.read, undefined);
    readEpisode(monitor, "read", "transient", 20);
    const third = readEpisode(monitor, "read", "persistent", 30);
    assert.equal(third.outcome, "exhausted-alert");
    const fourth = readEpisode(monitor, "read", "persistent", 40);
    assert.equal(fourth.outcome, "backoff", "alert exactly once");
    assert.equal(readEpisode(monitor, "read", "success", 50).outcome, "success");
    assert.equal(monitor.read_episodes.read, undefined, "success ends the episode");
    assert.equal(monitor.budget.read, undefined);
  } finally {
    await cleanup();
  }
});

test("classification: operational classes are excluded, work failures are production-code", () => {
  for (const category of ["provider_timeout", "provider_quota", "context_input_length", "provider_auth", "unknown", "aborted"]) {
    assert.equal(classifyRepairKind(category), "excluded", category);
  }
  assert.equal(classifyRepairKind("work_failure"), "production-code");
  const blocked = classifyEvidence(okStatus({
    state: "failed",
    error_details: [{ category: "provider_quota", message: "quota", detail_availability: "safe_template", source: "assistant_message_error", assistant_message_id: "msg_x", attribution: "exact_parent" }],
  }));
  assert.equal(blocked.kind, "blocked");
  if (blocked.kind === "blocked") assert.equal(blocked.category, "provider_quota");
  assert.equal(classifyEvidence(okStatus({ state: "running" })).kind, "none");
});

test("engine: unchanged monitor is a cheap no-op without a model call; changed canonical dispatches exactly once", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    const dispatched = await engine.tick();
    assert.equal(dispatched, "dispatched");
    assert.equal(state.sends.length, 1);
    const after = await readRegistrySnapshot(project);
    assert.equal(after.registry.monitors[0]!.dispatch_wal!.message_id, "msg_" + "a".repeat(32));
    assert.equal(after.registry.monitors[0]!.state.work, "active");
    const second = await engine.tick();
    assert.equal(second, "no-due");
    // advance time to the next interval with an unchanged canonical state
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 200_000 });
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.scheduler.next_run_at = 100_000;
      return registry;
    });
    const noop = await engine2.tick();
    assert.equal(noop, "noop-unchanged");
    assert.equal(state.sends.length, 1, "unchanged canonical must not call the model again");
  } finally {
    await cleanup();
  }
});

test("W4 wake progress: a worker-index delta reaches the manager instead of a no-op", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    assert.equal(state.sends.length, 1);
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;

    // Same canonical board state, but a worker receipt/lifecycle delta must wake
    // the manager rather than be swallowed by the unchanged-board no-op.
    const reserved = await reserveWorker(project, monitorId, {}, { now: 100_500 });
    await confirmWorkerCreation(
      project,
      monitorId,
      reserved.worker_key,
      { runtime_session_id: "ses_w", creation_receipt: "msg_w" },
      { now: 100_600 },
    );
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 200_000 });
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.scheduler.next_run_at = 100_000;
      return registry;
    });
    assert.equal(await engine2.tick(), "dispatched");
    assert.equal(state.sends.length, 2, "worker delta must reach the manager");
    assert.ok(state.sends[1]!.includes("M1-A:active@ses_w"), "wake prompt carries the bounded worker index");

    // Board and worker index unchanged again -> cheap no-op.
    const engine3 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 300_000 });
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.scheduler.next_run_at = 100_000;
      return registry;
    });
    assert.equal(await engine3.tick(), "noop-unchanged");
    assert.equal(state.sends.length, 2);
  } finally {
    await cleanup();
  }
});

test("W4 worker completion: a dispatched worker's finished turn yields a fresh result/terminal state and wakes the manager", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;

    // An already-dispatched active worker whose runtime turn is finished.
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    state.status = okStatus({ assistant_message_ids: ["msg_result"] });

    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 200_000 });
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 100_000; return registry; });
    assert.equal(await engine2.tick(), "dispatched", "observed worker completion must wake the manager");
    assert.equal(state.sends.length, 2);
    const after = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const worker = after.workers![0]!;
    assert.equal(worker.lifecycle, "idle");
    assert.equal(worker.result_receipt, "msg_result");
    assert.ok(after.history.some((entry) => entry.type === "worker-observed-complete"));

    // No board or worker change next -> cheap no-op (no repeated wake).
    const engine3 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 300_000 });
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 100_000; return registry; });
    assert.equal(await engine3.tick(), "noop-unchanged");
    assert.equal(state.sends.length, 2);
  } finally {
    await cleanup();
  }
});

test("engine: canonical read passes a bounded limit and reports deterministic contract errors honestly", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    // The board double rejects a missing/oversized limit exactly like the journal
    // contract; a valid canonical read still succeeds and never enters a read episode.
    const first = await engine.tick();
    assert.notEqual(first, "read-backoff");
    assert.notEqual(first, "read-exhausted");
    const ok = await readRegistrySnapshot(project);
    assert.ok(!ok.registry.monitors[0]!.history.some((entry) => entry.type.startsWith("read-")));

    state.readFailCode = "INVALID_ARGUMENT";
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.scheduler.next_run_at = 0;
      return registry;
    });
    assert.equal(await engine.tick(), "read-backoff");
    const snapshot = await readRegistrySnapshot(project);
    const record = snapshot.registry.monitors[0]!;
    const last = record.history[record.history.length - 1]!;
    assert.equal(last.type, "read-backoff");
    assert.equal((last.detail as { persistent?: boolean }).persistent, true);
    assert.equal((last.detail as { deterministic?: boolean }).deterministic, true);
    assert.equal((last.detail as { code?: string }).code, "INVALID_ARGUMENT");
    assert.ok(record.logs.some((entry) => entry.level === "error" && entry.message.includes("deterministic contract error INVALID_ARGUMENT")));
  } finally {
    await cleanup();
  }
});

test("engine: busy/pending holds, WAL reconciliation without blind resend, uncertain parks", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    state.status = okStatus({ pending_input: { permissions: 1, questions: 0 } });
    assert.equal(await engine.tick(), "busy-held");
    assert.equal(state.sends.length, 0);
    // WAL crash before receipt: reconcile finds the marker -> no resend
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.dispatch_wal = { action_id: "wake_test", at: new Date(0).toISOString(), prompt_digest: "x", message_id: null };
      monitor.scheduler.next_run_at = 0;
      return registry;
    });
    state.status = okStatus();
    state.history = [{ id: "msg_user_1", role: "user", text: "[MONITOR-ACTION wake_test] continue" }];
    assert.equal(await engine.tick(), "dispatch-reconciled");
    assert.equal(state.sends.length, 0, "reconciled dispatch is never resent");
    assert.equal(state.updates.length, 0);
    // WAL crash with no matching marker -> park INPUT_REQUIRED, no blind resend
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.state.work = "active";
      monitor.dispatch_wal = { action_id: "wake_missing", at: new Date(0).toISOString(), prompt_digest: "x", message_id: null };
      monitor.scheduler.next_run_at = 0;
      return registry;
    });
    state.history = [];
    assert.equal(await engine.tick(), "dispatch-uncertain");
    const parked = await readRegistrySnapshot(project);
    assert.equal(parked.registry.monitors[0]!.state.work, "parked_input_required");
    assert.equal(parked.registry.monitors[0]!.state.parked_reason, "dispatch-uncertain");
    assert.equal(state.sends.length, 0);
  } finally {
    await cleanup();
  }
});

test("engine: recovery aborts and verifies, unconfigured final fallback parks INPUT_REQUIRED without a dispatch", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = okStatus({
      state: "failed",
      error_details: [{ category: "provider_quota", message: "quota", detail_availability: "safe_template", source: "assistant_message_error", assistant_message_id: "msg_x", attribution: "exact_parent" }],
    });
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyUnconfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const created = defaultMonitorRecord("M", TASK, {}, 100_000);
      created.scheduler.next_run_at = 0;
      registry.monitors.push(created);
      return registry;
    });
    assert.equal(await engine.tick(), "recovery-parked");
    assert.deepEqual(state.abortResults, ["aborted"]);
    assert.equal(state.updates.length, 0);
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.monitors[0]!.state.work, "parked_input_required");
    assert.equal(snapshot.registry.monitors[0]!.state.parked_reason, "final-fallback-unconfigured");
    assert.equal(snapshot.registry.monitors[0]!.scheduler.enabled, true, "work park never disables the schedule");
    assert.equal(state.sends.length, 0);
  } finally {
    await cleanup();
  }
});

test("engine: configured total fallback switches runtime with readback and continues exactly once", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = okStatus({
      state: "failed",
      error_details: [{ category: "provider_timeout", message: "timeout", detail_availability: "safe_template", source: "assistant_message_error", assistant_message_id: "msg_x", attribution: "exact_parent" }],
    });
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const created = defaultMonitorRecord("M", TASK, {}, 100_000);
      created.scheduler.next_run_at = 0;
      registry.monitors.push(created);
      return registry;
    });
    assert.equal(await engine.tick(), "recovery-continued");
    assert.deepEqual(state.abortResults, ["aborted"]);
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0]!.provider_id, "fallback-provider");
    assert.equal(state.sends.length, 1);
    assert.match(state.sends[0]!, /\[MONITOR-RECOVERY/);
    // task_68085480 part 4: bounded authorized-alternatives check before a total park.
    assert.match(state.sends[0]!, /already-authorized plausible alternative ways within the existing authorized scope/);
    assert.match(state.sends[0]!, /global impossibility judgement/);
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.monitors[0]!.recovery.active, false);
    assert.equal(snapshot.registry.monitors[0]!.state.work, "active", "operational recovery does not park work");
  } finally {
    await cleanup();
  }
});

test("engine: scheduler, work state and run activity stay separate; expiry only by explicit expiry", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.work = "parked_input_required";
      monitor.state.last_seen_digest = "before";
      registry.monitors.push(monitor);
      return registry;
    });
    const changed = await engine.tick();
    assert.equal(changed, "dispatched");
    const after = await readRegistrySnapshot(project);
    assert.equal(after.registry.monitors[0]!.state.work, "parked_input_required", "changed canonical resumes even while parked");
    assert.equal(after.registry.monitors[0]!.scheduler.enabled, true);
    // explicit expiry disables only the scheduler
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.scheduler.expiry_at = 90_000;
      monitor.scheduler.next_run_at = 50_000;
      monitor.state.last_seen_digest = "different";
      return registry;
    });
    const expired = await engine.tick();
    assert.equal(expired, "dispatched");
    const expiredSnapshot = await readRegistrySnapshot(project);
    assert.equal(expiredSnapshot.registry.monitors[0]!.scheduler.enabled, false);
    assert.equal(expiredSnapshot.registry.monitors[0]!.scheduler.next_run_at, null);
    assert.equal(expiredSnapshot.registry.monitors[0]!.state.work, "parked_input_required", "expiry does not change work state");
  } finally {
    await cleanup();
  }
});

test("engine: degraded fallback chain skips null profiles and failed identities, availability checked", () => {
  const policy: MonitorPolicyView = {
    finalFallback: { mode: "degrading", selection: { provider_id: "fallback-provider", model_id: "fallback-model" } },
    profiles: { deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null, execution: null },
  };
  const chain = fallbackChain(policy, "deep");
  assert.deepEqual(chain, [{ provider_id: "fallback-provider", model_id: "fallback-model" }]);
  const catalog = runtimeOptions();
  assert.equal(catalogAvailable(catalog, { provider_id: "fallback-provider", model_id: "fallback-model" }), true);
  assert.equal(catalogAvailable(catalog, { provider_id: "missing", model_id: "x" }), false);
  assert.equal(catalogAvailable({ ...catalog, truncated: true }, { provider_id: "fallback-provider", model_id: "fallback-model" }), true);
});

test("inventory: all monitor states are returned with stable ids and unique master binding", async () => {
  const { project, cleanup } = await setup();
  try {
    await withRegistry(project, (registry) => {
      const active = defaultMonitorRecord("Active", TASK, {}, 1000);
      const parked = defaultMonitorRecord("Parked", "task_22222222-2222-4222-8222-222222222222", {}, 1000);
      parked.state.work = "parked_input_required";
      const disabled = defaultMonitorRecord("Disabled", "task_33333333-3333-4333-8333-333333333333", {}, 1000);
      disabled.scheduler.enabled = false;
      registry.monitors.push(active, parked, disabled);
      return registry;
    });
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.monitors.length, 3);
    const ids = new Set(snapshot.registry.monitors.map((monitor) => monitor.id));
    assert.equal(ids.size, 3);
    const anchors = new Set(snapshot.registry.monitors.map((monitor) => monitor.anchor.task_id));
    assert.equal(anchors.size, 3);
    assert.ok(snapshot.registry.monitors.some((monitor) => !monitor.scheduler.enabled));
    assert.ok(snapshot.registry.monitors.some((monitor) => monitor.state.work === "parked_input_required"));
  } finally {
    await cleanup();
  }
});
test("engine: operator abort request performs a verified native abort without a dispatch", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.abort_request = { requested_at: new Date(0).toISOString(), reason: "hub-ui" };
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    await engine.tick();
    assert.deepEqual(state.abortResults, ["aborted"]);
    assert.equal(state.sends.length, 0, "abort request never dispatches a prompt");
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.monitors[0]!.abort_request, null);
    assert.ok(snapshot.registry.monitors[0]!.history.some((entry) => entry.type === "run-aborted"));
    assert.equal(snapshot.registry.monitors[0]!.scheduler.enabled, true);
  } finally {
    await cleanup();
  }
});
test("engine: unverifiable descendant pending coverage holds instead of a clean zero", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = okStatus({ pending_input: { permissions: 0, questions: 0 } });
    state.combinedPending = { permissions: 0, questions: 0, coverage: "unknown" };
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "busy-held");
    assert.equal(state.sends.length, 0, "unknown coverage must not be read as no pending input");
    const snapshot = await readRegistrySnapshot(project);
    assert.ok(snapshot.registry.monitors[0]!.history.some(
      (entry) => entry.type === "busy-held" && (entry.detail as { reason?: string } | undefined)?.reason === "pending-coverage-unavailable"));
  } finally {
    await cleanup();
  }
});
test("engine: blind v2 zero with combined v1 permission holds the pre-dispatch gate", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = okStatus({ pending_input: { permissions: 0, questions: 0 } });
    state.combinedPending = { permissions: 1, questions: 0 };
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "busy-held");
    assert.equal(state.sends.length, 0, "a v1-runner permission suppresses the model dispatch");
    const snapshot = await readRegistrySnapshot(project);
    assert.ok(snapshot.registry.monitors[0]!.history.some(
      (entry) => entry.type === "busy-held" && (entry.detail as { reason?: string } | undefined)?.reason === "pending-input"));
  } finally {
    await cleanup();
  }
});

test("engine: combined coverage errors fail closed and never dispatch", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.combinedThrows = true;
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "busy-held");
    assert.equal(state.sends.length, 0, "unavailable combined coverage must not be treated as clear");
    const snapshot = await readRegistrySnapshot(project);
    assert.ok(snapshot.registry.monitors[0]!.history.some(
      (entry) => entry.type === "busy-held" && (entry.detail as { reason?: string } | undefined)?.reason === "pending-coverage-unavailable"));
  } finally {
    await cleanup();
  }
});

test("engine: compaction gate consults combined pending and holds on a late v1 permission", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = okStatus({
      state: "failed",
      error_details: [{ category: "context_input_length", message: "too long", detail_availability: "safe_template", source: "assistant_message_error", assistant_message_id: "msg_x", attribution: "exact_parent" }],
    });
    state.combinedQueue = [{ permissions: 0, questions: 0 }, { permissions: 1, questions: 0 }];
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "busy-held");
    assert.equal(state.sends.length, 0, "the compaction continue is suppressed while any permission surface is pending");
    const snapshot = await readRegistrySnapshot(project);
    assert.ok(snapshot.registry.monitors[0]!.history.some((entry) => entry.type === "compaction-held"));
  } finally {
    await cleanup();
  }
});

test("engine: post-abort verification consumes truthful combined coverage and preserves the operator request", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.abortState = "no_active_turn";
    state.abortPendingAfter = { permissions: 1, questions: 0 };
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.abort_request = { requested_at: new Date(0).toISOString(), reason: "operator-request" };
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "recovery-parked");
    assert.equal(state.sends.length, 0);
    const snapshot = await readRegistrySnapshot(project);
    const record = snapshot.registry.monitors[0]!;
    assert.notEqual(record.abort_request, null, "the operator request survives until the abort is truly verified");
    assert.ok(record.history.some((entry) => entry.type === "run-abort-uncertain"));
    assert.ok(!record.history.some((entry) => entry.type === "run-aborted"), "a pending v1 permission is never a false clear");
  } finally {
    await cleanup();
  }
});

test("engine: missing or non-idle post-abort coverage holds without clearing the request", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.abortState = "aborted";
    state.abortPendingAfter = null;
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.abort_request = { requested_at: new Date(0).toISOString(), reason: "operator-request" };
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "recovery-parked");
    let snapshot = await readRegistrySnapshot(project);
    assert.notEqual(snapshot.registry.monitors[0]!.abort_request, null, "missing coverage must not clear the request");
    assert.ok(!snapshot.registry.monitors[0]!.history.some((entry) => entry.type === "run-aborted"));
    state.abortPendingAfter = { permissions: 0, questions: 0 };
    state.abortActivityAfter = "busy";
    snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.monitors[0]!.run.active, false);
    assert.equal(await engine.tick(), "recovery-parked");
    snapshot = await readRegistrySnapshot(project);
    assert.notEqual(snapshot.registry.monitors[0]!.abort_request, null, "non-idle activity after the abort keeps the request held");
    assert.ok(!snapshot.registry.monitors[0]!.history.some((entry) => entry.type === "run-aborted"));
  } finally {
    await cleanup();
  }
});

test("engine: MANAGEMENT priming is sent once, later wakes stay short and single-message", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const created = defaultMonitorRecord("M", TASK, {}, 100_000);
      created.scheduler.next_run_at = 0;
      registry.monitors.push(created);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    assert.equal(state.sends.length, 1, "priming plus mission is one admitted message, never two");
    const first = state.sends[0]!;
    assert.match(first, /\[MANAGEMENT-PRIMING mgmt-v3\]/);
    assert.match(first, /Role: MANAGEMENT/);
    assert.match(first, /coordinate, never implement/);
    assert.match(first, /drive the commissioned development actively to the agreed result/);
    assert.match(first, /pure status observation is not delivery/);
    assert.match(first, /Management decisions and control stay serial/);
    assert.match(first, /tool visibility is not authorization/);
    assert.match(first, /no technical enforcement, caller-identity proof or BLOCKED guarantee is claimed/);
    assert.match(first, /reuse ones verifiably created by you \(creation receipt\/registry identity, never the title\)/);
    assert.match(first, /never use native subtasks for management work/);
    assert.match(first, /Workers decide their own subtask use inside existing scope and permissions/);
    assert.match(first, /normal same-session follow-up once the actual decision exists/);
    assert.match(first, /pending security permission is never answered or bypassed/);
    assert.match(first, /create\/spawn or reprioritize board tasks, or self-authorize — recommend instead/);
    assert.match(first, /journal\/compact-context upkeep, additive non-authorizing notes/);
    assert.match(first, /Journal entries are appended only through the board's management-note interface/);
    assert.match(first, /never create, edit, chmod, replace or delete journal files under the board's management-journal directory/);
    assert.match(first, /report persistence unverified instead/);
    assert.ok(first.includes("wake duty loop") && first.includes("reconcile actual session/order states"), "wake duty loop missing");
    assert.ok(first.includes("synthesize key findings continuously"), "continuous synthesis duty missing");
    assert.match(first, /after secured handover archive finished own sessions and remove their context files per contract/);
    assert.match(first, /list_project_tasks, get_project_task links\/documents/);
    assert.match(first, /Sandbox covers the explicitly assigned test estate/);
    assert.match(first, /product source and semantics are out of scope/);
    assert.match(first, /Never bypass or auto-approve a real host\/security permission/);
    assert.match(first, /never write to this management session or its own monitor binding/);
    assert.match(first, /\[MONITOR-ACTION wake_/);
    assert.match(first, /bounded no-op/);
    // The optimized mission no longer forces a full canonical re-read each wake.
    assert.ok(!first.includes("read the actual canonical C/P"), "no per-tick full-document read instruction");
    assert.match(first, /open canonical C\/P only when a listed revision changed/);

    const primed = await readRegistrySnapshot(project);
    const digestValue = primed.registry.monitors[0]!.session.priming_digest;
    assert.equal(typeof digestValue, "string");
    assert.ok(primed.registry.monitors[0]!.history.some((entry) => entry.type === "manager-primed"));

    // Changed canonical state, unchanged priming context: short wake, no priming.
    state.taskUpdated = "2026-10-08T00:00:00.000Z";
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.scheduler.next_run_at = 0;
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    assert.equal(state.sends.length, 2);
    const second = state.sends[1]!;
    assert.ok(!second.includes("[MANAGEMENT-PRIMING"), "no full priming on every tick");
    assert.match(second, /^\[MONITOR-ACTION wake_/u);
    assert.ok(second.length < first.length, "the repeated wake stays materially shorter");
    const after = await readRegistrySnapshot(project);
    assert.equal(after.registry.monitors[0]!.session.priming_digest, digestValue, "digest unchanged without re-priming");
    assert.equal(after.registry.monitors[0]!.history.filter((entry) => entry.type === "manager-primed").length, 1);

    // A changed autonomy profile is a context change: re-prime exactly once.
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.autonomy_profile = "sandbox";
      registry.monitors[0]!.scheduler.next_run_at = 0;
      return registry;
    });
    state.taskUpdated = "2026-10-09T00:00:00.000Z";
    assert.equal(await engine.tick(), "dispatched");
    assert.match(state.sends[2]!, /\[MANAGEMENT-PRIMING mgmt-v3\]/);
    assert.match(state.sends[2]!, /Autonomy profile sandbox: apply its operator-contract scope/);
    const reprime = await readRegistrySnapshot(project);
    assert.notEqual(reprime.registry.monitors[0]!.session.priming_digest, digestValue);
  } finally {
    await cleanup();
  }
});

test("engine: compaction continuation repeats the MANAGEMENT role block once", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = okStatus({
      state: "failed",
      error_details: [{ category: "context_input_length", message: "Range of input length should be [1, 100]", detail_availability: "safe_template", source: "assistant_message_error", assistant_message_id: "msg_x", attribution: "exact_parent" }],
    });
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const created = defaultMonitorRecord("M", TASK, {}, 100_000);
      created.scheduler.next_run_at = 0;
      registry.monitors.push(created);
      return registry;
    });
    assert.equal(await engine.tick(), "compaction-continued");
    assert.equal(state.sends.length, 1, "exactly one admitted continuation");
    assert.match(state.sends[0]!, /\[MANAGEMENT-PRIMING mgmt-v3\]/);
    assert.match(state.sends[0]!, /\[MONITOR-COMPACT /);
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(typeof snapshot.registry.monitors[0]!.session.priming_digest, "string");
    assert.match(JSON.stringify(snapshot.registry.monitors[0]!.history.find((entry) => entry.type === "compaction-continued")!.detail), /"primed":true/);
  } finally {
    await cleanup();
  }
});

test("engine: wake prompt stays inside its token budget and names the bounded mission", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const created = defaultMonitorRecord("M", TASK, {}, 100_000);
      created.scheduler.next_run_at = 0;
      registry.monitors.push(created);
      return registry;
    });
    await engine.tick();
    const primedWake = state.sends[0]!;
    const mission = primedWake.slice(primedWake.indexOf("[MONITOR-ACTION"));
    // Budget guard: the recurring mission text stays small (~150 tokens). The one-time
    // priming block grew with the W1 mission/ownership/wake-duty rules (Contract
    // EFBE-MVP-IMPLEMENTATION-20261009-R1, decision W1-D2) and the mgmt-v3
    // journal-writer rule: bounded at ~1150 tokens, sent once per priming digest,
    // never per tick.
    assert.ok(mission.length <= 1100, `mission text grew to ${mission.length} characters`);
    assert.ok(primedWake.length - mission.length <= 5400, `priming block grew to ${primedWake.length - mission.length} characters`);
    for (const marker of ["Mission: 1) verify progress", "exactly ONE next permitted step", "bounded no-op", "INPUT_REQUIRED only for a real missing decision",
      "already-authorized viable alternatives", "never synthesize YOLO/reset/delete/security approvals"]) {
      assert.ok(mission.includes(marker), `mission marker missing: ${marker}`);
    }
  } finally {
    await cleanup();
  }
});

test("engine: a session rebind inside the same wake primes the brand-new session immediately", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const created = defaultMonitorRecord("M", TASK, {}, 100_000);
      created.scheduler.next_run_at = 0;
      registry.monitors.push(created);
      return registry;
    });
    // First wake: session is created and primed in one admitted message.
    assert.equal(await engine.tick(), "dispatched");
    assert.equal(state.sends.length, 1);
    assert.match(state.sends[0]!, /\[MANAGEMENT-PRIMING mgmt-v3\]/);
    const primed = await readRegistrySnapshot(project);
    assert.equal(primed.registry.monitors[0]!.session.session_id, "ses_monitor");
    assert.equal(typeof primed.registry.monitors[0]!.session.priming_digest, "string");

    // The bound session is lost; the engine rebinds during the next wake.
    state.lostSessionId = "ses_monitor";
    state.createdSessionId = "ses_rebound";
    state.taskUpdated = "2026-10-09T00:00:00.000Z";
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.scheduler.next_run_at = 0;
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    assert.equal(state.sends.length, 2, "the rebind wake admits exactly one message");
    assert.match(state.sends[1]!, /\[MANAGEMENT-PRIMING mgmt-v3\]/,
      "the brand-new empty session receives the role block in the same wake, not one interval later");
    assert.match(state.sends[1]!, /\[MONITOR-ACTION wake_/);
    const rebound = await readRegistrySnapshot(project);
    assert.equal(rebound.registry.monitors[0]!.session.session_id, "ses_rebound");
    assert.equal(typeof rebound.registry.monitors[0]!.session.priming_digest, "string");
    assert.equal(rebound.registry.monitors[0]!.history.filter((entry) => entry.type === "manager-primed").length, 2);
    assert.equal(rebound.registry.monitors[0]!.history.filter((entry) => entry.type === "session-primed").length, 2);

    // With the rebound session healthy and the context unchanged, no re-priming.
    state.lostSessionId = null;
    state.taskUpdated = "2026-10-10T00:00:00.000Z";
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.scheduler.next_run_at = 0;
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    assert.ok(!state.sends[2]!.includes("[MANAGEMENT-PRIMING"), "no repeated priming for the same context");
    const after = await readRegistrySnapshot(project);
    assert.equal(after.registry.monitors[0]!.history.filter((entry) => entry.type === "manager-primed").length, 2);
  } finally {
    await cleanup();
  }
});

test("W2 naming: worker ordinals roll A..Z then AA.. and manager aliases are M<high-water>", () => {
  assert.equal(managerAliasFor(1), "M1");
  assert.equal(managerAliasFor(12), "M12");
  assert.equal(workerAliasFor("M1", 1), "M1-A");
  assert.equal(workerAliasFor("M1", 26), "M1-Z");
  assert.equal(workerAliasFor("M1", 27), "M1-AA");
  assert.equal(workerAliasFor("M1", 28), "M1-AB");
  assert.equal(workerAliasFor("M1", 52), "M1-AZ");
  assert.equal(workerAliasFor("M1", 53), "M1-BA");
  assert.throws(() => workerAliasFor("bad", 1), /invalid manager alias/);
  assert.throws(() => workerAliasFor("M1", 0), /invalid worker alias ordinal/);
});

test("W2 identity: monotonic manager and worker aliases never reuse codes under concurrency", async () => {
  const { project, cleanup } = await setup();
  try {
    await withRegistry(project, (registry) => {
      registry.monitors.push(defaultMonitorRecord("One", TASK, {}, 1000));
      registry.monitors.push(defaultMonitorRecord("Two", TASK, {}, 1000));
      return registry;
    });
    const snapshot = await readRegistrySnapshot(project);
    const [a, b] = snapshot.registry.monitors;
    assert.equal((await assignMonitorAlias(project, a!.id, { now: 1000 })).alias, "M1");
    assert.equal((await assignMonitorAlias(project, b!.id, { now: 1000 })).alias, "M2");
    // Stable identity: re-assignment keeps the same alias and does not advance the high-water.
    assert.equal((await assignMonitorAlias(project, a!.id, { now: 1100 })).alias, "M1");
    const reservations = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        reserveWorker(project, a!.id, { runtime_session_id: `ses_${index}` }, { now: 1200 }),
      ),
    );
    assert.deepEqual(
      reservations.map((entry) => entry.alias).sort(),
      ["M1-A", "M1-B", "M1-C", "M1-D", "M1-E"],
    );
    assert.equal(new Set(reservations.map((entry) => entry.worker_key)).size, 5);
    const stored = await listWorkers(project, a!.id);
    assert.equal(stored.length, 5);
    assert.equal(new Set(stored.map((entry) => entry.alias)).size, 5);
    assert.equal(new Set(stored.map((entry) => entry.worker_key)).size, 5);
    // The second monitor keeps its own ordinal namespace and worker high-water.
    const bReservation = await reserveWorker(project, b!.id, {}, { now: 1300 });
    assert.equal(bReservation.alias, "M2-A");
  } finally {
    await cleanup();
  }
});

test("W2 CAS: a pinned generation rejects a racing reservation", async () => {
  const { project, cleanup } = await setup();
  try {
    await withRegistry(project, (registry) => {
      registry.monitors.push(defaultMonitorRecord("One", TASK, {}, 1000));
      return registry;
    });
    const id = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    await assert.rejects(
      reserveWorker(project, id, {}, { expected: 0, now: 1000 }),
      /changed concurrently/,
    );
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.monitors[0]!.workers, undefined);
  } finally {
    await cleanup();
  }
});

test("W2 workers: reserve-before-create, uncertain reconcile, foreign refusal, reuse/rebind, taskless context", async () => {
  const { project, cleanup } = await setup();
  try {
    await withRegistry(project, (registry) => {
      registry.monitors.push(defaultMonitorRecord("One", TASK, {}, 1000));
      registry.monitors.push(defaultMonitorRecord("Two", TASK, {}, 1000));
      return registry;
    });
    const snapshot = await readRegistrySnapshot(project);
    const [a, b] = snapshot.registry.monitors;

    // Reserve (taskless) an identity and context path before any non-idempotent create.
    const reservation = await reserveWorker(project, a!.id, { scope: "W2", worktree: "/wt" }, { now: 1000 });
    assert.equal(reservation.alias, "M1-A");
    assert.equal(
      reservation.context_path,
      join(monitorWorkersDirectory(project), a!.id, `${reservation.worker_key}.md`),
    );
    assert.equal(reservation.context_path, monitorWorkerContextPath(project, a!.id, reservation.worker_key));
    const reserved = await getWorker(project, a!.id, reservation.worker_key);
    assert.equal(reserved?.lifecycle, "reserved");
    assert.equal(reserved?.task_id, null);
    assert.equal(reserved?.creation_receipt, null);

    // Foreign negatives: another monitor cannot read or mutate this worker by key.
    assert.equal(await getWorker(project, b!.id, reservation.worker_key), null);
    await assert.rejects(
      confirmWorkerCreation(project, b!.id, reservation.worker_key, { runtime_session_id: "ses_x", creation_receipt: "msg_x" }),
      /worker not found/,
    );

    // Uncertain create resolved absent -> archived, never a second create attempt.
    const uncertain = await reserveWorker(project, a!.id, {}, { now: 1100 });
    const reconciledAbsent = await reconcileWorkerCreate(project, a!.id, uncertain.worker_key, { outcome: "absent" }, { now: 1200 });
    assert.equal(reconciledAbsent.lifecycle, "archived");
    assert.equal(reconciledAbsent.runtime_session_id, null);

    // Confirmed create records the real runtime + receipt and cannot be re-confirmed.
    const active = await confirmWorkerCreation(
      project,
      a!.id,
      reservation.worker_key,
      { runtime_session_id: "ses_worker_1", creation_receipt: "msg_create_1" },
      { now: 1300 },
    );
    assert.equal(active.lifecycle, "active");
    assert.equal(active.runtime_session_id, "ses_worker_1");
    assert.equal(active.creation_receipt, "msg_create_1");
    await assert.rejects(
      confirmWorkerCreation(project, a!.id, reservation.worker_key, { runtime_session_id: "ses_dup", creation_receipt: "m" }),
      /already resolved/,
    );

    // Uncertain create resolved present -> active with the observed receipt.
    const uncertainPresent = await reserveWorker(project, a!.id, {}, { now: 1400 });
    const reconciledCreated = await reconcileWorkerCreate(
      project,
      a!.id,
      uncertainPresent.worker_key,
      { outcome: "created", runtime_session_id: "ses_worker_2", creation_receipt: "msg_create_2" },
      { now: 1500 },
    );
    assert.equal(reconciledCreated.lifecycle, "active");
    assert.equal(reconciledCreated.creation_receipt, "msg_create_2");
    await assert.rejects(
      reconcileWorkerCreate(project, a!.id, uncertainPresent.worker_key, { outcome: "absent" }),
      /already resolved/,
    );

    // Reset/rebind: the lost runtime reference is replaced on the same stable identity.
    const rebound = await rebindWorker(
      project,
      a!.id,
      reservation.worker_key,
      { runtime_session_id: "ses_worker_1b", dispatch_receipt: "msg_dispatch_1" },
      { now: 1600 },
    );
    assert.equal(rebound.lifecycle, "active");
    assert.equal(rebound.runtime_session_id, "ses_worker_1b");
    assert.equal(rebound.worker_key, reservation.worker_key);
    assert.equal(rebound.alias, reservation.alias);

    // Synthesis, idle, then own-worker reuse keeps alias/key.
    await setWorkerSynthesis(project, a!.id, reservation.worker_key, "2026-10-09T14:10:00.000Z", { now: 1700 });
    assert.equal((await getWorker(project, a!.id, reservation.worker_key))?.last_synthesis_at, "2026-10-09T14:10:00.000Z");
    assert.equal((await setWorkerLifecycle(project, a!.id, reservation.worker_key, "idle", { now: 1800 })).lifecycle, "idle");
    const reused = await reuseWorker(project, a!.id, reservation.worker_key, { runtime_session_id: "ses_worker_1c" }, { now: 1900 });
    assert.equal(reused.lifecycle, "active");
    assert.equal(reused.runtime_session_id, "ses_worker_1c");
    assert.equal(reused.alias, reservation.alias);
    assert.ok(reused.last_synthesis_at);

    // Archive lifecycle on the absent-resolved worker.
    assert.equal((await setWorkerLifecycle(project, a!.id, uncertain.worker_key, "archived", { now: 2000 })).lifecycle, "archived");

    // Manager context layout mirrors worker contexts under the ignored directory.
    assert.equal(monitorManagerContextPath(project, a!.id), join(monitorWorkersDirectory(project), a!.id, "manager.md"));

    // Full readback keeps all three distinct aliases and stable keys.
    const workers = await listWorkers(project, a!.id);
    assert.deepEqual(workers.map((entry) => entry.alias), ["M1-A", "M1-B", "M1-C"]);
    assert.deepEqual(workers.map((entry) => entry.lifecycle), ["active", "archived", "active"]);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Welle A (task_be951293): receipt-correlated failed-worker observation,
// idempotent marking with exactly one digest wake per terminal error, honest
// holds without provider routing, and bounded safe decision logging.
// ---------------------------------------------------------------------------

function failedDetail(category: CorrelatedErrorDetail["category"], messageId = "msg_err"): CorrelatedErrorDetail {
  return {
    category,
    message: `boom ${category}`,
    detail_availability: "safe_template",
    source: "assistant_message_error",
    assistant_message_id: messageId,
    attribution: "exact_parent",
  };
}

type WaveASeed = {
  monitorId: string;
  workerKey: string;
  logs: string[];
  engineFactory: (now: number) => MonitorEngine;
};

async function seedMonitorWithDispatchedWorker(
  project: string,
  gateway: MonitorGatewayLike,
  board: MonitorBoardLike,
  at: number,
): Promise<WaveASeed> {
  const logs: string[] = [];
  const engineFactory = (now: number) =>
    new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, log: (_level, message) => logs.push(message) });
  await withRegistry(project, (registry) => {
    const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, at);
    monitor.scheduler.next_run_at = 0;
    monitor.state.last_seen_digest = "different";
    registry.monitors.push(monitor);
    return registry;
  });
  assert.equal(await engineFactory(at).tick(), "dispatched");
  const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
  const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: at + 400 });
  await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: at + 500 });
  await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: at + 600 });
  return { monitorId, workerKey: reserved.worker_key, logs, engineFactory };
}

async function advanceDue(project: string, now: number): Promise<void> {
  await withRegistry(project, (registry) => {
    registry.monitors[0]!.scheduler.next_run_at = now - 1;
    return registry;
  });
}

test("Welle A: a correlated terminal failure marks idle+last_error, moves the digest, wakes the manager exactly once and re-observation stays idempotent", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithDispatchedWorker(project, gateway, board, 100_000);
    const failedWorker = okStatus({
      session_id: "ses_worker",
      state: "failed",
      assistant_message_ids: ["msg_err"],
      error_details: [failedDetail("provider_timeout")],
    });
    state.statusFor = (sessionId, messageId) =>
      sessionId === "ses_worker" && messageId === "msg_dispatch"
        ? failedWorker
        : okStatus({ session_id: sessionId, state: "unknown" });

    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "dispatched");
    assert.equal(state.sends.length, 2, "the failed worker reaches the manager as a wake");
    assert.ok(state.statusCalls.some((call) => call.session_id === "ses_worker" && call.message_id === "msg_dispatch"),
      "observation correlates through the worker's own dispatch receipt");
    const after = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const worker = after.workers!.find((entry) => entry.worker_key === seed.workerKey)!;
    const evidence = classifyEvidence(failedWorker);
    assert.equal(worker.lifecycle, "idle", "conservative idle plus additive marker, no new enum value");
    assert.equal(worker.result_receipt, "msg_err");
    assert.deepEqual(worker.last_error, {
      at: new Date(200_000).toISOString(),
      category: "provider_timeout",
      fingerprint: evidence.kind === "blocked" ? evidence.fingerprint : "unreachable",
      receipt: "msg_err",
    });
    assert.ok(after.history.some((entry) => entry.type === "worker-observed-failed"
      && (entry.detail as { category?: string }).category === "provider_timeout"));
    assert.ok(seed.logs.some((line) => line.includes("worker terminal failure observed") && line.includes("provider_timeout")));
    assert.match(state.sends[1]!, /M1-A:idle!provider_timeout/, "the wake prompt names the failure evidence");

    // Re-observation: the marked worker left the candidate set; the digest is
    // stable, the wake never repeats and the marker is never rewritten.
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "noop-unchanged");
    assert.equal(state.sends.length, 2, "the same terminal error wakes exactly once");
    const again = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const sameWorker = again.workers!.find((entry) => entry.worker_key === seed.workerKey)!;
    assert.equal(sameWorker.updated_at, worker.updated_at, "repeated observation does not rewrite the marker");
    // be951293 gate fix: the first unchanged tick after the wake settles the
    // wake's own dispatch receipt (one healthy receipt observation) before the
    // canonical no-op merge takes over on the following tick.
    const settleEntries = again.history.filter((entry) => entry.type === "noop-unchanged"
      && (entry.detail as { reason?: string }).reason === "receipt-observed-healthy");
    assert.equal(settleEntries.length, 1, "the settled receipt names its own cause");
    assert.equal(again.state.receipt_observation?.receipt, "msg_" + "a".repeat(32));
  } finally {
    await cleanup();
  }
});

test("Welle A: a foreign turn's failure is never attributed — the worker session is only consulted correlated with its own dispatch receipt and a non-terminal result holds without marking or wake", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithDispatchedWorker(project, gateway, board, 100_000);
    const failedForeign = okStatus({
      session_id: "ses_worker",
      state: "failed",
      assistant_message_ids: ["msg_foreign"],
      error_details: [failedDetail("provider_error", "msg_foreign")],
    });
    state.statusFor = (sessionId, messageId) =>
      messageId === "msg_dispatch"
        ? okStatus({ session_id: sessionId, state: "unknown", task_status_reason: "outside_history_or_not_observed" })
        : failedForeign;
    // The rebind itself is a worker delta and wakes (unchanged W4 semantics).
    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "dispatched");
    assert.equal(state.sends.length, 2);
    // A later tick with no new delta: the foreign failure alone must not mark
    // and must not wake.
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "noop-unchanged");
    assert.equal(state.sends.length, 2, "the foreign turn's failure produced no additional wake");
    assert.ok(state.statusCalls.every((call) => call.session_id !== "ses_worker" || call.message_id === "msg_dispatch"),
      "the worker session is never consulted without its own dispatch receipt");
    const after = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const worker = after.workers!.find((entry) => entry.worker_key === seed.workerKey)!;
    assert.equal(worker.lifecycle, "active");
    assert.equal(worker.last_error, null, "a foreign failed turn is never marked as this worker's error");
    const held = after.history.filter((entry) => entry.type === "worker-observe-held");
    assert.equal(held.length, 1);
    assert.equal((held[0]!.detail as { reason?: string }).reason, "turn-not-attributable");
    assert.equal((held[0]!.detail as { evidence?: string }).evidence, "outside_history_or_not_observed");
    assert.equal(state.updates.length, 0, "holding on unclear evidence is never provider routing");
  } finally {
    await cleanup();
  }
});

test("Welle A: unknown-category evidence marks as observation only with no provider routing; aborted, bare-failed and pending turns hold with a named reason and merge their streak", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithDispatchedWorker(project, gateway, board, 100_000);
    // 1) terminal unknown failure -> marked once, ordinary synthesis wake, NO runtime switch.
    state.statusFor = () => okStatus({
      session_id: "ses_worker",
      state: "failed",
      assistant_message_ids: ["msg_u"],
      error_details: [failedDetail("unknown", "msg_u")],
    });
    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "dispatched");
    const marked = await getWorker(project, seed.monitorId, seed.workerKey);
    assert.equal(marked?.lifecycle, "idle");
    assert.equal(marked?.last_error?.category, "unknown");
    assert.ok(marked?.last_error?.fingerprint, "unknown-category terminal failure keeps its evidence fingerprint");
    assert.equal(state.updates.length, 0, "wave A observation never routes providers");
    assert.ok(!state.sends[1]!.includes("[MONITOR-RECOVERY"), "the wake stays a normal synthesis wake");

    // 2) new episodes: aborted, failed-without-error-evidence and pending all hold honestly.
    const holdCases: Array<[SessionStatusResult, string]> = [
      [okStatus({ session_id: "ses_worker", state: "aborted" }), "turn-aborted"],
      [okStatus({ session_id: "ses_worker", state: "failed" }), "failed-without-error-evidence"],
      [okStatus({ session_id: "ses_worker", state: "input_required", pending_input: { permissions: 1, questions: 0 } }), "turn-input-required"],
    ];
    let caseIndex = 0;
    for (const [status, reason] of holdCases) {
      caseIndex += 1;
      await rebindWorker(project, seed.monitorId, seed.workerKey, { runtime_session_id: "ses_worker", dispatch_receipt: `msg_hold_${caseIndex}` }, { now: 210_000 + caseIndex * 1000 });
      state.statusFor = () => status;
      await advanceDue(project, 220_000 + caseIndex * 10_000);
      const engine = seed.engineFactory(220_000 + caseIndex * 10_000);
      assert.equal(await engine.tick(), "dispatched", `${reason}: the rebind delta still wakes`);
      const worker = await getWorker(project, seed.monitorId, seed.workerKey);
      assert.equal(worker?.lifecycle, "active", `${reason}: held, not marked`);
      assert.equal(worker?.last_error, null, `${reason}: reactivation cleared the previous episode marker (QC-F1) and the held state writes nothing`);
      const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
      const held = record.history.filter((entry) => entry.type === "worker-observe-held"
        && (entry.detail as { reason?: string }).reason === reason);
      assert.equal(held.length, 1, `${reason}: one bounded entry`);
      assert.equal(state.updates.length, 0, `${reason}: no provider routing`);
    }

    // 3) same state observed again without any delta: no wake, and the held streak
    //    merges into the existing single entry instead of appending per tick.
    const before = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const beforeHeld = before.history.filter((entry) => entry.type === "worker-observe-held").length;
    await advanceDue(project, 400_000);
    assert.equal(await seed.engineFactory(400_000).tick(), "noop-unchanged");
    const after = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(after.history.filter((entry) => entry.type === "worker-observe-held").length, beforeHeld, "repeats merge, no append");
    const merged = after.history.filter((entry) => entry.type === "worker-observe-held"
      && (entry.detail as { reason?: string }).reason === "turn-input-required");
    assert.equal(merged.length, 1);
    assert.equal((merged[0]!.detail as { count?: number }).count, 2);
    assert.equal(state.sends.length, 5, "no additional wake for the unchanged held state");
  } finally {
    await cleanup();
  }
});

test("Welle A: a worker status read failure names the safe code, merges across ticks and never fabricates an observation or a wake", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithDispatchedWorker(project, gateway, board, 100_000);
    state.statusFor = () => {
      throw Object.assign(new Error("token:supersecret https://private.example/x"), { code: "BACKEND_UNAVAILABLE" });
    };
    // The rebind delta from seeding wakes once; the read failure adds nothing.
    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "dispatched");
    assert.equal(state.sends.length, 2);
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "noop-unchanged");
    const first = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const errors = first.history.filter((entry) => entry.type === "worker-observe-error");
    assert.equal(errors.length, 1);
    assert.equal((errors[0]!.detail as { code?: string }).code, "BACKEND_UNAVAILABLE");
    assert.equal((errors[0]!.detail as { count?: number }).count, 2, "both observation attempts merged into one entry");
    assert.ok(!JSON.stringify(errors[0]).includes("supersecret"), "raw error text never reaches the registry");
    assert.ok(seed.logs.some((line) => line.includes("worker status read failed") && line.includes("BACKEND_UNAVAILABLE")));
    assert.ok(!seed.logs.join("\n").includes("supersecret"), "raw error text never reaches the service log");
    const worker = first.workers!.find((entry) => entry.worker_key === seed.workerKey)!;
    assert.equal(worker.lifecycle, "active", "unobservability stays unobservability");
    assert.equal(state.sends.length, 2, "the read failure itself fabricated no wake");

    await advanceDue(project, 400_000);
    assert.equal(await seed.engineFactory(400_000).tick(), "noop-unchanged");
    const second = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const merged = second.history.filter((entry) => entry.type === "worker-observe-error");
    assert.equal(merged.length, 1, "repeated same-key failures merge into one bounded entry");
    assert.equal((merged[0]!.detail as { count?: number }).count, 3);
    assert.equal((merged[0]!.detail as { first_at?: string }).first_at, (errors[0]!.detail as { first_at?: string }).first_at);
    assert.equal((merged[0]!.detail as { last_at?: string }).last_at, new Date(400_000).toISOString());
  } finally {
    await cleanup();
  }
});

test("Welle A registry compatibility: legacy records stay valid, unknown additive fields survive round-trips, a malformed marker fails closed and decisions stay bounded", async () => {
  const { project, cleanup } = await setup();
  try {
    await withRegistry(project, (registry) => {
      registry.monitors.push(defaultMonitorRecord("M", TASK, {}, 1000));
      return registry;
    });
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    // Legacy-shaped worker record (no last_error at all) loads and digests normally.
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 1000 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_c" }, { now: 1100 });
    const legacy = await readRegistrySnapshot(project);
    assert.equal(legacy.registry.monitors[0]!.workers![0]!.last_error, undefined);
    assert.match(workerIndexDigest(legacy.registry.monitors[0]!), /^[0-9a-f]{64}$/);

    // Purely additive: an unknown future field passes validation and survives mutation round-trips.
    const rawPath = monitorRegistryPath(project);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    raw.monitors[0].workers[0].zz_future_field = { whatever: 1 };
    await writeFile(rawPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    const tolerated = await readRegistrySnapshot(project);
    assert.deepEqual(
      (tolerated.registry.monitors[0]!.workers![0] as unknown as { zz_future_field?: unknown }).zz_future_field,
      { whatever: 1 },
    );
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.title = "M2";
      return registry;
    });
    const roundTripped = await readRegistrySnapshot(project);
    assert.deepEqual(
      (roundTripped.registry.monitors[0]!.workers![0] as unknown as { zz_future_field?: unknown }).zz_future_field,
      { whatever: 1 },
      "additive unknown fields survive a serialized mutation",
    );

    // A corrupt additive marker fails closed like any other corrupted registry data.
    const corrupted = JSON.parse(await readFile(rawPath, "utf8"));
    corrupted.monitors[0].workers[0].last_error = { category: "provider_timeout" };
    await writeFile(rawPath, JSON.stringify(corrupted, null, 2) + "\n", { mode: 0o600 });
    await assert.rejects(readRegistrySnapshot(project), /invalid monitor registry/);

    // monitorDecision: same-key streaks merge with first/last/count visible, history stays bounded.
    const record = defaultMonitorRecord("B", TASK, {}, 1000);
    for (let i = 0; i < 3; i += 1) monitorDecision(record, "noop-unchanged", { reason: "x" }, "noop-unchanged", 2000 + i);
    assert.equal(record.history.length, 1);
    assert.equal((record.history[0]!.detail as { count?: number }).count, 3);
    assert.equal((record.history[0]!.detail as { first_at?: string }).first_at, new Date(2000).toISOString());
    assert.equal((record.history[0]!.detail as { last_at?: string }).last_at, new Date(2002).toISOString());
    for (let i = 0; i < MONITOR_HISTORY_LIMIT + 120; i += 1) monitorDecision(record, "held", { i }, `held:${i}`, 3000 + i);
    assert.ok(record.history.length <= MONITOR_HISTORY_LIMIT, `history grew to ${record.history.length}`);
  } finally {
    await cleanup();
  }
});

test("Welle A: concurrent-wake and no-due ticks name themselves once with bounded streak lines and unchanged outcomes", async () => {
  const { project, cleanup } = await setup();
  try {
    const logs: string[] = [];
    const state = baseState();
    const { gateway, board } = fakes(state);
    let nowMs = 100_000;
    const quiet = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => nowMs, log: (_level, message) => logs.push(message) });
    for (let i = 0; i < 59; i += 1) {
      assert.equal(await quiet.tick(), "no-due");
      nowMs += 60_000;
    }
    assert.equal(logs.filter((line) => line.includes("no-due: no enabled monitor due")).length, 1, "first no-due names itself once");
    assert.equal(logs.filter((line) => line.includes("wake no-due streak")).length, 0, "streak stays quiet below the bound");
    assert.equal(await quiet.tick(), "no-due");
    assert.equal(logs.filter((line) => line.includes("wake no-due streak: 60 ticks")).length, 1, "one bounded streak line at the bound");

    // Concurrent wake: the first tick is parked inside the canonical read.
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const originalGetTask = board.getTask.bind(board);
    let gated = false;
    board.getTask = async (taskId: string) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return originalGetTask(taskId);
    };
    const busy = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 500_000, log: (_level, message) => logs.push(message) });
    const first = busy.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await busy.tick(), "skipped", "the concurrent call remains single-flight");
    releaseGate();
    assert.equal(await first, "dispatched");
    assert.equal(logs.filter((line) => line.includes("wake tick skipped")).length, 1, "the silent concurrent-skip path is now named");
  } finally {
    await cleanup();
  }
});

test("Welle A QC-F1: reuseWorker and rebindWorker clear last_error — a stale category never renders as the new dispatch's current error", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithDispatchedWorker(project, gateway, board, 100_000);
    const failedWorker = okStatus({
      session_id: "ses_worker",
      state: "failed",
      assistant_message_ids: ["msg_err"],
      error_details: [failedDetail("provider_timeout")],
    });
    state.statusFor = () => failedWorker;
    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "dispatched");
    const marked = await getWorker(project, seed.monitorId, seed.workerKey);
    assert.equal(marked?.lifecycle, "idle");
    assert.equal(marked?.last_error?.category, "provider_timeout");
    assert.match(state.sends.at(-1)!, /M1-A:idle!provider_timeout/, "the marked episode renders the failure");

    // Reuse reactivates: the previous episode's marker is cleared to null.
    await reuseWorker(project, seed.monitorId, seed.workerKey, { runtime_session_id: "ses_worker" }, { now: 210_000 });
    const reused = await getWorker(project, seed.monitorId, seed.workerKey);
    assert.equal(reused?.lifecycle, "active");
    assert.equal(reused?.last_error, null, "reactivation never keeps the old error as the current one");

    // Rebind (new dispatch) also clears, and the next wake prompt renders the
    // fresh active episode WITHOUT the stale category.
    state.statusFor = () => okStatus({ session_id: "ses_worker", state: "running", backend_activity: "busy" });
    await rebindWorker(project, seed.monitorId, seed.workerKey, { runtime_session_id: "ses_new", dispatch_receipt: "msg_d2" }, { now: 220_000 });
    const rebound = await getWorker(project, seed.monitorId, seed.workerKey);
    assert.equal(rebound?.lifecycle, "active");
    assert.equal(rebound?.last_error, null);
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "dispatched", "the rebind delta wakes");
    assert.match(state.sends.at(-1)!, /M1-A:active@ses_new/, "fresh dispatch renders without any error marker");
    assert.ok(!state.sends.at(-1)!.includes("!provider_timeout"), "no stale category in the wake prompt");
    // The earlier observation stays auditable in history, not on the live record.
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.ok(record.history.some((entry) => entry.type === "worker-observed-failed"));
  } finally {
    await cleanup();
  }
});

test("Welle A QC-F2: noop merge keys are cause-specific — different causes keep separate entries and per-cause counts", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, log: () => undefined });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      registry.monitors.push(monitor);
      return registry;
    });
    // Prime once (real digest stored), then the receipt settles on the first
    // unchanged tick (be951293 gate fix, own cause-specific entry) and the two
    // following digest-gate no-ops merge into ONE canonical cause entry.
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await engineFactory(200_000).tick(), "noop-unchanged");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await engineFactory(300_000).tick(), "noop-unchanged");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await engineFactory(400_000).tick(), "noop-unchanged");
    const merged = await readRegistrySnapshot(project);
    const noopEntries = merged.registry.monitors[0]!.history.filter((entry) => entry.type === "noop-unchanged");
    assert.equal(noopEntries.length, 2, "the receipt settlement and the canonical cause stay separate entries");
    const settleEntry = noopEntries.find((entry) => (entry.detail as { reason?: string }).reason === "receipt-observed-healthy")!;
    assert.ok(settleEntry, "the settlement names its receipt cause");
    const canonicalEntry0 = noopEntries.find((entry) => (entry.detail as { reason?: string }).reason === "canonical-and-worker-index-unchanged")!;
    assert.equal((canonicalEntry0.detail as { count?: number }).count, 2);
    assert.equal((canonicalEntry0.detail as { merge?: string }).merge, "noop-unchanged:canonical-and-worker-index-unchanged",
      "the recorded merge key names its cause");

    // A different cause must land in a SEPARATE entry and must not inflate or
    // mislabel the first one (Repro2 regression at the helper the engine uses).
    const record = merged.registry.monitors[0]!;
    monitorDecision(record, "noop-unchanged", { reason: "runtime-resolved-without-dispatch" }, "noop-unchanged:runtime-resolved-without-dispatch", 400_000);
    monitorDecision(record, "noop-unchanged", { reason: "canonical-and-worker-index-unchanged" }, "noop-unchanged:canonical-and-worker-index-unchanged", 500_000);
    const byCause = record.history.filter((entry) => entry.type === "noop-unchanged");
    assert.equal(byCause.length, 3, "causes never conflate into one mixed entry (settlement, canonical, runtime)");
    const canonicalEntry = byCause.find((entry) => (entry.detail as { reason?: string }).reason === "canonical-and-worker-index-unchanged")!;
    const runtimeEntry = byCause.find((entry) => (entry.detail as { reason?: string }).reason === "runtime-resolved-without-dispatch")!;
    assert.equal((canonicalEntry.detail as { count?: number }).count, 3, "only same-cause repeats increment");
    assert.equal((runtimeEntry.detail as { count?: number }).count, 1, "the other cause keeps its own count and reason");
    assert.equal((canonicalEntry.detail as { first_at?: string }).first_at, new Date(300_000).toISOString(), "first_at stays per cause");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Welle B (task_be951293): shared Schema-4 policy resolution in the engine —
// admission, persistent finite episodes, provider-skip evidence scope,
// Primary release, exhaustion hold and variant readback.
// ---------------------------------------------------------------------------

function blockedStatus(category: string, messageId = "msg_err"): SessionStatusResult {
  return okStatus({
    session_id: "ses_monitor",
    state: "failed",
    assistant_message_ids: [messageId],
    error_details: [failedDetail(category as CorrelatedErrorDetail["category"], messageId)],
  });
}

function perProfileView(profiles: Record<string, { provider_id: string; model_id: string; variant?: string } | null>, extras: {
  profileFallbacks?: Record<string, { provider_id: string; model_id: string; variant?: string } | null>;
  strategies?: { degrading: boolean | null; providerSkip: boolean | null };
  finalFallback?: { mode: "total" | "degrading"; selection: { provider_id: string; model_id: string; variant?: string } } | null;
  disabled?: { profiles?: Record<string, boolean>; profileFallbacks?: Record<string, boolean>; finalFallback?: boolean };
  revision?: number;
} = {}): MonitorPolicyView {
  const own = { deep: null, standard: null, execution: null, design: null, review: null, ...(extras.profileFallbacks ?? {}) };
  const strategies = extras.strategies ?? { degrading: null, providerSkip: null };
  const perProfile = Object.values(own).some((entry) => entry !== null) || strategies.degrading !== null || strategies.providerSkip !== null;
  return {
    finalFallback: extras.finalFallback ?? null,
    profiles: { deep: null, standard: null, execution: null, design: null, review: null, ...profiles },
    profileFallbacks: own,
    strategies,
    ...(extras.disabled ? {
      disabled: {
        profiles: { deep: false, standard: false, execution: false, design: false, review: false, ...(extras.disabled.profiles ?? {}) },
        profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false, ...(extras.disabled.profileFallbacks ?? {}) },
        finalFallback: extras.disabled.finalFallback ?? false,
      },
    } : {}),
    revision: extras.revision ?? 7,
    routing: perProfile
      ? { regime: "per_profile", legacy_final_stage_applies: false, strategies_effective: { degrading: strategies.degrading === true, provider_skip: strategies.providerSkip === true } }
      : { regime: "legacy_final_fallback", legacy_final_stage_applies: true, strategies_effective: { degrading: strategies.degrading === true, provider_skip: strategies.providerSkip === true } },
  };
}

function seededFailedMonitor(project: string, at = 100_000): Promise<string> {
  return withRegistry(project, (registry) => {
    const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, at);
    monitor.scheduler.next_run_at = 0;
    monitor.state.last_seen_digest = "different";
    registry.monitors.push(monitor);
    return registry;
  }).then((registry) => registry.monitors[0]!.id);
}

test("Welle B: per_profile own fallback dispatches exactly one admitted step; second wake exhausts visibly and parks without re-attempt", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_timeout");
    const { gateway, board } = fakes(state);
    const policy = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null }, { profileFallbacks: { deep: { provider_id: "deep-provider", model_id: "deep-fb" } } });
    await seededFailedMonitor(project);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000, log: () => undefined });
    assert.equal(await engine.tick(), "recovery-continued");
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0]!.model_id, "deep-fb");
    assert.equal(state.sends.length, 1);
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.recovery_episode?.attempts.length, 2, "current failure and dispatched fallback persisted in the episode");
    assert.deepEqual(record.recovery_episode?.attempts.map((entry) => entry.identity), ["deep-provider/deep-model", "deep-provider/deep-fb"]);
    assert.equal(record.recovery_episode?.attempts[1]!.outcome, "dispatched");
    const resolution = record.recovery_resolution?.at(-1)!;
    assert.equal(resolution.regime, "per_profile");
    assert.equal(resolution.selected_identity, "deep-provider/deep-fb");
    assert.ok(record.history.some((entry) => entry.type === "recovery-resolved"));
    // Still blocked next wake: the attempted fallback is NOT re-jumped; no other
    // candidate exists -> transparent park with visible reason (approved §4.6).
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000, log: () => undefined });
    assert.equal(await engine2.tick(), "recovery-parked");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required");
    assert.equal(record.state.parked_reason, "recovery-chain-exhausted");
    assert.equal(state.sends.length, 1, "exhaustion never dispatches a second message");
    assert.equal(state.updates.length, 1);
    assert.ok(record.history.some((entry) => entry.type === "recovery-chain-exhausted"
      && JSON.stringify(entry.detail).includes("deep-provider/deep-fb")));
    assert.equal(record.scheduler.enabled, true, "parking keeps the schedule");
    // Explicit operator trigger on the exhausted park restarts the episode (§4.6):
    // the parked state itself is the precondition, never an automatic reset.
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.wake_request = { requested_at: new Date(350_000).toISOString(), reason: "operator" };
      monitor.scheduler.next_run_at = 0;
      return registry;
    });
    const engine3 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 400_000, log: () => undefined });
    assert.equal(await engine3.tick(), "recovery-continued", "operator trigger is the one sanctioned episode restart");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.ok(record.history.some((entry) => entry.type === "recovery-episode-restarted"
      && (entry.detail as { operator_trigger?: boolean }).operator_trigger === true));
    assert.equal(state.updates.length, 2);
    // QC F-B1: the sanctioned resume must also lift its OWN recovery park.
    assert.equal(record.state.work, "active", "recovery-continued resumes the recovery park");
    assert.equal(record.state.parked_reason, undefined, "no stale park reason survives the resume");
    assert.ok(record.history.some((entry) => entry.type === "recovery-park-resumed"
      && (entry.detail as { resumed_from?: string }).resumed_from === "recovery-chain-exhausted"
      && (entry.detail as { via?: string }).via === "recovery-continued"));
    assert.equal(record.scheduler.enabled, true, "resume never touches the scheduler");
  } finally {
    await cleanup();
  }
});

test("Welle B: episodes survive a restart; a policy revision keeps failed identities and adds only new candidates", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_error");
    const { gateway, board } = fakes(state);
    const policyA = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null }, { profileFallbacks: { deep: { provider_id: "deep-provider", model_id: "deep-fb" } } });
    await seededFailedMonitor(project);
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policyA, now: () => 200_000 }).tick(), "recovery-continued");
    // "Adapter restart": a fresh engine instance reading only the registry.
    const policyB = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: { provider_id: "standard-provider", model_id: "standard-model" } }, {
      profileFallbacks: { deep: { provider_id: "deep-provider", model_id: "deep-fb" } }, strategies: { degrading: true, providerSkip: null }, revision: 8,
    });
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyB, now: () => 300_000 });
    assert.equal(await engine2.tick(), "recovery-continued", "the new permitted candidate is chosen");
    assert.equal(state.updates.at(-1)!.provider_id, "standard-provider");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const identities = record.recovery_episode!.attempts.map((entry) => entry.identity);
    assert.ok(identities.includes("deep-provider/deep-fb"), "the old failed identity was NOT forgotten by the revision");
    assert.equal(record.recovery_episode!.started_at, new Date(200_000).toISOString(), "same episode continues across the revision");
    assert.equal(record.recovery_episode!.policy_revision, 8);
  } finally {
    await cleanup();
  }
});

test("Welle B: a healthy wake closes the episode, the Primary is automatically retried without cooldown, and a later failure may start a fresh episode", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_timeout");
    const { gateway, board } = fakes(state);
    const policy = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" } }, { profileFallbacks: { deep: { provider_id: "fallback-provider", model_id: "fallback-model" } } });
    await seededFailedMonitor(project);
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000 }).tick(), "recovery-continued");
    // Fallback turn completes healthy; canonical change lets a normal wake run.
    state.status = okStatus();
    state.taskUpdated = "2026-10-10T00:00:00.000Z";
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000 }).tick(), "dispatched");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.recovery_episode, null, "success closes the episode");
    assert.ok(record.history.some((entry) => entry.type === "recovery-episode-closed" && (entry.detail as { reason?: string }).reason === "healthy-wake"));
    // The same healthy wake re-tried the current Primary automatically: NO cooldown,
    // no attempted filter on resolveRuntime (R1 scoping) — it switched back.
    assert.equal(state.runtime.provider_id, "deep-provider", "Primary return without cooldown on the first normal healthy wake");
    assert.equal(state.updates.at(-1)!.provider_id, "deep-provider");
    // A later normal wake on unchanged runtime performs no extra switch.
    state.taskUpdated = "2026-10-11T00:00:00.000Z";
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 400_000 }).tick(), "dispatched");
    assert.equal(state.runtime.provider_id, "deep-provider");
    // Primary fails again: a NEW episode may legitimately re-attempt the old fallback.
    state.status = blockedStatus("provider_quota");
    state.taskUpdated = "2026-10-12T00:00:00.000Z";
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 500_000 }).tick(), "recovery-continued");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.recovery_episode!.started_at, new Date(500_000).toISOString());
    assert.equal(state.updates.filter((entry) => entry.provider_id === "fallback-provider").length, 2, "permitted cycle re-tries after a proven success closed the old episode");
  } finally {
    await cleanup();
  }
});

test("Welle B: unknown and fachlich errors are honest named holds — no abort, no runtime update, no dispatch; the W2 budget keeps counting product failures", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("unknown");
    const { gateway, board } = fakes(state);
    const policy = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" } }, { profileFallbacks: { deep: { provider_id: "fallback-provider", model_id: "fallback-model" } } });
    await seededFailedMonitor(project);
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000 }).tick(), "recovery-parked");
    assert.equal(state.abortResults.length, 0, "a held non-admitted error is not aborted");
    assert.equal(state.updates.length, 0, "never provider routing without admission");
    assert.equal(state.sends.length, 0);
    const held = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.ok(held.history.some((entry) => entry.type === "recovery-held"
      && (entry.detail as { reason?: string }).reason === "no-provider-error-admission"
      && (entry.detail as { category?: string }).category === "unknown"));
    assert.equal(held.state.work, "active", "a hold does not park work");
    assert.equal(held.recovery_episode ?? null, null, "no episode opens without admission");
    // Fachlicher (production-code) failure: W2 budget accounting unchanged, still no routing.
    state.status = blockedStatus("work_failure");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000 }).tick(), "recovery-parked");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 400_000 }).tick(), "recovery-parked");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 500_000 }).tick(), "recovery-parked");
    const budgeted = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(budgeted.state.work, "parked_input_required");
    assert.equal(budgeted.state.parked_reason, "repair-budget-exhausted", "budget limits preserved (matrix J)");
    assert.equal(state.updates.length, 0, "still zero provider routing");
    assert.equal(state.sends.length, 0);
  } finally {
    await cleanup();
  }
});

test("Welle B: variant readback fails closed and the unverified full identity is never re-jumped inside the episode", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_timeout");
    state.dropVariant = true;
    const { gateway, board } = fakes(state);
    const policy = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" } }, { profileFallbacks: { deep: { provider_id: "fallback-provider", model_id: "fallback-model", variant: "high" } } });
    await seededFailedMonitor(project);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000 });
    assert.equal(await engine.tick(), "error");
    assert.equal(state.sends.length, 0, "never send under an unverified runtime");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.ok(record.history.some((entry) => entry.type === "recovery-update-unverified"));
    assert.equal(record.recovery_episode!.attempts.at(-1)!.identity, "fallback-provider/fallback-model/high");
    assert.equal(record.recovery_episode!.attempts.at(-1)!.outcome, "update_unverified");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000 }).tick(), "recovery-parked");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.parked_reason, "recovery-chain-exhausted", "the same provider/model/variant is not tried twice");
    assert.equal(state.updates.length, 1);
  } finally {
    await cleanup();
  }
});

test("Welle B: an uncertain recovery send is recorded, never blind-resent, and old records without episode fields load and gain them additively", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_auth");
    state.sendsFail = "SUBMISSION_UNCERTAIN";
    const { gateway, board } = fakes(state);
    const policy = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" } }, { profileFallbacks: { deep: { provider_id: "fallback-provider", model_id: "fallback-model" } } });
    const monitorId = await seededFailedMonitor(project);
    // Legacy check: the record was created WITHOUT recovery_episode/recovery_resolution fields.
    const raw = JSON.parse(await readFile(monitorRegistryPath(project), "utf8"));
    assert.equal("recovery_episode" in raw.monitors[0], false);
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000 }).tick(), "dispatch-uncertain");
    const after = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(after.state.work, "parked_input_required");
    assert.equal(after.state.parked_reason, "dispatch-uncertain");
    assert.equal(after.recovery_episode!.attempts.at(-1)!.outcome, "dispatch_uncertain", "uncertain admission is a recorded attempt");
    assert.equal(state.sends.length, 0);
    // Second wake reconciles the WAL FIRST — no second send of the recovery.
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000 }).tick(), "dispatch-uncertain");
    assert.equal(state.sends.length, 0, "never blindly resent");
    // QC F-B1: an uncertain park is NOT a sanctioned resume — the deliberate
    // dispatch-uncertain park must survive untouched.
    const still = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(still.state.work, "parked_input_required", "no false unpark on uncertain send");
    assert.equal(still.state.parked_reason, "dispatch-uncertain");
    assert.ok(still.recovery_episode, "the episode stays open across uncertainty");
    assert.ok(!still.history.some((entry) => entry.type === "recovery-park-resumed"), "foreign deliberate parks are never resumed by the hook");
    assert.ok(monitorId);
  } finally {
    await cleanup();
  }
});

test("Welle B: quota evidence with Provider-Skip ON bypasses the failing provider but keeps foreign-provider fallback usable", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_quota");
    const { gateway, board } = fakes(state);
    const policy = perProfileView(
      { deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: { provider_id: "fallback-provider", model_id: "fallback-model" } },
      {
        profileFallbacks: { deep: { provider_id: "deep-provider", model_id: "deep-fb" } },
        strategies: { degrading: true, providerSkip: true },
      },
    );
    await seededFailedMonitor(project);
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000 }).tick(), "recovery-continued");
    assert.equal(state.updates.at(-1)!.provider_id, "fallback-provider", "same-provider own fallback skipped on account-scope quota evidence");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const resolution = record.recovery_resolution!.at(-1)!;
    assert.deepEqual(resolution.candidates.map((entry) => entry.status), ["skipped_current_failure", "skipped_provider_scope", "selected"]);
    // Same configuration but a request-level timeout: no provider-wide skip.
    state.status = blockedStatus("provider_timeout");
    state.runtime = { provider_id: "deep-provider", model_id: "deep-model" };
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.recovery_episode = null;
      monitor.scheduler.next_run_at = 0;
      return registry;
    });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000 }).tick(), "recovery-continued");
    assert.equal(state.updates.at(-1)!.model_id, "deep-fb", "a single timeout never proves provider-wide failure");
  } finally {
    await cleanup();
  }
});

test("Welle B QC-F-B1: a policy-added candidate and a healthy close both lift only the engine's OWN recovery park, never the scheduler", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_timeout");
    const { gateway, board } = fakes(state);
    const policyOne = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" } }, {
      profileFallbacks: { deep: { provider_id: "fallback-provider", model_id: "fallback-model" } },
    });
    await seededFailedMonitor(project);
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policyOne, now: () => 200_000 }).tick(), "recovery-continued");
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policyOne, now: () => 300_000 }).tick(), "recovery-parked");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required");
    assert.equal(record.state.parked_reason, "recovery-chain-exhausted");
    // Policy change with a NEW permitted candidate resumes without any operator trigger.
    const policyTwo = perProfileView(
      { deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: { provider_id: "standard-provider", model_id: "standard-model" } },
      { profileFallbacks: { deep: { provider_id: "fallback-provider", model_id: "fallback-model" } }, strategies: { degrading: true, providerSkip: null }, revision: 8 },
    );
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policyTwo, now: () => 400_000 }).tick(), "recovery-continued");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "active", "the sanctioned policy resume lifts its own recovery park");
    assert.equal(record.state.parked_reason, undefined, "the stale exhaustion label is gone");
    assert.ok(record.history.some((entry) => entry.type === "recovery-park-resumed"
      && (entry.detail as { resumed_from?: string }).resumed_from === "recovery-chain-exhausted"
      && (entry.detail as { via?: string }).via === "recovery-continued"));
    assert.equal(record.recovery_episode!.started_at, new Date(200_000).toISOString(), "the continuing episode never ended");
    assert.ok(record.recovery_episode!.attempts.some((entry) => entry.identity === "deep-provider/deep-model"), "old failed identity retained");
    assert.ok(record.recovery_episode!.attempts.some((entry) => entry.identity === "fallback-provider/fallback-model"), "old failed identity retained");
    assert.equal(record.recovery_episode!.policy_revision, 8);
    // Healthy admitted normal dispatch closes the episode; no stale park remains.
    state.status = okStatus();
    state.taskUpdated = "2026-10-10T00:00:00.000Z";
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await new MonitorEngine({ project, gateway, board, readPolicy: async () => policyTwo, now: () => 500_000 }).tick(), "dispatched");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.recovery_episode, null);
    assert.equal(record.state.work, "active");
    assert.equal(record.state.parked_reason, undefined);
    assert.equal(record.scheduler.enabled, true, "resume never touches the scheduler");
  } finally {
    await cleanup();
  }
});

test("Welle B QC-F-B2: malformed recovery fields fail closed on read; null, legacy and valid records round-trip", async () => {
  const { project, cleanup } = await setup();
  try {
    await seededFailedMonitor(project);
    const path = monitorRegistryPath(project);
    const writeRaw = async (mutate: (raw: Record<string, unknown>) => void): Promise<void> => {
      const raw = JSON.parse(await readFile(path, "utf8"));
      mutate(raw);
      await writeFile(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    };
    const validAttempt = { at: "2026-10-10T00:00:00.000Z", identity: "p/m", category: "provider_timeout", fingerprint: "f".repeat(64), outcome: "dispatched" };
    const validEntry = { at: "2026-10-10T00:00:00.000Z", policy_revision: 3, regime: "per_profile", entry_profile: "deep", candidates: [{ label: "deep.main", identity: "p/m", status: "selected" }], selected_identity: "p/m", reason: "selected" };
    // A valid additive record loads and survives a serialized mutation round-trip.
    await writeRaw((raw) => {
      (raw.monitors as Record<string, unknown>[])[0]!.recovery_episode = { started_at: "2026-10-10T00:00:00.000Z", policy_revision: 3, attempts: [validAttempt] };
      (raw.monitors as Record<string, unknown>[])[0]!.recovery_resolution = [validEntry];
    });
    const ok = await readRegistrySnapshot(project);
    assert.equal(ok.registry.monitors[0]!.recovery_episode?.attempts[0]!.identity, "p/m");
    await withRegistry(project, (registry) => { registry.monitors[0]!.title = "M2"; return registry; });
    const roundTrip = await readRegistrySnapshot(project);
    assert.equal(roundTrip.registry.monitors[0]!.recovery_episode?.attempts.length, 1, "valid additive fields survive");
    // Explicit nulls (closed/absent semantics) stay valid.
    await writeRaw((raw) => {
      (raw.monitors as Record<string, unknown>[])[0]!.recovery_episode = null;
      (raw.monitors as Record<string, unknown>[])[0]!.recovery_resolution = null;
    });
    await readRegistrySnapshot(project);
    // Hand-corrupted shapes fail closed at read time, exactly like every other field.
    const malformed: Array<[string, (monitor: Record<string, unknown>) => void]> = [
      ["episode with bad started_at", (m) => { m.recovery_episode = { started_at: "yesterday", policy_revision: 1, attempts: [] }; }],
      ["episode attempts not an array", (m) => { m.recovery_episode = { started_at: "2026-10-10T00:00:00.000Z", policy_revision: 1, attempts: "nope" }; }],
      ["unknown attempt outcome", (m) => { m.recovery_episode = { started_at: "2026-10-10T00:00:00.000Z", policy_revision: 1, attempts: [{ ...validAttempt, outcome: "magic" }] }; }],
      ["short fingerprint", (m) => { m.recovery_episode = { started_at: "2026-10-10T00:00:00.000Z", policy_revision: 1, attempts: [{ ...validAttempt, fingerprint: "abc" }] }; }],
      ["attempts above the bound", (m) => { m.recovery_episode = { started_at: "2026-10-10T00:00:00.000Z", policy_revision: 1, attempts: Array.from({ length: RECOVERY_ATTEMPT_LIMIT + 1 }, () => ({ ...validAttempt })) }; }],
      ["resolution above the bound", (m) => { m.recovery_resolution = Array.from({ length: RECOVERY_RESOLUTION_LIMIT + 1 }, () => ({ ...validEntry })); }],
      ["unknown candidate status", (m) => { m.recovery_resolution = [{ ...validEntry, candidates: [{ label: "deep.main", identity: "p/m", status: "bogus" }] }]; }],
      ["unknown chain reason", (m) => { m.recovery_resolution = [{ ...validEntry, reason: "whatever" }]; }],
    ];
    for (const [label, mutate] of malformed) {
      await writeRaw((raw) => { mutate((raw.monitors as Record<string, unknown>[])[0]!); });
      await assert.rejects(readRegistrySnapshot(project), /invalid monitor registry/, label);
    }
    // Legacy records without the fields remain valid (pure additive compatibility).
    await writeRaw((raw) => {
      delete (raw.monitors as Record<string, unknown>[])[0]!.recovery_episode;
      delete (raw.monitors as Record<string, unknown>[])[0]!.recovery_resolution;
    });
    const legacy = await readRegistrySnapshot(project);
    assert.equal(legacy.registry.monitors[0]!.recovery_episode, undefined);
  } finally {
    await cleanup();
  }
});

test("Welle D AITL-Fixture (isoliert, §7): worker terminal failure -> ONE correlated synthesis wake; manager-only provider chain; exhaustion park; healthy release — every step left a truthful log trail", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithDispatchedWorker(project, gateway, board, 100_000);
    const workerReceipt = `msg_${"299062e8349b46bb9c700b4bbe034f40"}`;
    const policy = perProfileView(
      { deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: { provider_id: "standard-provider", model_id: "standard-model" } },
      { profileFallbacks: { deep: { provider_id: "deep-provider", model_id: "deep-fb" } }, strategies: { degrading: true, providerSkip: true }, revision: 12 },
    );
    const engineFor = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => now, log: (_level, message) => seed.logs.push(message) });
    // (1) the dedicated worker's OWN dispatched turn ends terminally failed
    state.statusFor = (sessionId, messageId) =>
      sessionId === "ses_worker" && messageId === "msg_dispatch"
        ? okStatus({ session_id: "ses_worker", state: "failed", assistant_message_ids: [workerReceipt],
            error_details: [failedDetail("provider_header_timeout", workerReceipt)] })
        : okStatus({ session_id: sessionId, state: "unknown" });
    await advanceDue(project, 110_000);
    assert.equal(await engineFor(110_000).tick(), "dispatched");
    assert.equal(state.sends.length, 2, "exactly one synthesis wake for the worker failure");
    assert.equal(state.updates.length, 0, "a worker failure NEVER starts manager provider routing");
    assert.ok(state.statusCalls.some((call) => call.session_id === "ses_worker" && call.message_id === "msg_dispatch"));
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const worker = record.workers!.find((entry) => entry.worker_key === seed.workerKey)!;
    assert.equal(worker.lifecycle, "idle");
    assert.equal(worker.result_receipt, workerReceipt, "exact receipt of the terminal failed turn persisted");
    assert.equal(worker.last_error?.receipt, workerReceipt);
    assert.equal(worker.last_error?.category, "provider_header_timeout");
    const observed = record.history.find((entry) => entry.type === "worker-observed-failed")!;
    assert.equal((observed.detail as { dispatch_receipt?: string }).dispatch_receipt, "msg_dispatch");
    assert.equal((observed.detail as { result_receipt?: string }).result_receipt, workerReceipt);
    assert.match(state.sends[1]!, /M1-A:idle!provider_header_timeout@ses_worker/);
    assert.ok(seed.logs.some((line) => line.includes("worker terminal failure observed") && line.includes(workerReceipt.slice(0, 20))));
    // (2) repeated observation never re-wakes
    await advanceDue(project, 120_000);
    assert.equal(await engineFor(120_000).tick(), "noop-unchanged");
    assert.equal(state.sends.length, 2);

    // (3) the MANAGER's own dispatched turn fails with quota — admitted provider routing
    state.status = blockedStatus("provider_quota", "msg_mgr_err");
    state.taskUpdated = "2026-10-10T10:00:00.000Z";
    await advanceDue(project, 130_000);
    assert.equal(await engineFor(130_000).tick(), "recovery-continued");
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0]!.provider_id, "standard-provider", "Provider-Skip bypassed the account-scope failing provider's own fallback");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const resolution = record.recovery_resolution!.at(-1)!;
    // Matrix A: engine-persisted resolution == what the shared resolver returns for identical inputs
    const direct = resolveRecoveryChain(policy, {
      entryProfile: "deep", catalog: runtimeOptions(), evidenceCategory: "provider_quota",
      evidenceProviderId: "deep-provider", attempted: ["deep-provider/deep-model"], currentIdentity: "deep-provider/deep-model",
    });
    assert.deepEqual(resolution.candidates.map((entry) => `${entry.label}=${entry.identity}=${entry.status}`),
      direct.candidates.map((entry) => `${entry.label}=${entry.identity}=${entry.status}`));
    assert.equal(resolution.selected_identity, direct.selected_identity);
    assert.equal(resolution.policy_revision, 12);
    // the manager status was correlated with its OWN dispatch receipt (WAL message id)
    const walMessage = record.dispatch_wal?.message_id;
    assert.ok(walMessage);
    assert.ok(state.statusCalls.some((call) => call.session_id === "ses_monitor" && call.message_id === walMessage));

    // (4) the fallback also fails with quota: the account-scope evidence now names
    //     standard-provider, so the wake first legitimately continues onto the
    //     remaining foreign-provider candidate (deep-fb) — no re-jump of attempted ids
    state.taskUpdated = "2026-10-10T11:00:00.000Z";
    await advanceDue(project, 140_000);
    assert.equal(await engineFor(140_000).tick(), "recovery-continued");
    assert.equal(state.updates.length, 2);
    assert.equal(state.updates[1]!.model_id, "deep-fb");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.deepEqual(record.recovery_episode!.attempts.map((entry) => entry.identity),
      ["deep-provider/deep-model", "standard-provider/standard-model", "deep-provider/deep-fb"]);
    // (5) still failing with deep-fb now current: every candidate is attempted,
    //     current or provider-scope — the finite chain exhausts visibly and parks
    state.taskUpdated = "2026-10-10T11:30:00.000Z";
    await advanceDue(project, 150_000);
    assert.equal(await engineFor(150_000).tick(), "recovery-parked");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required");
    assert.equal(record.state.parked_reason, "recovery-chain-exhausted");
    assert.equal(state.sends.length, 4, "exhaustion adds no second dispatch");
    assert.equal(state.updates.length, 2);
    assert.ok(record.history.some((entry) => entry.type === "recovery-chain-exhausted"
      && JSON.stringify(entry.detail).includes("standard-provider/standard-model")));

    // (6) healthy recovery of the manager session: episode closes, own park lifts,
    //     the next normal wake re-tries the Primary
    state.status = okStatus();
    state.taskUpdated = "2026-10-10T12:00:00.000Z";
    await advanceDue(project, 160_000);
    assert.equal(await engineFor(160_000).tick(), "dispatched");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.recovery_episode, null);
    assert.equal(record.state.work, "active");
    assert.equal(record.state.parked_reason, undefined);
    assert.equal(state.runtime.provider_id, "deep-provider", "Primary automatically re-tried without cooldown");
    assert.ok(record.history.some((entry) => entry.type === "recovery-episode-closed"));
    assert.ok(record.history.some((entry) => entry.type === "recovery-park-resumed"
      && (entry.detail as { resumed_from?: string }).resumed_from === "recovery-chain-exhausted"));
    // AITL symptom reversal: the once-empty trail is now complete and truthful
    for (const type of ["worker-observed-failed", "recovery-resolved", "recovery-chain-exhausted",
                        "recovery-park-resumed", "recovery-episode-closed"]) {
      assert.ok(record.history.some((entry) => entry.type === type), `missing decision entry ${type}`);
    }
    assert.ok(seed.logs.some((line) => line.includes("recovery park resumed")));
    assert.ok(seed.logs.some((line) => line.includes("recovery parked with visible reason=recovery-chain-exhausted")));
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// be951293 gate fix (2026-10-10): unchanged-board dispatch-receipt watch.
// The unchanged/no-op shortcut never re-read the manager session, so an
// admitted dispatch whose turn failed AFTER admission stayed invisible in a
// silent noop-unchanged loop (live AITL case). The watch observes each
// distinct receipt exactly once and reuses the existing evidence/recovery
// machinery; the tests below pin the fixed behavior and its convergence.

type GateSeed = {
  logs: string[];
  engineFactory: (now: number) => MonitorEngine;
  receipt: string;
};

/** Seeds a monitor whose board digest/worker digest are current (an admitted
 * wake dispatched `receipt` and nothing else happened since). */
async function seedMonitorWithAdmittedDispatch(
  project: string,
  gateway: MonitorGatewayLike,
  board: MonitorBoardLike,
  state: { taskStatus: string; taskUpdated: string },
  at: number,
): Promise<GateSeed> {
  const logs: string[] = [];
  const engineFactory = (now: number) =>
    new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, log: (_level, message) => logs.push(message) });
  const digestNow = digest({
    task: { id: TASK, status: state.taskStatus, updated: state.taskUpdated },
    checkpoint: "e1",
    newest: "e1",
    documents: [],
  });
  const receipt = "msg_" + "e".repeat(32);
  await withRegistry(project, (registry) => {
    const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, at);
    monitor.scheduler.next_run_at = 0;
    monitor.state.worker_digest = workerIndexDigest(monitor);
    monitor.state.last_seen_digest = digestNow;
    monitor.session = { session_id: "ses_monitor", title: "Monitor M", primed_at: new Date(at).toISOString(), priming_digest: "d".repeat(64) };
    monitor.dispatch_wal = { action_id: "wake_seed", at: new Date(at).toISOString(), prompt_digest: "p".repeat(64), message_id: receipt };
    registry.monitors.push(monitor);
    return registry;
  });
  return { logs, engineFactory, receipt };
}

test("gate fix: unchanged board plus correlated terminal manager provider failure recovers, follows the recovery receipt and settles healthy without a duplicate", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    state.abortState = "no_active_turn";
    const seed = await seedMonitorWithAdmittedDispatch(project, gateway, board, state, 100_000);
    state.status = okStatus({
      state: "failed",
      assistant_message_ids: ["msg_fail"],
      error_details: [failedDetail("provider_header_timeout", "msg_fail")],
    });

    // (1) the swallowed case now recovers through the existing chain machinery
    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "recovery-continued");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(state.sends.length, 1, "exactly one recovery continuation");
    assert.deepEqual(state.statusCalls.map((call) => call.message_id), [seed.receipt], "the watch correlates the failed dispatch receipt");
    assert.equal(state.runtime.provider_id, "fallback-provider", "chain switched to the configured fallback");
    assert.deepEqual(
      record.recovery_episode?.attempts.map((entry) => entry.identity),
      ["deep-provider/deep-model", "fallback-provider/fallback-model"],
    );
    assert.equal(record.state.receipt_observation, undefined, "an open recovery keeps the watch on the new receipt");
    assert.equal(record.dispatch_wal?.message_id, "msg_" + "a".repeat(32));

    // (2) recovery turn still running: bounded merged decision, no new dispatch
    state.status = okStatus({ backend_activity: "busy", state: "running" });
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "busy-held");
    assert.equal(state.sends.length, 1, "a running recovery is never re-sent");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const watch = record.history.filter((entry) => entry.type === "receipt-watch");
    assert.equal(watch.length, 1, "turn-active watch stays one merged decision entry");
    assert.equal((watch[0]!.detail as { count?: number }).count, 1);

    // (3) recovery receipt completed healthy: watch settles, episode closes
    state.status = okStatus();
    await advanceDue(project, 400_000);
    assert.equal(await seed.engineFactory(400_000).tick(), "noop-unchanged");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.deepEqual(record.state.receipt_observation, {
      receipt: "msg_" + "a".repeat(32),
      outcome: "healthy",
      at: new Date(400_000).toISOString(),
    });
    assert.equal(record.recovery_episode, null, "a healthy receipt closes the episode like a healthy wake");
    assert.ok(record.history.some((entry) => entry.type === "recovery-episode-closed"
      && (entry.detail as { reason?: string }).reason === "receipt-observed-healthy"));
    assert.equal(state.sends.length, 1);
    const statusCallsAfterSettle = state.statusCalls.length;

    // (4) settled watch: the board digest never changed, so later ticks stay
    //     quiet no-ops with no further status reads and no second recovery
    state.status = okStatus({
      state: "failed",
      assistant_message_ids: ["msg_late"],
      error_details: [failedDetail("provider_header_timeout", "msg_late")],
    });
    await advanceDue(project, 500_000);
    assert.equal(await seed.engineFactory(500_000).tick(), "noop-unchanged");
    await advanceDue(project, 600_000);
    assert.equal(await seed.engineFactory(600_000).tick(), "noop-unchanged");
    assert.equal(state.sends.length, 1, "the settled watch never re-dispatches");
    assert.equal(state.statusCalls.length, statusCallsAfterSettle, "a settled watch performs no further status reads");
  } finally {
    await cleanup();
  }
});

test("gate fix: healthy terminal receipt on an unchanged board settles once and stays a cheap no-op", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithAdmittedDispatch(project, gateway, board, state, 100_000);
    state.status = okStatus();

    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "noop-unchanged");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(state.sends.length, 0, "healthy unchanged board stays dispatch-free");
    assert.equal(record.state.receipt_observation?.outcome, "healthy");
    assert.equal(record.state.receipt_observation?.receipt, seed.receipt);
    const decision = record.history.find((entry) => entry.type === "noop-unchanged"
      && (entry.detail as { reason?: string }).reason === "receipt-observed-healthy");
    assert.ok(decision, "the settlement names its own cause-specific merge key");

    const statusCallsAfterSettle = state.statusCalls.length;
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "noop-unchanged");
    assert.equal(state.statusCalls.length, statusCallsAfterSettle, "no repeated receipt reads after settlement");
  } finally {
    await cleanup();
  }
});

test("gate fix: chain exhaustion on an unchanged board parks transparently once and later ticks stay quiet without repeated aborts", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    state.abortState = "no_active_turn";
    const seed = await seedMonitorWithAdmittedDispatch(project, gateway, board, state, 100_000);
    state.status = okStatus({
      state: "failed",
      assistant_message_ids: ["msg_fail"],
      error_details: [failedDetail("provider_header_timeout", "msg_fail")],
    });
    const unconfigured = new MonitorEngine({
      project, gateway, board,
      readPolicy: async () => policyUnconfigured,
      now: () => 200_000,
    });
    await advanceDue(project, 200_000);
    assert.equal(await unconfigured.tick(), "recovery-parked");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required");
    assert.equal(record.state.parked_reason, "final-fallback-unconfigured");
    assert.equal(record.state.receipt_observation?.outcome, "held", "a park settles the watch");
    assert.equal(state.sends.length, 0);
    assert.equal(state.abortResults.length, 1);

    const statusCallsAfterPark = state.statusCalls.length;
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "noop-unchanged");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required", "the park stays");
    assert.equal(state.sends.length, 0, "no repeated recovery attempts after the park");
    assert.equal(state.abortResults.length, 1, "no repeated aborts on a quiet board");
    assert.equal(state.statusCalls.length, statusCallsAfterPark);
  } finally {
    await cleanup();
  }
});

test("gate fix: pending input during the watch stays a bounded merged busy hold without dispatches or history growth", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithAdmittedDispatch(project, gateway, board, state, 100_000);
    state.status = okStatus({
      state: "failed",
      assistant_message_ids: ["msg_fail"],
      error_details: [failedDetail("provider_header_timeout", "msg_fail")],
    });
    state.combinedPending = { permissions: 1, questions: 0 };

    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "busy-held");
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "busy-held");
    assert.equal(state.sends.length, 0, "pending input never dispatches");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const watch = record.history.filter((entry) => entry.type === "receipt-watch"
      && (entry.detail as { reason?: string }).reason === "pending-input");
    assert.equal(watch.length, 1, "repeated holds merge into one decision entry");
    assert.equal((watch[0]!.detail as { count?: number }).count, 2);
    assert.equal(record.state.receipt_observation, undefined, "an unresolved hold keeps the watch open");
  } finally {
    await cleanup();
  }
});

test("gate fix: receipt_observation is additive, validates fail-closed and round-trips", async () => {
  const { project, cleanup } = await setup();
  try {
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, {}, 1000);
      monitor.state.receipt_observation = { receipt: "msg_" + "a".repeat(32), outcome: "healthy", at: new Date(1000).toISOString() };
      registry.monitors.push(monitor);
      return registry;
    });
    const ok = await readRegistrySnapshot(project);
    assert.equal(ok.registry.monitors[0]!.state.receipt_observation?.outcome, "healthy");
    const validMonitor = JSON.parse(JSON.stringify(ok.registry.monitors[0]));

    for (const corrupt of [
      { receipt: "msg_x", outcome: "magic", at: new Date(1000).toISOString() },
      { receipt: "", outcome: "healthy", at: new Date(1000).toISOString() },
      { receipt: "msg_x", outcome: "held", at: "yesterday" },
    ]) {
      await writeFile(monitorRegistryPath(project), JSON.stringify({
        schema: 1,
        generation: 1,
        monitors: [{ ...validMonitor, state: { ...validMonitor.state, receipt_observation: corrupt } }],
      }));
      await assert.rejects(readRegistrySnapshot(project), /invalid monitor registry/);
    }
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// QC G1 fix (be951293): unknown/submitted/aborted/bare-failed are NOT reliable
// terminal evidence and must never settle the receipt watch — a later terminal
// outcome of the SAME receipt must still reach evidence/recovery.

test("gate fix QC-G1: unknown on an unchanged board does not settle; a later terminal header-timeout of the same receipt recovers on the next tick", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    state.abortState = "no_active_turn";
    const seed = await seedMonitorWithAdmittedDispatch(project, gateway, board, state, 100_000);

    // (1) delayed/nonterminal observation: idle + unknown — never a settlement
    state.status = okStatus({ state: "unknown" });
    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "busy-held");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.receipt_observation, undefined, "unknown must not settle the watch");
    assert.equal(state.sends.length, 0);
    const watch = record.history.filter((entry) => entry.type === "receipt-watch"
      && (entry.detail as { reason?: string }).reason === "receipt-not-confirmed-terminal");
    assert.equal(watch.length, 1, "one transparent merged decision names the unconfirmed state");
    assert.equal((watch[0]!.detail as { state?: string }).state, "unknown");

    // (2) repeated identical nonterminal observation stays merged and idempotent
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "busy-held");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const watchAfterRepeat = record.history.filter((entry) => entry.type === "receipt-watch"
      && (entry.detail as { reason?: string }).reason === "receipt-not-confirmed-terminal");
    assert.equal(watchAfterRepeat.length, 1, "no history growth for repeated nonterminal reads");
    assert.equal((watchAfterRepeat[0]!.detail as { count?: number }).count, 2);
    assert.equal(state.sends.length, 0);

    // (3) the delayed terminal failure of the SAME receipt recovers — the
    //     exact G1 repro (unknown -> provider_header_timeout, no board/worker
    //     change, second tick must allow the needed recovery)
    state.status = okStatus({
      state: "failed",
      assistant_message_ids: ["msg_fail"],
      error_details: [failedDetail("provider_header_timeout", "msg_fail")],
    });
    await advanceDue(project, 400_000);
    assert.equal(await seed.engineFactory(400_000).tick(), "recovery-continued");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(state.sends.length, 1, "exactly one recovery continuation for the late failure");
    assert.deepEqual(state.statusCalls.map((call) => call.message_id),
      [seed.receipt, seed.receipt, seed.receipt], "every watch read correlates the same dispatch receipt");
    assert.ok(record.recovery_episode?.attempts.some((entry) => entry.identity === "deep-provider/deep-model"));
  } finally {
    await cleanup();
  }
});

test("gate fix QC-G1: aborted is transparent, never healthy, keeps the watch open and a later terminal failure still recovers", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    state.abortState = "no_active_turn";
    const seed = await seedMonitorWithAdmittedDispatch(project, gateway, board, state, 100_000);

    state.status = okStatus({ state: "aborted" });
    await advanceDue(project, 200_000);
    assert.equal(await seed.engineFactory(200_000).tick(), "busy-held");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.receipt_observation, undefined, "aborted never settles as healthy");
    const watch = record.history.filter((entry) => entry.type === "receipt-watch"
      && (entry.detail as { reason?: string }).reason === "receipt-not-confirmed-terminal");
    assert.equal(watch.length, 1);
    assert.equal((watch[0]!.detail as { state?: string }).state, "aborted", "the aborted state is named transparently");
    assert.ok(!record.history.some((entry) => entry.type === "noop-unchanged"
      && (entry.detail as { reason?: string }).reason === "receipt-observed-healthy"));

    state.status = okStatus({
      state: "failed",
      assistant_message_ids: ["msg_fail"],
      error_details: [failedDetail("provider_header_timeout", "msg_fail")],
    });
    await advanceDue(project, 300_000);
    assert.equal(await seed.engineFactory(300_000).tick(), "recovery-continued");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(state.sends.length, 1);
  } finally {
    await cleanup();
  }
});

test("gate fix QC-G1: submitted/running/retry/busy activity and bare-failed states keep the watch open without sends or settlements", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const seed = await seedMonitorWithAdmittedDispatch(project, gateway, board, state, 100_000);

    for (const [index, status] of [
      okStatus({ state: "submitted" }),
      okStatus({ backend_activity: "busy", state: "running" }),
      okStatus({ backend_activity: "retry", state: "running" }),
      okStatus({ state: "failed", error_details: [] }),
    ].entries()) {
      state.status = status;
      const now = 200_000 + index * 100_000;
      await advanceDue(project, now);
      assert.equal(await seed.engineFactory(now).tick(), "busy-held", `nonterminal state ${JSON.stringify(status.state ?? status.backend_activity)} stays held`);
    }
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.receipt_observation, undefined, "no nonterminal read settles the watch");
    assert.equal(state.sends.length, 0, "no dispatch or recovery without terminal evidence");
    assert.equal(record.state.work, "active", "holds never park the work state");
    const watchEntries = record.history.filter((entry) => entry.type === "receipt-watch");
    assert.ok(watchEntries.length >= 1, "the holds are visible as merged decisions");
    assert.ok(record.history.filter((entry) => entry.type === "receipt-watch").every((entry) =>
      (entry.detail as { reason?: string }).reason !== undefined));
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// V2 adaptive progress / investigation (task_a234c341 §13, package
// task_e67c39cf): per-worker clocks, dispatch anchor, bounded budgets,
// claim recovery with heartbeat evidence, registry-only observer. C1/C4/C6
// contract tests; the harness stays deterministic (temp registries, fakes).
// ---------------------------------------------------------------------------

function progressResult(sessionId: string, tick: number) {
  return {
    session_id: sessionId,
    observed_at: "2026-10-07T00:00:00.000Z",
    source: "backend_snapshot" as const,
    backend_activity: "busy" as const,
    pending_input: { permissions: 0, questions: 0 },
    pending_input_scope: "session" as const,
    in_flight_tools: [
      { message_id: `msg_t${tick}`, call_id: `call_${tick}`, tool: "bash", status: "running" as const },
    ],
    idle_with_in_flight_tools: false,
    coverage: { message_limit: 100, messages_scanned: 100, history_has_more: false, in_flight_total: 1, in_flight_truncated: false, metadata_incomplete: false, unattributed_tools: 0 },
  };
}

async function writeHeartbeat(project: string, generation: string, atMs: number): Promise<void> {
  const dir = join(project, ".opencode-vm", "monitor");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "heartbeat.json"), JSON.stringify({ schema: 1, projectHash: "p", generation, pid: 1, at: new Date(atMs).toISOString() }) + "\n");
}

/** Seeds a due investigation worker state for the standard dispatched worker. */
async function seedDueWorker(project: string, workerKey: string, dueAt: number): Promise<void> {
  await withRegistry(project, (registry) => {
    const monitor = registry.monitors[0]!;
    const inv = monitor.investigation ??= defaultInvestigationState();
    const state = investigationWorkerFor(inv, workerKey, "msg_dispatch");
    state.anchored_at = "2026-10-07T00:00:00.000Z";
    state.anchor_source = "creation";
    state.dispatch_receipt = "msg_dispatch";
    state.next_deep_check_at = dueAt;
    refreshInvestigationProjections(inv);
    return registry;
  });
}

test("investigation config: defaults are valid; degenerate values fail closed (C4)", () => {
  const defaults = validateInvestigationConfigInput(undefined);
  assert.equal(defaults.config.first_check_s, 3600);
  assert.equal(defaults.config.cooldown_s, 3600);
  assert.deepEqual(defaults.config.ladder_s, [7200, 14400, 28800]);
  assert.equal(defaults.task.task_type, "default");
  assert.deepEqual(defaultInvestigationConfig().config.budget, { max_duration_ms: 300_000, max_calls: 10, max_bytes: 262_144, call_timeout_ms: 3_000, daily_budget: 24 });
  for (const bad of [
    { first_check_s: 30 },
    { cooldown_s: 0 },
    { ladder_s: [1, 1, 1] },
    { ladder_s: [28800, 7200, 14400] },
    { ladder_s: [60, 120] },
    { budget: { max_calls: 0 } },
    { budget: { max_bytes: 2_000_000 } },
    { budget: { max_duration_ms: 7_200_000 } },
    { task_type: "yolo" },
    { daily_budget: 10 },
  ]) {
    assert.throws(() => validateInvestigationConfigInput(bad), `degenerate value must fail closed: ${JSON.stringify(bad)}`);
  }
  const custom = validateInvestigationConfigInput({
    first_check_s: 120,
    cooldown_s: 180,
    ladder_s: [600, 1200, 2400],
    budget: { max_calls: 5 },
    daily_budget: Math.ceil(86_400 / 180),
    task_type: "milestoned",
    expected_milestone: "MVP green",
  });
  assert.equal(custom.config.first_check_s, 120);
  assert.deepEqual(custom.config.ladder_s, [600, 1200, 2400]);
  assert.equal(custom.task.expected_milestone, "MVP green");
});

test("A11 claim recovery: stale heartbeat of the owner generation releases after WAL reconciliation (no duplicate dispatch)", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway } = fakes(state);
    await withRegistry(project, (registry) => {
      const recovered = defaultMonitorRecord("M", TASK, {}, 100_000);
      recovered.run = { active: true, started_at: "2026-10-07T00:00:00.000Z", action: "dispatch", owner_pid: 4242, owner_generation: "gen-old" };
      recovered.dispatch_wal = { action_id: "act_known", at: "2026-10-07T00:00:00.000Z", prompt_digest: "d", message_id: null };
      recovered.session = { session_id: "ses_monitor", title: null, primed_at: null, priming_digest: null };
      state.history.push({ id: "msg_hist", role: "user", text: "[MONITOR-ACTION act_known] hi" });
      const parked = defaultMonitorRecord("M2", TASK, {}, 100_000);
      parked.run = { active: true, started_at: "2026-10-07T00:00:00.000Z", action: "dispatch", owner_pid: 4242, owner_generation: "gen-old" };
      parked.dispatch_wal = { action_id: "act_lost", at: "2026-10-07T00:00:00.000Z", prompt_digest: "d", message_id: null };
      parked.session = { session_id: "ses_monitor", title: null, primed_at: null, priming_digest: null };
      registry.monitors.push(recovered, parked);
      return registry;
    });
    // Stale heartbeat of exactly the claim owner generation: owner provably gone.
    await writeHeartbeat(project, "gen-old", 100_000 - 120_000);
    const engine = new MonitorEngine({ project, gateway, readPolicy: async () => policyConfigured, now: () => 200_000, engineGeneration: "gen-new" });
    const recoveredCount = await engine.recoverAbandonedClaims();
    assert.equal(recoveredCount, 2);
    const after = (await readRegistrySnapshot(project)).registry.monitors;
    assert.equal(after[0]!.run.active, false);
    assert.equal(after[0]!.dispatch_wal!.message_id, "msg_hist", "uncertain WAL reconciled through the existing path");
    assert.ok(after[0]!.history.some((entry) => entry.type === "wake-claim-recovered"));
    assert.equal(after[1]!.run.active, false);
    assert.equal(after[1]!.state.parked_reason, "dispatch-uncertain", "unresolved WAL parks, never a silent release");
    assert.equal(state.sends.length, 0, "claim recovery never re-sends");
  } finally {
    await cleanup();
  }
});

test("A11b: a fresh heartbeat of the owner generation is never released; identity-less claims stay visible; own generation untouched", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway } = fakes(state);
    await withRegistry(project, (registry) => {
      const old = defaultMonitorRecord("M", TASK, {}, 100_000);
      old.run = { active: true, started_at: "2026-10-07T00:00:00.000Z", action: null, owner_pid: 4242, owner_generation: "gen-old" };
      const legacy = defaultMonitorRecord("M2", TASK, {}, 100_000);
      legacy.run = { active: true, started_at: "2026-10-07T00:00:00.000Z", action: null, owner_pid: 99 };
      const own = defaultMonitorRecord("M3", TASK, {}, 100_000);
      own.run = { active: true, started_at: "2026-10-07T00:00:00.000Z", action: null, owner_pid: process.pid, owner_generation: "gen-new" };
      registry.monitors.push(old, legacy, own);
      return registry;
    });
    // FRESH heartbeat of gen-old: the old engine may still be alive (A11b).
    await writeHeartbeat(project, "gen-old", 200_000 - 1_000);
    const engine = new MonitorEngine({ project, gateway, readPolicy: async () => policyConfigured, now: () => 200_000, engineGeneration: "gen-new" });
    assert.equal(await engine.recoverAbandonedClaims(), 0);
    const after = (await readRegistrySnapshot(project)).registry.monitors;
    assert.equal(after[0]!.run.active, true, "fresh heartbeat of the owner generation blocks release");
    assert.ok(after[0]!.history.some((entry) => entry.type === "wake-claim-stuck" && (entry.detail as { reason?: string }).reason === "heartbeat-fresh-owner-generation"));
    assert.equal(after[1]!.run.active, true, "PID without generation is not sufficient process identity");
    assert.ok(after[1]!.history.some((entry) => entry.type === "wake-claim-stuck" && (entry.detail as { reason?: string }).reason === "claim-without-owner-identity"));
    assert.equal(after[2]!.run.active, true);
    assert.equal(after[2]!.history.some((entry) => entry.type === "wake-claim-stuck"), false, "own generation is never touched");
  } finally {
    await cleanup();
  }
});

test("anchor: creation fallback anchors the first deep check T_first out; investigation never fires immediately", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });

    // The next wake claims and anchors the worker; the worker-index delta
    // itself wakes the manager (existing W4 mechanism), the anchor makes the
    // FOLLOWING unchanged wake a cheap no-op — never an immediate investigation.
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 200_000, engineGeneration: "gen-new" });
    await advanceDue(project, 200_000);
    assert.equal(await engine2.tick(), "dispatched", "worker delta wakes the manager; the claim anchors the episode");
    assert.equal(state.sends.length, 2);
    let after = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.ok(after.investigation, "investigation state exists after the first claimed wake");
    let ws = after.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.equal(after.workers![0]!.dispatch_at, new Date(100_600).toISOString(), "F4: dispatch time captured at the new receipt");
    assert.equal(ws.anchor_source, "dispatch", "F4: dispatch-correlated anchor wins over creation fallback");
    assert.equal(ws.anchored_at, new Date(100_600).toISOString());
    assert.equal(ws.next_deep_check_at, 100_600 + 3600 * 1000, "first deep check T_first after the dispatch anchor");
    assert.equal(after.investigation!.counters.anchor_unknown_total, 0);

    // The quiet-board receipt watch settles the admitted dispatch as verified
    // healthy — a reconciliation completion that re-anchors per §13.5 (never
    // an immediate deep check, never a progress reset).
    const engine3 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 300_000, engineGeneration: "gen-new" });
    await advanceDue(project, 300_000);
    assert.equal(await engine3.tick(), "noop-unchanged");
    after = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    ws = after.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.equal(after.state.receipt_observation!.outcome, "healthy");
    assert.equal(ws.anchor_source, "reconciled", "§13.5: healthy receipt settlement re-anchors");
    assert.equal(ws.next_deep_check_at, 300_000 + 3600 * 1000);
    assert.equal(ws.last_progress_at, null);
    assert.equal(state.sends.length, 2);
  } finally {
    await cleanup();
  }
});

test("P5: a due investigation runs before the no-op shortcut AND before the busy gate; results are never progress (C1b)", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 150_000);

    // (1) Unchanged board + due worker -> investigation, not a silent no-op.
    const investigated = await engineFactory(200_000).tick();
    assert.equal(investigated, "investigated");
    assert.equal(state.sends.length, 1, "investigation performs zero sends");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.episode!.outcome, "inconclusive", "active worker without progress telemetry is honestly inconclusive — never progress");
    assert.equal(record.investigation!.last_progress_at, null, "an investigation result is never progress");
    assert.ok(record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!.cooldown_until !== null, "cooldown from the investigation end");

    // (2) Cooldown prevents an immediate second investigation (no due loop).
    await advanceDue(project, 300_000);
    assert.equal(await engineFactory(300_000).tick(), "noop-unchanged");

    // (3) Busy/blocked worker: due investigation still runs read-only (C1b),
    // unattributable running without telemetry stays inconclusive.
    state.statusFor = (sessionId) => (sessionId === "ses_worker" ? okStatus({ backend_activity: "retry", state: "running" }) : okStatus());
    await withRegistry(project, (registry) => {
      const target = registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      target.next_deep_check_at = 350_000;
      refreshInvestigationProjections(registry.monitors[0]!.investigation!);
      return registry;
    });
    const busyInvestigated = await engineFactory(400_000).tick();
    assert.equal(busyInvestigated, "investigated", "due check precedes the busy gate");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.episode!.outcome, "inconclusive", "stale running without attributable telemetry is inconclusive");
    assert.equal(record.investigation!.last_progress_at, null);
    assert.ok(state.statusCalls.some((call) => call.session_id === "ses_worker"), "the honest status read names the observed state");
  } finally {
    await cleanup();
  }
});

test("long-work ladder advances 2h/4h/8h-cap ONLY on positive evidence; attributable tool delta qualifies (A1)", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    let progressTick = 0;
    gateway.getSessionProgress = async (sessionId: string) => progressResult(sessionId, ++progressTick);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 150_000);

    // Round 1: baseline only (delta needs two points) -> inconclusive, cooldown.
    assert.equal(await engineFactory(200_000).tick(), "investigated");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    let ws = record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.equal(record.investigation!.episode!.outcome, "inconclusive");
    assert.ok(ws.last_tool_digest !== null, "baseline recorded");

    // Rounds 2-4: attributable tool delta each round -> ladder 1,2,3 (2h/4h/8h).
    for (const [round, now] of [[2, 400_000], [3, 900_000], [4, 3_400_000]] as const) {
      await withRegistry(project, (registry) => {
        const target = registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
        target.next_deep_check_at = now - 1_000;
        refreshInvestigationProjections(registry.monitors[0]!.investigation!);
        return registry;
      });
      assert.equal(await engineFactory(now).tick(), "investigated", `round ${round}`);
      record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
      ws = record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      assert.equal(record.investigation!.episode!.outcome, "long_work_evidenced", `round ${round}`);
      assert.equal(ws.backoff_stage, round - 1, `round ${round}`);
      assert.equal(ws.cooldown_until, null);
    }
    // Stage cap: a fifth positive round stays at stage 3 (8 h cap).
    await withRegistry(project, (registry) => {
      const target = registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      target.next_deep_check_at = 10_400_000;
      refreshInvestigationProjections(registry.monitors[0]!.investigation!);
      return registry;
    });
    assert.equal(await engineFactory(10_500_000).tick(), "investigated");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    ws = record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.equal(ws.backoff_stage, 3);
    assert.ok(record.investigation!.episode!.wait_reason !== null);
    // The ladder never touched the progress clock.
    assert.equal(record.investigation!.last_progress_at, null);
  } finally {
    await cleanup();
  }
});

test("A8: a receipt-correlated terminal worker result resets the ladder to stage 0 and T_first; investigations never do", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 150_000);
    assert.equal(await engineFactory(200_000).tick(), "investigated");

    // The worker completes: observeWorkers marks it and A resets the ladder.
    state.status = okStatus({ assistant_message_ids: ["msg_result"] });
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!.next_deep_check_at = 5_000_000;
      refreshInvestigationProjections(registry.monitors[0]!.investigation!);
      return registry;
    });
    assert.equal(await engineFactory(1_000_000).tick(), "dispatched", "worker delta wakes the manager");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    let ws = record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.ok(ws.last_progress_at !== null, "terminal result receipt is engine-side A evidence");
    assert.equal(ws.backoff_stage, 0, "A resets the ladder");
    assert.equal(ws.cooldown_until, null);
    assert.equal(ws.next_deep_check_at, 1_000_000 + 3600 * 1000);

    // A subsequent investigation still never claims progress.
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!.next_deep_check_at = 1_100_000;
      refreshInvestigationProjections(registry.monitors[0]!.investigation!);
      return registry;
    });
    assert.equal(await engineFactory(1_200_000).tick(), "investigated");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.last_progress_at, ws.last_progress_at, "investigation results never advance the progress clock");
  } finally {
    await cleanup();
  }
});

test("§13.5: recovery holds the due check; a healthy dispatch re-anchors WITHOUT touching progress or stage", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    // Absorb the worker-index delta so the board digest is current.
    await advanceDue(project, 200_000);
    assert.equal(await engineFactory(200_000).tick(), "dispatched");
    const seedReceipt = (await readRegistrySnapshot(project)).registry.monitors[0]!.dispatch_wal!.message_id!;

    await seedDueWorker(project, reserved.worker_key, 150_000);
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.recovery.active = true;
      // Settle the receipt watch so the quiet board stays a true no-op path.
      monitor.state.receipt_observation = { receipt: seedReceipt, outcome: "healthy", at: "2026-10-07T00:03:00.000Z" };
      const target = monitor.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      target.backoff_stage = 2;
      target.last_progress_at = "2026-10-07T01:00:00.000Z";
      refreshInvestigationProjections(monitor.investigation!);
      return registry;
    });
    // Open recovery holds the due check: unchanged board stays a cheap no-op.
    await advanceDue(project, 300_000);
    assert.equal(await engineFactory(300_000).tick(), "noop-unchanged", "clock hold during recovery (§13.5)");

    // A healthy receipt settlement (existing receipt watch) is a reconciliation
    // completion: it re-anchors WITHOUT touching progress or stage.
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.recovery.active = false;
      monitor.state.receipt_observation = null;
      const target = monitor.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      target.next_deep_check_at = 5_000_000; // P5 quiet; the receipt watch runs instead
      refreshInvestigationProjections(monitor.investigation!);
      return registry;
    });
    await advanceDue(project, 400_000);
    assert.equal(await engineFactory(400_000).tick(), "noop-unchanged", "verified terminal health settles the watch");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.receipt_observation!.outcome, "healthy");
    const ws = record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.equal(ws.backoff_stage, 2, "re-anchor keeps the stage (no false reset)");
    assert.equal(ws.last_progress_at, "2026-10-07T01:00:00.000Z", "re-anchor never touches the progress clock");
    assert.equal(ws.anchor_source, "reconciled");
    assert.equal(ws.next_deep_check_at, 400_000 + 3600 * 1000, "anchor = reconciliation completion");
  } finally {
    await cleanup();
  }
});

test("§13.7 observer: registry-only (zero gateway calls), leases, wake_request handover, stuck own-claim visibility", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 90_000);

    const statusCallsBefore = state.statusCalls.length;
    await engine.observe();
    assert.equal(state.statusCalls.length, statusCallsBefore, "the observer performs zero gateway calls");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.wake_request?.reason, `investigation-due:${reserved.worker_key}`, "due investigation handed to the next regular wake");
    assert.ok(record.investigation!.observer_lease, "lease recorded");
    assert.ok(record.history.some((entry) => entry.type === "observer-investigation-due"));

    // A foreign fresh lease blocks the observer (no double handover).
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.wake_request = null;
      monitor.investigation!.observer_lease = { owner: "other:gen", lease_until: 200_000, generation: 1 };
      return registry;
    });
    await engine.observe();
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.wake_request, null, "foreign unexpired lease blocks observation");
    assert.equal(record.investigation!.observer_lease!.owner, "other:gen");

    // Stuck OWN claim is made visible (never released by the observer).
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.run = { active: true, started_at: new Date(100_000 - 61 * 60_000).toISOString(), action: null, owner_pid: process.pid, owner_generation: "gen-new" };
      monitor.investigation!.observer_lease = null;
      return registry;
    });
    await engine.observe();
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.run.active, true, "the observer never releases a claim");
    assert.ok(record.history.some((entry) => entry.type === "wake-claim-stuck" && (entry.detail as { reason?: string }).reason === "own-claim-extended"));

    // Observation stays possible while a wake is in flight (blocked await).
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.run = { active: false, started_at: null, action: null };
      registry.monitors[0]!.investigation!.observer_lease = null;
      return registry;
    });
    const pending = engine.tick();
    await engine.observe();
    await pending;
    assert.ok(true, "observer completed while the wake was between awaits");
  } finally {
    await cleanup();
  }
});

test("board bookkeeping alone is never progress: changed decisions dispatch, but the progress clock stays untouched (A8 guard)", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 900_000);

    // Board bookkeeping changes (new journal entries) -> normal dispatch path.
    state.entries.push({ sequence: 2, entry_id: "e2", appended_at: "2026-10-07T02:00:00.000Z" });
    assert.equal(await engineFactory(200_000).tick(), "dispatched");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.last_progress_at, null, "decisionsSince/entries alone are not A evidence");
    assert.equal(record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!.last_progress_at, null);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Candidate-QC fixes (task_e67c39cf): F1 milestone/daily-budget/checkpoint
// enforcement, F2 budget enforcement (timeout/bytes/admission), F4 dispatch-
// correlated worker time basis, Z1 observer probe lane during a blocked wake.
// ---------------------------------------------------------------------------

test("F4: reused worker gets a dispatch-correlated time basis; same-receipt rebind never resets", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });

    // Same receipt again: NO reset of the dispatch time basis.
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 500_600 });
    let worker = (await readRegistrySnapshot(project)).registry.monitors[0]!.workers![0]!;
    assert.equal(worker.dispatch_at, new Date(100_600).toISOString(), "same receipt never resets dispatch_at");

    // A genuinely NEW receipt starts a fresh time basis (F4 core).
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker2", dispatch_receipt: "msg_dispatch2" }, { now: 600_000 });
    worker = (await readRegistrySnapshot(project)).registry.monitors[0]!.workers![0]!;
    assert.equal(worker.dispatch_at, new Date(600_000).toISOString());
    assert.equal(worker.dispatch_receipt, "msg_dispatch2");

    // The episode sync anchors from dispatch_at (not the old created_at).
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 700_000, engineGeneration: "gen-new" });
    await advanceDue(project, 700_000);
    assert.equal(await engine2.tick(), "dispatched");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const ws = record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.equal(ws.dispatch_receipt, "msg_dispatch2");
    assert.equal(ws.anchored_at, new Date(600_000).toISOString(), "anchor = fresh dispatch time, not stale created_at");
    assert.equal(ws.anchor_source, "dispatch");
    assert.equal(ws.next_deep_check_at, 600_000 + 3600 * 1000);
  } finally {
    await cleanup();
  }
});

test("F1: an overdue unachieved milestone pulls one early investigation per deadline; no due loop; A achieves", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      monitor.investigation_config = validateInvestigationConfigInput({
        task_type: "milestoned", expected_milestone: "MVP green", milestone_due_at: "1970-01-01T00:03:00.000Z",
      });
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    // The anchor window is far in the future (T_first from dispatch at
    // 100_600); the OVERDUE milestone must pull the check forward anyway.
    await advanceDue(project, 200_000);
    assert.equal(await engineFactory(200_000).tick(), "investigated", "overdue milestone triggers the bounded check early");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.milestone!.overdue_handled_for, "1970-01-01T00:03:00.000Z");
    assert.ok(record.investigation!.milestone!.overdue_handled_at !== null);

    // Exactly ONCE per deadline: the next unchanged wakes are cheap no-ops.
    await advanceDue(project, 300_000);
    assert.equal(await engineFactory(300_000).tick(), "noop-unchanged", "no due loop from the expired deadline");
    await advanceDue(project, 400_000);
    assert.equal(await engineFactory(400_000).tick(), "noop-unchanged");

    // A CHANGED deadline may trigger once again.
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.investigation_config = validateInvestigationConfigInput({
        task_type: "milestoned", expected_milestone: "MVP green", milestone_due_at: "1970-01-01T00:06:00.000Z",
      });
      return registry;
    });
    await advanceDue(project, 500_000);
    assert.equal(await engineFactory(500_000).tick(), "investigated", "a new deadline value triggers once again");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.milestone!.overdue_handled_for, "1970-01-01T00:06:00.000Z");

    // Genuine A evidence achieves the milestone: overdue pressure ends.
    state.status = okStatus({ assistant_message_ids: ["msg_result"] });
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.investigation_config = validateInvestigationConfigInput({
        task_type: "milestoned", expected_milestone: "MVP green", milestone_due_at: "1970-01-01T01:00:00.000Z",
      });
      return registry;
    });
    await advanceDue(project, 600_000);
    assert.equal(await engineFactory(600_000).tick(), "dispatched", "worker completion reaches the manager");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.ok(record.investigation!.milestone!.achieved_at !== null, "receipt-correlated result achieves the milestone");
    await advanceDue(project, 700_000);
    assert.equal(await engineFactory(700_000).tick(), "noop-unchanged", "achieved milestone never triggers again");
  } finally {
    await cleanup();
  }
});

test("F1: daily budget counts executed runs in a rolling 24h window; the deferred run is transparent and cheap checks continue", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      monitor.investigation_config = validateInvestigationConfigInput({
        cooldown_s: 3600, daily_budget: 24,
      });
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 100_000);

    for (const run of Array.from({ length: 24 }, (_, index) => index + 1)) {
      const now = 200_000 + run * 100_000;
      await withRegistry(project, (registry) => {
        const target = registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
        target.next_deep_check_at = now - 1;
        refreshInvestigationProjections(registry.monitors[0]!.investigation!);
        return registry;
      });
      assert.equal(await engineFactory(now).tick(), "investigated", `executed run ${run}`);
    }
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.counters.investigations_total, 24);

    // 4th due within the window: DEFERRED — no episode, no counter, visible
    // next check at the window end, explicit decision.
    const oldest = Math.min(...(record.investigation!.recent_investigations ?? []));
    await withRegistry(project, (registry) => {
      const target = registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      target.next_deep_check_at = 600_000;
      refreshInvestigationProjections(registry.monitors[0]!.investigation!);
      return registry;
    });
    await advanceDue(project, 600_000);
    assert.equal(await engineFactory(600_000).tick(), "investigation-deferred");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.counters.investigations_total, 24, "deferred runs never count");
    assert.equal(record.investigation!.episode!.started_at, new Date(2_600_000).toISOString(),
      "deferral leaves the previous executed episode untouched");
    const ws = record.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
    assert.equal(ws.next_deep_check_at, oldest + 86_400_000, "transparent next due = window end");
    assert.ok(record.history.some((entry) => entry.type === "investigation-deferred" &&
      (entry.detail as { next_check?: string }).next_check !== undefined), "visible next check/wait reason");

    // Cheap checks continue: a board change still dispatches normally.
    state.entries.push({ sequence: 2, entry_id: "e2", appended_at: "2026-10-07T02:00:00.000Z" });
    await advanceDue(project, 700_000);
    assert.equal(await engineFactory(700_000).tick(), "dispatched", "cheap/normal checks unaffected by the deferral");
  } finally {
    await cleanup();
  }
});

test("F1: receipt-correlated checkpoint evidence counts; unavailable journal text claims nothing", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    // Constant tool digest: the tool-delta criterion must NOT pre-empt the
    // checkpoint scan (this test isolates evidence kind (b)).
    gateway.getSessionProgress = async (sessionId: string) => ({
      session_id: sessionId,
      observed_at: "2026-10-07T00:00:00.000Z",
      source: "backend_snapshot" as const,
      backend_activity: "busy" as const,
      pending_input: { permissions: 0, questions: 0 },
      pending_input_scope: "session" as const,
      in_flight_tools: [{ message_id: "msg_tool", call_id: "call_base", tool: "bash", status: "running" as const }],
      idle_with_in_flight_tools: false,
      coverage: { message_limit: 100, messages_scanned: 100, history_has_more: false, in_flight_total: 1, in_flight_truncated: false, metadata_incomplete: false, unattributed_tools: 0 },
    });
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 150_000);

    // Baseline round records the tool digest; the journal has NO text yet ->
    // the checkpoint boundary is recorded without any long-work claim.
    assert.equal(await engineFactory(200_000).tick(), "investigated");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.episode!.outcome, "inconclusive");
    assert.ok(record.investigation!.episode!.evidence.some((entry) => entry.kind === "checkpoint_evidence_unavailable"));

    // A journal entry CORRELATED to the worker's own receipt is positive.
    state.entries.push({ sequence: 2, entry_id: "e2", appended_at: "2026-10-07T02:00:00.000Z", text: "checkpoint: dispatched msg_dispatch step 3 done" } as typeof state.entries[number] & { text: string });
    await withRegistry(project, (registry) => {
      const target = registry.monitors[0]!.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      target.next_deep_check_at = 250_000;
      refreshInvestigationProjections(registry.monitors[0]!.investigation!);
      return registry;
    });
    assert.equal(await engineFactory(300_000).tick(), "investigated");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.episode!.outcome, "long_work_evidenced");
    assert.ok(record.investigation!.episode!.evidence.some((entry) => entry.kind === "receipt_correlated_checkpoint"));
    assert.ok(String(record.investigation!.episode!.wait_reason).includes("checkpoint"));
  } finally {
    await cleanup();
  }
});

test("F2: call timeout bounds a hanging gateway read (aborted_budget, timely)", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    gateway.getSessionProgress = () => new Promise(() => undefined); // hangs
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      monitor.investigation_config = validateInvestigationConfigInput({ budget: { call_timeout_ms: 250 } });
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 150_000);

    const startedAt = Date.now();
    assert.equal(await engineFactory(200_000).tick(), "investigated");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5_000, `the engine wait is bounded (took ${elapsed}ms)`);
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.episode!.outcome, "aborted_budget");
    assert.ok(record.investigation!.episode!.evidence.some((entry) => entry.kind === "call_timeout"));
    assert.equal(record.investigation!.last_progress_at, null);
  } finally {
    await cleanup();
  }
});

test("F2: byte budget admits the NEXT call, never fires one over budget; small call budget blocks before the read", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    let boardHistoryCalls = 0;
    const countingBoard: MonitorBoardLike = {
      getTask: board.getTask,
      getManagementHistory: (...args: Parameters<MonitorBoardLike["getManagementHistory"]>) => {
        boardHistoryCalls += 1;
        return board.getManagementHistory(...args);
      },
      getDocuments: board.getDocuments,
    };
    const engineFactory = (now: number) =>
      new MonitorEngine({ project, gateway, board: countingBoard, readPolicy: async () => policyConfigured, now: () => now, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      // Tiny byte budget: the first bounded status response already exceeds it.
      monitor.investigation_config = validateInvestigationConfigInput({ budget: { max_bytes: 50 } });
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engineFactory(100_000).tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    await seedDueWorker(project, reserved.worker_key, 150_000);

    const statusCallsBefore = state.statusCalls.length;
    const boardCallsBefore = boardHistoryCalls;
    assert.equal(await engineFactory(200_000).tick(), "investigated");
    assert.equal(state.statusCalls.length, statusCallsBefore + 2,
      "exactly two reads: the wake's observeWorkers probe + the budget-admitted status read");
    // Canonical snapshot reads (recent + latest_checkpoint) happen every wake;
    // the CHECKPOINT evidence read was the one never admitted over budget.
    assert.equal(boardHistoryCalls, boardCallsBefore + 2,
      "only the two canonical reads ran; the checkpoint read was never admitted over budget");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.investigation!.episode!.outcome, "aborted_budget");
    assert.ok(record.investigation!.episode!.evidence.some((entry) => entry.kind === "budget_exhausted"));

    // Small max_calls: admission blocks BEFORE the second read.
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.investigation_config = validateInvestigationConfigInput({ budget: { max_calls: 1 } });
      const target = monitor.investigation!.workers.find((entry) => entry.worker_key === reserved.worker_key)!;
      target.next_deep_check_at = 250_000;
      refreshInvestigationProjections(monitor.investigation!);
      return registry;
    });
    const statusBefore2 = state.statusCalls.length;
    assert.equal(await engineFactory(300_000).tick(), "investigated");
    assert.equal(state.statusCalls.length, statusBefore2 + 2,
      "observeWorkers probe + the single admitted investigation read; call #2 blocked before firing");
    const record2 = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record2.investigation!.episode!.outcome, "aborted_budget",
      "the second call is denied by admission control before it fires");
    assert.ok(record2.investigation!.episode!.evidence.some((entry) => entry.kind === "budget_exhausted"));
  } finally {
    await cleanup();
  }
});

test("Z1: observer probes persist fresh receipt-correlated evidence while a wake blocks; controlled release has no double dispatch", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    let releaseStatus!: (value: SessionStatusResult) => void;
    const hung = new Promise<SessionStatusResult>((resolve) => { releaseStatus = resolve; });
    let statusCallIndex = 0;
    let receiptCalls = 0;
    let hungSpent = false;
    let wakeProbeReleased = false;
    gateway.getSessionStatus = (_sessionId: string, messageId?: string) => {
      statusCallIndex += 1;
      if (messageId !== "msg_dispatch") return Promise.resolve(okStatus()); // manager-session reads stay neutral
      receiptCalls += 1;
      if (!wakeProbeReleased && !hungSpent) {
        hungSpent = true;
        return hung; // the wake's own observeWorkers read hangs until WE release it
      }
      if (wakeProbeReleased) return Promise.resolve(okStatus({ assistant_message_ids: [] }));
      // Observer probes: the backend CHANGED while the wake is blocked; the
      // probe is correlated by the worker's OWN dispatch receipt.
      return Promise.resolve(okStatus({ backend_activity: "retry", state: "running", assistant_message_ids: ["msg_dispatch"] }));
    };
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });
    // The wake blocks on its own await (never-resolving until WE release it).
    await advanceDue(project, 100_000);
    const blocked = engine.tick();
    for (let waited = 0; receiptCalls === 0 && waited < 50; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(receiptCalls, 1, "the wake's read is the hanging call");

    // Observer runs WHILE blocked: a real probe (receipt call #2) with the
    // changed backend status, persisted as fresh merged evidence.
    await engine.observe();
    assert.equal(receiptCalls, 2, "the observer performed a real gateway read");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const probeEntry = record.history.find((entry) => entry.type === "observer-probe");
    assert.ok(probeEntry, "fresh evidence persisted during the blocked wake");
    assert.equal((probeEntry!.detail as { worker_key?: string }).worker_key, reserved.worker_key, "attribution to the own worker only");
    assert.equal((probeEntry!.detail as { activity?: string }).activity, "retry");
    assert.equal(record.investigation!.last_progress_at, null, "probe evidence is never progress");
    assert.equal(record.run.active, true, "the living owner is never released by the observer");
    assert.equal(state.sends.length, 1);

    // Throttled: an immediate second observe adds NO new probe call.
    await engine.observe();
    assert.equal(receiptCalls, 2, "probe lane is throttled (one batch per window)");

    // Controlled release: the wake completes without a double dispatch.
    wakeProbeReleased = true;
    releaseStatus(okStatus({ assistant_message_ids: [] }));
    const outcome = await blocked;
    assert.equal(outcome, "dispatched");
    assert.equal(state.sends.length, 2, "exactly the worker-delta dispatch, no duplicate");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.run.active, false);
  } finally {
    await cleanup();
  }
});

test("Z1: observer probes are timeout-bounded and fail visibly without misattribution", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    // Only receipt-correlated worker reads hang; manager-session reads stay
    // neutral so the seed wake completes.
    gateway.getSessionStatus = (_sessionId: string, messageId?: string) => {
      if (messageId === "msg_dispatch") return new Promise<SessionStatusResult>(() => undefined);
      return Promise.resolve(okStatus());
    };
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policyConfigured, now: () => 100_000, engineGeneration: "gen-new" });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      monitor.investigation_config = validateInvestigationConfigInput({ budget: { call_timeout_ms: 250 } });
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    const monitorId = (await readRegistrySnapshot(project)).registry.monitors[0]!.id;
    const reserved = await reserveWorker(project, monitorId, { runtime_session_id: "ses_worker" }, { now: 100_400 });
    await confirmWorkerCreation(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", creation_receipt: "msg_create" }, { now: 100_500 });
    await rebindWorker(project, monitorId, reserved.worker_key, { runtime_session_id: "ses_worker", dispatch_receipt: "msg_dispatch" }, { now: 100_600 });

    // Simulate an in-flight wake (owner alive) and probe against the hung
    // gateway: the probe fails bounded and persists the failure honestly.
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.run = { active: true, started_at: new Date(100_000).toISOString(), action: null, owner_pid: process.pid, owner_generation: "gen-new" };
      return registry;
    });
    const startedAt = Date.now();
    await engine.observe();
    assert.ok(Date.now() - startedAt < 5_000, "probe wait bounded by call_timeout_ms");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const probeEntry = record.history.find((entry) => entry.type === "observer-probe");
    assert.ok(probeEntry, "the failed probe is persisted, not silent");
    assert.equal((probeEntry!.detail as { error?: string }).error, "CALL_TIMEOUT");
    assert.equal((probeEntry!.detail as { worker_key?: string }).worker_key, reserved.worker_key);
    assert.equal(record.run.active, true, "observer never releases the owner");
    assert.equal(state.sends.length, 1, "observer never sends");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// task_f2d0ccc6: engine behavior for manually disabled slots — real dispatch,
// update, park and recovery paths (never text-only assertions).
// ---------------------------------------------------------------------------

test("slot disabled: new dispatch skips the paused primary to its own fallback before any request, and reactivation restores the identical primary", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const paused = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null },
      { profileFallbacks: { deep: { provider_id: "deep-provider", model_id: "deep-fb" } }, disabled: { profiles: { deep: true } } });
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => paused, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "dispatched");
    assert.equal(state.updates.length, 1, "the disabled primary is never dispatched; the own fallback is applied");
    assert.deepEqual(state.updates[0], { provider_id: "deep-provider", model_id: "deep-fb" });
    assert.equal(state.sends.length, 1);
    // Re-enable the same slot: the identical stored primary is restored at the next new dispatch.
    const active = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null },
      { profileFallbacks: { deep: { provider_id: "deep-provider", model_id: "deep-fb" } } });
    await withRegistry(project, (registry) => { registry.monitors[0]!.state.last_seen_digest = "changed-again"; return registry; });
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => active, now: () => 200_000 });
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; return registry; });
    assert.equal(await engine2.tick(), "dispatched");
    assert.equal(state.updates.length, 2);
    assert.deepEqual(state.updates[1], { provider_id: "deep-provider", model_id: "deep-model" },
      "reactivation restores the byte-identical stored primary");
  } finally {
    await cleanup();
  }
});

test("slot disabled: every stored slot paused parks honestly without any provider request", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    const { gateway, board } = fakes(state);
    const paused = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null },
      { disabled: { profiles: { deep: true }, finalFallback: true },
        finalFallback: { mode: "total", selection: { provider_id: "fallback-provider", model_id: "fallback-model" } } });
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => paused, now: () => 100_000 });
    await withRegistry(project, (registry) => {
      const monitor = defaultMonitorRecord("M", TASK, { interval_seconds: 60 }, 100_000);
      monitor.scheduler.next_run_at = 0;
      monitor.state.last_seen_digest = "different";
      registry.monitors.push(monitor);
      return registry;
    });
    assert.equal(await engine.tick(), "runtime-unavailable");
    assert.equal(state.sends.length, 0, "no message is sent");
    assert.equal(state.updates.length, 0, "no runtime is switched");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required");
    assert.equal(record.state.parked_reason, "runtime-unavailable");
    const entry = record.history.find((item) => item.type === "runtime-unavailable");
    assert.ok(entry && JSON.stringify(entry.detail).includes("manually disabled"), JSON.stringify(entry?.detail));
    // A healthy wake after operator reactivation clears the stale park label.
    const active = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null });
    await withRegistry(project, (registry) => {
      registry.monitors[0]!.state.last_seen_digest = "changed-after-reactivation";
      registry.monitors[0]!.scheduler.next_run_at = 0;
      return registry;
    });
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => active, now: () => 200_000 });
    assert.equal(await engine2.tick(), "dispatched");
    const resumed = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(resumed.state.work, "active", "reactivation ends the park");
    assert.equal(resumed.state.parked_reason, undefined);
  } finally {
    await cleanup();
  }
});

test("slot disabled: a recovery chain exhausted only by paused slots parks as recovery-chain-disabled without attempts or requests", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_timeout");
    const { gateway, board } = fakes(state);
    // Legacy regime, mode total: the chain is exactly the global final stage — paused.
    const policy = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" } },
      { finalFallback: { mode: "total", selection: { provider_id: "fallback-provider", model_id: "fallback-model" } },
        disabled: { finalFallback: true } });
    await seededFailedMonitor(project);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000, log: () => undefined });
    assert.equal(await engine.tick(), "recovery-parked");
    assert.equal(state.sends.length, 0, "a paused fallback is never requested");
    assert.equal(state.updates.length, 0, "a paused fallback is never switched to");
    const record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required");
    assert.equal(record.state.parked_reason, "recovery-chain-disabled");
    assert.equal(record.recovery_episode?.attempts.length, 1,
      "only the really failed current runtime is an attempt; the paused slot is not");
    assert.deepEqual(record.recovery_episode?.attempts.map((entry) => entry.identity), ["deep-provider/deep-model"]);
    const resolution = record.recovery_resolution?.at(-1)!;
    assert.deepEqual(resolution.candidates, [{ label: "final.main", identity: "fallback-provider/fallback-model", status: "skipped_disabled" }]);
    assert.ok(record.history.some((entry) => entry.type === "recovery-chain-disabled"));
    // The paused chain is not restartable by trigger — reactivation is the explicit exit.
    await withRegistry(project, (registry) => {
      const monitor = registry.monitors[0]!;
      monitor.wake_request = { requested_at: new Date(250_000).toISOString(), reason: "operator" };
      monitor.scheduler.next_run_at = 0;
      return registry;
    });
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000, log: () => undefined });
    assert.equal(await engine2.tick(), "recovery-parked", "no trigger bypasses the manual pause");
    assert.equal(state.sends.length, 0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// task_68085480 part 3: sticky final — after the regular chain is exhausted an
// existing unattended monitor keeps dispatching exactly the configured global
// final stage on every suitable regular wake (no full-chain rerun, no permanent
// recovery-chain-exhausted park, no new timer/cadence).
// ---------------------------------------------------------------------------

test("task_68085480 sticky final: an exhausted unattended monitor retries exactly the global final stage on each suitable wake", async () => {
  const { project, cleanup } = await setup();
  try {
    const state = baseState();
    state.status = blockedStatus("provider_timeout");
    const { gateway, board } = fakes(state);
    const policy = perProfileView(
      { deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null },
      { strategies: { degrading: false, providerSkip: true },
        finalFallback: { mode: "total", selection: { provider_id: "fallback-provider", model_id: "fallback-model" } } });
    await seededFailedMonitor(project);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 200_000, log: () => undefined });
    // First wake: the regular primary is the failed current runtime; the final stage is dispatched.
    assert.equal(await engine.tick(), "recovery-continued");
    assert.equal(state.updates.length, 1);
    assert.equal(state.updates[0]!.model_id, "fallback-model");
    assert.equal(state.sends.length, 1);
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    const resolution = record.recovery_resolution?.at(-1)!;
    assert.equal(resolution.selected_identity, "fallback-provider/fallback-model");
    assert.equal(resolution.candidates.at(-1)!.label, "final.main");
    assert.equal(record.state.work, "active", "no permanent park after chain exhaustion");
    // Second suitable wake, still failing: the final stage is retried directly —
    // the failed regular chain is NOT rerun and no recovery-chain-exhausted park appears.
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; registry.monitors[0]!.state.last_seen_digest = "changed"; return registry; });
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => policy, now: () => 300_000, log: () => undefined });
    assert.equal(await engine2.tick(), "recovery-continued", "final is retried on the next suitable wake");
    assert.equal(state.sends.length, 2, "exactly one additional bounded dispatch per wake — no hot loop");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "active");
    assert.notEqual(record.state.parked_reason, "recovery-chain-exhausted", "no permanent chain-exhausted park");
    assert.ok(!record.history.some((entry) => entry.type === "recovery-chain-exhausted"), "chain exhaustion never parks while a final stage is configured");
    // The final stage remains gated by a real disable (F5 exception does not bypass a manual pause).
    const paused = perProfileView(
      { deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null },
      { strategies: { degrading: false, providerSkip: true },
        disabled: { finalFallback: true },
        finalFallback: { mode: "total", selection: { provider_id: "fallback-provider", model_id: "fallback-model" } } });
    await withRegistry(project, (registry) => { registry.monitors[0]!.scheduler.next_run_at = 0; registry.monitors[0]!.state.last_seen_digest = "changed2"; return registry; });
    const engine3 = new MonitorEngine({ project, gateway, board, readPolicy: async () => paused, now: () => 400_000, log: () => undefined });
    assert.equal(await engine3.tick(), "recovery-parked", "a manually disabled final stage is respected");
    record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(record.state.work, "parked_input_required");
    assert.ok(record.recovery_resolution?.at(-1)!.candidates.some((entry) => entry.label === "final.main" && entry.status === "skipped_disabled"),
      "the paused final stage is skipped, never dispatched");
  } finally {
    await cleanup();
  }
});

test("task_68085480 sticky final guards: unavailable final is skipped without dispatch; busy/unknown blocks a duplicate", async () => {
  const { project, cleanup } = await setup();
  try {
    // (b) final configured but catalog-unavailable -> skipped_unavailable, no dispatch, honest park.
    const state = baseState(); state.status = blockedStatus("provider_timeout");
    const { gateway, board } = fakes(state);
    const unavailable = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null },
      { strategies: { degrading: false, providerSkip: true },
        finalFallback: { mode: "total", selection: { provider_id: "fallback-provider", model_id: "fallback-gone" } } });
    await seededFailedMonitor(project);
    const engine = new MonitorEngine({ project, gateway, board, readPolicy: async () => unavailable, now: () => 200_000, log: () => undefined });
    assert.equal(await engine.tick(), "recovery-parked");
    assert.equal(state.sends.length, 0, "an unavailable final is never dispatched");
    let record = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.ok(record.recovery_resolution?.at(-1)!.candidates.some((entry) => entry.label === "final.main" && entry.status === "skipped_unavailable"));

    // (a) busy / unknown receipt must not produce a duplicate final dispatch.
    const ok = perProfileView({ deep: { provider_id: "deep-provider", model_id: "deep-model" }, standard: null },
      { strategies: { degrading: false, providerSkip: true },
        finalFallback: { mode: "total", selection: { provider_id: "fallback-provider", model_id: "fallback-model" } } });
    await withRegistry(project, (registry) => {
      const m = registry.monitors[0]!; m.state.work = "active"; m.state.parked_reason = undefined;
      m.scheduler.next_run_at = 0; m.state.last_seen_digest = "c"; return registry;
    });
    const engine2 = new MonitorEngine({ project, gateway, board, readPolicy: async () => ok, now: () => 300_000, log: () => undefined });
    assert.equal(await engine2.tick(), "recovery-continued", "the final is dispatched once");
    const afterFirst = state.sends.length;
    state.status = okStatus({ state: "running", backend_activity: "busy" });
    await withRegistry(project, (registry) => {
      const m = registry.monitors[0]!; m.scheduler.next_run_at = 0; m.state.last_seen_digest = "d"; return registry;
    });
    const engine3 = new MonitorEngine({ project, gateway, board, readPolicy: async () => ok, now: () => 400_000, log: () => undefined });
    const outcome = await engine3.tick();
    assert.ok(["busy-held", "noop-unchanged", "activity-observed"].includes(outcome), `busy blocks a duplicate final: got ${outcome}`);
    assert.equal(state.sends.length, afterFirst, "no duplicate final dispatch while the worker is busy/unknown");
  } finally {
    await cleanup();
  }
});
