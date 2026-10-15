import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { OpenCodeGateway as ProductionGateway, validateScopeDirs, validateScopeReadFiles } from "./opencode.js";
import { createServer as unixServer } from "node:net";
import { AdapterError } from "./types.js";
import type { RuntimeDescriptor, TaskResult } from "./types.js";
import type { SubmissionGuardOverrideInput } from "./types.js";

const project = "/project";
const managedCalls: string[] = [];
class OpenCodeGateway extends ProductionGateway {
  protected override async adoptManagedSession(id: string): Promise<void> { managedCalls.push(id); }
}

function runtime(managerFile?: string, projectDir: string = project): RuntimeDescriptor {
  return {
    schema: 1,
    project: projectDir,
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
  projectDir: string = project,
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
    location: { directory: projectDir },
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
  v1Permissions: Array<Record<string, unknown>>;
  v1Questions: Array<Record<string, unknown>>;
  promptCalls: Array<Record<string, unknown>>;
  promptAsync?: (parameters: Record<string, unknown>) => Promise<unknown>;
  abortCalls: Array<Record<string, unknown>>;
  abort?: (parameters: Record<string, unknown>) => Promise<unknown>;
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

function fakeClient(state: FakeState, projectDir: string = project) {
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
      async directories() {
        return { data: [] };
      },
    },
    permission: {
      async list() {
        return { data: state.v1Permissions };
      },
    },
    question: {
      async list() { return { data: state.v1Questions }; },
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
        }, projectDir);
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
      async abort(parameters: Record<string, unknown>) {
        state.abortCalls.push(parameters);
        if (state.abort) return state.abort(parameters);
        return { data: true };
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
    v1Permissions: [],
    v1Questions: [],
    promptCalls: [],
    abortCalls: [],
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

test("explicit journal-free mode avoids journal state and preserves reads, writes and admission checks", async t => {
  const state = baseState();
  state.messages = [stored("user_jfree", "request"), stored("assistant_jfree", "result", "user_jfree")];
  let subscriptions = 0;
  const gateway = new OpenCodeGateway({ ...runtime(), activityJournalEnabled: false }, {
    ...fakeClient(state), event: { subscribe() { subscriptions++; throw new Error("must never subscribe"); } },
  } as never);
  t.after(() => gateway.close());
  // If enableActivity touches disk, this deliberately invalid path fails.
  await gateway.enableActivity("/proc/nonexistent-journal/activity.json");
  gateway.startActivityCollection();
  assert.equal(subscriptions, 0);
  assert.deepEqual(gateway.activityJournalStatus(), { enabled: false, state: "disabled" });
  assert.equal((await gateway.getSessionStatus("ses_work", "user_jfree")).state, "completed");
  assert.equal((await gateway.getTaskResult("ses_work", "user_jfree")).state, "completed");
  assert.equal((await gateway.getSessionProgress("ses_work")).source, "backend_snapshot");
  assert.equal((await gateway.updateSessionRuntime("ses_work", { variant: "medium" })).state, "updated");
  const sent = await gateway.sendMessage("ses_work", "journal-free request");
  assert.equal(sent.state, "submitted");
  assert.equal(sent.activity_cursor, undefined);
  state.statuses.ses_work = { type: "busy" };
  await assert.rejects(gateway.sendMessage("ses_work", "must be refused"), { code: "SESSION_BUSY" });
  const followup = await gateway.sendFollowup("ses_work", "next turn");
  assert.equal(followup.activity_cursor, undefined);
  state.questions = [{ sessionID: "ses_work" }];
  await assert.rejects(gateway.sendFollowup("ses_work", "must be refused"), { code: "INPUT_REQUIRED" });
  for (const read of [() => gateway.getProjectActivity(), () => gateway.getProjectAttention(),
    () => gateway.waitForProjectActivity({ after_cursor: "unused", timeout_ms: 1 }),
    () => gateway.handleMcpEventMethod("events/list", {})])
    await assert.rejects(read(), { code: "ACTIVITY_DISABLED" });
});

test("enabled journal failure is degraded, never silently downgraded to journal-free", async t => {
  const state = baseState(), gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const path = await enableTestJournal(t, gateway);
  assert.deepEqual(gateway.activityJournalStatus(), { enabled: true, state: "ready" });
  await rm(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
  state.statuses.ses_work = { type: "busy" };
  await assert.rejects(gateway.captureActivity("ses_work"), { code: "ACTIVITY_UNAVAILABLE" });
  assert.deepEqual(gateway.activityJournalStatus(), { enabled: true, state: "degraded" });
  state.messages = [stored("user_failedjournal", "request"), stored("assistant_failedjournal", "result", "user_failedjournal")];
  await assert.rejects(gateway.getSessionStatus("ses_work", "user_failedjournal"), { code: "ACTIVITY_UNAVAILABLE" });
  assert.equal((await gateway.getSessionDetails("ses_work")).activity, "busy");
});

test("a failed optional journal does not block admission; coverage is reported degraded", async t => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    const user = stored(parameters.messageID as string, "degraded send");
    user.info.sessionID = parameters.sessionID;
    state.messages.push(user);
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const path = await enableTestJournal(t, gateway);
  assert.deepEqual(gateway.activityJournalStatus(), { enabled: true, state: "ready" });
  // Break the write target; the next commit latches the optional journal closed.
  await rm(path.substring(0, path.lastIndexOf("/")), { recursive: true, force: true });
  state.statuses.ses_work = { type: "busy" };
  await assert.rejects(gateway.captureActivity("ses_work"), { code: "ACTIVITY_UNAVAILABLE" });
  assert.deepEqual(gateway.activityJournalStatus(), { enabled: true, state: "degraded" });
  // Admission with the degraded optional journal still succeeds (never blocked).
  state.statuses.ses_work = { type: "idle" };
  const receipt = await gateway.sendMessage("ses_work", "degraded send");
  assert.equal(receipt.state, "submitted");
  assert.ok(receipt.message_id.length > 0);
});

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
  assert.equal(progress.pending_input_scope, "session+descendants");
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

test("worker failure details are safe on every read path and stay with the exact submitted turn", async () => {
  const state = baseState();
  const failed = stored("assistant_timeout", "", "user_timeout");
  failed.info.error = {
    name: "APIError",
    data: {
      message: "PRIVATE_PROVIDER_MESSAGE",
      isRetryable: true,
      metadata: {
        code: "ProviderHeaderTimeoutError",
        timeoutMs: "300000",
        headers: { authorization: "Bearer PRIVATE_TOKEN" },
      },
    },
  };
  failed.parts = [{
    type: "tool",
    state: {
      input: { token: "PRIVATE_TOOL_INPUT" },
      output: "PRIVATE_TOOL_OUTPUT",
    },
  }];
  state.messages = [
    stored("user_timeout", "original request"),
    failed,
    stored("user_continued", "later continuation"),
    stored("assistant_continued", "later response", "user_continued"),
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const expected = {
    category: "provider_header_timeout",
    name: "APIError",
    code: "ProviderHeaderTimeoutError",
    timeout_ms: 300000,
    message: "Provider response headers timed out after 300000ms.",
    detail_availability: "safe_template" as const,
    source: "assistant_message_error" as const,
    source_is_retryable: true,
  };
  const [history, direct, result, status] = await Promise.all([
    gateway.getSessionHistory("ses_work"),
    gateway.getMessage("ses_work", "assistant_timeout"),
    gateway.getTaskResult("ses_work", "user_timeout"),
    gateway.getSessionStatus("ses_work", "user_timeout"),
  ]);
  assert.deepEqual(
    history.messages.find((message) => message.id === "assistant_timeout")?.error_detail,
    expected,
  );
  assert.deepEqual(direct.message.error_detail, expected);
  assert.equal(direct.message.content?.availability, "not_exposed");
  assert.equal(result.state, "failed");
  assert.deepEqual(result.messages.map((message) => message.id), ["assistant_timeout"]);
  assert.deepEqual(result.messages[0]?.error_detail, expected);
  assert.equal(status.state, "failed");
  assert.deepEqual(status.error_details, [{
    ...expected,
    assistant_message_id: "assistant_timeout",
    attribution: "exact_parent",
  }]);
  assert.equal(status.error_details_total, 1);
  assert.equal(status.error_details_truncated, false);
  assert.doesNotMatch(
    JSON.stringify({ history, direct, result, status }),
    /PRIVATE_/u,
  );
});

test("correlated status bounds worker error details without losing the total", async () => {
  const state = baseState();
  const failures = Array.from({ length: 11 }, (_, index) => {
    const failed = stored(`assistant_${index}`, "", "user_timeout");
    failed.info.error = {
      name: "APIError",
      data: {
        metadata: {
          code: "ProviderHeaderTimeoutError",
          timeoutMs: String(index + 1),
        },
      },
    };
    return failed;
  });
  state.messages = [stored("user_timeout", "original request"), ...failures];
  const status = await new OpenCodeGateway(
    runtime(),
    fakeClient(state) as never,
  ).getSessionStatus("ses_work", "user_timeout");
  assert.equal(status.error_details?.length, 10);
  assert.equal(status.error_details_total, 11);
  assert.equal(status.error_details_truncated, true);
  assert.deepEqual(
    status.error_details?.map((detail) => detail.assistant_message_id),
    Array.from({ length: 10 }, (_, index) => `assistant_${index}`),
  );
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
  assert.equal(result.pending_input_scope, "session+descendants");
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

test("work creation/send adopt automatically while reads and pure management stay neutral", async () => {
  const state = baseState();
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const before = managedCalls.length;
  await gateway.getSessionDetails("ses_work");
  await gateway.getSessionHistory("ses_work");
  await gateway.renameSession("ses_work", "Managed neutrality fixture");
  await gateway.updateSessionRuntime("ses_work", { variant: "default" });
  await gateway.uploadAttachment("ses_work", "note.txt", "text/plain", Buffer.from("fixture").toString("base64"));
  assert.equal(managedCalls.length, before);
  await gateway.sendMessage("ses_work", "ordinary flagless work");
  assert.deepEqual(managedCalls.slice(before), ["ses_work"]);
  await gateway.archiveSession("ses_work");
  assert.equal(managedCalls.length, before + 1);
  const created = await gateway.createSession("New agent work");
  assert.equal(managedCalls.at(-1), created.session_id);
});

test("policy failure prevents prompt admission and creation remains uncertain without retry", async () => {
  class FailingGateway extends OpenCodeGateway {
    protected override async adoptManagedSession(): Promise<void> { throw new AdapterError("BACKEND_INCOMPATIBLE", "policy unavailable"); }
  }
  const state = baseState();
  const gateway = new FailingGateway(runtime(), fakeClient(state) as never);
  await assert.rejects(gateway.sendMessage("ses_work", "work"), { code: "BACKEND_INCOMPATIBLE" });
  assert.equal(state.promptCalls.length, 0);
  await assert.rejects(gateway.createSession("work"), { code: "CREATION_UNCERTAIN" });
  assert.equal(state.createCalls.length, 1);
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
  const submittedPrompts = state.promptCalls.length;
  await finish("ses_a", a.message_id, "reply_a");
  const first = await gateway.getProjectActivity({
    after_cursor: anchor,
    event_types: ["message.completed"],
  });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.session_id, "ses_a");
  assert.equal(first.events[0]?.message_id, a.message_id);
  assert.deepEqual(first.events[0]?.assistant_message_ids, ["msg_reply_a"]);
  const prepared = (await gateway.getProjectAttention()).entries.find((entry) => entry.event_id === first.events[0]?.event_id);
  assert.equal(prepared?.lifecycle, "ready");
  assert.equal(prepared?.submitted_message_id, a.message_id);
  assert.deepEqual(prepared?.assistant_message_ids, ["msg_reply_a"]);
  assert.equal(prepared?.evidence?.complete, true);
  assert.match(prepared?.prepared_summary ?? "", /Worker result is available/u);
  assert.match(prepared?.next_safe_step ?? "", /no follow-up was started/u);
  assert.doesNotMatch(prepared?.prepared_summary ?? "", /SECRET_RESPONSE/u);
  assert.equal(state.promptCalls.length, submittedPrompts, "prefetch must never submit a follow-up worker");
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
    coverage: "session+descendants",
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
    coverage: "session+descendants",
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

test("prepared attention retains safe correlated failure evidence without visible text", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-error-attention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  const state = baseState();
  const failed = stored("assistant_timeout", "", "user_timeout");
  failed.info.error = {
    name: "APIError",
    data: {
      isRetryable: true,
      message: "PRIVATE_PROVIDER_MESSAGE",
      metadata: {
        code: "ProviderHeaderTimeoutError",
        timeoutMs: "300000",
        headers: { authorization: "Bearer PRIVATE_TOKEN" },
      },
    },
  };
  failed.parts = [{
    type: "tool",
    state: { output: "PRIVATE_TOOL_OUTPUT" },
  }];
  state.messages = [stored("user_timeout", "request"), failed];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await gateway.enableActivity(path);
  await gateway.captureActivity("ses_work");
  const prepared = (await gateway.getProjectAttention()).entries[0]!;
  assert.equal(prepared.event_type, "message.failed");
  assert.equal(prepared.lifecycle, "ready");
  assert.match(prepared.source_revision ?? "", /^attention-v2:/u);
  assert.match(prepared.prepared_summary, /300000ms/u);
  assert.deepEqual(prepared.error_details, [{
    category: "provider_header_timeout",
    name: "APIError",
    code: "ProviderHeaderTimeoutError",
    timeout_ms: 300000,
    message: "Provider response headers timed out after 300000ms.",
    detail_availability: "safe_template",
    source: "assistant_message_error",
    source_is_retryable: true,
    assistant_message_id: "assistant_timeout",
    attribution: "exact_parent",
  }]);
  assert.equal(prepared.error_details_total, 1);
  assert.equal(prepared.error_details_truncated, false);
  assert.deepEqual(prepared.assistant_message_ids, ["assistant_timeout"]);
  assert.deepEqual(prepared.evidence?.assistant_message_ids, ["assistant_timeout"]);
  const extraFailures = Array.from({ length: 10 }, (_, index) => {
    const extra = stored(`assistant_timeout_${index}`, "", "user_timeout");
    extra.info.error = {
      name: "APIError",
      data: { metadata: { code: "ProviderResponseStreamError" } },
    };
    return extra;
  });
  state.messages.push(...extraFailures);
  await gateway.captureActivity("ses_work");
  const truncated = (await gateway.getProjectAttention()).entries[0]!;
  assert.equal(truncated.error_details?.length, 10);
  assert.equal(truncated.error_details_total, 11);
  assert.equal(truncated.error_details_truncated, true);
  const allAssistantIds = ["assistant_timeout", ...extraFailures.map((message) => message.info.id)];
  assert.deepEqual([...truncated.assistant_message_ids].sort(), [...allAssistantIds].sort());
  assert.deepEqual([...truncated.evidence?.assistant_message_ids ?? []].sort(), [...allAssistantIds].sort());
  assert.equal(truncated.evidence?.complete, true);
  const sourceRevision = truncated.source_revision;
  (failed.info.error as {
    data: { metadata: { timeoutMs: string } };
  }).data.metadata.timeoutMs = "300001";
  await gateway.captureActivity("ses_work");
  const refreshed = (await gateway.getProjectAttention()).entries[0]!;
  assert.notEqual(refreshed.source_revision, sourceRevision);
  assert.equal(refreshed.error_details_total, 11);
  assert.equal(refreshed.error_details_truncated, true);
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(
    JSON.stringify({ prepared, persisted }),
    /PRIVATE_/u,
  );
  await gateway.close();
  const restoredGateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await restoredGateway.enableActivity(path);
  assert.deepEqual(
    (await restoredGateway.getProjectAttention()).entries[0]?.error_details,
    refreshed.error_details,
  );
  await restoredGateway.close();
});

test("activity refreshes prepared attention when durable error metadata arrives late", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-late-error-attention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = baseState();
  const failed = stored("assistant_late_error", "", "user_late_error", "error");
  state.messages = [stored("user_late_error", "request"), failed];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  await gateway.enableActivity(join(directory, "activity.json"));
  await gateway.captureActivity("ses_work");
  const initialQueue = await gateway.getProjectAttention();
  const initial = initialQueue.entries[0]!;
  assert.equal(initial.error_details, undefined);
  const initialRevision = initial.source_revision;
  failed.info.error = {
    name: "APIError",
    data: {
      metadata: {
        code: "ProviderHeaderTimeoutError",
        timeoutMs: "300000",
      },
    },
  };
  await gateway.captureActivity("ses_work");
  const refreshedQueue = await gateway.getProjectAttention({ after_cursor: initialQueue.current_cursor });
  assert.equal(refreshedQueue.entries.length, 1);
  const refreshed = refreshedQueue.entries[0]!;
  assert.notEqual(refreshed.event_id, initial.event_id);
  assert.notEqual(refreshed.source_revision, initialRevision);
  assert.equal(refreshed.error_details?.[0]?.message, "Provider response headers timed out after 300000ms.");
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
    pending_input: { permissions: 0, questions: 0, coverage: "session+descendants" },
    assistant_message_ids: ["msg_assistant"],
    active_assistant_message_ids: [],
    admission: { write_in_progress: false },
    pending_input_scope: "session+descendants",
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

test("backend connectivity is cached, bounded and honest without live services", async (t) => {
  let calls = 0;
  const okClient = { global: { async health() { calls += 1; return { data: { healthy: true } }; } } };
  const gateway = new OpenCodeGateway(runtime(), okClient as never);
  t.after(() => gateway.close());
  assert.equal(await gateway.backendConnectivity(), "ok");
  assert.equal(await gateway.backendConnectivity(), "ok");
  assert.equal(calls, 1, "the short cache must prevent a backend probe per poll");
  (gateway as unknown as { backendHealthCacheTtlMs: number }).backendHealthCacheTtlMs = 10;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await gateway.backendConnectivity(), "ok");
  assert.equal(calls, 2, "an expired cache re-probes");
  let aborted = false;
  const hangClient = {
    global: {
      health: ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
        }),
    },
  };
  const hangGateway = new OpenCodeGateway(runtime(), hangClient as never);
  t.after(() => hangGateway.close());
  (hangGateway as unknown as { backendHealthProbeTimeoutMs: number }).backendHealthProbeTimeoutMs = 30;
  // AbortSignal.timeout does not keep the event loop alive; in production the
  // server does. Hold the loop so the bounded probe can actually fire here.
  const keepAlive = setInterval(() => undefined, 10);
  const started = Date.now();
  try {
    assert.equal(await hangGateway.backendConnectivity(), "unreachable");
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(aborted, "a hanging backend must be cut by the probe timeout");
  assert.ok(Date.now() - started < 2000, "the health path stays bounded");
  const sickGateway = new OpenCodeGateway(runtime(),
    { global: { async health() { return { data: { healthy: false } }; } } } as never);
  t.after(() => sickGateway.close());
  assert.equal(await sickGateway.backendConnectivity(), "unreachable");
});

test("attention prefetch episodes back off bounded, alert once, retain pending and clear on success", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-attention-episode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "activity.json");
  const state = baseState();
  const opaque = (id: string, parent: string) => ({
    info: { id, sessionID: "ses_work", role: "assistant", time: { created: 1, completed: 2 }, parentID: parent, finish: "stop" },
    parts: [{ id: `part_${id}`, type: "tool", state: { output: "PRIVATE_TOOL_OUTPUT" } }],
  });
  state.messages = [stored("user_x", "request"), opaque("assistant_x", "user_x") as never];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  (gateway as unknown as { attentionRetryDelaysMs: number[] }).attentionRetryDelaysMs = [0, 0, 0];
  t.after(() => gateway.close());
  const stderrLines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    if (typeof chunk === "string") stderrLines.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  t.after(() => { process.stderr.write = originalWrite; });
  const pendingLines = () => stderrLines.filter((line) => line.includes("attention prefetch pending")).length;
  const exhaustedLines = () => stderrLines.filter((line) => line.includes("exhausted after 3 bounded attempts")).length;

  await gateway.enableActivity(path);
  await gateway.captureActivity("ses_work");
  assert.equal(pendingLines(), 1, "the first failed attempt is logged once");
  for (const filler of ["user_f1", "user_f2", "user_f3", "user_f4"]) {
    state.messages.push(stored(filler, "filler"));
    await gateway.captureActivity("ses_work");
  }
  assert.equal(pendingLines(), 1, "attempts 2 and 3 stay silent; the cap blocks further attempts");
  assert.equal(exhaustedLines(), 1, "exactly one persistent-impact alert per exhausted episode");
  assert.ok(!stderrLines.join("").includes("PRIVATE_TOOL_OUTPUT"));
  let pending = (await gateway.getProjectAttention({ lifecycle: ["new"] })).entries;
  const stuckX = pending.filter((entry) => entry.submitted_message_id === "user_x");
  assert.equal(stuckX.length, 1);
  assert.equal(stuckX[0]?.lifecycle, "new", "exhaustion retains the pending entry; evidence is never dropped");

  // A second entry gets its own fresh episode budget.
  state.messages.push(stored("user_y", "request"), opaque("assistant_y", "user_y") as never);
  await gateway.captureActivity("ses_work");
  assert.equal(pendingLines(), 2);
  // The correlated result becoming visible makes the next bounded attempt
  // succeed: a normal return clears the episode without exhaustion.
  (state.messages[state.messages.length - 1] as { parts: unknown[] }).parts =
    [{ id: "part_y_text", type: "text", text: "visible final report" }];
  state.messages.push(stored("user_f5", "filler"));
  await gateway.captureActivity("ses_work");
  const readyY = (await gateway.getProjectAttention()).entries;
  assert.ok(readyY.some((entry) => entry.submitted_message_id === "user_y" && entry.lifecycle === "ready"),
    "a successful prefetch clears the episode and prepares the entry");
  assert.equal(pendingLines(), 2, "the cleared episode logged no further attempts");
  assert.equal(exhaustedLines(), 1, "success is not an exhaustion");

  // A fresh future episode remains possible after a cleared one.
  state.messages.push(stored("user_z", "request"), opaque("assistant_z", "user_z") as never);
  await gateway.captureActivity("ses_work");
  assert.equal(pendingLines(), 3, "episodes are per entry, not a global budget");
  pending = (await gateway.getProjectAttention({ lifecycle: ["new"] })).entries;
  assert.equal(pending.filter((entry) => entry.submitted_message_id === "user_z" && entry.lifecycle === "new").length, 1);
});

// ---------------------------------------------------------------------------
// W1 Session-Control: send_session_followup + abort_session_turn
// Evidence base: D1/D2 JIT probe against disposable real OpenCode 1.18.34
// (v1 prompt_async admits while busy and serializes natively; v1 abort marks
// the assistant MessageAbortedError; v1-runner permissions only surface on
// the v1 endpoint; idle abort is a non-destructive no-op).
// ---------------------------------------------------------------------------

function activeAssistant(
  id: string,
  parent: string,
): FakeState["messages"][number] {
  return {
    info: {
      id,
      sessionID: "ses_work",
      role: "assistant",
      parentID: parent,
      time: { created: 1 },
    },
    parts: [{ id: `part_${id}`, type: "step-start" }],
  };
}

function abortedAssistant(
  id: string,
  parent: string,
): FakeState["messages"][number] {
  return {
    info: {
      id,
      sessionID: "ses_work",
      role: "assistant",
      parentID: parent,
      time: { created: 1, completed: 2 },
      error: { name: "MessageAbortedError" },
    },
    parts: [{ id: `part_${id}`, type: "step-start" }],
  };
}

function setAbortSeams(
  gateway: OpenCodeGateway,
  budgetMs: number,
  pollMs: number,
): void {
  const seams = gateway as unknown as {
    abortVerifyBudgetMs: number;
    abortVerifyPollMs: number;
  };
  seams.abortVerifyBudgetMs = budgetMs;
  seams.abortVerifyPollMs = pollMs;
}

test("W1: follow-up admits natively while busy and keeps the supersede guard bound to the running turn", async (t) => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "task"));
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());

  const first = await gateway.sendMessage("ses_work", "original task");
  assert.equal(state.promptCalls.length, 1);
  const adoptionsAfterSend = managedCalls.length;
  assert.ok(adoptionsAfterSend >= 1, "send_message adopts managed policy");

  state.statuses["ses_work"] = { type: "busy" };
  const followup = await gateway.sendFollowup("ses_work", "correction while busy");
  assert.equal(followup.state, "submitted");
  assert.equal(
    managedCalls.length,
    adoptionsAfterSend,
    "a busy follow-up never re-triggers the idle adoption boundary",
  );
  assert.equal(followup.session_id, "ses_work");
  assert.match(followup.message_id, /^msg_[0-9a-f]{32}$/u);
  assert.notEqual(followup.message_id, first.message_id);
  assert.ok(followup.submitted_at);

  const call = state.promptCalls[1];
  assert.ok(call);
  assert.equal(call.sessionID, "ses_work");
  assert.equal(call.messageID, followup.message_id);
  assert.equal(call.agent, "build");
  assert.deepEqual(call.model, { providerID: "provider", modelID: "model" });
  assert.equal(call.variant, "high");
  assert.deepEqual(call.parts, [{ type: "text", text: "correction while busy" }]);

  // The follow-up adds a tracked message but never replaces the guard of the
  // still-running original turn.
  const details = await gateway.getSessionDetails("ses_work");
  assert.equal(details.admission?.guarded_message_id, first.message_id);
  assert.equal(state.promptCalls.length, 2);
});

