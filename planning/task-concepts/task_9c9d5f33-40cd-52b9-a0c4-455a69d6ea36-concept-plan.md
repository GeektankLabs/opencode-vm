Task-ID: task_9c9d5f33-40cd-52b9-a0c4-455a69d6ea36
Title: MCP - sichere abfragbare Worker-Fehlerdetails
Status: integrated_pending_release
Last-concept-update: 2026-10-06T01:38:38+02:00

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

Candidate evidence on 2026-10-06: initial implementation is local commit `e737a87`; first QC remediation is local commit `b914e88`. Repeat QC found and the current candidate remediates three further issues: legacy bytes and event cursors validate before any target write, complete prepared evidence retains IDs beyond the ten exposed error details, and public schemas require an exact safe projection with internally consistent total/truncation fields. `npm run check` passed; `npm test` passed with 125 passing tests and 2 existing skipped pinned-upstream integration tests. The candidate is local-only and awaits a remediation commit plus repeat independent QC.

Subsequent QC of local commit `55122f4` identified late durable error metadata and empty persisted detail arrays. Current remediation refreshes same-terminal safe evidence through the normal collector, publishes a newly sequenced correlated occurrence with fresh delivery tracking, and rejects empty persisted arrays before migration. An internal hash of all safe correlated error projections detects revisions beyond the public ten-detail cap; stale nonterminal observations remain protected. Collector, saved-cursor continuation and already-delivered webhook regressions pass. Validation passed with 127 tests passing and 2 existing integration skips. Final independent read-only QC returned **No findings**, with separate cursor/delivery/dedup/stale-state probes; the reviewer did not independently rerun the full suite. Integration/publication and hosted client/webhook acceptance remain separate.

Local integration on 2026-10-06 under operator Go `OCVM-ERRORDETAIL-INTEGRATE-20261006-01`: fast-forward of `main` from base `819f8d48f38f06e7ad0e78bbbf6828349c02b8a6` to the exact reviewed candidate `f0add8ef378737d821fe7151f1a08e985c3a8cd8`, preserving the full series unchanged. JIT checks confirmed the candidate paths clean, foreign root changes and the Hub worktree (`task_686da158`, own commit `1deaf2c`) untouched, no script/version/asset change in range, and no push to origin. The integrated tree was re-verified green (adapter check + 127 tests / 2 existing skips). This integrates only the authorized point-4 error-detail surface; the broader Board ticket, adapter version bump/pin, release build, runtime rollout/restart and hosted client/webhook acceptance remain separate operator decisions. Fallback `task_fa86d673` remains HIGH todo and its concept/Hub dependency is a handoff only, not part of this scope.

## Combined release preparation and Hub dependency (read-only, 2026-10-06, Go `OCVM-ERRORDETAIL-RELEASE-PREP-20261006-01`)

- Verified tips: main `033db3d014e8677f5a7acfc13616ea9b87644b4d` (= reviewed code `f0add8ef378737d821fe7151f1a08e985c3a8cd8` plus docs-only record); Hub candidate `1deaf2c8caa398b45525fdce099f7acaf60e6ae7` on parent `819f8d48…`, immutable under independent read-only QC (`ses_ef1940a76ffe9Sqa2bOntjw6lj`), Hub writer paused. No shared version/pin/archive/root-index mutation happened during this preparation; only this task's own C/P documents were written.
- Disjointness and mergeability: the Hub's 16 files (script, workflow, `hub/`, tests, README/AGENTS/WEB-EDITOR docs) share no path with the point-4 range (14 files); read-only `git merge-tree --write-tree main 1deaf2c8…` predicts clean tree `05086e245d389619e5257769624c3b2fd098d5f8`.
- Pin loss mechanism confirmed: Hub 0.7.7 keeps `MCP_ADAPTER_VERSION=0.1.23`/`MCP_ADAPTER_SHA256=4d9a5eaf06b5c0a72c4af1e6cd4364231ca24fdf7e141d95f4c69744c462eb8f` (the v0.7.6 pre-error-detail archive). A combined release must therefore bump the MCP adapter to **0.1.24** (package.json + package-lock + `ADAPTER_VERSION` + script version/filename/digest from a double build), and the combined script to **0.7.8** (`v0.7.7` is consumed by the immutable Hub commit), keeping OpenLive 0.1.7/`39a50c5127b0a577b54e4790b5c3c1f463b35a52b42c4343aa639dcea53bad47` and re-digesting the Hub archive (`e5ec4ea0dc3e43cebcae10eed25c3aaeaa909abbc8c80b9534674862d6599194` from Hub bytes) under the new tag.
- Serialized integrator order after the Hub QC verdict: JIT recheck → `git merge --no-ff` of `1deaf2c…` into main → adapter 0.1.24 + script 0.7.8 prep edits → build all three archives twice to scratch with byte `cmp` and `shasum -a 256` → pin digests → full `RELEASING.md ## Validation` battery → independent read-only exact-commit QC of the combined tip → operator pushes that exact SHA; CI creates `v0.7.8` with the five assets. Rollout is by new sessions only; no live adapter restart. Rollback stays local and linear (revert commits or reset main to `033db3d…`); runtime continuity per RELEASING while any gate is red or unverified.
