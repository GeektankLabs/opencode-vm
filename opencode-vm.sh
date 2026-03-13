#!/usr/bin/env bash
set -euo pipefail

# Timing instrumentation for performance debugging
_T0=$(date +%s)
_ts() { echo "+$(($(date +%s) - _T0))s"; }

BASE_NAME="oc-base"
TEMPLATE="template:docker-rootful"

# Host config: OpenCode empfiehlt ~/.config/opencode/opencode.json
HOST_CFG_DIR="$HOME/.config/opencode"
HOST_CFG_JSON="$HOST_CFG_DIR/opencode.json"
HOST_CFG_JSONC="$HOST_CFG_DIR/opencode.jsonc"
HOST_CFG_DOT_JSON="$HOST_CFG_DIR/.opencode.json"
HOST_DATA_DIR="$HOME/.local/share/opencode"
HOST_STATE_DIR="$HOME/.local/state/opencode"

# Share root and session tracking
SHARE_ROOT="$HOME/.opencode-vm"
BACKUP_DIR="$SHARE_ROOT/backups"
SESSIONS_DIR="$SHARE_ROOT/sessions"
PROJECT_STATE_DIR="$SHARE_ROOT/project-state"

# Policy persistiert am Host (wird pro Session in der VM angewendet)
POLICY_ENV="$SHARE_ROOT/policy.env"

# Excludes for xdg-data rsync: bin/ (375M, 28k files — downloaded on demand),
# log/ (old session logs), tool-output/ (previous session artifacts)
DATA_RSYNC_EXCLUDES=(--exclude='bin/' --exclude='log/' --exclude='tool-output/')

# Defaults
DEFAULT_HOST_TCP_PORTS="1234 11434"   # LM Studio + Ollama
DEFAULT_LAN_ALLOW_TCP=""              # z.B. "192.168.178.10:443 10.0.0.5:22"
DEFAULT_LAN_ALLOW_UDP=""              # z.B. "192.168.178.20:53"
DEFAULT_OC_PORT=4096                  # OpenCode web/API server port

# Self-update metadata
SCRIPT_NAME="opencode-vm.sh"
OCVM_VERSION="0.1.4"
OCVM_UPDATE_REPO="GeektankLabs/opencode-vm"
OCVM_UPDATE_BRANCH="main"
OCVM_UPDATE_SCRIPT_PATH="opencode-vm.sh"

cmd="${1:-help}"
shift || true

# Session mode variables (set by web command handler before start_session)
SESSION_MODE="tui"
SESSION_PORT=""
SESSION_PASSWORD=""
OC_WEB_TUI=false

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing dependency: $1" >&2
    exit 1
  }
}

run_with_spinner() {
  local message="$1"
  shift

  local tmp_out
  tmp_out="$(mktemp)"

  "$@" >"$tmp_out" 2>&1 &
  local cmd_pid=$!

  local spin='|/-\\'
  local i=0

  while kill -0 "$cmd_pid" 2>/dev/null; do
    printf "\r%s %s" "$message" "${spin:i++%4:1}"
    sleep 0.1
  done

  local status=0
  set +e
  wait "$cmd_pid"
  status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    printf "\r%s done $(_ts)\n" "$message"
    rm -f "$tmp_out"
    return 0
  fi

  printf "\r%s failed $(_ts)\n" "$message" >&2
  cat "$tmp_out" >&2
  rm -f "$tmp_out"
  return "$status"
}

check_port_available() {
  local port="$1"
  if lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use on the host." >&2
    echo "Use --port <PORT> to specify a different port." >&2
    exit 1
  fi
}

parse_web_flags() {
  SESSION_PORT="$DEFAULT_OC_PORT"
  SESSION_PASSWORD=""
  OC_WEB_TUI=false
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --port)   shift; SESSION_PORT="${1:?Missing port value}" ;;
      --port=*) SESSION_PORT="${1#*=}" ;;
      --password)   shift; SESSION_PASSWORD="${1:?Missing password value}" ;;
      --password=*) SESSION_PASSWORD="${1#*=}" ;;
      --tui) OC_WEB_TUI=true ;;
      *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
  done
}

get_host_ip() {
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(route get default 2>/dev/null | awk '/interface:/{print $2}' | head -1 | xargs ipconfig getifaddr 2>/dev/null || true)"
  fi
  echo "${ip:-localhost}"
}

ensure_dirs() {
  mkdir -p "$HOST_CFG_DIR" "$BACKUP_DIR" "$SESSIONS_DIR" "$PROJECT_STATE_DIR"
}

proj_hash() {
  echo -n "$1" | md5 -q
}

session_env() {
  echo "$SESSIONS_DIR/$(proj_hash "$1").env"
}

session_share_dir() {
  echo "$SESSIONS_DIR/$(proj_hash "$1")"
}

project_state_dir() {
  echo "$PROJECT_STATE_DIR/$(proj_hash "$1")"
}

is_vm_running() {
  local vm_name="$1"
  limactl list -q --status Running 2>/dev/null | grep -qx "$vm_name"
}

ensure_host_opencode_dirs() {
  mkdir -p "$HOST_CFG_DIR" "$HOST_DATA_DIR" "$HOST_STATE_DIR"
}

sync_cfg_between_host_and_project() {
  local host_cfg="$1"
  local proj_cfg="$2"

  mkdir -p "$(dirname "$proj_cfg")"

  if [[ -f "$proj_cfg" ]] && [[ -f "$host_cfg" ]]; then
    if ! cmp -s "$proj_cfg" "$host_cfg"; then
      local host_mtime proj_mtime
      host_mtime="$(stat -f %m "$host_cfg" 2>/dev/null || echo 0)"
      proj_mtime="$(stat -f %m "$proj_cfg" 2>/dev/null || echo 0)"
      if (( host_mtime >= proj_mtime )); then
        cp -p "$host_cfg" "$proj_cfg"
      else
        cp -p "$proj_cfg" "$host_cfg"
      fi
    fi
  elif [[ -f "$host_cfg" ]]; then
    cp -p "$host_cfg" "$proj_cfg"
  elif [[ -f "$proj_cfg" ]]; then
    cp -p "$proj_cfg" "$host_cfg"
  fi
}

sync_data_dirs_bidirectional() {
  local left="$1"
  local right="$2"
  shift 2

  mkdir -p "$left" "$right"
  rsync -a --update "$@" "$left/" "$right/"
  rsync -a --update "$@" "$right/" "$left/"
}

find_sqlite_files() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  # Single grep process via xargs — no per-file subprocess, no null-byte issues
  find "$dir" -type f -print0 2>/dev/null | xargs -0 grep -l "SQLite format 3" 2>/dev/null || true
}

check_sqlite_integrity() {
  local dir="$1"
  local backup_dir="${2:-}"
  [[ -d "$dir" ]] || return 0

  while IFS= read -r db; do
    [[ -f "$db" ]] || continue
    local result
    result="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>/dev/null || echo 'error')"
    if [[ "$result" != "ok" ]]; then
      echo "[sqlite] Corrupt database detected: $db"
      # Attempt recovery via .dump
      local recovered="${db}.recovered"
      if sqlite3 "$db" '.dump' 2>/dev/null | sqlite3 "$recovered" 2>/dev/null; then
        mv -f "$recovered" "$db"
        echo "[sqlite] Recovered via dump: $db"
      else
        rm -f "$recovered"
        # Try restoring from backup
        local rel="${db#"$dir"/}"
        if [[ -n "$backup_dir" ]] && [[ -f "$backup_dir/$rel" ]]; then
          cp -p "$backup_dir/$rel" "$db"
          rm -f "${db}-wal" "${db}-shm" "${db}-journal"
          echo "[sqlite] Restored from backup: $db"
        else
          echo "[sqlite] No backup available — removing: $db"
          rm -f "$db" "${db}-wal" "${db}-shm" "${db}-journal"
        fi
      fi
    fi
  done < <(find_sqlite_files "$dir")

  return 0
}

backup_sqlite_dbs() {
  local src_dir="$1"
  local backup_dir="$2"
  [[ -d "$src_dir" ]] || return 0

  while IFS= read -r db; do
    [[ -f "$db" ]] || continue
    local rel="${db#"$src_dir"/}"
    mkdir -p "$backup_dir/$(dirname "$rel")"
    cp -p "$db" "$backup_dir/$rel"
  done < <(find_sqlite_files "$src_dir")
}

check_and_backup_sqlite_dbs() {
  local src_dir="$1"
  local backup_dir="${2:-}"
  [[ -d "$src_dir" ]] || return 0

  while IFS= read -r db; do
    [[ -f "$db" ]] || continue

    # Integrity check
    local result
    result="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>/dev/null || echo 'error')"
    if [[ "$result" != "ok" ]]; then
      echo "[sqlite] Corrupt database detected: $db"
      local recovered="${db}.recovered"
      if sqlite3 "$db" '.dump' 2>/dev/null | sqlite3 "$recovered" 2>/dev/null; then
        mv -f "$recovered" "$db"
        echo "[sqlite] Recovered via dump: $db"
      else
        rm -f "$recovered"
        local rel="${db#"$src_dir"/}"
        if [[ -n "$backup_dir" ]] && [[ -f "$backup_dir/$rel" ]]; then
          cp -p "$backup_dir/$rel" "$db"
          rm -f "${db}-wal" "${db}-shm" "${db}-journal"
          echo "[sqlite] Restored from backup: $db"
        else
          echo "[sqlite] No backup available — removing: $db"
          rm -f "$db" "${db}-wal" "${db}-shm" "${db}-journal"
        fi
      fi
    fi

    # Backup (after potential recovery)
    if [[ -n "$backup_dir" ]] && [[ -f "$db" ]]; then
      local rel="${db#"$src_dir"/}"
      mkdir -p "$backup_dir/$(dirname "$rel")"
      cp -p "$db" "$backup_dir/$rel"
    fi
  done < <(find_sqlite_files "$src_dir")

  return 0
}


pick_host_cfg() {
  # Prefer opencode.json, then opencode.jsonc, then legacy .opencode.json.
  # If none exists, create opencode.json.
  if [[ -f "$HOST_CFG_JSON" ]]; then
    echo "$HOST_CFG_JSON"
  elif [[ -f "$HOST_CFG_JSONC" ]]; then
    echo "$HOST_CFG_JSONC"
  elif [[ -f "$HOST_CFG_DOT_JSON" ]]; then
    echo "$HOST_CFG_DOT_JSON"
  else
    echo '{ "autoupdate": true }' > "$HOST_CFG_JSON"
    echo "$HOST_CFG_JSON"
  fi
}

backup_host_cfg() {
  ensure_dirs
  local src
  src="$(pick_host_cfg)"
  cp -p "$src" "$BACKUP_DIR/$(basename "$src").bak-$(date +%Y%m%d-%H%M%S)"
}

ensure_policy_file() {
  ensure_dirs
  if [[ ! -f "$POLICY_ENV" ]]; then
    cat > "$POLICY_ENV" <<EOF
# opencode-vm policy (host)
HOST_TCP_PORTS="$DEFAULT_HOST_TCP_PORTS"
LAN_ALLOW_TCP="$DEFAULT_LAN_ALLOW_TCP"
LAN_ALLOW_UDP="$DEFAULT_LAN_ALLOW_UDP"
EOF
  fi
}

