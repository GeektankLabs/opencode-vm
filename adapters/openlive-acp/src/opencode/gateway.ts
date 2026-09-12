import {
  createOpencodeClient,
  type Event,
  type Message,
  type Part,
  type Session,
} from "@opencode-ai/sdk/v2";
import type {
  ModelCatalog,
  ModelSelection,
  PromptImage,
  PromptSettings,
  PromptUpdate,
  ReplayMessage,
  RuntimeDescriptor,
  SessionListing,
} from "../types.js";

const HISTORY_LIMIT = 12;
const TEXT_LIMIT = 16_000;
const OPENING_ACKNOWLEDGMENT = "Okay, one moment please.";
const PROMPT_KEEPALIVE_MS = 20_000;
const SSE_CONNECT_TIMEOUT_MS = 5_000;
const PROGRESS_TIMEOUT_MS = 10 * 60_000;
type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

export type PromptHooks = {
  onSubmitted(): void;
  onAssistantMessage(messageId: string): void;
  preserveBackend(): void;
};

export class BackendUncertainError extends Error {}
export class InteractionRequiredError extends BackendUncertainError {}
export class ConcurrentSessionError extends BackendUncertainError {}

export class OpenCodeGateway {
  private readonly client: OpenCodeClient;

  constructor(
    private readonly runtime: RuntimeDescriptor,
    client?: OpenCodeClient,
    private readonly promptKeepaliveMs = PROMPT_KEEPALIVE_MS,
    private readonly progressTimeoutMs = PROGRESS_TIMEOUT_MS,
    private readonly connectTimeoutMs = SSE_CONNECT_TIMEOUT_MS,
  ) {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    this.client =
      client ??
      createOpencodeClient({
        baseUrl: runtime.backendUrl,
        directory: runtime.project,
        throwOnError: true,
        ...(password
          ? {
              headers: {
                Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
              },
            }
          : {}),
      });
  }

  async health(): Promise<void> {
    const response = await this.client.global.health();
    if (!response.data?.healthy)
      throw new Error("OpenCode server is unhealthy");
  }

  async requireTool(toolId: string): Promise<void> {
    const response = await this.client.tool.ids();
    if (!(response.data ?? []).includes(toolId)) {
      throw new Error(`Required OpenCode tool is unavailable: ${toolId}`);
    }
    process.stderr.write(`[openlive] tool discovered=${toolId}\n`);
  }

  async requireManagerTool(
    toolId: string,
    model: ModelSelection,
    managerSessionId: string,
    agentName: string,
  ): Promise<void> {
    const [toolResponse, agentResponse, session] = await Promise.all([
      this.client.tool.list({
        provider: model.providerID,
        model: model.modelID,
      }),
      this.client.app.agents(),
      this.getSession(managerSessionId),
    ]);
    const tool = (toolResponse.data ?? []).find((item) => item.id === toolId);
    if (!tool || !isObjectSchema(tool.parameters)) {
      throw new Error(
        `Required OpenCode tool is unavailable for ${model.providerID}/${model.modelID}: ${toolId}`,
      );
    }
    const agent = (agentResponse.data ?? []).find(
      (item) => item.name === agentName,
    );
    if (!agent)
      throw new Error(`Required OpenCode agent is unavailable: ${agentName}`);
    const rules = [...agent.permission, ...(session.permission ?? [])];
    if (permissionAction(rules, toolId) !== "allow") {
      throw new Error(
        `Manager or session permissions do not allow required tool: ${toolId}`,
      );
    }
    const persistedExposure = (session.permission ?? []).find(
      (rule) => rule.permission !== toolId && rule.action !== "deny",
    );
    const exposedTool = (toolResponse.data ?? []).find(
      (item) =>
        item.id !== toolId && permissionAction(rules, item.id) !== "deny",
    );
    if (persistedExposure || exposedTool) {
      throw new Error(
        `Manager permissions expose a tool outside the read-only policy: ${persistedExposure?.permission ?? exposedTool?.id}`,
      );
    }
    process.stderr.write(
      `[openlive] tool ready=${toolId} model=${model.providerID}/${model.modelID} agent=${agentName} sessionRules=${session.permission?.length ?? 0}\n`,
    );
  }

