"""Graphify guest artifact staging (Phase 1) — regression tests.

Runs the real production functions from opencode-vm.sh against disposable
fixtures (same convention as worktree_cleanup_test.py). Covers:
  - writer/MCP-reader path equality (SingleRepo and MCrepo),
  - positive own legacy-link migration vs. negative foreign/unclear/dangling,
  - parallel checkouts and never-re-aimed links,
  - no host copy-back of the graph,
  - real graphifyy writer -> reader end-to-end on the canonical path (skipped
    when graphifyy is not installed).

Real VM keep/delete lifecycle is NOT covered here and stays UNVERIFIED.
"""
import hashlib
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


FNS = "\n".join([
    _extract("mcrepo_docs_dir", "graphify_guest_base"),
    _extract("graphify_guest_base", "graphify_guest_dir"),
    _extract("graphify_guest_dir", "graphify_ensure_out_link"),
    _extract("graphify_ensure_out_link", "_graphify_git_tracked"),
    _extract("_graphify_git_tracked", "_graphify_form_ok"),
    _extract("_graphify_form_ok", "graphify_migrate_legacy_outputs"),
    _extract("graphify_migrate_legacy_outputs", "_skills_registry_path"),
    _extract("_mcps_graph_path_for_session", "graphify_persist_dir_for_project"),
    _extract("graphify_persist_dir_for_project", "graphify_ensure_mcp_in_vm"),
    _extract("graphify_ensure_mcp_in_vm", "graphify_guest_prepare"),
    _extract("graphify_guest_prepare", "graphify_guest_prepare_link"),
    _extract("graphify_guest_prepare_link", "mcps_build_config_json"),
])

GRAPHIFY_CLI = shutil.which("graphify") or str(
    Path.home() / ".local/bin/graphify")


def _have_graphifyy():
    if not os.access(GRAPHIFY_CLI, os.X_OK):
        return False
    return subprocess.run(
        [GRAPHIFY_CLI, "--help"], capture_output=True, timeout=30
    ).returncode == 0


class GraphifyFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ocvm-graphify-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.proj = self.base / "proj"
        self.proj.mkdir()
        self.guest = self.base / "guest-artifacts"
        self.guest.mkdir()
        self.env = {**os.environ, "OCVM_INTERNAL_SOURCE_ONLY": "1",
                    "OCVM_DISABLE_UPDATE_CHECK": "1",
                    "OCVM_ARTIFACT_ROOT": str(self.guest)}

    def run_fns(self, script, extra_env=None):
        cmd = "set -uo pipefail\n" + FNS + "\n" + script
        return subprocess.run(["bash", "-c", cmd],
                              env={**self.env, **(extra_env or {})},
                              capture_output=True, text=True, timeout=60)

    def git(self, *args):
        return subprocess.run(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=f@x.invalid",
             "-C", str(self.proj), *args],
            env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def write_own_outputs(self, container):
        container.mkdir(parents=True, exist_ok=True)
        (container / "graph.json").write_text('{"nodes": [], "edges": []}')
        (container / "manifest.json").write_text('{"src.py": 1.0}')
        (container / "graph.html").write_text("<html>g</html>")
        cache = container / "cache"
        cache.mkdir()
        (cache / "abc.json").write_text('{"x": 1}')


class PathEqualityTest(GraphifyFixture):
    """Generation (through the link) and MCP reading share one guest path."""

    def _canonical(self, proj=None):
        r = self.run_fns(
            f'graphify_guest_dir /home/lima.linux "{proj or self.proj}"')
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_single_repo_token_equals_link_target(self):
        canonical = self._canonical()
        r = self.run_fns(
            f'graphify_ensure_out_link "{self.proj}" "{canonical}" >/dev/null\n'
            f'_mcps_graph_path_for_session /home/lima.linux "{self.proj}"')
        self.assertEqual(r.returncode, 0, r.stderr)
        token = r.stdout.strip()
        self.assertEqual(token, canonical + "/graph.json")
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), canonical)

    def test_mcrepo_token_equals_link_target(self):
        (self.proj / "mcrepo.yaml").write_text("schema: 2\n")
        canonical = self._canonical()
        r = self.run_fns(
            f'graphify_ensure_out_link "{self.proj}" "{canonical}" >/dev/null\n'
            f'_mcps_graph_path_for_session /home/lima.linux "{self.proj}"')
        token = r.stdout.strip()
        self.assertEqual(token, canonical + "/graph.json")
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), canonical)

    def test_guest_dir_hash_matches_proj_hash_semantics(self):
        expected = hashlib.md5(str(self.proj).encode()).hexdigest()
        self.assertIn("/" + expected + "/graphify", self._canonical())

    def test_artifact_root_override_honored(self):
        r = self.run_fns(
            f'graphify_guest_dir /home/lima.linux "{self.proj}"')
        self.assertTrue(r.stdout.strip().startswith(str(self.guest) + "/"), r.stdout)

    def test_default_base_without_override(self):
        r = self.run_fns(f'graphify_guest_dir /home/lima.linux "{self.proj}"',
                         extra_env={"OCVM_ARTIFACT_ROOT": ""})
        self.assertIn("/home/lima.linux/.opencode-vm/artifacts/", r.stdout)


