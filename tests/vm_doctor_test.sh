#!/usr/bin/env bash
# VM-local doctor: wrapper + canonical library, exercised headlessly.
# Run with both /bin/bash on macOS (3.2) and a current Bash. No VM, no
# network, no host state is touched: every external probe is a function
# override or a fixture file. The wrapper end-to-end case runs the real
# installed wrapper binary with a clean environment against loopback-only
# fixture ports (connection-refused is the expected honest outcome there).
# Evidence: run output is meant to be tee'd to a retained task-owned path.
# Globals are used by sourced production functions.
# shellcheck disable=SC2034
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME" "$TMP/emptytmp" "$TMP/.opencode-vm/sessions"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"
if [[ "$(uname -s)" == Linux ]]; then
  md5() { md5sum | cut -d' ' -f1; }
  export -f md5
fi
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
need_out() { grep -qF "$2" "$1" || fail "expected [$2] in $1"; }
deny_out() { if grep -qF "$2" "$1"; then fail "forbidden [$2] found in $1"; fi; }

# --- payload extraction and materialization (release/staging parity) -------
[[ -n "${OCVM_DOCTOR_SH:-}" ]] || fail "OCVM_DOCTOR_SH payload is missing"
[[ -n "${OCVM_DOCTOR_INSTALL_SH:-}" ]] || fail "OCVM_DOCTOR_INSTALL_SH payload is missing"
printf '%s\n' "$OCVM_DOCTOR_SH" > "$TMP/doctor-lib.sh"
printf '%s\n' "$OCVM_DOCTOR_INSTALL_SH" > "$TMP/doctor-install.sh"
bash -n "$TMP/doctor-lib.sh" || fail "library payload bash -n"
bash -n "$TMP/doctor-install.sh" || fail "installer payload bash -n"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck --severity=error -s bash "$TMP/doctor-lib.sh" || fail "library payload shellcheck"
  shellcheck --severity=error -s bash "$TMP/doctor-install.sh" || fail "installer payload shellcheck"
fi
pass "materialized payloads pass bash -n and shellcheck --severity=error"

eval "$OCVM_DOCTOR_SH"
eval "$OCVM_DOCTOR_INSTALL_SH"
command -v doctor_main >/dev/null || fail "doctor_main not defined by library payload"
command -v install_doctor_wrapper >/dev/null || fail "install_doctor_wrapper not defined"
# _doctor_run without the external timeout binary keeps function mocks (curl,
# opencode) visible; the production timeout guard stays in the library itself.
_doctor_run() { local t="$1"; shift; "$@" 2>/dev/null; }
opencode() { printf '9.9.9-test\n'; }

# --- wrapper installation: idempotence, drift repair, symlink refusal ------
install_doctor_wrapper || fail "wrapper install"
WRAPPER="$HOME/.local/bin/doctor"
[[ -x "$WRAPPER" && ! -L "$WRAPPER" ]] || fail "wrapper missing or not executable"
head -n 2 "$WRAPPER" | grep -qF 'ocvm-doctor-wrapper v1' || fail "wrapper marker missing"
bash -n "$WRAPPER" || fail "wrapper bash -n"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck --severity=error -s bash "$WRAPPER" || fail "wrapper shellcheck"
fi
before_install="$(md5 < "$WRAPPER")"
install_doctor_wrapper || fail "wrapper reinstall"
[[ "$before_install" == "$(md5 < "$WRAPPER")" ]] || fail "idempotent reinstall rewrote the wrapper"
grep -v 'ocvm-doctor-wrapper v1' "$WRAPPER" > "$TMP/drifted" || true
mv "$TMP/drifted" "$WRAPPER"; chmod 755 "$WRAPPER"
install_doctor_wrapper || fail "wrapper drift reinstall"
head -n 2 "$WRAPPER" | grep -qF 'ocvm-doctor-wrapper v1' || fail "wrapper drift not repaired"
rm -f "$WRAPPER"
ln -s /etc/hosts "$WRAPPER"
if install_doctor_wrapper 2>/dev/null; then fail "symlinked wrapper was accepted"; fi
rm -f "$WRAPPER"
install_doctor_wrapper || fail "wrapper reinstall after symlink removal"
pass "wrapper install: marker, idempotence, drift repair, symlink refusal"

# wrapper usage/help/exit-2 matrix (no share needed)
run_wrapper() { local rc=0; env -i HOME="$HOME" PATH="/usr/bin:/bin" "$WRAPPER" "$@" > "$TMP/w.out" 2> "$TMP/w.err" || rc=$?; printf '%s' "$rc"; }
[[ "$(run_wrapper help)" == 0 ]] || fail "wrapper help rc"
need_out "$TMP/w.out" "read-only"
[[ "$(run_wrapper --help)" == 0 ]] || fail "wrapper --help rc"
[[ "$(run_wrapper bogus)" == 2 ]] || fail "wrapper unknown area rc"
need_out "$TMP/w.err" "Usage: doctor"
[[ "$(run_wrapper show extra)" == 2 ]] || fail "wrapper extra args rc"
pass "wrapper usage/help/exit-2 matrix"

# --- fixture world ---------------------------------------------------------
PROJECT="$TMP/project"
mkdir -p "$PROJECT/.opencode-vm/mcp" "$PROJECT/.opencode-vm/taskboard"
HASH="$(proj_hash "$PROJECT")"
SHARE="$TMP/.opencode-vm/sessions/$HASH"
SECRET_TOKEN='fixture-mcp-token-0123456789abcdef'
SECRET_SK='sk-tunnel-fixture-secret-9999'
SECRET_GHP='ghp_0123456789abcdefghijABCDEF'
SECRET_JWT='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlLXN1YmplY3QifQ'
SECRET_BASIC='Zml4dHVyZTpwYXNzd29yZA=='
SECRET_PAIR='SuperFixtureSecret1'
SECRET_DASH='FIXTUREDASHPASSWORD'
SECRET_TKEY='tunnelkey-fixture-secret-123456'
ALL_SECRETS="$SECRET_TOKEN $SECRET_SK $SECRET_GHP $SECRET_JWT $SECRET_BASIC $SECRET_PAIR $SECRET_DASH $SECRET_TKEY"

