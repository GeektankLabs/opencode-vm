#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/opencode-vm.sh"
TMP="$(mktemp -d)"
NODE_BIN="$(command -v node)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }
assert_file() { [[ -f "$1" ]] || fail "missing file: $1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "expected '$2', got '$1'"; }

ARTIFACT="$TMP/opencode-vm-openlive-adapter-0.1.5.tar"
"$ROOT/scripts/build-openlive-adapter.sh" "$ARTIFACT" >/dev/null
ADAPTER_SHA="$(awk -F'"' '/^OPENLIVE_ADAPTER_SHA256=/ { print $2; exit }' "$SCRIPT")"
assert_eq "$(sha256sum "$ARTIFACT" | awk '{ print $1 }')" "$ADAPTER_SHA"

RELEASE_WORKFLOW="$ROOT/.github/workflows/release.yml"
grep -A2 '^    branches:$' "$RELEASE_WORKFLOW" | grep -q '^      - main$' ||
  fail "release workflow does not run for main pushes"
grep -A2 '^    tags:$' "$RELEASE_WORKFLOW" | grep -q '^      - "v\*"$' ||
  fail "release workflow does not retain the manual tag recovery trigger"
grep -qF 'group: opencode-vm-release-${{ needs.metadata.outputs.release_tag }}' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not serialize publication per version"
grep -qF 'compare/$OPENLIVE_RELEASE_TAG...$GITHUB_SHA' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not compare repeated release inputs"
grep -qF 'Release inputs changed without incrementing OCVM_VERSION.' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not reject unversioned release-input changes"
grep -qF '.draft == false and .prerelease == false' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not reject draft or prerelease no-ops"
grep -qF 'index($adapter) != null and index("SHA256SUMS") != null' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not verify existing release assets"
grep -qF 'gh release download "$OPENLIVE_RELEASE_TAG"' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not download existing assets for verification"
grep -qF '! cmp "$state_dir/assets/opencode-vm.sh" opencode-vm.sh' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not compare the published and candidate scripts"
grep -qF 'sha256sum -c SHA256SUMS' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not verify the published adapter checksum"
grep -qF 'elif grep -q '\''(HTTP 404)'\'' "$error_file"; then' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not distinguish missing releases from API failures"
grep -qF 'gh release create "$OPENLIVE_RELEASE_TAG"' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not create the version-derived tag"
grep -qF -- '-f ref="refs/tags/$OPENLIVE_RELEASE_TAG" -f sha="$GITHUB_SHA"' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not bind an automatic tag to the validated commit"
grep -qF -- '--verify-tag --generate-notes' "$RELEASE_WORKFLOW" ||
  fail "release workflow does not verify the explicit tag before publication"
assert_eq "$(grep -cF "if: steps.state.outputs.release_needed == 'true'" "$RELEASE_WORKFLOW")" "6"
pass "main pushes create missing version tags and releases after validation"

MOCK_BIN="$TMP/bin"
mkdir -p "$MOCK_BIN"
ln -s "$ROOT/tests/helpers/mock-limactl" "$MOCK_BIN/limactl"

cat > "$MOCK_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Darwin\n'
EOF
cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
payload=""
output=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--data-binary" ]]; then shift; payload="${1:-}"; fi
  if [[ "$1" == "--output" ]]; then shift; output="${1:-}"; fi
  shift || true
done
if [[ -n "${MOCK_ADAPTER_ASSET:-}" && -n "$output" ]]; then
  cp "$MOCK_ADAPTER_ASSET" "$output"
  exit 0
fi
if [[ -n "${MOCK_OPENLIVE_API_FILE:-}" ]]; then
  if [[ -n "$payload" ]]; then printf '%s\n' "$payload" > "$MOCK_OPENLIVE_API_FILE"; fi
  printf '%s\n' "$(<"$MOCK_OPENLIVE_API_FILE")"
  exit 0
fi
exit 1
EOF
cat > "$MOCK_BIN/md5" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
printf 'openlive-test-hash\n'
EOF
cat > "$MOCK_BIN/mv" <<'EOF'
#!/usr/bin/env bash
last=""
for last in "$@"; do :; done
if [[ -n "${MOCK_MV_FAIL_PATTERN:-}" && "$last" == *"$MOCK_MV_FAIL_PATTERN"* ]]; then
  exit 1
fi
exec /bin/mv "$@"
EOF
chmod +x "$MOCK_BIN/uname" "$MOCK_BIN/curl" "$MOCK_BIN/md5" "$MOCK_BIN/mv"

export PATH="$MOCK_BIN:/usr/local/bin:/usr/bin:/bin"
export MOCK_LIMACTL_LOG="$TMP/limactl.log"
export MOCK_LIMA_VM="oc-openlive-test"
: > "$MOCK_LIMACTL_LOG"

HOME_ONE="$TMP/home-one"
mkdir -p "$HOME_ONE"
HOME="$HOME_ONE" bash "$SCRIPT" openlive install >"$TMP/install.out" 2>"$TMP/install.err"
SHIM="$HOME_ONE/.opencode-vm/openlive/bin/opencode"
SETTINGS="$HOME_ONE/Library/Application Support/OpenLive/data/settings.json"
AUTH="$HOME_ONE/.local/share/opencode/auth.json"
assert_file "$SHIM"
assert_file "$SETTINGS"
assert_file "$AUTH"
[[ -L "$HOME_ONE/bin/opencode" ]] || fail "managed discovery link missing"
assert_eq "$(jq -r '.["acpCommand:opencode"]' "$SETTINGS")" "$SHIM acp"
jq -e '.__opencode_vm_openlive__ == {"type":"api","key":"opencode-vm-openlive-readiness-v1"}' "$AUTH" >/dev/null ||
  fail "readiness marker missing or unexpected"
assert_eq "$(HOME="$HOME_ONE" "$SHIM" --version)" "opencode-vm OpenLive bridge 0.5.47"
pass "install creates the managed shim, setting, discovery link, and non-secret marker"

STANDALONE_DIR="$TMP/standalone"
HOME_STANDALONE="$TMP/home-standalone"
mkdir -p "$STANDALONE_DIR" "$HOME_STANDALONE"
cp "$SCRIPT" "$STANDALONE_DIR/opencode-vm"
chmod +x "$STANDALONE_DIR/opencode-vm"
# Skills transport has its own fixture tests; adapter tests must stay offline.
cp -R "$ROOT/skills" "$STANDALONE_DIR/skills"
export MOCK_ADAPTER_ASSET="$ARTIFACT"
HOME="$HOME_STANDALONE" bash "$STANDALONE_DIR/opencode-vm" openlive install \
  >"$TMP/standalone-install.out" 2>"$TMP/standalone-install.err"
STANDALONE_CACHE="$HOME_STANDALONE/.opencode-vm/openlive/adapters/0.1.5-$ADAPTER_SHA"
assert_file "$STANDALONE_CACHE/dist/main.js"
assert_file "$STANDALONE_CACHE/dist/remote/client.js"
assert_file "$STANDALONE_CACHE/dist/remote/server.js"
assert_file "$STANDALONE_CACHE/manager/tool.mjs"
jq -e '.schema == 1 and .adapterVersion == "0.1.5" and .remoteProtocol == "ocvm-openlive.v1"' "$STANDALONE_CACHE/manifest.json" >/dev/null ||
  fail "standalone adapter manifest is missing or invalid"
HOME="$HOME_STANDALONE" bash "$STANDALONE_DIR/opencode-vm" openlive status \
  >"$TMP/standalone-status.out" || true
grep -q '0.1.5 (installed release)' "$TMP/standalone-status.out" ||
  fail "standalone adapter status is not reported"
HOME="$HOME_STANDALONE" bash "$STANDALONE_DIR/opencode-vm" openlive install \
  >"$TMP/standalone-reinstall.out" 2>"$TMP/standalone-reinstall.err"
grep -q 'already installed' "$TMP/standalone-reinstall.out" ||
  fail "standalone adapter reinstall is not idempotent"
STANDALONE_STUB="$TMP/standalone-remote-stub"
mkdir -p "$STANDALONE_STUB"
STANDALONE_REMOTE="$HOME_STANDALONE/.opencode-vm/project-state/openlive-test-hash"
STANDALONE_REMOTE_TWO="$HOME_STANDALONE/.opencode-vm/project-state/migration-test-two"
mkdir -p "$STANDALONE_REMOTE"
mkdir -p "$STANDALONE_REMOTE_TWO"
chmod 700 "$STANDALONE_REMOTE" "$STANDALONE_REMOTE_TWO"
jq -n --arg localProject "$STANDALONE_STUB" '{schema:1,protocol:"ocvm-openlive.v1",
  localProject:$localProject,origin:"https://127.0.0.1:1",projectId:"migration-project",
  displayName:"Migration project",username:"opencode",password:"test-only-password",
  nodePath:"old",clientPath:"old",adapterVersion:"0.1.3",adapterSha256:"old"}' \
  > "$STANDALONE_REMOTE/openlive-remote.json"