  async listSessions(managerSessionId: string): Promise<SessionListing> {
    const [sessions, statuses] = await Promise.all([
      this.client.session.list({ roots: true, limit: Number.MAX_SAFE_INTEGER }),
      this.client.session.status(),
    ]);
    const available = (sessions.data ?? [])
      .filter((session) => session.id !== managerSessionId && !session.parentID)
      .map((session) => ({
        id: session.id,
        title: session.title.slice(0, 160),
        updated: session.time.updated,
        status: statuses.data?.[session.id]?.type ?? "idle",
      }))
      .sort((left, right) => right.updated - left.updated);
    return {
      total: available.length,
      busy: available.filter((session) => session.status !== "idle").length,
      sessions: available.slice(0, 20),
    };
  }

  async getSession(sessionId: string): Promise<Session> {
    const response = await this.client.session.get({ sessionID: sessionId });
    if (!response.data)
      throw new Error(`OpenCode session not found: ${sessionId}`);
    if (response.data.directory !== this.runtime.project) {
      throw new Error("OpenCode session does not belong to this project");
    }
    return response.data;
  }

  async status(sessionId: string): Promise<string> {
    const response = await this.client.session.status();
    return response.data?.[sessionId]?.type ?? "idle";
  }

  async promptSettings(sessionId: string): Promise<PromptSettings> {
    const session = await this.getSession(sessionId);
    if (session.agent && session.model) {
      return {
        agent: session.agent,
        model: {
          providerID: session.model.providerID,
          modelID: session.model.id,
        },
        variant: normalizedVariant(session.model.variant),
      };
    }
    const response = await this.client.session.messages({
      sessionID: sessionId,
      limit: 12,
    });
    const user = [...(response.data ?? [])]
      .reverse()
      .map((message) => message.info)
      .find((message) => message.role === "user");
    if (!user || user.role !== "user") {
      throw new Error(
        "The target session has no reusable agent and model settings.",
      );
    }
    return {
      agent: user.agent,
      model: user.model,
      variant: normalizedVariant(user.model.variant),
    };
  }

  async readSession(sessionId: string, limit = HISTORY_LIMIT): Promise<string> {
    const messages = await this.textHistory(sessionId, limit);
    return (
      messages
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n\n") || "No text messages are available for this session."
    );
  }

  async replayManager(sessionId: string): Promise<ReplayMessage[]> {
    return this.textHistory(sessionId, HISTORY_LIMIT);
  }

  async ensureManager(
    existingId: string | undefined,
    title: string,
  ): Promise<string> {
    if (existingId) {
      try {
        await this.getSession(existingId);
        return existingId;
      } catch {
        // A deleted manager is recreated below.
      }
    }
    const response = await this.client.session.create({ title });
    if (!response.data)
      throw new Error("OpenCode did not create the manager session");
    return response.data.id;
  }

  async createSession(
    title: string | undefined,
    settings: PromptSettings,
    signal?: AbortSignal,
  ) {
    const response = await this.client.session.create(
      {
        title: title?.trim().slice(0, 80) || "OpenLive Work Session",
        agent: settings.agent,
        model: {
          providerID: settings.model.providerID,
          id: settings.model.modelID,
          variant: settings.variant,
        },
      },
      signal ? { signal } : undefined,
    );
    if (!response.data)
      throw new Error("OpenCode did not create the work session");
    return response.data;
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.client.session.delete(
      { sessionID: sessionId },
      signal ? { signal } : undefined,
    );
    if (!response.data) {
      throw new Error(`OpenCode did not delete work session: ${sessionId}`);
    }
  }

  async defaultWorkAgent(): Promise<string> {
    const [config, agents] = await Promise.all([
      this.client.config.get(),
      this.client.app.agents(),
    ]);
    const available = (agents.data ?? []).filter(
      (agent) =>
        agent.name !== "openlive-manager" &&
        !agent.hidden &&
        (agent.mode === "primary" || agent.mode === "all"),
    );
    const configured = config.data?.default_agent;
    if (configured && available.some((agent) => agent.name === configured)) {
      return configured;
    }
    if (available.some((agent) => agent.name === "build")) return "build";
    if (available[0]) return available[0].name;
    throw new Error("OpenCode has no available primary work agent");
  }

