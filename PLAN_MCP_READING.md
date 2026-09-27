# MCP Delivery A: original reading and task results

Date: 2026-09-27. Script 0.5.67 / adapter 0.1.3.

Implementation and local automated acceptance are complete. Hosted ChatGPT/Voice and real macOS/Lima acceptance remain external; this is not a claim of end-to-end product acceptance.

## Agreed scope

Delivery A implements package 1, the functional core of package 2, and only necessary status fields, descriptions and metadata diagnostics from package 3. Delivery B is a small journal tail/continuation improvement plus observable tool metadata. Incremental history, general tool outputs, export and personal discussion state are deferred. Idempotency is a separate prerequisite before any automatic write retry. MCP 2026-07-28 migration is a separate decision, not a requirement of Delivery A.

## Findings and implementation decisions

- The previous adapter shared 32,000 JavaScript UTF-16 code units among all history messages and conflated more history with clipped text. This explains blank following messages and history-limit-dependent report visibility. It does not establish loss in OpenCode storage or additional client-side clipping.
- The existing SDK's legacy direct-message endpoint preserves text, identity and assistant `parentID` on the tested real backend. Reuse it; native v2 history and protocol tasks are not necessary.
- One `visible-text-v1` projection selects existing non-synthetic/non-ignored text parts in source order and joins them without separators. Get-message/history/task-result previews use that same selection. Hidden/tool/file parts are counted, never exported.
- `get_message` and `read_message_content` provide authenticated adapter-lifetime references, UTF-8 byte ranges, a SHA-256 of the complete visible text and explicit revision changes. No snapshots or conversation copies are retained. Reacquire after adapter restart; a missing original is an error, not regeneration.
- `get_task_result` scans bounded backward pages by the submitted user ID and existing parent relation. Cursors preserve progress and aggregate terminal evidence; clients retain result references from all pages. Empty search pages can have continuation. There is no 100-message total-search cutoff and no permanent index. Observed session/head/user changes invalidate a scan explicitly. This is not a transactional snapshot; out-of-band source edits that bypass backend update metadata cannot be guaranteed detectable.
- The existing fast status lookup remains bounded, with observation time/source and reasons for ambiguity. Later/unattributed pending input cannot override an old completed turn. A successful deep terminal lookup also reconciles the MCP admission guard, so long completed turns do not remain permanently busy.
- Preview default: 1024 UTF-8 bytes. Content default: 8192, caller-selectable 4..16384. Structured read payload: 48 KiB; full serialized JSON-RPC response: 64 KiB. Metadata/reference/cursor budget is preserved. JSON-RPC request IDs are bounded to 1024 serialized bytes to make the envelope bound meaningful.
- Keep `structuredContent` plus concise `content`, deliberately avoiding duplicate report bytes. This differs from the MCP 2025-11-25 backward-compatibility SHOULD for duplicated JSON text; the supported local clients read structured results correctly. Text-only clients remain unaccepted until a measured fallback is needed and budgeted. Real ChatGPT visibility remains a separate acceptance item.
- The SDK throws parsed error bodies without necessarily preserving HTTP status. New direct reads and shared session exposure checks inspect non-throwing SDK responses to distinguish real 404s from backend failures, without returning raw bodies.
- No automatic resend, model summarization, discussion acknowledgement, new permission-answer path, transport upgrade or SDK upgrade is introduced.

## Compatibility record

Baseline commit: `e11574955394c869fd3ca7c3451563d7074a5678`, with the Delivery A working-tree patch. No implementation commit has been created by the agent; record the eventual release commit at host acceptance.

