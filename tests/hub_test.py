#!/usr/bin/env python3
"""Focused guest-runtime and non-exposure checks for the Hub."""

import base64
import hashlib
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import hub.server as server


class HubReadModelTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.share = root / "share"
        self.hub = self.share / "hub"
        self.mcp = self.share / "mcp"
        self.project = root / "project"
        for directory in (self.share, self.hub, self.mcp, self.project):
            directory.mkdir(parents=True, exist_ok=True)
            directory.chmod(0o700)
        (self.mcp / "credential").write_text("fixture-token\n")
        (self.mcp / "credential").chmod(0o600)
        (self.mcp / "tunnel.log").write_text(
            "Authorization: Bearer super-secret-token\napi_key=sk-this-must-not-leak\nhealthy probe failed\n"
        )
        (self.mcp / "tunnel.log").chmod(0o600)
        self.prior = (server.PROJECT, server.SESSION_ROOT, server.RUNTIME, server.AUTH_CREDENTIALS, server.REQUEST_SCHEME)
        self.runtime_path = self.hub / "runtime-input.json"
        self.project_id = hashlib.md5(str(self.project.resolve()).encode()).hexdigest()
        self.write_runtime()
        server.configure_runtime(self.runtime_path, self.project, self.project_id)

    def tearDown(self):
        server.PROJECT, server.SESSION_ROOT, server.RUNTIME, server.AUTH_CREDENTIALS, server.REQUEST_SCHEME = self.prior
        self.temp.cleanup()

    def write_runtime(self, **changes):
        runtime = {
            "schema": 1,
            "projectHash": self.project_id,
            "generation": "fixture-generation",
            "hubPort": 4567,
            "authEnabled": False,
            "auth": None,
            "a2aEnabled": True,
            "tunnelConfigured": True,
            "openliveConfigured": True,
            "mcp": {"enabled": True, "port": 4568, "generation": "fixture-generation"},
        }
        runtime.update(changes)
        self.runtime_path.write_text(json.dumps(runtime))
        self.runtime_path.chmod(0o600)

    def test_runtime_input_is_project_bound_and_private(self):
        self.write_runtime(projectHash="0" * 32)
        with self.assertRaisesRegex(ValueError, "project identity"):
            server.configure_runtime(self.runtime_path, self.project, self.project_id)
        self.write_runtime()
        self.runtime_path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "unavailable"):
            server.configure_runtime(self.runtime_path, self.project, self.project_id)

    def test_runtime_uses_host_project_identity_for_a_guest_mount_path(self):
        guest_mount = Path(self.temp.name) / "guest-mount"
        guest_mount.mkdir()
        server.configure_runtime(self.runtime_path, guest_mount, self.project_id)
        self.assertEqual(server.PROJECT, guest_mount.resolve())
        self.assertEqual(server.project_hash(), self.project_id)

    def test_model_uses_admitted_guest_runtime_and_redacts_logs(self):
        model = server.build_model()
        by_id = {item["id"]: item for item in model["integrations"]}
        self.assertEqual(set(by_id), {"secure-mcp-tunnel", "incoming-mcp", "a2a", "openlive"})
        self.assertTrue(by_id["secure-mcp-tunnel"]["configured"])
        self.assertEqual(by_id["secure-mcp-tunnel"]["state"], "unverified")
        self.assertEqual(by_id["a2a"]["state"], "unverified")
        self.assertEqual(by_id["openlive"]["state"], "unverified")
        encoded = json.dumps(model)
        self.assertNotIn("super-secret-token", encoded)
        self.assertNotIn("sk-this-must-not-leak", encoded)
        self.assertIn("[REDACTED]", encoded)

    def test_mcp_health_ready_is_independent_of_catalog_and_disabled_is_explained(self):
        connection = {"state": "ready", "reason": "project-health", "base": "http://127.0.0.1:4568", "token": "private"}
        with patch.object(server, "mcp_connection", return_value=connection):
            card = next(item for item in server.build_model()["integrations"] if item["id"] == "incoming-mcp")
            self.assertEqual(card["state"], "ready")
            self.assertEqual(card["checkScope"], "local-mcp-health")
        server.RUNTIME["mcp"] = {"enabled": False, "port": 0, "generation": "fixture-generation"}
        card = next(item for item in server.build_model()["integrations"] if item["id"] == "incoming-mcp")
        self.assertEqual(card["state"], "not_ready")
        self.assertIn("--no-mcp", card["statusReason"])

    def test_control_snapshot_reuses_one_health_probe_without_exposing_token(self):
        connection = {"state": "ready", "reason": "verified", "base": "http://127.0.0.1:4568", "token": "PRIVATE-PROBE-TOKEN"}
        with patch.object(server, "mcp_connection", return_value=connection) as probe, \
             patch.object(server, "read_catalog", return_value=None), \
             patch.object(server, "read_capabilities", return_value=False):
            snapshot = server.control_snapshot()
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(next(item for item in snapshot["readModel"]["integrations"] if item["id"] == "incoming-mcp")["state"], "ready")
        self.assertNotIn("PRIVATE-PROBE-TOKEN", json.dumps(snapshot))

    def test_health_is_public_only_to_private_peers_but_api_uses_existing_auth(self):
        password = "two words$#'\""
        self.write_runtime(authEnabled=True, auth={"username": "opencode", "password": password})
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        server.REQUEST_SCHEME = "http"
        http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{http.server_port}"
        try:
            with urlopen(base + "/healthz", timeout=3) as response:
                health = json.load(response)
            self.assertEqual(health["generation"], "fixture-generation")
            with self.assertRaises(HTTPError) as refused:
                urlopen(base + "/api/status", timeout=3)
            self.assertEqual(refused.exception.code, 401)
            token = base64.b64encode(f"opencode:{password}".encode()).decode()
            request = Request(base + "/api/status", headers={"Authorization": "Basic " + token})
            with urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_private_peer_boundary(self):
        self.assertTrue(server.private_peer("192.168.3.4"))
        self.assertTrue(server.private_peer("100.90.1.2"))
        self.assertFalse(server.private_peer("8.8.8.8"))
        self.assertFalse(server.private_peer("192.0.2.1"))


if __name__ == "__main__":
    unittest.main()
