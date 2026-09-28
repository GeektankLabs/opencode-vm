import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpHttpServer } from "./http.js";
import { READ_RESPONSE_BYTES, READ_PAYLOAD_BYTES } from "./content.js";
import type { SessionV2Info } from "@opencode-ai/sdk/v2";
import { OpenCodeGateway } from "./opencode.js";
import { AdapterError } from "./types.js";
import type { RuntimeDescriptor, TaskResult } from "./types.js";
import type { SubmissionGuardOverrideInput } from "./types.js";

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
  config: { default_agent?: string; model?: string };
  agents: Array<{
    name: string;
    mode: string;
    hidden?: boolean;
    model?: { providerID: string; modelID: string };
    variant?: string;
  }>;
  providers: {
    all: Array<{ id: string; models: Record<string, object> }>;
    connected: string[];
    default: Record<string, string>;
  };
  createCalls: Array<Record<string, unknown>>;
  runtimeCalls: Array<Record<string, unknown>>;
  archiveCalls: Array<Record<string, unknown>>;
  renameCalls: Array<Record<string, unknown>>;
  archive?: (parameters: Record<string, unknown>) => Promise<unknown>;
  rename?: (parameters: Record<string, unknown>) => Promise<unknown>;
  create?: (
    parameters: Record<string, unknown>,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
};

