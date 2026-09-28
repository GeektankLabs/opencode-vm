# Changelog

## 2026-09-29-r12

- Propose classification only for trackable outcomes; search existing Board Projects and tickets before offering a confirmed extension, ticket, workstream or Inbox setup.
- Keep board writes user-confirmed, distinguish native Inbox-to-workstream reclassification from the unavailable global/local transfer, and recover uncertain transfers by the same request UUID.
- Keep technical transfer staging and agent/session completion separate from business Done; add synthetic classification and recovery cases.

## 2026-09-28-r11

- Use transport-neutral project runtime profiles `deep`, `standard`, and `execution` for new authorized work when supported; explicit user choices take precedence.
- Apply an available configured runtime to an idle session before sending and briefly disclose profile/model/variant. Pure reads never switch; unavailable mappings are not silently substituted.
- Replace fixed clarification model/variant heuristics with project profile resolution and exact readback.

## 2026-09-28-r10

- Add capability-driven project-board lookup: exact task IDs, title/description search, task/session reverse lookup, search-before-create and explicit incomplete-scan reporting.
- Keep board outcomes separate from session execution, read complete originals before business conclusions, and preserve multiple session/message references without assuming a review-role taxonomy.
- Add a read-only remainder-synthesis preview that accounts for every known open obligation and marks gaps without applying task mutations or making completion claims.

## 2026-09-28-r9

- Add a discovered-tool-only upload workflow for supported images and text/Markdown using session-bound, one-use attachment IDs; preserve normal `send_message` write/uncertain semantics.
- Add an explicit PDF-to-Markdown/text fallback, size-aware splitting and coverage rules, plus a no-raw-upload policy for other unsupported types.
- Add synthetic image/text, PDF extraction, limits, unsupported model/type and expired/one-use reference review scenarios. This package does not claim hosted ChatGPT or Voice attachment acceptance.

## 2026-09-28-r8

- Add an explicit recovery path for `SUBMISSION_UNRESOLVED`: inspect the exact old receipt and current guard, explain the remaining risk, and require fresh user approval tied to that guard.
- Use `supersede_unresolved_submission` only when discovered; it atomically audits the operator decision and submits the approved next task once. Verify its own returned message ID without a second send.
- Preserve the exact client UUID/request on uncertain recovery, never infer operator approval from the original task authorization, and stop on stale guards, active work or pending input.
- Add synthetic regression scenarios; this instruction package does not claim hosted ChatGPT behavior or live override acceptance.

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
