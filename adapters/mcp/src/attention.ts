import type {
  ActivityEvent,
  AttentionClass,
  AttentionEntry,
  CorrelatedErrorDetail,
  DeliveryPolicy,
} from "./types.js";
import { utf8Prefix } from "./content.js";

const attentionEvents = new Map<string, AttentionClass>([
  ["message.completed", "ready"],
  ["message.failed", "attention"],
  ["message.aborted", "attention"],
  ["session.input_required", "action_required"],
]);

export function attentionClass(event: ActivityEvent): AttentionClass | undefined {
  return attentionEvents.get(event.type);
}

export function initialAttention(event: ActivityEvent, sequence: number): AttentionEntry | undefined {
  const classification = attentionClass(event);
  if (!classification) return undefined;
  return {
    event_id: event.event_id,
    activity_cursor: event.cursor,
    event_sequence: sequence,
    event_type: event.type,
    classification,
    lifecycle: "new",
    session_id: event.session_id,
    session_title: event.session_title,
    ...(event.message_id ? { submitted_message_id: event.message_id } : {}),
    assistant_message_ids: event.assistant_message_ids,
    occurred_at: event.timestamp,
    observed_at: event.timestamp,
    prepared_summary: "",
    next_safe_step: "",
      hierarchy_status: "pending",
    delivery_policy: "on_demand_fallback",
    deliveries: {},
  };
}

export function summarizeAttention(
  entry: AttentionEntry,
  visibleResult: string,
  sourceRevision: string,
  sha256: string,
  assistantMessageIds: string[],
  task?: { task_id: string; title: string; status: string; updated_at?: string },
  hierarchy?: {
    master_task_id?: string;
    master_task_title?: string;
    master_task_status?: string;
    work_package_id?: string;
    work_package_title?: string;
    work_package_status?: string;
    summary?: string;
    management_checkpoints?: AttentionEntry["management_checkpoints"];
  },
  hierarchyStatus: AttentionEntry["hierarchy_status"] = "unlinked",
  errorDetails: CorrelatedErrorDetail[] = [],
  errorDetailsTotal = errorDetails.length,
  errorDetailsTruncated = false,
): Omit<AttentionEntry, "deliveries"> {
  const lead = sanitizeSummary(visibleResult).replace(/\s+/gu, " ").trim();
  const errorLead = errorDetails
    .map((detail) => detail.message)
    .join(" ");
  const title = task ? `${sanitizeSummary(task.title)}: ` : "";
  const outcome = entry.classification === "ready"
    ? "Worker result is available"
    : entry.classification === "action_required"
      ? "Worker requires operator input"
      : entry.event_type === "message.aborted"
        ? "Worker turn was aborted"
        : "Worker turn failed";
  const excerpt = lead
    ? utf8Prefix(lead, 420)
    : errorLead
      ? utf8Prefix(errorLead, 420)
      : "No complete visible result text was exposed.";
  const nextSafeStep = entry.classification === "ready"
    ? "Review the original result and decide any authorized next step; no follow-up was started."
    : entry.classification === "action_required"
      ? "Review and resolve the pending input in the host UI; no permission or question was answered."
      : "Review the original failure/abort evidence; no automatic retry or replacement worker was started.";
  return {
    ...entry,
    lifecycle: "ready",
    source_revision: sourceRevision,
    result_sha256: sha256,
    assistant_message_ids: assistantMessageIds,
    prepared_at: new Date().toISOString(),
    prepared_summary: utf8Prefix(sanitizeSummary(`${outcome}${title ? ` — ${title}` : ". "}${hierarchy?.summary ? ` Context: ${hierarchy.summary}.` : ""} ${excerpt}`), 900),
    next_safe_step: nextSafeStep,
    hierarchy_status: hierarchyStatus,
    ...(task ? {
      task_id: task.task_id,
      task_title: sanitizeSummary(task.title),
      task_status: task.status,
      ...(task.updated_at ? { task_updated_at: task.updated_at } : {}),
    } : {}),
    ...(hierarchy?.master_task_id ? { master_task_id: hierarchy.master_task_id } : {}),
    ...(hierarchy?.master_task_title ? { master_task_title: sanitizeSummary(hierarchy.master_task_title) } : {}),
    ...(hierarchy?.master_task_status ? { master_task_status: hierarchy.master_task_status } : {}),
    ...(hierarchy?.work_package_id ? { work_package_id: hierarchy.work_package_id } : {}),
    ...(hierarchy?.work_package_title ? { work_package_title: sanitizeSummary(hierarchy.work_package_title) } : {}),
    ...(hierarchy?.work_package_status ? { work_package_status: hierarchy.work_package_status } : {}),
    ...(hierarchy?.summary ? { hierarchy_summary: utf8Prefix(sanitizeSummary(hierarchy.summary), 512) } : {}),
    ...(hierarchy?.management_checkpoints ? { management_checkpoints: hierarchy.management_checkpoints } : {}),
    ...(errorDetails.length
      ? {
          error_details: errorDetails,
          error_details_total: errorDetailsTotal,
          error_details_truncated: errorDetailsTruncated,
        }
      : {}),
    evidence: {
      source: "visible_original",
      source_revision: sourceRevision,
      sha256,
      assistant_message_ids: assistantMessageIds,
      complete: true,
    },
  };
}

export type DeliveryContext = {
  proactiveMonitoringConfirmed: boolean;
  conversationBusy: boolean | "unknown";
  hostSupportsDeferredDelivery: boolean;
};

export function deliveryPolicy(context: DeliveryContext): DeliveryPolicy {
  if (!context.proactiveMonitoringConfirmed) return "on_demand_fallback";
  if (context.conversationBusy === true)
    return context.hostSupportsDeferredDelivery
      ? "deferred_to_next_idle_boundary"
      : "on_demand_fallback";
  return "immediate_proactive_wakeup";
}

export function sanitizeSummary(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\b[A-Z0-9_-]*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY)[A-Z0-9_-]*\s*[:=]\s*[^\s,;]+/giu, "[REDACTED]")
    .replace(/\b[A-Z0-9_-]*(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY)[A-Z0-9_-]*\b/giu, "[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|Bearer\s+\S+)\b/giu, "[REDACTED]");
}