function fakeClient(state: FakeState) {
  return {
    config: {
      async get() {
        return { data: state.config };
      },
    },
    app: {
      async agents() {
        return { data: state.agents };
      },
    },
    provider: {
      async list() {
        return { data: state.providers };
      },
    },
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
      model: {
        async list() {
          return {
            data: {
              data: state.providers.all.flatMap((provider) =>
                Object.entries(provider.models).map(([id, value]) => ({
                  id,
                  providerID: provider.id,
                  name: id,
                  enabled: true,
                  variants: Object.keys(
                    (value as { variants?: object }).variants ?? {},
                  ).map((id) => ({ id })),
                })),
              ),
            },
          };
        },
      },
      session: {
        async switchAgent(parameters: { sessionID: string; agent: string }) {
          state.runtimeCalls.push(parameters);
          state.sessions.find(
            (item) => item.id === parameters.sessionID,
          )!.agent = parameters.agent;
          return { data: {} };
        },
        async switchModel(parameters: {
          sessionID: string;
          model: NonNullable<SessionV2Info["model"]>;
        }) {
          state.runtimeCalls.push(parameters);
          state.sessions.find(
            (item) => item.id === parameters.sessionID,
          )!.model = parameters.model;
          return { data: {} };
        },
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
          async list(parameters: { sessionID: string }) {
            return {
              data: {
                data: state.permissions.filter(
                  (item) =>
                    !item.sessionID || item.sessionID === parameters.sessionID,
                ),
              },
            };
          },
        },
        question: {
          async list(parameters: { sessionID: string }) {
            return {
              data: {
                data: state.questions.filter(
                  (item) =>
                    !item.sessionID || item.sessionID === parameters.sessionID,
                ),
              },
            };
          },
        },
      },
    },
    session: {
      async update(parameters: Record<string, unknown>) {
        const found = state.sessions.find(
          (item) => item.id === parameters.sessionID,
        );
        if (!found)
          throw Object.assign(new Error("not found"), { status: 404 });
        if (typeof parameters.title === "string") {
          state.renameCalls.push(parameters);
          if (state.rename) return state.rename(parameters);
          found.title = parameters.title;
          return { data: found };
        }
        state.archiveCalls.push(parameters);
        if (state.archive) return state.archive(parameters);
        found.time = {
          ...found.time,
          archived: (parameters.time as { archived: number }).archived,
        };
        return { data: found };
      },
      async message(
        parameters: { sessionID: string; messageID: string },
        _options?: { signal?: AbortSignal },
      ) {
        const item = state.messages.find(
          (message) =>
            message.info.id === parameters.messageID &&
            (!message.info.sessionID ||
              message.info.sessionID === parameters.sessionID),
        );
        if (!item) throw Object.assign(new Error("absent"), { status: 404 });
        return {
          data: {
            ...item,
            info: { ...item.info, sessionID: parameters.sessionID },
          },
        };
      },
      async create(
        parameters: Record<string, unknown>,
        options: { signal: AbortSignal },
      ) {
        state.createCalls.push(parameters);
        if (state.create) return state.create(parameters, options);
        const model = parameters.model as NonNullable<SessionV2Info["model"]>;
        const created = session("ses_created", {
          title: parameters.title as string,
          agent: parameters.agent as string,
          model: { ...model, variant: model.variant ?? "default" },
        });
        state.sessions.push(created);
        return { data: { id: created.id } };
      },
      async status() {
        return { data: state.statuses };
      },
      async messages(parameters: {
        sessionID: string;
        limit: number;
        before?: string;
      }) {
        const messages = state.messages.filter(
          (item) =>
            !item.info.sessionID ||
            item.info.sessionID === parameters.sessionID,
        );
        let end = messages.length;
        if (parameters.before) {
          const match = /^opaque\.(\d+)$/u.exec(parameters.before);
          if (!match)
            throw Object.assign(new Error("bad cursor"), { status: 400 });
          end = Number(match[1]);
        }
        const start = Math.max(0, end - parameters.limit);
        const next = start > 0 ? `opaque.${start}` : undefined;
        return {
          data: messages.slice(start, end),
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

async function enableTestJournal(
  t: TestContext,
  gateway: OpenCodeGateway,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-guard-override-"));
  const path = join(directory, "activity.json");
  await gateway.enableActivity(path);
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

async function unresolvedFixture(
  t: TestContext,
  state = baseState(),
): Promise<{
  state: FakeState;
  gateway: OpenCodeGateway;
  journalPath: string;
  guardedMessageId: string;
}> {
  state.promptAsync = async (parameters) => {
    const user = stored(parameters.messageID as string, "original request");
    user.info.sessionID = parameters.sessionID;
    state.messages.push(user);
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const journalPath = await enableTestJournal(t, gateway);
  const receipt = await gateway.sendMessage("ses_work", "original request");
  return {
    state,
    gateway,
    journalPath,
    guardedMessageId: receipt.message_id,
  };
}

function overrideInput(
  guardedMessageId: string,
  changes: Partial<SubmissionGuardOverrideInput> = {},
): SubmissionGuardOverrideInput {
  return {
    sessionId: "ses_work",
    guardedMessageId,
    requestId: "11111111-1111-4111-8111-111111111111",
    operatorAuthorized: true,
    reason: "Reviewed this exact unresolved receipt; continue once.",
    message: "approved follow-up request",
    ...changes,
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
    config: { default_agent: "plan", model: "provider/model" },
    agents: [
      { name: "build", mode: "primary" },
      { name: "plan", mode: "primary" },
    ],
    providers: {
      all: [
        {
          id: "provider",
          models: { model: { variants: { high: {}, medium: {} } } },
        },
      ],
      connected: ["provider"],
      default: { provider: "model" },
    },
    createCalls: [],
    runtimeCalls: [],
    archiveCalls: [],
    renameCalls: [],
  };
}

function stored(
  id: string,
  text: string,
  parent?: string,
  finish = "stop",
): FakeState["messages"][number] {
  return {
    info: {
      id,
      sessionID: "ses_work",
      role: parent ? "assistant" : "user",
      time: { created: 1, ...(parent ? { completed: 2 } : {}) },
      ...(parent ? { parentID: parent, finish } : {}),
    },
    parts: [{ id: `part_${id}`, type: "text", text }],
  };
}

function progressPart(
  call: string,
  status: string,
  start?: number,
  end?: number,
): Record<string, unknown> {
  return {
    type: "tool",
    callID: call,
    tool: "proxmox_create_vm",
    state: {
      status,
      ...(start !== undefined || end !== undefined
        ? { time: { start, end } }
        : {}),
      title: "B_PRIVATE_TITLE",
      input: { token: "B_PRIVATE_ARGUMENT" },
      output: "B_PRIVATE_OUTPUT",
      error: "B_PRIVATE_ERROR",
      metadata: { password: "B_PRIVATE_METADATA", exit: 1 },
    },
  };
}

test("Delivery B: progress exposes only observed tool metadata and exact task correlation", async () => {
  const state = baseState();
  const stepA = stored("stepA", "B_PRIVATE_TEXT", "userA", "tool-calls");
  stepA.parts = [
    progressPart("waiting", "pending"),
    progressPart("running", "running", 30),
    progressPart("done", "completed", 10, 20),
    progressPart("error", "error", 22, 25),
    { type: "reasoning", text: "B_PRIVATE_REASONING" },
  ];
  const stepB = stored("stepB", "", "userB", "tool-calls");
  stepB.parts = [progressPart("other-task", "running", 50)];
  state.messages = [
    stored("userA", "B_PRIVATE_PROMPT"),
    stepA,
    stored("userB", "next"),
    stepB,
  ];
  state.statuses.ses_work = { type: "busy" };
  state.questions = [{ sessionID: "ses_work", tool: { messageID: "stepB" } }];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const progress = await gateway.getSessionProgress("ses_work", "userA");
  assert.equal(progress.source, "backend_snapshot");
  assert.ok(progress.observed_at);
  assert.deepEqual(
    progress.in_flight_tools.map((tool) => tool.call_id),
    ["running", "waiting"],
  );
  assert.ok(
    progress.in_flight_tools.every((tool) => tool.task_message_id === "userA"),
  );
  assert.equal(progress.in_flight_tools[0]?.started_at, 30);
  assert.equal(progress.in_flight_tools[1]?.started_at, undefined);
  assert.equal(progress.last_finished_tool?.call_id, "error");
  assert.equal(progress.last_finished_tool?.status, "error");
  assert.equal(progress.last_finished_tool?.finished_at, 25);
  assert.equal(progress.last_activity_at, 30);
  assert.equal(progress.pending_input.questions, 1);
  assert.equal(progress.pending_input_scope, "session");
  assert.equal(progress.idle_with_in_flight_tools, false);
  assert.equal(progress.coverage.metadata_incomplete, false);
  assert.doesNotMatch(
    JSON.stringify(progress),
    /B_PRIVATE|password|exit|percent|success/u,
  );
  const all = await gateway.getSessionProgress("ses_work");
  assert.equal(all.in_flight_tools.length, 3);
  assert.equal(all.last_activity_at, 50);
  state.statuses.ses_work = { type: "idle" };
  assert.equal(
    (await gateway.getSessionProgress("ses_work")).idle_with_in_flight_tools,
    true,
  );
  stepA.parts = [progressPart("done", "completed", 10, 20)];
  const completed = await gateway.getSessionProgress("ses_work", "userA");
  assert.equal(completed.last_finished_tool?.status, "completed"); // metadata.exit=1 is not promoted into a guessed success/failure
  assert.equal(completed.in_flight_tools.length, 0);
  assert.equal(state.promptCalls.length, 0);
});

test("Delivery B: parallel-tool caps, history bounds and missing metadata stay explicit", async () => {
  const state = baseState();
  const step = stored("step", "", "user", "tool-calls");
  step.parts = Array.from({ length: 12 }, (_, i) =>
    progressPart(`call${i}`, "running", 100 + i),
  );
  state.messages = [stored("user", "task"), step];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const capped = await gateway.getSessionProgress("ses_work", "user");
  assert.equal(capped.coverage.in_flight_total, 12);
  assert.equal(capped.coverage.in_flight_truncated, true);
  assert.equal(capped.in_flight_tools.length, 10);
  assert.equal(capped.in_flight_tools[0]?.started_at, 111);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) < READ_PAYLOAD_BYTES);
  step.info.parentID = "";
  step.parts = [
    progressPart("unattributed", "pending"),
    progressPart("badtime", "running", NaN),
    progressPart("future", "new-backend-state"),
  ];
  const incomplete = await gateway.getSessionProgress("ses_work");
  assert.equal(incomplete.coverage.unattributed_tools, 3);
  assert.equal(incomplete.coverage.metadata_incomplete, true);
  assert.ok(
    incomplete.in_flight_tools.every(
      (tool) => tool.task_message_id === undefined,
    ),
  );
  assert.equal(
    (await gateway.getSessionProgress("ses_work", "user")).in_flight_tools
      .length,
    0,
  );
  state.messages.push(
    ...Array.from({ length: 105 }, (_, i) => stored(`new${i}`, "newer task")),
  );
  const bounded = await gateway.getSessionProgress("ses_work", "user");
  assert.equal(bounded.coverage.history_has_more, true);
  assert.equal(bounded.coverage.messages_scanned, 100);
  assert.equal(bounded.last_activity_at, undefined);
  assert.equal(bounded.in_flight_tools.length, 0);
  await assert.rejects(gateway.getSessionProgress("ses_work", "step"), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(gateway.getSessionProgress("ses_work", "absent"), {
    code: "MESSAGE_NOT_FOUND",
  });
  state.sessions[0]!.time.archived = 3;
  await assert.rejects(gateway.getSessionProgress("ses_work"), {
    code: "SESSION_NOT_FOUND",
  });
});

test("Delivery A: original UTF-8 content is fully reconstructible independent of history size", async () => {
  const state = baseState();
  const text =
    'ÄÖß👩🏽‍💻\n```ts\nconst value = "\\path";\n```\n'.repeat(6000) +
    "END-OF-REPORT";
  assert.ok(Buffer.byteLength(text) >= 200 * 1024);
  state.messages = [
    stored("user", "task"),
    stored("report", text, "user"),
    stored("following", "following user"),
  ];
  const splitAt = text.indexOf("```ts", 1000);
  state.messages[1]!.parts[0]!.text = text.slice(0, splitAt);
  // Preserve selected part order; never include hidden, ignored or synthetic text.
  state.messages[1]!.parts.push(
    { type: "reasoning", text: "hidden-reasoning-secret" },
    { type: "text", text: text.slice(splitAt) },
    { type: "text", text: "synthetic-secret", synthetic: true },
    { type: "text", text: "ignored-secret", ignored: true },
  );
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const overview = await gateway.getSessionHistory("ses_work", 20);
  assert.equal(overview.history_has_more, false);
  assert.equal(overview.truncated, true);
  assert.equal(overview.messages.at(-1)?.text, "following user");
  const latest = await gateway.getSessionHistory("ses_work", 1);
  const reportPage = await gateway.getSessionHistory(
    "ses_work",
    1,
    latest.next_before,
  );
  const report = (await gateway.getMessage("ses_work", "report")).message;
  assert.equal(
    report.content?.content_ref,
    reportPage.messages[0]?.content?.content_ref,
  );
  assert.equal(
    report.content?.revision,
    overview.messages[1]?.content?.revision,
  );
  assert.equal(report.truncation_reason, "preview_limit");
  const ref = report.content!.content_ref;
  let cursor: string | undefined;
  let reconstructed = "";
  let count = 0;
  do {
    const part = await gateway.readMessageContent(ref, cursor, 777);
    assert.equal(part.range.start, Buffer.byteLength(reconstructed));
    assert.ok(Buffer.byteLength(part.text) <= 777);
    assert.ok(part.text.isWellFormed());
    reconstructed += part.text;
    assert.equal(part.range.end, Buffer.byteLength(reconstructed));
    assert.equal(part.sha256, report.content!.sha256);
    assert.equal(part.has_more, Boolean(part.next_cursor));
    cursor = part.next_cursor;
    count++;
  } while (cursor);
  assert.ok(count > 1);
  assert.equal(reconstructed, text);
  assert.equal(
    createHash("sha256").update(reconstructed).digest("hex"),
    report.content!.sha256,
  );
  assert.equal(state.promptCalls.length, 0);
  assert.doesNotMatch(
    JSON.stringify(overview),
    /hidden-reasoning-secret|synthetic-secret|ignored-secret/u,
  );
});

test("Delivery A: revisions, invalid/future references and missing sources fail explicitly", async () => {
  const state = baseState();
  state.messages = [
    stored("report", "😀abcdef".repeat(100), "user", "length"),
    stored("other", "other"),
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const report = (await gateway.getMessage("ses_work", "report")).message;
  assert.equal(report.finish, "length");
  const ref = report.content!.content_ref;
  const first = await gateway.readMessageContent(ref, undefined, 4);
  assert.equal(first.text, "😀");
  const other = (await gateway.getMessage("ses_work", "other")).message.content!
    .content_ref;
  await assert.rejects(gateway.readMessageContent(other, first.next_cursor), {
    code: "INVALID_ARGUMENT",
  });
  const [body, signature] = ref.split(".");
  const tampered = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(body!, "base64url").toString()),
      message: "other",
    }),
  ).toString("base64url");
  await assert.rejects(gateway.readMessageContent(`${tampered}.${signature}`), {
    code: "INVALID_ARGUMENT",
  });
  state.messages[0]!.parts[0]!.text += "changed";
  await assert.rejects(gateway.readMessageContent(ref, first.next_cursor), {
    code: "CONTENT_CHANGED",
  });
  const changed = (await gateway.getMessage("ses_work", "report")).message;
  assert.notEqual(changed.content!.revision, report.content!.revision);
  state.messages.shift();
  await assert.rejects(
    gateway.readMessageContent(changed.content!.content_ref),
    { code: "CONTENT_UNAVAILABLE" },
  );
  await assert.rejects(gateway.getMessage("ses_work", "report"), {
    code: "MESSAGE_NOT_FOUND",
  });
  const restarted = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await assert.rejects(restarted.readMessageContent(other), {
    code: "READ_REFERENCE_EXPIRED",
  });
});

test("Delivery A: all read paths recheck session confinement, including previously issued references", async () => {
  const state = baseState();
  state.messages = [stored("user", "task"), stored("report", "answer", "user")];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const ref = (await gateway.getMessage("ses_work", "report")).message.content!
    .content_ref;
  for (const changes of [
    { parentID: "parent" },
    { agent: "openlive-manager" },
    { projectID: "foreign" },
    { location: { directory: "/foreign" } },
    { time: { created: 1, updated: 2, archived: 3 } },
  ]) {
    state.sessions[0] = session("ses_work", changes);
    await assert.rejects(gateway.getMessage("ses_work", "report"), {
      code: "SESSION_NOT_FOUND",
    });
    await assert.rejects(gateway.readMessageContent(ref), {
      code: "SESSION_NOT_FOUND",
    });
    await assert.rejects(gateway.getTaskResult("ses_work", "user"), {
      code: "SESSION_NOT_FOUND",
    });
  }
  state.sessions[0] = session("ses_work");
  state.messages[1]!.info.sessionID = "ses_other";
  await assert.rejects(gateway.getMessage("ses_work", "report"), {
    code: "MESSAGE_NOT_FOUND",
  });
});

test("Delivery A: empty visible text is distinct from omitted tool content", async () => {
  const state = baseState();
  const step = stored("step", "", "user", "tool-calls");
  step.parts = [
    {
      type: "tool",
      state: {
        output: "output-secret",
        input: { password: "argument-secret" },
      },
    },
  ];
  state.messages = [stored("empty", ""), step];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const empty = await gateway.getMessage("ses_work", "empty");
  const omitted = await gateway.getMessage("ses_work", "step");
  assert.equal(empty.message.content!.availability, "empty");
  assert.equal(omitted.message.content!.availability, "not_exposed");
  assert.equal(omitted.message.text_truncated, false);
  assert.deepEqual(omitted.message.content!.omitted_parts, [
    { type: "tool", count: 1, reason: "part_not_exposed" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(omitted),
    /output-secret|argument-secret/u,
  );
  const read = await gateway.readMessageContent(
    omitted.message.content!.content_ref,
  );
  assert.equal(read.text, "");
  assert.equal(read.has_more, false);
  assert.equal(read.content_complete, true); // complete visible projection, not hidden parts
});

test("Delivery A: bounded search recovers old tasks with 130 steps without confusing a later blocked task", async () => {
  const state = baseState();
  state.messages = [
    stored("user1", "old task"),
    ...Array.from({ length: 130 }, (_, i) =>
      stored(`step${i}`, "", "user1", "tool-calls"),
    ),
    stored("final1", "old report", "user1"),
    stored("user2", "new task"),
    stored("step2", "", "user2", "tool-calls"),
  ];
  state.questions = [
    { sessionID: "ses_work", tool: { messageID: "step2", callID: "call" } },
  ];
  state.statuses.ses_work = { type: "busy" };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "user1")).state,
    "unknown",
  );
  let cursor: string | undefined;
  const ids: string[] = [];
  let searches = 0;
  do {
    const result = await gateway.getTaskResult("ses_work", "user1", cursor, 20);
    ids.push(...result.messages.map((message) => message.id));
    assert.ok(
      result.messages.every((message) => message.parent_id === "user1"),
    );
    if (!result.search_complete) {
      assert.equal(result.state, "unknown");
      assert.equal(result.state_reason, "search_incomplete");
    } else assert.equal(result.state, "completed");
    cursor = result.next_cursor;
    searches++;
  } while (cursor);
  assert.ok(searches > 5);
  assert.equal(ids.length, 131);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], "final1");
  const second = await gateway.getTaskResult("ses_work", "user2");
  assert.equal(second.state, "unknown");
  assert.equal(second.state_reason, "non_terminal_evidence");
  state.messages.push(stored("final2", "new report", "user2"));
  assert.equal(
    (await gateway.getTaskResult("ses_work", "user2")).state,
    "completed",
  );
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "user2")).state,
    "input_required",
  ); // explicitly correlated pending input
  state.questions = [
    {
      sessionID: "ses_work",
      tool: { messageID: "later-task", callID: "call" },
    },
  ];
  assert.equal(
    (await gateway.getSessionStatus("ses_work", "user2")).state,
    "completed",
  );
  assert.equal(state.promptCalls.length, 0);
});