cp "$STANDALONE_REMOTE/openlive-remote.json" "$STANDALONE_REMOTE_TWO/openlive-remote.json"
chmod 600 "$STANDALONE_REMOTE/openlive-remote.json" "$STANDALONE_REMOTE_TWO/openlive-remote.json"
rm -rf "$STANDALONE_CACHE"
PATH="$MOCK_BIN:$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin" HOME="$HOME_STANDALONE" \
  bash "$STANDALONE_DIR/opencode-vm" \
  --post-update-migrate 0.5.44 0.5.45 >"$TMP/standalone-migrate.out"
assert_file "$STANDALONE_CACHE/dist/main.js"
grep -q 'Updating remote OpenLive runtimes' "$TMP/standalone-migrate.out" ||
  fail "script update did not refresh remote OpenLive runtimes"
for migrated in "$STANDALONE_REMOTE/openlive-remote.json" "$STANDALONE_REMOTE_TWO/openlive-remote.json"; do
  jq -e --arg version "0.1.5" --arg sha "$ADAPTER_SHA" \
    '.adapterVersion == $version and .adapterSha256 == $sha and
     .projectId == "migration-project" and .password == "test-only-password" and
     (.nodePath | type == "string" and length > 0) and (.clientPath | endswith("/dist/remote/client.js"))' \
    "$migrated" >/dev/null || fail "script update did not bind every remote mapping to the refreshed adapter"
done
: > "$MOCK_LIMACTL_LOG"
if PATH="$MOCK_BIN:$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin" HOME="$HOME_STANDALONE" \
  bash "$STANDALONE_DIR/opencode-vm" openlive acp "$STANDALONE_STUB" \
  >"$TMP/migrated-acp.out" 2>"$TMP/migrated-acp.err"; then
  fail "unreachable migrated remote mapping unexpectedly connected"
fi
[[ ! -s "$MOCK_LIMACTL_LOG" ]] || fail "migrated remote mapping fell back to Lima"
if grep -q 'mapping is invalid\|runtime is missing' "$TMP/migrated-acp.err"; then
  fail "migrated mapping is not dispatchable"
fi
pass "script updates refresh installed adapters and version-bound remote mappings"
MIGRATION_BAD="$HOME_STANDALONE/.opencode-vm/project-state/aaa-invalid"
MIGRATION_GOOD="$HOME_STANDALONE/.opencode-vm/project-state/zzz-valid"
mkdir -p "$MIGRATION_BAD" "$MIGRATION_GOOD"
chmod 700 "$MIGRATION_BAD" "$MIGRATION_GOOD"
printf '{}\n' > "$MIGRATION_BAD/openlive-remote.json"
jq '.adapterVersion = "0.1.3" | .adapterSha256 = "old"' \
  "$STANDALONE_REMOTE/openlive-remote.json" > "$MIGRATION_GOOD/openlive-remote.json"
chmod 600 "$MIGRATION_BAD/openlive-remote.json" "$MIGRATION_GOOD/openlive-remote.json"
if PATH="$MOCK_BIN:$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin" HOME="$HOME_STANDALONE" \
  bash "$STANDALONE_DIR/opencode-vm" --post-update-migrate 0.5.44 0.5.45 \
  >"$TMP/mixed-migrate.out" 2>"$TMP/mixed-migrate.err"; then
  fail "migration with an invalid mapping should report failure"
