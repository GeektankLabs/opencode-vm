"""Dashboard source lifecycle only: no actual service/VM/forward operations."""
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / 'opencode-vm.sh').read_text()

def function(name):
    pattern = r'^' + name + r'\(\) (?:\{\n.*?^\}|\(\n.*?^\))'
    match = re.search(pattern, SCRIPT, re.M | re.S)
    assert match, name
    return match[0].replace('/tmp/ocvm-dashboard.lock', '$SESS_SHARE/cleanup.lock')

def run(code):
    with tempfile.TemporaryDirectory(prefix='ocvm-dashboard-lifecycle-') as path:
        result = subprocess.run(['bash', '-c', 'set -euo pipefail\n' + code, 'fixture', path], capture_output=True, text=True)
        if result.returncode:
            raise AssertionError(result.stdout + result.stderr)

PRELUDE = '''
SESS_SHARE="$1/share"; mkdir -p "$SESS_SHARE/dashboard"
OC_HUB_GENERATION=generation; OC_OPENLIVE_PROJECT_HASH=0123456789abcdef0123456789abcdef
systemctl() { if [[ "$*" == *LoadState* ]]; then printf '%s\n' "$LOAD"; elif [[ "$*" == *Description* ]]; then printf '%s\n' "$DESCRIPTION"; else return 0; fi; }
sudo() { printf '%s\n' "$*" >> "$SESS_SHARE/service-calls"; }
'''

