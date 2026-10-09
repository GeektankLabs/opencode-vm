#!/usr/bin/env bash
# Isolated session preparation: no host state, downloads or services.
# Mocks and package state are consumed by the sourced script.
# shellcheck disable=SC2034,SC2317
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"
[[ "$ORCHESTRATOR_SKILL_CACHE" == "$SHARE_ROOT/orchestrator-skill" ]]
skills_load() { SKILLS_PACKAGES=orchestrator; }
skills_sync_besprechung_for_session() { return 0; }
skills_registry_always_active() { return 0; }
detect_project_languages() { return 0; }
skills_registry_field() {
  case "$2" in
    .resolver) echo single_bundled ;;
    .skill_dir_name) echo opencode-session-orchestrator ;;
  esac
  return 0
}

skills_mount_for_session "$TMP/checkout-session" "$TMP" >"$TMP/checkout.out"
cmp "$ROOT/integrations/chatgpt/opencode-session-orchestrator/SKILL.md" \
  "$TMP/checkout-session/config/opencode/skills/orchestrator/opencode-session-orchestrator/SKILL.md"
grep -qx 'orchestrator/opencode-session-orchestrator' "$TMP/checkout-session/skills-manifest.txt"
echo 'ok - checkout mounts the enabled skill and records it'

SCRIPT_DIR="$TMP/standalone"
mkdir -p "$SCRIPT_DIR"
if skills_mount_for_session "$TMP/missing-session" "$TMP" >"$TMP/missing.out" 2>"$TMP/missing.err"; then
  echo 'not ok - absent standalone source was silently accepted' >&2
  exit 1
fi
grep -q 'Enabled orchestrator skill source unavailable' "$TMP/missing.err"
[[ ! -s "$TMP/missing-session/skills-manifest.txt" ]]
[[ ! -e "$TMP/missing-session/config/opencode/skills/orchestrator/opencode-session-orchestrator/SKILL.md" ]]
echo 'ok - standalone missing source fails explicitly without a false mount'

cache_skill="$ORCHESTRATOR_SKILL_CACHE/integrations/chatgpt/opencode-session-orchestrator"
mkdir -p "$cache_skill"
: > "$cache_skill/SKILL.md"
if skills_mount_for_session "$TMP/empty-session" "$TMP" >"$TMP/empty.out" 2>"$TMP/empty.err"; then
  echo 'not ok - empty standalone skill was accepted' >&2
  exit 1
fi
echo 'ok - incomplete cache is rejected'
cp "$ROOT/integrations/chatgpt/opencode-session-orchestrator/SKILL.md" "$cache_skill/SKILL.md"
skills_mount_for_session "$TMP/cache-session" "$TMP" >"$TMP/cache.out"
cmp "$cache_skill/SKILL.md" "$TMP/cache-session/config/opencode/skills/orchestrator/opencode-session-orchestrator/SKILL.md"
grep -qx 'orchestrator/opencode-session-orchestrator' "$TMP/cache-session/skills-manifest.txt"
echo 'ok - existing complete standalone cache mounts offline'

skills_load() { SKILLS_PACKAGES=""; }
skills_mount_for_session "$TMP/off-session" "$TMP" >"$TMP/off.out"
[[ ! -e "$TMP/off-session/config/opencode/skills/orchestrator" ]]
echo 'ok - opt-out does not require a skill source'
