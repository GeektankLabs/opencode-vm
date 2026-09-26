#!/usr/bin/env bash
# Globals are used by sourced production functions.
# shellcheck disable=SC2034
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME" "$TMP/a" "$TMP/b" "$TMP/c" "$TMP/d" "$TMP/e" "$TMP/unconfigured"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"
if [[ "$(uname -s)" == Linux ]]; then
  md5() { printf '%s' "$(md5sum | cut -d' ' -f1)"; }
  export -f md5
fi
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
check() { jq -e "$2" "$1" >/dev/null || fail "$2"; }
in_project() ( local path="$1"; shift; cd "$path"; "$@"; )
ensure_dirs
export TEST_TUNNEL_KEY='sk-tunnel-fixture-secret'
ID=tunnel_0123456789abcdef0123456789abcdef
ID2=tunnel_11111111111111111111111111111111
registry="$MCP_TUNNEL_DIR/registry.json"
in_project "$TMP/a" provider_cmd mcp new openai --tunnel-api-key env:TEST_TUNNEL_KEY --tunnel-id "$ID" > "$TMP/new.log"
check "$registry" '.schema == 2 and (.keys | length) == 1 and (.projects | length) == 1'
KEY_ID="$(jq -r '.keys | keys[0]' "$registry")"
A="$(proj_hash "$TMP/a")"
B="$(proj_hash "$TMP/b")"
[[ "$(stat -c %a "$registry")" == 600 && "$(stat -c %a "$MCP_TUNNEL_DIR")" == 700 ]] || fail 'private modes'
in_project "$TMP/a" provider_cmd mcp status openai > "$TMP/status.log"
provider_cmd mcp list > "$TMP/list.log"
if grep -qF "$TEST_TUNNEL_KEY" "$TMP/new.log" "$TMP/status.log" "$TMP/list.log"; then fail 'secret in CLI output'; fi
grep -q 'not yet verified' "$TMP/new.log" || fail 'setup claimed connectivity'
grep -q '2026-09-26' "$TMP/list.log" || fail 'missing dated product note'
grep -q 'wrong project' "$TMP/new.log" || fail 'missing tunnel reuse notice'
[[ ! -e "$HOST_DATA_DIR/auth.json" && ! -e "$HOST_CFG_JSON" ]] || fail 'tunnel modified model auth/config'
pass 'private project registry, redacted status/list, reuse notice and dated plan information'

cp "$registry" "$TMP/before.json"
for args in '' 'rm' 'new openai --tunnel-id bad --api-key value' 'new openai' 'rm other' 'status openai extra' 'new openai --key-id absent --tunnel-id tunnel_0123456789abcdef0123456789abcdef'; do
  # shellcheck disable=SC2086
  if in_project "$TMP/a" provider_cmd mcp $args </dev/null >"$TMP/error.log" 2>&1; then fail "accepted invalid input: $args"; fi
done
cmp -s "$registry" "$TMP/before.json" || fail 'invalid input replaced registry'
chmod 644 "$registry"
if mcp_tunnel_registry view >"$TMP/error.log" 2>&1; then fail 'accepted public registry'; fi
chmod 600 "$registry"
mv "$registry" "$TMP/real.json"
ln -s "$TMP/real.json" "$registry"
if mcp_tunnel_registry view >"$TMP/error.log" 2>&1; then fail 'accepted symlink registry'; fi
rm "$registry"
mv "$TMP/real.json" "$registry"
pass 'invalid input and unsafe registry files preserve existing configuration'

in_project "$TMP/b" provider_cmd mcp new openai --api-key env:TEST_TUNNEL_KEY --tunnel-id "$ID2" > /dev/null
ln -s "$TMP/a" "$TMP/alias"
in_project "$TMP/alias" provider_cmd mcp new openai --key-id "$KEY_ID" --tunnel-id "$ID" > /dev/null
check "$registry" '.keys | length == 1'
check "$registry" '.projects | length == 2'
[[ "$(jq -r --arg key "$KEY_ID" '.keys[$key].createdIn' "$registry")" == "$TMP/a" ]] || fail 'reuse lost origin'
printf 'sk-second-fixture\n' > "$TMP/key"
in_project "$TMP/c" provider_cmd mcp new openai --tunnel-api-key "file:$TMP/key" --tunnel-id "$ID" > /dev/null
check "$registry" '.keys | length == 2'
KEY2="$(jq -r '.keys | to_entries[] | select(.value.value == "sk-second-fixture") | .key' "$registry")"
for project in d e; do
  in_project "$TMP/$project" provider_cmd mcp new openai --key-id "$KEY_ID" --tunnel-id "$ID2" > "$TMP/$project.log" &
