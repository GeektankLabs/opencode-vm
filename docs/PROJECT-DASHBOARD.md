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

## Read contract

- `GET /healthz`: owned project/generation/readOnly/readiness, authenticated.
- `GET /api/v1/status`: bounded detail view from one volatile collector.
- `GET /api/v1/status?view=summary`: same snapshot/counts/freshness, no session
  histories. A later global page may consume this without global discovery now.
- Unsupported methods: 405; invalid view/selectors: 400; missing/wrong existing
  webauth: 401; foreign routes: 404; invalid Host/Origin: 403. No CORS, generic
  proxy, task selector, URL input, prompt, permission or retry endpoint.
- No prompts, descriptions, raw workspace paths, provider errors or credentials
  in status responses. Unknown counts are null, not zero. Unknown session reads
  retain admitted identity rows separately. Responses are capped at 512 KiB.

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
archive, reusing its SDK/domain readers. `--no-mcp` still permits this internal
read producer; it does not create an MCP listener/token or broaden public MCP
child/manager/history exposure. Only an owned transient service is stopped,
under a bounded cleanup lock and matching generation/description.

Private checks: `node --test dist/dashboard*.test.js`,
`python3 -B tests/dashboard_lifecycle_test.py`; browser fixture:
`PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node tests/dashboard-browser.mjs`
in `adapters/mcp`. Artifacts default to `/tmp/opencode/wc-browser`, generated
fixture certificates are test-only. Source mutation times are paired with actual
production-UI status/runtime renders in the following painted frame (DOM
observation plus double requestAnimationFrame), not producer polling constants.
Independent QC, integration and all external acceptance remain separate gates.
