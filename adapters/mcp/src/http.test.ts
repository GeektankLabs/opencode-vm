import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpHttpServer, MAX_REQUEST_BODY_BYTES } from "./http.js";
import type { SessionGateway } from "./opencode.js";
import { AdapterError } from "./types.js";
import type {
  ActivityQuery,
  ActivityResult,
  RuntimeOptions,
  RuntimePatch,
  RuntimeUpdateResult,
  ListSessionsResult,
  CreateSessionResult,
  ArchiveSessionResult,
  RuntimeDescriptor,
  SendMessageResult,
  SessionDetailsResult,
  SessionHistoryResult,
  SessionStatusResult,
  MessageResult,
  MessageContentResult,
  TaskResult,
  SessionProgressResult,
} from "./types.js";

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

class FakeGateway implements SessionGateway {
  async getSessionProgress(sessionId: string): Promise<SessionProgressResult> {
    return {
      session_id: sessionId,
      observed_at: new Date().toISOString(),
      source: "backend_snapshot",
      backend_activity: "idle",
      pending_input: { permissions: 0, questions: 0 },
      pending_input_scope: "session",
      in_flight_tools: [],
      idle_with_in_flight_tools: false,
      coverage: {
        message_limit: 100,
        messages_scanned: 0,
        history_has_more: false,
        in_flight_total: 0,
        in_flight_truncated: false,
        metadata_incomplete: false,
        unattributed_tools: 0,
      },
    };
  }
  async getMessage(): Promise<MessageResult> {
    throw new Error("fixture unused");
  }
  async readMessageContent(): Promise<MessageContentResult> {
    throw new Error("fixture unused");
  }
  async getTaskResult(): Promise<TaskResult> {
    throw new Error("fixture unused");
  }
  async getSessionRuntimeOptions(): Promise<RuntimeOptions> {
    return {
      agents: ["plan", "build"],
      providers: [{ provider_id: "provider", name: "Provider" }],
      models: [
        {
          provider_id: "provider",
          model_id: "model",
          name: "Model",
          variants: ["default", "high"],
        },
      ],
      truncated: false,
    };
  }
  async updateSessionRuntime(
    id: string,
    patch: RuntimePatch,
  ): Promise<RuntimeUpdateResult> {
    const previous = {
      agent: "plan",
      provider_id: "provider",
      model_id: "model",
      variant: "default",
    };
    return {
      session_id: id,
      previous,
      current: { ...previous, ...patch },
      state: "updated",
    };
  }
  async getProjectActivity(_query?: ActivityQuery): Promise<ActivityResult> {
    return {
      events: [],
      next_cursor: "cursor",
      has_more: false,
      tracking: { connected: true, partial: false },
    };
  }
  async waitForProjectActivity(
    query: ActivityQuery & { after_cursor: string; timeout_ms?: number },
  ): Promise<ActivityResult & { timeout: boolean }> {
    return { ...(await this.getProjectActivity(query)), timeout: true };
  }
  listEntered: (() => void) | undefined;
  listBarrier: Promise<void> | undefined;
  createCalls: Array<string | undefined> = [];
  archiveCalls: string[] = [];

  async archiveSession(sessionId: string): Promise<ArchiveSessionResult> {
    this.archiveCalls.push(sessionId);
    return { session_id: sessionId, state: "archived", archived_at: 3 };
  }

  async createSession(title?: string): Promise<CreateSessionResult> {
    this.createCalls.push(title);
    return {
      project: { id: "hash", name: "project" },
      session_id: "ses_new",
      title: title ?? "MCP Work Session",
      agent: "build",
      provider_id: "provider",
      model_id: "model",
      state: "created",
    };
  }

  async listSessions(): Promise<ListSessionsResult> {
    this.listEntered?.();
    await this.listBarrier;
    return {
      project: { id: "hash", name: "project" },
      sessions: [
        { id: "ses", title: "Work", created: 1, updated: 2, activity: "idle" },
      ],
      truncated: false,
    };
  }

  async getSessionDetails(): Promise<SessionDetailsResult> {
    throw new Error("backend-secret-must-not-leak");
  }

