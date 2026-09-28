#!/usr/bin/env python3
"""Verify the project-local Taskboard web service path and readiness contract."""

from pathlib import Path
import unittest

SCRIPT = (Path(__file__).resolve().parents[1] / "opencode-vm.sh").read_text()


class WebServiceFlagsTest(unittest.TestCase):
    def test_taskboard_health_and_project_db_contract(self):
        self.assertIn('curl -fsS --max-time 1 "http://127.0.0.1:$port/api/projects"', SCRIPT)
        self.assertIn('"$proj/.opencode-vm/taskboard/taskboard.db"', SCRIPT)
        self.assertIn('"$proj_state/taskboard/taskboard.db"', SCRIPT)
        self.assertIn('OC_TASKBOARD_LEGACY_EXPECTED=', SCRIPT)


if __name__ == "__main__":
    unittest.main()
