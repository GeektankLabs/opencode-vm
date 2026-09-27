#!/usr/bin/env bash
# Globals below are consumed by the production functions loaded dynamically.
# shellcheck disable=SC2034
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"

fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$*"; }
proj_hash() { printf 'lifecycle-test\n'; }
sanitize_lima_sock_dir() { :; }
is_vm_running() { [[ "$running" == 1 ]]; }
limactl() {
  [[ "$1" == list ]] || printf '%s\n' "$*" >> "$TMP/lima.log"
  case "$1" in
    stop) [[ "$stop_fails" == 0 ]] || return 1; running=0 ;;
    delete) [[ "$delete_fails" == 0 ]] || return 1 ;;
  esac
}
pgrep() { [[ "${writer_running:-0}" == 1 ]]; }
export -f pgrep
export writer_running=0
vm_exec() {
  [[ "$capture_fails" == 0 ]] || return 1
  local code="$2"
  code="${code//\/tmp\//$TMP/guest/}"
  bash -c "$code" _ "${@:3}"
}

reset_case() {
  rm -rf "$AUTH_SYNC_DIR" "$SESSIONS_DIR" "$TMP/guest"
  mkdir -p "$HOST_DATA_DIR" "$TMP/guest/oc-xdg-data/opencode"
  printf '{}\n' > "$HOST_DATA_DIR/auth.json"
  share="$(session_share_dir /project)"
  mkdir -p "$share/xdg-data/opencode"
  auth_sync_begin /project generation "$share/xdg-data/opencode/auth.json"
  printf '{"test":{"type":"api","key":"final"}}\n' > "$TMP/guest/oc-xdg-data/opencode/auth.json"
  senv="$(session_env /project)"
  write_senv "$senv" oc-test /project hash tui '' 0 0 generation controller
  running=1 capture_fails=0 stop_fails=0 delete_fails=0 writer_running=0
  : > "$TMP/lima.log"
}
assert_preserved() {
  [[ -f "$senv" && -d "$share" ]] || fail 'tracker/share removed'
  [[ ! -s "$TMP/lima.log" ]] || fail 'VM stop/delete attempted before capture'
}

reset_case
capture_fails=1
if cleanup_sessions; then fail 'cleanup accepted failed live capture'; fi
assert_preserved
[[ "$(jq length "$HOST_DATA_DIR/auth.json")" == 0 ]] || fail 'seed was published'
pass 'cleanup rejects a stale share seed after transport failure'

reset_case
running=0
if _destroy_prev_session /project; then fail 'stopped destroy accepted seed'; fi
assert_preserved
pass 'stopped destroy preserves an unverified share and tracker'

reset_case
running=0
printf '{"test":{"type":"oauth","access":"old","refresh":"old","expires":1}}\n' > "$share/xdg-data/opencode/auth.json"
if auth_cmd resync; then fail 'resync accepted an unverified checkpoint'; fi
assert_preserved
[[ "$(jq length "$HOST_DATA_DIR/auth.json")" == 0 ]] || fail 'resync published unverified checkpoint'
mkdir -p "$AUTH_SYNC_DIR/runs/generation"
printf '{"test":{"type":"api","key":"verified"}}\n' > "$AUTH_SYNC_DIR/runs/generation/lifecycle-final.json"
auth_cmd resync
[[ "$(jq -r '.test.key' "$HOST_DATA_DIR/auth.json")" == verified ]] || fail 'resync ignored trusted snapshot'
pass 'stopped resync requires a trusted final snapshot, never a share checkpoint'

reset_case
rm "$TMP/guest/oc-xdg-data/opencode/auth.json"
if lifecycle_finalize_runtime oc-test generation "$share"; then fail 'missing live file accepted'; fi
assert_preserved
printf '[1]\n' > "$TMP/guest/oc-xdg-data/opencode/auth.json"
if lifecycle_finalize_runtime oc-test generation "$share"; then fail 'invalid live auth accepted'; fi
pass 'missing and invalid live files cannot fall back to an empty baseline'

reset_case
writer_running=1
if lifecycle_finalize_runtime oc-test generation "$share"; then fail 'active writer accepted'; fi
assert_preserved
pass 'unknown active writers prevent finalization without being killed'

# Exercise the actual guest lock, traps and foreground launch statements under
# a controlling terminal. The fixture child never forwards signals itself.
reset_case
python3 - "$ROOT/opencode-vm.sh" "$TMP" <<'PY'
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import sys
import time

