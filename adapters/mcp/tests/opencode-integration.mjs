import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const OPEN_CODE_VERSION = "1.18.21";
const here = dirname(fileURLToPath(import.meta.url));
const adapter = resolve(here, "..");
const temporary = await mkdtemp(join(tmpdir(), "ocvm-mcp-integration-"));
const project = join(temporary, "project");
const configHome = join(temporary, "config");
const configDirectory = join(configHome, "opencode");
const dataHome = join(temporary, "data");
const stateHome = join(temporary, "state");
const runtimeDirectory = join(temporary, "runtime");
const mcpDirectory = join(temporary, "mcp");
const credentialFile = join(mcpDirectory, "credential");
const runtimeFile = join(mcpDirectory, "runtime.json");
const readyFile = join(mcpDirectory, "ready.json");
const token = `integration-${"a".repeat(64)}`;
let opencode;
let mcp;
let provider;
let mcpClient;

try {
  await mkdir(configDirectory, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(mcpDirectory, { recursive: true, mode: 0o700 });
  await chmod(mcpDirectory, 0o700);

  if (!process.env.OCVM_MCP_TEST_OPENCODE) {
    const install = spawnSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--silent",
        `opencode-ai@${OPEN_CODE_VERSION}`,
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        env: { ...process.env, npm_config_prefix: runtimeDirectory },
      },
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);
    process.stderr.write(
      `[integration] OpenCode ${OPEN_CODE_VERSION} runtime ready\n`,
    );
  }

  const providerRequests = [];
  provider = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, {
        object: "list",
        data: [{ id: "test-model", object: "model", owned_by: "test" }],
      });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    providerRequests.push(JSON.parse(await readBody(request)));
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write(
      sseChunk({
        id: "chatcmpl-mcp",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "MCP integration reply" },
            finish_reason: null,
          },
        ],
      }),
    );
    response.write(
      sseChunk({
        id: "chatcmpl-mcp",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
    response.end("data: [DONE]\n\n");
  });
  const providerPort = await listen(provider);
  const opencodePort = await reservePort();
  const mcpPort = await reservePort();
  await writeFile(
    join(configDirectory, "opencode.json"),
    `${JSON.stringify({
      autoupdate: false,
      model: "integration/test-model",
      small_model: "integration/test-model",
      provider: {
        integration: {
          npm: "@ai-sdk/openai-compatible",
          name: "MCP integration test",
          options: {
            baseURL: `http://127.0.0.1:${providerPort}/v1`,
            apiKey: "test-only",
          },
          models: {
            "test-model": {
              name: "Test model",
              tool_call: true,
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 32_000, output: 4_096 },
            },
          },
        },
      },
    })}\n`,
  );

  const command =
    process.env.OCVM_MCP_TEST_OPENCODE ??
    join(temporary, "node_modules", ".bin", "opencode");
  opencode = spawn(
    command,
    ["serve", "--hostname", "127.0.0.1", "--port", String(opencodePort)],
    {
      cwd: project,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: stateHome,
        OPENCODE_CONFIG: join(configDirectory, "opencode.json"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let opencodeDiagnostics = "";
  opencode.stderr.setEncoding("utf8");
  opencode.stderr.on("data", (chunk) => {
    opencodeDiagnostics += chunk;
  });
  const backendUrl = `http://127.0.0.1:${opencodePort}`;
  await waitForHealth(backendUrl, () => opencodeDiagnostics, opencode);

  const backend = createOpencodeClient({
    baseUrl: backendUrl,
    directory: project,
    throwOnError: true,
  });
  const currentProject = await backend.project.current({ directory: project });
  process.stderr.write(
    `[integration] OpenCode project id=${currentProject.data?.id ?? "missing"} worktree=${currentProject.data?.worktree ?? "missing"}\n`,
  );
  const created = await backend.session.create({
    title: "MCP integration session",
    agent: "build",
    model: { providerID: "integration", id: "test-model" },
  });
  assert.ok(created.data?.id);
  const sessionId = created.data.id;

  await writeFile(credentialFile, token, { mode: 0o600 });
  await writeFile(
    runtimeFile,
    `${JSON.stringify({
      schema: 1,
      project,
      projectHash: "integration-hash",
      projectName: "integration-project",
      backendUrl,
      generation: "integration-generation",
      opencodeVersion: OPEN_CODE_VERSION,
      listenHost: "127.0.0.1",
      listenPort: mcpPort,
      credentialFile,
    })}\n`,
    { mode: 0o600 },
  );

  ({ child: mcp } = await startAdapter(runtimeFile, readyFile));
  mcpClient = await connectMcp(mcpPort, token);
  const listed = structured(
    await mcpClient.callTool({
      name: "list_sessions",
      arguments: { limit: 10 },
    }),
  );
  assert.ok(listed.sessions.some((item) => item.id === sessionId));
  const details = structured(
    await mcpClient.callTool({
      name: "get_session",
      arguments: { session_id: sessionId },
    }),
  );
  assert.equal(details.id, sessionId);

  const receipt = structured(
    await mcpClient.callTool({
      name: "send_message",
      arguments: {
        session_id: sessionId,
        message: "Reply with the integration phrase.",
      },
    }),
  );
  assert.match(receipt.message_id, /^msg_[a-f0-9]{32}$/u);

  let finalStatus;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    finalStatus = structured(
      await mcpClient.callTool({
        name: "get_session_status",
        arguments: { session_id: sessionId, message_id: receipt.message_id },
      }),
    );
    if (
      ["completed", "failed", "aborted", "input_required"].includes(
        finalStatus.state,
      )
    )
      break;
    await delay(250);
  }
  assert.equal(finalStatus?.state, "completed");
  const history = structured(
    await mcpClient.callTool({
      name: "get_session_history",
      arguments: { session_id: sessionId, limit: 20 },
    }),
  );
  assert.ok(history.messages.some((item) => item.id === receipt.message_id));
  assert.ok(
    history.messages.some((item) =>
      item.text.includes("MCP integration reply"),
    ),
  );

  const backendNewest = await backend.session.messages({
    sessionID: sessionId,
    limit: 1,
  });
  assert.equal(backendNewest.data?.length, 1);
  assert.equal(backendNewest.data[0]?.info.role, "assistant");
  const backendCursor = backendNewest.response.headers.get("x-next-cursor");
  assert.ok(backendCursor);
  assert.notEqual(backendCursor, backendNewest.data[0]?.info.id);
  const backendOlder = await backend.session.messages({
    sessionID: sessionId,
    limit: 1,
    before: backendCursor,
  });
  assert.equal(backendOlder.data?.length, 1);
  assert.equal(backendOlder.data[0]?.info.id, receipt.message_id);

  const newestPage = structured(
    await mcpClient.callTool({
      name: "get_session_history",
      arguments: { session_id: sessionId, limit: 1 },
    }),
  );
  assert.deepEqual(
    newestPage.messages.map((item) => item.id),
    backendNewest.data.map((item) => item.info.id),
  );
  assert.equal(newestPage.next_before, backendCursor);
  const olderPage = structured(
    await mcpClient.callTool({
      name: "get_session_history",
      arguments: {
        session_id: sessionId,
        limit: 1,
        before: newestPage.next_before,
      },
    }),
  );
  assert.deepEqual(
    olderPage.messages.map((item) => item.id),
    [receipt.message_id],
  );
  assert.equal(olderPage.next_before, undefined);

  const backendMessages = await backend.session.messages({
    sessionID: sessionId,
    limit: 100,
  });
  assert.equal(
    backendMessages.data?.filter(
      (message) => message.info.id === receipt.message_id,
    ).length,
    1,
  );
  assert.ok(providerRequests.length > 0);

  await mcpClient.close();
  mcpClient = undefined;
  await stopChild(mcp);
  mcp = undefined;
  ({ child: mcp } = await startAdapter(runtimeFile, readyFile));
  mcpClient = await connectMcp(mcpPort, token);
  const recovered = structured(
    await mcpClient.callTool({
      name: "get_session_status",
      arguments: { session_id: sessionId, message_id: receipt.message_id },
    }),
  );
  assert.equal(recovered.state, "completed");
  assert.equal(
    (
      await backend.session.messages({ sessionID: sessionId, limit: 100 })
    ).data?.filter((message) => message.info.id === receipt.message_id).length,
    1,
  );
  process.stdout.write("MCP real OpenCode integration passed.\n");
} finally {
  await mcpClient?.close().catch(() => undefined);
  await stopChild(mcp);
  await stopChild(opencode);
  await closeServer(provider);
  await rm(temporary, { recursive: true, force: true });
}

async function startAdapter(runtimeFile, readyFile) {
  const child = spawn(process.execPath, [join(adapter, "dist", "main.js")], {
    cwd: adapter,
    env: { ...process.env, OCVM_MCP_RUNTIME: runtimeFile },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `MCP adapter exited with ${child.exitCode}.\n${diagnostics}`,
      );
    }
    try {
      const ready = JSON.parse(await readFile(readyFile, "utf8"));
      if (ready.pid === child.pid)
        return { child, diagnostics: () => diagnostics };
    } catch {}
    await delay(100);
  }
  await stopChild(child);
  throw new Error(`MCP adapter did not become ready.\n${diagnostics}`);
}

async function connectMcp(port, token) {
  const client = new Client({
    name: "ocvm-real-integration",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } },
  );
  await client.connect(transport);
  return client;
}

function structured(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No TCP port"));
      resolve(address.port);
    });
  });
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (!graceful && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function json(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return body;
}

function sseChunk(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function waitForHealth(baseUrl, diagnostics, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `OpenCode exited with ${child.exitCode}.\n${diagnostics()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`OpenCode did not become healthy.\n${diagnostics()}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
