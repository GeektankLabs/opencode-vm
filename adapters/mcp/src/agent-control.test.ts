import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { candidateOrder, describePolicy, isRecoveryProviderAdmission, newStartCandidates, profileState, providerFailureScope, readPolicy, resolveProfile, resolveRecoveryChain, routingRegime, PROFILE_NAMES, type ProfileName } from "./agent-control.js";
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
      profileFallbacks: { ...profiles }, strategies: { degrading: null, providerSkip: null },
      disabled: { profiles: Object.fromEntries(PROFILE_NAMES.map((name) => [name, (vector as { disabled?: string[] }).disabled?.includes(name) ?? false])) as Record<ProfileName, boolean>,
        profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false },
        finalFallback: false } };
    const before = JSON.stringify(policy);
    const result = resolveProfile(policy, vector.profile, vector.catalog === "unavailable" ? undefined :
      { ...catalog, truncated: vector.catalog === "incomplete" });
    assert.equal(result.status, vector.status);
    assert.equal(("resolved_profile" in result ? result.resolved_profile : undefined) ?? null, vector.resolved_profile ?? null);
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
      { selection: { ...selection, variant: "default" }, status: "available", disabled: false });
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
      { mode: "degrading", selection, status: "available", disabled: false });
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

// ---------------------------------------------------------------------------
// Welle B (be951293): shared recovery-candidate resolution — exactly once in
// TypeScript, used by adapter and Monitor Engine alike (concept §4.4/§4.6).
// ---------------------------------------------------------------------------

type ViewTuple = { provider_id: string; model_id: string; variant?: string };
const fullCatalog: RuntimeOptions = {
  agents: ["build"],
  providers: [
    { provider_id: "p", name: "P" },
    { provider_id: "q", name: "Q" },
  ],
  models: [
    { provider_id: "p", model_id: "m", name: "M", variants: [] },
    { provider_id: "p", model_id: "fb", name: "FB", variants: [] },
    { provider_id: "q", model_id: "m", name: "QM", variants: [] },
  ],
  truncated: false,
};

function recoveryView(profiles: Record<string, ViewTuple | null>, extras: {
  profileFallbacks?: Record<string, ViewTuple | null>;
  strategies?: { degrading: boolean | null; providerSkip: boolean | null };
  finalFallback?: { mode: "total" | "degrading"; selection: ViewTuple } | null;
  disabled?: { profiles?: Record<string, boolean>; profileFallbacks?: Record<string, boolean>; finalFallback?: boolean };
  revision?: number;
  schemaVersion?: 3 | 4 | 5;
}) {
  const fallbacksAll = { deep: null, standard: null, execution: null, design: null, review: null, ...(extras.profileFallbacks ?? {}) };
  const strategies = extras.strategies ?? { degrading: null, providerSkip: null };
  const policy = {
    schemaVersion: extras.schemaVersion ?? 4,
    revision: extras.revision ?? 7,
    updatedAt: "2026-10-10T00:00:00Z",
    profiles: { deep: null, standard: null, execution: null, design: null, review: null, ...profiles },
    finalFallback: extras.finalFallback ?? null,
    profileFallbacks: fallbacksAll,
    strategies,
    ...(extras.disabled ? {
      disabled: {
        profiles: { deep: false, standard: false, execution: false, design: false, review: false, ...(extras.disabled.profiles ?? {}) },
        profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false, ...(extras.disabled.profileFallbacks ?? {}) },
        finalFallback: extras.disabled.finalFallback ?? false,
      },
    } : {}),
  } as unknown as Parameters<typeof routingRegime>[0];
  return { ...policy, routing: routingRegime(policy), revision: policy.revision };
}

const deepT: ViewTuple = { provider_id: "p", model_id: "m" };
const fbT: ViewTuple = { provider_id: "p", model_id: "fb" };
const qT: ViewTuple = { provider_id: "q", model_id: "m" };