test("Delivery A: result cursors reject changed boundaries and query switches; empty pages remain resumable", async () => {
  const state = baseState();
  state.messages = [
    stored("user1", "old"),
    stored("final1", "answer", "user1"),
    ...Array.from({ length: 25 }, (_, i) => stored(`later${i}`, "later")),
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const first = await gateway.getTaskResult("ses_work", "user1");
  assert.equal(first.messages.length, 0);
  assert.equal(first.search_complete, false);
  assert.ok(first.next_cursor);
  await assert.rejects(
    gateway.getTaskResult("ses_work", "later1", first.next_cursor),
    { code: "INVALID_ARGUMENT" },
  );
  state.messages.at(-1)!.parts[0]!.text = "changed head";
  await assert.rejects(
    gateway.getTaskResult("ses_work", "user1", first.next_cursor),
    { code: "SEARCH_CHANGED" },
  );
  const again = await gateway.getTaskResult("ses_work", "user1");
  const final = await gateway.getTaskResult(
    "ses_work",
    "user1",
    again.next_cursor,
  );
  assert.equal(final.state, "completed");
  assert.equal(final.messages[0]?.id, "final1");
  await assert.rejects(gateway.getTaskResult("ses_work", "final1"), {
    code: "INVALID_ARGUMENT",
  });
});

test("uploads bind attachments to a session and send text/file parts only to capable models", async (t) => {
  const state = baseState([
    session("ses_work"),
    session("ses_other"),
    session("ses_text"),
  ]);
  const submittedParts = new Map<string, Array<Record<string, unknown>>>();
  state.promptAsync = async (parameters) => {
    submittedParts.set(
      parameters.sessionID as string,
      (parameters.parts as Array<Record<string, unknown>>).map((part) => ({
        ...part,
      })),
    );
    state.messages.push(stored(parameters.messageID as string, "task"));
    return {};
  };
  const client = fakeClient(state);
  let imageInput = false;
  client.v2.model.list = async () => ({
    data: {
      data: [
        {
          id: "model",
          providerID: "provider",
          name: "Model",
          enabled: true,
          variants: [],
          capabilities: { input: imageInput ? ["text", "image"] : ["text"] },
        },
      ],
    },
  });
  const gateway = new OpenCodeGateway(runtime(), client as never);
  t.after(() => gateway.close());

  const textBytes = Buffer.from(
    "# Launcher\nPlace it in the lower-left corner.\n",
  );
  const text = await gateway.uploadAttachment(
    "ses_work",
    "design.md",
    "text/markdown",
    textBytes.toString("base64"),
  );
  const plainText = await gateway.uploadAttachment(
    "ses_text",
    "notes.txt",
    "text/plain",
    textBytes.toString("base64"),
  );
  const textReceipt = await gateway.sendMessage(
    "ses_text",
    "Use these notes.",
    [plainText.attachment_id],
  );
  assert.equal(textReceipt.state, "submitted");
  assert.equal(
    submittedParts
      .get("ses_text")?.[1]
      ?.text?.toString()
      .includes("Place it in the lower-left corner."),
    true,
  );
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);
  const image = await gateway.uploadAttachment(
    "ses_work",
    "launcher-mockup.png",
    "image/png",
    png.toString("base64"),
  );

  await assert.rejects(
    gateway.sendMessage("ses_work", "Use this mockup.", ["/etc/passwd"]),
    { code: "INVALID_ATTACHMENT_REFERENCE" },
  );
  await assert.rejects(
    gateway.sendMessage("ses_other", "Use this mockup.", [text.attachment_id]),
    { code: "ATTACHMENT_ACCESS_DENIED" },
  );
  await assert.rejects(
    gateway.sendMessage("ses_work", "Use this mockup.", [image.attachment_id]),
    { code: "MODEL_DOES_NOT_SUPPORT_ATTACHMENT_TYPE" },
  );
  assert.equal(state.promptCalls.length, 1);

  imageInput = true;
  const receipt = await gateway.sendMessage("ses_work", "Use this mockup.", [
    text.attachment_id,
    image.attachment_id,
  ]);
  assert.equal(receipt.state, "submitted");
  assert.equal(receipt.message_id, state.promptCalls.at(-1)?.messageID);
  assert.deepEqual(
    receipt.attachments?.map(
      ({ attachment_id, filename, mime_type, size_bytes }) => ({
        attachment_id,
        filename,
        mime_type,
        size_bytes,
      }),
    ),
    [
      {
        attachment_id: text.attachment_id,
        filename: "design.md",
        mime_type: "text/markdown",
        size_bytes: textBytes.length,
      },
      {
        attachment_id: image.attachment_id,
        filename: "launcher-mockup.png",
        mime_type: "image/png",
        size_bytes: png.length,
      },
    ],
  );
  const submittedFileParts = submittedParts.get("ses_work") as Array<{
    type: string;
    text?: string;
    mime?: string;
    filename?: string;
    url?: string;
  }>;
  assert.deepEqual(
    submittedFileParts.map((part) => part.type),
    ["text", "text", "file"],
  );
  assert.ok(
    submittedFileParts[1]?.text?.includes("Place it in the lower-left corner."),
  );
  assert.equal(submittedFileParts[2]?.mime, "image/png");
  assert.equal(submittedFileParts[2]?.filename, "launcher-mockup.png");
  assert.equal(
    submittedFileParts[2]?.url,
    `data:image/png;base64,${png.toString("base64")}`,
  );
});

