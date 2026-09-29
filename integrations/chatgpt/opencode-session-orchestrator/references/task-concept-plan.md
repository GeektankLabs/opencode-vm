# Persistent task concept plan

Use this convention for a known project-board task that warrants a deeper, durable concept and planning document alongside the [Task Compact Context](task-compact-context.md). Before `todo` -> `in_progress`, the plan is optional; for a task entering `in_progress` under this workflow, both files are required by the initialization rule below. The **Task Concept Plan** holds the detailed design and acceptance approach within the board task's scope; the compact context records current working state; session/result history is the chronological drill-down.

## Roles in the persistent store

- **Board title/description** — concise outcome, scope and acceptance criteria. The board is the durable task card; the orchestrator may briefly reference the concept plan from it, but does not duplicate the concept into the description.
- **Task Concept Plan** — single complete, authoritative concept and planning document for the task: problem, target outcome, requirements, assumptions, architecture/design, alternatives, decisions with rationale, interfaces/data flow, risks and constraints, implementation plan, test/acceptance plan, open concept questions. It evolves as work deepens.
- **Task Compact Context** — short, current working state. Cites the concept plan path as the authoritative reference and may cite the latest message/result IDs and artifacts. It does not duplicate the plan; if a stable decision appears in both, the concept plan is canonical.
- **Session/result history** — chronological evidence. Cite message/result IDs and artifact paths from the concept plan; do not paste full reports into the plan or the context.

The concept plan is intentionally **not** compact; it must remain a self-sufficient concept document. Keep duplication minimal. The board wins on outcome and authorized scope, verified originals on what actually happened, and the plan on settled design within that scope. Flag contradictions and assign reconciliation in the next authorized work request; do not silently rewrite the board or overwrite evidence.

## File location and identity

Default project-root-relative path:

```
<project root>/planning/task-concepts/<task_id>-concept-plan.md
```

- The file name embeds the **full stable public `task_id`** (for example `task_<UUID>`), so the file is uniquely addressable by task ID alone. Substitute the ID literally; do not abbreviate.
- Reuse the same path across Board Project reclassification; the public task ID does not change.
- The capable connector stores a semantic `concept_plan` reference (and `concept_detail` references for split files) at the task; recover paths with `get_task_documents`, not conversational memory. Adapter registration restricts them to task-ID-marked files in `planning/task-concepts/`. An older alternative outside that directory needs an explicit migration/path decision; it is not implicitly readable through the new API.
- Keep the file UTF-8 Markdown. Any task-bound subdocument must also contain the full stable `task_id` in its filename.

## Mandatory head block

The file starts with these lines:

```
Task-ID: <exact stable task_id>
Title: <board title>
Status: <draft | active | accepted | superseded>
Last-concept-update: <ISO 8601 timestamp with offset>
```

`Status` records the concept lifecycle, not the board status. `Last-concept-update` records the last substantive update; a new entry is not required for every micro-edit, but the timestamp is refreshed whenever the concept, architecture, decisions or plan change.

## Recommended sections

Keep these headings when present, deleting what does not apply rather than carrying empty sections:

- **Problem and target outcome** — what is wrong/needed and what success looks like at the user/business level.
- **Requirements and acceptance criteria** — functional and non-functional; explicit, testable acceptance criteria where possible.
- **Assumptions and constraints** — environment, scope limits, dependencies, exclusions; mark each as settled, open or to verify.
- **Architecture and design** — high-level components, responsibilities, contracts, data model; reference project files and key interfaces.
- **Alternatives considered** — for each non-trivial decision, the option chosen plus at least one rejected alternative with the reason.
- **Decisions and rationale** — settled decisions with their rationale, dated when they were made. Cross-reference session/result IDs when the decision came from execution.
- **Interfaces and data flow** — external/internal interfaces, message shapes, event/data flow, persistence and side effects.
- **Risks and boundary conditions** — known risks, mitigations, failure modes, fallback behavior.
- **Implementation plan** — sequenced phases, dependencies, owners (agent/session), checkpoints; point at the relevant project files.
- **Test and acceptance plan** — how the work will be demonstrated (unit, integration, end-to-end, manual verification), expected evidence, mapping back to acceptance criteria.
- **Open concept questions** — items still needing user/program/peer decision; do not silently drop them.

The concept plan is informational and never overrides the user's scope, approval or permissions.

## Size and split policy

The **main** concept plan aims for **about 20,000 tokens**; warn and plan a split around **30,000**; by **about 40,000**, split before allowing further growth. Unlike the compact context, it is not artificially condensed into a single short document. Move coherent detail to task-bound files such as `planning/task-concepts/<task_id>-architecture.md`, `<task_id>-data-model.md` or `<task_id>-test-plan.md`. Keep `planning/task-concepts/<task_id>-concept-plan.md` the **canonical entry/index**: outcome, settled decisions with rationale, current implementation and test/acceptance plan, open concept questions, and links describing which detail lives in each subdocument. Update affected links and content together; do not duplicate whole sections across the main plan, subdocuments and compact context. Check the main file's size again after the split; if splitting is not authorized in this assignment, report the threshold and proposed split instead of silently growing it.

