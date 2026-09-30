import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export const ADAPTER_VERSION = "0.1.20";
export const MCP_TRANSPORT = "streamable-http-stateless";

export type RuntimeDescriptor = {
  schema: 1;
  project: string;
  projectHash: string;
  projectName: string;
  backendUrl: string;
  generation: string;
  opencodeVersion: string;
  listenHost: "127.0.0.1";
  listenPort: number;
  credentialFile: string;
  managerFile?: string;
  taskboardUrl?: string;
  taskboardMetadataFile?: string;
};

export type ReadyDescriptor = {
  schema: 1;
  projectHash: string;
  generation: string;
  adapterVersion: string;
  pid: number;
  host: "127.0.0.1";
  port: number;
  transport: string;
  preferredProtocolVersion: string;
  supportedProtocolVersions: string[];
  negotiatedProtocolVersion: null;
};

export type ProjectIdentity = {
  id: string;
  name: string;
};

export type PendingInput = {
  permissions: number;
  questions: number;
};

export type SessionActivity = "idle" | "busy" | "retry";

export type SessionSummary = {
  id: string;
  title: string;
  created: number;
  updated: number;
  activity: SessionActivity;
};

export type ListSessionsResult = {
  project: ProjectIdentity;
  sessions: SessionSummary[];
  next_cursor?: string;
  truncated: boolean;
};

export type SessionDetailsResult = SessionSummary & {
  archived_at?: number;
  agent?: string;
  provider_id?: string;
  model_id?: string;
  variant?: string;
  pending_input: PendingInput;
  admission?: AdmissionState;
};

export type AdmissionState = {
  write_in_progress: boolean;
  guarded_message_id?: string;
};

export type CorrelatedState =
  | "unknown"
  | "submitted"
  | "running"
  | "input_required"
  | "completed"
  | "failed"
  | "aborted";

export type SessionStatusResult = {
  session_id: string;
  message_id?: string;
  backend_activity: SessionActivity;
  state: CorrelatedState;
  pending_input: PendingInput;
  assistant_message_ids: string[];
  active_assistant_message_ids?: string[];
  pending_input_scope?: "session";
  admission?: AdmissionState;
  receipt_resolution?: ReceiptResolution;
  observed_at?: string;
  source?: "backend";
  task_status_reason?:
    | "not_requested"
    | "outside_history_or_not_observed"
    | "non_terminal_evidence";
};

export type ToolObservation = {
  message_id: string;
  call_id: string;
  tool: string;
  task_message_id?: string;
  status: "pending" | "running" | "completed" | "error";
  started_at?: number;
  finished_at?: number;
};

export type SessionProgressResult = {
  session_id: string;
  message_id?: string;
  observed_at: string;
  source: "backend_snapshot";
  backend_activity: SessionActivity;
  pending_input: PendingInput;
  pending_input_scope: "session";
  in_flight_tools: ToolObservation[];
  last_finished_tool?: ToolObservation;
  last_activity_at?: number;
  idle_with_in_flight_tools: boolean;
  coverage: {
    message_limit: number;
    messages_scanned: number;
    history_has_more: boolean;
    in_flight_total: number;
    in_flight_truncated: boolean;
    metadata_incomplete: boolean;
    unattributed_tools: number;
  };
};

export type ContentDescriptor = {
  content_ref: string;
  revision: string;
  unit: "utf8_bytes";
  total_bytes: number;
  sha256: string;
  availability: "available" | "empty" | "not_exposed";
  omitted_parts: Array<{
    type: string;
    count: number;
    reason: "part_not_exposed";
  }>;
};

export type HistoryMessage = {
  id: string;
  role: "user" | "assistant";
  parent_id?: string;
  text: string;
  created: number;
  completed?: number;
  finish?: string;
  error?: "aborted" | "failed";
  text_truncated: boolean;
  content_complete?: boolean;
  truncation_reason?: "preview_limit" | "response_budget";
  content?: ContentDescriptor;
};

export type SessionHistoryResult = {
  session_id: string;
  messages: HistoryMessage[];
  next_before?: string;
  truncated: boolean;
  history_has_more?: boolean;
};

