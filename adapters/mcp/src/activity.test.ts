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

test("Delivery B: tail selects newest matching events and preserves concurrent future events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-tail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  let journal = await ActivityJournal.open(path, "project");
  const start = journal.cursor;
  for (const activity of ["idle", "busy", "idle"] as const) {
    await journal.observe(snapshot("a", activity), "observed");
    await journal.observe(snapshot("b", activity), "observed");
  }
  const head = journal.cursor;
  let appended = false;
  const tail = await journal.read(
    { tail: true, limit: 2, session_ids: ["a"] },
    async () => {
      if (!appended) {
        appended = true;
        await journal.observe(snapshot("a", "busy"), "observed");
      }
      return true;
    },
  );
  assert.deepEqual(
    tail.events.map((event) => event.type),
    ["session.busy", "session.idle"],
  );
  assert.ok(tail.events[0]!.cursor < tail.events[1]!.cursor);
  assert.equal(tail.next_cursor, head);
  assert.equal(tail.has_more, false);
  assert.deepEqual(tail.tail, {
    selection_complete: true,
    earlier_events_not_examined: true,
  });
  const next = await journal.read(
    { after_cursor: tail.next_cursor, session_ids: ["a"] },
    async () => true,
  );
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0]?.type, "session.busy");
  assert.equal(next.filter_key, tail.filter_key);
  // Separate filter progress: A's high-water cursor must not replace B's cursor.
  const b = await journal.read(
    { after_cursor: start, session_ids: ["b"] },
    async () => true,
  );
  assert.equal(b.events.length, 3);
  assert.notEqual(b.filter_key, next.filter_key);
  const filterProgress = new Map([
    [next.filter_key, next.next_cursor],
    [b.filter_key, b.next_cursor],
  ]);
  await journal.close();
  journal = await ActivityJournal.open(path, "project");
  await journal.observe(snapshot("b", "busy"), "observed");
  const nextB = await journal.read(
    { after_cursor: filterProgress.get(b.filter_key), session_ids: ["b"] },
    async () => true,
  );
  assert.equal(nextB.events.length, 1);
  assert.equal(nextB.filter_key, b.filter_key);
  await journal.close();
});

test("Delivery B: tail budgets, empty windows, visibility and filter identity are explicit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-tail-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await ActivityJournal.open(
    join(directory, "activity.json"),
    "project",
  );
  const empty = await journal.read({ tail: true }, async () => true);
  assert.deepEqual(empty.events, []);
  assert.deepEqual(empty.tail, {
    selection_complete: true,
    earlier_events_not_examined: false,
  });
  for (const id of ["a", "b", "private"])
    await journal.observe(snapshot(id, "idle"), "observed");
  const visible = await journal.read(
    { tail: true, limit: 1 },
    async (id) => id !== "private",
  );
  assert.equal(visible.events[0]?.session_id, "b");
  assert.doesNotMatch(JSON.stringify(visible), /private/);
  const noMatches = await journal.read(
    { tail: true, session_ids: ["absent"] },
    async () => true,
  );
  assert.equal(noMatches.events.length, 0);
  assert.equal(noMatches.next_cursor, journal.cursor);
  assert.equal(noMatches.tail?.selection_complete, true);
  const first = await journal.read(
    {
      session_ids: ["a", "b", "a"],
      event_types: ["session.busy", "session.idle"],
      limit: 1,
    },
    async () => true,
  );
  const reordered = await journal.read(
    {
      tail: true,
      session_ids: ["b", "a"],
      event_types: ["session.idle", "session.busy"],
    },
    async () => true,
  );
  assert.equal(first.filter_key, reordered.filter_key);
  await assert.rejects(
    journal.read(
      { tail: true, after_cursor: journal.cursor },
      async () => true,
    ),
    { code: "INVALID_ARGUMENT" },
  );
  const now = Date.now;
  let clock = now();
  try {
    Date.now = () => clock;
    const limited = await journal.read({ tail: true, limit: 3 }, async () => {
      clock += 2000;
      return true;
    });
    assert.equal(limited.events.length, 1);
    assert.deepEqual(limited.tail, {
      selection_complete: false,
      earlier_events_not_examined: true,
    });
    assert.equal(limited.next_cursor, journal.cursor);
    assert.equal(limited.has_more, false); // head cursor is for future reads, not older tail records
  } finally {
    Date.now = now;
    await journal.close();
  }
});

test("Delivery B: tail cursors retain explicit rotation/epoch expiry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-tail-expiry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  let journal = await ActivityJournal.open(path, "project", 2);
  await journal.signal("a", "A", "idle");
  const tail = await journal.read({ tail: true }, async () => true);
  for (const id of ["b", "c", "d"]) await journal.signal(id, id, "idle");
  await assert.rejects(
    journal.read({ after_cursor: tail.next_cursor }, async () => true),
    { code: "CURSOR_EXPIRED" },
  );
  await journal.close();
  await rm(path);
  journal = await ActivityJournal.open(path, "project", 2);
  await assert.rejects(
    journal.read({ after_cursor: tail.next_cursor }, async () => true),
    { code: "CURSOR_EXPIRED" },
  );
  assert.equal(
    (await journal.read({ tail: true }, async () => true)).events.length,
    0,
  );
  await journal.close();
});
