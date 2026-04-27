#!/usr/bin/env bash
set -euo pipefail

# Timing instrumentation for performance debugging
_T0=$(date +%s)
_ts() { echo "+$(($(date +%s) - _T0))s"; }

BASE_NAME="oc-base"

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
PROJECT_HISTORY_DIR="$SHARE_ROOT/project-history"   # loaded only with --keep-history
FRESH_HISTORY_DIR="$SHARE_ROOT/fresh-history"       # per-run snapshots from default fresh mode
FRESH_DEFAULT_NOTIFIED_MARKER="$SHARE_ROOT/.fresh-default-notified"
KEPT_SESSION_NOTIFIED_MARKER="$SHARE_ROOT/.kept-session-notified"
PROJECT_HISTORY_MIGRATED_MARKER="$SHARE_ROOT/.migrated-project-history"

# Policy persistiert am Host (wird pro Session in der VM angewendet)
POLICY_ENV="$SHARE_ROOT/policy.env"

# ECC (everything-claude-code) opt-in integration
ECC_ENV="$SHARE_ROOT/ecc.env"
ECC_DIR="$SHARE_ROOT/ecc"
DEFAULT_ECC_REPO="https://github.com/affaan-m/everything-claude-code.git"
DEFAULT_ECC_REF="main"

# Skills subsystem (registry-driven since v0.4.5 — skills/registry.json is the source of truth)
SKILLS_ENV="$SHARE_ROOT/skills.env"
SKILLS_REGISTRY_CACHE="$SHARE_ROOT/skills-registry"   # fallback if script is not co-located with bundled skills/

# MCPs subsystem (separate from skills: MCPs are servers + credentials; skills are knowledge)
MCPS_ENV="$SHARE_ROOT/mcps.env"
MCPS_REGISTRY_CACHE="$SHARE_ROOT/mcps-registry"   # fallback if script is not co-located with bundled mcps/

# Proxmox MCP (opt-in via `opencode-vm mcps on proxmox`; migrated from skills in v0.4.4)
PROXMOX_ENV="$SHARE_ROOT/proxmox.env"
PROXMOX_MCP_DIR="$SHARE_ROOT/proxmox-mcp"
PROXMOX_SKILL_CACHE="$SHARE_ROOT/proxmox-skill"   # fallback if script is not co-located with bundled skills/

# Web Image Pipeline skill package (built-in, always active — CLI tools in base VM)
WEBIMG_SKILL_CACHE="$SHARE_ROOT/webimg-skill"      # fallback if script is not co-located with bundled skills/
# SSH toolkit skill package (built-in, default active — CLI tools in base VM)
SSH_SKILL_CACHE="$SHARE_ROOT/ssh-toolkit-skill"    # fallback if script is not co-located with bundled skills/
DEFAULT_PROXMOX_MCP_REPO="https://github.com/canvrno/ProxmoxMCP.git"
DEFAULT_PROXMOX_MCP_REF="main"
# Script location (for resolving bundled skills/proxmox when running from repo)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Excludes for xdg-data rsync: bin/ (375M, 28k files — downloaded on demand),
# log/ (old session logs), tool-output/ (previous session artifacts)
DATA_RSYNC_EXCLUDES=(--exclude='bin/' --exclude='log/' --exclude='tool-output/')

# Defaults
DEFAULT_HOST_TCP_PORTS="1234 11434"   # LM Studio + Ollama
DEFAULT_LAN_ALLOW_TCP=""              # z.B. "192.168.178.10:443 10.0.0.5:22" (ohne :PORT = alle TCP-Ports dieser IP)
DEFAULT_LAN_ALLOW_UDP=""              # z.B. "192.168.178.20:53"              (ohne :PORT = alle UDP-Ports dieser IP)
DEFAULT_HOST_LOCALHOST_FORWARD="yes"  # expose HOST_TCP_PORTS inside VM as localhost:PORT
DEFAULT_OC_PORT=4096                  # OpenCode web/API server port

# Self-update metadata
SCRIPT_NAME="opencode-vm.sh"
OCVM_VERSION="0.4.17"
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
KEEP_HISTORY=0

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing dependency: $1" >&2
    exit 1
  }
}

sanitize_lima_sock_dir() {
  # Lima can leave ~/.lima/sock/ behind without lima.yaml.
  # limactl may then treat it as a broken instance and fail fatally.
  if [[ -d "$HOME/.lima/sock" ]] && [[ ! -f "$HOME/.lima/sock/lima.yaml" ]]; then
    rm -rf "$HOME/.lima/sock" 2>/dev/null || true
  fi
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
  KEEP_HISTORY=0
  ON_EXISTING=""   # "", "reconnect", "fresh", "cancel"
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --port)   shift; SESSION_PORT="${1:?Missing port value}" ;;
      --port=*) SESSION_PORT="${1#*=}" ;;
      --password)   shift; SESSION_PASSWORD="${1:?Missing password value}" ;;
      --password=*) SESSION_PASSWORD="${1#*=}" ;;
      --tui) OC_WEB_TUI=true ;;
      --keep-history) KEEP_HISTORY=1 ;;
      --reconnect) ON_EXISTING="reconnect" ;;
      --fresh) ON_EXISTING="fresh" ;;
      --cancel-if-exists) ON_EXISTING="cancel" ;;
      *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
  done
}

parse_start_flags() {
  KEEP_HISTORY=0
  ON_EXISTING=""   # "", "reconnect", "fresh", "cancel"
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --keep-history) KEEP_HISTORY=1 ;;
      --reconnect) ON_EXISTING="reconnect" ;;
      --fresh) ON_EXISTING="fresh" ;;
      --cancel-if-exists) ON_EXISTING="cancel" ;;
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
  mkdir -p "$HOST_CFG_DIR" "$BACKUP_DIR" "$SESSIONS_DIR" "$PROJECT_STATE_DIR" "$PROJECT_HISTORY_DIR" "$FRESH_HISTORY_DIR"
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

project_history_dir() {
  echo "$PROJECT_HISTORY_DIR/$(proj_hash "$1")"
}

fresh_history_dir() {
  echo "$FRESH_HISTORY_DIR/$(proj_hash "$1")"
}

is_vm_running() {
  local vm_name="$1"
  sanitize_lima_sock_dir
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
HOST_LOCALHOST_FORWARD="$DEFAULT_HOST_LOCALHOST_FORWARD"
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
  : "${HOST_LOCALHOST_FORWARD:=$DEFAULT_HOST_LOCALHOST_FORWARD}"
}

