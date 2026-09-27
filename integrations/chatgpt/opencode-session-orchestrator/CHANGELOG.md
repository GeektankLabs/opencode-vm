# Changelog

## 2026-09-27-r7

- Explicitly classify each new `send_message` task as a write-capable, non-idempotent connector call, independently of a read-only remote task scope.
- Distinguish existing-result retrieval from fresh read-only research, preserve explicit prompt limits and leave approval decisions to the host/backend without retrying to provoke a card.
- Add synthetic A–E regression scenarios for status reads, read-only research, planning-file edits, uncertain delivery and explicit WRITE/read-only phrasing.

## 2026-09-27-r6

- Proactively offer bounded `[KLÄRUNG]` sessions for independent code/planning details while the original workstream is busy; create them only for an authorized clarification, with an exact origin link and focused context handoff.
- Choose the newest identifiable OpenAI Luna with `xhigh` from the live catalog, verify runtime before submission and route emerging concept planning into a consciously chosen workstream.
- Separate local closure from optional user-requested server archiving, with explicit archived-content reads where available; collect MCP/skill product suggestions for the responsible programmer rather than silently implementing them during subject work.

## 2026-09-27-r5

- Explain the MCP admission distinction between backend/concurrent-write `SESSION_BUSY`, idle-but-unverified `SUBMISSION_UNRESOLVED`, and potentially delivered `SUBMISSION_UNCERTAIN`.
- Bind an unresolved rejection's correlation ID to the older receipt, not the rejected new request; do not treat idle or finished tool-call steps as proof of task completion.
- Use the server's error metadata and admission state where available, without assuming these fields exist on other compatible connectors.
- Add synthetic regression cases for stale guards, unrelated busy signals and uncertain new sends. No write retry or permission-setting behavior is added.

## 2026-09-27-r4

- Maintain the reviewed skill as an optional, generic client package in the opencode-vm repository; preserve the skill name and display name.
- Add capability-based Delivery B tool progress, bounded coverage, session-wide pending-input handling and idle/stored-state interpretation.
- Add recent journal tail reads and independent progress per project/filter; distinguish a captured-head continuation from historical consumption.
- Clarify response-local `content_complete`, including a false value on the final page of a fully traversed visible stream.
- Discard old search-page accumulation after `SEARCH_CHANGED`; deduplicate only within the new search attempt.
- Add explicit connection selection for multiple compatible servers and preserve legacy fallbacks. No fixed tunnel IDs, account identifiers, server aliases or credentials are bundled.
- Replace the icon with an independently drawn OpenCode VM enclosure/terminal design. Keep documented UI/invocation metadata; remove the earlier unverified product-list declaration rather than claiming installation compatibility across products.
- Keep task submission and request lookup capability-driven: idempotent submission and restricted analysis are not assumed to exist.
- Add Delivery B and multi-connector behavioral review cases. These are scenarios, not claims of live ChatGPT/Voice acceptance.

## 2026-09-27-r3

Permission-flow update on top of r2; retain complete long-content retrieval, exact-task verification, session tracking, decision preparation and concept-persistence behavior.

- Add a prominent approval-flow section and dedicated reference.
- Act on clear conversational authorization without another invented "shall I send" loop.
- Preserve one pending invocation across on-screen approval and interruptions.
- Separate missing response, host approval, MCP acceptance, backend permission and execution.
- Require actual error evidence before saying a send failed; protect against duplicate non-idempotent submissions.
- Preserve approved bounded work packages without per-step verbal bureaucracy.
- Add dated official documentation for per-tool conversation approval and refresh behavior, app-specific permissions, accurate annotations and API/ChatGPT differences.
- Do not advertise snapshot-based arbitrary execution as read-only or universally risk-free; use only real supported narrower capabilities.
- Add 23 synthetic approval-flow regression cases; no live writes or permission changes performed by packaging.

This package does not automatically update the installed skill or app/workspace permissions. The marker is a skill revision, not an MCP protocol/server version.

## 2026-09-27-r2

Update of the existing `opencode-session-orchestrator` skill; preserve its name, display name, icon and implicit invocation policy. This marker is a skill-bundle revision, not a claimed server or MCP protocol version.

- Add capability-based use of `get_task_result`, `get_message` and `read_message_content`, with legacy fallback.
- Separate task-search completion, history paging, visible-text coverage and omitted parts.
- Add stable content-reference/cursor handling, revision changes, UTF-8 range continuity and truthful checksum reporting.
- Tighten exact-message send verification: accepted is not running; pending approval is not a proven failed send.
- Handle bounded status windows, task-state conflicts and journal coverage gaps without blind resubmission.
- Preserve active/waiting/attention/parked/closed topics and prepared-but-unsent follow-ups across session switches.
- Require architecture context, operational examples, evidence and recommendations for every decision topic and delegated request.
- Separate user decisions, expert code checks, authorized live verification, implementation planning and execution.
- Add concept-persistence and contradiction-check guidance without treating planning as permission to implement.
- Add regression scenarios for the observed failure patterns.

Bundle no live session registry, private project IDs, credentials or project-specific business decisions. Add no executable scripts or background monitor.
