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
/** Schema 5 slot-disable state: the per-slot manual pause. A stored selection
 * is never deleted; a disabled slot is skipped by every effective resolution
 * (never a provider request, never a synthetic error). Missing flag (schema 1-4
 * policies) means enabled. No expiry, no automatic re-enable. */
export type SlotDisabled = {
  profiles: Record<ProfileName, boolean>;
  profileFallbacks: Record<ProfileName, boolean>;
  finalFallback: boolean;
};
export type PolicyFinalFallbackEnabled = SlotDisabled["finalFallback"];
type Policy = {
  schemaVersion: 1 | 2 | 3 | 4 | 5;
  revision: number;
  updatedAt: string | null;
  profiles: Record<ProfileName, Selection | null>;
  finalFallback: FinalFallback;
  profileFallbacks: ProfileFallbacks;
  strategies: Strategies;
  disabled: SlotDisabled;
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
const NO_DISABLED = (): SlotDisabled =>
  ({ profiles: { deep: false, standard: false, execution: false, design: false, review: false },
    profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false },
    finalFallback: false });

const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\s\x00-\x1f\x7f]/u.test(value) &&
  !/^(?:\/|\\|file:|bearer|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})|:\/\//iu.test(value);

const EXPECTED_KEYS: Record<number, string> = {
  1: "profiles,revision,schemaVersion,updatedAt",
  2: "profiles,revision,schemaVersion,updatedAt",
  3: "finalFallback,profiles,revision,schemaVersion,updatedAt",
  4: "finalFallback,profileFallbacks,profiles,revision,schemaVersion,strategies,updatedAt",
  5: "disabled,finalFallback,profileFallbacks,profiles,revision,schemaVersion,strategies,updatedAt",
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

function parseDisabled(raw: unknown): SlotDisabled {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid disabled");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "finalFallback,profileFallbacks,profiles") throw new Error("invalid disabled");
  const boolMap = (entry: unknown): Record<ProfileName, boolean> => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid disabled");
    const map = entry as Record<string, unknown>;
    if (Object.keys(map).sort().join() !== [...PROFILE_NAMES].sort().join()) throw new Error("invalid disabled");
    return Object.fromEntries(PROFILE_NAMES.map((name) => {
      const item = map[name];
      if (typeof item !== "boolean") throw new Error("invalid disabled");
      return [name, item];
    })) as Record<ProfileName, boolean>;
  };
  if (typeof value.finalFallback !== "boolean") throw new Error("invalid disabled");
  return { profiles: boolMap(value.profiles), profileFallbacks: boolMap(value.profileFallbacks), finalFallback: value.finalFallback };
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
      ![1, 2, 3, 4, 5].includes(schema) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
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
    if (schema === 4 || schema === 5) {
      const raw = value.profileFallbacks;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid profile fallbacks");
      const entries = raw as Record<string, unknown>;
      if (Object.keys(entries).sort().join() !== [...PROFILE_NAMES].sort().join()) throw new Error("invalid profile fallbacks");
      for (const name of PROFILE_NAMES) profileFallbacks[name] = parseSelection(entries[name], "invalid profile fallbacks");
      strategies = parseStrategies(value.strategies);
    }
    // Schema 1-4 policies carry no disable state: every slot is enabled. The
    // normalized view is total, so no consumer branches on the schema version.
    const disabled: SlotDisabled = schema === 5 ? parseDisabled(value.disabled) : NO_DISABLED();
    return { schemaVersion: schema as Policy["schemaVersion"], revision: value.revision as number,
      updatedAt: value.updatedAt as string,
      profiles: { ...NO_SELECTIONS(), ...profiles },
      finalFallback, profileFallbacks, strategies, disabled };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A missing directory or file is a virtual, entirely unconfigured policy.
      return { schemaVersion: 1, revision: 0, updatedAt: null,
        profiles: { deep: null, standard: null, execution: null, design: null, review: null },
        finalFallback: null, profileFallbacks: NO_OWN_FALLBACKS(), strategies: NO_STRATEGIES(),
        disabled: NO_DISABLED() };
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
  // Schema 5 is additive on 4: a configured own fallback or an explicit switch
  // still makes the regime per_profile. The disable state never changes it.
  const perProfile = policy.schemaVersion >= 4 &&
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
      disabled: policy.disabled.profiles[name],
    }])),
    final_fallback: policy.finalFallback
      ? { mode: policy.finalFallback.mode, selection: policy.finalFallback.selection,
          status: profileState(policy.finalFallback.selection, catalog),
          disabled: policy.disabled.finalFallback }
      : null,
    profile_fallbacks: Object.fromEntries(PROFILE_NAMES.map((name) => [name, {
      selection: policy.profileFallbacks[name], status: profileState(policy.profileFallbacks[name], catalog),
      disabled: policy.disabled.profileFallbacks[name],
    }])),
    strategies: { degrading: policy.strategies.degrading, provider_skip: policy.strategies.providerSkip },
    // task_f2d0ccc6: effective NEW-START resolution per profile from the one
    // shared candidate formation — disabled slots skipped, winner and every
    // skip reason visible. Pure management readback, never a dispatch.
    resolution: Object.fromEntries(PROFILE_NAMES.map((name) => {
      const result = resolveProfile(policy, name, catalog);
      return [name, {
        status: result.status,
        resolved_label: result.resolved_label,
        ...(result.status === "available" ? { runtime: result.runtime } : {}),
        candidates: result.candidates,
      }];
    })),
    routing: { ...routingRegime(policy),
      candidate_order: Object.fromEntries(PROFILE_NAMES.map((name) => [name, candidateOrder(policy, name)])) },
  };
}

