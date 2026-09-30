# opencode-vm MCP interface contract

This document defines the incoming MCP interface exposed by `opencode-vm web` sessions (enabled by default since 0.5.61) and by terminal `start` sessions with a project-specific OpenAI MCP assignment (since 0.5.62). It describes the server side that external MCP clients use. It is separate from `opencode-vm mcps`, which configures MCP servers that OpenCode consumes as tools.

The implemented adapter is version **0.1.14**, uses `@modelcontextprotocol/sdk` **1.30.1** and `@opencode-ai/sdk` **1.18.21**, and was tested with MCP protocol revision **2025-11-25**. It uses stateless Streamable HTTP with JSON responses. The adapter does not perform semantic duplicate/task detection for normal conversation continuation. An old unresolved receipt remains available as per-request status, but does not block a new prompt when backend activity and pending input permit it. Only current backend activity, pending input, an in-flight MCP write, or an exact immediate retry of an uncertain transport request can reject `send_message`. See [admission diagnostics](../PLAN_MCP_ADMISSION.md).

## 1. Runtime model

One MCP endpoint represents one running project and its existing server-backed OpenCode runtime:

```text
external MCP client
        |
http://127.0.0.1:<port>/mcp
        |
MCP adapter in the project VM
        |
existing OpenCode server and sessions
```

The adapter does not start a second OpenCode process, create an MCP manager session, or maintain a separate conversation database. Web UI, TUI, A2A, OpenLive, and MCP therefore observe the same OpenCode sessions and workspace. Adapter 0.1.2 adds a bounded persistent activity journal containing state/identifier metadata, separate from conversation history.

The endpoint is enabled by default for new web sessions:

```bash
opencode-vm web
opencode-vm web --mcp-port 40960
opencode-vm web --no-mcp
```

Automatic fresh starts reserve a free port from `40960..41059`, starting at `40960`, including reservations by concurrent launches. Web `--mcp-port` selects a fixed port and enables MCP; an occupied explicit port fails. Reconnect preserves its port and re-evaluates the current project assignment. `--no-mcp` suppresses MCP/tunnel for this invocation only and conflicts with both `--mcp` and `--mcp-port`. Normal web starts enable local MCP; normal terminal starts do so when a project connection is registered. The terminal UI attaches to one loopback OpenCode `serve` backend shared with MCP, without web/A2A LAN forwards.

## 2. HTTP transport

| Path | Method | Authentication | Purpose |
|---|---|---|---|
| `/mcp` | POST | required | Stateless Streamable HTTP JSON-RPC |
| `/healthz` | GET | required | Project- and generation-bound readiness probe |

The MCP transport does not issue `Mcp-Session-Id`. A fresh MCP server and transport handle each POST, so standalone GET streams and DELETE-based session termination are not supported. `/mcp` returns `405` for methods other than POST.

Every request must include:

```text
X-OCVM-MCP-Token: <contents of the printed credential file>
```

HTTP boundary rules:

| Condition | Result |
|---|---|
| Missing or wrong token | HTTP 401 |
| Invalid `Host` or `Origin` | HTTP 403 |
| Unknown path, query string, or route | HTTP 404 |
| Wrong method | HTTP 405 |
| Request body over 256 KiB | HTTP 413 |
| Non-JSON content type | HTTP 415 |
| Malformed JSON | HTTP 400 |
| JSON-RPC ID over 1024 serialized UTF-8 bytes | HTTP 400, without reflecting the oversized ID |
| More than 16 concurrent HTTP requests | HTTP 503 with `Retry-After: 1` |

`Host` must be `127.0.0.1:<port>` or `localhost:<port>`. `Origin` may be absent; when present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. The adapter does not enable permissive browser CORS.

An authenticated `GET /healthz` returns the project hash and basename, controller generation, adapter version, transport, and preferred MCP revision. It does not return the absolute project path or either backend credential.

## 3. Project and session confinement

The runtime descriptor fixes one canonical project directory, and the adapter resolves one OpenCode project ID at startup. Every direct session operation repeats the same ownership checks used by listing.

Only sessions meeting all of these conditions are exposed:

- The OpenCode project ID matches the configured project.
- The session directory exactly matches the configured canonical directory.
- The session is a root session with no `parentID`.
- The session is not archived (unless an ID-based stored-content read explicitly supplies `include_archived:true`).
- The session agent is not `openlive-manager`.
- The session is not the manager session named by OpenLive's manager descriptor.

Absent, foreign-project, foreign-directory, child, manager and default-read archived sessions all return the same `SESSION_NOT_FOUND` tool error. Explicitly opted-in archived reads still enforce project, directory, root and manager checks. Normal lists, runtime changes, submissions, progress/status and activity exclude archived sessions.

The public project identity is:

```json
{"id":"<opencode-vm project hash>","name":"<project basename>"}
```

Absolute workspace paths and OpenCode's internal project ID are never returned.

## 4. Tool contract

All input schemas are strict: unknown fields are rejected. Every successful call returns both concise text in `content` and the JSON object below in `structuredContent`.

The established structured-result representation is retained deliberately: the official SDK client and local tunnel-control-plane test can see the complete data without duplicating large pages in a second JSON text block. MCP 2025-11-25 recommends that duplication for backward compatibility (SHOULD); clients that only consume text blocks are not yet accepted for these reads. Real ChatGPT visibility must be checked separately. Any future text fallback must fit the same total response budget.

Session IDs, message IDs, and `before` values must contain 1 to 256 non-whitespace, non-control characters. The cursor has its separate base64url constraint below.

### `list_sessions`

Read-only, idempotent, closed-world tool.

Input:

```json
{"limit":10,"cursor":"<opaque optional cursor>"}
```

- `limit`: integer `1..20`, default `10`.
- `cursor`: optional opaque base64url cursor, maximum 1024 characters. Clients must not construct or edit it.

Output:

```json
{
  "project":{"id":"abc123","name":"my-project"},
  "sessions":[{
    "id":"ses_...",
    "title":"Work session",
    "created":1,
    "updated":2,
    "activity":"idle"
  }],
  "next_cursor":"<opaque optional cursor>",
  "truncated":false
}
```

Activity is `idle`, `busy`, or `retry`. Titles are capped at 160 characters. The adapter requests backend pages of 20 in descending update order and scans at most ten pages for one response. `truncated` and `next_cursor` indicate that the client should continue.

### `create_session`

Added in adapter 0.1.1 / opencode-vm 0.5.65. Write-capable, additive (non-destructive), non-idempotent, closed-world tool.

Input:

```json
{"title":"Investigate the import error"}
```

`title` is optional; omitted titles become `MCP Work Session`. Supplied titles are trimmed and must contain 1–160 characters without control characters. No directory, parent session, agent, model, permission, or workspace overrides are accepted.

Output:

```json
{
  "project":{"id":"abc123","name":"my-project"},
  "session_id":"ses_...",
  "title":"Investigate the import error",
  "agent":"build",
  "provider_id":"openai",
  "model_id":"configured-model",
  "variant":"default",
  "state":"created"
}
```

The tool creates one **empty root work session** in the endpoint's fixed project. It does not submit a prompt. Use the returned `session_id` with `send_message` to start work; the normal status/history tools then apply. The session uses the same server and persisted history as Web UI/TUI.

Creation binds usable defaults because OpenCode's bare session-create API does not persist agent/model settings automatically:

1. Use the configured `default_agent`, or otherwise the visible `build` primary agent, falling back to the first visible primary/all-mode agent. Hidden agents, subagents and `openlive-manager` are excluded. An explicitly configured but unavailable default agent fails before creation.
2. Prefer that agent's configured model, then the project's configured `model` (`provider/model`, preserving slashes in the model ID). If neither is specified, use the first connected provider with a valid backend-reported default model. Explicitly configured unavailable models fail rather than silently switching providers.
3. Preserve the agent's variant when supplied. The result reports the variant persisted by OpenCode, which may normalize an unspecified variant to `default`; it is omitted if absent.

The adapter calls the scoped create endpoint once, then verifies the returned session through the same project/root/manager checks as other tools and checks its persisted agent/model. It does not override the project's permission rules. Creation/default lookup failures before submission use normal backend errors. A timeout, connection failure or unverifiable result after submission returns **`CREATION_UNCERTAIN`**: the session may already exist. Inspect `list_sessions` or Web UI before manually deciding what to do; **never retry automatically**. The adapter does not delete or replay uncertain creations.

The 0.1.2 review additionally validates the default variant and native model disabling. OpenCode bridges custom providers lazily into its v2 catalog: connected legacy catalog entries remain usable before that bridge exists, while an existing native entry's enabled flag and variants take precedence.

### `rename_session`

Added in adapter 0.1.14 / opencode-vm 0.5.96. Write-capable, non-destructive and idempotent: repeating the same title is valid. It updates the title on the existing OpenCode session; there is no adapter-side alias or parallel title store.

```json
{"session_id":"ses_...","title":"Reviewed session name"}
```

`session_id` follows the normal session-ID validation. `title` must contain 1–160 characters, cannot be empty/whitespace-only, and cannot contain control characters; leading and trailing whitespace is trimmed before saving.

Successful result:

```json
{"session_id":"ses_...","title":"Reviewed session name","state":"renamed"}
```

