import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { ActivityJournal } from "./activity.js";
import type {
  Message,
  Part,
  PermissionV2Request,
  QuestionV2Request,
  SessionV2Info,
} from "@opencode-ai/sdk/v2";
import { AdapterError, MAX_HISTORY_TEXT, isRecord } from "./types.js";
import type {
  ActivityQuery,
  ActivityResult,
  ActivitySnapshot,
  RuntimeOptions,
  RuntimePatch,
  RuntimeUpdateResult,
  SessionRuntime,
  CreateSessionResult,
  HistoryMessage,
  ListSessionsResult,
  PendingInput,
  ProjectIdentity,
  RuntimeDescriptor,
  SendMessageResult,
  SessionActivity,
  SessionDetailsResult,
  SessionHistoryResult,
  SessionStatusResult,
  SessionSummary,
} from "./types.js";

const BACKEND_DEADLINE_MS = 8_000;
const ADMISSION_DEADLINE_MS = 15_000;
const BACKEND_PAGE_SIZE = 20;
const MAX_SESSION_PAGES = 10;
const STATUS_HISTORY_LIMIT = 100;
const OPENLIVE_MANAGER_AGENT = "openlive-manager";

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;
type MessageWithParts = { info: Message; parts: Part[] };
type MessagePage = { items: MessageWithParts[]; next?: string };

type PendingDetails = PendingInput & {
  permissionsList: PermissionV2Request[];
  questionsList: QuestionV2Request[];
};

type SessionCursor = {
  v: 1;
  backend: string | null;
  offset: number;
};

export interface SessionGateway {
  getSessionRuntimeOptions(sessionId?: string): Promise<RuntimeOptions>;
  updateSessionRuntime(
    sessionId: string,
    patch: RuntimePatch,
  ): Promise<RuntimeUpdateResult>;
  getProjectActivity(query?: ActivityQuery): Promise<ActivityResult>;
  waitForProjectActivity(
    query: ActivityQuery & { after_cursor: string; timeout_ms?: number },
  ): Promise<ActivityResult & { timeout: boolean }>;
  createSession(title?: string): Promise<CreateSessionResult>;
  listSessions(limit?: number, cursor?: string): Promise<ListSessionsResult>;
  getSessionDetails(sessionId: string): Promise<SessionDetailsResult>;
  getSessionStatus(
    sessionId: string,
    messageId?: string,
  ): Promise<SessionStatusResult>;
  getSessionHistory(
    sessionId: string,
    limit?: number,
    before?: string,
  ): Promise<SessionHistoryResult>;
  sendMessage(sessionId: string, message: string): Promise<SendMessageResult>;
}

export class OpenCodeGateway implements SessionGateway {
  private readonly client: OpenCodeClient;
  private projectId: string | undefined;
  private compatibilityPromise: Promise<void> | undefined;
  private readonly submissionLocks = new Set<string>();
  private readonly unresolved = new Map<string, string>();
  private journal?: ActivityJournal;
  private readonly collectorStop = new AbortController();
  private collector?: Promise<void>;
  private sweeper?: Promise<void>;
  private readonly collecting = new Map<string, symbol>();
  private tracking: ActivityResult["tracking"] = {
    connected: false,
    partial: true,
  };

  constructor(
    private readonly runtime: RuntimeDescriptor,
    client?: OpenCodeClient,
    private readonly backendDeadlineMs = BACKEND_DEADLINE_MS,
    private readonly admissionDeadlineMs = ADMISSION_DEADLINE_MS,
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

  compatibilityCheck(): Promise<void> {
    this.compatibilityPromise ??= this.checkCompatibility();
    return this.compatibilityPromise;
  }

  async enableActivity(path: string): Promise<void> {
    this.journal = await ActivityJournal.open(path, this.runtime.projectHash);
  }

  startActivityCollection(): void {
    if (!this.journal || this.collector) return;
    this.collector = this.collectEvents();
    this.sweeper = this.sweepActivity();
  }

  async close(): Promise<void> {
    this.collectorStop.abort();
    await Promise.allSettled(
      [this.collector, this.sweeper].filter((value) => value !== undefined),
    );
    await this.journal?.close();
  }

  async getSessionRuntimeOptions(sessionId?: string): Promise<RuntimeOptions> {
    await this.compatibilityCheck();
    const session = sessionId
      ? await this.requireExposedSession(sessionId)
      : undefined;
    const options = await this.runtimeOptions();
    return {
      ...options,
      models: options.models.slice(0, 2000),
      truncated: options.models.length > 2000,
      ...(session ? { current: await this.sessionRuntime(session) } : {}),
    };
  }

  async updateSessionRuntime(
    sessionId: string,
    patch: RuntimePatch,
  ): Promise<RuntimeUpdateResult> {
    if (
      !Object.keys(patch).length ||
      Object.values(patch).some(
        (value) =>
          typeof value !== "string" ||
          !value ||
          value.length > 256 ||
          /[\s\x00-\x1f\x7f]/u.test(value),
      )
    ) {
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "Supply at least one nonempty runtime setting.",
      );
    }
    if (this.submissionLocks.has(sessionId))
      throw new AdapterError(
        "SESSION_BUSY",
        "The session has an MCP write in progress.",
      );
    this.submissionLocks.add(sessionId);
    this.collecting.delete(sessionId);
    try {
      const session = await this.requireExposedSession(sessionId);
      await this.requireIdle(sessionId);
      let previous: SessionRuntime;
      try {
        previous = await this.sessionRuntime(session);
      } catch (error) {
        if (
          error instanceof AdapterError &&
          error.code === "BACKEND_INCOMPATIBLE"
        )
          throw new AdapterError(
            "UNSUPPORTED_CONFIGURATION",
            "Session has no reusable runtime settings; initialize it in Web UI/TUI or use create_session.",
          );
        throw error;
      }
      const current = { ...previous, ...patch };
      this.validateRuntime(current, await this.runtimeOptions());
      // Seed the previous runtime in the journal before switching; collector
      // snapshots skip MCP-local writes to avoid publishing intermediate settings.
      if (this.journal)
        await this.journal.observe(
          await this.activitySnapshot(sessionId),
          "mcp",
        );
      await this.requireIdle(sessionId);
      let writing = false;
      try {
        if (current.agent !== previous.agent) {
          writing = true;
          await this.client.v2.session.switchAgent(
            { sessionID: sessionId, agent: current.agent },
            { signal: this.deadline() },
          );
        }
        if (JSON.stringify(current) !== JSON.stringify(previous)) {
          await this.requireIdle(sessionId);
          writing = true;
          await this.client.v2.session.switchModel(
            {
              sessionID: sessionId,
              model: {
                providerID: current.provider_id,
                id: current.model_id,
                variant: current.variant,
              },
            },
            { signal: this.deadline() },
          );
        }
        const verified = await this.sessionRuntime(
          await this.requireExposedSession(sessionId),
        );
        if (JSON.stringify(verified) !== JSON.stringify(current))
          throw new Error("Runtime verification failed");
        if (this.journal)
          await this.journal.observe(
            await this.activitySnapshot(sessionId),
            "mcp",
          );
        return {
          session_id: sessionId,
          previous,
          current: verified,
          state: "updated",
        };
      } catch (error) {
        if (!writing && error instanceof AdapterError) throw error;
        throw new AdapterError(
          "RUNTIME_UPDATE_FAILED",
          "Runtime update could not be verified and may be partial. Inspect get_session before proceeding; do not retry automatically.",
        );
      }
    } finally {
      this.submissionLocks.delete(sessionId);
    }
  }

