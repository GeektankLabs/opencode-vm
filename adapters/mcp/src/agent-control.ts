import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError, type RuntimeDescriptor, type RuntimeOptions } from "./types.js";

export const PROFILE_NAMES = ["deep", "standard", "execution", "design", "review"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];
export const FALLBACKS: Partial<Record<ProfileName, ProfileName[]>> = { design: ["standard"], review: ["deep", "standard"] };
export const FINAL_FALLBACK_MODES = ["total", "degrading"] as const;
/** Additive schema-4 strategy switches; `null` means "not explicitly set". */
export const STRATEGY_KEYS = ["degrading", "providerSkip"] as const;
export type StrategyKey = (typeof STRATEGY_KEYS)[number];
export type Strategies = { degrading: boolean | null; providerSkip: boolean | null };
/** Regular degrading order with the existing special-role entry points. */
export const STAGE_ORDER: Record<ProfileName, ProfileName[]> = {
  deep: ["deep", "standard", "execution"],
  standard: ["standard", "execution"],
  execution: ["execution"],
  design: ["design", "standard", "execution"],
  review: ["review", "deep", "standard", "execution"],
};
export type RoutingRegime = "legacy_final_fallback" | "per_profile";
type Selection = { provider_id: string; model_id: string; variant: string };
type FinalFallback = { mode: (typeof FINAL_FALLBACK_MODES)[number]; selection: Selection } | null;
type ProfileFallbacks = Record<ProfileName, Selection | null>;
type Policy = {
  schemaVersion: 1 | 2 | 3 | 4;
  revision: number;
  updatedAt: string | null;
  profiles: Record<ProfileName, Selection | null>;
  finalFallback: FinalFallback;
  profileFallbacks: ProfileFallbacks;
  strategies: Strategies;
};

export type PolicySelection = Selection;
export type PolicyFinalFallback = FinalFallback;
export type PolicyStrategies = Strategies;
export type AgentControlPolicy = Policy;

const NO_OWN_FALLBACKS = (): ProfileFallbacks =>
  ({ deep: null, standard: null, execution: null, design: null, review: null }) as ProfileFallbacks;
const NO_SELECTIONS = (): Record<ProfileName, Selection | null> =>
  ({ deep: null, standard: null, execution: null, design: null, review: null });
const NO_STRATEGIES = (): Strategies => ({ degrading: null, providerSkip: null });

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\s\x00-\x1f\x7f]/u.test(value) &&
  !/^(?:\/|\\|file:|bearer|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})|:\/\//iu.test(value);

const EXPECTED_KEYS: Record<number, string> = {
  1: "profiles,revision,schemaVersion,updatedAt",
  2: "profiles,revision,schemaVersion,updatedAt",
  3: "finalFallback,profiles,revision,schemaVersion,updatedAt",
  4: "finalFallback,profileFallbacks,profiles,revision,schemaVersion,strategies,updatedAt",
};

function parseSelection(raw: unknown, label: string): Selection | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(label);
  const fields = raw as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== "model_id,provider_id,variant" ||
    !id(fields.provider_id) || !id(fields.model_id) || !id(fields.variant)) throw new Error(label);
  return { provider_id: fields.provider_id as string, model_id: fields.model_id as string, variant: fields.variant as string };
}

function parseStrategies(raw: unknown): Strategies {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid strategies");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== [...STRATEGY_KEYS].sort().join()) throw new Error("invalid strategies");
  const result = {} as Strategies;
  for (const key of STRATEGY_KEYS) {
    const item = value[key];
    if (item !== null && typeof item !== "boolean") throw new Error("invalid strategies");
    result[key] = item as boolean | null;
  }
  return result;
}

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
    const schema = value.schemaVersion as number;
    const keys = Object.keys(value).sort().join();
    if (keys !== EXPECTED_KEYS[schema] ||
      ![1, 2, 3, 4].includes(schema) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
      typeof value.updatedAt !== "string" || !value.updatedAt.endsWith("Z") ||
      !value.profiles || typeof value.profiles !== "object" || Array.isArray(value.profiles))
      throw new Error("unsupported policy");
    const profiles = value.profiles as Record<string, unknown>;
    const names = schema === 1 ? PROFILE_NAMES.slice(0, 3) : PROFILE_NAMES;
    if (Object.keys(profiles).sort().join() !== [...names].sort().join()) throw new Error("invalid profiles");
    for (const name of names) parseSelection(profiles[name], "invalid selection");
    let finalFallback: FinalFallback = null;
    if (schema >= 3) {
      const raw = value.finalFallback;
      if (raw !== null) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid final fallback");
        const fields = raw as Record<string, unknown>;
        if (Object.keys(fields).sort().join() !== "mode,selection") throw new Error("invalid final fallback");
        const selection = parseSelection(fields.selection, "invalid final fallback");
        if (selection === null) throw new Error("invalid final fallback");
        if (fields.mode !== "total" && fields.mode !== "degrading") throw new Error("invalid final fallback mode");
        finalFallback = { mode: fields.mode, selection };
      }
    }
    let profileFallbacks: ProfileFallbacks = NO_OWN_FALLBACKS();
    let strategies: Strategies = NO_STRATEGIES();
    if (schema === 4) {
      const raw = value.profileFallbacks;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid profile fallbacks");
      const entries = raw as Record<string, unknown>;
      if (Object.keys(entries).sort().join() !== [...PROFILE_NAMES].sort().join()) throw new Error("invalid profile fallbacks");
      for (const name of PROFILE_NAMES) profileFallbacks[name] = parseSelection(entries[name], "invalid profile fallbacks");
      strategies = parseStrategies(value.strategies);
    }
    return { schemaVersion: schema as Policy["schemaVersion"], revision: value.revision as number,
      updatedAt: value.updatedAt as string,
      profiles: { ...NO_SELECTIONS(), ...profiles },
      finalFallback, profileFallbacks, strategies };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A missing directory or file is a virtual, entirely unconfigured policy.
      return { schemaVersion: 1, revision: 0, updatedAt: null,
        profiles: { deep: null, standard: null, execution: null, design: null, review: null },
        finalFallback: null, profileFallbacks: NO_OWN_FALLBACKS(), strategies: NO_STRATEGIES() };
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

