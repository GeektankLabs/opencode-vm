# Persistent Work Packages

Use a Work Package for a multi-task outcome that needs durable membership, explicit sequencing/integration, or recovery across sessions. It is a **management task**, not a new taskboard subsystem or a replacement for member tasks. Read [Worktree ownership](worktree-ownership.md) for every member's write ownership and [Board workflow](board-workflow.md) before any Board mutation.

## Assemble the package from verified tasks

The user may start with concrete task IDs, a goal/topic, or required tasks plus optional candidates.

1. Preserve the selected connector/project. Read each supplied ID directly with the discovered task tool. For a goal, search with the actual discovered query schema. `TASK_SEARCH_INCOMPLETE` is unknown coverage, not proof that no task exists.
2. Check titles/descriptions, current Board status, superseded/duplicate/transfer state where exposed, existing task documents, project/workstream scope and linked sessions. Do not infer current implementation from Board status alone.
3. Classify every candidate as a required outcome or optional candidate, and as analysis/concept, implementation, verification/review, integration or external acceptance. Identify known prerequisite tasks, expected baseline/versions, shared files/packages/submodules/generated assets and work that must follow a consolidated HEAD. Mark unknown conflicts as unknown; do not call the tasks independent without evidence.
4. Propose members and explicit exclusions to the user, explaining any dependency or duplicate finding. Reuse existing cards for the same outcome; do not create one package per agent step. Board search/read is read-only. Create or change a package/member/link only within the user's confirmed Board mutation scope.
5. A confirmed package creation uses the actual discovered Board Project and task-creation schema. The package description should state its independent orchestration outcome, member `task_id`s, exclusions and high-level acceptance. Keep detailed evolving status in the package C/P, not by replacing the entire Board description on every turn.

A package may exist in Board `todo` while members need concept work, decisions, missing C/P, baseline inspection or external prerequisites. Record these as explicit readiness gaps, with owner and next evidence. Do not move it into execution just to begin that preparation.

If a candidate is `done`, retain it when its implementation/commit is still a required integration input. If superseded or transferred, preserve the exact stable ID and known resolution; do not silently revive or duplicate it. If a task is outside the selected project, its connection/document content is unavailable, or task search is incomplete, report the gap before finalizing membership.

## Initialize and persist the management task

The package has its own stable Board `task_id`, Compact Context and Concept Plan at the normal task-ID paths:

```text
.opencode/tasks/task-<package_task_id>.compact.md
planning/task-concepts/<package_task_id>-concept-plan.md
```

The plan contains the goal/scope, member and exclusion rationale, dependencies, ownership/worktree plan, version/shared-hunk map, integration target, waves, operator boundaries, acceptance and cleanup. The compact context is the short current snapshot: per-member Board state, session/message/result evidence, worktree/base/HEAD/commit/dirty state, implementation/integration/acceptance state, blockers and next safe management action. Keep the two roles distinct; do not paste histories/logs or the full plan into C.

On the authorized package transition, use the existing document lifecycle: leave Board `todo`; create/reconcile both files, exact header readback and correlated `CONCEPT_READY`; register with discovered `add_task_document_bindings` if present, otherwise `register_task_document` only when the bundle tool is absent; read both as `available` with exact paths/revisions (`REGISTERED`). Do not fall back after a bundle error. **For a package, apply the readiness gate below after `REGISTERED` and before the separate Board move.** If not ready, preserve the registered documents and leave the package in `todo`; a later authorized readiness transition reuses them. Move the Board only after the gate passes and read back status (`BOARD_MOVED`). Uncertain writes require the existing readback/recovery rules, not blind retries. See [Initialization follow-through](initialization-follow-through.md).

No package-specific MCP fields are needed: use task description for stable outcome/membership, C/P for the full working state, existing task/session links for supported evidence references, and original messages/files/Git reads for claims. If direct task-document tools are absent, keep to the skill's exact-text fallback; don't invent capabilities or assert that references can be read.

## Build the wave plan and evaluate `WORK_PACKAGE_READY`

