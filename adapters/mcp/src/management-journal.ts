import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AdapterError } from "./types.js";
import { READ_RESPONSE_BYTES } from "./content.js";

const TASK_ID_PATTERN = /^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MAX_NOTE_JSON_BYTES = 40 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = MAX_NOTE_JSON_BYTES + 2048;
const MAX_SUFFIX_RECOVERY_BYTES = 1024 * 1024;
const MAX_RECENT_READ_BYTES = 1024 * 1024;
const MAX_HISTORY_ENTRIES = 50;
const MAX_HISTORY_RESULT_BYTES = READ_RESPONSE_BYTES - 16 * 1024;

export type ManagementJournalEntry = {
  sequence: number;
  entry_id: string;
  appended_at: string;
  text: string;
  journal_offset: number;
};

export type ManagementHistoryMode = "recent" | "after" | "after_checkpoint" | "latest_checkpoint";

export type ManagementHistoryOptions = {
  mode: ManagementHistoryMode;
  limit: number;
  cursor?: string;
};

type JournalHeader = {
  type: "header";
  schema: 1;
  project_hash: string;
  task_id: string;
  generation: string;
};

type CheckpointPointer = { sequence: number; offset: number };

type JournalHead = {
  schema: 1;
  project_hash: string;
  task_id: string;
  generation: string;
  committed_bytes: number;
  entry_count: number;
  last_sequence: number;
  last_entry_offset: number | null;
  latest_checkpoint: CheckpointPointer | null;
};

type JournalView = {
  header: JournalHeader;
  header_bytes: number;
  head: JournalHead;
  consistency: "current" | "rebuilt_index" | "recovered_suffix";
};

type Cursor = {
  schema: 1;
  project_hash: string;
  task_id: string;
  generation: string;
  head_bytes: number;
  head_sequence: number;
  captured_last_offset: number | null;
  captured_last_sequence: number;
  next_offset: number;
  next_sequence: number;
  previous_offset: number | null;
  previous_sequence: number;
};

export type ManagementJournalRead = {
  task_id: string;
  state: "absent" | "available";
  consistency: "current" | "rebuilt_index" | "recovered_suffix";
  generation: string | null;
  head_sequence: number;
  head_bytes: number;
  captured_head_sequence: number;
  captured_head_bytes: number;
  entry_count: number;
  mode: ManagementHistoryMode;
  entries: ManagementJournalEntry[];
  latest_checkpoint: Omit<ManagementJournalEntry, "text"> | null;
  has_more: boolean;
  next_cursor?: string;
};

export type ManagementAppendReceipt = {
  entry_id: string;
  sequence: number;
  generation: string;
  head_sequence: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string, code = "TASK_MANAGEMENT_JOURNAL_ERROR"): AdapterError {
  return new AdapterError(code as ConstructorParameters<typeof AdapterError>[0], message);
}

function checkpointText(text: string): boolean {
  return text === "MONITOR-CHECKPOINT v1" || text.startsWith("MONITOR-CHECKPOINT v1\n");
}

function lineBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function decodeJsonLine(bytes: Buffer, offset: number): unknown {
  if (!bytes.length || bytes.at(-1) !== 0x0a || bytes.length > MAX_LINE_BYTES) {
    throw fail("Management journal contains an incomplete or oversized record; history was preserved.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1));
  } catch {
    throw fail(`Management journal record at byte ${offset} is not valid UTF-8; history was preserved.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw fail(`Management journal record at byte ${offset} is invalid JSON; history was preserved.`);
  }
}

function parseHeader(value: unknown, taskId: string, projectHash: string): JournalHeader {
  if (!isRecord(value) || value.type !== "header" || value.schema !== 1 ||
      Object.keys(value).sort().join(",") !== "generation,project_hash,schema,task_id,type" ||
      value.task_id !== taskId || value.project_hash !== projectHash ||
      typeof value.generation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.generation)) {
    throw fail("Management journal identity or schema does not match this project task.");
  }
  return value as JournalHeader;
}

function parseRecord(value: unknown, expectedSequence: number, offset: number): ManagementJournalEntry {
  if (!isRecord(value) || value.type !== "entry" || value.sequence !== expectedSequence ||
      Object.keys(value).sort().join(",") !== "appended_at,entry_id,sequence,text,type" ||
      typeof value.entry_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.entry_id) ||
      typeof value.appended_at !== "string" || !Number.isFinite(Date.parse(value.appended_at)) ||
      typeof value.text !== "string" || !value.text.isWellFormed() || !value.text.trim() || value.text !== value.text.trim() ||
      Buffer.byteLength(JSON.stringify(value.text), "utf8") > MAX_NOTE_JSON_BYTES) {
      throw fail(`Management journal sequence ${expectedSequence} is invalid at byte ${offset}; history was preserved.`);
  }
  return {
    sequence: expectedSequence,
    entry_id: value.entry_id,
    appended_at: value.appended_at,
    text: value.text,
    journal_offset: offset,
  };
}

function makeHead(header: JournalHeader, entries: ManagementJournalEntry[], committedBytes: number): JournalHead {
  const last = entries.at(-1);
  const checkpoint = [...entries].reverse().find((entry) => checkpointText(entry.text));
  return {
    schema: 1,
    project_hash: header.project_hash,
    task_id: header.task_id,
    generation: header.generation,
    committed_bytes: committedBytes,
    entry_count: entries.length,
    last_sequence: last?.sequence ?? 0,
    last_entry_offset: last?.journal_offset ?? null,
    latest_checkpoint: checkpoint ? { sequence: checkpoint.sequence, offset: checkpoint.journal_offset } : null,
  };
}

function validateHead(value: unknown, header: JournalHeader, headerBytes: number, fileBytes: number): JournalHead {
  if (!isRecord(value) || value.schema !== 1 ||
      Object.keys(value).sort().join(",") !== "committed_bytes,entry_count,generation,last_entry_offset,last_sequence,latest_checkpoint,project_hash,schema,task_id" ||
      value.project_hash !== header.project_hash ||
      value.task_id !== header.task_id || value.generation !== header.generation ||
      !Number.isSafeInteger(value.committed_bytes) || (value.committed_bytes as number) < headerBytes ||
      (value.committed_bytes as number) > fileBytes || !Number.isSafeInteger(value.entry_count) ||
      (value.entry_count as number) < 1 || !Number.isSafeInteger(value.last_sequence) ||
      value.last_sequence !== value.entry_count ||
      (value.last_entry_offset !== null && (!Number.isSafeInteger(value.last_entry_offset) ||
        (value.last_entry_offset as number) < headerBytes || (value.last_entry_offset as number) >= (value.committed_bytes as number)))) {
    throw fail("Management journal head is invalid or inconsistent; history was preserved.");
  }
  let latestCheckpoint: CheckpointPointer | null = null;
  if (value.latest_checkpoint !== null) {
    if (!isRecord(value.latest_checkpoint) || Object.keys(value.latest_checkpoint).sort().join(",") !== "offset,sequence" ||
        !Number.isSafeInteger(value.latest_checkpoint.sequence) ||
        (value.latest_checkpoint.sequence as number) < 1 ||
        (value.latest_checkpoint.sequence as number) > (value.last_sequence as number) ||
        !Number.isSafeInteger(value.latest_checkpoint.offset) ||
        (value.latest_checkpoint.offset as number) < headerBytes ||
        (value.latest_checkpoint.offset as number) >= (value.committed_bytes as number)) {
      throw fail("Management journal checkpoint pointer is invalid; history was preserved.");
    }
    latestCheckpoint = { sequence: value.latest_checkpoint.sequence as number, offset: value.latest_checkpoint.offset as number };
  }
  if (value.last_entry_offset === null || (value.committed_bytes as number) === headerBytes) {
    throw fail("Management journal head omits its committed tail; history was preserved.");
  }
  return {
    schema: 1,
    project_hash: header.project_hash,
    task_id: header.task_id,
    generation: header.generation,
    committed_bytes: value.committed_bytes as number,
    entry_count: value.entry_count as number,
    last_sequence: value.last_sequence as number,
    last_entry_offset: value.last_entry_offset as number | null,
    latest_checkpoint: latestCheckpoint,
  };
}

export class TaskManagementJournal {
  constructor(private readonly metadataFile: string, private readonly projectHash: string) {}

  async append(taskId: string, rawText: string): Promise<ManagementAppendReceipt> {
    this.validateTaskId(taskId);
    if (typeof rawText !== "string" || !rawText.isWellFormed() || !rawText.trim()) throw new AdapterError("INVALID_ARGUMENT", "A nonempty, well-formed Unicode management note is required.");
    const text = rawText.trim();
    if (Buffer.byteLength(JSON.stringify(text), "utf8") > MAX_NOTE_JSON_BYTES) {
      throw new AdapterError("TASK_MANAGEMENT_JOURNAL_LIMIT", `A management note's serialized text must fit within ${MAX_NOTE_JSON_BYTES} bytes.`);
    }
    const paths = await this.paths(taskId, true);
    if (!paths) throw fail("Management journal directory could not be created.");
    const view = await this.loadView(taskId, paths);
    const entryId = randomUUID();
    const appendedAt = new Date().toISOString();
    const generation = view?.header.generation ?? randomUUID();
    const sequence = (view?.head.last_sequence ?? 0) + 1;
    const header = view?.header ?? { type: "header" as const, schema: 1 as const, project_hash: this.projectHash, task_id: taskId, generation };
    const headerLine = view ? undefined : lineBytes(header);
    const entry = { type: "entry" as const, sequence, entry_id: entryId, appended_at: appendedAt, text };
    const entryLine = lineBytes(entry);
    const previousHead = view?.head ?? makeHead(header, [], headerLine!.length);
    const entryOffset = previousHead.committed_bytes;
    const entryParsed: ManagementJournalEntry = { sequence, entry_id: entryId, appended_at: appendedAt, text, journal_offset: entryOffset };
    const checkpoint = checkpointText(text) ? { sequence, offset: entryOffset } : previousHead.latest_checkpoint;
    const nextHead: JournalHead = {
      ...previousHead,
      committed_bytes: previousHead.committed_bytes + entryLine.length,
      entry_count: previousHead.entry_count + 1,
      last_sequence: sequence,
      last_entry_offset: entryOffset,
      latest_checkpoint: checkpoint,
    };
    if (nextHead.committed_bytes > MAX_JOURNAL_BYTES) {
      throw new AdapterError("TASK_MANAGEMENT_JOURNAL_LIMIT", "The per-task management journal reached its bounded storage limit; existing history was preserved.");
    }

    if (!view) {
      await this.createInitialJournal(paths, headerLine!, entryLine);
    } else {
      if (view.consistency !== "current") await this.writeHead(paths, view.head);
      await this.appendLine(paths, entryLine, previousHead.committed_bytes, nextHead.committed_bytes);
    }
    try {
      await this.writeHead(paths, nextHead);
    } catch {
      throw fail("The journal entry may have been appended, but its index update was not confirmed. Read management history before any retry.", "TASK_MANAGEMENT_JOURNAL_UNCERTAIN");
    }
    return { entry_id: entryParsed.entry_id, sequence, generation, head_sequence: sequence };
  }

  async read(taskId: string, options: ManagementHistoryOptions): Promise<ManagementJournalRead> {
    this.validateTaskId(taskId);
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_HISTORY_ENTRIES) {
      throw new AdapterError("INVALID_ARGUMENT", `History limit must be between 1 and ${MAX_HISTORY_ENTRIES}.`);
    }
    const paths = await this.paths(taskId, false);
    if (!paths) return this.absent(taskId, options.mode);
    const journalExists = await this.exists(paths.journalPath);
    const headExists = await this.exists(paths.headPath);
    if (!journalExists && !headExists) return this.absent(taskId, options.mode);
    if (!journalExists && headExists) throw fail("Management journal index exists without its canonical history file.");

    const file = await this.openRegular(paths.journalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = await file.stat();
      if (initial.size > MAX_JOURNAL_BYTES) throw new AdapterError("TASK_MANAGEMENT_JOURNAL_LIMIT", "Management journal exceeds its bounded storage limit; history was preserved.");
      const view = await this.loadViewFromOpen(taskId, paths, file, initial.size, headExists);
      const checkpoint = await this.readCheckpoint(file, view);
      let entries: ManagementJournalEntry[] = [];
      let hasMore = false;
      let nextCursor: string | undefined;
      let capturedHeadSequence = view.head.last_sequence;
      let capturedHeadBytes = view.head.committed_bytes;
      if (options.mode === "latest_checkpoint") {
        entries = checkpoint ? [checkpoint] : [];
      } else if (options.mode === "recent") {
        const result = await this.readRecent(file, view, options.limit);
        entries = result.entries;
        hasMore = result.hasMore;
      } else {
        const result = await this.readAfter(file, view, taskId, options.cursor, options.limit, options.mode);
        entries = result.entries;
        hasMore = result.hasMore;
        nextCursor = result.nextCursor;
        capturedHeadSequence = result.capturedHeadSequence;
        capturedHeadBytes = result.capturedHeadBytes;
      }
      const result: ManagementJournalRead = {
        task_id: taskId,
        state: "available",
        consistency: view.consistency,
        generation: view.header.generation,
        head_sequence: view.head.last_sequence,
        head_bytes: view.head.committed_bytes,
        captured_head_sequence: capturedHeadSequence,
        captured_head_bytes: capturedHeadBytes,
        entry_count: view.head.entry_count,
        mode: options.mode,
        entries,
        latest_checkpoint: checkpoint ? {
          sequence: checkpoint.sequence,
          entry_id: checkpoint.entry_id,
          appended_at: checkpoint.appended_at,
          journal_offset: checkpoint.journal_offset,
        } : null,
        has_more: hasMore,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      };
      while (result.entries.length && Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_HISTORY_RESULT_BYTES) {
        if (options.mode === "recent") result.entries.shift();
        else result.entries.pop();
        result.has_more = true;
        if ((options.mode === "after" || options.mode === "after_checkpoint") && result.entries.length) {
          result.next_cursor = this.encodeCursor(this.cursorAfter(this.decodeCursor(nextCursor ?? options.cursor ?? ""), result.entries.at(-1)!));
        } else if (options.mode === "after" || options.mode === "after_checkpoint") {
          result.next_cursor = options.cursor;
        }
      }
      if ((options.mode === "after" || options.mode === "after_checkpoint") && !result.has_more) delete result.next_cursor;
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_HISTORY_RESULT_BYTES) {
        throw new AdapterError("RESPONSE_BUDGET_EXCEEDED", "Management history metadata exceeds the response budget.");
      }
      const final = await file.stat();
      if (final.size !== initial.size || final.ino !== initial.ino || final.mtimeMs !== initial.mtimeMs) {
        throw fail("Management journal changed during the read; restart from the beginning.", "TASK_MANAGEMENT_JOURNAL_CHANGED");
      }
      return result;
    } finally {
      await file.close();
    }
  }

  private absent(taskId: string, mode: ManagementHistoryMode): ManagementJournalRead {
    return { task_id: taskId, state: "absent", consistency: "current", generation: null, head_sequence: 0, head_bytes: 0,
      captured_head_sequence: 0, captured_head_bytes: 0, entry_count: 0, mode, entries: [], latest_checkpoint: null, has_more: false };
  }

  private validateTaskId(taskId: string): void {
    if (!TASK_ID_PATTERN.test(taskId)) throw new AdapterError("INVALID_ARGUMENT", "A stable public task ID is required.");
  }

  private async paths(taskId: string, create: boolean): Promise<{ directory: string; journalPath: string; headPath: string } | undefined> {
    let parent: string;
    try { parent = await realpath(dirname(this.metadataFile)); }
    catch { throw fail("Taskboard journal directory is unavailable."); }
    const directory = join(parent, "management-journal");
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => { throw fail("Management journal directory could not be created."); });
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return undefined;
      throw fail("Management journal directory is unavailable or unsafe.");
    });
    if (!info) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== (process.getuid?.() ?? info.uid)) {
      throw fail("Management journal directory is not a private directory owned by this runtime.");
    }
    if (await realpath(directory).catch(() => "") !== directory) throw fail("Management journal directory resolves outside its configured path.");
    return { directory, journalPath: join(directory, `${taskId}.jsonl`), headPath: join(directory, `${taskId}.head.json`) };
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw fail("Management journal path is not a regular file.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async openRegular(path: string, flags: number) {
    let file;
    try { file = await open(path, flags); }
    catch { throw fail("Management journal file could not be opened safely."); }
    const info = await file.stat().catch(async () => { await file.close(); throw fail("Management journal file could not be inspected."); });
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== (process.getuid?.() ?? info.uid) ||
        await realpath(`/proc/self/fd/${file.fd}`).catch(() => "") !== path) {
      await file.close();
      throw fail("Management journal file is not a private regular file at its deterministic path.");
    }
    return file;
  }

  private async readRange(file: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const { bytesRead } = await file.read(buffer, received, length - received, position + received);
      if (!bytesRead) break;
      received += bytesRead;
    }
    if (received !== length) throw fail("Management journal changed or ended during a bounded read.", "TASK_MANAGEMENT_JOURNAL_CHANGED");
    return buffer;
  }

  private async readLine(file: Awaited<ReturnType<typeof open>>, offset: number, end: number): Promise<{ raw: Buffer; value: unknown; next: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= end) throw fail("Management journal record offset is invalid.");
    const chunks: Buffer[] = [];
    let position = offset;
    let length = 0;
    let raw: Buffer | undefined;
    while (position < end && length <= MAX_LINE_BYTES) {
      const chunk = await this.readRange(file, position, Math.min(4096, MAX_LINE_BYTES + 1 - length, end - position));
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline + 1));
        length += newline + 1;
        raw = Buffer.concat(chunks, length);
        break;
      }
      chunks.push(chunk);
      length += chunk.length;
      position += chunk.length;
    }
    if (!raw) throw fail(`Management journal has an incomplete or oversized record at byte ${offset}; history was preserved.`);
    return { raw, value: decodeJsonLine(raw, offset), next: offset + raw.length };
  }

  private async readHeader(file: Awaited<ReturnType<typeof open>>, fileBytes: number, taskId: string): Promise<{ header: JournalHeader; headerBytes: number }> {
    const line = await this.readLine(file, 0, fileBytes);
    return { header: parseHeader(line.value, taskId, this.projectHash), headerBytes: line.next };
  }

  private async loadView(taskId: string, paths: { directory: string; journalPath: string; headPath: string }): Promise<JournalView | undefined> {
    const journalExists = await this.exists(paths.journalPath);
    const headExists = await this.exists(paths.headPath);
    if (!journalExists && !headExists) return undefined;
    if (!journalExists) throw fail("Management journal index exists without its canonical history file.");
    const file = await this.openRegular(paths.journalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const size = (await file.stat()).size;
      if (size > MAX_JOURNAL_BYTES) throw new AdapterError("TASK_MANAGEMENT_JOURNAL_LIMIT", "Management journal exceeds its bounded storage limit; history was preserved.");
      return await this.loadViewFromOpen(taskId, paths, file, size, headExists);
    } finally { await file.close(); }
  }

  private async loadViewFromOpen(taskId: string, paths: { directory: string; journalPath: string; headPath: string },
    file: Awaited<ReturnType<typeof open>>, fileBytes: number, headExists: boolean): Promise<JournalView> {
    const { header, headerBytes } = await this.readHeader(file, fileBytes, taskId);
    if (!headExists) {
      const entries = await this.scanAll(file, headerBytes, fileBytes);
      if (!entries.length) throw fail("Management journal has no committed entry; an interrupted initial append must be reconciled.");
      return { header, header_bytes: headerBytes, head: makeHead(header, entries, fileBytes), consistency: "rebuilt_index" };
    }
    const headBytes = await this.readSmallFile(paths.headPath, 64 * 1024);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headBytes)); }
    catch { throw fail("Management journal index is invalid; history was preserved."); }
    const head = validateHead(parsed, header, headerBytes, fileBytes);
    if (head.committed_bytes > headerBytes) {
      const lastLine = await this.readLine(file, head.last_entry_offset!, head.committed_bytes);
      if (lastLine.next !== head.committed_bytes) throw fail("Management journal committed boundary is inconsistent.");
      parseRecord(lastLine.value, head.last_sequence, head.last_entry_offset!);
    } else if (head.committed_bytes !== headerBytes) throw fail("Management journal header boundary is inconsistent.");
    if (head.latest_checkpoint) {
      const checkpoint = await this.readLine(file, head.latest_checkpoint.offset, head.committed_bytes);
      const entry = parseRecord(checkpoint.value, head.latest_checkpoint.sequence, head.latest_checkpoint.offset);
      if (!checkpointText(entry.text)) throw fail("Management journal checkpoint pointer does not reference a checkpoint.");
    }
    if (fileBytes === head.committed_bytes) return { header, header_bytes: headerBytes, head, consistency: "current" };
    const suffixBytes = fileBytes - head.committed_bytes;
    if (suffixBytes > MAX_SUFFIX_RECOVERY_BYTES) throw fail("Management journal has an unindexed suffix beyond the bounded reconciliation budget.");
    const suffix = await this.scanRange(file, head.committed_bytes, fileBytes, head.last_sequence + 1);
    const recovered = makeHead(header, suffix.entries, fileBytes);
    // scanRange receives only suffix records; combine the prior head without reading the full prefix.
    recovered.entry_count = head.entry_count + suffix.entries.length;
    recovered.last_sequence = recovered.entry_count;
    recovered.last_entry_offset = suffix.entries.at(-1)?.journal_offset ?? head.last_entry_offset;
    if (!suffix.entries.length) throw fail("Management journal size differs from its committed head without a complete appended record.");
    if (!recovered.latest_checkpoint && head.latest_checkpoint) recovered.latest_checkpoint = head.latest_checkpoint;
    return { header, header_bytes: headerBytes, head: recovered, consistency: "recovered_suffix" };
  }

  private async scanRange(file: Awaited<ReturnType<typeof open>>, start: number, end: number,
    expectedSequence: number): Promise<{ entries: ManagementJournalEntry[] }> {
    const entries: ManagementJournalEntry[] = [];
    let offset = start;
    let sequence = expectedSequence;
    while (offset < end) {
      const line = await this.readLine(file, offset, end);
      const entry = parseRecord(line.value, sequence, offset);
      entries.push(entry);
      offset = line.next;
      sequence++;
    }
    if (offset !== end || entries.length !== (sequence - expectedSequence)) throw fail("Management journal suffix is not a complete sequence.");
    return { entries };
  }

  private async scanAll(file: Awaited<ReturnType<typeof open>>, headerBytes: number, fileBytes: number): Promise<ManagementJournalEntry[]> {
    let offset = headerBytes;
    let sequence = 1;
    const entries: ManagementJournalEntry[] = [];
    while (offset < fileBytes) {
      const line = await this.readLine(file, offset, fileBytes);
      entries.push(parseRecord(line.value, sequence, offset));
      offset = line.next;
      sequence++;
    }
    if (offset !== fileBytes) throw fail("Management journal does not end on a complete record boundary.");
    return entries;
  }

  private async readSmallFile(path: string, maxBytes: number): Promise<Buffer> {
    const file = await this.openRegular(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (info.size > maxBytes) throw fail("Management journal index exceeds its size limit.");
      return await this.readRange(file, 0, info.size);
    } finally { await file.close(); }
  }

  private async readCheckpoint(file: Awaited<ReturnType<typeof open>>, view: JournalView): Promise<ManagementJournalEntry | null> {
    const pointer = view.head.latest_checkpoint;
    if (!pointer) return null;
    const line = await this.readLine(file, pointer.offset, view.head.committed_bytes);
    return parseRecord(line.value, pointer.sequence, pointer.offset);
  }

  private async readRecent(file: Awaited<ReturnType<typeof open>>, view: JournalView, limit: number): Promise<{ entries: ManagementJournalEntry[]; hasMore: boolean }> {
    if (!view.head.last_sequence) return { entries: [], hasMore: false };
    const end = view.head.committed_bytes;
    const start = Math.max(view.header_bytes, end - MAX_RECENT_READ_BYTES);
    let offset = start;
    if (start > view.header_bytes) {
      const prior = await this.readRange(file, start - 1, 1);
      if (prior[0] !== 0x0a) {
        const chunk = await this.readRange(file, start, end - start);
        const newline = chunk.indexOf(0x0a);
        if (newline < 0) throw fail("Recent history page could not align to a record boundary.");
        offset = start + newline + 1;
      }
    }
    const found: ManagementJournalEntry[] = [];
    let sequence: number | undefined;
    while (offset < end) {
      const line = await this.readLine(file, offset, end);
      const value = isRecord(line.value) ? line.value.sequence : undefined;
      if (!Number.isSafeInteger(value)) throw fail(`Management journal tail is invalid at byte ${offset}.`);
      if (sequence === undefined) sequence = value as number;
      const entry = parseRecord(line.value, sequence, offset);
      found.push(entry);
      offset = line.next;
      sequence++;
    }
    if (found.at(-1)?.sequence !== view.head.last_sequence) throw fail("Recent history page does not reach the indexed journal head.");
    const entries = found.slice(-limit);
    return { entries, hasMore: (found[0]?.sequence ?? 1) > 1 || found.length > entries.length };
  }

  private async readAfter(file: Awaited<ReturnType<typeof open>>, view: JournalView, taskId: string,
    opaqueCursor: string | undefined, limit: number, mode: ManagementHistoryMode): Promise<{ entries: ManagementJournalEntry[]; hasMore: boolean;
      nextCursor?: string; capturedHeadSequence: number; capturedHeadBytes: number }> {
    let cursor: Cursor;
    if (opaqueCursor) cursor = this.decodeCursor(opaqueCursor);
    else {
      let nextOffset = view.header_bytes;
      let nextSequence = 1;
      let previousOffset: number | null = null;
      let previousSequence = 0;
      if (mode === "after_checkpoint" && view.head.latest_checkpoint) {
        const checkpoint = view.head.latest_checkpoint;
        const line = await this.readLine(file, checkpoint.offset, view.head.committed_bytes);
        parseRecord(line.value, checkpoint.sequence, checkpoint.offset);
        nextOffset = line.next;
        nextSequence = checkpoint.sequence + 1;
        previousOffset = checkpoint.offset;
        previousSequence = checkpoint.sequence;
      }
      cursor = { schema: 1, project_hash: this.projectHash, task_id: taskId, generation: view.header.generation,
        head_bytes: view.head.committed_bytes, head_sequence: view.head.last_sequence,
        captured_last_offset: view.head.last_entry_offset, captured_last_sequence: view.head.last_sequence,
        next_offset: nextOffset, next_sequence: nextSequence, previous_offset: previousOffset, previous_sequence: previousSequence };
    }
    this.validateCursor(cursor, taskId, view);
    if (cursor.previous_offset !== null) {
      const previous = await this.readLine(file, cursor.previous_offset, cursor.next_offset);
      if (previous.next !== cursor.next_offset) throw new AdapterError("INVALID_ARGUMENT", "Management history cursor is not on a record boundary.");
      parseRecord(previous.value, cursor.previous_sequence, cursor.previous_offset);
    }
    if (cursor.captured_last_sequence === 0) {
      if (cursor.head_bytes !== view.header_bytes || cursor.captured_last_offset !== null) {
        throw new AdapterError("TASK_MANAGEMENT_JOURNAL_CHANGED", "Captured management history head is inconsistent.");
      }
    } else {
      if (cursor.captured_last_offset === null) throw new AdapterError("INVALID_ARGUMENT", "Management history cursor omits its captured tail.");
      const capturedLast = await this.readLine(file, cursor.captured_last_offset, cursor.head_bytes);
      if (capturedLast.next !== cursor.head_bytes) throw new AdapterError("TASK_MANAGEMENT_JOURNAL_CHANGED", "Captured management history boundary changed.");
      parseRecord(capturedLast.value, cursor.captured_last_sequence, cursor.captured_last_offset);
    }
    let offset = cursor.next_offset;
    let sequence = cursor.next_sequence;
    const entries: ManagementJournalEntry[] = [];
    while (offset < cursor.head_bytes && entries.length < limit + 1) {
      const line = await this.readLine(file, offset, cursor.head_bytes);
      entries.push(parseRecord(line.value, sequence, offset));
      offset = line.next;
      sequence++;
    }
    const hasMore = entries.length > limit || offset < cursor.head_bytes;
    entries.length = Math.min(entries.length, limit);
    const returned = entries;
    const nextCursor = returned.length
      ? this.encodeCursor(this.cursorAfter(cursor, returned.at(-1)!))
      : undefined;
    return { entries: returned, hasMore, capturedHeadSequence: cursor.head_sequence, capturedHeadBytes: cursor.head_bytes,
      ...(nextCursor ? { nextCursor } : {}) };
  }

  private cursorAfter(cursor: Cursor, entry: ManagementJournalEntry): Cursor {
    const entryLength = lineBytes({ type: "entry", sequence: entry.sequence, entry_id: entry.entry_id,
      appended_at: entry.appended_at, text: entry.text }).length;
    return { ...cursor, next_offset: entry.journal_offset + entryLength,
      next_sequence: entry.sequence + 1, previous_offset: entry.journal_offset, previous_sequence: entry.sequence };
  }

  private encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  private decodeCursor(value: string): Cursor {
    try {
      if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
      if (!isRecord(decoded) || Object.keys(decoded).sort().join(",") !==
          "captured_last_offset,captured_last_sequence,generation,head_bytes,head_sequence,next_offset,next_sequence,previous_offset,previous_sequence,project_hash,schema,task_id" ||
          Buffer.from(value, "base64url").toString("base64url") !== value) throw new Error();
      return decoded as unknown as Cursor;
    } catch {
      throw new AdapterError("INVALID_ARGUMENT", "Management history cursor is invalid.");
    }
  }

  private validateCursor(cursor: Cursor, taskId: string, view: JournalView): void {
    if (cursor.schema !== 1 || cursor.project_hash !== this.projectHash || cursor.task_id !== taskId ||
        cursor.generation !== view.header.generation || !Number.isSafeInteger(cursor.head_bytes) ||
        !Number.isSafeInteger(cursor.head_sequence) || !Number.isSafeInteger(cursor.next_offset) ||
        !Number.isSafeInteger(cursor.captured_last_sequence) || !Number.isSafeInteger(cursor.next_sequence) ||
        !Number.isSafeInteger(cursor.previous_sequence) ||
        cursor.head_bytes > view.head.committed_bytes || cursor.head_bytes < view.header_bytes ||
        cursor.head_sequence > view.head.last_sequence || cursor.next_offset < view.header_bytes ||
        cursor.next_offset > cursor.head_bytes || cursor.next_sequence < 1 ||
        cursor.next_sequence > cursor.head_sequence + 1 || cursor.captured_last_sequence !== cursor.head_sequence ||
        (cursor.captured_last_offset !== null && (!Number.isSafeInteger(cursor.captured_last_offset) ||
          cursor.captured_last_offset < view.header_bytes || cursor.captured_last_offset >= cursor.head_bytes))) {
      throw new AdapterError("TASK_MANAGEMENT_JOURNAL_CHANGED", "Management history cursor belongs to another journal revision; restart the read.");
    }
    if (cursor.previous_offset === null) {
      if (cursor.next_offset !== view.header_bytes || cursor.next_sequence !== 1 || cursor.previous_sequence !== 0) {
        throw new AdapterError("INVALID_ARGUMENT", "Management history cursor is not at a valid record boundary.");
      }
    } else if (!Number.isSafeInteger(cursor.previous_offset) || cursor.previous_offset < view.header_bytes ||
        cursor.previous_offset >= cursor.next_offset || cursor.next_sequence !== cursor.previous_sequence + 1) {
      throw new AdapterError("INVALID_ARGUMENT", "Management history cursor is not at a valid record boundary.");
    }
  }

  private async createInitialJournal(paths: { directory: string; journalPath: string; headPath: string }, header: Buffer, entry: Buffer): Promise<void> {
    let file;
    try { file = await open(paths.journalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { throw fail("Management journal creation failed; no Description fallback was attempted."); }
    try {
      await file.writeFile(Buffer.concat([header, entry]));
      await file.sync();
    } catch {
      throw fail("Initial management journal write may be partial; preserve it and reconcile before retrying.", "TASK_MANAGEMENT_JOURNAL_UNCERTAIN");
    } finally { await file.close(); }
    await this.syncDirectory(paths.directory).catch(() => {
      throw fail("Initial management journal is present but its directory publication is uncertain.", "TASK_MANAGEMENT_JOURNAL_UNCERTAIN");
    });
  }

  private async appendLine(paths: { directory: string; journalPath: string; headPath: string }, line: Buffer,
    expectedBytes: number, nextBytes: number): Promise<void> {
    const file = await this.openRegular(paths.journalPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (before.size !== expectedBytes) throw fail("Management journal changed before append; no entry was written.", "TASK_MANAGEMENT_JOURNAL_CHANGED");
      let written = 0;
      while (written < line.length) {
        const result = await file.write(line, written, line.length - written, null);
        if (!result.bytesWritten) throw new Error("short journal write");
        written += result.bytesWritten;
      }
      await file.sync();
      if ((await file.stat()).size !== nextBytes) throw new Error("journal size mismatch after append");
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw fail("Management journal append may have committed; read history before retrying.", "TASK_MANAGEMENT_JOURNAL_UNCERTAIN");
    } finally { await file.close(); }
  }

  private async writeHead(paths: { directory: string; journalPath: string; headPath: string }, head: JournalHead): Promise<void> {
    const exists = await this.exists(paths.headPath);
    if (exists) {
      // Validate that a deterministic head target is a private regular file before atomic replacement.
      const current = await this.openRegular(paths.headPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      await current.close();
    }
    const temporary = `${paths.headPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(`${JSON.stringify(head)}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, paths.headPath);
      await this.syncDirectory(paths.directory);
    } catch {
      await unlink(temporary).catch(() => {});
      throw fail("Management journal index publication failed; canonical history was preserved.");
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const file = await open(directory, constants.O_RDONLY);
    try { await file.sync(); }
    finally { await file.close(); }
  }
}
