# Changelog

## 2026-10-02-r28

- Route explicit management-note verification and monitor checkpoint recovery through the discovered persistent Taskboard journal: latest checkpoint, entries after it, bounded older-history cursors and revision-bound legacy Description pages.
- Keep connector compatibility honest: normal task Description remains unchanged for new journal notes; old connectors retain only their observed legacy behavior, and journal/I/O/coverage uncertainty blocks dependent action without blind replay.
- Add source/scenario checks for persistent-history use, legacy notes, incomplete-history failures and the r27 monitor boundaries. No operator-authentication or scheduled-resume provenance behavior is added.

## 2026-10-01-r27

- Make simple first / complexity on evidence a core rule with targeted Operator Spot-Checks, persisted Lean assumptions and delta/JIT readiness; keep actual write-target and semantic security boundaries.
- Add instruction-only scheduler-supported Monitor Tasks: one master, current external capability/model/connection/single-flight gates, Direct Create or full bootstrap, activation readback/receipt, exact correlation and compact append-only checkpoints. No VM scheduler or blind retry.
- Add two policies sharing one wakeup loop: strictly sequential monitored package Waves and conservative long-test worker plus bounded manager diagnosis/harness repair/focused regression/Resume-or-Fresh. Keep two same-fingerprint no-progress repairs as default.
- Define ACTIVE/PARKED_INPUT_REQUIRED/COMPLETE_PASS/STOPPED and cheap parked/terminal no-op. Operator Override/Resume provenance stays in existing downstream QC; unauthenticated notes never authorize scheduled reactivation, and no duplicate follow-up is created.
- Add focused source/scenario and synthetic flow regressions; hosted scheduler/app access and both real pilots remain separate acceptance.

## 2026-09-30-r26

- Deep-QA clarifies existing ownership across simultaneous Work Packages/manual writers and serial publication of member C/P deltas to the canonical connector document root; a private worktree copy is not a registered document.
- Revalidate named-wave readiness on every dispatch/resume and reject stale, empty, unknown-member or cyclic-dependency evidence. Apply write-worktree checks to mutating members only; a blocked later wave leaves an already started package's actual Board status intact.
- Complete the existing cleanup contract for relevant ignored outputs and detached-source commit reachability. Preserve source evidence before removal; an SHA in Markdown is not a retained Git object.
- Strengthen focused negative regressions for cross-package ownership, readiness drift, evidence-limited Morning Handoff and real nested/detached Git worktree retention. Keep the existing MCP/Managed/approval and document-binding boundaries unchanged.

## 2026-09-30-r25

- Define general agent-managed Git/worktree ownership before repository writes: verify the actual repository/worktree/base/dirty state and each file-tool target, assign one active writer per tree/index, isolate concurrent writes and serialize shared integration. Local commits remain task-scoped; remote publishing remains operator-only.
- Add persistent project-local Work Packages using existing Board management tasks, stable member task IDs and task Compact Context/Concept Plan documents. Cover package assembly from IDs or goal searches, deduplication, `todo` readiness gaps, wave planning, `WORK_PACKAGE_READY`, dependent-HEAD verification, integration, retention and Morning Handoff without a new MCP package schema.
- Define the plan-bounded autonomy/terminal `INPUT_REQUIRED` contract, compact Chat-to-Work handoff, and separate OpenCode profile resolution from the ChatGPT Work model picker. Work availability and tool access are checked on the actual selected surface; no automatic Work invocation or background monitoring is claimed.
- Add ownership, package-readiness, dependency, park/continue, cleanup, Work handoff and runtime-choice regression scenarios. Keep `CONCEPT_READY` → `REGISTERED` intact; package-only `WORK_PACKAGE_READY` is an additional pre-Board-move gate.

## 2026-09-30-r24

- Document backend-owned agent-managed work admission without client flags or repeated primer/permission rituals; preserve READ and pure-management neutrality.
- Distinguish normal terminal business INPUT_REQUIRED text from real pending security/host approvals; resolve in Voice/Chat and send one normal same-session follow-up.
- Keep local development autonomy task-scoped and remote publishing operator-only; retain r21/Header/ACH-1 contracts and Review intent.

