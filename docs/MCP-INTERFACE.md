# opencode-vm MCP interface contract

This document defines the incoming MCP interface exposed by `opencode-vm web` sessions (enabled by default since 0.5.61) and by terminal `start` sessions with a project-specific OpenAI MCP assignment (since 0.5.62). It describes the server side that external MCP clients use. It is separate from `opencode-vm mcps`, which configures MCP servers that OpenCode consumes as tools.

The implemented adapter is version **0.1.0**, uses `@modelcontextprotocol/sdk` **1.30.1** and `@opencode-ai/sdk` **1.18.21**, and was tested with MCP protocol revision **2025-11-25**. It uses stateless Streamable HTTP with JSON responses. The SDK also advertises `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`, but those revisions are not the release-tested contract.

## 1. Runtime model

One MCP endpoint represents one running project and its existing server-backed OpenCode runtime:

```text
external MCP client
        |
http://127.0.0.1:<port>/mcp
        |
MCP adapter in the project VM
        |
existing OpenCode web server and sessions
```

The adapter does not start a second OpenCode process, create an MCP manager session, or maintain a separate conversation database. Web UI, TUI, A2A, OpenLive, and MCP therefore observe the same OpenCode sessions and workspace.

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

## 5. Submission and recovery semantics

Before admission, `send_message` requires an exposed, idle session with no pending permission or question. It calls OpenCode's asynchronous prompt endpoint once with a generated message ID and a 15-second admission deadline.

The adapter serializes MCP submissions per session and keeps an in-memory unresolved-receipt guard until status reconciliation reaches `completed`, `failed`, or `aborted`. A second MCP submission is rejected with `SESSION_BUSY`; it is not queued.

This guard does not lock Web UI, TUI, A2A, OpenLive, or other OpenCode clients. It also does not provide durable exactly-once admission across adapter restarts. The durable correlation source is OpenCode history, not an adapter-side task database.

If admission times out or disconnects, the adapter returns `SUBMISSION_UNCERTAIN` with the generated message ID. The request may already have been admitted. Do not retry automatically. Poll status and inspect history using that ID. Adapter restart never replays a prompt; a known receipt can still be inspected after restart.

Permission requests and questions are never answered through this MCP surface. `input_required` directs the operator to Web UI or TUI.

## 6. Tool errors

Tool failures return `isError: true` and sanitized text. They do not return backend stack traces, prompts, responses, credentials, or raw headers.

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | A limit, cursor, message, or other argument is invalid. |
| `SESSION_NOT_FOUND` | The session is absent or excluded by the endpoint's confinement rules. |
| `SESSION_BUSY` | The session is active, receiving another MCP submission, or has an unresolved MCP receipt. |
| `INPUT_REQUIRED` | A permission or question must be handled in Web UI or TUI. |
| `BACKEND_UNAVAILABLE` | OpenCode did not answer a bounded backend request. |
| `BACKEND_INCOMPATIBLE` | The live OpenCode API or session metadata does not satisfy the required contract. |
| `SUBMISSION_UNCERTAIN` | Admission was not confirmed; automatic retry could duplicate work. |
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

This interface does not create, delete, fork, or interrupt sessions; change models; upload attachments; answer permissions/questions; expose a shell directly; or discover other projects.

Automated package, fake-backend, and disposable real-OpenCode tests cover the implemented protocol and one correlated prompt. Real macOS/Lima loopback behavior and actual ChatGPT text and desktop Voice operation still require acceptance on the target host and workspace.
