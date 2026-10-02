Task-ID: task_160e0556-f3a8-5e12-a877-ed22e7bb2360
Title: Orchestrator – Quality-Control-Sammel- und Abnahmetask
Status: draft
Last-concept-update: 2026-10-02T12:11:57+02:00

# Canonical Concept Plan

## 1. Authority, preparation scope and dependency

This is the existing central QC/acceptance task, not an independent feature/scope-expansion task. Its complete current Board description was read from the local Board service using the stable public task ID and verified against the deterministic ID mapping. It is MCP-16 in workstream `board_project_1bdf1737-f1ca-323e-7a7d-3025c99f2cb4`, status `todo`, priority `high`, last Board update `2026-10-01T17:47:11.097098664+02:00`. The Board task has no task-document mapping in the current project sidecar. The matching task-owned C/P files now exist at the paths below but are not yet registered. QC-5 is an existing `Management Note:` in the authoritative Description, not new scope invented by this preparation.

Board = outcome/scope and QC criteria. This P = detailed canonical review requirements, settled boundaries, evidence method and test/acceptance concept. C (`.opencode/tasks/task-task_160e0556-f3a8-5e12-a877-ed22e7bb2360.compact.md`) = one terse working-state file. Original session results, inspected bytes/Git and actual test reports = execution evidence. A Board `done`, idle worker, completed model turn or planning statement is not a QC PASS.

This session reads the complete Board descriptions for Task B, its origin task `task_9dc6e797-b884-589a-99d7-fd3ceceb5414`, and the two user-designated release blockers. The origin is MCP-12, **Orchestrator Skill – agent-managed Worktree-Isolation und persistente Arbeitspakete**, `in_progress`/high, description updated `2026-09-30T20:46:14.201558687+02:00`. Its Board scope covers generic write-tree ownership, persistent package/wave planning, handoff and operator-only remote publishing. Task A is MCP-15, `in_progress`/high. The existing C/P files are retained because their first-line Task-IDs match B; they remain unregistered. This work reconciles task documents only: no QC test/review, correction, document binding, Board move/status change, connector restart, infrastructure action or release. `CONCEPT_READY` is this agent's handoff only; the plan's `draft` label is concept lifecycle, not Board state or a QC verdict.

### Fixed later execution order

1. **Task A:** `task_a73131d9-b3c3-57e2-b1aa-582204f248e0` — Management Journal foundation; implemented, regression-checked and integrated locally.
   - C: `.opencode/tasks/task-task_a73131d9-b3c3-57e2-b1aa-582204f248e0.compact.md`.
   - P: `planning/task-concepts/task_a73131d9-b3c3-57e2-b1aa-582204f248e0-concept-plan.md`.
2. **Task B:** this task — QC/acceptance on A's actual integrated implementation and the current Orchestrator context.

The dependency now has an actual integrated subject: `62869f68fc2ccbea302d34c2bd39900dbc813090` on `main` (parent `e6acbb97adb530caf73163f7ae2b010a81e6e54d`), adapter 0.1.22, script 0.7.2 and companion marker `2026-10-02-r28`. Task A's C/P and its original implementation/test evidence were read. This satisfies the prerequisite to conduct QC-3; **QC-3 and every other point remain PENDING because the Task B review/verdict has not been performed.** A green suite or document handoff is not a QC verdict or hosted acceptance.

## 2. Problem and target outcome

Persistent Work Package and Monitor management must survive a fresh supervisor context. It must recover the current task order, decision/checkpoint, historical repair limits and uncertain worker delivery without redoing an old action or reopening the same already-resolved park. Long-running management also needs storage/read limits that do not invalidate ordinary Board reads. Rules written only in concept text, incomplete synthetic coverage or an unauthenticated resume label cannot prove that behavior.

The target is a traceable verdict **PASS / FAIL / PENDING for each existing QC-1–QC-5**, with actual evidence and honest coverage boundaries. A FAIL names the precise mismatch, affected file/rule/test and smallest correction proposal. Missing prerequisites/external evidence remain PENDING; genuine missing product/architecture/data-schema/security decisions are returned as terminal `INPUT_REQUIRED`, never improvised by the reviewer. This task is the central collection point for relevant QC findings, not authority to create new product semantics.