done
wait
check "$registry" '.projects | length == 5'
pass 'key deduplication, canonical project identity, independent keys, and concurrent registry edits'

# Test actual host startup, using existing session records and a fake VM transport.
# Deliberately use the same tunnel ID in two projects: both must be allowed.
in_project "$TMP/b" provider_cmd mcp new openai --key-id "$KEY_ID" --tunnel-id "$ID" >/dev/null
for project in a b; do
  share="$(session_share_dir "$TMP/$project")"
  mkdir -p "$share"
  write_senv "$(session_env "$TMP/$project")" "oc-$project" "$TMP/$project" hash web 4096 0 1 generation "controller-$project" 1 40960
  ensure_mcp_credential "$share"
done
mcp_tunnel_vm_state() { printf 'Running\n'; }
mcp_tunnel_remote() {
  local vm
  vm="$(jq -r .vm <<<"$1")"
  if [[ "$2" == stop ]]; then
    [[ ! -f "$TMP/refuse-stop" ]] || return 1
    rm -f "$TMP/$vm.active"
    printf '%s:stop\n' "$vm" >> "$TMP/events"
  elif [[ -f "$TMP/$vm.active" ]]; then
    printf '{"process":"active","ready":true,"controlPlane":"polling","connected":true}\n'
  else
    printf '{"process":"inactive","ready":false,"controlPlane":"unknown"}\n'
  fi
}
vm_exec() {
  jq -e --arg tunnel "$ID" '.apiKey == "sk-tunnel-fixture-secret" and .tunnelId == $tunnel' >/dev/null
  sleep 0.2
  printf '%s:start\n' "$1" >> "$TMP/events"
  touch "$TMP/$1.active"
}
mcp_tunnel_start oc-a "$TMP/a" "$(session_share_dir "$TMP/a")" controller-a > "$TMP/a.log" &
one=$!
mcp_tunnel_start oc-b "$TMP/b" "$(session_share_dir "$TMP/b")" controller-b > "$TMP/b.log" &
two=$!
wait "$one"
wait "$two"
[[ "$(wc -l < "$TMP/events")" == 2 ]] || fail 'parallel same-tunnel projects were blocked'
[[ ! -e "$MCP_TUNNEL_DIR/owner.json" ]] || fail 'global occupancy metadata created'
touch "$TMP/refuse-stop"
if provider_cmd mcp rm openai --project "$A" > "$TMP/rm.log" 2>&1; then fail 'removal ignored failed shutdown'; fi
check "$registry" ".projects | has(\"$A\")"
rm "$TMP/refuse-stop"
provider_cmd mcp rm openai --project "$A" > "$TMP/rm.log"
[[ ! -e "$TMP/oc-a.active" && -e "$TMP/oc-b.active" ]] || fail 'removal touched another project'
check "$registry" ".projects | has(\"$A\") | not"
check "$registry" '.keys | length == 2'
if provider_cmd mcp rm openai --key-id "$KEY_ID" > "$TMP/rm.log" 2>&1; then fail 'referenced key deleted'; fi
if provider_cmd mcp rm openai --tunnel-id "$ID" > "$TMP/rm.log" 2>&1; then fail 'referenced tunnel deleted'; fi
in_project "$TMP/c" provider_cmd mcp rm openai >/dev/null
provider_cmd mcp rm openai --key-id "$KEY2" >/dev/null
check "$registry" '.keys | length == 1'
before="$(wc -l < "$TMP/events")"
mcp_tunnel_start oc-b "$TMP/b" "$(session_share_dir "$TMP/b")" old-controller
[[ "$(wc -l < "$TMP/events")" == "$before" ]] || fail 'superseded watcher started a tunnel'
pass 'no tunnel occupancy manager; project-only stop, retained reusable entries and reference-safe explicit deletion'

