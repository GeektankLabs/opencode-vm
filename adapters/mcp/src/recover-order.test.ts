import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchMcp2Method } from "./tools.js";
import { recordAdmission } from "./order-recovery.js";
import type { SessionGateway } from "./opencode.js";
import type { CorrelatedErrorDetail, RuntimeDescriptor, RuntimeOptions, SessionDetailsResult, SessionStatusResult, SendMessageResult } from "./types.js";

const SES = "ses_recover";
const MSG = "msg_original";

function catalog(): RuntimeOptions {
  return {
    agents: ["build"],
    providers: [{ provider_id: "deep-provider", name: "D" }, { provider_id: "fb-provider", name: "F" }, { provider_id: "final-provider", name: "FF" }],
    models: [
      { provider_id: "deep-provider", model_id: "deep-model", name: "dm", variants: ["high"] },
      { provider_id: "fb-provider", model_id: "fb-model", name: "fm", variants: ["high"] },
      { provider_id: "final-provider", model_id: "final-model", name: "ffm", variants: ["high"] },
    ],
    truncated: false,
  };
}

function fake(state: { state: string; error?: CorrelatedErrorDetail; details?: Partial<SessionDetailsResult> }, initial = { provider_id: "deep-provider", model_id: "deep-model", variant: "high" }) {
  const runtimeState = { ...initial };
  let updateCalls = 0; let sends = 0; const dispatches: string[] = [];
  const gateway = {
    async getSessionDetails(): Promise<SessionDetailsResult> {
      return { id: SES, title: "Order", created: 1, updated: 2, activity: "idle", agent: "build",
        provider_id: runtimeState.provider_id, model_id: runtimeState.model_id, variant: runtimeState.variant,
        pending_input: { permissions: 0, questions: 0 }, ...state.details } as SessionDetailsResult;
    },
    async getSessionStatus(): Promise<SessionStatusResult> {
      return { session_id: SES, backend_activity: "idle", state: state.state as SessionStatusResult["state"],
        pending_input: { permissions: 0, questions: 0 }, assistant_message_ids: [],
        ...(state.error ? { error_details: [state.error] } : {}) };
    },
    async getSessionRuntimeOptions(): Promise<RuntimeOptions> { return catalog(); },
    async updateSessionRuntime(_id: string, patch: { provider_id: string; model_id: string; variant?: string }) {
      updateCalls += 1;
      dispatches.push(`${patch.provider_id}/${patch.model_id}`);
      runtimeState.provider_id = patch.provider_id; runtimeState.model_id = patch.model_id;
      if (patch.variant !== undefined) runtimeState.variant = patch.variant;
      return { session_id: SES, previous: {}, current: { agent: "build", ...patch, variant: patch.variant ?? "" }, state: "updated" as const };
    },
    async sendMessage(): Promise<SendMessageResult> { await new Promise((r) => setTimeout(r, 15)); sends += 1; return { session_id: SES, message_id: "msg_recovery", state: "submitted" }; },
  } as unknown as SessionGateway;
  return { gateway, calls: () => ({ updateCalls, sends }), dispatches: () => [...dispatches] };
}

const providerError: CorrelatedErrorDetail = { category: "provider_timeout", message: "timeout", detail_availability: "safe_template", source: "assistant_message_error", assistant_message_id: MSG, attribution: "exact_parent" };

async function project(schemaPolicy: Record<string, unknown>): Promise<{ project: string; runtime: RuntimeDescriptor; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ocvm-recover-tool-"));
  await mkdir(join(dir, ".opencode-vm"), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, ".opencode-vm", "agent-control.json"), `${JSON.stringify(schemaPolicy)}\n`);
  return { project: dir, runtime: { project: dir, projectHash: "p" } as RuntimeDescriptor, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const legacyFinalPolicy = {
  schemaVersion: 3, revision: 1, updatedAt: "2026-10-13T00:00:00Z",
  profiles: { deep: { provider_id: "deep-provider", model_id: "deep-model", variant: "high" }, standard: null, execution: null, design: null, review: null },
  finalFallback: { mode: "total", selection: { provider_id: "fb-provider", model_id: "fb-model", variant: "high" } },
};

// Per-profile regime: deep has its own fallback, plus the guaranteed global final stage.
const perProfilePolicy = {
  schemaVersion: 4, revision: 1, updatedAt: "2026-10-13T00:00:00Z",
  profiles: { deep: { provider_id: "deep-provider", model_id: "deep-model", variant: "high" }, standard: null, execution: null, design: null, review: null },
  profileFallbacks: { deep: { provider_id: "fb-provider", model_id: "fb-model", variant: "high" }, standard: null, execution: null, design: null, review: null },
  strategies: { degrading: null, providerSkip: null },
  finalFallback: { mode: "total", selection: { provider_id: "final-provider", model_id: "final-model", variant: "high" } },
};

async function call(gateway: SessionGateway, runtime: RuntimeDescriptor) {
  return dispatchMcp2Method(gateway, runtime, "tools/call", 1, { name: "recover_session_order", arguments: { session_id: SES, message_id: MSG } });
}
const structured = (r: unknown) => (r as { structuredContent?: Record<string, unknown>; isError?: boolean }).structuredContent;
const codeOf = (r: unknown) => (r as { _meta?: { "opencode-vm/error"?: { code?: string } } })._meta?.["opencode-vm/error"]?.code;

test("recover_session_order: no provenance -> RECOVERY_ORDER_UNKNOWN (no side effect)", async () => {
  const { runtime, cleanup } = await project(legacyFinalPolicy);
  try {
    const { gateway, calls } = fake({ state: "failed", error: providerError });
    const r = await call(gateway, runtime);
    assert.equal(codeOf(r), "RECOVERY_ORDER_UNKNOWN");
    assert.deepEqual(calls(), { updateCalls: 0, sends: 0 });
  } finally { await cleanup(); }
});

test("recover_session_order: non-failed / non-provider error are refused", async () => {
  const { runtime, cleanup } = await project(legacyFinalPolicy);
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    let r = await call(fake({ state: "running" }).gateway, runtime);
    assert.equal(codeOf(r), "RECOVERY_ORDER_REJECTED");
    r = await call(fake({ state: "failed", error: { ...providerError, category: "unknown" } }).gateway, runtime);
    assert.equal(codeOf(r), "RECOVERY_ORDER_REJECTED");
  } finally { await cleanup(); }
});

