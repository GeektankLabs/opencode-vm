import assert from "node:assert/strict";
import test from "node:test";
import { DashboardCollector, boundedUiProjection } from "./dashboard.js";
import type { DashboardControl, DashboardReader, Inventory, Session, Tasks } from "./dashboard.js";
import { READ_PAYLOAD_BYTES, jsonBytes } from "./content.js";
import { createMcpServer, loadControlAppHtml, REPO_LIVE_UI_MIME, REPO_LIVE_UI_URI } from "./tools.js";
import type { SessionGateway } from "./opencode.js";

function fixture(count = 3) {
  let time = 100000;
  const native = (id: string): Inventory["sessions"][number] => ({ id, title: `Title ${id}`, projectID: "native",
    time: { created: 1, updated: 2 }, location: { directory: "/project" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  const inventory = { sessions: Array.from({ length: count }, (_, index) => native(`ses_${index}`)),
    complete: true, observed_at: new Date(time).toISOString() };
  const row = (id: string): Session => ({ session_id: id, title: `Title ${id}`, parent_session_id: null, kind: "root",
    archived: false, backend_activity: id === "ses_0" ? "busy" : "idle",
    pending_input: { permissions: 0, questions: 0, scope: "session" }, observed_at: new Date(time).toISOString(),
    last_activity_at: time, current_runtime: { provider_id: "new", model_id: "setting", variant: "medium", source: "session_setting" },
    turns: id === "ses_0" ? [{ user_message_id: "msg_new", state: "running", active: true, finish: null, completed_at: null,
      runtime: { provider_id: "old", model_id: "used", variant: "high", source: "assistant_message", message_id: "assistant" } }] : [],
    turns_truncated: false, history_has_more: false });
  const tasks: Tasks = [{ task_id: "task_A", title: "Task A", board_status: "in_progress", board_project_id: "workstream",
    links: [{ session_id: "ses_0", message_id: "msg_new" }] }];
  let sessionFail = false;
  const reader: DashboardReader = {
    inventory: async () => inventory,
    session: async item => { if (sessionFail) throw new Error("unavailable"); return { ...row(item.id), observed_at: new Date(time).toISOString() }; },
    board: async () => tasks,
    activity: async ids => ({ epoch: "epoch", recent: [...ids].slice(0, 2).map((id, index) => ({ event_id: `e${index}`,
      session_id: id, message_id: null, type: "message.completed", timestamp: new Date(time).toISOString() })) }),
  };
  const collector = new DashboardCollector({ id: "project", name: "Test" }, "generation", reader, () => time);
  return { collector, reader, inventory, tasks, advance: (delta: number) => { time += delta; }, failSession: () => { sessionFail = true; } };
}

test("Repo Live projection keeps evidence separate, injects the serving process and stays under the read budget", async () => {
  const probe = fixture();
  await probe.collector.tick();
  const snapshot = probe.collector.snapshot(false);
  assert.ok("sessions" in snapshot);
  const projection = boundedUiProjection(snapshot, { kind: "mcp-app", generation: "generation", adapterVersion: "0.1.32" });
  assert.deepEqual(projection.service, { kind: "mcp-app", generation: "generation", adapterVersion: "0.1.32" });
  assert.equal(projection.truncation, null);
  assert.ok(projection.sessions.length === 3);
  assert.equal(projection.sessions[0]?.session_id, "ses_0", "operational rows stay first");
  assert.equal(projection.counts.active_sessions, 1);
  assert.equal(projection.sessions[0]?.current_runtime?.model_id, "setting");
  assert.equal(projection.sessions[0]?.turns[0]?.runtime?.model_id, "used");
  assert.ok(!("qc" in projection) && !("verdict" in projection));
  assert.ok(jsonBytes(projection) <= READ_PAYLOAD_BYTES);
});

test("Repo Live projection trims by priority with explicit omission counts instead of silently cutting", async () => {
  const large = fixture(200);
  await large.collector.tick();
  const snapshot = large.collector.snapshot(false);
  assert.ok("sessions" in snapshot);
  const projection = boundedUiProjection(snapshot, { kind: "mcp-app", generation: "generation" });
  assert.ok(jsonBytes(projection) <= READ_PAYLOAD_BYTES, String(jsonBytes(projection)));
  assert.ok(projection.truncation, "large snapshots report omissions");
  assert.equal(projection.truncation.reason, "READ_RESPONSE_BUDGET");
  assert.ok(projection.truncation.sessions > 0);
  assert.ok(projection.sessions.length > 0 && projection.sessions.length < 200);
  assert.ok(projection.sessions.some(session => session.session_id === "ses_0"), "operational rows survive trimming");
});

test("fresh session detail is scope-bound, keeps runtime separation and reports absence", async () => {
  const probe = fixture();
  await probe.collector.tick();
  const found = await probe.collector.readSessionDetail("ses_0");
  assert.equal(found.found, true);
  if (!found.found) throw new Error("unreachable");
  assert.equal(found.row.session_id, "ses_0");
  assert.equal(found.row.current_runtime?.model_id, "setting");
  assert.equal(found.row.turns[0]?.runtime?.model_id, "used");
  assert.equal(found.recent.length, 1);
  assert.equal(found.recent[0]?.session_id, "ses_0");
  const missing = await probe.collector.readSessionDetail("ses_foreign");
  assert.deepEqual(missing, { found: false });
  probe.failSession();
  await assert.rejects(probe.collector.readSessionDetail("ses_0"));
});

test("Repo Live UI resource is assembled from the single repository source", async () => {
  const html = await loadControlAppHtml();
  assert.ok(html.includes("<style>") && html.includes("<script>"));
  assert.ok(!html.includes('href="/styles.css"') && !html.includes('src="/app.js"'));
  assert.ok(html.includes('id="facts"') && html.includes('id="work"'));
  assert.ok(html.includes("keine kanonische Live-Quelle"), "unknown QC stays explicit in the shared UI");
  assert.equal(await loadControlAppHtml(), html);
});

test("MCP app surface registers one UI resource, a render tool with entrypoints and read-only data tools", async () => {
  const control: DashboardControl = {
    overview: () => ({ marker: "overview" }),
    refresh: async () => ({ marker: "refresh" }),
    session: async id => id === "known" ? { found: true, marker: "detail" } : { found: false },
  };
  const gateway = { dashboardControl: control } as unknown as SessionGateway;
  const server = createMcpServer(gateway, undefined);
  const internals = server as unknown as {
    _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean }; _meta?: Record<string, unknown> }>;
    _registeredResources: Record<string, unknown>;
  };
  const open = internals._registeredTools.open_repo_live;
  const refresh = internals._registeredTools.refresh_repo_live;
  const detail = internals._registeredTools.get_repo_live_session;
  assert.ok(open && refresh && detail);
  assert.equal(open.annotations?.readOnlyHint, true);
  assert.equal(refresh.annotations?.readOnlyHint, true);
  assert.equal(detail.annotations?.readOnlyHint, true);
  assert.deepEqual(open._meta?.ui, { resourceUri: REPO_LIVE_UI_URI });
  assert.deepEqual(open._meta?.["openai/ui"], { entrypoints: [{ type: "global" }, { type: "thread" }] });
  assert.equal(refresh._meta, undefined);
  assert.ok(internals._registeredResources[REPO_LIVE_UI_URI]);

  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers;
  const call = async (name: string, args: Record<string, unknown>) => await handlers!.get("tools/call")!(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { requestId: 1, signal: AbortSignal.timeout(5000) });
  const refreshed = await call("refresh_repo_live", {}) as { structuredContent?: { marker?: string } };
  assert.equal(refreshed.structuredContent?.marker, "refresh");
  const rendered = await call("open_repo_live", {}) as { structuredContent?: { marker?: string } };
  assert.equal(rendered.structuredContent?.marker, "refresh");
  const known = await call("get_repo_live_session", { session_id: "known" }) as { structuredContent?: { marker?: string } };
  assert.equal(known.structuredContent?.marker, "detail");
  const missing = await call("get_repo_live_session", { session_id: "missing" }) as { isError?: boolean; _meta?: Record<string, { code?: string }> };
  assert.equal(missing.isError, true);
  assert.equal(missing._meta?.["opencode-vm/error"]?.code, "SESSION_NOT_FOUND");

  const resource = await handlers!.get("resources/read")!({ jsonrpc: "2.0", id: 2, method: "resources/read",
    params: { uri: REPO_LIVE_UI_URI } }, { requestId: 2, signal: AbortSignal.timeout(5000) }) as
    { contents?: Array<{ mimeType?: string; text?: string }> };
  assert.equal(resource.contents?.[0]?.mimeType, REPO_LIVE_UI_MIME);
  assert.ok(resource.contents?.[0]?.text?.includes("<style>"));

  const bare = createMcpServer({} as unknown as SessionGateway, undefined);
  const bareHandlers = (bare.server as unknown as { _requestHandlers?: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> })._requestHandlers;
  const refused = await bareHandlers!.get("tools/call")!({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "refresh_repo_live", arguments: {} } }, { requestId: 3, signal: AbortSignal.timeout(5000) }) as
    { isError?: boolean; _meta?: Record<string, { code?: string }> };
  assert.equal(refused.isError, true);
  assert.equal(refused._meta?.["opencode-vm/error"]?.code, "BACKEND_UNAVAILABLE");
});