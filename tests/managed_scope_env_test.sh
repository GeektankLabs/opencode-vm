#!/usr/bin/env bash
# R3 regression: the operator's external-scope declarations are validated on
# the host (fail closed) and forwarded into both runtime blocks (attach and
# start) as arguments 26/27, exported in the VM for the A2A supervisor and the
# OpenLive gateway. Source-level + function-level checks; no VM is started.
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

# Function-level: normalization, dedup and fail-closed validation.
[[ -z "$(managed_scope_env_normalize "" X)" ]] || fail "empty input must stay empty"
[[ "$(managed_scope_env_normalize "/srv/data:/srv/data/" X)" == "/srv/data" ]] || fail "normalized duplicates must dedup"
[[ "$(managed_scope_env_normalize "/a//:/b/" X)" == "/a:/b" ]] || fail "all trailing slashes are trimmed"
for invalid in "relative" "/" "/a/../b" "/a/./b" "/a..b/../c" "$(printf '/a/b\tx')"; do
  if managed_scope_env_normalize "$invalid" X >/dev/null 2>&1; then fail "invalid declaration accepted: $invalid"; fi
done
if managed_scope_env_normalize "$(for i in $(seq 1 17); do printf '/d/%s:' "$i"; done | sed 's/:$//')" X >/dev/null 2>&1; then
  fail "17 directories must be rejected"
fi
[[ -n "$(managed_scope_env_normalize "/d/1" X)" ]] || fail "single valid directory rejected"
pass "managed_scope_env_normalize validates, normalizes and fails closed"

# Source-level: both runtime blocks export the forwarded values, and both
# call sites pass them as arguments 26/27 (fail-closed precomputed locals).
script="$ROOT/opencode-vm.sh"
exports="$(grep -c 'export OCVM_A2A_SCOPE_DIRS="${26:-}"' "$script")"
[[ "$exports" == 2 ]] || fail "expected two in-VM OCVM_A2A_SCOPE_DIRS exports, found $exports"
exports="$(grep -c 'export OCVM_OPENLIVE_SCOPE_DIRS="${27:-}"' "$script")"
[[ "$exports" == 2 ]] || fail "expected two in-VM OCVM_OPENLIVE_SCOPE_DIRS exports, found $exports"
grep -q 'attach_a2a_scope="$(managed_scope_env_normalize "${OCVM_A2A_SCOPE_DIRS:-}" OCVM_A2A_SCOPE_DIRS)"' "$script" \
  || fail "attach precompute missing"
grep -q 'sess_a2a_scope="$(managed_scope_env_normalize "${OCVM_A2A_SCOPE_DIRS:-}" OCVM_A2A_SCOPE_DIRS)"' "$script" \
  || fail "start precompute missing"
grep -q '"$attach_a2a_scope" \\' "$script" && grep -q '"$attach_ol_scope" || {' "$script" \
  || fail "attach call site does not forward the precomputed scope"
grep -q '"$sess_a2a_scope" \\' "$script" && grep -q '"$sess_ol_scope"; then' "$script" \
  || fail "start call site does not forward the precomputed scope"
pass "both runtime blocks forward and export the operator scope declarations"

printf 'all ok\n'
