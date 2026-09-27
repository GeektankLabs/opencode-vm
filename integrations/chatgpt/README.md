# ChatGPT companion skill

<img src="opencode-session-orchestrator/assets/icon.svg" alt="OpenCode VM skill icon" width="96" height="96">

**[Download the installable ZIP](https://github.com/GeektankLabs/opencode-vm/raw/refs/heads/main/integrations/chatgpt/opencode-session-orchestrator.zip)** · [SHA-256](opencode-session-orchestrator.zip.sha256) · [Source](opencode-session-orchestrator/) · [Setup and installation](../../docs/CHATGPT.md)

`opencode-session-orchestrator` is an optional **ChatGPT-side** workflow package. It helps a coordinating assistant use an already configured compatible OpenCode MCP connection: delegate authorized work, handle approvals accurately, observe tool progress and retrieve complete stored results. Connection labels and tunnel IDs are supplied by the user at setup, never embedded in the skill.

This directory is separate from the repository's VM-side `skills/registry.json`. The ZIP is a standalone skill, not an MCP server, model provider, published OpenAI plugin or automatic permission configuration. Its installation does not enable MCP in a product surface that lacks those tools.

## Source inventory

[`bundle.json`](bundle.json) is the machine-readable inventory and skill revision. Only its explicitly listed files, plus the repository [MIT license](../../LICENSE), enter the ZIP.

| Maintained file | Purpose |
|---|---|
| `opencode-session-orchestrator/SKILL.md` | Entry point, discovery, state/coverage, task and attention workflows |
| `opencode-session-orchestrator/CHANGELOG.md` | Independent skill revision history |
| `opencode-session-orchestrator/agents/openai.yaml` | Display/icon metadata and implicit invocation policy; no fixed MCP dependency |
| `opencode-session-orchestrator/assets/icon.svg` | Canonical OpenCode VM terminal/enclosure icon |
| `opencode-session-orchestrator/references/content-protocol.md` | Full original reads, revisions, completeness and cursor handling |
| `opencode-session-orchestrator/references/clarification-sessions.md` | Bounded clarification offers, runtime, origin handoff, closure and optional archive |
| `opencode-session-orchestrator/references/progress-activity.md` | Delivery B observations, tail entry, filter-specific progress and gaps |
| `opencode-session-orchestrator/references/approval-flow.md` | Authorization, host approval, acceptance and backend boundaries |
| `opencode-session-orchestrator/references/approval-sources.md` | Dated public documentation and evidence limits |
| `opencode-session-orchestrator/references/decision-preparation.md` | Decision-ready research and authorized concept/planning work |
| `opencode-session-orchestrator/references/regression-scenarios.md` | Synthetic behavior-review and optional smoke-test cases |
| Repository `LICENSE` | Copied as `opencode-session-orchestrator/LICENSE` when packaging |

The initial import is based on the user-supplied r3 instruction bundle. Revision r4 incorporates Delivery B, precise response-local completeness/search restart semantics, capability-based multi-connector selection and the new icon. Revision r5 clarifies the MCP admission errors `SESSION_BUSY`, `SUBMISSION_UNRESOLVED` and `SUBMISSION_UNCERTAIN`. Revision r6 adds bounded clarification sessions, origin handoff, optional archival and programmer handover for improvement requests. Revision r7 distinguishes the write-capable `send_message` connector call from the independently read-only scope of a newly submitted task. Package content has been reviewed for fixed private identifiers and credentials. Automated pattern checks are additional guards, not a substitute for reviewing future edits.

## Artifact and reproducible build

Run from the repository root with **Python 3.9+**, using only its standard library:

```bash
python3 scripts/build-chatgpt-skill.py
python3 scripts/build-chatgpt-skill.py --check
python3 -B tests/chatgpt_skill_test.py
```

The builder creates:

- [`opencode-session-orchestrator.zip`](opencode-session-orchestrator.zip) — one top-level `opencode-session-orchestrator/` directory containing the inventoried source files and `LICENSE`.
- [`opencode-session-orchestrator.zip.sha256`](opencode-session-orchestrator.zip.sha256) — checksum of the exact archive bytes.

An alternate output is supported for comparing builds:

```bash
python3 scripts/build-chatgpt-skill.py /tmp/opencode-session-orchestrator.zip
cmp integrations/chatgpt/opencode-session-orchestrator.zip /tmp/opencode-session-orchestrator.zip
```

The small text/vector package deliberately uses uncompressed ZIP entries (`ZIP_STORED`) to avoid compressor-version differences. Entry order, timestamps (1980-01-01), regular-file permissions and UTF-8/LF encoding are fixed. No filesystem usernames, extra fields, archive comments, screenshots, upload indexes, `.DS_Store` or `__MACOSX` content are included. Symlinks, unexpected source files, unsafe paths, broken relative links, common credential/private-ID patterns and active/external SVG content fail validation.

`--check` is read-only and fails if the inventory, sources, ZIP or checksum disagree. CI runs it and the packaging regression tests on changes to this package/builder. Packaging validation does **not** prove that ChatGPT installed the skill, honored instructions, exposed tools in Voice or suppressed any approval dialogs.

## Maintaining a revision

1. Edit the maintained source files, not the ZIP. Add/remove entries in `bundle.json` intentionally when changing the file inventory.
2. Advance the skill revision in `bundle.json`, the `SKILL.md` release marker and `CHANGELOG.md`. Preserve the skill name for upgrades.
3. Review genericity and privacy: no actual tunnel/account/project/session IDs, private URLs, secrets or fixed connector aliases. Keep future capabilities conditional on discovery.
4. Rebuild and run the checks above. Review relevant behavioral scenarios; carry out live tests only in an authorized test scope.
5. Commit the sources, inventory, ZIP and checksum together through the normal host workflow. The main-branch download link serves the new package after that commit is pushed.
6. Update/replace the installed skill through the target product's Skills UI and verify its release marker. Repository changes do not update a user's installed copy automatically.

Skill revisions are independent of opencode-vm/MCP adapter versions. This artifact is served directly from the repository; it does not require changing the runtime script or publishing a new adapter release.
