"""Artifact/privacy regression checks, not live ChatGPT behavior tests."""

import hashlib
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
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
        for required in ("get_recommended_runtime", "deep", "standard", "execution", "design", "review", "resolution_path", "resolved_profile", "only null",
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

    def test_header_evidence_and_same_file_recovery_instruction_contract(self):
        # Static skill contract regression; does not claim hosted model behavior.
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        texts = {name: (source / path).read_text() for name, path in (
            ("skill", "SKILL.md"), ("context", "references/task-compact-context.md"),
            ("plan", "references/task-concept-plan.md"), ("board", "references/board-workflow.md"),
            ("followthrough", "references/initialization-follow-through.md"))}
        for name, text in texts.items():
            with self.subTest(document=name):
                self.assertIn("Task-ID: <stable task_id>", text)
                for required in ("backticks", "spacing", "terminal", "final result", "CONCEPT_READY", "INPUT_REQUIRED"):
                    self.assertIn(required, text)
                self.assertIn("success without header evidence is not accepted", text.lower())
        instruction = texts["plan"].split("When that request initializes or repairs documents", 1)[1].split(
            "### Short follow-up reminder", 1)[0]
        for required in ("first three lines", "first four", "role and actual path", "exact readback lines",
                         "missing file vs wrong path vs header mismatch", "never overwrite", "do not move the Board yourself"):
            self.assertIn(required, instruction)
        recovery = texts["board"].split("For a registration failure", 1)[1].split("With an older connector", 1)[0]
        for required in ("TASK_DOCUMENT_MISSING", "TASK_DOCUMENT_PATH_INVALID", "TASK_DOCUMENT_MISMATCH",
                         "do not infer a foreign owner solely from this code", "preserving their body", "reread",
                         "register again", "both roles `available`", "current revisions", "same files at the same paths",
                         "separate status readback", "preferred bundle", "never create replacement"):
            self.assertIn(required, recovery)
        self.assertLess(recovery.index("register again"), recovery.index("both roles `available`"))
        self.assertLess(recovery.index("both roles `available`"), recovery.index("only then `in_progress`"))
        scenarios = (source / "references/regression-scenarios.md").read_text()
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        no_evidence = rows['Agent reports success or "headers checked" but supplies no actual lines']
        self.assertIn("not accepted", no_evidence)
        self.assertIn("Leave Board `todo`", no_evidence)
        self.assertIn("no registration/move", no_evidence)
        self.assertIn("INPUT_REQUIRED", rows["Real header contains a foreign Task-ID"])
        self.assertIn("do not overwrite", rows["Real header contains a foreign Task-ID"])
        malformed = rows["Header uses Markdown heading, backticks, alternate label or extra spacing"]
        for required in ("not proof of another owner", "same safely task-owned files",
                         "both roles `available` with exact paths/revisions", "preferred bundle", "fallback only if absent"):
            self.assertIn(required, malformed)

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
        self.assertIn("do not recreate", rows["One document registration succeeds and the second fails"].lower())
        self.assertIn("Preserve files/references", rows["Both references exist but Board move fails or has an uncertain response"])
        self.assertIn("Stop before the new transition", rows["Connector lacks both main-document binding tools for a newly requested `todo` -> `in_progress` move"])
        self.assertIn("original result", rows["After a substantive agent result, both files are directly readable"])
        self.assertIn("read `compact_context` first", rows["User requests an Executive Summary or next step"])
        self.assertIn("agent-mediated exact-text fallback", rows["Connector lacks direct task-document reads"])

    def test_initialization_follow_through_vocabulary_and_text_markers(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        board = (source / "references/board-workflow.md").read_text()
        plan = (source / "references/task-concept-plan.md").read_text()
        context = (source / "references/task-compact-context.md").read_text()
        reference = (source / "references/initialization-follow-through.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}

        for label in ("CONCEPT_READY", "REGISTERED", "BOARD_MOVED"):
            self.assertIn(label, reference)
            self.assertIn(label, skill)
        self.assertIn("CONCEPT_READY:", reference)
        manifest, _ = BUILDER.package_content(ROOT)
        self.assertIn("references/initialization-follow-through.md", manifest["files"])

        self.assertIn("CONCEPT_READY:", plan)
        self.assertIn("`CONCEPT_READY`", skill)
        self.assertIn("`REGISTERED`", skill)
        self.assertIn("`BOARD_MOVED`", skill)
        self.assertIn("post-`CONCEPT_READY`", context)

        guard = rows["Agent reports `CONCEPT_READY` with verified paths/IDs and the orchestrator tries to move the Board before registration"]
        self.assertIn("REGISTERED", guard)
        self.assertIn("`todo`", guard)
        skip = rows["Both registrations succeed and read back as `available` but the orchestrator skips the Board move"]
        self.assertIn("BOARD_MOVED", skip)
        orphan = rows["Orphan matching files already exist at canonical paths from a previous interrupted run"]
        self.assertIn("ask the executing agent to recreate", orphan.lower())
        self.assertIn("rename", orphan.lower())
        path_only = rows["Agent returns `CONCEPT_READY` with paths but no actual `Task-ID` from each head block"]
        self.assertIn("Reject the checkpoint", path_only)
        followup = rows["Same-session follow-up arrives before the Board move completes"]
        self.assertIn("continuation of the authorized transition", followup)
        interrupt = rows["Approval interrupt arrives before any post-`CONCEPT_READY` step completes"]
        self.assertIn("Preserve the last successful step", interrupt)
        self.assertIn("resume from the next pending step", interrupt)

    def test_initialization_follow_through_sequence_walks_orchestrator_side(self):
        """Walk the orchestrator's post-CONCEPT_READY sequence against an in-memory fake.

        The orchestrator is described declaratively in the skill source; this test
        models the labelled-checkpoint decision process against a small
        FakeConnector + FakeAgent and asserts the orchestrator's action across
        scripted success, retry and failure scenarios:

          1. Clean run: CONCEPT_READY with verified paths/IDs → REGISTERED → BOARD_MOVED.
          2. Premature-Board-advance guard: even with verified files, the orchestrator
             must not move the Board before REGISTERED.
          3. Partial registration and retry: first registration succeeds, second
             fails → Board stays todo; retry registers only the missing role.
          4. Move failure: both registrations succeed and read back, but Board move
             returns uncertain → Board stays todo, registrations preserved.
          5. Orphan reuse: matching files already exist from a previous interrupted
             run → reuse, register, move; no recreate, no rename.
          6. Foreign Task-ID collision: an expected path belongs to another task →
             orchestrator stops with collision report; no overwrite, no move.
          7. Invalid task-document readbacks (unavailable state, wrong path or
             missing revision) → Board stays todo.
          8. Board readback does not confirm in_progress → no BOARD_MOVED result.

        The test does not exercise every wording detail in the skill source; it
        exercises the action contract that the wording implies.
        """

        class FakeConnector:
            """Minimal in-memory model of the orchestrator-visible connector API."""

            def __init__(self, *, plan_id, context_id,
                         register_fail=None, move_status="success",
                         plan_owned_by=None, context_owned_by=None,
                         document_state="available", document_path_overrides=None,
                         document_revision=1, board_readback_status=None,
                         bundle_available=True, bundle_fail=None, move_commits_uncertain=False):
                self.plan_id = plan_id
                self.context_id = context_id
                self.register_fail = register_fail
                self.move_status = move_status
                self.plan_owned_by = plan_owned_by
                self.context_owned_by = context_owned_by
                self.document_state = document_state
                self.document_path_overrides = document_path_overrides or {}
                self.document_revision = document_revision
                self.board_readback_status = board_readback_status
                self.bundle_available = bundle_available
                self.bundle_fail = bundle_fail
                self.move_commits_uncertain = move_commits_uncertain
                self.binding_calls = []
                self.binding_publications = 0
                self.plan_path = f"planning/task-concepts/{plan_id}-concept-plan.md"
                self.context_path = f".opencode/tasks/task-{plan_id}.compact.md"
                self.registration_calls = []
                self.registrations = []
                self.moves = []
                self.readbacks = []
                self.document_reads = 0
                self.status = "todo"

            def register_task_document(self, role, path):
                self.registration_calls.append((role, path))
                if self.register_fail == role:
                    return {"ok": False, "role": role, "error": "registration_failed"}
                if role == "compact_context" and self.context_owned_by not in (None, self.context_id):
                    return {"ok": False, "role": role, "error": "foreign_task_id"}
                if role == "concept_plan" and self.plan_owned_by not in (None, self.plan_id):
                    return {"ok": False, "role": role, "error": "foreign_task_id"}
                if (role, path) not in self.registrations:
                    self.registrations.append((role, path))
                return {"ok": True, "role": role, "revision": 1}

            def add_task_document_bindings(self, task_id, compact_context, concept_plan):
                self.binding_calls.append((task_id, compact_context, concept_plan))
                requested = [("compact_context", compact_context), ("concept_plan", concept_plan)]
                if self.context_owned_by not in (None, task_id) or self.plan_owned_by not in (None, task_id):
                    return {"ok": False, "error": "TASK_DOCUMENT_MISMATCH"}
                if self.bundle_fail and self.bundle_fail != "uncertain_after_commit":
                    return {"ok": False, "error": self.bundle_fail}
                if any(old_role == role and old_path != path
                       for role, path in requested for old_role, old_path in self.registrations):
                    return {"ok": False, "error": "TASK_DOCUMENT_CONFLICT"}
                additions = [ref for ref in requested if ref not in self.registrations]
                if additions:
                    self.registrations.extend(additions)
                    self.binding_publications += 1
                if self.bundle_fail == "uncertain_after_commit":
                    return {"ok": False, "error": "TASKBOARD_METADATA_ERROR"}
                return {"ok": True}

            def get_task_documents(self, task_id):
                self.document_reads += 1
                docs = []
                for role, path in self.registrations:
                    if role in ("compact_context", "concept_plan") and path:
                        docs.append({
                            "role": role,
                            "path": self.document_path_overrides.get(role, path),
                            "state": self.document_state,
                            "revision": self.document_revision,
                        })
                return {"task_id": task_id, "documents": docs}

            def move_task_to_in_progress(self, task_id):
                self.moves.append(task_id)
                if self.move_status == "uncertain":
                    if self.move_commits_uncertain:
                        self.status = "in_progress"
                    return {"ok": False, "error": "uncertain"}
                self.status = "in_progress"
                return {"ok": True, "status": "in_progress"}

            def read_task(self, task_id):
                self.readbacks.append(task_id)
                return {
                    "ok": True,
                    "status": self.board_readback_status or self.status,
                }

        class FakeFilesystem:
            """Tracks file presence and head blocks at the canonical paths."""

            def __init__(self, *, plan_id, plan_owned_by=None, context_owned_by=None):
                self.plan_path = f"planning/task-concepts/{plan_id}-concept-plan.md"
                self.context_path = f".opencode/tasks/task-{plan_id}.compact.md"
                self.plan_id = plan_owned_by or plan_id
                self.context_id = context_owned_by or plan_id

            def head_block(self, path):
                if path == self.plan_path:
                    return f"Task-ID: {self.plan_id}"
                if path == self.context_path:
                    return f"Task-ID: {self.context_id}"
                return None

        # Reference orchestrator implementation that mirrors the labelled-checkpoint
        # sequence described in references/initialization-follow-through.md. Each
        # step is an explicit function call so the test can assert call ordering.
        def run_orchestrator(agent_reply, connector, fs, *, force_premature_advance=False):
            log = {"agent_reply": agent_reply, "actions": []}

            def step(name, fn):
                log["actions"].append(name)
                return fn()

            # 1. Verify the agent's reply carries CONCEPT_READY + actual Task-IDs.
            if "CONCEPT_READY:" not in agent_reply:
                log["state"] = "todo"
                log["last_successful_step"] = None
                log["failure"] = "missing CONCEPT_READY label"
                return log
            plan_match = "Task-ID: " + connector.plan_id in agent_reply
            context_match = "Task-ID: " + connector.context_id in agent_reply
            if not (plan_match and context_match):
                log["state"] = "todo"
                log["last_successful_step"] = None
                log["failure"] = "missing actual Task-ID from head block"
                return log

            # 2. Verify each file on disk and reject foreign Task-IDs.
            plan_head = fs.head_block(connector.plan_path)
            context_head = fs.head_block(connector.context_path)
            if plan_head != "Task-ID: " + connector.plan_id:
                log["state"] = "todo"
                log["last_successful_step"] = None
                log["failure"] = "plan path collision"
                return log
            if context_head != "Task-ID: " + connector.context_id:
                log["state"] = "todo"
                log["last_successful_step"] = None
                log["failure"] = "context path collision"
                return log

            # 3. Reuse any already-available matching registration; this is what
            # lets a later authorized attempt resume after partial registration.
            existing = step("get_existing_task_documents", lambda:
                            connector.get_task_documents(connector.plan_id))

            def available_at(docs, role, path):
                return any(
                    entry.get("state") == "available"
                    and entry.get("path") == path
                    and entry.get("revision") not in (None, "")
                    for entry in docs["documents"] if entry["role"] == role
                )

            roles = (
                ("concept_plan", connector.plan_path, "register_plan", "register_plan"),
                ("compact_context", connector.context_path,
                 "register_context", "register_context"),
            )
            last_successful_step = "verify_files"
            if connector.bundle_available:
                result = step("add_task_document_bindings", lambda: connector.add_task_document_bindings(
                    connector.plan_id, connector.context_path, connector.plan_path))
                if not result["ok"]:
                    log["state"] = "todo"
                    log["last_successful_step"] = last_successful_step
                    log["failure"] = result["error"]
                    # Reconciliation only: no blind retry or automatic replacement fallback.
                    step("reconcile_task_documents", lambda: connector.get_task_documents(connector.plan_id))
                    return log
                last_successful_step = "bind_both"
            else:
                for role, path, action, success_step in roles:
                    if available_at(existing, role, path):
                        last_successful_step = success_step
                        continue
                    result = step(action, lambda role=role, path=path:
                                  connector.register_task_document(role, path))
                    if not result["ok"]:
                        log["state"] = "todo"
                        log["last_successful_step"] = last_successful_step
                        log["failure"] = result.get("error", f"{role}_registration_failed")
                        return log
                    last_successful_step = success_step

            # 4. Read back via get_task_documents and require both roles available,
            # at their canonical paths, with non-empty revisions.
            docs = step("get_task_documents", lambda: connector.get_task_documents(connector.plan_id))
            if not (
                available_at(docs, "compact_context", connector.context_path)
                and available_at(docs, "concept_plan", connector.plan_path)
            ):
                log["state"] = "todo"
                log["last_successful_step"] = last_successful_step
                log["failure"] = "documents_not_available"
                return log
            log["registered"] = True

            # Guard: the orchestrator must NOT move the Board before REGISTERED.
            if force_premature_advance:
                log["state"] = "todo"
                log["last_successful_step"] = "register_both"
                log["failure"] = "premature_board_advance_rejected"
                return log

            # 5. Board move + readback.
            move = step("move_to_in_progress", lambda: connector.move_task_to_in_progress(connector.plan_id))
            readback = step("read_task", lambda: connector.read_task(connector.plan_id))
            if readback.get("status") != "in_progress":
                log["state"] = readback.get("status", "unknown")
                log["last_successful_step"] = "move_called" if move["ok"] else "register_both"
                log["failure"] = "readback_not_in_progress" if move["ok"] else move.get("error", "move_failed")
                return log
            log["state"] = "in_progress"
            log["last_successful_step"] = "board_moved"
            return log

        # Scenario 1: clean run.
        plan_id = "task_clean_run"
        connector = FakeConnector(plan_id=plan_id, context_id=plan_id)
        fs = FakeFilesystem(plan_id=plan_id)
        reply = (f"CONCEPT_READY: created both files\n"
                 f"Task-ID: {plan_id} verified\n")
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "in_progress")
        self.assertEqual(result["last_successful_step"], "board_moved")
        self.assertEqual(connector.registrations,
                         [("compact_context", connector.context_path),
                          ("concept_plan", connector.plan_path)])
        self.assertEqual(connector.registration_calls, [])
        self.assertEqual(connector.binding_calls, [(plan_id, connector.context_path, connector.plan_path)])
        self.assertEqual(result["actions"], ["get_existing_task_documents", "add_task_document_bindings",
                                            "get_task_documents", "move_to_in_progress", "read_task"])
        self.assertEqual(connector.moves, [plan_id])
        self.assertEqual(connector.readbacks, [plan_id])

        # Scenario 2: premature-Board-advance guard. The orchestrator is offered a
        # forced bypass; the guard must hold.
        connector = FakeConnector(plan_id="task_guard", context_id="task_guard")
        fs = FakeFilesystem(plan_id="task_guard")
        reply = "CONCEPT_READY: created both files\nTask-ID: task_guard verified\n"
        result = run_orchestrator(reply, connector, fs, force_premature_advance=True)
        self.assertEqual(result["state"], "todo")
        self.assertEqual(result["failure"], "premature_board_advance_rejected")
        self.assertEqual(connector.moves, [])
        self.assertEqual(connector.readbacks, [])

        # Scenario 3: partial registration. Plan registration succeeds; context
        # registration fails. Board stays todo; the successful plan registration
        # is preserved and must not be duplicated on retry.
        connector = FakeConnector(
            plan_id="task_partial", context_id="task_partial",
            register_fail="compact_context", bundle_available=False)
        fs = FakeFilesystem(plan_id="task_partial")
        reply = "CONCEPT_READY: created both files\nTask-ID: task_partial verified\n"
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "todo")
        self.assertEqual(result["last_successful_step"], "register_plan")
        self.assertEqual(connector.registration_calls,
                         [("concept_plan", connector.plan_path),
                          ("compact_context", connector.context_path)])
        self.assertEqual(connector.registrations,
                         [("concept_plan", connector.plan_path)])
        self.assertEqual(connector.moves, [])

        # Retry after re-authorization: preserve the plan registration and
        # register only the previously failed context role.
        connector.register_fail = None
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "in_progress")
        self.assertEqual(connector.registration_calls,
                         [("concept_plan", connector.plan_path),
                          ("compact_context", connector.context_path),
                          ("compact_context", connector.context_path)])
        self.assertEqual(connector.registrations,
                         [("concept_plan", connector.plan_path),
                          ("compact_context", connector.context_path)])
        self.assertEqual(connector.moves, ["task_partial"])

        # Scenario 4: move failure. Both registrations succeed and read back;
        # the Board move returns uncertain. Board stays todo; registrations are
        # preserved; no retry on uncertainty.
        connector = FakeConnector(
            plan_id="task_move_fail", context_id="task_move_fail",
            move_status="uncertain")
        fs = FakeFilesystem(plan_id="task_move_fail")
        reply = "CONCEPT_READY: created both files\nTask-ID: task_move_fail verified\n"
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "todo")
        self.assertEqual(result["last_successful_step"], "register_both")
        self.assertEqual(connector.moves, ["task_move_fail"])
        # Only one move call on uncertainty; no silent retry.
        self.assertEqual(len(connector.moves), 1)

        # Scenario 5: orphan-files reuse. A previous interrupted run already
        # left matching files at the canonical paths with matching Task-IDs.
        # The orchestrator reuses them: registers both, reads back, moves.
        # No recreate, no rename; the orchestrator does not consult the agent
        # for file creation when files already exist and verify.
        connector = FakeConnector(
            plan_id="task_orphan", context_id="task_orphan")
        fs = FakeFilesystem(plan_id="task_orphan")
        # The agent reply in the orphan case still carries CONCEPT_READY with
        # verified paths/IDs (the agent's role is the same: verify and report).
        reply = ("CONCEPT_READY: verified existing files at canonical paths\n"
                 f"Task-ID: task_orphan verified\n")
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "in_progress")
        self.assertEqual(connector.registrations,
                         [("compact_context", connector.context_path),
                          ("concept_plan", connector.plan_path)])

        # Scenario 6: foreign Task-ID collision. The context path belongs to
        # another task. The orchestrator stops with todo and does not overwrite,
        # rename, or move the Board.
        connector = FakeConnector(
            plan_id="task_collision", context_id="task_collision",
            context_owned_by="task_someone_else")
        fs = FakeFilesystem(
            plan_id="task_collision",
            context_owned_by="task_someone_else")
        reply = ("CONCEPT_READY: created both files\n"
                 f"Task-ID: task_collision verified\n")
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "todo")
        self.assertEqual(result["failure"], "context path collision")
        self.assertEqual(connector.registrations, [])
        self.assertEqual(connector.moves, [])
        self.assertEqual(connector.readbacks, [])

        # Scenario 7: task-document readback must be available, point at the
        # canonical file and include a revision before the Board may move.
        invalid_readbacks = (
            {"document_state": "pending"},
            {"document_path_overrides": {"concept_plan": "elsewhere/plan.md"}},
            {"document_revision": None},
        )
        for options in invalid_readbacks:
            connector = FakeConnector(
                plan_id="task_bad_readback", context_id="task_bad_readback",
                **options)
            fs = FakeFilesystem(plan_id="task_bad_readback")
            reply = ("CONCEPT_READY: created both files\n"
                     "Task-ID: task_bad_readback verified\n")
            result = run_orchestrator(reply, connector, fs)
            self.assertEqual(result["state"], "todo")
            self.assertEqual(result["failure"], "documents_not_available")
            self.assertEqual(connector.moves, [])

        # Scenario 8: a successful move response is insufficient unless the
        # Board readback confirms in_progress.
        connector = FakeConnector(
            plan_id="task_bad_board_readback", context_id="task_bad_board_readback",
            board_readback_status="todo")
        fs = FakeFilesystem(plan_id="task_bad_board_readback")
        reply = ("CONCEPT_READY: created both files\n"
                 "Task-ID: task_bad_board_readback verified\n")
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "todo")
        self.assertEqual(result["failure"], "readback_not_in_progress")
        self.assertEqual(connector.moves, ["task_bad_board_readback"])
        self.assertEqual(connector.readbacks, ["task_bad_board_readback"])

        # Bundle failure never falls back to register or partially publishes.
        for error in ("TASK_DOCUMENT_MISMATCH", "TASK_DOCUMENT_PATH_INVALID", "TASK_DOCUMENT_CONFLICT"):
            connector = FakeConnector(plan_id="task_bundle_error", context_id="task_bundle_error", bundle_fail=error)
            fs = FakeFilesystem(plan_id="task_bundle_error")
            snapshot = vars(fs).copy()
            result = run_orchestrator("CONCEPT_READY:\nTask-ID: task_bundle_error", connector, fs)
            self.assertEqual(result["failure"], error)
            self.assertEqual(connector.registrations, [])
            self.assertEqual(connector.registration_calls, [])
            self.assertEqual(connector.moves, [])
            self.assertEqual(connector.binding_publications, 0)
            self.assertEqual(vars(fs), snapshot)

        connector = FakeConnector(plan_id="task_replay", context_id="task_replay", bundle_fail="uncertain_after_commit")
        fs = FakeFilesystem(plan_id="task_replay")
        reply = "CONCEPT_READY:\nTask-ID: task_replay"
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "todo")
        self.assertEqual(connector.moves, [])
        self.assertEqual(len(connector.binding_calls), 1)
        self.assertEqual(result["actions"][-1], "reconcile_task_documents")
        connector.bundle_fail = None  # Explicit authorized resume after read-only reconciliation.
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "in_progress")
        self.assertEqual(connector.binding_publications, 1)
        self.assertEqual(len(connector.registrations), 2)
        self.assertEqual(connector.registration_calls, [])
        self.assertEqual(len(connector.moves), 1)

        # Existing single role plus bundle adds only the missing role; wrong binding blocks all.
        for conflicting in (False, True):
            connector = FakeConnector(plan_id="task_existing", context_id="task_existing")
            connector.registrations = [("compact_context", "other.compact.md" if conflicting else connector.context_path)]
            fs = FakeFilesystem(plan_id="task_existing")
            result = run_orchestrator("CONCEPT_READY:\nTask-ID: task_existing", connector, fs)
            self.assertEqual(len(connector.registrations), 1 if conflicting else 2)
            self.assertEqual(connector.binding_publications, 0 if conflicting else 1)
            self.assertEqual(len(connector.moves), 0 if conflicting else 1)

        # Move may have committed despite uncertain response; readback resolves it, no second move.
        connector = FakeConnector(plan_id="task_move_committed", context_id="task_move_committed",
                                  move_status="uncertain", move_commits_uncertain=True)
        result = run_orchestrator("CONCEPT_READY:\nTask-ID: task_move_committed", connector,
                                  FakeFilesystem(plan_id="task_move_committed"))
        self.assertEqual(result["state"], "in_progress")
        self.assertEqual(len(connector.moves), 1)
        self.assertEqual(len(connector.readbacks), 1)

        # Sanity check: path-only CONCEPT_READY (no actual Task-ID from the head
        # block) is rejected without any registration call. This is the canonical
        # "hallucinated path" guard from the regression row.
        connector = FakeConnector(
            plan_id="task_path_only", context_id="task_path_only")
        fs = FakeFilesystem(plan_id="task_path_only")
        reply = ("CONCEPT_READY: created both files at canonical paths\n")
        result = run_orchestrator(reply, connector, fs)
        self.assertEqual(result["state"], "todo")
        self.assertEqual(result["failure"],
                         "missing actual Task-ID from head block")
        self.assertEqual(connector.registrations, [])
        self.assertEqual(connector.moves, [])

    def test_additive_task_write_skill_contract_and_note_flow(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        for path in ("SKILL.md", "references/board-workflow.md", "references/initialization-follow-through.md",
                     "references/task-concept-plan.md", "references/task-compact-context.md"):
            text = (source / path).read_text()
            self.assertIn("add_task_document_bindings", text)
            self.assertIn("get_task_documents", text)
        workflow = (source / "references/board-workflow.md").read_text()
        for term in ("add_task_management_note", "get_task_management_history", "non-idempotent",
                     "never blindly retry", "initialization create no notes", "legacy Description",
                     "after_checkpoint", "approval UI"):
            self.assertIn(term.lower(), workflow.lower() + (source / "SKILL.md").read_text().lower())

        # Synthetic client-decision model; actual service semantics are covered by adapter tests.
        class Notes:
            def __init__(self, available=True, uncertain=False):
                self.available = available
                self.uncertain = uncertain
                self.description = "Original\n"
                self.status = "todo"
                self.entries = []
                self.calls = []

            def read(self):
                self.calls.append("get_project_task")
                return {"description": self.description, "status": self.status}

            def append(self, note):
                self.calls.append("add_task_management_note")
                self.entries.append({"entry_id": "entry-1", "sequence": 1, "text": note.strip()})
                return not self.uncertain

            def history(self):
                self.calls.append("get_task_management_history")
                return list(self.entries)

        def request_note(connector, note=None):
            before = connector.read()
            if note is None:  # Status/summary/remainder/initialization is not a note request.
                return before
            if not connector.available:
                return {"error": "unsupported"}
            connector.append(note)
            return {"task": connector.read(), "history": connector.history()}  # Reconcile even on lost response, no retry/general edit.

        for uncertain in (False, True):
            notes = Notes(uncertain=uncertain)
            result = request_note(notes, " Follow up ")
            self.assertEqual(result, {"task": {"description": "Original\n", "status": "todo"},
                                      "history": [{"entry_id": "entry-1", "sequence": 1, "text": "Follow up"}]})
            self.assertEqual(notes.calls, ["get_project_task", "add_task_management_note", "get_project_task", "get_task_management_history"])
        notes = Notes()
        request_note(notes)
        self.assertEqual(notes.calls, ["get_project_task"])
        notes = Notes(available=False)
        self.assertEqual(request_note(notes, "Missing"), {"error": "unsupported"})
        self.assertEqual(notes.calls, ["get_project_task"])

    def test_worktree_and_work_package_reference_contract(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        manifest, _ = BUILDER.package_content(ROOT)
        skill = (source / "SKILL.md").read_text()
        worktrees = (source / "references/worktree-ownership.md").read_text()
        packages = (source / "references/work-packages.md").read_text()
        board = (source / "references/board-workflow.md").read_text()
        context = (source / "references/task-compact-context.md").read_text()
        plan = (source / "references/task-concept-plan.md").read_text()
        followthrough = (source / "references/initialization-follow-through.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        docs = (ROOT / "docs/CHATGPT.md").read_text()

        self.assertIn("references/work-packages.md", manifest["files"])
        self.assertIn("references/worktree-ownership.md", manifest["files"])
        self.assertIn(manifest["revision"], skill)
        self.assertIn(f'## {manifest["revision"]}', (source / "CHANGELOG.md").read_text())
        for text in (skill, packages, board, followthrough, scenarios):
            self.assertIn("WORK_PACKAGE_READY", text)
        for required in ("base HEAD", "one active writer", "verify every write target", "operator-only"):
            self.assertIn(required.lower(), worktrees.lower())
        for required in ("TASK_SEARCH_INCOMPLETE", "todo", "registered", "Morning Handoff",
                         "ChatGPT Work", "OpenCode runtime", "get_recommended_runtime",
                         "do not translate an OpenCode provider/model/variant id", "INPUT_REQUIRED"):
            self.assertIn(required.lower(), packages.lower())
        self.assertIn("package gate **after** `REGISTERED`", board)
        self.assertIn("additional prerequisite after `REGISTERED`", board)
        self.assertIn("external acceptance", context.lower())
        self.assertIn("integration-tree `HEAD`", packages)
        self.assertIn("ChatGPT Work" , docs)
        self.assertIn("do not set or map to the ChatGPT Work model picker", docs)
        for required in ("Ownership is repository-wide", "canonical **document root**",
                         "serially publishes", "hash written in C/P does not keep",
                         "--ignored", "cooperating-writer convention"):
            self.assertIn(required, worktrees)
        for required in ("before each actual dispatch", "failed reevaluation invalidates",
                         "Empty/unknown waves", "additional prerequisite after `REGISTERED`"):
            self.assertIn(required.lower(), (skill + packages + board).lower())
        self.assertIn("including on orphan recovery", followthrough)
        self.assertIn("member-specific task-file handoffs", packages)

        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        expected_rows = (
            "Two independent agent-managed tasks will write simultaneously",
            "The MCP session's directory is the project root but a task worktree is nested below it",
            "The expected downstream base changed after a predecessor was integrated",
            "Two member plans touch a shared hunk/version/package/adapter/skill/release file",
            "A member is blocked by a genuine product or architecture decision while an independent wave is ready",
            "A member is Board `done` but its commit is required by a downstream implementation",
            "Cleanup is requested with an active worker, dirty/untracked state, unreviewed result or uncertain integration",
            "User supplies existing task IDs for a package",
            "User supplies a goal or a mixture of required and optional tasks",
            "A package is created in `todo` while one member lacks a concept plan or decision",
            "Package C/P are registered, but a required decision, worktree, base or tool target is not ready",
            "Package wave passes all readiness evidence",
            "A Work Package is started from ordinary Chat after `WORK_PACKAGE_READY`",
            "A suitable ChatGPT Work session is already active",
            "A deterministic ready wave has a current configured `execution` profile",
            "A normal multi-task plan or a complex unresolved integration has a current policy",
            "Two Work Packages reference the same active member or integration tree",
            "A worker updates C/P in its isolated worktree while the connector reads canonical project-root documents",
            "A detached source was semantically ported but its SHA is not reachable from the target",
            "A previously ready wave fails a current ownership, revision, membership or business-input check",
            "A proposed wave is empty, includes unknown members or has a prerequisite cycle",
        )
        for title in expected_rows:
            with self.subTest(scenario=title):
                self.assertIn(title, rows)
                self.assertTrue(rows[title])

    def test_work_package_readiness_ownership_and_resume_flow(self):
        """Exercise the client-side ownership/readiness checkpoints with disposable fakes."""

        class Worktrees:
            def __init__(self):
                self.owners = {}
                self.records = {}

            def claim(self, task_id, path, owner, base, *, actual_write_target):
                path = str(Path(path).resolve())
                if task_id in self.records or path in self.owners or not actual_write_target:
                    return False
                self.owners[path] = owner
                self.records[task_id] = {"path": path, "owner": owner, "base": base,
                                         "head": base, "dirty": False}
                return True

            def write(self, task_id, destination):
                destination = str(Path(destination).resolve())
                record = self.records[task_id]
                if destination != record["path"] or self.owners.get(destination) != record["owner"]:
                    return False
                record["dirty"] = True
                return True

            def cleanup(self, task_id, *, integrated, reviewed, owner_stopped, authorized,
                        external_acceptance_complete=True):
                record = self.records[task_id]
                if not (integrated and reviewed and owner_stopped and authorized and
                        external_acceptance_complete and not record["dirty"] and
                        not record.get("untracked") and not record.get("ignored_result")):
                    return False
                self.owners.pop(record["path"])
                self.records.pop(task_id)
                return True

        class Package:
            def __init__(self, members):
                self.members = {member["id"]: dict(member) for member in members}
                self.context = {"members": list(self.members), "results": {}, "integrations": []}
                self.documents_registered = False
                self.status = "todo"
                self.document_revision = "documents-1"
                self.ready_waves = {}

            @classmethod
            def create(cls, member_ids, *, complete_search, authorized, member_data):
                if not complete_search:
                    return None, "search_incomplete"
                if not authorized:
                    return None, "not_authorized"
                stable_ids = list(dict.fromkeys(member_ids))
                if not stable_ids or any(item not in member_data for item in stable_ids):
                    return None, "missing_member"
                if any(member_data[item].get("superseded") for item in stable_ids):
                    return None, "superseded_member"
                return cls([member_data[item] for item in stable_ids]), None

            def snapshot(self, wave, target_head):
                # Test-only snapshot of discovered inputs, not a product persistence schema.
                return json.dumps({"documents": self.document_revision,
                                   "registered": self.documents_registered, "head": target_head,
                                   "members": self.members, "results": self.context["results"]}, sort_keys=True)

            def ready(self, wave, *, target_head):
                self.ready_waves.pop(tuple(wave), None)
                if (not self.documents_registered or not wave or len(set(wave)) != len(wave) or
                        any(item not in self.members for item in wave)):
                    return False

                def acyclic(member_id, visiting, visited):
                    if member_id in visiting or member_id not in self.members:
                        return False
                    if member_id in visited:
                        return True
                    visiting.add(member_id)
                    for dependency in self.members[member_id].get("dependencies", []):
                        if not acyclic(dependency, visiting, visited):
                            return False
                    visiting.remove(member_id)
                    visited.add(member_id)
                    return True

                if not all(acyclic(item, set(), set()) for item in wave):
                    return False
                for member_id in wave:
                    member = self.members[member_id]
                    if (member.get("input_required") or not member["concept_ready"] or not member["scope_ready"] or
                            (member.get("mutating", True) and not member["worktree_ready"])):
                        return False
                    if member.get("required_head") and target_head != member["required_head"]:
                        return False
                    if any(not self.context["results"].get(dependency, {}).get("verified")
                           for dependency in member.get("dependencies", [])):
                        return False
                self.ready_waves[tuple(wave)] = self.snapshot(wave, target_head)
                return True

            def move_to_progress(self, wave, target_head="base-0"):
                if self.ready_waves.get(tuple(wave)) != self.snapshot(wave, target_head):
                    self.ready_waves.pop(tuple(wave), None)
                    return False
                self.status = "in_progress"
                return True

            def morning(self, *, documents, original_results, git_state):
                gaps = [item for item, member in self.members.items()
                        if member.get("requires_result") and item not in original_results]
                next_step = "verify required integration HEAD before dependent wave"
                if not all(documents.get(role) == "available" for role in ("C", "P")):
                    next_step = "recover canonical documents before dispatch"
                elif gaps:
                    next_step = "retrieve missing original results before dispatch"
                return {"members": self.context["members"], "documents": documents,
                        "results": original_results, "git": git_state,
                        "evidence_gaps": gaps, "next": next_step}

            def recommend(self, *, fully_specified, conflicts, explicit=None):
                if explicit:
                    return explicit
                if conflicts:
                    return "deep"
                if fully_specified:
                    return "execution"
                return "standard"

            def resolve_runtime(self, *, status, recommendation=None, current=None):
                if status == "available":
                    return recommendation
                if status == "unconfigured":
                    return current
                raise ValueError(status)  # Configured outage/incomplete is not an absence fallback.

        member_data = {
            "member_ready": {"id": "member_ready", "board": "in_progress", "concept_ready": True,
                             "worktree_ready": True, "scope_ready": True},
            "member_unready": {"id": "member_unready", "board": "todo", "concept_ready": False,
                                "worktree_ready": False, "scope_ready": True},
            "member_dependent": {"id": "member_dependent", "board": "todo", "concept_ready": True,
                                  "worktree_ready": True, "scope_ready": True,
                                  "required_head": "integrated-foundation"},
            "member_done": {"id": "member_done", "board": "done", "concept_ready": True,
                            "worktree_ready": True, "scope_ready": True},
        }

        package, error = Package.create(
            ["member_ready", "member_ready", "member_unready", "member_done", "member_dependent"],
            complete_search=True, authorized=True, member_data=member_data)
        self.assertIsNone(error)
        self.assertEqual(package.status, "todo")
        self.assertEqual(package.context["members"], ["member_ready", "member_unready", "member_done",
                                                     "member_dependent"])
        package.documents_registered = True
        self.assertFalse(package.ready(["member_unready"], target_head="base-0"))
        self.assertFalse(package.move_to_progress(["member_unready"]))
        self.assertEqual(package.status, "todo")  # Not ready is a documented todo preparation state.
        self.assertTrue(package.ready(["member_ready", "member_done"], target_head="base-0"))
        self.assertTrue(package.move_to_progress(["member_ready", "member_done"]))
        self.assertEqual(package.status, "in_progress")
        self.assertIn("member_done", package.context["members"])  # Done members remain integration evidence.

        # A blocked member does not prevent an unrelated ready member/wave.
        package.members["member_unready"]["input_required"] = True
        self.assertTrue(package.ready(["member_ready"], target_head="base-0"))
        self.assertFalse(package.ready(["member_dependent"], target_head="base-0"))
        package.context["integrations"].append({"source": "foundation", "target": "integrated-foundation"})
        self.assertTrue(package.ready(["member_dependent"], target_head="integrated-foundation"))

        worktrees = Worktrees()
        self.assertFalse(worktrees.claim("bad_target", "/repo/wt/bad", "worker-bad", "base-0",
                                         actual_write_target=False))
        self.assertTrue(worktrees.claim("member_a", "/repo/wt/member_a", "worker-a", "base-0",
                                        actual_write_target=True))
        self.assertTrue(worktrees.claim("member_b", "/repo/wt/member_b", "worker-b", "base-0",
                                        actual_write_target=True))
        self.assertFalse(worktrees.claim("member_c", "/repo/wt/member_a", "worker-c", "base-0",
                                         actual_write_target=True))
        self.assertFalse(worktrees.write("member_a", "/repo/root"))
        self.assertTrue(worktrees.write("member_a", "/repo/wt/member_a"))
        self.assertFalse(worktrees.cleanup("member_a", integrated=True, reviewed=True,
                                           owner_stopped=True, authorized=True))
        worktrees.records["member_a"]["dirty"] = False
        self.assertFalse(worktrees.cleanup("member_a", integrated=True, reviewed=True,
                                           owner_stopped=False, authorized=True))
        self.assertFalse(worktrees.cleanup("member_a", integrated=True, reviewed=True,
                                           owner_stopped=True, authorized=True,
                                           external_acceptance_complete=False))
        self.assertTrue(worktrees.cleanup("member_a", integrated=True, reviewed=True,
                                          owner_stopped=True, authorized=True))

        # Search gaps and missing package authorization never create a package.
        self.assertEqual(Package.create(["x"], complete_search=False, authorized=True,
                                        member_data={})[1], "search_incomplete")
        self.assertEqual(Package.create(["x"], complete_search=True, authorized=False,
                                        member_data={})[1], "not_authorized")
        # Runtime advice distinguishes deterministic, normal, conflict and unavailable cases.
        self.assertEqual(package.recommend(fully_specified=True, conflicts=False), "execution")
        self.assertEqual(package.recommend(fully_specified=False, conflicts=False), "standard")
        self.assertEqual(package.recommend(fully_specified=False, conflicts=True), "deep")
        self.assertEqual(package.recommend(fully_specified=True, conflicts=True, explicit="standard"), "standard")
        tuple_from_policy = ("fixture-provider", "fixture-model", "fixture-variant")
        self.assertEqual(package.resolve_runtime(status="available", recommendation=tuple_from_policy),
                         tuple_from_policy)
        self.assertEqual(package.resolve_runtime(status="unconfigured", current="suitable-current"),
                         "suitable-current")
        for status in ("unavailable", "catalog_incomplete", "unsupported"):
            with self.subTest(runtime_status=status):
                with self.assertRaisesRegex(ValueError, status):
                    package.resolve_runtime(status=status, current="suitable-current")
        handoff = package.morning(documents={"C": "available", "P": "available"},
                                  original_results={"member_ready": "finish:stop"},
                                  git_state={"HEAD": "integrated-foundation", "dirty": False})
        self.assertEqual(handoff["next"], "verify required integration HEAD before dependent wave")
        self.assertEqual(handoff["results"]["member_ready"], "finish:stop")

        # Negative controls missing in the initial 20-test acceptance.
        package.status = "todo"
        self.assertTrue(package.ready(["member_dependent"], target_head="integrated-foundation"))
        package.members["member_dependent"]["concept_ready"] = False
        self.assertFalse(package.ready(["member_dependent"], target_head="integrated-foundation"))
        self.assertFalse(package.move_to_progress(["member_dependent"], "integrated-foundation"))
        self.assertEqual(package.status, "todo")
        self.assertFalse(package.ready([], target_head="integrated-foundation"))
        self.assertFalse(worktrees.claim("member_b", "/repo/wt/duplicate-b", "another-package", "base-0",
                                         actual_write_target=True))
        self.assertFalse(worktrees.claim("alias", "/repo/wt/../wt/member_b", "another-package", "base-0",
                                         actual_write_target=True))
        for field in ("untracked", "ignored_result"):
            worktrees.records["member_b"][field] = True
            self.assertFalse(worktrees.cleanup("member_b", integrated=True, reviewed=True,
                                               owner_stopped=True, authorized=True))
            worktrees.records["member_b"][field] = False

        # Readiness cannot survive changed revisions/base/membership or a business blocker.
        package.members["member_dependent"]["concept_ready"] = True
        self.assertTrue(package.ready(["member_dependent"], target_head="integrated-foundation"))
        self.assertFalse(package.move_to_progress(["member_dependent"], "newer-unverified-head"))
        self.assertTrue(package.ready(["member_ready"], target_head="base-0"))
        package.document_revision = "documents-2"
        self.assertFalse(package.move_to_progress(["member_ready"]))
        self.assertTrue(package.ready(["member_ready"], target_head="base-0"))
        package.members["member_ready"]["input_required"] = True
        self.assertFalse(package.ready(["member_ready"], target_head="base-0"))
        self.assertFalse(package.move_to_progress(["member_ready"]))
        package.members["member_ready"]["input_required"] = False
        self.assertTrue(package.ready(["member_ready"], target_head="base-0"))
        package.members.pop("member_ready")
        package.context["members"].remove("member_ready")
        self.assertFalse(package.move_to_progress(["member_ready"]))
        self.assertFalse(package.ready(["unknown"], target_head="base-0"))

        # Read-only waves do not require a write worktree; cyclic prerequisites do not start.
        package.members["member_unready"].update(concept_ready=True, mutating=False, input_required=False)
        self.assertTrue(package.ready(["member_unready"], target_head="base-0"))
        package.members["member_unready"]["dependencies"] = ["member_dependent"]
        package.members["member_dependent"]["dependencies"] = ["member_unready"]
        self.assertFalse(package.ready(["member_unready"], target_head="integrated-foundation"))
        package.members["member_dependent"]["dependencies"] = []
        self.assertFalse(package.ready(["member_unready"], target_head="integrated-foundation"))
        package.context["results"]["member_dependent"] = {"verified": True}
        self.assertTrue(package.ready(["member_unready"], target_head="integrated-foundation"))
        package.status = "in_progress"
        package.members["member_unready"]["input_required"] = True
        self.assertFalse(package.ready(["member_unready"], target_head="integrated-foundation"))
        self.assertEqual(package.status, "in_progress")  # Park wave, do not roll back Board.

        self.assertEqual(Package.create(["unknown"], complete_search=True, authorized=True,
                                        member_data=member_data)[1], "missing_member")
        superseded = {"old": {"id": "old", "superseded": True}}
        self.assertEqual(Package.create(["old"], complete_search=True, authorized=True,
                                        member_data=superseded)[1], "superseded_member")

        # A fresh manager consumes reread persisted inputs, not an earlier chat registry.
        restored = Package(list(json.loads(json.dumps(package.members)).values()))
        restored.context = json.loads(json.dumps(package.context))
        restored.members["member_done"]["requires_result"] = True
        morning = restored.morning(documents={"C": "available", "P": "available"},
                                   original_results={}, git_state={"HEAD": "integrated-foundation"})
        self.assertIn("member_done", morning["members"])
        self.assertEqual(morning["evidence_gaps"], ["member_done"])
        self.assertEqual(morning["next"], "retrieve missing original results before dispatch")
        missing_docs = restored.morning(documents={"C": "missing", "P": "available"},
                                        original_results={}, git_state={})
        self.assertEqual(missing_docs["next"], "recover canonical documents before dispatch")

    def test_git_worktrees_isolate_indexes_and_shared_hunks_need_reconciliation(self):
        """Verify the Git behavior used by the documented worktree contract."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            worktrees = Path(temporary) / "worktrees"
            worktrees.mkdir()

            def git(cwd, *args, check=True):
                return subprocess.run(["git", *args], cwd=cwd, check=check,
                                      capture_output=True, text=True)

            git(root, "init", "-q", "-b", "main")
            git(root, "config", "user.name", "Skill Test")
            git(root, "config", "user.email", "skill-test@example.invalid")
            (root / "shared.txt").write_text("base\n")
            git(root, "add", "shared.txt")
            git(root, "commit", "-q", "-m", "baseline")

            task_a = worktrees / "task-a"
            task_b = worktrees / "task-b"
            git(root, "worktree", "add", "-q", "-b", "task/a", str(task_a), "HEAD")
            git(root, "worktree", "add", "-q", "-b", "task/b", str(task_b), "HEAD")
            self.assertEqual(Path(git(task_a, "rev-parse", "--show-toplevel").stdout.strip()), task_a)
            self.assertEqual(Path(git(task_b, "rev-parse", "--show-toplevel").stdout.strip()), task_b)
            git_dir_a = git(task_a, "rev-parse", "--absolute-git-dir").stdout.strip()
            git_dir_b = git(task_b, "rev-parse", "--absolute-git-dir").stdout.strip()
            common_a = git(task_a, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
            common_b = git(task_b, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
            self.assertNotEqual(git_dir_a, git_dir_b)
            self.assertEqual(common_a, common_b)

            (task_a / "a-only.txt").write_text("a\n")
            git(task_a, "add", "a-only.txt")
            self.assertIn("a-only.txt", git(task_a, "status", "--short").stdout)
            self.assertEqual(git(task_b, "status", "--short").stdout, "")
            self.assertEqual(git(root, "status", "--short").stdout, "")
            git(task_a, "commit", "-q", "-m", "task a independent file")

            (task_b / "b-only.txt").write_text("b\n")
            git(task_b, "add", "b-only.txt")
            self.assertIn("b-only.txt", git(task_b, "status", "--short").stdout)
            self.assertEqual(git(task_a, "status", "--short").stdout, "")
            git(task_b, "commit", "-q", "-m", "task b independent file")

            (task_a / "shared.txt").write_text("from task a\n")
            git(task_a, "add", "shared.txt")
            git(task_a, "commit", "-q", "-m", "task a shared hunk")
            (task_b / "shared.txt").write_text("from task b\n")
            git(task_b, "add", "shared.txt")
            git(task_b, "commit", "-q", "-m", "task b shared hunk")
            git(root, "merge", "--no-ff", "--no-edit", "task/a")
            conflict = git(root, "merge", "--no-ff", "--no-edit", "task/b", check=False)
            self.assertNotEqual(conflict.returncode, 0)
            self.assertTrue((root / "shared.txt").read_text().startswith("<<<<<<<"))
            git(root, "merge", "--abort")
            self.assertEqual(git(root, "status", "--short").stdout, "")

    def test_nested_worktree_resume_cleanup_and_detached_source_retention(self):
        """Real disposable Git evidence; not a macOS/Lima or Hosted-agent acceptance."""
        with tempfile.TemporaryDirectory() as temporary:
            root = (Path(temporary) / "repo")
            root.mkdir()
            root = root.resolve()

            def git(cwd, *args, check=True):
                return subprocess.run(["git", "-c", "user.name=Skill QA",
                                       "-c", "user.email=skill-qa@example.invalid", *args],
                                      cwd=cwd, check=check, capture_output=True, text=True, timeout=15)

            git(root, "init", "-q", "-b", "main")
            (root / ".gitignore").write_text(".opencode-vm/\n*.result\n")
            (root / "base.txt").write_text("baseline\n")
            git(root, "add", ".gitignore", "base.txt")
            git(root, "commit", "-q", "-m", "baseline")
            base = git(root, "rev-parse", "HEAD").stdout.strip()
            worktrees = root / ".opencode-vm" / "worktrees"
            worktrees.mkdir(parents=True)
            task_a, task_b = worktrees / "task-a", worktrees / "task-b"
            for path in (task_a, task_b):
                git(root, "worktree", "add", "-q", "--detach", str(path), base)
                self.assertEqual(git(path, "rev-parse", "HEAD").stdout.strip(), base)
                self.assertEqual(Path(git(path, "rev-parse", "--show-toplevel").stdout.strip()), path)

            # Two real concurrent writers, each using its own index and detached HEAD.
            def write_and_commit(path):
                filename = f"{path.name}.txt"
                (path / filename).write_text(f"owned by {path.name}\n")
                git(path, "add", filename)
                git(path, "commit", "-q", "-m", f"{path.name} local outcome")
                return git(path, "rev-parse", "HEAD").stdout.strip()

            with ThreadPoolExecutor(max_workers=2) as executor:
                source_a, source_b = list(executor.map(write_and_commit, (task_a, task_b)))
            self.assertNotEqual(source_a, source_b)
            self.assertEqual(git(root, "status", "--short", "--untracked-files=all").stdout, "")
            self.assertTrue(git(root, "check-ignore", str(task_a.relative_to(root))).stdout)
            self.assertFalse((task_a / "task-b.txt").exists())
            self.assertFalse((task_b / "task-a.txt").exists())

            # A fresh reader recovers the same worktree/base/HEAD, not the root HEAD.
            self.assertEqual(git(task_a, "rev-parse", "HEAD").stdout.strip(), source_a)
            self.assertEqual(git(root, "rev-parse", "HEAD").stdout.strip(), base)
            (task_a / "unpublished.md").write_text("uncommitted task context\n")
            removal = git(root, "worktree", "remove", str(task_a), check=False)
            self.assertNotEqual(removal.returncode, 0)
            self.assertTrue((task_a / "unpublished.md").exists())
            (task_a / "unpublished.md").unlink()  # Test-owned disposable content only.
            (task_a / "acceptance.result").write_text("required ignored acceptance evidence\n")
            self.assertEqual(git(task_a, "status", "--short").stdout, "")
            self.assertIn("acceptance.result", git(task_a, "status", "--short", "--ignored").stdout)

            # Semantic port: source isn't an ancestor, so retain a local source ref before cleanup.
            (root / "task-a.txt").write_bytes((task_a / "task-a.txt").read_bytes())
            git(root, "add", "task-a.txt")
            git(root, "commit", "-q", "-m", "reconcile task a on integration target")
            target = git(root, "rev-parse", "HEAD").stdout.strip()
            self.assertNotEqual(git(root, "merge-base", "--is-ancestor", source_a, target,
                                    check=False).returncode, 0)
            source_ref = "refs/heads/ocvm-task-a-source"
            git(root, "update-ref", source_ref, source_a, "0" * 40)
            self.assertEqual(git(root, "rev-parse", source_ref).stdout.strip(), source_a)
            preserved = root / ".opencode-vm" / "preserved-task-a.result"
            preserved.write_bytes((task_a / "acceptance.result").read_bytes())
            (task_a / "acceptance.result").unlink()
            self.assertEqual(git(task_a, "status", "--short", "--ignored").stdout, "")
            git(root, "worktree", "remove", str(task_a))
            self.assertFalse(task_a.exists())
            # Prune only this disposable fixture: a Markdown hash would not retain objects.
            git(root, "reflog", "expire", "--expire=now", "--all")
            git(root, "gc", "--prune=now")
            self.assertEqual(git(root, "cat-file", "-t", source_a).stdout.strip(), "commit")
            self.assertEqual(git(root, "rev-parse", source_ref).stdout.strip(), source_a)
            self.assertEqual(preserved.read_text(), "required ignored acceptance evidence\n")
            self.assertTrue(task_b.exists())
            self.assertEqual(git(task_b, "rev-parse", "HEAD").stdout.strip(), source_b)

    def test_monitor_reference_and_lean_contract(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        manifest, _ = BUILDER.package_content(ROOT)
        monitor = (source / "references/monitor-tasks.md").read_text()
        integration = (source / "references/integration-test-monitor.md").read_text()
        packages = (source / "references/work-packages.md").read_text()
        skill = (source / "SKILL.md").read_text()
        for name in ("monitor-tasks", "integration-test-monitor"):
            self.assertIn(f"references/{name}.md", manifest["files"])
            self.assertIn(f"references/{name}.md", skill)
        for term in ("simple first / complexity on evidence", "Operator Spot-Check",
                     "canonical current content", "No separate provenance"):
            self.assertIn(term.lower(), skill.lower())
        for term in ("strictly sequential", "delta/JIT", "only human owner",
                     "one coordinated writing agent/monitor strand", "anomaly signal"):
            self.assertIn(term, packages)
        for term in ("PARKED_INPUT_REQUIRED", "COMPLETE_PASS", "STOPPED",
                      "Direct Create", "Setup Receipt", "single-flight",
                      "32,000 UTF-16", "64 MiB", "40 KiB", "SUBMISSION_UNCERTAIN",
                     "action_key", "not MCP", "at most one", "no deep session analysis"):
            self.assertIn(term, monitor)
        for term in ("at most two", "Reserve a cycle", "focused regression first",
                     "A→B→A", "same appropriate session", "one continuation",
                     "fail-fast", "acceptance semantics", "does not automatically"):
            self.assertIn(term, integration)
        for term in ("get_task_management_history", 'mode:"latest_checkpoint"',
                     'mode:"after_checkpoint"', 'mode:"after"', "legacy_description"):
            self.assertIn(term, monitor + skill)
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in (source / "references/regression-scenarios.md").read_text().splitlines()
                if row.startswith("| ") and row.count("|") >= 3}
        expected = ("Monitor worker is RUNNING or session busy",
                    "Monitor PASS with complete evidence", "Monitor FAIL has unknown cause",
                    "Monitor diagnosis proves allowed harness fault",
                    "Monitor product/schema/security/architecture blocker",
                    "Monitor same fingerprint after two no-progress repairs",
                    "Monitor parked with no new authority",
                    "Monitor parked with later free-form Operator Resume note",
                    "Monitor current interactive operator resume",
                    "Monitor duplicate/overlapping wakeups",
                    "Monitor SUBMISSION_UNCERTAIN or interrupted post-send checkpoint",
                    "Monitor open permission/question",
                    "Monitor Wave N terminal verified before Wave N+1",
                    "Monitor missing next-wave readiness/integration",
                    "Monitor connection lost or result coverage incomplete",
                    "Monitor single-flight or scheduler not verifiable",
                     "Monitor Morning Handoff",
                     "Non-ownership Spot-Check: test environment sharing is unknown",
                     "Requested management note on a journal-capable connector",
                     "Management journal has a latest checkpoint and later decisions/notes",
                     "Management journal has older loop/fingerprint history beyond recent tail",
                     "Management append response is uncertain or journal reports a recovered suffix",
                     "Journal JSON, identity, head or record is malformed/incomplete",
                     "Existing legacy Management Notes remain in native Description",
                     "Connector lacks `get_task_management_history`")
        for name in expected:
            self.assertIn(name, rows)
            self.assertTrue(rows[name])

    def test_stage1_handoff_escalation_source_contract(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        monitor = (source / "references/monitor-tasks.md").read_text()
        bootstrap = monitor.split("```text", 1)[1].split("```", 1)[0]
        for term in ("Work/Worker", "Normal Chat/Voice", "Unknown surface", "master",
                     "C:", "P:", "Schedule:", "model", "Single-flight", "Repair limit",
                     "two concrete operational examples", "persist", "receipt/result",
                     "SCHEDULER stop", "configured cadence", "canonical"):
            self.assertIn(term.lower(), bootstrap.lower())
        for term in ("Never probe", "newest non-superseded", "captured head",
                     "checkpoint identity/generation", "Refresh the head", "Already-admitted",
                     "not identity attestation", "same two examples", "persistence unverified"):
            self.assertIn(term, monitor)
        for name in ("SKILL.md", "references/monitor-tasks.md",
                     "references/integration-test-monitor.md", "references/work-packages.md",
                     "references/board-workflow.md", "references/regression-scenarios.md"):
            text = (source / name).read_text().lower()
            self.assertNotIn("self-disable is optional", text)
            self.assertNotIn("provenance is deferred", text)
        example = monitor.split("Example shape", 1)[1].split("Fixed Description", 1)[0]
        positions = [example.index(term) for term in
                     ("test supervisor", "Example 1:", "Example 2:", "Evidence:", "Operator question:")]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("Cause remains unknown", example)
        self.assertIn("Next permissible step", example)

    def test_stage1_decision_paging_and_uncertain_escalation(self):
        """Captured-head and append-loss fixtures; no live journal or platform claim."""
        entries = [{"kind": "checkpoint", "id": "park-1"},
                   {"kind": "decision", "id": "resume-2"}]
        captured = len(entries)
        first_page = entries[:1]
        entries.append({"kind": "decision", "id": "stop-3"})
        second_page = entries[1:captured]
        # Captured pagination is internally complete but cannot authorize an action
        # until the refreshed head's newer entries have also been considered.
        covered = first_page + second_page
        self.assertEqual(covered[-1]["id"], "resume-2")
        self.assertNotEqual(captured, len(entries))
        covered += entries[captured:]
        self.assertEqual(covered[-1]["id"], "stop-3")
        # Moving latest-checkpoint shortcuts cannot erase a preceding decision.
        entries.append({"kind": "checkpoint", "id": "waiting-4", "decision": "stop-3"})
        self.assertEqual(entries[-1]["decision"], covered[-1]["id"])

        context = "Test supervisor: regression-to-resume blocked by unknown delivery."
        examples = ["A second command could duplicate the retained test run.",
                    "The next member could consume unfinished results."]
        terminal = {"context": context, "examples": examples, "cause": "unknown",
                    "reason": "delivery unresolved", "next": "reconcile original receipt"}
        store = []
        for anchor in (None, "ambiguous"):
            if anchor == "master":
                store.append(terminal)
        self.assertEqual(store, [])
        # Commit succeeded, response lost: recover exact entry, never append again.
        store.append({"entry_id": "entry-1", "master": "master", **terminal})
        readback = [e for e in store if e["entry_id"] == "entry-1" and e["master"] == "master"]
        self.assertEqual(len(readback), 1)
        for key in ("context", "examples", "cause", "reason", "next"):
            self.assertEqual(readback[0][key], terminal[key])
        self.assertEqual(len(store), 1)

    def test_stage1_fresh_wake_receipt_cadence_and_history(self):
        """Synthetic serialized snapshots, not hosted scheduler/model acceptance."""
        import json

        state = {"master": "master", "park": "park-1", "work": "PARKED_INPUT_REQUIRED",
                 "entries": [], "receipts": {}, "repairs": {"A": 2, "B": 1},
                 "scheduler": "hourly", "sends": [], "notes": []}

        def wake(saved, *, live=True, complete=True, conflict=False, scheduler_stop=False,
                 expired=False, lose_checkpoint=False):
            s = json.loads(saved)
            trace = ["master", "latest_checkpoint", "newer_decisions", "refresh_head"]
            if scheduler_stop or expired:
                s["scheduler"] = "stopped" if scheduler_stop else "expired"
                return json.dumps(s), trace
            if not complete or conflict:
                return json.dumps(s), trace
            decisions = [e for e in s["entries"] if e["master"] == s["master"]]
            d = decisions[-1] if decisions else None
            if not d or d["park"] != s["park"] or d["step"] not in ("regression", "repair"):
                return json.dumps(s), trace
            trace.append("exact_receipt")
            if d["id"] in s["receipts"]:
                trace.append("observe_or_reconcile")
                return json.dumps(s), trace
            trace.append("live_revalidate")
            if not live or (d["step"] == "repair" and s["repairs"].get("A", 0) >= 2):
                return json.dumps(s), trace
            s["sends"].append(d["id"])
            s["receipts"][d["id"]] = "uncertain" if lose_checkpoint else "admitted"
            if not lose_checkpoint:
                s["notes"].append(d["id"])
            return json.dumps(s), trace + ["send"]

        for lifecycle in ("PARKED_INPUT_REQUIRED", "COMPLETE_PASS", "STOPPED"):
            state["work"] = lifecycle
            saved = json.dumps(state)
            for _ in range(48):
                saved, trace = wake(saved)
                self.assertEqual(len(trace), 4)
            self.assertEqual(json.loads(saved), state)
        decision = {"master": "master", "park": "park-1", "id": "decision-1",
                    "step": "regression", "source_revision": "another-chat-record-2"}
        for change in ({"master": "other"}, {"park": "old-park"}, {"step": "deploy"}):
            saved, _ = wake(json.dumps(dict(state, entries=[dict(decision, **change)])))
            self.assertEqual(json.loads(saved)["sends"], [])
        snapshot = dict(state, entries=[decision])
        for guards in ({"live": False}, {"complete": False}, {"conflict": True}):
            saved, _ = wake(json.dumps(snapshot), **guards)
            self.assertEqual(json.loads(saved)["sends"], [])
            self.assertEqual(json.loads(saved)["scheduler"], "hourly")
        stopped = dict(snapshot, entries=[decision, dict(decision, id="stop-2", step="stop")])
        saved, _ = wake(json.dumps(stopped))
        self.assertEqual(json.loads(saved)["sends"], [])
        for lost in (False, True):
            saved, trace = wake(json.dumps(snapshot), lose_checkpoint=lost)
            self.assertLess(trace.index("exact_receipt"), trace.index("send"))
            for _ in range(3):
                saved, trace = wake(saved)
                self.assertNotIn("send", trace)
            recovered = json.loads(saved)
            self.assertEqual(recovered["sends"], ["decision-1"])
            self.assertEqual(recovered["repairs"], {"A": 2, "B": 1})
            self.assertEqual(recovered["scheduler"], "hourly")
        snapshot["entries"] = [dict(decision, step="repair")]
        saved, _ = wake(json.dumps(snapshot))
        self.assertEqual(json.loads(saved)["sends"], [])
        for kwargs, expected in (({"scheduler_stop": True}, "stopped"), ({"expired": True}, "expired")):
            saved, _ = wake(json.dumps(state), **kwargs)
            self.assertEqual(json.loads(saved)["scheduler"], expected)

    def test_monitor_scripted_action_traces_and_fail_closed_boundaries(self):
        """Synthetic client contract walks; no scheduler/authentication implementation.

        The fake represents platform evidence, not a new runtime engine. It exercises
        interruption/overlap and both policies as the existing package fakes do.
        Source/scenario contracts above bind the examples to shipped instructions;
        hosted model behavior still needs separate authorized pilots.
        """
        class Evidence:
            def __init__(self):
                self.lifecycle = "ACTIVE"
                self.calls = []
                self.active_supervisor = False
                self.in_flight = False
                self.uncertain = False
                self.cycles = 0

            def wake(self, event, *, single_flight=True, interactive=False,
                     live=True, integrated=True, ready=True, resumable=True):
                self.calls.append("master_read")
                if self.active_supervisor or not single_flight:
                    return "no_action"
                if self.lifecycle != "ACTIVE":
                    if not interactive:
                        return "no_action"  # This legacy trace has no canonical Resume decision.
                    self.calls.append("live_revalidate")
                    if not live or self.in_flight or self.uncertain:
                        return "no_action"
                    self.lifecycle = "ACTIVE"
                if not live or self.uncertain or event == "uncertain":
                    self.calls.append("reconcile_original")
                    return "no_action"
                if self.in_flight or event in ("running", "busy"):
                    self.calls.append("correlated_status")
                    return "no_action"
                if event in ("product", "permission", "question") or (
                        event == "repair" and self.cycles >= 2):
                    self.lifecycle = "PARKED_INPUT_REQUIRED"
                    action = "park"
                elif event == "pass":
                    self.calls.append("full_original")
                    if not integrated:
                        return "no_action"
                    self.lifecycle = "COMPLETE_PASS"
                    action = "complete"
                elif event == "wave_done":
                    self.calls.extend(["full_original", "integration_readback"])
                    if not integrated:
                        return "no_action"
                    self.calls.append("delta_readiness")
                    if not ready:
                        return "no_action"
                    action = "next_wave"
                elif event == "focused_pass":
                    self.calls.append("focused_original")
                    action = "resume" if resumable else "fresh"
                else:
                    action = {"fail_unknown": "diagnosis", "repair": "repair",
                              "fixed": "focused_regression"}[event]
                if action == "repair":
                    self.cycles += 1  # Reserved even if a later checkpoint is interrupted.
                self.calls.extend([action, "exact_readback", "checkpoint_append"])
                return action

        for event in ("running", "busy", "uncertain"):
            evidence = Evidence()
            self.assertEqual(evidence.wake(event), "no_action")
            self.assertNotIn("checkpoint_append", evidence.calls)
        for lifecycle in ("PARKED_INPUT_REQUIRED", "COMPLETE_PASS", "STOPPED"):
            evidence = Evidence()
            evidence.lifecycle = lifecycle
            self.assertEqual(evidence.wake("focused_pass"), "no_action")
            self.assertEqual(evidence.calls, ["master_read"])
        evidence = Evidence()
        evidence.lifecycle = "PARKED_INPUT_REQUIRED"
        self.assertEqual(evidence.wake("focused_pass", interactive=True, live=False), "no_action")
        self.assertEqual(evidence.lifecycle, "PARKED_INPUT_REQUIRED")
        self.assertEqual(evidence.wake("focused_pass", interactive=True), "resume")
        self.assertLess(evidence.calls.index("live_revalidate"), evidence.calls.index("resume"))
        for event in ("product", "permission", "question"):
            evidence = Evidence()
            self.assertEqual(evidence.wake(event), "park")
            self.assertEqual(evidence.lifecycle, "PARKED_INPUT_REQUIRED")
        for resumable, final in ((True, "resume"), (False, "fresh")):
            evidence = Evidence()
            for event, expected in (("fail_unknown", "diagnosis"), ("repair", "repair"),
                                    ("fixed", "focused_regression"), ("focused_pass", final)):
                start = len(evidence.calls)
                self.assertEqual(evidence.wake(event, resumable=resumable), expected)
                self.assertEqual(evidence.calls[start:].count("checkpoint_append"), 1)
            self.assertEqual(evidence.wake("pass"), "complete")
        evidence = Evidence()
        self.assertEqual(evidence.wake("repair"), "repair")
        self.assertEqual(evidence.wake("repair"), "repair")
        self.assertEqual(evidence.wake("repair"), "park")
        self.assertEqual(evidence.cycles, 2)
        evidence = Evidence()
        self.assertEqual(evidence.wake("wave_done", integrated=False), "no_action")
        self.assertNotIn("delta_readiness", evidence.calls)
        self.assertEqual(evidence.wake("wave_done", ready=False), "no_action")
        self.assertNotIn("next_wave", evidence.calls)
        self.assertEqual(evidence.wake("wave_done"), "next_wave")
        self.assertLess(evidence.calls.index("integration_readback"), evidence.calls.index("next_wave"))
        for overlap in (False, True):
            evidence = Evidence()
            evidence.active_supervisor = overlap
            self.assertEqual(evidence.wake("wave_done", single_flight=overlap), "no_action")
            self.assertEqual(evidence.calls, ["master_read"])

    def test_canonical_document_publication_preserves_newer_content_and_reconciles_uncertainty(self):
        """Filesystem workflow fixture; no claim of a native publication API/CAS."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            canonical = root / "project" / ".opencode" / "tasks" / "task-fixture.compact.md"
            worker_copy = root / "worktree" / ".opencode" / "tasks" / canonical.name
            canonical.parent.mkdir(parents=True)
            worker_copy.parent.mkdir(parents=True)
            header = b"Task-ID: task_fixture\n"
            canonical.write_bytes(header + b"baseline\n")
            read_revision = hashlib.sha256(canonical.read_bytes()).hexdigest()
            worker_copy.write_bytes(header + b"worker checkpoint\n")
            publications = []

            def publish(expected_revision, *, lost_response=False):
                if canonical.is_symlink() or not canonical.is_file():
                    return "unsafe_path"
                if hashlib.sha256(canonical.read_bytes()).hexdigest() != expected_revision:
                    return "revision_conflict"
                data = worker_copy.read_bytes()
                if not data.startswith(header):
                    return "foreign_task"
                canonical.write_bytes(data)  # Cooperating owner only, not cross-client CAS.
                publications.append(canonical)
                if lost_response:
                    raise TimeoutError("publication response lost")
                return "published"

            self.assertNotEqual(worker_copy.read_bytes(), canonical.read_bytes())
            canonical.write_bytes(header + b"newer canonical decision\n")
            self.assertEqual(publish(read_revision), "revision_conflict")
            self.assertEqual(canonical.read_bytes(), header + b"newer canonical decision\n")
            self.assertEqual(publications, [])
            # Reconcile the worker delta with the newer canonical bytes, not whole-file overwrite.
            worker_copy.write_bytes(header + b"newer canonical decision\nworker checkpoint\n")
            current_revision = hashlib.sha256(canonical.read_bytes()).hexdigest()
            with self.assertRaises(TimeoutError):
                publish(current_revision, lost_response=True)
            self.assertEqual(canonical.read_bytes(), worker_copy.read_bytes())
            self.assertEqual(publications, [canonical])  # Readback, not a second publication.
            worker_copy.write_bytes(b"Task-ID: task_foreign\nforeign body\n")
            current_revision = hashlib.sha256(canonical.read_bytes()).hexdigest()
            self.assertEqual(publish(current_revision), "foreign_task")
            self.assertEqual(publications, [canonical])
            retained_bytes = canonical.read_bytes()
            outside = root / "other-task.md"
            outside.write_bytes(retained_bytes)
            canonical.unlink()
            canonical.symlink_to(outside)
            self.assertEqual(publish(current_revision), "unsafe_path")
            self.assertEqual(outside.read_bytes(), retained_bytes)

    def test_repository_release_gate_policy_and_scenarios(self):
        """Guard the generic skill and project policy against release-gate drift."""
        project_policy = (ROOT / "docs/RELEASING.md").read_text()
        project_guidance = (ROOT / "AGENTS.md").read_text()
        chatgpt_guidance = (ROOT / "docs/CHATGPT.md").read_text()
        package_readme = (ROOT / "integrations/chatgpt/README.md").read_text()
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        release_reference = (source / "references/release-gates.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        changelog = (source / "CHANGELOG.md").read_text()
        manifest, _ = BUILDER.package_content(ROOT)

        self.assertIn("Release-completion gate and runtime continuity", project_policy)
        for required in (
            "exact candidate SHA",
            "checked-out/head commit is exactly the candidate SHA",
            "tag resolves to that same commit",
            "all five expected assets",
            "red or unverified",
            "The earlier green result does not validate the repaired commit",
            "preserve the working runtime and its recovery state",
            "Do not recommend routine pruning",
            "explicitly authorized in-scope repair demonstrably requires",
        ):
            self.assertIn(required.lower(), project_policy.lower())
        self.assertIn("docs/RELEASING.md", project_guidance)
        self.assertIn("Skill r29", chatgpt_guidance)

        self.assertIn("references/release-gates.md", manifest["files"])
        self.assertIn("references/release-gates.md", skill)
        self.assertIn("references/release-gates.md", package_readme)
        self.assertIn(f'## {manifest["revision"]}', changelog)
        self.assertIn(f'**{manifest["revision"]}**', skill)
        for required in (
            "target repository's own release policy",
            "do not infer workflow names",
            "operator",
            "exact intended candidate",
            "different newer green run",
            "new candidate commit",
            "preserve the working runtime",
            "red or unverified",
            "demonstrably requires",
        ):
            self.assertIn(required.lower(), release_reference.lower())
        for project_specific in ("task_70e6fe6a-7813-54f2-aa1a-5c068d67ca3b",
                                 "GeektankLabs", "v0.7.2", "github.com/"):
            self.assertNotIn(project_specific, release_reference)

        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in scenarios.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        wrong_commit = rows["A green workflow run belongs to a different or newer commit than the intended candidate"]
        self.assertIn("exact commit", wrong_commit)
        self.assertIn("Gate remains unverified", wrong_commit)
        repaired = rows["An authorized local repair creates a new candidate commit after an earlier green run"]
        self.assertIn("earlier run does not verify the new commit", repaired)
        runtime = rows["The expected gate is red or unverified while a working runtime is needed for current work"]
        for action in ("prune", "restart", "reconnect/reattach", "recreation", "install/update"):
            self.assertIn(action, runtime)
        interruption = rows["An explicitly authorized, in-scope repair demonstrably requires interrupting the runtime"]
        self.assertIn("technical necessity", interruption)
        self.assertIn("recovery state", interruption)


if __name__ == "__main__":
    unittest.main()
