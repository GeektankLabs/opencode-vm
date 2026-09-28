import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describePolicy, profileState, readPolicy } from "./agent-control.js";
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
    assert.equal(describePolicy(runtime, policy, catalog).profiles.deep?.status, "available");
    await writeFile(join(directory, "agent-control.json"), JSON.stringify({ ...policy, schemaVersion: 2 }));
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
