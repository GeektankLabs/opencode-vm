#!/usr/bin/env bash
# Test globals are consumed by sourced production functions.
# shellcheck disable=SC2034
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="${OCVM_CONFIG_TEST_TMP:-$(mktemp -d)}"
if [[ -z "${OCVM_CONFIG_TEST_TMP:-}" ]]; then trap 'rm -rf "$TMP"' EXIT; fi
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME" "$TMP/a" "$TMP/b" "$TMP/vms"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"
# Production project hashing uses macOS md5; emulate it on Linux.
if ! command -v md5 >/dev/null 2>&1; then
  md5() { md5sum | cut -d ' ' -f 1; }
fi
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
assert_has() { [[ "$1" == *"$2"* ]] || fail "missing '$2' in: $1"; }
assert_order() {
  local text="$1" item
  shift
  for item in "$@"; do
    [[ "$text" == *"$item"* ]] || fail "event '$item' missing or out of order: $text"
    text="${text#*"$item"}"
  done
}

# Fake Lima: per-instance byte fields and a mutation log. The --disk path is
# deliberately stateful so a second stopped resume must be a no-op.
limactl() {
  local op="$1" vm="${2:-}" field="${4:-}" arg
  shift
  case "$op" in
    list)
      if [[ "${1:-}" == -q ]]; then
        [[ ! -e "$TMP/list-error" ]] || return 1
        for arg in "$TMP"/vms/*; do [[ -f "$arg" ]] && basename "$arg"; done
        return 0
      fi
      [[ -f "$TMP/vms/$vm" ]] || return 1
      if [[ "$field" == '{{.Name}} {{.Status}}' ]]; then
        if [[ -f "$TMP/running" && "$(<"$TMP/running")" == "$vm" ]]; then
          printf '%s Running\n' "$vm"
        else
          printf '%s Stopped\n' "$vm"
        fi
        return 0
      fi
      # shellcheck disable=SC1090
      source "$TMP/vms/$vm"
      case "$field" in
        '{{.Disk}}') printf '%s\n' "$disk" ;;
        '{{.Memory}}') printf '%s\n' "$mem" ;;
        '{{.CPUs}}') printf '%s\n' "$cpus" ;;
      esac
      ;;
    edit)
      printf '%s\n' "$*" >> "$TMP/edits"
      printf 'edit:%s\n' "$*" >> "$TMP/events"
      [[ "${OCVM_CONFIG_TEST_SCENARIO:-}" != readback-failure ]] || return 1
      vm="$1"; shift
      # shellcheck disable=SC1090
      source "$TMP/vms/$vm"
      while (( $# )); do
        case "$1" in
          --disk) disk=$(( $2 * 1073741824 )); shift 2 ;;
          --memory) mem=$(( $2 * 1073741824 )); shift 2 ;;
          --cpus) cpus="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      printf 'disk=%s\nmem=%s\ncpus=%s\n' "$disk" "$mem" "$cpus" > "$TMP/vms/$vm"
      ;;
    clone) printf '%s\n' "$*" >> "$TMP/clones" ;;
    stop)
      printf 'stop:%s\n' "$*" >> "$TMP/events"
      [[ "${OCVM_CONFIG_TEST_SCENARIO:-}" != stop-failure ]] || return 1
      [[ "${OCVM_CONFIG_TEST_SCENARIO:-}" != stop-unverified ]] || return 0
      [[ ! -f "$TMP/running" || "$(<"$TMP/running")" != "$1" ]] || rm -f "$TMP/running"
      ;;
    start)
      printf '%s\n' "$*" >> "$TMP/starts"
      printf 'start:%s\n' "$*" >> "$TMP/events"
      if [[ -n "${OCVM_CONFIG_TEST_SCENARIO:-}" ]]; then printf '%s\n' "$1" > "$TMP/running"; fi
      ;;
    *) fail "unexpected Lima call $op $*" ;;
  esac
}
need() { :; }
_host_mem_gib() { echo 64; }
_host_cpus() { echo 16; }
is_vm_running() { [[ -f "$TMP/running" && "$(<"$TMP/running")" == "$1" ]]; }
printf 'disk=%s\nmem=%s\ncpus=%s\n' "$(( 100 * 1073741824 ))" "$(( 8 * 1073741824 ))" 6 > "$TMP/vms/$BASE_NAME"
printf 'disk=%s\nmem=%s\ncpus=%s\n' "$(( 120 * 1073741824 ))" "$(( 8 * 1073741824 ))" 6 > "$TMP/vms/kept"
SESSION_A="$TMP/a"
SESSION_B="$TMP/b"
mkdir -p "$(dirname "$(session_env "$SESSION_A")")"
write_senv "$(session_env "$SESSION_A")" kept "$SESSION_A" fixture tui 4096 0 0 auth-old controller-old 0 "" 0 0
if [[ "${OCVM_CONFIG_INTERACTIVE:-0}" == 1 && -z "${OCVM_CONFIG_TEST_SCENARIO:-}" ]]; then
  cd "$SESSION_B"
  config_cmd
  config_cmd disk
  exit 0
fi
unset OCVM_CONFIG_INTERACTIVE

if [[ -n "${OCVM_CONFIG_TEST_SCENARIO:-}" ]]; then
  scenario="$OCVM_CONFIG_TEST_SCENARIO"
  cd "$SESSION_A"
  rm -f "$TMP/events" "$TMP/edits" "$TMP/starts" "$TMP/stops" "$TMP/clones" "$TMP/running"
  if [[ "$scenario" == approval-tui ]]; then
    write_senv "$(session_env "$SESSION_A")" kept "$SESSION_A" fixture tui 4096 0 0 auth-old controller-old 0 "" 0 0
  else
    write_senv "$(session_env "$SESSION_A")" kept "$SESSION_A" fixture web 8080 1 1 auth-old controller-old 0 "" 1 0
  fi
  printf 'kept\n' > "$TMP/running"
  vmcfg_load "$SESSION_A"
  if [[ "$scenario" == approval ]]; then
    VM_MEMORY_GIB=4
    VM_CPUS=4
    vmcfg_save "$SESSION_A"
  fi

  lifecycle_finalize_runtime() {
    [[ -L "$LIFECYCLE_LOCK_LINK" ]] || fail 'runtime finalized without project lock'
    unset SESS_NAME SESS_PROJ SESS_CONTROLLER SESS_AUTH_GENERATION
    # shellcheck disable=SC1090
    source "$(session_env "$SESSION_A")"
    [[ "$SESS_CONTROLLER" == kept-disk-resize-* ]] || fail 'runtime finalized before retained-controller takeover'
    [[ "$SESS_AUTH_GENERATION" == auth-old ]] || fail 'takeover changed trusted auth generation'
    printf 'finalize:%s:%s\n' "$1" "$2" >> "$TMP/events"
    [[ "$scenario" != finalize-failure ]]
  }
  stop_web_tunnels() {
    [[ -L "$LIFECYCLE_LOCK_LINK" ]] || fail 'web forward stopped without project lock'
    printf 'tunnel:%s:%s\n' "$1" "$2" >> "$TMP/events"
  }
  if [[ "$scenario" == lock-failure ]]; then
    lifecycle_lock_acquire() { return 1; }
  fi
  attach_session() {
    [[ -z "$LIFECYCLE_LOCK_LINK" && -z "$LIFECYCLE_LOCK_CLAIM" ]] || fail 'managed attach recursively held lifecycle lock'
    unset SESS_NAME SESS_PROJ SESS_CONTROLLER SESS_AUTH_GENERATION
    # shellcheck disable=SC1090
    source "$(session_env "$SESSION_A")"
    if [[ "$scenario" != approval-tui ]]; then
      [[ "$SESS_MODE" == web && "$SESS_TLS" == 1 && "$SESS_EDITOR_ENABLED" == 1 ]] || fail 'retained web settings changed'
    else
      [[ "$SESS_MODE" == tui && "$SESS_TLS" == 0 && "$SESS_EDITOR_ENABLED" == 0 ]] || fail 'retained terminal settings changed'
    fi
    write_senv "$(session_env "$SESSION_A")" "$SESS_NAME" "$SESS_PROJ" "$CFG_HASH_AT_START" \
      "$SESS_MODE" "$SESS_PORT" "$SESS_KEEP_HISTORY" "$SESS_TLS" "$SESS_AUTH_GENERATION" kept-attach-test \
      "$SESS_MCP_ENABLED" "$SESS_MCP_PORT" "$SESS_EDITOR_ENABLED" "$SESS_EDITOR_DISABLED"
    printf 'attach:%s\n' "$SESS_NAME" >> "$TMP/events"
    [[ "$scenario" != attach-failure ]] || return 1
    limactl start "$SESS_NAME" --tty=false
  }
  # shellcheck disable=SC2317
  read() {
    case "$scenario:$*" in
      stale-controller:*"Stop, grow to"*)
        unset SESS_NAME SESS_PROJ SESS_CONTROLLER SESS_AUTH_GENERATION
        # shellcheck disable=SC1090
        source "$(session_env "$SESSION_A")"
        write_senv "$(session_env "$SESSION_A")" "$SESS_NAME" "$SESS_PROJ" "${CFG_HASH_AT_START:-}" \
          "$SESS_MODE" "$SESS_PORT" "$SESS_KEEP_HISTORY" "$SESS_TLS" "$SESS_AUTH_GENERATION" changed-controller \
          "$SESS_MCP_ENABLED" "$SESS_MCP_PORT" "$SESS_EDITOR_ENABLED" "$SESS_EDITOR_DISABLED"
        ;;
      stale-target:*"Stop, grow to"*)
        vmcfg_load "$SESSION_A"
        VM_DISK_GIB=160
        vmcfg_save "$SESSION_A"
        ;;
      stale-state:*"Stop, grow to"*) rm -f "$TMP/running" ;;
    esac
    # shellcheck disable=SC2162
    builtin read "$@"
  }

  if [[ "$scenario" == noninteractive ]]; then
    if config_cmd disk 150 > "$TMP/out" 2>&1; then :; else fail 'non-interactive disk setting failed'; fi
    assert_has "$(<"$TMP/out")" 'No interactive terminal; not stopping automatically'
    [[ "$(<"$(project_vm_env "$SESSION_A")")" == *'VM_DISK_GIB="150"'* ]] || fail 'non-interactive target was not saved'
    [[ ! -e "$TMP/events" && ! -e "$TMP/edits" && ! -e "$TMP/starts" ]] || fail 'non-interactive path mutated VM lifecycle'
    pass 'non-interactive growth stays pending without stop or restart'
    exit 0
  fi

  case "$scenario" in
    decline)
      config_cmd disk 150 > "$TMP/out" 2>&1 || fail 'declined disk setting failed'
      assert_has "$(<"$TMP/out")" 'Not stopping the VM'
      [[ "$(<"$(project_vm_env "$SESSION_A")")" == *'VM_DISK_GIB="150"'* ]] || fail 'declined target was not saved'
      [[ ! -e "$TMP/events" && ! -e "$TMP/edits" && ! -e "$TMP/starts" ]] || fail 'decline mutated VM lifecycle'
      pass 'declined running-VM offer saves a pending target without stopping'
      ;;
    approval|approval-tui)
      config_cmd disk 150 > "$TMP/out" 2>&1 || fail 'approved disk setting failed'
      if [[ "$scenario" == approval ]]; then
        assert_has "$(<"$TMP/out")" 'pending RAM/CPU changes: RAM 8 -> 4 GiB, CPU 6 -> 4'
        assert_has "$(<"$TMP/edits")" '--disk 150 --memory 4 --cpus 4'
      else
        assert_has "$(<"$TMP/edits")" '--disk 150'
      fi
      [[ "$(_vm_instance_disk_gib kept)" == 150 ]] || fail 'approved resize did not reach requested disk'
      [[ "$(<"$TMP/running")" == kept ]] || fail 'managed attach did not resume the retained VM'
      # shellcheck disable=SC1090
      source "$(session_env "$SESSION_A")"
      [[ "$SESS_AUTH_GENERATION" == auth-old && "$SESS_CONTROLLER" == kept-attach-* ]] || fail 'managed attach did not preserve and supersede tracker state'
      events="$(<"$TMP/events")"
      assert_order "$events" 'finalize:kept:auth-old' 'stop:kept' 'edit:kept' 'attach:kept' 'start:kept --tty=false'
      if [[ "$scenario" == approval ]]; then
        assert_has "$events" 'tunnel:kept:8080'
      else
        [[ "$events" != *'tunnel:'* ]] || fail 'terminal-mode resize stopped web forwards'
      fi
      [[ "$events" != *'stop:oc-base'* && "$events" != *'stop:project-b'* ]] || fail 'approved flow stopped another VM'
      [[ ! -e "$TMP/clones" ]] || fail 'approved flow recreated a VM'
      pass "$scenario finalizes before stop, verifies resize, and managed-attaches with saved mode"
      ;;
    stale-controller|stale-target)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'stale consent state was accepted'; fi
      assert_has "$(<"$TMP/out")" 'changed after consent'
      [[ "$(<"$TMP/running")" == kept ]] || fail 'stale consent stopped VM'
      [[ ! -e "$TMP/events" && ! -e "$TMP/edits" && ! -e "$TMP/starts" ]] || fail 'stale consent mutated lifecycle'
      pass "$scenario revalidation prevents stop, resize and restart"
      ;;
    stale-state)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'changed running state was accepted'; fi
      assert_has "$(<"$TMP/out")" 'no longer confirmed running'
      [[ ! -e "$TMP/running" && ! -e "$TMP/events" && ! -e "$TMP/edits" ]] || fail 'changed VM state proceeded to lifecycle mutation'
      pass 'VM state change during consent prevents stop and resize'
      ;;
    lock-failure)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'lock failure was accepted'; fi
      assert_has "$(<"$TMP/out")" 'Could not acquire lifecycle ownership'
      [[ "$(<"$TMP/running")" == kept ]] || fail 'lock failure stopped VM'
      [[ ! -e "$TMP/events" && ! -e "$TMP/edits" ]] || fail 'lock failure proceeded to lifecycle mutation'
      pass 'lifecycle lock contention fails closed before stop'
      ;;
    finalize-failure)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'failed finalization was accepted'; fi
      assert_has "$(<"$TMP/out")" 'finalization failed'
      [[ "$(<"$TMP/running")" == kept ]] || fail 'finalization failure stopped VM'
      [[ "$(<"$TMP/events")" == 'finalize:kept:auth-old' ]] || fail 'finalization failure proceeded to stop or resize'
      # shellcheck disable=SC1090
      source "$(session_env "$SESSION_A")"
      [[ "$SESS_CONTROLLER" == kept-disk-resize-* ]] || fail 'failed takeover evidence was rolled back'
      pass 'finalization failure preserves the running VM and retained-controller recovery evidence'
      ;;
    stop-failure)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'failed stop was accepted'; fi
      assert_has "$(<"$TMP/out")" 'stop failed or is uncertain'
      [[ "$(<"$TMP/running")" == kept ]] || fail 'failed stop unexpectedly changed VM state'
      [[ "$(<"$TMP/events")" != *'edit:'* && "$(<"$TMP/events")" != *'attach:'* ]] || fail 'failed stop proceeded to resize or resume'
      pass 'uncertain stop fails closed without resizing or restarting'
      ;;
    stop-unverified)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'unverified stopped state was accepted'; fi
      assert_has "$(<"$TMP/out")" 'stop could not be verified'
      [[ "$(<"$TMP/running")" == kept ]] || fail 'unverified stop changed VM state'
      [[ "$(<"$TMP/events")" != *'edit:'* && "$(<"$TMP/events")" != *'start:'* ]] || fail 'unverified stop proceeded to resize or restart'
      pass 'unverified stop state prevents resize and restart'
      ;;
    readback-failure)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'unverified resize was accepted'; fi
      assert_has "$(<"$TMP/out")" 'Could not verify disk growth'
      [[ ! -e "$TMP/running" ]] || fail 'readback failure unexpectedly restarted VM'
      [[ "$(<"$TMP/events")" != *'attach:'* && "$(<"$TMP/events")" != *'start:'* ]] || fail 'readback failure proceeded to resume'
      [[ ! -e "$TMP/clones" ]] || fail 'readback failure recreated VM'
      pass 'disk readback failure retains the stopped VM without managed resume'
      ;;
    attach-failure)
      if config_cmd disk 150 > "$TMP/out" 2>&1; then fail 'failed managed attach was accepted'; fi
      assert_has "$(<"$TMP/out")" 'Disk growth is verified, but the session did not resume'
      [[ "$(_vm_instance_disk_gib kept)" == 150 ]] || fail 'disk success was lost after attach failure'
      [[ ! -e "$TMP/running" && "$(<"$TMP/events")" == *'attach:kept'* ]] || fail 'attach failure state was not retained'
      [[ "$(<"$TMP/events")" != *'start:'* ]] || fail 'failed attach started the VM'
      pass 'managed attach failure reports verified disk growth and leaves recovery state'
      ;;
    *) fail "unknown test scenario $scenario" ;;
  esac
  exit 0
fi

cd "$SESSION_A"
out="$(config_cmd show)"
assert_has "$out" 'Disk'
assert_has "$out" '120 GiB disk'
if config_cmd disk 119 > "$TMP/out" 2>&1; then fail 'stopped disk shrink accepted'; fi
[[ ! -e "$(project_vm_env "$SESSION_A")" && ! -e "$TMP/edits" ]] || fail 'shrink mutated state'
pass 'stopped shrink fails before saving or editing'

printf 'kept\n' > "$TMP/running"
if config_cmd disk 110 > "$TMP/out" 2>&1; then fail 'running disk shrink accepted'; fi
[[ ! -e "$(project_vm_env "$SESSION_A")" ]] || fail 'running shrink persisted'
config_cmd disk 120 > "$TMP/out"
[[ ! -e "$TMP/edits" ]] || fail 'equal disk changed Lima'
config_cmd disk 150 > "$TMP/out"
assert_has "$(config_cmd show)" 'Disk pending: 120 -> 150 GiB'
assert_has "$(<"$TMP/out")" 'No interactive terminal; not stopping automatically'
assert_has "$(<"$TMP/out")" 'Lima cannot grow the disk while session VM'
[[ ! -e "$TMP/edits" ]] || fail 'running disk changed Lima'
[[ "$(<"$TMP/running")" == kept ]] || fail 'non-interactive config stopped the VM'
pass 'running shrink precheck, equal value, pending grow'

rm "$TMP/running"
vmcfg_load "$SESSION_A"
_apply_vm_sizing_to_stopped kept > "$TMP/out"
assert_has "$(<"$TMP/edits")" '--disk 150'
[[ "$(_vm_instance_disk_gib kept)" == 150 ]] || fail 'disk did not grow'
_apply_vm_sizing_to_stopped kept > /dev/null
[[ "$(wc -l < "$TMP/edits")" -eq 1 ]] || fail 'repeat grow was not a no-op'
limactl start kept --tty=false
assert_has "$(<"$TMP/starts")" 'kept --tty=false'
pass 'stopped resize, idempotent reapply and ordinary start'

config_cmd disk default > "$TMP/out"
assert_has "$(<"$TMP/out")" 'never shrunk'
vmcfg_load "$SESSION_A"
[[ -z "$VM_DISK_GIB" ]] || fail 'default retained disk override'
_apply_vm_sizing_to_stopped kept > /dev/null
[[ "$(_vm_instance_disk_gib kept)" == 150 ]] || fail 'default shrank VM'
config_cmd ram 4 > /dev/null
config_cmd cpu 2 > /dev/null
vmcfg_load "$SESSION_A"
[[ "$VM_MEMORY_GIB" == 4 && "$VM_CPUS" == 2 ]] || fail 'direct RAM/CPU setting lost'
_apply_vm_sizing_to_stopped kept > /dev/null
assert_has "$(<"$TMP/edits")" '--memory 4 --cpus 2'
ram_cmd 8 > /dev/null
cpu_cmd 1 > /dev/null
vmcfg_load "$SESSION_A"
[[ "$VM_MEMORY_GIB" == 8 && "$VM_CPUS" == 1 ]] || fail 'legacy RAM/CPU commands lost'
_apply_vm_sizing_to_stopped kept > /dev/null
assert_has "$(<"$TMP/edits")" '--memory 8 --cpus 1'
config_cmd ram default > /dev/null
config_cmd cpu default > /dev/null
[[ ! -f "$(project_vm_env "$SESSION_A")" ]] || fail 'default left residue'
pass 'disk default never shrinks, RAM/CPU direct and legacy commands persist independently'

cd "$SESSION_B"
if config_cmd disk 50 > "$TMP/out" 2>&1; then fail 'clone smaller than base accepted'; fi
assert_has "$(<"$TMP/out")" 'base VM disk is 100 GiB'
config_cmd disk 180 > /dev/null
vmcfg_load "$SESSION_B"
[[ "$VM_DISK_GIB" == 180 ]] || fail 'project B override lost'
clone_args=( --mount-only "$SESSION_B:w" )
vmcfg_add_clone_overrides > "$TMP/out"
limactl clone "$BASE_NAME" project-b "${clone_args[@]}" --tty=false --start
assert_has "$(<"$TMP/clones")" '--disk 180'
assert_has "$(<"$TMP/clones")" '--mount-only'
vmcfg_load "$SESSION_A"
[[ -z "$VM_DISK_GIB" ]] || fail 'project A inherited B override'
pass 'project isolation, persistence and clone disk override'

printf 'SESS_NAME=kept\n' > "$(session_env "$SESSION_B")"
printf 'disk=invalid\nmem=%s\ncpus=6\n' "$(( 8 * 1073741824 ))" > "$TMP/vms/kept"
if config_cmd disk 200 > "$TMP/out" 2>&1; then fail 'unreadable disk accepted'; fi
assert_has "$(<"$TMP/out")" 'Cannot read'
vmcfg_load "$SESSION_B"
[[ "$VM_DISK_GIB" == 180 ]] || fail 'unreadable disk changed config'
touch "$TMP/list-error"
if config_cmd disk 200 > "$TMP/out" 2>&1; then fail 'failed Lima list accepted'; fi
assert_has "$(<"$TMP/out")" 'Cannot list Lima VMs'
rm "$TMP/list-error"
pass 'unknown existing disk fails closed'
rm "$(session_env "$SESSION_B")"

if config_cmd disk 150 extra > "$TMP/out" 2>&1; then fail 'extra arguments accepted'; fi
if config_cmd disk > "$TMP/out" 2>&1; then fail 'incomplete non-interactive command accepted'; fi
pass 'complete commands are scriptable, incomplete commands require a terminal'

command -v script >/dev/null || fail 'script utility required for PTY menu test'
export OCVM_CONFIG_TEST_TMP="$TMP" OCVM_CONFIG_INTERACTIVE=1
if [[ "$(uname -s)" == Linux ]]; then
  out="$(printf '3\n170\n160\n' | script -q -e -c "bash '$ROOT/tests/vm_config_test.sh'" /dev/null)" || fail "interactive command failed: $out"
  assert_has "$out" 'Choose a resource'
  assert_has "$out" 'New disk value'
  assert_has "$out" 'Disk growth requires a stopped VM'
  vmcfg_load "$SESSION_B"
  [[ "$VM_DISK_GIB" == 160 ]] || fail 'interactive values not persisted'
  pass 'bare config and bare config disk complete interactively'
fi

run_tty_case() {
  local scenario="$1" input="$2" output
  output="$(printf '%s\n' "$input" | script -q -e -c "OCVM_CONFIG_TEST_SCENARIO=$scenario bash '$ROOT/tests/vm_config_test.sh'" /dev/null)" \
    || fail "$scenario PTY scenario failed: $output"
  assert_has "$output" 'ok - '
}

run_tty_case decline n
run_tty_case approval y
run_tty_case approval-tui Y
run_tty_case stale-controller y
run_tty_case stale-target y
run_tty_case stale-state y
run_tty_case lock-failure y
run_tty_case finalize-failure y
run_tty_case stop-failure y
run_tty_case stop-unverified y
run_tty_case readback-failure y
run_tty_case attach-failure y
OCVM_CONFIG_TEST_SCENARIO=noninteractive bash "$ROOT/tests/vm_config_test.sh" > "$TMP/noninteractive.log" 2>&1 \
  || fail "non-interactive scenario failed: $(<"$TMP/noninteractive.log")"
assert_has "$(<"$TMP/noninteractive.log")" 'ok - non-interactive growth stays pending'
pass 'running-VM disk consent, retained lifecycle and failure paths'
