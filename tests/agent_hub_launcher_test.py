#!/usr/bin/env python3
"""Guest Hub lifecycle and embedded launcher contract checks."""

import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "opencode-vm.sh").read_text()


def function(name):
    match = re.search(r"^" + re.escape(name) + r"\(\) \{\n.*?^\}", SCRIPT, re.M | re.S)
    if not match:
        raise AssertionError(f"missing shell function: {name}")
    return match.group()


def shell(code, *args, check=True):
    result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + code, "test", *map(str, args)],
                            text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(f"Shell exited {result.returncode}:\n{result.stdout}\n{result.stderr}")
    return result


class AgentHubLauncherTest(unittest.TestCase):
    def test_host_only_stages_verified_assets(self):
        hub_sha = re.search(r'^HUB_ASSET_SHA256="([^"]+)"', SCRIPT, re.M)[1]
        code = '\n'.join(function(name) for name in ("agent_hub_source_dir", "legacy_hub_process_matches", "agent_hub_retire_legacy",
                                                     "_hub_file_sha256", "_hub_write_manifest", "_agent_hub_verify_manifest",
                                                     "agent_hub_stage_assets"))
        code += f'''\nSCRIPT_DIR={str(ROOT)!r}
SHARE_ROOT="$1/state"
HUB_ASSET_SHA256={hub_sha!r}
OCVM_VERSION=fixture
mkdir -p "$1/share"
agent_hub_stage_assets "$1/share"
stat -c %a "$1/share" | grep -qx 700
test -d "$1/share/hub/assets-$HUB_ASSET_SHA256"
test "$(cat "$1/share/hub/assets-$HUB_ASSET_SHA256/.sha256")" = "$HUB_ASSET_SHA256"
stat -c %a "$1/share/hub" | grep -qx 700
stat -c %a "$1/share/hub/assets-$HUB_ASSET_SHA256/server.py" | grep -qx 600
stat -c %a "$1/share/hub/assets-$HUB_ASSET_SHA256/.files.sha256" | grep -qx 600
_agent_hub_verify_manifest "$1/share/hub/assets-$HUB_ASSET_SHA256"
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)
        self.assertIn("agent_hub_stage_assets", SCRIPT)
        self.assertNotIn("agent_hub_start", SCRIPT)
        self.assertNotIn("agent_hub_health", SCRIPT)
        self.assertNotIn("agent_hub_stop", SCRIPT)

    def test_legacy_host_hub_is_retired_before_guest_assets_are_staged(self):
        hub_sha = re.search(r'^HUB_ASSET_SHA256="([^"]+)"', SCRIPT, re.M)[1]
        names = ("agent_hub_source_dir", "legacy_hub_process_matches", "agent_hub_retire_legacy",
                 "_hub_file_sha256", "_hub_write_manifest", "_agent_hub_verify_manifest", "agent_hub_stage_assets")
        code = '\n'.join(function(name) for name in names)
        code += f'''\nSCRIPT_DIR={str(ROOT)!r}
SHARE_ROOT="$1/state"
HUB_ASSET_SHA256={hub_sha!r}
OCVM_VERSION=fixture
share="$1/0123456789abcdef0123456789abcdef"
mkdir -p "$share/hub"
printf '%s\\n' 123 > "$share/hub/server.pid"
printf '%s\\n' 456 > "$share/hub/watcher.pid"
printf '%s\\n' '{{"schema":1,"projectHash":"0123456789abcdef0123456789abcdef"}}' > "$share/hub/runtime.json"
server_alive=1
watcher_alive=1
ps() {{ printf '%s\\n' 'python3 /tmp/hub/server.py --host 0.0.0.0 --port 4180 --project-hash 0123456789abcdef0123456789abcdef'; }}
kill() {{
  case "$1" in
    -0) [[ "$2" == 123 && "$server_alive" == 1 ]] || [[ "$2" == 456 && "$watcher_alive" == 1 ]] ;;
    123|-KILL) server_alive=0; watcher_alive=0 ;;
  esac
}}
sleep() {{ :; }}
agent_hub_stage_assets "$share"
test ! -e "$share/hub/server.pid"
test ! -e "$share/hub/watcher.pid"
test ! -e "$share/hub/runtime.json"
test -d "$share/hub/assets-$HUB_ASSET_SHA256"
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)

    def test_legacy_cleanup_refuses_an_unverified_pid(self):
        code = '\n'.join(function(name) for name in ("legacy_hub_process_matches", "agent_hub_retire_legacy"))
        code += '''\nshare="$1/0123456789abcdef0123456789abcdef"
mkdir -p "$share/hub"
printf '%s\\n' 123 > "$share/hub/server.pid"
ps() { printf '%s\\n' 'python3 /tmp/other.py'; }
kill() { [ "$1" = -0 ] && return 0; exit 99; }
        if agent_hub_retire_legacy "$share"; then exit 1; fi
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)

    def test_legacy_cleanup_rejects_invalid_watcher_before_any_signal(self):
        code = '\n'.join(function(name) for name in ("legacy_hub_process_matches", "agent_hub_retire_legacy"))
        code += '''\nshare="$1/0123456789abcdef0123456789abcdef"
