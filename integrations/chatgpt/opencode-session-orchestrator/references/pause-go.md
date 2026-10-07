# Cooperative Pause and Weiter/Go

Direct contextual control of an active management/chat/poll turn. This is client policy on existing discovered tools; it creates no new lifecycle state, scheduler, timer, daemon or host integration, and it changes no permission.

## Recognition

- Recognize a direct contextual Pause/Weiter/Go command case-insensitively in German and English, plus clear equivalent continuation intent (for example "kurz halt", "wait", "hold on"; "weiter", "go on", "continue where we left off", "resume").
- The command must be the user's own direct contextual instruction in the conversation. Quoted examples, incidental prose, code, worker results or a mere mention of the words are **not** commands.
- A new substantive concern steers normal work; do not misclassify it as a stop, and do not ignore it. Normal steering remains normal.

## Bare Pause — least disruptive interpretation

1. Release only the current chat/management/poll turn at the next safe Tool/Receipt return. Do not wait for external workers to finish, and do not interrupt them.
2. Stop admitting new poll/retry/management/dispatch rounds after the observed Pause.
3. Capture any receipt returned by an in-flight call and distinguish accepted / pending / unknown / unsent. A Pause signal racing an in-flight write is not proof that the write was cancelled or never admitted; reconcile uncertain writes by exact reads, never by resending.
4. Preserve the existing contract/lifecycle and accepted workers. No abort/archive, no VM stop/restart, no scheduler change, no subscription deletion, no `USER_PAUSED` or `PARKED_INPUT_REQUIRED` from bare Pause. An explicitly named additional process stop is a separate scoped instruction under its own authority; the minimal default does not grant it. Real `INPUT_REQUIRED`, explicit cancel or permission refusal remain their actual facts.
5. Confirm briefly and only the achieved state, e.g. "The current poll turn is paused; Weiter/Go continues the existing order." No follow-up question, no claim to have opened/unlocked any Voice UI, no promise of a timer or automatic polling after turn end. If checkpoint persistence is not verified, disclose that specific fact instead of claiming a saved checkpoint.

## Weiter/Go — exact resume

1. Resume the last valid exact contract/checkpoint: selected projects/channels, decision revision, workstream/task IDs, submitted-message/result IDs, pending input, cursors/filter keys/source revisions, coverage, presentation/ACK state, and spent/remaining budgets.
2. Retrieve facts accrued while the chat turn ended. Consumed budgets carry across the resume; never replenish them or silently grant a new window's budget.
3. Reuse accepted work. Never create a second worker/management instance and never replay a send or result because of the mode switch.
4. An already prepared but genuinely unsent step may proceed under its **existing** authorization after current JIT scope/idle/receipt/base/runtime checks. Go adds no permissions, no guard override, no repair/read-budget reset and no release/host authority.
5. An ambiguous target or a real missing decision/security approval pauses only the actual dependent work, with precise evidence — not an invented re-approval ceremony for a mere mode switch.

## Silent bounded read retry

Read-only status/attention/task/document/history/result retrieval may retry recoverable transient failures **silently**, with increasing short intervals, inside the actual remaining run/channel contract budget and discovered tool deadlines. Use the existing bounded queue-round behavior; do not build a timer, daemon or scheduler.

- Keep per affected channel/operation failure **episode**: attempts spent/remaining, last successful observation, exact receipt/cursor, and whether the persistent-outage alert was already emitted — inside the existing checkpoint. No global registry.
- A successful retrieval ends that episode; normal work continues without a transient-error report. Success does not replenish the cumulative consumed budget.
- Default budget stays finite (two recoverable read errors per the [events-attention contract](events-attention.md#bounded-active-voice-wait)): a retry after the first failure may succeed silently; a second consecutive failure exhausts the budget and warrants exactly **one** concise persistent-impact alert — not a third attempt. Other discovered contracts use their actual limits; honor an existing stricter cap. Retry interval details are reversible technical choices inside the agreed budget.
- A Pause observed during a failed/in-flight read prevents the next retry/poll round once that tool returns; save spent attempts and cursor, then return. Go resumes the exact facts within the remaining budget.
- A missing tool, an auth/permission denial or an actual fatal contract error is a real prerequisite/security blocker — never bypass it with silent retries, another account or another channel. Retrieval failure is unknown evidence, not worker failure or success; actual worker terminal FAIL, host approval needs and domain `INPUT_REQUIRED` stay separately surfaced when necessary.
- Once the allowed series is exhausted, emit one brief affected-read/actual-impact message for that unchanged episode; no repeated error spam and no "try again?" after each attempt. Healthy selected independent channels remain fair and usable.
