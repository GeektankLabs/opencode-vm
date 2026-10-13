import assert from "node:assert/strict";
import {
  mkdir,
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
import { ActivityJournal, __setCommitFsForTest, commitFailureLine, persistErrorClass, safeCommitErrno, safeCommitSyscall } from "./activity.js";
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

test("project-persistent journal adopts the prior session journal once without replacing later project state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyDirectory = join(directory, "session-mcp");
  const projectDirectory = join(directory, "project-mcp");
  await mkdir(legacyDirectory, { mode: 0o700 });
  await mkdir(projectDirectory, { mode: 0o700 });
  const legacyPath = join(legacyDirectory, "activity.json");
  const source = await ActivityJournal.open(legacyPath, "project");
  await source.signal("ses", "Worker", "busy");
  const cursor = source.cursor;
  await source.close();
  const targetPath = join(projectDirectory, "activity.json");
  const migrated = await ActivityJournal.open(targetPath, "project", 5000, legacyPath);
  assert.equal(migrated.cursor, cursor);
  assert.equal((await migrated.read({}, async () => true)).events[0]?.session_id, "ses");
  await migrated.signal("ses", "Worker", "idle");
  await migrated.close();
  const later = await ActivityJournal.open(targetPath, "project", 5000, legacyPath);
  assert.notEqual(later.cursor, cursor);
  assert.equal((await later.read({}, async () => true)).events.at(-1)?.state, "idle");
  await later.close();
  assert.equal((await readFile(legacyPath, "utf8")).includes('"state":"busy"'), true, "migration leaves old bytes intact");
});

