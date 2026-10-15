#!/usr/bin/env python3
"""Monitor registry access for the Agent Control Hub (W4).

Reads and writes the same checked project-separated guest registry as the
Monitor Engine and MCP adapter tools (no legacy host-register fallback).
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
    return _guest_directory(project, False)


def _guest_directory(project: Path, create: bool, child: str | None = None) -> Path:
    import subprocess
    helper = os.environ.get("OCVM_GUEST_STATE_HELPER")
    if not helper:
        helper = str(Path(__file__).resolve().parent.parent / "runtime" / "guest-state.py")
    try:
        result = subprocess.run(["python3", helper, "resolve", str(project), "monitor"] + ([child] if child else [])
                                + (["--create"] if create else []),
                                check=True, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as error:
        raise MonitorError("Guest monitor state unavailable/unsafe; no host fallback") from error
    return Path(result.stdout.strip())


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
                info = lock.lstat()
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
                    raise MonitorError("Unsafe monitor registry lock retained.")
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
    directory = _guest_directory(project, True)
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


# ---------------------------------------------------------------------------
# Welle C (be951293 §4.8/§4.9): safe bounded diagnosis reads. The Hub is a
# purely READ-ONLY consumer here: registry history/logs and heartbeat come
# from the project-persistent store, the service tail comes from THIS
# session share's monitor directory only (never a foreign project log), and
# the recovery projection is surfaced exactly as the engine persisted it —
# no Python-side resolution, filtering or reinterpretation.
# ---------------------------------------------------------------------------

SERVER_LOG_MAX_BYTES = 262_144
SERVER_LOG_MAX_LINES = 2_000
DISPLAY_WINDOW_HOURS = 24
MAX_HEARTBEAT_BYTES = 4_096


def server_log_path(project: Path) -> Path:
    return _guest_directory(project, False, "run") / "server.log"


def read_server_log_tail(project: Path) -> dict[str, Any]:
    """Bounded, ownership-checked tail of the canonical guest monitor log.

    The path is fixed to this project's owned guest registry, so a foreign
    project log is structurally unreachable; symlinks, non-regular files,
    group/other writable directories and foreign-owned files fail closed as
    `unsafe` without reading them. Byte and line limits are enforced
    server-side.
    """
    result: dict[str, Any] = {"state": "ok", "source": "monitor/server.log", "lines": [],
                              "bytes": 0, "truncated_bytes": False, "truncated_lines": False}
    try:
        directory = _guest_directory(project, False, "run")
    except MonitorError:
        result["state"] = "unsafe"
        return result
    result["path"] = str(directory / "server.log")
    try:
        info = directory.lstat()
    except OSError:
        result["state"] = "not_configured"
        return result
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or directory.is_symlink()):
        result["state"] = "unsafe"
        return result
    path = directory / "server.log"
    try:
        info = path.lstat()
    except OSError:
        result["state"] = "not_configured"
        return result
    if (not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_uid != os.getuid()
            or info.st_mode & 0o077):
        result["state"] = "unsafe"
        return result
    size = info.st_size
    if size == 0:
        result["state"] = "empty"
        return result
    start = max(0, size - SERVER_LOG_MAX_BYTES)
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            raw = handle.read()
    except OSError:
        result["state"] = "unavailable"
        return result
    result["bytes"] = len(raw)
    result["truncated_bytes"] = start > 0
    text = raw.decode("utf-8", errors="replace")
    if result["truncated_bytes"]:
        # Drop the leading partial line produced by the byte-window cut.
        first_newline = text.find("\n")
        text = text[first_newline + 1:] if first_newline >= 0 else ""
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        # QC F-C3 (waveC-qc SHA6040ddf0): a non-empty file whose byte window
        # contained no COMPLETE line (one oversized line > bound, with or
        # without trailing newline) must never be reported as "empty" — the
        # content exists beyond the readable window: honest truncated_only.
        result["state"] = "truncated_only" if result["truncated_bytes"] else "empty"
        return result
    if len(lines) > SERVER_LOG_MAX_LINES:
        result["truncated_lines"] = True
        lines = lines[-SERVER_LOG_MAX_LINES:]
    result["lines"] = lines
    result["state"] = "ok"
    return result


def read_heartbeat(project: Path) -> dict[str, Any]:
    """Project-local engine heartbeat, read strictly (regular, private, small)."""
    result: dict[str, Any] = {"state": "absent", "source": "monitor/heartbeat.json", "value": None}
    try:
        path = registry_directory(project) / "heartbeat.json"
    except MonitorError:
        result["state"] = "unsafe"
        return result
    result["path"] = str(path)
    try:
        info = path.lstat()
    except OSError:
        return result
    if (not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_uid != os.getuid()
            or info.st_size > MAX_HEARTBEAT_BYTES):
        result["state"] = "unsafe"
        return result
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        result["state"] = "corrupt"
        return result
    if not isinstance(value, dict):
        result["state"] = "corrupt"
        return result
    result["state"] = "ok"
    result["value"] = value
    return result


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
