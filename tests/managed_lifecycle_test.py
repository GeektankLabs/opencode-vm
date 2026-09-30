"""Execute the actual host payload installer against source/standalone fixtures."""
import base64
from contextlib import redirect_stdout
import gzip
import io
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "opencode-vm.sh").read_text()
FUNCTION = re.search(r"^managed_policy_install\(\) \{\n.*?^\}", SCRIPT, re.M | re.S)[0]


class LifecycleTest(unittest.TestCase):
    def builder_fixture(self, root):
        (root / "runtime").mkdir()
        for name in ("managed-core.mjs", "managed-policy.mjs", "a2a-managed.py"):
            (root / "runtime" / name).write_bytes((ROOT / "runtime" / name).read_bytes())
        (root / "scripts").mkdir()
        builder = root / "scripts/build-managed-runtime.py"
        builder.write_bytes((ROOT / "scripts/build-managed-runtime.py").read_bytes())
        embedded = re.search(r"# BEGIN GENERATED MANAGED RUNTIME\n.*?# END GENERATED MANAGED RUNTIME",
                             SCRIPT, re.S)[0]
        script = root / "opencode-vm.sh"
        script.write_text("# preserve prefix\n" + embedded + "\n# preserve suffix\n")
        return builder, script

    def run_builder(self, builder, *args):
        original_compress = gzip.compress

        def legacy_compress(data, compresslevel=9, *, mtime=None):
            # Reproduce the Python 3.11/3.12 zlib fast-path header on any host.
            result = bytearray(original_compress(data, compresslevel=compresslevel, mtime=mtime))
            result[9] = 3  # Unix OS marker, while the checked-in payload uses 255.
            return bytes(result)

        with patch.object(sys, "argv", [str(builder), *args]), \
                patch.object(gzip, "compress", legacy_compress), redirect_stdout(io.StringIO()):
            runpy.run_path(str(builder), run_name="__main__")

    def test_builder_preserves_exact_embedded_bytes_across_legacy_gzip_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            builder, script = self.builder_fixture(Path(tmp))
            before = script.read_bytes()
            self.run_builder(builder, "--check")
            self.assertEqual(script.read_bytes(), before)  # --check never writes.
            self.run_builder(builder)
            self.assertEqual(script.read_bytes(), before)  # Same bytes, no runtime/version churn.
            encoded = re.search(r"OCVM_MANAGED_RUNTIME_GZIP_BASE64='([^']+)'", script.read_text())[1]
            compressed = base64.b64decode(encoded)
            self.assertEqual(compressed[9], 255)
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(compressed)), mode="r:") as archive:
                self.assertEqual(archive.getnames(), ["managed-core.mjs", "managed-policy.mjs", "a2a-managed.py"])
                for entry in archive.getmembers():
                    self.assertTrue(entry.isfile())
                    self.assertEqual((entry.mode, entry.mtime, entry.uid, entry.gid), (0o644, 0, 0, 0))
                    self.assertEqual(archive.extractfile(entry).read(), (ROOT / "runtime" / entry.name).read_bytes())

    def test_builder_still_rejects_source_drift_and_rebuilds_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            builder, script = self.builder_fixture(root)
            before = script.read_bytes()
            source = root / "runtime/managed-core.mjs"
            source.write_bytes(source.read_bytes() + b"\n// changed fixture\n")
            with self.assertRaisesRegex(AssertionError, "embedded managed runtime is stale"):
                self.run_builder(builder, "--check")
            self.assertEqual(script.read_bytes(), before)
            self.run_builder(builder)
            rebuilt = script.read_bytes()
            self.assertNotEqual(rebuilt, before)
            self.run_builder(builder, "--check")
            os.utime(source, (1700000000, 1700000000))
            self.run_builder(builder)
            self.assertEqual(script.read_bytes(), rebuilt)

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
