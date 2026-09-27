# MCP idle/busy admission diagnosis and correction

Date: 2026-09-27. Adapter 0.1.6 / script 0.5.70. This focused correction builds on Delivery B and the existing metadata-only call diagnostics.

## Observations and limits

The supplied tunnel excerpt contains INFO-level forwarding records, without tool names, task states, return codes or acceptance receipts. Repeated transport correlation values and JSON-RPC ID zero alone do not establish duplicated tasks, retries or malformed requests. Roughly 15-second intervals can be consistent with bounded activity waits, but the excerpt does not identify the methods. No private tunnel/session IDs from the report are copied into fixtures or this document.

The detailed report distinguishes an old inventory task from a rejected new implementation request. Complete result search for that old task returned five correlated messages without terminal evidence. That does **not** justify clearing its guard. A later session-wide busy observation, with no currently listed tools, also does not by itself establish which task is running or whether the model is generating text. The real project's runtime has not been inspected or altered here; no abort/unlock/resend was performed against it.

## Confirmed code problems

1. Admission used only the newest 100 messages to inspect a tracked old receipt. A finished task outside that window was rejected as SESSION_BUSY unless a caller manually performed deep result reads. A synthetic regression first reproduced this refusal, then passes with write-side deep reconciliation.
2. `correlatedStatus` treated a busy session as sufficient to label any visible nonterminal old turn running. It now requires correlated unfinished-assistant or in-flight-tool evidence, and exposes those IDs. Completed tool-call iterations without a terminal answer remain unknown; a user-only receipt stays submitted.
3. Idle with unresolved evidence shared SESSION_BUSY with real backend activity and concurrent writes. It now uses SUBMISSION_UNRESOLVED, with a bounded reason and the original blocking receipt ID. Unattributed pending-input counts are explicitly session-wide rather than a guessed task state.

## Implementation

- `get_session` / `get_session_status` expose MCP-local admission tracking separately from backend activity; status also returns active correlated assistant IDs where available and pending-input scope.
- Shared write preflight handles both prompt submission and runtime changes. It only deep-searches when the old receipt is outside/not observed in the fast status window and the session was observed idle without pending input.
- Deep search reuses the existing result reader: at most 25 pages per attempt, a shared 10-second deep-read deadline, and an in-memory continuation checkpoint. A later deliberate write attempt can resume a stable incomplete search. Changes invalidate its checkpoint; no guessed timeout/idle unlock is introduced.
- Terminal receipt retirement checks the exact current ID. A late old status response cannot remove a newer guard. Current backend activity/input is checked after reconciliation and again before sending after runtime lookup. Cross-client atomicity is still not promised by the backend.
- Known nonterminal, missing, failed, changed or budget-limited evidence preserves the guard. The new requested prompt is not sent in those rejection cases. Backend status/argument errors retain their actual classification where available; no prompt is replayed by reconciliation.
- The canonical error remains the MCP tool result's `_meta["opencode-vm/error"].code`, with a visible text prefix. `reason` and an old receipt reference add context. A hosted wrapper's outer INVALID_ARGUMENT cannot be attributed to the adapter from the supplied report alone.
- Existing diagnostics are included in the release artifact and completeness checks. Rejection logs now expose the reason and blocking receipt without input/output bodies.

This does not implement persistent idempotent submissions, a new job manager, automatic cancellation or strict removal of all read-side internal bookkeeping. Process-local guards/checkpoints do not survive adapter restart; restarting is not evidence that an uncertain submission never ran.

## Verification

Synthetic cases cover five correlated nonterminal iterations with completed step timestamps (one possible form of the reported missing-terminal evidence), idle-to-busy changes without task activity, text generation without running tools, old terminal receipts, bounded/resumable searches, changed history, read deadlines/failures, true busy/input states, concurrent writes and late old reads. The report alone does not establish whether all five assistant records had completion timestamps. Real OpenCode integration seeds more than 100 later messages while retaining a separate gateway's old guard, then admits exactly one new prompt after terminal reconciliation, without replaying the old task.

Local verification on 2026-09-27: 58 adapter tests pass; the real integration passes on OpenCode 1.18.21 and 1.18.32. Two MCP archive builds are byte-identical with SHA-256 `d8976883882d6ded1c4ded193ad9e87586387bc8ba54d704d25b45bcf691f15b`; the unchanged OpenLive archive also matches its existing pin after two identical builds. The SDK/transport remain on the tested 2025-11-25 revision.

Release metadata/state, shell syntax/ShellCheck, MCP/OpenLive lifecycle, provider lifecycle, Linux lock and packaging startup checks pass. The existing editor checks pass with their optional runtime test skipped. The companion skill ZIP/checksum and its seven package tests also remain valid. Native macOS and hosted-client acceptance remain separate.

Raw JSON-RPC tests exercise ID zero and verify that SESSION_BUSY and SUBMISSION_UNRESOLVED are emitted with their own canonical codes/reasons, not INVALID_ARGUMENT. The local tunnel fixture exercises the same error metadata through tunnel-client. Hosted ChatGPT's presentation/mapping and the affected project's live lifecycle still require target-side evidence.

## Client response guide

- Actual busy/retrying or another MCP write: do not submit again to get around it; use bounded observations and the original pending invocation.
- Idle plus unresolved receipt: inspect that receipt's status/results. A full nonterminal search remains unresolved; do not abort/unlock, fabricate completion or move the task to another session automatically.
- Confirmed terminal old result: the next explicit write can reconcile the guard; the session must also be idle and free of pending input.
- Uncertain new submission: retain its original ID and verify delivery; never replay blindly.
- For the affected runtime, compare the five assistants' finish/error/completion metadata and any newly active assistant IDs with timestamped adapter/backend logs. Do not infer a missing completion from a tunnel forwarding line or an empty bounded tool list alone.