export type MessageResult = { session_id: string; message: HistoryMessage };
export type MessageContentResult = {
  session_id: string;
  message_id: string;
  revision: string;
  unit: "utf8_bytes";
  total_bytes: number;
  sha256: string;
  range: { start: number; end: number };
  text: string;
  has_more: boolean;
  next_cursor?: string;
  content_complete: boolean;
};
export type TaskResult = {
  session_id: string;
  submitted_message_id: string;
  state: CorrelatedState;
  state_reason?:
    | "search_incomplete"
    | "non_terminal_evidence"
    | "no_terminal_evidence"
    | "superseded_by_later_completed_turn";
  superseded_by_message_id?: string;
  observed_at: string;
  source: "backend";
  search_complete: boolean;
  next_cursor?: string;
  order: "newest_first";
  messages: Array<
    HistoryMessage & { result_kind: "terminal" | "intermediate" }
  >;
  receipt_resolution?: ReceiptResolution;
};

export type ReceiptResolution = {
  state: "unresolved";
  resolution: "superseded_by_operator";
  superseded_at: string;
  superseded_by_request_id: string;
  superseded_by_message_id: string;
  reason?: string;
};

export type SubmissionGuardSnapshot = {
  observed_at: string;
  backend_activity: SessionActivity;
  active_assistant_message_ids: string[];
  in_flight_tools: ToolObservation[];
  pending_input: PendingInput;
  guarded_message_id: string;
  guarded_receipt_state: CorrelatedState;
  last_activity_at?: number;
  coverage: SessionProgressResult["coverage"];
};

export type SubmissionGuardOverrideInput = {
  sessionId: string;
  guardedMessageId: string;
  requestId: string;
  operatorAuthorized: true;
  message: string;
  reason?: string;
  attachmentIds?: string[];
};

export type SubmissionGuardOverrideResult = {
  session_id: string;
  guarded_message_id: string;
  request_id: string;
  message_id: string;
  state: "submitted";
  resolution: "superseded_by_operator";
  superseded_at: string;
  submitted_at: string;
  authorization_source: "operator_asserted";
  preflight: SubmissionGuardSnapshot;
  activity_cursor?: string;
  attachments?: SendMessageResult["attachments"];
};

export type SendMessageResult = {
  session_id: string;
  message_id: string;
  state: "submitted";
  submitted_at?: string;
  activity_cursor?: string;
  attachments?: Array<{
    attachment_id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    sha256: string;
  }>;
};

export type SessionRuntime = {
  agent: string;
  provider_id: string;
  model_id: string;
  variant: string;
};
export type RuntimePatch = Partial<SessionRuntime>;
export type RuntimeOptions = {
  agents: string[];
  providers: Array<{ provider_id: string; name: string }>;
  models: Array<{
    provider_id: string;
    model_id: string;
    name: string;
    variants: string[];
  }>;
  truncated: boolean;
  current?: SessionRuntime;
};
export type RuntimeUpdateResult = {
  session_id: string;
  previous: SessionRuntime;
  current: SessionRuntime;
  state: "updated";
};

