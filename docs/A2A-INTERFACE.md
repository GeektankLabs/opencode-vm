# opencode-vm — A2A interface contract

Everything a client needs to drive an `opencode-vm web` session over A2A.

Verified against **`opencode-a2a==1.2.0`** (`a2a-sdk==1.1.2`), A2A protocol **1.0**, on a live
session. Where a detail is easy to get wrong, the reason is spelled out rather than left implicit.

> Scope: this document describes the **server** side — what opencode-vm exposes. The client
> (registry of agents, run state, issue dispatch, scheduling) lives elsewhere.

---

## 1. What an agent is

One `opencode-vm web` session = one OpenCode runtime = one A2A agent.

The runtime is shared: the browser UI, the REST API and A2A all drive the *same* OpenCode process,
the same sessions and the same working tree. There is no second runtime behind A2A.

Consequences a client must accept:

- **Single-tenant.** All consumers share one workspace. Two orchestrators sending work to the same
  agent are editing the same files.
- **One agent per project.** Run several sessions on different base ports to address several
  projects.
- The workspace is fixed at session start. A client **cannot** point the agent at another
  directory (see §8).

---

## 2. Endpoints and ports

For a base port `P` (`opencode-vm web --port P`, default `4096`):

| Port | Service | On the LAN |
|---|---|---|
| `P-2` | `opencode-a2a` | no — VM loopback only |
| `P-1` | OpenCode backend | no — VM loopback only |
| `P` | Web UI / REST, HTTPS | yes |
| `P+1` | Web UI / REST, HTTP | yes |
| **`P+2`** | **A2A, HTTPS** | yes |
| **`P+3`** | **A2A, HTTP** | yes |

The block is contiguous and moves as a unit if any port is taken, so **never compute the A2A port
from a remembered base** — read it from the Agent Card (§3). `opencode-vm a2a` prints the effective
URLs.

HTTP paths on the A2A base URL:

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/` | POST | yes | **JSON-RPC 2.0 endpoint** — this is the one you want |
| `/.well-known/agent-card.json` | GET | **no** | discovery |
| `/health` | GET | yes | liveness **and** credential probe |
| `/extendedAgentCard` | GET | yes | full machine-readable contract (§7) |
| `/message:send`, `/message:stream`, `/tasks…` | | yes | REST twin, ProtoJSON, no JSON-RPC envelope |
| `…/pushNotificationConfigs` | | yes | **always 501** (§9) |

`/rpc` and `/a2a` do not exist — JSON-RPC is on the bare root.

**TLS:** `P+2` uses a self-signed per-session certificate. The Agent Card deliberately advertises
the **plain-HTTP** endpoint (`P+3`), because a client that cannot verify that certificate would
otherwise be redirected somewhere it cannot reach. Both ports front the same process. Use `P+3` on
a trusted LAN; use `P+2` if you can pin or install the session certificate.

---

## 3. Discovery

```bash
curl -s http://<host>:<P+3>/.well-known/agent-card.json | jq .
```

Unauthenticated by design — the A2A spec requires the card to be public, and clients fetch it
before they have credentials.

Fields that matter:

| Field | Meaning |
|---|---|
| `name` | `OpenCode: <project-dir-name>` — human-readable, **not** an identifier |
| `description` | includes the project and the host |
| `supportedInterfaces[]` | `{url, protocolBinding, protocolVersion}` — `HTTP+JSON` and `JSONRPC`, both `1.0`, both the same URL. **This URL is authoritative.** |
| `securitySchemes` | `bearerAuth` and `basicAuth` |
| `capabilities.extensions[]` | the four negotiable extensions (§6, §8) |
| `skills[]` | `opencode.chat`, `opencode.interrupt.callback` |

There is **no** top-level `url` field — read `supportedInterfaces[]`.

**The identity of an agent is its URL, not its name.** The A2A spec places no uniqueness
requirement on `name`, and every opencode-a2a instance exposes the identical `skills[]`. A client
registry must key agents by a locally chosen name mapped to a URL.

A minimal validity check (what `opencode-vm a2a check` enforces): `name` non-empty,
`supportedInterfaces[]` non-empty with non-empty `url`, at least one interface at
`protocolVersion 1.0`, `securitySchemes` present, `skills[]` non-empty.

---

## 4. Authentication

Both schemes are registered and carry the same secret:

```
Authorization: Bearer <secret>
Authorization: Basic base64(<username>:<secret>)
```

- **Username** — `opencode` (default; a session may override it).
- **Secret** — the session's `--password` if one was set, otherwise the documented constant
  **`opencode-vm`**. `opencode-a2a` refuses to start without a credential, so there is always one;
  a fixed, documented default was chosen over a hidden generated token, which nobody could find and
  which would rotate on every restart.
- `opencode-vm a2a` shows which of the two applies. A session password is never printed.

Probe credentials against **`GET /health`** — the card is public and therefore proves nothing:

```
no header      → 401  {"error":"Unauthorized"}
wrong secret   → 401
correct secret → 200  {"status":"ok","service":"opencode-a2a","version":"1.2.0", …}
```

The `WWW-Authenticate` response header is `Bearer, Basic realm="opencode-a2a"`.

> ### ⚠️ Bearer and Basic are different identities
> Session binding is keyed on `(identity, contextId)`. The identity is the principal `automation`
> for Bearer, and the **username** for Basic. Switching scheme mid-conversation — even with the
> identical secret — silently starts a new OpenCode session. **Pick one scheme and keep it.**

---

## 5. Sending a message

`SendMessage` is **blocking by default** and returns the finished task. No polling, no
subscription, no streaming needed.

```bash
curl -s -X POST http://<host>:<P+3>/ \
  -H 'Authorization: Bearer opencode-vm' \
  -H 'Content-Type: application/json' \
  -H 'A2A-Extensions: urn:opencode-a2a:extension:session-binding:v1' \
  --max-time 150 \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "m-0001",
        "role": "ROLE_USER",
        "parts": [{ "text": "What does this repository do?" }],
        "contextId": "my-conversation-42"
      }
    }
  }'