## 3. Current integrated r28 evidence and inherited contracts

Current review-preparation baseline: `/Users/admin/Documents/github/opencode-vm`, branch `main`, HEAD `62869f68fc2ccbea302d34c2bd39900dbc813090`; integrated Task A is based on `e6acbb97adb530caf73163f7ae2b010a81e6e54d`. Source MCP package/adapter pin is 0.1.22; `integrations/chatgpt/bundle.json`, `SKILL.md` and changelog are r28 (`2026-10-02-r28`). Task B's C/P and several other task C/P plus pre-existing `dist/` archives are untracked and preserved; only the four exact Task A/Task B C/P paths are edited by this document work. The Board and project sidecar are not modified.

Read sources / conceptual anchors:

- `integrations/chatgpt/opencode-session-orchestrator/SKILL.md`: capability discovery, simple-first/Lean assumptions, exact task/receipt/result evidence, scope, staged C/P maintenance, Work/OpenCode boundaries and Monitor routing.
- `references/monitor-tasks.md`: now routes supported checkpoint recovery through `get_task_management_history`; separates journal and legacy Description, documents 40-KiB note/64-MiB task journal/40,000-byte normal task response and 32,000-UTF-16-codeunit legacy Description boundaries, and explicitly keeps stored-note scheduled-resume provenance deferred/fail-closed.
- `references/integration-test-monitor.md`: fail-fast worker, bounded manager, fingerprint equivalence/history, reserve-on-admission, two no-progress cycles, transient-continuation bound, focused regression and verified Resume versus Fresh.
- `references/work-packages.md`, `worktree-ownership.md`: sequential monitored Waves, actual integrated base/current delta readiness, actual file-tool target and cooperating ownership; no native cross-client isolation/lease promise.
- `references/board-workflow.md`, `task-compact-context.md`, `task-concept-plan.md`, `initialization-follow-through.md`: Board/C/P/evidence roles, identity/size rules, `CONCEPT_READY` → binding/available readback → `REGISTERED` → separate Board move/readback → `BOARD_MOVED`, note authorization and uncertainty.
- `references/content-protocol.md`, `approval-flow.md`, `progress-activity.md`: complete stable visible originals, omissions/coverage, exact uncertain delivery, current interactive authority versus actual host/backend security input.
- `references/regression-scenarios.md`, `tests/chatgpt_skill_test.py`, bundle/changelog/latest and `docs/CHATGPT.md`: shipped text/scenario contracts, synthetic behavior and packaging/hosted boundary.
- Integrated A sources `adapters/mcp/src/management-journal.ts`, `taskboard.ts`, `tools.ts`, `diagnostics.ts`; tests `taskboard.test.ts`, `http.test.ts`, and `tests/taskboard-integration.mjs`; and `docs/MCP-INTERFACE.md`: strict append receipt/history modes, lazy per-task JSONL/head, bounded recent/cursor/checkpoint/legacy reads, metadata-only diagnostics and non-idempotent append. The live Taskboard/OpenCode harness was not run because `OCVM_TASKBOARD_BIN` is unavailable; do not infer active external connector capability from source pins.

Predecessor task plans/C were read for conceptual context, without duplicating their histories:

- `planning/task-concepts/task_9dc6e797-b884-589a-99d7-fd3ceceb5414-concept-plan.md` (Work Package/ownership).
- `planning/task-concepts/task_80f79e83-7493-5fb4-8131-3ddb072a2071-concept-plan.md` (Monitor r27). Its effective operator addendum explicitly deferred scheduled-resume provenance to existing downstream QC and preserved fail-closed unauthenticated-note behavior.

