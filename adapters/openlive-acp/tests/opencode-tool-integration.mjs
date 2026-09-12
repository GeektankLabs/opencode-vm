import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const OPEN_CODE_VERSION = "1.18.21";
const here = dirname(fileURLToPath(import.meta.url));
const adapter = resolve(here, "..");
const temporary = await mkdtemp(join(tmpdir(), "ocvm-openlive-integration-"));
const project = join(temporary, "project");
const configHome = join(temporary, "config");
const configDirectory = join(configHome, "opencode");
const dataHome = join(temporary, "data");
const stateHome = join(temporary, "state");
const runtimeDirectory = join(temporary, "runtime");
const socketPath = join(temporary, "control.sock");
const managerTool =
  process.env.OCVM_OPENLIVE_TEST_MANAGER_TOOL ??
  join(adapter, "src", "manager", "tool.mjs");
const screenFrame =
  "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";
let opencode;
let fakeProvider;
let control;

try {
  await mkdir(join(configDirectory, "tools"), { recursive: true });
  await mkdir(project, { recursive: true });
  await cp(managerTool, join(configDirectory, "tools", "voice_sessions.js"));
  const install = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--silent",
      `@opencode-ai/plugin@${OPEN_CODE_VERSION}`,
    ],
    { cwd: configDirectory, encoding: "utf8" },
  );
  assert.equal(install.status, 0, install.stderr || install.stdout);
  process.stderr.write("[integration] manager tool dependency ready\n");
  if (!process.env.OCVM_OPENLIVE_TEST_OPENCODE) {
    const runtimeInstall = spawnSync(
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
    assert.equal(
      runtimeInstall.status,
      0,
      runtimeInstall.stderr || runtimeInstall.stdout,
    );
    process.stderr.write("[integration] OpenCode 1.18.21 runtime ready\n");
  }

  const controlRequests = [];
  control = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      controlRequests.push(JSON.parse(input.slice(0, newline)));
      socket.end(
        `${JSON.stringify({
          ok: true,
          output: JSON.stringify({
            total: 1,
            busy: 0,
            sessions: [
              { id: "ses_work", title: "Integration work", status: "idle" },
            ],
          }),
        })}\n`,
      );
    });
  });
  await listen(control, socketPath);

  const providerRequests = [];
  fakeProvider = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, {
        object: "list",
        data: [{ id: "tool-model", object: "model", owned_by: "test" }],
      });
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(request));
    providerRequests.push(body);
    const hasToolResult = body.messages.some(
      (message) => message.role === "tool",
    );
    const hasVoiceTool = body.tools?.some(
      (tool) => tool.function?.name === "voice_sessions",
    );
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (!hasVoiceTool) {
      response.write(
        sseChunk({
          id: "chatcmpl-title",
          object: "chat.completion.chunk",
          created: 1,
          model: "tool-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Integration title" },
              finish_reason: null,
            },
          ],
        }),
      );
      response.write(
        sseChunk({
          id: "chatcmpl-title",
          object: "chat.completion.chunk",
          created: 1,
          model: "tool-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
    } else if (!hasToolResult) {
      response.write(
        sseChunk({
          id: "chatcmpl-tool",
          object: "chat.completion.chunk",
          created: 1,
          model: "tool-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_voice_sessions",
                    type: "function",
                    function: {
                      name: "voice_sessions",
                      arguments: '{"action":"list"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      response.write(
        sseChunk({
          id: "chatcmpl-tool",
          object: "chat.completion.chunk",
          created: 1,
          model: "tool-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
      );
    } else {
      response.write(
        sseChunk({
          id: "chatcmpl-final",
          object: "chat.completion.chunk",
          created: 2,
          model: "tool-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Listed sessions." },
              finish_reason: null,
            },
          ],
        }),
      );
      response.write(
        sseChunk({
          id: "chatcmpl-final",
          object: "chat.completion.chunk",
          created: 2,
          model: "tool-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
    }
    response.end("data: [DONE]\n\n");
  });
  const providerPort = await listen(fakeProvider);
  const opencodePort = await reservePort();
  await writeFile(
    join(configDirectory, "opencode.json"),
    `${JSON.stringify({
      autoupdate: false,
      model: "integration/tool-model",
      small_model: "integration/tool-model",
      provider: {
        integration: {
          npm: "@ai-sdk/openai-compatible",
          name: "OpenLive integration test",
          options: {
            baseURL: `http://127.0.0.1:${providerPort}/v1`,
            apiKey: "test-only",
          },
          models: {
            "tool-model": {
              name: "Tool model",
              tool_call: true,
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 32_000, output: 4_096 },
            },
          },
        },
      },
      agent: {
        "openlive-manager": {
          description: "OpenLive manager integration test",
          mode: "primary",
          prompt: "Always call voice_sessions before answering.",
          permission: { "*": "deny", voice_sessions: "allow" },
        },
      },
    })}\n`,
  );

  const command =
    process.env.OCVM_OPENLIVE_TEST_OPENCODE ??
    join(temporary, "node_modules", ".bin", "opencode");
  const args = [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(opencodePort),
  ];
  opencode = spawn(command, args, {
    cwd: project,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
      OPENCODE_CONFIG: join(configDirectory, "opencode.json"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OCVM_OPENLIVE_CONTROL_SOCKET: socketPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  opencode.stderr.setEncoding("utf8");
  opencode.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const baseUrl = `http://127.0.0.1:${opencodePort}`;
  await waitForHealth(baseUrl, () => diagnostics, opencode);
  process.stderr.write("[integration] OpenCode server healthy\n");

  const client = createOpencodeClient({
    baseUrl,
    directory: project,
    throwOnError: true,
  });
  const tools = await client.tool.list({
    provider: "integration",
    model: "tool-model",
  });
  assert.ok(
    tools.data?.some((tool) => tool.id === "voice_sessions"),
    "voice_sessions is missing from the model-aware OpenCode tool list",
  );
  const voiceTool = tools.data?.find((tool) => tool.id === "voice_sessions");
  assert.ok(
    voiceTool?.parameters?.properties?.action?.enum?.includes("create"),
    "voice_sessions does not expose the create action",
  );
  process.stderr.write("[integration] model-aware tool schema ready\n");
  const session = await client.session.create({ title: "Manager integration" });
  assert.ok(session.data?.id);
  const result = await withTimeout(
    client.session.prompt({
      sessionID: session.data.id,
      messageID: "msg_openliveintegration",
      agent: "openlive-manager",
      model: { providerID: "integration", modelID: "tool-model" },
      parts: [
        { type: "text", text: "List the sessions shown on screen." },
        {
          type: "file",
          mime: "image/jpeg",
          filename: "openlive-frame-1.jpg",
          url: `data:image/jpeg;base64,${screenFrame}`,
        },
      ],
    }),
    30_000,
    () =>
      `OpenCode manager prompt timed out after ${providerRequests.length} provider requests.\n${diagnostics}`,
  );

  assert.equal(result.data?.info.parentID, "msg_openliveintegration");
  assert.equal(
    result.data?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    "Listed sessions.",
  );
  const managerRequests = providerRequests.filter((request) =>
    request.tools?.some((tool) => tool.function?.name === "voice_sessions"),
  );
  assert.ok(
    managerRequests[0],
    "voice_sessions did not reach the provider request",
  );
  assert.match(
    JSON.stringify(managerRequests[0]),
    new RegExp(`data:image/jpeg;base64,${screenFrame}`),
    "the OpenLive JPEG frame did not reach the provider request",
  );
  assert.equal(controlRequests.length, 1);
  assert.equal(controlRequests[0].action, "list");
  assert.equal(controlRequests[0].callerSessionId, session.data.id);
  assert.equal(typeof controlRequests[0].callerMessageId, "string");
  assert.ok(
    managerRequests[1]?.messages?.some(
      (message) =>
        message.role === "tool" && message.content.includes("Integration work"),
    ),
    "the provider did not receive the control-socket tool result",
  );
  process.stdout.write("OpenCode manager-tool integration passed.\n");
} finally {
  if (opencode && opencode.exitCode === null) {
    opencode.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => opencode.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
  await closeServer(control);
  await closeServer(fakeProvider);
  await rm(temporary, { recursive: true, force: true });
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const ready = () => {
      server.off("error", reject);
      const address = server.address();
      resolve(
        typeof address === "object" && address ? address.port : undefined,
      );
    };
    if (path) server.listen(path, ready);
    else server.listen(0, "127.0.0.1", ready);
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

function json(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sseChunk(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function waitForHealth(baseUrl, diagnostics, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(
        `OpenCode test server exited with ${child.exitCode}.\n${diagnostics()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `OpenCode test server did not become healthy.\n${diagnostics()}`,
  );
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
