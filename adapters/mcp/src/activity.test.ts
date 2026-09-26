import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityJournal } from "./activity.js";
import { AdapterError } from "./types.js";
import type { ActivitySnapshot } from "./types.js";

function snapshot(id: string, activity: "idle" | "busy"): ActivitySnapshot {
  return {
    session_id: id,
    session_title: id,
    activity,
    pending_input: { permissions: 0, questions: 0 },
    messages: [],
  };
}

test("journal cursors persist, paginate and expire explicitly after retention/reset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  let journal = await ActivityJournal.open(path, "project", 3);
  const initial = journal.cursor;
  await journal.observe(snapshot("a", "idle"), "reconciled");
  await journal.observe(snapshot("b", "busy"), "observed");
  const page = await journal.read(
    { after_cursor: initial, limit: 1 },
    async () => true,
  );
  assert.equal(page.events.length, 1);
  assert.equal(page.has_more, true);
  const next = await journal.read(
    { after_cursor: page.next_cursor },
    async () => true,
  );
  assert.equal(next.events[0]?.session_id, "b");
  const checkpoint = journal.cursor;
  await journal.close();
  journal = await ActivityJournal.open(path, "project", 3);
  assert.equal(journal.cursor, checkpoint);
  assert.deepEqual(
    await journal.read({ after_cursor: page.next_cursor }, async () => true),
    next,
  );
  await journal.observe(snapshot("a", "busy"), "observed");
  await journal.observe(snapshot("a", "idle"), "observed");
  await assert.rejects(
    journal.read({ after_cursor: initial }, async () => true),
    (error) => error instanceof AdapterError && error.code === "CURSOR_EXPIRED",
  );
  const retained = await journal.read({}, async () => true);
  assert.equal(retained.events.length, 3);
  assert.deepEqual(
    retained.events.map((event) => event.cursor),
    retained.events.map((event) => event.cursor).sort(),
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await journal.close();
  await rm(path);
  journal = await ActivityJournal.open(path, "project", 3);
  await assert.rejects(
    journal.read({ after_cursor: checkpoint }, async () => true),
    (error) => error instanceof AdapterError && error.code === "CURSOR_EXPIRED",
  );
  await journal.close();
});

test("filters advance over skipped events, recheck visibility and support bounded waits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-filter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(
    join(directory, "activity.json"),
    "project",
  );
  const start = journal.cursor;
  await journal.observe(snapshot("private", "idle"), "observed");
  await journal.observe(snapshot("public", "busy"), "observed");
  const result = await journal.read(
    { after_cursor: start, event_types: ["session.busy"] },
    async (id) => id === "public",
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.session_id, "public");
  const empty = await journal.read(
    { after_cursor: start, session_ids: ["absent"] },
    async () => true,
  );
  assert.equal(empty.events.length, 0);
  assert.equal(empty.next_cursor, journal.cursor);
  const waiting = journal.wait(journal.cursor, 1000);
  await journal.signal("public", "public", "idle");
  await waiting;
  await journal.wait(journal.cursor, 1);
  await journal.close();
});

test("transient permission observations remain after resolution; no silent corruption reset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  const journal = await ActivityJournal.open(path, "project");
  await journal.signal("session", "Work", "permission");
  await journal.observe(snapshot("session", "idle"), "reconciled");
  const result = await journal.read(
    { event_types: ["session.input_required", "session.permission_required"] },
    async () => true,
  );
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[0]?.pending_input, {
    permissions: 1,
    questions: 0,
  });
  await journal.close();
  await writeFile(path, "invalid", { mode: 0o600 });
  await assert.rejects(
    ActivityJournal.open(path, "project"),
    (error) =>
      error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE",
  );
  assert.equal(await readFile(path, "utf8"), "invalid");
  await symlink(path, join(directory, "link.json"));
  await assert.rejects(
    ActivityJournal.open(join(directory, "link.json"), "project"),
  );
});

test("concurrent signals cannot overwrite committed message checkpoints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(
    join(directory, "activity.json"),
    "project",
  );
  await Promise.all([
    journal.submitted("session", "Work", "msg"),
    journal.signal("session", "Work", "busy"),
  ]);
  const completed: ActivitySnapshot = {
    ...snapshot("session", "idle"),
    messages: [
      {
        session_id: "session",
        message_id: "msg",
        backend_activity: "idle",
        state: "completed",
        pending_input: { permissions: 0, questions: 0 },
        assistant_message_ids: ["reply"],
      },
    ],
  };
  await Promise.all([
    journal.observe(completed, "observed"),
    journal.signal("session", "Work", "idle"),
  ]);
  await journal.observe(completed, "reconciled");
  const events = (await journal.read({}, async () => true)).events;
  assert.equal(
    events.filter((event) => event.type === "message.submitted").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "message.completed").length,
    1,
  );
  await journal.close();
});

test("slow visibility checks paginate instead of validating an entire backlog in one call", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(
    join(directory, "activity.json"),
    "project",
  );
  const start = journal.cursor;
  await journal.observe(snapshot("a", "idle"), "observed");
  await journal.observe(snapshot("b", "idle"), "observed");
  const now = Date.now;
  let clock = now();
  try {
    Date.now = () => clock;
    const page = await journal.read({ after_cursor: start }, async () => {
      clock += 2000;
      return true;
    });
    assert.equal(page.events.length, 1);
    assert.equal(page.has_more, true);
    const next = await journal.read(
      { after_cursor: page.next_cursor },
      async () => true,
    );
    assert.equal(next.events[0]?.session_id, "b");
  } finally {
    Date.now = now;
    await journal.close();
  }
});
