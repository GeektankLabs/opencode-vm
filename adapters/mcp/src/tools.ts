import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { SessionGateway } from "./opencode.js";
import {
  ACTIVITY_TYPES,
  ADAPTER_VERSION,
  AdapterError,
  isRecord,
} from "./types.js";
import {
  DEFAULT_CONTENT_BYTES,
  MAX_CONTENT_BYTES,
  READ_RESPONSE_BYTES,
  jsonBytes,
} from "./content.js";

const sessionId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\x00-\x1f\x7f]+$/u);
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/u);
const opaqueCursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s\x00-\x1f\x7f]+$/u);
const readReference = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
const getMessageInput = z
  .object({ session_id: sessionId, message_id: sessionId })
  .strict();
const readContentInput = z
  .object({
    content_ref: readReference,
    cursor: readReference.optional(),
    max_bytes: z
      .number()
      .int()
      .min(4)
      .max(MAX_CONTENT_BYTES)
      .default(DEFAULT_CONTENT_BYTES),
  })
  .strict();
const taskResultInput = z
  .object({
    session_id: sessionId,
    submitted_message_id: sessionId,
    cursor: readReference.optional(),
    limit: z.number().int().min(1).max(20).default(20),
  })
  .strict();

const projectSchema = z.object({ id: z.string(), name: z.string() }).strict();
const pendingSchema = z
  .object({
    permissions: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
  })
  .strict();
const activitySchema = z.enum(["idle", "busy", "retry"]);
const summarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    created: z.number(),
    updated: z.number(),
    activity: activitySchema,
  })
  .strict();

export const listSessionsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(20).default(10),
    cursor: cursor.optional(),
  })
  .strict();

export const getSessionInputSchema = z
  .object({ session_id: sessionId })
  .strict();

export const getSessionStatusInputSchema = z
  .object({ session_id: sessionId, message_id: sessionId.optional() })
  .strict();

export const getSessionHistoryInputSchema = z
  .object({
    session_id: sessionId,
    before: opaqueCursor.optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const sendMessageInputSchema = z
  .object({
    session_id: sessionId,
    message: z.string().min(1).max(32_000),
  })
  .strict();

export const createSessionInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\x00-\x1f\x7f]+$/u)
      .optional(),
  })
  .strict();

const runtimeFields = {
  agent: sessionId,
  provider_id: sessionId,
  model_id: sessionId,
  variant: sessionId,
};
const runtimeSchema = z.object(runtimeFields).strict();
const runtimeOptionsInput = z
  .object({ session_id: sessionId.optional() })
  .strict();
