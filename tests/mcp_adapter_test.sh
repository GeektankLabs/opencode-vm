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
MCP_ADAPTER_VERSION="$(jq -r '.version' "$ROOT/adapters/mcp/package.json")"
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
artifact="$TMP/opencode-vm-mcp-adapter-$MCP_ADAPTER_VERSION.tar"
"$ROOT/scripts/build-mcp-adapter.sh" "$artifact" >/dev/null
expected_sha="$(awk -F'"' '/^MCP_ADAPTER_SHA256=/ {print $2; exit}' "$SCRIPT")"
assert_eq "$(sha256sum "$artifact" | awk '{print $1}')" "$expected_sha"
mkdir "$TMP/artifact"
tar -xf "$artifact" -C "$TMP/artifact"
package_root="$TMP/artifact/opencode-vm-mcp-adapter-$MCP_ADAPTER_VERSION"
[[ -f "$package_root/dist/main.js" && -f "$package_root/dist/content.js" && -f "$package_root/dist/attention.js" && -f "$package_root/dist/events.js" && -f "$package_root/dist/attachments.js" && -f "$package_root/dist/agent-control.js" && -f "$package_root/dist/management-journal.js" && -f "$package_root/manifest.json" ]] || fail "release package is incomplete"
[[ ! -e "$package_root/src" && ! -e "$package_root/tests" && ! -e "$package_root/node_modules" ]] || fail "release package contains development state"
jq -e --arg version "$MCP_ADAPTER_VERSION" '.schema == 1 and .adapterVersion == $version and
  .mcpSdkVersion == "1.30.1" and .opencodeSdkVersion == "1.18.21" and
  .transport == "streamable-http-stateless"' "$package_root/manifest.json" >/dev/null ||
  fail "release manifest is invalid"
pass "MCP adapter artifact is deterministic, pinned, and production-only"

# Standalone cache installation is serialized: two starts may download in
# parallel, but neither may remove the other start's verified winner.
MCP_ADAPTER_SHA256="$expected_sha"
MCP_ADAPTER_FILENAME="opencode-vm-mcp-adapter-$MCP_ADAPTER_VERSION.tar"
MCP_ADAPTER_TAG="$(awk -F'"' '/^MCP_ADAPTER_TAG=/ {print $2; exit}' "$SCRIPT")"
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

# STARTREST P2: start/attach/watcher report exactly one honest named end state.
assert_eq "$(grep -cF '[mcp] End state:' "$SCRIPT")" 8
grep -qF 'End state: complete — guest listener, authenticated host mapping, and OpenAI tunnel verified.' "$SCRIPT" ||
  fail "complete tunnel end state missing"
grep -qF 'End state: INCOMPLETE — connector ready (guest listener + authenticated host mapping verified); OpenAI tunnel start failed.' "$SCRIPT" ||
  fail "incomplete tunnel end state missing"
grep -qF 'End state: INCOMPLETE — host readiness verification timed out' "$SCRIPT" ||
  fail "readiness timeout end state missing"
grep -qF 'End state: disabled — suppressed by --no-mcp for this invocation.' "$SCRIPT" ||
  fail "disabled end state missing"
grep -qF 'readiness: not ready — ready descriptor absent or bound to another generation/port' "$SCRIPT" ||
  fail "doctor readiness granularity missing"
grep -qF 'readiness: not ready — authenticated host healthz failed (listener/connectivity)' "$SCRIPT" ||
  fail "doctor listener granularity missing"
grep -qF 'oauth obs:' "$SCRIPT" || fail "OAuth warning observation missing"
pass "start/attach/doctor name exactly one honest MCP end state with concrete causes"

# STARTREST P1: provenance report classifies the invocation and names gaps.
# Self-contained throwaway git fixture: classification never depends on the
# checkout/export layout the test suite itself runs from.
(
  export HOME="$TMP/provenance-home"
  export OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  mkdir -p "$HOME"
  # shellcheck disable=SC1090
  source "$SCRIPT"
  fixture_git="$TMP/provenance-git"
  fixture_plain="$TMP/provenance-plain"
  mkdir -p "$fixture_git" "$fixture_plain" "$HOME/bin"
  git -C "$fixture_git" init -q
  printf 'x\n' > "$fixture_git/opencode-vm"
  printf 'x\n' > "$fixture_plain/opencode-vm"
  cp "$fixture_plain/opencode-vm" "$HOME/bin/opencode-vm"
  PROVENANCE_TARGET=""
  ocvm_resolve_script_path() { printf '%s\n' "$PROVENANCE_TARGET"; }
  SCRIPT_DIR="$ROOT"
  PROVENANCE_TARGET="$fixture_git/opencode-vm"
  out="$(script_provenance_report)"
  grep -qF 'invocation: git checkout' <<<"$out" || exit 1
  grep -qF 'mcp assets: source checkout, valid' <<<"$out" || exit 1
  grep -qF 'hub assets: source checkout' <<<"$out" || exit 1
  PROVENANCE_TARGET="$fixture_plain/opencode-vm"
  out="$(script_provenance_report)"
  grep -qF 'invocation: standalone script' <<<"$out" || exit 1
  grep -qF "installed:  $HOME/bin/opencode-vm (vunknown)" <<<"$out" || exit 1
  grep -qF "gap:        installed version vunknown differs from running v$OCVM_VERSION" <<<"$out" || exit 1
  out="$(script_provenance_report)"
  grep -qF 'digest:     installed copy byte-identical' <<<"$out" || exit 1
  printf '\n# drift\n' >> "$HOME/bin/opencode-vm"
  out="$(script_provenance_report)"
  grep -qF 'digest:     installed copy differs from the running script' <<<"$out" || exit 1
  PROVENANCE_TARGET="$HOME/bin/opencode-vm"
  out="$(script_provenance_report)"
  grep -qF 'invocation: managed install' <<<"$out" || exit 1
  rm -f "$HOME/bin/opencode-vm"
  # Standalone layout without assets: concrete named gaps, no repair/download.
  SCRIPT_DIR="$TMP/provenance-standalone"
  mkdir -p "$SCRIPT_DIR"
  PROVENANCE_TARGET="$fixture_plain/opencode-vm"
  out="$(script_provenance_report)"
  grep -qF 'mcp assets: GAP' <<<"$out" || exit 1
  grep -qF 'hub assets: GAP' <<<"$out" || exit 1
  grep -qF 'openlive:   not installed' <<<"$out" || exit 1
  grep -qF 'integrity:  named gaps above' <<<"$out" || exit 1
) || fail "provenance report did not classify invocations or name gaps"
pass "provenance report classifies invocation and names concrete asset gaps read-only"

