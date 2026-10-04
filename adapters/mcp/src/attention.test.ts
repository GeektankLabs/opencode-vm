import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attentionClass, deliveryPolicy, summarizeAttention } from "./attention.js";
import { ActivityJournal } from "./activity.js";
import type { ActivityEvent, ActivitySnapshot, AttentionEntry } from "./types.js";

function terminalSnapshot(sessionId: string, messageId: string, state: "completed" | "failed" | "aborted" = "completed"): ActivitySnapshot {
  return {
    session_id: sessionId,
    session_title: `Worker ${sessionId}`,
    activity: "idle",
    pending_input: { permissions: 0, questions: 0 },
    messages: [{
      session_id: sessionId,
      message_id: messageId,
      backend_activity: "idle",
      state,
      pending_input: { permissions: 0, questions: 0 },
      assistant_message_ids: [`assistant_${messageId}`],
    }],
  };
}

function prepared(entry: AttentionEntry, taskId = "task_00000000-0000-4000-8000-000000000001"): AttentionEntry {
  return {
    ...entry,
    lifecycle: "ready",
    source_revision: `revision-${entry.event_id}`,
    result_sha256: "a".repeat(64),
    prepared_at: new Date().toISOString(),
    prepared_summary: "Worker result is ready.",
    next_safe_step: "Read and review; do not dispatch automatically.",
    hierarchy_status: "unlinked",
    task_id: taskId,
    evidence: { source: "visible_original", assistant_message_ids: entry.assistant_message_ids, complete: true },
  };
}

test("activity events classify completed, failure, abort and input without turning progress into attention", () => {
  const base = (type: ActivityEvent["type"]): ActivityEvent => ({
    event_id: `event-${type}`, cursor: "cursor", timestamp: new Date().toISOString(),
    session_id: "session", session_title: "Worker", type, state: type, assistant_message_ids: [], source: "observed",
  });
  assert.equal(attentionClass(base("message.completed")), "ready");
  assert.equal(attentionClass(base("message.failed")), "attention");
  assert.equal(attentionClass(base("message.aborted")), "attention");
  assert.equal(attentionClass(base("session.input_required")), "action_required");
  assert.equal(attentionClass(base("session.busy")), undefined);
  const summary = summarizeAttention({
    event_id: "event", activity_cursor: "cursor", event_sequence: 1, event_type: "message.completed",
    classification: "ready", lifecycle: "new", session_id: "session", session_title: "Worker",
    assistant_message_ids: [], occurred_at: new Date().toISOString(), observed_at: new Date().toISOString(),
    prepared_summary: "", next_safe_step: "", hierarchy_status: "pending", delivery_policy: "on_demand_fallback", deliveries: {},
  }, "SECRET_RESPONSE is private.", "revision", "hash", []);
  assert.doesNotMatch(summary.prepared_summary, /SECRET_/u);
  assert.match(summary.prepared_summary, /\[REDACTED\]/u);
  assert.match(summary.next_safe_step, /no follow-up was started/u);
});

test("delivery policy requires confirmed proactive monitoring and defers only with explicit host support", () => {
  assert.equal(deliveryPolicy({ proactiveMonitoringConfirmed: false, conversationBusy: false, hostSupportsDeferredDelivery: true }), "on_demand_fallback");
  assert.equal(deliveryPolicy({ proactiveMonitoringConfirmed: true, conversationBusy: false, hostSupportsDeferredDelivery: false }), "immediate_proactive_wakeup");
  assert.equal(deliveryPolicy({ proactiveMonitoringConfirmed: true, conversationBusy: true, hostSupportsDeferredDelivery: true }), "deferred_to_next_idle_boundary");
  assert.equal(deliveryPolicy({ proactiveMonitoringConfirmed: true, conversationBusy: true, hostSupportsDeferredDelivery: false }), "on_demand_fallback");
  assert.equal(deliveryPolicy({ proactiveMonitoringConfirmed: true, conversationBusy: "unknown", hostSupportsDeferredDelivery: false }), "immediate_proactive_wakeup");
});

