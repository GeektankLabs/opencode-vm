"""Project-local, credential-free Agent Control policy (schema 1/2/3/4)."""

import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from datetime import datetime, timezone


BASE_PROFILES = ("deep", "standard", "execution")
PROFILES = (*BASE_PROFILES, "design", "review")
FALLBACKS = {"design": ["standard"], "review": ["deep", "standard"]}
FALLBACK_MODES = ("total", "degrading")
# Additive schema-4 strategy switches. `None` means "not explicitly set", which
# routing treats as not activated; it is never a silently chosen default.
STRATEGY_KEYS = ("degrading", "providerSkip")
# Regular degrading order; special-role entry points keep their existing chains.
STAGE_ORDER = {"deep": ("deep", "standard", "execution"), "standard": ("standard", "execution"),
               "execution": ("execution",), "design": ("design", "standard", "execution"),
               "review": ("review", "deep", "standard", "execution")}
FIELDS = ("provider_id", "model_id", "variant")
MAX_BYTES = 16 * 1024
VALUE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,256}$")
PRIVATE_VALUE = re.compile(r"(?i)^(?:/|\\|file:|bearer|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})|://")
KEY_SETS = ({"schemaVersion", "revision", "updatedAt", "profiles"},
            {"schemaVersion", "revision", "updatedAt", "profiles", "finalFallback"},
            {"schemaVersion", "revision", "updatedAt", "profiles", "finalFallback",
             "profileFallbacks", "strategies"})


class PolicyError(ValueError):
    pass


class PolicyConflict(PolicyError):
    pass


class PolicyCapabilityError(PolicyError):
    pass


def empty_policy():
    return {"schemaVersion": 1, "revision": 0, "updatedAt": None,
            "profiles": {name: None for name in PROFILES}}


def _timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _document(version, revision, profiles, final=None, profile_fallbacks=None, strategies=None):
    """Next policy document in the canonical persisted key order (Python/TS parity)."""
    updated = {"schemaVersion": version, "revision": revision, "updatedAt": _timestamp(),
               "profiles": dict(profiles)}
    if version >= 3:
        updated["finalFallback"] = final
    if version == 4:
        updated["profileFallbacks"] = dict(profile_fallbacks)
        updated["strategies"] = dict(strategies)
    return updated


def _persisted(updated, version):
    names = BASE_PROFILES if version == 1 else PROFILES
    return {**updated, "profiles": {name: updated["profiles"][name] for name in names}}


def validate_selection(selection):
    if selection is None:
        return None
    if not isinstance(selection, dict) or set(selection) != set(FIELDS):
        raise PolicyError("An exact provider, model and variant are required.")
    if not all(isinstance(selection[key], str) and VALUE.fullmatch(selection[key])
               and not PRIVATE_VALUE.search(selection[key]) for key in FIELDS):
        raise PolicyError("Invalid provider, model or variant ID.")
    return selection


def validate_final_fallback(value):
    """Additive schema-3 slot: the configured final error-fallback runtime.

    Distinct from FALLBACKS (the design/review *resolution* map). None means
    unconfigured, which routing must surface as INPUT_REQUIRED — never an
    automatic provider choice.
    """
    if value is None:
        return None
    if not isinstance(value, dict) or not {"selection"} <= set(value) <= {"mode", "selection"}:
        raise PolicyError("A fallback needs an exact selection and an optional mode.")
    mode = value.get("mode", "total")
    if mode not in FALLBACK_MODES:
        raise PolicyError("Fallback mode must be total or degrading.")
    selection = validate_selection(value["selection"])
    if selection is None:
        raise PolicyError("A configured fallback requires an exact selection.")
    return {"mode": mode, "selection": selection}


def validate_profile_fallbacks(value):
    """Additive schema-4 slot: the optional own fallback of each profile card.

    Strictly separate from `FALLBACKS` (design/review *resolution*) and from the
    schema-3 `finalFallback` (the legacy global final stage). `None` per profile
    means "no own fallback", which never stops a chain by itself.
    """
    if not isinstance(value, dict) or set(value) != set(PROFILES):
        raise PolicyError("Profile fallbacks need an entry for every profile.")
    return {name: validate_selection(value[name]) for name in PROFILES}


def validate_strategies(value):
    """Additive schema-4 slot: the two independent fallback-strategy switches.

    Each switch is `True`, `False` or `None` (not explicitly set). No default is
    invented here; routing surfaces the effective values instead.
    """
    if not isinstance(value, dict) or set(value) != set(STRATEGY_KEYS):
        raise PolicyError("Fallback strategies need both switches explicitly.")
    result = {}
    for key in STRATEGY_KEYS:
        item = value[key]
        if item is not None and type(item) is not bool:
            raise PolicyError("A fallback strategy switch must be true, false or unset.")
        result[key] = item
    return result


