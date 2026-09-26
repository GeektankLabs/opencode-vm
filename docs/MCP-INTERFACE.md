# opencode-vm MCP interface contract

This document defines the incoming MCP interface exposed by `opencode-vm web` sessions (enabled by default since 0.5.61) and by terminal `start` sessions with a project-specific OpenAI MCP assignment (since 0.5.62). It describes the server side that external MCP clients use. It is separate from `opencode-vm mcps`, which configures MCP servers that OpenCode consumes as tools.

The implemented adapter is version **0.1.2**, uses `@modelcontextprotocol/sdk` **1.30.1** and `@opencode-ai/sdk` **1.18.21**, and was tested with MCP protocol revision **2025-11-25**. It uses stateless Streamable HTTP with JSON responses. The SDK also advertises `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`, but those revisions are not the release-tested contract.

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
| More than 16 concurrent HTTP requests | HTTP 503 with `Retry-After: 1` |

`Host` must be `127.0.0.1:<port>` or `localhost:<port>`. `Origin` may be absent; when present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. The adapter does not enable permissive browser CORS.

An authenticated `GET /healthz` returns the project hash and basename, controller generation, adapter version, transport, and preferred MCP revision. It does not return the absolute project path or either backend credential.

## 3. Project and session confinement

The runtime descriptor fixes one canonical project directory, and the adapter resolves one OpenCode project ID at startup. Every direct session operation repeats the same ownership checks used by listing.

Only sessions meeting all of these conditions are exposed:

- The OpenCode project ID matches the configured project.
- The session directory exactly matches the configured canonical directory.
- The session is a root session with no `parentID`.
- The session is not archived.
- The session agent is not `openlive-manager`.
- The session is not the manager session named by OpenLive's manager descriptor.

Absent, foreign-project, foreign-directory, child, archived, and manager sessions all return the same `SESSION_NOT_FOUND` tool error. This prevents direct-ID calls from revealing whether an excluded session exists.

The public project identity is:

```json
{"id":"<opencode-vm project hash>","name":"<project basename>"}
```

Absolute workspace paths and OpenCode's internal project ID are never returned.

## 4. Tool contract

All input schemas are strict: unknown fields are rejected. Every successful call returns both concise text in `content` and the JSON object below in `structuredContent`.

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

### `get_session_status`

Read-only, idempotent, closed-world tool.

Input:

```json
{"session_id":"ses_...","message_id":"msg_..."}
```

`message_id` is optional. Without it, the result reports session-wide backend activity and pending input, but cannot identify completion of a particular turn.

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
| `running` | Correlated work is non-terminal and the backend is busy or retrying. |
| `input_required` | The session has a pending permission or question; continue in Web UI or TUI. |
| `completed` | Correlated assistant messages are complete and at least one ends with `stop`, `length`, or `content-filter`. |
| `failed` | A correlated assistant message carries a non-abort error. |
| `aborted` | A correlated assistant message was aborted. |

Correlation uses the submitted user `message_id` and assistant `parentID`. `tool-calls`, `unknown`, and unrecognized future finish values are non-terminal; `error` is failed. An earlier tool-call iteration does not prevent a later terminal assistant message from completing the turn. Status reads at most 100 backend messages. If the user message or required terminal evidence is outside that bound, the state is `unknown`, not guessed.

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

Only user and assistant messages are returned. The adapter includes non-synthetic, non-ignored text parts and excludes attachments, reasoning, system messages, and raw tool inputs or outputs. Total returned text is capped at 32,000 characters across the response. `text_truncated` marks a shortened message; `truncated` also becomes true when the backend supplies another opaque page cursor. `completed`, `finish`, `error`, `parent_id`, and `next_before` are omitted when not applicable.

### `send_message`

Write-capable, destructive, non-idempotent, open-world tool.

Input:

```json
{"session_id":"ses_...","message":"Continue with the requested task."}
```

`message` must contain `1..32000` characters.

Output:

```json
{"session_id":"ses_...","message_id":"msg_<32 hex characters>","state":"submitted"}
```