test("W1: follow-up refuses an idle session with SESSION_NOT_BUSY and no backend write", async (t) => {
  const state = baseState();
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "task"));
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  await assert.rejects(
    gateway.sendFollowup("ses_work", "idle follow-up"),
    (error: AdapterError) => {
      assert.equal(error.code, "SESSION_NOT_BUSY");
      assert.match(error.message, /send_message/u);
      return true;
    },
  );
  assert.equal(state.promptCalls.length, 0);
});

test("W1: follow-up treats retry activity as actively working", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "retry" };
  state.promptAsync = async (parameters) => {
    state.messages.push(stored(parameters.messageID as string, "task"));
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  const result = await gateway.sendFollowup("ses_work", "follow-up during retry");
  assert.equal(result.state, "submitted");
  assert.equal(state.promptCalls.length, 1);
});

test("W1: follow-up never bypasses pending input on the v1 or v2 surface", async (t) => {
  // v1-runner permission (invisible on the v2 endpoint — probe evidence)
  const s1 = baseState();
  s1.statuses["ses_work"] = { type: "busy" };
  s1.v1Permissions = [{ id: "per_1", sessionID: "ses_work", permission: "bash" }];
  const g1 = new OpenCodeGateway(runtime(), fakeClient(s1) as never);
  t.after(() => g1.close());
  await assert.rejects(g1.sendFollowup("ses_work", "x"), {
    code: "INPUT_REQUIRED",
    reason: "pending_input",
  });
  assert.equal(s1.promptCalls.length, 0);

  // v2 permission
  const s2 = baseState();
  s2.statuses["ses_work"] = { type: "busy" };
  s2.permissions = [{ id: "per_2", sessionID: "ses_work" }];
  const g2 = new OpenCodeGateway(runtime(), fakeClient(s2) as never);
  t.after(() => g2.close());
  await assert.rejects(g2.sendFollowup("ses_work", "x"), {
    code: "INPUT_REQUIRED",
    reason: "pending_input",
  });
  assert.equal(s2.promptCalls.length, 0);

  // v2 question
  const s3 = baseState();
  s3.statuses["ses_work"] = { type: "busy" };
  s3.questions = [{ id: "q_1", sessionID: "ses_work" }];
  const g3 = new OpenCodeGateway(runtime(), fakeClient(s3) as never);
  t.after(() => g3.close());
  await assert.rejects(g3.sendFollowup("ses_work", "x"), {
    code: "INPUT_REQUIRED",
    reason: "pending_input",
  });
  assert.equal(s3.promptCalls.length, 0);

  // A different session's v1 permission does not block this session.
  const s4 = baseState();
  s4.statuses["ses_work"] = { type: "busy" };
  s4.v1Permissions = [{ id: "per_3", sessionID: "ses_other" }];
  s4.sessions.push(session("ses_other")); // Proven foreign root, not an unknown lineage.
  s4.promptAsync = async (parameters) => {
    s4.messages.push(stored(parameters.messageID as string, "task"));
  };
  const g4 = new OpenCodeGateway(runtime(), fakeClient(s4) as never);
  t.after(() => g4.close());
  const admitted = await g4.sendFollowup("ses_work", "unblocked");
  assert.equal(admitted.state, "submitted");
  assert.equal(s4.promptCalls.length, 1);
});

