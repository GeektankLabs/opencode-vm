# MCP Connector Baseline Plan

Status: Local MCP MVP, project-based managed tunnel register and requested session creation implemented; real macOS/Lima and hosted OpenAI/ChatGPT/Voice acceptance remain external.

Date: 2026-09-25

Last updated: 2026-09-27

## Phase 6: Delivery A — Complete Original Reading (0.5.67 / Adapter 0.1.3)

Three additive tools (`get_task_result`, `get_message`, `read_message_content`) provide bounded deep result searches and complete revision-bound original-text reads. History's shared text clipping is replaced by UTF-8 previews with references, explicit omissions and serialized response budgets. The existing transport/SDK/revision baseline is preserved. No snapshots, durable result index, automatic write retries, raw tool output or discussion state are added. Decisions, test evidence and required hosted ChatGPT acceptance are maintained in `PLAN_MCP_READING.md` and `docs/MCP-INTERFACE.md`; historical text-budget/no-content-reading statements below are superseded by this phase.

## Phase 5: Runtime Configuration and Project Activity (0.5.66 / Adapter 0.1.2)

The user requested a baseline without further questions. `create_session` was reviewed and its variant/enabled-model checks extended while preserving lazy custom-provider compatibility. Four tools extend the existing six: runtime options, partial idle-session runtime update, persistent project activity and short activity wait. Message IDs and current-status correlation remain unchanged; receipt cursors/timestamps and machine-readable error metadata are additive. The detailed decisions, acceptance evidence and explicit follow-ups are maintained in `PLAN_MCP_ACTIVITY.md` and `docs/MCP-INTERFACE.md`. Historical no-runtime-update/no-journal statements below are superseded by this phase.

## Phase 4: Create Work Sessions (0.5.65 / Adapter 0.1.1)

The user explicitly requested session creation through MCP, superseding the historical five-tool/no-creation baseline below. `create_session` accepts only an optional bounded title and creates an empty root session in the endpoint's fixed project. The configured visible primary agent and connected model defaults are persisted so `send_message` can start the first turn; the backend normalizes an unspecified variant to `default`. Scope/parent/permission overrides are rejected. Creation is non-idempotent; unconfirmed results use `CREATION_UNCERTAIN` and are never automatically retried or deleted. The adapter re-reads and validates the new session before returning its identity.

The real OpenCode integration starts with no work sessions, creates one through MCP without a model call, verifies empty history and project ownership, then submits and correlates its first prompt. Unit/wire tests cover defaults, annotations, schema rejection, scope filtering and uncertain creation. Clients must refresh their tool catalog after runtime reconnect to discover the sixth tool. The protocol/runbook documents the current contract; older phase sections remain historical where superseded.

## Phase 3: Project Assignments and Reusable Entries (0.5.62)

The user replaced phase 2's global pair/single-owner model with a project-based register and explicitly rejected tunnel occupancy management. This section supersedes the phase-2 ownership and permanent opt-out behavior below.

- Private schema-2 host register with keys, tunnel IDs and canonical-directory project references. Creation origins remain visible independently of current usage. Duplicate key values reuse one key entry.
- `provider mcp new openai` offers numbered existing entries or hidden new key input. `--tunnel-api-key` supports literal/env/file input; `--api-key` is retained as an alias; `--key-id` reuses a registered key. Existing tunnel IDs may be reused after the operator notice. No simultaneous-use check or global owner claim remains.
- `provider mcp list [openai]` and `provider list` show all assignments and reusable entries. `status` and `rm` target cwd or `--project ID`; project removal stops only its own service and retains reusable entries. Explicit key/tunnel deletion requires no remaining project references.
- Legacy global config is exposed as an unassigned reusable pool and committed to schema 2 on an edit; setup binds it to the intended project explicitly.
- Configured `start` uses a loopback server plus immediately attached TUI (`tui-mcp` internally). Web-only services/forwards are not started in this mode. Fresh and resumed terminal lifecycles share the existing auth capture/cleanup. `--no-mcp` is invocation-local for both start and web.
- Setup/list include the dated 2026-09-26 ChatGPT eligibility caveat: Developer Mode documentation lists Plus/Pro read/write while the Help Center describes full/write support for Business/Enterprise/Edu. No local plan-based permission enforcement is added.
- Verified locally: registry storage/references/concurrent edits, canonical paths, secret-free selection/status/list, interactive reuse and atomic cancellation, migration, concurrent same-tunnel startup without blocking, isolated project removal, server-backed TUI fresh/attach teardown, provider/OpenLive regressions and release metadata. Real client/systemd fixtures use their own service/socket namespace; adapter lifecycle tests use private PID paths so a live session remains isolated.

The current operator contract is `docs/MCP-TUNNEL.md`; historical phase-1/phase-2 requirements below remain as implementation history only where superseded here.

## Phase 2: Managed VM Tunnel Baseline (0.5.61)

The user approved implementing the managed tunnel after the initial connector MVP. This section supersedes the historical host/operator-managed tunnel and opt-in fresh-web requirements below; the five-tool adapter contract remains unchanged.

- New commands: `provider mcp new openai`, `provider mcp status openai`, `provider mcp rm openai`; integrated with `provider new`, `provider list`, and `doctor`.
- Private user-wide host configuration, hidden interactive key input, parameter/env/file input, and one active tunnel project per computer. No model-auth merging for tunnel credentials.
- Local MCP defaults on for new web sessions. Automatic ports are reserved in `40960..41059`; explicit ports and reconnect choices stay fixed. Retained disabled sessions use `--mcp` to enable.
- After authenticated MCP readiness, lazily install SHA-256-pinned tunnel-client v0.0.15 inside the session VM and run it as an owned transient systemd service. The existing MCP token is injected into both header maps; the health endpoint is a guest Unix socket.
- Tunnel failure leaves local web/MCP running with diagnostics. Start/stop are serialized; removing configuration verifies shutdown first. The runtime key is intentionally transferred to the selected VM under this new requirement.
- Local checks passed: host CLI and PTY wizard (including hidden input/cancellation), concurrent project ownership, removal failure/recovery, automatic port reservation, real v0.0.15 local tunnel discovery and all five tool calls, real Linux/systemd service start/readiness, polling rejection, secret-free logs, and key/profile cleanup. Existing 18 adapter tests, lifecycle/provider regressions, and release metadata checks pass.
- The local tunnel fixture resolves client-to-adapter compatibility for v0.0.15, including the generated header configuration. Actual hosted-product headers, target-account permissions, macOS/Lima behavior and ChatGPT text/Voice remain external acceptance. Earlier B3 language requiring the runtime key to remain outside the guest is superseded.

See `docs/MCP-TUNNEL.md` for the current commands, operational contract and reproducible local-client checks. The following ledger records the original phase-1 implementation and its remaining external acceptance gates.