def profile_fallbacks_view(policy):
    """Normalized five-key view; schema 1/2/3 policies have no own fallbacks."""
    stored = policy.get("profileFallbacks")
    return dict(stored) if isinstance(stored, dict) else {name: None for name in PROFILES}


def strategies_view(policy):
    """Normalized switch view; absent means both switches are unset."""
    stored = policy.get("strategies")
    stored = stored if isinstance(stored, dict) else {}
    return {key: stored.get(key) for key in STRATEGY_KEYS}


def routing_regime(policy):
    """Explicit routing regime; the legacy global final stage is never reinterpreted.

    `per_profile` requires schema 4 *and* an actually configured own fallback or
    an explicitly set switch. Otherwise the legacy `finalFallback` behaviour
    applies unchanged. In the per-profile regime the legacy global final stage is
    deliberately not part of the chain; that relationship is surfaced, not hidden.
    """
    strategies = strategies_view(policy)
    per_profile = policy["schemaVersion"] == 4 and (
        any(value is not None for value in profile_fallbacks_view(policy).values())
        or any(strategies[key] is not None for key in STRATEGY_KEYS))
    return {"regime": "per_profile" if per_profile else "legacy_final_fallback",
            "legacyFinalStageApplies": not per_profile,
            "strategiesEffective": {"degrading": strategies["degrading"] is True,
                                    "providerSkip": strategies["providerSkip"] is True}}


def candidate_order(policy, profile):
    """Deterministic configured-candidate order for one entry profile.

    Pure configuration projection: within each stage the main model comes before
    that stage's own fallback, unconfigured entries are skipped, and degrading
    must be explicitly activated to continue with the next regular stage. Runtime
    filtering (already failed runtimes/provider identities, availability) stays a
    documented management-layer responsibility. Returns None in the legacy regime.
    """
    if routing_regime(policy)["regime"] != "per_profile" or profile not in PROFILES:
        return None
    fallbacks = profile_fallbacks_view(policy)
    degrading = strategies_view(policy)["degrading"] is True
    stages = STAGE_ORDER[profile] if degrading else (profile,)
    order = []
    for stage in stages:
        if policy["profiles"].get(stage) is not None:
            order.append(f"{stage}.main")
        if fallbacks.get(stage) is not None:
            order.append(f"{stage}.fallback")
    return order


def validate_policy(value):
    if not isinstance(value, dict) or set(value) not in KEY_SETS:
        raise PolicyError("Unsupported Agent Control policy format.")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] not in (1, 2, 3, 4):
        raise PolicyError("Unsupported Agent Control policy version.")
    if (value["schemaVersion"] >= 3) != ("finalFallback" in value):
        raise PolicyError("Unsupported Agent Control policy format.")
    if (value["schemaVersion"] == 4) != ("profileFallbacks" in value) \
            or (value["schemaVersion"] == 4) != ("strategies" in value):
        raise PolicyError("Unsupported Agent Control policy format.")
    if type(value["revision"]) is not int or value["revision"] < 1:
        raise PolicyError("Invalid policy revision.")
    if not isinstance(value["updatedAt"], str) or not value["updatedAt"].endswith("Z"):
        raise PolicyError("Invalid policy timestamp.")
    names = BASE_PROFILES if value["schemaVersion"] == 1 else PROFILES
    if not isinstance(value["profiles"], dict) or set(value["profiles"]) != set(names):
        raise PolicyError("Invalid policy profiles.")
    for selection in value["profiles"].values():
        validate_selection(selection)
    result = {**value, "profiles": {**{name: None for name in PROFILES}, **value["profiles"]}}
    if value["schemaVersion"] >= 3:
        result["finalFallback"] = validate_final_fallback(value["finalFallback"])
    if value["schemaVersion"] == 4:
        result["profileFallbacks"] = validate_profile_fallbacks(value["profileFallbacks"])
        result["strategies"] = validate_strategies(value["strategies"])
    return result


