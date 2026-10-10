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

// ---------------------------------------------------------------------------
// Welle B (be951293): shared recovery-policy resolution — exactly once in
// TypeScript, used by the adapter and the Monitor Engine alike (concept §4.4,
// R2 engine-canonical contract). Pure functions over the policy view: no
// second implementation may appear in monitor-engine.ts or the Hub; the Hub
// later only reads the engine-persisted projection.
// ---------------------------------------------------------------------------

export type RecoveryRuntimeTuple = { provider_id: string; model_id: string; variant?: string };

/** The full Schema-4 policy view as transported to the engine. Optional
 * additive fields keep reduced/legacy views valid: an absent `routing`
 * means the legacy regime (today's chain semantics unchanged). */
export type RecoveryPolicyView = {
  finalFallback: { mode: (typeof FINAL_FALLBACK_MODES)[number]; selection: RecoveryRuntimeTuple } | null;
  profiles: Partial<Record<string, RecoveryRuntimeTuple | null>>;
  profileFallbacks?: Partial<Record<string, RecoveryRuntimeTuple | null>>;
  strategies?: Strategies;
  routing?: { regime: RoutingRegime; legacy_final_stage_applies: boolean; strategies_effective: { degrading: boolean; provider_skip: boolean } };
  revision?: number | null;
};

/** Selection contract (task_ad26435f, concept §4.1 Ziffer 2): recovery
 * admission is exactly this explicit terminal provider-error set. Everything
 * else — `unknown`, fachliche Fehler, pending permissions/questions,
 * INPUT_REQUIRED, aborted — is never provider routing. */
export const PROVIDER_ERROR_ADMISSION = [
  "provider_header_timeout",
  "provider_response_stream_error",
  "provider_error",
  "provider_timeout",
  "provider_quota",
  "provider_auth",
] as const;

export function isRecoveryProviderAdmission(category: string): boolean {
  return (PROVIDER_ERROR_ADMISSION as readonly string[]).includes(category);
}

/** Central evidence semantics for the Provider-Skip gate: only quota and auth
 * are account/provider-wide failure proof. A single request timeout or stream
 * error is not, and the same provider_id alone is never an area conclusion. */
export function providerFailureScope(category: string): "account_scope" | "request_level" {
  return category === "provider_quota" || category === "provider_auth" ? "account_scope" : "request_level";
}

/** Full runtime identity provider/model/variant — persistent attempted keys. */
export function runtimeIdentityKey(selection: RecoveryRuntimeTuple): string {
  return `${selection.provider_id}/${selection.model_id}${selection.variant !== undefined ? `/${selection.variant}` : ""}`;
}

export function catalogAvailable(
  catalog: RuntimeOptions,
  selection: RecoveryRuntimeTuple,
): boolean {
  const provider = catalog.providers.find((entry) => entry.provider_id === selection.provider_id);
  if (!provider) return false;
  const model = catalog.models.find(
    (entry) => entry.provider_id === selection.provider_id && entry.model_id === selection.model_id,
  );
  if (!model) return false;
  if (selection.variant !== undefined) {
    const variants = model.variants ?? [];
    if (variants.length > 0 && !variants.includes(selection.variant)) return false;
  }
  return true;
}

/**
 * Legacy regime chain — today's semantics preserved unchanged (monitor-engine
 * fallbackChain moved here as the single canonical implementation): only a
 * `degrading` finalFallback mode descends, the global final stage always
 * applies when configured, Schema-4 fields are never reinterpreted.
 */
export function fallbackChain(
  policy: RecoveryPolicyView,
  monitorProfile: string,
): RecoveryRuntimeTuple[] {
  const order: string[] =
    monitorProfile === "design" || monitorProfile === "review"
      ? ["standard", "execution"]
      : monitorProfile === "deep"
        ? ["standard", "execution"]
        : ["execution"];
  const chain: RecoveryRuntimeTuple[] = [];
  if (policy.finalFallback && policy.finalFallback.mode === "degrading") {
    for (const profile of order) {
      const entry = policy.profiles[profile];
      if (entry) chain.push({ ...entry });
    }
  }
  if (policy.finalFallback) chain.push({ ...policy.finalFallback.selection });
  return chain;
}

export type RecoveryCandidateStatus =
  | "selected"
  | "skipped_current_failure"
  | "skipped_attempted"
  | "skipped_provider_scope"
  | "skipped_unavailable";

