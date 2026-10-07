"""Disposable Hub with a seeded canonical monitor registry (W5 UI evidence).

Serves the real hub/ assets and the real /api/monitor surface. The registry is
the same `<project>/.opencode-vm/monitor/registry.json` that the Monitor Engine
and the MCP tools use; external tests mutate it through
tests/hub_monitor_store_cli.py (hub.monitor), i.e. the same canonical store.
"""
import json
from pathlib import Path
import tempfile
import time

import hub.monitor as store
import hub.server as server

TITLES = {
    0: "Alpha Monitor",
    1: "Disabled Monitor",
    2: "Parked Monitor",
    3: "Running Monitor",
    4: "Abort Monitor",
    5: "Stale Monitor",
    6: "Unknown Monitor",
    7: "Deletable Monitor",
}

# Declared master tasks/work packages served through the candidates endpoint:
# only tasks with registered canonical document bindings (compact_context or
# concept_plan) count, and the terminal status done is excluded upstream.
DECLARED_TASKS = [
    {"task_id": "task_000000aa-0000-4000-8000-0000000000aa", "title": "Open Declared WP", "status": "in_progress", "declared": True},
    {"task_id": "task_000000ab-0000-4000-8000-0000000000ab", "title": "Second Declared WP", "status": "todo", "declared": True},
    {"task_id": "task_000000ac-0000-4000-8000-0000000000ac", "title": "Normal Ticket", "status": "in_progress", "declared": False},
]


def fixture_tasks(*_args, **_kwargs):
    override = Path(server.PROJECT) / ".fixture-tasks.json"
    if override.exists():
        return json.loads(override.read_text(encoding="utf-8"))
    return DECLARED_TASKS


def seed(project: Path, count: int = 52) -> None:
    now = int(time.time())
    at_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))

    def build(registry):
        for index in range(count):
            title = TITLES.get(index, f"Filler {index:02d} Monitor")
            task = f"task_{index:08x}-0000-4000-8000-{index:012x}"
            monitor = store.default_monitor(title, task, 60, "mvp", "deep", None)
            # Distinct creation times make pagination order deterministic (index 0 first).
            stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - (count - index)))
            monitor["created_at"] = stamp
            monitor["updated_at"] = stamp
            if index == 1:
                monitor["scheduler"]["enabled"] = False
                monitor["scheduler"]["next_run_at"] = None
            elif index == 2:
                monitor["state"]["work"] = "parked_input_required"
                monitor["state"]["parked_reason"] = "wartet auf Operator-Entscheidung"
            elif index == 3:
                monitor["run"] = {"active": True, "started_at": at_iso, "action": "review"}
            elif index == 4:
                monitor["abort_request"] = {"requested_at": at_iso, "reason": "engine"}
            elif index == 5:
                old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 3600))
                monitor["history"] = [{"at": old, "type": "dispatched", "detail": {"action": "review"}}]
            registry["monitors"].append(monitor)

    store.mutate(project, build)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="w5-monitor-fixture-") as temporary:
        root = Path(temporary)
        server.PROJECT = root / "project"
        server.PROJECT.mkdir()
        server.SESSION_ROOT = root / "share"
        server.SESSION_ROOT.mkdir(mode=0o700)
        server.RUNTIME = {
            "generation": "w5-monitor-fixture",
            "mcp": {"enabled": False, "port": 0, "generation": "w5-monitor-fixture"},
            "tunnelConfigured": False,
            "openliveConfigured": False,
            "a2aEnabled": False,
        }
        server.AUTH_CREDENTIALS = None
        server.REQUEST_SCHEME = "http"
        server.read_catalog = lambda *args, **kwargs: {"providers": [], "models": [], "truncated": False}
        server.read_capabilities = lambda *args: True
        server.read_board_tasks = fixture_tasks
        seed(server.PROJECT)
        http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        print(json.dumps({"port": http.server_port, "project": str(server.PROJECT)}), flush=True)
        try:
            http.serve_forever()
        finally:
            http.server_close()