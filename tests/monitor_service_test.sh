#!/usr/bin/env bash
# Focused guest-side monitor service checks: the engine heartbeat is read at the
# path the engine actually writes (project monitor registry, not the session
# share), with identity and freshness verification, and web.sh stays self-sufficient
# when it is sourced without the host script's helpers (vm_exec guest blocks).
# Globals are used by sourced production functions.
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

date -d '1 minute ago' +%s >/dev/null 2>&1 || { echo "SKIP monitor service checks (GNU date required)"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "SKIP monitor service checks (jq required)"; exit 0; }

SHARE="$TMP/share"
PROJECT="$TMP/project"
mkdir -p "$SHARE" "$PROJECT/.opencode-vm"
install_web_lib "$SHARE" >/dev/null
[[ -f "$SHARE/lib/web.sh" ]] || fail "web.sh was not materialized"

# ---------------------------------------------------------------- heartbeat
FUNCS="$TMP/monitor-funcs.sh"
{
  awk '/^monitor_heartbeat_path\(\) \{/,/^\}$/' "$SHARE/lib/web.sh"
  awk '/^monitor_wait_heartbeat\(\) \{/,/^\}$/' "$SHARE/lib/web.sh"
} > "$FUNCS"
grep -q '^monitor_heartbeat_path() {' "$FUNCS" || fail "monitor_heartbeat_path not extracted"
grep -q '^monitor_wait_heartbeat() {' "$FUNCS" || fail "monitor_wait_heartbeat not extracted"

HASH="66370db6a9e3f88af333b4d90620d90b"
GENERATION="oc-fixture-generation"
heartbeat_path="$(bash -c "source '$FUNCS'; monitor_heartbeat_path '$PROJECT'")"
[[ "$heartbeat_path" == "$PROJECT/.opencode-vm/monitor/heartbeat.json" ]] \
  || fail "heartbeat path is not the project monitor registry path ($heartbeat_path)"

write_heartbeat() { # <path> <hash> <generation> <age-seconds>
  local file="$1" at
  mkdir -p "$(dirname "$file")"
  at="$(date -u -d "-$4 seconds" +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '{"schema":1,"projectHash":"%s","generation":"%s","pid":4242,"at":"%s"}\n' "$2" "$3" "$at" > "$file"
}
wait_hb() { bash -c "source '$FUNCS'; monitor_wait_heartbeat '$PROJECT' '$1' '$2' '${3:-1}'" >/dev/null 2>&1; }

write_heartbeat "$heartbeat_path" "$HASH" "$GENERATION" 5
wait_hb "$HASH" "$GENERATION" || fail "fresh matching heartbeat was not accepted"
pass "heartbeat: fresh, matching hash/generation is accepted"

rm -f "$heartbeat_path"
write_heartbeat "$SHARE/monitor/heartbeat.json" "$HASH" "$GENERATION" 5
if wait_hb "$HASH" "$GENERATION"; then fail "session-share heartbeat was accepted (the old path bug)"; fi
pass "heartbeat: a session-share file is not the engine heartbeat (negative path)"

rm -rf "$SHARE/monitor"
write_heartbeat "$heartbeat_path" "$HASH" "oc-other-generation" 5
if wait_hb "$HASH" "$GENERATION"; then fail "foreign generation heartbeat was accepted"; fi
write_heartbeat "$heartbeat_path" "00000000000000000000000000000000" "$GENERATION" 5
if wait_hb "$HASH" "$GENERATION"; then fail "foreign project heartbeat was accepted"; fi
write_heartbeat "$heartbeat_path" "$HASH" "$GENERATION" 600
if wait_hb "$HASH" "$GENERATION"; then fail "stale heartbeat was accepted"; fi
printf '{"schema":1}' > "$heartbeat_path"
if wait_hb "$HASH" "$GENERATION"; then fail "heartbeat without identity was accepted"; fi
printf 'not-json\n' > "$heartbeat_path"
if wait_hb "$HASH" "$GENERATION"; then fail "malformed heartbeat was accepted"; fi
rm -f "$heartbeat_path"
if wait_hb "$HASH" "$GENERATION"; then fail "missing heartbeat was accepted"; fi
ln -s "$TMP/elsewhere" "$heartbeat_path"
if wait_hb "$HASH" "$GENERATION"; then fail "symlinked heartbeat was accepted"; fi
rm -f "$heartbeat_path"
pass "heartbeat: foreign generation/project, stale, malformed, missing and symlinked files are rejected"

# ------------------------------------------------- web.sh without host helpers
SELF_FUNCS="$TMP/self-funcs.sh"
{
  awk '/^web_jq_inplace\(\) \{/,/^\}$/' "$SHARE/lib/web.sh"
  awk '/^mcp_self_unregister\(\) \{/,/^\}$/' "$SHARE/lib/web.sh"
  awk '/^mcp_self_register\(\) \{/,/^\}$/' "$SHARE/lib/web.sh"
} > "$SELF_FUNCS"
for name in web_jq_inplace mcp_self_unregister mcp_self_register; do
  grep -q "^$name() {" "$SELF_FUNCS" || fail "$name was not extracted from web.sh"
done
# web.sh must not depend on the host-only helper any more.
if grep -nE '(^|[^_[:alnum:]])jq_inplace[[:space:]]' "$SHARE/lib/web.sh" | grep -v 'web_jq_inplace' >/dev/null; then
  fail "web.sh still calls the host-only jq_inplace"
fi

mkdir -p "$SHARE/config/opencode/skills/orchestrator/opencode-session-orchestrator" "$SHARE/mcp"
chmod 700 "$SHARE/mcp"
printf 'fixture-token\n' > "$SHARE/mcp/credential"
chmod 600 "$SHARE/mcp/credential"
printf '{"mcp":{}}\n' > "$SHARE/config/opencode/opencode.json"

# No jq_inplace is defined here on purpose: this is the guest vm_exec context.
run_self() {
  bash -c 'set -uo pipefail; source "$1"; SESS_SHARE="$2" OC_MCP_ENABLED=1 OC_MCP_PORT=40960 "$3"' \
    bash "$SELF_FUNCS" "$SHARE" "$1" 2>"$TMP/self.err"
}
run_self mcp_self_register || fail "guest-context mcp_self_register failed: $(cat "$TMP/self.err")"
grep -q "command not found" "$TMP/self.err" && fail "guest context reported a missing helper" || true
jq -e '.mcp["ocvm-self"].url == "http://127.0.0.1:40960/mcp"
       and .mcp["ocvm-self"].headers["X-OCVM-MCP-Token"] == "fixture-token"
       and .mcp["ocvm-self"].enabled == true' "$SHARE/config/opencode/opencode.json" >/dev/null \
  || fail "self-MCP entry was not registered in the guest context"
run_self mcp_self_unregister || fail "guest-context mcp_self_unregister failed: $(cat "$TMP/self.err")"
jq -e '.mcp | has("ocvm-self") | not' "$SHARE/config/opencode/opencode.json" >/dev/null \
  || fail "self-MCP entry was not removed in the guest context"
pass "web.sh self-MCP helpers work without the host jq_inplace (guest vm_exec context)"

# A broken config is left untouched instead of being truncated.
printf '{"mcp":{"ocvm-self":{"enabled":true}}\n' > "$SHARE/config/opencode/opencode.json"
before="$(cat "$SHARE/config/opencode/opencode.json")"
run_self mcp_self_unregister || true
[[ "$(cat "$SHARE/config/opencode/opencode.json")" == "$before" ]] \
  || fail "an invalid config was modified by the atomic jq helper"
pass "web.sh jq helper leaves an invalid config untouched"
