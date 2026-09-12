import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "@opencode-ai/sdk/v2";
import { OpenCodeGateway } from "./opencode/gateway.js";
import type { PromptHooks } from "./opencode/gateway.js";
import type { PromptUpdate, RuntimeDescriptor } from "./types.js";

const runtime: RuntimeDescriptor = {
  schema: 1,
  project: "/project",
  backendUrl: "http://127.0.0.1:4095",
  generation: "test",
  opencodeVersion: "1.18.21",
};

test("missing OpenCode status entries are idle", async () => {
  const client = {
    session: {
      async status() {
        return { data: {} };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  assert.equal(await gateway.status("session-idle"), "idle");
});

test("required manager tool must be registered in OpenCode", async () => {
  const available = new OpenCodeGateway(runtime, {
    tool: {
      async ids() {
        return { data: ["voice_sessions"] };
      },
    },
  } as never);
  const missing = new OpenCodeGateway(runtime, {
    tool: {
      async ids() {
        return { data: [] };
      },
    },
  } as never);

  await assert.doesNotReject(available.requireTool("voice_sessions"));
  await assert.rejects(
    missing.requireTool("voice_sessions"),
    /Required OpenCode tool is unavailable: voice_sessions/,
  );
});

test("manager tool must survive model and manager permission resolution", async () => {
  const client = {
    tool: {
      async list() {
        return {
          data: [
            {
              id: "voice_sessions",
              description: "sessions",
              parameters: { type: "object", properties: {} },
            },
          ],
        };
      },
    },
    app: {
      async agents() {
        return {
          data: [
            {
              name: "openlive-manager",
              permission: [
                { permission: "*", pattern: "*", action: "deny" },
                {
                  permission: "voice_sessions",
                  pattern: "*",
                  action: "allow",
                },
              ],
            },
          ],
        };
      },
    },
    session: {
      async get() {
        return {
          data: {
            id: "manager",
            directory: "/project",
            permission: [],
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  await assert.doesNotReject(
    gateway.requireManagerTool(
      "voice_sessions",
      { providerID: "Luna", modelID: "gpt" },
      "manager",
      "openlive-manager",
    ),
  );
});

test("persisted manager permissions cannot expose unrelated tools", async () => {
  const client = {
    tool: {
      async list() {
        return {
          data: [
            {
              id: "voice_sessions",
              parameters: { type: "object", properties: {} },
            },
            { id: "bash", parameters: { type: "object", properties: {} } },
          ],
        };
      },
    },
    app: {
      async agents() {
        return {
          data: [
            {
              name: "openlive-manager",
              permission: [
                { permission: "*", pattern: "*", action: "deny" },
                {
                  permission: "voice_sessions",
                  pattern: "*",
                  action: "allow",
                },
              ],
            },
          ],
        };
      },
    },
    session: {
      async get() {
        return {
          data: {
            id: "manager",
            directory: "/project",
            permission: [{ permission: "bash", pattern: "*", action: "allow" }],
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  await assert.rejects(
    gateway.requireManagerTool(
      "voice_sessions",
      { providerID: "Luna", modelID: "gpt" },
      "manager",
      "openlive-manager",
    ),
    /outside the read-only policy: bash/,
  );
});

test("session list reports active statuses and defaults omitted entries to idle", async () => {
  let listParameters: unknown;
  const client = {
    session: {
      async list(parameters: unknown) {
        listParameters = parameters;
        return {
          data: [
            { id: "manager", title: "Manager", time: { updated: 4 } },
            { id: "busy", title: "Busy", time: { updated: 3 } },
            { id: "idle", title: "Idle", time: { updated: 2 } },
            {
              id: "child",
              title: "Child",
              parentID: "busy",
              time: { updated: 1 },
            },
          ],
        };
      },
      async status() {
        return { data: { busy: { type: "busy" } } };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  assert.deepEqual(await gateway.listSessions("manager"), {
    total: 2,
    busy: 1,
    sessions: [
      { id: "busy", title: "Busy", updated: 3, status: "busy" },
      { id: "idle", title: "Idle", updated: 2, status: "idle" },
    ],
  });
  assert.deepEqual(listParameters, {
    roots: true,
    limit: Number.MAX_SAFE_INTEGER,
  });
});

test("new work sessions use the configured primary agent", async () => {
  let createdParameters: unknown;
  let deletedSession: string | undefined;
  const client = {
    config: {
      async get() {
        return { data: { default_agent: "plan" } };
      },
    },
    app: {
      async agents() {
        return {
          data: [
            { name: "openlive-manager", mode: "primary", permission: [] },
            { name: "build", mode: "primary", permission: [] },
            { name: "plan", mode: "primary", permission: [] },
          ],
        };
      },
    },
    session: {
      async create(parameters: { title: string }) {
        createdParameters = parameters;
        return {
          data: {
            id: "new-session",
            title: parameters.title,
            directory: "/project",
          },
        };
      },
      async delete(parameters: { sessionID: string }) {
        deletedSession = parameters.sessionID;
        return { data: true };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  assert.equal(await gateway.defaultWorkAgent(), "plan");
  const settings = {
    agent: "plan",
    model: { providerID: "Luna", modelID: "gpt" },
  };
  assert.equal(
    (await gateway.createSession("  Voice task  ", settings)).id,
    "new-session",
  );
  assert.deepEqual(createdParameters, {
    title: "Voice task",
    agent: "plan",
    model: { providerID: "Luna", id: "gpt", variant: undefined },
  });
  await gateway.deleteSession("new-session");
  assert.equal(deletedSession, "new-session");
});

test("model catalog prefers the model from the latest work session", async () => {
  const client = {
    provider: {
      async list() {
        return {
          data: {
            all: [
              {
                id: "CLI-Proxy",
                name: "CLI Proxy",
                models: {
                  claude: {
                    id: "claude",
                    name: "Claude",
                    capabilities: { toolcall: true },
                  },
                },
              },
              {
                id: "Luna",
                name: "Luna Provider",
                models: {
                  gpt: {
                    id: "gpt",
                    name: "GPT Luna",
                    capabilities: { toolcall: true },
                  },
                  plain: {
                    id: "plain",
                    name: "No Tools",
                    capabilities: { toolcall: false },
                  },
                },
              },
            ],
            connected: ["CLI-Proxy", "Luna"],
            default: { "CLI-Proxy": "claude", Luna: "gpt" },
          },
        };
      },
    },
    config: {
      async get() {
        return { data: { model: "CLI-Proxy/claude" } };
      },
    },
    session: {
      async list() {
        return {
          data: [
            { id: "manager", time: { updated: 3 } },
            { id: "work", time: { updated: 2 } },
          ],
        };
      },
      async messages() {
        return {
          data: [
            {
              info: {
                role: "assistant",
                providerID: "Luna",
                modelID: "gpt",
              },
              parts: [],
            },
          ],
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  assert.deepEqual(await gateway.modelCatalog("manager"), {
    current: { providerID: "Luna", modelID: "gpt" },
    options: [
      {
        id: "CLI-Proxy/claude",
        name: "Claude (CLI Proxy)",
        model: { providerID: "CLI-Proxy", modelID: "claude" },
      },
      {
        id: "Luna/gpt",
        name: "GPT Luna (Luna Provider)",
        model: { providerID: "Luna", modelID: "gpt" },
      },
    ],
  });
});

test("model catalog rejects an implicit fallback without a tool-capable model", async () => {
  const client = {
    provider: {
      async list() {
        return {
          data: {
            all: [
              {
                id: "plain",
                name: "Plain",
                models: {
                  text: {
                    id: "text",
                    name: "Text only",
                    capabilities: { toolcall: false },
                  },
                },
              },
            ],
            connected: ["plain"],
            default: { plain: "text" },
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  await assert.rejects(
    gateway.modelCatalog("manager"),
    /No connected, tool-capable OpenCode model/,
  );
});

test("prompt separates assistant thought and text without user echoes or duplicate snapshots", async () => {
  const userMessageId = "msg_owned";
  const events = [
    {
      type: "session.error",
      properties: { sessionID: "session", error: undefined },
    },
    {
      type: "message.updated",
      properties: {
        info: { id: userMessageId, sessionID: "session", role: "user" },
      },
    },
    {
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "assistant-thought",
          sessionID: "session",
          messageID: "assistant-message",
          type: "reasoning",
          text: "",
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "user-part",
          sessionID: "session",
          messageID: userMessageId,
          type: "text",
          text: "[voice preamble] User question",
        },
        delta: "[voice preamble] User question",
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "session",
        messageID: "assistant-message",
        partID: "assistant-thought",
        field: "text",
        delta: "Considering sessions",
      },
    },
    {
      type: "message.updated",
      properties: {
        info: {
          id: "assistant-message",
          sessionID: "session",
          role: "assistant",
          parentID: userMessageId,
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-part",
          sessionID: "session",
          messageID: "assistant-message",
          type: "tool",
          tool: "voice_sessions",
          state: { status: "running" },
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "assistant-part",
          sessionID: "session",
          messageID: "assistant-message",
          type: "text",
          text: "",
        },
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "session",
        messageID: "assistant-message",
        partID: "assistant-part",
        field: "text",
        delta: "Hello",
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "assistant-part",
          sessionID: "session",
          messageID: "assistant-message",
          type: "text",
          text: "Hello",
        },
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: "session",
        messageID: "assistant-message",
        partID: "assistant-part",
        field: "text",
        delta: " world",
      },
    },
  ] as unknown as Event[];
  let eventsDelivered: (() => void) | undefined;
  const delivered = new Promise<void>((resolve) => {
    eventsDelivered = resolve;
  });
  let streamSignal: AbortSignal | undefined;
  const stream = (async function* () {
    yield { type: "server.connected", properties: {} } as Event;
    for (const event of events) yield event;
    eventsDelivered?.();
    await new Promise<void>((resolve) =>
      streamSignal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  })();
  const client = {
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return { stream };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt() {
        await delivered;
        return {
          data: {
            info: { parentID: userMessageId },
            parts: [
              {
                id: "assistant-part",
                messageID: "assistant-message",
                type: "text",
                text: "Hello world",
              },
            ],
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);
  const output: PromptUpdate[] = [];

  await gateway.prompt(
    "session",
    "User question",
    {
      agent: "openlive-manager",
      model: { providerID: "Luna", modelID: "gpt" },
    },
    userMessageId,
    new AbortController().signal,
    async (update) => {
      output.push(update);
    },
    promptHooks(),
  );

  assert.deepEqual(output, [
    { type: "text", text: "Okay, one moment please." },
    { type: "thought", text: "" },
    {
      type: "thought",
      text: "Considering sessions",
      messageId: "assistant-message",
    },
    { type: "thought", text: "", messageId: "assistant-message" },
    { type: "text", text: "Hello", messageId: "assistant-message" },
    { type: "text", text: " world", messageId: "assistant-message" },
  ]);
});

test("a pending OpenCode prompt emits thought keepalives", async () => {
  const userMessageId = "msg_keepalive";
  let streamSignal: AbortSignal | undefined;
  const client = {
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return {
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          })(),
        };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt() {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          data: {
            info: { parentID: userMessageId },
            parts: [
              {
                id: "final",
                messageID: "assistant",
                type: "text",
                text: "Done",
              },
            ],
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never, 5);
  const output: PromptUpdate[] = [];

  await gateway.prompt(
    "session",
    "User question",
    {
      agent: "openlive-manager",
      model: { providerID: "Luna", modelID: "gpt" },
    },
    userMessageId,
    new AbortController().signal,
    async (update) => {
      output.push(update);
    },
    promptHooks(),
  );

  assert.deepEqual(output[0], {
    type: "text",
    text: "Okay, one moment please.",
  });
  assert.ok(
    output.some((update) => update.type === "thought" && update.text === ""),
  );
  assert.deepEqual(output.at(-1), {
    type: "text",
    text: "Done",
    messageId: "assistant",
  });
});

test("prompt waits for server.connected before submission", async () => {
  let connect: (() => void) | undefined;
  let submitted = false;
  let streamSignal: AbortSignal | undefined;
  const client = {
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return {
          stream: (async function* () {
            await new Promise<void>((resolve) => {
              connect = resolve;
            });
            yield { type: "server.connected", properties: {} };
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          })(),
        };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt() {
        submitted = true;
        return {
          data: {
            info: { parentID: "msg_wait" },
            parts: [],
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(
    runtime,
    client as never,
    1_000,
    1_000,
    100,
  );
  const prompt = gateway.prompt(
    "session",
    "wait",
    {
      agent: "openlive-manager",
      model: { providerID: "Luna", modelID: "gpt" },
    },
    "msg_wait",
    new AbortController().signal,
    async () => undefined,
    promptHooks(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, false);
  connect?.();
  await prompt;
  assert.equal(submitted, true);
});

test("prompt rejects concurrent work in the same session without aborting it", async () => {
  let streamSignal: AbortSignal | undefined;
  let preserved = false;
  const client = {
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return {
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
            yield {
              type: "message.updated",
              properties: {
                info: { id: "msg_foreign", sessionID: "session", role: "user" },
              },
            };
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          })(),
        };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt() {
        await new Promise(() => undefined);
      },
    },
  };
  const gateway = new OpenCodeGateway(
    runtime,
    client as never,
    1_000,
    1_000,
    100,
  );

  await assert.rejects(
    gateway.prompt(
      "session",
      "work",
      {
        agent: "build",
        model: { providerID: "Luna", modelID: "gpt" },
      },
      "msg_owned",
      new AbortController().signal,
      async () => undefined,
      {
        ...promptHooks(),
        preserveBackend() {
          preserved = true;
        },
      },
    ),
    /Another client submitted work/,
  );
  assert.equal(preserved, true);
});

test("prompt correlates reordered v2 interactions before handing off", async () => {
  let streamSignal: AbortSignal | undefined;
  let preserved = false;
  const client = {
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return {
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
            yield {
              type: "permission.v2.asked",
              properties: {
                id: "permission",
                sessionID: "session",
                action: "edit",
                resources: [],
                source: {
                  type: "tool",
                  messageID: "assistant",
                  callID: "call",
                },
              },
            };
            yield {
              type: "message.updated",
              properties: {
                info: {
                  id: "assistant",
                  sessionID: "session",
                  role: "assistant",
                  parentID: "msg_interaction",
                },
              },
            };
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          })(),
        };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt() {
        await new Promise(() => undefined);
      },
    },
  };
  const gateway = new OpenCodeGateway(
    runtime,
    client as never,
    1_000,
    1_000,
    100,
  );

  await assert.rejects(
    gateway.prompt(
      "session",
      "ask",
      {
        agent: "build",
        model: { providerID: "Luna", modelID: "gpt" },
      },
      "msg_interaction",
      new AbortController().signal,
      async () => undefined,
      {
        ...promptHooks(),
        preserveBackend() {
          preserved = true;
        },
      },
    ),
    /Continue this turn in Web UI or TUI/,
  );
  assert.equal(preserved, true);
});

test("prompt stops synthetic keepalives after bounded backend inactivity", async () => {
  let streamSignal: AbortSignal | undefined;
  let preserved = false;
  const client = {
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return {
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          })(),
        };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt() {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never, 2, 10, 100);

  await assert.rejects(
    gateway.prompt(
      "session",
      "wait",
      {
        agent: "build",
        model: { providerID: "Luna", modelID: "gpt" },
      },
      "msg_timeout",
      new AbortController().signal,
      async () => undefined,
      {
        ...promptHooks(),
        preserveBackend() {
          preserved = true;
        },
      },
    ),
    /no substantive progress/,
  );
  assert.equal(preserved, true);
});

test("an owned session-level error is reported as uncertain", async () => {
  let streamSignal: AbortSignal | undefined;
  let preserved = false;
  const client = {
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return {
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
            yield {
              type: "message.updated",
              properties: {
                info: { id: "msg_error", sessionID: "session", role: "user" },
              },
            };
            yield {
              type: "session.error",
              properties: { sessionID: "session", error: undefined },
            };
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          })(),
        };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt() {
        await new Promise(() => undefined);
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  await assert.rejects(
    gateway.prompt(
      "session",
      "fail",
      {
        agent: "build",
        model: { providerID: "Luna", modelID: "gpt" },
      },
      "msg_error",
      new AbortController().signal,
      async () => undefined,
      {
        ...promptHooks(),
        preserveBackend() {
          preserved = true;
        },
      },
    ),
    /cannot be attributed safely/,
  );
  assert.equal(preserved, true);
});

test("abort cancels its HTTP request after a bounded timeout", async () => {
  let requestAborted = false;
  const client = {
    session: {
      async abort(_parameters: unknown, options: { signal: AbortSignal }) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          options.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              requestAborted = true;
              reject(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          );
        });
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  await assert.rejects(gateway.abort("session", 5), /abort timed out/);
  assert.equal(requestAborted, true);
});

test("prompt forwards a JPEG frame only to an image-capable model", async () => {
  let streamSignal: AbortSignal | undefined;
  let submitted: Record<string, unknown> | undefined;
  const client = {
    provider: {
      async list() {
        return {
          data: {
            all: [
              {
                id: "Luna",
                models: {
                  vision: { capabilities: { input: { image: true } } },
                },
              },
            ],
          },
        };
      },
    },
    event: {
      async subscribe(_parameters: unknown, options: { signal: AbortSignal }) {
        streamSignal = options.signal;
        return {
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
            await new Promise<void>((resolve) =>
              streamSignal?.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          })(),
        };
      },
    },
    session: {
      async status() {
        return { data: {} };
      },
      async prompt(parameters: Record<string, unknown>) {
        submitted = parameters;
        return {
          data: {
            info: { parentID: "msg_image" },
            parts: [],
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

  await gateway.prompt(
    "session",
    "Inspect my screen",
    {
      agent: "build",
      model: { providerID: "Luna", modelID: "vision" },
      system: "First-turn greeting",
    },
    "msg_image",
    new AbortController().signal,
    async () => undefined,
    promptHooks(),
    [{ data: frame, mimeType: "image/jpeg" }],
  );

  assert.deepEqual(submitted?.parts, [
    { type: "text", text: "Inspect my screen" },
    {
      type: "file",
      mime: "image/jpeg",
      filename: "openlive-frame-1.jpg",
      url: `data:image/jpeg;base64,${frame}`,
    },
  ]);
  assert.equal(submitted?.system, "First-turn greeting");
});

test("prompt rejects screen frames for a text-only model", async () => {
  const client = {
    provider: {
      async list() {
        return {
          data: {
            all: [
              {
                id: "Luna",
                models: {
                  text: { capabilities: { input: { image: false } } },
                },
              },
            ],
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  await assert.rejects(
    gateway.prompt(
      "session",
      "Inspect my screen",
      {
        agent: "build",
        model: { providerID: "Luna", modelID: "text" },
      },
      "msg_image",
      new AbortController().signal,
      async () => undefined,
      promptHooks(),
      [{ data: "/9j/2Q==", mimeType: "image/jpeg" }],
    ),
    /not configured for image input/,
  );
});

test("prompt settings preserve session agent, model, and variant", async () => {
  const client = {
    session: {
      async get() {
        return {
          data: {
            id: "work",
            directory: "/project",
            agent: "plan",
            model: {
              providerID: "Luna",
              id: "gpt",
              variant: "high",
            },
          },
        };
      },
    },
  };
  const gateway = new OpenCodeGateway(runtime, client as never);

  assert.deepEqual(await gateway.promptSettings("work"), {
    agent: "plan",
    model: { providerID: "Luna", modelID: "gpt" },
    variant: "high",
  });
});

function promptHooks(): PromptHooks {
  return {
    onSubmitted() {},
    onAssistantMessage() {},
    preserveBackend() {},
  };
}