class EnsureNeverReaimsTest(GraphifyFixture):
    def test_missing_link_created_once(self):
        canonical = str(self.guest / "h" / "graphify")
        r = self.run_fns(f'graphify_ensure_out_link "{self.proj}" "{canonical}"')
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), canonical)
        self.assertIn(canonical, r.stdout)

    def test_second_call_with_other_target_does_not_flip(self):
        first = str(self.guest / "h1" / "graphify")
        second = str(self.guest / "h2" / "graphify")
        self.run_fns(f'graphify_ensure_out_link "{self.proj}" "{first}"')
        r = self.run_fns(f'graphify_ensure_out_link "{self.proj}" "{second}"')
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), first)
        self.assertIn("leaving it unchanged", r.stderr)

    def test_real_dir_left_alone(self):
        (self.proj / ".graphify-out").mkdir()
        (self.proj / ".graphify-out" / "graph.json").write_text("{}")
        r = self.run_fns(
            f'graphify_ensure_out_link "{self.proj}" "{self.guest}/h/graphify"')
        self.assertTrue((self.proj / ".graphify-out").is_dir())
        self.assertIn("not a symlink", r.stderr)

    def test_parallel_checkouts_get_distinct_guest_dirs(self):
        other = self.base / "proj2"
        other.mkdir()
        a = self.run_fns(f'graphify_guest_dir /home/lima.linux "{self.proj}"').stdout
        b = self.run_fns(f'graphify_guest_dir /home/lima.linux "{other}"').stdout
        self.assertNotEqual(a, b)


