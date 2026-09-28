# Agent Control Hub — v1 decision and delivery contract

Status: v1 implemented in the working tree; local fixture/package/browser verification completed. Real macOS/NetBird and hosted skill behavior acceptance remain separate. This plan concerns project preferences, not OpenCode core or provider credentials.

## Decisions

- Profiles `deep`, `standard`, `execution` are transport-neutral project preferences. The first capable external-agent transport is MCP; A2A and OpenLive report `unsupported` for profile reads rather than hiding the preferences.
- The Hub is available on trusted local/private networks, including private overlays. Requests from public peers are rejected. The existing LAN exposure model remains in place; a stronger authenticated proxy is a separate project.
- On a **new authorized work item**, a capable orchestrator classifies a semantic profile, resolves the exact configured provider/model/variant, checks that the target session is idle with no pending input, and applies the runtime before sending. It discloses the profile and runtime concisely. Explicit user choices prevail; existing status/result reads never switch runtimes. There is no silent replacement of a missing model.
- `.opencode-vm/agent-control.json` is project-local, versioned, and contains only portable preferences. It is ignored by default but may be deliberately included by the repository operator using a targeted Git force-add or a narrow ignore exception. No secret, absolute path or machine-specific catalog belongs in it.
- Usage/Quotas is **not part of v1**, including placeholders and adapter scaffolding. Revisit only if OpenCode/OpenAI documents a supported account-usage interface for the desired live allowance.

## v1 boundary

The existing Hub owns policy writes, serialized with a project-local host lock and atomic replacement; the MCP adapter reads the same file through the mounted project. A missing file returns three unconfigured profiles without writing anything. The running OpenCode model catalog comes from the existing `get_session_runtime_options` MCP read, which itself uses OpenCode's public SDK. A truncated/unavailable catalog cannot prove that a stored mapping is missing. The Hub never stores catalog snapshots in project state. OpenCode's existing `update_session_runtime` remains the only MCP session-setting write.

Schema: `{schemaVersion:1, revision:N, updatedAt:ISO8601, profiles:{deep,standard,execution}}`; each profile is `null` or an exact `{provider_id,model_id,variant}` tuple. Missing file is virtual revision 0. Newer/invalid schemas are never overwritten. A write supplies expected revision, validates against a complete fresh catalog, locks, rereads, writes a mode-0600 temporary file, fsyncs and atomically replaces it; a stale revision returns conflict. Future format changes require an explicit backed-up migration.

MCP reads: `get_project_model_policy({})` returns the policy with per-profile validation and catalog coverage; `get_recommended_runtime({profile})` returns an exact runtime only for a configured, currently listed tuple, otherwise an explicit unconfigured/unavailable/unknown result. Both are read-only and project-scoped. MCP absence leaves Hub catalog validation unknown while policy remains visible; `web --no-mcp` is an explicit degraded capability in v1.

Acceptance: missing/valid/future policy, atomic/concurrent writes, invalid provider/model/variant, truncated/offline catalog, private-network binding, capability states, skill precedence and idle/busy/pending handling, current launcher/editor regressions, skill bundle/checksum consistency. No live usage inference, provider auth parsing, new connection management or OpenCode core modifications.
