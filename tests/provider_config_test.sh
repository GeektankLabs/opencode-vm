#!/usr/bin/env bash
# Test globals are consumed by sourced production functions.
# shellcheck disable=SC2034
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
check() { jq -e "$2" "$1" >/dev/null || fail "$2 ($1)"; }

# Production uses BSD stat on macOS; provide its mtime operation on Linux.
if [[ "$(uname -s)" == Linux ]]; then
  stat() {
    if [[ "${1:-}" == -f && "${2:-}" == %m ]]; then
      command stat -c %Y "$3"
    else
      command stat "$@"
    fi
  }
fi

ensure_dirs
ensure_host_opencode_dirs
HOST="$(pick_host_cfg)"
PROJECT="$TMP/project/opencode.json"
STALE="$TMP/session.json"
OUT="$TMP/merged.json"
mkdir -p "$(dirname "$PROJECT")"
printf '%s\n' '{"provider":{"removed":{"name":"old","models":{"old":{}}},"keep":{"name":"keep","models":{"one":{}}}},"model":"keep/one","agent":{"user":{"prompt":"original"}}}' > "$HOST"
cp "$HOST" "$PROJECT"
cp "$HOST" "$STALE"
printf '%s\n' '{"provider":{"another":{"name":"new"}},"agent":{"user":{"prompt":"updated"}}}' > "$TMP/overlay.json"
_cfg_merge "$HOST" "$TMP/overlay.json" "$OUT"
check "$OUT" '(.provider | has("removed") and has("keep") and has("another")) and .agent.user.prompt == "updated"'
[[ ! -e "$SHARE_ROOT/removed-providers.json" ]] || fail 'ordinary merge created removal metadata'
pass 'ordinary merge retains union semantics without removal state'
provider_cmd custom rm removed >/dev/null
check "$HOST" '.provider | has("removed") | not'
check "$SHARE_ROOT/removed-providers.json" '. == ["removed"]'

# Newer timestamps must not turn an old definition into an explicit re-add.
touch -t 203001010000 "$PROJECT"
sync_cfg_between_host_and_project "$HOST" "$PROJECT"
check "$HOST" '(.provider | has("removed") | not) and .provider.keep.name == "keep"'
cmp -s "$HOST" "$PROJECT" || fail 'host and project did not converge'
_cfg_merge "$PROJECT" "$STALE" "$OUT"
check "$OUT" '.provider | has("removed") | not'
_cfg_merge "$STALE" "$HOST" "$OUT"
check "$OUT" '.provider | has("removed") | not'
pass 'removal survives newer old projects and session merges in both directions'

jq_inplace "$STALE" '.agent.user.prompt = "edited" | .provider.keep.models.two = {} | .provider.fresh = {"options":{"baseURL":"https://remote.example/v1"}}'
_cfg_merge "$HOST" "$STALE" "$OUT"
check "$OUT" '.agent.user.prompt == "edited" and .model == "keep/one" and (.provider.keep.models | has("one") and has("two")) and .provider.fresh.options.baseURL == "https://remote.example/v1" and (.provider | has("removed") | not)'
pass 'unrelated user settings, providers and model edits survive'

jq_inplace "$HOST" '.provider.removed = {"name":"explicit re-add","models":{"new":{}}}'
_cfg_merge "$HOST" "$STALE" "$OUT"
check "$OUT" '.provider.removed == {"name":"explicit re-add","models":{"new":{}}}'
_cfg_merge "$STALE" "$PROJECT" "$OUT"
check "$OUT" '.provider.removed == {"name":"explicit re-add","models":{"new":{}}}'
provider_cmd custom rm removed >/dev/null
check "$SHARE_ROOT/removed-providers.json" '. == ["removed"]'
_cfg_merge "$HOST" "$STALE" "$OUT"
check "$OUT" '.provider | has("removed") | not'
pass 'host re-add wins without obsolete models, and repeated removal stays effective'

provider_cmd custom rm absent >/dev/null
jq_inplace "$STALE" '.provider.absent = {"name":"only in old session"}'
_cfg_merge "$HOST" "$STALE" "$OUT"
check "$OUT" '.provider | has("absent") | not'
pass 'removal records providers absent from host but present in stale state'