  async getProjectActivity(query: ActivityQuery = {}): Promise<ActivityResult> {
    const journal = this.requireJournal();
    const limit = integerInRange(query.limit ?? 50, 1, 100, "limit");
    const result = await journal.read({ ...query, limit }, async (id) => {
      try {
        await this.requireExposedSession(id);
        return true;
      } catch (error) {
        if (error instanceof AdapterError && error.code === "SESSION_NOT_FOUND")
          return false;
        throw error;
      }
    });
    return { ...result, tracking: { ...this.tracking } };
  }

  async waitForProjectActivity(
    query: ActivityQuery & { after_cursor: string; timeout_ms?: number },
  ): Promise<ActivityResult & { timeout: boolean }> {
    const end =
      Date.now() +
      integerInRange(query.timeout_ms ?? 10000, 1, 15000, "timeout_ms");
    let result = await this.getProjectActivity(query);
    while (
      !result.events.length &&
      Date.now() < end &&
      !this.collectorStop.signal.aborted
    ) {
      await this.requireJournal().wait(
        result.next_cursor,
        Math.max(1, end - Date.now()),
      );
      result = await this.getProjectActivity({
        ...query,
        after_cursor: result.next_cursor,
      });
    }
    return { ...result, timeout: result.events.length === 0 };
  }