load_policy() {
  ensure_policy_file
  # shellcheck disable=SC1090
  source "$POLICY_ENV"
  : "${HOST_TCP_PORTS:=$DEFAULT_HOST_TCP_PORTS}"
  : "${LAN_ALLOW_TCP:=$DEFAULT_LAN_ALLOW_TCP}"
  : "${LAN_ALLOW_UDP:=$DEFAULT_LAN_ALLOW_UDP}"
}

save_policy() {
  cat > "$POLICY_ENV" <<EOF
# opencode-vm policy (host)
HOST_TCP_PORTS="$HOST_TCP_PORTS"
LAN_ALLOW_TCP="$LAN_ALLOW_TCP"
LAN_ALLOW_UDP="$LAN_ALLOW_UDP"
EOF
}



# Helpers for space-separated lists
list_has() {
  local item="$1"; shift
  local list="$*"
  [[ " $list " == *" $item "* ]]
}

list_add() {
  local item="$1"; shift
  local list="$*"
  if list_has "$item" $list; then
    echo "$list"
  else
    echo "$list $item" | xargs
  fi
}

list_rm() {
  local item="$1"; shift
  local list="$*"
  echo "$list" | tr ' ' '
' | awk -v i="$item" '$0!=i && $0!=""' | paste -sd' ' - | xargs
}

# ---------------------------------------------------------------------------
# Self-update helpers
# ---------------------------------------------------------------------------

ocvm_update_source_url() {
  if [[ -n "${OCVM_UPDATE_URL:-}" ]]; then
    printf '%s' "$OCVM_UPDATE_URL"
    return 0
  fi
  printf 'https://raw.githubusercontent.com/%s/%s/%s' \
    "$OCVM_UPDATE_REPO" "$OCVM_UPDATE_BRANCH" "$OCVM_UPDATE_SCRIPT_PATH"
}

ocvm_is_valid_version() {
  case "$1" in
    ''|*[!0-9.]*|*.*.*.*|.*|*.) return 1 ;;
  esac
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

ocvm_version_greater_than() {
  local left="$1" right="$2"
  awk -v left="$left" -v right="$right" 'BEGIN {
    left_count  = split(left,  lp, ".")
    right_count = split(right, rp, ".")
    max = left_count > right_count ? left_count : right_count
    for (i = 1; i <= max; i++) {
      l = (i in lp) ? lp[i] + 0 : 0
      r = (i in rp) ? rp[i] + 0 : 0
      if (l > r) exit 0
      if (l < r) exit 1
    }
    exit 1
  }'
}

ocvm_extract_version_from_file() {
  local file_path="$1"
  awk -F'"' '/^OCVM_VERSION="[0-9]+\.[0-9]+\.[0-9]+"$/ { print $2; exit }' "$file_path"
}

