import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpHttpServer, MAX_REQUEST_BODY_BYTES } from "./http.js";
import { MCP_EVENT_DEFINITIONS } from "./events.js";
import { lastToolRoundtrips, traceToolCall } from "./diagnostics.js";
import { readRegistrySnapshot, withRegistry } from "./monitor.js";
import type { SessionGateway } from "./opencode.js";
import type { AttachmentDescriptor } from "./attachments.js";
import { AdapterError, ADAPTER_VERSION } from "./types.js";
import type {
  AttentionResult,
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
  AbortSessionTurnResult,
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
    const review = await client.callTool({ name: "get_recommended_runtime", arguments: { profile: "review" } });
    assert.deepEqual(review.structuredContent, { profile: "review", policy_revision: 1, status: "available",
      resolved_profile: "deep", resolved_label: "deep.main", resolution_path: ["review", "deep"],
      runtime: { provider_id: "provider", model_id: "model", variant: "high" },
      candidates: [{ label: "deep.main", disabled: false, status: "available" }] });
    const path = join(project, ".opencode-vm", "agent-control.json");
    const upgraded = { schemaVersion: 2, revision: 2, updatedAt: "2026-09-30T03:00:00Z", profiles: {
      deep: { provider_id: "provider", model_id: "model", variant: "gone" },
      standard: { provider_id: "provider", model_id: "model", variant: "high" }, execution: null, design: null, review: null } };
    await writeFile(path, JSON.stringify(upgraded));
    const blocked = await client.callTool({ name: "get_recommended_runtime", arguments: { profile: "review" } });
    assert.deepEqual(blocked.structuredContent, { profile: "review", policy_revision: 2, status: "variant_unavailable",
      resolved_profile: "deep", resolved_label: "deep.main", resolution_path: ["review", "deep"],
      candidates: [{ label: "deep.main", disabled: false, status: "variant_unavailable" },
        { label: "standard.main", disabled: false, status: "not_evaluated" }] });
    const design = await client.callTool({ name: "get_recommended_runtime", arguments: { profile: "design" } });
    assert.equal((design.structuredContent as { resolved_profile: string }).resolved_profile, "standard");
    assert.equal(await readFile(path, "utf8"), JSON.stringify(upgraded));
    const listed = await client.listTools();
    const schema = listed.tools.find(tool => tool.name === "get_recommended_runtime")?.inputSchema;
    assert.deepEqual((schema?.properties?.profile as { enum: string[] }).enum, ["deep", "standard", "execution", "design", "review"]);
    assert.deepEqual(gateway.updateCalls, []);
  } finally {
    await client.close(); await adapter.close(); await rm(project, { recursive: true, force: true });
  }
});

