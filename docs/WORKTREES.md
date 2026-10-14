# Worktree locations and cleanup

## Where they live

Task checkouts can live in two places:

**Legacy host-share location** (current default for existing sessions):

```text
<project>/.opencode-vm/worktrees/<task-name>/
```

**Guest-native location** (recommended for new worktrees):

```text
<guest-worktree-root>/<proj-hash>/<sessionId>/
```

Where `<guest-worktree-root>` is the base configured via `OCVM_WORKTREE_ROOT`
(or derived from guest home), `<proj-hash>` is the project hash, and
`<sessionId>` is the OpenCode session identifier. The checkout is created
automatically by the adapter's `createGuestWorktree` when `OCVM_WORKTREE_ROOT`
is set.

The guest root defaults to `/home/lima.guest/.opencode-vm/worktrees` inside
the VM and is configurable via `OCVM_WORKTREE_ROOT`. Use
`ocvm_worktree_root <project-dir>` to resolve it; the function validates that
the base is on a guest-native filesystem (ext4) and refuses to fall back
silently to a host path. Use `ocvm_worktree_path <project-dir> <task-id>` for
the full checkout path.

Guest-native worktrees keep all source, dependency, build and scratch data on
the guest disk, offloading the virtiofs share. Git common directory, refs and
per-worktree metadata (`.git/worktrees/<name>/`) remain on the host — this is
deliberate; see "Git metadata" below.

For this repository the legacy location is
`/Users/admin/Documents/github/opencode-vm/.opencode-vm/worktrees/`.
`.opencode-vm/` is Git-ignored, so these checkout directories are not uploaded
to GitHub. Their commits/branches are Git history; pushing a branch is separate
from storing its working copy. Linked worktrees share the Git object database,
but have separate source files and often separate dependency/build directories.

`.opencode/tasks/` contains canonical task contexts, not worktrees.
Other `.opencode-vm` directories (Taskboard, Monitor, MCP, model policy) are
project state and are not part of worktree cleanup.

## Git metadata

Per-worktree private metadata (`HEAD`, `index`, `locks`, `logs`) lives in
`$GIT_COMMON_DIR/worktrees/<name>/` on the host. Git 2.43.0 does **not**
support `git worktree add --separate-git-dir`; metadata cannot be relocated
to the guest disk through a supported mechanism. Do not manually move
`.git/worktrees/` entries — it breaks `git worktree repair` and `prune`.

## Mount resolution

To verify a path is on guest-native disk (not a virtiofs share):

```bash
stat -f -c %T /path/to/check   # Linux: ext2/ext3 = guest, fuseblk = virtiofs
```

## Automatic cleanup on genuinely fresh session starts

Since script 0.7.24, every fresh project-session start runs a host-side sweep
before VM cloning/mounting. If replacing an existing session, owned-runtime
finalization and history capture must succeed first. Reconnect, attach and
cancellation do not trigger cleanup.

**A fresh project VM is the explicitly authorized disposal boundary.** The
sweep removes all registered immediate children of the project's
`.opencode-vm/worktrees/`, including unmerged, dirty, untracked, ignored and
locked working copies. It uses scoped `git worktree remove --force --force`;
there is no clean/integrated filter or age threshold. Work needed after the
boundary must already be committed on a branch or saved elsewhere. A Git
worktree lock does not exempt a task checkout from this fresh-start policy.

Existing source branches are never deleted, so unmerged commits remain
available. For a detached source, the sweep first creates/reuses a local
`ocvm-retained/worktree-<full-commit>` branch, never replacing a conflicting
reference. Main/the current project root, canonical `.opencode/tasks`, Taskboard,
MCP, Monitor, model policy and checkouts elsewhere are outside the sweep.
Moved/symlinked or unverifiable paths are reported rather than guessed; failures
do not cause optional cleanup to hard-abort normal startup. No global prune or
Git object garbage collection is performed. The sweep only probes Git metadata,
not every dependency file, before Git removes each selected directory.

Uncommitted/untracked/ignored work in Main or other directories outside the
selected registered task checkouts is preserved. Even unregistered sibling
directories under the worktrees folder are not swept. Branches contain commits,
not uncommitted working-copy data. This cleanup never uses `git clean`, `reset`,
stash deletion or branch deletion to erase those other working states.