ocvm_resolve_script_path() {
  local source_path="${BASH_SOURCE[0]}"
  while [[ -L "$source_path" ]]; do
    local dir
    dir="$(cd "$(dirname "$source_path")" && pwd -P)"
    source_path="$(readlink "$source_path")"
    [[ "$source_path" == /* ]] || source_path="$dir/$source_path"
  done
  local script_dir
  script_dir="$(cd "$(dirname "$source_path")" && pwd -P)"
  printf '%s/%s' "$script_dir" "$(basename "$source_path")"
}

ocvm_fetch_remote_script_to_file() {
  local target_file="$1"
  local source_url
  source_url="$(ocvm_update_source_url)"
  command -v curl >/dev/null 2>&1 || return 1
  if [[ "${OCVM_UPDATE_CHECK_QUIET:-0}" == "1" ]]; then
    curl --fail --silent --location --max-time 4 "$source_url" >"$target_file" 2>/dev/null
  else
    curl --fail --silent --show-error --location --max-time 4 "$source_url" >"$target_file"
  fi
}

ocvm_source_url_for_ref() {
  local ref="$1"
  printf 'https://raw.githubusercontent.com/%s/%s/%s' \
    "$OCVM_UPDATE_REPO" "$ref" "$OCVM_UPDATE_SCRIPT_PATH"
}

ocvm_fetch_remote_script_ref_to_file() {
  local ref="$1" target_file="$2"
  local source_url
  source_url="$(ocvm_source_url_for_ref "$ref")"
  command -v curl >/dev/null 2>&1 || return 1
  curl --fail --silent --location --max-time 6 "$source_url" >"$target_file" 2>/dev/null
}

ocvm_fetch_remote_script_version_to_file() {
  local version="$1" target_file="$2"
  local ref repo_url repo_tmp_dir repo_tmp_file commit script_version

  # Try v-prefixed tag first (e.g., v0.1.0)
  ref="v$version"
  if ocvm_fetch_remote_script_ref_to_file "$ref" "$target_file"; then
    return 0
  fi

  # Try bare version tag (e.g., 0.1.0)
  ref="$version"
  if ocvm_fetch_remote_script_ref_to_file "$ref" "$target_file"; then
    return 0
  fi

  # Fallback: clone repo and search commit history
  command -v git >/dev/null 2>&1 || return 1
  repo_tmp_dir="$(mktemp -d)"
  repo_tmp_file="$(mktemp)"
  repo_url="https://github.com/$OCVM_UPDATE_REPO.git"

  if ! git clone --quiet --depth 200 --branch "$OCVM_UPDATE_BRANCH" "$repo_url" "$repo_tmp_dir" >/dev/null 2>&1; then
    rm -rf "$repo_tmp_dir"
    rm -f "$repo_tmp_file"
    return 1
  fi

  while IFS= read -r commit; do
    if git -C "$repo_tmp_dir" show "$commit:$OCVM_UPDATE_SCRIPT_PATH" >"$repo_tmp_file" 2>/dev/null; then
      script_version="$(ocvm_extract_version_from_file "$repo_tmp_file" || true)"
      if [[ "$script_version" == "$version" ]]; then
        cp "$repo_tmp_file" "$target_file"
        rm -rf "$repo_tmp_dir"
        rm -f "$repo_tmp_file"
        return 0
      fi
    fi
  done < <(git -C "$repo_tmp_dir" log --format='%H' -- "$OCVM_UPDATE_SCRIPT_PATH")

  rm -rf "$repo_tmp_dir"
  rm -f "$repo_tmp_file"
  return 1
}

ocvm_check_remote_version() {
  local remote_tmp_file="$1"
  local remote_version
  ocvm_fetch_remote_script_to_file "$remote_tmp_file" || return 1
  remote_version="$(ocvm_extract_version_from_file "$remote_tmp_file" || true)"
  ocvm_is_valid_version "$remote_version" || return 1
  printf '%s' "$remote_version"
}

ocvm_notify_if_new_version_available() {
  local current_cmd="$1"

  case "$current_cmd" in
    install|update|create-patch|export-patch|--post-update-migrate) return 0 ;;
  esac

  [[ "${OCVM_DISABLE_UPDATE_CHECK:-0}" == "1" ]] && return 0

  local remote_tmp_file remote_version
  remote_tmp_file="$(mktemp)"
  remote_version="$(OCVM_UPDATE_CHECK_QUIET=1 ocvm_check_remote_version "$remote_tmp_file" || true)"
  rm -f "$remote_tmp_file"

  [[ -n "$remote_version" ]] || return 0

  if ocvm_version_greater_than "$remote_version" "$OCVM_VERSION"; then
    echo "New version available: $OCVM_VERSION -> $remote_version" >&2
    echo "Run 'opencode-vm update' to update this script." >&2
  fi
}

ports_cmd() {
  load_policy
  local area="${1:-show}"; shift || true

  case "$area" in
    show)
      echo "Policy file: $POLICY_ENV"
      echo "HOST_TCP_PORTS: $HOST_TCP_PORTS"
      echo "LAN_ALLOW_TCP:  ${LAN_ALLOW_TCP:-<empty>}"
      echo "LAN_ALLOW_UDP:  ${LAN_ALLOW_UDP:-<empty>}"
      ;;

    host)
      local op="${1:-show}"; shift || true
      case "$op" in
        show|"")
          echo "$HOST_TCP_PORTS"
          ;;
        add)
          for p in "$@"; do HOST_TCP_PORTS="$(list_add "$p" $HOST_TCP_PORTS)"; done
          save_policy
          echo "HOST_TCP_PORTS: $HOST_TCP_PORTS"
          ;;
        rm|remove|del)
          for p in "$@"; do HOST_TCP_PORTS="$(list_rm "$p" $HOST_TCP_PORTS)"; done
          save_policy
          echo "HOST_TCP_PORTS: $HOST_TCP_PORTS"
          ;;
        set)
          HOST_TCP_PORTS="$*"
          save_policy
          echo "HOST_TCP_PORTS: $HOST_TCP_PORTS"
          ;;
        *)
          echo "Usage: opencode-vm ports host {show|add|rm|set} [PORT...]" >&2
          exit 2
          ;;
      esac
      ;;

    lan)
      local proto="${1:-tcp}"; shift || true
      local op="${1:-show}"; shift || true

      case "$proto" in
        tcp)
          case "$op" in
            show|"") echo "${LAN_ALLOW_TCP:-}" ;;
            add)
              for ep in "$@"; do LAN_ALLOW_TCP="$(list_add "$ep" $LAN_ALLOW_TCP)"; done
              save_policy
              echo "LAN_ALLOW_TCP: $LAN_ALLOW_TCP" ;;
            rm|remove|del)
              for ep in "$@"; do LAN_ALLOW_TCP="$(list_rm "$ep" $LAN_ALLOW_TCP)"; done
              save_policy
              echo "LAN_ALLOW_TCP: $LAN_ALLOW_TCP" ;;
            clear)
              LAN_ALLOW_TCP=""
              save_policy
              echo "LAN_ALLOW_TCP cleared" ;;
            *)
              echo "Usage: opencode-vm ports lan tcp {show|add|rm|clear} [IP:PORT...]" >&2
              exit 2
              ;;
          esac
          ;;

        udp)
          case "$op" in
            show|"") echo "${LAN_ALLOW_UDP:-}" ;;
            add)
              for ep in "$@"; do LAN_ALLOW_UDP="$(list_add "$ep" $LAN_ALLOW_UDP)"; done
              save_policy
              echo "LAN_ALLOW_UDP: $LAN_ALLOW_UDP" ;;
            rm|remove|del)
              for ep in "$@"; do LAN_ALLOW_UDP="$(list_rm "$ep" $LAN_ALLOW_UDP)"; done
              save_policy
              echo "LAN_ALLOW_UDP: $LAN_ALLOW_UDP" ;;
            clear)
              LAN_ALLOW_UDP=""
              save_policy
              echo "LAN_ALLOW_UDP cleared" ;;
            *)
              echo "Usage: opencode-vm ports lan udp {show|add|rm|clear} [IP:PORT...]" >&2
              exit 2
              ;;
          esac
          ;;

        *)
          echo "Usage: opencode-vm ports lan {tcp|udp} ..." >&2
          exit 2
          ;;
      esac
      ;;

    *)
      echo "Usage: opencode-vm ports {show|host|lan} ..." >&2
      exit 2
      ;;
  esac
}

cleanup_sessions() {
  # Clean tracked sessions
  if [[ -d "$SESSIONS_DIR" ]]; then
    for senv in "$SESSIONS_DIR"/*.env; do
      [[ -f "$senv" ]] || continue
      # shellcheck disable=SC1090
      source "$senv"
      echo "[cleanup] $SESS_NAME (${SESS_PROJ:-unknown})"
      limactl stop "$SESS_NAME" 2>/dev/null || true
      limactl delete -f "$SESS_NAME" 2>/dev/null || true
      rm -rf "${senv%.env}"
      rm -f "$senv"
    done
  fi
  # Catch orphaned oc-* VMs not tracked by env files
  local orphans
  orphans="$(limactl list -q 2>/dev/null | grep '^oc-' | grep -v "^${BASE_NAME}$" || true)"
  for s in $orphans; do
    echo "[cleanup] orphan: $s"
    limactl stop "$s" 2>/dev/null || true
    limactl delete -f "$s" 2>/dev/null || true
  done
}

screenshot_cmd() {
  local share_dir="$HOME/Desktop/opencode-share"
  if [[ ! -d "$share_dir" ]]; then
    cat <<EOF
[screenshot] The shared Desktop folder does not exist yet.

To set it up, create the folder on your macOS Desktop:

  mkdir -p ~/Desktop/opencode-share

Then run this command again:

  opencode-vm screenshot
EOF
    exit 0
  fi

  cat <<EOF
[screenshot] Your share folder is ready: $share_dir

To capture browser screenshots into your VM sessions, install the
Chrome extension "Screenshot Capture":

  https://chromewebstore.google.com/detail/screenshot-capture/giabbpobpebjfegnpcclkocepcgockkc

Then configure the extension settings:
  1. Capture method:  "Viewport" (captures the entire visible area)
  2. Save method:     "Save as File"
  3. Save location:   ~/Desktop/opencode-share

Once configured, press the extension button (or its keyboard shortcut)
to capture a screenshot. The file will be saved as:
  Screenshot Capture - YYYY-MM-DD - HH-MM-SS.png

In your OpenCode VM prompts you can then refer to "the current screenshot"
at any time — the agent knows where to find the latest file and will
automatically delete all screenshot files after analysis.
EOF
}

# ---------------------------------------------------------------------------
# Self-update commands
# ---------------------------------------------------------------------------

ocvm_post_update_migrate() {
  # Hook for future version-to-version migrations.
  # Args: old_version new_version
  [[ "$#" -eq 2 ]] || return 0
  return 0
}

update_cmd() {
  [[ "$#" -eq 0 ]] || { echo "Usage: opencode-vm update" >&2; exit 2; }

  local remote_tmp_file remote_version current_version script_path
  current_version="$OCVM_VERSION"
  remote_tmp_file="$(mktemp)"

  remote_version="$(ocvm_check_remote_version "$remote_tmp_file" || true)"
  if [[ -z "$remote_version" ]]; then
    rm -f "$remote_tmp_file"
    echo "Could not check for updates from: $(ocvm_update_source_url)" >&2
    exit 1
  fi

  if ! ocvm_version_greater_than "$remote_version" "$current_version"; then
    rm -f "$remote_tmp_file"
    echo "Already up to date (version $current_version)."
    return 0
  fi

  script_path="$(ocvm_resolve_script_path)"
  if [[ ! -w "$script_path" ]]; then
    rm -f "$remote_tmp_file"
    echo "Cannot update '$script_path' (no write permission)." >&2
    exit 1
  fi

  chmod +x "$remote_tmp_file"
  mv "$remote_tmp_file" "$script_path"
  echo "Updated opencode-vm from version $current_version to $remote_version."

  if OCVM_DISABLE_UPDATE_CHECK=1 "$script_path" --post-update-migrate "$current_version" "$remote_version"; then
    echo "Update complete."
  else
    echo "Updated script, but post-update migration hook reported an issue." >&2
    echo "Run opencode-vm again and inspect your state before continuing." >&2
  fi
  echo ""
  echo "Recommended: run 'opencode-vm init' to rebuild the base VM with any new changes."
}

install_cmd() {
  local source_path target_dir target_path shell_name shell_rc

  target_dir="$HOME/bin"
  target_path="$target_dir/opencode-vm"

  # Resolve where this script is running from
  source_path="$(ocvm_resolve_script_path)"

  if [[ ! -f "$source_path" ]]; then
    echo "[install] Cannot determine script location." >&2
    echo "Download the script first, then run: bash opencode-vm.sh install" >&2
    exit 1
  fi

  # Create ~/bin if needed
  mkdir -p "$target_dir"

  # Resolve target path (follow symlinks portably, no readlink -f)
  local resolved_target="$target_path"
  if [[ -e "$target_path" ]]; then
    local t="$target_path"
    while [[ -L "$t" ]]; do
      local d
      d="$(cd "$(dirname "$t")" && pwd -P)"
      t="$(readlink "$t")"
      [[ "$t" == /* ]] || t="$d/$t"
    done
    resolved_target="$(cd "$(dirname "$t")" && pwd -P)/$(basename "$t")"
  fi

  # Copy script to ~/bin/opencode-vm (skip if same file)
  if [[ "$source_path" == "$resolved_target" ]]; then
    echo "[install] Script already installed at $target_path. Skipping copy."
  else
    cp "$source_path" "$target_path"
    echo "[install] Installed opencode-vm to $target_path"
  fi

  chmod +x "$target_path"

  # Check PATH and update shell profile if needed
  if echo ":$PATH:" | grep -q ":$target_dir:"; then
    echo "[install] $target_dir is already in PATH."
  else
    # Determine the appropriate shell profile file
    shell_name="$(basename "${SHELL:-/bin/zsh}")"
    case "$shell_name" in
      zsh)  shell_rc="$HOME/.zshrc" ;;
      bash)
        if [[ -f "$HOME/.bash_profile" ]]; then
          shell_rc="$HOME/.bash_profile"
        else
          shell_rc="$HOME/.bashrc"
        fi
        ;;
      *)    shell_rc="$HOME/.profile" ;;
    esac

    local path_line='export PATH="$HOME/bin:$PATH"'

    # Only append if not already present in the file
    if [[ -f "$shell_rc" ]] && grep -qF "$path_line" "$shell_rc"; then
      echo "[install] PATH entry already in $shell_rc (will take effect in new shells)."
    else
      echo "" >> "$shell_rc"
      echo "$path_line" >> "$shell_rc"
      echo "[install] Added $target_dir to PATH in $shell_rc"
    fi
  fi

  # Install Lima via Homebrew if not already present
  if command -v limactl &>/dev/null; then
    echo "[install] Lima is already installed."
  elif command -v brew &>/dev/null; then
    echo "[install] Installing Lima via Homebrew..."
    brew install lima
    echo "[install] Lima installed."
  else
    echo "[install] Homebrew not found. Please install Lima manually: brew install lima"
  fi

  # Print success and next steps
  echo ""
  echo "opencode-vm v$OCVM_VERSION installed successfully."
  echo ""
  echo "Next steps:"
  local step=1
  if ! echo ":$PATH:" | grep -q ":$target_dir:"; then
    echo "  $step. Reload your shell:  source ~/${shell_rc##"$HOME"/}"
    step=$((step + 1))
  fi
  if ! command -v limactl &>/dev/null; then
    echo "  $step. Install Lima:       brew install lima"
    step=$((step + 1))
  fi
  echo "  $step. Init base VM:       opencode-vm init"
  step=$((step + 1))
  echo "  $step. Start a session:    cd /path/to/project && opencode-vm start"
}

export_patch_cmd() {
  local topic="" strategy="intent"
  local script_path remote_tmp_file patch_tmp_file base_tmp_file merged_tmp_file
  local remote_version timestamp patch_source
  local issue_title default_topic entered_topic
  local base_version
  local patch_strategy_note="" merge_conflict_note=""
  local arg prompt_for_title=0

  # Parse arguments
  while [[ "$#" -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      --strategy=*) strategy="${arg#*=}" ;;
      --strategy)
        shift || true
        [[ "$#" -gt 0 ]] || { echo "Missing value for --strategy (use: intent or legacy)." >&2; exit 2; }
        strategy="$1"
        ;;
      --)
        shift || true
        topic="${*:-}"
        break
        ;;
      -*) echo "Unknown option for export-patch: $arg" >&2; exit 2 ;;
      *)
        if [[ -n "$topic" ]]; then
          topic="$topic $arg"
        else
          topic="$arg"
        fi
        ;;
    esac
    shift || true
  done

  case "$strategy" in
    intent|legacy) ;;
    *) echo "Unsupported patch strategy: $strategy (expected: intent or legacy)." >&2; exit 2 ;;
  esac

  script_path="$(ocvm_resolve_script_path)"
  [[ -f "$script_path" ]] || { echo "Local script not found: $script_path" >&2; exit 1; }

  remote_tmp_file="$(mktemp)"
  patch_tmp_file="$(mktemp)"
  base_tmp_file="$(mktemp)"
  merged_tmp_file="$(mktemp)"
  patch_source="$script_path"

  if ! ocvm_fetch_remote_script_to_file "$remote_tmp_file"; then
    rm -f "$remote_tmp_file" "$patch_tmp_file" "$base_tmp_file" "$merged_tmp_file"
    echo "Could not fetch upstream script from: $(ocvm_update_source_url)" >&2
    exit 1
  fi

  remote_version="$(ocvm_extract_version_from_file "$remote_tmp_file" || true)"
  if ! ocvm_is_valid_version "$remote_version"; then
    rm -f "$remote_tmp_file" "$patch_tmp_file" "$base_tmp_file" "$merged_tmp_file"
    echo "Could not parse upstream OCVM_VERSION from downloaded script." >&2
    exit 1
  fi

  # Intent strategy: 3-way merge to isolate local changes
  if [[ "$strategy" == "intent" ]]; then
    base_version="$OCVM_VERSION"
    if ! command -v git >/dev/null 2>&1; then
      strategy="legacy"
      patch_strategy_note="Intent strategy requested but git is not available; fallback to legacy."
    elif ! ocvm_is_valid_version "$base_version"; then
      strategy="legacy"
      patch_strategy_note="Intent strategy requested but local OCVM_VERSION is not valid; fallback to legacy."
    else
      if ! ocvm_fetch_remote_script_version_to_file "$base_version" "$base_tmp_file"; then
        strategy="legacy"
        patch_strategy_note="Intent strategy requested but could not fetch upstream base for version $base_version; fallback to legacy."
      fi
      if [[ "$strategy" == "intent" ]] && [[ "$base_version" == "$remote_version" ]]; then
        cp "$remote_tmp_file" "$base_tmp_file"
      fi
      if [[ "$strategy" == "intent" ]]; then
        if git merge-file -p "$remote_tmp_file" "$base_tmp_file" "$script_path" >"$merged_tmp_file"; then
          patch_source="$merged_tmp_file"
        else
          strategy="legacy"
          patch_strategy_note="Intent strategy detected overlapping edits; fallback to legacy."
          merge_conflict_note="Patch may include revert-looking hunks because automatic intent extraction conflicted."
        fi
      fi
    fi
  fi

  # Generate diff
  if diff -u --label a/opencode-vm.sh --label b/opencode-vm.sh "$remote_tmp_file" "$patch_source" >"$patch_tmp_file"; then
    rm -f "$remote_tmp_file" "$patch_tmp_file" "$base_tmp_file" "$merged_tmp_file"
    echo "No local changes in opencode-vm.sh compared to canonical upstream."
    return 0
  fi

  timestamp="$(date +%Y%m%d-%H%M%S)"

  # Interactive title prompt
  if [[ -z "$topic" ]]; then
    default_topic="Feature update $timestamp"
    topic="$default_topic"
    if [[ -t 0 ]] && [[ -t 1 ]]; then
      prompt_for_title=1
      printf 'No patch title provided.\n' >&2
      printf 'Summarize the feature in 2-5 words (press Enter for `%s`): ' "$default_topic" >&2
      IFS= read -r entered_topic
      [[ -n "$entered_topic" ]] && topic="$entered_topic"
    fi
  fi

  issue_title="[PATCH SUBMISSION] $topic"
  local issues_url="https://github.com/$OCVM_UPDATE_REPO/issues/new"

  # Output instructions and issue template to stdout
  printf '# Patch Submission Instructions\n\n'
  printf '1. If you do not have a GitHub account, create one first: https://github.com/signup\n'
  printf '2. Open this URL: %s\n' "$issues_url"
  printf '3. Set issue title to: `%s`\n' "$issue_title"
  printf '4. Paste the issue body below and submit\n\n'

  if [[ "$prompt_for_title" -eq 1 ]]; then
    printf 'Press Enter to show issue content... ' >&2
    IFS= read -r _
    printf '\n%s\n\n' '----------------------------------------' >&2
  fi

  printf '# Issue Title\n\n%s\n\n' "$issue_title"
  printf '# Issue Body\n\n'
  printf '## Contributor Metadata\n\n'
  printf -- '- Local opencode-vm version: `%s`\n' "$OCVM_VERSION"
  printf -- '- Upstream opencode-vm version: `%s`\n' "$remote_version"
  printf -- '- Upstream source URL: `%s`\n' "$(ocvm_update_source_url)"
  printf -- '- Patch strategy: `%s`\n' "$strategy"
  printf -- '- Generated at: `%s`\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf -- '- Local generation id: `%s`\n\n' "$timestamp"
  [[ -z "$patch_strategy_note" ]]  || printf -- '- Strategy note: %s\n\n' "$patch_strategy_note"
  [[ -z "$merge_conflict_note" ]]  || printf -- '- Conflict note: %s\n\n' "$merge_conflict_note"
  printf '## Contributor Notes\n\n'
  printf -- '- Replace this line with a short problem statement and why this patch is needed.\n'
  printf -- '- Replace this line with expected behavior after applying the patch.\n\n'
  printf '## Instructions for Maintainer and Copilot\n\n'
  printf '1. Assign this issue to Copilot coding agent.\n'
  printf '2. Apply the patch from the `Patch` section below to `opencode-vm.sh`, but keep current upstream behavior where unrelated hunks look like rollbacks.\n'
  printf '3. Validate syntax with `bash -n opencode-vm.sh`.\n'
  printf '4. Run manual verification steps.\n'
  printf '5. Open a PR with:\n'
  printf '   - a concise summary of behavior changes,\n'
  printf '   - validation steps and outcomes,\n'
  printf '   - any caveats or follow-ups.\n\n'
  printf '## Copilot Guidance\n\n'
  printf -- '- Preserve upstream behavior unless a hunk is required for the new feature intent.\n'
  printf -- '- If a patch hunk appears to reintroduce removed logic, treat it as non-intent unless clearly required.\n'
  printf -- '- Prefer extracting minimal feature-specific changes over replaying historical state differences.\n\n'
  printf '## Patch\n\n'
  printf '```diff\n'
  cat "$patch_tmp_file"
  printf '```\n'

  rm -f "$remote_tmp_file" "$patch_tmp_file" "$base_tmp_file" "$merged_tmp_file"
}

base_exists() {
  limactl list -q 2>/dev/null | grep -qx "$BASE_NAME"
}

provision_base() {
  echo "[init] Creating base VM: $BASE_NAME"
  # Lima's --timeout may not cover the optional Docker probe; tolerate timeout
  # and wait for SSH readiness ourselves.
  limactl start --cpus 6 --memory 8 --name "$BASE_NAME" --vm-type vz --mount-none --mount-type virtiofs --timeout 20m --tty=false "$TEMPLATE" || {
    # Check if VM is running despite the timeout error
    if limactl list -q 2>/dev/null | grep -qx "$BASE_NAME"; then
      echo "[init] Lima timed out on optional probe, but VM is running — continuing..."
    else
      echo "[init] VM failed to start." >&2
      exit 1
    fi
  }

  # Wait for shell access to be ready (Docker probe may still be finishing)
  echo "[init] Waiting for VM shell access..."
  local retries=0
  while ! limactl shell "$BASE_NAME" -- true 2>/dev/null; do
    retries=$((retries + 1))
    if (( retries > 30 )); then
      echo "[init] VM shell not accessible after 60s." >&2
      exit 1
    fi
    sleep 2
  done
  echo "[init] VM shell ready"

  # Expose auto-forwarded ports on all interfaces (LAN access for web mode)
  local lima_yaml="$HOME/.lima/$BASE_NAME/lima.yaml"
  if ! grep -q 'hostIP:' "$lima_yaml" 2>/dev/null; then
    echo "[init] Configuring LAN port forwarding..."
    limactl stop "$BASE_NAME" 2>/dev/null || true
    # Insert catch-all rule: forward guest 0.0.0.0 ports to host 0.0.0.0
    sed -i '' '/^portForwards:/a\
- guestIPMustBeZero: true\
  hostIP: 0.0.0.0
' "$lima_yaml"
    limactl start "$BASE_NAME" --tty=false
    echo "[init] LAN port forwarding configured"
  fi

  echo "[init] Installing OpenCode + nftables policy in base"
  limactl shell "$BASE_NAME" -- bash -l <<'PROVISION'
set -euo pipefail

# Ensure PATH for all dev tools
grep -q '# opencode-vm PATH setup' ~/.profile 2>/dev/null || cat >> ~/.profile <<'PATHBLOCK'
# opencode-vm PATH setup
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.config/composer/vendor/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
export PYENV_ROOT="$HOME/.pyenv"
[ -d "$PYENV_ROOT/bin" ] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
export BASH_ENV="$HOME/.bash_env.sh"
PATHBLOCK

# Create loader for non-interactive shells (OpenCode runs bash -c)
# BASH_ENV causes bash to source this file even without -l or -i
cat > ~/.bash_env.sh <<'ENVFILE'
# Loaded via BASH_ENV for non-interactive shells (bash -c)
# Guard: nvm.sh spawns subshells that would re-trigger BASH_ENV recursively
[ -n "$__BASH_ENV_LOADED" ] && return 0
export __BASH_ENV_LOADED=1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
export PYENV_ROOT="$HOME/.pyenv"
[ -d "$PYENV_ROOT/bin" ] && export PATH="$PYENV_ROOT/bin:$PATH"
command -v pyenv >/dev/null && eval "$(pyenv init -)"
ENVFILE

# Install opencode if missing
if ! command -v opencode >/dev/null 2>&1; then
  curl -fsSL https://opencode.ai/install | bash
fi

# Install dev tools, languages, and nftables
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl wget openssl \
  git ripgrep jq \
  less nano vim-tiny file tree \
  tar gzip bzip2 xz-utils zip unzip \
  procps lsof strace build-essential pkg-config make cmake \
  iproute2 iputils-ping traceroute mtr-tiny \
  bind9-dnsutils netcat-openbsd tcpdump socat whois iperf3 \
  python3 python3-venv python3-pip pipx \
  php-cli php-mbstring php-xml php-curl php-zip php-bcmath php-intl \
  php-mysql php-pgsql php-sqlite3 composer \
  golang-go \
  sqlite3 postgresql-client mysql-client redis-tools \
  libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
  libncursesw5-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev tk-dev \
  nftables \
  apparmor apparmor-utils \
  libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdbus-1-3 libdrm2 libxcb1 libxkbcommon0 \
  libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64

# Install NVM + Node.js 22 LTS (default)
export NVM_DIR="$HOME/.nvm"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22

# Install Playwright MCP globally + Chromium browser for headless UI testing
npm install -g @playwright/mcp@latest
npx -y playwright install chromium

# Create NVM-version-independent symlink so playwright-mcp stays available
# even when the agent switches Node versions with nvm use
mkdir -p ~/.local/bin
ln -sf "$(npm prefix -g)/bin/playwright-mcp" ~/.local/bin/playwright-mcp

# Install pyenv + Python 3.13 (default)
export PYENV_ROOT="$HOME/.pyenv"
curl -fsSL https://pyenv.run | bash
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
pyenv install 3.13
pyenv global 3.13

# Install RepoMapper MCP for AI-friendly codebase structure maps (PageRank-ranked)
# Pinned to commit 3ef8914 (2025-12-08) — security-reviewed, no network calls / no shell exec
git clone https://github.com/pdavis68/RepoMapper.git ~/.local/share/repomapper
git -C ~/.local/share/repomapper checkout 3ef8914b3a2271695ac9e4b07ce1e8bf5a4c9be6
pip3 install -r ~/.local/share/repomapper/requirements.txt
ln -sf ~/.local/share/repomapper/repomap_server.py ~/.local/bin/repomap-server

# Write nftables rules (defaults: 1234 + 11434)
sudo tee /etc/nftables.conf >/dev/null <<'NFT'
flush ruleset

table inet ocfilter {
  set host_allow_tcp {
    type inet_service
    elements = { 1234, 11434 }
  }

  set lan_allow_tcp4 {
    type ipv4_addr . inet_service
    flags interval
  }
  set lan_allow_udp4 {
    type ipv4_addr . inet_service
    flags interval
  }

  chain output {
    type filter hook output priority 0; policy accept;

    ct state established,related accept

    # DNS (Lima host-resolver läuft auf 192.168.5.2)
    ip daddr 192.168.5.2 udp dport 53 accept
    ip daddr 192.168.5.2 tcp dport 53 accept

    # ICMP/Ping erlauben
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept

    # Docker bridge traffic (docker-proxy -> container)
    oifname "docker*" accept
    oifname "br-*" accept

    # Host (host.lima.internal = 192.168.5.2): nur Ports aus host_allow_tcp
    ip daddr 192.168.5.2 tcp dport @host_allow_tcp accept
    ip daddr 192.168.5.2 drop

    # Allowlist für private Netze
    ip daddr . tcp dport @lan_allow_tcp4 accept
    ip daddr . udp dport @lan_allow_udp4 accept

    # Block TCP/UDP zu privaten Netzen (außer Allowlist/DNS/Host-Ausnahmen)
    ip daddr 10.0.0.0/8 meta l4proto { tcp, udp } drop
    ip daddr 172.16.0.0/12 meta l4proto { tcp, udp } drop
    ip daddr 192.168.0.0/16 meta l4proto { tcp, udp } drop
  }
}
NFT

sudo systemctl enable --now nftables
sudo systemctl restart nftables

# AppArmor profile: prevent firewall modification from within the VM.
# Posture: allow-all with specific denials for net_admin, sys_module, mac_admin
# capabilities and firewall/AppArmor management tools.
sudo tee /etc/apparmor.d/opencode-sandbox >/dev/null <<'APPARMOR'
profile opencode-sandbox flags=(attach_disconnected) {

  # Default-allow posture
  capability,
  /** rwlkmix,
  network,
  signal,
  unix,
  ptrace,
  mount,
  umount,
  pivot_root,
  dbus,

  # --- PRIMARY DEFENSE: capability denials ---
  deny capability net_admin,    # blocks ALL firewall modification
  deny capability sys_module,   # blocks kernel module load/unload
  deny capability mac_admin,    # blocks MAC policy changes

  # --- Firewall tool execution (defense-in-depth, clearer errors) ---
  deny /usr/sbin/nft x,
  deny /sbin/nft x,
  deny /usr/sbin/iptables x,
  deny /sbin/iptables x,
  deny /usr/sbin/iptables-save x,
  deny /sbin/iptables-save x,
  deny /usr/sbin/iptables-restore x,
  deny /sbin/iptables-restore x,
  deny /usr/sbin/ip6tables x,
  deny /sbin/ip6tables x,
  deny /usr/sbin/ip6tables-save x,
  deny /sbin/ip6tables-save x,
  deny /usr/sbin/ip6tables-restore x,
  deny /sbin/ip6tables-restore x,
  deny /usr/sbin/xtables-* x,
  deny /sbin/xtables-* x,

  # --- Firewall config protection ---
  deny /etc/nftables.conf w,
  deny /lib/systemd/system/nftables.service w,
  deny /etc/systemd/system/nftables.service* w,

  # --- AppArmor escape prevention ---
  deny /usr/sbin/apparmor_parser x,
  deny /sbin/apparmor_parser x,
  deny /usr/sbin/aa-* x,
  deny /sbin/aa-* x,
  deny /usr/bin/aa-* x,
  deny /etc/apparmor.d/** w,
  deny /etc/apparmor/** w,
  deny /sys/kernel/security/apparmor/** w,

  # --- Kernel module tools ---
  deny /usr/sbin/rmmod x,
  deny /sbin/rmmod x,
  deny /usr/sbin/insmod x,
  deny /sbin/insmod x,
  deny /usr/sbin/modprobe x,
  deny /sbin/modprobe x,
  deny /usr/bin/kmod x,
  deny /bin/kmod x,

  # --- Sudoers protection ---
  deny /etc/sudoers w,
  deny /etc/sudoers.d/** w,
}
APPARMOR

sudo apparmor_parser -r /etc/apparmor.d/opencode-sandbox
sudo aa-status --enabled 2>/dev/null || { echo "[init] WARNING: AppArmor not supported by kernel" >&2; }
echo "[init] AppArmor profile 'opencode-sandbox' loaded"

# Write VM environment instructions for AI coding tools (AGENTS.md)
cat > ~/AGENTS.md <<'AGENTSMD'
# VM Environment

You are running inside an isolated Lima VM managed by opencode-vm. The project directory is mounted read-write from the host. You have full freedom to install, configure, and run tools. You have passwordless sudo — use it whenever needed.

## System Privileges

- **sudo**: available without password. Use freely for installing packages, configuring services, changing system settings, inspecting processes, etc.
- **root access**: `sudo -i` or `sudo bash` for a root shell if needed.
- **Service management**: `sudo systemctl start/stop/restart <service>`.

## Languages & Version Managers

- **Node.js** via NVM (Node Version Manager):
  - `node --version`, `npm --version`, `npx <cmd>`
  - NVM is pre-loaded in all shells (interactive and non-interactive): `nvm --version` works directly
  - Switch versions: `nvm install 20`, `nvm use 18`, `nvm alias default 22`
  - Default: Node 22 LTS
  - Global installs: `npm install -g <pkg>` (no sudo needed, NVM manages per-version)
- **Python** via pyenv:
  - `python --version`, `pip install <pkg>`
  - Switch versions: `pyenv install 3.11`, `pyenv global 3.12`, `pyenv local 3.10`
  - Default: Python 3.13
  - System Python (`python3` from apt) also available as fallback
- **Go**: `go version`, `go build`, `go run`, `go install <pkg>@latest`
  - Binaries from `go install` land in `/tmp/go/bin` (on PATH)
- **PHP + Composer**: `php`, `composer`, `composer global require <pkg>`
  - Extensions: mbstring, xml, curl, zip, bcmath, intl, mysql, pgsql, sqlite3
- **Build tools**: `gcc`, `g++`, `make`, `cmake`, `pkg-config`

## Installing Additional Tools

```bash
sudo apt-get update && sudo apt-get install -y <package>
npm install -g <package>
pip install <package>
go install <package>@latest
composer global require <package>
pipx install <package>
```

## Networking & Connectivity Tools

All of these are installed and available:

- **HTTP/downloads**: `curl`, `wget`
- **DNS**: `dig`, `nslookup`, `host` (bind9-dnsutils)
- **TCP/IP connectivity**: `nc` (netcat-openbsd), `socat`, `telnet` (via netcat)
- **Packet capture**: `sudo tcpdump` (requires sudo for raw sockets)
- **Routing & latency**: `ping`, `traceroute`, `mtr` (mtr-tiny), `ip` (iproute2)
- **Bandwidth**: `iperf3`
- **Domain lookups**: `whois`
- **Port scanning/testing**: `nc -zv <host> <port>` to test if a TCP port is open
- **SSL/TLS inspection**: `openssl s_client -connect <host>:<port>`

### Examples

```bash
# Test if a service is reachable on a specific port
nc -zv host.lima.internal 1234

# DNS lookup
dig example.com

# Trace route to a host
mtr --report example.com

# Capture packets on an interface
sudo tcpdump -i eth0 -n port 443

# Test SSL certificate
openssl s_client -connect example.com:443

# Quick HTTP test
curl -sI https://example.com
```

## Docker

Docker is available and running. Use it for containerized services, databases, or any workload:

```bash
docker run -d --name mydb -p 5432:5432 -e POSTGRES_PASSWORD=secret postgres
docker ps
docker logs mydb
docker exec -it mydb psql -U postgres
```

## Database Clients

- `sqlite3` — SQLite CLI
- `psql` — PostgreSQL client
- `mysql` — MySQL/MariaDB client
- `redis-cli` — Redis client

## File & Process Tools

- **Search**: `rg` (ripgrep), `find`, `grep`
- **File inspection**: `file`, `tree`, `less`
- **Editors**: `nano`, `vi` (vim-tiny)
- **Archives**: `tar`, `gzip`, `bzip2`, `xz`, `zip`, `unzip`
- **Process inspection**: `ps`, `top`, `lsof`, `strace`
- **JSON**: `jq`

## Network Configuration

- **Internet**: full outbound access (HTTP/HTTPS and all protocols)
- **Host services** (from inside VM via `host.lima.internal`):
  - LM Studio: `http://host.lima.internal:1234`
  - Ollama: `http://host.lima.internal:11434`
- **LAN**: restricted by default (host can configure via `opencode-vm ports`)
- **DNS**: works normally, resolved via Lima host DNS
- **Firewall**: managed by the host and cannot be modified from within the VM

## Build Caches

All build caches are redirected to VM-local `/tmp/` for performance. They do not persist across sessions: npm, pip, Go, Cargo, Maven, Gradle, pnpm, yarn, ccache, Zig.

## Shared Files from Host Desktop

The host user can place files or folders in a directory called **opencode-share** on their
macOS Desktop. When this directory exists at session start, it is mounted **read-write**
into the VM and accessible at two paths:
- \`~/Desktop/opencode-share\` (symlinked for convenience)
- The original host path (for compatibility with pasted file paths from macOS)

This is useful for sharing images, documents, or other reference files that are not part
of the project repository.

**If a user references a local file path in their prompt and you cannot find the file:**
1. Explain that files outside the project directory are not available inside the VM.
2. Ask the user to create a folder called `opencode-share` on their macOS Desktop
   (if it doesn't exist yet), place the file there, and **restart the session**.
3. The file will then be accessible at its original host path.

## Screenshot Capture

The user can share browser screenshots with you via a Chrome extension that saves
PNG files into the shared Desktop folder.

**Location:** \`~/Desktop/opencode-share/\`
**Filename pattern:** \`Screenshot Capture - YYYY-MM-DD - HH-MM-SS.png\`

When the user mentions a "screenshot" in their prompt:
1. List all files matching \`Screenshot Capture - *.png\` in \`~/Desktop/opencode-share/\`
2. Identify the newest file by its filename timestamp
3. Analyze that image file
4. After analysis, delete **all** \`Screenshot Capture - *.png\` files in that directory
   (the one you just analyzed and any older ones) to keep the folder clean

If no matching screenshot file is found:
- The screenshot feature may not be configured yet
- Tell the user to exit this session, run \`opencode-vm screenshot\` in a host terminal,
  follow the setup instructions, and then start a new session

## Web Search

The `websearch` tool is available. Use it proactively to look up documentation, find API references, research error messages, or discover how others have solved similar problems. When debugging or implementing unfamiliar features, searching the web often saves significant time.

## Browser Automation (Playwright)

Playwright MCP is available as a tool for headless browser automation. Use it for:
- Testing UI flows end-to-end (navigation, form submission, clicking)
- Taking screenshots to verify visual state
- Inspecting page content and accessibility trees
- Debugging frontend issues by interacting with the running application

Start a dev server first (e.g. \`npm run dev\`), then use the Playwright tools to navigate to \`http://localhost:<port>\` and interact with the UI.

**Important:** Chromium is **already pre-installed** as an ARM64-native binary. Everything is configured and works out of the box. Do **NOT** run \`npx playwright install\` or try to install browsers — just use the MCP tools directly.

Pre-installed paths (do not change):
- MCP server binary: \`~/.local/bin/playwright-mcp\` (stable symlink, works with any NVM Node version)
- Chromium binary: \`~/.cache/ms-playwright/chromium-1208/chrome-linux/chrome\`
- Headless shell: \`~/.cache/ms-playwright/chromium_headless_shell-1208/chrome-linux/headless_shell\`

There is no Chrome at \`/opt/google/chrome/\` — ignore that path. The bundled Chromium above is used automatically by the MCP tools (\`browser_navigate\`, \`browser_click\`, \`browser_screenshot\`, etc.).

## Codebase Structure Maps (RepoMapper)

RepoMapper MCP is available for generating ranked structural overviews of codebases. Use it when:
- First exploring a large or unfamiliar codebase to understand its architecture
- You need to identify the most important/interconnected files before diving in
- You want symbol-aware code search (definitions vs references)

**Tools:**
- \`repo_map\` — generates a PageRank-ranked map of the codebase, showing the most important files and their key symbols. Pass \`project_root\` (absolute path) and optionally \`token_limit\` (default 8192).
- \`search_identifiers\` — searches for code identifiers across the codebase with context. Returns definitions and references with file locations and line numbers.

Pre-installed at: \`~/.local/share/repomapper/\`

## Important Notes

- The project directory is shared with the host. File changes are immediately visible on both sides.
- Session VMs are ephemeral — anything outside the project directory or OpenCode state is lost when the session ends.
- Globally installed tools (via apt, npm -g, pip, go install) persist only within the current session.
- You can freely modify system configuration, install packages, start services, and use sudo. The only restriction is on firewall and security-policy management, which are controlled by the host.
AGENTSMD

echo "[init] Base ready. OpenCode: $(command -v opencode || true)"
PROVISION

  echo "[init] Base VM created: $BASE_NAME"
}



apply_policy_in_vm() {
  load_policy

  # host ports: space-separated -> comma-separated list for nft
  local host_ports_csv
  host_ports_csv="$(echo "$HOST_TCP_PORTS" | tr ' ' ',')"

  # LAN allowlists are stored as "IP:PORT" entries
  local lan_tcp_elems=""
  for ep in $LAN_ALLOW_TCP; do
    local ip="${ep%:*}"
    local port="${ep##*:}"
    lan_tcp_elems+="${ip} . ${port}, "
  done
  lan_tcp_elems="${lan_tcp_elems%, }"

  local lan_udp_elems=""
  for ep in $LAN_ALLOW_UDP; do
    local ip="${ep%:*}"
    local port="${ep##*:}"
    lan_udp_elems+="${ip} . ${port}, "
  done
  lan_udp_elems="${lan_udp_elems%, }"

  cat <<EOF
[run] Applying policy inside VM:
  HOST_TCP_PORTS: $HOST_TCP_PORTS
  LAN_ALLOW_TCP:  ${LAN_ALLOW_TCP:-<empty>}
  LAN_ALLOW_UDP:  ${LAN_ALLOW_UDP:-<empty>}
EOF

  limactl shell --workdir / "$1" -- bash -lc "
    set -euo pipefail

    # Flush + re-add sets (idempotent)
    sudo -n nft flush set inet ocfilter host_allow_tcp
    sudo -n nft add element inet ocfilter host_allow_tcp { ${host_ports_csv} }

    sudo -n nft flush set inet ocfilter lan_allow_tcp4
    if [[ -n \"$lan_tcp_elems\" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_tcp4 { $lan_tcp_elems }
    fi

    sudo -n nft flush set inet ocfilter lan_allow_udp4
    if [[ -n \"$lan_udp_elems\" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_udp4 { $lan_udp_elems }
    fi

    sudo -n nft list table inet ocfilter >/dev/null
  "
}

enter_session_shell() {
  local vm_name="$1" proj_dir="$2"
  limactl shell --workdir / "$vm_name" -- bash -lc '
    export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.config/composer/vendor/bin:/tmp/go/bin:/tmp/pnpm-store:$PATH"
    export CARGO_TARGET_DIR=/tmp/cargo-target
    export npm_config_cache=/tmp/npm-cache
    export PNPM_HOME=/tmp/pnpm-store
    export YARN_CACHE_FOLDER=/tmp/yarn-cache
    export PIP_CACHE_DIR=/tmp/pip-cache
    export GOPATH=/tmp/go
    export GOCACHE=/tmp/go-cache
    export MAVEN_OPTS="${MAVEN_OPTS:-} -Dmaven.repo.local=/tmp/m2-repo"
    export GRADLE_USER_HOME=/tmp/gradle
    export CCACHE_DIR=/tmp/ccache
    export ZIG_LOCAL_CACHE_DIR=/tmp/zig-cache
    export ZIG_GLOBAL_CACHE_DIR=/tmp/zig-global-cache
    cd "$1"
    exec bash
  ' _ "$proj_dir"
}

attach_session() {
  need limactl
  local proj senv
  proj="$(pwd)"
  senv="$(session_env "$proj")"

  if [[ ! -f "$senv" ]]; then
    echo "No running session for this project directory." >&2
    echo "Start one with: opencode-vm start" >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  source "$senv"

  if ! is_vm_running "$SESS_NAME"; then
    echo "Session VM '$SESS_NAME' is no longer running." >&2
    echo "Start a new session with: opencode-vm start" >&2
    rm -f "$senv"
    exit 1
  fi

  echo "[attach] Reconnecting to session: $SESS_NAME"
  echo "[attach] Project: $proj"

  local sess_mode="${SESS_MODE:-tui}"
  local sess_port="${SESS_PORT:-$DEFAULT_OC_PORT}"

  limactl shell --workdir / "$SESS_NAME" -- bash -lc '
    set -euo pipefail
    export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.config/composer/vendor/bin:/tmp/go/bin:/tmp/pnpm-store:$PATH"
    export CARGO_TARGET_DIR=/tmp/cargo-target
    export npm_config_cache=/tmp/npm-cache
    export PNPM_HOME=/tmp/pnpm-store
    export YARN_CACHE_FOLDER=/tmp/yarn-cache
    export PIP_CACHE_DIR=/tmp/pip-cache
    export GOPATH=/tmp/go
    export GOCACHE=/tmp/go-cache
    export MAVEN_OPTS="${MAVEN_OPTS:-} -Dmaven.repo.local=/tmp/m2-repo"
    export GRADLE_USER_HOME=/tmp/gradle
    export CCACHE_DIR=/tmp/ccache
    export ZIG_LOCAL_CACHE_DIR=/tmp/zig-cache
    export ZIG_GLOBAL_CACHE_DIR=/tmp/zig-global-cache
    export XDG_DATA_HOME=/tmp/oc-xdg-data
    export XDG_STATE_HOME=/tmp/oc-xdg-state
    export OPENCODE_ENABLE_EXA=1

    SESS_SHARE="$2"
    export XDG_CONFIG_HOME="$SESS_SHARE/config"

    cd "$1"

    if [ "$3" = "web" ]; then
      echo "[attach] Starting OpenCode web server on port $4..."
      aa-exec -p opencode-sandbox -- opencode web --hostname 0.0.0.0 --port "$4" || true
    else
      aa-exec -p opencode-sandbox -- opencode || true
    fi
  ' _ "$proj" "$(session_share_dir "$proj")" "$sess_mode" "$sess_port"
}

start_session() {
  need limactl
  need rsync
  printf "\r[run] Starting OpenCode VM session... |"
  ensure_dirs
  ensure_host_opencode_dirs
  printf "\r[run] Starting OpenCode VM session... /"
  backup_host_cfg
  ensure_policy_file
  printf "\r[run] Starting OpenCode VM session... done $(_ts)\n"

  proj="$(pwd)"

  # Check if a session already exists for this project
  senv="$(session_env "$proj")"
  if [[ -f "$senv" ]]; then
    # shellcheck disable=SC1090
    source "$senv"
    local old_sess="$SESS_NAME"
    local old_sess_share
    old_sess_share="$(session_share_dir "$proj")"
    local old_proj_state
    old_proj_state="$(project_state_dir "$proj")"

    echo ""
    echo "Hey, you left a session open last time. Let me clean up for you. $(_ts)"
    echo "This might take a little bit longer..."
    echo ""

    # Sync data back from old session share to project state and host
    mkdir -p "$old_proj_state/config/opencode" "$old_proj_state/xdg-data/opencode" "$old_proj_state/xdg-state/opencode"
    mkdir -p "$HOST_DATA_DIR" "$HOST_STATE_DIR"

    if [[ -d "$old_sess_share" ]]; then
      local old_cfg="$old_sess_share/config/opencode/opencode.json"
      local old_cfg_dot="$old_sess_share/config/opencode/.opencode.json"
      if [[ -f "$old_cfg_dot" ]] && [[ ! -f "$old_cfg" ]]; then
        old_cfg="$old_cfg_dot"
      fi
      if [[ -f "$old_cfg" ]]; then
        cp -p "$old_cfg" "$old_proj_state/config/opencode/opencode.json"
        cp -p "$old_cfg" "$old_proj_state/config/opencode/.opencode.json"
        cp -p "$old_cfg" "$(pick_host_cfg)"
      fi

      sync_data_dirs_bidirectional "$HOST_DATA_DIR" "$old_sess_share/xdg-data/opencode" "${DATA_RSYNC_EXCLUDES[@]}"
      sync_data_dirs_bidirectional "$HOST_STATE_DIR" "$old_sess_share/xdg-state/opencode"
      rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$old_sess_share/xdg-data/opencode/" "$old_proj_state/xdg-data/opencode/"
      rsync -a "$old_sess_share/xdg-state/opencode/" "$old_proj_state/xdg-state/opencode/"

      local old_db_backup_dir="$old_proj_state/db-backups"
      check_sqlite_integrity "$old_proj_state/xdg-data/opencode" "$old_db_backup_dir/xdg-data"
      check_sqlite_integrity "$old_proj_state/xdg-state/opencode" "$old_db_backup_dir/xdg-state"
    fi

    echo "[old-session] Synced old session data back $(_ts)"

    # Stop and delete old session VM (may already be stopped/gone)
    echo "[cleanup] Removing old session VM: $old_sess $(_ts)"
    limactl stop "$old_sess" 2>/dev/null || true
    limactl delete -f "$old_sess" >/dev/null 2>&1 || true
    rm -f "$senv"
    rm -rf "$old_sess_share"
    echo "[cleanup] Old session removed $(_ts)"
  fi

  sess="oc-$(date +%Y%m%d-%H%M%S)"

  if ! base_exists; then
    echo "Base VM '$BASE_NAME' not found. Running: opencode-vm init $(_ts)" >&2
    provision_base
  fi

  # Per-project persistent state + per-session working copy
  proj_state="$(project_state_dir "$proj")"
  mkdir -p "$proj_state/config/opencode" "$proj_state/xdg-data/opencode" "$proj_state/xdg-state/opencode"

  host_cfg="$(pick_host_cfg)"
  proj_cfg="$proj_state/config/opencode/opencode.json"
  proj_cfg_legacy="$proj_state/config/opencode/.opencode.json"

  if [[ ! -f "$proj_cfg" && -f "$proj_cfg_legacy" ]]; then
    cp -p "$proj_cfg_legacy" "$proj_cfg"
  fi

  # Keep host and project preferences in sync before each session.
  # This also bootstraps first-run setups where local OpenCode was never installed.
  sync_cfg_between_host_and_project "$host_cfg" "$proj_cfg"
  echo "[run] Synced host ↔ project config $(_ts)"
  sync_data_dirs_bidirectional "$HOST_DATA_DIR" "$proj_state/xdg-data/opencode" "${DATA_RSYNC_EXCLUDES[@]}"
  echo "[run] Synced host ↔ project data dir $(_ts)"
  sync_data_dirs_bidirectional "$HOST_STATE_DIR" "$proj_state/xdg-state/opencode"
  echo "[run] Synced host ↔ project state dir $(_ts)"

  if [[ -f "$proj_cfg" ]]; then
    cp -p "$proj_cfg" "$proj_cfg_legacy"
  fi

  # Per-session share directory for config/state
  sess_share="$(session_share_dir "$proj")"
  rm -rf "$sess_share"
  mkdir -p "$sess_share"

  # Copy project state into session share (XDG directory structure)
  mkdir -p "$sess_share/config/opencode" "$sess_share/xdg-data/opencode" "$sess_share/xdg-state/opencode"
  if [[ -f "$proj_cfg" ]]; then
    cp -p "$proj_cfg" "$sess_share/config/opencode/opencode.json"
  else
    cp -p "$host_cfg" "$sess_share/config/opencode/opencode.json"
  fi
  cp -p "$sess_share/config/opencode/opencode.json" "$sess_share/config/opencode/.opencode.json"

  # Inject session overrides: Playwright + RepoMapper MCP, allow-all permissions, ask for git commit, deny git push
  local sess_cfg_file="$sess_share/config/opencode/opencode.json"
  if command -v jq >/dev/null 2>&1 && [[ -f "$sess_cfg_file" ]]; then
    local tmp_cfg
    tmp_cfg="$(mktemp)"
    jq '. * {
      "permission": {
        "*": "allow",
        "bash": {
          "*": "allow",
          "git commit": "ask",
          "git commit *": "ask",
          "git push": "deny",
          "git push *": "deny"
        }
      },
      "mcp": {
        "playwright": {
          "type": "local",
          "command": ["playwright-mcp", "--headless", "--browser", "chromium"]
        },
        "repomapper": {
          "type": "local",
          "command": ["python3", "/home/user.linux/.local/share/repomapper/repomap_server.py"]
        }
      }
    }' "$sess_cfg_file" > "$tmp_cfg" \
      && mv "$tmp_cfg" "$sess_cfg_file" \
      || rm -f "$tmp_cfg"
    cp -p "$sess_cfg_file" "$sess_share/config/opencode/.opencode.json"
  fi

  rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$proj_state/xdg-data/opencode/" "$sess_share/xdg-data/opencode/"
  rsync -a "$proj_state/xdg-state/opencode/" "$sess_share/xdg-state/opencode/"
  echo "[run] Copied project state into session share $(_ts)"

  # Check integrity + backup in a single pass (avoids scanning directories twice)
  local db_backup_dir="$proj_state/db-backups"
  mkdir -p "$db_backup_dir/xdg-data" "$db_backup_dir/xdg-state"
  check_and_backup_sqlite_dbs "$sess_share/xdg-data/opencode" "$db_backup_dir/xdg-data"
  check_and_backup_sqlite_dbs "$sess_share/xdg-state/opencode" "$db_backup_dir/xdg-state"
  echo "[run] SQLite integrity checks + backups done $(_ts)"

  cfg_hash="$(md5 -q "$host_cfg")"

  # Clone base (with lock to support parallel session starts)
  local lockfile="$SHARE_ROOT/clone.lock"
  local wait_count=0
  while true; do
    if ! [ -f "$lockfile" ]; then
      break
    fi
    # Check if lock holder is still alive
    local lock_pid
    lock_pid="$(cat "$lockfile" 2>/dev/null || true)"
    if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      echo "[run] Removing stale clone lock (PID $lock_pid no longer running)"
      rm -f "$lockfile"
      break
    fi
    wait_count=$((wait_count + 1))
    if (( wait_count > 30 )); then
      echo "[run] Clone lock stuck for >60s, removing it"
      rm -f "$lockfile"
      break
    fi
    echo "[run] Waiting for another session to finish cloning..."
    sleep 2
  done
  echo $$ > "$lockfile"
  trap "rm -f '$lockfile'" EXIT
  echo "[run] Starting base VM... $(_ts)"
  limactl start "$BASE_NAME" 2>/dev/null || true
  echo "[run] Base VM started $(_ts)"
  run_with_spinner "[run] Stopping base VM before clone..." limactl stop "$BASE_NAME"

  # Check for optional Desktop share directory
  local share_dir="$HOME/Desktop/opencode-share"
  local share_mount=""
  if [[ -d "$share_dir" ]]; then
    echo "[run] Mounting Desktop share directory (read-write) $(_ts)"
    share_mount="yes"
  fi

  # If project path contains non-ASCII or whitespace, create a clean symlink
  # so Lima's fstab (which can't parse emoji/special chars) works correctly
  local mount_proj="$proj"
  local clean_link=""
  if [[ "$proj" =~ [^a-zA-Z0-9_./:=-] ]]; then
    local proj_hash
    proj_hash="$(printf '%s' "$proj" | shasum | cut -c1-12)"
    clean_link="/tmp/oc-mount-${proj_hash}"
    ln -sfn "$proj" "$clean_link"
    mount_proj="$clean_link"
    echo "[run] Clean mount symlink: $clean_link -> $proj"
  fi

  if [[ -n "$share_mount" ]]; then
    run_with_spinner "[run] Cloning session VM: $sess..." limactl clone "$BASE_NAME" "$sess" \
      --mount-only "${mount_proj}:w" \
      --mount-only "${sess_share}:w" \
      --mount-only "${share_dir}:w" \
      --tty=false
  else
    run_with_spinner "[run] Cloning session VM: $sess..." limactl clone "$BASE_NAME" "$sess" \
      --mount-only "${mount_proj}:w" \
      --mount-only "${sess_share}:w" \
      --tty=false
  fi
  rm -f "$lockfile"
  trap - EXIT
  echo "[run] Clone complete, lock released $(_ts)"

  # Track session (printf '%q' safely escapes paths with spaces/special chars)
  printf 'SESS_NAME=%q\nSESS_PROJ=%q\nCFG_HASH_AT_START=%q\nSESS_MODE=%q\nSESS_PORT=%q\n' \
    "$sess" "$proj" "$cfg_hash" "$SESSION_MODE" "${SESSION_PORT:-}" > "$senv"

  cleanup() {
    echo "[cleanup] Starting cleanup... $(_ts)"
    # Sync config back with conflict detection
    local dst
    dst="$(pick_host_cfg)"
    local sess_cfg_json="$sess_share/config/opencode/opencode.json"
    local sess_cfg_dot="$sess_share/config/opencode/.opencode.json"
    local sess_cfg="$sess_cfg_json"
    local proj_cfg_cleanup="$proj_state/config/opencode/opencode.json"
    local proj_cfg_cleanup_legacy="$proj_state/config/opencode/.opencode.json"

    mkdir -p "$proj_state/config/opencode" "$proj_state/xdg-data/opencode" "$proj_state/xdg-state/opencode"
    mkdir -p "$HOST_DATA_DIR" "$HOST_STATE_DIR"

    if [[ -f "$sess_cfg_dot" ]] && [[ ! -f "$sess_cfg_json" ]]; then
      sess_cfg="$sess_cfg_dot"
    elif [[ -f "$sess_cfg_dot" ]] && [[ -f "$sess_cfg_json" ]] && ! cmp -s "$sess_cfg_json" "$sess_cfg_dot"; then
      local sess_json_mtime sess_dot_mtime
      sess_json_mtime="$(stat -f %m "$sess_cfg_json" 2>/dev/null || echo 0)"
      sess_dot_mtime="$(stat -f %m "$sess_cfg_dot" 2>/dev/null || echo 0)"
      if (( sess_dot_mtime > sess_json_mtime )); then
        sess_cfg="$sess_cfg_dot"
      fi
    fi

    echo "[cleanup] Config conflict check... $(_ts)"
    if [[ -f "$sess_cfg" ]]; then
      cp -p "$sess_cfg" "$proj_cfg_cleanup"
      cp -p "$sess_cfg" "$proj_cfg_cleanup_legacy"

      local current_hash
      current_hash="$(md5 -q "$dst")"
      if [[ "$current_hash" != "$cfg_hash" ]]; then
        echo ""
        echo "Another session has edited the OpenCode config since this session started."
        read -r -p "Overwrite with this session's config? [y/N] " answer </dev/tty || answer="n"
        if [[ "$answer" =~ ^[Yy]$ ]]; then
          cp -p "$sess_cfg" "$dst"
        else
          local bak="$dst.session-bak-$(date +%Y%m%d-%H%M%S)"
          cp -p "$sess_cfg" "$bak"
          echo "Keeping existing config. Session config saved to: $bak"
        fi
      else
        cp -p "$sess_cfg" "$dst"
      fi
    fi

    # Merge VM state with host state (newer files win), then persist into project state.
    echo "[cleanup] Syncing data dirs (host ↔ session)... $(_ts)"
    sync_data_dirs_bidirectional "$HOST_DATA_DIR" "$sess_share/xdg-data/opencode" "${DATA_RSYNC_EXCLUDES[@]}"
    sync_data_dirs_bidirectional "$HOST_STATE_DIR" "$sess_share/xdg-state/opencode"
    echo "[cleanup] Synced host ↔ session data $(_ts)"
    rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$sess_share/xdg-data/opencode/" "$proj_state/xdg-data/opencode/"
    rsync -a "$sess_share/xdg-state/opencode/" "$proj_state/xdg-state/opencode/"
    echo "[cleanup] Persisted into project state $(_ts)"

    # Prevent corrupt databases from persisting across sessions (restore from pre-session backup if needed)
    echo "[cleanup] SQLite integrity checks... $(_ts)"
    local db_backup_dir="$proj_state/db-backups"
    check_sqlite_integrity "$proj_state/xdg-data/opencode" "$db_backup_dir/xdg-data"
    check_sqlite_integrity "$proj_state/xdg-state/opencode" "$db_backup_dir/xdg-state"
    echo "[cleanup] SQLite integrity checks done $(_ts)"

    if [[ -n "${sess:-}" ]]; then
      if [[ "${OC_SHELL_OK:-}" == "1" ]]; then
        echo "[cleanup] Stopping session VM: $sess $(_ts)"
        rm -f "$senv"
        rm -rf "$sess_share"
        limactl stop "$sess" 2>/dev/null || true
        echo "[cleanup] Session VM stopped $(_ts)"
        limactl delete -f "$sess" >/dev/null 2>&1 || true
        echo "[cleanup] Session VM deleted $(_ts)"
      else
        echo "[cleanup] Session VM '$sess' kept running for re-attach. $(_ts)"
        echo "[cleanup] Use 'opencode-vm attach' to reconnect, or 'opencode-vm start' for a fresh session."
      fi
    fi
    # Remove clean mount symlink if created
    [[ -n "${clean_link:-}" ]] && rm -f "$clean_link"
  }
  trap cleanup EXIT

  run_with_spinner "[run] Starting session VM..." limactl start "$sess" --tty=false

  echo "[run] Applying firewall policy... $(_ts)"
  apply_policy_in_vm "$sess"
  echo "[run] Firewall policy applied $(_ts)"

  # Create symlink so ~/Desktop/opencode-share is accessible from VM user's home
  if [[ -n "$share_mount" ]]; then
    limactl shell --workdir / "$sess" -- bash -c 'mkdir -p ~/Desktop && ln -sfn "$1" ~/Desktop/opencode-share' _ "$share_dir"
    echo "[run] Symlinked ~/Desktop/opencode-share $(_ts)"
  fi

  # Wait for project mount to be ready (virtiofs may lag behind VM boot)
  # When using a clean symlink, the mount point in the VM is the clean path
  local mount_check_path="${mount_proj}"
  echo "[run] Checking project mount at: $mount_check_path $(_ts)"
  local mount_retries=0
  while ! limactl shell --workdir / "$sess" -- bash -c 'mountpoint -q "$1"' _ "$mount_check_path" 2>/dev/null; do
    mount_retries=$((mount_retries + 1))
    if (( mount_retries > 30 )); then
      echo "[run] WARNING: Project directory mount not ready after 60s" >&2
      echo "[run] Path: $mount_check_path" >&2
      break
    fi
    sleep 2
  done
  echo "[run] Project mount ready $(_ts)"

  # If using clean symlink, create VM-side symlink so original path resolves
  if [[ -n "$clean_link" ]]; then
    limactl shell --workdir / "$sess" -- sudo bash -c '
      mkdir -p "$(dirname "$1")"
      ln -sfn "$2" "$1"
    ' _ "$proj" "$clean_link"
    echo "[run] VM symlink: $proj -> $clean_link $(_ts)"
  fi

  echo "[run] Launching OpenCode inside VM (project: $proj) $(_ts)"

  limactl shell --workdir / "$sess" -- bash -lc '
    set -euo pipefail
    PROJ_DIR="$1"
    SESS_SHARE="$2"

    export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.config/composer/vendor/bin:/tmp/go/bin:/tmp/pnpm-store:$PATH"

    # Config stays on mount (small JSON files, safe over virtiofs)
    export XDG_CONFIG_HOME="$SESS_SHARE/config"

    # Make VM environment instructions available to OpenCode
    mkdir -p "$SESS_SHARE/config/opencode"
    [ -f "$HOME/AGENTS.md" ] && cp -p "$HOME/AGENTS.md" "$SESS_SHARE/config/opencode/AGENTS.md"

    # Data/state go to VM-local storage to avoid SQLite corruption over virtiofs
    VM_DATA=/tmp/oc-xdg-data
    VM_STATE=/tmp/oc-xdg-state
    mkdir -p "$VM_DATA/opencode" "$VM_STATE/opencode"
    echo "[$(date +%T)] Syncing session data into VM..."
    rsync -a --exclude="bin/" --exclude="log/" --exclude="tool-output/" "$SESS_SHARE/xdg-data/opencode/" "$VM_DATA/opencode/"
    rsync -a "$SESS_SHARE/xdg-state/opencode/" "$VM_STATE/opencode/"
    echo "[$(date +%T)] Session data synced into VM"
    export XDG_DATA_HOME="$VM_DATA"
    export XDG_STATE_HOME="$VM_STATE"

    # In-VM SQLite integrity check
    check_sqlite_dbs() {
      local dir="$1"
      [ -d "$dir" ] || return 0
      local db_list
      db_list="$(find "$dir" -type f -print0 2>/dev/null | xargs -0 grep -l "SQLite format 3" 2>/dev/null || true)"
      [ -n "$db_list" ] || return 0
      echo "$db_list" | while IFS= read -r f; do
        [ -f "$f" ] || continue
        local result
        result="$(sqlite3 "$f" "PRAGMA integrity_check;" 2>/dev/null || echo "error")"
        if [ "$result" != "ok" ]; then
          echo "[sqlite] Corrupt database detected: $f"
          local recovered="${f}.recovered"
          if sqlite3 "$f" ".dump" 2>/dev/null | sqlite3 "$recovered" 2>/dev/null; then
            mv -f "$recovered" "$f"
            echo "[sqlite] Recovered: $f"
          else
            rm -f "$recovered"
            echo "[sqlite] Recovery failed — removing: $f"
            rm -f "$f" "${f}-wal" "${f}-shm" "${f}-journal"
          fi
        fi
      done
    }

    echo "[$(date +%T)] Checking SQLite databases..."
    check_sqlite_dbs "$VM_DATA/opencode"
    check_sqlite_dbs "$VM_STATE/opencode"
    echo "[$(date +%T)] SQLite checks done"

    # -- Build caches -> VM-local (not mounted) for performance --
    export CARGO_TARGET_DIR=/tmp/cargo-target
    export npm_config_cache=/tmp/npm-cache
    export PNPM_HOME=/tmp/pnpm-store
    export YARN_CACHE_FOLDER=/tmp/yarn-cache
    export PIP_CACHE_DIR=/tmp/pip-cache
    export GOPATH=/tmp/go
    export GOCACHE=/tmp/go-cache
    export MAVEN_OPTS="${MAVEN_OPTS:-} -Dmaven.repo.local=/tmp/m2-repo"
    export GRADLE_USER_HOME=/tmp/gradle
    export CCACHE_DIR=/tmp/ccache
    export ZIG_LOCAL_CACHE_DIR=/tmp/zig-cache
    export ZIG_GLOBAL_CACHE_DIR=/tmp/zig-global-cache

    # Enable Exa-powered web search inside OpenCode (no API key needed)
    export OPENCODE_ENABLE_EXA=1

    # Set default git identity for commits inside VM
    git config --global user.name "robot"
    git config --global user.email "robot@geektank.de"

    echo "[$(date +%T)] Build caches redirected to VM-local /tmp/ for performance."
    echo "Host LLM endpoints from VM:"
    echo "  LM Studio: http://host.lima.internal:1234"
    echo "  Ollama:    http://host.lima.internal:11434"
    echo

    OC_MODE="$3"
    OC_PORT="$4"
    OC_PASSWORD="$5"
    OC_WEB_TUI="$6"
    OC_HOST_IP="$7"

    cd "$PROJ_DIR"

    case "$OC_MODE" in
      web)
        echo ""
        echo "=============================================="
        echo "  OpenCode Web Server (port $OC_PORT)"
        echo "=============================================="
        echo ""
        echo "Connect via:"
        echo ""
        echo "  Browser/Web UI:  http://${OC_HOST_IP}:${OC_PORT}"
        echo "  API docs:        http://${OC_HOST_IP}:${OC_PORT}/doc"
        echo "  TUI attach:      opencode attach http://${OC_HOST_IP}:${OC_PORT}"
        echo ""
        if [ -n "$OC_PASSWORD" ]; then
          echo "  Password:        $OC_PASSWORD"
          echo ""
          echo "The REST API can be used for custom integrations,"
          echo "IDE extensions, or programmatic access to OpenCode."
          echo "See: https://opencode.ai/docs/server/"
          echo ""
          export OPENCODE_SERVER_PASSWORD="$OC_PASSWORD"
        else
          echo "The REST API can be used for custom integrations,"
          echo "IDE extensions, or programmatic access to OpenCode."
          echo "See: https://opencode.ai/docs/server/"
          echo ""
          echo "Tip: To secure the server with a password, start with:"
          echo "  opencode-vm web --password <your-password>"
          echo ""
        fi
        if [ "$OC_WEB_TUI" = "true" ]; then
          aa-exec -p opencode-sandbox -- opencode web --hostname 0.0.0.0 --port "$OC_PORT" &
          OC_WEB_PID=$!
          sleep 2
          echo ""
          echo "Press Enter to start TUI (web server continues running)..."
          read -r
          aa-exec -p opencode-sandbox -- opencode attach "http://localhost:$OC_PORT" || true
          kill "$OC_WEB_PID" 2>/dev/null || true
          wait "$OC_WEB_PID" 2>/dev/null || true
        else
          echo "Press Ctrl+C to stop the session."
          aa-exec -p opencode-sandbox -- opencode web --hostname 0.0.0.0 --port "$OC_PORT" || true
        fi
        ;;
      *)
        aa-exec -p opencode-sandbox -- opencode || true
        ;;
    esac

    # After opencode exits: integrity check + sync back to mount
    echo "[$(date +%T)] Syncing session data back to host..."
    check_sqlite_dbs "$VM_DATA/opencode"
    check_sqlite_dbs "$VM_STATE/opencode"
    echo "[$(date +%T)] In-VM SQLite checks done"
    rsync -a --exclude="bin/" --exclude="log/" --exclude="tool-output/" "$VM_DATA/opencode/" "$SESS_SHARE/xdg-data/opencode/"
    rsync -a "$VM_STATE/opencode/" "$SESS_SHARE/xdg-state/opencode/"
    echo "[$(date +%T)] In-VM sync complete"
  ' _ "$proj" "$sess_share" "$SESSION_MODE" "${SESSION_PORT:-0}" "${SESSION_PASSWORD:-}" "${OC_WEB_TUI:-false}" "$(get_host_ip)" && OC_SHELL_OK=1 || true
}

ocvm_notify_if_new_version_available "$cmd"

case "$cmd" in
  install)
    install_cmd
    ;;

  init)
    need limactl
    cleanup_sessions
    if base_exists; then
      echo "[init] Stopping and deleting existing base VM: $BASE_NAME"
      limactl stop "$BASE_NAME" 2>/dev/null || true
      limactl delete -f "$BASE_NAME"
    fi
    provision_base
    echo
    echo "Next: navigate to your project directory (open terminal in VS Code) and run:"
    echo "  opencode-vm start"
    ;;

  start|run)
    start_session
    ;;

  web)
    SESSION_MODE="web"
    parse_web_flags "$@"
    check_port_available "$SESSION_PORT"
    start_session
    ;;

  ports)
    ports_cmd "$@"
    ;;


  shell)
    need limactl
    proj="$(pwd)"
    senv="$(session_env "$proj")"
    if [[ ! -f "$senv" ]]; then
      echo "No running session for this project directory." >&2
      echo "Start one with: opencode-vm start" >&2
      exit 1
    fi
    # shellcheck disable=SC1090
    source "$senv"
    echo "[shell] Connecting to session: $SESS_NAME (project: $proj)"
    enter_session_shell "$SESS_NAME" "$proj"
    ;;

  attach)
    attach_session
    ;;

  base)
    need limactl
    base_exists || provision_base
    limactl shell "$BASE_NAME"
    ;;

  screenshot)
    screenshot_cmd
    ;;

  prune)
    need limactl
    cleanup_sessions
    # Stop base VM if running, but keep it
    if base_exists; then
      limactl stop "$BASE_NAME" 2>/dev/null || true
    fi
    echo "[prune] Sessions cleaned. Base VM kept."
    ;;

  update)
    update_cmd "$@"
    ;;

  create-patch|export-patch)
    export_patch_cmd "$@"
    ;;

  --post-update-migrate)
    ocvm_post_update_migrate "$@"
    ;;

  *)
    cat >&2 <<EOF
opencode-vm v$OCVM_VERSION

Usage:
  opencode-vm install                      # install script to ~/bin and configure PATH
  opencode-vm start                        # start fresh session VM in current directory
  opencode-vm web [--port PORT] [--password PW] [--tui]
                                           # start web server session (default port 4096)
                                           # provides: web UI, REST API, TUI attach
                                           # --tui: also start TUI in terminal (experimental)
  opencode-vm attach                       # reconnect to a running session VM
  opencode-vm shell                        # open additional shell into running session VM
  opencode-vm init                         # create/provision base VM (one-time setup)
  opencode-vm ports show                   # show current firewall policy
  opencode-vm ports host {show|add|rm|set} [PORT...]
  opencode-vm ports lan tcp {show|add|rm|clear} [IP:PORT...]
  opencode-vm ports lan udp {show|add|rm|clear} [IP:PORT...]
  opencode-vm screenshot                   # setup guide for browser screenshot capture
  opencode-vm base                         # shell into base VM
  opencode-vm prune                        # cleanup unused Lima data
  opencode-vm update                       # update script from upstream
  opencode-vm create-patch [--strategy=intent|legacy] [topic]
                                           # generate a patch submission for upstream
  opencode-vm export-patch [topic]         # alias for create-patch

Quick start:
  1. brew install lima                     # install Lima (once)
  2. opencode-vm init                      # create base VM (once)
  3. cd /path/to/your/project              # navigate to project (or open terminal in VS Code)
  4. opencode-vm start                     # launch OpenCode session

Tip:
  Create ~/Desktop/opencode-share/ to share files (e.g. images) with the VM.
EOF
    exit 2
    ;;
esac
