import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdir, readFile, writeFile, rename, lstat, unlink, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { policyDelta, remoteWrite, tokens, handback, PRIMER, COMMIT_SENTENCE, LEGACY_VM_ASK, MANAGED_VM_ASK, protocol, questionInResponse, responseUsage, terminalResponse, REVISION } from "./managed-core.mjs";

const FETCH_STATE = Symbol.for("ocvm.managed.fetch.v1");
const HEADER = "x-ocvm-managed-turn";
const MAX_STEP_BYTES = 8 * 1024 * 1024;
const SUPPORTED = /(?:openai|anthropic|azure|google|openrouter|xai|mistral|groq|deepinfra|cerebras|togetherai|perplexity|alibaba|venice|copilot|amazon-bedrock\/mantle)/;
const exec = promisify(execFile);

// Gate one provider step before the SDK can dispatch a native Question. The
// terminal stream is consumed/persisted/completed by the real OpenCode runner;
// no DB mutation, question reply, session abort, model retry or fake user turn.
function installCompletionGate() {
  if (globalThis[FETCH_STATE]) return globalThis[FETCH_STATE];
  const original = globalThis.fetch;
  const state = { turns: new Map() };
  globalThis[FETCH_STATE] = state;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const key = headers.get(HEADER);
    if (!key) return original(input, init);
    headers.delete(HEADER); // never disclose local correlation to a model provider
    const turn = state.turns.get(key);
    if (!turn) throw new Error("MANAGED_COMPLETION_TURN_UNKNOWN");
    const bodyText = init?.body ?? (input instanceof Request ? await input.clone().text() : "{}");
    let body;
    try { body = JSON.parse(bodyText); } catch { throw new Error("MANAGED_COMPLETION_REQUEST_INVALID"); }
    const url = String(input instanceof Request ? input.url : input);
    const kind = protocol(body, url, turn.family);
    if (!kind) throw new Error("MANAGED_COMPLETION_PROTOCOL_UNSUPPORTED");
    const streaming = body.stream !== false && !url.includes(":generateContent");
    if (turn.report) return terminalResponse(turn.report, kind, streaming);
    const response = await original(input, { ...init, headers });
    if (!response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_STEP_BYTES) throw new Error("MANAGED_COMPLETION_STEP_LIMIT");
        chunks.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const raw = Buffer.concat(chunks.map(c => Buffer.from(c)));
    const blocked = questionInResponse(raw.toString("utf8"), kind);
    if (blocked) {
      turn.report = blocked.report;
      return terminalResponse(turn.report, kind, streaming, responseUsage(raw.toString("utf8"), kind));
    }
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return state;
}

