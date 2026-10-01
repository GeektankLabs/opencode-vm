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

Immediately before final setup, discover the actual surface's scheduler/Work create/configure/read tools, supported recurrence/time-zone/start/end controls, overlap/manual-trigger/queue behavior, model list and pinning, intended project apps/MCP tools and availability in the **scheduled execution context**. Current opencode-vm MCP has no scheduling API. Being in Work, a documentation/UI example or a successful interactive connection does not prove scheduled access. Do not invent API parameters or pin model IDs/UI labels in the skill.

Recommend among actually available Work models: adequate light management for deterministic observations, normal coordination for bounded reconciliation, stronger reasoning for difficult integration diagnosis. Operator confirms the choice; exact Work-model configuration must be verified. OpenCode `execution`/`standard`/`deep` are independent worker profiles governed by the [core runtime rules](../SKILL.md#project-runtime-profiles-for-new-authorized-work), not a mapping to Work models. Preserve explicit user choices and stop at configured unavailable/incomplete mappings; no silent substitution.

## One supervisor entry, not a note lock

Require one scheduled owner per master and a verifiable external single-flight facility covering the whole management run, including manual triggers; verify max one in-flight run and skip/coalesce overlapping wakeups rather than duplicate dispatch. Multiple scheduler jobs on the same master do not become safe because each individually has concurrency one. Coordinate interactive management through that same serialized entry or wait for a verified stop/idle handover. Do not dispatch through a second connection/session to bypass busy/input/uncertainty.

MCP per-session admission and cooperating note-write serialization are defenses, not a master-task lock or cross-client CAS. Neither a Board status, marker note, old timestamp nor a prompt establishes exclusivity. If serialization/owner/config cannot be verified, leave autonomous setup inactive; produce a bootstrap or explicit manual one-at-a-time handoff. Do not invent a lease service/registry or weaken the gate. This requirement is driven by concrete duplicate-supervisor risk, not a repository-wide enterprise coordination default.

## Direct Create, copy/paste and activation receipt

After explicit setup authorization, Direct Create is allowed only if all requested schedule, exact Work model, connection/context, master binding and single-flight settings can be set **and read back**. Create once; reconcile uncertain creation using supported reads, never duplicate it. Otherwise provide the complete copy/paste bootstrap below plus manual operator steps to select the actual model, connection, recurrence/timezone, serialized entry and start/end controls. Unsupported material settings leave setup inactive; copy/paste does not relax the gate.

```text
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
Read master + latest checkpoint + live exact evidence at each wakeup. Use the
Monitor Tasks and selected policy references; at most one management action,
exact receipt/readback, at most one compact checkpoint after action. Parked or
terminal is cheap no-op without trusted authority; free-form Management Notes
cannot reactivate it. No blind retry, permission bypass or remote publishing.
Do not claim active until final configuration readback and Setup Receipt match.
```

Receipt fields: actual scheduled task identity/name; master ID and C/P identity/revisions; actual schedule/recurrence/time zone/start/end as supported; actual pinned Work model; verified scheduled connection/tools; owner/single-flight setting and verification source; effective objective/actions/limits; activation status; timestamp; every deviation/unverifiable property. Only an exact material match permits `active configured`; a prepared prompt, accepted create, acknowledgment or user model preference alone does not. Timing guarantees are only those actually documented by the external platform, not an invented SLA. Unsupported end controls may be represented by an explicit master horizon/park rule, disclosed and operator-confirmed before activation.

## Lifecycle and effective authority

| Lifecycle | Wakeup behavior |
|---|---|
| `ACTIVE` | reconstruct current state; live revalidate; at most one bounded action |
| `PARKED_INPUT_REQUIRED` | no autonomous dependent work; cheap no-op unless trusted new authority exists |
| `COMPLETE_PASS` | goal evidenced; cheap no-op; not automatic Board Done |
| `STOPPED` | explicit operator end; no new work; does not silently abort a running worker |

Operator Override/Resume provenance is **deferred to existing downstream QC/follow-up**. This implementation does not authenticate stored directives. An unauthenticated/free-form Management Note, including `OPERATOR-DIRECTIVE`, is never a trusted scheduled resume signal. Until an effective verified follow-up contract exists, a parked/terminal scheduled wakeup returns after the master read: no deep session analysis, sends, retries or notes. Do not infer authority from “latest note wins”, a worker report or `operator_authorized:true`; do not create another follow-up ticket.

An explicit **current interactive operator instruction** uses the existing [approval flow](approval-flow.md) and exact scope/target validation. It supersedes older monitor intent, not permission/host controls. Before resumed work, reconcile the serialized owner, setup, current task/session/receipt/result, permissions/questions, base/worktree and remaining budget. Record the decision source and checkpoint it applies to; only after live revalidation may lifecycle become ACTIVE. Later monitor checkpoints must retain the applied decision reference, not supersede it by timestamp. Unknown/stale/conflicting authority stays parked. Positive scheduled trusted-resume acceptance remains downstream; do not claim it implemented.

## Bounded wakeup algorithm

1. Read exact master and complete bounded description. Recover effective lifecycle, scope, latest checkpoint and applied decision. Missing/truncated/conflicting master state is unknown; no dependent mutation. Cheap parked/terminal gate runs **before** document/worker scans; self-disable is optional, not necessary for correctness.
2. For ACTIVE, confirm setup and one serialized owner. Read only the current relevant C/P sections and task/session binding. Check actual `get_session` activity, admission and session-wide pending input; pending permission/question requires operator attention, not autoapproval. A verified running/busy worker means no new dispatch/repair/next wave. Repeated unchanged running observations need no note.
3. Reconcile pending invocation by exact user message ID/status/result. `SUBMISSION_UNCERTAIN` or unknown delivery/result => reads/reconciliation, not a changed prompt or second session. Complete bounded searches where needed; absence from one window never proves non-delivery. Follow [content protocol](content-protocol.md) for full terminal originals, revisions, omissions and read coverage. A completed tool/turn is not business PASS.
4. Apply the selected policy using just-in-time live evidence and [worktree ownership](worktree-ownership.md) for writes. Choose at most one logical management action (diagnosis, repair, regression, resume/fresh, integration, next-wave start, park or completion). Required idle runtime readback is preparation for that action; do not chain diagnosis → fix → full rerun in one wakeup. Dispatch one bounded worker instruction with exact task ID, C/P paths, owner/base/target and the normal staged maintenance reminder. Do not wait indefinitely for its result; capture/check exact admission and defer the next policy step to a later wakeup.
5. Verify actual receipt/state and append at most one checkpoint for the substantive outcome/change. Terminal/result-reading work can itself produce park/completion without a new worker. Re-read master before publication so a new operator instruction is not overwritten by stale inference. Uncertain append means task readback once/reconciliation, never blind replay; missing write capability never permits full-description replacement. If the master connection is unavailable, report the gap in the scheduled run response, don't claim a durable park was saved; next wakeup reconciles first.

## Checkpoint and correlation contract

Fixed Description is outcome/primer; P is detailed canonical design/policy; C is terse current state maintained by the executing agent at substantive checkpoints; notes are append-only management evidence, not an alternate design or authentication store. Do not start a copying/maintenance worker solely for each wakeup. Use task-file paths/revisions and original evidence pointers; don't duplicate logs in C/P/Board.

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

Target short routine notes around 1,200 UTF-8 bytes; put lengthy facts in originals/documents with exact references. Reserve larger park/final note allowance at setup. Current adapter limits total Description to 32,000 UTF-16 codeunits and full task JSON (including comments/links/docs) to 40,000 UTF-8 bytes. Preflight both budgets against maximum substantive runs plus park/final and operator allowance; if exact sizing is unavailable, use conservative estimates and disclose uncertainty. Recheck reserve before any new action. Park/report before exhaustion; no pruning, truncation, automatic compaction or invented latest-note endpoint. No-op wakeups consume no note budget. Reaching horizon without verified PASS parks for operator attention; STOPPED denotes an explicit operator stop, not a guessed success.

Morning Handoff is an authorized read from master/C/P/live originals and actual Git evidence: report lifecycle, last action/receipt/result coverage, edits/tests/integration vs open acceptance, fingerprint/counters/budget, exact question and safe next step. Scheduler activation does not guarantee notification delivery.

## Pilot acceptance

After source/package checks, perform separately authorized short pilots: one sequential package with two waves and integration/base readback; one long test with a controlled harness fault, focused regression and resume/fresh evidence. Record actual platform configuration/overlap behavior, setup receipt, IDs/checkpoints and fresh-context morning reconstruction. Exercise parked free-form-note no-op; trusted scheduled reactivation remains downstream. Collect stale-state/double-send/unnecessary escalation/budget/runtime failures, refine the recipe, and require several successful bounded runs before important unattended use. Synthetic tests do not prove hosted Work/app access or scheduler behavior.
