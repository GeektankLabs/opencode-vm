import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionV2Info } from "@opencode-ai/sdk/v2";
import { OpenCodeGateway } from "./opencode.js";
import { AdapterError } from "./types.js";
import type { RuntimeDescriptor } from "./types.js";

const project = "/project";

function runtime(managerFile?: string): RuntimeDescriptor {
  return {
    schema: 1,
    project,
    projectHash: "project-hash",
    projectName: "project-name",
    backendUrl: "http://127.0.0.1:4095",
    generation: "test-generation",
    opencodeVersion: "1.18.21",
    listenHost: "127.0.0.1",
    listenPort: 40960,
    credentialFile: "/credential",
    ...(managerFile ? { managerFile } : {}),
  };
}

function session(
  id: string,
  changes: Partial<SessionV2Info> = {},
): SessionV2Info {
  return {
    id,
    projectID: "project-id",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1, updated: 2 },
    title: id,
    location: { directory: project },
    agent: "build",
    model: { providerID: "provider", id: "model", variant: "high" },
    ...changes,
  };
}

type FakeState = {
  sessions: SessionV2Info[];
  statuses: Record<string, { type: "idle" | "busy" | "retry" }>;
  messages: Array<{
    info: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
  permissions: Array<Record<string, unknown>>;
  questions: Array<Record<string, unknown>>;
  promptCalls: Array<Record<string, unknown>>;
  promptAsync?: (parameters: Record<string, unknown>) => Promise<unknown>;
};

function fakeClient(state: FakeState) {
  return {
    global: {
      async health() {
        return { data: { healthy: true } };
      },
    },
    project: {
      async current() {
        return { data: { id: "project-id", worktree: project } };
      },
    },
    v2: {
      session: {
        async list(parameters: { cursor?: string; limit?: number }) {
          const start = parameters.cursor ? Number(parameters.cursor) : 0;
          const limit = parameters.limit ?? 20;
          const data = state.sessions.slice(start, start + limit);
          const next =
            start + limit < state.sessions.length
              ? String(start + limit)
              : undefined;
          return { data: { data, cursor: next ? { next } : {} } };
        },
        async get(parameters: { sessionID: string }) {
          const found = state.sessions.find(
            (item) => item.id === parameters.sessionID,
          );
          if (!found)
            throw Object.assign(new Error("not found"), { status: 404 });
          return { data: { data: found } };
        },
        permission: {
          async list() {
            return { data: { data: state.permissions } };
          },
        },
        question: {
          async list() {
            return { data: { data: state.questions } };
          },
        },
      },
    },
    session: {
      async status() {
        return { data: state.statuses };
      },
      async messages(parameters: { limit: number; before?: string }) {
        let end = state.messages.length;
        if (parameters.before) {
          const match = /^opaque\.(\d+)$/u.exec(parameters.before);
          if (!match)
            throw Object.assign(new Error("bad cursor"), { status: 400 });
          end = Number(match[1]);
        }
        const start = Math.max(0, end - parameters.limit);
        const next = start > 0 ? `opaque.${start}` : undefined;
        return {
          data: state.messages.slice(start, end),
          response: {
            headers: new Headers(next ? { "x-next-cursor": next } : {}),
          },
        };
      },
      async promptAsync(parameters: Record<string, unknown>) {
        state.promptCalls.push(parameters);
        return state.promptAsync?.(parameters);
      },
    },
  };
}

function baseState(sessions = [session("ses_work")]): FakeState {
  return {
    sessions,
    statuses: {},
    messages: [],
    permissions: [],
    questions: [],
    promptCalls: [],
  };
}

test("session listing and direct lookup enforce all exposure rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-mcp-manager-"));
  const managerFile = join(directory, "manager.json");
  await writeFile(
    managerFile,
    JSON.stringify({ schema: 1, project, sessionId: "ses_manager_file" }),
    { mode: 0o600 },
  );
  const state = baseState([
    session("ses_work"),
    session("ses_foreign_project", { projectID: "other" }),
    session("ses_foreign_directory", { location: { directory: "/other" } }),
    session("ses_child", { parentID: "ses_work" }),
    session("ses_archived", { time: { created: 1, updated: 2, archived: 3 } }),
    session("ses_manager_agent", { agent: "openlive-manager" }),
    session("ses_manager_file"),
  ]);
  state.statuses.ses_work = { type: "busy" };
  const gateway = new OpenCodeGateway(
    runtime(managerFile),
    fakeClient(state) as never,
  );

  assert.deepEqual(await gateway.listSessions(), {
    project: { id: "project-hash", name: "project-name" },
    sessions: [
      {
        id: "ses_work",
        title: "ses_work",
        created: 1,
        updated: 2,
        activity: "busy",
      },
    ],
    truncated: false,
  });
  for (const id of [
    "ses_foreign_project",
    "ses_foreign_directory",
    "ses_child",
    "ses_archived",
    "ses_manager_agent",
    "ses_manager_file",
    "ses_missing",
  ]) {
    await assert.rejects(
      gateway.getSessionDetails(id),
      (error) =>
        error instanceof AdapterError && error.code === "SESSION_NOT_FOUND",
    );
  }
});