test("idle admission automatically reconciles an old completed receipt beyond the status window", async () => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "task"));
    return {};
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const receipt = await gateway.sendMessage("ses_work", "long task");
  state.messages.push(
    ...Array.from({ length: 110 }, (_, i) =>
      stored(`step-${i}`, "", receipt.message_id, "tool-calls"),
    ),
    stored("final", "done", receipt.message_id),
  );
  assert.equal((await gateway.getSessionDetails("ses_work")).activity, "idle");
  assert.equal(
    (await gateway.getSessionStatus("ses_work", receipt.message_id)).state,
    "unknown",
  );
  assert.equal(state.promptCalls.length, 1);
  await gateway.sendMessage("ses_work", "next");
  assert.equal(state.promptCalls.length, 2);
});

test("idle without terminal evidence does not block a new conversation turn", async () => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(
      stored(parameters.messageID as string, "old inventory"),
    );
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const receipt = await gateway.sendMessage("ses_work", "inventory");
  state.messages.push(
    ...Array.from({ length: 5 }, (_, i) =>
      stored(`iteration${i}`, "", receipt.message_id, "tool-calls"),
    ),
  );
  const before = await gateway.getSessionDetails("ses_work");
  assert.equal(before.activity, "idle");
  assert.equal(before.admission?.guarded_message_id, receipt.message_id);
  const result = await gateway.getTaskResult("ses_work", receipt.message_id);
  assert.equal(result.search_complete, true);
  assert.equal(result.messages.length, 5);
  assert.equal(result.state, "unknown");
  const next = await gateway.sendMessage("ses_work", "new implementation");
  assert.notEqual(next.message_id, receipt.message_id);
  assert.equal(state.promptCalls.length, 2);
  state.statuses.ses_work = { type: "busy" };
  const busy = await gateway.getSessionStatus("ses_work", receipt.message_id);
  assert.equal(busy.backend_activity, "busy");
  assert.equal(busy.state, "unknown");
  assert.equal(busy.task_status_reason, "non_terminal_evidence");
  assert.deepEqual(busy.active_assistant_message_ids, []);
  await assert.rejects(gateway.sendMessage("ses_work", "new implementation"), {
    code: "SESSION_BUSY",
    reason: "backend_active",
  });
  // Text generation can be active without any currently running tool.
  const generating = stored("generating", "", receipt.message_id, "unknown");
  generating.info.time = { created: 3 };
  state.messages.push(generating);
  const active = await gateway.getSessionStatus("ses_work", receipt.message_id);
  assert.equal(active.state, "running");
  assert.deepEqual(active.active_assistant_message_ids, ["generating"]);
  assert.equal(
    (await gateway.getSessionProgress("ses_work")).in_flight_tools.length,
    0,
  );
  assert.equal(state.promptCalls.length, 2);
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    next.message_id,
  );
});

test("a later latest completed user turn supersedes an older nonterminal MCP receipt without replay", async () => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "old request"));
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const oldReceipt = await gateway.sendMessage("ses_work", "first V2 task");
  state.messages.push(
    ...Array.from({ length: 5 }, (_, index) =>
      stored(`old-tool-step-${index}`, "", oldReceipt.message_id, "tool-calls"),
    ),
    ...Array.from({ length: 105 }, (_, index) =>
      stored(`later-note-${index}`, "unrelated subsequent user turn"),
    ),
    stored(
      "later-user",
      "Continue the V2 workstream and report PAUSED / WAITING.",
    ),
    stored("later-completed", "PAUSED / WAITING", "later-user", "stop"),
  );

  let oldResult: TaskResult;
  let cursor: string | undefined;
  do {
    oldResult = await gateway.getTaskResult(
      "ses_work",
      oldReceipt.message_id,
      cursor,
    );
    cursor = oldResult.next_cursor;
  } while (!oldResult.search_complete);
  assert.equal(oldResult.search_complete, true);
  assert.equal(oldResult.state, "unknown");
  assert.equal(oldResult.state_reason, "superseded_by_later_completed_turn");
  assert.equal(oldResult.superseded_by_message_id, "later-user");
  assert.equal(
    oldResult.messages.every(
      (message) => message.parent_id === oldReceipt.message_id,
    ),
    true,
    "the later result is evidence only, not merged into the old task's result",
  );

  const next = await gateway.sendMessage("ses_work", "new regular task");
  assert.notEqual(next.message_id, oldReceipt.message_id);
  assert.equal(state.promptCalls.length, 2, "only the new task is submitted");
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    next.message_id,
  );
});

test("an older unresolved turn does not block when the latest later user has no terminal response", async () => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "old request"));
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const oldReceipt = await gateway.sendMessage("ses_work", "old request");
  state.messages.push(
    ...Array.from({ length: 105 }, (_, index) =>
      stored(`note-${index}`, "later user note"),
    ),
    stored("completed-user", "older later turn"),
    stored("completed-assistant", "done", "completed-user", "stop"),
    stored("latest-unfinished-user", "newest user still has no answer"),
  );

  let result: TaskResult;
  let cursor: string | undefined;
  do {
    result = await gateway.getTaskResult(
      "ses_work",
      oldReceipt.message_id,
      cursor,
    );
    cursor = result.next_cursor;
  } while (!result.search_complete);
  assert.equal(result.search_complete, true);
  assert.equal(result.state, "unknown");
  assert.equal(result.superseded_by_message_id, undefined);
  assert.equal(result.state_reason, "no_terminal_evidence");
  const next = await gateway.sendMessage("ses_work", "continue normally");
  assert.notEqual(next.message_id, oldReceipt.message_id);
  assert.equal(state.promptCalls.length, 2);
});

test("guard override requires explicit attestation and refuses a possibly active backend", async (t) => {
  const { state, gateway, guardedMessageId } = await unresolvedFixture(t);
  const input = overrideInput(guardedMessageId);
  await assert.rejects(
    gateway.supersedeUnresolvedSubmission({
      ...input,
      operatorAuthorized: false as true,
    }),
    { code: "INVALID_ARGUMENT" },
  );
  state.statuses.ses_work = { type: "busy" };
  await assert.rejects(gateway.supersedeUnresolvedSubmission(input), {
    code: "SESSION_BUSY",
    reason: "backend_active",
  });
  state.statuses.ses_work = { type: "idle" };
  state.permissions.push({ sessionID: "ses_work", id: "permission" });
  await assert.rejects(gateway.supersedeUnresolvedSubmission(input), {
    code: "INPUT_REQUIRED",
    reason: "pending_input",
  });
  state.permissions = [];
  const unfinished = stored(
    "unfinished-assistant",
    "",
    guardedMessageId,
    "unknown",
  );
  unfinished.info.time = { created: 3 };
  state.messages.push(unfinished);
  await assert.rejects(gateway.supersedeUnresolvedSubmission(input), {
    code: "SESSION_BUSY",
    reason: "backend_active",
  });
  assert.equal(state.promptCalls.length, 1);
  assert.deepEqual(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    guardedMessageId,
  );
});

test("idle unresolved guard no longer blocks normal send; exact override remains explicit", async (t) => {
  const { state, gateway, guardedMessageId } = await unresolvedFixture(t);
  const normal = await gateway.sendMessage("ses_work", "normal continuation");
  assert.notEqual(normal.message_id, guardedMessageId);
  assert.equal(state.promptCalls.length, 2);
});

test("terminal reconciliation between guard inspection and override causes a stale conflict", async (t) => {
  const { state, gateway, guardedMessageId } = await unresolvedFixture(t);
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    guardedMessageId,
  );
  state.messages.push(
    stored("late-terminal", "original completed", guardedMessageId),
  );
  assert.equal(
    (await gateway.getSessionStatus("ses_work", guardedMessageId)).state,
    "completed",
  );
  await assert.rejects(
    gateway.supersedeUnresolvedSubmission(overrideInput(guardedMessageId)),
    { code: "SUBMISSION_GUARD_CONFLICT" },
  );
  assert.equal(state.promptCalls.length, 1);
});

test("override rejects a guarded_message_id that is not the exact active guard", async (t) => {
  const { state, gateway, guardedMessageId } = await unresolvedFixture(t);
  await assert.rejects(
    gateway.supersedeUnresolvedSubmission(overrideInput("msg_another_receipt")),
    { code: "SUBMISSION_GUARD_CONFLICT" },
  );
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    guardedMessageId,
  );
  assert.equal(state.promptCalls.length, 1);
});

test("successful override preserves unresolved history and writes an auditable activity event", async (t) => {
  const { state, gateway, journalPath, guardedMessageId } =
    await unresolvedFixture(t);
  const override = await gateway.supersedeUnresolvedSubmission(
    overrideInput(guardedMessageId, {
      requestId: "33333333-3333-4333-8333-333333333333",
    }),
  );
  const oldResult = await gateway.getTaskResult("ses_work", guardedMessageId);
  assert.equal(oldResult.state, "unknown");
  assert.deepEqual(oldResult.receipt_resolution, {
    state: "unresolved",
    resolution: "superseded_by_operator",
    superseded_at: override.superseded_at,
    superseded_by_request_id: override.request_id,
    superseded_by_message_id: override.message_id,
    reason: "Reviewed this exact unresolved receipt; continue once.",
  });
  assert.deepEqual(
    (await gateway.getSessionStatus("ses_work", guardedMessageId))
      .receipt_resolution,
    oldResult.receipt_resolution,
  );
  const audit = await gateway.getProjectActivity({
    event_types: ["submission.guard_overridden"],
  });
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0]?.session_id, "ses_work");
  assert.equal(audit.events[0]?.guarded_message_id, guardedMessageId);
  assert.equal(audit.events[0]?.message_id, override.message_id);
  assert.equal(audit.events[0]?.request_id, override.request_id);
  assert.equal(audit.events[0]?.operator_authorized, true);
  assert.equal(audit.events[0]?.authorization_source, "operator_asserted");
  assert.equal(audit.events[0]?.reason, overrideInput(guardedMessageId).reason);
  assert.ok(Date.parse(audit.events[0]!.timestamp) > 0);
  assert.equal(state.promptCalls.length, 2);
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    override.message_id,
  );
  const journal = await readFile(journalPath, "utf8");
  assert.match(journal, /submission\.guard_overridden/u);
  assert.doesNotMatch(journal, /approved follow-up request/u);
});