make_share() { # $1=dir $2=generation $3=pid -- full healthy web-session fixture
  local d="$1" gen="$2" pid="$3"
  mkdir -p "$d/mcp/adapter/dist" "$d/hub" "$d/dashboard" "$d/editor" "$d/openlive/adapter" "$d/lib"
  printf '{"schema":1,"project":"%s","projectHash":"%s","projectName":"project","backendUrl":"http://127.0.0.1:4095","generation":"%s","opencodeVersion":"9.9.9-test","listenHost":"127.0.0.1","listenPort":40961,"credentialFile":"%s/mcp/credential","managerFile":"%s/openlive/manager.json","taskboardUrl":"http://127.0.0.1:4096","taskboardMetadataFile":""}\n' \
    "$PROJECT" "$HASH" "$gen" "$d" "$d" > "$d/mcp/runtime.json"
  printf '{"schema":1,"projectHash":"%s","generation":"%s","host":"127.0.0.1","port":40961,"pid":%s}\n' "$HASH" "$gen" "$pid" > "$d/mcp/ready.json"
  printf '%s' "$SECRET_TOKEN" > "$d/mcp/credential"; chmod 600 "$d/mcp/credential"
  printf '%s' "$SECRET_TKEY" > "$d/mcp/tunnel-key"; chmod 600 "$d/mcp/tunnel-key"
  printf '{"version":"0.1.26"}\n' > "$d/mcp/adapter/package.json"
  printf 'opencode-vm-mcp-staging-v1\n' > "$d/mcp/adapter/.ocvm-managed"
  : > "$d/mcp/adapter/dist/main.js"
  {
    printf '%s\n' '[mcp] call={"timestamp":"2026-10-06T10:00:00.000Z","request":"aaaa1111-2222-3333-4444-555566667777","tool":"get_session_status","session_id":"ses_fix01","state":"started"}'
    printf '%s\n' '[mcp] call={"timestamp":"2026-10-06T10:00:01.000Z","request":"aaaa1111-2222-3333-4444-555566667777","tool":"get_session_status","state":"completed","duration_ms":42}'
    printf '%s\n' "[mcp] noisy line token=$SECRET_TOKEN Authorization: Basic $SECRET_BASIC key=$SECRET_SK"
  } > "$d/mcp/adapter.log"; chmod 600 "$d/mcp/adapter.log"
  printf '{"config_version":1,"control_plane":{"tunnel_id":"tunnel_fixture0123456789"},"health":{"unix_socket":"/tmp/ocvm-mcp-tunnel/health.sock"}}\n' > "$d/mcp/tunnel.yaml"
  printf '%s\n' "tunnel log line password=$SECRET_PAIR jwt=$SECRET_JWT" > "$d/mcp/tunnel.log"; chmod 600 "$d/mcp/tunnel.log"
  printf 'backend log ok\n' > "$d/mcp/backend.log"
  printf '{"schema":1,"projectHash":"%s","generation":"%s","hubPort":7784,"ready":true}\n' "$HASH" "$gen" > "$d/hub/runtime.json"
  printf '%s\n' "hub log ghp=$SECRET_GHP" > "$d/hub/server.log"
  printf '{"schema":1,"projectHash":"%s","generation":"%s","dashboardPort":7783,"ready":true}\n' "$HASH" "$gen" > "$d/dashboard/runtime.json"
  printf '{"auth":{"username":"u","password":"%s"},"runtime":{"opencodeVersion":"9.9.9-test","listenPort":7783},"schema":1,"projectHash":"%s","generation":"%s"}\n' "$SECRET_DASH" "$HASH" "$gen" > "$d/dashboard/runtime-input.json"
  printf '{"schema":1,"editorPort":7781,"backendPort":4095}\n' > "$d/editor/runtime.json"
  printf '{"schema":1,"projectId":"%s","generation":"%s","port":41100,"pid":%s,"executable":"/usr/bin/node","script":"%s/openlive/adapter/dist/remote/server.js"}\n' "$HASH" "$gen" "$pid" "$d" > "$d/openlive/gateway-ready.json"
  printf '{"version":"0.1.7"}\n' > "$d/openlive/adapter/package.json"
  printf '{"schema":1,"projectHash":"%s","runtimeDir":"%s","log":"%s","taskboardPort":7782}\n' "$HASH" "$PROJECT/.opencode-vm/taskboard" "$PROJECT/.opencode-vm/taskboard/taskboard.log" > "$PROJECT/.opencode-vm/taskboard/runtime.json"
  printf '{"schema":1,"project":"%s","epoch":"e1","next":3,"events":[{"event_id":"ev1","cursor":"c1","timestamp":"2026-10-06T09:59:00.000Z","type":"session.busy"},{"event_id":"ev2","cursor":"c2","timestamp":"2026-10-06T10:00:02.000Z","type":"message.completed"}],"observations":{},"watched":{}}\n' "$PROJECT" > "$PROJECT/.opencode-vm/mcp/activity.json"
  cat > "$d/lib/web.sh" <<'FAKEWEB'
mcp_tunnel_unit_description() { printf 'opencode-vm mcp tunnel fixture'; }
mcp_tunnel_guest_status() {
  if [ -n "${FIXTURE_TUNNEL_REFUSE:-}" ]; then
    echo "[mcp-tunnel] Service ownership mismatch; refusing to use or stop this unit." >&2
    return 1
  fi
  printf '{"process":"active","tunnelId":"tunnel_fixture0123456789","ready":%s,"controlPlane":"ready","connected":%s,"httpStatus":%s}\n' \
    "${FIXTURE_TUNNEL_READY:-true}" "${FIXTURE_TUNNEL_CONNECTED:-true}" "${FIXTURE_TUNNEL_HTTP:-0}"
}
FAKEWEB
}

