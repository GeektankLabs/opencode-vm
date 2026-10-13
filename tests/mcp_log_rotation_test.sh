#!/usr/bin/env bash
# task_68085480 part 6: bounded/rotating adapter-log writer.
# Verifies the same convention the taskboard log uses (1 MiB limit, one `.1`
# backup), symlink refusal, bounded output and clean failure on a write error.
# Isolated temp layout; no live adapter, no FD exhaustion, no live changes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; chmod -R u+rwX "$TMP" 2>/dev/null || true' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1
mkdir -p "$HOME"
# shellcheck disable=SC1090
source "$ROOT/opencode-vm.sh"

fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fails=$((fails+1)); fi; }
LIMIT=$((1024 * 1024))
log="$TMP/adapter.log"
printf '%s\n' "" > "$log"; chmod 600 "$log"

# Feed >2x the limit; the writer must keep both files bounded and rotate once.
head -c $((LIMIT * 5 / 2)) /dev/zero | tr '\0' 'L' | python3 -u -c "$OC_MCP_LOG_WRITER_PY" "$log"
size=$(stat -c '%s' "$log")
check "active log stays within the 1 MiB limit" "[[ $size -le $LIMIT ]]"
check "one `.1` backup exists (retention)" "[[ -f '$log.1' ]]"
check "backup is also bounded" "[[ \$(stat -c '%s' '$log.1') -le $LIMIT ]]"
check "the active log is not empty after the streams" "[[ $size -gt 0 ]]"
check "log mode is 0600" "[[ \$(stat -c '%a' '$log') == 600 ]]"

# Unsafe symlink: the writer must refuse rather than follow it.
rm -f "$log" "$log.1"; target="$TMP/elsewhere"; printf 'secret\n' > "$target"
ln -s "$target" "$log"
set +e; head -c $((LIMIT * 2)) /dev/zero | python3 -u -c "$OC_MCP_LOG_WRITER_PY" "$log" >/dev/null 2>&1; rc=$?; set -e
check "symlinked log is refused (nonzero, target untouched)" "[[ $rc -ne 0 && \$(cat '$target') == secret ]]"

# Loggerausfall: unwritable directory -> clean nonzero exit, no partial write.
rm -f "$log" "$log.1"
bad="$TMP/ro/adapter.log"; mkdir -p "$TMP/ro"; printf '' > "$bad"; chmod 500 "$TMP/ro"
set +e; printf 'x\n' | python3 -u -c "$OC_MCP_LOG_WRITER_PY" "$bad" >/dev/null 2>&1; rc=$?; set -e
chmod 700 "$TMP/ro"
check "unwritable log path fails cleanly (nonzero)" "[[ $rc -ne 0 ]]"

echo
if [[ $fails -eq 0 ]]; then echo "PASS adapter-log rotation/retention/failure"; else echo "FAIL ($fails)"; exit 1; fi
