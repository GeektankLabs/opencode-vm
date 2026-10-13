#!/usr/bin/env bash
# task_68085480 part 6: bounded/rotating adapter-log writer.
# The writer is embedded in opencode-vm.sh inside the web library (WEBLIB) where
# start_mcp_adapter lives; it is set when that library is sourced, not by sourcing
# opencode-vm.sh itself. This test extracts the real embedded writer bytes and
# exercises them directly (1 MiB limit, one `.1` backup, symlink refusal, clean
# failure). Isolated temp layout; no live adapter, no FD exhaustion.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; chmod -R u+rwX "$TMP" 2>/dev/null || true' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"

WRITER_PY="$(awk '/OC_MCP_LOG_WRITER_PY <<.MCP_LOG./{f=1;next} f&&/^MCP_LOG$/{exit} f{print}' "$ROOT/opencode-vm.sh")"
if [[ -z "$WRITER_PY" ]]; then echo "not ok - embedded OC_MCP_LOG_WRITER_PY not found in opencode-vm.sh"; exit 1; fi
# The extremely cheap extractor must be a real python program.
printf '%s\n' "$WRITER_PY" | python3 -c 'import sys; compile(sys.stdin.read(), "writer", "exec")' \
  || { echo "not ok - extracted writer is not valid python"; exit 1; }

fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fails=$((fails+1)); fi; }
LIMIT=$((1024 * 1024))
log="$TMP/adapter.log"
: > "$log"; chmod 600 "$log"

# Feed >2x the limit; both files stay bounded and rotation keeps exactly one backup.
head -c $((LIMIT * 5 / 2)) /dev/zero | tr '\0' 'L' | python3 -u -c "$WRITER_PY" "$log"
size=$(stat -c '%s' "$log")
check "active log stays within the 1 MiB limit" "[[ $size -le $LIMIT ]]"
check "one .1 backup exists (retention)" "[[ -f '$log.1' ]]"
check "backup is also bounded" "[[ \$(stat -c '%s' '$log.1') -le $LIMIT ]]"
check "active log non-empty" "[[ $size -gt 0 ]]"
check "log mode is 0600" "[[ \$(stat -c '%a' "$log") == 600 ]]"
# A second full run still keeps exactly one backup (no unbounded .1 growth).
head -c $((LIMIT * 2)) /dev/zero | tr '\0' 'M' | python3 -u -c "$WRITER_PY" "$log"
check "still exactly one backup after another rotation" "[[ -f '$log.1' && ! -e '$log.2' && \$(stat -c '%s' '$log') -le $LIMIT ]]"

# Unsafe symlink: refuse rather than follow it.
rm -f "$log" "$log.1"; target="$TMP/elsewhere"; printf 'secret\n' > "$target"
ln -s "$target" "$log"
set +e; head -c $((LIMIT * 2)) /dev/zero | python3 -u -c "$WRITER_PY" "$log" >/dev/null 2>&1; rc=$?; set -e
check "symlinked log refused (nonzero, target untouched)" "[[ $rc -ne 0 && \$(cat "$target") == secret ]]"

# Logger failure: a log path whose parent directory does not exist makes the
# append open fail deterministically (ENOENT) -> clean nonzero exit, no hang.
bad="$TMP/missing-dir/adapter.log"
set +e; printf 'x\n' | python3 -u -c "$WRITER_PY" "$bad" >/dev/null 2>&1; rc=$?; set -e
check "unwritable log path fails cleanly (nonzero)" "[[ $rc -ne 0 && ! -e '$bad' ]]"

echo
if [[ $fails -eq 0 ]]; then echo "PASS adapter-log rotation/retention/failure"; else echo "FAIL ($fails)"; exit 1; fi
