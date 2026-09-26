#!/usr/bin/env bash
# Run with both /bin/bash on macOS (3.2) and a current Bash. No VM or host state
# is touched; only the port occupancy probe is replaced by a fixture.
# shellcheck disable=SC2034
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"
if [[ "$(uname -s)" == Linux ]]; then
  md5() { md5sum | cut -d' ' -f1; }
fi
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s (Bash %s)\n' "$1" "$BASH_VERSION"; }
assert_released() {
  local entry
  for entry in "$1"/*.lock "$1"/*.claim.*; do
    [[ ! -e "$entry" && ! -L "$entry" ]] || fail "left lock/claim after helper exited: $entry"
  done
}
mcp_host_port_available() { return 0; }
ports="$MCP_CONNECTOR_DIR/ports"
first="$(mcp_reserve_host_port /project-a)"
[[ "$first" == 40960 ]] || fail 'wrong first port'
# Assert immediately, rather than making a second call that hangs for 30s when
# Bash 3.2 loses the local lock variables before the explicit exit's trap runs.
assert_released "$ports/.locks"
second="$(mcp_reserve_host_port /project-b)"
[[ "$second" == 40961 ]] || fail 'port reservation was not retained independently of the short lock'
assert_released "$ports/.locks"
pass 'successful port reservations release the short lock while retaining port leases'

mcp_host_port_available() { return 1; }
if mcp_reserve_host_port /project-c 45000 > "$TMP/failure.out" 2> "$TMP/failure.err"; then
  fail 'busy explicit port was accepted'
fi
assert_released "$ports/.locks"
pass 'failed port reservation also releases its lock'

# Test implicit failure under errexit and an explicit exit inside the project
# callback, without disabling errexit by invoking the tested helper in an if.
mcp_tunnel_with_project /normal true
assert_released "$SESSIONS_DIR/.locks"
set +e
( set -e; mcp_tunnel_with_project /failure false; exit 99 )
failed=$?
mcp_tunnel_with_project /explicit-exit exit 7
exited=$?
set -e
[[ "$failed" == 1 && "$exited" == 7 ]] || fail 'callback exit status was changed'
assert_released "$SESSIONS_DIR/.locks"
pass 'project wrappers release locks on success, failure and explicit exit'

# Subshell-scoped cleanup state must not overwrite a caller's live lifecycle lock.
lifecycle_lock_acquire /parent
parent_link="$LIFECYCLE_LOCK_LINK"
parent_claim="$LIFECYCLE_LOCK_CLAIM"
mcp_host_port_available() { return 0; }
third="$(mcp_reserve_host_port /project-c)"
mcp_tunnel_with_project /child true
[[ "$LIFECYCLE_LOCK_LINK" == "$parent_link" && "$LIFECYCLE_LOCK_CLAIM" == "$parent_claim" && -L "$parent_link" ]] ||
  fail 'helper changed its parent lock'
assert_released "$ports/.locks"
lifecycle_lock_release
assert_released "$SESSIONS_DIR/.locks"
pass 'nested helpers preserve the parent lifecycle lock'

# Keep the existing dead-owner recovery semantics.
lock_root="$ports/.locks"
lock_key="$(proj_hash mcp-ports)"
mkdir "$lock_root/$lock_key.claim.dead"
printf '2147483647\n' > "$lock_root/$lock_key.claim.dead/pid"
ln -s "$lock_key.claim.dead" "$lock_root/$lock_key.lock"
recovered="$(mcp_reserve_host_port /project-d)"
[[ "$recovered" == 40963 ]] || fail 'dead owner recovery selected the wrong port'
assert_released "$lock_root"
pass 'dead reservation owners are recovered and released'
