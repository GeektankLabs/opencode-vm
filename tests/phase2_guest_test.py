"""Phase 2 — Monitor guest storage + node_modules relocation tests.

Extracts real production functions from opencode-vm.sh and runs them against
isolated fixtures.  Covers monitor_guest_dir resolution, node_modules
relocation, heartbeat path env resolution, and multi-project parallelism.
Real VM/virtiofs/Stop-Attach acceptance is UNVERIFIED (no VM in test).
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "opencode-vm.sh"
TEXT = SCRIPT.read_text()


def _extract(name, nxt):
    return name + "() {" + TEXT.split(name + "() {", 1)[1].split("\n" + nxt + "() {", 1)[0]


MONITOR_FNS = "\n".join([
    _extract("graphify_guest_base", "graphify_guest_dir"),
    _extract("graphify_guest_dir", "monitor_guest_dir"),
    _extract("monitor_guest_dir", "_nm_relocate_to_guest"),
    _extract("_nm_relocate_to_guest", "graphify_ensure_out_link"),
    _extract("monitor_heartbeat_path", "monitor_wait_heartbeat"),
])


class MonitorGuestPathTest(unittest.TestCase):
    """monitor_guest_dir resolution and parallel-project isolation."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ocvm-monitor-")
        self.addCleanup(self.tmp.cleanup)
        self.proj_a = Path(self.tmp.name) / "projA"
        self.proj_a.mkdir()
        self.proj_b = Path(self.tmp.name) / "projB"
        self.proj_b.mkdir()
        self.guest = Path(self.tmp.name) / "artifacts"
        self.guest.mkdir()
        self.env = {**os.environ, "OCVM_INTERNAL_SOURCE_ONLY": "1",
                    "OCVM_DISABLE_UPDATE_CHECK": "1",
                    "OCVM_ARTIFACT_ROOT": str(self.guest)}

    def run_fns(self, script, extra_env=None):
        cmd = "set -uo pipefail\n" + MONITOR_FNS + "\n" + script
        return subprocess.run(["bash", "-c", cmd],
                              env={**self.env, **(extra_env or {})},
                              capture_output=True, text=True, timeout=60)

    def test_monitor_dir_layout(self):
        r = self.run_fns(f'monitor_guest_dir /home/lima.linux "{self.proj_a}"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(str(self.guest), r.stdout)
        self.assertIn("/monitor", r.stdout)
        self.assertNotIn("/graphify", r.stdout)

    def test_two_projects_get_distinct_monitor_dirs(self):
        a = self.run_fns(f'monitor_guest_dir /home/lima.linux "{self.proj_a}"').stdout
        b = self.run_fns(f'monitor_guest_dir /home/lima.linux "{self.proj_b}"').stdout
        self.assertNotEqual(a, b)
        self.assertIn("/monitor", a)
        self.assertIn("/monitor", b)

    def test_same_project_same_dir(self):
        a = self.run_fns(f'monitor_guest_dir /home/lima.linux "{self.proj_a}"').stdout
        b = self.run_fns(f'monitor_guest_dir /home/lima.linux "{self.proj_a}"').stdout
        self.assertEqual(a, b)

    def test_override_honored(self):
        custom = Path(self.tmp.name) / "custom"
        custom.mkdir()
        r = self.run_fns(
            f'monitor_guest_dir /home/lima.linux "{self.proj_a}"',
            extra_env={"OCVM_ARTIFACT_ROOT": str(custom)})
        self.assertTrue(r.stdout.startswith(str(custom) + "/"), r.stdout)


class NodeModulesRelocationTest(unittest.TestCase):
    """_nm_relocate_to_guest: mv to guest + symlink back."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ocvm-nm-")
        self.addCleanup(self.tmp.cleanup)
        self.env = {**os.environ, "OCVM_INTERNAL_SOURCE_ONLY": "1",
                    "OCVM_DISABLE_UPDATE_CHECK": "1"}

    def run_fns(self, script, extra_env=None):
        cmd = "set -uo pipefail\n" + MONITOR_FNS + "\n" + script
        return subprocess.run(["bash", "-c", cmd],
                              env={**self.env, **(extra_env or {})},
                              capture_output=True, text=True, timeout=60)

    def test_relocates_real_dir_and_symlinks(self):
        src = Path(self.tmp.name) / "adapter" / "node_modules"
        src.mkdir(parents=True)
        (src / "package.json").write_text("{}")
        dst = Path(self.tmp.name) / "guest" / "node_modules"
        r = self.run_fns(
            f'_nm_relocate_to_guest "{src}" "{dst}"')
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertTrue(src.is_symlink())
        self.assertEqual(os.readlink(str(src)), str(dst))
        self.assertTrue(dst.is_dir())
        self.assertTrue((dst / "package.json").exists())
        # Symlink target has the content.
        self.assertTrue((src / "package.json").exists())

    def test_noop_when_already_symlink(self):
        src = Path(self.tmp.name) / "adapter" / "node_modules"
        src.parent.mkdir(parents=True)
        real = Path(self.tmp.name) / "somewhere"
        real.mkdir()
        src.symlink_to(real)
        dst = Path(self.tmp.name) / "guest" / "node_modules"
        r = self.run_fns(f'_nm_relocate_to_guest "{src}" "{dst}"')
        self.assertEqual(r.returncode, 0)
        self.assertFalse(dst.exists())  # nothing happened

    def test_noop_when_missing(self):
        src = Path(self.tmp.name) / "no" / "node_modules"
        dst = Path(self.tmp.name) / "guest" / "node_modules"
        r = self.run_fns(f'_nm_relocate_to_guest "{src}" "{dst}"')
        self.assertEqual(r.returncode, 0)
        self.assertFalse(dst.exists())

    def test_two_sequential_relocations_clean_guest(self):
        src = Path(self.tmp.name) / "adapter" / "node_modules"
        src.mkdir(parents=True)
        (src / "a.txt").write_text("first")
        dst = Path(self.tmp.name) / "guest" / "node_modules"
        # First relocation
        self.run_fns(f'_nm_relocate_to_guest "{src}" "{dst}"')
        self.assertTrue((dst / "a.txt").exists())
        # New install (src is now symlink; simulate by removing symlink and recreating)
        src.unlink()
        src.mkdir()
        (src / "b.txt").write_text("second")
        # Second relocation replaces old guest content.
        r = self.run_fns(f'_nm_relocate_to_guest "{src}" "{dst}"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((dst / "b.txt").exists())
        self.assertFalse((dst / "a.txt").exists())  # rm -rf guest before mv


class MonitorHeartbeatPathTest(unittest.TestCase):
    """monitor_heartbeat_path: guest path when env set, legacy otherwise."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ocvm-hb-")
        self.addCleanup(self.tmp.cleanup)
        self.env = {**os.environ, "OCVM_INTERNAL_SOURCE_ONLY": "1",
                    "OCVM_DISABLE_UPDATE_CHECK": "1"}

    def run_fns(self, script, extra_env=None):
        cmd = "set -uo pipefail\n" + MONITOR_FNS + "\n" + script
        return subprocess.run(["bash", "-c", cmd],
                              env={**self.env, **(extra_env or {})},
                              capture_output=True, text=True, timeout=10)

    def test_guest_path_when_env_set(self):
        guest_dir = Path(self.tmp.name) / "monitor-state"
        r = self.run_fns(
            'monitor_heartbeat_path "/fake/proj"',
            extra_env={"OCVM_MONITOR_STATE_DIR": str(guest_dir)})
        self.assertEqual(r.returncode, 0)
        self.assertIn(str(guest_dir), r.stdout)
        self.assertTrue(r.stdout.strip().endswith("/heartbeat.json"))

    def test_legacy_path_when_env_unset(self):
        r = self.run_fns(
            'monitor_heartbeat_path "/fake/proj"',
            extra_env={"OCVM_MONITOR_STATE_DIR": ""})
        self.assertEqual(r.returncode, 0)
        self.assertIn(".opencode-vm/monitor/heartbeat.json", r.stdout)
        self.assertIn("/fake/proj", r.stdout)


if __name__ == "__main__":
    unittest.main()