fi
jq -e --arg version "0.1.5" --arg sha "$ADAPTER_SHA" \
  '.adapterVersion == $version and .adapterSha256 == $sha' \
  "$MIGRATION_GOOD/openlive-remote.json" >/dev/null ||
  fail "an invalid mapping blocked migration of a later healthy mapping"
rm -f "$MIGRATION_BAD/openlive-remote.json" "$MIGRATION_GOOD/openlive-remote.json"
pass "mapping migration reports bad records after refreshing all healthy mappings"
grep -A8 'post-update migration hook reported an issue' "$SCRIPT" | grep -q 'return 1' ||
  fail "script update does not fail when adapter migration fails"
rm -f "$STANDALONE_REMOTE/openlive-remote.json"
rm -f "$STANDALONE_REMOTE_TWO/openlive-remote.json"
HOME="$HOME_STANDALONE" bash "$STANDALONE_DIR/opencode-vm" openlive uninstall \
  >"$TMP/standalone-uninstall.out"
[[ ! -e "$HOME_STANDALONE/.opencode-vm/openlive/adapters" ]] ||
  fail "standalone adapter cache survived uninstall"
pass "standalone script downloads, verifies, reports, reuses, and removes the adapter"

CORRUPT_ARTIFACT="$TMP/corrupt-openlive-adapter.tar"
cp "$ARTIFACT" "$CORRUPT_ARTIFACT"
printf 'corrupt' >> "$CORRUPT_ARTIFACT"
HOME_CORRUPT="$TMP/home-corrupt"
mkdir -p "$HOME_CORRUPT"
export MOCK_ADAPTER_ASSET="$CORRUPT_ARTIFACT"
if HOME="$HOME_CORRUPT" bash "$STANDALONE_DIR/opencode-vm" openlive install \
  >"$TMP/corrupt-install.out" 2>"$TMP/corrupt-install.err"; then
  fail "adapter checksum mismatch should fail installation"
fi
[[ ! -e "$HOME_CORRUPT/.opencode-vm/openlive/bin/opencode" ]] ||
  fail "checksum failure left an OpenLive shim"
[[ ! -e "$HOME_CORRUPT/Library/Application Support/OpenLive/data/settings.json" ]] ||
  fail "checksum failure changed OpenLive settings"
grep -q 'checksum mismatch' "$TMP/corrupt-install.err" ||
  fail "checksum failure is not actionable"
unset MOCK_ADAPTER_ASSET
pass "adapter checksum failure is side-effect free"

UNSAFE_STAGE="$TMP/unsafe-stage"
UNSAFE_ARTIFACT="$TMP/unsafe-openlive-adapter.tar"
UNSAFE_SCRIPT="$STANDALONE_DIR/opencode-vm-unsafe"
mkdir -p "$UNSAFE_STAGE"
tar -xf "$ARTIFACT" -C "$UNSAFE_STAGE"
ln -s /tmp/not-allowed "$UNSAFE_STAGE/opencode-vm-openlive-adapter-0.1.5/unsafe-link"
tar -cf "$UNSAFE_ARTIFACT" -C "$UNSAFE_STAGE" opencode-vm-openlive-adapter-0.1.5
UNSAFE_SHA="$(sha256sum "$UNSAFE_ARTIFACT" | awk '{ print $1 }')"
perl -pe "s/$ADAPTER_SHA/$UNSAFE_SHA/g" "$STANDALONE_DIR/opencode-vm" > "$UNSAFE_SCRIPT"
chmod +x "$UNSAFE_SCRIPT"
HOME_UNSAFE="$TMP/home-unsafe"
mkdir -p "$HOME_UNSAFE"
export MOCK_ADAPTER_ASSET="$UNSAFE_ARTIFACT"
if HOME="$HOME_UNSAFE" bash "$UNSAFE_SCRIPT" openlive install \
  >"$TMP/unsafe-install.out" 2>"$TMP/unsafe-install.err"; then
  fail "adapter archive links should fail installation"
fi
[[ ! -e "$HOME_UNSAFE/.opencode-vm/openlive/bin/opencode" ]] ||
  fail "unsafe archive left an OpenLive shim"
grep -q 'contains a link or unsupported entry' "$TMP/unsafe-install.err" ||
  fail "unsafe archive failure is not actionable"
unset MOCK_ADAPTER_ASSET
pass "adapter archives containing links are rejected before extraction"

HOME_ACTIVATE="$TMP/home-activate-failure"
mkdir -p "$HOME_ACTIVATE"
export MOCK_ADAPTER_ASSET="$ARTIFACT"
export MOCK_MV_FAIL_PATTERN="/openlive/adapters/0.1.5-$ADAPTER_SHA"
if HOME="$HOME_ACTIVATE" bash "$STANDALONE_DIR/opencode-vm" openlive install \
  >"$TMP/activate-install.out" 2>"$TMP/activate-install.err"; then
  fail "adapter activation failure should fail installation"
fi
[[ ! -e "$HOME_ACTIVATE/.opencode-vm/openlive/bin/opencode" ]] ||
  fail "activation failure left an OpenLive shim"
[[ ! -e "$HOME_ACTIVATE/.opencode-vm/openlive/adapters/0.1.5-$ADAPTER_SHA" ]] ||
  fail "activation failure left an adapter cache"
grep -q 'Could not activate the downloaded adapter' "$TMP/activate-install.err" ||
  fail "activation failure is not actionable"
unset MOCK_MV_FAIL_PATTERN MOCK_ADAPTER_ASSET
pass "adapter activation failure is reported without partial installation"

HOME_TRANSACTION="$TMP/home-transaction-failure"
mkdir -p "$HOME_TRANSACTION"
export MOCK_MV_FAIL_PATTERN="Library/Application Support/OpenLive/data/settings.json"
if HOME="$HOME_TRANSACTION" bash "$SCRIPT" openlive install \
  >"$TMP/transaction-install.out" 2>"$TMP/transaction-install.err"; then
  fail "OpenLive settings failure should fail installation"
