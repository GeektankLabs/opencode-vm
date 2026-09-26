#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/opencode-vm.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "expected '$2', got '$1'"; }

export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME"
# shellcheck disable=SC1090
source "$SCRIPT"

AUTH="$HOST_DATA_DIR/auth.json"
case " ${DATA_RSYNC_EXCLUDES[*]} " in
  *" --exclude=auth.json "*) ;;
  *) fail "generic data rsync still treats auth.json as history" ;;
esac
senv="$TMP/session.env"
write_senv "$senv" test-vm /project hash web 4096 0 1 auth-generation
# shellcheck disable=SC1090
source "$senv"
assert_eq "$SESS_AUTH_GENERATION" auth-generation
pass "session tracking carries auth generation and generic history excludes credentials"

proj_hash() { printf 'provider-lock-test\n'; }
lifecycle_lock_acquire /project
[[ -L "$LIFECYCLE_LOCK_LINK" ]] || fail "lifecycle lock was not acquired atomically"
lifecycle_lock_release
lock_root="$SESSIONS_DIR/.locks"
mkdir -p "$lock_root/stale-claim"
printf '%s\n' 99999999 > "$lock_root/stale-claim/pid"
ln -s stale-claim "$lock_root/provider-lock-test.lock"
lifecycle_lock_acquire /project
[[ -L "$LIFECYCLE_LOCK_LINK" ]] || fail "stale lifecycle lock was not recovered"
lifecycle_lock_release
pass "lifecycle ownership lock acquires, releases, and recovers dead owners"

mkdir -p "$AUTH_SYNC_DIR/stale-claim"
printf '%s\n' 99999999 > "$AUTH_SYNC_DIR/stale-claim/pid"
ln -s stale-claim "$AUTH_SYNC_DIR/.lock"
_auth_sync_lock
_auth_sync_unlock
[[ ! -L "$AUTH_SYNC_DIR/.lock" ]] || fail "auth lock was not released after stale-owner recovery"
pass "auth synchronization lock recovers dead owners without a persistent recovery sentinel"

reset_auth() {
  rm -rf "$AUTH_SYNC_DIR" "$HOST_DATA_DIR"
  mkdir -p "$HOST_DATA_DIR"
}

reset_auth
cat > "$AUTH" <<'JSON'
{"openai":{"type":"oauth","access":"a0","refresh":"r0","expires":900},"local":{"type":"api","key":"k0"}}
JSON
auth_sync_begin /project gen-one
cat > "$TMP/candidate-one.json" <<'JSON'
{"local":{"key":"k0","type":"api"},"openai":{"expires":100,"refresh":"r1","access":"a1","type":"oauth"},"anthropic":{"type":"api","key":"ak"}}
JSON
auth_sync_finalize gen-one "$TMP/candidate-one.json" >/dev/null
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" r1
assert_eq "$(jq -r '.anthropic.key' "$AUTH")" ak
pass "single-runtime changes merge per provider and ignore JSON key order"

reset_auth
cat > "$AUTH" <<'JSON'
{"openai":{"type":"oauth","access":"base","refresh":"base","expires":500}}
JSON
auth_sync_begin /project gen-early
auth_sync_begin /project gen-late
cat > "$TMP/early.json" <<'JSON'
{"openai":{"type":"oauth","access":"early","refresh":"early","expires":999999}}
JSON
cat > "$TMP/late.json" <<'JSON'
{"openai":{"type":"oauth","access":"late","refresh":"late","expires":1}}
JSON
auth_sync_finalize gen-early "$TMP/early.json" >/dev/null
auth_sync_finalize gen-late "$TMP/late.json" >/dev/null
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" late
completion="$(jq -r '.completion' "$AUTH_SYNC_DIR/runs/gen-late/manifest.json")"
auth_sync_finalize gen-late "$TMP/late.json" >/dev/null
assert_eq "$(jq -r '.completion' "$AUTH_SYNC_DIR/runs/gen-late/manifest.json")" "$completion"
assert_eq "$(jq -r '.nextCompletion' "$AUTH_SYNC_DIR/state.json")" 3
pass "later controlled OAuth completion wins without expiry ranking and retries stay ordered"