test("adapter cursors do not skip eligible sessions inside a backend page", async () => {
  const state = baseState(
    Array.from({ length: 12 }, (_, index) => session(`ses_${index}`)),
  );
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);

  const first = await gateway.listSessions(5);
  assert.deepEqual(
    first.sessions.map((item) => item.id),
    ["ses_0", "ses_1", "ses_2", "ses_3", "ses_4"],
  );
  await assert.rejects(
    gateway.listSessions(5, "not-a-valid-cursor"),
    (error) =>
      error instanceof AdapterError && error.code === "INVALID_ARGUMENT",
  );
  assert.equal(first.truncated, true);
  assert.ok(first.next_cursor);
  const second = await gateway.listSessions(5, first.next_cursor);
  assert.deepEqual(
    second.sessions.map((item) => item.id),
    ["ses_5", "ses_6", "ses_7", "ses_8", "ses_9"],
  );
});

test("a session deleted after listing stays non-disclosing", async () => {
  const state = baseState();
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  assert.deepEqual(
    (await gateway.listSessions()).sessions.map((item) => item.id),
    ["ses_work"],
  );
  state.sessions = [];
  await assert.rejects(
    gateway.getSessionDetails("ses_work"),
    (error) =>
      error instanceof AdapterError && error.code === "SESSION_NOT_FOUND",
  );
});

test("history returns only bounded user and assistant text", async () => {
  const state = baseState();
  state.messages = [
    {
      info: {
        id: "msg_user",
        sessionID: "ses_work",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [
        { id: "p1", type: "text", text: "u".repeat(20_000) },
        { id: "p2", type: "file", url: "secret" },
      ],
    },
    {
      info: {
        id: "msg_assistant",
        sessionID: "ses_work",
        role: "assistant",
        parentID: "msg_user",
        time: { created: 2, completed: 3 },
        finish: "stop",
      },
      parts: [
        { id: "p3", type: "reasoning", text: "hidden reasoning" },
        { id: "p4", type: "text", text: "a".repeat(20_000) },
      ],
    },
    {
      info: { id: "msg_other", role: "system", time: { created: 3 } },
      parts: [{ id: "p5", type: "text", text: "hidden system" }],
    },
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);

  const result = await gateway.getSessionHistory("ses_work", 10);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.text.length, 20_000);
  assert.equal(result.messages[1]?.text.length, 12_000);
  assert.equal(result.messages[1]?.text_truncated, true);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|reasoning|system/u);
});

test("history returns newest bounded pages and follows opaque cursors", async () => {
  const state = baseState();
  state.messages = Array.from({ length: 5 }, (_, index) => ({
    info: {
      id: `msg_${index}`,
      sessionID: "ses_work",
      role: "user",
      time: { created: index + 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
    parts: [{ id: `part_${index}`, type: "text", text: String(index) }],
  }));
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);

  const newest = await gateway.getSessionHistory("ses_work", 2);
  assert.deepEqual(
    newest.messages.map((message) => message.id),
    ["msg_3", "msg_4"],
  );
  assert.equal(newest.next_before, "opaque.3");
  assert.equal(newest.truncated, true);

  const older = await gateway.getSessionHistory(
    "ses_work",
    2,
    newest.next_before,
  );
  assert.deepEqual(
    older.messages.map((message) => message.id),
    ["msg_1", "msg_2"],
  );
  assert.equal(older.next_before, "opaque.1");

  const oldest = await gateway.getSessionHistory(
    "ses_work",
    2,
    older.next_before,
  );
  assert.deepEqual(
    oldest.messages.map((message) => message.id),
    ["msg_0"],
  );
  assert.equal(oldest.next_before, undefined);
  assert.equal(oldest.truncated, false);
});

test("correlated status requires terminal assistant evidence", async () => {
  const state = baseState();
  state.messages = [
    {
      info: {
        id: "msg_user",
        sessionID: "ses_work",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [],
    },
    {
      info: {
        id: "msg_assistant",
        sessionID: "ses_work",
        role: "assistant",
        parentID: "msg_user",
        time: { created: 2, completed: 3 },
        finish: "stop",
      },
      parts: [{ id: "part", type: "text", text: "done" }],
    },
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);

  assert.deepEqual(await gateway.getSessionStatus("ses_work", "msg_user"), {
    session_id: "ses_work",
    message_id: "msg_user",
    backend_activity: "idle",
    state: "completed",
    pending_input: { permissions: 0, questions: 0 },
    assistant_message_ids: ["msg_assistant"],
  });
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "msg_absent")).state,
    "unknown",
  );
  state.questions.push({
    id: "question",
    sessionID: "ses_work",
    questions: [],
    tool: { messageID: "msg_assistant", callID: "call" },
  });
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "msg_user")).state,
    "input_required",
  );
  state.questions.length = 0;
  state.messages[1]!.info.error = {
    name: "UnknownError",
    data: { message: "must remain private" },
  };
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "msg_user")).state,
    "failed",
  );
  state.messages[1]!.info.error = {
    name: "MessageAbortedError",
    data: { message: "aborted" },
  };
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "msg_user")).state,
    "aborted",
  );
  delete state.messages[1]!.info.error;
  for (const finish of ["stop", "length", "content-filter"]) {
    state.messages[1]!.info.finish = finish;
    assert.equal(
      (await gateway.getSessionStatus("ses_work", "msg_user")).state,
      "completed",
      finish,
    );
  }
  state.messages[1]!.info.finish = "error";
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "msg_user")).state,
    "failed",
  );
  for (const finish of ["tool-calls", "unknown", "future-value"]) {
    state.messages[1]!.info.finish = finish;
    assert.equal(
      (await gateway.getSessionStatus("ses_work", "msg_user")).state,
      "unknown",
      finish,
    );
  }
  state.messages[1]!.info.finish = "tool-calls";
  state.messages.push({
    info: {
      id: "msg_assistant_final",
      sessionID: "ses_work",
      role: "assistant",
      parentID: "msg_user",
      time: { created: 4, completed: 5 },
      finish: "stop",
    },
    parts: [],
  });
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "msg_user")).state,
    "completed",
  );
});