test("W1: follow-up transport uncertainty never blind-resends; a different follow-up continues", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  let fail = true;
  state.promptAsync = async (parameters) => {
    if (fail) throw new Error("transport lost");
    state.messages.push(stored(parameters.messageID as string, "task"));
    return {};
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());

  await assert.rejects(
    gateway.sendFollowup("ses_work", "uncertain follow-up"),
    (error: AdapterError) => {
      assert.equal(error.code, "SUBMISSION_UNCERTAIN");
      assert.match(error.correlationId ?? "", /^msg_[0-9a-f]{32}$/u);
      return true;
    },
  );
  assert.equal(state.promptCalls.length, 1);

  // The exact same immediate retry stays protected: no second backend call.
  await assert.rejects(gateway.sendFollowup("ses_work", "uncertain follow-up"), {
    code: "SUBMISSION_UNCERTAIN",
  });
  assert.equal(state.promptCalls.length, 1);

  // A different authorized follow-up is an explicit continuation.
  fail = false;
  const next = await gateway.sendFollowup("ses_work", "different follow-up");
  assert.equal(next.state, "submitted");
  assert.equal(state.promptCalls.length, 2);
});

test("W1: the MCP write lock serializes follow-ups against concurrent writes", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  let release!: () => void;
  state.promptAsync = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());

  const first = gateway.sendFollowup("ses_work", "held follow-up");
  while (state.promptCalls.length < 1)
    await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(gateway.sendMessage("ses_work", "concurrent send"), {
    code: "SESSION_BUSY",
    reason: "write_in_progress",
  });
  await assert.rejects(gateway.sendFollowup("ses_work", "concurrent follow-up"), {
    code: "SESSION_BUSY",
    reason: "write_in_progress",
  });
  release();
  await first;
  assert.equal(state.promptCalls.length, 1);
});