  async createSession(title?: string): Promise<CreateSessionResult> {
    const name = title === undefined ? "MCP Work Session" : title.trim();
    if (!name || name.length > 160 || /[\x00-\x1f\x7f]/u.test(name)) {
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "title must contain 1 to 160 characters without control characters.",
      );
    }
    await this.compatibilityCheck();
    await this.managerSessionId();
    const settings = await this.newSessionSettings();
    // Everything after this point may have created a session. Never retry or
    // roll back an uncertain write: another client may already be using it.
    try {
      const response = await this.client.session.create(
        { directory: this.runtime.project, title: name, ...settings },
        { signal: this.deadline() },
      );
      const id = response.data?.id;
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 256 ||
        /[\s\x00-\x1f\x7f]/u.test(id)
      ) {
        throw new Error("Invalid creation response.");
      }
      const session = await this.requireExposedSession(id);
      if (
        session.id !== id ||
        session.agent !== settings.agent ||
        session.model?.providerID !== settings.model.providerID ||
        session.model?.id !== settings.model.id ||
        (settings.model.variant !== undefined &&
          session.model?.variant !== settings.model.variant)
      ) {
        throw new Error("Session settings were not persisted.");
      }
      return {
        project: this.projectIdentity(),
        session_id: session.id,
        title: session.title.slice(0, 160),
        agent: settings.agent,
        provider_id: settings.model.providerID,
        model_id: settings.model.id,
        ...(session.model?.variant ? { variant: session.model.variant } : {}),
        state: "created",
      };
    } catch {
      throw new AdapterError(
        "CREATION_UNCERTAIN",
        "Session creation could not be confirmed. Inspect list_sessions or OpenCode Web UI before trying again; do not retry automatically.",
      );
    }
  }

  async listSessions(limit = 10, cursor?: string): Promise<ListSessionsResult> {
    await this.compatibilityCheck();
    const boundedLimit = integerInRange(limit, 1, 20, "limit");
    const initial = decodeCursor(cursor);
    const managerId = await this.managerSessionId();
    const statuses = await this.activities();
    const sessions: SessionSummary[] = [];
    let backendCursor = initial.backend;
    let offset = initial.offset;
    let nextCursor: string | undefined;
    let pages = 0;
    const seen = new Set<string>();

    while (pages < MAX_SESSION_PAGES) {
      const pageCursor = backendCursor;
      const response = await this.backendCall(
        () =>
          this.client.v2.session.list(
            {
              directory: this.runtime.project,
              project: this.requiredProjectId(),
              limit: BACKEND_PAGE_SIZE,
              order: "desc",
              ...(pageCursor ? { cursor: pageCursor } : {}),
            },
            { signal: this.deadline() },
          ),
        "Could not list OpenCode sessions.",
      );
      const payload = response.data;
      if (
        !payload ||
        !Array.isArray(payload.data) ||
        !isRecord(payload.cursor)
      ) {
        throw incompatible(
          "OpenCode returned an unsupported session-list response.",
        );
      }
      pages += 1;
      let index = offset;
      for (; index < payload.data.length; index += 1) {
        const session = payload.data[index];
        if (!session || !(await this.isExposedSession(session, managerId)))
          continue;
        sessions.push(toSummary(session, statuses.get(session.id) ?? "idle"));
        if (sessions.length === boundedLimit) {
          const followingOffset = index + 1;
          if (followingOffset < payload.data.length) {
            nextCursor = encodeCursor({
              v: 1,
              backend: pageCursor,
              offset: followingOffset,
            });
          } else if (payload.cursor.next) {
            nextCursor = encodeCursor({
              v: 1,
              backend: payload.cursor.next,
              offset: 0,
            });
          }
          return {
            project: this.projectIdentity(),
            sessions,
            ...(nextCursor ? { next_cursor: nextCursor } : {}),
            truncated: Boolean(nextCursor),
          };
        }
      }

      const next =
        typeof payload.cursor.next === "string"
          ? payload.cursor.next
          : undefined;
      if (!next) {
        backendCursor = null;
        break;
      }
      if (seen.has(next)) {
        throw incompatible("OpenCode repeated a session pagination cursor.");
      }
      seen.add(next);
      backendCursor = next;
      offset = 0;
    }

    if (pages === MAX_SESSION_PAGES && backendCursor) {
      nextCursor = encodeCursor({ v: 1, backend: backendCursor, offset });
    }
    return {
      project: this.projectIdentity(),
      sessions,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      truncated: Boolean(nextCursor),
    };
  }

  async getSessionDetails(sessionId: string): Promise<SessionDetailsResult> {
    const session = await this.requireExposedSession(sessionId);
    const [activity, pending] = await Promise.all([
      this.activity(sessionId),
      this.pending(sessionId),
    ]);
    return {
      ...toSummary(session, activity),
      ...(session.agent ? { agent: session.agent } : {}),
      ...(session.model
        ? {
            provider_id: session.model.providerID,
            model_id: session.model.id,
            ...(session.model.variant
              ? { variant: session.model.variant }
              : {}),
          }
        : {}),
      pending_input: pendingCounts(pending),
    };
  }

  async getSessionStatus(
    sessionId: string,
    messageId?: string,
  ): Promise<SessionStatusResult> {
    await this.requireExposedSession(sessionId);
    const [activity, pending] = await Promise.all([
      this.activity(sessionId),
      this.pending(sessionId),
    ]);
    const base = {
      session_id: sessionId,
      backend_activity: activity,
      pending_input: pendingCounts(pending),
      assistant_message_ids: [] as string[],
    };
    if (!messageId) {
      return {
        ...base,
        state:
          pending.permissions + pending.questions > 0
            ? "input_required"
            : activity === "idle"
              ? "unknown"
              : "running",
      };
    }

    const { items: messages } = await this.messages(
      sessionId,
      STATUS_HISTORY_LIMIT,
    );
    return this.correlatedStatus(
      sessionId,
      messageId,
      messages,
      activity,
      pending,
    );
  }

  private correlatedStatus(
    sessionId: string,
    messageId: string,
    messages: MessageWithParts[],
    activity: SessionActivity,
    pending: PendingDetails,
  ): SessionStatusResult {
    const base = {
      session_id: sessionId,
      backend_activity: activity,
      pending_input: pendingCounts(pending),
      assistant_message_ids: [] as string[],
    };
    const user = messages.find(
      (message) =>
        message.info.id === messageId && message.info.role === "user",
    );
    if (!user) {
      return { ...base, message_id: messageId, state: "unknown" };
    }
    const assistants = messages.filter(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === messageId,
    );
    const assistantIds = assistants.map((message) => message.info.id);
    const latestAssistant = assistants.at(-1);
    const pendingForTurn =
      pending.permissionsList.some(
        (request) =>
          !request.source || assistantIds.includes(request.source.messageID),
      ) ||
      pending.questionsList.some(
        (request) =>
          !request.tool || assistantIds.includes(request.tool.messageID),
      );

    let state: SessionStatusResult["state"];
    if (pendingForTurn || pending.permissions + pending.questions > 0) {
      state = "input_required";
    } else if (assistants.some((message) => isAborted(message.info))) {
      state = "aborted";
    } else if (
      assistants.some((message) => hasError(message.info)) ||
      (latestAssistant?.info.role === "assistant" &&
        latestAssistant.info.finish === "error")
    ) {
      state = "failed";
    } else if (
      latestAssistant?.info.role === "assistant" &&
      assistants.every(
        (message) =>
          message.info.role === "assistant" &&
          typeof message.info.time.completed === "number",
      ) &&
      isCompletedFinish(latestAssistant.info.finish)
    ) {
      state = "completed";
    } else if (activity !== "idle") {
      state = "running";
    } else if (assistants.length === 0) {
      state = "submitted";
    } else {
      state = "unknown";
    }

    if (state === "completed" || state === "failed" || state === "aborted") {
      if (this.unresolved.get(sessionId) === messageId)
        this.unresolved.delete(sessionId);
    }
    return {
      ...base,
      message_id: messageId,
      state,
      assistant_message_ids: assistantIds,
    };
  }

  async getSessionHistory(
    sessionId: string,
    limit = 10,
    before?: string,
  ): Promise<SessionHistoryResult> {
    await this.requireExposedSession(sessionId);
    const boundedLimit = integerInRange(limit, 1, 20, "limit");
    if (before && !isOpaqueCursor(before)) {
      throw new AdapterError("INVALID_ARGUMENT", "before cursor is invalid.");
    }
    const page = await this.messages(sessionId, boundedLimit, before);
    const visible = page.items.filter(
      (message) =>
        message.info.role === "user" || message.info.role === "assistant",
    );
    let remaining = MAX_HISTORY_TEXT;
    let textWasTruncated = false;
    const messages: HistoryMessage[] = visible.map((message) => {
      const full = message.parts
        .filter(
          (part): part is Extract<Part, { type: "text" }> =>
            part.type === "text" && !part.synthetic && !part.ignored,
        )
        .map((part) => part.text)
        .join("");
      const text = full.slice(0, remaining);
      const textTruncated = text.length < full.length;
      remaining -= text.length;
      textWasTruncated ||= textTruncated;
      const info = message.info;
      return {
        id: info.id,
        role: info.role,
        ...(info.role === "assistant" ? { parent_id: info.parentID } : {}),
        text,
        created: info.time.created,
        ...(info.role === "assistant" && typeof info.time.completed === "number"
          ? { completed: info.time.completed }
          : {}),
        ...(info.role === "assistant" && info.finish
          ? { finish: info.finish }
          : {}),
        ...(info.role === "assistant" && info.error
          ? {
              error: isAborted(info)
                ? ("aborted" as const)
                : ("failed" as const),
            }
          : {}),
        text_truncated: textTruncated,
      };
    });
    return {
      session_id: sessionId,
      messages,
      ...(page.next ? { next_before: page.next } : {}),
      truncated: Boolean(page.next) || textWasTruncated,
    };
  }

  async sendMessage(
    sessionId: string,
    message: string,
  ): Promise<SendMessageResult> {
    if (message.length < 1 || message.length > 32_000) {
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "message must contain between 1 and 32000 characters.",
      );
    }
    if (this.submissionLocks.has(sessionId)) {
      throw new AdapterError(
        "SESSION_BUSY",
        "The session is already receiving a message.",
      );
    }
    this.submissionLocks.add(sessionId);
    this.collecting.delete(sessionId);
    try {
      const unresolvedId = this.unresolved.get(sessionId);
      if (unresolvedId) {
        const status = await this.getSessionStatus(sessionId, unresolvedId);
        if (
          status.state !== "completed" &&
          status.state !== "failed" &&
          status.state !== "aborted"
        ) {
          throw new AdapterError(
            "SESSION_BUSY",
            "The previous MCP submission has not reached a terminal state.",
            unresolvedId,
          );
        }
      }

      const session = await this.requireExposedSession(sessionId);
      const [activity, pending] = await Promise.all([
        this.activity(sessionId),
        this.pending(sessionId),
      ]);
      if (pending.permissions + pending.questions > 0) {
        throw new AdapterError(
          "INPUT_REQUIRED",
          "The session is waiting for input in OpenCode Web UI or TUI.",
        );
      }
      if (activity !== "idle") {
        throw new AdapterError(
          "SESSION_BUSY",
          "The OpenCode session is not idle.",
        );
      }
      const settings = await this.promptSettings(session);
      const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
      const activityCursor = await this.journal?.track(sessionId, messageId);
      const submittedAt = new Date().toISOString();
      this.unresolved.set(sessionId, messageId);
      try {
        await this.client.session.promptAsync(
          {
            sessionID: sessionId,
            directory: this.runtime.project,
            messageID: messageId,
            agent: settings.agent,
            model: settings.model,
            ...(settings.variant ? { variant: settings.variant } : {}),
            parts: [{ type: "text", text: message }],
          },
          { signal: AbortSignal.timeout(this.admissionDeadlineMs) },
        );
      } catch {
        throw new AdapterError(
          "SUBMISSION_UNCERTAIN",
          "OpenCode did not confirm whether the message was admitted; do not retry automatically.",
          messageId,
        );
      }
      if (this.journal) {
        // Admission already happened; a journal fault must not turn the receipt
        // into a retryable send error. Durable tracking permits reconciliation.
        await this.journal
          .submitted(sessionId, session.title, messageId)
          .catch(() => {
            this.tracking.partial = true;
            process.stderr.write(
              "[mcp] activity persistence failed after admission\n",
            );
          });
      }
      return {
        session_id: sessionId,
        message_id: messageId,
        state: "submitted",
        submitted_at: submittedAt,
        ...(activityCursor ? { activity_cursor: activityCursor } : {}),
      };
    } finally {
      this.submissionLocks.delete(sessionId);
    }
  }

  private async checkCompatibility(): Promise<void> {
    const [health, project, sessions] = await Promise.all([
      this.backendCall(
        () => this.client.global.health({ signal: this.deadline() }),
        "The OpenCode health endpoint is unavailable.",
      ),
      this.backendCall(
        () =>
          this.client.project.current(
            { directory: this.runtime.project },
            { signal: this.deadline() },
          ),
        "The OpenCode project endpoint is unavailable.",
      ),
      this.backendCall(
        () =>
          this.client.v2.session.list(
            { directory: this.runtime.project, limit: 1, order: "desc" },
            { signal: this.deadline() },
          ),
        "The OpenCode v2 session endpoint is unavailable.",
      ),
    ]);
    if (health.data?.healthy !== true) {
      throw incompatible("The OpenCode server is unhealthy.");
    }
    if (
      !project.data ||
      typeof project.data.id !== "string" ||
      project.data.id.length === 0
    ) {
      throw incompatible("OpenCode did not return a project identity.");
    }
    if (!sessions.data || !Array.isArray(sessions.data.data)) {
      throw incompatible(
        "OpenCode returned an unsupported v2 session response.",
      );
    }
    this.projectId = project.data.id;
  }

  private async requireExposedSession(
    sessionId: string,
  ): Promise<SessionV2Info> {
    await this.compatibilityCheck();
    let session: SessionV2Info | undefined;
    try {
      const response = await this.client.v2.session.get(
        { sessionID: sessionId },
        { signal: this.deadline() },
      );
      session = response.data?.data;
    } catch (error) {
      if (httpStatus(error) === 404) throw sessionNotFound();
      throw unavailable("Could not inspect the OpenCode session.");
    }
    if (
      !session ||
      session.id !== sessionId ||
      !(await this.isExposedSession(session))
    )
      throw sessionNotFound();
    return session;
  }

  private async isExposedSession(
    session: SessionV2Info,
    knownManagerId?: string,
  ): Promise<boolean> {
    const managerId = knownManagerId ?? (await this.managerSessionId());
    return (
      session.projectID === this.requiredProjectId() &&
      session.location.directory === this.runtime.project &&
      !session.parentID &&
      !session.time.archived &&
      session.agent !== OPENLIVE_MANAGER_AGENT &&
      session.id !== managerId
    );
  }

  private async managerSessionId(): Promise<string | undefined> {
    if (!this.runtime.managerFile) return undefined;
    const stat = await lstat(this.runtime.managerFile).catch(() => undefined);
    if (!stat) return undefined;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw incompatible("The OpenLive manager descriptor is unsafe.");
    }
    try {
      const value: unknown = JSON.parse(
        await readFile(this.runtime.managerFile, "utf8"),
      );
      if (
        !isRecord(value) ||
        value.schema !== 1 ||
        value.project !== this.runtime.project ||
        typeof value.sessionId !== "string"
      ) {
        throw new Error("invalid");
      }
      return value.sessionId;
    } catch {
      throw incompatible("The OpenLive manager descriptor is invalid.");
    }
  }

  private async activities(): Promise<Map<string, SessionActivity>> {
    const response = await this.backendCall(
      () =>
        this.client.session.status(
          { directory: this.runtime.project },
          { signal: this.deadline() },
        ),
      "Could not read OpenCode session activity.",
    );
    if (!response.data || !isRecord(response.data)) {
      throw incompatible("OpenCode returned an unsupported status response.");
    }
    const result = new Map<string, SessionActivity>();
    for (const [id, value] of Object.entries(response.data)) {
      if (isRecord(value) && isActivity(value.type)) result.set(id, value.type);
    }
    return result;
  }

  private async activity(sessionId: string): Promise<SessionActivity> {
    return (await this.activities()).get(sessionId) ?? "idle";
  }

  private async pending(sessionId: string): Promise<PendingDetails> {
    const [permissions, questions] = await Promise.all([
      this.backendCall(
        () =>
          this.client.v2.session.permission.list(
            { sessionID: sessionId },
            { signal: this.deadline() },
          ),
        "Could not read pending OpenCode permissions.",
      ),
      this.backendCall(
        () =>
          this.client.v2.session.question.list(
            { sessionID: sessionId },
            { signal: this.deadline() },
          ),
        "Could not read pending OpenCode questions.",
      ),
    ]);
    const permissionsList = permissions.data?.data;
    const questionsList = questions.data?.data;
    if (!Array.isArray(permissionsList) || !Array.isArray(questionsList)) {
      throw incompatible("OpenCode returned unsupported pending-input data.");
    }
    return {
      permissions: permissionsList.length,
      questions: questionsList.length,
      permissionsList,
      questionsList,
    };
  }

  private async messages(
    sessionId: string,
    limit: number,
    before?: string,
  ): Promise<MessagePage> {
    let response: Awaited<ReturnType<OpenCodeClient["session"]["messages"]>>;
    try {
      response = await this.client.session.messages(
        {
          sessionID: sessionId,
          directory: this.runtime.project,
          limit,
          ...(before ? { before } : {}),
        },
        { signal: this.deadline() },
      );
    } catch (error) {
      if (before && httpStatus(error) === 400) {
        throw new AdapterError("INVALID_ARGUMENT", "before cursor is invalid.");
      }
      throw unavailable("Could not read OpenCode session history.");
    }
    if (!Array.isArray(response.data)) {
      throw incompatible("OpenCode returned unsupported session history.");
    }
    const next = response.response.headers.get("x-next-cursor") ?? undefined;
    if (next && !isOpaqueCursor(next)) {
      throw incompatible("OpenCode returned an invalid history cursor.");
    }
    return { items: response.data, ...(next ? { next } : {}) };
  }

  private async promptSettings(session: SessionV2Info): Promise<{
    agent: string;
    model: { providerID: string; modelID: string };
    variant?: string;
  }> {
    if (session.agent && session.model) {
      return {
        agent: session.agent,
        model: {
          providerID: session.model.providerID,
          modelID: session.model.id,
        },
        ...(session.model.variant ? { variant: session.model.variant } : {}),
      };
    }
    const { items: messages } = await this.messages(session.id, 20);
    const user = [...messages]
      .reverse()
      .map((message) => message.info)
      .find((message) => message.role === "user");
    if (!user || user.role !== "user") {
      throw incompatible(
        "The session has no reusable agent and model settings.",
      );
    }
    return {
      agent: user.agent,
      model: user.model,
      ...(user.model.variant ? { variant: user.model.variant } : {}),
    };
  }

  private async newSessionSettings(): Promise<{
    agent: string;
    model: { providerID: string; id: string; variant?: string };
  }> {
    const parameters = { directory: this.runtime.project };
    const [config, agents, providers, models] = await Promise.all([
      this.backendCall(
        () => this.client.config.get(parameters, { signal: this.deadline() }),
        "Could not read OpenCode defaults.",
      ),
      this.backendCall(
        () => this.client.app.agents(parameters, { signal: this.deadline() }),
        "Could not read OpenCode work agents.",
      ),
      this.backendCall(
        () =>
          this.client.provider.list(parameters, { signal: this.deadline() }),
        "Could not read OpenCode model availability.",
      ),
      this.backendCall(
        () =>
          this.client.v2.model.list(
            { location: { directory: this.runtime.project } },
            { signal: this.deadline() },
          ),
        "Could not read enabled OpenCode models.",
      ),
    ]);
    const catalog = providers.data;
    if (
      !isRecord(config.data) ||
      !Array.isArray(agents.data) ||
      !catalog ||
      !Array.isArray(catalog.all) ||
      !Array.isArray(catalog.connected) ||
      !isRecord(catalog.default) ||
      !Array.isArray(models.data?.data)
    ) {
      throw incompatible("OpenCode returned unsupported session defaults.");
    }
    const available = agents.data.filter(
      (agent) =>
        typeof agent?.name === "string" &&
        agent.name !== OPENLIVE_MANAGER_AGENT &&
        !agent.hidden &&
        (agent.mode === "primary" || agent.mode === "all"),
    );
    const agent = config.data.default_agent
      ? available.find((item) => item.name === config.data?.default_agent)
      : (available.find((item) => item.name === "build") ?? available[0]);
    if (!agent)
      throw incompatible(
        "OpenCode has no available default primary work agent.",
      );

    let model = agent.model
      ? { providerID: agent.model.providerID, id: agent.model.modelID }
      : undefined;
    if (!model && config.data.model) {
      const slash = config.data.model.indexOf("/");
      if (slash < 1)
        throw incompatible(
          "OpenCode's configured model must use provider/model format.",
        );
      model = {
        providerID: config.data.model.slice(0, slash),
        id: config.data.model.slice(slash + 1),
      };
    }
    const connected = catalog.all.filter((provider) =>
      catalog.connected.includes(provider.id),
    );
    if (!model) {
      const provider = connected.find((item) => {
        const id = catalog.default[item.id];
        return id && item.models?.[id];
      });
      const id = provider ? catalog.default[provider.id] : undefined;
      if (provider && id) model = { providerID: provider.id, id };
    }
    if (
      !model ||
      !connected.some(
        (provider) =>
          provider.id === model?.providerID && provider.models?.[model.id],
      )
    ) {
      throw incompatible(
        "No connected default model is available. Configure a model in OpenCode before creating a session.",
      );
    }
    const selected = models.data.data.find(
      (item) => item.providerID === model.providerID && item.id === model.id,
    );
    if (selected && !selected.enabled)
      throw incompatible("The default model is not enabled in OpenCode.");
    const legacy = connected.find(
      (provider) => provider.id === model.providerID,
    )?.models[model.id];
    const variants = selected
      ? ["default", ...selected.variants.map((variant) => variant.id)]
      : this.legacyVariants(legacy?.variants);
    if (agent.variant && !variants.includes(agent.variant)) {
      throw incompatible(
        "The default agent's variant is not available for its model.",
      );
    }
    return {
      agent: agent.name,
      model: { ...model, ...(agent.variant ? { variant: agent.variant } : {}) },
    };
  }

  private async runtimeOptions(): Promise<RuntimeOptions> {
    const parameters = { directory: this.runtime.project };
    const [agents, providers, models] = await Promise.all([
      this.backendCall(
        () => this.client.app.agents(parameters, { signal: this.deadline() }),
        "Could not read available work agents.",
      ),
      this.backendCall(
        () =>
          this.client.provider.list(parameters, { signal: this.deadline() }),
        "Could not read available models.",
      ),
      this.backendCall(
        () =>
          this.client.v2.model.list(
            { location: { directory: this.runtime.project } },
            { signal: this.deadline() },
          ),
        "Could not read enabled model variants.",
      ),
    ]);
    const catalog = providers.data;
    if (
      !Array.isArray(agents.data) ||
      !catalog ||
      !Array.isArray(catalog.all) ||
      !Array.isArray(catalog.connected) ||
      !Array.isArray(models.data?.data)
    )
      throw new AdapterError(
        "UNSUPPORTED_CONFIGURATION",
        "OpenCode returned unsupported runtime options.",
      );
    const connected = catalog.all.filter((provider) =>
      catalog.connected.includes(provider.id),
    );
    const native = new Map(
      models.data.data.map((model) => [
        JSON.stringify([model.providerID, model.id]),
        model,
      ]),
    );
    return {
      agents: agents.data
        .filter(
          (agent) =>
            !agent.hidden &&
            agent.name !== OPENLIVE_MANAGER_AGENT &&
            (agent.mode === "primary" || agent.mode === "all"),
        )
        .map((agent) => agent.name),
      providers: connected.map((provider) => ({
        provider_id: provider.id,
        name: provider.name ?? provider.id,
      })),
      // Custom providers are bridged lazily into v2 on first use. Keep the
      // connected legacy catalog until a native entry exists; native disabling
      // and variant declarations take precedence once present.
      models: connected.flatMap((provider) =>
        Object.entries(provider.models).flatMap(([id, model]) => {
          const entry = native.get(JSON.stringify([provider.id, id]));
          if (entry && !entry.enabled) return [];
          return [
            {
              provider_id: provider.id,
              model_id: id,
              name: model.name ?? id,
              variants: entry
                ? [
                    ...new Set([
                      "default",
                      ...entry.variants.map((variant) => variant.id),
                    ]),
                  ]
                : this.legacyVariants(model.variants),
            },
          ];
        }),
      ),
      truncated: false,
    };
  }

  private legacyVariants(
    variants: Record<string, Record<string, unknown>> | undefined,
  ): string[] {
    return [
      ...new Set([
        "default",
        ...Object.entries(variants ?? {})
          .filter(([, value]) => value.disabled !== true)
          .map(([id]) => id),
      ]),
    ];
  }

  private validateRuntime(
    settings: SessionRuntime,
    options: RuntimeOptions,
  ): void {
    if (!options.agents.includes(settings.agent))
      throw new AdapterError(
        "INVALID_AGENT",
        "Agent is not an available primary work agent.",
      );
    if (
      !options.providers.some(
        (provider) => provider.provider_id === settings.provider_id,
      )
    )
      throw new AdapterError(
        "INVALID_PROVIDER",
        "Provider is not connected or available.",
      );
    const model = options.models.find(
      (item) =>
        item.provider_id === settings.provider_id &&
        item.model_id === settings.model_id,
    );
    if (!model)
      throw new AdapterError(
        "INVALID_MODEL",
        "Model is not available from the selected provider.",
      );
    if (!model.variants.includes(settings.variant))
      throw new AdapterError(
        "INVALID_VARIANT",
        "Variant is not available for this model. Use get_session_runtime_options; use default to reset the variant.",
      );
  }

  private async sessionRuntime(
    session: SessionV2Info,
  ): Promise<SessionRuntime> {
    const settings = await this.promptSettings(session);
    return {
      agent: settings.agent,
      provider_id: settings.model.providerID,
      model_id: settings.model.modelID,
      variant: settings.variant ?? "default",
    };
  }

  private async requireIdle(id: string): Promise<void> {
    const receipt = this.unresolved.get(id);
    if (receipt) {
      const status = await this.getSessionStatus(id, receipt);
      if (!["completed", "failed", "aborted"].includes(status.state))
        throw new AdapterError(
          "SESSION_BUSY",
          "The previous MCP submission is unresolved.",
        );
    }
    if ((await this.activity(id)) !== "idle")
      throw new AdapterError("SESSION_BUSY", "The session is not idle.");
    const pending = await this.pending(id);
    if (pending.permissions + pending.questions > 0)
      throw new AdapterError(
        "INPUT_REQUIRED",
        "Resolve pending input in Web UI/TUI before changing runtime settings.",
      );
  }

  private requireJournal(): ActivityJournal {
    if (!this.journal)
      throw new AdapterError(
        "ACTIVITY_UNAVAILABLE",
        "Activity collection has not been initialized.",
      );
    return this.journal;
  }

  private async activitySnapshot(id: string): Promise<ActivitySnapshot> {
    const session = await this.requireExposedSession(id);
    const [activity, pending, history] = await Promise.all([
      this.activity(id),
      this.pending(id),
      this.messages(id, STATUS_HISTORY_LIMIT),
    ]);
    const ids = new Set([
      ...history.items
        .filter((item) => item.info.role === "user")
        .map((item) => item.info.id),
      ...(this.journal?.trackedMessages(id) ?? []),
    ]);
    return {
      session_id: id,
      session_title: session.title.slice(0, 160),
      activity,
      pending_input: pendingCounts(pending),
      ...(session.agent && session.model
        ? { runtime: await this.sessionRuntime(session) }
        : {}),
      messages: [...ids].map((messageId) =>
        this.correlatedStatus(id, messageId, history.items, activity, pending),
      ),
    };
  }

  async captureActivity(
    id: string,
    source: "observed" | "reconciled" = "reconciled",
  ): Promise<void> {
    if (
      !this.journal ||
      this.collecting.has(id) ||
      this.submissionLocks.has(id)
    )
      return;
    const marker = Symbol();
    this.collecting.set(id, marker);
    try {
      const snapshot = await this.activitySnapshot(id);
      if (this.collecting.get(id) === marker && !this.submissionLocks.has(id))
        await this.journal.observe(snapshot, source);
    } catch (error) {
      if (
        !(error instanceof AdapterError && error.code === "SESSION_NOT_FOUND")
      )
        throw error;
    } finally {
      if (this.collecting.get(id) === marker) this.collecting.delete(id);
    }
  }

  private async collectEvents(): Promise<void> {
    while (!this.collectorStop.signal.aborted) {
      try {
        const subscription = await this.client.event.subscribe(
          { directory: this.runtime.project },
          { signal: this.collectorStop.signal, sseMaxRetryAttempts: 1 },
        );
        for await (const event of subscription.stream) {
          if (this.collectorStop.signal.aborted) break;
          this.tracking.connected = true;
          if (!isRecord(event) || !isRecord(event.properties)) continue;
          const properties = event.properties as Record<string, unknown>;
          const info = isRecord(properties.info) ? properties.info : undefined;
          const id =
            typeof properties.sessionID === "string"
              ? properties.sessionID
              : typeof info?.sessionID === "string"
                ? info.sessionID
                : typeof info?.id === "string" &&
                    event.type.startsWith("session.")
                  ? info.id
                  : undefined;
          if (
            !id ||
            !/^(message\.updated|session\.(status|idle|updated|next\.)|permission\.|question\.)/u.test(
              event.type,
            )
          )
            continue;
          try {
            const session = await this.requireExposedSession(id);
            if (
              event.type === "session.status" &&
              isRecord(properties.status)
            ) {
              if (
                properties.status.type === "busy" ||
                properties.status.type === "retry" ||
                properties.status.type === "idle"
              )
                await this.journal!.signal(
                  id,
                  session.title,
                  properties.status.type === "idle" ? "idle" : "busy",
                );
            } else if (/^permission\..*asked$/u.test(event.type))
              await this.journal!.signal(id, session.title, "permission");
            else if (/^question\..*asked$/u.test(event.type))
              await this.journal!.signal(id, session.title, "question");
            await this.captureActivity(id, "observed");
          } catch (error) {
            if (
              !(
                error instanceof AdapterError &&
                error.code === "SESSION_NOT_FOUND"
              )
            )
              this.tracking.partial = true;
          }
        }
      } catch {
        this.tracking.partial = true;
      }
      this.tracking.connected = false;
      await this.pause(1000);
    }
  }

  private async sweepActivity(): Promise<void> {
    while (!this.collectorStop.signal.aborted) {
      let cursor: string | undefined;
      let count = 0;
      let pages = 0;
      try {
        do {
          const page = await this.listSessions(20, cursor);
          pages++;
          for (const session of page.sessions) {
            await this.captureActivity(session.id);
            count++;
          }
          cursor = page.next_cursor;
        } while (
          cursor &&
          count < 200 &&
          pages < 10 &&
          !this.collectorStop.signal.aborted
        );
        for (const id of this.journal!.trackedSessions)
          await this.captureActivity(id);
        this.tracking.partial = Boolean(cursor);
        this.tracking.last_reconciled_at = new Date().toISOString();
      } catch {
        this.tracking.partial = true;
      }
      await this.pause(5000);
    }
  }

  private async pause(milliseconds: number): Promise<void> {
    if (this.collectorStop.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.collectorStop.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      this.collectorStop.signal.addEventListener("abort", done, { once: true });
    });
  }

  private requiredProjectId(): string {
    if (!this.projectId)
      throw incompatible("OpenCode project identity is unavailable.");
    return this.projectId;
  }

  private projectIdentity(): ProjectIdentity {
    return { id: this.runtime.projectHash, name: this.runtime.projectName };
  }

  private deadline(): AbortSignal {
    return AbortSignal.any([
      AbortSignal.timeout(this.backendDeadlineMs),
      this.collectorStop.signal,
    ]);
  }

  private async backendCall<T>(
    operation: () => Promise<T>,
    message: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch {
      throw unavailable(message);
    }
  }
}