export type RecoveryChainCandidate = { label: string; identity: string; tuple: RecoveryRuntimeTuple; status: RecoveryCandidateStatus };

export type RecoveryChain = {
  regime: RoutingRegime;
  policy_revision: number | null;
  entry_profile: string;
  candidates: RecoveryChainCandidate[];
  selected: RecoveryRuntimeTuple | null;
  selected_identity: string | null;
  reason: "selected" | "chain_empty" | "chain_exhausted";
};

/**
 * The one shared candidate resolution (concept §4.4): stage label → full
 * tuple (provider/model/variant), catalog availability (existing
 * catalogAvailable semantics), persistent attempted filter, and the
 * Provider-Skip gate with central evidence semantics. The legacy regime keeps
 * `fallbackChain` semantics unchanged; per_profile chains never silently
 * append the legacy global final stage (routingRegime contract).
 * Without a fetched catalog every candidate is honestly `skipped_unavailable`
 * — an unchecked catalog is never treated as availability proof.
 */
export function resolveRecoveryChain(
  policy: RecoveryPolicyView,
  params: {
    entryProfile: string;
    catalog?: RuntimeOptions;
    evidenceCategory: string;
    evidenceProviderId?: string | null;
    attempted?: string[];
    currentIdentity?: string | null;
  },
): RecoveryChain {
  const regime: RoutingRegime = policy.routing?.regime ?? "legacy_final_fallback";
  const raw: Array<{ label: string; tuple: RecoveryRuntimeTuple }> = [];
  if (regime === "per_profile") {
    const effective = policy.routing?.strategies_effective ?? { degrading: false, provider_skip: false };
    const stages: string[] = effective.degrading && (STAGE_ORDER as Record<string, string[]>)[params.entryProfile]
      ? (STAGE_ORDER as Record<string, string[]>)[params.entryProfile]!
      : [params.entryProfile];
    for (const stage of stages) {
      const main = policy.profiles[stage];
      if (main) raw.push({ label: `${stage}.main`, tuple: main });
      const own = policy.profileFallbacks?.[stage];
      if (own) raw.push({ label: `${stage}.fallback`, tuple: own });
    }
  } else {
    const order: string[] =
      params.entryProfile === "design" || params.entryProfile === "review"
        ? ["standard", "execution"]
        : params.entryProfile === "deep"
          ? ["standard", "execution"]
          : ["execution"];
    if (policy.finalFallback && policy.finalFallback.mode === "degrading") {
      for (const profile of order) {
        const entry = policy.profiles[profile];
        if (entry) raw.push({ label: `degrade.${profile}.main`, tuple: entry });
      }
    }
    if (policy.finalFallback) raw.push({ label: "final.main", tuple: policy.finalFallback.selection });
  }
  const attempted = new Set(params.attempted ?? []);
  const providerSkip = policy.routing?.strategies_effective.provider_skip === true;
  const accountScope = providerFailureScope(params.evidenceCategory) === "account_scope";
  const candidates: RecoveryChainCandidate[] = raw.map((entry) => ({
    label: entry.label,
    identity: runtimeIdentityKey(entry.tuple),
    tuple: entry.tuple,
    status: "selected" as RecoveryCandidateStatus,
  }));
  let selectedIdentity: string | null = null;
  for (const candidate of candidates) {
    if (selectedIdentity !== null) {
      candidate.status = "skipped_attempted";
      continue;
    }
    if (params.currentIdentity && candidate.identity === params.currentIdentity) {
      candidate.status = "skipped_current_failure";
      continue;
    }
    if (attempted.has(candidate.identity)) {
      candidate.status = "skipped_attempted";
      continue;
    }
    if (!params.catalog || !catalogAvailable(params.catalog, candidate.tuple)) {
      candidate.status = "skipped_unavailable";
      continue;
    }
    if (providerSkip && accountScope && params.evidenceProviderId && candidate.tuple.provider_id === params.evidenceProviderId) {
      candidate.status = "skipped_provider_scope";
      continue;
    }
    selectedIdentity = candidate.identity;
  }
  const selected = selectedIdentity === null ? null : candidates.find((entry) => entry.identity === selectedIdentity)!.tuple;
  return {
    regime,
    policy_revision: policy.revision ?? null,
    entry_profile: params.entryProfile,
    candidates,
    selected,
    selected_identity: selectedIdentity,
    reason: candidates.length === 0 ? "chain_empty" : selectedIdentity === null ? "chain_exhausted" : "selected",
  };
}
