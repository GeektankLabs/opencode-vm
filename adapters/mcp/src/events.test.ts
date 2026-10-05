import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityJournal } from "./activity.js";
import { McpEventBridge, isPublicAddress, signWebhook, validateCallbackUrl } from "./events.js";
import type { AttentionEntry } from "./types.js";

function secret(): string { return `whsec_${randomBytes(32).toString("base64")}`; }

function completion(): Parameters<ActivityJournal["observe"]>[0] {
  return {
    session_id: "ses_worker",
    session_title: "Worker A",
    activity: "idle",
    pending_input: { permissions: 0, questions: 0 },
    messages: [{
      session_id: "ses_worker",
      message_id: "msg_user",
      backend_activity: "idle",
      state: "completed",
      pending_input: { permissions: 0, questions: 0 },
      assistant_message_ids: ["msg_assistant"],
    }],
  };
}

function ready(entry: AttentionEntry): AttentionEntry {
  return {
    ...entry,
    lifecycle: "ready",
    source_revision: "visible-text-v1:revision",
    result_sha256: "b".repeat(64),
    prepared_at: new Date().toISOString(),
    prepared_summary: "Worker A completed; the original result is ready for review.",
    next_safe_step: "Review the result; no follow-up action was started.",
    task_id: "task_00000000-0000-4000-8000-000000000001",
    hierarchy_status: "resolved",
    evidence: { source: "visible_original", source_revision: "visible-text-v1:revision", sha256: "b".repeat(64), assistant_message_ids: ["msg_assistant"], complete: true },
  };
}

test("MCP Events webhook subscribe is idempotent, challenge-verified, signed, filtered, persistent and removable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(join(directory, "activity.json"), "project");
  const calls: Array<{ body: string; headers: Record<string, string> }> = [];
  const sender = async (_url: URL, body: string, headers: Record<string, string>) => {
    calls.push({ body, headers });
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    return { status: 200, body: parsed.type === "verification" ? JSON.stringify({ challenge: parsed.challenge }) : "{}" };
  };
  const bridge = new McpEventBridge(journal, "project-hash", sender);
  const signingSecret = secret();
  const params = {
    name: "worker.completed",
    arguments: { session_id: "ses_worker" },
    delivery: { mode: "webhook", url: "https://callbacks.example.test/mcp", secret: signingSecret },
    ttlMs: 60_000,
  };
  const subscribed = await bridge.handle("events/subscribe", params) as { id: string; refreshBefore: string; cursor: null; truncated: false };
  assert.match(subscribed.id, /^sub_[a-f0-9]{32}$/u);
  assert.ok(subscribed.refreshBefore);
  assert.equal(subscribed.cursor, null);
  assert.equal(subscribed.truncated, false);
  assert.equal(calls.length, 1, "callback challenge precedes activation");
  assert.match(calls[0]!.headers["webhook-signature"]!, /^v1,/u);

  const repeated = await bridge.handle("events/subscribe", { ...params, arguments: { session_id: "ses_worker" } }) as { id: string };
  assert.equal(repeated.id, subscribed.id, "canonical arguments preserve the same subscription id");
  assert.equal(calls.length, 2, "refresh verifies the callback before updating the lease");

  await journal.observe(completion(), "observed");
  const candidate = (await journal.pendingAttention())[0]!;
  await journal.prepareAttention(ready(candidate));
  await bridge.deliverPending();
  assert.equal(calls.length, 3);
  const delivery = calls[2]!;
  const event = JSON.parse(delivery.body) as { eventId: string; name: string; data: { message_id: string; prepared_summary: string; next_safe_step: string } };
  assert.equal(event.eventId, candidate.event_id);
  assert.equal(event.name, "worker.completed");
  assert.equal(event.data.message_id, "msg_user");
  assert.match(event.data.prepared_summary, /original result is ready/u);
  assert.match(delivery.headers["webhook-signature"]!, /^v1,/u);
  assert.equal(delivery.headers["webhook-id"], event.eventId);
  assert.equal(delivery.headers["X-MCP-Subscription-Id"], subscribed.id);
  const timestamp = delivery.headers["webhook-timestamp"]!;
  assert.equal(delivery.headers["webhook-signature"], `v1,${signWebhook(signingSecret, event.eventId, timestamp, delivery.body)}`);
  assert.equal((await journal.pendingDeliveries()).length, 0, "2xx is a transport receipt only");
  assert.equal((await journal.listAttention()).entries[0]?.lifecycle, "ready", "webhook receipt does not mark the conversation offered");

  const removed = await bridge.handle("events/unsubscribe", {
    name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url },
  });
  assert.deepEqual(removed, {});
  await assert.rejects(bridge.handle("events/unsubscribe", {
    name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url },
  }), { code: "EVENT_SUBSCRIPTION_NOT_FOUND" });
  await journal.close();
});

test("revised terminal error evidence advances attention cursors and gets a fresh webhook delivery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-revised-error-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(join(directory, "activity.json"), "project");
  const bridge = new McpEventBridge(journal, "project-hash", async (_url, body) => {
    const parsed = JSON.parse(body) as { challenge?: string };
    return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
  });
  const subscription = await bridge.handle("events/subscribe", {
    name: "worker.failed",
    arguments: { session_id: "ses_worker" },
    delivery: { mode: "webhook", url: "https://callbacks.example.test/mcp", secret: secret() },
    ttlMs: 60_000,
  }) as { id: string };
  const snapshot = completion();
  snapshot.messages[0]!.state = "failed";
  await journal.observe(snapshot, "observed");
  const original = (await journal.pendingAttention())[0]!;
  await journal.prepareAttention(ready(original));
  await bridge.deliverPending();
  assert.equal((await journal.attention(original.event_id))?.deliveries[subscription.id]?.state, "delivered");
  const cursor = (await journal.listAttention()).current_cursor;
  snapshot.messages[0]!.error_evidence_revision = "a".repeat(64);
  await journal.observe(snapshot, "observed");
  const revised = (await journal.pendingAttention())[0]!;
  assert.notEqual(revised.event_id, original.event_id);
  await journal.prepareAttention({ ...ready(revised), source_revision: "attention-v2:revised" });
  assert.equal((await journal.listAttention({ after_cursor: cursor })).entries[0]?.event_id, revised.event_id);
  assert.equal((await journal.pendingDeliveries()).length, 1);
  await bridge.deliverPending();
  assert.equal((await journal.attention(revised.event_id))?.deliveries[subscription.id]?.state, "delivered");
  await journal.observe(snapshot, "reconciled");
  assert.equal((await journal.pendingAttention()).length, 0, "unchanged evidence does not duplicate notifications");
  await journal.close();
});

test("MCP Events rejects malformed callback URLs and non-public callback addresses", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.1.2", "172.20.0.2", "192.168.1.1", "::1", "fc00::1", "fe80::1", "2001:10::1", "2001:db8::1", "2002:0808::1", "3fff::1"])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(address), true, address);
  for (const url of ["http://callback.example/", "https://user@callback.example/", "https://localhost/", "https://127.0.0.1/", "https://callback.example:8443/"])
    assert.throws(() => validateCallbackUrl(url), { code: "INVALID_ARGUMENT" });
  assert.equal(validateCallbackUrl("https://callbacks.example.test/hook").protocol, "https:");
});
