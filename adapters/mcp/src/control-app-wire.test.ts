import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpHttpServer } from "./http.js";
import { REPO_LIVE_UI_MIME, REPO_LIVE_UI_URI } from "./tools.js";
import type { DashboardControl } from "./dashboard.js";
import type { SessionGateway } from "./opencode.js";
import type { RuntimeDescriptor } from "./types.js";

const token = "test-token-" + "x".repeat(43);

function runtime(): RuntimeDescriptor {
  return {
    schema: 1,
    project: "/project",
    projectHash: "hash",
    projectName: "project",
    backendUrl: "http://127.0.0.1:4095",
    generation: "generation",
    opencodeVersion: "1.18.21",
    listenHost: "127.0.0.1",
    listenPort: 0,
    credentialFile: "/credential",
  };
}

function gateway(): SessionGateway {
  const control: DashboardControl = {
    overview: () => ({ marker: "overview" }),
    refresh: async () => ({ marker: "refresh" }),
    session: async id => id === "ses_known" ? { found: true, marker: "detail" } : { found: false },
  };
  return { dashboardControl: control } as unknown as SessionGateway;
}

test("classic 2025-11-25 path serves the Repo Live resource and the read-only tools", async t => {
  const adapter = new McpHttpServer(runtime(), token, gateway());
  const port = await adapter.start();
  t.after(() => adapter.close());
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } });
  const client = new Client({ name: "repo-live-wire", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const tools = await client.listTools();
  const render = tools.tools.find(tool => tool.name === "open_repo_live") as
    (typeof tools.tools[number] & { _meta?: { ui?: { resourceUri?: string } } }) | undefined;
  assert.ok(render, "render tool is listed");
  assert.equal(render._meta?.ui?.resourceUri, REPO_LIVE_UI_URI);
  assert.equal(render.annotations?.readOnlyHint, true);
  assert.equal(render.annotations?.destructiveHint, false);

  const resources = await client.listResources();
  const entry = resources.resources.find(resource => resource.uri === REPO_LIVE_UI_URI);
  assert.ok(entry, "UI resource is listed");
  assert.equal(entry.mimeType, REPO_LIVE_UI_MIME);
  const read = await client.readResource({ uri: REPO_LIVE_UI_URI });
  assert.equal(read.contents[0]?.mimeType, REPO_LIVE_UI_MIME);
  const text = (read.contents[0] as { text?: string }).text ?? "";
  assert.ok(text.includes("<style>") && text.includes("<script>"));

  const refreshed = await client.callTool({ name: "refresh_repo_live", arguments: {} });
  assert.equal((refreshed.structuredContent as { marker?: string }).marker, "refresh");
  const detail = await client.callTool({ name: "get_repo_live_session", arguments: { session_id: "ses_known" } });
  assert.equal((detail.structuredContent as { marker?: string }).marker, "detail");
  const missing = await client.callTool({ name: "get_repo_live_session", arguments: { session_id: "ses_other" } });
  assert.equal(missing.isError, true);
  assert.equal((missing._meta?.["opencode-vm/error"] as { code?: string } | undefined)?.code, "SESSION_NOT_FOUND");
});