## 2026-09-30-r23

- Integrate ACH-1's actual-capability-gated Design/Review classification, fixed null-only fallbacks and requested/resolved-role disclosure onto the consolidated r21 + Header/r22 baseline.
- Preserve independent Review intent without automatic findings implementation; keep user override, idle/pending, exact runtime readback and single-send rules.
- Retain all add-only task binding, header/metadata evidence, same-file recovery, management-note and no-blind-retry rules. Optional-profile availability is discovered, not manufactured by a connector restart.

## 2026-09-30-r22

- Integrate isolated Header-Validation onto r21: require exact plain-text first lines and actual role/path-bound C/P header/metadata readback in the terminal and original final result before `CONCEPT_READY`; “checked” or IDs alone cannot pass.
- Diagnose missing file vs wrong path vs ID/format mismatch; repair only the same safely task-owned files within authorized scope, preserve body and successful bindings, renew evidence, bind/read back again. Foreign identity requires `INPUT_REQUIRED`, never overwrite.
- Preserve r21's preferred add-only bundle, absent-tool register fallback, exact replay, mandatory available/path/revision readback and separate Board move/status readback. No fallback after error, replace/retarget, new parser/tool, CAS or blind note/move retry.
- Port header/recovery regressions onto both binding paths and keep local/synthetic evidence distinct from Hosted model behavior.

## 2026-09-30-r21

- Prefer discovered `add_task_document_bindings` for both main roles in one add-only commit; retain `register_task_document` only when the new tool is absent, never after a conflict/error.
- Preserve `CONCEPT_READY` → bindings → available/path/revision readback → `REGISTERED` → separate Board move/status readback → `BOARD_MOVED`, including orphan reuse and exact-replay recovery. No cross-store transaction is claimed; uncertain Board delivery requires status reconciliation.
- Add explicitly authorized native management notes: task read, one narrow append, readback; no blind retry, automatic notes or general-edit fallback. Document UI/edit races and honest annotations without approval promises.
- Extend synthetic sequence, replay, fallback, failure and note regressions; hosted model behavior remains separate from package/connector tests.

## 2026-09-29-r20

- Introduce labelled checkpoints `CONCEPT_READY` (agent), `REGISTERED` (orchestrator — both roles bound and read back as `available`) and `BOARD_MOVED` (orchestrator — Board move + readback confirmed) as the single shared frame for the post-agent follow-through. The agent's `CONCEPT_READY` is the start of the orchestrator's follow-through, not its end; the Board never moves before `REGISTERED`.
- Add `references/initialization-follow-through.md` as the canonical document for the labelled checkpoints, the orphan-files recovery path and the failure-shape catalogue; reference it from `SKILL.md`, `references/board-workflow.md` and `references/task-concept-plan.md`.
- Make the orphan-files recovery path explicit: detect → verify `Task-ID` → reuse existing matching files → run the same `register_task_document` + `get_task_documents` sequence → run the Board move + readback. Do not ask the executing agent to recreate, do not rename, do not invent legacy artifact links. A foreign `Task-ID` at a canonical path is a collision and stops the run.
- Require the executing agent's reply on a successful file creation/reconciliation to end with the literal `CONCEPT_READY:` label and the actual `Task-ID` from each file's head block (not a paraphrase). Path-only reports are rejected; the orchestrator asks for the actual `Task-ID` before any registration call.
- Extend the regression scenarios with rows that cover: orchestrator advances the Board before `REGISTERED`; orchestrator skips the Board move after `REGISTERED`; orphan matching files reused without recreation; uncertain Board readback; same-session follow-up continuation; approval interrupt that preserves the last successful step and resumes from the next pending step.
- Add a flow-level regression test (`test_initialization_follow_through_sequence_walks_orchestrator_side`) in `tests/chatgpt_skill_test.py` that walks the ordered sequence against a small in-memory `FakeConnector` + `FakeAgent` across six scripted scenarios (clean run, premature-Board-advance guard, partial registration, move-failure, orphan reuse, foreign-Task-ID collision) and asserts the orchestrator's action in each.
- Preserve every r19 feature and assertion; no new MCP tool, scheduler, daemon or background process.