mkdir -p "$share/hub"
printf '%s\\n' 123 > "$share/hub/server.pid"
printf '%s\\n' invalid > "$share/hub/watcher.pid"
ps() { printf '%s\\n' 'python3 /tmp/hub/server.py --host 0.0.0.0 --port 4180 --project-hash 0123456789abcdef0123456789abcdef'; }
kill() { if [[ "$1" == -0 ]]; then return 0; fi; printf '%s\\n' "$*" >> "$share/signals"; }
sleep() { :; }
if agent_hub_retire_legacy "$share"; then exit 1; fi
test ! -e "$share/signals"
test -e "$share/hub/server.pid"
test -e "$share/hub/watcher.pid"
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)

    def test_legacy_process_match_requires_exact_full_tokens(self):
        code = function("legacy_hub_process_matches") + '''
ps() { printf '%s\\n' "$PS_COMMAND"; }
PS_COMMAND='python3 /tmp/hub/server.py --host 0.0.0.0 --port 4180 --project-hash 0123456789abcdef0123456789abcdefDIFFERENT'
if legacy_hub_process_matches 123 0123456789abcdef0123456789abcdef; then exit 1; fi
PS_COMMAND='python3 /tmp/hub/server.pyx --host 0.0.0.0 --project-hash 0123456789abcdef0123456789abcdef'
if legacy_hub_process_matches 123 0123456789abcdef0123456789abcdef; then exit 1; fi
PS_COMMAND='python3 /tmp/otherhub/server.py --host 0.0.0.0 --project-hash 0123456789abcdef0123456789abcdef'
if legacy_hub_process_matches 123 0123456789abcdef0123456789abcdef; then exit 1; fi
PS_COMMAND='python3 /tmp/hub/server.py --host 0.0.0.01 --project-hash 0123456789abcdef0123456789abcdef'
if legacy_hub_process_matches 123 0123456789abcdef0123456789abcdef; then exit 1; fi
PS_COMMAND='python3 /tmp/hub/server.py --host 0.0.0.0 --project-hash 0123456789abcdef0123456789abcdef --extra'
legacy_hub_process_matches 123 0123456789abcdef0123456789abcdef
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)

    def test_corrupted_staged_assets_are_restaged_not_reused(self):
        hub_sha = re.search(r'^HUB_ASSET_SHA256="([^"]+)"', SCRIPT, re.M)[1]
        names = ("agent_hub_source_dir", "legacy_hub_process_matches", "agent_hub_retire_legacy",
                 "_hub_file_sha256", "_hub_write_manifest", "_agent_hub_verify_manifest", "agent_hub_stage_assets")
        code = '\n'.join(function(name) for name in names)
        code += f'''\nSCRIPT_DIR={str(ROOT)!r}
