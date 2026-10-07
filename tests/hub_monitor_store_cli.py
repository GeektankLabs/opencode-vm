#!/usr/bin/env python3
"""Canonical monitor-store CLI for the W5 Hub UI browser evidence.

Uses hub.monitor, i.e. the very same registry file the Monitor Engine and the
MCP monitor tools read and write. This is the "other surface" the UI must stay
consistent with (MCP -> UI / UI -> MCP round trips).
"""
import json
import sys
from pathlib import Path

import hub.monitor as store


def main() -> None:
    command = sys.argv[1]
    project = Path(sys.argv[2])
    if command == "snapshot":
        registry = store.snapshot(project)
        print(json.dumps({"generation": registry["generation"],
                          "monitors": {item["id"]: item for item in registry["monitors"]}}))
        return
    if command == "create":
        title, task, interval, autonomy, runtime = sys.argv[3:8]

        def build(registry):
            monitor = store.default_monitor(title, task, int(interval), autonomy, runtime, None)
            store.history_entry(monitor, "created", {"interval_seconds": int(interval)})
            registry["monitors"].append(monitor)

        result = store.mutate(project, build)
        print(json.dumps({"id": result["monitors"][-1]["id"], "generation": result["generation"]}))
        return
    if command in {"update", "setstate"}:
        monitor_id = sys.argv[3]
        fields = json.loads(sys.argv[4])

        def build(registry):
            monitor = next(item for item in registry["monitors"] if item["id"] == monitor_id)
            for key, value in fields.items():
                if isinstance(value, dict) and isinstance(monitor.get(key), dict):
                    monitor[key].update(value)
                else:
                    monitor[key] = value
            monitor["updated_at"] = store.timestamp()
            store.history_entry(monitor, "updated")

        result = store.mutate(project, build)
        print(json.dumps({"generation": result["generation"]}))
        return
    if command == "bump":
        result = store.mutate(project, lambda registry: None)
        print(json.dumps({"generation": result["generation"]}))
        return
    if command == "delete":
        monitor_id = sys.argv[3]

        def build(registry):
            registry["monitors"] = [item for item in registry["monitors"] if item["id"] != monitor_id]

        result = store.mutate(project, build)
        print(json.dumps({"generation": result["generation"]}))
        return
    raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    main()