"""Execute the release workflow's actual metadata shell against local fixtures."""

import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/release.yml").read_text()
STEP = textwrap.dedent(
    WORKFLOW.split("        id: metadata\n        run: |\n", 1)[1].split(
        "\n  release:", 1
    )[0]
)
SCRIPT = (ROOT / "opencode-vm.sh").read_text()
VERSION = re.search(r'^OCVM_VERSION="([^"]+)"', SCRIPT, re.M)[1]


class ReleaseMetadataTest(unittest.TestCase):
    def run_metadata(self, changes=None, ref_type="branch", ref_name="main"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [
                "opencode-vm.sh",
                "adapters/openlive-acp/package.json",
                "adapters/openlive-acp/src/acp/transport.ts",
            ]
            for path in paths:
                content = (ROOT / path).read_text()
                for before, after in (changes or {}).get(path, []):
                    self.assertIn(before, content)
                    content = content.replace(before, after, 1)
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            output = root / "output"
            result = subprocess.run(
                ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", STEP],
                cwd=root,
                env={
                    **os.environ,
                    "GITHUB_REF_TYPE": ref_type,
                    "GITHUB_REF_NAME": ref_name,
                    "GITHUB_OUTPUT": str(output),
                },
                capture_output=True,
                text=True,
            )
            return result, output.read_text() if output.exists() else ""

    def test_current_metadata_for_main_and_matching_tag(self):
        for ref_type, ref_name in [("branch", "main"), ("tag", f"v{VERSION}")]:
            with self.subTest(ref_type=ref_type):
                result, output = self.run_metadata(ref_type=ref_type, ref_name=ref_name)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"release_tag=v{VERSION}\n", output)

    def test_stale_adapter_tag_explains_mismatch(self):
        result, output = self.run_metadata({
            "opencode-vm.sh": [(f'OPENLIVE_ADAPTER_TAG="v{VERSION}"',
                                'OPENLIVE_ADAPTER_TAG="v0.5.46"')],
        })
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("::error::OPENLIVE_ADAPTER_TAG must match OCVM_VERSION", result.stderr)
        self.assertIn(f"expected 'v{VERSION}', got 'v0.5.46'", result.stderr)
        self.assertEqual(output, "")

    def test_wrong_manual_tag_is_rejected(self):
        result, output = self.run_metadata(ref_type="tag", ref_name="v0.0.0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("::error::Pushed tag must match OCVM_VERSION", result.stderr)
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
