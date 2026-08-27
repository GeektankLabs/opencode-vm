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
KEPT_SESSION_NOTIFIED_MARKER="$SHARE_ROOT/.kept-session-notified"

# Per-project VM sizing. The shared base VM is always provisioned at these
# values; a project that needs more (or less) stores an override in its own
# project-state dir, applied at clone time. Keeping the override off the base VM
# means one heavyweight project can't inflate every other project's session VM.
# provision_base() uses these same constants, so the base VM and the "default"
# column of 'opencode-vm ram|cpu show' can never drift apart.
DEFAULT_VM_MEMORY_GIB=8
MIN_VM_MEMORY_GIB=2
DEFAULT_VM_CPUS=6
MIN_VM_CPUS=1

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

# Web Image Pipeline skill package (built-in, default active — CLI tools in base VM)
WEBIMG_SKILL_CACHE="$SHARE_ROOT/webimg-skill"      # fallback if script is not co-located with bundled skills/
# SSH toolkit skill package (built-in, default active — CLI tools in base VM)
SSH_SKILL_CACHE="$SHARE_ROOT/ssh-toolkit-skill"    # fallback if script is not co-located with bundled skills/
DEFAULT_PROXMOX_MCP_REPO="https://github.com/canvrno/ProxmoxMCP.git"
DEFAULT_PROXMOX_MCP_REF="main"

# SearXNG MCP (built-in, default active — account-free metasearch container in base VM)
SEARXNG_VM_DIR='/var/lib/ocvm-searxng'   # path inside oc-base; holds compose, settings, secret_key
SEARXNG_PORT=8888                         # browser-safe; not in BROWSER_UNSAFE_PORTS
SEARXNG_MCP_NPM_VERSION="1.0.3"           # pin for reproducible installs in provision_base

# A2A adapter (Intelligent-Internet/opencode-a2a). Pinned, not floating: a base
# image is cloned for months, and this speaks a versioned wire protocol to
# external orchestrators. 1.2.0 is the release this integration was built and
# tested against — later versions add Origin/Host enforcement that has to be
# re-checked against our proxy before the pin moves.
OCVM_A2A_SPEC="opencode-a2a==1.2.0"
OCVM_A2A_VENV='$HOME/.local/share/opencode-a2a-venv'
# Bump when the install recipe changes, so existing bases re-provision.
OCVM_A2A_STAMP_VERSION="1"
# Fixed default credential when the session has no --password. Deliberately a
# documented constant rather than a generated secret: opencode-a2a refuses to
# start without a credential, and a hidden random token would be worse than a
# known one — nobody could find it, and it would rotate on every restart.
OCVM_A2A_DEFAULT_SECRET="opencode-vm"
# Script location (for resolving bundled skills/proxmox/mcps when running from
# repo). Must follow symlinks: `opencode-vm install` copies the script to
# ~/bin/opencode-vm, but users who instead symlink ~/bin/opencode-vm at the
# repo's opencode-vm.sh would hit a naive `dirname "${BASH_SOURCE[0]}"`
# resolving to ~/bin — making the bundled mcps/registry.json invisible and
# forcing a fall-back to a stale on-disk cache that may pre-date recently-added
# MCPs (graphify lived this exact bug).
# Portable across macOS (BSD readlink, no -f) and Linux (GNU readlink).
_ocvm_resolve_script_dir() {
  local src="${BASH_SOURCE[0]}"
  while [ -L "$src" ]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}
SCRIPT_DIR="$(_ocvm_resolve_script_dir)"
unset -f _ocvm_resolve_script_dir

# Force Lima's SSH-based port forwarder for ALL `limactl start`/`clone --start`
# invocations below. Lima >= 1.1 defaults to the gRPC forwarder, which silently
# fails to relay VM->host TCP for vz + Docker instances: the host listener is
# created and accepts the connection, but no data ever flows (curl connects then
# times out). This breaks the core promise that a container port published in the
# VM is reachable on the host as localhost:PORT. The SSH forwarder relays
# correctly (verified). See lima-vm/lima#3355 and https://lima-vm.io/docs/config/port/.
# Caveat: the SSH forwarder does not support UDP forwarding (TCP web services are
# unaffected). Must be exported before any `limactl start` so the hostagent inherits it.
export LIMA_SSH_PORT_FORWARDER=true

# Excludes for xdg-data rsync: bin/ (375M, 28k files — downloaded on demand),
# log/ (old session logs), tool-output/ (previous session artifacts)
DATA_RSYNC_EXCLUDES=(--exclude='bin/' --exclude='log/' --exclude='tool-output/')

# Defaults
DEFAULT_HOST_TCP_PORTS="1234 8888 11434"   # LM Studio + SearXNG (MCP) + Ollama
DEFAULT_LAN_ALLOW_TCP=""              # z.B. "192.168.178.10:443 10.0.0.5:22" (ohne :PORT = alle TCP-Ports dieser IP)
DEFAULT_LAN_ALLOW_UDP=""              # z.B. "192.168.178.20:53"              (ohne :PORT = alle UDP-Ports dieser IP)
DEFAULT_HOST_LOCALHOST_FORWARD="yes"  # expose HOST_TCP_PORTS inside VM as localhost:PORT
DEFAULT_OC_PORT=4096                  # OpenCode web/API server port

# Self-update metadata
SCRIPT_NAME="opencode-vm.sh"
OCVM_VERSION="0.5.21"
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

# Run a script inside a VM via a login shell (profile PATH available).
# Usage: vm_exec <vm> <script> [args...]
# Host values must be passed as positional args — never interpolated into the
# script string — so they reach the guest strictly as data ($1, $2, ... in the
# script). This is the injection-safe pattern for all host→VM calls.
vm_exec() {
  local vm="$1" script="$2"
  shift 2
  # --tty=false: never let Lima open a TUI prompt (e.g. "Do you want to start
  # the instance now?" against a stopped VM since Lima 2.x) — fail fast
  # instead. Does not affect ssh PTY allocation, which Lima decides via
  # isatty(stdout), so interactive sessions through here are unaffected.
  limactl shell --workdir / --tty=false "$vm" -- bash -lc "$script" _ "$@"
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

# A web session owns a contiguous block of ports. Externally:
#
#   P      web  HTTPS      P+2    a2a HTTPS
#   P+1    web  HTTP       P+3    a2a HTTP
#
# and inside the VM, never tunnelled to the LAN:
#
#   P-1    opencode backend
#   P-2    opencode-a2a
#
# The offsets are a public contract — the A2A agent card has to advertise an
# absolute URL, so they can never be allowed to drift apart. That is why the
# whole block moves together on a collision, and why the host port and the VM
# port are now the same number.
validate_web_port() {
  local p="$1"
  if ! is_valid_port "$p" || (( p < 1026 || p > 65532 )); then
    echo "Invalid --port value: $p" >&2
    echo "opencode-vm web reserves a block around the base port:" >&2
    echo "  P-2  opencode-a2a      (VM-internal)" >&2
    echo "  P-1  opencode backend  (VM-internal)" >&2
    echo "  P    web HTTPS         P+1  web HTTP" >&2
    echo "  P+2  a2a HTTPS         P+3  a2a HTTP" >&2
    echo "so the base port must be between 1026 and 65532." >&2
    exit 2
  fi
  # Refuse, don't warn: web mode exists for browsers, and browsers refuse
  # these ports outright (ERR_UNSAFE_PORT) no matter what listens there. A
  # mid-scroll warning gets missed while the closing banner still advertises
  # the dead URLs — so an explicit --port must fail loudly instead.
  local u
  for u in "$p" $((p + 1)) $((p + 2)) $((p + 3)); do
    if is_browser_unsafe_port "$u"; then
      echo "Browser-blocked --port value: $p" >&2
      echo "Port $u of the public block $p..$((p + 3)) is on the browsers' hardcoded" >&2
      echo "unsafe-port list — Chrome/Firefox/Safari refuse to connect (ERR_UNSAFE_PORT)," >&2
      echo "so the web UI and the A2A agent card would be unreachable from any browser." >&2
      echo "Browser-safe alternatives: 4096 (default), 5555, 7777, 8080, 8888, 9000+" >&2
      exit 2
    fi
  done
  return 0
}

# True when something already holds 0.0.0.0:<port>. Listeners bound only to
# 127.0.0.1 are not a conflict — that is how our tunnels coexist with Lima's
# own loopback auto-forward.
_port_wildcard_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' \
    | grep -qE '(^\*|^0\.0\.0\.0|^\[::\]|^\[::0\]):'
}

# Can we bind 0.0.0.0:<port> for <vm>? Reclaims a dead tunnel of our own on the
# way — a web session that ends without its EXIT trap (closed terminal, SIGHUP,
# a laptop that slept) leaves the forward holding the port with nothing behind
# it, and the next start would otherwise refuse the very port the user always
# uses. Returns, never exits: the caller shifts the whole block instead.
_port_free_for_bind() {
  local port="$1" own_pids _tp _wait
  if ! _port_wildcard_busy "$port"; then
    # The policy socat units bind these same numbers on 127.0.0.1 inside the
    # VM, where they would silently shadow a proxy of ours.
    case " ${HOST_TCP_PORTS:-} " in *" $port "*) return 1 ;; esac
    return 0
  fi
  own_pids="$(pgrep -f "ssh -f -N .*-L 0\.0\.0\.0:${port}:127\.0\.0\.1:" 2>/dev/null || true)"
  [[ -n "$own_pids" ]] || return 1
  if curl -fsSk -o /dev/null --max-time 3 "https://127.0.0.1:${port}/" 2>/dev/null ||
     curl -fsS  -o /dev/null --max-time 3 "http://127.0.0.1:${port}/"  2>/dev/null; then
    return 1   # a live session — another project. Shift.
  fi
  echo "[tunnel] Port $port was held by a stale tunnel from an earlier session — reclaiming it."
  for _tp in $own_pids; do kill "$_tp" 2>/dev/null || true; done
  rm -f /tmp/ocvm-tunnel-*-"${port}".pid
  for _wait in 1 2 3 4 5 6 7 8 9 10; do
    _port_wildcard_busy "$port" || return 0
    sleep 0.3
  done
  return 1
}

