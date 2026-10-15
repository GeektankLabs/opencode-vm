"""Graphify guest artifact staging (Phase 1) — regression tests.

Runs the real production functions from opencode-vm.sh against disposable
fixtures (same convention as worktree_cleanup_test.py). Covers:
  - writer/MCP-reader path equality (SingleRepo and MCrepo),
  - positive own legacy-link migration vs. negative foreign/unclear/dangling/
    unprovenanced containers and foreign JSON/cache,
  - parallel checkouts and never-re-aimed links,
  - no host copy-back of the graph,
  - real graphifyy writer -> reader end-to-end on the canonical path (skipped
    when graphifyy is not installed) and a real MCP server protocol round-trip
    (initialize/tools/list/tools/call) on the same guest graph (skipped when no
    python with graphifyy + the decorator-era mcp API is available — pre-existing
    graphifyy 0.4.32 vs mcp>=2.0 break, see C/P).

Real VM keep/delete lifecycle is NOT covered here and stays UNVERIFIED.
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
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

    def run_fns(self, script, extra_env=None, timeout=60):
        cmd = "set -uo pipefail\n" + FNS + "\n" + script
        return subprocess.run(["bash", "-c", cmd],
                              env={**self.env, **(extra_env or {})},
                              capture_output=True, text=True, timeout=timeout)

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

    def test_negativ_real_dirs_without_link_kept(self):
        # Name+form alone are never a deletion authorization (QC-F1): bare
        # real dirs with self-generated-looking outputs survive.
        self.write_own_outputs(self.proj / ".graphify-out")
        self.write_own_outputs(self.proj / "graphify-out")
        self.write_own_outputs(self.proj / "docs" / "graphify")
        out, _ = self.migrate("apply")
        self.assertIn("no ownership proof", out.stdout)
        self.assertTrue((self.proj / ".graphify-out" / "graph.json").exists())
        self.assertTrue((self.proj / ".graphify-out" / "cache" / "abc.json").exists())
        self.assertTrue((self.proj / "graphify-out" / "graph.json").exists())
        self.assertTrue((self.proj / "docs" / "graphify" / "graph.json").exists())
        self.assertEqual(out.stdout.count("removed identified own output"), 0)

    def test_negativ_deviating_link_kept_and_lookalikes_not_cleaned(self):
        (self.proj / "docs" / "graphify").mkdir(parents=True)
        (self.proj / "docs" / "graphify" / "graph.json").write_text(
            '{"nodes": [], "edges": []}')
        os.symlink("./docs/graphify", self.proj / ".graphify-out")  # deviating form
        out, _ = self.migrate("apply")
        self.assertIn("KEEP+REPORT: custom/unclear link", out.stdout)
        self.assertEqual(os.readlink(self.proj / ".graphify-out"), "./docs/graphify")
        self.assertTrue((self.proj / "docs" / "graphify" / "graph.json").exists())
        self.assertEqual(out.stdout.count("removed identified own output"), 0)

    def test_positiv_emoji_target_only_docs_variant_kept(self):
        # Both docs variants present: cleanup must hit ONLY the recognized
        # link target, never the wrong container.
        (self.proj / "🧾 docs" / "graphify").mkdir(parents=True)
        self.write_own_outputs(self.proj / "🧾 docs" / "graphify")
        (self.proj / "docs" / "graphify").mkdir(parents=True)
        self.write_own_outputs(self.proj / "docs" / "graphify")
        os.symlink("🧾 docs/graphify", self.proj / ".graphify-out")
        out, _ = self.migrate("apply")
        self.assertIn("replaced own legacy link", out.stdout)
        self.assertFalse((self.proj / "🧾 docs" / "graphify" / "graph.json").exists())
        self.assertTrue((self.proj / "docs" / "graphify" / "graph.json").exists())
        self.assertIn("no ownership proof (name+form never suffice): "
                      + str(self.proj / "docs" / "graphify"), out.stdout)

    def test_positiv_docs_target_only_emoji_variant_kept(self):
        (self.proj / "docs" / "graphify").mkdir(parents=True)
        self.write_own_outputs(self.proj / "docs" / "graphify")
        (self.proj / "🧾 docs" / "graphify").mkdir(parents=True)
        self.write_own_outputs(self.proj / "🧾 docs" / "graphify")
        os.symlink("docs/graphify", self.proj / ".graphify-out")
        out, _ = self.migrate("apply")
        self.assertFalse((self.proj / "docs" / "graphify" / "graph.json").exists())
        self.assertTrue((self.proj / "🧾 docs" / "graphify" / "graph.json").exists())
        self.assertIn("no ownership proof (name+form never suffice): "
                      + str(self.proj / "🧾 docs" / "graphify"), out.stdout)

    def test_negativ_foreign_json_and_cache_kept(self):
        (self.proj / "docs" / "graphify").mkdir(parents=True)
        target = self.proj / "docs" / "graphify"
        (target / "graph.json").write_text('{"links": [], "nodes": []}')  # own form
        (target / "manifest.json").write_text('{"a": 1}')
        (target / "graph.html").write_text("<html>x</html>")
        (target / "foreign.json").write_text('{"nodes": []}')            # foreign name
        (target / "cache").mkdir()
        (target / "cache" / "junk.txt").write_text("nope")               # foreign cache
        os.symlink("docs/graphify", self.proj / ".graphify-out")
        out, _ = self.migrate("apply")
        self.assertIn("removed identified own output: " + str(target / "graph.json"),
                      out.stdout)
        self.assertIn("KEEP+REPORT: foreign shape: " + str(target / "cache"),
                      out.stdout)
        self.assertTrue((target / "foreign.json").exists())
        self.assertTrue((target / "cache" / "junk.txt").exists())

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


def _mcp_server_python():
    """A python that can run graphify.serve with the decorator-era mcp API
    (Server.list_tools exists). graphifyy 0.4.32 + mcp>=2.0 is a pre-existing
    break (serve.py:164 @server.list_tools); mcp==1.30.0 works."""
    cands = []
    if os.environ.get("GRAPHIFY_MCP_PYTHON"):
        cands.append(os.environ["GRAPHIFY_MCP_PYTHON"])
    cands += [sys.executable,
              str(Path.home() / ".local/share/pipx/venvs/graphifyy/bin/python"),
              "/tmp/opencode/graphify-mcp-venv/bin/python"]
    check = ("import graphify.serve, importlib.metadata as m; "
             "from mcp.server import Server; "
             "assert hasattr(Server('t'), 'list_tools'); "
             "print(m.version('mcp'))")
    for py in cands:
        if not (Path(py).exists() or shutil.which(py)):
            continue
        r = subprocess.run([py, "-c", check], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            return py, r.stdout.strip()
    return None, None


class GraphifyMcpPinTest(unittest.TestCase):
    """The tested graphifyy+mcp combination is reproducible: every
    graphify install/ensure path pins the decorator-era mcp release with
    --force (a plain inject no-ops on the already-present unpinned 2.x)."""

    PIN = "mcp==1.30.0"
    FORCE_INJECT = "pipx inject graphifyy --force"

    def test_install_and_ensure_pin_the_same_mcp_release(self):
        # Single-quoted form: provision_base site (its warn text repeats the
        # command as documentation); double-quoted form: the ensure snippet.
        self.assertIn(f"{self.FORCE_INJECT} '{self.PIN}'", TEXT)
        self.assertIn(f'{self.FORCE_INJECT} "{self.PIN}"', TEXT)
        self.assertGreaterEqual(TEXT.count(f"{self.FORCE_INJECT} '{self.PIN}'") +
                                TEXT.count(f'{self.FORCE_INJECT} "{self.PIN}"'), 2,
                                "install (provision_base) and ensure (graphify_ensure_mcp_in_vm) "
                                "must both force-pin the tested mcp release")
        # No unpinned inject and no without-force inject may remain: without
        # --force pipx reports the already-present 2.x as installed and
        # changes nothing (the ab6c3c1 defect).
        self.assertNotIn("pipx inject graphifyy mcp ", TEXT + " ")
        self.assertNotIn("pipx inject graphifyy mcp\n", TEXT)
        self.assertNotIn(f"pipx inject graphifyy '{self.PIN}'", TEXT)
        self.assertNotIn(f'pipx inject graphifyy "{self.PIN}"', TEXT)
        # graphifyy itself stays on its exact pin.
        self.assertIn("graphifyy[mcp]==0.4.32", TEXT)
        # Both sites verify the API the consumer needs (decorator-era
        # Server.list_tools), not mere module presence.
        self.assertGreaterEqual(TEXT.count("hasattr(Server"), 2)
        self.assertGreaterEqual(TEXT.count("@server.list_tools"), 2)


PIPX = shutil.which("pipx") or str(Path.home() / ".local/bin/pipx")


def _venv_py(home: Path) -> Path:
    return home / ".local/share/pipx/venvs/graphifyy/bin/python"


def _py_probe(py, code: str):
    return subprocess.run([str(py), "-c", code], capture_output=True, text=True, timeout=120)


def _mcp_version(py) -> str:
    r = _py_probe(py, "import importlib.metadata as m; print(m.version('mcp'))")
    return r.stdout.strip() if r.returncode == 0 else ""


def _mcp_api_ok(py) -> bool:
    return _py_probe(py, 'from mcp.server import Server; assert hasattr(Server, "list_tools")').returncode == 0


def _mcp_protocol_probe(py, graph: str):
    """Real MCP stdio protocol against python -m graphify.serve <graph>
    (the exact entry the production wrapper execs). Returns (tools, stats)."""
    proc = subprocess.Popen([str(py), "-m", "graphify.serve", graph],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)

    def send(obj):
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                     "clientInfo": {"name": "ocvm-test", "version": "1"}}})
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
          "params": {"name": "graph_stats", "arguments": {}}})
    got = {}
    inbox = queue.Queue()

    def reader():
        for line in proc.stdout:
            inbox.put(line)

    threading.Thread(target=reader, daemon=True).start()
    deadline = time.time() + 20
    while time.time() < deadline and not all(i in got for i in (1, 2, 3)):
        try:
            msg = json.loads(inbox.get(timeout=1))
        except (queue.Empty, ValueError):
            continue
        if "id" in msg:
            got[msg["id"]] = msg
    try:
        proc.stdin.close()
        proc.terminate()
        proc.wait(timeout=10)
        for stream in (proc.stdout, proc.stderr):
            if stream:
                stream.close()
    except Exception:
        pass
    tools = sorted(t["name"] for t in got.get(2, {}).get("result", {}).get("tools", []))
    stats = "".join(c.get("text", "") for c in got.get(3, {}).get("result", {}).get("content", []))
    return got, tools, stats


@unittest.skipUnless(Path(PIPX).exists() or shutil.which("pipx"),
                     "pipx not installed")
class GraphifyMcpPipxSandboxTest(GraphifyFixture):
    """Real pipx-sandbox regression for the pinned mcp compatibility fix
    (isolated PIPX_HOME under the fixture tempdir; the live venv, host
    install and base VM are never touched)."""

    def _sandbox_env(self, name="sbx", extra_path=None):
        home = self.base / name
        home.mkdir(parents=True, exist_ok=True)
        # pipx is a user-site install: redirecting HOME hides it from its own
        # interpreter. Keep the real user-site importable via PYTHONPATH while
        # PIPX_HOME still derives from the sandbox HOME (venv layout then
        # matches the production $HOME/.local/share/pipx path).
        user_site = subprocess.run(["python3", "-c", "import site; print(site.getusersitepackages())"],
                                   capture_output=True, text=True, timeout=30).stdout.strip()
        env = {**self.env, "HOME": str(home), "PATH": extra_path or os.environ["PATH"],
               # Explicit sandbox pipx home: an inherited PIPX_HOME (e.g. a
               # session tmp redirect) would place venvs outside the sandbox
               # and collide with other installs. The sandbox layout matches
               # the production $HOME/.local/share/pipx path the ensure
               # snippet probes.
               "PIPX_HOME": str(home / ".local/share/pipx"),
               "PIPX_BIN_DIR": str(home / ".local/bin")}
        if user_site:
            env["PYTHONPATH"] = user_site
        return home, env

    def _install(self, env, *spec):
        return subprocess.run([PIPX, "install", *spec], env=env,
                              capture_output=True, text=True, timeout=600)

    def test_incompatible_2x_healed_by_real_ensure_snippet_and_serves(self):
        if not _have_graphifyy():
            self.skipTest("graphifyy CLI not installed (needed to produce the graph)")
        home, env = self._sandbox_env("sbx-incompat")
        # 1. The exact base install command: [mcp] extra resolves mcp unpinned.
        r = self._install(env, "graphifyy[mcp]==0.4.32")
        py = _venv_py(home)
        self.assertTrue(py.exists(), r.stdout + r.stderr)
        v2 = _mcp_version(py)
        self.assertNotEqual(v2, "1.30.0",
                            f"the [mcp] extra must resolve unpinned mcp (observed {v2})")
        self.assertFalse(_mcp_api_ok(py), f"mcp {v2} must be API-incompatible")
        # 2. QC_FAIL evidence: without --force the pin is a no-op.
        subprocess.run([PIPX, "inject", "graphifyy", "mcp==1.30.0"],
                       env=env, capture_output=True, text=True, timeout=600)
        self.assertNotEqual(_mcp_version(py), "1.30.0",
                            "without --force the pin must not downgrade (ab6c3c1 defect)")
        self.assertFalse(_mcp_api_ok(py), "no-op inject must not fix the API")
        # 3. The REAL ensure snippet heals (API check + --force pin + verify).
        r = self.run_fns(VM_EXEC_STUB + "graphify_ensure_mcp_in_vm sess",
                         extra_env=env,
                         timeout=300)
        out = r.stdout + r.stderr
        self.assertIn("self-heal complete", out, out)
        self.assertEqual(_mcp_version(py), "1.30.0", out)
        self.assertTrue(_mcp_api_ok(py), "decorator-era API must be present after heal")
        # 4. Real MCP protocol on the sandbox-fixed venv over the same
        #    guest graph the real writer produced through the link.
        (self.proj / "src.py").write_text("def a():\n    return 1\ndef b():\n    return a()\n")
        token = self.run_fns(
            f'_mcps_graph_path_for_session /home/lima.linux "{self.proj}"'
        ).stdout.strip()
        canonical = token[: -len("/graph.json")]
        self.run_fns(f'graphify_ensure_out_link "{self.proj}" "{canonical}"')
        Path(canonical).mkdir(parents=True, exist_ok=True)
        w = subprocess.run([GRAPHIFY_CLI, "update", str(self.proj)],
                           capture_output=True, text=True, timeout=180,
                           env={**self.env, "HOME": str(self.base)})
        self.assertTrue(Path(token).exists(), w.stdout + w.stderr)
        got, tools, stats = _mcp_protocol_probe(py, token)
        self.assertIn(1, got, "initialize unanswered by sandbox venv")
        self.assertEqual(tools, ["get_community", "get_neighbors", "get_node",
                                 "god_nodes", "graph_stats", "query_graph",
                                 "shortest_path"], tools)
        self.assertIn("Nodes:", stats, f"graph_stats over MCP failed: {got.get(3)}")

    def test_missing_module_healed_by_real_ensure_snippet(self):
        home, env = self._sandbox_env("sbx-missing")
        # Bare install without the [mcp] extra: mcp missing entirely.
        r = self._install(env, "graphifyy==0.4.32")
        py = _venv_py(home)
        self.assertTrue(py.exists(), r.stdout + r.stderr)
        self.assertFalse(_mcp_api_ok(py), "mcp must be missing before heal")
        r = self.run_fns(VM_EXEC_STUB + "graphify_ensure_mcp_in_vm sess",
                         extra_env=env,
                         timeout=300)
        out = r.stdout + r.stderr
        self.assertIn("self-heal complete", out, out)
        self.assertEqual(_mcp_version(py), "1.30.0", out)
        self.assertTrue(_mcp_api_ok(py), out)

    def test_no_venv_is_a_silent_noop(self):
        home, env = self._sandbox_env("sbx-novenv")
        r = self.run_fns(VM_EXEC_STUB + "graphify_ensure_mcp_in_vm sess",
                         extra_env=env)
        out = r.stdout + r.stderr
        self.assertNotIn("self-heal", out, out)
        self.assertFalse(_venv_py(home).exists())

    def test_ineffective_install_reports_warning_not_success(self):
        home, _ = self._sandbox_env("sbx-err")
        venvbin = _venv_py(home).parent
        venvbin.mkdir(parents=True, exist_ok=True)
        stub = venvbin / "python"
        stub.write_text("#!/bin/sh\nexit 1\n")
        stub.chmod(0o755)
        # Shadow pipx with a failing stub: the inject cannot take effect ->
        # the ensure path must warn, never claim success.
        bindir = home / "failbin"
        bindir.mkdir(exist_ok=True)
        fake = bindir / "pipx"
        fake.write_text("#!/bin/sh\nexit 1\n")
        fake.chmod(0o755)
        r = self.run_fns(VM_EXEC_STUB + "graphify_ensure_mcp_in_vm sess",
                         extra_env={"HOME": str(home),
                                    "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}"})
        out = r.stdout + r.stderr
        self.assertIn("WARN self-heal ineffective", out, out)
        self.assertNotIn("self-heal complete", out, out)


class RealMcpServerProtocolTest(GraphifyFixture):
    """Real MCP server + JSON-RPC protocol request on the same guest graph —
    independent of the CLI reader (QC: CLI query alone is not enough)."""

    def test_mcp_protocol_round_trip_on_guest_graph(self):
        py, mcp_ver = _mcp_server_python()
        if not py:
            self.skipTest("no python with graphifyy + decorator-era mcp API "
                          "(pre-existing graphifyy 0.4.32 vs mcp>=2.0 break; "
                          "build /tmp/opencode/graphify-mcp-venv as in C/P)")
        if not _have_graphifyy():
            self.skipTest("graphifyy CLI not installed (needed to produce the graph)")
        (self.proj / "src.py").write_text("def a():\n    return 1\ndef b():\n    return a()\n")
        token = self.run_fns(
            f'_mcps_graph_path_for_session /home/lima.linux "{self.proj}"'
        ).stdout.strip()
        canonical = token[: -len("/graph.json")]
        self.run_fns(f'graphify_ensure_out_link "{self.proj}" "{canonical}"')
        Path(canonical).mkdir(parents=True, exist_ok=True)
        w = subprocess.run([GRAPHIFY_CLI, "update", str(self.proj)],
                           capture_output=True, text=True, timeout=180,
                           env={**self.env, "HOME": str(self.base)})
        self.assertTrue(Path(token).exists(), w.stdout + w.stderr)
        # REAL MCP reader: the same module entry the production wrapper execs
        # (graphify-serve-wrapper.sh -> python -m graphify.serve <graph>).
        proc = subprocess.Popen(
            [py, "-m", "graphify.serve", token],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)

        def send(obj):
            proc.stdin.write(json.dumps(obj) + "\n")
            proc.stdin.flush()

        send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": {"name": "ocvm-test", "version": "1"}}})
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
              "params": {"name": "graph_stats", "arguments": {}}})
        got = {}
        inbox = queue.Queue()

        def reader():
            for line in proc.stdout:
                inbox.put(line)

        threading.Thread(target=reader, daemon=True).start()
        deadline = time.time() + 20
        while time.time() < deadline and not all(i in got for i in (1, 2, 3)):
            try:
                msg = json.loads(inbox.get(timeout=1))
            except (queue.Empty, ValueError):
                continue
            if "id" in msg:
                got[msg["id"]] = msg
        try:
            proc.stdin.close()
            proc.terminate()
            proc.wait(timeout=10)
            for stream in (proc.stdout, proc.stderr):
                if stream:
                    stream.close()
        except Exception:
            pass
        self.assertIn(1, got, "initialize unanswered")
        self.assertEqual(got[1]["result"]["serverInfo"]["name"], "graphify")
        tools = sorted(t["name"] for t in got.get(2, {}).get("result", {}).get("tools", []))
        self.assertEqual(tools, ["get_community", "get_neighbors", "get_node",
                                 "god_nodes", "graph_stats", "query_graph",
                                 "shortest_path"], tools)
        content = got.get(3, {}).get("result", {}).get("content", [])
        text = "".join(c.get("text", "") for c in content)
        self.assertIn("Nodes:", text, f"graph_stats over MCP failed: {got.get(3)}")
        self.assertTrue(mcp_ver, "recorded mcp version of the serving python")


if __name__ == "__main__":
    unittest.main()