fi
[[ ! -e "$HOME_TRANSACTION/.opencode-vm/openlive/bin/opencode" ]] ||
  fail "settings failure left an OpenLive shim"
[[ ! -L "$HOME_TRANSACTION/bin/opencode" ]] ||
  fail "settings failure left a discovery link"
assert_eq "$(jq 'length' "$HOME_TRANSACTION/.local/share/opencode/auth.json")" "0"
grep -q 'Could not install the OpenLive settings update' "$TMP/transaction-install.err" ||
  fail "settings failure is not actionable"
unset MOCK_MV_FAIL_PATTERN
pass "host integration rolls back when a later installation step fails"

if grep -qF "'{schema:1,project:\$project" "$SCRIPT"; then
  fail "runtime descriptor jq filter breaks the enclosing guest-script quote"
fi
assert_eq "$(grep -cF 'project:\$project,backendUrl:\$url,generation:\$generation' "$SCRIPT")" "2"
pass "runtime descriptor filters preserve jq variables inside both guest scripts"

assert_eq "$(grep -cF 'OC_OPENLIVE_PROJECT_HASH="${12:-}"' "$SCRIPT")" "2"
assert_eq "$(perl -0ne 'while (/OC_LAN_UP="\$\{11:-1\}"\n    OC_OPENLIVE_PROJECT_HASH="\$\{12:-\}"/g) { $n++ } END { print $n // 0 }' "$SCRIPT")" "2"
pass "fresh and resumed web starts receive the OpenLive project identity"

if grep -qF 'src/main.ts" -nt "$adapter/dist/main.js' "$SCRIPT"; then
  fail "adapter build freshness checks only main.ts"
fi
assert_eq "$(grep -cF '( cd "$adapter" && npm run build --silent )' "$SCRIPT")" "2"
assert_eq "$(grep -cF '( cd "$adapter" && npm run build --silent ) || return 1' "$SCRIPT")" "2"
assert_eq "$(grep -cF 'if ! prepare_openlive_adapter; then' "$SCRIPT")" "2"
pass "fresh and resumed web starts always rebuild staged adapter sources"

assert_eq "$(grep -cF 'npm ci --omit=dev --ignore-scripts' "$SCRIPT")" "3"
pass "fresh and resumed web starts use packaged adapter runtime output"

assert_eq "$(grep -cF 'rsync -a --checksum --delete' "$SCRIPT")" "2"
assert_eq "$(grep -cF 'mode="release-$(cat "$adapter/.archive-sha256")"' "$SCRIPT")" "2"
assert_eq "$(grep -cF 'awk "{print \$1}"' "$SCRIPT")" "2"
RSYNC_SOURCE="$TMP/rsync-source"
RSYNC_TARGET="$TMP/rsync-target"
mkdir -p "$RSYNC_SOURCE" "$RSYNC_TARGET"
printf 'new' > "$RSYNC_SOURCE/main.js"
printf 'old' > "$RSYNC_TARGET/main.js"
touch -t 200001010000 "$RSYNC_SOURCE/main.js" "$RSYNC_TARGET/main.js"
rsync -a --checksum "$RSYNC_SOURCE/" "$RSYNC_TARGET/"
assert_eq "$(<"$RSYNC_TARGET/main.js")" "new"
pass "release restaging replaces same-size files even when timestamps match"

assert_eq "$(grep -cF 'if openlive_adapter_present; then' "$SCRIPT")" "2"
assert_eq "$(grep -cF '[ -f "$adapter/package-lock.json" ] || return 0' "$SCRIPT")" "2"
assert_eq "$(grep -cF 'openlive_unstage_adapter "$openlive_share"' "$SCRIPT")" "3"
assert_eq "$(grep -cF 'openlive_unstage_adapter "$sess_share"' "$SCRIPT")" "3"
if grep -qF '[[ "$sess_mode" == "web" ]] && openlive_adapter_present' "$SCRIPT" ||
  grep -qF '[[ "$SESSION_MODE" == "web" ]] && openlive_adapter_present' "$SCRIPT"; then
  fail "OpenLive availability gates unrelated web-mode setup"
fi
pass "web sessions remain available when the optional OpenLive bridge is not installed"

grep -qF 'echo "[run] Session command failed."' "$SCRIPT" ||
  fail "fresh session guest failures are still masked"
pass "fresh session guest preparation failures propagate to the host command"

grep -qF 'tools/voice_sessions.js' "$SCRIPT" ||
  fail "voice_sessions is not staged through OpenCode's custom-tool directory"
if grep -qF 'cp -p "$source/src/manager/plugin.mjs"' "$SCRIPT"; then
  fail "voice_sessions is still staged as a server plugin"
fi
pass "voice_sessions uses OpenCode's direct custom-tool discovery"

perl -0ne 'exit 0 if /"mode": "primary",\s+"hidden": true,\s+"prompt": \$prompt/; exit 1' "$SCRIPT" ||
  fail "OpenLive manager is visible in the normal primary-agent selector"
pass "OpenLive manager stays directly addressable without appearing as a user mode"

grep -qF 'callerMessageId: context.messageID' "$ROOT/adapters/openlive-acp/src/manager/tool.mjs" ||
  fail "voice_sessions does not identify its calling manager message"
grep -qF 'sessionCapabilities: { close: {} }' "$ROOT/adapters/openlive-acp/src/acp/transport.ts" ||
  fail "ACP does not advertise implemented session close support"
pass "manager controls are turn-bound and ACP close is advertised"

grep -qF 'image: true' "$ROOT/adapters/openlive-acp/src/acp/transport.ts" ||
  fail "ACP does not advertise implemented OpenLive screen-frame support"
grep -qF 'data:${image.mimeType};base64,${image.data}' "$ROOT/adapters/openlive-acp/src/opencode/gateway.ts" ||
  fail "OpenLive screen frames are not forwarded to OpenCode"
pass "OpenLive JPEG screen frames are advertised and forwarded"

HOME="$HOME_ONE" bash "$SCRIPT" openlive install >"$TMP/reinstall.out" 2>"$TMP/reinstall.err"
assert_eq "$(jq 'length' "$AUTH")" "1"
pass "install is idempotent"