SHARE_ROOT="$1/state"
HUB_ASSET_SHA256={hub_sha!r}
OCVM_VERSION=fixture
mkdir -p "$1/share"
agent_hub_stage_assets "$1/share"
target="$1/share/hub/assets-$HUB_ASSET_SHA256"
printf '%s\\n' 'corrupted non-Python content' > "$target/server.py"
if _agent_hub_verify_manifest "$target"; then exit 1; fi
agent_hub_stage_assets "$1/share"
cmp -s "$target/server.py" "$SCRIPT_DIR/hub/server.py"
_agent_hub_verify_manifest "$target"
printf '%s\\n' 'bogus' > "$target/.files.sha256"
if _agent_hub_verify_manifest "$target"; then exit 1; fi
agent_hub_stage_assets "$1/share"
_agent_hub_verify_manifest "$target"
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)

    def test_guest_service_publishes_generation_bound_runtime_after_tls_health(self):
        hub_sha = re.search(r'^HUB_ASSET_SHA256="([^"]+)"', SCRIPT, re.M)[1]
        names = ("agent_hub_source_dir", "legacy_hub_process_matches", "agent_hub_retire_legacy",
                 "_hub_file_sha256", "_hub_write_manifest", "_agent_hub_verify_manifest", "agent_hub_stage_assets",
                 "load_session_auth", "hub_runtime_dir", "hub_unit_description",
                 "hub_remove_current_file", "hub_failure", "hub_prepare_runtime", "stop_hub", "hub_health",
                 "hub_verify_assets", "start_hub")
        code = '\n'.join(function(name) for name in names)
        code += f'''\nSCRIPT_DIR={str(ROOT)!r}
SHARE_ROOT="$1/state"
HUB_ASSET_SHA256={hub_sha!r}
OCVM_VERSION=fixture
SESS_SHARE="$1/share"
PROJ_DIR="$1/project"
mkdir -p "$SESS_SHARE" "$PROJ_DIR"
agent_hub_stage_assets "$SESS_SHARE"
printf '%s\n' 'OPENCODE_SERVER_USERNAME=opencode' 'OPENCODE_SERVER_PASSWORD=two\\ words\\$#' > "$SESS_SHARE/auth.env"
chmod 600 "$SESS_SHARE/auth.env"
OC_HUB_ENABLED=1
OC_HUB_ASSET_DIR="$SESS_SHARE/hub/assets-$HUB_ASSET_SHA256"
OC_HUB_GENERATION=generation
OC_OPENLIVE_PROJECT_HASH=0123456789abcdef0123456789abcdef
OC_PORT=4096
OC_MCP_ENABLED=0
OC_MCP_PORT=40960
OC_A2A=1
ensure_web_tls() {{ OC_SCHEME=https; OC_TLS_CERT=cert.pem; OC_TLS_KEY=key.pem; }}
ss() {{ return 1; }}
systemctl() {{
  case "$1" in
    show) printf '%s\\n' not-found ;;
    is-active) return 0 ;;
  esac
}}
sudo() {{ printf '%s\\n' "$*" > "$TEST_ROOT/systemd-arguments"; return 0; }}
curl() {{ printf '%s\\n' '{{"status":"ok","service":"agent-connectivity-hub","readOnly":false,"schema":1,"projectHash":"0123456789abcdef0123456789abcdef","generation":"generation"}}'; }}
start_hub
test "$OC_HUB_READY" = 1
'''
        with tempfile.TemporaryDirectory() as temporary:
            result = shell('TEST_ROOT="$1"\n' + code, temporary)
            runtime = json.loads((Path(temporary) / "share/hub/runtime.json").read_text())
            runtime_input = json.loads((Path(temporary) / "share/hub/runtime-input.json").read_text())
            self.assertEqual(runtime["hubPort"], 4103)
            self.assertEqual(runtime["generation"], "generation")
            self.assertEqual(runtime_input["auth"], {"username": "opencode", "password": "two words$#"})
            arguments = (Path(temporary) / "systemd-arguments").read_text()
            self.assertIn("ocvm-hub", arguments)
            self.assertIn("--host 127.0.0.1", arguments)
            self.assertIn("--project-hash", arguments)
            self.assertIn("--runtime-input", arguments)
            self.assertNotIn("--auth-file", arguments)
            self.assertIn("--tls-cert", arguments)
            self.assertIn("--tls-key", arguments)
            self.assertIn("AppArmorProfile=opencode-sandbox", arguments)
            self.assertIn("--setenv=PYTHONDONTWRITEBYTECODE=1", arguments)
            self.assertIn("Ready on HTTPS port 4103", result.stdout)

    def test_guest_service_refuses_tampered_asset_contents(self):
        hub_sha = re.search(r'^HUB_ASSET_SHA256="([^"]+)"', SCRIPT, re.M)[1]
        names = ("agent_hub_source_dir", "legacy_hub_process_matches", "agent_hub_retire_legacy",
                 "_hub_file_sha256", "_hub_write_manifest", "_agent_hub_verify_manifest", "agent_hub_stage_assets",
                 "load_session_auth", "hub_runtime_dir", "hub_unit_description", "hub_remove_current_file",
                 "hub_failure", "hub_prepare_runtime", "stop_hub", "hub_health", "hub_verify_assets", "start_hub")
        code = '\n'.join(function(name) for name in names)
        code += f'''\nSCRIPT_DIR={str(ROOT)!r}
SHARE_ROOT="$1/state"
HUB_ASSET_SHA256={hub_sha!r}
OCVM_VERSION=fixture
SESS_SHARE="$1/share"
PROJ_DIR="$1/project"
mkdir -p "$SESS_SHARE" "$PROJ_DIR"
agent_hub_stage_assets "$SESS_SHARE"
printf '%s\\n' 'tampered after staging' > "$SESS_SHARE/hub/assets-$HUB_ASSET_SHA256/server.py"
OC_HUB_ENABLED=1
OC_HUB_ASSET_DIR="$SESS_SHARE/hub/assets-$HUB_ASSET_SHA256"
OC_HUB_GENERATION=generation
OC_OPENLIVE_PROJECT_HASH=0123456789abcdef0123456789abcdef
OC_PORT=4096
OC_MCP_ENABLED=0
OC_MCP_PORT=40960
OC_A2A=1
ensure_web_tls() {{ OC_SCHEME=https; OC_TLS_CERT=cert.pem; OC_TLS_KEY=key.pem; }}
ss() {{ return 1; }}
systemctl() {{ case "$1" in show) printf '%s\\n' not-found ;; esac; }}
sudo() {{ printf '%s\\n' "$*" > "$TEST_ROOT/systemd-arguments"; return 0; }}
if start_hub; then exit 1; fi
test ! -e "$TEST_ROOT/systemd-arguments"
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell('TEST_ROOT="$1"\n' + code, temporary)
            failure = json.loads((Path(temporary) / "share/hub/failure.json").read_text())
        self.assertIn("content integrity", failure["reason"])

    def test_guest_service_publishes_failure_when_assets_are_not_staged(self):
        names = ("hub_runtime_dir", "hub_unit_description", "hub_remove_current_file", "hub_failure",
                 "hub_prepare_runtime", "stop_hub", "hub_health", "start_hub")
        code = '\n'.join(function(name) for name in names)
        code += '''\nSESS_SHARE="$1/share"
