# Changelog

## 2026-10-09-r47

- Link the [monitor-manager worker rules](references/monitor-manager-rules.md) to the supported locked worker tools: `create_monitor_worker` (reserve-before-create + confirm against the observed response), `list_monitor_workers` (bounded index read) and `update_monitor_worker` (reconcile/reuse/rebind/idle/archive/synthesis). Worker registry metadata is changed only through these tools — never by editing the registry JSON directly and never via a second unlocked store; an uncertain create stays `reserved` and is reconciled through the tool, never by a second create.
- Note that the engine observes a finished dispatched own worker and marks it `idle` with a fresh `result_receipt`, which is a wake signal to synthesize the result original; the receipt is not itself an acceptance.

## 2026-10-09-r46

- Add [Monitor-manager rules](references/monitor-manager-rules.md): the operator-set mission (actively drive the commissioned development to the agreed result within the configured autonomy profile; pure status observation is not delivery), the two audiences (external commissioned orchestration within real auth/scope; explicitly established internal OpenCode monitor/manager sessions), and the rule that ordinary implementation sessions and their subtasks gain no management authority from tool or skill visibility.
- Codify serial root-only management delegation: the manager never uses native subtasks (including read-only research), delegates only to own root worker sessions (creation receipt/registry identity — never the session title), never takes over or relabels foreign sessions, and runs no parallel sub-managers; workers keep deciding their own subtask use inside existing scope and permissions without any new enablement ceremony or micromanagement.
- Make the action matrix cooperative and honest: rules bind, but no `BLOCKED` event, caller-identity proof or attack-detection guarantee is claimed; the manager never changes its own monitor/autonomy/runtime/expiry/scheduler/approval or management-tool settings (recommendation path only), never creates or reprioritizes board tasks, never self-authorizes; permitted lanes (reads, journal/compact-context upkeep, additive non-authorizing notes, own worker control and configured fallback/compaction, legitimate `INPUT_REQUIRED` parking) stay explicitly open, and external authentication stays unchanged.
- Add the eight-step wake duty loop (context/worker index → receipt/state reconciliation without duplicates → full original reading plus continuous key-finding synthesis → error/fallback/blocker handling → serial next-step dispatch → genuine operator-decision escalation → secured-handover archive/context cleanup → journal/index resume update) and the G3 rule: a worker business `input_required` is resolved by a normal same-session follow-up once the actual decision exists in profile/scope; a real missing decision escalates `INPUT_REQUIRED`; a pending security permission is never answered or bypassed.
- Document persistent worker context and lifecycle (own project-state context file per worker, no board ticket, no git tracking, maintained after each step; reversible archive then exact own context cleanup only after secured handover; session IDs are runtime references, reset resume verifies effects/receipts and never blind-replays). Future capabilities (server-side roles, technical guards) stay deferred, not assumed. SKILL.md gains the lightweight pointer; existing [Monitor tasks](references/monitor-tasks.md) keeps the external scheduler bootstrap unchanged.

## 2026-10-08-r45

- Add the additive per-profile fallback mode (policy schema 4) to error-fallback routing: each profile card may carry its own optional fallback runtime, and two independent switches (Degrading, Provider-Skip) govern the chain. `routing.regime` distinguishes `per_profile` from the unchanged `legacy_final_fallback`; the legacy global final stage stays stored and readable but is not part of the per-profile chain and is never silently appended. Unset switches mean "not activated" (published as `routing.strategies_effective`), never a hidden default.
- Keep the routing evidence-bound and finite: the failed identical runtime is never retried, provider skip applies to profile fallbacks too, unconfigured candidates are skipped, unavailable candidates are reported with their reason, and an exhausted chain ends in a controlled readable `INPUT_REQUIRED` (terminal end of the processing run, not a process crash, no double admission, no repeated uncertain side effects). Context/input-length errors stay on their separate compaction path.
- Document the two discovered write tools (`set_project_model_policy_profile_fallback`, `set_project_model_policy_strategies`) with revision CAS, exact catalog-validated selections, explicit both-switch writes and committed readback; no invented provider/model, no silent configuration.
- Hub model pickers now list models alphabetically by displayed name (locale-aware, case-insensitive, deterministic tie-breaker) across main mappings, own fallbacks and the final fallback, with provider separation, IDs, variants, availability and routing unchanged.

## 2026-10-08-r44

- Document operator-directed configuration of the final error-fallback slot through the discovered write capability (adapter 0.1.31 adds `set_project_model_policy_fallback`): read the current revision, use an exact catalog-validated selection and mode decided by the operator, write with revision CAS, and confirm the committed readback. No invented provider/model, no silent auto-configuration; an unconfigured slot still yields a precise `INPUT_REQUIRED`.

## 2026-10-07-r43

