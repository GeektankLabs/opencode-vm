#!/usr/bin/env python3
"""Focused read-model and non-exposure tests for the standalone hub."""

import json
import tempfile
import unittest
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
        self.assertFalse(any(item["id"] == "secure-mcp-tunnel" for item in model["integrations"]))
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


if __name__ == "__main__":
    unittest.main()
