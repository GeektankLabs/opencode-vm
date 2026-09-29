import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { READ_PAYLOAD_BYTES, utf8Prefix, jsonBytes } from "./content.js";
import type { RuntimeDescriptor } from "./types.js";
import { AdapterError } from "./types.js";

type TaskLink = { session_id: string; message_id?: string; result?: string; artifact_refs?: string[] };
export type DocumentRole = "compact_context" | "concept_plan" | "concept_detail";
type TaskDocument = { role: DocumentRole; path: string };
type BackendProject = { id: string; name: string; prefix: string; status: string };
type BackendSubtask = { id: string; title: string; completed: boolean; position: number };
type Transfer = {
  request_id: string;
  task_id: string;
  source_board_project_id: string;
  target_board_project_id: string;
  target_backend_project_id: string;
  source: BackendTask;
  source_key: string;
  source_links: number;
  source_comments: number;
  stage_backend_id?: string;
  stage_key?: string;
  pending_step?: "creating" | "subtask_creating" | "subtask_toggling" | "deleting" | "activating";
  state: "prepared" | "creating" | "staged" | "subtask_creating" | "subtask_toggling" | "deleting" | "remapping" | "activating" | "completed" | "aborted" | "unresolved";
  subtask_index?: number;
};

type Metadata = {
  schema: 3;
  projects: Record<string, { backend_id: string }>;
  tasks: Record<string, { backend_id: string; project_id: string; scope: string }>;
  comments: Record<string, Array<{ id: string; body: string; created_at: string }>>;
  links: Record<string, TaskLink[]>;
  transfers: Record<string, Transfer>;
  documents: Record<string, TaskDocument[]>;
};

type BackendTask = {
  id: string;
  projectId: string;
  projectPrefix?: string;
  number?: number;
  teamId?: string | null;
  dueDate?: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
  labels?: Array<{ id: string }>;
  subtasks?: BackendSubtask[];
  blockedBy?: string[];
};

type PublicBoardProject = {
  board_project_id: string;
  name: string;
  prefix: string;
  status: string;
  is_default: boolean;
};

type PublicTask = {
  task_id: string;
  project_id: string;
  board_project_id: string;
  scope: "project-local";
  title: string;
  description: string;
  status: string;
  priority: string;
  position?: number;
  created_at?: string;
  updated_at?: string;
  comments: Array<{ id: string; body: string; created_at: string }>;
  session_ids: string[];
  links?: TaskLink[];
  documents?: TaskDocument[];
};