test("legacy migration rejects persisted error details that are not safe projections", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-error-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyDirectory = join(directory, "session-mcp");
  const projectDirectory = join(directory, "project-mcp");
  await mkdir(legacyDirectory, { mode: 0o700 });
  await mkdir(projectDirectory, { mode: 0o700 });
  const legacyPath = join(legacyDirectory, "activity.json");
  const source = await ActivityJournal.open(legacyPath, "project");
  await source.observe({
    session_id: "ses",
    session_title: "Worker",
    activity: "idle",
    pending_input: { permissions: 0, questions: 0 },
    messages: [{
      session_id: "ses",
      message_id: "msg_user",
      backend_activity: "idle",
      state: "failed",
      pending_input: { permissions: 0, questions: 0 },
      assistant_message_ids: ["msg_assistant"],
    }],
  }, "observed");
  const entry = (await source.pendingAttention())[0]!;
  await source.prepareAttention({
    ...entry,
    lifecycle: "ready",
    source_revision: "attention-v2:test",
    result_sha256: "a".repeat(64),
    prepared_at: new Date().toISOString(),
    prepared_summary: "Worker failed.",
    next_safe_step: "Review the original failure evidence.",
    hierarchy_status: "unlinked",
    error_details: [{
      category: "provider_header_timeout",
      name: "APIError",
      code: "ProviderHeaderTimeoutError",
      timeout_ms: 300000,
      message: "Provider response headers timed out after 300000ms.",
      detail_availability: "safe_template",
      source: "assistant_message_error",
      assistant_message_id: "msg_assistant",
      attribution: "exact_parent",
    }],
    error_details_total: 1,
    error_details_truncated: false,
    evidence: {
      source: "visible_original",
      source_revision: "attention-v2:test",
      sha256: "a".repeat(64),
      assistant_message_ids: ["msg_assistant"],
      complete: true,
    },
  });
  await source.close();
  const raw = JSON.parse(await readFile(legacyPath, "utf8")) as {
    attention: Record<string, {
      error_details: Array<{ message: string }>;
      error_details_total: number;
      error_details_truncated: boolean;
    }>;
  };
  const persisted = Object.values(raw.attention)[0]!;
  persisted.error_details[0]!.message = "Bearer PRIVATE_TOKEN";
  await writeFile(legacyPath, JSON.stringify(raw) + "\n", { mode: 0o600 });
  const targetPath = join(projectDirectory, "activity.json");
  await assert.rejects(
    ActivityJournal.open(targetPath, "project", 5000, legacyPath),
    (error) => error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE",
  );
  await assert.rejects(readFile(targetPath, "utf8"),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const fresh = await ActivityJournal.open(targetPath, "project");
  await fresh.close();
  assert.doesNotMatch(await readFile(targetPath, "utf8"), /PRIVATE_TOKEN/u);
  persisted.error_details = [];
  persisted.error_details_total = 0;
  persisted.error_details_truncated = false;
  await writeFile(legacyPath, JSON.stringify(raw) + "\n", { mode: 0o600 });
  const emptyDetailsTarget = join(projectDirectory, "empty-details.json");
  await assert.rejects(
    ActivityJournal.open(emptyDetailsTarget, "project", 5000, legacyPath),
    (error) => error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE",
  );
  await assert.rejects(readFile(emptyDetailsTarget, "utf8"),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("a failed commit logs a bounded metadata class and keeps the fail-closed latch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-commit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "mcp");
  await mkdir(store, { mode: 0o700 });
  const journal = await ActivityJournal.open(join(store, "activity.json"), "project");
  await journal.observe(snapshot("a", "idle"), "observed");

  // Deterministic and root-safe: with the private directory gone, creating the
  // temporary file fails with ENOENT for any uid — no chmod/permission trickery.
  await rm(store, { recursive: true, force: true });

  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      journal.observe(snapshot("b", "busy"), "observed"),
      (error) => error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE",
    );
    const logged = lines.filter((line) => line.startsWith("[mcp] activity-commit-failed"));
    assert.equal(logged.length, 1, "exactly one bounded diagnostic line per failed commit");
    // Field order and allowlists are fixed; the open phase fails with ENOENT here.
    assert.match(logged[0]!,
      /^\[mcp\] activity-commit-failed phase=(open|write|sync|close|rename) class=[A-Za-z0-9_]{1,40} syscall=[a-z0-9_]+ errno=-?[0-9a-z]+ path=(journal|journal-temp) rss_kb=[0-9a-z]+ at=\d{4}-\d{2}-\d{2}T[\d:.]+Z pid=\d+\n$/u);
    assert.ok(logged[0]!.includes("phase=open class=ENOENT"), "the real first-failure phase and code are reported");
    assert.ok(logged[0]!.includes("path=journal-temp"), "only a logical path role is emitted");
    assert.ok(!logged[0]!.includes(directory), "no path reaches the log");

    // The latch stays closed: further commits fail on the pre-check without a
    // second write attempt, without a second log line and without a reset.
    lines.length = 0;
    await assert.rejects(
      journal.observe(snapshot("c", "idle"), "observed"),
      (error) => error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE",
    );
    await assert.rejects(
      journal.signal("a", "Title", "idle"),
      (error) => error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE",
    );
    assert.equal(lines.filter((line) => line.startsWith("[mcp] activity-commit-failed")).length, 0,
      "a latched journal neither retries nor reopens");
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
    await journal.close().catch(() => undefined);
  }

  // The sanitizer itself never emits paths, payloads or secrets.
  assert.equal(persistErrorClass(Object.assign(new Error("boom"), { code: "ENOSPC" })), "ENOSPC");
  assert.equal(persistErrorClass(Object.assign(new Error("boom"), { code: "EACCES" })), "EACCES");
  assert.equal(persistErrorClass(new Error("/tmp/secret/activity.json Bearer TOKEN")), "Error");
  assert.equal(persistErrorClass(Object.assign(new Error("boom"), { code: "/etc/passwd" })), "Error");
  assert.equal(persistErrorClass(Object.assign(new Error("boom"), { code: "BEARER_TOKEN_VALUE" })), "Error",
    "an uppercase non-errno code is not emitted verbatim");
  assert.equal(persistErrorClass(Object.assign(new Error("boom"), { code: "ERR_FS_EISDIR" })), "ERR_FS_EISDIR");
  assert.equal(persistErrorClass(undefined), "unknown");
});