# --- W4-F1: doctor preflight framing conforms to the REAL adapter -----------
# The doctor's tools/list request must satisfy the adapter's 2026-07-28
# header/meta contract (Mcp-Method header + params._meta.protocolVersion); a
# curl mock alone cannot prove this, so this runs the actual doctor request
# against a real McpHttpServer built from this candidate.
harness_pid=""
cleanup_harness() { [[ -n "${harness_pid:-}" ]] && kill "$harness_pid" 2>/dev/null || true; }
trap 'cleanup_harness; rm -rf "$TMP"' EXIT
if command -v node >/dev/null 2>&1 && [[ -f "$ROOT/adapters/mcp/dist/http.js" ]]; then
  harness="$TMP/preflight-harness.mjs"
  cat > "$harness" <<'HARNESS'
const { McpHttpServer } = await import(process.env.ADAPTER_HTTP);
const runtime = { schema: 1, project: "/p", projectHash: "h", projectName: "p", backendUrl: "http://127.0.0.1:1", generation: "g", opencodeVersion: "x", listenHost: "127.0.0.1", listenPort: 0, credentialFile: "/c", managerFile: "/m" };
const server = new McpHttpServer(runtime, process.env.PREFLIGHT_TOKEN, {});
const port = await server.start();
process.stdout.write(String(port) + "\n");
process.on("SIGTERM", async () => { await server.close().catch(() => {}); process.exit(0); });
setInterval(() => {}, 1000);
HARNESS
  preflight_token="tok-$(printf 'x%.0s' {1..40})"
  ADAPTER_HTTP="$ROOT/adapters/mcp/dist/http.js" PREFLIGHT_TOKEN="$preflight_token" node "$harness" > "$TMP/preflight.port" 2>"$TMP/preflight.err" &
  harness_pid=$!
  for _ in $(seq 1 60); do [[ -s "$TMP/preflight.port" ]] && break; sleep 0.1; done
  preflight_port="$(head -n 1 "$TMP/preflight.port" 2>/dev/null || true)"
  [[ -n "$preflight_port" ]] || { cat "$TMP/preflight.err" >&2; fail "preflight harness did not start"; }

  # The pre-W4-F1 framing (no mcp-method, empty params) is what the real
  # adapter rejects: prove the defect class is observable here.
  old_code="$(command curl -sS -o "$TMP/preflight-old.json" -w '%{http_code}' \
    -H "X-OCVM-MCP-Token: $preflight_token" -H "Content-Type: application/json" \
    -H "mcp-protocol-version: 2026-07-28" \
    --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    "http://127.0.0.1:$preflight_port/mcp" 2>/dev/null || true)"
  assert_eq "$old_code" "400"

  DOCTOR_TMPDIR="$TMP" DOCTOR_PROBE_TIMEOUT=2
  # Bypass the curl mock defined earlier in this file; use the real binary.
  _doctor_run() { local t="$1"; shift; command "$@" 2>/dev/null; }
  eval "$(extract_function _doctor_mcp_tools)"
  tools_out="$(_doctor_mcp_tools "$preflight_port" "$preflight_token" 2>/dev/null)" || tools_out=""
  for tool in list_monitors create_monitor create_monitor_worker list_monitor_workers update_monitor_worker; do
    grep -qxF "$tool" <<<"$tools_out" || fail "doctor tools/list framing did not return $tool"
  done
  assert_eq "$(grep -c . <<<"$tools_out")" "44"
  cleanup_harness
  harness_pid=""
  pass "doctor preflight framing conforms to the real adapter (old framing 400, real tools/list returns 44 incl. core management)"
else
  pass "doctor preflight conformance skipped (node or built adapter unavailable)"
fi

printf 'All MCP adapter lifecycle tests passed.\n'
