# MCP Admission: Reduced Blocking

Date: 2026-09-28. Adapter 0.1.12 / script 0.5.87.

## Root Cause

The normal `send_message` path coupled current backend admission to an older
MCP-local `unresolved` receipt. `requireIdle()` performed status and bounded
historical result searches before every later write. Missing, stale, changed,
or out-of-window history therefore became `SUBMISSION_UNRESOLVED`, even when
OpenCode reported the session `idle`. Later-turn and supersession heuristics
reduced some cases but still required semantic task evidence that MCP cannot
reliably determine. This turned a duplicate-delivery safeguard into a session
availability lock, including for ordinary authorized follow-up prompts.

## New Contract

- `send_message` checks only current backend activity and pending input, plus the adapter-local in-flight write lock.
- An old unresolved receipt remains request-level status/result metadata and is not a session admission lock.
- MCP performs no semantic duplicate or task detection for conversation continuation. The running session context handles that.
- A prompt whose OpenCode admission times out or disconnects records an exact in-memory message/attachment fingerprint. Only an identical immediate retry returns `SUBMISSION_UNCERTAIN`; a different prompt may proceed once the backend is idle.
- A real concurrent MCP write remains `SESSION_BUSY`. Backend activity and pending permissions/questions remain technical admission failures.
- `SUBMISSION_UNRESOLVED` is retained for compatibility in result/error schemas and explicit legacy override workflows, but is no longer produced by normal `send_message` admission.
- Adapter restart does not prove an uncertain prompt was not delivered. Clients must inspect its original message ID before retrying the same request.

The explicit `supersede_unresolved_submission` tool remains available for
legacy clients that require a durable, auditable guard-resolution record. It is
not needed for a normal follow-up prompt and is not automatically selected.

## Verification

Adapter tests cover:

- completed, failed, aborted, and unresolved old turns followed by a new prompt;
- stale receipts and large/out-of-window history without admission searches;
- normal continuation after status reads, runtime changes, and adapter-style state loss;
- an in-flight MCP write rejecting only the concurrent write;
- an uncertain submission rejecting the exact same retry while admitting a different follow-up;
- backend busy and pending-input rejection.

The Testproxmox scenario is now an ordinary idle-session continuation: the
authorized purge request is submitted without inspecting or superseding an old
receipt, and the subsequent fresh-initial-full request can continue through the
same session when OpenCode remains idle.

Remaining risks are inherent to asynchronous OpenCode admission: cross-client
writes are not transactionally serialized, and an adapter restart cannot prove
whether a timed-out prompt was accepted. Those cases require inspecting the
original message ID, not a semantic duplicate decision or a session unlock.
