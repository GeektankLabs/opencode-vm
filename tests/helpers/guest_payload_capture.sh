#!/usr/bin/env bash
# Preserve real lifecycle entries and vm_exec; all VM side effects stop at
# the transport. Only fixture directories are used by the host entry.
set -euo pipefail
export OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1 OCVM_AUTH_AUTORESYNC=0
source "$SOURCE/opencode-vm.sh"
for fn in $(declare -F | cut -d' ' -f3); do
  case "$fn" in attach_session|start_session|vm_exec) ;; *) eval "$fn() { return 0; }" ;; esac
done
session_env() { printf '%s/session.env' "$HOME"; }
session_share_dir() { printf '%s/share' "$HOME"; }
project_state_dir() { printf '%s/state' "$HOME"; }
pick_host_cfg() { printf '%s/config.json' "$HOME"; }
pick_project_cfg() { printf '%s/config.json' "$HOME"; }
project_cfg_path() { printf '%s/config.json' "$HOME"; }
mcp_session_mode() { printf '%s' "$TEST_MODE"; }
session_journal_enabled() { printf 0; }
session_journal_effective() { printf 0; }
web_editor_enabled() { printf 0; }
get_host_ip() { printf 127.0.0.1; }
vm_resolve_home() { printf '%s/guest' "$HOME"; }
managed_scope_env_normalize() { printf ''; }
_attach_legacy_choice_required() { return 1; }
ecc_enabled() { return 1; }
_cleanup_controller_is_current() { return 1; }
_decide_cleanup_action() { printf keep; }
is_mcrepo_workspace() { return 1; }
auth_sync_begin() { printf '{}\n' > "$3"; }
select_web_guest_base() { printf 4096; }
rsync() { :; }
ln() { :; }
md5() { printf fixturehash; }
stat() { command stat "$@"; }
limactl() {
  if [[ "$1" == shell && "${7:-}" == bash && "${8:-}" == -lc && "${9:-}" == *'exec 9>/tmp/ocvm-runtime.lock'* ]]; then
    printf '%s' "$9" > "$HOME/final-payload.sh"
    shift 9
    printf '%s\0' "$@" > "$HOME/final-arguments.bin"
    bash -n "$HOME/final-payload.sh"
  fi
  return 0
}
AUTH_SYNC_DIR="$HOME/auth"
SESSION_MODE="$TEST_MODE"
SESSION_MCP_MODE=disable
SESSION_EDITOR_MODE=disable
SESSION_HUB_MODE=disable
SESSION_TASKBOARD_MODE=disable
SESSION_JOURNAL_MODE=disable
if [[ "$TEST_ENTRY" == attach ]]; then attach_session; else start_session; fi
