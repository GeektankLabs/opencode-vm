## graphify (mcrepo cross-repo knowledge-graph)

This workspace is an **mcrepo** (multi-context repository) — multiple Git
repositories living side-by-side at the project root, listed in `mcrepo.yaml`.
For repo-overview and code-navigation work, **prefer graphify over reading
files blindly**: it sees connections that span repository boundaries, which
no per-repo tool can.

The graph is **already built and continuously watched** for this session:
- Live graph file: `{GRAPH_PATH}` (committed inside the workspace's docs folder).
- Human-readable summary: `GRAPH_REPORT.md` next to it — read this first for
  god-nodes, suggested questions, and surprising cross-repo connections.
- A background `graphify watch` process keeps the graph in sync as files
  change during the session — you do **not** need to run `graphify update`
  or `graphify <build-cmd>` yourself.

Available MCP tools (read-only): `query_graph`, `get_node`, `get_neighbors`,
`get_community`, `god_nodes`, `graph_stats`, `shortest_path`. Use them when
you need to:
- Find which child repos depend on a given concept (`get_neighbors`).
- See the overall mcrepo structure before diving in (`god_nodes`, `graph_stats`).
- Trace how a refactor in one repo could ripple into others (`shortest_path`).

If `graph_stats` returns "no graph yet", the watcher is still on its first
pass — wait a few seconds and retry. If it stays empty, check the watcher log
inside the session VM at `~/.opencode-vm/share/<session>/graphify-watch.log`.