export default async ({ client, directory }) => {
  const socket = process.env.OCVM_MANAGED_POLICY_SOCKET;
  if (!socket) return {}; // ordinary standalone OpenCode remains unchanged
  const project = resolve(directory);
  const hash = createHash("sha256").update(project).digest("hex");
  const store = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME, ".local/share"), "opencode", "managed-sessions", `${hash}.json`);
  await mkdir(dirname(store), { recursive: true, mode: 0o700 });
  let saved = { schema: 1, project, sessions: {} };
  try {
    const info = await lstat(store);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("MANAGED_STATE_INVALID");
    saved = JSON.parse(await readFile(store, "utf8"));
    if (saved.schema !== 1 || saved.project !== project || !saved.sessions || typeof saved.sessions !== "object" || Array.isArray(saved.sessions)) throw new Error("MANAGED_STATE_INVALID");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const fetchState = installCompletionGate();
  // PluginInput uses the legacy SDK (nested path params, old generated schema).
  // Its raw client preserves OpenCode's authenticated/in-process fetch while
  // addressing the verified V1 native endpoints explicitly.
  const api = async (method, url, body, query = {}) => {
    const result = await client._client.request({ method, url, query: { directory, ...query }, ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }), throwOnError: true });
    return result.data;
  };
  const turnKeys = new Set();
  let queue = Promise.resolve();
  const serial = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  const persist = async () => {
    const tmp = `${store}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
    await rename(tmp, store);
  };
  const getSession = async id => {
    if (typeof id !== "string" || !/^ses_[A-Za-z0-9_-]{1,250}$/.test(id)) throw new Error("MANAGED_SESSION_INVALID");
    const info = await api("GET", `/session/${id}`);
    const location = info?.directory ?? info?.location?.directory;
    if (!info || typeof location !== "string" || resolve(location) !== project || info.time?.archived) throw new Error("MANAGED_SESSION_NOT_EXPOSED");
    return info;
  };
  const idle = async id => {
    const [status, questions, permissions] = await Promise.all([api("GET", "/session/status"), api("GET", "/question"), api("GET", "/permission")]);
    if ([...(questions ?? []), ...(permissions ?? [])].some(item => item.sessionID === id)) throw new Error("MANAGED_INPUT_PENDING");
    if (status?.[id]?.type && status[id].type !== "idle") throw new Error("MANAGED_SESSION_BUSY");
  };
  const prepare = async (id, agentName, checkIdle = false) => {
    const info = await getSession(id);
    if (checkIdle) await idle(id);
    const [agents, config] = await Promise.all([api("GET", "/agent"), api("GET", "/config")]);
    const agent = agents.find(item => item.name === (agentName ?? info.agent ?? config.default_agent ?? "build"));
    if (!agent || agent.name === "openlive-manager") throw new Error("MANAGED_AGENT_INVALID");
    const current = info.permission ?? [];
    const previous = saved.sessions[id];
    const entry = previous ? structuredClone(previous) : { revision: REVISION, adoptedAt: new Date().toISOString(), base: current, disabled: {}, lastNative: current };
    if (!Array.isArray(entry.base) || !Array.isArray(entry.lastNative)) throw new Error("MANAGED_STATE_REVISION_UNSUPPORTED");
    const prefix = entry.lastNative.every((r, i) => current[i]?.permission === r.permission && current[i]?.pattern === r.pattern && current[i]?.action === r.action);
    if (!prefix) throw new Error("MANAGED_POLICY_REPLACED_EXTERNALLY");
    // Actual external PATCH appends are preserved separately from our owned
    // blocks. Re-applying/changing an agent never adopts our own previous rules
    // as new task restrictions and never accumulates on an unchanged readback.
    entry.base = [...entry.base, ...current.slice(entry.lastNative.length)];
    const scope = [...entry.base, ...Object.entries(entry.disabled).filter(([, value]) => value).map(([permission]) => ({ permission, pattern: "*", action: "deny" }))];
    const delta = policyDelta(current, agent.permission ?? [], scope);
    if (delta.length) {
      await api("PATCH", `/session/${id}`, { permission: delta });
      const verified = await getSession(id);
      if (policyDelta(verified.permission ?? [], agent.permission ?? [], scope).length) throw new Error("MANAGED_POLICY_READBACK_FAILED");
      entry.lastNative = verified.permission ?? [];
    }
    if (!saved.sessions[id] || delta.length) {
      saved.sessions[id] = entry;
      try { await persist(); }
      catch (error) { if (previous) saved.sessions[id] = previous; else delete saved.sessions[id]; throw error; }
    }
    return { session_id: id, revision: REVISION, agent_managed: true };
  };
  const isManaged = async id => {
    const seen = new Set();
    for (let depth = 0; depth < 32; depth++) {
      if (saved.sessions[id]) return true;
      if (seen.has(id)) throw new Error("MANAGED_PARENT_CYCLE");
      seen.add(id);
      const info = await getSession(id);
      if (info.agent === "openlive-manager") return false;
      if (!info.parentID) return false;
      id = info.parentID;
    }
    throw new Error("MANAGED_PARENT_LIMIT");
  };
  const deniedWrite = async (command, cwd = directory) => {
    if (remoteWrite(command)) return true;
    if (!command.includes("git")) return false;
    const words = tokens(command);
    const prefixes = [[]];
    for (let i = 0; i < words.length; i++) {
      if (words[i].split("/").at(-1) !== "git") continue;
      const prefix = [];
      for (let j = i + 1; j < words.length && words[j].startsWith("-"); j++) {
        prefix.push(words[j]);
        if (["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--config-env"].includes(words[j])) prefix.push(words[++j]);
      }
      prefixes.push(prefix);
    }
    if (prefixes.length > 16) throw new Error("REMOTE_POLICY_COMMAND_LIMIT");
    for (const prefix of prefixes) {
      let output;
      try { output = (await exec("git", [...prefix, "config", "--null", "--get-regexp", "^alias\\."], { cwd, timeout: 2000, maxBuffer: 64 * 1024 })).stdout; }
      catch (error) { if ([1, 128].includes(error.code)) continue; throw error; }
      const aliases = {};
      for (const record of output.split("\0")) {
        const newline = record.indexOf("\n");
        if (newline >= 0) aliases[record.slice(6, newline)] = record.slice(newline + 1);
      }
      if (remoteWrite(command, aliases)) return true;
    }
    return false;
  };

  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(socket);
    if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("MANAGED_SOCKET_UNSAFE");
    const alive = await new Promise(res => { const c = connect(socket); c.once("connect", () => { c.destroy(); res(true); }); c.once("error", () => res(false)); });
    if (alive) throw new Error("MANAGED_SOCKET_ALREADY_OWNED");
    await unlink(socket);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ revision: REVISION, project })); return;
      }
      if (req.method !== "POST" || req.url !== "/adopt") throw new Error("MANAGED_OPERATION_INVALID");
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error("MANAGED_REQUEST_LIMIT"); }
      const input = JSON.parse(body);
      if (!["mcp", "openlive", "a2a"].includes(input.ingress)) throw new Error("MANAGED_INGRESS_INVALID");
      const result = await serial(() => prepare(input.session_id, undefined, true));
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 409; res.end(JSON.stringify({ error: String(error.message).slice(0, 200) })); }
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen(socket, yes); });
  await chmod(socket, 0o600);
  return {
    dispose: async () => {
      for (const key of turnKeys) fetchState.turns.delete(key);
      await new Promise(res => server.close(res));
      await unlink(socket).catch(() => {});
    },
    "chat.message": async ({ sessionID }, { message }) => {
      if (!await isManaged(sessionID)) return;
      await serial(async () => {
        await prepare(sessionID, message.agent);
        if (message.tools && Object.keys(message.tools).length) {
          const visible = { ...message.tools };
          // V1 would otherwise replace *all* session rules after this hook.
          // Mutate that original input object; keep controls on the stored user
          // message and persist explicit disables through our own rule owner.
          for (const [tool, enabled] of Object.entries(visible)) {
            if (tool !== "question") saved.sessions[sessionID].disabled[tool] = enabled === false;
            delete message.tools[tool];
          }
          message.tools = visible;
          await prepare(sessionID, message.agent);
        }
      });
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (sessionID && await isManaged(sessionID)) {
        for (let i = 0; i < output.system.length; i++) output.system[i] = output.system[i].replace(LEGACY_VM_ASK, MANAGED_VM_ASK).replace(COMMIT_SENTENCE, "");
        output.system.push(PRIMER);
      }
    },
    "tool.definition": async ({ toolID }, output) => {
      if (toolID === "bash" && output.description.includes(COMMIT_SENTENCE)) output.description = output.description.replace(COMMIT_SENTENCE, "");
    },
    "chat.headers": async ({ sessionID, message, model, agent }, output) => {
      if (agent === "openlive-manager" || ["title", "summary", "compaction"].includes(agent) || !await isManaged(sessionID)) return;
      if (!SUPPORTED.test(model.api.npm)) throw new Error(`MANAGED_COMPLETION_TRANSPORT_UNSUPPORTED: ${model.api.npm}`);
      const key = `${hash}:${sessionID}:${message.id}`;
      fetchState.turns.set(key, fetchState.turns.get(key) ?? { sessionID, userID: message.id, family: model.api.npm });
      turnKeys.add(key);
      output.headers[HEADER] = key;
    },
    "tool.execute.before": async ({ tool, sessionID }, { args }) => {
      if (!await isManaged(sessionID)) return;
      if (tool === "task" && args.task_id) await serial(() => prepare(args.task_id, undefined, !saved.sessions[args.task_id]));
      if (tool === "question" || tool === "invalid" && args.tool === "question") {
        for (const key of turnKeys) { const turn = fetchState.turns.get(key); if (turn?.sessionID === sessionID) turn.report = handback(args.questions); }
        throw new Error("INPUT_REQUIRED: business question suppressed by the managed completion gate");
      }
      if (tool === "bash" && await deniedWrite(args.command ?? "", args.workdir ?? directory)) throw new Error("REMOTE_WRITE_DENIED: publishing is operator-only, not approvable in the guest");
    },
    "shell.env": async ({ sessionID, callID }) => {
      if (!sessionID || !await isManaged(sessionID)) return;
      // Native /shell does not call tool.execute.before. It stores this exact
      // call before shell.env and before spawning: read that correlation, not
      // a shared current-command variable or a permission-cache decision.
      const history = await api("GET", `/session/${sessionID}/message`, undefined, { limit: 20 });
      const part = history.flatMap(item => item.parts ?? []).findLast(item => item.type === "tool" && item.callID === callID && item.state?.status === "running");
      if (!part || typeof part.state?.input?.command !== "string") throw new Error("MANAGED_SHELL_CORRELATION_UNAVAILABLE");
      if (await deniedWrite(part.state.input.command, part.state.input.workdir ?? directory)) throw new Error("REMOTE_WRITE_DENIED: direct shell publishing is operator-only");
    },
  };
};
