# Tool progress and recent project activity

Use these capabilities only when the selected connector actually exposes them. Discover once, retain the schema, and preserve the connector/project identity across every request. A Secure MCP Tunnel supplies transport, not these capabilities by itself.

## Which question is being answered?

- **What is this session doing?** Prefer a compact tool-progress snapshot.
- **Has this exact task finished?** Use correlated task status/result search with the submitted user ID.
- **What happened recently across sessions?** Use the activity journal, optionally its tail entry.
- **What did the completed task conclude?** Read the original report through the [content protocol](content-protocol.md).

These are different observations; do not substitute one for another.

## Observe tool progress

When `get_session_progress` exists:

1. Supply the selected session. If the task is known, use the submitted **user** message ID in the tool's task-filter field (named `message_id` in opencode-vm), not an assistant report ID.
2. Inspect observation source/time, session activity, recorded tools and coverage. A fresh snapshot can contain old stored tool states; it is not process-liveness evidence by itself.
3. Describe tool name, recorded state, start/end time and backend-provided task binding. Show parallel tools individually when relevant. Do not infer a missing parent from time proximity or the last user message.
4. A recorded `pending` tool may have no start timestamp. `completed` means its invocation ended, not that a shell command exited successfully or the user's objective passed. Raw result/error contents are outside this metadata view.
5. The last finished step is only the latest known finished tool in the inspected window. The latest recorded activity timestamp is not necessarily the time of this read or a heartbeat.
6. Respect `coverage`: a bounded message window, capped tool list, missing metadata and unattributed tools limit the observation. An empty list is not proof of idle or of no historical tool work.
7. Session-wide pending-input counts do not establish that the selected task is blocked. Refer to first-party UI when applicable; do not answer permissions through an invented tool.
8. If idle is reported alongside recorded pending/running tools, state that mismatch rather than claiming execution continues. Reconcile with exact task status or the report.

In the current opencode-vm contract, the snapshot examines the newest 100 messages and returns at most ten in-flight tools plus the last known finished tool. Timestamps are Unix milliseconds; `observed_at` is an ISO observation time. These are contract examples, not universal limits to impose on other connectors.

Example wording: "The snapshot records a shell tool as running since the reported start time. The session is busy. This view does not reveal which operations the shell script contains."

Do not request titles, arguments, raw shell output or hidden reasoning just to make a progress sentence more detailed. Do not generate percentages, task-stage names or success claims without explicit evidence.

## Continue an existing activity stream

Keep a separate cursor per **connector/project + filter_key** when returned, otherwise per exact session/event-filter combination. A page size is not a separate consumer, but changing the selected sessions/event types is.

- Restore that filter's own cursor when returning to it.
- Use `after_cursor` with the same filters; ordinary `has_more=true` means continue, even if a page has no events.
- Keep returned cursors opaque. A global cursor can advance over records excluded by the current filter; that does not mean those records were reviewed under another filter.
- Current exposure rules still apply. Never use an old event reference to bypass session/project restrictions.

## Enter at the latest matching events

If no suitable saved cursor exists and the user wants a **current overview**, use `get_project_activity` with `tail:true` if supported. Omit `after_cursor` on that initial request.

In opencode-vm:

- Tail selects the newest matching retained events and returns them oldest-to-newest.
- `next_cursor` is the captured global journal head. Save it under `filter_key` and continue using ordinary reads or bounded waits **without tail**, with identical filters.
- A complete tail selection does not acknowledge or reconstruct older history. `tail.earlier_events_not_examined` and collector tracking are separate from the selected window.
- `tail.selection_complete=false` means the scan budget limited selection. Report the partial overview. A smaller tail limit may complete; use ordinary history reads from the retained beginning when older events matter.
- Tail's `has_more=false` is not proof that all past events were consumed. Do not repeatedly call tail while describing the result as uninterrupted incremental monitoring.

If the user wants all retained developments rather than a recent sample, use their saved forward cursor or start the ordinary journal from its documented beginning. Do not silently replace that task with tail.

## Gaps, results and legacy fallback

`CURSOR_EXPIRED`, disconnected collection, partial reconciliation and retention limits must remain visible. Rebuild current understanding from session status and exact task/message evidence. A recovered healthy collector cannot prove that transient past events were captured.

An idle event does not by itself establish a new result. Use correlated completion IDs to locate the original report, and keep read/discussion coverage separate from the journal cursor.

When progress or tail is absent, use the available compact status and journal/history paths. Empty tool-call messages establish activity only, not the tool's action or success. State the missing capability; do not invent an API or request a new agent summary merely to conceal an observation limit.

Use short waits only during active interaction and within the discovered timeout limit. No continuous background monitoring, future dispatch or unsolicited notification is implied by this skill.