test("W1: follow-up attachment mapping equals send_message and image capability is enforced", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  const submittedParts: Array<unknown> = [];
  state.promptAsync = async (parameters) => {
    submittedParts.push(parameters.parts);
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

  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);
  const image = await gateway.uploadAttachment(
    "ses_work",
    "mockup.png",
    "image/png",
    png.toString("base64"),
  );
  await assert.rejects(
    gateway.sendFollowup("ses_work", "look at this", [image.attachment_id]),
    { code: "MODEL_DOES_NOT_SUPPORT_ATTACHMENT_TYPE" },
  );
  assert.equal(state.promptCalls.length, 0);

  imageInput = true;
  await gateway.sendFollowup("ses_work", "look at this", [image.attachment_id]);
  state.statuses = {};
  const image2 = await gateway.uploadAttachment(
    "ses_work",
    "mockup.png",
    "image/png",
    png.toString("base64"),
  );
  await gateway.sendMessage("ses_work", "look at this", [image2.attachment_id]);
  assert.equal(submittedParts.length, 2);
  assert.deepEqual(submittedParts[0], submittedParts[1]);

  const textBytes = Buffer.from("# Follow-up note\nCheck the corner case.\n");
  const note = await gateway.uploadAttachment(
    "ses_work",
    "note.md",
    "text/markdown",
    textBytes.toString("base64"),
  );
  state.statuses["ses_work"] = { type: "busy" };
  await gateway.sendFollowup("ses_work", "with notes", [note.attachment_id]);
  const parts = (submittedParts[2] ?? []) as Array<Record<string, unknown>>;
  assert.equal(parts[0]?.text, "with notes");
  assert.equal(parts[1]?.type, "text");
  assert.ok(String(parts[1]?.text).includes("[Attachment: note.md (text/markdown)]"));
  assert.ok(String(parts[1]?.text).includes("Check the corner case."));
});