test("Welle B resolver: legacy regime keeps today's chain semantics unchanged", () => {
  const view = recoveryView({ deep: deepT, standard: qT, execution: null }, {
    finalFallback: { mode: "degrading", selection: fbT }, schemaVersion: 3,
  });
  assert.equal(view.routing.regime, "legacy_final_fallback");
  const chain = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_timeout", currentIdentity: "p/m" });
  assert.deepEqual(chain.candidates.map((entry) => `${entry.label}=${entry.status}`), ["degrade.standard.main=selected", "final.main=skipped_attempted"]);
  assert.equal(chain.selected_identity, "q/m");
  const total = resolveRecoveryChain(recoveryView({ deep: deepT, standard: qT }, {
    finalFallback: { mode: "total", selection: fbT }, schemaVersion: 3,
  }), { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_timeout" });
  assert.deepEqual(total.candidates.map((entry) => entry.label), ["final.main"]);
  const empty = resolveRecoveryChain(recoveryView({ deep: deepT }, { schemaVersion: 3 }), { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_timeout" });
  assert.equal(empty.reason, "chain_empty");
});

test("Welle B resolver: per_profile stage tuples resolve main then own fallback, degrading descends only when explicitly set", () => {
  const view = recoveryView({ deep: deepT, standard: qT, execution: qT }, {
    profileFallbacks: { deep: fbT, standard: null, execution: null },
    strategies: { degrading: true, providerSkip: null },
  });
  assert.equal(view.routing.regime, "per_profile");
  const chain = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", currentIdentity: "p/m" });
  assert.deepEqual(chain.candidates.map((entry) => entry.label), ["deep.main", "deep.fallback", "standard.main", "execution.main"]);
  assert.equal(chain.candidates[0]!.status, "skipped_current_failure");
  assert.equal(chain.selected_identity, "p/fb");
  const noDegrade = resolveRecoveryChain(recoveryView({ deep: deepT, standard: qT }, {
    profileFallbacks: { deep: fbT }, strategies: { degrading: false, providerSkip: null },
  }), { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", currentIdentity: "p/m" });
  assert.deepEqual(noDegrade.candidates.map((entry) => entry.label), ["deep.main", "deep.fallback"]);
  // task_68085480: the configured global final stage IS the guaranteed LAST step
  // of a per-profile chain now (operator-authorized change from #20).
  const appended = resolveRecoveryChain(recoveryView({ deep: deepT }, {
    profileFallbacks: { deep: fbT },
    finalFallback: { mode: "total", selection: qT },
  }), { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", currentIdentity: "p/m" });
  assert.deepEqual(appended.candidates.map((entry) => entry.label), ["deep.main", "deep.fallback", "final.main"]);
  assert.equal(appended.candidates.at(-1)!.status, "skipped_attempted", "the final is appended last; not reached when a regular candidate already won");
  // ... and it IS reached (and selected) when the regular alternatives fail —
  // including an identical already-failed tuple and active provider-skip.
  const exhausted = resolveRecoveryChain(recoveryView({ deep: deepT, standard: qT }, {
    strategies: { degrading: false, providerSkip: true },
    finalFallback: { mode: "total", selection: deepT },
  }), { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota",
       evidenceProviderId: "p", attempted: ["p/m", "q/m"], currentIdentity: "p/m" });
  assert.equal(exhausted.selected_identity, "p/m", "identical final tuple is still attempted once despite provider-skip");
  assert.equal(exhausted.candidates.at(-1)!.label, "final.main");
  assert.equal(exhausted.candidates.at(-1)!.status, "selected");
});

test("Welle B resolver: availability and catalog honesty — missing provider/model/variant skips, absent catalog skips everything", () => {
  const view = recoveryView({ deep: deepT }, { profileFallbacks: { deep: { provider_id: "p", model_id: "ghost" } } });
  const chain = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_timeout", currentIdentity: "p/m" });
  assert.equal(chain.candidates[1]!.status, "skipped_unavailable");
  assert.equal(chain.reason, "chain_exhausted");
  const noCatalog = resolveRecoveryChain(recoveryView({ deep: deepT }, { profileFallbacks: { deep: fbT } }), { entryProfile: "deep", evidenceCategory: "provider_timeout", currentIdentity: "p/m" });
  assert.equal(noCatalog.candidates[1]!.status, "skipped_unavailable", "an unchecked catalog is never availability proof");
});

test("Welle B resolver: Provider-Skip needs explicit ON plus account-scope evidence — single timeouts and id-only matches never skip", () => {
  const view = recoveryView({ deep: deepT, standard: qT }, { profileFallbacks: { deep: fbT }, strategies: { degrading: true, providerSkip: true } });
  const quota = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", evidenceProviderId: "p", currentIdentity: "p/m" });
  assert.deepEqual(quota.candidates.map((entry) => entry.status), ["skipped_current_failure", "skipped_provider_scope", "selected"]);
  const timeout = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_timeout", evidenceProviderId: "p", currentIdentity: "p/m" });
  assert.equal(timeout.candidates[1]!.status, "selected", "a single request timeout is not provider-wide proof");
  const unset = resolveRecoveryChain(recoveryView({ deep: deepT, standard: qT }, { profileFallbacks: { deep: fbT }, strategies: { degrading: true, providerSkip: null } }),
    { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", evidenceProviderId: "p", currentIdentity: "p/m" });
  assert.equal(unset.candidates[1]!.status, "selected", "an unset switch is never a hidden default");
  const foreign = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", evidenceProviderId: "q", currentIdentity: "p/m" });
  assert.equal(foreign.candidates[1]!.status, "selected", "skip applies to the matching failure scope only — foreign-provider fallback stays usable");
});

test("Welle B resolver: persistent attempted identities are filtered union-style and never re-jumped within the failing episode", () => {
  const view = recoveryView({ deep: deepT, standard: qT }, { profileFallbacks: { deep: fbT }, strategies: { degrading: true, providerSkip: null }, revision: 9 });
  const chain = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_error", attempted: ["p/fb"], currentIdentity: "p/m" });
  assert.equal(chain.candidates[1]!.status, "skipped_attempted");
  assert.equal(chain.selected_identity, "q/m");
  assert.equal(chain.policy_revision, 9);
  const all = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_error", attempted: ["p/m", "p/fb", "q/m"] });
  assert.equal(all.reason, "chain_exhausted");
  assert.equal(all.selected, null);
});

test("Welle B admission: exactly the six terminal provider categories route; unknown/fachlich/aborted never do", () => {
  for (const category of ["provider_header_timeout", "provider_response_stream_error", "provider_error", "provider_timeout", "provider_quota", "provider_auth"]) {
    assert.ok(isRecoveryProviderAdmission(category), category);
  }
  for (const category of ["unknown", "aborted", "context_input_length", "context_overflow", "output_length", "structured_output", "content_filter", "work_failure"]) {
    assert.ok(!isRecoveryProviderAdmission(category), category);
  }
  assert.equal(providerFailureScope("provider_quota"), "account_scope");
  assert.equal(providerFailureScope("provider_auth"), "account_scope");
  assert.equal(providerFailureScope("provider_timeout"), "request_level");
  assert.equal(providerFailureScope("unknown"), "request_level");
});

test("Welle B matrix F (doppelte Runtimes): identical full tuples anywhere in the chain are attempted at most once per episode", () => {
  const view = recoveryView({ deep: deepT, standard: fbT }, {
    profileFallbacks: { deep: fbT }, strategies: { degrading: true, providerSkip: null },
  });
  const first = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_error", currentIdentity: "p/m" });
  assert.deepEqual(first.candidates.map((entry) => `${entry.label}=${entry.status}`),
    ["deep.main=skipped_current_failure", "deep.fallback=selected", "standard.main=skipped_attempted"]);
  const after = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_error", attempted: ["p/m", "p/fb"] });
  assert.deepEqual(after.candidates.map((entry) => entry.status),
    ["skipped_attempted", "skipped_attempted", "skipped_attempted"]);
  assert.equal(after.reason, "chain_exhausted");
  assert.equal(after.selected, null);
});

// ---------------------------------------------------------------------------
// task_f2d0ccc6: per-slot disable (schema 5) — stored selections are skipped,
// never deleted, never a synthetic provider error.
// ---------------------------------------------------------------------------

test("schema-5 disable state is read additively, normalized for older schemas, and fail-closed on invalid shapes", async () => {
  const project = await mkdtemp(join(tmpdir(), "policy-schema5-"));
  const runtime = { project, projectHash: "project-id" } as RuntimeDescriptor;
  const directory = join(project, ".opencode-vm");
  const path = join(directory, "agent-control.json");
  await mkdir(directory);
  try {
    const disabled = {
      profiles: { deep: true, standard: false, execution: false, design: false, review: false },
      profileFallbacks: { deep: false, standard: true, execution: false, design: false, review: false },
      finalFallback: false,
    };
    const valid = { schemaVersion: 5, revision: 4, updatedAt: "2026-10-12T00:00:00Z",
      profiles: { deep: selection, standard: null, execution: null, design: null, review: null },
      finalFallback: { mode: "total", selection }, profileFallbacks: { deep: null, standard: selection, execution: null, design: null, review: null },
      strategies: { degrading: null, providerSkip: null }, disabled };
    await writeFile(path, JSON.stringify(valid));
    const policy = await readPolicy(runtime);
    assert.equal(policy.schemaVersion, 5);
    assert.equal(policy.disabled.profiles.deep, true);
    assert.equal(policy.disabled.profileFallbacks.standard, true);
    assert.equal(policy.disabled.finalFallback, false);
    // The stored selections survive byte-exact beside the disable state.
    assert.deepEqual(policy.profiles.deep, selection);
    assert.deepEqual(policy.profileFallbacks.standard, selection);
    const described = describePolicy(runtime, policy, catalog);
    assert.equal(described.profiles.deep?.disabled, true);
    assert.equal(described.profile_fallbacks.standard?.disabled, true);
    assert.equal(described.final_fallback?.disabled, false);
    assert.equal(described.routing.regime, "per_profile",
      "schema 5 keeps the schema-4 regime rule: a configured own fallback is per_profile");
    await writeFile(path, JSON.stringify({ ...valid, profileFallbacks: { deep: null, standard: null, execution: null, design: null, review: null } }));
    const unset = await readPolicy(runtime);
    assert.equal(routingRegime(unset).regime, "legacy_final_fallback",
      "a schema-5 policy without configured fallbacks/switches keeps today's legacy regime");
    // Schema 1-4 normalize to everything enabled.
    await writeFile(path, JSON.stringify({ schemaVersion: 3, revision: 2, updatedAt: "2026-10-12T00:00:00Z",
      profiles: valid.profiles, finalFallback: null }));
    const legacy = await readPolicy(runtime);
    assert.deepEqual(legacy.disabled, { profiles: { deep: false, standard: false, execution: false, design: false, review: false },
      profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false }, finalFallback: false });
    for (const bad of [
      { ...valid, disabled: { ...disabled, profiles: { deep: true, standard: false, execution: false, design: false } } },
      { ...valid, disabled: { ...disabled, finalFallback: "no" } },
      { ...valid, disabled: { profiles: disabled.profiles, profileFallbacks: disabled.profileFallbacks } },
      { ...valid, disabled: { ...disabled, extra: true } },
      { ...valid, disabled: { ...disabled, profiles: { ...disabled.profiles, deep: "yes" } } },
      { ...valid, schemaVersion: 4 },
    ]) {
      await writeFile(path, JSON.stringify(bad));
      await assert.rejects(readPolicy(runtime), { code: "UNSUPPORTED_CONFIGURATION" });
    }
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("schema-5 routing regime stays per_profile for configured fallbacks and candidate_order ignores disabled state", () => {
  const view = recoveryView({ deep: deepT, standard: null, execution: null }, {
    profileFallbacks: { deep: fbT }, strategies: { degrading: true, providerSkip: null },
    disabled: { profiles: { deep: true } }, schemaVersion: 5,
  });
  assert.equal(view.routing.regime, "per_profile");
  assert.deepEqual(candidateOrder(view as never, "deep"), ["deep.main", "deep.fallback"],
    "candidate_order stays the pure configuration projection");
});

test("new-start formation: per_profile main then own fallback, degrading stages only when activated; legacy entry plus resolution map, never the final stage", () => {
  const perProfile = recoveryView({ deep: deepT, standard: qT, execution: qT }, {
    profileFallbacks: { deep: fbT, standard: null, execution: null }, strategies: { degrading: true, providerSkip: null },
  });
  assert.deepEqual(newStartCandidates(perProfile, "deep").map((entry) => entry.label),
    ["deep.main", "deep.fallback", "standard.main", "execution.main"]);
  const noDegrade = recoveryView({ deep: deepT, standard: qT }, {
    profileFallbacks: { deep: fbT }, strategies: { degrading: false, providerSkip: null },
  });
  assert.deepEqual(newStartCandidates(noDegrade, "deep").map((entry) => entry.label), ["deep.main", "deep.fallback"]);
  const legacy = recoveryView({ review: deepT, deep: fbT, standard: qT }, { finalFallback: { mode: "total", selection: qT }, schemaVersion: 3 });
  assert.deepEqual(newStartCandidates(legacy, "review").map((entry) => entry.label),
    ["review.main", "deep.main", "standard.main"],
    "the legacy error fallback is never a new-start candidate");
  assert.deepEqual(newStartCandidates(legacy, "deep").map((entry) => entry.label), ["deep.main"]);
  // Design falls back to standard's MAIN slot in legacy regime (existing resolution map).
  assert.deepEqual(newStartCandidates(legacy, "design").map((entry) => entry.label), ["standard.main"],
    "unconfigured slots are absent from the formation");
});

test("recovery chain: disabled slots are skipped with an honest status, before availability and after failure evidence", () => {
  const view = recoveryView({ deep: deepT, standard: qT }, {
    profileFallbacks: { deep: fbT }, strategies: { degrading: true, providerSkip: null },
    disabled: { profiles: { standard: true } },
  });
  const chain = resolveRecoveryChain(view, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", currentIdentity: "p/m" });
  assert.deepEqual(chain.candidates.map((entry) => `${entry.label}=${entry.status}`),
    ["deep.main=skipped_current_failure", "deep.fallback=selected", "standard.main=skipped_attempted"],
    "after a winner the remaining slots keep the existing skipped_attempted convention");
  // Disabled never becomes an attempt and never a provider request; the identical
  // runtime in another ACTIVE slot stays selectable (no identity ban).
  const ownDisabled = recoveryView({ deep: deepT, standard: qT }, {
    profileFallbacks: { deep: qT }, strategies: { degrading: true, providerSkip: null },
    disabled: { profileFallbacks: { deep: true } },
  });
  const other = resolveRecoveryChain(ownDisabled, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota", currentIdentity: "p/m" });
  assert.deepEqual(other.candidates.map((entry) => `${entry.label}=${entry.status}`),
    ["deep.main=skipped_current_failure", "deep.fallback=skipped_disabled", "standard.main=selected"]);
  assert.equal(other.selected_identity, "q/m");
  // A really failed runtime keeps the stronger attempted status even when disabled meanwhile.
  const midEpisode = resolveRecoveryChain(view, {
    entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_quota",
    attempted: ["q/m"], currentIdentity: "p/m",
  });
  assert.equal(midEpisode.candidates.find((entry) => entry.label === "standard.main")?.status, "skipped_attempted");
  // Legacy: disabled degrade stage mains and a disabled final stage are skipped.
  const legacy = recoveryView({ deep: deepT, standard: qT, execution: fbT }, {
    finalFallback: { mode: "degrading", selection: qT }, schemaVersion: 3,
    disabled: { profiles: { standard: true }, finalFallback: true },
  });
  const legacyChain = resolveRecoveryChain(legacy, { entryProfile: "deep", catalog: fullCatalog, evidenceCategory: "provider_timeout", currentIdentity: "p/m" });
  assert.deepEqual(legacyChain.candidates.map((entry) => `${entry.label}=${entry.status}`),
    ["degrade.standard.main=skipped_disabled", "degrade.execution.main=selected", "final.main=skipped_attempted"],
    "after a winner the remaining slots keep the existing skipped_attempted convention");
  assert.equal(legacyChain.selected_identity, "p/fb");
});

test("resolveProfile: disabled slots are skipped, hold_disabled is distinct from unconfigured, and the effective path stays visible", () => {
  const high: ViewTuple = { provider_id: "p", model_id: "m", variant: "high" };
  const disabledMain = recoveryView({ deep: high, standard: qT }, {
    disabled: { profiles: { deep: true } }, schemaVersion: 5,
  });
  const deep = resolveProfile(disabledMain as never, "deep", catalog);
  assert.equal(deep.status, "hold_disabled");
  assert.deepEqual(deep.candidates, [{ label: "deep.main", disabled: true, status: "skipped_disabled" }]);
  assert.deepEqual(deep.resolution_path, ["deep"]);
  assert.equal("runtime" in deep, false);
  // design walks past its disabled main to the active standard main.
  // design walks past its disabled main to the active standard main.
  const designView = recoveryView({ design: high, standard: { ...high, variant: "default" } }, { disabled: { profiles: { design: true } }, schemaVersion: 5 });
  const design = resolveProfile(designView as never, "design", catalog);
  assert.equal(design.status, "available");
  assert.equal(design.resolved_label, "standard.main");
  assert.deepEqual(design.candidates.map((entry) => `${entry.label}=${entry.status}`),
    ["design.main=skipped_disabled", "standard.main=available"],
    "the winner carries its catalog status; selection is the result itself");
  // per_profile: own fallback wins after the paused main.
  const withOwn = recoveryView({ deep: high, standard: null, execution: null }, {
    profileFallbacks: { deep: { ...high, variant: "default" } }, strategies: { degrading: null, providerSkip: null },
    disabled: { profiles: { deep: true } }, schemaVersion: 5,
  });
  const resolved = resolveProfile(withOwn as never, "deep", catalog);
  assert.equal(resolved.status, "available");
  assert.equal(resolved.resolved_label, "deep.fallback");
  // Re-enabling restores the identical stored selection.
  const reEnabled = recoveryView({ deep: high, standard: null, execution: null }, { schemaVersion: 5 });
  const restored = resolveProfile(reEnabled as never, "deep", catalog);
  assert.equal(restored.resolved_label, "deep.main");
  assert.deepEqual(restored.runtime, high);
  // An enabled but catalog-unavailable slot still stops the walk (never substituted);
  // deep has no resolution fallback, so the unavailable entry main ends the walk.
  const unavailableView = recoveryView({ deep: { ...high, model_id: "gone" }, standard: qT }, { schemaVersion: 5 });
  const unavailable = resolveProfile(unavailableView as never, "deep", catalog);
  assert.equal(unavailable.status, "model_unavailable");
  assert.equal(unavailable.resolved_label, "deep.main");
  assert.deepEqual(unavailable.candidates, [{ label: "deep.main", disabled: false, status: "model_unavailable" }]);
});

test("describePolicy exposes the effective resolution block for every profile", () => {
  const view = recoveryView({ deep: { ...deepT, variant: "high" }, standard: { ...deepT, variant: "high" }, execution: null, design: null, review: null }, {
    disabled: { profiles: { deep: true } }, schemaVersion: 5,
  });
  const described = describePolicy({ project: "/p", projectHash: "project-id" } as never, view as never, catalog);
  assert.equal(described.resolution.deep?.status, "hold_disabled");
  assert.equal(described.resolution.review?.status, "available", "review walks review(null-skip), deep(disabled-skip) then standard");
  assert.equal(described.resolution.review?.resolved_label, "standard.main");
  assert.ok(described.resolution.execution?.candidates.every((entry) => entry.disabled === false));
});
