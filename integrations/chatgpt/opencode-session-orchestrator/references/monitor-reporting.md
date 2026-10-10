# Monitor, progress and night reports

Use when the operator asks for a report on a monitored or managed run (monitor tick summary, progress request, night report, Morning-Handoff style). This is a read-and-assemble contract only: no new runtime, scheduler, notification channel or extra dispatch. The [journal-mode branch](../SKILL.md#journal-mode-before-queueevent-workflows) applies first.

## Assemble from evidenced sources

Gather what the selected connector actually exposes; name every source used and skipped:

| Source | Read | Gives |
|---|---|---|
| Task documents | registered C/P paths with revisions via the [document rules](worktree-ownership.md#publish-task-documents-without-a-second-writer) | commissioned state, current phase, decisions |
| Task Management Journal | `get_task_management_history` (`latest_checkpoint`, then `after_checkpoint`) | durable management decisions/notes, distinct from the Activity Journal |
| Native monitor history | the connector's monitor-history read (opencode-vm: `get_monitor_history`) | engine decision entries such as dispatched/no-op, `worker-observed-failed`/`-complete`, `recovery-resolved`, `recovery-chain-exhausted`/`final-fallback-unconfigured`/`profile-fallback-unconfigured`, `recovery-park-resumed`, `recovery-episode-closed`, with bounded coverage |
| Exact receipts | manager dispatch WAL message id, worker `dispatch_receipt`/`result_receipt` (assistant message IDs), correlated through the submitted **user** message ID | which turn is which result |
| Original results | the [stored-result protocol](content-protocol.md) | actual report text with revision/range/omission evidence |

Do not present MCP request/message IDs as provider or API request IDs: they are connector-level correlation handles. Provider identity appears only in exposed safe error details (for example an error category), never in these IDs.

## Declare coverage; never claim error-free from gaps

Every section of the report names its source and read coverage (`complete`, `partial` with the bound, or `not read` with the reason). Counts (timeouts, retries, fallback switches) are stated only when the underlying coverage is complete enough to count. Missing coverage, truncated history, `search_complete=false` or an unread window blocks an "error-free"/"no failures" claim — say what was not read instead of inferring health.

## Evidenced errors stay visible — briefly

Scan everything actually read for evidenced errors (safe error categories such as provider timeout/quota/auth, recovery/fallback/park decision entries). Name each distinct evidenced class in one short sentence **even when the run later reached PASS or completion**: automatic recovery continuing the work is working-as-designed context, not a hidden failure, and it is not a reason to reopen or re-run anything. No mandatory error chapter, no log dump, no speculation beyond the evidence; give details on request or point at one verified location (exact history entry/ID or document path with revision).

Example wording — only when the evidence actually shows it:

> The run hit provider timeouts; the configured automatic fallbacks continued the work. Details on request / in monitor history [exact reference].

With `activity_journal.state:disabled` (fresh opencode-vm default) there are no Activity/Attention events: assemble from bounded exact-receipt status/result reads, native monitor history, the Task Management Journal and C/P instead, and say so. `state:unavailable` on an enabled journal is a named fault, not a silent gap.

## Shape

Keep the existing [Morning Handoff](monitor-tasks.md) fields and compactness: lifecycle and substantive outcome first, then one line per evidenced error class, then receipts/results with their coverage, then open questions and exact pointers — never raw dumps. A completed turn or tool is still not business PASS; terminal originals decide.
