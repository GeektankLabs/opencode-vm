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

## Implementation and lifecycle

`runtime/managed-policy.mjs` is an owned OpenCode plugin. Private Unix admission
is used by the three backend ingress adapters. State lives in the OpenCode XDG
data store, separately from mutable native session metadata, and is synced with
the existing project history. Native policy writes are idempotent; explicit tool
disables are preserved without allowing V1's tools replacement to erase policy.
New and reused Managed-workstream children are prepared synchronously before
their work prompt, including previously manual child lineage. Enabled background
continuations retain the same state.

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
`tests/managed_policy_integration.py`, `tests/managed_ingress_integration.py`,
MCP/OpenLive package suites and lifecycle/standalone checks. Historical V1 spike
evidence remains under `tests/agent-managed-v1-spike/`; its old external-G3 model
selection interpretation is superseded by this task's canonical operator plan.
