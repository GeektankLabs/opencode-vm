import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitFinalFallback, commitProfileFallback, commitSlotDisabled, commitStrategies, validateFinalFallbackValue, validateStrategiesValue } from "./policy-commit.js";
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

const schema3 = {
  schemaVersion: 3, revision: 2, updatedAt: "2026-10-08T00:00:00Z",
  profiles: { deep: selection, standard: selection, execution: null, design: null, review: null },
  finalFallback: { mode: "degrading", selection },
};

test("strategy validation accepts exactly both switches as true, false or unset", () => {
  assert.deepEqual(validateStrategiesValue({ degrading: true, providerSkip: false }), { degrading: true, providerSkip: false });
  assert.deepEqual(validateStrategiesValue({ degrading: null, providerSkip: null }), { degrading: null, providerSkip: null });
  for (const bad of [{ degrading: true }, { degrading: true, providerSkip: false, extra: true },
    { degrading: 1, providerSkip: null }, { degrading: "true", providerSkip: null },
    { degrading: true, providerSkip: "no" }, null, "degrading", [true, false]]) {
    assert.throws(() => validateStrategiesValue(bad), { code: "INVALID_ARGUMENT" });
  }
});

test("a profile fallback upgrades schema 3 to schema 4 with an exact-bytes backup and canonical key order", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await writePolicy(project, schema3);
    const before = await readFile(policyPath(project));
    const updated = await commitProfileFallback(runtime, 2, "deep", { ...selection, variant: "default" });
    assert.equal(updated.schemaVersion, 4);
    assert.equal(updated.revision, 3);
    assert.deepEqual(updated.profileFallbacks.deep, { ...selection, variant: "default" });
    assert.deepEqual(updated.finalFallback, schema3.finalFallback, "the legacy global slot is preserved verbatim");
    assert.deepEqual(updated.strategies, { degrading: null, providerSkip: null });
    const persisted = JSON.parse(await readFile(policyPath(project), "utf8"));
    assert.deepEqual(Object.keys(persisted),
      ["schemaVersion", "revision", "updatedAt", "profiles", "finalFallback", "profileFallbacks", "strategies"],
      "persisted key order matches the Python writer byte for byte");
    assert.deepEqual(persisted.profileFallbacks.deep, { ...selection, variant: "default" });
    assert.deepEqual(persisted.strategies, { degrading: null, providerSkip: null });
    assert.deepEqual(await readFile(join(project, ".opencode-vm", "agent-control.schema3-rev2.backup.json")), before);
  } finally {
    await cleanup();
  }
});

test("clearing never downgrades schema 4 and other keys survive every writer", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await writePolicy(project, schema3);
    await commitProfileFallback(runtime, 2, "standard", selection);
    await commitStrategies(runtime, 3, { degrading: true, providerSkip: false });
    const clearedFallback = await commitProfileFallback(runtime, 4, "standard", null);
    assert.equal(clearedFallback.schemaVersion, 4);
    assert.equal(clearedFallback.profileFallbacks.standard, null);
    assert.deepEqual(clearedFallback.strategies, { degrading: true, providerSkip: false });
    const clearedStrategies = await commitStrategies(runtime, 5, { degrading: null, providerSkip: null });
    assert.equal(clearedStrategies.schemaVersion, 4, "clearing both switches keeps schema 4");
    assert.deepEqual(clearedStrategies.strategies, { degrading: null, providerSkip: null });
    const persisted = JSON.parse(await readFile(policyPath(project), "utf8"));
    assert.deepEqual(persisted.finalFallback, schema3.finalFallback);
    assert.deepEqual(persisted.profiles.deep, selection);
    assert.deepEqual(Object.keys(persisted.profileFallbacks).sort(), ["deep", "design", "execution", "review", "standard"]);
    // The legacy writer keeps schema 4 and both new slots instead of downgrading.
    const legacyWrite = await commitFinalFallback(runtime, 6, { mode: "total", selection });
    assert.equal(legacyWrite.schemaVersion, 4);
    assert.deepEqual(legacyWrite.finalFallback, { mode: "total", selection });
    assert.deepEqual(legacyWrite.strategies, { degrading: null, providerSkip: null });
    const backups = (await readdir(join(project, ".opencode-vm"))).filter((name) => name.includes("backup")).sort();
    assert.deepEqual(backups, ["agent-control.schema3-rev2.backup.json"], "only the first upgrade backs up exact bytes");
  } finally {
    await cleanup();
  }
});