test("routing tool content text mirrors compact non-secret core metadata (crosschecks structuredContent)", async () => {
  const project = await mkdtemp(join(tmpdir(), "ocvm-policy-content-"));
  await mkdir(join(project, ".opencode-vm"));
  const selection = { provider_id: "provider", model_id: "model", variant: "high" };
  const ownFallback = { provider_id: "provider", model_id: "model", variant: "default" };
  await writeFile(join(project, ".opencode-vm", "agent-control.json"), JSON.stringify({
    schemaVersion: 5, revision: 3, updatedAt: "2026-10-13T00:00:00Z",
    profiles: { deep: selection, standard: null, execution: null, design: null, review: null },
    finalFallback: { mode: "total", selection: ownFallback },
    profileFallbacks: { deep: ownFallback, standard: null, execution: null, design: null, review: null },
    strategies: { degrading: true, providerSkip: false },
    disabled: { profiles: { deep: true, standard: false, execution: false, design: false, review: false },
      profileFallbacks: { deep: false, standard: false, execution: false, design: false, review: false },
      finalFallback: false },
  }));
  const gateway = new FakeGateway();
  const adapter = new McpHttpServer({ ...runtime(), project }, token, gateway);
  const port = await adapter.start();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } });
  const client = new Client({ name: "policy-content", version: "1.0.0" });
  const text = (result: unknown): string => {
    const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
    return Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") : "";
  };
  try {
    await client.connect(transport);
    const policy = await client.callTool({ name: "get_project_model_policy", arguments: {} });
    const policyText = text(policy);
    const policyData = policy.structuredContent as { revision: number; schema_version: number; profiles: { deep: { status: string; disabled: boolean } } };
    assert.equal(policyData.revision, 3);
    assert.equal(policyData.schema_version, 5);
    assert.match(policyText, /schema=5 revision=3/);
    assert.match(policyText, /deep=provider\/model\/high\[available,disabled\]/, "the disabled primary slot is mirrored honestly");
    assert.match(policyText, /regime=per_profile/);
    assert.match(policyText, /degrading=true/);
    assert.match(policyText, /Final fallback: provider\/model\/default\[available,mode=total\]/);
    assert.match(policyText, /deep\.fallback/);
    // No secrets, endpoints, credential paths or auth tokens in the model-readable text.
    for (const forbidden of [token, "/credential", "127.0.0.1", "http://"]) {
      assert.ok(!policyText.includes(forbidden), `policy content leaked ${forbidden}`);
    }
    // Crosscheck: the mirrored tuple equals the structuredContent selection.
    assert.ok(policyText.includes(`${selection.provider_id}/${selection.model_id}/${selection.variant}`));

    const recommended = await client.callTool({ name: "get_recommended_runtime", arguments: { profile: "deep" } });
    const recText = text(recommended);
    const recData = recommended.structuredContent as { profile: string; status: string; resolved_label?: string; runtime?: { provider_id: string; model_id: string; variant: string } };
    assert.equal(recData.status, "available");
    assert.equal(recData.resolved_label, "deep.fallback");
    assert.match(recText, /profile=deep revision=3 status=available/);
    assert.match(recText, /Resolved: label=deep\.fallback/);
    assert.match(recText, /Candidates: deep\.main\[disabled\] deep\.fallback\[available\]/);
    assert.ok(recText.includes(`${recData.runtime!.provider_id}/${recData.runtime!.model_id}/${recData.runtime!.variant}`),
      "recommended text mirrors the resolved runtime tuple");

    const unconfigured = await client.callTool({ name: "get_recommended_runtime", arguments: { profile: "execution" } });
    assert.equal((unconfigured.structuredContent as { status: string }).status, "unconfigured");
    assert.match(text(unconfigured), /status=unconfigured/);

    const updated = await client.callTool({ name: "update_session_runtime", arguments: { session_id: "ses", provider_id: "provider", model_id: "model", variant: "high" } });
    const updText = text(updated);
    const updData = updated.structuredContent as { session_id: string; current: { provider_id: string; model_id: string; variant: string } };
    assert.equal(updData.session_id, "ses");
    assert.match(updText, /session ses \(state=updated\)/);
    assert.ok(updText.includes(`Current: ${updData.current.provider_id}/${updData.current.model_id}/${updData.current.variant}`),
      "update text mirrors the confirmed current runtime");
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
  attentionResult?: AttentionResult;
  messageResult?: MessageResult;
  historyResult?: SessionHistoryResult;
  statusResult?: SessionStatusResult;
  detailsResult?: SessionDetailsResult;
  progressResult?: SessionProgressResult;
  abortResult?: AbortSessionTurnResult;
  taskResult?: TaskResult;
  async getProjectAttention(): Promise<AttentionResult> {
    return this.attentionResult ?? {
      entries: [],
      next_cursor: "attention",
      current_cursor: "attention",
      has_more: false,
    };
  }
  async handleMcpEventMethod(method: string): Promise<unknown> {
    if (method === "events/list") return { events: MCP_EVENT_DEFINITIONS };
    if (method === "events/subscribe") return { id: "sub_test" };
    if (method === "events/unsubscribe") return {};
    throw new Error("unsupported event method");
  }
  updateCalls: Array<{ id: string; patch: RuntimePatch }> = [];
  async getSessionProgress(sessionId: string): Promise<SessionProgressResult> {
    if (this.progressResult) return this.progressResult;
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
    if (this.messageResult) return this.messageResult;
    throw new Error("fixture unused");
  }
  async readMessageContent(): Promise<MessageContentResult> {
    throw new Error("fixture unused");
  }
  async getTaskResult(
    sessionId: string,
    submittedMessageId: string,
  ): Promise<TaskResult> {
    if (this.taskResult) return this.taskResult;
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
  failNextCreate = false;
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
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new AdapterError("SUBMISSION_UNCERTAIN", "simulated uncertain create");
    }
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
    if (this.detailsResult) return this.detailsResult;
    throw new Error("backend-secret-must-not-leak");
  }

  async getSessionStatus(
    sessionId: string,
    messageId?: string,
  ): Promise<SessionStatusResult> {
    if (this.statusResult) return this.statusResult;
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
    if (this.historyResult) return this.historyResult;
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

  followupCalls: Array<{
    session_id: string;
    message: string;
    attachments?: string[];
  }> = [];
  followupError?: AdapterError;
  async sendFollowup(
    sessionId: string,
    message: string,
    attachments?: string[],
  ): Promise<SendMessageResult> {
    this.followupCalls.push({
      session_id: sessionId,
      message,
      ...(attachments ? { attachments } : {}),
    });
    if (this.followupError) throw this.followupError;
    return {
      session_id: sessionId,
      message_id: "msg_followup",
      state: "submitted",
    };
  }

  abortCalls: string[] = [];
  async abortSessionTurn(sessionId: string): Promise<AbortSessionTurnResult> {
    this.abortCalls.push(sessionId);
    if (this.abortResult) return this.abortResult;
    return {
      session_id: sessionId,
      state: "no_active_turn",
      observed_at: new Date().toISOString(),
      activity_after: "idle",
      pending_input_after: { permissions: 0, questions: 0 },
      guidance: "fixture",
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

test("MCP 2.0 discovery and Events methods stay on the authenticated loopback endpoint", async (t) => {
  const adapter = new McpHttpServer(runtime(), token, new FakeGateway());
  const port = await adapter.start();
  t.after(() => adapter.close());
  const post = async (method: string, requestMethod = method, authenticated = true, protocolVersion = "2026-07-28", params: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authenticated ? { "X-OCVM-MCP-Token": token } : {}),
      "Mcp-Method": requestMethod,
      "MCP-Protocol-Version": protocolVersion,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": protocolVersion } } }),
  });
  const discovery = await post("server/discover");
  assert.equal(discovery.status, 200);
  const discoveryBody = await discovery.json() as { result: { supportedVersions: string[]; capabilities: { events?: object } } };
  assert.ok(discoveryBody.result.supportedVersions.includes("2026-07-28"));
  assert.deepEqual(discoveryBody.result.capabilities.events, {});
  const listed = await post("events/list");
  const listBody = await listed.json() as { result: { events: Array<{ name: string; delivery: string[] }> } };
  assert.equal(listBody.result.events.length, 4);
  assert.ok(listBody.result.events.every((event) => event.delivery.includes("webhook")));
  const mismatch = await post("events/list", "events/subscribe");
  assert.equal(mismatch.status, 400);
  assert.equal(((await mismatch.json()) as { error: { code: number } }).error.code, -32020);
  const unsupported = await post("events/list", "events/list", true, "2025-11-25");
  assert.equal(unsupported.status, 400);
  assert.equal(((await unsupported.json()) as { error: { code: number } }).error.code, -32022);
  const tools = await post("tools/list");
  const toolList = await tools.json() as { result?: { resultType?: string; tools?: Array<{ name: string }> }; error?: unknown };
  assert.equal(toolList.result?.resultType, "complete");
  assert.ok(toolList.result?.tools?.some((tool) => tool.name === "get_project_attention"), JSON.stringify(toolList.error));
  const called = await post("tools/call", "tools/call", true, "2026-07-28", { name: "get_project_attention", arguments: {} });
  assert.equal(called.status, 200);
  const callBody = await called.json() as { result?: { resultType?: string; structuredContent?: { entries?: unknown[] } }; error?: unknown };
  assert.equal(callBody.result?.resultType, "complete");
  assert.deepEqual(callBody.result?.structuredContent?.entries, [], JSON.stringify(callBody.error));
  assert.equal((await post("events/list", "events/list", false)).status, 401);
});

test("final fallback write is callable on both protocol paths with commit, CAS and catalog refusal", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "policy-wire-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const selection = { provider_id: "provider", model_id: "model", variant: "high" };
  const directory = join(project, ".opencode-vm");
  const policyPath = join(directory, "agent-control.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const original = `${JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: "2026-10-01T00:00:00Z",
    profiles: { deep: selection, standard: null, execution: null } })}\n`;
  await writeFile(policyPath, original);

  const descriptor = { ...runtime(), project };
  const adapter = new McpHttpServer(descriptor, token, new FakeGateway());
  const port = await adapter.start();
  t.after(() => adapter.close());

  // SDK wire path (pinned 2025-11-25 baseline): the new tool must actually execute.
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } },
  );
  const client = new Client({ name: "ocvm-mcp-fallback-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const written = await client.callTool({ name: "set_project_model_policy_fallback",
      arguments: { revision: 1, fallback: { mode: "degrading", selection } } });
    assert.notEqual(written.isError, true, JSON.stringify(written.content));
    const policy = written.structuredContent as { schema_version: number; revision: number;
      final_fallback: { mode: string; selection: unknown; status: string } | null; profiles: { deep: { selection: unknown } } };
    assert.equal(policy.schema_version, 3);
    assert.equal(policy.revision, 2);
    assert.equal(policy.final_fallback?.mode, "degrading");
    assert.equal(policy.final_fallback?.status, "available");
    assert.deepEqual(policy.profiles.deep.selection, selection, "regular profile mappings survive the partial fallback write");
  } finally {
    await client.close().catch(() => undefined);
  }
  const stored = JSON.parse(await readFile(policyPath, "utf8"));
  assert.deepEqual(stored.finalFallback, { mode: "degrading", selection });
  assert.equal(JSON.parse(await readFile(join(directory, "agent-control.schema1-rev1.backup.json"), "utf8")).schemaVersion, 1,
    "the schema 1 original was backed up before the schema 3 upgrade");

  // Modern 2026-07-28 wire path uses the same dispatch.
  const post = async (name: string, args: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "X-OCVM-MCP-Token": token,
      "Mcp-Method": "tools/call",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Name": name,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
  });
  const cleared = await post("set_project_model_policy_fallback", { revision: 2, fallback: null });
  const clearedBody = await cleared.json() as { result?: { structuredContent?: { schema_version?: number; revision?: number; final_fallback?: unknown } } };
  assert.equal(clearedBody.result?.structuredContent?.schema_version, 3, "clear never downgrades the schema");
  assert.equal(clearedBody.result?.structuredContent?.revision, 3);
  assert.equal(clearedBody.result?.structuredContent?.final_fallback, null);
  assert.equal(JSON.parse(await readFile(policyPath, "utf8")).finalFallback, null);

  const beforeStale = await readFile(policyPath);
  const stale = await post("set_project_model_policy_fallback", { revision: 1, fallback: { mode: "total", selection } });
  const staleBody = await stale.json() as { result?: { isError?: boolean; _meta?: Record<string, { code?: string }> } };
  assert.equal(staleBody.result?.isError, true);
  assert.equal(staleBody.result?._meta?.["opencode-vm/error"]?.code, "POLICY_REVISION_CONFLICT");
  assert.deepEqual(await readFile(policyPath), beforeStale, "a stale revision never writes");

  const invalid = await post("set_project_model_policy_fallback",
    { revision: 3, fallback: { selection: { provider_id: "provider", model_id: "model", variant: "gone" } } });
  const invalidBody = await invalid.json() as { result?: { isError?: boolean; _meta?: Record<string, { code?: string }> } };
  assert.equal(invalidBody.result?.isError, true);
  assert.equal(invalidBody.result?._meta?.["opencode-vm/error"]?.code, "SELECTION_UNAVAILABLE");
  assert.deepEqual(await readFile(policyPath), beforeStale, "an unavailable catalog selection never writes");
});

test("official MCP client discovers forty-six stateless HTTP tools and invokes session tools by ID", async () => {
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
      "abort_monitor_run",
      "abort_session_turn",
      "acknowledge_project_attention",
      "archive_session",
      "cancel_monitor_future",
      "create_monitor",
      "create_monitor_worker",
      "create_session",
      "delete_monitor",
      "disable_monitor",
      "enable_monitor",
      "get_message",
      "get_monitor",
      "get_monitor_history",
      "get_project_activity",
      "get_project_attention",
      "get_project_model_policy",
      "get_recommended_runtime",
      "get_repo_live_session",
      "get_session",
      "get_session_history",
      "get_session_progress",
      "get_session_runtime_options",
      "get_session_status",
      "get_task_result",
      "list_monitor_workers",
      "list_monitors",
      "list_sessions",
      "open_repo_live",
      "read_message_content",
      "recover_session_order",
      "refresh_repo_live",
      "rename_session",
      "send_message",
      "send_session_followup",
      "set_project_model_policy_fallback",
      "set_project_model_policy_profile_fallback",
      "set_project_model_policy_slot_disabled",
      "set_project_model_policy_strategies",
      "supersede_unresolved_submission",
      "trigger_monitor",
      "update_monitor",
      "update_monitor_worker",
      "update_session_runtime",
      "upload_attachment",
      "wait_for_project_activity",
    ]);
    const listTool = listed.tools.find((tool) => tool.name === "list_sessions");
    const sendTool = listed.tools.find((tool) => tool.name === "send_message");
    assert.equal(listed.tools.find((tool) => tool.name === "get_project_model_policy")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "get_recommended_runtime")?.annotations?.readOnlyHint, true);
    assert.equal(listed.tools.find((tool) => tool.name === "set_project_model_policy_fallback")?.annotations?.readOnlyHint, false);
    for (const name of ["set_project_model_policy_profile_fallback", "set_project_model_policy_strategies", "set_project_model_policy_slot_disabled"])
      assert.equal(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, false, name);
    for (const name of ["open_repo_live", "refresh_repo_live", "get_repo_live_session"])
      assert.equal(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true, name);
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
      activity_journal: { enabled: true, state: "unavailable" },
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

    // W1 session-control surface: discovery annotations + wire dispatch
    const followupTool = listed.tools.find(
      (tool) => tool.name === "send_session_followup",
    );
    assert.equal(followupTool?.annotations?.readOnlyHint, false);
    assert.equal(followupTool?.annotations?.idempotentHint, false);
    const abortTool = listed.tools.find(
      (tool) => tool.name === "abort_session_turn",
    );
    assert.equal(abortTool?.annotations?.destructiveHint, true);
    assert.equal(abortTool?.annotations?.idempotentHint, true);

    const followed = await client.callTool({
      name: "send_session_followup",
      arguments: { session_id: "ses", message: "correction while busy" },
    });
    assert.equal(followed.isError, undefined);
    assert.equal(
      (followed.structuredContent as Record<string, unknown>)?.message_id,
      "msg_followup",
    );
    assert.deepEqual(gateway.followupCalls.at(-1), {
      session_id: "ses",
      message: "correction while busy",
    });

    gateway.followupError = new AdapterError(
      "SESSION_NOT_BUSY",
      "The backend session is idle; use send_message to start a new task.",
    );
    const idleRejected = await client.callTool({
      name: "send_session_followup",
      arguments: { session_id: "ses", message: "idle attempt" },
    });
    assert.equal(idleRejected.isError, true);
    assert.equal(
      (idleRejected._meta as Record<string, any>)["opencode-vm/error"].code,
      "SESSION_NOT_BUSY",
    );
    gateway.followupError = undefined;

    const aborted = await client.callTool({
      name: "abort_session_turn",
      arguments: { session_id: "ses" },
    });
    assert.equal(aborted.isError, undefined);
    assert.equal(
      (aborted.structuredContent as Record<string, unknown>)?.state,
      "no_active_turn",
    );
    assert.deepEqual(gateway.abortCalls.at(-1), "ses");

    for (const [name, args] of [
      ["send_session_followup", { session_id: "ses" }],
      ["send_session_followup", { session_id: "ses", message: "" }],
      ["abort_session_turn", {}],
      ["abort_session_turn", { session_id: "ses", extra: true }],
    ] as const) {
      const invalid = await client.callTool({ name, arguments: args });
      assert.equal(invalid.isError, true);
      assert.equal(
        (invalid._meta as Record<string, any>)["opencode-vm/error"].code,
        "INVALID_ARGUMENT",
      );
    }

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

test("MCP read outputs accept only the bounded safe worker error detail shape", async () => {
  const gateway = new FakeGateway();
  const errorDetail = {
    category: "provider_header_timeout" as const,
    name: "APIError" as const,
    code: "ProviderHeaderTimeoutError" as const,
    timeout_ms: 300000,
    message: "Provider response headers timed out after 300000ms.",
    detail_availability: "safe_template" as const,
    source: "assistant_message_error" as const,
    source_is_retryable: true,
  };
  const message: MessageResult["message"] = {
    id: "msg_error",
    role: "assistant",
    parent_id: "msg_user",
    text: "",
    created: 1,
    completed: 2,
    finish: "stop",
    error: "failed",
    error_detail: errorDetail,
    text_truncated: false,
    content_complete: true,
    content: {
      content_ref: "content.ref",
      revision: "visible-text-v1:empty",
      unit: "utf8_bytes",
      total_bytes: 0,
      sha256: "a".repeat(64),
      availability: "not_exposed",
      omitted_parts: [{ type: "tool", count: 1, reason: "part_not_exposed" }],
    },
  };
  const correlated = {
    ...errorDetail,
    assistant_message_id: "msg_error",
    attribution: "exact_parent" as const,
  };
  gateway.messageResult = { session_id: "ses", message };
  gateway.historyResult = {
    session_id: "ses",
    messages: [message],
    truncated: false,
  };
  gateway.taskResult = {
    session_id: "ses",
    submitted_message_id: "msg_user",
    state: "failed",
    observed_at: new Date().toISOString(),
    source: "backend",
    search_complete: true,
    order: "newest_first",
    messages: [{ ...message, result_kind: "terminal" }],
  };
  gateway.statusResult = {
    session_id: "ses",
    message_id: "msg_user",
    backend_activity: "idle",
    state: "failed",
    pending_input: { permissions: 0, questions: 0 },
    assistant_message_ids: ["msg_error"],
    error_details: [correlated],
    error_details_total: 1,
    error_details_truncated: false,
  };
  gateway.attentionResult = {
    entries: [{
      event_id: "event_error",
      activity_cursor: "cursor",
      event_sequence: 1,
      event_type: "message.failed",
      classification: "attention",
      lifecycle: "ready",
      session_id: "ses",
      session_title: "Worker",
      submitted_message_id: "msg_user",
      assistant_message_ids: ["msg_error"],
      occurred_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
      prepared_summary: "Worker turn failed. Provider response headers timed out after 300000ms.",
      next_safe_step: "Review the original failure/abort evidence; no automatic retry or replacement worker was started.",
      hierarchy_status: "unlinked",
      delivery_policy: "on_demand_fallback",
      error_details: [correlated],
      error_details_total: 1,
      error_details_truncated: false,
      evidence: {
        source: "visible_original",
        assistant_message_ids: ["msg_error"],
        complete: true,
      },
      deliveries: {},
    }],
    next_cursor: "attention",
    current_cursor: "attention",
    has_more: false,
  };
  const server = new McpHttpServer(runtime(), token, gateway);
  const port = await server.start();
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } },
  );
  const client = new Client({ name: "error-detail-wire", version: "1.0.0" });
  try {
    await client.connect(transport);
    const [direct, history, result, status, attention] = await Promise.all([
      client.callTool({ name: "get_message", arguments: { session_id: "ses", message_id: "msg_error" } }),
      client.callTool({ name: "get_session_history", arguments: { session_id: "ses" } }),
      client.callTool({ name: "get_task_result", arguments: { session_id: "ses", submitted_message_id: "msg_user" } }),
      client.callTool({ name: "get_session_status", arguments: { session_id: "ses", message_id: "msg_user" } }),
      client.callTool({ name: "get_project_attention", arguments: {} }),
    ]);
    assert.deepEqual((direct.structuredContent as MessageResult).message.error_detail, errorDetail);
    assert.deepEqual((history.structuredContent as SessionHistoryResult).messages[0]?.error_detail, errorDetail);
    assert.deepEqual((result.structuredContent as TaskResult).messages[0]?.error_detail, errorDetail);
    assert.deepEqual((status.structuredContent as SessionStatusResult).error_details, [correlated]);
    assert.deepEqual((attention.structuredContent as AttentionResult).entries[0]?.error_details, [correlated]);
    gateway.messageResult = {
      session_id: "ses",
      message: {
        ...message,
        error_detail: { ...errorDetail, message: "Bearer PRIVATE_TOKEN" },
      },
    };
    const unsafeMessage = await client.callTool({
      name: "get_message",
      arguments: { session_id: "ses", message_id: "msg_error" },
    });
    assert.equal("isError" in unsafeMessage && unsafeMessage.isError, true);
    assert.doesNotMatch(JSON.stringify(unsafeMessage), /PRIVATE_TOKEN/u);
    gateway.statusResult = {
      ...gateway.statusResult!,
      error_details_truncated: true,
    };
    const inconsistentSummary = await client.callTool({
      name: "get_session_status",
      arguments: { session_id: "ses", message_id: "msg_user" },
    });
    assert.equal("isError" in inconsistentSummary && inconsistentSummary.isError, true);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
  }
});

test("MCP board search, reverse lookup, complete links and overflow use the public schemas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-wire-"));
  let rows = [{ id: "backend-1", projectId: "backend-project", title: "Review work", description: "Searchable body",
    status: "todo", priority: "medium" }];
  const puts: Array<Record<string, unknown>> = [];
  const backend = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tickets/backend-1" && request.method === "PUT") {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const patch = JSON.parse(body) as Record<string, unknown>;
        puts.push(patch);
        Object.assign(rows[0]!, patch);
        response.end(JSON.stringify(rows[0]));
      });
      return;
    }
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
  const descriptor = { ...runtime(), project: directory, projectHash: "hash", taskboardUrl: `http://127.0.0.1:${backendPort}`,
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
        "get_board_project", "create_board_project", "get_task_transfer_status",
        "register_task_document", "get_task_documents", "read_task_document",
        "add_task_management_note", "get_task_management_history", "add_task_document_bindings"].includes(tool.name)).length, 19);
    for (const [name, idempotentHint] of [["add_task_management_note", false], ["add_task_document_bindings", true]] as const) {
      assert.deepEqual(catalog.tools.find((tool) => tool.name === name)?.annotations,
        { readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint: false });
    }
    assert.equal(catalog.tools.find((tool) => tool.name === "list_project_tasks")?.annotations?.readOnlyHint, true);
    assert.equal(catalog.tools.find((tool) => tool.name === "get_task_documents")?.annotations?.readOnlyHint, true);
    assert.equal(catalog.tools.find((tool) => tool.name === "read_task_document")?.annotations?.readOnlyHint, true);
    assert.equal(catalog.tools.find((tool) => tool.name === "get_task_management_history")?.annotations?.readOnlyHint, true);
    assert.equal(catalog.tools.find((tool) => tool.name === "register_task_document")?.annotations?.readOnlyHint, false);
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
    const noted = await client.callTool({ name: "add_task_management_note", arguments: { task_id: id, note: " Follow up " } });
    assert.equal(noted.isError, undefined);
    assert.equal((noted.structuredContent as { description: string }).description, "Searchable body");
    assert.equal((noted.structuredContent as { management_note: { sequence: number } }).management_note.sequence, 1);
    assert.deepEqual(puts, []);
    const management = await client.callTool({ name: "get_task_management_history", arguments: { task_id: id } });
    assert.equal(management.isError, undefined);
    const history = management.structuredContent as { entries: Array<{ sequence: number; text: string }>; legacy_description: { text: string } };
    assert.deepEqual(history.entries.map(({ sequence, text }) => ({ sequence, text })), [{ sequence: 1, text: "Follow up" }]);
    assert.equal(history.legacy_description.text, "Searchable body");
    for (const [name, args, code] of [
      ["add_task_management_note", { task_id: id, note: "No status", status: "done" }, "INVALID_ARGUMENT"],
      ["add_task_management_note", { task_id: id, note: "  " }, "INVALID_ARGUMENT"],
      ["add_task_management_note", { task_id: "task_alias", note: "Invalid" }, "INVALID_ARGUMENT"],
      ["add_task_management_note", { task_id: "task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", note: "Unknown" }, "TASK_NOT_FOUND"],
      ["get_task_management_history", { task_id: id, mode: "recent", cursor: "wrong-mode" }, "INVALID_ARGUMENT"],
      ["add_task_document_bindings", { task_id: id }, "INVALID_ARGUMENT"],
      ["add_task_document_bindings", { task_id: id, compact_context: "../../private" }, "TASK_DOCUMENT_PATH_INVALID"],
      ["add_task_document_bindings", { task_id: id, concept_detail: "private" }, "INVALID_ARGUMENT"],
      ["add_task_document_bindings", { task_id: id, compact_context: "private", expected_path: "private" }, "INVALID_ARGUMENT"],
    ] as const) {
      const invalid = await client.callTool({ name, arguments: args });
      assert.equal(invalid.isError, true);
      assert.equal((invalid._meta as Record<string, any>)["opencode-vm/error"].code, code);
    }
    assert.equal(puts.length, 0);
    const contextPath = `.opencode/tasks/task-${id}.compact.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await writeFile(join(directory, contextPath), `Task-ID: ${id}\nStatus: ready\n`);
    const registered = await client.callTool({ name: "register_task_document", arguments: {
      task_id: id, role: "compact_context", path: contextPath,
    } });
    assert.equal(registered.isError, undefined);
    const bound = await client.callTool({ name: "add_task_document_bindings", arguments: { task_id: id, compact_context: contextPath } });
    assert.equal(bound.isError, undefined);
    assert.deepEqual(bound.structuredContent, registered.structuredContent);
    const alternate = `.opencode/tasks/${id}.compact.md`;
    await writeFile(join(directory, alternate), `Task-ID: ${id}\n`);
    const conflict = await client.callTool({ name: "add_task_document_bindings", arguments: { task_id: id, compact_context: alternate } });
    assert.equal(conflict.isError, true);
    assert.equal((conflict._meta as Record<string, any>)["opencode-vm/error"].code, "TASK_DOCUMENT_CONFLICT");
    const refs = await client.callTool({ name: "get_task_documents", arguments: { task_id: id } });
    assert.deepEqual((refs.structuredContent as { documents: Array<{ role: string; path: string }> }).documents
      .map((ref) => [ref.role, ref.path]), [["compact_context", contextPath]]);
    const read = await client.callTool({ name: "read_task_document", arguments: {
      task_id: id, role: "compact_context", max_bytes: 10,
    } });
    assert.equal(read.isError, undefined);
    const first = read.structuredContent as { text: string; revision: string; range: { end: number }; has_more: boolean };
    assert.equal(first.has_more, true);
    const second = await client.callTool({ name: "read_task_document", arguments: {
      task_id: id, role: "compact_context", offset: first.range.end, revision: first.revision,
    } });
    assert.equal(first.text + (second.structuredContent as { text: string }).text, `Task-ID: ${id}\nStatus: ready\n`);
    for (const [arguments_, code] of [
      [{ task_id: id, role: "other" }, "INVALID_ARGUMENT"],
      [{ task_id: id, role: "compact_context", path: "../../private" }, "TASK_DOCUMENT_PATH_INVALID"],
    ] as const) {
      const invalid = await client.callTool({ name: "read_task_document", arguments: arguments_ });
      assert.equal(invalid.isError, true);
      assert.equal((invalid._meta as Record<string, any>)["opencode-vm/error"].code, code);
    }
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

test("pre-dispatch rejections carry bounded redacted correlation per phase without wire changes", async (t) => {
  const adapter = new McpHttpServer(runtime(), token, new FakeGateway());
  const port = await adapter.start();
  t.after(() => adapter.close());
  const sentinels = ["SENTINEL-HEADER-VALUE", "SENTINEL-BODY-SECRET", "SENTINEL-URL-PART", "SENTINEL-TOKEN-VALUE", token];
  const stderrLines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    if (typeof chunk === "string") stderrLines.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  t.after(() => { process.stderr.write = originalWrite; });

  const raw = (path: string, method: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
      });
      request.on("error", reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const expectCorrelation = (correlation: unknown, phase: string, code: string, reason: string): Record<string, unknown> => {
    assert.ok(correlation && typeof correlation === "object", "correlation object missing");
    const value = correlation as Record<string, unknown>;
    assert.deepEqual(Object.keys(value).sort(), ["adapterVersion", "code", "generation", "phase", "reason", "request", "time"]);
    assert.equal(value.phase, phase);
    assert.equal(value.code, code);
    assert.equal(value.reason, reason);
    assert.equal(value.generation, "generation");
    assert.equal(value.adapterVersion, ADAPTER_VERSION);
    assert.match(String(value.request), uuid);
    assert.ok(!Number.isNaN(Date.parse(String(value.time))));
    assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") < 512, "correlation must stay bounded");
    return value;
  };
  const expectRejectionLog = (correlation: Record<string, unknown>) => {
    const line = stderrLines.find((entry) => entry.startsWith("[mcp] rejection="));
    assert.ok(line, "expected one stderr rejection trace");
    assert.deepEqual(JSON.parse(String(line).slice("[mcp] rejection=".length)), correlation);
  };
  const expectNoSentinel = (body: string) => {
    for (const sentinel of sentinels) {
      assert.ok(!body.includes(sentinel), `response leaked ${sentinel}`);
      for (const line of stderrLines) assert.ok(!line.includes(sentinel), `stderr leaked ${sentinel}`);
    }
  };
  const authorized = { "X-Sentinel": "SENTINEL-HEADER-VALUE", "X-OCVM-MCP-Token": token, Host: `127.0.0.1:${port}` };
  type WireBody = { error?: string | { code?: number; message?: string; data?: Record<string, unknown> }; id?: unknown; correlation?: unknown };

  // header phase: invalid Host
  stderrLines.length = 0;
  let reply = await raw("/healthz", "GET", { ...authorized, Host: "evil.example:9999" });
  assert.equal(reply.status, 403);
  let body = JSON.parse(reply.body) as WireBody;
  assert.equal(body.error, "Invalid Host header.");
  expectRejectionLog(expectCorrelation(body.correlation, "header", "403", "invalid_host"));
  expectNoSentinel(reply.body);

  // method phase: unknown route with a sentinel query
  stderrLines.length = 0;
  reply = await raw("/mcp?q=SENTINEL-URL-PART", "GET", authorized);
  assert.equal(reply.status, 404);
  body = JSON.parse(reply.body) as WireBody;
  assert.equal(body.error, "Not found.");
  expectCorrelation(body.correlation, "method", "404", "not_found");
  expectNoSentinel(reply.body);

  // header phase: invalid Origin
  stderrLines.length = 0;
  reply = await raw("/healthz", "GET", { ...authorized, Origin: "http://evil.example" });
  assert.equal(reply.status, 403);
  body = JSON.parse(reply.body) as WireBody;
  assert.equal(body.error, "Invalid Origin header.");
  expectCorrelation(body.correlation, "header", "403", "invalid_origin");
  expectNoSentinel(reply.body);

  // auth phase: wrong token sentinel, wire authenticate header preserved
  stderrLines.length = 0;
  reply = await raw("/healthz", "GET", { ...authorized, "X-OCVM-MCP-Token": "SENTINEL-TOKEN-VALUE" });
  assert.equal(reply.status, 401);
  assert.equal(reply.headers["www-authenticate"], 'Token realm="opencode-vm-mcp"');
  body = JSON.parse(reply.body) as WireBody;
  assert.equal(body.error, "Authentication required.");
  expectCorrelation(body.correlation, "auth", "401", "authentication_required");
  expectNoSentinel(reply.body);

  // method phase: wrong verb keeps the exact -32000 wire body plus allow header
  stderrLines.length = 0;
  reply = await raw("/mcp", "GET", authorized);
  assert.equal(reply.status, 405);
  assert.equal(reply.headers.allow, "POST");
  body = JSON.parse(reply.body) as WireBody;
  const methodError = body.error as { code?: number; message?: string; data?: Record<string, unknown> };
  assert.equal(methodError.code, -32000);
  assert.equal(methodError.message, "Method not allowed.");
  expectRejectionLog(expectCorrelation(methodError.data?.correlation, "method", "-32000", "method_not_allowed"));
  expectNoSentinel(reply.body);

  // transport phase: wrong content type
  stderrLines.length = 0;
  reply = await raw("/mcp", "POST", { ...authorized, "content-type": "text/plain" }, "SENTINEL-BODY-SECRET");
  assert.equal(reply.status, 415);
  body = JSON.parse(reply.body) as WireBody;
  assert.equal(body.error, "Content-Type must be application/json.");
  expectCorrelation(body.correlation, "transport", "415", "invalid_content_type");
  expectNoSentinel(reply.body);

  // transport phase: malformed JSON
  stderrLines.length = 0;
  reply = await raw("/mcp", "POST", { ...authorized, "content-type": "application/json" }, "SENTINEL-BODY-SECRET{not json");
  assert.equal(reply.status, 400);
  body = JSON.parse(reply.body) as WireBody;
  assert.equal(body.error, "Malformed JSON request.");
  expectCorrelation(body.correlation, "transport", "400", "malformed_json");
  expectNoSentinel(reply.body);

  // protocol phase: unsupported version keeps -32022 wire data
  stderrLines.length = 0;
  reply = await raw("/mcp", "POST", { ...authorized, "content-type": "application/json", "mcp-protocol-version": "1999-01-01" },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { note: "SENTINEL-BODY-SECRET" } } }));
  assert.equal(reply.status, 400);
  body = JSON.parse(reply.body) as WireBody;
  let wire = body.error as { code?: number; message?: string; data?: Record<string, unknown> };
  assert.equal(wire.code, -32022);
  assert.equal(wire.message, "Unsupported protocol version.");
  assert.equal(wire.data?.requested, "1999-01-01");
  expectCorrelation(wire.data?.correlation, "protocol", "-32022", "unsupported_protocol_version");
  expectNoSentinel(reply.body);

  // header phase: modern header mismatch keeps the -32020 wire message
  stderrLines.length = 0;
  reply = await raw("/mcp", "POST", { ...authorized, "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }));
  assert.equal(reply.status, 400);
  body = JSON.parse(reply.body) as WireBody;
  wire = body.error as { code?: number; message?: string; data?: Record<string, unknown> };
  assert.equal(wire.code, -32020);
  assert.equal(wire.message, "Header mismatch: standard MCP request headers must match the request metadata.");
  expectCorrelation(wire.data?.correlation, "header", "-32020", "header_mismatch");
  expectNoSentinel(reply.body);

  // protocol phase: oversized JSON-RPC id stays unreflected
  stderrLines.length = 0;
  reply = await raw("/mcp", "POST", { ...authorized, "content-type": "application/json" },
    JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(2000), method: "tools/list" }));
  assert.equal(reply.status, 400);
  body = JSON.parse(reply.body) as WireBody;
  wire = body.error as { code?: number; data?: Record<string, unknown> };
  assert.equal(wire.code, -32600);
  assert.equal(body.id, null);
  expectCorrelation(wire.data?.correlation, "protocol", "-32600", "request_id_too_large");
  expectNoSentinel(reply.body);

  // protocol phase: invalid events JSON-RPC inside the 200 envelope
  stderrLines.length = 0;
  reply = await raw("/mcp", "POST", { ...authorized, "content-type": "application/json" },
    JSON.stringify({ jsonrpc: "2.0", method: "events/list" }));
  assert.equal(reply.status, 200);
  body = JSON.parse(reply.body) as WireBody;
  wire = body.error as { code?: number; message?: string; data?: Record<string, unknown> };
  assert.equal(wire.code, -32600);
  assert.equal(wire.message, "Invalid JSON-RPC request.");
  expectCorrelation(wire.data?.correlation, "protocol", "-32600", "invalid_jsonrpc");
  expectNoSentinel(reply.body);

  // protocol phase: events method on a legacy protocol header keeps the -32022 event wire data
  stderrLines.length = 0;
  reply = await raw("/mcp", "POST", { ...authorized, "content-type": "application/json", "mcp-protocol-version": "2025-11-25", "mcp-method": "events/list" },
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "events/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } }));
  assert.equal(reply.status, 400);
  body = JSON.parse(reply.body) as WireBody;
  wire = body.error as { code?: number; message?: string; data?: Record<string, unknown> };
  assert.equal(wire.code, -32022);
  assert.deepEqual(wire.data?.supported, ["2026-07-28"]);
  expectCorrelation(wire.data?.correlation, "protocol", "-32022", "unsupported_protocol_version");
  expectNoSentinel(reply.body);
});

test("healthz granularity is additive, connectivity-backed and never fabricates tool evidence", async (t) => {
  const adapter = new McpHttpServer(runtime(), token, new FakeGateway());
  const port = await adapter.start();
  t.after(() => adapter.close());
  const getHealth = async () => (await fetch(`http://127.0.0.1:${port}/healthz`,
    { headers: { "X-OCVM-MCP-Token": token } })).json() as Promise<Record<string, unknown>>;
  const health = await getHealth();
  assert.equal(health.healthy, true);
  assert.equal(health.schema, 1);
  assert.equal(health.generation, "generation");
  assert.equal(health.adapterVersion, ADAPTER_VERSION);
  const granularity = health.granularity as Record<string, unknown>;
  assert.deepEqual(Object.keys(granularity).sort(),
    ["activity_journal", "backend_connectivity", "configuration", "events_channel", "last_tool_error", "last_tool_success", "listener", "process"]);
  assert.deepEqual(granularity.activity_journal, { enabled: true, state: "unavailable" });
  assert.equal(granularity.configuration, "validated");
  assert.equal(granularity.process, "up");
  assert.equal(granularity.listener, "bound");
  assert.equal(granularity.backend_connectivity, "unverified");
  assert.equal(granularity.events_channel, "enabled");
  const before = structuredClone(lastToolRoundtrips());
  await getHealth(); await getHealth(); await getHealth();
  assert.deepEqual(lastToolRoundtrips(), before, "health polling alone must not create roundtrip evidence");

  const stderrLines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    if (typeof chunk === "string") stderrLines.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await traceToolCall("list_sessions", { session_id: "ses_roundtrip" }, (async () => ({
      content: [{ type: "text", text: "SECRET-PAYLOAD-SENTINEL" }],
      structuredContent: { sessions: ["SECRET-STRUCT-SENTINEL"] },
      isError: false,
    })) as never);
    const afterSuccess = lastToolRoundtrips();
    assert.equal(afterSuccess.last_success?.tool, "list_sessions");
    assert.match(String(afterSuccess.last_success?.request), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
    assert.ok(!Number.isNaN(Date.parse(String(afterSuccess.last_success?.time))));
    assert.ok(afterSuccess.last_success && !("code" in afterSuccess.last_success));
    assert.ok(!JSON.stringify(afterSuccess).includes("SECRET-"));
    await traceToolCall("get_session", {}, (async () => ({
      content: [],
      isError: true,
      _meta: { "opencode-vm/error": { code: "SESSION_NOT_FOUND", message: "SECRET-REASON-SENTINEL" } },
      structuredContent: {},
    })) as never);
    const afterError = lastToolRoundtrips();
    assert.equal(afterError.last_error?.code, "SESSION_NOT_FOUND");
    assert.equal(afterError.last_error?.tool, "get_session");
    assert.ok(!JSON.stringify(afterError).includes("SECRET-"));
    assert.ok(!stderrLines.join("").includes("SECRET-"));
    const refreshed = await getHealth();
    const refreshedGranularity = refreshed.granularity as Record<string, unknown>;
    assert.deepEqual(refreshedGranularity.last_tool_success, afterSuccess.last_success);
    assert.deepEqual(refreshedGranularity.last_tool_error, afterError.last_error);
  } finally {
    process.stderr.write = originalWrite;
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

test("monitor emergency: persistent delete frees the anchor and binding changes are atomic, unique and idle-gated", async () => {
  const project = await mkdtemp(join(tmpdir(), "ocvm-monitor-bindings-"));
  const nativeIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const tasks = nativeIds.map(id => ({ id, projectId: "board", title: "Preserved task", description: "Preserved work", status: "in_progress", priority: "high" }));
  const boardServer = http.createServer((request, response) => {
    assert.equal(request.method, "GET", "binding validation must not mutate tasks");
    const path = request.url!.split("?")[0];
    const value = path === "/api/projects" ? [{ id: "board", name: "Test", prefix: "TEST", status: "active" }]
      : path === "/api/tickets" ? tasks : tasks.find(task => path === `/api/tickets/${task.id}`);
    response.writeHead(value ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value ?? {}));
  });
  await new Promise<void>(resolve => boardServer.listen(0, "127.0.0.1", resolve));
  const boardPort = (boardServer.address() as { port: number }).port;
  class BindingGateway extends FakeGateway {
    busy = false;
    pending = false;
    missingOld = false;
    guarded: string | null = null;
    receiptReads: string[] = [];
    race: (() => Promise<void>) | null = null;
    override async getSessionDetails(id: string): Promise<SessionDetailsResult> {
      if (this.missingOld && id === "ses_old") throw new AdapterError("SESSION_NOT_FOUND", "missing old manager");
      if (this.race) { const race = this.race; this.race = null; await race(); }
      return { id, title: "Manager", created: 1, updated: 2, activity: this.busy ? "busy" : "idle",
        pending_input: { permissions: this.pending ? 1 : 0, questions: 0 },
        ...(id === "ses_old" && this.guarded ? { admission: { guarded_message_id: this.guarded, write_in_progress: false } } : {}) };
    }
    override async getSessionStatus(id: string, receipt?: string): Promise<SessionStatusResult> {
      if (receipt) this.receiptReads.push(receipt);
      const status = await super.getSessionStatus(id, receipt);
      return receipt === "msg_wal_terminal" ? { ...status, state: "completed" } : status;
    }
  }
  const gateway = new BindingGateway();
  const adapter = new McpHttpServer({ ...runtime(), project, taskboardUrl: `http://127.0.0.1:${boardPort}`,
    taskboardMetadataFile: join(project, "board-metadata.json") }, token, gateway);
  const port = await adapter.start();
  const client = new Client({ name: "monitor-bindings", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { "X-OCVM-MCP-Token": token } } }));
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const catalog = await client.listTools();
    const properties = catalog.tools.find(tool => tool.name === "update_monitor")!.inputSchema.properties!;
    assert.ok(properties.task_id && properties.manager_session_id, "separate bindings are discoverable");
    const listed = await call("list_project_tasks", {});
    const taskIds = (listed.structuredContent as { tasks: Array<{ task_id: string }> }).tasks.map(task => task.task_id);
    assert.equal(taskIds.length, 3);
    const created = await call("create_monitor", { title: "Hello-World-Smoke", task_id: taskIds[0] });
    const id = (created.structuredContent as { monitor: { monitor_id: string } }).monitor.monitor_id;
    const second = await call("create_monitor", { title: "Other", task_id: taskIds[1] });
    const id2 = (second.structuredContent as { monitor: { monitor_id: string } }).monitor.monitor_id;
    const baseline = () => readFile(join(project, ".opencode-vm", "monitor", "registry.json"), "utf8");
    let raw = await baseline();
    assert.equal((await call("update_monitor", { monitor_id: id, task_id: taskIds[1], title: "must not save" })).isError, true);
    assert.equal(await baseline(), raw, "conflicting task: no partial title or generation write");
    assert.equal((await call("update_monitor", { monitor_id: id, task_id: "task_99999999-9999-4999-8999-999999999999" })).isError, true);
    assert.equal(await baseline(), raw);
    const rebound = await call("update_monitor", { monitor_id: id, task_id: taskIds[2], manager_session_id: "ses_old" });
    assert.notEqual(rebound.isError, true, JSON.stringify(rebound));
    assert.equal((rebound.structuredContent as { monitor: { anchor_task_id: string; session_id: string } }).monitor.anchor_task_id, taskIds[2]);
    assert.equal((rebound.structuredContent as { monitor: { session_id: string } }).monitor.session_id, "ses_old");
    raw = await baseline();
    assert.equal((await call("update_monitor", { monitor_id: id2, manager_session_id: "ses_old" })).isError, true);
    assert.equal(await baseline(), raw, "one session cannot host two monitor clocks");
    gateway.busy = true;
    assert.equal((await call("update_monitor", { monitor_id: id, manager_session_id: "ses_new" })).isError, true);
    gateway.busy = false; gateway.pending = true;
    assert.equal((await call("update_monitor", { monitor_id: id, manager_session_id: "ses_new" })).isError, true);
    gateway.pending = false;
    assert.equal(await baseline(), raw);
    const generation = (await readRegistrySnapshot(project)).registry.generation;
    let raced = false;
    gateway.race = async () => { raced = true; await withRegistry(project, registry => { registry.monitors[0]!.session.session_id = "ses_concurrent"; }); };
    assert.equal((await call("update_monitor", { monitor_id: id, manager_session_id: "ses_new", expected_generation: generation + 1 })).isError, true);
    assert.equal(raced, false, "a future expected_generation cannot replace the validation snapshot");
    assert.equal(await baseline(), raw);
    gateway.race = null;
    await withRegistry(project, registry => {
      registry.monitors[0]!.dispatch_wal = { action_id: "wake_old", at: new Date().toISOString(), prompt_digest: "digest", message_id: "msg_wal_terminal" };
    });
    gateway.guarded = "msg_later_unsettled";
    raw = await baseline();
    assert.equal((await call("update_monitor", { monitor_id: id, manager_session_id: "ses_new" })).isError, true);
    assert.deepEqual(gateway.receiptReads, ["msg_wal_terminal", "msg_later_unsettled"], "check distinct WAL and admission receipts");
    assert.equal(await baseline(), raw, "an unsettled later receipt is not hidden by the terminal WAL");
    gateway.guarded = null;
    await withRegistry(project, registry => {
      registry.monitors[0]!.dispatch_wal = { action_id: "wake_old", at: new Date().toISOString(), prompt_digest: "digest", message_id: null };
    });
    raw = await baseline();
    assert.equal((await call("update_monitor", { monitor_id: id, manager_session_id: "ses_new", title: "unsaved" })).isError, true);
    assert.equal(await baseline(), raw, "uncertain WAL is not discarded by rebind");
    await withRegistry(project, registry => { registry.monitors[0]!.dispatch_wal = null; });
    gateway.race = () => withRegistry(project, registry => { registry.monitors[0]!.run.active = true; }).then(() => {});
    assert.equal((await call("update_monitor", { monitor_id: id, manager_session_id: "ses_new" })).isError, true, "claim racing validation prevents commit");
    assert.equal((await readRegistrySnapshot(project)).registry.monitors[0]!.session.session_id, "ses_old");
    assert.equal((await call("delete_monitor", { monitor_id: id })).isError, true, "active run prevents deletion");
    await withRegistry(project, registry => { registry.monitors[0]!.run.active = false; });
    gateway.missingOld = true;
    assert.notEqual((await call("update_monitor", { monitor_id: id, manager_session_id: "ses_new" })).isError, true);
    assert.equal((await readRegistrySnapshot(project)).registry.monitors[0]!.anchor.task_id, taskIds[2], "manager recovery preserves task");
    assert.notEqual((await call("update_monitor", { monitor_id: id, manager_session_id: null })).isError, true);
    assert.equal((await readRegistrySnapshot(project)).registry.monitors[0]!.session.session_id, null, "explicit detach leaves next-wake recovery pending, without creating a session here");
    await writeFile(join(project, "preserved-work.txt"), "work");
    const deleted = await call("delete_monitor", { monitor_id: id });
    assert.equal((deleted.structuredContent as { deleted: boolean }).deleted, true);
    assert.equal((await readRegistrySnapshot(project)).registry.monitors.some(monitor => monitor.id === id), false);
    assert.equal((await call("get_monitor", { monitor_id: id })).isError, true);
    assert.notEqual((await call("create_monitor", { title: "New monitor", task_id: taskIds[2] })).isError, true, "anchor freed durably");
    assert.equal(await readFile(join(project, "preserved-work.txt"), "utf8"), "work");
    assert.equal(tasks.length, 3);
    assert.deepEqual(gateway.updateCalls, [], "binding edits do not switch session runtimes");
  } finally {
    await client.close(); await adapter.close();
    await new Promise<void>(resolve => boardServer.close(() => resolve()));
    await rm(project, { recursive: true, force: true });
  }
});