parse_web_flags() {
  SESSION_PORT="$DEFAULT_OC_PORT"
  SESSION_PASSWORD=""
  # "" = keep whatever the session already has (so a bare reconnect does not
  # silently unprotect it), "set" = adopt SESSION_PASSWORD, "clear" = --no-auth.
  SESSION_AUTH_MODE=""
  SESSION_REQUIRE_A2A=0
  SESSION_A2A="${OCVM_A2A:-1}"
  local _saw_password="" _saw_no_auth=""
  OC_WEB_TUI=false
  # HTTPS by default: opencode hashes attachments via crypto.subtle, which
  # browsers expose only to secure origins, so plain HTTP over a LAN address
  # silently breaks file/image uploads. --no-tls opts back out.
  SESSION_TLS=1
  KEEP_HISTORY=0
  ON_EXISTING=""   # "", "reconnect", "fresh", "cancel"
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --port)   shift; SESSION_PORT="${1:?Missing port value}" ;;
      --port=*) SESSION_PORT="${1#*=}" ;;
      --password)   shift; SESSION_PASSWORD="${1:?Missing password value}"; SESSION_AUTH_MODE="set"; _saw_password=1 ;;
      --password=*) SESSION_PASSWORD="${1#*=}"; SESSION_AUTH_MODE="set"; _saw_password=1 ;;
      --no-auth) SESSION_AUTH_MODE="clear"; SESSION_PASSWORD=""; _saw_no_auth=1 ;;
      --require-a2a) SESSION_REQUIRE_A2A=1 ;;
      --no-a2a) SESSION_A2A=0 ;;
      --tui) OC_WEB_TUI=true ;;
      --tls) SESSION_TLS=1 ;;
      --no-tls) SESSION_TLS=0 ;;
      --keep-history) KEEP_HISTORY=1 ;;
      --reconnect) ON_EXISTING="reconnect" ;;
      --fresh) ON_EXISTING="fresh" ;;
      --cancel-if-exists) ON_EXISTING="cancel" ;;
      *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
  done

  # --password and --no-auth say opposite things about the same session.
  if [[ -n "${_saw_password:-}" && -n "${_saw_no_auth:-}" ]]; then
    echo "--password and --no-auth are mutually exclusive." >&2
    exit 2
  fi

  # Host environment as a fallback source of the secret, so it never has to
  # appear on a command line (where it lands in the shell history and in ps).
  if [[ -z "$SESSION_AUTH_MODE" ]]; then
    if [[ -n "${OCVM_WEB_PASSWORD:-}" ]]; then
      SESSION_PASSWORD="$OCVM_WEB_PASSWORD"
      SESSION_AUTH_MODE="set"
    elif [[ -n "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
      SESSION_PASSWORD="$OPENCODE_SERVER_PASSWORD"
      SESSION_AUTH_MODE="set"
    fi
  fi
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

# Per-project VM sizing overrides. Lives inside the project-state dir so it is
# keyed by project path like every other per-project artefact, and stays out of
# the project's own working tree (and therefore out of the VM's mount).
project_vm_env() {
  echo "$(project_state_dir "$1")/vm.env"
}

is_vm_running() {
  local vm_name="$1"
  sanitize_lima_sock_dir
  # Lima >=2.1.0 dropped --status, so use --format and match Name+Status pair.
  # The trailing whitespace anchor prevents prefix matches (e.g. "oc-base" vs
  # "oc-base-2"). Output line shape: "<name> <status>".
  # Query the named instance explicitly: a bare `limactl list --format` loads
  # EVERY instance dir and dies fatally if a phantom ~/.lima/sock/ exists (the
  # docker-rootful hostSocket recreates it faster than sanitize can clear it),
  # which would falsely report a running VM as down. Naming the instance only
  # warns (to stderr) and still emits the row, so the check stays correct.
  limactl list "$vm_name" --format '{{.Name}} {{.Status}}' 2>/dev/null \
    | grep -qx "$vm_name Running"
}

ensure_host_opencode_dirs() {
  mkdir -p "$HOST_CFG_DIR" "$HOST_DATA_DIR" "$HOST_STATE_DIR"
}

# Deep-merge two opencode config JSONs into $3 so neither side loses a provider:
# $2 (overlay) wins on conflicting keys; keys present only in $1 (base) survive.
# `jq '.[0] * .[1]'` merges recursively with the right operand winning. Returns
# non-zero and writes nothing when jq is missing or the result is empty/invalid,
# so every caller can fall back to a plain copy. This is the single place that
# defines "merge, don't clobber" for the host/project/session config triangle.
# Caveat: union semantics mean an intentional provider deletion must be applied
# to every copy (or via `provider rm`) — anything still present in the other
# copy is re-added on the next merge.
_cfg_merge() {
  local base="$1" overlay="$2" out="$3"
  command -v jq >/dev/null 2>&1 || return 1
  [[ -f "$base" && -f "$overlay" ]] || return 1
  local tmp; tmp="$(mktemp)"
  if jq -s '.[0] * .[1]' "$base" "$overlay" > "$tmp" 2>/dev/null \
     && [[ -s "$tmp" ]] && jq -e . "$tmp" >/dev/null 2>&1; then
    mv "$tmp" "$out"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# Run a jq filter over a JSON file and replace it atomically. Guarded: the
# file is only replaced when jq succeeds AND produced non-empty valid JSON;
# on failure the file is left untouched and the temp file is cleaned up.
# Usage: jq_inplace <file> <jq-args...>
jq_inplace() {
  local file="$1"; shift
  command -v jq >/dev/null 2>&1 || return 1
  [[ -f "$file" ]] || return 1
  local tmp; tmp="$(mktemp)"
  if jq "$@" "$file" > "$tmp" 2>/dev/null \
     && [[ -s "$tmp" ]] && jq -e . "$tmp" >/dev/null 2>&1; then
    mv "$tmp" "$file"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

sync_cfg_between_host_and_project() {
  local host_cfg="$1"
  local proj_cfg="$2"

  mkdir -p "$(dirname "$proj_cfg")"

  if [[ -f "$proj_cfg" ]] && [[ -f "$host_cfg" ]]; then
    if ! cmp -s "$proj_cfg" "$host_cfg"; then
      local host_mtime proj_mtime newer older
      host_mtime="$(stat -f %m "$host_cfg" 2>/dev/null || echo 0)"
      proj_mtime="$(stat -f %m "$proj_cfg" 2>/dev/null || echo 0)"
      # The newer file wins on scalar/conflicting keys.
      if (( host_mtime >= proj_mtime )); then
        newer="$host_cfg"; older="$proj_cfg"
      else
        newer="$proj_cfg"; older="$host_cfg"
      fi
      # Deep-MERGE rather than wholesale-copy: a provider added on one side must
      # not nuke providers defined on the other (the old `cp` did exactly that —
      # editing the host to provider X silently dropped provider Y still held in
      # a project's stored config on the next session start). Write the UNION to
      # BOTH files so they converge and stop ping-ponging.
      local _merged
      _merged="$(mktemp)"
      if _cfg_merge "$older" "$newer" "$_merged"; then
        cp -p "$_merged" "$host_cfg"
        cp -p "$_merged" "$proj_cfg"
      else
        # No jq / merge failed — preserve the legacy newer-wins wholesale copy.
        cp -p "$newer" "$host_cfg"
        cp -p "$newer" "$proj_cfg"
      fi
      rm -f "$_merged"
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
    if [[ "$result" == "error" || -z "$result" ]]; then
      # Could not read the db at all — usually a live writer holding the lock
      # (an active or orphaned session). The .dump recovery would fail the
      # same way and end in deleting a healthy live database, so leave it
      # untouched. Only an explicit integrity verdict may trigger recovery.
      echo "[sqlite] Skipping integrity check (busy or unreadable): $db"
      continue
    fi
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
    if [[ "$result" == "error" || -z "$result" ]]; then
      # Unreadable (usually locked by a live writer) — see
      # check_sqlite_integrity: never treat that as corruption.
      echo "[sqlite] Skipping integrity check (busy or unreadable): $db"
      continue
    fi
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

# A valid host port is a plain integer 1–65535. Rejecting anything else keeps
# policy.env (sourced on the host) and the in-VM nft command free of
# shell-metacharacter injection.
is_valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 ))
}

ensure_policy_file() {
  ensure_dirs
  if [[ ! -f "$POLICY_ENV" ]]; then
    HOST_TCP_PORTS="$DEFAULT_HOST_TCP_PORTS"
    LAN_ALLOW_TCP="$DEFAULT_LAN_ALLOW_TCP"
    LAN_ALLOW_UDP="$DEFAULT_LAN_ALLOW_UDP"
    HOST_LOCALHOST_FORWARD="$DEFAULT_HOST_LOCALHOST_FORWARD"
    save_policy
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
  # Scrub hand-edited values: keep only valid port tokens so nothing but
  # digits ever reaches the in-VM nft command.
  local _p _clean=""
  for _p in $HOST_TCP_PORTS; do
    if is_valid_port "$_p"; then
      _clean="${_clean:+$_clean }$_p"
    else
      echo "[policy] WARN: ignoring invalid HOST_TCP_PORTS entry in $POLICY_ENV: $_p" >&2
    fi
  done
  HOST_TCP_PORTS="$_clean"
}

save_policy() {
  {
    echo "# opencode-vm policy (host)"
    printf 'HOST_TCP_PORTS=%q\n' "$HOST_TCP_PORTS"
    printf 'LAN_ALLOW_TCP=%q\n' "$LAN_ALLOW_TCP"
    printf 'LAN_ALLOW_UDP=%q\n' "$LAN_ALLOW_UDP"
    printf 'HOST_LOCALHOST_FORWARD=%q\n' "$HOST_LOCALHOST_FORWARD"
  } > "$POLICY_ENV"
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

# Normalize + validate a LAN allowlist endpoint for `ports lan {tcp,udp}`.
# IPv4 only (the nft LAN sets are ipv4_addr). Accepts these forms and prints the
# canonical (CIDR-normalized) form on stdout; on any invalid input it prints a
# clear reason to stderr and returns 1 (caller must abort BEFORE save_policy):
#   192.168.19.10        -> 192.168.19.10        (single host, all ports)
#   192.168.19.10:443    -> 192.168.19.10:443    (single host, one port)
#   192.168.19.0/24      -> 192.168.19.0/24      (CIDR, all ports)
#   192.168.19.0/24:443  -> 192.168.19.0/24:443  (CIDR, one port)
#   192.168.19.*         -> 192.168.19.0/24      (wildcard -> /24)
#   192.168.*.*          -> 192.168.0.0/16       (wildcard -> /16)
#   10.* | 10.*.*.*      -> 10.0.0.0/8           (wildcard -> /8)
#   192.168.19.*:443     -> 192.168.19.0/24:443  (wildcard + port)
# A trailing wildcard octet may only be followed by more wildcards, never by a
# fixed octet (e.g. 192.*.19.* is rejected).
normalize_lan_endpoint() {
  local ep="$1"
  local addr="$ep" port=""

  # Split an optional :PORT suffix. IPv4/CIDR/wildcard never contain ':'.
  if [[ "$ep" == *:* ]]; then
    addr="${ep%:*}"
    port="${ep##*:}"
    if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
      echo "[ports] Invalid LAN target '$ep': port must be 1-65535" >&2
      return 1
    fi
  fi

  local norm_addr=""
  if [[ "$addr" == *"*"* ]]; then
    # Wildcard form: count leading fixed octets, rest must be wildcards.
    # read -ra splits on IFS without pathname expansion (a bare '*' octet must
    # not be glob-expanded against the current directory).
    local -a oct; IFS='.' read -ra oct <<< "$addr"
    if (( ${#oct[@]} < 1 || ${#oct[@]} > 4 )); then
      echo "[ports] Invalid LAN target '$ep': expected up to 4 dot-separated octets" >&2
      return 1
    fi
    local i fixed=0 seen_star=0
    for ((i = 0; i < ${#oct[@]}; i++)); do
      local o="${oct[$i]}"
      if [[ "$o" == "*" ]]; then
        seen_star=1
      elif [[ "$o" =~ ^[0-9]+$ ]] && (( o >= 0 && o <= 255 )); then
        if (( seen_star )); then
          echo "[ports] Invalid LAN target '$ep': wildcard '*' may only appear in trailing octets" >&2
          return 1
        fi
        fixed=$((fixed + 1))
      else
        echo "[ports] Invalid LAN target '$ep': octet '$o' is not 0-255 or '*'" >&2
        return 1
      fi
    done
    if (( fixed < 1 || fixed > 3 )); then
      echo "[ports] Invalid LAN target '$ep': need 1-3 fixed octets before the wildcard" >&2
      return 1
    fi
    local -a base=("${oct[@]:0:fixed}")
    while (( ${#base[@]} < 4 )); do base+=("0"); done
    local oldifs="$IFS"; IFS='.'; norm_addr="${base[*]}/$((fixed * 8))"; IFS="$oldifs"
  elif [[ "$addr" == *"/"* ]]; then
    # CIDR form: validate base IP octets and prefix.
    local ip="${addr%/*}" prefix="${addr##*/}"
    if ! [[ "$prefix" =~ ^[0-9]+$ ]] || (( prefix < 0 || prefix > 32 )); then
      echo "[ports] Invalid LAN target '$ep': CIDR prefix must be 0-32" >&2
      return 1
    fi
    local -a oct; IFS='.' read -ra oct <<< "$ip"
    if (( ${#oct[@]} != 4 )); then
      echo "[ports] Invalid LAN target '$ep': CIDR base must be a full IPv4 address" >&2
      return 1
    fi
    local o
    for o in "${oct[@]}"; do
      if ! [[ "$o" =~ ^[0-9]+$ ]] || (( o < 0 || o > 255 )); then
        echo "[ports] Invalid LAN target '$ep': octet '$o' is not 0-255" >&2
        return 1
      fi
    done
    norm_addr="$ip/$prefix"
  else
    # Plain IPv4: exactly 4 octets 0-255.
    local -a oct; IFS='.' read -ra oct <<< "$addr"
    if (( ${#oct[@]} != 4 )); then
      echo "[ports] Invalid LAN target '$ep': expected IPv4 (a.b.c.d), CIDR (a.b.c.d/n) or wildcard (a.b.c.*)" >&2
      return 1
    fi
    local o
    for o in "${oct[@]}"; do
      if ! [[ "$o" =~ ^[0-9]+$ ]] || (( o < 0 || o > 255 )); then
        echo "[ports] Invalid LAN target '$ep': octet '$o' is not 0-255" >&2
        return 1
      fi
    done
    norm_addr="$addr"
  fi

  if [[ -n "$port" ]]; then
    echo "${norm_addr}:${port}"
  else
    echo "$norm_addr"
  fi
}

# IPv4 dotted-quad -> unsigned 32-bit integer. Inputs are already validated by
# normalize_lan_endpoint, so no range checking here.
_ipv4_to_int() {
  local a b c d IFS=.
  read -r a b c d <<< "$1"
  echo $(( (a << 24) + (b << 16) + (c << 8) + d ))
}

# True (return 0) if CIDR/IP $1 fully contains CIDR/IP $2. Bare IPs count as /32.
_cidr_contains() {
  local outer="$1" inner="$2" oip op iip ipfx
  if [[ "$outer" == */* ]]; then oip="${outer%/*}"; op="${outer##*/}"; else oip="$outer"; op=32; fi
  if [[ "$inner" == */* ]]; then iip="${inner%/*}"; ipfx="${inner##*/}"; else iip="$inner"; ipfx=32; fi
  (( op <= ipfx )) || return 1
  local oint iint mask
  oint="$(_ipv4_to_int "$oip")"
  iint="$(_ipv4_to_int "$iip")"
  if (( op == 0 )); then mask=0; else mask=$(( (0xFFFFFFFF << (32 - op)) & 0xFFFFFFFF )); fi
  (( (oint & mask) == (iint & mask) ))
}

# Collapse a space-separated list of IPv4/CIDR tokens: drop any token fully
# contained by a *different* token (a host inside a wider CIDR, a CIDR inside a
# larger one, or an exact duplicate). Preserves first-seen order. nftables
# `interval` sets reject overlapping elements ("conflicting intervals"), so the
# element lists must be collapsed before they are pushed into a set.
_collapse_cidrs() {
  local -a toks=( $* ) keep=()
  local i j drop
  for (( i = 0; i < ${#toks[@]}; i++ )); do
    drop=0
    for (( j = 0; j < ${#toks[@]}; j++ )); do
      (( i == j )) && continue
      if _cidr_contains "${toks[$j]}" "${toks[$i]}"; then
        if _cidr_contains "${toks[$i]}" "${toks[$j]}"; then
          # equal blocks contain each other — keep only the earlier index
          (( j < i )) && { drop=1; break; }
        else
          drop=1; break
        fi
      fi
    done
    (( drop )) || keep+=( "${toks[$i]}" )
  done
  # `${keep[*]:-}` guard: under `set -u`, bash 3.2 (macOS) treats expansion of an
  # empty array as an unbound variable. Empty input (no LAN allowlist) is normal.
  echo "${keep[*]:-}"
}

# Bare-host nft elements (entries without :PORT) from a LAN_ALLOW_* list,
# overlap-collapsed and comma-joined for `nft add element`.
_lan_host_elems() {
  local list="$1" ep hosts="" collapsed ip out=""
  for ep in $list; do
    [[ "$ep" == *:* ]] && continue
    hosts+=" $ep"
  done
  collapsed="$(_collapse_cidrs $hosts)"
  for ip in $collapsed; do out+="${ip}, "; done
  echo "${out%, }"
}

# Tuple nft elements ("ip . port") from a LAN_ALLOW_* list, overlap-collapsed
# per port (overlaps only conflict when the port matches) and comma-joined.
_lan_tuple_elems() {
  local list="$1" ep ports port ips collapsed ip out=""
  ports="$(for ep in $list; do [[ "$ep" == *:* ]] && echo "${ep##*:}"; done | sort -un)"
  for port in $ports; do
    ips=""
    for ep in $list; do
      [[ "$ep" == *:* ]] || continue
      [[ "${ep##*:}" == "$port" ]] || continue
      ips+=" ${ep%:*}"
    done
    collapsed="$(_collapse_cidrs $ips)"
    for ip in $collapsed; do out+="${ip} . ${port}, "; done
  done
  echo "${out%, }"
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
  vm_exec "$sess_name" '
    set -e
    mkdir -p "$HOME/.claude/homunculus/projects"
    ln -sfn "$1/homunculus" "$HOME/.claude/homunculus/projects/$2"
  ' "$sess_share" "$ecc_hash" 2>/dev/null || echo "[ecc] Warning: failed to create homunculus symlink in VM" >&2
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
  {
    echo "# opencode-vm Proxmox integration — credentials, mode 0600."
    echo "# Wiped automatically by: opencode-vm mcps off proxmox"
    printf 'PROXMOX_HOST=%q\n'        "${PROXMOX_HOST:-}"
    printf 'PROXMOX_PORT=%q\n'        "${PROXMOX_PORT:-8006}"
    printf 'PROXMOX_USER=%q\n'        "${PROXMOX_USER:-}"
    printf 'PROXMOX_TOKEN_NAME=%q\n'  "${PROXMOX_TOKEN_NAME:-}"
    printf 'PROXMOX_TOKEN_VALUE=%q\n' "${PROXMOX_TOKEN_VALUE:-}"
    printf 'PROXMOX_VERIFY_SSL=%q\n'  "${PROXMOX_VERIFY_SSL:-0}"
    printf 'PROXMOX_MCP_REPO=%q\n'    "${PROXMOX_MCP_REPO:-$DEFAULT_PROXMOX_MCP_REPO}"
    printf 'PROXMOX_MCP_REF=%q\n'     "${PROXMOX_MCP_REF:-$DEFAULT_PROXMOX_MCP_REF}"
    printf 'PROXMOX_MCP_COMMIT=%q\n'  "${PROXMOX_MCP_COMMIT:-}"
  } > "$PROXMOX_ENV"
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

# Guest username Lima created inside <vm> — not always the host user: Lima
# falls back to guest user "lima" when the host name is reserved in the guest
# image (macOS "admin" is the canonical case). Authoritative source is the
# per-instance ssh.config, which persists for stopped instances too.
lima_guest_user() {
  local vm="$1" u
  u="$(awk '$1 == "User" {print $2; exit}' "$HOME/.lima/$vm/ssh.config" 2>/dev/null)"
  [[ -n "$u" ]] || u="$(limactl show-ssh --format=config "$vm" 2>/dev/null | awk '$1 == "User" {print $2; exit}')"
  printf '%s' "$u"
}

VM_HOME_CACHE=""
vm_resolve_home() {
  [[ -n "$VM_HOME_CACHE" ]] && { printf '%s' "$VM_HOME_CACHE"; return 0; }
  local vm="${1:-$BASE_NAME}" home=""
  if is_vm_running "$vm"; then
    home="$(vm_exec "$vm" 'printf %s "$HOME"' 2>/dev/null | tr -d '\r\n')"
  fi
  if [[ -z "$home" || "$home" != /home/* ]]; then
    # The VM is usually stopped here (base VMs only run for installs), so
    # derive the home from the guest username instead of querying it. The
    # host username is not a substitute — with guest user "lima" that baked
    # a nonexistent /home/admin.linux into {VM_HOME} paths (proxmox MCP
    # ENOENT). The .linux suffix holds on both Lima generations: real home
    # on older instances, compat symlink to <user>.guest on newer ones.
    local guest_user; guest_user="$(lima_guest_user "$vm")"
    if [[ -n "$guest_user" ]]; then
      home="/home/${guest_user}.linux"
    else
      home="/home/$(whoami).linux"
      echo "[vm] Warning: could not resolve VM \$HOME; falling back to $home" >&2
    fi
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

  # Need the base VM running even for the stamp probe — `limactl shell`
  # against a stopped instance can't check the disk, and Lima >=2.x would
  # interactively ask to start it.
  local started_base=0
  if ! is_vm_running "$BASE_NAME"; then
    run_with_spinner "[proxmox] Starting base VM to check/install MCP server..." limactl start "$BASE_NAME" --tty=false || {
      echo "[proxmox] Could not start base VM; MCP will not be available this session." >&2
      return 1
    }
    started_base=1
  fi

  # Skip only when the stamp for the current recipe version is present.
  # Deliberately leave the base running even if we started it: start_session
  # stops the base before cloning regardless, and searxng's ensure-step may
  # need it up next — stopping here would just force a second boot.
  if vm_exec "$BASE_NAME" "test -f $stamp_path" 2>/dev/null; then
    return 0
  fi

  echo "[proxmox] Installing ProxmoxMCP into base VM (first-run only, ~20-40s)..."
  # ProxmoxMCP's pyproject.toml pins `mcp @ git+.../python-sdk.git` — the
  # unpinned main branch, which is no longer pip-installable: it depends on an
  # unpublished `mcp-types` dev version and partly requires Python >=3.14, so
  # dependency resolution fails before anything installs. Rewrite the pin to
  # the last released `mcp` that still ships the `mcp.server.fastmcp` module
  # ProxmoxMCP imports, BEFORE pip ever sees the pyproject.
  local mcp_sdk_pin="mcp==1.27.0"
  vm_exec "$BASE_NAME" "
    set -euo pipefail
    mkdir -p \$HOME/.local/share
    if [[ ! -d $src_path/.git ]]; then
      git clone --depth=1 --branch '$ref' '$repo' $src_path
    else
      git -C $src_path fetch --depth=1 origin '$ref' >/dev/null 2>&1 || true
      git -C $src_path checkout -q -f FETCH_HEAD 2>/dev/null || true
    fi
    sed -i 's|\"mcp @ git+[^\"]*\"|\"$mcp_sdk_pin\"|' $src_path/pyproject.toml
    rm -rf $venv_path
    python3 -m venv $venv_path
    $venv_path/bin/pip install --quiet --upgrade pip
    $venv_path/bin/pip install --quiet -e $src_path
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

# Install the SearXNG metasearch stack (searxng + valkey, via docker compose)
# into the BASE VM so every session clone inherits a ready-to-use private
# search engine reachable at http://127.0.0.1:8888.  Idempotent via a stamp
# file; honours `mcps_pkg_is_active searxng` and exits cleanly when disabled.
#
# Network path (no LAN exposure, no SSH tunnels):
#   session-VM 127.0.0.1:8888  --(socat hostfwd)-->  host 127.0.0.1:8888
#   host 127.0.0.1:8888         --(Lima portfwd)-->  oc-base 127.0.0.1:8888
#   oc-base 127.0.0.1:8888      --(docker portmap)-> searxng container :8080
#
# Called from start_session right before the base VM is stopped for cloning,
# parallel to proxmox_ensure_installed_in_base.
searxng_ensure_installed_in_base() {
  mcps_pkg_is_active searxng || return 0

  # Bump this when settings.yml.template/limiter/compose changes meaningfully.
  # Old stamps don't match → existing installs auto-re-render config on next run.
  local install_stamp_version="2"
  local stamp_path="$SEARXNG_VM_DIR/.installed-v$install_stamp_version"
  local lima_yaml="$HOME/.lima/$BASE_NAME/lima.yaml"
  local cfg_src="$SCRIPT_DIR/mcps/searxng"

  if [[ ! -d "$cfg_src" ]]; then
    echo "[searxng] WARN: bundled config dir not found at $cfg_src; install skipped." >&2
    echo "[searxng]       (run opencode-vm from a checked-out repo or 'opencode-vm update')" >&2
    return 0
  fi

  # Ensure lima.yaml has an explicit portForward rule for 127.0.0.1:8888.
  # Lima's default auto-forward can be displaced when other rules are present,
  # so we add an explicit rule above any catch-all. Idempotent.
  local need_lima_restart=0
  if [[ -f "$lima_yaml" ]] && ! grep -q 'guestPort: 8888' "$lima_yaml" 2>/dev/null; then
    echo "[searxng] Adding lima.yaml portForward rule for 127.0.0.1:$SEARXNG_PORT..."
    sed -i '' '/^portForwards:/a\
- guestIP: "127.0.0.1"\
  guestPort: 8888\
  hostIP: "127.0.0.1"\
  hostPort: 8888
' "$lima_yaml"
    need_lima_restart=1
  fi

  # Need the base VM running for the install. Start if stopped (track so we
  # leave the right state behind).
  local started_base=0
  if ! is_vm_running "$BASE_NAME"; then
    run_with_spinner "[searxng] Starting base VM to install SearXNG..." limactl start "$BASE_NAME" --tty=false || {
      echo "[searxng] Could not start base VM; SearXNG will not be available this session." >&2
      return 1
    }
    started_base=1
  elif (( need_lima_restart == 1 )); then
    run_with_spinner "[searxng] Restarting base VM to apply portForward..." bash -c "limactl stop '$BASE_NAME' && limactl start '$BASE_NAME' --tty=false" || {
      echo "[searxng] Restart for portForward failed; SearXNG may be unreachable from host." >&2
    }
  fi

  # Already installed?
  if vm_exec "$BASE_NAME" "test -f $stamp_path" 2>/dev/null; then
    # Always ensure the service is running, even if installed previously
    # (handles base-VM reboot or docker-daemon restart).
    vm_exec "$BASE_NAME" \
      'sudo systemctl is-active --quiet ocvm-searxng.service || sudo systemctl start ocvm-searxng.service' 2>/dev/null || true
    (( started_base == 1 )) && limactl stop "$BASE_NAME" 2>/dev/null || true
    return 0
  fi

  echo "[searxng] Installing SearXNG container into base VM (first-run only, ~60-90s)..."

  # Ship bundled config files into the VM. Use sudo tee to write under
  # /var/lib (root-owned). stdin redirection delivers the host-side bytes.
  local f
  for f in docker-compose.yml settings.yml.template limiter.toml ocvm-searxng.service; do
    if ! vm_exec "$BASE_NAME" \
      "sudo mkdir -p $SEARXNG_VM_DIR && sudo tee $SEARXNG_VM_DIR/$f >/dev/null" \
      < "$cfg_src/$f" >/dev/null; then
      echo "[searxng] Failed to write $f into base VM." >&2
      (( started_base == 1 )) && limactl stop "$BASE_NAME" 2>/dev/null || true
      return 1
    fi
  done

  # Generate the SEARXNG_SECRET once, render settings.yml + service unit,
  # install + enable the systemd unit, then wait for the JSON API to come up.
  # The outer "..." string is HOST-side expanded for $SEARXNG_VM_DIR /
  # $SEARXNG_PORT / $stamp_path; in-VM shell vars are escaped as \$var.
  if ! vm_exec "$BASE_NAME" "
    set -euo pipefail
    sudo chmod 755 $SEARXNG_VM_DIR
    if [[ ! -s $SEARXNG_VM_DIR/secret_key ]]; then
      sudo bash -c 'openssl rand -hex 32 > $SEARXNG_VM_DIR/secret_key'
      sudo chmod 600 $SEARXNG_VM_DIR/secret_key
    fi
    sk=\$(sudo cat $SEARXNG_VM_DIR/secret_key)

    sudo sed \"s|__SECRET_KEY__|\$sk|\" $SEARXNG_VM_DIR/settings.yml.template \
      | sudo tee $SEARXNG_VM_DIR/settings.yml >/dev/null
    echo \"SEARXNG_SECRET=\$sk\" | sudo tee $SEARXNG_VM_DIR/.env >/dev/null
    sudo chmod 600 $SEARXNG_VM_DIR/.env

    sudo sed \"s|__SEARXNG_VM_DIR__|$SEARXNG_VM_DIR|g\" $SEARXNG_VM_DIR/ocvm-searxng.service \
      | sudo tee /etc/systemd/system/ocvm-searxng.service >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable --now ocvm-searxng.service

    # Wait up to 60 s for HTTP 200 on the JSON API.
    ok=0
    for i in \$(seq 1 60); do
      if curl -fsS -o /dev/null --max-time 2 'http://127.0.0.1:$SEARXNG_PORT/search?q=test&format=json' 2>/dev/null; then
        ok=1; break
      fi
      sleep 1
    done
    if (( ok == 1 )); then
      sudo touch $stamp_path
      echo '[searxng] JSON API responding on 127.0.0.1:$SEARXNG_PORT'
    else
      echo '[searxng] JSON API did not respond within 60s — check: systemctl status ocvm-searxng.service' >&2
      exit 1
    fi
  "; then
    echo "[searxng] Provisioning failed; disable with 'opencode-vm mcps off searxng' or check 'opencode-vm doctor'." >&2
    (( started_base == 1 )) && limactl stop "$BASE_NAME" 2>/dev/null || true
    return 1
  fi

  echo "[searxng] SearXNG ready at http://127.0.0.1:$SEARXNG_PORT (private, account-free metasearch)"

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
# mcrepo (multi-context repository) detection + workspace conventions
# ---------------------------------------------------------------------------
# A workspace is an mcrepo iff `mcrepo.yaml` exists at the project root.
# mcrepo creates emoji-prefixed coordination folders by convention (e.g.
# "🧾 docs", "🧠 skills"); we tolerate plain names too.
is_mcrepo_workspace() {
  [[ -f "${1:?proj}/mcrepo.yaml" ]]
}

# Resolve the mcrepo docs directory. Returns the first existing match from a
# small candidate list; falls back to plain "docs" (caller mkdirs as needed).
mcrepo_docs_dir() {
  local proj="${1:?proj}" cand
  for cand in "🧾 docs" "docs"; do
    [[ -d "$proj/$cand" ]] && { printf '%s' "$proj/$cand"; return 0; }
  done
  printf '%s' "$proj/docs"
}

# Ensure <docs>/graphify/ exists and that <proj>/.graphify-out is a symlink to
# it (graphifyy 0.4.x hardcodes its output dir relative to the project; the
# in-VM install is sed-patched at base-image build time so it writes to
# .graphify-out instead of graphify-out, keeping the entry grouped with the
# other hidden management dirs like .playwright-mcp). Also seeds a .gitignore
# inside the graphify dir so the local-only cache and the mtime-based manifest
# don't bloat git status (graphify upstream itself recommends ignoring both —
# cache can grow to ~10k files on medium codebases and the manifest's mtimes
# are unreliable across `git clone`).
#
# Auto-migration: if a previous opencode-vm release left an un-hidden
# <proj>/graphify-out symlink behind, rename it in-place (atomic — preserves
# the symlink target, no data movement).
#
# Idempotent. Returns the absolute docs/graphify path on stdout.
mcrepo_ensure_graphify_dir() {
  local proj="${1:?proj}"
  local docs; docs="$(mcrepo_docs_dir "$proj")"
  local target="$docs/graphify"
  mkdir -p "$target"

  local new_link="$proj/.graphify-out"

  if [[ -L "$new_link" ]]; then
    : # already a symlink — leave it alone (path may be relative or absolute)
  elif [[ -e "$new_link" ]]; then
    echo "[mcrepo] WARNING: $new_link exists and is not a symlink; leaving graphify output there." >&2
  else
    # Use a path relative to the project root. The docs dir name may contain
    # a space (e.g. "🧾 docs"); ln handles that fine when the arg is quoted.
    local rel="${docs#$proj/}/graphify"
    ln -s "$rel" "$new_link"
  fi

  # Drop the .gitignore on first activation. Don't overwrite a user-edited
  # version; if they removed entries they'll have done so deliberately.
  if [[ ! -f "$target/.gitignore" && -f "$SCRIPT_DIR/mcps/graphify/gitignore.template" ]]; then
    cp -p "$SCRIPT_DIR/mcps/graphify/gitignore.template" "$target/.gitignore"
  fi

  printf '%s' "$target"
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
    skills_save
  fi
  return 0
}

skills_save() {
  mkdir -p "$SHARE_ROOT"
  cat > "$SKILLS_ENV" <<EOF
# opencode-vm skills subsystem
# space-separated list of active package names
SKILLS_PACKAGES="${SKILLS_PACKAGES:-}"
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
  langs="$(detect_project_languages "$proj")"

  local dest_root="$sess_share/config/opencode/skills"
  local manifest="$sess_share/skills-manifest.txt"
  mkdir -p "$dest_root"
  : > "$manifest"

  local pkg
  for pkg in $all_pkgs; do
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
  else
    # First run: seed from registry defaults
    local defaults
    defaults="$(mcps_registry_defaults 2>/dev/null | tr '\n' ' ')"
    MCPS_PACKAGES="$(echo "${defaults}" | sed -e 's/^ *//; s/ *$//')"
    mcps_save
  fi

  # Session-only overrides (e.g. mcrepo auto-activation in start_session).
  # MCPS_FORCE_ON/MCPS_FORCE_OFF are space-separated lists exported by the
  # caller; they don't get persisted to mcps.env.
  local _p
  if [[ -n "${MCPS_FORCE_ON:-}" ]]; then
    for _p in $MCPS_FORCE_ON; do
      case " ${MCPS_PACKAGES:-} " in
        *" $_p "*) ;;
        *) MCPS_PACKAGES="${MCPS_PACKAGES:+$MCPS_PACKAGES }$_p" ;;
      esac
    done
  fi
  if [[ -n "${MCPS_FORCE_OFF:-}" ]]; then
    for _p in $MCPS_FORCE_OFF; do
      _mcps_pkg_drop "$_p"
    done
  fi
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
    playwright|repomapper|graphify|searxng)
      # Bundled in base VM — nothing to do here. For searxng the actual
      # container provisioning happens lazily on first start_session via
      # searxng_ensure_installed_in_base().
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

# Path the {GRAPH_PATH} token resolves to. Two cases:
#   - mcrepo workspace: the graph lives in the workspace at <docs>/graphify/
#     graph.json (committed alongside the rest of the docs); this file is
#     visible from the VM via the project-root virtiofs mount.
#   - single-repo workspace: the graph lives in $sess_share/graphify/graph.json,
#     bind-mounted at the same absolute path inside the VM, and is
#     load-ed/save-d to host-side per-project state by
#     graphify_persist_load_for_session / graphify_persist_save_for_session.
_mcps_graph_path_for_session() {
  local sess_share="$1"
  local proj="${2:-}"
  if [[ -n "$proj" ]] && is_mcrepo_workspace "$proj"; then
    local docs; docs="$(mcrepo_docs_dir "$proj")"
    echo "$docs/graphify/graph.json"
    return 0
  fi
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

# Ensure the graphifyy pipx venv inside the session VM can launch its MCP
# server (`python -m graphify.serve`). graphifyy <0.5 ships the serve module
# but gates its `mcp` runtime dep behind the [mcp] extras — bases provisioned
# before v0.4.25 (or session VMs cloned from such a base) lack the module,
# which makes OpenCode mark graphify as "failed and disabled" on every start
# with no in-product recovery.
#
# Always-on probe: we run a ~200 ms `python -c "import mcp"` check on every
# session start AND attach. If the venv is absent (graphify never installed),
# we exit cleanly. If the venv exists but mcp is missing, we pipx-inject it
# (~5 s, one-time per VM disk). Idempotent. Cost when graphify isn't active
# at all is one short limactl shell roundtrip — negligible vs. session start.
# Called from both start_session (fresh) and attach_session (reconnect/resume).
# $1 = lima session VM name (e.g. oc-20260508-152352)
# --- opencode-a2a runtime -------------------------------------------------
#
# Installed into the base image so session clones inherit it, and re-checked per
# session because a VM cloned before this feature existed never saw that
# install. Same stamp-file shape as proxmox_ensure_installed_in_base and
# searxng_ensure_installed_in_base.
#
# pipx, not `uv tool install` (which is what upstream documents): pipx is
# already in the base image and is how graphify is installed, and the package is
# an ordinary wheel, so there is nothing to gain from adding a second Python
# tool installer.
_a2a_install_snippet() {
  cat <<A2ASNIP
set -e
venv="$OCVM_A2A_VENV"
stamp="\$venv/.ocvm-a2a-install-v$OCVM_A2A_STAMP_VERSION"
if [ -f "\$stamp" ]; then exit 0; fi
rm -rf "\$venv"
python3 -m venv "\$venv"
"\$venv/bin/pip" install --quiet --upgrade pip
"\$venv/bin/pip" install --quiet "$OCVM_A2A_SPEC"
touch "\$stamp"
A2ASNIP
}

a2a_ensure_installed_in_base() {
  [[ "${OCVM_A2A:-1}" != "0" ]] || return 0
  local stamp="$OCVM_A2A_VENV/.ocvm-a2a-install-v$OCVM_A2A_STAMP_VERSION"
  if vm_exec "$BASE_NAME" "test -f $stamp" 2>/dev/null; then
    return 0
  fi
  local started_base=0
  if ! is_vm_running "$BASE_NAME"; then
    run_with_spinner "[a2a] Starting base VM to install opencode-a2a..." limactl start "$BASE_NAME" --tty=false || {
      echo "[a2a] Could not start base VM; A2A will be installed per-session instead." >&2
      return 1
    }
    started_base=1
  fi
  if run_with_spinner "[a2a] Installing $OCVM_A2A_SPEC into base VM..." \
       vm_exec "$BASE_NAME" "$(_a2a_install_snippet)"; then
    echo "[a2a] opencode-a2a installed in base VM."
  else
    echo "[a2a] WARNING: install in base VM failed; will retry per-session." >&2
  fi
  if (( started_base == 1 )); then
    limactl stop "$BASE_NAME" 2>/dev/null || true
  fi
  return 0
}

# Session-level self-heal. Non-fatal by design: a missing sidecar must never
# cost the user the web UI (see --require-a2a for the opposite policy).
a2a_ensure_installed_in_vm() {
  local vm="$1"
  [[ "${OCVM_A2A:-1}" != "0" ]] || return 0
  [[ -n "$vm" ]] || return 0
  local stamp="$OCVM_A2A_VENV/.ocvm-a2a-install-v$OCVM_A2A_STAMP_VERSION"
  if vm_exec "$vm" "test -f $stamp" 2>/dev/null; then
    return 0
  fi
  run_with_spinner "[a2a] Installing $OCVM_A2A_SPEC in session VM (one-time)..." \
    vm_exec "$vm" "$(_a2a_install_snippet)" ||
    echo "[a2a] WARNING: could not install opencode-a2a; the A2A endpoints will be unavailable." >&2
  return 0
}

graphify_ensure_mcp_in_vm() {
  local sess="${1:?sess}"
  vm_exec "$sess" '
    set +e
    python_bin="$HOME/.local/share/pipx/venvs/graphifyy/bin/python"
    # No venv = graphify not installed in this base (older or stripped) — nothing to heal.
    [[ -x "$python_bin" ]] || exit 0
    if "$python_bin" -c "import mcp" 2>/dev/null; then
      exit 0
    fi
    echo "[graphify] mcp module missing in pipx venv — injecting (one-time, ~5s)..." >&2
    if pipx inject graphifyy mcp >/dev/null 2>&1; then
      echo "[graphify] self-heal complete; MCP server will start cleanly" >&2
    else
      echo "[graphify] WARN self-heal failed; MCP will likely fail to start" >&2
      echo "[graphify]      run: opencode-vm init    to rebuild oc-base cleanly" >&2
    fi
  ' 2>&1 || true
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
  local graph_p=""; [[ -n "$sess_share" ]] && graph_p="$(_mcps_graph_path_for_session "$sess_share" "$proj")"
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
        # Prefer bundled next to the script; in a single-file install fall back
        # to the registry sparse-clone cache, materializing the directory on
        # demand (the cache is a blob:none clone of the whole OCVM repo, so
        # sparse-checkout add can pull paths outside mcps/, e.g. skills/…).
        if [[ -d "$SCRIPT_DIR/$doc_rel" ]]; then
          src_dir="$SCRIPT_DIR/$doc_rel"
        else
          src_dir=""
          if [[ -d "$MCPS_REGISTRY_CACHE/.git" ]]; then
            if [[ ! -d "$MCPS_REGISTRY_CACHE/$doc_rel" ]]; then
              git -C "$MCPS_REGISTRY_CACHE" sparse-checkout add "$doc_rel" >/dev/null 2>&1 || true
            fi
            if [[ -d "$MCPS_REGISTRY_CACHE/$doc_rel" ]]; then
              src_dir="$MCPS_REGISTRY_CACHE/$doc_rel"
            fi
          fi
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
# $7=is_mcrepo (0/1) — when 1, use agents_md_snippet.path_mcrepo if present.
_mcps_resolve_snippet() {
  local pkg="$1" reg="$2" vm_home="$3" proj_h="$4" sess_share="$5" graph_p="$6"
  local is_mcrepo="${7:-0}"
  local source content path path_mcrepo raw
  source="$(jq -r --arg n "$pkg" '.mcps[$n].agents_md_snippet.source // empty' "$reg" 2>/dev/null)"
  [[ -n "$source" ]] || return 0

  case "$source" in
    inline)
      content="$(jq -r --arg n "$pkg" '.mcps[$n].agents_md_snippet.content // empty' "$reg" 2>/dev/null)"
      [[ -n "$content" ]] || return 0
      raw="$content"
      ;;
    file)
      if [[ "$is_mcrepo" == "1" ]]; then
        path_mcrepo="$(jq -r --arg n "$pkg" '.mcps[$n].agents_md_snippet.path_mcrepo // empty' "$reg" 2>/dev/null)"
        [[ -n "$path_mcrepo" ]] && path="$path_mcrepo"
      fi
      [[ -n "${path:-}" ]] || path="$(jq -r --arg n "$pkg" '.mcps[$n].agents_md_snippet.path // empty' "$reg" 2>/dev/null)"
      [[ -n "$path" ]] || return 0
      # Resolve relative to the registry actually in use: bundled repo checkout
      # or the sparse-clone cache of a single-file install — the snippet files
      # live in the same mcps/ tree as registry.json either way.
      local base
      base="$(dirname "$(dirname "$reg")")"
      local abs="$base/$path"
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
# Composes after the Host LAN IP block in the VM-side AGENTS.md.
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
  [[ -n "$sess_share" ]] && graph_p="$(_mcps_graph_path_for_session "$sess_share" "$proj")"

  local is_mcrepo=0
  [[ -n "$proj" ]] && is_mcrepo_workspace "$proj" && is_mcrepo=1

  local pkg snippet
  for pkg in $MCPS_PACKAGES; do
    snippet="$(_mcps_resolve_snippet "$pkg" "$reg" "$vm_home" "$proj_h" "$sess_share" "$graph_p" "$is_mcrepo")"
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
  opencode-vm skills on <pkg>             # enable skill package (ecc-auto | ecc-all | webimg | ssh-toolkit)
  opencode-vm skills off <pkg>            # disable skill package
  opencode-vm skills list [path]          # preview what would mount (no VM touch)

MCPs are servers/tools that give the agent capabilities (browser automation,
code indexing, infra APIs). Skills are knowledge-only markdown.

Built-in MCPs: playwright (default on), searxng (default on), repomapper (default off),
graphify (default off), proxmox (default off; requires API host + token on first enable).
Built-in skills: webimg (default on), ssh-toolkit (default on), ecc-auto, ecc-all.

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
# A2A interface (host side) — since v0.5.14
#
# `opencode-vm web` exposes each session's OpenCode runtime as an A2A 1.0 agent.
# These verbs are the counterpart an orchestrator's operator needs: which agents
# are live and under which URL (`a2a`), and does the interface actually behave
# the way docs/A2A-INTERFACE.md claims (`a2a check`).
#
# Deliberately stateless: there is nothing to register on this side. The session
# records are the source of truth for "what is running", and the served Agent
# Card is the truth for "where" — the effective port can differ from the
# requested one when a port block had to move on a collision.
# ---------------------------------------------------------------------------

# The smoke-test prompt is deliberately trivial and deterministic: it proves the
# round trip without asking the model to do work in the user's project.
A2A_CHECK_PROMPT="Reply with exactly OPENCODE_A2A_OK and nothing else."
A2A_CHECK_TOKEN="OPENCODE_A2A_OK"
A2A_EXT_SESSION_BINDING="urn:opencode-a2a:extension:session-binding:v1"

_a2a_need_tools() {
  local missing=""
  command -v curl >/dev/null 2>&1 || missing="curl"
  command -v jq   >/dev/null 2>&1 || missing="${missing:+$missing, }jq"
  if [[ -n "$missing" ]]; then
    echo "[a2a] Missing required tool(s): $missing" >&2
    echo "[a2a]   Install with: brew install ${missing//,/}" >&2
    return 1
  fi
  return 0
}

# Emit one TAB-separated record per live web session:
#   <vm-name> \t <project-dir> \t <requested-a2a_base-port> \t <project-basename>
_a2a_sessions() {
  local f
  [[ -d "$SESSIONS_DIR" ]] || return 0
  for f in "$SESSIONS_DIR"/*.env; do
    [[ -f "$f" ]] || continue
    ( # shellcheck disable=SC1090
      source "$f" 2>/dev/null || exit 0
      [[ "${SESS_MODE:-}" == "web" ]] || exit 0
      [[ -n "${SESS_NAME:-}" && -n "${SESS_PROJ:-}" && -n "${SESS_PORT:-}" ]] || exit 0
      printf '%s\t%s\t%s\t%s\n' "$SESS_NAME" "$SESS_PROJ" "$SESS_PORT" "$(basename "$SESS_PROJ")" )
  done
}

# The A2A credential for a session: whatever `--password` stored, else the
# documented default. Never echoed by the caller unless it IS the default.
_a2a_secret_for_project() {
  local proj="$1" share pw
  share="$(session_share_dir "$proj")"
  pw="$(read_session_auth "$share" 2>/dev/null || true)"
  printf '%s' "${pw:-$OCVM_A2A_DEFAULT_SECRET}"
}

_a2a_user_for_project() {
  local proj="$1" share f user="opencode"
  share="$(session_share_dir "$proj")"
  f="$share/auth.env"
  if [[ -f "$f" ]]; then
    # Subshell so the sourced assignments cannot leak into this process.
    user="$( set +u
             OPENCODE_SERVER_USERNAME=""
             # shellcheck disable=SC1090
             . "$f" 2>/dev/null || true
             printf '%s' "${OPENCODE_SERVER_USERNAME:-opencode}" )"
  fi
  printf '%s' "${user:-opencode}"
}

_a2a_fetch_card() {
  local a2a_base="$1" out="$2"
  curl -fsS --max-time 6 -o "$out" "${a2a_base%/}/.well-known/agent-card.json" 2>/dev/null
}

# Structural validation of an Agent Card. Prints one reason per failure.
_a2a_card_validate() {
  local file="$1" bad=0
  jq -e . "$file" >/dev/null 2>&1 || { echo "    not valid JSON"; return 1; }
  jq -e '.name           | type == "string" and length > 0' "$file" >/dev/null 2>&1 || { echo "    missing: name"; bad=1; }
  jq -e '.supportedInterfaces | type == "array" and length > 0' "$file" >/dev/null 2>&1 || { echo "    missing: supportedInterfaces[]"; bad=1; }
  jq -e '[.supportedInterfaces[]?.url] | all(type == "string" and length > 0)' "$file" >/dev/null 2>&1 || { echo "    missing: supportedInterfaces[].url"; bad=1; }
  jq -e '[.supportedInterfaces[]?.protocolVersion] | index("1.0")' "$file" >/dev/null 2>&1 || { echo "    no interface advertises protocolVersion 1.0"; bad=1; }
  jq -e '.securitySchemes  | type == "object"' "$file" >/dev/null 2>&1 || { echo "    missing: securitySchemes"; bad=1; }
  jq -e '.skills           | type == "array" and length > 0' "$file" >/dev/null 2>&1 || { echo "    missing: skills[]"; bad=1; }
  return "$bad"
}

# JSON-RPC call. $1 a2a_base url, $2 bearer secret, $3 request json file,
# $4 optional A2A-Extensions value, $5 optional --max-time (default 20).
_a2a_rpc() {
  local a2a_base="$1" secret="$2" reqfile="$3" ext="${4:-}" tmo="${5:-20}"
  if [[ -n "$ext" ]]; then
    curl -sS --max-time "$tmo" -X POST "${a2a_base%/}/" \
      -H "Authorization: Bearer $secret" \
      -H 'Content-Type: application/json' \
      -H "A2A-Extensions: $ext" \
      --data @"$reqfile" 2>/dev/null
  else
    curl -sS --max-time "$tmo" -X POST "${a2a_base%/}/" \
      -H "Authorization: Bearer $secret" \
      -H 'Content-Type: application/json' \
      --data @"$reqfile" 2>/dev/null
  fi
}

# No array for the optional header: macOS ships bash 3.2, where expanding an
# empty array under `set -u` is an "unbound variable" error.
_a2a_http_code() {
  local url="$1" secret="${2:-}"
  if [[ -n "$secret" ]]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 6 \
      -H "Authorization: Bearer $secret" "$url" 2>/dev/null || echo "000"
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$url" 2>/dev/null || echo "000"
  fi
}

# Resolve a target to "<a2a_base-url>\t<secret>\t<label>".
# Accepts: nothing (the single live session), a project/VM name, or a URL.
_a2a_resolve_target() {
  local want="${1:-}" ip name proj port pname a2a_base
  if [[ "$want" == http://* || "$want" == https://* ]]; then
    printf '%s\t%s\t%s\n' "${want%/}" "${OCVM_A2A_TOKEN:-$OCVM_A2A_DEFAULT_SECRET}" "$want"
    return 0
  fi
  ip="$(get_host_ip)"
  local matches=0 result=""
  while IFS=$'\t' read -r name proj port pname; do
    [[ -n "$name" ]] || continue
    if [[ -n "$want" && "$want" != "$pname" && "$want" != "$name" ]]; then
      continue
    fi
    a2a_base="http://${ip}:$((port + 3))"
    result="$(printf '%s\t%s\t%s' "$a2a_base" "$(_a2a_secret_for_project "$proj")" "$pname")"
    matches=$((matches + 1))
  done < <(_a2a_sessions)

  if (( matches == 0 )); then
    if [[ -n "$want" ]]; then
      echo "[a2a] No live web session named '$want'." >&2
    else
      echo "[a2a] No live web session on this host. Start one with: opencode-vm web" >&2
    fi
    return 1
  fi
  if (( matches > 1 )); then
    echo "[a2a] Several live sessions — name one: opencode-vm a2a check <project>" >&2
    return 1
  fi
  printf '%s\n' "$result"
}

a2a_status_cmd() {
  local as_json=0
  [[ "${1:-}" == "--json" ]] && as_json=1
  _a2a_need_tools || return 1

  local ip card rows=0 json_rows=""
  ip="$(get_host_ip)"
  card="$(mktemp)"

  local name proj port pname a2a_base cardname health effective secret user
  if (( as_json == 0 )); then
    echo "[a2a] Live web sessions on this host"
    echo ""
    printf "  %-20s %-6s %-30s %-32s %s\n" "PROJECT" "BASE" "A2A (HTTP)" "CARD NAME" "HEALTH"
  fi

  while IFS=$'\t' read -r name proj port pname; do
    [[ -n "$name" ]] || continue
    rows=$((rows + 1))
    a2a_base="http://${ip}:$((port + 3))"
    secret="$(_a2a_secret_for_project "$proj")"
    user="$(_a2a_user_for_project "$proj")"
    cardname="-"; health="unreachable"; effective="$a2a_base"
    if _a2a_fetch_card "$a2a_base" "$card"; then
      cardname="$(jq -r '.name // "-"' "$card" 2>/dev/null || echo "-")"
      # The card is authoritative: a shifted port block moves the real URL.
      effective="$(jq -r '[.supportedInterfaces[]? | select(.protocolBinding=="JSONRPC") | .url][0] // empty' "$card" 2>/dev/null || true)"
      [[ -n "$effective" ]] || effective="$a2a_base"
      [[ "$(_a2a_http_code "${effective%/}/health" "$secret")" == "200" ]] && health="ok" || health="auth-fail"
    fi
    if (( as_json == 1 )); then
      json_rows="$json_rows$(jq -cn --arg p "$pname" --arg d "$proj" --arg v "$name" \
        --argjson b "$port" --arg u "$effective" --arg c "$cardname" --arg h "$health" --arg us "$user" \
        '{project:$p,directory:$d,vm:$v,basePort:$b,a2aHttp:$u,agentCard:($u+"/.well-known/agent-card.json"),cardName:$c,username:$us,health:$h}')
"
    else
      printf "  %-20s %-6s %-30s %-32s %s\n" "$pname" "$port" "$effective" "$cardname" "$health"
      if [[ "$effective" != "$a2a_base" ]]; then
        printf "  %-20s %s\n" "" "(port block moved; card URL wins over the requested a2a_base)"
      fi
    fi
  done < <(_a2a_sessions)

  rm -f "$card"

  if (( as_json == 1 )); then
    printf '%s' "$json_rows" | jq -s '.'
    return 0
  fi

  if (( rows == 0 )); then
    echo "  <none — start one with: opencode-vm web>"
    return 0
  fi
  echo ""
  # Printing the default is deliberate: it is a documented constant, not a
  # secret. A session password is never printed. See docs/A2A-INTERFACE.md.
  local anydefault=0 anycustom=0
  while IFS=$'\t' read -r name proj port pname; do
    [[ -n "$name" ]] || continue
    if [[ "$(_a2a_secret_for_project "$proj")" == "$OCVM_A2A_DEFAULT_SECRET" ]]; then
      anydefault=1
    else
      anycustom=1
    fi
  done < <(_a2a_sessions)
  echo "  Auth:       HTTP Basic or Bearer, username 'opencode'"
  if (( anydefault == 1 )); then
    echo "  Token:      $OCVM_A2A_DEFAULT_SECRET   (session default — documented constant)"
  fi
  if (( anycustom == 1 )); then
    echo "  Token:      the session --password (not printed)"
  fi
  echo "  Agent Card: <a2a-url>/.well-known/agent-card.json"
  echo "  Contract:   docs/A2A-INTERFACE.md"
  echo ""
  echo "  Verify an agent end to end:  opencode-vm a2a check [<project>]"
  return 0
}

# Failures are recorded in a file, not a variable: the check body runs inside a
# `| tee` pipeline, so it is a subshell and any counter it increments would be
# discarded on return — the suite would report success while printing FAILs.
A2A_CHECK_FAILFILE=""
_a2a_ok()   { printf "  ok:   %s%s\n" "$1" "${2:+  ($2)}"; }
_a2a_fail() {
  printf "  FAIL: %s%s\n" "$1" "${2:+  ($2)}"
  [[ -n "$A2A_CHECK_FAILFILE" ]] && printf '%s\n' "$1" >> "$A2A_CHECK_FAILFILE"
  return 0
}

# The whole acceptance catalogue against one agent. Tests 8 and 9 send real
# prompts — they cost tokens and create a session in the target project.
_a2a_check_body() {
  local a2a_base="$1" secret="$2" label="$3"
  local tmp card req resp code state answer ctx ses1 ses2

  tmp="$(mktemp -d)"
  card="$tmp/card.json"; req="$tmp/req.json"; resp="$tmp/resp.json"

  echo "[a2a] Checking $label"
  echo "      endpoint: $a2a_base"
  echo ""

  echo "  -- discovery --"
  code="$(_a2a_http_code "${a2a_base%/}/.well-known/agent-card.json")"
  if [[ "$code" == "200" ]]; then _a2a_ok "Agent Card reachable without auth" "HTTP $code"
  else _a2a_fail "Agent Card reachable without auth" "HTTP $code"; fi

  if _a2a_fetch_card "$a2a_base" "$card"; then
    local reasons
    if reasons="$(_a2a_card_validate "$card")"; then
      _a2a_ok "Agent Card is structurally valid" "$(jq -r '.name' "$card" 2>/dev/null)"
    else
      _a2a_fail "Agent Card is structurally valid"
      printf '%s\n' "$reasons"
    fi
  else
    _a2a_fail "Agent Card is structurally valid" "could not fetch"
  fi

  echo ""
  echo "  -- authentication --"
  code="$(_a2a_http_code "${a2a_base%/}/health")"
  if [[ "$code" == "401" ]]; then _a2a_ok "/health rejects a request with no credentials" "HTTP 401"
  else _a2a_fail "/health rejects a request with no credentials" "HTTP $code"; fi

  code="$(_a2a_http_code "${a2a_base%/}/health" "$secret")"
  if [[ "$code" == "200" ]]; then _a2a_ok "/health accepts the session credential" "HTTP 200"
  else _a2a_fail "/health accepts the session credential" "HTTP $code"; fi

  code="$(_a2a_http_code "${a2a_base%/}/health" "definitely-not-the-token")"
  if [[ "$code" == "401" ]]; then _a2a_ok "/health rejects a wrong credential" "HTTP 401"
  else _a2a_fail "/health rejects a wrong credential" "HTTP $code"; fi

  echo ""
  echo "  -- protocol surface --"
  jq -n '{jsonrpc:"2.0",id:1,method:"NoSuchMethod_ocvm_check",params:{}}' > "$req"
  _a2a_rpc "$a2a_base" "$secret" "$req" "" 10 > "$resp" 2>/dev/null || true
  if jq -e '.error.code == -32601' "$resp" >/dev/null 2>&1 \
     && jq -e '[.error.data.supportedMethods[]?] | index("SendMessage")' "$resp" >/dev/null 2>&1; then
    _a2a_ok "unknown method returns -32601 and advertises SendMessage"
  else
    _a2a_fail "unknown method returns -32601 and advertises SendMessage" "$(jq -c '.error // .' "$resp" 2>/dev/null | head -c 120)"
  fi

  jq -n '{jsonrpc:"2.0",id:1,method:"opencode.sessions.list",params:{}}' > "$req"
  _a2a_rpc "$a2a_base" "$secret" "$req" "" 10 > "$resp" 2>/dev/null || true
  if jq -e '.error.code == -32004' "$resp" >/dev/null 2>&1; then
    _a2a_ok "extension method without A2A-Extensions returns -32004"
  else
    _a2a_fail "extension method without A2A-Extensions returns -32004" "$(jq -c '.error.code // .' "$resp" 2>/dev/null | head -c 80)"
  fi

  echo ""
  echo "  -- error handling --"
  if curl -fsS --max-time 4 "http://127.0.0.1:1/.well-known/agent-card.json" >/dev/null 2>&1; then
    _a2a_fail "unreachable agent fails cleanly" "something answered on 127.0.0.1:1"
  else
    _a2a_ok "unreachable agent fails cleanly" "no hang, non-zero exit"
  fi

  jq -n '{name:"Broken",skills:[]}' > "$tmp/bad-card.json"
  if _a2a_card_validate "$tmp/bad-card.json" >/dev/null 2>&1; then
    _a2a_fail "invalid Agent Card is rejected" "validator accepted a card with no interfaces"
  else
    _a2a_ok "invalid Agent Card is rejected"
  fi

  echo ""
  echo "  -- live round trip (sends real prompts) --"
  ctx="ocvm-check-$(date +%s)-$RANDOM"
  jq -n --arg t "$A2A_CHECK_PROMPT" --arg c "$ctx" --arg m "m-$ctx-1" \
    '{jsonrpc:"2.0",id:1,method:"SendMessage",params:{message:{messageId:$m,role:"ROLE_USER",parts:[{text:$t}],contextId:$c}}}' > "$req"
  _a2a_rpc "$a2a_base" "$secret" "$req" "$A2A_EXT_SESSION_BINDING" 180 > "$resp" 2>/dev/null || true

  state="$(jq -r '.result.task.status.state // empty' "$resp" 2>/dev/null || true)"
  # The answer lives in the "response" artifact. status.message is always the
  # literal string "Completed." — reading it would never yield a result.
  answer="$(jq -r '[.result.task.artifacts[]? | select(.name=="response") | .parts[]?.text] | join("")' "$resp" 2>/dev/null || true)"
  ses1="$(jq -r '.result.task.metadata.shared.session.id // empty' "$resp" 2>/dev/null || true)"

  if [[ "$state" == "TASK_STATE_COMPLETED" ]]; then
    _a2a_ok "SendMessage completes" "$state"
  else
    _a2a_fail "SendMessage completes" "state=${state:-<none>} $(jq -c '.error // .result.task.metadata.opencode.error // empty' "$resp" 2>/dev/null | head -c 140)"
    # Distinguish "the A2A interface is broken" from "the agent could not get an
    # answer from its model". Everything above this point is the interface; an
    # UPSTREAM_* error means the interface delivered the prompt correctly and
    # OpenCode failed behind it. Worth saying out loud, because the two look
    # identical from the outside.
    local uptype
    uptype="$(jq -r '.result.task.metadata.opencode.error.type // empty' "$resp" 2>/dev/null || true)"
    case "$uptype" in
      UPSTREAM_*)
        echo "        The A2A transport is fine — every check above it passed. OpenCode"
        echo "        itself did not return an answer ($uptype). Check the session's"
        echo "        model and provider credentials:"
        echo "          opencode-vm shell     then:  opencode auth list"
        echo "          agent log in the VM:  /tmp/ocvm-a2a.log"
        ;;
    esac
  fi
  if [[ "$answer" == *"$A2A_CHECK_TOKEN"* ]]; then
    _a2a_ok "reply contains $A2A_CHECK_TOKEN"
  else
    _a2a_fail "reply contains $A2A_CHECK_TOKEN" "got: $(printf '%s' "$answer" | head -c 80)"
  fi
  if [[ -n "$ses1" ]]; then
    _a2a_ok "OpenCode session id returned" "$ses1"
  else
    _a2a_fail "OpenCode session id returned" "negotiate $A2A_EXT_SESSION_BINDING to receive it"
  fi

  jq -n --arg c "$ctx" --arg m "m-$ctx-2" \
    '{jsonrpc:"2.0",id:2,method:"SendMessage",params:{message:{messageId:$m,role:"ROLE_USER",parts:[{text:"Reply with exactly OPENCODE_A2A_OK again."}],contextId:$c}}}' > "$req"
  _a2a_rpc "$a2a_base" "$secret" "$req" "$A2A_EXT_SESSION_BINDING" 180 > "$resp" 2>/dev/null || true
  ses2="$(jq -r '.result.task.metadata.shared.session.id // empty' "$resp" 2>/dev/null || true)"
  if [[ -n "$ses1" && "$ses1" == "$ses2" ]]; then
    _a2a_ok "same contextId continues the same OpenCode session" "$ses2"
  else
    _a2a_fail "same contextId continues the same OpenCode session" "first=${ses1:-<none>} second=${ses2:-<none>}"
  fi

  rm -rf "$tmp"
  return 0
}

a2a_check_cmd() {
  _a2a_need_tools || return 1
  local target a2a_base secret label resolved buf rc
  resolved="$(_a2a_resolve_target "${1:-}")" || return 1
  IFS=$'\t' read -r a2a_base secret label <<< "$resolved"

  buf="$(mktemp)"
  A2A_CHECK_FAILFILE="$(mktemp)"
  # Buffered *and* streamed: the redaction check below needs the full output,
  # but the live round trip takes long enough that silence would be unhelpful.
  _a2a_check_body "$a2a_base" "$secret" "$label" 2>&1 | tee "$buf"

  echo ""
  echo "  -- secret handling --"
  # Only meaningful for a real session password. The documented default is the
  # string "opencode-vm", which is also this tool's own name and appears all
  # over its output — grepping for it would prove nothing either way, and the
  # default is published on purpose (see docs/A2A-INTERFACE.md §4).
  if [[ "$secret" == "$OCVM_A2A_DEFAULT_SECRET" ]]; then
    echo "  skip: credential redaction — this session uses the published default"
    echo "        (start a session with --password to exercise this check)"
  elif grep -qF -- "$secret" "$buf" 2>/dev/null; then
    echo "  FAIL: the session password never appears in this command's output"
    printf 'credential redaction\n' >> "$A2A_CHECK_FAILFILE"
  else
    echo "  ok:   the session password never appears in this command's output"
  fi
  rm -f "$buf"

  rc="$(wc -l < "$A2A_CHECK_FAILFILE" | tr -d ' ')"
  local failed_names
  failed_names="$(cat "$A2A_CHECK_FAILFILE")"
  rm -f "$A2A_CHECK_FAILFILE"
  A2A_CHECK_FAILFILE=""

  echo ""
  if [[ "${rc:-0}" == "0" ]]; then
    echo "[a2a] All checks passed."
    return 0
  fi
  echo "[a2a] $rc check(s) failed:" >&2
  printf '%s\n' "$failed_names" | sed 's/^/  - /' >&2
  return 1
}

a2a_cmd() {
  local sub="${1:-status}"
  [[ $# -gt 0 ]] && shift || true
  case "$sub" in
    status|"")
      a2a_status_cmd "$@"
      ;;
    --json)
      # `a2a --json` is the status verb with a flag, not a verb of its own.
      a2a_status_cmd --json
      ;;
    check)
      a2a_check_cmd "${1:-}"
      ;;
    card)
      _a2a_need_tools || return 1
      local resolved a2a_base secret label
      resolved="$(_a2a_resolve_target "${1:-}")" || return 1
      IFS=$'\t' read -r a2a_base secret label <<< "$resolved"
      curl -fsS --max-time 6 "${a2a_base%/}/.well-known/agent-card.json" | jq .
      ;;
    help|-h|--help)
      cat <<'EOF'
opencode-vm a2a — the A2A interface every web session exposes

Usage:
  opencode-vm a2a                          # live agents on this host + how to reach them
  opencode-vm a2a --json                   # same, machine-readable
  opencode-vm a2a card [<project>]         # print the served Agent Card
  opencode-vm a2a check [<project>|<url>]  # verify the interface end to end

`check` runs the full contract suite: discovery, Agent Card validation, the three
authentication outcomes, the JSON-RPC method surface, extension negotiation, the
error paths, and a live round trip that proves SendMessage and session binding.
The round trip sends two real prompts — it costs tokens and creates a session in
the target project.

The protocol contract a client is built against: docs/A2A-INTERFACE.md
EOF
      ;;
    *)
      echo "Usage: opencode-vm a2a {status|card|check} [project|url]" >&2
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

# ---------------------------------------------------------------------------
# Per-project VM sizing (RAM + CPUs)
#
# The base VM is provisioned once at DEFAULT_VM_MEMORY_GIB / DEFAULT_VM_CPUS and
# shared by every project. A project that needs a different size records it in
# its project-state dir; the values are passed to `limactl clone` when the
# session VM is created and re-applied to a stopped session VM on resume. The
# base VM is never mutated.
#
# RAM and CPUs deliberately share one storage file, one load/save pair and one
# command implementation — they differ only in bounds, unit and which variable
# they write, so splitting them would just create two things to keep in sync.
# ---------------------------------------------------------------------------

# Physical RAM of the host in whole GiB (0 when it can't be determined, which
# disables the upper bound rather than blocking the user).
_host_mem_gib() {
  local bytes
  bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
  echo $(( bytes / 1024 / 1024 / 1024 ))
}

# Logical CPUs of the host (0 when it can't be determined).
_host_cpus() {
  local n
  n="$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  echo "$n"
}

# True when $1 is a whole number within [$2, $3]; $3 == 0 means "no upper bound".
_vm_size_valid() {
  local v="$1" min="$2" max="$3"
  [[ "$v" =~ ^[0-9]+$ ]] || return 1
  (( v >= min )) || return 1
  (( max == 0 || v <= max ))
}

# RAM of an existing Lima instance in whole GiB; empty when the instance is
# unknown. Lima reports bytes.
_vm_instance_mem_gib() {
  local bytes
  bytes="$(limactl list "$1" --format '{{.Memory}}' 2>/dev/null | head -1)"
  [[ "$bytes" =~ ^[0-9]+$ ]] || return 0
  echo $(( bytes / 1024 / 1024 / 1024 ))
}

# CPU count of an existing Lima instance; empty when the instance is unknown.
_vm_instance_cpus() {
  local n
  n="$(limactl list "$1" --format '{{.CPUs}}' 2>/dev/null | head -1)"
  [[ "$n" =~ ^[0-9]+$ ]] || return 0
  echo "$n"
}

# Load the project's overrides into VM_MEMORY_GIB / VM_CPUS. Empty means "no
# override — inherit the base VM's size". A stored value that no longer
# validates (hand-edited, or the machine shrank) is reported and dropped rather
# than clamped: silently booting a VM at a size the user never asked for is
# worse than falling back to the documented default.
vmcfg_load() {
  VM_MEMORY_GIB=""
  VM_CPUS=""
  local f
  f="$(project_vm_env "$1")"
  [[ -f "$f" ]] || return 0
  # shellcheck disable=SC1090
  source "$f"
  if [[ -n "${VM_MEMORY_GIB:-}" ]] && ! _vm_size_valid "$VM_MEMORY_GIB" "$MIN_VM_MEMORY_GIB" "$(_host_mem_gib)"; then
    echo "[vmsize] WARN: ignoring invalid VM_MEMORY_GIB='$VM_MEMORY_GIB' in $f" >&2
    echo "[vmsize]       falling back to the default (${DEFAULT_VM_MEMORY_GIB} GiB). Fix with 'opencode-vm ram <GiB>'." >&2
    VM_MEMORY_GIB=""
  fi
  if [[ -n "${VM_CPUS:-}" ]] && ! _vm_size_valid "$VM_CPUS" "$MIN_VM_CPUS" "$(_host_cpus)"; then
    echo "[vmsize] WARN: ignoring invalid VM_CPUS='$VM_CPUS' in $f" >&2
    echo "[vmsize]       falling back to the default (${DEFAULT_VM_CPUS} CPUs). Fix with 'opencode-vm cpu <N>'." >&2
    VM_CPUS=""
  fi
}

# Persist the current VM_MEMORY_GIB / VM_CPUS globals for project $1. With both
# empty the file is removed, so "no override" leaves no residue behind.
vmcfg_save() {
  local proj="$1" f
  f="$(project_vm_env "$proj")"
  if [[ -z "${VM_MEMORY_GIB:-}" && -z "${VM_CPUS:-}" ]]; then
    rm -f "$f"
    return 0
  fi
  mkdir -p "$(dirname "$f")"
  {
    echo "# opencode-vm per-project VM sizing"
    echo "# Project: $proj"
    echo "# Applied when this project's session VM is cloned from the base VM."
    echo "# Manage with: opencode-vm ram <GiB> | opencode-vm cpu <N> | ... default"
    if [[ -n "${VM_MEMORY_GIB:-}" ]]; then
      echo "VM_MEMORY_GIB=\"$VM_MEMORY_GIB\""
    fi
    if [[ -n "${VM_CPUS:-}" ]]; then
      echo "VM_CPUS=\"$VM_CPUS\""
    fi
  } > "$f"
}

# Standing reminder that this project deviates from the defaults. Emitted on
# every session start so an override set months ago can't be forgotten. Worded
# in one place so 'start', 'web' and 'attach' stay consistent.
vmcfg_print_override_notice() {
  local prefix="$1" what=""
  if [[ -n "${VM_MEMORY_GIB:-}" ]]; then
    what="${VM_MEMORY_GIB} GiB RAM"
  fi
  if [[ -n "${VM_CPUS:-}" ]]; then
    what="${what:+$what, }${VM_CPUS} CPUs"
  fi
  [[ -n "$what" ]] || return 0
  echo "$prefix Sizing override for this project: ${what} (defaults: ${DEFAULT_VM_MEMORY_GIB} GiB, ${DEFAULT_VM_CPUS} CPUs)"
  echo "$prefix   change: 'opencode-vm ram <GiB>' / 'opencode-vm cpu <N>'   reset: append 'default'"
}

# Shared status table for 'ram show' and 'cpu show'. Always prints both
# resources next to the host's totals — sizing decisions are made against what
# the machine actually has, so showing only the one resource you asked about
# would force a second lookup every time.
vmcfg_show() {
  local proj="$1"
  vmcfg_load "$proj"

  local host_mem host_cpu host_mem_s host_cpu_s proj_mem_s proj_cpu_s
  host_mem="$(_host_mem_gib)"
  host_cpu="$(_host_cpus)"
  if (( host_mem > 0 )); then host_mem_s="${host_mem} GiB"; else host_mem_s="unknown"; fi
  if (( host_cpu > 0 )); then host_cpu_s="${host_cpu}"; else host_cpu_s="unknown"; fi

  if [[ -n "${VM_MEMORY_GIB:-}" ]]; then
    proj_mem_s="${VM_MEMORY_GIB} GiB (set)"
  else
    proj_mem_s="${DEFAULT_VM_MEMORY_GIB} GiB"
  fi
  if [[ -n "${VM_CPUS:-}" ]]; then
    proj_cpu_s="${VM_CPUS} (set)"
  else
    proj_cpu_s="${DEFAULT_VM_CPUS}"
  fi

  echo "Project:  $proj"
  echo "Setting:  $(project_vm_env "$proj")"
  echo
  printf "  %-10s %-16s %-10s %s\n" "Resource" "This project" "Default" "Host total"
  printf "  %-10s %-16s %-10s %s\n" "RAM" "$proj_mem_s" "${DEFAULT_VM_MEMORY_GIB} GiB" "$host_mem_s"
  printf "  %-10s %-16s %-10s %s\n" "CPUs" "$proj_cpu_s" "$DEFAULT_VM_CPUS" "$host_cpu_s"
  echo

  # Report the live VM too: the settings only reach a session VM when that VM is
  # created or resumed, so a stale running VM would otherwise contradict the table.
  local senv sess_mem sess_cpu
  senv="$(session_env "$proj")"
  if [[ -f "$senv" ]]; then
    # shellcheck disable=SC1090
    source "$senv"
    sess_mem="$(_vm_instance_mem_gib "$SESS_NAME")"
    sess_cpu="$(_vm_instance_cpus "$SESS_NAME")"
    if [[ -n "$sess_mem" || -n "$sess_cpu" ]]; then
      echo "  Session VM $SESS_NAME: ${sess_mem:-?} GiB, ${sess_cpu:-?} CPUs"
      if [[ "${sess_mem:-}" != "${VM_MEMORY_GIB:-$DEFAULT_VM_MEMORY_GIB}" || "${sess_cpu:-}" != "${VM_CPUS:-$DEFAULT_VM_CPUS}" ]]; then
        echo "    -> differs from the table above; applied on the next VM start."
      fi
      echo
    fi
  fi

  echo "Set:    opencode-vm ram <GiB>        opencode-vm cpu <N>"
  echo "Reset:  opencode-vm ram default      opencode-vm cpu default"
}

# Shared implementation behind 'ram' and 'cpu'. $1 is the resource key; the rest
# are the user's arguments.
_vmcfg_resource_cmd() {
  local res="$1"; shift
  need limactl
  local proj sub
  proj="$(pwd)"
  sub="${1:-show}"

  # Per-resource attributes. Held as plain locals because bash 3.2 (the /bin/bash
  # this script runs under on macOS) has no associative arrays.
  local var def min host unit noun cmd
  case "$res" in
    ram)
      var=VM_MEMORY_GIB; def="$DEFAULT_VM_MEMORY_GIB"; min="$MIN_VM_MEMORY_GIB"
      host="$(_host_mem_gib)"; unit="GiB"; noun="RAM"; cmd="ram"
      ;;
    cpu)
      var=VM_CPUS; def="$DEFAULT_VM_CPUS"; min="$MIN_VM_CPUS"
      host="$(_host_cpus)"; unit="CPUs"; noun="CPUs"; cmd="cpu"
      ;;
    *)
      echo "[vmsize] Internal error: unknown resource '$res'" >&2
      return 1
      ;;
  esac

  case "$sub" in
    show|status)
      vmcfg_show "$proj"
      ;;

    default|reset|off)
      vmcfg_load "$proj"
      local cur="${!var}"
      if [[ -z "$cur" ]]; then
        echo "[$cmd] No ${noun} override set for this project — already at the default (${def} ${unit})."
        return 0
      fi
      printf -v "$var" '%s' ""
      vmcfg_save "$proj"
      echo "[$cmd] ${noun} override removed (was ${cur} ${unit}) — back to the default ${def} ${unit}."
      _vmcfg_report_pending_restart "$proj"
      ;;

    -h|--help|help)
      echo "Usage: opencode-vm ${cmd} [show|<value>|default]"
      ;;

    *)
      if ! [[ "$sub" =~ ^[0-9]+$ ]]; then
        echo "[$cmd] Not a whole number: '$sub'" >&2
        echo "[$cmd] Usage: opencode-vm ${cmd} [show|<value>|default]" >&2
        return 2
      fi
      if ! _vm_size_valid "$sub" "$min" "$host"; then
        if (( sub < min )); then
          if [[ "$res" == "ram" ]]; then
            echo "[$cmd] ${sub} ${unit} is below the ${min} ${unit} minimum — the VM needs headroom for Docker and the agent." >&2
          else
            echo "[$cmd] ${sub} is below the ${min} CPU minimum." >&2
          fi
        else
          echo "[$cmd] ${sub} exceeds the host's ${host} ${unit}." >&2
        fi
        return 2
      fi
      # Not an error — the host still has to run macOS — but worth flagging.
      if (( host > 0 && sub * 4 > host * 3 )); then
        echo "[$cmd] NOTE: ${sub} ${unit} is over 75% of the host's ${host} ${unit} — leave room for macOS." >&2
      fi
      vmcfg_load "$proj"
      printf -v "$var" '%s' "$sub"
      vmcfg_save "$proj"
      echo "[$cmd] This project's session VM will use ${sub} ${unit} (default: ${def} ${unit})."
      echo "[$cmd]   stored in: $(project_vm_env "$proj")"
      echo "[$cmd]   reset with: opencode-vm ${cmd} default"
      _vmcfg_report_pending_restart "$proj"
      ;;
  esac
}

ram_cmd() {
  _vmcfg_resource_cmd ram "$@"
}

cpu_cmd() {
  _vmcfg_resource_cmd cpu "$@"
}

# After a setting change, say whether an existing session VM still runs at the
# old size and what it takes to pick the new one up. Expects VM_MEMORY_GIB /
# VM_CPUS to already hold the new values.
_vmcfg_report_pending_restart() {
  local proj="$1" senv sess_mem sess_cpu want_mem want_cpu drift=""
  senv="$(session_env "$proj")"
  [[ -f "$senv" ]] || return 0
  # shellcheck disable=SC1090
  source "$senv"
  sess_mem="$(_vm_instance_mem_gib "$SESS_NAME")"
  sess_cpu="$(_vm_instance_cpus "$SESS_NAME")"
  want_mem="$(_effective_vm_mem_gib)"
  want_cpu="$(_effective_vm_cpus)"
  if [[ -n "$sess_mem" && "$sess_mem" != "$want_mem" ]]; then
    drift="${sess_mem} -> ${want_mem} GiB"
  fi
  if [[ -n "$sess_cpu" && "$sess_cpu" != "$want_cpu" ]]; then
    drift="${drift:+$drift, }${sess_cpu} -> ${want_cpu} CPUs"
  fi
  [[ -n "$drift" ]] || return 0
  if is_vm_running "$SESS_NAME"; then
    echo "[vmsize] Session VM '$SESS_NAME' is running — resizing needs a stop ($drift)."
    echo "[vmsize]   Exit the session, then 'opencode-vm start' applies it."
  else
    echo "[vmsize] Stopped session VM '$SESS_NAME' still has the old size — 'opencode-vm start' applies it ($drift)."
  fi
}

# Size a session VM should have right now: the project override when set,
# otherwise whatever the base VM actually carries (not the constant — a base
# provisioned by an older version or resized by hand must still win over a
# stale default, or every resume would fight it).
_effective_vm_mem_gib() {
  if [[ -n "${VM_MEMORY_GIB:-}" ]]; then
    echo "$VM_MEMORY_GIB"
    return 0
  fi
  local base_gib
  base_gib="$(_vm_instance_mem_gib "$BASE_NAME")"
  echo "${base_gib:-$DEFAULT_VM_MEMORY_GIB}"
}

_effective_vm_cpus() {
  if [[ -n "${VM_CPUS:-}" ]]; then
    echo "$VM_CPUS"
    return 0
  fi
  local base_cpus
  base_cpus="$(_vm_instance_cpus "$BASE_NAME")"
  echo "${base_cpus:-$DEFAULT_VM_CPUS}"
}

# Resize a stopped session VM in place so a setting changed between sessions
# takes effect without discarding the VM. Verified to rewrite only the affected
# lines of the instance's lima.yaml. Non-fatal: a failed resize keeps the old
# size rather than blocking the session.
_apply_vm_sizing_to_stopped() {
  local vm="$1" prefix="${2:-[start]}" want_mem want_cpu cur_mem cur_cpu what=""
  want_mem="$(_effective_vm_mem_gib)"
  want_cpu="$(_effective_vm_cpus)"
  cur_mem="$(_vm_instance_mem_gib "$vm")"
  cur_cpu="$(_vm_instance_cpus "$vm")"

  local -a edit_args
  edit_args=()
  if [[ -n "$cur_mem" && -n "$want_mem" && "$cur_mem" != "$want_mem" ]]; then
    edit_args+=( --memory "$want_mem" )
    what="RAM ${cur_mem} -> ${want_mem} GiB"
  fi
  if [[ -n "$cur_cpu" && -n "$want_cpu" && "$cur_cpu" != "$want_cpu" ]]; then
    edit_args+=( --cpus "$want_cpu" )
    what="${what:+$what, }CPUs ${cur_cpu} -> ${want_cpu}"
  fi
  # Guard the empty case explicitly: bash 3.2 errors on "${arr[@]}" for an empty
  # array under 'set -u'.
  (( ${#edit_args[@]} > 0 )) || return 0

  echo "$prefix Resizing session VM: $what"
  if ! limactl edit "$vm" "${edit_args[@]}" --tty=false >/dev/null 2>&1; then
    echo "$prefix WARN: could not resize '$vm' — continuing at the old size." >&2
    echo "$prefix       'opencode-vm start --fresh' recreates it at the configured size." >&2
  fi
}

# A running VM can't be resized; say so instead of silently ignoring the settings.
_warn_vm_sizing_mismatch() {
  local vm="$1" want_mem want_cpu cur_mem cur_cpu what=""
  want_mem="$(_effective_vm_mem_gib)"
  want_cpu="$(_effective_vm_cpus)"
  cur_mem="$(_vm_instance_mem_gib "$vm")"
  cur_cpu="$(_vm_instance_cpus "$vm")"
  if [[ -n "$cur_mem" && -n "$want_mem" && "$cur_mem" != "$want_mem" ]]; then
    what="${cur_mem} GiB (want ${want_mem})"
  fi
  if [[ -n "$cur_cpu" && -n "$want_cpu" && "$cur_cpu" != "$want_cpu" ]]; then
    what="${what:+$what, }${cur_cpu} CPUs (want ${want_cpu})"
  fi
  [[ -n "$what" ]] || return 0
  echo "[start] NOTE: running session VM '$vm' has $what."
  echo "[start]       Exit the session, then 'opencode-vm start' applies the settings."
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
          for p in "$@"; do
            is_valid_port "$p" || { echo "Invalid port: '$p' (expected an integer 1-65535)" >&2; exit 2; }
            HOST_TCP_PORTS="$(list_add "$p" $HOST_TCP_PORTS)"
          done
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
          for p in "$@"; do
            is_valid_port "$p" || { echo "Invalid port: '$p' (expected an integer 1-65535)" >&2; exit 2; }
          done
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
              for ep in "$@"; do
                ep="$(normalize_lan_endpoint "$ep")" || exit 2
                LAN_ALLOW_TCP="$(list_add "$ep" $LAN_ALLOW_TCP)"
              done
              save_policy
              echo "LAN_ALLOW_TCP: $LAN_ALLOW_TCP"
              apply_policy_to_running_sessions ;;
            rm|remove|del)
              for ep in "$@"; do
                ep="$(normalize_lan_endpoint "$ep")" || exit 2
                LAN_ALLOW_TCP="$(list_rm "$ep" $LAN_ALLOW_TCP)"
              done
              save_policy
              echo "LAN_ALLOW_TCP: $LAN_ALLOW_TCP"
              apply_policy_to_running_sessions ;;
            clear)
              LAN_ALLOW_TCP=""
              save_policy
              echo "LAN_ALLOW_TCP cleared"
              apply_policy_to_running_sessions ;;
            *)
              echo "Usage: opencode-vm ports lan tcp {show|add|rm|clear} [IP|CIDR|WILDCARD[:PORT]...]" >&2
              echo "  e.g. 192.168.19.10  192.168.19.10:443  192.168.19.0/24  192.168.19.*  192.168.*.*" >&2
              exit 2
              ;;
          esac
          ;;

        udp)
          case "$op" in
            show|"") echo "${LAN_ALLOW_UDP:-}" ;;
            add)
              for ep in "$@"; do
                ep="$(normalize_lan_endpoint "$ep")" || exit 2
                LAN_ALLOW_UDP="$(list_add "$ep" $LAN_ALLOW_UDP)"
              done
              save_policy
              echo "LAN_ALLOW_UDP: $LAN_ALLOW_UDP"
              apply_policy_to_running_sessions ;;
            rm|remove|del)
              for ep in "$@"; do
                ep="$(normalize_lan_endpoint "$ep")" || exit 2
                LAN_ALLOW_UDP="$(list_rm "$ep" $LAN_ALLOW_UDP)"
              done
              save_policy
              echo "LAN_ALLOW_UDP: $LAN_ALLOW_UDP"
              apply_policy_to_running_sessions ;;
            clear)
              LAN_ALLOW_UDP=""
              save_policy
              echo "LAN_ALLOW_UDP cleared"
              apply_policy_to_running_sessions ;;
            *)
              echo "Usage: opencode-vm ports lan udp {show|add|rm|clear} [IP|CIDR|WILDCARD[:PORT]...]" >&2
              echo "  e.g. 192.168.19.20:53  192.168.19.0/24  192.168.19.*" >&2
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

      echo "[doctor] OAuth token freshness (host vs. running VMs + saved sessions)"
      if [[ -f "$auth_file" ]] && command -v jq >/dev/null 2>&1; then
        if [[ -n "$(auth_oauth_provider_ids "$auth_file")" ]]; then
          auth_collect_freshest_oauth report
        else
          echo "  <no OAuth providers — only static API keys>"
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
          local _n_personal=0 _n_inherited=0 _obs_line
          # `find` returns non-zero when the dir doesn't exist; combined with
          # `set -o pipefail` that would propagate out and abort doctor mid-run.
          # Guard each subdir explicitly.
          if [[ -d "$_hom_dir/personal" ]]; then
            _n_personal=$(find "$_hom_dir/personal" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
          fi
          if [[ -d "$_hom_dir/inherited" ]]; then
            _n_inherited=$(find "$_hom_dir/inherited" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')
          fi
          echo "    instincts:    ${_n_personal} personal, ${_n_inherited} inherited"
          if [[ -f "$_hom_dir/observations.jsonl" ]]; then
            _obs_line=$(wc -l < "$_hom_dir/observations.jsonl" 2>/dev/null | tr -d ' ')
            echo "    observations: ${_obs_line} entries"
          fi
        else
          echo "    instincts:    <none yet — run /learn inside a session>"
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
          if vm_exec "$BASE_NAME" 'test -x $HOME/.local/share/proxmox-mcp-venv/bin/python' 2>/dev/null; then
            echo "             VM venv:   present"
          else
            echo "             VM venv:   missing (will install on next session start)"
          fi
        else
          echo "             VM venv:   unknown (base VM stopped)"
        fi
      fi
      echo ""

      # ---- SearXNG (private metasearch MCP backing service in base VM) ----
      echo "[doctor] SearXNG"
      if mcps_pkg_is_active searxng; then
        if is_vm_running "$BASE_NAME"; then
          local _sx_status _sx_http _sx_stamp
          # is-active / curl / ls all exit non-zero in failure states; the
          # outer `|| true` keeps `set -euo pipefail` from aborting doctor
          # mid-run when SearXNG is stopped or unreachable.
          _sx_status=$(vm_exec "$BASE_NAME" \
            'systemctl is-active ocvm-searxng.service 2>/dev/null || true' \
            2>/dev/null | tr -d '\r\n' || true)
          echo "  service:   ${_sx_status:-inactive}"
          _sx_http=$(vm_exec "$BASE_NAME" \
            "curl -s -o /dev/null -w '%{http_code}' --max-time 3 'http://127.0.0.1:${SEARXNG_PORT}/search?q=opencode&format=json' 2>/dev/null || true" \
            2>/dev/null | tr -d '\r\n' || true)
          echo "  json api:  HTTP ${_sx_http:-000} (expect 200)"
          _sx_stamp=$(vm_exec "$BASE_NAME" \
            "ls $SEARXNG_VM_DIR/.installed-v* 2>/dev/null | tail -1 | awk -F/ '{print \$NF}' || true" \
            2>/dev/null | tr -d '\r\n' || true)
          echo "  base prov: ${_sx_stamp:-missing}"
        else
          echo "  active:    yes (base VM stopped — start a session to refresh status)"
        fi
      else
        echo "  active:    no  (enable with: opencode-vm mcps on searxng)"
      fi
      echo ""

      # ---- Web-UI Attachments (materialize daemon) ----
      echo "[doctor] Web-UI Attachments (materialize daemon)"
      local _mat_in_base="unknown"
      if is_vm_running "$BASE_NAME"; then
        if vm_exec "$BASE_NAME" 'test -x $HOME/.local/bin/ocvm-materialize' 2>/dev/null; then
          _mat_in_base="present"
        else
          _mat_in_base="missing (run: opencode-vm init)"
        fi
      else
        _mat_in_base="unknown (base VM stopped)"
      fi
      echo "  base VM binary: $_mat_in_base"
      local _mat_running=0 _mat_files=0 _mat_sess
      if [[ -d "$SESSIONS_DIR" ]]; then
        local _sdir
        for _sdir in "$SESSIONS_DIR"/*/; do
          [[ -d "$_sdir" ]] || continue
          if [[ -f "${_sdir}materialize.pid" ]]; then
            _mat_running=$((_mat_running + 1))
          fi
          if [[ -d "${_sdir}attachments" ]]; then
            _mat_sess=$(find "${_sdir}attachments" -mindepth 2 -type f ! -name 'index.json' ! -name '*.tmp' 2>/dev/null | wc -l | tr -d ' ')
            _mat_files=$((_mat_files + _mat_sess))
          fi
        done
      fi
      echo "  active daemons: $_mat_running (one per running web session)"
      echo "  materialized:   $_mat_files file(s) across all sessions"
      if [[ "${OCVM_MATERIALIZE:-1}" == "0" ]]; then
        echo "  status:         DISABLED via OCVM_MATERIALIZE=0"
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

# ----------------------------------------------------------------------------
# OAuth subscription token helpers (e.g. OpenAI/ChatGPT, GitHub Copilot).
#
# Unlike static API keys (auth.json entries of type "key"), OAuth logins use a
# single-use *rotating* refresh token: each ~hourly refresh yields a new
# access+refresh pair and invalidates the previous refresh token. Because
# opencode-vm snapshots auth.json into every per-project VM, two VMs seeded from
# the same auth.json end up fighting over one rotating chain — the first to
# refresh invalidates the others, which then fail with "401 token refresh
# failed". These helpers locate whichever copy currently holds the freshest
# (latest-`expires`) OAuth token and adopt it into the host auth.json so the
# next session that reads it picks up the live token.
#
# Scope: OAuth entries only (type=="oauth", or a "refresh" field present).
# type:"key" entries are never read or modified by anything below.
# ----------------------------------------------------------------------------

# List provider ids in an auth.json file that are OAuth (refreshable).
auth_oauth_provider_ids() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r 'to_entries[]
         | select((.value.type? == "oauth") or (.value | has("refresh")))
         | .key' "$file" 2>/dev/null || true
}

# Echo the `expires` value (epoch-ms; 0 when absent/invalid) for one provider.
auth_oauth_expires() {
  local file="$1" provider="$2"
  { [[ -f "$file" ]] && command -v jq >/dev/null 2>&1; } || { echo 0; return 0; }
  jq -r --arg p "$provider" '(.[$p].expires // 0) | floor' "$file" 2>/dev/null \
    | grep -Ex '[0-9]+' || echo 0
}

# Format an epoch-ms timestamp for humans (macOS/BSD date).
_auth_fmt_expires() {
  local ms="$1"
  [[ "$ms" =~ ^[0-9]+$ ]] && (( ms > 0 )) || { echo "n/a"; return 0; }
  date -r "$(( ms / 1000 ))" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "$ms"
}

# Human label for where a candidate auth.json came from.
# Args: <path> <host_auth_path> [tmpfiles...] (tmpfiles are VM-sourced copies)
_auth_src_label() {
  local path="$1" host="$2"; shift 2
  local t
  for t in "$@"; do
    [[ "$path" == "$t" ]] && { echo "a running session VM"; return 0; }
  done
  if   [[ "$path" == "$host" ]];                 then echo "host"
  elif [[ "$path" == "$SESSIONS_DIR"/* ]];       then echo "a saved session"
  elif [[ "$path" == "$PROJECT_STATE_DIR"/* ]];  then echo "a project cache"
  else echo "$path"; fi
}

# Core: scan the host auth.json, every per-project session/state copy, and the
# live copy inside each running session VM; for each OAuth provider adopt the
# entry with the latest `expires` into the host auth.json. Pure no-op for files
# with no OAuth entries; type:"key" entries are never touched.
#   $1 = mode: "report" (read-only, default) | "apply" (writes host auth.json)
auth_collect_freshest_oauth() {
  local mode="${1:-report}"
  if ! command -v jq >/dev/null 2>&1; then
    echo "[auth] jq is required for OAuth token sync." >&2
    return 1
  fi
  ensure_dirs
  ensure_host_opencode_dirs
  local host_auth="$HOST_DATA_DIR/auth.json"

  # Candidate auth.json paths (host first, then saved sessions + project caches).
  local -a candidates=()
  [[ -f "$host_auth" ]] && candidates+=("$host_auth")
  local f
  for f in "$SESSIONS_DIR"/*/xdg-data/opencode/auth.json \
           "$PROJECT_STATE_DIR"/*/xdg-data/opencode/auth.json; do
    [[ -f "$f" ]] && candidates+=("$f")
  done

  # Live copy from each running session VM — a running VM holds its freshest
  # (post-refresh) token only in its own /tmp until the session exits.
  local -a tmpfiles=()
  local vm tmp
  while read -r vm; do
    [[ -n "$vm" ]] || continue
    tmp="$(mktemp)"
    # The live auth.json inside the VM is mode 0600 (owned by the VM user, but
    # may be root-owned on VMs seeded by older versions); read it via the
    # guest's passwordless sudo so either ownership works. Web-mode
    # XDG_DATA_HOME is /tmp/oc-xdg-data.
    if limactl shell --workdir / "$vm" -- sudo cat /tmp/oc-xdg-data/opencode/auth.json >"$tmp" 2>/dev/null \
        && [[ -s "$tmp" ]] && jq -e . "$tmp" >/dev/null 2>&1; then
      candidates+=("$tmp")
      tmpfiles+=("$tmp")
    else
      rm -f "$tmp"
    fi
  done < <(limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null \
             | awk -v base="$BASE_NAME" '$2=="Running" && $1 ~ /^oc-/ && $1!=base {print $1}')

  _auth_cleanup_tmp() { local x; for x in ${tmpfiles[@]+"${tmpfiles[@]}"}; do rm -f "$x"; done; }

  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "[auth] No auth.json found on host or in any session."
    _auth_cleanup_tmp; return 0
  fi

  # Union of OAuth provider ids across all candidates.
  local providers
  providers="$(for f in "${candidates[@]}"; do auth_oauth_provider_ids "$f"; done | sort -u)"
  if [[ -z "$providers" ]]; then
    echo "[auth] No OAuth (refreshable) providers found — nothing to sync."
    _auth_cleanup_tmp; return 0
  fi

  local now_ms backup_done=0 updated=0 p
  now_ms="$(( $(date +%s) * 1000 ))"
  for p in $providers; do
    local best_file="" best_exp=-1 host_exp exp has
    for f in "${candidates[@]}"; do
      has="$(jq -r --arg p "$p" '(.[$p] // empty) | if (.type? == "oauth" or has("refresh")) then "y" else empty end' "$f" 2>/dev/null || true)"
      [[ "$has" == "y" ]] || continue
      exp="$(auth_oauth_expires "$f" "$p")"
      if (( exp > best_exp )); then best_exp="$exp"; best_file="$f"; fi
    done
    [[ -n "$best_file" ]] || continue
    host_exp="$(auth_oauth_expires "$host_auth" "$p")"

    local note=""
    (( best_exp <= now_ms )) && note="  [all copies expired — re-login: 'opencode auth login' inside a session]"
    local src
    src="$(_auth_src_label "$best_file" "$host_auth" ${tmpfiles[@]+"${tmpfiles[@]}"})"
    echo "  $p: host=$(_auth_fmt_expires "$host_exp")  freshest=$(_auth_fmt_expires "$best_exp") (from $src)$note"

    if (( best_exp > host_exp )) && [[ "$best_file" != "$host_auth" ]]; then
      if [[ "$mode" == "apply" ]]; then
        if (( backup_done == 0 )); then
          local ts backup_dir
          ts="$(date +%Y%m%d-%H%M%S)"
          backup_dir="$BACKUP_DIR/auth-$ts"
          mkdir -p "$backup_dir"
          [[ -f "$host_auth" ]] && cp -p "$host_auth" "$backup_dir/auth.json.bak"
          echo "  (backup: $backup_dir/auth.json.bak)"
          backup_done=1
        fi
        local newentry tmp_out
        newentry="$(jq -c --arg p "$p" '.[$p]' "$best_file")"
        tmp_out="$(mktemp)"
        if [[ -f "$host_auth" ]]; then
          jq --arg p "$p" --argjson v "$newentry" '.[$p] = $v' "$host_auth" >"$tmp_out" \
            && mv "$tmp_out" "$host_auth" && updated=1 || rm -f "$tmp_out"
        else
          jq -n --arg p "$p" --argjson v "$newentry" '{($p): $v}' >"$tmp_out" \
            && mv "$tmp_out" "$host_auth" && updated=1 || rm -f "$tmp_out"
        fi
        echo "    -> adopted into host auth.json"
      else
        echo "    -> a fresher token exists; run 'opencode-vm auth resync' to adopt it"
      fi
    fi
  done

  if [[ "$mode" == "apply" ]]; then
    if (( updated == 1 )); then
      echo "[auth] Host auth.json updated. Restart (or 'opencode-vm attach') the failing session so it re-reads the token."
    else
      echo "[auth] Host already holds the freshest OAuth token — nothing to do."
    fi
  fi
  _auth_cleanup_tmp
  return 0
}

# `opencode-vm auth {status|resync}`
auth_cmd() {
  local op="${1:-status}"
  shift || true
  case "$op" in
    status)
      echo "[auth] OAuth provider token freshness (host vs. running VMs + saved sessions)"
      auth_collect_freshest_oauth report
      ;;
    resync)
      auth_collect_freshest_oauth apply
      ;;
    -h|--help|help)
      cat <<'EOF'
Usage: opencode-vm auth {status|resync}
  status   show OAuth providers and which copy holds the freshest token (read-only)
  resync   adopt the freshest OAuth token (across running VMs + saved sessions)
           into the host auth.json, then restart/attach the failing session
EOF
      ;;
    *)
      echo "Usage: opencode-vm auth {status|resync}" >&2
      return 2
      ;;
  esac
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
        # Cleartext (not -s/silent) so the user can see what they type and
        # confirm it is non-empty. These are local processes; a key briefly
        # visible on the console is an acceptable trade-off for usability.
        read -r -p "[provider] API key: " api_key
        if [[ -z "$api_key" ]]; then
          echo "[provider] No API key entered. Aborting (nothing was added)." >&2
          exit 2
        fi
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
          # Top-level "reasoning": true is the models.dev capability flag OpenCode
          # reads for the model-picker badge; reasoningEffort is the runtime knob.
          # provider add always builds an @ai-sdk/openai-compatible provider, so the
          # proxy-understood knob is reasoningEffort (not the native thinking{...}).
          models_json="$(printf '%s' "$models_json" | jq \
            --arg id "$_mid" \
            '.[$id].reasoning = true | .[$id].options.reasoningEffort = "medium"')"
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

      # OpenCode's auth.json discriminates on "type" with values oauth|api|wellknown.
      # A static API key MUST be type "api" (not "key", which OpenCode ignores ->
      # "API key not present" at runtime even though the key sits in the file).
      jq_inplace "$auth_file" --arg p "$provider" --arg k "$api_key" \
        '.[$p] = {"type":"api","key":$k}'

      jq_inplace "$cfg_file" \
        --arg p "$provider" \
        --arg n "$provider_name" \
        --arg b "$base_url" \
        --argjson m "$models_json" \
        '.provider = ((.provider // {}) + {($p): {"npm":"@ai-sdk/openai-compatible","name":$n,"options":{"baseURL":$b},"models":$m}})'

      # Enrich the host config in place (fill-only): backfills limit/modalities/
      # reasoning by model-id for frontier models the name heuristic can't classify
      # (claude-*, gpt-*). Without this the host config keeps raw entries with no
      # reasoning flag; only the ephemeral session copy got enriched at start, so
      # the user inspecting the host config saw "no reasoning" on every model.
      apply_model_enrichment "$cfg_file"

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

      jq_inplace "$cfg_file" --arg p "$provider" --argjson m "$updated_models" \
        '.provider[$p].models = $m'

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
          jq_inplace "$auth_file" --arg p "$provider" 'del(.[$p])'
        else
          echo "[provider] WARNING: jq missing, auth.json not modified." >&2
        fi
      fi

      if [[ -f "$cfg_file" ]] && command -v jq >/dev/null 2>&1; then
        if jq -e . "$cfg_file" >/dev/null 2>&1; then
          jq_inplace "$cfg_file" --arg p "$provider" 'del(.provider[$p])'
        else
          echo "[provider] WARNING: config file is not valid JSON, skipping provider entry removal." >&2
        fi
      fi

      if [[ -f "$model_file" ]]; then
        if command -v jq >/dev/null 2>&1; then
          jq_inplace "$model_file" --arg p "$provider" '
            .recent = [(.recent // [])[] | select(.providerID != $p)]
            | .favorite = [(.favorite // [])[] | select(.providerID != $p)]
            | .variant = ((.variant // {}) | with_entries(select(.key != $p and ((.value.providerID // "") != $p))))
          '
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

ocvm_post_update_migrate() {
  # Hook for version-to-version migrations. Args: old_version new_version
  # 0.5.0 dropped all pre-0.5 migration shims (proxmox-as-skill state,
  # project-history seeding, searxng auto-enable, legacy .opencode.json
  # shadowing). Upgrading from pre-0.4.x state: upgrade through the latest
  # 0.4.x first, or re-run `opencode-vm init`.
  [[ "$#" -eq 2 ]] || return 0
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
  echo "Built-in skills: webimg (web image optimization), ssh-toolkit (SSH/network workflows) — both default-active"
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

  limactl start --cpus "$DEFAULT_VM_CPUS" --memory "$DEFAULT_VM_MEMORY_GIB" --name "$BASE_NAME" --vm-type vz --mount-none --mount-type virtiofs --timeout 20m --tty=false "$tmpl_file" || {
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

  # Wait for Docker to be ready (replaces the removed Lima probe). Cold cloud-init
  # on slow disks can take 5+ minutes — the previous 120s budget was too tight
  # and frequently failed with "Docker not ready" even though the VM was about
  # to come up. We now poll for up to 10 min (matching Lima's 20-min budget for
  # the start phase) and report progress every 30s so the wait isn't silent.
  echo "[init] Waiting for Docker daemon (up to 10 min on cold start)..."
  retries=0
  local max_retries=300   # 300 × 2s = 600s
  while ! limactl shell "$BASE_NAME" -- docker info >/dev/null 2>&1; do
    retries=$((retries + 1))
    if (( retries > max_retries )); then
      echo "[init] Docker still not ready after $((max_retries * 2))s." >&2
      echo "[init]   Diagnosis hints:" >&2
      echo "[init]     limactl shell $BASE_NAME -- cloud-init status --long" >&2
      echo "[init]     limactl shell $BASE_NAME -- sudo cat /var/log/cloud-init-output.log | tail -50" >&2
      echo "[init]   Recovery: re-run 'opencode-vm init' (it deletes and rebuilds oc-base)." >&2
      exit 1
    fi
    if (( retries % 15 == 0 )); then
      echo "[init]   ...still waiting on Docker ($((retries * 2))s elapsed)"
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
  less nano vim-tiny file tree shellcheck \
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

# Install Playwright MCP globally + Chrome for Testing for headless UI testing.
# Pin to cdn.playwright.dev — the default playwright.azureedge.net mirror has
# been observed throttling to ~100 KB/s, turning the 185 MB browser download
# into a 30-min stall. cdn.playwright.dev serves the same artifacts at full speed.
npm install -g @playwright/mcp@latest svgo mcp-searxng@1.0.3

# Create NVM-version-independent symlink so playwright-mcp stays available
# even when the agent switches Node versions with nvm use. Must come before
# install-browser so the CLI is on PATH regardless of the active Node version.
mkdir -p ~/.local/bin
ln -sf "$(npm prefix -g)/bin/playwright-mcp" ~/.local/bin/playwright-mcp

# No-op xdg-open: `opencode web` tries to auto-open a browser on startup, but
# this VM is headless and accessed remotely over the LAN tunnel. Without a
# handler the spawn throws a scary "Executable not found: xdg-open" ENOENT on
# every (re)start. ~/.local/bin is ahead of $PATH, so this stub wins; it just
# logs the URL and exits 0, turning the auto-open into a harmless no-op.
cat > ~/.local/bin/xdg-open <<'XDGOPEN'
#!/usr/bin/env bash
echo "[xdg-open] headless VM — open this on your host browser: $*" >&2
exit 0
XDGOPEN
chmod +x ~/.local/bin/xdg-open

# Use the MCP's own resolver: since @playwright/mcp@0.0.74 the alias
# `--browser chromium` maps to channel `chrome-for-testing`, which is a
# different binary than `npx playwright install chromium` would fetch. Letting
# playwright-mcp drive the install ensures the channel + revision match the
# bundled playwright-core regardless of future MCP version bumps.
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.playwright.dev \
  playwright-mcp install-browser chrome-for-testing

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
# graphifyy ships its MCP server (graphify.serve) but the runtime dep `mcp`
# is gated behind the `[mcp]` extras — installing the bare package leaves
# `python -m graphify.serve` crashing with ModuleNotFoundError, which in turn
# makes OpenCode show graphify as "failed and disabled". Always include the
# extras so the wrapper at /usr/local/bin/graphify-serve-wrapper.sh works.
~/.local/bin/pipx install 'graphifyy[mcp]==0.4.32' >/dev/null \
  || ~/.local/bin/pipx install --force 'graphifyy[mcp]==0.4.32' >/dev/null
# Belt-and-suspenders: if a previous install of bare graphifyy is still around
# without the mcp extras, inject the missing module into its venv directly.
~/.local/bin/pipx inject graphifyy mcp >/dev/null 2>&1 || true
# Patch graphifyy so its hardcoded output dir is .graphify-out (hidden) rather
# than graphify-out. Upstream offers no override flag, env var, or config; the
# only way to rename the on-disk artefact is to replace the literal in the
# installed site-packages. Pinned-version-safe — the install line above locks
# 0.4.32, so the patch surface is fixed. A future version bump revisits this
# block automatically. The sanity-check at the end exits the build loudly if
# any 'graphify-out' occurrences remain, so an incomplete patch never ships.
# Python identifiers can't contain hyphens, so 'graphify-out' only ever appears
# inside string literals or comments — safe to globally rewrite.
for GRAPHIFY_SRC in ~/.local/share/pipx/venvs/graphifyy/lib/python*/site-packages/graphify; do
  [ -d "$GRAPHIFY_SRC" ] || continue
  # Idempotent + boundary-safe:
  # - leading boundary [^.] avoids re-prefixing an already-patched .graphify-out
  #   on second runs (pipx skips identical-version reinstalls and leaves the
  #   previously-patched source on disk)
  # - trailing boundary [^a-zA-Z0-9_-] avoids false matches on graphify-output
  #   or graphify-out-other (defensive — no such identifiers are known today)
  graphify_match='(^|[^.])graphify-out([^a-zA-Z0-9_-]|$)'
  grep -rlE --include='*.py' "$graphify_match" "$GRAPHIFY_SRC" 2>/dev/null \
    | xargs -r sed -i -E "s/$graphify_match/\1.graphify-out\2/g"
  find "$GRAPHIFY_SRC" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
done
for GRAPHIFY_SRC in ~/.local/share/pipx/venvs/graphifyy/lib/python*/site-packages/graphify; do
  [ -d "$GRAPHIFY_SRC" ] || continue
  # After patching, every former 'graphify-out' is now '.graphify-out'.
  # A bare 'graphify-out' still in source means our patch missed an occurrence
  # (e.g. upstream restructured) — fail the build loudly.
  if grep -rqE --include='*.py' '(^|[^.])graphify-out([^a-zA-Z0-9_-]|$)' "$GRAPHIFY_SRC" 2>/dev/null; then
    echo "[graphify] FATAL: bare 'graphify-out' still present in $GRAPHIFY_SRC after patch" >&2
    grep -rnE --include='*.py' '(^|[^.])graphify-out([^a-zA-Z0-9_-]|$)' "$GRAPHIFY_SRC" >&2 || true
    exit 1
  fi
done
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

# ocvm-materialize: poll OpenCode session storage for FilePart entries that
# carry a data: URI (the web UI's "+" upload mechanism inlines uploads as
# base64) and write them to disk so the agent's tools get a real path.
# Pure stdlib Python, no inotify dependency. Started by start_session in
# web mode; stops on SIGTERM.
mkdir -p ~/.local/bin
cat > ~/.local/bin/ocvm-materialize <<'OCVMMAT'
#!/usr/bin/env python3
"""
ocvm-materialize: poll OpenCode's SQLite store (opencode.db) for FilePart
rows whose `url` carries an inline `data:` URI (web-UI "+" uploads) and
persist them to disk under $OCVM_ATTACHMENTS_DIR/<session-id>/.

OpenCode stores messages and parts in SQLite (WAL mode), not as JSON
files. We open the DB read-only via `?mode=ro` — safe for concurrent reads
while opencode writes.

Env:
  OPENCODE_DATA_DIR      OpenCode XDG_DATA_HOME/opencode root
                         (defaults to /tmp/oc-xdg-data/opencode)
  OCVM_OPENCODE_DB       Override DB path (defaults to
                         $OPENCODE_DATA_DIR/opencode.db)
  OCVM_ATTACHMENTS_DIR   Destination root (required)
  OCVM_MATERIALIZE_LOG   Log file (optional)
  OCVM_MATERIALIZE_POLL  Poll interval seconds (default 0.5)
"""

import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import signal
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import unquote

POLL_INTERVAL = float(os.environ.get("OCVM_MATERIALIZE_POLL", "0.5"))
DATA_DIR = Path(os.environ.get("OPENCODE_DATA_DIR", "/tmp/oc-xdg-data/opencode"))
DB_PATH = Path(os.environ.get("OCVM_OPENCODE_DB", str(DATA_DIR / "opencode.db")))
ATT_DIR_ENV = os.environ.get("OCVM_ATTACHMENTS_DIR")
if not ATT_DIR_ENV:
    sys.stderr.write("ocvm-materialize: OCVM_ATTACHMENTS_DIR not set\n")
    sys.exit(2)
ATTACHMENTS_DIR = Path(ATT_DIR_ENV)
LOG_FILE = Path(os.environ.get("OCVM_MATERIALIZE_LOG",
                               str(ATTACHMENTS_DIR.parent / "materialize.log")))

DATA_URI_RE = re.compile(r"^data:([^;,]+)?(;[^,]*)?,(.*)$", re.DOTALL)


def setup_logging():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=str(LOG_FILE),
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )


def decode_data_url(url):
    m = DATA_URI_RE.match(url)
    if not m:
        return None
    mime = (m.group(1) or "application/octet-stream").strip()
    params = (m.group(2) or "").lower()
    payload = m.group(3)
    if "base64" in params:
        try:
            data = base64.b64decode(payload, validate=False)
        except Exception:
            return None
    else:
        data = unquote(payload).encode("utf-8", errors="replace")
    return mime, data


def safe_filename(name, mime):
    if name:
        name = os.path.basename(name)
        name = re.sub(r"[^\w.\-+]", "_", name)
        name = name[:120].lstrip(".")
        if name:
            return name
    ext = mimetypes.guess_extension(mime) or ".bin"
    return f"attachment{ext}"


def update_index(session_dir, part_id, filename, mime):
    idx_file = session_dir / "index.json"
    idx = {}
    if idx_file.exists():
        try:
            idx = json.loads(idx_file.read_text())
            if not isinstance(idx, dict):
                idx = {}
        except Exception:
            idx = {}
    idx[part_id] = {
        "filename": filename,
        "mime": mime,
        "timestamp": time.time(),
    }
    tmp = idx_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, indent=2, sort_keys=True))
    tmp.rename(idx_file)


def materialize(session_id, part_id, filename, mime, data):
    session_dir = ATTACHMENTS_DIR / re.sub(r"[^\w.\-]", "_", session_id or "default")
    session_dir.mkdir(parents=True, exist_ok=True)
    final_name = safe_filename(filename, mime)
    target = session_dir / final_name
    new_sha = hashlib.sha256(data).hexdigest()
    if target.exists():
        try:
            existing_sha = hashlib.sha256(target.read_bytes()).hexdigest()
        except Exception:
            existing_sha = None
        if existing_sha == new_sha:
            update_index(session_dir, part_id, target.name, mime)
            return target
        base, ext = os.path.splitext(final_name)
        i = 1
        while (session_dir / f"{base}-{i}{ext}").exists():
            i += 1
        target = session_dir / f"{base}-{i}{ext}"
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.rename(target)
    update_index(session_dir, part_id, target.name, mime)
    return target


def extract_data_url_part(blob):
    """`blob` is the raw `data` column text. OpenCode stores the part object
    directly as JSON. Returns the parsed dict if it carries a data: URI,
    else None.
    """
    if not blob or "data:" not in blob:
        return None
    try:
        obj = json.loads(blob)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    url = obj.get("url")
    if isinstance(url, str) and url.startswith("data:"):
        return obj
    return None


def scan_db(seen):
    """Open opencode.db read-only and emit any newly-seen FilePart rows."""
    if not DB_PATH.exists():
        return
    uri = f"file:{DB_PATH}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    except sqlite3.Error as e:
        logging.warning("sqlite connect failed: %s", e)
        return
    try:
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.execute(
                "SELECT id, session_id, message_id, data "
                "FROM part WHERE data LIKE '%\"data:%' "
                "ORDER BY time_created"
            )
        except sqlite3.Error as e:
            logging.warning("sqlite query failed: %s", e)
            return
        for row in cur:
            pid = row["id"]
            if pid in seen:
                continue
            part = extract_data_url_part(row["data"])
            if not part:
                seen.add(pid)  # negative cache — don't reparse next loop
                continue
            decoded = decode_data_url(part["url"])
            if not decoded:
                seen.add(pid)
                continue
            mime = part.get("mime") or decoded[0]
            try:
                target = materialize(
                    row["session_id"], pid, part.get("filename"), mime, decoded[1]
                )
                logging.info("materialized sid=%s pid=%s -> %s",
                             row["session_id"], pid, target)
                seen.add(pid)
            except Exception:
                logging.exception("materialize failed sid=%s pid=%s",
                                  row["session_id"], pid)
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    setup_logging()
    ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
    logging.info("ocvm-materialize starting db=%s out=%s",
                 DB_PATH, ATTACHMENTS_DIR)
    seen = set()
    running = [True]

    def stop(*_):
        running[0] = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while running[0]:
        try:
            scan_db(seen)
        except Exception:
            logging.exception("scan loop error")
        # Drain in small slices so SIGTERM is responsive.
        for _ in range(max(1, int(POLL_INTERVAL * 10))):
            if not running[0]:
                break
            time.sleep(0.1)

    logging.info("ocvm-materialize stopped")


if __name__ == "__main__":
    main()
OCVMMAT
chmod +x ~/.local/bin/ocvm-materialize
echo "[init] ocvm-materialize installed at ~/.local/bin/ocvm-materialize"

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

## Coding Principles

1. **Think before coding.** State your assumptions explicitly. If the request is ambiguous or you see multiple reasonable interpretations, surface them and ask before implementing. If no user is available to ask (autonomous or A2A runs), choose the most minimal interpretation consistent with the request and state the assumption in your report.
2. **Simplicity first (YAGNI).** Deliver the minimal code that solves the stated problem. **Follow YAGNI** ("You Aren't Gonna Need It"): no speculative features, unrequested abstractions, or flexibility for imagined future needs. If a need is real, add it when it arrives.
3. **Surgical changes.** Modify only what's required for the request. Preserve existing style and structure; don't fold in unrelated refactors or "while I'm here" cleanups.
4. **Stay in scope.** A finding discovered during implementation or testing may enter the current implementation cycle only if it is required to (a) make the agreed goal functional, (b) fix a regression caused by the current patch, or (c) pass a mandatory validation of the current scope. Everything else — improvement ideas, side issues, additional hardening — is documented and reported at the end, never implemented.
5. **Goal-driven execution.** Turn vague tasks into verifiable success criteria. Validate each step (build, test, run) before declaring the task done.
6. **User-facing work follows POLA.** For UI/UX, CLI output, prompts, messages, and errors, balance YAGNI with the **Principle of Least Astonishment**: the interface must behave the way users already expect, honoring established conventions and the context of the interaction. YAGNI governs the *feature set* (don't build what isn't needed); POLA governs *behavior* (whatever you do build must not surprise). Reconcile the two with **progressive disclosure** (minimal default surface, depth revealed when needed) and **sensible defaults over configuration**.

## System Privileges

- **sudo**: available without password. Use freely for installing packages, configuring services, changing system settings, inspecting processes, etc.
- **root access**: `sudo -i` or `sudo bash` for a root shell if needed.
- **Service management**: `sudo systemctl start/stop/restart <service>`.
- **Only restriction**: firewall and security-policy management are controlled by the host and cannot be modified from within the VM.

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
- **DNS**: `dig`, `nslookup`, `host` (bind9-dnsutils); `drill <name>` — alternative resolver (DNSSEC trace, CH-class)
- **TCP/IP connectivity**: `nc` (netcat-openbsd), `ncat` (from nmap, with TLS/SSL), `socat`, `telnet` (inetutils-telnet, real telnet)
- **Port scanning/testing**: `nc -zv <host> <port>` for a single port; `nmap -p 1-1000 <host>` for ranges; `nmap -sn 192.168.1.0/24` for ping-sweep
- **LAN discovery**: `sudo arp-scan --localnet` (use `--interface` if multi-iface); `arping <ip>` — single-host ARP reachability
- **Routing & latency**: `ping`, `traceroute`, `tracepath <host>`, `tcptraceroute <host> <port>` (TCP-based, gets through firewalls), `mtr` (mtr-tiny), `ip` (iproute2); `ipcalc 192.168.1.0/24` — subnet math
- **Packet capture & analysis**: `sudo tcpdump` (requires sudo for raw sockets); `tshark` — CLI Wireshark for protocol-level inspection (run with `sudo`); `hping3` — crafted-packet probes (use carefully — can stress LANs)
- **Bandwidth & interface diagnostics**: `iperf3`; `iftop -i <iface>` — live bandwidth per connection (TUI); `nethogs <iface>` — live bandwidth per process (TUI); `ethtool <iface>` — link/PHY/driver info; `brctl show` — bridge topology (bridge-utils); `vconfig` — VLAN inspection
- **SSL/TLS inspection**: `openssl s_client -connect <host>:<port>`; `gnutls-cli host:443` — alternative TLS client (different stack, useful for cross-checks)
- **Domain lookups**: `whois`
- **Bulk transfers**: `lftp` — sftp/http/ftp client with `mirror`, scriptable

### Examples

```bash
# Test if a service is reachable on a specific port
nc -zv host.lima.internal 1234

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

If mounted, the `web-image-pipeline` skill provides detailed workflows, quality defaults, and reporting format for production web image optimization.

## Network Configuration

- **Internet**: full outbound access (HTTP/HTTPS and all protocols)
- **Host services** (from inside VM via `host.lima.internal`):
  - LM Studio: `http://host.lima.internal:1234`
  - Ollama: `http://host.lima.internal:11434`
- **LAN**: restricted by default (host can configure via `opencode-vm ports`)
- **DNS**: works normally, resolved via Lima host DNS
- **Firewall**: managed by the host and cannot be modified from within the VM

## Host LAN IP Variable

Each session exports the host's LAN IP as `OCVM_HOST_LAN_IP` (aliases: `HOST_LAN_IP`, `LANIP`). The current value and URL guidance are in the "Host LAN IP (Session)" section appended below.

## Build Caches

All build caches are redirected to VM-local `/tmp/` for performance. They do not persist across sessions: npm, pip, Go, Cargo, Maven, Gradle, pnpm, yarn, ccache, Zig.

## Shared Files from Host Desktop

The host user can place files or folders in a directory called **opencode-share** on their
macOS Desktop. When this directory exists at session start, it is mounted **read-write**
into the VM and accessible at two paths:
- `~/Desktop/opencode-share` (symlinked for convenience)
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

**Location:** `~/Desktop/opencode-share/`
**Filename pattern:** `Screenshot Capture - YYYY-MM-DD - HH-MM-SS.png`

When the user mentions a "screenshot" in their prompt:
1. List all files matching `Screenshot Capture - *.png` in `~/Desktop/opencode-share/`
2. Identify the newest file by its filename timestamp
3. Analyze that image file
4. After analysis, delete **all** `Screenshot Capture - *.png` files in that directory
   (the one you just analyzed and any older ones) to keep the folder clean

If no matching screenshot file is found:
- The screenshot feature may not be configured yet
- Tell the user to exit this session, run `opencode-vm screenshot` in a host terminal,
  follow the setup instructions, and then start a new session

## Web Search

The built-in `websearch` tool is available for online research (documentation, API references, error messages). If an active MCP section later in this file documents a preferred search tool (e.g. SearXNG metasearch), follow that preference.

## Important Notes

- The project directory is shared with the host. File changes are immediately visible on both sides.
- Session VMs are ephemeral — anything outside the project directory or OpenCode state is lost when the session ends.
- Globally installed tools (via apt, npm -g, pip, go install) persist only within the current session.

## Project Design References

For any frontend, UI, or visual-design task, check the project root (and the root of any relevant sub-project, e.g. a mono-repo package) for a `DESIGN.md` file. If present, treat it as authoritative for design system, colors, typography, and component conventions. One public source of such files is [awesome-design-md](https://github.com/VoltAgent/awesome-design-md).
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

  # LAN allowlists: "IP:PORT" -> nft IP.PORT tuple, "IP" (ohne Port) -> Host-Set
  # (alle Ports). Overlaps (e.g. a single IP plus a /24 that covers it) are
  # collapsed first, otherwise nft rejects the interval set with "conflicting
  # intervals".
  local lan_tcp_elems lan_host_tcp_elems lan_udp_elems lan_host_udp_elems
  lan_tcp_elems="$(_lan_tuple_elems "$LAN_ALLOW_TCP")"
  lan_host_tcp_elems="$(_lan_host_elems "$LAN_ALLOW_TCP")"
  lan_udp_elems="$(_lan_tuple_elems "$LAN_ALLOW_UDP")"
  lan_host_udp_elems="$(_lan_host_elems "$LAN_ALLOW_UDP")"

  cat <<EOF
[run] Applying policy inside VM:
  HOST_TCP_PORTS: $HOST_TCP_PORTS
  LAN_ALLOW_TCP:  ${LAN_ALLOW_TCP:-<empty>}
  LAN_ALLOW_UDP:  ${LAN_ALLOW_UDP:-<empty>}
EOF

  # Host values travel as positional parameters (never interpolated into the
  # remote command string) — the vm_exec injection-safe pattern.
  vm_exec "$1" '
    set -euo pipefail
    host_ports_csv="$1"
    lan_tcp_elems="$2"
    lan_udp_elems="$3"
    lan_host_tcp_elems="$4"
    lan_host_udp_elems="$5"

    # Flush + re-add sets (idempotent)
    sudo -n nft flush set inet ocfilter host_allow_tcp
    if [[ -n "$host_ports_csv" ]]; then
      sudo -n nft add element inet ocfilter host_allow_tcp "{ $host_ports_csv }"
    fi

    sudo -n nft flush set inet ocfilter lan_allow_tcp4
    if [[ -n "$lan_tcp_elems" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_tcp4 "{ $lan_tcp_elems }"
    fi

    sudo -n nft flush set inet ocfilter lan_allow_udp4
    if [[ -n "$lan_udp_elems" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_udp4 "{ $lan_udp_elems }"
    fi

    sudo -n nft flush set inet ocfilter lan_allow_host_tcp4
    if [[ -n "$lan_host_tcp_elems" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_host_tcp4 "{ $lan_host_tcp_elems }"
    fi

    sudo -n nft flush set inet ocfilter lan_allow_host_udp4
    if [[ -n "$lan_host_udp_elems" ]]; then
      sudo -n nft add element inet ocfilter lan_allow_host_udp4 "{ $lan_host_udp_elems }"
    fi

    sudo -n nft list table inet ocfilter >/dev/null
  ' "$host_ports_csv" "$lan_tcp_elems" "$lan_udp_elems" "$lan_host_tcp_elems" "$lan_host_udp_elems"
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

  vm_exec "$vm_name" '
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
  ' "$HOST_TCP_PORTS"
}

stop_host_port_forwards_in_vm() {
  local vm_name="$1"
  vm_exec "$vm_name" '
    set +e
    for port in $1; do
      [[ -n "$port" ]] || continue
      unit="ocvm-hostfwd-${port}.service"
      sudo -n systemctl disable --now "$unit" 2>/dev/null || true
      sudo -n rm -f "/etc/systemd/system/${unit}" 2>/dev/null || true
    done
    sudo -n systemctl daemon-reload 2>/dev/null || true
  ' "$HOST_TCP_PORTS" || true
}

# Ports that browsers (Chrome, Firefox, Safari) refuse to connect to.
# Hitting one gives ERR_UNSAFE_PORT in the browser, while curl/API clients
# still work. Source: Chromium's net/base/port_util.cc kRestrictedPorts.
BROWSER_UNSAFE_PORTS=(
  1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103
  104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512
  513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995
  1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668
  6669 6697 10080
)

is_browser_unsafe_port() {
  local p="$1" u
  for u in "${BROWSER_UNSAFE_PORTS[@]}"; do
    [[ "$p" == "$u" ]] && return 0
  done
  return 1
}

# Web-mode forwarding: one SSH process carrying all four public forwards of the
# port block, host(0.0.0.0:X) -> VM(127.0.0.1:X).
#
# One ssh, not four:
#   - ExitOnForwardFailure=yes makes the whole block bind atomically. Either all
#     four ports are reserved or none are, so there is no window in which the
#     P/P+1/P+2/P+3 relationship is half-established, and no TOCTOU gap between
#     probing a port and binding it.
#   - One PID, one pidfile, one teardown. Nothing here ever needs to drop a
#     single forward: the offsets are a public contract, so if P+2 is taken the
#     whole block has to move anyway.
#
# Co-existence with Lima's auto-port-forward:
#   - The proxies bind 127.0.0.1 inside the VM. Lima still creates an
#     auto-forward (guestIPMustBeZero: false -> host-IP 127.0.0.1), so the host
#     gets loopback-only listeners for free.
#   - These forwards bind 0.0.0.0 — a different bind address, no conflict. The
#     LAN/NetBird path is exclusively this tunnel.
#
# Host port == VM port. Before the A2A work only the host port shifted on a
# collision, which is unrepresentable now that the agent card must advertise an
# absolute URL: the effective base is chosen here and then handed to the VM.
WEB_PORT_BASE=""

# $1 vm name, $2 requested base port. On success WEB_PORT_BASE holds the base
# that was actually reserved.
start_web_tunnels() {
  local vm="$1" req="$2"
  [[ -n "$vm" && -n "$req" ]] || return 1
  WEB_PORT_BASE=""

  local ssh_port
  ssh_port="$(limactl list -f '{{.SSHLocalPort}}' "$vm" 2>/dev/null)"
  if [[ -z "$ssh_port" || "$ssh_port" == "0" || ! "$ssh_port" =~ ^[0-9]+$ ]]; then
    echo "[tunnel] ERROR: could not determine SSH port for $vm (got: '$ssh_port')" >&2
    return 1
  fi

  load_policy 2>/dev/null || true   # for the HOST_TCP_PORTS overlap check

  # The forward authenticates as the *guest* user, which is not always the
  # host user (see lima_guest_user) — ${USER}@ would lock those hosts out of
  # every LAN tunnel.
  local guest_user
  guest_user="$(lima_guest_user "$vm")"
  [[ -n "$guest_user" ]] || guest_user="$USER"

  # Fail fast on anything that is not a port collision. Without this, an
  # unreachable sshd or a rejected login walks all ten candidate blocks and
  # then reports "no free ports" — pointing the user at lsof when the real
  # problem was SSH itself.
  local ssh_err
  if ! ssh_err="$(ssh -F /dev/null \
        -o IdentityFile="$HOME/.lima/_config/user" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o NoHostAuthenticationForLocalhost=yes \
        -o IdentitiesOnly=yes \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o ControlMaster=no \
        -p "$ssh_port" "${guest_user}@127.0.0.1" true 2>&1)"; then
    echo "[tunnel] ERROR: SSH into $vm failed (${guest_user}@127.0.0.1:${ssh_port}) — LAN tunnels unavailable." >&2
    [[ -n "$ssh_err" ]] && echo "[tunnel]   ssh: $(printf '%s\n' "$ssh_err" | tail -1)" >&2
    return 1
  fi

  local base p ok pid err_file
  err_file="$(mktemp 2>/dev/null || echo "/tmp/ocvm-tunnel-$$.err")"
  for base in $(seq "$req" $((req + 9))); do
    # Never bind a block that touches the browser unsafe-port list: browsers
    # refuse those outright (ERR_UNSAFE_PORT), so the banner would advertise
    # URLs no browser can open. Reached with a port persisted in session.env
    # before validate_web_port checked this, or when the shift below would
    # otherwise walk into the range.
    ok=1
    for p in "$base" $((base + 1)) $((base + 2)) $((base + 3)); do
      if is_browser_unsafe_port "$p"; then
        if [[ "$base" == "$req" ]]; then
          echo "[tunnel] Base port ${req}: port ${p} of block ${req}..$((req + 3)) is browser-blocked (ERR_UNSAFE_PORT) — moving to a browser-safe block."
        fi
        ok=0; break
      fi
    done
    (( ok )) || continue
    # Sweep any tunnel of ours left on this base before probing it.
    stop_web_tunnels "$vm" "$base" >/dev/null 2>&1 || true
    ok=1
    for p in "$base" $((base + 1)) $((base + 2)) $((base + 3)); do
      if ! _port_free_for_bind "$p"; then ok=0; break; fi
    done
    (( ok )) || continue

    if ssh -f -N -F /dev/null \
        -o IdentityFile="$HOME/.lima/_config/user" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o NoHostAuthenticationForLocalhost=yes \
        -o IdentitiesOnly=yes \
        -o ExitOnForwardFailure=yes \
        -o ServerAliveInterval=30 \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -o ControlMaster=no \
        -L "0.0.0.0:${base}:127.0.0.1:${base}" \
        -L "0.0.0.0:$((base + 1)):127.0.0.1:$((base + 1))" \
        -L "0.0.0.0:$((base + 2)):127.0.0.1:$((base + 2))" \
        -L "0.0.0.0:$((base + 3)):127.0.0.1:$((base + 3))" \
        -p "$ssh_port" "${guest_user}@127.0.0.1" 2>"$err_file"; then
      pid="$(pgrep -f "ssh -f -N .*-L 0\.0\.0\.0:${base}:127\.0\.0\.1:${base} .*-p ${ssh_port} " | head -1)"
      # The Lima SSH port goes in as line 2: after `limactl delete` the instance
      # can no longer be looked up, and without it the fallback sweep below
      # would not be able to tell this VM's tunnel from another VM's.
      [[ -n "$pid" ]] && printf '%s\n%s\n' "$pid" "$ssh_port" > "/tmp/ocvm-tunnel-${vm}-${base}.pid"
      WEB_PORT_BASE="$base"
      if [[ "$base" != "$req" ]]; then
        echo "[tunnel] Requested base port ${req} was unavailable — the block moved to ${base}."
      fi
      echo "[tunnel] LAN tunnels up (pid ${pid:-?}): ${base} web/https, $((base + 1)) web/http, $((base + 2)) a2a/https, $((base + 3)) a2a/http"
      rm -f "$err_file"
      return 0
    fi
  done

  if [[ -s "$err_file" ]]; then
    echo "[tunnel] ERROR: last ssh attempt said: $(tail -1 "$err_file")" >&2
  fi
  rm -f "$err_file"
  echo "[tunnel] ERROR: no free browser-safe block of four consecutive host ports in ${req}..$((req + 12))." >&2
  echo "[tunnel]   web mode needs P (web https), P+1 (web http), P+2 (a2a https), P+3 (a2a http)." >&2
  echo "[tunnel]   Diagnose: lsof -nP -iTCP:${req}-$((req + 12)) -sTCP:LISTEN" >&2
  echo "[tunnel]   Pick another base: opencode-vm web --port 8080" >&2
  echo "[tunnel]   If a limactl process holds one, stop & restart the VM to clear it:" >&2
  echo "[tunnel]     limactl stop ${vm} && limactl start ${vm}" >&2
  return 1
}

# Idempotent, and safe for a base that was never bound. One call tears down all
# four forwards, because they share a single ssh process.
stop_web_tunnels() {
  local vm="$1" base="$2" pidfile pid ssh_port
  [[ -n "$vm" && -n "$base" ]] || return 0
  pidfile="/tmp/ocvm-tunnel-${vm}-${base}.pid"
  if [[ -f "$pidfile" ]]; then
    pid="$(sed -n 1p "$pidfile" 2>/dev/null || true)"
    ssh_port="$(sed -n 2p "$pidfile" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  # Fallback for a torn pidfile. Scoped by the Lima SSH port, which is the only
  # per-VM token in the ssh argv — without it this would kill another VM's
  # tunnel on the same host port.
  [[ -z "${ssh_port:-}" ]] && ssh_port="$(limactl list -f '{{.SSHLocalPort}}' "$vm" 2>/dev/null || true)"
  if [[ -n "${ssh_port:-}" && "$ssh_port" != "0" ]]; then
    pkill -f "ssh -f -N .*-L 0\.0\.0\.0:${base}:127\.0\.0\.1:${base} .*-p ${ssh_port} " 2>/dev/null || true
  fi
  return 0
}

# ---------------------------------------------------------------------------
# In-VM web redirector
#
# Why this exists: opencode's web UI only opens a project via the route
# /<base64url(dir)>. Its root URL renders a project launcher whose list is
# client-side state — in a fresh browser it is empty, so the bare host:port URL
# reaches no project at all. opencode web has no project argument and no
# redirect setting, so the only lever is an HTTP hop in front of it.
#
# Design: opencode moves to a VM-internal port; this listens on the port the
# SSH tunnel forwards to, so every host-side URL, tunnel and firewall rule
# stays exactly as before. A browser navigating to "/" gets a 302 to the
# project deep link; everything else is spliced through as raw TCP, which
# keeps the UI's WebSocket upgrade (and keep-alive, and chunked bodies)
# untouched — we never parse or re-emit them.
#
# The redirect is gated on "Accept: text/html" so only browser navigation is
# rewritten. API clients, the host-side tunnel probe (curl /) and
# `opencode attach` do not send that, so they pass straight through to
# opencode and still see the real root.
#
# Kept free of single quotes: this is embedded in the single-quoted in-VM
# script as a positional argument.
read -r -d '' OCVM_WEB_REDIRECT_PY <<'PYSRC' || true
import socket, sys, threading, select, ssl, base64, json

LISTEN_PORT = int(sys.argv[1])
TARGET_PORT = int(sys.argv[2])
KEY = sys.argv[3]
# Optional TLS: opencode's web UI hashes attachments via crypto.subtle, which
# browsers expose only in secure contexts. Over a LAN IP that is undefined and
# attaching files fails (opencode issues 11452 / 12989). Terminating TLS here
# makes the origin a secure context; upstream stays plain HTTP on loopback.
CERT_FILE = sys.argv[4] if len(sys.argv) > 4 else ""
KEY_FILE = sys.argv[5] if len(sys.argv) > 5 else ""
TLS_ENABLED = bool(CERT_FILE and KEY_FILE)

TLS_CONTEXT = None
if TLS_ENABLED:
    TLS_CONTEXT = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    TLS_CONTEXT.load_cert_chain(CERT_FILE, KEY_FILE)


def decode_key(key):
    try:
        return base64.urlsafe_b64decode(key + "=" * (-len(key) % 4)).decode("utf-8")
    except Exception:
        return ""


WORKTREE = decode_key(KEY)

# Seeded once per browser, and only where the key is still absent, so anything
# the user changes later survives untouched.
#
# The project entry is what makes chat sessions visible at all: the UI asks the
# server for every session, then filters the answer against the project list it
# keeps in localStorage. A browser that has never opened this project has an
# empty list, so every session is discarded and the view looks empty — which is
# why sessions started on one machine were invisible on another.
#
# showCustomAgents needs agentVisibilityInitialized alongside it, otherwise the
# app's own initializer overwrites the value on first boot. app-version.v1 marks
# the install as not-brand-new so the onboarding overlay does not cover the UI.
# Note the app does NOT rewrite that key afterwards, so the pinned value stays
# put: the cost is that one future "what is new" panel may be skipped, which is
# preferable to an overlay covering the session list on every new device.
SEED_JS = """
(function () {
  var dir = %s, key = %s;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function seed(k, v) { if (get(k) === null) put(k, v); }
  if (dir) {
    var store = null;
    try { store = JSON.parse(get("opencode.global.dat:server")); } catch (e) { store = null; }
    if (!store || typeof store !== "object") store = {};
    if (!Array.isArray(store.list)) store.list = [];
    if (!store.projects || typeof store.projects !== "object") store.projects = {};
    if (!store.lastProject || typeof store.lastProject !== "object") store.lastProject = {};
    if (!store.recentlyClosed || typeof store.recentlyClosed !== "object") store.recentlyClosed = {};
    var open = Array.isArray(store.projects.local) ? store.projects.local : [];
    var known = false;
    for (var i = 0; i < open.length; i++) {
      if (open[i] && open[i].worktree === dir) { known = true; break; }
    }
    if (!known) open.unshift({ worktree: dir, expanded: true });
    store.projects.local = open;
    if (!store.lastProject.local) store.lastProject.local = dir;
    put("opencode.global.dat:server", JSON.stringify(store));
  }
  seed("settings.v3", JSON.stringify({
    general: { showCustomAgents: true, agentVisibilityInitialized: true, showNavigation: true }
  }));
  seed("opencode-color-scheme", "dark");
  seed("app-version.v1", JSON.stringify({ version: "1.18.18" }));
  location.replace("/" + key);
})();
""" % (json.dumps(WORKTREE), json.dumps(KEY))

SEED_HTML = (
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<title>opencode</title>"
    "<noscript><meta http-equiv=\"refresh\" content=\"0;url=/" + KEY + "\"></noscript>"
    "<script>" + SEED_JS + "</script></head><body></body></html>"
).encode("utf-8")

SEED_RESPONSE = (
    b"HTTP/1.1 200 OK\r\n"
    b"Content-Type: text/html; charset=utf-8\r\n"
    b"Cache-Control: no-store\r\n"
    b"Content-Length: " + str(len(SEED_HTML)).encode() + b"\r\n"
    b"Connection: close\r\n"
    b"\r\n" + SEED_HTML
)


def header_value(rest, wanted):
    for header in rest.split(b"\r\n"):
        name, sep, value = header.partition(b":")
        if sep and name.strip().lower() == wanted:
            return value.strip()
    return b""


def wants_seed_page(head):
    # No project key means this listener fronts something that is not the web UI
    # (the a2a endpoints). Without this guard the seed page would be served with
    # an empty key and bounce the client back to "/" forever.
    if not KEY:
        return False
    # Browser navigation to the bare root only. Everything else — the REST API,
    # the host-side tunnel probe, opencode attach — passes straight through.
    line, _, rest = head.partition(b"\r\n")
    parts = line.split(b" ")
    if len(parts) < 2 or parts[0] != b"GET":
        return False
    if parts[1].split(b"?")[0] != b"/":
        return False
    return b"text/html" in header_value(rest, b"accept").lower()


def https_redirect(head):
    # Plain HTTP spoke to the TLS port. Answering with a redirect beats letting
    # the handshake fail, which the browser shows as a connection error.
    line, _, rest = head.partition(b"\r\n")
    parts = line.split(b" ")
    path = parts[1] if len(parts) > 1 else b"/"
    if not path.startswith(b"/"):
        path = b"/"
    host = header_value(rest, b"host")
    if not host:
        host = ("127.0.0.1:" + str(LISTEN_PORT)).encode()
    return (
        b"HTTP/1.1 301 Moved Permanently\r\n"
        b"Location: https://" + host + path + b"\r\n"
        b"Cache-Control: no-store\r\n"
        b"Content-Length: 0\r\n"
        b"Connection: close\r\n"
        b"\r\n"
    )


def read_head(sock):
    head = b""
    try:
        while b"\r\n\r\n" not in head and len(head) < 32768:
            chunk = sock.recv(8192)
            if not chunk:
                break
            head += chunk
    except OSError:
        pass
    return head


def reply_and_close(sock, payload):
    # The request head is fully drained by now, so this closes with FIN, not a
    # RST that would lose the response.
    try:
        sock.sendall(payload)
        sock.shutdown(socket.SHUT_WR)
    except OSError:
        pass
    close_all(sock)


def splice(a, b):
    try:
        while True:
            # A TLS socket can hold already-decrypted bytes that select() cannot
            # see, so drain those before blocking on kernel readability.
            ready = [s for s in (a, b) if getattr(s, "pending", None) and s.pending()]
            if not ready:
                ready, _, _ = select.select([a, b], [], [])
            for src in ready:
                dst = b if src is a else a
                chunk = src.recv(65536)
                if not chunk:
                    return
                dst.sendall(chunk)
    except OSError:
        return


def close_all(*socks):
    for s in socks:
        try:
            s.close()
        except OSError:
            pass


def handle(conn):
    client = conn
    try:
        conn.settimeout(15)
        if TLS_ENABLED:
            # Sniff instead of assuming TLS: 0x16 is a TLS handshake record,
            # anything else is someone talking plain HTTP to this port.
            try:
                first = conn.recv(1, socket.MSG_PEEK)
            except OSError:
                close_all(conn)
                return
            if not first:
                close_all(conn)
                return
            if first[0] == 0x16:
                try:
                    client = TLS_CONTEXT.wrap_socket(conn, server_side=True)
                except (OSError, ssl.SSLError, ValueError):
                    close_all(conn)
                    return
            else:
                reply_and_close(conn, https_redirect(read_head(conn)))
                return
        head = read_head(client)
        client.settimeout(None)
    except OSError:
        close_all(conn, client)
        return

    if wants_seed_page(head):
        reply_and_close(client, SEED_RESPONSE)
        return

    try:
        upstream = socket.create_connection(("127.0.0.1", TARGET_PORT))
    except OSError:
        close_all(client)
        return
    try:
        if head:
            upstream.sendall(head)
        splice(client, upstream)
    except OSError:
        pass
    finally:
        close_all(client, upstream)


server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", LISTEN_PORT))
server.listen(128)
while True:
    # The handshake happens per connection in the worker thread. Wrapping the
    # listening socket instead would run it here, where one client that opens a
    # socket and then says nothing stalls every other connection.
    try:
        conn, _ = server.accept()
    except OSError:
        continue
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
PYSRC

# ---------------------------------------------------------------------------
# In-VM web library
#
# start_session and attach_session each drive opencode inside the VM through a
# single-quoted `bash -lc` script, and both carried the same ~110 lines of
# TLS/redirector/banner plumbing. Two copies is how they drifted apart in the
# first place, so the shared part lives here once and is materialized into the
# session share by install_web_lib(); the in-VM scripts source it.
#
# A file rather than another argv element, because the share is virtiofs-mounted
# into the VM at the same absolute path: the "no single quotes anywhere" rule
# that governs the in-VM script does not apply in here, the result can be linted
# and run in place (bash -n ~/.opencode-vm/sessions/<md5>/lib/web.sh), and the
# `limactl shell` command line stays short.
#
# Contract. The caller sets these before sourcing:
#   PROJ_DIR SESS_SHARE OC_PORT OC_HOST_IP OC_TLS
#   OC_DIR_KEY        (needed by start_web_proxies, may be set after sourcing)
#   OC_BANNER_SUFFIX  appended to the banner title, e.g. " — resumed"
#   OC_BANNER_VERBOSE 1 to include the REST-API paragraph
# and reads these back:
#   OC_PORT_INTERNAL OC_A2A_INTERNAL OC_SCHEME OC_TLS_CERT OC_TLS_KEY
#   OC_PASSWORD OC_USERNAME
#
# Sourced under `set -euo pipefail`, so nothing here may exit non-zero on a
# path the caller tolerates, and the shared globals above must never be
# declared `local`.
read -r -d '' OCVM_WEB_LIB_SH <<'WEBLIB' || true
OC_PORT_INTERNAL=$(( OC_PORT - 1 ))
OC_A2A_INTERNAL=$(( OC_PORT - 2 ))
OC_SCHEME=http
OC_TLS_CERT=""
OC_TLS_KEY=""
OC_PROXY_PY=/tmp/ocvm-proxy.py

# Every proxy this library knows how to start. stop_all_proxies sweeps it, so
# adding a listener means adding its name here and nowhere else.
OC_PROXY_NAMES="web-tls web-plain a2a-tls a2a-plain"

# A pidfile is only acted on when the process it names still carries the marker
# we launched it with. Every supervisor is started as `bash -c ... <marker>`, so
# the marker is its $0 and lands in its own /proc cmdline, and every child gets
# the same marker as an argument it ignores. Deliberately independent of the
# caller: an earlier version matched the parent shell's argv instead, which
# fails silently — the pidfile is removed and the process is left running,
# holding its port forever.
#
# pkill -f is not an option and must not be reintroduced: the entire in-VM
# script is one `bash -lc` argument, so any pattern naming a proxy also matches
# the session shell itself and would take the whole session down with it,
# skipping the EXIT trap that syncs provider logins and chat history back.
_pid_has_marker() {
  [ -n "${1:-}" ] || return 1
  grep -qsF "$2" "/proc/$1/cmdline"
}

# TLS terminates in the proxy so the browser origin is a secure context: the
# opencode web UI hashes attachments through crypto.subtle, which browsers
# withhold from insecure origins, so over a LAN IP attaching files fails
# (opencode issues 11452 / 12989). Upstream stays plain HTTP on loopback.
# The certificate lives in the session share and is reused as long as it still
# covers the current host IP, so a browser exception survives session restarts
# instead of prompting every time.
ensure_web_tls() {
  [ "$OC_TLS" = "1" ] || return 0
  if ! command -v openssl >/dev/null 2>&1; then
    echo "[web] openssl missing — staying on plain HTTP."
    return 0
  fi
  local dir="$SESS_SHARE/tls"
  local crt="$dir/cert.pem"
  local key="$dir/key.pem"
  mkdir -p "$dir"
  local need=1
  if [ -f "$crt" ] && [ -f "$key" ]; then
    if openssl x509 -in "$crt" -noout -checkend 86400 >/dev/null 2>&1 &&
       openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$OC_HOST_IP"; then
      need=0
    fi
  fi
  if [ "$need" = "1" ]; then
    echo "[web] Generating self-signed certificate for $OC_HOST_IP ..."
    if ! openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
         -keyout "$key" -out "$crt" -subj "/CN=opencode-vm" \
         -addext "subjectAltName=IP:$OC_HOST_IP,IP:127.0.0.1,DNS:localhost" \
         >/dev/null 2>&1; then
      echo "[web] Certificate generation failed — staying on plain HTTP."
      return 0
    fi
    chmod 600 "$key" 2>/dev/null || true
  fi
  OC_TLS_CERT="$crt"
  OC_TLS_KEY="$key"
  OC_SCHEME=https
  return 0
}

# Supervisor first, then its python child, so the loop cannot respawn it.
stop_proxy() {
  local name="$1" pidf pid marker="ocvm-proxy-$1"
  for pidf in "/tmp/ocvm-proxy-$name.sup.pid" "/tmp/ocvm-proxy-$name.run.pid"; do
    [ -f "$pidf" ] || continue
    pid="$(cat "$pidf" 2>/dev/null || true)"
    if _pid_has_marker "$pid" "$marker"; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidf"
  done
  return 0
}

stop_all_proxies() {
  local n
  for n in $OC_PROXY_NAMES; do
    stop_proxy "$n"
  done
  _stop_legacy_redirector
  return 0
}

# Up to 0.5.5 the proxy was a single "redirector" with its own pidfile names and
# its own /proc marker. Attaching to a session that is still running one has to
# stop it here, or it keeps holding $OC_PORT and every new proxy fails to bind.
# Uses the old marker deliberately: with --no-tls that process carries no path
# under the session share, so the newer share-path check would not match it.
# Can be dropped once no 0.5.5 session can still be live.
_stop_legacy_redirector() {
  local pidf pid
  for pidf in /tmp/ocvm-web-redirect.sup.pid /tmp/ocvm-web-redirect.run.pid; do
    [ -f "$pidf" ] || continue
    pid="$(cat "$pidf" 2>/dev/null || true)"
    if [ -n "$pid" ] && grep -qs ocvm-web-redirect "/proc/$pid/cmdline"; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidf"
  done
  return 0
}

# start_proxy <name> <listen-port> <target-port> <seed-key> <cert> <key>
# Idempotent. Silent on failure — the caller owns the message, because what a
# dead listener means differs per service. Returns non-zero if nothing is
# listening after ~4s.
start_proxy() {
  local name="$1" listen="$2" target="$3" seedkey="$4" crt="$5" keyf="$6"
  local waited=0 marker="ocvm-proxy-$1"
  stop_proxy "$name"
  # `bash -c <loop> <marker> ...` rather than a forked subshell, so the marker
  # is the supervisor's own $0 and stop_proxy can identify it without knowing
  # anything about who started it. Detached from the terminal because a
  # background job holding stdout keeps `limactl shell` from ever returning.
  setsid bash -c '
    marker="$0"; name="$1"; py="$2"; listen="$3"; target="$4"
    key="$5"; crt="$6"; keyf="$7"
    while true; do
      python3 "$py" "$listen" "$target" "$key" "$crt" "$keyf" "$marker" \
        >>"/tmp/ocvm-proxy-$name.log" 2>&1 &
      echo $! > "/tmp/ocvm-proxy-$name.run.pid"
      wait $! || true
      sleep 1
    done' "$marker" "$name" "$OC_PROXY_PY" "$listen" "$target" "$seedkey" "$crt" "$keyf" \
    </dev/null >/dev/null 2>&1 &
  echo $! > "/tmp/ocvm-proxy-$name.sup.pid"
  while [ "$waited" -lt 20 ]; do
    if ss -ltn "sport = :$listen" 2>/dev/null | grep -q LISTEN; then
      return 0
    fi
    sleep 0.2
    waited=$(( waited + 1 ))
  done
  stop_proxy "$name"
  return 1
}

# The Basic-auth secret arrives through a 0600 file in the session share, not
# through argv — see write_session_auth() on the host for why. Sets OC_PASSWORD
# and OC_USERNAME for the banner and exports what opencode itself reads.
load_session_auth() {
  OC_PASSWORD=""
  OC_USERNAME=opencode
  if [ -f "$SESS_SHARE/auth.env" ]; then
    . "$SESS_SHARE/auth.env"
    OC_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"
    OC_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
  fi
  if [ -n "$OC_PASSWORD" ]; then
    export OPENCODE_SERVER_USERNAME="$OC_USERNAME"
    export OPENCODE_SERVER_PASSWORD="$OC_PASSWORD"
  else
    unset OPENCODE_SERVER_PASSWORD 2>/dev/null || true
  fi
  return 0
}

# Kill a leftover `opencode web` from an earlier run of this session whose
# connection died without the EXIT trap (closed terminal, SIGHUP, host sleep).
# The orphan still holds the internal port, so a fresh server dies with
# ServeError on every respawn while the browser silently keeps talking to the
# orphan — sessions land in a process nothing manages any more. Scoped tightly
# to this session's internal port; a normal start finds nothing to do.
reap_stale_opencode() {
  local port="$1" pid waited=0
  for pid in $(pgrep -f "opencode web --hostname 127\.0\.0\.1 --port ${port}\$" 2>/dev/null); do
    echo "[web] Reaping orphaned opencode web (pid $pid) from a previous run — it held port ${port}."
    kill "$pid" 2>/dev/null || true
  done
  # Give the listener a moment to vanish so the fresh server can bind.
  while [ "$waited" -lt 20 ]; do
    ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN || return 0
    sleep 0.2
    waited=$(( waited + 1 ))
  done
  return 0
}

# Puts the proxy in front of opencode: it takes over $OC_PORT (the port the SSH
# tunnel forwards to) and opencode moves to $OC_PORT_INTERNAL, so no host-side
# URL, tunnel or firewall rule changes. Fails safe: if the proxy does not come
# up, opencode goes back on $OC_PORT directly and web mode behaves exactly as
# it did before the redirector existed.
start_web_proxies() {
  load_session_auth
  # Before binding anything: a pre-0.5.6 redirector may still own $OC_PORT.
  _stop_legacy_redirector
  if [ ! -f "$SESS_SHARE/lib/proxy.py" ] || ! command -v python3 >/dev/null 2>&1; then
    echo "[web] No redirector available — root URL will show the project launcher."
    return 0
  fi
  ensure_web_tls
  # The block is contiguous and relative to the effective base, so the internal
  # ports move with it. The host reserved P..P+3 before handing P down here.
  OC_PORT_INTERNAL=$(( OC_PORT - 1 ))
  OC_A2A_INTERNAL=$(( OC_PORT - 2 ))
  # Run from /tmp rather than straight off the share: the supervisor re-reads
  # the script on every respawn, and a stalled virtiofs mount would turn one
  # proxy crash into a permanently dead listener.
  if ! cp -f "$SESS_SHARE/lib/proxy.py" "$OC_PROXY_PY"; then
    echo "[web] Could not stage the proxy — root URL will show the project launcher."
    OC_PORT_INTERNAL="$OC_PORT"
    OC_SCHEME=http
    return 0
  fi
  if ! start_proxy web-tls "$OC_PORT" "$OC_PORT_INTERNAL" "$OC_DIR_KEY" "$OC_TLS_CERT" "$OC_TLS_KEY"; then
    echo "[web] Redirector did not bind port $OC_PORT — falling back to opencode on $OC_PORT directly."
    stop_all_proxies
    OC_PORT_INTERNAL="$OC_PORT"
    OC_SCHEME=http
    return 0
  fi

  # The plain-HTTP twins are not a --no-tls thing: they exist so clients that
  # cannot be taught to trust a self-signed certificate (OpenCode Desktop,
  # `opencode attach`, and every A2A client tested so far) still have a way in.
  # The listener set deliberately does not branch on $OC_TLS — when TLS is off
  # OC_TLS_CERT is empty and the "tls" listeners simply run plain, so P+1 is
  # always the plain web port and P+3 always the plain a2a port. Mirroring that
  # rule host-side would be a second source of truth, and ensure_web_tls can
  # degrade at runtime (missing openssl, cert failure) in ways the host cannot
  # predict — which would leave LAN ports tunnelled to nothing.
  start_proxy web-plain "$(( OC_PORT + 1 ))" "$OC_PORT_INTERNAL" "$OC_DIR_KEY" "" "" ||
    echo "[web] WARNING: plain-HTTP web endpoint on $(( OC_PORT + 1 )) did not come up."

  # The a2a listeners come up here too, even though the sidecar behind them is
  # not running yet. A proxy splices per connection, so it does not need its
  # upstream at bind time — and it cannot wait for one: `opencode web` is
  # started after this function returns, the sidecar waits for `opencode web`,
  # so anything gated on sidecar readiness here could never be satisfied.
  # Until the sidecar answers, these ports refuse connections rather than
  # accepting and hanging, which is the honest failure mode.
  if [ "${OC_A2A:-1}" = "1" ]; then
    start_proxy a2a-tls   "$(( OC_PORT + 2 ))" "$OC_A2A_INTERNAL" "" "$OC_TLS_CERT" "$OC_TLS_KEY" ||
      echo "[a2a] WARNING: HTTPS endpoint on $(( OC_PORT + 2 )) did not come up."
    start_proxy a2a-plain "$(( OC_PORT + 3 ))" "$OC_A2A_INTERNAL" "" "" "" ||
      echo "[a2a] WARNING: HTTP endpoint on $(( OC_PORT + 3 )) did not come up."
  fi
  return 0
}

# --- A2A sidecar ----------------------------------------------------------
#
# One OpenCode runtime, two protocol surfaces: the adapter talks to the very
# same `opencode web` over loopback, never back through the TLS proxy, so A2A
# tasks land in the same sessions and the same workspace the browser sees.
#
# The credential registry is never empty — opencode-a2a refuses to start without
# one. With a session password both a basic and a bearer entry carry it; without
# one they carry OC_A2A_DEFAULT_SECRET. Both schemes are registered because
# A2A clients differ: some send Basic, and the orchestrators tested (Hermes)
# only ever send Bearer.
a2a_credentials_json() {
  local secret="$1" user="$2"
  jq -cn --arg u "$user" --arg p "$secret" '[
    {scheme:"basic",  username:$u, password:$p},
    {scheme:"bearer", token:$p,    principal:$u}
  ]'
}

stop_a2a() {
  local pid pidf marker pidf_marker
  # Supervisor first so it cannot respawn the child, then the child. They carry
  # different markers: the supervisor is launched with an explicit $0, while the
  # child is the adapter itself and is recognised by its own binary path. Same
  # marker-based ownership check as the proxies, and for the same reason:
  # pkill -f would match the session shell's own argv.
  for pidf_marker in "/tmp/ocvm-a2a.sup.pid:ocvm-a2a-supervisor" "/tmp/ocvm-a2a.run.pid:opencode-a2a"; do
    pidf="${pidf_marker%%:*}"
    marker="${pidf_marker##*:}"
    [ -f "$pidf" ] || continue
    pid="$(cat "$pidf" 2>/dev/null || true)"
    if _pid_has_marker "$pid" "$marker"; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidf"
  done
  return 0
}

# Backgrounded end to end: waits for the opencode backend, then supervises the
# adapter. Never blocks session startup and never fails it.
start_a2a() {
  A2A_SECRET=""
  if [ "${OC_A2A:-1}" != "1" ]; then
    return 0
  fi
  A2A_BIN="$HOME/.local/share/opencode-a2a-venv/bin/opencode-a2a"
  if [ ! -x "$A2A_BIN" ]; then
    echo "[a2a] opencode-a2a is not installed in this VM — A2A endpoints unavailable."
    echo "[a2a]   Install it with: opencode-vm init   (or re-run: opencode-vm web)"
    return 0
  fi
  if [ "$OC_PORT_INTERNAL" = "$OC_PORT" ]; then
    echo "[a2a] Skipped: the web proxy is not running, so there is no internal port to attach to."
    return 0
  fi

  A2A_SECRET="${OC_PASSWORD:-$OC_A2A_DEFAULT_SECRET}"
  stop_a2a
  mkdir -p /tmp/ocvm-a2a

  # Environment, not argv: a credential on a command line is readable by every
  # process in the VM through /proc.
  export OPENCODE_BASE_URL="http://127.0.0.1:${OC_PORT_INTERNAL}"
  export OPENCODE_WORKSPACE_ROOT="$PROJ_DIR"
  if [ -n "${OC_PASSWORD:-}" ]; then
    export OPENCODE_AUTH_USERNAME="$OC_USERNAME"
    export OPENCODE_AUTH_PASSWORD="$OC_PASSWORD"
  fi
  export A2A_HOST=127.0.0.1
  export A2A_PORT="$OC_A2A_INTERNAL"
  # The card advertises the plain-HTTP endpoint. opencode-a2a bakes exactly one
  # public URL into the card at startup, and A2A clients follow it — advertising
  # the HTTPS port would send every client that cannot verify our self-signed
  # certificate straight into a handshake failure. Both endpoints reach the same
  # process either way.
  export A2A_PUBLIC_URL="http://${OC_HOST_IP}:$(( OC_PORT + 3 ))"

  # Card identity. Clients resolve an agent by its URL, not by this name — but
  # discovery tools print name and description verbatim, and with several
  # opencode-vm sessions registered against one orchestrator, cards that all
  # read "OpenCode A2A" and differ only in their URL are indistinguishable. The
  # project directory name is what the user actually thinks of the agent as.
  #
  # $PROJ_DIR is the host project path, so basename stays correct even for the
  # non-ASCII case where the mount goes through /tmp/oc-mount-<sha12>: the VM
  # carries a symlink at the real path. Do not use `pwd -P` here (that is what
  # OC_DIR_KEY needs) — it would yield the mount hash.
  OC_A2A_PROJECT="$(basename "$PROJ_DIR")"
  export A2A_TITLE="OpenCode: $OC_A2A_PROJECT"
  export A2A_DESCRIPTION="OpenCode coding agent for project '$OC_A2A_PROJECT', running in an opencode-vm session on $OC_HOST_IP."
  export A2A_PROJECT="$OC_A2A_PROJECT"

  local creds
  if ! creds="$(a2a_credentials_json "$A2A_SECRET" "$OC_USERNAME")" || [ -z "$creds" ]; then
    echo "[a2a] Could not build the credential registry (is jq present?) — A2A not started."
    return 0
  fi
  export A2A_STATIC_AUTH_CREDENTIALS="$creds"
  # The project VM is the security boundary; the adapter must not be able to
  # widen it. Directory override defaults to true upstream, so setting it false
  # is the load-bearing line here.
  export A2A_ALLOW_DIRECTORY_OVERRIDE=false
  export A2A_ENABLE_SESSION_SHELL=false
  export A2A_ENABLE_WORKSPACE_MUTATIONS=false
  export A2A_EXPOSE_WORKSPACE_ROOT_IN_CARD=false
  # VM-local, never on the virtiofs share: this is a live SQLite WAL workload,
  # and the upstream default would drop opencode-a2a.db into the project dir.
  export A2A_TASK_STORE_BACKEND=database
  export A2A_TASK_STORE_DATABASE_URL="sqlite+aiosqlite:////tmp/ocvm-a2a/opencode-a2a.db"

  # Same self-identifying supervisor shape as start_proxy. The A2A_* settings
  # above are exported, so the child inherits them without any of them ever
  # appearing on a command line.
  setsid bash -c '
    marker="$0"; bin="$1"; backend="$2"
    waited=0
    while [ "$waited" -lt 120 ]; do
      if ss -ltn "sport = :$backend" 2>/dev/null | grep -q LISTEN; then break; fi
      sleep 0.5
      waited=$(( waited + 1 ))
    done
    while true; do
      aa-exec -p opencode-sandbox -- "$bin" serve >>/tmp/ocvm-a2a.log 2>&1 &
      echo $! > /tmp/ocvm-a2a.run.pid
      wait $! || true
      sleep 2
    done' "ocvm-a2a-supervisor" "$A2A_BIN" "$OC_PORT_INTERNAL" \
    </dev/null >/dev/null 2>&1 &
  echo $! > /tmp/ocvm-a2a.sup.pid
  return 0
}

# Reports readiness once `opencode web` is up and the sidecar has followed it.
# Backgrounded because the caller goes on to run `opencode web` in the
# foreground — this is the only place that can observe the end state.
a2a_watch_ready() {
  [ "${OC_A2A:-1}" = "1" ] || return 0
  [ -x "$A2A_BIN" ] || return 0
  ( if wait_for_a2a; then
      # Same honesty rule as print_web_banner: no LAN URL while the LAN
      # tunnel is down — Lima's loopback forward is what actually answers.
      # Runs in a subshell, so the plain assignment cannot leak.
      host="$OC_HOST_IP"
      [ "${OC_LAN_UP:-1}" = "1" ] || host="127.0.0.1"
      echo ""
      echo "[a2a] Ready — agent card: http://${host}:$(( OC_PORT + 3 ))/.well-known/agent-card.json"
    else
      echo ""
      echo "[a2a] WARNING: the sidecar did not become ready."
      echo "[a2a]   log: /tmp/ocvm-a2a.log (in the VM)   backend: http://127.0.0.1:${OC_PORT_INTERNAL}   a2a: ${OC_A2A_INTERNAL}"
      if [ "${OC_REQUIRE_A2A:-0}" = "1" ]; then
        echo "[a2a]   --require-a2a was given — stopping the session."
        kill -TERM $$ 2>/dev/null || true
      else
        echo "[a2a]   Web mode continues without A2A. Use --require-a2a to make this fatal."
      fi
    fi ) &
  return 0
}

# Polls the sidecar's own card on the VM-internal port. Generous, because it is
# waiting on two startups in sequence: opencode, then the adapter.
wait_for_a2a() {
  local waited=0
  [ "${OC_A2A:-1}" = "1" ] || return 1
  [ -x "$HOME/.local/share/opencode-a2a-venv/bin/opencode-a2a" ] || return 1
  while [ "$waited" -lt 400 ]; do
    if curl -fsS -o /dev/null --max-time 2 \
         "http://127.0.0.1:${OC_A2A_INTERNAL}/.well-known/agent-card.json" 2>/dev/null; then
      return 0
    fi
    sleep 0.3
    waited=$(( waited + 1 ))
  done
  return 1
}

print_web_banner() {
  # An advertised URL is a promise the tunnel has to keep. When the LAN
  # forwards are down, the only working host-side listeners are Lima's
  # loopback auto-forwards — so print those, never LAN URLs that would just
  # be refused.
  local host="$OC_HOST_IP"
  [ "${OC_LAN_UP:-1}" = "1" ] || host="127.0.0.1"
  local plain="http://${host}"
  echo ""
  echo "=============================================="
  echo "  OpenCode Web + A2A (base port $OC_PORT)${OC_BANNER_SUFFIX:-}"
  echo "=============================================="
  echo ""
  if [ "${OC_LAN_UP:-1}" != "1" ]; then
    echo "[!] LAN access is DOWN — the SSH port tunnel could not be set up."
    echo "    The URLs below work on the host machine only; other devices cannot"
    echo "    reach this session. To retry the tunnel: opencode-vm attach"
    echo ""
  fi
  echo "Web UI / REST"
  # The short root URL is the one to hand out: it seeds this browser with the
  # project (without which the UI filters every chat session out of view),
  # sets sane defaults, and forwards into the project.
  echo "  Browser:       ${OC_SCHEME}://${host}:${OC_PORT}"
  echo "  Direct project ${OC_SCHEME}://${host}:${OC_PORT}/${OC_DIR_KEY}"
  echo "  REST / OpenAPI ${OC_SCHEME}://${host}:${OC_PORT}/doc"
  if [ "$OC_SCHEME" = "https" ]; then
    echo "  Plain HTTP:    ${plain}:$(( OC_PORT + 1 ))    (no certificate to trust)"
  fi
  echo ""
  if [ "${OC_A2A:-1}" = "1" ]; then
    echo "A2A  (protocol 1.0)"
    # Empty when the sidecar bailed out before naming itself (not installed, or
    # no internal port to attach to) — then there is no identity to report.
    if [ -n "${OC_A2A_PROJECT:-}" ]; then
      echo "  Agent name:    OpenCode: ${OC_A2A_PROJECT}"
    fi
    if [ "$OC_SCHEME" = "https" ]; then
      echo "  HTTPS:         ${OC_SCHEME}://${host}:$(( OC_PORT + 2 ))"
    fi
    echo "  HTTP:          ${plain}:$(( OC_PORT + 3 ))"
    echo "  Agent Card:    ${plain}:$(( OC_PORT + 3 ))/.well-known/agent-card.json"
  else
    echo "A2A"
    echo "  disabled for this session (--no-a2a)"
  fi
  echo ""
  echo "Internal (VM loopback only, not on the LAN)"
  echo "  opencode:      http://127.0.0.1:${OC_PORT_INTERNAL}"
  if [ "${OC_A2A:-1}" = "1" ]; then
    echo "  opencode-a2a:  http://127.0.0.1:${OC_A2A_INTERNAL}"
  fi
  echo "  TUI attach:    opencode attach http://127.0.0.1:${OC_PORT_INTERNAL}"
  echo ""
  echo "Authentication"
  if [ -n "${OC_PASSWORD:-}" ]; then
    echo "  Web / REST:    HTTP Basic — enabled"
    echo "  Username:      ${OC_USERNAME:-opencode}"
    echo "  Password:      (the one you set; not printed)"
    if [ "${OC_A2A:-1}" = "1" ]; then
      echo "  A2A:           Basic or Bearer, same credentials"
      echo "                 Bearer token = your web password"
    fi
  else
    echo "  Web / REST:    none — anyone on the LAN can use this server"
    if [ "${OC_A2A:-1}" = "1" ]; then
      # Printing it is the point: opencode-a2a cannot run without a credential,
      # so this is a documented constant rather than a secret.
      echo "  A2A:           Basic or Bearer (opencode-a2a always requires one)"
      echo "  Username:      ${OC_USERNAME:-opencode}"
      echo "  Password:      ${A2A_SECRET:-$OC_A2A_DEFAULT_SECRET}   <- default, not a secret"
      echo "  Bearer token:  ${A2A_SECRET:-$OC_A2A_DEFAULT_SECRET}"
    fi
    echo ""
    echo "  Set one with: opencode-vm web --password <pw>   (or \$OCVM_WEB_PASSWORD)"
  fi
  if [ "$OC_SCHEME" = "https" ]; then
    if [ -n "${OC_PASSWORD:-}" ]; then
      echo ""
      echo "  Credentials sent to the plain-HTTP endpoints are NOT protected by TLS."
    fi
  else
    echo ""
    echo "  Plain HTTP everywhere (--no-tls): file/image attachments stay broken"
    echo "       from other devices — browsers withhold crypto.subtle from"
    echo "       insecure origins. Use the 127.0.0.1 URL, or drop --no-tls."
  fi
  echo ""
  return 0
}
WEBLIB

# Materialize the in-VM web library and the proxy into the session share, which
# is mounted into the VM at this same absolute path. Call before every vm_exec
# that runs web mode, so a session created by an older version is healed on its
# next start or attach.
install_web_lib() {
  local share="$1"
  [[ -n "$share" ]] || return 1
  local dir="$share/lib"
  mkdir -p "$dir" || return 1
  printf '%s\n' "$OCVM_WEB_LIB_SH"      > "$dir/web.sh"   || return 1
  printf '%s\n' "$OCVM_WEB_REDIRECT_PY" > "$dir/proxy.py" || return 1
  return 0
}

# Write the web-mode AGENTS notes sidecar (materialized web-UI attachments).
# The VM-side AGENTS.md composition appends it after the MCP snippets, so
# terminal sessions never advertise the web-only daemon.
# $1 = session share dir on host
web_build_agents_sidecar() {
  local sess_share="$1"
  mkdir -p "$sess_share/config/opencode"
  cat > "$sess_share/config/opencode/AGENTS.web.md" <<'WEBMD'

## Web-UI Attachments (uploaded via the "+" button)

When a user uploads a file via the OpenCode web UI's "+" button, the file is
delivered to the model as an inline base64 `data:` URI — it has **no real
filesystem path**, so your tools (Read, Bash, `convert`, `pdftotext`,
`webimg`-pipeline, MCPs, …) cannot operate on it directly.

opencode-vm runs a background daemon (`ocvm-materialize`) in web sessions that
detects such uploads and writes them to disk so your tools get a real path.

**Location:** the directory is exposed as the env var `$OCVM_ATTACHMENTS_DIR`
(a subpath of the session share, with one subfolder per OpenCode session id).
Each session subfolder also contains an `index.json` mapping part-IDs to
filenames + MIME types.

**Convention** — whenever the user's prompt refers to an uploaded file, an
image they "just sent", or you receive a `FilePart` you cannot otherwise act
on, **list the directory first**:

```bash
ls -la "$OCVM_ATTACHMENTS_DIR"/*/ 2>/dev/null
```

Then pass the concrete filesystem path of the newest matching file to your tool
(e.g. `convert "$OCVM_ATTACHMENTS_DIR/<sid>/foo.png" -resize 800x out.png`).

Notes:
- The daemon polls (~0.5 s); allow a beat after the user sends the message
  before the file appears.
- Files are **ephemeral** — the whole directory is deleted at session end.
- This is independent of `~/Desktop/opencode-share/` (that one is for
  *user-curated* material shared from the host).
WEBMD
}

# Spawn the ocvm-materialize daemon inside the session VM so any FilePart
# with a data: URI (web-UI "+" upload) is dumped to disk under
# $sess_share/attachments/<oc-session-id>/. PID is written to a pidfile in
# the session share so cleanup() can stop it on session end.
# Idempotent: a fresh call kills any previous daemon for this session first.
# $1 = lima vm name  $2 = session share dir on host (same absolute path in VM)
start_materialize_daemon() {
  local vm_name="$1" sess_share="$2"
  [[ -n "$vm_name" && -n "$sess_share" ]] || return 1
  # Use `if` rather than `[[ ]] && { ... }` — the latter form returns the
  # test's exit code when the test is false, which under `set -e` aborts
  # the function before the daemon is ever spawned.
  if [[ "${OCVM_MATERIALIZE:-1}" == "0" ]]; then
    echo "[materialize] OCVM_MATERIALIZE=0 — daemon disabled."
    return 0
  fi
  local att_dir="$sess_share/attachments"
  local pidfile="$sess_share/materialize.pid"
  local log="$sess_share/log/materialize.log"
  # Host-side mkdir so the `2>>"$log"` redirect on the limactl call below
  # has a writable target. The in-VM mkdir on the same (virtiofs-shared)
  # path is still done for clarity, but happens too late for the redirect.
  mkdir -p "$att_dir" "$(dirname "$log")"
  stop_materialize_daemon "$vm_name" "$sess_share" >/dev/null 2>&1 || true
  # Spawn pattern: nohup + setsid + closed stdin + a brief grace sleep before
  # the SSH session closes. Python startup (~100ms importing sqlite3 etc.) is
  # too slow for the bare `setsid X &` pattern that graphify (Go binary) uses
  # — the SSH disconnect propagates before the new session is fully detached
  # and the daemon dies silently with an empty log.
  vm_exec "$vm_name" '
    set +e
    att="$1"; log="$2"; pidfile="$3"
    mkdir -p "$att" "$(dirname "$log")"
    : > "$log"
    if [ ! -x "$HOME/.local/bin/ocvm-materialize" ]; then
      echo "[materialize] ocvm-materialize not installed in this VM (re-run opencode-vm init to update base)." >>"$log"
      exit 0
    fi
    export OPENCODE_DATA_DIR=/tmp/oc-xdg-data/opencode
    export OCVM_ATTACHMENTS_DIR="$att"
    export OCVM_MATERIALIZE_LOG="$log"
    nohup setsid "$HOME/.local/bin/ocvm-materialize" </dev/null >>"$log" 2>&1 &
    echo $! > "$pidfile"
    sleep 0.3   # give Python time to import + reach setup_logging
  ' "$att_dir" "$log" "$pidfile" 2>>"$log" || {
    echo "[materialize] WARN: daemon spawn failed; see $log" >&2
    return 1
  }
  if [[ -s "$pidfile" ]]; then
    echo "[materialize] Daemon started (pid $(cat "$pidfile")) — attachments: $att_dir"
  fi
  return 0
}

stop_materialize_daemon() {
  local vm_name="$1" sess_share="$2"
  [[ -n "$vm_name" && -n "$sess_share" ]] || return 0
  local pidfile="$sess_share/materialize.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && is_vm_running "$vm_name"; then
    limactl shell --workdir / "$vm_name" -- bash -c '
      pid="$1"
      [[ -n "$pid" ]] && kill -TERM -"$pid" 2>/dev/null
      [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null
      true
    ' _ "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  return 0
}

# Probe the tunnel from the host — returns 0 if HTTP responds (any status).
# Runs in background after a short delay because opencode may still be
# booting inside the VM when we call it. Used for human-readable diagnostics
# only; tunnel teardown decisions are not made from this.
probe_web_tunnel_async() {
  local host_port="$1" lan_ip="$2" tls="${3:-0}"
  [[ -n "$host_port" ]] || return 0
  (
    sleep 4
    # -k: with --tls the redirector presents a self-signed certificate. The
    # probe only checks that something answers, so cert validation is noise.
    local scheme="http" insecure=""
    if [[ "$tls" == "1" ]]; then scheme="https"; insecure="-k"; fi
    local rc=""
    rc="$(curl -fsS $insecure --max-time 3 -o /dev/null -w '%{http_code}' "${scheme}://127.0.0.1:${host_port}/" 2>/dev/null || echo "000")"
    if [[ "$rc" == "000" ]]; then
      echo "[tunnel] WARNING: probe ${scheme}://127.0.0.1:${host_port}/ did not respond — opencode may still be starting or has crashed in VM."
    fi
  ) &
  return 0
}

enter_session_shell() {
  local vm_name="$1" proj_dir="$2" host_lan_ip="${3:-localhost}" sess_share="${4:-}"
  sanitize_lima_sock_dir
  vm_exec "$vm_name" '
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
      export OCVM_ATTACHMENTS_DIR="$SESS_SHARE/attachments"
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
  ' "$proj_dir" "$host_lan_ip" "$sess_share"
}

_ATTACH_TUNNEL_VM=""
_ATTACH_TUNNEL_BASE=""
_attach_tunnel_cleanup() {
  [[ -n "$_ATTACH_TUNNEL_VM" && -n "$_ATTACH_TUNNEL_BASE" ]] || return 0
  echo ""
  echo "[opencode-vm] Web session ended — closing LAN tunnels..."
  stop_web_tunnels "$_ATTACH_TUNNEL_VM" "$_ATTACH_TUNNEL_BASE"
  echo "[opencode-vm] Tunnels closed. Session paused — resume with: opencode-vm web"
  return 0
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
      # Same resize-on-resume as 'start': attaching to a kept VM must not be a
      # back door that silently keeps the old RAM size.
      vmcfg_load "$proj"
      vmcfg_print_override_notice "[attach]"
      _apply_vm_sizing_to_stopped "$SESS_NAME" "[attach]"
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

  # Re-run model enrichment on the share config so sessions created before this
  # feature (or before a table bump) gain limits/modalities/reasoning on resume.
  # Fill-only and idempotent — a no-op for already-enriched configs.
  local _att_cfg
  _att_cfg="$(session_share_dir "$proj")/config/opencode/opencode.json"
  [[ -f "$_att_cfg" ]] && apply_model_enrichment "$_att_cfg"

  # OAuth pre-flight before reconnect: adopt the freshest token (from any other
  # running VM or saved session) into the host auth.json, then push it into this
  # resumed VM — its own /tmp copy may hold a refresh token that another VM has
  # since rotated, which would 401. The fresh-mtime write survives the later
  # in-VM 'rsync --update' merge from the share. Opt out with
  # OCVM_AUTH_AUTORESYNC=0; non-fatal.
  if [[ "${OCVM_AUTH_AUTORESYNC:-1}" != "0" ]] && command -v jq >/dev/null 2>&1 \
     && [[ -n "$(auth_oauth_provider_ids "$HOST_DATA_DIR/auth.json")" ]]; then
    echo "[attach] OAuth pre-flight: adopting freshest provider token..."
    auth_collect_freshest_oauth apply 2>&1 | sed 's/^/[attach]   /' || true
    if [[ -f "$HOST_DATA_DIR/auth.json" ]]; then
      # Write as the normal VM user (NOT sudo): opencode runs unprivileged and
      # must be able to read this auth.json AND create log/ + repos/ siblings
      # under /tmp/oc-xdg-data/opencode. A root-owned tree here makes opencode
      # web crash-loop with EACCES on mkdir. The leading chown heals any
      # root-owned remnant left by older versions (which did push via sudo).
      if vm_exec "$SESS_NAME" '
        set -e
        d=/tmp/oc-xdg-data/opencode
        if [ -e "$d" ] && [ ! -O "$d" ]; then
          sudo chown -R "$(id -u):$(id -g)" /tmp/oc-xdg-data 2>/dev/null || true
        fi
        mkdir -p "$d"
        cat > "$d/auth.json"
        chmod 600 "$d/auth.json"
      ' < "$HOST_DATA_DIR/auth.json" 2>/dev/null; then
        echo "[attach]   pushed freshest auth.json into running VM $(_ts)"
      fi
    fi
  fi

  local sess_mode="${SESS_MODE:-tui}"
  local sess_port="${SESS_PORT:-$DEFAULT_OC_PORT}"
  # TLS is a property of the session, not of the attach invocation, so a bare
  # `opencode-vm attach` resumes HTTPS without the user repeating --tls. An
  # explicit `opencode-vm web [--tls]` wins and is written back, otherwise a
  # later bare attach would silently revert to the stale setting.
  local sess_tls="${SESSION_TLS:-${SESS_TLS:-0}}"
  if [[ "$sess_tls" != "${SESS_TLS:-0}" ]]; then
    local _tls_senv
    _tls_senv="$(session_env "$proj")"
    if [[ -f "$_tls_senv" ]]; then
      write_senv "$_tls_senv" "$SESS_NAME" "${SESS_PROJ:-$proj}" "${CFG_HASH_AT_START:-}" \
        "${SESS_MODE:-tui}" "${SESS_PORT:-$DEFAULT_OC_PORT}" "${SESS_KEEP_HISTORY:-0}" "$sess_tls"
      SESS_TLS="$sess_tls"
    fi
  fi
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

  # Self-heal graphify venv before OpenCode tries to launch its MCP server.
  # No-op when graphify isn't installed; injects mcp extras when missing.
  graphify_ensure_mcp_in_vm "$SESS_NAME"
  if [[ "$sess_mode" == "web" ]]; then
    a2a_ensure_installed_in_vm "$SESS_NAME"
  fi

  # Web mode: open the four LAN forwards for this session's port block and tear
  # them down when this attach ends. Tunnel failure is non-fatal: the session
  # still runs, and opencode stays reachable via Lima's loopback auto-forward.
  # See start_web_tunnels for the block rationale.
  local effective_base="$sess_port"
  local lan_up=1
  if [[ "$sess_mode" == "web" ]]; then
    if start_web_tunnels "$SESS_NAME" "$sess_port"; then
      effective_base="$WEB_PORT_BASE"
      # A named function, not an interpolated trap body: the old form spliced
      # $SESS_NAME straight into the trap string, which breaks on anything the
      # shell would re-parse. The operands are globals because an EXIT trap
      # fires after attach_session's locals have gone out of scope.
      _ATTACH_TUNNEL_VM="$SESS_NAME"
      _ATTACH_TUNNEL_BASE="$effective_base"
      trap _attach_tunnel_cleanup EXIT HUP TERM
      probe_web_tunnel_async "$effective_base" "$host_lan_ip" "$sess_tls"
    else
      lan_up=0
      echo "[attach] WARNING: SSH tunnel for LAN access could not be set up." >&2
      echo "[attach]   Session continues. Loopback-only fallback may be available via http://127.0.0.1:${sess_port}/ (Lima auto-forward)." >&2
      echo "[attach]   To enable LAN access: stop+restart the VM, then 'opencode-vm attach'." >&2
    fi
    # (Re-)start materialize daemon on reattach; idempotent if already running.
    local _att_sess_share
    _att_sess_share="$(session_share_dir "$proj")"
    start_materialize_daemon "$SESS_NAME" "$_att_sess_share" || true
  fi

  # Refresh the in-VM web library on every attach, so a session created by an
  # older opencode-vm picks it up without being destroyed and recreated.
  install_web_lib "$(session_share_dir "$proj")" ||
    echo "[attach] WARNING: could not write the web library into the session share." >&2
  resolve_session_auth "$(session_share_dir "$proj")"

  vm_exec "$SESS_NAME" '
    set -euo pipefail
    PROJ_DIR="$1"
    SESS_SHARE="$2"
    OC_MODE="$3"
    OC_PORT="$4"
    OC_HOST_IP="$5"
    OC_WEB_TUI="$6"
    OC_TLS="${7:-0}"
    OC_A2A="${8:-1}"
    OC_REQUIRE_A2A="${9:-0}"
    OC_A2A_DEFAULT_SECRET="${10:-opencode-vm}"
    OC_LAN_UP="${11:-1}"

    # Shared in-VM web library (materialized into the session share by
    # install_web_lib on the host, and mounted here at the same path). It owns
    # the TLS material, the proxy in front of opencode and the connect banner —
    # all of which start_session needs identically. Fails safe: without it,
    # opencode serves $OC_PORT directly, exactly as it did before the
    # redirector existed.
    OC_BANNER_SUFFIX=" — resumed"
    OC_BANNER_VERBOSE=0
    OC_PORT_INTERNAL="$OC_PORT"
    OC_SCHEME=http
    if [ -f "$SESS_SHARE/lib/web.sh" ]; then
      . "$SESS_SHARE/lib/web.sh"
    else
      echo "[attach] web library missing from the session share — running without the redirector."
      echo "[web] WARNING: without it the session also has no application password."
      start_web_proxies() { return 0; }
      stop_all_proxies()  { return 0; }
      start_a2a()         { return 0; }
      stop_a2a()          { return 0; }
      wait_for_a2a()      { return 1; }
      a2a_watch_ready()   { return 0; }
      reap_stale_opencode() { return 0; }
      print_web_banner()  { local h="$OC_HOST_IP"; [ "${OC_LAN_UP:-1}" = "1" ] || h="127.0.0.1"; echo "  Browser/Web UI:  http://${h}:${OC_PORT}"; return 0; }
    fi

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
    export OCVM_ATTACHMENTS_DIR="$SESS_SHARE/attachments"
    # ECC project identity: stable hash across sessions uses host project path
    if [ -f "$SESS_SHARE/config/opencode/.ecc-applied" ]; then
      export CLAUDE_PROJECT_DIR="$PROJ_DIR"
    fi

    cd "$PROJ_DIR"

    # Project key for the web UI route /<base64url(dir)>. Encodes the *physical*
    # cwd: that is what opencode process.cwd() reports and what the /:dir route
    # is matched against. Matters for the clean-symlink case, where a non-ASCII
    # project path resolves to /tmp/oc-mount-<sha12>.
    OC_DIR_KEY="$(printf %s "$(pwd -P)" | base64 -w0 | sed "s/+/-/g; s|/|_|g; s/=//g")"

    # Merge persisted session history from the host share into VM /tmp so
    # sessions started in a different mode (e.g. TUI) show up after resume.
    # rsync --update preserves any newer in-VM data (live session that has
    # not yet been synced back), while filling in anything missing from the
    # share — which covers both /tmp-cleared-on-boot and stale-/tmp cases.
    mkdir -p /tmp/oc-xdg-data/opencode /tmp/oc-xdg-state/opencode
    if [ -d "$SESS_SHARE/xdg-data/opencode" ]; then
      echo "[attach] Merging session history from share..."
      rsync -a --update --exclude="bin/" --exclude="log/" --exclude="tool-output/" \
        "$SESS_SHARE/xdg-data/opencode/" /tmp/oc-xdg-data/opencode/ 2>/dev/null || true
      rsync -a --update "$SESS_SHARE/xdg-state/opencode/" /tmp/oc-xdg-state/opencode/ 2>/dev/null || true
    fi

    # EXIT trap: always sync VM-local data back to the share, even when the
    # session ends via Ctrl+C. Without this, the rsync below the OC_MODE
    # branch never runs because bash terminates as soon as `opencode web`
    # exits on SIGINT (rc=130) — `set -e` propagates the signal exit.
    sync_vm_to_share() {
      # After a hangup the pty is gone and every echo fails — under the
      # scripts set -e that aborted this trap before the rsync, silently
      # losing the history sync. Nothing below may die on a write error.
      set +e
      echo ""
      stop_all_proxies
      stop_a2a
      echo "[attach] Stopping session — syncing data back to host..."
      # The rsync excludes log/, which made server-side failures undebuggable
      # from the host — keep the tail of the opencode log in the share.
      mkdir -p "$SESS_SHARE/log" 2>/dev/null || true
      tail -n 400 /tmp/oc-xdg-data/opencode/log/opencode.log > "$SESS_SHARE/log/opencode-last.log" 2>/dev/null || true
      rsync -a --exclude="bin/" --exclude="log/" --exclude="tool-output/" \
        /tmp/oc-xdg-data/opencode/ "$SESS_SHARE/xdg-data/opencode/" 2>/dev/null || true
      rsync -a /tmp/oc-xdg-state/opencode/ "$SESS_SHARE/xdg-state/opencode/" 2>/dev/null || true
      echo "[attach] Sync complete."
      return 0
    }
    trap sync_vm_to_share EXIT

    # INT/TERM handler so bash itself survives the signal long enough to
    # break out of the restart loop cleanly. An empty `trap "" INT` would
    # inherit as "ignore" to opencode web on execve and kill its ability to
    # respond to Ctrl+C; an active handler does not.
    shutdown_requested=0
    OC_WEB_PID=""
    on_signal() { shutdown_requested=1; [ -n "$OC_WEB_PID" ] && kill "$OC_WEB_PID" 2>/dev/null; return 0; }
    trap on_signal INT TERM HUP

    # Same guard as in start_session: config-dir deps (ECC custom tools)
    # must be installed before opencode boots, or its resolver caches the
    # empty node_modules and every prompt fails until the next restart.
    OC_CFG_DIR="$XDG_CONFIG_HOME/opencode"
    if [ -f "$OC_CFG_DIR/package.json" ] && command -v npm >/dev/null 2>&1; then
      if [ ! -f "$OC_CFG_DIR/node_modules/.package-lock.json" ] ||
         [ "$OC_CFG_DIR/package.json" -nt "$OC_CFG_DIR/node_modules/.package-lock.json" ]; then
        echo "[attach] Installing opencode config dependencies (custom tools/plugins)..."
        ( cd "$OC_CFG_DIR" && npm install --no-audit --no-fund --loglevel=error ) ||
          echo "[attach] WARNING: config dependency install failed — custom tools may not load."
        echo "[attach] Config dependencies ready."
      fi
    fi

    if [ "$OC_MODE" = "web" ]; then
      start_web_proxies
      start_a2a
      print_web_banner
      a2a_watch_ready
      reap_stale_opencode "$OC_PORT_INTERNAL"
      if [ "$OC_WEB_TUI" = "true" ]; then
        aa-exec -p opencode-sandbox -- opencode web --hostname 127.0.0.1 --port "$OC_PORT_INTERNAL" &
        OC_WEB_PID=$!
        sleep 2
        echo ""
        echo "Press Enter to start TUI (web server continues running)..."
        read -r
        aa-exec -p opencode-sandbox -- opencode attach "http://localhost:$OC_PORT_INTERNAL" || true
        kill "$OC_WEB_PID" 2>/dev/null || true
        wait "$OC_WEB_PID" 2>/dev/null || true
      else
        echo "Press Ctrl+C to stop the session."
        # Restart loop: if opencode web crashes (non-clean exit), bring it
        # back up. The SSH tunnel from the host keeps forwarding to
        # 127.0.0.1:$OC_PORT and stays valid across restarts. Clean exits
        # (0 / SIGINT 130 / SIGTERM 143) and signal-driven shutdown end the
        # loop and trigger the EXIT-trap sync.
        # Background job + `wait` for the same reason as in start_session:
        # only a trapped signal (INT/TERM/HUP) can interrupt `wait`, kill the
        # server and reach the EXIT-trap sync — a hangup on a foreground
        # child would skip the trap, lose the history sync and orphan the
        # server on its port.
        serve_fails=0
        while [ "$shutdown_requested" = "0" ]; do
          set +e
          aa-exec -p opencode-sandbox -- opencode web --hostname 127.0.0.1 --port "$OC_PORT_INTERNAL" &
          OC_WEB_PID=$!
          wait "$OC_WEB_PID"
          rc=$?
          set -e
          OC_WEB_PID=""
          [ "$shutdown_requested" = "1" ] && break
          case "$rc" in
            0|130|143) break ;;
          esac
          serve_fails=$(( serve_fails + 1 ))
          if [ "$serve_fails" -ge 5 ]; then
            echo ""
            echo "[attach] opencode web keeps dying (rc=$rc, ${serve_fails}x) — giving up."
            echo "[attach]   A ServeError here means port $OC_PORT_INTERNAL is held by another process."
            break
          fi
          echo ""
          echo "[attach] opencode web exited unexpectedly (rc=$rc) — restarting in 2s. Press Ctrl+C to abort."
          sleep 2 || break
        done
      fi
    else
      aa-exec -p opencode-sandbox -- opencode || true
    fi

    # Sync-back happens via the EXIT trap installed above (covers Ctrl+C as
    # well as normal exit).
  ' "$proj" "$(session_share_dir "$proj")" "$sess_mode" "$effective_base" "$host_lan_ip" "${OC_WEB_TUI:-false}" "$sess_tls" "${SESSION_A2A:-${OCVM_A2A:-1}}" "${SESSION_REQUIRE_A2A:-0}" "$OCVM_A2A_DEFAULT_SECRET" "$lan_up"
}

# --- Session Basic-auth secret -------------------------------------------
#
# The secret lives in $SESS_SHARE/auth.env at 0600, deliberately NOT in
# session.env (which doctor prints and cleanup copies around) and never as a
# positional to vm_exec — `limactl shell` puts positionals in the host process
# list, where the password stayed visible for the whole session.
#
# The session share is the right home rather than a sibling file: it is mounted
# into the VM at this same absolute path, so no transport is needed at all, and
# both `--fresh` (_destroy_prev_session) and session destroy already `rm -rf`
# it — so the secret cannot outlive the session it belongs to.
write_session_auth() {
  local share="$1" pw="$2" user="${3:-opencode}"
  [[ -n "$share" ]] || return 1
  local f="$share/auth.env"
  if [[ -z "$pw" ]]; then
    rm -f "$f"
    return 0
  fi
  mkdir -p "$share" || return 1
  ( umask 077
    printf 'OPENCODE_SERVER_USERNAME=%q\nOPENCODE_SERVER_PASSWORD=%q\n' "$user" "$pw" > "$f"
  ) || return 1
  chmod 600 "$f" 2>/dev/null || true
  return 0
}

read_session_auth() {
  local f="$1/auth.env"
  [[ -f "$f" ]] || return 0
  # Subshell: the sourced assignments must not leak into the caller, which
  # would otherwise re-export a stale password into unrelated child processes.
  ( set +u
    OPENCODE_SERVER_PASSWORD=""
    # shellcheck disable=SC1090
    . "$f" 2>/dev/null || true
    printf '%s' "$OPENCODE_SERVER_PASSWORD" )
}

# Precedence: explicit --password / --no-auth on this invocation, then the host
# environment (handled in parse_web_flags), then whatever the session already
# had. The last step is what makes a bare `opencode-vm attach` keep a protected
# session protected — before this, attach silently resumed it wide open.
resolve_session_auth() {
  local share="$1"
  case "${SESSION_AUTH_MODE:-}" in
    set)
      write_session_auth "$share" "$SESSION_PASSWORD" ||
        echo "[run] WARNING: could not persist the session password." >&2
      ;;
    clear)
      write_session_auth "$share" ""
      SESSION_PASSWORD=""
      ;;
    *)
      SESSION_PASSWORD="$(read_session_auth "$share")"
      ;;
  esac
  return 0
}

# Serialize session tracking state to $senv (loaded back via `source`).
# printf '%q' safely escapes paths with spaces/special chars.
write_senv() {
  local senv="$1" name="$2" proj="$3" cfg_hash="$4" mode="$5" port="$6" keep="$7" tls="${8:-0}"
  printf 'SESS_NAME=%q\nSESS_PROJ=%q\nCFG_HASH_AT_START=%q\nSESS_MODE=%q\nSESS_PORT=%q\nSESS_KEEP_HISTORY=%q\nSESS_TLS=%q\n' \
    "$name" "$proj" "$cfg_hash" "$mode" "$port" "$keep" "$tls" > "$senv"
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
    write_senv "$senv" "$SESS_NAME" "$SESS_PROJ" "${CFG_HASH_AT_START:-}" "$new_mode" "$new_port" "${SESS_KEEP_HISTORY:-0}" "${SESS_TLS:-0}"
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

# Static enrichment table for frontier models, keyed by model id. OpenCode pulls
# this metadata from models.dev for known providers, but custom/gateway providers
# that surface models dynamically (LiteLLM-style proxies, ai-gateway) get NONE of
# it: context falls back to 0 (silently disables auto-compaction, breaks the usage
# gauge, caps output at ~32k), media uploads are blocked, and reasoning is never
# requested. apply_model_enrichment() backfills the missing pieces from this table.
# Per-entry fields:
#   context / output : OpenCode limit.context / limit.output (tokens)
#   vision           : accepts image input  -> attachment + modalities.input image
#   pdf              : accepts pdf input     -> appends "pdf" to modalities.input
#   reasoning        : supports thinking/reasoning -> options.reasoningEffort
#                      (openai-compatible providers) or options.thinking (native)
# Edit here to add/adjust models.
_model_enrichment_table() {
  cat <<'EOF'
{
  "claude-opus-4-8":   { "name": "claude-opus-4-8",   "context": 200000,  "output": 64000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-opus-4-7":   { "name": "claude-opus-4-7",   "context": 200000,  "output": 32000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-opus-4-6":   { "name": "claude-opus-4-6",   "context": 200000,  "output": 32000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-fable-5":    { "name": "claude-fable-5",    "context": 200000,  "output": 64000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-sonnet-4-8": { "name": "claude-sonnet-4-8", "context": 200000,  "output": 64000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-sonnet-4-6": { "name": "claude-sonnet-4-6", "context": 1000000, "output": 64000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-sonnet-4-5": { "name": "claude-sonnet-4-5", "context": 1000000, "output": 64000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-sonnet-3-7": { "name": "claude-sonnet-3-7", "context": 200000,  "output": 128000, "vision": true,  "pdf": true,  "reasoning": true },
  "claude-sonnet-3-5": { "name": "claude-sonnet-3-5", "context": 200000,  "output": 8192,   "vision": true,  "pdf": true,  "reasoning": false },
  "claude-haiku-4-8":  { "name": "claude-haiku-4-8",  "context": 200000,  "output": 64000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-haiku-4-5":  { "name": "claude-haiku-4-5",  "context": 200000,  "output": 64000,  "vision": true,  "pdf": true,  "reasoning": true },
  "claude-haiku-3-5":  { "name": "claude-haiku-3-5",  "context": 200000,  "output": 8192,   "vision": true,  "pdf": true,  "reasoning": false },
  "claude-3-opus":     { "name": "claude-3-opus",     "context": 200000,  "output": 4096,   "vision": true,  "pdf": true,  "reasoning": false },
  "claude-3-sonnet":   { "name": "claude-3-sonnet",   "context": 200000,  "output": 4096,   "vision": true,  "pdf": true,  "reasoning": false },
  "claude-3-haiku":    { "name": "claude-3-haiku",    "context": 200000,  "output": 4096,   "vision": true,  "pdf": true,  "reasoning": false },
  "gpt-5.5":           { "name": "gpt-5.5",           "context": 1048576, "output": 128000, "vision": true,  "pdf": false, "reasoning": true },
  "gpt-5.4":           { "name": "gpt-5.4",           "context": 1050000, "output": 128000, "vision": true,  "pdf": false, "reasoning": true },
  "gpt-5.4-mini":      { "name": "gpt-5.4-mini",      "context": 400000,  "output": 128000, "vision": true,  "pdf": false, "reasoning": true },
  "gpt-5":             { "name": "gpt-5",             "context": 272000,  "output": 32768,  "vision": true,  "pdf": false, "reasoning": true },
  "gpt-5-mini":        { "name": "gpt-5-mini",        "context": 128000,  "output": 16384,  "vision": true,  "pdf": false, "reasoning": true },
  "o4":                { "name": "o4",                "context": 200000,  "output": 100000, "vision": true,  "pdf": false, "reasoning": true },
  "gemini-2.5-pro":    { "name": "gemini-2.5-pro",    "context": 2000000, "output": 65536,  "vision": true,  "pdf": true,  "reasoning": true },
  "gemini-2.5-flash":  { "name": "gemini-2.5-flash",  "context": 1000000, "output": 65536,  "vision": true,  "pdf": true,  "reasoning": true }
}
EOF
}

# Enrich the same-id models that custom/gateway providers surface dynamically with
# the metadata from _model_enrichment_table. Three additive passes, each FILL-ONLY
# (never overwrites a field the user already set):
#   1. limit       — backfills limit.{context,output} when no .limit present.
#   2. modalities  — for vision entries with no .modalities: sets attachment:true
#                    + modalities.input ["text","image"(,"pdf")], output ["text"].
#   3. reasoning   — for reasoning entries with no reasoning option already set:
#                    openai-compatible providers get options.reasoningEffort (the
#                    knob a proxy understands, covering gpt AND proxied claude),
#                    native providers get options.thinking{type,budgetTokens}.
# Only touches providers that already exist in the config. Operates on the session
# config file in place. Non-fatal; needs jq.
#   OCVM_MODEL_ENRICH=0                  -> disable entirely
#   OCVM_MODEL_ENRICH_PROVIDERS="a,b"    -> explicit target provider ids; default
#                                          is every @ai-sdk/openai-compatible
#                                          provider plus "ai-gateway".
#   OCVM_REASONING_EFFORT=medium         -> reasoningEffort for openai-compatible
#   OCVM_REASONING_BUDGET=8192           -> thinking.budgetTokens for native
apply_model_enrichment() {
  local cfg_file="$1"
  [[ "${OCVM_MODEL_ENRICH:-1}" == "0" ]] && return 0
  command -v jq >/dev/null 2>&1 || return 0
  [[ -f "$cfg_file" ]] || return 0

  # Explicit override. Empty => auto-select.
  local providers="${OCVM_MODEL_ENRICH_PROVIDERS:-}"
  local effort="${OCVM_REASONING_EFFORT:-medium}"
  local budget="${OCVM_REASONING_BUDGET:-8192}"
  local tbl; tbl="$(_model_enrichment_table)"

  if ! jq_inplace "$cfg_file" \
      --argjson tbl "$tbl" \
      --arg providers "$providers" \
      --arg effort "$effort" \
      --argjson budget "$budget" '
        # Target provider ids: explicit list if given, else every
        # openai-compatible provider plus a literal "ai-gateway".
        ( ($providers | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) ) as $explicit
        | ( if ($explicit | length) > 0 then $explicit
            else ((.provider // {}) | to_entries
                  | map(select(.value.npm == "@ai-sdk/openai-compatible") | .key) + ["ai-gateway"]
                  | unique)
          end ) as $plist
        | reduce $plist[] as $p (.;
            if (.provider[$p]?) then
              ((.provider[$p].npm // "") == "@ai-sdk/openai-compatible") as $oai
              | .provider[$p].models = (
                  (.provider[$p].models // {}) as $models
                  | reduce ($tbl | to_entries[]) as $e ($models;
                      .[$e.key] as $m
                      | if ($m == null) then .
                        else
                          # 1. limit (fill-only)
                          ( if ($m.limit) then $m
                            else $m * { name: ($m.name // $e.value.name),
                                        limit: { context: $e.value.context, output: $e.value.output } }
                            end ) as $m1
                          # 2. modalities (fill-only, vision entries)
                          | ( if (($e.value.vision == true) and ($m1.modalities | not))
                              then $m1 + { attachment: true,
                                           modalities: { input: (["text","image"] + (if $e.value.pdf == true then ["pdf"] else [] end)),
                                                         output: ["text"] } }
                              else $m1
                              end ) as $m2
                          # 3. reasoning (fill-only). Two distinct things:
                          #    a) top-level "reasoning": true  -> the models.dev
                          #       capability flag OpenCode reads to mark a model as
                          #       a reasoning model (the model-picker badge). Without
                          #       this, reasoningEffort alone leaves the UI showing
                          #       "no reasoning" (analogue of attachment for vision).
                          #    b) the runtime knob: reasoningEffort (openai-compatible)
                          #       or thinking{...} (native).
                          | ( if ($e.value.reasoning == true)
                              then ( $m2
                                     | ( if (.reasoning == null) then .reasoning = true else . end )
                                     | ( if ((.options.reasoningEffort // .options.thinking) | not)
                                         then ( if $oai
                                                then . * { options: { reasoningEffort: $effort } }
                                                else . * { options: { thinking: { type: "enabled", budgetTokens: $budget } } }
                                                end )
                                         else . end ) )
                              else $m2
                              end ) as $m3
                          | .[$e.key] = $m3
                        end))
            else . end)
      '; then
    echo "[run] WARN: model enrichment pass failed; leaving config unchanged." >&2
  fi
}

start_session() {
  need limactl
  need rsync
  sanitize_lima_sock_dir
  printf "\r[run] Starting OpenCode VM session... |"
  ensure_dirs
  ensure_host_opencode_dirs
  printf "\r[run] Starting OpenCode VM session... /"
  backup_host_cfg
  ensure_policy_file
  printf "\r[run] Starting OpenCode VM session... done $(_ts)\n"

  proj="$(pwd)"

  # Per-project RAM override (empty = inherit the base VM's size). Loaded before
  # the reconnect branch so a resumed VM can be resized too, not just a fresh clone.
  vmcfg_load "$proj"
  vmcfg_print_override_notice "[run]"

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
          _apply_vm_sizing_to_stopped "$SESS_NAME"
          if ! run_with_spinner "[start] Resuming session VM..." limactl start "$SESS_NAME" --tty=false; then
            echo "[start] Failed to resume VM '$SESS_NAME'. Use 'opencode-vm start --fresh' to recreate." >&2
            exit 1
          fi
        else
          _warn_vm_sizing_mismatch "$SESS_NAME"
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
    # model.json (recent/favorite models) is a UI preference, not history:
    # wiping it makes every fresh session fall back to a provider-default
    # model instead of the one last used in this project.
    local _model_keep=""
    if [[ -f "$proj_state/xdg-state/opencode/model.json" ]]; then
      _model_keep="$(mktemp)"
      cp -p "$proj_state/xdg-state/opencode/model.json" "$_model_keep"
    fi
    rm -rf "$proj_state/xdg-data/opencode" "$proj_state/xdg-state/opencode"
    mkdir -p "$proj_state/xdg-data/opencode" "$proj_state/xdg-state/opencode"
    if [[ -n "$_model_keep" ]]; then
      cp -p "$_model_keep" "$proj_state/xdg-state/opencode/model.json"
      rm -f "$_model_keep"
    fi
    echo "[run] Fresh session (no history loaded) $(_ts)"
  fi

  # OAuth pre-flight: subscription logins (e.g. OpenAI) use a single-use rotating
  # refresh token, so two VMs seeded from the same auth.json fight over one chain
  # and the loser hits "401 token refresh failed". BEFORE seeding this VM, adopt
  # the freshest live token — from any running session VM or saved session — into
  # the host auth.json, so the new VM starts with a working token instead of a
  # stale snapshot. Runs only when the host has OAuth providers; non-fatal.
  # Opt out with OCVM_AUTH_AUTORESYNC=0.
  if [[ "${OCVM_AUTH_AUTORESYNC:-1}" != "0" ]] && command -v jq >/dev/null 2>&1 \
     && [[ -n "$(auth_oauth_provider_ids "$HOST_DATA_DIR/auth.json")" ]]; then
    echo "[run] OAuth pre-flight: adopting freshest provider token before start... $(_ts)"
    auth_collect_freshest_oauth apply 2>&1 | sed 's/^/[run]   /' || true
  fi

  # Carry (the now-freshened) host auth.json into the project state so provider
  # credentials work.
  if [[ -f "$HOST_DATA_DIR/auth.json" ]]; then
    cp -p "$HOST_DATA_DIR/auth.json" "$proj_state/xdg-data/opencode/auth.json"
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

  # mcrepo (multi-context repo) auto-activation: if mcrepo.yaml is at the project
  # root, this session uses graphify (cross-repo knowledge graph) instead of
  # repomapper (single-repo PageRank). Override is session-only — the user's
  # persisted ~/.opencode-vm/mcps.env is not mutated, so single-repo workspaces
  # the user opens later get their normal selection back.
  if is_mcrepo_workspace "$proj"; then
    export MCPS_FORCE_ON="graphify"
    export MCPS_FORCE_OFF="repomapper"
    local _gfy_dir; _gfy_dir="$(mcrepo_ensure_graphify_dir "$proj")"
    # First-activation README so a human opening the docs folder knows what
    # the files are. Don't overwrite if the user has already edited it.
    if [[ ! -f "$_gfy_dir/README.md" && -f "$SCRIPT_DIR/mcps/graphify/README.template.md" ]]; then
      cp -p "$SCRIPT_DIR/mcps/graphify/README.template.md" "$_gfy_dir/README.md"
    fi
    echo "[run] mcrepo detected — graphify auto-on, repomapper auto-off (session only); graph dir: $_gfy_dir $(_ts)"
  fi

  # Inject session overrides: MCP block built from mcps/registry.json + active
  # MCPS_PACKAGES, plus allow-all permissions with git commit=ask and git push=deny.
  local sess_cfg_file="$sess_share/config/opencode/opencode.json"
  local vm_home
  vm_home="$(vm_resolve_home "$BASE_NAME")"
  if command -v jq >/dev/null 2>&1 && [[ -f "$sess_cfg_file" ]]; then
    local mcp_obj
    mcp_obj="$(mcps_build_config_json "$vm_home" "$sess_share" "$proj")"
    [[ -n "$mcp_obj" ]] || mcp_obj='{}'

    # The mcp block is wholly owned by the MCPs subsystem. Any stale mcp
    # entries in the persisted config (e.g. from manual edits) are
    # overwritten — we never want to leak a disabled MCP like repomapper
    # into the session just because it was written there on a previous run.
    jq_inplace "$sess_cfg_file" --argjson mcp "$mcp_obj" '
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
    ' || true

    # Enrich custom/gateway-served frontier models that surface without metadata:
    # backfills context/output limits (OpenCode would otherwise default context=0,
    # disabling auto-compaction), media modalities (image/pdf input), and reasoning
    # options. Fill-only — never overwrites explicit user fields. Mutates in place.
    apply_model_enrichment "$sess_cfg_file"

    cp -p "$sess_cfg_file" "$sess_share/config/opencode/.opencode.json"
  fi

  # Mount companion skill docs declared by active MCPs (e.g. proxmox SKILL.md)
  mcps_mount_skill_docs_for_session "$sess_share" 2>/dev/null || true

  # Build the AGENTS.mcps.md sidecar from active MCPs' agents_md_snippet
  # declarations. The VM-side AGENTS.md composition appends this after the
  # Host LAN IP block.
  mcps_build_agents_sidecar "$sess_share" "$vm_home" "$proj" 2>/dev/null || true

  # Web-mode AGENTS notes (materialized attachments daemon). Removed for
  # terminal sessions so a stale copy can't leak from a previous web session.
  if [[ "$SESSION_MODE" == "web" ]]; then
    web_build_agents_sidecar "$sess_share"
  else
    rm -f "$sess_share/config/opencode/AGENTS.web.md"
  fi

  # ECC (opt-in): copy plugin payload + optional MCP pack into session config,
  # seed homunculus learning store from persistent project state.
  if ecc_enabled; then
    ecc_apply_to_session "$sess_share"
    ecc_apply_mcp_pack "$sess_cfg_file"
    ecc_seed_homunculus "$proj_state" "$sess_share"
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

  # Install SearXNG (account-free metasearch) into base VM (idempotent, only
  # when searxng MCP is active). Must also run BEFORE stop-for-clone so the
  # service is fully provisioned in the base disk inherited by session VMs.
  searxng_ensure_installed_in_base || echo "[run] SearXNG install skipped; session will start without web-search MCP." >&2

  # Install the A2A adapter into the base VM so every session clone inherits it
  # (idempotent, web mode only). Same BEFORE-stop-for-clone placement as above.
  if [[ "$SESSION_MODE" == "web" ]]; then
    a2a_ensure_installed_in_base || echo "[run] A2A install skipped; session will start without A2A." >&2
  fi

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

  # Build the clone args incrementally: the optional Desktop share and the
  # per-project RAM/CPU overrides are independent, and spelling out every
  # combination as its own limactl line does not scale.
  local -a clone_args
  clone_args=( --mount-only "${mount_proj}:w" --mount-only "${sess_share}:w" )
  if [[ -n "$share_mount" ]]; then
    clone_args+=( --mount-only "${share_dir}:w" )
  fi
  if [[ -n "${VM_MEMORY_GIB:-}" ]]; then
    clone_args+=( --memory "$VM_MEMORY_GIB" )
    echo "[run] Session VM RAM: ${VM_MEMORY_GIB} GiB (project override)"
  fi
  if [[ -n "${VM_CPUS:-}" ]]; then
    clone_args+=( --cpus "$VM_CPUS" )
    echo "[run] Session VM CPUs: ${VM_CPUS} (project override)"
  fi
  run_with_spinner "[run] Cloning session VM: $sess..." limactl clone "$BASE_NAME" "$sess" \
    "${clone_args[@]}" --tty=false --start
  rm -f "$lockfile"
  trap - EXIT
  echo "[run] Clone complete, lock released $(_ts)"

  # Track session
  write_senv "$senv" "$sess" "$proj" "$cfg_hash" "$SESSION_MODE" "${SESSION_PORT:-}" "${KEEP_HISTORY:-0}" "${SESSION_TLS:-0}"

  cleanup() {
    echo "[cleanup] Starting cleanup... $(_ts)"
    # Tear down web-mode SSH tunnel (no-op if not web mode or already gone).
    # Sweep the actual base first, then the search window start_web_tunnels uses.
    if [[ "${SESSION_MODE:-}" == "web" && -n "${sess:-}" ]]; then
      local _p
      # The effective base first — it can sit outside the window below if the
      # block had to move — then the window itself, for tunnels a crashed run
      # left behind.
      [[ -n "${WEB_PORT_BASE:-}" ]] && stop_web_tunnels "$sess" "$WEB_PORT_BASE" >/dev/null 2>&1
      if [[ -n "${SESSION_PORT:-}" ]]; then
        for _p in $(seq "$SESSION_PORT" $((SESSION_PORT + 9))); do
          stop_web_tunnels "$sess" "$_p" >/dev/null 2>&1 || true
        done
      fi
    fi
    # Sync config back with conflict detection
    local dst
    dst="$(pick_host_cfg)"
    local sess_cfg_json="$sess_share/config/opencode/opencode.json"
    local sess_cfg_dot="$sess_share/config/opencode/.opencode.json"
    local sess_cfg="$sess_cfg_json"
    local proj_cfg_cleanup="$proj_state/config/opencode/opencode.json"

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

      # Merge the session config INTO the project-state baseline (session wins)
      # rather than overwriting it, so a provider that lives only in project
      # state is not dropped just because this session never referenced it.
      local _pmerge="$persist_cfg.proj"
      if _cfg_merge "$proj_cfg_cleanup" "$persist_cfg" "$_pmerge"; then
        cp -p "$_pmerge" "$proj_cfg_cleanup"
        rm -f "$_pmerge"
      else
        cp -p "$persist_cfg" "$proj_cfg_cleanup"
      fi

      # Same merge-not-clobber rule for the host config write below.
      local _hmerge="$persist_cfg.host"
      _cfg_merge "$dst" "$persist_cfg" "$_hmerge" || cp -p "$persist_cfg" "$_hmerge"

      local current_hash
      current_hash="$(md5 -q "$dst")"
      if [[ "$current_hash" != "$cfg_hash" ]]; then
        echo ""
        echo "Another session has edited the OpenCode config since this session started."
        read -r -p "Overwrite with this session's config? [y/N] " answer </dev/tty || answer="n"
        if [[ "$answer" =~ ^[Yy]$ ]]; then
          cp -p "$_hmerge" "$dst"
        else
          local bak="$dst.session-bak-$(date +%Y%m%d-%H%M%S)"
          cp -p "$_hmerge" "$bak"
          echo "Keeping existing config. Session config saved to: $bak"
        fi
      else
        cp -p "$_hmerge" "$dst"
      fi
      rm -f "$persist_cfg" "$_hmerge"
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

    # Stop the materialize daemon (web-mode only; no-op if it wasn't running)
    # and purge the attachments directory unconditionally — uploads are
    # explicitly ephemeral per design.
    if [[ -n "${sess:-}" ]]; then
      stop_materialize_daemon "$sess" "$sess_share" >/dev/null 2>&1 || true
    fi
    if [[ -d "$sess_share/attachments" ]]; then
      rm -rf "$sess_share/attachments" 2>/dev/null || true
      echo "[cleanup] Web-UI attachments purged $(_ts)"
    fi

    # mcrepo: stop the in-VM graphify watcher (best-effort; if the VM is
    # already gone the kill is a no-op). The watcher is daemonized via setsid
    # so we kill the whole process group to also catch tree-sitter children.
    local _gfy_pidfile="$sess_share/graphify-watch.pid"
    if [[ -f "$_gfy_pidfile" ]] && [[ -n "${sess:-}" ]]; then
      local _gfy_pid
      _gfy_pid="$(cat "$_gfy_pidfile" 2>/dev/null || true)"
      if [[ -n "$_gfy_pid" ]]; then
        limactl shell --workdir / "$sess" -- bash -c '
          pid="$1"
          [[ -n "$pid" ]] && kill -TERM -"$pid" 2>/dev/null
          [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null
          true
        ' _ "$_gfy_pid" 2>/dev/null || true
        echo "[cleanup] graphify watcher stopped (pid $_gfy_pid) $(_ts)"
      fi
      rm -f "$_gfy_pidfile"
    fi

    # Persist any updated graphify graph back to the per-project store
    # (single-repo path; mcrepo workspaces commit the graph in docs/graphify/).
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
  # HUP/TERM as well as EXIT: a closed terminal window kills the shell without
  # running an EXIT-only trap, which is how a web session can leave its SSH
  # tunnel holding the host port with nothing behind it any more.
  trap cleanup EXIT HUP TERM

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

  # graphify self-heal (mcp module): runs in every session, no-op when graphify
  # isn't installed in the base. Defined near graphify_persist_*.
  graphify_ensure_mcp_in_vm "$sess"
  if [[ "$SESSION_MODE" == "web" ]]; then
    a2a_ensure_installed_in_vm "$sess"
  fi

  # mcrepo: spawn the graphify watcher inside the session VM so the graph
  # rebuilds incrementally as files change. Best-effort: failures are logged
  # to the session log file but never block the session start. The PID is
  # written to the session share so cleanup can kill it on session end.
  if is_mcrepo_workspace "$proj"; then
    local _gfy_log="$sess_share/graphify-watch.log"
    local _gfy_pidfile="$sess_share/graphify-watch.pid"
    : > "$_gfy_log"
    # One-shot incremental update first (so the agent has *some* graph even if
    # the watcher needs a moment to settle), then long-lived watch. Both run
    # in the VM as the same user opencode runs as; PID is captured via $!.
    vm_exec "$sess" '
      set +e
      proj="$1"; log="$2"; pidfile="$3"
      export PATH="$HOME/.local/bin:$PATH"
      # Initial build is fast and code-only; ignore failures (an empty repo
      # still produces a usable empty graph on the next watch tick).
      ( graphify update "$proj" >>"$log" 2>&1 ) || true
      # Long-lived watcher; daemonize via setsid so it survives this shell exit.
      setsid graphify watch "$proj" >>"$log" 2>&1 &
      echo $! > "$pidfile"
    ' "$proj" "$_gfy_log" "$_gfy_pidfile" 2>>"$_gfy_log" || \
      echo "[run] WARN: graphify watcher spawn failed; see $_gfy_log" >&2
    if [[ -s "$_gfy_pidfile" ]]; then
      echo "[run] graphify watch started (pid $(cat "$_gfy_pidfile")) — log: $_gfy_log $(_ts)"
    fi
  fi

  echo "[run] Launching OpenCode inside VM (project: $proj) $(_ts)"

  local host_lan_ip
  host_lan_ip="$(get_host_ip)"
  echo "[run] Host LAN IP: ${host_lan_ip} $(_ts)"

  # Web mode: SSH tunnel host(0.0.0.0:hostPort) → VM(127.0.0.1:OC_PORT).
  # opencode binds 127.0.0.1 inside the VM. Lima's loopback auto-forward
  # (127.0.0.1:OC_PORT) coexists with our tunnel — different bind addresses.
  # Tunnel failure is non-fatal: opencode is still reachable via loopback.
  local effective_base="${SESSION_PORT:-0}"
  local lan_up=1
  if [[ "$SESSION_MODE" == "web" ]]; then
    if start_web_tunnels "$sess" "${SESSION_PORT:-0}"; then
      effective_base="$WEB_PORT_BASE"
      probe_web_tunnel_async "$WEB_PORT_BASE" "$host_lan_ip" "${SESSION_TLS:-0}"
    else
      lan_up=0
      echo "[run] WARNING: SSH tunnel for LAN access could not be set up." >&2
      echo "[run]   Session continues. Loopback fallback may work via http://127.0.0.1:${SESSION_PORT}/ (Lima auto-forward)." >&2
      echo "[run]   To enable LAN access: 'limactl stop ${sess} && limactl start ${sess}', then 'opencode-vm attach'." >&2
    fi
    # Materialize daemon: dump inline data: URI attachments from web-UI
    # uploads to $sess_share/attachments/ so agent tools get real file paths.
    start_materialize_daemon "$sess" "$sess_share" || true
  fi

  install_web_lib "$sess_share" ||
    echo "[run] WARNING: could not write the web library into the session share." >&2
  resolve_session_auth "$sess_share"

  if vm_exec "$sess" '
    set -euo pipefail
    PROJ_DIR="$1"
    SESS_SHARE="$2"
    OC_MODE="$3"
    OC_PORT="$4"
    OC_WEB_TUI="$5"
    OC_HOST_IP="$6"
    OC_TLS="${7:-0}"
    OC_A2A="${8:-1}"
    OC_REQUIRE_A2A="${9:-0}"
    OC_A2A_DEFAULT_SECRET="${10:-opencode-vm}"
    OC_LAN_UP="${11:-1}"

    # Shared in-VM web library (materialized into the session share by
    # install_web_lib on the host, and mounted here at the same path). It owns
    # the TLS material, the proxy in front of opencode and the connect banner —
    # all of which attach_session needs identically. Fails safe: without it,
    # opencode serves $OC_PORT directly, exactly as it did before the
    # redirector existed.
    OC_BANNER_SUFFIX=""
    OC_BANNER_VERBOSE=1
    OC_PORT_INTERNAL="$OC_PORT"
    OC_SCHEME=http
    if [ -f "$SESS_SHARE/lib/web.sh" ]; then
      . "$SESS_SHARE/lib/web.sh"
    else
      echo "[run] web library missing from the session share — running without the redirector."
      echo "[web] WARNING: without it the session also has no application password."
      start_web_proxies() { return 0; }
      stop_all_proxies()  { return 0; }
      start_a2a()         { return 0; }
      stop_a2a()          { return 0; }
      wait_for_a2a()      { return 1; }
      a2a_watch_ready()   { return 0; }
      reap_stale_opencode() { return 0; }
      print_web_banner()  { local h="$OC_HOST_IP"; [ "${OC_LAN_UP:-1}" = "1" ] || h="127.0.0.1"; echo "  Browser/Web UI:  http://${h}:${OC_PORT}"; return 0; }
    fi

    export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.config/composer/vendor/bin:/tmp/go/bin:/tmp/pnpm-store:$PATH"

    # Config stays on mount (small JSON files, safe over virtiofs)
    export XDG_CONFIG_HOME="$SESS_SHARE/config"
    export OCVM_ATTACHMENTS_DIR="$SESS_SHARE/attachments"

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
      # Append web-mode notes sidecar (web sessions only)
      if [ -s "$SESS_SHARE/config/opencode/AGENTS.web.md" ]; then
        cat "$SESS_SHARE/config/opencode/AGENTS.web.md" >> "$SESS_SHARE/config/opencode/AGENTS.md"
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
        if [ "$result" = "error" ] || [ -z "$result" ]; then
          # Unreadable — usually a live writer (active or orphaned opencode)
          # holding the lock. The dump below would fail the same way and end
          # in deleting a healthy live database plus its WAL, which is how
          # session history silently vanished. Never treat busy as corrupt.
          echo "[sqlite] Skipping integrity check (busy or unreadable): $f"
          continue
        fi
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

    # EXIT trap so Ctrl+C in web mode still syncs VM-local data (auth.json,
    # sessions) back to the share — without this, provider logins made via
    # the web UI are lost when the user stops the server with Ctrl+C.
    sync_vm_to_share() {
      # After a hangup the pty is gone and every echo fails — under the
      # scripts set -e that aborted this trap before the rsync, silently
      # losing the history sync. Nothing below may die on a write error.
      set +e
      stop_all_proxies
      stop_a2a
      echo "[$(date +%T)] Syncing session data back to host..."
      # The rsync excludes log/, which made server-side failures undebuggable
      # from the host — keep the tail of the opencode log in the share.
      mkdir -p "$SESS_SHARE/log" 2>/dev/null || true
      tail -n 400 /tmp/oc-xdg-data/opencode/log/opencode.log > "$SESS_SHARE/log/opencode-last.log" 2>/dev/null || true
      check_sqlite_dbs "$VM_DATA/opencode" 2>/dev/null || true
      check_sqlite_dbs "$VM_STATE/opencode" 2>/dev/null || true
      rsync -a --exclude="bin/" --exclude="log/" --exclude="tool-output/" \
        "$VM_DATA/opencode/" "$SESS_SHARE/xdg-data/opencode/" 2>/dev/null || true
      rsync -a "$VM_STATE/opencode/" "$SESS_SHARE/xdg-state/opencode/" 2>/dev/null || true
      echo "[$(date +%T)] In-VM sync complete"
      return 0
    }
    trap sync_vm_to_share EXIT

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

    # Project key for the web UI route /<base64url(dir)>. Encodes the *physical*
    # cwd: that is what opencode process.cwd() reports and what the /:dir route
    # is matched against. Matters for the clean-symlink case, where a non-ASCII
    # project path resolves to /tmp/oc-mount-<sha12>.
    OC_DIR_KEY="$(printf %s "$(pwd -P)" | base64 -w0 | sed "s/+/-/g; s|/|_|g; s/=//g")"

    # ECC/custom tools ship a package.json in the config share. opencode does
    # install those deps itself, but only mid-bootstrap — by then its module
    # resolver has already scanned the empty node_modules and keeps that miss
    # cached for the whole server lifetime, so every prompt dies silently with
    # "Cannot find module @opencode-ai/plugin/tool" until a restart. Installing
    # up front removes the race. In-VM on purpose: native deps need linux
    # builds; on the share on purpose: later sessions reuse the result and this
    # becomes a no-op.
    OC_CFG_DIR="$XDG_CONFIG_HOME/opencode"
    if [ -f "$OC_CFG_DIR/package.json" ] && command -v npm >/dev/null 2>&1; then
      if [ ! -f "$OC_CFG_DIR/node_modules/.package-lock.json" ] ||
         [ "$OC_CFG_DIR/package.json" -nt "$OC_CFG_DIR/node_modules/.package-lock.json" ]; then
        echo "[$(date +%T)] Installing opencode config dependencies (custom tools/plugins)..."
        ( cd "$OC_CFG_DIR" && npm install --no-audit --no-fund --loglevel=error ) ||
          echo "[run] WARNING: config dependency install failed — custom tools may not load on first start."
        echo "[$(date +%T)] Config dependencies ready."
      fi
    fi

    case "$OC_MODE" in
      shell)
        echo "[shell] Interactive shell started in session VM."
        echo "[shell] Exit this shell to return to host terminal."
        bash
        ;;
      web)
        start_web_proxies
        start_a2a
        print_web_banner
        a2a_watch_ready
        reap_stale_opencode "$OC_PORT_INTERNAL"
        if [ "$OC_WEB_TUI" = "true" ]; then
          aa-exec -p opencode-sandbox -- opencode web --hostname 127.0.0.1 --port "$OC_PORT_INTERNAL" &
          OC_WEB_PID=$!
          sleep 2
          echo ""
          echo "Press Enter to start TUI (web server continues running)..."
          read -r
          aa-exec -p opencode-sandbox -- opencode attach "http://localhost:$OC_PORT_INTERNAL" || true
          kill "$OC_WEB_PID" 2>/dev/null || true
          wait "$OC_WEB_PID" 2>/dev/null || true
        else
          echo "Press Ctrl+C to stop the session."
          # Restart loop: crashes (non-clean exit) come back automatically.
          # The host-side SSH tunnel forwards to 127.0.0.1:$OC_PORT in the VM
          # and is stable across these in-VM restarts. Clean exits (0/130/143)
          # end the loop.
          #
          # The server runs as a background job under `wait` because only a
          # trapped signal can interrupt `wait` — a foreground child would
          # leave bash blocked, and a hangup (closed terminal, dropped SSH,
          # host sleep) would kill bash WITHOUT the EXIT trap: no sync back
          # (history lost) and opencode web orphaned on its port, where it
          # shadows every later session (ServeError respawn loop while the
          # browser silently talks to the unmanaged orphan). The set -e wrap
          # matters too: without set +e a crash exits the script at the
          # aa-exec line and the restart loop can never run.
          shutdown_requested=0
          OC_WEB_PID=""
          on_signal() { shutdown_requested=1; [ -n "$OC_WEB_PID" ] && kill "$OC_WEB_PID" 2>/dev/null; return 0; }
          trap on_signal INT TERM HUP
          serve_fails=0
          while [ "$shutdown_requested" = "0" ]; do
            set +e
            aa-exec -p opencode-sandbox -- opencode web --hostname 127.0.0.1 --port "$OC_PORT_INTERNAL" &
            OC_WEB_PID=$!
            wait "$OC_WEB_PID"
            rc=$?
            set -e
            OC_WEB_PID=""
            [ "$shutdown_requested" = "1" ] && break
            case "$rc" in
              0|130|143) break ;;
            esac
            serve_fails=$(( serve_fails + 1 ))
            if [ "$serve_fails" -ge 5 ]; then
              echo ""
              echo "[run] opencode web keeps dying (rc=$rc, ${serve_fails}x) — giving up."
              echo "[run]   A ServeError here means port $OC_PORT_INTERNAL is held by another process."
              break
            fi
            echo ""
            echo "[run] opencode web exited unexpectedly (rc=$rc) — restarting in 2s. Press Ctrl+C to abort."
            sleep 2 || break
          done
          trap - INT TERM HUP
        fi
        ;;
      *)
        aa-exec -p opencode-sandbox -- opencode || true
        ;;
    esac

    # Sync back happens via the EXIT trap installed above (covers both clean
    # exit and Ctrl+C-driven termination of the web server).
  ' "$proj" "$sess_share" "$SESSION_MODE" "$effective_base" "${OC_WEB_TUI:-false}" "$host_lan_ip" "${SESSION_TLS:-0}" "${SESSION_A2A:-${OCVM_A2A:-1}}" "${SESSION_REQUIRE_A2A:-0}" "$OCVM_A2A_DEFAULT_SECRET" "$lan_up"; then
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
      [[ -n "$pkg" ]] || { echo "Usage: opencode-vm skills on <ecc-auto|ecc-all|webimg|ssh-toolkit>" >&2; exit 2; }
      skills_pkg_on "$pkg"
      ;;
    off)
      local pkg="${1:-}"
      [[ -n "$pkg" ]] || { echo "Usage: opencode-vm skills off <ecc-auto|ecc-all|webimg|ssh-toolkit>" >&2; exit 2; }
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
  opencode-vm skills on <pkg>             # enable package (ecc-auto | ecc-all | webimg | ssh-toolkit)
  opencode-vm skills off <pkg>            # disable package
  opencode-vm skills list [path]          # preview what would mount (no VM touch)

  opencode-vm mcps                        # MCP status (alias)
  opencode-vm mcps list                   # list all MCPs (active/default markers)
  opencode-vm mcps on <name>              # enable MCP (playwright | searxng | repomapper | graphify | proxmox)
  opencode-vm mcps off <name>             # disable MCP (proxmox: also wipes credentials)
  opencode-vm mcps purge <name>           # wipe per-project cached state (graphify: graph cache)
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

  a2a)
    a2a_cmd "$@"
    ;;

  init)
    need limactl
    sanitize_lima_sock_dir

    [[ "$#" -eq 0 ]] || { echo "[init] Unknown option: $1" >&2; exit 2; }

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
    echo "Built-in skills: webimg (web image optimization), ssh-toolkit (SSH/network workflows) — both default-active"
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
    validate_web_port "$SESSION_PORT"
    start_session
    ;;

  ports)
    ports_cmd "$@"
    ;;

  ram)
    ram_cmd "$@"
    ;;

  cpu|cpus)
    cpu_cmd "$@"
    ;;

  doctor)
    doctor_cmd "$@"
    ;;

  provider)
    provider_cmd "$@"
    ;;

  auth)
    auth_cmd "$@"
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
                                           # ('run' is an alias for 'start')
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
  opencode-vm web [--port PORT] [--password PW|--no-auth] [--no-tls] [--tui]
                  [--no-a2a|--require-a2a] [--keep-history] [--reconnect|--fresh|--cancel-if-exists]
                                           # start web server session (default port 4096)
                                           # provides: web UI, REST API, TUI attach, A2A agent
                                           # Reserves a block around the base port P:
                                           #   P-2  opencode-a2a     (VM-internal)
                                           #   P-1  opencode backend (VM-internal)
                                           #   P    web HTTPS        P+1  web HTTP
                                           #   P+2  a2a HTTPS        P+3  a2a HTTP
                                           #   valid range for P: 1026-65532
                                           # --password PW: HTTP Basic on all four
                                           #   public endpoints (also \$OCVM_WEB_PASSWORD).
                                           #   Persisted per session, so 'attach' keeps it.
                                           # --no-auth: drop a stored session password
                                           # A2A always needs a credential (opencode-a2a
                                           #   refuses to start without one); with no
                                           #   --password it uses the printed default.
                                           # --no-a2a: web only (also \$OCVM_A2A=0)
                                           # --require-a2a: fail the session if A2A is not ready
                                           # Session prompt/exit behavior matches 'start'.
                                           # Serves HTTPS by default (self-signed cert):
                                           #   file/image attachments need a secure origin,
                                           #   opencode hashes them via crypto.subtle, which
                                           #   browsers withhold from plain-HTTP origins.
                                           # --no-tls: serve plain HTTP instead (attachments
                                           #   then only work via the 127.0.0.1 URL)
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
                                           #   webimg      — default on; web image optimization pipeline
                                           #                 (CLI tools pre-installed in base VM)
                                           #   ssh-toolkit — default on; SSH/network workflow knowledge
                                           #                 (CLI tools pre-installed in base VM)
                                           #   ecc-auto    — ~30 skills, filtered to project languages
                                           #                 (auto-clones ECC on first enable)
                                           #   ecc-all     — ~180 skills, every ECC skill (token-heavy)
  opencode-vm a2a {status|card|check} [project|url]
                                           # the A2A interface every web session exposes
                                           #   status — live agents + their effective URLs
                                           #            (--json for machine consumption)
                                           #   card   — print the served Agent Card
                                           #   check  — verify one agent end to end; sends two
                                           #            real prompts, so it costs tokens
                                           # Client contract: docs/A2A-INTERFACE.md
  opencode-vm mcps {status|list|on|off|purge} [name]
                                           # manage MCP servers (tools the agent can call)
                                           # MCPs (registry: mcps/registry.json):
                                           #   playwright — default on; headless browser automation
                                           #   searxng    — default on; account-free metasearch (SearXNG)
                                           #   repomapper — default off; PageRank codebase maps
                                           #   graphify   — default off; code knowledge-graph
                                           #                ('purge' wipes the per-project graph cache)
                                           #   proxmox    — default off; Proxmox VE API via ProxmoxMCP
                                           #                'on' prompts interactively for host + API token;
                                           #                'off' disables AND wipes stored credentials.
  opencode-vm ram [show|<GiB>|default]     # per-project session VM RAM (run inside the project)
  opencode-vm cpu [show|<N>|default]       # per-project session VM CPU count
                                           # defaults: 8 GiB / 6 CPUs, inherited from the base VM.
                                           # An override is remembered for this project and
                                           # re-applied on every 'start'. 'show' prints both
                                           # resources next to the host's totals;
                                           # '<cmd> default' clears that override.
  opencode-vm ports show                   # show current firewall policy
  opencode-vm ports reload                 # re-push policy.env to running sessions
  opencode-vm ports host {show|add|rm|set} [PORT...]
  opencode-vm ports hostfwd {show|enable|disable}
  opencode-vm ports lan tcp {show|add|rm|clear} IP[:PORT]
  opencode-vm ports lan udp {show|add|rm|clear} IP[:PORT]
  opencode-vm doctor [show]                # inspect local sync/auth/model/db state
  opencode-vm provider list                # list configured providers
  opencode-vm provider new                 # add new openai-compatible provider (interactive)
  opencode-vm provider add <id> --base-url <url> [--api-key <key>] [--name <n>] [--dry-run]
                                           # add provider non-interactively
  opencode-vm provider refresh <id>        # re-discover models from /v1/models (auto-runs at session start
                                           #   for local providers; OCVM_PROVIDER_AUTOREFRESH=0 disables)
  opencode-vm provider rm <id> [--dry-run] # remove provider from auth/config/model state
  opencode-vm auth status                  # show OAuth token freshness across VMs/sessions
  opencode-vm auth resync                  # adopt the freshest OAuth token into host auth.json
                                           #   (fix for '401 token refresh failed' across VMs;
                                           #    restart/attach the failing session afterwards)
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