HOME="$HOME_ONE" bash "$SCRIPT" openlive uninstall >"$TMP/uninstall.out"
[[ ! -e "$SHIM" ]] || fail "shim survived uninstall"
[[ ! -L "$HOME_ONE/bin/opencode" ]] || fail "managed discovery link survived uninstall"
assert_eq "$(jq 'length' "$AUTH")" "0"
assert_eq "$(jq -r '.["acpCommand:opencode"] // empty' "$SETTINGS")" ""
pass "uninstall removes only managed integration state"

jq -n '{"acpCommand:opencode":"/usr/local/bin/custom-agent"}' > "$SETTINGS"
HOME="$HOME_ONE" bash "$SCRIPT" openlive install --force >"$TMP/force.out" 2>"$TMP/force.err"
HOME="$HOME_ONE" bash "$SCRIPT" openlive uninstall >"$TMP/force-uninstall.out"
assert_eq "$(jq -r '.["acpCommand:opencode"]' "$SETTINGS")" "/usr/local/bin/custom-agent"
pass "forced install restores the previous OpenLive command on uninstall"

HOME_ROLLBACK="$TMP/home-force-rollback"
ROLLBACK_SETTINGS="$HOME_ROLLBACK/Library/Application Support/OpenLive/data/settings.json"
mkdir -p "$(dirname "$ROLLBACK_SETTINGS")"
jq -n '{"acpCommand:opencode":"/usr/local/bin/agent-a"}' > "$ROLLBACK_SETTINGS"
HOME="$HOME_ROLLBACK" bash "$SCRIPT" openlive install --force \
  >"$TMP/rollback-first.out" 2>"$TMP/rollback-first.err"
jq '. + {"acpCommand:opencode":"/usr/local/bin/agent-b"}' "$ROLLBACK_SETTINGS" > "$TMP/rollback-settings.json"
/bin/mv "$TMP/rollback-settings.json" "$ROLLBACK_SETTINGS"
export MOCK_MV_FAIL_PATTERN="/.opencode-vm/openlive/bin/opencode"
if HOME="$HOME_ROLLBACK" bash "$SCRIPT" openlive install --force \
  >"$TMP/rollback-second.out" 2>"$TMP/rollback-second.err"; then
  fail "shim activation failure should fail forced reinstall"
fi
unset MOCK_MV_FAIL_PATTERN
assert_eq "$(jq -r '.["acpCommand:opencode"]' "$ROLLBACK_SETTINGS")" "/usr/local/bin/agent-b"
assert_eq "$(<"$HOME_ROLLBACK/.opencode-vm/openlive/previous-command")" "/usr/local/bin/agent-a"
grep -qFx '# opencode-vm-openlive-shim-v1' "$HOME_ROLLBACK/.opencode-vm/openlive/bin/opencode" ||
  fail "failed forced reinstall replaced the existing managed shim"
pass "failed forced reinstall restores the immediately previous command"

HOME_REFUSE="$TMP/home-refuse"
mkdir -p "$HOME_REFUSE/Library/Application Support/OpenLive/data"
jq -n '{"acpCommand:opencode":"/usr/local/bin/custom-agent --token=secret"}' > \
  "$HOME_REFUSE/Library/Application Support/OpenLive/data/settings.json"
if HOME="$HOME_REFUSE" bash "$SCRIPT" openlive install >"$TMP/refuse.out" 2>"$TMP/refuse.err"; then
  fail "foreign command should require --force"
fi
[[ ! -e "$HOME_REFUSE/.opencode-vm/openlive/bin/opencode" ]] || fail "refused install left a shim"
[[ ! -e "$HOME_REFUSE/.local/share/opencode/auth.json" ]] || fail "refused install left an auth marker"
if grep -q 'token=secret' "$TMP/refuse.err"; then fail "foreign command secret leaked to diagnostics"; fi
pass "non-forced install is side-effect free and redacts a foreign command"

HOME_TWO="$TMP/home-two"
mkdir -p "$HOME_TWO/bin" "$HOME_TWO/.local/share/opencode"
printf '#!/bin/sh\nexit 0\n' > "$HOME_TWO/bin/opencode"
chmod +x "$HOME_TWO/bin/opencode"
jq -n '{openai:{type:"api",key:"real-secret-placeholder"}}' > "$HOME_TWO/.local/share/opencode/auth.json"
HOME="$HOME_TWO" bash "$SCRIPT" openlive install >"$TMP/foreign.out" 2>"$TMP/foreign.err"
[[ ! -L "$HOME_TWO/bin/opencode" ]] || fail "foreign opencode was replaced"
assert_eq "$(jq -r '.openai.key' "$HOME_TWO/.local/share/opencode/auth.json")" "real-secret-placeholder"
jq -e 'has("__opencode_vm_openlive__") | not' "$HOME_TWO/.local/share/opencode/auth.json" >/dev/null ||
  fail "marker was added despite real auth data"
pass "install preserves foreign binaries and existing auth data"

HOME_OWNERSHIP="$TMP/home-ownership"
mkdir -p "$HOME_OWNERSHIP"
HOME="$HOME_OWNERSHIP" bash "$SCRIPT" openlive install >"$TMP/ownership-install.out" 2>"$TMP/ownership-install.err"
printf '#!/bin/sh\nprintf external-replacement\n' > "$HOME_OWNERSHIP/.opencode-vm/openlive/bin/opencode"
chmod +x "$HOME_OWNERSHIP/.opencode-vm/openlive/bin/opencode"
HOME="$HOME_OWNERSHIP" bash "$SCRIPT" openlive uninstall >"$TMP/ownership-uninstall.out" 2>"$TMP/ownership-uninstall.err"
assert_file "$HOME_OWNERSHIP/.opencode-vm/openlive/bin/opencode"
assert_eq "$(HOME="$HOME_OWNERSHIP" "$HOME_OWNERSHIP/.opencode-vm/openlive/bin/opencode")" "external-replacement"
pass "uninstall preserves a replaced shim"

if HOME="$HOME_OWNERSHIP" bash "$SCRIPT" openlive install >"$TMP/ownership-reinstall.out" 2>"$TMP/ownership-reinstall.err"; then
  fail "reinstall should not replace an externally owned shim"
