Task-ID: task_9c9d5f33-40cd-52b9-a0c4-455a69d6ea36
Title: MCP - sichere abfragbare Worker-Fehlerdetails
Status: candidate_ready_for_qc
Last-concept-update: 2026-10-05T23:04:08+02:00

# Canonical Concept Plan

## Scope and authority

This candidate implements only the authorized worker-error-detail surface. The Board remains the scope authority; this plan records the candidate design and does not change Board status, deployment state, provider configuration, session state or task membership. Work is isolated to the task worktree and later publication/integration remains a serial operation by a separate integrator.

## Verified problem

OpenCode stores structured Assistant `info.error` data independently from visible text/parts. The observed failed assistant records `APIError`, message `Provider response headers timed out after 300000ms`, `isRetryable:true`, metadata code `ProviderHeaderTimeoutError` and `timeoutMs:"300000"`; it has no parts. The Web UI renders its error message from the Assistant error, while the MCP `describeMessage()` projection currently collapses all non-abort errors to `error:"failed"`. History, direct message reads, task results and prepared attention consequently lack the diagnostic even though it is durable and natively readable.

## Settled design

1. Add one shared optional `error_detail` to projected Assistant messages. Its fields are bounded `category`, `name`, `code`, `timeout_ms`, safe-template `message`, `detail_availability`, `source:"assistant_message_error"`, and optional `source_is_retryable` only when the stored field is actually boolean.
2. Raw source strings are never copied. Exact known OpenCode error names/codes map to fixed safe templates. `ProviderHeaderTimeoutError` additionally requires a finite positive numeric metadata `timeoutMs` within the timer range before exposing `timeout_ms` and its exact template. Unknown or free-form error data gets only a generic safe message plus an explicit redacted availability marker.
3. Headers, response bodies, URLs, arbitrary metadata, provider/model identifiers, attempts, retry advice, tool state errors, inputs, outputs, reasoning, stacks and session-only events are excluded. The adapter does not make any retry/provider decision from `source_is_retryable`.
4. `get_session_status(session_id,message_id)` receives only details from Assistant messages whose `parentID` exactly equals the requested user message, each labeled `attribution:"exact_parent"`. Uncorrelated session events and later turns cannot be attached. Existing state/error semantics stay unchanged.
5. Prepared attention carries those safe exact-parent details and hashes them into a new source-revision input independently of visible text. Empty visible text can therefore yield a safe failure summary when a durable Assistant error exists. Tool-only/raw failures remain private and do not gain a new exposure path.
6. All fields are optional/additive in strict output schemas and persisted attention state, preserving legacy entries that lack details. Message text revisions/content references retain their existing visible-text semantics.

## Acceptance criteria

- The real header-timeout shape without Parts produces matching safe details in history, get_message, task-result messages, correlated status and prepared attention.
- Unknown/free-form and sensitive long/Unicode errors expose no source content and remain explicitly redacted; bounded safe strings do not exceed 1 KiB message or 128-byte identifiers.
- Abort remains distinct; tool errors remain private; session-only events gain no false task correlation; an old failed parent beside a newer running turn remains bound only to its exact parent.
- Strict tool output schemas accept the new optional fields; attention source revision changes when safe error evidence changes; response budgets remain enforced.
- No live adapter deploy/restart, VM/provider configuration mutation, Board Done transition, remote Git action or automatic retry is performed.

## Verification and handoff

Focused unit and MCP wire/schema regressions will accompany the candidate. Before any future publish, rebase/reconcile against the intended integration base, inspect all commits/diffs, run the relevant adapter suite again, and have an independent reviewer verify redaction, strict schemas, parent correlation and source-revision behavior. A separate operator decides publication, adapter rollout, catalog refresh and external ChatGPT acceptance.

Candidate evidence on 2026-10-05: `npm run check` passed; `npm test` passed with 123 passing tests and 2 existing skipped pinned-upstream integration tests. The candidate is local-only and awaits commit plus independent QC.