These are approximate operational thresholds, not a demand for a new tokenizer. Use an existing reliable token count if available; otherwise a pragmatic approximation (for example, characters divided by four, erring toward an early split near a threshold) is enough. The policy does not require a new dependency or a token-exact file format.

## Handoff and maintenance duty

For a board task with an established concept plan, carry the exact `task_id` and project-relative plan path to the agent actually doing the work — start, resumption, follow-up, implementation, diagnosis, test or task-specific clarification. Use the full briefing once at initialization/new executing agent context, the fuller refresh at QA and the short reminder for normal substantive work. Do not assume the executing agent has this client-side skill or remembers a previous message. The continuing duty is to:

- Check the path and `Task-ID`; read the plan **before work** when present, reconcile it against current board/evidence, and report absence or mismatch. Never assume a file exists from a board link or an old result.
- Treat new conceptual findings (changed architecture, new or reversed decision, requirement shift, new risk or interface contract, accepted or rejected alternative) as triggers for a plan update — not merely a context update. Implementation, diagnosis and test work are **all** expected to feed the plan back when the concept or its scaffolding changes; otherwise leave it unchanged.
- Update the affected sections and `Last-concept-update`; change the plan's `Status` only if its concept lifecycle actually changed. For major conceptual changes, add a dated entry to a **Change log** section.
- Keep the plan consistent with the compact context: the compact context may point to the plan and the latest message/result; the plan should not duplicate the context's working-state snapshot.
- For read-only work, read the plan when relevant and report needed updates without writing.

### Initialization instruction