script = Path(sys.argv[1])
root = Path(sys.argv[2]) / "pty"
text = script.read_text()
attach = text.split('  vm_exec "$SESS_NAME" \'\n    set -euo pipefail\n    exec 9>', 1)[1]
fresh = text.split('  if vm_exec "$sess" \'\n    set -euo pipefail\n    exec 9>', 1)[1]

def wait_for(fd, wanted):
    output = b""
    deadline = time.monotonic() + 10
    while wanted not in output:
        remaining = deadline - time.monotonic()
        assert remaining > 0, output.decode(errors="replace")
        assert select.select([fd], [], [], remaining)[0], output.decode(errors="replace")
        output += os.read(fd, 65536)
    return output

for mode in ("attach-tui", "fresh-tui", "fresh-shell", "attach-web", "fresh-web", "attach-web-tui", "fresh-web-tui", "attach-tui-mcp", "fresh-tui-mcp", "attach-tui-foreign"):
    work = root / mode
    work.mkdir(parents=True)
    guest = work / "guest"
    guest.mkdir()
    auth = guest / "oc-xdg-data/opencode/auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text("{}")
    (work / "aa-exec").write_text('#!/bin/bash\nshift 3\nexec "$@"\n')
    (work / "opencode").write_text('''#!/usr/bin/env python3
import json, os, signal, sys
from pathlib import Path
def finish(*args):
    Path(os.environ["TEST_AUTH"]).write_text(json.dumps({"test":{"type":"api","key":"after-stop"}}))
    sys.exit(0)
signal.signal(signal.SIGTERM, finish)
calls = Path(os.environ["TEST_GUEST"]) / "calls"
calls.mkdir(exist_ok=True)
(calls / str(os.getpid())).write_text(json.dumps(sys.argv[1:]))
if "web" not in sys.argv and "serve" not in sys.argv:
    assert os.isatty(0) and os.isatty(1)
    print("INPUT", flush=True)
    assert input() == "interactive-input"
print("CHILD_READY", flush=True)
while True:
    signal.pause()
''')
    for name in ("aa-exec", "opencode"):
        (work / name).chmod(0o755)
    source = attach if mode.startswith("attach") else fresh
    prelude = "    exec 9>" + source.split('    PROJ_DIR="$1"', 1)[0]
    sync = "    sync_vm_to_share() {" + source.split("    sync_vm_to_share() {", 1)[1].split("    trap sync_vm_to_share EXIT", 1)[0]
    handler = "shutdown_requested=0" + source.split("shutdown_requested=0", 1)[1].split("trap on_signal INT TERM HUP", 1)[0] + "trap on_signal INT TERM HUP\n"
    if mode.endswith("tui-mcp"):
        helper = re.search(r"^run_mcp_tui\(\) \{\n.*?^\}", text, re.M | re.S)[0]
        launch = '''
load_session_auth() { :; }
stop_mcp_adapter() { :; }
prepare_mcp_adapter() { mkdir -p "$SESS_SHARE/mcp"; }
start_mcp_adapter() { :; }
wait_for_mcp_adapter() { kill -0 "$OC_WEB_PID"; }
''' + helper + "\nrun_mcp_tui\n"
    elif mode.endswith("web-tui"):
        launch = re.split(r"\n\s*else\n", source.split('if [ "$OC_WEB_TUI" = "true" ]; then', 1)[1], maxsplit=1)[0]
    elif mode.endswith("web"):
        loop = source.split("serve_fails=0", 1)[1].split("\n        done" if mode.startswith("attach") else "\n          done", 1)[0]
        launch = "serve_fails=0" + loop + "\ndone\n"
    elif mode.endswith("shell"):
        launch = source.split('case "$OC_MODE" in', 1)[1].split("shell)", 1)[1].split(";;", 1)[0]
    else:
        launch = next(line for line in source.splitlines() if "aa-exec -p opencode-sandbox -- opencode || true" in line)
    # Only include a handler if this production mode installs it.
    if mode.startswith("fresh") and not mode.endswith("web") and source.index("shutdown_requested=0") > source.index('case "$OC_MODE" in'):
        handler = ""
    code = prelude + '''
stop_all_proxies() { :; }; stop_openlive_gateway() { :; }; stop_a2a() { :; }; stop_editor() { :; }
check_sqlite_dbs() { :; }; rsync() { :; }
OC_PORT_INTERNAL=4095
VM_DATA="$TEST_GUEST/oc-xdg-data"; VM_STATE="$TEST_GUEST/state"
SESS_SHARE="$TEST_GUEST/share"; mkdir -p "$SESS_SHARE"
''' + sync + "\ntrap sync_vm_to_share EXIT\n" + handler + launch
    code = code.replace("/tmp/", str(guest) + "/")
    env = dict(os.environ, HOME=str(work / "home"), PATH=str(work) + ":" + os.environ["PATH"],
               TEST_AUTH=str(auth), TEST_GUEST=str(guest))
    pid, fd = pty.fork()
    if pid == 0:
        os.execve("/bin/bash", ["bash", "-c", code], env)
    outsider = None
    try:
        if mode.endswith("shell"):
            # Bash job control must remain enabled and a foreground job must
            # also disappear when the managed interactive shell gets a hangup.
            os.write(fd, b'[[ -t 0 && -t 1 && $- == *m* ]] && printf "TTY_%s\\n" OK; printf \'{"test":{"type":"api","key":"after-stop"}}\' > "$TEST_AUTH"; bash -c \'printf "JOB_%s\\n" READY; exec sleep 60\'\n')
            assert b"TTY_OK\r\n" in wait_for(fd, b"JOB_READY\r\n"), mode
            os.write(fd, b'\x03')
            os.write(fd, b'printf "INT_%s\\n" OK; bash -c \'printf "STOP_%s\\n" READY; exec sleep 60\'\n')
            assert b"INT_OK\r\n" in wait_for(fd, b"STOP_READY\r\n"), mode
        elif not mode.endswith("web"):
            if mode.endswith("web-tui"):
                wait_for(fd, b"Press Enter to start TUI")
                os.write(fd, b"\n")
            wait_for(fd, b"INPUT\r\n")
            os.write(fd, b"interactive-input\n")
            wait_for(fd, b"CHILD_READY\r\n")
        else:
            wait_for(fd, b"CHILD_READY\r\n")
        def capture():
            return subprocess.run(["bash", "-c", '''
set -euo pipefail
source "$1"
is_vm_running() { return 0; }
vm_exec() {
  local code="$2"
  code="${code//\\/tmp\\//$TEST_GUEST/}"
  code="${code/flock -w 30 8/flock -w 2 8}"
  bash -c "$code" _ "${@:3}"
}
auth_sync_begin /project pty-run
lifecycle_finalize_runtime test-vm pty-run "$TEST_GUEST/share"
''', "_", str(script)], env=env, capture_output=True, text=True, timeout=10)
        if mode.endswith("foreign"):
            registered = (guest / "ocvm-runtime.child").read_text()
            # It even carries the same lock descriptor, but is not a child of
            # the managed supervisor and must never receive its stop signal.
            outsider = subprocess.Popen(["bash", "-c", 'exec 9>"$1"; printf "ready\\n"; exec sleep 60', "_", str(guest / "ocvm-runtime.lock")], stdout=subprocess.PIPE, text=True)
            assert outsider.stdout.readline() == "ready\n"
            (guest / "ocvm-runtime.child").write_text(f"{outsider.pid} TERM\n")
            rejected = capture()
            assert rejected.returncode != 0, "foreign child record allowed finalization"
            assert outsider.poll() is None, "foreign process was signaled"
            (guest / "ocvm-runtime.child").write_text(registered)
        result = capture()
        assert result.returncode == 0, f"{mode}: final capture failed: {result.stderr}"
        assert json.loads(auth.read_text())["test"]["key"] == "after-stop", mode
        assert json.loads((work / "home/.opencode-vm/auth-sync/runs/pty-run/lifecycle-final.json").read_text())["test"]["key"] == "after-stop", mode
        os.waitpid(pid, 0)
        if mode.endswith("tui-mcp"):
            calls = [json.loads(p.read_text()) for p in (guest / "calls").iterdir()]
            assert sorted(c[0] for c in calls) == ["attach", "serve"], calls
            assert ["serve", "--hostname", "127.0.0.1", "--port", "4095"] in calls, calls
            assert ["attach", "http://127.0.0.1:4095"] in calls, calls
        print(f"ok - production {mode} teardown preserves terminal behavior and waits for final auth")
    finally:
        if outsider is not None:
            outsider.terminate()
            outsider.wait()
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(fd)
PY

