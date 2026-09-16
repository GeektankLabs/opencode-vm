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
printf '%s\n' '{}' > "$AUTH"
auth_sync_begin /project action-gen
action_senv="$TMP/action.env"
action_share="$TMP/action-share"
mkdir -p "$action_share/xdg-data/opencode"
write_senv "$action_senv" action-vm /project hash web 4096 0 1 action-gen action-controller
session_env() { printf '%s\n' "$action_senv"; }
session_share_dir() { printf '%s\n' "$action_share"; }
is_vm_running() { return 0; }
vm_exec() {
  printf '%s\n' "$2" >> "$TMP/provider-action.log"
  printf '%s\n' "$*" >> "$TMP/provider-action-args.log"
  return 0
}
provider_auth_action login openai "ChatGPT Pro/Plus (headless)" >/dev/null
assert_eq "$(jq -r '.explicitLogins.openai' "$AUTH_SYNC_DIR/runs/action-gen/manifest.json")" true
[[ ! -L "$SESSIONS_DIR/.locks/provider-lock-test.lock" ]] || fail "provider action leaked lifecycle ownership"
grep -q 'opencode auth login' "$TMP/provider-action.log" || fail "provider action did not invoke VM OpenCode CLI"
grep -q 'ChatGPT Pro/Plus (headless)' "$TMP/provider-action-args.log" || fail "provider login method was not forwarded"
pass "provider login targets the tracked VM and records explicit intent under lifecycle ownership"

printf 'provider tests passed\n'
