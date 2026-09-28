#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTPUT="${1:-$ROOT/dist/opencode-vm-hub-1.tar}"
TAR="${GTAR:-tar}"
"$TAR" --version 2>/dev/null | grep -q 'GNU tar' || { echo "GNU tar is required" >&2; exit 1; }
mkdir -p "$(dirname "$OUTPUT")"
LC_ALL=C "$TAR" --sort=name --format=ustar --owner=0 --group=0 --numeric-owner \
  --mtime=@0 --mode='u+rwX,go+rX,go-w' -cf "$OUTPUT" -C "$ROOT" \
  hub/server.py hub/policy.py hub/catalog.py hub/index.html hub/styles.css hub/app.js hub/control.js
printf '%s\n' "$OUTPUT"
