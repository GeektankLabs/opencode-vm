import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { SessionGateway } from "./opencode.js";
import type { RuntimeDescriptor } from "./types.js";
import { ProjectBoardService, MAX_TASK_DESCRIPTION_LENGTH } from "./taskboard.js";
import type { DocumentRole } from "./taskboard.js";
import { traceToolCall } from "./diagnostics.js";
import { SUPPORTED_ATTACHMENT_TYPES } from "./attachments.js";
import { PROFILE_NAMES, describePolicy, readPolicy, resolveProfile } from "./agent-control.js";
import {
  ACTIVITY_TYPES,
  ADAPTER_VERSION,
  AdapterError,
  isRecord,
} from "./types.js";
import {
  DEFAULT_CONTENT_BYTES,
  MAX_CONTENT_BYTES,
  READ_RESPONSE_BYTES,
  jsonBytes,
} from "./content.js";

const sessionId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\x00-\x1f\x7f]+$/u);
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/u);
const opaqueCursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s\x00-\x1f\x7f]+$/u);
const readReference = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
const getMessageInput = z
  .object({
    session_id: sessionId,
    message_id: sessionId,
    include_archived: z.boolean().optional(),
  })
  .strict();
const readContentInput = z
  .object({
    content_ref: readReference,
    cursor: readReference.optional(),
    max_bytes: z
      .number()
      .int()
      .min(4)
      .max(MAX_CONTENT_BYTES)
      .default(DEFAULT_CONTENT_BYTES),
  })
  .strict();
const taskResultInput = z
  .object({
    session_id: sessionId,
    submitted_message_id: sessionId,
    cursor: readReference.optional(),
    limit: z.number().int().min(1).max(20).default(20),
    include_archived: z.boolean().optional(),
  })
  .strict();

const taskId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\x00-\x1f\x7f]+$/u);
const documentRole = z.enum(["compact_context", "concept_plan", "concept_detail"]);
const documentPath = z.string().min(1).max(512).regex(/^[A-Za-z0-9_./-]+$/u);
const projectTaskId = z.string().regex(/^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
const managementNoteInput = z.object({ task_id: projectTaskId,
  note: z.string().trim().min(1).max(MAX_TASK_DESCRIPTION_LENGTH) }).strict();
const managementHistoryInput = z.object({
  task_id: projectTaskId,
  mode: z.enum(["recent", "after", "after_checkpoint", "latest_checkpoint"]).default("recent"),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  legacy_offset: z.number().int().nonnegative().default(0),
  legacy_revision: z.string().max(128).optional(),
  legacy_max_bytes: z.number().int().min(0).max(8192).default(4096),
}).strict().refine((value) => value.mode === "after" || value.mode === "after_checkpoint" || value.cursor === undefined,
"Cursor is supported only in after or after_checkpoint mode.");
const documentBindingsInput = z.object({ task_id: projectTaskId,
  compact_context: documentPath.optional(), concept_plan: documentPath.optional() }).strict()
  .refine((input) => input.compact_context !== undefined || input.concept_plan !== undefined,
    "At least one main document role is required.");
const documentReference = z.object({ role: documentRole, path: documentPath }).strict();
const documentListOutput = z.object({ task_id: taskId, documents: z.array(documentReference.extend({
  state: z.enum(["available", "missing"]), total_bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(), revision: z.string().optional(),
}).strict()) }).strict();
const registerDocumentInput = z.object({ task_id: taskId, role: documentRole, path: documentPath,
  expected_path: documentPath.optional() }).strict();
const documentRefsOutput = z.object({ task_id: taskId, documents: z.array(documentReference) }).strict();
const readDocumentInput = z.object({ task_id: taskId, role: documentRole, path: documentPath.optional(),
  offset: z.number().int().nonnegative().default(0), revision: z.string().max(128).optional(),
  max_bytes: z.number().int().min(4).max(MAX_CONTENT_BYTES).default(DEFAULT_CONTENT_BYTES) }).strict();
const documentContentOutput = z.object({ task_id: taskId, role: documentRole, path: documentPath,
  revision: z.string(), unit: z.literal("utf8_bytes"), total_bytes: z.number().int().nonnegative(),
  sha256: z.string(), range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
  text: z.string(), has_more: z.boolean(), content_complete: z.boolean() }).strict();
const taskInputBase = z.object({ project_id: taskId.optional(), board_project_id: taskId.optional() }).strict();
const boardProjectOutput = z.object({ board_project_id: taskId, name: z.string(), prefix: z.string(),
  status: z.string(), is_default: z.boolean() }).strict();
const getBoardProjectInput = z.object({ board_project_id: taskId }).strict();
const createBoardProjectInput = z.object({ name: z.string().trim().min(1).max(160),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,5}$/u), make_default: z.boolean().optional() }).strict();
const reclassifyTaskInput = z.object({ task_id: taskId, target_board_project_id: taskId,
  expected_source_board_project_id: taskId, request_id: z.string().uuid() }).strict();
const transferStatusInput = z.object({ request_id: z.string().uuid() }).strict();
const transferStatusOutput = z.object({ request_id: z.string().uuid(), task_id: taskId,
  state: z.enum(["prepared", "creating", "staged", "subtask_creating", "subtask_toggling", "deleting", "remapping",
    "activating", "completed", "aborted", "unresolved"]), source_board_project_id: taskId,
  target_board_project_id: taskId, previous_native_key: z.string(), current_native_key: z.string().optional() }).strict();
const taskOutput = z
  .object({
    task_id: taskId,
    project_id: taskId,
    board_project_id: taskId,
    scope: z.literal("project-local"),
    title: z.string(),
    description: z.string(),
    status: z.string(),
    priority: z.string(),
    position: z.number().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    comments: z.array(
      z
        .object({ id: z.string(), body: z.string(), created_at: z.string() })
        .strict(),
    ),
    session_ids: z.array(z.string()),
    links: z.array(z.object({
      session_id: sessionId,
      message_id: sessionId.optional(),
      result: z.string().optional(),
      artifact_refs: z.array(z.string()).optional(),
    }).strict()).optional(),
    documents: z.array(documentReference).optional(),
    management_note: z.object({ entry_id: z.string().uuid(), sequence: z.number().int().positive(),
      generation: z.string().uuid(), head_sequence: z.number().int().positive() }).strict().optional(),
  })
  .strict();
const managementJournalEntryOutput = z.object({ sequence: z.number().int().positive(), entry_id: z.string().uuid(),
  appended_at: z.string().datetime({ offset: true }), text: z.string(), journal_offset: z.number().int().nonnegative() }).strict();
const managementHistoryOutput = z.object({
  task_id: projectTaskId,
  state: z.enum(["absent", "available"]),
  consistency: z.enum(["current", "rebuilt_index", "recovered_suffix"]),
  generation: z.string().uuid().nullable(),
  head_sequence: z.number().int().nonnegative(),
  head_bytes: z.number().int().nonnegative(),
  captured_head_sequence: z.number().int().nonnegative(),
  captured_head_bytes: z.number().int().nonnegative(),
  entry_count: z.number().int().nonnegative(),
  mode: z.enum(["recent", "after", "after_checkpoint", "latest_checkpoint"]),
  entries: z.array(managementJournalEntryOutput),
  latest_checkpoint: managementJournalEntryOutput.omit({ text: true }).nullable(),
  has_more: z.boolean(),
  next_cursor: z.string().optional(),
  legacy_description: z.object({ source: z.literal("native_description"), revision: z.string(),
    total_bytes: z.number().int().nonnegative(),
    range: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
    text: z.string(), has_more: z.boolean() }).strict(),
}).strict();
const listTasksInput = taskInputBase
  .extend({
    status: z.string().min(1).max(64).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    session_id: sessionId.optional(),
    updated_since: z.string().datetime({ offset: true }).optional(),
    include_terminal: z.boolean().optional(),
  })
  .strict();
const getTaskInput = z.object({ task_id: taskId }).strict();
const createTaskInput = taskInputBase
  .extend({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(32_000).optional(),
    priority: z.string().max(64).optional(),
    status: z.string().max(64).optional(),
  })
  .strict();
const updateTaskInput = z
  .object({
    task_id: taskId,
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(32_000).optional(),
    priority: z.string().max(64).optional(),
    status: z.string().max(64).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "task_id"));
const moveTaskInput = z
  .object({
    task_id: taskId,
    status: z.string().min(1).max(64),
    position: z.number().optional(),
  })
  .strict();
const commentInput = z
  .object({ task_id: taskId, body: z.string().trim().min(1).max(32_000) })
  .strict();
const linkTaskInput = z
  .object({
    task_id: taskId,
    session_id: sessionId,
    message_id: sessionId.optional(),
    result: z.string().max(32_000).optional(),
    artifact_refs: z.array(z.string().max(2048)).max(20).optional(),
  })
  .strict();