class LegacyMigrationTest(GraphifyFixture):
    def migrate(self, mode, old_sess="", old_persist=""):
        canonical = str(self.guest / "h" / "graphify")
        return self.run_fns(
            f'graphify_migrate_legacy_outputs "{self.proj}" "{canonical}" {mode} '
            f'"{old_sess}" "{old_persist}"'), canonical

    def test_positiv_own_legacy_link_replaced_target_kept(self):
        (self.proj / "docs").mkdir()
        self.write_own_outputs(self.proj / "docs" / "graphify")
        (self.proj / "docs" / "graphify" / "GRAPH_REPORT.md").write_text("# r")
        (self.proj / "docs" / "graphify" / "README.md").write_text("# r")
        os.symlink("docs/graphify", self.proj / ".graphify-out")
        out, canonical = self.migrate("apply")
        self.assertIn("replaced own legacy link", out.stdout)
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), canonical)
        kept = self.proj / "docs" / "graphify"
        self.assertTrue((kept / "GRAPH_REPORT.md").exists())
        self.assertTrue((kept / "README.md").exists())
        self.assertFalse((kept / "graph.json").exists())
        self.assertFalse((kept / "cache").exists())

    def test_positiv_emoji_docs_variant(self):
        (self.proj / "🧾 docs" / "graphify").mkdir(parents=True)
        (self.proj / "🧾 docs" / "graphify" / "graph.json").write_text(
            '{"nodes": [], "edges": []}')
        os.symlink("🧾 docs/graphify", self.proj / ".graphify-out")
        out, canonical = self.migrate("apply")
        self.assertIn("replaced own legacy link", out.stdout)
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), canonical)

    def test_dry_run_changes_nothing(self):
        (self.proj / "docs" / "graphify").mkdir(parents=True)
        (self.proj / "docs" / "graphify" / "graph.json").write_text(
            '{"nodes": [], "edges": []}')
        os.symlink("docs/graphify", self.proj / ".graphify-out")
        out, _ = self.migrate("dry-run")
        self.assertIn("would replace own legacy link", out.stdout)
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), "docs/graphify")
        self.assertTrue((self.proj / "docs" / "graphify" / "graph.json").exists())

    def test_negativ_custom_link_kept(self):
        os.symlink("/somewhere/else", self.proj / ".graphify-out")
        out, _ = self.migrate("apply")
        self.assertIn("KEEP+REPORT", out.stdout)
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), "/somewhere/else")

    def test_negativ_dangling_link_kept(self):
        os.symlink("docs/graphify", self.proj / ".graphify-out")  # target missing
        out, _ = self.migrate("apply")
        self.assertIn("KEEP+REPORT", out.stdout)
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), "docs/graphify")

    def test_negativ_unclear_absolute_link_kept(self):
        os.symlink(str(self.base / "elsewhere" / "graphify"),
                   self.proj / ".graphify-out")
        out, _ = self.migrate("apply")
        self.assertIn("KEEP+REPORT", out.stdout)
        self.assertTrue((self.proj / ".graphify-out").is_symlink())

    def test_negativ_tracked_and_foreign_outputs_kept(self):
        (self.proj / "docs" / "graphify").mkdir(parents=True)
        tracked = self.proj / "docs" / "graphify" / "graph.json"
        tracked.write_text('{"nodes": [], "edges": []}')
        (self.proj / "docs" / "graphify" / "notes.txt").write_text("foreign")
        foreign_shape = self.proj / "docs" / "graphify" / "manifest.json"
        foreign_shape.write_text("not-json")
        self.git("init", "-b", "main")
        self.git("add", "docs/graphify/graph.json")
        self.git("commit", "-m", "base")
        os.symlink("docs/graphify", self.proj / ".graphify-out")
        out, _ = self.migrate("apply")
        self.assertIn("replaced own legacy link", out.stdout)
        self.assertIn("KEEP+REPORT: git-tracked", out.stdout)
        self.assertIn("KEEP+REPORT: foreign shape", out.stdout)
        self.assertTrue(tracked.exists())
        self.assertTrue((self.proj / "docs" / "graphify" / "notes.txt").exists())
        self.assertTrue(foreign_shape.exists())

    def test_old_host_stores_retired_only_when_identified(self):
        old_sess = self.base / "sess" / "graphify"
        old_persist = self.base / "state" / "graphify"
        self.write_own_outputs(old_sess)
        self.write_own_outputs(old_persist)
        (old_persist / "user-note.txt").write_text("foreign")
        out, _ = self.migrate("apply", str(old_sess), str(old_persist))
        self.assertFalse(old_sess.exists())          # identified only -> retired
        self.assertIn("removed emptied legacy store", out.stdout)
        self.assertTrue(old_persist.exists())        # foreign file -> kept
        self.assertIn("not empty/unknown content", out.stdout)

    def test_migration_idempotent_no_flapping(self):
        (self.proj / "docs" / "graphify").mkdir(parents=True)
        os.symlink("docs/graphify", self.proj / ".graphify-out")
        _, canonical = self.migrate("apply")
        out, _ = self.migrate("apply")
        self.assertIn("already on guest target", out.stdout)
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), canonical)


class NoCopybackTest(GraphifyFixture):
    def test_production_has_no_host_copyback(self):
        self.assertNotIn("graphify_persist_load_for_session() {", TEXT)
        self.assertNotIn("graphify_persist_save_for_session() {", TEXT)
        self.assertNotIn("cp -p \"$persist_dir/graph.json\"", TEXT)
        self.assertNotIn("cp -p \"$sess_file\" \"$persist_dir/graph.json\"", TEXT)

    def test_token_is_guest_path_not_session_share(self):
        r = self.run_fns(
            f'_mcps_graph_path_for_session /home/lima.linux "{self.proj}"')
        self.assertIn(str(self.guest), r.stdout)      # OCVM_ARTIFACT_ROOT honored
        self.assertNotIn("/sessions/", r.stdout)      # never a session-share path
        self.assertTrue(r.stdout.strip().endswith("/graphify/graph.json"))


VM_EXEC_STUB = '''
vm_exec() {
  local vm="$1" script="$2"
  shift 2
  bash -c "$script" stub "$@"
}
'''


