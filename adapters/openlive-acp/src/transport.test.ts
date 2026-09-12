import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import {
  modelConfigOptions,
  limitNdjsonLines,
  parsePromptContent,
  startAcp,
  stripOpenLivePreamble,
  validateSessionScope,
} from "./acp/transport.js";
import type { CallController } from "./core/call-controller.js";

test("client-provided MCP servers are ignored for the central runtime", () => {
  process.env.OCVM_OPENLIVE_PROJECT = "/project";

  assert.doesNotThrow(() =>
    validateSessionScope({
      cwd: "/project",
      mcpServers: [{ name: "host-only", command: "do-not-run" }],
    }),
  );
});

test("additional workspaces and project mismatches remain rejected", () => {
  process.env.OCVM_OPENLIVE_PROJECT = "/project";

  assert.throws(
    () => validateSessionScope({ cwd: "/other" }),
    /workspace does not match/,
  );
  assert.throws(
    () =>
      validateSessionScope({
        cwd: "/project",
        additionalDirectories: ["/other"],
      }),
    /Additional OpenLive workspaces/,
  );
});

test("the fixed OpenLive preamble is not stored in the OpenCode session", () => {
  const base =
    "[You're being used through OpenLive, a hands-free VOICE interface. Speak naturally.]";

  assert.equal(
    stripOpenLivePreamble(`${base}\n\nList my sessions`),
    "List my sessions",
  );
  assert.equal(
    stripOpenLivePreamble(
      `${base}\n[How the user wants you to behave and speak:\nAnswer in German.]\n\nList my sessions`,
    ),
    "[How the user wants you to behave and speak:\nAnswer in German.]\n\nList my sessions",
  );
  assert.equal(stripOpenLivePreamble("List my sessions"), "List my sessions");
});

test("OpenLive JPEG frames are validated and retained with prompt text", () => {
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

  assert.deepEqual(
    parsePromptContent([
      { type: "text", text: "What is on my screen?" },
      { type: "image", data: frame, mimeType: "image/jpeg" },
    ]),
    {
      text: "What is on my screen?",
      images: [{ data: frame, mimeType: "image/jpeg" }],
    },
  );
  assert.throws(
    () =>
      parsePromptContent([
        { type: "text", text: "Look" },
        { type: "image", data: frame, mimeType: "image/png" },
      ]),
    /Only image\/jpeg screen frames are supported/,
  );
  assert.throws(
    () =>
      parsePromptContent([
        { type: "text", text: "Look" },
        { type: "image", data: "not-base64", mimeType: "image/jpeg" },
      ]),
    /invalid base64 JPEG frame/,
  );
  assert.throws(
    () =>
      parsePromptContent([
        { type: "text", text: "Look" },
        ...Array.from({ length: 3 }, () => ({
          type: "image",
          data: frame,
          mimeType: "image/jpeg",
        })),
      ]),
    /at most 2 camera\/screen frames/,
  );
  assert.throws(
    () =>
      parsePromptContent([
        { type: "text", text: "Look" },
        {
          type: "image",
          data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
          mimeType: "image/jpeg",
        },
      ]),
    /exceeds the 5 MiB limit/,
  );
  const largeFrame = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");
  assert.throws(
    () =>
      parsePromptContent([
        { type: "text", text: "Look" },
        { type: "image", data: largeFrame, mimeType: "image/jpeg" },
        { type: "image", data: largeFrame, mimeType: "image/jpeg" },
      ]),
    /exceeds the 8 MiB per-turn limit/,
  );
});

test("ACP input is rejected before an oversized NDJSON line is parsed", async () => {
  const limited = limitNdjsonLines(Readable.from(["123", "456\n"]), 5);

  await assert.rejects(async () => {
    for await (const _chunk of limited) {
      // Drain the guarded stream.
    }
  }, /exceeds the 5-byte limit/);
});