class DashboardLifecycle(unittest.TestCase):
    def test_owned_cleanup_and_generation_mismatch(self):
        code = '\n'.join(function(n) for n in ['dashboard_remove_current', 'stop_dashboard']) + PRELUDE + '''
LOAD=loaded; DESCRIPTION='foreign service'
printf '%s\n' '{"generation":"generation"}' > "$SESS_SHARE/dashboard/runtime.json"
if stop_dashboard; then exit 1; fi
test ! -f "$SESS_SHARE/service-calls"
test -f "$SESS_SHARE/dashboard/runtime.json"
DESCRIPTION="opencode-vm dashboard $SESS_SHARE generation"
printf '%s\n' '{"generation":"newer"}' > "$SESS_SHARE/dashboard/runtime-input.json"
stop_dashboard
test ! -f "$SESS_SHARE/dashboard/runtime.json"
test -f "$SESS_SHARE/dashboard/runtime-input.json"
grep -q 'timeout 12 systemctl stop ocvm-dashboard.service' "$SESS_SHARE/service-calls"
'''
        run(code)

    def test_start_tls_auth_and_staged_integrity_fail_closed(self):
        code = '\n'.join(function(n) for n in ['dashboard_remove_current', 'dashboard_failure', 'start_dashboard']) + PRELUDE + '''
OC_MODE=web; OC_PORT=4096; OC_PORT_INTERNAL=4095
OC_TASKBOARD_METADATA_FILE=metadata; PROJ_DIR="$1/project"; mkdir -p "$PROJ_DIR"
adapter="$SESS_SHARE/dashboard/adapter"; mkdir -p "$adapter/dist" "$adapter/dashboard"
printf '%s\n' opencode-vm-mcp-staging-v1 > "$adapter/.ocvm-managed"
touch "$adapter/dist/dashboard-main.js" "$adapter/dashboard/index.html"
( cd "$adapter"; sha256sum .ocvm-managed dist/dashboard-main.js dashboard/index.html > .files.sha256 )
stop_dashboard() { :; }; npm() { :; }
ensure_web_tls() { OC_SCHEME="$TLS"; OC_TLS_CERT=cert; OC_TLS_KEY=key; }
load_session_auth() { OC_PASSWORD=""; OC_USERNAME=opencode; }
ss() { :; }
TLS=http
if start_dashboard; then exit 1; fi
test ! -f "$SESS_SHARE/service-calls"
TLS=https
if start_dashboard; then exit 1; fi
test ! -f "$SESS_SHARE/service-calls"
printf '%s\n' enabled > "$SESS_SHARE/dashboard/auth.choice"
if start_dashboard; then exit 1; fi
test ! -f "$SESS_SHARE/service-calls"
printf '%s\n' none > "$SESS_SHARE/dashboard/auth.choice"
printf corrupt > "$adapter/dist/dashboard-main.js"
if start_dashboard; then exit 1; fi
test ! -f "$SESS_SHARE/service-calls"
OC_MODE=tui-mcp
start_dashboard
test ! -f "$SESS_SHARE/service-calls"
'''
        run(code)

    def test_source_starts_only_after_backend_spawn_and_reuses_eight_port_block(self):
        self.assertEqual(SCRIPT.count('start_dashboard || echo'), 4)
        for match in re.finditer(r'start_dashboard \|\| echo', SCRIPT):
            self.assertIn('OC_WEB_PID=$!', SCRIPT[match.start()-100:match.start()])
        self.assertIn('port="$((OC_PORT + 6))"', SCRIPT)
        self.assertIn('port="$((OC_PORT + 7))"', SCRIPT)
        self.assertNotIn('"local_only": True', SCRIPT)
        self.assertNotIn('host loopback forward', SCRIPT)
        self.assertIn('--property=KillMode=control-group', function('start_dashboard'))
        self.assertIn('--property=StartLimitBurst=3', function('start_dashboard'))
        self.assertNotIn('kill ', function('stop_dashboard'))
        self.assertIn('sha256sum -c .files.sha256', function('start_dashboard'))

    def test_start_resolves_absolute_node_path_before_service_launch(self):
        code = '\n'.join(function(n) for n in ['dashboard_remove_current', 'dashboard_failure', 'start_dashboard']) + PRELUDE + '''
OC_MODE=web; OC_PORT=4096; OC_PORT_INTERNAL=4095; OC_HOST_IP=192.0.2.1
OC_TASKBOARD_METADATA_FILE=metadata; PROJ_DIR="$1/project"; mkdir -p "$PROJ_DIR"
adapter="$SESS_SHARE/dashboard/adapter"; mkdir -p "$adapter/dist" "$adapter/dashboard"
printf '%s\n' opencode-vm-mcp-staging-v1 > "$adapter/.ocvm-managed"
touch "$adapter/dist/dashboard-main.js" "$adapter/dashboard/index.html"
( cd "$adapter"; sha256sum .ocvm-managed dist/dashboard-main.js dashboard/index.html > .files.sha256 )
stop_dashboard() { :; }; npm() { :; }; ss() { :; }; python3() { return 0; }
opencode() { printf '%s\n' 1.2.3; }
ensure_web_tls() { OC_SCHEME=https; OC_TLS_CERT="$SESS_SHARE/cert"; OC_TLS_KEY="$SESS_SHARE/key"; }
load_session_auth() { OC_PASSWORD=""; OC_USERNAME=opencode; }
printf '%s\n' none > "$SESS_SHARE/dashboard/auth.choice"
fakebin="$1/fakebin"; mkdir -p "$fakebin"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$fakebin/node"; chmod +x "$fakebin/node"
PATH="$fakebin:$PATH"
start_dashboard
grep -qF -- "-- $fakebin/node $adapter/dist/dashboard-main.js" "$SESS_SHARE/service-calls"
! grep -qF -- '-- node ' "$SESS_SHARE/service-calls"
test ! -f "$SESS_SHARE/dashboard/failure.json"
jq -e '.ready == true and .dashboardPort == 4102' "$SESS_SHARE/dashboard/runtime.json" >/dev/null
'''
        run(code)

    def test_missing_node_fails_closed_and_launch_continues(self):
        code = '\n'.join(function(n) for n in ['dashboard_remove_current', 'dashboard_failure', 'start_dashboard']) + PRELUDE + '''
OC_MODE=web; OC_PORT=4096; OC_PORT_INTERNAL=4095
OC_TASKBOARD_METADATA_FILE=metadata; PROJ_DIR="$1/project"; mkdir -p "$PROJ_DIR"
adapter="$SESS_SHARE/dashboard/adapter"; mkdir -p "$adapter/dist" "$adapter/dashboard"
printf '%s\n' opencode-vm-mcp-staging-v1 > "$adapter/.ocvm-managed"
touch "$adapter/dist/dashboard-main.js" "$adapter/dashboard/index.html"
( cd "$adapter"; sha256sum .ocvm-managed dist/dashboard-main.js dashboard/index.html > .files.sha256 )
stop_dashboard() { :; }; npm() { :; }; ss() { :; }
ensure_web_tls() { OC_SCHEME=https; OC_TLS_CERT="$SESS_SHARE/cert"; OC_TLS_KEY="$SESS_SHARE/key"; }
load_session_auth() { OC_PASSWORD=""; OC_USERNAME=opencode; }
printf '%s\n' none > "$SESS_SHARE/dashboard/auth.choice"
command() { if [[ "${1:-}" == -v && "${2:-}" == node ]]; then return 1; fi; builtin command "$@"; }
if start_dashboard; then exit 1; fi
test ! -f "$SESS_SHARE/service-calls"
test ! -f "$SESS_SHARE/dashboard/runtime-input.json"
jq -e '.reason == "Dashboard node executable could not be resolved."' "$SESS_SHARE/dashboard/failure.json" >/dev/null
out="$(start_dashboard || echo '[dashboard] Unavailable; OpenCode continues.')"
printf '%s\n' "$out" | grep -qF '[dashboard] Unavailable; OpenCode continues.'
'''
        run(code)

if __name__ == '__main__': unittest.main()