save_policy() {
  cat > "$POLICY_ENV" <<EOF
# opencode-vm policy (host)
HOST_TCP_PORTS="$HOST_TCP_PORTS"
LAN_ALLOW_TCP="$LAN_ALLOW_TCP"
LAN_ALLOW_UDP="$LAN_ALLOW_UDP"
HOST_LOCALHOST_FORWARD="$HOST_LOCALHOST_FORWARD"
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
# ECC (everything-claude-code) integration — fully opt-in
# ---------------------------------------------------------------------------

ecc_load() {
  ECC_ENABLED=""
  ECC_REPO=""
  ECC_REF=""
  ECC_COMMIT=""
  ECC_MCP_PACK=""
  if [[ -f "$ECC_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$ECC_ENV"
  fi
  : "${ECC_REPO:=$DEFAULT_ECC_REPO}"
  : "${ECC_REF:=$DEFAULT_ECC_REF}"
}

ecc_save() {
  mkdir -p "$SHARE_ROOT"
  cat > "$ECC_ENV" <<EOF
# opencode-vm ECC integration (host)
ECC_ENABLED="${ECC_ENABLED:-0}"
ECC_REPO="${ECC_REPO:-$DEFAULT_ECC_REPO}"
ECC_REF="${ECC_REF:-$DEFAULT_ECC_REF}"
ECC_COMMIT="${ECC_COMMIT:-}"
ECC_MCP_PACK="${ECC_MCP_PACK:-0}"
EOF
}

ecc_enabled() {
  ecc_load
  [[ "${ECC_ENABLED:-0}" == "1" ]]
}

# Shallow clone/update primitive — used by ECC and Proxmox skill packs.
# Args: <dest_dir> <repo_url> <ref> <log_prefix>
# Echoes "[<prefix>] …" status lines. Returns non-zero on failure.
git_clone_or_update() {
  need git
  local dest="$1" repo="$2" ref="$3" prefix="$4"
  mkdir -p "$SHARE_ROOT"
  if [[ -d "$dest/.git" ]]; then
    echo "[$prefix] Updating clone at $dest (ref: $ref)"
    git -C "$dest" fetch --depth=1 origin "$ref" >/dev/null 2>&1 || {
      echo "[$prefix] Fetch failed; leaving existing clone in place." >&2
      return 1
    }
    git -C "$dest" checkout -q "FETCH_HEAD" || {
      echo "[$prefix] Checkout failed." >&2
      return 1
    }
  else
    echo "[$prefix] Cloning $repo (ref: $ref) into $dest"
    rm -rf "$dest"
    git clone --depth=1 --branch "$ref" "$repo" "$dest" >/dev/null 2>&1 || {
      echo "[$prefix] Clone failed (repo/ref: $repo @ $ref)" >&2
      return 1
    }
  fi
  return 0
}

ecc_clone_or_update() {
  ecc_load
  git_clone_or_update "$ECC_DIR" "$ECC_REPO" "$ECC_REF" "ecc" || return 1
  ECC_COMMIT="$(git -C "$ECC_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  ecc_save
  echo "[ecc] Ready at commit ${ECC_COMMIT:-unknown}"
}

# Copy ECC's .opencode/ payload into the session's config share.
# Called from start_session when ECC_ENABLED=1.
ecc_apply_to_session() {
  local sess_share="$1"
  ecc_load
  [[ "${ECC_ENABLED:-0}" == "1" ]] || return 0
  [[ -d "$ECC_DIR/.opencode" ]] || {
    echo "[ecc] Clone missing .opencode/ — run: opencode-vm skills on ecc-auto" >&2
    return 0
  }

  local dest="$sess_share/config/opencode"
  mkdir -p "$dest"

  # Copy payload subdirs that OpenCode understands.
  # Skip opencode.json (owned by user/session) and node_modules (rebuilt in-VM).
  local sub
  for sub in commands instructions plugins prompts tools; do
    if [[ -d "$ECC_DIR/.opencode/$sub" ]]; then
      rsync -a --delete \
        --exclude 'node_modules' \
        "$ECC_DIR/.opencode/$sub/" "$dest/$sub/"
    fi
  done

  # Copy plugin entry files (index.ts, package.json, tsconfig.json) if present.
  local f
  for f in index.ts package.json tsconfig.json; do
    [[ -f "$ECC_DIR/.opencode/$f" ]] && cp -p "$ECC_DIR/.opencode/$f" "$dest/$f"
  done

  # Write a marker so doctor / debugging can see what was applied.
  cat > "$dest/.ecc-applied" <<EOF
repo=$ECC_REPO
ref=$ECC_REF
commit=${ECC_COMMIT:-unknown}
applied=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

  echo "[ecc] Applied plugin payload to session config (commit ${ECC_COMMIT:-unknown})"
}

# Merge ECC's MCP pack into the session's opencode.json when the user opted in.
# Called from start_session after the existing jq overlay.
ecc_apply_mcp_pack() {
  local sess_cfg="$1"
  ecc_load
  [[ "${ECC_ENABLED:-0}" == "1" ]] || return 0
  [[ "${ECC_MCP_PACK:-0}" == "1" ]] || return 0

  local pack_file="$ECC_DIR/mcp-configs/mcp-servers.json"
  [[ -f "$pack_file" ]] || {
    echo "[ecc] MCP pack requested but $pack_file not found." >&2
    return 0
  }
  command -v jq >/dev/null 2>&1 || {
    echo "[ecc] jq missing; skipping MCP pack merge." >&2
    return 0
  }

  local tmp_cfg
  tmp_cfg="$(mktemp)"
  # Merge: existing session config wins on conflict, pack fills gaps.
  if jq -s '.[0] as $pack | .[1] as $cfg | $cfg * {"mcp": ($pack.mcp // $pack.mcpServers // {}) + ($cfg.mcp // {})}' \
       "$pack_file" "$sess_cfg" > "$tmp_cfg"; then
    mv "$tmp_cfg" "$sess_cfg"
    echo "[ecc] Merged MCP pack into session config"
  else
    rm -f "$tmp_cfg"
    echo "[ecc] MCP pack merge failed; session config unchanged." >&2
  fi
}

# 12-char sha256 hash of a project path — matches ECC's project ID scheme
# so the in-VM symlink name (~/.claude/homunculus/projects/<hash>) resolves
# correctly against ECC's lookups.
ecc_compute_project_hash() {
  local proj="$1"
  printf '%s' "$proj" | shasum -a 256 | cut -c1-12
}

# Seed the session-share homunculus dir from persistent project state.
# Called from start_session only when ECC is enabled.
ecc_seed_homunculus() {
  local proj_state="$1"
  local sess_share="$2"
  mkdir -p "$proj_state/homunculus" "$sess_share/homunculus"
  rsync -a "$proj_state/homunculus/" "$sess_share/homunculus/"
}

# Create the ~/.claude/homunculus/projects/<hash> symlink inside the running
# session VM, pointing at the mounted session-share homunculus dir.
ecc_link_homunculus_in_vm() {
  local sess_name="$1"
  local sess_share="$2"
  local ecc_hash="$3"
  limactl shell --workdir / "$sess_name" -- bash -lc "
    set -e
    mkdir -p \"\$HOME/.claude/homunculus/projects\"
    ln -sfn '$sess_share/homunculus' \"\$HOME/.claude/homunculus/projects/$ecc_hash\"
  " 2>/dev/null || echo "[ecc] Warning: failed to create homunculus symlink in VM" >&2
}

# Sync session-share homunculus back to persistent project state on session end.
ecc_sync_homunculus_back() {
  local sess_share="$1"
  local proj_state="$2"
  [[ -d "$sess_share/homunculus" ]] || return 0
  mkdir -p "$proj_state/homunculus"
  rsync -a "$sess_share/homunculus/" "$proj_state/homunculus/"
}

# ---------------------------------------------------------------------------
# Proxmox MCP package — opt-in via `opencode-vm mcps on proxmox`
# Ships both the knowledge skill (bundled SKILL.md, mounted via mcps.skill_doc)
# and the ProxmoxMCP server. Credentials live in $PROXMOX_ENV (mode 0600);
# `mcps off proxmox` wipes them.
# ---------------------------------------------------------------------------

proxmox_load() {
  PROXMOX_HOST=""
  PROXMOX_PORT=""
  PROXMOX_USER=""
  PROXMOX_TOKEN_NAME=""
  PROXMOX_TOKEN_VALUE=""
  PROXMOX_VERIFY_SSL=""
  PROXMOX_MCP_REPO=""
  PROXMOX_MCP_REF=""
  PROXMOX_MCP_COMMIT=""
  if [[ -f "$PROXMOX_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$PROXMOX_ENV"
  fi
  : "${PROXMOX_PORT:=8006}"
  : "${PROXMOX_MCP_REPO:=$DEFAULT_PROXMOX_MCP_REPO}"
  : "${PROXMOX_MCP_REF:=$DEFAULT_PROXMOX_MCP_REF}"
  : "${PROXMOX_VERIFY_SSL:=0}"
  return 0
}

proxmox_save() {
  mkdir -p "$SHARE_ROOT"
  umask 077
  cat > "$PROXMOX_ENV" <<EOF
# opencode-vm Proxmox integration — credentials, mode 0600.
# Wiped automatically by: opencode-vm mcps off proxmox
PROXMOX_HOST="${PROXMOX_HOST:-}"
PROXMOX_PORT="${PROXMOX_PORT:-8006}"
PROXMOX_USER="${PROXMOX_USER:-}"
PROXMOX_TOKEN_NAME="${PROXMOX_TOKEN_NAME:-}"
PROXMOX_TOKEN_VALUE="${PROXMOX_TOKEN_VALUE:-}"
PROXMOX_VERIFY_SSL="${PROXMOX_VERIFY_SSL:-0}"
PROXMOX_MCP_REPO="${PROXMOX_MCP_REPO:-$DEFAULT_PROXMOX_MCP_REPO}"
PROXMOX_MCP_REF="${PROXMOX_MCP_REF:-$DEFAULT_PROXMOX_MCP_REF}"
PROXMOX_MCP_COMMIT="${PROXMOX_MCP_COMMIT:-}"
EOF
  chmod 600 "$PROXMOX_ENV"
  umask 022
}

proxmox_wipe_env() {
  [[ -f "$PROXMOX_ENV" ]] || return 0
  rm -f "$PROXMOX_ENV"
  echo "[proxmox] Credentials wiped ($PROXMOX_ENV removed)"
}

# Prompt interactively for host/user/token. Called by skills_pkg_on when
# pkg=proxmox and no credentials are persisted yet.
proxmox_setup_interactive() {
  proxmox_load
  if [[ ! -t 0 ]]; then
    echo "[proxmox] Interactive setup requires a TTY. Aborting." >&2
    return 1
  fi
  echo "[proxmox] First-time setup — I need your Proxmox API token."
  echo "  Create one in the PVE UI:"
  echo "    Datacenter → Permissions → Users       → Add 'automation@pve'"
  echo "    Datacenter → Permissions → API Tokens  → Add 'automation@pve!claude'"
  echo "    Datacenter → Permissions → Add         → Path=/ User=automation@pve Role=PVEAdmin"
  echo
  local host port user tname tval tls_in tls
  read -r -p "Host (IP or FQDN):            " host
  [[ -n "$host" ]] || { echo "[proxmox] Host is required." >&2; return 1; }
  read -r -p "Port [8006]:                  " port
  port="${port:-8006}"
  read -r -p "User [automation@pve]:        " user
  user="${user:-automation@pve}"
  read -r -p "Token name (e.g. claude):     " tname
  [[ -n "$tname" ]] || { echo "[proxmox] Token name is required." >&2; return 1; }
  read -r -s -p "Token value (hidden):         " tval
  echo
  [[ -n "$tval" ]] || { echo "[proxmox] Token value is required." >&2; return 1; }
  read -r -p "Verify TLS? [y/N]:            " tls_in
  case "$tls_in" in y|Y|yes|YES) tls=1 ;; *) tls=0 ;; esac

  PROXMOX_HOST="$host"
  PROXMOX_PORT="$port"
  PROXMOX_USER="$user"
  PROXMOX_TOKEN_NAME="$tname"
  PROXMOX_TOKEN_VALUE="$tval"
  PROXMOX_VERIFY_SSL="$tls"
  proxmox_save
  echo "[proxmox] Saved to $PROXMOX_ENV (mode 0600)"
  proxmox_autoallow_lan || true
}

# If the configured Proxmox host is on an RFC1918 private network, append its
# IP:PORT to LAN_ALLOW_TCP so the base VM's nftables egress filter doesn't drop
# the connection. No-op for public hosts or when the endpoint is already listed.
proxmox_autoallow_lan() {
  local host="${PROXMOX_HOST:-}" port="${PROXMOX_PORT:-8006}" ip=""
  [[ -n "$host" ]] || return 0
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    ip="$host"
  else
    ip="$(getent hosts "$host" 2>/dev/null | awk '{print $1; exit}')"
    [[ -z "$ip" ]] && ip="$(dscacheutil -q host -a name "$host" 2>/dev/null | awk '/ip_address:/ {print $2; exit}')"
  fi
  [[ "$ip" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]] || return 0
  load_policy
  local ep="$ip:$port"
  case " $LAN_ALLOW_TCP " in
    *" $ep "*|*" $ip "*) return 0 ;;
  esac
  LAN_ALLOW_TCP="$(list_add "$ep" $LAN_ALLOW_TCP)"
  save_policy
  echo "[proxmox] Added LAN allow rule for $ep (private network — needed for egress)."
}

# Clone/update the ProxmoxMCP server repo (host side — for visibility/doctor).
# The in-VM install is handled separately by proxmox_ensure_installed_in_base.
proxmox_mcp_clone_or_update() {
  proxmox_load
  git_clone_or_update "$PROXMOX_MCP_DIR" "$PROXMOX_MCP_REPO" "$PROXMOX_MCP_REF" "proxmox" || return 1
  PROXMOX_MCP_COMMIT="$(git -C "$PROXMOX_MCP_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  proxmox_save
  echo "[proxmox] MCP server ready at commit ${PROXMOX_MCP_COMMIT:-unknown}"
}

VM_HOME_CACHE=""
vm_resolve_home() {
  [[ -n "$VM_HOME_CACHE" ]] && { printf '%s' "$VM_HOME_CACHE"; return 0; }
  local vm="${1:-$BASE_NAME}" home=""
  if is_vm_running "$vm"; then
    home="$(limactl shell --workdir / "$vm" -- bash -lc 'printf %s "$HOME"' 2>/dev/null | tr -d '\r\n')"
  fi
  if [[ -z "$home" || "$home" != /home/* ]]; then
    home="/home/$(whoami).linux"
    echo "[vm] Warning: could not resolve VM \$HOME; falling back to $home" >&2
  fi
  VM_HOME_CACHE="$home"
  printf '%s' "$home"
}

# Install ProxmoxMCP into the BASE VM so that every session clone inherits the
# ready-to-run venv. Idempotent: skips when the venv already exists. Called
# from start_session right before the base VM is stopped for cloning.
proxmox_ensure_installed_in_base() {
  mcps_pkg_is_active proxmox || return 0
  [[ -f "$PROXMOX_ENV" ]] || return 0
  proxmox_load
  local venv_path='$HOME/.local/share/proxmox-mcp-venv'
  local src_path='$HOME/.local/share/proxmox-mcp'
  local ref="${PROXMOX_MCP_REF:-main}"
  local repo="${PROXMOX_MCP_REPO:-$DEFAULT_PROXMOX_MCP_REPO}"
  # Install-recipe version. Bump this when the install steps change (e.g. to
  # pin a different mcp SDK version). Existing venvs without this stamp are
  # wiped and reinstalled.
  local install_stamp_version="2"
  local stamp_path="$venv_path/.ocvm-proxmox-install-v$install_stamp_version"

  # Skip only when the stamp for the current recipe version is present.
  if limactl shell --workdir / "$BASE_NAME" -- bash -lc "test -f $stamp_path" 2>/dev/null; then
    return 0
  fi

  # Need the base VM running for the install. Start if stopped.
  local started_base=0
  if ! is_vm_running "$BASE_NAME"; then
    run_with_spinner "[proxmox] Starting base VM to install MCP server..." limactl start "$BASE_NAME" || {
      echo "[proxmox] Could not start base VM; MCP will not be available this session." >&2
      return 1
    }
    started_base=1
  fi

  echo "[proxmox] Installing ProxmoxMCP into base VM (first-run only, ~20-40s)..."
  # ProxmoxMCP's pyproject.toml pins `mcp @ git+.../python-sdk.git` (main),
  # which currently removes the `mcp.server.fastmcp` module ProxmoxMCP imports.
  # We force-install the last released `mcp` that still ships FastMCP.
  local mcp_sdk_pin="mcp==1.27.0"
  limactl shell --workdir / "$BASE_NAME" -- bash -lc "
    set -euo pipefail
    mkdir -p \$HOME/.local/share
    if [[ ! -d $src_path/.git ]]; then
      git clone --depth=1 --branch '$ref' '$repo' $src_path
    else
      git -C $src_path fetch --depth=1 origin '$ref' >/dev/null 2>&1 || true
      git -C $src_path checkout -q FETCH_HEAD 2>/dev/null || true
    fi
    rm -rf $venv_path
    python3 -m venv $venv_path
    $venv_path/bin/pip install --quiet --upgrade pip
    $venv_path/bin/pip install --quiet -e $src_path
    $venv_path/bin/pip install --quiet --force-reinstall '$mcp_sdk_pin'
    $venv_path/bin/python -c 'from mcp.server.fastmcp import FastMCP'
    touch $stamp_path
  " || {
    echo "[proxmox] MCP install failed. See VM log; disable with 'opencode-vm mcps off proxmox'." >&2
    (( started_base == 1 )) && limactl stop "$BASE_NAME" 2>/dev/null || true
    return 1
  }
  echo "[proxmox] MCP server installed at $venv_path"

  if (( started_base == 1 )); then
    limactl stop "$BASE_NAME" 2>/dev/null || true
  fi
}

# Resolve skill source dir: prefer bundled skills/proxmox next to the script,
# fall back to a shallow clone of the OCVM repo fetching only skills/proxmox/.
proxmox_skill_ensure() {
  local bundled="$SCRIPT_DIR/skills/proxmox"
  if [[ -d "$bundled" ]]; then
    echo "$bundled"
    return 0
  fi
  # Fetch from the OCVM repo when running from an installed (single-file) copy.
  local raw_repo="https://github.com/${OCVM_UPDATE_REPO}.git"
  if [[ ! -d "$PROXMOX_SKILL_CACHE/.git" ]]; then
    echo "[proxmox] Fetching bundled skill content from $OCVM_UPDATE_REPO …" >&2
    rm -rf "$PROXMOX_SKILL_CACHE"
    git clone --depth=1 --filter=blob:none --sparse \
      --branch "$OCVM_UPDATE_BRANCH" "$raw_repo" "$PROXMOX_SKILL_CACHE" >/dev/null 2>&1 || {
      echo "[proxmox] Failed to clone $raw_repo for skill content." >&2
      return 1
    }
    git -C "$PROXMOX_SKILL_CACHE" sparse-checkout set skills/proxmox >/dev/null 2>&1 || {
      echo "[proxmox] sparse-checkout failed for skills/proxmox." >&2
      return 1
    }
  else
    git -C "$PROXMOX_SKILL_CACHE" fetch --depth=1 origin "$OCVM_UPDATE_BRANCH" >/dev/null 2>&1 || true
    git -C "$PROXMOX_SKILL_CACHE" checkout -q FETCH_HEAD 2>/dev/null || true
  fi
  echo "$PROXMOX_SKILL_CACHE/skills/proxmox"
}

# Resolve webimg skill source: prefer bundled skills/web-image-pipeline next to
# the script, fall back to a shallow clone of the OCVM repo.
webimg_skill_ensure() {
  local bundled="$SCRIPT_DIR/skills/web-image-pipeline"
  if [[ -d "$bundled" ]]; then
    echo "$bundled"
    return 0
  fi
  local raw_repo="https://github.com/${OCVM_UPDATE_REPO}.git"
  if [[ ! -d "$WEBIMG_SKILL_CACHE/.git" ]]; then
    echo "[webimg] Fetching bundled skill content from $OCVM_UPDATE_REPO ..." >&2
    rm -rf "$WEBIMG_SKILL_CACHE"
    git clone --depth=1 --filter=blob:none --sparse \
      --branch "$OCVM_UPDATE_BRANCH" "$raw_repo" "$WEBIMG_SKILL_CACHE" >/dev/null 2>&1 || {
      echo "[webimg] Failed to clone $raw_repo for skill content." >&2
      return 1
    }
    git -C "$WEBIMG_SKILL_CACHE" sparse-checkout set skills/web-image-pipeline >/dev/null 2>&1 || {
      echo "[webimg] sparse-checkout failed for skills/web-image-pipeline." >&2
      return 1
    }
  else
    git -C "$WEBIMG_SKILL_CACHE" fetch --depth=1 origin "$OCVM_UPDATE_BRANCH" >/dev/null 2>&1 || true
    git -C "$WEBIMG_SKILL_CACHE" checkout -q FETCH_HEAD 2>/dev/null || true
  fi
  echo "$WEBIMG_SKILL_CACHE/skills/web-image-pipeline"
}

# Resolve ssh-toolkit skill source: prefer bundled skills/ssh-toolkit next to
# the script, fall back to a shallow clone of the OCVM repo.
ssh_toolkit_skill_ensure() {
  local bundled="$SCRIPT_DIR/skills/ssh-toolkit"
  if [[ -d "$bundled" ]]; then
    echo "$bundled"
    return 0
  fi
  local raw_repo="https://github.com/${OCVM_UPDATE_REPO}.git"
  if [[ ! -d "$SSH_SKILL_CACHE/.git" ]]; then
    echo "[ssh-toolkit] Fetching bundled skill content from $OCVM_UPDATE_REPO ..." >&2
    rm -rf "$SSH_SKILL_CACHE"
    git clone --depth=1 --filter=blob:none --sparse \
      --branch "$OCVM_UPDATE_BRANCH" "$raw_repo" "$SSH_SKILL_CACHE" >/dev/null 2>&1 || {
      echo "[ssh-toolkit] Failed to clone $raw_repo for skill content." >&2
      return 1
    }
    git -C "$SSH_SKILL_CACHE" sparse-checkout set skills/ssh-toolkit >/dev/null 2>&1 || {
      echo "[ssh-toolkit] sparse-checkout failed for skills/ssh-toolkit." >&2
      return 1
    }
  else
    git -C "$SSH_SKILL_CACHE" fetch --depth=1 origin "$OCVM_UPDATE_BRANCH" >/dev/null 2>&1 || true
    git -C "$SSH_SKILL_CACHE" checkout -q FETCH_HEAD 2>/dev/null || true
  fi
  echo "$SSH_SKILL_CACHE/skills/ssh-toolkit"
}

# ---------------------------------------------------------------------------
# Project language detector — shared by Rules and Skills
# ---------------------------------------------------------------------------

# Emits a space-separated list of language slugs that match ECC's rules/<lang>/
# directory names. `common` is always appended. Reads only project root +
# first-level subdirs for speed; no recursion into node_modules / vendor / etc.
detect_project_languages() {
  local proj="$1"
  local langs=""
  _add() { case " $langs " in *" $1 "*) ;; *) langs="$langs $1" ;; esac; }

  # Scan a single directory's root for language markers.
  _scan_one_dir() {
    local d="$1"
    [[ -d "$d" ]] || return 0
    if [[ -f "$d/package.json" || -f "$d/tsconfig.json" ]]; then
      _add typescript
    fi
    [[ -f "$d/go.mod" ]] && _add golang
    [[ -f "$d/Cargo.toml" ]] && _add rust
    if [[ -f "$d/requirements.txt" || -f "$d/pyproject.toml" || -f "$d/setup.py" ]]; then
      _add python
    fi
    [[ -f "$d/composer.json" ]] && _add php
    if [[ -f "$d/pom.xml" || -f "$d/build.gradle" ]]; then
      _add java
    fi
    [[ -f "$d/build.gradle.kts" ]] && _add kotlin
    [[ -f "$d/Package.swift" ]] && _add swift
    if ls "$d"/*.csproj "$d"/*.sln >/dev/null 2>&1; then
      _add csharp
    fi
    [[ -f "$d/CMakeLists.txt" ]] && _add cpp
    [[ -f "$d/pubspec.yaml" ]] && _add dart
    if [[ -f "$d/index.html" || -f "$d/tailwind.config.js" || -f "$d/tailwind.config.ts" ]]; then
      _add web
    fi
  }

  # Always scan the root project dir.
  _scan_one_dir "$proj"

  # If mcrepo.yaml exists, scan each listed repo subdirectory as well.
  # Parses `name:` entries under a top-level `repos:` block — no yq dependency.
  if [[ -f "$proj/mcrepo.yaml" ]]; then
    local repo_name
    while IFS= read -r repo_name; do
      [[ -n "$repo_name" ]] || continue
      _scan_one_dir "$proj/$repo_name"
    done < <(awk '
      /^repos:[[:space:]]*$/        { in_repos = 1; next }
      in_repos && /^[^[:space:]-]/  { in_repos = 0 }
      in_repos && /name:[[:space:]]*/ {
        sub(/.*name:[[:space:]]*/, "")
        gsub(/["'\'']/, "")
        sub(/[[:space:]]*#.*$/, "")
        gsub(/[[:space:]]+$/, "")
        if (length($0) > 0) print $0
      }
    ' "$proj/mcrepo.yaml")
  fi

  _add common
  echo "${langs# }"
  unset -f _add _scan_one_dir
}

# ---------------------------------------------------------------------------
# Rules auto-inject (ECC-gated) — appends per-language rules to session AGENTS.md
# ---------------------------------------------------------------------------

# Stage ECC rules matching detected languages into a separate sidecar file.
# Host-side: writes to $sess_share/config/opencode/AGENTS.ecc-rules.md — the
# VM-side AGENTS.md composition block then appends it after its own content,
# so this doesn't get overwritten by the VM's cp -p of $HOME/AGENTS.md.
ecc_inject_rules() {
  local proj="$1"
  local sess_share="$2"
  ecc_enabled || return 0
  [[ -d "$ECC_DIR/rules" ]] || return 0

  local langs
  langs="$(detect_project_languages "$proj")"
  [[ -n "$langs" ]] || return 0

  local sidecar="$sess_share/config/opencode/AGENTS.ecc-rules.md"
  mkdir -p "$(dirname "$sidecar")"

  {
    echo ""
    echo "## ECC Rules (auto-injected: $langs)"
    echo ""
    local lang
    for lang in $langs; do
      local dir="$ECC_DIR/rules/$lang"
      [[ -d "$dir" ]] || continue
      local f
      for f in "$dir"/*.md; do
        [[ -f "$f" ]] || continue
        echo "<!-- rules/$lang/$(basename "$f") -->"
        cat "$f"
        echo ""
      done
    done
  } > "$sidecar"

  # Cache detected languages per session (reused by skills mount + doctor)
  echo "$langs" > "$sess_share/ecc-langs"
  echo "[ecc] Rules prepared for: $langs"
}

# ---------------------------------------------------------------------------
# Skills subsystem — registry-driven since v0.4.5
# Source of truth: skills/registry.json (bundled alongside the script, or
# fetched from upstream on demand).
# ---------------------------------------------------------------------------

_skills_registry_path() {
  local bundled="$SCRIPT_DIR/skills/registry.json"
  if [[ -f "$bundled" ]]; then
    echo "$bundled"
    return 0
  fi
  if [[ -f "$SKILLS_REGISTRY_CACHE/skills/registry.json" ]]; then
    echo "$SKILLS_REGISTRY_CACHE/skills/registry.json"
    return 0
  fi
  return 1
}

skills_registry_ensure() {
  local bundled="$SCRIPT_DIR/skills/registry.json"
  [[ -f "$bundled" ]] && return 0
  local raw_repo="https://github.com/$OCVM_UPDATE_REPO.git"
  if [[ ! -d "$SKILLS_REGISTRY_CACHE/.git" ]]; then
    mkdir -p "$(dirname "$SKILLS_REGISTRY_CACHE")"
    rm -rf "$SKILLS_REGISTRY_CACHE"
    git clone --depth=1 --filter=blob:none --sparse \
      --branch "$OCVM_UPDATE_BRANCH" "$raw_repo" "$SKILLS_REGISTRY_CACHE" >/dev/null 2>&1 || {
      echo "[skills] Could not fetch registry from $raw_repo" >&2
      return 1
    }
    git -C "$SKILLS_REGISTRY_CACHE" sparse-checkout set skills >/dev/null 2>&1 || {
      echo "[skills] sparse-checkout failed" >&2
      return 1
    }
  else
    git -C "$SKILLS_REGISTRY_CACHE" fetch --depth=1 origin "$OCVM_UPDATE_BRANCH" >/dev/null 2>&1 || true
    git -C "$SKILLS_REGISTRY_CACHE" checkout -q FETCH_HEAD 2>/dev/null || true
  fi
  [[ -f "$SKILLS_REGISTRY_CACHE/skills/registry.json" ]]
}

_skills_registry_read() {
  local reg
  reg="$(_skills_registry_path 2>/dev/null)" || {
    skills_registry_ensure >/dev/null || return 1
    reg="$(_skills_registry_path 2>/dev/null)" || return 1
  }
  echo "$reg"
}

skills_registry_has() {
  local reg; reg="$(_skills_registry_read)" || return 1
  jq -e --arg n "$1" '.skills[$n]' "$reg" >/dev/null 2>&1
}

skills_registry_field() {
  # $1=pkg, $2=jq filter appended to .skills[$n]
  local reg; reg="$(_skills_registry_read)" || return 1
  jq -r --arg n "$1" ".skills[\$n]$2 // empty" "$reg" 2>/dev/null
}

skills_registry_list() {
  local reg; reg="$(_skills_registry_read)" || return 0
  jq -r '.skills | to_entries[] | "\(.key)\t\(.value.default_active)\t\(.value.always_active // false)\t\(.value.description)"' "$reg"
}

# Emit space-separated package names that have always_active: true.
skills_registry_always_active() {
  local reg; reg="$(_skills_registry_read)" || return 0
  jq -r '.skills | to_entries[] | select(.value.always_active == true) | .key' "$reg"
}

# Emit newline-separated package names that have default_active: true.
# Used by skills_load to seed SKILLS_PACKAGES on first use.
skills_registry_defaults() {
  local reg; reg="$(_skills_registry_read 2>/dev/null)" || return 0
  jq -r '.skills | to_entries[] | select(.value.default_active == true) | .key' "$reg"
}

skills_load() {
  SKILLS_PACKAGES=""
  SKILLS_MIGRATED_WEBIMG=""
  SKILLS_MIGRATED_SSHTK=""
  local dirty=0
  if [[ -f "$SKILLS_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$SKILLS_ENV"
  else
    # First use: seed all default_active packages from the registry.
    local def defs=""
    while IFS= read -r def; do
      [[ -n "$def" ]] || continue
      defs="${defs:+$defs }$def"
    done < <(skills_registry_defaults 2>/dev/null)
    SKILLS_PACKAGES="$defs"
    SKILLS_MIGRATED_WEBIMG=1
    SKILLS_MIGRATED_SSHTK=1
    dirty=1
  fi

  # Legacy cleanup: 'proxmox' moved to the mcps subsystem in v0.4.4.
  case " ${SKILLS_PACKAGES:-} " in
    *" proxmox "*)
      _skills_pkg_drop proxmox
      dirty=1
      ;;
  esac

  # Migration (v0.4.6): webimg was always_active in v0.4.2–v0.4.5. It is now a
  # default_active package — users may turn it off. Backfill webimg once for
  # existing state files so previous behaviour is preserved by default.
  if [[ "${SKILLS_MIGRATED_WEBIMG:-}" != "1" ]]; then
    case " ${SKILLS_PACKAGES:-} " in
      *" webimg "*) ;;
      *)
        SKILLS_PACKAGES="${SKILLS_PACKAGES:+$SKILLS_PACKAGES }webimg"
        ;;
    esac
    SKILLS_MIGRATED_WEBIMG=1
    dirty=1
  fi

  # Migration (v0.4.14): ssh-toolkit was added as default_active. Backfill
  # once for existing state files so the new SSH/network knowledge surfaces
  # for upgrading users without requiring a manual `skills on ssh-toolkit`.
  if [[ "${SKILLS_MIGRATED_SSHTK:-}" != "1" ]]; then
    case " ${SKILLS_PACKAGES:-} " in
      *" ssh-toolkit "*) ;;
      *)
        SKILLS_PACKAGES="${SKILLS_PACKAGES:+$SKILLS_PACKAGES }ssh-toolkit"
        ;;
    esac
    SKILLS_MIGRATED_SSHTK=1
    dirty=1
  fi

  (( dirty == 1 )) && skills_save
  return 0
}

skills_save() {
  mkdir -p "$SHARE_ROOT"
  cat > "$SKILLS_ENV" <<EOF
# opencode-vm skills subsystem
# space-separated list of active package names
SKILLS_PACKAGES="${SKILLS_PACKAGES:-}"
SKILLS_MIGRATED_WEBIMG="${SKILLS_MIGRATED_WEBIMG:-1}"
SKILLS_MIGRATED_SSHTK="${SKILLS_MIGRATED_SSHTK:-1}"
EOF
}

skills_pkg_is_active() {
  skills_load
  case " ${SKILLS_PACKAGES:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# Internal: remove $1 from SKILLS_PACKAGES (no save).
_skills_pkg_drop() {
  local pkg="$1" new=""
  local p
  for p in ${SKILLS_PACKAGES:-}; do
    [[ "$p" == "$pkg" ]] || new="$new $p"
  done
  SKILLS_PACKAGES="${new# }"
}

skills_pkg_on() {
  local pkg="$1"
  if [[ "$pkg" == "proxmox" ]]; then
    echo "[skills] 'proxmox' is now an MCP, not a skill." >&2
    echo "         Run instead: opencode-vm mcps on proxmox" >&2
    return 2
  fi
  if ! skills_registry_has "$pkg"; then
    local reg available=""
    if reg="$(_skills_registry_read 2>/dev/null)"; then
      available="$(jq -r '.skills | keys | join(", ")' "$reg" 2>/dev/null || true)"
    fi
    echo "[skills] Unknown package: '$pkg'. Available: ${available:-<registry unavailable>}" >&2
    return 2
  fi
  skills_load

  # Resolver-specific setup (auto-clone, cache seed)
  local rtype
  rtype="$(skills_registry_field "$pkg" ".resolver")"
  case "$rtype" in
    ecc_filtered|ecc_all)
      ecc_load
      if [[ ! -d "$ECC_DIR/.git" ]]; then
        echo "[skills] '$pkg' needs ECC — fetching clone now…"
        ecc_clone_or_update || {
          echo "[skills] ECC clone failed; package not enabled." >&2
          return 1
        }
      fi
      ECC_ENABLED=1
      ecc_save
      ;;
    single_bundled)
      # Bundled skills with their own ensure-hook for the ~/bin install path.
      case "$pkg" in
        webimg)      webimg_skill_ensure >/dev/null || return 1 ;;
        ssh-toolkit) ssh_toolkit_skill_ensure >/dev/null || return 1 ;;
      esac
      ;;
  esac

  # Mutual exclusion from registry. skills_pkg_is_active re-runs skills_load
  # which would clobber our in-memory drops, so iterate against the local copy.
  local other _active_snapshot=" ${SKILLS_PACKAGES:-} "
  local excl_changed=0
  while IFS= read -r other; do
    [[ -n "$other" ]] || continue
    case "$_active_snapshot" in
      *" $other "*)
        _skills_pkg_drop "$other"
        _active_snapshot=" ${SKILLS_PACKAGES:-} "
        excl_changed=1
        echo "[skills] Disabled '$other' (superseded by '$pkg')."
        ;;
    esac
  done < <(skills_registry_field "$pkg" ".mutually_exclusive_with[]?")
  (( excl_changed == 1 )) && skills_save

  case " ${SKILLS_PACKAGES:-} " in
    *" $pkg "*)
      echo "[skills] '$pkg' is already active."
      ;;
    *)
      SKILLS_PACKAGES="${SKILLS_PACKAGES:+$SKILLS_PACKAGES }$pkg"
      skills_save
      echo "[skills] Enabled '$pkg'. Restart session to apply."
      if [[ "$pkg" == "ecc-all" ]]; then
        echo "[skills] WARNING: ecc-all mounts ~180 skills (~10–15k tokens of frontmatter)."
        echo "[skills]          Suitable only for 128k+ context models."
      fi
      ;;
  esac
}

skills_pkg_off() {
  local pkg="$1"
  if [[ "$pkg" == "proxmox" ]]; then
    echo "[skills] 'proxmox' is now an MCP, not a skill." >&2
    echo "         Run instead: opencode-vm mcps off proxmox" >&2
    return 2
  fi
  skills_load
  if skills_pkg_is_active "$pkg"; then
    _skills_pkg_drop "$pkg"
    skills_save
    echo "[skills] Disabled '$pkg'. Restart session to apply."
    # ECC: if no ecc-* package is active anymore, disable the plugin payload.
    if [[ "$pkg" == "ecc-auto" || "$pkg" == "ecc-all" ]] \
       && ! skills_pkg_is_active ecc-auto && ! skills_pkg_is_active ecc-all; then
      ecc_load
      ECC_ENABLED=0
      ecc_save
      echo "[skills] No ECC skills active — ECC plugin payload disabled for future sessions."
      echo "         Clone at $ECC_DIR left intact."
    fi
  else
    echo "[skills] '$pkg' is not active."
  fi
}

# Resolve a resolver=ecc_filtered package: returns newline-separated skill
# dir names under $ECC_DIR/skills/ that match the package's universal whitelist
# or any configured language-prefix (read from skills/registry.json).
# $1 = detected languages (space-separated)
# $2 = package name (optional; defaults to "ecc-auto")
skills_resolve_ecc_filtered() {
  local langs="$1"
  local pkg="${2:-ecc-auto}"
  [[ -d "$ECC_DIR/skills" ]] || return 0

  local reg; reg="$(_skills_registry_read 2>/dev/null)" || return 0

  local available
  available="$(find "$ECC_DIR/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort -u)"
  [[ -n "$available" ]] || return 0

  local uwl exclude
  uwl="$(jq -r --arg n "$pkg" '.skills[$n].filter.universal_whitelist[]? // empty' "$reg")"
  exclude="$(jq -r --arg n "$pkg" '.skills[$n].filter.exclude[]? // empty' "$reg")"

  local pfx_all="" lang pfxs
  for lang in $langs; do
    pfxs="$(jq -r --arg n "$pkg" --arg lang "$lang" \
      '.skills[$n].filter.language_prefixes[$lang][]? // empty' "$reg")"
    while IFS= read -r p; do
      [[ -n "$p" ]] && pfx_all="$pfx_all $p"
    done <<< "$pfxs"
  done

  local name p match
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if [[ -n "$exclude" ]] && printf '%s\n' "$exclude" | grep -qx "$name"; then
      continue
    fi
    if printf '%s\n' "$uwl" | grep -qx "$name"; then
      echo "$name"; continue
    fi
    match=0
    for p in $pfx_all; do
      [[ -n "$p" ]] || continue
      case "$name" in "$p"*) match=1; break ;; esac
    done
    (( match == 1 )) && echo "$name"
  done <<< "$available"
  return 0
}

# Resolve a resolver=ecc_all package: every dir under $ECC_DIR/skills/ except
# entries in the package's exclude list (from registry).
# $1 = package name (optional; defaults to "ecc-all")
skills_resolve_ecc_all_pkg() {
  local pkg="${1:-ecc-all}"
  [[ -d "$ECC_DIR/skills" ]] || return 0
  local reg; reg="$(_skills_registry_read 2>/dev/null)" || {
    find "$ECC_DIR/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort -u
    return 0
  }
  local exclude
  exclude="$(jq -r --arg n "$pkg" '.skills[$n].filter.exclude[]? // empty' "$reg")"

  local all name
  all="$(find "$ECC_DIR/skills" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort -u)"
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if [[ -n "$exclude" ]] && printf '%s\n' "$exclude" | grep -qx "$name"; then
      continue
    fi
    echo "$name"
  done <<< "$all"
  return 0
}

# Generic resolver dispatch by registry-declared resolver type.
# $1 = package name, $2 = detected langs (needed only for ecc_filtered)
skills_resolve_pkg() {
  local pkg="$1"
  local langs="${2:-}"
  local rtype
  rtype="$(skills_registry_field "$pkg" ".resolver")"
  case "$rtype" in
    ecc_filtered)   skills_resolve_ecc_filtered "$langs" "$pkg" ;;
    ecc_all)        skills_resolve_ecc_all_pkg "$pkg" ;;
    single_bundled) skills_resolve_single_bundled "$pkg" ;;
    *)              return 0 ;;  # unknown or unresolved → empty
  esac
}

# Back-compat aliases (kept so older call sites continue to work).
skills_resolve_ecc_auto() { skills_resolve_ecc_filtered "$1" ecc-auto; }
skills_resolve_ecc_all()  { skills_resolve_ecc_all_pkg     ecc-all; }

# Resolve a single_bundled skill: reads skill_dir_name from the registry.
# Works for any package with resolver=single_bundled (today: webimg).
skills_resolve_single_bundled() {
  local pkg="$1"
  local name
  name="$(skills_registry_field "$pkg" ".skill_dir_name")"
  [[ -n "$name" ]] && echo "$name"
}

# Backwards-compatible shim for webimg (doctor/skills list call this directly).
skills_resolve_webimg() {
  skills_resolve_single_bundled webimg
}

# For a given package, echo the absolute path to the parent dir containing
# the skill subdirectories (e.g. ECC: $ECC_DIR/skills, Proxmox: bundled or cache).
skills_source_root_for() {
  case "$1" in
    ecc-auto|ecc-all) echo "$ECC_DIR/skills" ;;
    webimg)
      local bundled="$SCRIPT_DIR/skills"
      if [[ -d "$bundled/web-image-pipeline" ]]; then
        echo "$bundled"
      else
        echo "$WEBIMG_SKILL_CACHE/skills"
      fi
      ;;
    ssh-toolkit)
      local bundled="$SCRIPT_DIR/skills"
      if [[ -d "$bundled/ssh-toolkit" ]]; then
        echo "$bundled"
      else
        echo "$SSH_SKILL_CACHE/skills"
      fi
      ;;
    *) return 1 ;;
  esac
}

# Mount resolved skills for every active package into the session share.
# Writes $sess_share/skills-manifest.txt listing <pkg>/<skill> pairs.
skills_mount_for_session() {
  local sess_share="$1"
  local proj="$2"
  skills_load

  # Always-active packages (from registry) are mounted regardless of SKILLS_PACKAGES.
  local all_pkgs="${SKILLS_PACKAGES:-}"
  local _always
  while IFS= read -r _always; do
    [[ -n "$_always" ]] || continue
    case " $all_pkgs " in *" $_always "*) ;; *) all_pkgs="${all_pkgs:+$all_pkgs }$_always" ;; esac
  done < <(skills_registry_always_active)

  [[ -n "$all_pkgs" ]] || return 0

  local langs
  if [[ -f "$sess_share/ecc-langs" ]]; then
    langs="$(cat "$sess_share/ecc-langs")"
  else
    langs="$(detect_project_languages "$proj")"
  fi

  local dest_root="$sess_share/config/opencode/skills"
  local manifest="$sess_share/skills-manifest.txt"
  mkdir -p "$dest_root"
  : > "$manifest"

  local pkg
  for pkg in $all_pkgs; do
    [[ "$pkg" == "proxmox" ]] && continue   # legacy v0.4.3 state; now an MCP
    local names="" rtype
    rtype="$(skills_registry_field "$pkg" ".resolver")"
    case "$rtype" in
      ecc_filtered)   names="$(skills_resolve_ecc_filtered "$langs" "$pkg")" ;;
      ecc_all)        names="$(skills_resolve_ecc_all_pkg "$pkg")" ;;
      single_bundled) names="$(skills_resolve_single_bundled "$pkg")" ;;
      *)
        echo "[skills] Unknown active package '$pkg' (no resolver in registry) — skipping." >&2
        continue
        ;;
    esac
    [[ -n "$names" ]] || continue

    local src_root
    src_root="$(skills_source_root_for "$pkg" 2>/dev/null)" || continue
    # For bundled skill packs: refresh the cache if the bundled dir isn't available.
    if [[ "$rtype" == "single_bundled" ]]; then
      local _dir_name
      _dir_name="$(skills_registry_field "$pkg" ".skill_dir_name")"
      if [[ -n "$_dir_name" && ! -d "$src_root/$_dir_name" ]]; then
        # Bundled skills with their own ensure-hook for the ~/bin install path.
        case "$pkg" in
          webimg)
            webimg_skill_ensure >/dev/null || {
              echo "[skills] Could not prepare webimg skill content — skipping." >&2
              continue
            }
            ;;
          ssh-toolkit)
            ssh_toolkit_skill_ensure >/dev/null || {
              echo "[skills] Could not prepare ssh-toolkit skill content — skipping." >&2
              continue
            }
            ;;
        esac
      fi
    fi

    local pkg_dest="$dest_root/$pkg"
    mkdir -p "$pkg_dest"
    local n
    while IFS= read -r n; do
      [[ -z "$n" ]] && continue
      local src="$src_root/$n"
      [[ -d "$src" ]] || continue
      rsync -a --delete "$src/" "$pkg_dest/$n/"
      echo "$pkg/$n" >> "$manifest"
    done <<< "$names"
  done

  local total
  total=$(wc -l < "$manifest" 2>/dev/null | tr -d ' ')
  echo "[skills] Mounted ${total:-0} skills (packages: ${all_pkgs})"
}

# Rough token-cost estimate for the skills menu based on count (frontmatter-only).
# ~70 tokens per skill, reported as a ballpark integer range string.
_skills_estimate_tokens() {
  local n="${1:-0}"
  local lo=$((n * 60))
  local hi=$((n * 90))
  printf '%s–%s' "$lo" "$hi"
}

# ---------------------------------------------------------------------------
# MCPs subsystem — registry-driven, distinct from skills
# Skills = knowledge (markdown context). MCPs = capability (server processes,
# optional credentials). Registry at mcps/registry.json is the source of truth.
# ---------------------------------------------------------------------------

_mcps_registry_path() {
  local bundled="$SCRIPT_DIR/mcps/registry.json"
  if [[ -f "$bundled" ]]; then
    echo "$bundled"
    return 0
  fi
  # Fallback: sparse clone from upstream on demand (parallels webimg/proxmox caches)
  if [[ -f "$MCPS_REGISTRY_CACHE/mcps/registry.json" ]]; then
    echo "$MCPS_REGISTRY_CACHE/mcps/registry.json"
    return 0
  fi
  return 1
}

mcps_registry_ensure() {
  local bundled="$SCRIPT_DIR/mcps/registry.json"
  [[ -f "$bundled" ]] && return 0
  local raw_repo="https://github.com/$OCVM_UPDATE_REPO.git"
  if [[ ! -d "$MCPS_REGISTRY_CACHE/.git" ]]; then
    mkdir -p "$(dirname "$MCPS_REGISTRY_CACHE")"
    rm -rf "$MCPS_REGISTRY_CACHE"
    git clone --depth=1 --filter=blob:none --sparse \
      --branch "$OCVM_UPDATE_BRANCH" "$raw_repo" "$MCPS_REGISTRY_CACHE" >/dev/null 2>&1 || {
      echo "[mcps] Could not fetch registry from $raw_repo" >&2
      return 1
    }
    git -C "$MCPS_REGISTRY_CACHE" sparse-checkout set mcps >/dev/null 2>&1 || {
      echo "[mcps] sparse-checkout failed" >&2
      return 1
    }
  else
    git -C "$MCPS_REGISTRY_CACHE" fetch --depth=1 origin "$OCVM_UPDATE_BRANCH" >/dev/null 2>&1 || true
    git -C "$MCPS_REGISTRY_CACHE" checkout -q FETCH_HEAD 2>/dev/null || true
  fi
  [[ -f "$MCPS_REGISTRY_CACHE/mcps/registry.json" ]]
}

_mcps_registry_read() {
  local reg
  reg="$(_mcps_registry_path 2>/dev/null)" || {
    mcps_registry_ensure >/dev/null || return 1
    reg="$(_mcps_registry_path 2>/dev/null)" || return 1
  }
  echo "$reg"
}

mcps_registry_has() {
  local reg; reg="$(_mcps_registry_read)" || return 1
  jq -e --arg n "$1" '.mcps[$n]' "$reg" >/dev/null 2>&1
}

mcps_registry_defaults() {
  local reg; reg="$(_mcps_registry_read)" || return 0
  jq -r '.mcps | to_entries[] | select(.value.default_active == true) | .key' "$reg"
}

# Emits: name<TAB>default_active<TAB>description (one per registry entry)
mcps_registry_list() {
  local reg; reg="$(_mcps_registry_read)" || return 0
  jq -r '.mcps | to_entries[] | "\(.key)\t\(.value.default_active)\t\(.value.description)"' "$reg"
}

mcps_load() {
  MCPS_PACKAGES=""
  if [[ -f "$MCPS_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$MCPS_ENV"
    return 0
  fi
  # First run: seed from registry defaults
  local defaults
  defaults="$(mcps_registry_defaults 2>/dev/null | tr '\n' ' ')"
  MCPS_PACKAGES="$(echo "${defaults}" | sed -e 's/^ *//; s/ *$//')"
  mcps_save
}

mcps_save() {
  mkdir -p "$SHARE_ROOT"
  cat > "$MCPS_ENV" <<EOF
# opencode-vm mcps subsystem
# space-separated list of active mcp names
MCPS_PACKAGES="${MCPS_PACKAGES:-}"
EOF
}

mcps_pkg_is_active() {
  mcps_load
  case " ${MCPS_PACKAGES:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# Internal: remove $1 from MCPS_PACKAGES (no save).
_mcps_pkg_drop() {
  local pkg="$1" new=""
  local p
  for p in ${MCPS_PACKAGES:-}; do
    [[ "$p" == "$pkg" ]] || new="$new $p"
  done
  MCPS_PACKAGES="${new# }"
}

mcps_pkg_on() {
  local pkg="$1"
  if ! mcps_registry_has "$pkg"; then
    echo "[mcps] Unknown MCP: '$pkg'. Run 'opencode-vm mcps list' to see available." >&2
    return 2
  fi

  # Per-MCP setup hooks (credentials, external clones, skill-doc cache)
  case "$pkg" in
    proxmox)
      proxmox_load
      if [[ -z "${PROXMOX_HOST:-}" || -z "${PROXMOX_TOKEN_VALUE:-}" ]]; then
        proxmox_setup_interactive || return 1
      fi
      proxmox_mcp_clone_or_update || return 1
      proxmox_skill_ensure >/dev/null || return 1
      ;;
    playwright|repomapper|graphify)
      # Bundled in base VM — nothing to do
      :
      ;;
  esac

  mcps_load
  if mcps_pkg_is_active "$pkg"; then
    echo "[mcps] '$pkg' is already active."
    return 0
  fi
  MCPS_PACKAGES="${MCPS_PACKAGES:+$MCPS_PACKAGES }$pkg"
  mcps_save
  echo "[mcps] Enabled '$pkg'. Restart session to apply."
}

mcps_pkg_off() {
  local pkg="$1"
  mcps_load
  if ! mcps_pkg_is_active "$pkg"; then
    echo "[mcps] '$pkg' is not active."
    return 0
  fi
  _mcps_pkg_drop "$pkg"
  mcps_save

  # Per-MCP teardown hooks
  case "$pkg" in
    proxmox) proxmox_wipe_env ;;
  esac

  echo "[mcps] Disabled '$pkg'. Restart session to apply."
}

# Substitute well-known placeholder tokens in any JSON document. Used by both
# mcps_build_config_json (for mcp_config.command) and mcps_build_agents_sidecar
# (for agents_md_snippet.content). Token set:
#   {VM_HOME}    — VM user's home dir (e.g. /home/lima.linux)
#   {PROJ_HASH}  — md5 of the project path (matches project_state_dir naming)
#   {SESS_SHARE} — host path of session share (also bind-mounted at same path in VM)
#   {GRAPH_PATH} — per-project graphify graph file path (consumed by graphify MCP)
_mcps_substitute_tokens() {
  local json="$1" vm_home="$2" proj_hash="$3" sess_share="$4" graph_path="$5"
  jq --arg vh "$vm_home" --arg ph "$proj_hash" --arg ss "$sess_share" --arg gp "$graph_path" \
    'walk(if type == "string"
          then gsub("\\{VM_HOME\\}"; $vh)
             | gsub("\\{PROJ_HASH\\}"; $ph)
             | gsub("\\{SESS_SHARE\\}"; $ss)
             | gsub("\\{GRAPH_PATH\\}"; $gp)
          else . end)' <<<"$json"
}

# Path the {GRAPH_PATH} token resolves to. The graphify MCP runs inside the
# session VM and reads/writes through this path. Lives under $sess_share
# (bind-mounted at the same absolute path inside the VM) so the file is
# accessible from both host and guest. Persistence across sessions is handled
# by graphify_persist_load_for_session / graphify_persist_save_for_session.
_mcps_graph_path_for_session() {
  local sess_share="$1"
  echo "$sess_share/graphify/graph.json"
}

# Per-project persistent graph location (host-side, survives session resets).
graphify_persist_dir_for_project() {
  local proj="$1"
  local hash; hash="$(proj_hash "$proj")"
  echo "$PROJECT_STATE_DIR/$hash/graphify"
}

# At session start: load the persisted graph (if any) into sess_share so the
# graphify MCP server inside the VM can read it.
graphify_persist_load_for_session() {
  local proj="$1" sess_share="$2"
  local persist_dir; persist_dir="$(graphify_persist_dir_for_project "$proj")"
  local sess_dir="$sess_share/graphify"
  mkdir -p "$persist_dir" "$sess_dir"
  if [[ -f "$persist_dir/graph.json" ]]; then
    cp -p "$persist_dir/graph.json" "$sess_dir/graph.json"
  fi
}

# At session end: copy any updated graph from sess_share back to the
# per-project persist dir. Safe to call when graphify wasn't active — just
# becomes a no-op when the file doesn't exist.
graphify_persist_save_for_session() {
  local proj="$1" sess_share="$2"
  local sess_file="$sess_share/graphify/graph.json"
  [[ -f "$sess_file" ]] || return 0
  local persist_dir; persist_dir="$(graphify_persist_dir_for_project "$proj")"
  mkdir -p "$persist_dir"
  cp -p "$sess_file" "$persist_dir/graph.json"
}

# Build the {mcp: {...}} object for session injection by iterating
# MCPS_PACKAGES, reading mcp_config from the registry, substituting placeholder
# tokens, and materializing credentials for MCPs that flag
# environment_from_credentials.
# $1 = vm_home (VM user's home dir).
# $2 = sess_share dir (host path; bind-mounted into VM at the same absolute path)
#      used for writing per-session config files (e.g. PROXMOX_MCP_CONFIG JSON).
# $3 = proj path (used to derive {PROJ_HASH} and {GRAPH_PATH} tokens).
mcps_build_config_json() {
  local vm_home="$1"
  local sess_share="${2:-}"
  local proj="${3:-}"
  local proj_h=""; [[ -n "$proj" ]] && proj_h="$(proj_hash "$proj")"
  local graph_p=""; [[ -n "$sess_share" ]] && graph_p="$(_mcps_graph_path_for_session "$sess_share")"
  local reg
  reg="$(_mcps_registry_read 2>/dev/null)" || { echo '{}'; return 0; }

  mcps_load
  [[ -n "${MCPS_PACKAGES:-}" ]] || { echo '{}'; return 0; }

  local mcp_obj='{}'
  local pkg cfg_json raw_cfg
  for pkg in $MCPS_PACKAGES; do
    if ! jq -e --arg n "$pkg" '.mcps[$n]' "$reg" >/dev/null 2>&1; then
      echo "[mcps] active but unknown in registry: '$pkg' — skipping injection." >&2
      continue
    fi

    raw_cfg="$(jq --arg n "$pkg" \
      '.mcps[$n].mcp_config | del(.environment_from_credentials)' "$reg")"
    cfg_json="$(_mcps_substitute_tokens "$raw_cfg" "$vm_home" "$proj_h" "$sess_share" "$graph_p")"

    # MCPs needing credentials as env vars: Proxmox is the only one today.
    if [[ "$pkg" == "proxmox" ]]; then
      if [[ ! -f "$PROXMOX_ENV" ]]; then
        echo "[mcps] proxmox active but credentials missing — skipping injection." >&2
        continue
      fi
      proxmox_load
      if [[ -z "${PROXMOX_HOST:-}" || -z "${PROXMOX_TOKEN_VALUE:-}" ]]; then
        echo "[mcps] proxmox credentials incomplete — skipping injection." >&2
        continue
      fi
      if [[ -z "$sess_share" ]]; then
        echo "[mcps] proxmox injection requires a session share dir — skipping." >&2
        continue
      fi
      # ProxmoxMCP expects PROXMOX_MCP_CONFIG pointing to a JSON file matching
      # proxmox-config/config.example.json. Write it into the session share
      # (bind-mounted at the same absolute path inside the VM) with 0600 perms.
      local pmx_cfg_dir="$sess_share/config/proxmox-mcp"
      local pmx_cfg_file="$pmx_cfg_dir/config.json"
      mkdir -p "$pmx_cfg_dir"
      local pmx_verify=false
      [[ "${PROXMOX_VERIFY_SSL:-0}" == "1" ]] && pmx_verify=true
      jq -n \
        --arg host  "$PROXMOX_HOST" \
        --argjson port  "${PROXMOX_PORT:-8006}" \
        --argjson tls   "$pmx_verify" \
        --arg user  "${PROXMOX_USER:-}" \
        --arg tname "${PROXMOX_TOKEN_NAME:-}" \
        --arg tval  "${PROXMOX_TOKEN_VALUE:-}" \
        '{
          proxmox: { host: $host, port: $port, verify_ssl: $tls, service: "PVE" },
          auth:    { user: $user, token_name: $tname, token_value: $tval },
          logging: { level: "INFO", format: "%(asctime)s - %(name)s - %(levelname)s - %(message)s" }
        }' > "$pmx_cfg_file"
      chmod 600 "$pmx_cfg_file"
      cfg_json="$(echo "$cfg_json" | jq --arg p "$pmx_cfg_file" \
        '. + {environment: {PROXMOX_MCP_CONFIG: $p}}')"
    fi

    mcp_obj="$(jq --arg n "$pkg" --argjson cfg "$cfg_json" '. + {($n): $cfg}' <<<"$mcp_obj")"
  done

  echo "$mcp_obj"
}

# Mount companion skill docs for MCPs that declare a skill_doc field in the
# registry. Proxmox uses this to surface its SKILL.md to the agent.
# Written under $sess_share/config/opencode/skills/<mcp>/<mcp>/ to match the
# skills-subsystem layout so OpenCode picks them up uniformly.
mcps_mount_skill_docs_for_session() {
  local sess_share="$1"
  local reg
  reg="$(_mcps_registry_read 2>/dev/null)" || return 0

  mcps_load
  [[ -n "${MCPS_PACKAGES:-}" ]] || return 0

  local dest_root="$sess_share/config/opencode/skills"
  mkdir -p "$dest_root"

  local pkg doc_rel src_dir
  for pkg in $MCPS_PACKAGES; do
    doc_rel="$(jq -r --arg n "$pkg" '.mcps[$n].skill_doc // empty' "$reg" 2>/dev/null)"
    [[ -n "$doc_rel" ]] || continue

    case "$pkg" in
      proxmox)
        src_dir="$(proxmox_skill_ensure 2>/dev/null)"
        ;;
      *)
        if [[ -d "$SCRIPT_DIR/$doc_rel" ]]; then
          src_dir="$SCRIPT_DIR/$doc_rel"
        else
          src_dir=""
        fi
        ;;
    esac
    [[ -n "$src_dir" && -d "$src_dir" ]] || continue

    mkdir -p "$dest_root/$pkg"
    rsync -a --delete "$src_dir/" "$dest_root/$pkg/$pkg/"
  done
}

# Resolve an MCP's agents_md_snippet declaration into a substituted markdown
# string. Returns empty for MCPs without a snippet declaration.
# $1=pkg $2=registry-path $3=vm_home $4=proj_hash $5=sess_share $6=graph_path
_mcps_resolve_snippet() {
  local pkg="$1" reg="$2" vm_home="$3" proj_h="$4" sess_share="$5" graph_p="$6"
  local source content path raw
  source="$(jq -r --arg n "$pkg" '.mcps[$n].agents_md_snippet.source // empty' "$reg" 2>/dev/null)"
  [[ -n "$source" ]] || return 0

  case "$source" in
    inline)
      content="$(jq -r --arg n "$pkg" '.mcps[$n].agents_md_snippet.content // empty' "$reg" 2>/dev/null)"
      [[ -n "$content" ]] || return 0
      raw="$content"
      ;;
    file)
      path="$(jq -r --arg n "$pkg" '.mcps[$n].agents_md_snippet.path // empty' "$reg" 2>/dev/null)"
      [[ -n "$path" ]] || return 0
      local abs="$SCRIPT_DIR/$path"
      [[ -f "$abs" ]] || {
        echo "[mcps] $pkg agents_md_snippet path not found: $abs" >&2
        return 0
      }
      raw="$(cat "$abs")"
      ;;
    *)
      echo "[mcps] $pkg agents_md_snippet.source unsupported: $source" >&2
      return 0
      ;;
  esac

  # Substitute via the same token engine as mcp_config (wrap as a JSON string
  # to reuse _mcps_substitute_tokens, then unwrap).
  local wrapped substituted
  wrapped="$(jq -Rs . <<<"$raw")"
  substituted="$(_mcps_substitute_tokens "$wrapped" "$vm_home" "$proj_h" "$sess_share" "$graph_p")"
  jq -r . <<<"$substituted"
}