  async getSessionStatus(
    sessionId: string,
    messageId?: string,
  ): Promise<SessionStatusResult> {
    return {
      session_id: sessionId,
      ...(messageId ? { message_id: messageId } : {}),
      backend_activity: "idle",
      state: "unknown",
      pending_input: { permissions: 0, questions: 0 },
      assistant_message_ids: [],
    };
  }

  async getSessionHistory(sessionId: string): Promise<SessionHistoryResult> {
    return { session_id: sessionId, messages: [], truncated: false };
  }

  async sendMessage(sessionId: string): Promise<SendMessageResult> {
    return {
      session_id: sessionId,
      message_id: "msg_receipt",
      state: "submitted",
    };
  }
}

test("official MCP client discovers fifteen stateless HTTP tools and invokes archive by ID", async () => {
  const gateway = new FakeGateway();
  const server = new McpHttpServer(runtime(), token, gateway);
  const port = await server.start();
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } },
  );
  const client = new Client({ name: "ocvm-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "archive_session",
      "create_session",
      "get_message",
      "get_project_activity",
      "get_session",
      "get_session_history",
      "get_session_progress",
      "get_session_runtime_options",
      "get_session_status",
      "get_task_result",
      "list_sessions",
      "read_message_content",
      "send_message",
      "update_session_runtime",
      "wait_for_project_activity",
    ]);
    const listTool = listed.tools.find((tool) => tool.name === "list_sessions");
    const sendTool = listed.tools.find((tool) => tool.name === "send_message");
    assert.equal(listTool?.annotations?.readOnlyHint, true);
    assert.equal(sendTool?.annotations?.destructiveHint, true);
    assert.equal(sendTool?.annotations?.idempotentHint, false);
    const createTool = listed.tools.find(
      (tool) => tool.name === "create_session",
    );
    assert.equal(createTool?.annotations?.readOnlyHint, false);
    assert.equal(createTool?.annotations?.idempotentHint, false);
    assert.equal(createTool?.annotations?.destructiveHint, false);
    const archiveTool = listed.tools.find(
      (tool) => tool.name === "archive_session",
    );
    assert.equal(archiveTool?.annotations?.destructiveHint, true);
    const created = await client.callTool({
      name: "create_session",
      arguments: { title: "  New work  " },
    });
    assert.equal(
      (created.structuredContent as Record<string, unknown>)?.session_id,
      "ses_new",
    );
    assert.deepEqual(gateway.createCalls, ["New work"]);
    const archived = await client.callTool({
      name: "archive_session",
      arguments: { session_id: "ses" },
    });
    assert.equal(
      (archived.structuredContent as Record<string, unknown>)?.state,
      "archived",
    );
    assert.deepEqual(gateway.archiveCalls, ["ses"]);
    for (const request of [
      { name: "get_session_runtime_options", arguments: {} },
      { name: "get_session_progress", arguments: { session_id: "ses" } },
      {
        name: "update_session_runtime",
        arguments: { session_id: "ses", agent: "build" },
      },
      { name: "get_project_activity", arguments: {} },
      {
        name: "wait_for_project_activity",
        arguments: { after_cursor: "cursor", timeout_ms: 1 },
      },
    ]) {
      const result = await client.callTool(request);
      assert.ok(!result.isError);
      assert.ok(result.structuredContent);
    }

    const result = await client.callTool({
      name: "list_sessions",
      arguments: {},
    });
    assert.ok("structuredContent" in result);
    assert.deepEqual(result.structuredContent, {
      project: { id: "hash", name: "project" },
      sessions: [
        { id: "ses", title: "Work", created: 1, updated: 2, activity: "idle" },
      ],
      truncated: false,
    });
    const status = await client.callTool({
      name: "get_session_status",
      arguments: { session_id: "ses", message_id: "msg" },
    });
    assert.ok("structuredContent" in status);
    assert.equal(
      (status.structuredContent as Record<string, unknown> | undefined)?.state,
      "unknown",
    );
    const history = await client.callTool({
      name: "get_session_history",
      arguments: { session_id: "ses" },
    });
    assert.ok("structuredContent" in history);
    assert.deepEqual(
      (history.structuredContent as Record<string, unknown> | undefined)
        ?.messages,
      [],
    );
    const sent = await client.callTool({
      name: "send_message",
      arguments: { session_id: "ses", message: "continue" },
    });
    assert.ok("structuredContent" in sent);
    assert.equal(
      (sent.structuredContent as Record<string, unknown> | undefined)
        ?.message_id,
      "msg_receipt",
    );

    for (const request of [
      {
        name: "get_message",
        arguments: { session_id: "ses", message_id: "msg", path: "/secret" },
      },
      {
        name: "read_message_content",
        arguments: { content_ref: "file:///secret" },
      },
      {
        name: "read_message_content",
        arguments: { content_ref: "valid.shape", max_bytes: 0 },
      },
      {
        name: "get_task_result",
        arguments: {
          session_id: "ses",
          submitted_message_id: "msg",
          limit: 21,
        },
      },
      { name: "update_session_runtime", arguments: { session_id: "ses" } },
      { name: "get_project_activity", arguments: { limit: 101 } },
      {
        name: "get_project_activity",
        arguments: { tail: true, after_cursor: "cursor" },
      },
      { name: "get_project_activity", arguments: { tail: "true" } },
      {
        name: "wait_for_project_activity",
        arguments: { tail: true, after_cursor: "cursor" },
      },
      {
        name: "get_session_progress",
        arguments: { session_id: "ses", include_output: true },
      },
      {
        name: "get_session_progress",
        arguments: { session_id: "ses", message_id: "bad id" },
      },
      {
        name: "wait_for_project_activity",
        arguments: { after_cursor: "cursor", timeout_ms: 15001 },
      },
      { name: "create_session", arguments: { directory: "/other" } },
      { name: "create_session", arguments: { parentID: "ses" } },
      { name: "create_session", arguments: { agent: "openlive-manager" } },
      {
        name: "create_session",
        arguments: {
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        },
      },
      { name: "create_session", arguments: { title: " " } },
      { name: "create_session", arguments: { title: "x".repeat(161) } },
      { name: "create_session", arguments: { title: "bad\nname" } },
      {
        name: "archive_session",
        arguments: { session_id: "ses", delete: true },
      },
      { name: "archive_session", arguments: { session_id: "bad id" } },
      {
        name: "get_message",
        arguments: {
          session_id: "ses",
          message_id: "msg",
          include_archived: "true",
        },
      },
      { name: "list_sessions", arguments: { limit: 0 } },
      {
        name: "get_session_history",
        arguments: { session_id: "ses", limit: 21 },
      },
      { name: "list_sessions", arguments: { unexpected: true } },
      { name: "get_session", arguments: { session_id: "bad id" } },
      {
        name: "get_session_status",
        arguments: { session_id: "ses", message_id: "bad\nmessage" },
      },
    ]) {
      const invalid = await client.callTool(request);
      assert.equal("isError" in invalid && invalid.isError, true);
      assert.deepEqual(invalid.content, [
        {
          type: "text",
          text: "INVALID_ARGUMENT: Tool arguments are invalid.",
        },
      ]);
    }
    assert.equal(
      gateway.createCalls.length,
      1,
      "invalid creation input reached the backend",
    );

    const failed = await client.callTool({
      name: "get_session",
      arguments: { session_id: "ses" },
    });
    assert.equal("isError" in failed && failed.isError, true);
    assert.doesNotMatch(JSON.stringify(failed), /backend-secret/u);
    assert.match(JSON.stringify(failed), /INTERNAL_ERROR/u);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
});