test("strategy commit upgrades schema 1 to five profile keys and refuses unknown profiles or stale revisions", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await writePolicy(project, {
      schemaVersion: 1, revision: 1, updatedAt: "2026-10-01T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null },
    });
    const before = await readFile(policyPath(project));
    await assert.rejects(commitProfileFallback(runtime, 1, "manager", selection), { code: "INVALID_ARGUMENT" });
    await assert.rejects(commitProfileFallback(runtime, 0, "deep", selection), { code: "POLICY_REVISION_CONFLICT" });
    assert.deepEqual(await readFile(policyPath(project)), before, "a rejected write changes nothing");
    const upgraded = await commitStrategies(runtime, 1, { degrading: false, providerSkip: true });
    assert.equal(upgraded.schemaVersion, 4);
    const persisted = JSON.parse(await readFile(policyPath(project), "utf8"));
    assert.deepEqual(Object.keys(persisted.profiles).sort(), ["deep", "design", "execution", "review", "standard"]);
    assert.deepEqual(persisted.strategies, { degrading: false, providerSkip: true });
    assert.equal(persisted.finalFallback, null, "schema 4 always carries the legacy slot explicitly");
    assert.deepEqual(await readFile(join(project, ".opencode-vm", "agent-control.schema1-rev1.backup.json")), before);
  } finally {
    await cleanup();
  }
});

test("the new schema-4 commits fail closed on a held canonical lock", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await writePolicy(project, schema3);
    const directory = join(project, ".opencode-vm");
    const lock = await open(join(directory, "agent-control.lock"), "a", 0o600);
    const acquired = spawnSync("flock", ["-x", "3"], { stdio: ["ignore", "ignore", "pipe", lock.fd] });
    assert.equal(acquired.status, 0, "test must hold the canonical lock");
    const before = await readFile(policyPath(project));
    await assert.rejects(commitProfileFallback(runtime, 2, "deep", selection, { lockTimeoutSeconds: 1 }), { code: "POLICY_COMMIT_UNAVAILABLE" });
    await assert.rejects(commitStrategies(runtime, 2, { degrading: true, providerSkip: true }, { lockTimeoutSeconds: 1 }), { code: "POLICY_COMMIT_UNAVAILABLE" });
    assert.deepEqual(await readFile(policyPath(project)), before, "a held lock means no write");
    await lock.close();
    assert.equal((await commitStrategies(runtime, 2, { degrading: true, providerSkip: true })).revision, 3);
  } finally {
    await cleanup();
  }
});
// ---------------------------------------------------------------------------
// task_f2d0ccc6: commitSlotDisabled — additive schema 5 per-slot pause.
// ---------------------------------------------------------------------------

test("commitSlotDisabled upgrades to schema 5 with an exact-bytes backup and preserves every stored selection", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    await writePolicy(project, {
      schemaVersion: 4, revision: 6, updatedAt: "2026-10-12T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null, design: null, review: null },
      finalFallback: { mode: "total", selection },
      profileFallbacks: { deep: null, standard: { ...selection, variant: "default" }, execution: null, design: null, review: null },
      strategies: { degrading: true, providerSkip: null },
    });
    const before = await readFile(policyPath(project));
    const updated = await commitSlotDisabled(runtime, 6, { kind: "profile", profile: "deep" }, true);
    assert.equal(updated.schemaVersion, 5);
    assert.equal(updated.revision, 7);
    assert.equal(updated.disabled.profiles.deep, true);
    // Every stored slot survives byte-exact beside the disable state.
    assert.deepEqual(updated.profiles.deep, selection);
    assert.deepEqual(updated.profileFallbacks.standard, { ...selection, variant: "default" });
    assert.deepEqual(updated.finalFallback, { mode: "total", selection });
    assert.deepEqual(updated.strategies, { degrading: true, providerSkip: null });
    const persisted = JSON.parse(await readFile(policyPath(project), "utf8"));
    assert.equal(persisted.schemaVersion, 5);
    assert.deepEqual(persisted.disabled, {
      profiles: { deep: true, standard: false, execution: false, design: false, review: false },
      profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false },
      finalFallback: false,
    });
    // Canonical persisted key order: disabled is the last key of a schema-5 document.
    assert.deepEqual(Object.keys(persisted), ["schemaVersion", "revision", "updatedAt", "profiles",
      "finalFallback", "profileFallbacks", "strategies", "disabled"]);
    const backup = await readFile(join(project, ".opencode-vm", "agent-control.schema4-rev6.backup.json"));
    assert.deepEqual(backup, before, "the original bytes are backed up exactly before the upgrade");
  } finally {
    await cleanup();
  }
});

