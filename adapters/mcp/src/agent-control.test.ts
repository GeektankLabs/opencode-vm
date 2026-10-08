import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateOrder, describePolicy, profileState, readPolicy, resolveProfile, routingRegime, PROFILE_NAMES, type ProfileName } from "./agent-control.js";
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
    const policy = { schemaVersion: 2 as const, revision: 7, updatedAt: null, profiles, finalFallback: null,
      profileFallbacks: { ...profiles }, strategies: { degrading: null, providerSkip: null } };
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

test("schema-4 regime and candidate order match the shared Python/TypeScript vectors", async () => {
  const vectors = JSON.parse(await readFile(new URL("../tests/fallback-vectors.json", import.meta.url), "utf8"));
  const project = await mkdtemp(join(tmpdir(), "policy-vectors-"));
  const runtime = { project, projectHash: "project-id" } as RuntimeDescriptor;
  const directory = join(project, ".opencode-vm");
  const path = join(directory, "agent-control.json");
  await mkdir(directory);
  try {
    assert.ok(vectors.length >= 8, "the shared vector set covers both regimes and all four switch combinations");
    for (const vector of vectors) {
      await writeFile(path, JSON.stringify(vector.policy));
      const policy = await readPolicy(runtime);
      const routing = routingRegime(policy);
      assert.equal(routing.regime, vector.regime, vector.name);
      assert.equal(routing.legacy_final_stage_applies, vector.legacy_final_stage_applies, vector.name);
      assert.deepEqual(routing.strategies_effective, vector.strategies_effective, vector.name);
      for (const name of PROFILE_NAMES) {
        assert.deepEqual(candidateOrder(policy, name), vector.candidate_order[name], `${vector.name} / ${name}`);
      }
      const described = describePolicy(runtime, policy, catalog).routing;
      assert.deepEqual(described.candidate_order, vector.candidate_order, vector.name);
      assert.equal(described.regime, vector.regime, vector.name);
    }
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("schema-4 documents are read additively and invalid shapes fail closed", async () => {
  const project = await mkdtemp(join(tmpdir(), "policy-schema4-"));
  const runtime = { project, projectHash: "project-id" } as RuntimeDescriptor;
  const directory = join(project, ".opencode-vm");
  const path = join(directory, "agent-control.json");
  await mkdir(directory);
  try {
    const profiles = { deep: selection, standard: null, execution: null, design: null, review: null };
    const own = { deep: null, standard: { ...selection, variant: "default" }, execution: null, design: null, review: null };
    const valid = { schemaVersion: 4, revision: 3, updatedAt: "2026-10-08T00:00:00Z", profiles,
      finalFallback: { mode: "total", selection }, profileFallbacks: own,
      strategies: { degrading: true, providerSkip: null } };
    await writeFile(path, JSON.stringify(valid));
    const policy = await readPolicy(runtime);
    assert.equal(policy.schemaVersion, 4);
    assert.deepEqual(policy.profileFallbacks.standard, { ...selection, variant: "default" });
    assert.deepEqual(policy.strategies, { degrading: true, providerSkip: null });
    assert.deepEqual(policy.finalFallback, { mode: "total", selection });
    const described = describePolicy(runtime, policy, catalog);
    assert.deepEqual(described.profile_fallbacks.standard,
      { selection: { ...selection, variant: "default" }, status: "available" });
    assert.equal(described.profile_fallbacks.deep?.status, "unconfigured");
    assert.deepEqual(described.strategies, { degrading: true, provider_skip: null });
    assert.equal(described.routing.regime, "per_profile");
    assert.equal(described.routing.legacy_final_stage_applies, false);
    assert.equal(described.final_fallback?.status, "available", "the legacy slot stays stored and readable");
    // A configured but unavailable own fallback is reported, never substituted or dropped.
    await writeFile(path, JSON.stringify({ ...valid, profileFallbacks: { ...own, review: { ...selection, variant: "gone" } } }));
    const unavailable = describePolicy(runtime, await readPolicy(runtime), catalog);
    assert.equal(unavailable.profile_fallbacks.review?.status, "variant_unavailable");
    assert.deepEqual(unavailable.profile_fallbacks.review?.selection, { ...selection, variant: "gone" });
    await writeFile(path, JSON.stringify(valid));
    // A schema 1/2/3 document is normalized to unset own fallbacks and strategies.
    await writeFile(path, JSON.stringify({ schemaVersion: 3, revision: 2, updatedAt: "2026-10-08T00:00:00Z",
      profiles, finalFallback: null }));
    const legacy = await readPolicy(runtime);
    assert.deepEqual(legacy.profileFallbacks, { deep: null, standard: null, execution: null, design: null, review: null });
    assert.deepEqual(legacy.strategies, { degrading: null, providerSkip: null });
    assert.equal(routingRegime(legacy).regime, "legacy_final_fallback");
    for (const bad of [
      { ...valid, strategies: { degrading: true } },
      { ...valid, strategies: { degrading: "true", providerSkip: null } },
      { ...valid, strategies: { degrading: 1, providerSkip: null } },
      { ...valid, strategies: { degrading: true, providerSkip: null, extra: true } },
      { ...valid, profileFallbacks: { deep: null, standard: null, execution: null, design: null } },
      { ...valid, profileFallbacks: { ...own, review: { provider_id: "p", model_id: "m" } } },
      { ...valid, profileFallbacks: { ...own, review: { provider_id: "/etc/passwd", model_id: "m", variant: "high" } } },
      { schemaVersion: 4, revision: 3, updatedAt: "2026-10-08T00:00:00Z", profiles, finalFallback: null,
        profileFallbacks: own },
      { schemaVersion: 3, revision: 3, updatedAt: "2026-10-08T00:00:00Z", profiles, finalFallback: null,
        profileFallbacks: own, strategies: { degrading: null, providerSkip: null } },
      { ...valid, schemaVersion: 5 },
    ]) {
      await writeFile(path, JSON.stringify(bad));
      await assert.rejects(readPolicy(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
    }
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

test("schema-3 final fallback is read additively, described with availability, and fail-closed on invalid shapes", async () => {
  const project = await mkdtemp(join(tmpdir(), "policy-fallback-"));
  const runtime = { project, projectHash: "project-id" } as RuntimeDescriptor;
  const directory = join(project, ".opencode-vm");
  const path = join(directory, "agent-control.json");
  await mkdir(directory);
  try {
    const base = { schemaVersion: 3, revision: 4, updatedAt: "2026-10-07T00:00:00Z",
      profiles: { deep: selection, standard: selection, execution: null, design: null, review: null } };
    await writeFile(path, JSON.stringify({ ...base, finalFallback: { mode: "degrading", selection } }));
    const policy = await readPolicy(runtime);
    assert.equal(policy.schemaVersion, 3);
    assert.deepEqual(policy.finalFallback, { mode: "degrading", selection });
    assert.deepEqual(describePolicy(runtime, policy, catalog).final_fallback,
      { mode: "degrading", selection, status: "available" });
    assert.equal(describePolicy(runtime, policy, { ...catalog, truncated: true }).final_fallback?.status, "catalog_incomplete");
    await writeFile(path, JSON.stringify({ ...base, finalFallback: null }));
    const cleared = await readPolicy(runtime);
    assert.equal(cleared.finalFallback, null);
    assert.equal(describePolicy(runtime, cleared, catalog).final_fallback, null);
    // Schema 1/2 stay readable without the slot and describe it as null.
    await writeFile(path, JSON.stringify({ schemaVersion: 2, revision: 5, updatedAt: "2026-10-07T00:00:00Z",
      profiles: { deep: null, standard: selection, execution: null, design: null, review: null } }));
    const legacy = await readPolicy(runtime);
    assert.equal(legacy.schemaVersion, 2);
    assert.equal(legacy.finalFallback, null);
    for (const bad of [
      { ...base, finalFallback: { mode: "sideways", selection } },
      { ...base, finalFallback: { mode: "total", selection: null } },
      { ...base, finalFallback: { selection } },
      { ...base, finalFallback: { mode: "total", selection: { ...selection, extra: "x" } } },
      { schemaVersion: 2, revision: 5, updatedAt: "2026-10-07T00:00:00Z", finalFallback: null,
        profiles: { deep: null, standard: null, execution: null, design: null, review: null } },
      { schemaVersion: 3, revision: 5, updatedAt: "2026-10-07T00:00:00Z",
        profiles: { deep: null, standard: null, execution: null, design: null, review: null } },
    ]) {
      await writeFile(path, JSON.stringify(bad));
      await assert.rejects(readPolicy(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
    }
  } finally { await rm(project, { recursive: true, force: true }); }
});
