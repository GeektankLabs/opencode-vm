# ChatGPT, Secure MCP Tunnel and the companion skill

Use ChatGPT as a coordinating interface for an opencode-vm project: inspect sessions, delegate an authorized task, observe tools and discuss original reports. The existing OpenCode runtime in the VM does the project work.

**[Download OpenCode Session Orchestrator](https://github.com/GeektankLabs/opencode-vm/raw/refs/heads/main/integrations/chatgpt/opencode-session-orchestrator.zip)** · [Checksum](../integrations/chatgpt/opencode-session-orchestrator.zip.sha256) · [Review the skill source](../integrations/chatgpt/opencode-session-orchestrator/SKILL.md)

The ZIP is an optional instruction-only skill with an SVG icon. It contains no tunnel configuration or credentials. A skill improves tool usage; the MCP connection supplies the actual capabilities. Both are set up separately.

## 1. Configure the OpenAI MCP connection on the Mac

Run these commands in the **host terminal**, from the project directory:

```bash
opencode-vm provider mcp new openai
opencode-vm web
```

The first command registers this project's connection. It offers reusable stored entries or asks for a tunnel ID and hidden tunnel API key input. The second starts the project runtime, its MCP adapter and the configured tunnel. For a terminal UI instead of web mode, use `opencode-vm start`; configured projects also start their MCP tunnel there.

Before setup, create/select a tunnel in [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), associate it with the intended ChatGPT workspace, and create an appropriate [runtime API key](https://platform.openai.com/settings/organization/api-keys). Running the tunnel requires Tunnels **Read + Use**; creating/managing it requires the corresponding Manage permission. The local wizard registers existing OpenAI values rather than creating remote tunnel objects.

Inspect the result:

```bash
opencode-vm provider mcp status openai
opencode-vm provider mcp list
```

Wait for authenticated MCP readiness and successful OpenAI polling. Polling proves tunnel connectivity, not that ChatGPT has the latest tools or can use them in every product surface.

Use distinct tunnel IDs for projects running simultaneously. Keep the selected project session running during discovery and calls. Settings, storage, reconnect and troubleshooting details are in [MCP-TUNNEL.md](MCP-TUNNEL.md).

`provider mcp new openai` configures the incoming ChatGPT-facing **MCP connection**. It does not select OpenAI as the coding model or change the session's agent/model/variant. ChatGPT and the OpenCode work session can use different models. Keep the tunnel key in the private host configuration; never place it in the skill or chat.

## 2. Add the connection in ChatGPT

UI/documentation snapshot: **2026-09-27**. Account, workspace and surface availability can differ. Developer mode, MCP tools and skill uploading are distinct permissions/features; confirm each in the target UI.

1. Enable **Developer mode** under **Settings → Security and login**, where available and allowed by the workspace.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins), add a developer-mode connection, and choose **Tunnel** under **Connection**.
3. Select or enter the tunnel associated with the intended project/workspace. Choose a meaningful connection name; the skill is not tied to that name.
4. Inspect the discovered tools. After an adapter upgrade, use the connection's **Refresh** action and test in a new conversation. Published/managed apps can have a different update flow.
5. Select the connection in the conversation. With several compatible connections, identify which project ChatGPT should use.

The opencode-vm Delivery B reference surface (0.5.68 / adapter 0.1.4) exposes fourteen tools, including `get_task_result`, `get_message`, `read_message_content` and `get_session_progress`. Discover the actual runtime contract rather than assuming a version from the names. The skill also supports older compatible contracts with explicit limitations.

Since opencode-vm 0.5.72 / MCP adapter 0.1.7, the fifteenth tool `archive_session` archives eligible idle project sessions after explicit authorization; known archived IDs remain available to selected read tools using `include_archived:true`. ChatGPT skill r6 offers bounded `[KLÄRUNG]` sessions for independent details while the origin is busy, verifies the latest identifiable OpenAI Luna/xhigh runtime before the first handoff, and distinguishes local closure from optional server archive. Installing a new ZIP does not automatically refresh the connected MCP tool catalog, nor does a connector upgrade replace the installed skill ZIP.

Since opencode-vm 0.5.96 / MCP adapter 0.1.14, `rename_session` changes an existing idle session's native OpenCode title by `session_id`; the session ID and history remain unchanged. Archived, missing and otherwise unexposed sessions return `SESSION_NOT_FOUND`. Reconnect the project runtime and refresh the connected app's tool catalog before expecting the new tool to appear.

Since opencode-vm 0.5.78 / MCP adapter 0.1.9, `upload_attachment` and `send_message.attachments` provide a controlled, session-bound upload path for images and text files. This requires the connected client surface to supply file bytes to the tool as Base64; merely attaching a file to a ChatGPT conversation does not prove that its contents will be forwarded to the OpenCode session. Verify this behavior in the target ChatGPT text/Voice surface before relying on it.

Adapter 0.1.11 adds the discovered `supersede_unresolved_submission` tool for an idle but still unresolved receipt. The client must inspect the concrete old receipt/current `guarded_message_id`, explain the remaining duplicate-delivery risk, and get fresh approval specifically for that guard. The operation combines the override and the intended next prompt; it returns the new message ID to verify, so ChatGPT must not call `send_message` a second time for that task. Keep the same client UUID and exact fields if recovering an uncertain response. The companion skill r8 documents this flow. The `operator_authorized:true` input is an explicit client assertion, not proof of human identity; hosted ChatGPT behavior still requires a test in the target workspace/surface.

## 3. Download and install the skill ZIP

1. Download the [ZIP](https://github.com/GeektankLabs/opencode-vm/raw/refs/heads/main/integrations/chatgpt/opencode-session-orchestrator.zip), optionally checking its [SHA-256](../integrations/chatgpt/opencode-session-orchestrator.zip.sha256).
2. In ChatGPT, open **Plugins → Skills**. In some desktop surfaces, **Skills** is a direct sidebar entry.
3. Choose **Create → Upload from your computer** and select the ZIP. Use the **Skills import UI**, not the ordinary conversation attachment button.
4. Let the product scan the package and complete any review/install/enable step it presents. A package may be marked Needs Review or Blocked by host policy; the skill cannot override that decision.
5. If an older copy is installed, use the product's update/replace flow and verify the release marker in the active skill. Avoid leaving multiple same-name copies active accidentally.
6. Start a test conversation with the intended MCP connection selected. Explicitly select the installed skill if it is not picked automatically.

The uploaded archive contains one top-level `opencode-session-orchestrator/` folder with `SKILL.md`, references, appearance metadata, the icon and license. Do not upload the entire repository archive instead. If skill uploading is not available, check product/workspace eligibility using the official [Skills in ChatGPT](https://help.openai.com/en/articles/20001066-skills-in-chatgpt) guidance; that absence is not an MCP server error.

Downloading/installing this ZIP changes neither the app/workspace permission policy nor the backend's permissions. GitHub updates are not automatically installed into ChatGPT. The maintained files, inventory and reproducible build procedure are in [integrations/chatgpt](../integrations/chatgpt/README.md).

Skill r11 reads the project's Agent Control Hub profile preference when the selected connector exposes it. For **new authorized work** it chooses `deep`, `standard`, or `execution`, applies an exact available configured runtime only to an idle session, verifies it, and briefly reports profile and model/variant before submitting once. Explicit user runtime choices override the profile. Existing result/status reads never change runtime; unavailable configured mappings are not silently substituted. MCP is the first connector with this capability, while A2A/OpenLive do not yet expose profile reads. The Hub stores only provider/model/variant IDs in `<project>/.opencode-vm/agent-control.json`.

Skill r19 and MCP adapter 0.1.17 add project-task document roles (`compact_context`, `concept_plan`, optional `concept_detail`). For a confirmed `todo` → `in_progress` workflow, the work agent prepares both main documents while the task remains `todo`; the orchestrator verifies and registers their references before asking the Board to move. When the connected MCP catalog exposes `get_task_documents` and `read_task_document`, ChatGPT can answer brief task-status questions from the compact context and check document maintenance directly without another agent run. Actual work outcomes still require original session/result evidence. Update the installed skill ZIP and refresh the connector tool catalog independently.

Skill r21 and adapter 0.1.18 prefer `add_task_document_bindings` for one add-only main-role bundle, followed by mandatory available/path/revision readback and a separate Board move/status readback. Only when the new tool is absent may the old register path be used; errors/conflicts never authorize replacement fallback. Explicit management notes use `add_task_management_note`; status/remainder/Executive Summary requests and initialization create no notes. Adapter 0.1.22 stores new notes in a lazy, persistent per-task journal without changing native Description; `get_task_management_history` reads bounded recent/continuation/latest-checkpoint history and revision-bound legacy Description pages. Uncertain appends require journal readback, never blind retry. Older connectors retain only their actual legacy behavior. MCP hints do not guarantee suppression of host approval UI; hosted model behavior remains a separate acceptance level.

Skill r22 integrates Header-Validation with the r21 workflow: exact plain-text `Task-ID: <stable task_id>` first lines, actual C/P header/metadata readback in the agent's terminal and final result before `CONCEPT_READY`. “Checked” alone is not evidence. Adapter 0.1.19 clarifies the existing ID-or-format mismatch diagnostic without relaxing validation or adding a tool. Safely owned formatting errors are repaired minimally in the same files, followed by renewed evidence, preferred bundle (fallback only if absent) and fresh available/path/revision readback before separate Board move/status readback. Foreign IDs require `INPUT_REQUIRED`, never overwrite. Reimport the new ZIP for external skill acceptance; local package tests do not prove Hosted behavior.

Skill r23 additionally integrates ACH-1's five-role profiles onto r21 + Header/r22. Actual discovered schemas gate Design/Review; Design → Standard and Review → Deep → Standard skip only null and stop at configured unavailable/incomplete mappings. Disclose requested/resolved role, preserve explicit user choice and idle/pending/readback/single-send rules. Independent Review evaluates without automatic findings implementation. First optional Hub save checks active MCP capability and backs up exact original bytes before schema-2 migration; old readers cannot read schema 2. No live restart/restaging merely to make roles appear. The add-only binding, header-evidence, management-note and no-blind-retry contracts remain intact. See [Hub contract](../hub/README.md) and [MCP profile interface](MCP-INTERFACE.md#project-runtime-profiles-read-only); Hosted/Mac/Voice acceptance remains separate.

## ChatGPT Work and persistent Work Packages (checked 2026-09-30)

The current [ChatGPT Work and Codex documentation](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) describes Chat as conversational help, Work as an agent for longer multi-step work, and Codex as the dedicated software-development environment. Work availability and its connected apps/tools vary by plan, workspace, role and surface. Verify that the selected Work session actually exposes the intended OpenCode project connection before relying on it.

For this integration, **Work is the outer management/orchestration surface** for a persistent multi-task package; the existing opencode-vm OpenCode runtime remains the repository worker that changes files, runs tests and creates local commits. The package's compact handoff locates its Board task and registered C/P; it does not copy the whole plan or automatically invoke Work. From normal Chat, the user opens Work and pastes the handoff. In a suitable existing Work session, no extra session is required. If that surface cannot access the project connection, do not imply that work was submitted; state the exact missing capability. Work Cloud's files are not the VM's local repository, and a local desktop folder permission is not a substitute for OpenCode project/VM scope.

The project profiles `execution`/`standard`/`deep` and `get_recommended_runtime` resolve OpenCode runtime preferences only. They do not set or map to the ChatGPT Work model picker. State the coordination complexity recommendation and let the Work user choose among models actually available there; resolve an exact project mapping only for a separately authorized OpenCode worker submission, with the existing idle/pending/runtime-readback rules.

For parallel repository writes, the skill requires verified Git worktree ownership; an OpenCode session alone is not isolation. Existing MCP session creation is project-directory-bound, so check actual file-tool targeting before the first write. The skill's Work Package state is project task documents plus existing Board/session/result evidence; it does not add an MCP package schema or claim automated monitoring. Hosted Work/app access, Work-model choice, macOS/Lima worktree persistence and operator acceptance require separate verification.

## 4. Start with a read-only smoke test

Skill r27 adds an instruction-only Monitor Task workflow for explicitly authorized external scheduling. It discovers actual scheduled Work/app/model/readback and single-flight capabilities before activation; a copy/paste bootstrap alone is not an active monitor. Sequential package Waves and long integration/system-test supervision share one master-task/checkpoint loop. Operator Override/Resume provenance remains downstream QC: free-form Management Notes do not authenticate reactivation, so parked scheduled wakeups remain no-op. Update/reimport the companion ZIP and verify its marker in the selected surface; package checks do not prove scheduler access, runtime configuration or hosted pilot acceptance. OpenCode VM does not acquire a scheduler from the ZIP.

Skill r28 routes journal-capable Monitor recovery through exact Board task reads, latest-checkpoint lookup and entries after that checkpoint; older loop/fingerprint history uses bounded cursor pages when needed. Legacy Description notes remain a separate revision-bound source. Journal markers and entry order remain non-authenticating; r28 does not implement trusted scheduled Operator Override/Resume provenance or change the existing fail-closed boundary.

Skill r29 adds generic repository-release management guidance: it discovers and reads the selected repository's own release policy, separates a local candidate from operator-controlled publication, verifies evidence against the exact candidate commit, and preserves a working runtime while the expected gate is red or unverified. The companion skill contains no project-specific release IDs, URLs, credentials or current version constants. Rebuild/reimport the ZIP to use the new guidance; local package checks do not establish hosted behavior or release acceptance.

Paste this into the selected ChatGPT conversation:

```text
Use the installed OpenCode Session Orchestrator skill and the OpenCode MCP
connection selected for this project. This is a read-only check.

Report the skill release marker from the loaded skill and discover the actual
available tools. Select an existing session and, when a completed report exists,
retrieve it directly and read two adjacent small content pages using returned
cursors. Report IDs, revision, byte ranges and exactly what was read; do not
claim a full report read or a computed hash from a sample.

If supported, inspect get_session_progress and obtain a current journal overview
with tail=true. Keep its cursor under filter_key and continue once without tail
using the same filters. State coverage and any tracking limits.

Do not send a task, create a session, change runtime or permissions, or run tests.
If no suitable existing session/report exists, say so rather than creating one.
```

This checks visibility and workflow selection. A full-result test additionally traverses the complete content and verifies bytes/hash programmatically. An actual write-flow test is a separate, explicitly authorized harmless task. Avoid reporting `submitted` as `running`, an idle session as a reviewed result, or a stored tool's `completed` state as substantive success.

## 5. Spoken use: distinguish the product surfaces

This integration passes MCP tool calls and results; it is not a speech engine or a separate OpenAI Realtime audio client. Speech recognition and spoken answers belong to the ChatGPT surface being used.

- **Dictation into a supported text chat:** where offered, speech becomes an ordinary user message; use that conversation's selected MCP connection and permissions.
- **Voice in Chat / Live / Advanced:** do not assume app/MCP availability from a successful text test. The current [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-apps-in-chatgpt) FAQ says Voice mode does not support apps, and the [ChatGPT Voice](https://help.openai.com/en/articles/20001274/) guidance describes connected-app/plugin limitations for Live.
- **Voice in Work or Codex:** OpenAI documents separate desktop experiences with their own available tools and permissions. Verify that the intended MCP connection and skill are actually exposed there, then test them in that exact surface. This repository does not claim universal hosted Voice acceptance.

The skill favors short, speakable status updates while preserving IDs and evidence in written receipts when supported. If the voice surface lacks the connector tools, use an available supported surface; importing the ZIP cannot enable missing host capabilities. OpenLive is a separate integration described in the [main README](../README.md#openlive-voice-integration).

## 6. Routine usage and approvals

Examples once the connection and skill are available:

- "What is the selected session doing, and what was its last finished tool step?"
- "Read the complete original report for the task we just discussed."
- "Show recent completed tasks in this project, keeping other session filters separate."
- "Send this bounded review to the session we selected, then verify that exact receipt."

A clearly authorized task should use one supported submission, followed by exact-task verification. Host confirmation and backend input requests remain separate. Missing responses must not lead to blind non-idempotent resubmission. Use idempotent submission/request lookup only if the connected server actually offers it; the ZIP does not add those capabilities.

## Sources and acceptance status

Setup guidance was checked against official [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [Developer mode](https://developers.openai.com/api/docs/guides/developer-mode), [Skills in ChatGPT](https://help.openai.com/en/articles/20001066-skills-in-chatgpt), [Build skills](https://developers.openai.com/codex/build-skills) and [ChatGPT Voice](https://help.openai.com/en/articles/20001274/) documentation on 2026-09-27. UI labels and availability can evolve.

The repository validates archive membership, relative references, privacy-pattern guards, icon structure, reproducibility and ZIP/checksum consistency. MCP adapter/backend/local-tunnel evidence is recorded in [Delivery A](../PLAN_MCP_READING.md) and [Delivery B](../PLAN_MCP_PROGRESS.md). Installation, host scan outcomes, skill behavior and hosted ChatGPT/Voice acceptance still require testing in the user's actual account/workspace.
