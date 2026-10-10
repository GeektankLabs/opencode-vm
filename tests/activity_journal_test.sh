#!/usr/bin/env bash
# Production parsers/session serialization/runtime staging with isolated state.
# Contract since 0.7.31: the Activity Journal defaults ON for fresh sessions,
# --no-journal opts out, attach retains the stored mode in BOTH directions and
# refuses implicit changes; a journal-incapable fresh session downgrades
# transparently while an explicit --journal still fails hard.
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

# --- fresh default: ON; explicit flags both work; conflicts rejected --------
parse_web_flags
[[ "$(session_journal_enabled fresh)" == 1 ]] || fail 'fresh web does not default on'
parse_web_flags --no-journal
[[ "$(session_journal_enabled fresh)" == 0 ]] || fail 'web --no-journal opt-out lost'
parse_web_flags --journal
[[ "$(session_journal_enabled fresh)" == 1 ]] || fail 'web --journal opt-in lost'
if ( parse_web_flags --journal --no-journal ) >/dev/null 2>&1; then fail 'web journal flag conflict accepted'; fi
if ( parse_web_flags --journal --no-mcp ) >/dev/null 2>&1; then fail 'web --journal + --no-mcp accepted'; fi
if ! ( parse_web_flags --no-journal --no-mcp ) >/dev/null 2>&1; then fail 'web --no-journal + --no-mcp wrongly rejected'; fi
pass 'web parser: default on, both flags, conflict and MCP rules'

parse_start_flags
[[ "$(session_journal_enabled fresh)" == 1 ]] || fail 'fresh terminal does not default on'
parse_start_flags --no-journal
[[ "$(session_journal_enabled fresh)" == 0 ]] || fail 'terminal --no-journal opt-out lost'
parse_start_flags --journal
[[ "$(session_journal_enabled fresh)" == 1 ]] || fail 'terminal --journal opt-in lost'
if ( parse_start_flags --journal --no-journal ) >/dev/null 2>&1; then fail 'terminal journal flag conflict accepted'; fi
if ( parse_start_flags --journal --no-mcp ) >/dev/null 2>&1; then fail 'terminal --journal + --no-mcp accepted'; fi
pass 'terminal parser: default on, both flags, conflicts'

parse_attach_flags
SESSION_JOURNAL_MODE=""
parse_attach_flags --journal
[[ "$SESSION_JOURNAL_MODE" == enable ]] || fail 'attach --journal lost'
parse_attach_flags --no-journal
[[ "$SESSION_JOURNAL_MODE" == disable ]] || fail 'attach --no-journal lost'
if ( parse_attach_flags --journal --no-journal ) >/dev/null 2>&1; then fail 'attach journal flag conflict accepted'; fi
pass 'attach parser: journal flags parse, conflict rejected'

# --- effective resolution: explicit opt-in fails hard, default downgrades ---
SESSION_JOURNAL_MODE=""
[[ "$(session_journal_effective 1 0)" == 0 ]] || fail 'default-on did not downgrade without MCP'
[[ "$(session_journal_effective 1 1)" == 1 ]] || fail 'default-on lost with MCP'
[[ "$(session_journal_effective 0 1)" == 0 ]] || fail 'opt-out must stay off'
SESSION_JOURNAL_MODE=enable
if session_journal_effective 1 0 >/dev/null 2>&1; then fail 'explicit --journal accepted without MCP'; fi
[[ "$(session_journal_effective 1 1)" == 1 ]] || fail 'explicit --journal lost with MCP'
SESSION_JOURNAL_MODE=disable
[[ "$(session_journal_effective 1 0)" == 0 ]] || fail 'explicit opt-out resolved wrong'
pass 'effective resolution: explicit fails hard, default downgrades transparently'

# Explicit --journal without a configured connector is still rejected before
# any lifecycle work (existing-session prompt, preflight, VM operations).
if (
  SESSION_MODE=tui; SESSION_JOURNAL_MODE=enable; SESSION_MCP_MODE=""
  mcp_session_mode() { printf 'tui\n'; }
  vscode_trust_preflight() { printf 'reached\n' > "$TMP/unexpected-preflight"; return 1; }
  start_session
) >/dev/null 2>&1; then fail 'explicit journal start without connector accepted'; fi
[[ ! -e "$TMP/unexpected-preflight" ]] || fail 'invalid explicit journal start reached lifecycle preflight'
pass 'explicit --journal without connector rejected before lifecycle work'

# --- attach retains stored modes in BOTH directions, no implicit switching ---
SESSION_JOURNAL_MODE=""
[[ "$(session_journal_enabled attach 0)" == 0 ]] || fail 'attach switched off session'
[[ "$(session_journal_enabled attach 1)" == 1 ]] || fail 'attach switched on session'
[[ "$(session_journal_enabled attach '')" == 1 ]] || fail 'legacy attach lost journal'
SESSION_JOURNAL_MODE=enable
if session_journal_enabled attach 0 >/dev/null 2>&1; then fail 'reconnect silently enabled journal'; fi
[[ "$(session_journal_enabled attach 1)" == 1 ]] || fail 'same-mode reconnect failed'
SESSION_JOURNAL_MODE=disable
if session_journal_enabled attach 1 >/dev/null 2>&1; then fail 'reconnect silently disabled journal'; fi
[[ "$(session_journal_enabled attach 0)" == 0 ]] || fail 'same-mode off reconnect failed'
pass 'attach retains both modes and legacy enabled state without implicit switching'

# --- session env serialization keeps the mode, legacy writers keep field ----
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
[[ "${SESS_JOURNAL_ENABLED:-1}" == 1 ]] || fail 'legacy writer default is not the new default-on'
pass 'session env serialization and legacy writer defaults'
printf 'activity_journal_test: all checks passed\n'