## 2026-09-29-r19

- For confirmed `todo` -> `in_progress` work, keep the Board task `todo` while the executing agent creates/reuses and identifies both task files; register/read back semantic `compact_context` and `concept_plan` references before the Board move. Reuse documents after an uncertain or failed move.
- Prefer discovered `get_task_documents`/`read_task_document` for independent checkpoint QA and token-light Executive reads: context first, main/index plan only for conceptual depth, relevant registered details on demand. Verify executed work from original session results. Restart changed file reads by revision; incomplete pages never establish a full QA pass.
- Preserve r18 size and staged prompt policy and retain the exact-text agent-mediated fallback for connectors without task-document reads.

## 2026-09-29-r18

- Add approximate task-file size policy: Compact Context targets ~5k tokens, warns at ~7.5k and condenses by ~10k while remaining one file; Concept Plan main file targets ~20k, warns at ~30k and splits task-ID-named detail documents by ~40k while remaining the canonical index. No tokenizer dependency or duplicated plan/context content.
- Stage the executing agent's maintenance instructions: full roles and thresholds once on initialization/new work context, fuller policy/quality refresh at authorized QA checkpoints, and a single short path-bearing reminder for ordinary substantive work. Tiny/read-only mini-work omits the maintenance reminder; pure status/result reads submit no prompt. Preserve read-only scope for substantive investigations.
- Extend regression scenarios for thresholds, one-file context, split-plan index, all three handoff tiers and no-reminder reads.

## 2026-09-29-r17

- Align both task files: plan-backed work carries the plan path and, when established, the context path, including routine tests and same-session follow-ups; update the plan only for substantive conceptual findings. The board governs outcome/scope, the plan settled design within scope, the context current state and session results observed evidence.
- Clarify the confirmed `todo` -> `in_progress` initialization: reuse and reconcile matching files, never overwrite a different task's file, use only known IDs in the initial context, and report uncertain/missing initialization as pending. Already-running tasks require explicit backfill rather than a fictitious transition.
- Unify early and milestone quality checks for both files; incomplete agent-supplied plan text cannot pass a full-file check. Clarifications respect their actual read/write scope, and plan closure edits require authorized file writes.

## 2026-09-29-r16

- Introduce the optional persistent **task concept plan** alongside the compact context: a longer, authoritative concept/architecture/decision/test document at `planning/task-concepts/<task_id>-concept-plan.md`, distinct from the board description, compact context and session history.
- Require every task-related handoff with conceptual relevance to include the plan path alongside the compact context and tell the executing agent to write substantive conceptual findings (architecture, decisions, alternatives, interfaces, risks, implementation/test shifts) back into the plan, not only the context. The plan is canonical for stable decisions; the context cites it without duplicating rationale.
- Mandate initialization on `todo` -> `in_progress`: in the same authorized write-capable work request, assign both files (or reuse existing ones with matching `Task-ID`); transfer relevant concept starting state from the ticket description into the plan; initialize the compact context minimally. A board read alone must not create either file. Existing tasks without a concept plan remain backward compatible until that transition triggers initialization.
- Add introductory orchestrator quality checks: early after `todo` -> `in_progress`, after long/large iterations or several substantive follow-ups, after conceptually significant findings and before major handoffs; use the same agent-mediated exact-text mechanism as for the compact context when no direct project-file read exists, and route specific defects back to the executing agent without becoming the routine editor or creating an unsolicited QA task.

## 2026-09-29-r15

- Make the executing agent's read-first and compact-update duty an explicit part of **every** context-backed task handoff; distinguish read-only instructions and unknown file existence after a new chat.
- Require introductory orchestrator quality checks after the first substantive work and after long/large or several substantial follow-ups. Check actual context text against the board and original results for identity, freshness, continuation value and compactness; when no project-file read exists, request exact text in an authorized checkpoint result and mark missing evidence pending.
- Route specific stale/missing-context corrections back to the executing agent in the next authorized follow-up, without moving ongoing maintenance to the orchestrator or generating an unsolicited repair task.

## 2026-09-29-r14