// The upstream v0.6.0 list endpoint has no pagination or query. Fail rather than
// infer absence from a partial scan or exceed the MCP response budget.
export const TASK_SCAN_LIMIT = 500;
export const TASK_RESULT_LIMIT = 50;
const MAX_BOARD_RESPONSE_BYTES = 1024 * 1024;
const MAX_TASK_OUTPUT_BYTES = 40_000;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_DOCUMENT_DETAILS = 16;
const DOCUMENT_ROLES = ["compact_context", "concept_plan", "concept_detail"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function metadataError(): AdapterError {
  return new AdapterError("TASKBOARD_METADATA_ERROR", "Project task metadata is invalid or unavailable; its write was not confirmed.");
}

function searchIncomplete(): AdapterError {
  return new AdapterError("TASK_SEARCH_INCOMPLETE", "Project task scan or result exceeds its limit; completeness is not established.");
}

function parseMetadata(value: unknown): Metadata {
  if (!record(value) || (value.schema !== 1 && value.schema !== 2 && value.schema !== 3) ||
      !record(value.projects) || !record(value.tasks) ||
      !record(value.comments) || !record(value.links)) throw metadataError();
  if (value.schema !== 1 && !record(value.transfers)) throw metadataError();
  if (value.schema === 3 && !record(value.documents)) throw metadataError();
  for (const mapping of Object.values(value.projects)) {
    if (!record(mapping) || typeof mapping.backend_id !== "string") throw metadataError();
  }
  for (const mapping of Object.values(value.tasks)) {
    if (!record(mapping) || typeof mapping.backend_id !== "string" ||
        typeof mapping.project_id !== "string" || mapping.scope !== "project-local") throw metadataError();
  }
  for (const comments of Object.values(value.comments)) {
    if (!Array.isArray(comments) || comments.some((item) => !record(item) ||
        typeof item.id !== "string" || typeof item.body !== "string" || typeof item.created_at !== "string")) throw metadataError();
  }
  for (const links of Object.values(value.links)) {
    if (!Array.isArray(links) || links.some((item) => !record(item) ||
        typeof item.session_id !== "string" ||
        (item.message_id !== undefined && typeof item.message_id !== "string") ||
        (item.result !== undefined && typeof item.result !== "string") ||
        (item.artifact_refs !== undefined && (!Array.isArray(item.artifact_refs) ||
          item.artifact_refs.some((ref: unknown) => typeof ref !== "string"))))) throw metadataError();
  }
  const transfers = value.schema === 1 ? {} : value.transfers;
  for (const [requestId, transfer] of Object.entries(transfers as Record<string, unknown>)) {
    if (!record(transfer) || transfer.request_id !== requestId ||
        typeof transfer.task_id !== "string" || !record(transfer.source) ||
        typeof transfer.source.id !== "string" || typeof transfer.source_board_project_id !== "string" ||
        typeof transfer.target_board_project_id !== "string" || typeof transfer.target_backend_project_id !== "string" ||
        !["prepared", "creating", "staged", "subtask_creating", "subtask_toggling", "deleting", "remapping",
          "activating", "completed", "aborted", "unresolved"].includes(String(transfer.state))) throw metadataError();
  }
  const documents = value.schema === 3 ? value.documents : {};
  for (const [taskId, entries] of Object.entries(documents as Record<string, unknown>)) {
    if (!/^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(taskId) ||
        !Array.isArray(entries) || entries.length > MAX_DOCUMENT_DETAILS + 2 ||
        entries.some((item) => !record(item) || !DOCUMENT_ROLES.includes(String(item.role)) ||
          typeof item.path !== "string" || !validDocumentPath(taskId, item.role as DocumentRole, item.path)) ||
        entries.filter((item) => item.role === "compact_context").length > 1 ||
        entries.filter((item) => item.role === "concept_plan").length > 1 ||
        new Set(entries.map((item) => item.path)).size !== entries.length) throw metadataError();
  }
  return { ...value, schema: 3, transfers, documents } as Metadata;
}

const emptyMetadata = (): Metadata => ({
  schema: 3,
  projects: {},
  tasks: {},
  comments: {},
  links: {},
  transfers: {},
  documents: {},
});

// Deliberate role-bound directories/names, not a general path-based repo reader.
function validDocumentPath(taskId: string, role: DocumentRole, path: string): boolean {
  if (path.length > 512 || path.includes("\\") || path.includes("\0") || path.includes("..") ||
      !/^[A-Za-z0-9_./-]+$/u.test(path)) return false;
  if (role === "compact_context") return path === `.opencode/tasks/task-${taskId}.compact.md` ||
    path === `.opencode/tasks/${taskId}.compact.md`;
  if (role === "concept_plan") return path === `planning/task-concepts/${taskId}-concept-plan.md`;
  return path.startsWith(`planning/task-concepts/${taskId}-`) &&
    path !== `planning/task-concepts/${taskId}-concept-plan.md` &&
    /^[-a-z0-9]+\.md$/u.test(path.slice(`planning/task-concepts/${taskId}-`.length));
}

type TaskboardRuntime = RuntimeDescriptor & {
  taskboardUrl: string;
  taskboardMetadataFile: string;
};

export class ProjectBoardService {
  constructor(private readonly runtime: TaskboardRuntime) {}

  async listBoardProjects(): Promise<PublicBoardProject[]> {
    const metadata = await this.loadMetadata();
    const projects = await this.projects(metadata);
    return projects.map((project) => ({ board_project_id: this.boardId(project.id, metadata),
      name: project.name, prefix: project.prefix, status: project.status,
      is_default: this.boardId(project.id, metadata) === this.projectId() }));
  }

  async getBoardProject(id: string): Promise<PublicBoardProject> {
    const projects = await this.listBoardProjects();
    const found = projects.find((project) => project.board_project_id === id);
    if (!found) throw new AdapterError("BOARD_PROJECT_NOT_FOUND", "Board Project was not found in this repository.");
    return found;
  }

  async createBoardProject(input: { name: string; prefix: string; makeDefault?: boolean }): Promise<PublicBoardProject> {
    return this.withMetadataLock(async () => {
      const metadata = await this.loadMetadata();
      this.requireNoPendingTransfer(metadata);
      const projects = await this.projects(metadata);
      const prefix = input.prefix.toUpperCase();
      if (input.makeDefault && (input.name !== "Inbox" || prefix !== "INBOX")) {
        throw new AdapterError("BOARD_PROJECT_CONFLICT", "The confirmed default must be Inbox (INBOX).");
      }
      if (input.makeDefault && await this.getProject(undefined, metadata)) {
        throw new AdapterError("BOARD_PROJECT_CONFLICT", "A default Board Project already exists; choose its disposition explicitly.");
      }
      const existing = projects.find((project) => project.prefix === prefix);
      if (existing && (!input.makeDefault || existing.name !== "Inbox")) {
        throw new AdapterError("BOARD_PROJECT_CONFLICT", "Board Project prefix is already in use; no Project was renamed or created.");
      }
      const row = existing ?? await this.request<BackendProject>("/api/projects", {
        method: "POST", body: { name: input.name, prefix, description: "OpenCode VM workstream" },
      });
      const id = input.makeDefault ? this.projectId() : this.boardId(row.id, metadata);
      metadata.projects[id] = { backend_id: row.id };
      await this.saveMetadata(metadata);
      return { board_project_id: id, name: row.name, prefix: row.prefix, status: row.status,
        is_default: input.makeDefault === true };
    });
  }

  async listTasks(input: {
    projectId?: string;
    boardProjectId?: string;
    status?: string;
    query?: string;
    sessionId?: string;
    updatedSince?: string;
    includeTerminal?: boolean;
  } = {}): Promise<PublicTask[]> {
    const metadata = await this.loadMetadata();
    this.requireNoPendingTransfer(metadata);
    if (input.projectId && input.boardProjectId && input.projectId !== input.boardProjectId) {
      throw new AdapterError("BOARD_PROJECT_CONFLICT", "Board Project selectors disagree.");
    }
    const project = (input.projectId || input.boardProjectId)
      ? await this.getProject(input.boardProjectId ?? input.projectId, metadata) : undefined;
    const rows = await this.scanTasks(project?.backend_id, input.status);
    const projects = await this.projects(metadata);
    if (rows.some((row) => !projects.some((candidate) => candidate.id === row.projectId))) {
      throw new AdapterError("TASKBOARD_ERROR", "Taskboard returned a ticket outside this repository board.");
    }
    const query = input.query?.toLowerCase();
    const since = input.updatedSince === undefined ? undefined : Date.parse(input.updatedSince);
    const tasks = rows.filter((row) =>
      (!query || row.title.toLowerCase().includes(query) || (row.description ?? "").toLowerCase().includes(query)) &&
      (input.includeTerminal !== false || row.status !== "done") &&
      (since === undefined || (row.updatedAt !== undefined && Date.parse(row.updatedAt) >= since)) &&
      (!input.sessionId || (metadata.links[this.taskId(row.id, metadata)] ?? [])
        .some((link) => link.session_id === input.sessionId)),
    ).map((row) => this.publicTask(row, metadata));
    if (tasks.length > TASK_RESULT_LIMIT || Buffer.byteLength(JSON.stringify({ tasks }), "utf8") > MAX_TASK_OUTPUT_BYTES) {
      throw searchIncomplete();
    }
    return tasks;
  }

  async getTask(taskId: string): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    this.requireNoPendingTransfer(metadata);
    const row = await this.resolveTask(taskId, metadata);
    const task = this.publicTask(row, metadata, true);
    if (Buffer.byteLength(JSON.stringify(task), "utf8") > MAX_TASK_OUTPUT_BYTES) throw searchIncomplete();
    return task;
  }

  async registerDocument(taskId: string, role: DocumentRole, path: string, expectedPath?: string) {
    return this.withMetadataLock(async () => {
      const metadata = await this.loadMetadata();
      this.requireNoPendingTransfer(metadata);
      const row = await this.resolveTask(taskId, metadata);
      if (!validDocumentPath(taskId, role, path)) throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document path is not allowed for this role.");
      await this.documentBytes(taskId, path);
      const entries = metadata.documents[taskId] ?? [];
      const current = role === "concept_detail"
        ? entries.find((item) => item.role === role && item.path === expectedPath)
        : entries.find((item) => item.role === role);
      if (expectedPath !== undefined && current?.path !== expectedPath) {
        throw new AdapterError("TASK_DOCUMENT_CONFLICT", "Expected task document reference changed.");
      }
      if (entries.some((item) => item.path === path && item.role !== role) ||
          (role !== "concept_detail" && current && current.path !== path && expectedPath === undefined)) {
        throw new AdapterError("TASK_DOCUMENT_CONFLICT", "Task document role already refers to another path.");
      }
      if (role === "concept_detail" && !current && !entries.some((item) => item.path === path) &&
          entries.filter((item) => item.role === role).length >= MAX_DOCUMENT_DETAILS) {
        throw new AdapterError("TASK_DOCUMENT_LIMIT", "Task concept detail reference limit reached.");
      }
      const updated = current ? entries.map((item) => item === current ? { role, path } : item) :
        entries.some((item) => item.path === path) ? entries : [...entries, { role, path }];
      if (new Set(updated.map((item) => item.path)).size !== updated.length) {
        throw new AdapterError("TASK_DOCUMENT_CONFLICT", "Task document path is already registered.");
      }
      metadata.tasks[taskId] = { backend_id: row.id, project_id: this.boardId(row.projectId, metadata), scope: "project-local" };
      metadata.documents[taskId] = updated;
      await this.saveMetadata(metadata);
      return { task_id: taskId, documents: updated };
    });
  }

  async getDocuments(taskId: string) {
    const metadata = await this.loadMetadata();
    this.requireNoPendingTransfer(metadata);
    await this.resolveTask(taskId, metadata);
    const documents = [];
    for (const ref of metadata.documents[taskId] ?? []) {
      try {
        const bytes = await this.documentBytes(taskId, ref.path);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        documents.push({ ...ref, state: "available" as const, total_bytes: bytes.length,
          sha256, revision: `task-file-v1:${sha256}` });
      } catch (error) {
        if (!(error instanceof AdapterError) || error.code !== "TASK_DOCUMENT_MISSING") throw error;
        documents.push({ ...ref, state: "missing" as const });
      }
    }
    return { task_id: taskId, documents };
  }

  async readDocument(taskId: string, role: DocumentRole, path?: string, offset = 0, maxBytes = 8192, revision?: string) {
    if (path !== undefined && !validDocumentPath(taskId, role, path)) {
      throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document path is not allowed for this role.");
    }
    const metadata = await this.loadMetadata();
    this.requireNoPendingTransfer(metadata);
    await this.resolveTask(taskId, metadata);
    const matches = (metadata.documents[taskId] ?? []).filter((item) => item.role === role &&
      (path === undefined || item.path === path));
    if (!matches.length) throw new AdapterError("TASK_DOCUMENT_REF_NOT_FOUND", "Task document role/path is not registered.");
    if (matches.length !== 1) throw new AdapterError("INVALID_ARGUMENT", "Select a registered concept_detail path.");
    const ref = matches[0]!;
    const bytes = await this.documentBytes(taskId, ref.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const currentRevision = `task-file-v1:${sha256}`;
    if ((offset > 0 && !revision) || (revision && revision !== currentRevision)) {
      throw new AdapterError("TASK_DOCUMENT_CHANGED", "Task document revision changed; restart from offset zero using the current document revision.");
    }
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) {
      throw new AdapterError("INVALID_ARGUMENT", "Task document offset is outside a UTF-8 boundary.");
    }
    const remaining = bytes.subarray(offset).toString("utf8");
    let text = utf8Prefix(remaining, maxBytes);
    let end = offset + Buffer.byteLength(text);
    const result = () => ({ task_id: taskId, role, path: ref.path, revision: currentRevision,
      unit: "utf8_bytes" as const, total_bytes: bytes.length, sha256, range: { start: offset, end },
      text, has_more: end < bytes.length, content_complete: end === bytes.length });
    while (text && jsonBytes(result()) > READ_PAYLOAD_BYTES / 2) {
      text = utf8Prefix(text, Math.floor(Buffer.byteLength(text) / 2));
      end = offset + Buffer.byteLength(text);
    }
    if (end === offset && offset < bytes.length) throw new AdapterError("RESPONSE_BUDGET_EXCEEDED", "Task document page cannot fit the response budget.");
    return result();
  }

  private async documentBytes(taskId: string, path: string): Promise<Buffer> {
    if (!DOCUMENT_ROLES.some((role) => validDocumentPath(taskId, role as DocumentRole, path))) {
      throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document path is not allowed.");
    }
    const root = this.runtime.project;
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`) || basename(absolute) !== path.split("/").at(-1)) {
      throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document path escapes the project.");
    }
    let current = root;
    for (const segment of path.split("/").slice(0, -1)) {
      current = join(current, segment);
      const info = await lstat(current).catch(() => undefined);
      if (!info) throw new AdapterError("TASK_DOCUMENT_MISSING", "Task document directory does not exist.");
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document directory is not a regular directory.");
    }
    let file;
    try { file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AdapterError("TASK_DOCUMENT_MISSING", "Task document file does not exist.");
      throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document file cannot be opened safely.");
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document must be a regular file.");
      if (info.size > MAX_DOCUMENT_BYTES) throw new AdapterError("TASK_DOCUMENT_LIMIT", "Task document exceeds the read limit.");
      // Check the opened object, not merely its path, before exposing any bytes.
      if (await realpath(`/proc/self/fd/${file.fd}`).catch(() => undefined) !== absolute) {
        throw new AdapterError("TASK_DOCUMENT_PATH_INVALID", "Task document resolves outside its registered project path.");
      }
      const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_DOCUMENT_BYTES) throw new AdapterError("TASK_DOCUMENT_LIMIT", "Task document exceeds the read limit.");
      const after = await file.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || length !== info.size) {
        throw new AdapterError("TASK_DOCUMENT_CHANGED", "Task document changed during the read.");
      }
      const bytes = buffer.subarray(0, length);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new AdapterError("TASK_DOCUMENT_INVALID", "Task document is not valid UTF-8."); }
      if (!text.startsWith(`Task-ID: ${taskId}\n`) && !text.startsWith(`Task-ID: ${taskId}\r\n`)) {
        throw new AdapterError("TASK_DOCUMENT_MISMATCH", "Task document header belongs to another task.");
      }
      return bytes;
    } finally { await file.close(); }
  }

  async createTask(input: {
    projectId?: string;
    boardProjectId?: string;
    title: string;
    description?: string;
    priority?: string;
    status?: string;
  }): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    this.requireNoPendingTransfer(metadata);
    if (input.projectId && input.boardProjectId && input.projectId !== input.boardProjectId) {
      throw new AdapterError("BOARD_PROJECT_CONFLICT", "Board Project selectors disagree.");
    }
    const project = await this.getProject(input.boardProjectId ?? input.projectId, metadata);
    if (!project) throw new AdapterError("BOARD_PROJECT_SETUP_REQUIRED", "Confirm and create Inbox before adding a Ticket.");
    const boardProject = (await this.projects(metadata)).find((row) => row.id === project.backend_id);
    if (boardProject?.status !== "active") throw new AdapterError("BOARD_PROJECT_CONFLICT", "Board Project is not active.");
    const row = await this.request<BackendTask>("/api/tickets", {
      method: "POST",
      body: {
        projectId: project.backend_id,
        title: input.title,
        description: input.description ?? "",
        priority: input.priority,
        status: input.status,
      },
    });
    if (row.projectId !== project.backend_id) throw new AdapterError("TASKBOARD_ERROR", "Project taskboard returned a foreign task.");
    return this.publicTask(row, metadata);
  }

  async updateTask(taskId: string, patch: Record<string, unknown>): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    this.requireNoPendingTransfer(metadata);
    const existing = await this.resolveTask(taskId, metadata);
    const row = await this.request<BackendTask>(`/api/tickets/${encodeURIComponent(existing.id)}`, {
      method: "PUT",
      body: {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
    });
    return this.publicTask(row, metadata);
  }

  async moveTask(taskId: string, status: string, position?: number): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    this.requireNoPendingTransfer(metadata);
    const existing = await this.resolveTask(taskId, metadata);
    const row = await this.request<BackendTask>(`/api/tickets/${encodeURIComponent(existing.id)}/move`, {
      method: "POST",
      body: { status, ...(position === undefined ? {} : { position }) },
    });
    return this.publicTask(row, metadata);
  }

  async addComment(taskId: string, body: string) {
    return this.withMetadataLock(async () => {
      const metadata = await this.loadMetadata();
      this.requireNoPendingTransfer(metadata);
      const row = await this.resolveTask(taskId, metadata);
      const comment = { id: `comment_${randomUUID()}`, body, created_at: new Date().toISOString() };
      metadata.tasks[taskId] = { backend_id: row.id, project_id: this.boardId(row.projectId, metadata), scope: "project-local" };
      metadata.comments[taskId] = [...(metadata.comments[taskId] ?? []), comment];
      await this.saveMetadata(metadata);
      return { task_id: taskId, comment };
    });
  }

  async linkTask(taskId: string, link: { sessionId: string; messageId?: string; result?: string; artifactRefs?: string[] }) {
    return this.withMetadataLock(async () => {
      const metadata = await this.loadMetadata();
      this.requireNoPendingTransfer(metadata);
      const row = await this.resolveTask(taskId, metadata);
      const links = metadata.links[taskId] ?? [];
      const existing = links.findIndex((value) => value.session_id === link.sessionId &&
        value.message_id === link.messageId &&
        (link.result === undefined || value.result === undefined || value.result === link.result));
      const incoming: TaskLink = { session_id: link.sessionId,
        ...(link.messageId === undefined ? {} : { message_id: link.messageId }),
        ...(link.result === undefined ? {} : { result: link.result }),
        ...(link.artifactRefs === undefined ? {} : { artifact_refs: link.artifactRefs }) };
      if (existing < 0) links.push(incoming);
      else links[existing] = { ...links[existing], ...incoming,
        ...(link.artifactRefs === undefined ? {} : {
          artifact_refs: [...new Set([...(links[existing]!.artifact_refs ?? []), ...link.artifactRefs])],
        }) };
      metadata.tasks[taskId] = { backend_id: row.id, project_id: this.boardId(row.projectId, metadata), scope: "project-local" };
      metadata.links[taskId] = links;
      if (Buffer.byteLength(JSON.stringify({ task_id: taskId, links }), "utf8") > MAX_TASK_OUTPUT_BYTES) throw searchIncomplete();
      await this.saveMetadata(metadata);
      return { task_id: taskId, links };
    });
  }

  async getTransferStatus(requestId: string) {
    const metadata = await this.loadMetadata();
    const transfer = metadata.transfers[requestId];
    if (!transfer) throw new AdapterError("TASK_TRANSFER_CONFLICT", "Transfer request ID was not found.");
    return this.transferStatus(transfer);
  }

  async reclassifyTask(input: {
    taskId: string; targetBoardProjectId: string; expectedSourceBoardProjectId: string; requestId: string;
  }) {
    return this.withMetadataLock(async () => {
      const metadata = await this.loadMetadata();
      let transfer = metadata.transfers[input.requestId];
      if (transfer) {
        if (transfer.task_id !== input.taskId || transfer.target_board_project_id !== input.targetBoardProjectId ||
            transfer.source_board_project_id !== input.expectedSourceBoardProjectId || transfer.state === "aborted") {
          throw new AdapterError("TASK_TRANSFER_CONFLICT", "Transfer request ID is bound to a different or aborted operation.");
        }
        if (transfer.state === "completed") return this.transferStatus(transfer);
        // A previously completed or in-progress request keeps its journal unless the
        // caller's expected source no longer matches the live Ticket. The Inbox
        // retry after an interrupted DELETE is part of that contract: the
        // original source was deleted on purpose, and the request itself remains
        // valid until completed or aborted through this exact path.
        const currentSource = await this.ticketOrMissing(transfer.source.id);
        if (currentSource && this.boardId(currentSource.projectId, metadata) !== transfer.source_board_project_id) {
          transfer.state = "aborted";
          await this.saveMetadata(metadata);
          throw new AdapterError("TASK_TRANSFER_CONFLICT", "Source Ticket no longer belongs to the expected Board Project.");
        }
      } else {
        this.requireNoPendingTransfer(metadata);
        const source = await this.resolveTask(input.taskId, metadata);
        const sourceProject = this.boardId(source.projectId, metadata);
        if (sourceProject !== input.expectedSourceBoardProjectId) {
          throw new AdapterError("TASK_TRANSFER_CONFLICT", "Source Board Project does not match the expected Board Project.");
        }
        const target = await this.getProject(input.targetBoardProjectId, metadata);
        if (!target || target.id === sourceProject) throw new AdapterError("TASK_TRANSFER_CONFLICT", "Target must be another Board Project.");
        const targetRow = (await this.projects(metadata)).find((row) => row.id === target.backend_id);
        if (targetRow?.status !== "active") throw new AdapterError("BOARD_PROJECT_CONFLICT", "Target Board Project is not active.");
        if (!["todo", "in_progress", "done"].includes(source.status) ||
            !Array.isArray(source.labels ?? []) || !Array.isArray(source.subtasks ?? []) ||
            !Array.isArray(source.blockedBy ?? []) || source.blockedBy?.length) {
          throw new AdapterError("TASK_TRANSFER_UNSUPPORTED", "Source Ticket has unsupported status or native relations.");
        }
        const all = await this.scanTasks();
        if (all.some((row) => row.blockedBy?.includes(source.id))) {
          throw new AdapterError("TASK_TRANSFER_UNSUPPORTED", "A native Ticket dependency points to this Ticket.");
        }
        if ((source.labels ?? []).some((item) => !record(item) || typeof item.id !== "string") ||
            (source.subtasks ?? []).some((item) => !record(item) || typeof item.title !== "string" ||
              typeof item.completed !== "boolean")) {
          throw new AdapterError("TASK_TRANSFER_UNSUPPORTED", "Native Ticket fields cannot be copied safely.");
        }
        transfer = { request_id: input.requestId, task_id: input.taskId, source_board_project_id: sourceProject,
          target_board_project_id: target.id, target_backend_project_id: target.backend_id,
          source, source_key: `${source.projectPrefix ?? ""}-${source.number ?? "?"}`,
          source_links: (metadata.links[input.taskId] ?? []).length,
          source_comments: (metadata.comments[input.taskId] ?? []).length, state: "prepared" };
        metadata.transfers[input.requestId] = transfer;
        await this.saveMetadata(metadata);
      }
      return this.resumeTransfer(metadata, transfer);
    });
  }

  private transferStatus(transfer: Transfer) {
    return { request_id: transfer.request_id, task_id: transfer.task_id, state: transfer.state,
      source_board_project_id: transfer.source_board_project_id,
      target_board_project_id: transfer.target_board_project_id,
      previous_native_key: transfer.source_key,
      ...(transfer.stage_key ? { current_native_key: transfer.stage_key } : {}) };
  }

  private marker(transfer: Transfer): string { return `[transfer-pending:${transfer.request_id}]`; }

  private async ticketOrMissing(id: string): Promise<BackendTask | undefined> {
    try { return await this.request<BackendTask>(`/api/tickets/${encodeURIComponent(id)}`); }
    catch (error) { if (error instanceof AdapterError && error.code === "TASK_NOT_FOUND") return undefined; throw error; }
  }

  private async stageTicket(metadata: Metadata, transfer: Transfer): Promise<BackendTask | undefined> {
    const rows = await this.scanTasks(transfer.target_backend_project_id);
    const matches = rows.filter((row) => row.description?.includes(this.marker(transfer)));
    if (matches.length > 1 || (transfer.stage_backend_id && matches[0]?.id !== transfer.stage_backend_id)) {
      throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Transfer staging identity is ambiguous.");
    }
    if (matches.length === 1) {
      transfer.stage_backend_id = matches[0]!.id;
      transfer.stage_key = `${matches[0]!.projectPrefix ?? ""}-${matches[0]!.number ?? "?"}`;
      transfer.state = "staged";
      await this.saveMetadata(metadata);
    }
    return matches[0];
  }

  private async resumeTransfer(metadata: Metadata, transfer: Transfer) {
    if (transfer.state === "deleting") {
      if (await this.ticketOrMissing(transfer.source.id)) {
        transfer.state = "unresolved";
        transfer.pending_step = "deleting";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "An interrupted source deletion must be reconciled before retrying.");
      }
      transfer.state = "remapping";
      transfer.pending_step = undefined;
      await this.saveMetadata(metadata);
    }
    if (transfer.state === "prepared") {
      transfer.state = "creating";
      await this.saveMetadata(metadata);
      try {
        await this.request<BackendTask>("/api/tickets", { method: "POST", body: {
          projectId: transfer.target_backend_project_id,
          title: `[transfer-pending] ${transfer.source.title}`.slice(0, 500),
          description: `${transfer.source.description ?? ""}\n\n${this.marker(transfer)}`,
          status: "done", priority: transfer.source.priority,
          ...(transfer.source.teamId ? { teamId: transfer.source.teamId } : {}),
          ...(transfer.source.dueDate ? { dueDate: transfer.source.dueDate.slice(0, 10) } : {}),
          labels: (transfer.source.labels ?? []).map((label) => label.id),
        } });
      } catch { /* Recover by the unique marker, never repeat an uncertain POST. */ }
    }
    if (transfer.state === "unresolved" && transfer.pending_step === "deleting") {
      if (await this.ticketOrMissing(transfer.source.id)) {
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "An uncertain source deletion must be reconciled before another attempt.");
      }
      transfer.state = "remapping";
      await this.saveMetadata(metadata);
    }
    if (transfer.state === "unresolved" && transfer.pending_step === "activating") {
      const current = await this.ticketOrMissing(transfer.stage_backend_id!);
      if (current && await this.transferComplete(metadata, transfer, current)) {
        transfer.state = "completed";
        transfer.pending_step = undefined;
        await this.saveMetadata(metadata);
        return this.transferStatus(transfer);
      }
      if (!current || !current.description?.includes(this.marker(transfer))) {
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Target activation changed outside the transfer.");
      }
      transfer.state = "activating";
      await this.saveMetadata(metadata);
    }
    if (["creating", "unresolved", "subtask_creating", "subtask_toggling"].includes(transfer.state)) {
      const pendingSubtask = transfer.pending_step === "subtask_creating" ? transfer.subtask_index : undefined;
      const pendingToggle = transfer.pending_step === "subtask_toggling" ? transfer.subtask_index : undefined;
      const stage = await this.stageTicket(metadata, transfer);
      if (!stage) {
        transfer.state = "unresolved";
        transfer.pending_step = "creating";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Destination creation is uncertain; do not retry with another request ID.");
      }
      if (pendingSubtask !== undefined && !stage.subtasks?.[pendingSubtask]) {
        transfer.state = "unresolved";
        transfer.pending_step = "subtask_creating";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "An uncertain subtask POST must not be repeated blindly.");
      }
      if (pendingToggle !== undefined && !stage.subtasks?.[pendingToggle]?.completed) {
        transfer.state = "unresolved";
        transfer.pending_step = "subtask_toggling";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "An uncertain subtask toggle must not be repeated blindly.");
      }
      transfer.pending_step = undefined;
      await this.saveMetadata(metadata);
    }
    if (transfer.state === "staged") {
      const stageId = transfer.stage_backend_id!;
      let stage = await this.ticketOrMissing(stageId);
      if (!stage) throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Transfer staging Ticket is missing.");
      for (let index = 0; index < (transfer.source.subtasks ?? []).length; index++) {
        const sourceSubtask = transfer.source.subtasks![index]!;
        let copied = (stage!.subtasks ?? [])[index];
        if (!copied) {
          transfer.state = "subtask_creating";
          transfer.subtask_index = index;
          transfer.pending_step = "subtask_creating";
          await this.saveMetadata(metadata);
          try {
            await this.request(`/api/tickets/${encodeURIComponent(stageId)}/subtasks`, {
              method: "POST", body: { title: sourceSubtask.title },
            });
          } catch { /* Re-read first: the POST may have reached the server. */ }
          stage = await this.ticketOrMissing(stageId);
          copied = stage?.subtasks?.[index];
          if (!copied) {
            transfer.state = "unresolved";
            transfer.pending_step = "subtask_creating";
            await this.saveMetadata(metadata);
            throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Subtask creation is uncertain.");
          }
        }
        if (copied.title !== sourceSubtask.title) throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Staging subtask changed.");
        if (sourceSubtask.completed && !copied.completed) {
          transfer.state = "subtask_toggling";
          transfer.pending_step = "subtask_toggling";
          transfer.subtask_index = index;
          await this.saveMetadata(metadata);
          try { await this.request(`/api/subtasks/${encodeURIComponent(copied.id)}/toggle`, { method: "POST" }); }
          catch { /* Check completion rather than toggling twice. */ }
          stage = await this.ticketOrMissing(stageId);
          if (!stage?.subtasks?.[index]?.completed) {
            transfer.state = "unresolved";
            await this.saveMetadata(metadata);
            throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Subtask completion is uncertain.");
          }
        }
        transfer.state = "staged";
        transfer.subtask_index = undefined;
        transfer.pending_step = undefined;
        await this.saveMetadata(metadata);
      }
      stage = await this.ticketOrMissing(transfer.stage_backend_id!);
      const expectedSubtasks = transfer.source.subtasks ?? [];
      const expectedLabels = (transfer.source.labels ?? []).map((label) => label.id).sort();
      const actualLabels = (stage?.labels ?? []).map((label) => label.id).sort();
      if (!stage || stage.status !== "done" || !stage.description?.includes(this.marker(transfer)) ||
          stage.priority !== transfer.source.priority || (stage.teamId ?? null) !== (transfer.source.teamId ?? null) ||
          (stage.dueDate?.slice(0, 10) ?? null) !== (transfer.source.dueDate?.slice(0, 10) ?? null) ||
          JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels) ||
          (stage.subtasks ?? []).length !== expectedSubtasks.length ||
          expectedSubtasks.some((entry, index) => stage!.subtasks?.[index]?.title !== entry.title ||
            stage!.subtasks?.[index]?.completed !== entry.completed)) {
        transfer.state = "unresolved";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Native target fields were not copied faithfully.");
      }
      const source = await this.ticketOrMissing(transfer.source.id);
      if (source && JSON.stringify(source) !== JSON.stringify(transfer.source)) {
        try { await this.request(`/api/tickets/${encodeURIComponent(stageId)}`, { method: "DELETE" }); }
        catch { /* Inspect before reporting an aborted transfer. */ }
        transfer.state = await this.ticketOrMissing(stageId) ? "unresolved" : "aborted";
        await this.saveMetadata(metadata);
        throw new AdapterError(transfer.state === "aborted" ? "TASK_TRANSFER_CONFLICT" : "TASK_TRANSFER_UNRESOLVED",
          "Source Ticket changed while staging; inspect the transfer before starting another request.");
      }
      transfer.state = source ? "deleting" : "remapping";
      transfer.pending_step = source ? "deleting" : undefined;
      await this.saveMetadata(metadata);
    }
    if (transfer.state === "deleting") {
      try { await this.request(`/api/tickets/${encodeURIComponent(transfer.source.id)}`, { method: "DELETE" }); }
      catch { /* Deletion may have succeeded. */ }
      if (await this.ticketOrMissing(transfer.source.id)) {
        transfer.state = "unresolved";
        transfer.pending_step = "deleting";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Source deletion is uncertain; destination remains transfer-pending.");
      }
      transfer.state = "remapping";
      transfer.pending_step = undefined;
      await this.saveMetadata(metadata);
    }
    if (transfer.state === "remapping") {
      const stage = await this.ticketOrMissing(transfer.stage_backend_id!);
      if (!stage || stage.projectId !== transfer.target_backend_project_id ||
          !stage.description?.includes(this.marker(transfer))) {
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Target Ticket cannot be verified for stable ID remapping.");
      }
      metadata.tasks[transfer.task_id] = { backend_id: stage.id,
        project_id: transfer.target_board_project_id, scope: "project-local" };
      transfer.state = "activating";
      transfer.pending_step = "activating";
      await this.saveMetadata(metadata);
    }
    if (transfer.state === "activating") {
      const id = transfer.stage_backend_id!;
      const before = await this.ticketOrMissing(id);
      if (before && await this.transferComplete(metadata, transfer, before)) {
        transfer.state = "completed";
        transfer.pending_step = undefined;
        await this.saveMetadata(metadata);
        return this.transferStatus(transfer);
      }
      if (!before || !before.description?.includes(this.marker(transfer))) {
        transfer.state = "unresolved";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Target activation changed outside the transfer.");
      }
      try { await this.request(`/api/tickets/${encodeURIComponent(id)}`, { method: "PUT", body: {
        title: transfer.source.title, description: transfer.source.description ?? "", status: transfer.source.status,
        priority: transfer.source.priority,
      } }); }
      catch { /* Read back before deciding whether activation applied. */ }
      const target = await this.ticketOrMissing(id);
      if (!target || !await this.transferComplete(metadata, transfer, target)) {
        transfer.state = "unresolved";
        transfer.pending_step = "activating";
        await this.saveMetadata(metadata);
        throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Final Ticket or linked history could not be verified.");
      }
      transfer.state = "completed";
      transfer.pending_step = undefined;
      await this.saveMetadata(metadata);
    }
    if (transfer.state !== "completed") throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "Transfer needs reconciliation.");
    return this.transferStatus(transfer);
  }

  async transferTask() {
    throw new AdapterError(
      "TASK_SCOPE_UNAVAILABLE",
      "Only project-local tasks are enabled. Local/global transfer is reserved for the multi-store phase.",
    );
  }

  private projectId(): string { return `project_${this.runtime.projectHash}`; }

  private async transferComplete(metadata: Metadata, transfer: Transfer, target: BackendTask): Promise<boolean> {
    const expected = transfer.source;
    return target.projectId === transfer.target_backend_project_id &&
      target.title === expected.title && (target.description ?? "") === (expected.description ?? "") &&
      target.status === expected.status && target.priority === expected.priority &&
      (target.teamId ?? null) === (expected.teamId ?? null) &&
      (target.dueDate?.slice(0, 10) ?? null) === (expected.dueDate?.slice(0, 10) ?? null) &&
      JSON.stringify((target.labels ?? []).map((label) => label.id).sort()) ===
        JSON.stringify((expected.labels ?? []).map((label) => label.id).sort()) &&
      (target.subtasks ?? []).length === (expected.subtasks ?? []).length &&
      !(expected.subtasks ?? []).some((item, index) => target.subtasks?.[index]?.title !== item.title ||
        target.subtasks?.[index]?.completed !== item.completed) &&
      !(target.blockedBy ?? []).length &&
      !await this.ticketOrMissing(expected.id) &&
      metadata.tasks[transfer.task_id]?.backend_id === target.id &&
      metadata.tasks[transfer.task_id]?.project_id === transfer.target_board_project_id &&
      (metadata.links[transfer.task_id] ?? []).length === transfer.source_links &&
      (metadata.comments[transfer.task_id] ?? []).length === transfer.source_comments;
  }

  private boardId(backendId: string, metadata: Metadata): string {
    const known = Object.entries(metadata.projects).find(([, value]) => value.backend_id === backendId);
    if (known) return known[0];
    const digest = createHash("sha256").update(`${this.runtime.projectHash}\0board\0${backendId}`).digest("hex");
    return `board_project_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  }

  private async projects(metadata: Metadata): Promise<BackendProject[]> {
    const projects = await this.request<BackendProject[]>("/api/projects");
    if (!Array.isArray(projects) || projects.some((row) => !record(row) ||
        typeof row.id !== "string" || typeof row.name !== "string" ||
        typeof row.prefix !== "string" || typeof row.status !== "string")) {
      throw new AdapterError("TASKBOARD_ERROR", "Taskboard returned an invalid Board Project list.");
    }
    const current = metadata.projects[this.projectId()];
    if (current && !projects.some((project) => project.id === current.backend_id)) throw metadataError();
    if (!current) {
      const old = projects.find((project) => project.prefix === `OC${this.runtime.projectHash.slice(0, 6).toUpperCase()}`);
      if (old) metadata.projects[this.projectId()] = { backend_id: old.id }; // Read-only in-memory compatibility.
    }
    return projects;
  }

  private async getProject(requested: string | undefined, metadata: Metadata): Promise<{ id: string; backend_id: string } | undefined> {
    const projects = await this.projects(metadata);
    const id = requested ?? this.projectId();
    const row = projects.find((project) => this.boardId(project.id, metadata) === id);
    if (!row && requested && requested !== this.projectId()) {
      throw new AdapterError("BOARD_PROJECT_NOT_FOUND", "Board Project was not found in this repository.");
    }
    return row ? { id, backend_id: row.id } : undefined;
  }

  private taskId(backendId: string, metadata: Metadata): string {
    const known = Object.entries(metadata.tasks).find(([, value]) => value.backend_id === backendId);
    if (known) {
      return known[0];
    }
    // Deterministic UUID-shaped ID: UI-created tasks are addressable without a read-side write.
    const bytes = createHash("sha256").update(`${this.runtime.projectHash}\0${backendId}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 0x50;
    bytes[8] = (bytes[8]! & 63) | 0x80;
    const hex = bytes.toString("hex");
    return `task_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private async scanTasks(backendProjectId?: string, status?: string): Promise<BackendTask[]> {
    const rows = await this.request<BackendTask[]>(
      `/api/tickets?${backendProjectId ? `projectId=${encodeURIComponent(backendProjectId)}&` : ""}${status ? `status=${encodeURIComponent(status)}` : ""}`,
      {}, "scan",
    );
    if (!Array.isArray(rows)) throw new AdapterError("TASKBOARD_ERROR", "Project taskboard returned an invalid task list.");
    if (rows.length > TASK_SCAN_LIMIT) throw searchIncomplete();
    if (rows.some((row) => !record(row) || typeof row.id !== "string" ||
        typeof row.projectId !== "string" || (backendProjectId && row.projectId !== backendProjectId) ||
        typeof row.title !== "string" || typeof row.status !== "string" || typeof row.priority !== "string")) {
      throw new AdapterError("TASKBOARD_ERROR", "Project taskboard returned an invalid or foreign task.");
    }
    return rows;
  }

  private async resolveTask(taskId: string, metadata: Metadata): Promise<BackendTask> {
    const projects = await this.projects(metadata);
    const mapping = Object.hasOwn(metadata.tasks, taskId) ? metadata.tasks[taskId] : undefined;
    if (mapping) {
      const row = await this.request<BackendTask>(`/api/tickets/${encodeURIComponent(mapping.backend_id)}`);
      if (!projects.some((project) => project.id === row.projectId) ||
          this.boardId(row.projectId, metadata) !== mapping.project_id) throw metadataError();
      return row;
    }
    const row = (await this.scanTasks()).find((value) => this.taskId(value.id, metadata) === taskId);
    if (!row) throw new AdapterError("TASK_NOT_FOUND", "Project task was not found.");
    if (!projects.some((project) => project.id === row.projectId)) throw metadataError();
    return row;
  }

  private requireNoPendingTransfer(metadata: Metadata): void {
    if (Object.values(metadata.transfers).some((transfer) => transfer.state !== "completed" && transfer.state !== "aborted")) {
      throw new AdapterError("TASK_TRANSFER_UNRESOLVED", "A Board Project transfer is pending; inspect its request ID before continuing.");
    }
  }

  private publicTask(row: BackendTask, metadata: Metadata, includeLinks = false): PublicTask {
    const taskId = this.taskId(row.id, metadata);
    const links = metadata.links[taskId] ?? [];
    return {
      task_id: taskId,
      project_id: this.boardId(row.projectId, metadata),
      board_project_id: this.boardId(row.projectId, metadata),
      scope: "project-local",
      title: row.title,
      description: row.description ?? "",
      status: row.status,
      priority: row.priority,
      position: row.position,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      comments: metadata.comments[taskId] ?? [],
      session_ids: [...new Set(links.map((link) => link.session_id))],
      ...(includeLinks ? { links } : {}),
      ...(includeLinks ? { documents: metadata.documents[taskId] ?? [] } : {}),
    };
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}, kind?: "scan"): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.runtime.taskboardUrl}${path}`, {
        method: options.method ?? "GET",
        headers: options.body === undefined ? undefined : { "content-type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new AdapterError("TASKBOARD_UNAVAILABLE", "The project taskboard service is unavailable.");
    }
    if (!response.ok) {
      if (response.status === 404 && path.startsWith("/api/tickets/")) {
        throw new AdapterError("TASK_NOT_FOUND", "Project task was not found.");
      }
      throw new AdapterError("TASKBOARD_ERROR", `The project taskboard returned HTTP ${response.status}.`);
    }
    if (response.status === 204) return undefined as T;
    const reader = response.body?.getReader();
    if (!reader) throw new AdapterError("TASKBOARD_ERROR", "Project taskboard returned no JSON body.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BOARD_RESPONSE_BYTES) throw kind === "scan" ? searchIncomplete() :
          new AdapterError("TASKBOARD_ERROR", "Project taskboard response exceeds its limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new AdapterError("TASKBOARD_ERROR", "Project taskboard returned invalid JSON.");
    }
  }

  private async loadMetadata(): Promise<Metadata> {
    try {
      const info = await lstat(this.runtime.taskboardMetadataFile);
      if (!info.isFile() || info.isSymbolicLink()) throw metadataError();
      return parseMetadata(JSON.parse(await readFile(this.runtime.taskboardMetadataFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMetadata();
      if (error instanceof AdapterError) throw error;
      throw metadataError();
    }
  }

  private async saveMetadata(metadata: Metadata): Promise<void> {
    const temporary = `${this.runtime.taskboardMetadataFile}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
        await file.sync();
      }
      finally { await file.close(); }
      await rename(temporary, this.runtime.taskboardMetadataFile);
      const directory = await open(dirname(this.runtime.taskboardMetadataFile), constants.O_RDONLY);
      try { await directory.sync(); }
      finally { await directory.close(); }
    } catch {
      await unlink(temporary).catch(() => {});
      throw metadataError();
    }
  }

  private async withMetadataLock<T>(work: () => Promise<T>): Promise<T> {
    const directory = dirname(this.runtime.taskboardMetadataFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.runtime.taskboardMetadataFile}.lock`;
    try {
      const file = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await file.close();
      const info = await lstat(lockPath);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw metadataError();
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw metadataError();
    }
    // The guest already uses util-linux flock. The helper holds the kernel lock
    // across this callback, and EOF releases it even if the adapter exits.
    const child = spawn("flock", ["-x", "-w", "10", lockPath, "sh", "-c", "printf 'ready\\n'; read _"],
      { stdio: ["pipe", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = () => { cleanup(); reject(metadataError()); };
        const ready = (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("ready\n")) { cleanup(); resolve(); }
        };
        const cleanup = () => {
          child.off("error", failed);
          child.off("exit", failed);
          child.stdout.off("data", ready);
        };
        child.once("error", failed);
        child.once("exit", failed);
        child.stdout.on("data", ready);
      });
      return await work();
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    }
  }
}
