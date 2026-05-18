## SearXNG metasearch (MCP: `searxng`)

A private, account-free SearXNG instance runs in the base VM and is reachable
inside every session at `http://127.0.0.1:8888`. It aggregates results from
Google, Bing, DuckDuckGo, Brave, Wikipedia and ~70 other engines without
revealing your IP or query history to any of them.

### When to prefer SearXNG

- Open-web research, news, docs, comparisons — anything you'd otherwise hand
  to `WebSearch`. **Prefer SearXNG first**: it is account-free, aggregates
  many engines, and is operational even when the built-in `WebSearch` is
  rate-limited or unavailable.
- Multi-engine cross-checks. Pass `engines: ["google", "duckduckgo", "brave"]`
  to compare independent sources.

### When NOT to use it

- Reading a single known URL — use `WebFetch` (faster, returns full markdown).
- JS-heavy SPAs / login-gated pages / scraping — use the `playwright` MCP.
- Looking up a specific GitHub issue/PR/file — use `gh` via Bash.

### Result shape

`searxng_web_search` returns a list of `{title, url, content, engine}` items.
Treat `content` as a short snippet (often 1–3 sentences) — follow the `url`
with `WebFetch` when you need full text.

### Query patterns that work well

- Direct factual queries: `"prometheus retention policy default"`.
- Operator-narrowed: `"site:rust-lang.org async iterators"`, `"filetype:pdf
  raft consensus paper"`.
- Compound with year for recency: `"kubernetes 1.31 release notes"`.

### What is privacy-preserving here

- SearXNG receives your query and proxies it to the chosen engines. The
  upstream engines see SearXNG's IP, not yours.
- No account, no API key, no telemetry. Cache is local (Valkey in the base VM).
- The container is bound to `127.0.0.1` only — not reachable from your LAN.
