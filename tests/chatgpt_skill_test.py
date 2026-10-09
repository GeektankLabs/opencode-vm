"""Artifact/privacy regression checks, not live ChatGPT behavior tests."""

import hashlib
import copy
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
from pathlib import Path
import re
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
    def test_integration_cleanup_decision_and_explicit_fresh_disposal_boundary(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        ownership = (source / "references/worktree-ownership.md").read_text()
        for marker in ("cleanup decision", "git worktree remove", "fresh VM", "disposal boundary",
                       "Commit/save", "locked", "Never delete source", "Board Done"):
            self.assertIn(marker, skill)
        self.assertIn("Cleanup decision is mandatory at integration handback", ownership)
        self.assertIn("scoped exception", ownership)
        self.assertIn("Attach/reconnect does not sweep", ownership)

    def test_journal_mode_is_capability_bound_and_keeps_exact_receipt_observation(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        branch = skill.split("### Journal mode before queue/event workflows\n", 1)[1].split("\n- Discover the selected", 1)[0]
        for marker in ("activity_journal", "--journal", "state:disabled", "state:ready", "state:unavailable",
                       "ACTIVITY_DISABLED", "ACTIVITY_UNAVAILABLE", "get_session_status", "get_session_progress",
                       "get_task_result", "no-blind-retry", "Task Management Journal", "post-turn timer",
                       "Re-enabling never proves coverage"):
            self.assertIn(marker, branch)
        for ref in ("events-attention.md", "progress-activity.md", "optimistic-mvp.md"):
            self.assertIn("journal-mode branch", (source / "references" / ref).read_text())

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

    def test_prepared_attention_and_event_delivery_claims_are_evidence_bound(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        attention = (source / "references/events-attention.md").read_text()
        activity = (source / "references/progress-activity.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        changelog = (source / "CHANGELOG.md").read_text()
        manifest, _ = BUILDER.package_content(ROOT)
        self.assertIn("references/events-attention.md", manifest["files"])
        self.assertIn(manifest["revision"], skill)
        self.assertIn(f'## {manifest["revision"]}', changelog)
        for text in (skill, attention, activity):
            self.assertIn("get_project_attention", text)
        for marker in ("PROACTIVE_MONITORING", "on_demand_fallback", "deferred_to_next_idle_boundary",
                       "webhook 2xx is only", "without a user turn", "audible Voice"):
            self.assertIn(marker.lower(), (skill + attention + scenarios).lower())
        self.assertIn("authorizes no prompt", attention)
        self.assertIn("Board Done", attention)
        self.assertIn("no-user-turn Work/Chat continuation", attention)

    def test_active_voice_wait_contract_is_bounded_and_receipt_correlated(self):
        """Guard shipped instructions, not an invented polling implementation or host PASS."""
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        attention = (source / "references/events-attention.md").read_text()
        activity = (source / "references/progress-activity.md").read_text()
        wait = attention.split("## Bounded active Voice wait\n", 1)[1].split("## Manual surface acceptance", 1)[0]
        for text in (skill, activity):
            self.assertIn("events-attention.md#bounded-active-voice-wait", text)
        for required in (
            "explicit active waiting intent", "actual receipt", "After actual admission",
            "three minutes", "approximately 30 seconds", "before every page/read/wait",
            "five pages per round", "two recoverable read errors total",
            "second recoverable error exhausts", "no independent timer after assistant turn completion",
            "connector/project + `session_id` + `submitted_message_id`",
            "Do **not add session_id or message_id input filters**",
            "`before_cursor`", "`after_cursor`", "never both", "opaque `next_cursor`",
            "fresh latest read", "without a new sequence", "partial coverage",
            "complete `visible_original` evidence", "`source_revision`", "supersession",
            "no repetitive speech", "explicit cancel", "host interruption/execution termination",
            "No matching complete result observed", "renewed active waiting intent",
            "not autonomous idle Voice wakeup", "no tight loop, daemon, scheduler",
        ):
            with self.subTest(required=required):
                self.assertIn(required, wait)
        self.assertIn("one appropriately scoped authorized subscription before new work admission", attention)
        self.assertIn("no message_id subscription filter", attention)
        self.assertIn("Personal push/email preferences are separate; do not modify them", attention)
        self.assertIn("Same event/revision/result is presented once", wait)
        self.assertIn("acknowledge offered only after actual presentation", wait)
        self.assertIn("Unknown audio delivery is not audible presentation", wait)

    def test_active_wait_forward_and_negative_scenarios_remain_manual_acceptance(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        scenarios = (source / "references/regression-scenarios.md").read_text()
        section = scenarios.split("## Bounded active attention wait\n", 1)[1].split("## Optional read-only smoke test", 1)[0]
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in section.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        cases = {
            "Active Voice short wait with admitted async receipt": ("after actual admission", "present complete current result once", "then stop"),
            "Send is uncertain or not admitted": ("No accepted acknowledgement", "no replacement worker"),
            "Normal Chat lacks attention tools or sustained execution": ("no fake polling", "actual tools/execution support"),
            "Queue limit 100 rejected before execution": ("maximum 50", "cadence gap", "no worker resend"),
            "Target is on a later queue page": ("has_more", "before_cursor", "partial coverage, not absence"),
            "Older new entry prepares after head cursor advanced": ("Fresh latest read", "after_cursor-only", "not completion"),
            "Unrelated session or wrong submitted user message is ready": ("Stay silent", "exact correlation"),
            "Matching error or input-required evidence arrives": ("stop waiting", "no permission answer"),
            "Event and polling return the same result": ("Deduplicate", "present once", "callback 2xx is not either"),
            "Supported subscription exists before new work": ("Reuse", "no message_id subscription filter", "unchanged"),
            "Explicit cancel during active waiting": ("Stop local reads/waits immediately", "do not cancel remote"),
            "Host interruption or different topic mid-sentence": ("Park receipt/cursors/revisions", "no READY interruption", "renewed intent"),
            "Deadline with no matching complete evidence": ("Stop at timeout", "no completion/failure claim"),
            "Host turn ends or wait primitive is unavailable": ("No independent timer", "One-shot read/fallback", "do not fabricate"),
            "Explicit 30-minute request without execution evidence": ("No long-run promise", "UNVERIFIED"),
        }
        for scenario, markers in cases.items():
            with self.subTest(scenario=scenario):
                for marker in markers:
                    self.assertIn(marker, rows[scenario])
        self.assertIn("UNVERIFIED until observed", section)
        self.assertIn("no synthetic/package PASS", section)

    def test_long_active_text_contract_preserves_defaults_and_receipt_recovery(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        attention = (source / "references/events-attention.md").read_text()
        activity = (source / "references/progress-activity.md").read_text()
        pilot = attention.split("## Long active TEXT pilot\n", 1)[1].split("## Honest monitoring communication", 1)[0]
        for text in (skill, activity):
            self.assertIn("events-attention.md#long-active-text-pilot", text)
        for required in (
            "explicitly longer active TEXT task contract", "Retain finite defaults",
            "no blanket three-minute stop", "approximately 30 seconds between rounds",
            "also while the worker is running", "actual host execution limit",
            "before every page/read/wait/admission", "five-page round budget",
            "never invented session/message filter inputs", "older sequences",
            "not after_cursor-only", "exact admitted task/session/message binding",
            "not the whole multi-step contract", "designated integrator",
            "before any next admission", "Reserve once", "persist the actual receipt",
            "not MCP idempotency", "SUBMISSION_UNCERTAIN", "never blindly send again",
            "a new event ID for the same result", "not replay dispatch",
            "two recoverable errors total per active run", "does not reset it",
            "at most two PRODUCTION-CODE repairs for the same error without evidenced progress",
            "New message, model, clock or Resume alone never resets",
            "resume checkpoint unverified", "remaining budgets", "Verify entry readback",
            "transport PASS / steering FAIL", "one-action-per-wake/cadence rules remain unchanged",
        ):
            with self.subTest(required=required):
                self.assertIn(required, pilot)
        self.assertIn("offered before discussed", attention)
        self.assertIn("known task contract", skill)
        for state in ("CURRENT_TURN_WAIT", "PROACTIVE_MONITORING", "ON_DEMAND_STATUS"):
            self.assertIn(state, attention)
        self.assertIn("Unknown/unconfigured independent recovery stays on-demand after turn end", attention)

    def test_selected_optimistic_mvp_requires_durable_evidence_and_hard_boundaries(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        policy = (source / "references/optimistic-mvp.md").read_text()
        manifest, _ = BUILDER.package_content(ROOT)
        self.assertIn("references/optimistic-mvp.md", manifest["files"])
        self.assertIn("[Optimistic MVP](references/optimistic-mvp.md)", skill)
        for required in (
            "does not activate OID", "Never self-upgrade conservative",
            "functional additive reversible variant", "moderate local rework",
            "Security/Trust", "regulatory/compliance", "data-sovereignty",
            "irreversible data/state/schema", "public/external API/contract",
            "core product semantics/architecture", "INPUT_REQUIRED",
            "safe independent steps already authorized", "clean PRE_DECISION_HEAD",
            "clean existing commit suffices", "Never reset/stash/overwrite",
            "AUTONOMOUS_MVP_DECISION", "Before implementing", "strategy_source",
            "question", "alternatives", "choice/rationale", "uncertainty",
            "reversibility/rework", "implementation_commits", "components",
            "tests/acceptance", "change_path", "cumulative_drift",
            "combined effect of all OIDs", "at most two **production-code** repairs",
            "not progress or a budget reset", "No automatic hard reset/rebase",
            "OID_COUNT=0 / OID_UNTESTED (policy-only)", "not fabricated OIDs",
        ):
            with self.subTest(required=required):
                self.assertIn(required, policy)

    def test_text_and_oid_forward_negative_instruction_scenarios(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        scenarios = (source / "references/regression-scenarios.md").read_text()
        section = scenarios.split("## Active TEXT contract and selected Optimistic MVP\n", 1)[1].split("## Optional read-only smoke test", 1)[0]
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in section.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        cases = {
            "Explicit long TEXT contract still running after three minutes": ("Continue silent", "no blanket three-minute cutoff", "no post-turn timer"),
            "Standalone wait without completion intent": ("finite defaults", "no implied long completion mode"),
            "First worker complete but known contract has remaining steps": ("next-step gates", "contract-authorized admission", "nor expand scope"),
            "Queue capability absent on selected connection": ("Park", "foreign project queue"),
            "Host execution/wait limit reached during long TEXT pilot": ("exact resume checkpoint", "unverified", "no continuing timer"),
            "Subscription delivered HTTP 200 but steering failed": ("transport PASS / steering FAIL", "cause unverified"),
            "Event and pull repeat a result with changed event ID or summary revision": ("durable action_key", "zero duplicate logical dispatch"),
            "Post-send checkpoint interrupted or SUBMISSION_UNCERTAIN": ("before any next admission", "no blind resend"),
            "Queue hierarchy unlinked but receipt identifies exact task": ("submitted-message binding", "never title heuristic"),
            "User asks for automatic notice without independent mechanism": ("CURRENT_TURN_WAIT", "ON_DEMAND_STATUS", "verified surface/runtime"),
            "Two same-error no-progress repairs or restored run budget": ("Park", "no reset", "third repair"),
            "Newer cancel or scope decision appears during active polling": ("canonical head before action", "no automatic worker abort"),
            "Offered receipt missing before discussed": ("verify offered before discussed", "never treated as a send receipt"),
            "Explicit Optimistic MVP selected and one real reversible choice arises": ("functional additive", "before implementation", "PRE_DECISION_HEAD", "commits/tests/change path"),
            "Generic finish request under established conservative contract": ("known authorized contract", "conservative override", "do not activate OID"),
            "Small OID changes Security/Trust/API/product architecture/regulation/data sovereignty": ("INPUT_REQUIRED", "no implementation"),
            "Individually small OIDs cumulatively change product/API architecture": ("combined drift", "park"),
            "OID anchor dirty or decision persistence unavailable": ("gate before decision implementation", "no reset/stash/overwrite"),
            "Selected MVP is a deliberately broken dummy": ("Reject", "functional useful"),
            "No actual decision arose during policy implementation/pilot": ("OID_COUNT=0", "no fabricated OID"),
            "Later operator supersedes implemented OID": ("Preserve prior", "reconcile receipts", "no automatic hard reset/rebase"),
        }
        for scenario, markers in cases.items():
            with self.subTest(scenario=scenario):
                for marker in markers:
                    self.assertIn(marker, rows[scenario])
        self.assertIn("synthetic PASS is not a long-run PASS", section)
        self.assertIn("Active-turn polling never proves idle wakeup", section)

    def test_r37_semantic_completion_defaults_have_scope_and_contract_precedence(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        policy = (source / "references/optimistic-mvp.md").read_text()
        attention = (source / "references/events-attention.md").read_text()
        activity = (source / "references/progress-activity.md").read_text()
        defaults = skill.split("### Completion defaults and overrides\n", 1)[1].split("## Submit authorized tasks", 1)[0]
        for marker in (
            "Clear authorized substantive implementation/completion intent",
            "active Attention Queue polling + Optimistic MVP by default",
            "not literal keywords", "need not name a strategy or cadence",
            "Explain the effective scope/strategies briefly once", "persist",
            "before dependent dispatch", "Overrides win", "start-only",
            "status/read/connection-check/planning-only/prepare-but-wait/Go-pending",
            "conservative/MVP-off/no-poll/shorter/deadline/local-only",
            "existing stricter canonical task/package/scheduler contracts",
            "No retroactive widening or implicit live scheduler modification",
            "Local-only completion excludes integration",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, defaults)
        self.assertIn("Resolve the effective contract", policy)
        self.assertIn("before admission", policy)
        self.assertIn("strategy_source", policy)
        self.assertIn("genuine new domain-detail decision", policy)
        self.assertIn("Default strategy selection is policy, not itself a domain OID", policy)
        self.assertIn("no blanket three-minute stop", attention)
        self.assertIn("default to clear authorized substantive implementation/completion intent on supported Text or Voice", attention)
        self.assertIn("best-effort about 30 seconds, not a hard SLA", attention)
        self.assertIn("standalone WAIT-only", attention)
        self.assertIn("short updates only for material findings", activity)
        self.assertNotIn("Apply only when the user explicitly selected", policy)

    def test_r37_default_resolution_forward_and_negative_cases(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        scenarios = (source / "references/regression-scenarios.md").read_text()
        section = scenarios.split("## r37 semantic completion defaults and overrides\n", 1)[1].split("## Optional read-only smoke test", 1)[0]
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in section.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        cases = {
            "Natural “Setze diesen Task um” without strategy names": ("active queue polling + Optimistic MVP defaults", "explain once", "persist effective contract/readback"),
            "Natural work-package request to checked local completion": ("semantic completion intent", "local-only excludes integration"),
            "Equivalent implementation wording contains none of the example phrases": ("not literal keyword match", "clear authorized completion"),
            "“Starte nur” or “danach nicht warten”": ("Submit only", "no completion wait", "full-delivery expansion"),
            "Status/read/connection-check request": ("Only scoped reads", "no workers, long waits or mutations"),
            "Planning-only or preparation with Go pending": ("No implementation worker", "preserve waiting gate"),
            "Explicit conservative or MVP-off": ("OID off", "INPUT_REQUIRED"),
            "Explicit no-poll": ("No completion polling loop", "no invented recovery"),
            "Explicit shorter wait or deadline during completion": ("Honor actual window/deadline", "no silent extension"),
            "Existing canonical contract stricter than r37": ("Preserve strategy/scope/cadence/horizon/budgets", "no retroactive widening"),
            "Supported Voice request to implement and complete a task": ("Default active completion beyond three minutes", "real execution", "no post-turn timer"),
            "Voice request only to wait for an existing result": ("three-minute finite default", "no new worker", "explicit duration wins"),
            "Default completion lacks queue/tools/runtime support": ("Disclose limitation", "unverified save", "no fabricated process"),
            "Genuine domain-detail choice under default Optimistic MVP": ("functional additive reversible", "PRE_DECISION_HEAD", "before implementation"),
            "Default OID touches core contract/security/trust/regulation/data sovereignty/irreversible state": ("INPUT_REQUIRED", "no permission bypass"),
            "Default completion finishes locally": ("no automatic Board Done/push/release/deploy", "actual contract/owner/gates"),
            "Material-free rounds with processing gaps": ("Stay quiet", "not a hard SLA", "actual gaps recorded"),
            "Default policy selected but no genuine decision arose": ("OID_COUNT=0", "not itself a domain OID"),
        }
        for scenario, markers in cases.items():
            with self.subTest(scenario=scenario):
                for marker in markers:
                    self.assertIn(marker, rows[scenario])
        self.assertIn("not a model-behavior or host-duration test", section)

    def test_r38_selected_channels_are_isolated_fair_and_authority_bound(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        attention = (source / "references/events-attention.md").read_text()
        activity = (source / "references/progress-activity.md").read_text()
        channel = attention.split("## Selected project channels and fair rounds\n", 1)[1].split("## Honest monitoring communication", 1)[0]
        for text in (skill, activity):
            self.assertIn("events-attention.md#selected-project-channels-and-fair-rounds", text)
        for marker in (
            "only operator-selected or already established active management connections",
            "one authorized strand per VM", "aliases, not independent dispatch owners",
            "not one shared repository or one global queue", "exact connector + project",
            "task_id + session_id + submitted user receipt", "event/source revision",
            "result identity", "contract revision", "filter_key", "opaque cursors",
            "presentation/ACK state", "action_key reservations", "error/repair",
            "owner/current stage/next prepared step", "No cross-channel cursor",
            "first interaction/reentry", "not resend/start/new monitor",
            "one bounded page per eligible channel before extra pages or deep result processing",
            "five-page per-channel round cap", "older pending preparation",
            "one logical action at a time serially", "other due eligible channels",
            "that channel's dependent actions", "Healthy independent channels continue",
            "never resets budgets or admitted work", "no global reset or retry storm",
            "natural management boundary/active execution reentry", "not post-turn/background monitoring",
            "workstop is not schedulerstop", "unverified, never “timer still running”",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, channel)
        self.assertIn("UNVERIFIED until observed", channel)

    def test_r38_genuine_oid_explanation_precedes_send_without_silence_permission(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        policy = (source / "references/optimistic-mvp.md").read_text()
        explanation = policy.split("## Explain a genuine choice before dispatch\n", 1)[1].split("## Drift, repair and recovery", 1)[0]
        self.assertIn("references/optimistic-mvp.md#explain-a-genuine-choice-before-dispatch", skill)
        for marker in (
            "genuine optimistic domain-detail decision", "before the authorized send",
            "decision question", "alternatives", "functional reversible option",
            "precise next step to be admitted", "roughly 40–60 useful words where appropriate",
            "not a mandatory word count", "guaranteed speech duration",
            "prior contract supplies execution authority; silence/no objection is NOT fresh permission",
            "no extra confirmation ceremony", "no native permission/question answer",
            "hard gate exists", "observed “Moment”/objection before admission",
            "parks the unsent prepared action", "A reservation is not admission",
            "possibly admitted", "After actual accepted receipt",
            "never claim un-send, cancel or rollback", "separately authorized",
            "speech-completion/interrupt signals", "UNVERIFIED", "do not claim the user heard",
            "Do not sleep for ten seconds", "backend walltime/text word count",
            "independent hosted acceptance",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, explanation)

    def test_r38_multi_vm_and_explanation_forward_negative_scenarios(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        scenarios = (source / "references/regression-scenarios.md").read_text()
        section = scenarios.split("## r38 selected channels and pre-dispatch explanation\n", 1)[1].split("## Optional read-only smoke test", 1)[0]
        rows = {row.split("|")[1].strip(): row.split("|")[2].strip()
                for row in section.splitlines() if row.startswith("| ") and row.count("|") >= 3}
        cases = {
            "Two selected distinct VM projects with authorized workers": ("one strand per VM", "may run concurrently", "serial logical decisions/admissions"),
            "Unrelated installed app or available connector": ("not watched/activated", "no task authority"),
            "Two connector aliases expose the same VM/project": ("actual identity/owner/receipt", "not two independent strands"),
            "Session IDs or titles coincide on channel A and B": ("exact connector/project/task/session/submitted receipt", "no cross-project"),
            "Channel A has many pages or a long result": ("One bounded page each", "rotate order", "visit B", "no hard30s promise"),
            "One channel's old pending entry becomes prepared later": ("Fresh latest", "no after_cursor-only miss"),
            "First interaction/reentry has an uncertain prior send": ("exact stored action/receipt", "no blind resend/new worker/new monitor"),
            "Topic or Voice discussion delays reads": ("safe management boundary", "no fabricated post-turn timer"),
            "Pure status/start-only/plan/Go-pending with existing watched tasks": ("Bounded permitted reconciliation only", "no indefinite watch", "overrides remain"),
            "Channel A loses capability/auth/cursor or exhausts budget": ("Park A", "healthy independent B continues", "No foreign-queue fallback"),
            "User stops A or global management; worker still running": ("actual stop scope", "does not abort worker", "schedulerstop"),
            "Host execution ends mid-round": ("per-channel next visit/coverage/receipt", "unverified", "never timer-still-running"),
            "Genuine optimistic detail is ready for authorized dispatch": ("Before send", "question/options", "current contract/gates"),
            "Voice OID pre-explanation": ("roughly40–60 useful words", "no filler", "UNVERIFIED"),
            "Routine implementation or no actual OID": ("No artificial OID", "OID_COUNT=0", "silent"),
            "User “Moment”/objection observed before admission": ("Park unsent", "revalidate", "no automatic send"),
            "Objection arrives after accepted or uncertain send": ("cannot be claimed un-sent", "possibly admitted", "separately authorized supported"),
            "User is silent after explanation": ("not new permission", "prior authorized contract", "hard-gate bypass"),
            "Backend clock or text word count reaches ten seconds/words": ("Not audible/host-interrupt PASS", "no sleep timer"),
            "Pre-explained option crosses security/core API/architecture/irreversible/scope/owner gate": ("INPUT_REQUIRED", "no dependent dispatch"),
        }
        for scenario, markers in cases.items():
            with self.subTest(scenario=scenario):
                for marker in markers:
                    self.assertIn(marker, rows[scenario])
        self.assertIn("not hosted multi-VM or Voice acceptance", section)

    def test_r39_contextual_notices_preserve_verified_hierarchy_and_active_progress(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        attention = (source / "references/events-attention.md").read_text()
        notice = attention.split("## Context in user-facing notices\n", 1)[1].split("## Delivery claims", 1)[0]
        self.assertIn("references/events-attention.md#context-in-user-facing-notices", skill)
        for marker in (
            "MCP project/channel name -> verified workstream, when present -> descriptive task title -> result or attention needed",
            "never substitute a number or opaque ID", "each distinct item in a mixed-project report",
            "actual task's Board Project binding or established canonical task context",
            "another task's hierarchy are not evidence", "genuinely does not exist (e.g. Inbox)",
            "unknown or ambiguous", "without inventing a parent", "creates no new Board entity",
            "routine progress pings may use shorter context", "about once a minute",
            "next available tool/conversation boundary", "including failed reads",
            "Do not repeat checking-only filler", "not a new timer",
            "post-turn notification promise",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, notice)

    def test_r39_mvp_completion_notice_separates_new_inherited_pending_and_unknown(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        policy = (source / "references/optimistic-mvp.md").read_text()
        notice = policy.split("## Brief user-facing completion notice\n", 1)[1]
        self.assertIn("references/optimistic-mvp.md#brief-user-facing-completion-notice", skill)
        for marker in (
            "new implemented domain decisions in this run", "inherited cumulative decisions and pending proposals",
            "starting decision baseline from the actual canonical records before admission",
            "stable decision IDs and implementation evidence", "does not count the same decision twice",
            "cumulative `OID_COUNT` semantics", "`OID_NEW_COUNT`", "without creating a separate registry",
            "product code, database schema and established architecture",
            "do not infer such effects merely from policy coverage", "practical correction/reversal paths and Git anchors",
            "without making it a prerequisite", "do not automatically dump the decision log",
            "No new domain MVP decisions in this run", "count is unverified",
            "never report zero from absence of evidence", "Report pending proposals separately",
            "does not authorize new core architecture or irreversible migrations",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, notice)

    def test_r49_integrated_monitor_manager_cooperative_root_only_and_deferred_enforcement(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        rules = (source / "references/monitor-manager-rules.md").read_text()
        tasks = (source / "references/monitor-tasks.md").read_text()
        changelog = (source / "CHANGELOG.md").read_text()
        manifest, _ = BUILDER.package_content(ROOT)
        self.assertEqual(manifest["revision"], "2026-10-09-r49")
        self.assertIn("references/monitor-manager-rules.md", manifest["files"])
        self.assertIn("## 2026-10-09-r47\n", changelog)
        self.assertIn("Monitor-manager rules](references/monitor-manager-rules.md)", skill)
        self.assertIn("Monitor-manager rules](monitor-manager-rules.md)", tasks)
        for marker in (
            "drives the commissioned development to the agreed result",
            "Pure status observation is not delivery",
            "Two audiences",
            "Ordinary OpenCode implementation sessions do not use the management MCP",
            "Tool visibility is not authorization",
            "no technical enforcement is claimed",
            "no native subtasks",
            "not even small read-only research",
            "creation/dispatch receipt verifiably shows the same manager",
            "Never take over, steer or retroactively relabel foreign existing sessions",
            "Workers decide **themselves** whether they use native subtasks",
            "No extra enablement ceremony",
            "serial", "no parallel sub-managers",
            "normal same-session follow-up",
            "escalate as `INPUT_REQUIRED`",
            "never answered or bypassed by the manager",
            "Never self-change",
            "propose to the operator via attention/journal",
            "never disables the scheduler",
            "technical `BLOCKED` event",
            "caller-identity proof",
            "attack detection",
        ):
            self.assertIn(marker, rules, f"rules marker missing: {marker}")
        self.assertIn("separate deferred follow-up", rules)
        self.assertIn("not a board ticket, not git-tracked", rules)
        self.assertIn("reversible archive", rules)
        self.assertIn("context files only after", rules)
        # r47: model-facing rules link to the supported locked worker tools.
        for marker in (
            "create_monitor_worker",
            "list_monitor_workers",
            "update_monitor_worker",
            "reconcile_created",
            "never by editing the registry JSON directly",
            "second, unlocked store",
            "never issue a second create",
            "result_receipt",
        ):
            self.assertIn(marker, rules, f"r47 rules marker missing: {marker}")


    def test_r45_per_profile_fallback_mode_is_additive_explicit_and_finite(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        routing = (source / "references/fallback-routing.md").read_text()
        changelog = (source / "CHANGELOG.md").read_text()
        manifest, _ = BUILDER.package_content(ROOT)
        self.assertEqual(manifest["revision"], "2026-10-09-r49")
        self.assertIn("## 2026-10-08-r45\n", changelog)
        self.assertIn("**2026-10-09-r49**", skill)
        self.assertIn("references/fallback-routing.md", skill)
        self.assertIn("routing.regime: per_profile", skill)
        section = routing.split("## Per-profile fallback mode (additive schema 4)\n", 1)[1] \
            .split("## Context-error recovery", 1)[0]
        for marker in (
            # explicit regime, additive schema, legacy slot neither removed nor reinterpreted
            "Read `routing.regime` from the discovered policy read", "never inferred",
            "`legacy_final_fallback` — today's behaviour, unchanged",
            "at least one configured own fallback", "at least one explicitly set switch",
            "is **not** part of the chain", "never silently appended as an extra last step",
            "`routing.legacy_final_stage_applies` states this relationship explicitly",
            # chain order: own fallback before degrading, existing role entry points
            "The failed main model is never retried", "identical runtime (provider/model/variant) is never attempted twice",
            "own fallback** is the next candidate when configured and permitted",
            "Only when `routing.strategies_effective.degrading` is true",
            "Deep → Standard → Execution", "Design → Standard → Execution and Review → Deep → Standard → Execution",
            "main model first and then its own fallback",
            "a missing own fallback alone does not stop the chain",
            "Configured-but-unavailable candidates are not attempted and are reported with their status reason",
            "`routing.candidate_order[profile]` is the deterministic configured order",
            "`<stage>.main` then `<stage>.fallback`", "it is `null` in the legacy regime",
            # four switch combinations, null is not a hidden default
            "| off | off |", "| off | on |", "| on | off |", "| on | on |",
            "own fallback of the same stage → terminal `INPUT_REQUIRED`",
            "unless its provider identity already failed",
            "other configured models of the same provider remain allowed",
            "**including profile fallbacks**",
            "`null` means *not explicitly activated*, never a hidden default",
            "published as `routing.strategies_effective`",
            # evidence-bound identity, finiteness, controlled terminal state
            "skip only what the confirmed error and the configured IDs actually prove",
            "construct no provider-wide causal or skip claim",
            "the chain is finite, adds no retry/backoff/counter layer",
            "keeps native backend retries and the repair history separate",
            "never continues silently",
            "**not** a VM/adapter process crash and not a swallowed failure",
            "every attempted candidate with its outcome",
            "every skipped candidate with its reason",
            "identical runtime already failed, provider identity skipped, unconfigured, unavailable",
            "the last secured state and the required operator decision",
            "No double worker admission and no repetition of uncertain side effects",
            # write contract
            "`set_project_model_policy_profile_fallback`, `set_project_model_policy_strategies`",
            "with revision CAS", "Both strategy switches are always written explicitly",
            "Never invent a provider/model, never configure silently",
            "leave the main profile mappings and the legacy final-fallback slot untouched",
            # roles, per-step return and the separate context class
            "a reviewer stays independent with no self-implementation or self-acceptance",
            "resolves its regular profile fresh from the current policy with exact readback",
            "Context/input-length errors stay on their separate compaction path",
            "never a routing trigger",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, section)
        # The legacy total/degrading contract stays worded as before (no reinterpretation).
        legacy = routing.split("## Routing on timeout/quota (classes 1–2)\n", 1)[1] \
            .split("## Per-profile fallback mode", 1)[0]
        for marker in ("**Total (standard):**", "**Degrading (selectable option):**",
                       "no automatic provider/model choice of any kind", "**Role truth:**",
                       "**Per-step return:**"):
            with self.subTest(legacy=marker):
                self.assertIn(marker, legacy)

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
        for required in ("base HEAD", "one active writer", "verify every write target"):
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
                    "Monitor same fingerprint after two production-code no-progress repairs",
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
        checkpoint = monitor.split("MONITOR-CHECKPOINT v1\n", 1)[1].split("```", 1)[0]
        self.assertIn(
            "decision_ref=<current applied canonical decision reference/revision, "
            "interactive or persisted cross-chat; none only when no canonical decision applies>",
            checkpoint,
        )
        self.assertNotIn("current interactive source or none", checkpoint)
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


class SynthesizedContractTest(unittest.TestCase):
    """Source-bound instruction traces, not a runtime engine or hosted acceptance.

    Read the shipped precedence/phase tables; fixture observations determine which
    row applies. Expected traces and mutation controls are independent of the table
    outputs, so changing/removing/reordering a shipped rule changes the outcome.
    All contract/receipt/reviewer state below is test-only, never a backend schema.
    """

    def setUp(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        self.packages = (source / "references/work-packages.md").read_text()
        self.dispatch_rows = self.table(self.packages, "| Condition | Action |")
        self.phase_rows = self.table(self.packages, "| Phase | Observed gate |")
        template = self.packages.split("Synthesized Execution Contract\n", 1)[1].split("```", 1)[0]
        self.fields = set(re.findall(r"\b([A-Za-z_]+)=", template))
        self.trace = []
        # Independent observations of current synthesis inputs, not copies of pins.
        # Publication readback and authorized routine evidence updates are separate.
        self.observed_sources = {}

    @staticmethod
    def table(text, header):
        lines = text.split(header, 1)[1].splitlines()[2:]
        rows = []
        for line in lines:
            if not line.startswith("| "):
                break
            rows.append([cell.strip() for cell in line.split("|")[1:-1]])
        return rows

    def contract(self, revision=1, members=None, prior=None):
        members = copy.deepcopy(members if members is not None else {
            "member-a": {"board": "in_progress", "acceptance": "PENDING", "integrated": None}
        })
        for member in members.values():
            member["marker"] = {"package_id": "package-a", "SYNTHESIS_REVISION": revision,
                                "execution_owner": "package"}
        for key in members:
            self.observed_sources.setdefault(key, {"task": "board-r1", "C": "context-r1", "P": "plan-r1"})
        result = {
            "package_id": "package-a", "SYNTHESIS_REVISION": revision,
            "revision_state": "active", "supersedes": prior["SYNTHESIS_REVISION"] if prior else "none",
            "sources": {key: {"task": "board-r1", "C": "context-r1", "P": "plan-r1"} for key in members},
            "completed_evidence": {key: copy.deepcopy(value["integrated"]) for key, value in members.items()
                                   if value["integrated"]},
            "goal_semantics": "fixed goal/acceptance", "dependencies_order": "serial",
            "base_HEAD": "a" * 40, "candidate_HEAD": "a" * 40,
            "writer_integration": {"writers": ["implementer"], "verified": True},
            "autonomous_decisions": ["small/medium technical choices", "evidenced Board transitions"],
            "test_integration_QC_gates": {"local": "PASS", "hosted": "PENDING"},
            "correction_loop": copy.deepcopy(prior["correction_loop"]) if prior else {},
            "hard_stops": "new decision/conflict/permission/exhaustion",
            "target_end_state": "READY_FOR_LOCAL_RELEASE_PREP",
            "excluded_operator_only": ["release", "tag", "remote push", "publish", "upload",
                                       "deploy", "productive restart", "destructive cleanup"],
        }
        return result, members

    def valid(self, contract, members):
        if (not self.fields <= contract.keys() or contract["revision_state"] != "active" or
                not contract["writer_integration"]["verified"] or
                set(contract["sources"]) != set(members)):
            return False
        for key, member in members.items():
            if (set(contract["sources"][key]) != {"task", "C", "P"} or
                    not all(contract["sources"][key].values()) or
                    contract["sources"][key] != self.observed_sources.get(key) or
                    member["marker"] != {"package_id": contract["package_id"],
                                         "SYNTHESIS_REVISION": contract["SYNTHESIS_REVISION"],
                                         "execution_owner": "package"} or
                    (member["integrated"] and contract["completed_evidence"].get(key) != member["integrated"])):
                return False
        return True

    def dispatch(self, contract, members, member_id, *, caller="package-a", receipt=None,
                 hard_stop=False, ready=True, rows=None):
        conditions = {
            "Hard stop": hard_stop,
            "Contract or readiness invalid": not self.valid(contract, members) or not ready,
            "Member outside active revision": member_id not in members,
            "Caller is not package owner": caller != contract.get("package_id"),
            "Prior receipt admitted or uncertain": receipt in {"admitted", "uncertain"},
            "Implementation already completed and integrated": bool(members.get(member_id, {}).get("integrated")),
            "Remaining step ready": True,
        }
        for condition, action, _ in self.dispatch_rows if rows is None else rows:
            if conditions[condition]:
                self.trace.append(action)
                return action
        raise AssertionError("Missing shipped dispatch rule")

    def transition(self, phase, gate, contract, *, qc=None, fingerprint="A", in_scope=True):
        if gate == "in-scope finding":
            if not in_scope or contract["correction_loop"].get(fingerprint, 0) >= 2:
                self.trace.append("INPUT_REQUIRED")
                return "INPUT_REQUIRED"
            contract["correction_loop"][fingerprint] = contract["correction_loop"].get(fingerprint, 0) + 1
        if gate in {"independent PASS", "final PASS"}:
            if (qc is None or qc["reviewer"] in contract["writer_integration"]["writers"] or
                    qc["HEAD"] != contract["candidate_HEAD"] or
                    qc["revision"] != contract["SYNTHESIS_REVISION"] or not qc["full_candidate"]):
                raise ValueError("independent exact full-candidate evidence required")
            if gate == "final PASS" and any(value != "PASS" for value in contract["test_integration_QC_gates"].values()):
                raise ValueError("release-blocking FAIL/PENDING")
        matches = [row[2] for row in self.phase_rows if row[:2] == [phase, gate]]
        if len(matches) != 1:
            raise ValueError("no unique shipped phase transition")
        self.trace.append(matches[0])
        return matches[0]

    @staticmethod
    def qc(contract, reviewer="reviewer"):
        return {"reviewer": reviewer, "HEAD": contract["candidate_HEAD"],
                "revision": contract["SYNTHESIS_REVISION"], "full_candidate": True}

    def test_synthesis_contract_fields_and_cross_reference_routing(self):
        self.assertEqual(self.fields, {
            "package_id", "SYNTHESIS_REVISION", "revision_state", "supersedes", "sources",
            "completed_evidence", "goal_semantics", "dependencies_order", "base_HEAD", "candidate_HEAD",
            "writer_integration", "autonomous_decisions", "test_integration_QC_gates", "correction_loop",
            "hard_stops", "target_end_state", "excluded_operator_only",
        })
        contract, members = self.contract()
        self.assertTrue(self.valid(contract, members))
        for field in self.fields:
            broken = copy.deepcopy(contract)
            broken.pop(field)
            self.assertEqual(self.dispatch(broken, members, "member-a"), "RECONCILE", field)
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        for name in ("SKILL.md", "references/board-workflow.md", "references/monitor-tasks.md"):
            text = (source / name).read_text()
            self.assertIn("work-packages.md#synthesize-before-autonomous-execution", text)
            self.assertIn("SYNTHESIS_REVISION", text)
        for phrase in ("no new MCP/backend schema", "not a Board status", "execution_owner=package"):
            self.assertIn(phrase.lower(), (self.packages + (source / "SKILL.md").read_text()).lower())

    def test_synthesis_no_separate_or_double_dispatch(self):
        contract, members = self.contract()
        self.dispatch(contract, members, "member-a")
        self.dispatch(contract, members, "member-a", caller="another-manager")
        for receipt in ("admitted", "uncertain"):
            self.dispatch(contract, members, "member-a", receipt=receipt)
        self.assertEqual(self.trace, ["DISPATCH_ONCE", "OBSERVE_PACKAGE",
                                     "RECONCILE_RECEIPT", "RECONCILE_RECEIPT"])
        # Mutation controls: an early ready row or removed owner check must change the trace.
        reordered = [self.dispatch_rows[-1]] + self.dispatch_rows[:-1]
        self.assertNotEqual(self.dispatch(contract, members, "member-a", caller="other", rows=reordered),
                            "OBSERVE_PACKAGE")
        removed = [row for row in self.dispatch_rows if row[0] != "Caller is not package owner"]
        self.assertNotEqual(self.dispatch(contract, members, "member-a", caller="other", rows=removed),
                            "OBSERVE_PACKAGE")

    def test_synthesis_completed_member_import_is_not_rerun(self):
        evidence = {"source": "b" * 40, "integrated": "c" * 40, "result": "original-result",
                    "tests": "28 PASS", "acceptance": "PENDING"}
        for board in ("in_progress", "done"):
            contract, members = self.contract(members={"completed": {
                "board": board, "acceptance": "PENDING", "integrated": evidence}})
            before = copy.deepcopy((contract, members))
            self.assertEqual(self.dispatch(contract, members, "completed"), "IMPORT_COMPLETED_EVIDENCE")
            self.assertEqual((contract, members), before)
        self.assertNotIn("DISPATCH_ONCE", self.trace)

    def test_synthesis_new_revision_pins_sources_and_imports_evidence(self):
        old, members = self.contract(members={"completed": {
            "board": "done", "acceptance": "PENDING",
            "integrated": {"commit": "c" * 40, "result": "original-result", "tests": "PASS"}}})
        old["correction_loop"] = {"A": 2, "B": 1}
        saved = json.dumps((old, members), sort_keys=True)
        restored, restored_members = json.loads(saved)
        new, imported = self.contract(2, restored_members, restored)
        self.observed_sources["completed"]["C"] = "current-context-r2"
        self.assertEqual(self.dispatch(new, imported, "completed"), "RECONCILE")
        new["sources"]["completed"]["C"] = "current-context-r2"
        self.assertEqual(new["supersedes"], 1)
        self.assertEqual(new["completed_evidence"], old["completed_evidence"])
        self.assertEqual(new["correction_loop"], {"A": 2, "B": 1})
        self.assertEqual(imported["completed"]["marker"]["SYNTHESIS_REVISION"], 2)
        self.assertEqual(self.dispatch(new, imported, "completed"), "IMPORT_COMPLETED_EVIDENCE")
        self.assertEqual(json.dumps((old, members), sort_keys=True), saved)
        self.assertNotIn("DISPATCH_ONCE", self.trace)

    def test_synthesis_changed_present_or_stale_pins_reconcile_without_dispatch(self):
        contract, members = self.contract()
        for field in ("task", "C", "P"):
            for changed in ("pin", "observation"):
                with self.subTest(field=field, changed=changed):
                    self.trace = []
                    broken = copy.deepcopy(contract)
                    observed = copy.deepcopy(self.observed_sources)
                    if changed == "pin":
                        broken["sources"]["member-a"][field] = "stale-present-r0"
                    else:
                        self.observed_sources["member-a"][field] = "changed-present-r2"
                    self.assertFalse(self.valid(broken, members))
                    self.assertEqual(self.dispatch(broken, members, "member-a"), "RECONCILE")
                    self.assertEqual(self.trace, ["RECONCILE"])
                    self.assertEqual(self.trace.count("DISPATCH_ONCE"), 0)
                    self.observed_sources = observed
        reconciled, rows = self.contract(2, members, contract)
        self.observed_sources["member-a"] = {"task": "board-r2", "C": "context-r2", "P": "plan-r2"}
        self.assertEqual(self.dispatch(reconciled, rows, "member-a"), "RECONCILE")
        reconciled["sources"]["member-a"] = {"task": "board-r2", "C": "context-r2", "P": "plan-r2"}
        self.trace = []
        self.assertTrue(self.valid(reconciled, rows))
        self.assertEqual(self.dispatch(reconciled, rows, "member-a"), "DISPATCH_ONCE")
        self.assertEqual(self.trace, ["DISPATCH_ONCE"])
        self.assertEqual(contract["sources"]["member-a"],
                         {"task": "board-r1", "C": "context-r1", "P": "plan-r1"})

    def test_synthesis_publication_and_routine_evidence_do_not_rewrite_input_pins(self):
        contract, members = self.contract()
        frozen = copy.deepcopy(contract["sources"])
        publication_readback = {"member-a": {"C": "context-with-marker", "P": "plan-with-marker"}}
        self.assertNotEqual(publication_readback["member-a"]["C"], frozen["member-a"]["C"])
        # An authorized QC report/current HEAD update is not a changed input scope.
        publication_readback["member-a"]["C"] = "context-with-qc-evidence"
        contract["candidate_HEAD"] = "d" * 40
        contract["test_integration_QC_gates"]["local"] = "PASS"
        self.assertEqual(self.dispatch(contract, members, "member-a"), "DISPATCH_ONCE")
        self.assertEqual(contract["sources"], frozen)
        self.assertEqual(self.observed_sources, frozen)
        self.assertEqual(contract["SYNTHESIS_REVISION"], 1)

    def test_synthesis_new_unsynthesized_member_does_not_mutate_active_revision(self):
        contract, members = self.contract()
        before = json.dumps((contract, members), sort_keys=True)
        self.assertEqual(self.dispatch(contract, members, "new-member"), "KEEP_UNSYNTHESIZED")
        self.assertEqual(json.dumps((contract, members), sort_keys=True), before)
        next_members = copy.deepcopy(members)
        next_members["new-member"] = {"board": "todo", "acceptance": "PENDING", "integrated": None}
        new, admitted = self.contract(2, next_members, contract)
        self.assertEqual(self.dispatch(new, admitted, "new-member"), "DISPATCH_ONCE")

    def test_synthesis_correction_requires_renewed_independent_exact_subject_qc(self):
        contract, _ = self.contract()
        old_qc = self.qc(contract)
        phase = self.transition("INDEPENDENT_QC", "in-scope finding", contract)
        contract["writer_integration"]["writers"].append("fixer")
        contract["candidate_HEAD"] = "d" * 40
        phase = self.transition(phase, "correction integrated", contract)
        for bad in (old_qc, self.qc(contract, "fixer"), self.qc(contract, "implementer")):
            with self.assertRaisesRegex(ValueError, "independent exact"):
                self.transition(phase, "independent PASS", contract, qc=bad)
        phase = self.transition(phase, "independent PASS", contract, qc=self.qc(contract, "new-reviewer"))
        self.assertEqual(self.trace, ["CORRECTION_LOOP", "INDEPENDENT_QC", "FINAL_QC"])
        self.assertEqual(phase, "FINAL_QC")
        self.assertIn("separate correction worker", self.packages)
        self.assertIn("different independent reviewer", self.packages)

    def test_synthesis_genuine_decisions_and_permissions_stop_dependent_work(self):
        for reason in ("product", "architecture", "security", "scope", "unreconcilable base/ownership",
                       "host/operator permission", "exhausted bounded budget"):
            with self.subTest(reason=reason):
                contract, members = self.contract()
                before = copy.deepcopy((contract, members))
                self.assertIn(reason, self.dispatch_rows[0][2].lower())
                self.assertEqual(self.dispatch(contract, members, "member-a", hard_stop=True), "INPUT_REQUIRED")
                self.assertEqual((contract, members), before)
        contract, _ = self.contract()
        self.assertEqual(self.transition("FINAL_QC", "in-scope finding", contract, in_scope=False), "INPUT_REQUIRED")
        self.assertEqual(contract["correction_loop"], {})
        self.assertNotIn("DISPATCH_ONCE", self.trace)

    def test_synthesis_technical_milestones_are_internal_transitions(self):
        contract, members = self.contract()
        phase = self.transition("SYNTHESIS", "contract verified", contract)
        phase = self.transition(phase, "admission ready", contract)
        self.dispatch(contract, members, "member-a")
        # Source commit/integration milestone -> review; no operator approval handoff.
        phase = self.transition(phase, "integration verified", contract)
        self.assertEqual(phase, "INDEPENDENT_QC")
        self.assertNotIn("OPERATOR_HANDOFF", self.trace)
        self.assertIn("permitted evidence-supported Board transitions/readback", self.packages)
        self.assertIn("not operator handoffs", self.packages)
        self.assertEqual(members["member-a"]["board"], "in_progress")

    def test_synthesis_autonomous_ready_for_local_prep_requires_all_final_gates(self):
        contract, _ = self.contract()
        for status in ("PENDING", "FAIL"):
            contract["test_integration_QC_gates"]["hosted"] = status
            with self.assertRaisesRegex(ValueError, "release-blocking"):
                self.transition("FINAL_QC", "final PASS", contract, qc=self.qc(contract))
        contract["test_integration_QC_gates"]["hosted"] = "PASS"
        for field, value in (("HEAD", "old-baseline"), ("revision", 0), ("full_candidate", False)):
            stale = self.qc(contract)
            stale[field] = value
            with self.assertRaisesRegex(ValueError, "independent exact"):
                self.transition("FINAL_QC", "final PASS", contract, qc=stale)
        phase = self.transition("FINAL_QC", "final PASS", contract, qc=self.qc(contract))
        self.assertEqual(phase, "LOCAL_RELEASE_PREP")
        final_row = next(row for row in self.phase_rows if row[:2] == ["FINAL_QC", "final PASS"])
        self.assertIn("READY_FOR_LOCAL_RELEASE_PREP", final_row[3])
        self.assertNotIn("OPERATOR_HANDOFF", self.trace)

    def test_synthesis_member_package_acceptance_and_board_remain_distinct(self):
        contract, members = self.contract(members={"completed": {
            "board": "done", "acceptance": "PASS", "integrated": {"commit": "c" * 40}}})
        self.assertEqual(self.dispatch(contract, members, "completed"), "IMPORT_COMPLETED_EVIDENCE")
        with self.assertRaisesRegex(ValueError, "release-blocking"):
            self.transition("FINAL_QC", "final PASS", contract, qc=self.qc(contract))
        self.assertEqual(members["completed"]["board"], "done")
        self.assertEqual(members["completed"]["acceptance"], "PASS")
        self.assertEqual(contract["test_integration_QC_gates"]["hosted"], "PENDING")

    def test_synthesis_operator_only_actions_have_no_autonomous_transition(self):
        contract, _ = self.contract()
        self.assertEqual(self.transition("LOCAL_RELEASE_PREP", "local prep verified", contract), "OPERATOR_HANDOFF")
        for action in contract["excluded_operator_only"]:
            with self.subTest(action=action):
                with self.assertRaisesRegex(ValueError, "no unique shipped"):
                    self.transition("OPERATOR_HANDOFF", action, contract)
        self.assertEqual(self.trace, ["OPERATOR_HANDOFF"])
        self.assertIn("no actual publication", next(row[3] for row in self.phase_rows
                                                   if row[:2] == ["LOCAL_RELEASE_PREP", "local prep verified"]))

    def test_synthesis_partial_publication_and_missing_evidence_block_dispatch(self):
        contract, members = self.contract()
        for changed in ("revision", "owner", "source", "inactive", "writer", "readiness"):
            broken, rows = copy.deepcopy((contract, members))
            if changed == "revision":
                rows["member-a"]["marker"]["SYNTHESIS_REVISION"] = 2
            elif changed == "owner":
                rows["member-a"]["marker"]["package_id"] = "another-package"
            elif changed == "source":
                broken["sources"]["member-a"].pop("P")
            elif changed == "inactive":
                broken["revision_state"] = "candidate"
            elif changed == "writer":
                broken["writer_integration"]["verified"] = False
            self.assertEqual(self.dispatch(broken, rows, "member-a", ready=changed != "readiness"), "RECONCILE")
        self.assertNotIn("DISPATCH_ONCE", self.trace)

    def test_synthesis_repair_budget_survives_restart_and_new_revision(self):
        contract, members = self.contract()
        self.transition("INDEPENDENT_QC", "in-scope finding", contract, fingerprint="A")
        self.transition("INDEPENDENT_QC", "in-scope finding", contract, fingerprint="B")
        restored, restored_members = json.loads(json.dumps((contract, members)))
        next_contract, _ = self.contract(2, restored_members, restored)
        self.transition("FINAL_QC", "in-scope finding", next_contract, fingerprint="A")
        before = copy.deepcopy(next_contract["correction_loop"])
        self.assertEqual(self.transition("FINAL_QC", "in-scope finding", next_contract, fingerprint="A"),
                         "INPUT_REQUIRED")
        self.assertEqual(next_contract["correction_loop"], before)
        self.assertEqual(before, {"A": 2, "B": 1})
        self.assertIn("at most two no-progress autonomous **production-code** repair cycles", self.packages)
        self.assertIn("Reserve attempts at admission including uncertainty", self.packages)

    def test_synthesis_pilot_imports_completed_work_but_requires_new_full_candidate_qc(self):
        contract, members = self.contract(members={
            "stage-one": {"board": "in_progress", "acceptance": "PENDING", "integrated": {"commit": "b" * 40}},
            "stage-two": {"board": "done", "acceptance": "PASS", "integrated": {"commit": "c" * 40}},
            "synthesis-member": {"board": "in_progress", "acceptance": "PENDING", "integrated": {"commit": "d" * 40}},
            "qc-member": {"board": "in_progress", "acceptance": "PENDING", "integrated": None},
        })
        for member in ("stage-one", "stage-two", "synthesis-member"):
            self.dispatch(contract, members, member)
        self.dispatch(contract, members, "qc-member")
        self.assertEqual(self.trace, ["IMPORT_COMPLETED_EVIDENCE"] * 3 + ["DISPATCH_ONCE"])
        old_review = self.qc(contract)
        contract["candidate_HEAD"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "independent exact"):
            self.transition("FINAL_QC", "final PASS", contract, qc=old_review)
        with self.assertRaisesRegex(ValueError, "release-blocking"):
            self.transition("FINAL_QC", "final PASS", contract, qc=self.qc(contract))
        self.assertIn("FINAL QC after pilot synthesis", self.packages)
        self.assertIn("synthesis cannot turn PENDING into PASS", self.packages)


class AgentPreparationTraceTest(unittest.TestCase):
    """Interpret shipped gate order against independent fake tool evidence.

    Test-only contract walks, not a deployed client/runtime or hosted model test.
    Expected call traces and source-mutation controls detect absent/reordered gates.
    """

    class Connector:
        def __init__(self, *, existing=True, agent="plan", variant="effort", **flags):
            self.existing = existing
            self.state = {"agent": agent, "provider_id": "provider-current",
                          "model_id": "model-current", "variant": variant,
                          "idle": True, "permissions": 0, "questions": 0, "write": False}
            self.state.update(flags.pop("state", {}))
            self.catalog = {"build": {"primary": True, "available": True},
                            "plan": {"primary": True, "available": True}}
            self.flags = flags
            self.calls = []

        def call(self, name, **args):
            self.calls.append((name, args))
            if name == "create_session":
                self.existing = True
                return "session-target"
            if name == "get_runtime_options":
                return self.catalog
            if name == "get_session":
                if self.flags.get("read_failure") or (self.flags.get("readback_failure") and
                        any(call == "update_session_runtime" for call, _ in self.calls)):
                    raise RuntimeError("read unavailable")
                return copy.deepcopy(self.state)
            if name == "update_session_runtime":
                if not self.flags.get("partial"):
                    self.state.update({key: value for key, value in args.items() if key != "session_id"})
                if self.flags.get("drift"):
                    self.state[self.flags["drift"]] = "unexpected"
                if self.flags.get("after_update_busy"):
                    self.state["idle"] = False
                if self.flags.get("uncertain") or self.flags.get("partial"):
                    raise RuntimeError("update uncertain")
            if name == "send_message" and self.flags.get("send_uncertain"):
                raise RuntimeError("send uncertain")

    def setUp(self):
        self.source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        self.policy = (self.source / "references/agent-preparation.md").read_text()

    @staticmethod
    def tuple_of(state):
        return tuple(state.get(key) for key in ("provider_id", "model_id", "variant"))

    def walk(self, connector, *, scope="file_work", explicit_agent=None,
             plan_exception=False, authorized=True, profile_state="unconfigured",
             profile_tuple=None, policy=None):
        policy = self.policy if policy is None else policy
        rules = set(re.findall(r"\*\*([A-Z_]+):\*\*", policy))
        if scope == "stored_read" and "PURE_STORED_READ" in rules:
            connector.call("read_message_content")
            return "STORED_READ"
        if not authorized:
            return "NOT_AUTHORIZED"
        if (scope == "file_work" and explicit_agent == "plan" and
                "PLAN_WRITE_CONFLICT" in rules):
            return "PLAN_WRITE_CONFLICT"
        if profile_state in ("unavailable", "incomplete", "uncheckable"):
            return "PROFILE_BLOCKED"
        desired_agent = explicit_agent or ("plan" if plan_exception and scope == "read_only_new"
                                           else "build" if "DEFAULT_BUILD" in rules
                                           else connector.state["agent"])
        steps = re.findall(r"^\d+\. \*\*([A-Z_]+):\*\*", policy, re.M)
        observed = copy.deepcopy(connector.state)
        expected_tuple = self.tuple_of(observed)
        try:
            for step in steps:
                if step == "SCOPE_GATE" and not connector.existing:
                    if connector.flags.get("no_create"):
                        return "CAPABILITY_BLOCKED"
                    connector.call("create_session", title="Authorized task")
                elif step == "AVAILABILITY_GATE":
                    if connector.flags.get("no_catalog"):
                        return "CAPABILITY_BLOCKED"
                    agent = connector.call("get_runtime_options").get(desired_agent, {})
                    if not agent.get("primary") or not agent.get("available"):
                        return "AGENT_UNAVAILABLE"
                elif step == "IDLE_GATE":
                    if connector.flags.get("no_readback"):
                        return "CAPABILITY_BLOCKED"
                    observed = connector.call("get_session", session_id="session-target")
                    if not observed.get("agent") or not observed.get("provider_id") or not observed.get("model_id"):
                        return "AGENT_PREPARATION_UNVERIFIED"
                    if (not observed["idle"] or observed["permissions"] or
                            observed["questions"] or observed["write"]):
                        return "SESSION_BLOCKED"
                    expected_tuple = self.tuple_of(observed)
                elif step == "AGENT_UPDATE":
                    patches = []
                    if observed["agent"] != desired_agent:
                        patches.append({"agent": desired_agent})
                    if profile_tuple and profile_tuple != expected_tuple:
                        patches.append(dict(zip(("provider_id", "model_id", "variant"), profile_tuple)))
                        expected_tuple = profile_tuple
                    if patches and connector.flags.get("no_update"):
                        return "CAPABILITY_BLOCKED"
                    for patch in patches:
                        try:
                            connector.call("update_session_runtime", session_id="session-target", **patch)
                        except RuntimeError:
                            # One exact readback may establish success; no retry/rollback.
                            break
                elif step == "READBACK_GATE":
                    actual = connector.call("get_session", session_id="session-target")
                    if (actual["agent"] != desired_agent or self.tuple_of(actual) != expected_tuple or
                            not actual["idle"] or actual["permissions"] or actual["questions"] or actual["write"]):
                        return "AGENT_PREPARATION_UNVERIFIED"
                elif step == "SEND_ONCE":
                    try:
                        connector.call("send_message", session_id="session-target", message="Authorized bounded task")
                    except RuntimeError:
                        return "SUBMISSION_UNCERTAIN"
            return "PREPARED_AND_SENT"
        except RuntimeError:
            return "AGENT_PREPARATION_UNVERIFIED"

    @staticmethod
    def names(connector):
        return [name for name, _ in connector.calls]

    def assert_no_mutating_calls(self, connector):
        self.assertFalse(set(self.names(connector)) & {"create_session", "update_session_runtime", "send_message"})

    def test_file_capable_concept_and_create_default_plan_switch_before_single_send(self):
        for title in ("Concept with later persistence", "Implementation", "Context initialization"):
            with self.subTest(title=title):
                connector = self.Connector(existing=False)
                before = self.tuple_of(connector.state)
                self.assertEqual(self.walk(connector), "PREPARED_AND_SENT")
                self.assertEqual(self.names(connector), ["create_session", "get_runtime_options", "get_session",
                                                         "update_session_runtime", "get_session", "send_message"])
                self.assertEqual(connector.calls[0][1], {"title": "Authorized task"})
                self.assertEqual(connector.calls[3][1], {"session_id": "session-target", "agent": "build"})
                self.assertEqual(self.tuple_of(connector.state), before)

    def test_existing_build_reuse_and_explicit_read_only_plan_need_no_churn(self):
        for agent, scope, exception in (("build", "file_work", False), ("plan", "read_only_new", True)):
            connector = self.Connector(agent=agent)
            self.assertEqual(self.walk(connector, scope=scope, plan_exception=exception,
                                       explicit_agent="plan" if exception else None), "PREPARED_AND_SENT")
            self.assertEqual(self.names(connector), ["get_runtime_options", "get_session", "get_session", "send_message"])
            self.assertEqual(connector.state["agent"], agent)

    def test_clarification_cross_reference_checks_scope_before_create(self):
        """Walk the actual local Start sequence, not merely its central link.

        A creation before the linked central scope gate is already a mutation,
        even if the central workflow would subsequently stop correctly.
        """
        text = (self.source / "references/clarification-sessions.md").read_text()

        def clarification_walk(connector, *, text=text, scope="file_work", explicit_agent=None):
            start = text.split("## Start\n", 1)[1].split("## Return or branch", 1)[0]
            for step in re.findall(r"^\d+\. (.+)$", start, re.M):
                if "**SCOPE_GATE:**" in step:
                    if scope == "file_work" and explicit_agent == "plan":
                        return "PLAN_WRITE_CONFLICT"
                elif "create one empty root session" in step:
                    if not connector.existing:
                        connector.call("create_session", title="[KLÄRUNG] Authorized question")
                elif "Send **one** bounded handoff" in step:
                    return self.walk(connector, scope=scope, explicit_agent=explicit_agent)
            return "INCOMPLETE_WORKFLOW"

        # Independent negative expectation: no tool mutation before scope conflict.
        connector = self.Connector(existing=False)
        self.assertEqual(clarification_walk(connector, explicit_agent="plan"), "PLAN_WRITE_CONFLICT")
        self.assert_no_mutating_calls(connector)
        self.assertEqual(connector.calls, [])

        # Valid Plan-only clarification and default Build persistence still work.
        for scope, explicit_agent, final_agent, update_count in (
                ("read_only_new", "plan", "plan", 0), ("file_work", None, "build", 1)):
            connector = self.Connector(existing=False)
            original_tuple = self.tuple_of(connector.state)
            self.assertEqual(clarification_walk(connector, scope=scope, explicit_agent=explicit_agent),
                             "PREPARED_AND_SENT")
            self.assertEqual(self.names(connector).count("create_session"), 1)
            self.assertEqual(self.names(connector).count("update_session_runtime"), update_count)
            self.assertEqual(self.names(connector).count("send_message"), 1)
            self.assertEqual(connector.state["agent"], final_agent)
            self.assertEqual(self.tuple_of(connector.state), original_tuple)
            self.assertEqual(self.names(connector)[-2:], ["get_session", "send_message"])

        # Reorder actual local instructions to recreate F1. Even an eventual
        # conflict result must fail the independent zero-mutation expectation.
        lines = text.splitlines()
        scope_index = next(i for i, line in enumerate(lines) if "4. **SCOPE_GATE:**" in line)
        create_index = next(i for i, line in enumerate(lines) if line.startswith("5. If session creation"))
        lines[scope_index], lines[create_index] = lines[create_index], lines[scope_index]
        mutated = "\n".join(lines) + "\n"
        connector = self.Connector(existing=False)
        self.assertEqual(clarification_walk(connector, text=mutated, explicit_agent="plan"), "PLAN_WRITE_CONFLICT")
        self.assertEqual(self.names(connector), ["create_session"])
        with self.assertRaises(AssertionError):
            self.assert_no_mutating_calls(connector)

    def test_explicit_plan_conflict_pure_reads_and_scope_growth_authorization(self):
        connector = self.Connector(existing=False)
        self.assertEqual(self.walk(connector, explicit_agent="plan"), "PLAN_WRITE_CONFLICT")
        self.assert_no_mutating_calls(connector)
        connector = self.Connector()
        self.assertEqual(self.walk(connector, scope="stored_read"), "STORED_READ")
        self.assertEqual(self.names(connector), ["read_message_content"])
        self.assertEqual(self.walk(connector, authorized=False), "NOT_AUTHORIZED")
        self.assert_no_mutating_calls(connector)
        connector.calls.clear()
        self.assertEqual(self.walk(connector), "PREPARED_AND_SENT")
        self.assertEqual(connector.state["agent"], "build")

    def test_missing_or_nonprimary_build_and_missing_tools_block_send(self):
        for broken in ("missing", "disabled", "subagent"):
            connector = self.Connector()
            if broken == "missing":
                connector.catalog.pop("build")
            else:
                connector.catalog["build"]["available" if broken == "disabled" else "primary"] = False
            self.assertEqual(self.walk(connector), "AGENT_UNAVAILABLE")
            self.assert_no_mutating_calls(connector)
        for tool in ("no_create", "no_catalog", "no_update", "no_readback"):
            connector = self.Connector(existing=False if tool == "no_create" else True, **{tool: True})
            self.assertEqual(self.walk(connector), "CAPABILITY_BLOCKED")
            self.assertNotIn("send_message", self.names(connector))
        # Missing update is immaterial when correct Build and tuple are already verified.
        self.assertEqual(self.walk(self.Connector(agent="build", no_update=True)), "PREPARED_AND_SENT")

    def test_busy_permissions_questions_and_concurrent_write_block_update_and_send(self):
        for state in ({"idle": False}, {"permissions": 1}, {"questions": 1}, {"write": True}):
            connector = self.Connector(state=state)
            self.assertEqual(self.walk(connector), "SESSION_BLOCKED")
            self.assert_no_mutating_calls(connector)
        connector = self.Connector(after_update_busy=True)
        self.assertEqual(self.walk(connector), "AGENT_PREPARATION_UNVERIFIED")
        self.assertNotIn("send_message", self.names(connector))

    def test_exact_tuple_and_profile_preservation_and_unavailable_stop(self):
        for variant in ("explicit-effort", None):
            connector = self.Connector(variant=variant)
            original = self.tuple_of(connector.state)
            self.assertEqual(self.walk(connector), "PREPARED_AND_SENT")
            self.assertEqual(self.tuple_of(connector.state), original)
        requested = ("provider-explicit", "model-explicit", "variant-explicit")
        connector = self.Connector()
        self.assertEqual(self.walk(connector, profile_state="available", profile_tuple=requested), "PREPARED_AND_SENT")
        self.assertEqual(self.tuple_of(connector.state), requested)
        self.assertEqual(self.names(connector).count("send_message"), 1)
        for status in ("unavailable", "incomplete", "uncheckable"):
            connector = self.Connector(existing=False)
            self.assertEqual(self.walk(connector, profile_state=status), "PROFILE_BLOCKED")
            self.assert_no_mutating_calls(connector)

    def test_uncertain_partial_update_and_readback_drift_never_retry_or_send_unverified(self):
        connector = self.Connector(uncertain=True)
        self.assertEqual(self.walk(connector), "PREPARED_AND_SENT")
        self.assertEqual(self.names(connector).count("update_session_runtime"), 1)
        for flags in ({"partial": True}, {"read_failure": True}, {"readback_failure": True},
                      {"state": {"provider_id": None}}, {"state": {"model_id": None}},
                      {"drift": "provider_id"}, {"drift": "model_id"}, {"drift": "variant"}):
            connector = self.Connector(**flags)
            self.assertEqual(self.walk(connector), "AGENT_PREPARATION_UNVERIFIED")
            self.assertNotIn("send_message", self.names(connector))
            self.assertLessEqual(self.names(connector).count("update_session_runtime"), 1)
        connector = self.Connector(send_uncertain=True)
        self.assertEqual(self.walk(connector), "SUBMISSION_UNCERTAIN")
        self.assertEqual(self.names(connector).count("send_message"), 1)

    def test_shipped_gate_mutations_expose_unsafe_flows_and_reference_links_are_present(self):
        # Negative controls execute modified source order/rules, independent expectations.
        connector = self.Connector(drift="variant")
        without_readback = self.policy.replace("5. **READBACK_GATE:**", "5. **REMOVED:**")
        self.assertEqual(self.walk(connector, policy=without_readback), "PREPARED_AND_SENT")
        self.assertIn("send_message", self.names(connector))  # Unsafe trace rejected by intact gate above.
        connector = self.Connector(drift="variant")
        early_send = self.policy.replace("5. **READBACK_GATE:**", "5. **SEND_ONCE:**").replace(
            "6. **SEND_ONCE:**", "6. **READBACK_GATE:**")
        self.assertEqual(self.walk(connector, policy=early_send), "AGENT_PREPARATION_UNVERIFIED")
        self.assertLess(self.names(connector).index("send_message"), len(connector.calls) - 1)
        self.assertEqual(self.names(connector)[-1], "get_session")  # Too-late read cannot undo admitted prompt.
        connector = self.Connector(state={"idle": False})
        without_idle = self.policy.replace("3. **IDLE_GATE:**", "3. **REMOVED:**")
        self.assertEqual(self.walk(connector, policy=without_idle), "AGENT_PREPARATION_UNVERIFIED")
        self.assertIn("update_session_runtime", self.names(connector))  # Intact policy prevents even switch.
        connector = self.Connector()
        no_conflict = self.policy.replace("**PLAN_WRITE_CONFLICT:**", "**REMOVED:**")
        self.assertEqual(self.walk(connector, explicit_agent="plan", policy=no_conflict), "PREPARED_AND_SENT")
        self.assertEqual(connector.state["agent"], "plan")
        for path in ("SKILL.md", "references/clarification-sessions.md", "references/task-concept-plan.md",
                     "references/board-workflow.md", "references/work-packages.md"):
            self.assertIn("agent-preparation.md", (self.source / path).read_text())
        self.assertIn("first configured unavailable/incomplete stop", self.policy)
        self.assertIn("Never invent create_session agent/worktree parameters", self.policy)


class TaskDoneArchiveTraceTest(unittest.TestCase):
    """Source-ordered synthetic connector flow; never calls a real archive endpoint."""

    class Connector:
        def __init__(self, links=("session-a",), **flags):
            self.flags = flags
            self.calls = []
            self.task_reads = 0
            self.scan_reads = {}
            self.session_reads = {}
            self.task = {"task_id": "closed-task", "status": "done",
                         "links": [{"session_id": s, "message_id": "submitted-original"} for s in links]}
            self.refs = {s: [{"task_id": "closed-task", "status": "done", "board_project_id": "stream-a"}]
                         for s in set(links)}
            self.sessions = {s: {"id": s, "root": True, "idle": True, "permissions": 0,
                                 "questions": 0, "write": False, "admission_known": True,
                                 "guard": None, "unresolved": False, "archived_at": None}
                             for s in set(links)}

        def call(self, name, **args):
            self.calls.append((name, copy.deepcopy(args)))
            if name == "get_project_task":
                self.task_reads += 1
                task = copy.deepcopy(self.task)
                if self.task_reads > 1 and self.flags.get("reopened"):
                    task["status"] = "in_progress"
                if self.task_reads > 1 and self.flags.get("link_removed"):
                    task["links"] = []
                return task
            sid = args["session_id"]
            if name == "list_project_tasks":
                self.scan_reads[sid] = self.scan_reads.get(sid, 0) + 1
                if self.flags.get("scan_error"):
                    raise RuntimeError("TASK_SEARCH_INCOMPLETE")
                refs = copy.deepcopy(self.refs[sid])
                if self.scan_reads[sid] > 1 and self.flags.get("late_open"):
                    refs.append({"task_id": "master-open", "status": "in_progress", "board_project_id": "stream-b"})
                # A narrowed successful scan can truthfully be complete within
                # that stream and still omit the other stream's open reference.
                if args.get("board_project_id"):
                    refs = [r for r in refs if r["board_project_id"] == args["board_project_id"]]
                return {"tasks": refs, "complete": not self.flags.get("incomplete")}
            if name == "get_session":
                self.session_reads[sid] = self.session_reads.get(sid, 0) + 1
                if self.flags.get("post_archive_read_error") and any(
                        call == "archive_session" and params["session_id"] == sid for call, params in self.calls):
                    raise RuntimeError("archive readback unavailable")
                state = copy.deepcopy(self.sessions[sid])
                if self.session_reads[sid] > 1 and self.flags.get("late_busy"):
                    state["idle"] = False
                if self.session_reads[sid] > 1 and self.flags.get("late_archived"):
                    state["archived_at"] = 98765
                return state
            if name == "archive_session":
                if self.flags.get("no_archive_tool"):
                    raise RuntimeError("unsupported archive")
                if not self.flags.get("uncertain_not_applied"):
                    self.sessions[sid]["archived_at"] = 123456
                if self.flags.get("uncertain_applied") or self.flags.get("uncertain_not_applied"):
                    raise RuntimeError("ARCHIVE_UNCERTAIN")
                return {"session_id": sid, "archived_at": 123456}
            raise AssertionError("Unexpected mutation/tool: " + name)

    def setUp(self):
        self.source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        self.policy = (self.source / "references/task-done-archive.md").read_text()

    def run_flow(self, connector, *, authorized=True, result_secured=True, handback=True,
                 policy=None, lookup=None):
        policy = self.policy if policy is None else policy
        steps = re.findall(r"^\d+\. \*\*([A-Z_]+):\*\*", policy, re.M)
        lookup = lookup if lookup is not None else json.loads(policy.split("```json\n", 1)[1].split("```", 1)[0])
        closed = None
        targets = []
        for step in steps:
            if step == "DONE_AUTHORITY" and not (authorized and result_secured and handback):
                return {"workflow": "AUTHORITY_OR_HANDBACK_MISSING"}
            if step == "DONE_READBACK":
                closed = connector.call("get_project_task", task_id="closed-task")
                if closed["status"] != "done":
                    return {"workflow": "DONE_UNVERIFIED"}
            if step == "EXACT_LINKS":
                targets = list(dict.fromkeys(link["session_id"] for link in closed["links"] if link.get("session_id")))
                if not targets:
                    return {"workflow": "NO_LINKED_TARGETS"}

        def references(sid):
            args = copy.deepcopy(lookup)
            args["session_id"] = sid
            evidence = connector.call("list_project_tasks", **args)
            if not evidence["complete"]:
                return "COVERAGE_UNKNOWN"
            if any(r["status"] not in ("todo", "in_progress", "done") for r in evidence["tasks"]):
                return "STATUS_UNKNOWN"
            if any(r["status"] in ("todo", "in_progress") for r in evidence["tasks"]):
                return "OPEN_REFERENCE"

        def eligible(sid, state):
            return (state["id"] == sid and state["root"] and state["idle"] and
                    not state["permissions"] and not state["questions"] and not state["write"] and
                    state["admission_known"] and not state["guard"] and not state["unresolved"])

        results = {}
        for sid in targets:
            outcome = "NOT_ARCHIVED"
            try:
                for step in steps:
                    if step == "REFERENCE_COVERAGE":
                        blocker = references(sid)
                        if blocker:
                            outcome = blocker
                            break
                    elif step == "SESSION_ELIGIBILITY":
                        state = connector.call("get_session", session_id=sid, include_archived=True)
                        if state["id"] == sid and state["archived_at"]:
                            outcome = "ALREADY_ARCHIVED"
                            break
                        if connector.flags.get("no_archive_tool"):
                            outcome = "ARCHIVE_CAPABILITY_MISSING"
                            break
                        if not eligible(sid, state):
                            outcome = "INELIGIBLE"
                            break
                    elif step == "FRESH_RECHECK":
                        task = connector.call("get_project_task", task_id="closed-task")
                        if task["status"] != "done" or sid not in [r["session_id"] for r in task["links"]]:
                            outcome = "DONE_OR_LINK_DRIFT"
                            break
                        blocker = references(sid)
                        state = connector.call("get_session", session_id=sid, include_archived=True)
                        if state["id"] == sid and state["archived_at"]:
                            outcome = "ALREADY_ARCHIVED"
                            break
                        if blocker or not eligible(sid, state):
                            outcome = blocker or "INELIGIBLE"
                            break
                    elif step == "ARCHIVE_ONCE":
                        uncertain = False
                        try:
                            connector.call("archive_session", session_id=sid)
                        except RuntimeError:
                            uncertain = True
                        try:
                            state = connector.call("get_session", session_id=sid, include_archived=True)
                        except RuntimeError:
                            outcome = "ARCHIVE_UNVERIFIED"
                            break
                        if state["id"] != sid or not state["archived_at"]:
                            outcome = "ARCHIVE_UNVERIFIED"
                        else:
                            outcome = "ARCHIVED_RECONCILED" if uncertain else "ARCHIVED"
            except RuntimeError:
                outcome = "COVERAGE_OR_SOURCE_UNKNOWN"
            results[sid] = outcome
        return results

    @staticmethod
    def archives(connector):
        return [args["session_id"] for name, args in connector.calls if name == "archive_session"]

    def test_last_task_archives_once_with_unfiltered_coverage_and_timestamp_readback(self):
        connector = self.Connector()
        self.assertEqual(self.run_flow(connector), {"session-a": "ARCHIVED"})
        self.assertEqual(self.archives(connector), ["session-a"])
        scans = [args for name, args in connector.calls if name == "list_project_tasks"]
        self.assertEqual(scans, [{"session_id": "session-a", "include_terminal": True}] * 2)
        self.assertEqual(connector.calls[-1], ("get_session", {"session_id": "session-a", "include_archived": True}))
        self.assertGreater(connector.sessions["session-a"]["archived_at"], 0)
        self.assertEqual(connector.task["status"], "done")

    def test_first_task_and_cross_workstream_open_master_block_archive(self):
        for status in ("todo", "in_progress"):
            connector = self.Connector()
            connector.refs["session-a"].append({"task_id": "other-task-or-package", "status": status,
                                                "board_project_id": "stream-b"})
            self.assertEqual(self.run_flow(connector), {"session-a": "OPEN_REFERENCE"})
            self.assertEqual(self.archives(connector), [])
            self.assertEqual(connector.task["status"], "done")

    def test_duplicate_multiple_and_missing_explicit_links(self):
        connector = self.Connector(links=("session-a", "session-a", "session-b"))
        connector.sessions["session-b"]["idle"] = False
        self.assertEqual(self.run_flow(connector), {"session-a": "ARCHIVED", "session-b": "INELIGIBLE"})
        self.assertEqual(self.archives(connector), ["session-a"])
        connector = self.Connector(links=())
        self.assertEqual(self.run_flow(connector), {"workflow": "NO_LINKED_TARGETS"})
        self.assertEqual(self.archives(connector), [])

    def test_partial_failed_coverage_and_unknown_status_are_not_empty_eligibility(self):
        for flags, result in (({"incomplete": True}, "COVERAGE_UNKNOWN"),
                              ({"scan_error": True}, "COVERAGE_OR_SOURCE_UNKNOWN")):
            connector = self.Connector(**flags)
            self.assertEqual(self.run_flow(connector), {"session-a": result})
            self.assertEqual(self.archives(connector), [])
        connector = self.Connector()
        connector.refs["session-a"][0]["status"] = "transfer-pending"
        self.assertEqual(self.run_flow(connector), {"session-a": "STATUS_UNKNOWN"})
        self.assertEqual(self.archives(connector), [])

    def test_busy_input_write_guard_unknown_admission_and_wrong_root_are_skips(self):
        for changes in ({"idle": False}, {"permissions": 1}, {"questions": 1}, {"write": True},
                        {"guard": "historic-user"}, {"unresolved": True}, {"admission_known": False},
                        {"root": False}, {"id": "wrong-session"}):
            connector = self.Connector()
            connector.sessions["session-a"].update(changes)
            self.assertEqual(self.run_flow(connector), {"session-a": "INELIGIBLE"})
            self.assertEqual(self.archives(connector), [])
        connector = self.Connector(no_archive_tool=True)
        self.assertEqual(self.run_flow(connector), {"session-a": "ARCHIVE_CAPABILITY_MISSING"})
        self.assertEqual(self.archives(connector), [])

    def test_missing_authority_handback_or_done_readback_never_archives(self):
        for args in ({"authorized": False}, {"result_secured": False}, {"handback": False}):
            connector = self.Connector()
            self.assertEqual(self.run_flow(connector, **args), {"workflow": "AUTHORITY_OR_HANDBACK_MISSING"})
            self.assertEqual(self.archives(connector), [])
        connector = self.Connector()
        connector.task["status"] = "in_progress"
        self.assertEqual(self.run_flow(connector), {"workflow": "DONE_UNVERIFIED"})
        self.assertEqual(self.archives(connector), [])

    def test_fresh_done_links_reverse_references_and_session_drift_block_mutation(self):
        for flag in ("reopened", "link_removed", "late_open", "late_busy"):
            connector = self.Connector(**{flag: True})
            self.assertNotEqual(self.run_flow(connector)["session-a"], "ARCHIVED")
            self.assertEqual(self.archives(connector), [])
        connector = self.Connector(late_archived=True)
        self.assertEqual(self.run_flow(connector), {"session-a": "ALREADY_ARCHIVED"})
        self.assertEqual(self.archives(connector), [])

    def test_uncertain_archive_reconciles_same_id_without_retry_and_reports_existing(self):
        for flags, expected in (({"uncertain_applied": True}, "ARCHIVED_RECONCILED"),
                                ({"uncertain_not_applied": True}, "ARCHIVE_UNVERIFIED"),
                                ({"uncertain_applied": True, "post_archive_read_error": True}, "ARCHIVE_UNVERIFIED")):
            connector = self.Connector(**flags)
            self.assertEqual(self.run_flow(connector), {"session-a": expected})
            self.assertEqual(self.archives(connector), ["session-a"])
            self.assertEqual(connector.task["status"], "done")
        connector = self.Connector()
        connector.sessions["session-a"]["archived_at"] = 98765
        self.assertEqual(self.run_flow(connector), {"session-a": "ALREADY_ARCHIVED"})
        self.assertEqual(self.archives(connector), [])

    def test_source_mutations_expose_narrowed_lookup_missing_authority_and_late_recheck(self):
        # Source query narrowing hides stream-b despite successful stream-a scan.
        connector = self.Connector()
        connector.refs["session-a"].append({"task_id": "package-open", "status": "in_progress",
                                            "board_project_id": "stream-b"})
        narrowed = {"session_id": "<linked_session_id>", "include_terminal": True,
                    "board_project_id": "stream-a"}
        self.assertEqual(self.run_flow(connector, lookup=narrowed), {"session-a": "ARCHIVED"})
        with self.assertRaises(AssertionError):
            self.assertEqual(self.archives(connector), [])
        connector = self.Connector()
        absent = self.policy.replace("1. **DONE_AUTHORITY:**", "1. **REMOVED:**")
        self.assertEqual(self.run_flow(connector, handback=False, policy=absent), {"session-a": "ARCHIVED"})
        with self.assertRaises(AssertionError):
            self.assertEqual(self.archives(connector), [])
        connector = self.Connector(late_busy=True)
        late = self.policy.replace("6. **FRESH_RECHECK:**", "6. **ARCHIVE_ONCE:**").replace(
            "7. **ARCHIVE_ONCE:**", "7. **FRESH_RECHECK:**")
        self.assertEqual(self.run_flow(connector, policy=late), {"session-a": "ALREADY_ARCHIVED"})
        with self.assertRaises(AssertionError):
            self.assertEqual(self.archives(connector), [])  # Late blocker cannot undo an earlier archive.
        for path in ("SKILL.md", "references/board-workflow.md", "references/clarification-sessions.md",
                     "references/work-packages.md"):
            self.assertIn("task-done-archive.md", (self.source / path).read_text())
        self.assertIn("separate **explicitly requested** operation", self.policy)
        self.assertIn("non-atomic boundary", self.policy)


    def test_r42_pause_go_source_contract_is_bounded_and_receipt_preserving(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        pause = (source / "references/pause-go.md").read_text()
        events = (source / "references/events-attention.md").read_text()
        monitor = (source / "references/monitor-tasks.md").read_text()
        content = (source / "references/content-protocol.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        self.assertIn("2026-10-09-r49", skill)
        self.assertIn("## Cooperative Pause and Weiter/Go", skill)
        self.assertIn("references/pause-go.md", skill)
        for required in ("next safe Tool/Receipt return",
                         "Stop admitting new poll/retry/management/dispatch rounds",
                         "accepted / pending / unknown / unsent",
                         "no `USER_PAUSED` or `PARKED_INPUT_REQUIRED` from bare Pause",
                         "Quoted examples, incidental prose, code, worker results or a mere mention",
                         "never replenish",
                         "Go adds no permissions, no guard override",
                         "exactly **one** concise persistent-impact alert",
                         "do not build a timer, daemon or scheduler"):
            self.assertIn(required, pause)
        # Focused reconciliations where existing wording intersects.
        self.assertIn("pause-go.md", events)
        self.assertIn("never replenishes", events)
        self.assertIn("**not** a monitor/package stop", monitor)
        self.assertIn("PARKED_INPUT_REQUIRED", monitor)
        self.assertIn("pause-go.md", monitor)
        self.assertIn("pause-go.md", content)
        self.assertIn("## Cooperative Pause/Go and silent bounded read retries", scenarios)
        # Mutation controls: removing a boundary must break the required phrase set.
        for mutation in ("next safe Tool/Receipt return",
                         "no `USER_PAUSED` or `PARKED_INPUT_REQUIRED` from bare Pause",
                         "never replenish"):
            self.assertNotIn(mutation, pause.replace(mutation, ""))

    def test_r42_pause_go_flow_stops_at_safe_boundary_and_resumes_exact_state(self):
        class FakeChannel:
            """One selected management channel with a bounded poll/retry budget."""

            def __init__(self):
                self.rounds = 0
                self.cursor = "head"
                self.budget = 2
                self.sent = []
                self.paused = False
                self.lifecycle = "ACTIVE"
                self.alerts = 0

            def admit_round(self):
                if self.paused:
                    return False
                self.rounds += 1
                return True

            def send_once(self, key):
                self.sent.append(key)

        def run_flow(channel, *, pause_at=None, go=False, mutate=None):
            receipts = []
            for round_index in range(4):
                if pause_at == round_index:
                    channel.paused = True
                    if mutate == "ignore_safe_boundary":
                        channel.paused = False
                    if mutate == "force_user_paused":
                        channel.lifecycle = "USER_PAUSED"
                if not channel.admit_round():
                    break
                receipts.append(("inflight", round_index))
                channel.cursor = f"cursor-{round_index}"
                if round_index == 1:
                    channel.budget -= 1
            if go:
                spent = 2 - channel.budget
                channel.budget = 2 if mutate == "replenish_budget" else 2 - spent
                channel.paused = False
                while channel.rounds < 4 and channel.admit_round():
                    channel.cursor = f"cursor-{channel.rounds}"
                if mutate == "replay_accepted":
                    channel.send_once("replayed")
            return receipts

        channel = FakeChannel()
        receipts = run_flow(channel, pause_at=2)
        self.assertEqual(channel.rounds, 2)
        self.assertEqual(receipts, [("inflight", 0), ("inflight", 1)])
        self.assertEqual(channel.lifecycle, "ACTIVE")
        self.assertEqual(channel.budget, 1)
        run_flow(channel, go=True)
        self.assertEqual(channel.rounds, 4)
        self.assertEqual(channel.sent, [])
        self.assertEqual(channel.budget, 1)
        for mutation, kwargs, broken in [
                ("ignore_safe_boundary", dict(pause_at=2), lambda c: c.rounds > 2),
                ("force_user_paused", dict(pause_at=2, go=True), lambda c: c.lifecycle != "ACTIVE"),
                ("replenish_budget", dict(pause_at=2, go=True), lambda c: c.budget == 2),
                ("replay_accepted", dict(pause_at=2, go=True), lambda c: c.sent == ["replayed"])]:
            mutated = FakeChannel()
            run_flow(mutated, mutate=mutation, **kwargs)
            self.assertTrue(broken(mutated), mutation)
            compliant = FakeChannel()
            run_flow(compliant, **kwargs)
            self.assertFalse(broken(compliant), mutation)

    def test_r42_silent_read_retry_episodes_are_finite_and_alert_once(self):
        class ReadModel:
            def __init__(self, outcomes):
                self.outcomes = list(outcomes)
                self.attempts = 0
                self.alerts = 0
                self.episode_open = False
                self.exhausted = False

            def read_once(self, paused=False):
                if paused:
                    return "deferred"
                if self.exhausted:
                    return "exhausted"  # No third attempt inside the unchanged episode.
                self.attempts += 1
                outcome = self.outcomes.pop(0) if self.outcomes else "success"
                if outcome == "success":
                    self.episode_open = False
                    return "success"
                if not self.episode_open:
                    self.episode_open = True
                    return "silent-retry-scheduled"
                # Second consecutive recoverable failure exhausts the budget.
                self.alerts += 1
                self.episode_open = False
                self.exhausted = True
                return "exhausted"

        transient = ReadModel(["failure", "success"])
        self.assertEqual(transient.read_once(), "silent-retry-scheduled")
        self.assertEqual(transient.read_once(), "success")
        self.assertEqual(transient.alerts, 0)
        persistent = ReadModel(["failure", "failure", "failure"])
        self.assertEqual(persistent.read_once(), "silent-retry-scheduled")
        self.assertEqual(persistent.read_once(), "exhausted")
        self.assertEqual(persistent.alerts, 1)
        self.assertEqual(persistent.read_once(), "exhausted")  # exhausted episode: no new attempt or alert
        self.assertEqual(persistent.alerts, 1)
        self.assertEqual(persistent.attempts, 2)
        paused = ReadModel(["failure", "success"])
        self.assertEqual(paused.read_once(), "silent-retry-scheduled")
        self.assertEqual(paused.read_once(paused=True), "deferred")
        self.assertEqual(paused.attempts, 1)

    def test_r42_fallback_routing_source_contract_is_evidence_bound(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        routing = (source / "references/fallback-routing.md").read_text()
        scenarios = (source / "references/regression-scenarios.md").read_text()
        self.assertIn("references/fallback-routing.md", skill)
        self.assertIn("Error fallback is separate from that resolution map", skill)
        for required in ("after native retries completed",
                         "A plain rate limit is **not** proven exhaustion",
                         "no automatic provider/model choice of any kind",
                         "Deep → Standard → Execution → Fallback",
                         "Design → Standard → Execution → Fallback",
                         "Review → Deep → Standard → Execution → Fallback",
                         "no upward switches and no loops",
                         "never change the business role",
                         "Per-step return",
                         "native compaction",
                         "exactly one correlated, aligned continuation",
                         "previous regular profile including its thinking stage",
                         "no infinite compaction/retry loop",
                         "No secrets, no raw responses"):
            self.assertIn(required, routing)
        self.assertIn("## Error-fallback routing and context recovery", scenarios)

    def test_r42_fallback_chains_are_finite_role_true_and_never_auto_select(self):
        POLICY = {
            "profiles": {"deep": {"p": "a"}, "standard": {"p": "b"}, "execution": {"p": "c"},
                         "design": None, "review": {"p": "d"}},
            "final_fallback": {"mode": "total", "selection": {"p": "z"}},
        }
        DEGRADING = {**POLICY, "final_fallback": {"mode": "degrading", "selection": {"p": "z"}}}
        CHAINS = {"deep": ["deep", "standard", "execution"], "standard": ["standard", "execution"],
                  "execution": ["execution"], "design": ["standard", "execution"],
                  "review": ["review", "deep", "standard", "execution"]}

        def route(policy, start, failed_providers, error_class):
            if error_class not in ("timeout", "quota"):
                return {"action": "surface", "switches": []}
            fallback = policy.get("final_fallback")
            if not fallback:
                return {"action": "INPUT_REQUIRED", "switches": [], "reason": "final fallback unconfigured"}
            if fallback["selection"]["p"] in failed_providers:
                return {"action": "INPUT_REQUIRED", "switches": [], "reason": "configuration finding"}
            switches = []
            if fallback["mode"] == "total":
                return {"action": "fallback", "switches": [fallback["selection"]],
                        "continuations": 1}
            for candidate in CHAINS[start][CHAINS[start].index(start) + 1:] if start in CHAINS[start] else []:
                selection = policy["profiles"].get(candidate)
                if selection is None or selection["p"] in failed_providers:
                    continue
                switches.append(selection)
                return {"action": "candidate", "switches": switches, "continuations": 1}
            return {"action": "fallback", "switches": [fallback["selection"]], "continuations": 1}

        total = route(POLICY, "review", {"d"}, "timeout")
        self.assertEqual(total["action"], "fallback")
        self.assertEqual(total["switches"], [{"p": "z"}])
        self.assertEqual(total["continuations"], 1)
        degrading = route(DEGRADING, "review", {"d", "a"}, "quota")
        self.assertEqual(degrading["action"], "candidate")
        self.assertEqual(degrading["switches"], [{"p": "b"}])
        self.assertEqual(route(DEGRADING, "review", {"d", "a", "b", "c"}, "quota")["action"], "fallback")
        self.assertEqual(route({**POLICY, "final_fallback": None}, "deep", set(), "timeout")["action"], "INPUT_REQUIRED")
        self.assertEqual(route(POLICY, "deep", {"z"}, "timeout")["reason"], "configuration finding")
        self.assertEqual(route(POLICY, "deep", set(), "rate_limit_only")["action"], "surface")
        self.assertEqual(route(POLICY, "deep", set(), "context_input_length")["action"], "surface")
        # Mutation controls: an auto-selecting or looping variant must differ.
        def mutated_route(policy, start, failed, error_class):
            result = route(policy, start, failed, error_class)
            if result["action"] == "INPUT_REQUIRED" and not policy.get("final_fallback"):
                return {"action": "fallback", "switches": [{"p": "lm-studio-auto"}]}
            return result
        self.assertEqual(mutated_route({**POLICY, "final_fallback": None}, "deep", set(), "timeout")["switches"],
                         [{"p": "lm-studio-auto"}])
        self.assertNotEqual(mutated_route({**POLICY, "final_fallback": None}, "deep", set(), "timeout"),
                            route({**POLICY, "final_fallback": None}, "deep", set(), "timeout"))

    def test_w2_production_code_only_budget_and_read_episode_source_traces(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        skill = (source / "SKILL.md").read_text()
        timeline = (source / "references/integration-test-monitor.md").read_text()
        events = (source / "references/events-attention.md").read_text()
        monitor = (source / "references/monitor-tasks.md").read_text()
        packages = (source / "references/work-packages.md").read_text()
        mvp = (source / "references/optimistic-mvp.md").read_text()
        self.assertIn("2026-10-09-r49", skill)
        self.assertIn("## 2026-10-08-r44", (source / "CHANGELOG.md").read_text())
        # Production-Code-Only cap with excluded classes, progress and no-reset.
        for required in ("at most two autonomous PRODUCTION-CODE repair cycles",
                         "they never count and never park",
                         "evidenced progress ends the no-progress series",
                         "no third fix",
                         "no message/clock/Resume/rename resets or extends the counter"):
            self.assertIn(required, timeline)
        for required in ("at most two PRODUCTION-CODE repairs for the same error without evidenced progress",
                         "infrastructure work never counts",
                         "later healthy Go/wakeups are never parked by historical read errors"):
            self.assertIn(required, events)
        self.assertIn("same-fingerprint **production-code** repair cap", monitor)
        self.assertIn("production-code no-progress cycles; excluded work never counts", monitor)
        self.assertIn("no-progress autonomous **production-code** repair cycles", packages)
        self.assertIn("at most two **production-code** repairs", mvp)
        self.assertIn("exhausted bounded **production-code** repair budget", skill)
        # Finite read episode separated from the repair counter.
        for required in ("bounded causal backoff, success ends the episode",
                         "only persistently current unavailability holds dependent steps back",
                         "never fabricate worker FAIL/PASS"):
            self.assertIn(required, timeline)
        # Uncertain non-idempotent writes remain receipt-reconciled, distinct.
        self.assertIn("No retry of `SUBMISSION_UNCERTAIN`", timeline)
        # Scheduler clock stays independent of the work lifecycle.
        self.assertIn("Work park/PASS/STOPPED never stop the scheduler", timeline)

    def test_w2_six_override_cases_are_planned_and_labels_are_honest(self):
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        scenarios = (source / "references/regression-scenarios.md").read_text()
        self.assertIn("## Production-code-only repair budget and finite read episodes (W2 override)", scenarios)
        for required in ("Transient read errors followed by success",
                         "no repair-counter consumption",
                         "Historical read errors plus a later healthy Go/turn/wakeup",
                         "No `2/2` park",
                         "Persistent read unavailability",
                         "exactly one concise persistent-impact alert",
                         "worker status is never fabricated as FAIL/PASS from a read gap",
                         "Two production-code repairs of the same fingerprint without evidenced progress",
                         "an infrastructure/test/doc/management fix of the same fingerprint must not count",
                         "Mixed read errors, repair attempts, Pause/Resume and an uncertain non-idempotent receipt",
                         "never blindly retried or duplicated",
                         "Repo/skill structural check versus host/scheduler E2E",
                         "no synthetic E2E PASS"):
            self.assertIn(required, scenarios)

    def test_w2_mutation_controls_and_reference_model_stay_scoped(self):
        """Instruction-level checks only: a spec reference model and mutation
        controls over the scoped budget wording. This is a repository/spec
        simulation — not the production engine (W3) and not hosted behavior."""
        source = ROOT / BUILDER.PACKAGE / "opencode-session-orchestrator"
        timeline = (source / "references/integration-test-monitor.md").read_text()

        def scoped_checks(text):
            return [
                "at most two autonomous PRODUCTION-CODE repair cycles" in text,
                "they never count and never park" in text,
                "evidenced progress ends the no-progress series" in text,
                "bounded causal backoff, success ends the episode" in text,
                "only persistently current unavailability holds dependent steps back" in text,
            ]

        self.assertTrue(all(scoped_checks(timeline)))
        for mutation in ("PRODUCTION-CODE repair cycles",
                         "they never count and never park",
                         "evidenced progress ends the no-progress series",
                         "bounded causal backoff, success ends the episode",
                         "only persistently current unavailability holds dependent steps back"):
            mutated = timeline.replace(mutation, "REMOVED-CONTROL")
            self.assertFalse(all(scoped_checks(mutated)), f"mutation not detected: {mutation}")

        class BudgetModel:
            """Reference model for the six W2 cases (spec simulation only)."""

            def __init__(self):
                self.repairs = {}
                self.episode = {}

            def read(self, fingerprint, ok, persistent=False):
                if ok:
                    self.episode[fingerprint] = 0
                    return "continue"
                if persistent:
                    return "dependent-blocked-until-recovery"
                return "bounded-backoff-continue"

            def repair(self, fingerprint, kind, evidenced_progress=False):
                if kind != "production-code":
                    return "not-counted"
                if evidenced_progress:
                    self.repairs[fingerprint] = 0
                    return "progress-recorded-not-a-no-progress-failure"
                attempts = self.repairs.get(fingerprint, 0)
                if attempts >= 2:
                    return "parked-no-third-fix"
                self.repairs[fingerprint] = attempts + 1
                return "repair-attempt"

            def uncertain_write(self, reconciled):
                return "send" if reconciled else "reconcile-exact-receipt-first"

            def scheduler(self, work_state):
                return "enabled"

        model = BudgetModel()
        self.assertEqual(model.read("r1", ok=False), "bounded-backoff-continue")
        self.assertEqual(model.read("r1", ok=True), "continue")
        self.assertEqual(model.read("history", ok=True), "continue")
        self.assertEqual(model.read("down", ok=False, persistent=True), "dependent-blocked-until-recovery")
        self.assertEqual(model.repair("f", "production-code"), "repair-attempt")
        self.assertEqual(model.repair("f", "production-code"), "repair-attempt")
        self.assertEqual(model.repair("f", "production-code"), "parked-no-third-fix")
        self.assertEqual(model.repair("f", "infrastructure"), "not-counted")
        self.assertEqual(model.repair("f", "tests"), "not-counted")
        self.assertEqual(model.repair("p", "production-code", evidenced_progress=True),
                         "progress-recorded-not-a-no-progress-failure")
        self.assertEqual(model.uncertain_write(reconciled=False), "reconcile-exact-receipt-first")
        self.assertEqual(model.uncertain_write(reconciled=True), "send")
        for state in ("ACTIVE", "PARKED_INPUT_REQUIRED", "COMPLETE_PASS", "STOPPED"):
            self.assertEqual(model.scheduler(state), "enabled")


if __name__ == "__main__":
    unittest.main()