rm "$HOST"
cp "$STALE" "$PROJECT"
sync_cfg_between_host_and_project "$HOST" "$PROJECT"
check "$HOST" '.provider | (has("removed") or has("absent")) | not'
cmp -s "$HOST" "$PROJECT" || fail 'lone project did not converge'
pass 'missing host config cannot resurrect removed project providers'

jq_inplace "$STALE" '.provider.keep.options.baseURL = "http://host.lima.internal:1234/v1" | .provider.ip.options.baseURL = "https://192.168.5.2:11434/v1" | .provider.loopback.options.baseURL = "http://127.0.0.1:1234/v1" | .provider.remote.options.baseURL = "https://host.lima.internal.example/v1"'
_cfg_merge "$HOST" "$STALE" "$OUT"
check "$OUT" '.provider.keep.options.baseURL == "http://localhost:1234/v1" and .provider.ip.options.baseURL == "https://localhost:11434/v1" and .provider.loopback.options.baseURL == "http://127.0.0.1:1234/v1" and .provider.remote.options.baseURL == "https://host.lima.internal.example/v1"'
pass 'VM host URLs normalize without changing ports, paths, or other hosts'

printf '%s\n' 'invalid' > "$TMP/invalid.json"
cp "$OUT" "$TMP/before.json"
if _cfg_merge "$TMP/invalid.json" "$HOST" "$OUT"; then
  fail 'invalid merge input accepted'
fi
cmp -s "$OUT" "$TMP/before.json" || fail 'failed merge overwrote output'
pass 'invalid JSON leaves merge output untouched'

# Exercise actual publication paths; only unrelated lifecycle/VM work is stubbed.
proj_hash() { printf 'config-publication-test\n'; }
lifecycle_lock_acquire() { :; }
lifecycle_lock_release() { printf 'released\n' >> "$TMP/lock.log"; }
lifecycle_finalize_runtime() { :; }
auth_sync_prune_resolved_run() { :; }
is_vm_running() { return 1; }
limactl() { printf '%s\n' "$*" >> "$TMP/lima.log"; }
rsync() { :; }
check_sqlite_integrity() { :; }
graphify_persist_save_for_session() { :; }
ecc_enabled() { return 1; }
stop_materialize_daemon() { :; }
md5() { cksum "$2"; }

reset_publication() {
  proj=/config-test
  sess=oc-config-test
  controller_id=config-controller
  sess_share="$(session_share_dir "$proj")"
  proj_state="$(project_state_dir "$proj")"
  senv="$(session_env "$proj")"
  rm -rf "$sess_share" "$proj_state"
  mkdir -p "$sess_share/config/opencode" "$proj_state/config/opencode"
  write_senv "$senv" "$sess" "$proj" hash tui '' 0 0 generation "$controller_id"
  printf '%s\n' '["removed"]' > "$SHARE_ROOT/removed-providers.json"
  printf '%s\n' '{"provider":{"hostonly":{"name":"host change"}},"agent":{"host":{"prompt":"keep"}}}' > "$HOST"
  pub_project="$proj_state/config/opencode/opencode.json"
  printf '%s\n' '{"provider":{"projectonly":{"name":"project change"}},"agent":{"project":{"prompt":"keep"}}}' > "$pub_project"
  pub_session="$sess_share/config/opencode/opencode.json"
  printf '%s\n' '{"provider":{"removed":{"models":{"old":{}}},"sessiononly":{"options":{"baseURL":"http://host.lima.internal:1234/v1"}}},"agent":{"session":{"prompt":"edited"}}}' > "$pub_session"
  touch -t 203001010000 "$pub_session"
  : > "$TMP/lima.log"
  : > "$TMP/lock.log"
  SESSION_MODE=tui OC_SHELL_OK=0 KEEP_HISTORY=0 clean_link=''
  cfg_hash="$(md5 -q "$HOST")"
}

