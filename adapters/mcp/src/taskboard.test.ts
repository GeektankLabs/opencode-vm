import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ProjectBoardService, TASK_RESULT_LIMIT, TASK_SCAN_LIMIT } from "./taskboard.js";
import type { RuntimeDescriptor } from "./types.js";

function runtime(directory: string, url = "http://127.0.0.1:4101") {
  return {
    schema: 1, project: directory, projectHash: "abcdef123456", projectName: "Test",
    backendUrl: "http://127.0.0.1:4095", generation: "generation", opencodeVersion: "test",
    listenHost: "127.0.0.1", listenPort: 40960, credentialFile: join(directory, "credential"),
    taskboardUrl: url, taskboardMetadataFile: join(directory, "taskboard.metadata.json"),
  } as RuntimeDescriptor & { taskboardUrl: string; taskboardMetadataFile: string };
}

function fakeBoard(rows: Array<{ id: string; projectId: string; title: string; description?: string; status: string; priority: string }>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let failNextMove = false;
  let failNextPut = false;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    let value: unknown = [];
    let status = 200;
    if (url.pathname === "/api/projects") {
      if (method === "POST") { value = { id: "backend-project" }; status = 201; }
       else value = [{ id: "backend-project", prefix: "OCABCDEF", name: "Test", status: "active" }];
    } else if (url.pathname === "/api/tickets" && method === "POST") {
      const input = JSON.parse(String(init?.body)) as { title: string; description?: string; status?: string; priority?: string };
      const row = { id: `backend-${rows.length}`, projectId: "backend-project", title: input.title,
        description: input.description ?? "", status: input.status ?? "todo", priority: input.priority ?? "medium" };
      rows.push(row);
      value = row;
      status = 201;
    } else if (url.pathname === "/api/tickets") {
      value = rows.filter((row) => !url.searchParams.get("status") || row.status === url.searchParams.get("status"));
    } else if (url.pathname.endsWith("/move") && method === "POST") {
      if (failNextMove) { status = 503; failNextMove = false; }
      else {
        const id = url.pathname.split("/")[3];
        const row = rows.find((item) => item.id === id);
        if (!row) status = 404;
        else { row.status = (JSON.parse(String(init?.body)) as { status: string }).status; value = row; }
      }
    } else if (url.pathname.startsWith("/api/tickets/") && method === "PUT") {
      const row = rows.find((item) => item.id === url.pathname.slice("/api/tickets/".length));
      if (!row) status = 404;
      else { Object.assign(row, JSON.parse(String(init?.body))); value = row; }
      if (failNextPut) { failNextPut = false; throw new Error("Response lost after commit"); }
    } else if (url.pathname.startsWith("/api/tickets/") && method === "GET") {
      value = rows.find((row) => row.id === url.pathname.slice("/api/tickets/".length));
      if (!value) status = 404;
    } else throw new Error(`Unexpected ${method} ${url.pathname}`);
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, failPutOnce: () => { failNextPut = true; }, failMoveOnce: () => { failNextMove = true; }, restore: () => { globalThis.fetch = originalFetch; } };
}