/** Effective NEW-START resolution for one profile (task_f2d0ccc6): the ordered
 * shared candidate formation; disabled slots are skipped (never a request,
 * never a synthetic error), the order of active slots is preserved, and the
 * identical runtime in another active slot stays selectable (no identity ban).
 * `null` slots are absent from the candidate list; an enabled configured slot
 * that is catalog-unavailable stops the walk with its honest status (existing
 * semantics, never substituted). Everything disabled (or nothing configured)
 * ends in `hold_disabled` / `unconfigured` — a precise hold, never a backend
 * default choice. */
export type ProfileResolution = {
  profile: ProfileName;
  policy_revision: number;
  status: ReturnType<typeof profileState> | "hold_disabled";
  resolution_path: ProfileName[];
  resolved_label?: string;
  resolved_profile?: ProfileName;
  candidates: Array<{ label: string; disabled: boolean; status: string }>;
  runtime?: { provider_id: string; model_id: string; variant: string };
};

export function resolveProfile(policy: Policy, profile: ProfileName, catalog?: RuntimeOptions): ProfileResolution {
  // resolution_path stays the visited prefix of the fixed primary walk (existing
  // contract, shared Python vectors): disabled slots are passed like null ones.
  const primaryWalk: ProfileName[] = [profile, ...(FALLBACKS[profile] ?? [])];
  const resolution_path: ProfileName[] = [];
  for (const name of primaryWalk) {
    resolution_path.push(name);
    const entry = policy.profiles[name];
    if (entry !== null && !slotDisabled(policy, { kind: "profile", profile: name })) break;
  }
  // The effective selection uses the shared candidate formation (own fallbacks
  // included in the per-profile regime); candidates carries every visited slot
  // with its disable flag and honest status.
  const candidates = newStartCandidates(policy, profile);
  const detail = candidates.map((candidate) => ({
    label: candidate.label,
    disabled: candidate.disabled,
    status: candidate.disabled ? "skipped_disabled" : "not_evaluated",
  }));
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    if (candidate.disabled) continue;
    const selection = candidate.tuple as { provider_id: string; model_id: string; variant: string };
    const status = profileState(selection, catalog);
    detail[index]!.status = status;
    return {
      profile, policy_revision: policy.revision, status, resolution_path,
      resolved_label: candidate.label,
      resolved_profile: candidate.ref.profile,
      candidates: detail,
      ...(status === "available" ? { runtime: selection } : {}),
    };
  }
  return {
    profile, policy_revision: policy.revision,
    status: candidates.length > 0 ? "hold_disabled" : "unconfigured",
    resolution_path, candidates: detail,
  };
}