# Simulate interruption after auth.json publication but before completion
# metadata was committed. The prepared hash must repair provenance on retry.
state_tmp="$TMP/state-recovery.json"
jq '.providers.openai.completion = null' "$AUTH_SYNC_DIR/state.json" > "$state_tmp"
mv "$state_tmp" "$AUTH_SYNC_DIR/state.json"
published_hash="$(_auth_sync_hash_file "$AUTH")"
login_revision_before="$(jq -r '.providers.openai.loginRevision' "$AUTH_SYNC_DIR/state.json")"
manifest_tmp="$TMP/manifest-recovery.json"
jq --arg hash "$published_hash" '.publishingHash=$hash | .publishingProviders=["openai"] | .candidateHash=null' \
  "$AUTH_SYNC_DIR/runs/gen-late/manifest.json" > "$manifest_tmp"
mv "$manifest_tmp" "$AUTH_SYNC_DIR/runs/gen-late/manifest.json"
auth_sync_finalize gen-late "$TMP/late.json" >/dev/null
assert_eq "$(jq -r '.providers.openai.completion' "$AUTH_SYNC_DIR/state.json")" "$completion"
assert_eq "$(jq -r '.providers.openai.loginRevision' "$AUTH_SYNC_DIR/state.json")" "$login_revision_before"
assert_eq "$(jq -r '.publishingHash' "$AUTH_SYNC_DIR/runs/gen-late/manifest.json")" null
pass "interrupted publication repairs completion metadata without inventing an external login"

reset_auth
cat > "$AUTH" <<'JSON'
{"openai":{"type":"oauth","access":"base","refresh":"base","expires":500}}
JSON
auth_sync_begin /project stale-copy
auth_sync_begin /project changed-copy
cp "$AUTH" "$TMP/stale.json"
cat > "$TMP/changed.json" <<'JSON'
{"openai":{"type":"oauth","access":"new","refresh":"new","expires":600}}
JSON
auth_sync_finalize changed-copy "$TMP/changed.json" >/dev/null
auth_sync_finalize stale-copy "$TMP/stale.json" >/dev/null
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" new
pass "an unchanged stale runtime never overwrites a newer host entry"

reset_auth
cat > "$AUTH" <<'JSON'
{"custom":{"type":"api","key":"base"}}
JSON
auth_sync_begin /project api-first
auth_sync_begin /project api-second
printf '%s\n' '{"custom":{"type":"api","key":"first"}}' > "$TMP/api-first.json"
printf '%s\n' '{"custom":{"type":"api","key":"second"}}' > "$TMP/api-second.json"
auth_sync_finalize api-first "$TMP/api-first.json" >/dev/null
auth_sync_finalize api-second "$TMP/api-second.json" >/dev/null 2> "$TMP/api-conflict.err"
assert_eq "$(jq -r '.custom.key' "$AUTH")" first
assert_eq "$(jq -r '.conflicts' "$AUTH_SYNC_DIR/runs/api-second/manifest.json")" 1
[[ -f "$AUTH_SYNC_DIR/runs/api-second/candidate.json" ]] || fail "conflicting candidate was not preserved"
pass "non-OAuth conflicts preserve the host and durable candidate"

# An auth format the merge does not understand (for example after an OpenCode
# update) falls back to publishing the newest runtime file wholesale.
reset_auth
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"a","expires":1}}' > "$AUTH"
auth_sync_begin /project future-format
printf '%s\n' '{"openai":{"type":"quantum","tokens":["t"]}}' > "$TMP/future.json"
auth_sync_finalize future-format "$TMP/future.json" 2> "$TMP/future.err"
assert_eq "$(jq -r '.openai.type' "$AUTH")" quantum
assert_eq "$(jq -r '.mergeFallback' "$AUTH_SYNC_DIR/runs/future-format/manifest.json")" true
grep -q 'wholesale' "$TMP/future.err" || fail "whole-copy fallback did not warn"
pass "an unrecognized runtime auth format falls back to a wholesale copy"

