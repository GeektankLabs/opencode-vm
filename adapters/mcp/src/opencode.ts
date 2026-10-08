import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import { ActivityJournal } from "./activity.js";
import { McpEventBridge } from "./events.js";
import { sanitizeSummary, summarizeAttention } from "./attention.js";
import { ProjectBoardService } from "./taskboard.js";
import { AttachmentStore, submittedAttachment } from "./attachments.js";
import type { AttachmentDescriptor } from "./attachments.js";
import type { DashboardControl } from "./dashboard.js";
import type {
  Message,
  Part,
  PermissionV2Request,
  QuestionV2Request,
  SessionV2Info,
} from "@opencode-ai/sdk/v2";
import {
  AdapterError,
  isRecord,
  MAX_CORRELATED_ERROR_DETAILS,
} from "./types.js";
import {
  ReadReferences,
  DEFAULT_CONTENT_BYTES,
  MAX_CONTENT_BYTES,
  READ_PAYLOAD_BYTES,
  READ_RESPONSE_BYTES,
  describeMessage,
  digest,
  fitPreviews,
  jsonBytes,
  safeAssistantErrorDetail,
  utf8Prefix,
  visibleContent,
} from "./content.js";
import type { ContentReference } from "./content.js";
import type {
  ActivityQuery,
  ActivityResult,
  AttentionQuery,
  AttentionResult,
  AttentionReceipt,
  AttentionEntry,
  ActivitySnapshot,
  CorrelatedErrorDetail,
  RuntimeOptions,
  RuntimePatch,
  RuntimeUpdateResult,
  SessionRuntime,
  CreateSessionResult,
  ListSessionsResult,
  PendingInput,
  ProjectIdentity,
  RuntimeDescriptor,
  SendMessageResult,
  AbortSessionTurnResult,
  SessionActivity,
  SessionDetailsResult,
  SessionHistoryResult,
  SessionStatusResult,
  SessionSummary,
  MessageResult,
  MessageContentResult,
  TaskResult,
  SessionProgressResult,
  ToolObservation,
  AdmissionState,
  ArchiveSessionResult,
  RenameSessionResult,
  SubmissionGuardOverrideInput,
  SubmissionGuardOverrideResult,
  SubmissionGuardSnapshot,
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

type ResultCursor = {
  kind: "result";
  session: string;
  user: string;
  boundary: string;
  before: string;
  assistants: number;
  allCompleted: boolean;
  failed: boolean;
  aborted: boolean;
  latestFinish?: string;
  newerTurn?: {
    assistantSeen: boolean;
    assistantParentId?: string;
    assistantCompleted: boolean;
    userSeen: boolean;
    userId?: string;
  };
  archived?: boolean;
};

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
  getSessionProgress(
    sessionId: string,
    messageId?: string,
  ): Promise<SessionProgressResult>;
  getMessage(
    sessionId: string,
    messageId: string,
    includeArchived?: boolean,
  ): Promise<MessageResult>;
  readMessageContent(
    reference: string,
    cursor?: string,
    maxBytes?: number,
  ): Promise<MessageContentResult>;
  getTaskResult(
    sessionId: string,
    messageId: string,
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
    includeArchived?: boolean,
  ): Promise<TaskResult>;
  archiveSession(sessionId: string): Promise<ArchiveSessionResult>;
  renameSession(
    sessionId: string,
    title: string,
  ): Promise<RenameSessionResult>;
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
  getSessionDetails(
    sessionId: string,
    includeArchived?: boolean,
  ): Promise<SessionDetailsResult>;
  getSessionStatus(
    sessionId: string,
    messageId?: string,
  ): Promise<SessionStatusResult>;
  getSessionHistory(
    sessionId: string,
    limit?: number,
    before?: string,
    includeArchived?: boolean,
  ): Promise<SessionHistoryResult>;
  uploadAttachment(
    sessionId: string,
    filename: string,
    mimeType: string,
    dataBase64: string,
  ): Promise<AttachmentDescriptor>;
  sendMessage(
    sessionId: string,
    message: string,
    attachmentIds?: string[],
  ): Promise<SendMessageResult>;
  sendFollowup?(
    sessionId: string,
    message: string,
    attachmentIds?: string[],
  ): Promise<SendMessageResult>;
  abortSessionTurn?(sessionId: string): Promise<AbortSessionTurnResult>;
  supersedeUnresolvedSubmission(
    input: SubmissionGuardOverrideInput,
  ): Promise<SubmissionGuardOverrideResult>;
  getProjectAttention?(query?: AttentionQuery): Promise<AttentionResult>;
  acknowledgeProjectAttention?(input: AttentionReceipt): Promise<AttentionEntry>;
  handleMcpEventMethod?(method: string, params: unknown): Promise<unknown>;
  backendConnectivity?(): Promise<"ok" | "unreachable" | "unverified">;
  /** Read-only Repo Live projection wired by the adapter runtime; absent in fakes. */
  dashboardControl?: DashboardControl;
}

export class OpenCodeGateway implements SessionGateway {
  private readonly client: OpenCodeClient;
  private projectId: string | undefined;
  dashboardControl?: DashboardControl;
  private compatibilityPromise: Promise<void> | undefined;
  private readonly submissionLocks = new Set<string>();
  private readonly unresolved = new Map<string, string>();
  private readonly uncertainSubmissions = new Map<
    string,
    { message: string; attachmentIds: string[]; messageId: string }
  >();
  private readonly readReferences = new ReadReferences();
  private readonly attachments = new AttachmentStore();
  private journal?: ActivityJournal;
  private eventBridge?: McpEventBridge;
  private attentionProcessing?: Promise<void>;
  private readonly attentionEpisodes = new Map<string, { attempts: number; nextAllowedAt: number; alerted: boolean }>();
  // Test seam: episode cadence defaults; behavior with defaults is the shipped contract.
  private attentionRetryDelaysMs: number[] = [5_000, 15_000, 45_000];
  private backendHealthCache?: { at: number; state: "ok" | "unreachable" };
  private backendHealthCacheTtlMs = 5000;
  private backendHealthProbeTimeoutMs = 500;
  // Test seam: abort verification cadence defaults; behavior with defaults is
  // the shipped contract.
  private abortVerifyBudgetMs = 8_000;
  private abortVerifyPollMs = 500;
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
    // Kept as an ignored constructor slot for source-level test/runtime callers
    // while admission no longer performs historical receipt searches.
    _legacyAdmissionSearchMs?: number,
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

