#!/usr/bin/env python3
"""Focused guest-runtime and non-exposure checks for the Hub."""

import base64
import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import hub.server as server

ROOT = Path(__file__).resolve().parents[1]


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

    def test_unauthenticated_mode_serves_reads_and_control_writes_for_lan_host(self):
        # --no-auth sessions must be fully functional over the LAN forward:
        # assets, status reads and existing PUT control writes without login.
        # The LAN browser's Host/Origin pair is reproduced against the loopback
        # server; the forward is what carries these headers in production.
        self.write_runtime(authEnabled=False, auth=None)
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        server.REQUEST_SCHEME = "http"
        http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{http.server_port}"
        lan_host = f"192.168.16.155:{http.server_port}"
        try:
            with urlopen(base + "/", timeout=3) as response:
                self.assertEqual(response.status, 200)
            with urlopen(base + "/api/status", timeout=3) as response:
                self.assertEqual(json.load(response)["schema"], 2)
            policy = server.PolicyStore(self.project).read()
            body = json.dumps({"revision": policy["revision"], "selection": None}).encode()
            request = Request(base + "/api/control/profiles/standard", data=body, method="PUT",
                              headers={"Content-Type": "application/json", "Host": lan_host,
                                       "Origin": "http://" + lan_host})
            with urlopen(request, timeout=3) as response:
                self.assertEqual(response.status, 200)
                updated = json.load(response)
            self.assertEqual(updated["policy"]["revision"], policy["revision"] + 1)
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_private_peer_boundary(self):
        self.assertTrue(server.private_peer("192.168.3.4"))
        self.assertTrue(server.private_peer("100.90.1.2"))
        self.assertFalse(server.private_peer("8.8.8.8"))
        self.assertFalse(server.private_peer("192.0.2.1"))


class HubRealTLSTest(unittest.TestCase):
    def test_silent_tcp_client_cannot_stall_threaded_tls_health(self):
        # The handshake must run in the per-connection thread. Wrapping the
        # listening socket instead would let one client that opens a socket and
        # then says nothing block every other connection, including /healthz.
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            share = root / "share"
            hub = share / "hub"
            hub.mkdir(parents=True, mode=0o700)
            share.chmod(0o700)
            project = root / "project"
            project.mkdir()
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            project_hash = hashlib.md5(os.fsencode(project.resolve())).hexdigest()
            runtime = {"schema": 1, "projectHash": project_hash, "generation": "tls-regression",
                       "hubPort": port, "authEnabled": False, "auth": None, "a2aEnabled": False,
                       "tunnelConfigured": False, "openliveConfigured": False,
                       "mcp": {"enabled": False, "port": 0, "generation": "tls-regression"}}
            runtime_path = hub / "runtime-input.json"
            runtime_path.write_text(json.dumps(runtime))
            runtime_path.chmod(0o600)
            cert, key = root / "cert.pem", root / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", "/CN=localhost", "-keyout", str(key), "-out", str(cert)],
                           check=True, capture_output=True)
            process = subprocess.Popen(
                [sys.executable, "-B", str(ROOT / "hub/server.py"), "--port", str(port),
                 "--project", str(project), "--project-hash", project_hash,
                 "--runtime-input", str(runtime_path), "--tls-cert", str(cert), "--tls-key", str(key)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            context = ssl._create_unverified_context()
            base = f"https://127.0.0.1:{port}"
            raw = None
            try:
                for _ in range(100):
                    try:
                        with urlopen(base + "/healthz", context=context, timeout=0.5) as response:
                            health = json.load(response)
                        break
                    except (OSError, URLError):
                        time.sleep(0.05)
                else:
                    self.fail("TLS Hub did not become ready")
                self.assertEqual(health["generation"], "tls-regression")
                raw = socket.create_connection(("127.0.0.1", port), timeout=2)
                time.sleep(0.15)
                with urlopen(base + "/healthz", context=context, timeout=2) as response:
                    self.assertEqual(response.status, 200)
                self.assertIsNone(process.poll())
                raw.close()
                raw = None
                with urlopen(base + "/healthz", context=context, timeout=2) as response:
                    self.assertEqual(response.status, 200)
            finally:
                if raw:
                    raw.close()
                process.terminate()
                process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