const transferTaskInput = z
  .object({ task_id: taskId, target_scope: z.string().min(1).max(64) })
  .strict();

const projectSchema = z.object({ id: z.string(), name: z.string() }).strict();
const pendingSchema = z
  .object({
    permissions: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
  })
  .strict();
const admissionSchema = z
  .object({
    write_in_progress: z.boolean(),
    guarded_message_id: z.string().optional(),
  })
  .strict();
const activitySchema = z.enum(["idle", "busy", "retry"]);
const toolObservationSchema = z
  .object({
    message_id: z.string(),
    call_id: z.string(),
    tool: z.string(),
    task_message_id: z.string().optional(),
    status: z.enum(["pending", "running", "completed", "error"]),
    started_at: z.number().nonnegative().optional(),
    finished_at: z.number().nonnegative().optional(),
  })
  .strict();
const sessionProgressOutput = z
  .object({
    session_id: z.string(),
    message_id: z.string().optional(),
    observed_at: z.string(),
    source: z.literal("backend_snapshot"),
    backend_activity: activitySchema,
    pending_input: pendingSchema,
    pending_input_scope: z.literal("session"),
    in_flight_tools: z.array(toolObservationSchema).max(10),
    last_finished_tool: toolObservationSchema.optional(),
    last_activity_at: z.number().nonnegative().optional(),
    idle_with_in_flight_tools: z.boolean(),
    coverage: z
      .object({
        message_limit: z.number().int().positive(),
        messages_scanned: z.number().int().nonnegative(),
        history_has_more: z.boolean(),
        in_flight_total: z.number().int().nonnegative(),
        in_flight_truncated: z.boolean(),
        metadata_incomplete: z.boolean(),
        unattributed_tools: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const summarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    created: z.number(),
    updated: z.number(),
    activity: activitySchema,
  })
  .strict();

export const listSessionsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(20).default(10),
    cursor: cursor.optional(),
  })
  .strict();

export const getSessionInputSchema = z
  .object({ session_id: sessionId, include_archived: z.boolean().optional() })
  .strict();
const archiveSessionInputSchema = z.object({ session_id: sessionId }).strict();
const archiveSessionOutputSchema = z
  .object({
    session_id: z.string(),
    state: z.literal("archived"),
    archived_at: z.number().int().positive(),
  })
  .strict();
const renameSessionInputSchema = z
  .object({
    session_id: sessionId,
    title: z
      .string()
      .min(1)
      .max(160)
      .regex(/^(?=.*\S)[^\x00-\x1f\x7f-\x9f]+$/u),
  })
  .strict();
const renameSessionOutputSchema = z
  .object({
    session_id: z.string(),
    title: z.string(),
    state: z.literal("renamed"),
  })
  .strict();
const receiptResolutionSchema = z
  .object({
    state: z.literal("unresolved"),
    resolution: z.literal("superseded_by_operator"),
    superseded_at: z.string(),
    superseded_by_request_id: z.string().uuid(),
    superseded_by_message_id: sessionId,
    reason: z.string().optional(),
  })
  .strict();

export const getSessionStatusInputSchema = z
  .object({ session_id: sessionId, message_id: sessionId.optional() })
  .strict();

export const getSessionHistoryInputSchema = z
  .object({
    session_id: sessionId,
    before: opaqueCursor.optional(),
    limit: z.number().int().min(1).max(20).default(10),
    include_archived: z.boolean().optional(),
  })
  .strict();

export const sendMessageInputSchema = z
  .object({
    session_id: sessionId,
    message: z.string().min(1).max(32_000),
    attachments: z.array(z.string().min(1).max(256)).max(32).optional(),
  })
  .strict();
const supersedeSubmissionInputSchema = z
  .object({
    session_id: sessionId,
    guarded_message_id: sessionId,
    request_id: z.string().uuid(),
    operator_authorized: z.literal(true),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .regex(/^[^\x00-\x1f\x7f]+$/u)
      .optional(),
    message: z.string().min(1).max(32_000),
    attachments: z.array(z.string().min(1).max(256)).max(32).optional(),
  })
  .strict();

const uploadAttachmentInputSchema = z
  .object({
    session_id: sessionId,
    filename: z.string().min(1).max(255),
    mime_type: z.string().min(1).max(128),
    data_base64: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
  })
  .strict();
const uploadAttachmentOutputSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string(),
    mime_type: z.enum(SUPPORTED_ATTACHMENT_TYPES),
    size_bytes: z.number().int().positive(),
    sha256: z.string(),
    expires_at: z.string(),
  })
  .strict();

export const createSessionInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\x00-\x1f\x7f]+$/u)
      .optional(),
  })
  .strict();

const runtimeFields = {
  agent: sessionId,
  provider_id: sessionId,
  model_id: sessionId,
  variant: sessionId,
};
const runtimeSchema = z.object(runtimeFields).strict();
const runtimeOptionsInput = z
  .object({ session_id: sessionId.optional() })
  .strict();
const runtimeUpdateInput = z
  .object({
    session_id: sessionId,
    agent: sessionId.optional(),
    provider_id: sessionId.optional(),
    model_id: sessionId.optional(),
    variant: sessionId.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.agent !== undefined ||
      value.provider_id !== undefined ||
      value.model_id !== undefined ||
      value.variant !== undefined,
  );
const runtimeOptionsOutput = z
  .object({
    agents: z.array(z.string()),
    providers: z.array(
      z.object({ provider_id: z.string(), name: z.string() }).strict(),
    ),
    models: z.array(
      z
        .object({
          provider_id: z.string(),
          model_id: z.string(),
          name: z.string(),
          variants: z.array(z.string()),
        })
        .strict(),
    ),
    truncated: z.boolean(),
    current: runtimeSchema.optional(),
  })
  .strict();
const profileSelection = z.object({ provider_id: sessionId, model_id: sessionId, variant: sessionId }).strict();
const profileStatus = z.enum(["available", "unconfigured", "provider_unavailable", "model_unavailable",
  "variant_unavailable", "catalog_unavailable", "catalog_incomplete"]);
const profileEntry = z.object({ selection: profileSelection.nullable(), status: profileStatus }).strict();
const modelPolicyOutput = z.object({
  project_id: z.string(), schema_version: z.union([z.literal(1), z.literal(2)]), revision: z.number().int().nonnegative(),
  updated_at: z.string().nullable(), catalog_status: z.enum(["complete", "incomplete", "unavailable"]),
  profiles: z.object({ deep: profileEntry, standard: profileEntry, execution: profileEntry, design: profileEntry, review: profileEntry }).strict(),
  fallbacks: z.object({ design: z.array(z.enum(PROFILE_NAMES)), review: z.array(z.enum(PROFILE_NAMES)) }).strict(),
}).strict();
const recommendedInput = z.object({ profile: z.enum(PROFILE_NAMES) }).strict();
const recommendedOutput = z.object({
  profile: z.enum(PROFILE_NAMES), policy_revision: z.number().int().nonnegative(), status: profileStatus,
  runtime: profileSelection.optional(),
  resolution_path: z.array(z.enum(PROFILE_NAMES)), resolved_profile: z.enum(PROFILE_NAMES).optional(),
}).strict();
const runtimeUpdateOutput = z
  .object({
    session_id: z.string(),
    previous: runtimeSchema,
    current: runtimeSchema,
    state: z.literal("updated"),
  })
  .strict();
const activityFields = {
  after_cursor: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  session_ids: z.array(sessionId).min(1).max(50).optional(),
  event_types: z
    .array(z.enum(ACTIVITY_TYPES))
    .min(1)
    .max(ACTIVITY_TYPES.length)
    .optional(),
};
const activityInput = z
  .object({ ...activityFields, tail: z.boolean().optional() })
  .strict()
  .refine((value) => !value.tail || value.after_cursor === undefined);
const waitActivityInput = z
  .object({
    ...activityFields,
    after_cursor: z.string().min(1).max(128),
    timeout_ms: z.number().int().min(1).max(15000).default(10000),
  })
  .strict();
const activityOutput = z
  .object({
    events: z.array(
      z
        .object({
          event_id: z.string(),
          cursor: z.string(),
          timestamp: z.string(),
          session_id: z.string(),
          session_title: z.string(),
          message_id: z.string().optional(),
          guarded_message_id: z.string().optional(),
          request_id: z.string().uuid().optional(),
          reason: z.string().optional(),
          operator_authorized: z.literal(true).optional(),
          authorization_source: z.literal("operator_asserted").optional(),
          guarded_receipt_state: z
            .enum([
              "unknown",
              "submitted",
              "running",
              "input_required",
              "completed",
              "failed",
              "aborted",
            ])
            .optional(),
          last_activity_at: z.number().nonnegative().optional(),
          type: z.enum(ACTIVITY_TYPES),
          state: z.string(),
          assistant_message_ids: z.array(z.string()),
          pending_input: pendingSchema.optional(),
          previous: runtimeSchema.optional(),
          current: runtimeSchema.optional(),
          source: z.enum(["mcp", "observed", "reconciled"]),
        })
        .strict(),
    ),
    next_cursor: z.string(),
    has_more: z.boolean(),
    filter_key: z.string().optional(),
    tail: z
      .object({
        selection_complete: z.boolean(),
        earlier_events_not_examined: z.boolean(),
      })
      .strict()
      .optional(),
    tracking: z
      .object({
        connected: z.boolean(),
        partial: z.boolean(),
        last_reconciled_at: z.string().optional(),
      })
      .strict(),
  })
  .strict();
const waitActivityOutput = activityOutput
  .extend({ timeout: z.boolean() })
  .strict();

const listSessionsOutputSchema = z
  .object({
    project: projectSchema,
    sessions: z.array(summarySchema),
    next_cursor: z.string().optional(),
    truncated: z.boolean(),
  })
  .strict();

const sessionDetailsOutputSchema = summarySchema
  .extend({
    archived_at: z.number().int().positive().optional(),
    agent: z.string().optional(),
    provider_id: z.string().optional(),
    model_id: z.string().optional(),
    variant: z.string().optional(),
    pending_input: pendingSchema,
    admission: admissionSchema.optional(),
  })
  .strict();

const sessionStatusOutputSchema = z
  .object({
    session_id: z.string(),
    message_id: z.string().optional(),
    backend_activity: activitySchema,
    state: z.enum([
      "unknown",
      "submitted",
      "running",
      "input_required",
      "completed",
      "failed",
      "aborted",
    ]),
    pending_input: pendingSchema,
    assistant_message_ids: z.array(z.string()),
    active_assistant_message_ids: z.array(z.string()).optional(),
    pending_input_scope: z.literal("session").optional(),
    admission: admissionSchema.optional(),
    receipt_resolution: receiptResolutionSchema.optional(),
    observed_at: z.string().optional(),
    source: z.literal("backend").optional(),
    task_status_reason: z
      .enum([
        "not_requested",
        "outside_history_or_not_observed",
        "non_terminal_evidence",
      ])
      .optional(),
  })
  .strict();

const contentDescriptorSchema = z
  .object({
    content_ref: z.string(),
    revision: z.string(),
    unit: z.literal("utf8_bytes"),
    total_bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    availability: z.enum(["available", "empty", "not_exposed"]),
    omitted_parts: z.array(
      z
        .object({
          type: z.string(),
          count: z.number().int().positive(),
          reason: z.literal("part_not_exposed"),
        })
        .strict(),
    ),
  })
  .strict();
const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    parent_id: z.string().optional(),
    text: z.string(),
    created: z.number(),
    completed: z.number().optional(),
    finish: z.string().optional(),
    error: z.enum(["aborted", "failed"]).optional(),
    text_truncated: z.boolean(),
    content_complete: z.boolean().optional(),
    truncation_reason: z.enum(["preview_limit", "response_budget"]).optional(),
    content: contentDescriptorSchema.optional(),
  })
  .strict();