`WORK_PACKAGE_READY` is an orchestrator checkpoint in the package documents/result, not an OpenCode/MCP tool, Board column, permission grant, or synonym for `CONCEPT_READY`, `REGISTERED`, `BOARD_MOVED`, member completion, integration, or acceptance. Every checkpoint names the exact package ID, wave, relevant document revisions, integration target/base and excluded/parked members. It applies to the **named wave only**; later waves are reevaluated against their actual predecessor state.

Create explicit waves such as discovery/concept readiness, independent isolated implementation, serialized integration/reconciliation, combined regression and dependent implementation. For each member state dependencies, parallel/sequential classification, expected source base, required prior integrated HEAD, likely file/hunk/version/release overlap, worktree owner and verifier. If exact diff overlap is not yet knowable, classify the risk and do not promise conflict-free parallel work. One integrator owns the shared target tree; concurrent source work cannot update shared bundle/version state in that tree.

Mark the named wave `WORK_PACKAGE_READY` only when all applicable checks pass:

- membership, goal, exclusions, acceptance and authorization for that wave are explicit;
- every starting task is implementation-ready for its assigned scope and has current required task documents;
- task dependencies, expected basis and actual required prior integration are verifiable;
- simultaneous writers have separate usable persistent worktrees and unique owners, or the plan deliberately sequences them;
- tool-level file-write targeting is verified, not inferred from shell `workdir` or the prompt;
- likely shared-hunk, version, package, submodule, generated-output and test-service conflicts have an explicit order/reconciliation plan;
- integration owner/target, combined checks, checkpoints, retention and next handoff are specified;
- actual decisions and operator boundaries are settled, or the affected task is explicitly parked outside this wave;
- the latest package/membership/task-document/baseline observations are cited with time/source.

A ready wave does not imply all package tasks are ready. An unready member can remain `todo` or blocked while an independent ready wave proceeds. A member's blocked condition does not block independent work unless dependency or shared-state analysis shows that the other wave is unsafe.

After a dependency integrates, verify the real integration-tree `HEAD` and the presence of required content before starting downstream tasks. Update package C with the new target, resulting integration commit and actual checks. Retain done members in package membership and report their implementation/commit contribution even if external acceptance is outstanding.

## Minimal-functional autonomy and decision parking

The package authorizes workers to make small/medium reversible engineering choices that stay inside its documented architecture, member task scope and acceptance criteria. Workers record material assumptions and continue to a safe implementable result; do not pause for each local coding choice. This does not authorize new product semantics, scope, security boundaries, core architecture, irreversible schema/data changes, remote publishing or out-of-scope product cleanup.

When a genuine decision exceeds the plan, the member worker must:

1. stop only the dependent portion in a recoverable state and retain its worktree/dirty changes;
2. return the normal terminal agent-managed `INPUT_REQUIRED` with the exact decision, context, safe options, completed work and paused work;
3. leave independent members running only when their bases, scopes and resources are verified independent;
4. let the orchestrator read that exact result, resolve the decision in Chat/Work with the user, check the original session is idle/no pending security input and send a normal authorized follow-up to that same session.

`INPUT_REQUIRED` is a completed turn, not business/task/package completion. Real host/security permission requests remain independent. Do not use native Question replies, create a second session to evade a busy/unresolved write or auto-change Board status. Record the blocker and next decision in package C on the next authorized maintenance write.

## Morning Handoff without prior chat context

On return, start from the selected connector/project, package Board task, registered package C/P and exact member IDs. Read package C first and the plan only for needed dependency, design or integration detail. Re-read the live Board states and task document bindings; inspect required original session messages/results under the normal content protocol. Then verify each relevant worktree's physical path, Git root/common-dir, starting base, HEAD, branch, dirty/untracked state and owner, plus the actual integration target `HEAD`.

Summarize separately:

- member Board status and obligation still owed;
- session/receipt/tool observation, including unknown, busy, pending input and original-result coverage;
- implementation and actual test evidence;
- local source commits and uncommitted changes;
- integration source/target commit and combined-check state;
- external/Hosted/operator acceptance and who must perform it;
- retained worktrees, blockers and the next safe operation.

