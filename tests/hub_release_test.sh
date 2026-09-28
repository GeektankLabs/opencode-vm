#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export OCVM_INTERNAL_SOURCE_ONLY=1
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"
"$ROOT/scripts/build-agent-hub.sh" "$TMP/hub.tar" >/dev/null
[[ "$(shasum -a 256 "$TMP/hub.tar" | cut -d' ' -f1)" == "$HUB_ASSET_SHA256" ]]
SCRIPT_DIR="$TMP/standalone"
SHARE_ROOT="$TMP/state"
mkdir -p "$SCRIPT_DIR" "$SHARE_ROOT"
TEST_ARCHIVE="$TMP/hub.tar"
curl() {
  local output=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in -o) shift; output="$1" ;; esac
    shift
  done
  cp "$TEST_ARCHIVE" "$output"
}
agent_hub_prepare_cache
candidate="$(agent_hub_source_dir)"
[[ "$candidate" == "$SHARE_ROOT/hub-assets/$HUB_ASSET_SHA256/hub" ]]
for asset in server.py policy.py catalog.py index.html styles.css app.js control.js; do
  [[ -f "$candidate/$asset" ]]
done
[[ ! -e "$candidate/__pycache__" ]]
echo "ok - standalone Hub assets are pinned, validated and usable without project source"