test("W2-F2/W4: monitor workers use the locked identity lifecycle through the MCP surface", async () => {
  const project = await mkdtemp(join(tmpdir(), "ocvm-monitor-worker-"));
  const gateway = new FakeGateway();
  const adapter = new McpHttpServer({ ...runtime(), project }, token, gateway);
  const port = await adapter.start();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } });
  const client = new Client({ name: "monitor-worker", version: "1.0.0" });
  try {
    await client.connect(transport);
    const created = await client.callTool({
      name: "create_monitor",
      arguments: { title: "Worker monitor", task_id: "task_11111111-1111-4111-8111-111111111111" },
    });
    const monitorId = (created.structuredContent as { monitor: { monitor_id: string } }).monitor.monitor_id;

    // W2-F2: create_monitor assigns a monotonic manager alias and records it.
    const snapshot = await readRegistrySnapshot(project);
    assert.equal(snapshot.registry.alias_high_water, 1);
    assert.equal(snapshot.registry.monitors[0]!.alias, "M1");
    const history = await client.callTool({ name: "get_monitor_history", arguments: { monitor_id: monitorId } });
    const createdEntry = (history.structuredContent as {
      history: Array<{ type: string; detail?: { alias?: string } }>;
    }).history.find((entry) => entry.type === "created");
    assert.equal(createdEntry?.detail?.alias, "M1");

    // Reserve-before-create + confirm through the locked helper (taskless worker).
    const worker = await client.callTool({
      name: "create_monitor_worker",
      arguments: { monitor_id: monitorId, scope: "W4" },
    });
    const w0 = (worker.structuredContent as {
      worker: { worker_key: string; alias: string; lifecycle: string; runtime_session_id: string | null; creation_receipt: string | null };
      uncertain: boolean;
    }).worker;
    assert.equal(w0.alias, "M1-A");
    assert.equal(w0.lifecycle, "active");
    assert.equal(w0.runtime_session_id, "ses_new");
    assert.equal(w0.creation_receipt, "ses_new");
    assert.equal((worker.structuredContent as { uncertain: boolean }).uncertain, false);

    const listed = await client.callTool({ name: "list_monitor_workers", arguments: { monitor_id: monitorId } });
    assert.equal((listed.structuredContent as { workers: unknown[] }).workers.length, 1);
    assert.equal((listed.structuredContent as { alias: string | null }).alias, "M1");

    // Own-worker reuse after idle and rebind after a lost runtime keep the alias.
    await client.callTool({ name: "update_monitor_worker", arguments: { monitor_id: monitorId, worker_key: w0.worker_key, action: "idle" } });
    const reused = await client.callTool({
      name: "update_monitor_worker",
      arguments: { monitor_id: monitorId, worker_key: w0.worker_key, action: "reuse", runtime_session_id: "ses_reuse", dispatch_receipt: "msg_d1" },
    });
    const w1 = (reused.structuredContent as {
      worker: { lifecycle: string; runtime_session_id: string | null; dispatch_receipt: string | null; alias: string };
    }).worker;
    assert.equal(w1.lifecycle, "active");
    assert.equal(w1.runtime_session_id, "ses_reuse");
    assert.equal(w1.dispatch_receipt, "msg_d1");
    assert.equal(w1.alias, "M1-A");
    const rebound = await client.callTool({
      name: "update_monitor_worker",
      arguments: { monitor_id: monitorId, worker_key: w0.worker_key, action: "rebind", runtime_session_id: "ses_rebind" },
    });
    assert.equal((rebound.structuredContent as { worker: { runtime_session_id: string } }).worker.runtime_session_id, "ses_rebind");
    const reboundStored = (await readRegistrySnapshot(project)).registry.monitors[0]!;
    assert.equal(reboundStored.workers![0]!.dispatch_receipt, null);
    assert.equal(reboundStored.workers![0]!.dispatch_at, null);
    assert.ok(reboundStored.history.some(entry => entry.type === "worker-episode-detached" && entry.detail?.dispatch_receipt === "msg_d1" && entry.detail?.session_id === "ses_reuse"), "MCP omission preserves prior episode provenance");

    // Uncertain create stays reserved and is reconciled, never retried blindly.
    gateway.failNextCreate = true;
    const uncertain = await client.callTool({ name: "create_monitor_worker", arguments: { monitor_id: monitorId } });
    const w2 = (uncertain.structuredContent as { worker: { worker_key: string; alias: string; lifecycle: string } }).worker;
    assert.equal((uncertain.structuredContent as { uncertain: boolean }).uncertain, true);
    assert.equal(w2.lifecycle, "reserved");
    assert.notEqual(uncertain.isError, true, JSON.stringify(uncertain.content));
    const reconciled = await client.callTool({
      name: "update_monitor_worker",
      arguments: { monitor_id: monitorId, worker_key: w2.worker_key, action: "reconcile_created", runtime_session_id: "ses_recovered", creation_receipt: "msg_rec" },
    });
    const w3 = (reconciled.structuredContent as { worker: { lifecycle: string; creation_receipt: string | null } }).worker;
    assert.equal(w3.lifecycle, "active");
    assert.equal(w3.creation_receipt, "msg_rec");

    // A foreign monitor cannot mutate this worker; it gets its own M2 alias.
    const created2 = await client.callTool({
      name: "create_monitor",
      arguments: { title: "Other", task_id: "task_33333333-3333-4333-8333-333333333333" },
    });
    const monitorId2 = (created2.structuredContent as { monitor: { monitor_id: string } }).monitor.monitor_id;
    const foreign = await client.callTool({
      name: "update_monitor_worker",
      arguments: { monitor_id: monitorId2, worker_key: w0.worker_key, action: "archive" },
    });
    assert.equal(foreign.isError, true);
    assert.equal((await readRegistrySnapshot(project)).registry.monitors.find((m) => m.id === monitorId2)?.alias, "M2");

    // Actual metadata-only management audit is visible on the monitor history.
    const hist2 = await client.callTool({ name: "get_monitor_history", arguments: { monitor_id: monitorId, limit: 50 } });
    const types = (hist2.structuredContent as { history: Array<{ type: string }> }).history.map((entry) => entry.type);
    assert.ok(types.includes("worker-created"));
    assert.ok(types.includes("worker-reuse"));
    assert.ok(types.includes("worker-rebind"));
    assert.ok(types.includes("worker-create-uncertain"));
    assert.ok(types.includes("worker-reconcile_created"));
  } finally {
    await client.close(); await adapter.close(); await rm(project, { recursive: true, force: true });
  }
});

