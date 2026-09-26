# MCP runtime configuration and project activity baseline

Status: Implemented locally in script 0.5.66 / adapter 0.1.2. Target-host acceptance remains outstanding.

## Scope and decisions

This extends the shared `adapters/mcp` connector used by bi-mcrepo and other projects. Existing message IDs, prompt admission and correlated status remain authoritative; no separate task service is introduced.

1. Review `create_session`, reuse its visible-primary-agent/connected-model discovery for `get_session_runtime_options`, and validate default variants as well.
2. Add partial `update_session_runtime` for idle exposed sessions. Preserve omitted fields and share the MCP submission lock. OpenCode provides separate v2 agent/model switches, so verify the final state and report a possibly partial failure rather than claiming an atomic update or rolling back concurrent work.
3. Add a private, atomic JSON journal beside the runtime descriptor in the session share. Retain 5,000 events and bounded observation checkpoints; epoch-qualified monotonically increasing cursors survive adapter/server reconnects. Missing/recreated journals or evicted cursors produce `CURSOR_EXPIRED`.
4. Subscribe to project OpenCode events inside the existing adapter and reconcile bounded durable history at startup and periodically. Capture all exposed sessions, including work submitted by other first-party clients. Store only titles, identifiers, states, counts and runtime settings, never prompts, answers, permission payloads or reasoning.
5. Expose `get_project_activity`, with filtering and cursor pagination, plus bounded `wait_for_project_activity` (maximum 15 seconds). Add optional receipt timestamps and an activity cursor before admission; keep the existing receipt fields and no-retry semantics.
6. Exercise acceptance A–I with isolated backend fixtures and real OpenCode. Refresh the adapter artifact/version/checksum and interface/runbook.

## Explicit baseline limits / follow-up work

- The journal is an observation journal, not a guaranteed lossless replay of the backend event bus. Transient states while the adapter is stopped/disconnected cannot all be reconstructed; collection health and reconciliation timestamps are returned. Durable completions are reconciled where present in the bounded history.
- Reconciliation examines up to 200 exposed sessions/ten discovery pages per sweep, plus tracked MCP receipts, and the newest 100 messages per session (the existing status bound). Live event-driven collection also covers sessions outside that discovery window. Observation checkpoints retain up to 500 sessions; larger installations need a more scalable collector/store. Transition deduplication is checkpoint-bounded, not a permanent exactly-once guarantee: evicted/restored history may be observed again.
- The journal survives adapter restart and retained-VM reconnect/disable/re-enable. A fresh VM/share or explicit share deletion resets its epoch and expires old cursors. Cross-fresh-VM archival is deferred.
- MCP-local serialization cannot atomically exclude simultaneous Web UI/TUI/other-client writes. Busy is checked before changes and between separate switches. Cross-client compare-and-swap/atomic multi-field updates require backend support.
- Pending-input attribution inherits the existing session-wide fallback in correlated status. A session event can omit its message ID when no reliable receipt is known; finer attribution for competing/queued first-party turns remains follow-up work.
- Capability enumeration is bounded and advertises truncation; additional catalog pagination can follow if needed.
- `client_request_id`, event previews, hosted push delivery, and additional permission-answer tools are deferred. No automatic prompt or runtime-update retries are added.
- Older empty sessions without agent/model metadata or a prior user message cannot preserve missing runtime settings and report `UNSUPPORTED_CONFIGURATION` on update. Initialize them in the first-party UI, or create a configured session with `create_session`; more flexible initialization can follow.
- Real macOS/Lima and ChatGPT/Voice acceptance remains a target-host task.

## Verification and review findings

- `create_session`: existing scope/identity/no-prompt/no-retry behavior retained; configured variants and native model disabling are checked. Real OpenCode 1.18.21 exposes custom models in its v2 catalog only after bridging them on use, so connected legacy model entries are valid discovery/creation inputs until the native entry exists. Native enabled/variant metadata then wins.
- A–D: plan/build updates, exact model/variant persistence, invalid-model errors and busy refusal are covered in fake-backend and real-OpenCode integration tests. A shared MCP session lock blocks racing `send_message`; uncertain/partial updates are never retried or rolled back.
- E–F: two real OpenCode sessions run concurrently against a controlled provider. Releasing A yields exactly A's correlated completion; releasing B makes the next cursor/wait return only B's completion.
- G: permission and question requirements, counts, and privacy are covered with backend fixtures and transient journal signals. Real interactive permission-dialog product acceptance remains external.
- H: real adapter restart preserves both completion events and the cursor; bounded-journal tests exercise retention expiry, epoch reset, visibility/filtering and corruption refusal.
- I: fake transport failure after admission is a single submission attempt. The old message ID recovery contract is retained; journaling does not replay prompts.
- MCP SDK 1.30.1 validates `structuredContent` against success schemas even for error results. Structured error codes therefore live in `_meta["opencode-vm/error"]`, alongside the unchanged error text.
- Journaling is serialized transactionally. Signal updates read their checkpoint inside the transaction; MCP writes invalidate in-flight collector snapshots to avoid stale overwrites and duplicate completion observations.
- Current verification: 32 unit/fake-backend tests, the real OpenCode integration (including independent A/B completion and restart), and ten-tool interoperability with the pinned tunnel-client's local control plane pass. The adapter archive is built twice byte-identically and its SHA-256 is pinned in the script.
