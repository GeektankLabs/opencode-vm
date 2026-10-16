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
        self.prior_env = {key: os.environ.get(key) for key in
                          ("OCVM_ARTIFACT_ROOT", "OCVM_GUEST_STATE_HELPER", "OCVM_MONITOR_STATE_DIR",
                           "OCVM_PROJECT_PATH", "OCVM_PROJ_HASH")}
        os.environ["OCVM_ARTIFACT_ROOT"] = str(root / "artifacts")
        os.environ["OCVM_GUEST_STATE_HELPER"] = str(ROOT / "runtime" / "guest-state.py")
        for key in ("OCVM_MONITOR_STATE_DIR", "OCVM_PROJECT_PATH", "OCVM_PROJ_HASH"):
            os.environ.pop(key, None)
        self.runtime_path = self.hub / "runtime-input.json"
        self.project_id = hashlib.md5(str(self.project.resolve()).encode()).hexdigest()
        self.write_runtime()
        server.configure_runtime(self.runtime_path, self.project, self.project_id)

    def tearDown(self):
        server.PROJECT, server.SESSION_ROOT, server.RUNTIME, server.AUTH_CREDENTIALS, server.REQUEST_SCHEME = self.prior
        for key, value in self.prior_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
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
             patch.object(server, "read_capabilities", return_value=False), \
             patch.object(server, "read_policy_capabilities",
                          return_value={"optionalProfiles": False, "profileFallbacks": False}):
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


