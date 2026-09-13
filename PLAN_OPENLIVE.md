# OpenLive Voice Session Gateway Plan

Current status:

- The local, remote, and discussion MVP baselines plus the regular single-script distribution path are implemented at `opencode-vm` `0.5.49` / adapter `0.1.6`, using ACP SDK `1.2.1` and OpenCode SDK/server `1.18.21`.
- A real OpenLive run has already confirmed ACP setup, reuse of the central runtime, model selection, normal streaming, and per-turn screen sharing. The exact OpenLive build used for that run was not recorded.
- Remaining release gates are publication of the `v0.5.49` adapter asset before the script reaches the update path, the complete local macOS/OpenLive acceptance run in A.6, and the real two-computer remote acceptance in section 29.11, with the exact OpenLive build recorded. A real spoken discussion (skill activation, follow-up question, decision and result summary) remains a manual acceptance step.
- A versioned reproducible adapter archive, embedded SHA-256 verification, safe extraction, atomic content-addressed host cache, packaged-runtime session preparation, and tag-driven release workflow are part of the baseline. Richer ACP activity, generic attachments, and retention policy remain future work.
- Remote OpenLive through the existing web port is implemented in section 29 (work package C). It uses a local stub folder and `opencode-vm openlive remote`; no SSH access, local project checkout, or client-side base VM is required.
- Script `0.5.45` / adapter `0.1.5` add the first discussion baseline: the default-active bundled `besprechung` skill with document and turn-based dialogue commands. Every attached OpenLive work turn receives a concise voice primer that points natural review and decision requests to this skill; ordinary questions and the read-only manager remain unchanged. Existing installations receive the package through a one-time, opt-out-preserving skills migration.
- Script `0.5.46` closes the discussion lifecycle gaps: reconnect refreshes owned skill/command files and applies opt-out while preserving user edits; cache refresh errors are explicit, incomplete packages are retried, and an already-current script can retry asset updates. Regression tests cover the actual attach entry point with a mocked VM launch and standalone Git transport with local fixtures. The adapter bytes and version remain `0.1.5`.
- Script `0.5.49` / adapter `0.1.6` make Remote OpenLive inherit the HTTPS web session's authentication choice. Unprotected trusted-LAN sessions accept remote calls without a password; protected sessions retain the same Basic credential and setup asks for it only after an unauthenticated discovery receives HTTP 401.

## 1. Goal

The implemented baseline replaces the former separate `opencode acp` runtime with a custom ACP adapter that connects OpenLive to the already-running OpenCode server started by `opencode-vm web`.

The first minimal functional baseline must prove this user flow end to end:

1. The user starts `opencode-vm web` for a project.
2. OpenLive connects to that project without starting another OpenCode runtime.
3. Every voice call starts in one persistent management session for the project.
4. On the first successful turn, the manager reports exact project-session and busy counts and offers an existing or new work session.
5. The manager can list and read existing Web/TUI sessions.
6. The user can attach the current voice call to an existing idle session or explicitly create a new one.
7. Subsequent voice turns are added to that exact OpenCode session and appear in Web UI and TUI.
8. Per-turn OpenLive camera/screen JPEG frames reach a vision-capable selected model as normal OpenCode image parts.
9. Ending the OpenLive call discards the attachment.
10. The next voice call starts in the persistent management session again.

OpenLive and OpenCode remain unmodified. The former direct `opencode acp` path was replaced rather than retained as a fallback.

## 2. Confirmed Product Decisions

| Topic                        | Decision                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| OpenLive                     | Remains unchanged                                                                                          |
| OpenCode                     | No fork and no source modification                                                                         |
| Central runtime              | The server started by `opencode-vm web`                                                                    |
| Adapter backend              | Official OpenCode HTTP/SSE SDK                                                                             |
| ACP                          | First frontend transport into a reusable voice-session core                                                |
| A2A                          | Remains an independent sibling interface to the same OpenCode server                                       |
| Management session           | One persistent OpenCode session per project                                                                |
| Manager mutation             | Read-only except for explicit user-requested creation of one work session                                  |
| New work session             | OpenCode's configured primary agent plus OpenLive's selected model; attach only after manager confirmation |
| Attachment lifetime          | Current OpenLive call only                                                                                 |
| Return to manager            | End the call; the next call starts in manager mode                                                         |
| In-call detach               | Not included initially                                                                                     |
| Session selector in OpenLive | Not included initially                                                                                     |
| Concurrency                  | At most one OpenLive call per project                                                                      |
| Passive monitoring           | Not included while OpenLive ignores unsolicited turn updates                                               |
| Initial distribution         | Single installed script plus a versioned, checksummed GitHub Release adapter artifact                      |
| Remote MVP (planned)         | Local stub folder and setup command; ACP over the existing web port; adapter and tools remain in the VM    |

## 3. Why the Adapter Will Not Use A2A as Its Only Backend

The existing `opencode-a2a==1.2.0` sidecar is valuable and remains supported. It already points at the same `opencode web` process used by Web UI and attached TUI clients.

It is not sufficient as the only backend for this adapter:

- Session list/get projections omit important OpenCode metadata such as titles and timestamps.
- Message history is projected as concatenated text and loses reasoning, tools, files, and structured parts.
- The standard streaming path cannot select the dedicated manager agent per request.
- Private asynchronous prompts do not provide the complete streaming lifecycle needed by OpenLive.
- Some cancellation and event-correlation cases require direct OpenCode session and event APIs.

The adapter therefore uses `@opencode-ai/sdk` directly. A2A remains available to external orchestrators and may reuse parts of the new internal core later only when there is a concrete need. This plan does not refactor the existing A2A implementation.

## 4. Current Architecture

```text
                                      +-- Web UI
                                      +-- attached TUI
                                      +-- A2A sidecar
                                      |
OpenLive -- ACP stdio --> Voice Session Core -- OpenCode SDK --> opencode web
```

Runtime ownership:

| Resource                               | Owner                                          |
| -------------------------------------- | ---------------------------------------------- |
| VM creation, start, stop, and deletion | `opencode-vm web` lifecycle                    |
| `opencode web` process                 | Web runtime supervisor                         |
| XDG state synchronization              | Web runtime and existing session cleanup       |
| A2A sidecar and proxies                | Web runtime                                    |
| ACP stdio process                      | OpenLive launcher                              |
| Current voice-call route               | Voice Session Core                             |
| Persistent manager session             | OpenCode server, referenced from session share |
| Call-local control socket              | Voice Session Core                             |

OpenLive must never start or stop the central VM/server as part of the ACP handshake. If the web runtime is unavailable, startup fails quickly with an actionable instruction to run `opencode-vm web`.

## 5. Repository Structure

The repository keeps `opencode-vm.sh` as the VM and host control plane. Concurrent protocol and call state live in the implemented TypeScript adapter:

```text
opencode-vm.sh                         VM and process control plane
adapters/openlive-acp/                 TypeScript adapter and reusable core
tests/openlive_test.sh                 host/VM lifecycle integration tests
docs or README.md                      user-facing operation and troubleshooting
```

Current adapter package:

```text
adapters/openlive-acp/
|-- package.json
|-- tsconfig.json
|-- src/
|   |-- main.ts
|   |-- acp/
|   |   `-- transport.ts
|   |-- core/
|   |   |-- call-controller.ts
|   |   `-- session-inspector.ts
|   |-- opencode/
|   |   `-- gateway.ts
|   `-- manager/
|       |-- manager-session.ts
|       |-- control-server.ts
|       `-- tool.mjs
|-- src/*.test.ts
`-- tests/opencode-tool-integration.mjs
```

Responsibilities:

| Component                    | Responsibility                                               |
| ---------------------------- | ------------------------------------------------------------ |
| `main.ts`                    | Parse trusted launcher configuration and compose components  |
| `acp/transport.ts`           | ACP v1 JSON-RPC over stdin/stdout only                       |
| `core/call-controller.ts`    | Call lifecycle, route, active turn, cancellation             |
| `core/session-inspector.ts`  | Project-scoped list/read/status/create and attach validation |
| `opencode/gateway.ts`        | Narrow typed wrapper around OpenCode SDK and SSE             |
| `manager/manager-session.ts` | Create, validate, and reuse the persistent manager           |
| `manager/control-server.ts`  | Authenticate manager tool calls over a Unix socket           |

The core must not expose ACP or A2A wire types. A future HTTP/WebSocket voice client should be able to call the controller without importing the ACP transport. No generic plugin framework, command bus, or universal protocol abstraction will be created.

## 6. Technology and Version Strategy

- The implemented adapter uses TypeScript on Node.js 22 or newer.
- `@agentclientprotocol/sdk@1.2.1` and `@opencode-ai/sdk@1.18.21` are pinned in the source package; the deterministic integration test runs against OpenCode `1.18.21`.
- Adapter dependencies and production JavaScript are prepared when the web runtime starts, never during OpenLive's ACP startup window.
- ACP startup performs bounded health, manager, model, and effective-tool checks and fails clearly when the central runtime is unavailable or incompatible.
- Full tuple reporting and rejection in `openlive doctor` remains future compatibility work; the release supports the tested tuple rather than claiming a broad compatibility matrix.

The implementation uses the official SDKs instead of maintaining handwritten copies of their complete schemas. The adapter defines only narrow internal domain types for the exact fields it consumes.

## 7. Persistent and Ephemeral State

Implemented durable state in the project session share:

```text
<session-share>/openlive/runtime.json
<session-share>/openlive/manager.json
```

`runtime.json` contains only non-secret runtime metadata:

```json
{
  "schema": 1,
  "project": "/canonical/project/path",
  "backendUrl": "http://127.0.0.1:4095",
  "generation": "opaque-runtime-generation",
  "opencodeVersion": "1.x.y"
}
```

`manager.json` contains the manager reference:

```json
{
  "schema": 1,
  "project": "/canonical/project/path",
  "sessionId": "ses_..."
}
```

Both files are written atomically. Neither file contains credentials.

Call-local state lives only in adapter memory and the VM-local control socket:

```text
/tmp/ocvm-openlive/<project-hash>/control.sock
```

The current target session, active request, cancellation state, and inline frames are not persisted as adapter state. The socket is removed on normal exit, EOF, and signal cleanup. Frames sent to OpenCode are normal message parts and therefore remain in OpenCode session history.

## 8. ACP Session Semantics

OpenLive's ACP session is an outer voice-call/session identity, not the target OpenCode work-session identity.

`session/new` returns an adapter ID shaped like:

```text
ocvm:<project-hash>:<random-id>
```

`session/load` accepts only IDs whose project hash matches the current project. It always restores the persistent manager as the initial route. A previously attached target is deliberately not restored.

This separation provides the required behavior:

- Reopening an OpenLive conversation can reload manager history.
- A new or resumed voice call always begins in manager mode.
- Work-session attachment remains call-local.
- Multiple historical OpenLive chats do not need separate persistent manager sessions.

Replay is bounded and initially includes recent user/assistant text. Rich replay can be added after the minimal baseline. The adapter must not duplicate OpenLive's locally retained history when `session/load` succeeds.

## 9. Call State Machine

The controller uses three orthogonal state fields:

```text
lifecycle: opening | open | closing | closed | failed
route:     manager | attached(targetSessionId)
turn:      idle | running(backingSessionId, requestId) | cancelling
nextRoute: optional attached(targetSessionId)
```

Required transitions:

```text
open call
  opening -> manager/idle

manager prompt
  manager/idle -> manager/running -> manager/idle

attach requested during manager turn
  nextRoute=attached(target)
  manager response completes
  -> attached(target)/idle

create requested during manager turn
  create configured work session
  nextRoute=attached(created target)
  manager response completes -> attached(created target)/idle
  manager response fails/cancels -> delete unconfirmed target

attached prompt
  attached/idle -> attached/running -> attached/idle

cancel
  */running -> */cancelling -> same route/idle

