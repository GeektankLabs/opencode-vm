#!/usr/bin/env python3
"""Checks the standard web-service flags and guest argument contract."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "opencode-vm.sh").read_text()


class WebServiceFlagsTest(unittest.TestCase):
    def test_services_default_on_and_have_explicit_opt_outs(self):
        self.assertIn('SESSION_HUB_MODE=""', SCRIPT)
        self.assertIn('SESSION_TASKBOARD_MODE=""', SCRIPT)
        self.assertIn('--no-hub)', SCRIPT)
        self.assertIn('--no-taskboard)', SCRIPT)
        self.assertIn('"${SESSION_HUB_MODE:-}" != disable', SCRIPT)
        self.assertIn('"${SESSION_TASKBOARD_MODE:-}" != disable', SCRIPT)

    def test_no_launcher_does_not_disable_standard_services(self):
        self.assertIn('if [[ "$SESSION_MODE" == "web" && "${SESSION_HUB_MODE:-}" != disable ]]', SCRIPT)
        self.assertNotIn('SESSION_LAUNCHER_ENABLED:-1}" == "1" ]]; then\n    agent_hub_start', SCRIPT)

    def test_taskboard_health_and_project_db_contract(self):
        self.assertIn('curl -fsS --max-time 1 "http://127.0.0.1:$port/api/projects"', SCRIPT)
        self.assertIn('"$proj/.opencode-vm/taskboard/taskboard.db"', SCRIPT)
        self.assertIn('"$proj_state/taskboard/taskboard.db"', SCRIPT)  # one-time legacy import
        self.assertIn('"$sess_taskboard_enabled" "${SESSION_LAUNCHER_ENABLED:-1}"', SCRIPT)


if __name__ == "__main__":
    unittest.main()
