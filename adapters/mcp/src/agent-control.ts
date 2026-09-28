import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError, type RuntimeDescriptor, type RuntimeOptions } from "./types.js";

export const PROFILE_NAMES = ["deep", "standard", "execution"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
type Selection = { provider_id: string; model_id: string; variant: string };
type Policy = {
  schemaVersion: 1;
  revision: number;
  updatedAt: string | null;
  profiles: Record<ProfileName, Selection | null>;
};

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\s\x00-\x1f\x7f]/u.test(value) &&
  !/^(?:\/|\\|file:|bearer|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})|:\/\//iu.test(value);

export async function readPolicy(runtime: RuntimeDescriptor): Promise<Policy> {
  const directory = join(runtime.project, ".opencode-vm");
  const path = join(directory, "agent-control.json");
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("unsafe directory");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024)
      throw new Error("unsafe policy file");
    const policy: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("invalid policy");
    const value = policy as Record<string, unknown>;
    if (Object.keys(value).sort().join() !== "profiles,revision,schemaVersion,updatedAt" ||
      value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
      typeof value.updatedAt !== "string" || !value.updatedAt.endsWith("Z") ||
      !value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles))
      throw new Error("unsupported policy");
    const profiles = value.profiles as Record<string, unknown>;
    if (Object.keys(profiles).sort().join() !== [...PROFILE_NAMES].sort().join()) throw new Error("invalid profiles");
    for (const name of PROFILE_NAMES) {
      const selection = profiles[name];
      if (selection === null) continue;
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("invalid selection");
      const fields = selection as Record<string, unknown>;
      if (Object.keys(fields).sort().join() !== "model_id,provider_id,variant" ||
        !id(fields.provider_id) || !id(fields.model_id) || !id(fields.variant))
        throw new Error("invalid selection");
    }
    return policy as Policy;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A missing directory or file is a virtual, entirely unconfigured policy.
      return { schemaVersion: 1, revision: 0, updatedAt: null,
        profiles: { deep: null, standard: null, execution: null } };
    }
    throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project Agent Control policy is invalid or unsupported.");
  }
}

export function profileState(selection: Selection | null, catalog?: RuntimeOptions) {
  if (!selection) return "unconfigured";
  if (!catalog) return "catalog_unavailable";
  if (catalog.truncated) return "catalog_incomplete";
  if (!catalog.providers.some((item) => item.provider_id === selection.provider_id)) return "provider_unavailable";
  const model = catalog.models.find((item) => item.provider_id === selection.provider_id && item.model_id === selection.model_id);
  if (!model) return "model_unavailable";
  return model.variants.includes(selection.variant) ? "available" : "variant_unavailable";
}

export function describePolicy(runtime: RuntimeDescriptor, policy: Policy, catalog?: RuntimeOptions) {
  return {
    project_id: runtime.projectHash, schema_version: policy.schemaVersion,
    revision: policy.revision, updated_at: policy.updatedAt,
    catalog_status: !catalog ? "unavailable" : catalog.truncated ? "incomplete" : "complete",
    profiles: Object.fromEntries(PROFILE_NAMES.map((name) => [name, {
      selection: policy.profiles[name], status: profileState(policy.profiles[name], catalog),
    }])),
  };
}