fi
assert_eq "$(HOME="$HOME_OWNERSHIP" "$HOME_OWNERSHIP/.opencode-vm/openlive/bin/opencode")" "external-replacement"
pass "reinstall refuses to overwrite a replaced shim"

HOME_API="$TMP/home-api"
API_SETTINGS="$TMP/api-settings.json"
mkdir -p "$HOME_API"
printf '{}\n' > "$API_SETTINGS"
export MOCK_OPENLIVE_API_FILE="$API_SETTINGS"
HOME="$HOME_API" bash "$SCRIPT" openlive install >"$TMP/api-install.out" 2>"$TMP/api-install.err"
assert_eq "$(jq -r '.["acpCommand:opencode"]' "$API_SETTINGS")" "$HOME_API/.opencode-vm/openlive/bin/opencode acp"
[[ ! -f "$HOME_API/Library/Application Support/OpenLive/data/settings.json" ]] || fail "live API install also wrote offline settings"
HOME="$HOME_API" bash "$SCRIPT" openlive uninstall >"$TMP/api-uninstall.out" 2>"$TMP/api-uninstall.err"
assert_eq "$(jq -r '.["acpCommand:opencode"]' "$API_SETTINGS")" ""
unset MOCK_OPENLIVE_API_FILE
pass "running OpenLive settings are updated through its local API"

HOME_SPACE="$TMP/home with space"
mkdir -p "$HOME_SPACE"
if HOME="$HOME_SPACE" bash "$SCRIPT" openlive install >"$TMP/space-home.out" 2>"$TMP/space-home.err"; then
  fail "whitespace home path should be rejected for OpenLive 0.2.7"
fi
pass "unsupported whitespace in the shim path fails clearly"

ACP_INITIALIZE='{"jsonrpc":"2.0","id":1,"method":"initialize"}'
HOME_REMOTE="$TMP/home-remote"
REMOTE_STUB="$TMP/remote stub"
REMOTE_STATE="$HOME_REMOTE/.opencode-vm/project-state/openlive-test-hash"
REMOTE_NODE="$TMP/remote-node"
REMOTE_CLIENT="$ROOT/adapters/openlive-acp/dist/remote/client.js"
mkdir -p "$HOME_REMOTE" "$REMOTE_STUB" "$REMOTE_STATE"
chmod 700 "$REMOTE_STATE"
cat > "$REMOTE_NODE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MOCK_REMOTE_NODE_LOG:?}"
IFS= read -r line
printf '%s\n' "$line"
EOF
chmod +x "$REMOTE_NODE"
jq -n --arg localProject "$REMOTE_STUB" --arg nodePath "$REMOTE_NODE" \
  --arg clientPath "$REMOTE_CLIENT" --arg adapterSha "$ADAPTER_SHA" '{schema:1,protocol:"ocvm-openlive.v1",
    localProject:$localProject,origin:"https://remote.example:4096",projectId:"remote-project",
    displayName:"Remote project",username:"opencode",password:"secret",
    nodePath:$nodePath,clientPath:$clientPath,adapterVersion:"0.1.5",
    adapterSha256:$adapterSha}' > "$REMOTE_STATE/openlive-remote.json"
chmod 600 "$REMOTE_STATE/openlive-remote.json"
export MOCK_REMOTE_NODE_LOG="$TMP/remote-node.log"
: > "$MOCK_REMOTE_NODE_LOG"
: > "$MOCK_LIMACTL_LOG"
printf '%s\n' "$ACP_INITIALIZE" | HOME="$HOME_REMOTE" bash "$SCRIPT" openlive acp "$REMOTE_STUB" \
  >"$TMP/remote-acp.out" 2>"$TMP/remote-acp.err"
assert_eq "$(<"$TMP/remote-acp.out")" "$ACP_INITIALIZE"
[[ ! -s "$MOCK_LIMACTL_LOG" ]] || fail "remote ACP dispatch consulted Lima"
grep -qF "$REMOTE_CLIENT $REMOTE_STATE/openlive-remote.json $REMOTE_STUB" "$MOCK_REMOTE_NODE_LOG" ||
  fail "remote ACP dispatch did not use the mapped client runtime"
pass "remote ACP dispatch needs neither a local VM nor Lima lifecycle access"

chmod 644 "$REMOTE_STATE/openlive-remote.json"
: > "$MOCK_LIMACTL_LOG"
if HOME="$HOME_REMOTE" bash "$SCRIPT" openlive acp "$REMOTE_STUB" \
  >"$TMP/public-remote.out" 2>"$TMP/public-remote.err"; then
  fail "non-private remote mapping should fail"
fi
[[ ! -s "$MOCK_LIMACTL_LOG" ]] || fail "non-private remote mapping fell back to Lima"
grep -q 'mapping is invalid' "$TMP/public-remote.err" || fail "non-private mapping error is not actionable"
chmod 600 "$REMOTE_STATE/openlive-remote.json"

printf '{}\n' > "$REMOTE_STATE/openlive-remote.json"
: > "$MOCK_LIMACTL_LOG"
if HOME="$HOME_REMOTE" bash "$SCRIPT" openlive acp "$REMOTE_STUB" \
  >"$TMP/invalid-remote.out" 2>"$TMP/invalid-remote.err"; then
  fail "invalid remote mapping should fail"
fi
[[ ! -s "$MOCK_LIMACTL_LOG" ]] || fail "invalid remote mapping fell back to Lima"
[[ ! -s "$TMP/invalid-remote.out" ]] || fail "invalid remote mapping polluted ACP stdout"
grep -q 'mapping is invalid' "$TMP/invalid-remote.err" || fail "invalid mapping error is not actionable"
HOME="$HOME_REMOTE" bash "$SCRIPT" openlive remote --remove "$REMOTE_STUB" >"$TMP/remote-remove.out"
[[ ! -e "$REMOTE_STATE/openlive-remote.json" ]] || fail "remote mapping survived removal"
mkdir -p "$REMOTE_STATE"
chmod 700 "$REMOTE_STATE"
ln -s "$TMP/missing-remote-mapping" "$REMOTE_STATE/openlive-remote.json"
: > "$MOCK_LIMACTL_LOG"
if HOME="$HOME_REMOTE" bash "$SCRIPT" openlive acp "$REMOTE_STUB" \
  >"$TMP/dangling-remote.out" 2>"$TMP/dangling-remote.err"; then
  fail "dangling remote mapping should fail"
