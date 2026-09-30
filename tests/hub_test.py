#!/usr/bin/env python3
"""Focused read-model and non-exposure tests for the standalone hub."""

import json
import tempfile
import unittest
from unittest.mock import patch
import subprocess
from pathlib import Path

import hub.server as server


class HubReadModelTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / "mcp-tunnel/openai").mkdir(parents=True)
        (root / "sessions/demo/mcp").mkdir(parents=True)
        (root / "sessions/demo").mkdir(exist_ok=True)
        self.project = root / "project"
        self.project.mkdir()
        (root / "mcp-tunnel/openai/registry.json").write_text(json.dumps({"projects": {"p": {"id": "p", "path": str(self.project), "keyId": "key_private", "tunnelId": "tunnel_0123456789abcdef0123456789abcdef"}}}))
        (root / "sessions/demo.env").write_text(f'SESS_PROJ="{self.project}"\nSESS_NAME="oc-demo"\nSESS_MODE="web"\nSESS_PORT="4555"\nSESS_MCP_ENABLED="1"\nSESS_MCP_PORT="4556"\n')
        (root / "sessions/demo/auth.env").write_text('OPENCODE_SERVER_PASSWORD="super-secret-token"\n')
        (root / "sessions/demo/mcp/runtime.json").write_text(json.dumps({"connected": False, "tunnelId": "tunnel_0123456789abcdef0123456789abcdef"}))
        (root / "sessions/demo/mcp/tunnel.log").write_text("Authorization: Bearer super-secret-token\napi_key=sk-this-must-not-leak\nhealthy probe failed\n")
        self.old = (server.SHARE_ROOT, server.PROJECT)
        server.SHARE_ROOT = root
        server.PROJECT = self.project

    def tearDown(self):
        server.SHARE_ROOT, server.PROJECT = self.old
        self.temp.cleanup()

    def test_configuration_and_runtime_are_separate(self):
        model = server.build_model()
        tunnel = next(item for item in model["integrations"] if item["id"] == "secure-mcp-tunnel")
        self.assertTrue(tunnel["configured"])
        self.assertNotEqual(tunnel["healthStatus"], "active/healthy")
        self.assertEqual(tunnel["runtimeStatus"], "unknown/stale")

    def test_logs_are_bounded_and_secret_free(self):
        model = server.build_model()
        encoded = json.dumps(model)
        self.assertNotIn("super-secret-token", encoded)
        self.assertNotIn("sk-this-must-not-leak", encoded)
        self.assertIn("[REDACTED]", encoded)

    def test_no_assignment_means_no_fake_active_card(self):
        registry = server.SHARE_ROOT / "mcp-tunnel/openai/registry.json"
        registry.write_text(json.dumps({"projects": {}}))
        model = server.build_model()
        tunnel = next(item for item in model["integrations"] if item["id"] == "secure-mcp-tunnel")
        self.assertFalse(tunnel["configured"])
        self.assertEqual(tunnel["state"], "not_configured")
        self.assertEqual(len(model["integrations"]), 4)
        self.assertTrue(model["setupGuides"])

    def test_lm_studio_guide_uses_native_provider_and_default_forward(self):
        model = server.build_model()
        guide = next(item for item in model["setupGuides"] if item["id"] == "lm-studio")
        text = " ".join(guide["steps"])
        self.assertIn("bereits erlaubt", text)
        self.assertIn("opencode-vm ports host add 1234", text)
        self.assertIn("native", text)
        self.assertIn("localhost:1234", text)
        self.assertIn("alle VMs", text)
        self.assertEqual(guide["docs"], "README.md#network-policy-commands")

    def test_invalid_registry_is_unverified_and_markers_never_prove_ready(self):
        registry = server.SHARE_ROOT / "mcp-tunnel/openai/registry.json"
        registry.write_text("invalid")
        model = server.build_model()
        self.assertIsNone(model["integrations"][0]["configured"])
        self.assertEqual(model["integrations"][0]["state"], "unverified")
        registry.write_text(json.dumps({"projects": {"p": {"path": str(self.project)}, "q": {"path": str(self.project)}}}))
        self.assertIsNone(server.build_model()["integrations"][0]["configured"])
        registry.write_text(json.dumps({"projects": {"p": {"path": str(self.project)}}}))
        (server.SHARE_ROOT / "sessions/demo/mcp/runtime.json").write_text('{"connected":true}')
        bridge = server.SHARE_ROOT / "openlive/bin/opencode"
        bridge.parent.mkdir(parents=True); bridge.write_text("shim")
        runtime = server.SHARE_ROOT / "sessions/demo/openlive/runtime.json"
        runtime.parent.mkdir(); runtime.write_text('{"pid":123}')
        with patch.object(server, "vm_running", return_value=True), patch.object(server, "probe_port", return_value=True):
            model = server.build_model()
        for name in ("secure-mcp-tunnel", "openlive", "incoming-mcp"):
            item = next(item for item in model["integrations"] if item["id"] == name)
            self.assertNotEqual(item["state"], "ready")

    def test_verified_stop_and_unknown_lima_are_distinct(self):
        with patch.object(server.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "failed")):
            self.assertIsNone(server.vm_running("demo"))
        with patch.object(server.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "stopped", "")):
            self.assertFalse(server.vm_running("demo"))
            self.assertEqual(server.build_model()["integrations"][0]["state"], "not_ready")

    def test_mcp_health_ready_is_independent_of_catalog_and_no_mcp_is_explained(self):
        with patch.object(server, "mcp_connection", return_value={"state": "ready", "reason": "project-health"}):
            card = next(item for item in server.build_model()["integrations"] if item["id"] == "incoming-mcp")
            self.assertEqual(card["state"], "ready")
            self.assertEqual(card["checkScope"], "local-mcp-health")
        env = server.SHARE_ROOT / "sessions/demo.env"
        env.write_text(env.read_text().replace('SESS_MCP_ENABLED="1"', 'SESS_MCP_ENABLED="0"'))
        card = next(item for item in server.build_model()["integrations"] if item["id"] == "incoming-mcp")
        self.assertEqual(card["state"], "not_ready")
        self.assertIn("--no-mcp", card["statusReason"])
        self.assertEqual(card["checkScope"], "configuration-only")

    def test_control_snapshot_reuses_single_health_probe_without_exposing_token(self):
        with patch.object(server, "mcp_connection", return_value={"state": "ready", "reason": "verified", "token": "PRIVATE-PROBE-TOKEN"}) as probe, \
             patch.object(server, "read_catalog", return_value=None), patch.object(server, "read_capabilities", return_value=False):
            snapshot = server.control_snapshot()
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(next(item for item in snapshot["readModel"]["integrations"] if item["id"] == "incoming-mcp")["state"], "ready")
        self.assertNotIn("PRIVATE-PROBE-TOKEN", json.dumps(snapshot))

    def test_a2a_body_and_effective_url_are_validated_no_task_probe(self):
        card = {"supportedInterfaces": [{"protocolBinding": "JSONRPC", "url": "http://127.0.0.1:4999"}]}
        for body, expected in (({"status": "ok", "service": "other"}, "not_ready"),
                               ({"status": "ok", "service": "opencode-a2a"}, "ready")):
            calls = []
            def probe(url, secret=None):
                calls.append((url, secret)); return (True, body if secret else card)
            with patch.object(server, "probe_http", side_effect=probe):
                item = next(item for item in server.build_model()["integrations"] if item["id"] == "a2a")
            self.assertEqual(item["state"], expected)
            self.assertEqual(calls[-1][0], "http://127.0.0.1:4999/health")
            self.assertEqual(len(calls), 2)
        with patch.object(server, "probe_http", return_value=(True, {"supportedInterfaces": []})):
            item = next(item for item in server.build_model()["integrations"] if item["id"] == "a2a")
            self.assertEqual(item["state"], "unverified")


if __name__ == "__main__":
    unittest.main()