test("pending-input coverage and descendant fields pass real tool output validation; strictness is retained", async () => {
  const gateway = new FakeGateway();
  gateway.detailsResult = {
    id: "ses_work",
    title: "Coverage fixture",
    created: 1,
    updated: 2,
    activity: "idle",
    pending_input: {
      permissions: 2,
      questions: 0,
      coverage: "session+descendants",
      descendant_permissions: [
        { session_id: "ses_child", permission: "external_directory" },
      ],
    },
    admission: { write_in_progress: false },
  };
  gateway.statusResult = {
    session_id: "ses_work",
    backend_activity: "busy",
    state: "input_required",
    pending_input: { permissions: 1, questions: 0, coverage: "unknown" },
    pending_input_scope: "unknown",
    assistant_message_ids: [],
  };
  gateway.progressResult = {
    session_id: "ses_work",
    observed_at: new Date().toISOString(),
    source: "backend_snapshot",
    backend_activity: "busy",
    pending_input: { permissions: 1, questions: 0, coverage: "session" },
    pending_input_scope: "session+descendants",
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
  gateway.abortResult = {
    session_id: "ses_work",
    state: "no_active_turn",
    observed_at: new Date().toISOString(),
    activity_after: "idle",
    pending_input_after: {
      permissions: 1,
      questions: 0,
      coverage: "session+descendants",
      descendant_permissions: [
        { session_id: "ses_child", permission: "external_directory" },
      ],
    },
    guidance: "fixture",
  };
  const adapter = new McpHttpServer({ ...runtime(), project: await mkdtemp(join(tmpdir(), "ocvm-pending-wire-")) }, token, gateway);
  const port = await adapter.start();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { "X-OCVM-MCP-Token": token } } });
  const client = new Client({ name: "pending-wire", version: "1.0.0" });
  try {
    await client.connect(transport);
    // Positive: every coverage form and the bounded descendant field pass the
    // REAL dispatch path (client -> server -> safeHandler -> outputSchema).
    const details = await client.callTool({ name: "get_session", arguments: { session_id: "ses_work" } });
    assert.equal(Boolean(details.isError), false, JSON.stringify(details));
    const detailContent = details.structuredContent as { pending_input: { coverage?: string; descendant_permissions?: { session_id: string }[] } };
    assert.equal(detailContent.pending_input.coverage, "session+descendants");
    assert.equal(detailContent.pending_input.descendant_permissions?.[0]?.session_id, "ses_child");
    const status = await client.callTool({ name: "get_session_status", arguments: { session_id: "ses_work" } });
    assert.equal(Boolean(status.isError), false, JSON.stringify(status));
    const statusContent = status.structuredContent as { pending_input: { coverage?: string }, pending_input_scope?: string };
    assert.equal(statusContent.pending_input.coverage, "unknown", "unknown coverage must stay honest");
    assert.equal(statusContent.pending_input_scope, "unknown");
    const progress = await client.callTool({ name: "get_session_progress", arguments: { session_id: "ses_work" } });
    assert.equal(Boolean(progress.isError), false, JSON.stringify(progress));
    const progressContent = progress.structuredContent as { pending_input_scope?: string };
    assert.equal(progressContent.pending_input_scope, "session+descendants");
    const abort = await client.callTool({ name: "abort_session_turn", arguments: { session_id: "ses_work" } });
    assert.equal(Boolean(abort.isError), false, JSON.stringify(abort));
    // Negative: strict validation is retained — unknown coverage values and
    // unknown extra fields still produce INTERNAL_ERROR invalid results.
    const baseDetails = gateway.detailsResult!;
    gateway.detailsResult = {
      ...baseDetails,
      pending_input: { permissions: 1, questions: 0, coverage: "sometimes" } as never,
    };
    const badCoverage = await client.callTool({ name: "get_session", arguments: { session_id: "ses_work" } });
    assert.equal("isError" in badCoverage && badCoverage.isError, true, "unknown coverage value must fail strict validation");
    gateway.detailsResult = {
      ...baseDetails,
      pending_input: { permissions: 1, questions: 0, coverage: "session", extra_field: true } as never,
    };
    const badField = await client.callTool({ name: "get_session", arguments: { session_id: "ses_work" } });
    assert.equal("isError" in badField && badField.isError, true, "unknown pending_input field must fail strict validation");
    assert.match(JSON.stringify(badField), /The MCP adapter produced an invalid result\./u);
  } finally {
    await client.close().catch(() => undefined);
    await adapter.close();
  }
});
