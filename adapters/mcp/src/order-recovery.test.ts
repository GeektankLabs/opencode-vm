import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdapterError, type RuntimeDescriptor } from "./types.js";
import { MAX_RECOVERY_ATTEMPTS, getOrder, mutateRecoveryOrder, nextOrder, readRecoveryStore, recordAdmission, recoveryStorePath } from "./order-recovery.js";

async function setup(): Promise<{ project: string; runtime: RuntimeDescriptor; cleanup: () => Promise<void> }> {
  const project = await mkdtemp(join(tmpdir(), "ocvm-recovery-store-"));
  return { project, runtime: { project, projectHash: "p" } as RuntimeDescriptor, cleanup: () => rm(project, { recursive: true, force: true }) };
}

const SES = "ses_aaaa";
const MSG = "msg_bbbb";

test("recovery store: admission is idempotent and records only minimal provenance", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    const now = "2026-10-13T00:00:00Z";
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now });
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: "deep", now: "later" });
    const store = await readRecoveryStore(runtime);
    const order = getOrder(store, SES, MSG)!;
    assert.equal(order.status, "pending");
    assert.equal(order.final_attempted, false);
    assert.equal(order.profile, null, "an existing entry is never overwritten");
    assert.deepEqual(order.attempts, []);
    const raw = await readFile(recoveryStorePath(project), "utf8");
    assert.ok(!raw.includes("prompt") && !raw.includes("Bearer") && raw.length < 2048, "no prompts or secrets are persisted");
  } finally { await cleanup(); }
});

test("recovery store: write-ahead final flag survives a fresh read (restart/crash before dispatch)", async () => {
  const { runtime, cleanup } = await setup();
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    // Write-ahead: persist the final attempt before any (simulated) dispatch.
    await mutateRecoveryOrder(runtime, SES, MSG, (cur) => cur ? nextOrder(cur, {
      status: "final_attempted", final_attempted: true,
      attempts: [...cur.attempts, { at: "t1", identity: "p/m/high", outcome: "dispatch" }],
    }, "t1") : null);
    // "Restart": a brand-new read must still see the durable final flag.
    const store = await readRecoveryStore(runtime);
    const order = getOrder(store, SES, MSG)!;
    assert.equal(order.final_attempted, true);
    assert.equal(order.status, "final_attempted");
    assert.equal(order.attempts.length, 1);
    // A replay that refuses a consumed final cannot dispatch again.
    await assert.rejects(
      mutateRecoveryOrder(runtime, SES, MSG, (cur) => { if (cur?.final_attempted) throw new AdapterError("RECOVERY_ORDER_REJECTED", "consumed"); return null; }),
      { code: "RECOVERY_ORDER_REJECTED" });
    assert.equal((getOrder(await readRecoveryStore(runtime), SES, MSG))!.attempts.length, 1, "no state change on refusal");
  } finally { await cleanup(); }
});

test("recovery store: concurrent mutations serialize under the lock (no lost update)", async () => {
  const { runtime, cleanup } = await setup();
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    const append = (n: number) => mutateRecoveryOrder(runtime, SES, MSG, (cur) => cur ? nextOrder(cur, {
      attempts: [...cur.attempts, { at: `t${n}`, identity: `p/m${n}`, outcome: "dispatch" }],
    }, `t${n}`) : null);
    await Promise.all(Array.from({ length: 10 }, (_, n) => append(n)));
    const order = getOrder(await readRecoveryStore(runtime), SES, MSG)!;
    assert.equal(order.attempts.length, 10, "every concurrent mutation is applied exactly once");
  } finally { await cleanup(); }
});

test("recovery store: corrupt or unsafe store fails closed (recovery is not attempted)", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await mkdir(join(project, ".opencode-vm"), { recursive: true, mode: 0o700 });
    await writeFile(recoveryStorePath(project), "{ not json", "utf8");
    await assert.rejects(readRecoveryStore(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
    await writeFile(recoveryStorePath(project), JSON.stringify({ schema: 1, orders: { x: { session_id: 1 } } }), "utf8");
    await assert.rejects(readRecoveryStore(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
  } finally { await cleanup(); }
});

test("recovery store: attempts are bounded per order", async () => {
  const { runtime, cleanup } = await setup();
  try {
    await recordAdmission(runtime, { session_id: SES, message_id: MSG, profile: null, now: "t0" });
    for (let n = 0; n < MAX_RECOVERY_ATTEMPTS + 5; n += 1) {
      await mutateRecoveryOrder(runtime, SES, MSG, (cur) => cur ? nextOrder(cur, {
        attempts: [...cur.attempts, { at: `t${n}`, identity: `p/m${n}`, outcome: "x" }].slice(-MAX_RECOVERY_ATTEMPTS),
      }, `t${n}`) : null);
    }
    assert.equal(getOrder(await readRecoveryStore(runtime), SES, MSG)!.attempts.length, MAX_RECOVERY_ATTEMPTS);
  } finally { await cleanup(); }
});