[[ "$(mcp_session_mode tui "$TMP/b")" == tui-mcp ]] || fail 'configured start missing server-backed TUI'
[[ "$(mcp_session_mode tui "$TMP/unconfigured")" == tui ]] || fail 'unconfigured start changed mode'
parse_start_flags --no-mcp
[[ "$(mcp_session_mode tui-mcp "$TMP/b")" == tui ]] || fail 'suppression ignored'
parse_start_flags
[[ "$(mcp_session_mode tui "$TMP/b")" == tui-mcp ]] || fail 'suppression leaked to next run'
pass 'configured start is automatic, unconfigured start stays TUI, suppression is per invocation'

# Execute attach through mode selection and old-runtime teardown, then stop at
# auth preparation before unrelated sync/server work. Only VM boundaries and
# external preparation are stubbed; old mode/port must survive until cleanup.
for scenario in web-to-tui suppressed-tui resume-web; do
  (
    cd "$TMP/b"
    SESSION_LAUNCH_MODE=tui SESSION_PORT=4096 SESSION_MCP_MODE=""
    prior=web enabled=1
    case "$scenario" in
      suppressed-tui) prior=tui-mcp; SESSION_MCP_MODE=disable ;;
      resume-web) SESSION_LAUNCH_MODE=web; enabled=0 ;;
    esac
    write_senv "$(session_env "$TMP/b")" oc-b "$TMP/b" hash "$prior" 7777 0 0 old-generation old-controller "$enabled" 40960
    events="$TMP/$scenario.events"
    need() { :; }
    vscode_trust_preflight() { :; }
    sanitize_lima_sock_dir() { :; }
    is_vm_running() { return 0; }
    get_host_ip() { printf '127.0.0.1\n'; }
    apply_policy_in_vm() { :; }
    setup_host_port_forwards_in_vm() { :; }
    graphify_ensure_mcp_in_vm() { :; }
    mcp_prepare_adapter_cache() { printf 'prepare-mcp\n' >> "$events"; }
    lifecycle_finalize_runtime() { printf 'finalize\n' >> "$events"; }
    a2a_ensure_installed_in_vm() { printf 'prepare-a2a\n' >> "$events"; }
    stop_web_tunnels() { printf 'stop-forward:%s\n' "$2" >> "$events"; }
    install_web_lib() { :; }
    vm_exec() { printf 'guest-cleanup\n' >> "$events"; }
    stop_materialize_daemon() { printf 'stop-materialize\n' >> "$events"; }
    openlive_unstage_adapter() { printf 'unstage-openlive\n' >> "$events"; }
    resolve_session_auth() { printf 'reached-auth\n' >> "$events"; return 1; }
    if attach_session > "$TMP/$scenario.log" 2>&1; then fail 'fixture did not stop at auth boundary'; fi
    grep -qx 'reached-auth' "$events" || fail 'attach failed before expected boundary'
    grep -qx 'stop-forward:7777' "$events" || fail 'old port was overwritten before cleanup'
    if [[ "$scenario" == suppressed-tui ]]; then
      if grep -q 'prepare-mcp' "$events"; then fail 'suppressed attach prepared MCP'; fi
    else
      grep -qx 'prepare-mcp' "$events" || fail 'MCP was not re-evaluated on attach'
    fi
    if [[ "$scenario" == web-to-tui ]]; then
      grep -qx 'stop-materialize' "$events" || fail 'web-only daemon retained in terminal mode'
      grep -qx 'unstage-openlive' "$events" || fail 'web-only staging retained in terminal mode'
      if grep -q 'prepare-a2a' "$events"; then fail 'terminal mode prepared web services'; fi
    fi
  )
done
pass 'attach re-evaluates suppression and cleans prior web ports/services before switching to terminal'

# Read legacy state as an unassigned reusable pool; commit migration with setup.
(
  MCP_TUNNEL_DIR="$HOME/.opencode-vm/mcp-tunnel/legacy"
  mkdir -m 700 "$MCP_TUNNEL_DIR"
  ( umask 077; printf '{"schema":1,"apiKey":"sk-legacy","tunnelId":"%s"}\n' "$ID" > "$MCP_TUNNEL_DIR/config.json" )
  view="$(mcp_tunnel_registry view)"
  [[ "$(jq '.projects | length' <<<"$view")" == 0 ]] || fail 'legacy credentials activated arbitrary projects'
  [[ "$(mcp_session_mode tui "$TMP/a")" == tui ]] || fail 'legacy global config auto-activated'
  in_project "$TMP/a" provider_cmd mcp new openai --key-id key_legacy --tunnel-id "$ID" >/dev/null
  [[ -f "$MCP_TUNNEL_DIR/registry.json" && ! -e "$MCP_TUNNEL_DIR/config.json" ]] || fail 'legacy migration not committed'
  check "$MCP_TUNNEL_DIR/registry.json" '.keys.key_legacy.value == "sk-legacy" and (.projects | length) == 1'
)
pass 'legacy global credentials become a reusable pool with explicit project binding'

