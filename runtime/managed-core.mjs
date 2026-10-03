// The VM/host credential and origin separation is the primary remote boundary.
// These rules are the additional OpenCode work-session behavior contract.
export const REVISION = 1;
export const PRIMER = `This work session is agent-managed by its backend ingress.
Follow the authorized task scope. Explicit read-only/review/task restrictions still apply.
Do not open questions, quizzes or other end-user dialogs. If a business decision is missing, end the turn with INPUT_REQUIRED, the concrete decision, context, safe options, completed work and paused work. The orchestrator supplies a normal follow-up in this same session.`;
export const COMMIT_SENTENCE = "Only commit, amend, push, or create PRs when explicitly requested.";
export const LEGACY_VM_ASK = "If the request is ambiguous or you see multiple reasonable interpretations, surface them and ask before implementing. If no user is available to ask (autonomous or A2A runs), choose the most minimal interpretation consistent with the request and state the assumption in your report.";
export const MANAGED_VM_ASK = "This is backend agent-managed work: document safe reversible assumptions within the authorized scope. If a business/product decision is missing, pause dependent work and return a terminal INPUT_REQUIRED report with question, context and options; the orchestrator supplies a normal follow-up. Do not open a native end-user question.";

const same = (a, b) => a.permission === b.permission && a.pattern === b.pattern && a.action === b.action;
const remoteRules = ["git push", "git push *", "git send-pack *", "git http-push *", "git receive-pack *", "git lfs push *", "git lfs upload *"].map(pattern => ({ permission: "bash", pattern, action: "deny" }));
export function restrictions(rules) {
  const independent = rules.filter(r => r.permission !== "question" && !remoteRules.some(remote => same(r, remote)));
  const denied = new Set(independent.filter(r => r.action === "deny").map(r => r.permission));
  return independent.filter(r => r.action === "deny" || r.permission !== "*" && (denied.has(r.permission) || denied.has("*")));
}
export function policyDelta(current, agentRules = [], scope = []) {
  const desired = [
    ...agentRules,
    ...scope,
    { permission: "bash", pattern: "git *", action: "allow" },
    { permission: "bash", pattern: "/usr/bin/git *", action: "allow" },
    { permission: "bash", pattern: "/bin/git *", action: "allow" },
    // Preserve task/agent denies; only the VM's ordinary commit asks are relaxed.
    ...restrictions(agentRules),
    ...restrictions(scope),
    { permission: "question", pattern: "*", action: "deny" },
    ...remoteRules,
  ];
  const suffix = current.slice(-desired.length);
  return suffix.length === desired.length && suffix.every((rule, i) => same(rule, desired[i])) ? [] : desired;
}