- Adapter: 0.1.3, MCP SDK 1.30.1, OpenCode SDK 1.18.21; Node.js 22.
- Disposable backends: OpenCode 1.18.21 and the session-installed 1.18.32, each with isolated config/state/project and a controlled synthetic provider. Both integration runs passed on 2026-09-27.
- Direct path: official MCP SDK client → loopback adapter → real OpenCode. Observed initialize offer **2025-11-25**, result **2025-11-25**, subsequent HTTP header **2025-11-25**. This tests the established revision, not native 2026-07-28.
- Tunnel path: official MCP SDK client → tunnel-client **0.0.15** local development proxy/control plane → adapter with synthetic backend fixtures. Linux arm64 binary archive SHA-256: `c51bfd883fc22e3445494a03c0179875176564bde470661b308fd83af5d01abb`, matching the existing script pin. Client-side initialize offered/negotiated **2025-11-25**. No hosted OpenAI path or intermediate protocol translation is asserted.
- ChatGPT surface/account/workspace: **not tested in this session**. Its actual negotiated revision and structured-result/model visibility remain unobserved. No maximum supported ChatGPT revision is claimed.

## Automated evidence

- Unit/fake-backend/HTTP suite: 41 tests passing, including >200-KB Unicode/code reconstruction, history limits 1/20, follow-on entries, projection omissions, growing content, `finish:length`, expired/tampered/cross-query references, source loss, session confinement, 130 tool-call steps and later blocked/completed work, empty search pages, explicit search changes, and deep admission-guard recovery.
- Actual serialized HTTP results are measured, including JSON escaping and envelopes. Large identifiers exercise metadata-first preview shrinking/page reduction without losing pagination. Oversized reflected request IDs are rejected with a small error.
- Real OpenCode + SDK MCP integration: **320,036 UTF-8 bytes** reconstructed hash-identically without an additional provider request. After 105 stored no-reply follow-ups plus a later task, the old result is recovered in **six search pages** and both tasks retain their parent identities. Direct missing-message/session errors are verified. References expire across actual adapter restart; fresh lookup recovers the same original hash. Maximum measured read response in this fixture: **16,612 bytes**.
- Real tunnel-client local-control-plane test discovers/invokes all thirteen tools and reconstructs **290,017 UTF-8 bytes**, matching SHA-256. Maximum measured content/result response: **9,905 bytes**. This is programmatic tunnel interoperability, not ChatGPT acceptance.
- Packaging uses the existing independently versioned adapter artifact, now including `dist/content.js`; source/release completeness checks require it. Two MCP archive builds are byte-identical; SHA-256 `503e660ebdb694393e46e6e7b21873b4e9e961b065c6e8ec3876a538c80077c2` is pinned in the script. The unchanged OpenLive archive was also rebuilt twice byte-identically and matches its existing pin. TypeScript checks, release metadata/state tests, shell syntax and ShellCheck error-level validation pass; release/package checks follow `docs/RELEASING.md`.
- MCP and OpenLive shell lifecycle/package tests, Linux lock regression, Besprechung regression, OpenLive's 46 unit tests and real integrations pass. The extracted MCP package installs only locked production dependencies and reaches the expected missing-runtime startup check. Actionlint 1.7.7 validates the release workflow; `git diff --check` passes. Native macOS shell/platform checks remain part of target-host/CI acceptance.

## Required external acceptance

After deploying the candidate on the host, reconnect the project runtime and refresh/publish the ChatGPT tool catalog as required by that product. Use a disposable acceptance session and synthetic originals, not the diagnostic user sessions from the improvement request.

1. Record release commit, all component versions, date, exact ChatGPT surface/account/workspace and observed protocol offer/selection or version metadata. If a middle component translates, record each observed leg separately.
2. Confirm the three reading tools appear and structured text, IDs, availability and cursors are usable by the coordinating model.
3. Read a known ≥200-KB stored report through content pages and recover a distinctive fact from its end. Compare exact byte ranges/hash with a programmatic client over the actual route where accessible; do not ask the model to calculate the hash mentally.
4. Check history limits 1/20 with a following message, old/later task separation, revision change recovery and reference reacquisition after restart. Verify that no model re-execution or implicit read/discussion acknowledgement occurs.
5. Repeat the relevant interaction in the intended Voice surface if Voice is part of acceptance. A text-mode or SDK success does not establish Voice support.

Report only: “This combination works on revision X for these functions.” If the host truncates/hides structured output, investigate that measured boundary and introduce a budgeted fallback only as required. Absence of a general OpenAI version ceiling does not block the established-path reading feature.
