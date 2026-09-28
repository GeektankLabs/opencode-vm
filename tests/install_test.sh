#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" OCVM_INTERNAL_SOURCE_ONLY=1
export PATH="$HOME/bin:$PATH"
mkdir -p "$HOME/bin" "$TMP/source/hub/__pycache__"
# shellcheck disable=SC1090
source "$ROOT/opencode-vm.sh"
limactl() { :; }

source_file="$TMP/source/opencode-vm.sh"
ocvm_resolve_script_path() { printf '%s\n' "$source_file"; }
for asset in server.py policy.py catalog.py index.html styles.css app.js control.js; do
  printf '%s\n' "$asset" > "$TMP/source/hub/$asset"
done
printf '#!/usr/bin/env bash\n# first version\n' > "$source_file"
ln -s "$source_file" "$HOME/bin/opencode-vm"

install_cmd > "$TMP/install.log"
[[ -f "$HOME/bin/opencode-vm" && ! -L "$HOME/bin/opencode-vm" && -x "$HOME/bin/opencode-vm" ]]
cmp -s "$source_file" "$HOME/bin/opencode-vm"
for asset in server.py policy.py catalog.py index.html styles.css app.js control.js; do
  cmp -s "$TMP/source/hub/$asset" "$SHARE_ROOT/hub/$asset"
done
[[ ! -e "$SHARE_ROOT/hub/__pycache__" ]]

printf '#!/usr/bin/env bash\n# second version\n' > "$source_file"
install_cmd > "$TMP/install.log"
cmp -s "$source_file" "$HOME/bin/opencode-vm"

# Reinstalling from the installed executable is safe even though source and
# destination are the same path.
source_file="$HOME/bin/opencode-vm"
install_cmd > "$TMP/install.log"
[[ -f "$HOME/bin/opencode-vm" && -x "$HOME/bin/opencode-vm" ]]
printf '%s\n' 'ok - install replaces an existing symlink and executable; Hub caches are ignored'
