# Repo Live dashboard

The project Web lifecycle starts an independent **guest-resident Node HTTPS**
dashboard on **P+6**, using the existing eight-port forwarding block. P+6 and
the Agent Control Hub at P+7 are **LAN-bound** like the rest of the block
(explicitly trusted LAN, independent of the auth choice); their guest
listeners stay loopback-bound. Terminal-only mode
starts neither dashboard nor additional web listeners. Dashboard failure is
nonfatal to OpenCode workers. No live cutover is implied by this source change.

The **Repo Live** launcher entry is enabled only after project/generation-bound
authenticated HTTPS health verifies the staged descriptor. Startup reuses the
session's self-signed leaf and web Basic-auth choice. An explicit existing
no-auth choice is preserved; missing auth or TLS material does not silently
disable protection. Client trust remains an operator decision. Local responsive
fixtures are not real Safari, Phone, Voice, Lima or host-forward acceptance.

## One UI, two transports

`adapters/mcp/dashboard/{index.html,styles.css,app.js}` is the single Control
view source. The browser service serves it as static files; the MCP adapter
assembles the byte-identical files into one inline `ui://repo-live/v1.html`
resource (`text/html;profile=mcp-app`) and renders it with the `open_repo_live`
tool (`_meta.ui.resourceUri`, declared `openai/ui` entrypoints `global` and
`thread`; real ChatGPT sidebar/panel availability stays unverified). The page
renders from one snapshot shape and only its host shim differs:

- Browser: `fetch("/api/v1/status")`, producer-aligned polling, local session
  and Board links.
- MCP app: `tools/call` over the MCP Apps host bridge (`refresh_repo_live`,
  `get_repo_live_session`), no local URL fetch and no anchor assumption. The
  adapter keeps one lazy collector (first read, then at most every 2s) so an
  unused session does not poll the backend.

The **Arbeitslage** panel keeps facts separate: Board status, backend sessions,
correlated turn completions, QC findings, main integration and the serving
process. QC/integration/installed have no canonical live source here and are
shown as unknown; turn completion is never promoted to a verdict. Detail panes
load fresh when opened (newest metadata events first) and show explicit
loading, error and retry states; a failed refresh keeps the last known stand.

## Read contract

- `GET /healthz`: owned project/generation/readOnly/readiness, authenticated.
- `GET /api/v1/status`: bounded detail view from one volatile collector, plus an
  additive `service {kind,generation,adapterVersion}` field.
- `GET /api/v1/status?view=summary`: same snapshot/counts/freshness, no session
  histories. A later global page may consume this without global discovery now.
- Unsupported methods: 405; invalid view/selectors: 400; missing/wrong existing
  webauth: 401; foreign routes: 404; invalid Host/Origin: 403. No CORS, generic
  proxy, task selector, URL input, prompt, permission or retry endpoint.
- No prompts, descriptions, raw workspace paths, provider errors or credentials
  in status responses. Unknown counts are null, not zero. Unknown session reads
  retain admitted identity rows separately. Responses are capped at 512 KiB.

The MCP app path returns the same snapshot shape as a bounded projection under
the structured read budget (`READ_PAYLOAD_BYTES - 4096` target, 48 KiB payload
ceiling); omitted rows are counted in `truncation {sessions,tasks,
unknown_sessions,recent,reason:"READ_RESPONSE_BUDGET"}`. Unknown session ids
return `SESSION_NOT_FOUND`; all three Repo Live tools are `readOnlyHint:true`.

Session/turn/Board states are independent. Unique session IDs determine counts,
including manual sessions, children and managers. Explicit Board associations
form task-first groups; multiple references never multiply global counts.
Child inheritance is labelled indirect. Unknown bindings are not “without Task”.
Idle parents cannot hide busy children, and active archived rows remain anomalies.
Current setting and evidenced assistant-message runtime have one small grey line;
missing historical variant stays unknown, never inferred from today's setting.
Older active/unresolved turns in the bounded message window are retained even
when five newer turns exist; an idle backend with such evidence is unknown,
not misleadingly idle. Omitted terminal history is explicitly labelled bounded.

Collection: sessions 5s; discovery and Board 15s; 200 sessions, 500 tickets and
50 active sessions are the supported read budget. Incomplete/gapped/error reads
are degraded. Age >15s for session observations / >45s for Board is stale.
Serving cached data never resets source observation time. Visible browser polls
align just after the 5s producer boundary; hidden tabs use 30s and refresh on focus.
Generation revocation clears live claims. There is no persistent dashboard DB,
history copy, queue or extra backend event subscription.

## Navigation / packaging / verification

The observed OpenCode 1.18.34 server-key/session route is used only when that
installed version is recorded; unknown versions link to the OpenCode entry and
say the route is unverified. Board links are the existing HTTP Board entry,
not invented ticket routes or a claim that the Board gained HTTPS/auth.
The old operator “Überblick” reference remains UNVERIFIED and is not a blocker
for this data MVP.

Dashboard modules and static UI are distributed in the pinned MCP adapter
archive, reusing its SDK/domain readers — including the MCP app resource and
its tools, which read the same collector. `--no-mcp` still permits this internal
read producer; it does not create an MCP listener/token or broaden public MCP
child/manager/history exposure. Only an owned transient service is stopped,
under a bounded cleanup lock and matching generation/description.

The dashboard/browser check collection (`dist/*.test.js`, `tests/dashboard_*`,
`adapters/mcp/tests/dashboard-browser*`, `adapters/mcp/tests/repo-live-app-browser.mjs`)
was removed with the repository's test apparatus; automated delivery is build,
packaging and release publication (`docs/RELEASING.md`). Source mutation times
remain paired with actual production-UI status/runtime renders in the following
painted frame (DOM observation plus double requestAnimationFrame), not producer
polling constants. Independent QC, integration and all external acceptance
remain separate gates.