export const ACTIVITY_TYPES = [
  "message.submitted",
  "message.running",
  "message.completed",
  "message.failed",
  "message.aborted",
  "session.input_required",
  "session.permission_required",
  "session.idle",
  "session.busy",
  "session.runtime_changed",
  "submission.guard_overridden",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type ActivityEvent = {
  event_id: string;
  cursor: string;
  timestamp: string;
  session_id: string;
  session_title: string;
  message_id?: string;
  guarded_message_id?: string;
  request_id?: string;
  reason?: string;
  operator_authorized?: true;
  authorization_source?: "operator_asserted";
  guarded_receipt_state?: CorrelatedState;
  last_activity_at?: number;
  type: ActivityType;
  state: string;
  assistant_message_ids: string[];
  pending_input?: PendingInput;
  previous?: SessionRuntime;
  current?: SessionRuntime;
  source: "mcp" | "observed" | "reconciled";
};
export type ActivityQuery = {
  tail?: boolean;
  after_cursor?: string;
  limit?: number;
  session_ids?: string[];
  event_types?: ActivityType[];
};
export type ActivityResult = {
  events: ActivityEvent[];
  next_cursor: string;
  has_more: boolean;
  filter_key?: string;
  tail?: {
    selection_complete: boolean;
    earlier_events_not_examined: boolean;
  };
  tracking: {
    connected: boolean;
    partial: boolean;
    last_reconciled_at?: string;
  };
};
export type ActivitySnapshot = {
  session_id: string;
  session_title: string;
  activity: SessionActivity;
  pending_input: PendingInput;
  runtime?: SessionRuntime;
  messages: SessionStatusResult[];
};

export type CreateSessionResult = {
  project: ProjectIdentity;
  session_id: string;
  title: string;
  agent: string;
  provider_id: string;
  model_id: string;
  variant?: string;
  state: "created";
};

export type ArchiveSessionResult = {
  session_id: string;
  state: "archived";
  archived_at: number;
};

export type RenameSessionResult = {
  session_id: string;
  title: string;
  state: "renamed";
};

export const ADAPTER_ERROR_CODES = [
  "INVALID_ARGUMENT",
  "SESSION_NOT_FOUND",
  "SESSION_BUSY",
  "INPUT_REQUIRED",
  "BACKEND_UNAVAILABLE",
  "BACKEND_INCOMPATIBLE",
  "SUBMISSION_UNCERTAIN",
  "SUBMISSION_UNRESOLVED",
  "SUBMISSION_GUARD_CONFLICT",
  "CREATION_UNCERTAIN",
  "ARCHIVE_UNCERTAIN",
  "RENAME_UNCERTAIN",
  "INVALID_AGENT",
  "INVALID_PROVIDER",
  "INVALID_MODEL",
  "INVALID_VARIANT",
  "UNSUPPORTED_CONFIGURATION",
  "RUNTIME_UPDATE_FAILED",
  "CURSOR_EXPIRED",
  "ACTIVITY_UNAVAILABLE",
  "INTERNAL_ERROR",
  "MESSAGE_NOT_FOUND",
  "CONTENT_UNAVAILABLE",
  "CONTENT_CHANGED",
  "READ_REFERENCE_EXPIRED",
  "SEARCH_CHANGED",
  "RESPONSE_BUDGET_EXCEEDED",
  "ATTACHMENT_NOT_FOUND",
  "UNSUPPORTED_MEDIA_TYPE",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_ACCESS_DENIED",
  "INVALID_ATTACHMENT_REFERENCE",
  "MODEL_DOES_NOT_SUPPORT_ATTACHMENT_TYPE",
  "TASK_NOT_FOUND",
  "TASKBOARD_UNAVAILABLE",
  "TASKBOARD_ERROR",
  "TASKBOARD_METADATA_ERROR",
  "TASK_SEARCH_INCOMPLETE",
  "TASK_SCOPE_UNAVAILABLE",
  "BOARD_PROJECT_NOT_FOUND",
  "BOARD_PROJECT_CONFLICT",
  "BOARD_PROJECT_SETUP_REQUIRED",
  "TASK_TRANSFER_UNSUPPORTED",
  "TASK_TRANSFER_UNRESOLVED",
  "TASK_TRANSFER_CONFLICT",
  "TASK_DOCUMENT_REF_NOT_FOUND",
  "TASK_DOCUMENT_MISSING",
  "TASK_DOCUMENT_CHANGED",
  "TASK_DOCUMENT_MISMATCH",
  "TASK_DOCUMENT_PATH_INVALID",
  "TASK_DOCUMENT_INVALID",
  "TASK_DOCUMENT_CONFLICT",
  "TASK_DOCUMENT_LIMIT",
  "TASK_DESCRIPTION_LIMIT",
] as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export const ADMISSION_ERROR_REASONS = [
  "write_in_progress",
  "backend_active",
  "pending_input",
  "receipt_not_terminal",
  "receipt_unavailable",
  "receipt_changed",
  "search_incomplete",
  "search_changed",
  "backend_unavailable",
  "backend_incompatible",
] as const;
export type AdmissionErrorReason = (typeof ADMISSION_ERROR_REASONS)[number];

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly correlationId?: string,
    readonly reason?: AdmissionErrorReason,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export async function loadRuntimeDescriptor(
  path: string,
): Promise<RuntimeDescriptor> {
  await requirePrivateRegularFile(path, 0o600, "runtime descriptor");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("The MCP runtime descriptor is not valid JSON.");
  }
  if (!isRecord(value) || value.schema !== 1) {
    throw new Error("The MCP runtime descriptor has an unsupported schema.");
  }

  const project = requiredString(value, "project", 4096);
  const projectHash = requiredString(value, "projectHash", 256);
  const projectName = requiredString(value, "projectName", 256);
  const backendUrl = requiredString(value, "backendUrl", 2048);
  const generation = requiredString(value, "generation", 256);
  const opencodeVersion = requiredString(value, "opencodeVersion", 128);
  const credentialFile = requiredString(value, "credentialFile", 4096);
  const managerFile = optionalString(value, "managerFile", 4096);
  const taskboardUrl = optionalString(value, "taskboardUrl", 2048);
  const taskboardMetadataFile = optionalString(
    value,
    "taskboardMetadataFile",
    4096,
  );

  if (!isAbsolute(project)) throw new Error("MCP project must be absolute.");
  if ((await realpath(project).catch(() => undefined)) !== project) {
    throw new Error("MCP project must be an existing canonical directory.");
  }
  if (!isSafeLabel(projectHash) || !isSafeLabel(projectName)) {
    throw new Error("MCP project identity is invalid.");
  }
  validateBackendUrl(backendUrl);
  if (taskboardUrl) validateBackendUrl(taskboardUrl);
  if (!isSafeLabel(generation) || /[\r\n]/u.test(opencodeVersion)) {
    throw new Error("MCP runtime identity is invalid.");
  }
  if (value.listenHost !== "127.0.0.1") {
    throw new Error("MCP listenHost must be 127.0.0.1.");
  }
  const listenPort = value.listenPort;
  if (
    typeof listenPort !== "number" ||
    !Number.isInteger(listenPort) ||
    listenPort < 1 ||
    listenPort > 65_535
  ) {
    throw new Error("MCP listenPort is invalid.");
  }
  if (
    !isAbsolute(credentialFile) ||
    (managerFile && !isAbsolute(managerFile)) ||
    (taskboardMetadataFile && !isAbsolute(taskboardMetadataFile))
  ) {
    throw new Error(
      "MCP credential, manager and taskboard paths must be absolute.",
    );
  }
  await requirePrivateRegularFile(credentialFile, 0o600, "credential");

  return {
    schema: 1,
    project,
    projectHash,
    projectName,
    backendUrl,
    generation,
    opencodeVersion,
    listenHost: "127.0.0.1",
    listenPort,
    credentialFile,
    ...(managerFile ? { managerFile } : {}),
    ...(taskboardUrl ? { taskboardUrl } : {}),
    ...(taskboardMetadataFile ? { taskboardMetadataFile } : {}),
  };
}