```

### Request rules

`a2a-sdk` is **protobuf-first**, which explains every one of these:

| Rule | Wrong | Right |
|---|---|---|
| Role is an enum | `"role": "user"` | `"role": "ROLE_USER"` |
| A text part is bare | `{"kind":"text","text":"…"}`, `{"type":"text",…}` | `{"text": "…"}` |
| Parts, not content | `"content": "…"` | `"parts": [ … ]` |

Required: `messageId` (non-empty), `role`, `parts` (≥ 1).
Optional: `contextId`, `metadata`.
**Omit `taskId`** on a new turn — an unknown one gives `TaskNotFoundError`, a finished one gives
`InvalidParamsError`.

Omit `configuration` entirely. If you do send `acceptedOutputModes`, it **must** contain
`text/plain` or the call fails with `-32004`.

Other part kinds: `{"raw": "<base64>", "mediaType": …, "filename": …}` and `{"url": …}` are
supported. `{"data": {...}}` is **not** — it comes back as a FAILED task, not a JSON-RPC error.

### Reading the response

```jsonc
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "task": {
      "id": "…", "contextId": "my-conversation-42",
      "status": {
        "state": "TASK_STATE_COMPLETED",
        "message": { "parts": [{ "text": "Completed." }] }   // ← always this literal
      },
      "artifacts": [
        { "artifactId": "…", "name": "response",
          "parts": [{ "text": "THE ANSWER" }] }              // ← the answer
      ],
      "history": [ … ],
      "metadata": { "shared": { "session": { "id": "ses_…" } } }
    }
  }
}
```

> ### ⚠️ The answer is in the artifact, not in the status message
> `result.task.status.message.parts[0].text` is **always the literal string `"Completed."`**. It is
> a placeholder. Read the artifact named `response`:
>
> ```
> result.task.artifacts[] | select(.name == "response") | .parts[].text
> ```

`status.state` is one of `TASK_STATE_SUBMITTED | WORKING | COMPLETED | FAILED | CANCELED |
INPUT_REQUIRED | REJECTED | AUTH_REQUIRED`. Terminal: `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`.

### Error handling — two layers, both under HTTP 200

**HTTP 200 does not mean success.** Check both:

1. `error` present → a JSON-RPC error (bad request, unknown method, missing extension).
2. `result.task.status.state != TASK_STATE_COMPLETED` → the agent failed. The reason is in
   `result.task.metadata.opencode.error` (`{"type": "UPSTREAM_TIMEOUT", "upstream_status": 502}`),
   and a human-readable message in `status.message.parts[0].text`.

`UPSTREAM_*` error types mean the A2A layer worked and OpenCode failed behind it — a model or
provider problem, not an interface problem.

JSON-RPC error codes: `-32700` parse, `-32600` invalid request, `-32601` method not found (the
response helpfully lists `supportedMethods`), `-32602` invalid params, `-32603` internal,
`-32001` task not found, `-32004` unsupported / **extension negotiation required**.

Batch requests are rejected. A request without `id` is a notification and returns **HTTP 204**.

### Timeout

The non-streaming upstream call uses a **120 s** timeout. Longer turns end as `FAILED` with
`UPSTREAM_TIMEOUT`. Set your HTTP client above that (≥ 150 s) and use streaming for long work
(§9) — the streaming path allows 900 s.

---

## 6. Session binding — continuing a conversation

`contextId` is the conversation key.

- Omit it on the first turn and the server generates one; read it back from
  `result.task.contextId`.
- **Reuse the same `contextId` and you continue the same OpenCode session** — same history, same
  working context.
- The binding key is `(identity, contextId)` — see the warning in §4.

To learn *which* OpenCode session you are bound to, negotiate the extension:

```
A2A-Extensions: urn:opencode-a2a:extension:session-binding:v1
```

Then `result.task.metadata.shared.session.id` (`ses_…`) is returned. Without the header the field
is stripped from the response.

You may also bind explicitly to a known session id:

```jsonc
"message": {
  "messageId": "m-2", "role": "ROLE_USER", "parts": [{"text": "continue"}],
  "contextId": "my-conversation-42",
  "metadata": { "shared": { "session": { "id": "ses_7f3ab21" } } }
}
```

Sessions are owned by the identity that created them; another identity binding to them is refused.

**Model selection** works the same way, with
`urn:opencode-a2a:extension:model-selection:v1` and
`metadata.shared.model = {providerID, modelID}`.

---

## 7. The wider method surface

Beyond the standard A2A methods (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`,
`CancelTask`, `SubscribeToTask`, `GetExtendedAgentCard`), the agent exposes provider-private
methods:

