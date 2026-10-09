import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignMonitorAlias,
  confirmWorkerCreation,
  defaultMonitorRecord,
  getWorker,
  listWorkers,
  managerAliasFor,
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
  reserveWorker,
  reuseWorker,
  setWorkerLifecycle,
  setWorkerSynthesis,
  withRegistry,
  workerAliasFor,
} from "./monitor.js";
import {
  MonitorEngine,
  catalogAvailable,
  classifyEvidence,
  classifyRepairKind,
  fallbackChain,
} from "./monitor-engine.js";
import type { MonitorBoardLike, MonitorGatewayLike, MonitorPolicyView } from "./monitor-engine.js";
import type { AbortSessionTurnResult, RuntimeOptions, SessionStatusResult } from "./types.js";

const TASK = "task_11111111-1111-4111-8111-111111111111";

function runtimeOptions(): RuntimeOptions {
  return {
    agents: ["build"],
    providers: [
      { provider_id: "deep-provider", name: "Deep" },
      { provider_id: "fallback-provider", name: "Fallback" },
    ],
    models: [
      { provider_id: "deep-provider", model_id: "deep-model", name: "deep", variants: [] },
      { provider_id: "fallback-provider", model_id: "fallback-model", name: "fb", variants: [] },
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
  runtime: { provider_id: string; model_id: string };
  combinedPending: { permissions: number; questions: number } | null;
  combinedQueue: Array<{ permissions: number; questions: number } | null>;
  combinedThrows: boolean;
  abortPendingAfter: { permissions: number; questions: number } | null;
  abortActivityAfter: "idle" | "busy" | "retry";
  readFailCode: string | null;
  lostSessionId: string | null;
  createdSessionId: string;
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
        pending_input: { permissions: 0, questions: 0 },
      };
    },
    async getSessionStatus() {
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
      state.runtime = { provider_id: String(patch.provider_id), model_id: String(patch.model_id) };
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
    combinedPending: null,
    combinedQueue: [],
    combinedThrows: false,
    abortPendingAfter: { permissions: 0, questions: 0 },
    abortActivityAfter: "idle",
    readFailCode: null,
    lostSessionId: null,
    createdSessionId: "ses_monitor",
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
    assert.match(first, /\[MANAGEMENT-PRIMING mgmt-v2\]/);
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
    assert.match(state.sends[2]!, /\[MANAGEMENT-PRIMING mgmt-v2\]/);
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
    assert.match(state.sends[0]!, /\[MANAGEMENT-PRIMING mgmt-v2\]/);
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
    // EFBE-MVP-IMPLEMENTATION-20261009-R1, decision W1-D2): bounded at ~1100 tokens,
    // sent once per priming digest, never per tick.
    assert.ok(mission.length <= 1100, `mission text grew to ${mission.length} characters`);
    assert.ok(primedWake.length - mission.length <= 5200, `priming block grew to ${primedWake.length - mission.length} characters`);
    for (const marker of ["Mission: 1) verify progress", "exactly ONE next permitted step", "bounded no-op", "INPUT_REQUIRED only for a real missing decision"]) {
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
    assert.match(state.sends[0]!, /\[MANAGEMENT-PRIMING mgmt-v2\]/);
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
    assert.match(state.sends[1]!, /\[MANAGEMENT-PRIMING mgmt-v2\]/,
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