test("commit first-failure diagnostics are allowlisted, redacted and bounded", () => {
  const fixed = { now: new Date("2026-10-13T00:00:00.000Z"), pid: 4242, rssKb: "1234" };
  const err = (extra: Record<string, unknown>) => Object.assign(new Error("raw /etc/passwd Bearer TOKEN prompt"), extra);

  // A benign open failure: allowlisted phase/code/syscall, logical path role only.
  const line = commitFailureLine("open", err({ code: "ENOENT", syscall: "open", errno: -2 }), "journal-temp", fixed);
  assert.equal(line,
    "[mcp] activity-commit-failed phase=open class=ENOENT syscall=open errno=-2 path=journal-temp rss_kb=1234 at=2026-10-13T00:00:00.000Z pid=4242\n");

  // Unknown/unlisted phase, path role, syscall and errno degrade to "unknown".
  const odd = commitFailureLine("frobnicate", err({ code: "ENFILE", syscall: "/secret/bin", errno: "x" }), "/Users/private/mcp", fixed);
  assert.equal(odd,
    "[mcp] activity-commit-failed phase=unknown class=ENFILE syscall=unknown errno=unknown path=unknown rss_kb=1234 at=2026-10-13T00:00:00.000Z pid=4242\n");

  // Dangerous/raw codes never appear verbatim; the raw message never leaks.
  for (const bad of ["/etc/passwd", "BEARER_TOKEN_VALUE", "secret-token", "sk-abcdefghijklmnopqrstuv"]) {
    const rendered = commitFailureLine("write", err({ code: bad }), "journal-temp", fixed);
    assert.ok(!rendered.includes(bad), `dangerous code not emitted: ${bad}`);
    assert.ok(rendered.includes(`class=${persistErrorClass(err({ code: bad }))}`));
  }
  for (const rendered of [line, odd]) {
    assert.ok(!rendered.includes("passwd") && !rendered.includes("Bearer") && !rendered.includes("TOKEN")
      && !rendered.includes("prompt") && !rendered.includes("/Users"), "no raw error string, path or secret leaks");
    assert.ok(!rendered.includes("\n\n") && rendered.endsWith("\n"), "exactly one terminated line");
  }

  // Best-effort resource metadata degrades to "unknown" without an extra probe.
  assert.ok(commitFailureLine("close", err({ code: "EMFILE" }), "journal-temp", { ...fixed, rssKb: "unknown" })
    .includes("rss_kb=unknown"));

  // Helper allowlists.
  assert.equal(safeCommitSyscall({ syscall: "fsync" }), "fsync");
  assert.equal(safeCommitSyscall({ syscall: "execve" }), "unknown");
  assert.equal(safeCommitSyscall({}), "unknown");
  assert.equal(safeCommitErrno({ errno: 28 }), "28");
  assert.equal(safeCommitErrno({ errno: 1.5 }), "unknown");
  assert.equal(safeCommitErrno({}), "unknown");
});