python3 - "$ROOT/opencode-vm.sh" "$ID" "$TMP" <<'PY'
import errno, hashlib, json, os, select, signal, sys, time
script, tunnel, root = sys.argv[1:]
os.environ["HOME"] = root + "/pty-home"
os.mkdir(os.environ["HOME"])
config = os.environ["HOME"] + "/.opencode-vm/mcp-tunnel/openai/registry.json"
captured = []
def wizard(command, directory, exchanges, expected=0):
    pid, fd = os.forkpty()
    if pid == 0:
        os.chdir(directory)
        os.execv("/bin/bash", ["bash", "-c", 'source "$1"; ' + command, "_", script])
    output = b""
    try:
        for prompt, answer in exchanges:
            deadline = time.monotonic() + 10
            while prompt not in output:
                if time.monotonic() > deadline: raise AssertionError("Missing wizard prompt: " + repr(prompt))
                ready, _, _ = select.select([fd], [], [], .1)
                if ready: output += os.read(fd, 65536)
            os.write(fd, answer)
        while True:
            ready, _, _ = select.select([fd], [], [], 10)
            if not ready: raise AssertionError("Wizard did not exit")
            try: chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
            if not chunk: break
            output += chunk
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == expected, output.decode()
        captured.append(output)
        return output
    finally:
        os.close(fd)
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
secret = b"sk-hidden-pty-fixture"
out = wizard("provider_cmd new", root + "/a", [(b"Choice [c/s/m]", b"m\n"), (b"New tunnel API key (Read + Use):", secret + b"\n"), (b"Tunnel ID:", tunnel.encode() + b"\n")])
assert secret not in out, "key echoed by wizard"
out = wizard("provider_cmd mcp new openai", root + "/b", [(b"Tunnel API key: choose", b"1\n"), (b"Tunnel: choose", b"1\n")])
assert b"New tunnel API key (Read + Use):" not in out
assert (root + "/a").encode() in out and b"wrong project" in out
value = json.load(open(config))
assert len(value["keys"]) == 1 and len(value["tunnels"]) == 1 and len(value["projects"]) == 2
before = open(config, "rb").read()
wizard("provider_cmd mcp new openai", root + "/b", [(b"Tunnel API key: choose", b"n\n"), (b"New tunnel API key (Read + Use):", b"sk-cancelled\n"), (b"Tunnel: choose", b"n\n"), (b"Tunnel ID:", b"\x03")], -signal.SIGINT)
assert open(config, "rb").read() == before, "cancelled setup left partial pool entries"

# Start at either the action menu or a partially specified command. Missing
# deletion targets must be chosen explicitly, including when cwd is configured.
out = wizard("provider_cmd mcp", root + "/a", [(b"MCP action", b"invalid\nlist\n")])
assert b"Please choose list" in out and b"OpenAI MCP project connections" in out
assert open(config, "rb").read() == before
out = wizard("provider_cmd mcp", root + "/a", [(b"MCP action", b"status\n"), (b"Select projects entry", b"2\n")])
assert ("project:       " + root + "/b").encode() in out
out = wizard("provider_cmd mcp", root + "/c", [(b"MCP action", b"add\n"), (b"Tunnel API key: choose", b"1\n"), (b"Tunnel: choose", b"1\n")])
key_id = next(iter(json.load(open(config))["keys"]))
out = wizard(f"provider_cmd mcp add --key-id {key_id} --tunnel-id {tunnel}", root + "/d", [])
assert b"MCP action" not in out and b"Saved project connection" in out
assert len(json.load(open(config))["projects"]) == 4

before = open(config, "rb").read()
for command, exchanges in [
    ("provider_cmd mcp", [(b"MCP action", b"q\n")]),
    ("provider_cmd mcp rm", [(b"Remove [", b"q\n")]),
    ("provider_cmd mcp rm openai", [(b"Remove [", b"1\n"), (b"Select projects entry", b"q\n")]),
    ("provider_cmd mcp rm", [(b"Remove [", b"3\n"), (b"Select tunnels entry", b"\x04")]),
    ("provider_cmd mcp add", [(b"Tunnel API key: choose", b"q\n")]),
]:
    wizard(command, root + "/a", exchanges)
    assert open(config, "rb").read() == before, "cancel/EOF changed registry"
