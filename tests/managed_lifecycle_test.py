"""Execute the actual host payload installer against source/standalone fixtures."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "opencode-vm.sh").read_text()
FUNCTION = re.search(r"^managed_policy_install\(\) \{\n.*?^\}", SCRIPT, re.M | re.S)[0]


class LifecycleTest(unittest.TestCase):
    def test_source_and_standalone_install_are_idempotent_and_preserve_manual_config(self):
        for standalone in (False, True):
            with self.subTest(standalone=standalone), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                config = root / "share/config/opencode"
                config.mkdir(parents=True)
                original = {"$schema": "https://opencode.ai/config.json", "permission": {"bash": {"git commit *": "ask"}}, "instructions": ["original.md"], "plugin": ["existing-plugin"]}
                cfg = config / "opencode.json"
                cfg.write_text(json.dumps(original))
                source = root / "standalone" if standalone else ROOT
                source.mkdir(exist_ok=True)
                embedded = re.search(r"# BEGIN GENERATED MANAGED RUNTIME\n(.*?)\n# END GENERATED MANAGED RUNTIME", SCRIPT, re.S)[1]
                shell = embedded + "\n" + FUNCTION + '''
jq_inplace() { target="$1"; shift; jq "$@" "$target" > "$target.tmp" && mv "$target.tmp" "$target"; }
mcp_prepare_adapter_cache() { return 0; }
mcp_adapter_source_dir() { printf '%s\\n' "$CACHE"; }
managed_policy_install "$SHARE"
managed_policy_install "$SHARE"
'''
                if standalone:
                    # Same layout as the release package; no origin/download.
                    cache = root / "cache"
                    (cache / "runtime").mkdir(parents=True)
                    for name in ("managed-core.mjs", "managed-policy.mjs", "a2a-managed.py"):
                        (cache / "runtime" / name).write_bytes((ROOT / "runtime" / name).read_bytes())
                else:
                    cache = root
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", shell], env={**os.environ, "SCRIPT_DIR": str(source), "CACHE": str(cache), "SHARE": str(root / "share")}, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                value = json.loads(cfg.read_text())
                self.assertEqual(value["permission"], original["permission"])
                self.assertEqual(value["instructions"], original["instructions"])
                self.assertEqual(len(value["plugin"]), 2)
                self.assertEqual(value["plugin"][0], "existing-plugin")
                for name in ("managed-core.mjs", "managed-policy.mjs", "a2a-managed.py"):
                    self.assertEqual((config / "managed-policy" / name).read_bytes(), (ROOT / "runtime" / name).read_bytes())

    def test_symlinked_policy_destination_is_rejected_without_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "share/config/opencode"
            config.mkdir(parents=True)
            victim = root / "victim"
            victim.mkdir()
            (victim / "managed-core.mjs").write_text("keep")
            (config / "managed-policy").symlink_to(victim)
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", FUNCTION + '\nmanaged_policy_install "$SHARE"'], env={**os.environ, "SCRIPT_DIR": str(ROOT), "SHARE": str(root / "share")}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((victim / "managed-core.mjs").read_text(), "keep")

    def test_fresh_attach_and_a2a_launch_use_the_same_owned_payload(self):
        self.assertIn('managed_policy_install "$resume_share"', SCRIPT)
        self.assertIn('managed_policy_install "$sess_share"', SCRIPT)
        self.assertEqual(SCRIPT.count('export OCVM_MANAGED_POLICY_SOCKET="/tmp/ocvm-managed/'), 2)
        self.assertIn('"$A2A_PYTHON" "$A2A_LAUNCHER" "$bin" serve', SCRIPT)
        self.assertIn('"$ROOT/runtime/managed-policy.mjs"', (ROOT / "scripts/build-mcp-adapter.sh").read_text())


if __name__ == "__main__": unittest.main()