The adapter calls OpenCode's native `PATCH /session/{sessionID}` `session.update` operation with only `title`, then reads the session back by ID and verifies the exact title. The same MCP per-session write lock as other session writes is used. Active sessions return `SESSION_BUSY`; pending permissions/questions return `INPUT_REQUIRED`. Archived, unknown and otherwise unexposed IDs return `SESSION_NOT_FOUND`; archived sessions are not renameable through MCP. If the native update may have applied but its title cannot be verified, the adapter returns `RENAME_UNCERTAIN`; inspect `get_session` before deciding whether to try again. Other OpenCode clients do not share the adapter lock, so there is no cross-client compare-and-swap. Renaming does not change the session ID, messages/history, runtime or archive state.

### `archive_session`

Added in adapter 0.1.7. Write-capable and non-idempotent from the MCP client's perspective; use only on the user's explicit request. Generic to eligible project root work sessions, not specific to `[KLÄRUNG]` titles.

```json
{"session_id":"ses_..."}
```

After the same session exposure, per-session MCP write lock, idle, pending-input and unresolved-receipt checks as `send_message`, the adapter updates OpenCode's archive timestamp without deleting history. A successful result contains `{"session_id":"ses_...","state":"archived","archived_at":1790520000000}` only after an exact by-ID backend readback verifies the timestamp. An archive request that might have applied but cannot be verified returns `ARCHIVE_UNCERTAIN`: inspect with an opted-in archived `get_session` before another deliberate attempt, never blindly retry. Already archived sessions are not accepted by this tool. Other OpenCode clients are not locked by the MCP per-session lock; there is no cross-client archive transaction. The archived session leaves normal MCP lists and default reads, but retains history for explicit by-ID reads below.

### `get_session`

Read-only, idempotent, closed-world tool.

Input:

```json
{"session_id":"ses_..."}
```

Output:

```json
{
  "id":"ses_...",
  "title":"Work session",
  "created":1,
  "updated":2,
  "activity":"idle",
  "agent":"build",
  "provider_id":"provider",
  "model_id":"model",
  "variant":"high",
  "pending_input":{"permissions":0,"questions":0}
}
```

Agent, provider, model, and variant are omitted when unavailable. Pending input is counted but its private payload is not returned.

Since 0.1.7, `get_session` accepts optional `include_archived:true` for a known, archived project-root session ID. Its result adds `archived_at` (Unix milliseconds) when archived. No other read tool silently enables archived access, and archived IDs are absent from `list_sessions`.

Since 0.1.6, `get_session` and `get_session_status` also return `admission:{write_in_progress,guarded_message_id?}`. `write_in_progress` is an MCP-local submission/runtime-write lock, distinct from backend activity. `guarded_message_id` identifies an earlier MCP receipt awaiting terminal reconciliation; it is not a receipt for a rejected new request and does not itself prove execution is running. Thus `activity:idle` alongside admission tracking can be legitimate.

### `get_session_status`

Read-only, idempotent, closed-world tool.

Input:

```json
{"session_id":"ses_...","message_id":"msg_..."}
```

`message_id` is optional. Without it, the result reports session-wide backend activity and pending input, but cannot identify completion of a particular turn.

Since 0.1.3, results also include `observed_at` (ISO observation time) and `source:"backend"`. Without a message ID, `task_status_reason:"not_requested"` explains that the legacy `state` is session-wide, not proof of a requested task starting. A correlated `unknown` includes `outside_history_or_not_observed` or `non_terminal_evidence`. Backend request failures remain errors, not fabricated task states.

Output:

```json
{
  "session_id":"ses_...",
  "message_id":"msg_...",
  "backend_activity":"idle",
  "state":"completed",
  "pending_input":{"permissions":0,"questions":0},
  "assistant_message_ids":["msg_..."]
}
```

`state` is one of:

| State | Meaning |
|---|---|
| `unknown` | The receipt is not visible in the bounded history, or available evidence is not terminal. |
| `submitted` | The user message is visible and no correlated assistant message is visible yet. |
| `running` | The backend is busy/retrying and a correlated assistant lacks completion or records pending/running tools. Session busy alone is insufficient. |
| `input_required` | For a requested task, a permission/question is explicitly linked to a correlated assistant; without a message ID this remains a session-wide status. Continue in Web UI/TUI. |
| `completed` | Correlated assistant messages are complete and at least one ends with `stop`, `length`, or `content-filter`. |
| `failed` | A correlated assistant message carries a non-abort error. |
| `aborted` | A correlated assistant message was aborted. |

Correlation uses the submitted user `message_id` and assistant `parentID`. `tool-calls`, `unknown`, and unrecognized future finish values are non-terminal; `error` is failed. An earlier tool-call iteration does not prevent a later terminal assistant message from completing the turn. Status reads at most 100 backend messages. If the user message or required terminal evidence is outside that bound, the state is `unknown`, not guessed.

Use `get_task_result` to search beyond that bound. A question/permission explicitly linked to this turn remains actionable, but session-wide or later-turn pending input no longer overrides this turn's terminal evidence. `completed` describes execution evidence, not how much text the caller has read. `length` and `content-filter` are terminal generation reasons, not proof of a regularly finished report.

Adapter 0.1.6 additionally returns `active_assistant_message_ids` when correlation is available: stored correlated assistants without completion timestamps or with pending/running tool parts. This is observation evidence, not independent process-liveness verification. An older turn consisting only of completed `tool-calls` iterations stays `unknown/non_terminal_evidence` even if another operation makes the session busy. A receipt with no correlated assistant remains `submitted`, including while the backend is busy. Conversely, text generation may have an unfinished assistant and no active tool, so an empty progress tool list does not prove inactivity. `pending_input_scope:"session"` explicitly qualifies the counts; unrelated/unattributed input does not become that older task's `input_required` state. The observations are not a cross-endpoint transactional snapshot.

### `get_session_progress`

Added in adapter 0.1.4 / opencode-vm 0.5.68. Read-only, idempotent, closed-world. A compact observation of stored tool metadata, with no model execution or new event subscription:

```json
{"session_id":"ses_...","message_id":"msg_user_optional"}
```

Omit `message_id` to inspect the session's recent tools. If supplied, it must identify a visible stored **user** message in this session; only assistant tools whose backend `parentID` matches that ID are selected. No latest-user/time-proximity guess is made.

```json
{
  "session_id":"ses_...",
  "message_id":"msg_user",
  "observed_at":"2026-09-27T12:00:00.000Z",
  "source":"backend_snapshot",
  "backend_activity":"busy",
  "pending_input":{"permissions":0,"questions":0},
  "pending_input_scope":"session",
  "in_flight_tools":[{
    "message_id":"msg_assistant",
    "call_id":"call_...",
    "tool":"bash",
    "task_message_id":"msg_user",
    "status":"running",
    "started_at":1790510399000
  }],
  "last_activity_at":1790510399000,
  "idle_with_in_flight_tools":false,
  "coverage":{
    "message_limit":100,"messages_scanned":12,"history_has_more":false,
    "in_flight_total":1,"in_flight_truncated":false,
    "metadata_incomplete":false,"unattributed_tools":0
  }
}
```

- The observation examines at most the newest **100 messages**, not the whole historical task. An old requested user can be directly verified even when its tool steps are outside this window. An empty result does not prove that no tool exists or that the task is idle; inspect `coverage.history_has_more`.
- `in_flight_tools` contains up to **ten** tools recorded as `pending` or `running`, ordered by descending known start time, then call ID; entries without a start time follow timed entries. Parallel tools are represented individually. `in_flight_total` counts matching valid entries in the inspected window, and `in_flight_truncated` marks the ten-entry cap.
- Optional `last_finished_tool` has the same shape with status `completed` or `error` and, where available, `started_at`/`finished_at`. It selects the greatest recorded finish timestamp within the selected window, using the later encountered part for ties. It is not necessarily the last tool in the entire session.
- Tool times and `last_activity_at` are Unix **milliseconds**. The latter is the greatest known selected message create/complete or tool start/end time in this read, not a heartbeat or a claim that progress just occurred. It is omitted when the selected window has no known activity time. `observed_at` is the read completion time.
- `completed` means the backend finished that tool invocation. It is **not** a shell exit-code check or proof of task success. `error` is the backend's tool error state; its raw error string remains private. Use task status/results for execution completion and the original report for substantive conclusions.
- Only message/call/tool/parent identifiers, enum states and timestamps are selected. No titles, descriptions, arguments, output, raw metadata, paths from arguments/results, artifact bodies or reasoning are returned. Missing/unsupported identifiers, states or expected times set `metadata_incomplete`; invalid entries/times are not fabricated. `unattributed_tools` counts tool parts in the inspected session window with no usable parent ID. Session-wide reads can show their metadata without `task_message_id`; task-filtered reads exclude them.
- These are non-transactional backend snapshots, not process-liveness checks. `idle_with_in_flight_tools` explicitly notes session idle alongside stored pending/running entries; do not silently turn that combination into a running task. Pending-input counts are always **session-wide**, even on task-filtered reads, and do not establish that the requested task is blocked. Resolve input through first-party UI as before.
- The same project/session checks and 64-KiB serialized result budget as Delivery A apply. Backend failures return errors rather than a cached success. No percentages or automatically generated semantic checkpoints are inferred.

