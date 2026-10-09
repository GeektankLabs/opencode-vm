import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { McpHttpServer, supportedProtocolVersions } from "./http.js";
import { OpenCodeGateway } from "./opencode.js";
import { ActivityJournal } from "./activity.js";
import { DashboardCollector, createDashboardControl } from "./dashboard.js";
import type { UiService } from "./dashboard.js";
import { ProjectBoardService } from "./taskboard.js";
import {
  ADAPTER_VERSION,
  MCP_TRANSPORT,
  isRecord,
  loadCredential,
  loadRuntimeDescriptor,
} from "./types.js";
import type { ReadyDescriptor } from "./types.js";

export async function main(): Promise<void> {
  const runtimePath = process.env.OCVM_MCP_RUNTIME;
  if (!runtimePath) {
    throw new Error(
      "Missing required MCP adapter environment: OCVM_MCP_RUNTIME",
    );
  }
  const runtime = await loadRuntimeDescriptor(runtimePath);
  const token = await loadCredential(runtime.credentialFile);
  const gateway = new OpenCodeGateway(runtime);
  await gateway.compatibilityCheck();
  const legacyJournal = join(dirname(runtimePath), "activity.json");
  const activityPath = await projectActivityJournalPath(runtime.project);
  await gateway.enableActivity(activityPath, legacyJournal);

  // One lazy Repo Live collector behind the shared read-only projection; it
  // collects on demand (first MCP app read, then at most every 2s) so unused
  // sessions create no backend polling, and never writes.
  const board = runtime.taskboardUrl && runtime.taskboardMetadataFile
    ? new ProjectBoardService({ ...runtime, taskboardUrl: runtime.taskboardUrl, taskboardMetadataFile: runtime.taskboardMetadataFile })
    : undefined;
  const collector = new DashboardCollector({ id: runtime.projectHash, name: runtime.projectName }, runtime.generation, {
    inventory: () => gateway.readDashboardInventory(),
    session: session => gateway.readDashboardSession(session),
    board: () => { if (!board) throw new Error("Board unavailable"); return board.readDashboardTasks(); },
    activity: ids => ActivityJournal.readDashboard(activityPath, runtime.projectHash, ids),
    attention: () => ActivityJournal.readPreparedAttention(activityPath, runtime.projectHash),
  });
  const service: UiService = { kind: "mcp-app", generation: runtime.generation, adapterVersion: ADAPTER_VERSION };
  gateway.dashboardControl = createDashboardControl(collector, service);

  const server = new McpHttpServer(runtime, token, gateway);
  const readyPath = join(dirname(runtimePath), "ready.json");
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await gateway.close();
    await removeOwnedReadyFile(readyPath, runtime.generation, process.pid);
  };

  try {
    const port = await server.start();
    gateway.startActivityCollection();
    const ready: ReadyDescriptor = {
      schema: 1,
      projectHash: runtime.projectHash,
      generation: runtime.generation,
      adapterVersion: ADAPTER_VERSION,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      transport: MCP_TRANSPORT,
      preferredProtocolVersion: LATEST_PROTOCOL_VERSION,
      supportedProtocolVersions: supportedProtocolVersions(),
      negotiatedProtocolVersion: null,
    };
    await writeReadyFile(readyPath, ready);
    process.stderr.write(
      `[mcp] ready project=${runtime.projectHash} generation=${runtime.generation} port=${port}\n`,
    );
  } catch (error) {
    await shutdown();
    throw error;
  }

  const onSignal = () => {
    void shutdown().catch(() => undefined);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

export async function projectActivityJournalPath(project: string): Promise<string> {
  const root = await lstat(project);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("The project root for persistent MCP activity is unsafe.");
  const state = join(project, ".opencode-vm");
  try { await mkdir(state, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stateInfo = await lstat(state);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink())
    throw new Error("Project .opencode-vm state must be a real directory.");
  const directory = join(state, "mcp");
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    directoryInfo.uid !== process.getuid?.() || (directoryInfo.mode & 0o777) !== 0o700)
    throw new Error("Project MCP journal directory must be private and user-owned.");
  return join(directory, "activity.json");
}

export async function writeReadyFile(
  path: string,
  value: ReadyDescriptor,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await unlink(temporary).catch(() => undefined);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removeOwnedReadyFile(
  path: string,
  generation: string,
  pid: number,
): Promise<void> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      isRecord(value) &&
      value.schema === 1 &&
      value.generation === generation &&
      value.pid === pid
    ) {
      await unlink(path);
    }
  } catch {
    // Missing, replaced, or malformed readiness does not belong to this process.
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown startup error.";
    process.stderr.write(`[mcp] startup failed: ${message.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
