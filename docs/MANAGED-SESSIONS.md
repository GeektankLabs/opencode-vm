# Agent-managed work sessions

**Backend admission and task-scoped work**

An actual agentic work admission adopts a session server-side. Clients use normal
tools; no managed flag or repeated initialization prompt is required. Creation
of a work session through MCP/OpenLive/A2A is work admission too. A continuation
of an existing manual session adopts it before work starts. Adoption is sticky
across UI inspection, agent/model changes, reconnect and runtime restart.

Reads, upload staging, rename/archive/runtime management, Board management and
plain OpenLive call attachment do not reclassify a manual session. The OpenLive
manager remains a separate read-only session. A2A also covers its actual
prompt_async and command work paths; its disabled shell/workspace mutations are
not enabled by this feature.

## Work behavior

The injected managed prompt contains task-scope and business-decision handback
instructions, without Git-specific rules. The shared Bash-description rewrite
removes the upstream Git confirmation sentence without replacement, including
the former manual-session clause. Executable permissions remain unchanged.

- Ordinary local development includes status/diff/log, staging/restore, branches,
  appropriate local tags and local commits without another confirmation.
- Explicit task, read-only/review and agent/session restrictions still apply.
  Model-role recommendations do not authorize implementation of Review findings.
- Native end-user Questions are suppressed. Missing business decisions end with
  a normal terminal `INPUT_REQUIRED` report: concrete question, context, options,
  completed and paused work. The orchestrator resolves it in Chat/Voice and sends
  a normal follow-up to the same idle session.
- Real independent security permissions remain separate pending operator input;
  the feature does not approve/reply to them or reinterpret them as business text.