out = wizard("provider_cmd mcp rm", root + "/a", [(b"Remove [", b"key\n"), (b"Select keys entry", b"1\n")], 1)
assert b"Still referenced by projects" in out and secret not in out
assert open(config, "rb").read() == before

out = wizard("provider_cmd mcp rm", root + "/a", [(b"Remove [", b"invalid\nproject\n"), (b"Select projects entry", b"2\n")])
value = json.load(open(config))
pid = lambda name: hashlib.md5(os.fsencode(root + "/" + name)).hexdigest()
assert pid("b") not in value["projects"] and pid("a") in value["projects"], "menu removed cwd instead of chosen project"
assert len(value["keys"]) == 1 and len(value["tunnels"]) == 1
for name in ("a", "c", "d"):
    out = wizard(f"provider_cmd mcp rm openai --project {pid(name)}", root + "/a", [])
    assert b"What would you like to remove" not in out, "complete command entered menu"

out = wizard("provider_cmd mcp rm", root + "/a", [(b"Remove [", b"2\n"), (b"Select keys entry", b"99\n1\n")])
assert b"Please enter a number" in out
value = json.load(open(config))
assert len(value["keys"]) == 0 and len(value["tunnels"]) == 1
out = wizard("provider_cmd mcp", root + "/a", [(b"MCP action", b"rm\n"), (b"Remove [", b"tunnel\n"), (b"Select tunnels entry", b"1\n")])
assert len(json.load(open(config))["tunnels"]) == 0
before = open(config, "rb").read()
out = wizard("provider_cmd mcp rm", root + "/a", [(b"Remove [", b"2\n")])
assert b"No registered keys to select" in out
assert open(config, "rb").read() == before
assert all(secret not in output for output in captured), "key leaked in menu output"
PY
pass 'interactive action/add/status/remove flows select exact entries, handle empty/invalid/cancel/EOF and hide keys'

mcp_host_port_available() { [[ "$1" != 40961 ]]; }
first="$(mcp_reserve_host_port "$TMP/a")"
second="$(mcp_reserve_host_port "$TMP/b")"
[[ "$first" == 40960 && "$second" == 40962 ]] || fail 'automatic port reservations collide'
[[ "$(mcp_reserve_host_port "$TMP/a" "$first")" == "$first" ]] || fail 'reconnect changed port'
pass 'independent project MCP ports remain collision-free'

OC_PORT=4096
SESS_SHARE="$(session_share_dir "$TMP/a")"
eval "$OCVM_WEB_LIB_SH"
curl() {
  local previous="" output="" arg
  for arg in "$@"; do
    [[ "$previous" != -o ]] || output="$arg"
    previous="$arg"
  done
  printf 'corrupted archive\n' > "$output"
}
if install_mcp_tunnel > "$TMP/install.log" 2>&1; then fail 'installer accepted corrupt bytes'; fi
pass 'guest installer rejects checksum mismatches'
unit_description=foreign unit_state=active
sudo() {
  case "$*" in
    'systemctl show '*) printf 'LoadState=loaded\nActiveState=%s\nDescription=%s\n' "$unit_state" "$unit_description" ;;
    'systemctl stop '*) unit_state=inactive; printf 'stop\n' >> "$TMP/unit.log" ;;
    *) fail 'unexpected service operation' ;;
  esac
}
if stop_mcp_tunnel > "$TMP/unit-error.log" 2>&1; then fail 'foreign service was treated as ours'; fi
[[ ! -e "$TMP/unit.log" ]] || fail 'foreign service stopped'
unit_description="$(mcp_tunnel_unit_description)"
printf '{}\n' > "$SESS_SHARE/mcp/tunnel.yaml"
printf 'fixture\n' > "$SESS_SHARE/mcp/tunnel-key"
curl() { printf '{}\n'; }
stop_mcp_tunnel
[[ ! -e "$SESS_SHARE/mcp/tunnel-key" ]] || fail 'own service did not clean credentials'
pass 'guest lifecycle still stops only its own service and removes its credential copy'
printf 'All project MCP registry tests passed.\n'