# Build the per-session AGENTS.mcps.md sidecar from active MCPs' snippets.
# Truncates first so a deactivated MCP cannot leak from a previous session.
# Composes after Host LAN IP and before ECC rules in the VM-side AGENTS.md.
# $1=sess_share $2=vm_home $3=proj
mcps_build_agents_sidecar() {
  local sess_share="$1" vm_home="$2" proj="$3"
  local out="$sess_share/config/opencode/AGENTS.mcps.md"
  mkdir -p "$(dirname "$out")"
  : > "$out"

  local reg
  reg="$(_mcps_registry_read 2>/dev/null)" || return 0
  mcps_load
  [[ -n "${MCPS_PACKAGES:-}" ]] || return 0

  local proj_h="" graph_p=""
  [[ -n "$proj" ]] && proj_h="$(proj_hash "$proj")"
  [[ -n "$sess_share" ]] && graph_p="$(_mcps_graph_path_for_session "$sess_share")"

  local pkg snippet
  for pkg in $MCPS_PACKAGES; do
    snippet="$(_mcps_resolve_snippet "$pkg" "$reg" "$vm_home" "$proj_h" "$sess_share" "$graph_p")"
    [[ -n "$snippet" ]] || continue
    printf '\n%s\n' "$snippet" >> "$out"
  done
}