- `external_directory` (OpenCode's tool permission for paths outside the
  workspace) is handled noninteractively since 0.7.36: adoption no longer copies
  OpenCode's default interactive `external_directory "*": "ask"` or the generic
  blanket `"*": "allow"` into the session rule set. Blanket-allow projects
  therefore behave exactly as their configuration says for roots and native
  children (the previous copy made children inherit the interactive ask while
  dropping the parent's generic allow — the hidden-endless-wait incidents on
  OpenCode 1.19.0). In restrictive projects an unauthorized external ask in a
  managed session (root, new/reused child) is auto-rejected with corrective
  feedback — mirroring `opencode run`'s noninteractive precedent — and the turn
  ends with a stored terminal `INPUT_REQUIRED` permission blocker instead of
  waiting forever on a UI approval. Explicit deny rules always win. An
  operator-authorized directory scope can be declared per adoption
  (`scope_dirs` on the plugin's `/adopt`; inherited by native children); it
  installs narrow `external_directory <dir>/* allow` session rules unless an
  explicit deny matches. The declaration is carried by the real ingress paths:
  the MCP tools `create_session`/`send_message` accept an explicit
  `scope_dirs` parameter (validated fail-fast, forwarded over the admission
  socket, atomic union — never truncated), and the A2A/OpenLive launchers read
  an operator-side `OCVM_A2A_SCOPE_DIRS`/`OCVM_OPENLIVE_SCOPE_DIRS`
  environment declaration (path-separated). Scope is never derived from prompt
  text; reads and pure management never adopt or extend a scope. A missed
  `permission.asked` event or a transient lineage-check API error is covered
  two ways: a bounded pending-list reconciliation sweep on every
  (re)subscribe, plus one bounded delayed re-check (max 3 per ask, 1.5 s
  apart) scheduled when the intact event path hits such an error — an intact
  stream never reconnects on its own, so the re-check is what closes that
  window. The sweep processes managed-lineage asks first (fairness), is
  bounded at 64 per pass, and leaves manual sessions' asks untouched. If the
  lineage stays unverifiable after the bounded attempts, the ask remains
  honestly pending (never auto-allowed, never rejected without verified
  lineage). Manual sessions keep the native interactive ask;
  nothing approves or bypasses a real permission, and host/mount/remote-write
  boundaries are untouched.

## Implementation and lifecycle

`runtime/managed-policy.mjs` is an owned OpenCode plugin. Private Unix admission
is used by the three backend ingress adapters. State lives in the OpenCode XDG
data store, separately from mutable native session metadata, and is synced with
the existing project history. Native policy writes are idempotent; explicit tool
disables are preserved without allowing V1's tools replacement to erase policy.
New and reused Managed-workstream children are prepared synchronously before
their work prompt, including previously manual child lineage. Enabled background
continuations retain the same state. Entries persisted by plugin versions
before the `scopeDirs` field existed are lazily normalized, per queried session
only, to an empty scope at adoption/prepare: the field is added only when it is
genuinely absent on a strictly validated same-revision entry, all stored rules,
denies, disables and `adoptedAt` stay verbatim, no external access is granted,
and the migrated entry is persisted atomically even when the policy delta is
empty. Present-but-invalid field values still fail closed.

The completion gate correlates the actual model request with its stored user
turn. It checks one bounded provider step before SDK tool dispatch. A Question
tool response becomes an ordinary terminal text response consumed, persisted and
completed by the real OpenCode runner. This does not abort a session, edit DB
finish fields, answer Questions, insert a fake user turn or depend on the model
obeying a tool exception. Chat Completions, Responses, Anthropic Messages and
Google JSON/SSE protocols are supported; incompatible transports fail closed.
Managed model steps are buffered up to 8 MiB, so text appears after the provider
step finishes rather than token-by-token. Manual model traffic is untouched.

Fresh and Attach install the same payload without globally adopting sessions.
Source checkouts use `runtime/`; standalone embeds the exact deterministic runtime
payload, with a source/parity check and no new manual/offline download dependency.
The MCP package also includes those runtime sources. A2A uses the owned
`a2a-managed.py` launcher with process-local hooks, not a persistent site patch.
This is not a new independent policy daemon. An unavailable/incompatible policy
refuses work; reads and management remain available.

Existing sessions started with an older script keep their loaded configuration
until a normal stop/attach/restart. Updating source files alone does not activate
the policy in an already running OpenCode instance.

## Boundary and evidence

Executable permission rules and tool/direct-shell guards still deny recognized
push, send-pack/http-push/receive-pack, LFS publishing and publishing wrappers or
aliases without an approval prompt. Otherwise permitted fetch/ls-remote reads
remain possible. These are technical controls, not injected prompt instructions.

The primary boundary is the established VM design: no GitHub/origin credentials
or configured writable operator origin in the guest; operator credentials and
project/origin control remain host-side. The plugin is additional behavioral
policy/defense-in-depth, not an arbitrary-process/network sandbox. No credential
or GitHub-login provisioning, general read-only broker or blanket network denial
is added. Native permission/alias/script canaries alone neither prove nor disprove
the host/guest credential-origin contract; real macOS/Lima/operator acceptance is
reported separately from local disposable regression evidence.

Maintained gates: `tests/managed_policy_test.mjs`, `tests/managed_a2a_test.py`,
`tests/managed_policy_integration.py`, `tests/managed_legacy_migration_test.py`,
`tests/managed_ingress_integration.py`,
MCP/OpenLive package suites and lifecycle/standalone checks. Historical V1 spike
evidence remains under `tests/agent-managed-v1-spike/`; its old external-G3 model
selection interpretation is superseded by this task's canonical operator plan.

## Known pre-existing limitation: legacy adopted sessions (documented, no migration)

`policyDelta` writes are append-only. Sessions adopted by a plugin from before
the F0 correction (0.7.36) keep the previously copied OpenCode default rules —
including the copied generic `"*": "allow"` and the default external ask — in
front of the newly desired tail on reuse/attach/re-adopt. The external-directory
watcher protects the external ask path in those sessions regardless of the
stale rules, but other agent-level asks (e.g. doom_loop, `.env` reads) can
remain silently overridden by the stale copied blanket allow in exactly those
cross-version-reused sessions. This is a pre-existing residual, not a
regression of the current change, and no cleanup is performed automatically:
re-adopt/attach does not remove previously written session rules or foreign
plugin references. A dedicated later migration (stripping previously copied
default rules on re-adopt) is recorded as separate follow-up work.