const runtimeUpdateInput = z
  .object({
    session_id: sessionId,
    agent: sessionId.optional(),
    provider_id: sessionId.optional(),
    model_id: sessionId.optional(),
    variant: sessionId.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.agent !== undefined ||
      value.provider_id !== undefined ||
      value.model_id !== undefined ||
      value.variant !== undefined,
  );
const runtimeOptionsOutput = z
  .object({
    agents: z.array(z.string()),
    providers: z.array(
      z.object({ provider_id: z.string(), name: z.string() }).strict(),
    ),
    models: z.array(
      z
        .object({
          provider_id: z.string(),
          model_id: z.string(),
          name: z.string(),
          variants: z.array(z.string()),
        })
        .strict(),
    ),
    truncated: z.boolean(),
    current: runtimeSchema.optional(),
  })
  .strict();
const runtimeUpdateOutput = z
  .object({
    session_id: z.string(),
    previous: runtimeSchema,
    current: runtimeSchema,
    state: z.literal("updated"),
  })
  .strict();
const activityFields = {
  after_cursor: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  session_ids: z.array(sessionId).min(1).max(50).optional(),
  event_types: z
    .array(z.enum(ACTIVITY_TYPES))
    .min(1)
    .max(ACTIVITY_TYPES.length)
    .optional(),
};
const activityInput = z.object(activityFields).strict();
const waitActivityInput = z
  .object({
    ...activityFields,
    after_cursor: z.string().min(1).max(128),
    timeout_ms: z.number().int().min(1).max(15000).default(10000),
  })
  .strict();
const activityOutput = z
  .object({
    events: z.array(
      z
        .object({
          event_id: z.string(),
          cursor: z.string(),
          timestamp: z.string(),
          session_id: z.string(),
          session_title: z.string(),
          message_id: z.string().optional(),
          type: z.enum(ACTIVITY_TYPES),
          state: z.string(),
          assistant_message_ids: z.array(z.string()),
          pending_input: pendingSchema.optional(),
          previous: runtimeSchema.optional(),
          current: runtimeSchema.optional(),
          source: z.enum(["mcp", "observed", "reconciled"]),
        })
        .strict(),
    ),
    next_cursor: z.string(),
    has_more: z.boolean(),
    tracking: z
      .object({
        connected: z.boolean(),
        partial: z.boolean(),
        last_reconciled_at: z.string().optional(),
      })
      .strict(),
  })
  .strict();
const waitActivityOutput = activityOutput
  .extend({ timeout: z.boolean() })
  .strict();

const listSessionsOutputSchema = z
  .object({
    project: projectSchema,
    sessions: z.array(summarySchema),
    next_cursor: z.string().optional(),
    truncated: z.boolean(),
  })
  .strict();

const sessionDetailsOutputSchema = summarySchema
  .extend({
    agent: z.string().optional(),
    provider_id: z.string().optional(),
    model_id: z.string().optional(),
    variant: z.string().optional(),
    pending_input: pendingSchema,
  })
  .strict();

const sessionStatusOutputSchema = z
  .object({
    session_id: z.string(),
    message_id: z.string().optional(),
    backend_activity: activitySchema,
    state: z.enum([
      "unknown",
      "submitted",
      "running",
      "input_required",
      "completed",
      "failed",
      "aborted",
    ]),
    pending_input: pendingSchema,
    assistant_message_ids: z.array(z.string()),
    observed_at: z.string().optional(),
    source: z.literal("backend").optional(),
    task_status_reason: z
      .enum([
        "not_requested",
        "outside_history_or_not_observed",
        "non_terminal_evidence",
      ])
      .optional(),
  })
  .strict();

const contentDescriptorSchema = z
  .object({
    content_ref: z.string(),
    revision: z.string(),
    unit: z.literal("utf8_bytes"),
    total_bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    availability: z.enum(["available", "empty", "not_exposed"]),
    omitted_parts: z.array(
      z
        .object({
          type: z.string(),
          count: z.number().int().positive(),
          reason: z.literal("part_not_exposed"),
        })
        .strict(),
    ),
  })
  .strict();
const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    parent_id: z.string().optional(),
    text: z.string(),
    created: z.number(),
    completed: z.number().optional(),
    finish: z.string().optional(),
    error: z.enum(["aborted", "failed"]).optional(),
    text_truncated: z.boolean(),
    content_complete: z.boolean().optional(),
    truncation_reason: z.enum(["preview_limit", "response_budget"]).optional(),
    content: contentDescriptorSchema.optional(),
  })
  .strict();
const readableMessageSchema = messageSchema
  .extend({ content: contentDescriptorSchema, content_complete: z.boolean() })
  .strict();
const historyOutputSchema = z
  .object({
    session_id: z.string(),
    messages: z.array(messageSchema),
    next_before: z.string().optional(),
    truncated: z.boolean(),
    history_has_more: z.boolean().optional(),
  })
  .strict();

const getMessageOutput = z
  .object({ session_id: z.string(), message: readableMessageSchema })
  .strict();
const readContentOutput = z
  .object({
    session_id: z.string(),
    message_id: z.string(),
    revision: z.string(),
    unit: z.literal("utf8_bytes"),
    total_bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    range: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict(),
    text: z.string(),
    has_more: z.boolean(),
    next_cursor: z.string().optional(),
    content_complete: z.boolean(),
  })
  .strict();
const taskResultOutput = z
  .object({
    session_id: z.string(),
    submitted_message_id: z.string(),
    state: z.enum([
      "unknown",
      "submitted",
      "running",
      "input_required",
      "completed",
      "failed",
      "aborted",
    ]),
    state_reason: z
      .enum([
        "search_incomplete",
        "non_terminal_evidence",
        "no_terminal_evidence",
      ])
      .optional(),
    observed_at: z.string(),
    source: z.literal("backend"),
    search_complete: z.boolean(),
    next_cursor: z.string().optional(),
    order: z.literal("newest_first"),
    messages: z.array(
      readableMessageSchema
        .extend({ result_kind: z.enum(["terminal", "intermediate"]) })
        .strict(),
    ),
  })
  .strict();