  protected async adoptManagedSession(sessionId: string): Promise<void> {
    const socketPath = process.env.OCVM_MANAGED_POLICY_SOCKET;
    if (!socketPath) throw new AdapterError("BACKEND_INCOMPATIBLE", "The agent-managed backend policy is not installed. Start or attach with the current opencode-vm before submitting work.");
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({ socketPath, path: "/adopt", method: "POST", headers: { "content-type": "application/json" }, timeout: this.backendDeadlineMs }, response => {
        let text = "";
        response.on("data", chunk => { text += chunk; if (text.length > 4096) request.destroy(new Error("Managed policy response exceeded its limit")); });
        response.on("end", () => {
          try {
            const result = JSON.parse(text);
            if (result.error === "MANAGED_SESSION_BUSY") throw new AdapterError("SESSION_BUSY", "The session became busy before managed work admission.", undefined, "backend_active");
            if (result.error === "MANAGED_INPUT_PENDING") throw new AdapterError("INPUT_REQUIRED", "The session has pending operator input; no work was admitted.", undefined, "pending_input");
            if (response.statusCode !== 200 || result.session_id !== sessionId || result.agent_managed !== true || result.revision !== 1) throw new Error("Managed policy adoption was not confirmed");
            resolve();
          } catch (error) { reject(error); }
        });
      });
      request.on("timeout", () => request.destroy(new Error("Managed policy admission timed out")));
      request.on("error", reject);
      request.end(JSON.stringify({ session_id: sessionId, ingress: "mcp" }));
    }).catch(error => { if (error instanceof AdapterError) throw error; throw new AdapterError("BACKEND_INCOMPATIBLE", "Agent-managed policy adoption could not be verified; no work prompt was submitted."); });
  }

  async enableActivity(path: string, legacyPath?: string): Promise<void> {
    this.journal = await ActivityJournal.open(path, this.runtime.projectHash, 5000, legacyPath);
    this.eventBridge = new McpEventBridge(this.journal, this.runtime.projectHash);
  }

  startActivityCollection(): void {
    if (!this.journal || this.collector) return;
    void this.processPendingAttention().catch(() => { this.tracking.partial = true; });
    this.collector = this.collectEvents();
    this.sweeper = this.sweepActivity();
  }

  async getProjectAttention(query: AttentionQuery = {}): Promise<AttentionResult> {
    const visible = async (id: string) => {
      try { await this.requireExposedSession(id); return true; }
      catch (error) {
        if (error instanceof AdapterError && error.code === "SESSION_NOT_FOUND") return false;
        throw error;
      }
    };
    const journal = this.requireJournal();
    let limit = query.limit ?? 25;
    for (;;) {
      const result = await journal.listAttention({ ...query, limit }, visible);
      if (jsonBytes(result) <= READ_RESPONSE_BYTES - 2048) return result;
      if (limit === 1) throw new AdapterError("RESPONSE_BUDGET_EXCEEDED", "One prepared attention entry exceeds the bounded read response budget.");
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }

  async acknowledgeProjectAttention(input: AttentionReceipt): Promise<AttentionEntry> {
    const journal = this.requireJournal();
    const entry = await journal.attention(input.event_id);
    if (!entry) throw new AdapterError("ATTENTION_NOT_FOUND", "Prepared attention entry is unavailable.");
    await this.requireExposedSession(entry.session_id);
    return journal.attentionReceipt(input);
  }

  async handleMcpEventMethod(method: string, params: unknown): Promise<unknown> {
    if (!this.eventBridge) throw new AdapterError("ACTIVITY_UNAVAILABLE", "MCP Events are not initialized.");
    return this.eventBridge.handle(method, params);
  }

  /**
   * Cached, bounded backend connectivity evidence for the health granularity
   * read (STARTREST P5). Never blocks the health endpoint for longer than the
   * short probe timeout; connectivity alone is not tool-roundtrip proof.
   */
  async backendConnectivity(): Promise<"ok" | "unreachable" | "unverified"> {
    const now = Date.now();
    if (this.backendHealthCache && now - this.backendHealthCache.at < this.backendHealthCacheTtlMs)
      return this.backendHealthCache.state;
    try {
      const health = await this.client.global.health({ signal: AbortSignal.timeout(this.backendHealthProbeTimeoutMs) });
      const state = health.data?.healthy === true ? "ok" : "unreachable";
      this.backendHealthCache = { at: Date.now(), state };
      return state;
    } catch {
      this.backendHealthCache = { at: Date.now(), state: "unreachable" };
      return "unreachable";
    }
  }

  private processPendingAttention(): Promise<void> {
    if (this.attentionProcessing) return this.attentionProcessing;
    const operation = this.drainPendingAttention();
    this.attentionProcessing = operation.finally(() => {
      this.attentionProcessing = undefined;
    });
    return this.attentionProcessing;
  }

  private async drainPendingAttention(): Promise<void> {
    if (!this.journal || !this.eventBridge) return;
    for (const entry of await this.journal.pendingAttention()) {
      // STARTREST P6: bounded backoff per failure episode. A repeatedly
      // CONTENT_UNAVAILABLE entry is skipped silently until its next allowed
      // attempt instead of re-running on every backend event; the episode
      // budget is finite and never replenished by success of other entries.
      const episode = this.attentionEpisodes.get(entry.event_id);
      if (episode && (episode.attempts >= this.attentionRetryDelaysMs.length || Date.now() < episode.nextAllowedAt)) continue;
      try {
        if (entry.event_type === "session.input_required") {
          const status = await this.getSessionStatus(entry.session_id, entry.submitted_message_id);
          if (status.pending_input.permissions + status.pending_input.questions === 0) {
            await this.journal.supersedeAttention(entry.event_id, "Pending input was resolved before prefetch; this notification is stale.");
            continue;
          }
          const context = await this.resolveAttentionTask(entry);
          const sourceRevision = `pending-input-v1:${createHash("sha256").update(JSON.stringify({
            session_id: entry.session_id,
            message_id: entry.submitted_message_id ?? null,
            pending_input: status.pending_input,
            observed_at: status.observed_at,
            task_id: context.task?.task_id ?? null,
            task_updated_at: context.task?.updated_at ?? null,
            documents: context.documentRevisions,
          })).digest("hex")}`;
          await this.journal.prepareAttention({
            ...entry,
            lifecycle: "ready",
            source_revision: sourceRevision,
            prepared_at: new Date().toISOString(),
            prepared_summary: `${context.task ? `${context.task.title}: ` : `Session ${entry.session_title}: `}operator input is required (${status.pending_input.permissions} permission(s), ${status.pending_input.questions} question(s)); pending-input scope is session-wide.`,
            next_safe_step: "Review and resolve the exact pending input in the host UI; the adapter did not answer or approve it.",
            ...(context.task ? { task_id: context.task.task_id, task_title: context.task.title, task_status: context.task.status,
              ...(context.task.updated_at ? { task_updated_at: context.task.updated_at } : {}) } : {}),
            ...(context.hierarchy?.master_task_id ? { master_task_id: context.hierarchy.master_task_id } : {}),
            ...(context.hierarchy?.work_package_id ? { work_package_id: context.hierarchy.work_package_id } : {}),
            hierarchy_status: context.hierarchy_status,
            evidence: { source: "pending_input", source_revision: sourceRevision, assistant_message_ids: [], complete: true },
          });
          this.attentionEpisodes.delete(entry.event_id);
          continue;
        }
        await this.prefetchTerminalAttention(entry);
        this.attentionEpisodes.delete(entry.event_id);
      } catch (error) {
        this.tracking.partial = true;
        const prior = this.attentionEpisodes.get(entry.event_id);
        const attempts = (prior?.attempts ?? 0) + 1;
        const delays = this.attentionRetryDelaysMs;
        const exhausted = attempts >= delays.length;
        this.attentionEpisodes.set(entry.event_id, {
          attempts,
          nextAllowedAt: Date.now() + delays[Math.min(attempts - 1, delays.length - 1)]!,
          alerted: exhausted ? true : (prior?.alerted ?? false),
        });
        const code = error instanceof AdapterError ? error.code : "unavailable";
        if (attempts === 1)
          process.stderr.write(`[mcp] attention prefetch pending event=${entry.event_id.slice(0, 72)} code=${code} (bounded backoff active)\n`);
        else if (exhausted && !prior?.alerted)
          process.stderr.write(`[mcp] attention prefetch exhausted after ${attempts} bounded attempts event=${entry.event_id.slice(0, 72)} code=${code}; entry stays pending, no automatic re-attempt\n`);
      }
    }
    await this.eventBridge.deliverPending();
  }

  private async prefetchTerminalAttention(entry: AttentionEntry): Promise<void> {
    if (!entry.submitted_message_id) throw new AdapterError("CONTENT_UNAVAILABLE", "Terminal event has no correlated submitted message ID.");
    const messages: TaskResult["messages"] = [];
    let cursor: string | undefined;
    let result: TaskResult | undefined;
    for (let page = 0; page < 25; page++) {
      result = await this.getTaskResult(entry.session_id, entry.submitted_message_id, cursor, 20);
      messages.push(...result.messages);
      if (result.search_complete) break;
      if (!result.next_cursor) throw new AdapterError("SEARCH_CHANGED", "Terminal result search was incomplete without a continuation cursor.");
      cursor = result.next_cursor;
    }
    if (!result?.search_complete) throw new AdapterError("TASK_SEARCH_INCOMPLETE", "Terminal result prefetch exceeded its bounded page budget.");
    const expected = entry.event_type === "message.completed" ? "completed" :
      entry.event_type === "message.failed" ? "failed" : "aborted";
    if (result.state !== expected) {
      if (result.state === "input_required") {
        await this.journal!.supersedeAttention(entry.event_id, "A newer correlated read shows pending operator input; re-read the current session before presenting this terminal event.");
        return;
      }
      if (result.state === "running" || result.state === "submitted" || result.state === "unknown")
        throw new AdapterError("CONTENT_UNAVAILABLE", "Current correlated receipt does not confirm the terminal event.");
      await this.journal!.supersedeAttention(entry.event_id, "A newer correlated terminal state superseded this event.");
      return;
    }
    const terminalMessages = messages.filter((item) => item.role === "assistant" && item.result_kind === "terminal");
    if (!terminalMessages.length)
      throw new AdapterError("CONTENT_UNAVAILABLE", "No terminal visible assistant result was exposed by this connector.");
    const allErrorDetails = terminalMessages.flatMap((message) =>
      message.parent_id === entry.submitted_message_id && message.error_detail
        ? [{
            ...message.error_detail,
            assistant_message_id: message.id,
            attribution: "exact_parent" as const,
          }]
        : [],
    );
    const errorDetails = allErrorDetails.slice(0, MAX_CORRELATED_ERROR_DETAILS);
    const errorDetailsTruncated =
      allErrorDetails.length > errorDetails.length;
    const reports: string[] = [];
    const messageRevisions: Array<{ id: string; revision: string }> = [];
    let totalBytes = 0;
    for (const report of terminalMessages) {
      const errorOnly = report.parent_id === entry.submitted_message_id &&
        Boolean(report.error_detail);
      if (!report.content || report.content.availability === "not_exposed") {
        if (errorOnly) continue;
        throw new AdapterError("CONTENT_UNAVAILABLE", "Complete visible terminal result text is not exposed by this connector.");
      }
      const chunks: string[] = [];
      let contentCursor: string | undefined;
      let offset = 0;
      let complete = false;
      for (let page = 0; page < 128; page++) {
        const content = await this.readMessageContent(report.content.content_ref, contentCursor, 16_384);
        if (content.revision !== report.content.revision || content.range.start !== offset)
          throw new AdapterError("CONTENT_CHANGED", "Visible result changed or has a discontinuous UTF-8 range during prefetch.");
        offset = content.range.end;
        totalBytes += Buffer.byteLength(content.text, "utf8");
        if (totalBytes > 512 * 1024) throw new AdapterError("RESPONSE_BUDGET_EXCEEDED", "Visible result exceeds the bounded attention prefetch size.");
        chunks.push(content.text);
        if (!content.has_more) { complete = true; break; }
        if (!content.next_cursor) throw new AdapterError("CONTENT_UNAVAILABLE", "Visible result page is incomplete without a cursor.");
        contentCursor = content.next_cursor;
      }
      if (!complete) throw new AdapterError("CONTENT_UNAVAILABLE", "Visible result prefetch exceeded its bounded page budget.");
      const verified = await this.getMessage(entry.session_id, report.id);
      if (verified.message.content?.revision !== report.content.revision)
        throw new AdapterError("CONTENT_CHANGED", "Visible result changed before attention publication.");
      reports.push(chunks.join(""));
      messageRevisions.push({ id: report.id, revision: report.content.revision });
    }
    const visibleResult = reports.join("\n\n");
    const errorEvidence = allErrorDetails.length
      ? digest(JSON.stringify(allErrorDetails))
      : undefined;
    const context = await this.resolveAttentionTask(entry);
    const sha256 = digest(visibleResult);
    const sourceRevision = `attention-v2:${digest(JSON.stringify({
      messages: messageRevisions,
      sha256,
      ...(errorEvidence
        ? {
            error_evidence: {
              sha256: errorEvidence,
              total: allErrorDetails.length,
            },
          }
        : {}),
      event_cursor: entry.activity_cursor,
      task_id: context.task?.task_id ?? null,
      task_updated_at: context.task?.updated_at ?? null,
      documents: context.documentRevisions,
    }))}`;
    const assistantMessageIds = [...new Set([
      ...entry.assistant_message_ids,
      ...messageRevisions.map((message) => message.id),
      ...allErrorDetails.map((detail) => detail.assistant_message_id),
    ])];
    const prepared = summarizeAttention(
      entry,
      visibleResult,
      sourceRevision,
      sha256,
      assistantMessageIds,
      context.task,
      context.hierarchy,
      context.hierarchy_status,
      errorDetails,
      allErrorDetails.length,
      errorDetailsTruncated,
    );
    await this.journal!.prepareAttention({ ...prepared, deliveries: entry.deliveries });
  }

  private async resolveAttentionTask(entry: AttentionEntry): Promise<{
    task?: { task_id: string; title: string; status: string; updated_at?: string };
    hierarchy?: {
      master_task_id?: string; master_task_title?: string; master_task_status?: string;
      work_package_id?: string; work_package_title?: string; work_package_status?: string;
      summary?: string; management_checkpoints?: AttentionEntry["management_checkpoints"];
    };
    documentRevisions: string[];
    hierarchy_status: AttentionEntry["hierarchy_status"];
  }> {
    if (!this.runtime.taskboardUrl || !this.runtime.taskboardMetadataFile)
      return { documentRevisions: [], hierarchy_status: "unavailable" };
    try {
      const board = new ProjectBoardService(this.runtime as RuntimeDescriptor & { taskboardUrl: string; taskboardMetadataFile: string });
      const linked = await board.listTasks({ sessionId: entry.session_id });
      const exact = entry.submitted_message_id
        ? linked.filter((task) => task.links?.some((link) => link.message_id === entry.submitted_message_id))
        : [];
      const candidates = exact.length ? exact : linked.length === 1 ? linked : [];
      if (candidates.length !== 1)
        return { documentRevisions: [], hierarchy_status: linked.length > 1 || exact.length > 1 ? "ambiguous" : "unlinked" };
      const selected = await board.getTask(candidates[0]!.task_id);
      const documentRevisions: string[] = [];
      const checkpoints: NonNullable<AttentionEntry["management_checkpoints"]> = [];
      const readTaskContext = async (taskId: string) => {
        const docs = await board.getDocuments(taskId);
        let text = "";
        const revisions: string[] = [];
        for (const document of docs.documents) {
          if (document.state !== "available" || (document.role !== "compact_context" && document.role !== "concept_plan")) continue;
          if (document.revision) revisions.push(`${document.path}:${document.revision}`);
          let offset = 0;
          for (let page = 0; page < 64; page++) {
            const part = await board.readDocument(taskId, document.role, document.path, offset, 8192,
              offset ? document.revision : undefined);
            text += part.text;
            offset = part.range.end;
            if (!part.has_more) break;
            if (page === 63) throw new AdapterError("TASK_DOCUMENT_LIMIT", "Task relation document exceeded its bounded read limit.");
          }
        }
        const history = await board.getManagementHistory(taskId, { mode: "latest_checkpoint", limit: 1 }, 0, undefined, 0);
        const checkpoint = history.entries[0];
        documentRevisions.push(...revisions);
        documentRevisions.push(`management:${taskId}:${history.generation ?? "absent"}:${history.head_sequence}`);
        checkpoints.push({
          task_id: taskId,
          state: history.state,
          ...(history.consistency ? { consistency: history.consistency } : {}),
          ...(history.generation ? { generation: history.generation } : {}),
          head_sequence: history.head_sequence,
          ...(history.latest_checkpoint ? { latest_checkpoint: {
            sequence: history.latest_checkpoint.sequence,
            entry_id: history.latest_checkpoint.entry_id,
            appended_at: history.latest_checkpoint.appended_at,
          } } : {}),
          ...(checkpoint ? {
            ...(relationField(checkpoint.text, "lifecycle") ? { lifecycle: relationField(checkpoint.text, "lifecycle") } : {}),
            ...(relationField(checkpoint.text, "operator_attention") ? { operator_attention: relationField(checkpoint.text, "operator_attention") } : {}),
            ...(relationField(checkpoint.text, "next_allowed_action") ? { next_allowed_action: relationField(checkpoint.text, "next_allowed_action") } : {}),
          } : {}),
        });
        return text;
      };
      const markers = await readTaskContext(selected.task_id);
      const packageId = relationId(markers, ["package_id", "work_package_id"]);
      let masterId = relationId(markers, ["master_task_id", "control_task_id"]);
      let packageTask: Awaited<ReturnType<typeof board.getTask>> | undefined;
      if (packageId && packageId !== selected.task_id) {
        packageTask = await board.getTask(packageId);
        const packageMarkers = await readTaskContext(packageId);
        masterId ??= relationId(packageMarkers, ["master_task_id", "control_task_id"]);
      }
      let masterTask: Awaited<ReturnType<typeof board.getTask>> | undefined;
      if (masterId && masterId !== selected.task_id && masterId !== packageId) {
        masterTask = await board.getTask(masterId);
        await readTaskContext(masterId);
      }
      const checkpointFacts = checkpoints.map((item) => item.latest_checkpoint
        ? `${item.task_id} checkpoint#${item.latest_checkpoint.sequence}`
        : `${item.task_id} checkpoint:none`).join("; ");
      const hierarchySummary = [
        `Task ${selected.title} [${selected.status}]`,
        ...(masterTask ? [`Master ${masterTask.title} [${masterTask.status}]`] : []),
        ...(packageTask ? [`Work Package ${packageTask.title} [${packageTask.status}]`] : []),
        ...(checkpointFacts ? [checkpointFacts] : []),
      ].join("; ");
      return {
        task: { task_id: selected.task_id, title: selected.title, status: selected.status,
          ...(selected.updated_at ? { updated_at: selected.updated_at } : {}) },
        hierarchy: {
          ...(masterId ? { master_task_id: masterId } : {}),
          ...(masterTask ? { master_task_title: masterTask.title, master_task_status: masterTask.status } : {}),
          ...(packageId ? { work_package_id: packageId } : {}),
          ...(packageTask ? { work_package_title: packageTask.title, work_package_status: packageTask.status } : {}),
          summary: hierarchySummary,
          management_checkpoints: checkpoints,
        },
        documentRevisions,
        hierarchy_status: "resolved",
      };
    } catch (error) {
      if (error instanceof AdapterError && ["TASK_SEARCH_INCOMPLETE", "TASKBOARD_UNAVAILABLE", "TASKBOARD_ERROR", "TASK_NOT_FOUND", "TASK_DOCUMENT_LIMIT", "TASK_MANAGEMENT_JOURNAL_ERROR", "TASK_MANAGEMENT_JOURNAL_LIMIT"].includes(error.code))
        return { documentRevisions: [], hierarchy_status: "unavailable" };
      throw error;
    }
  }

  async close(): Promise<void> {
    this.collectorStop.abort();
    this.attachments.close();
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
        undefined,
        "write_in_progress",
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
    if (query.tail !== undefined && typeof query.tail !== "boolean")
      throw new AdapterError("INVALID_ARGUMENT", "tail must be a boolean.");
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
    if (query.tail !== undefined)
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "Activity waits require a continuation cursor, not tail.",
      );
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
      await this.adoptManagedSession(id);
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

  async archiveSession(sessionId: string): Promise<ArchiveSessionResult> {
    if (this.submissionLocks.has(sessionId))
      throw new AdapterError(
        "SESSION_BUSY",
        "The session has an MCP write in progress.",
        undefined,
        "write_in_progress",
      );
    this.submissionLocks.add(sessionId);
    this.collecting.delete(sessionId);
    try {
      await this.requireExposedSession(sessionId);
      await this.requireIdle(sessionId);
      // The legacy update endpoint records the archive timestamp; do not use
      // delete, which removes the conversation. A failed readback is uncertain.
      const time = Date.now();
      try {
        await this.client.session.update(
          {
            sessionID: sessionId,
            directory: this.runtime.project,
            time: { archived: time },
          },
          { signal: this.deadline() },
        );
        const verified = await this.requireExposedSession(
          sessionId,
          undefined,
          true,
        );
        if (verified.time.archived !== time)
          throw new Error("Archive timestamp not persisted.");
        return { session_id: sessionId, state: "archived", archived_at: time };
      } catch {
        throw new AdapterError(
          "ARCHIVE_UNCERTAIN",
          "Archive could not be confirmed. Inspect the session before another attempt; do not retry automatically.",
        );
      }
    } finally {
      this.submissionLocks.delete(sessionId);
    }
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<RenameSessionResult> {
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId.length > 256 ||
      /[\s\x00-\x1f\x7f]/u.test(sessionId) ||
      typeof title !== "string" ||
      title.length < 1 ||
      title.length > 160 ||
      /[\x00-\x1f\x7f-\x9f]/u.test(title) ||
      !title.trim()
    ) {
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "session_id must be valid and title must contain 1 to 160 characters without control characters.",
      );
    }
    const name = title.trim();
    if (this.submissionLocks.has(sessionId))
      throw new AdapterError(
        "SESSION_BUSY",
        "The session has an MCP write in progress.",
        undefined,
        "write_in_progress",
      );
    this.submissionLocks.add(sessionId);
    this.collecting.delete(sessionId);
    try {
      // External OpenCode clients do not share the adapter's per-session lock,
      // so check exposure and backend idleness immediately before the update.
      await this.requireExposedSession(sessionId);
      await this.requireIdle(sessionId);
      try {
        const response = await this.client.session.update(
          {
            sessionID: sessionId,
            directory: this.runtime.project,
            title: name,
          },
          { signal: this.deadline(), throwOnError: false },
        );
        if (response.response?.status === 404) throw sessionNotFound();
        if (response.response && !response.response.ok)
          throw new Error("OpenCode rejected the title update.");
        const verified = await this.requireExposedSession(sessionId);
        if (verified.title !== name)
          throw new Error("Renamed title was not persisted.");
        return { session_id: sessionId, title: verified.title, state: "renamed" };
      } catch (error) {
        if (error instanceof AdapterError && error.code === "SESSION_NOT_FOUND")
          throw error;
        if (httpStatus(error) === 404) throw sessionNotFound();
        throw new AdapterError(
          "RENAME_UNCERTAIN",
          "The title update could not be confirmed. Inspect get_session before deciding whether to retry.",
        );
      }
    } finally {
      this.submissionLocks.delete(sessionId);
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

  /** Internal dashboard read, never registered as an MCP tool. No admission,
   * journal writes or public exposure-filter changes. Native project directories
   * and recursively admitted parents establish worktree/child ancestry. */
  async readDashboardInventory() {
    const deadline = Date.now() + 10000;
    try { await this.compatibilityCheck(); }
    catch (error) {
      // An initial backend boot/read outage must not poison the independent
      // dashboard forever. Retry only this read probe on the next collector tick.
      this.compatibilityPromise = undefined;
      throw error;
    }
    const [identity, health] = await Promise.all([
      this.client.project.current({ directory: this.runtime.project }, { signal: this.deadline() }),
      this.client.global.health({ signal: this.deadline() }),
    ]);
    if (identity.data?.id !== this.requiredProjectId() || health.data?.healthy !== true) throw incompatible("Dashboard backend identity changed.");
    const directories = await this.client.project.directories(
      { projectID: this.requiredProjectId(), directory: this.runtime.project },
      { signal: this.deadline() },
    );
    if (!Array.isArray(directories.data)) throw incompatible("Project directories are unavailable.");
    const locations = new Set([this.runtime.project, ...directories.data.map(item => item.directory)]);
    const sessions: SessionV2Info[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    let complete = true;
    for (let page = 0; page < 11; page++) {
      if (Date.now() > deadline) { complete = false; break; }
      const response = await this.client.v2.session.list(
        { directory: this.runtime.project, project: this.requiredProjectId(), limit: 20, order: "desc", ...(cursor ? { cursor } : {}) },
        { signal: this.deadline() },
      );
      if (!Array.isArray(response.data?.data)) throw incompatible("Session inventory is unavailable.");
      sessions.push(...response.data.data);
      cursor = response.data?.cursor?.next ?? undefined;
      if (sessions.length > 200) { complete = false; break; }
      if (!cursor) break;
      if (seen.has(cursor)) throw incompatible("Repeated inventory cursor.");
      seen.add(cursor);
      if (page === 10) { complete = false; break; }
    }
    const admitted = new Map<string, SessionV2Info>();
    for (const item of sessions) {
      if (item.projectID === this.requiredProjectId() && locations.has(item.location.directory)) admitted.set(item.id, item);
    }
    for (let pass = 0; pass < sessions.length; pass++) {
      let changed = false;
      for (const item of sessions) {
        if (!admitted.has(item.id) && item.projectID === this.requiredProjectId() && item.parentID && admitted.has(item.parentID)) {
          admitted.set(item.id, item); changed = true;
        }
      }
      if (!changed) break;
    }
    if (sessions.some(item => item.projectID === this.requiredProjectId() && !admitted.has(item.id))) complete = false;
    return { sessions: [...admitted.values()].slice(0, 200), complete, observed_at: new Date().toISOString() };
  }

  async readDashboardSession(session: SessionV2Info) {
    // Revalidate identity/location against the admitted native inventory each tick.
    const current = await this.client.v2.session.get({ sessionID: session.id }, { signal: this.deadline() });
    const value = current.data?.data;
    if (!value || value.id !== session.id || value.projectID !== this.requiredProjectId() || value.location.directory !== session.location.directory || value.parentID !== session.parentID) throw sessionNotFound();
    const [activity, pending, history] = await Promise.all([this.activity(session.id, value.location.directory), this.pending(session.id), this.messages(session.id, 100, undefined, undefined, value.location.directory)]);
    if (history.items.some(item => item.info.sessionID !== session.id)) throw incompatible("Dashboard history belongs to another session.");
    const users = history.items.filter(item => item.info.role === "user");
    const allTurns = users.map(user => {
      const status = this.correlatedStatus(session.id, user.info.id, history.items, activity, pending, false);
      const assistant = history.items.filter(item => item.info.role === "assistant" && item.info.parentID === user.info.id).at(-1)?.info;
      const info = assistant?.role === "assistant" ? assistant : undefined;
      return {
        user_message_id: user.info.id, state: status.state,
        active: (status.active_assistant_message_ids?.length ?? 0) > 0,
        finish: info?.finish ?? null, completed_at: info?.time.completed ?? null,
        runtime: info ? { provider_id: info.providerID, model_id: info.modelID,
          variant: isRecord(info) && typeof info.variant === "string" ? info.variant : null,
          source: "assistant_message", message_id: info.id } : null,
      };
    });
    // Bound recent terminal detail, never discard known active/unresolved turns
    // merely because five newer user turns exist in the same 100-message window.
    const turns = allTurns.filter((turn, index) => index >= allTurns.length - 5 || turn.active || turn.state === "submitted");
    return {
      session_id: value.id, title: value.title.slice(0, 240), parent_session_id: value.parentID ?? null,
      kind: value.parentID ? "child" : value.agent === OPENLIVE_MANAGER_AGENT || value.id === await this.managerSessionId() ? "manager" : "root",
      archived: Boolean(value.time.archived), backend_activity: activity,
      pending_input: { ...pendingCounts(pending), scope: "session" },
      observed_at: new Date().toISOString(), last_activity_at: value.time.updated,
      current_runtime: value.model ? { provider_id: value.model.providerID, model_id: value.model.id,
        variant: value.model.variant ?? null, source: "session_setting" } : null,
      turns, turns_truncated: turns.length < allTurns.length, history_has_more: Boolean(history.next),
    };
  }

  async getSessionDetails(
    sessionId: string,
    includeArchived = false,
  ): Promise<SessionDetailsResult> {
    const session = await this.requireExposedSession(
      sessionId,
      undefined,
      includeArchived,
    );
    const [activity, pending] = await Promise.all([
      this.activity(sessionId),
      this.pending(sessionId),
    ]);
    return {
      ...toSummary(session, activity),
      ...(session.time.archived ? { archived_at: session.time.archived } : {}),
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
      admission: this.admissionState(sessionId),
    };
  }

  async getSessionProgress(
    sessionId: string,
    messageId?: string,
  ): Promise<SessionProgressResult> {
    await this.requireExposedSession(sessionId);
    if (
      messageId &&
      (await this.message(sessionId, messageId)).info.role !== "user"
    )
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "message_id must identify a submitted user message.",
      );
    const [activity, pending, history] = await Promise.all([
      this.activity(sessionId),
      this.pending(sessionId),
      this.messages(sessionId, STATUS_HISTORY_LIMIT),
    ]);
    const inFlight: ToolObservation[] = [];
    let lastFinished: ToolObservation | undefined;
    let lastActivity: number | undefined;
    let incomplete = false;
    let unattributed = 0;
    const identifier = (value: unknown): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\s\x00-\x1f\x7f]/u.test(value);
    const timestamp = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const observeTime = (value: unknown) => {
      const time = timestamp(value);
      if (time !== undefined)
        lastActivity = Math.max(lastActivity ?? time, time);
    };
    for (const { info, parts } of history.items) {
      if (info.sessionID !== sessionId)
        throw incompatible("OpenCode returned progress for another session.");
      const parent =
        info.role === "assistant" && identifier(info.parentID)
          ? info.parentID
          : undefined;
      const matches =
        !messageId || info.id === messageId || parent === messageId;
      if (matches) {
        observeTime(info.time.created);
        if (info.role === "assistant") observeTime(info.time.completed);
      }
      if (info.role !== "assistant") continue;
      for (const part of parts) {
        if (part.type !== "tool") continue;
        if (!parent) unattributed++;
        if (!matches) continue;
        // Deliberate allowlist: no title, arguments, output, metadata, file paths,
        // reasoning or raw error strings leave this projection.
        if (
          !identifier(info.id) ||
          !identifier(part.callID) ||
          !identifier(part.tool) ||
          !isRecord(part.state) ||
          !["pending", "running", "completed", "error"].includes(
            part.state.status,
          )
        ) {
          incomplete = true;
          continue;
        }
        const state = part.state;
        const started =
          state.status === "pending" ? undefined : timestamp(state.time?.start);
        const finished =
          state.status === "completed" || state.status === "error"
            ? timestamp(state.time?.end)
            : undefined;
        if (state.status !== "pending" && started === undefined)
          incomplete = true;
        const tool: ToolObservation = {
          message_id: info.id,
          call_id: part.callID,
          tool: part.tool,
          status: state.status,
          ...(parent ? { task_message_id: parent } : {}),
          ...(started !== undefined ? { started_at: started } : {}),
          ...(finished !== undefined ? { finished_at: finished } : {}),
        };
        observeTime(started);
        observeTime(finished);
        if (state.status === "pending" || state.status === "running")
          inFlight.push(tool);
        else if (finished === undefined) incomplete = true;
        else if (!lastFinished || finished >= lastFinished.finished_at!)
          lastFinished = tool;
      }
    }
    inFlight.sort(
      (a, b) =>
        (b.started_at ?? -1) - (a.started_at ?? -1) ||
        a.call_id.localeCompare(b.call_id),
    );
    return {
      session_id: sessionId,
      ...(messageId ? { message_id: messageId } : {}),
      observed_at: new Date().toISOString(),
      source: "backend_snapshot",
      backend_activity: activity,
      pending_input: pendingCounts(pending),
      pending_input_scope: "session",
      in_flight_tools: inFlight.slice(0, 10),
      ...(lastFinished ? { last_finished_tool: lastFinished } : {}),
      ...(lastActivity !== undefined ? { last_activity_at: lastActivity } : {}),
      idle_with_in_flight_tools: activity === "idle" && inFlight.length > 0,
      coverage: {
        message_limit: STATUS_HISTORY_LIMIT,
        messages_scanned: history.items.length,
        history_has_more: Boolean(history.next),
        in_flight_total: inFlight.length,
        in_flight_truncated: inFlight.length > 10,
        metadata_incomplete: incomplete,
        unattributed_tools: unattributed,
      },
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
        admission: this.admissionState(sessionId),
        pending_input_scope: "session",
        active_assistant_message_ids: [],
        observed_at: new Date().toISOString(),
        source: "backend",
        task_status_reason: "not_requested",
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
    const result = this.correlatedStatus(
      sessionId,
      messageId,
      messages,
      activity,
      pending,
    );
    const receiptResolution = await this.journal?.receiptResolution(
      sessionId,
      messageId,
    );
    return {
      ...result,
      admission: this.admissionState(sessionId),
      ...(receiptResolution ? { receipt_resolution: receiptResolution } : {}),
      pending_input_scope: "session",
      observed_at: new Date().toISOString(),
      source: "backend",
      ...(result.state === "unknown"
        ? {
            task_status_reason: messages.some(
              (item) => item.info.id === messageId,
            )
              ? ("non_terminal_evidence" as const)
              : ("outside_history_or_not_observed" as const),
          }
        : {}),
    };
  }

  private correlatedStatus(
    sessionId: string,
    messageId: string,
    messages: MessageWithParts[],
    activity: SessionActivity,
    pending: PendingDetails,
    retire = true,
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
    const activeAssistantIds = assistants
      .filter(
        (message) =>
          message.info.role === "assistant" &&
          (typeof message.info.time.completed !== "number" ||
            message.parts.some(
              (part) =>
                part.type === "tool" &&
                isRecord(part.state) &&
                ["pending", "running"].includes(part.state.status),
            )),
      )
      .map((message) => message.info.id);
    const latestAssistant = assistants.at(-1);
    const allErrorDetails = correlatedErrorDetails(assistants);
    const errorDetails = allErrorDetails.slice(0, MAX_CORRELATED_ERROR_DETAILS);
    const pendingForTurn =
      pending.permissionsList.some(
        (request) =>
          request.source && assistantIds.includes(request.source.messageID),
      ) ||
      pending.questionsList.some(
        (request) =>
          request.tool && assistantIds.includes(request.tool.messageID),
      );

    let state: SessionStatusResult["state"];
    if (pendingForTurn) {
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
    } else if (assistants.length === 0) {
      state = "submitted";
    } else if (activity !== "idle" && activeAssistantIds.length > 0) {
      state = "running";
    } else {
      state = "unknown";
    }

    if (retire && (state === "completed" || state === "failed" || state === "aborted")) {
      this.retireReceipt(sessionId, messageId);
      if (this.uncertainSubmissions.get(sessionId)?.messageId === messageId)
        this.uncertainSubmissions.delete(sessionId);
    }
    return {
      ...base,
      message_id: messageId,
      state,
      assistant_message_ids: assistantIds,
      active_assistant_message_ids: activeAssistantIds,
      ...(errorDetails.length
        ? {
            error_details: errorDetails,
            error_details_total: allErrorDetails.length,
            error_details_truncated:
              allErrorDetails.length > errorDetails.length,
          }
        : {}),
    };
  }

  async getSessionHistory(
    sessionId: string,
    limit = 10,
    before?: string,
    includeArchived = false,
  ): Promise<SessionHistoryResult> {
    await this.requireExposedSession(sessionId, undefined, includeArchived);
    const boundedLimit = integerInRange(limit, 1, 20, "limit");
    if (before && !isOpaqueCursor(before)) {
      throw new AdapterError("INVALID_ARGUMENT", "before cursor is invalid.");
    }
    const page = await this.messages(sessionId, boundedLimit, before);
    const visible = page.items.filter(
      (message) =>
        message.info.role === "user" || message.info.role === "assistant",
    );
    const messages = visible.map((message) =>
      describeMessage(message, this.readReferences, undefined, includeArchived),
    );
    const result = {
      session_id: sessionId,
      messages,
      ...(page.next ? { next_before: page.next } : {}),
      truncated:
        Boolean(page.next) ||
        messages.some((message) => message.text_truncated),
      history_has_more: Boolean(page.next),
    };
    try {
      fitPreviews(result, messages);
    } catch (error) {
      if (
        error instanceof AdapterError &&
        error.code === "RESPONSE_BUDGET_EXCEEDED" &&
        boundedLimit > 1
      )
        return this.getSessionHistory(
          sessionId,
          Math.floor(boundedLimit / 2),
          before,
          includeArchived,
        );
      throw error;
    }
    result.truncated ||= messages.some((message) => message.text_truncated);
    return result;
  }

  async getMessage(
    sessionId: string,
    messageId: string,
    includeArchived = false,
  ): Promise<MessageResult> {
    await this.requireExposedSession(sessionId, undefined, includeArchived);
    const message = describeMessage(
      await this.message(sessionId, messageId),
      this.readReferences,
      undefined,
      includeArchived,
    );
    return fitPreviews({ session_id: sessionId, message }, [message]);
  }

  async readMessageContent(
    reference: string,
    cursor?: string,
    maxBytes = DEFAULT_CONTENT_BYTES,
  ): Promise<MessageContentResult> {
    const maximum = integerInRange(maxBytes, 4, MAX_CONTENT_BYTES, "max_bytes");
    const ref = this.readReferences.decode<ContentReference>(
      reference,
      "content",
    );
    await this.requireExposedSession(
      ref.session,
      undefined,
      ref.archived === true,
    );
    let start = 0;
    if (cursor) {
      const position = this.readReferences.decode<
        ContentReference & { kind: "content"; offset: number }
      >(cursor, "content");
      if (
        position.session !== ref.session ||
        position.message !== ref.message ||
        position.revision !== ref.revision ||
        position.archived !== ref.archived ||
        !Number.isSafeInteger(position.offset) ||
        position.offset < 0
      ) {
        throw new AdapterError(
          "INVALID_ARGUMENT",
          "Content cursor does not belong to this reference.",
        );
      }
      start = position.offset;
    }
    let stored: MessageWithParts;
    try {
      stored = await this.message(ref.session, ref.message);
    } catch (error) {
      if (error instanceof AdapterError && error.code === "MESSAGE_NOT_FOUND")
        throw new AdapterError(
          "CONTENT_UNAVAILABLE",
          "Previously referenced message is no longer available from the source.",
        );
      throw error;
    }
    const full = visibleContent(stored).text;
    const sha256 = digest(full);
    const revision = `visible-text-v1:${sha256}`;
    if (revision !== ref.revision)
      throw new AdapterError(
        "CONTENT_CHANGED",
        "Visible text changed. Call get_message and restart reading its new revision.",
      );
    const bytes = Buffer.from(full, "utf8");
    if (
      start > bytes.length ||
      (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)
    )
      throw new AdapterError("INVALID_ARGUMENT", "Content offset is invalid.");
    let size = maximum;
    for (;;) {
      const text = utf8Prefix(bytes.subarray(start).toString("utf8"), size);
      const end = start + Buffer.byteLength(text);
      const more = end < bytes.length;
      const result: MessageContentResult = {
        session_id: ref.session,
        message_id: ref.message,
        revision,
        unit: "utf8_bytes",
        total_bytes: bytes.length,
        sha256,
        range: { start, end },
        text,
        has_more: more,
        ...(more
          ? { next_cursor: this.readReferences.encode({ ...ref, offset: end }) }
          : {}),
        content_complete: start === 0 && !more,
      };
      if (jsonBytes(result) <= READ_PAYLOAD_BYTES) return result;
      size = Math.floor(size / 2);
      if (size < 4)
        throw new AdapterError(
          "RESPONSE_BUDGET_EXCEEDED",
          "Content metadata exceeds the response budget.",
        );
    }
  }

  async getTaskResult(
    sessionId: string,
    messageId: string,
    cursor?: string,
    limit = 20,
    signal?: AbortSignal,
    includeArchived = false,
  ): Promise<TaskResult> {
    const boundedLimit = integerInRange(limit, 1, 20, "limit");
    const session = await this.requireExposedSession(
      sessionId,
      signal,
      includeArchived,
    );
    const user = await this.message(sessionId, messageId, signal);
    if (user.info.role !== "user")
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "submitted_message_id must identify a user message.",
      );
    const newest = await this.messages(sessionId, 1, undefined, signal);
    const boundary = this.resultBoundary(
      session.time.updated,
      user,
      newest.items[0],
    );
    const scan: ResultCursor = cursor
      ? this.readReferences.decode<ResultCursor>(cursor, "result")
      : {
          kind: "result",
          session: sessionId,
          user: messageId,
          boundary,
          before: "",
          assistants: 0,
          allCompleted: true,
          failed: false,
          aborted: false,
          ...(includeArchived ? { archived: true } : {}),
        };
    if (
      scan.session !== sessionId ||
      scan.user !== messageId ||
      Boolean(scan.archived) !== includeArchived
    )
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "Result cursor belongs to another query.",
      );
    if (scan.boundary !== boundary)
      throw new AdapterError(
        "SEARCH_CHANGED",
        "Session changed during result search. Restart get_task_result without a cursor.",
      );
    const page = await this.messages(
      sessionId,
      boundedLimit,
      scan.before || undefined,
      signal,
    );
    const messages: TaskResult["messages"] = [];
    let foundUser = false;
    for (const stored of [...page.items].reverse()) {
      if (stored.info.id === messageId) {
        foundUser = true;
        break;
      }
      const info = stored.info;
      const newerTurn = (scan.newerTurn ??= {
        assistantSeen: false,
        assistantCompleted: false,
        userSeen: false,
      });
      // Pages are scanned newest-to-oldest. Capture only the newest assistant
      // and user after the guarded receipt, and later require them to correlate.
      // An unresolved newer user must prevent an older completed turn from
      // being mistaken for proof that the session has moved on safely.
      if (
        info.role === "assistant" &&
        info.parentID !== messageId &&
        !newerTurn.assistantSeen
      ) {
        newerTurn.assistantSeen = true;
        newerTurn.assistantParentId = info.parentID;
        newerTurn.assistantCompleted =
          typeof info.time.completed === "number" &&
          info.finish === "stop" &&
          !hasError(info) &&
          !isAborted(info);
      } else if (info.role === "user" && !newerTurn.userSeen) {
        newerTurn.userSeen = true;
        newerTurn.userId = info.id;
      }
      if (info.role !== "assistant" || info.parentID !== messageId) continue;
      if (!scan.assistants) scan.latestFinish = info.finish;
      scan.assistants++;
      scan.allCompleted &&= typeof info.time.completed === "number";
      scan.failed ||=
        (hasError(info) && !isAborted(info)) || info.finish === "error";
      scan.aborted ||= isAborted(info);
      messages.push({
        ...describeMessage(
          stored,
          this.readReferences,
          undefined,
          includeArchived,
        ),
        result_kind:
          isCompletedFinish(info.finish) ||
          hasError(info) ||
          isAborted(info) ||
          info.finish === "error"
            ? "terminal"
            : "intermediate",
      });
    }
    // No historical snapshots: reject an observable change rather than silently
    // mixing search boundaries. Cursors are query-bound and contain only metadata.
    const verifiedSession = await this.requireExposedSession(
      sessionId,
      signal,
      includeArchived,
    );
    const verifiedHead = await this.messages(sessionId, 1, undefined, signal);
    const verifiedUser = await this.message(sessionId, messageId, signal);
    if (
      this.resultBoundary(
        verifiedSession.time.updated,
        verifiedUser,
        verifiedHead.items[0],
      ) !== boundary
    )
      throw new AdapterError(
        "SEARCH_CHANGED",
        "Session changed during result search. Restart without a cursor.",
      );
    if (!foundUser && !page.next)
      throw new AdapterError(
        "BACKEND_INCOMPATIBLE",
        "Stored user message was not reachable through backend history.",
      );
    if (!foundUser && page.next === scan.before)
      throw incompatible("OpenCode repeated a result-search cursor.");
    let state: TaskResult["state"] = "unknown";
    if (foundUser) {
      if (scan.aborted) state = "aborted";
      else if (scan.failed) state = "failed";
      else if (
        scan.assistants &&
        scan.allCompleted &&
        isCompletedFinish(scan.latestFinish)
      )
        state = "completed";
      // Session-wide busy/pending signals cannot establish this older task's state.
    }
    const supersededBy =
      state === "unknown" &&
      foundUser &&
      scan.newerTurn?.userSeen &&
      scan.newerTurn.userId &&
      scan.newerTurn.assistantSeen &&
      scan.newerTurn.assistantCompleted &&
      scan.newerTurn.assistantParentId === scan.newerTurn.userId
        ? scan.newerTurn.userId
        : undefined;
    const receiptResolution = await this.journal?.receiptResolution(
      sessionId,
      messageId,
    );
    const result: TaskResult = {
      session_id: sessionId,
      submitted_message_id: messageId,
      state,
      ...(state === "unknown"
        ? {
            state_reason: !foundUser
              ? ("search_incomplete" as const)
              : supersededBy
                ? ("superseded_by_later_completed_turn" as const)
                : scan.assistants
                  ? ("non_terminal_evidence" as const)
                  : ("no_terminal_evidence" as const),
          }
        : {}),
      ...(supersededBy ? { superseded_by_message_id: supersededBy } : {}),
      observed_at: new Date().toISOString(),
      source: "backend",
      search_complete: foundUser,
      order: "newest_first",
      messages,
      ...(receiptResolution ? { receipt_resolution: receiptResolution } : {}),
      ...(!foundUser
        ? {
            next_cursor: this.readReferences.encode({
              ...scan,
              before: page.next!,
            }),
          }
        : {}),
    };
    try {
      fitPreviews(result, messages);
      if (["completed", "failed", "aborted"].includes(state))
        this.retireReceipt(sessionId, messageId);
      return result;
    } catch (error) {
      if (
        error instanceof AdapterError &&
        error.code === "RESPONSE_BUDGET_EXCEEDED" &&
        boundedLimit > 1
      )
        return this.getTaskResult(
          sessionId,
          messageId,
          cursor,
          Math.floor(boundedLimit / 2),
          signal,
          includeArchived,
        );
      throw error;
    }
  }

  private resultBoundary(
    updated: number,
    user: MessageWithParts,
    head?: MessageWithParts,
  ): string {
    const stamp = (item: MessageWithParts | undefined) =>
      item
        ? {
            info: {
              id: item.info.id,
              role: item.info.role,
              time: item.info.time,
              ...(item.info.role === "assistant"
                ? {
                    parent: item.info.parentID,
                    finish: item.info.finish,
                    error_detail: safeAssistantErrorDetail(item.info.error),
                  }
                : {}),
            },
            visible: visibleContent(item),
          }
        : null;
    return digest(
      JSON.stringify({ updated, user: stamp(user), head: stamp(head) }),
    );
  }

  private async message(
    sessionId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<MessageWithParts> {
    let stored: MessageWithParts | undefined;
    try {
      const response = await this.client.session.message(
        {
          sessionID: sessionId,
          messageID: messageId,
          directory: this.runtime.project,
        },
        { signal: this.deadline(signal), throwOnError: false },
      );
      if (response.response?.status === 404)
        throw new AdapterError(
          "MESSAGE_NOT_FOUND",
          "Message is absent or not exposed in this session.",
        );
      if (response.response && !response.response.ok)
        throw unavailable("Could not read the stored OpenCode message.");
      stored = response.data;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (httpStatus(error) === 404)
        throw new AdapterError(
          "MESSAGE_NOT_FOUND",
          "Message is absent or not exposed in this session.",
        );
      throw unavailable("Could not read the stored OpenCode message.");
    }
    if (
      !stored ||
      stored.info?.id !== messageId ||
      stored.info.sessionID !== sessionId ||
      !["user", "assistant"].includes(stored.info.role)
    )
      throw new AdapterError(
        "MESSAGE_NOT_FOUND",
        "Message is absent or not exposed in this session.",
      );
    if (!Array.isArray(stored.parts))
      throw incompatible("OpenCode returned unsupported message content.");
    return stored;
  }

  async uploadAttachment(
    sessionId: string,
    filename: string,
    mimeType: string,
    dataBase64: string,
  ): Promise<AttachmentDescriptor> {
    await this.requireExposedSession(sessionId);
    return this.attachments.upload(sessionId, filename, mimeType, dataBase64);
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachmentIds: string[] = [],
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
        undefined,
        "write_in_progress",
      );
    }
    const uncertain = this.uncertainSubmissions.get(sessionId);
    if (
      uncertain &&
      uncertain.message === message &&
      JSON.stringify(uncertain.attachmentIds) === JSON.stringify(attachmentIds)
    ) {
      throw new AdapterError(
        "SUBMISSION_UNCERTAIN",
        "This exact prompt may already have been admitted; inspect its message_id before retrying.",
        uncertain.messageId,
      );
    }
    this.submissionLocks.add(sessionId);
    this.collecting.delete(sessionId);
    try {
      const session = await this.requireExposedSession(sessionId);
      await this.requireIdle(sessionId);
      const settings = await this.promptSettings(session);
      const initialAttachments = this.attachments.resolve(
        sessionId,
        attachmentIds,
      );
      if (
        initialAttachments.some((attachment) =>
          attachment.mime_type.startsWith("image/"),
        )
      ) {
        await this.requireImageInput(
          settings.model.providerID,
          settings.model.modelID,
        );
      }
      // Runtime lookup can race another frontend. Recheck before admission;
      // this is still not a cross-client backend transaction.
      await this.requireIdle(sessionId);
      const attachments = this.attachments.resolve(sessionId, attachmentIds);
      await this.adoptManagedSession(sessionId);
      const parts: Array<TextPartInput | FilePartInput> = [
        { type: "text", text: message },
      ];
      for (const attachment of attachments) {
        if (attachment.mime_type.startsWith("image/")) {
          parts.push({
            type: "file",
            mime: attachment.mime_type,
            filename: attachment.filename,
            url: `data:${attachment.mime_type};base64,${attachment.data.toString("base64")}`,
          });
        } else {
          parts.push({
            type: "text",
            text: `\n\n[Attachment: ${attachment.filename} (${attachment.mime_type})]\n${attachment.data.toString("utf8")}`,
          });
        }
      }
      const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
      const activityCursor = await this.journal?.track(sessionId, messageId);
      const submittedAt = new Date().toISOString();
      const submittedAttachments = attachments.map(submittedAttachment);
      this.attachments.consume(sessionId, attachments);
      // A different prompt is an explicit continuation; it ends the narrow
      // immediate-retry window for an older uncertain transport call.
      this.uncertainSubmissions.delete(sessionId);
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
            parts,
          },
          { signal: AbortSignal.timeout(this.admissionDeadlineMs) },
        );
      } catch {
        this.uncertainSubmissions.set(sessionId, {
          message,
          attachmentIds: [...attachmentIds],
          messageId,
        });
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
        ...(submittedAttachments.length
          ? { attachments: submittedAttachments }
          : {}),
      };
    } finally {
      this.submissionLocks.delete(sessionId);
    }
  }

  /**
   * Native follow-up admission into a session that is actively working.
   * OpenCode's v1 runner admits prompts while busy and serializes them as the
   * next turn of the same runner/projection (D1 probe evidence, 1.18.34); this
   * adds no adapter-side queue, retry or priority. send_message stays the sole
   * idle path and is untouched; pending input is never bypassed (v1 AND v2
   * permission/question reads, because v1-runner permissions only surface on
   * the v1 endpoint). The unresolved supersede guard deliberately stays bound
   * to the running turn's receipt.
   */
  async sendFollowup(
    sessionId: string,
    message: string,
    attachmentIds: string[] = [],
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
        undefined,
        "write_in_progress",
      );
    }
    const uncertain = this.uncertainSubmissions.get(sessionId);
    if (
      uncertain &&
      uncertain.message === message &&
      JSON.stringify(uncertain.attachmentIds) === JSON.stringify(attachmentIds)
    ) {
      throw new AdapterError(
        "SUBMISSION_UNCERTAIN",
        "This exact follow-up may already have been admitted; inspect its message_id before retrying.",
        uncertain.messageId,
      );
    }
    this.submissionLocks.add(sessionId);
    this.collecting.delete(sessionId);
    try {
      const session = await this.requireExposedSession(sessionId);
      await this.followupPreflight(sessionId);
      const settings = await this.promptSettings(session);
      const initialAttachments = this.attachments.resolve(
        sessionId,
        attachmentIds,
      );
      if (
        initialAttachments.some((attachment) =>
          attachment.mime_type.startsWith("image/"),
        )
      ) {
        await this.requireImageInput(
          settings.model.providerID,
          settings.model.modelID,
        );
      }
      // Runtime lookup can race another frontend. Recheck before admission;
      // this is still not a cross-client backend transaction.
      await this.followupPreflight(sessionId);
      const attachments = this.attachments.resolve(sessionId, attachmentIds);
      // No managed-policy adoption here: adoption is the idle work-admission
      // boundary (the policy daemon refuses a busy session with
      // MANAGED_SESSION_BUSY), while a follow-up targets a session that is
      // actively working by definition. The follow-up inherits the session's
      // current policy state; create_session/send_message remain the adoption
      // points.
      // Same parts mapping as send_message, kept separate so the send_message
      // path stays byte-identical (W1 invariant).
      const parts: Array<TextPartInput | FilePartInput> = [
        { type: "text", text: message },
      ];
      for (const attachment of attachments) {
        if (attachment.mime_type.startsWith("image/")) {
          parts.push({
            type: "file",
            mime: attachment.mime_type,
            filename: attachment.filename,
            url: `data:${attachment.mime_type};base64,${attachment.data.toString("base64")}`,
          });
        } else {
          parts.push({
            type: "text",
            text: `\n\n[Attachment: ${attachment.filename} (${attachment.mime_type})]\n${attachment.data.toString("utf8")}`,
          });
        }
      }
      const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
      const activityCursor = await this.journal?.track(sessionId, messageId);
      const submittedAt = new Date().toISOString();
      const submittedAttachments = attachments.map(submittedAttachment);
      this.attachments.consume(sessionId, attachments);
      // A different prompt is an explicit continuation; it ends the narrow
      // immediate-retry window for an older uncertain transport call.
      this.uncertainSubmissions.delete(sessionId);
      try {
        await this.client.session.promptAsync(
          {
            sessionID: sessionId,
            directory: this.runtime.project,
            messageID: messageId,
            agent: settings.agent,
            model: settings.model,
            ...(settings.variant ? { variant: settings.variant } : {}),
            parts,
          },
          { signal: AbortSignal.timeout(this.admissionDeadlineMs) },
        );
      } catch {
        this.uncertainSubmissions.set(sessionId, {
          message,
          attachmentIds: [...attachmentIds],
          messageId,
        });
        throw new AdapterError(
          "SUBMISSION_UNCERTAIN",
          "OpenCode did not confirm whether the follow-up was admitted; do not retry automatically.",
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
              "[mcp] activity persistence failed after follow-up admission\n",
            );
          });
      }
      return {
        session_id: sessionId,
        message_id: messageId,
        state: "submitted",
        submitted_at: submittedAt,
        ...(activityCursor ? { activity_cursor: activityCursor } : {}),
        ...(submittedAttachments.length
          ? { attachments: submittedAttachments }
          : {}),
      };
    } finally {
      this.submissionLocks.delete(sessionId);
    }
  }

  /**
   * Abort the active turn through OpenCode's native v1 abort, then verify the
   * outcome through existing stored reads. Acceptance is never treated as
   * confirmation: only a stored aborted assistant message proves the abort.
   * No rollback is performed or promised; already-executed changes remain.
   * Queued follow-ups survive a native abort and may still execute (D1/D2
   * probe evidence). Idle sessions short-circuit to a non-destructive
   * no_active_turn without a backend write.
   */
  async abortSessionTurn(sessionId: string): Promise<AbortSessionTurnResult> {
    await this.requireExposedSession(sessionId);
    const preflightActivity = await this.activity(sessionId);
    if (preflightActivity === "idle") {
      const pendingNow = await this.combinedPending(sessionId);
      const observed = new Date().toISOString();
      return {
        session_id: sessionId,
        state: "no_active_turn",
        observed_at: observed,
        activity_after: await this.activity(sessionId),
        pending_input_after: pendingNow,
        guidance:
          "No active turn was observed, so nothing was aborted. This is a non-destructive result and not a task failure; no changes were rolled back.",
      };
    }
    const before = await this.messages(sessionId, 12);
    const sawAbortedMarker = [...before.items]
      .reverse()
      .find((item) => item.info.role === "assistant")
      ?.info;
    const preexistingAbort =
      sawAbortedMarker && isAborted(sawAbortedMarker)
        ? sawAbortedMarker.id
        : undefined;
    await this.backendCall(
      () =>
        this.client.session.abort(
          { sessionID: sessionId, directory: this.runtime.project },
          { signal: this.deadline() },
        ),
      "Could not request the OpenCode turn abort.",
    );
    const deadline = Date.now() + this.abortVerifyBudgetMs;
    let lastActivity: SessionActivity = preflightActivity;
    let lastPending = await this.combinedPending(sessionId);
    let abortedId: string | undefined;
    let racedTerminal = false;
    while (Date.now() < deadline) {
      const [page, activityNow, pendingNow] = await Promise.all([
        this.messages(sessionId, 12),
        this.activity(sessionId),
        this.combinedPending(sessionId),
      ]);
      lastActivity = activityNow;
      lastPending = pendingNow;
      const newest = [...page.items]
        .reverse()
        .find((item) => item.info.role === "assistant")?.info;
      if (newest && isAborted(newest) && newest.id !== preexistingAbort) {
        abortedId = newest.id;
        break;
      }
      if (
        newest &&
        newest.role === "assistant" &&
        !isAborted(newest) &&
        activityNow === "idle" &&
        (isCompletedFinish(newest.finish) || hasError(newest))
      ) {
        // The running turn reached its own terminal state before abort
        // evidence appeared. Never claim it was aborted or that it passed.
        racedTerminal = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, this.abortVerifyPollMs));
    }
    const observed = new Date().toISOString();
    if (abortedId) {
      return {
        session_id: sessionId,
        state: "aborted",
        aborted_message_id: abortedId,
        observed_at: observed,
        activity_after: lastActivity,
        pending_input_after: lastPending,
        guidance:
          "Turn abort verified through the stored aborted assistant message. Already-executed changes remain; nothing was rolled back. Already admitted follow-ups are not discarded; OpenCode drains them with the next admitted prompt.",
      };
    }
    return {
      session_id: sessionId,
      state: "abort_uncertain",
      observed_at: observed,
      activity_after: lastActivity,
      pending_input_after: lastPending,
      guidance: racedTerminal
        ? "The newest assistant turn reached its own terminal state before abort evidence appeared; the abort request may have arrived after completion. Inspect get_session_status or get_task_result for the exact message state; do not treat this as an aborted or completed task."
        : "The abort request was accepted but its effect could not be verified within the bounded window. Do not treat the turn as aborted or completed; re-check get_session_status before any follow-up submission.",
    };
  }

  private async followupPreflight(sessionId: string): Promise<void> {
    const [activity, pending] = await Promise.all([
      this.activity(sessionId),
      this.combinedPending(sessionId),
    ]);
    if (pending.permissions + pending.questions > 0)
      throw new AdapterError(
        "INPUT_REQUIRED",
        "The session has pending input. Resolve it in OpenCode Web UI/TUI; the follow-up was not admitted.",
        undefined,
        "pending_input",
      );
    if (activity !== "busy" && activity !== "retry")
      throw new AdapterError(
        "SESSION_NOT_BUSY",
        "The backend session is idle; use send_message to start a new task. A follow-up requires a session that is actively working.",
      );
  }

  /**
   * v1-runner permission requests only surface on the v1 endpoint (D1/D2
   * probe evidence, 1.18.34), so pending detection for the session-control
   * paths combines both permission surfaces. Existing v2-only reads stay
   * untouched.
   */
  async getCombinedPendingInput(sessionId: string): Promise<PendingInput> {
    await this.requireExposedSession(sessionId);
    return this.combinedPending(sessionId);
  }

  private async combinedPending(sessionId: string): Promise<PendingInput> {
    const [pending, v1Permissions] = await Promise.all([
      this.pending(sessionId),
      this.pendingV1PermissionCount(sessionId),
    ]);
    return {
      permissions: pending.permissions + v1Permissions,
      questions: pending.questions,
    };
  }

  private async pendingV1PermissionCount(sessionId: string): Promise<number> {
    const response = await this.backendCall(
      () =>
        this.client.permission.list(
          { directory: this.runtime.project },
          { signal: this.deadline() },
        ),
      "Could not read pending OpenCode permissions.",
    );
    if (!Array.isArray(response.data)) {
      throw incompatible("OpenCode returned unsupported permission data.");
    }
    return response.data.filter(
      (entry) =>
        isRecord(entry) &&
        (entry.sessionID === undefined || entry.sessionID === sessionId),
    ).length;
  }

  async supersedeUnresolvedSubmission(
    input: SubmissionGuardOverrideInput,
  ): Promise<SubmissionGuardOverrideResult> {
    const {
      sessionId,
      guardedMessageId,
      operatorAuthorized,
      message,
      attachmentIds = [],
    } = input;
    const requestId = input.requestId.toLowerCase();
    const reason = input.reason?.trim();
    if (
      operatorAuthorized !== true ||
      !sessionId ||
      sessionId.length > 256 ||
      /[\s\x00-\x1f\x7f]/u.test(sessionId) ||
      !guardedMessageId ||
      guardedMessageId.length > 256 ||
      /[\s\x00-\x1f\x7f]/u.test(guardedMessageId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        requestId,
      ) ||
      message.length < 1 ||
      message.length > 32_000 ||
      (input.reason !== undefined &&
        (!reason || reason.length > 500 || /[\x00-\x1f\x7f]/u.test(reason))) ||
      attachmentIds.length > 32
    ) {
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "A valid session, guarded message, UUID request_id, explicit operator_authorized=true, message, and optional short reason are required.",
      );
    }

    await this.requireExposedSession(sessionId);
    const journal = this.requireJournal();
    const fingerprint = digest(
      JSON.stringify({
        sessionId,
        guardedMessageId,
        requestId,
        reason: reason ?? null,
        message,
        attachmentIds,
      }),
    );
    const replay = async (
      record: NonNullable<
        Awaited<ReturnType<ActivityJournal["guardOverride"]>>
      >,
    ) => {
      if (record.fingerprint !== fingerprint)
        throw new AdapterError(
          "SUBMISSION_GUARD_CONFLICT",
          "This request_id is already bound to a different guard override request.",
        );
      if (record.state === "submitted" && record.result)
        return structuredClone(record.result);
      throw new AdapterError(
        "SUBMISSION_UNCERTAIN",
        "This guard override request may already have reached OpenCode. Inspect its new message_id; do not retry with a new request_id.",
        record.message_id,
      );
    };
    const existing = await journal.guardOverride(requestId);
    if (existing) return replay(existing);

    if (this.submissionLocks.has(sessionId))
      throw new AdapterError(
        "SESSION_BUSY",
        "The session has an MCP write in progress.",
        guardedMessageId,
        "write_in_progress",
      );
    this.submissionLocks.add(sessionId);
    this.collecting.delete(sessionId);
    try {
      const session = await this.requireExposedSession(sessionId);
      const alreadyRecorded = await journal.guardOverride(requestId);
      if (alreadyRecorded) return replay(alreadyRecorded);
      if (this.unresolved.get(sessionId) !== guardedMessageId)
        throw staleGuard();

      if (this.unresolved.get(sessionId) !== guardedMessageId)
        throw staleGuard();

      let preflight = await this.submissionGuardSnapshot(
        sessionId,
        guardedMessageId,
      );
      const settings = await this.promptSettings(session);
      const attachments = this.attachments.resolve(sessionId, attachmentIds);
      if (
        attachments.some((attachment) =>
          attachment.mime_type.startsWith("image/"),
        )
      ) {
        await this.requireImageInput(
          settings.model.providerID,
          settings.model.modelID,
        );
      }
      // Recheck the exact guard and all live admission signals immediately before
      // the write-ahead audit record and the one backend admission attempt.
      if (this.unresolved.get(sessionId) !== guardedMessageId)
        throw staleGuard();
      preflight = await this.submissionGuardSnapshot(
        sessionId,
        guardedMessageId,
      );

      await this.adoptManagedSession(sessionId);

      const parts: Array<TextPartInput | FilePartInput> = [
        { type: "text", text: message },
      ];
      for (const attachment of attachments) {
        if (attachment.mime_type.startsWith("image/")) {
          parts.push({
            type: "file",
            mime: attachment.mime_type,
            filename: attachment.filename,
            url: `data:${attachment.mime_type};base64,${attachment.data.toString("base64")}`,
          });
        } else {
          parts.push({
            type: "text",
            text: `\n\n[Attachment: ${attachment.filename} (${attachment.mime_type})]\n${attachment.data.toString("utf8")}`,
          });
        }
      }
      const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
      const prepared = await journal.prepareGuardOverride({
        request_id: requestId,
        fingerprint,
        session_id: sessionId,
        session_title: session.title,
        guarded_message_id: guardedMessageId,
        message_id: messageId,
        ...(reason ? { reason } : {}),
        preflight,
      });
      if (!prepared.created) return replay(prepared.record);

      this.attachments.consume(sessionId, attachments);
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
            parts,
          },
          { signal: AbortSignal.timeout(this.admissionDeadlineMs) },
        );
      } catch {
        throw new AdapterError(
          "SUBMISSION_UNCERTAIN",
          "OpenCode did not confirm whether the superseding message was admitted; inspect its message_id and do not retry automatically.",
          messageId,
        );
      }

      const result: SubmissionGuardOverrideResult = {
        session_id: sessionId,
        guarded_message_id: guardedMessageId,
        request_id: requestId,
        message_id: messageId,
        state: "submitted",
        resolution: "superseded_by_operator",
        superseded_at: prepared.record.superseded_at,
        submitted_at: new Date().toISOString(),
        authorization_source: "operator_asserted",
        preflight,
        activity_cursor: prepared.record.activity_cursor,
        ...(attachments.length
          ? { attachments: attachments.map(submittedAttachment) }
          : {}),
      };
      await journal
        .completeGuardOverride(requestId, session.title, result)
        .catch(() => {
          this.tracking.partial = true;
          process.stderr.write(
            "[mcp] activity persistence failed after guard override admission\n",
          );
        });
      return result;
    } finally {
      this.submissionLocks.delete(sessionId);
    }
  }

  private async submissionGuardSnapshot(
    sessionId: string,
    guardedMessageId: string,
  ): Promise<SubmissionGuardSnapshot> {
    const [status, progress] = await Promise.all([
      this.getSessionStatus(sessionId, guardedMessageId),
      this.getSessionProgress(sessionId),
    ]);
    if (this.unresolved.get(sessionId) !== guardedMessageId) throw staleGuard();
    if (
      status.backend_activity !== progress.backend_activity ||
      JSON.stringify(status.pending_input) !==
        JSON.stringify(progress.pending_input)
    )
      throw new AdapterError(
        "SUBMISSION_GUARD_CONFLICT",
        "Session activity changed during override inspection. Read the current guard and retry only after review.",
        guardedMessageId,
      );
    this.assertIdle(
      status.backend_activity,
      status.pending_input,
      guardedMessageId,
    );
    if (
      status.active_assistant_message_ids?.length ||
      progress.coverage.in_flight_total > 0 ||
      progress.coverage.metadata_incomplete
    )
      throw new AdapterError(
        "SESSION_BUSY",
        "Stored active assistant/tool evidence prevents superseding this guard. Inspect the session before proceeding.",
        guardedMessageId,
        "backend_active",
      );
    return {
      observed_at: new Date().toISOString(),
      backend_activity: status.backend_activity,
      active_assistant_message_ids: status.active_assistant_message_ids ?? [],
      in_flight_tools: progress.in_flight_tools,
      pending_input: status.pending_input,
      guarded_message_id: guardedMessageId,
      guarded_receipt_state: status.state,
      ...(progress.last_activity_at !== undefined
        ? { last_activity_at: progress.last_activity_at }
        : {}),
      coverage: progress.coverage,
    };
  }

  private async requireImageInput(
    providerId: string,
    modelId: string,
  ): Promise<void> {
    const response = await this.backendCall(
      () =>
        this.client.v2.model.list(
          { location: { directory: this.runtime.project } },
          { signal: this.deadline() },
        ),
      "Could not verify the selected model's image-input support.",
    );
    const model = response.data?.data?.find(
      (candidate) =>
        candidate.providerID === providerId && candidate.id === modelId,
    );
    if (!model?.capabilities?.input?.includes("image")) {
      throw new AdapterError(
        "MODEL_DOES_NOT_SUPPORT_ATTACHMENT_TYPE",
        "The session's selected model is not confirmed to support image input; choose an image-capable model before submitting this attachment.",
      );
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
    signal?: AbortSignal,
    includeArchived = false,
  ): Promise<SessionV2Info> {
    await this.compatibilityCheck();
    let session: SessionV2Info | undefined;
    try {
      const response = await this.client.v2.session.get(
        { sessionID: sessionId },
        { signal: this.deadline(signal), throwOnError: false },
      );
      if (response.response?.status === 404) throw sessionNotFound();
      if (response.response && !response.response.ok)
        throw unavailable("Could not inspect the OpenCode session.");
      session = response.data?.data;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (httpStatus(error) === 404) throw sessionNotFound();
      throw unavailable("Could not inspect the OpenCode session.");
    }
    if (
      !session ||
      session.id !== sessionId ||
      !(await this.isExposedSession(session, undefined, includeArchived))
    )
      throw sessionNotFound();
    return session;
  }

  private async isExposedSession(
    session: SessionV2Info,
    knownManagerId?: string,
    includeArchived = false,
  ): Promise<boolean> {
    const managerId = knownManagerId ?? (await this.managerSessionId());
    return (
      session.projectID === this.requiredProjectId() &&
      session.location.directory === this.runtime.project &&
      !session.parentID &&
      (includeArchived || !session.time.archived) &&
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

  private async activities(directory = this.runtime.project): Promise<Map<string, SessionActivity>> {
    const response = await this.backendCall(
      () =>
        this.client.session.status(
          { directory },
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

  private async activity(sessionId: string, directory = this.runtime.project): Promise<SessionActivity> {
    return (await this.activities(directory)).get(sessionId) ?? "idle";
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
    signal?: AbortSignal,
    directory = this.runtime.project,
  ): Promise<MessagePage> {
    let response: Awaited<ReturnType<OpenCodeClient["session"]["messages"]>>;
    try {
      response = await this.client.session.messages(
        {
          sessionID: sessionId,
          directory,
          limit,
          ...(before ? { before } : {}),
        },
        { signal: this.deadline(signal), throwOnError: false },
      );
      if (before && response.response?.status === 400)
        throw new AdapterError("INVALID_ARGUMENT", "before cursor is invalid.");
      if ((response.response?.status ?? 0) >= 400)
        throw unavailable("Could not read OpenCode session history.");
    } catch (error) {
      if (error instanceof AdapterError) throw error;
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
    // Receipt uncertainty belongs to the old request, not to the session. Only
    // current backend activity and pending input can prevent a new prompt.
    const [activity, pending] = await Promise.all([
      this.activity(id),
      this.pending(id),
    ]);
    this.assertIdle(activity, pending);
  }

  private admissionState(id: string): AdmissionState {
    const receipt = this.unresolved.get(id);
    return {
      write_in_progress: this.submissionLocks.has(id),
      ...(receipt ? { guarded_message_id: receipt } : {}),
    };
  }

  private retireReceipt(id: string, receipt: string): void {
    if (this.unresolved.get(id) !== receipt) return;
    this.unresolved.delete(id);
  }

  private assertIdle(
    activity: SessionActivity,
    pending: PendingInput,
    receipt?: string,
  ): void {
    if (pending.permissions + pending.questions > 0)
      throw new AdapterError(
        "INPUT_REQUIRED",
        "The session has pending input. Resolve it in OpenCode Web UI/TUI; the requested operation was not admitted.",
        receipt,
        "pending_input",
      );
    if (activity !== "idle")
      throw new AdapterError(
        "SESSION_BUSY",
        "The backend session is busy or retrying. The requested operation was not admitted.",
        receipt,
        "backend_active",
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
      messages: [...ids].map((messageId) => {
        const details = correlatedErrorDetails(history.items.filter((item) =>
          item.info.role === "assistant" && item.info.parentID === messageId));
        return {
          ...this.correlatedStatus(id, messageId, history.items, activity, pending),
          ...(details.length ? { error_evidence_revision: digest(JSON.stringify(details)) } : {}),
        };
      }),
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
      if (this.collecting.get(id) === marker && !this.submissionLocks.has(id)) {
        const changed = await this.journal.observe(snapshot, source);
        if (changed) await this.processPendingAttention();
      }
    } catch (error) {
      if (!(
        error instanceof AdapterError && error.code === "SESSION_NOT_FOUND"
      ))
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
            if (!(
              error instanceof AdapterError &&
              error.code === "SESSION_NOT_FOUND"
            ))
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
        await this.processPendingAttention();
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

  private deadline(extra?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      AbortSignal.timeout(this.backendDeadlineMs),
      this.collectorStop.signal,
      ...(extra ? [extra] : []),
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

function relationId(text: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const expression = new RegExp(`^\\s*${key}\\s*[:=]\\s*(task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\\s*$`, "imu");
    const match = expression.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function relationField(text: string, key: string): string | undefined {
  const expression = new RegExp(`^\\s*${key}\\s*[:=]\\s*(.{1,200})\\s*$`, "imu");
  const match = expression.exec(text);
  return match?.[1] ? sanitizeSummary(match[1]).slice(0, 160).trim() : undefined;
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

function correlatedErrorDetails(
  assistants: MessageWithParts[],
): CorrelatedErrorDetail[] {
  const details: CorrelatedErrorDetail[] = [];
  for (const message of assistants) {
    if (message.info.role !== "assistant") continue;
    const detail = safeAssistantErrorDetail(message.info.error);
    if (!detail) continue;
    details.push({
      ...detail,
      assistant_message_id: message.info.id,
      attribution: "exact_parent",
    });
  }
  return details;
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

function staleGuard(): AdapterError {
  return new AdapterError(
    "SUBMISSION_GUARD_CONFLICT",
    "The guarded receipt is no longer the exact active admission guard. Read the current session guard before any new override request.",
  );
}

function unavailable(message: string): AdapterError {
  return new AdapterError("BACKEND_UNAVAILABLE", message);
}

function incompatible(message: string): AdapterError {
  return new AdapterError("BACKEND_INCOMPATIBLE", message);
}