test("W1: follow-up validates message bounds and session confinement", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  await assert.rejects(gateway.sendFollowup("ses_work", ""), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(gateway.sendFollowup("ses_work", "x".repeat(32_001)), {
    code: "INVALID_ARGUMENT",
  });
  await assert.rejects(gateway.sendFollowup("ses_ghost", "foreign"), {
    code: "SESSION_NOT_FOUND",
  });
  assert.equal(state.promptCalls.length, 0);
});

test("W1: abort verifies the stored aborted assistant and never claims completion", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  state.messages.push(stored("user_t", "long task"));
  const active = activeAssistant("assist_t", "user_t");
  state.messages.push(active);
  state.abort = async () => {
    active.info.error = { name: "MessageAbortedError" };
    delete state.statuses["ses_work"];
    return { data: true };
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());

  const result = await gateway.abortSessionTurn("ses_work");
  assert.equal(result.state, "aborted");
  assert.equal(result.aborted_message_id, "assist_t");
  assert.equal(result.activity_after, "idle");
  assert.equal(state.abortCalls.length, 1);
  assert.equal(state.abortCalls[0]?.sessionID, "ses_work");
  assert.match(result.guidance ?? "", /nothing was rolled back/u);
  assert.ok(!["completed", "passed", "failed"].includes(result.state));
});

test("W1: abort on an idle session is a non-destructive no_active_turn without a backend write", async (t) => {
  const state = baseState();
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  const result = await gateway.abortSessionTurn("ses_work");
  assert.equal(result.state, "no_active_turn");
  assert.equal(result.aborted_message_id, undefined);
  assert.equal(result.activity_after, "idle");
  assert.deepEqual(result.pending_input_after, { permissions: 0, questions: 0, coverage: "session+descendants" });
  assert.match(result.guidance ?? "", /non-destructive/u);
  assert.equal(state.abortCalls.length, 0);
});

test("W1: abort is allowed while a v1 permission is pending and reports it cleared", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  state.v1Permissions = [{ id: "per_1", sessionID: "ses_work", permission: "bash" }];
  state.messages.push(stored("user_p", "tool task"));
  const active = activeAssistant("assist_p", "user_p");
  state.messages.push(active);
  state.abort = async () => {
    active.info.error = { name: "MessageAbortedError" };
    state.v1Permissions = [];
    delete state.statuses["ses_work"];
    return { data: true };
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  const result = await gateway.abortSessionTurn("ses_work");
  assert.equal(result.state, "aborted");
  assert.deepEqual(result.pending_input_after, { permissions: 0, questions: 0, coverage: "session+descendants" });
});

test("W1: abort racing a self-completing turn stays abort_uncertain", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  state.messages.push(stored("user_r", "fast task"));
  const active = activeAssistant("assist_r", "user_r");
  state.messages.push(active);
  state.abort = async () => {
    active.info.finish = "stop";
    delete state.statuses["ses_work"];
    return { data: true };
  };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  const result = await gateway.abortSessionTurn("ses_work");
  assert.equal(result.state, "abort_uncertain");
  assert.equal(result.aborted_message_id, undefined);
  assert.match(result.guidance ?? "", /terminal state/u);
});

test("W1: abort without verifiable evidence within the budget stays abort_uncertain", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  state.messages.push(stored("user_u", "stuck task"));
  state.messages.push(activeAssistant("assist_u", "user_u"));
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  setAbortSeams(gateway, 200, 50);
  const result = await gateway.abortSessionTurn("ses_work");
  assert.equal(result.state, "abort_uncertain");
  assert.equal(result.activity_after, "busy");
  assert.equal(state.abortCalls.length, 1);
  assert.match(result.guidance ?? "", /could not be verified/u);
});