  async modelCatalog(managerSessionId: string): Promise<ModelCatalog> {
    const response = await this.client.provider.list();
    const providers = response.data?.all ?? [];
    const connected = new Set(response.data?.connected ?? []);
    const options = providers
      .filter((provider) => connected.has(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models)
          .filter((model) => model.capabilities.toolcall)
          .map((model) => ({
            id: `${provider.id}/${model.id}`,
            name: `${model.name} (${provider.name})`,
            model: { providerID: provider.id, modelID: model.id },
          })),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    if (options.length === 0) {
      throw new Error(
        "No connected, tool-capable OpenCode model is available for the OpenLive manager.",
      );
    }
    const available = new Map(
      options.map((option) => [option.id, option.model]),
    );

    let current = await this.recentModel(managerSessionId, available);
    if (!current) {
      const config = await this.client.config.get().catch(() => undefined);
      const configured = config?.data?.model;
      if (configured) current = available.get(configured);
    }
    if (!current) {
      for (const provider of providers) {
        if (!connected.has(provider.id)) continue;
        current = available.get(
          `${provider.id}/${response.data?.default[provider.id] ?? ""}`,
        );
        if (current) break;
      }
    }
    current ??= options[0].model;
    return { current, options };
  }

  async prompt(
    sessionId: string,
    text: string,
    settings: PromptSettings,
    messageId: string,
    signal: AbortSignal,
    onUpdate: (update: PromptUpdate) => Promise<void>,
    hooks: PromptHooks,
    images: PromptImage[] = [],
  ): Promise<void> {
    if (signal.aborted) throw abortError();
    if (images.length > 0) {
      await this.requireImageInput(settings.model, signal);
      if (signal.aborted) throw abortError();
    }
    let stopped = false;
    const requestAbort = new AbortController();
    const requestSignal = AbortSignal.any([signal, requestAbort.signal]);
    const emitted = new Map<string, string>();
    const emit = async (update: PromptUpdate) => {
      await onUpdate(update);
    };
    await emit({ type: "text", text: OPENING_ACKNOWLEDGMENT });

    let keepaliveInFlight = false;
    const keepalive = setInterval(() => {
      if (stopped || keepaliveInFlight) return;
      keepaliveInFlight = true;
      process.stderr.write("[openlive] prompt keepalive\n");
      void emit({ type: "thought", text: "" })
        .catch((error: unknown) => {
          process.stderr.write(
            `[openlive] prompt keepalive failed: ${errorMessage(error).slice(0, 500)}\n`,
          );
        })
        .finally(() => {
          keepaliveInFlight = false;
        });
    }, this.promptKeepaliveMs);
    keepalive.unref();

    const progress = new ProgressWatchdog(this.progressTimeoutMs);
    let events: Awaited<ReturnType<OpenCodeClient["event"]["subscribe"]>>;
    let pump: Promise<void> | undefined;
    const ready = deferred<void>();
    const stop = () => {
      stopped = true;
      requestAbort.abort();
      void events?.stream.return?.(undefined);
    };
    signal.addEventListener("abort", stop, { once: true });

    try {
      events = await withTimeout(
        this.client.event.subscribe(undefined, { signal: requestSignal }),
        this.connectTimeoutMs,
        "Timed out connecting to the OpenCode event stream.",
      );
      pump = this.consumeEvents(
        events.stream,
        sessionId,
        messageId,
        () => stopped,
        emit,
        emitted,
        ready,
        progress,
        hooks,
      );
      await withTimeout(
        Promise.race([
          ready.promise,
          pump.then(() => {
            throw new Error(
              "OpenCode event stream closed before it was ready.",
            );
          }),
        ]),
        this.connectTimeoutMs,
        "Timed out waiting for the OpenCode event stream.",
      );

      if ((await this.status(sessionId)) !== "idle") {
        hooks.preserveBackend();
        throw new ConcurrentSessionError(
          "The OpenCode session became busy before the voice prompt was submitted.",
        );
      }
      hooks.onSubmitted();
      const response = await Promise.race([
        this.client.session.prompt(
          {
            sessionID: sessionId,
            messageID: messageId,
            agent: settings.agent,
            model: settings.model,
            variant: settings.variant,
            system: settings.system,
            parts: [
              { type: "text", text },
              ...images.map((image, index) => ({
                type: "file" as const,
                mime: image.mimeType,
                filename: `openlive-frame-${index + 1}.jpg`,
                url: `data:${image.mimeType};base64,${image.data}`,
              })),
            ],
          },
          { signal: requestSignal },
        ),
        pump.then(() => {
          if (stopped) throw abortError();
          hooks.preserveBackend();
          throw new BackendUncertainError(
            "OpenCode event stream disconnected while the prompt may still be running.",
          );
        }),
        progress.failure.catch((error: unknown) => {
          hooks.preserveBackend();
          throw error;
        }),
      ]);
      if (!response.data)
        throw new Error("OpenCode did not return a prompt response");
      if (response.data.info.parentID !== messageId) {
        hooks.preserveBackend();
        throw new BackendUncertainError(
          "OpenCode returned an assistant message for another prompt.",
        );
      }
      if (response.data.info.error) {
        throw new Error(formatOpenCodeError(response.data.info.error));
      }
      for (const part of response.data.parts) {
        if (part.type !== "text" || !part.text) continue;
        const previous = emitted.get(part.id) ?? "";
        if (part.text.startsWith(previous)) {
          const suffix = part.text.slice(previous.length);
          if (suffix) {
            await emit({
              type: "text",
              text: suffix,
              messageId: part.messageID,
            });
            emitted.set(part.id, part.text);
          }
          continue;
        }
        if (!previous.startsWith(part.text)) {
          hooks.preserveBackend();
          throw new BackendUncertainError(
            "OpenCode stream and final response contain conflicting text.",
          );
        }
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error;
    } finally {
      clearInterval(keepalive);
      progress.stop();
      stop();
      signal.removeEventListener("abort", stop);
      await pump?.catch(() => undefined);
    }
  }

  async abort(sessionId: string, timeoutMs = 3_000): Promise<void> {
    const controller = new AbortController();
    try {
      await withTimeout(
        this.client.session.abort(
          { sessionID: sessionId },
          { signal: controller.signal },
        ),
        timeoutMs,
        "OpenCode session abort timed out.",
      );
    } finally {
      controller.abort();
    }
  }

  async isAssistantForPrompt(
    sessionId: string,
    assistantMessageId: string,
    userMessageId: string,
  ): Promise<boolean> {
    try {
      const response = await this.client.session.message({
        sessionID: sessionId,
        messageID: assistantMessageId,
      });
      const info = response.data?.info;
      return info?.role === "assistant" && info.parentID === userMessageId;
    } catch {
      return false;
    }
  }

  private async requireImageInput(
    model: ModelSelection,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.client.provider.list(undefined, { signal });
    const selected = response.data?.all.find(
      (provider) => provider.id === model.providerID,
    )?.models[model.modelID];
    if (!selected?.capabilities.input.image) {
      throw new Error(
        `The selected OpenCode model ${model.providerID}/${model.modelID} is not configured for image input. Select a vision-capable model or refresh the provider with vision enabled.`,
      );
    }
  }

  private async textHistory(
    sessionId: string,
    limit: number,
  ): Promise<ReplayMessage[]> {
    await this.getSession(sessionId);
    const response = await this.client.session.messages({
      sessionID: sessionId,
      limit: Math.min(Math.max(limit, 1), HISTORY_LIMIT),
    });
    let remaining = TEXT_LIMIT;
    const result: ReplayMessage[] = [];
    for (const message of response.data ?? []) {
      if (message.info.role !== "user" && message.info.role !== "assistant")
        continue;
      const full = message.parts
        .filter(
          (part): part is Extract<Part, { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("");
      const text = full.slice(0, remaining);
      if (!text) continue;
      result.push({ id: message.info.id, role: message.info.role, text });
      remaining -= text.length;
      if (remaining === 0) break;
    }
    return result;
  }

  private async recentModel(
    managerSessionId: string,
    available: Map<string, ModelSelection>,
  ): Promise<ModelSelection | undefined> {
    const sessions = await this.client.session.list();
    const candidates = (sessions.data ?? [])
      .filter((session) => session.id !== managerSessionId && !session.parentID)
      .sort((left, right) => right.time.updated - left.time.updated)
      .slice(0, 10);
    for (const session of candidates) {
      try {
        const response = await this.client.session.messages({
          sessionID: session.id,
          limit: 6,
        });
        for (const message of [...(response.data ?? [])].reverse()) {
          const info = message.info;
          const model =
            info.role === "user"
              ? info.model
              : { providerID: info.providerID, modelID: info.modelID };
          const match = available.get(`${model.providerID}/${model.modelID}`);
          if (match) return match;
        }
      } catch {
        // A deleted or concurrently changing session is not a model signal.
      }
    }
    return undefined;
  }

  private async consumeEvents(
    stream: AsyncIterable<Event>,
    sessionId: string,
    userMessageId: string,
    stopped: () => boolean,
    onUpdate: (update: PromptUpdate) => Promise<void>,
    emitted: Map<string, string>,
    ready: Deferred<void>,
    progress: ProgressWatchdog,
    hooks: PromptHooks,
  ): Promise<void> {
    const ownedMessages = new Set<string>();
    const partMessages = new Map<string, string>();
    const partTypes = new Map<string, PromptUpdate["type"]>();
    const partText = new Map<string, string>();
    const pendingInteractions = new Set<string>();
    let ownedPromptObserved = false;
    const trace = (message: string) =>
      process.stderr.write(`[openlive] stream ${message}\n`);
    const flush = async (partId: string) => {
      const messageId = partMessages.get(partId);
      const type = partTypes.get(partId);
      if (!messageId || !type || !ownedMessages.has(messageId)) return;
      const text = partText.get(partId) ?? "";
      const previous = emitted.get(partId) ?? "";
      if (text.startsWith(previous)) {
        const delta = text.slice(previous.length);
        if (!delta) return;
        emitted.set(partId, text);
        progress.touch();
        await onUpdate({ type, text: delta, messageId });
        return;
      }
      if (!previous.startsWith(text)) {
        hooks.preserveBackend();
        throw new BackendUncertainError(
          "OpenCode emitted conflicting updates for one message part.",
        );
      }
    };

    for await (const event of stream) {
      if (stopped()) return;
      if (event.type === "server.connected") {
        ready.resolve();
        continue;
      }
      if (event.type === "session.error") {
        if (event.properties.sessionID !== sessionId) continue;
        if (!ownedPromptObserved) continue;
        hooks.preserveBackend();
        throw new BackendUncertainError(
          `OpenCode reported a session-level error that cannot be attributed safely (${formatOpenCodeError(event.properties.error)}). Inspect the session in Web UI before retrying.`,
        );
      }
      if (
        event.type === "permission.asked" ||
        event.type === "permission.v2.asked" ||
        event.type === "question.asked" ||
        event.type === "question.v2.asked"
      ) {
        if (event.properties.sessionID !== sessionId) continue;
        const toolMessageId = interactionMessageId(event);
        if (toolMessageId && !ownedMessages.has(toolMessageId)) {
          pendingInteractions.add(toolMessageId);
          continue;
        }
        hooks.preserveBackend();
        throw new InteractionRequiredError(
          "OpenCode is waiting for input. Continue this turn in Web UI or TUI.",
        );
      }
      if (event.type === "session.status") {
        if (
          event.properties.sessionID === sessionId &&
          event.properties.status.type !== "idle"
        ) {
          trace(`status=${event.properties.status.type}`);
          await onUpdate({ type: "thought", text: "" });
        }
        continue;
      }
      if (event.type === "message.updated") {
        const { info } = event.properties;
        if (info.sessionID !== sessionId) continue;
        if (info.role === "user") {
          if (info.id !== userMessageId) {
            hooks.preserveBackend();
            throw new ConcurrentSessionError(
              "Another client submitted work to this OpenCode session.",
            );
          }
          ownedPromptObserved = true;
          continue;
        }
        if (info.parentID !== userMessageId) continue;
        if (!ownedMessages.has(info.id)) {
          ownedMessages.add(info.id);
          hooks.onAssistantMessage(info.id);
          ownedPromptObserved = true;
          progress.touch();
          trace("assistant-message");
        }
        if (pendingInteractions.has(info.id)) {
          hooks.preserveBackend();
          throw new InteractionRequiredError(
            "OpenCode is waiting for input. Continue this turn in Web UI or TUI.",
          );
        }
        if (info.error) throw new Error(formatOpenCodeError(info.error));
        for (const [partId, messageId] of partMessages) {
          if (messageId === info.id) await flush(partId);
        }
        continue;
      }
      if (event.type === "message.part.delta") {
        const { sessionID, messageID, partID, field, delta } = event.properties;
        if (sessionID !== sessionId || field !== "text" || !delta) continue;
        partMessages.set(partID, messageID);
        partText.set(partID, (partText.get(partID) ?? "") + delta);
        await flush(partID);
        continue;
      }
      if (event.type !== "message.part.updated") continue;
      const { part } = event.properties;
      if (part.sessionID !== sessionId) continue;
      if (part.type === "tool") {
        if (!ownedMessages.has(part.messageID)) continue;
        trace(`tool=${part.tool} status=${part.state.status}`);
        progress.touch();
        await onUpdate({
          type: "thought",
          text: "",
          messageId: part.messageID,
        });
        continue;
      }
      if (part.type !== "text" && part.type !== "reasoning") continue;
      partMessages.set(part.id, part.messageID);
      partTypes.set(part.id, part.type === "reasoning" ? "thought" : "text");
      partText.set(part.id, part.text);
      await flush(part.id);
    }
    if (!stopped()) throw new Error("OpenCode event stream disconnected.");
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ProgressWatchdog {
  readonly failure: Promise<never>;
  private timer?: NodeJS.Timeout;
  private reject!: (error: Error) => void;

  constructor(private readonly timeoutMs: number) {
    this.failure = new Promise<never>((_resolve, reject) => {
      this.reject = reject;
    });
    void this.failure.catch(() => undefined);
    this.touch();
  }

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.reject(
        new BackendUncertainError(
          "OpenCode made no substantive progress for too long. Inspect the session in Web UI before retrying.",
        ),
      );
    }, this.timeoutMs);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

function normalizedVariant(value: string | undefined): string | undefined {
  return value && value !== "default" ? value : undefined;
}

function isObjectSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "object"
  );
}

function permissionAction(
  rules: Array<{ permission: string; action: string }>,
  permission: string,
): string {
  return (
    [...rules]
      .reverse()
      .find((rule) => wildcardMatch(permission, rule.permission))?.action ??
    "ask"
  );
}

function wildcardMatch(value: string, pattern: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

function interactionMessageId(
  event: Extract<
    Event,
    {
      type:
        | "permission.asked"
        | "permission.v2.asked"
        | "question.asked"
        | "question.v2.asked";
    }
  >,
): string | undefined {
  if (event.type === "permission.v2.asked") {
    return event.properties.source?.messageID;
  }
  return event.properties.tool?.messageID;
}

function abortError(): DOMException {
  return new DOMException("The OpenLive prompt was cancelled.", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatOpenCodeError(error: unknown): string {
  if (!error || typeof error !== "object") return "OpenCode session failed.";
  const value = error as { name?: unknown; data?: { message?: unknown } };
  const name = typeof value.name === "string" ? value.name : "OpenCodeError";
  const message =
    typeof value.data?.message === "string"
      ? value.data.message
      : "Session failed";
  return `${name}: ${message}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