Source: [Issue #2: Expose OpenCode VM as an MCP server for external agents and voice frontends](https://github.com/GeektankLabs/opencode-vm/issues/2)

## Progress Ledger

Update this table when a work item starts, reaches its gate, or becomes blocked. A work item is complete only after its listed verification passes.

| ID | Work item | Status | Evidence or next gate |
| --- | --- | --- | --- |
| P0 | Issue, repository, protocol, tunnel, and release-path research | Complete | Findings incorporated into this document on 2026-09-25. |
| P1 | Minimal scope and architecture decisions | Complete | Five tools, one project, async prompts, private opt-in endpoint, no new OpenCode runtime. |
| P2 | File-level implementation and test plan | Complete | Detailed phases M0-M7 below. |
| P3 | Executive readiness review and near-term delivery priorities | Complete | Read-only recheck on 2026-09-25 found no implementation at that time; the 2026-09-26 implementation update supersedes that snapshot. |
| M0 | Compatibility spike | Partial | Official SDK and real OpenCode checks selected stateless protocol `2025-11-25` and `promptAsync`; tunnel headers, macOS forwarding, and account checks remain external. |
| M1 | MCP adapter package and fake-backend tests | Complete locally | Clean install, type-check, build, 18 unit/fake-backend tests, and official-client discovery/call/cancellation pass. |
| M2 | Real OpenCode compatibility harness | Core gate passed | OpenCode 1.18.21 admits one prompt, correlates terminal completion, follows opaque pagination, survives adapter restart, and shows no replay. Extended competing-client/tool/failure cases remain follow-up coverage. |
| M3 | Host/guest lifecycle and CLI integration | In progress | Implementation and focused Linux fixtures pass; the full fresh/reconnect/disable matrix still requires real macOS/Lima acceptance. |
| M4 | Reproducible standalone release artifact | Complete locally | Independent archive, pinned digest, concurrent cache/staging tests, release checks, and byte-identical double builds pass; packaged VM startup remains part of M6. |
| M5 | Interface and tunnel documentation | Complete locally | Interface, operator-managed tunnel, README, AGENTS, and releasing documentation are present; external runbook execution remains M6/M7. |
| M6 | Real macOS/Lima and generic tunnel acceptance | Blocked externally | Requires B3 and B4. |
| M7 | ChatGPT text and desktop Voice acceptance | Blocked externally | Requires B3 and a passing M6. |

The local connector, lifecycle integration, packaging, and documentation are implemented. This ledger deliberately does not infer M6/M7 acceptance from local mocks or the disposable real-OpenCode harness.

Progress note (2026-09-26): implemented the five-tool stateless adapter, source and standalone lifecycle, private credential/readiness boundary, release artifact/workflow, and operator documentation. Local package, integration, lifecycle, regression, release, reproducibility, ShellCheck, workflow-lint, and whitespace gates pass. M6/M7 remain externally blocked.

## Blocker Ledger

| ID | Blocker or unknown | Impact | Unblock condition | Status |
| --- | --- | --- | --- | --- |
| B1 | The inspected working tree had mismatched script and OpenLive release tags. | M4/release publication could not pass while values disagreed. | Resolved at `OCVM_VERSION=0.5.60` with both adapter tags at `v0.5.60`; release metadata/state tests and actionlint pass. | Resolved |
| B2 | Exact interoperable MCP/OpenCode versions and HTTP lifecycle behavior were not proven; external tunnel behavior was also unknown. | Tool discovery or calls could fail if the server implemented the wrong Streamable HTTP era. | Locally resolved for `@modelcontextprotocol/sdk` 1.30.1, `@opencode-ai/sdk` 1.18.21, Zod 4.6.5, and stateless protocol `2025-11-25`. `tunnel-client` v0.0.15 remains externally unverified under B3/B6. | Partial |
| B3 | Access to the target ChatGPT workspace, tunnel ID, runtime key, tunnel permissions, and desktop Voice has not been provided or demonstrated for this work. This does not establish that the user lacks these capabilities. | M6/M7 cannot be completed in CI or this VM alone. | Confirm access on the real host and run the acceptance procedure there; keep the tunnel control-plane key out of the repository/guest. | External |
| B4 | Lima loopback auto-forwarding and collision behavior have not been exercised on the real macOS host for the proposed MCP port. | Host-private reachability is not proven even if the guest listener is healthy. | Complete the M6 real-host lifecycle tests. If it fails, use the explicit SSH-forward contingency documented below. | External |
| B5 | OpenCode HTTP 204 admission did not define final-turn completion, message visibility, or pagination ordering. | `get_session_status` could report false completion or encourage duplicate prompts. | Resolved locally against OpenCode 1.18.21: opaque `x-next-cursor`; `stop`, `length`, and `content-filter` are terminal success; `error` fails; unknown/tool-call values remain non-terminal; uncertainty is never retried. | Resolved locally |
| B6 | The exact `Host` and `Origin` headers forwarded by the selected `tunnel-client`/ChatGPT path are not recorded. | Strict HTTP validation may reject legitimate tunneled requests, while permissive validation weakens local security. | Capture the headers during M6 without logging secrets, then allow only observed safe values if the current loopback-only rules reject them. | External |

Blockers B1-B6 must remain visible here until resolved. Implementation may proceed through fake-backend adapter work while external blockers remain, but no release-ready or end-to-end claim may be made around them.

## Executive Assessment And Delivery Sequence

Review date: 2026-09-26. This section records the implemented local baseline and does not change the external acceptance criteria.

### What Exists Today

The repository now contains an independent `adapters/mcp/` package, exactly five tools, CLI/lifecycle integration, source and standalone staging, reproducible release packaging, and operator documentation. The adapter uses the existing OpenCode server and durable messages; it creates no manager session or second coding runtime.

Verified local evidence:

- `adapters/mcp/`: pinned SDK package, stateless Streamable HTTP server, project-scoped gateway, five tools, and 15 passing unit/fake-backend tests.
- `adapters/mcp/tests/opencode-integration.mjs`: passing OpenCode 1.18.21 admission, correlation, opaque pagination, no-replay, and adapter-restart harness.
- `opencode-vm.sh`: `--mcp`, `--mcp-port`, and `--no-mcp`; private credentials; generation-bound readiness; supervised guest process; fail-closed cleanup.
- `scripts/build-mcp-adapter.sh` and `.github/workflows/release.yml`: deterministic independent archive and dual-adapter publication checks.
- `docs/MCP-INTERFACE.md` and `docs/MCP-TUNNEL.md`: external contract and operator-managed tunnel runbook.

No real macOS/Lima, Secure MCP Tunnel, ChatGPT workspace, or desktop Voice acceptance was executed in this VM. Those claims remain blocked under M6/M7.

### Readiness Judgment

A first working ChatGPT connection is technically plausible without a new coding runtime. The required protocol adapter, prompt correlation, and controlled startup/reconnect/disable behavior now exist locally; the remaining question is compatibility and reachability through the real host/tunnel/product path.

Do not wait for finished release automation to learn whether the target ChatGPT/Voice surface works. First test the external path with a deterministic harmless tool, then repeat against the real connector. A source-checkout pilot may precede standalone packaging. It is an intermediate result, not completion of M4-M7 or a relaxation of the final definition of done.

Voice compatibility is separate from MCP compatibility. A desktop voice conversation may discover tools but require an on-screen approval before writing. A spoken interruption of ChatGPT also does not interrupt OpenCode work; session interruption remains outside this MVP.

### Blockers In Plain Terms

**B1: Resolved release metadata.** The script and both adapter tags are aligned at 0.5.60/v0.5.60, with the final MCP archive digest embedded and release checks passing.

**B2: Local protocol interoperability resolved; tunnel side pending.** The official MCP client discovers and invokes the five tools over stateless Streamable HTTP protocol 2025-11-25 with SDK 1.30.1. Tunnel-client behavior is still part of B3/B6.

**B3: Account and workspace access, clarify immediately in parallel.** A technically correct connector is unusable if the selected workspace cannot create a tunnel app or approve write tools. For example, the tunnel exists in a Platform organization but is not associated with the ChatGPT workspace, so it does not appear in the app picker. This is an external acceptance dependency, not a requirement to put account secrets into the VM.

**B4: Private host-to-VM reachability, relevant before the first host tunnel test.** A listener inside the VM is not proof that the Mac can reach it. For example, another application owns host port 40960 while the guest adapter reports healthy. Test host reachability, identity, LAN refusal, and reconnect on real Lima; never solve a failure by exposing the service publicly.

**B5: Locally resolved prompt acceptance versus completion.** The real-runtime harness verifies one 204 async admission, durable message visibility, parent correlation, terminal completion, opaque pagination, adapter restart recovery, and no replay. Unit tests retain unresolved admissions and return `SUBMISSION_UNCERTAIN` without retry.

**B6: HTTP header validation, relevant with B2/B4.** Local security rules must allow legitimate tunnel traffic without admitting arbitrary browser origins. For example, a valid tunneled call could receive 403 because the forwarded Origin differs from the assumed loopback URL. Record non-secret headers on the real path and derive narrow rules; do not turn validation off.

B3, B4, and B6 are external compatibility or access prerequisites, not confirmed product failures. B1 and B5 are resolved; B2 is resolved for the local MCP/OpenCode path and remains open only for the external tunnel path.

### First Functional Pilot

The pilot target is deliberately one project and one existing idle work session. An authenticated external client must list that session, read it, submit one harmless text instruction, retrieve the matching answer, and find that exact exchange in Web UI/TUI. No extra session, model switch, permission bypass, public listener, or replay is allowed.

Example acceptance request: ask the existing agent to reply with a unique test phrase without changing files. This verifies transport, admission, correlation, and shared history. A later deterministic tool-using request tests longer-running work and pending input; the phrase test alone does not validate a coding workflow.

### Next Steps After Implementation Approval

The following R1-R6 sequence is the practical delivery order. It maps to the existing M milestones without checking any of their task boxes prematurely.

**R1. Split local compatibility proof from external access checks.** Covers M0.1-M0.10. Locally select exact SDK/runtime versions, test a one-tool SDK server, and record which HTTP lifecycle actually works. On the host, confirm the intended ChatGPT workspace, desktop surface, tunnel permissions, and the ability to approve a harmless write action. Run the loopback reachability check separately. Output: a version/protocol record, non-secret header observations, and an explicit pass/blocked result for each external prerequisite. Local implementation need not stop merely because account access is pending.

**R2. Implement the read-only connector slice.** Covers the relevant M1 package, HTTP, gateway, and schema tasks. Create the independent package, fixed-project runtime descriptor, dedicated credential validation, and the four read-only tools. Use a disposable fake backend first, then the real runtime. Test foreign session IDs, excluded sessions, pagination/truncation, wrong credentials, invalid origins, unavailable backend, and cleanup. Output: an official MCP client can inspect a real existing session and cannot access another project. Run an early read-only ChatGPT/Voice smoke test when R1's external prerequisites are available; label it partial acceptance.

**R3. Add one reliable asynchronous write path.** Covers the remaining M1 and M2 tasks. Choose one admission API proven against the live runtime rather than mixing incompatible message identifiers from different API families. Add `send_message`, a receipt, preserved model/agent settings, pending-input detection, and bounded correlated status/history retrieval. Keep an in-memory unresolved-submission guard beyond the HTTP call so a temporarily idle snapshot immediately after acknowledgment does not admit a second prompt. Test timeout-after-acceptance, delayed persistence, multiple tool iterations, external competing submissions, failure, and adapter restart. Output: one request creates exactly one user message and yields the right answer, or reports uncertainty without replay.

**R4. Integrate the source-checkout lifecycle.** Covers M3 except standalone-download activation. Add explicit opt-in flags, persistent enable/port settings, private credential creation, source staging/build, guest supervision, and authenticated host readiness. Integrate both fresh and attach paths, stop on disable, and retain ownership checks during takeover. Validate port collisions across the whole guest web/backend block as well as host public ports. Output: one documented checkout command starts the private connector; reconnect preserves session history and disabling removes access. No automated tunnel installation is added.

**R5. Exercise the actual ChatGPT channel before release polish.** Covers an early subset of M5-M7 using source checkout. Provide a minimal tunnel profile/runbook, connect the target workspace, and perform the four-read-tool plus one-write-tool flow in text. Repeat in desktop Voice, including required on-screen approval. Compare receipt/message IDs against Web UI/TUI and test connector reconnect and disable. Record text and Voice separately, with client version, runtime versions, transport mode, and sanitized evidence. Output: a functional checkout pilot, or a named external blocker. A healthy tunnel or successful echo tool is not enough.

**R6. Finish distribution and repeat acceptance.** Covers M4, remaining M5, and final M6/M7. Reconcile B1 with the current release baseline, build the separate checksum-verified MCP artifact, extend release checks, test standalone installation, and finish operator documentation. Repeat the real host/ChatGPT/Voice flow using the packaged adapter. Output: the release-ready MVP meeting the unchanged definition of done. Do not publish or change the existing release workflow order without a separate release action.

Priority rule: clarify B3 while working on B2/B6; resolve B5 before enabling the write path; prove B4 before claiming host connectivity. Resolve B1 for release, not as a prerequisite to an isolated local protocol test. Packaging remains mandatory for delivery, but is not on the critical path to the first honest ChatGPT pilot.

### Plan Corrections From This Review

- Successful HTTP acknowledgment must not be called proven durable admission until the selected live API establishes that guarantee. A receipt may still require history reconciliation.
- The formerly provisional completion predicate now has explicit terminal finish values and a 100-message bound. If history bounds hide required evidence, return `unknown`, not a guessed success.
- A submission mutex covering only the HTTP request is insufficient. Retain unresolved admission state until reconciliation, and document that adapter-local protection cannot provide universal locking or exactly-once guarantees across all clients and restarts.
- MCP HTTP methods must match the protocol version selected by M0. Do not hardcode POST-only behavior while simultaneously promising untested legacy stateful transport support.
- Reconnect replaces the controlled web runtime; it is not an adapter-only restart. Test these as two distinct cases.
- Explicit SSH forwarding is only a contingency. It must not fight Lima for the same host bind; verify an appropriate guest-port mapping or a narrowly supported forwarding exclusion before choosing it.

Progress note (2026-09-26, implementation review): R2-R4 and the local portions of R1/R6 are implemented and validated. R5 plus packaged real-host acceptance remain blocked on B3/B4/B6; no local result is counted as ChatGPT or Voice acceptance.

## 1. Goal And Acceptance Target

Expose existing OpenCode work sessions through an opt-in, project-scoped MCP adapter. External clients must interact with the same OpenCode runtime and session history used by Web UI, TUI, A2A, and OpenLive.

The user selected **ChatGPT end-to-end** as the baseline acceptance target, rather than stopping at generic MCP interoperability. Acceptance therefore includes ChatGPT through Secure MCP Tunnel, including the intended desktop Voice experience.

Do not create a second OpenCode runtime, manager session, or conversation database. A small protocol-adapter process is expected; it is not another coding runtime.

```text
ChatGPT Work / Voice
        |
OpenAI Secure MCP Tunnel
        |
tunnel-client on the Mac
        |
Authenticated host-loopback endpoint
        |
MCP adapter inside the existing project VM
        |
Existing OpenCode server and sessions
```

Keep `tunnel-client` operator-managed for this baseline. Document setup and validation without adding tunnel installation, OpenAI account management, or another daemon-management subsystem to `opencode-vm`.

## 2. Baseline Scope

Include:

- One running web project per MCP endpoint.
- Listing, inspecting, and continuing existing work sessions.
- Asynchronous prompt submission with status and response retrieval.
- Private networking, authentication, lifecycle cleanup, and release packaging.
- Generic MCP interoperability and verified ChatGPT text/desktop Voice interaction through the tunnel.

Defer:

- Cross-project discovery or starting VMs remotely.
- Session creation, deletion, and interruption.
- Model selection, attachments, and richer event streaming.
- Permission/question answers through MCP. Report pending input and direct the user to Web UI/TUI.
- OAuth and per-user authorization. Initially, authorized clients act as trusted operators of the configured project.
- Public/LAN MCP listeners, public plugin distribution, and client-specific UI components.

This scope covers the issue's eight minimal acceptance criteria. Cross-project orchestration and the issue's optional tools remain follow-up work.

The existing `opencode-vm mcps` subsystem remains unchanged: it configures servers OpenCode consumes, whereas this feature exposes OpenCode to external clients. Do not register the new endpoint as a tool server consumed by the same runtime.

## 3. Proposed MCP Surface

Use five tools with explicit schemas, bounded output, and structured results. Every successful result should include concise text for clients that do not consume structured content and a JSON object for clients that do.

| Tool | Input | Bounded result |
| --- | --- | --- |
| `list_sessions` | `limit?: 1..20` (default 10), `cursor?: string` | Project identity without an absolute path; root work-session summaries; `next_cursor`; `truncated`. Scan at most ten backend pages to fill one response. |
| `get_session` | `session_id: string` | ID, title, timestamps, activity, agent, provider/model/variant, and pending-input counts. No absolute workspace path. |
| `get_session_status` | `session_id: string`, `message_id?: string` | Backend activity plus `unknown`, `submitted`, `running`, `input_required`, `completed`, `failed`, or `aborted` for the correlated message. |
| `get_session_history` | `session_id: string`, `before?: string`, `limit?: 1..20` (default 10) | Text-only user/assistant messages, IDs, parent IDs, completion/error metadata, `next_before`, and explicit text/output truncation. Cap total text at 32,000 characters. |
| `send_message` | `session_id: string`, `message: 1..32000 characters` | Immediate `{session_id, message_id, state:"submitted"}` receipt after asynchronous acknowledgment; persistence guarantees must be established by M0/M2. |

Mark `list_sessions`, `get_session`, `get_session_status`, and `get_session_history` read-only through MCP tool annotations. Mark `send_message` non-idempotent and write-capable, with a description stating that it can cause code changes and command execution inside the VM. Tool annotations are client guidance, not authorization enforcement. Do not bypass ChatGPT approval or OpenCode permissions.

The project identity returned to clients is `{id: <opencode-vm project hash>, name: <basename>}`. Do not expose the absolute host-mounted project path or the backend's internal project ID. The adapter can still use both internally for confinement.

Expose only non-archived, project-owned root work sessions. Exclude sessions with `parentID`, sessions whose agent is `openlive-manager`, and the current ID in OpenLive's optional manager descriptor. Apply the same checks to every ID-addressed operation; list filtering alone is insufficient.

Use `client.v2.session.list` for bounded, ordered session discovery and `client.v2.session.get` for metadata, with both exact directory and project-ID validation. Use the existing session message/status/question/permission APIs for history and turn correlation until the compatibility spike proves an all-v2 equivalent. Never read OpenCode SQLite files directly.

Return stable, sanitized tool errors rather than stack traces:

| Error code | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | Schema or cursor input is invalid. |
| `SESSION_NOT_FOUND` | The ID does not identify an exposed session. Use the same client-visible result for absent, out-of-project, child, manager, and archived sessions. |
| `SESSION_BUSY` | The adapter refused a new prompt because the session was not idle. |
| `INPUT_REQUIRED` | OpenCode is waiting for a permission or question response in Web UI/TUI. |
| `BACKEND_UNAVAILABLE` | The existing OpenCode server could not be reached within the request deadline. |
| `BACKEND_INCOMPATIBLE` | The live server lacks an API contract required by this adapter. |
| `SUBMISSION_UNCERTAIN` | Admission timed out or disconnected and automatic retry would risk a duplicate prompt. |
| `INTERNAL_ERROR` | Unexpected adapter failure with no internal details disclosed. |

HTTP authentication failures remain HTTP 401/403 and are not MCP tool errors. Log error codes and request IDs, not prompts, responses, credentials, raw headers, or stack traces at normal log level.

## 4. Prompt And Result Semantics

Use OpenCode's existing asynchronous prompt admission rather than wrapping blocking A2A calls or OpenLive's long-lived prompt stream. The verified OpenCode 1.18.21 contract uses `client.session.promptAsync` with an explicit message ID and HTTP 204 acknowledgment.

1. Validate project/session ownership and reject a visibly busy session.
2. Preserve the session's agent, model, and variant.
3. Assign `msg_<uuid-without-dashes>` as the user-message ID and submit the prompt with a bounded HTTP deadline.
4. Return `{session_id, message_id, state: "submitted"}` after acknowledgment.
5. Retrieve progress and results through status/history calls, correlating assistant messages by `parentID`.

An acknowledgment is not completion or, by itself, proof of durable persistence. The SDK's `session.promptAsync` endpoint returns HTTP 204 without a response body; that is not an error. Do not assume the newer `v2.session.prompt` has the same response or message-ID semantics.

Keep backend activity separate from the outcome of a particular prompt. An idle snapshot or the first completed assistant message does not necessarily prove that the submitted turn completed successfully. The verified correlation rule is:

1. Confirm the user message exists with the receipt ID.
2. Select only assistant messages whose `parentID` equals that receipt ID.
3. Report `input_required` when a pending permission/question belongs to that session or one of those assistant tool messages.
4. Report `failed` or `aborted` when a correlated assistant message carries the corresponding error.
5. Report `completed` only when every correlated assistant message is complete, at least one ends with `stop`, `length`, or `content-filter`, and no pending input remains. Treat `error` as failed; `tool-calls`, `unknown`, and unrecognized future values remain non-terminal.
6. Otherwise report `running` while the backend is busy/retrying, `submitted` when the user message is visible without assistant output, or `unknown` when durable admission cannot be confirmed.

The adapter scans at most 100 backend messages. If the target evidence lies outside that bound, it reports `unknown`, not a guessed success. A busy session may contain work from another client and is not alone proof that this receipt is running. History pagination passes through OpenCode's opaque `x-next-cursor`; clients must never construct a cursor from message IDs.

A timeout after submission is an uncertain outcome, not permission to resend automatically. Return the correlation ID when available and reconcile against OpenCode history. A message ID provides correlation; do not assume it provides upstream idempotency.

Adapter restarts must reconcile against OpenCode state rather than replay prompts. Do not add a persistent task database. Once prompt submission is acknowledged, client disconnection must not implicitly abort the existing OpenCode work.

Serialize MCP submissions per session with an in-memory keyed mutex and retain an unresolved-submission guard after acknowledgment or an uncertain timeout until backend reconciliation permits another submission. Do not queue a second MCP prompt: reject it as `SESSION_BUSY`. This reduces competing submissions through this adapter but does not provide an atomic lock against simultaneous Web UI, TUI, A2A, or OpenLive submissions, or a durable exactly-once guarantee after adapter restart. Document that limitation and test foreign submissions without falsely claiming their output as the MCP prompt's result.

Pending permission requests and questions should be surfaced as requiring user input. Do not automatically answer them or treat them as successful completion.

## 5. Networking And Authentication

The current web forwarding binds host listeners to `0.0.0.0`. Do not expose MCP through the existing public web proxy or extend its wildcard-bound port block.

Proposed CLI:

```bash
opencode-vm web --mcp --mcp-port 40960
opencode-vm web --no-mcp
```

Use `40960` as the MVP default. `--mcp-port` is valid only with `--mcp`; requiring the enable flag makes activation of a write-capable endpoint explicit. Reject `--mcp` with `--no-mcp`, and reject `--no-mcp` with `--mcp-port`.

Concurrent MCP-enabled projects require distinct explicit ports. A collision must print the occupying port and the recovery form `opencode-vm web --mcp --mcp-port <free-port>` without inspecting or printing another process's secret-bearing argv.

- MCP defaults to disabled for fresh sessions. Preserve the explicit choice on reconnect.
- Bind the adapter to guest `127.0.0.1:<port>` and use Lima's existing loopback auto-forward to host `127.0.0.1:<same-port>`.
- Keep MCP outside the existing web/A2A port-offset contract.
- Keep the selected port stable on reconnect. Fail clearly on host or guest collision rather than scanning or silently redirecting a configured tunnel.
- Validate loopback occupancy; the existing wildcard-listener check is intentionally insufficient for this endpoint.
- Reserve the MCP port while the public web block searches for a collision-free base so the two services cannot overlap.
- After guest readiness, verify that the same service is reachable through host loopback before advertising the endpoint.
- Publish readiness only after verifying the expected project/runtime behind the endpoint.
- Generate a dedicated high-entropy MCP credential, store it privately, and exclude it from ordinary logs and command-line arguments.
- Preserve the port and credential across reconnect and disable/re-enable. Rotate the credential only when a fresh session destroys and recreates the session share.
- Web `--no-auth` must not disable MCP authentication.
- Validate Host/Origin headers, bound request sizes, and avoid permissive browser CORS.
- Do not expose arbitrary backend URLs, workspace overrides, generic shell tools, or additional host filesystem APIs.

This auto-forward choice is the smallest baseline because the current web implementation already depends on the same Lima loopback behavior when its explicit LAN tunnel fails. M0/M6 must prove it on macOS. If Lima cannot reliably expose the guest-loopback listener, the contingency is one owner-scoped SSH forward from host `127.0.0.1:<host-port>` to guest `127.0.0.1:<verified-guest-port>` with `ExitOnForwardFailure=yes`. First verify how it avoids competing with Lima's automatic host bind; do not fall back to a wildcard listener or assume same-port coexistence.

An explicit `--mcp` request is fail-closed. Adapter preparation, credential validation, port binding, backend compatibility, or readiness failure terminates that web launch instead of silently continuing without MCP. No separate `--require-mcp` option is needed.

Reuse existing backend credentials only for the adapter-to-OpenCode connection. Do not pass caller authorization headers through to the OpenCode backend.

### Tunnel Authentication

The tunnel supports private-upstream header injection through `mcp.extra_headers` and `mcp.discovery_extra_headers`, including environment/file references. Use a dedicated `X-OCVM-MCP-Token` header in both maps. Avoid `Authorization`, because connector-forwarded OAuth headers can override static headers. The OpenAI tunnel runtime key is a separate credential and remains host-side.

The credential file contains only the token value. Create `<session-share>/mcp` with mode 0700 and `<session-share>/mcp/credential` with mode 0600 through atomic rename. Generate at least 256 random bits. Reject symlinks, malformed content, or unsafe permissions instead of silently rotating a configured session.

The baseline uses shared-service authentication, not OAuth or individual-user isolation. Workspace/tunnel access determines who can act through that service identity. Session history sent through the tunnel becomes available to the authorized external product; document this disclosure boundary.

Connector-forwarded headers can override static injected headers. Validate that the selected ChatGPT path does not replace `X-OCVM-MCP-Token`; do not weaken authentication if it does.

Do not describe this private static-credential setup as implementing MCP's OAuth authorization specification. OAuth is deferred unless the compatibility spike establishes it as necessary for the agreed end-to-end flow.

## 6. Detailed Implementation Plan

M0-M7 remain verification milestones, not a strict serial schedule. Use R1-R6 above as the updated delivery order: local compatibility precedes adapter work, real prompt evidence precedes write acceptance, and source-checkout ChatGPT/Voice trials may precede release packaging. External checks can remain blocked while isolated development proceeds. Do not mark a milestone complete until its full gate passes.

### M0. Compatibility Spike

Purpose: eliminate protocol and backend assumptions before building lifecycle machinery around them.

Selected local versions:

| Component | Selected version |
| --- | --- |
| MCP TypeScript SDK | `@modelcontextprotocol/sdk` 1.30.1 |
| Secure MCP Tunnel client | `openai/tunnel-client` v0.0.15 |
| OpenCode SDK/runtime contract | `@opencode-ai/sdk` 1.18.21 and the live OpenCode version installed by `opencode-vm` |

Tasks:

- [x] M0.1 Create a temporary, uncommitted SDK server using Node 22 and one deterministic read-only tool. The production adapter superseded the temporary server and is exercised with deterministic fake cases.
- [x] M0.2 Verify Streamable HTTP initialization, `tools/list`, `tools/call`, request cancellation, and server shutdown with the official MCP client.
- [ ] M0.3 Run `tunnel-client doctor --explain` and its local discovery probe against the server using both `mcp.extra_headers` and `mcp.discovery_extra_headers` with `file:` values.
- [x] M0.4 Record whether the selected path uses modern self-contained requests, legacy initialization with `Mcp-Session-Id`, or both. The selected local path is stateless Streamable HTTP with self-contained requests and protocol `2025-11-25`.
- [ ] M0.5 Capture non-secret request metadata from the tunnel path: HTTP methods, endpoint path, protocol version, Host, Origin, Accept, and session headers. Never log authentication values or request bodies.
- [ ] M0.6 Probe a guest `127.0.0.1:40960` listener from host `127.0.0.1:40960` on real macOS/Lima, including occupied-host-port and occupied-guest-port cases.
- [ ] M0.7 Against a disposable OpenCode runtime, submit one known message asynchronously and measure admission response, message visibility delay, status transitions, assistant parent correlation, terminal fields, pending permission/question behavior, and pagination direction.
- [x] M0.8 Confirm whether `client.session.promptAsync` or `client.v2.session.prompt` provides the smaller reliable durable-admission contract for the installed runtime. OpenCode 1.18.21 uses one `session.promptAsync` call with explicit message ID and 204 acknowledgment.
- [ ] M0.9 If credentials are available, confirm ChatGPT can discover a local deterministic tunnel tool and that desktop Voice can invoke it with the expected approval behavior.
- [x] M0.10 Update the progress/blocker tables and replace candidate versions with exact pins and observed behavior.

M0 gate:

- Exact package/tunnel versions and negotiated MCP revisions are recorded.
- Header validation rules are known.
- Lima host-loopback forwarding is proven or the SSH contingency is selected.
- OpenCode admission and final-state predicates are captured as executable fixture expectations.
- Any unavailable ChatGPT/Voice step remains explicitly blocked under B3 rather than being treated as passed.

Progress note (2026-09-26): local official-client initialization/list/call/cancellation/shutdown and OpenCode probes selected the pinned MCP/OpenCode/Zod versions, stateless protocol `2025-11-25`, opaque message pagination, and `promptAsync` admission. M0.3/M0.5/M0.6/M0.9 remain unverified on the external host/tunnel/product path; M0.7 remains partial because real pending-input behavior was not induced.

### M1. MCP Adapter Package

Add an independent package at `adapters/mcp/`. Do not refactor or import OpenLive implementation modules; duplicate only small proven semantics where necessary.

Planned package layout:

| Path | Responsibility |
| --- | --- |
| `adapters/mcp/package.json` | Private ESM package, Node >=22, exact runtime/dev dependencies, check/build/test scripts. |
| `adapters/mcp/package-lock.json` | Locked dependency graph. |
| `adapters/mcp/tsconfig.json` | Strict TypeScript build into `dist/`. |
| `adapters/mcp/src/types.ts` | Runtime/ready descriptors and public structured-result types. |
| `adapters/mcp/src/opencode.ts` | Fixed-project OpenCode gateway, filtering, pagination, status correlation, async submission. |
| `adapters/mcp/src/tools.ts` | Five tool schemas, annotations, result shaping, and sanitized error mapping. |
| `adapters/mcp/src/http.ts` | Loopback HTTP server, token/Host/Origin/body validation, MCP transport lifecycle. |
| `adapters/mcp/src/main.ts` | Descriptor loading, startup compatibility check, ready-file publication, signal shutdown. |
| `adapters/mcp/src/*.test.ts` | Co-located unit and fake-backend tests. |
| `adapters/mcp/tests/opencode-integration.mjs` | Real-runtime contract harness used by M2 and release smoke tests. |

Initial exact dependencies should be the versions proven in M0: `@modelcontextprotocol/sdk`, `@opencode-ai/sdk`, and the schema package required by that MCP SDK, normally `zod`. Avoid Express or another web framework unless the selected official transport requires it; prefer Node's built-in HTTP server.

#### M1.1 Runtime Contract

Load one mode-0600 JSON descriptor from `OCVM_MCP_RUNTIME`:

```json
{
  "schema": 1,
  "project": "/absolute/mounted/project",
  "projectHash": "...",
  "projectName": "opencode-vm",
  "backendUrl": "http://127.0.0.1:4095",
  "generation": "controller-generation",
  "opencodeVersion": "...",
  "listenHost": "127.0.0.1",
  "listenPort": 40960,
  "credentialFile": "/session-share/mcp/credential",
  "managerFile": "/session-share/openlive/manager.json"
}
```

Validate every field, require `listenHost` to be exactly `127.0.0.1`, reject unsafe credential files, and construct the OpenCode client with the fixed project directory. Load backend Basic credentials from the existing environment only for adapter-to-OpenCode calls.

Write `<session-share>/mcp/ready.json` atomically only after the listener is bound and the live OpenCode compatibility check passes. Include schema, project hash, generation, adapter version, PID, port, and supported/negotiated MCP versions. Never include either credential.

#### M1.2 HTTP And MCP Transport

- [x] M1.2.1 Serve MCP at `/mcp` using the exact methods/lifecycle required by the version proven in M0. Support legacy GET/DELETE only if the selected compatibility contract requires them. Return appropriate method errors on that route and 404 on unrelated paths, except authenticated `GET /healthz` for the host readiness probe.
- [x] M1.2.2 Require `X-OCVM-MCP-Token` on discovery and tool requests and compare it in constant time.
- [x] M1.2.3 Return 401 for absent/invalid tokens, 403 for invalid Origin, 413 for oversized bodies, and bounded 4xx responses for malformed protocol traffic.
- [x] M1.2.4 Allow absent Origin for non-browser clients and only exact loopback origins when Origin is present; B6 governs any external additions.
- [x] M1.2.5 Validate Host against loopback endpoint behavior; never accept arbitrary hosts to accommodate DNS rebinding.
- [x] M1.2.6 Cap request bodies at 256 KiB, cap concurrent HTTP requests, and use bounded backend deadlines.
- [x] M1.2.7 Use stateless transport, so no legacy MCP sessions are retained; adapter restart leaves OpenCode sessions untouched.
- [x] M1.2.8 On SIGINT/SIGTERM, stop accepting requests, close active MCP transports, remove only the owned ready file, and exit within a bounded interval.

#### M1.3 OpenCode Gateway

- [x] M1.3.1 On startup, check OpenCode health and required API behavior with a non-mutating request; fail as `BACKEND_INCOMPATIBLE` when the response shape is unsupported.
- [x] M1.3.2 Resolve the current OpenCode project ID and retain the exact descriptor directory as the confinement boundary.
- [x] M1.3.3 Implement one `requireExposedSession(sessionID)` path used by all ID-addressed tools.
- [x] M1.3.4 Reject a session unless project ID and directory both match; reject archived, child, and OpenLive manager sessions.
- [x] M1.3.5 Implement bounded session listing with backend cursors, descending update order, and no unbounded fetch.
- [x] M1.3.6 Implement text-only history with IDs/parent IDs and a 32,000-character result budget. Do not return attachments, reasoning, raw tool inputs/outputs, or full backend errors.
- [x] M1.3.7 Query pending questions and permissions by the validated session and report only counts needed to direct the user to Web UI/TUI.
- [x] M1.3.8 Preserve existing agent/model/variant from v2 session metadata; fall back to the most recent user-message settings only when metadata is absent; otherwise reject submission.
- [x] M1.3.9 Check session activity and pending input immediately before admission, while documenting the unavoidable cross-client race.
- [x] M1.3.10 Generate the user message ID, call the selected async admission API once, and return after acknowledgment. Never retry automatically after timeout/disconnection.
- [x] M1.3.11 Implement the correlated-state algorithm from section 4 with the M2 terminal-state and pagination evidence.

#### M1.4 Adapter Tests

- [x] M1.4.1 Test schemas, defaults, limits, annotations, text fallback, and structured results.
- [x] M1.4.2 Test token, Host, Origin, content type, body limit, unsupported route, initialization, and shutdown behavior.
- [x] M1.4.3 Test project/list/direct-ID confinement, child/manager/archive exclusion, and non-disclosing out-of-scope errors.
- [x] M1.4.4 Test pagination scan limits, history text limits, cursor errors, and concurrent deletion.
- [x] M1.4.5 Test idle/busy/retry, pending input, success/failure/abort, no-visible-message race, and multiple correlated assistant messages.
- [x] M1.4.6 Test per-session submission exclusion and simultaneous submissions to different sessions.
- [x] M1.4.7 Test admission timeout after fake-backend acceptance and prove there is exactly one backend call.
- [x] M1.4.8 Test restart reconciliation with no adapter-side receipt database.

M1 gate: `npm ci --ignore-scripts`, `npm run check`, `npm run build`, and `npm test` pass in `adapters/mcp/`; an official MCP client can initialize, list five tools, and call deterministic fake-backend cases.

Progress note (2026-09-26): clean install, strict type-check, build, and all 18 tests pass. The official SDK client lists exactly five tools and invokes and cancels calls over stateless HTTP. The suite includes concurrent deletion, same-session serialization, and independent different-session submissions.

### M2. Real OpenCode Contract Harness

Use a disposable OpenCode runtime with a deterministic fake provider, following the existing `adapters/openlive-acp/tests/opencode-tool-integration.mjs` approach.

- [x] M2.1 Create a project and at least one root work session using the real runtime.
- [x] M2.2 Prove list/get/history/status use the same session IDs visible through the OpenCode API.
- [x] M2.3 Submit a unique harmless prompt through MCP and require exactly one corresponding OpenCode user message.
- [x] M2.4 Poll status with bounded backoff until terminal; correlate every returned assistant message to the receipt ID.
- [ ] M2.5 Exercise at least one tool-using response with multiple message/part updates.
- [ ] M2.6 Exercise a deterministic provider failure and, if the harness permits, a pending permission/question.
- [x] M2.7 Restart only the MCP adapter and prove the same receipt can still be inspected without replay.
- [ ] M2.8 Submit a competing prompt through another OpenCode client and prove it is not attributed to the MCP receipt.
- [x] M2.9 Freeze the verified completion/pagination rules in code tests and `docs/MCP-INTERFACE.md`.

M2 gate: the real-runtime integration harness passes repeatedly without duplicate prompts, false completion, or a second OpenCode process.

Progress note (2026-09-26): `npm run test:integration` passes repeatedly against OpenCode 1.18.21 with one runtime, one admitted user message, correlated completion, opaque `x-next-cursor`, adapter restart recovery, and no replay. Tool-using, provider-failure/pending-input, and competing-client cases remain unchecked M2 extensions.

### M3. `opencode-vm.sh` Lifecycle Integration

This milestone is the first change to `opencode-vm.sh`; increment only the patch component of `OCVM_VERSION` when this milestone is implemented. Re-read the current version first because other dirty work may have moved it.

#### M3.1 Constants, Flags, And Persistent State

- [x] M3.1.1 Add independent MCP adapter release/cache constants beside the OpenLive constants, plus `DEFAULT_MCP_PORT=40960`.
- [x] M3.1.2 Extend `parse_web_flags` with tri-state `SESSION_MCP_MODE` (`""`, `enable`, `disable`) and optional `SESSION_MCP_PORT`.
- [x] M3.1.3 Add the conflicts and validation described in section 5; existing sessions without MCP fields resolve to disabled.
- [x] M3.1.4 Extend `write_senv` with trailing optional `SESS_MCP_ENABLED` and `SESS_MCP_PORT` fields so old callers/records remain readable.
- [x] M3.1.5 Update every `write_senv` call, including cleanup, TLS changes, attach takeover, new attach generation, `_update_senv_mode`, `_destroy_prev_session`, and fresh tracking, to preserve the fields.
- [x] M3.1.6 Centralize precedence: explicit invocation overrides persisted state; bare reconnect preserves it; fresh without `--mcp` disables it.
- [x] M3.1.7 Append new guest script arguments after the existing argument 13 so current OpenLive argument contracts do not shift.

#### M3.2 Credential And Port Helpers

- [x] M3.2.1 Add `ensure_mcp_credential`, `validate_mcp_credential`, and `read_mcp_credential_path` helpers without ever returning the token to normal output. Descriptor-based reads use `O_NOFOLLOW` through the pinned state-directory fd.
- [x] M3.2.2 Preserve a valid credential for the retained session, including while disabled. Let existing fresh/destroy share removal rotate it.
- [x] M3.2.3 Add a host loopback occupancy check; do not reuse `_port_wildcard_busy`, which deliberately ignores loopback listeners.
- [x] M3.2.4 Reject overlap with `HOST_TCP_PORTS`, the full guest block `P-2..P+3`, the host public web block, or a foreign host listener. On reconnect, distinguish a still-live owned listener and delayed Lima forwarding teardown from a foreign collision.
- [x] M3.2.5 Extend `start_web_tunnels` candidate selection with an optional reserved MCP port so a shifted public block cannot consume it.
- [x] M3.2.6 After guest start, run a generation-bound host watcher that requires `ready.json` and an authenticated host-loopback `/healthz` response before printing the MCP endpoint. Feed the header to curl through stdin/config rather than argv. On timeout, terminate only the matching controller so normal cleanup runs.

No new host tunnel process is part of the baseline. If M0 selects the SSH contingency, add an owner-scoped start/stop pair and include its cleanup in every fresh/attach/controller path before implementing the rest of M3.

#### M3.3 Source/Release Cache And Session Staging

Add dedicated functions modeled on, but not coupled to, the OpenLive implementation:

```text
mcp_adapter_release_url
mcp_adapter_cache_dir
mcp_adapter_dev_valid
mcp_adapter_release_valid
mcp_adapter_source_dir
mcp_adapter_present
mcp_prepare_adapter_cache
mcp_stage_adapter
mcp_unstage_adapter
```

- [x] M3.3.1 Prefer a complete adjacent `adapters/mcp` checkout; fail on an incomplete adjacent tree rather than silently selecting stale cache content.
- [x] M3.3.2 For installed scripts, download only the pinned HTTPS release URL, verify the embedded SHA-256 before extraction, reject unsafe members/links/special files, validate the manifest, and atomically activate a version+digest cache.
- [x] M3.3.3 Stage under `<session-share>/mcp/adapter` with a managed marker, excluding `node_modules` in all modes and source `dist` in checkout mode.
- [x] M3.3.4 Stage only for MCP-enabled web sessions. Disabled ordinary web sessions do not download, install, or build this package.
- [x] M3.3.5 Unstage only owned adapter/runtime/readiness files; preserve credential and configured port for disable/re-enable.
- [x] M3.3.6 Keep OpenLive cache/staging behavior unchanged. Do not add MCP manager agents, plugin dependencies, or `opencode.json.mcp` entries.

For MVP isolation, use dedicated MCP validation/cache functions even where they resemble OpenLive. Do not refactor the security-sensitive OpenLive installer into a generic framework during this feature.

#### M3.4 Guest Process Lifecycle

Add these helpers to the shared `OCVM_WEB_LIB_SH` near `start_a2a`:

```text
prepare_mcp_adapter
stop_mcp_adapter
start_mcp_adapter
wait_for_mcp_adapter
mcp_watch_ready
```

- [x] M3.4.1 Source checkout preparation runs locked `npm ci --ignore-scripts --no-audit --no-fund` then builds; packaged preparation runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` and requires `dist/main.js`.
- [x] M3.4.2 Resolve `OC_PORT_INTERNAL` only after `start_web_proxies`, because proxy fallback can move OpenCode back to the public base port.
- [x] M3.4.3 Write the runtime descriptor atomically with mode 0600, remove stale readiness, then start an ownership-marked supervisor under `aa-exec -p opencode-sandbox`.
- [x] M3.4.4 Close runtime-lock fd 9 and terminal descriptors in detached supervisor/child processes so finalization cannot be held open accidentally.
- [x] M3.4.5 The adapter may wait for the backend to appear but must validate it before readiness. Supervisor restart never submits or replays work.
- [x] M3.4.6 `stop_mcp_adapter` kills supervisor before child, validates process markers before signaling, waits boundedly, escalates, and verifies listener removal before deleting state.
- [x] M3.4.7 Older sessions install the current web library before lifecycle takeover; installation failure leaves the prior runtime untouched, so duplicate fallback process definitions are unnecessary.
- [x] M3.4.8 Call start/stop/watch symmetrically in both fresh and attach web branches and both guest EXIT traps.
- [x] M3.4.9 Start MCP before foreground `opencode web`; let `mcp_watch_ready` observe the final state and terminate the controlling session shell if explicit MCP readiness fails.
- [x] M3.4.10 Stop MCP before stopping OpenCode so new external work is refused during finalization, and propagate unverified shutdown as failure.

#### M3.5 Fresh, Reconnect, Disable, And Failure Paths

- [x] M3.5.1 Fresh enabled start: validate host port, create credential, prepare/stage package, clone/start VM, start adapter, require host readiness, persist state.
- [x] M3.5.2 Bare reconnect: preserve enabled flag, port, and credential; stop the old owned adapter through lifecycle finalization; refresh staging; start a new generation without replay.
- [x] M3.5.3 Explicit `--no-mcp`: take lifecycle ownership, stop old adapter, remove managed staging/runtime/readiness, preserve credential/port, persist disabled state.
- [x] M3.5.4 Explicit port change: stop the old generation before collision checks and persist the new value only after transition preparation succeeds.
- [x] M3.5.5 Preparation failure before takeover leaves the old session untouched. Failure after takeover preserves the VM/share and prints exact recovery instructions; do not claim the old runtime is still active.
- [x] M3.5.6 A stale controller cleanup cannot stop a replacement generation. Existing `SESS_CONTROLLER` ownership checks remain authoritative.
- [x] M3.5.7 Public web/A2A/OpenLive routes remain unchanged; never route `/mcp` through `OCVM_WEB_REDIRECT_PY`.

#### M3.6 CLI Output And Bash Tests

- [x] M3.6.1 Update help and examples for `--mcp`, `--mcp-port`, and `--no-mcp`.
- [x] M3.6.2 Add a separate MCP-ready message emitted only by the successful host watcher, showing `http://127.0.0.1:<port>/mcp` and the credential file path. Do not put an unverified endpoint in the initial guest web banner and never print the token.
- [x] M3.6.3 State that MCP remains authenticated under `--no-auth`, fresh rotation requires tunnel profile refresh, and only host-local clients can reach it.
- [x] M3.6.4 Add `tests/mcp_adapter_test.sh` for flag/state/secret/staging/lifecycle/banner behavior.
- [ ] M3.6.5 Test legacy session records, reconnect preservation, disable/re-enable, fresh rotation, unsafe credential files, host/guest collisions, public-block overlap, generation mismatch, stale PID markers, and fd 9 closure.
- [x] M3.6.6 Scope existing `tests/openlive_test.sh` string-count assertions to OpenLive functions so new npm/staging code does not create false failures.
- [x] M3.6.7 No mock-limactl extension was required because the selected path uses Lima loopback and focused helper fixtures.

M3 gate: shell syntax, focused ShellCheck, `tests/mcp_adapter_test.sh`, `tests/openlive_test.sh`, `tests/web_proxy_remote_test.py`, `tests/provider_test.sh`, `tests/provider_lifecycle_test.sh`, and relevant lifecycle tests pass; only `127.0.0.1` is advertised for MCP.

Progress note (2026-09-26): syntax, ShellCheck error severity, focused MCP lifecycle/security fixtures, OpenLive, web proxy, provider, provider lifecycle, besprechung, and VS Code trust regressions pass. Automated tests cover credential/path safety, no-follow staging, concurrent/stale cache activation, guest-port overlap, process ownership/escalation, fd 9 closure, host readiness propagation, and shutdown failure propagation. The complete M3.6.5 real transition/collision matrix remains pending real macOS/Lima work, so M3 is not marked complete.

### M4. Reproducible Release And Standalone Installation

Publish MCP as a second independent archive in the same script-version release:

```text
opencode-vm.sh
opencode-vm-openlive-adapter-<openlive-version>.tar
opencode-vm-mcp-adapter-<mcp-version>.tar
SHA256SUMS
```

Use one release tag, `v<OCVM_VERSION>`, for the script and both pinned artifacts. Keep OpenLive and MCP package versions independent.

- [x] M4.1 Add `scripts/build-mcp-adapter.sh` using the existing deterministic GNU-tar conventions and an explicit production-file allowlist.
- [x] M4.2 Package `package.json`, lockfile, license, manifest, and required `dist` files only. Exclude source, tests, maps unless required, `node_modules`, credentials, logs, runtime descriptors, and readiness files.
- [x] M4.3 Include adapter version, exact MCP/OpenCode SDK versions, Node requirement, transport, and tested MCP revision in `manifest.json`.
- [x] M4.4 Add `MCP_ADAPTER_VERSION`, tag, filename, digest, SDK-version constants, URL/cache/source validation, and standalone staging to `opencode-vm.sh`.
- [x] M4.5 Update `.github/workflows/release.yml` triggers and metadata checks for `adapters/mcp/**` and `scripts/build-mcp-adapter.sh`.
- [x] M4.6 Require an existing release to contain the script, both adapter archives, and checksum entries for both archives.
- [x] M4.7 Install/check/build/test both packages, build both archives twice, require byte equality, install production dependencies with scripts disabled, and smoke-test extracted entry points.
- [x] M4.8 Add the MCP archive to release publication and changed-release-input detection.
- [x] M4.9 Extend `tests/release_metadata_test.py` and `tests/release_state_test.py` for stale tag/version/filename/digest, missing assets, incomplete checksums, and publication arguments.
- [x] M4.10 Update only shared release assertions in `tests/openlive_test.sh`; preserve OpenLive install/uninstall behavior.
- [x] M4.11 Reconcile B1 with the current owning work, retain or update the patch increment introduced with script edits as required by the actual release baseline, and calculate final archive digests. Both tags are `v0.5.60`; the MCP digest is `8234d7247f00d4f9d89006cc2747011dcf627c12ee59244739244c5302e237f0`.

M4 gate: two independent builds of each archive are byte-identical; checksum and unsafe-archive tests pass; a copied standalone `opencode-vm.sh` can download, verify, cache, stage, install, and start the pinned MCP package without adjacent repository files.

Progress note (2026-09-26): MCP double builds are byte-identical at the pinned digest above; concurrent/stale standalone cache activation, source/release staging, archive content, release metadata/state, OpenLive regression, and actionlint checks pass. The final copied-script start inside a real Lima VM remains coupled to M6 and is not inferred from fixtures.

### M5. Documentation

- [x] M5.1 Add `docs/MCP-INTERFACE.md` with exact tool schemas/results/errors, async polling, truncation, approval behavior, concurrency limits, project confinement, and shared-service authorization.
- [x] M5.2 Add a Secure MCP Tunnel runbook in `docs/MCP-TUNNEL.md`, with a secret-free profile, required permissions, `doctor --explain`, health/readiness checks, ChatGPT app creation, Voice use, and teardown.
- [x] M5.3 Show both `extra_headers` and `discovery_extra_headers` reading the same credential file:

```yaml
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:40960/mcp
  extra_headers:
    X-OCVM-MCP-Token: file:/absolute/path/to/session-share/mcp/credential
  discovery_extra_headers:
    X-OCVM-MCP-Token: file:/absolute/path/to/session-share/mcp/credential
  startup_wait_timeout: 60s
```

- [x] M5.4 Clearly separate `opencode-vm mcps` (servers OpenCode consumes) from `web --mcp` (OpenCode exposed as a server).
- [x] M5.5 Update README/help, `docs/RELEASING.md`, and `AGENTS.md` architecture/release notes.
- [x] M5.6 Document that disabling preserves the credential, fresh rotates it, and rotation requires restarting/reconfiguring `tunnel-client`.
- [x] M5.7 Document the absolute trust boundary: an authenticated MCP client can read and mutate existing project sessions, and returned history is disclosed to the external product.

M5 gate: a maintainer who has a tunnel ID/key but no repository source can follow the installed-script runbook without guessing a URL, header, credential location, or approval step.

Progress note (2026-09-26): all planned interface, tunnel, README/help, architecture, trust-boundary, credential-lifecycle, and release documentation is present. Reproducing it with real tunnel credentials remains an M6/M7 acceptance step.

### M6. Real macOS/Lima And Generic Tunnel Acceptance

Prerequisites: a real macOS host, current Lima VM, selected `tunnel-client`, tunnel ID, restricted runtime key, and correct organization/workspace association.

1. Start a project with `opencode-vm web --mcp` and an existing work session.
2. Prove the guest and host listeners bind only to loopback and that LAN connections are refused.
3. Prove missing/wrong token requests fail and the correct token supports discovery and a read-only call.
4. Run `tunnel-client doctor --profile ... --explain`; require its MCP discovery probe to pass.
5. Start the tunnel runtime and require `/healthz` and `/readyz` to pass, then execute an actual tunneled read-only tool call.
6. List and inspect the existing session through a generic MCP client.
7. Send a unique harmless prompt, poll it to terminal, and verify the same IDs/content in Web UI/TUI.
8. Test an adapter-only restart separately from `web --reconnect`, which replaces the controlled web runtime. In both cases prove history/status recovery without replay and document that in-flight work may be interrupted by full runtime replacement.
9. Stop the runtime and prove tunnel calls fail; restart against the same session/port/credential and repeat discovery.
10. Disable MCP and prove the listener, readiness, and managed staging are removed while Web UI/TUI continue normally.

M6 gate: all ten steps pass with sanitized evidence. Tunnel health alone is insufficient; one real tunneled tool execution and matching OpenCode history are required.

### M7. ChatGPT Text And Desktop Voice Acceptance

1. Associate the same tunnel with the intended ChatGPT workspace and verify Tunnels Read + Use and custom-app permissions.
2. Create a developer-mode ChatGPT app using Connection: Tunnel and the selected tunnel ID.
3. In text chat, discover all five tools and use `list_sessions`, `get_session`, and `get_session_history` against the known project.
4. Invoke `send_message`, complete any on-screen write approval, poll status/history, and verify the same interaction in Web UI/TUI.
5. Repeat list/read/send/status through the intended desktop Voice experience.
6. Record whether spoken requests require on-screen approval; do not claim hands-free approval if the product requires a click.
7. Verify reconnect and disable behavior from ChatGPT without changing the tunnel ID.

M7 gate: ChatGPT text and desktop Voice each complete a real read and write workflow against the same OpenCode session. A text-only pass does not establish Voice acceptance.

## 7. Validation Matrix

| Layer | Required commands/checks | Required result |
| --- | --- | --- |
| MCP package | `npm ci --ignore-scripts`, `npm run check`, `npm run build`, `npm test` in `adapters/mcp` | Type-safe build and deterministic unit/fake-backend tests. |
| Real OpenCode | `npm run test:integration` or the focused real-runtime harness | One admitted prompt, correlated completion, no duplicate runtime/state. |
| Shell | `bash -n` on changed shell files and focused `shellcheck --severity=error` | No syntax or new error-severity findings. |
| Lifecycle | `bash tests/mcp_adapter_test.sh` plus relevant OpenLive/web/lifecycle suites | Fresh/reconnect/disable/failure symmetry and no regression. |
| Release | Python metadata/state tests and two-build artifact comparison | Complete atomic release contract for both adapters. |
| Security | Auth/Origin/Host/body-limit/path/archive/secret-leak tests | Endpoint remains private, authenticated, scoped, and secret-free in output. |
| macOS/Lima | Listener inspection, host probe, reconnect, collision, teardown | Stable loopback endpoint and complete cleanup. |
| Tunnel/ChatGPT | `doctor`, readiness, real tool calls, matching backend history | End-to-end text and Voice acceptance. |

Also run `git diff --check`. Do not mass-fix unrelated ShellCheck/test findings; report critical pre-existing findings separately as required by repository policy.

## 8. Critical Path And Scope Controls

Critical path to a first functional checkout pilot:

```text
R1 local protocol/backend proof + parallel host/account checks
  -> R2 read-only adapter and optional early external read test
  -> R3 verified async write path
  -> R4 source-checkout lifecycle
  -> R5 minimal runbook + real tunnel/ChatGPT/Voice pilot
  -> R6 release package + complete docs + packaged acceptance rerun
```

This ordering does not waive M4-M7. A successful checkout pilot is not a release-ready MVP, and an unavailable Voice test remains blocked rather than passing on the strength of a text test.

Scope controls:

- Do not add session create/delete/interrupt tools to unblock the baseline.
- Do not add cross-project discovery; one endpoint remains one project.
- Do not install or supervise `tunnel-client` from `opencode-vm`.
- Do not expose MCP on the public web/A2A proxy or LAN.
- Do not add OAuth unless M0 proves static private-upstream authentication cannot satisfy ChatGPT tunnel acceptance.
- Do not add a receipt/task database; reconcile from OpenCode's durable messages.
- Do not refactor OpenLive, A2A, or generic release infrastructure unless the MVP cannot be made correct without it.
- Do not silently broaden Host/Origin rules when tunnel acceptance fails; capture and document the required exact behavior.
- Do not close blockers by weakening acceptance criteria.

## 9. Definition Of Done

The baseline is complete only when:

- The exact pinned versions and protocol behavior are recorded in this document and the release manifest.
- The five-tool contract operates on the existing project's sessions and runtime with bounded results.
- A submitted message returns promptly, can be correlated after restart, and is never retried automatically on uncertainty.
- Private binding, authentication, Host/Origin validation, project confinement, and complete teardown are verified.
- Fresh, reconnect, disable/re-enable, collision, stale-process, and failure paths are automated.
- Both source checkout and single-script release installations are supported.
- Automated checks and real macOS/Lima acceptance pass.
- Secure MCP Tunnel executes real calls rather than only reporting healthy.
- ChatGPT text and the intended desktop Voice flow pass against the same OpenCode session.
- Documentation states approval behavior, concurrency limits, shared-service authorization, data disclosure, credential lifecycle, and deferred capabilities.
- Every blocker in the ledger is resolved or explicitly accepted by the user with a documented limitation.

## 10. Progress Update Procedure

During implementation, keep this document current:

1. Mark exactly one active milestone `In progress` in the Progress Ledger.
2. Check task boxes only after their code and focused verification are complete.
3. Add every newly discovered blocker to the Blocker Ledger before working around it.
4. When resolving a blocker, keep the row and change its status to `Resolved`, recording the decision/evidence in the unblock column.
5. At each milestone gate, record the exact test commands and result beneath that milestone in a dated `Progress note:` paragraph.
6. If implementation changes a tool schema, security boundary, version pin, or acceptance criterion, update the governing section before continuing.
7. Never mark M6/M7 complete from mocked or local-only evidence.

## 11. References And Planning Record

- [Feature request](https://github.com/GeektankLabs/opencode-vm/issues/2)
- [OpenAI Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Tunnel-client configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [Tunnel-client connector behavior](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md)
- [Tunnel-client end-user guide](https://github.com/openai/tunnel-client/blob/master/docs/end-user-guide.md)
- [ChatGPT Voice documentation](https://help.openai.com/en/articles/20001274/)
- [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- Existing repository references: `docs/A2A-INTERFACE.md`, `docs/RELEASING.md`, `adapters/openlive-acp/`, and `scripts/build-openlive-adapter.sh`.

The plan began from issue/documentation research and is now also the implementation ledger for the local connector. Product documentation, tunnel behavior, and account availability can change; recheck them during M6/M7.

Local implementation and runtime tests were performed on 2026-09-26. Existing unrelated working-tree changes remain outside this document's scope and must remain untouched.
