## Codebase Structure Maps (MCP: `repomapper`)

RepoMapper MCP is available for generating ranked structural overviews of codebases. Use it when:
- First exploring a large or unfamiliar codebase to understand its architecture
- You need to identify the most important/interconnected files before diving in
- You want symbol-aware code search (definitions vs references)

**Tools:**
- `repo_map` — generates a PageRank-ranked map of the codebase, showing the most important files and their key symbols. Pass `project_root` (absolute path) and optionally `token_limit` (default 8192).
- `search_identifiers` — searches for code identifiers across the codebase with context. Returns definitions and references with file locations and line numbers.

Pre-installed at: `~/.local/share/repomapper/`
