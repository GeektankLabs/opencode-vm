import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { SessionGateway } from "./opencode.js";
import { validateScopeDirs, validateScopeReadFiles } from "./opencode.js";
import type { DashboardControl } from "./dashboard.js";
import type { RuntimeDescriptor, RuntimeUpdateResult } from "./types.js";
import { ProjectBoardService, MAX_TASK_DESCRIPTION_LENGTH } from "./taskboard.js";
import type { DocumentRole } from "./taskboard.js";
import { traceToolCall } from "./diagnostics.js";
import { SUPPORTED_ATTACHMENT_TYPES } from "./attachments.js";
import { PROFILE_NAMES, describePolicy, isRecoveryProviderAdmission, profileState, readPolicy, resolveProfile, resolveRecoveryChain, runtimeIdentityKey, type PolicySelection, type ProfileName } from "./agent-control.js";
import { commitFinalFallback, commitProfileFallback, commitSlotDisabled, commitStrategies } from "./policy-commit.js";
import { getOrder, mutateRecoveryOrder, nextOrder, readRecoveryStore, recordAdmission, withRecoverySubmissionLock, MAX_RECOVERY_ATTEMPTS } from "./order-recovery.js";
import {
  confirmWorkerCreation,
  defaultMonitorRecord,
  ensureManagerAlias,
  getWorker,
  monitorHistory,
  readRegistrySnapshot,
  rebindWorker,
  reconcileWorkerCreate,
  reserveWorker,
  reuseWorker,
  setWorkerLifecycle,
  setWorkerSynthesis,
  validateInvestigationConfigInput,
  withRegistry,
} from "./monitor.js";
import type { MonitorInvestigationState, MonitorRecord, MonitorWorkerRecord } from "./monitor.js";
import type { CreateSessionResult } from "./types.js";

import {
  ACTIVITY_TYPES,
  ADAPTER_VERSION,
  AdapterError,
  isRecord,
  MAX_CORRELATED_ERROR_DETAILS,
} from "./types.js";
import {
  DEFAULT_CONTENT_BYTES,
  MAX_ERROR_DETAIL_IDENTIFIER_BYTES,
  MAX_ERROR_DETAIL_MESSAGE_BYTES,
  MAX_CONTENT_BYTES,
  READ_RESPONSE_BYTES,
  isSafeAssistantErrorDetail,
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
// Pending-input coverage over the session's descendant line, mirroring the
// wire types (types.ts PendingCoverage) and every runtime emitter
// (pendingCounts/combinedPending/correlatedStatus). "unknown" must stay a
// first-class honest value — it is never stripped or coerced to a clean zero.
const pendingCoverageSchema = z.enum([
  "session",
  "session+descendants",
  "unknown",
]);
const descendantPermissionSchema = z
  .object({
    session_id: z.string(),
    permission: z.string(),
  })
  .strict();
const pendingScopeSchema = z.enum([
  "session",
  "session+descendants",
  "unknown",
]);
const pendingSchema = z
  .object({
    permissions: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    coverage: pendingCoverageSchema.optional(),
    descendant_permissions: z
      .array(descendantPermissionSchema)
      .max(20)
      .optional(),
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
    pending_input_scope: pendingScopeSchema,
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

const scopeReadFilesSchema = z.array(z.string().min(1).max(512)
  .regex(/^\/(?!$)[^\x00-\x1f\x7f*?\[\]{}\\]+$/u)
  .refine(file => normalize(file) === file && !file.endsWith("/"), "Expected a normalized absolute single file"))
  .min(1).max(16);

export const sendMessageInputSchema = z
  .object({
    session_id: sessionId,
    message: z.string().min(1).max(32_000),
    attachments: z.array(z.string().min(1).max(256)).max(32).optional(),
    scope_read_files: scopeReadFilesSchema.optional(),
    scope_dirs: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(16)
      .optional(),
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
    scope_read_files: scopeReadFilesSchema.optional(),
    scope_dirs: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(16)
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
  "variant_unavailable", "catalog_unavailable", "catalog_incomplete", "hold_disabled"]);
const profileEntry = z.object({ selection: profileSelection.nullable(), status: profileStatus, disabled: z.boolean() }).strict();
const strategySwitch = z.boolean().nullable();
const strategySwitches = z.object({ degrading: strategySwitch, provider_skip: strategySwitch }).strict();
const candidateOrderEntry = z.array(z.string()).nullable();
const resolutionCandidate = z.object({
  label: z.string(),
  disabled: z.boolean(),
  status: z.enum(["selected", "skipped_disabled", "skipped_unavailable", "skipped_provider_scope",
    "skipped_current_failure", "skipped_attempted", "not_evaluated", "available",
    "provider_unavailable", "model_unavailable", "variant_unavailable", "catalog_unavailable", "catalog_incomplete"]),
}).strict();
const resolutionEntry = z.object({
  status: profileStatus,
  resolved_label: z.string().optional(),
  runtime: profileSelection.optional(),
  candidates: z.array(resolutionCandidate),
}).strict();
const modelPolicyOutput = z.object({
  project_id: z.string(), schema_version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), revision: z.number().int().nonnegative(),
  updated_at: z.string().nullable(), catalog_status: z.enum(["complete", "incomplete", "unavailable"]),
  profiles: z.object({ deep: profileEntry, standard: profileEntry, execution: profileEntry, design: profileEntry, review: profileEntry }).strict(),
  fallbacks: z.object({ design: z.array(z.enum(PROFILE_NAMES)), review: z.array(z.enum(PROFILE_NAMES)) }).strict(),
  final_fallback: z.object({
    mode: z.enum(["total", "degrading"]), selection: profileSelection, status: profileStatus, disabled: z.boolean(),
  }).strict().nullable(),
  profile_fallbacks: z.object({ deep: profileEntry, standard: profileEntry, execution: profileEntry, design: profileEntry, review: profileEntry }).strict(),
  strategies: strategySwitches,
  resolution: z.object({ deep: resolutionEntry, standard: resolutionEntry, execution: resolutionEntry,
    design: resolutionEntry, review: resolutionEntry }).strict(),
  routing: z.object({
    regime: z.enum(["legacy_final_fallback", "per_profile"]),
    legacy_final_stage_applies: z.boolean(),
    strategies_effective: z.object({ degrading: z.boolean(), provider_skip: z.boolean() }).strict(),
    candidate_order: z.object({ deep: candidateOrderEntry, standard: candidateOrderEntry, execution: candidateOrderEntry,
      design: candidateOrderEntry, review: candidateOrderEntry }).strict().nullable(),
  }).strict(),
}).strict();
const recommendedInput = z.object({ profile: z.enum(PROFILE_NAMES) }).strict();
const recommendedOutput = z.object({
  profile: z.enum(PROFILE_NAMES), policy_revision: z.number().int().nonnegative(), status: profileStatus,
  runtime: profileSelection.optional(),
  resolution_path: z.array(z.string()), resolved_label: z.string().optional(),
  resolved_profile: z.enum(PROFILE_NAMES).optional(),
  candidates: z.array(resolutionCandidate),
}).strict();
const policyFallbackInput = z.object({
  revision: z.number().int().nonnegative(),
  fallback: z.object({ mode: z.enum(["total", "degrading"]).optional(), selection: profileSelection }).strict().nullable(),
}).strict();
const policyProfileFallbackInput = z.object({
  revision: z.number().int().nonnegative(),
  profile: z.enum(PROFILE_NAMES),
  fallback: profileSelection.nullable(),
}).strict();
const policyStrategiesInput = z.object({
  revision: z.number().int().nonnegative(),
  strategies: strategySwitches,
}).strict();
const slotSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), profile: z.enum(PROFILE_NAMES) }).strict(),
  z.object({ kind: z.literal("profile_fallback"), profile: z.enum(PROFILE_NAMES) }).strict(),
  z.object({ kind: z.literal("final_fallback") }).strict(),
]);
const policySlotDisabledInput = z.object({
  revision: z.number().int().nonnegative(),
  slot: slotSelector,
  disabled: z.boolean(),
}).strict();
const recoverOrderInput = z.object({ session_id: sessionId, message_id: sessionId }).strict();
const recoverOrderOutput = z.object({
  session_id: z.string(), message_id: z.string(),
  attempted_identity: z.string(), final_attempt: z.boolean(),
  new_receipt: z.string(), status: z.enum(["continued", "escalated"]),
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
const attentionInput = z.object({
  after_cursor: z.string().min(1).max(128).optional(),
  before_cursor: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(50).default(25),
  lifecycle: z.array(z.enum(["new", "ready", "offered", "discussed", "superseded"])).min(1).max(5).optional(),
  classification: z.array(z.enum(["ready", "attention", "action_required"])).min(1).max(3).optional(),
}).strict().refine((value) => value.after_cursor === undefined || value.before_cursor === undefined,
  "Use either after_cursor or before_cursor, not both.");
const errorNameSchema = z.enum([
  "APIError",
  "ProviderAuthError",
  "ContextOverflowError",
  "MessageOutputLengthError",
  "StructuredOutputError",
  "ContentFilterError",
  "MessageAbortedError",
]).refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ERROR_DETAIL_IDENTIFIER_BYTES);
const errorCodeSchema = z.enum([
  "ProviderHeaderTimeoutError",
  "ProviderResponseStreamError",
]).refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ERROR_DETAIL_IDENTIFIER_BYTES);
const errorDetailObjectSchema = z.object({
  category: z.enum([
    "provider_header_timeout",
    "provider_response_stream_error",
    "provider_error",
    "provider_timeout",
    "provider_quota",
    "context_input_length",
    "provider_auth",
    "context_overflow",
    "output_length",
    "structured_output",
    "content_filter",
    "aborted",
    "unknown",
  ]),
  name: errorNameSchema.optional(),
  code: errorCodeSchema.optional(),
  timeout_ms: z.number().int().min(1).max(2_147_483_647).optional(),
  message: z.string().min(1).refine((value) =>
    Buffer.byteLength(value, "utf8") <= MAX_ERROR_DETAIL_MESSAGE_BYTES),
  detail_availability: z.enum(["safe_template", "redacted"]),
  source: z.literal("assistant_message_error"),
  source_is_retryable: z.boolean().optional(),
}).strict();
const errorDetailSchema = errorDetailObjectSchema.refine(
  isSafeAssistantErrorDetail,
  "Error detail must be an allowlisted safe projection.",
);
const correlatedErrorDetailSchema = errorDetailObjectSchema.extend({
  assistant_message_id: z.string(),
  attribution: z.literal("exact_parent"),
}).strict().refine((value) => {
  const { assistant_message_id: _assistantMessageId, attribution: _attribution, ...detail } = value;
  return isSafeAssistantErrorDetail(detail);
}, "Error detail must be an allowlisted safe projection.");
function validErrorDetailSummary(value: {
  error_details?: unknown[];
  error_details_total?: number;
  error_details_truncated?: boolean;
}): boolean {
  if (value.error_details === undefined)
    return value.error_details_total === undefined && value.error_details_truncated === undefined;
  return value.error_details_total !== undefined &&
    value.error_details_total >= value.error_details.length &&
    value.error_details_truncated ===
      (value.error_details_total > value.error_details.length);
}
const attentionEntryOutput = z.object({
  event_id: z.string(), activity_cursor: z.string(), event_sequence: z.number().int(), event_type: z.enum(ACTIVITY_TYPES),
  classification: z.enum(["ready", "attention", "action_required"]),
  lifecycle: z.enum(["new", "ready", "offered", "discussed", "superseded"]),
  session_id: z.string(), session_title: z.string(), submitted_message_id: z.string().optional(),
  assistant_message_ids: z.array(z.string()), occurred_at: z.string(), observed_at: z.string(), prepared_at: z.string().optional(),
  source_revision: z.string().optional(), result_sha256: z.string().optional(), prepared_summary: z.string(), next_safe_step: z.string(),
  task_id: z.string().optional(), task_title: z.string().optional(), task_status: z.string().optional(), task_updated_at: z.string().optional(),
  master_task_id: z.string().optional(), master_task_title: z.string().optional(), master_task_status: z.string().optional(),
  work_package_id: z.string().optional(), work_package_title: z.string().optional(), work_package_status: z.string().optional(),
  hierarchy_status: z.enum(["pending", "resolved", "unlinked", "ambiguous", "unavailable"]),
  hierarchy_summary: z.string().optional(),
  management_checkpoints: z.array(z.object({ task_id: z.string(), state: z.enum(["absent", "available"]),
    consistency: z.enum(["current", "rebuilt_index", "recovered_suffix"]).optional(), generation: z.string().optional(),
    head_sequence: z.number().int().optional(), latest_checkpoint: z.object({ sequence: z.number().int(), entry_id: z.string(), appended_at: z.string() }).strict().optional(),
    lifecycle: z.string().optional(), operator_attention: z.string().optional(), next_allowed_action: z.string().optional() }).strict()).optional(),
  superseded_by: z.string().optional(),
  delivery_policy: z.enum(["immediate_proactive_wakeup", "deferred_to_next_idle_boundary", "on_demand_fallback"]),
  error_details: z.array(correlatedErrorDetailSchema).min(1).max(MAX_CORRELATED_ERROR_DETAILS).optional(),
  error_details_total: z.number().int().positive().optional(),
  error_details_truncated: z.boolean().optional(),
  evidence: z.object({ source: z.enum(["visible_original", "pending_input"]), source_revision: z.string().optional(), sha256: z.string().optional(),
    assistant_message_ids: z.array(z.string()), complete: z.boolean() }).strict().optional(),
  deliveries: z.record(z.string(), z.object({ state: z.enum(["pending", "delivered", "failed", "abandoned"]), attempts: z.number().int(),
    next_attempt_at: z.string().optional(), http_status: z.number().int().optional(), updated_at: z.string() }).strict()),
}).strict().refine(validErrorDetailSummary, "Error detail totals must match returned details.");
const attentionOutput = z.object({ entries: z.array(attentionEntryOutput), next_cursor: z.string(), has_more: z.boolean(), current_cursor: z.string() }).strict();
const attentionReceiptInput = z.object({ event_id: z.string().min(1).max(256), source_revision: z.string().min(1).max(256),
  lifecycle: z.enum(["offered", "discussed"]) }).strict();
