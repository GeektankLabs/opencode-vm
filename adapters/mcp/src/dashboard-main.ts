import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { OpenCodeGateway } from "./opencode.js";
import { ProjectBoardService } from "./taskboard.js";
import { ActivityJournal } from "./activity.js";
import { DashboardCollector } from "./dashboard.js";
import { dashboardServer } from "./dashboard-http.js";
import type { RuntimeDescriptor } from "./types.js";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Private dashboard runtime input required");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error("Unsafe runtime input");
  const value = JSON.parse(await readFile(path, "utf8"));
  const runtime: RuntimeDescriptor = value.runtime;
  if (runtime.schema !== 1 || runtime.listenHost !== "127.0.0.1" || !/^[0-9a-f]{32}$/.test(runtime.projectHash) ||
    !runtime.generation || await realpath(runtime.project) !== runtime.project ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.backendUrl) ||
    !Number.isInteger(runtime.listenPort) || runtime.listenPort < 1024 || runtime.listenPort > 65535 ||
    typeof value.authEnabled !== "boolean" || (value.authEnabled && (!value.auth?.username || !value.auth?.password)) ||
    (!value.authEnabled && value.auth !== null) ||
    (runtime.taskboardUrl && !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.taskboardUrl)) ||
    (value.navigation && [value.navigation.web_port, value.navigation.board_port].some(port => !Number.isInteger(port) || port < 1 || port > 65535))) throw new Error("Invalid runtime identity/auth");
  for (const file of [value.cert, value.key]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
      (file === value.key && (info.mode & 0o077) !== 0)) throw new Error("Unsafe TLS material");
  }
  const authorization = value.authEnabled ? `Basic ${Buffer.from(`${value.auth.username}:${value.auth.password}`).toString("base64")}` : undefined;
  const client = createOpencodeClient({ baseUrl: runtime.backendUrl, directory: runtime.project, throwOnError: true,
    headers: authorization ? { Authorization: authorization } : {},
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "GET" || new URL(request.url).origin !== runtime.backendUrl) throw new Error("Read boundary");
      const response = await fetch(request, { redirect: "error" });
      if (Number(response.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) { await response.body?.cancel(); throw new Error("Backend budget"); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Backend budget"); }
        chunks.push(next.value);
      }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    } });
  const gateway = new OpenCodeGateway(runtime, client, 3000);
  const board = runtime.taskboardUrl && runtime.taskboardMetadataFile ? new ProjectBoardService({ ...runtime,
    taskboardUrl: runtime.taskboardUrl, taskboardMetadataFile: runtime.taskboardMetadataFile }) : undefined;
  const collector = new DashboardCollector({ id: runtime.projectHash, name: runtime.projectName }, runtime.generation, {
    inventory: () => gateway.readDashboardInventory(), session: session => gateway.readDashboardSession(session),
    board: () => { if (!board) throw new Error("Board unavailable"); return board.readDashboardTasks(); },
    activityJournalStatus: () => ({ enabled: runtime.activityJournalEnabled !== false,
      state: runtime.activityJournalEnabled === false ? "disabled" : "ready" }),
    activity: ids => ActivityJournal.readDashboard(`${runtime.project}/.opencode-vm/mcp/activity.json`, runtime.projectHash, ids),
    attention: () => ActivityJournal.readPreparedAttention(`${runtime.project}/.opencode-vm/mcp/activity.json`, runtime.projectHash),
  });
  const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../dashboard");
  const server = await dashboardServer({ projectHash: runtime.projectHash, generation: runtime.generation,
    listenPort: runtime.listenPort, authEnabled: value.authEnabled, auth: value.auth,
    cert: value.cert, key: value.key, assets, navigation: value.navigation }, collector);
  collector.start();
  const initial = await readFile(path, "utf8");
  const ownership = setInterval(async () => {
    try { if (await readFile(path, "utf8") === initial) return; } catch { /* revoked */ }
    collector.resetGeneration("unverified"); collector.stop(); clearInterval(ownership);
  }, 5000);
  server.listen(runtime.listenPort, "127.0.0.1");
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { clearInterval(ownership); collector.stop(); server.close(); server.closeAllConnections(); });
}
main().catch(() => { console.error("[dashboard] Private runtime, TLS, authentication or backend interface unavailable."); process.exitCode = 1; });