// Tokenize literal shell commands without confusing commit-message text with a
// command. This is defense-in-depth, not an arbitrary-process/network sandbox.
export function tokens(command) {
  const out = [];
  let word = "", quote = "", escaped = false, present = false;
  for (const char of command) {
    if (escaped) { if (char !== "\n") word += char; escaped = false; present = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; present = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; present = true; continue; }
    if (char === "'" || char === '"') { quote = char; present = true; continue; }
    if (/\s/.test(char) || ";|&()".includes(char)) {
      if (present) out.push(word);
      word = ""; present = false;
      if (";|&()\n".includes(char)) out.push(";");
    } else { word += char; present = true; }
  }
  if (quote || escaped) throw new Error("REMOTE_POLICY_COMMAND_INVALID");
  if (present) out.push(word);
  return out;
}
export function remoteWrite(command, aliases = {}, depth = 0) {
  if (depth > 8) return true;
  const words = tokens(command);
  const writes = new Set(["push", "send-pack", "http-push", "receive-pack"]);
  let start = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === ";") { start = true; continue; }
    if (!start) continue;
    const binary = word.split("/").at(-1);
    if (["sh", "bash", "zsh", "dash"].includes(binary)) {
      const flag = words[i + 1];
      if (flag?.startsWith("-") && flag.includes("c") && remoteWrite(words[i + 2] ?? "", aliases, depth + 1)) return true;
    }
    if (/^[A-Za-z_][\w]*=/.test(word) || ["env", "command", "exec", "sudo", "nice", "nohup"].includes(binary)) continue;
    start = false;
    if (["git-send-pack", "git-http-push", "git-receive-pack", "git-http-backend"].includes(binary)) return true;
    if (binary === "git") {
      let j = i + 1;
      const localAliases = { ...aliases };
      while (j < words.length && words[j].startsWith("-")) {
        if (words[j] === "-c" && words[j + 1]?.startsWith("alias.")) {
          const setting = words[j + 1];
          const equal = setting.indexOf("=");
          if (equal > 6) localAliases[setting.slice(6, equal)] = setting.slice(equal + 1);
        }
        if (["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--config-env"].includes(words[j])) j++;
        j++;
      }
      if (writes.has(words[j])) return true;
      if (words[j] === "credential" && ["approve", "fill"].includes(words[j + 1])) return true;
      if (words[j] === "lfs" && ["push", "upload", "pre-push"].includes(words[j + 1])) return true;
      if (localAliases[words[j]]) {
        const value = localAliases[words[j]];
        if (remoteWrite(value.startsWith("!") ? value.slice(1) : `git ${value}`, localAliases, depth + 1)) return true;
      }
    }
    if (binary === "git-lfs" && ["push", "upload", "pre-push"].includes(words[i + 1])) return true;
    if (binary === "gh" && ["release", "pr", "repo"].includes(words[i + 1]) && !["list", "view", "status", "clone", "diff", "checks", "download"].includes(words[i + 2])) return true;
    if (binary === "gh" && words[i + 1] === "api") {
      const arguments_ = words.slice(i + 2, words.indexOf(";", i + 2) < 0 ? undefined : words.indexOf(";", i + 2));
      if (arguments_.some((arg, index) => ["-f", "-F", "--field", "--raw-field"].includes(arg) || /^(?:--field|--raw-field)=/.test(arg) || ["-X", "--method"].includes(arg) && !["GET", "HEAD", "OPTIONS"].includes(arguments_[index + 1]) || /^--method=/.test(arg) && !/^--method=(GET|HEAD|OPTIONS)$/.test(arg))) return true;
    }
    if (binary === "gh" && words[i + 1] === "auth" && ["login", "setup-git", "refresh", "token"].includes(words[i + 2])) return true;
  }
  return false;
}
export function handback(questions) {
  const items = Array.isArray(questions) ? questions.slice(0, 8) : [];
  const text = value => String(value ?? "").replace(/\r/g, "").slice(0, 2000);
  const decisions = items.map(q => text(q.question)).filter(Boolean);
  const options = items.flatMap(q => Array.isArray(q.options) ? q.options.slice(0, 8).map(o => `${text(o.label)}: ${text(o.description)}`) : []);
  return `INPUT_REQUIRED:\n- decision: ${decisions.join("; ") || "A business decision is required; inspect the attempted question in this turn."}\n- context: The agent requested information needed to continue this work. Native end-user dialogs are disabled for agent-managed sessions.\n- safe_options: ${options.join("; ") || "Supply the missing decision, or keep the dependent work paused."}\n- completed: Work already stored in this session remains available for review.\n- paused: Decision-dependent work; reply through the orchestrator as a normal follow-up in this same session.`;
}