# dead pid owned+reaped by this test (positive cleanup, primary status kept)
( : ) & DEAD_PID=$!
wait "$DEAD_PID" || true
LIVE_PID=$$
make_share "$SHARE" gen-1 "$LIVE_PID"

# staging regression: the real host staging function materializes the library
install_doctor_lib "$SHARE" || fail "install_doctor_lib"
[[ -f "$SHARE/lib/doctor.sh" && -f "$SHARE/lib/doctor.env" ]] || fail "staged files missing"
bash -n "$SHARE/lib/doctor.sh" || fail "staged library bash -n"
grep -qF "OCVM_SCRIPT_VERSION=$OCVM_VERSION" "$SHARE/lib/doctor.env" || fail "doctor.env script version"
ln -s "$TMP/shares" "$TMP/symshare"
if install_doctor_lib "$TMP/symshare" 2>/dev/null; then fail "symlinked share accepted by staging"; fi
pass "install_doctor_lib staging: files, bash -n, version stamp, symlink refusal"

# --- seams -----------------------------------------------------------------
MOUNT_FIXTURE=""
HOSTNAME_FIXTURE="lima-oc-20261006-171011"
UNIT_FIXTURE=""
LISTEN_FIXTURE=""
OPENCODE_PIDS=""
OPENCODE_PID=""
CURL_FAIL_HEALTH=""
CURL_FAIL_ADAPTER=""
NOW_FILE="$TMP/now-counter"
NOW_STEP=0
printf '1000' > "$NOW_FILE"
CURL_ARGS_LOG="$TMP/curl-args.log"
CURL_STDIN_LOG="$TMP/curl-stdin.log"
_doctor_mounts() { printf '%s\n' "$MOUNT_FIXTURE"; }
_doctor_hostname() { printf '%s' "$HOSTNAME_FIXTURE"; }
# File-backed clock: command substitutions run in subshells, so an in-memory
# counter would never advance. Production uses real `date +%s`.
_doctor_now() {
  local n
  n="$(cat "$NOW_FILE" 2>/dev/null || true)"
  case "$n" in ''|*[!0-9]*) n=1000 ;; esac
  n=$((n + NOW_STEP))
  printf '%s' "$n" > "$NOW_FILE"
  printf '%s' "$n"
}
_doctor_systemctl_show() {
  local u="$1" rec
  while IFS= read -r rec; do
    case "$rec" in
      "$u|"*) printf '%s\n' "${rec#*|}" | tr '|' '\n'; return 0 ;;
    esac
  done <<< "$UNIT_FIXTURE"
  printf 'LoadState=not-found\n'
  return 0
}
_doctor_listening() { case " $LISTEN_FIXTURE " in *" $1 "*) return 0 ;; esac; return 1; }
_doctor_pgrep_opencode() { printf '%s\n' $OPENCODE_PIDS; }
_doctor_proc_cwd() { if [ "$1" = "$OPENCODE_PID" ]; then printf '%s' "$PROJECT"; fi; }
_doctor_proc_cmdline() {
  if [ "$1" = "$OPENCODE_PID" ]; then
    printf 'opencode\nweb\n--hostname\n127.0.0.1\n--port\n4095\n'
  fi
}
curl() {
  printf '%s\n' "$*" >> "$CURL_ARGS_LOG"
  local url="" a wmode=0 has_config=0
  for a in "$@"; do
    case "$a" in http*) url="$a" ;; "%{http_code}") wmode=1 ;; "--config") has_config=1 ;; esac
  done
  if [ "$has_config" = 1 ] && [ ! -t 0 ]; then cat >> "$CURL_STDIN_LOG"; fi
  local out=""
  case "$url" in
    *"/global/health")
      if [ -n "$CURL_FAIL_HEALTH" ]; then return 1; fi
      out='{"healthy":true,"version":"9.9.9-test"}' ;;
    *"/path") out="{\"directory\":\"$PROJECT\",\"config\":\"/x\"}" ;;
    *":40961/healthz")
      if [ -n "$CURL_FAIL_ADAPTER" ]; then return 1; fi
      out="{\"healthy\":true,\"project\":{\"id\":\"$HASH\"},\"generation\":\"gen-1\"}" ;;
    *":7784/healthz") out='{"service":"agent-hub","status":"ok"}' ;;
    *":7783/healthz") out='{"service":"repo-dashboard","status":"ok"}' ;;
    *":7782/api/projects") out='[]' ;;
    *":7781/healthz")
      if [ "$wmode" = 1 ]; then printf '401'; return 0; fi
      return 1 ;;
    *":41100/openlive/info") out="{\"scriptVersion\":\"$OCVM_VERSION\"}" ;;
    *":4096/healthz") out='{}' ;;
    *)
      if [ "$wmode" = 1 ]; then printf '000'; return 0; fi
      return 1 ;;
  esac
  if [ "$wmode" = 1 ]; then printf '200'; return 0; fi
  printf '%s' "$out"
  return 0
}
mount_one() { MOUNT_FIXTURE="ocvm-share $TMP/.opencode-vm/sessions/$1 virtiofs rw,relatime 0 0"; }
unit_all() {
  UNIT_FIXTURE="ocvm-hub.service|LoadState=loaded|ActiveState=active|SubState=running|NRestarts=0|Description=opencode-vm hub $SHARE gen-1
ocvm-dashboard.service|LoadState=loaded|ActiveState=active|SubState=running|NRestarts=1|Description=opencode-vm dashboard $SHARE gen-1
ocvm-editor.service|LoadState=loaded|ActiveState=active|SubState=running|NRestarts=0|Description=opencode-vm editor $SHARE
ocvm-taskboard.service|LoadState=loaded|ActiveState=active|SubState=running|NRestarts=0|Description=opencode-vm taskboard $SHARE
ocvm-mcp-tunnel.service|LoadState=loaded|ActiveState=active|SubState=running|NRestarts=2|Description=opencode-vm mcp tunnel fixture"
}
run_main() { # area outfile errfile -> rc ; resets counters/clock
  local area="$1" out="$2" err="$3" rc=0
  printf '1000' > "$NOW_FILE"; NOW_STEP=0
  : > "$CURL_ARGS_LOG"; : > "$CURL_STDIN_LOG"
  DOCTOR_WALL_BUDGET=15 DOCTOR_LINE_BUDGET=150 DOCTOR_TMPDIR="$TMP/emptytmp" \
    doctor_main "$area" > "$out" 2> "$err" || rc=$?
  printf '%s' "$rc"
}
deny_secrets() { # file...
  local f s
  for f in "$@"; do
    for s in $ALL_SECRETS; do
      deny_out "$f" "$s"
    done
  done
}