close or ACP EOF
  any -> closing
      -> abort active adapter-owned turn if necessary
      -> discard attached route
      -> remove call-local state
      -> closed
```

Attach or create-and-attach is committed only after the manager's confirmation turn completes. This prevents manager output and target-session output from interleaving in one ACP turn. A newly created but unconfirmed target is removed with bounded cleanup.

## 10. Management Session

One persistent manager session is created per project and remains visible in Web UI/TUI with a clear title such as:

```text
OpenLive Manager: <project-name>
```

The manager is a dedicated OpenCode agent that is read-only except for explicit work-session creation. It may:

- List project sessions.
- Inspect session status.
- Read bounded session history.
- Read session diffs and todos after the baseline phase.
- Read project files needed to discuss a report.
- Ask for clarification when titles are ambiguous.
- Request attachment to one exact session ID.
- On explicit user request, create one work session with OpenCode's configured primary agent and OpenLive's selected model.

The manager may not:

- Edit or create project files.
- Run arbitrary shell commands.
- Mutate, compact, revert, share, or delete work sessions.
- Create a work session without an explicit user request.
- Attach to sessions outside the current project.
- Select an ambiguous session title silently.

Session content returned to the manager is untrusted data. Tool output must delimit it clearly and cap message count, text size, diff size, and todo count.

"Summarize session" means read a bounded history and let the manager produce a spoken summary. It must not call OpenCode's mutating session-compaction/summarization endpoint.

## 11. Manager Tool and Control Channel

The managed OpenCode tool is named `voice_sessions` and accepts a typed action rather than separate loosely related tools.

Implemented MVP actions:

```text
list
status
read
attach
create
```

Post-MVP actions:

```text
diff
todo
```

The tool runs in the central OpenCode server process. It communicates with the active adapter through the Unix socket under `/tmp/ocvm-openlive/<project-hash>/control.sock`.

Security rules:

- Socket mode is `0600`.
- Only one adapter owns the socket for a project.
- Every request carries the calling OpenCode session ID.
- Every request also carries the calling assistant message ID and an expiry deadline.
- The adapter accepts control operations only from the manager session recorded in `manager.json` and the active manager voice turn.
- `attach` validates project ownership and target existence.
- `create` is bounded by the active control request, persists agent/model at creation, defers route switching, and rolls back an unconfirmed session.
- The manager tool cannot detach or redirect another call.
- Tool requests and responses contain no A2A or ACP credentials.

OpenCode's custom-tool context exposes both calling session and message IDs. The deterministic OpenCode integration test verifies that the tool schema reaches the provider and that the authenticated control result returns to the model.

## 12. Session Inspection and Attachment Rules

All session queries are scoped to the canonical project directory.

Listing rules:

- Query all root work sessions for exact total and busy counts.
- Exclude the manager session and child/subagent sessions from the normal spoken list.
- Include session ID, title, last-updated time, and current status.
- Return only the 20 most recently updated details to the manager, with bounded titles, while keeping totals exact.

Title resolution rules:

- Exact session ID always wins.
- One exact normalized title match may be selected.
- Multiple title matches require clarification.
- Fuzzy matching may suggest candidates but may not attach automatically.

Read rules:

- Reading a busy session is allowed.
- Return bounded user/assistant history.
- Do not return raw attachment bytes or unlimited tool output.
- Reasoning is excluded from manager inspection by default.

Attach rules:

- Target must exist and belong to the current project.
- Target must not be the manager session.
- Target must be idle when attach is requested.
- Target status is checked again before every attached prompt.
- A race with Web/TUI after the check remains possible; OpenCode is the final concurrency authority.
- The adapter never retries an uncertain prompt automatically because duplicate execution could duplicate edits.

The direct OpenCode SDK path does not create or rely on A2A ownership claims.

## 13. OpenCode Event Handling

The adapter subscribes to OpenCode SSE and waits for `server.connected` before submitting a prompt. It filters events by:

- Canonical project.
- Current backing session ID.
- Unique user message ID and admitted assistant parent/message IDs.
- Current route generation.

The prompt response and SSE stream must be deduplicated so final text is not emitted twice.

The implemented transport boundary emits only text or thought updates plus the final turn result. Internally, the gateway recognizes text/reasoning deltas, tool/status activity, terminal errors, permission/question requests, and connection loss. Rich ACP activity objects remain future work.

Implemented safeguards include:

- message/part-aware streamed-versus-final deduplication;
- buffering unknown-role parts until the assistant relationship is known;
- rejection of concurrent work and preservation of uncertain backend ownership;
- bounded substantive-progress watchdogs plus OpenLive-compatible silent keepalives;
- actionable handoff to Web UI/TUI when permission or question interaction is required.

## 14. Minimal Functional Baseline (MVP)

The MVP is intentionally narrower than full feature parity. It must prove the architecture and core workflow before implementing every OpenCode event type.

### 14.1 MVP scope

- `opencode-vm web` is required and remains the sole OpenCode runtime.
- Custom TypeScript adapter starts within OpenLive's timeout.
- ACP `initialize`, `session/new`, `session/load`, `session/prompt`, and `session/cancel` work.
- Protocol stdout is clean NDJSON; diagnostics use stderr.
- Persistent manager session is created, validated, and reused.
- The first successful manager turn reports exact project-session and busy counts and offers existing-session attach or new-session creation.
- Manager has `list`, `status`, `read`, `attach`, and explicit `create` actions.
- Manager can discuss bounded text history from another session.
- Attach and create-and-attach are deferred until the manager response completes.
- New sessions persist OpenCode's configured primary agent and OpenLive's selected model; unconfirmed creations are rolled back.
- Attached text prompts run in the exact target session.
- Text responses stream back to OpenLive.
- OpenLive exposes connected tool-capable OpenCode models through the ACP model selector; existing work sessions retain their own agent, model, and reasoning variant.
- Per-turn JPEG camera/screen frames are validated, bounded, and sent to vision-capable models.
- Basic provider/session errors are surfaced clearly.
- Busy targets are rejected before attach and before prompt.
- Cancellation, EOF, close, signal cleanup, bounded liveness, and interaction-required handoff are implemented.
- Ending the call clears the target route.
- The next call begins in the manager session.
- The existing one-call-per-project lock remains enforced.

### 14.2 MVP exclusions

- Passive display of turns initiated in Web UI/TUI.
- In-call detach.
- Session selector config option.
- Rich replay of tools, reasoning, and files.
- Continuous video and generic non-JPEG media or file attachments.
- ACP rendering parity for tool cards, plans, diffs, usage, permissions, and questions.
- Mobile or remote voice transport in the local baseline; the separately approved remote desktop MVP is specified in section 29.
- Multiple projects in one voice call.
- Multiple simultaneous OpenLive calls to one project.

### 14.3 MVP acceptance scenario

1. Record the exact OpenLive macOS version/build and fully quit OpenLive before testing freshly staged adapter code.
2. Install the release bridge with `opencode-vm openlive install`, then start `opencode-vm web` in a test project. A source checkout may be used only when explicitly validating the development fallback.
3. Create a work session in Web UI, give it a recognizable title, and send at least one message.
4. Connect OpenLive to the project and make a first request.
5. Verify the first successful manager response states the exact existing-session and busy counts and offers an existing or new session.
6. Ask the manager to summarize the known session, resolve ambiguity if needed, and attach to its exact idle session ID.
7. Send one new voice prompt and verify its prompt and answer appear under the unchanged target session ID in Web UI/TUI.
8. End the call, start another call, and verify it returns to the same persistent manager rather than the prior work session.
9. Explicitly ask the manager to create a new work session and verify the confirmation says the next prompt will continue there.
10. Send the first work prompt and verify the new session uses OpenCode's configured primary agent and the model selected in OpenLive.
11. With a vision-capable model selected, send a turn with screen sharing and verify the JPEG frame reaches that same OpenCode session.
12. Exercise busy, deleted, ambiguous, and foreign-project target failures without changing the route or duplicating work.
13. Verify a cancelled or failed manager creation does not leave an unconfirmed blank session.
14. Verify exactly one `opencode web` and zero `opencode acp` processes were used.

The MVP is not considered complete if it creates a second OpenCode runtime or copies the target history into a new work session instead of using the original session ID.

## 15. Post-MVP Functional Parity

After the MVP passes the real OpenLive scenario, add only capabilities backed by a concrete user or compatibility need. Items already pulled forward into the MVP are recorded as implemented below.

### 15.1 Manager inspection

- Add `diff` and `todo` actions.
- Improve bounded history pagination.
- Further refine concise spoken status formatting after real-call feedback. The first-turn totals and bounded recent-session details are already implemented.
- Expose exact IDs when title resolution is ambiguous.

### 15.2 ACP activity rendering

- Reasoning chunks are already emitted as ACP thought updates, and silent thought keepalives satisfy the characterized OpenLive watchdog.
- Map tool calls and sparse tool updates.
- Map plan/todo updates.
- Map context usage and cumulative cost.
- Expand the already implemented OpenLive-compatible error extraction into richer structured activity.

### 15.3 Interaction handling

- Map OpenCode permission requests to ACP permission requests.
- Map OpenCode questions to ACP elicitations.
- Forward responses to the corresponding OpenCode request.
- Pause timeout/watchdog accounting while user input is pending.

The MVP already detects owned permission/question requests and stops with an actionable Web UI/TUI handoff instead of approving them or waiting indefinitely.

### 15.4 Model and mode behavior

- Model options are derived from connected, tool-capable OpenCode providers and exposed through the ACP model category.
- The selected model is applied explicitly to manager prompts and newly created sessions without mutating unrelated sessions.
- Existing attached sessions preserve their own current agent, model, and reasoning variant.
- Expose only mode semantics that can be mapped correctly.

### 15.5 Images and attachments

- Per-turn OpenLive camera/screen JPEG frames are implemented with base64 validation, a two-frame limit, 5 MiB per-frame and 8 MiB per-turn decoded-size limits, and a 12 MiB pre-parse ACP line limit.
- Frames are forwarded as normal OpenCode image attachments and therefore remain in session history; continuous video is not implemented.
- Add generic image/file media only with explicit MIME handling and limits.
- Store any future path-based call-local files under the protected call directory, reject traversal and symlinks, remove them on call close and stale-call recovery, and represent expired attachments clearly during replay.

## 16. Shell Integration Status

The required single-script release and source-development shell integration is implemented in `opencode-vm.sh`.

Preserved:

- OpenLive discovery and settings integration.
- Managed host shim and ownership checks.
- Non-secret host readiness marker.
- Project path canonicalization.
- ACP stdin/stdout descriptor isolation.
- Per-project OpenLive lock.

Completed replacements:

- `openlive_prepare_cmd` retained-VM preparation semantics.
- `openlive_acp_cmd` direct-ACP launch assumptions.
- `openlive_guest_script` execution of `opencode acp`.
- `openlive_resume_and_exec` ownership of VM start/stop.
- Signal cleanup that currently stops a VM started by OpenLive.

Completed additions:

- Adapter staging and version constants.
- Versioned release download, SHA-256 verification, safe archive extraction, atomic host caching, and cleanup.
- Release-package or source-checkout staging and dependency preparation during fresh and resumed web startup.
- Runtime descriptor creation/removal in the web lifecycle.
- Effective internal backend-port persistence.
- Manager agent/tool injection before the web server starts.
- Basic installation/runtime checks in `openlive status` and `openlive doctor`.
- Fast failure when the project is not in a running web session.

Future shell work is limited to broader compatibility diagnostics and protected-runtime support. Every future `opencode-vm.sh` change must continue to increment the patch component of `OCVM_VERSION`.

## 17. Installation and Distribution

The adapter must be prepared before an OpenLive call starts. The accepted release path is the installed single script plus its matching GitHub Release artifact.

Installed single-script behavior:

- `opencode-vm openlive install` downloads one versioned archive over HTTPS from the tag embedded in `opencode-vm.sh`.
- The host verifies the embedded SHA-256, rejects absolute paths and traversal, validates the package manifest, and atomically promotes it into `~/.opencode-vm/openlive/adapters/<version>-<sha256>/`.
- Reinstall and offline reuse use that verified content-addressed cache without another download.
- Once the managed bridge exists, later `opencode-vm update` runs prepare the newly pinned adapter automatically; a failed refresh remains explicit and prevents stale adapter activation.
- `openlive status` distinguishes an adjacent development source from an installed release; `openlive uninstall` removes the managed cache with the other owned integration state.

Source-development behavior:

- Resolve `adapters/openlive-acp` next to `opencode-vm.sh` before consulting the release cache.
- Build/test from local source during development.
- Stage source into the session share and install/build dependencies during fresh or resumed `opencode-vm web` startup.

Current web-start preparation:

- Stage either the adjacent source package or verified release package into the session share on fresh and resumed web starts.
- If neither is present, skip OpenLive preparation and start the otherwise independent web runtime normally.
- For source, run locked dependency installation when needed and rebuild unconditionally so non-entrypoint changes cannot leave stale JavaScript active.
- For a release, run `npm ci --omit=dev --ignore-scripts` when needed and execute the precompiled `dist/main.js`; no TypeScript compiler or source tree is required.
- Fail ACP startup quickly rather than downloading, building, cloning, or resuming a VM inside OpenLive's deadline.

The tag workflow builds the archive twice, compares it byte-for-byte, checks its digest against `opencode-vm.sh`, and publishes it with the script and `SHA256SUMS`. The release asset must be available before that script commit is exposed through `main` and `opencode-vm update`.

## 18. Runtime Preconditions and Diagnostics

Currently implemented checks cover:

- OpenLive is installed.
- The managed shim and command are active.
- A session record exists for the project.
- Session mode is `web`.
- The VM is running.
- The runtime descriptor exists.
- A missing/stopped/non-web runtime produces one concrete recovery action.

ACP startup additionally validates the descriptor schema, ACP project scope, OpenCode health, manager state, model catalog, global tool discovery, and effective model/agent permissions before accepting a call.

Future `openlive doctor` expansion should report:

- Descriptor project and running-server version agreement.
- Adapter, ACP SDK, OpenCode SDK/plugin/CLI/server, Node, and source/artifact versions.
- Manager descriptor, tool, socket, and stale-lock state.
- Protected-runtime authentication state without exposing credentials.

Expected recovery messages should name one concrete action, for example:

```text
Start the central runtime first:
  cd /path/to/project && opencode-vm web
