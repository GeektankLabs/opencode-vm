import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method });
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
    } else if (url.pathname.startsWith("/api/tickets/") && method === "GET") {
      value = rows.find((row) => row.id === url.pathname.slice("/api/tickets/".length));
      if (!value) status = 404;
    } else throw new Error(`Unexpected ${method} ${url.pathname}`);
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

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
    for (const raw of ["{broken", JSON.stringify({ schema: 2, projects: {}, tasks: {}, comments: {}, links: {} }),
      JSON.stringify({ schema: 1, projects: [], tasks: {}, comments: {}, links: {} })]) {
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
