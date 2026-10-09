// Local MCP-app evidence: the assembled UI resource is loaded inside an iframe,
// a host page simulates the MCP Apps bridge (ui/* + tools/call over postMessage)
// and the same render kernel must show tasks, sessions, separated facts,
// freshness, honest errors and detail-on-open without any local URL assumption.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadControlAppHtml } from '../dist/tools.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const out = process.env.REPO_LIVE_ARTIFACT_DIR ?? '/tmp/opencode/repo-live-app';
await mkdir(out, { recursive: true });

const now = new Date().toISOString();
const session = {
  session_id: 'ses_1', title: 'Umsetzung Control-UI', parent_session_id: null, kind: 'root', archived: false,
  backend_activity: 'busy', pending_input: { permissions: 0, questions: 1, scope: 'session' },
  observed_at: now, last_activity_at: Date.now() - 60000,
  current_runtime: { provider_id: 'openai', model_id: 'gpt-6.1-sol', variant: 'high', source: 'session_setting' },
  turns: [{ user_message_id: 'msg_u1', state: 'running', active: true, finish: null, completed_at: null,
    runtime: { provider_id: 'openai', model_id: 'gpt-6.1-sol', variant: 'high', source: 'assistant_message', message_id: 'msg_a1' } }],
  turns_truncated: false, history_has_more: true,
  state: 'input_required', operational: true, freshness: 'fresh', binding_state: 'known', current_turn_unbound: false,
  associations: [{ task_id: 'task_A', session_id: 'ses_1', message_id: 'msg_u1', scope: 'message', source: 'board_link' }], anomaly: null,
};
const sources = () => ({
  sessions: { observed_at: now, last_success_at: now, complete: true, error: null, age_ms: 0, stale_after_ms: 15000, state: 'fresh' },
  discovery: { observed_at: now, last_success_at: now, complete: true, error: null, age_ms: 0, stale_after_ms: 45000, state: 'fresh' },
  board: { observed_at: now, last_success_at: now, complete: true, error: null, age_ms: 0, stale_after_ms: 45000, state: 'fresh' },
  activity: { observed_at: now, last_success_at: now, complete: false, error: 'READ_COVERAGE_INCOMPLETE', age_ms: 0, stale_after_ms: 15000, state: 'degraded' },
});
const overview = {
  schema_version: 1, project: { id: 'fixture', name: 'Fixture Repo' }, generation: 'generation-a', snapshot_id: 'generation-a:1',
  generated_at: now, sources: sources(),
  counts: { active_sessions: 1, known_active_sessions: 1, attention_sessions: 1, active_tasks: 1 },
  coverage: { sessions_complete: true, bindings_complete: true, recent_complete: false },
  capabilities: { all_session_scope: true, task_links: true, prepared_attention: true },
  attention: [{ session_id: 'ses_1', state: 'input_required', anomaly: null }],
  prepared_attention: { available: true, reason: null, total: 11, omitted: 1, coverage: 'paged',
    ordering: ['input_required', 'error_abort', 'ready_result'],
    entries: [
      { event_id: 'evt_input', source_revision: 'rev-a', classification: 'action_required', lifecycle: 'new',
        session_id: 'ses_1', task_id: 'task_A', master_task_id: null, work_package_id: null, hierarchy_status: 'resolved',
        occurred_at: now, observed_at: now, prepared_summary: 'Operatorentscheidung benötigt', next_safe_step: 'Entscheidung einholen',
        resolution: 'unverified', evidence_complete: false, superseded_by: null },
      { event_id: 'evt_ready', source_revision: 'rev-b', classification: 'ready', lifecycle: 'discussed',
        session_id: 'ses_1', task_id: null, master_task_id: null, work_package_id: null, hierarchy_status: 'unlinked',
        occurred_at: now, observed_at: now, prepared_summary: 'Ergebnis liegt vor', next_safe_step: 'Original prüfen',
        resolution: 'unverified', evidence_complete: true, superseded_by: null },
    ] },
  tasks: [{ task_id: 'task_A', title: 'Umbau nach Control-Prototyp', board_status: 'in_progress', board_project_id: 'ws',
    links: [{ session_id: 'ses_1', message_id: 'msg_u1' }] }],
  sessions: [session], unknown_sessions: [],
  recent: { epoch: 'e', recent: [{ event_id: 'e1', session_id: 'ses_1', message_id: 'msg_u1', type: 'session.input_required', timestamp: now }] },
  service: { kind: 'mcp-app', generation: 'generation-a', adapterVersion: '0.1.32' }, truncation: null,
};