class PolicyStore:
    def __init__(self, project):
        self.project = Path(project).resolve()
        self.directory = self.project / ".opencode-vm"
        self.path = self.directory / "agent-control.json"

    def read(self):
        if self.directory.is_symlink() or self.path.is_symlink():
            raise PolicyError("Unsafe policy path.")
        if not self.path.exists():
            return empty_policy()
        if not self.path.is_file() or self.path.stat().st_size > MAX_BYTES:
            raise PolicyError("Invalid policy file.")
        try:
            return validate_policy(json.loads(self.path.read_text(encoding="utf-8")))
        except (UnicodeError, OSError, ValueError) as error:
            raise PolicyError("Invalid or unsupported Agent Control policy.") from error

    def update(self, profile, selection, expected_revision, *, optional_capable=False):
        if profile not in PROFILES:
            raise PolicyError("Invalid profile or revision.")
        validate_selection(selection)

        def mutate(current):
            upgrade = current["schemaVersion"] == 1 and profile in FALLBACKS and selection is not None
            if upgrade and not optional_capable:
                raise PolicyCapabilityError("Active MCP adapter does not confirm schema 2 and optional profiles.")
            version = 2 if upgrade else current["schemaVersion"]
            updated = _document(version, expected_revision + 1,
                                {**current["profiles"], profile: selection},
                                final=current.get("finalFallback"),
                                profile_fallbacks=profile_fallbacks_view(current),
                                strategies=strategies_view(current))
            return updated, _persisted(updated, version), "schema1" if upgrade else None

        return self._write(expected_revision, mutate)

    def update_fallback(self, fallback, expected_revision, *, optional_capable=False):
        """CAS update of the additive schema-3 finalFallback slot.

        Setting a fallback upgrades schema 1/2 to schema 3 after backing up the
        exact original bytes; clearing on schema 1/2 leaves the schema untouched.
        A schema-1 upgrade requires the same MCP capability confirmation as the
        first optional-profile mapping. Schema-4 keys are preserved verbatim.
        """
        fallback = validate_final_fallback(fallback)

        def mutate(current):
            upgrade = current["schemaVersion"] in (1, 2) and fallback is not None
            if upgrade and current["schemaVersion"] == 1 and not optional_capable:
                raise PolicyCapabilityError("Active MCP adapter does not confirm schema 2 and optional profiles.")
            version = 3 if upgrade or current["schemaVersion"] == 3 else current["schemaVersion"]
            updated = _document(version, expected_revision + 1, current["profiles"], final=fallback,
                                profile_fallbacks=profile_fallbacks_view(current),
                                strategies=strategies_view(current))
            label = f"schema{current['schemaVersion']}" if upgrade else None
            return updated, _persisted(updated, version), label

        return self._write(expected_revision, mutate)

    def update_profile_fallback(self, profile, selection, expected_revision, *,
                                optional_capable=False, schema4_capable=False):
        """CAS update of one additive schema-4 per-profile own fallback.

        Setting a selection upgrades schema 1/2/3 to schema 4 after backing up the
        exact original bytes; clearing never downgrades. The legacy `finalFallback`
        slot and every other key are preserved verbatim, and a schema-1 upgrade
        still requires the existing optional-profile capability confirmation.
        """
        if profile not in PROFILES:
            raise PolicyError("Invalid profile or revision.")
        validate_selection(selection)

        def mutate(current):
            upgrade = current["schemaVersion"] != 4 and selection is not None
            if upgrade:
                if not schema4_capable:
                    raise PolicyCapabilityError(
                        "Active MCP adapter does not confirm schema 4 profile fallbacks and strategies.")
                if current["schemaVersion"] == 1 and not optional_capable:
                    raise PolicyCapabilityError("Active MCP adapter does not confirm schema 2 and optional profiles.")
            version = 4 if upgrade or current["schemaVersion"] == 4 else current["schemaVersion"]
            fallbacks = {**profile_fallbacks_view(current), profile: selection}
            updated = _document(version, expected_revision + 1, current["profiles"],
                                final=current.get("finalFallback"), profile_fallbacks=fallbacks,
                                strategies=strategies_view(current))
            label = f"schema{current['schemaVersion']}" if upgrade else None
            return updated, _persisted(updated, version), label

        return self._write(expected_revision, mutate)

    def update_strategies(self, strategies, expected_revision, *,
                          optional_capable=False, schema4_capable=False):
        """CAS update of the two additive schema-4 fallback-strategy switches.

        Both switches are always written explicitly (`true`, `false` or `null` for
        "not set"); an explicit value upgrades schema 1/2/3 to schema 4 after an
        exact-bytes backup, and clearing both never downgrades an existing schema 4.
        """
        strategies = validate_strategies(strategies)

        def mutate(current):
            explicit = any(strategies[key] is not None for key in STRATEGY_KEYS)
            upgrade = current["schemaVersion"] != 4 and explicit
            if upgrade:
                if not schema4_capable:
                    raise PolicyCapabilityError(
                        "Active MCP adapter does not confirm schema 4 profile fallbacks and strategies.")
                if current["schemaVersion"] == 1 and not optional_capable:
                    raise PolicyCapabilityError("Active MCP adapter does not confirm schema 2 and optional profiles.")
            version = 4 if upgrade or current["schemaVersion"] == 4 else current["schemaVersion"]
            updated = _document(version, expected_revision + 1, current["profiles"],
                                final=current.get("finalFallback"),
                                profile_fallbacks=profile_fallbacks_view(current), strategies=strategies)
            label = f"schema{current['schemaVersion']}" if upgrade else None
            return updated, _persisted(updated, version), label

        return self._write(expected_revision, mutate)

    def _write(self, expected_revision, mutate):
        """Canonical CAS write: lock, revision check, exact-bytes backup, publish."""
        if type(expected_revision) is not int or expected_revision < 0:
            raise PolicyError("Invalid revision.")
        if self.directory.is_symlink() or (self.directory.exists() and not self.directory.is_dir()):
            raise PolicyError("Unsafe policy directory.")
        self.directory.mkdir(mode=0o700, exist_ok=True)
        lock = self.directory / "agent-control.lock"
        if lock.is_symlink():
            raise PolicyError("Unsafe policy lock.")
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise PolicyError("Unsafe policy lock.")
            fcntl.flock(fd, fcntl.LOCK_EX)
            current = self.read()
            if current["revision"] != expected_revision:
                raise PolicyConflict("Policy changed; reload before saving.")
            updated, persisted, backup_label = mutate(current)
            if backup_label is not None and self.path.exists():
                self._backup(current["revision"], self.path.read_bytes(), label=backup_label)
            self._ensure_ignore()
            self._publish(persisted)
            return updated
        finally:
            os.close(fd)

    def _ensure_ignore(self):
        ignore = self.project / ".gitignore"
        if ignore.is_symlink() or (ignore.exists() and not ignore.is_file()):
            raise PolicyError("Unsafe project ignore file.")
        if not ignore.exists() or ".opencode-vm/" not in ignore.read_text(encoding="utf-8").splitlines():
            with ignore.open("a", encoding="utf-8") as output:
                if output.tell():
                    output.write("\n")
                output.write(".opencode-vm/\n")
                output.flush()
                os.fsync(output.fileno())

    def _publish(self, persisted):
        data = (json.dumps(persisted, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        handle, temporary = tempfile.mkstemp(prefix=".agent-control-", dir=self.directory)
        try:
            with os.fdopen(handle, "wb") as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _backup(self, revision, data, label="schema1"):
        """Publish exact original bytes before replace; exact interrupted replay is safe."""
        path = self.directory / f"agent-control.{label}-rev{revision}.backup.json"
        handle, temporary = tempfile.mkstemp(prefix=".agent-control-backup-", dir=self.directory)
        try:
            with os.fdopen(handle, "wb") as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(temporary, path)  # No overwrite, including symlinks.
            except FileExistsError:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as original:
                    info = os.fstat(original.fileno())
                    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                            or info.st_mode & 0o077 or original.read(MAX_BYTES + 1) != data):
                        raise PolicyError("Existing migration backup differs or is unsafe.")
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            os.unlink(temporary)


def check_selection(selection, catalog):
    if selection is None:
        return "unconfigured"
    if catalog is None:
        return "catalog_unavailable"
    if catalog.get("truncated") is True:
        return "catalog_incomplete"
    providers = catalog.get("providers", [])
    models = catalog.get("models", [])
    if not any(item.get("provider_id") == selection["provider_id"] for item in providers):
        return "provider_unavailable"
    matching = next((item for item in models if item.get("provider_id") == selection["provider_id"]
                     and item.get("model_id") == selection["model_id"]), None)
    if matching is None:
        return "model_unavailable"
    if selection["variant"] not in matching.get("variants", []):
        return "variant_unavailable"
    return "available"


def resolve_profile(policy, profile, catalog):
    result = {"profile": profile, "policy_revision": policy["revision"],
              "status": "unconfigured", "resolution_path": []}
    for candidate in [profile, *FALLBACKS.get(profile, [])]:
        result["resolution_path"].append(candidate)
        selection = policy["profiles"][candidate]
        if selection is None:
            continue
        result.update(resolved_profile=candidate, status=check_selection(selection, catalog))
        if result["status"] == "available":
            result["runtime"] = selection
        break
    return result
