// Optional real tunnel-client interoperability check, with a local control plane.
// Build adapters/mcp first; set OCVM_TUNNEL_CLIENT to the pinned full client binary.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpHttpServer } from "../adapters/mcp/dist/http.js";

const binary = process.env.OCVM_TUNNEL_CLIENT;
if (!binary) throw new Error("Set OCVM_TUNNEL_CLIENT to tunnel-client v0.0.15.");
const require = createRequire(new URL("../adapters/mcp/package.json", import.meta.url));
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "ocvm-tunnel-protocol-"));
const namespace = `ocvm-mcp-tunnel-fixture-${process.pid}`;
const loadGuestLibrary = 'source "$1"; OC_PORT=4096; OCVM_WEB_LIB_SH="${OCVM_WEB_LIB_SH//ocvm-mcp-tunnel/$TEST_TUNNEL_NAMESPACE}"; eval "$OCVM_WEB_LIB_SH"; ';
const key = "sk-test-runtime-key-must-not-leak";
const token = "test-local-token-must-not-leak";
const summary = { id: "ses_fixture", title: "Fixture", created: 1, updated: 2, activity: "idle" };
const pending = { permissions: 0, questions: 0 };
const fixtureRuntime = { agent: "build", provider_id: "fixture", model_id: "model", variant: "default" };
let submissions = 0, creations = 0;
const gateway = {
  async getSessionRuntimeOptions() { return { agents: ["build", "plan"], providers: [{ provider_id: "fixture", name: "Fixture" }], models: [{ provider_id: "fixture", model_id: "model", name: "Model", variants: ["default"] }], truncated: false }; },
  async updateSessionRuntime(sessionId, patch) { return { session_id: sessionId, previous: fixtureRuntime, current: { ...fixtureRuntime, ...patch }, state: "updated" }; },
  async getProjectActivity() { return { events: [], next_cursor: "fixture-cursor", has_more: false, tracking: { connected: true, partial: false } }; },
  async waitForProjectActivity() { return { ...await this.getProjectActivity(), timeout: true }; },
  async createSession(title) { creations++; return { project: { id: "fixture", name: "fixture" }, session_id: summary.id, title: title ?? "MCP Work Session", agent: "build", provider_id: "fixture", model_id: "model", state: "created" }; },
  async listSessions() { return { project: { id: "fixture", name: "fixture" }, sessions: [summary], truncated: false }; },
  async getSessionDetails() { return { ...summary, pending_input: pending }; },
  async getSessionStatus() { return { session_id: summary.id, message_id: "msg_fixture", backend_activity: "idle", state: "completed", pending_input: pending, assistant_message_ids: ["msg_reply"] }; },
  async getSessionHistory() { return { session_id: summary.id, messages: [{ id: "msg_reply", role: "assistant", text: "Tunnel fixture reply", created: 2, text_truncated: false }], truncated: false }; },
  async sendMessage() { submissions++; return { session_id: summary.id, message_id: "msg_fixture", state: "submitted" }; },
};
const server = new McpHttpServer({ schema: 1, project: temp, projectHash: "fixture", projectName: "fixture", generation: "fixture", listenHost: "127.0.0.1", listenPort: 0 }, token, gateway);
let proxy, client, controlPlane, serviceShare;
let diagnostics = "";
async function stopProxy() {
  if (!proxy || proxy.exitCode !== null) return;
  const exited = new Promise(resolve => proxy.once("exit", resolve));
  proxy.kill("SIGTERM");
  const timer = setTimeout(() => proxy.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
function guest(command, env = {}) {
  return spawn("bash", ["-c", 'action="$2"; ' + loadGuestLibrary + 'eval "$action"', "_", join(root, "opencode-vm.sh"), command], {
    env: { ...process.env, OCVM_INTERNAL_SOURCE_ONLY: "1", TEST_TUNNEL_NAMESPACE: namespace, SESS_SHARE: serviceShare, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function runGuest(command, env) {
  const child = guest(command, env);
  let stdout = "", stderr = "";
  child.stdout.on("data", part => { stdout += part; });
  child.stderr.on("data", part => { stderr += part; });
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(code, 0, stderr + stdout);
  return stdout;
}
try {
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.0\.15[+\s]/);
  const port = await server.start();
  const share = join(temp, "share");
  await mkdir(join(share, "mcp"), { recursive: true, mode: 0o700 });
  await writeFile(join(share, "mcp", "credential"), token, { mode: 0o600 });
  await writeFile(join(share, "mcp", "runtime.json"), JSON.stringify({ listenPort: port }));
  // Generate the actual managed profile without installing or starting anything.
  const prepared = spawnSync("bash", ["-c", loadGuestLibrary + 'prepare_mcp_tunnel', "_", join(root, "opencode-vm.sh")], {
    env: { ...process.env, OCVM_INTERNAL_SOURCE_ONLY: "1", TEST_TUNNEL_NAMESPACE: namespace, SESS_SHARE: share },
    input: JSON.stringify({ tunnelId: "tunnel_0123456789abcdef0123456789abcdef", apiKey: key }),
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const profile = join(share, "mcp", "tunnel.yaml");
  assert.ok(!(await readFile(profile, "utf8")).includes(key));
  const connectionFile = join(temp, "connection.json");
  proxy = spawn(resolve(binary), ["dev", "proxy", "--profile-file", profile, "--url-file", connectionFile, "--readiness-timeout", "20s"], { stdio: ["ignore", "pipe", "pipe"] });
  proxy.stdout.on("data", part => { diagnostics += part; });
  proxy.stderr.on("data", part => { diagnostics += part; });
  let connection;
  for (let i = 0; i < 120; i++) {
    try { connection = JSON.parse(await readFile(connectionFile, "utf8")); break; } catch {}
    assert.equal(proxy.exitCode, null, diagnostics);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(connection?.mcp_url, diagnostics);
  client = new Client({ name: "ocvm-tunnel-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcp_url)));
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 10);
  for (const [name, args] of [
    ["get_session_runtime_options", {}],
    ["update_session_runtime", { session_id: summary.id, agent: "plan" }],
    ["get_project_activity", {}],
    ["wait_for_project_activity", { after_cursor: "fixture-cursor", timeout_ms: 1 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
  }
  const created = await client.callTool({ name: "create_session", arguments: { title: "Tunnel session" } });
  assert.equal(created.structuredContent?.session_id, summary.id);
  assert.ok(!created.isError);
  for (const name of ["list_sessions", "get_session", "send_message", "get_session_status", "get_session_history"]) {
    const args = name === "list_sessions" ? {} : { session_id: summary.id };
    if (name === "send_message") args.message = "Fixture request";
    if (name === "get_session_status") args.message_id = "msg_fixture";
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(result.structuredContent);
  }
  assert.equal(submissions, 1);
  assert.equal(creations, 1);
  const direct = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(direct.status, 401, "the local endpoint still requires its token");
  assert.ok(!diagnostics.includes(key) && !diagnostics.includes(token), "credentials leaked into tunnel diagnostics");
  console.log("PASS: tunnel-client v0.0.15 discovers and invokes all ten tools through its local tunnel control plane using the generated profile.");

  // Optional Linux/systemd check: real checksum installer and managed service,
  // with outbound traffic confined to a disposable local control-plane fixture.
  if (process.env.OCVM_TUNNEL_ARCHIVE) {
    await client.close();
    client = undefined;
    await stopProxy();
    const existing = spawnSync("sudo", ["-n", "systemctl", "show", `${namespace}.service`, "-p", "LoadState", "--value"], { encoding: "utf8" });
    assert.equal(existing.stdout.trim(), "not-found", "refusing to touch an existing tunnel service");
    let deny = false, polls = 0;
    controlPlane = http.createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      if (request.url.includes("/poll")) {
        polls++;
        setTimeout(() => response.writeHead(deny ? 403 : 204).end(), 100);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "tunnel_0123456789abcdef0123456789abcdef", name: "fixture" }));
      }
    });
    await new Promise(resolve => controlPlane.listen(0, "127.0.0.1", resolve));
    const value = JSON.parse(await readFile(profile, "utf8"));
    value.control_plane.base_url = `http://127.0.0.1:${controlPlane.address().port}`;
    await writeFile(profile, JSON.stringify(value));
    serviceShare = share;
    const home = join(temp, "home");
    await mkdir(home);
    const installed = await runGuest('curl() { local output="" previous="" arg; for arg in "$@"; do if [[ "$previous" == -o ]]; then output="$arg"; fi; previous="$arg"; done; cp "$OCVM_TUNNEL_ARCHIVE" "$output"; }; install_mcp_tunnel; printf "%s\\n" "$OC_MCP_TUNNEL_BIN"', { HOME: home });
    const installedBinary = installed.trim().split("\n").at(-1);
    const started = await runGuest('start_mcp_tunnel; wait_for_mcp_tunnel', { OC_MCP_TUNNEL_BIN: installedBinary });
    assert.match(started, /OpenAI polling confirmed/);
    assert.ok(polls > 0);
    let status = JSON.parse(await runGuest('mcp_tunnel_guest_status'));
    assert.equal(status.process, "active");
    assert.equal(status.connected, true);
    deny = true;
    for (let i = 0; i < 40; i++) {
      status = JSON.parse(await runGuest('mcp_tunnel_guest_status'));
      if (status.httpStatus === 403) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.httpStatus, 403);
    assert.equal(status.connected, false, "a previous success must not hide a current polling failure");
    const log = await readFile(join(share, "mcp", "tunnel.log"), "utf8");
    assert.ok(!log.includes(key) && !log.includes(token), "credentials leaked into service log");
    await runGuest('exec 7>"/tmp/$TEST_TUNNEL_NAMESPACE.lock"; flock -w 10 7; stop_mcp_tunnel');
    status = JSON.parse(await runGuest('mcp_tunnel_guest_status'));
    assert.equal(status.process, "inactive");
    await assert.rejects(readFile(join(share, "mcp", "tunnel-key")), { code: "ENOENT" });
    serviceShare = undefined;
    console.log("PASS: pinned installer, real systemd start/readiness, polling rejection, secret-free logs and shutdown cleanup.");
  }
} finally {
  await client?.close().catch(() => {});
  await stopProxy();
  if (serviceShare) await runGuest('exec 7>"/tmp/$TEST_TUNNEL_NAMESPACE.lock"; flock -w 10 7; stop_mcp_tunnel').catch(() => {});
  if (controlPlane) await new Promise(resolve => controlPlane.close(resolve));
  await server.close();
  await rm(temp, { recursive: true, force: true });
  await rm(`/tmp/${namespace}`, { recursive: true, force: true });
  await rm(`/tmp/${namespace}.lock`, { force: true });
}