# --- C1: full show report, healthy web session -----------------------------
mount_one "$HASH"; unit_all
OPENCODE_PIDS="4242"; OPENCODE_PID="4242"
LISTEN_FIXTURE="7784 7783 7781 7782 4096 4094 41100"
rc="$(run_main show "$TMP/c1.out" "$TMP/c1.err")"
[[ "$rc" == 0 ]] || { cat "$TMP/c1.out"; fail "C1 rc=$rc expected 0"; }
head -n 1 "$TMP/c1.out" | grep -qF '[vm-doctor]' || fail "C1 first line must be the buffered header"
need_out "$TMP/c1.out" "identity: PASS"
need_out "$TMP/c1.out" "project=$PROJECT hash=$HASH generation=gen-1"
need_out "$TMP/c1.out" "opencode-server:"
need_out "$TMP/c1.out" "readiness=PASS(/global/health healthy=true version=9.9.9-test"
need_out "$TMP/c1.out" "mcp-adapter: config=staged(0.1.26,managed-v1)"
need_out "$TMP/c1.out" "readiness=PASS(healthz token-verified"
need_out "$TMP/c1.out" "mcp-tunnel: config=configured(tunnel_id=tunnel_fixture0123456789)"
need_out "$TMP/c1.out" "readiness=PASS(ready control-plane=ready)"
need_out "$TMP/c1.out" "last-success=connected(control-plane success evidenced"
need_out "$TMP/c1.out" "last-tool-roundtrip: PASS 2026-10-06T10:00:01.000Z tool=get_session_status duration_ms=42"
need_out "$TMP/c1.out" "last-worker-event: 2026-10-06T10:00:02.000Z message.completed"
need_out "$TMP/c1.out" "NOT tool-roundtrip proof"
need_out "$TMP/c1.out" "script-staged=$OCVM_VERSION"
need_out "$TMP/c1.out" "script-live=$OCVM_VERSION"
need_out "$TMP/c1.out" "install-vs-checkout=UNVERIFIED(host-side fact)"
need_out "$TMP/c1.out" "SUMMARY: PASS="
need_out "$TMP/c1.out" "local checks only — NOT a ChatGPT/E2E acceptance"
grep -q 'FAIL=0 ' "$TMP/c1.out" || fail "C1 expected FAIL=0 in summary"
# editor readiness must be honest about auth instead of failing
need_out "$TMP/c1.out" "editor:"
grep -qE 'editor: .*UNVERIFIED\(HTTP 401' "$TMP/c1.out" || fail "C1 editor auth honesty"
# four dimensions separated on service lines
grep -qE 'hub: config=.* process=.* readiness=.* last-success=' "$TMP/c1.out" || fail "C1 hub dimensions"
# line + wall budgets respected
lines="$(wc -l < "$TMP/c1.out" | tr -d '[:space:]')"
[[ "$lines" -le 154 ]] || fail "C1 line count $lines exceeds budget+summary"
# token reached curl via stdin only, never argv
if grep -qF "$SECRET_TOKEN" "$CURL_ARGS_LOG"; then fail "C1 token leaked into curl argv"; fi
grep -qF "$SECRET_TOKEN" "$CURL_STDIN_LOG" || fail "C1 token not delivered via --config stdin"
deny_secrets "$TMP/c1.out" "$TMP/c1.err"
# tunnel_id is an identifier (host CLI precedent), not a secret
need_out "$TMP/c1.out" "tunnel_fixture0123456789"
pass "C1 full show report: identity/versions/services/roundtrip/budgets/redaction/stdin-token"

# --- C14: secrets on error paths (corrupt JSON everywhere) -----------------
CORRUPT="$TMP/.opencode-vm/sessions/$HASH"
cp "$CORRUPT/mcp/runtime.json" "$TMP/runtime.json.bak"
printf '{"schema":1,' > "$CORRUPT/mcp/runtime.json"   # truncated JSON
printf '{"schema":1,"projectHash":"%s","generation":"gen-1","host":"127.0.0.1","port":40961,"pid":%s}\n' "$HASH" "$LIVE_PID" > "$CORRUPT/mcp/ready.json"
printf '%s\n' "[mcp] call={\"timestamp\":\"x\",\"tool\":\"y\",\"state\":\"completed\"" >> "$CORRUPT/mcp/adapter.log"   # unparseable trace tail
CURL_FAIL_ADAPTER=1
rc="$(run_main show "$TMP/c14.out" "$TMP/c14.err")"
CURL_FAIL_ADAPTER=""
cp "$TMP/runtime.json.bak" "$CORRUPT/mcp/runtime.json"
[[ "$rc" == 1 ]] || fail "C14 rc=$rc expected 1 (probe failure with live pid is FAIL)"
need_out "$TMP/c14.out" "FAIL(healthz probe failed while adapter process is alive)"
need_out "$TMP/c14.out" "completed trace present but unparseable"
need_out "$TMP/c14.out" "/path probe and hash-confirmed"
deny_secrets "$TMP/c14.out" "$TMP/c14.err"
grep -q 'SUMMARY' "$TMP/c14.out" || fail "C14 summary must survive error paths"
# C14b: corrupt ready.json -> explicit unparseable finding + STALE FAIL
cp "$CORRUPT/mcp/ready.json" "$TMP/ready.json.bak"
printf '{"schema":1,' > "$CORRUPT/mcp/ready.json"
rc="$(run_main show "$TMP/c14b.out" "$TMP/c14b.err")"
cp "$TMP/ready.json.bak" "$CORRUPT/mcp/ready.json"
[[ "$rc" == 1 ]] || fail "C14b rc=$rc expected 1"
need_out "$TMP/c14b.out" "ready.json present but unparseable or field-less"
need_out "$TMP/c14b.out" "process=STALE(descriptor without live process)"
deny_secrets "$TMP/c14b.out" "$TMP/c14b.err"
pass "C14 corrupt descriptors + failing probe: honest FAILs, /path identity adoption, no secret leak, no abort"