test("repeating an override request after adapter restart returns the same receipt without resubmitting", async (t) => {
  const { state, gateway, journalPath, guardedMessageId } =
    await unresolvedFixture(t);
  const input = overrideInput(guardedMessageId, {
    requestId: "44444444-4444-4444-8444-444444444444",
  });
  const first = await gateway.supersedeUnresolvedSubmission(input);
  await gateway.close();

  const restarted = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await restarted.enableActivity(journalPath);
  t.after(() => restarted.close());
  const repeated = await restarted.supersedeUnresolvedSubmission(input);
  assert.deepEqual(repeated, first);
  await assert.rejects(
    restarted.supersedeUnresolvedSubmission({
      ...input,
      message: "different content under the same request UUID",
    }),
    { code: "SUBMISSION_GUARD_CONFLICT" },
  );
  assert.equal(state.promptCalls.length, 2);
});

test("guard overrides are confined to the exact session and project", async (t) => {
  const state = baseState([
    session("ses_work"),
    session("ses_other"),
    session("ses_foreign", { projectID: "another-project" }),
  ]);
  state.promptAsync = async (parameters) => {
    const user = stored(parameters.messageID as string, "original request");
    user.info.sessionID = parameters.sessionID;
    state.messages.push(user);
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await enableTestJournal(t, gateway);
  const first = await gateway.sendMessage("ses_work", "work one");
  const other = await gateway.sendMessage("ses_other", "work two");
  await assert.rejects(
    gateway.supersedeUnresolvedSubmission(
      overrideInput(first.message_id, { sessionId: "ses_other" }),
    ),
    { code: "SUBMISSION_GUARD_CONFLICT" },
  );
  await assert.rejects(
    gateway.supersedeUnresolvedSubmission(
      overrideInput(first.message_id, { sessionId: "ses_foreign" }),
    ),
    { code: "SESSION_NOT_FOUND" },
  );
  const result = await gateway.supersedeUnresolvedSubmission(
    overrideInput(first.message_id),
  );
  assert.equal(result.session_id, "ses_work");
  assert.equal(
    (await gateway.getSessionDetails("ses_other")).admission
      ?.guarded_message_id,
    other.message_id,
  );
  assert.equal(state.promptCalls.length, 3);
});

test("a visible user receipt alone does not become running or input_required from session-wide signals", async () => {
  const state = baseState();
  state.messages = [stored("user", "task")];
  state.statuses.ses_work = { type: "busy" };
  state.questions = [
    { sessionID: "ses_work", tool: { messageID: "another_turn" } },
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const result = await gateway.getSessionStatus("ses_work", "user");
  assert.equal(result.state, "submitted");
  assert.equal(result.pending_input_scope, "session");
  assert.equal(result.pending_input.questions, 1);
  assert.deepEqual(result.active_assistant_message_ids, []);
});

test("stale receipts do not trigger historical admission searches", async () => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "task"));
  };
  const client = fakeClient(state);
  const gateway = new OpenCodeGateway(runtime(), client as never);
  const receipt = await gateway.sendMessage("ses_work", "old task");
  state.messages.push(
    ...Array.from({ length: 620 }, (_, i) =>
      stored(`step${i}`, "", receipt.message_id, "tool-calls"),
    ),
    stored("done", "finished", receipt.message_id),
  );
  const next = await gateway.sendMessage("ses_work", "next");
  assert.equal(state.promptCalls.length, 2);
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    next.message_id,
  );
});

test("stale receipt reads do not affect later prompt admission", async () => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "task"));
  };
  const client = fakeClient(state);
  const gateway = new OpenCodeGateway(runtime(), client as never);
  const receipt = await gateway.sendMessage("ses_work", "old");
  state.messages.push(
    ...Array.from({ length: 510 }, (_, i) =>
      stored(`step${i}`, "", receipt.message_id, "tool-calls"),
    ),
    stored("done", "report", receipt.message_id),
  );
  const firstNext = await gateway.sendMessage("ses_work", "next");
  state.messages.at(-1)!.parts[0]!.text = "changed report";
  const secondNext = await gateway.sendMessage("ses_work", "next again");
  const direct = client.session.message;
  client.session.message = async () => {
    throw new Error("PRIVATE BACKEND ERROR");
  };
  const thirdNext = await gateway.sendMessage("ses_work", "next despite stale read");
  assert.equal(state.promptCalls.length, 4);
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    thirdNext.message_id,
  );
  assert.notEqual(firstNext.message_id, secondNext.message_id);
  client.session.message = direct;
});

test("the MCP write lock still protects an in-flight prompt", async () => {
  const state = baseState();
  let release!: () => void;
  state.promptAsync = () => new Promise<void>((resolve) => { release = resolve; });
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const first = gateway.sendMessage("ses_work", "next");
  while (state.promptCalls.length < 1)
    await new Promise((resolve) => setImmediate(resolve));
  const pending = await gateway.getSessionDetails("ses_work");
  assert.equal(pending.activity, "idle");
  assert.equal(pending.admission?.write_in_progress, true);
  await assert.rejects(gateway.sendMessage("ses_work", "concurrent"), {
    code: "SESSION_BUSY",
    reason: "write_in_progress",
  });
  release();
  await first;
  assert.equal(state.promptCalls.length, 1);
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.write_in_progress,
    false,
  );
});

test("a late status read for an old task cannot retire a newer receipt", async () => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "task"));
  };
  const client = fakeClient(state);
  const gateway = new OpenCodeGateway(runtime(), client as never);
  const first = await gateway.sendMessage("ses_work", "first");
  state.messages.push(stored("done", "report", first.message_id));
  const messages = client.session.messages.bind(client.session);
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  client.session.messages = async (parameters) => {
    const result = await messages(parameters);
    if (!held && parameters.limit === 100) {
      held = true;
      entered();
      await gate;
    }
    return result;
  };
  const oldRead = gateway.getSessionStatus("ses_work", first.message_id);
  await entering;
  const second = await gateway.sendMessage("ses_work", "second");
  release();
  assert.equal((await oldRead).state, "completed");
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.guarded_message_id,
    second.message_id,
  );
  const third = await gateway.sendMessage("ses_work", "third");
  assert.notEqual(third.message_id, second.message_id);
  assert.equal(state.promptCalls.length, 3);
});

test("runtime changes reconcile old terminal receipts without sending work", async () => {
  for (const finish of ["stop", "abort", "error"]) {
    const state = baseState();
    state.promptAsync = async (parameters) => {
      state.messages.push(stored(parameters.messageID as string, "task"));
    };
    const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
    const receipt = await gateway.sendMessage("ses_work", "old");
    state.messages.push(
      ...Array.from({ length: 110 }, (_, i) =>
        stored(`step${i}`, "", receipt.message_id, "tool-calls"),
      ),
      stored("end", "", receipt.message_id, finish),
    );
    assert.equal(
      (await gateway.updateSessionRuntime("ses_work", { agent: "plan" })).state,
      "updated",
    );
    assert.equal(state.promptCalls.length, 1);
    assert.equal(
      (await gateway.getSessionDetails("ses_work")).admission
        ?.guarded_message_id,
      receipt.message_id,
    );
  }
});

