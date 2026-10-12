#!/usr/bin/env bash
# Focused fixtures for the minimal host lifecycle metadata logging (attach/run
# session-command failure, web-session end, tunnel cleanup). No VM, no live
# session: helpers are exercised directly with stubbed cleanup functions, and
# the failure blocks are verified source-level (rc captured before cleanup)
# plus a behavioral mini-fixture proving the primary rc and exit behavior stay
# intact when cleanup itself fails.
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

SHARE="$TMP/share"
mkdir -p "$SHARE"

# --- _host_session_log: bounded metadata line, nothing else ---
_host_session_log "$SHARE" session_command_failed "ctrl-1" "ses-fixture" "primary_rc=7 phase=vm_exec"
_host_session_log "$SHARE" web_session_ended "ctrl-1" "ses-fixture" "tunnel_base=7788"
line1="$(tail -n 2 "$SHARE/host-session.log" | head -n 1)"
line2="$(tail -n 1 "$SHARE/host-session.log")"
[[ "$line1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\ role=host\ pid=[0-9]+\ controller=ctrl-1\ session=ses-fixture\ event=session_command_failed\ primary_rc=7\ phase=vm_exec$ ]] || fail "unexpected failure line: $line1"
[[ "$line2" =~ event=web_session_ended\ tunnel_base=7788$ ]] || fail "unexpected end line: $line2"
_host_session_log "$TMP/missing-share" session_command_failed "c" "s" "primary_rc=1"
[[ ! -e "$TMP/missing-share/host-session.log" ]] || fail "log created outside an existing share"
pass "_host_session_log writes bounded metadata lines only"

# --- _attach_tunnel_cleanup: normal end, cleanup failure, no-tunnel no-op ---
stop_mcp_host_watcher() { return 0; }
stop_web_tunnels() { return 0; }
_ATTACH_TUNNEL_VM="ses-fixture"
_ATTACH_TUNNEL_BASE="7788"
_ATTACH_TUNNEL_SHARE="$SHARE"
_ATTACH_TUNNEL_CONTROLLER="ctrl-1"
out="$(_attach_tunnel_cleanup 2>&1)" || fail "normal cleanup must return 0"
[[ "$out" == *"Web session ended — closing LAN tunnels..."* && "$out" == *"Tunnels closed. Session paused — resume with: opencode-vm web"* ]] || fail "cleanup messages changed: $out"
grep -q "event=web_session_ended tunnel_base=7788$" "$SHARE/host-session.log" || fail "web_session_ended not logged"
grep -q "event=tunnel_cleanup .*stop_web_tunnels_rc=0$" "$SHARE/host-session.log" || fail "tunnel_cleanup rc=0 not logged"
pass "tunnel cleanup logs end and rc without changing messages or exit"

stop_web_tunnels() { return 4; }
before="$(wc -l <"$SHARE/host-session.log")"
out="$(_attach_tunnel_cleanup 2>&1)" || fail "failed tunnel stop must still return 0"
grep -q "event=tunnel_cleanup .*stop_web_tunnels_rc=4$" "$SHARE/host-session.log" || fail "cleanup failure rc not logged"
grep -q "event=web_session_ended" "$SHARE/host-session.log" || fail "end event missing on cleanup failure"
after="$(wc -l <"$SHARE/host-session.log")"
(( after == before + 2 )) || fail "unexpected log line count: $before -> $after"
pass "cleanup failure is logged as such while exit behavior stays unchanged"

stop_web_tunnels() { return 0; }
_ATTACH_TUNNEL_VM=""
_ATTACH_TUNNEL_BASE=""
_ATTACH_TUNNEL_SHARE=""
before="$(wc -l <"$SHARE/host-session.log")"
_attach_tunnel_cleanup >/dev/null 2>&1 || fail "no-tunnel cleanup must return 0"
(( "$(wc -l <"$SHARE/host-session.log")" == before )) || fail "no-tunnel cleanup must not log"
pass "no-tunnel cleanup stays a silent no-op"

# --- failure blocks: primary rc is captured before any cleanup (source) ---
grep -n 'local attach_primary_rc=\$?' "$ROOT/opencode-vm.sh" >/dev/null || fail "attach primary rc capture missing"
grep -n 'local run_primary_rc=\$?' "$ROOT/opencode-vm.sh" >/dev/null || fail "run primary rc capture missing"
attach_block="$(sed -n '/"\$attach_ol_scope" || {/,/^  }$/p' "$ROOT/opencode-vm.sh")"
attach_capture_line="$(printf '%s\n' "$attach_block" | grep -n 'attach_primary_rc=\$?' | head -n 1 | cut -d: -f1)"
attach_cleanup_line="$(printf '%s\n' "$attach_block" | grep -n 'stop_mcp_host_watcher' | head -n 1 | cut -d: -f1)"
[[ -n "$attach_capture_line" && -n "$attach_cleanup_line" && "$attach_capture_line" -lt "$attach_cleanup_line" ]] || fail "attach capture must precede cleanup"
run_block="$(grep -B2 -A12 'local run_primary_rc' "$ROOT/opencode-vm.sh" || true)"
[[ -n "$run_block" ]] || fail "run failure block shape changed"
printf '%s\n' "$run_block" | grep -q 'echo "\[run\] Session command failed\." >&2' || fail "run failure message changed"
printf '%s\n' "$run_block" | grep -q 'return 1' || fail "run failure must still return 1"
pass "both failure blocks capture the primary rc before cleanup"

# --- behavioral mini-fixture: primary rc and exit stay intact despite
# cleanup failure (the exact pattern used in the real blocks) ---
log_share="$TMP/mini"
mkdir -p "$log_share"
mini_session() {
  local primary_rc=$?
  _host_session_log "$log_share" session_command_failed "mini-ctrl" "mini-ses" "primary_rc=$primary_rc phase=vm_exec"
  local cleanup_rc=0
  false_cleanup || cleanup_rc=$?
  if (( cleanup_rc != 0 )); then
    _host_session_log "$log_share" cleanup_followup_failed "mini-ctrl" "mini-ses" "component=false_cleanup rc=$cleanup_rc primary_rc=$primary_rc"
  fi
  return 1
}
false_cleanup() { return 9; }
set +e
( exit 3 ) 2>/dev/null || mini_session
rc=$?
set -e
[[ "$rc" == 1 ]] || fail "mini session must still return 1, got $rc"
grep -q "event=session_command_failed primary_rc=3 phase=vm_exec$" "$log_share/host-session.log" || fail "primary rc 3 not preserved"
grep -q "event=cleanup_followup_failed component=false_cleanup rc=9 primary_rc=3$" "$log_share/host-session.log" || fail "cleanup failure not distinguished"
pass "primary rc preserved and cleanup failure distinguished with unchanged exit"

printf 'all ok\n'