// ---------------------------------------------------------------------------
// Welle B (be951293): shared recovery-policy resolution — exactly once in
// TypeScript, used by the adapter and the Monitor Engine alike (concept §4.4,
// R2 engine-canonical contract). Pure functions over the policy view: no
// second implementation may appear in monitor-engine.ts or the Hub; the Hub
// later only reads the engine-persisted projection.
// ---------------------------------------------------------------------------

export type RecoveryRuntimeTuple = { provider_id: string; model_id: string; variant?: string };

/** The full Schema-4/5 policy view as transported to the engine. Optional
 * additive fields keep reduced/legacy views valid: an absent `routing`
 * means the legacy regime (today's chain semantics unchanged), an absent
 * `disabled` means every slot is enabled. */
export type RecoveryPolicyView = {
  finalFallback: { mode: (typeof FINAL_FALLBACK_MODES)[number]; selection: RecoveryRuntimeTuple } | null;
  profiles: Partial<Record<string, RecoveryRuntimeTuple | null>>;
  profileFallbacks?: Partial<Record<string, RecoveryRuntimeTuple | null>>;
  strategies?: Strategies;
  disabled?: SlotDisabled;
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

// ---------------------------------------------------------------------------
// Slot-disable resolution (task_f2d0ccc6): one shared candidate formation for
// NEW-START and RECOVERY selection. A disabled slot keeps its stored selection
// but is skipped before any request is made — never a synthetic provider
// error, never a deletion. Order of active slots is preserved; the identical
// runtime in another active slot stays selectable (no identity ban).
// ---------------------------------------------------------------------------

export type SlotKind = "profile" | "profileFallback" | "finalFallback";
export type SlotRef = { kind: SlotKind; profile?: ProfileName };
export type SlotCandidate = { label: string; ref: SlotRef; tuple: RecoveryRuntimeTuple; disabled: boolean };

/** True only for an explicitly persisted disable flag; absent state = enabled. */
export function slotDisabled(policy: RecoveryPolicyView, ref: SlotRef): boolean {
  const disabled = policy.disabled;
  if (!disabled) return false;
  if (ref.kind === "profile") return disabled.profiles[ref.profile as ProfileName] === true;
  if (ref.kind === "profileFallback") return disabled.profileFallbacks[ref.profile as ProfileName] === true;
  return disabled.finalFallback === true;
}

/** The routing regime for either a transported view (routing present) or a
 * full Policy object (derive exactly like routingRegime; never reinterpret). */
function effectiveRegime(policy: RecoveryPolicyView): RoutingRegime {
  if (policy.routing) return policy.routing.regime;
  const schema = (policy as { schemaVersion?: number }).schemaVersion;
  const own = policy.profileFallbacks ?? {};
  const strategies = policy.strategies ?? { degrading: null, providerSkip: null };
  const perProfile = (schema === 4 || schema === 5) &&
    (PROFILE_NAMES.some((name) => own[name] !== null && own[name] !== undefined) ||
      strategies.degrading !== null || strategies.providerSkip !== null);
  return perProfile ? "per_profile" : "legacy_final_fallback";
}

function effectiveDegrading(policy: RecoveryPolicyView): boolean {
  if (policy.routing) return policy.routing.strategies_effective.degrading === true;
  return policy.strategies?.degrading === true;
}

/**
 * Ordered NEW-START candidate formation over stored slots (main before that
 * stage's own fallback). per_profile regime: entry stage, then further regular
 * stages only with explicitly activated degrading. Legacy regime: the entry
 * primary plus the fixed design/review resolution map — the legacy global
 * final stage is never a new-start candidate (no unauthorized mixing).
 */
export function newStartCandidates(policy: RecoveryPolicyView, entryProfile: string): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  const push = (ref: SlotRef, label: string, tuple: RecoveryRuntimeTuple | null | undefined) => {
    if (!tuple) return;
    out.push({ label, ref, tuple: { ...tuple }, disabled: slotDisabled(policy, ref) });
  };
  if (effectiveRegime(policy) === "per_profile") {
    const stages: string[] = effectiveDegrading(policy) && (STAGE_ORDER as Record<string, string[]>)[entryProfile]
      ? (STAGE_ORDER as Record<string, string[]>)[entryProfile]!
      : [entryProfile];
    for (const stage of stages) {
      push({ kind: "profile", profile: stage as ProfileName }, `${stage}.main`, policy.profiles[stage]);
      push({ kind: "profileFallback", profile: stage as ProfileName }, `${stage}.fallback`, policy.profileFallbacks?.[stage]);
    }
  } else {
    push({ kind: "profile", profile: entryProfile as ProfileName }, `${entryProfile}.main`, policy.profiles[entryProfile]);
    for (const profile of FALLBACKS[entryProfile as ProfileName] ?? []) {
      push({ kind: "profile", profile }, `${profile}.main`, policy.profiles[profile]);
    }
  }
  return out;
}