### `get_session_history`

Read-only, idempotent, closed-world tool.

Input:

```json
{"session_id":"ses_...","limit":10,"before":"msg_..."}
```

- `limit`: integer `1..20`, default `10`.
- `before`: optional opaque backend pagination cursor returned as `next_before`. Clients must not construct or edit it.

Output:

```json
{
  "session_id":"ses_...",
  "messages":[{
    "id":"msg_...",
    "role":"assistant",
    "parent_id":"msg_...",
    "text":"Answer text",
    "created":1,
    "completed":2,
    "finish":"stop",
    "error":"failed",
    "text_truncated":false
  }],
  "next_before":"msg_...",
  "truncated":false
}
```

Only user and assistant messages are returned. The adapter includes non-synthetic, non-ignored text parts and excludes attachments, reasoning, system messages, and raw tool inputs or outputs. `completed`, `finish`, `error`, `parent_id`, and `next_before` are omitted when not applicable.

Since 0.1.7, `get_session_history`, `get_message` and `get_task_result` accept optional `include_archived:true` for a known archived session ID. Keep the same value on history or result-search continuations; result cursors reject a mode switch. A `content_ref` issued by an opted-in read binds that read mode and can be followed through `read_message_content` without a new argument. Every page/reference rechecks exact project/root/manager visibility and the original content revision. Existing references issued without opt-in do not become archive-readable after archival. The backend may still change archived content out of band; the ordinary revision/search-change safeguards apply. No archived-session browse/restore, write, progress or activity API is added.

**Delivery A migration (0.1.3):** text is now a preview of at most 1024 UTF-8 bytes per message, possibly smaller to preserve metadata within the response budget. The old shared 32,000-JavaScript-code-unit clipping is replaced by the complete reading path below. Existing fields remain: `truncated` still means more history **or** any shortened preview. New clients should instead use:

- `history_has_more`: another backend history page exists; follow `next_before`.
- Per-message `content_complete`: this preview contains all selected visible text. It does not mean all backend parts were exposed.
- `text_truncated` with `truncation_reason:"preview_limit"|"response_budget"`: the preview is shorter; read the message's `content.content_ref`.
- `content.availability` and `content.omitted_parts`: distinguish empty visible text and excluded parts.

Every returned message includes the content descriptor defined under `get_message`, even when the response budget leaves its preview empty. Metadata takes precedence over previews. A page may contain fewer than `limit` entries if metadata itself requires a smaller backend page; the resulting `next_before` still resumes correctly.

### `get_message`

Read-only, idempotent, closed-world. Directly reads a known message, without scanning history or starting model work:

```json
{"session_id":"ses_...","message_id":"msg_..."}
```

Returns `session_id` and `message`. The message contains the same identity, role, parent, time, finish/error and preview fields as history, plus:

```json
{
  "content_complete":false,
  "text_truncated":true,
  "truncation_reason":"preview_limit",
  "content":{
    "content_ref":"<opaque authenticated reference>",
    "revision":"visible-text-v1:<sha256>",
    "unit":"utf8_bytes",
    "total_bytes":320036,
    "sha256":"<hash of the complete selected visible text>",
    "availability":"available",
    "omitted_parts":[{"type":"tool","count":1,"reason":"part_not_exposed"}]
  }
}
```

Projection `visible-text-v1` concatenates selected text parts in backend order, with **no inserted separators or normalization**. The exact same projection is used in previews and content reads. Invalid Unicode source text fails explicitly rather than being silently repaired. Availability is `available` for nonempty selected text, `empty` for empty text/no parts, or `not_exposed` when only excluded parts exist. Omitted categories are `text` (synthetic/ignored), `reasoning`, `tool`, `file`, and `other`; only type/count/reason are disclosed. No heuristic secret redactor or raw-tool-output export is introduced.

The hash covers only the deliverable visible UTF-8 text, including the empty string when applicable. It neither hashes hidden parts nor proves that the model finished its intended report. Inspect the preserved `finish`/`error` separately. Absence, unknown source loss and actual backend failures are not inferred from a short string or empty part list.

### `read_message_content`

Read-only, idempotent, closed-world:

```json
{"content_ref":"<reference>","cursor":"<optional next_cursor>","max_bytes":8192}
```

`max_bytes` is an integer `4..16384`, default `8192`. It bounds unescaped UTF-8 text, **not** JSON wire size; the server may return less. Four bytes permit any Unicode scalar value without a stalled page. Responses include:

```json
{
  "session_id":"ses_...",
  "message_id":"msg_...",
  "revision":"visible-text-v1:<sha256>",
  "unit":"utf8_bytes",
  "total_bytes":320036,
  "sha256":"<complete visible-text hash>",
  "range":{"start":0,"end":8192},
  "text":"<original text page>",
  "has_more":true,
  "next_cursor":"<opaque content cursor>",
  "content_complete":false
}
```

Ranges are byte offsets into the unescaped UTF-8 projection, start inclusive/end exclusive, always on code-point boundaries. Keep the same `content_ref`, append text without separators, and follow `next_cursor` until `has_more:false` (no next cursor). Verify contiguous ranges, total byte length and SHA-256 programmatically. `content_complete` is true only when **this response alone** contains the entire projection (`start=0`, `end=total_bytes`); it is not a caller read receipt. An empty projection returns `[0,0)`, no continuation and its empty-text hash, while `get_message` retains the explanation of omitted parts.

References and cursors are authenticated, scope-bound, opaque strings up to 16384 characters. They are valid only for the current adapter process lifetime, not indefinitely persisted capability URLs. Every call rechecks current session exposure. They accept no filesystem paths. On adapter restart, reacquire a reference through `get_message` using stable session/message IDs. A cursor cannot be used with a different message/revision reference.

There is no historical snapshot store. Every page rereads the source; a changed visible projection yields `CONTENT_CHANGED` and requires a new `get_message` and restart of concatenation. A previously referenced message that disappears yields `CONTENT_UNAVAILABLE`; excluded sessions still yield non-disclosing `SESSION_NOT_FOUND`. A backend timeout is `BACKEND_UNAVAILABLE`, not proof of source loss. Permanently growing messages need not be fully traversable until stable.

**Budgets:** These tools, history and task-result reads allow at most 48 KiB of serialized structured payload and 64 KiB for the complete JSON-RPC result response, including `content`, `structuredContent`, escaping and the envelope. Preview shrinking/page reduction and content-page shrinking preserve references and continuation. A metadata-only result that cannot fit fails with `RESPONSE_BUDGET_EXCEEDED`; it is never sliced into invalid JSON. These limits do not assert a universal ChatGPT/context limit. Lower `max_bytes` if needed for a tested client.

### `get_task_result`

Read-only, idempotent, closed-world; an ordinary MCP tool, not native MCP task execution:

```json
{"session_id":"ses_...","submitted_message_id":"msg_user","cursor":"<optional next_cursor>","limit":20}
```

The user message is read directly and validated. The adapter scans backward in bounded backend pages (`limit:1..20`, default `20`), selecting assistants solely by the existing `parentID`. It stops when it reaches the requested user message. No permanent result index or model summary is created.

Returns `session_id`, `submitted_message_id`, `observed_at`, `source:"backend"`, `state`, `search_complete`, optional `next_cursor`, optional `superseded_by_message_id`, `order:"newest_first"`, and `messages`. Each message includes the same content descriptor as `get_message` plus `result_kind:"terminal"|"intermediate"`. Terminal denotes a recognized terminal finish/error/abort; tool-call iterations are intermediate. Multiple terminal constituents are retained, and terminal metadata can legitimately have no visible report text.

**Keep results from every page, in returned newest-first order.** Follow `next_cursor` even for an empty page. Reverse the accumulated list if chronological presentation is desired. Until `search_complete:true`, state is `unknown` with `state_reason:"search_incomplete"`; this is not absence. Complete scans report `completed`, `failed` or `aborted` only from correlated evidence. Otherwise state stays `unknown` with `non_terminal_evidence` or `no_terminal_evidence`. Session busy or another task's pending input is not used to guess an older task's state; use `get_session_status` for current live work. Terminal deep reads reconcile the same MCP unresolved-admission guard as status reads, allowing a subsequent explicit prompt after a long turn.

Adapter 0.1.11 may additionally return `superseded_by_message_id` with `state_reason:"superseded_by_later_completed_turn"`. This does **not** change the requested older task's state from `unknown`, and its own nonterminal/intermediate results remain unchanged. It means the complete search observed a later user turn as the newest user message, and the newest assistant message is explicitly parented to that user, completed, `finish:"stop"`, and error/abort-free. The process-local admission guard for the older receipt may then be retired, but only after current backend idle/pending-input checks are repeated. A later message submission alone, an older later terminal task followed by a newer unanswered user, or journal `message.running`/`message.completed` without this history correlation does not supersede a guard. This prevents an old stale receipt from blocking indefinitely without treating the old task as completed or clearing a genuinely unresolved latest turn.

