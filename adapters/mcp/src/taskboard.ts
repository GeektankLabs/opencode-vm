import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeDescriptor } from "./types.js";
import { AdapterError } from "./types.js";

type Metadata = {
  schema: 1;
  projects: Record<string, { backend_id: string }>;
  tasks: Record<string, { backend_id: string; project_id: string; scope: string }>;
  comments: Record<string, Array<{ id: string; body: string; created_at: string }>>;
  links: Record<string, Array<{ session_id: string; message_id?: string; result?: string; artifact_refs?: string[] }>>;
};

type BackendTask = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  position?: number;
  createdAt?: string;
  updatedAt?: string;
  labels?: unknown[];
  subtasks?: unknown[];
};

type PublicTask = {
  task_id: string;
  project_id: string;
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
};

const emptyMetadata = (): Metadata => ({
  schema: 1,
  projects: {},
  tasks: {},
  comments: {},
  links: {},
});

type TaskboardRuntime = RuntimeDescriptor & {
  taskboardUrl: string;
  taskboardMetadataFile: string;
};

export class ProjectBoardService {
  private metadata?: Metadata;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: TaskboardRuntime) {}

  async listTasks(projectId?: string, status?: string): Promise<PublicTask[]> {
    const project = await this.ensureProject(projectId);
    const suffix = status ? `&status=${encodeURIComponent(status)}` : "";
    const rows = (await this.request<BackendTask[]>(
      `/api/tickets?projectId=${encodeURIComponent(project.backend_id)}${suffix}`,
    )) ?? [];
    return Promise.all(rows.map((row) => this.publicTask(row, project.id)));
  }

  async getTask(taskId: string): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    const mapping = metadata.tasks[taskId];
    if (!mapping) throw new AdapterError("TASK_NOT_FOUND", "Project task was not found.");
    const row = await this.request<BackendTask>(`/api/tickets/${encodeURIComponent(mapping.backend_id)}`);
    return this.publicTask(row, mapping.project_id, taskId);
  }

  async createTask(input: {
    projectId?: string;
    title: string;
    description?: string;
    priority?: string;
    status?: string;
  }): Promise<PublicTask> {
    const project = await this.ensureProject(input.projectId);
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
    return this.publicTask(row, project.id);
  }

  async updateTask(taskId: string, patch: Record<string, unknown>): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    const mapping = metadata.tasks[taskId];
    if (!mapping) throw new AdapterError("TASK_NOT_FOUND", "Project task was not found.");
    const row = await this.request<BackendTask>(`/api/tickets/${encodeURIComponent(mapping.backend_id)}`, {
      method: "PUT",
      body: {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
    });
    return this.publicTask(row, mapping.project_id, taskId);
  }

  async moveTask(taskId: string, status: string, position?: number): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    const mapping = metadata.tasks[taskId];
    if (!mapping) throw new AdapterError("TASK_NOT_FOUND", "Project task was not found.");
    const row = await this.request<BackendTask>(`/api/tickets/${encodeURIComponent(mapping.backend_id)}/move`, {
      method: "POST",
      body: { status, ...(position === undefined ? {} : { position }) },
    });
    return this.publicTask(row, mapping.project_id, taskId);
  }

  async addComment(taskId: string, body: string) {
    const metadata = await this.loadMetadata();
    if (!metadata.tasks[taskId]) throw new AdapterError("TASK_NOT_FOUND", "Project task was not found.");
    const comment = { id: `comment_${randomUUID()}`, body, created_at: new Date().toISOString() };
    metadata.comments[taskId] = [...(metadata.comments[taskId] ?? []), comment];
    await this.saveMetadata(metadata);
    return { task_id: taskId, comment };
  }

  async linkTask(taskId: string, link: { sessionId: string; messageId?: string; result?: string; artifactRefs?: string[] }) {
    const metadata = await this.loadMetadata();
    if (!metadata.tasks[taskId]) throw new AdapterError("TASK_NOT_FOUND", "Project task was not found.");
    const links = metadata.links[taskId] ?? [];
    const next = links.filter((value) => value.session_id !== link.sessionId);
    next.push({ session_id: link.sessionId, message_id: link.messageId, result: link.result, artifact_refs: link.artifactRefs });
    metadata.links[taskId] = next;
    await this.saveMetadata(metadata);
    return { task_id: taskId, links: next };
  }

  async transferTask() {
    throw new AdapterError(
      "TASK_SCOPE_UNAVAILABLE",
      "Only project-local tasks are enabled. Local/global transfer is reserved for the multi-store phase.",
    );
  }

  private async ensureProject(requested?: string): Promise<{ id: string; backend_id: string }> {
    const id = requested ?? `project_${this.runtime.projectHash}`;
    const metadata = await this.loadMetadata();
    const known = metadata.projects[id];
    if (known) return { id, backend_id: known.backend_id };
    const projects = (await this.request<Array<{ id: string; name: string; prefix: string }>>("/api/projects")) ?? [];
    const prefix = `OC${this.runtime.projectHash.slice(0, 6).toUpperCase()}`;
    const existing = projects.find((project) => project.prefix === prefix);
    const project = existing ?? (await this.request<{ id: string }>("/api/projects", {
      method: "POST",
      body: { name: this.runtime.projectName, prefix, description: "OpenCode VM project board" },
    }));
    metadata.projects[id] = { backend_id: project.id };
    await this.saveMetadata(metadata);
    return { id, backend_id: project.id };
  }

  private async publicTask(row: BackendTask, projectId: string, knownId?: string): Promise<PublicTask> {
    const metadata = await this.loadMetadata();
    let taskId = knownId;
    if (!taskId) {
      taskId = Object.entries(metadata.tasks).find(([, value]) => value.backend_id === row.id)?.[0];
    }
    if (!taskId) {
      taskId = `task_${randomUUID()}`;
      metadata.tasks[taskId] = { backend_id: row.id, project_id: projectId, scope: "project-local" };
      await this.saveMetadata(metadata);
    }
    const links = metadata.links[taskId] ?? [];
    return {
      task_id: taskId,
      project_id: projectId,
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
    };
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
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
      throw new AdapterError("TASKBOARD_ERROR", `The project taskboard returned HTTP ${response.status}.`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async loadMetadata(): Promise<Metadata> {
    if (this.metadata) return this.metadata;
    try {
      const parsed = JSON.parse(await readFile(this.runtime.taskboardMetadataFile, "utf8")) as Metadata;
      if (parsed.schema !== 1) throw new Error("unsupported schema");
      this.metadata = parsed;
    } catch {
      this.metadata = emptyMetadata();
    }
    return this.metadata;
  }

  private async saveMetadata(metadata: Metadata): Promise<void> {
    this.metadata = metadata;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.runtime.taskboardMetadataFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.runtime.taskboardMetadataFile}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.runtime.taskboardMetadataFile);
    });
    await this.writeChain;
  }
}