- Scope the repair-loop budget to production code (Production-Code-Only override): at most two same-fingerprint production-code repairs without evidenced progress, then park; management, reads/result fetch, receipt reconciliation, planning/documentation, tests/fixtures/harness/test environments and infrastructure fixes are excluded and never count. Evidenced material progress ends the no-progress series and is not a no-progress failure; history survives sessions/models/pauses and is never reset.
- Separate finite read episodes from the repair counter: bounded causal backoff, success ends the episode, only persistently current unavailability holds dependent steps back, historical read errors never park a later healthy Go/wakeup, and worker status is never fabricated FAIL/PASS from a read gap.
- Keep uncertain non-idempotent writes/sends receipt-reconciled without blind retry or duplicates (distinct from read backoff), and keep the scheduler clock independent of ACTIVE/PARKED_INPUT_REQUIRED/COMPLETE_PASS/STOPPED work state with no automatic Work-Scheduler enrollment.
- Unify the override wording across SKILL.md, regression scenarios, events/attention, optimistic MVP, monitor tasks, integration-test monitor and work packages; add the six mandatory W2 regression cases as source traces plus fake-connector/mutation-control tests; preserve r39–r42 coverage. Hosted behavior and the production engine (W3) remain separate acceptance.

## 2026-10-07-r42

- Add cooperative Pause/Weiter-Go: a bare contextual Pause releases only the current chat/management/poll turn at the next safe Tool/Receipt return, preserving contracts, receipts and accepted workers (no abort/stop/archive, no scheduler or subscription change, no `USER_PAUSED`/`PARKED_INPUT_REQUIRED`); Go resumes the exact contract with remaining budgets and no replay or permission expansion.
- Make recoverable transient read retries silent and finite inside the existing episode budgets (events-attention default: two recoverable read errors), with exactly one concise persistent-impact alert per exhausted episode; Pause prevents the next round at the safe boundary and resume never replenishes spent budget.
- Add evidence-bound error-fallback routing on the project policy's additive final-fallback slot: Total (default, direct) and Degrading chains with role entry points, provider/quota-identity skip, finite sequences, role truth, per-step return to a freshly resolved regular profile, and precise `INPUT_REQUIRED` when unconfigured — classification only from exposed safe error detail (rate limit ≠ proven quota), no daemon/platform/provider prerequisite.
- Add separate context-length recovery: no resubmission of the rejected request, native version-verified compaction relied upon, exactly one aligned continuation in the previous regular profile/thinking stage, and a mandatory alignment/recovery prompt (task ID, canonical C/P, limits, receipts, secured state) after any automatic resumption.
- Add source-bound fake-connector traces and mutation controls for pause/go boundaries, silent-retry budgets and fallback chains; r40 Build-preparation, r41 Done/archive and r39 contextual-reporting coverage preserved. Hosted Voice/UI behavior remains separate UNVERIFIED acceptance.

## 2026-10-04-r41

- Add narrow task-Done archive follow-through after secured result/handback and independently verified authorized Done: exact linked sessions, complete all-workstream/all-status reverse coverage, current eligibility and fresh recheck before archive once/readback.
- Keep unknown coverage, busy/input/guard/unresolved evidence and uncertain replies conservative per session; no force, blind retry, Done rollback, watcher or backend transaction. Standalone explicit manual archive and r40 Build preparation remain unchanged.
- Add source-bound fake-connector traces and mutation controls for last/open task references, cross-workstream blockers, dedup, handback, eligibility, races and uncertain/already archived state. No live session archives or hosted behavior acceptance from packaging.

## 2026-10-04-r40

- Unreleased-candidate F1 correction: check clarification scope/explicit Plan-persistence conflict before any session creation, then prepare/read back runtime and send once. Add a source-bound cross-reference ordering regression with a create-before-scope mutation control.
- Prepare the available primary Build agent before authorized new/prepared work that can persist files, including concept/context/plan work and checks. Keep deliberate small strictly read-only Plan exceptions and explicit user-agent conflicts visible before writing.
- Reuse suitable sessions; discover creation/catalog/idle/update/readback capabilities, preserve the full provider/model/variant tuple and separate five-role profile resolution. No global agent/permission/model-policy change or invented creation arguments.
- Link the same preparation through clarification, initialization, Board/package handoffs and project setup notes. Add source-bound scripted tool-call traces for Build selection, no-switch reads, override conflicts, unavailable tools, busy/input and uncertain/partial updates; hosted behavior remains separate acceptance.

## 2026-10-04-r39

- Require concise completion/decision/escalation notices to name the MCP project, verified workstream when present, and descriptive task title; short keys supplement titles and unknown hierarchy remains explicit.
- Add a brief user-facing MVP completion notice separating newly implemented decisions from inherited and pending ones, with actual product/schema/architecture effects, added complexity and a pointer to practical correction options. Incomplete coverage never becomes a zero count.
- Clarify useful progress updates during active unfinished work, without repetitive polling speech or a post-turn timer claim.

## 2026-10-04-r38

- Describe one fair active management cycle for operator-selected distinct VM/project channels, with isolated identity/cursors/receipts/budgets and bounded reentry recovery. One strand per VM normally; separate authorized VM workers may run concurrently, controller admissions remain serial.
- Explain genuine optimistic domain choices before dispatch, with natural Voice/Text alternatives/rationale/next-action notice and observed-objection handling. Silence grants no authority; text length or backend walltime proves no spoken window, interruption or un-send.
- Add multi-channel and pre-dispatch forward/negative instruction cases while preserving r37 scope/default overrides, receipt dedup/recovery and no post-turn timer. Hosted multi-VM and Voice acceptance remain separate.

