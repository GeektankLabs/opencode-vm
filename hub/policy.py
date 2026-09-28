"""Project-local, credential-free Agent Control policy (schema 1)."""

import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from datetime import datetime, timezone


PROFILES = ("deep", "standard", "execution")
FIELDS = ("provider_id", "model_id", "variant")
MAX_BYTES = 16 * 1024
VALUE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,256}$")
PRIVATE_VALUE = re.compile(r"(?i)^(?:/|\\|file:|bearer|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})|://")


class PolicyError(ValueError):
    pass


class PolicyConflict(PolicyError):
    pass


def empty_policy():
    return {"schemaVersion": 1, "revision": 0, "updatedAt": None,
            "profiles": {name: None for name in PROFILES}}


def validate_selection(selection):
    if selection is None:
        return None
    if not isinstance(selection, dict) or set(selection) != set(FIELDS):
        raise PolicyError("An exact provider, model and variant are required.")
    if not all(isinstance(selection[key], str) and VALUE.fullmatch(selection[key])
               and not PRIVATE_VALUE.search(selection[key]) for key in FIELDS):
        raise PolicyError("Invalid provider, model or variant ID.")
    return selection


def validate_policy(value):
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "revision", "updatedAt", "profiles"}:
        raise PolicyError("Unsupported Agent Control policy format.")
    if value["schemaVersion"] != 1 or isinstance(value["schemaVersion"], bool):
        raise PolicyError("Unsupported Agent Control policy version.")
    if type(value["revision"]) is not int or value["revision"] < 1:
        raise PolicyError("Invalid policy revision.")
    if not isinstance(value["updatedAt"], str) or not value["updatedAt"].endswith("Z"):
        raise PolicyError("Invalid policy timestamp.")
    if not isinstance(value["profiles"], dict) or set(value["profiles"]) != set(PROFILES):
        raise PolicyError("Invalid policy profiles.")
    for selection in value["profiles"].values():
        validate_selection(selection)
    return value


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

    def update(self, profile, selection, expected_revision):
        if profile not in PROFILES or type(expected_revision) is not int or expected_revision < 0:
            raise PolicyError("Invalid profile or revision.")
        validate_selection(selection)
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
            updated = {"schemaVersion": 1, "revision": expected_revision + 1,
                       "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                       "profiles": {**current["profiles"], profile: selection}}
            data = (json.dumps(updated, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
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
            return updated
        finally:
            os.close(fd)


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