test("Delivery A: full serialized MCP responses stay bounded, including escaped text and Unicode", async () => {
  const state = baseState();
  const text =
    "\u0000".repeat(20000) +
    '\u0000\u0001\n"\\😀'.repeat(10000) +
    "TAIL-MARKER";
  state.messages = [
    stored("user", "task"),
    stored("report", text, "user", "length"),
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const token = "fixture-token";
  const server = new McpHttpServer(
    { ...runtime(), listenPort: 0 },
    token,
    gateway,
  );
  const port = await server.start();
  const client = new Client({ name: "delivery-a", version: "1" });
  const wireSizes: number[] = [];
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    {
      requestInit: { headers: { "X-OCVM-MCP-Token": token } },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (response.headers.get("content-type")?.includes("application/json"))
          wireSizes.push((await response.clone().arrayBuffer()).byteLength);
        return response;
      },
    },
  );
  try {
    await client.connect(transport);
    for (const tool of ["get_session_history", "get_task_result"]) {
      const result = await client.callTool({
        name: tool,
        arguments: {
          session_id: "ses_work",
          ...(tool === "get_task_result"
            ? { submitted_message_id: "user" }
            : {}),
        },
      });
      assert.ok(!result.isError, JSON.stringify(result));
    }
    const message = await client.callTool({
      name: "get_message",
      arguments: { session_id: "ses_work", message_id: "report" },
    });
    assert.ok(!message.isError, JSON.stringify(message));
    const descriptor = (
      message.structuredContent as unknown as {
        message: { content: { content_ref: string; sha256: string } };
      }
    ).message.content;
    let cursor: string | undefined;
    let full = "";
    do {
      const result = await client.callTool({
        name: "read_message_content",
        arguments: {
          content_ref: descriptor.content_ref,
          ...(cursor ? { cursor } : {}),
          max_bytes: 16384,
        },
      });
      assert.ok(!result.isError, JSON.stringify(result));
      const data = result.structuredContent as unknown as {
        text: string;
        next_cursor?: string;
      };
      if (!cursor)
        assert.ok(
          Buffer.byteLength(data.text) < 8192,
          "JSON escaping/metadata must shrink the first all-control-character page",
        );
      full += data.text;
      cursor = data.next_cursor;
    } while (cursor);
    assert.equal(full, text);
    assert.equal(
      createHash("sha256").update(full).digest("hex"),
      descriptor.sha256,
    );
    assert.ok(wireSizes.every((size) => size <= READ_RESPONSE_BYTES));
    assert.equal(state.promptCalls.length, 0);
    const oversizedId = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "X-OCVM-MCP-Token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "x".repeat(70000),
        method: "tools/call",
        params: {
          name: "get_message",
          arguments: { session_id: "ses_work", message_id: "report" },
        },
      }),
    });
    assert.equal(oversizedId.status, 400);
    assert.ok((await oversizedId.arrayBuffer()).byteLength < 1024);
  } finally {
    await client.close();
    await server.close();
  }
});

test("Delivery A: large metadata reduces history pages without losing continuation", async () => {
  const id = "界".repeat(256);
  const state = baseState([session(id)]);
  state.messages = Array.from({ length: 20 }, (_, i) => {
    const message = stored(
      `${"界".repeat(250)}${i}`,
      "large preview".repeat(1000),
    );
    message.info.sessionID = id;
    return message;
  });
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  let before: string | undefined;
  const ids = new Set<string>();
  do {
    const page = await gateway.getSessionHistory(id, 20, before);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAYLOAD_BYTES);
    for (const message of page.messages) {
      assert.ok(message.content?.content_ref);
      assert.ok(!ids.has(message.id));
      ids.add(message.id);
    }
    before = page.next_before;
  } while (before);
  assert.equal(ids.size, 20);
});

test("creation binds runtime defaults and a root project session without sending a prompt", async () => {
  const state = baseState([]);
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const created = await gateway.createSession("  New task  ");
  assert.deepEqual(state.createCalls, [
    {
      directory: project,
      title: "New task",
      agent: "plan",
      model: { providerID: "provider", id: "model" },
    },
  ]);
  assert.deepEqual(created, {
    project: { id: "project-hash", name: "project-name" },
    session_id: "ses_created",
    title: "New task",
    agent: "plan",
    provider_id: "provider",
    model_id: "model",
    variant: "default",
    state: "created",
  });
  assert.equal(state.promptCalls.length, 0);
  assert.equal(
    (await gateway.listSessions()).sessions[0]?.id,
    created.session_id,
  );
  await gateway.sendMessage(created.session_id, "Start work");
  assert.equal(state.promptCalls[0]?.agent, "plan");
  assert.deepEqual(state.promptCalls[0]?.model, {
    providerID: "provider",
    modelID: "model",
  });
});

test("renaming uses OpenCode's native title field and preserves session identity, runtime, and history", async () => {
  const state = baseState();
  const original = session("ses_work");
  state.messages = [stored("user", "question"), stored("answer", "answer", "user")];
  const originalModel = { ...original.model! };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);

  const renamed = await gateway.renameSession("ses_work", "  Renamed work  ");
  assert.deepEqual(renamed, {
    session_id: "ses_work",
    title: "Renamed work",
    state: "renamed",
  });
  assert.deepEqual(state.renameCalls, [
    { sessionID: "ses_work", directory: project, title: "Renamed work" },
  ]);
  assert.equal(state.sessions[0]?.id, "ses_work");
  assert.equal(state.sessions[0]?.title, "Renamed work");
  assert.equal(state.sessions[0]?.agent, "build");
  assert.deepEqual(state.sessions[0]?.model, originalModel);
  assert.equal(state.messages.length, 2);
  assert.equal((await gateway.getSessionDetails("ses_work")).title, "Renamed work");
  assert.equal((await gateway.listSessions()).sessions[0]?.title, "Renamed work");
  assert.equal(state.archiveCalls.length, 0);
  assert.equal(state.promptCalls.length, 0);
  assert.equal(state.runtimeCalls.length, 0);
});

test("rename validates titles and IDs, distinguishes unknown sessions, and refuses busy or pending sessions", async () => {
  const state = baseState();
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  for (const title of ["", "   ", "x".repeat(161), "bad\nname", "bad\u0085name"])
    await assert.rejects(gateway.renameSession("ses_work", title), {
      code: "INVALID_ARGUMENT",
    });
  await assert.rejects(gateway.renameSession("bad id", "Valid title"), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(state.renameCalls.length, 0);

  await assert.rejects(gateway.renameSession("ses_missing", "Valid title"), {
    code: "SESSION_NOT_FOUND",
  });
  assert.equal(state.renameCalls.length, 0);

  state.statuses.ses_work = { type: "busy" };
  await assert.rejects(gateway.renameSession("ses_work", "Busy rename"), {
    code: "SESSION_BUSY",
    reason: "backend_active",
  });
  state.statuses.ses_work = { type: "idle" };
  state.questions.push({ sessionID: "ses_work" });
  await assert.rejects(gateway.renameSession("ses_work", "Pending rename"), {
    code: "INPUT_REQUIRED",
    reason: "pending_input",
  });
  assert.equal(state.renameCalls.length, 0);
});

test("rename shares the per-session MCP write lock with concurrent operations", async () => {
  const state = baseState();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.rename = async (parameters) => {
    await gate;
    state.sessions[0]!.title = parameters.title as string;
    return { data: state.sessions[0] };
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const first = gateway.renameSession("ses_work", "First title");
  while (!state.renameCalls.length)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).admission?.write_in_progress,
    true,
  );
  await assert.rejects(gateway.renameSession("ses_work", "Second title"), {
    code: "SESSION_BUSY",
    reason: "write_in_progress",
  });
  release();
  await first;
  assert.equal(state.renameCalls.length, 1);
  assert.equal((await gateway.getSessionDetails("ses_work")).title, "First title");
});

test("an unverified native title update is reported as uncertain without retry", async () => {
  const state = baseState();
  state.rename = async (parameters) => {
    state.sessions[0]!.title = parameters.title as string;
    throw new Error("simulated lost response");
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await assert.rejects(gateway.renameSession("ses_work", "Possibly applied"), {
    code: "RENAME_UNCERTAIN",
  });
  assert.equal(state.renameCalls.length, 1);
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).title,
    "Possibly applied",
  );
});

