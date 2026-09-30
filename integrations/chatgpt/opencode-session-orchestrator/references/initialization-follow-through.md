# Initialization follow-through after `CONCEPT_READY`

This reference is the canonical document for the **post-`CONCEPT_READY` follow-through**: the orchestrator's ordered steps after the executing agent has reported its file-creation/reconciliation result. It complements the [task concept plan](task-concept-plan.md) §"Mandatory initialization on `todo` -> `in_progress`" (which is the agent's initialization duties) and [board workflow](board-workflow.md) §"Ordered transition and recovery" (which is the orchestrator's ordered sequence at the highest level). Read it whenever a user-confirmed `todo` -> `in_progress` transition is in progress and the agent's correlated result is on the desk.

The regular task transition uses three labelled checkpoints. None is optional and none replaces the next. A Work Package has one additional, package-only readiness gate between `REGISTERED` and the Board move; it does not change the regular task sequence.

- [`CONCEPT_READY`](#concept-ready) — the **executing agent** has created or reused both task files at the canonical paths, each with a matching `Task-ID`, and reports their actual paths, statuses and a short summary. The agent's terminal return.
- [`REGISTERED`](#registered) — the **orchestrator** has bound both main roles with preferred `add_task_document_bindings` (register fallback only when absent) and `get_task_documents` shows both as `state:available` with exact paths and revisions.
- [`BOARD_MOVED`](#board-moved) — the **orchestrator** has called the Board move tool to change the task to `in_progress` and a readback of the Board task confirms the new status.
- [`WORK_PACKAGE_READY`](work-packages.md#build-the-wave-plan-and-evaluate-work_package_ready) — for a package only, the **orchestrator** has verified the named startable wave against its current task/document revisions, worktree ownership, dependency base and plan before attempting `in_progress`. It is not a Board or server state.

The Board task never moves to `in_progress` before `REGISTERED`; a Work Package also never moves before `WORK_PACKAGE_READY`. `CONCEPT_READY` is the start of the orchestrator's follow-through, not its end. A package that is not ready keeps its registered documents and remains `todo`.

## CONCEPT_READY

The executing agent's terminal return on a successful file creation/reconciliation. The orchestrator must accept it as evidence only after parsing and verifying every required field:

1. The literal label `CONCEPT_READY:` appears in the agent's correlated original result. (The label is for the orchestrator's bookkeeping; it is a skill-level vocabulary term, not a server field.)
2. The agent reports the **actual** path of each file (`planning/task-concepts/<task_id>-concept-plan.md` and `.opencode/tasks/task-<task_id>.compact.md`).
3. The agent reports C's actual first three lines (Task-ID, Title, Last-updated) and P's actual first four (Task-ID, Title, Status, Last-concept-update), read from the real files and printed in the terminal and original final result under each role/path. First line must be exactly plain-text `Task-ID: <stable task_id>` with the full ID substituted: no heading/backticks/alternate label/extra spacing. Agent success without header evidence is not accepted; “checked” or paths/IDs alone cannot pass.
4. Header metadata identifies the intended task; a foreign Task-ID requires `INPUT_REQUIRED`, never overwrite/rename/retarget. Agent-supplied evidence is not independent adapter verification.
5. The agent supplies a short summary (problem, design, next concrete step).

If any of these fields is missing, the orchestrator rejects the checkpoint and stops with Board still `todo`. Path-only reports are not sufficient: a path-only report is indistinguishable from a hallucinated path. The orchestrator asks the executing agent to provide the actual `Task-ID` from each file's head block before any registration call. See the [regression scenarios](regression-scenarios.md#ordered-initialization-direct-document-reads-and-executive-view) for the explicit reject row.

`CONCEPT_READY` does **not** authorize the Board move or registration by itself. The confirmed transition package supplies authorization; the orchestrator must still verify files, bind and read back. The agent result closes only its own part of the work.

## REGISTERED

The orchestrator's first internal checkpoint. The orchestrator completes the following steps, in order, with explicit success/uncertain/failure branches:

1. **Verify each file on disk.** Open both files at their canonical paths. Confirm the `Task-ID` head block matches the board task, the plan's `Status` and `Last-concept-update` are present, the context's `Last-updated` is present, and the content is the one the agent reported (head block and first paragraph). A different `Task-ID` at a canonical path is a collision; stop with a path-decision request, do not overwrite, do not rename.
2. **Bind both roles.** When discovered, call `add_task_document_bindings` once with `task_id`, `compact_context` and `concept_plan` at the verified paths. All files/Task-IDs/conflicts are validated before one atomic sidecar publication. Exact replay revalidates files and adds no references; no `expected_path`, replacement or file writing exists here. Only if this tool is absent may `register_task_document` bind each main role without `expected_path`; on authorized fallback resume, keep matching successful roles and register only what remains. If neither capability is available, stop before initialization. Generic `artifact_refs` are not substitutes. Optional detail documents still use the existing register tool when authorized.
3. **Read back both roles.** Call `get_task_documents(task_id)` after the write and require both main roles present, `state:available`, exact paths and revisions. A bundle conflict/error stops before `REGISTERED` and Board move; never fall back to replacement. For an uncertain binding response, first inspect references read-only; a later authorized identical add-only replay is safe, then read back again. This is not permission to blindly retry a Board move or a management note.

The transition to `REGISTERED` is the orchestrator's commitment to the files. Only after `REGISTERED` does the orchestrator proceed toward the Board move; a package must first pass the additional gate below.

## WORK_PACKAGE_READY for a package transition

Before moving a package task to `in_progress`, read the current package task, registered C/P and their actual revisions. Check the exact intended first wave, member scopes/documents, expected and actual base HEADs, dependencies, shared-file/version conflict plan, persistent worktree/owner, actual write-tool target, integration owner, operator boundary, acceptance and explicit parked members against [the package readiness contract](work-packages.md#build-the-wave-plan-and-evaluate-work_package_ready).

Report `WORK_PACKAGE_READY` only for that named wave, with package ID, wave, source document revisions, base/integration HEAD and excluded members. If a relevant C/P or base changes during the check, reread it and reevaluate. If any readiness item is missing, retain files/bindings, do not move the Board, and report the concrete gap. `WORK_PACKAGE_READY` is neither `CONCEPT_READY` nor `REGISTERED`, and does not make a member done or prove implementation/integration. After it passes, use the ordinary separate Board move and exact status readback required by [`BOARD_MOVED`](#board-moved).

## BOARD_MOVED

The orchestrator's second internal checkpoint. The orchestrator completes the following steps, in order:

1. **Check the preceding gates.** Require `REGISTERED`, and for a Work Package also the current `WORK_PACKAGE_READY` evidence for the exact wave. With the discovered Board move tool, change the task to `in_progress` only after those prerequisites.
2. **Read the Board task back.** Confirm the status even after an uncertain move. Do not claim `todo` or rollback from a lost response: the move may already have occurred. A confirmed `in_progress` resolves delivery; a verified `todo` permits authorized resume only once non-delivery is established. Other statuses/conflicts require a new decision; unavailable readback leaves status unknown. Preserve registrations/files and never blindly repeat the move.
3. **Mark the transition complete.** Only after the readback confirms `in_progress` does the orchestrator mark the transition `BOARD_MOVED` and report the verified files, registrations, revisions and Board status to the user.

`BOARD_MOVED` is the only complete transition checkpoint. Before a move attempt the task stays `todo`; after an uncertain attempt its status is unknown until read back, not assumed `todo` or `in_progress`. Sidecar binding, filesystem and native Board DB have no common transaction or cross-client CAS.

## Orphan-files recovery

An interrupted initialization can leave matching files at canonical paths, no semantic registration and Board still `todo`. The recovery path is explicit and ordered, not a cross-store atomic transaction:

1. **Detect.** Either via a deterministic path check or, when the connector exposes it, via `get_task_documents(task_id)` after a fresh chat. Absence of references is **not** proof that the files are absent; the deterministic path check is the source of truth.
2. **Verify `Task-ID`.** Open each file at the canonical path and read its `Task-ID` head block. The `Task-ID` must match the board task. A foreign `Task-ID` is a collision — see [Failure shapes](#failure-shapes) below.
3. **Reuse.** Do **not** ask the executing agent to recreate the files. Do **not** rename the existing files. Do **not** invent legacy artifact links.
4. **Bind.** Use the same preferred add-only bundle and absent-tool register fallback as fresh initialization. Existing matching references are safe; a different main binding is a conflict, never a retarget opportunity.
5. **Read back.** Run the same `get_task_documents` flow used for fresh files.
6. **Move and readback.** Run the same Board move + readback flow used for fresh files.

The recovery path produces the same end state as the fresh-init path. The two paths differ only in whether the agent is asked to write the files; in both paths the orchestrator's follow-through is identical. The user-confirmed transition package is the only authorization for any of these steps; a fresh chat that finds orphan files does not silently resume the transition without re-confirming the original `todo` -> `in_progress` authorization.

## Failure shapes

Each failure shape has a precise orchestrator action. The principle is fail-closed: the Board never advances past a genuine error.

| Shape | Orchestrator action |
|---|---|
| Agent reports `CONCEPT_READY` with verified paths/IDs/summary | Continue with verify → register → readback. |
| Agent reports `CONCEPT_READY` with paths but no `Task-ID` from each head block | Reject the checkpoint. Ask the executing agent to provide the actual `Task-ID` from each file's head block. Board stays `todo`. |
| File at the canonical path belongs to another `Task-ID` | Stop with a path-decision request. Do not overwrite, do not rename, do not move. Board stays `todo`. |
| One of two registrations fails | Stop with Board still `todo`. Preserve the successful registration. On a later authorized retry, register only the missing role; do not duplicate the successful one. |
| Add-only bundle conflicts or a file has a wrong Task-ID/path | Stop before `REGISTERED` with Board still `todo`; no partial publication, no replacement fallback or Board move. |
| Add-only bundle response is lost/uncertain | Read references first; preserve files. An authorized identical replay is idempotent, then mandatory available/path/revision readback. No changed-path retry. |
| Header format mismatch in a safely task-owned file | Keep `todo`, inspect actual header/ownership, minimally repair the same file in authorized work and renew exact header/metadata evidence. Rebind using the preferred bundle, absent-tool register fallback only; require both roles available with exact paths/revisions before separate move/status readback. A bundle error does not enable replacement fallback. |
| Both registrations succeed but `get_task_documents` does not show both roles as `available` | Stop with Board still `todo`. The successful registration is preserved; the readback gap is a registration-state issue, not a Board-state issue. |
| Both registrations read back as `available` but the Board move returns uncertain or fails | Preserve files/references; read exact Board status before any retry. It may already be `in_progress`. Unknown delivery is not rollback or confirmed `todo`; retry only after non-delivery is established. |
| Board move returns success but readback does not show `in_progress` | Do not mark `BOARD_MOVED`. Preserve files/references and report actual status/unknown; reconcile before any retry. |
| An approval interrupt arrives before the Board move completes | Preserve the last successful step (the verified files, the successful registrations, the `get_task_documents` readback). On confirmed re-authorization, resume from the next pending step — never restart the entire sequence, never recreate files. |
| Same-session follow-up arrives before the Board move completes | Treat the follow-up as the continuation of the authorized transition, not a new request. Do not duplicate the verification, do not re-register already-registered roles, do not advance past the next pending step without its own evidence. |

The orchestrator never silently retries or recreates successful files. It reports the precise failure and last verified state, never a Board status inferred from a receipt. Exact binding replay is distinct from non-idempotent note/Board operations.

## What the orchestrator does not do

The orchestrator does not start a background process, polling loop, daemon, scheduler or hidden retry to "complete the transition later". The transition is a synchronous client-side workflow; the orchestrator either completes it in the current authorized assignment or stops at the precise last successful step and reports it. A later authorized retry resumes from the next pending step under the same package; it does not create a new attempt from scratch and it does not assume a push channel that does not exist.
