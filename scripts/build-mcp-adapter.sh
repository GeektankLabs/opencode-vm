#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ADAPTER="$ROOT/adapters/mcp"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
VERSION="$(jq -er '.version' "$ADAPTER/package.json")"
grep -qF "export const ADAPTER_VERSION = \"$VERSION\";" "$ADAPTER/src/types.ts" || {
  echo "types.ts ADAPTER_VERSION must match package.json." >&2
  exit 1
}
PROTOCOL="$(cd "$ADAPTER" && node --input-type=module -e \
  'import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"; process.stdout.write(LATEST_PROTOCOL_VERSION)')"
NAME="opencode-vm-mcp-adapter-$VERSION"
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
mkdir -p "$STAGE/dist"

(
  cd "$ADAPTER"
  npm run check --silent
  npm run build --silent
)

cp -p "$ADAPTER/package.json" "$ADAPTER/package-lock.json" "$STAGE/"
cp -p "$ROOT/LICENSE" "$STAGE/LICENSE"
cp -p "$ADAPTER/dist/main.js" "$ADAPTER/dist/types.js" \
  "$ADAPTER/dist/opencode.js" "$ADAPTER/dist/tools.js" \
  "$ADAPTER/dist/http.js" "$STAGE/dist/"

jq -n \
  --arg version "$VERSION" \
  --arg mcp "$(jq -er '.dependencies["@modelcontextprotocol/sdk"]' "$ADAPTER/package.json")" \
  --arg opencode "$(jq -er '.dependencies["@opencode-ai/sdk"]' "$ADAPTER/package.json")" \
  --arg zod "$(jq -er '.dependencies.zod' "$ADAPTER/package.json")" \
  --arg protocol "$PROTOCOL" \
  '{schema:1,adapterVersion:$version,node:">=22",mcpSdkVersion:$mcp,opencodeSdkVersion:$opencode,zodVersion:$zod,transport:"streamable-http-stateless",testedProtocolVersion:$protocol}' \
  > "$STAGE/manifest.json"

LC_ALL=C "$TAR" --sort=name --format=ustar --owner=0 --group=0 --numeric-owner \
  --mtime="@$EPOCH" --mode='u+rwX,go+rX,go-w' -cf "$OUTPUT" \
  -C "$TMP" "$NAME"

printf '%s\n' "$OUTPUT"
