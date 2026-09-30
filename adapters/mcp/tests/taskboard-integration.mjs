// Disposable real Taskboard + OpenCode + packaged MCP acceptance. No model turns.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

assert.ok(process.env.OCVM_TASKBOARD_BIN, "Set OCVM_TASKBOARD_BIN to the pinned v0.6.0 binary.");
const root = await mkdtemp(join(tmpdir(), "ocvm-low-risk-smoke-"));
const project = join(root, "project");
const privateDir = join(root, "mcp");
const children = [];
const clients = [];
let proxy;
let diagnostics = "";
const token = randomBytes(32).toString("hex");
const report = { scope: "disposable-only", checks: [], current_connector: "not-probed" };

async function port() {
  const server = http.createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: project, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  child.stderr.on("data", (bytes) => { diagnostics = (diagnostics + bytes).slice(-32_000); });
  child.on("error", (error) => { diagnostics += error.message; });
  return child;
}
async function wait(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const result = await check(); if (result) return result; } catch { /* Starting. */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Readiness timeout: " + diagnostics);
}
async function connect(url, credential) {
  const client = new Client({ name: "low-risk-disposable-smoke", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url),
    { requestInit: { headers: { "X-OCVM-MCP-Token": credential } } }), { timeout: 10_000 });
  return client;
}
try {
  await mkdir(project);
  await mkdir(privateDir, { mode: 0o700 });
  await chmod(privateDir, 0o700);
  // Existing project connector is discovery-only: no production Board writes/restart.
  if (process.env.OCVM_MCP_LIVE_RUNTIME) {
    console.error("[smoke] Existing connector discovery (read-only)");
    const live = JSON.parse(await readFile(process.env.OCVM_MCP_LIVE_RUNTIME, "utf8"));
    const liveClient = await connect(`http://127.0.0.1:${live.listenPort}/mcp`,
      (await readFile(live.credentialFile, "utf8")).trim());
    const names = (await liveClient.listTools({}, { timeout: 10_000 })).tools.map((tool) => tool.name);
    report.current_connector = {
      discovery_only: true,
      note_available: names.includes("add_task_management_note"),
      bindings_available: names.includes("add_task_document_bindings"),
    };
  }
  const boardPort = await port();
  console.error("[smoke] Starting disposable Taskboard and OpenCode");
  const backendPort = await port();
  const mcpPort = await port();
  const boardUrl = `http://127.0.0.1:${boardPort}`;
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  start(process.env.OCVM_TASKBOARD_BIN, ["--db", join(root, "smoke.db"), "start", "--foreground", "--port", String(boardPort)],
    { SHELL: "/bin/false" });
  await wait(async () => (await fetch(`${boardUrl}/api/projects`, { signal: AbortSignal.timeout(1_000) })).ok);
  const config = join(root, "config/opencode");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [], mcp: {} }));
  start(process.env.OCVM_MCP_TEST_OPENCODE ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(backendPort)], {
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG: join(config, "opencode.json"), OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  });
  const health = await wait(async () => { const response = await fetch(`${backendUrl}/global/health`, { signal: AbortSignal.timeout(1_000) }); return response.ok && response.json(); });
  // Record real PUT bodies; inject one lost response AFTER real backend commit.
  const puts = [];
  let loseNextPutResponse = false;
  proxy = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (request.method === "PUT") puts.push(JSON.parse(body.toString("utf8")));
      const upstream = await fetch(`${boardUrl}${request.url}`, { method: request.method,
        ...(body.length ? { body, headers: { "content-type": "application/json" } } : {}) });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (request.method === "PUT" && loseNextPutResponse) {
        loseNextPutResponse = false;
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, { "content-type": "application/json" });
      response.end(bytes);
    } catch { response.writeHead(502).end(); }
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  const credentialFile = join(privateDir, "credential");
  const runtimeFile = join(privateDir, "runtime.json");
  const metadataFile = join(project, "metadata.json");
  await writeFile(credentialFile, token, { mode: 0o600 });
  await writeFile(runtimeFile, JSON.stringify({ schema: 1, project, projectHash: "low-risk-smoke", projectName: "Disposable smoke",
    backendUrl, opencodeVersion: health.version, generation: "disposable-low-risk", listenHost: "127.0.0.1", listenPort: mcpPort,
    credentialFile, taskboardUrl: `http://127.0.0.1:${proxy.address().port}`, taskboardMetadataFile: metadataFile }), { mode: 0o600 });
  const entry = process.env.OCVM_MCP_TEST_ADAPTER ?? resolve(dirname(fileURLToPath(import.meta.url)), "../dist/main.js");
  start(process.execPath, [entry], { OCVM_MCP_RUNTIME: runtimeFile });
  console.error("[smoke] Waiting for isolated MCP readiness");
  const ready = await wait(async () => JSON.parse(await readFile(join(privateDir, "ready.json"), "utf8")));
  report.adapter_version = ready.adapterVersion;
  report.opencode_version = health.version;
  const client = await connect(`http://127.0.0.1:${mcpPort}/mcp`, token);
  console.error("[smoke] Exercising additive tools through MCP");
  const tools = (await client.listTools()).tools;
  for (const [name, idempotentHint] of [["add_task_management_note", false], ["add_task_document_bindings", true]]) {
    assert.deepEqual(tools.find((tool) => tool.name === name)?.annotations,
      { readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint: false });
  }
  async function call(name, arguments_ = {}) {
    const response = await client.callTool({ name, arguments: arguments_ });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return response.structuredContent;
  }
  async function error(name, arguments_, code) {
    const response = await client.callTool({ name, arguments: arguments_ });
    assert.equal(response.isError, true);
    assert.equal(response._meta["opencode-vm/error"].code, code);
  }
  await call("create_board_project", { name: "Inbox", prefix: "INBOX", make_default: true });
  const task = await call("create_project_task", { title: "Disposable low-risk acceptance", description: "Original\n", priority: "high" });
  const id = task.task_id;
  const compact = `.opencode/tasks/task-${id}.compact.md`;
  const alternate = `.opencode/tasks/${id}.compact.md`;
  const plan = `planning/task-concepts/${id}-concept-plan.md`;
  await mkdir(join(project, ".opencode/tasks"), { recursive: true });
  await mkdir(join(project, "planning/task-concepts"), { recursive: true });
  for (const path of [compact, alternate]) await writeFile(join(project, path), `Task-ID: ${id}\nDisposable context\n`);
  const before = await readFile(metadataFile, "utf8");
  await error("add_task_document_bindings", { task_id: id, compact_context: compact, concept_plan: plan }, "TASK_DOCUMENT_MISSING");
  assert.equal(await readFile(metadataFile, "utf8"), before);
  await writeFile(join(project, plan), `Task-ID: foreign\n`);
  await error("add_task_document_bindings", { task_id: id, compact_context: compact, concept_plan: plan }, "TASK_DOCUMENT_MISMATCH");
  assert.equal(await readFile(metadataFile, "utf8"), before);
  await writeFile(join(project, plan), `Task-ID: ${id}\nStatus: active\nDisposable plan\n`);
  await call("add_task_document_bindings", { task_id: id, compact_context: compact });
  const single = await readFile(metadataFile, "utf8");
  await error("add_task_document_bindings", { task_id: id, compact_context: alternate, concept_plan: plan }, "TASK_DOCUMENT_CONFLICT");
  assert.equal(await readFile(metadataFile, "utf8"), single);
  await call("add_task_document_bindings", { task_id: id, compact_context: compact, concept_plan: plan });
  const inode = (await stat(metadataFile)).ino;
  const bound = await readFile(metadataFile, "utf8");
  await call("add_task_document_bindings", { task_id: id, compact_context: compact, concept_plan: plan });
  assert.equal((await stat(metadataFile)).ino, inode);
  assert.equal(await readFile(metadataFile, "utf8"), bound);
  const docs = (await call("get_task_documents", { task_id: id })).documents;
  assert.deepEqual(docs.map(({ role, path, state }) => ({ role, path, state })),
    [{ role: "compact_context", path: compact, state: "available" }, { role: "concept_plan", path: plan, state: "available" }]);
  assert.ok(docs.every((doc) => doc.revision && doc.sha256));
  assert.match((await call("read_task_document", { task_id: id, role: "concept_plan" })).text, /Disposable plan/u);
  assert.equal((await call("get_project_task", { task_id: id })).status, "todo");
  report.checks.push("single/bundle/replay/conflict/missing/mismatch/all-or-nothing/readback");
  for (const note of ["Follow up", "Follow up"]) await call("add_task_management_note", { task_id: id, note });
  let readback = await call("get_project_task", { task_id: id });
  assert.equal(readback.description, "Original\n" + "\n\nManagement Note:\nFollow up".repeat(2));
  assert.deepEqual([readback.title, readback.priority, readback.status], [task.title, task.priority, "todo"]);
  assert.equal(await readFile(metadataFile, "utf8"), bound);
  await error("add_task_management_note", { task_id: "task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", note: "Unknown" }, "TASK_NOT_FOUND");
  await error("add_task_management_note", { task_id: id, note: "界".repeat(14_000) }, "TASK_SEARCH_INCOMPLETE");
  await error("add_task_management_note", { task_id: id, note: "x".repeat(32_000) }, "TASK_DESCRIPTION_LIMIT");
  assert.equal(puts.length, 2);
  loseNextPutResponse = true;
  await error("add_task_management_note", { task_id: id, note: "Committed response lost" }, "TASKBOARD_UNAVAILABLE");
  readback = await call("get_project_task", { task_id: id });
  assert.ok(readback.description.endsWith("\n\nManagement Note:\nCommitted response lost"));
  assert.equal(puts.length, 3, "Uncertain PUT was retried");
  assert.ok(puts.every((body) => Object.keys(body).join() === "description"));
  report.checks.push("native append/multiple/prefix/field-isolation/limits/unknown/commit-uncertainty-no-retry");
  await call("move_project_task", { task_id: id, status: "in_progress" });
  assert.equal((await call("get_project_task", { task_id: id })).status, "in_progress");
  report.checks.push("available-revisions-before-separate-board-move/status-readback");
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await new Promise((done) => child.once("exit", done));
    clearTimeout(timer);
  }
  if (proxy) await new Promise((done) => proxy.close(done));
  await rm(root, { recursive: true, force: true });
}
