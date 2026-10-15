#!/usr/bin/env python3
"""Cross-writer preservation (task_e67c39cf, C6): the Hub's registry mutation
path must preserve the additive `investigation` fields byte-stably. This test
imports the real hub module and exercises the real `mutate`/`_valid_registry`
path on a temp registry that carries investigation state."""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hub"))

import monitor  # noqa: E402


def main() -> int:
    failures: list[str] = []

    def check(name: str, condition: bool) -> None:
        print(("ok - " if condition else "not ok - ") + name)
        if not condition:
            failures.append(name)

    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp) / "project"
        project.mkdir(parents=True)
        for key in ("OCVM_MONITOR_STATE_DIR", "OCVM_PROJECT_PATH", "OCVM_PROJ_HASH"):
            os.environ.pop(key, None)
        os.environ["OCVM_ARTIFACT_ROOT"] = str(Path(tmp) / "artifacts")
        investigation = {
            "schema": 1,
            "last_progress_at": None,
            "last_investigation_at": "2026-10-12T10:00:00.000Z",
            "cooldown_until": 1781500000000,
            "backoff_stage": 2,
            "next_deep_check_at": 1781500800000,
            "episode": {
                "started_at": "2026-10-12T09:55:00.000Z",
                "finished_at": "2026-10-12T10:00:00.000Z",
                "outcome": "long_work_evidenced",
                "evidence": [{"kind": "attributable_tool_progress", "source": "get_session_progress",
                              "at": "2026-10-12T09:59:00.000Z", "digest": "0a44366a"}],
                "expected_milestone": None,
                "wait_reason": "attributable in-flight tool progress on the worker's own dispatch receipt",
                "worker_key": "worker_" + "a" * 32,
                "dispatch_receipt": "msg_dispatch",
                "generation_source": "runtime_json",
                "generation_value": "oc-20261012-test",
            },
            "workers": [{
                "worker_key": "worker_" + "a" * 32,
                "dispatch_receipt": "msg_dispatch",
                "anchored_at": "2026-10-12T09:00:00.000Z",
                "anchor_source": "creation",
                "last_progress_at": None,
                "last_tool_digest": "0a44366a" + "0" * 56,
                "cooldown_until": None,
                "next_deep_check_at": 1781500800000,
                "backoff_stage": 2,
            }],
            "counters": {"investigations_total": 3, "inconclusive_total": 1, "anchor_unknown_total": 0},
            "observer_lease": {"owner": "4242:oc-20261012-test", "lease_until": 1781499900000, "generation": 7},
        }
        registry = {
            "schema": 1,
            "generation": 5,
            "alias_high_water": 1,
            "monitors": [{
                "id": "monitor_" + "b" * 32,
                "title": "Crosswriter",
                "anchor": {"task_id": "task_" + "c" * 32},
                "scheduler": {"enabled": True, "interval_seconds": 60, "next_run_at": 1781500000000, "expiry_at": None},
                "autonomy_profile": "mvp",
                "runtime_profile": "deep",
                "session": {"session_id": None, "title": None, "primed_at": None, "priming_digest": None},
                "state": {"work": "active", "last_seen_digest": None, "watermark": None},
                "cursors": {},
                "budget": {},
                "read_episodes": {},
                "run": {"active": False, "started_at": None, "action": None},
                "recovery": {"active": False, "started_at": None, "last_error_fingerprint": None},
                "dispatch_wal": None,
                "wake_request": None,
                "abort_request": None,
                "history": [],
                "logs": [],
                "created_at": "2026-10-12T08:00:00Z",
                "updated_at": "2026-10-12T08:00:00Z",
                "alias": "M1",
                "workers": [],
                "investigation": investigation,
                "investigation_config": {
                    "schema": 1,
                    "config": {"first_check_s": 120, "cooldown_s": 180, "ladder_s": [600, 1200, 2400],
                               "budget": {"max_duration_ms": 60_000, "max_calls": 5, "max_bytes": 4096}},
                    "task": {"task_type": "milestoned", "expected_milestone": "MVP green", "milestone_due_at": None},
                },
            }],
        }
        monitor.mutate(project, lambda draft: None)
        monitor.registry_path(project).write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")

        snapshot = monitor.snapshot(project)
        check("hub snapshot reads a registry carrying investigation state", True)

        def toggle_scheduler(draft):
            draft["monitors"][0]["scheduler"]["enabled"] = False

        mutated = monitor.mutate(project, toggle_scheduler, expected_generation=snapshot["generation"])
        check("hub mutation succeeds alongside additive fields", mutated["monitors"][0]["scheduler"]["enabled"] is False)
        check("investigation state survives a hub mutation byte-stably",
              mutated["monitors"][0]["investigation"] == investigation)
        check("investigation_config survives a hub mutation byte-stably",
              mutated["monitors"][0]["investigation_config"] == registry["monitors"][0]["investigation_config"])
        check("observer lease survives a hub mutation",
              mutated["monitors"][0]["investigation"]["observer_lease"] == investigation["observer_lease"])

        reread = json.loads(monitor.registry_path(project).read_text(encoding="utf-8"))
        check("published bytes contain the full investigation state",
              reread["monitors"][0]["investigation"] == investigation)

    print("FAILURES: " + str(len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