class HubMonitorTest(HubReadModelTest):
    def serve(self):
        server.REQUEST_SCHEME = "http"
        http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        return http, thread

    def request(self, base, path, method="GET", payload=None, lan=False):
        headers = {}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if method != "GET" and lan:
            host = f"192.168.16.155:{base.rsplit(':', 1)[1]}"
            headers["Host"] = host
            headers["Origin"] = "http://" + host
        request = Request(base + path, data=json.dumps(payload).encode() if payload is not None else None,
                          method=method, headers=headers)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def test_monitor_roundtrip_cas_actions_and_states(self):
        self.write_runtime(authEnabled=False, auth=None)
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        http, thread = self.serve()
        base = f"http://127.0.0.1:{http.server_port}"
        task = "task_11111111-1111-4111-8111-111111111111"
        try:
            status, created = self.request(base, "/api/monitor", "POST", {
                "title": "Fixture Monitor", "task_id": task}, lan=True)
            self.assertEqual(status, 201)
            monitor = created["monitor"]
            self.assertTrue(monitor["monitor_id"].startswith("monitor_"))
            self.assertTrue(monitor["scheduler"]["enabled"])
            self.assertEqual(monitor["work_state"], "active")
            self.assertEqual(monitor["autonomy_profile"], "mvp")
            self.assertEqual(monitor["runtime_profile"], "deep")
            generation = created["generation"]
            status, listed = self.request(base, "/api/monitor?limit=50")
            self.assertEqual(status, 200)
            self.assertEqual(listed["total"], 1)
            self.assertEqual(listed["completeness"], "complete")
            self.assertEqual(listed["monitors"][0]["anchor_task_id"], task)
            status, updated = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}", "PUT",
                                           {"generation": generation, "interval_seconds": 90}, lan=True)
            self.assertEqual(status, 200)
            self.assertEqual(updated["monitor"]["scheduler"]["interval_seconds"], 90)
            status, conflict = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}", "PUT",
                                            {"generation": generation, "interval_seconds": 30}, lan=True)
            self.assertEqual(status, 409)
            self.assertEqual(conflict["code"], "MONITOR_REVISION_CONFLICT")
            generation = updated["generation"]
            status, disabled = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}/disable", "POST",
                                            {"generation": generation}, lan=True)
            self.assertEqual(status, 200)
            self.assertFalse(disabled["monitor"]["scheduler"]["enabled"])
            self.assertEqual(disabled["monitor"]["work_state"], "active")
            generation = disabled["generation"]
            status, enabled = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}/enable", "POST",
                                           {"generation": generation}, lan=True)
            self.assertEqual(status, 200)
            self.assertTrue(enabled["monitor"]["scheduler"]["enabled"])
            generation = enabled["generation"]
            status, triggered = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}/trigger", "POST",
                                             {"generation": generation}, lan=True)
            self.assertEqual(status, 200)
            generation = triggered["generation"]
            status, abort_requested = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}/abort", "POST",
                                                   {"generation": generation}, lan=True)
            self.assertEqual(status, 200)
            self.assertEqual(abort_requested["state"], "requested")
            status, listed = self.request(base, "/api/monitor?limit=50")
            self.assertTrue(listed["monitors"][0]["abort_requested"])
            generation = abort_requested["generation"]
            monitor_store = sys.modules["hub.monitor"]
            monitor_store.mutate(self.project, lambda registry: registry["monitors"][0]["run"].update({"active": True}))
            status, refused = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}/delete", "POST",
                                           {"generation": None}, lan=True)
            self.assertEqual(status, 409)
            self.assertEqual(refused["code"], "MONITOR_STATE_CONFLICT")
            monitor_store.mutate(self.project, lambda registry: registry["monitors"][0]["run"].update({"active": False}))
            status, deleted = self.request(base, f"/api/monitor/{monitor['monitor_id'][8:]}/delete", "POST",
                                           {"generation": None}, lan=True)
            self.assertEqual(status, 200)
            self.assertTrue(deleted["deleted"])
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_monitor_inventory_pagination_states_and_history(self):
        import hub.monitor as monitor_store
        first = monitor_store.default_monitor("Aktiv", "task_11111111-1111-4111-8111-111111111111", 60, "mvp", "deep", None)
        parked = monitor_store.default_monitor("Parked", "task_22222222-2222-4222-8222-222222222222", 60, "conservative", "deep", None)
        parked["state"]["work"] = "parked_input_required"
        parked["state"]["parked_reason"] = "repair-budget-exhausted"
        disabled = monitor_store.default_monitor("Disabled", "task_33333333-3333-4333-8333-333333333333", 60, "yolo", "standard", None)
        disabled["scheduler"]["enabled"] = False
        monitor_store.mutate(self.project, lambda registry: registry["monitors"].extend([first, parked, disabled]))
        monitor_store.mutate(self.project, lambda registry: monitor_store.history_entry(
            next(item for item in registry["monitors"] if item["id"] == first["id"]), "dispatched",
            {"message_id": "msg_fixture"}))
        self.write_runtime(authEnabled=False, auth=None)
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        http, thread = self.serve()
        base = f"http://127.0.0.1:{http.server_port}"
        try:
            status, page = self.request(base, "/api/monitor?limit=2")
            self.assertEqual(status, 200)
            self.assertEqual(page["total"], 3)
            self.assertEqual(page["completeness"], "paged")
            self.assertEqual(len(page["monitors"]), 2)
            self.assertIn("next_cursor", page)
            status, rest = self.request(base, f"/api/monitor?limit=2&cursor={page['next_cursor']}")
            self.assertEqual(rest["completeness"], "complete")
            self.assertEqual(len(rest["monitors"]), 1)
            states = {item["monitor_id"]: item for item in page["monitors"] + rest["monitors"]}
            self.assertEqual(states[parked["id"]]["work_state"], "parked_input_required")
            self.assertEqual(states[parked["id"]]["parked_reason"], "repair-budget-exhausted")
            self.assertFalse(states[disabled["id"]]["scheduler"]["enabled"])
            self.assertIsNotNone(states[first["id"]]["last_run_at"])
            status, history = self.request(base, f"/api/monitor/{first['id'][8:]}/history?include_logs=1")
            self.assertEqual(status, 200)
            self.assertEqual(history["freshness"], "fresh")
            self.assertEqual(history["coverage"], "complete")
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_monitor_ui_uses_the_canonical_api_only(self):
        index = (ROOT / "hub/index.html").read_text(encoding="utf-8")
        ui = (ROOT / "hub/monitor.js").read_text(encoding="utf-8")
        self.assertIn('id="monitors"', index)
        self.assertIn('/monitor.js', index)
        for marker in ("/api/monitor?limit=", "/api/monitor/candidates", "MONITOR_REVISION_CONFLICT",
                       "generation: snapshot.generation", "Abort angefordert", "monitor-details-refresh"):
            self.assertIn(marker, ui)
        for removed in ("Nächsten Lauf abbrechen", "Laufenden Turn abbrechen", "Speichern (CAS)",
                        "Aktuellen Stand vergleichen"):
            self.assertNotIn(removed, ui, "the contracted UI removal must stay effective")
        self.assertNotIn("localStorage", ui, "no second UI-side registry")

    def test_navigation_runtime_input_is_validated_and_exposed_for_session_links(self):
        import hub.monitor as monitor_store
        monitor = monitor_store.default_monitor("Linked", "task_44444444-4444-4444-8444-444444444444", 60, "mvp", "deep", None)
        monitor["session"] = {"session_id": "ses_link", "title": "Linked", "primed_at": "2026-10-08T00:00:00Z"}
        monitor_store.mutate(self.project, lambda registry: registry["monitors"].append(monitor))
        for invalid in ({"web_port": "4096", "opencode_version": "1.18.34"},
                        {"web_port": 0, "opencode_version": "1.18.34"},
                        {"web_port": 4096, "opencode_version": ""},
                        {"web_port": True, "opencode_version": "1.18.34"}):
            self.write_runtime(authEnabled=False, auth=None, navigation=invalid)
            with self.assertRaisesRegex(ValueError, "navigation"):
                server.configure_runtime(self.runtime_path, self.project, self.project_id)
        self.write_runtime(authEnabled=False, auth=None,
                           navigation={"web_port": 4096, "opencode_version": "1.18.34"})
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        http, thread = self.serve()
        base = f"http://127.0.0.1:{http.server_port}"
        try:
            status, listed = self.request(base, "/api/monitor?limit=50")
            self.assertEqual(status, 200)
            self.assertEqual(listed["navigation"], {"web_port": 4096, "opencode_version": "1.18.34"})
            self.assertEqual(listed["monitors"][0]["session_id"], "ses_link")
        finally:
            http.shutdown()
            http.server_close()
            thread.join()
        # Without navigation the UI has no link target and must not invent one.
        self.write_runtime(authEnabled=False, auth=None)
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        http, thread = self.serve()
        base = f"http://127.0.0.1:{http.server_port}"
        try:
            status, listed = self.request(base, "/api/monitor?limit=50")
            self.assertEqual(status, 200)
            self.assertIsNone(listed["navigation"])
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_monitor_candidates_report_coverage_instead_of_an_empty_list(self):
        import hub.monitor as monitor_store
        bound = monitor_store.default_monitor("Bound", "task_55555555-5555-4555-8555-555555555555", 60, "mvp", "deep", None)
        monitor_store.mutate(self.project, lambda registry: registry["monitors"].append(bound))
        self.write_runtime(authEnabled=False, auth=None)
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        http, thread = self.serve()
        base = f"http://127.0.0.1:{http.server_port}"
        original = server.read_board_tasks
        try:
            server.read_board_tasks = lambda *args, **kwargs: {
                "tasks": [{"task_id": "task_55555555-5555-4555-8555-555555555555", "title": "Bound", "status": "in_progress"},
                          {"task_id": "task_66666666-6666-4666-8666-666666666666", "title": "Open WP", "status": "todo"}],
                "completeness": "partial", "reason": "task-scan-budget", "missing_statuses": ["in_progress"],
                "truncated": False, "scanned": 2}
            status, body = self.request(base, "/api/monitor/candidates")
            self.assertEqual(status, 200)
            self.assertEqual([item["task_id"] for item in body["candidates"]],
                             ["task_66666666-6666-4666-8666-666666666666"], "bound tasks stay excluded")
            self.assertEqual(body["completeness"], "partial")
            self.assertEqual(body["incomplete_reason"], "task-scan-budget")
            self.assertEqual(body["missing_statuses"], ["in_progress"])
            self.assertFalse(body["truncated"])
            server.read_board_tasks = lambda *args, **kwargs: None
            status, body = self.request(base, "/api/monitor/candidates")
            self.assertEqual(status, 503)
            self.assertEqual(body["code"], "MONITOR_CANDIDATES_UNAVAILABLE")
        finally:
            server.read_board_tasks = original
            http.shutdown()
            http.server_close()
            thread.join()

    def test_board_task_read_narrows_on_scan_budget_and_never_fakes_empty(self):
        import hub.catalog as catalog
        calls = []
        declared = {"task_id": "task_77777777-7777-4777-8777-777777777777", "title": "WP", "status": "todo",
                    "documents": [{"role": "concept_plan", "path": "planning/x.md"}]}
        plain = {"task_id": "task_88888888-8888-4888-8888-888888888888", "title": "Ticket", "status": "todo",
                 "documents": []}
        connection = {"state": "ready", "base": "http://127.0.0.1:1", "token": "t"}

        def budget_then_narrowed(url, token, payload=None):
            arguments = payload["params"]["arguments"]
            calls.append(arguments)
            if "status" not in arguments:
                return {"result": {"isError": True, "_meta": {"opencode-vm/error": {"code": "TASK_SEARCH_INCOMPLETE"}}}}
            if arguments["status"] == "todo":
                return {"result": {"structuredContent": {"tasks": [declared, plain]}}}
            return {"result": {"isError": True, "_meta": {"opencode-vm/error": {"code": "TASK_SEARCH_INCOMPLETE"}}}}

        original = catalog._request
        try:
            catalog._request = budget_then_narrowed
            result = catalog.read_board_tasks({"enabled": True}, None, "hash", connection=connection)
            self.assertEqual(calls[0], {"include_terminal": False, "summary": True})
            self.assertEqual(calls[1], {"include_terminal": False, "status": "todo", "summary": True},
                             "the narrowed scan stays on the lean summary projection")
            self.assertEqual(result["completeness"], "partial")
            self.assertEqual(result["reason"], "task-scan-budget")
            self.assertEqual(result["missing_statuses"], ["in_progress"], "an unread status is named, not hidden")
            self.assertEqual([item["task_id"] for item in result["tasks"]], [declared["task_id"]],
                             "only declared tasks are candidates")

            def unavailable(url, token, payload=None):
                raise catalog.CatalogUnavailable("board down")
            catalog._request = unavailable
            self.assertIsNone(catalog.read_board_tasks({"enabled": True}, None, "hash", connection=connection),
                              "an unreadable board is None, never an empty list")

            many = [{**declared, "task_id": f"task_{index:08d}-0000-4000-8000-{index:012d}"} for index in range(60)]
            catalog._request = lambda url, token, payload=None: {"result": {"structuredContent": {"tasks": many}}}
            capped = catalog.read_board_tasks({"enabled": True}, None, "hash", limit=50, connection=connection)
            self.assertTrue(capped["truncated"])
            self.assertEqual(len(capped["tasks"]), 50)
            self.assertEqual(capped["scanned"], 60)
            self.assertEqual(capped["completeness"], "complete")
        finally:
            catalog._request = original