Search cursors carry only bounded progress/evidence metadata and are authenticated to the session/user query. The adapter verifies the observed session update stamp, requested user projection and newest-message projection before and after each page and again on continuation. An observed change yields `SEARCH_CHANGED`; restart without a cursor and discard the old search-page accumulation. This is an optimistic observation boundary, **not a backend transactional snapshot or archival guarantee**. It relies on backend history ordering/update metadata and cannot detect arbitrary out-of-band database edits that bypass that metadata. Content references independently verify visible-text revisions at read time. Failure to reach a directly readable user through backend pagination is an explicit compatibility failure, not a false empty result.

For stale-guard reconciliation, the authenticated cursor additionally carries only the newest later user/assistant IDs and the terminal predicate. No message text, prompt or result payload is added to the cursor.

Recommended workflow: poll the receipt's status; obtain `get_task_result` pages through `search_complete`; read terminal message references via `read_message_content` (or reacquire with `get_message`). Finding, completing execution and reading are separate. None of these tools marks a report read/discussed or submits a new prompt.

### `upload_attachment`

Write-capable, non-idempotent temporary upload; it does not create an OpenCode message or start model work.

Input:

```json
{
  "session_id":"ses_...",
  "filename":"launcher-mockup.png",
  "mime_type":"image/png",
  "data_base64":"<canonical Base64 bytes>"
}
```

The upload tool accepts raw Base64 bytes rather than a filesystem path. It returns an opaque `attachment_id`, the safe filename, validated MIME type, byte size, SHA-256 and expiry:

```json
{
  "attachment_id":"att_<32 lowercase hex characters>",
  "filename":"launcher-mockup.png",
  "mime_type":"image/png",
  "size_bytes":12345,
  "sha256":"<64 lowercase hex characters>",
  "expires_at":"2026-09-28T12:10:00.000Z"
}
```

Supported MIME types are `image/png`, `image/jpeg`, `image/webp`, `text/plain` and `text/markdown`. Image files are limited to 5 MiB each; text files to 512 KiB each. One message accepts at most four attachments and 10 MiB total. The adapter keeps at most 32 staged attachments / 20 MiB across the running connector. The authenticated MCP JSON request limit is 8 MiB, sufficient for one maximum-sized encoded image.

The adapter validates canonical Base64, rejects path separators/control characters in `filename`, checks image signatures and strict UTF-8 for text, and verifies the declared MIME against the bytes. Unsupported or mismatched types return `UNSUPPORTED_MEDIA_TYPE`; size and quota failures return `ATTACHMENT_TOO_LARGE`; unsafe names return `INVALID_ATTACHMENT_REFERENCE`. PDFs and other binary types are not accepted in this phase.

References are bound to the supplied exposed session and current adapter process. They expire after ten minutes, are removed on expiry or connector shutdown, and are consumed immediately before a prompt may be admitted. Before submission, bytes remain in adapter memory only; no client path is opened and no upload file is written to host/project storage. On admission, OpenCode stores the resulting file part in that user message's normal session history. Its retention follows OpenCode's session-data lifecycle; one-use consumption does not erase the message history. A reference from another session returns `ATTACHMENT_ACCESS_DENIED`; missing, expired or already-consumed IDs return `ATTACHMENT_NOT_FOUND`. The returned SHA-256 and size identify the exact staged bytes.

### `send_message`

Write-capable, destructive, non-idempotent, open-world tool.

Input:

```json
{"session_id":"ses_...","message":"Continue with the requested task."}
```

`message` must contain `1..32000` characters.

Optional `attachments` is an array of up to four `attachment_id` values returned by `upload_attachment`; arbitrary paths, URLs and unissued IDs are rejected. For example:

```json
{
  "session_id":"ses_...",
  "message":"Use this mockup as a visual reference for the launcher.",
  "attachments":["att_0123456789abcdef0123456789abcdef"]
}
```

Output:

```json
{"session_id":"ses_...","message_id":"msg_<32 hex characters>","state":"submitted"}
```

When attachments are supplied, the receipt additionally returns their IDs, filenames, MIME types, sizes and SHA-256 values:

```json
{
  "session_id":"ses_...",
  "message_id":"msg_<32 hex characters>",
  "state":"submitted",
  "attachments":[{
    "attachment_id":"att_0123456789abcdef0123456789abcdef",
    "filename":"launcher-mockup.png",
    "mime_type":"image/png",
    "size_bytes":12345,
    "sha256":"<64 lowercase hex characters>"
  }]
}
```

The generated `message_id` binds those accepted OpenCode file/text parts to the submitted message; receipts without attachments keep the existing shape.

This is an asynchronous admission receipt, not a completion result. The prompt may run commands and modify project files inside the VM. Poll `get_session_status` with the returned `message_id`, then retrieve correlated results with `get_task_result` and originals with `read_message_content`. History remains a preview/navigation surface.

The adapter preserves the session's agent, provider/model, and variant. If current session metadata lacks those settings, it uses the latest user-message settings from a bounded 20-message lookup; otherwise it returns `BACKEND_INCOMPATIBLE`. Text and Markdown are passed as labeled UTF-8 text parts, not opaque binary blobs. Images are passed to OpenCode as actual file parts with `data:` URLs and are visible to the model as image inputs. Before submission the adapter checks OpenCode's active model `capabilities.input` for `image`; when image support is absent or unconfirmed, it returns `MODEL_DOES_NOT_SUPPORT_ATTACHMENT_TYPE` without sending the prompt or consuming the staged reference. A model/provider can still impose stricter format, size or dimension limits after this check.

Since 0.1.2, receipts also include `submitted_at` (ISO timestamp of the submission attempt) and, with initialized collection, `activity_cursor`. That cursor is the journal position **before** submission, so an exclusive `after_cursor` read includes this request's submitted/running/completion events and any concurrent project activity. The original three fields and no-retry semantics remain unchanged. `client_request_id` is not implemented in this baseline.

`SESSION_BUSY`, `SUBMISSION_UNRESOLVED` and `SUBMISSION_UNCERTAIN` retain their existing admission behavior. References are consumed once an OpenCode prompt may have been admitted, including an uncertain response; do not retry that prompt automatically. A model-capability rejection occurs before admission and leaves the staged references available until expiry.

### `supersede_unresolved_submission`

Added in adapter 0.1.11. This is an explicit write-capable operator escape hatch, not a `force` switch on ordinary submission. It combines superseding the exact unresolved guard and submitting the user's intended new message in one audited operation:

```json
{
  "session_id":"ses_...",
  "guarded_message_id":"msg_old_receipt",
  "request_id":"<client-generated UUID>",
  "operator_authorized":true,
  "reason":"Reviewed this exact unresolved receipt; continue once.",
  "message":"The originally authorized next task."
}
```

`operator_authorized` must be the literal `true`. It records a fresh client attestation; it does not independently identify the human behind the already authenticated project MCP token. The client must first inspect the old receipt and obtain new, explicit user approval tied to the **currently observed** `guarded_message_id`. A prior general approval for the task or for ordinary sends is not sufficient. `reason` is optional, trimmed, limited to 500 characters and retained in the audit journal. `request_id` is a client-generated UUID used as the idempotency/correlation key; preserve it and the exact request on recovery. Optional attachments follow the same session-bound rules as `send_message`.

Before writing the audit record, the adapter rechecks that the supplied ID is still the exact active guard and runs ordinary terminal reconciliation once more. It also checks current backend activity, session-wide pending permissions/questions, correlated active assistant evidence and stored in-flight tool evidence. A terminally reconciled or changed guard returns `SUBMISSION_GUARD_CONFLICT`; active/backend-busy or pending-input states are refused. Idle alone never authorizes an override. OpenCode history is not edited and the old task is not marked completed: its task status remains `unknown` unless actual terminal evidence later appears, and `get_session_status` / `get_task_result` expose `receipt_resolution:{state:"unresolved",resolution:"superseded_by_operator",...}` separately.

The private activity journal records `submission.guard_overridden` with the session, old guard, new `message_id`, request UUID, timestamp, optional reason and `operator_authorized:true` / `authorization_source:"operator_asserted"`. The journal also stores a payload-free fingerprint and the new receipt for request replay; it never stores the prompt body. The write-ahead record is durable before the single `promptAsync` attempt. Repeating the exact request UUID returns the recorded admitted receipt, or `SUBMISSION_UNCERTAIN` with that same new message ID when admission could not be confirmed; it never makes another prompt attempt. Reusing the UUID with changed fields conflicts. Idempotency/audit records follow the journal's bounded 5,000-event retention.

The successful response includes the exact old/new IDs, `resolution`, `request_id`, timestamps, authorization source and the final preflight snapshot (`backend_activity`, active assistant IDs, in-flight tools, pending input, guarded receipt state, last activity and coverage). It is also the new prompt's admission receipt: **do not call `send_message` again for that same task**. Verify the returned new `message_id` with `get_session_status`. The per-session lock remains adapter-local; a different OpenCode client can race after the final snapshot, so the operation makes no cross-client transaction or universal exactly-once claim.

### `get_session_runtime_options`

Read-only. Input is `{}` or `{"session_id":"ses_..."}`. Returns live visible primary/all-mode work agents, connected providers, enabled models and their supported variant IDs:

```json
{
  "agents":["plan","build"],
  "providers":[{"provider_id":"provider","name":"Provider"}],
  "models":[{"provider_id":"provider","model_id":"model","name":"Model","variants":["default","medium","high"]}],
  "truncated":false,
  "current":{"agent":"plan","provider_id":"provider","model_id":"model","variant":"medium"}
}
```

