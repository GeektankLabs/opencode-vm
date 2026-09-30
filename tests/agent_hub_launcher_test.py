#!/usr/bin/env python3
"""Host Hub lifecycle and embedded launcher contract checks."""

import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "opencode-vm.sh").read_text()


class AgentHubLauncherTest(unittest.TestCase):
    def test_hub_skips_an_occupied_port_and_stops_only_its_own_process(self):
        def extract(name):
            match = re.search(rf"(?m)^{name}\(\) \{{\n.*?^\}}$", SCRIPT, re.S | re.M)
            self.assertIsNotNone(match, name)
            return match.group(0)

        with tempfile.TemporaryDirectory() as temporary, socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen(1)
            port = occupied.getsockname()[1]
            project = Path(temporary) / "project"
            project.mkdir()
            project_hash = hashlib.md5(os.fsencode(project)).hexdigest()
            share = Path(temporary) / "sessions" / project_hash
            script = "\n".join(extract(name) for name in (
                "agent_hub_source_dir", "agent_hub_runtime_path", "agent_hub_stop",
                "agent_hub_health", "agent_hub_start"))
            hub_sha = re.search(r'^HUB_ASSET_SHA256="([^"]+)"', SCRIPT, re.M)[1]
            version = re.search(r'^OCVM_VERSION="([^"]+)"', SCRIPT, re.M)[1]
            code = f"""set -euo pipefail
SCRIPT_DIR={shlex.quote(str(ROOT))}
SHARE_ROOT={shlex.quote(temporary)}
AGENT_HUB_PORT={port}
HUB_ASSET_SHA256={hub_sha}
OCVM_VERSION={version}
proj_hash() {{ python3 -c 'import hashlib,os,sys; print(hashlib.md5(os.fsencode(sys.argv[1])).hexdigest())' "$1"; }}
{script}
share={shlex.quote(str(share))}
project={shlex.quote(str(project))}
trap 'agent_hub_stop "$share"' EXIT
agent_hub_start "$share" "$project"
python3 -c 'import json,sys,urllib.request; d=json.load(open(sys.argv[1])); h=json.load(urllib.request.urlopen("http://127.0.0.1:"+str(d["hubPort"])+"/healthz")); print(json.dumps({{"runtime":d,"health":h}}))' "$share/hub/runtime.json"
"""
            result = subprocess.run(["bash", "-c", code], text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            observed = json.loads(result.stdout)
            self.assertEqual(observed["runtime"]["hubPort"], port + 1)
            self.assertEqual(observed["runtime"]["projectHash"], project_hash)
            self.assertEqual(observed["health"]["projectHash"], project_hash)
            with socket.socket() as probe:
                self.assertEqual(probe.connect_ex(("127.0.0.1", port)), 0)
            with socket.socket() as probe:
                self.assertNotEqual(probe.connect_ex(("127.0.0.1", port + 1)), 0)

    def test_registry_uses_bounded_private_network_ports_and_expected_label(self):
        self.assertIn('"id": "agent-hub"', SCRIPT)
        self.assertIn('"label": "Agent Control"', SCRIPT)
        self.assertIn('"port_min": 4180', SCRIPT)
        self.assertIn('"port_max": 4199', SCRIPT)
        self.assertIn('"health_path": "/healthz"', SCRIPT)
        self.assertIn('--host 0.0.0.0 --port "$port"', SCRIPT)
        self.assertIn('.readOnly == false', SCRIPT)

    def test_readiness_requires_fresh_heartbeat(self):
        self.assertIn('"heartbeat_max_age": 3', SCRIPT)
        self.assertIn('runtime.get("ready") is not True', SCRIPT)
        self.assertIn('agent_hub_health "$port" "$hash"', SCRIPT)
        self.assertIn('.projectHash == $hash', SCRIPT)
        self.assertIn('WEB_BASE_PORT = LISTEN_PORT - 1', SCRIPT)

    def test_web_start_and_cleanup_own_the_hub_lifecycle(self):
        self.assertIn('agent_hub_start "$sess_share" "$proj" || true', SCRIPT)
        self.assertIn('agent_hub_stop "$sess_share" || true', SCRIPT)
        self.assertIn('agent_hub_stop "${_ATTACH_HUB_SHARE:-}" || true', SCRIPT)


if __name__ == "__main__":
    unittest.main()
