# MCP Delivery B: observable tool progress and journal tail

Date: 2026-09-27. Script 0.5.68 / adapter 0.1.4. Baseline commit: `1a665f2`.

Status: implemented and locally verified. Hosted ChatGPT/Voice and native macOS/Lima acceptance remain outstanding.

## Scope and decisions

The user approved the small Delivery B recommendation: observable tool metadata plus an efficient current journal entry with forward continuation. The implementation adds one ordinary read-only tool, `get_session_progress`, and `tail:true` on `get_project_activity`. The total tool count is fourteen. The MCP SDK 1.30.1 / OpenCode SDK 1.18.21 / tested 2025-11-25 transport baseline is preserved.

- Progress uses ordinary, bounded OpenCode reads. No new daemon, collector subscription, persistent tool store, model summary or percentage estimator is introduced. The existing SSE collector is unchanged.
- The real legacy message API exposes tool names, call IDs, running/completed states, start/end times and parent correlation on OpenCode 1.18.21 and 1.18.32. A gated harmless shell tool in a disposable test project verifies those fields while running and after completion. Production permissions are unchanged; only the isolated integration fixture explicitly permits its synthetic shell command.
- Progress selects at most the ten most recently started known in-flight tools from the newest 100 messages, plus the finished tool with the newest known end time in that window. The response explicitly reports history/cap/metadata limits, unattributed parts, observation and source times, session-wide pending input and idle alongside recorded in-flight tools. Multiple parallel tools retain individual message/call IDs.
- An optional user `message_id` selects only exact assistant `parentID` matches. There is no latest-user/time-proximity attribution. Missing metadata or an empty bounded window must not be narrated as definite inactivity. Tool completion is not a substantive success verdict or shell exit-code inference.
- Progress has an explicit field allowlist: identifiers, states and timestamps. Titles, arguments, results, descriptions, raw errors, metadata and reasoning stay private. No general tool-output reader is added. The existing serialized 64-KiB read-response bound applies.
- Journal tail captures the current head, scans newest-first with the existing visibility/deadline rules, and returns the selected events oldest-first. Its next cursor points to the captured head, so concurrent/new events are not lost. Budget-limited selection is explicit; it can be retried with a smaller limit. Older retained history remains accessible through ordinary forward reads.
- `filter_key` hashes the fixed project and canonical query filters, excluding page size/cursor/tail mode. Clients keep separate cursors per key. The existing global journal cursors/retention remain unchanged; the server does not enforce filter binding or maintain consumer state. Reusing a cursor under a different filter can still skip prior records and is explicitly outside the client contract.
- Tail selection is not historical consumption or acknowledgement. Collector health cannot retrospectively prove lossless coverage. Epoch/retention expiry remains `CURSOR_EXPIRED`; there is no new replay/archive infrastructure.
- Incremental conversation history, general tool outputs, export, personal discussion state, write idempotency and protocol migration remain separate follow-ups.

## Verification

- Adapter suite: 46 unit/fake-backend/HTTP tests pass. New scenarios cover parallel pending/running tools, completed/error metadata, exact task filtering, session-wide pending counts, idle/stored-state mismatch, history and ten-tool bounds, missing/future metadata and confidential field exclusion.
- Journal tests cover latest matching selection, chronological output, concurrent appends beyond the captured head, filter-key canonicalization and independent progress, restart persistence, empty windows, visibility rejection, bounded scan disclosure, invalid tail/cursor combinations, retention expiry and epoch changes.
- Disposable real OpenCode integration passes on 1.18.21 and 1.18.32: an actual shell tool is observed through MCP while running, then after completion, with matching timestamps/IDs and no leaked arguments, title, output or extra model requests. A completion tail is followed by a wait that receives a second independently completed task. Filter identity is preserved after adapter restart. Delivery A reconstruction and deep result search regressions also pass.
- Real tunnel-client 0.0.15 local-control-plane test discovers/invokes fourteen tools, exercises progress and tail-to-forward continuation, and retains the hash-identical 290,017-byte Delivery A read test. The observed MCP initialize offer/selection remains 2025-11-25. These are programmatic tests, not proof of hosted ChatGPT/Voice presentation.
- Two MCP archive builds are byte-identical; SHA-256 `5e32e3609112ff893c8a2055054f3795d8a9391c546932635daec8f878153f3f` is pinned in the script. The unchanged OpenLive archive was also built twice identically and matches its existing pin. TypeScript, shell syntax/ShellCheck, release metadata/state tests, Linux lock regression, Actionlint and OpenLive unit/integration regressions pass. No commit or publication is implied by local implementation; native macOS and hosted acceptance remain external.
- MCP/OpenLive lifecycle and Besprechung shell tests pass. The extracted 0.1.4 package installs its locked production dependencies and reaches the expected missing-runtime startup check. `git diff --check` passes.

## Known runtime issue

During the preceding diagnosis, OpenCode 1.18.32 reproduced `MaxListenersExceededWarning` after sequential SSE connections/disconnects in an isolated server with no adapter and no model work. Delivery B introduces no additional event subscriptions and does not claim to repair that upstream cleanup issue. A stored `running` state is not independently verified process liveness. OpenCode runtime stabilization remains a separate work item.

## Target-host acceptance

After deployment/reconnect, refresh ChatGPT's tool catalog and verify `get_session_progress` appears. Record host/runtime/adapter/tunnel versions, actual ChatGPT surface and observed protocol revision where accessible.

1. Inspect a known running harmless task. Confirm the coordinating model can read tool name, recorded state, time and task ID; after completion it sees the finished step. Verify no raw commands/outputs or fabricated success percentages are presented.
2. Read `get_project_activity` with `tail:true` and a fixed filter; save its `next_cursor` under `filter_key`. Continue without tail using the same filters, and confirm a newly completed task appears.
3. Keep independent saved progress for two different session filters; switching back restores the proper cursor. Explain that tail leaves older history unread and budget-limited selection remains partial.
4. Check exposure limits, pending input in first-party UI, restart/expired-cursor recovery, and Voice separately if used. Hosted ChatGPT/Voice and native macOS/Lima acceptance remain external.