const appHtml = await loadControlAppHtml();
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Host</title></head><body>
<iframe id="app" src="/app.html" style="width:100%;height:900px;border:0"></iframe>
<script>
window.hostLog = [];
window.hostFail = false;
window.overview = ${JSON.stringify(overview)};
window.detail = { found: true, service: { kind: 'mcp-app', generation: 'generation-a', adapterVersion: '0.1.32' },
  observed_at: new Date().toISOString(), session: window.overview.sessions[0],
  recent: [{ event_id: 'e2', session_id: 'ses_1', message_id: 'msg_u1', type: 'message.completed', timestamp: new Date().toISOString() }] };
window.addEventListener('message', event => {
  const app = document.getElementById('app');
  if (event.source !== app.contentWindow) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  const reply = result => app.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
  if (message.method === 'ui/initialize') { window.hostLog.push('initialize'); reply({ protocolVersion: '2026-01-26' }); return; }
  if (message.method !== 'tools/call') return;
  window.hostLog.push('call:' + message.params.name);
  if (window.hostFail) {
    reply({ isError: true, _meta: { 'opencode-vm/error': { code: 'BACKEND_UNAVAILABLE', message: 'Quelle nicht erreichbar.' } },
      content: [{ type: 'text', text: 'BACKEND_UNAVAILABLE' }] });
    return;
  }
  if (message.params.name === 'refresh_repo_live' || message.params.name === 'open_repo_live')
    reply({ structuredContent: structuredClone(window.overview), content: [{ type: 'text', text: 'ok' }] });
  else if (message.params.name === 'get_repo_live_session')
    reply({ structuredContent: structuredClone(window.detail), content: [{ type: 'text', text: 'ok' }] });
  else
    reply({ isError: true, content: [{ type: 'text', text: 'unknown tool' }] });
});
window.pushTitle = title => {
  window.overview.sessions[0].title = title;
  document.getElementById('app').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result',
    params: { structuredContent: structuredClone(window.overview) } }, '*');
};
</script></body></html>`;

const server = createServer((request, response) => {
  if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(hostHtml); return; }
  if (request.url === '/app.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(appHtml); return; }
  response.writeHead(404).end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url);
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'iframe loaded');
  await frame.waitForSelector('.session', { timeout: 10000 });

  const title = await frame.textContent('#project');
  assert.ok(title.includes('Fixture Repo'));
  assert.equal(await frame.textContent('article h2'), 'Umbau nach Control-Prototyp');
  assert.equal(await frame.getAttribute('.status', 'data-state'), 'input_required');
  const facts = await frame.evaluate(() => Object.fromEntries([...document.querySelectorAll('.fact')].map(item => [item.dataset.fact, item.textContent])));
  assert.ok(facts.qc.includes('unbekannt'));
  assert.ok(facts.integration.includes('unbekannt'));
  assert.ok(facts.service.includes('mcp-app') && facts.service.includes('0.1.32'));
  assert.ok(facts.sessions.includes('1 aktiv'));
  assert.ok(facts.turn.includes('kein belegter Abschluss'));
  assert.equal(await frame.locator('.session a').count(), 0, 'no local URL anchors in the MCP app');
  assert.ok((await frame.textContent('#truncation')).length >= 0);
  const preparedText = await frame.textContent('#prepared-attention');
  assert.ok(preparedText.includes('Input erforderlich'), preparedText);
  assert.ok(preparedText.includes('zur Prüfung unverifiziert'), 'discussed/ready is never shown as resolved');
  assert.ok(preparedText.includes('diskutiert'), 'the discussed lifecycle is surfaced distinctly');
  assert.ok(preparedText.includes('unverknüpft'), 'an unlinked taskless entry stays honestly unlinked');
  assert.ok(preparedText.includes('ausgelassen'), 'the omitted count is surfaced for a paged queue');
  assert.ok(preparedText.includes('Reihenfolge'), 'the ordering is surfaced');

  // Refresh: visible loading/success feedback and a second host roundtrip.
  await frame.click('#refresh');
  await frame.waitForFunction(() => document.getElementById('status-line').textContent.includes('Abruf abgeschlossen'));
  const afterRefresh = await page.evaluate(() => window.hostLog.filter(entry => entry === 'call:refresh_repo_live').length);
  assert.ok(afterRefresh >= 2, String(afterRefresh));

  // Details on open: fresh adapter call with newest-first metadata events.
  await frame.click('.session-detail summary');
  await frame.waitForFunction(() => document.querySelector('.detail-body')?.textContent.includes('Turnbelege'));
  const detailText = await frame.textContent('.detail-body');
  assert.ok(detailText.includes('Einstellung (aktuell)'));
  assert.ok(detailText.includes('Turn abgeschlossen ≠ Taskabnahme'));
  const detailCalls = await page.evaluate(() => window.hostLog.filter(entry => entry === 'call:get_repo_live_session').length);
  assert.equal(detailCalls, 1);

  // Host push path: ui/notifications/tool-result updates the shared renderer.
  await page.evaluate(() => window.pushTitle('Umsetzung Control-UI (Push aktualisiert)'));
  await frame.waitForFunction(() => document.querySelector('.title')?.textContent.includes('Push aktualisiert'));

  // W3-F2: an unavailable prepared-attention source shows the reason honestly
  // and keeps the last-known entries as stale data (no empty-list pretence).
  await page.evaluate(() => {
    window.overview.prepared_attention = { available: false, reason: 'ACTIVITY_DISABLED', coverage: 'unavailable',
      ordering: ['input_required', 'error_abort', 'ready_result'], total: 1, omitted: null,
      entries: window.overview.prepared_attention.entries.slice(0, 1) };
    document.getElementById('app').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result',
      params: { structuredContent: structuredClone(window.overview) } }, '*');
  });
  await frame.waitForFunction(() => document.getElementById('prepared-attention')?.textContent.includes('ACTIVITY_DISABLED'));
  const unavailableText = await frame.textContent('#prepared-attention');
  assert.ok(unavailableText.includes('nicht verfügbar'), unavailableText);
  assert.ok(unavailableText.includes('Letzter bekannter Stand, nicht frisch: 1'), unavailableText);

  // Failure path: no empty-list pretence, previous stand stays visible.
  await page.evaluate(() => { window.hostFail = true; });
  await frame.click('#refresh');
  await frame.waitForFunction(() => document.getElementById('status-line').textContent.includes('fehlgeschlagen'));
  assert.ok((await frame.textContent('#error')).includes('BACKEND_UNAVAILABLE'));
  assert.ok(await frame.$('.session'), 'previous stand stays visible after a failed refresh');

  const layouts = [];
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const info = await frame.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      touch: [...document.querySelectorAll('button,a,summary')].filter(x => x.getBoundingClientRect().height > 0)
        .every(x => x.getBoundingClientRect().height >= 44),
      runtimeRows: [...document.querySelectorAll('.session')].every(s => s.querySelectorAll('.runtime').length === 1) }));
    assert.ok(info.scroll <= width, JSON.stringify(info));
    assert.ok(info.touch, JSON.stringify(info));
    assert.ok(info.runtimeRows);
    layouts.push(info);
    await page.screenshot({ path: resolve(out, `app-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(out, 'app-observations.json'), JSON.stringify({ method: 'assembled MCP-app resource in an iframe with a simulated MCP Apps host bridge over postMessage (plain HTTP fixture)',
    hostLog: await page.evaluate(() => window.hostLog), layouts, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, hostLog: await page.evaluate(() => window.hostLog), layouts, artifact_dir: out }));
} finally {
  if (browser) await browser.close();
  server.close();
  server.closeAllConnections?.();
}