class HubMonitorLogTest(HubMonitorTest):
    """Welle C (be951293 §4.8/§4.9): bounded, safe, redacted diagnosis reads."""

    import hub.monitor as _store

    def seed_monitor(self, base):
        task = "task_11111111-1111-4111-8111-111111111111"
        status, created = self.request(base, "/api/monitor", "POST",
                                       {"title": "Log Monitor", "task_id": task}, lan=True)
        self.assertEqual(status, 201)
        return created["monitor"]["monitor_id"]

    def guest_run_dir(self):
        import hub.monitor as store
        directory = store._guest_directory(self.project, True, "run")
        directory.mkdir(mode=0o700, exist_ok=True)
        return directory

    def guest_heartbeat_path(self):
        import hub.monitor as store
        store._guest_directory(self.project, True)
        return store.registry_directory(self.project) / "heartbeat.json"

    def write_server_log(self, lines, share=None):
        import hub.monitor as store
        directory = self.guest_run_dir()
        directory.chmod(0o700)
        path = directory / "server.log"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        path.chmod(0o600)
        return store

    def start(self):
        self.write_runtime(authEnabled=False, auth=None)
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        http, thread = self.serve()
        return http, thread, f"http://127.0.0.1:{http.server_port}"

    def test_log_api_separates_sources_redacts_and_passes_projection_through(self):
        http, thread, base = self.start()
        import hub.monitor as store
        try:
            monitor_id = self.seed_monitor(base)
            self.write_server_log([
                "[monitor] ready project=x generation=fixture",
                "[monitor] error: Authorization: Bearer topsecretvalue123 api_key=sk-thismaynotleakhere",
            ])
            heartbeat = self.guest_heartbeat_path()
            heartbeat.write_text(json.dumps({"schema": 1, "projectHash": self.project_id,
                                             "generation": "fixture-generation", "pid": 4242,
                                             "at": "2026-10-10T00:00:00.000Z"}) + "\n", encoding="utf-8")
            projection = {"policy_revision": 8, "regime": "per_profile", "entry_profile": "deep",
                          "selected_identity": None, "reason": "chain_exhausted",
                          "candidates": [{"label": "deep.main", "identity": "p/m", "status": "skipped_current_failure"}]}
            def build(registry):
                monitor = registry["monitors"][0]
                monitor["recovery_resolution"] = [projection]
                monitor["recovery_episode"] = {"started_at": "2026-10-10T00:00:00.000Z",
                                               "policy_revision": 8, "attempts": []}
            store.mutate(self.project, build)
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            self.assertEqual(status, 200)
            self.assertEqual(body["completeness"], "complete")
            self.assertTrue(body["observed_at"].endswith("Z"))
            kinds = {source["kind"]: source for source in body["sources"]}
            self.assertEqual(kinds["server_log_tail"]["state"], "ok")
            self.assertEqual(kinds["heartbeat"]["state"], "matching")
            self.assertEqual(kinds["recovery_projection"]["count"], 1)
            text = body["text"]
            for marker in ("Entscheidungslauf", "Operational Logs", "Recovery-Projektion",
                           "Engine-Heartbeat", "Service-Log-Tail"):
                self.assertIn(marker, text)
            self.assertNotIn("topsecretvalue123", json.dumps(body))
            self.assertNotIn("sk-thismaynotleakhere", json.dumps(body))
            self.assertGreaterEqual(body["redacted_lines"], 1)
            # Verbatim engine projection: no Python-side resolution or filtering.
            self.assertEqual(body["recovery_projection"]["resolutions"], [projection])
            self.assertIn("p/m=skipped_current_failure", text)
            self.assertIn("grund=chain_exhausted", text)
        finally:
            http.shutdown(); thread.join(timeout=5)

    def test_log_api_bounds_and_truncation(self):
        http, thread, base = self.start()
        try:
            monitor_id = self.seed_monitor(base)
            lines = [f"line-{index:04d} filler filler filler filler filler" for index in range(1, 3001)]
            self.write_server_log(lines)
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            self.assertEqual(status, 200)
            tail = next(source for source in body["sources"] if source["kind"] == "server_log_tail")
            self.assertEqual(tail["count"], 2000)
            self.assertTrue(tail["truncated"])
            self.assertIn("[GEKÜRZT", body["text"])
            self.assertNotIn("line-0001 ", body["text"])
            self.assertIn("line-3000", body["text"])
            self.assertEqual(body["limits"]["server_log_max_lines"], 2000)
            self.assertEqual(body["limits"]["server_log_max_bytes"], 262144)
            # window_hours is clamped, never unbounded.
            status, wide = self.request(base, f"/api/monitor/{monitor_id[8:]}/log?window_hours=999")
            self.assertEqual(wide["window_hours"], 24)
        finally:
            http.shutdown(); thread.join(timeout=5)

    def test_log_api_window_omits_old_entries_and_reports_partial(self):
        http, thread, base = self.start()
        import hub.monitor as store
        try:
            monitor_id = self.seed_monitor(base)
            def build(registry):
                monitor = registry["monitors"][0]
                monitor["history"] = [{"at": "2026-09-01T00:00:00.000Z", "type": "created"}]
                store.history_entry(monitor, "dispatched", {"action_id": "wake_recent"})
            store.mutate(self.project, build)
            # No server.log at all: honest partial, never "fresh complete".
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            self.assertEqual(status, 200)
            self.assertEqual(body["completeness"], "partial")
            tail = next(source for source in body["sources"] if source["kind"] == "server_log_tail")
            self.assertEqual(tail["state"], "not_configured")
            decisions = next(source for source in body["sources"] if source["kind"] == "registry_history")
            self.assertEqual(decisions["count"], 1)
            self.assertGreaterEqual(decisions["omitted"], 1)
            self.assertIn("wake_recent", body["text"])
            self.assertNotIn('"type": "created"', body["text"])
        finally:
            http.shutdown(); thread.join(timeout=5)

    def test_log_api_unsafe_and_foreign_sources_never_leak(self):
        http, thread, base = self.start()
        import hub.monitor as store
        try:
            monitor_id = self.seed_monitor(base)
            other = Path(self.temp.name) / "foreign-share"
            foreign_directory = other / "monitor"
            foreign_directory.mkdir(parents=True, exist_ok=True)
            foreign_directory.chmod(0o700)
            other.chmod(0o700)
            foreign_log = foreign_directory / "server.log"
            foreign_log.write_text("NEW-SHARE probe line after reconnect\n", encoding="utf-8")
            foreign_log.chmod(0o600)
            # Symlinked tail target fails closed and is never read.
            target = Path(self.temp.name) / "elsewhere.log"
            target.write_text("SYMLINKED secret-token-xyz\n", encoding="utf-8")
            directory = self.guest_run_dir()
            link = directory / "server.log"
            link.symlink_to(target)
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            self.assertEqual(status, 200)
            tail = next(source for source in body["sources"] if source["kind"] == "server_log_tail")
            self.assertEqual(tail["state"], "unsafe")
            self.assertEqual(body["completeness"], "unavailable")
            self.assertNotIn("SYMLINKED", body["text"])
            self.assertNotIn("secret-token-xyz", json.dumps(body))
            # Share switch (reconnect simulation): the tail source is fixed to
            # THIS project's owned guest registry — a foreign project's log is
            # structurally unreachable, even when the informational session
            # share context points at it.
            link.unlink()
            self.write_server_log(["[monitor] project-own line"])
            prior_share = server.SESSION_ROOT
            server.SESSION_ROOT = other
            try:
                status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
                tail = next(source for source in body["sources"] if source["kind"] == "server_log_tail")
                self.assertEqual(tail["state"], "ok")
                self.assertIn("project-own line", body["text"])
                self.assertNotIn("NEW-SHARE", body["text"])
                self.assertEqual(body["source_context"]["share_root"], str(other))
            finally:
                server.SESSION_ROOT = prior_share
            # A heartbeat from a different generation is an honest mismatch.
            heartbeat = self.guest_heartbeat_path()
            heartbeat.write_text(json.dumps({"schema": 1, "projectHash": "0" * 32,
                                             "generation": "other-generation", "pid": 1,
                                             "at": "2026-10-10T00:00:00Z"}) + "\n", encoding="utf-8")
            self.write_server_log(["[monitor] ok"])
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            kinds = {source["kind"]: source for source in body["sources"]}
            self.assertEqual(kinds["heartbeat"]["state"], "mismatch")
            self.assertEqual(body["completeness"], "partial")
            self.assertIn("NICHT PASSEND", body["text"])
        finally:
            http.shutdown(); thread.join(timeout=5)

    def test_log_api_honours_auth_and_registry_errors(self):
        password = "hub-log-pass"
        self.write_runtime(authEnabled=True, auth={"username": "opencode", "password": password})
        server.configure_runtime(self.runtime_path, self.project, self.project_id)
        import hub.monitor as store
        http, thread = self.serve()
        base = f"http://127.0.0.1:{http.server_port}"
        try:
            self.write_server_log(["[monitor] ready"])
            # Unauthenticated reads are refused exactly like every other API path.
            try:
                with urlopen(base + "/api/monitor/0000000000000000000000000000abcd/log", timeout=5) as response:
                    self.fail(f"expected 401, got {response.status}")
            except HTTPError as refused:
                self.assertEqual(refused.code, 401)
            token = base64.b64encode(f"opencode:{password}".encode()).decode()
            request = Request(base + "/api/monitor/0000000000000000000000000000abcd/log",
                              headers={"Authorization": "Basic " + token})
            try:
                with urlopen(request, timeout=5):
                    self.fail("expected 404 for an unknown monitor")
            except HTTPError as missing:
                self.assertEqual(missing.code, 404)
            # A corrupt registry is an honest 503, never a stale success.
            registry_dir = self.guest_run_dir().parent
            registry_dir.mkdir(parents=True, exist_ok=True)
            (registry_dir / "registry.json").write_text("{broken", encoding="utf-8")
            try:
                with urlopen(request, timeout=5):
                    self.fail("expected 503 for an unreadable registry")
            except HTTPError as unavailable:
                self.assertEqual(unavailable.code, 503)
        finally:
            http.shutdown(); thread.join(timeout=5)


    def test_log_api_structured_response_contains_no_secrets_but_keeps_benign_projection(self):
        # QC F-C1: redaction must cover the STRUCTURED copy of the safe answer,
        # not only the text view; legitimate engine data stays byte-identical.
        http, thread, base = self.start()
        import hub.monitor as store
        try:
            monitor_id = self.seed_monitor(base)
            self.write_server_log(["[monitor] ready"])
            leak_label = "deep.ghp_QCLEAKGGHU1234567890abcdefghijk"
            leak_identity = "prov/sk-proj-QCLEAK1234567890abcdefghij"
            benign = {"policy_revision": 8, "regime": "per_profile", "entry_profile": "deep",
                      "selected_identity": None, "reason": "chain_exhausted",
                      "candidates": [{"label": "deep.main", "identity": "prov/skipped_model", "status": "skipped_current_failure"}]}
            def build(registry):
                registry["monitors"][0]["recovery_resolution"] = [{
                    "at": "2026-10-10T00:00:00.000Z", "policy_revision": 8, "regime": "per_profile",
                    "entry_profile": "deep", "selected_identity": leak_identity, "reason": "selected",
                    "candidates": [{"label": leak_label, "identity": leak_identity, "status": "selected"}],
                }]
                registry["monitors"][0]["recovery_episode"] = {
                    "started_at": "2026-10-10T00:00:00.000Z", "policy_revision": 8,
                    "attempts": [{"at": "2026-10-10T00:00:00.000Z", "identity": leak_identity,
                                  "category": "provider_quota", "fingerprint": "f" * 64, "outcome": "dispatched"}],
                }
                registry["monitors"][0]["history"] = [
                    {"at": "2026-10-10T00:00:00.000Z", "type": "recovery-resolved",
                     "detail": {"selected": leak_identity, "note": "ghp_QCLEAKSECONDARY0123456789abcdefgh"}},
                ]
            store.mutate(self.project, build)
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            self.assertEqual(status, 200)
            serialised = json.dumps(body)
            self.assertNotIn("QCLEAK", serialised, "full JSON response must not carry synthetic secrets")
            self.assertNotIn("ghp_", serialised)
            self.assertNotIn("sk-proj-", serialised)
            self.assertIn("[REDACTED]", body["text"])
            structured = json.dumps(body["recovery_projection"])
            self.assertIn("[REDACTED]", structured)
            # Benign engine projection passes through byte-identical (no recomputation).
            def benign_build(registry):
                registry["monitors"][0]["recovery_resolution"] = [benign]
                registry["monitors"][0]["recovery_episode"] = None
                registry["monitors"][0]["history"] = []
            store.mutate(self.project, benign_build)
            status, clean = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            self.assertEqual(clean["recovery_projection"]["resolutions"], [benign])
            self.assertIn("prov/skipped_model=skipped_current_failure", clean["text"])
            self.assertIn("prov/skipped_model", json.dumps(clean["recovery_projection"]))
        finally:
            http.shutdown(); thread.join(timeout=5)

    def test_log_api_oversized_single_line_is_truncated_never_empty(self):
        # QC F-C3: >bound single line (with and without trailing newline) must be
        # an honest truncated_only/partial state; an empty file stays "empty".
        http, thread, base = self.start()
        try:
            monitor_id = self.seed_monitor(base)
            directory = self.guest_run_dir()
            path = directory / "server.log"
            huge = "x" * (400 * 1024)
            for case, content in (("no-newline", huge), ("with-newline", huge + "\n")):
                path.write_text(content, encoding="utf-8")
                path.chmod(0o600)
                status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
                self.assertEqual(status, 200, case)
                tail = next(source for source in body["sources"] if source["kind"] == "server_log_tail")
                self.assertEqual(tail["state"], "truncated_only", case)
                self.assertTrue(tail["truncated"], case)
                self.assertNotEqual(body["completeness"], "complete", case)
                self.assertIn("TRUNKIERT", body["text"], case)
                self.assertNotIn("Datei vorhanden, ohne nicht-leere Inhaltzeile", body["text"], case)
                self.assertNotIn(huge[:100], body["text"], case)
            # Control: a big but in-bounds single line (100 KiB) stays readable.
            path.write_text("y" * (100 * 1024) + "\n", encoding="utf-8")
            path.chmod(0o600)
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            tail = next(source for source in body["sources"] if source["kind"] == "server_log_tail")
            self.assertEqual(tail["state"], "ok")
            self.assertFalse(tail["truncated"], "in-bounds byte window is not truncated")
            marker_line = next(line for line in body["text"].splitlines() if line.startswith("yyy"))
            self.assertLess(len(marker_line), 1500, "single oversized line stays display-bounded")
            # Control: genuinely empty file remains honest "empty" (complete-neutral).
            path.write_text("", encoding="utf-8")
            status, body = self.request(base, f"/api/monitor/{monitor_id[8:]}/log")
            tail = next(source for source in body["sources"] if source["kind"] == "server_log_tail")
            self.assertEqual(tail["state"], "empty")
            self.assertIn("ohne nicht-leere Inhaltzeile", body["text"])
        finally:
            http.shutdown(); thread.join(timeout=5)
    def test_hub_writer_preserves_engine_additive_recovery_fields(self):
        # Welle D (§8 risk 6 rollback-safety, both-writer round-trip): a Hub
        # mutation (PUT via the CAS writer) must not lose the additive engine
        # fields recovery_episode / recovery_resolution / worker last_error.
        http, thread, base = self.start()
        import hub.monitor as store
        try:
            monitor_id = self.seed_monitor(base)
            episode = {"started_at": "2026-10-10T00:00:00.000Z", "policy_revision": 12,
                       "attempts": [{"at": "2026-10-10T00:00:00.000Z", "identity": "p/m",
                                     "category": "provider_quota", "fingerprint": "a" * 64,
                                     "outcome": "dispatched"}]}
            resolution = {"at": "2026-10-10T00:00:00.000Z", "policy_revision": 12, "regime": "per_profile",
                          "entry_profile": "deep", "selected_identity": "p/m", "reason": "selected",
                          "candidates": [{"label": "deep.main", "identity": "p/m", "status": "selected"}]}
            def build(registry):
                monitor = registry["monitors"][0]
                monitor["recovery_episode"] = episode
                monitor["recovery_resolution"] = [resolution]
                monitor["workers"] = [{
                    "worker_key": "worker_" + "a" * 32, "alias": "M1-A", "monitor_id": monitor["id"],
                    "manager_alias": "M1", "creator_manager_session_id": None, "created_at": "2026-10-10T00:00:00.000Z",
                    "runtime_session_id": "ses_w", "creation_receipt": "msg_c", "dispatch_receipt": "msg_d",
                    "result_receipt": "msg_r", "scope": None, "worktree": None, "task_id": None,
                    "context_path": "/tmp/x.md", "lifecycle": "idle", "last_synthesis_at": None,
                    "updated_at": "2026-10-10T00:00:00.000Z",
                    "last_error": {"at": "2026-10-10T00:00:00.000Z", "category": "provider_timeout",
                                   "fingerprint": "b" * 64, "receipt": "msg_r"},
                }]
            store.mutate(self.project, build)
            before = store.snapshot(self.project)["monitors"][0]
            _, updated = self.request(base, f"/api/monitor/{monitor_id[8:]}", "PUT",
                                      {"generation": store.snapshot(self.project)["generation"], "interval_seconds": 90}, lan=True)
            self.assertEqual(updated["monitor"]["scheduler"]["interval_seconds"], 90)
            after = store.snapshot(self.project)["monitors"][0]
            self.assertEqual(after["recovery_episode"], before["recovery_episode"], "hub writer preserves the episode")
            self.assertEqual(after["recovery_resolution"], before["recovery_resolution"], "hub writer preserves the resolution projection")
            self.assertEqual(after["workers"][0]["last_error"], before["workers"][0]["last_error"], "hub writer preserves the worker marker")
        finally:
            http.shutdown(); thread.join(timeout=5)

if __name__ == "__main__":
    unittest.main()