reset_case
lifecycle_finalize_runtime oc-test generation "$share"
[[ "$(jq -r '.test.key' "$HOST_DATA_DIR/auth.json")" == final ]] || fail 'live snapshot not merged'
completion="$(jq .nextCompletion "$AUTH_SYNC_DIR/state.json")"
running=0
printf '{}\n' > "$share/xdg-data/opencode/auth.json"
lifecycle_finalize_runtime oc-test generation "$share"
[[ "$(jq -r '.test.key' "$share/xdg-data/opencode/auth.json")" == final ]] || fail 'stopped snapshot not recovered'
[[ "$(jq .nextCompletion "$AUTH_SYNC_DIR/state.json")" == "$completion" ]] || fail 'retry gained completion priority'
pass 'keep/resume uses the host snapshot and preserves completion order'

running=1 capture_fails=1
if lifecycle_finalize_runtime oc-test generation "$share"; then fail 'recapture failure accepted'; fi
running=0
if lifecycle_finalize_runtime oc-test generation "$share"; then fail 'old receipt survived failed recapture'; fi
pass 'failed recapture invalidates prior stopped-recovery evidence'

reset_case
stop_fails=1
if cleanup_sessions; then fail 'stop failure accepted'; fi
[[ -f "$senv" && -d "$share" ]] || fail 'stop failure discarded state'
reset_case
delete_fails=1
if cleanup_sessions; then fail 'delete failure accepted'; fi
[[ -f "$senv" && -d "$share" ]] || fail 'delete failure discarded state'
reset_case
cleanup_sessions
[[ ! -f "$senv" && ! -d "$share" ]] || fail 'successful cleanup retained tracker'
[[ "$(jq -r '.test.key' "$HOST_DATA_DIR/auth.json")" == final ]] || fail 'delete lost live auth'
pass 'cleanup deletes only after capture, merge and successful VM stop/delete'

