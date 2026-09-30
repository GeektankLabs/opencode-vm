# Agent-managed V1 compatibility / enforcement spike

**Historical characterization only.** These prototype modules are not installed,
packaged or imported by production or maintained regressions. The maintained
implementation is `runtime/managed-{core,policy}.mjs`; durable fixtures/scenarios
are in `tests/helpers/managed_runtime.py`, `tests/managed_*` and the MCP/OpenLive
suites. The canonical operator plan §17 supersedes this document's original G3/
external-capability-mediation interpretation. Preserve the historical failures as
evidence, not as desired behavior or an untracked implementation dependency.

Task-ID: `task_25b3af4f-e97f-5707-b523-13bcc99ed03c`

**Isolated experimental path, not installed product policy.** It demonstrates
OpenCode **1.18.33 V1** behavior and intentionally proves the remaining escapes.
There is no complete remote-write security guarantee here.

## Reproduce

Requirements: `opencode` **1.18.33**, Node, npm, Python 3, Git, curl and Bash.
Run from the repository:

```sh
python3 -B tests/agent-managed-v1-spike/probe.py
node --check tests/agent-managed-v1-spike/policy.mjs
node --check tests/agent-managed-v1-spike/plugin.mjs
```

The runner refuses a different OpenCode version. npm installs the real pinned
`@opencode-ai/plugin@1.18.33` into the disposable config before bootstrap,
avoiding a wait on V1's background installer in this sandbox. The experimental
plugin has no external imports.

Everything mutable lives in a new `/tmp/opencode/managed-v1-*` directory:

- fresh HOME/all XDG locations, environment whitelist, no provider credentials;
- explicitly configured loopback deterministic OpenAI-compatible model;
- owned loopback OpenCode server, terminated/restarted by the runner;
- Git stub that delegates local operations but **never delegates publishing**;
- local bare clone for actual `ls-remote`/`fetch`, before/after ref comparison;
- local HTTP sink for a harmless generic-write capability canary.

No remote URL is configured in the disposable work repository. No actual push,
send-pack, release or tag is performed, including during Always-Allow probes.
Synthetic approvals/rejections affect this runtime exclusively. The real project
and session are not test fixtures. Default plugins/external skills are disabled.

The printed evidence directory contains `report.json` (completed status and
assertions), `audit.jsonl` (event/tool metadata), `model-requests.json` (only
synthetic-fixture instruction provenance), `runtime-schema.json`, runtime logs
and `git-canary.jsonl`. These expire with the VM. The durable findings and
acceptance mapping are in [EVIDENCE.md](EVIDENCE.md).

## Prototype

- `policy.mjs`: compact primer, conditional shell commit sentence, native session
  rule composition preserving existing **session** Denies, deliberately limited
  direct Git-write recognizer.
- `plugin.mjs`: actual shell `tool.definition` adjustment, session-aware system
  primer, parent-lineage lookup, approval-independent `tool.execute.before`
  denial for native Questions/recognized direct writes.
- `probe.py`: actual V1 APIs/native model-driven tools, native `task` creation
  and reuse, real disposable commits, positive and negative controls.

Only the runner installs the plugin into its fresh config. No production
adapter, lifecycle, AGENTS, skill, wire, bundle or release file is modified.

## Limits deliberately demonstrated

1. V1 remembered Allows beat native Denies across sessions of one instance.
2. Executor errors suppress Questions but do not force terminal handback;
   the deterministic model supplies the final `INPUT_REQUIRED` text.
3. Native PATCH permission appends; prompt `tools` replaces the ruleset;
   PATCH metadata replaces the entire map.
4. New children inherit Denies, not local Allows/metadata. Reused/manual-lineage
   children need explicit adoption and preparation.
5. Session Allows override explicit agent Denies. This prototype composes
   session rules only; effective agent scope still needs reconciliation.
6. Mutable metadata is not protected sticky authority.
7. REST shell, indirect scripts and generic HTTP bypass this guard. Helpers,
   aliases, hooks, Docker, custom/MCP tools and foreign-repo writes remain open.

Read-only local-fixture behavior is preserved. The existing user-origin
restriction is neither changed nor probed. Complete operator-controlled
capability mediation remains a coordinated integration gate, not a regex task.
