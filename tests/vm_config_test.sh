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
    start) printf '%s\n' "$*" >> "$TMP/starts" ;;
    *) fail "unexpected Lima call $op $*" ;;
  esac
}
need() { :; }
_host_mem_gib() { echo 64; }
_host_cpus() { echo 16; }
is_vm_running() { [[ -f "$TMP/running" ]]; }
printf 'disk=%s\nmem=%s\ncpus=%s\n' "$(( 100 * 1073741824 ))" "$(( 8 * 1073741824 ))" 6 > "$TMP/vms/$BASE_NAME"
printf 'disk=%s\nmem=%s\ncpus=%s\n' "$(( 120 * 1073741824 ))" "$(( 8 * 1073741824 ))" 6 > "$TMP/vms/kept"
SESSION_A="$TMP/a"
SESSION_B="$TMP/b"
mkdir -p "$(dirname "$(session_env "$SESSION_A")")"
printf 'SESS_NAME=kept\n' > "$(session_env "$SESSION_A")"
if [[ "${OCVM_CONFIG_INTERACTIVE:-0}" == 1 ]]; then
  cd "$SESSION_B"
  config_cmd
  config_cmd disk
  exit 0
fi

cd "$SESSION_A"
out="$(config_cmd show)"
assert_has "$out" 'Disk'
assert_has "$out" '120 GiB disk'
if config_cmd disk 119 > "$TMP/out" 2>&1; then fail 'stopped disk shrink accepted'; fi
[[ ! -e "$(project_vm_env "$SESSION_A")" && ! -e "$TMP/edits" ]] || fail 'shrink mutated state'
pass 'stopped shrink fails before saving or editing'

touch "$TMP/running"
if config_cmd disk 110 > "$TMP/out" 2>&1; then fail 'running disk shrink accepted'; fi
[[ ! -e "$(project_vm_env "$SESSION_A")" ]] || fail 'running shrink persisted'
config_cmd disk 120 > "$TMP/out"
[[ ! -e "$TMP/edits" ]] || fail 'equal disk changed Lima'
config_cmd disk 150 > "$TMP/out"
assert_has "$(config_cmd show)" 'Disk pending: 120 -> 150 GiB'
assert_has "$(<"$TMP/out")" 'running'
[[ ! -e "$TMP/edits" ]] || fail 'running disk changed Lima'
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
  assert_has "$out" 'Disk grows on the next stopped-VM start'
  vmcfg_load "$SESSION_B"
  [[ "$VM_DISK_GIB" == 160 ]] || fail 'interactive values not persisted'
  pass 'bare config and bare config disk complete interactively'
fi