# Load the actual nested cleanup and shell dispatch bodies without starting Lima.
cleanup_code='' shell_code='' in_cleanup=0 in_shell=0
while IFS= read -r line; do
  [[ "$line" != '  cleanup() {' ]] || in_cleanup=1
  if (( in_cleanup )); then
    cleanup_code+="$line"$'\n'
    [[ "$line" != '  }' ]] || in_cleanup=0
  fi
  if [[ "$line" == '  shell)' ]]; then in_shell=1; continue; fi
  if (( in_shell )); then
    if [[ "$line" == '    ;;' ]]; then in_shell=0; else shell_code+="$line"$'\n'; fi
  fi
done < "$ROOT/opencode-vm.sh"
[[ -n "$cleanup_code" && -n "$shell_code" ]] || fail 'lifecycle bodies not found'
eval "$cleanup_code"
pick_host_cfg() { printf '%s/nonexistent\n' "$TMP"; }
reset_case
proj=/project sess=oc-test sess_share="$share" proj_state="$TMP/state" controller_id=controller
SESSION_MODE=tui clean_link=''
capture_fails=1
# The production cleanup removes EXIT traps, so invoke it in a subshell.
if (cleanup); then fail 'normal cleanup accepted capture failure'; fi
assert_preserved
pass 'normal cleanup returns failure and preserves the VM/share on capture failure'

controller_id=superseded
(cleanup)
assert_preserved
pass 'stale normal controller cannot capture or delete a newer session'

rsync() { :; }
check_sqlite_integrity() { :; }
graphify_persist_save_for_session() { :; }
ecc_enabled() { return 1; }
stop_host_port_forwards_in_vm() { :; }
stop_materialize_daemon() { :; }
_notify_kept_session_once() { :; }
_decide_cleanup_action() { printf '%s\n' "$exit_action"; }
for exit_action in keep delete; do
  reset_case
  auth_sync_begin /project oc-test "$share/xdg-data/opencode/auth.json"
  proj=/project sess=oc-test sess_share="$share" proj_state="$TMP/state" controller_id=controller
  OC_SHELL_OK=1 KEEP_HISTORY=0
  (cleanup)
  [[ "$(jq -r '.test.key' "$HOST_DATA_DIR/auth.json")" == final ]] || fail 'normal exit did not merge live auth'
  if [[ "$exit_action" == keep ]]; then
    [[ -f "$senv" && -d "$share" ]] || fail 'keep lost tracker/share'
  else
    [[ ! -f "$senv" && ! -d "$share" ]] || fail 'delete retained tracker/share'
  fi
done
pass 'actual normal keep and delete paths preserve the synchronous final auth'

reset_case
running=0
vscode_trust_preflight() { return 0; }
need() { :; }
if attach_session; then fail 'stopped attach accepted an unverified seed'; fi
assert_preserved
pass 'stopped attach refuses to boot before trusted auth recovery'

reset_case
running=0
start_session() { [[ -f "$senv" ]] || fail 'shell discarded tracker'; printf 'retained\n' > "$TMP/shell-result"; }
(eval "$shell_code")
[[ -f "$TMP/shell-result" && -f "$senv" ]] || fail 'stopped shell bypassed tracked recovery'
pass 'stopped shell delegates with the original tracker intact'
