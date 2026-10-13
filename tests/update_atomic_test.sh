#!/usr/bin/env bash
# task_68085480 part 5: update_cmd must swap the installed script atomically.
#
# A bare `mv` from a /tmp download can cross a filesystem boundary, where the
# replace degrades to copy+unlink and a concurrent read/exec of the installed
# script can observe a partial file (arbitrary shell parse errors such as
# "unexpected ((""). This test proves the fixed update_cmd stages the new script
# in the target directory and replaces it with a same-filesystem rename, keeps
# the mode, preserves the existing script on every failure path, and leaves no
# temporary file behind. No network, no real installation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; chmod -R u+rwX "$TMP" 2>/dev/null || true' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1 OCVM_DISABLE_UPDATE_CHECK=1
mkdir -p "$HOME/bin"
# shellcheck disable=SC1090
source "$ROOT/opencode-vm.sh"

bin="$TMP/bin"
mkdir -p "$bin"
target="$bin/opencode-vm"
NEW_CONTENT=$'#!/usr/bin/env bash\n# updated version\nexit 0\n'
printf '#!/usr/bin/env bash\n# original version\n' > "$target"
chmod 755 "$target"
old_sha="$(sha256sum "$target" | awk '{print $1}')"

fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fails=$((fails+1)); fi; }
no_temps() { ! compgen -G "$bin/.opencode-vm.*" >/dev/null; }

# --- success path: atomic replacement, mode preserved, no temp left ---------
ocvm_update_source_url() { printf '%s\n' "https://example.invalid/opencode-vm.sh"; }
ocvm_version_greater_than() { return 0; }         # pretend a newer remote exists
ocvm_resolve_script_path() { printf '%s\n' "$target"; }
ocvm_post_update_migrate() { return 0; }
ocvm_check_remote_version() { printf '%s' "$NEW_CONTENT" > "$1"; printf '%s\n' "9.9.9"; }

set +e
( update_cmd </dev/null >"$TMP/update.log" 2>&1 )
rc=$?
set -e
check "success exits 0" "[[ $rc -eq 0 ]]"
check "target content replaced" "cmp -s <(printf '%s' \"\$NEW_CONTENT\") '$target'"
check "target stays executable" "[[ -x '$target' ]]"
check "target mode is 0755" "[[ \$(stat -c '%a' '$target' 2>/dev/null || stat -f '%Lp' '$target') == 755 ]]"
check "no staged temp files remain" "no_temps"

# --- error path: remote check unavailable -> exit 1, original preserved -----
printf '#!/usr/bin/env bash\n# original version\n' > "$target"; chmod 755 "$target"
ocvm_check_remote_version() { : > "$1"; }         # empty version -> "could not check"
set +e
( update_cmd </dev/null >"$TMP/update.log" 2>&1 )
rc=$?
set -e
check "missing remote version exits 1" "[[ $rc -eq 1 ]]"
check "original preserved on check failure" "[[ \$(sha256sum '$target' | awk '{print \$1}') == '$old_sha' ]]"
check "no temp on check failure" "no_temps"

# --- error path: staging directory not writable -> exit 1, original preserved -
ocvm_check_remote_version() { printf '%s' "$NEW_CONTENT" > "$1"; printf '%s\n' "9.9.9"; }
printf '#!/usr/bin/env bash\n# original version\n' > "$target"; chmod 755 "$target"
chmod 500 "$bin"
set +e
( update_cmd </dev/null >"$TMP/update.log" 2>&1 )
rc=$?
set -e
chmod 700 "$bin"
check "unwritable staging dir exits 1" "[[ $rc -eq 1 ]]"
check "staging failure keeps the original" "[[ \$(sha256sum '$target' | awk '{print \$1}') == '$old_sha' ]]"
check "staging failure names the cause" "grep -q 'Cannot stage the update next to' '$TMP/update.log'"
check "no temp after staging failure" "no_temps"
check "target still executable after failure" "[[ -x '$target' ]]"

echo
if [[ $fails -eq 0 ]]; then echo "PASS update_cmd atomic replacement (success/error/preservation/no-temp)"; else echo "FAIL ($fails)"; exit 1; fi