const sendMessageOutputSchema = z
  .object({
    session_id: z.string(),
    message_id: z.string(),
    state: z.literal("submitted"),
    submitted_at: z.string().optional(),
    activity_cursor: z.string().optional(),
  })
  .strict();

const createSessionOutputSchema = z
  .object({
    project: projectSchema,
    session_id: z.string(),
    title: z.string(),
    agent: z.string(),
    provider_id: z.string(),
    model_id: z.string(),
    variant: z.string().optional(),
    state: z.literal("created"),
  })
  .strict();

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function createMcpServer(gateway: SessionGateway): McpServer {
  const server = new McpServer({
    name: "opencode-vm",
    version: ADAPTER_VERSION,
  });

  const getMessageHandler = safeHandler(
    async (input: z.output<typeof getMessageInput>) => {
      const result = await gateway.getMessage(
        input.session_id,
        input.message_id,
      );
      return readSuccess(
        result,
        "Message preview and revision-bound content_ref. Use read_message_content to retrieve the original text.",
      );
    },
  );
  const readContentHandler = safeHandler(
    async (input: z.output<typeof readContentInput>) => {
      const result = await gateway.readMessageContent(
        input.content_ref,
        input.cursor,
        input.max_bytes,
      );
      return readSuccess(
        result,
        result.has_more
          ? "Content page. Continue with the same content_ref and next_cursor."
          : "End of this revision. Verify concatenated UTF-8 text against sha256; this does not imply a regular model finish.",
      );
    },
  );
  const taskResultHandler = safeHandler(
    async (input: z.output<typeof taskResultInput>) => {
      const result = await gateway.getTaskResult(
        input.session_id,
        input.submitted_message_id,
        input.cursor,
        input.limit,
      );
      return readSuccess(
        result,
        result.search_complete
          ? "Result search complete for this observed session boundary. Read terminal message content_refs; pages are newest first."
          : "Result search incomplete. Save message references and continue with next_cursor, even for an empty page; unknown does not mean absent.",
      );
    },
  );
  server.registerTool(
    "get_message",
    {
      title: "Get Stored Message",
      description:
        "Read one known visible user/assistant message directly: identity, parent, finish, preview, omissions and content_ref. Never starts model work. Read references expire on adapter restart; reacquire with IDs. CONTENT_CHANGED requires restarting the new revision.",
      inputSchema: getMessageInput,
      outputSchema: getMessageOutput,
      annotations: readOnlyAnnotations,
    },
    getMessageHandler,
  );
  server.registerTool(
    "read_message_content",
    {
      title: "Read Message Content",
      description:
        "Read original visible text in bounded UTF-8 pages using content_ref from get_message, history or get_task_result. Keep the same reference and follow next_cursor until has_more=false. max_bytes bounds text bytes, not the JSON response. Verify concatenation with sha256. Changed text reports CONTENT_CHANGED, never mixed revisions. Does not acknowledge/read-mark results.",
      inputSchema: readContentInput,
      outputSchema: readContentOutput,
      annotations: readOnlyAnnotations,
    },
    readContentHandler,
  );
  server.registerTool(
    "get_task_result",
    {
      title: "Find Task Result",
      description:
        "Find results by the original submitted user message ID, including older tasks beyond 100 messages. Bounded backward search: follow next_cursor until search_complete, retaining returned references (newest first). Intermediate tool-call steps are not reports. SEARCH_CHANGED means restart the search. Read terminal originals with read_message_content; finish=length/content-filter is not a regular generation finish. No new model call or native MCP task.",
      inputSchema: taskResultInput,
      outputSchema: taskResultOutput,
      annotations: readOnlyAnnotations,
    },
    taskResultHandler,
  );

  const listSessionsHandler = safeHandler(
    async ({
      limit,
      cursor: value,
    }: z.output<typeof listSessionsInputSchema>) => {
      const result = await gateway.listSessions(limit, value);
      return success(
        result,
        `Found ${result.sessions.length} exposed session${result.sessions.length === 1 ? "" : "s"} for ${result.project.name}.`,
      );
    },
  );
  const getSessionHandler = safeHandler(
    async ({ session_id }: z.output<typeof getSessionInputSchema>) => {
      const result = await gateway.getSessionDetails(session_id);
      return success(result, `Session ${result.id} is ${result.activity}.`);
    },
  );
  const getSessionStatusHandler = safeHandler(
    async ({
      session_id,
      message_id,
    }: z.output<typeof getSessionStatusInputSchema>) => {
      const result = await gateway.getSessionStatus(session_id, message_id);
      return success(
        result,
        message_id
          ? `Message ${message_id} is ${result.state}; session activity is ${result.backend_activity}.`
          : `Session ${session_id} activity is ${result.backend_activity}.`,
      );
    },
  );
  const getSessionHistoryHandler = safeHandler(
    async ({
      session_id,
      limit,
      before,
    }: z.output<typeof getSessionHistoryInputSchema>) => {
      const result = await gateway.getSessionHistory(session_id, limit, before);
      return readSuccess(
        result,
        `Returned ${result.messages.length} text message${result.messages.length === 1 ? "" : "s"} from session ${session_id}.`,
      );
    },
  );
  const sendMessageHandler = safeHandler(
    async ({
      session_id,
      message,
    }: z.output<typeof sendMessageInputSchema>) => {
      const result = await gateway.sendMessage(session_id, message);
      return success(
        result,
        `Submitted message ${result.message_id} to session ${result.session_id}. Poll get_session_status before sending another message.`,
      );
    },
  );

  const createSessionHandler = safeHandler(
    async ({ title }: z.output<typeof createSessionInputSchema>) => {
      const result = await gateway.createSession(title);
      return success(
        result,
        `Created session ${result.session_id} (${result.title}) for ${result.project.name} using ${result.agent} and ${result.provider_id}/${result.model_id}. Use send_message with this session_id to start work.`,
      );
    },
  );

  const optionsHandler = safeHandler(
    async ({ session_id }: z.output<typeof runtimeOptionsInput>) =>
      success(
        await gateway.getSessionRuntimeOptions(session_id),
        "Available primary agents, connected providers, models and variants.",
      ),
  );
  const updateHandler = safeHandler(
    async ({ session_id, ...patch }: z.output<typeof runtimeUpdateInput>) =>
      success(
        await gateway.updateSessionRuntime(session_id, patch),
        `Updated runtime settings for session ${session_id}.`,
      ),
  );
  const activityHandler = safeHandler(
    async (query: z.output<typeof activityInput>) => {
      const result = await gateway.getProjectActivity(query);
      return success(
        result,
        `Returned ${result.events.length} project activity events. Save next_cursor for the next read.`,
      );
    },
  );
  const waitHandler = safeHandler(
    async (query: z.output<typeof waitActivityInput>) => {
      const result = await gateway.waitForProjectActivity(query);
      return success(
        result,
        result.timeout
          ? "Activity wait timed out; save next_cursor."
          : `Returned ${result.events.length} activity events.`,
      );
    },
  );
  server.registerTool(
    "get_session_runtime_options",
    {
      title: "Get Session Runtime Options",
      description:
        "List available primary agents and connected provider/model/variant combinations. Optionally include a session's current runtime.",
      inputSchema: runtimeOptionsInput,
      outputSchema: runtimeOptionsOutput,
      annotations: readOnlyAnnotations,
    },
    optionsHandler,
  );
  server.registerTool(
    "update_session_runtime",
    {
      title: "Update Session Runtime",
      description:
        "Change specified agent/provider/model/variant fields of an idle project session. Omitted fields stay unchanged. Query options first. Busy sessions are rejected; failed updates may be partial and must not be retried automatically.",
      inputSchema: runtimeUpdateInput,
      outputSchema: runtimeUpdateOutput,
      annotations: { ...writeAnnotations, openWorldHint: false },
    },
    updateHandler,
  );
  server.registerTool(
    "get_project_activity",
    {
      title: "Get Project Activity",
      description:
        "Read the bounded persistent activity journal across project sessions since after_cursor. Completion events reference message IDs; fetch history separately. Save next_cursor; CURSOR_EXPIRED requires a fresh read. Check tracking for collector outages/limits.",
      inputSchema: activityInput,
      outputSchema: activityOutput,
      annotations: readOnlyAnnotations,
    },
    activityHandler,
  );
  server.registerTool(
    "wait_for_project_activity",
    {
      title: "Wait For Project Activity",
      description:
        "Wait up to 15 seconds for matching project activity after a cursor; returns timeout=true when no matching event arrives. This is short polling, not external push.",
      inputSchema: waitActivityInput,
      outputSchema: waitActivityOutput,
      annotations: readOnlyAnnotations,
    },
    waitHandler,
  );

  server.registerTool(
    "create_session",
    {
      title: "Create OpenCode Session",
      description:
        "Create an empty root work session in this configured project using OpenCode's default work agent/model. Use when the user requests a new session. Returns session_id; call send_message separately to start work. Non-idempotent: do not retry automatically if creation is uncertain.",
      inputSchema: createSessionInputSchema,
      outputSchema: createSessionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createSessionHandler,
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List OpenCode Sessions",
      description:
        "List bounded root work sessions for this configured project.",
      inputSchema: listSessionsInputSchema,
      outputSchema: listSessionsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    listSessionsHandler,
  );

  server.registerTool(
    "get_session",
    {
      title: "Get OpenCode Session",
      description:
        "Inspect one exposed root work session: current agent/model/variant, activity and pending-input counts. Use this compact view to check runtime settings; request the full runtime options catalog only when choosing settings.",
      inputSchema: getSessionInputSchema,
      outputSchema: sessionDetailsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    getSessionHandler,
  );

  server.registerTool(
    "get_session_status",
    {
      title: "Get OpenCode Session Status",
      description:
        "Inspect backend activity and the correlated state of an optional submitted message (newest 100 messages). Without message_id no particular task was requested. For older tasks or complete result references use get_task_result. Session busy alone is not proof that a requested task started.",
      inputSchema: getSessionStatusInputSchema,
      outputSchema: sessionStatusOutputSchema,
      annotations: readOnlyAnnotations,
    },
    getSessionStatusHandler,
  );

  server.registerTool(
    "get_session_history",
    {
      title: "Get OpenCode Session History",
      description:
        "Read bounded user/assistant text previews. history_has_more concerns older messages; text_truncated concerns a preview. Follow content_ref with read_message_content for the complete visible original. Omissions are explicit; tool output and reasoning are not exposed. For a known task prefer get_task_result.",
      inputSchema: getSessionHistoryInputSchema,
      outputSchema: historyOutputSchema,
      annotations: readOnlyAnnotations,
    },
    getSessionHistoryHandler,
  );

  server.registerTool(
    "send_message",
    {
      title: "Send OpenCode Message",
      description:
        "Submit one asynchronous prompt to an existing session. This can run commands and change project files inside the VM. It is non-idempotent and must not be retried automatically.",
      inputSchema: sendMessageInputSchema,
      outputSchema: sendMessageOutputSchema,
      annotations: writeAnnotations,
    },
    sendMessageHandler,
  );

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const input = request.params.arguments ?? {};
      switch (request.params.name) {
        case "get_message":
          return validatedToolCall(
            getMessageInput,
            getMessageOutput,
            input,
            getMessageHandler,
            extra.requestId,
            request.params.name,
          );
        case "read_message_content":
          return validatedToolCall(
            readContentInput,
            readContentOutput,
            input,
            readContentHandler,
            extra.requestId,
            request.params.name,
          );
        case "get_task_result":
          return validatedToolCall(
            taskResultInput,
            taskResultOutput,
            input,
            taskResultHandler,
            extra.requestId,
            request.params.name,
          );
        case "get_session_runtime_options":
          return validatedToolCall(
            runtimeOptionsInput,
            runtimeOptionsOutput,
            input,
            optionsHandler,
          );
        case "update_session_runtime":
          return validatedToolCall(
            runtimeUpdateInput,
            runtimeUpdateOutput,
            input,
            updateHandler,
          );
        case "get_project_activity":
          return validatedToolCall(
            activityInput,
            activityOutput,
            input,
            activityHandler,
          );
        case "wait_for_project_activity":
          return validatedToolCall(
            waitActivityInput,
            waitActivityOutput,
            input,
            waitHandler,
          );
        case "create_session":
          return validatedToolCall(
            createSessionInputSchema,
            createSessionOutputSchema,
            input,
            createSessionHandler,
          );
        case "list_sessions":
          return validatedToolCall(
            listSessionsInputSchema,
            listSessionsOutputSchema,
            input,
            listSessionsHandler,
          );
        case "get_session":
          return validatedToolCall(
            getSessionInputSchema,
            sessionDetailsOutputSchema,
            input,
            getSessionHandler,
          );
        case "get_session_status":
          return validatedToolCall(
            getSessionStatusInputSchema,
            sessionStatusOutputSchema,
            input,
            getSessionStatusHandler,
          );
        case "get_session_history":
          return validatedToolCall(
            getSessionHistoryInputSchema,
            historyOutputSchema,
            input,
            getSessionHistoryHandler,
            extra.requestId,
            request.params.name,
          );
        case "send_message":
          return validatedToolCall(
            sendMessageInputSchema,
            sendMessageOutputSchema,
            input,
            sendMessageHandler,
          );
        default:
          return errorResult(
            new AdapterError("INVALID_ARGUMENT", "Tool name is invalid."),
          );
      }
    },
  );

  return server;
}