export function protocol(body, url, family = "") {
  if (url.includes("/responses")) return "responses";
  if (family.includes("anthropic") || body?.anthropic_version) return "anthropic";
  if (url.includes(":streamGenerateContent") || url.includes(":generateContent")) return "google";
  if (url.includes("/messages") && body?.max_tokens !== undefined) return "anthropic";
  if (Array.isArray(body?.messages)) return "chat";
  return undefined;
}
export function questionInResponse(raw, kind) {
  const frames = raw.split(/\r?\n\r?\n/).flatMap(frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
    try { return data && data !== "[DONE]" ? [JSON.parse(data)] : []; } catch { return []; }
  });
  if (!frames.length) { try { frames.push(JSON.parse(raw)); } catch { return undefined; } }
  const calls = new Map();
  const add = (id, name, args, replace = false) => {
    const call = calls.get(id) ?? { name: "", args: "" };
    if (name) call.name = replace ? name : call.name + name;
    if (typeof args === "string") call.args = replace ? args : call.args + args;
    else if (args) call.args = JSON.stringify(args);
    calls.set(id, call);
  };
  for (const frame of frames) {
    if (kind === "chat") for (const choice of frame.choices ?? []) for (const call of choice.delta?.tool_calls ?? choice.message?.tool_calls ?? []) add(call.index ?? call.id, call.function?.name, call.function?.arguments, !!choice.message);
    if (kind === "responses") {
      if (frame.type === "response.output_item.added" && frame.item?.type === "function_call") add(frame.item.id, frame.item.name, frame.item.arguments, true);
      if (frame.type === "response.function_call_arguments.delta") add(frame.item_id, "", frame.delta);
      for (const item of frame.response?.output ?? frame.output ?? []) if (item.type === "function_call") add(item.id, item.name, item.arguments, true);
    }
    if (kind === "anthropic") {
      if (frame.type === "content_block_start" && frame.content_block?.type === "tool_use") add(frame.index, frame.content_block.name, Object.keys(frame.content_block.input ?? {}).length ? frame.content_block.input : undefined, true);
      if (frame.delta?.type === "input_json_delta") add(frame.index, "", frame.delta.partial_json);
      for (const item of frame.content ?? []) if (item.type === "tool_use") add(item.id, item.name, item.input, true);
    }
    if (kind === "google") for (const candidate of frame.candidates ?? []) for (const part of candidate.content?.parts ?? []) if (part.functionCall) add(calls.size, part.functionCall.name, part.functionCall.args, true);
  }
  for (const call of calls.values()) {
    if (!["question", "business_input"].includes(call.name)) continue;
    try { return { report: handback(JSON.parse(call.args || "{}").questions) }; }
    catch { return { report: handback([]) }; }
  }
}
export function responseUsage(raw, kind) {
  let usage = {};
  const values = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
  if (!values.length) values.push(raw);
  for (const value of values) {
    try {
      const frame = JSON.parse(value);
      const next = kind === "responses" ? frame.response?.usage ?? frame.usage : kind === "google" ? frame.usageMetadata : frame.usage ?? frame.message?.usage;
      if (next) usage = { ...usage, ...next };
    } catch { /* SSE event/comment/[DONE], not usage. */ }
  }
  return usage;
}
export function terminalResponse(report, kind, streaming = true, usage = {}) {
  const id = "ocvm-handback";
  const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  let body;
  if (kind === "chat") {
    const base = { id, object: "chat.completion.chunk", created: 0, model: "ocvm-terminal" };
    const tokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, ...usage };
    body = streaming ? `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: report }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: tokens })}\n\ndata: [DONE]\n\n` : JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: report }, finish_reason: "stop" }], usage: tokens });
  } else if (kind === "responses") {
    const message = { id: "ocvm-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: report, annotations: [] }] };
    const response = { id, object: "response", created_at: 0, status: "completed", model: "ocvm-terminal", output: [message], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, ...usage } };
    body = streaming ? event("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }) + event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }) + event("response.content_part.added", { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) + event("response.output_text.delta", { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: report }) + event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message }) + event("response.completed", { type: "response.completed", response }) : JSON.stringify(response);
  } else if (kind === "anthropic") {
    const message = { id, type: "message", role: "assistant", model: "ocvm-terminal", content: [{ type: "text", text: report }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, ...usage } };
    body = streaming ? event("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }) + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: report } }) + event("content_block_stop", { type: "content_block_stop", index: 0 }) + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }) + event("message_stop", { type: "message_stop" }) : JSON.stringify(message);
  } else if (kind === "google") {
    const result = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: report }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0, ...usage } };
    body = streaming ? `data: ${JSON.stringify(result)}\n\n` : JSON.stringify(result);
  } else throw new Error("MANAGED_COMPLETION_PROTOCOL_UNSUPPORTED");
  return new Response(body, { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } });
}