# --- C5: stale ready.json (dead pid) ---------------------------------------
printf '{"schema":1,"projectHash":"%s","generation":"gen-1","host":"127.0.0.1","port":40961,"pid":%s}\n' "$HASH" "$DEAD_PID" > "$SHARE/mcp/ready.json"
rc="$(run_main show "$TMP/c5.out" "$TMP/c5.err")"
[[ "$rc" == 1 ]] || fail "C5 rc=$rc expected 1"
need_out "$TMP/c5.out" "process=STALE(descriptor without live process)"
grep -q 'names pid '"$DEAD_PID"' which is not alive' "$TMP/c5.out" || fail "C5 stale finding"
deny_secrets "$TMP/c5.out" "$TMP/c5.err"
printf '{"schema":1,"projectHash":"%s","generation":"gen-1","host":"127.0.0.1","port":40961,"pid":%s}\n' "$HASH" "$LIVE_PID" > "$SHARE/mcp/ready.json"
# stale gateway ready-file (dead pid) — same STALE semantics, isolated FAIL
cp "$SHARE/openlive/gateway-ready.json" "$TMP/gw.bak"
printf '{"schema":1,"projectId":"%s","generation":"gen-1","port":41100,"pid":%s,"executable":"/usr/bin/node","script":"%s/openlive/adapter/dist/remote/server.js"}\n' "$HASH" "$DEAD_PID" "$SHARE" > "$SHARE/openlive/gateway-ready.json"
rc="$(run_main show "$TMP/c5g.out" "$TMP/c5g.err")"
[[ "$rc" == 1 ]] || fail "C5g rc=$rc expected 1"
need_out "$TMP/c5g.out" "openlive-gateway: config=ready-file(port=41100) process=STALE(ready-file pid $DEAD_PID not alive)"
cp "$TMP/gw.bak" "$SHARE/openlive/gateway-ready.json"
pass "C5 stale adapter descriptor + stale gateway ready-file: STALE + FAIL, no repair"

# --- C6: wrong-project guards (hash mismatch, md5 mismatch) -----------------
cp "$SHARE/mcp/runtime.json" "$TMP/rt.bak"
printf '{"schema":1,"project":"%s","projectHash":"ffffffffffffffffffffffffffffffff","generation":"gen-1","backendUrl":"http://127.0.0.1:4095","opencodeVersion":"9.9.9-test"}\n' "$PROJECT" > "$SHARE/mcp/runtime.json"
rc="$(run_main show "$TMP/c6.out" "$TMP/c6.err")"
[[ "$rc" == 1 ]] || fail "C6a rc=$rc expected 1"
need_out "$TMP/c6.out" "does not match share id"
need_out "$TMP/c6.out" "wrong-project guard"
printf '{"schema":1,"project":"%s","projectHash":"%s","generation":"gen-1","backendUrl":"http://127.0.0.1:4095","opencodeVersion":"9.9.9-test"}\n' "$TMP/elsewhere" "$HASH" > "$SHARE/mcp/runtime.json"
rc="$(run_main show "$TMP/c6b.out" "$TMP/c6b.err")"
[[ "$rc" == 1 ]] || fail "C6b rc=$rc expected 1"
need_out "$TMP/c6b.out" "md5(project)"
cp "$TMP/rt.bak" "$SHARE/mcp/runtime.json"
pass "C6 wrong-project guards: hash and md5 mismatches fail closed"

# --- C7: mixed generations -> explicit STALE, no reconciliation ------------
printf '{"schema":1,"projectHash":"%s","generation":"gen-2","host":"127.0.0.1","port":40961,"pid":%s}\n' "$HASH" "$LIVE_PID" > "$SHARE/mcp/ready.json"
rc="$(run_main show "$TMP/c7.out" "$TMP/c7.err")"
need_out "$TMP/c7.out" "identity: STALE"
need_out "$TMP/c7.out" "generation mismatch: ready.json=gen-2 runtime.json=gen-1"
printf '{"schema":1,"projectHash":"%s","generation":"gen-1","host":"127.0.0.1","port":40961,"pid":%s}\n' "$HASH" "$LIVE_PID" > "$SHARE/mcp/ready.json"
pass "C7 mixed generations reported STALE explicitly"

# --- C4: ambiguity fail-closed (library and wrapper levels) -----------------
SHARE2="$TMP/.opencode-vm/sessions/0000000000000000000000000000ffff"
mkdir -p "$SHARE2/lib"
MOUNT_FIXTURE="ocvm-share $SHARE virtiofs rw 0 0
ocvm-share $SHARE2 virtiofs rw 0 0"
rc="$(run_main show "$TMP/c4.out" "$TMP/c4.err")"
[[ "$rc" == 3 ]] || fail "C4 rc=$rc expected 3"
need_out "$TMP/c4.out" "AMBIGUOUS"
need_out "$TMP/c4.out" "candidate: $SHARE"
need_out "$TMP/c4.out" "candidate: $SHARE2"
grep -q 'SUMMARY' "$TMP/c4.out" || fail "C4 summary must still print"
# wrapper-level ambiguity (real wrapper binary, seam env only)
printf '%s\n' "$MOUNT_FIXTURE" > "$TMP/mounts2"
rc=0
env -i HOME="$HOME" PATH="/usr/bin:/bin" OCVM_DOCTOR_MOUNTS_FILE="$TMP/mounts2" \
  "$WRAPPER" > "$TMP/c4w.out" 2>&1 || rc=$?
