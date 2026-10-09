import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AdapterError,
  ACTIVITY_TYPES,
  isRecord,
  MAX_CORRELATED_ERROR_DETAILS,
} from "./types.js";
import type {
  ActivityEvent,
  AttentionEntry,
  AttentionQuery,
  AttentionResult,
  AttentionReceipt,
  EventSubscription,
  ActivityQuery,
  ActivitySnapshot,
  ActivityType,
  ActivityResult,
  SessionStatusResult,
  ReceiptResolution,
  SubmissionGuardOverrideResult,
  SubmissionGuardSnapshot,
} from "./types.js";
import { initialAttention } from "./attention.js";
import { isSafeAssistantErrorDetail } from "./content.js";

type GuardOverrideRecord = {
  request_id: string;
  fingerprint: string;
  session_id: string;
  guarded_message_id: string;
  message_id: string;
  reason?: string;
  preflight: SubmissionGuardSnapshot;
  superseded_at: string;
  activity_cursor: string;
  state: "prepared" | "submitted";
  result?: SubmissionGuardOverrideResult;
};
type Store = {
  schema: 1;
  project: string;
  epoch: string;
  next: number;
  events: ActivityEvent[];
  observations: Record<string, ActivitySnapshot>;
  watched: Record<string, string[]>;
  guardOverrides?: Record<string, GuardOverrideRecord>;
  resolutions?: Record<string, ReceiptResolution>;
  attention?: Record<string, AttentionEntry>;
  attentionNext?: number;
  subscriptions?: Record<string, EventSubscription>;
};
type EventInput = Omit<ActivityEvent, "event_id" | "cursor" | "timestamp">;
const terminal = new Set(["completed", "failed", "aborted"]);

/** Bounded, metadata-only error class for diagnostics: an errno-shaped code or
 * the error class name. Deliberately narrow so a path, payload or secret can
 * never reach the adapter log through this field. */
export function persistErrorClass(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code)) return code;
  const name = (error as Error | null | undefined)?.name;
  if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) return name;
  return "unknown";
}

/** One owned adapter is the writer. Commits serialize observation + event state
 * in one atomic file; reads never perform backend polling or copy history. */
export class ActivityJournal {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;
  private readonly waiters = new Set<() => void>();

  get available(): boolean { return !this.failed && !this.closed; }

  private constructor(
    private readonly path: string,
    private store: Store,
    private readonly maximum: number,
  ) {}

