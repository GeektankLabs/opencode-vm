#!/usr/bin/env bash
# D5 focused checks: canonical local orchestrator skill loader, mount/update/
# recovery identity, and the monitor self-connection composition.
# shellcheck disable=SC2034
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME" "$TMP/project"
# shellcheck disable=SC1091
source "$ROOT/opencode-vm.sh"

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

# 1) Registry coherence for the canonical orchestrator package.
[[ "$(skills_registry_field orchestrator .resolver)" == "single_bundled" ]] || fail 'resolver mismatch'
[[ "$(skills_registry_field orchestrator .skill_dir_name)" == "opencode-session-orchestrator" ]] || fail 'skill_dir_name mismatch'
[[ "$(skills_registry_field orchestrator .install.sparse_path)" == "integrations/chatgpt/opencode-session-orchestrator" ]] || fail 'sparse_path mismatch'
[[ "$(skills_registry_field orchestrator .default_active)" == "false" ]] || fail 'must stay opt-in'
pass 'orchestrator package is a registered opt-in single_bundled loader'

# 2) Source identity: actual bytes of the canonical r47 revision.
source_root="$(skills_source_root_for orchestrator)"
skill_dir="$source_root/opencode-session-orchestrator"
[[ -d "$skill_dir" ]] || fail 'orchestrator source dir missing'
grep -q '2026-10-09-r47' "$skill_dir/SKILL.md" || fail 'SKILL.md revision marker missing'
grep -q '^## 2026-10-09-r47' "$skill_dir/CHANGELOG.md" || fail 'CHANGELOG revision missing'
python3 - "$source_root" <<'PY'
import json, hashlib, sys, pathlib
base = pathlib.Path(sys.argv[1])
manifest = json.loads((base / "bundle.json").read_text())
assert manifest["revision"] == "2026-10-09-r47", manifest["revision"]
zip_bytes = (base / "opencode-session-orchestrator.zip").read_bytes()
digest = hashlib.sha256(zip_bytes).hexdigest()
assert (base / "opencode-session-orchestrator.zip.sha256").read_text().strip().startswith(digest)
latest = json.loads((base / "latest.json").read_text())
assert latest["revision"] == manifest["revision"] and latest["sha256"] == digest
PY
pass 'canonical source bytes are revision r47 and bundle/ZIP/latest are coherent'

# 3) Mount into a session share (local load path) with actual bytes.
share="$TMP/share"; mkdir -p "$share"
skills_load >/dev/null 2>&1 || true
skills_pkg_on orchestrator >/dev/null
skills_mount_for_session "$share" "$TMP/project" >/dev/null
dest="$share/config/opencode/skills/orchestrator/opencode-session-orchestrator"
[[ -f "$dest/SKILL.md" ]] || fail 'mounted SKILL.md missing'
cmp -s "$skill_dir/SKILL.md" "$dest/SKILL.md" || fail 'mounted bytes differ from canonical source'
grep -q '2026-10-09-r47' "$dest/SKILL.md" || fail 'mounted revision missing'
grep -q 'orchestrator/opencode-session-orchestrator' "$share/skills-manifest.txt" || fail 'manifest entry missing'
pass 'session share load mounts the canonical bytes and records the manifest'

# 4) Update propagation/recovery: a stale local copy is refreshed on re-mount.
printf 'stale-local-edit\n' >> "$dest/SKILL.md"
skills_mount_for_session "$share" "$TMP/project" >/dev/null
cmp -s "$skill_dir/SKILL.md" "$dest/SKILL.md" || fail 're-mount did not restore canonical bytes'
pass 're-mount refreshes a stale local copy back to the canonical revision'

# 5) Self-MCP composition: test the functions from the actual materialized artifact.
install_web_lib "$share" >/dev/null
lib="$share/lib/web.sh"
[[ -f "$lib" ]] || fail 'web lib not materialized'
grep -q 'mcp_self_register || true' "$lib" || fail 'start hook missing'
grep -q 'mcp_self_unregister || true' "$lib" || fail 'stop hook missing'
{ awk '/^mcp_self_unregister\(\) \{/,/^\}$/' "$lib"; awk '/^mcp_self_register\(\) \{/,/^\}$/' "$lib"; } > "$TMP/self-mcp-funcs.sh"
grep -q '^mcp_self_register() {' "$TMP/self-mcp-funcs.sh" || fail 'register function not extracted'
# shellcheck disable=SC1090
source "$TMP/self-mcp-funcs.sh"
pass 'web lib materializes with the self-connection functions wired'

cfg="$share/config/opencode/opencode.json"
mkdir -p "$share/mcp"
printf '%s\n' '{"mcp":{"keep":{"type":"remote","url":"http://127.0.0.1:1/mcp"}}}' > "$cfg"
printf 'tok-selftest-123\n' > "$share/mcp/credential"
chmod 600 "$share/mcp/credential"
out="$(OC_MCP_ENABLED=1 OC_MCP_PORT=1234 SESS_SHARE="$share" mcp_self_register)"
[[ "$out" != *tok-selftest-123* ]] || fail 'token leaked to output'
jq -e '.mcp.keep.url == "http://127.0.0.1:1/mcp"' "$cfg" >/dev/null || fail 'unrelated mcp entries changed'
jq -e '.mcp["ocvm-self"].url == "http://127.0.0.1:1234/mcp" and .mcp["ocvm-self"].headers["X-OCVM-MCP-Token"] == "tok-selftest-123" and .mcp["ocvm-self"].enabled == true' "$cfg" >/dev/null || fail 'self entry wrong'
SESS_SHARE="$share" mcp_self_unregister >/dev/null
jq -e '(.mcp | has("ocvm-self") | not) and (.mcp.keep != null)' "$cfg" >/dev/null || fail 'unregister wrong'
# Guard: without the mounted orchestrator skill nothing is added.
rm -rf "$dest"
SESS_SHARE="$share" mcp_self_register >/dev/null
jq -e '.mcp | has("ocvm-self") | not' "$cfg" >/dev/null || fail 'registered without skill'
pass 'self-connection registers only with the skill, carries the token, and unregisters cleanly'