for legacy in no yes; do
  reset_publication
  if [[ "$legacy" == yes ]]; then
    mv "$pub_session" "$sess_share/config/opencode/.opencode.json"
  fi
  _destroy_prev_session "$proj" > "$TMP/destroy.log"
  check "$HOST" '(.provider | has("removed") | not) and .provider.hostonly.name == "host change" and .agent.session.prompt == "edited" and .provider.sessiononly.options.baseURL == "http://localhost:1234/v1"'
  check "$pub_project" '(.provider | has("removed") | not) and .provider.projectonly.name == "project change" and .agent.session.prompt == "edited"'
  cmp -s "$pub_project" "$proj_state/config/opencode/.opencode.json" || fail 'legacy project config was not filtered'
  [[ ! -d "$sess_share" && -s "$TMP/lima.log" ]] || fail 'successful destroy did not finish'
  sync_cfg_between_host_and_project "$HOST" "$pub_project"
  check "$HOST" '.provider | has("removed") | not'
done
pass 'real destroy filters both config names, preserves edits and cannot poison subsequent merges'

reset_publication
touch -t 203101010000 "$HOST"
cp "$HOST" "$TMP/host-before.json"
_destroy_prev_session "$proj" > "$TMP/destroy.log"
cmp -s "$HOST" "$TMP/host-before.json" || fail 'destroy overwrote newer host config'
check "$pub_project" '(.provider | has("removed") | not) and .agent.session.prompt == "edited"'
pass 'destroy retains newer host config while filtering project publication'

reset_publication
jq_inplace "$HOST" '.provider.removed = {"name":"explicit re-add"}'
_destroy_prev_session "$proj" > "$TMP/destroy.log"
check "$HOST" '.provider.removed == {"name":"explicit re-add"}'
check "$pub_project" '.provider.removed == {"name":"explicit re-add"}'
pass 'destroy honors explicit host re-add without merging obsolete provider fields'

# Load the real nested cleanup without running start_session or provisioning Lima.
cleanup_code='' in_cleanup=0
while IFS= read -r line; do
  [[ "$line" != '  cleanup() {' ]] || in_cleanup=1
  if (( in_cleanup )); then
    cleanup_code+="$line"$'\n'
    [[ "$line" != '  }' ]] || in_cleanup=0
  fi
done < "$ROOT/opencode-vm.sh"
[[ -n "$cleanup_code" ]] || fail 'normal cleanup body not found'
eval "$cleanup_code"

reset_publication
# A missing project baseline must not force raw-copy publication.
rm "$pub_project"
(cleanup) > "$TMP/cleanup.log"
check "$HOST" '(.provider | has("removed") | not) and .agent.host.prompt == "keep" and .agent.session.prompt == "edited"'
check "$pub_project" '(.provider | has("removed") | not) and .provider.sessiononly.options.baseURL == "http://localhost:1234/v1"'
pass 'real normal cleanup filters missing-baseline publication and preserves user edits'

for publication in destroy cleanup sync; do
  for broken in removals session host; do
    reset_publication
    case "$broken" in
      removals) printf 'invalid\n' > "$SHARE_ROOT/removed-providers.json" ;;
      session) printf 'invalid\n' > "$pub_session"; touch -t 203001010000 "$pub_session" ;;
      host) printf 'invalid\n' > "$HOST" ;;
    esac
    cp "$HOST" "$TMP/host-before.json"
    cp "$pub_project" "$TMP/project-before.json"
    cp "$pub_session" "$TMP/session-before.json"
    cfg_hash="$(md5 -q "$HOST")"
    case "$publication" in
      destroy) if _destroy_prev_session "$proj" > "$TMP/failure.log" 2>&1; then fail 'destroy accepted failed filter'; fi ;;
      cleanup) if (cleanup) > "$TMP/failure.log" 2>&1; then fail 'cleanup accepted failed filter'; fi ;;
      sync) if sync_cfg_between_host_and_project "$HOST" "$pub_session" > "$TMP/failure.log" 2>&1; then fail 'sync accepted failed filter'; fi ;;
    esac
    cmp -s "$HOST" "$TMP/host-before.json" || fail "$publication changed host after failed filter"
    cmp -s "$pub_project" "$TMP/project-before.json" || fail "$publication changed project after failed filter"
    cmp -s "$pub_session" "$TMP/session-before.json" || fail "$publication changed session after failed filter"
    [[ -d "$sess_share" && -f "$senv" && ! -s "$TMP/lima.log" ]] || fail "$publication discarded failed session"
    if [[ "$publication" != sync ]]; then
      [[ -s "$TMP/lock.log" ]] || fail "$publication did not release lifecycle lock"
    fi
  done
