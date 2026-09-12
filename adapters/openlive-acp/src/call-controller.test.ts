import assert from "node:assert/strict";
import test from "node:test";
import { CallController } from "./core/call-controller.js";
import { SessionInspector } from "./core/session-inspector.js";
import type { OpenCodeGateway } from "./opencode/gateway.js";
import type { PromptUpdate } from "./types.js";

test("attachment is committed after the manager turn and reset for a new call", async () => {
  let releasePrompt: (() => void) | undefined;
  const prompted: string[] = [];
  const gateway = {
    async getSession(id: string) {
      return { id, directory: "/project" };
    },
    async status() {
      return "idle";
    },
    async listSessions() {
      return [];
    },
    async readSession() {
      return "";
    },
    async promptSettings() {
      return {
        agent: "build",
        model: { providerID: "Luna", modelID: "work" },
        variant: "high",
      };
    },
    async prompt(
      sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      onUpdate: (update: PromptUpdate) => Promise<void>,
      hooks: {
        onSubmitted(): void;
        onAssistantMessage(messageId: string): void;
      },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("assistant");
      prompted.push(sessionId);
      await onUpdate({ type: "text", text: "response" });
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    },
    async abort() {},
  } as unknown as OpenCodeGateway;
  const inspector = new SessionInspector(gateway, "manager");
  const controller = new CallController(gateway, inspector, "manager", "hash", {
    current: { providerID: "Luna", modelID: "gpt" },
    options: [],
  });
  const call = controller.newCall();

  const managerTurn = controller.prompt(
    call,
    "attach me",
    async () => undefined,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await controller.control({
    callerSessionId: "manager",
    callerMessageId: "assistant",
    action: "attach",
    sessionId: "work",
  });
  releasePrompt?.();
  assert.equal(await managerTurn, "end_turn");

  const workTurn = controller.prompt(call, "continue", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  releasePrompt?.();
  await workTurn;
  assert.deepEqual(prompted, ["manager", "work"]);

  await controller.close(call);
  const nextCall = controller.newCall();
  const nextManagerTurn = controller.prompt(
    nextCall,
    "start",
    async () => undefined,
  );
  await new Promise((resolve) => setImmediate(resolve));
  releasePrompt?.();
  await nextManagerTurn;
  assert.deepEqual(prompted, ["manager", "work", "manager"]);
});

test("selected ACP model is passed explicitly to OpenCode prompts", async () => {
  const prompted: unknown[] = [];
  const gateway = {
    async status() {
      return "idle";
    },
    async prompt(
      _sessionId: string,
      _text: string,
      settings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: { onSubmitted(): void },
    ) {
      hooks.onSubmitted();
      prompted.push(settings);
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    {} as SessionInspector,
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [
        {
          id: "Luna/gpt",
          name: "GPT Luna",
          model: { providerID: "Luna", modelID: "gpt" },
        },
        {
          id: "Other/fast",
          name: "Fast",
          model: { providerID: "Other", modelID: "fast" },
        },
      ],
    },
  );
  const call = controller.newCall();

  assert.equal(controller.modelState(call)?.current, "Luna/gpt");
  controller.setModel(call, "Other/fast");
  await controller.prompt(call, "hello", async () => undefined);

  await controller.prompt(call, "again", async () => undefined);

  const [first, second] = prompted as Array<{
    agent: string;
    model: unknown;
    system?: string;
  }>;
  assert.equal(first?.agent, "openlive-manager");
  assert.deepEqual(first?.model, { providerID: "Other", modelID: "fast" });
  assert.match(first?.system ?? "", /first user turn.*action list/i);
  assert.equal(second?.system, undefined);
});

test("an attached work session keeps its own model selection", async () => {
  let releasePrompt: (() => void) | undefined;
  const prompted: unknown[] = [];
  const gateway = {
    async getSession(id: string) {
      return { id, directory: "/project" };
    },
    async status() {
      return "idle";
    },
    async promptSettings() {
      return {
        agent: "build",
        model: { providerID: "Work", modelID: "code" },
        variant: "high",
      };
    },
    async prompt(
      _sessionId: string,
      _text: string,
      settings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: {
        onSubmitted(): void;
        onAssistantMessage(messageId: string): void;
      },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("assistant");
      prompted.push(settings);
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    new SessionInspector(gateway, "manager"),
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [
        {
          id: "Luna/gpt",
          name: "GPT Luna",
          model: { providerID: "Luna", modelID: "gpt" },
        },
      ],
    },
  );
  const call = controller.newCall();
  const manager = controller.prompt(call, "attach", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.control({
    callerSessionId: "manager",
    callerMessageId: "assistant",
    action: "attach",
    sessionId: "work",
  });
  releasePrompt?.();
  await manager;

  const attached = controller.prompt(call, "continue", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  releasePrompt?.();
  await attached;

  const [managerSettings, workSettings] = prompted as Array<{
    agent: string;
    model: unknown;
    variant?: string;
    system?: string;
  }>;
  assert.equal(managerSettings?.agent, "openlive-manager");
  assert.deepEqual(managerSettings?.model, {
    providerID: "Luna",
    modelID: "gpt",
  });
  assert.match(managerSettings?.system ?? "", /first user turn/i);
  assert.deepEqual(workSettings, {
    agent: "build",
    model: { providerID: "Work", modelID: "code" },
    variant: "high",
  });
});

test("creating a work session attaches after confirmation with safe defaults", async () => {
  let releaseManager: (() => void) | undefined;
  const sessions: string[] = [];
  const settings: unknown[] = [];
  const createdSettings: unknown[] = [];
  const deleted: string[] = [];
  const gateway = {
    async getSession(id: string) {
      return { id, directory: "/project" };
    },
    async status() {
      return "idle";
    },
    async defaultWorkAgent() {
      return "plan";
    },
    async createSession(title: string | undefined, promptSettings: unknown) {
      createdSettings.push(promptSettings);
      return { id: "new-work", title, directory: "/project" };
    },
    async deleteSession(sessionId: string) {
      deleted.push(sessionId);
    },
    async promptSettings() {
      return {
        agent: "build",
        model: { providerID: "Work", modelID: "persisted" },
      };
    },
    async prompt(
      sessionId: string,
      _text: string,
      promptSettings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: {
        onSubmitted(): void;
        onAssistantMessage(messageId: string): void;
      },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("assistant");
      sessions.push(sessionId);
      settings.push(promptSettings);
      if (sessions.length === 1) {
        await new Promise<void>((resolve) => {
          releaseManager = resolve;
        });
      }
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    new SessionInspector(gateway, "manager"),
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();
  const manager = controller.prompt(call, "create one", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(
    await controller.control({
      callerSessionId: "manager",
      callerMessageId: "assistant",
      action: "create",
      title: "Voice task",
    }),
    /Created work session new-work/,
  );
  releaseManager?.();
  await manager;
  await controller.prompt(call, "first task", async () => undefined);
  await controller.prompt(call, "follow-up", async () => undefined);

  assert.deepEqual(sessions, ["manager", "new-work", "new-work"]);
  assert.deepEqual(createdSettings, [
    {
      agent: "plan",
      model: { providerID: "Luna", modelID: "gpt" },
    },
  ]);
  assert.deepEqual(deleted, []);
  assert.deepEqual(settings[1], {
    agent: "plan",
    model: { providerID: "Luna", modelID: "gpt" },
  });
  assert.deepEqual(settings[2], {
    agent: "build",
    model: { providerID: "Work", modelID: "persisted" },
  });
});

test("cancel aborts only a submitted active turn and settles it as cancelled", async () => {
  let aborts = 0;
  const gateway = {
    async status() {
      return "idle";
    },
    async prompt(
      _sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      signal: AbortSignal,
      _onUpdate: unknown,
      hooks: { onSubmitted(): void },
    ) {
      hooks.onSubmitted();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      );
    },
    async abort() {
      aborts++;
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    {} as SessionInspector,
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();

  await controller.cancel(call);
  assert.equal(aborts, 0);
  const prompt = controller.prompt(call, "hello", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.cancel(call);

  assert.equal(await prompt, "cancelled");
  assert.equal(aborts, 1);
});

test("a new turn waits until the previous session-wide abort settles", async () => {
  let releaseAbort: (() => void) | undefined;
  const gateway = {
    async status() {
      return "idle";
    },
    async prompt(
      _sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      signal: AbortSignal,
      _onUpdate: unknown,
      hooks: { onSubmitted(): void },
    ) {
      hooks.onSubmitted();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      );
    },
    async abort() {
      await new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    {} as SessionInspector,
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();
  const first = controller.prompt(call, "first", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const cancelling = controller.cancel(call);

  assert.equal(await first, "cancelled");
  await assert.rejects(
    controller.prompt(call, "too soon", async () => undefined),
    /already running/,
  );
  releaseAbort?.();
  await cancelling;
});

test("an attach is discarded when its control request expires", async () => {
  let releasePrompt: (() => void) | undefined;
  let releaseInspection: (() => void) | undefined;
  const prompted: string[] = [];
  const gateway = {
    async status() {
      return "idle";
    },
    async prompt(
      sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: { onSubmitted(): void; onAssistantMessage(id: string): void },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("assistant");
      prompted.push(sessionId);
      if (prompted.length === 1) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
    },
  } as unknown as OpenCodeGateway;
  const inspector = {
    async requireAttachable() {
      await new Promise<void>((resolve) => {
        releaseInspection = resolve;
      });
    },
  } as unknown as SessionInspector;
  const controller = new CallController(gateway, inspector, "manager", "hash", {
    current: { providerID: "Luna", modelID: "gpt" },
    options: [],
  });
  const call = controller.newCall();
  const manager = controller.prompt(call, "attach", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const attach = controller.control({
    callerSessionId: "manager",
    callerMessageId: "assistant",
    action: "attach",
    sessionId: "work",
    expiresAt: Date.now() - 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseInspection?.();

  await assert.rejects(attach, /control request expired or changed/);
  releasePrompt?.();
  await manager;
  await controller.prompt(call, "still manager", async () => undefined);
  assert.deepEqual(prompted, ["manager", "manager"]);
});

test("failed manager turns discard a pending attachment", async () => {
  let attempts = 0;
  let failPrompt: (() => void) | undefined;
  const sessions: string[] = [];
  const settings: unknown[] = [];
  const gateway = {
    async getSession(id: string) {
      return { id, directory: "/project" };
    },
    async status() {
      return "idle";
    },
    async promptSettings() {
      return {
        agent: "build",
        model: { providerID: "Work", modelID: "code" },
      };
    },
    async prompt(
      sessionId: string,
      _text: string,
      promptSettings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: {
        onSubmitted(): void;
        onAssistantMessage(messageId: string): void;
      },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("assistant");
      sessions.push(sessionId);
      settings.push(promptSettings);
      attempts++;
      if (attempts === 1) {
        await new Promise<void>((resolve) => {
          failPrompt = resolve;
        });
        throw new Error("provider failed");
      }
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    new SessionInspector(gateway, "manager"),
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();
  const first = controller.prompt(call, "attach", async () => undefined);
  const failed = assert.rejects(first, /provider failed/);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.control({
    callerSessionId: "manager",
    callerMessageId: "assistant",
    action: "attach",
    sessionId: "work",
  });
  failPrompt?.();
  await failed;

  await controller.prompt(call, "still manager", async () => undefined);
  assert.deepEqual(sessions, ["manager", "manager"]);
  assert.match(
    (settings[0] as { system?: string }).system ?? "",
    /first user turn/i,
  );
  assert.match(
    (settings[1] as { system?: string }).system ?? "",
    /first user turn/i,
  );
});

test("failed manager turns remove an unconfirmed created session", async () => {
  let failPrompt: (() => void) | undefined;
  const deleted: string[] = [];
  const gateway = {
    async status() {
      return "idle";
    },
    async defaultWorkAgent() {
      return "build";
    },
    async createSession() {
      return { id: "new-work", title: "Voice task", directory: "/project" };
    },
    async deleteSession(sessionId: string) {
      deleted.push(sessionId);
    },
    async prompt(
      _sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: {
        onSubmitted(): void;
        onAssistantMessage(messageId: string): void;
      },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("assistant");
      await new Promise<void>((resolve) => {
        failPrompt = resolve;
      });
      throw new Error("provider failed");
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    new SessionInspector(gateway, "manager"),
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();
  const prompt = controller.prompt(call, "create", async () => undefined);
  const failed = assert.rejects(prompt, /provider failed/);
  await new Promise((resolve) => setImmediate(resolve));

  await controller.control({
    callerSessionId: "manager",
    callerMessageId: "assistant",
    action: "create",
    title: "Voice task",
  });
  failPrompt?.();
  await failed;

  assert.deepEqual(deleted, ["new-work"]);
});

test("loading a known call resets its attachment to the manager", async () => {
  let release: (() => void) | undefined;
  const sessions: string[] = [];
  const gateway = {
    async getSession(id: string) {
      return { id, directory: "/project" };
    },
    async status() {
      return "idle";
    },
    async promptSettings() {
      return {
        agent: "build",
        model: { providerID: "Work", modelID: "code" },
      };
    },
    async prompt(
      sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: {
        onSubmitted(): void;
        onAssistantMessage(messageId: string): void;
      },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("assistant");
      sessions.push(sessionId);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    new SessionInspector(gateway, "manager"),
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();
  const manager = controller.prompt(call, "attach", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.control({
    callerSessionId: "manager",
    callerMessageId: "assistant",
    action: "attach",
    sessionId: "work",
  });
  release?.();
  await manager;

  controller.loadCall(call);
  const loaded = controller.prompt(call, "resume", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  await loaded;
  assert.deepEqual(sessions, ["manager", "manager"]);
});

test("control rejects a manager message outside the active voice turn", async () => {
  let release: (() => void) | undefined;
  const gateway = {
    async status() {
      return "idle";
    },
    async prompt(
      _sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      _signal: AbortSignal,
      _onUpdate: unknown,
      hooks: { onSubmitted(): void; onAssistantMessage(id: string): void },
    ) {
      hooks.onSubmitted();
      hooks.onAssistantMessage("owned");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async isAssistantForPrompt() {
      return false;
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    {} as SessionInspector,
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();
  const prompt = controller.prompt(call, "hello", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    controller.control({
      callerSessionId: "manager",
      callerMessageId: "foreign",
      action: "list",
    }),
    /does not belong to the active OpenLive turn/,
  );
  release?.();
  await prompt;
});

test("cancel preserves a backend whose ownership became uncertain", async () => {
  let aborts = 0;
  const gateway = {
    async status() {
      return "idle";
    },
    async prompt(
      _sessionId: string,
      _text: string,
      _settings: unknown,
      _messageId: string,
      signal: AbortSignal,
      _onUpdate: unknown,
      hooks: { onSubmitted(): void; preserveBackend(): void },
    ) {
      hooks.onSubmitted();
      hooks.preserveBackend();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      );
    },
    async abort() {
      aborts++;
    },
  } as unknown as OpenCodeGateway;
  const controller = new CallController(
    gateway,
    {} as SessionInspector,
    "manager",
    "hash",
    {
      current: { providerID: "Luna", modelID: "gpt" },
      options: [],
    },
  );
  const call = controller.newCall();
  const prompt = controller.prompt(call, "hello", async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.cancel(call);

  assert.equal(await prompt, "cancelled");
  assert.equal(aborts, 0);
});
