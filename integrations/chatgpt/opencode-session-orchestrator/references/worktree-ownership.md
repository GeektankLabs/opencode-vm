# Git and Worktree Ownership for Agent-Managed Writes

Use this workflow for agent-managed tasks that may change repository files. A session ID is not an isolation boundary: sessions connected to the same project may share its working tree and Git index. Backend admission is already automatic for supported work writes; do not add a managed flag or repeated initialization prompt.

## Choose one owner and one working copy

Before the first substantive write, decide and report:

- the stable Board `task_id` when the work belongs to a Board task;
- the repository root and verified starting `HEAD`;
- the exact integration tree or isolated task worktree and its owner;
- whether any other active writer can touch the same worktree/index;
- affected subsystems, files, submodules, generated/package/version/release surfaces;
- required predecessor changes, expected integration target, and next safe integration step.

Pure reads and reviews need no write worktree. One explicitly exclusive, sequential implementation may use the integration tree. Concurrent independent writers use separate Git worktrees by default. Two agents must never coordinate by merely sharing a session, branch, directory, or informal assumption that their file changes do not overlap.

One active writer owns each working tree/index. Handing it to another session requires a verified stop/idle point, current Git readback and an explicit ownership update. A child session is not a worktree. Do not start a concurrent write child in the same tree; give it a distinct worktree or sequence it.

## Verify the tree before writing

Capture actual Git state, not only the prompt's claimed path:

```sh
pwd -P
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse HEAD
git status --short --untracked-files=all
git branch --show-current
git worktree list --porcelain
```

Resolve paths physically. Record the initial `HEAD` as immutable **base HEAD** and separately record the current `HEAD` after work. Identify modified, staged, untracked and ignored output relevant to the task. Do not stage, clean, stash, reset, overwrite or commit existing user/other-task changes. Stage explicit task-owned paths; inspect the staged diff before each commit. Local commits within the authorized task scope are already allowed by agent-managed policy. Push, send-pack, LFS publishing and other remote writes remain operator-only.

For opencode-vm, `.opencode-vm/` is already ignored. Prefer the persistent, project-mounted location:

```text
<project-root>/.opencode-vm/worktrees/<full-task_id>
```

Check that the path is absent or demonstrably belongs to this exact task before creating/reusing it; confirm Git reports it as an active worktree and that its contents/common Git directory remain reachable from the host after the VM ends. `/tmp` is disposable, not a Morning-Handoff store, unless an independently verified snapshot/transfer is part of the authorized task. For other repositories, discover a persistent mounted path and a suitable ignore rule; never create repository state outside the authorized project just because this example exists.

Branches are optional; detached worktrees are valid. If a task branch is useful, use a unique task-specific local name and verify it is not already checked out elsewhere. Linked worktrees have separate checkouts/indexes, but share object storage and some refs/configuration. Do not concurrently mutate the same branch, common Git config, tags, worktree registrations or shared submodule checkout. A worktree does not isolate shared build outputs, test databases or service ports; identify and separate those too.

## Verify every write target

opencode-vm MCP `create_session` is fixed to the running project's canonical directory and has no worktree selector. A2A likewise uses its startup-fixed workspace. A shell command's `workdir`, `cd`, or `git -C` does not prove that OpenCode's separate Read/Edit/Write tools target that same worktree.

Before the first change, verify the actual active writer/tool surface against the intended physical worktree. For each write path used, confirm its resolved destination is inside the task worktree and Git reports the resulting change there, not in the integration tree or another task's worktree. Keep the task worktree beneath the mounted project when using an existing project session, and verify the actual tools can address it. If a tool is root-confined, the mount is absent, or the destination cannot be established, **do not write**: use an operator-prepared project/runtime connection scoped to that working copy or ask the operator to select the explicitly exclusive integration tree. Do not add a new MCP parameter or claim prompt text technically binds file tools.

## Record task ownership and resume safely

For an established task Compact Context, keep a compact current record of:

- `task_id`, connector/project, owner session and current writer;
- worktree path, Git dir/common dir, branch/detached state and original base `HEAD`;
- latest `HEAD`, local commit IDs or explicitly uncommitted state;
- relevant `git status --short --untracked-files=all`, changed-file scope and submodules;
- integration target, required predecessor commits, last successful integration/checkpoint;
- observation time and evidence source.

For a small task without persistent task documents, carry the same essential ownership/base in its actual task handoff and final result; do not create a Board card or C/P solely to manufacture a worktree registry. For a multi-iteration task, maintain its authorized Compact Context and point to its Concept Plan. Board links to sessions/results are useful references, not proof of Git state.

On same-task follow-up, reread the task documents and inspect the actual worktree, HEAD, status and task scope. Reuse only after matching the path/Git identity and resolving its previous owner. Never silently continue from a different/older base. If the expected integration base moved, compare the required changes, record old and new bases, and replan/reconcile before dependent writes; do not automatically rebase, reset, merge or overwrite.

## Plan conflicts and serialize integration

Before parallelizing, compare member scopes and planned file surfaces. Treat shared hunks, package/lock files, version markers, skill bundles, adapter/launcher code, release metadata, generated archives and submodules as likely conflicts even when task titles differ. Classify work as parallel, sequenced, or isolated-with-explicit-reconciliation. A path-overlap check is a warning, not proof that same-file hunks are independent.

One integrator owns the common integration tree at a time:

1. Read the source task's original result and verify the exact source commit, its parent/base, current source dirty/untracked state and intended file scope.
2. Read the integration tree's actual target `HEAD` and dirty state. Do not operate on a dirty tree unless every change is explained and belongs to this authorized integration.
3. Compare source and target history/diffs. Cherry-pick only a suitable task-owned commit when its base and changes are compatible. Otherwise port/reconcile the intended changes semantically; do not blindly copy whole files, choose `ours`/`theirs`, or revive stale generated artifacts.
4. Rebuild shared versioned bundles/pins on the consolidated target when required; run relevant combined regressions.
5. Record source task/commit/base, target base before, resulting integration commit/HEAD, included/excluded scope and test evidence. A semantic port need not make the source SHA an ancestor of the target; explicitly show the target commit that contains the reconciled change.
6. Before a dependent wave, reread the real target `HEAD` and verify the required predecessor changes are actually present. “Newer SHA”, Board `done`, or source commit existence alone does not pass this gate.

A blocked task does not block a different, genuinely independent wave. Keep the blocked task's worktree and dirty work intact while resolving its business `INPUT_REQUIRED` through the normal same-session follow-up contract. Technical turn completion never means Board completion or integration.

## Retain safely; cleanup is explicit

Keep the task worktree when a worker is active, the result has not been reviewed, the task is blocked, any relevant staged/unstaged/untracked change remains, integration is uncertain/pending, an external acceptance depends on it, or source evidence is needed for reconciliation. An integrated local commit may still require retention while Hosted/operator acceptance is open.

Removal requires all of the following to be verified: the owner stopped; the task result and exact source state were reviewed; every relevant change is integrated or explicitly preserved elsewhere; target integration/readback and required checks are recorded; no required acceptance depends on the checkout; and cleanup is within the user's authorization. Check `git status` and `git worktree list` immediately before cleanup. No force-remove, reset, implicit stash, branch deletion, common-object cleanup or deletion of a dirty/unknown worktree. If any check is unclear, retain it and report the exact reason.

## Useful regression cases

See [regression scenarios](regression-scenarios.md#worktree-ownership-and-work-packages) for independent simultaneous writers, shared-hunk conflicts, wrong-base refusal, path-targeting failure, foreign dirty files, local commits/no remote write, integration readback, retention and cleanup.