const readableMessageSchema = messageSchema
  .extend({ content: contentDescriptorSchema, content_complete: z.boolean() })
  .strict();
const historyOutputSchema = z
  .object({
    session_id: z.string(),
    messages: z.array(messageSchema),
    next_before: z.string().optional(),
    truncated: z.boolean(),
    history_has_more: z.boolean().optional(),
  })
  .strict();

const getMessageOutput = z
  .object({ session_id: z.string(), message: readableMessageSchema })
  .strict();
const readContentOutput = z
  .object({
    session_id: z.string(),
    message_id: z.string(),
    revision: z.string(),
    unit: z.literal("utf8_bytes"),
    total_bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    range: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict(),
    text: z.string(),
    has_more: z.boolean(),
    next_cursor: z.string().optional(),
    content_complete: z.boolean(),
  })
  .strict();
const taskResultOutput = z
  .object({
    session_id: z.string(),
    submitted_message_id: z.string(),
    state: z.enum([
      "unknown",
      "submitted",
      "running",
      "input_required",
      "completed",
      "failed",
      "aborted",
    ]),
    state_reason: z
      .enum([
        "search_incomplete",
        "non_terminal_evidence",
        "no_terminal_evidence",
        "superseded_by_later_completed_turn",
      ])
      .optional(),
    superseded_by_message_id: z.string().optional(),
    observed_at: z.string(),
    source: z.literal("backend"),
    search_complete: z.boolean(),
    next_cursor: z.string().optional(),
    order: z.literal("newest_first"),
    messages: z.array(
      readableMessageSchema
        .extend({ result_kind: z.enum(["terminal", "intermediate"]) })
        .strict(),
    ),
    receipt_resolution: receiptResolutionSchema.optional(),
  })
  .strict();

