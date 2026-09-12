#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ADAPTER="$ROOT/adapters/openlive-acp"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
VERSION="$(jq -er '.version' "$ADAPTER/package.json")"
NAME="opencode-vm-openlive-adapter-$VERSION"
OUTPUT="${1:-$ROOT/dist/$NAME.tar}"
EPOCH="${SOURCE_DATE_EPOCH:-0}"
TAR="${GTAR:-}"

if [[ -z "$TAR" ]]; then
  if command -v gtar >/dev/null 2>&1; then TAR="gtar"; else TAR="tar"; fi
fi
"$TAR" --version 2>/dev/null | grep -q 'GNU tar' || {
  echo "GNU tar is required to build the release artifact." >&2
  exit 1
}

mkdir -p "$(dirname "$OUTPUT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/$NAME"
mkdir -p "$STAGE/dist/acp" "$STAGE/dist/core" "$STAGE/dist/manager" \
  "$STAGE/dist/opencode" "$STAGE/manager"

(
  cd "$ADAPTER"
  npm run check --silent
  npm run build --silent
)

cp -p "$ADAPTER/package.json" "$ADAPTER/package-lock.json" "$STAGE/"
cp -p "$ROOT/LICENSE" "$STAGE/LICENSE"
cp -p "$ADAPTER/src/manager/tool.mjs" "$STAGE/manager/tool.mjs"
cp -p "$ADAPTER/dist/main.js" "$ADAPTER/dist/types.js" "$STAGE/dist/"
cp -p "$ADAPTER/dist/acp/transport.js" "$STAGE/dist/acp/"
cp -p "$ADAPTER/dist/core/call-controller.js" \
  "$ADAPTER/dist/core/session-inspector.js" "$STAGE/dist/core/"
cp -p "$ADAPTER/dist/manager/control-server.js" \
  "$ADAPTER/dist/manager/manager-session.js" "$STAGE/dist/manager/"
cp -p "$ADAPTER/dist/opencode/gateway.js" "$STAGE/dist/opencode/"

jq -n \
  --arg version "$VERSION" \
  --arg acp "$(jq -er '.dependencies["@agentclientprotocol/sdk"]' "$ADAPTER/package.json")" \
  --arg opencode "$(jq -er '.dependencies["@opencode-ai/sdk"]' "$ADAPTER/package.json")" \
  '{schema:1,adapterVersion:$version,node:">=22",acpSdkVersion:$acp,opencodeSdkVersion:$opencode}' \
  > "$STAGE/manifest.json"

LC_ALL=C "$TAR" --sort=name --format=ustar --owner=0 --group=0 --numeric-owner \
  --mtime="@$EPOCH" --mode='u+rwX,go+rX,go-w' -cf "$OUTPUT" \
  -C "$TMP" "$NAME"

printf '%s\n' "$OUTPUT"