test("management journal appends compatibly without growing Description and preserves legacy notes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-note-"));
  const rows = [{ id: "backend-1", projectId: "backend-project", title: "Unchanged", description: "Original\n\n",
    status: "todo", priority: "high" }];
  const board = fakeBoard(rows);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    assert.equal((await service.getManagementHistory(id, { mode: "recent", limit: 20 })).state, "absent");
    await assert.rejects(stat(join(directory, "management-journal")), { code: "ENOENT" });
    const first = await service.addManagementNote(id, "  Follow up  ");
    assert.equal(first.description, "Original\n\n");
    assert.equal(first.management_note.sequence, 1);
    await Promise.all([service.addManagementNote(id, "Same"), new ProjectBoardService(state).addManagementNote(id, "Same")]);
    assert.equal(rows[0]!.description, "Original\n\n");
    const readback = await service.getManagementHistory(id, { mode: "recent", limit: 20 });
    assert.deepEqual(readback.entries.map((entry) => entry.text), ["Follow up", "Same", "Same"]);
    assert.deepEqual(readback.entries.map((entry) => entry.sequence), [1, 2, 3]);
    assert.equal(board.calls.some((call) => call.method === "PUT"), false);
    assert.deepEqual([rows[0]!.title, rows[0]!.status, rows[0]!.priority], ["Unchanged", "todo", "high"]);
    await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
    rows[0]!.description = "";
    assert.equal((await service.addManagementNote(id, "Empty prefix")).description, "");
    assert.deepEqual((await service.getManagementHistory(id, { mode: "recent", limit: 20 })).entries.map((entry) => entry.text),
      ["Follow up", "Same", "Same", "Empty prefix"]);
    await assert.rejects(service.addManagementNote(id, "  "), { code: "INVALID_ARGUMENT" });
    await assert.rejects(service.addManagementNote("task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Unknown"), { code: "TASK_NOT_FOUND" });
    rows[0]!.description = "x".repeat(31_990);
    assert.equal((await service.addManagementNote(id, "No description growth")).description.length, 31_990);
    rows[0]!.description = "界".repeat(14_000);
    await assert.rejects(service.addManagementNote(id, "Byte overflow"), { code: "TASK_SEARCH_INCOMPLETE" });
    assert.equal(board.calls.some((call) => call.method === "PUT"), false);
    rows[0]!.description = "Original\n\nManagement Note:\nlegacy checkpoint\n";
    const legacy = await service.getManagementHistory(id, { mode: "recent", limit: 20 }, 0, undefined, 10);
    assert.equal(legacy.legacy_description.text, "Original\n\n");
    const legacyNext = await service.getManagementHistory(id, { mode: "recent", limit: 20 },
      legacy.legacy_description.range.end, legacy.legacy_description.revision, 8192);
    assert.equal(legacyNext.legacy_description.revision, legacy.legacy_description.revision);
    assert.match(legacyNext.legacy_description.text, /Management Note:\nlegacy checkpoint/u);
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("management journal keeps 64 cycles bounded, pages a captured head, and seeks the latest checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-journal-long-"));
  const rows = [{ id: "backend-1", projectId: "backend-project", title: "Long run",
    description: "Canonical task\n\nManagement Note:\nlegacy checkpoint", status: "in_progress", priority: "high" }];
  const board = fakeBoard(rows);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    const before = JSON.stringify(await service.getTask(id));
    const unavailable = await service.getManagementHistory(id, { mode: "latest_checkpoint", limit: 20 });
    assert.equal(unavailable.state, "absent");
    await assert.rejects(stat(join(directory, "management-journal")), { code: "ENOENT" });

    for (let cycle = 1; cycle <= 64; cycle++) {
      const note = `MONITOR-CHECKPOINT v1\nrun=${cycle}\nlifecycle=ACTIVE\ncycles=${cycle}\npadding=${"x".repeat(16_000)}`;
      const appended = await service.addManagementNote(id, note);
      assert.equal(appended.management_note.sequence, cycle);
    }
    assert.equal(JSON.stringify(await service.getTask(id)), before, "ordinary task reads must not grow with journal history");

    const instrumented = service as unknown as { managementJournal: {
      readRange: (file: unknown, position: number, length: number) => Promise<Buffer>;
    } };
    const originalReadRange = instrumented.managementJournal.readRange.bind(instrumented.managementJournal);
    let bytesRead = 0;
    instrumented.managementJournal.readRange = async (file, position, length) => {
      bytesRead += length;
      return originalReadRange(file, position, length);
    };
    const latest = await service.getManagementHistory(id, { mode: "latest_checkpoint", limit: 20 });
    assert.ok(bytesRead < 64 * 1024, `latest checkpoint read ${bytesRead} bytes from a >1 MiB journal`);
    bytesRead = 0;
    const recent = await service.getManagementHistory(id, { mode: "recent", limit: 10 });
    assert.ok(bytesRead <= 1_100 * 1024, `recent history read ${bytesRead} bytes from a >1 MiB journal`);
    assert.ok(recent.entries.length > 0 && recent.entries.length <= 10);
    assert.equal(recent.entries.at(-1)?.sequence, 64);
    assert.ok(recent.entries[0]!.sequence > 1, "the JSON response byte budget must report omitted older records");
    assert.equal(recent.has_more, true);
    assert.equal(latest.entries[0]?.sequence, 64);
    assert.match(latest.entries[0]!.text, /cycles=64/u);
    assert.match(latest.legacy_description.text, /Management Note:\nlegacy checkpoint/u);
    assert.equal((await service.getManagementHistory(id, { mode: "after_checkpoint", limit: 10 })).entries.length, 0);

    const collected: number[] = [];
    let cursor: string | undefined;
    let capturedHead = 0;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await service.getManagementHistory(id, { mode: "after", limit: 7, cursor });
      capturedHead ||= page.head_sequence;
      assert.equal(page.captured_head_sequence, 64);
      collected.push(...page.entries.map((entry) => entry.sequence));
      if (pageIndex === 0) await service.addManagementNote(id, "post-capture ordinary note");
      if (!page.has_more) break;
      assert.ok(page.next_cursor);
      cursor = page.next_cursor;
    }
    assert.equal(capturedHead, 64);
    assert.deepEqual(collected, Array.from({ length: 64 }, (_, index) => index + 1));
    const afterAppend = await service.getManagementHistory(id, { mode: "recent", limit: 1 });
    assert.equal(afterAppend.entries[0]?.sequence, 65);
    assert.equal(afterAppend.head_sequence, 65);
    const afterCheckpoint = await new ProjectBoardService(state).getManagementHistory(id, { mode: "after_checkpoint", limit: 10 });
    assert.deepEqual(afterCheckpoint.entries.map((entry) => entry.text), ["post-capture ordinary note"]);
    assert.equal(board.calls.some((call) => call.method === "PUT"), false);
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("cooperating writer processes serialize journal appends without lost or duplicated entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-journal-processes-"));
  const rows = [{ id: "backend-1", projectId: "backend-project", title: "Process writers", description: "",
    status: "todo", priority: "medium" }];
  const backend = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/projects") {
      response.end(JSON.stringify([{ id: "backend-project", prefix: "OCABCDEF", name: "Test", status: "active" }]));
    } else if (request.method === "GET" && request.url === "/api/tickets") {
      response.end(JSON.stringify(rows));
    } else if (request.method === "GET" && request.url === "/api/tickets/backend-1") {
      response.end(JSON.stringify(rows[0]));
    } else {
      response.statusCode = 405;
      response.end(JSON.stringify({ error: "unexpected method" }));
    }
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
    const state = runtime(directory, url);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    const moduleUrl = new URL("./taskboard.js", import.meta.url).href;
    const source = `import { ProjectBoardService } from ${JSON.stringify(moduleUrl)};
const runtime = JSON.parse(process.env.OCVM_JOURNAL_RUNTIME);
const service = new ProjectBoardService(runtime);
await Promise.all(Array.from({ length: 8 }, (_, index) => service.addManagementNote(process.env.OCVM_TASK_ID, \`worker=\${process.env.OCVM_WORKER};entry=\${index}\`)));`;
    const workers = Array.from({ length: 4 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...process.env, OCVM_JOURNAL_RUNTIME: JSON.stringify(state), OCVM_TASK_ID: id, OCVM_WORKER: String(worker) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer ${worker} exited ${code}: ${stderr}`)));
    }));
    await Promise.all(workers);
    const history = await service.getManagementHistory(id, { mode: "after", limit: 50 });
    assert.deepEqual(history.entries.map((entry) => entry.sequence), Array.from({ length: 32 }, (_, index) => index + 1));
    assert.equal(new Set(history.entries.map((entry) => entry.text)).size, 32);
    assert.equal(history.has_more, false);
  } finally {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal uncertainty is reconciled from complete bytes; malformed history fails closed without repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-journal-fault-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Faults", description: "Legacy",
    status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    await service.addManagementNote(id, "first committed entry");
    const journal = service as unknown as { managementJournal: { writeHead: (...args: unknown[]) => Promise<void> } };
    const instance = journal.managementJournal;
    const publish = instance.writeHead.bind(instance);
    let failOnce = true;
    instance.writeHead = async (...args) => {
      if (failOnce) { failOnce = false; throw new Error("injected head publication fault"); }
      return publish(...args);
    };
    await assert.rejects(service.addManagementNote(id, "second may be committed"), { code: "TASK_MANAGEMENT_JOURNAL_UNCERTAIN" });
    const reconciled = await service.getManagementHistory(id, { mode: "recent", limit: 10 });
    assert.equal(reconciled.consistency, "recovered_suffix");
    assert.deepEqual(reconciled.entries.map((entry) => entry.text), ["first committed entry", "second may be committed"]);
    await service.addManagementNote(id, "third after reconciliation");
    assert.deepEqual((await service.getManagementHistory(id, { mode: "recent", limit: 10 })).entries.map((entry) => entry.sequence), [1, 2, 3]);

    const journalPath = join(directory, "management-journal", `${id}.jsonl`);
    const headPath = join(directory, "management-journal", `${id}.head.json`);
    await unlink(headPath);
    const rebuilt = await service.getManagementHistory(id, { mode: "recent", limit: 10 });
    assert.equal(rebuilt.consistency, "rebuilt_index");
    assert.equal(rebuilt.entry_count, 3);
    await assert.rejects(stat(headPath), { code: "ENOENT" }, "a read must not republish a missing derived index");
    await service.addManagementNote(id, "append after index rebuild");
    assert.equal((await service.getManagementHistory(id, { mode: "recent", limit: 10 })).entry_count, 4);
    const originalJournal = await readFile(journalPath);
    const originalHead = await readFile(headPath);
    await writeFile(headPath, "{broken\n");
    await assert.rejects(service.getManagementHistory(id, { mode: "recent", limit: 10 }), { code: "TASK_MANAGEMENT_JOURNAL_ERROR" });
    await assert.rejects(service.addManagementNote(id, "must not append"), { code: "TASK_MANAGEMENT_JOURNAL_ERROR" });
    assert.deepEqual(await readFile(journalPath), originalJournal);
    await writeFile(headPath, originalHead);
    await writeFile(journalPath, Buffer.concat([originalJournal, Buffer.from("{partial", "utf8")]));
    const damaged = await readFile(journalPath);
    await assert.rejects(service.getManagementHistory(id, { mode: "recent", limit: 10 }), { code: "TASK_MANAGEMENT_JOURNAL_ERROR" });
    await assert.rejects(service.addManagementNote(id, "must not skip partial"), { code: "TASK_MANAGEMENT_JOURNAL_ERROR" });
    assert.deepEqual(await readFile(journalPath), damaged);
    assert.equal(board.calls.some((call) => call.method === "PUT"), false);

    await rm(join(directory, "management-journal"), { recursive: true });
    const outside = join(directory, "outside-journal");
    await mkdir(outside);
    await symlink(outside, join(directory, "management-journal"));
    await assert.rejects(service.getManagementHistory(id, { mode: "recent", limit: 10 }), { code: "TASK_MANAGEMENT_JOURNAL_ERROR" });
    await assert.rejects(service.addManagementNote(id, "unsafe symlink target"), { code: "TASK_MANAGEMENT_JOURNAL_ERROR" });
    assert.deepEqual(await readdir(outside), []);
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("journal appends fail before creation when the cooperating-writer lock is unsafe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-journal-lock-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Lock failure", description: "",
    status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    const outside = join(directory, "outside-lock-target");
    await writeFile(outside, "preserve\n");
    await symlink(outside, `${state.taskboardMetadataFile}.lock`);
    await assert.rejects(service.addManagementNote(id, "must not create journal"), { code: "TASKBOARD_METADATA_ERROR" });
    await assert.rejects(stat(join(directory, "management-journal")), { code: "ENOENT" });
    assert.equal(await readFile(outside, "utf8"), "preserve\n");
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("add-only document bundles prevalidate, commit once, replay without publication and retain register retarget semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-bindings-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Bindings", status: "todo", priority: "high" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    const compact = `.opencode/tasks/task-${id}.compact.md`;
    const alternate = `.opencode/tasks/${id}.compact.md`;
    const plan = `planning/task-concepts/${id}-concept-plan.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    const bytes = `Task-ID: ${id}\nUnchanged content\n`;
    await writeFile(join(directory, compact), bytes);
    await writeFile(join(directory, alternate), bytes);
    await assert.rejects(service.addDocumentBindings(id, {}), { code: "INVALID_ARGUMENT" });
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), { code: "TASK_DOCUMENT_MISSING" });
    await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
    await writeFile(join(directory, plan), "Task-ID: task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n");
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), { code: "TASK_DOCUMENT_MISMATCH" });
    assert.deepEqual((await service.getDocuments(id)).documents, []);
    await writeFile(join(directory, plan), bytes);
    // Observe actual publication calls without changing production visibility.
    const writer = service as unknown as { saveMetadata: (...args: unknown[]) => Promise<void> };
    const save = writer.saveMetadata.bind(service);
    let saves = 0;
    writer.saveMetadata = async (...args) => { saves++; await save(...args); };
    const result = await service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan });
    assert.deepEqual(result.documents, [{ role: "compact_context", path: compact }, { role: "concept_plan", path: plan }]);
    assert.equal(saves, 1);
    const persisted = await readFile(state.taskboardMetadataFile, "utf8");
    const inode = (await stat(state.taskboardMetadataFile)).ino;
    assert.deepEqual(await service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), result);
    assert.equal(saves, 1);
    assert.equal((await stat(state.taskboardMetadataFile)).ino, inode);
    await assert.rejects(service.addDocumentBindings(id, { compactContext: alternate, conceptPlan: plan }), { code: "TASK_DOCUMENT_CONFLICT" });
    assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), persisted);
    await writeFile(join(directory, plan), "Task-ID: foreign\n");
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), { code: "TASK_DOCUMENT_MISMATCH" });
    assert.equal(saves, 1);
    await writeFile(join(directory, plan), bytes);
    await service.registerDocument(id, "compact_context", alternate, compact);
    assert.equal((await service.getDocuments(id)).documents[0]!.path, alternate);
    assert.equal(await readFile(join(directory, compact), "utf8"), bytes);
    assert.equal((await service.getTask(id)).status, "todo");
    assert.equal(board.calls.every((call) => call.method === "GET"), true);
    // A fresh bundle mixes an exact single-role replay with one addition.
    await rm(state.taskboardMetadataFile);
    await service.addDocumentBindings(id, { compactContext: compact });
    const single = await readFile(state.taskboardMetadataFile, "utf8");
    await assert.rejects(service.addDocumentBindings(id, { compactContext: alternate, conceptPlan: plan }), { code: "TASK_DOCUMENT_CONFLICT" });
    assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), single);
    assert.equal((await service.getDocuments(id)).documents.length, 1);
    await service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan });
    assert.equal((await service.getDocuments(id)).documents.length, 2);
    assert.equal(saves, 4);
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("low-risk writes fail closed on transfers, corrupt metadata and scan overflow; note budgets include sidecar fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-low-risk-boundary-"));
  const rows = [{ id: "backend-1", projectId: "backend-project", title: "Boundary", description: "", status: "todo", priority: "medium" }];
  const board = fakeBoard(rows);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    const compact = `.opencode/tasks/task-${id}.compact.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await writeFile(join(directory, compact), `Task-ID: ${id}\n`);
    const metadata = { schema: 2, projects: {}, tasks: {}, comments: {
      [id]: [{ id: "comment", body: "界".repeat(12_000), created_at: "2026-09-30T00:00:00Z" }],
    }, links: { [id]: [{ session_id: "ses", result: "Preserved" }] }, transfers: {} };
    await writeFile(state.taskboardMetadataFile, JSON.stringify(metadata));
    const before = await readFile(state.taskboardMetadataFile, "utf8");
    // Existing task JSON remains under 40 KB; a note no longer adds its bytes to that output.
    assert.equal((await service.addManagementNote(id, "界".repeat(2_000))).description, "");
    await service.addManagementNote(id, "Within budget");
    assert.equal((await service.getTask(id)).description, "");
    assert.deepEqual((await service.getManagementHistory(id, { mode: "recent", limit: 10 })).entries.map((entry) => entry.text),
      ["界".repeat(2_000), "Within budget"]);
    assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), before);
    await service.addDocumentBindings(id, { compactContext: compact });
    const upgraded = JSON.parse(await readFile(state.taskboardMetadataFile, "utf8"));
    assert.equal(upgraded.schema, 3);
    assert.deepEqual(upgraded.comments, metadata.comments);
    assert.deepEqual(upgraded.links, metadata.links);
    const requestId = randomUUID();
    upgraded.transfers[requestId] = { request_id: requestId, task_id: id, source: { id: "backend-1" },
      source_board_project_id: "project_source", target_board_project_id: "project_target",
      target_backend_project_id: "backend-target", state: "unresolved" };
    await writeFile(state.taskboardMetadataFile, JSON.stringify(upgraded));
    const pending = await readFile(state.taskboardMetadataFile, "utf8");
    const calls = board.calls.length;
    await assert.rejects(service.addManagementNote(id, "Blocked"), { code: "TASK_TRANSFER_UNRESOLVED" });
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact }), { code: "TASK_TRANSFER_UNRESOLVED" });
    assert.equal(board.calls.length, calls);
    assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), pending);
    upgraded.transfers = {};
    upgraded.documents[id] = [{ role: "concept_plan", path: compact }];
    await writeFile(state.taskboardMetadataFile, JSON.stringify(upgraded));
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact }), { code: "TASKBOARD_METADATA_ERROR" });
    await assert.rejects(service.addManagementNote(id, "Blocked"), { code: "TASKBOARD_METADATA_ERROR" });
    await rm(state.taskboardMetadataFile);
    rows.push(...Array.from({ length: 500 }, (_, index) => ({ id: `extra-${index}`, projectId: "backend-project",
      title: "Extra", description: "", status: "todo", priority: "medium" })));
    const puts = board.calls.filter((call) => call.method === "PUT").length;
    await assert.rejects(service.addManagementNote(id, "Incomplete scan"), { code: "TASK_SEARCH_INCOMPLETE" });
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact }), { code: "TASK_SEARCH_INCOMPLETE" });
    assert.equal(board.calls.filter((call) => call.method === "PUT").length, puts);
    await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent add-only bundles publish once; conflicting canonical paths never silently retarget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-binding-race-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Concurrent", status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const services = [new ProjectBoardService(state), new ProjectBoardService(state)];
    const id = (await services[0]!.listTasks())[0]!.task_id;
    const compact = `.opencode/tasks/task-${id}.compact.md`;
    const alternate = `.opencode/tasks/${id}.compact.md`;
    const plan = `planning/task-concepts/${id}-concept-plan.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    for (const path of [compact, alternate, plan]) await writeFile(join(directory, path), `Task-ID: ${id}\n`);
    let saves = 0;
    for (const service of services) {
      const writer = service as unknown as { saveMetadata: (...args: unknown[]) => Promise<void> };
      const save = writer.saveMetadata.bind(service);
      writer.saveMetadata = async (...args) => { saves++; await save(...args); };
    }
    await Promise.all(services.map((service) => service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan })));
    assert.equal(saves, 1);
    await rm(state.taskboardMetadataFile);
    const outcomes = await Promise.allSettled(services.map((service, index) =>
      service.addDocumentBindings(id, { compactContext: index ? alternate : compact, conceptPlan: plan })));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "TASK_DOCUMENT_CONFLICT");
    assert.equal(saves, 2);
    assert.equal((await services[0]!.getDocuments(id)).documents.length, 2);
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("add-only binding reuses file safety checks without partial publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-binding-files-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Files", status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    const compact = `.opencode/tasks/task-${id}.compact.md`;
    const plan = `planning/task-concepts/${id}-concept-plan.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    await writeFile(join(directory, compact), `Task-ID: ${id}\n`);
    for (const [bytes, code] of [
      [Buffer.concat([Buffer.from(`Task-ID: ${id}\n`), Buffer.from([0xff])]), "TASK_DOCUMENT_INVALID"],
      [Buffer.from(`Task-ID: ${id}\n${"x".repeat(1024 * 1024)}`), "TASK_DOCUMENT_LIMIT"],
    ] as const) {
      await writeFile(join(directory, plan), bytes);
      await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), { code });
      await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
    }
    await rm(join(directory, plan));
    await symlink(join(directory, compact), join(directory, plan));
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), { code: "TASK_DOCUMENT_PATH_INVALID" });
    await rm(join(directory, plan));
    await mkdir(join(directory, plan));
    await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), { code: "TASK_DOCUMENT_PATH_INVALID" });
    await assert.rejects(service.addDocumentBindings("task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { compactContext: compact }), { code: "TASK_NOT_FOUND" });
    await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("task reads neither create projects nor metadata; UI and MCP tasks have stable separate IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-read-"));
  const rows = [{ id: "backend-1", projectId: "backend-project", title: "Alpha", description: "Search body",
    status: "todo", priority: "high" }];
  const board = fakeBoard(rows);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const listed = await service.listTasks();
    assert.match(listed[0]!.task_id, /^task_[0-9a-f-]{36}$/);
    assert.notEqual(listed[0]!.task_id, rows[0]!.id);
    assert.equal((await service.getTask(listed[0]!.task_id)).task_id, listed[0]!.task_id);
    assert.equal((await new ProjectBoardService(state).listTasks())[0]!.task_id, listed[0]!.task_id);
    await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
    assert.equal(board.calls.every((call) => call.method === "GET"), true);
    assert.deepEqual((await service.listTasks({ query: "BODY" })).map((task) => task.task_id), [listed[0]!.task_id]);
    assert.deepEqual(await service.listTasks({ query: "not here" }), []);
     await assert.rejects(service.listTasks({ projectId: "project_alias" }), { code: "BOARD_PROJECT_NOT_FOUND" });
    const created = await service.createTask({ title: "New" });
    assert.equal(created.task_id, (await service.listTasks({ query: "New" }))[0]!.task_id);
  } finally {
    board.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt and unsupported metadata fail closed and preserve original bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-corrupt-"));
  const board = fakeBoard([]);
  try {
    const state = runtime(directory);
    for (const raw of ["{broken", JSON.stringify({ schema: "3", projects: {}, tasks: {}, comments: {}, links: {}, transfers: {}, documents: {} }),
      JSON.stringify({ schema: 2, projects: {}, tasks: {}, comments: {}, links: {} }),
      JSON.stringify({ schema: 1, projects: [], tasks: {}, comments: {}, links: {} }),
      JSON.stringify({ schema: 3, projects: {}, tasks: {}, comments: {}, links: {}, transfers: {}, documents: {
        "task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": [{ role: "concept_plan", path: "../../private.md" }],
      } })]) {
      await writeFile(state.taskboardMetadataFile, raw);
      await assert.rejects(new ProjectBoardService(state).listTasks(), { code: "TASKBOARD_METADATA_ERROR" });
      await assert.rejects(new ProjectBoardService(state).createTask({ title: "Do not create" }), { code: "TASKBOARD_METADATA_ERROR" });
      assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), raw);
    }
    assert.equal(board.calls.some((call) => call.method === "POST"), false);
  } finally {
    board.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("semantic task documents: register after file confirmation, resume, paginated read and bounded paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-doc-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Documents", status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const taskId = (await service.getTask((await service.listTasks())[0]!.task_id)).task_id;
    const compact = `.opencode/tasks/task-${taskId}.compact.md`;
    const plan = `planning/task-concepts/${taskId}-concept-plan.md`;
    const detail = `planning/task-concepts/${taskId}-architecture.md`;
    assert.deepEqual((await service.getDocuments(taskId)).documents, []); // Old tasks need no sidecar write.
    await assert.rejects(service.registerDocument(taskId, "compact_context", compact), { code: "TASK_DOCUMENT_MISSING" });
    const legacy = JSON.stringify({ schema: 2, projects: {}, tasks: {}, comments: {}, links: {}, transfers: {} });
    await writeFile(state.taskboardMetadataFile, legacy);
    assert.deepEqual((await service.getDocuments(taskId)).documents, []);
    assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), legacy); // Legacy read stays read-only.
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    await writeFile(join(directory, compact), `Task-ID: ${taskId}\nState: ready\n`);
    await writeFile(join(directory, plan), `Task-ID: ${taskId}\nPlan: ${"ä".repeat(70_000)}\n`);
    await writeFile(join(directory, detail), `Task-ID: ${taskId}\nArchitecture: bounded\n`);
    await assert.rejects(service.readDocument(taskId, "concept_plan"), { code: "TASK_DOCUMENT_REF_NOT_FOUND" });
    await service.registerDocument(taskId, "compact_context", compact);
    assert.equal((JSON.parse(await readFile(state.taskboardMetadataFile, "utf8")) as { schema: number }).schema, 3);
    await service.registerDocument(taskId, "concept_plan", plan);
    await service.registerDocument(taskId, "concept_detail", detail);
    const secondDetail = `planning/task-concepts/${taskId}-test-plan.md`;
    await writeFile(join(directory, secondDetail), `Task-ID: ${taskId}\nTests: pending\n`);
    await service.registerDocument(taskId, "concept_detail", secondDetail);
    await assert.rejects(service.readDocument(taskId, "concept_detail"), { code: "INVALID_ARGUMENT" });
    assert.match((await service.readDocument(taskId, "concept_detail", detail)).text, /Architecture: bounded/u);
    await assert.rejects(service.registerDocument(taskId, "concept_plan", secondDetail), { code: "TASK_DOCUMENT_PATH_INVALID" });
    assert.equal((await service.getTask(taskId)).documents?.length, 4);
    const restarted = new ProjectBoardService(state);
    const documents = (await restarted.getDocuments(taskId)).documents;
    assert.deepEqual(documents.map((item) => item.role), ["compact_context", "concept_plan", "concept_detail", "concept_detail"]);
    assert.equal(documents[1]?.state, "available");
    let offset = 0;
    let revision: string | undefined;
    let assembled = "";
    do {
      const page = await restarted.readDocument(taskId, "concept_plan", undefined, offset, 127, revision);
      assert.equal(page.range.start, offset);
      revision = page.revision;
      offset = page.range.end;
      assembled += page.text;
      if (!page.has_more) break;
    } while (true);
    assert.equal(assembled, await readFile(join(directory, plan), "utf8"));
    assert.equal(revision, documents[1]?.revision);
    await assert.rejects(restarted.readDocument(taskId, "concept_plan", undefined, 1), { code: "TASK_DOCUMENT_CHANGED" });
    const insideUmlaut = Buffer.byteLength(`Task-ID: ${taskId}\nPlan: `) + 1;
    await assert.rejects(restarted.readDocument(taskId, "concept_plan", undefined, insideUmlaut, 128, revision),
      { code: "INVALID_ARGUMENT" });
    await writeFile(join(directory, plan), `Task-ID: ${taskId}\nPlan: changed\n`);
    await assert.rejects(restarted.readDocument(taskId, "concept_plan", undefined, offset - 10, 128, revision),
      { code: "TASK_DOCUMENT_CHANGED" });
    await writeFile(join(directory, plan), Buffer.concat([Buffer.from(`Task-ID: ${taskId}\n`), Buffer.from([0xff])]));
    await assert.rejects(restarted.readDocument(taskId, "concept_plan"), { code: "TASK_DOCUMENT_INVALID" });
    await writeFile(join(directory, plan), `Task-ID: ${taskId}\n${"x".repeat(1024 * 1024)}\n`);
    await assert.rejects(restarted.readDocument(taskId, "concept_plan"), { code: "TASK_DOCUMENT_LIMIT" });
    await writeFile(join(directory, plan), `Task-ID: ${taskId}\nPlan: current\n`);
    await assert.rejects(restarted.registerDocument(taskId, "concept_plan", "planning/task-concepts/other.md"),
      { code: "TASK_DOCUMENT_PATH_INVALID" });
    await assert.rejects(restarted.registerDocument(taskId, "concept_detail", `planning/task-concepts/${taskId}-../escape.md`),
      { code: "TASK_DOCUMENT_PATH_INVALID" });
    await assert.rejects(restarted.readDocument(taskId, "concept_detail", `planning/task-concepts/${taskId}-unregistered.md`),
      { code: "TASK_DOCUMENT_REF_NOT_FOUND" });
    await writeFile(join(directory, compact), `Task-ID: task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\nwrong\n`);
    await assert.rejects(restarted.readDocument(taskId, "compact_context"), { code: "TASK_DOCUMENT_MISMATCH" });
    await rm(join(directory, compact));
    await symlink(join(directory, detail), join(directory, compact));
    await assert.rejects(restarted.readDocument(taskId, "compact_context"), { code: "TASK_DOCUMENT_PATH_INVALID" });
    await rm(join(directory, compact));
    assert.equal((await restarted.getDocuments(taskId)).documents[0]?.state, "missing");
    await assert.rejects(restarted.readDocument(taskId, "compact_context"), { code: "TASK_DOCUMENT_MISSING" });
    await rm(join(directory, ".opencode/tasks"), { recursive: true });
    await symlink(join(directory, "planning/task-concepts"), join(directory, ".opencode/tasks"));
    await assert.rejects(restarted.readDocument(taskId, "compact_context"), { code: "TASK_DOCUMENT_PATH_INVALID" });
  } finally {
    board.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("document header ID/format diagnostics fail closed for both roles and add-only bundle without publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-headers-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Headers", status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    const foreignId = `task_${randomUUID()}`;
    const invalid = [
      `Task-ID: ${foreignId}\n`,
      `# Task-ID: ${id}\n`, `\`Task-ID: ${id}\`\n`, `\`\`\`\nTask-ID: ${id}\n\`\`\`\n`,
      `Task ID: ${id}\n`, `Task-ID:${id}\n`, `Task-ID:  ${id}\n`,
      ` Task-ID: ${id}\n`, `Task-ID: ${id} \n`, `\nTask-ID: ${id}\n`,
    ];
    for (const [role, path] of [
      ["compact_context", `.opencode/tasks/task-${id}.compact.md`],
      ["concept_plan", `planning/task-concepts/${id}-concept-plan.md`],
    ] as const) {
      // The other bundle file is good: failure cannot publish even that role.
      const compact = `.opencode/tasks/task-${id}.compact.md`;
      const plan = `planning/task-concepts/${id}-concept-plan.md`;
      await writeFile(join(directory, role === "compact_context" ? plan : compact), `Task-ID: ${id}\nGood body\n`);
      for (const header of invalid) {
        const text = `${header}Preserve this body\n`;
        await writeFile(join(directory, path), text);
        const expected = {
          code: "TASK_DOCUMENT_MISMATCH",
          message: `Task document at ${path} has a mismatched task ID or header format. First line must be exactly "Task-ID: ${id}" (plain text, no extra spacing), followed by LF or CRLF.`,
        };
        await assert.rejects(service.registerDocument(id, role, path), expected);
        await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), expected);
        assert.equal(await readFile(join(directory, path), "utf8"), text);
        assert.deepEqual((await service.getDocuments(id)).documents, []);
        await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
        assert.equal((await service.getTask(id)).status, "todo");
      }
    }
    const missing = `planning/task-concepts/${id}-concept-plan-missing.md`;
    await assert.rejects(service.registerDocument(id, "concept_detail", missing), { code: "TASK_DOCUMENT_MISSING" });
    await assert.rejects(service.registerDocument(id, "compact_context", missing), { code: "TASK_DOCUMENT_PATH_INVALID" });
    assert.equal(board.calls.some((call) => call.method !== "GET"), false);
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

