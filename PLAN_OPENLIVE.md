# OpenLive Voice Session Gateway Plan

Current status:

- The functional MVP and regular single-script distribution path are implemented and automated-test complete at `opencode-vm` `0.5.43` / adapter `0.1.3`, using ACP SDK `1.2.1` and OpenCode SDK/server `1.18.21`.
- A real OpenLive run has already confirmed ACP setup, reuse of the central runtime, model selection, normal streaming, and per-turn screen sharing. The exact OpenLive build used for that run was not recorded.
- Remaining release gates are publication of the `v0.5.43` adapter asset before the script reaches the update path, plus the complete macOS/OpenLive acceptance run in A.6: first-turn status, existing-session attach, explicit new-session creation, subsequent work routing, call reset, and process-count verification with the exact OpenLive build recorded.
- A versioned reproducible adapter archive, embedded SHA-256 verification, safe extraction, atomic content-addressed host cache, packaged-runtime session preparation, and tag-driven release workflow are part of the baseline. Protected-runtime support, richer ACP activity, generic attachments, and retention policy remain future work.

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
- Mobile or remote voice transport.
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
- Consider passive monitoring, multiple concurrent calls, remote/mobile transport, or project switching only after a concrete client and protocol contract exists.

Package B has no unconditional exit criterion. For any selected item, its implementation is complete only when the corresponding shell, VM, protocol, documentation, and real-application tests pass.

### Cross-Package Constraints

- Direct HTTP access from an unrelated isolated development VM to the macOS test runtime can be blocked by the VM session firewall. Mirroring the private target adapter log into `~/Desktop/opencode-share/openlive-live.log` remains a development workaround, not product behavior.
- The OpenLive watchdog behavior used during characterization came from the inspected upstream build. Record the exact installed macOS OpenLive version or commit before treating those timings as the compatibility contract.
- Package A must not absorb package B work merely because it is desirable. An item moves into package A only if a reproducible failure proves it is required for the section 14.3 installed-script scenario.