This is an asynchronous admission receipt, not a completion result. The prompt may run commands and modify project files inside the VM. Poll `get_session_status` with the returned `message_id`, then retrieve text with `get_session_history`.

The adapter preserves the session's agent, provider/model, and variant. If current session metadata lacks those settings, it uses the latest user-message settings from a bounded 20-message lookup; otherwise it returns `BACKEND_INCOMPATIBLE`.

Since 0.1.2, receipts also include `submitted_at` (ISO timestamp of the submission attempt) and, with initialized collection, `activity_cursor`. That cursor is the journal position **before** submission, so an exclusive `after_cursor` read includes this request's submitted/running/completion events and any concurrent project activity. The original three fields and no-retry semantics remain unchanged. `client_request_id` is not implemented in this baseline.

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

Busy/retrying sessions and unresolved MCP admissions are refused with `SESSION_BUSY`. Pending questions/permissions return `INPUT_REQUIRED`. Runtime updates and MCP submissions share the same per-session write lock. The adapter checks idle immediately before changes and between the backend's separate agent/model switches, then verifies the stored settings; subsequent `get_session` and `send_message` use those values.

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

Session-only events may omit `message_id`; message events preserve the existing submitted user-message ID. Completion events contain correlated assistant IDs, not responses. No prompts, answers, reasoning, permission details or raw tool inputs/outputs are journaled. Use `get_session_history` for text.

`timestamp` is the observation/recording time. `source` distinguishes recording during `mcp` receipts/updates, live `observed` events, and `reconciled` durable-state discoveries; it is not attribution to the frontend that originally started the work. Initial reconciliation can report already completed work; it does not claim the work happened at observation time. `get_session_status(session_id,message_id)` remains the source of truth for the **current** correlated state and shares its correlation logic with journal reconciliation.

Events are ordered by a persistent monotonic sequence within a journal epoch. Reads are exclusive of `after_cursor` and do not consume events for other clients. Keep `next_cursor`; when `has_more` is true, continue pagination, including an empty page. A one-second scan budget (plus the in-flight bounded backend check) prevents long backlogs of visibility checks from monopolizing one call. Filtering advances past skipped records; changing filters later does not replay records already skipped by that cursor. Omit the cursor to read from the earliest retained event. Current project/root/manager/archive checks are repeated before returning stored events, so excluded sessions cannot be retrieved from old journal entries.

### `wait_for_project_activity`

Same filters/output as `get_project_activity`, with required `after_cursor`, optional `timeout_ms` (1–15000, default 10000), and an additional `timeout` boolean. Returns immediately if matching events are already present; otherwise waits briefly for journal changes. Normal backend visibility validation adds its usual request deadline to the waiting budget. On timeout, the empty response still has `next_cursor`. This is a bounded active wait, not delivery/push to an inactive ChatGPT conversation.

## 5. Submission and recovery semantics

Before admission, `send_message` requires an exposed, idle session with no pending permission or question. It calls OpenCode's asynchronous prompt endpoint once with a generated message ID and a 15-second admission deadline.

The adapter serializes MCP submissions per session and keeps an in-memory unresolved-receipt guard until status reconciliation reaches `completed`, `failed`, or `aborted`. A second MCP submission is rejected with `SESSION_BUSY`; it is not queued.

This guard does not lock Web UI, TUI, A2A, OpenLive, or other OpenCode clients. It also does not provide durable exactly-once admission across adapter restarts. The durable correlation source is OpenCode history, not an adapter-side task database.

If admission times out or disconnects, the adapter returns `SUBMISSION_UNCERTAIN` with the generated message ID. The request may already have been admitted. Do not retry automatically. Poll status and inspect history using that ID. Adapter restart never replays a prompt; a known receipt can still be inspected after restart.

Permission requests and questions are never answered through this MCP surface. `input_required` directs the operator to Web UI or TUI.

### Activity persistence and coverage

The existing adapter process subscribes to OpenCode's event stream and performs startup/periodic (five-second pause between sweeps) reconciliation. Durable message status uses the same bounded correlation rules as `get_session_status`. Short busy/input-required signals are recorded from observed backend events as well as snapshots. No additional daemon, task ID, or second coding runtime is introduced.

