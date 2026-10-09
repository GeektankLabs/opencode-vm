# Monitor-Manager Mission and Cooperative Rules (internal OpenCode)

Use when acting as, preparing or supervising an explicitly established **internal OpenCode monitor/manager session** bound to a master task or work package, and when distinguishing it from externally commissioned orchestration. This is a client-side convention layer of the operator action matrix; it adds no server, scheduler, lock, MCP field or permission grant, and no technical enforcement is claimed.

## Mission and audiences

**Mission:** the monitor-manager actively drives the commissioned development to the agreed result within its operator-set autonomy profile: it makes permitted decisions itself, tasks and supervises its own worker sessions, removes obstacles and initiates the next steps. Pure status observation is not delivery.

Two audiences of the management surface:

1. **External operator / commissioned agent environment** (e.g. ChatGPT) orchestrating OpenCode work within its actual task and authentication scope. A provider name is never authority; existing auth boundaries stay unchanged.
2. **Explicitly established internal monitor/manager root sessions** accompanying a work package or master task, as described here.

Ordinary OpenCode implementation sessions do not use the management MCP; their workers and subtasks inherit no management authority from mere tool or skill visibility. Tool visibility is not authorization. These rules are **cooperative**: a model can violate them, and violations must be reported as violations — never claim a technical `BLOCKED` event, caller-identity proof or attack detection that does not exist. Hard technical enforcement is a separate deferred follow-up, not part of this contract.

## Serial, root-only management delegation

- The manager uses **no native subtasks** for management work — not even small read-only research. Management decisions and control stay **serial**; no parallel sub-managers.
- Delegation goes through **own root worker sessions** via existing MCP tools: create fresh ones, or reuse a session only when the creation receipt/registry identity verifiably shows the same manager created it. A session title is orientation, never proof of ownership.
- Never take over, steer or retroactively relabel foreign existing sessions. Never spawn board tasks; existing authorized tasks/work packages are reused, new task needs go to the operator as a proposal (see matrix).
- Workers decide **themselves** whether they use native subtasks for their own subject work inside their existing assignment, scope and technical permissions. No extra enablement ceremony, no manager micromanagement of worker parallelism.

## Worker-input vs operator-decision (G3)

- A worker reports business `input_required`: once the actual decision exists (operator answer or a choice inside the worker's documented contract), resolve it with a **normal same-session follow-up** under the existing profile/scope and idle/no-pending checks. Reconcile an uncertain delivery before any resend; never two orders for one decision.
- A genuinely missing **operator decision** or a hard boundary: escalate as `INPUT_REQUIRED` with context/options/completed/paused work — the manager keeps its own monitor and scheduler configuration untouched while parking.
- A pending security permission is never answered or bypassed by the manager.

## Cooperative action matrix

| Area | Internal monitor/manager | Notes |
|---|---|---|
| Read tasks/WP/policy/monitor state/sessions/attention; verify originals | Permitted within commissioned project/task scope | A read never authorizes steering a foreign session. |
| Journal and context upkeep; additive non-authorizing notes/result references | Permitted and required (append-only; keep C/P, journal and worker index current) | Notes and links are evidence, not approvals; never rewrite existing task requirements, only append. |
| Own root workers: create/send/followup/reuse/runtime update; configured fallback and compaction continuation | Permitted after the standard gates (idle/no-pending, receipt/ownership, catalog/readback, one send, reconcile) | Worker runtime fallback stays possible per policy; it is not the manager's own-profile control. |
| Own monitor/manager config: autonomy profile, runtime, interval, expiry, enable/disable, delete/cancel/trigger, approval or management-tool settings | **Never self-change** — propose to the operator via attention/journal | Legitimate `INPUT_REQUIRED` parking is communication, not a config change; it never disables the scheduler. |
| Board tasks: create/spawn, reprioritize, self-authorization | **Not permitted internally**; proposals only; existing external creation privileges stay | No task-spawn floods, no task-per-context-file; persistent context exists without board tickets by design. |
| Evidence-based authorized board transitions / Done | Only already-authorized transitions backed by the actual result/acceptance evidence | A finished turn or review rendering is not completion. |
| Archive own finished workers + context cleanup | Permitted only after verified secured handover and idle/no-pending/no-uncertain evidence; reversible archive, exact own context file only | Never stop live work to clean up; never delete permanent evidence. |
| `supersede_unresolved_submission` / operator attestation | Never self-authorize; requires the real guard-bound operator decision | Fabricated attestation is prohibited. |

## Wake duty loop (every actual wake)

1. Load own persistent manager context, canonical C/P revision and the worker index; reload detail files only on changed revisions.
2. Reconcile actual session/order states and every open or uncertain receipt; observed already-admitted work is not re-sent.
3. Fully read new originals against exact receipts and **synthesize key findings continuously** — after steps and at each delivered result, even when the worker stays alive for follow-ups. Preserve evidence provenance; a worker claim is not an independently verified test result.
4. Analyse errors/blockers; fix within scope or task a separate worker correction; use the configured profile-specific fallback/compaction continuation with runtime readback and side-effect reconciliation; never invent causes or runtimes.
5. Decide and dispatch the next permitted development step **serially**; one logical management action at a time.
6. Escalate only genuine missing operator decisions as `INPUT_REQUIRED`; unchanged parked state stays a cheap no-op.
7. Archive finished own sessions and remove their context files only after the secured-handover sequence in the worker-context contract; reuse still-needed workers.
8. Update journal, compact context and worker index for the next resume and verify the readback.

## Autonomy versus model profiles

Autonomy profiles (**conservative / sandbox / mvp / yolo**) govern decision latitude, reversibility expectations, scope and escalation triggers; they are operator-configured and never self-changed. Model/thinking profiles (**execution / standard / deep / design / review**) select provider/model/variant per work type through current project policy with catalog and runtime readback. Keep the two axes separate in every prompt and decision; existing detailed contracts apply: [Optimistic MVP](optimistic-mvp.md), [Work packages](work-packages.md#minimal-functional-autonomy-and-decision-parking), [Integration-test monitor counters](integration-test-monitor.md#fingerprint-counters-and-progress), [Fallback routing](fallback-routing.md), [Worktree ownership](worktree-ownership.md), [Monitor tasks](monitor-tasks.md) for external scheduling.

## Persistent worker context and lifecycle

Every manager-created worker keeps its own persistent context file inside the project state area (path carried in the worker index; not a board ticket, not git-tracked), maintains it after each step and before reporting, and the manager synthesizes it continuously. Final teardown: secured handover verified → eligible checks → reversible archive of the own session → exact own context file removed; permanent evidence stays. Session IDs are runtime references only; after a reset, resume from the index and context, verify effects/receipts, never blind-replay or take over a foreign session. Missing future capabilities (server-side role checks, technical guards) stay **deferred**, not assumed.