test("commitSlotDisabled clears without downgrade, upgrades from schema 1, covers fallback and final slots, and validates input", async () => {
  const { project, runtime, cleanup } = await setup();
  try {
    const schema5 = {
      schemaVersion: 5, revision: 9, updatedAt: "2026-10-12T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null, design: null, review: null },
      finalFallback: { mode: "degrading", selection },
      profileFallbacks: { deep: { ...selection, variant: "default" }, standard: null, execution: null, design: null, review: null },
      strategies: { degrading: null, providerSkip: null },
      disabled: {
        profiles: { deep: true, standard: false, execution: false, design: false, review: false },
        profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false },
        finalFallback: true,
      },
    };
    await writePolicy(project, schema5);
    // Clearing a primary never downgrades and never touches the stored selection.
    const reenabled = await commitSlotDisabled(runtime, 9, { kind: "profile", profile: "deep" }, false);
    assert.equal(reenabled.schemaVersion, 5);
    assert.equal(reenabled.disabled.profiles.deep, false);
    assert.equal(reenabled.disabled.finalFallback, true);
    assert.deepEqual(reenabled.profiles.deep, selection, "the stored tuple survives re-enable");
    // A different slot of the same profile is independent.
    await writePolicy(project, schema5);
    const own = await commitSlotDisabled(runtime, 9, { kind: "profileFallback", profile: "deep" }, true);
    assert.equal(own.disabled.profiles.deep, true, "other slots stay unchanged");
    assert.equal(own.disabled.profileFallbacks.deep, true);
    const final = await commitSlotDisabled(runtime, 10, { kind: "finalFallback" }, false);
    assert.equal(final.disabled.finalFallback, false);
    assert.equal(final.disabled.profileFallbacks.deep, true);
    // Upgrade straight from schema 1: an explicit disable publishes schema 5 with a backup.
    await rm(join(project, ".opencode-vm"), { recursive: true, force: true });
    await writePolicy(project, {
      schemaVersion: 1, revision: 1, updatedAt: "2026-10-01T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null },
    });
    const upgraded = await commitSlotDisabled(runtime, 1, { kind: "profile", profile: "standard" }, true);
    assert.equal(upgraded.schemaVersion, 5);
    assert.equal(upgraded.disabled.profiles.standard, true);
    assert.deepEqual(upgraded.profiles.deep, selection);
    const backups = (await readdir(join(project, ".opencode-vm"))).filter((name) => name.includes("backup"));
    assert.deepEqual(backups, ["agent-control.schema1-rev1.backup.json"]);
    // Input validation fails closed before any write.
    await assert.rejects(commitSlotDisabled(runtime, 12, { kind: "profile", profile: "nope" }, true), { code: "INVALID_ARGUMENT" });
    await assert.rejects(commitSlotDisabled(runtime, 12, { kind: "profileFallback", profile: "nope" }, true), { code: "INVALID_ARGUMENT" });
    // CAS conflict never writes.
    const frozen = await readFile(policyPath(project));
    await assert.rejects(commitSlotDisabled(runtime, 1, { kind: "finalFallback" }, true), { code: "POLICY_REVISION_CONFLICT" });
    assert.deepEqual(await readFile(policyPath(project)), frozen);
  } finally {
    await cleanup();
  }
});