```
opencode.sessions.status | list | get | children | messages.list | messages.get
opencode.sessions.todo | diff | fork | share | unshare | summarize | revert | unrevert
opencode.sessions.prompt_async | command
opencode.providers.list | opencode.models.list
opencode.projects.list | opencode.projects.current
opencode.workspaces.list | opencode.worktrees.list
opencode.permissions.list | opencode.questions.list
a2a.interrupt.permission.reply | a2a.interrupt.question.reply | a2a.interrupt.question.reject
```

`opencode.sessions.diff` is the useful one for a review workflow — it shows what the agent changed.

> ### ⚠️ Every `opencode.*` method requires extension negotiation
> Without an `A2A-Extensions` header you get `-32004 EXTENSION_NEGOTIATION_REQUIRED`. The error
> names the URN you need, e.g.:
> ```
> A2A-Extensions: urn:opencode-a2a:extension:session-management:v1
> ```

**The authoritative, always-current reference is the agent itself:**

```bash
curl -s -H 'Authorization: Bearer opencode-vm' \
     -H 'A2A-Extensions: urn:opencode-a2a:extension:wire-contract:v1' \
     http://<host>:<P+3>/extendedAgentCard | jq .
```

That returns per-method required/optional parameters and result fields. Prefer it over this
document when the two disagree.

---

## 8. What the agent may and may not do

**Disabled server-side, not negotiable by a client:**

| Setting | Effect |
|---|---|
| `A2A_ALLOW_DIRECTORY_OVERRIDE=false` | a client cannot move the agent outside its project |
| `A2A_ENABLE_SESSION_SHELL=false` | no shell access over A2A |
| `A2A_ENABLE_WORKSPACE_MUTATIONS=false` | no workspace create/remove over A2A |

**Enforced by the environment, not by policy:** the VM holds **no git credentials** — no SSH keys,
no tokens, no agent forwarding, no access to your origin. The agent therefore *cannot* push a
branch or open a PR, whatever it is asked to do. Review and push happen on the host. The VM also
cannot reach your LAN: outbound RFC1918 traffic is dropped by its firewall.

**Allowed:** reading and editing files inside the mounted project, running builds and tests, and
network access to the public internet.