Guest-native worktree registrations (checkout paths outside the project root)
whose directories no longer exist — typically because the guest VM was
replaced — are pruned: their `$GIT_COMMON_DIR/worktrees/<name>/` admin
directory is removed. Live guest worktrees (path still present) are left alone.

The integrator must make a cleanup decision at each integration handback. It
should remove a completed disposable source checkout after verified integration
and owner stop, or record why it is retained until the next fresh VM. Ordinary
integration cleanup remains scoped and preserves needed changes; the explicit
loss authorization applies to the fresh-VM boundary, not arbitrary live work.

Deleting a checkout reduces future VirtioFS traversal/dependency duplication.
It does not prove that a running virtualization helper releases already cached
handles immediately. The fresh-start policy deliberately discards unpublished
working-copy data; it does not implicitly integrate any task or mark it Done.

## One-time manual bulk disposal (Mac host terminal)

For the operator-authorized loss cleanup, run this from the repository checkout:

```bash
cd "$(git rev-parse --show-toplevel)"
pwd
git branch --show-current
git worktree list

ROOT="$(git rev-parse --show-toplevel)"
git -c core.quotePath=false worktree list --porcelain |
while IFS= read -r line; do
  case "$line" in
    "worktree $ROOT/.opencode-vm/worktrees/"*)
      WT="${line#worktree }"
      printf 'Entferne: %s\n' "$WT"
      git worktree remove --force --force "$WT" || break
      ;;
  esac
done

git worktree list
git branch --list
ls -la ".opencode-vm/worktrees"
```

This discards local changes and ignored outputs even in locked worktrees. The
Main checkout and existing branch refs remain. If a detached commit must be
retained, first create a branch for it with `git branch <new-name> <commit>`;
the automated fresh-start sweep handles that retention itself. A raw
`rm -r .opencode-vm/worktrees/` leaves registrations behind and is not the
documented removal method. A Git error stops the loop for inspection.

VM-local `/tmp` records can refer to paths not visible on the Mac. They are not
this host folder; preserve relevant detached source references before using
`git worktree prune --dry-run` to inspect obsolete registrations.

## Ordinary single-worktree cleanup outside the disposal boundary

1. Go to the repository root. If currently in `.opencode-vm`, use `cd ..`.
   Verify the location and inspect registered checkouts:

   ```bash
   pwd
   git rev-parse --show-toplevel
   git worktree list
   ```

2. Set `WT` to one **exact path from that list**, not the whole worktrees folder:

   ```bash
   WT="$PWD/.opencode-vm/worktrees/<task-name-from-the-list>"
   ```

3. Verify the checkout's source, branch, changes and ignored outputs. Its owner
   must have stopped using it; preserve any required report/output before removal:

   ```bash
   git -C "$WT" rev-parse HEAD
   git -C "$WT" branch --show-current
   git -C "$WT" status --short --untracked-files=normal --ignored=matching
   git worktree list --porcelain
   ```

   Dirty/untracked files must be committed on their own branch or separately
   saved first. A detached source needs a durable reference before its only
   worktree is removed. A locked checkout is intentionally retained.

4. Check that the source commit is integrated into the repository HEAD:

   ```bash
   SOURCE=$(git -C "$WT" rev-parse HEAD)
   git merge-base --is-ancestor "$SOURCE" HEAD
   ```

   Exit 0 means integrated; exit 1 means it is not integrated. The mere absence
   of dirty files does not establish task completion. Retain unintegrated or
   still-needed work unless its disposition is explicitly settled.

5. Remove the selected completed checkout through Git:

   ```bash
   git worktree remove "$WT"
   ```

   This removes its files **and** registration. Outside the expressly authorized
   disposal boundary, if Git refuses, resolve the reason rather than appending
   `--force` or substituting recursive folder deletion.
   `rm -r .opencode-vm/worktrees/` bypasses these checks and removes all task
   directories together, including unfinished work, while leaving registrations.

6. Verify the result:

   ```bash
   git worktree list
   git branch --list
   ```

   The directory/registration should be gone and the source branch still present.
   Branch deletion is a separate action and does not free checkout/dependency files.

If files were already removed manually, retain source references before repairing
registrations. `git worktree prune --dry-run` previews missing-directory records;
it is not a command that removes existing worktree directories.