`<session-share>/mcp/activity.json` is a private mode-0600 atomic JSON journal, bound to the project hash. It retains the latest **5,000 events**, up to **500 session observation checkpoints** and bounded outstanding receipt IDs. Collected events, sequence/epoch and checkpoints survive adapter restarts and retained-share reconnects. Fresh VM/share creation or deletion resets the epoch. An old epoch or a cursor before retained events yields **`CURSOR_EXPIRED`**, not an empty success. Unsafe/corrupt journals are rejected rather than silently reset.

Collection is bounded: each discovery sweep processes up to 200 exposed sessions/ten pages, plus tracked MCP receipts, and up to the newest 100 backend messages per session. Live events can trigger collection outside the discovery window. Events missed during adapter downtime cannot all be reconstructed: durable completion evidence is recovered where present, but transient intermediate states and history outside the bound may be unavailable. Check `tracking.connected` (event-stream connection), `partial` (reconciliation error/cutoff) and `last_reconciled_at`; a healthy socket is not a guarantee of lossless coverage. Larger-project scaling, stronger crash/downtime replay, cross-fresh-share archival and catalog pagination are recorded in [PLAN_MCP_ACTIVITY.md](../PLAN_MCP_ACTIVITY.md).

## 6. Tool errors

Tool failures return `isError: true` and sanitized text. Machine-readable error details are also returned in `_meta["opencode-vm/error"]` (`code`, `message`, optional `message_id`). Error objects are not placed in `structuredContent`, because MCP SDK clients validate that field against the successful tool output schema even on errors. Existing text codes remain compatible. Backend stack traces, prompts, responses, credentials and raw headers are not returned.

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | A limit, cursor, message, or other argument is invalid. |
| `SESSION_NOT_FOUND` | The session is absent or excluded by the endpoint's confinement rules. |
| `SESSION_BUSY` | The session is active, receiving another MCP submission, or has an unresolved MCP receipt. |
| `INPUT_REQUIRED` | A permission or question must be handled in Web UI or TUI. |
| `BACKEND_UNAVAILABLE` | OpenCode did not answer a bounded backend request. |
| `BACKEND_INCOMPATIBLE` | The live OpenCode API or session metadata does not satisfy the required contract. |
| `SUBMISSION_UNCERTAIN` | Admission was not confirmed; automatic retry could duplicate work. |
| `CREATION_UNCERTAIN` | Session creation was not confirmed; inspect sessions before retrying, since a session may already exist. |
| `INVALID_AGENT` | Agent is not an available visible primary/all-mode work agent. |
| `INVALID_PROVIDER` | Provider is not connected/available. |
| `INVALID_MODEL` | Model is unavailable for the chosen provider. |
| `INVALID_VARIANT` | Variant is unsupported for the chosen model. |
| `UNSUPPORTED_CONFIGURATION` | Required runtime settings or capability data are unavailable. |
| `RUNTIME_UPDATE_FAILED` | Update could not be verified and may be partial; inspect current settings before proceeding. |
| `CURSOR_EXPIRED` | Cursor epoch or retained range no longer matches the journal. |
| `ACTIVITY_UNAVAILABLE` | Journal could not be initialized/read/persisted safely. |
| `INTERNAL_ERROR` | An unexpected adapter error occurred; internal details were suppressed. |

HTTP authentication and request-boundary failures use HTTP status codes rather than these tool codes.

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

This interface can create empty root work sessions, change idle-session runtime settings, continue exposed sessions and read project activity. It does not delete, fork, or interrupt sessions; upload attachments; answer permissions/questions; expose a shell directly; or discover other projects.

Automated package, fake-backend, and disposable real-OpenCode tests cover the ten-tool protocol, creation without a model call, runtime changes and validation, two independently running sessions with ordered completion events, bounded waits, journal recovery after adapter restart, pending input and no automatic resend on uncertainty. Real macOS/Lima and actual ChatGPT text/Voice operation still require target-host acceptance. After upgrading, reconnect the project runtime and refresh the external client's tool catalog; ChatGPT custom apps may require a tool refresh or republishing to expose new tools.
