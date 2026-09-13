"""Run the actual release-state and publication steps with a strict gh mock."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/release.yml").read_text()
REPO = "fixture/project"
TAG = "v0.5.50"
SHA = "a" * 40
ASSET = "opencode-vm-openlive-adapter-0.1.6.tar"
REF = ["api", f"repos/{REPO}/git/ref/tags/{TAG}"]
COMMIT = ["api", f"repos/{REPO}/commits/{TAG}", "--jq", ".sha"]
RELEASE = ["api", f"repos/{REPO}/releases/tags/{TAG}"]
CREATE_REF = ["api", "--method", "POST", f"repos/{REPO}/git/refs",
              "-f", f"ref=refs/tags/{TAG}", "-f", f"sha={SHA}"]
PUBLISH = ["release", "create", TAG, "opencode-vm.sh", f"release-a/{ASSET}",
           "release-a/SHA256SUMS", "--verify-tag", "--generate-notes",
           "--title", f"opencode-vm {TAG}"]


def response(args, stdout="", error=""):
    return {"args": args, "stdout": stdout, "error": error}


MISSING_RELEASE = response(RELEASE, error="gh: Not Found (HTTP 404)")
MISSING_REF = response(REF, error="gh: Not Found (HTTP 404)")
MOCK = '''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

path = Path(os.environ["GH_FIXTURE"])
responses = json.loads(path.read_text())
if not responses or responses[0]["args"] != sys.argv[1:]:
    print("Unexpected gh call: " + repr(sys.argv[1:]), file=sys.stderr)
    sys.exit(90)
item = responses.pop(0)
path.write_text(json.dumps(responses))
print(item["stdout"], end="")
if item["error"]:
    print(item["error"], file=sys.stderr)
    sys.exit(1)
'''


class ReleaseStateTest(unittest.TestCase):
    def run_step(self, name, responses, success=True):
        step = textwrap.dedent(
            WORKFLOW.split(f"      - name: {name}\n", 1)[1]
            .split("        run: |\n", 1)[1].split("        env:", 1)[0]
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / "gh"
            mock.write_text(MOCK)
            mock.chmod(0o755)
            fixture = root / "responses.json"
            fixture.write_text(json.dumps(responses))
            output = root / "output"
            result = subprocess.run(
                ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step],
                cwd=root,
                env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}",
                     "GH_FIXTURE": str(fixture), "GITHUB_REPOSITORY": REPO,
                     "GITHUB_SHA": SHA, "OPENLIVE_RELEASE_TAG": TAG,
                     "OPENLIVE_ASSET": ASSET, "GITHUB_OUTPUT": str(output),
                     "TMPDIR": str(root)},
                capture_output=True, text=True,
            )
            self.assertNotIn("Unexpected gh call", result.stderr)
            self.assertEqual(json.loads(fixture.read_text()), [])
            if success:
                self.assertEqual(result.returncode, 0, result.stderr)
            else:
                self.assertNotEqual(result.returncode, 0)
            return result, output.read_text() if output.exists() else ""

    def test_missing_tag_allows_build_and_is_created_before_publication(self):
        _, output = self.run_step("Check release state", [MISSING_RELEASE, MISSING_REF])
        self.assertEqual(output, "release_needed=true\n")
        self.run_step("Publish release", [MISSING_REF, response(CREATE_REF), response(PUBLISH)])

    def test_existing_lightweight_and_annotated_tags_use_peeled_commit(self):
        for kind in ("commit", "tag"):
            ref = response(REF, json.dumps({"object": {"type": kind, "sha": "b" * 40}}))
            for name in ("Check release state", "Publish release"):
                with self.subTest(kind=kind, step=name):
                    replies = ([MISSING_RELEASE] if name == "Check release state" else [])
                    replies += [ref, response(COMMIT, SHA)]
                    if name == "Publish release":
                        replies += [response(PUBLISH)]
                    self.run_step(name, replies)

    def test_mismatched_existing_tag_blocks_build_and_publication(self):
        for name in ("Check release state", "Publish release"):
            with self.subTest(step=name):
                replies = ([MISSING_RELEASE] if name == "Check release state" else [])
                replies += [response(REF), response(COMMIT, "b" * 40)]
                result, output = self.run_step(name, replies, success=False)
                self.assertIn(f"expected {SHA}", result.stderr)
                self.assertEqual(output, "")

    def test_ref_api_errors_are_not_treated_as_missing_tags(self):
        for status in (401, 403, 422, 500):
            for name in ("Check release state", "Publish release"):
                with self.subTest(status=status, step=name):
                    replies = ([MISSING_RELEASE] if name == "Check release state" else [])
                    replies += [response(REF, error=f"gh: API failure (HTTP {status})")]
                    result, _ = self.run_step(name, replies, success=False)
                    self.assertIn(f"HTTP {status}", result.stderr)

    def test_unresolvable_existing_tag_does_not_create_or_publish(self):
        for name in ("Check release state", "Publish release"):
            with self.subTest(step=name):
                replies = ([MISSING_RELEASE] if name == "Check release state" else [])
                replies += [response(REF), response(COMMIT, error=
                            f"gh: No commit found for SHA: {TAG} (HTTP 422)")]
                result, _ = self.run_step(name, replies, success=False)
                self.assertIn("HTTP 422", result.stderr)


if __name__ == "__main__":
    unittest.main()