test("persistent attention deduplicates events, protects newer task evidence and tracks presentation separately", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-attention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  let journal = await ActivityJournal.open(path, "project");
  await journal.observe(terminalSnapshot("session", "message_old"), "observed");
  const old = (await journal.pendingAttention())[0]!;
  assert.equal(old.lifecycle, "new");
  await journal.observe(terminalSnapshot("session", "message_old"), "reconciled");
  assert.equal((await journal.pendingAttention()).length, 1, "same observed event does not enqueue twice");
  await journal.prepareAttention(prepared(old));
  await journal.observe(terminalSnapshot("session", "message_new"), "observed");
  const newer = (await journal.pendingAttention())[0]!;
  await journal.prepareAttention(prepared(newer));
  await journal.prepareAttention(prepared(old));
  const listed = await journal.listAttention({ lifecycle: ["ready", "offered", "superseded"] });
  assert.equal(listed.entries.find((entry) => entry.event_id === old.event_id)?.lifecycle, "superseded");
  const live = listed.entries.find((entry) => entry.event_id === newer.event_id)!;
  assert.equal(live.lifecycle, "ready");
  const offered = await journal.attentionReceipt({ event_id: live.event_id, source_revision: live.source_revision!, lifecycle: "offered" });
  assert.equal(offered.lifecycle, "offered");
  assert.equal((await journal.attentionReceipt({ event_id: live.event_id, source_revision: live.source_revision!, lifecycle: "offered" })).lifecycle, "offered");
  const discussed = await journal.attentionReceipt({ event_id: live.event_id, source_revision: live.source_revision!, lifecycle: "discussed" });
  assert.equal(discussed.lifecycle, "discussed");
  await assert.rejects(journal.attentionReceipt({ event_id: live.event_id, source_revision: "stale", lifecycle: "discussed" }), { code: "ATTENTION_CHANGED" });
  await journal.close();
  journal = await ActivityJournal.open(path, "project");
  const restored = await journal.listAttention({ lifecycle: ["discussed", "superseded"] });
  assert.deepEqual(new Set(restored.entries.map((entry) => entry.lifecycle)), new Set(["discussed", "superseded"]));
  const persisted = await readFile(path, "utf8");
  assert.match(persisted, /prepared_summary/u);
  assert.doesNotMatch(persisted, /SECRET_RESPONSE/u);
  await journal.close();
});

test("incomplete queue entries cannot be acknowledged or interpreted as completed business work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-attention-states-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(join(directory, "activity.json"), "project");
  await journal.observe(terminalSnapshot("session", "message_failed", "failed"), "observed");
  const entry = (await journal.pendingAttention())[0]!;
  assert.equal(entry.classification, "attention");
  await assert.rejects(journal.attentionReceipt({ event_id: entry.event_id, source_revision: "revision", lifecycle: "offered" }), { code: "ATTENTION_NOT_FOUND" });
  await journal.close();
});

test("attention retention preserves unresolved entries and expires cursors after acknowledged history is pruned", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-attention-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(join(directory, "activity.json"), "project", 2);
  const initialCursor = (await journal.listAttention()).current_cursor;
  for (const id of ["one", "two", "three"]) {
    await journal.observe(terminalSnapshot("session", id), "observed");
    const entry = (await journal.pendingAttention())[0]!;
    await journal.prepareAttention(prepared(entry));
    const current = (await journal.listAttention({ classification: ["ready"] })).entries[0]!;
    await journal.attentionReceipt({ event_id: current.event_id, source_revision: current.source_revision!, lifecycle: "offered" });
    await journal.attentionReceipt({ event_id: current.event_id, source_revision: current.source_revision!, lifecycle: "discussed" });
  }
  assert.equal((await journal.listAttention({ lifecycle: ["ready", "offered", "discussed", "superseded"] })).entries.length, 2);
  await assert.rejects(journal.listAttention({ after_cursor: initialCursor }), { code: "CURSOR_EXPIRED" });
  await journal.close();
});