test("raw MCP responses preserve busy/unresolved error codes and receipt reasons, including JSON-RPC id zero", async () => {
  const gateway = new FakeGateway();
  const server = new McpHttpServer(runtime(), token, gateway);
  const port = await server.start();
  try {
    for (const error of [
      new AdapterError(
        "SESSION_BUSY",
        "Backend is busy; no new submission.",
        "msg_previous",
        "backend_active",
      ),
      new AdapterError(
        "SUBMISSION_UNRESOLVED",
        "Idle with an unresolved earlier receipt; no new submission.",
        "msg_previous",
        "receipt_not_terminal",
      ),
    ]) {
      gateway.sendMessage = async () => {
        throw error;
      };
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "X-OCVM-MCP-Token": token,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: { session_id: "ses_123", message: "authorized fixture" },
          },
        }),
      });
      assert.equal(response.status, 200);
      const wire = (await response.json()) as {
        id: number;
        error?: unknown;
        result: {
          isError: boolean;
          error_code?: unknown;
          _meta: Record<string, unknown>;
          content: Array<{ text: string }>;
        };
      };
      assert.equal(wire.id, 0);
      assert.equal(wire.error, undefined);
      assert.equal(wire.result.isError, true);
      assert.equal(
        wire.result.error_code,
        undefined,
        "adapter does not invent a generic outer INVALID_ARGUMENT code",
      );
      assert.deepEqual(wire.result._meta["opencode-vm/error"], {
        code: error.code,
        message: error.message,
        message_id: "msg_previous",
        reason: error.reason,
      });
      assert.match(wire.result.content[0]!.text, new RegExp(`^${error.code}:`));
    }
  } finally {
    await server.close();
  }
});