reset_auth
printf '%s\n' '{"openai":{"type":"quantum","tokens":["t"]}}' > "$AUTH"
auth_sync_begin /project future-host 2> "$TMP/future-host.err"
grep -q 'WARNING' "$TMP/future-host.err" || fail "unsupported host format did not warn at begin"
assert_eq "$(jq -r '.mergeFallback' "$AUTH_SYNC_DIR/runs/future-host/manifest.json")" true
printf '%s\n' '{"openai":{"type":"quantum","tokens":["t2"]}}' > "$TMP/future-host-candidate.json"
auth_sync_finalize future-host "$TMP/future-host-candidate.json" 2> "$TMP/future-host-final.err"
assert_eq "$(jq -r '.openai.tokens[0]' "$AUTH")" t2
pass "an unrecognized host auth format is published wholesale at finalization"

reset_auth
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"r","expires":1}}' > "$AUTH"
auth_sync_begin /project logout-run
auth_sync_begin /project older-run
auth_sync_begin /project older-explicit-login
auth_sync_begin /project old-logout
printf '%s\n' '{}' > "$TMP/deleted.json"
printf '%s\n' '{"openai":{"type":"oauth","access":"old-new","refresh":"old-new","expires":999}}' > "$TMP/older.json"
auth_sync_finalize logout-run "$TMP/deleted.json" >/dev/null
assert_eq "$(jq -r 'has("openai")' "$AUTH")" false
[[ "$(jq -r '.providers.openai.tombstone' "$AUTH_SYNC_DIR/state.json")" != null ]] || fail "logout tombstone was not recorded"
auth_sync_finalize older-run "$TMP/older.json" >/dev/null 2> "$TMP/delete.err"
assert_eq "$(jq -r 'has("openai")' "$AUTH")" false
printf '%s\n' '{"openai":{"type":"oauth","access":"new","refresh":"new","expires":2}}' > "$TMP/relogin.json"
auth_sync_mark_intent older-explicit-login openai login
auth_sync_finalize older-explicit-login "$TMP/relogin.json" >/dev/null
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" new
assert_eq "$(jq -r '.providers.openai.tombstone' "$AUTH_SYNC_DIR/state.json")" null
auth_sync_finalize old-logout "$TMP/deleted.json" >/dev/null 2> "$TMP/old-logout.err"
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" new
pass "global logout tombstones block stale runtimes while an explicitly logged-in older runtime clears them"

reset_auth
printf '%s\n' '{"openai":{"type":"oauth","access":"same","refresh":"same","expires":1}}' > "$AUTH"
auth_sync_begin /project identical-login
auth_sync_begin /project older-identical-logout
cp "$AUTH" "$TMP/identical-login.json"
auth_sync_mark_intent identical-login openai login
auth_sync_finalize identical-login "$TMP/identical-login.json" >/dev/null
printf '%s\n' '{}' > "$TMP/identical-logout.json"
auth_sync_finalize older-identical-logout "$TMP/identical-logout.json" >/dev/null 2> "$TMP/identical-logout.err"
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" same
assert_eq "$(jq -r '.conflicts' "$AUTH_SYNC_DIR/runs/older-identical-logout/manifest.json")" 1
pass "an explicit byte-identical login records provenance and blocks an older logout"