# CLI: opencode-vm mcps {status|list|on <name>|off <name>}
mcps_cmd() {
  local sub="${1:-status}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    status)
      mcps_load
      if [[ -z "${MCPS_PACKAGES:-}" ]]; then
        echo "[mcps] No MCPs active."
      else
        echo "[mcps] Active: ${MCPS_PACKAGES}"
      fi
      ;;
    list)
      if ! _mcps_registry_read >/dev/null; then
        echo "[mcps] Registry not available." >&2
        return 1
      fi
      mcps_load
      printf "%-14s %-7s %-8s %s\n" "NAME" "ACTIVE" "DEFAULT" "DESCRIPTION"
      local name default_active desc
      while IFS=$'\t' read -r name default_active desc; do
        [[ -n "$name" ]] || continue
        local active_mark="no"
        mcps_pkg_is_active "$name" && active_mark="yes"
        local def_mark="off"
        [[ "$default_active" == "true" ]] && def_mark="on"
        printf "%-14s %-7s %-8s %s\n" "$name" "$active_mark" "$def_mark" "$desc"
      done < <(mcps_registry_list)
      ;;
    on)
      [[ -n "${1:-}" ]] || { echo "Usage: opencode-vm mcps on <name>" >&2; return 2; }
      mcps_pkg_on "$1"
      ;;
    off)
      [[ -n "${1:-}" ]] || { echo "Usage: opencode-vm mcps off <name>" >&2; return 2; }
      mcps_pkg_off "$1"
      ;;
    purge)
      # Wipe per-project cached state for an MCP. Currently only graphify
      # owns persistent per-project state (the graph); add cases here for
      # future MCPs as needed. Runs against the CWD project (proj_hash matches
      # what start_session uses).
      [[ -n "${1:-}" ]] || { echo "Usage: opencode-vm mcps purge <name>" >&2; return 2; }
      local _purge_pkg="$1" _purge_proj _purge_dir
      _purge_proj="$(pwd)"
      case "$_purge_pkg" in
        graphify)
          _purge_dir="$(graphify_persist_dir_for_project "$_purge_proj")"
          if [[ -d "$_purge_dir" ]]; then
            rm -rf "$_purge_dir"
            echo "[mcps] Purged graphify cache for project: $_purge_proj"
            echo "[mcps]   removed: $_purge_dir"
          else
            echo "[mcps] No graphify cache to purge for: $_purge_proj"
          fi
          ;;
        *)
          echo "[mcps] '$_purge_pkg' has no per-project state to purge." >&2
          return 1
          ;;
      esac
      ;;
    help|-h|--help)
      cat <<'EOF'
opencode-vm mcps — manage MCP servers (separate from skills)

Usage:
  opencode-vm mcps                        # status (alias)
  opencode-vm mcps status                 # show active MCPs
  opencode-vm mcps list                   # list all known MCPs (active + default + description)
  opencode-vm mcps on <name>              # enable an MCP for future sessions
  opencode-vm mcps off <name>             # disable an MCP for future sessions
  opencode-vm mcps purge <name>           # wipe per-project cached state for an MCP
                                          #   (currently only graphify owns such state)

  opencode-vm skills                      # skills status (alias)
  opencode-vm skills status [path]        # active skill packages + resolved skills
  opencode-vm skills on <pkg>             # enable skill package (ecc-auto | ecc-all | webimg)
  opencode-vm skills off <pkg>            # disable skill package
  opencode-vm skills list [path]          # preview what would mount (no VM touch)

MCPs are servers/tools that give the agent capabilities (browser automation,
code indexing, infra APIs). Skills are knowledge-only markdown.

Built-in MCPs (v0.4.6): playwright (default on), repomapper (default off),
graphify (default off), proxmox (default off; requires API host + token on first enable).
Built-in skills (v0.4.6): webimg (default on, can be disabled), ecc-auto, ecc-all.

Session MCP injection is data-driven: only MCPs in the active list end up
in opencode.json's mcp block. MCPs can also contribute an "agents_md_snippet"
that is appended to the session AGENTS.md (composed via a sidecar — host
writes $sess_share/config/opencode/AGENTS.mcps.md, VM-side cats it onto
~/.config/opencode/AGENTS.md after the Host LAN IP block).
EOF
      ;;
    *)
      echo "Usage: opencode-vm mcps {status|list|on <name>|off <name>|purge <name>}" >&2
      return 2
      ;;
  esac
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

  # Build curl args — bypass CDN cache when OCVM_BYPASS_CACHE=1 (used by update_cmd)
  local -a curl_args=(--fail --silent --location --max-time 4)
  if [[ "${OCVM_BYPASS_CACHE:-0}" == "1" ]]; then
    curl_args+=(-H "Cache-Control: no-cache" -H "Pragma: no-cache")
    source_url="${source_url}?_=$(date +%s)"
  fi

  if [[ "${OCVM_UPDATE_CHECK_QUIET:-0}" == "1" ]]; then
    curl "${curl_args[@]}" "$source_url" >"$target_file" 2>/dev/null
  else
    curl "${curl_args[@]}" --show-error "$source_url" >"$target_file"
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
      echo "HOST_LOCALHOST_FORWARD: ${HOST_LOCALHOST_FORWARD:-$DEFAULT_HOST_LOCALHOST_FORWARD}"
      ;;

    reload|apply)
      # Force-push the current policy.env to every running session VM —
      # useful when policy.env was changed externally (by another shell, edited
      # by hand, restored from backup) or as a manual recovery hatch.
      apply_policy_to_running_sessions
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
          apply_policy_to_running_sessions
          ;;
        rm|remove|del)
          for p in "$@"; do HOST_TCP_PORTS="$(list_rm "$p" $HOST_TCP_PORTS)"; done
          save_policy
          echo "HOST_TCP_PORTS: $HOST_TCP_PORTS"
          apply_policy_to_running_sessions
          ;;
        set)
          HOST_TCP_PORTS="$*"
          save_policy
          echo "HOST_TCP_PORTS: $HOST_TCP_PORTS"
          apply_policy_to_running_sessions
          ;;
        *)
          echo "Usage: opencode-vm ports host {show|add|rm|set} [PORT...]" >&2
          exit 2
          ;;
      esac
      ;;

    hostfwd)
      local op="${1:-show}"; shift || true
      case "$op" in
        show|"")
          echo "${HOST_LOCALHOST_FORWARD:-$DEFAULT_HOST_LOCALHOST_FORWARD}"
          ;;
        enable|on|yes)
          HOST_LOCALHOST_FORWARD="yes"
          save_policy
          echo "HOST_LOCALHOST_FORWARD: $HOST_LOCALHOST_FORWARD"
          apply_policy_to_running_sessions
          ;;
        disable|off|no)
          HOST_LOCALHOST_FORWARD="no"
          save_policy
          echo "HOST_LOCALHOST_FORWARD: $HOST_LOCALHOST_FORWARD"
          apply_policy_to_running_sessions
          ;;
        *)
          echo "Usage: opencode-vm ports hostfwd {show|enable|disable}" >&2
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
              echo "LAN_ALLOW_TCP: $LAN_ALLOW_TCP"
              apply_policy_to_running_sessions ;;
            rm|remove|del)
              for ep in "$@"; do LAN_ALLOW_TCP="$(list_rm "$ep" $LAN_ALLOW_TCP)"; done
              save_policy
              echo "LAN_ALLOW_TCP: $LAN_ALLOW_TCP"
              apply_policy_to_running_sessions ;;
            clear)
              LAN_ALLOW_TCP=""
              save_policy
              echo "LAN_ALLOW_TCP cleared"
              apply_policy_to_running_sessions ;;
            *)
              echo "Usage: opencode-vm ports lan tcp {show|add|rm|clear} [IP[:PORT]...]" >&2
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
              echo "LAN_ALLOW_UDP: $LAN_ALLOW_UDP"
              apply_policy_to_running_sessions ;;
            rm|remove|del)
              for ep in "$@"; do LAN_ALLOW_UDP="$(list_rm "$ep" $LAN_ALLOW_UDP)"; done
              save_policy
              echo "LAN_ALLOW_UDP: $LAN_ALLOW_UDP"
              apply_policy_to_running_sessions ;;
            clear)
              LAN_ALLOW_UDP=""
              save_policy
              echo "LAN_ALLOW_UDP cleared"
              apply_policy_to_running_sessions ;;
            *)
              echo "Usage: opencode-vm ports lan udp {show|add|rm|clear} [IP[:PORT]...]" >&2
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
      echo "Usage: opencode-vm ports {show|reload|host|hostfwd|lan} ..." >&2
      exit 2
      ;;
  esac
}

