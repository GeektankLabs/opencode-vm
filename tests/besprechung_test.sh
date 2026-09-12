#!/usr/bin/env bash
# Fixtures intentionally isolate HOME; mocks are called by the sourced script.
# shellcheck disable=SC2030,SC2031,SC2317
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/opencode-vm.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
assert_file() { [[ -f "$1" ]] || fail "missing file: $1"; }

jq -e '
  .skills.besprechung.default_active == true and
  .skills.besprechung.resolver == "single_bundled" and
  .skills.besprechung.skill_dir_name == "besprechung" and
  .skills.besprechung.commands == ["besprechung.md", "besprechung-dialog.md"]
' "$ROOT/skills/registry.json" >/dev/null || fail "invalid besprechung registry entry"
assert_file "$ROOT/skills/besprechung/SKILL.md"
assert_file "$ROOT/skills/besprechung/commands/besprechung.md"
assert_file "$ROOT/skills/besprechung/commands/besprechung-dialog.md"
pass "bundled skill and commands are registered"

(
  export HOME="$TMP/fresh-home"
  mkdir -p "$HOME"
  export OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  # shellcheck disable=SC1090
  source "$SCRIPT"
  skills_load
  case " $SKILLS_PACKAGES " in
    *" besprechung "*) ;;
    *) fail "fresh state did not enable besprechung" ;;
  esac
  [[ "$SKILLS_DEFAULTS_VERSION" == "1" ]] || fail "fresh defaults marker was not written"

  session="$TMP/session"
  project="$TMP/project"
  mkdir -p "$project"
  skills_mount_for_session "$session" "$project" >/dev/null
  assert_file "$session/config/opencode/skills/besprechung/besprechung/SKILL.md"
  assert_file "$session/config/opencode/commands/besprechung.md"
  assert_file "$session/config/opencode/commands/besprechung-dialog.md"
)
pass "fresh sessions receive the skill and commands"

(
  export HOME="$TMP/existing-home"
  mkdir -p "$HOME/.opencode-vm"
  cat > "$HOME/.opencode-vm/skills.env" <<'EOF'
SKILLS_PACKAGES="webimg"
EOF
  export OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  # shellcheck disable=SC1090
  source "$SCRIPT"
  skills_load 2>"$TMP/migrate.err"
  case " $SKILLS_PACKAGES " in
    *" besprechung "*) ;;
    *) fail "existing state was not migrated" ;;
  esac
  [[ "$SKILLS_DEFAULTS_VERSION" == "1" ]] || fail "migration marker was not written"

  skills_pkg_off besprechung >/dev/null
  skills_load
  case " $SKILLS_PACKAGES " in
    *" besprechung "*) fail "disabled default was re-enabled" ;;
  esac
)
pass "existing state migrates once and respects later opt-out"

UPDATE_HOME="$TMP/update-home"
mkdir -p "$UPDATE_HOME/.opencode-vm"
cat > "$UPDATE_HOME/.opencode-vm/skills.env" <<'EOF'
SKILLS_PACKAGES="ssh-toolkit"
EOF
HOME="$UPDATE_HOME" OCVM_DISABLE_UPDATE_CHECK=1 \
  bash "$SCRIPT" --post-update-migrate 0.5.45 0.5.46 >/dev/null
grep -q 'SKILLS_PACKAGES="ssh-toolkit besprechung"' "$UPDATE_HOME/.opencode-vm/skills.env" ||
  fail "post-update migration did not enable besprechung"
grep -q 'SKILLS_DEFAULTS_VERSION="1"' "$UPDATE_HOME/.opencode-vm/skills.env" ||
  fail "post-update migration did not persist its marker"
pass "post-update hook introduces the new default package"

(
  export HOME="$TMP/collision-home"
  mkdir -p "$HOME/.opencode-vm"
  export OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  # shellcheck disable=SC1090
  source "$SCRIPT"
  session="$TMP/collision-session"
  project="$TMP/collision-project"
  mkdir -p "$session/config/opencode/commands" "$project"
  printf '%s\n' 'user command' > "$session/config/opencode/commands/besprechung.md"
  skills_mount_for_session "$session" "$project" >/dev/null 2>"$TMP/collision.err"
  [[ "$(<"$session/config/opencode/commands/besprechung.md")" == "user command" ]] ||
    fail "existing command was replaced"
  grep -q "already exists" "$TMP/collision.err" || fail "command collision was not reported"
)
pass "packaged commands do not replace existing commands"

