#!/usr/bin/env bash
# MCP adapter shutdown ownership regression (task_68085480 follow-up).
#
# The bounded adapter-log rotation wrapped the listener in a pipeline
#   ( aa-exec node | python writer ) &
# so `$!` named the pipeline subshell: stop killed the wrapper and the orphaned
# node kept the LISTEN socket (residual listener check failed on every stop).
# start_mcp_adapter now backgrounds node inside the brace group (left side of the
# pipe) so run.pid is the real node PID carrying the child marker. This test
# drives the real start_mcp_adapter/stop_mcp_adapter from the embedded web
# library against a fake aa-exec/node that binds a port, and asserts:
#   - run.pid is the real listener PID (child-marker owned) and the port is bound;
#   - stop frees the port, removes the pidfiles and leaves no node/writer orphan;
#   - repeated stop and stop->restart are safe;
#   - a foreign listener and an unmarked PID are never signalled.
# Linux-only (/proc + ss). Run with a private /tmp and PID namespace:
#   sudo unshare --mount --pid --fork --mount-proc bash -c \
#     'mount -t tmpfs tmpfs /tmp && bash tests/mcp_shutdown_test.sh'
set -euo pipefail

if [ ! -r /proc/self/cmdline ]; then echo "SKIP: /proc required (Linux)"; exit 0; fi
if [ -e /tmp/ocvm-mcp.sup.pid ] || [ -e /tmp/ocvm-mcp.run.pid ]; then
  echo "FATAL: foreign /tmp/ocvm-mcp*.pid present; run in a private /tmp namespace"; exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
NODE_PID=""; FOREIGN_PID=""; SLEEP_PID=""; WRONG_PID=""; FOREIGN_GEN_PID=""
cleanup() {
  set +e
  for v in "$NODE_PID" "$FOREIGN_PID" "$SLEEP_PID" "$WRONG_PID" "$FOREIGN_GEN_PID"; do
    [ -n "$v" ] && kill -KILL "$v" 2>/dev/null
  done
  [ -f /tmp/ocvm-mcp.sup.pid ] && kill -KILL "$(cat /tmp/ocvm-mcp.sup.pid)" 2>/dev/null
  [ -f /tmp/ocvm-mcp.run.pid ] && kill -KILL "$(cat /tmp/ocvm-mcp.run.pid)" 2>/dev/null
  rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid /tmp/ocvm-mcp-tunnel.lock
  rm -rf "$TMP"
}
trap cleanup EXIT

fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fails=$((fails+1)); fi; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }

LIB="$TMP/web.sh"; WRITER="$TMP/writer.py"
lib_line="$(grep -n "OCVM_WEB_LIB_SH <<'WEBLIB'" "$ROOT/opencode-vm.sh" | head -1 | cut -d: -f1)"
awk -v s="$lib_line" 'NR>s { if ($0=="WEBLIB") exit; print }' "$ROOT/opencode-vm.sh" > "$LIB"
awk '/OC_MCP_LOG_WRITER_PY <<.MCP_LOG./{f=1;next} f&&/^MCP_LOG$/{exit} f{print}' "$ROOT/opencode-vm.sh" > "$WRITER"
[ -s "$LIB" ] || { echo "not ok - web library not extracted"; exit 1; }
bash -n "$LIB" || { echo "not ok - extracted web library is not valid bash"; exit 1; }

BIN="$TMP/bin"; mkdir -p "$BIN"
printf '%s\n' '#!/usr/bin/env bash' \
  'if [ "${1:-}" = "-p" ]; then shift 2; fi' \
  'if [ "${1:-}" = "--" ]; then shift; fi' \
  'exec "$@"' > "$BIN/aa-exec"
FAKENODE="$TMP/fakenode.py"
printf '%s\n' \
  'import os, socket, time' \
  'port = int(os.environ["MCP_TEST_PORT"])' \
  's = socket.socket()' \
  's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)' \
  's.bind(("127.0.0.1", port))' \
  's.listen(16)' \
  'while True:' \
  '    try:' \
  '        c, _ = s.accept()' \
  '        c.close()' \
  '    except Exception:' \
  '        time.sleep(0.2)' > "$FAKENODE"
printf '%s\n' '#!/usr/bin/env bash' 'exec python3 "$FAKENODE" "${2:-}" "${1:-}"' > "$BIN/node"
chmod +x "$BIN/aa-exec" "$BIN/node"
export PATH="$BIN:$PATH" FAKENODE

export PROJ_DIR="$TMP/proj" SESS_SHARE="$TMP/share" OC_PORT=19173 OC_HOST_IP=127.0.0.1 OC_TLS=0
mkdir -p "$PROJ_DIR" "$SESS_SHARE/mcp/adapter/dist" "$SESS_SHARE/config/opencode"
: > "$SESS_SHARE/mcp/adapter/dist/main.js"
# shellcheck disable=SC1090
. "$LIB"
stop_mcp_tunnel() { return 0; }
mcp_self_unregister() { return 0; }