doctor_cmd() {
  ensure_dirs
  ensure_host_opencode_dirs

  local auth_file="$HOST_DATA_DIR/auth.json"
  local model_file="$HOST_STATE_DIR/model.json"
  local db_file="$HOST_DATA_DIR/opencode.db"

  local area="${1:-show}"
  shift || true

  case "$area" in
    show|"")
      echo "[doctor] OpenCode host paths"
      echo "  config: $HOST_CFG_DIR"
      echo "  data:   $HOST_DATA_DIR"
      echo "  state:  $HOST_STATE_DIR"
      echo ""

      echo "[doctor] Files"
      for f in "$auth_file" "$model_file" "$db_file"; do
        if [[ -f "$f" ]]; then
          echo "  ok: $f"
        else
          echo "  missing: $f"
        fi
      done
      echo ""

      echo "[doctor] Providers from /connect (auth.json)"
      if [[ -f "$auth_file" ]]; then
        if command -v jq >/dev/null 2>&1; then
          jq -r 'keys[]' "$auth_file" 2>/dev/null | sed 's/^/  - /' || echo "  <invalid json>"
        else
          echo "  (jq missing - install jq to list keys)"
        fi
      else
        echo "  <none>"
      fi
      echo ""

      echo "[doctor] Recent/Favorite model providers (model.json)"
      if [[ -f "$model_file" ]]; then
        if command -v jq >/dev/null 2>&1; then
          echo "  recent:"
          jq -r '.recent[]? | "  - \(.providerID)\t\(.modelID)"' "$model_file" 2>/dev/null || echo "  <invalid json>"
          echo "  favorite:"
          jq -r '.favorite[]? | "  - \(.providerID)\t\(.modelID)"' "$model_file" 2>/dev/null || echo "  <invalid json>"
        else
          echo "  (jq missing - install jq for detailed model state)"
        fi
      else
        echo "  <none>"
      fi
      echo ""

      echo "[doctor] Provider usage found in opencode.db messages"
      if [[ -f "$db_file" ]] && command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$db_file" "
          SELECT COALESCE(json_extract(data,'$.model.providerID'),'<none>') AS provider,
                 COUNT(*)
          FROM message
          GROUP BY provider
          ORDER BY COUNT(*) DESC;
        " | sed 's/^/  /'
      elif [[ ! -f "$db_file" ]]; then
        echo "  <no database yet>"
      else
        echo "  (sqlite3 missing - install sqlite3 to inspect db)"
      fi
      echo ""

      echo "[doctor] ECC (everything-claude-code)"
      ecc_load
      if [[ "${ECC_ENABLED:-0}" == "1" ]]; then
        echo "  enabled:   yes"
        echo "  repo:      ${ECC_REPO:-<unset>}"
        echo "  ref:       ${ECC_REF:-<unset>}"
        echo "  commit:    ${ECC_COMMIT:-<unset>}"
        if [[ -d "$ECC_DIR/.opencode" ]]; then
          local _n_cmds _n_agents _n_plugins
          _n_cmds=$(find "$ECC_DIR/.opencode/commands" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
          _n_agents=$(find "$ECC_DIR/.opencode/prompts/agents" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
          _n_plugins=$(find "$ECC_DIR/.opencode/plugins" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
          echo "  payload:   ${_n_cmds} commands, ${_n_agents} agents, ${_n_plugins} plugins"
        else
          echo "  payload:   <clone missing — run: opencode-vm skills on ecc-auto>"
        fi

        # Homunculus (per-project learning store) stats for cwd
        local _hom_proj _hom_hash _hom_dir
        _hom_proj="$(pwd)"
        _hom_hash="$(ecc_compute_project_hash "$_hom_proj")"
        _hom_dir="$(project_state_dir "$_hom_proj")/homunculus"
        echo "  learnings (cwd: $_hom_proj):"
        echo "    project hash: $_hom_hash"
        echo "    store:        $_hom_dir"
        if [[ -d "$_hom_dir" ]]; then
          local _n_personal _n_inherited _obs_line
          _n_personal=$(find "$_hom_dir/personal" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
          _n_inherited=$(find "$_hom_dir/inherited" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
          echo "    instincts:    ${_n_personal} personal, ${_n_inherited} inherited"
          if [[ -f "$_hom_dir/observations.jsonl" ]]; then
            _obs_line=$(wc -l < "$_hom_dir/observations.jsonl" 2>/dev/null | tr -d ' ')
            echo "    observations: ${_obs_line} entries"
          fi
        else
          echo "    instincts:    <none yet — run /learn inside a session>"
        fi

        # Rules auto-inject preview
        local _rules_langs
        _rules_langs="$(detect_project_languages "$_hom_proj")"
        echo "  rules (cwd):   langs: $_rules_langs"
        if [[ -d "$ECC_DIR/rules" ]]; then
          local _rlang _rfiles
          for _rlang in $_rules_langs; do
            [[ -d "$ECC_DIR/rules/$_rlang" ]] || continue
            _rfiles=$(find "$ECC_DIR/rules/$_rlang" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
            echo "                 $_rlang: $_rfiles files"
          done
        fi
      else
        echo "  enabled:   no  (enable with: opencode-vm skills on ecc-auto)"
      fi
      echo ""

      # ---- Skills (knowledge-only packages) ----
      echo "[doctor] Skills"
      skills_load
      if [[ -z "${SKILLS_PACKAGES:-}" ]]; then
        echo "  active:    <none>  (enable with: opencode-vm skills on ecc-auto)"
      else
        echo "  active:    $SKILLS_PACKAGES"
        local _sk_proj _sk_langs _sk_pkg _sk_names _sk_count _sk_total=0
        _sk_proj="$(pwd)"
        _sk_langs="$(detect_project_languages "$_sk_proj")"
        for _sk_pkg in $SKILLS_PACKAGES; do
          _sk_names="$(skills_resolve_pkg "$_sk_pkg" "$_sk_langs")"
          _sk_count=$(printf '%s\n' "$_sk_names" | grep -c . || true)
          _sk_total=$((_sk_total + _sk_count))
          echo "    [$_sk_pkg] $_sk_count skills for cwd"
        done
        echo "  total:     $_sk_total skills, est. $(_skills_estimate_tokens "$_sk_total") tokens"
      fi
      echo ""

      # ---- MCPs (server/capability packages, separate from skills) ----
      echo "[doctor] MCPs"
      if _mcps_registry_read >/dev/null 2>&1; then
        mcps_load
        if [[ -z "${MCPS_PACKAGES:-}" ]]; then
          echo "  active:    <none>  (enable with: opencode-vm mcps on <name>)"
        else
          echo "  active:    $MCPS_PACKAGES"
        fi
        local _mcp_name _mcp_default _mcp_desc _mcp_mark
        while IFS=$'\t' read -r _mcp_name _mcp_default _mcp_desc; do
          [[ -n "$_mcp_name" ]] || continue
          _mcp_mark="[ ]"
          mcps_pkg_is_active "$_mcp_name" && _mcp_mark="[x]"
          echo "    $_mcp_mark $_mcp_name (default ${_mcp_default:-false}): $_mcp_desc"
        done < <(mcps_registry_list)
      else
        echo "  registry:  not available (bundle or fetch mcps/registry.json)"
      fi

      # Proxmox detail (regardless of whether the MCP is currently active)
      if [[ -f "$PROXMOX_ENV" ]]; then
        proxmox_load
        echo "  proxmox:   host=${PROXMOX_HOST:-<unset>}:${PROXMOX_PORT:-8006} user=${PROXMOX_USER:-<unset>} token=${PROXMOX_TOKEN_NAME:-<unset>} verify_tls=${PROXMOX_VERIFY_SSL:-0}"
        if [[ -d "$PROXMOX_MCP_DIR/.git" ]]; then
          echo "             MCP clone: $PROXMOX_MCP_DIR @ ${PROXMOX_MCP_COMMIT:-<unknown>}"
        fi
        if is_vm_running "$BASE_NAME"; then
          if limactl shell --workdir / "$BASE_NAME" -- bash -lc 'test -x $HOME/.local/share/proxmox-mcp-venv/bin/python' 2>/dev/null; then
            echo "             VM venv:   present"
          else
            echo "             VM venv:   missing (will install on next session start)"
          fi
        else
          echo "             VM venv:   unknown (base VM stopped)"
        fi
      fi
      ;;

    *)
      echo "Usage: opencode-vm doctor [show]" >&2
      exit 2
      ;;
  esac
}

# Heuristic capability tagging for newly-discovered models. Order:
# 1) Inspect /v1/models metadata (capabilities[]/modalities/vision/thinking)
# 2) Fall back to model-id name patterns (Ollama tag stripped)
# Lists drift fast — keep them in this single function for easy bumps.
# $1=model id  $2=optional /v1/models entry as JSON
# Output: "<vision>\t<reasoning>" where each is "yes" or "no"
_provider_cap_heuristics() {
  local id="$1"
  local meta_json="${2:-}"
  local id_stripped="${id%%:*}"
  local id_lower
  id_lower="$(printf '%s' "$id_stripped" | tr '[:upper:]' '[:lower:]')"

  local vision="no" reasoning="no"

  if [[ -n "$meta_json" ]] && command -v jq >/dev/null 2>&1; then
    if jq -e 'any(.capabilities[]?; . == "vision" or . == "image" or . == "image-input")' <<<"$meta_json" >/dev/null 2>&1; then
      vision="yes"
    elif jq -e 'any(.modalities.input[]?; . == "image")' <<<"$meta_json" >/dev/null 2>&1; then
      vision="yes"
    elif jq -e '.vision == true' <<<"$meta_json" >/dev/null 2>&1; then
      vision="yes"
    fi
    if jq -e 'any(.capabilities[]?; . == "reasoning" or . == "thinking")' <<<"$meta_json" >/dev/null 2>&1; then
      reasoning="yes"
    elif jq -e '.reasoning == true or .thinking == true' <<<"$meta_json" >/dev/null 2>&1; then
      reasoning="yes"
    fi
  fi

  if [[ "$vision" == "no" ]]; then
    case "$id_lower" in
      *llava*|*llama-3.2-vision*|*llama3.2-vision*|*qwen2.5-vl*|*qwen2-vl*|*qwen-vl*|*qwen3-vl*|*pixtral*|*gemma-3*|*gemma3*|*minicpm-v*|*moondream*|*phi-3-vision*|*phi-4-vision*|*phi3-vision*|*phi4-vision*|*internvl*|*idefics*)
        vision="yes" ;;
    esac
  fi
  if [[ "$reasoning" == "no" ]]; then
    case "$id_lower" in
      *qwq*|*deepseek-r1*|o1*|o3*|*-reasoning*|*reasoning-*|*-thinking*|*thinking-*|*sky-t1*|*qwen3*-thinking*)
        reasoning="yes" ;;
    esac
  fi

  printf '%s\t%s\n' "$vision" "$reasoning"
}

# Quietly refresh all "local" providers (LM Studio, Ollama, etc.) so newly
# loaded models surface in OpenCode at session start. Cloud providers (OpenAI,
# Anthropic) are skipped to avoid per-session API noise. Failures are
# non-fatal — a stopped LM Studio just means we keep yesterday's model list.
provider_refresh_all_quiet() {
  command -v jq >/dev/null 2>&1 || return 0
  command -v curl >/dev/null 2>&1 || return 0
  ensure_dirs
  ensure_host_opencode_dirs
  local cfg_file
  cfg_file="$(pick_host_cfg 2>/dev/null)" || return 0
  [[ -f "$cfg_file" ]] || return 0
  jq -e . "$cfg_file" >/dev/null 2>&1 || return 0

  local local_providers
  local_providers="$(jq -r '
    .provider // {}
    | to_entries[]
    | select(.value.npm == "@ai-sdk/openai-compatible")
    | select(((.value.options.baseURL // "") | test("^http://(localhost|127\\.0\\.0\\.1|192\\.168\\.5\\.2|host\\.lima\\.internal):")))
    | .key
  ' "$cfg_file" 2>/dev/null)"

  [[ -n "$local_providers" ]] || return 0

  local p
  for p in $local_providers; do
    if ! provider_cmd refresh "$p" --quiet >/dev/null 2>&1; then
      echo "[provider] refresh skipped ($p): unreachable" >&2
    fi
  done
}

provider_cmd() {
  ensure_dirs
  ensure_host_opencode_dirs

  local auth_file="$HOST_DATA_DIR/auth.json"
  local model_file="$HOST_STATE_DIR/model.json"
  local db_file="$HOST_DATA_DIR/opencode.db"

  local op="${1:-list}"
  shift || true

  case "$op" in
    new)
      provider_cmd add
      return $?
      ;;

    add)
      local provider="${1:-}"
      shift || true

      # If the first positional arg looks like a flag, put it back and treat provider as empty
      if [[ "$provider" == --* ]]; then
        set -- "$provider" "$@"
        provider=""
      fi

      local base_url=""
      local api_key=""
      local provider_name=""
      local dry_run="no"
      local vision="no"
      local reasoning="no"
      local models=()  # entries stored as: id<TAB>name<TAB>context_tokens

      while [[ "$#" -gt 0 ]]; do
        case "$1" in
          --base-url)
            shift
            base_url="${1:-}"
            ;;
          --base-url=*)
            base_url="${1#*=}"
            ;;
          --api-key)
            shift
            api_key="${1:-}"
            ;;
          --api-key=*)
            api_key="${1#*=}"
            ;;
          --name)
            shift
            provider_name="${1:-}"
            ;;
          --name=*)
            provider_name="${1#*=}"
            ;;
          --model)
            shift
            # parse id[:name[:context[:output]]] — vision/reasoning from global flags
            { IFS=':' read -r _fm _fn _fc _fo <<< "${1:-}"; }
            models+=("${_fm}"$'\t'"${_fn:-$_fm}"$'\t'"${_fc:-0}"$'\t'""$'\t'""$'\t'"${_fo:-0}")
            ;;
          --model=*)
            { IFS=':' read -r _fm _fn _fc _fo <<< "${1#*=}"; }
            models+=("${_fm}"$'\t'"${_fn:-$_fm}"$'\t'"${_fc:-0}"$'\t'""$'\t'""$'\t'"${_fo:-0}")
            ;;
          --vision)
            vision="yes"
            ;;
          --reasoning)
            reasoning="yes"
            ;;
          --dry-run)
            dry_run="yes"
            ;;
          *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
        esac
        shift || true
      done

      # --- Interactive prompts for missing required fields ---
      if [[ -z "$provider" ]]; then
        if [[ ! -t 0 ]]; then
          echo "Usage: opencode-vm provider add [<provider-id>] [--base-url <url>] [--api-key <key>] [--name <display-name>] [--model <model-id>[:<display-name>]] [--dry-run]" >&2
          exit 2
        fi
        while true; do
          read -r -p "[provider] Provider ID (letters, digits, . _ -): " provider
          [[ "$provider" =~ ^[A-Za-z0-9._-]+$ ]] && break
          echo "  Invalid. Allowed: letters, digits, dot, underscore, hyphen." >&2
        done
      fi

      if [[ ! "$provider" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "Invalid provider id: '$provider'" >&2
        echo "Allowed characters: letters, digits, dot, underscore, hyphen." >&2
        exit 2
      fi

      if [[ -z "$base_url" ]]; then
        if [[ ! -t 0 ]]; then
          echo "Missing required --base-url" >&2; exit 2
        fi
        while true; do
          read -r -p "[provider] Base URL (https://api.example.com/v1): " base_url
          [[ "$base_url" == http://* || "$base_url" == https://* ]] && break
          echo "  Must start with http:// or https://" >&2
        done
      fi

      if [[ "$base_url" != http://* && "$base_url" != https://* ]]; then
        echo "Invalid base url: '$base_url'" >&2
        echo "Expected URL starting with http:// or https://" >&2
        exit 2
      fi

      if [[ -z "$api_key" ]]; then
        if [[ ! -t 0 ]]; then
          echo "Missing required --api-key" >&2; exit 2
        fi
        read -r -s -p "[provider] API key: " api_key
        echo
      fi

      if [[ -z "$provider_name" ]] && [[ -t 0 ]]; then
        read -r -p "[provider] Display name [$provider]: " provider_name
      fi
      [[ -z "$provider_name" ]] && provider_name="$provider"

      # --- Dependency check ---
      if ! command -v jq >/dev/null 2>&1; then
        echo "[provider] jq is required for provider add. Install jq and retry." >&2
        exit 1
      fi

      # --- Auto model discovery (when no --model flags given) ---
      if [[ "${#models[@]}" -eq 0 ]]; then
        if ! command -v curl >/dev/null 2>&1; then
          echo "[provider] ERROR: curl is required for model auto-discovery." >&2
          echo "[provider] Install curl or specify models manually with --model <model-id>." >&2
          exit 1
        fi
        local _discover_url="${base_url%/}/models"
        echo "[provider] No --model flags given. Fetching model list from $_discover_url ..."
        local _discover_resp
        _discover_resp="$(curl -sf --connect-timeout 10 --max-time 15 \
          -H "Authorization: Bearer $api_key" \
          -H "Accept: application/json" \
          "$_discover_url" 2>/dev/null || true)"

        if [[ -z "$_discover_resp" ]]; then
          echo "[provider] ERROR: No response from $_discover_url." >&2
          echo "[provider] Check base URL and API key. Provider was NOT added." >&2
          exit 1
        fi
        if ! printf '%s' "$_discover_resp" | jq -e . >/dev/null 2>&1; then
          echo "[provider] ERROR: Response from $_discover_url is not valid JSON." >&2
          echo "[provider] Provider was NOT added." >&2
          exit 1
        fi
        local _discovered_tsv
        _discovered_tsv="$(printf '%s' "$_discover_resp" | \
          jq -r '.data[]? | [.id, (.context_length // .max_context_length // 0 | tostring)] | @tsv' \
          2>/dev/null || true)"
        if [[ -z "$_discovered_tsv" ]]; then
          echo "[provider] ERROR: Endpoint returned no models (.data[].id empty)." >&2
          echo "[provider] Provider was NOT added. Use --model <id> to specify models manually." >&2
          exit 1
        fi
        # Load TSV into array first so the loop doesn't redirect stdin
        # (a while+here-string would swallow interactive read prompts)
        local -a _model_rows=()
        while IFS= read -r _row; do
          [[ -n "$_row" ]] && _model_rows+=("$_row")
        done <<< "$_discovered_tsv"

        echo "[provider] Discovered models:"
        for _row in "${_model_rows[@]}"; do
          local _mid _mctx
          IFS=$'\t' read -r _mid _mctx <<< "$_row"
          [[ -z "$_mid" ]] && continue
          _mctx="${_mctx:-0}"
          local _m_vision="no" _m_reasoning="no" _mout="0"

          if [[ -t 0 ]]; then
            echo ""
            echo "[provider] Model: $_mid"
            printf "  Context window : %s\n" "${_mctx:-unknown (0)}"
            printf "  Vision         : no\n"
            printf "  Reasoning      : no\n"
            local _action=""
            read -r -p "  Accept [Y], edit [e], skip [s]? " _action </dev/tty
            if [[ "$_action" =~ ^[Ss] ]]; then
              echo "  (skipped)"
              continue
            elif [[ "$_action" =~ ^[Ee] ]]; then
              local _new_ctx=""
              if [[ "${_mctx:-0}" -gt 0 ]]; then
                read -r -p "  Context window [$_mctx]: " _new_ctx </dev/tty
              else
                read -r -p "  Context window (tokens, Enter to skip): " _new_ctx </dev/tty
              fi
              [[ -n "$_new_ctx" ]] && _mctx="$_new_ctx"
              local _new_out=""
              read -r -p "  Max output tokens [8192]: " _new_out </dev/tty
              [[ -n "$_new_out" ]] && _mout="$_new_out"
              local _v_ans="" _r_ans=""
              read -r -p "  Supports vision/image input? [y/N]: " _v_ans </dev/tty
              [[ "$_v_ans" =~ ^[Yy] ]] && _m_vision="yes"
              read -r -p "  Supports reasoning/thinking? [y/N]: " _r_ans </dev/tty
              [[ "$_r_ans" =~ ^[Yy] ]] && _m_reasoning="yes"
            fi
            # Y/Enter: accept discovered values (vision/reasoning stay no)
          fi

          models+=("${_mid}"$'\t'"${_mid}"$'\t'"${_mctx:-0}"$'\t'"${_m_vision}"$'\t'"${_m_reasoning}"$'\t'"${_mout:-0}")
        done
        echo ""
      fi

      # --- Prepare config files ---
      local cfg_file
      cfg_file="$(pick_host_cfg)"

      if [[ ! -f "$auth_file" ]]; then
        echo '{}' > "$auth_file"
      fi

      if ! jq -e . "$auth_file" >/dev/null 2>&1; then
        echo "[provider] auth.json is not valid JSON: $auth_file" >&2
        exit 1
      fi

      if ! jq -e . "$cfg_file" >/dev/null 2>&1; then
        echo "[provider] Config file is not valid JSON and cannot be auto-edited: $cfg_file" >&2
        echo "[provider] Please convert to JSON or edit provider config manually." >&2
        exit 1
      fi

      local exists_auth="no" exists_cfg="no"
      exists_auth="$(jq -r --arg p "$provider" 'if has($p) then "yes" else "no" end' "$auth_file")"
      exists_cfg="$(jq -r --arg p "$provider" 'if (.provider // {} | has($p)) then "yes" else "no" end' "$cfg_file")"

      # Build models_json (entries: id<TAB>name<TAB>context<TAB>vision<TAB>reasoning<TAB>output)
      # Per-model vision/reasoning fall back to global --vision / --reasoning flags.
      # limit.output defaults to 8192 — OpenCode requires it as a number when limit is set.
      local models_json='{}'
      for _model_entry in "${models[@]}"; do
        local _mid _mname _mctx _m_vision _m_reasoning _mout
        IFS=$'\t' read -r _mid _mname _mctx _m_vision _m_reasoning _mout <<< "$_model_entry"
        _mctx="${_mctx:-0}"
        _mout="${_mout:-0}"; [[ "$_mout" -eq 0 ]] && _mout=8192
        [[ -z "$_m_vision" ]]    && _m_vision="$vision"
        [[ -z "$_m_reasoning" ]] && _m_reasoning="$reasoning"

        models_json="$(printf '%s' "$models_json" | jq \
          --arg id "$_mid" --arg name "$_mname" --argjson ctx "$_mctx" --argjson out "$_mout" \
          'if $ctx > 0
           then .[$id] = {"name": $name, "limit": {"context": $ctx, "output": $out}}
           else .[$id] = {"name": $name}
           end')"

        if [[ "$_m_vision" == "yes" ]]; then
          models_json="$(printf '%s' "$models_json" | jq \
            --arg id "$_mid" \
            '.[$id] += {"attachment": true, "modalities": {"input": ["text","image"],"output":["text"]}}')"
        fi

        if [[ "$_m_reasoning" == "yes" ]]; then
          models_json="$(printf '%s' "$models_json" | jq \
            --arg id "$_mid" \
            '.[$id].options.thinking = {"type":"enabled","budgetTokens":8192}')"
        fi
      done

      echo "[provider] Add preview: $provider"
      echo "  auth.json existing entry: $exists_auth"
      echo "  config existing provider: $exists_cfg"
      echo "  baseURL: $base_url"
      echo "  display name: $provider_name"
      echo "  models (${#models[@]}):"
      for _model_entry in "${models[@]}"; do
        local _mid _mname _mctx _m_vision _m_reasoning _mout
        IFS=$'\t' read -r _mid _mname _mctx _m_vision _m_reasoning _mout <<< "$_model_entry"
        [[ -z "$_m_vision" ]]    && _m_vision="$vision"
        [[ -z "$_m_reasoning" ]] && _m_reasoning="$reasoning"
        _mout="${_mout:-0}"; [[ "$_mout" -eq 0 ]] && _mout=8192
        local _meta=""
        [[ "${_mctx:-0}" -gt 0 ]] && _meta+=" ctx:${_mctx}"
        _meta+=" out:${_mout}"
        [[ "$_m_vision" == "yes" ]]    && _meta+=" vision"
        [[ "$_m_reasoning" == "yes" ]] && _meta+=" reasoning"
        echo "    - $_mid${_meta:+  ($_meta)}"
      done

      if [[ "$dry_run" == "yes" ]]; then
        echo "[provider] Dry-run only. No changes made."
        return 0
      fi

      local ts backup_dir
      ts="$(date +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_DIR/provider-$ts"
      mkdir -p "$backup_dir"

      cp -p "$auth_file" "$backup_dir/auth.json.bak"
      cp -p "$cfg_file" "$backup_dir/$(basename "$cfg_file").bak"

      local tmp_auth tmp_cfg
      tmp_auth="$(mktemp)"
      tmp_cfg="$(mktemp)"

      jq --arg p "$provider" --arg k "$api_key" \
        '.[$p] = {"type":"key","key":$k}' \
        "$auth_file" > "$tmp_auth" && mv "$tmp_auth" "$auth_file"

      jq \
        --arg p "$provider" \
        --arg n "$provider_name" \
        --arg b "$base_url" \
        --argjson m "$models_json" \
        '.provider = ((.provider // {}) + {($p): {"npm":"@ai-sdk/openai-compatible","name":$n,"options":{"baseURL":$b},"models":$m}})' \
        "$cfg_file" > "$tmp_cfg" && mv "$tmp_cfg" "$cfg_file"

      echo "[provider] '$provider' added/updated with ${#models[@]} model(s)."
      echo "[provider] Updated auth: $auth_file"
      echo "[provider] Updated config: $cfg_file"
      echo "[provider] Backups written to: $backup_dir"
      echo "[provider] Tip: restart your session (opencode-vm prune && opencode-vm start)."
      ;;

    refresh)
      local provider="${1:-}"
      shift || true
      local prompt_new="no" skip_new="no" no_context_update="no" dry_run="no" quiet="no"

      while [[ "$#" -gt 0 ]]; do
        case "$1" in
          --prompt-new) prompt_new="yes" ;;
          --skip-new) skip_new="yes" ;;
          --no-context-update) no_context_update="yes" ;;
          --dry-run) dry_run="yes" ;;
          --quiet) quiet="yes" ;;
          *) echo "Unknown option: $1" >&2; return 2 ;;
        esac
        shift
      done

      if [[ -z "$provider" ]]; then
        echo "Usage: opencode-vm provider refresh <provider-id> [--prompt-new] [--skip-new] [--no-context-update] [--dry-run] [--quiet]" >&2
        return 2
      fi

      if ! command -v jq >/dev/null 2>&1; then
        echo "[provider] jq is required for provider refresh." >&2
        return 1
      fi
      if ! command -v curl >/dev/null 2>&1; then
        echo "[provider] curl is required for provider refresh." >&2
        return 1
      fi

      local cfg_file
      cfg_file="$(pick_host_cfg)"
      if ! jq -e . "$cfg_file" >/dev/null 2>&1; then
        echo "[provider] Config file is not valid JSON: $cfg_file" >&2
        return 1
      fi

      if ! jq -e --arg p "$provider" '(.provider // {}) | has($p)' "$cfg_file" >/dev/null 2>&1; then
        echo "[provider] No such provider in config: '$provider'" >&2
        echo "[provider] Run 'opencode-vm provider add $provider ...' first." >&2
        return 1
      fi

      local base_url
      base_url="$(jq -r --arg p "$provider" '.provider[$p].options.baseURL // ""' "$cfg_file")"
      if [[ -z "$base_url" ]]; then
        echo "[provider] Provider '$provider' has no options.baseURL — cannot refresh." >&2
        return 1
      fi

      local api_key=""
      if [[ -f "$auth_file" ]]; then
        api_key="$(jq -r --arg p "$provider" '.[$p].key // ""' "$auth_file" 2>/dev/null || echo "")"
      fi
      [[ -z "$api_key" ]] && api_key="local"

      local discover_url="${base_url%/}/models"
      local discover_resp
      discover_resp="$(curl -sf --connect-timeout 3 --max-time 5 \
        -H "Authorization: Bearer $api_key" \
        -H "Accept: application/json" \
        "$discover_url" 2>/dev/null || true)"

      if [[ -z "$discover_resp" ]] || ! jq -e . <<<"$discover_resp" >/dev/null 2>&1; then
        [[ "$quiet" == "no" ]] && echo "[provider] refresh: no/invalid response from $discover_url" >&2
        return 1
      fi

      # discovered_map: { "<id>": { "context": <int>, "meta": <full /v1/models entry> } }
      local discovered_map
      discovered_map="$(jq '
        [.data[]?
         | { (.id): { context: (.context_length // .max_context_length // 0), meta: . } }
        ] | add // {}' <<<"$discover_resp")"

      local existing_map
      existing_map="$(jq --arg p "$provider" '.provider[$p].models // {}' "$cfg_file")"

      local removed_ids new_ids kept_ids
      removed_ids="$(jq -r --argjson d "$discovered_map" 'keys - ($d | keys) | .[]' <<<"$existing_map")"
      new_ids="$(jq -r --argjson e "$existing_map" 'keys - ($e | keys) | .[]' <<<"$discovered_map")"
      kept_ids="$(jq -r --argjson d "$discovered_map" 'keys | map(select(. as $k | $d | has($k))) | .[]' <<<"$existing_map")"

      local updated_models="$existing_map"
      local mid

      # 1) Drop removed
      for mid in $removed_ids; do
        updated_models="$(jq --arg id "$mid" 'del(.[$id])' <<<"$updated_models")"
      done

      # 2) Update kept (context only, preserve user-set vision/reasoning/output)
      if [[ "$no_context_update" != "yes" ]]; then
        for mid in $kept_ids; do
          local new_ctx
          new_ctx="$(jq -r --arg id "$mid" '.[$id].context // 0' <<<"$discovered_map")"
          [[ "${new_ctx:-0}" -gt 0 ]] || continue
          updated_models="$(jq --arg id "$mid" --argjson c "$new_ctx" \
            'if (.[$id].limit?.context // 0) != $c
             then .[$id].limit = ((.[$id].limit // {}) + {"context":$c, "output": (.[$id].limit?.output // 8192)})
             else . end' <<<"$updated_models")"
        done
      fi

      # 3) Add new (auto-tag via heuristics; --prompt-new for interactive; --skip-new to skip)
      local added_ids="" skipped_ids=""
      for mid in $new_ids; do
        if [[ "$skip_new" == "yes" ]]; then
          skipped_ids+="$mid "
          continue
        fi
        local new_ctx new_meta v r
        new_ctx="$(jq -r --arg id "$mid" '.[$id].context // 0' <<<"$discovered_map")"
        new_meta="$(jq --arg id "$mid" '.[$id].meta' <<<"$discovered_map")"
        IFS=$'\t' read -r v r < <(_provider_cap_heuristics "$mid" "$new_meta")

        if [[ "$prompt_new" == "yes" ]] && [[ -t 0 ]]; then
          echo "[provider] New model: $mid (ctx=${new_ctx:-?} vision=$v reasoning=$r)"
          local action=""
          read -r -p "  Add [Y], edit [e], skip [s]? " action </dev/tty
          if [[ "$action" =~ ^[Ss] ]]; then
            skipped_ids+="$mid "
            continue
          elif [[ "$action" =~ ^[Ee] ]]; then
            local v_ans r_ans
            read -r -p "  Vision? [${v}] (y/n): " v_ans </dev/tty
            [[ "$v_ans" =~ ^[Yy] ]] && v="yes"
            [[ "$v_ans" =~ ^[Nn] ]] && v="no"
            read -r -p "  Reasoning? [${r}] (y/n): " r_ans </dev/tty
            [[ "$r_ans" =~ ^[Yy] ]] && r="yes"
            [[ "$r_ans" =~ ^[Nn] ]] && r="no"
          fi
        fi

        local entry
        if [[ "${new_ctx:-0}" -gt 0 ]]; then
          entry="$(jq -n --arg name "$mid" --argjson c "$new_ctx" \
            '{name: $name, limit: {context: $c, output: 8192}}')"
        else
          entry="$(jq -n --arg name "$mid" '{name: $name}')"
        fi
        if [[ "$v" == "yes" ]]; then
          entry="$(jq '. += {attachment: true, modalities: {input: ["text","image"], output: ["text"]}}' <<<"$entry")"
        fi
        if [[ "$r" == "yes" ]]; then
          entry="$(jq '.options.thinking = {type: "enabled", budgetTokens: 8192}' <<<"$entry")"
        fi
        updated_models="$(jq --arg id "$mid" --argjson e "$entry" '.[$id] = $e' <<<"$updated_models")"
        added_ids+="$mid "
      done

      # If nothing changed and we're quiet, exit silently
      if [[ "$quiet" == "yes" ]] && [[ -z "$removed_ids$added_ids" ]]; then
        return 0
      fi

      [[ "$quiet" == "no" ]] && {
        echo "[provider] refresh: $provider"
        [[ -n "$removed_ids" ]] && echo "  removed: $(echo "$removed_ids" | tr '\n' ' ')"
        [[ -n "$kept_ids"    ]] && echo "  kept:    $(echo "$kept_ids" | tr '\n' ' ')"
        [[ -n "$added_ids"   ]] && echo "  added:   $added_ids"
        [[ -n "$skipped_ids" ]] && echo "  skipped: $skipped_ids"
      }

      if [[ "$dry_run" == "yes" ]]; then
        [[ "$quiet" == "no" ]] && echo "[provider] Dry-run only. No changes made."
        return 0
      fi

      # Skip write if nothing actually changed (avoids touching mtime needlessly,
      # which would re-trigger the host↔project sync)
      if [[ -z "$removed_ids$added_ids" ]] && [[ "$no_context_update" == "yes" ]]; then
        return 0
      fi
      # Compare updated_models against existing_map; skip write if identical
      if jq -e --argjson a "$existing_map" --argjson b "$updated_models" '$a == $b' <<<"null" >/dev/null 2>&1; then
        return 0
      fi

      local ts backup_dir
      ts="$(date +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_DIR/provider-$ts"
      mkdir -p "$backup_dir"
      cp -p "$cfg_file" "$backup_dir/$(basename "$cfg_file").bak"

      local tmp_cfg
      tmp_cfg="$(mktemp)"
      jq --arg p "$provider" --argjson m "$updated_models" \
        '.provider[$p].models = $m' \
        "$cfg_file" > "$tmp_cfg" && mv "$tmp_cfg" "$cfg_file"

      [[ "$quiet" == "no" ]] && {
        echo "[provider] Updated config: $cfg_file"
        echo "[provider] Backup: $backup_dir"
      }
      ;;

    rm|remove|forget|delete)
      local provider="${1:-}"
      shift || true
      local dry_run="no"

      while [[ "$#" -gt 0 ]]; do
        case "$1" in
          --dry-run) dry_run="yes" ;;
          *) echo "Unknown option: $1" >&2; exit 2 ;;
        esac
        shift
      done

      if [[ -z "$provider" ]]; then
        echo "Usage: opencode-vm provider rm <provider-id> [--dry-run]" >&2
        exit 2
      fi
      if [[ ! "$provider" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "Invalid provider id: '$provider'" >&2
        echo "Allowed characters: letters, digits, dot, underscore, hyphen." >&2
        exit 2
      fi

      local cfg_file
      cfg_file="$(pick_host_cfg)"

      local auth_count=0 cfg_count=0 recent_count=0 favorite_count=0 db_count=0

      if [[ -f "$auth_file" ]] && command -v jq >/dev/null 2>&1; then
        auth_count="$(jq --arg p "$provider" 'if has($p) then 1 else 0 end' "$auth_file" 2>/dev/null || echo 0)"
      fi
      if [[ -f "$cfg_file" ]] && command -v jq >/dev/null 2>&1; then
        cfg_count="$(jq -r --arg p "$provider" 'if (.provider // {} | has($p)) then 1 else 0 end' "$cfg_file" 2>/dev/null || echo 0)"
      fi
      if [[ -f "$model_file" ]] && command -v jq >/dev/null 2>&1; then
        recent_count="$(jq --arg p "$provider" '[.recent[]? | select(.providerID == $p)] | length' "$model_file" 2>/dev/null || echo 0)"
        favorite_count="$(jq --arg p "$provider" '[.favorite[]? | select(.providerID == $p)] | length' "$model_file" 2>/dev/null || echo 0)"
      fi
      if [[ -f "$db_file" ]] && command -v sqlite3 >/dev/null 2>&1; then
        db_count="$(sqlite3 "$db_file" "SELECT COUNT(*) FROM message WHERE json_extract(data,'$.model.providerID')='$provider';" 2>/dev/null || echo 0)"
      fi

      echo "[provider] Remove preview: $provider"
      echo "  auth.json entry: $auth_count"
      echo "  opencode.json provider entry: $cfg_count"
      echo "  model.json recent entries: $recent_count"
      echo "  model.json favorite entries: $favorite_count"
      echo "  opencode.db message rows: $db_count"

      if [[ "$dry_run" == "yes" ]]; then
        echo "[provider] Dry-run only. No changes made."
        return 0
      fi

      local ts backup_dir
      ts="$(date +%Y%m%d-%H%M%S)"
      backup_dir="$BACKUP_DIR/provider-$ts"
      mkdir -p "$backup_dir"

      [[ -f "$auth_file" ]] && cp -p "$auth_file" "$backup_dir/auth.json.bak"
      [[ -f "$cfg_file" ]] && cp -p "$cfg_file" "$backup_dir/$(basename "$cfg_file").bak"
      [[ -f "$model_file" ]] && cp -p "$model_file" "$backup_dir/model.json.bak"
      [[ -f "$db_file" ]] && cp -p "$db_file" "$backup_dir/opencode.db.bak"

      if [[ -f "$auth_file" ]]; then
        if command -v jq >/dev/null 2>&1; then
          local tmp_auth
          tmp_auth="$(mktemp)"
          jq --arg p "$provider" 'del(.[$p])' "$auth_file" > "$tmp_auth" && mv "$tmp_auth" "$auth_file"
        else
          echo "[provider] WARNING: jq missing, auth.json not modified." >&2
        fi
      fi

      if [[ -f "$cfg_file" ]] && command -v jq >/dev/null 2>&1; then
        if jq -e . "$cfg_file" >/dev/null 2>&1; then
          local tmp_cfg
          tmp_cfg="$(mktemp)"
          jq --arg p "$provider" 'del(.provider[$p])' "$cfg_file" > "$tmp_cfg" && mv "$tmp_cfg" "$cfg_file"
        else
          echo "[provider] WARNING: config file is not valid JSON, skipping provider entry removal." >&2
        fi
      fi

      if [[ -f "$model_file" ]]; then
        if command -v jq >/dev/null 2>&1; then
          local tmp_model
          tmp_model="$(mktemp)"
          jq --arg p "$provider" '
            .recent = [(.recent // [])[] | select(.providerID != $p)]
            | .favorite = [(.favorite // [])[] | select(.providerID != $p)]
            | .variant = ((.variant // {}) | with_entries(select(.key != $p and ((.value.providerID // "") != $p))))
          ' "$model_file" > "$tmp_model" && mv "$tmp_model" "$model_file"
        else
          echo "[provider] WARNING: jq missing, model.json not modified." >&2
        fi
      fi

      if [[ -f "$db_file" ]] && command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$db_file" "
          UPDATE message
          SET data = json_remove(data, '$.model')
          WHERE json_extract(data,'$.model.providerID') = '$provider';
          PRAGMA wal_checkpoint(FULL);
        " >/dev/null 2>&1 || true
      elif [[ -f "$db_file" ]]; then
        echo "[provider] WARNING: sqlite3 missing, opencode.db not modified." >&2
      fi

      echo "[provider] '$provider' removed."
      echo "[provider] Backups written to: $backup_dir"
      echo "[provider] Tip: restart your session (opencode-vm prune && opencode-vm start)."
      ;;

    list|show|"")
      if [[ -f "$auth_file" ]] && command -v jq >/dev/null 2>&1; then
        echo "[provider] Configured providers:"
        jq -r 'keys[]' "$auth_file" | sed 's/^/  - /'
      else
        echo "Usage: opencode-vm provider {list|add|rm ...}"
      fi
      ;;

    *)
      echo "Usage: opencode-vm provider {list|new|add [<id>] [--base-url <url>] [--api-key <key>] [--name <display-name>] [--vision] [--model <id>[:<name>[:<context>]]] [--dry-run]|refresh <id> [--prompt-new] [--skip-new] [--no-context-update] [--dry-run] [--quiet]|rm <id> [--dry-run]}" >&2
      exit 2
      ;;
  esac
}

cleanup_sessions() {
  sanitize_lima_sock_dir

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

migrate_to_project_history() {
  # Idempotent: seed $PROJECT_HISTORY_DIR from existing $PROJECT_STATE_DIR
  # entries so users who had OCVM sessions before the fresh-default switch
  # can still reach their chat history via `opencode-vm web --keep-history`.
  [[ -f "$PROJECT_HISTORY_MIGRATED_MARKER" ]] && return 0
  mkdir -p "$PROJECT_HISTORY_DIR"
  if [[ -d "$PROJECT_STATE_DIR" ]]; then
    local src dst
    for src in "$PROJECT_STATE_DIR"/*/; do
      [[ -d "$src" ]] || continue
      dst="$PROJECT_HISTORY_DIR/$(basename "$src")"
      if [[ -d "$src/xdg-data/opencode" ]] && [[ ! -e "$dst/xdg-data/opencode" ]]; then
        mkdir -p "$dst/xdg-data/opencode" "$dst/xdg-state/opencode"
        rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$src/xdg-data/opencode/" "$dst/xdg-data/opencode/" 2>/dev/null || true
        rsync -a "$src/xdg-state/opencode/" "$dst/xdg-state/opencode/" 2>/dev/null || true
      fi
    done
  fi
  : > "$PROJECT_HISTORY_MIGRATED_MARKER"
}

notify_fresh_default_once() {
  [[ -f "$FRESH_DEFAULT_NOTIFIED_MARKER" ]] && return 0
  cat <<'EOF'

───────────────────────────────────────────────────────────────
 OpenCode-VM: session handling changed
───────────────────────────────────────────────────────────────
 `opencode-vm web` now starts with an empty session list by
 default. Your previous per-project chat history is preserved
 and still available via:

     opencode-vm web --keep-history

 Fresh-mode sessions are archived per run under
 ~/.opencode-vm/fresh-history/<project>/<timestamp>/.
 The global ~/.local/share/opencode/opencode.db is no longer
 synced into the VM — use it only from host-side opencode.
───────────────────────────────────────────────────────────────

EOF
  : > "$FRESH_DEFAULT_NOTIFIED_MARKER"
}

ocvm_post_update_migrate() {
  # Hook for version-to-version migrations. Args: old_version new_version
  [[ "$#" -eq 2 ]] || return 0
  migrate_to_project_history
  return 0
}

update_cmd() {
  [[ "$#" -eq 0 ]] || { echo "Usage: opencode-vm update" >&2; exit 2; }

  local remote_tmp_file remote_version current_version script_path
  current_version="$OCVM_VERSION"
  remote_tmp_file="$(mktemp)"

  remote_version="$(OCVM_BYPASS_CACHE=1 ocvm_check_remote_version "$remote_tmp_file" || true)"
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

  # Non-interactive (piped stdin): just print the recommendation
  if [[ ! -t 0 ]]; then
    echo "Recommended: run 'opencode-vm init' to rebuild the base VM with any new changes."
    return 0
  fi

  # Interactive: offer to rebuild now
  local answer=""
  read -r -p "Rebuild base VM now with the new version? (y/N) " answer
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo ""
    echo "Recommended: run 'opencode-vm init' to rebuild the base VM with any new changes."
    return 0
  fi

  echo ""
  need limactl
  sanitize_lima_sock_dir
  cleanup_sessions
  if base_exists; then
    echo "[init] Stopping and deleting existing base VM: $BASE_NAME"
    limactl stop "$BASE_NAME" 2>/dev/null || true
    if ! limactl delete -f "$BASE_NAME"; then
      sanitize_lima_sock_dir
      limactl delete -f "$BASE_NAME" 2>/dev/null || true
    fi
  fi
  rm -rf "$HOME/.lima/sock" 2>/dev/null || true
  provision_base
  echo
  echo "Next: navigate to your project directory (open terminal in VS Code) and run:"
  echo "  opencode-vm start"
  echo
  skills_load
  echo "Built-in skill: webimg (web image optimization pipeline, always active)"
  if [[ -n "${SKILLS_PACKAGES:-}" ]]; then
    echo "Active skill packages: ${SKILLS_PACKAGES}"
    echo "These will be applied automatically on next 'opencode-vm start'."
  else
    echo "Optional skill packages (enable any time):"
    echo "  opencode-vm skills on ecc-auto   # language-filtered ECC skills (auto-clones ECC)"
    echo "  opencode-vm skills on ecc-all    # every ECC skill (token-heavy)"
    echo ""
    echo "Optional MCP servers (separate subsystem):"
    echo "  opencode-vm mcps on proxmox      # Proxmox VE API via ProxmoxMCP (requires token)"
    echo "  opencode-vm mcps on repomapper   # PageRank codebase maps (default off)"
  fi
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
  sanitize_lima_sock_dir
  limactl list -q 2>/dev/null | grep -qx "$BASE_NAME"
}

provision_base() {
  sanitize_lima_sock_dir

  echo "[init] Creating base VM: $BASE_NAME"

  # Generate a custom Lima template based on docker-rootful but without the
  # slow Docker readiness probe.  We check Docker readiness ourselves below,
  # which avoids the ~10 min polling loop Lima's optional probe causes.
  local tmpl_file
  tmpl_file=$(mktemp /tmp/ocvm-template-XXXXXX)
  mv "$tmpl_file" "${tmpl_file}.yaml"
  tmpl_file="${tmpl_file}.yaml"
  limactl tmpl yq 'template:docker-rootful' 'del(.probes) | del(.param)' > "$tmpl_file"

  limactl start --cpus 6 --memory 8 --name "$BASE_NAME" --vm-type vz --mount-none --mount-type virtiofs --timeout 20m --tty=false "$tmpl_file" || {
    if limactl list -q 2>/dev/null | grep -qx "$BASE_NAME"; then
      echo "[init] Lima start returned non-zero, but VM is running — continuing..."
    else
      echo "[init] VM failed to start." >&2
      rm -f "$tmpl_file"
      exit 1
    fi
  }
  rm -f "$tmpl_file"

  # Wait for shell access
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

  # Wait for Docker to be ready (replaces the removed Lima probe)
  echo "[init] Waiting for Docker daemon..."
  retries=0
  while ! limactl shell "$BASE_NAME" -- docker info >/dev/null 2>&1; do
    retries=$((retries + 1))
    if (( retries > 60 )); then
      echo "[init] Docker not ready after 120s." >&2
      exit 1
    fi
    sleep 2
  done
  echo "[init] Docker ready"

  # Expose auto-forwarded ports on all interfaces (LAN access for web mode)
  local lima_yaml="$HOME/.lima/$BASE_NAME/lima.yaml"
  if ! grep -q 'guestIPMustBeZero: true' "$lima_yaml" 2>/dev/null; then
    echo "[init] Configuring LAN port forwarding..."
    rm -rf "$HOME/.lima/sock" 2>/dev/null || true
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
# Preseed wireshark-common: don't make dumpcap setuid (we use sudo for captures).
# Without this, the tshark install would prompt and break non-interactive provisioning.
echo "wireshark-common wireshark-common/install-setuid boolean false" | sudo debconf-set-selections
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl wget openssl \
  git ripgrep jq \
  less nano vim-tiny file tree \
  tar gzip bzip2 xz-utils zip unzip \
  procps lsof strace build-essential pkg-config make cmake \
  iproute2 iputils-ping traceroute mtr-tiny \
  bind9-dnsutils netcat-openbsd tcpdump socat whois iperf3 \
  openssh-client sshpass autossh mosh sshfs rsync expect \
  nmap arp-scan iputils-arping iputils-tracepath tcptraceroute ipcalc ldnsutils inetutils-telnet \
  ethtool iftop nethogs bridge-utils vlan tshark hping3 \
  gnutls-bin lftp \
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
  libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
  imagemagick libvips-tools \
  webp libavif-bin \
  pngquant optipng jpegoptim gifsicle \
  potrace librsvg2-bin \
  libimage-exiftool-perl

# Install NVM + Node.js 22 LTS (default)
export NVM_DIR="$HOME/.nvm"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22

# Install Playwright MCP globally + Chromium browser for headless UI testing
# Pin to cdn.playwright.dev — the default playwright.azureedge.net mirror has
# been observed throttling to ~100 KB/s, turning the 183 MB chromium download
# into a 30-min stall. cdn.playwright.dev serves the same artifacts at full speed.
npm install -g @playwright/mcp@latest svgo
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.playwright.dev npx -y playwright install chromium

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

# Install graphify — code-graph MCP. Pure-Python, tree-sitter AST based.
# The MCP server (`python -m graphify.serve`) is read-only and makes ZERO
# LLM calls. Semantic enrichment happens via the agent's own LLM access
# (no separate API key needed). Pinned to a tested PyPI version.
pip3 install --user pipx
mkdir -p ~/.local/bin
~/.local/bin/pipx ensurepath >/dev/null 2>&1 || true
~/.local/bin/pipx install 'graphifyy==0.4.32' >/dev/null
# Wrapper provides a friendly "no graph yet" error when activated in a fresh
# project — keeps the agent from seeing a Python traceback.
sudo tee /usr/local/bin/graphify-serve-wrapper.sh >/dev/null <<'WRAPPER'
#!/usr/bin/env bash
graph="${1:?usage: graphify-serve-wrapper.sh <graph.json>}"
if [[ ! -f "$graph" ]]; then
  echo "[graphify] No graph at $graph yet." >&2
  echo "[graphify] Build one in the project root with the graphify CLI:" >&2
  echo "[graphify]   graphify --help    # see available subcommands" >&2
  echo "[graphify]   graphify <build-cmd> --code-only" >&2
  exit 2
fi
# pipx-installed graphify owns its own venv; invoke its python directly so we
# don't rely on the venv's bin/ being on PATH.
exec ~/.local/share/pipx/venvs/graphifyy/bin/python -m graphify.serve "$graph"
WRAPPER
sudo chmod 0755 /usr/local/bin/graphify-serve-wrapper.sh

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
  set lan_allow_host_tcp4 {
    type ipv4_addr
    flags interval
  }
  set lan_allow_host_udp4 {
    type ipv4_addr
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

    # Host-weite Freigaben (alle Ports einer IP)
    ip daddr @lan_allow_host_tcp4 meta l4proto tcp accept
    ip daddr @lan_allow_host_udp4 meta l4proto udp accept

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
  # Note: `nft` is intentionally NOT denied here — `deny capability net_admin`
  # above already blocks every modifying nft op (set element, flush, replace,
  # add chain/rule, etc.) at the kernel layer, while leaving read-only
  # operations like `nft list ruleset` / `nft monitor` available so agents
  # can diagnose firewall state. iptables/ip6tables stay denied because
  # they're legacy, rarely useful for read-only diagnostics, and keep the
  # defense-in-depth layer for unfamiliar attack paths.
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
# Coding Principles section adapted from andrej-karpathy-skills (MIT):
#   https://github.com/forrestchang/andrej-karpathy-skills
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
- **TCP/IP connectivity**: `nc` (netcat-openbsd), `ncat` (nmap, with TLS/SSL), `socat`, `telnet` (inetutils-telnet, real telnet)
- **Packet capture**: `sudo tcpdump` (requires sudo for raw sockets)
- **Routing & latency**: `ping`, `traceroute`, `mtr` (mtr-tiny), `ip` (iproute2)
- **Bandwidth**: `iperf3`
- **Domain lookups**: `whois`
- **Port scanning/testing**: `nc -zv <host> <port>` for a single port; `nmap -p 1-1000 <host>` for ranges; `nmap -sn 192.168.1.0/24` for ping-sweep
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

# SSH with non-interactive password (when key auth not set up)
SSHPASS="$REMOTE_PW" sshpass -e ssh -o StrictHostKeyChecking=accept-new user@host uptime

# Discover LAN hosts
sudo arp-scan --localnet

# Find which TCP ports are open on a host
nmap -p 1-1000 192.168.1.10
```

## SSH & Remote Access

All standard SSH client tooling is pre-installed:

- `ssh`, `scp`, `sftp`, `ssh-keygen`, `ssh-keyscan`, `ssh-copy-id` (openssh-client)
- `sshpass` — non-interactive password auth for scripting
- `autossh` — auto-reconnecting SSH tunnels
- `mosh` — mobile shell over UDP, robust on flaky links
- `sshfs` — mount remote dirs over SSH
- `rsync` — file sync over SSH
- `expect` — script interactive prompts

**No SSH credentials are pre-loaded.** `~/.ssh` is empty; no agent forwarding.
If you need to SSH somewhere, the user must provide the credentials per session
(env var, paste key into `~/.ssh/`, or use sshpass with a password). Never
attempt to reach the user's git origin from inside the VM — that boundary is
enforced at the firewall level.

## Network Discovery

- `nmap` — port/host scanning. `nmap -sn 192.168.1.0/24` for ping-sweep
- `ncat` — netcat with TLS/SSL support (from nmap package)
- `arp-scan --localnet` — LAN host discovery via ARP (use `--interface` if multi-iface)
- `arping <ip>` — single-host ARP reachability
- `tracepath <host>` / `tcptraceroute <host> <port>` — path tracing without root, TCP-based traceroute through firewalls
- `ipcalc 192.168.1.0/24` — subnet math
- `drill <name>` — alternative DNS resolver (DNSSEC trace, CH-class)

## Deep Packet Analysis

- `tshark` — CLI Wireshark for protocol-level inspection (run with `sudo`)
- `hping3` — crafted-packet probes (use carefully — can stress LANs)

## Performance & Interface Diagnostics

- `ethtool <iface>` — link/PHY/driver info
- `iftop -i <iface>` — live bandwidth per connection (TUI)
- `nethogs <iface>` — live bandwidth per process (TUI)
- `brctl show` — bridge topology (bridge-utils)
- `vconfig` — VLAN inspection

## TLS / Secure Transport

- `openssl s_client -connect host:443` — TLS handshake & cert inspection
- `gnutls-cli host:443` — alternative TLS client (different stack, useful for cross-checks)
- `lftp` — sftp/http/ftp client with `mirror`, scriptable bulk transfers

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

## Image Optimization Tools

Pre-installed CLI tools for web image optimization and graphics conversion:

- **ImageMagick** (`convert`, `identify`, `mogrify`): versatile image conversion, resize, crop, format detection
- **libvips** (`vips`, `vipsthumbnail`): high-performance image processing (faster and more memory-efficient than ImageMagick for batch operations)
- **WebP** (`cwebp`, `dwebp`): encode/decode WebP format
- **AVIF** (`avifenc`, `avifdec`): encode/decode AVIF format
- **pngquant**: lossy PNG compression (reduces colors, dramatic size reduction)
- **OptiPNG** (`optipng`): lossless PNG recompression
- **jpegoptim**: JPEG optimization (lossless or lossy)
- **gifsicle**: GIF optimization and manipulation
- **potrace**: bitmap-to-SVG vectorization (flat logos, icons only — not photos)
- **librsvg** (`rsvg-convert`): SVG rendering and conversion
- **SVGO** (`svgo`): SVG optimization and cleanup
- **ExifTool** (`exiftool`): image metadata inspection and removal

The `web-image-pipeline` skill is mounted by default and provides detailed workflows, quality defaults, and reporting format for production web image optimization.

## Network Configuration

- **Internet**: full outbound access (HTTP/HTTPS and all protocols)
- **Host services** (from inside VM via `host.lima.internal`):
  - LM Studio: `http://host.lima.internal:1234`
  - Ollama: `http://host.lima.internal:11434`
- **LAN**: restricted by default (host can configure via `opencode-vm ports`)
- **DNS**: works normally, resolved via Lima host DNS
- **Firewall**: managed by the host and cannot be modified from within the VM

## Host LAN IP Variable

For each started session, opencode-vm injects the host LAN IP into the environment and into the session-local AGENTS instructions file.

- Canonical variable: `OCVM_HOST_LAN_IP`
- Aliases: `HOST_LAN_IP`, `LANIP`
- Use this value when suggesting URLs for services bound to `0.0.0.0` in the VM (prefer `http://$OCVM_HOST_LAN_IP:<port>` over `localhost`).

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

## Project Design References

For any frontend, UI, or visual-design task, check the project root (and the root of any relevant sub-project, e.g. a mono-repo package) for a `DESIGN.md` file. If present, treat it as authoritative for design system, colors, typography, and component conventions. One public source of such files is [awesome-design-md](https://github.com/VoltAgent/awesome-design-md).

## Coding Principles

1. **Think before coding.** State your assumptions explicitly. If the request is ambiguous or you see multiple reasonable interpretations, surface them and ask before implementing.
2. **Simplicity first.** Deliver the minimal code that solves the stated problem. No speculative features, unrequested abstractions, or flexibility for imagined future needs.
3. **Surgical changes.** Modify only what's required for the request. Preserve existing style and structure; don't fold in unrelated refactors or "while I'm here" cleanups.
4. **Goal-driven execution.** Turn vague tasks into verifiable success criteria. Validate each step (build, test, run) before declaring the task done.
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

  # LAN allowlists: "IP:PORT" -> nft IP.PORT tuple, "IP" (ohne Port) -> Host-Set (alle Ports)
  local lan_tcp_elems="" lan_host_tcp_elems=""
  for ep in $LAN_ALLOW_TCP; do
    if [[ "$ep" == *:* ]]; then
      local ip="${ep%:*}"
      local port="${ep##*:}"
      lan_tcp_elems+="${ip} . ${port}, "
    else
      lan_host_tcp_elems+="${ep}, "
    fi
  done
  lan_tcp_elems="${lan_tcp_elems%, }"
  lan_host_tcp_elems="${lan_host_tcp_elems%, }"

  local lan_udp_elems="" lan_host_udp_elems=""
  for ep in $LAN_ALLOW_UDP; do
    if [[ "$ep" == *:* ]]; then
      local ip="${ep%:*}"
      local port="${ep##*:}"
      lan_udp_elems+="${ip} . ${port}, "
    else
      lan_host_udp_elems+="${ep}, "
    fi
  done
  lan_udp_elems="${lan_udp_elems%, }"
  lan_host_udp_elems="${lan_host_udp_elems%, }"

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

    sudo -n nft flush set inet ocfilter lan_allow_host_tcp4
    if [[ -n \"$lan_host_tcp_elems\" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_host_tcp4 { $lan_host_tcp_elems }
    fi

    sudo -n nft flush set inet ocfilter lan_allow_host_udp4
    if [[ -n \"$lan_host_udp_elems\" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_host_udp4 { $lan_host_udp_elems }
    fi

    sudo -n nft list table inet ocfilter >/dev/null
  "
}

# Re-apply the current policy.env to every currently-running session VM.
# Used by `ports {host,hostfwd,lan} {add,rm,set,clear}` and `ports reload` so
# changes take effect immediately without requiring a session restart.
# Iterates ~/.opencode-vm/sessions/*.env (one entry per project hash); for
# each, sources SESS_NAME, checks `is_vm_running`, and pushes:
#   - nft set updates via apply_policy_in_vm
#   - socat hostfwd units via setup_host_port_forwards_in_vm (idempotent;
#     drops stale ports automatically)
# Silent no-op if no sessions are running.
apply_policy_to_running_sessions() {
  [[ -d "$SESSIONS_DIR" ]] || return 0
  shopt -s nullglob
  local applied=0 envf SESS_NAME SESS_PROJ
  for envf in "$SESSIONS_DIR"/*.env; do
    SESS_NAME=""; SESS_PROJ=""
    # shellcheck disable=SC1090
    source "$envf"
    [[ -n "${SESS_NAME:-}" ]] || continue
    if is_vm_running "$SESS_NAME"; then
      echo "[ports] Re-applying policy to running session: $SESS_NAME (${SESS_PROJ:-unknown})"
      apply_policy_in_vm "$SESS_NAME" >/dev/null || {
        echo "[ports] WARN: nft policy push to '$SESS_NAME' failed." >&2
      }
      setup_host_port_forwards_in_vm "$SESS_NAME" >/dev/null || true
      applied=$((applied + 1))
    fi
  done
  shopt -u nullglob
  if (( applied == 0 )); then
    echo "[ports] No running sessions — changes apply on next 'opencode-vm start'."
  else
    echo "[ports] Applied to $applied running session(s)."
  fi
}

setup_host_port_forwards_in_vm() {
  local vm_name="$1"

  if [[ "${HOST_LOCALHOST_FORWARD:-$DEFAULT_HOST_LOCALHOST_FORWARD}" != "yes" ]]; then
    echo "[run] Localhost forwarding disabled by policy"
    return 0
  fi

  sanitize_lima_sock_dir

  limactl shell --workdir / "$vm_name" -- bash -lc '
    set -euo pipefail
    local_ports="$1"
    started=""
    skipped=""

    # Drop stale units from previous port policy revisions
    shopt -s nullglob
    for unit in /etc/systemd/system/ocvm-hostfwd-*.service; do
      unit_name="$(basename "$unit")"
      port="${unit_name#ocvm-hostfwd-}"
      port="${port%.service}"
      if [[ " $local_ports " != *" $port "* ]]; then
        sudo -n systemctl disable --now "$unit_name" 2>/dev/null || true
        sudo -n rm -f "$unit"
      fi
    done
    sudo -n systemctl daemon-reload

    for port in $local_ports; do
      [[ -n "$port" ]] || continue

      # If something already listens on localhost:port in the VM, keep it untouched.
      if ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .; then
        echo "[fwd] skip localhost:$port (already in use)"
        skipped="$skipped $port"
        continue
      fi

      unit="ocvm-hostfwd-${port}.service"
      sudo -n tee "/etc/systemd/system/${unit}" >/dev/null <<UNIT
[Unit]
Description=OpenCode VM localhost forward for host port ${port}
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork TCP:192.168.5.2:${port}
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
UNIT

      sudo -n systemctl daemon-reload
      sudo -n systemctl enable --now "$unit" >/dev/null 2>&1 || true

      sleep 0.1
      if ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .; then
        started="$started $port"
      else
        echo "[fwd] failed localhost:$port"
        sudo -n systemctl status "$unit" --no-pager 2>/dev/null | tail -n 4 || true
        skipped="$skipped $port"
      fi
    done

    echo "[fwd] localhost forwarding started:${started:- <none>}"
    if [[ -n "${skipped// /}" ]]; then
      echo "[fwd] localhost forwarding skipped:${skipped}"
    fi
  ' _ "$HOST_TCP_PORTS"
}

stop_host_port_forwards_in_vm() {
  local vm_name="$1"
  limactl shell --workdir / "$vm_name" -- bash -lc '
    set +e
    for port in $1; do
      [[ -n "$port" ]] || continue
      unit="ocvm-hostfwd-${port}.service"
      sudo -n systemctl disable --now "$unit" 2>/dev/null || true
      sudo -n rm -f "/etc/systemd/system/${unit}" 2>/dev/null || true
    done
    sudo -n systemctl daemon-reload 2>/dev/null || true
  ' _ "$HOST_TCP_PORTS" || true
}

enter_session_shell() {
  local vm_name="$1" proj_dir="$2" host_lan_ip="${3:-localhost}" sess_share="${4:-}"
  sanitize_lima_sock_dir
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
    export OCVM_HOST_LAN_IP="$2"
    export HOST_LAN_IP="$2"
    export LANIP="$2"

    # Set XDG dirs to match session environment (same as start_session)
    SESS_SHARE="$3"
    if [ -n "$SESS_SHARE" ] && [ -d "$SESS_SHARE" ]; then
      export XDG_CONFIG_HOME="$SESS_SHARE/config"
      export XDG_DATA_HOME=/tmp/oc-xdg-data
      export XDG_STATE_HOME=/tmp/oc-xdg-state
      export OPENCODE_ENABLE_EXA=1
      # ECC project identity: stable hash across sessions uses host project path
      if [ -f "$SESS_SHARE/config/opencode/.ecc-applied" ]; then
        export CLAUDE_PROJECT_DIR="$1"
      fi
    fi

    cd "$1"
    bash

    # Sync VM-local data back to session share after shell exits
    if [ -n "$SESS_SHARE" ] && [ -d "$SESS_SHARE" ]; then
      echo "[shell] Syncing session data back to host..."
      rsync -a --exclude="bin/" --exclude="log/" --exclude="tool-output/" \
        /tmp/oc-xdg-data/opencode/ "$SESS_SHARE/xdg-data/opencode/" 2>/dev/null || true
      rsync -a /tmp/oc-xdg-state/opencode/ "$SESS_SHARE/xdg-state/opencode/" 2>/dev/null || true
      echo "[shell] Sync complete"
    fi
  ' _ "$proj_dir" "$host_lan_ip" "$sess_share"
}

attach_session() {
  need limactl
  sanitize_lima_sock_dir
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
    # Session was kept on a previous exit (stop-but-keep). Resume it.
    if limactl list -q 2>/dev/null | grep -qx "$SESS_NAME"; then
      echo "[attach] Session VM '$SESS_NAME' is stopped — resuming..."
      if ! run_with_spinner "[attach] Starting session VM..." limactl start "$SESS_NAME" --tty=false; then
        echo "[attach] Failed to resume VM '$SESS_NAME'." >&2
        echo "[attach] Start a fresh session with: opencode-vm start --fresh" >&2
        exit 1
      fi
    else
      echo "Session VM '$SESS_NAME' no longer exists." >&2
      echo "Start a new session with: opencode-vm start" >&2
      rm -f "$senv"
      exit 1
    fi
  fi

  echo "[attach] Reconnecting to session: $SESS_NAME"
  echo "[attach] Project: $proj"

  local sess_mode="${SESS_MODE:-tui}"
  local sess_port="${SESS_PORT:-$DEFAULT_OC_PORT}"
  local host_lan_ip
  host_lan_ip="$(get_host_ip)"

  # Parity with fresh-start: nftables sets are reset on VM boot to /etc/nftables.conf
  # defaults, and host-localhost forwards (socat units) were torn down on the
  # previous keep-exit. Re-apply both so the resumed session matches a fresh one.
  echo "[attach] Applying firewall policy... $(_ts)"
  apply_policy_in_vm "$SESS_NAME" || echo "[attach] WARNING: nftables policy push failed" >&2
  if ! setup_host_port_forwards_in_vm "$SESS_NAME"; then
    echo "[attach] WARNING: host-localhost forwarding setup failed; use host.lima.internal as fallback" >&2
  fi
  echo "[attach] Firewall policy applied $(_ts)"

  limactl shell --workdir / "$SESS_NAME" -- bash -lc '
    set -euo pipefail
    PROJ_DIR="$1"
    SESS_SHARE="$2"
    OC_MODE="$3"
    OC_PORT="$4"
    OC_HOST_IP="$5"
    OC_PASSWORD="$6"
    OC_WEB_TUI="$7"

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
    export OPENCODE_ENABLE_EXA=1
    export OCVM_HOST_LAN_IP="$OC_HOST_IP"
    export HOST_LAN_IP="$OC_HOST_IP"
    export LANIP="$OC_HOST_IP"

    export XDG_CONFIG_HOME="$SESS_SHARE/config"
    export XDG_DATA_HOME=/tmp/oc-xdg-data
    export XDG_STATE_HOME=/tmp/oc-xdg-state
    # ECC project identity: stable hash across sessions uses host project path
    if [ -f "$SESS_SHARE/config/opencode/.ecc-applied" ]; then
      export CLAUDE_PROJECT_DIR="$PROJ_DIR"
    fi

    cd "$PROJ_DIR"

    # If VM-local xdg data is missing (e.g. /tmp was cleared by systemd-tmpfiles
    # on a stop-then-start boot), repopulate it from the persisted session
    # share so reconnect preserves history. On a still-running VM the in-VM
    # data is already present; we only seed when it is missing.
    mkdir -p /tmp/oc-xdg-data/opencode /tmp/oc-xdg-state/opencode
    if [ ! -e /tmp/oc-xdg-data/opencode/storage ] && [ -d "$SESS_SHARE/xdg-data/opencode" ]; then
      echo "[attach] Restoring session history from share..."
      rsync -a --exclude="bin/" --exclude="log/" --exclude="tool-output/" \
        "$SESS_SHARE/xdg-data/opencode/" /tmp/oc-xdg-data/opencode/ 2>/dev/null || true
      rsync -a "$SESS_SHARE/xdg-state/opencode/" /tmp/oc-xdg-state/opencode/ 2>/dev/null || true
    fi

    if [ "$OC_MODE" = "web" ]; then
      echo ""
      echo "=============================================="
      echo "  OpenCode Web Server (port $OC_PORT) — resumed"
      echo "=============================================="
      echo ""
      echo "Connect via:"
      echo ""
      echo "  Browser/Web UI:  http://${OC_HOST_IP}:${OC_PORT}"
      echo "  API docs:        http://${OC_HOST_IP}:${OC_PORT}/doc"
      echo "  TUI attach:      opencode attach http://${OC_HOST_IP}:${OC_PORT}"
      echo ""
      if [ -n "$OC_PASSWORD" ]; then
        echo "  Username:        opencode"
        echo "  Password:        $OC_PASSWORD"
        echo ""
        export OPENCODE_SERVER_PASSWORD="$OC_PASSWORD"
      else
        echo "Tip: pass --password <pw> to opencode-vm web to secure the server."
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
    else
      aa-exec -p opencode-sandbox -- opencode || true
    fi

    # Sync VM-local data back to session share so host cleanup picks it up
    echo "[attach] Syncing session data back to host..."
    rsync -a --exclude="bin/" --exclude="log/" --exclude="tool-output/" \
      /tmp/oc-xdg-data/opencode/ "$SESS_SHARE/xdg-data/opencode/" 2>/dev/null || true
    rsync -a /tmp/oc-xdg-state/opencode/ "$SESS_SHARE/xdg-state/opencode/" 2>/dev/null || true
    echo "[attach] Sync complete"
  ' _ "$proj" "$(session_share_dir "$proj")" "$sess_mode" "$sess_port" "$host_lan_ip" "${SESSION_PASSWORD:-}" "${OC_WEB_TUI:-false}"
}

# Update SESS_MODE / SESS_PORT in an existing session.env, preserving other
# fields. Used when the user resumes via a different launch verb than the one
# that created the session (e.g. `opencode-vm web` resuming a session that was
# created with `opencode-vm start`, where the persisted mode was tui).
_update_senv_mode() {
  local senv="$1" new_mode="$2" new_port="$3"
  [[ -f "$senv" ]] || return 0
  # shellcheck disable=SC1090
  ( source "$senv"
    printf 'SESS_NAME=%q\nSESS_PROJ=%q\nCFG_HASH_AT_START=%q\nSESS_MODE=%q\nSESS_PORT=%q\nSESS_KEEP_HISTORY=%q\n' \
      "$SESS_NAME" "$SESS_PROJ" "${CFG_HASH_AT_START:-}" "$new_mode" "$new_port" "${SESS_KEEP_HISTORY:-0}" > "$senv"
  )
}

# Sync data back from a prior session share, then stop and delete its VM.
# Called when the user chooses "fresh" at the start prompt.
_destroy_prev_session() {
  local proj="$1"
  local senv
  senv="$(session_env "$proj")"
  [[ -f "$senv" ]] || return 0

  # shellcheck disable=SC1090
  source "$senv"
  local old_sess="$SESS_NAME"
  local old_sess_share
  old_sess_share="$(session_share_dir "$proj")"
  local old_proj_state
  old_proj_state="$(project_state_dir "$proj")"

  echo ""
  echo "[cleanup] Syncing old session data back before destroy... $(_ts)"

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
      # Only overwrite host config if old session's version is newer —
      # the user may have run 'provider add' after the session ended.
      local _host_cfg
      _host_cfg="$(pick_host_cfg)"
      if [[ ! -f "$_host_cfg" ]] || [[ "$old_cfg" -nt "$_host_cfg" ]]; then
        cp -p "$old_cfg" "$_host_cfg"
      fi
    fi

    # Propagate only auth.json back to host (if newer) so provider changes stick.
    local _old_sess_auth="$old_sess_share/xdg-data/opencode/auth.json"
    if [[ -f "$_old_sess_auth" ]]; then
      if [[ ! -f "$HOST_DATA_DIR/auth.json" ]] || [[ "$_old_sess_auth" -nt "$HOST_DATA_DIR/auth.json" ]]; then
        cp -p "$_old_sess_auth" "$HOST_DATA_DIR/auth.json"
      fi
    fi

    # Persist orphaned session to the correct project-local destination
    # based on the mode the session was started in.
    local _old_keep="${SESS_KEEP_HISTORY:-0}"
    if [[ "$_old_keep" -eq 1 ]]; then
      local _old_ph_dir
      _old_ph_dir="$(project_history_dir "$proj")"
      mkdir -p "$_old_ph_dir/xdg-data/opencode" "$_old_ph_dir/xdg-state/opencode"
      rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$old_sess_share/xdg-data/opencode/" "$_old_ph_dir/xdg-data/opencode/"
      rsync -a "$old_sess_share/xdg-state/opencode/" "$_old_ph_dir/xdg-state/opencode/"
    else
      local _old_fh_dir
      _old_fh_dir="$(fresh_history_dir "$proj")/${old_sess#oc-}"
      mkdir -p "$_old_fh_dir/xdg-data/opencode" "$_old_fh_dir/xdg-state/opencode"
      rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$old_sess_share/xdg-data/opencode/" "$_old_fh_dir/xdg-data/opencode/"
      rsync -a "$old_sess_share/xdg-state/opencode/" "$_old_fh_dir/xdg-state/opencode/"
    fi

    # Keep project-state cache in sync too.
    rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$old_sess_share/xdg-data/opencode/" "$old_proj_state/xdg-data/opencode/"
    rsync -a "$old_sess_share/xdg-state/opencode/" "$old_proj_state/xdg-state/opencode/"

    local old_db_backup_dir="$old_proj_state/db-backups"
    check_sqlite_integrity "$old_proj_state/xdg-data/opencode" "$old_db_backup_dir/xdg-data"
    check_sqlite_integrity "$old_proj_state/xdg-state/opencode" "$old_db_backup_dir/xdg-state"
  fi

  echo "[old-session] Synced old session data back $(_ts)"

  echo "[cleanup] Removing old session VM: $old_sess $(_ts)"
  limactl stop "$old_sess" 2>/dev/null || true
  limactl delete -f "$old_sess" >/dev/null 2>&1 || true
  rm -f "$senv"
  rm -rf "$old_sess_share"
  echo "[cleanup] Old session removed $(_ts)"
}

# Decide what to do when a prior session exists for this project.
# Writes one of "reconnect" / "fresh" / "cancel" to stdout; prompts go to stderr.
# Non-interactive with no ON_EXISTING flag → returns 2 (fail closed).
_decide_start_action() {
  local vm_name="$1"

  # Explicit flag wins.
  if [[ -n "${ON_EXISTING:-}" ]]; then
    echo "$ON_EXISTING"
    return 0
  fi

  # Non-interactive: require a flag rather than silently picking an action.
  if [[ ! -t 0 ]] || [[ ! -r /dev/tty ]]; then
    echo "[start] A session already exists for this project (VM: $vm_name)." >&2
    echo "[start] Non-interactive mode — pass one of:" >&2
    echo "[start]   --reconnect         attach to existing (resume if stopped)" >&2
    echo "[start]   --fresh             destroy and start new" >&2
    echo "[start]   --cancel-if-exists  exit without doing anything" >&2
    return 2
  fi

  local vm_state="stopped"
  is_vm_running "$vm_name" && vm_state="running"

  echo "" >&2
  if [[ "$vm_state" == "running" ]]; then
    echo "A session for this project is already running: $vm_name" >&2
    echo "  [r] reconnect (attach to it)" >&2
    echo "  [f] fresh     (destroy and start new — you will lose mid-session state)" >&2
    echo "  [c] cancel" >&2
  else
    echo "A stopped session VM exists for this project: $vm_name" >&2
    echo "  [r] resume (restart the VM and attach)" >&2
    echo "  [f] fresh  (destroy and start new)" >&2
    echo "  [c] cancel" >&2
  fi

  local _ans
  while true; do
    read -r -p "Choose r/f/c: " _ans </dev/tty || return 2
    case "$_ans" in
      r|R) echo "reconnect"; return 0 ;;
      f|F) echo "fresh";     return 0 ;;
      c|C) echo "cancel";    return 0 ;;
      *)   echo "Please enter r, f, or c." >&2 ;;
    esac
  done
}

# Decide whether to keep or delete the session VM on clean exit.
# Honors OCVM_ON_EXIT=keep|delete|ask. Non-interactive defaults to keep.
# Writes "keep" or "delete" to stdout.
_decide_cleanup_action() {
  local override="${OCVM_ON_EXIT:-}"
  case "$override" in
    keep|delete)
      echo "$override"
      return 0
      ;;
    ask|"")
      ;;
    *)
      echo "[cleanup] Ignoring invalid OCVM_ON_EXIT='$override' (expected: keep|delete|ask)." >&2
      ;;
  esac

  # Non-interactive or no TTY: keep (preserve state).
  if [[ ! -r /dev/tty ]]; then
    echo "keep"
    return 0
  fi

  local _ans
  echo "" >&2
  read -r -p "Session ended. [K]eep VM for later resume / [d]elete and clean up [K/d]: " _ans </dev/tty || _ans=""
  case "$_ans" in
    d|D|delete) echo "delete" ;;
    *)          echo "keep"   ;;
  esac
}

# One-time tip after the user first kept a session.
_notify_kept_session_once() {
  [[ -f "$KEPT_SESSION_NOTIFIED_MARKER" ]] && return 0
  cat >&2 <<'EOF'

───────────────────────────────────────────────────────────────
 Tip: stopped session VMs persist on disk.
───────────────────────────────────────────────────────────────
 You chose to keep this session. Resume it any time with:
     opencode-vm start        (then choose 'r' to resume)
     opencode-vm attach       (auto-starts the stopped VM)

 To clean up a kept session, answer 'd' at the next exit
 prompt, or run:
     opencode-vm prune        (removes all kept sessions)
───────────────────────────────────────────────────────────────

EOF
  : > "$KEPT_SESSION_NOTIFIED_MARKER"
}

start_session() {
  need limactl
  need rsync
  sanitize_lima_sock_dir
  printf "\r[run] Starting OpenCode VM session... |"
  ensure_dirs
  ensure_host_opencode_dirs
  migrate_to_project_history
  notify_fresh_default_once
  printf "\r[run] Starting OpenCode VM session... /"
  backup_host_cfg
  ensure_policy_file
  printf "\r[run] Starting OpenCode VM session... done $(_ts)\n"

  proj="$(pwd)"

  # A session already exists for this project: prompt the user — never auto-destroy.
  senv="$(session_env "$proj")"
  if [[ -f "$senv" ]]; then
    # shellcheck disable=SC1090
    source "$senv"
    local _action _rc
    _action="$(_decide_start_action "$SESS_NAME")"
    _rc=$?
    if [[ "$_rc" -ne 0 ]]; then
      exit "$_rc"
    fi
    case "$_action" in
      reconnect)
        if ! is_vm_running "$SESS_NAME"; then
          if ! run_with_spinner "[start] Resuming session VM..." limactl start "$SESS_NAME" --tty=false; then
            echo "[start] Failed to resume VM '$SESS_NAME'. Use 'opencode-vm start --fresh' to recreate." >&2
            exit 1
          fi
        fi
        # The launch verb (`opencode-vm web`) overrides the persisted mode
        # from the prior session — otherwise attach_session re-sources
        # session.env and re-launches in the old mode.
        if [[ "$SESSION_MODE" == "web" && "${SESS_MODE:-tui}" != "web" ]]; then
          echo "[start] Switching session mode: ${SESS_MODE:-tui} -> web (port ${SESSION_PORT:-$DEFAULT_OC_PORT})."
          _update_senv_mode "$senv" web "${SESSION_PORT:-$DEFAULT_OC_PORT}"
        elif [[ "$SESSION_MODE" == "web" && -n "${SESSION_PORT:-}" && "$SESSION_PORT" != "${SESS_PORT:-}" ]]; then
          echo "[start] Updating web port: ${SESS_PORT:-?} -> $SESSION_PORT."
          _update_senv_mode "$senv" web "$SESSION_PORT"
        fi
        attach_session
        return 0
        ;;
      fresh)
        _destroy_prev_session "$proj"
        ;;
      cancel)
        echo "[start] Cancelled."
        exit 0
        ;;
      *)
        echo "[start] Internal error: unexpected action '$_action'." >&2
        exit 1
        ;;
    esac
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

  # Auto-refresh local LLM providers (LM Studio, Ollama) so newly-loaded
  # models surface in this session. Cloud providers are untouched. Failures
  # are non-fatal. Set OCVM_PROVIDER_AUTOREFRESH=0 to disable.
  # Runs BEFORE the host↔project sync so refreshed host_cfg propagates
  # into proj_cfg via mtime comparison, and BEFORE cfg_hash is computed.
  if [[ "${OCVM_PROVIDER_AUTOREFRESH:-1}" == "1" ]]; then
    provider_refresh_all_quiet || true
  fi

  # Keep host and project preferences in sync before each session.
  # This also bootstraps first-run setups where local OpenCode was never installed.
  sync_cfg_between_host_and_project "$host_cfg" "$proj_cfg"
  echo "[run] Synced host ↔ project config $(_ts)"

  # History handling: default is fresh (empty session list); --keep-history
  # loads the project-specific history from $PROJECT_HISTORY_DIR. The global
  # host opencode.db is never synced in either mode.
  if [[ "${KEEP_HISTORY:-0}" -eq 1 ]]; then
    local ph_dir
    ph_dir="$(project_history_dir "$proj")"
    mkdir -p "$ph_dir/xdg-data/opencode" "$ph_dir/xdg-state/opencode"
    mkdir -p "$proj_state/xdg-data/opencode" "$proj_state/xdg-state/opencode"
    rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$ph_dir/xdg-data/opencode/" "$proj_state/xdg-data/opencode/"
    rsync -a "$ph_dir/xdg-state/opencode/" "$proj_state/xdg-state/opencode/"
    echo "[run] Loaded project history $(_ts)"
  else
    rm -rf "$proj_state/xdg-data/opencode" "$proj_state/xdg-state/opencode"
    mkdir -p "$proj_state/xdg-data/opencode" "$proj_state/xdg-state/opencode"
    echo "[run] Fresh session (no history loaded) $(_ts)"
  fi

  # Carry host auth.json into the project state so provider credentials work.
  if [[ -f "$HOST_DATA_DIR/auth.json" ]]; then
    cp -p "$HOST_DATA_DIR/auth.json" "$proj_state/xdg-data/opencode/auth.json"
  fi

  if [[ -f "$proj_cfg" ]]; then
    cp -p "$proj_cfg" "$proj_cfg_legacy"
  fi

  # Per-session share directory for config/state
  sess_share="$(session_share_dir "$proj")"
  rm -rf "$sess_share"
  mkdir -p "$sess_share"

  # Copy project state into session share (XDG directory structure)
  mkdir -p "$sess_share/config/opencode" "$sess_share/xdg-data/opencode" "$sess_share/xdg-state/opencode"

  # Load any persisted graphify graph for this project into sess_share so the
  # graphify MCP server (running in the VM via virtiofs mount) can read it.
  graphify_persist_load_for_session "$proj" "$sess_share"
  if [[ -f "$proj_cfg" ]]; then
    cp -p "$proj_cfg" "$sess_share/config/opencode/opencode.json"
  else
    cp -p "$host_cfg" "$sess_share/config/opencode/opencode.json"
  fi
  cp -p "$sess_share/config/opencode/opencode.json" "$sess_share/config/opencode/.opencode.json"

  # Inject session overrides: MCP block built from mcps/registry.json + active
  # MCPS_PACKAGES, plus allow-all permissions with git commit=ask and git push=deny.
  local sess_cfg_file="$sess_share/config/opencode/opencode.json"
  local vm_home
  vm_home="$(vm_resolve_home "$BASE_NAME")"
  if command -v jq >/dev/null 2>&1 && [[ -f "$sess_cfg_file" ]]; then
    local mcp_obj
    mcp_obj="$(mcps_build_config_json "$vm_home" "$sess_share" "$proj")"
    [[ -n "$mcp_obj" ]] || mcp_obj='{}'

    local tmp_cfg
    tmp_cfg="$(mktemp)"
    # The mcp block is wholly owned by the MCPs subsystem. Any legacy mcp
    # entries in the persisted config (e.g. from pre-v0.4.7 auto-injection
    # or manual edits) are overwritten — we never want to leak a disabled
    # MCP like repomapper into the session just because it was written
    # there on a previous run.
    jq --argjson mcp "$mcp_obj" '
      (. * {
        "permission": {
          "*": "allow",
          "bash": {
            "*": "allow",
            "git commit": "ask",
            "git commit *": "ask",
            "git push": "deny",
            "git push *": "deny"
          }
        }
      }) | .mcp = $mcp
    ' "$sess_cfg_file" > "$tmp_cfg" \
      && mv "$tmp_cfg" "$sess_cfg_file" \
      || rm -f "$tmp_cfg"
    cp -p "$sess_cfg_file" "$sess_share/config/opencode/.opencode.json"
  fi

  # Mount companion skill docs declared by active MCPs (e.g. proxmox SKILL.md)
  mcps_mount_skill_docs_for_session "$sess_share" 2>/dev/null || true

  # Build the AGENTS.mcps.md sidecar from active MCPs' agents_md_snippet
  # declarations. The VM-side AGENTS.md composition appends this after the
  # Host LAN IP block and before any ECC rules sidecar.
  mcps_build_agents_sidecar "$sess_share" "$vm_home" "$proj" 2>/dev/null || true

  # ECC (opt-in): copy plugin payload + optional MCP pack into session config,
  # seed homunculus learning store from persistent project state, auto-inject
  # language-specific rules into AGENTS.md.
  if ecc_enabled; then
    ecc_apply_to_session "$sess_share"
    ecc_apply_mcp_pack "$sess_cfg_file"
    ecc_seed_homunculus "$proj_state" "$sess_share"
    ecc_inject_rules "$proj" "$sess_share"
    cp -p "$sess_cfg_file" "$sess_share/config/opencode/.opencode.json"
  fi

  # Skills (independent of ECC enabled state — package guards handle dependencies)
  skills_mount_for_session "$sess_share" "$proj"

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

  # Lima's docker-rootful template creates a shared socket dir at ~/.lima/sock/
  # which Lima may misinterpret as a VM instance, causing fatal errors during
  # list/stop. Remove it before any status check to avoid spurious failures.
  rm -rf "$HOME/.lima/sock" 2>/dev/null || true

  # Install ProxmoxMCP into base VM (idempotent, only when proxmox skill is active).
  # Must run with base VM available — slot in BEFORE the stop-for-clone step.
  proxmox_ensure_installed_in_base || echo "[run] Proxmox MCP install skipped; session will start without it." >&2

  # Ensure base VM is stopped for clone — always attempt stop defensively
  if is_vm_running "$BASE_NAME"; then
    run_with_spinner "[run] Stopping base VM before clone..." limactl stop "$BASE_NAME"
  else
    # Defensively try stop even if status check says not running, in case
    # the status check was unreliable (e.g. transient lima state)
    limactl stop "$BASE_NAME" 2>/dev/null || true
    echo "[run] Base VM already stopped, ready for clone $(_ts)"
  fi

  # Upgrade path: patch base VM yaml if LAN port forwarding rule is missing.
  # This fixes existing installations where provision_base used the wrong grep
  # condition ('hostIP:' instead of 'guestIPMustBeZero: true'), causing the
  # catch-all rule to never be inserted because Docker's socket rule already
  # contains 'hostIP: 127.0.0.1'.
  local base_lima_yaml="$HOME/.lima/$BASE_NAME/lima.yaml"
  if ! grep -q 'guestIPMustBeZero: true' "$base_lima_yaml" 2>/dev/null; then
    echo "[run] Upgrading base VM: adding LAN port forwarding rule... $(_ts)"
    sed -i '' '/^portForwards:/a\
- guestIPMustBeZero: true\
  hostIP: 0.0.0.0
' "$base_lima_yaml"
    echo "[run] LAN port forwarding rule added to base VM $(_ts)"
  fi

  # Check for optional Desktop share directory
  # Use ls to verify actual access — macOS may block ~/Desktop even when -d succeeds
  local share_dir="$HOME/Desktop/opencode-share"
  local share_mount=""
  if [[ -d "$share_dir" ]] && ls "$share_dir" >/dev/null 2>&1; then
    echo "[run] Mounting Desktop share directory (read-write) $(_ts)"
    share_mount="yes"
  elif [[ -d "$share_dir" ]]; then
    echo "[run] Desktop share directory exists but is not accessible (grant Full Disk Access to your terminal) $(_ts)"
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
  printf 'SESS_NAME=%q\nSESS_PROJ=%q\nCFG_HASH_AT_START=%q\nSESS_MODE=%q\nSESS_PORT=%q\nSESS_KEEP_HISTORY=%q\n' \
    "$sess" "$proj" "$cfg_hash" "$SESSION_MODE" "${SESSION_PORT:-}" "${KEEP_HISTORY:-0}" > "$senv"

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
      # The mcp block is session-time state (injected fresh every start from
      # the MCPs registry + active MCPS_PACKAGES) and must NOT be persisted.
      # Strip it before writing back to project-state and host so stale
      # entries never leak into the next session's baseline.
      local persist_cfg="$sess_cfg.sanitized"
      if command -v jq >/dev/null 2>&1 && jq -e '.mcp' "$sess_cfg" >/dev/null 2>&1; then
        jq 'del(.mcp)' "$sess_cfg" > "$persist_cfg" 2>/dev/null || cp -p "$sess_cfg" "$persist_cfg"
      else
        cp -p "$sess_cfg" "$persist_cfg"
      fi

      cp -p "$persist_cfg" "$proj_cfg_cleanup"
      cp -p "$persist_cfg" "$proj_cfg_cleanup_legacy"

      local current_hash
      current_hash="$(md5 -q "$dst")"
      if [[ "$current_hash" != "$cfg_hash" ]]; then
        echo ""
        echo "Another session has edited the OpenCode config since this session started."
        read -r -p "Overwrite with this session's config? [y/N] " answer </dev/tty || answer="n"
        if [[ "$answer" =~ ^[Yy]$ ]]; then
          cp -p "$persist_cfg" "$dst"
        else
          local bak="$dst.session-bak-$(date +%Y%m%d-%H%M%S)"
          cp -p "$persist_cfg" "$bak"
          echo "Keeping existing config. Session config saved to: $bak"
        fi
      else
        cp -p "$persist_cfg" "$dst"
      fi
      rm -f "$persist_cfg"
    fi

    # Propagate only auth.json back to the host so provider changes made in
    # the UI stick — the global opencode.db is intentionally never touched.
    echo "[cleanup] Persisting session data... $(_ts)"
    local _sess_auth="$sess_share/xdg-data/opencode/auth.json"
    if [[ -f "$_sess_auth" ]]; then
      mkdir -p "$HOST_DATA_DIR"
      if [[ ! -f "$HOST_DATA_DIR/auth.json" ]] || [[ "$_sess_auth" -nt "$HOST_DATA_DIR/auth.json" ]]; then
        cp -p "$_sess_auth" "$HOST_DATA_DIR/auth.json"
      fi
    fi

    # Persist history to the mode-appropriate project-local destination.
    if [[ "${KEEP_HISTORY:-0}" -eq 1 ]]; then
      local ph_dir_out
      ph_dir_out="$(project_history_dir "$proj")"
      mkdir -p "$ph_dir_out/xdg-data/opencode" "$ph_dir_out/xdg-state/opencode"
      rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$sess_share/xdg-data/opencode/" "$ph_dir_out/xdg-data/opencode/"
      rsync -a "$sess_share/xdg-state/opencode/" "$ph_dir_out/xdg-state/opencode/"
      echo "[cleanup] Persisted into project history $(_ts)"
    else
      local fh_dir_out
      fh_dir_out="$(fresh_history_dir "$proj")/${sess#oc-}"
      mkdir -p "$fh_dir_out/xdg-data/opencode" "$fh_dir_out/xdg-state/opencode"
      rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$sess_share/xdg-data/opencode/" "$fh_dir_out/xdg-data/opencode/"
      rsync -a "$sess_share/xdg-state/opencode/" "$fh_dir_out/xdg-state/opencode/"
      echo "[cleanup] Persisted fresh snapshot: $fh_dir_out $(_ts)"
    fi

    # Keep project-state as a local cache (harmless; cleared on next fresh start).
    rsync -a "${DATA_RSYNC_EXCLUDES[@]}" "$sess_share/xdg-data/opencode/" "$proj_state/xdg-data/opencode/"
    rsync -a "$sess_share/xdg-state/opencode/" "$proj_state/xdg-state/opencode/"
    echo "[cleanup] Project-state cache updated $(_ts)"

    # Persist any updated graphify graph back to the per-project store.
    graphify_persist_save_for_session "$proj" "$sess_share" 2>/dev/null || true

    # ECC: persist project-scoped homunculus learnings back to host project state.
    if ecc_enabled; then
      ecc_sync_homunculus_back "$sess_share" "$proj_state"
      echo "[cleanup] ECC homunculus synced back $(_ts)"
    fi

    # Prevent corrupt databases from persisting across sessions (restore from pre-session backup if needed)
    echo "[cleanup] SQLite integrity checks... $(_ts)"
    local db_backup_dir="$proj_state/db-backups"
    check_sqlite_integrity "$proj_state/xdg-data/opencode" "$db_backup_dir/xdg-data"
    check_sqlite_integrity "$proj_state/xdg-state/opencode" "$db_backup_dir/xdg-state"
    echo "[cleanup] SQLite integrity checks done $(_ts)"

    if [[ -n "${sess:-}" ]]; then
      if [[ "${OC_SHELL_OK:-}" != "1" ]]; then
        # Abnormal exit (crash, Ctrl-C before opencode ran): leave the VM
        # running so the user can 'opencode-vm attach' and recover.
        echo "[cleanup] Session VM '$sess' kept running for re-attach. $(_ts)"
        echo "[cleanup] Use 'opencode-vm attach' to reconnect, or 'opencode-vm start' to choose."
      else
        local _exit_action
        _exit_action="$(_decide_cleanup_action)"
        case "$_exit_action" in
          keep)
            echo "[cleanup] Stopping session VM (kept for resume): $sess $(_ts)"
            stop_host_port_forwards_in_vm "$sess"
            limactl stop "$sess" 2>/dev/null || true
            echo "[cleanup] Session VM stopped — disk clone and session env retained. $(_ts)"
            echo "[cleanup] Resume with 'opencode-vm start' (choose 'r') or 'opencode-vm attach'."
            _notify_kept_session_once
            ;;
          delete)
            echo "[cleanup] Stopping and deleting session VM: $sess $(_ts)"
            stop_host_port_forwards_in_vm "$sess"
            rm -f "$senv"
            rm -rf "$sess_share"
            limactl stop "$sess" 2>/dev/null || true
            echo "[cleanup] Session VM stopped $(_ts)"
            limactl delete -f "$sess" >/dev/null 2>&1 || true
            echo "[cleanup] Session VM deleted $(_ts)"
            ;;
        esac
      fi
    fi
    # Remove clean mount symlink if created
    [[ -n "${clean_link:-}" ]] && rm -f "$clean_link"
  }
  trap cleanup EXIT

  run_with_spinner "[run] Starting session VM..." limactl start "$sess" --tty=false

  echo "[run] Applying firewall policy... $(_ts)"
  apply_policy_in_vm "$sess"
  if ! setup_host_port_forwards_in_vm "$sess"; then
    echo "[run] WARNING: localhost forwarding setup failed; use host.lima.internal as fallback" >&2
  fi
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

  # ECC: link the mounted homunculus share into ECC's expected project path.
  if ecc_enabled; then
    local _ecc_proj_hash
    _ecc_proj_hash="$(ecc_compute_project_hash "$proj")"
    ecc_link_homunculus_in_vm "$sess" "$sess_share" "$_ecc_proj_hash"
    echo "[run] ECC homunculus linked (project hash: $_ecc_proj_hash) $(_ts)"
  fi

  echo "[run] Launching OpenCode inside VM (project: $proj) $(_ts)"

  local host_lan_ip
  host_lan_ip="$(get_host_ip)"
  echo "[run] Host LAN IP: ${host_lan_ip} $(_ts)"

  if limactl shell --workdir / "$sess" -- bash -lc '
    set -euo pipefail
    PROJ_DIR="$1"
    SESS_SHARE="$2"
    OC_MODE="$3"
    OC_PORT="$4"
    OC_PASSWORD="$5"
    OC_WEB_TUI="$6"
    OC_HOST_IP="$7"
    export OCVM_HOST_LAN_IP="$OC_HOST_IP"
    export HOST_LAN_IP="$OC_HOST_IP"
    export LANIP="$OC_HOST_IP"

    export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.config/composer/vendor/bin:/tmp/go/bin:/tmp/pnpm-store:$PATH"

    # Config stays on mount (small JSON files, safe over virtiofs)
    export XDG_CONFIG_HOME="$SESS_SHARE/config"

    # ECC project identity: stable hash across sessions uses host project path
    if [ -f "$SESS_SHARE/config/opencode/.ecc-applied" ]; then
      export CLAUDE_PROJECT_DIR="$PROJ_DIR"
    fi

    # Make VM environment instructions available to OpenCode
    mkdir -p "$SESS_SHARE/config/opencode"
    if [ -f "$HOME/AGENTS.md" ]; then
      cp -p "$HOME/AGENTS.md" "$SESS_SHARE/config/opencode/AGENTS.md"
      cat >> "$SESS_SHARE/config/opencode/AGENTS.md" <<EOF

## Host LAN IP (Session)

- **Current host LAN IP:** \`$OC_HOST_IP\`
- **Environment variables:** \`OCVM_HOST_LAN_IP\` (canonical), \`HOST_LAN_IP\`, \`LANIP\`
- When suggesting URLs for services bound to \`0.0.0.0\` in the VM, prefer \`http://$OC_HOST_IP:<port>\` over \`localhost\`.
EOF
      # Append per-MCP AGENTS snippets sidecar (active MCPs that declare one)
      if [ -s "$SESS_SHARE/config/opencode/AGENTS.mcps.md" ]; then
        cat "$SESS_SHARE/config/opencode/AGENTS.mcps.md" >> "$SESS_SHARE/config/opencode/AGENTS.md"
      fi
      # Append ECC rules sidecar if host-side injector produced one
      if [ -f "$SESS_SHARE/config/opencode/AGENTS.ecc-rules.md" ]; then
        cat "$SESS_SHARE/config/opencode/AGENTS.ecc-rules.md" >> "$SESS_SHARE/config/opencode/AGENTS.md"
      fi
    fi

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

    cd "$PROJ_DIR"

    case "$OC_MODE" in
      shell)
        echo "[shell] Interactive shell started in session VM."
        echo "[shell] Exit this shell to return to host terminal."
        bash
        ;;
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
          echo "  Username:        opencode"
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
  ' _ "$proj" "$sess_share" "$SESSION_MODE" "${SESSION_PORT:-0}" "${SESSION_PASSWORD:-}" "${OC_WEB_TUI:-false}" "$host_lan_ip"; then
    if [[ "$SESSION_MODE" != "shell" ]]; then
    OC_SHELL_OK=1
    fi
  fi
}

skills_cmd() {
  local op="${1:-status}"
  shift || true

  case "$op" in
    status|"")
      skills_load
      echo "active packages: ${SKILLS_PACKAGES:-<none>}"
      if [[ -z "${SKILLS_PACKAGES:-}" ]]; then
        echo ""
        echo "No opt-in skill packages active. Enable one with:"
        echo "  opencode-vm skills on ecc-auto   # language-filtered subset (~30 skills)"
        echo "  opencode-vm skills on ecc-all    # every ECC skill (~180 skills, token-heavy)"
        echo ""
        echo "Looking for Proxmox? It is now an MCP:"
        echo "  opencode-vm mcps on proxmox"
        return 0
      fi
      local path="${1:-$(pwd)}"
      local langs
      langs="$(detect_project_languages "$path")"
      echo "project:         $path"
      echo "detected langs:  $langs"
      echo ""
      # Always-active packages from registry are included even if missing from SKILLS_PACKAGES.
      local all_status_pkgs="$SKILLS_PACKAGES"
      local _always
      while IFS= read -r _always; do
        [[ -n "$_always" ]] || continue
        case " $all_status_pkgs " in *" $_always "*) ;; *) all_status_pkgs="${all_status_pkgs:+$all_status_pkgs }$_always" ;; esac
      done < <(skills_registry_always_active)
      local pkg total=0
      for pkg in $all_status_pkgs; do
        local names count
        names="$(skills_resolve_pkg "$pkg" "$langs")"
        count=$(printf '%s\n' "$names" | grep -c . || true)
        total=$((total + count))
        echo "[$pkg] $count skills"
        if [[ -n "$names" ]]; then
          printf '%s\n' "$names" | sed 's/^/  - /'
        fi
        echo ""
      done
      local est
      est="$(_skills_estimate_tokens "$total")"
      echo "Total: ${total} skills, estimated ${est} tokens of frontmatter."
      ;;
    on)
      local pkg="${1:-}"
      [[ -n "$pkg" ]] || { echo "Usage: opencode-vm skills on <ecc-auto|ecc-all|webimg>" >&2; exit 2; }
      skills_pkg_on "$pkg"
      ;;
    off)
      local pkg="${1:-}"
      [[ -n "$pkg" ]] || { echo "Usage: opencode-vm skills off <ecc-auto|ecc-all|webimg>" >&2; exit 2; }
      skills_pkg_off "$pkg"
      ;;
    list)
      # Preview: what would mount at the given project path with current active packages.
      local path="${1:-$(pwd)}"
      skills_load
      local langs
      langs="$(detect_project_languages "$path")"
      echo "project:         $path"
      echo "detected langs:  $langs"
      echo ""
      # Always-active packages from registry are previewed even if missing from SKILLS_PACKAGES.
      local all_list_pkgs="${SKILLS_PACKAGES:-}"
      local _always
      while IFS= read -r _always; do
        [[ -n "$_always" ]] || continue
        case " $all_list_pkgs " in *" $_always "*) ;; *) all_list_pkgs="${all_list_pkgs:+$all_list_pkgs }$_always" ;; esac
      done < <(skills_registry_always_active)
      local pkg total=0
      for pkg in $all_list_pkgs; do
        local names
        names="$(skills_resolve_pkg "$pkg" "$langs")"
        [[ -n "$names" ]] || continue
        local count
        count=$(printf '%s\n' "$names" | grep -c . || true)
        total=$((total + count))
        echo "[$pkg] would mount $count skills:"
        printf '%s\n' "$names" | sed 's/^/  - /'
        echo ""
      done
      local est
      est="$(_skills_estimate_tokens "$total")"
      echo "Total: ${total} skills, estimated ${est} tokens."
      ;;
    *)
      cat >&2 <<EOF
Usage:
  opencode-vm skills                      # status (alias)
  opencode-vm skills status [path]        # active packages + resolved skills + token estimate
  opencode-vm skills on <pkg>             # enable package (ecc-auto | ecc-all | webimg)
  opencode-vm skills off <pkg>            # disable package
  opencode-vm skills list [path]          # preview what would mount (no VM touch)

  opencode-vm mcps                        # MCP status (alias)
  opencode-vm mcps list                   # list all MCPs (active/default markers)
  opencode-vm mcps on <name>              # enable MCP (playwright | repomapper | proxmox)
  opencode-vm mcps off <name>             # disable MCP (proxmox: also wipes credentials)

Note: Proxmox moved to the mcps subsystem in v0.4.4 — use 'opencode-vm mcps'.
EOF
      exit 2 ;;
  esac
}

ocvm_notify_if_new_version_available "$cmd"

case "$cmd" in
  install)
    install_cmd
    ;;

  skills)
    skills_cmd "$@"
    ;;

  mcps)
    mcps_cmd "$@"
    ;;

  init)
    need limactl
    sanitize_lima_sock_dir

    # init no longer takes ECC-specific flags; ECC is managed via `skills on/off ecc-*`.
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        *) echo "[init] Unknown option: $1" >&2; exit 2 ;;
      esac
    done

    cleanup_sessions
    if base_exists; then
      echo "[init] Stopping and deleting existing base VM: $BASE_NAME"
      limactl stop "$BASE_NAME" 2>/dev/null || true
      if ! limactl delete -f "$BASE_NAME"; then
        sanitize_lima_sock_dir
        limactl delete -f "$BASE_NAME" 2>/dev/null || true
      fi
    fi
    # Clean up shared socket dir that Lima's docker-rootful template creates;
    # leftover after VM deletion it confuses limactl into a fatal error.
    rm -rf "$HOME/.lima/sock" 2>/dev/null || true
    provision_base
    echo
    echo "Next: navigate to your project directory (open terminal in VS Code) and run:"
    echo "  opencode-vm start"
    echo
    skills_load
    echo "Built-in skill: webimg (web image optimization pipeline, always active)"
    if [[ -n "${SKILLS_PACKAGES:-}" ]]; then
      echo "Active skill packages: ${SKILLS_PACKAGES}"
      echo "These will be applied automatically on next 'opencode-vm start'."
    else
      echo "Optional skill packages (enable any time):"
      echo "  opencode-vm skills on ecc-auto   # language-filtered ECC skills (auto-clones ECC)"
      echo "  opencode-vm skills on ecc-all    # every ECC skill (token-heavy)"
      echo ""
      echo "  opencode-vm mcps on proxmox      # Proxmox VE API via ProxmoxMCP (separate subsystem)"
      echo "  opencode-vm mcps on repomapper   # PageRank codebase maps"
    fi
    ;;

  start|run)
    parse_start_flags "$@"
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

  doctor)
    doctor_cmd "$@"
    ;;

  provider)
    provider_cmd "$@"
    ;;


  shell)
    need limactl
    proj="$(pwd)"
    senv="$(session_env "$proj")"
    if [[ ! -f "$senv" ]]; then
      echo "[shell] No running session found. Starting one now..."
      SESSION_MODE="shell"
      start_session
      exit 0
    fi
    # shellcheck disable=SC1090
    source "$senv"
    if ! is_vm_running "$SESS_NAME"; then
      echo "[shell] Existing session record found, but VM is not running. Starting a fresh session..."
      rm -f "$senv"
      SESSION_MODE="shell"
      start_session
      exit 0
    fi
    echo "[shell] Connecting to session: $SESS_NAME (project: $proj)"
    enter_session_shell "$SESS_NAME" "$proj" "$(get_host_ip)" "$(session_share_dir "$proj")"
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
  opencode-vm start [--keep-history] [--reconnect|--fresh|--cancel-if-exists]
                                           # start a session VM in current directory
                                           # If a session already exists, prompts:
                                           #   r = reconnect (resume if stopped)
                                           #   f = fresh (destroy and recreate)
                                           #   c = cancel
                                           # On clean exit: prompts [K]eep (default) / [d]elete.
                                           # Kept VMs are stopped but retained on disk —
                                           # resume via start (choose 'r') or 'attach'.
                                           # --keep-history: load project history
                                           #   from ~/.opencode-vm/project-history/
                                           # --reconnect/--fresh/--cancel-if-exists:
                                           #   non-interactive override of the prompt
  opencode-vm web [--port PORT] [--password PW] [--tui] [--keep-history] [--reconnect|--fresh|--cancel-if-exists]
                                           # start web server session (default port 4096)
                                           # provides: web UI, REST API, TUI attach
                                           # Session prompt/exit behavior matches 'start'.
                                           # --tui: also start TUI in terminal (experimental)
                                           # --keep-history: load project-specific history
                                           #   (default starts with empty session list)
  opencode-vm attach                       # reconnect to the project's session VM
                                           # (auto-starts a stopped-but-kept VM)
  opencode-vm shell                        # open shell in session VM (auto-starts if missing)
  opencode-vm init                         # create/provision base VM (one-time setup)
                                           # Skill + MCP packages stay at their defaults —
                                           # manage later via 'opencode-vm skills|mcps on/off <pkg>'.
  opencode-vm skills {status|on|off|list} [pkg|path]
                                           # manage skill packages (knowledge-only markdown)
                                           # packages (registry: skills/registry.json):
                                           #   webimg    — default on; web image optimization pipeline
                                           #               (CLI tools pre-installed in base VM)
                                           #   ecc-auto  — ~30 skills, filtered to project languages
                                           #               (auto-clones ECC on first enable)
                                           #   ecc-all   — ~180 skills, every ECC skill (token-heavy)
  opencode-vm mcps {status|list|on|off} [name]
                                           # manage MCP servers (tools the agent can call)
                                           # MCPs (registry: mcps/registry.json):
                                           #   playwright — default on; headless browser automation
                                           #   repomapper — default off; PageRank codebase maps
                                           #   proxmox    — default off; Proxmox VE API via ProxmoxMCP
                                           #                'on' prompts interactively for host + API token;
                                           #                'off' disables AND wipes stored credentials.
  opencode-vm ports show                   # show current firewall policy
  opencode-vm ports host {show|add|rm|set} [PORT...]
  opencode-vm ports hostfwd {show|enable|disable}
  opencode-vm ports lan tcp {show|add|rm|clear} IP[:PORT]
  opencode-vm ports lan udp {show|add|rm|clear} IP[:PORT]
  opencode-vm doctor [show]                # inspect local sync/auth/model/db state
  opencode-vm provider list                # list configured providers
  opencode-vm provider new                 # add new openai-compatible provider (interactive)
  opencode-vm provider refresh <id>        # re-discover models from /v1/models (auto-runs at session start
                                           #   for local providers; OCVM_PROVIDER_AUTOREFRESH=0 disables)
  opencode-vm provider rm <id> [--dry-run] # remove provider from auth/config/model state
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

Environment variables:
  OCVM_ON_EXIT=keep|delete|ask             # override the exit prompt default
                                           # keep (default for non-TTY) / delete / ask

Tip:
  Create ~/Desktop/opencode-share/ to share files (e.g. images) with the VM.
EOF
    exit 2
    ;;
esac