`current` is included for a requested session. Unexposed session IDs fail as usual. Models use the live connected catalog plus native v2 enabled/variant metadata where available; absent native entries can be lazy custom-provider bridges. Raw provider credentials, endpoint URLs, agent prompts and variant request bodies are not returned. The default variant is represented by `default`. Output is capped at 2,000 model entries with `truncated`; internal update validation still uses the full catalog. Catalog pagination is a follow-up item.

### Project runtime profiles (read-only)

`get_project_model_policy({})` reads `<project>/.opencode-vm/agent-control.json` and returns `project_id`, `schema_version`, `revision`, `updated_at`, `catalog_status` (`complete|incomplete|unavailable`) and `profiles.deep|standard|execution`. Each profile has `selection` (`null` or `{provider_id,model_id,variant}`) and `status` (`available|unconfigured|provider_unavailable|model_unavailable|variant_unavailable|catalog_unavailable|catalog_incomplete`). Missing policy is virtual revision 0 with all profiles unconfigured; invalid/future schemas fail closed. Mappings are never replaced when availability changes.

`get_recommended_runtime({"profile":"deep"})` returns `{profile,policy_revision,status}` plus `runtime:{provider_id,model_id,variant}` **only** when the exact stored tuple is listed by a complete current catalog. Both calls are project-scoped and do not create sessions or change runtimes. The policy is transport-neutral; MCP is its first supported external-agent transport, A2A/OpenLive do not yet expose the profile capability. The existing `update_session_runtime` applies an available recommendation only to an idle session before a new authorized task; explicit user settings take precedence.

### `update_session_runtime`

Write-capable, non-idempotent. Input requires `session_id` and at least one of `agent`, `provider_id`, `model_id`, `variant`:

```json
{"session_id":"ses_...","agent":"build","provider_id":"provider","model_id":"model","variant":"high"}
```

Omitted fields keep their effective current values. Every resulting combination is checked against live runtime options, including a retained variant after switching models. Use `variant:"default"` to explicitly reset it. Setting strings must be nonempty, at most 256 characters, with no whitespace/control characters.

```json
{
  "session_id":"ses_...",
  "previous":{"agent":"plan","provider_id":"provider","model_id":"model","variant":"medium"},
  "current":{"agent":"build","provider_id":"provider","model_id":"model","variant":"high"},
  "state":"updated"
}
```

Busy/retrying sessions and concurrent writes are refused with `SESSION_BUSY`. A historical unresolved receipt alone does not block a technically idle session. Pending questions/permissions return `INPUT_REQUIRED`. Runtime updates and MCP submissions share the same per-session write lock and admission preflight. The adapter checks idle immediately before changes and between the backend's separate agent/model switches, then verifies the stored settings; subsequent `get_session` and `send_message` use those values.

OpenCode does not expose an atomic multi-field switch or cross-client compare-and-swap here. Web UI/TUI/other-client writes can race; a failed/uncertain write may leave a partial update and reports `RUNTIME_UPDATE_FAILED`, without rollback or retry. Inspect `get_session` before continuing. Older empty sessions without any reusable agent/model metadata report `UNSUPPORTED_CONFIGURATION`; initialize them in first-party UI or use `create_session`.

### `get_project_activity`

Read-only access to a persistent **project-wide observation journal**, not a status snapshot or task queue:

```json
{"after_cursor":"<previous next_cursor>","limit":50,"session_ids":["ses_A","ses_B"],"event_types":["message.completed","session.input_required"]}
```

- `after_cursor`: optional opaque cursor; do not construct/edit it.
- `limit`: 1–100, default 50.
- `session_ids`: optional 1–50 session IDs.
- `event_types`: optional nonempty array of supported types.
- `tail`: optional boolean, default false. `tail:true` is an initial recent-window read and cannot be combined with `after_cursor`.

```json
{
  "events":[{
    "event_id":"evt_<epoch>_123",
    "cursor":"<epoch>:0000000000000123",
    "timestamp":"2026-09-26T12:00:00.000Z",
    "session_id":"ses_A",
    "session_title":"Import investigation",
    "message_id":"msg_...",
    "type":"message.completed",
    "state":"completed",
    "assistant_message_ids":["msg_reply"],
    "source":"observed"
  }],
  "next_cursor":"<epoch>:0000000000000123",
  "has_more":false,
  "tracking":{"connected":true,"partial":false,"last_reconciled_at":"2026-09-26T12:00:00.000Z"}
}
```

Event types:

- `message.submitted`, `message.running`, `message.completed`, `message.failed`, `message.aborted`.
- `session.input_required`, `session.permission_required` (include `pending_input` counts).
- `session.idle`, `session.busy` (backend retry counts as busy).
- `session.runtime_changed` (includes previous/current runtime settings when known).
- `submission.guard_overridden` (explicit operator assertion; `message_id` is the new submission, while `guarded_message_id` is the older unresolved receipt; includes `request_id`, optional `reason`, `operator_authorized:true` and `authorization_source:"operator_asserted"`).

Session-only events may omit `message_id`; message events preserve the existing submitted user-message ID. Completion events contain correlated assistant IDs, not responses. For `submission.guard_overridden`, `message_id` names the newly requested message and `guarded_message_id` identifies the old receipt whose state was not rewritten. No prompts, answers, reasoning, permission details or raw tool inputs/outputs are journaled. Use `get_session_history` for text.

`timestamp` is the observation/recording time. `source` distinguishes recording during `mcp` receipts/updates, live `observed` events, and `reconciled` durable-state discoveries; it is not attribution to the frontend that originally started the work. Initial reconciliation can report already completed work; it does not claim the work happened at observation time. `get_session_status(session_id,message_id)` remains the source of truth for the **current** correlated state and shares its correlation logic with journal reconciliation.

Events are ordered by a persistent monotonic sequence within a journal epoch. Reads are exclusive of `after_cursor` and do not consume events for other clients. Keep `next_cursor`; when `has_more` is true, continue pagination, including an empty page. A one-second scan budget (plus the in-flight bounded backend check) prevents long backlogs of visibility checks from monopolizing one call. Filtering advances past skipped records; changing filters later does not replay records already skipped by that cursor. Omit the cursor to read from the earliest retained event. Current project/root/manager/archive checks are repeated before returning stored events, so excluded sessions cannot be retrieved from old journal entries.

**Delivery B — recent entry and independent filter progress:**

```json
{"tail":true,"limit":10,"session_ids":["ses_A"],"event_types":["message.completed"]}
```

Tail scans backward from a captured journal head to find the newest matching currently exposed events, then returns them in the usual **oldest-to-newest order**. `next_cursor` is that captured **global journal head**, not the last matching event. Events appended during the read remain reachable with a subsequent ordinary `after_cursor` read or wait. Continue **without `tail`** and with the same filters.

Tail responses add:

```json
{
  "filter_key":"activity-filter-v1:<sha256>",
  "tail":{"selection_complete":true,"earlier_events_not_examined":true},
  "has_more":false,
  "next_cursor":"<captured global head>"
}
```

`selection_complete:true` means the requested number of visible matches was found, or the retained snapshot was exhausted. If the scan budget is reached first, it is false and only the newest matches found so far are returned. `earlier_events_not_examined` says older retained entries remain unchecked; neither false nor a complete tail selection proves that evicted/downtime history was recovered. Tail's `has_more:false` refers to forward continuation through the captured head, **not complete past consumption**. To recover older retained events, start an ordinary read without a cursor/tail; to request a smaller current window after a budget-limited selection, repeat tail with a smaller limit. No historical read/discussion acknowledgement is made.

All activity reads and waits now return `filter_key`, a stable opaque key for the project plus sorted/deduplicated `session_ids` and `event_types`. Limit, tail and cursor are not part of this identity. Clients must store **one `next_cursor` per `filter_key`**. Switching to a previously used filter restores that filter's own cursor; a new filter starts its own history or tail read. The existing global cursors are unchanged and are not filter-bound authorization tokens: the server cannot detect a client incorrectly reusing another filter's cursor. No server-side consumer registry is introduced. Existing `CURSOR_EXPIRED`, tracking/coverage limits and visibility rechecks still apply.

### `wait_for_project_activity`

Same filters/output as ordinary `get_project_activity`, with required `after_cursor`, optional `timeout_ms` (1–15000, default 10000), and an additional `timeout` boolean. `tail` is not accepted on waits. Returns immediately if matching events are already present; otherwise waits briefly for journal changes. Normal backend visibility validation adds its usual request deadline to the waiting budget. On timeout, the empty response still has `next_cursor` and `filter_key`; retain it only for that filter. This is a bounded active wait, not delivery/push to an inactive ChatGPT conversation.

### Optional project-local Taskboard tools (adapter 0.1.18)

When the runtime descriptor includes the Taskboard URL and metadata file, eighteen additional board-neutral tools are discoverable. They operate on the current repository's taskboard, separate from OpenCode execution tasks. Taskboard service unavailability returns `TASKBOARD_UNAVAILABLE`; `transfer_project_task` remains a deliberate `TASK_SCOPE_UNAVAILABLE` global/local boundary. The dedicated MCP token applies to these MCP calls; it does not authenticate the separate Taskboard HTTP/UI port.

