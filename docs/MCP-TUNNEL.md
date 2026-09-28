# Project-based OpenAI MCP tunnel

Since 0.5.62, OpenAI MCP connections are configured **per project**, with reusable tunnel API keys and tunnel IDs in a private host-side register. A configured project starts its tunnel automatically with both `opencode-vm start` and `opencode-vm web`. The MCP tool contract is [MCP-INTERFACE.md](MCP-INTERFACE.md).

## 1. Prerequisites and ChatGPT availability

Create a tunnel in [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) and associate it with the intended ChatGPT workspace. Its ID is `tunnel_` followed by 32 lowercase hexadecimal characters.

Create a restricted **tunnel API key** in [Runtime API keys](https://platform.openai.com/settings/organization/api-keys) with Tunnels **Read + Use**. The principal behind the key must have those permissions for the selected tunnel. A shared key can serve multiple projects/tunnels if authorized by OpenAI; projects in other accounts/workspaces can select a different key. The setup command registers existing values; it does not create OpenAI tunnel objects or need an admin key.

**ChatGPT plan information — research date 2026-09-26:** official sources currently differ. The [Developer Mode guide](https://developers.openai.com/api/docs/guides/developer-mode) lists Plus, Pro, Business, Enterprise and Education with read/write tools. The [Help Center](https://help.openai.com/en/articles/12584461) describes full/write MCP for Business/Enterprise/Edu and read/fetch for Pro. Setup and list output display this dated qualification. Verify actual tool availability in the target account/workspace. A tunnel API key neither establishes the ChatGPT subscription nor bypasses product/workspace restrictions; opencode-vm does not implement a plan-based permission model.

The VM needs outbound HTTPS to `api.openai.com:443` and access to the pinned GitHub release for installation. No public inbound tunnel listener is required.

## 2. Configure from each project directory

Since 0.5.63, entering the command tree without an action opens a terminal menu:

```bash
opencode-vm provider mcp          # choose list, add/new, status, or rm
opencode-vm provider mcp add      # start project setup directly (alias: new)
opencode-vm provider mcp rm       # choose what to remove, then the exact entry
```

OpenAI is the default provider. The guided `status` action offers project selection; the guided `rm` action offers project connections, tunnel API keys, or tunnel IDs, followed by a numbered entry list. Key values remain hidden; creation origins and current references are displayed. Invalid selections in the action/status/removal menus are requested again, `q` cancels, and an empty list is reported without changing anything. A chosen removal uses the same project lifecycle and reference checks as an explicit command; selecting an in-use key/tunnel never cascades into project deletions.

Each invocation performs one selected action and exits. Explicit selectors bypass menus. Without a terminal, bare `provider mcp` and `provider mcp rm` require arguments and fail without changing state. For compatibility, the previously supported noninteractive `provider mcp rm openai` still removes the current project's assignment. In a terminal, `rm` without a selector opens the selection menus, including when `openai` is supplied.

The fully specified setup form also remains available:

```bash
opencode-vm provider mcp new openai
```

The wizard identifies the current project by its canonical absolute directory, then:

1. Lists registered tunnel API keys by stable key ID, creation project and currently referencing projects. Choose a number to reuse one or `n` to enter another key with hidden input.
2. Lists registered tunnel IDs with the same origin/usage information. Choose a number to reuse one, paste a valid `tunnel_…` ID directly to register/select it, or choose `n` for the separate ID prompt and the OpenAI Platform URL. `q` cancels.
3. Saves the project assignment and any new register entries atomically. Invalid input or cancellation preserves the prior configuration.

On first setup, empty registers skip the selection menus and ask directly for the values. Re-entering an identical key reuses the existing key entry. Symlink spellings of the same directory share one project identity. Distinct directories with the same basename remain separate projects; list output includes their full paths and stable project IDs. Moving a project directory requires setup at its new location and removal of the old assignment by project ID.

Setup explicitly warns:

> Reuse a tunnel ID only when one project uses it at a time. For parallel projects, create separate tunnels in OpenAI Platform. Concurrent reuse is not blocked and can route requests to the wrong project.

There is **no tunnel occupancy manager**, cross-project start blocking, scheduling or automatic takeover. The operator manages simultaneous use. Reusing one key with different tunnel IDs is supported, as is registering one tunnel for projects operated sequentially.

`opencode-vm provider new` also offers **MCP connection (OpenAI MCP)**. Both `add` and `new` accept the same setup parameters, with optional `openai`.

### Noninteractive setup

```bash
opencode-vm provider mcp new openai \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --tunnel-api-key env:OPENAI_TUNNEL_API_KEY

# Reuse a key ID shown by list, with another project's own tunnel:
opencode-vm provider mcp new openai \
  --key-id key_012345abcdef \
  --tunnel-id tunnel_11111111111111111111111111111111
```

`--tunnel-api-key` accepts a literal, `env:NAME`, or `file:/absolute/path`. References are resolved during setup and the value is stored privately. `--api-key` remains an alias. Choose either a key value or `--key-id`. Missing input prompts only with a terminal; noninteractive calls fail without all required values.

Run `new` again in a project to change its assignment. Changes apply at its next start/reconnect, not immediately to a running client. Other projects keep their selected entries. A new key does not implicitly rotate every project using the previously selected key.

## 3. Host storage and migration

The single source of truth is:

```text
~/.opencode-vm/mcp-tunnel/openai/registry.json
```

Schema 2 contains `keys`, `tunnels`, and `projects`. Keys store the secret and origin; tunnels store their origin; projects reference a key ID and tunnel ID. `createdIn` remains historical even after its project assignment is removed. Current usage is derived from project references.

The directory is `0700`; the registry containing secrets is `0600`. A short file lock serializes registry edits. Runtime start/stop use only the existing **project lifecycle lock**, not a tunnel-ID or key-usage lock. Only the selected key/tunnel pair is transferred to a project's VM. The full register remains on the host, separate from model-provider `auth.json` and from the project repository.

Legacy 0.5.61 `config.json` is offered as an **unassigned reusable pool** (`key_legacy` plus its tunnel). The old `owner.json`, if present, supplies only an origin label. Startup prints a setup hint while only legacy state exists. Run `new` in each intended project to select these entries. The first successful register edit publishes schema 2 before removing obsolete global activation files. Migration does not silently enable every project; existing live processes use their staged profile until stopped/reconnected.

## 4. Automatic runtime

```bash
opencode-vm start     # terminal UI; configured project also gets MCP + its tunnel
opencode-vm web       # Web UI, local MCP, and this project's configured tunnel
```

For a configured terminal session, an internal `tui-mcp` mode launches one loopback OpenCode `serve` backend and attaches the TUI immediately. MCP talks to that same server and history. It does not open the web/A2A LAN forwards or start those web-only services. Without a project assignment, `start` retains the ordinary standalone TUI.

Local MCP remains enabled by default in web mode, even without a tunnel assignment. New MCP-enabled sessions reserve a free loopback port from `40960..41059`; `web --mcp-port PORT` selects a fixed one. Reconnect retains the port/token and re-evaluates the project assignment. `attach` keeps the saved UI mode; explicit `start` selects the terminal UI, and `web` selects web mode.

Suppress MCP and its tunnel for **this invocation only**:

```bash
opencode-vm start --no-mcp
opencode-vm web --reconnect --no-mcp
```

The next normal start/reconnect enables the configured connection again. Suppression does not erase project assignments or reusable entries.

### Recovery from a pre-0.5.64 port-lock timeout

Versions 0.5.61–0.5.63 can leave the short MCP port-allocation lock behind under macOS Bash 3.2. The shell discards the helper's local variables before its EXIT trap runs. Subsequent starts can time out at `mcp-connector/ports/.locks/5bdb347e8420bfe74dc815a17bfca37d.lock`, even while the original controller is still alive. Version 0.5.64 keeps cleanup state at subshell scope and fixes the leak.

If this lock is already stranded, first ensure no other project start or reconnect is currently in progress. Existing idle/running sessions can remain running. Remove only this allocation-lock symlink once on the Mac, then retry using 0.5.64 or the corrected source checkout:

```bash
lock="$HOME/.opencode-vm/mcp-connector/ports/.locks/5bdb347e8420bfe74dc815a17bfca37d.lock"
if [ -L "$lock" ]; then unlink "$lock"; fi
opencode-vm web --port 5555
```

The lock is not a tunnel assignment or API credential. A Lima `use of closed network connection` message during a successfully completed VM shutdown is separate from this lock timeout.

### Service lifecycle

After authenticated MCP readiness, the host resolves this project's pair, verifies the current runtime generation, and installs **tunnel-client v0.0.15** on demand in the session VM using pinned Linux ARM64/AMD64 release checksums. It starts the transient `ocvm-mcp-tunnel.service` as the guest user under the sandbox profile. Different project VMs start independently, including when the operator has deliberately assigned the same tunnel ID.

The generated `<session-share>/mcp/tunnel.yaml` is JSON-compatible YAML. It references the private `tunnel-key` file and injects `X-OCVM-MCP-Token` through both `mcp.extra_headers` and `mcp.discovery_extra_headers`, using `file:` references. The upstream is the actual guest MCP loopback port. Health uses a guest Unix socket; the optional Cloudflare companion is not used.

Reconnect stops the old tunnel before its adapter and reloads the current pair and MCP token. The transient service is not independently enabled at VM boot. Failure to install/connect a tunnel is reported without stopping the local terminal/web/MCP runtime. The client retries temporary network failures; systemd restarts failed processes. Installation failures are retried on the next start/reconnect.

## 5. List, status, and removal

```bash
opencode-vm provider mcp list             # all assignments and reusable entries
opencode-vm provider mcp list openai      # same view, explicit provider
opencode-vm provider list                 # also includes the MCP register overview
opencode-vm provider mcp status openai    # current project plus live runtime state
opencode-vm provider mcp status openai --project <project-id>
opencode-vm doctor
```

`list` is a stored-configuration overview, not a claim that every connection is live. `status` queries only the selected project's tracked VM and shows process state, startup readiness, polling connectivity, and HTTP failures where available. The configured and runtime tunnel IDs are displayed separately. Keys are never printed. Logs are at `<session-share>/mcp/tunnel.log` (`0600`); the server-backed terminal backend also logs to `mcp/backend.log`.

```bash
opencode-vm provider mcp rm                                # interactive type + entry selection
opencode-vm provider mcp rm openai --project "$PWD"         # current project assignment, directly
opencode-vm provider mcp rm openai --project <project-id>   # another recorded project
opencode-vm provider mcp rm openai --key-id <key-id>         # unused registered key
opencode-vm provider mcp rm openai --tunnel-id <tunnel-id>   # unused registered tunnel
```

Project removal stops only that project's managed tunnel, removes its staged key/profile and its assignment, and **retains the reusable key/tunnel entries**. Other project VMs continue running. If shutdown cannot be verified, the assignment is retained for recovery. Key/tunnel deletion refuses entries still referenced by projects and lists those projects; it does not cascade. Removing local entries does not revoke OpenAI-issued keys or delete OpenAI tunnel objects or ChatGPT apps.

## 6. ChatGPT setup and acceptance

In [ChatGPT Plugins](https://chatgpt.com/plugins), add a developer-mode connection, name it for the project, select **Tunnel**, and choose that project's tunnel ID. For sequential projects sharing one tunnel, a shared app can be used; the app name does not control routing. Keep the selected project running during discovery and calls.

The optional [OpenCode Session Orchestrator skill ZIP](https://github.com/GeektankLabs/opencode-vm/raw/refs/heads/main/integrations/chatgpt/opencode-session-orchestrator.zip) adds client-side workflow guidance. It is installed separately through the Skills UI and contains no connection credentials. See [CHATGPT.md](CHATGPT.md) for setup, skill installation, read-only smoke testing and the distinction between text/dictation and product-specific Voice capabilities. The skill is not a public MCP plugin submission and does not change workspace permissions.

Verify all sixteen core tools, inspect the expected project/session IDs, and call `create_session` with an optional title to create an empty work session. Query `get_session_runtime_options` and test an idle `update_session_runtime`. Submit harmless unique prompts to two sessions with `send_message`, then use one `get_project_activity` cursor to collect their completion events (or `wait_for_project_activity` for a short active wait). Compare correlated status/history with the same sessions in TUI/Web UI. Use `get_task_result`, `get_message` and `read_message_content` to retrieve a long synthetic original completely, including a fact from its end; check byte/hash reconstruction programmatically and text/ID/cursor visibility in ChatGPT separately. Check `get_session_progress` during a harmless tool operation and test a journal `tail:true` read followed by ordinary continuation, keeping cursors separate per `filter_key`. Test attachment upload with synthetic PNG and Markdown bytes, then submit both returned references in one `send_message`; verify the backend stores a file part, the text is present, and the provider receives an image input. Also verify an unsupported model rejects an image before admission and that unknown/path references fail with their documented codes. Confirm the target client can pass bytes to `upload_attachment` within its tool-input size limit; a conversation-only local file reference is insufficient. With explicit authorization, archive an idle completed test session and verify normal exclusion and by-ID `include_archived:true` content reading. Record the actual revision and component versions; follow [Delivery A acceptance](../PLAN_MCP_READING.md) and [Delivery B acceptance](../PLAN_MCP_PROGRESS.md). Resolve input requirements in the first-party UI and never automatically replay uncertain submissions, creations, archives or runtime changes. Repeat after adapter restart: activity cursors persist, whereas content/search references must be reacquired using stable IDs. Test Voice independently, including any on-screen approvals; text success does not prove Voice support.

The original sixteen-tool checklist above describes adapter 0.1.9. Current adapter 0.1.11 exposes seventeen core tools, including `supersede_unresolved_submission`. Verify that the connected catalog actually lists it after refresh. Its live write test requires a disposable runtime and fresh approval for the exact test guard; local regression fixtures cover guard conflict, audit and request replay. Do not use a real project's unresolved receipt as an acceptance fixture.

`create_session` is available from adapter 0.1.1 / opencode-vm 0.5.65. Reconnect after updating and refresh the ChatGPT app's tool catalog (or republish/recreate the app where required) so its saved tool list includes the new write-capable action.

Local coverage includes registry concurrency and migration, hidden-input/reuse/cancellation dialogs, same-tunnel parallel startup without occupancy blocking, per-project removal, port reservations, and fresh/reconnected server-backed TUI lifecycle with final auth capture. Real v0.0.15 local-control-plane tests exercise all ten tools and Linux/systemd installation, readiness, failure diagnostics, logs and cleanup. Adapter 0.1.2 / script 0.5.66 adds runtime options/updates and persistent activity; its collection bounds and follow-ups are documented in [PLAN_MCP_ACTIVITY.md](../PLAN_MCP_ACTIVITY.md).

Delivery A (adapter 0.1.3 / script 0.5.67) extends local-control-plane coverage to thirteen tools and hash-verified reconstruction of a 290,017-byte original. The SDK client offered/negotiated 2025-11-25 on this local tunnel path. This does not establish the revision or model-context behavior of a hosted ChatGPT connection. The scoped compatibility record is [PLAN_MCP_READING.md](../PLAN_MCP_READING.md).

Delivery B (adapter 0.1.4 / script 0.5.68) adds local-control-plane coverage for the fourteenth tool, metadata-only progress, and journal tail-to-forward continuation. It preserves the established 2025-11-25 transport and opens no new event subscriptions. See [PLAN_MCP_PROGRESS.md](../PLAN_MCP_PROGRESS.md).

PTY dialog tests also cover the action menu, add alias, selected-project status, all three removal types, exact entry selection, referenced-entry refusal, invalid input, cancellation/EOF, empty lists, and noninteractive compatibility.

`tests/mcp_lock_test.sh` verifies release of short port/project locks on success, failure and explicit exit, parent-lock isolation, and dead-owner recovery. Run it with macOS `/bin/bash` as well as a current Bash; CI gates publication on the native macOS check.

Optional real-client checks, after building `adapters/mcp`:

```bash
OCVM_TUNNEL_CLIENT=/absolute/path/to/tunnel-client \
  node tests/mcp_tunnel_protocol_test.mjs

# Linux/systemd and sudo; uses a separate fixture unit/socket namespace:
OCVM_TUNNEL_CLIENT=/absolute/path/to/tunnel-client \
OCVM_TUNNEL_ARCHIVE=/absolute/path/to/pinned-linux-release.zip \
  node tests/mcp_tunnel_protocol_test.mjs
```

Real macOS/Lima multi-project start/reconnect behavior and hosted OpenAI/ChatGPT/Voice acceptance still require the target host/account. Local tests do not establish product acceptance.
