import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const heldPrompts = new Map();
const longReport =
  'ÄÖß 😀 👩🏽‍💻\n```ts\nconst path = "\\\\example";\n```\n'.repeat(5000) +
  "FINAL-TOKEN: delivery-a-original-end";
assert.ok(Buffer.byteLength(longReport) >= 200 * 1024);
const protocolObservations = new Set();
const readResponseSizes = [];
const toolGate = join(temporary, "release-tool");

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
    const requestBody = JSON.parse(await readBody(request));
    providerRequests.push(requestBody);
    const content = requestBody.messages?.at(-1)?.content;
    const lastText =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
          : "";
    if (lastText === "parallel-A" || lastText === "parallel-B") {
      await new Promise((resolve) => heldPrompts.set(lastText, resolve));
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (lastText === "delivery-b-tool") {
      response.write(
        sseChunk({
          id: "chatcmpl-progress",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_delivery_b",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command: `for i in $(seq 1 300); do [ -f "${toolGate}" ] && break; sleep 0.1; done; printf B_PRIVATE_TOOL_OUTPUT`,
                        description: "B_PRIVATE_TOOL_TITLE",
                      }),
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
          id: "chatcmpl-progress",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(
      sseChunk({
        id: "chatcmpl-mcp",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content:
                lastText === "delivery-a-report"
                  ? longReport
                  : "MCP integration reply",
            },
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
      permission: { bash: "allow" },
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
              reasoning: true,
              variants: { medium: {}, high: {} },
              modalities: { input: ["text"], output: ["text"] },
              limit: { context: 32_000, output: 4_096 },
            },
            "other-model": {
              name: "Other test model",
              tool_call: true,
              reasoning: true,
              variants: { medium: {}, high: {} },
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
  const backendVersion = (await backend.global.health()).data?.version;
  assert.ok(backendVersion);
  process.stderr.write(
    `[integration] OpenCode ${backendVersion} project id=${currentProject.data?.id ?? "missing"} worktree=${currentProject.data?.worktree ?? "missing"}\n`,
  );
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
      opencodeVersion: backendVersion,
      listenHost: "127.0.0.1",
      listenPort: mcpPort,
      credentialFile,
    })}\n`,
    { mode: 0o600 },
  );

  ({ child: mcp } = await startAdapter(runtimeFile, readyFile));
  mcpClient = await connectMcp(mcpPort, token);
  const beforeCreation = structured(
    await mcpClient.callTool({ name: "list_sessions", arguments: {} }),
  );
  assert.equal(beforeCreation.sessions.length, 0);
  const creationReply = await mcpClient.callTool({
    name: "create_session",
    arguments: { title: "MCP integration session" },
  });
  if (creationReply.isError) {
    console.error(
      "[integration] enabled models",
      (
        await backend.v2.model.list({ location: { directory: project } })
      ).data?.data
        ?.filter((model) => model.providerID === "integration")
        .map(({ id, enabled }) => ({ id, enabled })),
    );
    const observed = await backend.v2.session.list({ directory: project });
    console.error(
      "[integration] creation metadata",
      observed.data?.data?.map(({ id, agent, model, location, parentID }) => ({
        id,
        agent,
        model,
        location,
        parentID,
      })),
    );
  }
  const created = structured(creationReply);
  const sessionId = created.session_id;
  assert.ok(sessionId);
  assert.equal(created.agent, "build");
  assert.equal(created.provider_id, "integration");
  assert.equal(created.model_id, "test-model");
  const empty = structured(
    await mcpClient.callTool({
      name: "get_session_history",
      arguments: { session_id: sessionId },
    }),
  );
  assert.equal(empty.messages.length, 0);
  assert.equal(providerRequests.length, 0, "creation started a model turn");
  const backendCreated = await backend.v2.session.get({ sessionID: sessionId });
  assert.equal(backendCreated.data?.data?.location.directory, project);
  assert.equal(backendCreated.data?.data?.parentID, undefined);
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

  const options = structured(
    await mcpClient.callTool({
      name: "get_session_runtime_options",
      arguments: { session_id: sessionId },
    }),
  );
  assert.ok(
    options.agents.includes("plan") && options.agents.includes("build"),
  );
  assert.ok(
    options.models.some(
      (model) =>
        model.provider_id === "integration" &&
        model.model_id === "other-model" &&
        model.variants.includes("high"),
    ),
  );
  for (const agent of ["plan", "build"]) {
    const update = structured(
      await mcpClient.callTool({
        name: "update_session_runtime",
        arguments: { session_id: sessionId, agent },
      }),
    );
    assert.equal(update.current.agent, agent);
    assert.equal(
      structured(
        await mcpClient.callTool({
          name: "get_session",
          arguments: { session_id: sessionId },
        }),
      ).agent,
      agent,
    );
  }
  const update = structured(
    await mcpClient.callTool({
      name: "update_session_runtime",
      arguments: {
        session_id: sessionId,
        model_id: "other-model",
        variant: "high",
      },
    }),
  );
  assert.equal(update.current.model_id, "other-model");
  assert.equal(update.current.variant, "high");
  const invalid = await mcpClient.callTool({
    name: "update_session_runtime",
    arguments: { session_id: sessionId, model_id: "missing-model" },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid._meta["opencode-vm/error"].code, "INVALID_MODEL");
  assert.equal(
    providerRequests.length,
    0,
    "runtime changes started model work",
  );
  const activityStart = structured(
    await mcpClient.callTool({ name: "get_project_activity", arguments: {} }),
  ).next_cursor;

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
  let activity;
  for (let attempt = 0; attempt < 80; attempt++) {
    activity = structured(
      await mcpClient.callTool({
        name: "get_project_activity",
        arguments: {
          after_cursor: activityStart,
          event_types: ["message.completed"],
        },
      }),
    );
    if (
      activity.events.some((event) => event.message_id === receipt.message_id)
    )
      break;
    await delay(100);
  }
  assert.ok(
    activity.events.some(
      (event) =>
        event.message_id === receipt.message_id &&
        event.session_id === sessionId,
    ),
    JSON.stringify(activity),
  );
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

  // Delivery A capability check: direct legacy reads preserve the identities
  // and parent relation used by the existing adapter; no history scan/model call.
  const callsBeforeDirectRead = providerRequests.length;
  const directMessage = await backend.session.message({
    sessionID: sessionId,
    messageID: backendNewest.data[0].info.id,
  });
  assert.deepEqual(directMessage.data, backendNewest.data[0]);
  assert.equal(directMessage.data.info.parentID, receipt.message_id);
  assert.equal(providerRequests.length, callsBeforeDirectRead);
  const absentMessage = await mcpClient.callTool({
    name: "get_message",
    arguments: { session_id: sessionId, message_id: "msg_missing" },
  });
  assert.equal(
    absentMessage._meta["opencode-vm/error"].code,
    "MESSAGE_NOT_FOUND",
  );
  const absentSession = await mcpClient.callTool({
    name: "get_message",
    arguments: { session_id: "ses_missing", message_id: "msg_missing" },
  });
  assert.equal(
    absentSession._meta["opencode-vm/error"].code,
    "SESSION_NOT_FOUND",
  );
  process.stderr.write(
    "[integration] direct message read preserves text, identity and parent correlation\n",
  );

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

  const reportSession = structured(
    await mcpClient.callTool({
      name: "create_session",
      arguments: { title: "Delivery A originals" },
    }),
  ).session_id;
  const reportReceipt = structured(
    await mcpClient.callTool({
      name: "send_message",
      arguments: { session_id: reportSession, message: "delivery-a-report" },
    }),
  );
  await waitForTask(reportSession, reportReceipt.message_id);
  const taskReport = structured(
    await mcpClient.callTool({
      name: "get_task_result",
      arguments: {
        session_id: reportSession,
        submitted_message_id: reportReceipt.message_id,
      },
    }),
  );
  assert.equal(taskReport.state, "completed");
  assert.equal(taskReport.search_complete, true);
  const reportId = taskReport.messages.find(
    (item) => item.result_kind === "terminal",
  ).id;
  const reportMessage = structured(
    await mcpClient.callTool({
      name: "get_message",
      arguments: { session_id: reportSession, message_id: reportId },
    }),
  ).message;
  const reportReference = reportMessage.content.content_ref;
  assert.equal(
    reportMessage.content.total_bytes,
    Buffer.byteLength(longReport),
  );
  const beforeReading = providerRequests.length;
  let reconstructed = "",
    contentCursor;
  do {
    const part = structured(
      await mcpClient.callTool({
        name: "read_message_content",
        arguments: {
          content_ref: reportReference,
          ...(contentCursor ? { cursor: contentCursor } : {}),
        },
      }),
    );
    assert.equal(part.range.start, Buffer.byteLength(reconstructed));
    reconstructed += part.text;
    contentCursor = part.next_cursor;
  } while (contentCursor);
  assert.equal(reconstructed, longReport);
  assert.equal(
    createHash("sha256").update(reconstructed).digest("hex"),
    reportMessage.content.sha256,
  );
  assert.equal(
    providerRequests.length,
    beforeReading,
    "reading originals invoked a model",
  );
  // Existing backend noReply storage produces history beyond the previous status
  // bound without executing a model or touching any user sessions.
  for (let index = 0; index < 105; index++) {
    await backend.session.prompt({
      sessionID: reportSession,
      noReply: true,
      parts: [{ type: "text", text: `synthetic-followup-${index}` }],
    });
  }
  assert.equal(
    providerRequests.length,
    beforeReading,
    "noReply history seeding invoked a model",
  );
  const followup = structured(
    await mcpClient.callTool({
      name: "send_message",
      arguments: { session_id: reportSession, message: "delivery-a-followup" },
    }),
  );
  await waitForTask(reportSession, followup.message_id);
  const olderStatus = structured(
    await mcpClient.callTool({
      name: "get_session_status",
      arguments: {
        session_id: reportSession,
        message_id: reportReceipt.message_id,
      },
    }),
  );
  assert.equal(olderStatus.state, "unknown");
  let searchCursor,
    oldResult,
    searchPages = 0;
  const oldMessages = [];
  do {
    oldResult = structured(
      await mcpClient.callTool({
        name: "get_task_result",
        arguments: {
          session_id: reportSession,
          submitted_message_id: reportReceipt.message_id,
          ...(searchCursor ? { cursor: searchCursor } : {}),
        },
      }),
    );
    oldMessages.push(...oldResult.messages);
    searchCursor = oldResult.next_cursor;
    searchPages++;
  } while (searchCursor);
  assert.ok(searchPages > 5);
  assert.equal(oldResult.state, "completed");
  assert.ok(
    oldMessages.some(
      (item) =>
        item.id === reportId && item.parent_id === reportReceipt.message_id,
    ),
  );
  const followupResult = structured(
    await mcpClient.callTool({
      name: "get_task_result",
      arguments: {
        session_id: reportSession,
        submitted_message_id: followup.message_id,
      },
    }),
  );
  assert.equal(followupResult.state, "completed");
  assert.ok(
    followupResult.messages.every(
      (item) => item.parent_id === followup.message_id,
    ),
  );
  for (const limit of [1, 20]) {
    const preview = structured(
      await mcpClient.callTool({
        name: "get_session_history",
        arguments: { session_id: reportSession, limit },
      }),
    );
    assert.ok(preview.messages.every((item) => item.content?.content_ref));
  }
  assert.ok(readResponseSizes.every((size) => size <= 64 * 1024));
  assert.ok(protocolObservations.has("negotiated:2025-11-25"));
  process.stderr.write(
    `[integration] Delivery A: ${Buffer.byteLength(longReport)} UTF-8 bytes reconstructed; old result recovered in ${searchPages} pages; protocol ${[...protocolObservations].join(", ")}; max read response ${Math.max(...readResponseSizes)} bytes\n`,
  );

  const progressSession = structured(
    await mcpClient.callTool({
      name: "create_session",
      arguments: { title: "Delivery B progress" },
    }),
  ).session_id;
  const progressReceipt = structured(
    await mcpClient.callTool({
      name: "send_message",
      arguments: { session_id: progressSession, message: "delivery-b-tool" },
    }),
  );
  let runningTool, toolMessage;
  for (let i = 0; i < 100; i++) {
    const messages = (
      await backend.session.messages({ sessionID: progressSession, limit: 100 })
    ).data;
    toolMessage = messages.find((item) =>
      item.parts.some(
        (part) => part.type === "tool" && part.state.status === "running",
      ),
    );
    runningTool = toolMessage?.parts.find(
      (part) => part.type === "tool" && part.state.status === "running",
    );
    if (runningTool) break;
    await delay(100);
  }
  assert.ok(runningTool, "backend must expose a running tool");
  assert.equal(runningTool.tool, "bash");
  assert.equal(typeof runningTool.state.time.start, "number");
  assert.equal(toolMessage.info.parentID, progressReceipt.message_id);
  const callsBeforeProgress = providerRequests.length;
  const liveProgress = structured(
    await mcpClient.callTool({
      name: "get_session_progress",
      arguments: {
        session_id: progressSession,
        message_id: progressReceipt.message_id,
      },
    }),
  );
  assert.equal(liveProgress.source, "backend_snapshot");
  assert.equal(liveProgress.in_flight_tools[0]?.tool, "bash");
  assert.equal(liveProgress.in_flight_tools[0]?.status, "running");
  assert.equal(
    liveProgress.in_flight_tools[0]?.task_message_id,
    progressReceipt.message_id,
  );
  assert.equal(liveProgress.in_flight_tools[0]?.call_id, runningTool.callID);
  assert.equal(
    liveProgress.in_flight_tools[0]?.started_at,
    runningTool.state.time.start,
  );
  assert.equal(providerRequests.length, callsBeforeProgress);
  assert.doesNotMatch(
    JSON.stringify(liveProgress),
    /B_PRIVATE|release-tool|command|description/,
  );
  await writeFile(toolGate, "release");
  await waitForTask(progressSession, progressReceipt.message_id);
  const finishedMessage = (
    await backend.session.message({
      sessionID: progressSession,
      messageID: toolMessage.info.id,
    })
  ).data;
  const finishedTool = finishedMessage.parts.find(
    (part) => part.type === "tool" && part.callID === runningTool.callID,
  );
  assert.equal(finishedTool.state.status, "completed");
  assert.equal(typeof finishedTool.state.time.end, "number");
  const finalProgress = structured(
    await mcpClient.callTool({
      name: "get_session_progress",
      arguments: {
        session_id: progressSession,
        message_id: progressReceipt.message_id,
      },
    }),
  );
  assert.equal(finalProgress.in_flight_tools.length, 0);
  assert.equal(finalProgress.last_finished_tool.status, "completed");
  assert.equal(
    finalProgress.last_finished_tool.finished_at,
    finishedTool.state.time.end,
  );
  assert.doesNotMatch(
    JSON.stringify(finalProgress),
    /B_PRIVATE|release-tool|command|description/,
  );
  process.stderr.write(
    "[integration] Delivery B: real tool name, running/completed states, start/end and parent correlation verified\n",
  );

  const secondSession = structured(
    await mcpClient.callTool({
      name: "create_session",
      arguments: { title: "Parallel B" },
    }),
  ).session_id;
  const parallelCursor = structured(
    await mcpClient.callTool({ name: "get_project_activity", arguments: {} }),
  ).next_cursor;
  const [parallelA, parallelB] = await Promise.all([
    mcpClient.callTool({
      name: "send_message",
      arguments: { session_id: sessionId, message: "parallel-A" },
    }),
    mcpClient.callTool({
      name: "send_message",
      arguments: { session_id: secondSession, message: "parallel-B" },
    }),
  ]).then((results) => results.map(structured));
  for (let i = 0; i < 100 && heldPrompts.size < 2; i++) await delay(100);
  assert.equal(
    heldPrompts.size,
    2,
    "both independent sessions must start work",
  );
  const busyUpdate = await mcpClient.callTool({
    name: "update_session_runtime",
    arguments: { session_id: sessionId, agent: "plan" },
  });
  assert.equal(busyUpdate._meta["opencode-vm/error"].code, "SESSION_BUSY");
  heldPrompts.get("parallel-A")();
  let firstCompletion;
  for (let i = 0; i < 100; i++) {
    firstCompletion = structured(
      await mcpClient.callTool({
        name: "get_project_activity",
        arguments: {
          after_cursor: parallelCursor,
          session_ids: [sessionId, secondSession],
          event_types: ["message.completed"],
        },
      }),
    );
    if (firstCompletion.events.length) break;
    await delay(100);
  }
  assert.deepEqual(
    firstCompletion.events.map((event) => event.message_id),
    [parallelA.message_id],
  );
  const recent = structured(
    await mcpClient.callTool({
      name: "get_project_activity",
      arguments: {
        tail: true,
        limit: 1,
        session_ids: [sessionId, secondSession],
        event_types: ["message.completed"],
      },
    }),
  );
  assert.equal(recent.events[0]?.message_id, parallelA.message_id);
  assert.equal(recent.tail.selection_complete, true);
  assert.equal(recent.has_more, false);
  assert.equal(recent.filter_key, firstCompletion.filter_key);
  const wait = mcpClient.callTool({
    name: "wait_for_project_activity",
    arguments: {
      after_cursor: recent.next_cursor,
      session_ids: [sessionId, secondSession],
      event_types: ["message.completed"],
      timeout_ms: 15000,
    },
  });
  heldPrompts.get("parallel-B")();
  const secondCompletion = structured(await wait);
  assert.equal(secondCompletion.filter_key, recent.filter_key);
  assert.equal(secondCompletion.timeout, false);
  assert.deepEqual(
    secondCompletion.events.map((event) => event.message_id),
    [parallelB.message_id],
  );
  const runtimeEvents = structured(
    await mcpClient.callTool({
      name: "get_project_activity",
      arguments: { event_types: ["session.runtime_changed"] },
    }),
  );
  assert.ok(runtimeEvents.events.length >= 3);

  await mcpClient.close();
  mcpClient = undefined;
  await stopChild(mcp);
  mcp = undefined;
  ({ child: mcp } = await startAdapter(runtimeFile, readyFile));
  mcpClient = await connectMcp(mcpPort, token);
  const expiredRead = await mcpClient.callTool({
    name: "read_message_content",
    arguments: { content_ref: reportReference },
  });
  assert.equal(
    expiredRead._meta["opencode-vm/error"].code,
    "READ_REFERENCE_EXPIRED",
  );
  const reacquired = structured(
    await mcpClient.callTool({
      name: "get_message",
      arguments: { session_id: reportSession, message_id: reportId },
    }),
  );
  assert.equal(reacquired.message.content.sha256, reportMessage.content.sha256);
  const persisted = structured(
    await mcpClient.callTool({
      name: "get_project_activity",
      arguments: {
        after_cursor: parallelCursor,
        session_ids: [sessionId, secondSession],
        event_types: ["message.completed"],
      },
    }),
  );
  assert.deepEqual(
    persisted.events.map((event) => event.message_id),
    [parallelA.message_id, parallelB.message_id],
  );
  assert.ok(persisted.next_cursor >= secondCompletion.next_cursor);
  assert.equal(persisted.filter_key, recent.filter_key);
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
  await writeFile(toolGate, "release").catch(() => {});
  for (const release of heldPrompts.values()) release();
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
    {
      requestInit: { headers: { "X-OCVM-MCP-Token": token } },
      fetch: async (url, init) => {
        const request =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const header = new Headers(init?.headers).get("mcp-protocol-version");
        if (header) protocolObservations.add(`header:${header}`);
        if (request?.method === "initialize")
          protocolObservations.add(`offered:${request.params.protocolVersion}`);
        const response = await fetch(url, init);
        if (
          response.headers.get("content-type")?.includes("application/json")
        ) {
          const body = await response.clone().text();
          if (request?.method === "initialize")
            protocolObservations.add(
              `negotiated:${JSON.parse(body).result.protocolVersion}`,
            );
          if (
            [
              "get_message",
              "read_message_content",
              "get_task_result",
              "get_session_history",
              "get_session_progress",
            ].includes(request?.params?.name)
          )
            readResponseSizes.push(Buffer.byteLength(body));
        }
        return response;
      },
    },
  );
  await client.connect(transport);
  return client;
}

async function waitForTask(sessionId, messageId) {
  for (let i = 0; i < 160; i++) {
    const status = structured(
      await mcpClient.callTool({
        name: "get_session_status",
        arguments: { session_id: sessionId, message_id: messageId },
      }),
    );
    if (status.state === "completed") return;
    assert.ok(
      !["failed", "aborted", "input_required"].includes(status.state),
      JSON.stringify(status),
    );
    await delay(100);
  }
  throw new Error("Synthetic report did not complete");
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