test("HTTP boundary enforces authentication, Host, Origin, methods, and body limits", async () => {
  const server = new McpHttpServer(runtime(), token, new FakeGateway());
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/healthz`, {
          headers: {
            "X-OCVM-MCP-Token": token,
            Origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await rawRequest(port, "/healthz", "GET", {
          Host: "evil.example",
          "X-OCVM-MCP-Token": token,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/mcp`, {
          headers: { "X-OCVM-MCP-Token": token },
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "X-OCVM-MCP-Token": token,
            "Content-Type": "application/json",
          },
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "X-OCVM-MCP-Token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ padding: "x".repeat(MAX_REQUEST_BODY_BYTES) }),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await rawRequest(
          port,
          "/mcp",
          "POST",
          {
            "X-OCVM-MCP-Token": token,
            "Content-Type": "application/json",
          },
          JSON.stringify({ padding: "x".repeat(MAX_REQUEST_BODY_BYTES) }),
        )
      ).status,
      413,
    );
    const health = await fetch(`${base}/healthz`, {
      headers: { "X-OCVM-MCP-Token": token },
    });
    assert.equal(health.status, 200);
    assert.equal(
      ((await health.json()) as { project: { id: string } }).project.id,
      "hash",
    );
  } finally {
    await server.close();
  }
});

test("HTTP concurrency is bounded across tool requests", async () => {
  const gateway = new FakeGateway();
  let enterList: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enterList = resolve;
  });
  let releaseList: (() => void) | undefined;
  gateway.listBarrier = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  gateway.listEntered = enterList;
  const server = new McpHttpServer(runtime(), token, gateway, 1);
  const port = await server.start();
  const client = new Client({ name: "concurrency-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } },
  );
  try {
    await client.connect(transport);
    const call = client.callTool({ name: "list_sessions", arguments: {} });
    await entered;
    const overloaded = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { "X-OCVM-MCP-Token": token },
    });
    assert.equal(overloaded.status, 503);
    releaseList?.();
    await call;
  } finally {
    releaseList?.();
    await client.close().catch(() => undefined);
    await server.close();
  }
});

test("official MCP client cancellation rejects a pending tool call", async () => {
  const gateway = new FakeGateway();
  let enterList: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enterList = resolve;
  });
  let releaseList: (() => void) | undefined;
  gateway.listBarrier = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  gateway.listEntered = enterList;
  const server = new McpHttpServer(runtime(), token, gateway);
  const port = await server.start();
  const client = new Client({ name: "cancellation-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } },
  );
  try {
    await client.connect(transport);
    const controller = new AbortController();
    const call = client.callTool(
      { name: "list_sessions", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await entered;
    controller.abort();
    await assert.rejects(call, /abort|cancel/iu);
  } finally {
    releaseList?.();
    await client.close().catch(() => undefined);
    await server.close();
  }
});

function rawRequest(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}
