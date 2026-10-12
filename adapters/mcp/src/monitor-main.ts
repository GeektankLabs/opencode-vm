import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { OpenCodeGateway } from "./opencode.js";
import { ProjectBoardService } from "./taskboard.js";
import { readPolicy, routingRegime } from "./agent-control.js";
import { MonitorEngine } from "./monitor-engine.js";
import type { MonitorBoardLike, MonitorPolicyView } from "./monitor-engine.js";
import { monitorRegistryDirectory } from "./monitor.js";
import type { RuntimeDescriptor } from "./types.js";

/**
 * Monitor Engine service entry (W3). One engine owner per project, started as
 * an ordinary transient systemd unit by the session wrapper. The engine has no
 * listener and opens no port: it wakes on its own schedule, reads the
 * canonical board/task sources through the existing OpenCode/Board services
 * and takes at most one bounded action per wake. The MCP tools operate on the
 * same project registry and the same gateway contract (single canonical truth,
 * no second platform).
 */

type MonitorRuntimeInput = {
  runtime: RuntimeDescriptor;
  auth: { username: string; password: string } | null;
};

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) fail("Private monitor runtime input required");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 16384
  )
    fail("Unsafe runtime input");
  const value = JSON.parse(await readFile(path, "utf8")) as MonitorRuntimeInput;
  const runtime = value?.runtime;
  if (
    !runtime ||
    runtime.schema !== 1 ||
    runtime.listenHost !== "127.0.0.1" ||
    !/^[0-9a-f]{32}$/.test(runtime.projectHash) ||
    !runtime.generation ||
    (await realpath(runtime.project)) !== runtime.project ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.backendUrl) ||
    (runtime.taskboardUrl && !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.taskboardUrl))
  )
    fail("Invalid runtime identity");
  if (value.auth !== null && (!value.auth || !value.auth.username || !value.auth.password))
    fail("Invalid authentication material");

  if (value.auth) {
    // The gateway builds its backend client from these environment variables;
    // the unit runs with the same session credential as the other services.
    process.env.OPENCODE_SERVER_USERNAME = value.auth.username;
    process.env.OPENCODE_SERVER_PASSWORD = value.auth.password;
  }
  const client = createOpencodeClient({
    baseUrl: runtime.backendUrl,
    directory: runtime.project,
    throwOnError: true,
  });
  const gateway = new OpenCodeGateway(runtime, client, 3000);
  const board: MonitorBoardLike | undefined =
    runtime.taskboardUrl && runtime.taskboardMetadataFile
      ? (new ProjectBoardService({
          ...runtime,
          taskboardUrl: runtime.taskboardUrl,
          taskboardMetadataFile: runtime.taskboardMetadataFile,
        }) as unknown as MonitorBoardLike)
      : undefined;
  const policyView = async (): Promise<MonitorPolicyView> => {
    const policy = await readPolicy(runtime);
    // Welle B: full Schema-4 view — profileFallbacks, strategies, computed
    // routing regime and revision reach the engine; the shared resolver in
    // agent-control.ts is the single implementation (the Hub stays a later
    // read-only consumer of the engine-persisted projection).
    return {
      finalFallback: policy.finalFallback,
      profiles: policy.profiles,
      profileFallbacks: policy.profileFallbacks,
      strategies: policy.strategies,
      routing: routingRegime(policy),
      revision: policy.revision,
    };
  };

  const engine = new MonitorEngine({
    project: runtime.project,
    gateway,
    ...(board ? { board } : {}),
    readPolicy: policyView,
    // V2 §13.8: the runtime generation is the engine's claim-fencing identity.
    engineGeneration: runtime.generation,
    log: (level, message) => {
      process.stderr.write(`[monitor] ${level}: ${message}\n`);
    },
  });

  const stateDir = monitorRegistryDirectory(runtime.project);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const heartbeatPath = join(stateDir, "heartbeat.json");
  let stopped = false;
  const writeHeartbeat = async (): Promise<void> => {
    const tmp = join(stateDir, `.heartbeat.${process.pid}.tmp`);
    await writeFile(
      tmp,
      JSON.stringify({ schema: 1, projectHash: runtime.projectHash, generation: runtime.generation, pid: process.pid, at: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
    await rename(tmp, heartbeatPath);
  };
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(wakeTimer);
    clearInterval(observerTimer);
    clearInterval(heartbeatTimer);
  };
  const wakeTimer = setInterval(() => {
    if (stopped) return;
    engine.tick().catch((error) => {
      process.stderr.write(`[monitor] wake error: ${error instanceof Error ? error.message : "unknown"}\n`);
    });
  }, 5000);
  // V2 §13.7: minimal independent cheap observer — registry-only (no gateway
  // calls), so it stays observation-capable while a wake blocks inside a
  // long tool call. It never sends, recovers or releases claims.
  const observerTimer = setInterval(() => {
    if (stopped) return;
    engine.observe().catch((error) => {
      process.stderr.write(`[monitor] observer error: ${error instanceof Error ? error.message : "unknown"}\n`);
    });
  }, 5000);
  const heartbeatTimer = setInterval(() => {
    if (stopped) return;
    writeHeartbeat().catch(() => undefined);
  }, 30_000);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);

  // Ownership watch: stop when the private runtime input is revoked or replaced.
  const initial = await readFile(path, "utf8");
  setInterval(() => {
    readFile(path, "utf8")
      .then((current) => {
        if (current !== initial) shutdown();
      })
      .catch(() => shutdown());
  }, 5000).unref();

  // V2 §13.8: recover orphaned wake claims ONCE at boot (owner-generation +
  // stale-heartbeat evidence; uncertain WAL reconciled first). A claim whose
  // owner generation still has a fresh heartbeat is never released here.
  try {
    const recovered = await engine.recoverAbandonedClaims();
    if (recovered > 0) process.stderr.write(`[monitor] recovered ${recovered} orphaned wake claim(s)\n`);
  } catch (error) {
    process.stderr.write(`[monitor] claim recovery error: ${error instanceof Error ? error.message : "unknown"}\n`);
  }

  await writeHeartbeat();
  await engine.tick();
  process.stderr.write(`[monitor] ready project=${runtime.projectHash} generation=${runtime.generation}\n`);
}

main().catch(() => {
  console.error("[monitor] Private runtime input or backend interface unavailable.");
  process.exitCode = 1;
});