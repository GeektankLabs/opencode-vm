import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultMonitorRecord,
  monitorHistory,
  monitorRegistryPath,
  readEpisode,
  readRegistrySnapshot,
  recordRepair,
  withRegistry,
} from "./monitor.js";
import {
  MonitorEngine,
  catalogAvailable,
  classifyEvidence,
  classifyRepairKind,
  fallbackChain,
} from "./monitor-engine.js";
import type { MonitorBoardLike, MonitorGatewayLike, MonitorPolicyView } from "./monitor-engine.js";
import type { RuntimeOptions, SessionStatusResult } from "./types.js";

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
};

function fakes(state: FakeState) {
  const gateway: MonitorGatewayLike = {
    async createSession(title: string) {
      return { project: { id: "p", name: "p" }, session_id: "ses_monitor", title, agent: "build", provider_id: "deep-provider", model_id: "deep-model", state: "created" };
    },
    async getSessionDetails() {
      return {
        id: "ses_monitor",
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
      return {
        session_id: "ses_monitor",
        state: state.abortState,
        observed_at: new Date(0).toISOString(),
        activity_after: "idle",
        pending_input_after: { permissions: 0, questions: 0 },
      };
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
    async getManagementHistory(_taskId: string, options: { mode: string }) {
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