const sendMessageOutputSchema = z
  .object({
    session_id: z.string(),
    message_id: z.string(),
    state: z.literal("submitted"),
    submitted_at: z.string().optional(),
    activity_cursor: z.string().optional(),
    attachments: z
      .array(
        z
          .object({
            attachment_id: z.string(),
            filename: z.string(),
            mime_type: z.enum(SUPPORTED_ATTACHMENT_TYPES),
            size_bytes: z.number().int().positive(),
            sha256: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const submissionGuardSnapshotSchema = z
  .object({
    observed_at: z.string(),
    backend_activity: activitySchema,
    active_assistant_message_ids: z.array(z.string()),
    in_flight_tools: z.array(toolObservationSchema).max(10),
    pending_input: pendingSchema,
    guarded_message_id: z.string(),
    guarded_receipt_state: z.enum([
      "unknown",
      "submitted",
      "running",
      "input_required",
      "completed",
      "failed",
      "aborted",
    ]),
    last_activity_at: z.number().nonnegative().optional(),
    coverage: z
      .object({
        message_limit: z.number().int().positive(),
        messages_scanned: z.number().int().nonnegative(),
        history_has_more: z.boolean(),
        in_flight_total: z.number().int().nonnegative(),
        in_flight_truncated: z.boolean(),
        metadata_incomplete: z.boolean(),
        unattributed_tools: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const supersedeSubmissionOutputSchema = z
  .object({
    session_id: z.string(),
    guarded_message_id: z.string(),
    request_id: z.string().uuid(),
    message_id: z.string(),
    state: z.literal("submitted"),
    resolution: z.literal("superseded_by_operator"),
    superseded_at: z.string(),
    submitted_at: z.string(),
    authorization_source: z.literal("operator_asserted"),
    preflight: submissionGuardSnapshotSchema,
    activity_cursor: z.string().optional(),
    attachments: z
      .array(
        z
          .object({
            attachment_id: z.string(),
            filename: z.string(),
            mime_type: z.enum(SUPPORTED_ATTACHMENT_TYPES),
            size_bytes: z.number().int().positive(),
            sha256: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const createSessionOutputSchema = z
  .object({
    project: projectSchema,
    session_id: z.string(),
    title: z.string(),
    agent: z.string(),
    provider_id: z.string(),
    model_id: z.string(),
    variant: z.string().optional(),
    state: z.literal("created"),
  })
  .strict();

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function createMcpServer(
  gateway: SessionGateway,
  runtime?: RuntimeDescriptor,
): McpServer {
  const server = new McpServer({
    name: "opencode-vm",
    version: ADAPTER_VERSION,
  });

  const board =
    runtime?.taskboardUrl && runtime.taskboardMetadataFile
      ? new ProjectBoardService(
          runtime as RuntimeDescriptor & {
            taskboardUrl: string;
            taskboardMetadataFile: string;
          },
        )
      : undefined;
  if (board) {
    const boardError =
      "Board changes are shared with the project Taskboard web app.";
    server.registerTool("list_board_projects", {
      title: "List Board Projects", description: "Read the Board Projects in this repository, including the confirmed default Inbox.",
      inputSchema: z.object({}).strict(), outputSchema: z.object({ projects: z.array(boardProjectOutput) }).strict(),
      annotations: readOnlyAnnotations,
    }, safeHandler(async () => success({ projects: await board.listBoardProjects() }, "Returned Board Projects.")));
    server.registerTool("get_board_project", {
      title: "Get Board Project", description: "Read one Board Project without creating it.",
      inputSchema: getBoardProjectInput, outputSchema: boardProjectOutput, annotations: readOnlyAnnotations,
    }, safeHandler(async (input) => success(await board.getBoardProject(input.board_project_id), "Returned Board Project.")));
    server.registerTool("create_board_project", {
      title: "Create Board Project", description: "Create a user-confirmed Board Project or confirm the default Inbox (INBOX). Never called on reads.",
      inputSchema: createBoardProjectInput, outputSchema: boardProjectOutput, annotations: writeAnnotations,
    }, safeHandler(async (input) => success(await board.createBoardProject({ name: input.name,
      prefix: input.prefix, makeDefault: input.make_default }), "Created Board Project.")));
    server.registerTool("get_task_transfer_status", {
      title: "Get Task Transfer Status", description: "Read the durable state of a known Inbox-to-workstream transfer request.",
      inputSchema: transferStatusInput, outputSchema: transferStatusOutput, annotations: readOnlyAnnotations,
    }, safeHandler(async (input) => success(await board.getTransferStatus(input.request_id), "Returned transfer state.")));
    server.registerTool("reclassify_project_task", {
      title: "Reclassify Project Task", description: "Move a confirmed Inbox Ticket to an existing Board Project using a durable request UUID. Replays use exactly the same fields; uncertain transfers fail closed.",
      inputSchema: reclassifyTaskInput, outputSchema: transferStatusOutput, annotations: writeAnnotations,
    }, safeHandler(async (input) => success(await board.reclassifyTask({ taskId: input.task_id,
      targetBoardProjectId: input.target_board_project_id, expectedSourceBoardProjectId: input.expected_source_board_project_id,
      requestId: input.request_id }), "Transferred project task.")));
    server.registerTool(
      "list_project_tasks",
      {
        title: "List Project Tasks",
        description: `Read the complete project-local board, optionally matching title/description text or a linked session. A bounded scan returns TASK_SEARCH_INCOMPLETE rather than partial results. ${boardError}`,
        inputSchema: listTasksInput,
        outputSchema: z.object({ tasks: z.array(taskOutput) }).strict(),
        annotations: readOnlyAnnotations,
      },
      safeHandler(async (input) =>
        success(
          { tasks: await board.listTasks({ projectId: input.project_id, boardProjectId: input.board_project_id,
            status: input.status,
            query: input.query, sessionId: input.session_id, updatedSince: input.updated_since,
            includeTerminal: input.include_terminal }) },
          "Returned project tasks.",
        ),
      ),
    );
    server.registerTool(
      "get_project_task",
      {
        title: "Get Project Task",
        description: "Read one stable project task by task_id, including its session/message/result/artifact links. Reads do not create taskboard projects or metadata.",
        inputSchema: getTaskInput,
        outputSchema: taskOutput,
        annotations: readOnlyAnnotations,
      },
      safeHandler(async (input) =>
        success(await board.getTask(input.task_id), "Returned project task."),
      ),
    );
    server.registerTool("add_task_management_note", {
      title: "Add Task Management Note",
      description: "Append one task-specific persistent management journal entry without changing the native task Description. Not idempotent; reconcile an uncertain result with get_task_management_history before retrying. Preserves legacy Description notes and does not change Board status.",
      inputSchema: managementNoteInput, outputSchema: taskOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, safeHandler(async (input) => success(await board.addManagementNote(input.task_id, input.note), "Added task management note.")));
    server.registerTool("get_task_management_history", {
      title: "Get Task Management History",
      description: "Read bounded task-specific management journal history, a continuation page, the latest checkpoint, and a UTF-8 page of legacy native Description text. Reads never create journal files; missing or inconsistent history is explicit.",
      inputSchema: managementHistoryInput, outputSchema: managementHistoryOutput, annotations: readOnlyAnnotations,
    }, safeHandler(async (input) => readSuccess(await board.getManagementHistory(input.task_id,
      { mode: input.mode, limit: input.limit, cursor: input.cursor }, input.legacy_offset,
      input.legacy_revision, input.legacy_max_bytes), "Returned bounded task management history.")));
    server.registerTool("add_task_document_bindings", {
      title: "Add Task Document Bindings",
      description: "Add one or both main document bindings after complete validation in one sidecar commit. Exact replay is a no-op; conflicting bindings fail. Never writes files, retargets references or changes board status.",
      inputSchema: documentBindingsInput, outputSchema: documentRefsOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safeHandler(async (input) => success(await board.addDocumentBindings(input.task_id,
      { compactContext: input.compact_context, conceptPlan: input.concept_plan }), "Added task document bindings.")));
    server.registerTool("register_task_document", {
      title: "Register Task Document", description: "Bind an existing task-ID-marked project document to a semantic task role. No file is written; conflicting replacements require expected_path.",
      inputSchema: registerDocumentInput, outputSchema: documentRefsOutput, annotations: writeAnnotations,
    }, safeHandler(async (input) => success(await board.registerDocument(input.task_id,
      input.role as DocumentRole, input.path, input.expected_path), "Registered task document.")));
    server.registerTool("get_task_documents", {
      title: "Get Task Documents", description: "Read registered semantic document roles and current file revisions for one project task; missing files are explicit.",
      inputSchema: getTaskInput, outputSchema: documentListOutput, annotations: readOnlyAnnotations,
    }, safeHandler(async (input) => readSuccess(await board.getDocuments(input.task_id), "Returned task document references.")));
    server.registerTool("read_task_document", {
      title: "Read Task Document", description: "Read a UTF-8 byte page of a registered task document only. For later pages send the returned revision and next offset; changed files fail closed.",
      inputSchema: readDocumentInput, outputSchema: documentContentOutput, annotations: readOnlyAnnotations,
    }, safeHandler(async (input) => readSuccess(await board.readDocument(input.task_id,
      input.role as DocumentRole, input.path, input.offset, input.max_bytes, input.revision), "Returned task document page.")));
    server.registerTool(
      "create_project_task",
      {
        title: "Create Project Task",
        description: `Create a task in the project-local board. ${boardError}`,
        inputSchema: createTaskInput,
        outputSchema: taskOutput,
        annotations: writeAnnotations,
      },
      safeHandler(async (input) =>
        success(
          await board.createTask({
            projectId: input.project_id,
            boardProjectId: input.board_project_id,
            title: input.title,
            description: input.description,
            priority: input.priority,
            status: input.status,
          }),
          "Created project task.",
        ),
      ),
    );
    server.registerTool(
      "update_project_task",
      {
        title: "Update Project Task",
        description:
          "Update task title, description, priority or status by stable task_id.",
        inputSchema: updateTaskInput,
        outputSchema: taskOutput,
        annotations: writeAnnotations,
      },
      safeHandler(async ({ task_id, ...patch }) =>
        success(
          await board.updateTask(task_id, patch),
          "Updated project task.",
        ),
      ),
    );
    server.registerTool(
      "move_project_task",
      {
        title: "Move Project Task",
        description: "Move a task to a board status column.",
        inputSchema: moveTaskInput,
        outputSchema: taskOutput,
        annotations: writeAnnotations,
      },
      safeHandler(async (input) =>
        success(
          await board.moveTask(input.task_id, input.status, input.position),
          "Moved project task.",
        ),
      ),
    );
    server.registerTool(
      "add_task_comment",
      {
        title: "Add Task Comment",
        description:
          "Add an integration comment to a project task. Comments are stored by the adapter until the backend provides native comments.",
        inputSchema: commentInput,
        outputSchema: z
          .object({
            task_id: taskId,
            comment: z
              .object({
                id: z.string(),
                body: z.string(),
                created_at: z.string(),
              })
              .strict(),
          })
          .strict(),
        annotations: writeAnnotations,
      },
      safeHandler(async (input) =>
        success(
          await board.addComment(input.task_id, input.body),
          "Added task comment.",
        ),
      ),
    );
    server.registerTool(
      "link_task_to_session",
      {
        title: "Link Task To Session",
        description:
          "Associate a project task with an exposed OpenCode work session and optional message/result/artifact references. Distinct messages of one session remain distinct links.",
        inputSchema: linkTaskInput,
        outputSchema: z
          .object({
            task_id: taskId,
            links: z.array(
              z
                .object({
                  session_id: sessionId,
                  message_id: sessionId.optional(),
                  result: z.string().optional(),
                  artifact_refs: z.array(z.string()).optional(),
                })
                .strict(),
            ),
          })
          .strict(),
        annotations: writeAnnotations,
      },
      safeHandler(async (input) => {
        try { await gateway.getSessionDetails(input.session_id); }
        catch (error) { return errorResult(error instanceof AdapterError ? error :
          new AdapterError("INTERNAL_ERROR", "The MCP adapter could not verify the session.")); }
        return success(
          await board.linkTask(input.task_id, {
            sessionId: input.session_id,
            messageId: input.message_id,
            result: input.result,
            artifactRefs: input.artifact_refs,
          }),
          "Linked task to session.",
        );
      }),
    );
    server.registerTool(
      "transfer_project_task",
      {
        title: "Transfer Project Task",
        description:
          "Transfer a task between board scopes. Only project-local scope exists in this first phase; this tool fails closed until a global store is enabled.",
        inputSchema: transferTaskInput,
        outputSchema: z
          .object({
            task_id: taskId,
            target_scope: z.string(),
            state: z.literal("transferred"),
          })
          .strict(),
        annotations: writeAnnotations,
      },
      safeHandler(async (input) => {
        await board.transferTask();
        return success(
          {
            task_id: input.task_id,
            target_scope: input.target_scope,
            state: "transferred",
          },
          "Task transfer completed.",
        );
      }),
    );
  }

  const progressHandler = safeHandler(
    async (input: z.output<typeof getSessionStatusInputSchema>) => {
      const result = await gateway.getSessionProgress(
        input.session_id,
        input.message_id,
      );
      return readSuccess(
        result,
        result.idle_with_in_flight_tools
          ? "Session is idle alongside stored pending/running tools: do not infer tool-process liveness. Check coverage and observation times."
          : "Stored tool snapshot, not a percentage or task success report. Pending input counts are session-wide; check coverage and observation times.",
      );
    },
  );
  server.registerTool(
    "get_session_progress",
    {
      title: "Get Session Tool Progress",
      description:
        "Inspect stored tool metadata in the newest 100 messages: up to ten pending/running tools, last tool finished, timestamps and parent-based task IDs. Optional message_id filters to that submitted user message. Completed tools do not prove command/task success. No arguments, titles, outputs or reasoning are exposed. Empty/bounded observations do not prove inactivity; pending input remains session-wide. A normal read, not a new event subscription.",
      inputSchema: getSessionStatusInputSchema,
      outputSchema: sessionProgressOutput,
      annotations: readOnlyAnnotations,
    },
    progressHandler,
  );

  const getMessageHandler = safeHandler(
    async (input: z.output<typeof getMessageInput>) => {
      const result = await gateway.getMessage(
        input.session_id,
        input.message_id,
        input.include_archived,
      );
      return readSuccess(
        result,
        "Message preview and revision-bound content_ref. Use read_message_content to retrieve the original text.",
      );
    },
  );
  const readContentHandler = safeHandler(
    async (input: z.output<typeof readContentInput>) => {
      const result = await gateway.readMessageContent(
        input.content_ref,
        input.cursor,
        input.max_bytes,
      );
      return readSuccess(
        result,
        result.has_more
          ? "Content page. Continue with the same content_ref and next_cursor."
          : "End of this revision. Verify concatenated UTF-8 text against sha256; this does not imply a regular model finish.",
      );
    },
  );
  const taskResultHandler = safeHandler(
    async (input: z.output<typeof taskResultInput>) => {
      const result = await gateway.getTaskResult(
        input.session_id,
        input.submitted_message_id,
        input.cursor,
        input.limit,
        undefined,
        input.include_archived,
      );
      return readSuccess(
        result,
        result.search_complete
          ? result.superseded_by_message_id
            ? `Result search complete: the original receipt has no terminal assistant result, but the latest later user turn is complete (${result.superseded_by_message_id}). The old receipt may be superseded for admission; its own task state remains unknown.`
            : "Result search complete for this observed session boundary. Read terminal message content_refs; pages are newest first."
          : "Result search incomplete. Save message references and continue with next_cursor, even for an empty page; unknown does not mean absent.",
      );
    },
  );
  server.registerTool(
    "get_message",
    {
      title: "Get Stored Message",
      description:
        "Read one known visible user/assistant message directly: identity, parent, finish, preview, omissions and content_ref. Set include_archived=true to read an archived project session by ID. Never starts model work. Read references expire on adapter restart; reacquire with IDs. CONTENT_CHANGED requires restarting the new revision.",
      inputSchema: getMessageInput,
      outputSchema: getMessageOutput,
      annotations: readOnlyAnnotations,
    },
    getMessageHandler,
  );
  server.registerTool(
    "read_message_content",
    {
      title: "Read Message Content",
      description:
        "Read original visible text in bounded UTF-8 pages using content_ref from get_message, history or get_task_result. Keep the same reference and follow next_cursor until has_more=false. max_bytes bounds text bytes, not the JSON response. Verify concatenation with sha256. Changed text reports CONTENT_CHANGED, never mixed revisions. Does not acknowledge/read-mark results.",
      inputSchema: readContentInput,
      outputSchema: readContentOutput,
      annotations: readOnlyAnnotations,
    },
    readContentHandler,
  );
  server.registerTool(
    "get_task_result",
    {
      title: "Find Task Result",
      description:
        "Find results by the original submitted user message ID, including older tasks beyond 100 messages. Set include_archived=true for archived project sessions by ID, including on cursor continuation. Bounded backward search: follow next_cursor until search_complete, retaining returned references (newest first). Intermediate tool-call steps are not reports. If a nonterminal old turn was overtaken, superseded_by_message_id identifies only a latest later user turn with its own terminal stop assistant; the requested old task remains unknown. SEARCH_CHANGED means restart the search. Read terminal originals with read_message_content; finish=length/content-filter is not a regular generation finish. No new model call or native MCP task.",
      inputSchema: taskResultInput,
      outputSchema: taskResultOutput,
      annotations: readOnlyAnnotations,
    },
    taskResultHandler,
  );

  const listSessionsHandler = safeHandler(
    async ({
      limit,
      cursor: value,
    }: z.output<typeof listSessionsInputSchema>) => {
      const result = await gateway.listSessions(limit, value);
      return success(
        result,
        `Found ${result.sessions.length} exposed session${result.sessions.length === 1 ? "" : "s"} for ${result.project.name}.`,
      );
    },
  );
  const getSessionHandler = safeHandler(
    async ({
      session_id,
      include_archived,
    }: z.output<typeof getSessionInputSchema>) => {
      const result = await gateway.getSessionDetails(
        session_id,
        include_archived,
      );
      return success(result, `Session ${result.id} is ${result.activity}.`);
    },
  );
  const getSessionStatusHandler = safeHandler(
    async ({
      session_id,
      message_id,
    }: z.output<typeof getSessionStatusInputSchema>) => {
      const result = await gateway.getSessionStatus(session_id, message_id);
      return success(
        result,
        message_id
          ? `Message ${message_id} is ${result.state}; session activity is ${result.backend_activity}.`
          : `Session ${session_id} activity is ${result.backend_activity}.`,
      );
    },
  );
  const getSessionHistoryHandler = safeHandler(
    async ({
      session_id,
      limit,
      before,
      include_archived,
    }: z.output<typeof getSessionHistoryInputSchema>) => {
      const result = await gateway.getSessionHistory(
        session_id,
        limit,
        before,
        include_archived,
      );
      return readSuccess(
        result,
        `Returned ${result.messages.length} text message${result.messages.length === 1 ? "" : "s"} from session ${session_id}.`,
      );
    },
  );
  const sendMessageHandler = safeHandler(
    async ({
      session_id,
      message,
      attachments,
    }: z.output<typeof sendMessageInputSchema>) => {
      const result = await gateway.sendMessage(
        session_id,
        message,
        attachments,
      );
      return success(
        result,
        `Submitted message ${result.message_id} to session ${result.session_id}${result.attachments?.length ? ` with ${result.attachments.length} attachment${result.attachments.length === 1 ? "" : "s"}` : ""}. Poll get_session_status before sending another message.`,
      );
    },
  );
  const supersedeSubmissionHandler = safeHandler(
    async (input: z.output<typeof supersedeSubmissionInputSchema>) => {
      const result = await gateway.supersedeUnresolvedSubmission({
        sessionId: input.session_id,
        guardedMessageId: input.guarded_message_id,
        requestId: input.request_id,
        operatorAuthorized: input.operator_authorized,
        message: input.message,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.attachments ? { attachmentIds: input.attachments } : {}),
      });
      return success(
        result,
        `Operator override superseded guard ${result.guarded_message_id} and submitted exactly one new message ${result.message_id}. Verify that exact message_id before any further submission.`,
      );
    },
  );

  const uploadAttachmentHandler = safeHandler(
    async ({
      session_id,
      filename,
      mime_type,
      data_base64,
    }: z.output<typeof uploadAttachmentInputSchema>) => {
      const result = await gateway.uploadAttachment(
        session_id,
        filename,
        mime_type,
        data_base64,
      );
      return success(
        result,
        `Uploaded ${result.filename} as ${result.attachment_id}; the reference expires at ${result.expires_at}.`,
      );
    },
  );

  const createSessionHandler = safeHandler(
    async ({ title }: z.output<typeof createSessionInputSchema>) => {
      const result = await gateway.createSession(title);
      return success(
        result,
        `Created session ${result.session_id} (${result.title}) for ${result.project.name} using ${result.agent} and ${result.provider_id}/${result.model_id}. Use send_message with this session_id to start work.`,
      );
    },
  );
  const archiveSessionHandler = safeHandler(
    async ({ session_id }: z.output<typeof archiveSessionInputSchema>) =>
      success(
        await gateway.archiveSession(session_id),
        `Session ${session_id} archived. Use include_archived=true on ID-based stored-content reads.`,
      ),
  );
  const renameSessionHandler = safeHandler(
    async ({ session_id, title }: z.output<typeof renameSessionInputSchema>) =>
      success(
        await gateway.renameSession(session_id, title),
        `Session ${session_id} renamed to "${title.trim()}".`,
      ),
  );

  const optionsHandler = safeHandler(
    async ({ session_id }: z.output<typeof runtimeOptionsInput>) =>
      success(
        await gateway.getSessionRuntimeOptions(session_id),
        "Available primary agents, connected providers, models and variants.",
      ),
  );
  const updateHandler = safeHandler(
    async ({ session_id, ...patch }: z.output<typeof runtimeUpdateInput>) =>
      success(
        await gateway.updateSessionRuntime(session_id, patch),
        `Updated runtime settings for session ${session_id}.`,
      ),
  );
  const activityHandler = safeHandler(
    async (query: z.output<typeof activityInput>) => {
      const result = await gateway.getProjectActivity(query);
      return success(
        result,
        result.tail
          ? `Returned ${result.events.length} recent events; tail selection ${result.tail.selection_complete ? "complete" : "incomplete due to scan budget"}. Older history is not acknowledged. Save next_cursor under filter_key; continue without tail.`
          : `Returned ${result.events.length} project activity events. Save next_cursor separately for this filter_key.`,
      );
    },
  );
  const waitHandler = safeHandler(
    async (query: z.output<typeof waitActivityInput>) => {
      const result = await gateway.waitForProjectActivity(query);
      return success(
        result,
        result.timeout
          ? "Activity wait timed out; save next_cursor separately for this filter_key."
          : `Returned ${result.events.length} activity events; save next_cursor separately for this filter_key.`,
      );
    },
  );
  server.registerTool(
    "get_session_runtime_options",
    {
      title: "Get Session Runtime Options",
      description:
        "List available primary agents and connected provider/model/variant combinations. Optionally include a session's current runtime.",
      inputSchema: runtimeOptionsInput,
      outputSchema: runtimeOptionsOutput,
      annotations: readOnlyAnnotations,
    },
    optionsHandler,
  );
  server.registerTool(
    "update_session_runtime",
    {
      title: "Update Session Runtime",
      description:
        "Change specified agent/provider/model/variant fields of an idle project session. Omitted fields stay unchanged. Query options first. Busy sessions are rejected; failed updates may be partial and must not be retried automatically.",
      inputSchema: runtimeUpdateInput,
      outputSchema: runtimeUpdateOutput,
      annotations: { ...writeAnnotations, openWorldHint: false },
    },
    updateHandler,
  );
  const modelPolicyHandler = safeHandler(async () => {
    if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
    const policy = await readPolicy(runtime);
    const catalog = await gateway.getSessionRuntimeOptions().catch(() => undefined);
    return success(describePolicy(runtime, policy, catalog), "Project runtime profile policy and validation.");
  });
  const recommendedHandler = safeHandler(async ({ profile }: z.output<typeof recommendedInput>) => {
    if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
    const policy = await readPolicy(runtime);
    const catalog = await gateway.getSessionRuntimeOptions().catch(() => undefined);
    const result = resolveProfile(policy, profile, catalog);
    return success(result,
      result.status === "available" ? "The configured runtime is currently listed." : "No runtime was selected; inspect the status before submitting work.");
  });
  server.registerTool(
    "get_project_model_policy",
    { title: "Get Project Model Policy", description: "Read schema 1/2 preferences for deep, standard, execution, design and review with catalog validation and fixed absence fallbacks.",
      inputSchema: z.object({}).strict(), outputSchema: modelPolicyOutput, annotations: readOnlyAnnotations },
    modelPolicyHandler,
  );
  server.registerTool(
    "get_recommended_runtime",
    { title: "Get Recommended Runtime", description: "Resolve an exact runtime. Design falls back to standard; review to deep then standard. Only null is skipped; configured unavailable/incomplete mappings stop. Review evaluates without automatically implementing findings. Does not switch any session.",
      inputSchema: recommendedInput, outputSchema: recommendedOutput, annotations: readOnlyAnnotations },
    recommendedHandler,
  );
  server.registerTool(
    "get_project_activity",
    {
      title: "Get Project Activity",
      description:
        "Read the bounded persistent project journal. Set tail=true WITHOUT after_cursor for the latest matching retained events, then continue after next_cursor without tail. Tail is a recent window, not complete historical consumption; check tail.selection_complete and tracking. Save a separate cursor per filter_key; changing filters must not reuse another filter's progress. CURSOR_EXPIRED requires an explicit fresh start. Completion IDs can be read with get_task_result/get_message.",
      inputSchema: activityInput,
      outputSchema: activityOutput,
      annotations: readOnlyAnnotations,
    },
    activityHandler,
  );
  server.registerTool(
    "wait_for_project_activity",
    {
      title: "Wait For Project Activity",
      description:
        "Wait up to 15 seconds for matching project activity after a cursor; returns timeout=true when no matching event arrives. Use a cursor saved for this exact filter_key (including after a tail read); keep filter progress separate. This is short polling, not external push.",
      inputSchema: waitActivityInput,
      outputSchema: waitActivityOutput,
      annotations: readOnlyAnnotations,
    },
    waitHandler,
  );

  server.registerTool(
    "create_session",
    {
      title: "Create OpenCode Session",
      description:
        "Create an empty root work session in this configured project using OpenCode's default work agent/model. Backend work creation automatically adopts agent-managed policy; no client flag is needed. Reads and pure management do not adopt manual sessions. Returns session_id; call send_message separately to start work. Non-idempotent: do not retry automatically if creation is uncertain.",
      inputSchema: createSessionInputSchema,
      outputSchema: createSessionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createSessionHandler,
  );
  server.registerTool(
    "archive_session",
    {
      title: "Archive OpenCode Session",
      description:
        "Archive an idle project work session without deleting history. Requires an explicit request. Refuses busy/pending/unresolved sessions; do not retry an uncertain archive blindly. Archived sessions are omitted from normal views; use include_archived=true on ID-based reads.",
      inputSchema: archiveSessionInputSchema,
      outputSchema: archiveSessionOutputSchema,
      annotations: { ...writeAnnotations, openWorldHint: false },
    },
    archiveSessionHandler,
  );

  server.registerTool(
    "rename_session",
    {
      title: "Rename OpenCode Session",
      description:
        "Rename an existing idle root work session in this project by updating OpenCode's native session title. Session ID, history, messages, runtime and archive state are preserved. Archived or otherwise unexposed sessions return SESSION_NOT_FOUND; busy or pending-input sessions are refused. Inspect get_session if the result is RENAME_UNCERTAIN.",
      inputSchema: renameSessionInputSchema,
      outputSchema: renameSessionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    renameSessionHandler,
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List OpenCode Sessions",
      description:
        "List bounded root work sessions for this configured project.",
      inputSchema: listSessionsInputSchema,
      outputSchema: listSessionsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    listSessionsHandler,
  );

  server.registerTool(
    "get_session",
    {
      title: "Get OpenCode Session",
      description:
        "Inspect one root work session: current runtime, backend activity, session-wide pending input and MCP admission tracking. Set include_archived=true for an archived project session by ID (archived_at is returned). Backend idle does not prove an old receipt is terminal. Use this compact view for settings; request the full catalog only when choosing settings.",
      inputSchema: getSessionInputSchema,
      outputSchema: sessionDetailsOutputSchema,
      annotations: readOnlyAnnotations,
    },
    getSessionHandler,
  );

  server.registerTool(
    "get_session_status",
    {
      title: "Get OpenCode Session Status",
      description:
        "Inspect backend activity and a correlated task (newest 100 messages), including active assistant evidence and MCP admission tracking. Session busy alone never proves this task is running; pending counts are session-wide. Without message_id no task was requested. Use get_task_result for older tasks/terminal evidence. Unknown is not completed or failed.",
      inputSchema: getSessionStatusInputSchema,
      outputSchema: sessionStatusOutputSchema,
      annotations: readOnlyAnnotations,
    },
    getSessionStatusHandler,
  );

  server.registerTool(
    "get_session_history",
    {
      title: "Get OpenCode Session History",
      description:
        "Read bounded user/assistant text previews. Set include_archived=true for archived project sessions by ID, including on pagination. history_has_more concerns older messages; text_truncated concerns a preview. Follow content_ref with read_message_content for the complete visible original. Omissions are explicit; tool output and reasoning are not exposed. For a known task prefer get_task_result.",
      inputSchema: getSessionHistoryInputSchema,
      outputSchema: historyOutputSchema,
      annotations: readOnlyAnnotations,
    },
    getSessionHistoryHandler,
  );

  server.registerTool(
    "upload_attachment",
    {
      title: "Upload OpenCode Attachment",
      description:
        "Upload one validated PNG, JPEG, WebP, plain-text or Markdown file for an exposed project session. Supply canonical Base64 bytes, never a path. Returns a session-bound, one-use attachment_id that expires after ten minutes; pass up to four IDs (10 MiB total) in send_message.attachments. Images are limited to 5 MiB and text to 512 KiB each.",
      inputSchema: uploadAttachmentInputSchema,
      outputSchema: uploadAttachmentOutputSchema,
      annotations: {
        ...writeAnnotations,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    uploadAttachmentHandler,
  );

  server.registerTool(
    "send_message",
    {
      title: "Send OpenCode Message",
      description:
        "Submit one asynchronous prompt; this can run commands and change project files. Backend work admission automatically adopts agent-managed policy without a client flag. Missing business decisions return ordinary terminal INPUT_REQUIRED text for a normal same-session follow-up; independent real security permissions remain separate. Optional attachments are one-use attachment_id values returned by upload_attachment, never paths. Non-idempotent: do not blindly retry an uncertain request. SESSION_BUSY means active backend work, pending input, or a concurrent MCP write. Historical receipt uncertainty does not block a technically idle session; inspect old receipts separately with get_task_result. SUBMISSION_UNCERTAIN means delivery may already have occurred; the exact same immediate retry is protected, while a different authorized follow-up may proceed when the backend is idle. Associated attachment references are consumed.",
      inputSchema: sendMessageInputSchema,
      outputSchema: sendMessageOutputSchema,
      annotations: writeAnnotations,
    },
    sendMessageHandler,
  );

  server.registerTool(
    "supersede_unresolved_submission",
    {
      title: "Supersede Unresolved Submission",
      description:
        "Legacy explicit guard override for clients that need an auditable resolution record. Normal conversation continuation does not require this tool: an unresolved historical receipt does not block a technically idle session, and MCP does not decide whether prompts are duplicate tasks. Requires the client-generated UUID request_id to be reused unchanged for recovery, operator_authorized=true, and optionally a short reason. A stale/mismatched guard conflicts. Repeated identical request_id returns the recorded receipt or SUBMISSION_UNCERTAIN and never submits twice. This is an operator attestation, not independent human identity verification.",
      inputSchema: supersedeSubmissionInputSchema,
      outputSchema: supersedeSubmissionOutputSchema,
      annotations: { ...writeAnnotations, idempotentHint: true },
    },
    supersedeSubmissionHandler,
  );

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const input = request.params.arguments ?? {};
      return traceToolCall(request.params.name, input, async () => {
        try {
        switch (request.params.name) {
          case "get_session_progress":
            return validatedToolCall(
              getSessionStatusInputSchema,
              sessionProgressOutput,
              input,
              progressHandler,
              extra.requestId,
              request.params.name,
            );
          case "get_message":
            return validatedToolCall(
              getMessageInput,
              getMessageOutput,
              input,
              getMessageHandler,
              extra.requestId,
              request.params.name,
            );
          case "read_message_content":
            return validatedToolCall(
              readContentInput,
              readContentOutput,
              input,
              readContentHandler,
              extra.requestId,
              request.params.name,
            );
          case "get_task_result":
            return validatedToolCall(
              taskResultInput,
              taskResultOutput,
              input,
              taskResultHandler,
              extra.requestId,
              request.params.name,
            );
          case "get_session_runtime_options":
            return validatedToolCall(
              runtimeOptionsInput,
              runtimeOptionsOutput,
              input,
              optionsHandler,
            );
          case "update_session_runtime":
            return validatedToolCall(
              runtimeUpdateInput,
              runtimeUpdateOutput,
              input,
              updateHandler,
            );
          case "get_project_model_policy":
            return validatedToolCall(z.object({}).strict(), modelPolicyOutput, input, modelPolicyHandler);
          case "get_recommended_runtime":
            return validatedToolCall(recommendedInput, recommendedOutput, input, recommendedHandler);
          case "get_project_activity":
            return validatedToolCall(
              activityInput,
              activityOutput,
              input,
              activityHandler,
            );
          case "wait_for_project_activity":
            return validatedToolCall(
              waitActivityInput,
              waitActivityOutput,
              input,
              waitHandler,
            );
          case "create_session":
            return validatedToolCall(
              createSessionInputSchema,
              createSessionOutputSchema,
              input,
              createSessionHandler,
            );
          case "archive_session":
            return validatedToolCall(
              archiveSessionInputSchema,
              archiveSessionOutputSchema,
              input,
              archiveSessionHandler,
            );
          case "rename_session":
            return validatedToolCall(
              renameSessionInputSchema,
              renameSessionOutputSchema,
              input,
              renameSessionHandler,
            );
          case "list_sessions":
            return validatedToolCall(
              listSessionsInputSchema,
              listSessionsOutputSchema,
              input,
              listSessionsHandler,
            );
          case "get_session":
            return validatedToolCall(
              getSessionInputSchema,
              sessionDetailsOutputSchema,
              input,
              getSessionHandler,
            );
          case "get_session_status":
            return validatedToolCall(
              getSessionStatusInputSchema,
              sessionStatusOutputSchema,
              input,
              getSessionStatusHandler,
            );
          case "get_session_history":
            return validatedToolCall(
              getSessionHistoryInputSchema,
              historyOutputSchema,
              input,
              getSessionHistoryHandler,
              extra.requestId,
              request.params.name,
            );
          case "send_message":
            return validatedToolCall(
              sendMessageInputSchema,
              sendMessageOutputSchema,
              input,
              sendMessageHandler,
            );
          case "supersede_unresolved_submission":
            return validatedToolCall(
              supersedeSubmissionInputSchema,
              supersedeSubmissionOutputSchema,
              input,
              supersedeSubmissionHandler,
            );
          case "upload_attachment":
            return validatedToolCall(
              uploadAttachmentInputSchema,
              uploadAttachmentOutputSchema,
              input,
              uploadAttachmentHandler,
            );
          case "list_board_projects":
            return validatedToolCall(z.object({}).strict(), z.object({ projects: z.array(boardProjectOutput) }).strict(),
              input, async () => board ? success({ projects: await board.listBoardProjects() }, "Returned Board Projects.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "get_board_project":
            return validatedToolCall(getBoardProjectInput, boardProjectOutput, input,
              async (value) => board ? success(await board.getBoardProject(value.board_project_id), "Returned Board Project.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "create_board_project":
            return validatedToolCall(createBoardProjectInput, boardProjectOutput, input,
              async (value) => board ? success(await board.createBoardProject({ name: value.name,
                prefix: value.prefix, makeDefault: value.make_default }), "Created Board Project.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "get_task_transfer_status":
            return validatedToolCall(transferStatusInput, transferStatusOutput, input,
              async (value) => board ? success(await board.getTransferStatus(value.request_id), "Returned transfer state.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "reclassify_project_task":
            return validatedToolCall(reclassifyTaskInput, transferStatusOutput, input,
              async (value) => board ? success(await board.reclassifyTask({ taskId: value.task_id,
                targetBoardProjectId: value.target_board_project_id, expectedSourceBoardProjectId: value.expected_source_board_project_id,
                requestId: value.request_id }), "Transferred project task.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "list_project_tasks":
            return await validatedToolCall(
              listTasksInput,
              z.object({ tasks: z.array(taskOutput) }).strict(),
              input,
              async (value) =>
                board
                  ? success(
                      {
                        tasks: await board.listTasks({
                          projectId: value.project_id,
                          boardProjectId: value.board_project_id,
                          status: value.status,
                          query: value.query,
                          sessionId: value.session_id,
                          updatedSince: value.updated_since,
                          includeTerminal: value.include_terminal,
                        }),
                      },
                      "Returned project tasks.",
                    )
                  : errorResult(
                      new AdapterError(
                        "TASKBOARD_UNAVAILABLE",
                        "Taskboard is not enabled.",
                      ),
                    ),
            );
          case "get_project_task":
            return await validatedToolCall(
              getTaskInput,
              taskOutput,
              input,
              async (value) =>
                board
                  ? success(
                      await board.getTask(value.task_id),
                      "Returned project task.",
                    )
                  : errorResult(
                      new AdapterError(
                        "TASKBOARD_UNAVAILABLE",
                        "Taskboard is not enabled.",
                      ),
                    ),
            );
          case "add_task_management_note":
            return await validatedToolCall(managementNoteInput, taskOutput, input,
              async (value) => board ? success(await board.addManagementNote(value.task_id, value.note), "Added task management note.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "get_task_management_history":
            return await validatedToolCall(managementHistoryInput, managementHistoryOutput, input,
              async (value) => board ? readSuccess(await board.getManagementHistory(value.task_id,
                { mode: value.mode, limit: value.limit, cursor: value.cursor }, value.legacy_offset,
                value.legacy_revision, value.legacy_max_bytes), "Returned bounded task management history.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")),
              extra.requestId, request.params.name);
          case "add_task_document_bindings":
            return await validatedToolCall(documentBindingsInput, documentRefsOutput, input,
              async (value) => board ? success(await board.addDocumentBindings(value.task_id,
                { compactContext: value.compact_context, conceptPlan: value.concept_plan }), "Added task document bindings.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "register_task_document":
            return await validatedToolCall(registerDocumentInput, documentRefsOutput, input,
              async (value) => board ? success(await board.registerDocument(value.task_id,
                value.role as DocumentRole, value.path, value.expected_path), "Registered task document.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")));
          case "get_task_documents":
            return await validatedToolCall(getTaskInput, documentListOutput, input,
              async (value) => board ? readSuccess(await board.getDocuments(value.task_id), "Returned task document references.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")),
              extra.requestId, request.params.name);
          case "read_task_document":
            return await validatedToolCall(readDocumentInput, documentContentOutput, input,
              async (value) => board ? readSuccess(await board.readDocument(value.task_id, value.role as DocumentRole,
                value.path, value.offset, value.max_bytes, value.revision), "Returned task document page.") :
                errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled.")),
              extra.requestId, request.params.name);
          case "create_project_task":
            return await validatedToolCall(
              createTaskInput,
              taskOutput,
              input,
              async (value) =>
                board
                  ? success(
                      await board.createTask({
                        projectId: value.project_id,
                        boardProjectId: value.board_project_id,
                        title: value.title,
                        description: value.description,
                        priority: value.priority,
                        status: value.status,
                      }),
                      "Created project task.",
                    )
                  : errorResult(
                      new AdapterError(
                        "TASKBOARD_UNAVAILABLE",
                        "Taskboard is not enabled.",
                      ),
                    ),
            );
          case "update_project_task":
            return await validatedToolCall(
              updateTaskInput,
              taskOutput,
              input,
              async (value) =>
                board
                  ? success(
                      await board.updateTask(value.task_id, {
                        title: value.title,
                        description: value.description,
                        priority: value.priority,
                        status: value.status,
                      }),
                      "Updated project task.",
                    )
                  : errorResult(
                      new AdapterError(
                        "TASKBOARD_UNAVAILABLE",
                        "Taskboard is not enabled.",
                      ),
                    ),
            );
          case "move_project_task":
            return await validatedToolCall(
              moveTaskInput,
              taskOutput,
              input,
              async (value) =>
                board
                  ? success(
                      await board.moveTask(
                        value.task_id,
                        value.status,
                        value.position,
                      ),
                      "Moved project task.",
                    )
                  : errorResult(
                      new AdapterError(
                        "TASKBOARD_UNAVAILABLE",
                        "Taskboard is not enabled.",
                      ),
                    ),
            );
          case "add_task_comment":
            return await validatedToolCall(
              commentInput,
              z
                .object({
                  task_id: taskId,
                  comment: z
                    .object({
                      id: z.string(),
                      body: z.string(),
                      created_at: z.string(),
                    })
                    .strict(),
                })
                .strict(),
              input,
              async (value) =>
                board
                  ? success(
                      await board.addComment(value.task_id, value.body),
                      "Added task comment.",
                    )
                  : errorResult(
                      new AdapterError(
                        "TASKBOARD_UNAVAILABLE",
                        "Taskboard is not enabled.",
                      ),
                    ),
            );
          case "link_task_to_session":
            return await validatedToolCall(
              linkTaskInput,
              z
                .object({
                  task_id: taskId,
                  links: z.array(
                    z
                      .object({
                        session_id: sessionId,
                        message_id: sessionId.optional(),
                        result: z.string().optional(),
                        artifact_refs: z.array(z.string()).optional(),
                      })
                      .strict(),
                  ),
                })
                .strict(),
              input,
              async (value) => {
                if (!board) return errorResult(new AdapterError("TASKBOARD_UNAVAILABLE", "Taskboard is not enabled."));
                try { await gateway.getSessionDetails(value.session_id); }
                catch (error) { return errorResult(error instanceof AdapterError ? error :
                  new AdapterError("INTERNAL_ERROR", "The MCP adapter could not verify the session.")); }
                return success(await board.linkTask(value.task_id, {
                  sessionId: value.session_id,
                  messageId: value.message_id,
                  result: value.result,
                  artifactRefs: value.artifact_refs,
                }), "Linked task to session.");
              },
            );
          case "transfer_project_task":
            return await validatedToolCall(
              transferTaskInput,
              z
                .object({
                  task_id: taskId,
                  target_scope: z.string(),
                  state: z.literal("transferred"),
                })
                .strict(),
              input,
              async (value) => {
                if (!board)
                  return errorResult(
                    new AdapterError(
                      "TASKBOARD_UNAVAILABLE",
                      "Taskboard is not enabled.",
                    ),
                  );
                await board.transferTask();
                return success(
                  {
                    task_id: value.task_id,
                    target_scope: value.target_scope,
                    state: "transferred",
                  },
                  "Task transfer completed.",
                );
              },
            );
          default:
            return errorResult(
              new AdapterError("INVALID_ARGUMENT", "Tool name is invalid."),
            );
        }
        } catch (error) {
          return errorResult(error instanceof AdapterError ? error :
            new AdapterError("INTERNAL_ERROR", "The MCP adapter could not complete the request."));
        }
      });
    },
  );

  return server;
}

async function validatedToolCall<Input>(
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType,
  input: unknown,
  handler: (input: Input) => Promise<CallToolResult>,
  readRequestId?: string | number,
  readTool?: string,
): Promise<CallToolResult> {
  const parsed = await inputSchema.safeParseAsync(input);
  if (!parsed.success) {
    return errorResult(
      new AdapterError("INVALID_ARGUMENT", "Tool arguments are invalid."),
    );
  }
  const result = await handler(parsed.data);
  if (result.isError) return result;
  const output = await outputSchema.safeParseAsync(result.structuredContent);
  if (!output.success) {
    return errorResult(
      new AdapterError(
        "INTERNAL_ERROR",
        "The MCP adapter produced an invalid result.",
      ),
    );
  }
  if (readRequestId !== undefined) {
    const responseBytes = jsonBytes({
      jsonrpc: "2.0",
      id: readRequestId,
      result,
    });
    if (responseBytes > READ_RESPONSE_BYTES)
      return errorResult(
        new AdapterError(
          "RESPONSE_BUDGET_EXCEEDED",
          "Read response exceeds the serialized budget; reduce the page size.",
        ),
      );
    const data = result.structuredContent!;
    const message = isRecord(data.message) ? data.message : undefined;
    const descriptor = isRecord(message?.content) ? message.content : undefined;
    // Known metadata only: never text, references/cursors, arguments or outputs.
    process.stderr.write(
      `[mcp] read=${JSON.stringify({
        request: randomUUID(),
        tool: readTool,
        session_id: data.session_id,
        message_id: data.message_id ?? data.submitted_message_id ?? message?.id,
        revision: data.revision ?? descriptor?.revision,
        total_bytes: data.total_bytes ?? descriptor?.total_bytes,
        delivered_text_bytes:
          typeof data.text === "string"
            ? Buffer.byteLength(data.text)
            : undefined,
        reason: message?.truncation_reason ?? data.state_reason,
        response_bytes: responseBytes,
        budget_bytes: READ_RESPONSE_BYTES,
      })}\n`,
    );
  }
  return result;
}

function readSuccess(value: object, text: string): CallToolResult {
  const result = success(value, text);
  if (jsonBytes(result) > READ_RESPONSE_BYTES - 2048)
    throw new AdapterError(
      "RESPONSE_BUDGET_EXCEEDED",
      "Read response exceeds the serialized budget; reduce the page size.",
    );
  return result;
}

function safeHandler<Arguments>(
  handler: (input: Arguments) => Promise<CallToolResult>,
): (input: Arguments) => Promise<CallToolResult> {
  return async (input) => {
    const requestId = randomUUID();
    try {
      return await handler(input);
    } catch (error) {
      const safe =
        error instanceof AdapterError
          ? error
          : new AdapterError(
              "INTERNAL_ERROR",
              "The MCP adapter could not complete the request.",
            );
      return errorResult(safe, requestId);
    }
  };
}

function errorResult(
  error: AdapterError,
  requestId = randomUUID(),
): CallToolResult {
  process.stderr.write(
    `[mcp] request=${requestId} error=${error.code}${error.reason ? ` reason=${error.reason}` : ""}\n`,
  );
  return {
    isError: true,
    _meta: {
      "opencode-vm/error": {
        code: error.code,
        message: error.message,
        ...(error.correlationId ? { message_id: error.correlationId } : {}),
        ...(error.reason ? { reason: error.reason } : {}),
      },
    },
    content: [
      {
        type: "text",
        text: `${error.code}: ${error.message}${error.correlationId ? ` Correlation message_id: ${error.correlationId}.` : ""}`,
      },
    ],
  };
}

function success(value: object, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...value },
  };
}