test("recover_session_order: dispatches the final stage exactly once, then refuses the replay (escalated)", async () => {
  const { runtime, cleanup } = await project(legacyFinalPolicy);
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    const { gateway, calls } = fake({ state: "failed", error: providerError });
    const first = await call(gateway, runtime);
    assert.equal(structured(first)?.status, "escalated");
    assert.equal(structured(first)?.final_attempt, true);
    assert.equal(structured(first)?.new_receipt, "msg_recovery");
    assert.deepEqual(calls(), { updateCalls: 1, sends: 1 }, "exactly one switch + one resend");
    // Replay after the consumed final attempt: refused, no second dispatch.
    const replay = await call(gateway, runtime);
    assert.equal(codeOf(replay), "RECOVERY_ORDER_REJECTED");
    assert.deepEqual(calls(), { updateCalls: 1, sends: 1 }, "no state change on replay");
  } finally { await cleanup(); }
});

test("recover_session_order: original entry profile survives the switched runtime across an adapter restart (F1)", async () => {
  const { runtime, cleanup } = await project(perProfilePolicy);
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    const st = { state: "failed", error: providerError };
    // First call: deep.main failed -> own fallback deep.fallback dispatched (regular step).
    const first = await call(fake(st).gateway, runtime);
    assert.equal(structured(first)?.status, "continued");
    assert.equal(structured(first)?.attempted_identity, "fb-provider/fb-model/high");
    // Second call after a SIMULATED ADAPTER RESTART: the session runtime is now the
    // switched candidate (fb), which maps to no profile. The persisted original profile
    // (deep) + entry identity must still drive the chain to the final stage.
    const restarted = fake(st, { provider_id: "fb-provider", model_id: "fb-model", variant: "high" });
    const second = await call(restarted.gateway, runtime);
    assert.equal(structured(second)?.status, "escalated");
    assert.equal(structured(second)?.final_attempt, true);
    assert.equal(structured(second)?.attempted_identity, "final-provider/final-model/high");
    assert.deepEqual(restarted.calls(), { updateCalls: 1, sends: 1 });
    // Replay of the consumed final attempt after the restart: refused, no dispatch.
    const replay = await call(restarted.gateway, runtime);
    assert.equal(codeOf(replay), "RECOVERY_ORDER_REJECTED");
    assert.deepEqual(restarted.calls(), { updateCalls: 1, sends: 1 });
  } finally { await cleanup(); }
});

test("recover_session_order: concurrent calls never dispatch the same candidate twice (F2)", async () => {
  const { runtime, cleanup } = await project(perProfilePolicy);
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    const st = { state: "failed", error: providerError };
    const { gateway, calls, dispatches } = fake(st);
    await Promise.all(Array.from({ length: 4 }, () => call(gateway, runtime)));
    const ids = dispatches();
    assert.equal(new Set(ids).size, ids.length, `a candidate was dispatched twice: ${JSON.stringify(ids)}`);
    assert.equal(calls().sends, calls().updateCalls, "exactly one verified switch per dispatch");
    assert.ok(ids.length >= 1 && ids.length <= 2, JSON.stringify(ids));
  } finally { await cleanup(); }
});

test("recover_session_order: a disabled final stage yields no allowed candidate (refused, no dispatch)", async () => {
  const policy = { ...legacyFinalPolicy, schemaVersion: 5, revision: 2,
    profileFallbacks: { deep: null, standard: null, execution: null, design: null, review: null },
    strategies: { degrading: null, providerSkip: null },
    disabled: { profiles: { deep: false, standard: false, execution: false, design: false, review: false },
      profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false }, finalFallback: true } };
  const { runtime, cleanup } = await project(policy);
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    const { gateway, calls } = fake({ state: "failed", error: providerError });
    const r = await call(gateway, runtime);
    assert.equal(codeOf(r), "RECOVERY_ORDER_REJECTED");
    assert.deepEqual(calls(), { updateCalls: 0, sends: 0 });
  } finally { await cleanup(); }
});
