import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpHttpServer, MAX_REQUEST_BODY_BYTES } from "./http.js";
import type { SessionGateway } from "./opencode.js";
import type { AttachmentDescriptor } from "./attachments.js";
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
  RenameSessionResult,
  RuntimeDescriptor,
  SendMessageResult,
  SessionDetailsResult,
  SessionHistoryResult,
  SessionStatusResult,
  MessageResult,
  MessageContentResult,
  TaskResult,
  SessionProgressResult,
  SubmissionGuardOverrideInput,
  SubmissionGuardOverrideResult,
} from "./types.js";

const token = "test-token-" + "x".repeat(43);

test("profile MCP reads resolve an exact configured runtime without mutating the session", async () => {
  const project = await mkdtemp(join(tmpdir(), "ocvm-policy-wire-"));
  await mkdir(join(project, ".opencode-vm"));
  await writeFile(join(project, ".opencode-vm", "agent-control.json"), JSON.stringify({
    schemaVersion: 1, revision: 1, updatedAt: "2026-09-28T18:00:00Z",
    profiles: { deep: { provider_id: "provider", model_id: "model", variant: "high" }, standard: null, execution: null },
  }));
  const gateway = new FakeGateway();
  const adapter = new McpHttpServer({ ...runtime(), project }, token, gateway);
  const port = await adapter.start();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } });
  const client = new Client({ name: "policy-wire", version: "1.0.0" });
  try {
    await client.connect(transport);
    const policy = await client.callTool({ name: "get_project_model_policy", arguments: {} });
    assert.equal((policy.structuredContent as { profiles: { deep: { status: string } } }).profiles.deep.status, "available");
    const result = await client.callTool({ name: "get_recommended_runtime", arguments: { profile: "deep" } });
    assert.deepEqual((result.structuredContent as { runtime: object }).runtime,
      { provider_id: "provider", model_id: "model", variant: "high" });
    assert.deepEqual(gateway.updateCalls, []);
  } finally {
    await client.close(); await adapter.close(); await rm(project, { recursive: true, force: true });
  }
});

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
  updateCalls: Array<{ id: string; patch: RuntimePatch }> = [];
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
  async getTaskResult(
    sessionId: string,
    submittedMessageId: string,
  ): Promise<TaskResult> {
    return {
      session_id: sessionId,
      submitted_message_id: submittedMessageId,
      state: "unknown",
      state_reason: "superseded_by_later_completed_turn",
      superseded_by_message_id: "msg_later",
      observed_at: new Date().toISOString(),
      source: "backend",
      search_complete: true,
      order: "newest_first",
      messages: [],
    };
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
    this.updateCalls.push({ id, patch });
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
  renameCalls: Array<{ session_id: string; title: string }> = [];
  uploadCalls: Array<{
    session_id: string;
    filename: string;
    mime_type: string;
    data_base64: string;
  }> = [];
  sendCalls: Array<{
    session_id: string;
    message: string;
    attachments?: string[];
  }> = [];
  supersedeCalls: SubmissionGuardOverrideInput[] = [];

  async archiveSession(sessionId: string): Promise<ArchiveSessionResult> {
    this.archiveCalls.push(sessionId);
    return { session_id: sessionId, state: "archived", archived_at: 3 };
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<RenameSessionResult> {
    this.renameCalls.push({ session_id: sessionId, title });
    return { session_id: sessionId, title: title.trim(), state: "renamed" };
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

  async getSessionDetails(_sessionId: string): Promise<SessionDetailsResult> {
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

  async uploadAttachment(
    sessionId: string,
    filename: string,
    mimeType: string,
    dataBase64: string,
  ): Promise<AttachmentDescriptor> {
    this.uploadCalls.push({
      session_id: sessionId,
      filename,
      mime_type: mimeType,
      data_base64: dataBase64,
    });
    return {
      attachment_id: "att_0123456789abcdef0123456789abcdef",
      filename,
      mime_type: "image/png",
      size_bytes: 4,
      sha256: "a".repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: string[],
  ): Promise<SendMessageResult> {
    this.sendCalls.push({
      session_id: sessionId,
      message,
      ...(attachments ? { attachments } : {}),
    });
    return {
      session_id: sessionId,
      message_id: "msg_receipt",
      state: "submitted",
      ...(attachments?.length
        ? {
            attachments: attachments.map((attachment_id) => ({
              attachment_id,
              filename: "mockup.png",
              mime_type: "image/png",
              size_bytes: 4,
              sha256: "a".repeat(64),
            })),
          }
        : {}),
    };
  }

  async supersedeUnresolvedSubmission(
    input: SubmissionGuardOverrideInput,
  ): Promise<SubmissionGuardOverrideResult> {
    this.supersedeCalls.push(input);
    return {
      session_id: input.sessionId,
      guarded_message_id: input.guardedMessageId,
      request_id: input.requestId,
      message_id: "msg_superseding",
      state: "submitted",
      resolution: "superseded_by_operator",
      superseded_at: new Date().toISOString(),
      submitted_at: new Date().toISOString(),
      authorization_source: "operator_asserted",
      preflight: {
        observed_at: new Date().toISOString(),
        backend_activity: "idle",
        active_assistant_message_ids: [],
        in_flight_tools: [],
        pending_input: { permissions: 0, questions: 0 },
        guarded_message_id: input.guardedMessageId,
        guarded_receipt_state: "unknown",
        coverage: {
          message_limit: 100,
          messages_scanned: 1,
          history_has_more: false,
          in_flight_total: 0,
          in_flight_truncated: false,
          metadata_incomplete: false,
          unattributed_tools: 0,
        },
      },
      activity_cursor: "cursor",
    };
  }
}

test("official MCP client discovers twenty stateless HTTP tools and invokes session tools by ID", async () => {
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
      "get_project_model_policy",
      "get_recommended_runtime",
      "get_session",
      "get_session_history",
      "get_session_progress",
      "get_session_runtime_options",
      "get_session_status",
      "get_task_result",
      "list_sessions",
      "read_message_content",
      "rename_session",
      "send_message",
      "supersede_unresolved_submission",
      "update_session_runtime",
      "upload_attachment",
      "wait_for_project_activity",
    ]);
    const listTool = listed.tools.find((tool) => tool.name === "list_sessions");
    const sendTool = listed.tools.find((tool) => tool.name === "send_message");
    assert.equal(listed.tools.find((tool) => tool.name === "get_project_model_policy")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "get_recommended_runtime")?.annotations?.readOnlyHint, true);
    const policy = await client.callTool({ name: "get_project_model_policy", arguments: {} });
    assert.equal((policy.structuredContent as { revision: number }).revision, 0);
    const recommendation = await client.callTool({ name: "get_recommended_runtime", arguments: { profile: "deep" } });
    assert.equal((recommendation.structuredContent as { status: string }).status, "unconfigured");
    assert.equal((recommendation.structuredContent as Record<string, unknown> | undefined)?.runtime, undefined);
    assert.equal(listTool?.annotations?.readOnlyHint, true);
    assert.equal(sendTool?.annotations?.destructiveHint, true);
    assert.equal(sendTool?.annotations?.idempotentHint, false);
    const uploadTool = listed.tools.find(
      (tool) => tool.name === "upload_attachment",
    );
    assert.equal(uploadTool?.annotations?.readOnlyHint, false);
    assert.equal(uploadTool?.annotations?.destructiveHint, false);
    assert.equal(uploadTool?.annotations?.idempotentHint, false);
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
    const renameTool = listed.tools.find(
      (tool) => tool.name === "rename_session",
    );
    assert.equal(renameTool?.annotations?.readOnlyHint, false);
    assert.equal(renameTool?.annotations?.destructiveHint, false);
    assert.equal(renameTool?.annotations?.idempotentHint, true);
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
    const renamed = await client.callTool({
      name: "rename_session",
      arguments: { session_id: "ses", title: "  New title  " },
    });
    assert.equal(
      (renamed.structuredContent as Record<string, unknown>)?.title,
      "New title",
    );
    assert.deepEqual(gateway.renameCalls, [
      { session_id: "ses", title: "  New title  " },
    ]);
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
    const taskResult = await client.callTool({
      name: "get_task_result",
      arguments: { session_id: "ses", submitted_message_id: "msg_old" },
    });
    assert.equal(
      (taskResult.structuredContent as Record<string, unknown> | undefined)
        ?.state_reason,
      "superseded_by_later_completed_turn",
    );
    assert.equal(
      (taskResult.structuredContent as Record<string, unknown> | undefined)
        ?.superseded_by_message_id,
      "msg_later",
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
    assert.deepEqual(gateway.sendCalls.at(-1), {
      session_id: "ses",
      message: "continue",
    });
    const overrideRequestId = "01234567-89ab-4def-8123-456789abcdef";
    const override = await client.callTool({
      name: "supersede_unresolved_submission",
      arguments: {
        session_id: "ses",
        guarded_message_id: "msg_old",
        request_id: overrideRequestId,
        operator_authorized: true,
        reason: "Reviewed the old unresolved receipt; continue once.",
        message: "continue with the approved task",
      },
    });
    assert.equal(override.isError, undefined);
    assert.equal(
      (override.structuredContent as Record<string, unknown>)?.message_id,
      "msg_superseding",
    );
    assert.deepEqual(gateway.supersedeCalls.at(-1), {
      sessionId: "ses",
      guardedMessageId: "msg_old",
      requestId: overrideRequestId,
      operatorAuthorized: true,
      reason: "Reviewed the old unresolved receipt; continue once.",
      message: "continue with the approved task",
    });
    const overrideTool = listed.tools.find(
      (tool) => tool.name === "supersede_unresolved_submission",
    );
    assert.equal(overrideTool?.annotations?.idempotentHint, true);
    const upload = await client.callTool({
      name: "upload_attachment",
      arguments: {
        session_id: "ses",
        filename: "mockup.png",
        mime_type: "image/png",
        data_base64: "iVBORw0KGgo=",
      },
    });
    assert.equal(upload.isError, undefined);
    assert.equal(
      (upload.structuredContent as Record<string, unknown>)?.attachment_id,
      "att_0123456789abcdef0123456789abcdef",
    );
    assert.deepEqual(gateway.uploadCalls.at(-1), {
      session_id: "ses",
      filename: "mockup.png",
      mime_type: "image/png",
      data_base64: "iVBORw0KGgo=",
    });
    const attached = await client.callTool({
      name: "send_message",
      arguments: {
        session_id: "ses",
        message: "Use this as a visual reference.",
        attachments: ["att_0123456789abcdef0123456789abcdef"],
      },
    });
    assert.equal(attached.isError, undefined);
    assert.deepEqual(gateway.sendCalls.at(-1), {
      session_id: "ses",
      message: "Use this as a visual reference.",
      attachments: ["att_0123456789abcdef0123456789abcdef"],
    });

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
      { name: "rename_session", arguments: { session_id: "bad id", title: "Valid" } },
      { name: "rename_session", arguments: { session_id: "ses", title: "" } },
      { name: "rename_session", arguments: { session_id: "ses", title: "   " } },
      { name: "rename_session", arguments: { session_id: "ses", title: "x".repeat(161) } },
      { name: "rename_session", arguments: { session_id: "ses", title: "bad\nname" } },
      { name: "rename_session", arguments: { session_id: "ses", title: "bad\u0085name" } },
      { name: "rename_session", arguments: { session_id: "ses", title: "Valid", unknown: true } },
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
        name: "upload_attachment",
        arguments: {
          session_id: "ses",
          filename: "secret.png",
          mime_type: "image/png",
          data_base64: "Ynl0ZXM=",
          path: "/etc/passwd",
        },
      },
      {
        name: "supersede_unresolved_submission",
        arguments: {
          session_id: "ses",
          guarded_message_id: "msg_old",
          request_id: "01234567-89ab-cdef-0123-456789abcdef",
          operator_authorized: false,
          message: "continue",
        },
      },
      {
        name: "supersede_unresolved_submission",
        arguments: {
          session_id: "ses",
          guarded_message_id: "msg_old",
          request_id: "01234567-89ab-4def-8123-456789abcdef",
          message: "continue",
        },
      },
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

test("MCP board search, reverse lookup, complete links and overflow use the public schemas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-wire-"));
  let rows = [{ id: "backend-1", projectId: "backend-project", title: "Review work", description: "Searchable body",
    status: "todo", priority: "medium" }];
  const backend = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/projects") response.end(JSON.stringify([{ id: "backend-project", prefix: "OCHASH", name: "project", status: "active" }]));
    else if (request.url === "/api/tickets" || request.url?.startsWith("/api/tickets?")) response.end(JSON.stringify(rows));
    else if (request.url === "/api/tickets/backend-1") response.end(JSON.stringify(rows[0]));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: "not found" })); }
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as { port: number }).port;
  class BoardGateway extends FakeGateway {
    override async getSessionDetails(id: string): Promise<SessionDetailsResult> {
      if (id !== "ses") throw new AdapterError("SESSION_NOT_FOUND", "Session was not found.");
      return { id, title: "Work", created: 1, updated: 2, activity: "idle",
        pending_input: { permissions: 0, questions: 0 } };
    }
  }
  const descriptor = { ...runtime(), projectHash: "hash", taskboardUrl: `http://127.0.0.1:${backendPort}`,
    taskboardMetadataFile: join(directory, "board.json") };
  const server = new McpHttpServer(descriptor, token, new BoardGateway());
  const port = await server.start();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } });
  const client = new Client({ name: "board-wire-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.equal(catalog.tools.filter((tool) => tool.name.endsWith("_project_task") ||
      ["list_project_tasks", "add_task_comment", "link_task_to_session", "list_board_projects",
        "get_board_project", "create_board_project", "get_task_transfer_status"].includes(tool.name)).length, 13);
    assert.equal(catalog.tools.find((tool) => tool.name === "list_project_tasks")?.annotations?.readOnlyHint, true);
    assert.equal(catalog.tools.find((tool) => tool.name === "reclassify_project_task")?.annotations?.readOnlyHint, false);
    const projects = await client.callTool({ name: "list_board_projects", arguments: {} });
    assert.equal(projects.isError, undefined);
    assert.equal((projects.structuredContent as { projects: Array<{ board_project_id: string; is_default: boolean }> })
      .projects[0]?.board_project_id, "project_hash");
    const knownBoard = await client.callTool({ name: "get_board_project", arguments: { board_project_id: "project_hash" } });
    assert.equal((knownBoard.structuredContent as { is_default: boolean }).is_default, true);
    const found = await client.callTool({ name: "list_project_tasks", arguments: { query: "searchable" } });
    assert.equal(found.isError, undefined);
    const tasks = (found.structuredContent as { tasks: Array<{ task_id: string }> }).tasks;
    assert.equal(tasks.length, 1);
    const id = tasks[0]!.task_id;
    assert.equal((found.structuredContent as { tasks: Array<{ board_project_id: string }> }).tasks[0]?.board_project_id,
      "project_hash");
    const foreign = await client.callTool({ name: "link_task_to_session", arguments: { task_id: id, session_id: "foreign" } });
    assert.equal(foreign.isError, true);
    assert.equal((foreign._meta as Record<string, any>)["opencode-vm/error"].code, "SESSION_NOT_FOUND");
    for (const [message, result] of [["msg_one", "First"], ["msg_two", "Second"]]) {
      const linked = await client.callTool({ name: "link_task_to_session", arguments: {
        task_id: id, session_id: "ses", message_id: message, result, artifact_refs: [`artifact:${message}`],
      } });
      assert.equal(linked.isError, undefined);
    }
    const linkedTask = await client.callTool({ name: "get_project_task", arguments: { task_id: id } });
    assert.deepEqual((linkedTask.structuredContent as { links: Array<{ message_id: string }> }).links.map((link) => link.message_id),
      ["msg_one", "msg_two"]);
    const reversed = await client.callTool({ name: "list_project_tasks", arguments: { session_id: "ses" } });
    assert.deepEqual((reversed.structuredContent as { tasks: Array<{ task_id: string }> }).tasks.map((task) => task.task_id), [id]);
    rows = Array.from({ length: 501 }, (_, index) => ({ id: `id-${index}`, projectId: "backend-project",
      title: "Other", description: "", status: "todo", priority: "medium" }));
    const overflow = await client.callTool({ name: "list_project_tasks", arguments: { query: "absent" } });
    assert.equal(overflow.isError, true);
    assert.equal((overflow._meta as Record<string, any>)["opencode-vm/error"].code, "TASK_SEARCH_INCOMPLETE");
    assert.equal(overflow.structuredContent, undefined);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
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