| Tool | Input | Result / behavior |
|---|---|---|
| `list_board_projects` / `get_board_project` | Empty object / `board_project_id` | Read native Board Projects with name, prefix, status and default role. Reads do not create Inbox. |
| `create_board_project` | `name`, unique 1–5-character `prefix`, optional `make_default:true` only for `Inbox`/`INBOX` | Explicitly confirmed creation. Existing canonical defaults retain their identity; collisions require an operator decision. |
| `list_project_tasks` | Optional `board_project_id` (legacy alias `project_id`), `status`, `query` (1–200 chars), `session_id`, `updated_since` (ISO datetime with offset), `include_terminal` (default true) | Complete repository-local match set across Board Projects by default, optionally filtered to one. Case-insensitive title/description and session reverse lookup. No search cursor or semantic similarity. |
| `get_project_task` | `task_id` | Exact stable ID lookup, including `comments`, unique `session_ids`, optional `links` and semantic `documents` references (`role`, `path`). UI-created tickets resolve without writing metadata during reads. |
| `register_task_document` | `task_id`, `role`, project-relative `path`, optional `expected_path` for deliberate replacement | Write a role/path reference **only after** the existing UTF-8 Markdown file is safely opened and its first-line `Task-ID` matches. Main roles `compact_context` and `concept_plan` each have one path; `concept_detail` adds up to 16 task-bound detail paths. Exact repeats are safe; conflicting main-path changes require `expected_path`. No file is created or edited. |
| `add_task_document_bindings` | Strict UUID-shaped `task_id`, at least one of `compact_context`, `concept_plan` (project-relative path strings) | Add-only main-role bindings, individually or as one bundle. Complete file/Task-ID/path/conflict prevalidation before at most one atomic sidecar commit. Exact role/path replay revalidates files and makes no new publication. Returns `{task_id, documents:[{role,path}]}`. No `expected_path`, `concept_detail`, replacement, file write or Board move. |
| `add_task_management_note` | Strict UUID-shaped `task_id`, `note` (trimmed, nonempty, ≤32,000 UTF-16 codeunits) | Append one native `Management Note:` block and return normal task output. PUT contains only `description`. Not idempotent; no text deduplication, blind retry, sidecar save or status mutation. |
| `get_task_documents` | `task_id` | Read all registered roles/paths with current `state:available|missing`; available entries include `total_bytes`, SHA-256 and `task-file-v1:<sha256>` revision. Old tasks return an empty list; reads do not write sidecar metadata. |
| `read_task_document` | `task_id`, `role`, optional registered `path` (required to disambiguate multiple details), `offset` (default 0), `max_bytes` (4–16,384, default 8,192), `revision` (required for offset > 0) | Read a bounded UTF-8 byte range of **one registered file**. Returns `revision`, SHA-256, `total_bytes`, `range {start,end}`, `text`, `has_more`, `content_complete`. Follow `end` with the same revision; restart at zero on `TASK_DOCUMENT_CHANGED`. No agent prompt or filesystem browsing. |
| `create_project_task` | Optional `board_project_id` (legacy alias `project_id`); required `title`, optional `description`, `priority`, `status` | Creates one ticket in that Board Project, or the already configured default. No implicit Project creation; absent default returns `BOARD_PROJECT_SETUP_REQUIRED`. Tasks expose both `project_id` and `board_project_id`. |
| `update_project_task` / `move_project_task` | `task_id` plus existing patch fields or `status`/optional `position` | Upstream v0.6.0 writes; there is **no** shared UI/MCP revision or compare-and-swap in this phase. |
| `add_task_comment` | `task_id`, `body` | Stores an adapter-side comment; upstream UI does not show it. |
| `link_task_to_session` | `task_id`, exposed `session_id`, optional `message_id`, `result`, `artifact_refs` | Returns all links. Distinct messages in one session remain separate; a repeat can enrich a compatible link and union artifact refs. A conflicting nonempty result is retained as a separate link rather than overwriting the old result, including links without a message ID. The session is verified as exposed in the current project; message/result/artifact strings are references, **not** independently verified completion evidence. |
| `reclassify_project_task` | `task_id`, `target_board_project_id`, `expected_source_board_project_id`, UUID `request_id` | Move a confirmed ticket between two existing active workstreams (Inbox→workstream or workstream→workstream). The identical request can be resumed. Returns old/new native display keys and stable task ID only after complete readback. Replays whose `expected_source_board_project_id` no longer matches the live source return `TASK_TRANSFER_CONFLICT`; a missing source retires the journal as `aborted`. |
| `get_task_transfer_status` | UUID `request_id` | Read the journal state and audit keys. `unresolved` is not success; inspect the original request before another write. |
| `transfer_project_task` | `task_id`, `target_scope` | Always fails closed: only project-local scope exists. |

Task IDs are deterministic UUID-shaped `task_...` values derived from repository identity and native ticket ID. New Board Project IDs are repo-bound `board_project_...` identifiers; `project_<repo hash>` remains the default/legacy ID. Project/task reads do not write. Schema-3 sidecar adds task-keyed semantic document references beside projects, tasks, comments, links and the transfer journal; schema 1/2 is read compatibly and upgraded only on writes. References follow the stable public task ID across Board Project reclassification. Corrupt/unknown metadata fails closed. Writers reload under the process-shared lock and publish atomically. This is not a shared UI/MCP compare-and-swap.

The two additive tools require `^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$` and reject unknown fields. A completely resolved unknown ID returns `TASK_NOT_FOUND`; incomplete scans remain `TASK_SEARCH_INCOMPLETE`. Both reject pending transfers. `add_task_document_bindings` rejects an already-bound main role at another path or a path under another role with `TASK_DOCUMENT_CONFLICT`, without publishing any part of the bundle. A replay against a now missing/mismatched file fails instead of claiming success. Existing `register_task_document` keeps its deliberate `expected_path` replacement semantics and its existing publication behavior.

Management notes preserve the existing description character-for-character as a prefix, append exactly `\n\n` for a nonempty prefix (without normalizing trailing newlines), then `Management Note:\n<trimmed note>`; an empty prefix starts directly with the block. Every call adds one block, including identical notes. The fresh native read and one description-only PUT run under the existing process-shared lock, with no sidecar content write. Resulting description >32,000 UTF-16 codeunits returns `TASK_DESCRIPTION_LIMIT`; prospective normal task JSON (including comments/links/documents) >40,000 UTF-8 bytes returns `TASK_SEARCH_INCOMPLETE`, both before PUT without truncation. Unknown/lost PUT outcomes return the existing backend error and may have committed: reconcile through `get_project_task`, never blindly replay. The upstream offers no CAS; non-cooperating UI/general edits can race this GET/PUT. That boundary is explicitly accepted for this feature, not a global loss-free append guarantee.

Annotations are `readOnlyHint:false`, `destructiveHint:false`, `openWorldHint:false` for both tools; `idempotentHint:false` for notes and `true` for bindings. These are honest client hints, not authorization or a guarantee of suppressed host approval UI. Existing wider write annotations are unchanged. Diagnostics log tool names/states/durations/errors only, never note text, paths or document contents.

Task-document reads are intentionally narrow: only task-ID-marked Markdown in `.opencode/tasks/` (`task-<task_id>.compact.md` or `<task_id>.compact.md`) and `planning/task-concepts/` (`<task_id>-concept-plan.md` and `<task_id>-<slug>.md` details). Registration and every read reject traversal, symlinks (including directory components), non-regular files, invalid UTF-8, a wrong first-line `Task-ID` and files above 1 MiB. The opened file descriptor is verified against the project path before reading. Other project files and arbitrary absolute/alternative locations are not exposed. A previous custom location outside these directories needs an explicit relocation decision, not a broad reader. A missing reference returns `TASK_DOCUMENT_REF_NOT_FOUND`; a referenced missing file returns `TASK_DOCUMENT_MISSING`; a wrong header returns `TASK_DOCUMENT_MISMATCH`; unsafe paths return `TASK_DOCUMENT_PATH_INVALID`; invalid UTF-8 returns `TASK_DOCUMENT_INVALID`; oversized files return `TASK_DOCUMENT_LIMIT`; revision drift or a changed file during reading returns `TASK_DOCUMENT_CHANGED`. `get_task_documents` reports `state:missing` for an absent file without losing its reference. Every page revalidates exposure of the exact Board task and its registered path; `offset` must be a UTF-8 boundary, and serialized read responses remain within the existing 64-KiB MCP read budget. These content hashes are file revisions, not verified business completion.

For a confirmed `todo` -> `in_progress` workflow, initialize while the task remains `todo`, verify `CONCEPT_READY`, prefer one add-only bundle and read both roles back as available with exact paths/revisions (`REGISTERED`), **then** separately move and read status back (`BOARD_MOVED`). Skill r21 uses the existing register path without `expected_path` only if the new tool is absent, never on bundle error/conflict. Preparation/binding failure leaves `todo`; an uncertain move may already have committed, so reconcile actual status before retrying. There is no common filesystem/sidecar/Board transaction or UI CAS. Management notes are separately authorized, never automatic initialization or status-read side effects. Older tasks without references remain valid.

