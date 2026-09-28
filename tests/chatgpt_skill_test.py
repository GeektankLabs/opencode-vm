"""Artifact/privacy regression checks, not live ChatGPT behavior tests."""

import hashlib
import importlib.util
import io
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("skill_builder", ROOT / "scripts/build-chatgpt-skill.py")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class SkillPackageTest(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        shutil.copytree(ROOT / BUILDER.PACKAGE, root / BUILDER.PACKAGE)
        shutil.copyfile(ROOT / "LICENSE", root / "LICENSE")
        return root

    def test_checked_in_artifact_matches_inventory_and_safe_zip_metadata(self):
        manifest, data = BUILDER.archive_bytes(ROOT)
        base = ROOT / BUILDER.PACKAGE
        self.assertEqual((base / f'{manifest["name"]}.zip').read_bytes(), data)
        self.assertEqual((base / f'{manifest["name"]}.zip.sha256').read_text(),
                         f'{hashlib.sha256(data).hexdigest()}  {manifest["name"]}.zip\n')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertIsNone(archive.testzip())
            expected = {f'{manifest["name"]}/{name}' for name in manifest["files"] + ["LICENSE"]}
            self.assertEqual(set(archive.namelist()), expected)
            self.assertEqual(len(archive.infolist()), len(expected))
            for item in archive.infolist():
                self.assertTrue(stat.S_ISREG(item.external_attr >> 16))
                self.assertEqual((item.external_attr >> 16) & 0o777, 0o644)
                self.assertEqual(item.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(item.extra, b"")
                self.assertEqual(item.comment, b"")

    def test_build_is_independent_of_source_mtime_and_crlf_checkout(self):
        root = self.fixture()
        original = BUILDER.archive_bytes(root)[1]
        skill = root / BUILDER.PACKAGE / "opencode-session-orchestrator/SKILL.md"
        skill.write_bytes(skill.read_bytes().replace(b"\n", b"\r\n"))
        skill.touch()
        self.assertEqual(BUILDER.archive_bytes(root)[1], original)

    def test_uninventoried_file_is_not_silently_shipped(self):
        root = self.fixture()
        (root / BUILDER.PACKAGE / "opencode-session-orchestrator/.DS_Store").write_bytes(b"private metadata")
        with self.assertRaisesRegex(ValueError, "Inventory mismatch"):
            BUILDER.archive_bytes(root)

    def test_symlink_is_rejected(self):
        root = self.fixture()
        icon = root / BUILDER.PACKAGE / "opencode-session-orchestrator/assets/icon.svg"
        icon.unlink()
        icon.symlink_to(root / "LICENSE")
        with self.assertRaisesRegex(ValueError, "Symlinks"):
            BUILDER.archive_bytes(root)

    def test_private_identifiers_and_broken_references_fail(self):
        root = self.fixture()
        skill = root / BUILDER.PACKAGE / "opencode-session-orchestrator/SKILL.md"
        original = skill.read_text()
        for value, expected in [("tunnel_" + "0" * 32, "private identifier"),
                                ("[missing](references/missing.md)", "Missing/out-of-bundle"),
                                ("[secret](../../../../LICENSE)", "Missing/out-of-bundle")]:
            with self.subTest(value=value):
                skill.write_text(original + "\n" + value + "\n")
                with self.assertRaisesRegex(ValueError, expected):
                    BUILDER.archive_bytes(root)

    def test_active_svg_is_rejected(self):
        root = self.fixture()
        icon = root / BUILDER.PACKAGE / "opencode-session-orchestrator/assets/icon.svg"
        original = icon.read_text()
        for value in [original.replace("</svg>", "<script>alert(1)</script></svg>"),
                      original.replace('fill="none"', 'fill="URL(https://example.com/paint.svg)"'),
                      '<?xml-stylesheet href="https://example.com/style.xsl"?>' + original]:
            with self.subTest(value=value[:40]):
                icon.write_text(value)
                with self.assertRaisesRegex(ValueError, "SVG"):
                    BUILDER.archive_bytes(root)

    def test_fixed_connector_dependency_is_rejected(self):
        root = self.fixture()
        metadata = root / BUILDER.PACKAGE / "opencode-session-orchestrator/agents/openai.yaml"
        metadata.write_text(metadata.read_text() + "\ndependencies:\n  tools: []\n")
        with self.assertRaisesRegex(ValueError, "fixed MCP dependency"):
            BUILDER.archive_bytes(root)

    def test_semantic_profiles_preserve_read_only_and_user_override_rules(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        clarification = (source / "references/clarification-sessions.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        for required in ("get_recommended_runtime", "deep", "standard", "execution",
                         "User-specified", "busy", "pending", "reread", "pure read"):
            self.assertIn(required.lower(), skill.lower())
        self.assertNotIn("gpt-6-luna", clarification)
        self.assertNotIn("variant:xhigh", clarification)
        self.assertIn("unavailable configured mapping", scenarios)


if __name__ == "__main__":
    unittest.main()
