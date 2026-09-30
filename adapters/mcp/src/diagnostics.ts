import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ADMISSION_ERROR_REASONS, isRecord } from "./types.js";

const tools = new Set([
  "list_sessions",
  "create_session",
  "archive_session",
  "rename_session",
  "get_session",
  "get_session_status",
  "get_session_history",
  "send_message",
  "supersede_unresolved_submission",
  "upload_attachment",
  "get_session_runtime_options",
  "update_session_runtime",
  "get_project_activity",
  "wait_for_project_activity",
  "get_task_result",
  "get_message",
  "read_message_content",
  "get_session_progress",
  "list_project_tasks",
  "get_project_task",
  "register_task_document",
  "add_task_management_note",
  "add_task_document_bindings",
  "get_task_documents",
  "read_task_document",
  "create_project_task",
  "update_project_task",
  "move_project_task",
  "add_task_comment",
  "link_task_to_session",
  "transfer_project_task",
]);

/** Local operator diagnostics only. Never serialize a request/result body. */
export async function traceToolCall(
  name: string,
  input: Record<string, unknown>,
  handler: () => Promise<CallToolResult>,
  write = (line: string) => {
    process.stderr.write(line);
  },
): Promise<CallToolResult> {
  const request = randomUUID();
  const tool = tools.has(name) ? name : "unknown";
  const started = performance.now();
  const id = (value: unknown) =>
    typeof value === "string" && /^(ses|msg)_[a-zA-Z0-9]{1,128}$/u.test(value)
      ? value
      : undefined;
  const requestId = (value: unknown) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
      ? value
      : undefined;
  const metadata = {
    request,
    tool,
    session_id: id(input.session_id),
    message_id: id(input.message_id ?? input.submitted_message_id),
    ...(requestId(input.request_id)
      ? { request_id: requestId(input.request_id) }
      : {}),
    ...(id(input.guarded_message_id)
      ? { guarded_message_id: id(input.guarded_message_id) }
      : {}),
  };
  const log = (data: object) => {
    try {
      write(
        `[mcp] call=${JSON.stringify({ timestamp: new Date().toISOString(), ...metadata, ...data })}\n`,
      );
    } catch {
      /* Logging must not change submission/result semantics. */
    }
  };
  log({ state: "started" });
  let state = "failed";
  let error: string | undefined;
  let message: string | undefined;
  let reason: string | undefined;
  let blockingMessage: string | undefined;
  try {
    const result = await handler();
    state = result.isError ? "failed" : "completed";
    const detail = result._meta?.["opencode-vm/error"];
    if (
      isRecord(detail) &&
      typeof detail.code === "string" &&
      /^[A-Z_]{1,80}$/u.test(detail.code)
    )
      error = detail.code;
    message = id(result.structuredContent?.message_id);
    if (isRecord(detail)) {
      if (ADMISSION_ERROR_REASONS.some((value) => value === detail.reason))
        reason = detail.reason as string;
      blockingMessage = id(detail.message_id);
    }
    return result;
  } finally {
    log({
      state,
      duration_ms: Math.round(performance.now() - started),
      error,
      reason,
      ...(blockingMessage ? { blocking_message_id: blockingMessage } : {}),
      ...(message ? { message_id: message } : {}),
    });
  }
}
