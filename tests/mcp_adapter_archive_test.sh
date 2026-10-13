#!/usr/bin/env bash
# Archive import-closure smoke test (task_68085480 packaging regression).
#
# Builds the real MCP adapter release tar, extracts it into an isolated temp
# directory, links the production dependencies, and loads the ACTUAL archive
# entrypoint and tools module from the extracted bytes. If the build list ever
# omits a required sibling module again (the order-recovery.js regression), the
# dynamic import fails with ERR_MODULE_NOT_FOUND and this test fails — a missing
# module cannot hide behind a local dist/ that happens to be complete.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ADAPTER="$ROOT/adapters/mcp"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

command -v node >/dev/null 2>&1 || { echo "skip: node unavailable"; exit 0; }
[ -d "$ADAPTER/node_modules" ] || { echo "skip: adapter node_modules unavailable (run npm ci)"; exit 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ARCHIVE="$TMP/archive.tar"
bash "$ROOT/scripts/build-mcp-adapter.sh" "$ARCHIVE" >/dev/null || fail "archive build failed"
[ -s "$ARCHIVE" ] || fail "archive not produced"

mkdir "$TMP/extract"
tar -xf "$ARCHIVE" -C "$TMP/extract"
NAME="$(ls "$TMP/extract")"
ROOT_DIR="$TMP/extract/$NAME"
DIST="$ROOT_DIR/dist"
[ -f "$DIST/main.js" ] || fail "archive entrypoint dist/main.js missing"
[ -f "$DIST/tools.js" ] || fail "archive dist/tools.js missing"

# Offline production dependencies: reuse the adapter's installed modules.
ln -s "$ADAPTER/node_modules" "$ROOT_DIR/node_modules"

if compgen -G "$DIST/*.test.js" >/dev/null; then fail "archive ships compiled test modules"; fi

# Load the extracted entrypoint and build the tool schema from the archive bytes.
ARCHIVE_ROOT="$ROOT_DIR" node --input-type=module <<'NODE' || fail "archive import / tools/list failed"
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.env.ARCHIVE_ROOT;
const entry = await import(pathToFileURL(join(root, "dist/main.js")).href);
if (typeof entry.main !== "function") throw new Error("archive main entrypoint export missing");

const tools = await import(pathToFileURL(join(root, "dist/tools.js")).href);
if (typeof tools.dispatchMcp2Method !== "function") throw new Error("archive tools.dispatchMcp2Method missing");

const runtime = { project: root, projectHash: "archive-smoke", activityJournalEnabled: true };
const res = await tools.dispatchMcp2Method({}, runtime, "tools/list", 1, {});
const list = res?.tools ?? res?.result?.tools ?? [];
const names = list.map((tool) => tool.name);
if (names.length < 46) throw new Error(`tools/list returned ${names.length} tools (expected >= 46)`);
for (const required of ["recover_session_order", "send_message", "list_monitors"]) {
  if (!names.includes(required)) throw new Error(`tools/list missing ${required}`);
}
console.log(`imported archive entrypoint; tools/list = ${names.length} tools`);
NODE

pass "archive extracts, loads the real entrypoint with prod deps, and builds the tool schema (>=46 tools incl. recover_session_order)"

printf 'PASS MCP adapter archive import-closure smoke\n'
