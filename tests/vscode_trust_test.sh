#!/usr/bin/env bash
# shellcheck disable=SC2030,SC2031,SC2317
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/opencode-vm.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

make_vscode_state() {
  local home="$1" value="$2"
  mkdir -p "$home/Library/Application Support/Code/User/globalStorage"
  python3 - "$home/Library/Application Support/Code/User/globalStorage/state.vscdb" "$value" <<'PY'
import sqlite3
import sys

database, value = sys.argv[1:]
connection = sqlite3.connect(database)
connection.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
connection.execute("INSERT INTO ItemTable VALUES (?, ?)", ("content.trust.model.key", value))
connection.commit()
connection.close()
PY
}

(
  export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  mkdir -p "$HOME" "$TMP/project/subdir"
  # shellcheck disable=SC1090
  source "$SCRIPT"
  proj_hash() { printf 'test-hash\n'; }

  make_vscode_state "$HOME" '{"uriTrustInfo":[{"trusted":true,"uri":{"scheme":"file","path":"'"$TMP"'/project"}}]}'
  [[ "$(vscode_trust_detect "$TMP/project")" == $'trusted_direct\t'"$TMP/project" ]] ||
    fail "direct VS Code trust was not detected"
  [[ "$(vscode_trust_detect "$TMP/project/subdir")" == $'trusted_parent\t'"$TMP/project" ]] ||
    fail "inherited VS Code trust was not detected"

  python3 - "$HOME/Library/Application Support/Code/User/settings.json" <<'PY'
import sys
from pathlib import Path
Path(sys.argv[1]).write_text('// comment\n{"security.workspace.trust.enabled": false,}\n')
PY
  [[ "$(vscode_trust_detect "$TMP/project")" == $'trust_disabled\tWorkspace Trust is disabled in VS Code settings' ]] ||
    fail "disabled Workspace Trust was not detected"
  rm "$HOME/Library/Application Support/Code/User/settings.json"

  if vscode_trust_preflight "$TMP/project" >"$TMP/preflight.out" 2>"$TMP/preflight.err"; then
    fail "trusted project continued in non-interactive mode"
  else
    [[ $? -eq 2 ]] || fail "trusted project returned the wrong non-interactive status"
  fi
  grep -q 'Non-interactive mode' "$TMP/preflight.err" || fail "non-interactive guidance was not printed"
  grep -q 'rerun your OpenCode VM command' < <(vscode_trust_print_protection_help trusted_direct "$TMP/project") ||
    fail "protection help did not tell the user to rerun"

  vscode_trust_save_exemption "$TMP/project"
  vscode_trust_has_exemption "$TMP/project" || fail "remembered choice was not saved"
  vscode_trust_preflight "$TMP/project" || fail "remembered choice did not allow startup"
  vscode_trust_reset_exemption "$TMP/project"
  if vscode_trust_has_exemption "$TMP/project"; then fail "remembered choice was not reset"; fi
)
pass "detects VS Code trust, prints protection guidance, and scopes remembered choices"

(
  export HOME="$TMP/lifecycle-home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  mkdir -p "$HOME" "$TMP/lifecycle-project"
  # shellcheck disable=SC1090
  source "$SCRIPT"
  proj_hash() { printf 'lifecycle-hash\n'; }
  make_vscode_state "$HOME" '{"uriTrustInfo":[{"trusted":true,"uri":{"scheme":"file","path":"'"$TMP"'/lifecycle-project"}}]}'
  need() { fail "session lifecycle dependency check ran before trust preflight"; }

  if ( cd "$TMP/lifecycle-project" && start_session ) >"$TMP/start.out" 2>"$TMP/start.err"; then
    fail "start continued despite a non-interactive trust decision"
  else
    [[ $? -eq 2 ]] || fail "start returned the wrong preflight status"
  fi
)
pass "blocks session lifecycle work until a trust decision is made"