test("W1: abort does not misattribute a pre-existing aborted turn", async () => {
  // (a) a NEW aborted marker on the running turn is attributed correctly even
  // though an older aborted turn exists in history.
  const s1 = baseState();
  s1.statuses["ses_work"] = { type: "busy" };
  s1.messages.push(stored("user_old", "old task"));
  s1.messages.push(abortedAssistant("assist_old", "user_old"));
  s1.messages.push(stored("user_new", "new task"));
  const activeNew = activeAssistant("assist_new", "user_new");
  s1.messages.push(activeNew);
  s1.abort = async () => {
    activeNew.info.error = { name: "MessageAbortedError" };
    delete s1.statuses["ses_work"];
    return { data: true };
  };
  const g1 = new OpenCodeGateway(runtime(), fakeClient(s1) as never);
  const r1 = await g1.abortSessionTurn("ses_work");
  assert.equal(r1.state, "aborted");
  assert.equal(r1.aborted_message_id, "assist_new");
  await g1.close();

  // (b) when the newest assistant was ALREADY aborted before the call and the
  // backend changes nothing, the stale marker is never re-reported as this
  // call's abort.
  const s2 = baseState();
  s2.statuses["ses_work"] = { type: "busy" };
  s2.messages.push(stored("user_x", "task"));
  s2.messages.push(abortedAssistant("assist_x", "user_x"));
  const g2 = new OpenCodeGateway(runtime(), fakeClient(s2) as never);
  setAbortSeams(g2, 200, 50);
  const r2 = await g2.abortSessionTurn("ses_work");
  assert.equal(r2.state, "abort_uncertain");
  assert.equal(r2.aborted_message_id, undefined);
  await g2.close();
});

test("W1: send_message keeps its exact SESSION_BUSY semantics on a busy session", async (t) => {
  const state = baseState();
  state.statuses["ses_work"] = { type: "busy" };
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  t.after(() => gateway.close());
  await assert.rejects(gateway.sendMessage("ses_work", "normal task"), {
    code: "SESSION_BUSY",
    reason: "backend_active",
  });
  assert.equal(state.promptCalls.length, 0);
});

test("descendant pending permissions are counted and attributed in root pending input", async () => {
  const state = baseState();
  state.sessions.push(
    session("ses_child", { parentID: "ses_work" }),
    session("ses_other_root"),
  );
  state.statuses.ses_child = { type: "busy" };
  state.v1Permissions = [
    { id: "per_child", sessionID: "ses_child", permission: "external_directory" },
    { id: "per_other", sessionID: "ses_other_root", permission: "external_directory" },
  ];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const pending = await gateway.getCombinedPendingInput("ses_work");
  assert.equal(pending.permissions, 1);
  assert.equal(pending.coverage, "session+descendants");
  assert.deepEqual(pending.descendant_permissions, [
    { session_id: "ses_child", permission: "external_directory" },
  ]);
  const status = await gateway.getSessionStatus("ses_work");
  assert.equal(status.pending_input.permissions, 1);
  assert.equal(status.pending_input_scope, "session+descendants");
});

test("unverifiable descendant coverage is reported as unknown, never as a clean zero verdict", async () => {
  const state = baseState();
  state.v1Permissions = [
    { id: "per_child", sessionID: "ses_child", permission: "external_directory" },
  ];
  const client = fakeClient(state) as { project: Record<string, unknown> };
  delete client.project.directories;
  const gateway = new OpenCodeGateway(runtime(), client as never);
  const pending = await gateway.getCombinedPendingInput("ses_work");
  assert.equal(pending.coverage, "unknown");
  assert.equal(pending.descendant_permissions, undefined);
});

test("permission emergency: V1 root Ask is visible across status/progress/activity/MCP and blocks admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocvm-pending-root-"));
  const state = baseState();
  state.messages = [stored("user", "Read fixture"), stored("answer", "waiting", "user")];
  state.v1Permissions = [{ id: "per_native", sessionID: "ses_work", permission: "read", tool: { messageID: "answer", callID: "call_read" } }];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const adapter = new McpHttpServer({ ...runtime(), listenPort: 0 }, "x".repeat(64), gateway);
  const client = new Client({ name: "pending-root", version: "1" });
  try {
    await gateway.enableActivity(join(dir, "activity.json"));
    await gateway.captureActivity("ses_work");
    assert.equal((await gateway.getSessionDetails("ses_work")).pending_input.permissions, 1);
    assert.equal((await gateway.getSessionStatus("ses_work")).pending_input.permissions, 1);
    assert.equal((await gateway.getSessionStatus("ses_work", "user")).state, "input_required", "V1 tool.messageID is correlated like V2 source.messageID");
    assert.equal((await gateway.getSessionProgress("ses_work")).pending_input.permissions, 1);
    assert.equal((await gateway.getCombinedPendingInput("ses_work")).permissions, 1);
    const activity = await gateway.getProjectActivity({ tail: true });
    assert.ok(activity.events.some(event => event.pending_input?.permissions === 1));
    const attention = await gateway.getProjectAttention({});
    assert.ok(attention.entries.some(entry => entry.event_type === "session.input_required" && entry.lifecycle !== "superseded"), "a visible V1 Ask must not disappear during attention prefetch");
    const port = await adapter.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { "X-OCVM-MCP-Token": "x".repeat(64) } } }));
    for (const name of ["get_session", "get_session_status", "get_session_progress"]) {
      const reply = await client.callTool({ name, arguments: { session_id: "ses_work" } });
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      assert.equal((reply.structuredContent as { pending_input: { permissions: number } }).pending_input.permissions, 1);
    }
    const rejected = await client.callTool({ name: "send_message", arguments: { session_id: "ses_work", message: "must not admit" } });
    assert.equal(rejected.isError, true);
    assert.equal(state.promptCalls.length, 0);
  } finally { await client.close(); await adapter.close(); await gateway.close(); await rm(dir, { recursive: true, force: true }); }
});

test("permission emergency: deduplicates V1/V2 IDs, counts child Questions and excludes proven foreign roots", async () => {
  const state = baseState();
  state.sessions.push(session("ses_child", { parentID: "ses_work" }), session("ses_foreign"));
  state.permissions = [{ id: "per_root", sessionID: "ses_work", permission: "read" }];
  state.v1Permissions = [state.permissions[0]!, { id: "per_child", sessionID: "ses_child", permission: "read" }, { id: "per_foreign", sessionID: "ses_foreign" }];
  state.questions = [{ id: "q_root", sessionID: "ses_work" }];
  state.v1Questions = [state.questions[0]!, { id: "q_child", sessionID: "ses_child" }, { id: "q_foreign", sessionID: "ses_foreign" }];
  const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
  const pending = await gateway.getCombinedPendingInput("ses_work");
  assert.equal(pending.permissions, 2);
  assert.equal(pending.questions, 2);
  assert.equal(pending.coverage, "session+descendants");
  assert.deepEqual(pending.descendant_permissions, [{ session_id: "ses_child", permission: "read" }]);
  assert.deepEqual((await gateway.getSessionDetails("ses_work")).pending_input, pending);
});

test("permission emergency: missing native coverage is unknown and holds sends, not a clean zero", async () => {
  const state = baseState();
  const client = fakeClient(state) as { permission: { list: () => Promise<unknown> } };
  client.permission.list = async () => { throw new Error("native pending read unavailable"); };
  const gateway = new OpenCodeGateway(runtime(), client as never);
  assert.equal((await gateway.getSessionStatus("ses_work")).pending_input.coverage, "unknown");
  assert.equal((await gateway.getCombinedPendingInput("ses_work")).coverage, "unknown");
  await assert.rejects(gateway.sendMessage("ses_work", "not admitted"), { code: "BACKEND_UNAVAILABLE" });
  assert.equal(state.promptCalls.length, 0);
});

