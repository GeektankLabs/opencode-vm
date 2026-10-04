import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectActivityJournalPath } from "./main.js";

test("project activity journal uses a private project-persistent directory and rejects symlinked state roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ocvm-project-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await projectActivityJournalPath(root);
  assert.equal(journal, join(root, ".opencode-vm", "mcp", "activity.json"));
  const info = await lstat(join(root, ".opencode-vm", "mcp"));
  assert.equal(info.isDirectory(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.mode & 0o777, 0o700);

  const outside = await mkdtemp(join(tmpdir(), "ocvm-project-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linked = join(root, "linked-project");
  await mkdir(linked);
  await symlink(outside, join(linked, ".opencode-vm"));
  await assert.rejects(projectActivityJournalPath(linked), /real directory/u);
});
