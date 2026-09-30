#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/opencode-vm.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "expected '$2', got '$1'"; }

extract_function() {
  local name="$1"
  awk -v signature="${name}() {" '
    $0 == signature { copy=1 }
    copy { print }
    copy && /^}$/ { exit }
  ' "$SCRIPT"
}

# Parser behavior is tested from the production function with only its two
# numeric dependencies stubbed. Each failure case runs in a subshell because
# parse_web_flags intentionally exits with usage status 2.
DEFAULT_OC_PORT=4096
DEFAULT_MCP_PORT=40960
is_valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( 1 <= 10#$1 && 10#$1 <= 65535 )); }
eval "$(extract_function validate_mcp_port)"
eval "$(extract_function parse_web_flags)"

parse_web_flags --mcp --mcp-port 41000 --no-auth
assert_eq "$SESSION_MCP_MODE" enable
assert_eq "$SESSION_MCP_PORT" 41000
assert_eq "$SESSION_AUTH_MODE" clear
pass "web flags enable MCP without weakening its independent authentication"

parse_web_flags --mcp-port 41000
assert_eq "$SESSION_MCP_MODE" enable
assert_eq "$SESSION_MCP_PORT" 41000
for args in '--mcp --no-mcp' '--no-mcp --mcp-port 41000' '--mcp --mcp-port nope'; do
  # shellcheck disable=SC2086
  if ( parse_web_flags $args ) >"$TMP/flags.out" 2>"$TMP/flags.err"; then
    fail "invalid flag combination was accepted: $args"
  fi
done
pass "MCP flag conflicts and invalid ports fail closed"

# Session records append fields and remain callable through the old positional
# contract used by older tests/installations.
eval "$(extract_function write_senv)"
senv="$TMP/session.env"
write_senv "$senv" vm /project hash web 4096 0 1 generation controller
# shellcheck disable=SC1090
source "$senv"
assert_eq "$SESS_MCP_ENABLED" 0
assert_eq "$SESS_MCP_PORT" ""
write_senv "$senv" vm /project hash web 4096 0 1 generation controller 1 41000
# shellcheck disable=SC1090
source "$senv"
assert_eq "$SESS_MCP_ENABLED" 1
assert_eq "$SESS_MCP_PORT" 41000
pass "session tracking is backward compatible and preserves connector state"

# Credential helpers are executed rather than string-matched: creation,
# preservation, mode checks, malformed files, and symlinks are security gates.
need() { command -v "$1" >/dev/null; }
eval "$(extract_function mcp_move_no_follow)"
eval "$(extract_function load_mcp_credential)"
eval "$(extract_function validate_mcp_credential)"
eval "$(extract_function ensure_mcp_credential)"
eval "$(extract_function read_mcp_credential_path)"
share="$TMP/share"
mkdir -p "$share"
ensure_mcp_credential "$share"
credential="$share/mcp/credential"
assert_eq "$(stat -c '%a' "$share/mcp")" 700
assert_eq "$(stat -c '%a' "$credential")" 600
[[ "$(<"$credential")" =~ ^[0-9a-f]{64}$ ]] || fail "credential does not contain 256 random bits"
before="$(<"$credential")"
ensure_mcp_credential "$share"
assert_eq "$(<"$credential")" "$before"
assert_eq "$(read_mcp_credential_path "$share")" "$credential"
chmod 644 "$credential"
validate_mcp_credential "$share" && fail "unsafe credential mode was accepted"
chmod 600 "$credential"
rm -f "$credential"
ln -s /dev/null "$credential"
validate_mcp_credential "$share" && fail "credential symlink was accepted"
pass "connector credentials are private, stable, and reject unsafe paths"

# Stage through a private connector directory and reject any guest-created
# destination symlink before rsync --delete can touch it.
MCP_ADAPTER_VERSION=0.1.19
MCP_ADAPTER_SHA256="test"
MCP_ADAPTER_CACHE_ROOT="$TMP/cache"
SCRIPT_DIR="$ROOT"
eval "$(extract_function mcp_adapter_cache_dir)"
eval "$(extract_function mcp_adapter_dev_valid)"
eval "$(extract_function mcp_adapter_release_valid)"
eval "$(extract_function mcp_adapter_source_dir)"
eval "$(extract_function mcp_stage_adapter)"
eval "$(extract_function mcp_unstage_adapter)"
stage_share="$TMP/stage-share"
mkdir -p "$stage_share"
ensure_mcp_credential "$stage_share"
mcp_stage_adapter "$stage_share"
[[ -f "$stage_share/mcp/adapter/.ocvm-managed" ]] || fail "managed adapter was not staged"
[[ ! -e "$stage_share/mcp/adapter/node_modules" && ! -e "$stage_share/mcp/adapter/dist" ]] ||
  fail "source staging copied generated dependency/output directories"
victim="$TMP/victim"
mkdir "$victim"
printf 'keep\n' > "$victim/keep"
rm -rf "$stage_share/mcp/adapter"
ln -s "$victim" "$stage_share/mcp/adapter"
if mcp_stage_adapter "$stage_share" >"$TMP/stage.out" 2>"$TMP/stage.err"; then
  fail "adapter staging accepted a destination symlink"
fi
[[ "$(<"$victim/keep")" == keep ]] || fail "unsafe staging changed the symlink target"
rm -f "$stage_share/mcp/adapter"
mcp_stage_adapter "$stage_share"
mcp_unstage_adapter "$stage_share"
[[ ! -e "$stage_share/mcp/adapter" && -f "$stage_share/mcp/credential" ]] ||
  fail "managed unstage did not preserve only the credential"
pass "staging is atomic, managed, and rejects destination symlinks"

BROWSER_UNSAFE_PORTS=(6000)
eval "$(extract_function is_browser_unsafe_port)"
eval "$(extract_function select_web_guest_base)"
assert_eq "$(select_web_guest_base 4096 40960)" 4096
assert_eq "$(select_web_guest_base 4096 4094)" 4097
if select_web_guest_base 65532 65530 >"$TMP/ports.out" 2>"$TMP/ports.err"; then
  fail "guest web block accepted an unavoidable MCP overlap"
fi
pass "guest web ports avoid MCP overlap without depending on LAN tunnels"

# Build/package contract and the pinned digest used by standalone scripts.
artifact="$TMP/opencode-vm-mcp-adapter-0.1.19.tar"
"$ROOT/scripts/build-mcp-adapter.sh" "$artifact" >/dev/null
expected_sha="$(awk -F'"' '/^MCP_ADAPTER_SHA256=/ {print $2; exit}' "$SCRIPT")"
assert_eq "$(sha256sum "$artifact" | awk '{print $1}')" "$expected_sha"
mkdir "$TMP/artifact"
tar -xf "$artifact" -C "$TMP/artifact"
package_root="$TMP/artifact/opencode-vm-mcp-adapter-0.1.19"
[[ -f "$package_root/dist/main.js" && -f "$package_root/dist/content.js" && -f "$package_root/dist/attachments.js" && -f "$package_root/dist/agent-control.js" && -f "$package_root/manifest.json" ]] || fail "release package is incomplete"
[[ ! -e "$package_root/src" && ! -e "$package_root/tests" && ! -e "$package_root/node_modules" ]] || fail "release package contains development state"
jq -e '.schema == 1 and .adapterVersion == "0.1.19" and
  .mcpSdkVersion == "1.30.1" and .opencodeSdkVersion == "1.18.21" and
  .transport == "streamable-http-stateless"' "$package_root/manifest.json" >/dev/null ||
  fail "release manifest is invalid"
pass "MCP adapter artifact is deterministic, pinned, and production-only"

# Standalone cache installation is serialized: two starts may download in
# parallel, but neither may remove the other start's verified winner.
MCP_ADAPTER_SHA256="$expected_sha"
MCP_ADAPTER_FILENAME="opencode-vm-mcp-adapter-0.1.19.tar"
MCP_ADAPTER_TAG="v0.5.60"
MCP_SDK_VERSION="1.30.1"
MCP_OPENCODE_SDK_VERSION="1.18.21"
MCP_TESTED_PROTOCOL_VERSION="2025-11-25"
OCVM_UPDATE_REPO="test/repo"
SCRIPT_DIR="$TMP/standalone"
MCP_ADAPTER_CACHE_ROOT="$TMP/standalone-cache"
mkdir -p "$SCRIPT_DIR"
eval "$(extract_function mcp_adapter_release_url)"
eval "$(extract_function mcp_sha256)"
eval "$(extract_function mcp_link_no_follow)"
eval "$(extract_function mcp_prepare_adapter_cache)"
curl() {
  local output="" previous="" arg
  for arg in "$@"; do
    [[ "$previous" == "--output" ]] && output="$arg"
    previous="$arg"
  done
  [[ -n "$output" ]] || return 1
  sleep 0.2
  cp "$artifact" "$output"
}
mcp_prepare_adapter_cache &
cache_one=$!
mcp_prepare_adapter_cache &
cache_two=$!
wait "$cache_one" || fail "first concurrent cache install failed"
wait "$cache_two" || fail "second concurrent cache install failed"
cached_adapter="$(mcp_adapter_cache_dir)"
mcp_adapter_release_valid "$cached_adapter" || fail "concurrent cache winner is invalid"
[[ ! -e "${cached_adapter}.install-lock" ]] || fail "adapter cache lock was retained"
rm -rf "$cached_adapter"
printf '%s\n' '999999 stale stale-token' > "${cached_adapter}.install-lock"
mcp_prepare_adapter_cache || fail "stale cache activation lock was not reclaimed"
mcp_adapter_release_valid "$cached_adapter" || fail "cache is invalid after stale-lock recovery"
rm -rf "$cached_adapter"
mkdir -p "${cached_adapter}.install-lock"
printf '%s\n' 999999 > "${cached_adapter}.install-lock/owner"
mcp_prepare_adapter_cache || fail "legacy directory cache lock was not reclaimed"
mcp_adapter_release_valid "$cached_adapter" || fail "cache is invalid after legacy-lock recovery"
pass "standalone cache activation preserves the verified concurrent winner"

# Lifecycle invariants that must remain visible in both duplicated guest entry
# scripts and in the shared web library.
assert_eq "$(grep -cF 'OC_MCP_ENABLED="${14:-0}"' "$SCRIPT")" 2
assert_eq "$(grep -cF 'OC_MCP_PORT="${15:-40960}"' "$SCRIPT")" 2
assert_eq "$(grep -cF 'OC_MCP_GENERATION="${16:-}"' "$SCRIPT")" 2
(( $(grep -cF 'stop_mcp_adapter' "$SCRIPT") >= 10 )) || fail "connector shutdown is not wired through all runtime paths"
grep -qF 'listenHost:"127.0.0.1"' "$SCRIPT" || fail "runtime descriptor is not loopback-only"
grep -qF 'aa-exec -p opencode-sandbox -- node "$adapter/dist/main.js"' "$SCRIPT" || fail "adapter does not run under the sandbox profile"
grep -qF 'exec 9>&-' "$SCRIPT" || fail "adapter supervisor retains the runtime lock"
grep -qF 'Credential: $credential' "$SCRIPT" || fail "host readiness does not report the credential path"
if grep -qE -- '-L "?0\.0\.0\.0:.*mcp|OC_PROXY_NAMES=.*mcp' "$SCRIPT"; then
  fail "MCP was added to the public web forwarding path"
fi
pass "guest lifecycle is private, ownership-marked, and appended after the existing argument contract"

# The embedded library itself must remain valid shell after lifecycle additions.
python3 - "$SCRIPT" "$TMP/web.sh" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
match = re.search(r"read -r -d '' OCVM_WEB_LIB_SH <<'WEBLIB' \|\| true\n(.*?)\nWEBLIB", text, re.S)
if not match:
    raise SystemExit("web library not found")
# Keep fixture process/lock/socket state separate from a live project in this VM.
guest = Path(sys.argv[2]).parent / "guest"
guest.mkdir()
Path(sys.argv[2]).write_text(match.group(1).replace("/tmp/ocvm-", str(guest / "ocvm-")) + "\n")
PY
bash -n "$TMP/web.sh"
pass "embedded connector lifecycle library parses"

# Execute the production stop helper with ownership-marked processes. It must
# terminate supervisor then child, and must never signal a stale unrelated PID.
PROJ_DIR="$ROOT"
SESS_SHARE="$stage_share"
OC_PORT=4096
OC_HOST_IP=127.0.0.1
OC_TLS=0
OC_DIR_KEY="test"
OC_BANNER_SUFFIX=""
OC_BANNER_VERBOSE=0
OC_MCP_GENERATION=test-generation
OC_MCP_PORT=""
# shellcheck disable=SC1090
source "$TMP/web.sh"
# Tunnel service lifecycle has its own fixture suite; this test owns only the
# adapter processes below and must not query/stop a live systemd tunnel unit.
stop_mcp_tunnel() { return 0; }
bash -c 'trap "" TERM; while :; do sleep 1; done' "ocvm-mcp-supervisor-$OC_MCP_GENERATION" &
supervisor=$!
bash -c 'trap "" TERM; while :; do sleep 1; done' "ocvm-mcp-child-$OC_MCP_GENERATION" &
child=$!
printf '%s\n' "$supervisor" > "$TMP/guest/ocvm-mcp.sup.pid"
printf '%s\n' "$child" > "$TMP/guest/ocvm-mcp.run.pid"
stop_mcp_adapter
wait "$supervisor" 2>/dev/null || true
wait "$child" 2>/dev/null || true
[[ ! -e "$TMP/guest/ocvm-mcp.sup.pid" && ! -e "$TMP/guest/ocvm-mcp.run.pid" ]] || fail "owned MCP pid files survived shutdown"

sleep 30 &
foreign=$!
printf '%s\n' "$foreign" > "$TMP/guest/ocvm-mcp.sup.pid"
if stop_mcp_adapter >"$TMP/stop.out" 2>"$TMP/stop.err"; then
  fail "stale foreign PID was accepted as connector-owned"
fi
kill -0 "$foreign" 2>/dev/null || fail "foreign process was signaled"
kill "$foreign" 2>/dev/null || true
wait "$foreign" 2>/dev/null || true
rm -f "$TMP/guest/ocvm-mcp.sup.pid" "$TMP/guest/ocvm-mcp.run.pid"
pass "shutdown enforces process ownership and escalates boundedly"

grep -qF 'fi ) 9>&- &' "$SCRIPT" || fail "guest readiness watcher retains runtime-lock fd 9"
pass "connector background watchers close the runtime lock descriptor"

eval "$(extract_function mcp_watch_host_ready)"
eval "$(extract_function stop_mcp_host_watcher)"
MCP_HOST_WATCH_PID=""
MCP_HOST_WATCH_STATUS=""
session_env() { printf '%s\n' "$TMP/watcher.env"; }
proj_hash() { printf '%s\n' project-hash; }
load_mcp_credential() { MCP_CREDENTIAL_TOKEN="watcher-token"; }
vm_exec() { return 0; }
mcp_tunnel_start() { return 0; }
limactl() { return 0; }
curl() {
  local output="" previous="" arg
  for arg in "$@"; do
    [[ "$previous" == "-o" ]] && output="$arg"
    previous="$arg"
  done
  [[ -n "$output" ]] || return 1
  printf '%s\n' '{"healthy":true,"project":{"id":"project-hash"},"generation":"generation"}' > "$output"
}
mkdir -p "$stage_share/mcp"
printf '%s\n' 'SESS_CONTROLLER=controller' > "$TMP/watcher.env"
jq -n '{schema:1,projectHash:"project-hash",generation:"generation",host:"127.0.0.1",port:40960}' \
  > "$stage_share/mcp/ready.json"
mcp_watch_host_ready test-vm "$ROOT" "$stage_share" 40960 generation controller
sleep 1
stop_mcp_host_watcher || fail "successful host readiness was not propagated"
[[ -z "$MCP_HOST_WATCH_PID" && -z "$MCP_HOST_WATCH_STATUS" ]] || fail "completed watcher state was retained"
rm -f "$stage_share/mcp/ready.json"
mcp_watch_host_ready test-vm "$ROOT" "$stage_share" 40960 generation controller
if stop_mcp_host_watcher; then
  fail "cancelled host readiness was reported as successful"
fi
[[ -z "$MCP_HOST_WATCH_PID" && -z "$MCP_HOST_WATCH_STATUS" ]] || fail "cancelled watcher state was retained"
pass "host readiness result is reaped and propagated without signaling its PID"

assert_eq "$(grep -cF 'MCP_SHUTDOWN_FAILED=1' "$SCRIPT")" 4
pass "guest cleanup records and propagates connector shutdown failures"

printf 'All MCP adapter lifecycle tests passed.\n'