function toSummary(
  session: SessionV2Info,
  activity: SessionActivity,
): SessionSummary {
  return {
    id: session.id,
    title: session.title.slice(0, 160),
    created: session.time.created,
    updated: session.time.updated,
    activity,
  };
}

function pendingCounts(pending: PendingDetails): PendingInput {
  return { permissions: pending.permissions, questions: pending.questions };
}

function isActivity(value: unknown): value is SessionActivity {
  return value === "idle" || value === "busy" || value === "retry";
}

function hasError(message: Message): boolean {
  return message.role === "assistant" && Boolean(message.error);
}

function isAborted(message: Message): boolean {
  return (
    message.role === "assistant" &&
    (message.error?.name === "MessageAbortedError" ||
      message.finish === "abort")
  );
}

function isCompletedFinish(value: string | undefined): boolean {
  return value === "stop" || value === "length" || value === "content-filter";
}

function isOpaqueCursor(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 2048 &&
    !/[\s\x00-\x1f\x7f]/u.test(value)
  );
}

function integerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AdapterError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function decodeCursor(value?: string): SessionCursor {
  if (!value) return { v: 1, backend: null, offset: 0 };
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      (parsed.backend !== null && typeof parsed.backend !== "string") ||
      !Number.isInteger(parsed.offset) ||
      (parsed.offset as number) < 0 ||
      (parsed.offset as number) > BACKEND_PAGE_SIZE
    ) {
      throw new Error();
    }
    return parsed as SessionCursor;
  } catch {
    throw new AdapterError("INVALID_ARGUMENT", "cursor is invalid.");
  }
}

function encodeCursor(value: SessionCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function httpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.status === "number") return error.status;
  if (isRecord(error.response) && typeof error.response.status === "number") {
    return error.response.status;
  }
  return httpStatus(error.cause);
}

function sessionNotFound(): AdapterError {
  return new AdapterError(
    "SESSION_NOT_FOUND",
    "The session does not exist or is not exposed by this project endpoint.",
  );
}

function unavailable(message: string): AdapterError {
  return new AdapterError("BACKEND_UNAVAILABLE", message);
}

function incompatible(message: string): AdapterError {
  return new AdapterError("BACKEND_INCOMPATIBLE", message);
}