test("submission refuses busy sessions and pending input before admission", async () => {
  const state = baseState();
  state.statuses.ses_work = { type: "busy" };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await assert.rejects(
    gateway.sendMessage("ses_work", "busy"),
    (error) => error instanceof AdapterError && error.code === "SESSION_BUSY",
  );
  state.statuses = {};
  state.permissions.push({
    id: "permission",
    sessionID: "ses_work",
    action: "bash",
    resources: ["*"],
  });
  await assert.rejects(
    gateway.sendMessage("ses_work", "pending"),
    (error) => error instanceof AdapterError && error.code === "INPUT_REQUIRED",
  );
  assert.equal(state.promptCalls.length, 0);
});

test("submission timeout is uncertain, is never retried, and blocks concurrency", async () => {
  const state = baseState();
  let rejectAdmission: ((error: Error) => void) | undefined;
  state.promptAsync = () =>
    new Promise((_, reject) => {
      rejectAdmission = reject;
    });
  const gateway = new OpenCodeGateway(
    runtime(),
    fakeClient(state) as never,
    1_000,
    1_000,
  );

  const first = gateway.sendMessage("ses_work", "first");
  while (!rejectAdmission)
    await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    gateway.sendMessage("ses_work", "second"),
    (error) => error instanceof AdapterError && error.code === "SESSION_BUSY",
  );
  rejectAdmission(new Error("connection lost"));
  await assert.rejects(
    first,
    (error) =>
      error instanceof AdapterError &&
      error.code === "SUBMISSION_UNCERTAIN" &&
      error.correlationId?.startsWith("msg_") === true,
  );
  assert.equal(state.promptCalls.length, 1);
  await assert.rejects(
    gateway.sendMessage("ses_work", "third"),
    (error) => error instanceof AdapterError && error.code === "SESSION_BUSY",
  );
  assert.equal(state.promptCalls.length, 1);
});

test("simultaneous submissions serialize before unresolved reconciliation", async () => {
  const state = baseState();
  state.promptAsync = async () => undefined;
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const first = await gateway.sendMessage("ses_work", "first");
  state.messages = [
    {
      info: {
        id: first.message_id,
        sessionID: "ses_work",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
      parts: [],
    },
    {
      info: {
        id: "msg_answer",
        sessionID: "ses_work",
        role: "assistant",
        parentID: first.message_id,
        time: { created: 2, completed: 3 },
        finish: "stop",
      },
      parts: [],
    },
  ];

  const attempts = await Promise.allSettled([
    gateway.sendMessage("ses_work", "second"),
    gateway.sendMessage("ses_work", "simultaneous"),
  ]);
  const admitted = attempts.filter(
    (
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<typeof gateway.sendMessage>>
    > => result.status === "fulfilled",
  );
  const rejected = attempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(admitted.length, 1);
  assert.match(admitted[0]!.value.message_id, /^msg_[a-f0-9]{32}$/u);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof AdapterError);
  assert.equal(rejected[0]!.reason.code, "SESSION_BUSY");
  assert.equal(state.promptCalls.length, 2);
  assert.equal((state.promptCalls[0]?.parts as unknown[]).length, 1);
});

test("submissions to different sessions proceed independently", async () => {
  const state = baseState([session("ses_one"), session("ses_two")]);
  const releases: Array<() => void> = [];
  state.promptAsync = () =>
    new Promise((resolve) => {
      releases.push(() => resolve(undefined));
    });
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);

  const first = gateway.sendMessage("ses_one", "first");
  while (state.promptCalls.length < 1)
    await new Promise((resolve) => setImmediate(resolve));
  const second = gateway.sendMessage("ses_two", "second");
  while (state.promptCalls.length < 2)
    await new Promise((resolve) => setImmediate(resolve));

  releases.forEach((release) => release());
  const receipts = await Promise.all([first, second]);
  assert.deepEqual(
    receipts.map((receipt) => receipt.session_id),
    ["ses_one", "ses_two"],
  );
  assert.equal(state.promptCalls.length, 2);
});
