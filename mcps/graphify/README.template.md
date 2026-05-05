# Graphify — cross-repo knowledge graph

This folder is auto-managed by [OpenCode VM](https://github.com/rootzoll/opencode-vm)
when it detects an mcrepo (`mcrepo.yaml` at the workspace root). It contains a
queryable knowledge graph of all repositories in the mcrepo, built by
[graphify](https://github.com/safishamsi/graphify) (tree-sitter AST extraction).

## What's in here

**Committed (ships with the repo):**

- `GRAPH_REPORT.md` — human-readable summary: god-nodes, suggested questions,
  surprising cross-repo connections. Diff-able in PRs. Typically <1 MB.
- `README.md` — explains this folder's purpose.
- `.gitignore` — keeps the local-only files below out of git.

**Local-only, regenerated each session (gitignored):**

- `cache/` — incremental-build cache (tree-sitter parses + content hashes).
  Easily 10,000+ files on medium codebases — VSCode warns "too many active
  changes" if these get tracked. Rebuilt automatically by `graphify watch`.
- `manifest.json` — file-mtime tracking. Per graphify upstream, mtimes don't
  survive `git clone`, so committing it forces full rebuilds anyway.
- `graph.json` — the queryable graph the MCP server reads. **Real-world
  mcrepos produce graphs over 100 MB**, which exceeds GitHub's hard
  per-file cap. Rebuilt each `opencode-vm` session by the in-VM watcher.
- `graph.html` — interactive visualization. Same rebuild-on-session story.

The repository-root `graphify-out` symlink points here — it exists because
graphify's CLI hardcodes `<project>/graphify-out/` as its output directory,
and the symlink redirects writes into this `docs/graphify/` folder so they
ship with the rest of the documentation.

## Why this policy

mcrepo's `docs/` is part of the repo, but graphify's full output is too
heavyweight to commit safely. The compromise:

- **`GRAPH_REPORT.md` is committed** — small, human-readable, diff-able. PR
  reviewers see new god-nodes and new cross-repo connections at a glance.
- **`graph.json` is rebuilt every session** — `graphify watch` runs in the
  session VM the moment you start `opencode-vm`. Within seconds the agent
  has a fresh graph; you don't wait for it.
- **No git bloat, no GitHub size limits hit, no VSCode warnings.**

If your codebase is small enough that `graph.json` is comfortably under
~25 MB, you can opt back in by removing `graph.json` from this `.gitignore`
— a fresh clone will then be query-ready instantly without waiting for the
watcher's first pass.

## If you already committed the cache by accident

If a previous session created `cache/`, `manifest.json`, `graph.json` or
`graph.html` before this `.gitignore` existed, untrack them (without deleting
the local files — they're still useful for the running watcher):

```sh
git rm -r --cached "docs/graphify/cache" "docs/graphify/manifest.json" \
                   "docs/graphify/graph.json" "docs/graphify/graph.html"
git add docs/graphify/.gitignore docs/graphify/README.md docs/graphify/GRAPH_REPORT.md
git commit -m "chore(graphify): apply gitignore policy, untrack heavy artifacts"
```

(Adjust the path prefix if your mcrepo uses the emoji-prefixed `🧾 docs/`.)

## How updates happen

While an OpenCode VM session is running:

- `graphify watch` runs as a background process inside the session VM and
  rebuilds the graph as you edit files. You don't need to do anything.
- The watcher log is at `~/.opencode-vm/share/<session-id>/graphify-watch.log`
  on the host — useful when troubleshooting.

Between sessions (so commits from outside OpenCode VM also keep the graph
fresh), you can install graphify on your **host** and let its post-commit
hook update the graph automatically:

```sh
pipx install graphifyy
graphify hook install     # in the mcrepo workspace
```

This is opt-in — without it, the graph is rebuilt each time you start an
OpenCode VM session.

## Manual rebuild

From inside an OpenCode VM session:

```sh
graphify update "$(pwd)"   # incremental, code-only, fast
```

Or in a fresh terminal on the host (if you installed graphify on the host):

```sh
cd <mcrepo-workspace> && graphify update .
```
