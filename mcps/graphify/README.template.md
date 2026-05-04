# Graphify — cross-repo knowledge graph

This folder is auto-managed by [OpenCode VM](https://github.com/rootzoll/opencode-vm)
when it detects an mcrepo (`mcrepo.yaml` at the workspace root). It contains a
queryable knowledge graph of all repositories in the mcrepo, built by
[graphify](https://github.com/safishamsi/graphify) (tree-sitter AST extraction).

## What's in here

- `GRAPH_REPORT.md` — human-readable summary: god-nodes, suggested questions,
  surprising cross-repo connections. Read this first.
- `graph.json` — the full graph used by AI agents via the graphify MCP server.
- `graph.html` — interactive browser visualization. Open it in a browser to
  pan/zoom the graph.
- `cache/` — incremental-build cache used by `graphify watch`/`update` so
  rebuilds are fast. Safe to delete; will be recreated.

The repository-root `graphify-out` symlink points here — it exists because
graphify's CLI hardcodes `<project>/graphify-out/` as its output directory,
and the symlink redirects writes into this `docs/graphify/` folder so they
ship with the rest of the documentation.

## Why these files are committed

mcrepo's whole point is that `docs/` is part of the repo. Committing the
graph means:

- A fresh clone of the mcrepo on another machine has a ready-to-use graph
  immediately — no rebuild from scratch.
- PR reviewers see structural changes in `GRAPH_REPORT.md` diffs (new
  god-nodes, new cross-repo edges).
- Agents on first session don't have to wait for the watcher's initial pass.

If diff noise on `graph.json` becomes a problem, you can `.gitignore` it and
keep just `GRAPH_REPORT.md` tracked. The watcher will rebuild `graph.json`
each session.

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