for (const bundle of [false, true]) test(`document header recovery preserves r21 ${bundle ? "bundle" : "register fallback"} and readback gate`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-header-recovery-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Recovery", status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    const compact = `.opencode/tasks/task-${id}.compact.md`;
    const plan = `planning/task-concepts/${id}-concept-plan.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    const compactText = `Task-ID: ${id}\nTitle: Recovery\nLast-updated: 2026-09-30T00:00:00+00:00\nState: initialized\n`;
    const body = "Title: Recovery\nStatus: draft\nLast-concept-update: 2026-09-30T00:00:00+00:00\nGoal: preserve requirements\n";
    await writeFile(join(directory, compact), compactText);
    await writeFile(join(directory, plan), `# Task-ID: ${id}\n${body}`);
    if (bundle) {
      await assert.rejects(service.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }), { code: "TASK_DOCUMENT_MISMATCH" });
      await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
    } else {
      await service.registerDocument(id, "compact_context", compact);
      const before = await readFile(state.taskboardMetadataFile, "utf8");
      await assert.rejects(service.registerDocument(id, "concept_plan", plan), { code: "TASK_DOCUMENT_MISMATCH" });
      assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), before);
    }
    assert.equal((await service.getTask(id)).status, "todo");
    assert.equal(board.calls.some((call) => call.path.endsWith("/move")), false);
    // Authorized same-file repair preserves body and existing LF/CRLF compatibility.
    const corrected = `Task-ID: ${id}\r\n${body}`;
    await writeFile(join(directory, plan), corrected);
    assert.equal(await readFile(join(directory, compact), "utf8"), compactText);
    const resumed = new ProjectBoardService(state);
    const bind = () => bundle ? resumed.addDocumentBindings(id, { compactContext: compact, conceptPlan: plan }) :
      resumed.registerDocument(id, "concept_plan", plan);
    await bind();
    const bound = await readFile(state.taskboardMetadataFile, "utf8");
    const inode = (await stat(state.taskboardMetadataFile)).ino;
    // A good old registration cannot hide a later malformed header, even on exact replay.
    await writeFile(join(directory, plan), `\`Task-ID: ${id}\`\n${body}`);
    await assert.rejects(bind(), { code: "TASK_DOCUMENT_MISMATCH" });
    await assert.rejects(resumed.getDocuments(id), { code: "TASK_DOCUMENT_MISMATCH" });
    await assert.rejects(resumed.readDocument(id, "concept_plan"), { code: "TASK_DOCUMENT_MISMATCH" });
    assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), bound);
    assert.equal((await resumed.getTask(id)).status, "todo");
    assert.equal(board.calls.some((call) => call.path.endsWith("/move")), false);
    await writeFile(join(directory, plan), corrected);
    await bind();
    if (bundle) assert.equal((await stat(state.taskboardMetadataFile)).ino, inode);
    const documents = (await resumed.getDocuments(id)).documents;
    assert.deepEqual(documents.map((item) => [item.role, item.path, item.state]), [
      ["compact_context", compact, "available"], ["concept_plan", plan, "available"],
    ]);
    for (const document of documents) {
      assert.ok(document.state === "available");
      assert.equal(document.sha256, createHash("sha256").update(await readFile(join(directory, document.path))).digest("hex"));
      assert.equal(document.revision, `task-file-v1:${document.sha256}`);
      assert.equal((await resumed.readDocument(id, document.role)).revision, document.revision);
    }
    assert.equal(await readFile(join(directory, plan), "utf8"), corrected);
    assert.equal((await resumed.getTask(id)).status, "todo");
    await resumed.moveTask(id, "in_progress"); // Client ordering, not new server admission.
    assert.equal((await resumed.getTask(id)).status, "in_progress");
    assert.equal(board.calls.filter((call) => call.path.endsWith("/move")).length, 1);
  } finally { board.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("document initialization precedes board move; failed move keeps todo and reuses refs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-doc-init-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "Work", status: "todo", priority: "medium" }]);
  try {
    const service = new ProjectBoardService(runtime(directory));
    const id = (await service.listTasks())[0]!.task_id;
    const compact = `.opencode/tasks/task-${id}.compact.md`;
    const plan = `planning/task-concepts/${id}-concept-plan.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    await assert.rejects(service.registerDocument(id, "compact_context", compact), { code: "TASK_DOCUMENT_MISSING" });
    assert.equal((await service.getTask(id)).status, "todo");
    await writeFile(join(directory, compact), `Task-ID: ${id}\nState: ready\n`);
    await writeFile(join(directory, plan), `Task-ID: ${id}\nGoal: work\n`);
    await service.registerDocument(id, "compact_context", compact);
    await service.registerDocument(id, "concept_plan", plan);
    assert.equal((await service.getDocuments(id)).documents.length, 2);
    board.failMoveOnce();
    await assert.rejects(service.moveTask(id, "in_progress"), { code: "TASKBOARD_ERROR" });
    assert.equal((await service.getTask(id)).status, "todo");
    const resumed = new ProjectBoardService(runtime(directory));
    await resumed.registerDocument(id, "compact_context", compact);
    await resumed.registerDocument(id, "concept_plan", plan);
    assert.equal((await resumed.getDocuments(id)).documents.length, 2);
    assert.equal((await resumed.moveTask(id, "in_progress")).status, "in_progress");
    assert.equal((await resumed.getTask(id)).documents?.length, 2);
    const moved = board.calls.findIndex((call) => call.path.endsWith("/move"));
    assert.ok(moved > board.calls.findIndex((call) => call.path === "/api/tickets/backend-1"));
  } finally {
    board.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same session retains distinct messages/results/artifacts; exact repeat enriches rather than duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-links-"));
  const board = fakeBoard([{ id: "backend-1", projectId: "backend-project", title: "One", status: "todo", priority: "medium" }]);
  try {
    const state = runtime(directory);
    const service = new ProjectBoardService(state);
    const id = (await service.listTasks())[0]!.task_id;
    await service.linkTask(id, { sessionId: "ses_A", messageId: "msg_1", artifactRefs: ["report:1"] });
    await service.linkTask(id, { sessionId: "ses_A", messageId: "msg_2", result: "Second result" });
    await service.linkTask(id, { sessionId: "ses_B", messageId: "msg_3" });
    const links = (await service.linkTask(id, { sessionId: "ses_A", messageId: "msg_1", result: "First result", artifactRefs: ["report:2"] })).links;
    assert.deepEqual(links.map((link) => link.message_id), ["msg_1", "msg_2", "msg_3"]);
    assert.deepEqual(links[0]!.artifact_refs, ["report:1", "report:2"]);
    assert.equal(links[0]!.result, "First result");
    assert.equal(links[1]!.result, "Second result");
    assert.deepEqual((await service.getTask(id)).session_ids, ["ses_A", "ses_B"]);
    assert.equal((await service.getTask(id)).links?.length, 3);
    assert.deepEqual((await service.listTasks({ sessionId: "ses_A" })).map((task) => task.task_id), [id]);
    assert.deepEqual((await new ProjectBoardService(state).listTasks({ sessionId: "ses_B" })).map((task) => task.task_id), [id]);
    await service.linkTask(id, { sessionId: "ses_C", result: "Implementation" });
    await service.linkTask(id, { sessionId: "ses_C", result: "Review" });
    await service.linkTask(id, { sessionId: "ses_A", messageId: "msg_1", result: "Revised finding" });
    const later = (await service.getTask(id)).links!;
    assert.deepEqual(later.filter((item) => item.session_id === "ses_C").map((item) => item.result),
      ["Implementation", "Review"]);
    assert.deepEqual(later.filter((item) => item.message_id === "msg_1").map((item) => item.result),
      ["First result", "Revised finding"]);
    const first = new ProjectBoardService(state);
    await first.listTasks();
    await new ProjectBoardService(state).addComment(id, "Other writer");
    await first.addComment(id, "Original reader");
    assert.deepEqual((await new ProjectBoardService(state).getTask(id)).comments.map((item) => item.body),
      ["Other writer", "Original reader"]);
  } finally {
    board.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("scan and result overflow return an error, never a false empty or partial match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-limits-"));
  const rows: Array<{ id: string; projectId: string; title: string; status: string; priority: string; description?: string }> = [];
  const board = fakeBoard(rows);
  try {
    const service = new ProjectBoardService(runtime(directory));
    for (let index = 0; index <= TASK_SCAN_LIMIT; index++) rows.push({ id: `b${index}`,
      projectId: "backend-project", title: "Other", status: "todo", priority: "medium" });
    await assert.rejects(service.listTasks({ query: "not present" }), { code: "TASK_SEARCH_INCOMPLETE" });
    rows.length = TASK_RESULT_LIMIT + 1;
    await assert.rejects(service.listTasks(), { code: "TASK_SEARCH_INCOMPLETE" });
    rows.length = 1;
    rows[0]!.description = "a".repeat(41_000);
    await assert.rejects(service.listTasks(), { code: "TASK_SEARCH_INCOMPLETE" });
    rows.length = 0;
    for (let index = 0; index < TASK_SCAN_LIMIT; index++) rows.push({ id: `big${index}`,
      projectId: "backend-project", title: "Other", status: "todo", priority: "medium", description: "a".repeat(3000) });
    await assert.rejects(service.listTasks({ query: "not present" }), { code: "TASK_SEARCH_INCOMPLETE" });
  } finally {
    board.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pinned upstream binary: two writer processes do not lose comments", { skip: !process.env.OCVM_TASKBOARD_BIN }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-real-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const child = spawn(process.env.OCVM_TASKBOARD_BIN!, ["--db", join(directory, "board.db"),
    "start", "--foreground", "--port", String(port)], { stdio: "ignore", env: { ...process.env, SHELL: "/bin/false" } });
  try {
    const state = runtime(directory, `http://127.0.0.1:${port}`);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${state.taskboardUrl}/api/projects`)).ok; if (ready) break; } catch { /* Starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const board = new ProjectBoardService(state);
    assert.deepEqual(await board.listTasks(), []);
    assert.deepEqual(await (await fetch(`${state.taskboardUrl}/api/projects`)).json(), []);
    await assert.rejects(stat(state.taskboardMetadataFile), { code: "ENOENT" });
    await assert.rejects(board.createTask({ title: "No silent Inbox" }), { code: "BOARD_PROJECT_SETUP_REQUIRED" });
    await board.createBoardProject({ name: "Inbox", prefix: "INBOX", makeDefault: true });
    const task = await board.createTask({ title: "Phase 1 fixture" });
    const beforeUiRead = await readFile(state.taskboardMetadataFile, "utf8");
    const projects = await (await fetch(`${state.taskboardUrl}/api/projects`)).json() as Array<{ id: string }>;
    const project = projects[0]!;
    const uiResult = await fetch(`${state.taskboardUrl}/api/tickets`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, title: "UI followup", description: "Searchable" }) });
    assert.equal(uiResult.status, 201);
    const uiTask = (await board.listTasks({ query: "SEARCHABLE" }))[0]!;
    assert.equal(uiTask.title, "UI followup");
    assert.equal((await board.getTask(uiTask.task_id)).task_id, uiTask.task_id);
    assert.equal(await readFile(state.taskboardMetadataFile, "utf8"), beforeUiRead);
    const writer = async (body: string) => {
      const code = `import { ProjectBoardService } from ${JSON.stringify(new URL("./taskboard.js", import.meta.url).href)};\n` +
        `await new ProjectBoardService(JSON.parse(process.argv[1])).addComment(process.argv[2], process.argv[3]);`;
      const proc = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(state), task.task_id, body], { stdio: "ignore" });
      return new Promise<number>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("exit", (status) => resolve(status ?? -1));
      });
    };
    assert.deepEqual(await Promise.all([writer("first"), writer("second")]), [0, 0]);
    assert.deepEqual((await new ProjectBoardService(state).getTask(task.task_id)).comments.map((entry) => entry.body).sort(),
      ["first", "second"]);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("pinned upstream binary: confirmed Inbox, multi-project identity and recoverable reclassification", { skip: !process.env.OCVM_TASKBOARD_BIN }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-board-transfer-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const child = spawn(process.env.OCVM_TASKBOARD_BIN!, ["--db", join(directory, "board.db"),
    "start", "--foreground", "--port", String(port)], { stdio: "ignore", env: { ...process.env, SHELL: "/bin/false" } });
  const state = runtime(directory, `http://127.0.0.1:${port}`);
  const api = async (path: string, body: unknown) => {
    const response = await fetch(`${state.taskboardUrl}${path}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path} returned ${response.status}`);
    return response.json() as Promise<Record<string, any>>;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${state.taskboardUrl}/api/projects`)).ok; if (ready) break; } catch { /* Starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const board = new ProjectBoardService(state);
    assert.deepEqual(await board.listBoardProjects(), []);
    await assert.rejects(board.createTask({ title: "No implicit create" }), { code: "BOARD_PROJECT_SETUP_REQUIRED" });
    assert.deepEqual(await (await fetch(`${state.taskboardUrl}/api/projects`)).json(), []);
    const inbox = await board.createBoardProject({ name: "Inbox", prefix: "INBOX", makeDefault: true });
    const work = await board.createBoardProject({ name: "Architecture", prefix: "ARCH" });
    assert.equal((await board.listBoardProjects()).length, 2);
    assert.equal((await new ProjectBoardService(state).getBoardProject(inbox.board_project_id)).is_default, true);
    const projects = await (await fetch(`${state.taskboardUrl}/api/projects`)).json() as Array<{ id: string; prefix: string }>;
    const inboxBackend = projects.find((project) => project.prefix === "INBOX")!.id;
    const team = await api("/api/teams", { name: "Optional" });
    const label = await api("/api/labels", { name: "Keep", color: "#ffffff" });
    const source = await api("/api/tickets", { projectId: inboxBackend, title: "Original ticket", description: "Keep obligation",
      teamId: team.id, dueDate: "2026-10-01", labels: [label.id], status: "in_progress", priority: "high" });
    const subtask = await api(`/api/tickets/${source.id}/subtasks`, { title: "Check evidence" });
    await api(`/api/subtasks/${subtask.id}/toggle`, {});
    const task = (await board.listTasks({ query: "Original" }))[0]!;
    await board.linkTask(task.task_id, { sessionId: "ses_one", messageId: "msg_one", result: "Result one", artifactRefs: ["file:a"] });
    await board.linkTask(task.task_id, { sessionId: "ses_two", messageId: "msg_two", result: "Result two", artifactRefs: ["file:b"] });
    await board.addComment(task.task_id, "Decision");
    const contextPath = `.opencode/tasks/task-${task.task_id}.compact.md`;
    const planPath = `planning/task-concepts/${task.task_id}-concept-plan.md`;
    await mkdir(join(directory, ".opencode/tasks"), { recursive: true });
    await mkdir(join(directory, "planning/task-concepts"), { recursive: true });
    await writeFile(join(directory, contextPath), `Task-ID: ${task.task_id}\nCurrent state\n`);
    await writeFile(join(directory, planPath), `Task-ID: ${task.task_id}\nPlan\n`);
    await board.registerDocument(task.task_id, "compact_context", contextPath);
    await board.registerDocument(task.task_id, "concept_plan", planPath);
    const requestId = randomUUID();
    const input = { taskId: task.task_id, targetBoardProjectId: work.board_project_id,
      expectedSourceBoardProjectId: inbox.board_project_id, requestId };
    const originalFetch = globalThis.fetch;
    let interrupted = false;
    try {
      globalThis.fetch = (async (url, options) => {
        if (!interrupted && String(url).includes(`/api/tickets/${source.id}`) && options?.method === "DELETE") {
          interrupted = true;
          return new Response("failure", { status: 500 });
        }
        return originalFetch(url, options);
      }) as typeof fetch;
      await assert.rejects(board.reclassifyTask(input), { code: "TASK_TRANSFER_UNRESOLVED" });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(interrupted, true);
    assert.equal((await board.getTransferStatus(requestId)).state, "unresolved");
    await assert.rejects(board.getTask(task.task_id), { code: "TASK_TRANSFER_UNRESOLVED" });
    await assert.rejects(board.listTasks({ sessionId: "ses_one" }), { code: "TASK_TRANSFER_UNRESOLVED" });
    await assert.rejects(new ProjectBoardService(state).reclassifyTask(input), { code: "TASK_TRANSFER_UNRESOLVED" });
    const stage = (await (await fetch(`${state.taskboardUrl}/api/tickets?`)).json() as Array<Record<string, any>>)
      .find((row) => row.description?.includes(`[transfer-pending:${requestId}]`))!;
    assert.equal(stage.status, "done");
    assert.equal(stage.teamId, team.id);
    assert.equal(stage.subtasks[0].completed, true);
    assert.equal((await fetch(`${state.taskboardUrl}/api/tickets/${source.id}`)).ok, true);
    // Reconcile an explicitly verified deletion without issuing a second DELETE.
    const deleted = await fetch(`${state.taskboardUrl}/api/tickets/${source.id}`, { method: "DELETE" });
    assert.equal(deleted.ok, true);
    const moved = await new ProjectBoardService(state).reclassifyTask(input);
    assert.equal(moved.state, "completed");
    assert.equal(moved.task_id, task.task_id);
    assert.equal(moved.previous_native_key.startsWith("INBOX-"), true);
    assert.equal(moved.current_native_key?.startsWith("ARCH-"), true);
    assert.deepEqual(await new ProjectBoardService(state).reclassifyTask(input), moved);
    const actual = await board.getTask(task.task_id);
    assert.equal(actual.board_project_id, work.board_project_id);
    assert.equal(actual.status, "in_progress");
    assert.equal(actual.description, "Keep obligation");
    assert.equal(actual.comments[0]!.body, "Decision");
    assert.deepEqual(actual.links?.map((link) => link.message_id), ["msg_one", "msg_two"]);
    assert.deepEqual(actual.documents?.map((entry) => entry.role), ["compact_context", "concept_plan"]);
    assert.equal((await new ProjectBoardService(state).getDocuments(task.task_id)).documents[1]?.state, "available");
    assert.deepEqual((await board.listTasks({ boardProjectId: work.board_project_id, sessionId: "ses_two" }))
      .map((item) => item.task_id), [task.task_id]);
    assert.deepEqual(await board.listTasks({ boardProjectId: inbox.board_project_id }), []);
    const target = (await (await fetch(`${state.taskboardUrl}/api/tickets?`)).json() as Array<Record<string, any>>)[0]!;
    assert.equal(target.teamId, team.id);
    assert.equal(target.dueDate.startsWith("2026-10-01"), true);
    assert.equal(target.labels[0].id, label.id);
    assert.equal(target.subtasks[0].completed, true);
    assert.equal(target.description.includes("transfer-pending"), false);
    await assert.rejects(board.reclassifyTask({ ...input, requestId: randomUUID() }), { code: "TASK_TRANSFER_CONFLICT" });
    // Workstream -> workstream reclassification of an unrelated task.
    const inter = await board.createTask({ boardProjectId: work.board_project_id, title: "Move me between workstreams" });
    const interTransfer = randomUUID();
    const interInput = { taskId: inter.task_id, targetBoardProjectId: inbox.board_project_id,
      expectedSourceBoardProjectId: work.board_project_id, requestId: interTransfer };
    const interMoved = await board.reclassifyTask(interInput);
    assert.equal(interMoved.state, "completed");
    assert.equal(interMoved.current_native_key?.startsWith("INBOX-"), true);
    assert.equal((await board.getTask(inter.task_id)).board_project_id, inbox.board_project_id);
    // Replay with the original UUID and matching source Board Project remains idempotent.
    assert.deepEqual(await new ProjectBoardService(state).reclassifyTask(interInput), interMoved);
    // Stale target: changing the destination for the same UUID must fail closed
    // even when the source still matches.
    await assert.rejects(board.reclassifyTask({ ...interInput,
      targetBoardProjectId: work.board_project_id }), { code: "TASK_TRANSFER_CONFLICT" });
    // The moved task remains uniquely addressable under its public task_id after the replay attempt.
    const movedTask = (await board.getTask(inter.task_id));
    assert.equal(movedTask.task_id, inter.task_id);
    const extra = await board.createTask({ title: "Lost staging response" });
    const retryId = randomUUID();
    const originalPost = globalThis.fetch;
    let lost = false;
    try {
      globalThis.fetch = (async (url, options) => {
        if (!lost && String(url).endsWith("/api/tickets") && options?.method === "POST" &&
            String(options.body).includes("[transfer-pending]")) {
          lost = true;
          await originalPost(url, options);
          throw new Error("response lost after commit");
        }
        return originalPost(url, options);
      }) as typeof fetch;
      assert.equal((await board.reclassifyTask({ taskId: extra.task_id, targetBoardProjectId: work.board_project_id,
        expectedSourceBoardProjectId: inbox.board_project_id, requestId: retryId })).state, "completed");
    } finally { globalThis.fetch = originalPost; }
    assert.equal(lost, true);
    assert.equal((await board.listTasks({ boardProjectId: work.board_project_id })).length, 2);
    const dependent = await api("/api/tickets", { projectId: inboxBackend, title: "Dependency example", blockedBy: [target.id] });
    const dependentTask = (await board.listTasks({ query: "Dependency example" }))[0]!;
    assert.equal(dependentTask.title, dependent.title);
    await assert.rejects(board.reclassifyTask({ taskId: dependentTask.task_id, targetBoardProjectId: work.board_project_id,
      expectedSourceBoardProjectId: inbox.board_project_id, requestId: randomUUID() }), { code: "TASK_TRANSFER_UNSUPPORTED" });
    const changed = await board.createTask({ title: "Source changes during staging" });
    const sourceId = (await (await fetch(`${state.taskboardUrl}/api/tickets?`)).json() as Array<Record<string, any>>)
      .find((row) => row.title === changed.title)!.id;
    const beforeConflict = globalThis.fetch;
    let sourceReads = 0;
    let updateStatus = 0;
    let conflictError: unknown;
    try {
      globalThis.fetch = (async (url, options) => {
        if (String(url).endsWith(`/api/tickets/${sourceId}`) && (!options?.method || options.method === "GET")) {
          sourceReads++;
          if (sourceReads === 1) {
            const update = await beforeConflict(url, { method: "PUT", headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "Edited by UI" }) });
            updateStatus = update.status;
          }
        }
        return beforeConflict(url, options);
      }) as typeof fetch;
      try {
        await board.reclassifyTask({ taskId: changed.task_id, targetBoardProjectId: work.board_project_id,
          expectedSourceBoardProjectId: inbox.board_project_id, requestId: randomUUID() });
      } catch (error) { conflictError = error; }
    } finally { globalThis.fetch = beforeConflict; }
    assert.equal(updateStatus, 200);
    assert.equal((conflictError as { code?: string } | undefined)?.code, "TASK_TRANSFER_CONFLICT");
    assert.equal((await board.getTask(changed.task_id)).title, "Edited by UI");
    assert.equal((await board.listTasks({ boardProjectId: work.board_project_id })).length, 2);
    const afterCrash = await board.createTask({ title: "Crash after remap" });
    const crashId = randomUUID();
    const crashInput = { taskId: afterCrash.task_id, targetBoardProjectId: work.board_project_id,
      expectedSourceBoardProjectId: inbox.board_project_id, requestId: crashId };
    const crashService = new ProjectBoardService(state);
    const saveHook = crashService as unknown as {
      saveMetadata(metadata: { transfers: Record<string, { state: string }> }): Promise<void>;
    };
    const originalSave = saveHook.saveMetadata.bind(crashService);
    saveHook.saveMetadata = async (metadata: { transfers: Record<string, { state: string }> }) => {
      await originalSave(metadata);
      if (metadata.transfers[crashId]?.state === "activating") throw new Error("simulated adapter exit after remap");
    };
    await assert.rejects(crashService.reclassifyTask(crashInput), /simulated adapter exit after remap/);
    assert.equal((await new ProjectBoardService(state).getTransferStatus(crashId)).state, "activating");
    assert.equal((await new ProjectBoardService(state).reclassifyTask(crashInput)).state, "completed");
    assert.equal((await board.getTask(afterCrash.task_id)).board_project_id, work.board_project_id);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
