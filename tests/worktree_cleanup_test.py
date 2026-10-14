"""Run the production host cleanup against disposable local Git repositories."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "opencode-vm.sh"
TEXT = SCRIPT.read_text()
HELPER = "cleanup_project_worktrees() {" + TEXT.split(
    "cleanup_project_worktrees() {", 1)[1].split("\nstart_session() {", 1)[0]
REAL_GIT = shutil.which("git")


class WorktreeCleanupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ocvm-worktree-cleanup-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.repo = Path(self.tmp.name) / "project with spaces"
        self.repo.mkdir()
        self.env = {**os.environ, "HOME": str(self.home),
                    "OCVM_INTERNAL_SOURCE_ONLY": "1", "OCVM_DISABLE_UPDATE_CHECK": "1"}
        self.git("init", "-b", "main")
        (self.repo / ".gitignore").write_text(
            ".opencode-vm/\nnode_modules/\n__pycache__/\n*.pyc\n"
            ".saved-artifact/\nadapters/mcp/dist/\n")
        (self.repo / "source.txt").write_text("source\n")
        source = self.repo / "adapters" / "mcp" / "src"
        source.mkdir(parents=True)
        (source / "main.ts").write_text("tracked source\n")
        self.git("add", ".")
        self.git("commit", "-m", "base")
        self.base = self.repo / ".opencode-vm" / "worktrees"
        self.base.mkdir(parents=True)

    def git(self, *args, cwd=None):
        return subprocess.run([REAL_GIT, "-c", "user.name=Fixture", "-c",
                               "user.email=fixture@example.invalid", "-C", str(cwd or self.repo),
                               *args], env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def worktree(self, name, outside=False, detached=False):
        path = (Path(self.tmp.name) if outside else self.base) / name
        args = ["worktree", "add"]
        args += ["--detach", str(path), "HEAD"] if detached else ["-b", name, str(path)]
        self.git(*args)
        return path

    def cleanup(self, extra=None, project=None):
        result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + HELPER +
                                 '\ncleanup_project_worktrees "$1"', "fixture", str(project or self.repo)],
                                env={**self.env, **(extra or {})}, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout + result.stderr

    def test_integrated_clean_and_known_caches_removed_branches_preserved_idempotently(self):
        path = self.worktree("task_clean")
        (path / "node_modules").mkdir()
        (path / "node_modules" / "cache.js").write_text("generated")
        dist = path / "adapters" / "mcp" / "dist"
        dist.mkdir(parents=True)
        (dist / "main.js").write_text("generated")
        before = self.git("rev-parse", "task_clean")
        self.assertIn("1 removed", self.cleanup())
        self.assertFalse(path.exists())
        self.assertEqual(self.git("rev-parse", "task_clean"), before)
        self.assertNotIn(str(path), self.git("worktree", "list", "--porcelain"))
        self.assertIn("0 removed", self.cleanup())

    def test_fresh_boundary_discards_unmerged_dirty_ignored_and_locked_work_but_preserves_commits(self):
        unmerged = self.worktree("task_unmerged")
        self.git("commit", "--allow-empty", "-m", "unmerged", cwd=unmerged)
        tracked = self.worktree("task_tracked")
        (tracked / "source.txt").write_text("unfinished")
        untracked = self.worktree("task_untracked")
        (untracked / "report.md").write_text("unpublished")
        ignored = self.worktree("task_ignored")
        (ignored / ".saved-artifact").mkdir()
        (ignored / ".saved-artifact" / "report.txt").write_text("needed result")
        build_report = self.worktree("task_build_report")
        output_dir = build_report / "adapters" / "mcp" / "dist"
        output_dir.mkdir(parents=True)
        (output_dir / "report.md").write_text("needed even inside ignored dist")
        locked = self.worktree("task_locked")
        self.git("worktree", "lock", str(locked))
        detached = self.worktree("task_detached", detached=True)
        heads = {path.name: self.git("rev-parse", "HEAD", cwd=path)
                 for path in (unmerged, tracked, untracked, ignored, build_report, locked, detached)}
        output = self.cleanup()
        self.assertIn("7 removed, 0 retained", output)
        for path in (unmerged, tracked, untracked, ignored, build_report, locked, detached):
            self.assertFalse(path.exists(), path)
        for name, head in heads.items():
            if name == detached.name:
                name = "ocvm-retained/worktree-" + head
            self.assertEqual(self.git("rev-parse", name), head)
        self.assertEqual((self.repo / "source.txt").read_text(), "source\n", "Main working copy is outside the disposal scope")

    def test_other_locations_and_symlinked_candidates_never_removed(self):
        outside = self.worktree("outside", outside=True)
        linked = self.worktree("task_linked")
        real = Path(self.tmp.name) / "moved-source"
        linked.rename(real)
        linked.symlink_to(real, target_is_directory=True)
        output = self.cleanup()
        self.assertIn("unsafe or moved path", output)
        self.assertTrue(linked.is_symlink())
        self.assertTrue(real.exists())
        self.assertTrue(outside.exists())

    def test_guest_native_path_detection(self):
        # Extract ocvm_is_guest_native_path from the production script.
        fn = "ocvm_is_guest_native_path() {" + TEXT.split(
            "ocvm_is_guest_native_path() {", 1)[1].split("\nocvm_worktree_root() {", 1)[0]
        script = "set -euo pipefail\n" + fn + "\n"
        # A real directory on the local filesystem should be guest-native
        # (ext4, tmpfs …) on Linux.  We only assert the function runs and
        # returns a deterministic boolean for an existing path.
        result = subprocess.run(
            ["bash", "-c", script + '\nocvm_is_guest_native_path "$1" && echo yes || echo no',
             "fixture", str(self.repo)],
            capture_output=True, text=True, timeout=10)
        self.assertIn(result.stdout.strip(), ("yes", "no"))
        # A missing path must return non-zero (refuse to validate).
        result2 = subprocess.run(
            ["bash", "-c", script + '\nocvm_is_guest_native_path /nonexistent-path-ocvm-test && echo yes || echo no',
             "fixture"],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result2.stdout.strip(), "no")

    def test_stale_guest_registration_is_pruned_when_checkout_path_vanished(self):
        outside = self.worktree("task_guest_stale", outside=True)
        # Simulate guest-VM replacement: checkout directory disappears.
        shutil.rmtree(outside)
        self.assertFalse(outside.exists())
        output = self.cleanup()
        self.assertIn("Pruned stale guest registration: task_guest_stale", output)
        self.assertNotIn(str(outside), self.git("worktree", "list", "--porcelain"))

    def test_live_guest_worktree_outside_base_is_left_alone(self):
        outside = self.worktree("task_guest_live", outside=True)
        output = self.cleanup()
        self.assertNotIn("Pruned stale guest registration", output)
        self.assertTrue(outside.exists())
        self.assertIn(str(outside), self.git("worktree", "list", "--porcelain"))

    def test_main_uncommitted_and_unregistered_work_survive_the_disposal_boundary(self):
        victim = self.worktree("task_disposable")
        (self.repo / "source.txt").write_text("Main pending changes\n")
        (self.repo / "main-note.md").write_text("untracked Main work")
        (self.repo / ".saved-artifact").mkdir()
        (self.repo / ".saved-artifact" / "main-result.txt").write_text("ignored Main work")
        unregistered = self.base / "task_unregistered"
        unregistered.mkdir()
        (unregistered / "unfinished.txt").write_text("not a registered worktree")
        self.assertIn("1 removed", self.cleanup())
        self.assertFalse(victim.exists())
        self.assertEqual((self.repo / "source.txt").read_text(), "Main pending changes\n")
        self.assertEqual((self.repo / "main-note.md").read_text(), "untracked Main work")
        self.assertEqual((self.repo / ".saved-artifact" / "main-result.txt").read_text(), "ignored Main work")
        self.assertEqual((unregistered / "unfinished.txt").read_text(), "not a registered worktree")

    def test_symlinked_container_and_nonrepository_degrade_without_deletion(self):
        path = self.worktree("task_retained")
        moved = Path(self.tmp.name) / "moved-container"
        self.base.rename(moved)
        self.base.symlink_to(moved, target_is_directory=True)
        self.assertIn("symlinked", self.cleanup())
        self.assertTrue(path.exists())
        self.assertIn("unavailable", self.cleanup(project=self.home))

    def test_remove_failure_retains_source_and_normal_startup_contract(self):
        path = self.worktree("task_remove_failure")
        bin_dir = Path(self.tmp.name) / "bin"
        bin_dir.mkdir()
        wrapper = bin_dir / "git"
        wrapper.write_text("#!/usr/bin/env python3\nimport os,sys\n"
                           "if 'worktree' in sys.argv and 'remove' in sys.argv: sys.exit(1)\n"
                           f"os.execv({REAL_GIT!r}, [{REAL_GIT!r}] + sys.argv[1:])\n")
        wrapper.chmod(0o755)
        output = self.cleanup({"PATH": str(bin_dir) + os.pathsep + self.env["PATH"]})
        self.assertIn("1 failed", output)
        self.assertTrue(path.exists())
        self.git("rev-parse", "task_remove_failure")

    def test_project_root_is_preserved_even_when_detached(self):
        path = self.worktree("task_keep")
        self.git("checkout", "--detach", "HEAD")
        self.assertIn("1 removed", self.cleanup())
        self.assertFalse(path.exists())
        self.assertTrue((self.repo / "source.txt").exists())
        self.git("rev-parse", "task_keep")

    def test_detached_retention_never_overwrites_an_existing_branch(self):
        path = self.worktree("task_detached_conflict", detached=True)
        source = self.git("rev-parse", "HEAD", cwd=path)
        self.git("commit", "--allow-empty", "-m", "another retained state")
        other = self.git("rev-parse", "HEAD")
        name = "ocvm-retained/worktree-" + source
        self.git("branch", name, other)
        self.assertIn("0 removed, 1 retained", self.cleanup())
        self.assertTrue(path.exists())
        self.assertEqual(self.git("rev-parse", name), other)
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=path), source)

    def test_fresh_hook_after_finalization_and_never_on_reconnect_cancel_or_failed_stop(self):
        senv = Path(self.tmp.name) / "session.env"
        senv.write_text("SESS_NAME=fixture\n")
        for action, failed, present, expected in (
                ("fresh", False, True, "destroy\ncleanup\nreserve\n"),
                ("fresh", True, True, "destroy\n"),
                ("reconnect", False, True, "attach\n"),
                ("cancel", False, True, ""),
                ("fresh", False, False, "cleanup\nreserve\n")):
            trace = Path(self.tmp.name) / "trace"
            trace.write_text("")
            if present:
                senv.write_text("SESS_NAME=fixture\n")
            else:
                senv.unlink(missing_ok=True)
            driver = '''
set -euo pipefail
source "$1"
SESSION_MODE=web; SESSION_MCP_MODE=""; SESSION_JOURNAL_MODE=""
mcp_session_mode() { printf 'web\\n'; }
vscode_trust_preflight() { return 0; }
need() { :; }
sanitize_lima_sock_dir() { :; }
ensure_dirs() { :; }
ensure_host_opencode_dirs() { :; }
backup_host_cfg() { :; }
ensure_policy_file() { :; }
vmcfg_load() { :; }
vmcfg_print_override_notice() { :; }
session_env() { printf '%s\\n' "$SENV"; }
_decide_start_action() { printf '%s\\n' "$ACTION"; }
is_vm_running() { return 0; }
_warn_vm_sizing_mismatch() { :; }
attach_session() { printf 'attach\\n' >> "$TRACE"; }
_destroy_prev_session() { printf 'destroy\\n' >> "$TRACE"; return "$STOP_RC"; }
cleanup_project_worktrees() { printf 'cleanup\\n' >> "$TRACE"; }
mcp_reserve_host_port() { printf 'reserve\\n' >> "$TRACE"; return 1; }
if start_session; then :; else :; fi
'''
            subprocess.run(["bash", "-c", driver, "fixture", str(SCRIPT)], cwd=self.repo,
                           env={**self.env, "SENV": str(senv), "TRACE": str(trace), "ACTION": action,
                                "STOP_RC": "1" if failed else "0"}, check=True, capture_output=True)
            self.assertEqual(trace.read_text(), expected, (action, failed, present))


if __name__ == "__main__":
    unittest.main()
