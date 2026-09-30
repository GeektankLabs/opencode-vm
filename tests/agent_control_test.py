"""Agent Control policy persistence, validation and HTTP boundary."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import hub.server as server
from hub.catalog import read_catalog, mcp_connection, read_capabilities
from hub.policy import PolicyStore, PolicyConflict, PolicyError, PolicyCapabilityError, PROFILES, check_selection, resolve_profile


CATALOG = {"providers": [{"provider_id": "p", "name": "Provider"}],
           "models": [{"provider_id": "p", "model_id": "family/model", "name": "Current",
                       "variants": ["default", "high"]}], "truncated": False}
SELECTION = {"provider_id": "p", "model_id": "family/model", "variant": "high"}


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / "project"
        self.project.mkdir()
        self.store = PolicyStore(self.project)

    def tearDown(self):
        self.temp.cleanup()

    def test_missing_policy_is_virtual_and_portable_policy_is_git_ignored(self):
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        self.assertEqual(self.store.read()["profiles"], dict.fromkeys(PROFILES))
        self.assertFalse(self.store.path.exists())
        saved = self.store.update("deep", SELECTION, 0)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(self.store.read()["profiles"]["deep"], SELECTION)
        self.assertIn(".opencode-vm/", (self.project / ".gitignore").read_text())
        text = self.store.path.read_text()
        self.assertNotIn(str(self.project), text)
        self.assertNotIn("token", text)
        self.assertEqual(subprocess.run(["git", "check-ignore", "-q", str(self.store.path)],
                                        cwd=self.project).returncode, 0)
        subprocess.run(["git", "add", "-f", ".opencode-vm/agent-control.json"], cwd=self.project, check=True)
        staged = subprocess.check_output(["git", "ls-files"], cwd=self.project, text=True).splitlines()
        self.assertEqual(staged, [".opencode-vm/agent-control.json"])

    def test_future_and_invalid_policy_fail_closed(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_text().replace('"schemaVersion":1', '"schemaVersion":3')
        self.store.path.write_text(original)
        with self.assertRaises(PolicyError):
            self.store.update("execution", SELECTION, 1)
        self.assertEqual(self.store.path.read_text(), original)

    def test_policy_rejects_secret_like_values_and_absolute_paths(self):
        with self.assertRaises(PolicyError):
            self.store.update("deep", {**SELECTION, "provider_id": "sk-" + "x" * 24}, 0)
        with self.assertRaises(PolicyError):
            self.store.update("deep", {**SELECTION, "model_id": "/Users/private/model"}, 0)
        self.assertFalse(self.store.path.exists())

    def test_read_rejects_budget_and_exact_profile_format_without_mutation(self):
        self.store.update("deep", SELECTION, 0)
        valid = json.loads(self.store.path.read_text())
        for data in (b" " * (16 * 1024 + 1),
                     json.dumps({**valid, "schemaVersion": 2}).encode(),
                     json.dumps({**valid, "profiles": {**valid["profiles"], "design": None}}).encode()):
            self.store.path.write_bytes(data)
            with self.assertRaises(PolicyError): self.store.read()
            self.assertEqual(self.store.path.read_bytes(), data)

    def test_concurrent_revision_allows_only_one_write(self):
        outcomes = []
        def write(profile):
            try:
                self.store.update(profile, SELECTION, 0)
                outcomes.append("saved")
            except PolicyConflict:
                outcomes.append("conflict")
        threads = [threading.Thread(target=write, args=(name,)) for name in ("deep", "standard")]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertCountEqual(outcomes, ["saved", "conflict"])
        self.assertEqual(self.store.read()["revision"], 1)

    def test_catalog_validation_distinguishes_missing_and_incomplete(self):
        self.assertEqual(check_selection(SELECTION, CATALOG), "available")
        self.assertEqual(check_selection({**SELECTION, "provider_id": "other"}, CATALOG), "provider_unavailable")
        self.assertEqual(check_selection({**SELECTION, "model_id": "other"}, CATALOG), "model_unavailable")
        self.assertEqual(check_selection({**SELECTION, "variant": "missing"}, CATALOG), "variant_unavailable")
        self.assertEqual(check_selection(SELECTION, {**CATALOG, "truncated": True}), "catalog_incomplete")
        self.assertEqual(check_selection(SELECTION, None), "catalog_unavailable")

    def test_explicit_atomic_upgrade_and_clear_preserve_basics(self):
        self.store.update("deep", SELECTION, 0)
        self.store.update("standard", SELECTION, 1)
        original = self.store.path.read_bytes()
        self.assertEqual(json.loads(original)["schemaVersion"], 1)
        self.assertEqual(len(json.loads(original)["profiles"]), 3)
        with self.assertRaises(PolicyCapabilityError):
            self.store.update("design", SELECTION, 2)
        self.assertEqual(self.store.path.read_bytes(), original)
        updated = self.store.update("design", SELECTION, 2, optional_capable=True)
        backup = self.store.directory / "agent-control.schema1-rev2.backup.json"
        self.assertEqual(backup.read_bytes(), original)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(updated["schemaVersion"], 2)
        self.assertEqual(updated["revision"], 3)
        self.assertEqual(updated["profiles"]["deep"], SELECTION)
        self.assertIsNone(updated["profiles"]["review"])
        self.assertEqual(self.store.update("design", None, 3)["schemaVersion"], 2)

    def test_first_optional_save_without_original_has_no_fictitious_backup(self):
        saved = self.store.update("review", SELECTION, 0, optional_capable=True)
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(saved["schemaVersion"], 2)
        self.assertEqual(list(self.store.directory.glob("*.backup.json")), [])
        self.assertIsNone(saved["profiles"]["design"])

    def test_interrupted_upgrade_replay_and_differing_backup_fail_closed(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_bytes()
        with patch("hub.policy.os.replace", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                self.store.update("review", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.assertEqual(self.store.read()["revision"], 1)
        backup = self.store.directory / "agent-control.schema1-rev1.backup.json"
        backup.write_bytes(b"different")
        with self.assertRaises(PolicyError):
            self.store.update("review", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        backup.write_bytes(original)
        self.assertEqual(self.store.update("review", SELECTION, 1, optional_capable=True)["revision"], 2)

    def test_backup_failure_and_unsafe_paths_do_not_publish(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_bytes()
        with patch("hub.policy.os.link", side_effect=OSError("backup failed")):
            with self.assertRaises(OSError):
                self.store.update("design", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        backup = self.store.directory / "agent-control.schema1-rev1.backup.json"
        backup.symlink_to(self.store.path)
        with self.assertRaises(OSError):
            self.store.update("design", SELECTION, 1, optional_capable=True)
        self.assertEqual(self.store.path.read_bytes(), original)
        self.store.path.unlink(); self.store.path.symlink_to(backup)
        with self.assertRaises(PolicyError): self.store.read()

    def test_shared_resolution_vectors(self):
        vectors = json.loads((Path(__file__).parent / "fixtures/ach1-resolution.json").read_text())
        for vector in vectors:
            policy = self.store.read()
            for role, state in vector["mappings"].items():
                selection = dict(SELECTION)
                if state.endswith("_unavailable"):
                    selection[{"provider_unavailable": "provider_id", "model_unavailable": "model_id",
                               "variant_unavailable": "variant"}[state]] = "gone"
                policy["profiles"][role] = selection
            catalog = None if vector["catalog"] == "unavailable" else {**CATALOG, "truncated": vector["catalog"] == "incomplete"}
            result = resolve_profile(policy, vector["profile"], catalog)
            for key in ("status", "resolved_profile", "resolution_path"):
                self.assertEqual(result.get(key), vector.get(key), vector)
            self.assertEqual("runtime" in result, vector["status"] == "available")


class HubApiTest(PolicyTest):
    def setUp(self):
        super().setUp()
        self.prior = (server.PROJECT, server.SHARE_ROOT, server.read_catalog)
        server.PROJECT, server.SHARE_ROOT = self.project, Path(self.temp.name)
        server.read_catalog = lambda *args, **kwargs: CATALOG
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.http.server_port}"

    def tearDown(self):
        self.http.shutdown(); self.http.server_close(); self.thread.join()
        server.PROJECT, server.SHARE_ROOT, server.read_catalog = self.prior
        super().tearDown()

    def request(self, selection, revision=0, origin=True, profile="deep"):
        body = json.dumps({"revision": revision, "selection": selection}).encode()
        headers = {"Content-Type": "application/json"}
        if origin: headers["Origin"] = self.base
        request = Request(self.base + f"/api/control/profiles/{profile}", data=body, headers=headers, method="PUT")
        try:
            with urlopen(request, timeout=3) as response:
                return response.status
        except HTTPError as error:
            return error.code

    def test_write_requires_origin_and_available_catalog(self):
        self.assertEqual(self.request(SELECTION, origin=False), 403)
        malicious = Request(self.base + "/api/control/profiles/deep", data=json.dumps({"revision": 0, "selection": SELECTION}).encode(),
                            headers={"Content-Type": "application/json", "Host": "public.example:4187", "Origin": "http://public.example:4187"}, method="PUT")
        with self.assertRaises(HTTPError) as refused:
            urlopen(malicious, timeout=3)
        self.assertEqual(refused.exception.code, 403)
        self.assertEqual(self.request({**SELECTION, "variant": "missing"}), 422)
        self.assertFalse(self.store.path.exists())
        self.assertEqual(self.request(SELECTION), 200)
        self.assertEqual(self.request(SELECTION), 409)
        server.read_catalog = lambda *args, **kwargs: {**CATALOG, "truncated": True}
        self.assertEqual(self.request(SELECTION, revision=1), 503)
        with urlopen(self.base + "/api/control", timeout=3) as response:
            self.assertEqual(json.load(response)["validation"]["deep"], "catalog_incomplete")

    def test_optional_save_requires_live_capability_and_clear_needs_no_catalog(self):
        self.assertEqual(self.request(SELECTION, profile="design"), 409)
        self.assertFalse(self.store.path.exists())
        with patch.object(server, "read_capabilities", return_value=True):
            self.assertEqual(self.request(SELECTION, profile="design"), 200)
        server.read_catalog = lambda *args, **kwargs: None
        self.assertEqual(self.request(None, revision=1, profile="design"), 200)
        self.assertEqual(self.store.read()["schemaVersion"], 2)

    def test_http_format_conflict_and_failed_publication_are_distinct(self):
        self.store.update("deep", SELECTION, 0)
        original = self.store.path.read_bytes()
        with patch("hub.policy.os.replace", side_effect=OSError("publication failed")):
            self.assertEqual(self.request(SELECTION, revision=1), 503)
        self.assertEqual(self.store.path.read_bytes(), original)
        invalid = original.replace(b'"schemaVersion":1', b'"schemaVersion":9')
        self.store.path.write_bytes(invalid)
        self.assertEqual(self.request(SELECTION, revision=1), 409)
        self.assertEqual(self.store.path.read_bytes(), invalid)
        with self.assertRaises(HTTPError) as error: urlopen(self.base + "/api/control", timeout=3)
        self.assertEqual(json.load(error.exception)["code"], "POLICY_FORMAT_UNSUPPORTED")

    def test_private_peer_boundary(self):
        self.assertTrue(server.private_peer("192.168.3.4"))
        self.assertTrue(server.private_peer("100.90.1.2"))
        self.assertFalse(server.private_peer("8.8.8.8"))
        self.assertFalse(server.private_peer("192.0.2.1"))


class CatalogTest(PolicyTest):
    def test_authenticated_mcp_read_checks_project_and_generation(self):
        root = Path(self.temp.name)
        session = root / "sessions/demo.env"
        credential = root / "sessions/demo/mcp/credential"
        credential.parent.mkdir(parents=True)
        credential.write_text("fixture-token\n")
        credential.chmod(0o600)

        class McpFixture(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond({"healthy": True, "project": {"id": "project-hash"}, "generation": "generation"})
            def do_POST(self):
                assert self.headers["X-OCVM-MCP-Token"] == "fixture-token"
                self.respond({"result": {"structuredContent": CATALOG}})
            def respond(self, value):
                data = json.dumps(value).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            def log_message(self, *args): pass

        http = ThreadingHTTPServer(("127.0.0.1", 0), McpFixture)
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        try:
            values = {"SESS_MCP_ENABLED": "1", "SESS_MCP_PORT": str(http.server_port), "SESS_CONTROLLER": "generation"}
            self.assertEqual(read_catalog(root, [(session, values)], "project-hash"), CATALOG)
            self.assertIsNone(read_catalog(root, [(session, values)], "foreign-project"))
            self.assertEqual(mcp_connection(root, [(session, values)], "foreign-project")["state"], "not_ready")
            self.assertFalse(read_capabilities(mcp_connection(root, [(session, values)], "project-hash")))
        finally:
            http.shutdown(); http.server_close(); thread.join()

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / "adapters/mcp/dist/http.js").is_file(),
                         "MCP adapter has not been built in this checkout")
    def test_real_stateless_mcp_transport_returns_catalog(self):
        root = Path(self.temp.name)
        session = root / "sessions/demo.env"
        credential = root / "sessions/demo/mcp/credential"
        credential.parent.mkdir(parents=True)
        credential.write_text("fixture-token\n"); credential.chmod(0o600)
        js = '''import { McpHttpServer } from "./adapters/mcp/dist/http.js";
const runtime = {schema:1,project:process.argv[1],projectHash:"project-hash",projectName:"fixture",
  backendUrl:"http://127.0.0.1:4095",generation:"generation",opencodeVersion:"test",
  listenHost:"127.0.0.1",listenPort:0,credentialFile:"/fixture"};
const gateway = {getSessionRuntimeOptions:async()=>({agents:["build"],...JSON.parse(process.argv[2])})};
const server = new McpHttpServer(runtime,"fixture-token",gateway);
console.log(await server.start());
process.on("SIGTERM",()=>{void server.close().then(()=>process.exit(0));});'''
        process = subprocess.Popen(["node", "--input-type=module", "-e", js, str(self.project), json.dumps(CATALOG)],
                                   cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            port = int(process.stdout.readline().strip())
            values = {"SESS_MCP_ENABLED": "1", "SESS_MCP_PORT": str(port), "SESS_CONTROLLER": "generation"}
            self.assertEqual(read_catalog(root, [(session, values)], "project-hash"), CATALOG)
            self.assertTrue(read_capabilities(mcp_connection(root, [(session, values)], "project-hash")))
        finally:
            process.terminate(); process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