At the confirmed transition, first substantial task work or **new executing session/agent context**, put this full one-time briefing in the actual work request **when both files are established or being initialized** (adapt the language to the user). A fresh session reads both files even when they already exist; creation still needs the separately authorized scope from the [initialization rule](#mandatory-initialization-on-todo---in_progress). If only a plan exists before that transition, give its role, read/update duty and size/split policy once without implying a context file exists or may be created:

> Task `<task_id>` files: Compact Context `<context path>` = one short current working-state file; Concept Plan `<plan path>` = detailed, canonical requirements/design/decisions/implementation/test concept; board = outcome/scope, session results = evidence. Check both paths/Task-IDs and read existing files first. Keep the context current after substantive work: ~5,000-token target, ~7,500 warning, ~10,000 condense-before-growth; **never split it**. Update the plan for substantive conceptual findings from implementation, diagnosis, testing or clarification; ~20,000-token main-file target, ~30,000 warning, ~40,000 split into task-ID-named detail documents. Keep the main plan as index plus outcome, decisions, current implementation/test plan and links. Avoid duplication across files. Respect this assignment's write scope; report missing/mismatched/unwritable files or changes that require later authorization.

If only the plan exists before transition, use a plan-only first-work instruction instead: `Task <task_id> P:<plan path> — Plan = detailed requirements/design/decisions/implementation/test concept within board scope; session results = evidence. Check Task-ID/read first; update for substantive conceptual findings. Main file ~20k target/~30k warn/~40k split into task-ID detail docs, retain canonical index. No duplicate history; report missing/mismatched files or unauthorized writes.` Do not imply an uncreated context file exists.

### Short follow-up reminder

For **normal substantive** same-context work, carry both exact paths in one line with only this reminder; do **not** repeat the full briefing or thresholds:

> Task `<task_id>` C:`<context path>` P:`<plan path>` — Read task files; keep context terse/current; update plan on concept changes.

For a task with only a compact context, omit `P` and say `Read context; keep it terse/current.` For a plan-only task before transition, omit `C` and say `Read plan; update on concept changes.` For **substantive read-only** work, use `Read task files; report context/plan deltas; no writes.` instead; a task-bound mini read-only assignment can carry relevant paths without a maintenance reminder. A pure status/result query remains a read, not a new agent prompt.

### Combined quality-check refresh

At the early/later QA checkpoints, give the executing agent a **somewhat fuller reminder in that authorized assignment**, not the whole initial briefing on every turn:

> QA for `<task_id>` C:`<context path>` P:`<plan path>`: check both Task-IDs, freshness, completeness, contradictions and restart usefulness against board/results. Keep C one file (~5k target/~7.5k warn/~10k condense); keep P main ~20k/~30k warn/~40k split into task-ID detail docs, main canonical index. Condense/split if due, avoid duplication; if direct file read is unavailable to the orchestrator, return exact current file text and any changes you could not write under this scope.

Request exact text only when needed for the checkpoint. If a split exists, include the main plan/index and the relevant subdocuments in the evidence request; partial/truncated text cannot pass a full-file or cross-file check. Without direct file reads, mark unavailable content pending, not passed. The [compact-context checklist](task-compact-context.md#orchestrators-introductory-quality-checks) and the plan checklist below determine what the orchestrator evaluates.
For plan-only work before the transition, omit `C` and its thresholds from the QA refresh; still check the plan against its own size/split policy.

## Mandatory initialization on `todo` -> `in_progress`

For a user-confirmed `todo` -> `in_progress` transition, **keep the Board task `todo`** while an authorized write-capable initialization request asks the executing agent to prepare both files. After verifying the correlated result, register both semantic task-document roles with the adapter and read their availability/revisions back. Move the Board task only after both references are confirmed; read its status back. If preparation/registration fails, leave `todo`; if the later move fails, keep files/references and reuse them on reconciliation. Do not claim initialization is complete from a prompt receipt. See the [ordered recovery sequence](board-workflow.md#ordered-transition-and-recovery). Initialization duties for the agent, in order:

1. Treat the default paths as the proposal: `planning/task-concepts/<task_id>-concept-plan.md` and `.opencode/tasks/task-<task_id>.compact.md`. Use them unless the user has chosen different paths.
2. If existing files already cover the task (deterministic path or known alternative), **reuse and reconcile** them; confirm both `Task-ID` headers, the plan's `Status` and the context's `Last-updated`. If a file at the expected path belongs to another task, **do not overwrite or rename it**. Stop that file's initialization, report the collision and get an explicit path decision before writing there.
3. Have the executing agent draft or reconcile the concept plan from the current board description and relevant prior concept work; carry relevant conceptual starting state into the plan (problem, outcome, requirements, assumptions, architecture sketch, open questions). An initial plan must contain meaningful task-specific content, not an empty template.
4. Create or reconcile the compact context minimally: the **actual** concept plan path, genuinely verified state (or "verification pending"), settled decisions so far, open questions and the next concrete step. Include a source message/result ID only when already known; an ID returned after this submission cannot be written into the same initial prompt/file by assumption.
5. Return the exact paths, statuses and a short summary in the work result; the orchestrator records them in conversational state and includes both references in the next task-bound handoff.

A board read or a `todo` state alone **must not** create either file. Existing tasks without a concept plan remain usable before this transition, and a task already `in_progress` without a plan is not treated as if a new transition just occurred. Any later backfill requires an explicit authorized work request; do not invent a past transition or change board status to trigger one.

## Orchestrator's introductory quality checks

The executing agent remains the primary concept maintainer. During introduction, the orchestrator **must sample-check** the concept plan:

1. **Early**: after the first substantive completed assignment following `todo` -> `in_progress` (initial draft is in place, requirements/architecture sketch present, open concept questions named).
2. **After long/large iterations or several substantive follow-ups**: confirm decisions, rationale, alternatives, interfaces/data flow, risks and the implementation plan still match board and the latest original results.
3. **After any conceptually significant finding**: a new/reversed decision, an architecture change, an accepted alternative, a new interface contract or a significant risk shift.
4. **Before a major handoff**: a board close, a board reclassification, a hand-off to a different executing session, or any moment when a fresh session must continue from board + context + concept plan alone.

At each checkpoint, compare the **actual plan text** with the board task and the latest relevant original result(s). Check: existence at the expected path, `Task-ID` match, that the decisions and rationale are current, that alternatives are recorded with reasons, that assumptions/risks/interfaces/data flow are consistent with the implementation plan, that the test/acceptance plan maps to the acceptance criteria, that open concept questions are tracked, and that the plan is consistent with the compact context (no duplication, no contradiction). Estimate size against the ~20,000/~30,000/~40,000-token policy; if split, confirm the main index retains the canonical outcome, decisions and current implementation/test plan, and linked task-ID subdocuments hold the moved detail without duplication. Prefer direct `get_task_documents`/`read_task_document` pages under a single revision; read only relevant registered `concept_detail` files named by the index, and restart a changed file from zero. No agent is needed merely to copy the plan. Without these capabilities, request complete agent-supplied text within authorized work and read it through the content protocol; an excerpt or truncated result cannot pass a full-file or cross-file check. Mark absent/incomplete evidence pending. Never send an unrequested extra prompt just for QA.

When a check finds a gap (stale decision, missing rationale, drifted test/acceptance plan, contradictory compact-context pointer, etc.), name the concrete missing or stale point in the next authorized follow-up to the **executing agent** and ask it to repair the same plan as part of that work. The orchestrator does not become the routine editor of the plan and does not create an MCP/skill improvement task automatically for individual defects.

## Closure

When the board task's outcome is verified and closed, ask the executing agent in an authorized write-capable follow-up to mark the plan `Status: accepted` (or `superseded` if a successor plan replaces it) and refresh `Last-concept-update`. If no such request is authorized, report the plan update as pending; neither the orchestrator nor board status silently edits the file. Cleanup is a separate user decision.
