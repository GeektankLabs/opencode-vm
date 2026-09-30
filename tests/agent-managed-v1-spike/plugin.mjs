import { appendFileSync } from "node:fs";
import { MARKER, PRIMER, SHELL_COMMIT_RULE, CONDITIONAL_COMMIT_RULE, recognizedDirectWrite } from "./policy.mjs";

// Installed only into a disposable runtime by probe.py, never the project runtime.
export default async ({ serverUrl, directory }) => {
  const audit = (record) => appendFileSync(process.env.OCVM_SPIKE_AUDIT, JSON.stringify(record) + "\n");
  const session = async (id) => {
    const url = new URL(`/session/${encodeURIComponent(id)}`, serverUrl);
    url.searchParams.set("directory", directory);
    const response = await fetch(url);
    if (!response.ok) throw new Error("SPIKE_POLICY_STATE_UNAVAILABLE");
    return response.json();
  };
  const managed = async (id) => {
    if (!id) throw new Error("SPIKE_POLICY_SESSION_MISSING");
    const seen = new Set();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(id)) throw new Error("SPIKE_POLICY_PARENT_CYCLE");
      seen.add(id);
      const info = await session(id);
      if (info.metadata?.[MARKER] === 1) return true;
      if (!info.parentID) return false;
      id = info.parentID;
    }
    throw new Error("SPIKE_POLICY_PARENT_LIMIT");
  };
  return {
    event: async ({ event }) => {
      // No prompts/arguments/output captured by this audit hook.
      audit({ kind: "event", type: event.type, sessionID: event.properties?.sessionID });
    },
    "tool.definition": async ({ toolID }, output) => {
      if (toolID !== "bash") return;
      const found = output.description.includes(SHELL_COMMIT_RULE);
      audit({ kind: "shell-definition", originalRuleFound: found });
      if (!found) throw new Error("SPIKE_UNSUPPORTED_SHELL_INSTRUCTION");
      // Hook has no sessionID. Conditional wording preserves manual semantics;
      // never use a mutable current-session variable across concurrent sessions.
      output.description = output.description.replace(SHELL_COMMIT_RULE, CONDITIONAL_COMMIT_RULE);
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      const active = await managed(sessionID);
      audit({ kind: "system", sessionID, managed: active });
      if (active) output.system.push(PRIMER);
    },
    "tool.execute.before": async ({ tool, sessionID }, { args }) => {
      const active = await managed(sessionID);
      audit({ kind: "before", tool, sessionID, managed: active });
      if (!active) return;
      if (tool === "question") {
        throw new Error("INPUT_REQUIRED: native question blocked; return decision, context, safe_options, completed and paused as terminal assistant text.");
      }
      if (tool === "bash" && recognizedDirectWrite(args.command ?? "")) {
        throw new Error("REMOTE_WRITE_DENIED: operator-only; no permission request or approval can authorize this execution.");
      }
    },
  };
};