```

OpenLive startup must not attempt expensive repair, package installation, VM cloning, or VM resume inside its startup deadline.

## 19. Security Requirements

- Keep OpenCode backend and the manager control socket on VM loopback/local filesystem only.
- Do not write provider credentials, web passwords, or A2A credentials to descriptors or logs.
- Do not pass secrets in process arguments.
- Canonicalize and compare project paths before every session operation.
- Refuse additional workspace roots from ACP.
- Do not inject ACP-supplied MCP servers into the shared central runtime.
- Validate manager session ID on every control-socket request.
- Treat session titles, messages, diffs, todos, tool output, and model output as untrusted.
- Cap all manager inspection results before adding them to model context.
- Do not expose raw reasoning by default.
- Never auto-select among ambiguous session names.
- Never automatically retry a potentially mutating prompt.
- Only abort the adapter-owned active turn on ACP cancellation.

## 20. Concurrency Rules

- Retain one OpenLive call per project for the current implementation.
- Permit exactly one prompt in flight per call.
- Different OpenCode sessions may continue to work concurrently.
- Read-only manager inspection may query a busy session.
- Attachment and prompting require an idle target.
- Subscribe to SSE before sending a prompt.
- Filter late events using backing session ID and route generation.
- Ignore events from unrelated Web/TUI/A2A turns.
- Do not assume a process-local lock protects against Web/TUI races.
- If server state becomes uncertain, report the error and require the user to inspect the Web UI rather than guessing whether a turn ran.

## 21. Testing Strategy

Current automated release gate:

- TypeScript no-emit check and production build.
- 41 adapter unit/contract tests covering call routing, deferred attach/create, rollback, cancellation, SSE correlation/deduplication, manager permissions, model selection, image bounds, ACP scope, replay, EOF, and close.
- A deterministic real OpenCode `1.18.21` integration test with a fake provider proving effective `voice_sessions` construction/execution and JPEG delivery to the provider request.
- `tests/openlive_test.sh` coverage for managed host installation, source and release staging contracts, standalone download/checksum/cache/uninstall behavior, fresh/resumed web preparation, ACP stream isolation, lock/signal behavior, and running-web preconditions.
- `bash -n`, ShellCheck at error severity, Prettier, and `git diff --check`.

### 21.1 Adapter unit tests

- Implemented coverage includes:

- Call state transitions.
- Deferred attach/create commit and failed-create rollback.
- Attachment reset on close and load.
- Busy-session rejection.
- Project-scope enforcement.
- SSE event filtering and deduplication.
- Cancellation and late-event handling.
- Session counts, statuses, configured creation settings, and inspection output limits.

Ambiguous-title behavior and stale-manager recreation remain explicit real-acceptance cases rather than claimed unit coverage.

### 21.2 ACP contract tests

- Implemented coverage includes ACP model options, scope validation, prompt text/image forwarding, line/image bounds, manager replay, close, EOF, and clean protocol streaming.
- Controller coverage supplies synthetic outer IDs, cancellation, stop reasons, and call reset behavior below the transport.
- Additional wire fixtures for malformed JSON-RPC, every error response, and richer replay remain package-B hardening.

Use a small test ACP client or the official SDK rather than testing only with opaque echoed JSON.

### 21.3 OpenCode gateway tests

Current gateway tests use mocked SDK responses and deterministic event streams for:

- Session create/list/get/messages/status.
- Prompt request and streamed text.
- Duplicate final response suppression.
- Abort behavior.
- Missing/deleted sessions.
- Provider/model failures.
- Malformed or disconnected SSE streams.

No paid or nondeterministic real model call is required for automated tests.

### 21.4 Shell integration tests

The runtime half of `tests/openlive_test.sh` covers:

- A running web session is required.
- A stopped VM is not resumed by OpenLive.
- Missing runtime descriptors fail clearly.
- The adapter receives untouched ACP stdin.
- Lifecycle output never pollutes stdout.
- Signals release the OpenLive lock and socket.
- Signals do not stop the web VM.
- Concurrent OpenLive calls are rejected.
- Project paths with spaces work.
- Managed installation preserves foreign binaries/settings and does not copy credentials into the VM boundary.
- A copied standalone script downloads and verifies the exact release archive, reports and reuses its content-addressed cache, and removes it on uninstall.
- A checksum mismatch fails before changing the shim, OpenLive settings, or cache.

Broader version-mismatch matrices, interrupted-install recovery, and protected-runtime credentials remain future work.

Preserve existing install/uninstall ownership and readiness-marker tests.

### 21.5 VM and real-application tests

- Verify exactly one OpenCode server process.
- Verify no `opencode acp` process starts.
- Verify the persistent manager survives web runtime restart.
- Verify an attached turn appears under the same target session ID in Web UI/TUI.
- Verify call close returns the next call to manager mode.
- Verify a target deleted between inspection and attach fails safely.
- Verify OpenLive startup remains within its deadline when the web runtime is healthy.
- Run the complete manual macOS/OpenLive scenario in section 14.3 and record the exact OpenLive build. This is the sole remaining package-A gate.

## 22. Documentation and Migration

Completed for the release MVP:

- `README.md` OpenLive section.
- `AGENTS.md` architecture and command descriptions.
- CLI help output.
- Basic `openlive status` and `openlive doctor` output.
- Normal installed-script setup, development-source fallback, release procedure, missing-web-runtime recovery, busy-session behavior, model selection, and screen-frame limits.

Future documentation follows only when the corresponding functionality exists: full version-mismatch diagnostics, protected runtimes, generic attachments, and retention/compaction policy.

Migration behavior:

- Existing OpenLive host settings continue to invoke the managed shim.
- The meaning of the shim changes from direct ACP runtime to the new adapter.
- Existing `prepare`-mode sessions must be started with `opencode-vm web` before OpenLive can connect.
- No compatibility path starts the old `opencode acp` runtime.
- Existing Web/TUI sessions and their data remain untouched.
- Existing A2A behavior remains untouched.

## 23. Delivery Status and Remaining Order

### Phase 0: Characterization and executable contracts - complete

Deliverables:

- ACP request/response fixtures matching OpenLive.
- OpenCode SDK/SSE event fixtures matching the provisioned version.
- Verified custom-tool caller session ID.
- Versioned, checksummed standalone artifact release decision.

Exit criterion met for the release MVP.

### Phase 1: Central runtime contract and adapter skeleton - complete

Deliverables:

- Runtime descriptor.
- Effective backend-port handling.
- Adapter install/self-heal.
- ACP initialize/new/load skeleton.
- Fast running-web precondition checks.

Exit criterion met in automated tests and the earlier real OpenLive run.

### Phase 2: Minimal functional baseline - implementation complete, real acceptance pending

Deliverables:

- Persistent manager session.
- Text prompt streaming.
- First-turn session/busy status and `list`, `status`, `read`, `attach`, and explicit `create` manager actions.
- Deferred route switching.
- Attached prompt into the exact target session.
- Cancellation, call close, and manager reset.
- ACP model selection and bounded per-turn JPEG screen frames.
- Automated MVP acceptance coverage plus the complete real OpenLive scenario.

Automated exit criteria are met. The phase closes only when A.6 and section 14.3 pass with the exact OpenLive build recorded.

### Phase 3: Interaction and activity parity - partial, future

Deliverables:

- Rich tool, plan, usage, permission, and question mapping. Reasoning-to-thought mapping and safe Web UI/TUI interaction handoff already exist.
- Mode behavior beyond the implemented model selector and per-session model preservation.
- `diff` and `todo` manager actions.
- Improved replay and error translation.

Exit criterion: normal coding turns no longer depend on a permissive/no-confirmation setup and OpenLive's Activity panel remains useful.

### Phase 4: Media, retention, and compatibility - future

Deliverables:

- Generic media/path attachments beyond the implemented per-turn JPEG frame path.
- Session-history retention policy plus attachment cleanup.
- Expanded compatibility doctor checks and protected-runtime support.
- Additional VM/compatibility tests.
- Broader compatibility and recovery coverage beyond the implemented standalone artifact flow.

Exit criterion: production-ready integration with repeatable installation and recovery.

No new estimate is assigned to phases 3-4. They are a prioritized backlog, not committed release scope.

The approved next remote desktop baseline is work package C in section 29. It depends on the existing core plus the narrow authentication work required by C, not on completion of phases 3-4.

## 24. Explicit Non-Goals

- No OpenLive fork.
- No OpenCode fork.
- No second OpenCode runtime for voice.
- No direct SQLite access.
- No separate session database.
- No event-sourcing or distributed-lock framework.
- No ACP v2 implementation until OpenLive requires it.
- No replacement of `opencode-a2a`.
- No universal protocol adapter abstraction.
- No dynamic per-call MCP registration.
- No session mutation from manager inspection; only explicit user-requested work-session creation is allowed.
- No persistent work-session attachment across calls.
- No automatic project switching.
- No mobile API before a real client requirement exists.

## 25. Risks and Mitigations

| Risk                                                      | Impact                                   | Mitigation                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode SSE events change between versions               | Broken streaming or event mapping        | Match SDK/server versions; contract fixtures; doctor check                                                                             |
| OpenLive updates its ACP behavior                         | Startup or replay incompatibility        | Pin characterized ACP SDK behavior; maintain ACP contract tests                                                                        |
| Web/TUI starts a turn after the busy preflight            | Concurrent work in one session           | Recheck before prompt; no retries; treat OpenCode as final authority                                                                   |
| Manager tool is visible outside manager                   | Unauthorized session inspection/routing  | Agent restrictions plus server-side caller-session validation                                                                          |
| Persistent manager is deleted manually                    | Voice startup fails                      | Validate and recreate from `manager.json`                                                                                              |
| Persistent manager history grows indefinitely             | Context/cost growth                      | Bounded replay; later explicit manager compaction policy if needed                                                                     |
| Repeated screen frames grow OpenCode history              | Storage, context, and vision cost growth | Per-turn limits now; define retention/compaction before calling visual sharing production-ready                                        |
| OpenLive startup exceeds its deadline                     | Agent cannot connect                     | Require running web runtime; preinstall adapter; no startup repair                                                                     |
| Release artifact is unavailable or altered                | OpenLive installation fails safely       | Publish before exposing the script through `main`; pin tag/name/SHA-256; retain a verified content-addressed cache                       |
| Prompt response and SSE both contain final text           | Duplicate speech                         | Message/part-aware deduplication and terminal-state tests                                                                              |
| Call exits during a mutating target turn                  | Uncertain completion                     | Best-effort abort; report uncertainty; never retry automatically                                                                       |
| Manager confirmation fails after creating a blank session | Duplicate/orphan session                 | Defer attachment and delete the unconfirmed session with bounded cleanup; log cleanup failure                                          |

## 26. Plan Review Gates

Gate status:

1. Complete: OpenCode custom tools expose trustworthy caller session and message IDs.
2. Complete for the tested tuple: OpenCode SDK/server `1.18.21` is installed and exercised deterministically.
3. Complete in automated coverage: text deltas correlate to one target session and active prompt.
4. Complete in automated and earlier real startup coverage: the adapter starts against an already-running web VM without owning its lifecycle.
5. Pending final A.6 reconfirmation: an attached and a newly created SDK session must visibly retain the unchanged target session ID in Web UI/TUI.
6. Pending final A.6 reconfirmation: call end must leave the central runtime untouched and reset the next call to manager mode.

If any gate fails, revise the architecture in this document before broadening implementation scope.

## 27. Definition of Done

MVP release readiness requires:

- All automated checks listed in section 21 pass.
- The complete real A.6 scenario passes on macOS with the exact OpenLive build recorded.
- First-turn status, existing-session attach, explicit creation, deferred routing, call reset, and screen-frame delivery are visible in the shared OpenCode runtime.
- Exactly one `opencode web` and zero `opencode acp` processes are involved.
- The reproducible adapter artifact is published before the referencing script reaches `main`, and installed-script setup and recovery instructions are accurate.

The broader optional integration backlog is done only when its selected scope requires and verifies:

- OpenLive uses the custom adapter and never launches `opencode acp`.
- Web UI, TUI, A2A, and OpenLive all target one `opencode web` runtime.
- One persistent manager session exists per project.
- The manager safely lists, reads, summarizes, diffs, and reports todos for project sessions when the future `diff` and `todo` actions are implemented.
- A voice call can attach to an existing Web/TUI session and continue its real context.
- Ending the call reliably returns the next call to manager mode.
- Text, tools, reasoning, plans, usage, permissions, questions, cancellation, and images have tested ACP mappings.
- Busy and ambiguous targets fail safely.
- No secret appears in protocol output, logs, descriptors, or process arguments.
- Installation, upgrade, doctor, cleanup, and documentation paths are complete.
- Automated contract, unit, shell, and VM tests pass.
- The real OpenLive MVP acceptance scenario passes on macOS.

## 28. Implementation Record and Remaining Work

Implemented across the completed iterations:

- Added `adapters/openlive-acp/`, a TypeScript ACP v1 adapter pinned to `@agentclientprotocol/sdk@1.2.1` and the currently provisioned `@opencode-ai/sdk@1.18.21`.
- Added an OpenCode SDK gateway for health, project-scoped sessions, bounded text history, prompt, abort, and SSE text-delta forwarding.
- Added an ACP call controller with synthetic outer IDs, manager-first routing, deferred attachment, cancellation, and attachment reset on call close.
- Added the persistent manager descriptor, project-local `0600` Unix control socket, and `voice_sessions` OpenCode custom tool. The tool supplies the real caller session and message IDs; the adapter accepts it only from the active turn of the persistent manager session.
- Added source-checkout and packaged-release staging into a web session, including a restricted `openlive-manager` agent and custom-tool dependency before `opencode web` starts.
- Changed the host ACP path to require a live web-mode VM and runtime descriptor. It no longer starts/resumes VMs or launches `opencode acp`.
- Added runtime descriptor creation/removal in both fresh and attached web lifecycles.
- Updated OpenLive lifecycle tests, README, and AGENTS architecture documentation.
- Added a controller regression test covering deferred attach and call-local route reset.

Validation completed:

- `npm run check && npm run build && npm test` in `adapters/openlive-acp/`.
- `bash tests/openlive_test.sh`.
- `bash -n opencode-vm.sh tests/openlive_test.sh tests/helpers/mock-limactl`.
- `shellcheck -s bash -S error opencode-vm.sh tests/openlive_test.sh tests/helpers/mock-limactl`.
- `git diff --check`.

Stabilization completed after the first macOS startup attempt:

- Fixed `openlive_stage_adapter` under `set -u` by separating dependent local assignments. The failed attempt stopped before creating a replacement session VM.
- Treat OpenCode sessions omitted from `/session/status` as idle and expose real busy/idle values in manager listings. OpenCode intentionally removes idle sessions from this map.
- Create the runtime descriptor after the web proxy resolves its final backend port in both fresh and resumed web lifecycles.
- Reserve the internal `openlive-manager` agent name, reject conflicting user definitions, and remove the injected agent during config sync-back without touching other agents.
- Set the manager control socket to `0600`, make close idempotent, and remove the socket when ACP stdin reaches EOF as well as on signals.
- Added gateway status and control-socket regression tests. The adapter suite now contains four passing tests.
- Bumped the script patch version to `0.5.25` and documented that pre-release testing must invoke the source-checkout script directly.
- Fixed the second macOS startup finding: the runtime-descriptor `jq` filter now preserves its variables inside the enclosing quoted guest script instead of expanding an unset host `$project`. Added a shell regression assertion for both fresh and resumed paths and bumped the patch version to `0.5.26`.
- Reproduced OpenLive's generic `stopped responding` path against a real OpenCode 1.18.21 server: ACP initialization and `session/new` succeed with an empty MCP list, while rejecting OpenLive's `.mcp.json` passthrough aborts the handshake and the UI hides the detail. Client-provided MCP definitions are now ignored, never executed, while additional workspaces remain rejected. Added scope regression tests and bumped the patch version to `0.5.27`.
- Fixed OpenLive reading its own voice preamble and user question aloud. The OpenCode event stream publishes text parts for both user and assistant messages, sometimes before the corresponding role event; the gateway now buffers unknown-role text, emits only confirmed assistant parts, drops user parts, and keeps duplicate-delta suppression. Added an ordering/echo regression test and bumped the patch version to `0.5.28`.
- Fixed deployment of adapter source-only changes: staging excludes `dist/`, but the guest previously rebuilt only when `main.ts` was newer, so the user-echo fix in `gateway.ts` remained uncompiled on re-attach. Both fresh and resumed web starts now rebuild the small adapter unconditionally after dependency preparation. Added a shell regression assertion and bumped the patch version to `0.5.29`.
- Fixed OpenLive's 30-second first-output watchdog during long model reasoning. OpenCode reasoning parts are now forwarded as ACP `agent_thought_chunk` updates, which OpenLive treats as activity without speaking them as answer text; visible assistant text remains `agent_message_chunk`. This avoids fake acknowledgments and preserves the model's real stream. Bumped the patch version to `0.5.30`.
- Added an immediate spoken acknowledgment (`OK`) when the adapter accepts a prompt. OpenLive installs its turn emitter before sending the request, so the language-neutral acknowledgment reliably satisfies the 30-second first-output watchdog while OpenCode starts model work; genuine reasoning then refreshes the normal 60-second stall window and final-response fallback remains independent. Prompt and manager-control lifecycle diagnostics are appended without prompt content to the private session `adapter.log`. Bumped the patch version to `0.5.32`.
- Fixed the remaining mid-answer timeout: OpenCode 1.18.21 emits ongoing text and reasoning primarily as runtime `message.part.delta` events, although the pinned legacy SDK event union omits that variant. The gateway now consumes those deltas, treats busy and tool-state events as silent activity, and logs only event kinds/statuses for diagnosis. `OK.` includes a sentence boundary so OpenLive TTS flushes it promptly. Bumped the patch version to `0.5.33`.
- Added a prompt keepalive after a real call showed the provider could remain busy without emitting content for longer than OpenLive's 60-second stall timeout. The bridge now sends a silent thought update every 20 seconds while the OpenCode prompt is pending, uses the more reliably pronounced `Okay.` acknowledgment, and strips OpenLive's fixed voice preamble before storing the user turn. Voice-response rules live on the manager agent instead, while user-specific OpenLive instructions remain in the prompt. Bumped the patch version to `0.5.34`.
- Corrected the acknowledgment against OpenLive's actual `SentenceChunker`: initial TTS fragments shorter than 24 characters are deliberately buffered until the turn ends, so `Okay.` could only be heard after a later error completed the turn. The bridge now opens with the exactly 24-character `Okay, one moment please.` and uses empty reasoning keepalives, which still refresh OpenLive's supervisor watchdog without filling the visible work transcript. Bumped the patch version to `0.5.35`.
- Added ACP-native model selection after diagnostics showed a new manager session silently inherited OpenCode's stale `CLI-Proxy` default instead of the GPT Luna model selected in a normal web session. The adapter now advertises connected, tool-capable OpenCode models as a `category: model` config option, initializes it from the latest non-manager project session, accepts OpenLive's remembered model choice, and passes the selection explicitly with every manager prompt. Attached work sessions retain their own model and reasoning variant, and an empty tool-capable catalog now fails clearly instead of reintroducing an implicit fallback. Bumped the patch version to `0.5.36`.
- Fixed the missing `voice_sessions` tool after a successful GPT Luna conversation showed that the manager received no session tool schema. OpenCode auto-discovers only `plugin(s)/*.{js,ts}`, while the bridge had staged `openlive-voice-sessions.mjs`; staging now removes that ignored file and installs the same ESM plugin as `.js`. Added a discovery-filename regression and bumped the patch version to `0.5.37`.
- Replaced the server-plugin wrapper with OpenCode's direct custom-tool mechanism after a retest still lacked `voice_sessions`. The bridge now stages a default tool definition at `tools/voice_sessions.js`, removes both obsolete plugin filenames, and verifies through OpenCode's tool-ID endpoint before accepting an ACP connection. A missing tool therefore fails at startup with a concrete diagnostic instead of allowing a manager conversation that cannot inspect sessions. Bumped the patch version to `0.5.38`.

Package A implementation update at `opencode-vm` `0.5.41` / adapter `0.1.3`:

- The adapter now uses the OpenCode SDK v2 surface, verifies `/global/health`, verifies `voice_sessions` through model-aware tool construction, and reports the effective manager model, agent, and relevant permissions at startup.
- A deterministic OpenCode 1.18.21 integration test with a local fake provider proves that the final provider request contains the `voice_sessions` schema, OpenCode executes the requested tool through the authenticated control socket, returns the tool result to the provider, and completes the manager turn.
- Every adapter prompt has its own OpenCode user message ID. SSE consumption waits for `server.connected`; assistant messages must reference that user message as `parentID`; streamed and final text are reconciled by message and part.
- Active turns are reserved before asynchronous preflight, carry a generation and backend-ownership state, and govern cancel, failed deferred attach, EOF, close, and shutdown behavior. The custom tool also sends its caller message ID, so control requests are accepted only from the active manager turn.
- Synthetic keepalives are bounded by substantive backend progress. Concurrent work and active permission/question requests preserve the backend and direct the user to Web UI/TUI instead of aborting work with uncertain ownership.
- `session/load` resets routing to the persistent manager and replays bounded recent manager text before returning.
- OpenLive now advertises ACP image support and forwards the freshest per-turn camera/screen JPEG frames to vision-capable OpenCode models. Input is bounded before JSON parsing and again by decoded per-frame/per-turn limits; text-only models fail clearly.
- The first successful manager turn reports the exact project-session and busy counts. The manager can create a work session only on explicit request, persists the selected model and configured primary agent at creation, attaches after a successful confirmation, and removes an unconfirmed creation after failure or cancellation.
- Automated validation passes: TypeScript check, production build, all 41 adapter tests, the real OpenCode 1.18.21 manager-tool and image-provider integration test, `tests/openlive_test.sh`, `bash -n`, ShellCheck at error severity, and `git diff --check`.
- The earlier real macOS run established ACP setup, central-runtime reuse, model selection, basic streaming, and screen sharing. A fresh run of the complete section 14.3 scenario is still required; package A is not accepted until A.6 passes with the exact OpenLive build recorded.

Release-distribution update at `opencode-vm` `0.5.43` / adapter `0.1.3`:

- Added a reproducible GNU-tar builder that emits the manifest, compiled production JavaScript, lockfiles, manager tool, and license without source, tests, or `node_modules`.
- Added pinned tag, filename, adapter version, and SHA-256 metadata to the single script. `openlive install` downloads only over HTTPS, verifies before extraction, rejects unsafe paths, validates the manifest, and atomically installs a content-addressed host cache.
- Fresh and resumed web starts now distinguish local development source from a packaged release. Development source is rebuilt; packaged releases install only locked production dependencies with lifecycle scripts disabled and run their precompiled output.
- Added standalone-copy tests for download, checksum rejection, cache reuse, status, uninstall, and side-effect-free failure, plus a tag-driven GitHub workflow that checks metadata consistency, runs all adapter/shell tests, proves reproducibility, and publishes the script, adapter, and `SHA256SUMS`.
- Hardened cache activation and staging with explicit failure handling, rejected archive links, added automatic adapter refresh for an already installed bridge during `opencode-vm update`, and covered activation failure plus packaged entry-point/tool execution.
- The release remains blocked until that artifact is published under `v0.5.43` before the same script commit is made visible through `main`, and until A.6 passes.

### Work Package A: Complete the Functional MVP Baseline

Implementation and automated validation are complete. The package now contains no planned code work; it ends when the regular installed-script path is published in the required order and passes the complete real scenario in section 14.3 with a trustworthy turn lifecycle. Broad feature parity and optional compatibility work must not be pulled into this package unless a reproducible A.6 failure makes a correction necessary.

#### A.1 Prove and fix the effective manager tool path - complete

The effective tool path is implemented and covered by the real OpenCode `1.18.21` fake-provider integration test.

Completed checklist:

1. After selecting the manager model, query `client.tool.list({ query: { provider, model } })` and require `voice_sessions` with the expected schema. Keep the existing global `tool.ids()` check only as the earlier discovery check.
2. Inspect and log the effective manager agent name, model, agent permission rules, persisted manager-session permission rules, and user-message tool flags. Log only tool names and non-secret diagnostic fields.
3. Add a deterministic integration test through a real OpenCode server and a fake local provider. The provider must assert that the final model request contains `voice_sessions`, return a fixed `list` tool call, receive its result, and complete the turn. This proves the complete OpenCode tool-construction and execution path without a real model call.
4. Compare a fresh diagnostic manager session with the persistent manager session if the deterministic path succeeds but the real provider still omits or ignores the tool. This distinguishes stale session state/history from provider transformation or model-selection behavior without deleting the persistent manager first.
5. Do not weaken the manager's deny-by-default policy or bypass caller-session validation. An explicit prompt `tools: { voice_sessions: true }` is not a temporary diagnostic in OpenCode 1.18.21: it replaces the session's persisted permission rules. If this mechanism is required, use it only as an intentional manager-session permission update and assert that all editing, shell, task, and unrelated inspection tools remain denied.
6. Extend control requests with the custom-tool caller `messageID` in addition to `sessionID`, and accept an attach request only from the active manager turn. OpenCode exposes both values to custom tools; checking only the persistent manager session does not distinguish the active OpenLive turn from another client using that session.

Acceptance criterion: one real OpenLive manager turn produces an effective `voice_sessions` schema at the provider boundary, a `voice_sessions` tool event, and the matching authenticated control-socket operation. A model statement that the tool is unavailable is diagnostic output, not proof of the request schema.

#### A.2 Make one voice turn attributable and complete - complete

Prompt-scoped correlation, final-response reconciliation, and uncertain-backend handling are implemented and tested.

Completed checklist:

1. Start consuming the SSE stream and wait for OpenCode's `server.connected` event before submitting the prompt. Awaiting the SDK's lazy async iterable alone does not prove that the server-side listener is registered.
2. Supply a unique OpenCode user `messageID` for every adapter prompt. Admit assistant events only when their `parentID` refers to that message, and correlate parts to the admitted assistant message IDs.
3. Add a route/turn generation and ignore late events after cancel, failure, attachment change, or call close.
4. Replace the turn-wide `emittedText` fallback flag with message/part-aware reconciliation. A streamed prefix must not suppress a missing final suffix, and the final HTTP response must not duplicate text already emitted through SSE.
5. Handle terminal assistant errors, `session.error`, malformed/disconnected SSE, and an uncertain completion explicitly. Never retry a prompt automatically after submission may have succeeded.
6. Preserve the attached session's effective agent, model, and reasoning variant deliberately. Omitting these fields is not sufficient in OpenCode 1.18.21 because prompt creation can select the default agent and persist a changed session model or variant.

Acceptance criterion: interleaved events from other sessions, old turns, user-message echoes, and reordered role/part events cannot enter the voice response; the owned answer is emitted exactly once and in full.

#### A.3 Correct cancellation, closure, and deferred attachment - complete

Completed checklist:

1. Reserve the active turn before any asynchronous busy or attachment preflight so two prompts cannot pass the initial guard concurrently.
2. Abort the OpenCode session only when this adapter has an active, submitted turn. Cancelling an idle ACP session must not call the backend abort endpoint.
3. Propagate the abort signal into stream and prompt requests where the SDK supports it, settle the ACP prompt with `stopReason: "cancelled"`, and use bounded cleanup waits.
4. Clear a pending attachment on every cancelled or failed manager turn. Commit it only after that same manager turn completes successfully.
5. Route ACP EOF, `SIGINT`, `SIGTERM`, explicit call close, and prompt cancellation through one idempotent cleanup path. It must settle adapter-owned work, discard the attachment, remove the call, release the socket and lock, and leave the central web runtime untouched.
6. Document and test the backend limitation: OpenCode's abort endpoint is session-wide, not request-scoped. If Web/TUI activity races with a voice prompt in the same session, report an uncertain ownership state and require inspection in Web UI; do not claim that another client's work cannot be affected and do not retry.
7. Persist agent/model settings when creating a work session and remove an unconfirmed creation after manager failure, cancellation, expiry, or disconnect.

Acceptance criterion: idle cancel, preflight cancel, generation cancel, EOF, and signals leave no stale call or attachment, and no cleanup operation stops the central runtime or aborts an unrelated session in the normal tested path.

#### A.4 Bound liveness and unsupported interactions - complete

The spoken opening and empty thought keepalives are confirmed to satisfy the characterized OpenLive watchdog. They must remain compatibility signals, not evidence that the backend is healthy.

Completed checklist:

1. Keep the 24-character-or-longer opening acknowledgment and the current silent keepalive behavior while the owned prompt is healthy.
2. Add bounded startup, SSE-connect, cancellation, and cleanup waits. Stop keepalives immediately after terminal failure, disconnect, cancellation, or uncertain backend state.
3. Define and test a maximum period in which a provider may remain busy without meaningful backend progress. A synthetic keepalive must not conceal a permanently blocked provider.
4. Detect permission and question requests belonging to the active turn. For the text MVP, terminate with a bounded actionable response directing the user to Web/TUI rather than silently approving or waiting forever. Full ACP permission and elicitation rendering remains in package B.

Acceptance criterion: a healthy reasoning-free delay survives OpenLive's watchdog, while a disconnected, failed, interaction-blocked, or never-settling backend reaches a bounded terminal outcome.

#### A.5 Complete minimum `session/load` behavior - complete

Completed checklist:

1. Every successful `session/load`, including an ID still present in adapter memory, resets the route to the persistent manager and discards any prior target attachment.
2. Reject or first settle a load attempted during an active turn.
3. Replay bounded recent manager user/assistant text before returning the load response, without duplicating history already retained by OpenLive.
4. Keep the current bounded replay as an explicitly documented MVP limitation. ACP specifies replay of the entire conversation, so bounded text replay must not be described as full ACP replay conformance.

Acceptance criterion: loading a previous outer ACP ID always resumes in manager mode, provides useful recent text to an empty client, and does not duplicate an OpenLive-retained transcript.

#### A.6 Run the complete real acceptance scenario - pending

With A.1 through A.5 complete, run all of section 14.3 on macOS with the exact tested OpenLive build recorded and verify:

- Manager `list`, `status`, and bounded `read` use the real control tool.
- The first successful manager turn states the exact number of existing project sessions and how many are busy, then offers existing-session attachment or new-session creation.
- An explicit request creates one work session with the selected OpenLive model and configured primary agent; manager failure or cancellation does not leave an unconfirmed blank session.
- An ambiguous title requires clarification; an exact target can be attached only while idle.
- Attachment is committed after the manager confirmation turn.
- The next voice prompt and answer appear under the unchanged target OpenCode session ID in Web UI/TUI.
- A screen-shared turn reaches the same session as a JPEG image part when a vision-capable model is selected.
- Closing the call discards the target route; the next call uses the same persistent manager session.
- Busy, deleted, and foreign-project targets fail safely.
- Exactly one `opencode web` and zero `opencode acp` processes are involved.
- Adapter source changes are tested after a web-runtime restart and full OpenLive quit/relaunch so both OpenCode tool discovery and the ACP child process use the new build.

Package A exit criterion: the complete scenario in section 14.3 passes, all package-A automated regressions pass, and the remaining constraints are documented without being misrepresented as MVP capabilities.

### Work Package B: Compatibility and Feature Improvements - future

This package starts only after package A passes and only for items backed by a concrete need. Its items improve compatibility, protocol parity, diagnostics, and robustness beyond the standalone release baseline.

#### B.1 Standalone distribution - implemented; controlled compatibility - future

Implemented release baseline:

1. Publish a versioned adapter archive containing a manifest, compiled production JavaScript, `package.json`, `package-lock.json`, the manager tool, and applicable license files. Exclude tests and development-only output.
2. Embed the exact artifact tag, filename, SHA-256, adapter version, and supported OpenCode version tuple in `opencode-vm.sh`. Never execute a floating `main` artifact.
3. Download and verify the archive on the host, reject unsafe archive paths, validate its manifest, and atomically activate a content-addressed host cache under `~/.opencode-vm/openlive/adapters/`.
4. Stage `tools/voice_sessions.js` as a small wrapper around the packaged manager tool while retaining the existing pinned OpenCode plugin dependency in the generated session config. Verify this wrapper through real OpenCode discovery and execution tests.
5. Stage the package during fresh and resumed web startup, install production dependencies from the lockfile with lifecycle scripts disabled, and execute precompiled output. ACP startup itself performs only fast validation and execution.
6. Build twice and compare output in the tag workflow, verify release metadata and the embedded digest, then publish the archive, script, and checksum file.
7. Publish the checksummed artifact before making a script version that references it available through the existing update path.

Future compatibility work:

- Pin and report the complete tested tuple of adapter, ACP SDK, OpenCode SDK/plugin/CLI/server, and Node runtime rather than claiming broad compatibility.
- Expand interrupted-install, offline, concurrent-preparation, and recovery coverage if field failures make it necessary.

#### B.2 Doctor and protected-runtime compatibility

1. Extend `openlive doctor` to report expected and observed adapter, ACP SDK, OpenCode SDK, plugin, CLI, running-server, Node, and artifact versions, plus descriptor, manager, tool, socket, and health state.
2. Query the running server's `/global/health` version rather than relying only on the installed CLI or `project.current()`.
3. Support password-protected OpenCode web runtimes by reusing the existing `0600` session `auth.env` channel and applying Basic authentication consistently to HTTP and SSE. Never place credentials in runtime descriptors, process arguments, stdout, or diagnostics.
4. Test missing and incorrect credentials, custom usernames, stale descriptors, CLI/server disagreement, corrupt installations, interrupted repair, and operation without an adjacent source checkout.

#### B.3 ACP and activity parity

- Map tool calls and sparse updates into rich ACP activity instead of keepalive-only thought events.
- Enrich the implemented reasoning thought chunks with plans/todos, usage, cumulative cost, and provider/session error details.
- Map OpenCode permission requests to ACP permission requests and questions to capability-gated ACP elicitations, including correlation, replies, cancellation, and paused watchdog accounting.
- Add complete replay for tools, reasoning, files, and other supported history so `session/load` can approach full ACP replay conformance.
- Extend the implemented inline JPEG frame path to generic media or path-based attachments only after format-specific validation, traversal, symlink, expiry, and cleanup rules are implemented and tested.
- Add the manager `diff` and `todo` actions, bounded pagination, and concise spoken formatting.

#### B.4 Broader hardening and test coverage

- Add deterministic fake HTTP/SSE gateway tests for health, sessions, prompts, aborts, errors, duplicate suppression, delayed connection, malformed events, and disconnects beyond package A's required focused cases.
- Add ACP wire-contract fixtures for initialize, new, load, prompt, cancel, JSON-RPC errors, replay ordering, strict stdout, EOF, and signals.
- Extend packaging tests across additional supported architectures and Node versions, and add concurrent preparation or interrupted atomic-promotion scenarios when required.
- Revisit passive monitoring, richer replay pagination, multiple clients, and request-scoped cancellation only if OpenLive or OpenCode gains the required protocol/runtime support. Do not simulate guarantees the backend does not provide.

#### B.5 Optional call UX and retention

- Consider in-call detach or return-to-manager only if OpenLive can present the transition without surprising the user.
- Consider a session-selector config option only if it can preserve exact-ID and busy-state safety.
- Define manager-history and repeated-screen-frame retention/compaction policies before describing long-running visual use as production-ready.
- Remote desktop ACP transport now has an approved client workflow and is planned in package C. Passive monitoring, multiple concurrent calls, mobile clients, and in-call project switching remain deferred.

Package B has no unconditional exit criterion. For any selected item, its implementation is complete only when the corresponding shell, VM, protocol, documentation, and real-application tests pass.

### Cross-Package Constraints

- Direct HTTP access from an unrelated isolated development VM to the macOS test runtime can be blocked by the VM session firewall. Mirroring the private target adapter log into `~/Desktop/opencode-share/openlive-live.log` remains a development workaround, not product behavior.
- The OpenLive watchdog behavior used during characterization came from the inspected upstream build. Record the exact installed macOS OpenLive version or commit before treating those timings as the compatibility contract.
- Package A must not absorb package B work merely because it is desirable. An item moves into package A only if a reproducible failure proves it is required for the section 14.3 installed-script scenario.

## 29. Remote OpenLive MVP Implementation Plan (Work Package C)

**Status: MVP baseline implemented in script 0.5.44 / adapter 0.1.4; optional web-auth inheritance implemented in script 0.5.49 / adapter 0.1.6; automated validation passes. Real two-computer OpenLive acceptance in section 29.11 remains pending.**

This section specifies the implemented remote desktop baseline and its remaining release acceptance. Local behavior remains available for folders without a mapping; the real-application acceptance record is still outstanding.

### 29.1 Goal, user workflow, and scope

The user operates OpenLive on a macOS workstation while the actual project and `opencode-vm web` run in another account on another development computer. Only the already published web port is reachable over LAN or VPN. There is no SSH login, host filesystem mount, project synchronization, or direct Lima access from the workstation.

Planned workstation flow after installing the script:

```bash
mkdir -p ~/Remote-Projekte/MeinProjekt
cd ~/Remote-Projekte/MeinProjekt
opencode-vm openlive remote
```

The command configures the current existing folder as a connection stub. OpenLive subsequently selects OpenCode and that folder through its existing UI. The remote project's real files never need to exist in the stub.

On the development computer, the operator updates `opencode-vm` and starts the actual project with the existing HTTPS `web` workflow and chosen port. A compatible `web` startup prepares the remote gateway with the web session's authentication choice, even if no local OpenLive host shim exists there. The development computer does not need the OpenLive app. Gateway/package preparation belongs to web startup, never to an incoming network request; failure leaves the remote feature unavailable with a diagnostic while ordinary web services retain their existing lifecycle.

Important command distinction:

- `opencode-vm install` makes the script callable and currently may install Lima as part of its normal setup.
- `opencode-vm init` provisions a local base VM; it is **not required** for remote OpenLive.
- `openlive remote` must work without running `init`, without a local session record, and without invoking `limactl`. Avoid redesigning the general installer solely to remove its existing Lima dependency check.
- Installing `opencode-vm` on the workstation is supported and is the intended delivery path; a separate manually maintained proxy application is not required.

MVP capabilities:

- One local stub maps to one confirmed remote project and one web origin.
- Multiple stubs can select different remote projects through the same global OpenLive shim.
- Preserve manager-first calls, session counts, list/read, exact-session attach, explicit create, selected models, text/thought streaming, cancellation, and the current bounded JPEG frame support.
- The server-side adapter, manager tool, provider credentials, and coding tools remain inside the development VM.
- Normal local OpenLive operation remains available when a selected folder has no remote mapping.

Explicit exclusions: remote filesystem browsing or synchronization, SSH fallback, a second OpenCode runtime, generic terminal forwarding, arbitrary server process execution, automatic project discovery across a LAN, multiple calls per remote project, mobile clients, and automatic replay/retry of interrupted work.

### 29.2 Setup interaction and lifecycle of a mapping

`opencode-vm openlive remote` is an interactive setup/update command, not a long-running tunnel. Its steps are:

1. Canonicalize the current folder and check macOS/OpenLive availability before changing integration settings. If OpenLive is missing, print installation guidance and exit without claiming setup succeeded. Prepare the verified local network-client executable and its Node prerequisites before attempting connection tests; this may populate the cache but does not activate a mapping or alter OpenLive settings.
2. If a mapping exists, show the saved project and sanitized origin, test it again, and offer to keep or change it. Reconfiguration replaces the same mapping; it must not create duplicates or silently convert the folder back to local mode.
3. Ask for the **actual reachable web address**, for example `https://dev-machine:4444`. Accept DNS names, IPv4, and bracketed IPv6 through a real URL parser. A bare host with port may default to HTTPS. Do not derive internal backend/A2A ports from this input.
4. Permit a pasted normal OpenCode project deep link by extracting its origin and explaining that the server will confirm the target project. Strip UI path/query/fragment data; reject embedded credentials and unsupported schemes. Custom reverse-proxy subpath deployments are outside the MVP.
5. Establish TLS trust, query the remote capability document without credentials, and request the web username (default `opencode`) and password without echo only after an HTTP 401 response.
6. Show the server-confirmed project display name and origin and obtain confirmation. The local folder name is only a label, never proof of remote identity.
7. Check protocol compatibility, server readiness, and a real WebSocket upgrade with the web session's optional authentication through the public web entry point. This probe creates no manager/work session, sends no model prompt, and must not interrupt an existing call. A busy project can still be configured; report that a call is currently active.
8. Reuse the prepared local network-bridge runtime and install/reuse the existing managed OpenLive shim, discovery link, and readiness marker. Preserve foreign command overrides under the same explicit replacement rules as the local installer.
9. Persist the confirmed mapping and credentials atomically only after successful checks and bridge preparation. On failure/cancel preserve the previous mapping and restore changes made to the shared integration in this attempt. A downloaded verified artifact may remain cached.
10. Print the exact local folder and the next steps: open/restart OpenLive, choose OpenCode, select this folder, and keep the remote web session running. Do not print credentials or the remote filesystem path in the normal completion message.

Minimal companion behavior:

- Extend `openlive status` and `openlive doctor [folder]` to recognize a remote mapping before checking local Lima state. Status shows configuration; doctor performs bounded connection/trust/auth/project/protocol checks without a model call.
- Add `openlive remote --remove` for the current folder. This removes only that stub's mapping and saved connection secret; it leaves the shared shim and other projects intact. Confirm that the folder will thereafter follow local routing.
- On shared `openlive uninstall`, remove owned remote mappings/credentials as well as managed integration files, report their removal, and leave stub folders and project contents untouched.
- Renaming or moving a stub requires rerunning setup at the new path; do not introduce automatic filesystem tracking.

### 29.3 Architecture and ownership

```text
Workstation                                      Development VM
OpenLive
   | ACP stdin/stdout
managed opencode shim
   | selected local stub -> saved remote mapping
network client -------- HTTPS/WSS web port -----> existing web entry point
                                                   | dedicated path routing
                                                   v
                                                loopback remote gateway
                                                   | fixed adapter child
                                                existing ACP adapter
                                                   | SDK HTTP/SSE
                                                existing OpenCode server
                                                   |
                                                tools + actual project

voice_sessions tool <---- existing VM-local Unix socket ----> ACP adapter
```

- Add only a small network client and a VM-side ACP gateway around the existing adapter; do not reimplement the call controller or manager behavior on the workstation.
- The gateway runs for the web-session lifetime. It may start one fixed, preinstalled adapter child for an admitted call; it never starts/resumes a VM or another OpenCode server.
- An internal loopback listener is allowed, but no additional host/LAN port is published. Allocate its internal port without colliding with the existing backend/A2A block; an OS-assigned loopback port with private runtime metadata is sufficient.
- Extend `OCVM_WEB_REDIRECT_PY`/the generated web library to route only the two dedicated paths below to that listener. Preserve all other Web UI/API/SSE/WebSocket and A2A behavior, including the HTML seed/redirect path.
- Routing must retain bytes already read past the HTTP headers, support WebSocket upgrade, and avoid mixing upstreams on a keep-alive connection. Discovery responses close their HTTP connection; upgrade connections remain bound to the selected gateway until close.
- The web supervisor owns gateway start/stop and readiness on fresh and resumed sessions. Start only after package preparation; report not-ready until the central backend and required tool are ready. A gateway failure must be visible without stopping unrelated Web UI/A2A use.

### 29.4 Minimal network contract

Stable paths on the supplied web origin:

| Endpoint | Contract |
| --- | --- |
| `GET /openlive/info` | Bounded JSON capability/project/readiness response using the web session's optional authentication; no model call or session creation |
| `GET /openlive/acp` with WebSocket upgrade | ACP transport using the web session's optional authentication and the explicit `ocvm-openlive.v1` subprotocol |

The capability response contains only the required fields: schema/protocol version, script and adapter versions, stable project ID, bounded display name, readiness, call-busy state, supported frame-size limit, and the relative ACP path. Do not return credentials or accept an advertised cross-origin endpoint. Project identity derives from the server's canonical project identity, not the port number, VM name, or disposable runtime generation.

Connection sequence:

1. The client sends the expected project ID and protocol through bounded handshake headers, plus HTTP authorization when the web session requires it. The gateway validates all applicable fields before spawning an adapter or exposing project details.
2. The gateway sends one bounded transport-level `ready` message identifying the confirmed project, runtime generation, and canonical server-side ACP working directory. The local helper consumes this message; it is never written to OpenLive's ACP stdout.
3. A setup probe may close immediately after `ready`, without acquiring the call slot or starting the adapter.
4. The first ACP request within a bounded startup deadline triggers call admission and adapter launch. From then on, each WebSocket text message contains one ACP JSON-RPC object, translated to/from one NDJSON line on the child pipes. Preserve JSON-RPC IDs and notification ordering.
5. Reject binary messages, unsupported subprotocols, oversized payloads, and malformed framing. Disable WebSocket compression initially; preserve the existing 12 MiB ACP-line and decoded image limits. Bound write queues and propagate backpressure; terminate a persistently slow connection rather than buffer indefinitely.

HTTP failures must distinguish required-but-missing/wrong credentials (`401`), unavailable/disabled service (`503` with a bounded reason), project mismatch (`409`), unsupported protocol/upgrade (`400`/`426`), and a missing remote feature on older servers (`404`). A call-busy race after upgrade produces a transport failure and closes without starting a second child. Transport errors must never masquerade as successful ACP responses.

No query-string tokens, secret-bearing URLs, arbitrary launch commands, remote executable paths, or arbitrary backend URLs are accepted. Cross-origin redirects are rejected rather than forwarding credentials. Browser WebSocket origins are rejected for the MVP native-client endpoint; the workstation helper does not need a browser-origin allowance.

### 29.5 Project mapping and ACP working directories

Persist one per-stub record under the existing private project-state hierarchy, for example:

```text
~/.opencode-vm/project-state/<canonical-stub-hash>/openlive-remote.json
```

The versioned record holds the canonical local stub, sanitized web origin, expected server project ID, display name, protocol version, optional connection credential, and any explicit certificate trust pin. A single atomically replaced mode-0600 JSON record keeps connection/credential updates consistent without a second state registry; containing directories are private. Read it as data, never shell-source or evaluate it. Exclude it from VM config/data sync, generated agent context, logs, and exported patches. Existing OpenCode provider `auth.json` is not the storage location for the remote password.

Dispatch and scope rules:

- Check for a mapping **before** local `need limactl`, session lookup, or provisioning. An unreadable/invalid mapping fails explicitly; it is not equivalent to no mapping.
- A valid remote mapping selects only the remote helper. Failed network/auth/trust/project checks never fall back to local execution.
- The helper verifies that ACP `session/new` and `session/load` refer to the selected canonical local stub. It then rewrites only their `cwd` to the confirmed server working directory from `ready`.
- The server retains the existing strict `validateSessionScope` comparison against its own descriptor. Client parameters cannot select another project. Additional workspaces remain rejected, and ACP-provided MCP definitions remain ignored.
- Prompt text, session IDs, filenames, and image contents are not subject to blanket path substitution. Local path-based file attachments are not added in this MVP.
- The server checks the expected stable project ID on every connection. Reuse of the same port by another project requires explicit reconfiguration. A new VM generation for the same project may reconnect in a new call, but never resumes an uncertain active prompt automatically.

### 29.6 Authentication and certificate trust

Inherit the web session's authentication choice. When its protected `auth.env` contains a username/password, reuse that credential for discovery and upgrade at the gateway itself; do not reuse the public default A2A credential or create another account subsystem. When the web session is unprotected, omit the Authorization header throughout discovery, upgrade, and backend access.

MVP defaults and explicit exceptions:

- HTTPS/WSS is the normal setup path. A manually entered HTTP origin may be supported for a user-confirmed trusted LAN/VPN connection, with a clear one-time notice that this transport itself is unencrypted; never silently downgrade HTTPS.
- A web session without a configured password exposes remote ACP without authentication and prints an explicit trusted-network warning. Setup probes it without credentials and skips the password prompt. Anyone who can reach the web port can start an agent with write access to the mounted project, so this mode is intended only for trusted LANs or VPNs.
- Standard trusted certificates use normal hostname/chain verification. For a self-signed certificate, setup shows the endpoint and SHA-256 certificate fingerprint, explains the trust decision, and persists an explicit pin after confirmation. Certificate probing sends no credentials.
- Apply the same trust policy to discovery, setup probing, and every WSS call. A changed pin or invalid certificate fails closed and requires setup again. Do not use global TLS verification disabling; any self-signed exception is scoped to that exact origin and pinned certificate.
- Credential/certificate changes take effect on subsequent connections; restarting the web service closes existing calls. Do not add live credential rotation machinery to the MVP.

The VM-side `OpenCodeGateway` also needs the narrow protected-runtime support currently deferred in B.2: apply Basic authentication consistently to SDK requests and SSE when backend auth is enabled, read from the trusted session channel, and leave the runtime descriptor non-secret. Gateway admission and backend API authentication are separate checks, both required.

The network credential grants the configured remote service's authority, including coding tasks inside the VM. This is not a new read-only role or a multi-user authorization system. It grants no additional host login or Git-origin credentials.

### 29.7 Admission, disconnects, and startup timing

- Enforce one active OpenLive call per remote project **across local and remote entry paths**. Two workstation stubs or two computers must not bypass the existing policy.
- Add one VM-side ownership gate at the common adapter startup boundary, before any Unix-socket removal or manager mutation. A simple atomic local lock with owner identity and bounded stale-owner recovery is sufficient; the existing host lock can remain an early local diagnostic.
- Correct `ControlServer.start` sequencing so an arriving adapter cannot unlink a live owner's socket. Only the owning process may remove its socket and lock. Gateway probes do not consume call ownership.
- Gateway launch uses a fixed executable and argument vector, a bounded environment, and the preinstalled package; never interpolate client input into a shell command.
- ACP EOF, explicit close, WebSocket close, heartbeat failure, gateway shutdown, and signals reach the existing idempotent call cleanup. If necessary, terminate the adapter child after a bounded grace period; never stop the central runtime or abort an unrelated session.
- Configure WebSocket ping/pong, for example 15-second heartbeat with a 10-second response deadline. This detects dead network connections and is separate from the adapter's substantive-progress watchdog.
- After an uncertain disconnect, report the interruption and advise checking Web UI. Do not reconnect and resend an in-flight prompt, recreate an unconfirmed session blindly, or restore a work attachment automatically. A later explicit call starts in the persistent manager as usual.
- Target a 12-second total client startup budget within OpenLive's characterized 15-second limit, including connection, optional-auth upgrade, and the existing bounded adapter preflight. Dependencies, certificate approval, credential prompts, downloads, and builds happen only during setup/update, never in ACP startup.
- Preserve stdin from the first buffered OpenLive request onward; protocol stdout carries ACP only. Setup/probe messages and remote child diagnostics remain bounded and on stderr.

### 29.8 Distribution and workstation runtime

Extend the existing verified adapter artifact with compiled network-client and gateway entry points. Keep one versioned artifact and its locked production dependencies rather than adding a package registry or a second updater. Pin a small maintained WebSocket implementation supporting authorization headers and per-connection TLS options; select and lock its exact version during implementation, and include its licensing obligations in packaging checks.

- Reuse source-development and precompiled-release paths, embedded digest verification, content-addressed caching, and release-before-script publication ordering.
- On the workstation, `openlive remote` checks for Node.js 22 or newer and prepares production dependencies locally with the locked install and lifecycle scripts disabled. No local OpenCode server or TypeScript build is needed for the installed release path.
- If Node is absent/incompatible, offer the standard host installation when Homebrew is available, with confirmation, or print a precise prerequisite and retry instruction. Do not start a VM to supply Node or silently alter an existing runtime manager.
- Save the resolved executable location in managed bridge state so OpenLive launched from Finder does not depend on an interactive shell's PATH. Validate it at startup and give setup recovery guidance if it disappears.
- `opencode-vm update` refreshes the package and local runtime dependencies when remote mappings exist. A failed update remains explicit; subsequent ACP must not use mismatched client/package state. Local-only installations do not gain an unnecessary host Node requirement.
- Test execution from an installed single script without adjacent sources, plus the development checkout path. Node modules/cache files stay outside the stub and project repository.

### 29.9 Implementation sequence and file-level work

C.1 through C.7 and the documentation portion of C.8 are implemented. Automated tests cover the packaged TLS round trip, exact existing-port routing, transactional setup, fail-closed dispatch, protected and unprotected non-mutating probing, shared ownership, and local regressions. C.8 remains open only for the real two-computer macOS/OpenLive acceptance in section 29.11; behavior tests, not implementation-line greps, remain the release criterion.

| Step | Work and expected locations | Exit criterion |
| --- | --- | --- |
| C.1 Contract and fixtures | Finalize info/ready/ACP framing and error fixtures under `adapters/openlive-acp/tests/`; characterize the exact OpenLive build's cwd, initialization, and close behavior | One written protocol-v1 contract and executable fixtures cover project binding and read-only setup probing |
| C.2 Shared admission and protected backend | `src/main.ts`, `src/manager/control-server.ts`, a small VM-local ownership helper, and `src/opencode/gateway.ts` | Local calls still pass; simultaneous local/remote-style launches cannot unlink each other's sockets; protected HTTP and SSE work |
| C.3 VM gateway | New `src/remote/server.ts` around the existing child entry point, with explicit auth, protocol, size, and lifecycle handling | Authenticated info/upgrade/probe/ACP succeed on loopback; unauthorized and mismatched requests spawn no child |
| C.4 Existing-port integration | `opencode-vm.sh`: `OCVM_WEB_REDIRECT_PY`, generated web lifecycle, fresh/resumed preparation and cleanup | The same public web port carries discovery and WSS; ordinary Web/API/SSE/A2A traffic remains correct; no additional published port |
| C.5 Workstation helper | New `src/remote/client.ts` with bounded framing, TLS/auth, cwd mapping, and EOF behavior | A stdio ACP client operates through the public endpoint from a different local path, including spaces and non-ASCII names |
| C.6 Setup and routing | `opencode-vm.sh`: `openlive_cmd`, `openlive_acp_cmd`, private mapping helpers, host-runtime preparation, status/doctor/remove/uninstall/update | Stub setup is idempotent and transactional; remote dispatch works without Lima/base/session records and never falls back locally |
| C.7 Artifact and automation | `package.json`/lockfile, `scripts/build-openlive-adapter.sh`, `.github/workflows/release.yml`, focused shell and package tests | Production-only extracted client/gateway packages complete an actual ACP round trip through the web entry point while protected and unprotected probes are covered separately |
| C.8 Documentation and real acceptance | Future README/AGENTS/release-doc changes plus the acceptance record in this plan | A two-computer macOS/OpenLive run over the sole allowed web port meets section 29.11, with versions recorded |

The implementation increments the script to 0.5.44 and the adapter/package to 0.1.4, adds the pinned `ws` runtime, and extends the reproducible artifact with the remote client and gateway. The embedded digest and version fixtures are validated with every release build.

### 29.10 Required automated validation

**Routing and setup:** fresh and existing stubs; keep/change/remove; missing OpenLive/Node; GUI PATH; no local `limactl` or base VM; multiple mappings through one shim; foreign command preservation; failed setup retains old state; secret-free output; changed server/project/port; renamed stub; invalid mapping never selects local mode. Run the actual command paths with controlled dependencies.

**Transport and scope:** real info and WebSocket upgrade with optional authentication through the generated public web proxy; client cwd differs from server cwd; same-origin endpoint enforcement; missing/wrong required credentials; unsupported protocol; older server; wrong project ID; busy call; unauthorized requests never create an adapter, manager, or socket. A setup probe must remain non-mutating even when a call is busy.

**TLS and limits:** trusted certificates; explicit self-signed trust; changed pin; credentials withheld until trust is established; HTTP confirmation/no automatic downgrade; Unicode and IPv6 URL handling; malformed JSON/NDJSON and binary frames; size limits before parsing; slow peers/backpressure; bounded diagnostics without secrets.

**Call behavior:** launch the actual extracted client, gateway, and adapter against the pinned real OpenCode server with a deterministic fake provider. Exercise ACP initialize/new/prompt/cancel/close, real manager-tool schema and execution, first-turn counts, deferred attach/create, subsequent exact-session work, rollback, selected model, JPEG delivery, and manager reset. Do not accept a missing-environment exit or a source-only manager-tool test as proof of remote runtime functionality.

**Lifecycle and concurrency:** local-vs-remote and remote-vs-remote contention; EOF during preflight/streaming; network loss during manager create; no automatic prompt replay; gateway/child crash; stale-lock recovery without touching live owners; heartbeat expiry; web restart invalidates old connections; fresh and resumed web sessions clean up only owned processes.

**Distribution and regressions:** reproducible double build and embedded SHA; locked host and guest production installs; same-size/same-mtime package updates replace old files; failed update yields nonzero and no stale execution; shell syntax checks for each changed file separately, ShellCheck on changed scope, TypeScript checks, existing local tests, workflow lint, and `git diff --check`. Include a macOS host job or an explicit macOS shell smoke run for Bash 3.2, BSD tar, and Finder-launched runtime resolution; Linux mocks alone do not prove workstation portability.

### 29.11 Two-computer acceptance and definition of done

1. Record exact macOS, OpenLive, script, adapter/client protocol, Node, and OpenCode versions on both sides.
2. Run one protected `opencode-vm web` project on computer A. Make only its existing web port reachable from B, over LAN and then VPN. B must have no SSH access to A and no copy of the real project.
3. Install the script on B, leave local base/session VMs absent, create an empty named stub, and run `opencode-vm openlive remote` there.
4. Complete URL/auth/certificate/project confirmation and verify setup prints the correct OpenLive next steps. Setup must leave the remote session count unchanged.
5. Launch OpenLive from the GUI, choose OpenCode and the stub, and complete first-turn manager status within the startup budget.
6. Read and attach to an existing WebUI session, then verify a spoken work prompt and its answer appear under that exact session ID in the remote WebUI. Explicit creation and selected-model behavior must also work.
7. Send a bounded screen-sharing turn to a vision-capable model and verify the image reaches the same remote session.
8. End the call and verify that the next call starts in the same manager. Attempt a concurrent local/remote call and confirm it is rejected without disturbing the active one.
9. Interrupt the network during work, inspect the clearly reported uncertain outcome in WebUI, and verify no automatic replay or extra runtime was created. Start a new call explicitly after connectivity returns.
10. Exercise a second stub/remote target, a wrong password, changed certificate, reused port serving another project, missing feature on an older server, and reconfiguration/removal. None may silently route to a local or unintended project.
11. Verify exactly one OpenCode server for the development project, at most one admitted adapter child, a VM-local manager socket, and zero local coding runtimes or new public ports. Browser/API/A2A usage remains functional throughout.

**Remote-MVP release readiness requires all C steps and the above acceptance to pass.** Publish compatible client/gateway artifacts before distributing their referencing script; a new client talking to an older server must produce upgrade guidance. The existing local A.6 acceptance remains a separate required regression gate, not something remote planning or mocks can satisfy.

Further proxy platforms, browser clients, fine-grained multi-user authorization, background reconnection, and filesystem features enter a later plan only after a concrete need. No such work is necessary to deliver the stub-folder remote workflow approved here.
