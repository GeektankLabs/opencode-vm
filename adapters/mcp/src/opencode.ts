import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  Message,
  Part,
  PermissionV2Request,
  QuestionV2Request,
  SessionV2Info,
} from "@opencode-ai/sdk/v2";
import { AdapterError, MAX_HISTORY_TEXT, isRecord } from "./types.js";
import type {
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
      return {
        session_id: sessionId,
        message_id: messageId,
        state: "submitted",
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
    if (!session || !(await this.isExposedSession(session)))
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

  private requiredProjectId(): string {
    if (!this.projectId)
      throw incompatible("OpenCode project identity is unavailable.");
    return this.projectId;
  }

  private projectIdentity(): ProjectIdentity {
    return { id: this.runtime.projectHash, name: this.runtime.projectName };
  }

  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.backendDeadlineMs);
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
