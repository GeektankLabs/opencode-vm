import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AdapterError, ACTIVITY_TYPES, isRecord } from "./types.js";
import type {
  ActivityEvent,
  ActivityQuery,
  ActivitySnapshot,
  ActivityType,
  SessionStatusResult,
} from "./types.js";

type Store = {
  schema: 1;
  project: string;
  epoch: string;
  next: number;
  events: ActivityEvent[];
  observations: Record<string, ActivitySnapshot>;
  watched: Record<string, string[]>;
};
type EventInput = Omit<ActivityEvent, "event_id" | "cursor" | "timestamp">;
const terminal = new Set(["completed", "failed", "aborted"]);

/** One owned adapter is the writer. Commits serialize observation + event state
 * in one atomic file; reads never perform backend polling or copy history. */
export class ActivityJournal {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;
  private readonly waiters = new Set<() => void>();

  private constructor(
    private readonly path: string,
    private store: Store,
    private readonly maximum: number,
  ) {}

  static async open(
    path: string,
    project: string,
    maximum = 5000,
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
        if (
          store.schema !== 1 ||
          store.project !== project ||
          !/^[a-f0-9-]{36}$/u.test(store.epoch) ||
          !Number.isSafeInteger(store.next) ||
          store.next < 1 ||
          !Array.isArray(store.events) ||
          !isRecord(store.observations) ||
          !isRecord(store.watched)
        )
          throw new Error();
        let previous = 0;
        for (const event of store.events) {
          const sequence = Number(event.cursor.split(":")[1]);
          if (
            !event.cursor.startsWith(`${store.epoch}:`) ||
            !Number.isSafeInteger(sequence) ||
            sequence <= previous ||
            sequence >= store.next ||
            !ACTIVITY_TYPES.includes(event.type)
          )
            throw new Error();
          previous = sequence;
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new AdapterError(
          "ACTIVITY_UNAVAILABLE",
          "Activity journal is invalid or unsafe; it was not reset.",
        );
      store = {
        schema: 1,
        project,
        epoch: randomUUID(),
        next: 1,
        events: [],
        observations: {},
        watched: {},
      };
    }
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
  ): Promise<void> {
    await this.commit((draft) =>
      this.applyObservation(draft, snapshot, source),
    );
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
        return old && terminal.has(old.state) ? old : message;
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
  }> {
    await this.tail;
    this.check();
    const snapshot = this.store;
    const after = this.sequence(query.after_cursor, snapshot);
    const limit = query.limit ?? 50;
    const matches: ActivityEvent[] = [];
    const permissions = new Map<string, boolean>();
    const deadline = Date.now() + 1000;
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
    draft.events.push({
      ...value,
      event_id: `evt_${draft.epoch}_${sequence}`,
      cursor: this.cursorFor(sequence),
      timestamp: new Date().toISOString(),
    });
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
      } catch {
        this.failed = true;
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