export async function loadCredential(path: string): Promise<string> {
  await requirePrivateRegularFile(path, 0o600, "credential");
  const raw = await readFile(path, "utf8");
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (
    token.length < 43 ||
    token.length > 512 ||
    token.trim() !== token ||
    /[\s\x00-\x1f\x7f]/u.test(token)
  ) {
    throw new Error("The MCP credential is malformed.");
  }
  return token;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requirePrivateRegularFile(
  path: string,
  expectedMode: number,
  label: string,
): Promise<void> {
  if (!isAbsolute(path))
    throw new Error(`The MCP ${label} path must be absolute.`);
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`The MCP ${label} must be a regular file.`);
  }
  if (stat.uid !== process.getuid?.()) {
    throw new Error(`The MCP ${label} has an unsafe owner.`);
  }
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new Error(
      `The MCP ${label} must have mode ${expectedMode.toString(8)}.`,
    );
  }
  const parent = await lstat(dirname(path)).catch(() => undefined);
  if (
    !parent?.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700
  ) {
    throw new Error(`The MCP ${label} directory must be owner-only mode 700.`);
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0 || item.length > maximum) {
    throw new Error(`MCP runtime field ${key} is invalid.`);
  }
  return item;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
): string | undefined {
  if (value[key] === undefined) return undefined;
  return requiredString(value, key, maximum);
}

function isSafeLabel(value: string): boolean {
  return value.length > 0 && !/[\x00-\x1f\x7f/\\]/u.test(value);
}

function validateBackendUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP backendUrl is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("MCP backendUrl must be a loopback HTTP origin.");
  }
}
