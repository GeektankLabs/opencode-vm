import net from "node:net";
import { tool } from "@opencode-ai/plugin";

const socketPath = process.env.OCVM_OPENLIVE_CONTROL_SOCKET;
const CONTROL_TIMEOUT_MS = 2_000;
const MUTATION_DEADLINE_MS = 1_750;

export default tool({
  description:
    "List project sessions, inspect one, attach the current OpenLive call, or create and attach a new work session. Available only in the OpenLive manager session.",
  args: {
    action: tool.schema.enum(["list", "status", "read", "attach", "create"]),
    sessionId: tool.schema.string().optional(),
    limit: tool.schema.number().int().min(1).max(12).optional(),
    title: tool.schema.string().max(80).optional(),
  },
  async execute(args, context) {
    if (!socketPath)
      throw new Error("OpenLive control socket is not configured.");
    return requestControl(socketPath, {
      ...args,
      callerSessionId: context.sessionID,
      callerMessageId: context.messageID,
      expiresAt: Date.now() + MUTATION_DEADLINE_MS,
    });
  },
});

function requestControl(path, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_TIMEOUT_MS);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      try {
        const response = JSON.parse(data);
        if (!response.ok) reject(new Error(response.error));
        else resolve(response.output);
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.on("timeout", () =>
      socket.destroy(new Error("OpenLive control request timed out.")),
    );
    socket.on("error", reject);
  });
}
