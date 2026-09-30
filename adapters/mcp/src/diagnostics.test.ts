import assert from "node:assert/strict";
import test from "node:test";
import { traceToolCall } from "./diagnostics.js";

test("low-risk task write diagnostics name tools without note, path or result contents", async () => {
  for (const tool of ["add_task_management_note", "add_task_document_bindings"]) {
    const lines: string[] = [];
    await traceToolCall(tool, { task_id: "task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      note: "PRIVATE NOTE", compact_context: "PRIVATE PATH", concept_plan: "PRIVATE PLAN" },
    async () => ({ content: [{ type: "text", text: "PRIVATE RESULT" }] }), (line) => lines.push(line));
    assert.match(lines[0]!, new RegExp(`"tool":"${tool}"`, "u"));
    assert.equal(lines.length, 2);
    assert.doesNotMatch(lines.join(""), /PRIVATE/u);
  }
});

test("communication logs correlate calls without copying input or results", async () => {
  const lines: string[] = [];
  let calls = 0;
  const result = {
    content: [{ type: "text" as const, text: "PRIVATE RESULT" }],
    structuredContent: { message_id: "msg_123" },
  };
  assert.equal(
    await traceToolCall(
      "send_message",
      { session_id: "ses_123", prompt: "PRIVATE PROMPT", token: "SECRET" },
      async () => {
        calls++;
        return result;
      },
      (line) => lines.push(line),
    ),
    result,
  );
  const records = lines.map((line) =>
    JSON.parse(line.slice("[mcp] call=".length)),
  );
  assert.equal(calls, 1);
  assert.equal(records.length, 2);
  assert.equal(records[0].request, records[1].request);
  assert.equal(records[0].state, "started");
  assert.equal(records[1].state, "completed");
  assert.equal(records[1].message_id, "msg_123");
  assert.equal(typeof records[1].duration_ms, "number");
  assert.doesNotMatch(lines.join(""), /PRIVATE|SECRET/);
});

test("attachment upload diagnostics never log uploaded bytes or filenames", async () => {
  const lines: string[] = [];
  await traceToolCall(
    "upload_attachment",
    {
      session_id: "ses_123",
      filename: "PRIVATE-MOCKUP.png",
      mime_type: "image/png",
      data_base64: "SECRET-BASE64-PAYLOAD",
    },
    async () => ({ content: [{ type: "text", text: "Uploaded." }] }),
    (line) => lines.push(line),
  );
  assert.match(lines[0]!, /"tool":"upload_attachment"/u);
  assert.match(lines[0]!, /"session_id":"ses_123"/u);
  assert.doesNotMatch(lines.join(""), /PRIVATE|SECRET|mockup|base64|data:/iu);
});

test("failed calls are logged without retries, raw errors or unknown tool names", async () => {
  const lines: string[] = [];
  const error = new Error("PRIVATE EXCEPTION");
  await assert.rejects(
    traceToolCall(
      "PRIVATE TOOL",
      { session_id: "PRIVATE ID\n" },
      async () => {
        throw error;
      },
      (line) => lines.push(line),
    ),
    error,
  );
  assert.match(lines[1]!, /"state":"failed"/);
  assert.match(lines[0]!, /"tool":"unknown"/);
  assert.doesNotMatch(lines.join(""), /PRIVATE/);
  const result = {
    isError: true,
    content: [],
    _meta: {
      "opencode-vm/error": { code: "SESSION_BUSY", message: "PRIVATE MESSAGE" },
    },
  };
  assert.equal(
    await traceToolCall(
      "send_message",
      {},
      async () => result,
      (line) => lines.push(line),
    ),
    result,
  );
  assert.match(lines[3]!, /SESSION_BUSY/);
  assert.doesNotMatch(lines.join(""), /PRIVATE/);
  assert.equal(
    await traceToolCall(
      "send_message",
      {},
      async () => result,
      () => {
        throw new Error("log failure");
      },
    ),
    result,
  );
});

test("admission rejection diagnostics preserve reason and blocking receipt without payloads", async () => {
  const lines: string[] = [];
  await traceToolCall(
    "send_message",
    { session_id: "ses_123", message: "PRIVATE PROMPT" },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "PRIVATE RESPONSE" }],
      _meta: {
        "opencode-vm/error": {
          code: "SUBMISSION_UNRESOLVED",
          reason: "receipt_not_terminal",
          message_id: "msg_previous",
          message: "PRIVATE ERROR",
        },
      },
    }),
    (line) => lines.push(line),
  );
  const end = JSON.parse(lines[1]!.slice("[mcp] call=".length));
  assert.equal(end.error, "SUBMISSION_UNRESOLVED");
  assert.equal(end.reason, "receipt_not_terminal");
  assert.equal(end.blocking_message_id, "msg_previous");
  assert.doesNotMatch(lines.join(""), /PRIVATE/);
});