The integrated r28 skill is locally package-checked (24 skill tests PASS in Task A's evidence). In the current `tests/chatgpt_skill_test.py`, `test_monitor_reference_and_lean_contract` checks r28 source/scenario strings, including journal modes/legacy and fail-closed monitor terms. `test_monitor_scripted_action_traces_and_fail_closed_boundaries` uses an in-memory `Evidence` fake: integer repair counter and boolean `interactive` flag; it does not persist history, authenticate stored decisions or exercise a hosted scheduler. It proves only its synthetic trace contract. Task A's source/process tests provide separate local persistence evidence, not QC-1/2/5 acceptance or an authenticated scheduled-resume authority.

## 4. Requirements and initial QC register

| Point | Initial state | Requirement / pass gate |
|---|---|---|
| QC-1 | PENDING — review not executed | Each wake reads canonical order and relevant persistent history/checkpoint/decision, honors newer effective operator decision over stale management intent, revalidates live evidence, and persists one compact checkpoint after a permitted action. |
| QC-2 | PENDING — review not executed | Evaluate history across runs/restarts; recognize same/practically-equivalent failure path; at most two autonomous no-progress repair cycles, then controlled park/operator report and no repeated autonomous repair without new authorized decision. |
| QC-3 | **PENDING — prerequisite delivered; review not executed** | Review integrated journal for new Description/output growth, bounded long-history operations and fail-safe I/O/size/parse/coverage errors. Task A's local tests/evidence are available in §3 and its P §10; this row has no verdict yet. |
| QC-4 | PENDING — integrated alignment review not executed | Board, canonical P, terse C, actual shipped skill/connector paths and meaningful tests agree; contradictions are named findings, not silently reconciled by claims. |
| QC-5 | PENDING — review/provenance acceptance missing | Interactive unpark decision/fix is durably bound to the correct master and superseded park within existing scope; worker continues without duplicate send; next wake respects the effective newer decision. Unclear master/authority is a fail-closed management gap. |

The later report may divide a point into subchecks to show local versus hosted evidence, but must retain one honest overall PASS/FAIL/PENDING per named Board point. A missing required positive case cannot be hidden behind passed negative/source tests. No verdict is granted by this initialization.

## 5. QC-1 — persistent memory and correct resumption

### Required behavior

Read the exact master/task order every run; recover latest relevant checkpoint, applied decision reference and any newer entries. Task A's latest-checkpoint shortcut cannot hide a newer operator-related note, and a tail cannot prove older state absent. Obtain older history when the pending action/fingerprint/precedence depends on it. Preserve legacy notes as an explicit source rather than treating absent journal as absent memory.

Separate management intent from observed truth: Board status, monitor lifecycle, current session busy/idle, pending permissions/questions, exact user-message receipt, original terminal result/coverage, Git/owner/base, integration and external acceptance. The next action is derived from current evidence within original scope, not a copied historic next-step field.

After one permitted substantive management action, persist a compact checkpoint containing decision/action, exact delivery/result references, remaining next action and park/escalation reason as applicable. Cheap parked/terminal no-op and repeated unchanged running observations must not produce unnecessary notes or dispatch. A storage failure cannot claim a durable checkpoint or park was saved.

### Later acceptance scenarios

1. Fresh manager with no conversational history recovers exact order, task/session/message/result IDs and next permitted step from Board+C/P+journal/legacy+live evidence.
2. A newer effective authorized decision supersedes an older park/checkpoint; another routine checkpoint cannot silently erase its decision reference.
3. A worker changed state after the last checkpoint: live reads prevent stale dispatch/PASS and retain exact pending invocation.
4. Required note/source coverage is partial/corrupt/changed: stop dependent action, disclose gap, no inference of absent decision.
5. Action admitted but checkpoint response lost: reconcile exact action key/user-message/result and journal entry; no resend or repeated append.
6. Lifecycle `PARKED_INPUT_REQUIRED`, `COMPLETE_PASS` or `STOPPED` without trusted new authority: master/relevant checkpoint read then cheap no-op before deep worker scans; no write.

Evidence: exact input identity/base, history source/range/head/coverage, observed live state, ordered action trace, append/readback receipt and complete original terminal report references. Stored free-form text is not proof the operator authorized it.

## 6. QC-2 — history-based loop guard

Use the existing r27 policy, without raising limits or changing acceptance semantics: default at most **two autonomous repair cycles for the same/practically-equivalent failure fingerprint without material progress**. Diagnosis alone is not a cycle. Reserve a cycle when repair is admitted; uncertain admission reserves until reconciled, release only on proven non-admission. Attempted fixes cannot disappear because regression, checkpoint or supervisor process failed.

Fingerprint uses stable test/harness/assertion/error/config/environment components; superficial wording, timestamp, model change or a repair's own harness revision cannot reset the original episode. Retain historical A→B→A counts. Material progress requires attributable evidence resolving/narrowing the original failure under unchanged criteria, not an unrelated PASS or weakened assertion. Focused PASS permits continuation but does not erase history if the full run reproduces the original failure.

Later cases:

- First repair + focused failure → supervisor restart/fresh context → second equivalent repair + failure → controlled park; no third repair.
- Old fingerprint records outside the latest-N tail: retrieve required older coverage; missing coverage cannot reset to zero.
- A→B→A and practically-equivalent signature under new wording/revision: A's history remains counted.
- Admitted/uncertain repair interrupted before regression/checkpoint: reserve survives reconstruction; only exact non-admission evidence releases it.
- At the cap, repeated scheduled wakeups are no-op; report clear `INPUT_REQUIRED`, completed/paused work and safe next decision.
- New current authorized operator decision can permit a bounded continuation in existing scope only after live revalidation and durable correct-master recording; no invented reset policy. If reset/authorization meaning is genuinely unsettled, return `INPUT_REQUIRED`.
- Existing one-transient-continuation bound is not a repair-cap loophole. Uncertain receipt/storage never becomes retry permission.

Evidence must demonstrate durable restart reconstruction and absence of the prohibited third action. An in-memory fake with two increments is useful synthetic coverage but insufficient by itself for persistent restart acceptance.

## 7. QC-3 — capacity, long history and fail-safe errors

### Dependency and verdict boundary

The prerequisite is now met for a later authorized review: integrated source at `62869f68fc2ccbea302d34c2bd39900dbc813090`, actual append/history schemas, bounded/lazy storage, legacy Description behavior, measured 64-cycle/read-work fixtures, multi-process concurrency and failure tests were inspected in Task A C/P and the local tree. Those records let the reviewer begin QC-3; they do **not** themselves set its verdict. QC-3 stays PENDING until Task B performs the explicit matrix/acceptance review and records any gaps. Two optional pinned-upstream adapter tests were skipped, and the actual disposable Board/OpenCode harness was not run because `OCVM_TASKBOARD_BIN` is unavailable.

### Later acceptance scenarios

1. 48+ logical hourly management cycles over two days append/read/recover without native Description growth; extended-history fixture exercises bounded reads. Distinguish deterministic simulation from real elapsed-time scheduling.
2. Ordinary exact/list task reads do not embed complete journal contents; demonstrate stable normal-task serialized size attributable to note growth. Existing native Description/comments/links and unpaginated scan limits still exist; do not claim unrelated unlimited task/search capacity.
3. Full small history, tail/continuation, efficient latest checkpoint and notes newer than it are retrievable with honest coverage; older fingerprint history remains accessible when required.
4. Unicode, JSON escaping, long individual note and response-budget boundaries do not silently truncate/drop records or create unreadable successful writes.
5. Legacy-only/mixed history is preserved and recoverable, including existing Description addenda; a journal absence is not history absence.
6. Multiple cooperating append processes, restart and read-during-append retain exact task/order boundaries; transfer/reclassification preserves stable task history identity.
7. I/O/permission/disk/partial write/flush/head-publication faults, malformed JSON/UTF-8/schema, inconsistent boundary, replacement/truncation and expired/wrong read context fail safe. Reconcile an uncertain record, never blindly append again or fall back to Description.
8. Post-worker-action checkpoint failure stops further dependent action while retaining/recovering the exact worker receipt; do not claim durable park if its persistence failed.

Measure actual bytes/read work and actual serialized responses; counting prose or passing a fake append loop cannot prove read efficiency. Source/package tests cannot establish mount persistence, hosted scheduled access or two days of external operation.

## 8. QC-4 — concept ↔ skill ↔ tests alignment

Create a bounded traceability matrix in the authorized later QC result: `QC requirement → authoritative Board/P clause → actual skill/connector path → concrete test/trace → observed result/coverage → verdict/finding`. Read C for current state and relevant canonical P sections; do not duplicate entire histories.

Check especially:

- A's actual journal/readback contract versus old r27 `get_project_task.description` checkpoint recovery, finite Description-budget wording and management-note source tests. Necessary foundation integration must update those paths consistently; stale old assumptions are findings.
- Board/C/P identity, current dependency state, source/bundle markers and generated inventory/artifacts. Registered C/P remain regular canonical files at exact paths; a private worktree copy is not independently readable evidence.
- New append/history/checkpoint tools are actually registered/dispatched with strict schema, correct metadata-only diagnostics and response budgets; no capabilities invented by skill text or manufactured through a connector restart.
- r27 lifecycle, cheap no-op, one bounded action, exact original/result coverage, no blind retry, loop reservations, focused regression, sequential monitored Waves and actual base/delta readiness are unchanged by storage integration.
- Tests assert ordered decisions and forbidden side effects, not just keywords. Existing source/scenario and fake tests are explicitly distinguished from real disk/process/MCP transport and hosted model behavior.
- `CONCEPT_READY`, `REGISTERED`, `BOARD_MOVED`, `WORK_PACKAGE_READY`, local implementation/commit/integration and external acceptance remain separate. Review findings do not automatically authorize implementation or Board Done.

Contradictions are recorded with subject revision, exact file/section/test, severity/uncertainty and smallest correction. Updating a plan to say a test passed is not a correction to behavior. A scope/architecture/security choice is returned to the orchestrator as `INPUT_REQUIRED`.

## 9. QC-5 — Operator Override/Resume after interactive unpark

### Existing outcome and reported reproduction

The Board requires the Orchestrator, after an interactive operator fix/decision/blocker resolution or explicit continuation approval, to persist a durable Resume/Override signal on the **correct master**, in addition to the worker follow-up. Record what changed, the older park/`INPUT_REQUIRED` superseded and the already existing scope released. The next scheduled wake must not blindly repeat that old park/action, and the worker follow-up must not be double-dispatched.

The Board reports a 2026-10-01 Work Package example where interactive continuation alone did not make the new decision durably reconstructible; the additional package-master management record did. This is an acceptance input reported by the Board, not a repro executed here or evidence of authenticated scheduler behavior.

### Required checks, without inventing trust architecture

1. Determine exact master from established task/package/monitor bindings and original decision/worker context. A worker/member task is not automatically the master. Ambiguous/missing/conflicting master means fail-closed management gap, not annotating the most plausible card.
2. Capture the actual current interactive operator instruction/fix evidence and exact park/checkpoint it resolves. Identify what is permitted/forbidden; do not turn an implementation fix or an arbitrary note into permission for wider product, deployment, remote, schema or security changes.
3. Persist the authorized Resume/Override once on that master through A's actual append/readback contract, with exact decision/source/park references. Unknown write outcome is reconciled, not repeated. Preserve the signal through later checkpoints/restarts.
4. Reconcile worker delivery and actual busy/pending-input/result/process/owner/base/connection/single-flight state before one permitted continuation. If the interactive follow-up already admitted the work, the next wake observes it; it does not submit it again.
5. Next fresh wake reads the canonical order and effective newer decision, verifies the authority available through the real supported contract, then applies live revalidation/one-action policy. Old park text alone must not recreate the identical resolved business question. A new authority/coverage gap remains a separately named gap, not a claim the old fix never happened.
6. Negative cases: another master's signal, a stale/mismatched superseded checkpoint, conflicting/new stop decision, ambiguous decision source, unauthenticated worker/free-form note, pending security input and uncertain worker/journal state all block dependent mutation.

### r27 provenance boundary and pending positive case

Current r27 intentionally does **not** authenticate stored operator directives. Its ordinary notes expose no human author provenance. `OPERATOR-DIRECTIVE`, newest timestamp/sequence, persisted journal bytes, a worker report and `operator_authorized:true` in the separate unresolved-submission override are not proof of human identity or a trusted scheduled-resume grant. Task A supplies durable storage/read access only; it cannot convert any of these into authority.

Current interactive authorization can follow the existing approval/same-session/live-revalidation flow. The subsequent positive **scheduled** trusted-resume case requires an effective, supported and verified authority/provenance contract. This plan does not choose one, add authentication, introduce a token/role/approval ledger, or weaken fail-closed behavior. If the later authorized QC finds no such contract, report QC-5's positive scheduled case PENDING (or a precise FAIL for a demonstrated contrary behavior) and return terminal `INPUT_REQUIRED` for the real missing decision. Passing free-form-note no-op tests cannot count as passing the positive resume case.

The later regression is exactly `Park → current interactive operator fix/decision → correct-master durable Resume/Override + exact worker follow-up reconciliation → fresh next Wakeup`. Separate verified interactive persistence/no-double-send, negative untrusted wakeup and positive trusted scheduled authority evidence. A synthetic `trusted=True`/`interactive=True` fixture must be labeled simulated; it does not authenticate a real stored note or discharge hosted acceptance.

## 10. Review execution concept, ownership and evidence

No new orchestration engine or QC runtime API is required. Review uses current Board/task-document/history/session/result reads, actual integrated source and bounded test artifacts. Pure stored-result reads require no new worker. A later test/investigation is a separately authorized work instruction and retains actual scope. Runtime selection follows current project capabilities/user choice; do not hard-code provider/model IDs or alter the current runtime merely to read evidence.

Later sequential QC review steps (not part of this document handoff):

1. Reread this task's exact C/P and full current Board, including QC-5; verify identity/revisions and actual A completion/integrated base. Record missing source/result/schema/evidence explicitly.
2. Freeze the actual subject revision(s), Task A handoff and current companion revision. Revalidate affected tool targets/ownership for any permitted test/document writes. Read-only review does not require an isolated code worktree; correcting code would require explicit authorization and current writer ownership.
3. Recover full relevant original results and stable content coverage. Distinguish predecessor-reported PASS from directly verified test outcomes and installed/discovered capabilities.
4. Execute the existing QC points using the above cases and A's meaningful storage/transport tests. Separate source, synthetic, local persistent/process/wire, and hosted evidence. Do not run a live external scheduler/host pilot without its separately authorized configured target and capabilities.
5. Record PASS/FAIL/PENDING per point with concrete evidence; collect precise contradictions/minimal proposals. New relevant QC findings belong in this canonical review/result and, if separately authorized, the existing Board collection task; no automatic duplicate ticket or Board append during a read.
6. Apply small in-scope quality corrections only when the later review assignment explicitly authorizes them; then rerun the affected checks, renew subject/evidence and record residual gaps. No new product/architecture/data-schema/security decision is implemented under a QC label.
7. Update C with actual verdicts/base/result pointers and next action; update P only for genuine conceptual findings. Return acceptance evidence to the orchestrator; Board status change is separate.

## 11. Validation and acceptance levels

Task A's scoped checks have already been run on integrated `main`; Task B has **not** performed QC or rerun tests in this concept-preparation step. The following Task A evidence is available for later criterion-by-criterion review:

- In `adapters/mcp`: `npm run check` PASS; `npm test` 106 PASS / 0 FAIL / 2 opt-in pinned-upstream skips. The live `npm run test:taskboard` harness was not run: `OCVM_TASKBOARD_BIN` and the pinned binary are absent. The harness was syntax-checked only.
- Journal tests included 64 ~16-KiB checkpoint entries, <64-KiB latest read work, ≤1.1-MiB recent scan, full 64-entry cursor traversal to a captured head, unchanged ordinary task JSON, readable legacy Description ranges, and four child processes × eight unique contiguous appends. Fault fixtures covered uncertain post-log/pre-head reconciliation, corrupt head, partial suffix and unsafe journal/lock symlinks.
- `bash tests/mcp_adapter_test.sh` PASS (production-only archive/pin/cache checks); `python3 -B tests/release_metadata_test.py` 5 PASS; `bash tests/vm_config_test.sh` PASS. Companion `python3 scripts/build-chatgpt-skill.py --check` PASS and `python3 -B tests/chatgpt_skill_test.py` 24 PASS. These include source/scenario assertions and a synthetic in-memory monitor trace, not real scheduled resumes.
- No live connector restart/discovery, hosted Work/scheduler, real two-day wait, runtime mount-persistence test, operator identity proof, deployment or external acceptance is claimed. No Task B tests are run in this turn.
- `git diff --check`, `bash -n`, ShellCheck and integration-harness `node --check` passed in the Task A integration check; Task B's final C/P-only diff must be checked separately. If a later authorized corrective assignment changes sources, rerun only relevant required checks plus applicable companion consistency checks.

Evidence levels must remain distinct:

| Level | What it proves / cannot prove |
|---|---|
| Read source/concept matrix | Requirements and actual paths/wording; no execution or real model compliance. |
| Deterministic synthetic traces | Ordered expected decisions and forbidden sends/appends in the fixture; no persistent storage, external scheduler or real actor provenance unless actually tested at that level. |
| Real local journal/process/MCP tests | Durable records/restart/concurrency/limits/transport in tested environment; no hosted Work/Scheduler availability or operator identity guarantee. |
| Reproducible skill package checks | Inventory/markers/artifacts consistency; no installed skill invocation or hosted behavior. |
| Authorized hosted/host/operator acceptance | Actual configured target, scheduled connection/model/single-flight/readback, fresh-context resume and observed operator flow; only the specifically evidenced scenario. |

For any required missing level, retain PENDING and name the exact target/capability/evidence needed. Full business acceptance requires all required QC outcomes evidenced; no blanket PASS from A's local completion or a green package suite. External pilot setup, infrastructure, push/publish/deploy and Board Done are not authorized by this document preparation or by an ordinary review.

### Later report shape

For each QC point return: verdict; subject HEAD/revision; exact evidence source (file/section, command/result, task/session/message IDs when actually known, history generation/ranges/coverage); observed result; gaps/uncertainty. For FAIL add affected rule/test and minimal corrective proposal. For PENDING add prerequisite and one next bounded evidence step. For `INPUT_REQUIRED` state the concrete missing decision/context/safe options plus completed and paused work. Keep full reports in original session evidence; cite them from C/P rather than copying.

## 12. Decisions, open acceptance questions and maintenance

Settled from the current Board/user instruction: QC covers exactly the existing QC-1–QC-5; fixed A→B order; Task A's implementation/evidence prerequisite is now delivered, while QC-3 remains PENDING until reviewed; review does not grant feature/security scope; later small corrections need explicit authorization; normal terminal `INPUT_REQUIRED` handles real missing decisions. No new product, architecture or security decision is made by this plan.

Open acceptance prerequisite: the actual supported provenance/authority for persisted scheduled Operator Override/Resume is not supplied by r27, r28 or A's journal. Preserve the fail-closed boundary and investigate/report it during authorized QC; do not invent a solution now. This does not block C/P preparation. A's integrated local result is present; hosted/runtime evidence remains absent and separate from local source/test evidence.

## 13. Current release blockers and adjacent follow-ups

The complete current Board descriptions for these two user-designated tasks were read. They are separate release blockers/follow-ups, not implementation scope silently absorbed into QC:

- `task_ce242aa5-b674-5c39-b722-aa69228d3b06` — **Scheduled Tasks – Host-/Security-Blockings vor Connector untersuchen**, Inbox/INBOX ticket 5, `todo`/high. Its current scope is to reproduce/classify the pre-dispatch host/safety block and distinguish host-not-delivered, connector rejection and backend failure without bypassing policy. Its latest Board note expressly keeps the Work/Worker implementation separate.
- `task_1bb4d21a-364c-5b28-88e5-4f503071e387` — **Orchestrator – Scheduled-Monitor nur via Work/Worker starten und Operator-Eskalationen verständlich berichten**, MCP ticket 19, `todo`/high. Its current Board description requires a distinct concept round before it may be moved to `in_progress` or implemented. It covers normal-chat-to-Work/Worker bootstrap routing and clear operator escalation summaries (including persistent correct-master checkpoint mapping).

No release/tag/publish/deploy is authorized. Task B's document readiness does not resolve either blocker, pass QC-5, start the `task_1bb4...` concept, change either Board task or authorize release. The next step is orchestrator document registration/readback; a separate Board transition remains explicitly open, and QC review starts only under its own authorized assignment.

Maintenance: C one file, ~5k target/~7.5k warn/condense before ~10k; never split. Main P ~20k target/~30k warn/split by ~40k into task-ID-named details while keeping the main canonical outcome/decisions/current review-test plan/index. Budgets are not minimum lengths. Read files before substantive work, keep C current after substantial iterations and update P/`Last-concept-update` for substantive concept shifts. Avoid full-history duplication and never overwrite a foreign Task-ID or silently retarget bindings.