test("journal-free discovery hides exactly five tools and cached calls/events fail explicitly on both protocols", async t => {
  const disabled = { ...runtime(), activityJournalEnabled: false };
  const fake = gateway();
  let eventCalls = 0;
  fake.handleMcpEventMethod = async () => { eventCalls++; throw new Error("must not be called"); };
  const adapter = new McpHttpServer(disabled, token, fake);
  const port = await adapter.start(); t.after(() => adapter.close());
  const legacy = new McpHttpServer(runtime(), token, gateway());
  const legacyPort = await legacy.start(); t.after(() => legacy.close());
  const post = async (method: string, params: Record<string, unknown> = {}, modern = true, target = port) => {
    const response = await fetch(`http://127.0.0.1:${target}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", "X-OCVM-MCP-Token": token,
        ...(modern ? { "Mcp-Method": method, "MCP-Protocol-Version": "2026-07-28",
          ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}) } :
          { "MCP-Protocol-Version": "2025-11-25", accept: "application/json, text/event-stream" }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params,
        ...(modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } : {}) } }) });
    return response.json() as Promise<any>;
  };
  const baseline = (await post("tools/list", {}, true, legacyPort)).result.tools.map((tool: any) => tool.name);
  const removed = ["get_project_activity", "wait_for_project_activity", "get_project_attention",
    "acknowledge_project_attention", "supersede_unresolved_submission"];
  for (const modern of [false, true]) {
    const names = (await post("tools/list", {}, modern)).result.tools.map((tool: any) => tool.name);
    assert.deepEqual([...baseline.filter((name: string) => !names.includes(name))].sort(), [...removed].sort());
    for (const name of removed) {
      const result = (await post("tools/call", { name, arguments: {} }, modern)).result;
      assert.equal(result.isError, true);
      assert.equal(result._meta["opencode-vm/error"].code, "ACTIVITY_DISABLED");
      assert.equal(result.structuredContent.error_code, "ACTIVITY_DISABLED");
    }
  }
  assert.equal((await post("server/discover")).result.capabilities.events, undefined);
  assert.deepEqual((await post("events/list")).result.events, []);
  assert.equal((await post("events/subscribe")).error.data.code, "ACTIVITY_DISABLED");
  assert.equal(eventCalls, 0);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { "X-OCVM-MCP-Token": token } })).json() as any;
  assert.equal(health.healthy, true);
  assert.deepEqual(health.granularity.activity_journal, { enabled: false, state: "disabled" });
  assert.equal(health.granularity.events_channel, "disabled");
});

test("2026-07-28 path dispatches resources and tools through the same handlers", async t => {
  const adapter = new McpHttpServer(runtime(), token, gateway());
  const port = await adapter.start();
  t.after(() => adapter.close());
  const post = async (method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-OCVM-MCP-Token": token,
        "Mcp-Method": method,
        "MCP-Protocol-Version": "2026-07-28",
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method,
        params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
    });

  const discovery = await post("server/discover");
  const capabilities = ((await discovery.json()) as { result: { capabilities: Record<string, unknown> } }).result.capabilities;
  assert.deepEqual(capabilities.resources, {});

  const listed = await post("resources/list");
  const listResult = (await listed.json()) as { result?: { resultType?: string; resources?: Array<{ uri: string; mimeType?: string }> } };
  assert.equal(listResult.result?.resultType, "complete");
  assert.ok(listResult.result?.resources?.some(resource => resource.uri === REPO_LIVE_UI_URI));

  const read = await post("resources/read", { uri: REPO_LIVE_UI_URI }, { "Mcp-Name": REPO_LIVE_UI_URI });
  const readResult = (await read.json()) as { result?: { contents?: Array<{ mimeType?: string; text?: string }> }; error?: unknown };
  assert.equal(readResult.result?.contents?.[0]?.mimeType, REPO_LIVE_UI_MIME, JSON.stringify(readResult.error));
  assert.ok(readResult.result?.contents?.[0]?.text?.includes("<style>"));

  const call = await post("tools/call", { name: "refresh_repo_live", arguments: {} }, { "Mcp-Name": "refresh_repo_live" });
  const callResult = (await call.json()) as { result?: { resultType?: string; structuredContent?: { marker?: string } } };
  assert.equal(callResult.result?.resultType, "complete");
  assert.equal(callResult.result?.structuredContent?.marker, "refresh");

  const detail = await post("tools/call", { name: "get_repo_live_session", arguments: { session_id: "ses_other" } }, { "Mcp-Name": "get_repo_live_session" });
  const detailResult = (await detail.json()) as { result?: { isError?: boolean; _meta?: Record<string, { code?: string }> } };
  assert.equal(detailResult.result?.isError, true);
  assert.equal(detailResult.result?._meta?.["opencode-vm/error"]?.code, "SESSION_NOT_FOUND");

  const unknown = await post("resources/read", { uri: "ui://repo-live/unknown.html" }, { "Mcp-Name": "ui://repo-live/unknown.html" });
  const unknownResult = (await unknown.json()) as { error?: { code?: number } };
  assert.equal(unknownResult.error?.code, -32602);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "Mcp-Method": "resources/list", "MCP-Protocol-Version": "2026-07-28" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
  });
  assert.equal(unauthorized.status, 401);
});