test("commit fault injection: real open/write/sync/close/rename/cleanup phases keep one bounded log and the primary error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-fault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "mcp"); await mkdir(store, { mode: 0o700 });
  const path = join(store, "activity.json");

  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
  t.after(() => { (process.stderr as unknown as { write: unknown }).write = originalWrite; __setCommitFsForTest(null); });

  const commitErr = (code: string, syscall: string) => Object.assign(new Error("raw /etc/passwd Bearer TOKEN payload"), { code, syscall, errno: 2 });

  // Each case gets a fresh journal (the latch is per instance) and one injected
  // phase failure; secondary failures must never mask the primary or add a log.
  const runCase = async (opts: { openErr?: unknown; writeErr?: unknown; syncErr?: unknown; closeErr?: unknown; renameErr?: unknown; unlinkErr?: unknown; loggerErr?: boolean }, expectedPhase: string, expectedClass: string) => {
    const journal = await ActivityJournal.open(path, "project");
    await journal.observe(snapshot("seed", "idle"), "observed"); // real fs: establish a valid journal
    let closed = 0;
    const handle = {
      writeFile: async () => { if (opts.writeErr) throw opts.writeErr; },
      sync: async () => { if (opts.syncErr) throw opts.syncErr; },
      close: async () => { closed += 1; if (opts.closeErr) throw opts.closeErr; },
    };
    __setCommitFsForTest({
      open: (async () => { if (opts.openErr) throw opts.openErr; return handle; }) as unknown as typeof import("node:fs/promises").open,
      rename: (async () => { if (opts.renameErr) throw opts.renameErr; }) as unknown as typeof import("node:fs/promises").rename,
      unlink: (async () => { if (opts.unlinkErr) throw opts.unlinkErr; }) as unknown as typeof import("node:fs/promises").unlink,
    });
    const before = lines.length;
    if (opts.loggerErr) (process.stderr as unknown as { write: () => boolean }).write = () => { throw new Error("logger ENOSPC"); };
    await assert.rejects(
      journal.observe(snapshot("next", "busy"), "observed"),
      (error) => error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE",
      `${expectedPhase}: fail-closed`,
    );
    if (opts.loggerErr) (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
    const produced = lines.slice(before).filter((line) => line.startsWith("[mcp] activity-commit-failed"));
    if (opts.loggerErr) {
      assert.equal(produced.length, 0, "a failing logger must not crash and must not surface a raw error");
    } else {
      assert.equal(produced.length, 1, `${expectedPhase}: exactly one bounded log per latch`);
      assert.ok(produced[0]!.includes(`phase=${expectedPhase}`), `${expectedPhase}: phase reported`);
      assert.ok(produced[0]!.includes(`class=${expectedClass}`), `${expectedPhase}: primary class reported`);
      assert.ok(!produced[0]!.includes(directory) && !produced[0]!.includes("passwd") && !produced[0]!.includes("TOKEN"), `${expectedPhase}: redacted`);
    }
    assert.ok(closed <= 1, `${expectedPhase}: no file-descriptor leak (close at most once)`);
    // Latch stays closed: a further commit neither retries nor re-logs.
    const after = lines.length;
    await assert.rejects(journal.observe(snapshot("later", "idle"), "observed"),
      (error) => error instanceof AdapterError && error.code === "ACTIVITY_UNAVAILABLE");
    assert.equal(lines.length, after, `${expectedPhase}: latched journal never retries or reopens`);
    __setCommitFsForTest(null);
    await journal.close().catch(() => undefined);
  };

  await runCase({ openErr: commitErr("ENOENT", "open") }, "open", "ENOENT");
  await runCase({ writeErr: commitErr("ENOSPC", "write") }, "write", "ENOSPC");
  await runCase({ syncErr: commitErr("ENFILE", "fsync") }, "sync", "ENFILE");
  await runCase({ closeErr: commitErr("EIO", "close") }, "close", "EIO");
  await runCase({ renameErr: commitErr("EXDEV", "rename") }, "rename", "EXDEV");
  // Secondary close failure after a primary write failure: primary preserved.
  await runCase({ writeErr: commitErr("ENOSPC", "write"), closeErr: commitErr("EIO", "close") }, "write", "ENOSPC");
  // Secondary cleanup (unlink) failure must not mask the primary.
  await runCase({ writeErr: commitErr("ENOSPC", "write"), unlinkErr: commitErr("EACCES", "unlink") }, "write", "ENOSPC");
  // Explicit logger failure: no crash, fail-closed unchanged, no raw error.
  await runCase({ writeErr: commitErr("ENOSPC", "write"), loggerErr: true }, "write", "ENOSPC");

  // A fully successful commit with the seam active still flips the store and
  // closes the descriptor exactly once.
  const okJournal = await ActivityJournal.open(path, "project");
  let okClosed = 0;
  __setCommitFsForTest({
    open: (async () => ({ writeFile: async () => {}, sync: async () => {}, close: async () => { okClosed += 1; } })) as unknown as typeof import("node:fs/promises").open,
    rename: (async () => {}) as unknown as typeof import("node:fs/promises").rename,
    unlink: (async () => {}) as unknown as typeof import("node:fs/promises").unlink,
  });
  await okJournal.observe(snapshot("ok", "idle"), "observed");
  assert.equal(okClosed, 1, "exactly one descriptor closed on the success path");
  assert.equal(okJournal.available, true);
  __setCommitFsForTest(null);
  await okJournal.close().catch(() => undefined);
});

test("filters advance over skipped events, recheck visibility and support bounded waits", async (t) => {  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-filter-"));
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