test("archiving keeps history opt-in readable by ID but excludes normal reads and all writes", async () => {
  const state = baseState();
  state.messages = [
    stored("user", "question"),
    stored("answer", "archived answer", "user"),
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const oldRef = (await gateway.getMessage("ses_work", "answer")).message
    .content!.content_ref;
  const archived = await gateway.archiveSession("ses_work");
  assert.equal(archived.state, "archived");
  assert.equal(state.archiveCalls.length, 1);
  assert.deepEqual(state.archiveCalls[0], {
    sessionID: "ses_work",
    directory: project,
    time: { archived: archived.archived_at },
  });
  assert.equal((await gateway.listSessions()).sessions.length, 0);
  for (const read of [
    () => gateway.getSessionDetails("ses_work"),
    () => gateway.getSessionHistory("ses_work"),
    () => gateway.getMessage("ses_work", "answer"),
    () => gateway.readMessageContent(oldRef),
    () => gateway.getTaskResult("ses_work", "user"),
    () => gateway.sendMessage("ses_work", "new work"),
    () => gateway.archiveSession("ses_work"),
    () => gateway.renameSession("ses_work", "Archived rename"),
  ])
    await assert.rejects(read(), { code: "SESSION_NOT_FOUND" });
  assert.equal(state.renameCalls.length, 0);
  assert.equal((await gateway.getSessionDetails("ses_work", true)).title, "ses_work");
  assert.equal(
    (await gateway.getSessionDetails("ses_work", true)).archived_at,
    archived.archived_at,
  );
  const page = await gateway.getSessionHistory("ses_work", 2, undefined, true);
  assert.equal(page.messages.length, 2);
  const message = (await gateway.getMessage("ses_work", "answer", true))
    .message;
  assert.equal(
    (await gateway.readMessageContent(message.content!.content_ref)).text,
    "archived answer",
  );
  const result = await gateway.getTaskResult(
    "ses_work",
    "user",
    undefined,
    20,
    undefined,
    true,
  );
  assert.equal(result.state, "completed");
  assert.equal(
    (await gateway.readMessageContent(result.messages[0]!.content!.content_ref))
      .text,
    "archived answer",
  );
  const partial = await gateway.getTaskResult(
    "ses_work",
    "user",
    undefined,
    1,
    undefined,
    true,
  );
  assert.ok(partial.next_cursor);
  await assert.rejects(
    gateway.getTaskResult("ses_work", "user", partial.next_cursor),
    { code: "SESSION_NOT_FOUND" },
  );
  const resumed = await gateway.getTaskResult(
    "ses_work",
    "user",
    partial.next_cursor,
    1,
    undefined,
    true,
  );
  assert.equal(resumed.state, "completed");
  assert.equal(state.promptCalls.length, 0);
  state.sessions[0]!.location.directory = "/other";
  await assert.rejects(
    gateway.readMessageContent(message.content!.content_ref),
    { code: "SESSION_NOT_FOUND" },
  );
  await assert.rejects(
    gateway.getTaskResult("ses_work", "user", undefined, 20, undefined, true),
    { code: "SESSION_NOT_FOUND" },
  );
});

test("archive refuses active/pending/foreign sessions but ignores stale receipts", async () => {
  for (const mode of [
    "busy",
    "pending",
    "foreign",
    "child",
  ] as const) {
    const state = baseState();
    if (mode === "busy") state.statuses.ses_work = { type: "busy" };
    if (mode === "pending") state.questions = [{ sessionID: "ses_work" }];
    if (mode === "foreign") state.sessions[0]!.location.directory = "/other";
    if (mode === "child") state.sessions[0]!.parentID = "ses_parent";
    const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
    if (mode === "busy" || mode === "pending" || mode === "foreign" || mode === "child")
      await assert.rejects(gateway.archiveSession("ses_work"), {
        code:
          mode === "busy"
            ? "SESSION_BUSY"
            : mode === "pending"
              ? "INPUT_REQUIRED"
              : "SESSION_NOT_FOUND",
      });
    assert.equal(state.archiveCalls.length, 0, mode);
    if (mode === "foreign" || mode === "child")
      await assert.rejects(gateway.getSessionDetails("ses_work", true), {
        code: "SESSION_NOT_FOUND",
      });
  }
});

test("unconfirmed archive is not retried or falsely reported as success", async () => {
  for (const mode of ["lost-response", "not-persisted"]) {
    const state = baseState();
    state.archive = async () => {
      if (mode === "lost-response") {
        state.sessions[0]!.time.archived = 3;
        throw new Error("lost response");
      }
      return { data: state.sessions[0] };
    };
    const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
    await assert.rejects(gateway.archiveSession("ses_work"), {
      code: "ARCHIVE_UNCERTAIN",
    });
    assert.equal(state.archiveCalls.length, 1);
    assert.equal(
      (await gateway.getSessionDetails("ses_work", true)).archived_at,
      mode === "lost-response" ? 3 : undefined,
    );
  }
});

test("creation resolves agent model/variant, nested model IDs, and provider defaults", async () => {
  for (const mode of ["agent", "configured", "fallback"] as const) {
    const state = baseState([]);
    state.providers.all[0]!.models["family/model"] = { variants: { high: {} } };
    if (mode === "agent") {
      state.agents[1]!.model = {
        providerID: "provider",
        modelID: "family/model",
      };
      state.agents[1]!.variant = "high";
    } else if (mode === "configured") {
      state.config.model = "provider/family/model";
    } else {
      state.config = {};
    }
    const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
    const created = await gateway.createSession();
    assert.equal(created.title, "MCP Work Session");
    assert.equal(created.agent, mode === "fallback" ? "build" : "plan");
    assert.equal(
      created.model_id,
      mode === "fallback" ? "model" : "family/model",
    );
    assert.equal(created.variant, mode === "agent" ? "high" : "default");
  }
});

test("invalid creation defaults and titles fail before any write", async () => {
  for (const mode of [
    "manager",
    "hidden",
    "subagent",
    "disconnected",
    "missing-model",
    "invalid-title",
    "invalid-variant",
  ]) {
    const state = baseState([]);
    if (mode === "manager") {
      state.config.default_agent = "openlive-manager";
      state.agents.push({ name: "openlive-manager", mode: "primary" });
    }
    if (mode === "hidden") state.agents[1]!.hidden = true;
    if (mode === "subagent") state.agents[1]!.mode = "subagent";
    if (mode === "disconnected") state.providers.connected = [];
    if (mode === "missing-model") state.config.model = "provider/absent";
    if (mode === "invalid-variant") state.agents[1]!.variant = "not-available";
    const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
    await assert.rejects(
      gateway.createSession(mode === "invalid-title" ? "  " : "new"),
      (error) =>
        error instanceof AdapterError &&
        error.code ===
          (mode === "invalid-title"
            ? "INVALID_ARGUMENT"
            : "BACKEND_INCOMPATIBLE"),
    );
    assert.equal(state.createCalls.length, 0, mode);
    assert.equal(state.promptCalls.length, 0, mode);
  }
});

test("uncertain creation is never retried and does not expose unverified IDs", async () => {
  for (const mode of [
    "timeout",
    "missing",
    "foreign",
    "child",
    "archived",
    "manager",
  ] as const) {
    const state = baseState([]);
    let aborted = false;
    state.create = async (_parameters, options) => {
      if (mode === "timeout") {
        state.sessions.push(
          session("ses_accepted_before_timeout", { agent: "plan" }),
        );
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("deadline was not applied")),
            100,
          );
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(timer);
              reject(new Error("backend-secret"));
            },
            { once: true },
          );
        });
      }
      if (mode === "missing") return { data: {} };
      const created = session("ses_private_id", {
        ...(mode === "foreign" ? { location: { directory: "/other" } } : {}),
        ...(mode === "child" ? { parentID: "ses_other" } : {}),
        ...(mode === "archived"
          ? { time: { created: 1, updated: 2, archived: 3 } }
          : {}),
        ...(mode === "manager" ? { agent: "openlive-manager" } : {}),
      });
      state.sessions.push(created);
      return { data: { id: created.id } };
    };
    const gateway = new OpenCodeGateway(
      runtime(),
      fakeClient(state) as never,
      10,
    );
    await assert.rejects(gateway.createSession(), (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "CREATION_UNCERTAIN");
      assert.match(error.message, /do not retry automatically/u);
      assert.doesNotMatch(
        error.message,
        /ses_private_id|backend-secret|\/other/u,
      );
      return true;
    });
    assert.equal(state.createCalls.length, 1, mode);
    assert.equal(state.promptCalls.length, 0, mode);
    if (mode === "timeout") {
      assert.equal(aborted, true, "creation deadline was not applied");
      assert.equal(
        (await gateway.listSessions()).sessions[0]?.id,
        "ses_accepted_before_timeout",
      );
    }
  }
});

test("creation verifies the exact read-back identity and requested settings", async () => {
  for (const mode of ["id", "agent", "model", "variant"] as const) {
    const state = baseState([]);
    state.agents[1]!.variant = "high";
    const client = fakeClient(state);
    const get = client.v2.session.get;
    client.v2.session.get = async (parameters) => {
      const response = await get(parameters);
      const actual = response.data.data;
      return {
        data: {
          data: {
            ...actual,
            ...(mode === "id" ? { id: "ses_unverified_other" } : {}),
            ...(mode === "agent" ? { agent: "build" } : {}),
            ...(mode === "model" ? { model: undefined } : {}),
            ...(mode === "variant"
              ? { model: { ...actual.model!, variant: "default" } }
              : {}),
          },
        },
      };
    };
    const gateway = new OpenCodeGateway(runtime(), client as never);
    await assert.rejects(
      gateway.createSession(),
      (error) =>
        error instanceof AdapterError &&
        error.code === "CREATION_UNCERTAIN" &&
        !error.message.includes("ses_unverified_other"),
    );
    assert.equal(state.createCalls.length, 1);
    assert.equal(state.sessions.length, 1, "unverified creation was removed");
  }
});

test("A-D: runtime options and partial updates preserve settings and refuse busy/invalid writes", async () => {
  const state = baseState([session("ses_work", { agent: "plan" })]);
  state.providers.all[0]!.models.other = { variants: { high: {}, medium: {} } };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const options = await gateway.getSessionRuntimeOptions("ses_work");
  assert.deepEqual(options.agents, ["build", "plan"]);
  assert.deepEqual(options.models[0]?.variants, ["default", "high", "medium"]);
  const changed = await gateway.updateSessionRuntime("ses_work", {
    agent: "build",
  });
  assert.equal(changed.previous.agent, "plan");
  assert.equal(changed.current.agent, "build");
  assert.equal(changed.current.variant, "high");
  assert.equal((await gateway.getSessionDetails("ses_work")).agent, "build");
  await gateway.updateSessionRuntime("ses_work", {
    model_id: "other",
    variant: "medium",
  });
  const actual = await gateway.getSessionDetails("ses_work");
  assert.equal(actual.model_id, "other");
  assert.equal(actual.variant, "medium");
  state.providers.all.push({
    id: "second-provider",
    models: { other: { variants: { medium: {} } } },
  });
  state.providers.connected.push("second-provider");
  state.providers.default["second-provider"] = "other";
  const switchedProvider = await gateway.updateSessionRuntime("ses_work", {
    provider_id: "second-provider",
  });
  assert.deepEqual(switchedProvider.current, {
    agent: "build",
    provider_id: "second-provider",
    model_id: "other",
    variant: "medium",
  });
  assert.equal(
    (await gateway.getSessionDetails("ses_work")).provider_id,
    "second-provider",
  );
  const count = state.runtimeCalls.length;
  for (const [patch, code] of [
    [{ agent: "openlive-manager" }, "INVALID_AGENT"],
    [{ provider_id: "absent" }, "INVALID_PROVIDER"],
    [{ model_id: "absent" }, "INVALID_MODEL"],
    [{ variant: "absent" }, "INVALID_VARIANT"],
  ] as const) {
    await assert.rejects(
      gateway.updateSessionRuntime("ses_work", patch),
      (error) => error instanceof AdapterError && error.code === code,
    );
  }
  state.statuses.ses_work = { type: "busy" };
  await assert.rejects(
    gateway.updateSessionRuntime("ses_work", { agent: "plan" }),
    (error) => error instanceof AdapterError && error.code === "SESSION_BUSY",
  );
  assert.equal(state.runtimeCalls.length, count);
});