/**
 * Explicit routing regime; the legacy global final stage is never reinterpreted.
 *
 * `per_profile` requires schema 4 *and* an actually configured own fallback or an
 * explicitly set switch, so existing schema 1/2/3 configurations and a schema-4
 * document with everything unset keep today's behaviour exactly. In the
 * per-profile regime the legacy `finalFallback` stays stored and readable but is
 * deliberately not part of the chain — that relationship is surfaced, not hidden.
 */
export function routingRegime(policy: Policy) {
  const strategies = policy.strategies ?? NO_STRATEGIES();
  const own = policy.profileFallbacks ?? NO_OWN_FALLBACKS();
  const perProfile = policy.schemaVersion === 4 &&
    (PROFILE_NAMES.some((name) => own[name] !== null) ||
      strategies.degrading !== null || strategies.providerSkip !== null);
  return {
    regime: (perProfile ? "per_profile" : "legacy_final_fallback") as RoutingRegime,
    legacy_final_stage_applies: !perProfile,
    strategies_effective: { degrading: strategies.degrading === true, provider_skip: strategies.providerSkip === true },
  };
}

/**
 * Deterministic configured-candidate order for one entry profile.
 *
 * Pure configuration projection: within each stage the main model precedes that
 * stage's own fallback, unconfigured entries are skipped, and degrading must be
 * explicitly activated to continue with the next regular stage. Runtime filtering
 * (an already failed identical runtime, failed provider identities when provider
 * skip is on, unavailable candidates) stays a documented management-layer step.
 * `null` in the legacy regime, where today's chains apply unchanged.
 */
export function candidateOrder(policy: Policy, profile: ProfileName): string[] | null {
  const routing = routingRegime(policy);
  if (routing.regime !== "per_profile") return null;
  const stages = routing.strategies_effective.degrading ? STAGE_ORDER[profile] : ([profile] as ProfileName[]);
  const order: string[] = [];
  for (const stage of stages) {
    if (policy.profiles[stage] !== null) order.push(`${stage}.main`);
    if (policy.profileFallbacks[stage] !== null) order.push(`${stage}.fallback`);
  }
  return order;
}

export function describePolicy(runtime: RuntimeDescriptor, policy: Policy, catalog?: RuntimeOptions) {
  return {
    project_id: runtime.projectHash, schema_version: policy.schemaVersion,
    revision: policy.revision, updated_at: policy.updatedAt,
    catalog_status: !catalog ? "unavailable" : catalog.truncated ? "incomplete" : "complete",
    fallbacks: FALLBACKS,
    profiles: Object.fromEntries(PROFILE_NAMES.map((name) => [name, {
      selection: policy.profiles[name], status: profileState(policy.profiles[name], catalog),
    }])),
    final_fallback: policy.finalFallback
      ? { mode: policy.finalFallback.mode, selection: policy.finalFallback.selection,
          status: profileState(policy.finalFallback.selection, catalog) }
      : null,
    profile_fallbacks: Object.fromEntries(PROFILE_NAMES.map((name) => [name, {
      selection: policy.profileFallbacks[name], status: profileState(policy.profileFallbacks[name], catalog),
    }])),
    strategies: { degrading: policy.strategies.degrading, provider_skip: policy.strategies.providerSkip },
    routing: { ...routingRegime(policy),
      candidate_order: Object.fromEntries(PROFILE_NAMES.map((name) => [name, candidateOrder(policy, name)])) },
  };
}

export function resolveProfile(policy: Policy, profile: ProfileName, catalog?: RuntimeOptions) {
  const resolution_path: ProfileName[] = [];
  for (const candidate of [profile, ...(FALLBACKS[profile] ?? [])]) {
    resolution_path.push(candidate);
    const selection = policy.profiles[candidate];
    if (selection === null) continue;
    const status = profileState(selection, catalog);
    return { profile, policy_revision: policy.revision, status, resolved_profile: candidate, resolution_path,
      ...(status === "available" ? { runtime: selection } : {}) };
  }
  return { profile, policy_revision: policy.revision, status: "unconfigured" as const, resolution_path };
}
