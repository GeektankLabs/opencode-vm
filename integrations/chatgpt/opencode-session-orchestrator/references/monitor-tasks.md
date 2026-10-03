# Scheduler-supported Monitor Tasks

Use only for explicit authorized recurring supervision through an **external, currently available scheduler**. This instruction-only skill does not implement a scheduler, polling daemon or notification channel. Stateless reasoning, stateful system: recover from one master task plus live evidence, not chat memory. The same loop supports [sequential Work Packages](work-packages.md#monitored-work-packages-v1) and [long integration/system tests](integration-test-monitor.md).

## Master and Monitorability Gate

Read the exact selected project/connection and Board task using [Board workflow](board-workflow.md). Use the package task as master for a package; a suitable existing single task may be master; the integration-test policy uses a separate monitoring/master task. Propose/create a separate master only within normal authorized Board mutations. No master means not configured. Preserve existing [C/P roles](task-concept-plan.md), bindings and initialization/readback sequence; do not create a card per wakeup/attempt.

Before schedule configuration, establish a fixed primer with these fields (client-side convention, **not new MCP arguments**):

| Primer field | Required content |
|---|---|
| identity | `monitor_schema:v1`, master task ID, pattern, selected project/connection, exact established C/P paths |
| objective | goal, unchanged PASS criteria, stop/escalation boundaries, finite monitoring horizon |
| monitored work | task/member IDs, session ownership or explicit not-yet-assigned, exact recovery rules, wave order/integration target |
| actions | approved diagnosis/repair/test/resume/fresh surfaces; prohibited product/schema/security/acceptance changes, production and remote publishing |
| limits | same-fingerprint repair cap (default two), progress/reset rules, transient retry cap, bounded active-run budget |
| runtime | operator-confirmed Work supervisor model separate from OpenCode worker profile/runtime policy; no silent substitution |
| setup | requested recurrence/time zone/start/end, required apps/MCP connection, single-flight owner, setup receipt reference |
| persistence | note size and remaining description/output budget, checkpoint and operator handoff rules |

Apply the core Lean rule. Ask a targeted Spot-Check only when an unknown resource/writer/role assumption changes the next safe action; do not repeat answered questions. Keep test-environment exclusivity and semantics distinct from worktree isolation. Required product/trust/security choices must be resolved before dependent engineering starts. Missing evidence blocks only the action that needs it.

## Current capability gate and supervisor model

Only in the explicitly established Work/Worker execution context, immediately before final setup, discover actual scheduler/Work create/configure/read tools, recurrence/time-zone/start/end controls, overlap/manual-trigger/queue behavior, model list/pinning and intended project apps/MCP availability in the **scheduled execution context**. Normal Chat preparation may collect known requirements and read project state, but never probes its own scheduler creation capability. Current opencode-vm MCP has no scheduling API. Being in Work or a successful interactive connection does not prove scheduled access; do not invent parameters or pin UI labels/model IDs.

Recommend among actually available Work models: adequate light management for deterministic observations, normal coordination for bounded reconciliation, stronger reasoning for difficult integration diagnosis. Operator confirms the choice; exact Work-model configuration must be verified. OpenCode `execution`/`standard`/`deep` are independent worker profiles governed by the [core runtime rules](../SKILL.md#project-runtime-profiles-for-new-authorized-work), not a mapping to Work models. Preserve explicit user choices and stop at configured unavailable/incomplete mappings; no silent substitution.

## One supervisor entry, not a note lock

Require one scheduled owner per master and a verifiable external single-flight facility covering the whole management run, including manual triggers; verify max one in-flight run and skip/coalesce overlapping wakeups rather than duplicate dispatch. Multiple scheduler jobs on the same master do not become safe because each individually has concurrency one. Coordinate interactive management through that same serialized entry or wait for a verified stop/idle handover. Do not dispatch through a second connection/session to bypass busy/input/uncertainty.

MCP per-session admission and cooperating note-write serialization are defenses, not a master-task lock or cross-client CAS. Neither a Board status, marker note, old timestamp nor a prompt establishes exclusivity. If serialization/owner/config cannot be verified, leave autonomous setup inactive; produce a bootstrap or explicit manual one-at-a-time handoff. Do not invent a lease service/registry or weaken the gate. This requirement is driven by concrete duplicate-supervisor risk, not a repository-wide enterprise coordination default.

## Work/Worker handoff, Direct Create and activation receipt

Normal Chat/Voice only prepares scope/readiness and emits the complete copy/paste bootstrap below. Never probe whether that chat can self-create a scheduled monitor, and never create it there even if tools exist. Explicitly tell the operator: start this bootstrap in ChatGPT Work/Worker. Ordinary one-shot delegation is unchanged. Reuse an appropriate Work context; no unnecessary new session.

The marker declares intent, not reliable UI detection. If pasted into normal Chat/Voice, redirect without executing anything. If the surface is unknown, return a targeted INPUT_REQUIRED asking for the execution context; do not assume Work or silently fall back. Only in an explicitly established Work/Worker context discover actual scheduler capabilities. After setup authorization, Direct Create is allowed there only if all material schedule/model/connection/master/single-flight settings can be set **and read back**. Create once; uncertain creation requires reconciliation, never duplicate create. Unsupported settings leave setup inactive with concrete manual steps, not automatic execution.

```text
Scheduled-Monitor-Bootstrap v1 — execute only in ChatGPT Work/Worker context.
Normal Chat/Voice: redirect to Work/Worker without creating or executing this.
Unknown surface: ask for context; this marker does not prove Work capability.
Set up recurring supervision for master <task ID> on <selected project/connection>.
C: <exact registered context path>; P: <exact registered plan path>.
Pattern/objective/PASS: <policy and unchanged criteria>.
Monitored task/session/message bindings and recovery: <exact IDs/rules>.
Schedule: <recurrence, time zone, start/end logic, finite management horizon>.
Work supervisor model confirmed by operator: <actual selectable model>.
OpenCode worker profile policy: <separate current project preferences>.
Required connections/tools in scheduled context: <verified capabilities>.
Single-flight: <one owner/master, verified overlap/manual-trigger behavior>.
Allowed actions/surfaces: <bounded actions>; forbidden decisions: <scope boundaries>.
Repair limit: <default two same-fingerprint no-progress cycles>; transient resume
limit: <default one per unchanged failure episode>; note/run budget: <bounds>.
Read master + latest checkpoint + newer decisions before the no-op gate. Use the
Monitor Tasks and selected policy references; at most one management action,
exact receipt/readback, at most one compact checkpoint after action. Parked or
terminal without a current canonical Resume decision is silent: no deep scans,
sends, repeated messages or notes. The correct canonical master/task content is
the work instruction; use its latest non-superseded bounded decision, including
cross-chat decisions persisted there. No separate provenance/register required.
Bind the decision to the superseded park and reconcile any existing follow-up
receipt/result before one live-revalidated step; unknown delivery is not resend.
Preserve fingerprint history/reserved cycles and all Safety/Scope/Readiness gates.
Work park/escalation/COMPLETE_PASS/work-STOPPED never cancel, disable or delete
the scheduler. Keep configured cadence until expiry or explicit SCHEDULER stop.
On operator escalation begin with system/process/problem/impact, then at least
two concrete operational examples, then evidence/uncertainty/operator question.
Persist the same context and examples, reason and next permissible step on the
uniquely correct master; ambiguous anchor means report a gap, no arbitrary write.
No blind retry, permission bypass or remote publishing.
Do not claim active until final configuration readback and Setup Receipt match.
```

Receipt fields: actual scheduled task identity/name; master ID and C/P identity/revisions; actual schedule/recurrence/time zone/start/end as supported; actual pinned Work model; verified scheduled connection/tools; owner/single-flight setting and verification source; effective objective/actions/limits; activation status; timestamp; every deviation/unverifiable property. Only an exact material match permits `active configured`; a prepared prompt, accepted create, acknowledgment or user model preference alone does not. Timing guarantees are only those actually documented by the external platform, not an invented SLA. Unsupported required end controls leave setup inactive; a master work-horizon/park rule must not masquerade as scheduler expiry.

## Lifecycle and effective authority

| Lifecycle | Wakeup behavior |
|---|---|
| `ACTIVE` | reconstruct current state; live revalidate; at most one bounded action |
| `PARKED_INPUT_REQUIRED` | no dependent work unless a current canonical decision releases it; otherwise silent cheap no-op |
| `COMPLETE_PASS` | goal evidenced; cheap no-op; not automatic Board Done |
| `STOPPED` | explicit operator end; no new work; does not silently abort a running worker |

Under friendly, controlled operation, the canonical current content of the correct master/task anchor is the authoritative work instruction. A Resume decision persisted there, including from another chat, can release work without cryptographic or separate operator provenance or a decision register. Text elsewhere, labels and client flags alone are not that canonical context. Determine the correct master, newest non-superseded decision, exact superseded park/checkpoint and bounded released step. Record source/revision and existing follow-up receipt for consistency/recovery, not identity attestation. A routine checkpoint does not erase a decision; an unresolved newer conflict blocks action. Missing/corrupt/partial context fails closed. Unchanged park remains silent: no deep session analysis, repeated messages, sends, retries or notes.

An explicit **current interactive operator instruction** uses the existing [approval flow](approval-flow.md). Persist its bounded decision on the correct master with the superseded park and existing follow-up receipt, so a fresh wake can recover it. Reconcile serialized owner, setup, exact task/session/receipt/result, permissions/questions, base/worktree and remaining budget before ACTIVE. Already-admitted work is observed, not sent again; unknown admission is reconciled. Preserve historical counters/reservations and A→B→A history; Resume is no repair-budget reset or permission bypass.

Work lifecycle is separate from scheduler lifecycle: park, escalation, COMPLETE_PASS, work-STOPPED and exhausted work/repair/storage budgets never cancel, disable or delete the scheduler. Keep configured cadence until configured expiry or explicit **SCHEDULER stop** targeting that scheduler. Work stop is not scheduler stop. Verify a requested scheduler stop with the actual platform readback; never claim stop on an uncertain response. Expiry does not authorize extending/recreating a schedule. A work horizon/park rule is not a substitute for the configured scheduler expiry.

## Bounded wakeup algorithm

1. Read the exact master/order first. On a connector exposing `get_task_management_history`, read `mode:"latest_checkpoint"`, then page `mode:"after_checkpoint"` to the captured head before deriving state. Compare checkpoint identity/generation between reads; if it moved, recover the intervening coverage with `mode:"after"` or restart, never skip a decision between snapshots. Refresh the head before action; consume newer entries or defer if a stable decision cannot be established. Use `mode:"recent"` for overview and `mode:"after"` for older fingerprint history; a tail never proves older attempts absent. Page relevant `legacy_description` under its revision. Older connectors use only observed complete Description readback and disclose the gap. Missing/truncated/corrupt/conflicting coverage blocks work, not cadence. Only after this cheap decision-aware entry apply silent parked/terminal no-op, before worker scans.
2. For ACTIVE, confirm setup and one serialized owner. Read only the current relevant C/P sections and task/session binding. Check actual `get_session` activity, admission and session-wide pending input; pending permission/question requires operator attention, not autoapproval. A verified running/busy worker means no new dispatch/repair/next wave. Repeated unchanged running observations need no note.
3. Reconcile pending invocation by exact user message ID/status/result. `SUBMISSION_UNCERTAIN` or unknown delivery/result => reads/reconciliation, not a changed prompt or second session. Complete bounded searches where needed; absence from one window never proves non-delivery. Follow [content protocol](content-protocol.md) for full terminal originals, revisions, omissions and read coverage. A completed tool/turn is not business PASS.
4. Apply the selected policy using just-in-time live evidence and [worktree ownership](worktree-ownership.md) for writes. Choose at most one logical management action (diagnosis, repair, regression, resume/fresh, integration, next-wave start, park or completion). Required idle runtime readback is preparation for that action; do not chain diagnosis → fix → full rerun in one wakeup. Dispatch one bounded worker instruction with exact task ID, C/P paths, owner/base/target and the normal staged maintenance reminder. Do not wait indefinitely for its result; capture/check exact admission and defer the next policy step to a later wakeup.
5. Verify actual receipt/state and append at most one checkpoint for the substantive outcome/change. Terminal/result-reading work can itself produce park/completion without a new worker. Re-read master and the current history head before publication so a newly appended decision is not overwritten by stale inference. On journal-capable connectors, reconcile an uncertain append through `get_task_management_history` and its exact entry receipt before any retry; do not expect new text in `get_project_task.description`. On older connectors, use only their observed legacy readback. Missing write capability never permits full-description replacement. If the master connection or journal is unavailable, report the gap in the scheduled run response; do not claim a durable checkpoint/park was saved.

## Checkpoint and correlation contract

### Operator escalation: terminal plus correct-master persistence

For genuine INPUT_REQUIRED/PARKED_INPUT_REQUIRED, out-of-autonomy business/product/architecture/security decisions, evidenced excessive complexity, exhausted loop guards or other defined operator-required endpoints, the worker/monitor itself produces both outputs. Begin the terminal report with affected system/infrastructure, process phase, exact problem point and overall impact. Then give **at least two concrete operational examples**, followed by fingerprint/IDs/evidence/attempted fixes/uncertainty and the concrete operator question. Do not invent observations: label illustrative consequences as examples; unknown cause remains unknown.

Persist the same context and same two examples plus escalation reason and next permissible step in one MONITOR-CHECKPOINT on the uniquely correct master. Technical detail may be shorter but state/cause must agree. Resolve package master versus test-monitor master from established bindings, never title similarity or the current worker task alone. Ambiguous anchor: terminal management-gap report, no arbitrary write. Missing persistence capability/budget or uncertain append: report persistence unverified, retain exact action/entry references for reconciliation; do not claim saved or duplicate the write. The normal 1,200-byte target is guidance, not permission to omit required examples; respect actual hard bounds. Unchanged park never repeats the escalation.

Example shape (illustrative, replace with actual evidence; reuse the first three paragraphs in the checkpoint):

> The test supervisor is at the regression-to-resume step. It cannot establish whether the previous worker follow-up arrived. This blocks a safe continuation of the test package; it does not prove the tested product failed.
>
> Example 1: issuing another full test command could start the same run twice against the retained test environment.
>
> Example 2: starting the next package member now could use results from an unfinished run instead of an accepted integration baseline.
>
> Evidence: exact submission/result references, read coverage and attempted reconciliation. Cause remains unknown. Escalation reason: delivery cannot be established. Next permissible step: reconcile that original receipt; no resend. Operator question: which missing result/connection evidence can be supplied? Scheduler cadence remains configured. Persistence: verified entry receipt or explicitly unverified.

Fixed Description is outcome/primer and retains legacy Management Notes; P is detailed canonical design/policy; C is terse current state maintained by the executing agent at substantive checkpoints; new append-only journal entries are management evidence, not an alternate design or authentication store. Do not start a copying/maintenance worker solely for each wakeup. Use task-file paths/revisions and original evidence pointers; don't duplicate logs in C/P/Board.

```text
MONITOR-CHECKPOINT v1
run=<unique local correlation label>; observed_at=<ISO>; master=<task ID>
lifecycle=<state>; decision_ref=<current interactive source or none>
work=<task/member + session + submitted user message IDs, wave/test run>
evidence=<assistant result IDs/revisions/read coverage, observed state, time>
action=<one actual action>; action_key=<scope/stage/previous receipt/decision>
delivery=<verified admission/uncertain/not sent>; fingerprint=<stable parts/ref>
cycles=<completed/reserved count>; progress=<evidence or none>
base/integration=<actual owner/worktree/HEAD/checks or reference/n/a>
attention=<INPUT_REQUIRED/permission/question/error/none>; stop_reason=<...>
next_allowed_action=<one step or none>; operator_attention=<yes/no>
```

These labels are text, not MCP `request_id` or an idempotency API. Bind every action to connector/project + master/task + session + submitted user message/receipt and returned assistant result IDs. Distinct messages in one session remain distinct; Board links alone do not prove execution. Include the action key in the worker prompt so an interrupted post-send checkpoint can be reconciled from stored user messages. Before another action after interrupted publication, search/reconcile that exact action/receipt and result; incomplete history or missing durable evidence parks rather than repeats. Do not promise universal exactly-once across restarts/clients.

Keep routine entries compact (about 1,200 UTF-8 bytes) and put lengthy facts in originals/documents with exact references. With the current journal adapter, each serialized note is capped at 40 KiB and each task journal at 64 MiB; a normal task response still has its separate 40,000-byte bound, and native Description remains capped at 32,000 UTF-16 codeunits for the fixed order/legacy notes. The journal's latest/tail/history APIs are separately response-bounded; inspect coverage and cursor head. Set a finite monitoring horizon/run budget; stop before the actual journal bound and report any I/O/parse/coverage failure. Do not prune/truncate old notes or silently continue on an error. Older connectors lacking the journal retain their observed Description cap, so do not promise long-run capacity there. No-op wakeups consume no journal entries. Reaching horizon without verified PASS parks for operator attention; STOPPED denotes an explicit operator stop, not a guessed success.

Morning Handoff is an authorized read from master/C/P/live originals and actual Git evidence: report lifecycle, last action/receipt/result coverage, edits/tests/integration vs open acceptance, fingerprint/counters/budget, exact question and safe next step. Scheduler activation does not guarantee notification delivery.

## Pilot acceptance

After source/package checks, perform separately authorized short pilots: sequential package and long test/harness repair. Record actual schedule/single-flight/model/connection receipt and fresh-context reconstruction. Exercise correct-master cross-chat Resume, stale/wrong-anchor/newer-stop negatives, uncertain/already-admitted receipts with no resend, dual escalation persistence and cadence retained across parked/PASS/work-stop ticks. QC checks canonical-state consistency, not separate operator authentication. Synthetic traces do not prove hosted Work/app access, model compliance or scheduler timing.