async function validatedToolCall<Input>(
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType,
  input: unknown,
  handler: (input: Input) => Promise<CallToolResult>,
  readRequestId?: string | number,
  readTool?: string,
): Promise<CallToolResult> {
  const parsed = await inputSchema.safeParseAsync(input);
  if (!parsed.success) {
    return errorResult(
      new AdapterError("INVALID_ARGUMENT", "Tool arguments are invalid."),
    );
  }
  const result = await handler(parsed.data);
  if (result.isError) return result;
  const output = await outputSchema.safeParseAsync(result.structuredContent);
  if (!output.success) {
    return errorResult(
      new AdapterError(
        "INTERNAL_ERROR",
        "The MCP adapter produced an invalid result.",
      ),
    );
  }
  if (readRequestId !== undefined) {
    const responseBytes = jsonBytes({
      jsonrpc: "2.0",
      id: readRequestId,
      result,
    });
    if (responseBytes > READ_RESPONSE_BYTES)
      return errorResult(
        new AdapterError(
          "RESPONSE_BUDGET_EXCEEDED",
          "Read response exceeds the serialized budget; reduce the page size.",
        ),
      );
    const data = result.structuredContent!;
    const message = isRecord(data.message) ? data.message : undefined;
    const descriptor = isRecord(message?.content) ? message.content : undefined;
    // Known metadata only: never text, references/cursors, arguments or outputs.
    process.stderr.write(
      `[mcp] read=${JSON.stringify({
        request: randomUUID(),
        tool: readTool,
        session_id: data.session_id,
        message_id: data.message_id ?? data.submitted_message_id ?? message?.id,
        revision: data.revision ?? descriptor?.revision,
        total_bytes: data.total_bytes ?? descriptor?.total_bytes,
        delivered_text_bytes:
          typeof data.text === "string"
            ? Buffer.byteLength(data.text)
            : undefined,
        reason: message?.truncation_reason ?? data.state_reason,
        response_bytes: responseBytes,
        budget_bytes: READ_RESPONSE_BYTES,
      })}\n`,
    );
  }
  return result;
}