/** Ordered RECOVERY candidate formation: per_profile identical to new-start;
 * legacy keeps today's chain — degrading stage mains (only with a degrading
 * finalFallback mode) then the global final stage. Disabled flags travel with
 * each candidate; filtering stays with the consumer. */
export function recoveryCandidates(policy: RecoveryPolicyView, entryProfile: string): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  const push = (ref: SlotRef, label: string, tuple: RecoveryRuntimeTuple | null | undefined) => {
    if (!tuple) return;
    out.push({ label, ref, tuple: { ...tuple }, disabled: slotDisabled(policy, ref) });
  };
  if (effectiveRegime(policy) === "per_profile") return newStartCandidates(policy, entryProfile);
  if (policy.finalFallback && policy.finalFallback.mode === "degrading") {
    const order: string[] =
      entryProfile === "design" || entryProfile === "review"
        ? ["standard", "execution"]
        : entryProfile === "deep"
          ? ["standard", "execution"]
          : ["execution"];
    for (const profile of order) {
      push({ kind: "profile", profile: profile as ProfileName }, `degrade.${profile}.main`, policy.profiles[profile]);
    }
  }
  if (policy.finalFallback) push({ kind: "finalFallback" }, "final.main", policy.finalFallback.selection);
  return out;
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
 * applies when configured, Schema-4 fields are never reinterpreted. Disabled
 * slots (schema 5) keep their stored value but are not part of the chain.
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
      if (slotDisabled(policy, { kind: "profile", profile: profile as ProfileName })) continue;
      const entry = policy.profiles[profile];
      if (entry) chain.push({ ...entry });
    }
  }
  if (policy.finalFallback && !slotDisabled(policy, { kind: "finalFallback" })) {
    chain.push({ ...policy.finalFallback.selection });
  }
  return chain;
}

export type RecoveryCandidateStatus =
  | "selected"
  | "skipped_current_failure"
  | "skipped_attempted"
  | "skipped_disabled"
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
  const regime: RoutingRegime = effectiveRegime(policy);
  // task_f2d0ccc6: the shared candidate formation — the disabled flag travels
  // with each candidate and is filtered AFTER current-failure/attempt evidence
  // (a really failed runtime stays the stronger event) and BEFORE availability.
  const raw = recoveryCandidates(policy, params.entryProfile);
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
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
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
    if (raw[index]!.disabled) {
      candidate.status = "skipped_disabled";
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