export OC_MCP_ENABLED=1
OC_MCP_GENERATION="testgen-$$"
OC_MCP_LOG_WRITER_PY="$(< "$WRITER")"
write_runtime() { printf '{"schema":1,"project":"p","projectHash":"h","generation":"%s","host":"127.0.0.1","port":%s,"listenPort":%s}\n' "$OC_MCP_GENERATION" "$1" "$1" > "$SESS_SHARE/mcp/runtime.json"; }
wait_node() {
  NODE_PID=""
  for _ in $(seq 1 60); do
    if [ -s /tmp/ocvm-mcp.run.pid ]; then
      NODE_PID="$(cat /tmp/ocvm-mcp.run.pid)"
      [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null && return 0
    fi
    sleep 0.1
  done
  return 1
}

# --- 1) start: run.pid is the real listener PID, port bound -----------------
PORT="$(free_port)"; export MCP_TEST_PORT="$PORT"; OC_MCP_PORT="$PORT"; export OC_MCP_PORT
write_runtime "$PORT"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
start_mcp_adapter
wait_node || true
for _ in $(seq 1 60); do listening "$PORT" && break; sleep 0.1; done
check "run.pid exists after start" "[ -s /tmp/ocvm-mcp.run.pid ]"
check "recorded PID is alive" "[ -n '$NODE_PID' ] && kill -0 '$NODE_PID' 2>/dev/null"
check "recorded PID carries the child marker" "grep -qsF 'ocvm-mcp-child-$OC_MCP_GENERATION' '/proc/$NODE_PID/cmdline'"
check "listener port $PORT is bound" "listening '$PORT'"

# --- 2) stop: port freed, no orphan, pidfiles removed ----------------------
set +e; stop_mcp_adapter; rc=$?; set -e
check "stop returns success" "[ $rc -eq 0 ]"
check "listener port is released" "! listening '$PORT'"
check "recorded listener PID is gone" "! kill -0 '$NODE_PID' 2>/dev/null"
check "run.pid removed on success" "[ ! -e /tmp/ocvm-mcp.run.pid ]"
check "sup.pid removed on success" "[ ! -e /tmp/ocvm-mcp.sup.pid ]"
check "no node/writer orphan references the adapter log" "! pgrep -f '$SESS_SHARE/mcp/adapter.log' >/dev/null 2>&1"

# --- 3) repeated stop is a safe no-op --------------------------------------
set +e; stop_mcp_adapter; rc=$?; set -e
check "second stop returns success" "[ $rc -eq 0 ]"

# --- 4) stop -> restart -----------------------------------------------------
PORT="$(free_port)"; export MCP_TEST_PORT="$PORT"; OC_MCP_PORT="$PORT"; export OC_MCP_PORT
write_runtime "$PORT"
start_mcp_adapter
wait_node || true
for _ in $(seq 1 60); do listening "$PORT" && break; sleep 0.1; done
check "restart binds the port again" "listening '$PORT'"
set +e; stop_mcp_adapter; rc=$?; set -e
check "restart stop returns success" "[ $rc -eq 0 ]"
check "restart port released" "! listening '$PORT'"

# --- 5) foreign listener is never killed or ignored ------------------------
PORT="$(free_port)"
python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(1)
time.sleep(120)' "$PORT" &
FOREIGN_PID=$!
for _ in $(seq 1 50); do listening "$PORT" && break; sleep 0.1; done
OC_MCP_PORT="$PORT"; export OC_MCP_PORT; write_runtime "$PORT"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
set +e; stop_mcp_adapter; rc=$?; set -e
check "stop fails closed while a foreign listener holds the port" "[ $rc -ne 0 ]"
check "foreign listener survives stop" "kill -0 '$FOREIGN_PID' 2>/dev/null && listening '$PORT'"
kill -KILL "$FOREIGN_PID" 2>/dev/null || true; wait "$FOREIGN_PID" 2>/dev/null || true; FOREIGN_PID=""

# --- 6) unmarked PID in a pidfile is never signalled -----------------------
sleep 300 & SLEEP_PID=$!
PORT="$(free_port)"; OC_MCP_PORT="$PORT"; export OC_MCP_PORT; write_runtime "$PORT"
printf '%s\n' "$SLEEP_PID" > /tmp/ocvm-mcp.run.pid
rm -f /tmp/ocvm-mcp.sup.pid
set +e; stop_mcp_adapter; rc=$?; set -e
check "stop refuses an unowned pidfile" "[ $rc -ne 0 ]"
check "unmarked PID survives" "kill -0 '$SLEEP_PID' 2>/dev/null"
kill -KILL "$SLEEP_PID" 2>/dev/null || true; wait "$SLEEP_PID" 2>/dev/null || true; SLEEP_PID=""
rm -f /tmp/ocvm-mcp.run.pid

# --- 7) missing pidfiles: socket-owner recovery stops the own listener ----
PORT="$(free_port)"; export MCP_TEST_PORT="$PORT"; OC_MCP_PORT="$PORT"; export OC_MCP_PORT
write_runtime "$PORT"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
start_mcp_adapter
wait_node || true
for _ in $(seq 1 60); do listening "$PORT" && break; sleep 0.1; done
check "missing-pid: listener is bound" "listening '$PORT'"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
set +e; stop_mcp_adapter; rc=$?; set -e
check "missing-pid: stop succeeds via socket-owner recovery" "[ $rc -eq 0 ]"
check "missing-pid: listener port is released" "! listening '$PORT'"
check "missing-pid: node is gone" "! kill -0 '$NODE_PID' 2>/dev/null"

# --- 8) legacy pipeline: run.pid is stale, node orphaned, recovery works --
PORT="$(free_port)"; export MCP_TEST_PORT="$PORT"; OC_MCP_PORT="$PORT"; export OC_MCP_PORT
write_runtime "$PORT"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
start_mcp_adapter
wait_node || true
for _ in $(seq 1 60); do listening "$PORT" && break; sleep 0.1; done
check "legacy: listener is bound" "listening '$PORT'"
sleep 300 & WRONG_PID=$!
printf '%s\n' "$WRONG_PID" > /tmp/ocvm-mcp.run.pid
rm -f /tmp/ocvm-mcp.sup.pid
set +e; stop_mcp_adapter; rc=$?; set -e
check "legacy: stop succeeds via socket-owner recovery" "[ $rc -eq 0 ]"
check "legacy: listener port is released" "! listening '$PORT'"
check "legacy: node is gone" "! kill -0 '$NODE_PID' 2>/dev/null"
check "legacy: wrong PID survives (unmarked)" "kill -0 '$WRONG_PID' 2>/dev/null"
kill -KILL "$WRONG_PID" 2>/dev/null || true; wait "$WRONG_PID" 2>/dev/null || true

# --- 9) foreign generation: listener with different marker is not killed --
PORT="$(free_port)"
python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(1)
time.sleep(120)' "$PORT" "$SESS_SHARE/mcp/adapter" ocvm-mcp-child-othergen &
FOREIGN_GEN_PID=$!
for _ in $(seq 1 50); do listening "$PORT" && break; sleep 0.1; done
OC_MCP_PORT="$PORT"; export OC_MCP_PORT; write_runtime "$PORT"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
set +e; stop_mcp_adapter; rc=$?; set -e
check "foreign-gen: stop fails closed" "[ $rc -ne 0 ]"
check "foreign-gen: listener survives" "kill -0 '$FOREIGN_GEN_PID' 2>/dev/null && listening '$PORT'"
kill -KILL "$FOREIGN_GEN_PID" 2>/dev/null || true; wait "$FOREIGN_GEN_PID" 2>/dev/null || true

# --- 10) stale pidfile: dead PID is cleaned up, real listener stopped ------
PORT="$(free_port)"; export MCP_TEST_PORT="$PORT"; OC_MCP_PORT="$PORT"; export OC_MCP_PORT
write_runtime "$PORT"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
start_mcp_adapter
wait_node || true
for _ in $(seq 1 60); do listening "$PORT" && break; sleep 0.1; done
check "stale-pid: listener is bound" "listening '$PORT'"
printf '%s\n' '999999' > /tmp/ocvm-mcp.run.pid
rm -f /tmp/ocvm-mcp.sup.pid
set +e; stop_mcp_adapter; rc=$?; set -e
check "stale-pid: stop succeeds" "[ $rc -eq 0 ]"
check "stale-pid: listener port is released" "! listening '$PORT'"
check "stale-pid: node is gone" "! kill -0 '$NODE_PID' 2>/dev/null"
check "stale-pid: stale pidfile removed" "[ ! -e /tmp/ocvm-mcp.run.pid ]"

# --- 11) F1: live wrong PID in run.pid cleaned up after recovery; 2nd stop -
PORT="$(free_port)"; export MCP_TEST_PORT="$PORT"; OC_MCP_PORT="$PORT"; export OC_MCP_PORT
write_runtime "$PORT"
rm -f /tmp/ocvm-mcp.sup.pid /tmp/ocvm-mcp.run.pid
start_mcp_adapter
wait_node || true
for _ in $(seq 1 60); do listening "$PORT" && break; sleep 0.1; done
check "f1: listener is bound" "listening '$PORT'"
sleep 300 & WRONG_PID=$!
printf '%s\n' "$WRONG_PID" > /tmp/ocvm-mcp.run.pid
rm -f /tmp/ocvm-mcp.sup.pid
set +e; stop_mcp_adapter; rc=$?; set -e
check "f1: first stop succeeds" "[ $rc -eq 0 ]"
check "f1: own adapter gone" "! kill -0 '$NODE_PID' 2>/dev/null"
check "f1: port released" "! listening '$PORT'"
check "f1: foreign PID survives" "kill -0 '$WRONG_PID' 2>/dev/null"
check "f1: stale wrong run.pid removed after recovery" "[ ! -e /tmp/ocvm-mcp.run.pid ]"
set +e; stop_mcp_adapter; rc=$?; set -e
check "f1: second stop is idempotent success" "[ $rc -eq 0 ]"
kill -KILL "$WRONG_PID" 2>/dev/null || true; wait "$WRONG_PID" 2>/dev/null || true; WRONG_PID=""

echo
if [ "$fails" -eq 0 ]; then echo "PASS mcp shutdown ownership"; else echo "FAIL ($fails)"; exit 1; fi