[[ "$rc" == 3 ]] || fail "C4 wrapper rc=$rc expected 3"
need_out "$TMP/c4w.out" "AMBIGUOUS"
MOUNT_FIXTURE="ocvm-share $SHARE virtiofs rw 0 0"
rm -rf "$SHARE2"
# C4b: wrapper-resolved share differs from library mount view -> fail closed
MISMATCH="$TMP/.opencode-vm/sessions/33333333333333333333333333330000"
mkdir -p "$MISMATCH/lib"
MOUNT_FIXTURE="ocvm-share $MISMATCH virtiofs rw 0 0"
rc=0
printf '1000' > "$NOW_FILE"; NOW_STEP=0
DOCTOR_WALL_BUDGET=15 DOCTOR_LINE_BUDGET=150 DOCTOR_TMPDIR="$TMP/emptytmp" \
  doctor_main show "$SHARE" > "$TMP/c4b.out" 2> "$TMP/c4b.err" || rc=$?
[[ "$rc" == 3 ]] || fail "C4b rc=$rc expected 3"
need_out "$TMP/c4b.out" "refusing the mixed view"
need_out "$TMP/c4b.out" "wrapper resolved '$SHARE' but runtime mounts resolve '$MISMATCH'"
MOUNT_FIXTURE="ocvm-share $SHARE virtiofs rw 0 0"
rm -rf "$MISMATCH"
pass "C4 multiple shares + C4b wrapper/library view mismatch: fail closed, never an arbitrary choice"

# --- C3: zero shares — session/base/foreign hostname matrix (wrapper) -------
: > "$TMP/mounts0"
for hn in "lima-oc-20261006-171011:3:FAIL" "oc-base:0:BASE" "lima-oc-base:0:BASE" "someotherhost:3:UNVERIFIED"; do
  name="${hn%%:*}"; rest="${hn#*:}"; want_rc="${rest%%:*}"; want_text="${rest#*:}"
  rc=0
  # hostname cannot be forged for the wrapper binary; library covers the matrix
  HOSTNAME_FIXTURE="$name"
  MOUNT_FIXTURE=""
  rc="$(run_main show "$TMP/c3.out" "$TMP/c3.err")"
  [[ "$rc" == "$want_rc" ]] || fail "C3 $name rc=$rc expected $want_rc"
  need_out "$TMP/c3.out" "$want_text"
done
HOSTNAME_FIXTURE="lima-oc-20261006-171011"
pass "C3 zero-share matrix: session FAIL/3, base BASE/0, foreign UNVERIFIED/3"

# --- C10/C11/C12: not configured / staged-but-stopped / opencode absent ----
BARE="$TMP/.opencode-vm/sessions/11111111111111111111111111110000"
mkdir -p "$BARE/lib"
cp "$SHARE/lib/doctor.sh" "$SHARE/lib/doctor.env" "$BARE/lib/" 2>/dev/null || true
mount_one "11111111111111111111111111110000"
UNIT_FIXTURE=""; LISTEN_FIXTURE=""; OPENCODE_PIDS=""; OPENCODE_PID=""
rc="$(run_main show "$TMP/c10.out" "$TMP/c10.err")"
[[ "$rc" == 0 ]] || { cat "$TMP/c10.out"; fail "C10 rc=$rc expected 0 (bare share has no FAIL evidence)"; }
need_out "$TMP/c10.out" "mcp-adapter: config=not-configured process=inactive readiness=UNVERIFIED(no descriptor)"
need_out "$TMP/c10.out" "mcp-tunnel: config=not-configured"
need_out "$TMP/c10.out" "UNVERIFIED(web library not staged"
need_out "$TMP/c10.out" "opencode-server: config=no-descriptor process=not-running(normal for idle shell/TUI sessions)"
need_out "$TMP/c10.out" "identity: UNVERIFIED (share mount only"
# staged adapter without ready.json => finding, still no FAIL
mkdir -p "$BARE/mcp/adapter/dist"
printf '{"version":"0.1.26"}\n' > "$BARE/mcp/adapter/package.json"
printf 'opencode-vm-mcp-staging-v1\n' > "$BARE/mcp/adapter/.ocvm-managed"
: > "$BARE/mcp/adapter/dist/main.js"
rc="$(run_main show "$TMP/c11.out" "$TMP/c11.err")"
[[ "$rc" == 0 ]] || fail "C11 rc=$rc expected 0"
need_out "$TMP/c11.out" "staged but no ready.json"
rm -rf "$BARE"
mount_one "$HASH"; unit_all
LISTEN_FIXTURE="7784 7783 7781 7782 4096 4094 41100"
OPENCODE_PIDS=""; OPENCODE_PID=""
rc="$(run_main show "$TMP/c12.out" "$TMP/c12.err")"
[[ "$rc" == 0 ]] || fail "C12 rc=$rc expected 0 (absent OpenCode is benign unknown)"
need_out "$TMP/c12.out" "process=not-running(normal for idle shell/TUI sessions) readiness=UNVERIFIED"
pass "C10-C12 not-configured/staged-stopped/opencode-absent stay honest, never FAIL"

# --- C13: broken MCP (probe fails / identity mismatch) ---------------------
OPENCODE_PIDS="4242"; OPENCODE_PID="4242"
CURL_FAIL_ADAPTER=1
rc="$(run_main show "$TMP/c13.out" "$TMP/c13.err")"
CURL_FAIL_ADAPTER=""
[[ "$rc" == 1 ]] || fail "C13 rc=$rc expected 1 (broken adapter with live pid is FAIL)"
need_out "$TMP/c13.out" "FAIL(healthz probe failed while adapter process is alive)"
need_out "$TMP/c13.out" "healthz unreachable on port 40961"
pass "C13 broken MCP adapter: isolated FAIL, other dimensions still reported"