auth_sync_begin /project logout-before-external-login
printf '%s\n' '{"openai":{"type":"oauth","access":"external","refresh":"external","expires":2}}' > "$AUTH"
auth_sync_begin /project refresh-after-external-login
printf '%s\n' '{"openai":{"type":"oauth","access":"refreshed","refresh":"refreshed","expires":3}}' > "$TMP/refreshed-after-external.json"
auth_sync_finalize refresh-after-external-login "$TMP/refreshed-after-external.json" >/dev/null
auth_sync_finalize logout-before-external-login "$TMP/identical-logout.json" >/dev/null 2> "$TMP/logout-before-external.err"
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" refreshed
assert_eq "$(jq -r '.conflicts' "$AUTH_SYNC_DIR/runs/logout-before-external-login/manifest.json")" 1
pass "explicit-login revisions keep later external logins newer than older logout baselines"

reset_auth
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"a","expires":1}}' > "$AUTH"
auth_sync_begin /project explicit-before-cycle
printf '%s\n' '{"openai":{"type":"oauth","access":"b","refresh":"b","expires":2}}' > "$AUTH"
auth_sync_begin /project observe-b
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"a","expires":1}}' > "$AUTH"
auth_sync_begin /project logout-at-returned-a
auth_sync_mark_intent explicit-before-cycle openai login
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"a","expires":1}}' > "$TMP/cycled-explicit-login.json"
auth_sync_finalize explicit-before-cycle "$TMP/cycled-explicit-login.json" >/dev/null
auth_sync_finalize logout-at-returned-a "$TMP/identical-logout.json" >/dev/null 2> "$TMP/cycled-logout.err"
assert_eq "$(jq -r '.openai.refresh' "$AUTH")" a
assert_eq "$(jq -r '.conflicts' "$AUTH_SYNC_DIR/runs/logout-at-returned-a/manifest.json")" 1
pass "A-B-A credentials still allocate a newer explicit-login revision than a predating logout"


reset_auth
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"r","expires":1},"local":{"type":"api","key":"k"}}' > "$AUTH"
if provider_cmd subscription rm missing-provider >/dev/null 2>&1; then fail "rm accepted a missing credential"; fi
if provider_cmd subscription rm local >/dev/null 2>&1; then fail "rm accepted a non-subscription credential"; fi
provider_cmd subscription rm openai --dry-run > "$TMP/sub-dry.out"
[[ "$(jq -r 'has("openai")' "$AUTH")" == true ]] || fail "dry-run removed the credential"
grep -q 'Dry-run only' "$TMP/sub-dry.out" || fail "subscription dry-run did not report"
provider_cmd subscription rm openai > "$TMP/sub-rm.out"
assert_eq "$(jq -r 'has("openai")' "$AUTH")" false
assert_eq "$(jq -r 'has("local")' "$AUTH")" true
assert_eq "$(jq -r '.providers.openai.tombstone' "$AUTH_SYNC_DIR/state.json")" 1
assert_eq "$(jq -r '.providers.openai.revision' "$AUTH_SYNC_DIR/state.json")" 1
pass "subscription rm removes the stored credential host-side and records a tombstone"

# A runtime that started before the removal must not restore the credential.
rm -rf "$AUTH_SYNC_DIR"
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"a","expires":1}}' > "$AUTH"
auth_sync_begin /project before-removal
printf '%s\n' '{"openai":{"type":"oauth","access":"a","refresh":"a","expires":1}}' > "$TMP/held.json"
provider_cmd subscription rm openai >/dev/null 2>&1
auth_sync_finalize before-removal "$TMP/held.json" >/dev/null 2>&1
assert_eq "$(jq -r 'has("openai")' "$AUTH")" false
pass "a stale runtime cannot restore a host-side removed subscription"