class GuestPrepareGateTest(GraphifyFixture):
    """The real guest snippet runs locally via a vm_exec stub: fail-closed
    fstype gate (fuse -> refuse) and path gate (only */graphify)."""

    def prepare(self, target):
        return self.run_fns(
            VM_EXEC_STUB + f'graphify_guest_prepare sess "{target}"')

    def test_refuses_wrong_suffix(self):
        target = str(self.guest / "not-graphify")
        r = self.prepare(target)
        self.assertIn("refusing non-artifact dir", r.stderr + r.stdout)
        self.assertFalse(Path(target).exists())

    def test_refuses_host_share_or_unknown_fs(self):
        # Use the repository mount: fuseblk inside the VM, unknown stat on a
        # macOS host — both must refuse. Only run when refusal is expected so
        # the fixture can never create anything inside the repo.
        probe = subprocess.run(["stat", "-f", "-c", "%T", str(ROOT)],
                               capture_output=True, text=True)
        if probe.returncode == 0 and not probe.stdout.strip().startswith("fuse"):
            self.skipTest("repo is on a guest-native filesystem here")
        target = str(ROOT) + "/x-graphify-should-never-exist/graphify"
        r = self.prepare(target)
        out = r.stderr + r.stdout
        self.assertIn("refusing", out)
        self.assertFalse(Path(target).exists())

    def test_creates_on_guest_native_fs(self):
        probe = self.guest / "probe"
        probe.mkdir()
        st = subprocess.run(["stat", "-f", "-c", "%T", str(probe)],
                            capture_output=True, text=True)
        if st.returncode != 0 or st.stdout.strip().startswith("fuse"):
            self.skipTest("no guest-native filesystem in this test environment")
        target = str(self.guest / "h" / "graphify")
        r = self.prepare(target)
        self.assertTrue(Path(target).is_dir(), r.stderr + r.stdout)

    def test_prepare_link_only_for_canonical_target(self):
        canonical = self.run_fns(
            f'graphify_guest_dir /home/lima.linux "{self.proj}"').stdout.strip()
        os.symlink(canonical, self.proj / ".graphify-out")
        r = self.run_fns(VM_EXEC_STUB +
                         f'graphify_guest_prepare_link sess /home/lima.linux "{self.proj}"')
        self.assertTrue(Path(canonical).is_dir(), r.stderr + r.stdout)
        # custom link -> never followed/prepared
        other = self.base / "custom-target" / "graphify"
        proj2 = self.base / "proj2"
        proj2.mkdir()
        os.symlink(str(other), proj2 / ".graphify-out")
        self.run_fns(VM_EXEC_STUB +
                     f'graphify_guest_prepare_link sess /home/lima.linux "{proj2}"')
        self.assertFalse(other.exists())


@unittest.skipUnless(_have_graphifyy(), "graphifyy CLI not installed")
class RealWriterReaderE2ETest(GraphifyFixture):
    """Real graphifyy writer and real reader entry share the token path."""

    def test_writer_and_reader_use_same_canonical_path(self):
        (self.proj / "src.py").write_text("def a():\n    return 1\n")
        canonical = self.run_fns(
            f'graphify_guest_dir /home/lima.linux "{self.proj}"').stdout.strip()
        token = self.run_fns(
            f'_mcps_graph_path_for_session /home/lima.linux "{self.proj}"'
        ).stdout.strip()
        self.assertEqual(token, canonical + "/graph.json")
        self.run_fns(f'graphify_ensure_out_link "{self.proj}" "{canonical}"')
        Path(canonical).mkdir(parents=True, exist_ok=True)   # guest dir prepare
        # REAL writer: the production CLI writes through .graphify-out
        w = subprocess.run([GRAPHIFY_CLI, "update", str(self.proj)],
                           capture_output=True, text=True, timeout=180,
                           env={**self.env, "HOME": str(self.base)})
        self.assertTrue(Path(token).exists(),
                        f"writer did not land on token path: {w.stdout}{w.stderr}")
        # REAL reader entry (same graph_path argument the MCP wrapper passes):
        q = subprocess.run([GRAPHIFY_CLI, "query", "what is here", "--graph", token],
                           capture_output=True, text=True, timeout=60,
                           env={**self.env, "HOME": str(self.base)})
        self.assertNotIn("No graph at", q.stdout + q.stderr)
        self.assertEqual(q.returncode, 0, q.stdout + q.stderr)


if __name__ == "__main__":
    unittest.main()