const attentionReceiptOutput = z.object({ event_id: z.string(), source_revision: z.string(), lifecycle: z.enum(["new", "ready", "offered", "discussed", "superseded"]) }).strict();

const journalCapabilitySchema = z.object({ enabled: z.boolean(), state: z.enum(["disabled", "ready", "degraded", "unavailable"]) }).strict();
const JOURNAL_TOOLS = new Set(["get_project_activity", "wait_for_project_activity", "get_project_attention",
  "acknowledge_project_attention", "supersede_unresolved_submission"]);

const listSessionsOutputSchema = z
  .object({
    project: projectSchema,
    sessions: z.array(summarySchema),
    next_cursor: z.string().optional(),
    truncated: z.boolean(),
    activity_journal: journalCapabilitySchema.optional(),
  })
  .strict();

const sessionDetailsOutputSchema = summarySchema
  .extend({
    archived_at: z.number().int().positive().optional(),
    activity_journal: journalCapabilitySchema.optional(),
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
    error_details: z.array(correlatedErrorDetailSchema).min(1).max(MAX_CORRELATED_ERROR_DETAILS).optional(),
    error_details_total: z.number().int().positive().optional(),
    error_details_truncated: z.boolean().optional(),
    active_assistant_message_ids: z.array(z.string()).optional(),
    pending_input_scope: pendingScopeSchema.optional(),
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
  .strict()
  .refine(validErrorDetailSummary, "Error detail totals must match returned details.");

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
    error_detail: errorDetailSchema.optional(),
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
const sendFollowupInputSchema = z
  .object({
    session_id: sessionId,
    message: z.string().min(1).max(32_000),
    attachments: z.array(z.string().min(1).max(256)).max(32).optional(),
  })
  .strict();
const abortSessionTurnInputSchema = z
  .object({
    session_id: sessionId,
  })
  .strict();
const abortSessionTurnOutputSchema = z
  .object({
    session_id: z.string(),
    state: z.enum(["aborted", "no_active_turn", "abort_uncertain"]),
    aborted_message_id: z.string().optional(),
    observed_at: z.string(),
    activity_after: activitySchema,
    pending_input_after: pendingSchema,
    guidance: z.string().optional(),
  })
  .strict();

const monitorIdSchema = z.string().regex(/^monitor_[0-9a-f]{32}$/);
const monitorIdInput = z.object({ monitor_id: monitorIdSchema }).strict();
const monitorAnchorTaskId = z.string().regex(/^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const monitorWorkStateSchema = z.enum(["active", "parked_input_required", "complete_pass", "stopped"]);
const monitorAutonomySchema = z.enum(["conservative", "sandbox", "mvp", "yolo"]);
const monitorRuntimeProfileSchema = z.enum(["deep", "standard", "execution", "design", "review"]);
const monitorSummaryOutput = z
  .object({
    monitor_id: z.string(),
    title: z.string(),
    anchor_task_id: z.string(),
    scheduler: z
      .object({
        enabled: z.boolean(),
        interval_seconds: z.number().int(),
        next_run_at: z.number().nullable(),
        expiry_at: z.number().nullable(),
      })
      .strict(),
    autonomy_profile: monitorAutonomySchema,
    runtime_profile: monitorRuntimeProfileSchema,
    session_id: z.string().nullable(),
    work_state: monitorWorkStateSchema,
    parked_reason: z.string().optional(),
    run_active: z.boolean(),
    last_run_at: z.string().nullable(),
    updated_at: z.string(),
  })
  .strict();
const listMonitorsInput = z
  .object({
    cursor: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    work_state: monitorWorkStateSchema.optional(),
  })
  .strict();
const listMonitorsOutput = z
  .object({
    monitors: z.array(monitorSummaryOutput),
    total: z.number().int(),
    next_cursor: z.string().optional(),
    generation: z.number().int(),
    completeness: z.enum(["complete", "paged"]),
    observed_at: z.string(),
  })
  .strict();
const getMonitorInput = z.object({ monitor_id: monitorIdSchema }).strict();
// V2 §13.3 (task_e67c39cf): smallest config/task-contract surface on the
// EXISTING create/update monitor tools — operational timing/budget/milestone
// configuration only, never authority (autonomy profiles and grants are
// separate). Degenerate values fail closed through the shared validator.
const investigationBudgetInput = z
  .object({
    max_duration_ms: z.number().int().positive().optional(),
    max_calls: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().optional(),
    call_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();
const investigationConfigInput = z
  .object({
    first_check_s: z.number().int().optional(),
    cooldown_s: z.number().int().optional(),
    ladder_s: z.array(z.number().int()).length(3).optional(),
    budget: investigationBudgetInput.optional(),
    daily_budget: z.number().int().optional(),
    task_type: z.enum(["default", "long_runner", "milestoned"]).optional(),
    expected_milestone: z.string().min(1).max(200).nullable().optional(),
    milestone_due_at: z.string().nullable().optional(),
  })
  .strict();
const investigationWorkerOutput = z
  .object({
    worker_key: z.string(),
    dispatch_receipt: z.string().nullable(),
    anchored_at: z.string().nullable(),
    anchor_source: z.string().nullable(),
    last_progress_at: z.string().nullable(),
    cooldown_until: z.number().nullable(),
    next_deep_check_at: z.number().nullable(),
    backoff_stage: z.number().int(),
  })
  .strict();
const investigationStateOutput = z
  .object({
    schema: z.number().int(),
    last_progress_at: z.string().nullable(),
    last_investigation_at: z.string().nullable(),
    cooldown_until: z.number().nullable(),
    backoff_stage: z.number().int(),
    next_deep_check_at: z.number().nullable(),
    episode: z.unknown().nullable().optional(),
    workers: z.array(investigationWorkerOutput),
    counters: z
      .object({
        investigations_total: z.number().int(),
        inconclusive_total: z.number().int(),
        anchor_unknown_total: z.number().int(),
      })
      .strict(),
  })
  .strict();
const getMonitorOutput = z
  .object({
    monitor: monitorSummaryOutput,
    anchor: z.object({ task_id: z.string() }).strict(),
    effective: z
      .object({
        interval_seconds: z.number().int(),
        runtime_profile: monitorRuntimeProfileSchema,
        autonomy_profile: monitorAutonomySchema,
      })
      .strict(),
    last_event: z.object({ at: z.string(), type: z.string() }).strict().nullable(),
    next_run_at: z.number().nullable(),
    investigation: investigationStateOutput.nullable().optional(),
    investigation_config: z.unknown().nullable().optional(),
    observed_at: z.string(),
  })
  .strict();
const createMonitorInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    task_id: monitorAnchorTaskId,
    interval_seconds: z.number().int().min(5).max(86400).optional(),
    autonomy_profile: monitorAutonomySchema.optional(),
    runtime_profile: monitorRuntimeProfileSchema.optional(),
    expiry_at: z.number().int().positive().nullable().optional(),
    investigation: investigationConfigInput.optional(),
  })
  .strict();
const monitorMutationOutput = z
  .object({
    monitor: monitorSummaryOutput,
    generation: z.number().int(),
    observed_at: z.string(),
  })
  .strict();
const updateMonitorInput = z
  .object({
    monitor_id: monitorIdSchema,
    expected_generation: z.number().int().nonnegative().optional(),
    task_id: monitorAnchorTaskId.optional(),
    manager_session_id: sessionId.nullable().optional(),
    title: z.string().trim().min(1).max(160).optional(),
    interval_seconds: z.number().int().min(5).max(86400).optional(),
    autonomy_profile: monitorAutonomySchema.optional(),
    runtime_profile: monitorRuntimeProfileSchema.optional(),
    expiry_at: z.number().int().positive().nullable().optional(),
    investigation: investigationConfigInput.optional(),
  })
  .strict();
const triggerMonitorInput = z
  .object({ monitor_id: monitorIdSchema, reason: z.string().trim().min(1).max(200).optional() })
  .strict();
const monitorDeleteOutput = z
  .object({ monitor_id: z.string(), deleted: z.literal(true), generation: z.number().int() })
  .strict();
const monitorHistoryInput = z
  .object({
    monitor_id: monitorIdSchema,
    limit: z.number().int().min(1).max(100).optional(),
    include_logs: z.boolean().optional(),
  })
  .strict();
const monitorHistoryOutput = z
  .object({
    monitor_id: z.string(),
    history: z.array(
      z.object({ at: z.string(), type: z.string(), detail: z.record(z.string(), z.unknown()).optional() }).strict(),
    ),
    logs: z
      .array(z.object({ at: z.string(), level: z.enum(["info", "warn", "error"]), message: z.string() }).strict())
      .optional(),
    last_run_at: z.string().nullable(),
    next_run_at: z.number().nullable(),
    freshness: z.enum(["fresh", "stale", "unknown"]),
    coverage: z.enum(["complete", "paged"]),
    observed_at: z.string(),
  })
  .strict();
const monitorAbortOutput = z
  .object({
    monitor_id: z.string(),
    state: z.enum(["aborted", "no_active_run", "abort_uncertain"]),
    run_active_after: z.boolean(),
    observed_at: z.string(),
    guidance: z.string().optional(),
  })
  .strict();
const monitorWorkerLifecycleSchema = z.enum(["reserved", "active", "idle", "archived"]);
const monitorWorkerLastErrorSchema = z
  .object({
    at: z.string(),
    category: z.string(),
    fingerprint: z.string(),
    receipt: z.string().nullable(),
  })
  .strict();
const monitorWorkerOutput = z
  .object({
    worker_key: z.string(),
    alias: z.string(),
    lifecycle: monitorWorkerLifecycleSchema,
    task_id: z.string().nullable(),
    context_path: z.string(),
    runtime_session_id: z.string().nullable(),
    creation_receipt: z.string().nullable(),
    dispatch_receipt: z.string().nullable(),
    dispatch_at: z.string().nullable().optional(),
    result_receipt: z.string().nullable(),
    last_synthesis_at: z.string().nullable(),
    updated_at: z.string(),
    last_error: monitorWorkerLastErrorSchema.nullable(),
  })
  .strict();
const createMonitorWorkerInput = z
  .object({
    monitor_id: monitorIdSchema,
    scope_dirs: z.array(z.string().min(1).max(512)).min(1).max(16).optional(),
    scope_read_files: scopeReadFilesSchema.optional(),
    title: z.string().trim().min(1).max(160).optional(),
    task_id: monitorAnchorTaskId.optional(),
    scope: z.string().trim().min(1).max(400).optional(),
    worktree: z.string().trim().min(1).max(400).optional(),
  })
  .strict();
const createMonitorWorkerOutput = z
  .object({
    worker: monitorWorkerOutput,
    generation: z.number().int(),
    uncertain: z.boolean(),
    observed_at: z.string(),
  })
  .strict();
const listMonitorWorkersInput = z.object({ monitor_id: monitorIdSchema }).strict();
const listMonitorWorkersOutput = z
  .object({
    monitor_id: z.string(),
    alias: z.string().nullable(),
    workers: z.array(monitorWorkerOutput),
    generation: z.number().int(),
    observed_at: z.string(),
  })
  .strict();
const updateMonitorWorkerInput = z
  .object({
    monitor_id: monitorIdSchema,
    worker_key: z.string().regex(/^worker_[0-9a-f]{32}$/),
    action: z.enum(["reconcile_created", "reconcile_absent", "reuse", "rebind", "idle", "archive", "synthesis"]),
    runtime_session_id: z.string().min(1).max(200).optional(),
    creation_receipt: z.string().min(1).max(200).optional(),
    dispatch_receipt: z.string().min(1).max(200).optional(),
    synthesis_at: z.string().min(1).max(40).optional(),
  })
  .strict();
const updateMonitorWorkerOutput = z
  .object({ worker: monitorWorkerOutput, generation: z.number().int(), observed_at: z.string() })
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

export const REPO_LIVE_UI_URI = "ui://repo-live/v1.html";
export const REPO_LIVE_UI_MIME = "text/html;profile=mcp-app";
let controlAppHtml: string | undefined;

/** Assemble the one Repo Live source (index.html + styles.css + app.js) into a
 * self-contained MCP app resource; the same files serve the browser dashboard.
 * Fails closed when the documented inline markers are no longer present. */
export async function loadControlAppHtml(): Promise<string> {
  if (controlAppHtml) return controlAppHtml;
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../dashboard");
  const [html, css, script] = await Promise.all([
    readFile(resolve(directory, "index.html"), "utf8"),
    readFile(resolve(directory, "styles.css"), "utf8"),
    readFile(resolve(directory, "app.js"), "utf8"),
  ]);
  const link = '<link rel="stylesheet" href="/styles.css">';
  const source = '<script src="/app.js" defer></script>';
  if (!html.includes(link) || !html.includes(source)) throw new Error("Repo Live UI asset markers are missing.");
  controlAppHtml = html.replace(link, `<style>\n${css}\n</style>`).replace(source, `<script>\n${script}\n</script>`);
  return controlAppHtml;
}

function requireDashboardControl(gateway: SessionGateway): DashboardControl {
  const control = gateway.dashboardControl;
  if (!control) throw new AdapterError("BACKEND_UNAVAILABLE", "The Repo Live read projection is unavailable in this runtime.");
  return control;
}

const controlOverviewInput = z.object({}).strict();
const controlSessionInput = z.object({ session_id: sessionId }).strict();
const controlOutput = z.looseObject({});

export function createMcpServer(
  gateway: SessionGateway,
  runtime?: RuntimeDescriptor,
): McpServer {
  const server = new McpServer({
    name: "opencode-vm",
    version: ADAPTER_VERSION,
  });
  const journalEnabled = runtime?.activityJournalEnabled !== false;
  const journalCapability = () => gateway.activityJournalStatus?.() ?? {
    enabled: journalEnabled, state: journalEnabled ? "unavailable" as const : "disabled" as const,
  };

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
        { ...result, activity_journal: journalCapability() },
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
      return success({ ...result, activity_journal: journalCapability() }, `Session ${result.id} is ${result.activity}.`);
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
      scope_dirs,
      scope_read_files,
    }: z.output<typeof sendMessageInputSchema>) => {
      const result = await gateway.sendMessage(
        session_id,
        message,
        attachments,
        scope_dirs,
        scope_read_files,
      );
      // Durable provenance for a later explicit recover_session_order. Best effort
      // so a store fault never turns an already-admitted send into a false failure;
      // a missing entry makes recovery fail closed rather than act on an unknown order.
      if (runtime) {
        await recordAdmission(runtime, {
          session_id: result.session_id, message_id: result.message_id, profile: null, now: new Date().toISOString(),
        }).catch(() => undefined);
      }
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

  const sendFollowupHandler = safeHandler(
    async ({
      session_id,
      message,
      attachments,
    }: z.output<typeof sendFollowupInputSchema>) => {
      if (!gateway.sendFollowup)
        throw new AdapterError(
          "UNSUPPORTED_CONFIGURATION",
          "Session follow-up admission is not available on this connector.",
        );
      const result = await gateway.sendFollowup(
        session_id,
        message,
        attachments,
      );
      return success(
        result,
        `Admitted follow-up ${result.message_id} into session ${result.session_id}${result.attachments?.length ? ` with ${result.attachments.length} attachment${result.attachments.length === 1 ? "" : "s"}` : ""}. OpenCode runs it natively as the next turn; correlate it with get_session_status before sending anything else.`,
      );
    },
  );
  const abortSessionTurnHandler = safeHandler(
    async ({ session_id }: z.output<typeof abortSessionTurnInputSchema>) => {
      if (!gateway.abortSessionTurn)
        throw new AdapterError(
          "UNSUPPORTED_CONFIGURATION",
          "Turn abort is not available on this connector.",
        );
      const result = await gateway.abortSessionTurn(session_id);
      return success(
        result,
        result.state === "aborted"
          ? `Turn abort verified for session ${result.session_id} via stored message ${result.aborted_message_id}. Executed changes remain; nothing was rolled back.`
          : result.state === "no_active_turn"
            ? `Session ${result.session_id} had no active turn; nothing was aborted (non-destructive result, not a task failure).`
            : `Abort of session ${result.session_id} was requested but not verified; inspect get_session_status before any follow-up submission.`,
      );
    },
  );


  const monitorRuntime = () => {
    if (!runtime)
      throw new AdapterError(
        "UNSUPPORTED_CONFIGURATION",
        "Monitor management requires the project runtime descriptor.",
      );
    return runtime;
  };
  const monitorSummary = (monitor: MonitorRecord) => {
    const last = [...monitor.history]
      .reverse()
      .find(
        (entry) =>
          entry.type === "dispatched" ||
          entry.type === "recovery-continued" ||
          entry.type === "compaction-continued",
      );
    return {
      monitor_id: monitor.id,
      title: monitor.title,
      anchor_task_id: monitor.anchor.task_id,
      scheduler: {
        enabled: monitor.scheduler.enabled,
        interval_seconds: monitor.scheduler.interval_seconds,
        next_run_at: monitor.scheduler.next_run_at,
        expiry_at: monitor.scheduler.expiry_at,
      },
      autonomy_profile: monitor.autonomy_profile,
      runtime_profile: monitor.runtime_profile,
      session_id: monitor.session.session_id,
      work_state: monitor.state.work,
      ...(monitor.state.parked_reason ? { parked_reason: monitor.state.parked_reason } : {}),
      run_active: monitor.run.active,
      last_run_at: last?.at ?? null,
      updated_at: monitor.updated_at,
    };
  };
  const monitorHistoryFreshness = (monitor: MonitorRecord, now: number): "fresh" | "stale" | "unknown" => {
    const last = [...monitor.history]
      .reverse()
      .find(
        (entry) =>
          entry.type === "dispatched" ||
          entry.type === "recovery-continued" ||
          entry.type === "compaction-continued",
      );
    if (!last) return "unknown";
    const at = Date.parse(last.at);
    if (!Number.isFinite(at)) return "unknown";
    return now - at <= monitor.scheduler.interval_seconds * 2 * 1000 ? "fresh" : "stale";
  };
  // V2 §13.3: validate + attach the smallest config/task-contract surface.
  const applyInvestigationConfig = (monitor: MonitorRecord, input: z.output<typeof investigationConfigInput> | undefined): void => {
    if (input === undefined) return;
    try {
      monitor.investigation_config = validateInvestigationConfigInput(input);
    } catch (error) {
      throw new AdapterError("INVALID_ARGUMENT", error instanceof Error ? error.message : "investigation config is invalid.");
    }
  };
  const publicInvestigation = (inv: MonitorInvestigationState) => ({
    schema: inv.schema,
    last_progress_at: inv.last_progress_at,
    last_investigation_at: inv.last_investigation_at,
    cooldown_until: inv.cooldown_until,
    backoff_stage: inv.backoff_stage,
    next_deep_check_at: inv.next_deep_check_at,
    ...(inv.episode
      ? {
          episode: {
            started_at: inv.episode.started_at,
            finished_at: inv.episode.finished_at,
            outcome: inv.episode.outcome,
            evidence: inv.episode.evidence,
            expected_milestone: inv.episode.expected_milestone,
            wait_reason: inv.episode.wait_reason,
            worker_key: inv.episode.worker_key,
            dispatch_receipt: inv.episode.dispatch_receipt,
            generation_source: inv.episode.generation_source,
            generation_value: inv.episode.generation_value,
          },
        }
      : {}),
    workers: inv.workers.map((worker) => ({
      worker_key: worker.worker_key,
      dispatch_receipt: worker.dispatch_receipt,
      anchored_at: worker.anchored_at,
      anchor_source: worker.anchor_source,
      last_progress_at: worker.last_progress_at,
      cooldown_until: worker.cooldown_until,
      next_deep_check_at: worker.next_deep_check_at,
      backoff_stage: worker.backoff_stage,
    })),
    counters: inv.counters,
  });
  const listMonitorsHandler = safeHandler(async (input: z.output<typeof listMonitorsInput>) => {
    const project = monitorRuntime().project;
    const snapshot = await readRegistrySnapshot(project);
    const monitors = [...snapshot.registry.monitors]
      .filter((monitor) => input.work_state === undefined || monitor.state.work === input.work_state)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const total = monitors.length;
    const start = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(start) || start < 0 || (input.cursor !== undefined && String(start) !== input.cursor))
      throw new AdapterError("INVALID_ARGUMENT", "cursor is invalid.");
    const limit = input.limit ?? 20;
    const page = monitors.slice(start, start + limit);
    const next = start + limit < total ? String(start + limit) : undefined;
    return success(
      {
        monitors: page.map(monitorSummary),
        total,
        ...(next ? { next_cursor: next } : {}),
        generation: snapshot.registry.generation,
        completeness: next ? "paged" : "complete",
        observed_at: new Date().toISOString(),
      },
      `Returned ${page.length} of ${total} monitor(s)${next ? "; continue with next_cursor" : "; inventory complete (all states included)"}.`,
    );
  });
  const getMonitorHandler = safeHandler(async ({ monitor_id }: z.output<typeof getMonitorInput>) => {
    const snapshot = await readRegistrySnapshot(monitorRuntime().project);
    const monitor = snapshot.registry.monitors.find((entry) => entry.id === monitor_id);
    if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
    const last = [...monitor.history].reverse().find((entry) => entry.type.startsWith("dispatch") || entry.type === "recovery-continued");
    return success(
      {
        monitor: monitorSummary(monitor),
        anchor: { task_id: monitor.anchor.task_id },
        effective: {
          interval_seconds: monitor.scheduler.interval_seconds,
          runtime_profile: monitor.runtime_profile,
          autonomy_profile: monitor.autonomy_profile,
        },
        last_event: last ? { at: last.at, type: last.type } : null,
        next_run_at: monitor.scheduler.next_run_at,
        ...(monitor.investigation ? { investigation: publicInvestigation(monitor.investigation) } : {}),
        investigation_config: monitor.investigation_config ?? null,
        observed_at: new Date().toISOString(),
      },
      `Monitor ${monitor.id} is ${monitor.state.work}; scheduler ${monitor.scheduler.enabled ? "enabled" : "disabled"}.`,
    );
  });
  const findMonitor = (source: { monitors: MonitorRecord[] }, id: string): MonitorRecord | undefined =>
    source.monitors.find((entry) => entry.id === id);
  const createMonitorHandler = safeHandler(async (input: z.output<typeof createMonitorInput>) => {
    const project = monitorRuntime().project;
    const now = Date.now();
    const created = await withRegistry(project, (registry) => {
      if (registry.monitors.some((monitor) => monitor.anchor.task_id === input.task_id))
        throw new AdapterError(
          "MONITOR_CONFLICT",
          "This canonical task already has a monitor (unique master-task binding).",
        );
      const record = defaultMonitorRecord(
        input.title,
        input.task_id,
        {
          ...(input.interval_seconds !== undefined ? { interval_seconds: input.interval_seconds } : {}),
          ...(input.autonomy_profile !== undefined ? { autonomy_profile: input.autonomy_profile } : {}),
          ...(input.runtime_profile !== undefined ? { runtime_profile: input.runtime_profile } : {}),
          ...(input.expiry_at !== undefined ? { expiry_at: input.expiry_at } : {}),
        },
        now,
      );
      ensureManagerAlias(registry, record);
      applyInvestigationConfig(record, input.investigation);
      monitorHistory(record, "created", { alias: record.alias, interval_seconds: record.scheduler.interval_seconds }, now);
      registry.monitors.push(record);
      return registry;
    });
    const monitor = created.monitors.find((entry) => entry.anchor.task_id === input.task_id)!;
    return success(
      { monitor: monitorSummary(monitor), generation: created.generation, observed_at: new Date().toISOString() },
      `Created monitor ${monitor.id} for task ${input.task_id}.`,
    );
  });
  const updateMonitorHandler = safeHandler(async (input: z.output<typeof updateMonitorInput>) => {
    const project = monitorRuntime().project;
    const now = Date.now();
    const bindingUpdate = input.task_id !== undefined || input.manager_session_id !== undefined;
    // Backend validation stays outside the short registry lock. Fence the
    // observed bindings/claim with CAS when committing the complete update.
    const before = bindingUpdate ? await readRegistrySnapshot(project) : null;
    const previous = before?.registry.monitors.find((entry) => entry.id === input.monitor_id);
    let managerTitle: string | null = null;
    if (bindingUpdate) {
      if (!previous) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
      if (input.expected_generation !== undefined && input.expected_generation !== before!.registry.generation)
        throw new AdapterError("MONITOR_CONFLICT", "Monitor registry differs from expected_generation; read back before a deliberate retry.");
      if (previous.run.active || (previous.dispatch_wal && previous.dispatch_wal.message_id === null))
        throw new AdapterError("MONITOR_STATE_CONFLICT", "Finish the running action or reconcile its uncertain dispatch before changing bindings.");
      if (input.task_id !== undefined) {
        if (!board) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Task binding validation requires the project Taskboard.");
        await board.getTask(input.task_id);
      }
      const managerChanged = input.manager_session_id !== undefined && input.manager_session_id !== previous.session.session_id;
      const sessions = new Set<string>();
      if (previous.session.session_id) sessions.add(previous.session.session_id);
      if (input.manager_session_id) sessions.add(input.manager_session_id);
      for (const id of sessions) {
        try {
          const details = await gateway.getSessionDetails(id);
          if (details.id !== id || details.activity !== "idle" || details.pending_input.permissions + details.pending_input.questions > 0 ||
              details.pending_input.coverage === "unknown" || details.admission?.write_in_progress)
            throw new AdapterError("MONITOR_STATE_CONFLICT", "Manager binding requires an exposed idle session without pending input or concurrent writes.");
          if (id === input.manager_session_id) managerTitle = details.title;
          const receipts = new Set([
            id === previous.session.session_id ? previous.dispatch_wal?.message_id : null,
            details.admission?.guarded_message_id,
          ].filter((receipt): receipt is string => typeof receipt === "string"));
          for (const receipt of receipts) {
            const status = await gateway.getSessionStatus(id, receipt);
            if (status.backend_activity !== "idle" || !["completed", "failed", "aborted"].includes(status.state))
              throw new AdapterError("MONITOR_STATE_CONFLICT", "The manager dispatch is not verified terminal; reconcile it before changing bindings.");
          }
        } catch (error) {
          // Only the old missing runtime is recoverable. An unavailable read,
          // foreign/new session or real pending permission never becomes a rebind.
          if (!(error instanceof AdapterError && error.code === "SESSION_NOT_FOUND" && managerChanged && id === previous.session.session_id)) throw error;
        }
      }
    }
    const updated = await withRegistry(
      project,
      (registry) => {
        const monitor = registry.monitors.find((entry) => entry.id === input.monitor_id);
        if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
        if (bindingUpdate) {
          if (monitor.run.active || (monitor.dispatch_wal && monitor.dispatch_wal.message_id === null))
            throw new AdapterError("MONITOR_STATE_CONFLICT", "The monitor has a running action or uncertain dispatch.");
          if (input.task_id !== undefined && registry.monitors.some((entry) => entry.id !== monitor.id && entry.anchor.task_id === input.task_id))
            throw new AdapterError("MONITOR_CONFLICT", "This canonical task already has a monitor (unique master-task binding).");
          if (input.manager_session_id && registry.monitors.some((entry) =>
              (entry.id !== monitor.id && entry.session.session_id === input.manager_session_id) ||
              (entry.workers ?? []).some((worker) => worker.runtime_session_id === input.manager_session_id)))
            throw new AdapterError("MONITOR_CONFLICT", "This session is already bound to a monitor manager or worker.");
          const taskChanged = input.task_id !== undefined && input.task_id !== monitor.anchor.task_id;
          const managerChanged = input.manager_session_id !== undefined && input.manager_session_id !== monitor.session.session_id;
          if (taskChanged || managerChanged) {
            monitorHistory(monitor, "bindings-updated", {
              previous_task_id: monitor.anchor.task_id, task_id: input.task_id ?? monitor.anchor.task_id,
              previous_session_id: monitor.session.session_id,
              session_id: input.manager_session_id === undefined ? monitor.session.session_id : input.manager_session_id,
              previous_dispatch: monitor.dispatch_wal,
            }, now);
            if (taskChanged) {
              monitor.anchor.task_id = input.task_id!;
              monitor.state.watermark = null;
              monitor.cursors = {};
            }
            if (managerChanged) {
              monitor.session = { session_id: input.manager_session_id!, title: managerTitle, primed_at: null, priming_digest: null };
              monitor.dispatch_wal = null;
              monitor.state.receipt_observation = null;
            } else monitor.session.priming_digest = null;
            monitor.state.last_seen_digest = null;
            monitor.state.worker_digest = null;
          }
        }
        if (input.title !== undefined) monitor.title = input.title;
        if (input.interval_seconds !== undefined) monitor.scheduler.interval_seconds = input.interval_seconds;
        if (input.autonomy_profile !== undefined) monitor.autonomy_profile = input.autonomy_profile;
        if (input.runtime_profile !== undefined) monitor.runtime_profile = input.runtime_profile;
        if (input.expiry_at !== undefined) monitor.scheduler.expiry_at = input.expiry_at;
        applyInvestigationConfig(monitor, input.investigation);
        monitor.updated_at = new Date().toISOString();
        monitorHistory(monitor, "updated", undefined, now);
        return registry;
      },
      { ...((before?.registry.generation ?? input.expected_generation) !== undefined
        ? { expected: before?.registry.generation ?? input.expected_generation } : {}), now },
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message === "monitor registry changed concurrently")
        throw new AdapterError("MONITOR_CONFLICT", "Monitor registry changed during validation; read back before a deliberate retry.");
      throw error;
    });
    const monitor = findMonitor(updated, input.monitor_id)!;
    return success(
      { monitor: monitorSummary(monitor), generation: updated.generation, observed_at: new Date().toISOString() },
      `Updated monitor ${monitor.id}.`,
    );
  });
  const setMonitorEnabledHandler = (enabled: boolean) =>
    safeHandler(async ({ monitor_id }: z.output<typeof monitorIdInput>) => {
      const project = monitorRuntime().project;
      const now = Date.now();
      const updated = await withRegistry(project, (registry) => {
        const monitor = registry.monitors.find((entry) => entry.id === monitor_id);
        if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
        monitor.scheduler.enabled = enabled;
        monitor.scheduler.next_run_at = enabled ? now + monitor.scheduler.interval_seconds * 1000 : null;
        monitor.updated_at = new Date().toISOString();
        monitorHistory(monitor, enabled ? "enabled" : "disabled", undefined, now);
        return registry;
      });
      const monitor = findMonitor(updated, monitor_id)!;
      return success(
        { monitor: monitorSummary(monitor), generation: updated.generation, observed_at: new Date().toISOString() },
        `Monitor ${monitor.id} scheduler ${enabled ? "enabled" : "disabled"}; work state unchanged (${monitor.state.work}).`,
      );
    });
  const enableMonitorHandler = setMonitorEnabledHandler(true);
  const disableMonitorHandler = setMonitorEnabledHandler(false);
  const triggerMonitorHandler = safeHandler(async (input: z.output<typeof triggerMonitorInput>) => {
    const project = monitorRuntime().project;
    const now = Date.now();
    const at = new Date(now).toISOString();
    const updated = await withRegistry(project, (registry) => {
      const monitor = registry.monitors.find((entry) => entry.id === input.monitor_id);
      if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
      monitor.wake_request = { requested_at: at, reason: input.reason ?? "operator-trigger" };
      monitor.updated_at = at;
      monitorHistory(monitor, "trigger-requested", { reason: input.reason ?? "operator-trigger" }, now);
      return registry;
    });
    const monitor = findMonitor(updated, input.monitor_id)!;
    return success(
      { monitor: monitorSummary(monitor), generation: updated.generation, observed_at: new Date().toISOString() },
      `Wake requested for ${monitor.id}; the engine takes the next bounded action (no immediate model call from this tool).`,
    );
  });
  const cancelMonitorFutureHandler = safeHandler(async ({ monitor_id }: z.output<typeof monitorIdInput>) => {
    const project = monitorRuntime().project;
    const now = Date.now();
    const updated = await withRegistry(project, (registry) => {
      const monitor = registry.monitors.find((entry) => entry.id === monitor_id);
      if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
      monitor.wake_request = null;
      if (monitor.scheduler.enabled)
        monitor.scheduler.next_run_at = now + monitor.scheduler.interval_seconds * 1000;
      monitor.updated_at = new Date().toISOString();
      monitorHistory(monitor, "future-cancelled", undefined, now);
      return registry;
    });
    const monitor = findMonitor(updated, monitor_id)!;
    return success(
      { monitor: monitorSummary(monitor), generation: updated.generation, observed_at: new Date().toISOString() },
      `Pending future wake cancelled for ${monitor.id}; a still-running worker turn is separate (use abort_monitor_run).`,
    );
  });
  const abortMonitorRunHandler = safeHandler(async ({ monitor_id }: z.output<typeof monitorIdInput>) => {
    const project = monitorRuntime().project;
    const snapshot = await readRegistrySnapshot(project);
    const monitor = findMonitor(snapshot.registry, monitor_id);
    if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
    if (!monitor.run.active || !monitor.session.session_id)
      return success(
        {
          monitor_id,
          state: "no_active_run" as const,
          run_active_after: monitor.run.active,
          observed_at: new Date().toISOString(),
          guidance: "No monitor action is running; nothing was aborted (non-destructive).",
        },
        `Monitor ${monitor_id} has no running action; nothing was aborted.`,
      );
    if (!gateway.abortSessionTurn)
      throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Turn abort is not available on this connector.");
    const abort = await gateway.abortSessionTurn(monitor.session.session_id);
    const state: "aborted" | "abort_uncertain" =
      abort.state === "aborted" || abort.state === "no_active_turn" ? "aborted" : "abort_uncertain";
    await withRegistry(project, (registry) => {
      const record = registry.monitors.find((entry) => entry.id === monitor_id);
      if (!record) return registry;
      monitorHistory(record, state === "aborted" ? "run-aborted" : "run-abort-uncertain", { abort: abort.state }, Date.now());
      record.updated_at = new Date().toISOString();
      return registry;
    });
    const after = await readRegistrySnapshot(project);
    const runActiveAfter = findMonitor(after.registry, monitor_id)?.run.active ?? false;
    return success(
      {
        monitor_id,
        state,
        run_active_after: runActiveAfter,
        observed_at: new Date().toISOString(),
        ...(state === "abort_uncertain"
          ? { guidance: "Abort was accepted but not verified; inspect the monitor session state before further actions." }
          : { guidance: "Running worker turn aborted and verified; already executed changes remain (no rollback)." }),
      },
      state === "aborted"
        ? `Monitor run for ${monitor_id} was aborted and verified.`
        : `Abort for ${monitor_id} was requested but not verified.`,
    );
  });
  const deleteMonitorHandler = safeHandler(async ({ monitor_id }: z.output<typeof monitorIdInput>) => {
    const project = monitorRuntime().project;
    const updated = await withRegistry(project, (registry) => {
      const monitor = registry.monitors.find((entry) => entry.id === monitor_id);
      if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
      if (monitor.run.active)
        throw new AdapterError(
          "MONITOR_STATE_CONFLICT",
          "The monitor has a running action; abort or finish it before deletion.",
        );
      registry.monitors = registry.monitors.filter((entry) => entry.id !== monitor_id);
      return registry;
    });
    return success(
      { monitor_id, deleted: true as const, generation: updated.generation },
      `Deleted monitor ${monitor_id}.`,
    );
  });
  const monitorHistoryHandler = safeHandler(async (input: z.output<typeof monitorHistoryInput>) => {
    const project = monitorRuntime().project;
    const now = Date.now();
    const snapshot = await readRegistrySnapshot(project);
    const monitor = findMonitor(snapshot.registry, input.monitor_id);
    if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
    const limit = input.limit ?? 50;
    const history = monitor.history.slice(Math.max(0, monitor.history.length - limit));
    const last = [...monitor.history].reverse().find((entry) => entry.type.startsWith("dispatch") || entry.type === "recovery-continued");
    return success(
      {
        monitor_id: monitor.id,
        history,
        ...(input.include_logs ? { logs: monitor.logs.slice(Math.max(0, monitor.logs.length - limit)) } : {}),
        last_run_at: last?.at ?? null,
        next_run_at: monitor.scheduler.next_run_at,
        freshness: monitorHistoryFreshness(monitor, now),
        coverage: monitor.history.length > limit ? ("paged" as const) : ("complete" as const),
        observed_at: new Date().toISOString(),
      },
      `Returned ${history.length} history entr${history.length === 1 ? "y" : "ies"} for ${monitor.id}; last run ${last?.at ?? "unknown"}.`,
    );
  });

  // ---- W2-F1 consumer wiring: monitor worker identity/context metadata ----
  const workerSummary = (worker: MonitorWorkerRecord) => ({
    worker_key: worker.worker_key,
    alias: worker.alias,
    lifecycle: worker.lifecycle,
    task_id: worker.task_id,
    context_path: worker.context_path,
    runtime_session_id: worker.runtime_session_id,
    creation_receipt: worker.creation_receipt,
    dispatch_receipt: worker.dispatch_receipt,
    ...(worker.dispatch_at !== undefined ? { dispatch_at: worker.dispatch_at ?? null } : {}),
    result_receipt: worker.result_receipt,
    last_synthesis_at: worker.last_synthesis_at,
    updated_at: worker.updated_at,
    last_error: worker.last_error ?? null,
  });
  const appendWorkerAudit = async (
    project: string,
    monitorId: string,
    type: string,
    detail: Record<string, unknown>,
    now: number,
  ): Promise<void> => {
    await withRegistry(
      project,
      (registry) => {
        const monitor = registry.monitors.find((entry) => entry.id === monitorId);
        if (!monitor) return registry;
        monitorHistory(monitor, type, detail, now);
        monitor.updated_at = new Date(now).toISOString();
        return registry;
      },
      { now },
    );
  };
  const createMonitorWorkerHandler = safeHandler(async (input: z.output<typeof createMonitorWorkerInput>) => {
    const project = monitorRuntime().project;
    const now = Date.now();
    const scopeDirs = input.scope_dirs === undefined ? undefined : validateScopeDirs(input.scope_dirs);
    const scopeReadFiles = input.scope_read_files === undefined ? undefined : await validateScopeReadFiles(input.scope_read_files);
    // Reserve the alias + context path under the registry lock BEFORE the
    // non-idempotent session create; the record stays reserved until the create
    // response is observed.
    const reservation = await reserveWorker(
      project,
      input.monitor_id,
      { task_id: input.task_id ?? null, scope: input.scope ?? null, worktree: input.worktree ?? null },
      { now },
    );
    let created: CreateSessionResult | null = null;
    try {
      created = await gateway.createSession(input.title, scopeDirs, scopeReadFiles);
    } catch {
      created = null;
    }
    const worker = created
      ? await confirmWorkerCreation(
          project,
          input.monitor_id,
          reservation.worker_key,
          { runtime_session_id: created.session_id, creation_receipt: created.session_id },
          { now },
        )
      : await getWorker(project, input.monitor_id, reservation.worker_key);
    if (!worker) throw new AdapterError("INTERNAL_ERROR", "Worker reservation disappeared during creation.");
    await appendWorkerAudit(
      project,
      input.monitor_id,
      created ? "worker-created" : "worker-create-uncertain",
      { worker_key: worker.worker_key, alias: worker.alias, worker_session_id: created?.session_id ?? null },
      now,
    );
    const snapshot = await readRegistrySnapshot(project);
    const uncertain = created === null;
    return success(
      {
        worker: workerSummary(worker),
        generation: snapshot.registry.generation,
        uncertain,
        observed_at: new Date().toISOString(),
      },
      uncertain
        ? `Reserved worker ${worker.alias} but the session creation was uncertain; reconcile with update_monitor_worker (reconcile_created or reconcile_absent) before any retry.`
        : `Created worker ${worker.alias} as session ${created!.session_id}; use send_message with that session_id.`,
    );
  });
  const listMonitorWorkersHandler = safeHandler(async (input: z.output<typeof listMonitorWorkersInput>) => {
    const project = monitorRuntime().project;
    const snapshot = await readRegistrySnapshot(project);
    const monitor = snapshot.registry.monitors.find((entry) => entry.id === input.monitor_id);
    if (!monitor) throw new AdapterError("MONITOR_NOT_FOUND", "Monitor does not exist in this project registry.");
    const workers = monitor.workers ?? [];
    return success(
      {
        monitor_id: monitor.id,
        alias: monitor.alias ?? null,
        workers: workers.map(workerSummary),
        generation: snapshot.registry.generation,
        observed_at: new Date().toISOString(),
      },
      `Returned ${workers.length} worker(s) for ${monitor.id}${monitor.alias ? ` (${monitor.alias})` : ""}.`,
    );
  });
  const updateMonitorWorkerHandler = safeHandler(async (input: z.output<typeof updateMonitorWorkerInput>) => {
    const project = monitorRuntime().project;
    const now = Date.now();
    let worker: MonitorWorkerRecord;
    switch (input.action) {
      case "reconcile_created": {
        if (!input.runtime_session_id)
          throw new AdapterError("INVALID_ARGUMENT", "reconcile_created requires runtime_session_id.");
        worker = await reconcileWorkerCreate(
          project,
          input.monitor_id,
          input.worker_key,
          { outcome: "created", runtime_session_id: input.runtime_session_id, creation_receipt: input.creation_receipt ?? null },
          { now },
        );
        break;
      }
      case "reconcile_absent": {
        worker = await reconcileWorkerCreate(project, input.monitor_id, input.worker_key, { outcome: "absent" }, { now });
        break;
      }
      case "reuse": {
        if (!input.runtime_session_id)
          throw new AdapterError("INVALID_ARGUMENT", "reuse requires runtime_session_id.");
        worker = await reuseWorker(
          project,
          input.monitor_id,
          input.worker_key,
          { runtime_session_id: input.runtime_session_id, ...(input.dispatch_receipt !== undefined ? { dispatch_receipt: input.dispatch_receipt } : {}) },
          { now },
        );
        break;
      }
      case "rebind": {
        if (!input.runtime_session_id)
          throw new AdapterError("INVALID_ARGUMENT", "rebind requires runtime_session_id.");
        worker = await rebindWorker(
          project,
          input.monitor_id,
          input.worker_key,
          { runtime_session_id: input.runtime_session_id, ...(input.dispatch_receipt !== undefined ? { dispatch_receipt: input.dispatch_receipt } : {}) },
          { now },
        );
        break;
      }
      case "idle": {
        worker = await setWorkerLifecycle(project, input.monitor_id, input.worker_key, "idle", { now });
        break;
      }
      case "archive": {
        worker = await setWorkerLifecycle(project, input.monitor_id, input.worker_key, "archived", { now });
        break;
      }
      case "synthesis": {
        if (!input.synthesis_at) throw new AdapterError("INVALID_ARGUMENT", "synthesis requires synthesis_at.");
        await setWorkerSynthesis(project, input.monitor_id, input.worker_key, input.synthesis_at, { now });
        const updated = await getWorker(project, input.monitor_id, input.worker_key);
        if (!updated) throw new AdapterError("INTERNAL_ERROR", "Worker disappeared during synthesis update.");
        worker = updated;
        break;
      }
      default:
        throw new AdapterError("INVALID_ARGUMENT", "Unknown worker action.");
    }
    await appendWorkerAudit(
      project,
      input.monitor_id,
      `worker-${input.action}`,
      { worker_key: worker.worker_key, alias: worker.alias, lifecycle: worker.lifecycle, worker_session_id: worker.runtime_session_id },
      now,
    );
    const snapshot = await readRegistrySnapshot(project);
    return success(
      { worker: workerSummary(worker), generation: snapshot.registry.generation, observed_at: new Date().toISOString() },
      `Applied ${input.action} to worker ${worker.alias} (${worker.lifecycle}).`,
    );
  });

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
    async ({ title, scope_dirs, scope_read_files }: z.output<typeof createSessionInputSchema>) => {
      const result = await gateway.createSession(title, scope_dirs, scope_read_files);
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

  // task_68085480 rework: compact, non-secret core metadata mirrored into the
  // model-readable content text for the critical routing tools. structuredContent
  // and the API contract stay unchanged; no prompts, auth, endpoints or secrets;
  // null/unconfigured/unavailable are reported honestly.
  const fmtTuple = (r: { provider_id?: string; model_id?: string; variant?: string; agent?: string }): string =>
    `${r.provider_id ?? "?"}/${r.model_id ?? "?"}/${r.variant ?? "none"}${r.agent ? ` agent=${r.agent}` : ""}`;
  const fmtSlot = (entry: { selection: { provider_id: string; model_id: string; variant: string } | null; status: string; disabled: boolean }): string =>
    entry.selection ? `${fmtTuple(entry.selection)}[${entry.status}${entry.disabled ? ",disabled" : ""}]`
      : `unconfigured${entry.disabled ? "[disabled]" : ""}`;
  const policyText = (value: ReturnType<typeof describePolicy>): string => [
    `Project policy: project=${value.project_id} schema=${value.schema_version} revision=${value.revision} catalog=${value.catalog_status} updated=${value.updated_at ?? "none"}`,
    `Routing: regime=${value.routing.regime} legacy_final_stage_applies=${value.routing.legacy_final_stage_applies} strategies(degrading=${value.strategies.degrading ?? "unset"},provider_skip=${value.strategies.provider_skip ?? "unset"}) effective(degrading=${value.routing.strategies_effective.degrading},provider_skip=${value.routing.strategies_effective.provider_skip})`,
    `Profiles: ${PROFILE_NAMES.map((p) => `${p}=${fmtSlot(value.profiles[p]!)}`).join(" ")}`,
    `Profile fallbacks: ${PROFILE_NAMES.map((p) => `${p}=${fmtSlot(value.profile_fallbacks[p]!)}`).join(" ")}`,
    `Final fallback: ${value.final_fallback ? `${fmtTuple(value.final_fallback.selection)}[${value.final_fallback.status}${value.final_fallback.disabled ? ",disabled" : ""},mode=${value.final_fallback.mode}]` : "unconfigured"}`,
    `Resolution: ${PROFILE_NAMES.map((p) => { const r = value.resolution[p]!; return `${p}=${r.status}${r.resolved_label ? `->${r.resolved_label}` : ""}${r.runtime ? `(${fmtTuple(r.runtime)})` : ""}`; }).join(" ")}`,
    `Candidate order: ${value.routing.candidate_order ? PROFILE_NAMES.map((p) => `${p}:${(value.routing.candidate_order![p] ?? []).join(">") || "none"}`).join(" ") : "legacy"}`,
  ].join("\n");
  const recommendedText = (value: ReturnType<typeof resolveProfile>): string => [
    `Recommended runtime: profile=${value.profile} revision=${value.policy_revision} status=${value.status}`,
    `Resolved: label=${value.resolved_label ?? "none"}${value.resolved_profile ? ` profile=${value.resolved_profile}` : ""} runtime=${value.runtime ? fmtTuple(value.runtime) : "none"}`,
    `Resolution path: ${value.resolution_path.join(">") || "none"}`,
    `Candidates: ${value.candidates.map((c) => `${c.label}[${c.disabled ? "disabled" : c.status}]`).join(" ") || "none"}`,
  ].join("\n");
  const updateText = (value: RuntimeUpdateResult): string => [
    `Updated runtime settings for session ${value.session_id} (state=${value.state}).`,
    `Previous: ${fmtTuple(value.previous)}`,
    `Current: ${fmtTuple(value.current)}`,
  ].join("\n");

  const optionsHandler = safeHandler(
    async ({ session_id }: z.output<typeof runtimeOptionsInput>) =>
      success(
        await gateway.getSessionRuntimeOptions(session_id),
        "Available primary agents, connected providers, models and variants.",
      ),
  );
  const updateHandler = safeHandler(
    async ({ session_id, ...patch }: z.output<typeof runtimeUpdateInput>) => {
      const result = await gateway.updateSessionRuntime(session_id, patch);
      return success(result, updateText(result));
    },
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
  const attentionHandler = safeHandler(async (input: z.output<typeof attentionInput>) => {
    if (!gateway.getProjectAttention) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Persistent attention is not available on this connector.");
    const result = await gateway.getProjectAttention(input);
    return success(result, `Returned ${result.entries.length} prepared project attention entr${result.entries.length === 1 ? "y" : "ies"}; reading does not mark any entry offered or discussed.`);
  });
  const acknowledgeAttentionHandler = safeHandler(async (input: z.output<typeof attentionReceiptInput>) => {
    if (!gateway.acknowledgeProjectAttention) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Attention receipts are not available on this connector.");
    const entry = await gateway.acknowledgeProjectAttention(input);
    return success({ event_id: entry.event_id, source_revision: input.source_revision, lifecycle: entry.lifecycle },
      `Recorded ${entry.lifecycle} for ${entry.event_id}; this receipt does not authorize execution or change Board state.`);
  });
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
    const value = describePolicy(runtime, policy, catalog);
    return success(value, policyText(value));
  });
  const recommendedHandler = safeHandler(async ({ profile }: z.output<typeof recommendedInput>) => {
    if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
    const policy = await readPolicy(runtime);
    const catalog = await gateway.getSessionRuntimeOptions().catch(() => undefined);
    const result = resolveProfile(policy, profile, catalog);
    return success(result, recommendedText(result));
  });
  server.registerTool(
    "get_project_model_policy",
    { title: "Get Project Model Policy", description: "Read schema 1/2/3/4/5 preferences for deep, standard, execution, design and review with catalog validation and fixed absence fallbacks. Additive schema-4 fields: profile_fallbacks (each profile's optional own fallback), strategies (degrading/provider_skip, null means not explicitly set) and routing (regime, legacy_final_stage_applies, strategies_effective, candidate_order). Additive schema-5 fields: disabled per stored slot (profiles, profile_fallbacks, final_fallback — manually paused slot, stored selection preserved and skipped for new starts) and resolution (the effective next allowed candidate per profile with every skip reason; hold_disabled means every configured slot of that profile is paused).",
      inputSchema: z.object({}).strict(), outputSchema: modelPolicyOutput, annotations: readOnlyAnnotations },
    modelPolicyHandler,
  );
  server.registerTool(
    "get_recommended_runtime",
    { title: "Get Recommended Runtime", description: "Resolve an exact runtime. Design falls back to standard; review to deep then standard. Only null is skipped; configured unavailable/incomplete mappings stop. Review evaluates without automatically implementing findings. Does not switch any session.",
      inputSchema: recommendedInput, outputSchema: recommendedOutput, annotations: readOnlyAnnotations },
    recommendedHandler,
  );
  const setFallbackHandler = safeHandler(async ({ revision, fallback }: z.output<typeof policyFallbackInput>) => {
    if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
    const catalog = await gateway.getSessionRuntimeOptions().catch(() => undefined);
    const normalized = fallback === null ? null : { mode: fallback.mode ?? "total", selection: fallback.selection as PolicySelection };
    if (normalized !== null) {
      if (!catalog || catalog.truncated) throw new AdapterError("CATALOG_UNAVAILABLE", "A complete runtime catalog is required to validate the final fallback; the policy was not changed.");
      const status = profileState(normalized.selection, catalog);
      if (status !== "available") throw new AdapterError("SELECTION_UNAVAILABLE", `Final fallback selection is ${status}; the policy was not changed.`);
    }
    const updated = await commitFinalFallback(runtime, revision, normalized);
    return success(describePolicy(runtime, updated, catalog), "Final fallback committed; this response is the policy readback. It is separate from the design/review resolution fallbacks.");
  });
  server.registerTool(
    "set_project_model_policy_fallback",
    { title: "Set Project Model Policy Final Fallback",
      description: "Set, change, or clear (fallback:null) the configured final error-fallback runtime in the project policy. Mode total is the default, degrading is optional; both are separate from the design/review resolution fallbacks. An exact provider/model/variant from the current catalog is required when setting. Uses revision CAS with an exact-bytes backup on the first schema 3 upgrade; clearing never downgrades the schema, and regular profile mappings are preserved. The response is the committed policy readback.",
      inputSchema: policyFallbackInput, outputSchema: modelPolicyOutput, annotations: { ...writeAnnotations, openWorldHint: false } },
    setFallbackHandler,
  );
  const setProfileFallbackHandler = safeHandler(async ({ revision, profile, fallback }: z.output<typeof policyProfileFallbackInput>) => {
    if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
    const catalog = await gateway.getSessionRuntimeOptions().catch(() => undefined);
    const selection = fallback === null ? null : (fallback as PolicySelection);
    if (selection !== null) {
      if (!catalog || catalog.truncated) throw new AdapterError("CATALOG_UNAVAILABLE", "A complete runtime catalog is required to validate a profile fallback; the policy was not changed.");
      const status = profileState(selection, catalog);
      if (status !== "available") throw new AdapterError("SELECTION_UNAVAILABLE", `Profile fallback selection is ${status}; the policy was not changed.`);
    }
    const updated = await commitProfileFallback(runtime, revision, profile, selection);
    return success(describePolicy(runtime, updated, catalog), "Profile fallback committed; this response is the policy readback. It is separate from the legacy global final fallback and from the design/review resolution fallbacks.");
  });
  server.registerTool(
    "set_project_model_policy_profile_fallback",
    { title: "Set Project Model Policy Profile Fallback",
      description: "Set, change, or clear (fallback:null) one profile's OPTIONAL own error-fallback runtime (deep, standard, execution, design or review). Additive schema 4: uses revision CAS with an exact-bytes backup on the first schema 4 upgrade; clearing never downgrades the schema. The main profile mapping, the legacy global final fallback and both strategy switches are preserved. An exact catalog-listed provider/model/variant is required when setting. The response is the committed policy readback including routing.regime and routing.candidate_order.",
      inputSchema: policyProfileFallbackInput, outputSchema: modelPolicyOutput, annotations: { ...writeAnnotations, openWorldHint: false } },
    setProfileFallbackHandler,
  );
  const setStrategiesHandler = safeHandler(async ({ revision, strategies }: z.output<typeof policyStrategiesInput>) => {
    if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
    const catalog = await gateway.getSessionRuntimeOptions().catch(() => undefined);
    const updated = await commitStrategies(runtime, revision,
      { degrading: strategies.degrading, providerSkip: strategies.provider_skip });
    return success(describePolicy(runtime, updated, catalog), "Fallback strategies committed; this response is the policy readback. Both switches are written explicitly; null means not explicitly set and is never a silently chosen default.");
  });
  server.registerTool(
    "set_project_model_policy_strategies",
    { title: "Set Project Model Policy Fallback Strategies",
      description: "Set the two independent additive schema-4 fallback-strategy switches: degrading (continue with the next regular profile after an own fallback) and provider_skip (skip remaining candidates of an already failed provider identity, including profile fallbacks). Both must be sent explicitly as true, false or null (null = not explicitly set, surfaced as strategies_effective). Uses revision CAS with an exact-bytes backup on the first schema 4 upgrade; clearing both never downgrades the schema, and all profile mappings plus the legacy global final fallback are preserved. The response is the committed policy readback.",
      inputSchema: policyStrategiesInput, outputSchema: modelPolicyOutput, annotations: { ...writeAnnotations, openWorldHint: false } },
    setStrategiesHandler,
  );
  const setSlotDisabledHandler = safeHandler(async ({ revision, slot, disabled }: z.output<typeof policySlotDisabledInput>) => {
    if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
    const catalog = await gateway.getSessionRuntimeOptions().catch(() => undefined);
    const ref = slot.kind === "final_fallback" ? { kind: "finalFallback" as const }
      : slot.kind === "profile_fallback" ? { kind: "profileFallback" as const, profile: slot.profile }
      : { kind: "profile" as const, profile: slot.profile };
    const updated = await commitSlotDisabled(runtime, revision, ref, disabled);
    return success(describePolicy(runtime, updated, catalog), disabled
      ? "Slot disabled; this response is the policy readback. The stored selection is preserved and skipped for NEW starts before any request (no synthetic error, no deletion); an already running turn or recovery attempt is unchanged. Re-enable the same slot to make the identical selection available again."
      : "Slot enabled; this response is the policy readback. The previously stored selection is available again for new starts at its configured position.");
  });
  server.registerTool(
    "set_project_model_policy_slot_disabled",
    { title: "Set Project Model Policy Slot Disabled",
      description: "Manually pause or reactivate exactly ONE stored runtime slot of the project policy: a profile primary (slot {kind:'profile', profile}), a profile's optional own fallback (slot {kind:'profile_fallback', profile}) or the legacy global final error fallback (slot {kind:'final_fallback'}). disabled:true skips that slot for every NEW start and recovery resolution before any provider request — the stored provider/model/variant is preserved byte-exact, never deleted or set to null, and is never reported as a provider error. No provider/account/model-wide ban: the identical runtime in another active slot stays selectable. No expiry and no automatic re-enable; missing flag on schema 1-4 policies means enabled. Uses revision CAS with an exact-bytes backup on the first schema 5 upgrade; disabled:false never downgrades. The response is the committed policy readback including resolution (the effective next allowed candidate per profile).",
      inputSchema: policySlotDisabledInput, outputSchema: modelPolicyOutput, annotations: { ...writeAnnotations, openWorldHint: false } },
    setSlotDisabledHandler,
  );
  const recoverSessionOrderHandler = safeHandler(({ session_id, message_id }: z.output<typeof recoverOrderInput>) =>
    // task_68085480 F2: serialize the entire revalidate → claim → dispatch sequence per
    // session so two concurrent recovery calls can never both dispatch the same regular
    // candidate. The durable store plus the immediate final write-ahead stay the
    // cross-restart guard; no global lock or scheduler is introduced.
    withRecoverySubmissionLock(`recovery:${session_id}`, async () => {
      if (!runtime) throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Project runtime is unavailable.");
      // Exposed, not archived (getSessionDetails enforces exposure).
      const details = await gateway.getSessionDetails(session_id);
      if (details.archived_at !== undefined) throw new AdapterError("RECOVERY_ORDER_REJECTED", "Archived sessions are not recoverable here.");
      // Monitor-bound and monitor-worker sessions are out of scope; fail closed if unverifiable.
      try {
        const snapshot = await readRegistrySnapshot(runtime.project);
        const bound = snapshot.registry.monitors.some((m) => m.session?.session_id === session_id
          || (m.workers ?? []).some((w) => w.runtime_session_id === session_id));
        if (bound) throw new AdapterError("RECOVERY_ORDER_REJECTED", "Monitor-bound or monitor-worker sessions are not recovered here.");
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        throw new AdapterError("RECOVERY_ORDER_REJECTED", "Monitor ownership could not be verified; refusing to recover.");
      }
      // Provenance: only an adapter-admitted original order from the durable store.
      const store = await readRecoveryStore(runtime);
      const order = getOrder(store, session_id, message_id);
      if (!order) throw new AdapterError("RECOVERY_ORDER_UNKNOWN", "No adapter-admitted order with this session and message id.");
      if (order.status === "completed" || order.status === "escalated")
        throw new AdapterError("RECOVERY_ORDER_REJECTED", "This order already concluded; no further recovery is permitted.");
      // Admission / busy: fail closed on pending input or an in-progress write.
      const status = await gateway.getSessionStatus(session_id, message_id);
      if (status.pending_input.permissions + status.pending_input.questions > 0)
        throw new AdapterError("SESSION_BUSY", "Pending input must be resolved before any recovery.", undefined, "pending_input");
      if (status.admission?.write_in_progress)
        throw new AdapterError("SESSION_BUSY", "A write is in progress; recovery is refused.", undefined, "write_in_progress");
      if (status.state !== "failed")
        throw new AdapterError("RECOVERY_ORDER_REJECTED", "Only a terminal failed turn is recoverable.");
      const detail = (status.error_details ?? []).find((d) => d.attribution === "exact_parent") ?? (status.error_details ?? [])[0];
      const category = detail?.category;
      if (!category || !isRecoveryProviderAdmission(category))
        throw new AdapterError("RECOVERY_ORDER_REJECTED", "The terminal error is not an eligible provider error.");
      // Shared canonical resolver under the current policy.
      const policy = await readPolicy(runtime);
      const catalog = await gateway.getSessionRuntimeOptions(session_id);
      const detailsIdentity = details.provider_id !== undefined && details.model_id !== undefined
        ? runtimeIdentityKey({ provider_id: details.provider_id, model_id: details.model_id, ...(details.variant !== undefined ? { variant: details.variant } : {}) })
        : null;
      // task_68085480 F1: prefer the durable original identity/profile recorded on the
      // first recovery over the session's CURRENT runtime, which an earlier recovery
      // call may already have switched to a candidate that maps to no profile. Policy
      // and disabled state are still read fresh above and below.
      const currentIdentity = order.entry_identity ?? detailsIdentity;
      const entryProfile: ProfileName | null = (order.profile !== null && (PROFILE_NAMES as readonly string[]).includes(order.profile))
        ? order.profile as ProfileName
        : PROFILE_NAMES.find((p) => { const s = policy.profiles[p]; return s !== null && runtimeIdentityKey(s) === currentIdentity; }) ?? null;
      if (entryProfile === null)
        throw new AdapterError("RECOVERY_ORDER_REJECTED", "The failed runtime does not map to a configured profile; there is no authorized recovery chain.");
      const chain = resolveRecoveryChain(policy, {
        entryProfile, catalog, evidenceCategory: category,
        evidenceProviderId: details.provider_id ?? null,
        attempted: order.attempts.map((a) => a.identity), currentIdentity,
      });
      if (chain.selected === null) throw new AdapterError("RECOVERY_ORDER_REJECTED", `No allowed recovery candidate (${chain.reason}).`);
      const candidate = chain.candidates.find((c) => c.identity === chain.selected_identity)!;
      const isFinal = candidate.label === "final.main";
      if (isFinal && order.final_attempted)
        throw new AdapterError("RECOVERY_ORDER_REJECTED", "The single permitted final attempt was already used; escalate to the operator.");
      const identity = runtimeIdentityKey(chain.selected);
      const now = new Date().toISOString();
      // Write-ahead BEFORE any side effect: the attempt (and final flag) is durable
      // first, so a crash/replay can never dispatch the final twice.
      await mutateRecoveryOrder(runtime, session_id, message_id, (cur) => {
        if (!cur) return null;
        if (isFinal && cur.final_attempted) throw new AdapterError("RECOVERY_ORDER_REJECTED", "The final attempt was already consumed.");
        return nextOrder(cur, {
          profile: cur.profile ?? entryProfile,
          entry_identity: cur.entry_identity ?? currentIdentity,
          status: isFinal ? "final_attempted" : "pending",
          final_attempted: cur.final_attempted || isFinal,
          attempts: [...cur.attempts, { at: now, identity, outcome: "dispatch" }].slice(-MAX_RECOVERY_ATTEMPTS),
        }, now);
      });
      // Exactly one runtime switch, verified.
      const updated = await gateway.updateSessionRuntime(session_id, {
        provider_id: chain.selected.provider_id, model_id: chain.selected.model_id,
        ...(chain.selected.variant !== undefined ? { variant: chain.selected.variant } : {}),
      });
      const verified = await gateway.getSessionDetails(session_id);
      if (updated.state !== "updated" || verified.provider_id !== chain.selected.provider_id
        || verified.model_id !== chain.selected.model_id || (chain.selected.variant !== undefined && verified.variant !== chain.selected.variant)) {
        await mutateRecoveryOrder(runtime, session_id, message_id, (cur) => cur
          ? nextOrder(cur, { attempts: [...cur.attempts, { at: new Date().toISOString(), identity, outcome: "update_unverified" }].slice(-MAX_RECOVERY_ATTEMPTS) }, new Date().toISOString()) : null);
        throw new AdapterError("RECOVERY_DISPATCH_UNVERIFIED", "The runtime switch could not be verified; no retry was performed.");
      }
      const prompt = `[RECOVER-ORDER] Continue the original admitted order (message ${message_id}) in this session after an evidenced provider error (${category}); do not duplicate already admitted work. Report a precise INPUT_REQUIRED if a real business decision is needed.`;
      let receipt;
      try {
        receipt = await gateway.sendMessage(session_id, prompt);
      } catch (error) {
        const code = error instanceof AdapterError ? error.code : "SUBMISSION_UNCERTAIN";
        await mutateRecoveryOrder(runtime, session_id, message_id, (cur) => cur
          ? nextOrder(cur, { attempts: [...cur.attempts, { at: new Date().toISOString(), identity, outcome: code === "SUBMISSION_UNCERTAIN" ? "dispatch_uncertain" : "dispatch_failed" }].slice(-MAX_RECOVERY_ATTEMPTS) }, new Date().toISOString()) : null);
        throw error;
      }
      await mutateRecoveryOrder(runtime, session_id, message_id, (cur) => cur
        ? nextOrder(cur, { new_receipt: receipt.message_id, status: isFinal ? "escalated" : "pending" }, new Date().toISOString()) : null);
      return success({
        session_id, message_id, attempted_identity: identity, final_attempt: isFinal,
        new_receipt: receipt.message_id, status: isFinal ? "escalated" : "continued",
      }, isFinal
        ? `Final recovery attempt dispatched (${identity}). Exactly one final attempt per order; escalate to the operator for the next decision.`
        : `Regular recovery candidate ${identity} dispatched. Call again only if this too ends in a terminal provider error.`);
    }));
  server.registerTool(
    "recover_session_order",
    { title: "Recover Session Order",
      description: "Explicit, operator-requested recovery of ONE adapter-admitted single order (not a monitor, not a foreign/archived/aborted order): after a confirmed terminal eligible provider error, resolve the current policy's candidate chain (remaining regular candidates first, then the configured global final stage — exactly once per order) and continue that same original order with exactly one verified runtime switch and one resend, using a durable per-order store with write-ahead before the final dispatch. Read-only GET/status calls never trigger it. A completed or already-escalated order is refused; a further identical call never resets a consumed final attempt. Fail-closed on unknown/uncertain delivery, pending input or an in-progress write. Never automatically resumes foreign, manual, aborted or monitor-bound orders.",
      inputSchema: recoverOrderInput, outputSchema: recoverOrderOutput, annotations: { ...writeAnnotations, openWorldHint: false } },
    recoverSessionOrderHandler,
  );
  if (journalEnabled) {
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
  server.registerTool("get_project_attention", {
    title: "Get Prepared Project Attention",
    description: "Read the bounded, persistent prefetched attention view before scanning sessions for a general status/what-is-new question. Includes task hierarchy where exact existing links and registered C/P markers resolve. A read does not mark an item offered/discussed, prove host continuation, or authorize any follow-up action. Use source_revision-bound acknowledge_project_attention only after actually presenting/discussing it.",
    inputSchema: attentionInput, outputSchema: attentionOutput, annotations: readOnlyAnnotations,
  }, attentionHandler);
  server.registerTool("acknowledge_project_attention", {
    title: "Acknowledge Project Attention",
    description: "Record only an actually presented (offered) or discussed attention item, bound to event_id and source_revision. This is not a webhook receipt, host-continuation receipt, Board update, execution request or permission answer; stale revisions are rejected.",
    inputSchema: attentionReceiptInput, outputSchema: attentionReceiptOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, acknowledgeAttentionHandler);
  }

  server.registerTool(
    "create_session",
    {
      title: "Create OpenCode Session",
      description:
        "Create an empty root work session using the configured default agent/model. Work creation adopts managed policy automatically; reads/management stay neutral. Optional scope_dirs authorizes external directories separately. Optional scope_read_files declares 1..16 exact existing canonical regular absolute files (no globs/symlinks), adding only native Read grants; denies/disables win. No inferred scope or edit grant. Returns session_id; call send_message to start. Non-idempotent: inspect uncertain creation, never retry blindly.",
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
        "Submit one asynchronous work prompt under managed policy. Missing decisions/blocked permissions produce ordinary terminal INPUT_REQUIRED; no automatic approval. Optional scope_dirs authorizes external directories; scope_read_files declares exact canonical regular single files for Read only (1..16, no globs/symlinks; denies/disables win). Scopes merge atomically before prompt admission, including native children; no inferred scope. Attachments use one-use upload IDs. Busy/pending/unknown coverage holds admission. Historical receipts remain separate; inspect uncertain delivery with get_task_result, never blindly resend. Associated attachments are consumed.",
      inputSchema: sendMessageInputSchema,
      outputSchema: sendMessageOutputSchema,
      annotations: writeAnnotations,
    },
    sendMessageHandler,
  );

  if (journalEnabled) {
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
  }

  server.registerTool(
    "send_session_followup",
    {
      title: "Send OpenCode Session Follow-up",
      description:
        "Admit one follow-up message into a session that is actively working (busy or retrying), like sending another message into a running session in the OpenCode Web UI. OpenCode admits it natively while busy and runs it after the current work ends; if the current work is aborted, admitted follow-ups drain batched with the next admitted prompt. No adapter-side queue, retry, priority or mid-turn injection. For an idle session use send_message instead (SESSION_NOT_BUSY). Pending permissions/questions are never bypassed (INPUT_REQUIRED). Non-idempotent: do not blindly retry an uncertain request; SUBMISSION_UNCERTAIN means admission may already have occurred. Returns the stable message_id; correlate it with get_session_status or get_task_result.",
      inputSchema: sendFollowupInputSchema,
      outputSchema: sendMessageOutputSchema,
      annotations: writeAnnotations,
    },
    sendFollowupHandler,
  );

  server.registerTool(
    "abort_session_turn",
    {
      title: "Abort OpenCode Session Turn",
      description:
        "Request a native abort of the session's active turn and verify the outcome through stored reads. Acceptance is not confirmation: state=aborted is only reported with a stored aborted assistant message; otherwise no_active_turn (idle; non-destructive, nothing aborted) or abort_uncertain (inspect get_session_status before proceeding). Never reports a task as completed or passed. No rollback: already-executed changes remain. Queued follow-ups survive the abort; OpenCode drains them with the next admitted prompt. A pending permission request is cleared by the abort, not bypassed.",
      inputSchema: abortSessionTurnInputSchema,
      outputSchema: abortSessionTurnOutputSchema,
      annotations: { ...writeAnnotations, idempotentHint: true },
    },
    abortSessionTurnHandler,
  );


  server.registerTool(
    "list_monitors",
    {
      title: "List Project Monitors",
      description:
        "List all monitors of the connected project including disabled and parked ones. Pagination completeness is explicit (completeness/next_cursor); every entry carries its stable monitor_id and unique master-task binding. Read-only.",
      inputSchema: listMonitorsInput,
      outputSchema: listMonitorsOutput,
      annotations: readOnlyAnnotations,
    },
    listMonitorsHandler,
  );

  server.registerTool(
    "get_monitor",
    {
      title: "Get Project Monitor",
      description:
        "Read one monitor's configured/effective interval, autonomy profile, runtime profile, scheduler state, work state, session binding and next run. Scheduler enabled/disabled, work state and technical run activity stay separate. Read-only.",
      inputSchema: getMonitorInput,
      outputSchema: getMonitorOutput,
      annotations: readOnlyAnnotations,
    },
    getMonitorHandler,
  );

  server.registerTool(
    "create_monitor",
    {
      title: "Create Project Monitor",
      description:
        "Create a project monitor bound to exactly one canonical board task (unique master binding). Default interval 60 s, autonomy profile mvp, runtime profile deep. Non-idempotent: do not retry automatically.",
      inputSchema: createMonitorInput,
      outputSchema: monitorMutationOutput,
      annotations: writeAnnotations,
    },
    createMonitorHandler,
  );

  server.registerTool(
    "update_monitor",
    {
      title: "Update Project Monitor",
      description:
        "Update monitor settings or separate bindings: task_id is the canonical Board anchor; manager_session_id binds an exposed idle manager (null clears it for next-wake recovery). Binding changes validate both sessions, pending input, dispatch and uniqueness before an atomic CAS; tasks/workers/results and scheduler/work state remain. Optional expected_generation rejects concurrent changes.",
      inputSchema: updateMonitorInput,
      outputSchema: monitorMutationOutput,
      annotations: writeAnnotations,
    },
    updateMonitorHandler,
  );

  server.registerTool(
    "enable_monitor",
    {
      title: "Enable Project Monitor Scheduler",
      description:
        "Enable the monitor scheduler. Work state (active/parked/completed/stopped) is unchanged; enabling never creates work.",
      inputSchema: monitorIdInput,
      outputSchema: monitorMutationOutput,
      annotations: writeAnnotations,
    },
    enableMonitorHandler,
  );

  server.registerTool(
    "disable_monitor",
    {
      title: "Disable Project Monitor Scheduler",
      description:
        "Disable the monitor scheduler without changing business work state or aborting a running worker. Use abort_monitor_run for a running turn; cancel_monitor_future for a pending wake.",
      inputSchema: monitorIdInput,
      outputSchema: monitorMutationOutput,
      annotations: writeAnnotations,
    },
    disableMonitorHandler,
  );

  server.registerTool(
    "trigger_monitor",
    {
      title: "Trigger Project Monitor Wake",
      description:
        "Request the next bounded monitor wake (operator trigger). The engine takes at most one bounded action; an unchanged parked monitor remains a no-op without a model call.",
      inputSchema: triggerMonitorInput,
      outputSchema: monitorMutationOutput,
      annotations: writeAnnotations,
    },
    triggerMonitorHandler,
  );

  server.registerTool(
    "cancel_monitor_future",
    {
      title: "Cancel Future Monitor Runs",
      description:
        "Cancel a pending wake request and skip the currently due run (scheduler stays enabled). Distinct from abort_monitor_run (running turn) and disable_monitor (scheduler off).",
      inputSchema: monitorIdInput,
      outputSchema: monitorMutationOutput,
      annotations: writeAnnotations,
    },
    cancelMonitorFutureHandler,
  );

  server.registerTool(
    "abort_monitor_run",
    {
      title: "Abort Running Monitor Action",
      description:
        "Abort the running worker turn of a monitor through the verified native abort and report the stored outcome (aborted/no_active_run/abort_uncertain). No rollback claim; idle is a non-destructive no_active_run.",
      inputSchema: monitorIdInput,
      outputSchema: monitorAbortOutput,
      annotations: { ...writeAnnotations, idempotentHint: true },
    },
    abortMonitorRunHandler,
  );

  server.registerTool(
    "delete_monitor",
    {
      title: "Delete Project Monitor",
      description:
        "Delete a monitor from the project registry. Refuses while the monitor has a running action (MONITOR_STATE_CONFLICT). Run history is removed with the monitor.",
      inputSchema: monitorIdInput,
      outputSchema: monitorDeleteOutput,
      annotations: writeAnnotations,
    },
    deleteMonitorHandler,
  );

  server.registerTool(
    "get_monitor_history",
    {
      title: "Get Project Monitor History",
      description:
        "Read bounded run history (most recent entries), optional bounded logs, last/next run timestamps and explicit freshness (fresh/stale/unknown). Calendar freshness alone is no health guarantee.",
      inputSchema: monitorHistoryInput,
      outputSchema: monitorHistoryOutput,
      annotations: readOnlyAnnotations,
    },
    monitorHistoryHandler,
  );

  server.registerTool(
    "create_monitor_worker",
    {
      title: "Create Monitor Worker",
      description:
        "Reserve a worker alias/context under the monitor registry lock BEFORE creating a root work session, then confirm it against the observed create response. Optional scope_dirs/scope_read_files are structured operator authorizations forwarded to managed policy (the free-text scope field is metadata only and grants nothing). Non-idempotent: an uncertain creation stays reserved and must be reconciled with update_monitor_worker, never retried blindly. The alias is cooperative identity, not an authorization.",
      inputSchema: createMonitorWorkerInput,
      outputSchema: createMonitorWorkerOutput,
      annotations: writeAnnotations,
    },
    createMonitorWorkerHandler,
  );

  server.registerTool(
    "list_monitor_workers",
    {
      title: "List Monitor Workers",
      description:
        "Read the bounded worker index of one monitor: stable worker_key/alias, lifecycle, task binding, context path, runtime session and creation/dispatch receipts. Read-only; a receipt is not task completion.",
      inputSchema: listMonitorWorkersInput,
      outputSchema: listMonitorWorkersOutput,
      annotations: readOnlyAnnotations,
    },
    listMonitorWorkersHandler,
  );

  server.registerTool(
    "update_monitor_worker",
    {
      title: "Update Monitor Worker",
      description:
        "Reconcile an uncertain worker creation (reconcile_created/reconcile_absent), reuse or rebind an own worker after a runtime loss, or mark idle/archive/synthesis. Operates only on workers of the given monitor; foreign workers are refused. Cooperative metadata, not authenticated caller isolation.",
      inputSchema: updateMonitorWorkerInput,
      outputSchema: updateMonitorWorkerOutput,
      annotations: writeAnnotations,
    },
    updateMonitorWorkerHandler,
  );

  // Repo Live MCP app: one UI resource rendered by `open_repo_live`; data flows
  // through the same bounded projection the browser dashboard serves. Read-only.
  const controlOverviewHandler = safeHandler(async () =>
    readSuccess(await requireDashboardControl(gateway).refresh() as object, "Repo Live overview refreshed."));
  const controlSessionHandler = safeHandler(async (value: z.output<typeof controlSessionInput>) => {
    const detail = await requireDashboardControl(gateway).session(value.session_id) as { found?: boolean };
    if (!isRecord(detail) || detail.found !== true)
      throw new AdapterError("SESSION_NOT_FOUND", "The session is not part of the Repo Live projection.");
    return readSuccess(detail as object, "Returned Repo Live session detail.");
  });
  server.registerResource("opencode-repo-live", REPO_LIVE_UI_URI,
    { description: "Read-only Repo Live control view; browser and MCP app share one source.", mimeType: REPO_LIVE_UI_MIME },
    async () => ({ contents: [{ uri: REPO_LIVE_UI_URI, mimeType: REPO_LIVE_UI_MIME, text: await loadControlAppHtml(),
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  server.registerTool("open_repo_live", {
    title: "Open Repo Live",
    description: "Open the read-only Repo Live control view: current tasks, associated sessions, evidenced work state, last activity, freshness and bounded evidence. It starts, stops, merges or changes nothing.",
    inputSchema: controlOverviewInput, annotations: readOnlyAnnotations,
    _meta: { ui: { resourceUri: REPO_LIVE_UI_URI }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } },
  }, controlOverviewHandler);
  server.registerTool("refresh_repo_live", {
    title: "Refresh Repo Live",
    description: "Read a fresh bounded Repo Live overview (tasks, sessions, activity, explicit freshness and coverage). A read is not execution, QC, integration or release evidence.",
    inputSchema: controlOverviewInput, annotations: readOnlyAnnotations,
  }, controlOverviewHandler);
  server.registerTool("get_repo_live_session", {
    title: "Read Repo Live session",
    description: "Read one in-scope session with correlated turn evidence, pending input, separated setting/assistant runtime and the newest metadata events first. Bounded preview; no message text.",
    inputSchema: controlSessionInput, annotations: readOnlyAnnotations,
  }, controlSessionHandler);

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const input = request.params.arguments ?? {};
      return traceToolCall(request.params.name, input, async () => {
        if (!journalEnabled && JOURNAL_TOOLS.has(request.params.name))
          return errorResult(new AdapterError("ACTIVITY_DISABLED",
            "Activity journal is disabled for this session; opt in with --journal on a fresh start."));
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
          case "set_project_model_policy_fallback":
            return validatedToolCall(policyFallbackInput, modelPolicyOutput, input, setFallbackHandler);
          case "set_project_model_policy_profile_fallback":
            return validatedToolCall(policyProfileFallbackInput, modelPolicyOutput, input, setProfileFallbackHandler);
          case "set_project_model_policy_strategies":
            return validatedToolCall(policyStrategiesInput, modelPolicyOutput, input, setStrategiesHandler);
          case "recover_session_order":
            return validatedToolCall(recoverOrderInput, recoverOrderOutput, input, recoverSessionOrderHandler);
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
          case "get_project_attention":
            return validatedToolCall(attentionInput, attentionOutput, input, attentionHandler);
          case "acknowledge_project_attention":
            return validatedToolCall(attentionReceiptInput, attentionReceiptOutput, input, acknowledgeAttentionHandler);
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
          case "send_session_followup":
            return validatedToolCall(
              sendFollowupInputSchema,
              sendMessageOutputSchema,
              input,
              sendFollowupHandler,
            );
          case "abort_session_turn":
            return validatedToolCall(
              abortSessionTurnInputSchema,
              abortSessionTurnOutputSchema,
              input,
              abortSessionTurnHandler,
            );
          case "list_monitors":
            return validatedToolCall(listMonitorsInput, listMonitorsOutput, input, listMonitorsHandler);
          case "get_monitor":
            return validatedToolCall(getMonitorInput, getMonitorOutput, input, getMonitorHandler);
          case "create_monitor":
            return validatedToolCall(createMonitorInput, monitorMutationOutput, input, createMonitorHandler);
          case "update_monitor":
            return validatedToolCall(updateMonitorInput, monitorMutationOutput, input, updateMonitorHandler);
          case "enable_monitor":
            return validatedToolCall(monitorIdInput, monitorMutationOutput, input, enableMonitorHandler);
          case "disable_monitor":
            return validatedToolCall(monitorIdInput, monitorMutationOutput, input, disableMonitorHandler);
          case "trigger_monitor":
            return validatedToolCall(triggerMonitorInput, monitorMutationOutput, input, triggerMonitorHandler);
          case "cancel_monitor_future":
            return validatedToolCall(monitorIdInput, monitorMutationOutput, input, cancelMonitorFutureHandler);
          case "abort_monitor_run":
            return validatedToolCall(monitorIdInput, monitorAbortOutput, input, abortMonitorRunHandler);
          case "delete_monitor":
            return validatedToolCall(monitorIdInput, monitorDeleteOutput, input, deleteMonitorHandler);
          case "get_monitor_history":
            return validatedToolCall(monitorHistoryInput, monitorHistoryOutput, input, monitorHistoryHandler);
          case "create_monitor_worker":
            return validatedToolCall(createMonitorWorkerInput, createMonitorWorkerOutput, input, createMonitorWorkerHandler);
          case "list_monitor_workers":
            return validatedToolCall(listMonitorWorkersInput, listMonitorWorkersOutput, input, listMonitorWorkersHandler);
          case "update_monitor_worker":
            return validatedToolCall(updateMonitorWorkerInput, updateMonitorWorkerOutput, input, updateMonitorWorkerHandler);
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
          case "open_repo_live":
          case "refresh_repo_live":
            return validatedToolCall(controlOverviewInput, controlOutput, input, controlOverviewHandler);
          case "get_repo_live_session":
            return validatedToolCall(controlSessionInput, controlOutput, input, controlSessionHandler);
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

/** Dispatch MCP 2026 tool and resource requests through the same registered
 * handlers while the pinned SDK transport remains on the legacy 2025 baseline. */
export async function dispatchMcp2Method(
  gateway: SessionGateway,
  runtime: RuntimeDescriptor,
  method: "tools/list" | "tools/call" | "resources/list" | "resources/read",
  id: string | number,
  params: Record<string, unknown>,
): Promise<unknown> {
  const server = createMcpServer(gateway, runtime);
  try {
    type Handler = (request: unknown, extra: unknown) => Promise<unknown>;
    const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers;
    const handler = handlers?.get(method);
    if (!handler) throw new AdapterError("UNSUPPORTED_CONFIGURATION", `MCP 2026 ${method} handler is unavailable.`);
    const legacyParams = { ...params };
    delete legacyParams._meta;
    return await handler({ jsonrpc: "2.0", id, method, params: legacyParams }, {
      requestId: id,
      signal: AbortSignal.timeout(20_000),
    });
  } finally {
    await server.close().catch(() => undefined);
  }
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
    ...(["ACTIVITY_DISABLED", "ACTIVITY_UNAVAILABLE"].includes(error.code)
      ? { structuredContent: { error_code: error.code, message: error.message } } : {}),
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