- Introduce the optional persistent **task compact context**: one small task-`task_id`-bounded Markdown file (default `.opencode/tasks/task-<task_id>.compact.md`) as long-lived working memory for multi-iteration board tasks, distinct from the board description, session/result history and scope/auth sources.
- Every task-related handoff for a context-keeping task now references the file by path, requires reading it before work and mandates a compact update after substantial iterations; handoffs without that reference when a context exists are treated as defective.
- Add client-side registry tracking of path/`task_id`/`Last-updated`, new decision-preparation integration, and board-workflow integration for start/resumption/follow-up and remainder previews.
- Preserve backward compatibility: tasks without a compact context behave unchanged; creating one is an optional, user-confirmed choice with no board mutation and no new MCP tool or backend field.

## 2026-09-29-r13

- Propose classification only for trackable outcomes; search existing Board Projects and tickets before offering a confirmed extension, ticket, workstream or Inbox setup.
- Keep board writes user-confirmed, distinguish native Inbox-to-workstream reclassification from the unavailable global/local transfer, and recover uncertain transfers by the same request UUID.
- Allow the same reclassification between any two existing active Board Projects; replay with a stale source fails closed and an aborted journal rejects further use of that UUID.
- Keep technical transfer staging and agent/session completion separate from business Done; add synthetic classification and recovery cases.

## 2026-09-28-r11

- Use transport-neutral project runtime profiles `deep`, `standard`, and `execution` for new authorized work when supported; explicit user choices take precedence.
- Apply an available configured runtime to an idle session before sending and briefly disclose profile/model/variant. Pure reads never switch; unavailable mappings are not silently substituted.
- Replace fixed clarification model/variant heuristics with project profile resolution and exact readback.

## 2026-09-28-r10

- Add capability-driven project-board lookup: exact task IDs, title/description search, task/session reverse lookup, search-before-create and explicit incomplete-scan reporting.
- Keep board outcomes separate from session execution, read complete originals before business conclusions, and preserve multiple session/message references without assuming a review-role taxonomy.
- Add a read-only remainder-synthesis preview that accounts for every known open obligation and marks gaps without applying task mutations or making completion claims.

## 2026-09-28-r9

- Add a discovered-tool-only upload workflow for supported images and text/Markdown using session-bound, one-use attachment IDs; preserve normal `send_message` write/uncertain semantics.
- Add an explicit PDF-to-Markdown/text fallback, size-aware splitting and coverage rules, plus a no-raw-upload policy for other unsupported types.
- Add synthetic image/text, PDF extraction, limits, unsupported model/type and expired/one-use reference review scenarios. This package does not claim hosted ChatGPT or Voice attachment acceptance.

## 2026-09-28-r8

- Add an explicit recovery path for `SUBMISSION_UNRESOLVED`: inspect the exact old receipt and current guard, explain the remaining risk, and require fresh user approval tied to that guard.
- Use `supersede_unresolved_submission` only when discovered; it atomically audits the operator decision and submits the approved next task once. Verify its own returned message ID without a second send.
- Preserve the exact client UUID/request on uncertain recovery, never infer operator approval from the original task authorization, and stop on stale guards, active work or pending input.
- Add synthetic regression scenarios; this instruction package does not claim hosted ChatGPT behavior or live override acceptance.

## 2026-09-27-r7

- Explicitly classify each new `send_message` task as a write-capable, non-idempotent connector call, independently of a read-only remote task scope.
- Distinguish existing-result retrieval from fresh read-only research, preserve explicit prompt limits and leave approval decisions to the host/backend without retrying to provoke a card.
- Add synthetic A–E regression scenarios for status reads, read-only research, planning-file edits, uncertain delivery and explicit WRITE/read-only phrasing.

## 2026-09-27-r6

- Proactively offer bounded `[KLÄRUNG]` sessions for independent code/planning details while the original workstream is busy; create them only for an authorized clarification, with an exact origin link and focused context handoff.
- Choose the newest identifiable OpenAI Luna with `xhigh` from the live catalog, verify runtime before submission and route emerging concept planning into a consciously chosen workstream.
- Separate local closure from optional user-requested server archiving, with explicit archived-content reads where available; collect MCP/skill product suggestions for the responsible programmer rather than silently implementing them during subject work.