# --- pre-baseline attach resolution ---
reset_auth
mkdir -p "$AUTH_SYNC_DIR/runs/legacy-gen"
printf '%s\n' '{"a":{"type":"api","key":"ka"},"b":{"type":"oauth","access":"old","refresh":"r","expires":1},"c":{"type":"api","key":"kc"}}' > "$AUTH"
printf '%s\n' '{"a":{"type":"api","key":"ka"},"b":{"type":"oauth","access":"new","refresh":"r","expires":2},"d":{"type":"api","key":"kd"}}' > "$AUTH_SYNC_DIR/runs/legacy-gen/candidate.json"
_attach_legacy_choice_required "$AUTH_SYNC_DIR/runs/legacy-gen/candidate.json" || fail "differing session state did not require a choice"
printf '%s\n' '{"a":{"type":"api","key":"ka"}}' > "$TMP/identical-candidate.json"
printf '%s\n' '{"a":{"type":"api","key":"ka"}}' > "$AUTH"
if _attach_legacy_choice_required "$TMP/identical-candidate.json"; then fail "identical state required a choice"; fi
printf '%s\n' '{"a":{"type":"api","key":"ka"},"b":{"type":"oauth","access":"old","refresh":"r","expires":1},"c":{"type":"api","key":"kc"}}' > "$AUTH"
prompt_out="$(printf 's\n' | _attach_legacy_prompt legacy-gen "$AUTH_SYNC_DIR/runs/legacy-gen/candidate.json" 2>&1)" || fail "session adoption failed"
assert_eq "$(jq -r '.b.access' "$AUTH")" new
assert_eq "$(jq -r 'has("c")' "$AUTH")" true
assert_eq "$(jq -r 'has("d")' "$AUTH")" true
[[ -f "$AUTH_SYNC_DIR/runs/legacy-gen/legacy-host-before-adopt.json" ]] || fail "pre-adoption host backup missing"
if [[ "$prompt_out" == *"ka"* || "$prompt_out" == *"kc"* || "$prompt_out" == *"kd"* ]]; then fail "legacy prompt exposed credential values"; fi
pass "pre-baseline attach unions session credentials over the host state without leaking values"

reset_auth
mkdir -p "$AUTH_SYNC_DIR/runs/legacy-gen"
printf '%s\n' '{"b":{"type":"oauth","access":"host","refresh":"r","expires":1}}' > "$AUTH"
printf '%s\n' '{"b":{"type":"oauth","access":"session","refresh":"r","expires":2}}' > "$AUTH_SYNC_DIR/runs/legacy-gen/candidate.json"
printf 'h\n' | _attach_legacy_prompt legacy-gen "$AUTH_SYNC_DIR/runs/legacy-gen/candidate.json" >/dev/null 2>&1 || fail "host choice failed"
assert_eq "$(jq -r '.b.access' "$AUTH")" host
if printf 'c\n' | _attach_legacy_prompt legacy-gen "$AUTH_SYNC_DIR/runs/legacy-gen/candidate.json" >/dev/null 2>&1; then fail "cancel was accepted"; fi
assert_eq "$(jq -r '.b.access' "$AUTH")" host
pass "pre-baseline attach keeps the host state on host and cancel choices"

# The removed CLI commands must stay removed.
for removed in login logout refresh; do
  if provider_cmd "$removed" >/dev/null 2>&1; then fail "removed command '$removed' still accepted"; fi
done
if provider_cmd subscription add >/dev/null 2>&1; then fail "subscription add still accepted"; fi
if provider_cmd add >/dev/null 2>&1; then fail "flat add still accepted"; fi
if provider_cmd rm >/dev/null 2>&1; then fail "flat rm still accepted"; fi
provider_cmd help > "$TMP/provider-help.out"
grep -q 'provider custom sync' "$TMP/provider-help.out" || fail "provider help missing custom sync"
grep -q 'provider subscription rm' "$TMP/provider-help.out" || fail "provider help missing subscription rm"
provider_cmd subscription new > "$TMP/sub-new.out"
grep -q '/model' "$TMP/sub-new.out" || fail "subscription guidance missing the /model shortcut"
grep -q 'Anbieter verbinden' "$TMP/sub-new.out" || fail "subscription guidance missing the localized label"
pass "provider surface exposes the new tree and the WebUI guidance"