done
pass 'destroy, normal cleanup and sync fail closed without publication or deletion on invalid input'

reset_publication
rm "$HOST"
printf 'invalid\n' > "$SHARE_ROOT/removed-providers.json"
if sync_cfg_between_host_and_project "$HOST" "$pub_session" > "$TMP/failure.log" 2>&1; then
  fail 'lone stale config bypassed failed filter'
fi
[[ ! -e "$HOST" ]] || fail 'failed lone-config filtering created host config'
pass 'missing-host sync cannot fall back to an unfiltered stale copy'

reset_publication
cp "$HOST" "$TMP/host-before.json"
cp "$pub_project" "$TMP/project-before.json"
if (
  # Called indirectly by the sourced config merge function.
  # shellcheck disable=SC2317
  command() {
    if [[ "${1:-}" == -v && "${2:-}" == jq ]]; then return 1; fi
    builtin command "$@"
  }
  _destroy_prev_session "$proj"
) > "$TMP/failure.log" 2>&1; then
  fail 'destroy accepted unavailable jq with recorded removals'
fi
cmp -s "$HOST" "$TMP/host-before.json" || fail 'missing jq changed host config'
cmp -s "$pub_project" "$TMP/project-before.json" || fail 'missing jq changed project config'
[[ -d "$sess_share" && ! -s "$TMP/lima.log" ]] || fail 'missing jq discarded session'
pass 'unavailable jq cannot silently bypass removal filtering during destroy'

# ---------------------------------------------------------------------------
# Canonical OpenAI headerTimeout default (fill-only, 60000 ms) on both config
# composition paths. Mutation controls: required-default-dropped, explicit-
# override-clobber and other-provider-pollution must fail these assertions.
# ---------------------------------------------------------------------------
cfg="$TMP/hdr.json"

# (a) Absent provider.openai -> minimal entry with the default; nothing else moves.
printf '%s\n' '{"provider":{"siliconflow":{"options":{"baseURL":"https://api.siliconflow.cn/v1"}}},"model":"siliconflow/x"}' > "$cfg"
jq -S '.provider.openai = {"options":{"headerTimeout":60000}}' "$cfg" > "$TMP/hdr-expected.json"
apply_openai_header_timeout_default "$cfg"
check "$cfg" '.provider.openai.options.headerTimeout == 60000'
jq -S . "$cfg" > "$TMP/hdr-after.json"
cmp -s "$TMP/hdr-expected.json" "$TMP/hdr-after.json" || fail 'fill changed unrelated bytes (default dropped or pollution)'
pass 'absent OpenAI entry gets the 60000 ms default and nothing else changes'

# (b) Existing OpenAI entry without options -> only the missing path is added.
printf '%s\n' '{"provider":{"openai":{"name":"openai","models":{"gpt-5":{}}},"other":{"options":{"timeout":123}}}}' > "$cfg"
jq -S '.provider.openai.options = {"headerTimeout":60000}' "$cfg" > "$TMP/hdr-expected.json"
apply_openai_header_timeout_default "$cfg"
check "$cfg" '.provider.openai.options.headerTimeout == 60000 and .provider.openai.name == "openai" and (.provider.openai.models | has("gpt-5")) and .provider.other.options.timeout == 123'
jq -S . "$cfg" > "$TMP/hdr-after.json"
cmp -s "$TMP/hdr-expected.json" "$TMP/hdr-after.json" || fail 'custom OpenAI fields changed'
pass 'existing OpenAI entry only gains the missing key'