## 2026-09-27-r5

- Explain the MCP admission distinction between backend/concurrent-write `SESSION_BUSY`, idle-but-unverified `SUBMISSION_UNRESOLVED`, and potentially delivered `SUBMISSION_UNCERTAIN`.
- Bind an unresolved rejection's correlation ID to the older receipt, not the rejected new request; do not treat idle or finished tool-call steps as proof of task completion.
- Use the server's error metadata and admission state where available, without assuming these fields exist on other compatible connectors.
- Add synthetic regression cases for stale guards, unrelated busy signals and uncertain new sends. No write retry or permission-setting behavior is added.

## 2026-09-27-r4

- Maintain the reviewed skill as an optional, generic client package in the opencode-vm repository; preserve the skill name and display name.
- Add capability-based Delivery B tool progress, bounded coverage, session-wide pending-input handling and idle/stored-state interpretation.
- Add recent journal tail reads and independent progress per project/filter; distinguish a captured-head continuation from historical consumption.
- Clarify response-local `content_complete`, including a false value on the final page of a fully traversed visible stream.
- Discard old search-page accumulation after `SEARCH_CHANGED`; deduplicate only within the new search attempt.
- Add explicit connection selection for multiple compatible servers and preserve legacy fallbacks. No fixed tunnel IDs, account identifiers, server aliases or credentials are bundled.
- Replace the icon with an independently drawn OpenCode VM enclosure/terminal design. Keep documented UI/invocation metadata; remove the earlier unverified product-list declaration rather than claiming installation compatibility across products.
- Keep task submission and request lookup capability-driven: idempotent submission and restricted analysis are not assumed to exist.
- Add Delivery B and multi-connector behavioral review cases. These are scenarios, not claims of live ChatGPT/Voice acceptance.

## 2026-09-27-r3

Permission-flow update on top of r2; retain complete long-content retrieval, exact-task verification, session tracking, decision preparation and concept-persistence behavior.

- Add a prominent approval-flow section and dedicated reference.
- Act on clear conversational authorization without another invented "shall I send" loop.
- Preserve one pending invocation across on-screen approval and interruptions.
- Separate missing response, host approval, MCP acceptance, backend permission and execution.
- Require actual error evidence before saying a send failed; protect against duplicate non-idempotent submissions.
- Preserve approved bounded work packages without per-step verbal bureaucracy.
- Add dated official documentation for per-tool conversation approval and refresh behavior, app-specific permissions, accurate annotations and API/ChatGPT differences.
- Do not advertise snapshot-based arbitrary execution as read-only or universally risk-free; use only real supported narrower capabilities.
- Add 23 synthetic approval-flow regression cases; no live writes or permission changes performed by packaging.

This package does not automatically update the installed skill or app/workspace permissions. The marker is a skill revision, not an MCP protocol/server version.

## 2026-09-27-r2

Update of the existing `opencode-session-orchestrator` skill; preserve its name, display name, icon and implicit invocation policy. This marker is a skill-bundle revision, not a claimed server or MCP protocol version.

- Add capability-based use of `get_task_result`, `get_message` and `read_message_content`, with legacy fallback.
- Separate task-search completion, history paging, visible-text coverage and omitted parts.
- Add stable content-reference/cursor handling, revision changes, UTF-8 range continuity and truthful checksum reporting.
- Tighten exact-message send verification: accepted is not running; pending approval is not a proven failed send.
- Handle bounded status windows, task-state conflicts and journal coverage gaps without blind resubmission.
- Preserve active/waiting/attention/parked/closed topics and prepared-but-unsent follow-ups across session switches.
- Require architecture context, operational examples, evidence and recommendations for every decision topic and delegated request.
- Separate user decisions, expert code checks, authorized live verification, implementation planning and execution.
- Add concept-persistence and contradiction-check guidance without treating planning as permission to implement.
- Add regression scenarios for the observed failure patterns.

Bundle no live session registry, private project IDs, credentials or project-specific business decisions. Add no executable scripts or background monitor.