# --- live list payload (web server and opencode CLI mocked) ---
action_senv="$TMP/action.env"
action_share="$TMP/action-share"
mkdir -p "$TMP/vm-data/opencode" "$action_share/xdg-data/opencode" "$action_share/lib"
write_senv "$action_senv" action-vm /project hash web 4096 0 1 action-gen action-controller
session_env() { printf '%s\n' "$action_senv"; }
session_share_dir() { printf '%s\n' "$action_share"; }
is_vm_running() { [[ "${MOCK_VM_STATE:-running}" == running ]]; }
export PROVIDER_TMP="$TMP" MOCK_PIDS=42 MOCK_VERSION=1.18.31
printf '%s\n' "$OCVM_WEB_LIB_SH" > "$action_share/lib/web.sh"
printf '%s\0' opencode web --hostname 127.0.0.1 --port 5551 > "$TMP/cmdline"
printf '%s\n' 'OPENCODE_SERVER_USERNAME=test-user' 'OPENCODE_SERVER_PASSWORD=test-password' > "$action_share/auth.env"

opencode() {
  case "$*" in
    --version) printf '%s\n' "$MOCK_VERSION" ;;
    *) return 98 ;;
  esac
}
pgrep() {
  [[ "$*" == '-x opencode' ]] || return 97
  [[ -n "$MOCK_PIDS" ]] && printf '%s\n' "$MOCK_PIDS"
}
readlink() {
  if [[ "$1" == /proc/42/cwd ]]; then pwd -P; else command readlink "$@"; fi
}
curl() {
  local config verb=GET target="" path
  config="$(command cat)"
  [[ "$config" == "header = \"Authorization: Basic $(printf '%s' 'test-user:test-password' | base64 -w0)\"" ]] || return 92
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -q|-fsS) shift ;;
      --config) [[ "$2" == - ]] || return 93; shift 2 ;;
      -X) verb="$2"; shift 2 ;;
      --max-time) shift 2 ;;
      http://127.0.0.1:5551/*) target="$1"; shift ;;
      *) return 93 ;;
    esac
  done
  [[ "$target" == *"?directory=$(pwd -P | tr -d '\n' | jq -sRr @uri)" ]] || return 93
  path="${target#http://127.0.0.1:5551}"
  path="${path%%\?*}"
  case "$verb $path" in
    'GET /global/health') jq -cn --arg v "$MOCK_VERSION" '{healthy:true,version:$v}' ;;
    'GET /path') jq -n --arg project "${MOCK_PROJECT:-$(pwd -P)}" --arg config "$XDG_CONFIG_HOME/opencode" '{directory:$project,config:$config}' ;;
    'GET /provider')
      case "${MOCK_HTTP:-ok}" in
        ok) jq -cn --argjson connected "${MOCK_CONNECTED:-[\"local\"]}" '{all:[{id:"openai",key:"must-not-print"},{id:"local"},{id:"disabled"},{id:"internal-marker"}],connected:$connected}' ;;
        invalid) printf '%s\n' '{"providers":[]}' ;;
        fail) return 22 ;;
        *) return 94 ;;
      esac ;;
    *) return 95 ;;
  esac
}
export -f opencode pgrep readlink curl

vm_exec() {
  local code="$2"
  shift 2
  code="${code//\/tmp\/oc-xdg-data/$TMP/vm-data}"
  code="${code//\/proc\/\$pid\/cmdline/$TMP/cmdline}"
  bash -c "$code" _ "$@"
}

printf '%s\n' '{"openai":{"type":"api","key":"still-present"}}' > "$TMP/vm-data/opencode/auth.json"
vm_exec action-vm "$OCVM_PROVIDER_VM_SH" list "$action_share" "$ROOT" internal-marker > "$TMP/list.out"
grep -q $'local\tendpoint\tlive\tcredentials=no\tavailable=yes' "$TMP/list.out" || fail "local runtime provider unavailable"
grep -q $'openai\tapi\tlive\tcredentials=yes\tavailable=no' "$TMP/list.out" || fail "credentials mistaken for runtime availability"
if grep -Eq 'must-not-print|still-present|internal-marker|test-password' "$TMP/list.out"; then fail "list leaked secrets or marker"; fi
for MOCK_HTTP in invalid fail; do
  export MOCK_HTTP
  if vm_exec action-vm "$OCVM_PROVIDER_VM_SH" list "$action_share" "$ROOT" internal-marker >/dev/null 2>&1; then fail "list accepted $MOCK_HTTP response"; fi