(
  export HOME="$TMP/cache-home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  mkdir -p "$HOME"
  # shellcheck disable=SC1090
  source "$SCRIPT"
  SCRIPT_DIR="$TMP/standalone"
  mkdir -p "$SCRIPT_DIR"
  payload="$TMP/payload"
  mkdir -p "$payload"
  cp -R "$ROOT/skills/." "$payload/"
  FAIL_GIT=""
  git() {
    # No remote access: exercise clone, fetch, checkout and sparse repair locally.
    printf '%s\n' "$*" >> "$TMP/skills-git.log"
    if [[ "$1" == "clone" ]]; then
      mkdir -p "$SKILLS_REGISTRY_CACHE/.git"
      return
    fi
    [[ "$1" == "-C" && "$2" == "$SKILLS_REGISTRY_CACHE" ]] || return 1
    [[ "$3" != "$FAIL_GIT" ]] || return 1
    case "$3" in
      fetch|checkout) return 0 ;;
      sparse-checkout)
        mkdir -p "$SKILLS_REGISTRY_CACHE/skills"
        cp -R "$payload/." "$SKILLS_REGISTRY_CACHE/skills/"
        ;;
      *) return 1 ;;
    esac
  }
  skills_load
  skills_sync_besprechung_for_session "$TMP/cache-session"
  assert_file "$TMP/cache-session/config/opencode/commands/besprechung-dialog.md"

  FAIL_GIT=fetch
  if ocvm_post_update_migrate 0.5.45 0.5.46 2>"$TMP/refresh.err"; then
    fail "update accepted a failed fetch of an existing cache"
  fi
  grep -q 'Could not refresh' "$TMP/refresh.err" || fail "failed refresh was not reported"
  FAIL_GIT=checkout
  if skills_registry_ensure 2>/dev/null; then fail "failed checkout was accepted"; fi
  FAIL_GIT=sparse-checkout
  if skills_registry_ensure 2>/dev/null; then fail "failed sparse checkout was accepted"; fi
  # A complete cache still works without any network operation on normal starts.
  skills_sync_besprechung_for_session "$TMP/offline-session"
  assert_file "$TMP/offline-session/config/opencode/skills/besprechung/besprechung/SKILL.md"

  rm "$SKILLS_REGISTRY_CACHE/skills/besprechung/commands/besprechung-dialog.md"
  if skills_sync_besprechung_for_session "$TMP/incomplete-session" 2>/dev/null; then
    fail "incomplete package was accepted despite failed repair"
  fi
  [[ ! -e "$TMP/incomplete-session/config/opencode/commands/besprechung.md" ]] ||
    fail "an incomplete package was partially installed"
  FAIL_GIT=""
  skills_sync_besprechung_for_session "$TMP/incomplete-session"
  assert_file "$TMP/incomplete-session/config/opencode/commands/besprechung-dialog.md"

  # Refresh old registry content before migrating; do not mark incomplete payloads.
  rm "$SKILLS_ENV"
  rm -rf "$SKILLS_REGISTRY_CACHE/skills/besprechung"
  jq 'del(.skills.besprechung)' "$ROOT/skills/registry.json" > "$SKILLS_REGISTRY_CACHE/skills/registry.json"
  rm "$payload/besprechung/commands/besprechung-dialog.md"
  if skills_load 2>/dev/null; then fail "incomplete payload completed migration"; fi
  [[ ! -e "$SKILLS_ENV" ]] || fail "failed migration persisted a success marker"
  cp "$ROOT/skills/besprechung/commands/besprechung-dialog.md" "$payload/besprechung/commands/"
  skills_load
  [[ "$SKILLS_DEFAULTS_VERSION" == "1" ]] || fail "migration retry did not finish"
  skills_pkg_off besprechung >/dev/null
  openlive_remote_mappings_exist() { return 1; }
  openlive_bridge_installed() { return 1; }
  ocvm_check_remote_version() { printf '%s\n' "$OCVM_VERSION"; }
  FAIL_GIT=fetch
  if update_cmd >/dev/null 2>/dev/null; then fail "same-version update ignored asset failure"; fi
  FAIL_GIT=""
  update_cmd >/dev/null
  case " $SKILLS_PACKAGES " in *" besprechung "*) fail "update reverted opt-out" ;; esac
)
pass "standalone cache refresh failures, offline reuse, incomplete payloads and retry are handled"