# --- C19: tunnel canonical reuse + ownership refusal -----------------------
rc="$(run_main tunnel "$TMP/c19.out" "$TMP/c19.err")"
[[ "$rc" == 0 ]] || fail "C19 rc=$rc expected 0"
need_out "$TMP/c19.out" "mcp-tunnel:"
need_out "$TMP/c19.out" "guest=active"
need_out "$TMP/c19.out" "restarts=2"
need_out "$TMP/c19.out" "excerpt tunnel"
grep -qF '[vm-doctor] versions:' "$TMP/c19.out" && fail "C19 tunnel area must stay focused"
FIXTURE_TUNNEL_REFUSE=1
rc="$(run_main tunnel "$TMP/c19b.out" "$TMP/c19b.err")"
FIXTURE_TUNNEL_REFUSE=""
need_out "$TMP/c19b.out" "UNVERIFIED(canonical guest status unavailable or unit ownership mismatch — not touched)"
FIXTURE_TUNNEL_READY=false FIXTURE_TUNNEL_HTTP=401
rc="$(run_main tunnel "$TMP/c19c.out" "$TMP/c19c.err")"
FIXTURE_TUNNEL_READY="" FIXTURE_TUNNEL_HTTP=""
[[ "$rc" == 1 ]] || fail "C19c rc=$rc expected 1"
need_out "$TMP/c19c.out" "FAIL(not ready control-plane=ready httpStatus=401)"
need_out "$TMP/c19c.out" "tunnel control-plane HTTP status 401"
pass "C19 tunnel area: canonical guest status reuse, ownership refusal, not-ready FAIL"

# --- C17: worker event is not tool proof -----------------------------------
cp "$SHARE/mcp/adapter.log" "$TMP/adapter.log.bak"
printf '%s\n' '[mcp] call={"timestamp":"2026-10-06T11:00:00.000Z","request":"cccc3333-0000-0000-0000-000000000000","tool":"send_message","state":"started"}' > "$SHARE/mcp/adapter.log"
printf '%s\n' '[mcp] call={"timestamp":"2026-10-06T11:00:05.000Z","request":"cccc3333-0000-0000-0000-000000000000","tool":"send_message","state":"failed","error":"SESSION_BUSY","reason":"backend_activity","session_id":"ses_fix02","message_id":"msg_fix03"}' >> "$SHARE/mcp/adapter.log"
rc="$(run_main show "$TMP/c17.out" "$TMP/c17.err")"
need_out "$TMP/c17.out" "last-tool-roundtrip: UNVERIFIED (no completed tool trace"
need_out "$TMP/c17.out" "last-worker-event: 2026-10-06T10:00:02.000Z message.completed"
need_out "$TMP/c17.out" "SESSION_BUSY"
need_out "$TMP/c17.out" "ses_fix02"
cp "$TMP/adapter.log.bak" "$SHARE/mcp/adapter.log"
pass "C17 no completed trace => UNVERIFIED despite worker event; failed trace surfaces error code + support ids"

# --- C9: unreadable files degrade per-section (real non-root permissions) --
if [[ "$(id -u)" == 0 ]]; then
  pass "C9 SKIPPED (running as root; permission denial not enforceable) — noted as environment gap"
else
  chmod 000 "$SHARE/mcp/runtime.json" "$SHARE/hub/runtime.json"
  rc="$(run_main show "$TMP/c9.out" "$TMP/c9.err")"
  chmod 644 "$SHARE/mcp/runtime.json" "$SHARE/hub/runtime.json"
  [[ "$rc" == 0 || "$rc" == 1 ]] || fail "C9 rc=$rc must not abort (2/3/4 unexpected)"
  need_out "$TMP/c9.out" "SUMMARY"
  need_out "$TMP/c9.out" "identity: UNVERIFIED"   # runtime.json unreadable -> mount-only identity
  grep -qE 'hub: config=not-configured|hub: .*UNVERIFIED' "$TMP/c9.out" || fail "C9 hub section must degrade, not abort"
  deny_secrets "$TMP/c9.out" "$TMP/c9.err"
  pass "C9 unreadable descriptors: per-section UNVERIFIED, run continues, no leak"
fi

# --- C15/C16: global wall budget and line budget ---------------------------
printf '1000' > "$NOW_FILE"; NOW_STEP=8
rc=0
: > "$CURL_ARGS_LOG"; : > "$CURL_STDIN_LOG"
DOCTOR_WALL_BUDGET=15 DOCTOR_LINE_BUDGET=150 DOCTOR_TMPDIR="$TMP/emptytmp" \
  doctor_main show > "$TMP/c15.out" 2> "$TMP/c15.err" || rc=$?
NOW_STEP=0
n_budget="$(grep -c 'BUDGET_EXCEEDED section=' "$TMP/c15.out" || true)"
[[ "$n_budget" -ge 2 ]] || fail "C15 expected multiple BUDGET_EXCEEDED sections (global budget), got $n_budget"
need_out "$TMP/c15.out" "WALL_BUDGET_EXCEEDED"
grep -q 'SUMMARY' "$TMP/c15.out" || fail "C15 summary must survive budget exhaustion"
rc=0
DOCTOR_WALL_BUDGET=15 DOCTOR_LINE_BUDGET=20 DOCTOR_TMPDIR="$TMP/emptytmp" \
  doctor_main show > "$TMP/c16.out" 2> "$TMP/c16.err" || rc=$?
need_out "$TMP/c16.out" "LINE_BUDGET_EXCEEDED"
total16="$(wc -l < "$TMP/c16.out" | tr -d '[:space:]')"
[[ "$total16" -le 24 ]] || fail "C16 total lines $total16 exceeded 20+forced summary bound"
deny_secrets "$TMP/c15.out" "$TMP/c15.err" "$TMP/c16.out" "$TMP/c16.err"
pass "C15/C16 global wall budget truncates whole run; line budget caps output"