**Actions that need a human:** OpenCode raises permission prompts and questions. They surface
through `opencode.permissions.list` / `opencode.questions.list`, and the client answers with
`a2a.interrupt.permission.reply` / `a2a.interrupt.question.reply` / `…question.reject`
(extension `urn:opencode-a2a:extension:interactive-interrupt:v1`). This is the built-in approval
channel — a client does not have to invent one.

⚠️ Those interrupt events are delivered on the **streaming** path. On the blocking `SendMessage`
path a prompt that triggers an approval may simply block until the 120 s timeout. If your prompts
can trigger tool approvals, use `SendStreamingMessage` and handle the interrupts.

---

## 9. Driving this from an orchestrator

### Registering an agent

Get the URL from the host running the session:

```bash
opencode-vm a2a            # human-readable
opencode-vm a2a --json     # machine-readable
```

```json
[{ "project": "raspiblitz-mcrepo",
   "a2aHttp": "http://192.168.16.152:4447",
   "agentCard": "http://192.168.16.152:4447/.well-known/agent-card.json",
   "cardName": "OpenCode: raspiblitz-mcrepo",
   "username": "opencode",
   "health": "ok" }]
```

Register that URL under a **local name of your choosing** — that name, not the card's, is what
your operators and your model will use to address the agent.

### Scheduling

> ### ⚠️ There are no webhooks
> The A2A push-notification methods are **permanently `501 UNIMPLEMENTED`** in this deployment.
> The agent will never call you back. Do not design around callbacks.

Two workable patterns:

1. **Cron + blocking `SendMessage`.** Simplest. Remember the 120 s ceiling: keep scheduled prompts
   small, or use (2).
2. **`SendStreamingMessage` / `SubscribeToTask` over SSE.** Needed for long turns (900 s) and the
   only way to see permission/question interrupts as they happen.

Keep one `contextId` per logical conversation and persist it alongside the returned
`metadata.shared.session.id`, so a later run continues where the last one stopped.

### Fan-out

If your orchestrator can broadcast to several agents by capability or tag, be careful: several
opencode-vm agents tagged alike means one instruction runs in **every** project directory
simultaneously. Give each agent a distinct tag, or address them individually.

---

## 10. Known limits

| Limit | Value |
|---|---|
| Blocking turn timeout | 120 s (`UPSTREAM_TIMEOUT`); streaming 900 s |
| Rate limit | 120 requests / 60 s per identity |
| Request body | 1 MiB |
| Push notifications / webhooks | not implemented (501) |
| Tenancy | single-tenant; all consumers share one workspace |
| Protocol | A2A 1.0 only — 0.3 aliases and payload shapes are rejected, not normalized |
| Card `name` | not unique, not an identifier |
| Card skills | identical across instances; unusable for agent selection |

**Open questions**, recorded rather than guessed:

1. Whether an approval prompt on the blocking path resolves upstream or hangs until the timeout is
   not traced end to end. Use streaming for prompts that can trigger approvals.
2. `ListTasks` was empty on the reference deployment, so the persisted task shape is unverified
   against a real record.
3. Upstream's own `docs/` (guide, extension specifications) ships only in the GitHub repo, not in
   the wheel. `GET /extendedAgentCard` is the in-band substitute.
4. Everything here is pinned to `opencode-a2a==1.2.0`. Later versions add Origin/Host enforcement
   that must be re-tested against the opencode-vm proxy before the pin moves.

---

## 11. Verifying an agent

```bash
opencode-vm a2a check [<project>|<url>]
```

Runs the full contract suite against a live agent: card reachable and structurally valid; the three
authentication outcomes; the JSON-RPC method surface; extension negotiation; the unreachable-agent
and invalid-card error paths; a live `SendMessage` round trip asserting the reply; and session
binding across two turns.

It finishes with a redaction self-check — it greps its own buffered output for the credential. That
check only runs when the session has a real `--password`: the published default is the literal
string `opencode-vm`, which is also this tool's own name and appears throughout its output, so
grepping for it would prove nothing.

The round trip sends two real prompts — it costs tokens and creates a session in the target
project. Exit code is non-zero if any check fails.

An `UPSTREAM_*` failure in the round trip means the interface worked and OpenCode did not return an
answer — a model or provider problem in the session, not an interface problem. Every check above the
round trip passing while the round trip fails is exactly that picture.
