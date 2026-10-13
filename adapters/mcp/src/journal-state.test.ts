import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityJournal } from "./activity.js";
import type { ActivitySnapshot } from "./types.js";

const snap = (id: string, activity: "idle" | "busy"): ActivitySnapshot => ({ session_id: id, session_title: id, activity, pending_input: { permissions: 0, questions: 0 }, messages: [] } as ActivitySnapshot);
import { computeJournalState } from "./opencode.js";

test("computeJournalState distinguishes disabled / ready / degraded / unavailable (task_68085480 part 3)", () => {
  assert.deepEqual(computeJournalState(false, true, false), { enabled: false, state: "disabled" });
  assert.deepEqual(computeJournalState(false, false, true), { enabled: false, state: "disabled" }, "opt-out wins");
  assert.deepEqual(computeJournalState(true, true, false), { enabled: true, state: "ready" });
  assert.deepEqual(computeJournalState(true, false, true), { enabled: true, state: "degraded" });
  assert.deepEqual(computeJournalState(true, false, false), { enabled: true, state: "unavailable" });
});

test("a latched journal commit failure is reported as degraded, never as ready, and is not auto-reset", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-journal-degraded-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "mcp");
  await mkdir(store, { mode: 0o700 });
  const journal = await ActivityJournal.open(join(store, "activity.json"), "project");
  await journal.observe(snap("s", "idle"), "observed");
  assert.equal(journal.available, true);
  assert.equal(journal.degraded, false);
  assert.deepEqual(computeJournalState(true, journal.available, journal.degraded), { enabled: true, state: "ready" });

  // Break the write target so the next commit latches the journal closed.
  await rm(store, { recursive: true, force: true });
  await assert.rejects(journal.observe(snap("s", "busy"), "observed"));
  assert.equal(journal.available, false);
  assert.equal(journal.degraded, true, "the failure latch stays closed (no auto-reset/reopen)");
  assert.deepEqual(computeJournalState(true, journal.available, journal.degraded), { enabled: true, state: "degraded" });
  // Opt-out dominates a degraded journal.
  assert.deepEqual(computeJournalState(false, journal.available, journal.degraded), { enabled: false, state: "disabled" });
});