test("ACP exposes the OpenCode model catalog as a model config option", () => {
  const controller = {
    modelState() {
      return {
        current: "Luna/gpt",
        options: [
          {
            id: "Luna/gpt",
            name: "GPT Luna (Luna)",
            model: { providerID: "Luna", modelID: "gpt" },
          },
        ],
      };
    },
  } as unknown as CallController;

  assert.deepEqual(modelConfigOptions(controller, "call"), [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "Luna/gpt",
      options: [{ value: "Luna/gpt", name: "GPT Luna (Luna)" }],
    },
  ]);
});

test("ACP forwards a screen frame with its spoken turn", async () => {
  process.env.OCVM_OPENLIVE_PROJECT = "/project";
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  let received:
    | { id: string; text: string; images: Array<Record<string, unknown>> }
    | undefined;
  const controller = {
    newCall() {
      return "ocvm:hash:image";
    },
    modelState() {
      return undefined;
    },
    async prompt(
      id: string,
      text: string,
      _onUpdate: unknown,
      images: Array<Record<string, unknown>>,
    ) {
      received = { id, text, images };
      return "end_turn" as const;
    },
    async shutdown() {},
  } as unknown as CallController;
  const input = new PassThrough();
  const output = new PassThrough();
  let buffered = "";
  let promptResponded!: () => void;
  const response = new Promise<void>((resolve) => {
    promptResponded = resolve;
  });
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffered.slice(0, newline)) as { id?: number };
      buffered = buffered.slice(newline + 1);
      if (message.id === 3) promptResponded();
    }
  });
  const running = startAcp(controller, input, output);
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    })}\n`,
  );
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/project", mcpServers: [] },
    })}\n`,
  );
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "ocvm:hash:image",
        prompt: [
          { type: "text", text: "What is visible?" },
          { type: "image", data: frame, mimeType: "image/jpeg" },
        ],
      },
    })}\n`,
  );
  await response;
  input.end();
  await running;

  assert.deepEqual(received, {
    id: "ocvm:hash:image",
    text: "What is visible?",
    images: [{ data: frame, mimeType: "image/jpeg" }],
  });
});

test("ACP load replays manager text before responding and closes on EOF", async () => {
  process.env.OCVM_OPENLIVE_PROJECT = "/project";
  let shutdowns = 0;
  const controller = {
    loadCall(id: string) {
      assert.equal(id, "ocvm:hash:existing");
    },
    async replayManager() {
      return [
        { id: "msg_user", role: "user", text: "Question" },
        { id: "msg_agent", role: "assistant", text: "Answer" },
      ];
    },
    modelState() {
      return undefined;
    },
    async shutdown() {
      shutdowns++;
    },
  } as unknown as CallController;
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buffered = "";
  let loadResponded: (() => void) | undefined;
  const response = new Promise<void>((resolve) => {
    loadResponded = resolve;
  });
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (message.id === 2) loadResponded?.();
    }
  });
  const running = startAcp(controller, input, output);
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    })}\n`,
  );
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: {
        cwd: "/project",
        mcpServers: [],
        sessionId: "ocvm:hash:existing",
      },
    })}\n`,
  );
  await response;
  input.end();
  await running;

  const initialized = messages.find((message) => message.id === 1) as {
    result: {
      agentCapabilities: {
        sessionCapabilities: unknown;
        promptCapabilities: { image: boolean };
      };
    };
  };
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities, {
    close: {},
  });
  assert.equal(
    initialized.result.agentCapabilities.promptCapabilities.image,
    true,
  );
  const loadIndex = messages.findIndex((message) => message.id === 2);
  const replay = messages
    .slice(0, loadIndex)
    .filter((message) => message.method === "session/update") as Array<{
    params: { update: { sessionUpdate: string; messageId: string } };
  }>;
  assert.deepEqual(
    replay.map((message) => message.params.update),
    [
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Question" },
        messageId: "msg_user",
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
        messageId: "msg_agent",
      },
    ],
  );
  assert.equal(shutdowns, 1);
});