fi
[[ ! -s "$MOCK_LIMACTL_LOG" ]] || fail "dangling remote mapping fell back to Lima"
HOME="$HOME_REMOTE" bash "$SCRIPT" openlive remote --remove "$REMOTE_STUB" >/dev/null
[[ ! -L "$REMOTE_STATE/openlive-remote.json" ]] || fail "dangling remote mapping survived removal"
pass "invalid remote mappings fail closed and removal is idempotent"

SETUP_HOME="$TMP/home-remote-setup"
SETUP_STUB="$TMP/setup stub"
SETUP_APP="$TMP/OpenLive.app"
SETUP_BIN="$TMP/setup-bin"
SETUP_STATE="$TMP/setup-server.state"
SETUP_CERT="$TMP/setup-cert.pem"
SETUP_KEY="$TMP/setup-key.pem"
mkdir -p "$SETUP_HOME" "$SETUP_STUB" "$SETUP_APP" "$SETUP_BIN"
ln -s "$MOCK_BIN/uname" "$SETUP_BIN/uname"
ln -s "$MOCK_BIN/md5" "$SETUP_BIN/md5"
ln -s /usr/bin/curl "$SETUP_BIN/curl"
"$NODE_BIN" "$ROOT/tests/helpers/remote-setup-server.mjs" "$SETUP_CERT" "$SETUP_KEY" "$SETUP_STATE" \
  "$ROOT/adapters/openlive-acp/node_modules/ws/wrapper.mjs" >"$TMP/setup-server.out" 2>"$TMP/setup-server.err" &
SETUP_SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [[ -s "$SETUP_STATE" ]] && break
  sleep 0.1
done
assert_file "$SETUP_STATE"
SETUP_PORT="$(sed -n '1p' "$SETUP_STATE")"
SETUP_FINGERPRINT="$(sed -n '2p' "$SETUP_STATE")"
SETUP_PATH="$SETUP_BIN:$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
if ! PATH="$SETUP_PATH" HOME="$SETUP_HOME" OCVM_OPENLIVE_APP_PATH="$SETUP_APP" \
  OCVM_OPENLIVE_REMOTE_PASSWORD=remote-password-42 \
  bash "$SCRIPT" openlive remote --stub "$SETUP_STUB" \
  --url "https://127.0.0.1:$SETUP_PORT" --username opencode \
  --fingerprint "$SETUP_FINGERPRINT" --yes >"$TMP/remote-setup.out" 2>"$TMP/remote-setup.err"; then
  kill "$SETUP_SERVER_PID" 2>/dev/null || true
  wait "$SETUP_SERVER_PID" 2>/dev/null || true
  fail "transactional remote setup failed: $(<"$TMP/remote-setup.err")"
fi
kill "$SETUP_SERVER_PID" 2>/dev/null || true
wait "$SETUP_SERVER_PID" 2>/dev/null || true
SETUP_MAPPING="$SETUP_HOME/.opencode-vm/project-state/openlive-test-hash/openlive-remote.json"
assert_file "$SETUP_MAPPING"
jq -e --arg project "$SETUP_STUB" --arg fingerprint "$SETUP_FINGERPRINT" '
  .localProject == $project and .projectId == "setup-project-id" and
  .displayName == "Setup Remote" and .tlsFingerprint == $fingerprint and
  .password == "remote-password-42" and .adapterVersion == "0.1.5"
' "$SETUP_MAPPING" >/dev/null || fail "remote setup persisted the wrong mapping"
assert_eq "$(stat -c '%a' "$SETUP_MAPPING")" "600"
assert_eq "$(stat -c '%a' "$(dirname "$SETUP_MAPPING")")" "700"
if grep -qF 'remote-password-42' "$TMP/remote-setup.out" "$TMP/remote-setup.err"; then
  fail "remote setup leaked its password"
fi
if grep -q -- '--arg password' "$SCRIPT" || ! grep -qF -- '--rawfile password /dev/fd/9' "$SCRIPT"; then
  fail "remote setup passes its password through process arguments"
fi
pass "remote setup verifies TLS/auth/project/ACP before atomically saving a private mapping"

PIN_STATE="$TMP/pin-server.state"
PIN_CERT="$TMP/pin-cert.pem"
PIN_KEY="$TMP/pin-key.pem"
"$NODE_BIN" "$ROOT/tests/helpers/remote-setup-server.mjs" "$PIN_CERT" "$PIN_KEY" "$PIN_STATE" \
  "$ROOT/adapters/openlive-acp/node_modules/ws/wrapper.mjs" >"$TMP/pin-server.out" 2>"$TMP/pin-server.err" &
PIN_SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [[ -s "$PIN_STATE" ]] && break
  sleep 0.1
done
assert_file "$PIN_STATE"
PIN_PORT="$(sed -n '1p' "$PIN_STATE")"
MAPPING_BEFORE="$(sha256sum "$SETUP_MAPPING" | awk '{print $1}')"
if PATH="$SETUP_PATH" HOME="$SETUP_HOME" CURL_CA_BUNDLE="$PIN_CERT" \
  OCVM_OPENLIVE_APP_PATH="$SETUP_APP" OCVM_OPENLIVE_REMOTE_PASSWORD=remote-password-42 \
  bash "$SCRIPT" openlive remote --stub "$SETUP_STUB" --url "https://127.0.0.1:$PIN_PORT" \
  --fingerprint "$(printf '0%.0s' {1..64})" --yes >"$TMP/wrong-pin.out" 2>"$TMP/wrong-pin.err"; then
  kill "$PIN_SERVER_PID" 2>/dev/null || true
  wait "$PIN_SERVER_PID" 2>/dev/null || true
  fail "explicit fingerprint mismatch should fail for a CA-trusted certificate"