done
unset MOCK_HTTP
export MOCK_PROJECT=/wrong-project
if vm_exec action-vm "$OCVM_PROVIDER_VM_SH" list "$action_share" "$ROOT" internal-marker >/dev/null 2>&1; then fail "wrong server context accepted"; fi
unset MOCK_PROJECT
MOCK_PIDS=""
no_server_rc=0
vm_exec action-vm "$OCVM_PROVIDER_VM_SH" list "$action_share" "$ROOT" internal-marker >/dev/null 2>&1 || no_server_rc=$?
[[ "$no_server_rc" == 3 ]] || fail "missing web server did not use the benign exit code"
pass "live listing uses the authenticated effective-port API and fails closed on bad responses"

# --- host list: grouped output, runtime column, next steps ---
printf '%s\n' '{"openai":{"type":"oauth","access":"secret-a","refresh":"secret-r","expires":1}}' > "$AUTH"
mkdir -p "$HOST_CFG_DIR"
printf '%s\n' '{"provider":{"local":{"npm":"@ai-sdk/openai-compatible","name":"Local","options":{"baseURL":"http://localhost:1234"},"models":{"old-model":{}}}}}' > "$HOST_CFG_DIR/opencode.json"
MOCK_PIDS=""
provider_cmd list > "$TMP/list-host.out"
grep -q 'Subscriptions' "$TMP/list-host.out" || fail "subscription group missing"
grep -q 'Custom endpoints' "$TMP/list-host.out" || fail "custom group missing"
grep -q 'Live runtime status unavailable' "$TMP/list-host.out" || fail "missing live-unavailable note"
if grep -Eq 'secret-a|secret-r' "$TMP/list-host.out"; then fail "host list exposed secrets"; fi
grep -q 'provider subscription rm <id>' "$TMP/list-host.out" || fail "next steps missing subscription rm"
grep -q 'provider custom rm <id>' "$TMP/list-host.out" || fail "next steps missing custom rm"
MOCK_PIDS=42
provider_cmd list > "$TMP/list-live.out"
grep -qE '^  openai[[:space:]]+oauth' "$TMP/list-live.out" || fail "live subscription row missing"
grep -qE '^  local[[:space:]]+endpoint' "$TMP/list-live.out" || fail "live endpoint row missing"
pass "provider list groups providers and shows actionable next steps"

# --- custom sync dispatch (renamed from refresh) ---
curl() {
  [[ "$*" == *"http://localhost:1234/models"* ]] || return 93
  printf '%s\n' '{"data":[{"id":"new-model","context_length":4096}]}'
}
provider_cmd custom sync local --quiet || fail "custom sync failed"
assert_eq "$(jq -r '.provider.local.models | has("new-model")' "$HOST_CFG_DIR/opencode.json")" true
assert_eq "$(jq -r '.provider.local.models | has("old-model")' "$HOST_CFG_DIR/opencode.json")" false
pass "custom sync reconciles the model list through the new command tree"

# The cosmetic bash internal error must not leak into provider output.
vm_exec() {
  printf 'environment: line 26: pop_var_context: head of shell_variables not a function context\n' >&2
  printf 'local\tnone\tlive\tcredentials=no\tavailable=yes\n'
  return 0
}
filtered="$(_provider_vm_exec fake-vm list 2>&1 1>/dev/null)"
[[ "$filtered" != *pop_var_context* ]] || fail "cosmetic bash error leaked from provider VM output"
pass "cosmetic pop_var_context noise is filtered from provider VM stderr"

printf 'provider tests passed\n'