  /** Dashboard consumes the already validated journal without opening a writer,
   * migration, commit, prefetch, event subscription or receipt acknowledgement. */
  static async readDashboard(path: string, project: string, sessions: Set<string>) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 32 * 1024 * 1024) throw new Error("Unsafe activity journal");
      const store = JSON.parse(await file.readFile("utf8")) as Store;
      if (!validStore(store, project) || !validEvents(store)) throw new Error("Invalid activity journal");
      return { epoch: store.epoch, updated_at: new Date(info.mtimeMs).toISOString(), recent: store.events.filter(event => sessions.has(event.session_id ?? ""))
        .slice(-10).map(event => ({ event_id: event.event_id, session_id: event.session_id,
          message_id: event.message_id ?? null, type: event.type, timestamp: event.timestamp })) };
    } finally { await file.close(); }
  }

  static async open(
    path: string,
    project: string,
    maximum = 5000,
    legacyPath?: string,
  ): Promise<ActivityJournal> {
    const parent = await lstat(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    ) {
      throw new AdapterError(
        "ACTIVITY_UNAVAILABLE",
        "Activity directory must be private and user-owned.",
      );
    }
    let store: Store;
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o777) !== 0o600 ||
          stat.size > 32 * 1024 * 1024
        )
          throw new Error();
        store = JSON.parse(await file.readFile("utf8")) as Store;
        if (!validStore(store, project) || !validEvents(store))
          throw new Error();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AdapterError(
          "ACTIVITY_UNAVAILABLE",
          "Activity journal is invalid or unsafe; it was not reset.",
        );
      if (legacyPath) await adoptLegacyJournal(path, legacyPath, project);
      try {
        const adopted = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await adopted.stat();
          if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 32 * 1024 * 1024) throw new Error();
          const legacy = JSON.parse(await adopted.readFile("utf8")) as Store;
          if (legacy.observations === undefined) legacy.observations = {};
          if (legacy.watched === undefined) legacy.watched = {};
          if (!validStore(legacy, project) || !validEvents(legacy)) throw new Error();
          store = legacy;
        } finally { await adopted.close(); }
      } catch (adoptError) {
        if ((adoptError as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AdapterError("ACTIVITY_UNAVAILABLE", "Legacy activity journal is invalid or unsafe; it was not reset.");
        store = {
          schema: 1, project, epoch: randomUUID(), next: 1, events: [], observations: {}, watched: {},
          guardOverrides: {}, resolutions: {}, attention: {}, attentionNext: 1, subscriptions: {},
        };
      }
    }
    store.guardOverrides ??= {};
    store.resolutions ??= {};
    store.attention ??= {};
    store.attentionNext ??= Math.max(1, ...Object.values(store.attention).map((entry) => entry.event_sequence + 1));
    store.subscriptions ??= {};
    const journal = new ActivityJournal(path, store, maximum);
    await journal.commit(() => true);
    return journal;
  }

  get cursor(): string {
    return this.cursorFor(this.store.next - 1);
  }
  get trackedSessions(): string[] {
    return Object.keys(this.store.watched);
  }
  trackedMessages(id: string): string[] {
    return [...(this.store.watched[id] ?? [])];
  }

  async listAttention(query: AttentionQuery = {}, visible: (sessionId: string) => Promise<boolean> = async () => true): Promise<AttentionResult> {
    await this.tail;
    this.check();
    const limit = query.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new AdapterError("INVALID_ARGUMENT", "Attention limit must be between 1 and 50.");
    const head = (this.store.attentionNext ?? 1) - 1;
    const after = this.attentionSequence(query.after_cursor);
    const before = query.before_cursor === undefined ? head + 1 : this.attentionSequence(query.before_cursor);
    if (query.after_cursor !== undefined && query.before_cursor !== undefined)
      throw new AdapterError("INVALID_ARGUMENT", "Attention cursors are mutually exclusive.");
    const lifecycle = new Set(query.lifecycle ?? ["ready", "offered"]);
    const classification = query.classification ? new Set(query.classification) : undefined;
    const candidates = Object.values(this.store.attention ?? {})
      .filter((entry) => entry.event_sequence > after && entry.event_sequence < before && lifecycle.has(entry.lifecycle) &&
        (!classification || classification.has(entry.classification)))
      .sort((a, b) => query.after_cursor ? a.event_sequence - b.event_sequence : b.event_sequence - a.event_sequence);
    const entries: AttentionEntry[] = [];
    let scanned = 0;
    const deadline = Date.now() + 1000;
    for (const entry of candidates) {
      if (entries.length >= limit || Date.now() >= deadline) break;
      scanned++;
      if (await visible(entry.session_id)) entries.push(entry);
    }
    return {
      entries: structuredClone(entries),
      next_cursor: this.attentionCursor(entries.at(-1)?.event_sequence ?? head),
      has_more: scanned < candidates.length,
      current_cursor: this.attentionCursor(head),
    };
  }

  async pendingAttention(limit = 25): Promise<AttentionEntry[]> {
    await this.tail;
    this.check();
    return structuredClone(Object.values(this.store.attention ?? {})
      .filter((entry) => entry.lifecycle === "new")
      .sort((a, b) => a.event_sequence - b.event_sequence)
      .slice(0, limit));
  }

  async attention(eventId: string): Promise<AttentionEntry | undefined> {
    await this.tail;
    this.check();
    const entry = this.store.attention?.[eventId];
    return entry ? structuredClone(entry) : undefined;
  }

  async prepareAttention(entry: AttentionEntry): Promise<boolean> {
    let prepared = false;
    await this.commit((draft) => {
      const current = draft.attention![entry.event_id];
      if (!current || current.lifecycle === "superseded") return false;
      if (current.lifecycle !== "new" && current.source_revision === entry.source_revision) return false;
      const hasNewer = Object.values(draft.attention!).some((candidate) =>
        candidate.event_id !== entry.event_id && candidate.lifecycle !== "discussed" &&
        candidate.session_id === entry.session_id &&
        ((entry.submitted_message_id && candidate.submitted_message_id === entry.submitted_message_id) ||
          (entry.task_id && candidate.task_id === entry.task_id)) &&
        candidate.event_sequence > entry.event_sequence);
      if (hasNewer) {
        current.lifecycle = "superseded";
        current.prepared_summary = "Superseded by newer correlated activity; reconcile the current result.";
        current.superseded_by = Object.values(draft.attention!).find((candidate) =>
          candidate.session_id === entry.session_id && candidate.event_sequence > entry.event_sequence &&
          ((entry.submitted_message_id && candidate.submitted_message_id === entry.submitted_message_id) ||
            (entry.task_id && candidate.task_id === entry.task_id)))?.event_id;
        return true;
      }
      for (const candidate of Object.values(draft.attention!)) {
        if (candidate.event_id === entry.event_id || candidate.lifecycle === "discussed" ||
          candidate.event_sequence >= entry.event_sequence || candidate.session_id !== entry.session_id) continue;
        if ((entry.submitted_message_id && candidate.submitted_message_id === entry.submitted_message_id) ||
            (entry.task_id && candidate.task_id === entry.task_id)) {
          candidate.lifecycle = "superseded";
          candidate.superseded_by = entry.event_id;
        }
      }
      entry.deliveries = current.deliveries;
      entry.lifecycle = "ready";
      for (const subscription of Object.values(draft.subscriptions ?? {})) {
        if (!subscription.active || (subscription.expires_at !== null && Date.parse(subscription.expires_at) <= Date.now()) ||
          subscription.event_name !== eventName(entry.event_type) ||
          (subscription.arguments.session_id && subscription.arguments.session_id !== entry.session_id) ||
          (subscription.arguments.task_id && subscription.arguments.task_id !== entry.task_id)) continue;
        entry.deliveries[subscription.id] ??= {
          state: "pending", attempts: 0, updated_at: new Date().toISOString(),
        };
      }
      draft.attention![entry.event_id] = structuredClone(entry);
      prepared = true;
      return true;
    });
    return prepared;
  }

  async attentionReceipt(input: AttentionReceipt): Promise<AttentionEntry> {
    let result: AttentionEntry | undefined;
    await this.commit((draft) => {
      const entry = draft.attention![input.event_id];
      if (!entry || entry.lifecycle === "new" || entry.lifecycle === "superseded")
        throw new AdapterError("ATTENTION_NOT_FOUND", "Prepared attention entry is unavailable.");
      if (!entry.source_revision || entry.source_revision !== input.source_revision)
        throw new AdapterError("ATTENTION_CHANGED", "Attention source revision changed; read the current entry before acknowledging it.");
      if (entry.lifecycle === "discussed" || entry.lifecycle === input.lifecycle) {
        result = entry;
        return false;
      }
      if (input.lifecycle === "discussed" && entry.lifecycle !== "offered")
        throw new AdapterError("ATTENTION_STATE_CONFLICT", "An entry must be offered before it can be marked discussed.");
      if (input.lifecycle === "offered" && entry.lifecycle !== "ready")
        throw new AdapterError("ATTENTION_STATE_CONFLICT", "Only a ready entry can be offered.");
      entry.lifecycle = input.lifecycle;
      result = entry;
      return true;
    });
    if (!result) throw new AdapterError("ACTIVITY_UNAVAILABLE", "Attention receipt was not persisted.");
    return structuredClone(result);
  }

  async upsertSubscription(subscription: EventSubscription): Promise<EventSubscription> {
    let result: EventSubscription | undefined;
    await this.commit((draft) => {
      const existing = draft.subscriptions![subscription.id];
      if (!existing && Object.values(draft.subscriptions!).filter((item) => item.active &&
        (item.expires_at === null || Date.parse(item.expires_at) > Date.now())).length >= 32)
        throw new AdapterError("EVENT_SUBSCRIPTION_LIMIT", "The project event subscription limit is 32.");
      const next = existing
        ? { ...existing, ...subscription, created_at: existing.created_at }
        : subscription;
      draft.subscriptions![subscription.id] = next;
      result = next;
      return JSON.stringify(existing) !== JSON.stringify(next);
    });
    if (!result) throw new AdapterError("ACTIVITY_UNAVAILABLE", "Event subscription was not persisted.");
    return structuredClone(result);
  }

  async removeSubscription(id: string): Promise<boolean> {
    let removed = false;
    await this.commit((draft) => {
      if (!draft.subscriptions![id]) return false;
      delete draft.subscriptions![id];
      for (const entry of Object.values(draft.attention!)) delete entry.deliveries[id];
      removed = true;
      return true;
    });
    return removed;
  }

  async subscriptions(): Promise<EventSubscription[]> {
    await this.tail;
    this.check();
    const now = Date.now();
    return structuredClone(Object.values(this.store.subscriptions ?? {}).filter((item) =>
      item.active && (item.expires_at === null || Date.parse(item.expires_at) > now)));
  }

  async subscription(id: string): Promise<EventSubscription | undefined> {
    await this.tail;
    this.check();
    const value = this.store.subscriptions?.[id];
    return value ? structuredClone(value) : undefined;
  }

  async supersedeAttention(eventId: string, reason: string): Promise<void> {
    await this.commit((draft) => {
      const entry = draft.attention![eventId];
      if (!entry || entry.lifecycle === "discussed" || entry.lifecycle === "superseded") return false;
      entry.lifecycle = "superseded";
      entry.prepared_summary = reason.slice(0, 420);
      return true;
    });
  }

  async pendingDeliveries(limit = 50): Promise<Array<{ entry: AttentionEntry; subscription: EventSubscription }>> {
    await this.tail;
    this.check();
    const now = Date.now();
    const result: Array<{ entry: AttentionEntry; subscription: EventSubscription }> = [];
    for (const entry of Object.values(this.store.attention ?? {}).sort((a, b) => a.event_sequence - b.event_sequence)) {
      if (entry.lifecycle !== "ready" && entry.lifecycle !== "offered") continue;
      for (const subscription of Object.values(this.store.subscriptions ?? {})) {
        const receipt = entry.deliveries[subscription.id];
        if (!receipt || (receipt.state !== "pending" && !(receipt.state === "failed" && receipt.next_attempt_at)) ||
          (receipt.next_attempt_at && Date.parse(receipt.next_attempt_at) > now) ||
          !subscription.active || (subscription.expires_at !== null && Date.parse(subscription.expires_at) <= now)) continue;
        result.push({ entry: structuredClone(entry), subscription: structuredClone(subscription) });
        if (result.length >= limit) return result;
      }
    }
    return result;
  }

  async recordDelivery(eventId: string, subscriptionId: string, result: {
    state: "delivered" | "failed" | "abandoned";
    http_status?: number;
    retry_at?: string;
  }): Promise<void> {
    await this.commit((draft) => {
      const entry = draft.attention![eventId];
      const subscription = draft.subscriptions![subscriptionId];
      if (!entry || !subscription) return false;
      const previous = entry.deliveries[subscriptionId];
      if (previous?.state === "delivered" || previous?.state === "abandoned") return false;
      entry.deliveries[subscriptionId] = {
        state: result.state,
        attempts: (previous?.attempts ?? 0) + 1,
        ...(result.retry_at ? { next_attempt_at: result.retry_at } : {}),
        ...(result.http_status !== undefined ? { http_status: result.http_status } : {}),
        updated_at: new Date().toISOString(),
      };
      if (result.state === "delivered") {
        entry.delivery_policy = "immediate_proactive_wakeup";
        subscription.last_cursor = entry.activity_cursor;
      }
      return true;
    });
  }

  async guardOverride(requestId: string): Promise<GuardOverrideRecord | undefined> {
    await this.tail;
    this.check();
    const record = this.store.guardOverrides?.[requestId];
    return record ? structuredClone(record) : undefined;
  }

  async receiptResolution(
    sessionId: string,
    messageId: string,
  ): Promise<ReceiptResolution | undefined> {
    await this.tail;
    this.check();
    const resolution = this.store.resolutions?.[resolutionKey(sessionId, messageId)];
    return resolution ? structuredClone(resolution) : undefined;
  }

  async prepareGuardOverride(input: {
    request_id: string;
    fingerprint: string;
    session_id: string;
    session_title: string;
    guarded_message_id: string;
    message_id: string;
    reason?: string;
    preflight: SubmissionGuardSnapshot;
  }): Promise<{ record: GuardOverrideRecord; created: boolean }> {
    let result: { record: GuardOverrideRecord; created: boolean } | undefined;
    await this.commit((draft) => {
      const prior = draft.guardOverrides![input.request_id];
      if (prior) {
        if (
          prior.fingerprint !== input.fingerprint ||
          prior.session_id !== input.session_id ||
          prior.guarded_message_id !== input.guarded_message_id
        )
          throw new AdapterError(
            "SUBMISSION_GUARD_CONFLICT",
            "This request_id is already bound to a different guard override request.",
          );
        result = { record: prior, created: false };
        return false;
      }
      const supersededAt = new Date().toISOString();
      const record: GuardOverrideRecord = {
        request_id: input.request_id,
        fingerprint: input.fingerprint,
        session_id: input.session_id,
        guarded_message_id: input.guarded_message_id,
        message_id: input.message_id,
        ...(input.reason ? { reason: input.reason } : {}),
        preflight: input.preflight,
        superseded_at: supersededAt,
        activity_cursor: this.cursorFor(draft.next - 1),
        state: "prepared",
      };
      draft.guardOverrides![input.request_id] = record;
      draft.resolutions![resolutionKey(input.session_id, input.guarded_message_id)] = {
        state: "unresolved",
        resolution: "superseded_by_operator",
        superseded_at: supersededAt,
        superseded_by_request_id: input.request_id,
        superseded_by_message_id: input.message_id,
        ...(input.reason ? { reason: input.reason } : {}),
      };
      draft.watched[input.session_id] = [
        ...new Set([...(draft.watched[input.session_id] ?? []), input.message_id]),
      ].slice(-100);
      this.push(draft, {
        session_id: input.session_id,
        session_title: input.session_title.slice(0, 160),
        message_id: input.message_id,
        guarded_message_id: input.guarded_message_id,
        request_id: input.request_id,
        ...(input.reason ? { reason: input.reason } : {}),
        operator_authorized: true,
        authorization_source: "operator_asserted",
        guarded_receipt_state: input.preflight.guarded_receipt_state,
        ...(input.preflight.last_activity_at !== undefined
          ? { last_activity_at: input.preflight.last_activity_at }
          : {}),
        type: "submission.guard_overridden",
        state: "superseded_by_operator",
        assistant_message_ids: [],
        source: "mcp",
      });
      result = { record, created: true };
      return true;
    });
    if (!result)
      throw new AdapterError(
        "ACTIVITY_UNAVAILABLE",
        "Could not persist the submission guard override.",
      );
    return structuredClone(result);
  }

  async completeGuardOverride(
    requestId: string,
    sessionTitle: string,
    result: SubmissionGuardOverrideResult,
  ): Promise<void> {
    await this.commit((draft) => {
      const record = draft.guardOverrides![requestId];
      if (!record || record.message_id !== result.message_id)
        throw new AdapterError(
          "ACTIVITY_UNAVAILABLE",
          "The prepared guard override record is unavailable.",
        );
      if (record.state === "submitted") return false;
      record.state = "submitted";
      record.result = result;
      const snapshot =
        draft.observations[result.session_id] ??
        this.empty(result.session_id, sessionTitle);
      snapshot.session_title = sessionTitle.slice(0, 160);
      if (!snapshot.messages.some((item) => item.message_id === result.message_id)) {
        const submitted: SessionStatusResult = {
          session_id: result.session_id,
          message_id: result.message_id,
          state: "submitted",
          backend_activity: "idle",
          pending_input: { permissions: 0, questions: 0 },
          assistant_message_ids: [],
        };
        snapshot.messages.push(submitted);
        draft.observations[result.session_id] = snapshot;
        this.push(
          draft,
          this.event(snapshot, "message.submitted", "submitted", "mcp", submitted),
        );
      }
      return true;
    });
  }

  async track(sessionId: string, messageId: string): Promise<string> {
    let cursor = "";
    await this.commit((draft) => {
      cursor = this.cursorFor(draft.next - 1);
      draft.watched[sessionId] = [
        ...new Set([...(draft.watched[sessionId] ?? []), messageId]),
      ].slice(-100);
      return true;
    });
    return cursor;
  }

  async submitted(
    sessionId: string,
    title: string,
    messageId: string,
  ): Promise<void> {
    await this.commit((draft) => {
      const snapshot =
        draft.observations[sessionId] ?? this.empty(sessionId, title);
      if (snapshot.messages.some((message) => message.message_id === messageId))
        return false;
      snapshot.messages.push({
        session_id: sessionId,
        message_id: messageId,
        backend_activity: "idle",
        state: "submitted",
        pending_input: { permissions: 0, questions: 0 },
        assistant_message_ids: [],
      });
      draft.observations[sessionId] = snapshot;
      this.push(
        draft,
        this.event(
          snapshot,
          "message.submitted",
          "submitted",
          "mcp",
          snapshot.messages.at(-1),
        ),
      );
      return true;
    });
  }

  async observe(
    snapshot: ActivitySnapshot,
    source: ActivityEvent["source"],
  ): Promise<boolean> {
    let changed = false;
    await this.commit((draft) => {
      changed = this.applyObservation(draft, snapshot, source);
      return changed;
    });
    return changed;
  }

  private applyObservation(
    draft: Store,
    snapshot: ActivitySnapshot,
    source: ActivityEvent["source"],
  ): boolean {
    const previous = draft.observations[snapshot.session_id];
    snapshot = {
      ...snapshot,
      messages: snapshot.messages.map((message) => {
        const old = previous?.messages.find(
          (item) => item.message_id === message.message_id,
        );
        if (!old || !terminal.has(old.state)) return message;
        if (message.state !== old.state) return old;
        const retainedErrorDetails = message.error_details === undefined && old.error_details
          ? {
              error_details: old.error_details,
              error_details_total: old.error_details_total,
              error_details_truncated: old.error_details_truncated,
              error_evidence_revision: old.error_evidence_revision,
            }
          : {};
        return {
          ...message,
          state: old.state,
          assistant_message_ids: [...new Set([
            ...old.assistant_message_ids,
            ...message.assistant_message_ids,
          ])],
          ...retainedErrorDetails,
        };
      }),
    };
    if (JSON.stringify(previous) === JSON.stringify(snapshot)) return false;
    if (!previous || previous.activity !== snapshot.activity) {
      const busy = snapshot.activity !== "idle";
      this.push(
        draft,
        this.event(
          snapshot,
          busy ? "session.busy" : "session.idle",
          busy ? "busy" : "idle",
          source,
        ),
      );
    }
    if (
      previous?.runtime &&
      snapshot.runtime &&
      JSON.stringify(previous.runtime) !== JSON.stringify(snapshot.runtime)
    ) {
      this.push(draft, {
        ...this.event(snapshot, "session.runtime_changed", "updated", source),
        previous: previous.runtime,
        current: snapshot.runtime,
      });
    }
    for (const message of snapshot.messages) {
      if (!message.message_id || message.state === "unknown") continue;
      const old = previous?.messages.find(
        (item) => item.message_id === message.message_id,
      );
      if (
        old &&
        terminal.has(old.state) &&
        JSON.stringify({
          error_details: old.error_details,
          error_details_total: old.error_details_total,
          error_details_truncated: old.error_details_truncated,
          error_evidence_revision: old.error_evidence_revision,
        }) !== JSON.stringify({
          error_details: message.error_details,
          error_details_total: message.error_details_total,
          error_details_truncated: message.error_details_truncated,
          error_evidence_revision: message.error_evidence_revision,
        })
      ) {
        // Revised durable evidence needs a new cursor and delivery receipts.
        this.push(draft, this.event(
          snapshot,
          `message.${message.state}` as ActivityType,
          message.state,
          source,
          message,
        ));
      }
      if (!old)
        this.push(
          draft,
          this.event(
            snapshot,
            "message.submitted",
            "submitted",
            source,
            message,
          ),
        );
      // A terminal receipt cannot become running again due to stale status events.
      if (
        !terminal.has(old?.state ?? "") &&
        message.state !== "submitted" &&
        message.state !== "input_required" &&
        message.state !== old?.state
      ) {
        this.push(
          draft,
          this.event(
            snapshot,
            `message.${message.state}` as ActivityType,
            message.state,
            source,
            message,
          ),
        );
      }
      if (terminal.has(message.state))
        draft.watched[snapshot.session_id] = (
          draft.watched[snapshot.session_id] ?? []
        ).filter((id) => id !== message.message_id);
    }
    const pendingChanged =
      JSON.stringify(previous?.pending_input) !==
      JSON.stringify(snapshot.pending_input);
    const pendingMessage = [...snapshot.messages]
      .reverse()
      .find((message) => message.state === "input_required");
    if (
      pendingChanged &&
      snapshot.pending_input.permissions + snapshot.pending_input.questions > 0
    ) {
      this.push(draft, {
        ...this.event(
          snapshot,
          "session.input_required",
          "input_required",
          source,
          pendingMessage,
        ),
        pending_input: snapshot.pending_input,
      });
      if (snapshot.pending_input.permissions > 0)
        this.push(draft, {
          ...this.event(
            snapshot,
            "session.permission_required",
            "input_required",
            source,
            pendingMessage,
          ),
          pending_input: snapshot.pending_input,
        });
    }
    draft.observations[snapshot.session_id] = snapshot;
    if (!draft.watched[snapshot.session_id]?.length)
      delete draft.watched[snapshot.session_id];
    return true;
  }

  async signal(
    sessionId: string,
    title: string,
    signal: "busy" | "idle" | "permission" | "question",
  ): Promise<void> {
    await this.commit((draft) => {
      const snapshot = structuredClone(
        draft.observations[sessionId] ?? this.empty(sessionId, title),
      );
      snapshot.session_title = title;
      if (signal === "busy" || signal === "idle") snapshot.activity = signal;
      else if (signal === "permission")
        snapshot.pending_input.permissions = Math.max(
          1,
          snapshot.pending_input.permissions,
        );
      else
        snapshot.pending_input.questions = Math.max(
          1,
          snapshot.pending_input.questions,
        );
      if (signal === "permission" || signal === "question") {
        snapshot.messages = snapshot.messages.map((message) =>
          !terminal.has(message.state) && message.state !== "unknown"
            ? {
                ...message,
                state: "input_required",
                pending_input: snapshot.pending_input,
              }
            : message,
        );
      }
      return this.applyObservation(draft, snapshot, "observed");
    });
  }

  async read(
    query: ActivityQuery,
    visible: (id: string) => Promise<boolean>,
  ): Promise<{
    events: ActivityEvent[];
    next_cursor: string;
    has_more: boolean;
    filter_key: string;
    tail?: ActivityResult["tail"];
  }> {
    await this.tail;
    this.check();
    const snapshot = this.store;
    if (query.tail && query.after_cursor !== undefined)
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "tail cannot be combined with after_cursor.",
      );
    const filterKey = `activity-filter-v1:${createHash("sha256")
      .update(
        JSON.stringify({
          project: snapshot.project,
          sessions: query.session_ids
            ? [...new Set(query.session_ids)].sort()
            : null,
          types: query.event_types
            ? [...new Set(query.event_types)].sort()
            : null,
        }),
      )
      .digest("hex")}`;
    const after = this.sequence(query.after_cursor, snapshot);
    const limit = query.limit ?? 50;
    const matches: ActivityEvent[] = [];
    const permissions = new Map<string, boolean>();
    const deadline = Date.now() + 1000;
    if (query.tail) {
      // Capture the head before asynchronous visibility checks. New events must
      // remain reachable through next_cursor, never silently join this snapshot.
      let index = snapshot.events.length - 1;
      let limited = false;
      for (; index >= 0; index--) {
        if (Date.now() >= deadline) {
          limited = true;
          break;
        }
        const event = snapshot.events[index]!;
        if (
          (query.session_ids &&
            !query.session_ids.includes(event.session_id)) ||
          (query.event_types && !query.event_types.includes(event.type))
        )
          continue;
        if (!permissions.has(event.session_id))
          permissions.set(event.session_id, await visible(event.session_id));
        if (!permissions.get(event.session_id)) continue;
        matches.push(event);
        if (matches.length === limit) {
          index--;
          break;
        }
      }
      return {
        events: structuredClone(matches.reverse()),
        next_cursor: this.cursorFor(snapshot.next - 1),
        has_more: false,
        filter_key: filterKey,
        tail: {
          selection_complete: !limited,
          earlier_events_not_examined: index >= 0,
        },
      };
    }
    let scanned = after;
    let budgetReached = false;
    for (const event of snapshot.events) {
      const sequence = Number(event.cursor.split(":")[1]);
      if (sequence <= after) continue;
      // A large backlog of different/archived sessions must not turn one read
      // or short wait into minutes of serial backend validation. Finish the
      // current bounded backend read, then let the cursor paginate the rest.
      if (Date.now() >= deadline) {
        budgetReached = true;
        break;
      }
      if (
        (query.session_ids && !query.session_ids.includes(event.session_id)) ||
        (query.event_types && !query.event_types.includes(event.type))
      ) {
        scanned = sequence;
        continue;
      }
      if (!permissions.has(event.session_id))
        permissions.set(event.session_id, await visible(event.session_id));
      if (!permissions.get(event.session_id)) {
        scanned = sequence;
        continue;
      }
      matches.push(event);
      if (matches.length > limit) break;
      scanned = sequence;
    }
    const hasMore = matches.length > limit || budgetReached;
    const events = matches.slice(0, limit);
    return {
      events: structuredClone(events),
      next_cursor: hasMore
        ? this.cursorFor(scanned)
        : this.cursorFor(snapshot.next - 1),
      has_more: hasMore,
      filter_key: filterKey,
    };
  }

  async wait(cursor: string, milliseconds: number): Promise<void> {
    this.check();
    if (this.cursor !== cursor) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.waiters.add(finish);
    });
  }

  async close(): Promise<void> {
    await this.tail;
    this.closed = true;
    for (const wake of this.waiters) wake();
  }

  private empty(id: string, title: string): ActivitySnapshot {
    return {
      session_id: id,
      session_title: title,
      activity: "idle",
      pending_input: { permissions: 0, questions: 0 },
      messages: [],
    };
  }
  private event(
    snapshot: ActivitySnapshot,
    type: ActivityType,
    state: string,
    source: ActivityEvent["source"],
    message?: SessionStatusResult,
  ): EventInput {
    return {
      session_id: snapshot.session_id,
      session_title: snapshot.session_title.slice(0, 160),
      type,
      state,
      source,
      ...(message?.message_id ? { message_id: message.message_id } : {}),
      assistant_message_ids: message?.assistant_message_ids ?? [],
    };
  }
  private push(draft: Store, value: EventInput): void {
    const sequence = draft.next++;
    const event: ActivityEvent = {
      ...value,
      event_id: `evt_${draft.epoch}_${sequence}`,
      cursor: this.cursorFor(sequence),
      timestamp: new Date().toISOString(),
    };
    draft.events.push(event);
    const attention = initialAttention(event, draft.attentionNext ?? 1);
    if (attention) {
      draft.attentionNext = attention.event_sequence + 1;
      draft.attention![event.event_id] = attention;
    }
    if (draft.events.length > this.maximum)
      draft.events.splice(0, draft.events.length - this.maximum);
  }
  private cursorFor(sequence: number): string {
    return `${this.store.epoch}:${String(sequence).padStart(16, "0")}`;
  }
  private sequence(cursor: string | undefined, store: Store): number {
    const oldest = store.events[0]
      ? Number(store.events[0].cursor.split(":")[1]) - 1
      : store.next - 1;
    if (cursor === undefined) return oldest;
    if (!/^[a-f0-9-]{36}:\d{16}$/u.test(cursor))
      throw new AdapterError("INVALID_ARGUMENT", "Invalid activity cursor.");
    const [epoch, value] = cursor.split(":");
    const sequence = Number(value);
    if (epoch !== store.epoch || sequence < oldest)
      throw new AdapterError(
        "CURSOR_EXPIRED",
        "Activity cursor expired. Read without a cursor to resume from retained events.",
      );
    if (!Number.isSafeInteger(sequence) || sequence >= store.next)
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "Activity cursor is ahead of this journal.",
      );
    return sequence;
  }
  private attentionCursor(sequence: number): string {
    return `${this.store.epoch}:attention:${String(sequence).padStart(16, "0")}`;
  }
  private attentionSequence(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const match = /^([a-f0-9-]{36}):attention:(\d{16})$/u.exec(cursor);
    if (!match || match[1] !== this.store.epoch)
      throw new AdapterError("INVALID_ARGUMENT", "Invalid attention cursor.");
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence) || sequence >= (this.store.attentionNext ?? 1))
      throw new AdapterError("INVALID_ARGUMENT", "Attention cursor is ahead of this journal.");
    const oldest = Math.min(...Object.values(this.store.attention ?? {}).map((entry) => entry.event_sequence));
    if (Number.isFinite(oldest) && sequence < oldest - 1)
      throw new AdapterError("CURSOR_EXPIRED", "Attention cursor predates retained entries; read the current bounded queue and reconcile current state.");
    return sequence;
  }
  private check(): void {
    if (this.failed || this.closed)
      throw new AdapterError(
        "ACTIVITY_UNAVAILABLE",
        "Activity collection is unavailable; inspect the adapter log.",
      );
  }
  private commit(change: (draft: Store) => boolean): Promise<void> {
    const operation = this.tail.then(async () => {
      this.check();
      const draft = structuredClone(this.store);
      if (!change(draft)) return;
      for (const key of Object.keys(draft.observations).slice(0, -500))
        delete draft.observations[key];
      for (const key of Object.keys(draft.watched).slice(0, -500))
        delete draft.watched[key];
      const retainedOverrideRequests = new Set(
        draft.events
          .filter((event) => event.type === "submission.guard_overridden")
          .map((event) => event.request_id)
          .filter((id): id is string => Boolean(id)),
      );
      for (const requestId of Object.keys(draft.guardOverrides ?? {}))
        if (!retainedOverrideRequests.has(requestId))
          delete draft.guardOverrides![requestId];
      for (const [key, resolution] of Object.entries(draft.resolutions ?? {}))
        if (!draft.guardOverrides?.[resolution.superseded_by_request_id])
          delete draft.resolutions![key];
      const retainedAttention = Object.values(draft.attention ?? {}).sort((a, b) => a.event_sequence - b.event_sequence);
      while (retainedAttention.length > this.maximum) {
        const removable = retainedAttention.find((entry) => entry.lifecycle === "discussed" || entry.lifecycle === "superseded");
        if (!removable)
          throw new AdapterError("ACTIVITY_UNAVAILABLE", "Persistent attention reached its bounded retention limit; unresolved entries were preserved.");
        delete draft.attention![removable.event_id];
        retainedAttention.splice(retainedAttention.indexOf(removable), 1);
      }
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(draft) + "\n");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.path);
        this.store = draft;
        for (const wake of this.waiters) wake();
      } catch (error) {
        this.failed = true;
        // Metadata only: a bounded error class for the adapter log, never a
        // path, payload or secret. The latch stays fail-closed — no reset, no
        // retry and no reopen from here; the ACTIVITY_UNAVAILABLE contract is
        // unchanged and keeps pointing at this log line.
        process.stderr.write(`[mcp] activity-commit-failed class=${persistErrorClass(error)}\n`);
        throw new AdapterError(
          "ACTIVITY_UNAVAILABLE",
          "Could not persist activity; the journal was not reset.",
        );
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

function eventName(type: ActivityEvent["type"]): string | undefined {
  switch (type) {
    case "message.completed": return "worker.completed";
    case "message.failed": return "worker.failed";
    case "message.aborted": return "worker.aborted";
    case "session.input_required": return "worker.input_required";
    default: return undefined;
  }
}

function validStore(store: Store, project: string): boolean {
  return store.schema === 1 && store.project === project &&
    /^[a-f0-9-]{36}$/u.test(store.epoch) &&
    Number.isSafeInteger(store.next) && store.next >= 1 &&
    Array.isArray(store.events) && isRecord(store.observations) &&
    isRecord(store.watched) &&
    (store.guardOverrides === undefined || isRecord(store.guardOverrides)) &&
    (store.resolutions === undefined || isRecord(store.resolutions)) &&
    (store.attention === undefined || isRecord(store.attention)) &&
    (store.attentionNext === undefined ||
      (Number.isSafeInteger(store.attentionNext) && store.attentionNext >= 1)) &&
    (store.subscriptions === undefined || isRecord(store.subscriptions)) &&
    validAttentionState(store);
}

function validEvents(store: Store): boolean {
  let previous = 0;
  for (const event of store.events) {
    if (!isRecord(event) || typeof event.cursor !== "string" || typeof event.type !== "string")
      return false;
    const prefix = `${store.epoch}:`;
    const sequenceText = event.cursor.startsWith(prefix)
      ? event.cursor.slice(prefix.length)
      : "";
    const sequence = Number(sequenceText);
    if (!/^[0-9]+$/u.test(sequenceText) || !Number.isSafeInteger(sequence) ||
      sequence <= previous || sequence >= store.next ||
      !ACTIVITY_TYPES.includes(event.type as ActivityType)) return false;
    previous = sequence;
  }
  return true;
}

function validAttentionState(store: Store): boolean {
  for (const [id, value] of Object.entries(store.attention ?? {})) {
    if (!isRecord(value) || value.event_id !== id || !Number.isSafeInteger(value.event_sequence) ||
      (value.event_sequence as number) < 1 || (value.event_sequence as number) >= (store.attentionNext ?? Number.MAX_SAFE_INTEGER) ||
      !ACTIVITY_TYPES.includes(value.event_type as ActivityType) ||
      !["ready", "attention", "action_required"].includes(String(value.classification)) ||
      !["new", "ready", "offered", "discussed", "superseded"].includes(String(value.lifecycle)) ||
      !["pending", "resolved", "unlinked", "ambiguous", "unavailable"].includes(String(value.hierarchy_status)) ||
       typeof value.session_id !== "string" || typeof value.prepared_summary !== "string" ||
       typeof value.next_safe_step !== "string" || !Array.isArray(value.assistant_message_ids) ||
       !isRecord(value.deliveries) || !validAttentionErrorDetails(value)) return false;
    for (const delivery of Object.values(value.deliveries)) {
      if (!isRecord(delivery) || !["pending", "delivered", "failed", "abandoned"].includes(String(delivery.state)) ||
        !Number.isSafeInteger(delivery.attempts) || typeof delivery.updated_at !== "string") return false;
    }
  }
  for (const [id, subscription] of Object.entries(store.subscriptions ?? {})) {
    if (!isRecord(subscription) || subscription.id !== id ||
      !["worker.completed", "worker.failed", "worker.aborted", "worker.input_required"].includes(String(subscription.event_name)) ||
      typeof subscription.callback_url !== "string" || !subscription.callback_url.startsWith("https://") ||
      typeof subscription.secret !== "string" || !subscription.secret.startsWith("whsec_") ||
      typeof subscription.active !== "boolean" || typeof subscription.created_at !== "string" ||
      !(subscription.expires_at === null || typeof subscription.expires_at === "string") ||
      !(subscription.last_cursor === null || typeof subscription.last_cursor === "string") ||
      !isRecord(subscription.arguments)) return false;
  }
  return true;
}

function validAttentionErrorDetails(value: Record<string, unknown>): boolean {
  const details = value.error_details;
  const total = value.error_details_total;
  const truncated = value.error_details_truncated;
  if (details === undefined)
    return total === undefined && truncated === undefined;
  if (!Array.isArray(details) || details.length < 1 || details.length > MAX_CORRELATED_ERROR_DETAILS ||
    !Number.isSafeInteger(total) || (total as number) < 1 || (total as number) < details.length ||
    typeof truncated !== "boolean" || truncated !== ((total as number) > details.length))
    return false;
  return details.every(validCorrelatedAttentionErrorDetail);
}

function validCorrelatedAttentionErrorDetail(detail: unknown): boolean {
  if (!isRecord(detail) || typeof detail.assistant_message_id !== "string" ||
    detail.attribution !== "exact_parent") return false;
  const { assistant_message_id: _assistantMessageId, attribution: _attribution, ...errorDetail } = detail;
  return isSafeAssistantErrorDetail(errorDetail);
}

async function adoptLegacyJournal(target: string, legacyPath: string, project: string): Promise<void> {
  let parent;
  try { parent = await lstat(dirname(legacyPath)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700)
    throw new AdapterError("ACTIVITY_UNAVAILABLE", "Legacy activity directory is unsafe; the journal was not migrated.");
  let source;
  try { source = await open(legacyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let raw: string;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 32 * 1024 * 1024)
      throw new AdapterError("ACTIVITY_UNAVAILABLE", "Legacy activity file is unsafe; the journal was not migrated.");
    raw = await source.readFile("utf8");
  } finally { await source.close(); }
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new AdapterError("ACTIVITY_UNAVAILABLE", "Legacy activity file is invalid; the journal was not migrated.");
  }
  if (!isRecord(value))
    throw new AdapterError("ACTIVITY_UNAVAILABLE", "Legacy activity identity is invalid; the journal was not migrated.");
  const legacy = value as Store;
  if (legacy.observations === undefined) legacy.observations = {};
  if (legacy.watched === undefined) legacy.watched = {};
  if (!validStore(legacy, project) || !validEvents(legacy))
    throw new AdapterError("ACTIVITY_UNAVAILABLE", "Legacy activity file is invalid; the journal was not migrated.");
  const serialized = `${JSON.stringify(legacy)}\n`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    try { await link(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(() => undefined); }
}

function resolutionKey(sessionId: string, messageId: string): string {
  return JSON.stringify([sessionId, messageId]);
}