fi
kill "$PIN_SERVER_PID" 2>/dev/null || true
wait "$PIN_SERVER_PID" 2>/dev/null || true
grep -q 'fingerprint does not match' "$TMP/wrong-pin.err" || fail "explicit pin mismatch is not actionable"
assert_eq "$(sha256sum "$SETUP_MAPPING" | awk '{print $1}')" "$MAPPING_BEFORE"
pass "explicit TLS pins are enforced even when the certificate chain is trusted"

HOME_THREE="$TMP/home-three"
PROJECT="$TMP/project with spaces"
mkdir -p "$HOME_THREE/.opencode-vm/sessions/openlive-test-hash/config/opencode" \
  "$HOME_THREE/.opencode-vm/sessions/openlive-test-hash/xdg-data/opencode" \
  "$HOME_THREE/.opencode-vm/sessions/openlive-test-hash/xdg-state/opencode" \
  "$HOME_THREE/.opencode-vm/sessions/openlive-test-hash/openlive" "$PROJECT"
printf '{"schema":1,"project":"%s","backendUrl":"http://127.0.0.1:4095","generation":"test","opencodeVersion":"1.18.21"}\n' "$PROJECT" > \
  "$HOME_THREE/.opencode-vm/sessions/openlive-test-hash/openlive/runtime.json"
printf 'SESS_NAME=%q\nSESS_PROJ=%q\nSESS_MODE=web\n' "$MOCK_LIMA_VM" "$PROJECT" > \
  "$HOME_THREE/.opencode-vm/sessions/openlive-test-hash.env"

HOME="$HOME_THREE" bash "$SCRIPT" openlive acp "$PROJECT" >"$TMP/acp.out" 2>"$TMP/acp.err"
assert_eq "$(<"$TMP/acp.out")" '{"jsonrpc":"2.0","method":"test/openlive"}'
pass "ACP stdout contains only protocol data for a project path with spaces"

export MOCK_CONSUME_STDIN=1 MOCK_ECHO_STDIN=1
printf '%s\n' "$ACP_INITIALIZE" | HOME="$HOME_THREE" bash "$SCRIPT" openlive acp "$PROJECT" >"$TMP/stdin.out" 2>"$TMP/stdin.err"
assert_eq "$(<"$TMP/stdin.out")" "$ACP_INITIALIZE"
unset MOCK_CONSUME_STDIN MOCK_ECHO_STDIN
pass "VM preparation cannot consume OpenLive's buffered ACP initialize request"

export MOCK_LIMA_STATE="Stopped"
: > "$MOCK_LIMACTL_LOG"
if HOME="$HOME_THREE" bash "$SCRIPT" openlive acp "$PROJECT" >"$TMP/stopped.out" 2>"$TMP/stopped.err"; then
  fail "a stopped web runtime should be rejected"
fi
[[ ! -s "$TMP/stopped.out" ]] || fail "stopped-runtime error polluted ACP stdout"
grep -q "central web runtime is not running" "$TMP/stopped.err" || fail "stopped-runtime error is not actionable"
if grep -q '^start ' "$MOCK_LIMACTL_LOG" || grep -q '^stop ' "$MOCK_LIMACTL_LOG"; then
  fail "OpenLive must not change the web VM lifecycle"
fi
unset MOCK_LIMA_STATE
pass "a stopped web runtime is rejected without changing VM lifecycle"

export MOCK_ACP_SLEEP=30
: > "$MOCK_LIMACTL_LOG"
setsid env HOME="$HOME_THREE" bash "$SCRIPT" openlive acp "$PROJECT" >"$TMP/signal.out" 2>"$TMP/signal.err" &
BRIDGE_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if grep -q 'dist/main.js' "$MOCK_LIMACTL_LOG"; then break; fi
  sleep 0.1
done
kill -TERM -"$BRIDGE_PID"
set +e
wait "$BRIDGE_PID"
BRIDGE_RC=$?
set -e
assert_eq "$BRIDGE_RC" "143"
if grep -q '^stop ' "$MOCK_LIMACTL_LOG"; then fail "signal must not stop the central web VM"; fi
[[ ! -d "$HOME_THREE/.opencode-vm/openlive/locks/openlive-test-hash.lock" ]] || fail "signal left project lock behind"
unset MOCK_ACP_SLEEP
pass "OpenLive process-group termination releases its lock without stopping the web VM"

LOCK="$HOME_THREE/.opencode-vm/openlive/locks/openlive-test-hash.lock"
mkdir -p "$LOCK"
printf '%s\n' "$$" > "$LOCK/pid"
if HOME="$HOME_THREE" bash "$SCRIPT" openlive acp "$PROJECT" >"$TMP/locked.out" 2>"$TMP/locked.err"; then
  fail "concurrent ACP bridge should be rejected"
fi
[[ ! -s "$TMP/locked.out" ]] || fail "concurrency error polluted ACP stdout"
rm -f "$LOCK/pid"
rmdir "$LOCK"
pass "concurrent OpenLive conversations for one project are rejected"

if HOME="$HOME_THREE" bash "$SCRIPT" openlive acp "$TMP/missing-project" >"$TMP/missing.out" 2>"$TMP/missing.err"; then
  fail "missing project should fail"
fi
[[ ! -s "$TMP/missing.out" ]] || fail "missing-project error polluted ACP stdout"
pass "ACP startup errors stay off protocol stdout"

NEW_PROJECT="$TMP/new-project"
HOME_NEW="$TMP/home-new"
mkdir -p "$NEW_PROJECT" "$HOME_NEW"
if HOME="$HOME_NEW" bash "$SCRIPT" openlive acp "$NEW_PROJECT" >"$TMP/no-base.out" 2>"$TMP/no-base.err"; then
  fail "unprepared project should block first-use ACP"
fi
[[ ! -s "$TMP/no-base.out" ]] || fail "unprepared-project error polluted ACP stdout"
grep -q "opencode-vm web" "$TMP/no-base.err" || fail "missing web-runtime error is not actionable"
pass "first use requires a central web runtime outside the ACP handshake timeout"

python3 "$ROOT/tests/web_proxy_remote_test.py"
pass "the existing web port routes only exact remote OpenLive paths to the gateway"

printf 'OpenLive tests passed.\n'
