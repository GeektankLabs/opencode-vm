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

    def test_task_compact_context_convention(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        manifest, _ = BUILDER.package_content(ROOT)
        context = (source / "references/task-compact-context.md").read_text()
        board = (source / "references/board-workflow.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        changelog = (source / "CHANGELOG.md").read_text()
        self.assertIn("references/task-compact-context.md", manifest["files"])
        self.assertIn(f'## {manifest["revision"]}', changelog)
        self.assertIn(f'**{manifest["revision"]}**', skill)
        self.assertIn("[Task compact context](references/task-compact-context.md)", skill)
        self.assertIn(".opencode/tasks/task-<task_id>.compact.md", context)
        self.assertIn("Task-ID:", context)
        self.assertIn("Last-updated:", context)
        self.assertIn("message to the agent actually doing the work", skill)
        self.assertIn("after substantial iterations", skill)
        self.assertIn("The executing agent remains the primary maintainer", context)
        self.assertIn("must sample-check", context)
        self.assertIn("do not claim a registry survives a new chat", context)
        self.assertIn("get_task_documents", context)
        self.assertIn("QA **pending**", context)
        self.assertIn("not to the manager as routine editor", board)

        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        early = rows["Early QA after the first substantive completed work assignment"]
        later = rows["Long/large iteration or several substantive follow-ups materially change the task"]
        repair = rows["Context lacks the latest verified milestone or has a stale next step"]
        self.assertIn("actual file text", early)
        self.assertIn("that assignment's final result", early)
        self.assertIn("matching `Task-ID`", early)
        self.assertIn("Sample-check the current file again", later)
        self.assertIn("new session resume", later)
        self.assertIn("next authorized follow-up to the executing agent", repair)
        self.assertIn("Work it exactly as before", scenarios)

    def test_task_concept_plan_convention(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        manifest, _ = BUILDER.package_content(ROOT)
        concept = (source / "references/task-concept-plan.md").read_text()
        board = (source / "references/board-workflow.md").read_text()
        clarification = (source / "references/clarification-sessions.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        changelog = (source / "CHANGELOG.md").read_text()
        self.assertIn("references/task-concept-plan.md", manifest["files"])
        self.assertIn(f'## {manifest["revision"]}', changelog)
        self.assertIn(f'**{manifest["revision"]}**', skill)
        self.assertIn("[Task concept plan](references/task-concept-plan.md)", skill)
        self.assertIn("planning/task-concepts/<task_id>-concept-plan.md", concept)
        self.assertIn("Task-ID:", concept)
        self.assertIn("Last-concept-update:", concept)
        self.assertIn("Mandatory initialization on `todo` -> `in_progress`", concept)
        self.assertIn("mandatory initialization before `todo` -> `in_progress`", board.lower())
        self.assertIn("Initialize concept plan + compact context on `todo` -> `in_progress`", skill)
        self.assertIn("Sample-check task files during introduction", skill)
        self.assertIn("concept plan", clarification.lower())
        self.assertIn("start, resumption, follow-up, implementation, diagnosis, test", concept)

        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        init = rows["A known board task moves from `todo` to `in_progress`"]
        self.assertIn("authorized write-capable work request", init)
        self.assertIn("planning/task-concepts/<task_id>-concept-plan.md", init)
        self.assertIn(".opencode/tasks/task-<task_id>.compact.md", init)
        early = rows["Early QA after `todo` -> `in_progress`"]
        self.assertIn("plan text", early)
        later = rows["Later QA after long/large iterations or several substantive follow-ups"]
        self.assertIn("decisions and rationale", later)
        repair = rows["Plan gap (stale decision, missing rationale, drifted test/acceptance plan, contradictory compact-context pointer)"]
        self.assertIn("next authorized follow-up to the executing agent", repair)

    def test_combined_task_file_handoffs_and_conflicts(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        plan = (source / "references/task-concept-plan.md").read_text()
        context = (source / "references/task-compact-context.md").read_text()
        board = (source / "references/board-workflow.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        self.assertIn("every task-related work instruction", skill)
        self.assertIn("actual path", context)
        self.assertIn("collision, not permission to overwrite", board.lower())
        self.assertIn("truncated result cannot pass a full-file", plan)
        self.assertIn("only IDs already known", rows["A known board task moves from `todo` to `in_progress`"])
        self.assertIn("stop; do not overwrite", rows["Existing files already cover the task"])
        self.assertIn("Repeat both paths", rows["Same-session follow-up for plan-backed task is a routine implementation or test"])
        self.assertIn("both paths", rows["Read-only diagnostic/clarification with conceptual relevance"])
        self.assertIn("Board wins on outcome/scope", rows["Compact context and plan contradict"])
        self.assertIn("full check pending", rows["First combined-file QA or handover after a long diagnosis"])
        self.assertIn("Board + context + plan", rows["A new session resumes with a known task ID but no conversational registry"])

    def test_task_file_size_policy_and_staged_agent_prompts(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        context = (source / "references/task-compact-context.md").read_text()
        plan = (source / "references/task-concept-plan.md").read_text()
        board = (source / "references/board-workflow.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}

        for value in ("5,000", "7,500", "10,000"):
            self.assertIn(value, context)
            self.assertIn(value, plan)
        for value in ("20,000", "30,000", "40,000"):
            self.assertIn(value, plan)
        self.assertIn("exactly one file", context)
        self.assertIn("canonical entry/index", plan)
        self.assertIn("<task_id>-architecture.md", plan)
        self.assertIn("characters divided by four", context)
        self.assertIn("tokenizer", plan)

        self.assertIn("Initialization instruction", plan)
        self.assertIn("Combined quality-check refresh", plan)
        reminder = "Read task files; keep context terse/current; update plan on concept changes."
        self.assertIn(reminder, skill)
        self.assertIn(reminder, plan)
        self.assertIn("full care instruction", rows["First substantive assignment or new executing agent/session context with both files"])
        self.assertIn("Keep exactly one context file", rows["Compact context approaches ~7,500 or ~10,000 tokens"])
        self.assertIn("canonical index", rows["Concept plan main file approaches ~30,000 or ~40,000 tokens"])
        self.assertIn("somewhat fuller refresh", rows["Early or later QA checkpoint for both files"])
        self.assertIn(reminder, rows["Same-session substantive implementation, design, diagnosis or test follow-up"])
        self.assertIn("report context/plan deltas; no writes", rows["Substantive read-only investigation could reveal concept changes"])
        self.assertIn("omit the maintenance reminder", rows["Tiny read-only check or trivial task-bound mini-assignment"])
        self.assertIn("do not submit any new agent prompt", rows["User asks only for existing status/result"])
        self.assertIn("short reminder", board)

    def test_ordered_task_document_initialization_and_read_only_management(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        board = (source / "references/board-workflow.md").read_text()
        context = (source / "references/task-compact-context.md").read_text()
        plan = (source / "references/task-concept-plan.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        for tool in ("register_task_document", "get_task_documents", "read_task_document"):
            self.assertIn(tool, board)
        self.assertIn("**then**", skill)
        self.assertIn("keep the task **`todo`**", skill)
        self.assertIn("Read task documents for management questions", skill)
        self.assertIn("`compact_context` first", skill)
        self.assertIn("agent-mediated exact-text fallback", skill)
        self.assertIn("TASK_DOCUMENT_CHANGED", context)
        self.assertIn("registered `concept_detail`", plan)

        init = rows["User confirms moving a `todo` task into `in_progress`"]
        self.assertLess(init.index("While Board remains `todo`"), init.index("Register `compact_context`"))
        self.assertLess(init.index("Register `compact_context`"), init.index("then move the Board task"))
        self.assertIn("Leave Board `todo`", rows["Initial file creation fails or another task ID owns an expected path"])
        self.assertIn("do not recreate", rows["One document registration succeeds and the second fails"])
        self.assertIn("Preserve files/references", rows["Both references exist but Board move fails or has an uncertain response"])
        self.assertIn("Stop before the new transition", rows["Connector lacks `register_task_document` for a newly requested `todo` -> `in_progress` move"])
        self.assertIn("original result", rows["After a substantive agent result, both files are directly readable"])
        self.assertIn("read `compact_context` first", rows["User requests an Executive Summary or next step"])
        self.assertIn("agent-mediated exact-text fallback", rows["Connector lacks direct task-document reads"])


if __name__ == "__main__":
    unittest.main()