(
  export HOME="$TMP/resume-home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
  export OCVM_AUTH_AUTORESYNC=0
  mkdir -p "$HOME"
  # shellcheck disable=SC1090
  source "$SCRIPT"
  SCRIPT_DIR="$TMP/resume-source"
  mkdir -p "$SCRIPT_DIR"
  cp -R "$ROOT/skills" "$SCRIPT_DIR/skills"
  share="$TMP/resume-session"
  mkdir -p "$share/config/opencode/commands" "$share/config/opencode/skills/besprechung/besprechung"
  printf 'SESS_NAME="test-vm"\nSESS_MODE="tui"\n' > "$TMP/resume.env"
  # Pre-marker baseline commands are adopted only when their bytes match.
  cp "$ROOT/skills/besprechung/commands/besprechung.md" "$share/config/opencode/commands/"
  # Reconstruct the initial MVP skill before the unused metadata was removed.
  awk 'NR == 4 { print "metadata:"; print "  opencode/autoinvoke: \"false\"" } { print }' \
    "$ROOT/skills/besprechung/SKILL.md" > "$share/config/opencode/skills/besprechung/besprechung/SKILL.md"
  [[ "$(cksum < "$share/config/opencode/skills/besprechung/besprechung/SKILL.md")" == "1794848888 5425" ]] ||
    fail "legacy skill fixture no longer matches the original MVP"
  session_env() { printf '%s\n' "$TMP/resume.env"; }
  session_share_dir() { printf '%s\n' "$share"; }
  proj_hash() { printf 'test-hash\n'; }
  need() { :; }
  sanitize_lima_sock_dir() { :; }
  is_vm_running() { return 0; }
  get_host_ip() { printf '127.0.0.1\n'; }
  apply_policy_in_vm() { :; }
  setup_host_port_forwards_in_vm() { :; }
  graphify_ensure_mcp_in_vm() { :; }
  # Test the actual attach path up to VM launch, not merely the sync helper.
  vm_exec() {
    assert_file "$share/config/opencode/skills/besprechung/besprechung/SKILL.md"
    cmp -s "$SCRIPT_DIR/skills/besprechung/SKILL.md" \
      "$share/config/opencode/skills/besprechung/besprechung/SKILL.md" || fail "resume launched with a stale skill"
    cmp -s "$SCRIPT_DIR/skills/besprechung/commands/besprechung.md" \
      "$share/config/opencode/commands/besprechung.md" || fail "resume launched with stale commands"
  }
  attach_session >/dev/null
  printf '\nUpdated package content.\n' >> "$SCRIPT_DIR/skills/besprechung/commands/besprechung.md"
  attach_session >/dev/null
  # An edited managed command must survive both updates and opt-out.
  printf 'user edit\n' > "$share/config/opencode/commands/besprechung-dialog.md"
  attach_session >/dev/null 2>"$TMP/resume-preserve.err"
  [[ "$(<"$share/config/opencode/commands/besprechung-dialog.md")" == "user edit" ]] || fail "resume overwrote an edit"
  skills_pkg_off besprechung >/dev/null
  vm_exec() {
    [[ ! -e "$share/config/opencode/skills/besprechung/besprechung/SKILL.md" ]] || fail "disabled skill survived resume"
    [[ ! -e "$share/config/opencode/commands/besprechung.md" ]] || fail "disabled command survived resume"
    [[ "$(<"$share/config/opencode/commands/besprechung-dialog.md")" == "user edit" ]] || fail "opt-out deleted an edit"
    [[ ! -s "$share/skills-manifest.txt" ]] || fail "resume left stale skill manifest entries"
  }
  attach_session >/dev/null 2>/dev/null
)
pass "actual reconnect installs, refreshes and removes owned files while preserving edits"
