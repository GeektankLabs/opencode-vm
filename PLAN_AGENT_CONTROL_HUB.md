# Agent Control Hub — decision and delivery contract

Status: v1 plus ACH-1 integrated onto the consolidated r21 + Header baseline. Real macOS/Safari/VoiceOver/NetBird and hosted skill behavior acceptance remain separate. This plan concerns project preferences, not OpenCode core or provider credentials. ACH-1 canonical requirements/design/test plan: `planning/task-concepts/task_4bae0002-9e0e-5722-b287-a5b4338c1ba3-concept-plan.md`.

## Decisions

- Profiles `deep`, `standard`, `execution`, optional `design` and `review` are transport-neutral preferences. Design → Standard; Review → Deep → Standard, skipping only null and stopping at configured unavailable/incomplete mappings. Independent Review does not automatically implement findings. MCP is the first capable transport; A2A/OpenLive remain unsupported.
- The Hub is available on trusted local/private networks, including private overlays. Requests from public peers are rejected. The existing LAN exposure model remains in place; a stronger authenticated proxy is a separate project.
- On a **new authorized work item**, a capable orchestrator classifies a semantic profile, resolves the exact configured provider/model/variant, checks that the target session is idle with no pending input, and applies the runtime before sending. It discloses the profile and runtime concisely. Explicit user choices prevail; existing status/result reads never switch runtimes. There is no silent replacement of a missing model.
- `.opencode-vm/agent-control.json` is project-local, versioned, and contains only portable preferences. It is ignored by default but may be deliberately included by the repository operator using a targeted Git force-add or a narrow ignore exception. No secret, absolute path or machine-specific catalog belongs in it.
- Usage/Quotas is **not part of v1**, including placeholders and adapter scaffolding. Revisit only if OpenCode/OpenAI documents a supported account-usage interface for the desired live allowance.

## v1 boundary

The existing Hub owns policy writes, serialized with a project-local host lock and atomic replacement; MCP reads the mounted file. Missing file returns five normalized unconfigured profiles without writing. Catalog comes from existing MCP runtime options; truncated/unavailable is not missing evidence. No stored catalog or new runtime write. UI follows Profiles → Connections → Logs, preserves drafts/focus, serializes browserwrites and reconciles conflicts/lost responses explicitly.

Dualreader: schema 1 exactly three keys, schema 2 exactly five; both normalize five roles. Base writes stay schema 1. First explicit optional mapping verifies the active adapter tool contract and publishes exact-original private backup before atomic schema-2 replacement under lock, increasing revision once. Failed/differing backup prevents replacement; interrupted identical backup replay is safe. Clearing never downgrades. Invalid/future remain untouched. See `hub/README.md` for migration/recovery/rollback contracts.

MCP reads: `get_project_model_policy({})` returns the policy with per-profile validation and catalog coverage; `get_recommended_runtime({profile})` returns an exact runtime only for a configured, currently listed tuple, otherwise an explicit unconfigured/unavailable/unknown result. Both are read-only and project-scoped. MCP absence leaves Hub catalog validation unknown while policy remains visible; `web --no-mcp` is an explicit degraded capability in v1.

Acceptance additionally covers shared Python/TS fallback vectors, Schema-1/2 compatibility, active-vs-old adapter discovery, backup/interrupted migration, four honest Connectionstates, draft/focus preservation, conflict and uncertain-save browserflows, keyboard/reflow/contrast, launcher and reproducible packages. Marker/TCP/PID never prove Ready; authenticated project/generation MCP health is independent of catalog. Mac/operator acceptance and external live checks remain separately required; no live usage inference, new connection management or OpenCode core changes.