PROJ_DIR="$1/project"
mkdir -p "$SESS_SHARE" "$PROJ_DIR"
OC_HUB_ENABLED=1
OC_HUB_ASSET_DIR=""
OC_HUB_GENERATION=generation
OC_OPENLIVE_PROJECT_HASH=0123456789abcdef0123456789abcdef
systemctl() { printf '%s\\n' not-found; }
if start_hub; then exit 1; fi
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)
            failure = json.loads((Path(temporary) / "share/hub/failure.json").read_text())
        self.assertEqual(failure["generation"], "generation")
        self.assertIn("not staged", failure["reason"])

    def test_guest_stop_refuses_a_different_generation_and_removes_only_its_own_descriptor(self):
        names = ("hub_runtime_dir", "hub_unit_description", "hub_remove_current_file", "stop_hub")
        code = '\n'.join(function(name) for name in names)
        code += '''\nSESS_SHARE="$1/share"
mkdir -p "$SESS_SHARE/hub"
chmod 700 "$SESS_SHARE" "$SESS_SHARE/hub"
OC_HUB_GENERATION=generation
printf '%s\\n' '{"generation":"generation"}' > "$SESS_SHARE/hub/runtime.json"
chmod 600 "$SESS_SHARE/hub/runtime.json"
systemctl() {
  if [[ "$4" == LoadState ]]; then printf '%s\\n' loaded; else printf '%s\\n' "opencode-vm hub $SESS_SHARE foreign"; fi
}
sudo() { exit 99; }
if stop_hub; then exit 1; fi
systemctl() {
  if [[ "$4" == LoadState ]]; then printf '%s\\n' loaded; else printf '%s\\n' "opencode-vm hub $SESS_SHARE generation"; fi
}
sudo() { test "$1 $2 $3" = "-n systemctl stop"; }
stop_hub
'''
        with tempfile.TemporaryDirectory() as temporary:
            shell(code, temporary)

    def test_launcher_requires_same_generation_tls_health_and_lan_bound_block(self):
        registry = SCRIPT.split("LAUNCHER_APP_REGISTRY = (", 1)[1].split("\n)", 1)[0]
        self.assertIn('"id": "agent-hub"', registry)
        self.assertIn('"port_offset": 7', registry)
        self.assertIn('"scheme": "https"', registry)
        self.assertIn('"runtime_file": "hub/runtime.json"', registry)
        self.assertIn('"failure_file": "hub/failure.json"', registry)
        self.assertNotIn('"local_only"', registry)
        self.assertIn('generation != LAUNCHER_GENERATION', SCRIPT)
        self.assertIn('ssl._create_unverified_context()', SCRIPT)
        self.assertIn('health.get("generation") == generation', SCRIPT)
        self.assertNotIn('bind="127.0.0.1"', SCRIPT)
        self.assertIn('forwards+=( -L "0.0.0.0:${p}:127.0.0.1:${p}" )', SCRIPT)
        self.assertIn('P+7  Agent Control Hub HTTPS', SCRIPT)

    def test_reattach_stops_only_the_previous_owned_hub_generation(self):
        self.assertIn('local old_controller="${SESS_CONTROLLER:-$old_auth_generation}"', SCRIPT)
        self.assertIn('OC_HUB_GENERATION="${6:-}"', SCRIPT)
        self.assertIn('. "$SESS_SHARE/lib/web.sh"\n       stop_hub', SCRIPT)
        self.assertIn('"$sess_tls" "$old_controller" || {', SCRIPT)


if __name__ == "__main__":
    unittest.main()
