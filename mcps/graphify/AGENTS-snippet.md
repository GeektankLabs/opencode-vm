## graphify (code knowledge-graph MCP)

A read-only code-graph MCP is available with cross-file relationship tools:
`query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`,
`graph_stats`, `shortest_path`. The graph lives at `{GRAPH_PATH}` on the
session VM's guest disk (the project's `.graphify-out` symlink points there).
It is not committed and not copied to the host: it is regenerable and may
vanish with the VM disk.

If `graph_stats` returns "no graph" or the MCP fails with a "no graph" message,
the graph hasn't been built for this project yet. Build it from the project root:

  graphify --help              # discover the actual build subcommand/flags
  graphify <build-cmd>         # code-only build is fast and uses NO LLM

The build writes through `.graphify-out` to `{GRAPH_PATH}`; the MCP server
reads the same file. If the graph was lost (e.g. after a VM reset), just
rebuild it — no backup/restore step exists or is needed.

Semantic enrichment of non-code content (docs, papers, images) is opt-in via
the `/graphify` skill workflow. That work uses your already-configured opencode
provider (LM Studio / Ollama / cloud) — graphify does not require any separate
API key. If you want to enrich images, ensure a vision-capable model is loaded
in your provider (run `opencode-vm provider refresh <name>` to pick up newly
loaded local models).
