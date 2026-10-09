#!/usr/bin/env bash
# Production parsers/session serialization/runtime staging with isolated state.
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

parse_web_flags
[[ "$(session_journal_enabled fresh)" == 0 ]] || fail 'fresh web defaults on'
parse_web_flags --journal
[[ "$(session_journal_enabled fresh)" == 1 ]] || fail 'web opt-in lost'
parse_start_flags
[[ "$(session_journal_enabled fresh)" == 0 ]] || fail 'fresh terminal defaults on'
parse_start_flags --journal
[[ "$(session_journal_enabled fresh)" == 1 ]] || fail 'terminal opt-in lost'
for parser in parse_web_flags parse_start_flags; do
  if ( "$parser" --journal --no-mcp ) > /dev/null 2>&1; then fail 'incompatible flags accepted'; fi
done
pass 'fresh start parsers default off, opt in and reject incompatible flags'

if (
  SESSION_MODE=tui; SESSION_JOURNAL_MODE=enable; SESSION_MCP_MODE=""
  mcp_session_mode() { printf 'tui\n'; }
  vscode_trust_preflight() { printf 'reached\n' > "$TMP/unexpected-preflight"; return 1; }
  start_session
) > /dev/null 2>&1; then fail 'journal accepted without a configured connector'; fi
[[ ! -e "$TMP/unexpected-preflight" ]] || fail 'invalid journal start reached lifecycle preflight'
pass 'invalid opt-in is rejected before existing-session or VM lifecycle work'

SESSION_JOURNAL_MODE=""
[[ "$(session_journal_enabled attach 0)" == 0 ]] || fail 'attach switched off session'
[[ "$(session_journal_enabled attach 1)" == 1 ]] || fail 'attach switched on session'
[[ "$(session_journal_enabled attach '')" == 1 ]] || fail 'legacy attach lost journal'
SESSION_JOURNAL_MODE=enable
if session_journal_enabled attach 0 > /dev/null 2>&1; then fail 'reconnect silently changed mode'; fi
[[ "$(session_journal_enabled attach 1)" == 1 ]] || fail 'same-mode reconnect failed'
pass 'attach retains both modes and legacy enabled state without implicit switching'

senv="$TMP/session.env"
for mode in 0 1; do
  write_senv "$senv" vm "$TMP" hash web 4096 0 1 gen controller 1 40960 0 0 "$mode"
  # shellcheck disable=SC1090
  source "$senv"
  [[ "$SESS_JOURNAL_ENABLED" == "$mode" ]] || fail 'mode not serialized'
  # Older positional callers (TLS/resize/cleanup) preserve an existing field.
  write_senv "$senv" vm "$TMP" hash web 4096 0 1 gen controller 1 40960 0 0
  # shellcheck disable=SC1090
  source "$senv"
  [[ "$SESS_JOURNAL_ENABLED" == "$mode" ]] || fail 'legacy writer reset mode'
done
unset SESS_JOURNAL_ENABLED
write_senv "$senv" vm "$TMP" hash web 4096 0
# shellcheck disable=SC1090
source "$senv"
[[ "$SESS_JOURNAL_ENABLED" == 1 ]] || fail 'legacy positional default changed'
pass 'session serialization preserves both explicit modes and old callers'

write_senv "$senv" vm "$TMP" hash web 4096 0 1 gen controller 1 40960 0 0 0
if (
  SESSION_JOURNAL_MODE=enable
  vscode_trust_preflight() { return 0; }
  need() { :; }
  sanitize_lima_sock_dir() { :; }
  session_env() { printf '%s\n' "$senv"; }
  lifecycle_lock_acquire() { :; }
  lifecycle_lock_release() { :; }
  is_vm_running() { printf 'reached\n' > "$TMP/unexpected-runtime"; return 0; }
  attach_session
) > /dev/null 2>&1; then fail 'attach accepted a journal mode change'; fi
[[ ! -e "$TMP/unexpected-runtime" ]] || fail 'mode change reached VM lifecycle work'
pass 'actual attach rejects a mode change before any VM runtime operation'

share="$TMP/share"
install_web_lib "$share"
SESS_SHARE="$share"; PROJ_DIR="$TMP"; OC_PORT=4096
# shellcheck disable=SC1090
source "$share/lib/web.sh"
adapter="$share/mcp/adapter"
mkdir -p "$adapter/dist" "$adapter/node_modules"
printf '{}\n' > "$adapter/package-lock.json"
printf '{}\n' > "$adapter/manifest.json"
printf 'test\n' > "$adapter/.archive-sha256"
printf 'release-test\n' > "$adapter/node_modules/.ocvm-install-mode"
touch "$adapter/node_modules/.package-lock.json" "$adapter/dist/main.js"
opencode() { printf 'test-version\n'; }
OC_MCP_ENABLED=1; OC_MCP_PORT=40960; OC_MCP_GENERATION=test; OC_OPENLIVE_PROJECT_HASH=test
for mode in 0 1; do
  OC_JOURNAL_ENABLED="$mode"
  prepare_mcp_adapter > /dev/null
  jq -e --argjson expected "$mode" '.activityJournalEnabled == ($expected == 1)' "$share/mcp/runtime.json" > /dev/null || fail 'runtime mode lost'
done
pass 'production runtime preparation writes boolean mode without installs'
