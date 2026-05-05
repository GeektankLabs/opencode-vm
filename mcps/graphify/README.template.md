# Graphify — cross-repo knowledge graph

This folder is auto-managed by [OpenCode VM](https://github.com/rootzoll/opencode-vm)
when it detects an mcrepo (`mcrepo.yaml` at the workspace root). It contains a
queryable knowledge graph of all repositories in the mcrepo, built by
[graphify](https://github.com/safishamsi/graphify) (tree-sitter AST extraction).

## What's in here

**Committed (ships with the repo):**

- `GRAPH_REPORT.md` — human-readable summary: god-nodes, suggested questions,
  surprising cross-repo connections. Read this first.
- `graph.json` — the full graph used by AI agents via the graphify MCP server.
- `graph.html` — interactive browser visualization. Open it in a browser to
  pan/zoom the graph.
- `.gitignore` — keeps the local-only files below out of git.

**Local-only (gitignored, regenerated automatically):**

- `cache/` — incremental-build cache (tree-sitter parses + content hashes).
  Can grow to ~10,000 files on a medium codebase. Reproduced by
  `graphify watch`/`update` whenever needed; committing it would trade
  significant repo bloat for a marginal cold-start speedup, so we don't.
- `manifest.json` — mtime-tracking. Per graphify upstream, file mtimes are
  not preserved across `git clone`, so a committed manifest forces a full
  rebuild on every fresh checkout anyway. Better regenerated locally.

The repository-root `graphify-out` symlink points here — it exists because
graphify's CLI hardcodes `<project>/graphify-out/` as its output directory,
and the symlink redirects writes into this `docs/graphify/` folder so they
ship with the rest of the documentation.

## Why the small files are committed

mcrepo's whole point is that `docs/` is part of the repo. Committing
`graph.json` + `graph.html` + `GRAPH_REPORT.md` (typically a few MB total)
means:

- A fresh clone has a ready-to-use graph immediately — no rebuild from scratch.
- PR reviewers see structural changes in `GRAPH_REPORT.md` diffs (new
  god-nodes, new cross-repo edges).
- Agents on first session don't have to wait for the watcher's initial pass.

If even `graph.json` becomes noisy on a very active repo, you can extend
`.gitignore` to skip it too — `GRAPH_REPORT.md` alone is still enough to
make structural changes legible in PRs, and the watcher rebuilds `graph.json`
each session anyway.

## If you already committed the cache by accident

If a previous session committed `cache/` or `manifest.json` before this
`.gitignore` existed, untrack them (without deleting the local files —
they're still useful for the running watcher):

```sh
git rm -r --cached docs/graphify/cache docs/graphify/manifest.json
git commit -m "chore(graphify): untrack local-only build cache"
```

The next session's watcher will keep using the local cache; only git stops
tracking it.

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