function readSuccess(value: object, text: string): CallToolResult {
  const result = success(value, text);
  if (jsonBytes(result) > READ_RESPONSE_BYTES - 2048)
    throw new AdapterError(
      "RESPONSE_BUDGET_EXCEEDED",
      "Read response exceeds the serialized budget; reduce the page size.",
    );
  return result;
}

function safeHandler<Arguments>(
  handler: (input: Arguments) => Promise<CallToolResult>,
): (input: Arguments) => Promise<CallToolResult> {
  return async (input) => {
    const requestId = randomUUID();
    try {
      return await handler(input);
    } catch (error) {
      const safe =
        error instanceof AdapterError
          ? error
          : new AdapterError(
              "INTERNAL_ERROR",
              "The MCP adapter could not complete the request.",
            );
      return errorResult(safe, requestId);
    }
  };
}

function errorResult(
  error: AdapterError,
  requestId = randomUUID(),
): CallToolResult {
  process.stderr.write(`[mcp] request=${requestId} error=${error.code}\n`);
  return {
    isError: true,
    _meta: {
      "opencode-vm/error": {
        code: error.code,
        message: error.message,
        ...(error.correlationId ? { message_id: error.correlationId } : {}),
      },
    },
    content: [
      {
        type: "text",
        text: `${error.code}: ${error.message}${error.correlationId ? ` Correlation message_id: ${error.correlationId}.` : ""}`,
      },
    ],
  };
}

function success(value: object, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...value },
  };
}
