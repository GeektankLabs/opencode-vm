import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describePolicy, profileState, readPolicy, resolveProfile, PROFILE_NAMES, type ProfileName } from "./agent-control.js";
import type { RuntimeDescriptor, RuntimeOptions } from "./types.js";

const catalog: RuntimeOptions = { agents: ["build"], providers: [{ provider_id: "p", name: "P" }],
  models: [{ provider_id: "p", model_id: "m", name: "M", variants: ["default", "high"] }], truncated: false };
const selection = { provider_id: "p", model_id: "m", variant: "high" };

test("project policy is optional, portable and fail-closed on newer schemas", async () => {
  const project = await mkdtemp(join(tmpdir(), "agent-control-"));
  const runtime = { project, projectHash: "project-id" } as RuntimeDescriptor;
  try {
    const missing = await readPolicy(runtime);
    assert.equal(missing.revision, 0);
    assert.equal(missing.profiles.deep, null);
    const directory = join(project, ".opencode-vm");
    await mkdir(directory);
    const policy = { schemaVersion: 1 as const, revision: 1, updatedAt: "2026-09-28T18:00:00Z",
      profiles: { deep: selection, standard: null, execution: null } };
    await writeFile(join(directory, "agent-control.json"), JSON.stringify(policy));
    assert.deepEqual((await readPolicy(runtime)).profiles.deep, selection);
    assert.equal(describePolicy(runtime, await readPolicy(runtime), catalog).profiles.deep?.status, "available");
    await writeFile(join(directory, "agent-control.json"), JSON.stringify({ ...policy, schemaVersion: 2 }));
    await assert.rejects(readPolicy(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
    await writeFile(join(directory, "agent-control.json"), JSON.stringify({ ...policy, schemaVersion: 2,
      profiles: { ...policy.profiles, design: null, review: selection } }));
    const normalized = await readPolicy(runtime);
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(resolveProfile(normalized, "review", catalog).resolution_path[0], "review");
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("shared absence-fallback vectors match Python and never write policy", async () => {
  const vectors = JSON.parse(await readFile(new URL("../../../tests/fixtures/ach1-resolution.json", import.meta.url), "utf8"));
  for (const vector of vectors) {
    const profiles = Object.fromEntries(PROFILE_NAMES.map(name => [name, null])) as Record<ProfileName, typeof selection | null>;
    for (const [role, state] of Object.entries(vector.mappings)) {
      const tuple = { ...selection };
      if (state === "provider_unavailable") tuple.provider_id = "gone";
      if (state === "model_unavailable") tuple.model_id = "gone";
      if (state === "variant_unavailable") tuple.variant = "gone";
      profiles[role as ProfileName] = tuple;
    }
    const policy = { schemaVersion: 2 as const, revision: 7, updatedAt: null, profiles };
    const before = JSON.stringify(policy);
    const result = resolveProfile(policy, vector.profile, vector.catalog === "unavailable" ? undefined :
      { ...catalog, truncated: vector.catalog === "incomplete" });
    assert.equal(result.status, vector.status);
    assert.equal("resolved_profile" in result ? result.resolved_profile : undefined, vector.resolved_profile);
    assert.deepEqual(result.resolution_path, vector.resolution_path);
    assert.equal("runtime" in result, vector.status === "available");
    assert.equal(JSON.stringify(policy), before);
  }
});

test("invalid exact keys, future format, budget and symlink fail closed without read mutation", async () => {
  const project = await mkdtemp(join(tmpdir(), "policy-boundary-"));
  const runtime = { project } as RuntimeDescriptor;
  const directory = join(project, ".opencode-vm"), path = join(directory, "agent-control.json");
  await mkdir(directory);
  try {
    const value = { schemaVersion: 1, revision: 1, updatedAt: "2026-09-30T04:00:00Z", profiles: { deep: null, standard: null, execution: null } };
    for (const data of [" ".repeat(16 * 1024 + 1), JSON.stringify({ ...value, schemaVersion: 9 }),
      JSON.stringify({ ...value, profiles: { ...value.profiles, design: null } })]) {
      await writeFile(path, data);
      await assert.rejects(readPolicy(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
      assert.equal(await readFile(path, "utf8"), data);
    }
    await unlink(path); await symlink(join(project, "missing"), path);
    await assert.rejects(readPolicy(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("catalog validation never substitutes unavailable or truncated mappings", () => {
  assert.equal(profileState(selection, catalog), "available");
  assert.equal(profileState({ ...selection, provider_id: "gone" }, catalog), "provider_unavailable");
  assert.equal(profileState({ ...selection, model_id: "gone" }, catalog), "model_unavailable");
  assert.equal(profileState({ ...selection, variant: "gone" }, catalog), "variant_unavailable");
  assert.equal(profileState(selection, { ...catalog, truncated: true }), "catalog_incomplete");
  assert.equal(profileState(selection), "catalog_unavailable");
});