test("runtime catalog supports lazy custom-provider bridging and honors native disabling", async () => {
  const state = baseState([]);
  state.agents[1]!.variant = "high";
  const client = fakeClient(state);
  const nativeList = client.v2.model.list;
  client.v2.model.list = async () => ({ data: { data: [] } });
  const gateway = new OpenCodeGateway(runtime(), client as never);
  assert.equal(
    (await gateway.getSessionRuntimeOptions()).models[0]?.model_id,
    "model",
  );
  assert.equal((await gateway.createSession()).variant, "high");
  client.v2.model.list = async () => {
    const result = await nativeList();
    return {
      data: {
        data: result.data.data.map((model) => ({ ...model, enabled: false })),
      },
    };
  };
  assert.equal((await gateway.getSessionRuntimeOptions()).models.length, 0);
  await assert.rejects(
    gateway.updateSessionRuntime("ses_created", { agent: "build" }),
    (error) => error instanceof AdapterError && error.code === "INVALID_MODEL",
  );
  await assert.rejects(
    gateway.createSession(),
    (error) =>
      error instanceof AdapterError && error.code === "BACKEND_INCOMPATIBLE",
  );
  assert.equal(state.createCalls.length, 1);
});

test("runtime update serializes with send_message and reports partial failures without retry", async () => {
  const state = baseState();
  const client = fakeClient(state);
  const gateway = new OpenCodeGateway(runtime(), client as never);
  client.v2.session.switchAgent = async (parameters) => {
    state.runtimeCalls.push(parameters);
    state.sessions[0]!.agent = parameters.agent;
    await assert.rejects(
      gateway.sendMessage("ses_work", "racing prompt"),
      (error) => error instanceof AdapterError && error.code === "SESSION_BUSY",
    );
    return { data: {} };
  };
  client.v2.session.switchModel = async (parameters) => {
    state.runtimeCalls.push(parameters);
    throw new Error("backend-secret");
  };
  await assert.rejects(
    gateway.updateSessionRuntime("ses_work", { agent: "plan" }),
    (error) =>
      error instanceof AdapterError &&
      error.code === "RUNTIME_UPDATE_FAILED" &&
      !error.message.includes("backend-secret"),
  );
  assert.equal(state.runtimeCalls.length, 2);
  assert.equal(state.promptCalls.length, 0);
  assert.equal((await gateway.getSessionDetails("ses_work")).agent, "plan");
});

test("E-I: activity correlates parallel receipts, pending input and restart without storing history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-activity-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  const state = baseState([
    session("ses_a"),
    session("ses_b"),
    session("ses_c"),
  ]);
  const client = fakeClient(state);
  let gateway = new OpenCodeGateway(runtime(), client as never);
  await gateway.enableActivity(path);
  state.promptAsync = async (parameters) => {
    const id = parameters.sessionID as string;
    state.statuses[id] = { type: "busy" };
    state.messages.push({
      info: {
        id: parameters.messageID,
        sessionID: id,
        role: "user",
        time: { created: Date.now() },
      },
      parts: [{ type: "text", text: "SECRET_PROMPT" }],
    });
  };
  const anchor = (await gateway.getProjectActivity()).next_cursor;
  const [a, b] = await Promise.all([
    gateway.sendMessage("ses_a", "a"),
    gateway.sendMessage("ses_b", "b"),
  ]);
  assert.ok(a.activity_cursor && a.submitted_at);
  const finish = async (id: string, messageId: string, suffix: string) => {
    state.messages.push({
      info: {
        id: `msg_${suffix}`,
        sessionID: id,
        parentID: messageId,
        role: "assistant",
        time: { created: 2, completed: 3 },
        finish: "stop",
      },
      parts: [{ type: "text", text: "SECRET_RESPONSE" }],
    });
    state.statuses[id] = { type: "idle" };
    await gateway.captureActivity(id);
  };
  await gateway.captureActivity("ses_a");
  await gateway.captureActivity("ses_b");
  await finish("ses_a", a.message_id, "reply_a");
  const first = await gateway.getProjectActivity({
    after_cursor: anchor,
    event_types: ["message.completed"],
  });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.session_id, "ses_a");
  assert.equal(first.events[0]?.message_id, a.message_id);
  assert.deepEqual(first.events[0]?.assistant_message_ids, ["msg_reply_a"]);
  await finish("ses_b", b.message_id, "reply_b");
  const second = await gateway.getProjectActivity({
    after_cursor: first.next_cursor,
    event_types: ["message.completed"],
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]?.message_id, b.message_id);
  const c = await gateway.sendMessage("ses_c", "c");
  state.permissions = [
    { id: "p", sessionID: "ses_c", metadata: { secret: "SECRET_PERMISSION" } },
  ];
  await gateway.captureActivity("ses_c");
  const blocked = await gateway.getProjectActivity({
    after_cursor: second.next_cursor,
    event_types: ["session.input_required", "session.permission_required"],
  });
  assert.equal(blocked.events.length, 2);
  assert.equal(blocked.events[0]?.session_id, c.session_id);
  assert.equal(
    blocked.events[0]?.message_id,
    undefined,
    "unattributed session input must not claim a task binding",
  );
  assert.deepEqual(blocked.events[0]?.pending_input, {
    permissions: 1,
    questions: 0,
  });
  state.permissions = [];
  state.questions = [
    {
      id: "q",
      sessionID: "ses_c",
      questions: [{ question: "SECRET_QUESTION" }],
    },
  ];
  await gateway.captureActivity("ses_c");
  const question = await gateway.getProjectActivity({
    after_cursor: blocked.next_cursor,
    event_types: ["session.input_required", "session.permission_required"],
  });
  assert.equal(question.events.length, 1);
  assert.deepEqual(question.events[0]?.pending_input, {
    permissions: 0,
    questions: 1,
  });
  await gateway.close();
  gateway = new OpenCodeGateway(runtime(), client as never);
  await gateway.enableActivity(path);
  const restored = await gateway.getProjectActivity({
    after_cursor: first.next_cursor,
    event_types: ["message.completed"],
  });
  assert.deepEqual(restored.events, second.events);
  assert.doesNotMatch(await readFile(path, "utf8"), /SECRET_/u);
  const waiting = gateway.waitForProjectActivity({
    after_cursor: (await gateway.getProjectActivity()).next_cursor,
    timeout_ms: 10,
  });
  assert.equal((await waiting).timeout, true);
  // Existing I semantics: a transport failure is a single admission attempt.
  state.statuses.ses_a = { type: "idle" };
  state.promptAsync = async () => {
    throw new Error("uncertain transport");
  };
  const calls = state.promptCalls.length;
  await assert.rejects(
    gateway.sendMessage("ses_a", "uncertain"),
    (error) =>
      error instanceof AdapterError && error.code === "SUBMISSION_UNCERTAIN",
  );
  assert.equal(state.promptCalls.length, calls + 1);
  await gateway.close();
});

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
  assert.equal(result.messages[0]?.text.length, 1024);
  assert.equal(result.messages[1]?.text.length, 1024);
  assert.equal(result.messages[1]?.text_truncated, true);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /secret|hidden reasoning|hidden system/u,
  );
  assert.deepEqual(result.messages[1]?.content?.omitted_parts, [
    { type: "reasoning", count: 1, reason: "part_not_exposed" },
  ]);
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

  const observed = await gateway.getSessionStatus("ses_work", "msg_user");
  assert.ok(observed.observed_at);
  assert.deepEqual(observed, {
    session_id: "ses_work",
    message_id: "msg_user",
    backend_activity: "idle",
    state: "completed",
    pending_input: { permissions: 0, questions: 0 },
    assistant_message_ids: ["msg_assistant"],
    active_assistant_message_ids: [],
    admission: { write_in_progress: false },
    pending_input_scope: "session",
    observed_at: observed.observed_at,
    source: "backend",
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

test("submission timeout protects the exact retry but allows a different follow-up", async () => {
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
    gateway.sendMessage("ses_work", "first"),
    (error) =>
      error instanceof AdapterError &&
      error.code === "SUBMISSION_UNCERTAIN" &&
      error.correlationId?.startsWith("msg_") === true,
  );
  state.promptAsync = async () => undefined;
  const followUp = await gateway.sendMessage("ses_work", "third");
  assert.match(followUp.message_id, /^msg_[a-f0-9]{32}$/u);
  assert.equal(state.promptCalls.length, 2);
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