Reclassification uses supported upstream HTTP routes, not an in-place `projectId` edit. A durable journal records each non-idempotent step, and a visibly `[transfer-pending]` destination in the native **Done** column may briefly coexist with the original active task. After verified source deletion, the stable public ID and unchanged comments/links point to the new native ULID; only after restoring and verifying the original business status does the request complete. Native keys, ULIDs, timestamps and subtask IDs change; old native URLs do not redirect. Native dependency edges are rejected. Pending task reads/writes fail with `TASK_TRANSFER_UNRESOLVED` rather than expose the staged ticket as a second regular task; the journal remains readable by request UUID. Uncertain deletes require explicit reconciliation and must not be blindly retried. UI edits cannot be serialized by this sidecar lock.

Upstream v0.6.0 supplies only an unpaginated `/api/tickets` response and ignores a `query` URL parameter. The adapter reads the **entire** project/status-specific response (up to **1 MiB** and **500** scanned tasks), then filters locally. At most **50** returned tasks and **40,000 UTF-8 bytes** of task JSON are returned in one result. Exceeding any scan/result bound returns `TASK_SEARCH_INCOMPLETE` as an MCP tool error, **not** an empty list, partial success, or continuation cursor. Narrowing by backend `status` may make a later *different* search fit; changing only the local query does not reduce the upstream scan size. An exact `task_id` for an as-yet-unmapped UI ticket can likewise require a bounded scan; an overflow does not establish absence. `updated_at` is a last-edit timestamp, not a reliable work-start or cycle-time measure. No automatic PLAN synchronization, task creation on `send_message`, or automatic Done transition exists.

The canonical document first line is exactly `Task-ID: <stable task_id>` with the full ID substituted, followed by LF or CRLF. Heading/backticks, alternate labels and extra spacing are invalid. Adapter 0.1.19's shared `TASK_DOCUMENT_MISMATCH` diagnostic names the attempted allowed path and exact expected line, describing ID **or** format mismatch instead of asserting foreign ownership. It does not export file contents, add error codes, relax validation or add a parser/tool. Inspect actual identity: a foreign ID requires a path decision, not overwrite. Only safely owned formatting errors may be minimally repaired in the same files within authorized work; reread real headers/metadata, rebind through the preferred add-only bundle (register fallback only if absent), require both roles available at exact paths/revisions, then separately move/read Board status. Never use an error to fall back to replacement or bypass r21's ordering.

## 5. Submission and recovery semantics

**Current adapter 0.1.16:** normal `send_message` admission does not treat an old unresolved receipt as a session lock; it checks current backend activity, pending input, the in-flight write lock and exact immediate uncertain-request retries. The historical guard-reconciliation description below records the older 0.1.6–0.1.11 behavior and applies only where an actual legacy/explicit override workflow still uses it. See [PLAN_MCP_ADMISSION.md](../PLAN_MCP_ADMISSION.md) for the current correction.

Before admission, `send_message` requires an exposed, idle session with no pending permission or question. It calls OpenCode's asynchronous prompt endpoint once with a generated message ID and a 15-second admission deadline.

The adapter serializes MCP submissions per session and keeps an in-memory unresolved-receipt guard until the exact receipt reaches `completed`, `failed`, or `aborted`, or adapter 0.1.11 proves the current session has advanced through a terminal latest user turn. It does not queue a second prompt. Since 0.1.6, admission distinguishes:

- `SESSION_BUSY` / `write_in_progress`: a concurrent MCP write holds the lock. Backend activity can still be idle while that write is being prepared/checked.
- `SESSION_BUSY` / `backend_active`: the backend is busy or retrying. This does not attribute that activity to the old receipt by itself.
- `INPUT_REQUIRED` / `pending_input`: session-wide questions/permissions need first-party input.
- `SUBMISSION_UNRESOLVED`: idle was observed, but an older receipt has no verified terminal state or permitted latest-turn supersession witness. This new prompt was **not** submitted; the error's message ID refers to the older receipt.

For an old receipt outside the fast status window, the write-side preflight reuses the authenticated backward result search under the existing per-session write lock. Each deep-search attempt is bounded to 25 result pages of up to 20 messages, with a shared 10-second deep-read deadline in addition to normal preflight deadlines. Completed pages retain only a process-local search cursor; a later deliberate write attempt can resume it. Source changes invalidate the checkpoint explicitly. Adapter 0.1.11 also retires an old guard when a complete, stable search finds the old user message and proves that the latest later user message is parent to the latest assistant message, which has `finish:"stop"`, a completion timestamp, and no error or abort. This witness says only that the session advanced past the old receipt; the old task remains `unknown`. An uncompleted newest user, a later submission without a terminal result, a previous completed turn followed by a newer unanswered user, or busy/pending input does not unlock. After either the old receipt reaches its own terminal state or a supersession witness retires its guard, backend activity and pending input are checked again before admission; runtime changes use the same preflight. Correlation-ID comparisons prevent a late old read from retiring a newer receipt.

This guard does not lock Web UI, TUI, A2A, OpenLive, or other OpenCode clients. It also does not provide durable exactly-once admission across adapter restarts. The durable correlation source is OpenCode history, not an adapter-side task database.

A restart is not a recovery verdict: process-local guards/checkpoints do not survive it, and an uncertain old submission still requires inspection by its original IDs. No automatic prompt replay, abort, unlock endpoint or persistent request-id registry is added by this fix. Existing terminal status/result reads can still reconcile internal receipt bookkeeping.

If admission times out or disconnects, the adapter returns `SUBMISSION_UNCERTAIN` with the generated message ID. The request may already have been admitted. Do not retry automatically. Poll status and inspect history using that ID. Adapter restart never replays a prompt; a known receipt can still be inspected after restart.

Permission requests and questions are never answered through this MCP surface. `input_required` directs the operator to Web UI or TUI.

### Activity persistence and coverage

The existing adapter process subscribes to OpenCode's event stream and performs startup/periodic (five-second pause between sweeps) reconciliation. Durable message status uses the same bounded correlation rules as `get_session_status`. Short busy/input-required signals are recorded from observed backend events as well as snapshots. No additional daemon, task ID, or second coding runtime is introduced.

`<session-share>/mcp/activity.json` is a private mode-0600 atomic JSON journal, bound to the project hash. It retains the latest **5,000 events**, up to **500 session observation checkpoints** and bounded outstanding receipt IDs. Collected events, sequence/epoch and checkpoints survive adapter restarts and retained-share reconnects. Fresh VM/share creation or deletion resets the epoch. An old epoch or a cursor before retained events yields **`CURSOR_EXPIRED`**, not an empty success. Unsafe/corrupt journals are rejected rather than silently reset.

Collection is bounded: each discovery sweep processes up to 200 exposed sessions/ten pages, plus tracked MCP receipts, and up to the newest 100 backend messages per session. Live events can trigger collection outside the discovery window. Events missed during adapter downtime cannot all be reconstructed: durable completion evidence is recovered where present, but transient intermediate states and history outside the bound may be unavailable. Check `tracking.connected` (event-stream connection), `partial` (reconciliation error/cutoff) and `last_reconciled_at`; a healthy socket is not a guarantee of lossless coverage. Larger-project scaling, stronger crash/downtime replay, cross-fresh-share archival and catalog pagination are recorded in [PLAN_MCP_ACTIVITY.md](../PLAN_MCP_ACTIVITY.md).

## 6. Tool errors

