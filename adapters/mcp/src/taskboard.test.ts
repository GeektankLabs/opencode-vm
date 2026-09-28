import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ProjectBoardService } from "./taskboard.js";
import type { RuntimeDescriptor } from "./types.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("taskboard adapter keeps stable task ids separate from backend ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-taskboard-"));
  const calls: Array<{ path: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: init?.method ?? "GET" });
    if (url.pathname === "/api/projects" && init?.method === "POST") return response({ id: "project-backend" }, 201);
    if (url.pathname === "/api/projects") return response([{ id: "project-backend", prefix: "OCTEST", name: "Test" }]);
    if (url.pathname === "/api/tickets" && init?.method === "POST") {
      return response({ id: "ticket-backend", projectId: "project-backend", title: "Ship", status: "todo", priority: "high" }, 201);
    }
    if (url.pathname === "/api/tickets") return response([{ id: "ticket-backend", projectId: "project-backend", title: "Ship", status: "todo", priority: "high" }]);
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
  try {
    const runtime = {
      schema: 1, project: directory, projectHash: "abcdef123456", projectName: "Test",
      backendUrl: "http://127.0.0.1:4095", generation: "generation", opencodeVersion: "test",
      listenHost: "127.0.0.1", listenPort: 40960, credentialFile: join(directory, "credential"),
      taskboardUrl: "http://127.0.0.1:4101", taskboardMetadataFile: join(directory, "taskboard.metadata.json"),
    } as RuntimeDescriptor & { taskboardUrl: string; taskboardMetadataFile: string };
    const service = new ProjectBoardService(runtime);
    const created = await service.createTask({ title: "Ship", priority: "high" });
    assert.notEqual(created.task_id, "ticket-backend");
    assert.equal(created.project_id, "project_abcdef123456");
    const listed = await service.listTasks();
    assert.equal(listed[0]?.task_id, created.task_id);
    const metadata = JSON.parse(await readFile(runtime.taskboardMetadataFile, "utf8"));
    assert.equal(metadata.tasks[created.task_id].backend_id, "ticket-backend");
    assert.ok(calls.some((call) => call.path === "/api/tickets" && call.method === "POST"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