Neither an idle session nor Board `done` proves result review, integration or external acceptance. A local commit can remain `in_progress` while the agreed external acceptance is open. An integrated task worktree is not automatically safe to delete. Fresh VM history is not automatically restored: the existing default start is fresh; `--keep-history` is an operator option, not a promise. If a linked original result cannot be retrieved, report the evidence gap rather than repeating test claims from C. This is an on-demand handoff, not a watcher, scheduler or automatic morning notification.

## Chat, ChatGPT Work and OpenCode-VM are separate roles

Use ordinary Chat for interactive goal clarification, candidate selection, Readiness discussion, prioritization and later result review. After a named wave has reached `WORK_PACKAGE_READY`, the skill should direct a multi-step management run to a **ChatGPT Work** session when that surface, selected project and required app tools are actually available. If already in a suitable Work session, continue there. Otherwise give the user a clear Work-start instruction and a copy/paste handoff; the ordinary chat cannot silently turn itself into Work and the skill does not claim an automatic Work-invocation API.

ChatGPT Work coordinates the package and invokes the selected OpenCode project connection for repository work. The OpenCode VM remains the worker/runtime that reads or changes repository files, runs tests and creates local commits. Work availability depends on account/plan/workspace/surface; connected apps and their permissions are separate. If the selected Work surface cannot access the intended connection/tools, report that prerequisite and do not pretend an OpenCode task was sent. For UI labels/availability, consult the current [ChatGPT Work and Codex documentation](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex).

The documented ChatGPT model picker is separate from the project's OpenCode runtime profile. Do not translate an OpenCode provider/model/variant ID into a ChatGPT Work model or claim that `update_session_runtime` switches Work's model. The Work user selects a model available in that product surface; the profile capability below governs only an OpenCode worker when a submission to that runtime is being prepared.

## Choose and resolve the OpenCode management profile

Recommend a profile based on the whole management work package:

- **`execution`** — fixed member plans, ready waves and deterministic integration/checklist work;
- **`standard`** — ordinary multi-task coordination with bounded reconciliation;
- **`deep`** — uncertain architecture/dependencies, several serious Shared-Hunk conflicts or difficult integration diagnosis.

State one sentence explaining the recommendation. Discover `get_recommended_runtime` and its actual schema before using it. Resolve against current project policy; do not hard-code a provider, model, variant or OpenAI Work selection. An explicit user runtime/profile wins. The resolver skips only `null`, and the first configured unavailable/uncheckable/incomplete mapping is a stop, not permission to choose another configured profile. All-null/unconfigured may use the existing suitable OpenCode session default under the current skill contract.

For a new OpenCode work submission, apply the resolved exact tuple only to the chosen idle/no-pending-input session using the discovered runtime-update capability; preserve agent and omitted settings, read the session back, then send once. If the connection lacks profile/runtime tools, say so and use the existing suitable session only where the current submission contract permits; do not invent a tool, restart/restage a connector, or block ChatGPT Work pretending it can use the OpenCode tuple as its model.

## Compact Work-session bootstrap

Once ready, generate a small handoff rather than copying the package description or plan:

```text
Coordinate Work Package <package_task_id> for project <verified project/connection>.

Package C: <exact registered compact_context path>
Package P: <exact registered concept_plan path>
Gate: WORK_PACKAGE_READY for <named wave> on <verified base HEAD>.

Read the Board task, C and P first. Verify the package/member documents and
current Board/result evidence; the files define scope and plan, originals prove
execution. Before writes, verify the task's owner, persistent worktree, base HEAD,
dirty state and actual file-tool target. Follow the planned wave/integrator; do
not start dependencies on an older HEAD. Update C after substantive milestones;
update P only for real concept changes. Make safe in-plan technical decisions
autonomously; return terminal INPUT_REQUIRED and park dependent work for a
plan-exceeding decision. No remote Git write/push. Report implementation,
tests, commits, integration and external acceptance separately.
```

The assistant should confirm the exact package/wave, the C/P actually read, the verified owner/base, the OpenCode connection it can use and its next safe step. That is an acknowledgement, not proof that any member started. Capture each actual OpenCode submission's receipt and original result using the usual per-session contract; do not assume queueing or issue a second send after an uncertain response.