# --- C20: usage discipline at library level --------------------------------
rc="$(run_main bogus "$TMP/c20.out" "$TMP/c20.err")"
[[ "$rc" == 2 ]] || fail "C20 rc=$rc expected 2"
need_out "$TMP/c20.err" "Usage: doctor"
pass "C20 unknown area exits 2 with usage"

# --- C18: no-mutation proof over a full healthy run -------------------------
snapshot() {
  local d="$1" f rel mode size dg
  ( cd "$d" && find . -type f | LC_ALL=C sort ) | while IFS= read -r rel; do
    f="$d/$rel"
    mode="$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null)"
    size="$(wc -c < "$f" | tr -d '[:space:]')"
    dg="$(md5 < "$f")"
    printf '%s %s %s %s\n' "$rel" "$mode" "$size" "$dg"
  done
}
mount_one "$HASH"; unit_all; LISTEN_FIXTURE="7784 7783 7781 7782 4096 4094 41100"
OPENCODE_PIDS="4242"; OPENCODE_PID="4242"
snapshot "$SHARE" > "$TMP/snap-share-before"
snapshot "$PROJECT" > "$TMP/snap-proj-before"
snapshot "$HOME" > "$TMP/snap-home-before"
n_before="$(find "$TMP/emptytmp" -mindepth 1 | wc -l | tr -d '[:space:]')"
rc="$(run_main show "$TMP/c18.out" "$TMP/c18.err")"
[[ "$rc" == 0 ]] || fail "C18 rc=$rc expected 0"
snapshot "$SHARE" > "$TMP/snap-share-after"
snapshot "$PROJECT" > "$TMP/snap-proj-after"
snapshot "$HOME" > "$TMP/snap-home-after"
cmp -s "$TMP/snap-share-before" "$TMP/snap-share-after" || fail "C18 session share mutated"
cmp -s "$TMP/snap-proj-before" "$TMP/snap-proj-after" || fail "C18 project dir mutated"
cmp -s "$TMP/snap-home-before" "$TMP/snap-home-after" || fail "C18 HOME mutated"
n_after="$(find "$TMP/emptytmp" -mindepth 1 | wc -l | tr -d '[:space:]')"
[[ "$n_before" == 0 && "$n_after" == 0 ]] || fail "C18 doctor created files in its tmp dir"
[[ -z "$(jobs -p)" ]] || fail "C18 leftover background jobs"
if ! ps -p "$DEAD_PID" >/dev/null 2>&1; then :; else fail "C18 dead fixture pid unexpectedly alive"; fi
pass "C18 noMutation: share/project/HOME bytes+modes identical, no new files, no leftover jobs"

# --- C2: real wrapper end-to-end from foreign cwd with clean env ------------
# Uses the real staged library; external probes hit loopback fixture ports and
# fail fast (connection refused) — honest UNVERIFIED/FAIL outcomes accepted.
mounts_file="$TMP/mounts-e2e"
printf '%s %s\n' "$SHARE" "virtiofs" > "$mounts_file"
# /proc/mounts format: "<device> <mountpoint> <fstype> ..." — mountpoint is $2
printf 'opencode-vm %s virtiofs rw,relatime 0 0\n' "$SHARE" > "$mounts_file"
for cwd in / "$TMP"; do
  rc=0
  env -i HOME="$HOME" PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    OCVM_DOCTOR_MOUNTS_FILE="$mounts_file" DOCTOR_TMPDIR="$TMP/emptytmp" \
    DOCTOR_WALL_BUDGET=25 DOCTOR_PROBE_TIMEOUT=1 \
    /bin/bash -c 'cd "$1" && doctor' _ "$cwd" > "$TMP/c2-$$.out" 2> "$TMP/c2-$$.err" || rc=$?
  case "$rc" in 0|1) ;; *) cat "$TMP/c2-$$.out" "$TMP/c2-$$.err"; fail "C2 cwd=$cwd rc=$rc expected 0|1" ;; esac
  need_out "$TMP/c2-$$.out" "share=$SHARE"
  need_out "$TMP/c2-$$.out" "SUMMARY"
  if grep -E 'share=|candidate: ' "$TMP/c2-$$.out" | grep -qvF "$TMP"; then
    fail "C2 hermeticity: a non-fixture share was referenced"
  fi
  deny_secrets "$TMP/c2-$$.out" "$TMP/c2-$$.err"
done
# focused area through the wrapper as well
rc=0
env -i HOME="$HOME" PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  OCVM_DOCTOR_MOUNTS_FILE="$mounts_file" DOCTOR_TMPDIR="$TMP/emptytmp" DOCTOR_PROBE_TIMEOUT=1 \
  /bin/bash -c 'cd / && doctor tunnel' > "$TMP/c2t.out" 2> "$TMP/c2t.err" || rc=$?
case "$rc" in 0|1) ;; *) fail "C2 tunnel rc=$rc" ;; esac
need_out "$TMP/c2t.out" "mcp-tunnel:"
# wrapper degradation: share without staged library
NOLIB="$TMP/.opencode-vm/sessions/22222222222222222222222222220000"
mkdir -p "$NOLIB"
printf 'opencode-vm %s virtiofs rw,relatime 0 0\n' "$NOLIB" > "$TMP/mounts-nolib"
rc=0
env -i HOME="$HOME" PATH="/usr/bin:/bin" OCVM_DOCTOR_MOUNTS_FILE="$TMP/mounts-nolib" \
  "$WRAPPER" > "$TMP/c2n.out" 2>&1 || rc=$?
[[ "$rc" == 4 ]] || fail "C2 missing-library rc=$rc expected 4"
need_out "$TMP/c2n.out" "canonical library not staged"
rm -rf "$NOLIB"
pass "C2 wrapper end-to-end: any cwd, clean env, focused area, missing-library exit 4"

# --- final hygiene ----------------------------------------------------------
[[ -z "$(jobs -p)" ]] || fail "leftover background jobs at end"
printf 'ALL_PASS vm_doctor_test (%s, Bash %s)\n' "$(uname -s)" "$BASH_VERSION"