Tool failures return `isError: true` and sanitized text. Machine-readable error details are also returned in `_meta["opencode-vm/error"]` (`code`, `message`, optional `message_id` and admission `reason`). Error objects are not placed in `structuredContent`, because MCP SDK clients validate that field against the successful tool output schema even on errors. Existing text prefixes remain compatible; 0.1.6 adds the more precise `SUBMISSION_UNRESOLVED` code for previously overloaded idle/receipt-busy cases. Backend stack traces, prompts, responses, credentials and raw headers are not returned.

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | A limit, cursor, message, or other argument is invalid. |
| `SESSION_NOT_FOUND` | The session is absent or excluded by the endpoint's confinement rules. |
| `SESSION_BUSY` | Backend work is active/retrying or an MCP write is in progress; inspect `reason`. |
| `SUBMISSION_UNRESOLVED` | An old receipt cannot be confirmed terminal or superseded by the verified latest later turn despite observed idle. The requested operation was not admitted. Inspect the original correlation ID and `reason`. |
| `SUBMISSION_GUARD_CONFLICT` | The exact guarded receipt changed, is no longer current, or `request_id` was reused with different operation fields. Re-read the current guard and require fresh approval before creating another override request. |
| `INPUT_REQUIRED` | A permission or question must be handled in Web UI or TUI. |
| `BACKEND_UNAVAILABLE` | OpenCode did not answer a bounded backend request. |
| `BACKEND_INCOMPATIBLE` | The live OpenCode API or session metadata does not satisfy the required contract. |
| `SUBMISSION_UNCERTAIN` | Admission was not confirmed; automatic retry could duplicate work. |
| `CREATION_UNCERTAIN` | Session creation was not confirmed; inspect sessions before retrying, since a session may already exist. |
| `ARCHIVE_UNCERTAIN` | Archive update may have applied but could not be verified; inspect with opted-in `get_session` before another deliberate attempt. |
| `INVALID_AGENT` | Agent is not an available visible primary/all-mode work agent. |
| `INVALID_PROVIDER` | Provider is not connected/available. |
| `INVALID_MODEL` | Model is unavailable for the chosen provider. |
| `INVALID_VARIANT` | Variant is unsupported for the chosen model. |
| `UNSUPPORTED_CONFIGURATION` | Required runtime settings or capability data are unavailable. |
| `RUNTIME_UPDATE_FAILED` | Update could not be verified and may be partial; inspect current settings before proceeding. |
| `CURSOR_EXPIRED` | Cursor epoch or retained range no longer matches the journal. |
| `ACTIVITY_UNAVAILABLE` | Journal could not be initialized/read/persisted safely. |
| `INTERNAL_ERROR` | An unexpected adapter error occurred; internal details were suppressed. |
| `MESSAGE_NOT_FOUND` | Message is absent or not exposed in the requested session. |
| `CONTENT_UNAVAILABLE` | A previously referenced message is no longer available from the source. |
| `CONTENT_CHANGED` | Visible text no longer matches the reference revision; reacquire and restart. |
| `READ_REFERENCE_EXPIRED` | Content/search reference belongs to another adapter lifetime; reacquire with stable IDs. |
| `SEARCH_CHANGED` | Observed result-search boundary changed; restart the search without a cursor. |
| `RESPONSE_BUDGET_EXCEEDED` | Required read metadata/result does not fit; reduce the page limit. No partial JSON is returned. |
| `TASK_NOT_FOUND` | Stable task ID does not resolve to an exposed ticket. |
| `TASKBOARD_UNAVAILABLE` | The configured Taskboard service did not respond. |
| `TASKBOARD_ERROR` | The Taskboard returned an error or an incompatible response. |
| `TASKBOARD_METADATA_ERROR` | Sidecar or its private lock cannot be loaded/updated safely. Corrupt or unknown schema is not reset; inspect the stored file. |
| `TASK_SEARCH_INCOMPLETE` | Entire task scan, match set, or detailed link response exceeds the explicit bound. No complete result was returned; never infer zero matches. |
| `BOARD_PROJECT_NOT_FOUND` / `BOARD_PROJECT_CONFLICT` | Unknown selector or conflicting default/prefix/selection. |
| `BOARD_PROJECT_SETUP_REQUIRED` | No default is configured; confirm Inbox setup before a default ticket. |
| `TASK_TRANSFER_UNSUPPORTED` | Native dependencies, status or fields cannot be faithfully copied through the supported routes. |
| `TASK_TRANSFER_UNRESOLVED` / `TASK_TRANSFER_CONFLICT` | Transfer or identity needs reconciliation; inspect the original request ID. |
| `TASK_SCOPE_UNAVAILABLE` | Only the configured project-local taskboard scope exists; transfer is not enabled. |

HTTP authentication and request-boundary failures use HTTP status codes rather than these tool codes.

Admission reasons are `write_in_progress`, `backend_active`, `pending_input`, `receipt_not_terminal`, `receipt_unavailable`, `receipt_changed`, `search_incomplete`, `search_changed`, `backend_unavailable`, and `backend_incompatible`. Never reinterpret `unknown/non_terminal_evidence` or a complete search without terminal evidence as successful completion or safe non-delivery of that old task. Guard retirement occurs only from confirmed terminal evidence, the verified latest-later-turn predicate documented under `get_task_result`, or the explicitly authorized `supersede_unresolved_submission` operation. The last path keeps the old task unknown and is never inferred from idle. A known pre-admission rejection is distinct from `SUBMISSION_UNCERTAIN`, where the backend may already have accepted the new prompt. Read/reconcile the original evidence before deciding on any further send.

The adapter does not emit a separate outer `error_code:"INVALID_ARGUMENT"` for these conflicts. Raw MCP tool errors can be HTTP 200 responses with `result.isError:true`; transport forwarding logs therefore do not prove tool success. Clients should inspect the canonical `_meta` code and visible text prefix. A hosted wrapper's different outer classification requires comparison with the actual wire response; do not automatically treat a busy/unresolved refusal as malformed arguments.

Reading diagnostics use the existing stderr log: an internal request identifier, tool, session/message IDs where applicable, visible-content revision/length, delivered text length, complete serialized response size/budget and known preview/search/error cause. No prompt, answer, reasoning, cursor/token, tool arguments or raw tool results are logged. There is no separate telemetry/export product.

Adapter 0.1.5 additionally records metadata-only tool-call start/end, timestamp, duration and error code in that same log. Internal request IDs correlate the two records; known session/message IDs are included where available. Completion here means the MCP call returned, not that an asynchronously submitted agent task completed. These records support the optional [web editor's Output channels](WEB-EDITOR.md); the original fourteen-tool submission semantics are unchanged.

Adapter 0.1.6 adds a bounded admission `reason` and `blocking_message_id` to rejection diagnostics when available. These identify the older receipt, not a new successful submission. Adapter 0.1.11 adds request UUID and guarded message ID to metadata-only call diagnostics, without logging prompts, reasons or backend payloads.

## 7. Authentication and lifecycle

The connector uses a dedicated random 256-bit token, independent of Web UI Basic authentication and the A2A credential. `--no-auth` does not disable MCP authentication.

The session share stores:

```text
~/.opencode-vm/sessions/<project-hash>/mcp/credential
```

The `mcp` directory is mode `0700`; the credential is a regular, non-symlink file owned by the user with mode `0600`. Unsafe or malformed existing paths fail closed rather than being silently replaced. The token is not printed or placed in process arguments; the successful readiness banner prints only its file path.

A bare reconnect preserves the port and token, and re-evaluates whether MCP should run from the UI mode and project assignment. `opencode-vm web --reconnect --no-mcp` stops and unstages the connector for this run while preserving its configured port and token. A later normal start/reconnect enables it again. Terminal `start --no-mcp` behaves the same way. A fresh MCP-enabled session recreates the share and therefore rotates the token; restart any client that reads the credential file after rotation.

An MCP-enabled launch is fail-closed. Adapter preparation, credential validation, port collision, backend compatibility, guest readiness, or authenticated host-loopback readiness failure stops that launch instead of silently continuing without MCP. A configured OpenAI tunnel starts only after authenticated MCP readiness. Tunnel installation/connectivity failures are nonfatal to the local terminal/web/MCP session. Disabling MCP stops the tunnel first.

## 8. Source checkout and standalone script

In a repository checkout, opencode-vm validates and stages the adjacent `adapters/mcp` source, installs its locked dependencies with scripts disabled, and builds it in the VM. An incomplete adjacent package fails rather than falling back to a cached release.

A standalone installed script downloads the independently versioned `opencode-vm-mcp-adapter-<version>.tar` from the matching script release, verifies the SHA-256 embedded in `opencode-vm.sh`, rejects unsafe archive members, validates the manifest, and activates a content-addressed cache under:

```text
~/.opencode-vm/mcp-connector/adapters/<version>-<sha256>/
```

The packaged adapter contains compiled production files and a lockfile. The VM installs production dependencies with lifecycle scripts disabled. Disabled sessions do not download, stage, install, or start the MCP adapter.

## 9. Trust boundary and limits

The token is shared-service authentication, not OAuth and not per-user authorization. Anyone who can reach the loopback endpoint and read the token can inspect exposed session history and submit prompts that may run commands or change files. When Secure MCP Tunnel is used, authorized users of the external product can receive that history through the tunnel and can invoke the write tool subject to product and OpenCode approvals.

The endpoint is bound only to guest `127.0.0.1` and is verified through host `127.0.0.1`; it is not added to the public web/A2A proxy or LAN listener. The optional managed Secure MCP Tunnel runs inside the same VM, connects directly to guest loopback, and makes outbound HTTPS requests. It is documented separately in [MCP-TUNNEL.md](MCP-TUNNEL.md).

This interface can create empty root work sessions, change idle-session runtime settings, continue exposed sessions (including bounded, explicit file attachments) and read project activity. It does not delete, fork, or interrupt sessions; answer permissions/questions; expose a shell directly; or discover other projects.

Automated package, fake-backend, disposable real-OpenCode and local tunnel-control-plane tests cover twenty core tools, including project model policy reads and exact runtime recommendations, native title rename/readback and validation, scoped archive and opted-in archived reading, metadata-only progress, tail-to-forward continuation, complete original-text reconstruction, deep result searches, revision/reference handling, attachment upload/model capability checks, actual provider image input, guard-bound operator override/replay and audit receipts, creation without a model call, runtime changes and validation, independent session completions, bounded waits, journal restart recovery, pending input and no automatic resend on uncertainty. Real macOS/Lima and actual ChatGPT text/Voice acceptance still require target-host acceptance. A client must be able to submit file bytes to `upload_attachment` as Base64; a client that only exposes its local file in conversation context cannot use this upload flow. After upgrading, reconnect the project runtime and refresh the external client's tool catalog; ChatGPT custom apps may require a tool refresh or republishing to expose new tools. See the exact tested combinations and external acceptance procedures in [PLAN_MCP_READING.md](../PLAN_MCP_READING.md) and [PLAN_MCP_PROGRESS.md](../PLAN_MCP_PROGRESS.md).