## 2026-10-04-r37

- Resolve clear authorized substantive implementation/completion intent semantically to active queue polling and bounded Optimistic MVP defaults; explain once and persist the effective scoped contract, no strategy/cadence keywords required.
- Give start-only, reads/planning/preparation/Go-pending and explicit or canonical stricter overrides precedence; never widen a live scheduler or infer integration/release authority from defaults.
- Use the active completion protocol on supported Text/Voice without a blanket three-minute cutoff, keeping finite standalone WAIT-only behavior, best-effort cadence, real host limits, receipt recovery and hard decision gates. Add positive/negative default-resolution regressions; no installed or hosted behavior claim.

## 2026-10-04-r36

- Preserve finite Voice/default waits; add explicitly longer active TEXT queue reconciliation and serial contract follow-through, ending at completion/cancel/gate/error budget/real host limit rather than a blanket three-minute cutoff.
- Separate active-turn observation, independently verified recovery and on-demand communication; subscription is a supplementary accelerator, not proof of reliable long-run management continuation.
- Add explicitly selected Optimistic MVP policy with durable decision/Git evidence and cumulative-drift/hard-stop checks. Extend receipt recovery, presentation/dispatch dedup and non-resetting repair budgets with positive/negative instruction regressions; hosted timing, recovery and actual OID cases remain external acceptance.

## 2026-10-04-r35

- Add explicitly authorized, bounded active Voice waiting on the prefetched MCP attention queue: three minutes by default, approximate 30-second silent reads, exact receipt/revision correlation and finite page/error budgets. No independent timer after turn completion or idle Voice wakeup claim.
- Prefer/reuse one appropriately scoped authorized subscription on supported surfaces; deduplicate event and polling presentation, preserve safe topic boundaries and separate personal push preferences.
- Add instruction-contract regressions and manual acceptance cases for limits/pagination, missing Chat tools, cancellation, interruption, timeout and delivery dedup. Active Voice retrieval has operator evidence; precise cadence, normal Chat, long runs and idle Voice remain separate external gates.

## 2026-10-04-r34

- Prefer the persistent prepared attention view for cross-session status questions and natural handoffs; acknowledge presentation/discussion only against the exact source revision.
- Define honest event-delivery promises: automatic notice requires confirmed host monitoring/wakeup, safe-boundary deferral requires host confirmation, and otherwise use on-demand fallback. Keep event receipt, same-context continuation and audible Voice evidence separate.
- Add source-contract coverage for queue-first behavior, lifecycle receipts and no follow-up authorization. Hosted Work/Voice behavior remains external acceptance.

## 2026-10-03-r33

- Synthesize autonomous Work Packages into one revisioned canonical package-P execution contract with source/completed-evidence pins, sole package dispatch ownership and member C/P markers; retain stable tasks and separate acceptance, no new backend schema or Board status.
- Import completed work without redispatch; require explicit new revisions for new members, preserve receipt/repair history, and define internal technical transitions plus bounded separate-worker correction/renewed independent QC through final local-preparation readiness and operator handoff.
- Add source-bound dispatch/phase trace regressions and negative controls for the ten synthesis acceptance cases, revision/partial-publication integrity and repair/QC independence. Hosted import/model/scheduler acceptance remains separate; no pilot revision is activated by packaging.

## 2026-10-03-r32

- Correct the monitor checkpoint `decision_ref` template to retain the current applied canonical decision reference/revision, including persisted cross-chat decisions; use `none` only when no canonical decision applies. Extend the existing Stage-1 source-contract regression for this field. No other workflow or enforcement changes.

## 2026-10-03-r31

- Remove Git-specific managed-policy claims from task submission and worktree guidance; task scope and actual backend controls remain authoritative.

## 2026-10-03-r30

- Route Chat/Voice scheduled-monitor requests through a complete Work/Worker bootstrap, with wrong-surface redirection and no self-create probe.
- Require terminal and correct-master persisted escalation context, two operational examples, then technical evidence/uncertainty/question.
- Keep cadence through work park/PASS/STOPPED until expiry or explicit SCHEDULER stop; recover canonical cross-chat Resume decisions without a separate provenance/register, preserving exact receipts and loop history.
- Add source contracts and synthetic restart/receipt/cadence regressions; hosted model/scheduler acceptance remains separate.

## 2026-10-02-r29

- Add generic release-gate guidance that discovers and follows the target repository's policy, keeps operator-only publication separate from local work, and verifies CI/release evidence against the exact candidate commit.
- Preserve the working runtime while the expected gate is red or unverified; permit interruption only for an explicitly authorized in-scope repair that demonstrably requires it, with reason and recovery state.
- Add release-gate regression scenarios and source-contract checks. No publishing, CI, credential, security-boundary or runtime behavior is changed; hosted skill acceptance remains separate.

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