test("single-file declarations validate exact canonical regular files before any creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocvm-read-files-"));
  const file = join(dir, "route.env");
  try {
    await writeFile(file, "PORT=1234\nDB=fixture\n");
    await symlink(file, join(dir, "alias.env"));
    assert.deepEqual(await validateScopeReadFiles([file, file]), [file]);
    for (const input of [[], ["relative.env"], ["/"], [file + "/*"], [file + "/"], [join(dir, "alias.env")], [dir], [join(dir, "missing.env")]])
      await assert.rejects(validateScopeReadFiles(input), { code: "INVALID_ARGUMENT" });
    const state = baseState();
    const gateway = new OpenCodeGateway(runtime(), fakeClient(state) as never);
    const before = state.sessions.length;
    await assert.rejects(gateway.createSession("invalid files", undefined, [join(dir, "missing.env")]), { code: "INVALID_ARGUMENT" });
    assert.equal(state.sessions.length, before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("validateScopeDirs enforces the managed plugin contract fail-fast", () => {
  assert.deepEqual(validateScopeDirs(["/srv/data", "/srv/data/"]), ["/srv/data"], "normalized duplicates dedupe like the plugin merge");
  assert.throws(() => validateScopeDirs([]), /non-empty/u);
  assert.throws(() => validateScopeDirs(Array.from({ length: 17 }, (_, i) => `/d/${i}`)), /at most 16/u);
  assert.throws(() => validateScopeDirs(["relative/path"]), /absolute/u);
  assert.throws(() => validateScopeDirs(["/"]), /normalized/u);
  assert.throws(() => validateScopeDirs(["/a/../b"]), /normalized/u);
  assert.throws(() => validateScopeDirs(["/a\0b"]), /absolute/u);
  assert.throws(() => validateScopeDirs(["no-string" as never]), /absolute/u);
});

test("adoptManagedSession forwards authorized scope_dirs over the managed socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocvm-adopt-"));
  const socketPath = join(dir, "managed.sock");
  const received: unknown[] = [];
  const server = unixServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      received.push(JSON.parse(buffer.slice(split + 4)));
      const input = received.at(-1) as { scope_read_files?: string[] };
      const body = JSON.stringify({ session_id: "ses_work", agent_managed: true, revision: 1,
        ...(input.scope_read_files && !input.scope_read_files.includes("/tmp/opencode/unsupported.env") ? { scope_read_files: input.scope_read_files } : {}) });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const previous = process.env.OCVM_MANAGED_POLICY_SOCKET;
  process.env.OCVM_MANAGED_POLICY_SOCKET = socketPath;
  try {
    const gateway = new OpenCodeGateway(runtime(), fakeClient(baseState()) as never);
    await (ProductionGateway.prototype as unknown as { adoptManagedSession(id: string, dirs?: string[]): Promise<void> }).adoptManagedSession.call(gateway, "ses_work", ["/srv/data"]);
    await (ProductionGateway.prototype as unknown as { adoptManagedSession(id: string, dirs?: string[]): Promise<void> }).adoptManagedSession.call(gateway, "ses_work");
    await (ProductionGateway.prototype as unknown as { adoptManagedSession(id: string, dirs?: string[], files?: string[]): Promise<void> }).adoptManagedSession.call(gateway, "ses_work", undefined, ["/tmp/opencode/route.env"]);
    await assert.rejects((ProductionGateway.prototype as unknown as { adoptManagedSession(id: string, dirs?: string[], files?: string[]): Promise<void> }).adoptManagedSession.call(gateway, "ses_work", undefined, ["/tmp/opencode/unsupported.env"]), { code: "BACKEND_INCOMPATIBLE" }, "old loaded policy must not silently ignore the declaration");
    await gateway.close();
    assert.equal(received.length, 4);
    assert.deepEqual(received[0], { session_id: "ses_work", ingress: "mcp", scope_dirs: ["/srv/data"] });
    assert.deepEqual(received[1], { session_id: "ses_work", ingress: "mcp" });
    assert.deepEqual(received[2], { session_id: "ses_work", ingress: "mcp", scope_read_files: ["/tmp/opencode/route.env"] });
  } finally {
    if (previous === undefined) delete process.env.OCVM_MANAGED_POLICY_SOCKET;
    else process.env.OCVM_MANAGED_POLICY_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession derives guest worktree scope and creates checkout when no explicit scope_dirs provided", async () => {
  // This test calls the REAL createSession product function and verifies:
  // 1. The guest-native worktree root is included in scope_dirs.
  // 2. A real git worktree checkout is created at the guest path.
  // If the product integration is missing, either assertion fails.
  const dir = await mkdtemp(join(tmpdir(), "ocvm-guest-scope-"));
  const projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", projectDir], { stdio: "pipe" });
  execFileSync("git", ["-C", projectDir, "-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "pipe" });
  const socketPath = join(dir, "managed.sock");
  const guestRoot = join(dir, "guest-wt-root");
  const received: unknown[] = [];
  const server = unixServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      received.push(JSON.parse(buffer.slice(split + 4)));
      const body = JSON.stringify({ session_id: "ses_created", agent_managed: true, revision: 1 });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const prevSocket = process.env.OCVM_MANAGED_POLICY_SOCKET;
  const prevRoot = process.env.OCVM_WORKTREE_ROOT;
  process.env.OCVM_MANAGED_POLICY_SOCKET = socketPath;
  process.env.OCVM_WORKTREE_ROOT = guestRoot;
  try {
    const state = baseState();
    const gateway = new ProductionGateway(runtime(undefined, projectDir), fakeClient(state, projectDir) as never);
    let createError: Error | undefined;
    try {
      await gateway.createSession("guest-scope-test");
    } catch (e) {
      createError = e as Error;
    }
    await gateway.close();
    if (createError) {
      assert.fail(`createSession failed: ${createError.message}`);
    }
    // 1. Scope must include guest root.
    assert.ok(received.length >= 1, `adoptManagedSession must be called (received=${received.length})`);
    const first = received[0] as Record<string, unknown>;
    assert.ok("scope_dirs" in first, "scope_dirs must be present (guest root integration)");
    assert.ok(Array.isArray(first.scope_dirs), "scope_dirs must be an array");
    const dirs = first.scope_dirs as string[];
    assert.ok(dirs.some((d) => d.startsWith(guestRoot)), `scope_dirs must contain guest root ${guestRoot}, got: ${JSON.stringify(dirs)}`);
    // 2. Real worktree checkout must exist at guest path.
    const hash = runtime().projectHash;
    const checkoutPath = join(guestRoot, hash, "ses_created");
    const gitFile = join(checkoutPath, ".git");
    const st = await lstat(gitFile).catch(() => undefined);
    assert.ok(st, `worktree checkout must exist at ${checkoutPath} (found .git: ${st !== undefined})`);
  } finally {
    if (prevSocket === undefined) delete process.env.OCVM_MANAGED_POLICY_SOCKET;
    else process.env.OCVM_MANAGED_POLICY_SOCKET = prevSocket;
    if (prevRoot === undefined) delete process.env.OCVM_WORKTREE_ROOT;
    else process.env.OCVM_WORKTREE_ROOT = prevRoot;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession uses explicit scope_dirs and does not override with guest root", async () => {
  // Explicit scope_dirs must win over the derived guest root.
  const dir = await mkdtemp(join(tmpdir(), "ocvm-explicit-scope-"));
  const projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", projectDir], { stdio: "pipe" });
  execFileSync("git", ["-C", projectDir, "-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "pipe" });
  const socketPath = join(dir, "managed.sock");
  const guestRoot = join(dir, "guest-wt-root");
  const received: unknown[] = [];
  const server = unixServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      received.push(JSON.parse(buffer.slice(split + 4)));
      const body = JSON.stringify({ session_id: "ses_created", agent_managed: true, revision: 1 });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const prevSocket = process.env.OCVM_MANAGED_POLICY_SOCKET;
  const prevRoot = process.env.OCVM_WORKTREE_ROOT;
  process.env.OCVM_MANAGED_POLICY_SOCKET = socketPath;
  process.env.OCVM_WORKTREE_ROOT = guestRoot;
  try {
    const state = baseState();
    const gateway = new ProductionGateway(runtime(undefined, projectDir), fakeClient(state, projectDir) as never);
    // Explicit scope_dirs must NOT be overridden by guest root.
    await gateway.createSession("explicit-scope-test", ["/srv/data"]);
    await gateway.close();
    const first = received[0] as Record<string, unknown>;
    assert.ok("scope_dirs" in first, "scope_dirs must be present");
    assert.deepEqual(first.scope_dirs, ["/srv/data"], "explicit scope_dirs must be preserved");
  } finally {
    if (prevSocket === undefined) delete process.env.OCVM_MANAGED_POLICY_SOCKET;
    else process.env.OCVM_MANAGED_POLICY_SOCKET = prevSocket;
    if (prevRoot === undefined) delete process.env.OCVM_WORKTREE_ROOT;
    else process.env.OCVM_WORKTREE_ROOT = prevRoot;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession reports CREATION_UNCERTAIN when guest worktree creation fails", async () => {
  // When OCVM_WORKTREE_ROOT is configured and git worktree add fails,
  // createSession must NOT silently swallow the error and report state=created.
  // The session already exists, so the error is CREATION_UNCERTAIN (inspect
  // before retrying).  This is the honest visible failure for activated
  // guest placement.
  const dir = await mkdtemp(join(tmpdir(), "ocvm-guest-fail-"));
  const projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  // No git init — worktree add will fail because there is no repository.
  const socketPath = join(dir, "managed.sock");
  const guestRoot = join(dir, "guest-wt-root");
  const received: unknown[] = [];
  const server = unixServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      received.push(JSON.parse(buffer.slice(split + 4)));
      const body = JSON.stringify({ session_id: "ses_created", agent_managed: true, revision: 1 });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const prevSocket = process.env.OCVM_MANAGED_POLICY_SOCKET;
  const prevRoot = process.env.OCVM_WORKTREE_ROOT;
  process.env.OCVM_MANAGED_POLICY_SOCKET = socketPath;
  process.env.OCVM_WORKTREE_ROOT = guestRoot;
  try {
    const state = baseState();
    const gateway = new ProductionGateway(runtime(undefined, projectDir), fakeClient(state, projectDir) as never);
    let createError: Error | undefined;
    try {
      await gateway.createSession("guest-fail-test");
    } catch (e) {
      createError = e as Error;
    }
    await gateway.close();
    // Must throw CREATION_UNCERTAIN — not silently return state=created.
    assert.ok(createError, "createSession must fail when guest worktree creation fails");
    assert.match(createError.message, /confirmation failed|could not be confirmed/i, `error must be CREATION_UNCERTAIN, got: ${createError.message}`);
  } finally {
    if (prevSocket === undefined) delete process.env.OCVM_MANAGED_POLICY_SOCKET;
    else process.env.OCVM_MANAGED_POLICY_SOCKET = prevSocket;
    if (prevRoot === undefined) delete process.env.OCVM_WORKTREE_ROOT;
    else process.env.OCVM_WORKTREE_ROOT = prevRoot;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("deriveGuestWorktreeScope rejects relative and traversal paths", async () => {
  // SET-but-invalid OCVM_WORKTREE_ROOT must throw INVALID_ARGUMENT, not
  // silently return undefined (which would mean "not activated").
  const dir = await mkdtemp(join(tmpdir(), "ocvm-invalid-root-"));
  const projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", projectDir], { stdio: "pipe" });
  execFileSync("git", ["-C", projectDir, "-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "pipe" });
  const socketPath = join(dir, "managed.sock");
  const received: unknown[] = [];
  const server = unixServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      received.push(JSON.parse(buffer.slice(split + 4)));
      const body = JSON.stringify({ session_id: "ses_created", agent_managed: true, revision: 1 });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const prevSocket = process.env.OCVM_MANAGED_POLICY_SOCKET;
  const prevRoot = process.env.OCVM_WORKTREE_ROOT;
  process.env.OCVM_MANAGED_POLICY_SOCKET = socketPath;
  for (const bad of ["relative/path", "/tmp/foo/../bar", "/"]) {
    process.env.OCVM_WORKTREE_ROOT = bad;
    try {
      const state = baseState();
      const gateway = new ProductionGateway(runtime(undefined, projectDir), fakeClient(state, projectDir) as never);
      let createError: Error | undefined;
      try {
        await gateway.createSession("invalid-root-test");
      } catch (e) {
        createError = e as Error;
      }
      await gateway.close();
      assert.ok(createError, `must throw for OCVM_WORKTREE_ROOT=${JSON.stringify(bad)}`);
    } finally { /* per-iteration */ }
  }
  if (prevSocket === undefined) delete process.env.OCVM_MANAGED_POLICY_SOCKET;
  else process.env.OCVM_MANAGED_POLICY_SOCKET = prevSocket;
  if (prevRoot === undefined) delete process.env.OCVM_WORKTREE_ROOT;
  else process.env.OCVM_WORKTREE_ROOT = prevRoot;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

test("createGuestWorktree rejects unsafe session ID segments", async () => {
  // Session IDs that could escape the guest root must be rejected.
  const dir = await mkdtemp(join(tmpdir(), "ocvm-session-seg-"));
  const projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", projectDir], { stdio: "pipe" });
  execFileSync("git", ["-C", projectDir, "-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "pipe" });
  const socketPath = join(dir, "managed.sock");
  const received: unknown[] = [];
  const server = unixServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      received.push(JSON.parse(buffer.slice(split + 4)));
      const body = JSON.stringify({ session_id: "ses_created", agent_managed: true, revision: 1 });
      socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const prevSocket = process.env.OCVM_MANAGED_POLICY_SOCKET;
  const prevRoot = process.env.OCVM_WORKTREE_ROOT;
  process.env.OCVM_MANAGED_POLICY_SOCKET = socketPath;
  process.env.OCVM_WORKTREE_ROOT = join(dir, "guest-root");
  try {
    const state = baseState();
    state.create = async () => ({ data: { id: "../../etc/passwd" } });
    const gateway = new ProductionGateway(runtime(undefined, projectDir), fakeClient(state, projectDir) as never);
    let createError: Error | undefined;
    try {
      await gateway.createSession("unsafe-seg-test");
    } catch (e) {
      createError = e as Error;
    }
    await gateway.close();
    assert.ok(createError, "createSession must reject unsafe session ID");
  } finally {
    if (prevSocket === undefined) delete process.env.OCVM_MANAGED_POLICY_SOCKET;
    else process.env.OCVM_MANAGED_POLICY_SOCKET = prevSocket;
    if (prevRoot === undefined) delete process.env.OCVM_WORKTREE_ROOT;
    else process.env.OCVM_WORKTREE_ROOT = prevRoot;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
