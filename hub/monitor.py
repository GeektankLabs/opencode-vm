#!/usr/bin/env python3
"""Monitor registry access for the Agent Control Hub (W4).

Reads and writes the same project-persistent registry as the Monitor Engine
and the MCP adapter tools: <project>/.opencode-vm/monitor/registry.json.
One canonical store, one generation counter, one cooperating mkdir lock.
Stdlib only, mirroring the TypeScript schema exactly.
"""

from __future__ import annotations

import json
import os
import stat
import time
import uuid
from pathlib import Path
from typing import Any


class MonitorError(Exception):
    pass


class MonitorConflict(MonitorError):
    pass


MONITOR_SCHEMA = 1
DEFAULT_INTERVAL_SECONDS = 60
HISTORY_LIMIT = 200
LOG_LIMIT = 200
WORK_STATES = ("active", "parked_input_required", "complete_pass", "stopped")
AUTONOMY_PROFILES = ("conservative", "sandbox", "mvp", "yolo")
RUNTIME_PROFILES = ("deep", "standard", "execution", "design", "review")
LOCK_STALE_SECONDS = 10
MAX_REGISTRY_BYTES = 1_048_576


def registry_directory(project: Path) -> Path:
    return project / ".opencode-vm" / "monitor"


def registry_path(project: Path) -> Path:
    return registry_directory(project) / "registry.json"


def _read_registry(project: Path) -> dict[str, Any]:
    path = registry_path(project)
    try:
        info = path.lstat()
    except OSError:
        return {"schema": MONITOR_SCHEMA, "generation": 0, "monitors": []}
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_size > MAX_REGISTRY_BYTES or path.is_symlink()):
        raise MonitorError("Monitor registry is unsafe or unreadable.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise MonitorError("Monitor registry is corrupt.") from error
    if not _valid_registry(value):
        raise MonitorError("Monitor registry has an invalid shape.")
    return value


def _valid_registry(value: Any) -> bool:
    if not isinstance(value, dict) or value.get("schema") != MONITOR_SCHEMA:
        return False
    if not isinstance(value.get("generation"), int) or isinstance(value["generation"], bool) or value["generation"] < 0:
        return False
    monitors = value.get("monitors")
    if not isinstance(monitors, list):
        return False
    seen: set[str] = set()
    for monitor in monitors:
        if not isinstance(monitor, dict):
            return False
        identifier = monitor.get("id")
        if not isinstance(identifier, str) or not identifier.startswith("monitor_") or len(identifier) != 40:
            return False
        if identifier in seen:
            return False
        seen.add(identifier)
        if not isinstance(monitor.get("title"), str) or not 1 <= len(monitor["title"]) <= 160:
            return False
        anchor = monitor.get("anchor")
        if not isinstance(anchor, dict) or not isinstance(anchor.get("task_id"), str):
            return False
        scheduler = monitor.get("scheduler")
        if (not isinstance(scheduler, dict) or not isinstance(scheduler.get("enabled"), bool)
                or not isinstance(scheduler.get("interval_seconds"), int)
                or isinstance(scheduler["interval_seconds"], bool)
                or not 5 <= scheduler["interval_seconds"] <= 86400):
            return False
        if monitor.get("autonomy_profile") not in AUTONOMY_PROFILES:
            return False
        if monitor.get("runtime_profile") not in RUNTIME_PROFILES:
            return False
        state = monitor.get("state")
        if not isinstance(state, dict) or state.get("work") not in WORK_STATES:
            return False
        if not isinstance(monitor.get("history"), list) or not isinstance(monitor.get("logs"), list):
            return False
    return True


def _lock(project: Path) -> Path:
    lock = registry_directory(project) / ".lock"
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            lock.mkdir(mode=0o700)
            (lock / "owner").write_text(f"{os.getpid()}\n{time.time()}\n", encoding="utf-8")
            return lock
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > LOCK_STALE_SECONDS:
                    for child in lock.iterdir():
                        child.unlink()
                    lock.rmdir()
                    continue
            except OSError:
                pass
            time.sleep(0.05)
    raise MonitorError("Monitor registry lock could not be acquired.")


def _unlock(lock: Path) -> None:
    try:
        for child in lock.iterdir():
            child.unlink()
        lock.rmdir()
    except OSError:
        pass


def _publish(project: Path, registry: dict[str, Any]) -> None:
    directory = registry_directory(project)
    tmp = directory / f".registry.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    tmp.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, registry_path(project))


def mutate(project: Path, mutator, expected_generation: int | None = None) -> dict[str, Any]:
    """Serialized read-modify-write with monotonic CAS generation."""
    directory = registry_directory(project)
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    lock = _lock(project)
    try:
        registry = _read_registry(project)
        if expected_generation is not None and registry["generation"] != expected_generation:
            raise MonitorConflict("Monitor registry changed concurrently; reload before saving.")
        draft = json.loads(json.dumps(registry))
        mutator(draft)
        draft["generation"] = registry["generation"] + 1
        if not _valid_registry(draft):
            raise MonitorError("Monitor registry mutation produced an invalid shape.")
        _publish(project, draft)
        return draft
    finally:
        _unlock(lock)


def snapshot(project: Path) -> dict[str, Any]:
    return _read_registry(project)


def history_entry(monitor: dict[str, Any], kind: str, detail: dict[str, Any] | None = None) -> None:
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "type": kind}
    if detail:
        entry["detail"] = detail
    monitor.setdefault("history", []).append(entry)
    del monitor["history"][:-HISTORY_LIMIT]


def valid_task_id(value: str) -> bool:
    import re
    return bool(re.fullmatch(r"task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value))


def valid_monitor_id(value: str) -> bool:
    import re
    return bool(re.fullmatch(r"monitor_[0-9a-f]{32}", value))


def timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def default_monitor(title: str, task_id: str, interval_seconds: int,
                    autonomy_profile: str, runtime_profile: str,
                    expiry_at: int | None) -> dict[str, Any]:
    now = int(time.time())
    at = timestamp()
    return {
        "id": f"monitor_{uuid.uuid4().hex}",
        "title": title,
        "anchor": {"task_id": task_id},
        "scheduler": {
            "enabled": True,
            "interval_seconds": interval_seconds,
            "next_run_at": (now + interval_seconds) * 1000,
            "expiry_at": expiry_at,
        },
        "autonomy_profile": autonomy_profile,
        "runtime_profile": runtime_profile,
        "session": {"session_id": None, "title": None, "primed_at": None},
        "state": {"work": "active", "last_seen_digest": None, "watermark": None},
        "cursors": {},
        "budget": {},
        "read_episodes": {},
        "run": {"active": False, "started_at": None, "action": None},
        "recovery": {"active": False, "started_at": None, "last_error_fingerprint": None},
        "dispatch_wal": None,
        "wake_request": None,
        "history": [],
        "logs": [],
        "created_at": at,
        "updated_at": at,
    }