# (c) Existing options -> siblings untouched, headerTimeout filled.
printf '%s\n' '{"provider":{"openai":{"options":{"timeout":123456,"apiKey":"opaque"}}}}' > "$cfg"
jq -S '.provider.openai.options.headerTimeout = 60000' "$cfg" > "$TMP/hdr-expected.json"
apply_openai_header_timeout_default "$cfg"
jq -S . "$cfg" > "$TMP/hdr-after.json"
cmp -s "$TMP/hdr-expected.json" "$TMP/hdr-after.json" || fail 'sibling option keys changed'
pass 'sibling option keys stay untouched while headerTimeout is filled'

# (d) Explicit values (number, 0, null) are never overwritten.
for explicit in '12345' '0' 'null'; do
  printf '{"provider":{"openai":{"options":{"headerTimeout":%s}}}}\n' "$explicit" > "$cfg"
  apply_openai_header_timeout_default "$cfg"
  check "$cfg" ".provider.openai.options.headerTimeout == $explicit"
done
pass 'explicit headerTimeout values including 0 and null are never overwritten'

# (e) Non-OpenAI providers never gain the key.
printf '%s\n' '{"provider":{"anthropic":{"options":{"timeout":99}},"alibaba":{"models":{}}}}' > "$cfg"
jq -S '.provider' "$cfg" > "$TMP/hdr-others-before.json"
apply_openai_header_timeout_default "$cfg"
jq -S '.provider | del(.openai)' "$cfg" > "$TMP/hdr-others-after.json"
cmp -s "$TMP/hdr-others-before.json" "$TMP/hdr-others-after.json" || fail 'non-OpenAI providers were modified'
pass 'non-OpenAI providers stay byte-identical (no pollution)'

# (f) Repeated fill is an idempotent no-op at byte level.
printf '%s\n' '{"provider":{"openai":{"options":{"headerTimeout":60000}}}}' > "$cfg"
apply_openai_header_timeout_default "$cfg"
cp -p "$cfg" "$TMP/hdr-idem.json"
apply_openai_header_timeout_default "$cfg"
cmp -s "$cfg" "$TMP/hdr-idem.json" || fail 'repeated fill changed bytes'
pass 'repeated fill is an idempotent no-op'

# (g) Fresh and attach composition mirrors resolve identically; auth.json untouched.
printf '%s\n' '{"provider":{"ai-gateway":{"models":{"gpt-5":{"name":"gpt-5"}}}},"model":"ai-gateway/gpt-5"}' > "$TMP/hdr-src.json"
printf '%s\n' '{"openai":{"type":"oauth","refresh":"opaque-probe"}}' > "$TMP/auth.json"
cp -p "$TMP/auth.json" "$TMP/auth-before.json"
cp -p "$TMP/hdr-src.json" "$TMP/hdr-fresh.json"
apply_model_enrichment "$TMP/hdr-fresh.json"
apply_openai_header_timeout_default "$TMP/hdr-fresh.json"
check "$TMP/hdr-fresh.json" '.provider.openai.options.headerTimeout == 60000 and .provider["ai-gateway"].models["gpt-5"].limit.context == 272000'
cp -p "$TMP/hdr-src.json" "$TMP/hdr-attach.json"
apply_model_enrichment "$TMP/hdr-attach.json"
apply_openai_header_timeout_default "$TMP/hdr-attach.json"
cmp -s "$TMP/hdr-fresh.json" "$TMP/hdr-attach.json" || fail 'fresh and attach composition diverged'
cmp -s "$TMP/auth.json" "$TMP/auth-before.json" || fail 'auth.json changed'
pass 'fresh and attach composition resolve identically with auth.json untouched'

# (h) Structural guard: both production composition paths invoke the fill.
grep -q 'apply_openai_header_timeout_default "$_att_cfg"' "$ROOT/opencode-vm.sh" \
  || fail 'attach composition path lost the fill'
grep -q 'apply_openai_header_timeout_default "$sess_cfg_file"' "$ROOT/opencode-vm.sh" \
  || fail 'fresh composition path lost the fill'
pass 'both fresh and attach composition paths invoke the fill'
