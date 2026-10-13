#!/usr/bin/env bash
# task_68085480 part 6: bounded/rotating adapter-log writer.
# The writer is embedded in opencode-vm.sh inside the web library (WEBLIB) where
# start_mcp_adapter lives; it is set when that library is sourced, not by sourcing
# opencode-vm.sh itself. This test extracts the real embedded writer bytes and
# exercises them directly: 1 MiB limit + one `.1` backup, symlink refusal, and
# graceful drain (rc 0, no EPIPE/restart loop) when the diagnostic target breaks
# mid-stream. Isolated temp layout; no live adapter, no FD exhaustion.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; chmod -R u+rwX "$TMP" 2>/dev/null || true' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"

WRITER="$TMP/writer.py"
awk '/OC_MCP_LOG_WRITER_PY <<.MCP_LOG./{f=1;next} f&&/^MCP_LOG$/{exit} f{print}' "$ROOT/opencode-vm.sh" > "$WRITER"
if [[ ! -s "$WRITER" ]]; then echo "not ok - embedded OC_MCP_LOG_WRITER_PY not found"; exit 1; fi
python3 -c 'import sys; compile(open(sys.argv[1]).read(), "writer", "exec")' "$WRITER" \
  || { echo "not ok - extracted writer is not valid python"; exit 1; }

fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fails=$((fails+1)); fi; }
LIMIT=$((1024 * 1024))
log="$TMP/adapter.log"
: > "$log"; chmod 600 "$log"

# Rotation/retention: two full runs keep both files bounded with exactly one backup.
head -c $((LIMIT * 5 / 2)) /dev/zero | tr '\0' 'L' | python3 -u "$WRITER" "$log"
check "active log stays within the 1 MiB limit" "[[ \$(stat -c '%s' "$log") -le $LIMIT ]]"
check "one .1 backup exists (retention)" "[[ -f '$log.1' ]]"
check "backup is bounded" "[[ \$(stat -c '%s' '$log.1') -le $LIMIT ]]"
check "active log non-empty" "[[ \$(stat -c '%s' "$log") -gt 0 ]]"
check "log mode is 0600" "[[ \$(stat -c '%a' "$log") == 600 ]]"
head -c $((LIMIT * 2)) /dev/zero | tr '\0' 'M' | python3 -u "$WRITER" "$log"
check "still exactly one backup after another rotation" "[[ -f '$log.1' && ! -e '$log.2' && \$(stat -c '%s' "$log") -le $LIMIT ]]"

# Symlinked target: refused without following it; writer drains and exits cleanly.
rm -f "$log" "$log.1"; secret="$TMP/elsewhere"; printf 'secret\n' > "$secret"; ln -s "$secret" "$log"
set +e; head -c $((LIMIT)) /dev/zero | tr '\0' 'X' | python3 -u "$WRITER" "$log" >/dev/null 2>&1; rc=$?; set -e
check "symlinked target refused gracefully (rc 0, target untouched)" "[[ $rc -eq 0 && \$(cat "$secret") == secret && ! -e '$log.1' ]]"

# Broken target from the start (missing parent dir): drain, rc 0, nothing created.
rm -f "$log" "$log.1"; missing="$TMP/nope/adapter.log"
set +e; head -c $((LIMIT)) /dev/zero | tr '\0' 'Y' | python3 -u "$WRITER" "$missing" >/dev/null 2>&1; rc=$?; set -e
check "missing target dir -> graceful drain (rc 0), nothing created" "[[ $rc -eq 0 && ! -e '$missing' ]]"

# Target breaks MID-STREAM: rotation to `$log.1` fails because `.1` is a directory.
# The writer must keep draining stdin and exit 0 (no EPIPE for the child, no restart loop),
# and must not append without bound past the limit.
rm -f "$log" "$log.1"; : > "$log"; chmod 600 "$log"; mkdir "$log.1"
set +e; head -c $((LIMIT * 3)) /dev/zero | tr '\0' 'Z' | python3 -u "$WRITER" "$log" >/dev/null 2>&1; rc=$?; set -e
check "mid-stream target failure -> graceful rc 0 (no EPIPE/restart)" "[[ $rc -eq 0 ]]"
check "active log stayed bounded after mid-stream failure" "[[ \$(stat -c '%s' "$log") -le $LIMIT ]]"
rm -rf "$log.1"

echo
if [[ $fails -eq 0 ]]; then echo "PASS adapter-log rotation/retention/drain"; else echo "FAIL ($fails)"; exit 1; fi
