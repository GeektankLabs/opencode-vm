import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitFinalFallback, validateFinalFallbackValue } from "./policy-commit.js";
import type { RuntimeDescriptor } from "./types.js";

const selection = { provider_id: "p", model_id: "m", variant: "high" };
const fallback = { mode: "degrading" as const, selection };

function runtimeFor(project: string): RuntimeDescriptor {
  return { project, projectHash: "project-id" } as RuntimeDescriptor;
}

async function setup(): Promise<{ project: string; runtime: RuntimeDescriptor; cleanup: () => Promise<void> }> {
  const project = await mkdtemp(join(tmpdir(), "policy-commit-"));
  return { project, runtime: runtimeFor(project), cleanup: () => rm(project, { recursive: true, force: true }) };
}

const policyPath = (project: string) => join(project, ".opencode-vm", "agent-control.json");

async function writePolicy(project: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(project, ".opencode-vm"), { recursive: true, mode: 0o700 });
  await writeFile(policyPath(project), `${JSON.stringify(value)}\n`);
}

test("fallback validation mirrors the Python store exactly", () => {
  assert.equal(validateFinalFallbackValue(null), null);
  assert.deepEqual(validateFinalFallbackValue({ selection }), { mode: "total", selection });
  assert.deepEqual(validateFinalFallbackValue({ mode: "degrading", selection }), { mode: "degrading", selection });
  for (const bad of [
    { mode: "sometimes", selection },
    { selection: { ...selection, extra: "x" } },
    { selection: { ...selection, provider_id: "/etc/passwd" } },
    { selection: { ...selection, model_id: "sk-abcdefghijklmnopqrstuv" } },
    { mode: "total" },
    "selection",
  ]) {
    assert.throws(() => validateFinalFallbackValue(bad), { code: "INVALID_ARGUMENT" });
  }
});

test("setting on a missing policy creates schema 3 revision 1 without a backup", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    const updated = await commitFinalFallback(runtime, 0, fallback);
    assert.equal(updated.schemaVersion, 3);
    assert.equal(updated.revision, 1);
    assert.deepEqual(updated.finalFallback, fallback);
    const persisted = JSON.parse(await readFile(policyPath(project), "utf8"));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(persisted.revision, 1);
    assert.deepEqual(persisted.finalFallback, fallback);
    assert.deepEqual(Object.keys(persisted.profiles).sort(), ["deep", "design", "execution", "review", "standard"]);
    assert.match(await readFile(join(project, ".gitignore"), "utf8"), /\.opencode-vm\//u);
    const backups = (await readdir(join(project, ".opencode-vm"))).filter((name) => name.includes("backup"));
    assert.deepEqual(backups, [], "a missing file has no original bytes to back up");
  } finally {
    await cleanup();
  }
});

test("revision CAS rejects a stale expected revision and never writes", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await writePolicy(project, {
      schemaVersion: 1, revision: 1, updatedAt: "2026-10-01T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null },
    });
    const before = await readFile(policyPath(project));
    await assert.rejects(commitFinalFallback(runtime, 0, fallback), { code: "POLICY_REVISION_CONFLICT" });
    assert.deepEqual(await readFile(policyPath(project)), before);
  } finally {
    await cleanup();
  }
});

test("first schema 1 upgrade publishes schema 3 with an exact-bytes backup and preserves profiles", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    const original = {
      schemaVersion: 1, revision: 1, updatedAt: "2026-10-01T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null },
    };
    await writePolicy(project, original);
    const before = await readFile(policyPath(project));
    const updated = await commitFinalFallback(runtime, 1, fallback);
    assert.equal(updated.schemaVersion, 3);
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.profiles.deep, selection);
    const persisted = JSON.parse(await readFile(policyPath(project), "utf8"));
    assert.deepEqual(persisted.profiles.deep, selection);
    assert.deepEqual(persisted.finalFallback, fallback);
    assert.deepEqual(await readFile(join(project, ".opencode-vm", "agent-control.schema1-rev1.backup.json")), before);
  } finally {
    await cleanup();
  }
});

test("clearing keeps schema 3 and clearing on schema 1 neither upgrades nor drops profiles", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await commitFinalFallback(runtime, 0, fallback);
    const cleared = await commitFinalFallback(runtime, 1, null);
    assert.equal(cleared.schemaVersion, 3);
    assert.equal(cleared.revision, 2);
    assert.equal(cleared.finalFallback, null);
    assert.equal(JSON.parse(await readFile(policyPath(project), "utf8")).finalFallback, null);

    await rm(join(project, ".opencode-vm"), { recursive: true, force: true });
    await writePolicy(project, {
      schemaVersion: 1, revision: 1, updatedAt: "2026-10-01T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null },
    });
    const downgrade = await commitFinalFallback(runtime, 1, null);
    assert.equal(downgrade.schemaVersion, 1);
    const persisted = JSON.parse(await readFile(policyPath(project), "utf8"));
    assert.deepEqual(Object.keys(persisted).sort(), ["profiles", "revision", "schemaVersion", "updatedAt"]);
    assert.deepEqual(Object.keys(persisted.profiles).sort(), ["deep", "execution", "standard"]);
    assert.deepEqual(persisted.profiles.deep, selection);
  } finally {
    await cleanup();
  }
});

test("commit blocks on the shared canonical flock and fails closed on timeout", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await writePolicy(project, {
      schemaVersion: 3, revision: 4, updatedAt: "2026-10-01T00:00:00Z",
      profiles: { deep: null, standard: null, execution: null, design: null, review: null },
      finalFallback: null,
    });
    const directory = join(project, ".opencode-vm");
    const lock = await open(join(directory, "agent-control.lock"), "a", 0o600);
    const acquired = spawnSync("flock", ["-x", "3"], { stdio: ["ignore", "ignore", "pipe", lock.fd] });
    assert.equal(acquired.status, 0, "test must hold the canonical lock");
    const before = await readFile(policyPath(project));
    await assert.rejects(commitFinalFallback(runtime, 4, fallback, { lockTimeoutSeconds: 1 }), { code: "POLICY_COMMIT_UNAVAILABLE" });
    assert.deepEqual(await readFile(policyPath(project)), before, "a held lock means no write");
    await lock.close();
    const updated = await commitFinalFallback(runtime, 4, fallback);
    assert.equal(updated.revision, 5);
  } finally {
    await cleanup();
  }
});