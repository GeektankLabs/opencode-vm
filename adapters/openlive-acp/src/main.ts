import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { startAcp } from "./acp/transport.js";
import { CallController } from "./core/call-controller.js";
import { ProjectOwnership } from "./core/project-ownership.js";
import { SessionInspector } from "./core/session-inspector.js";
import { ControlServer } from "./manager/control-server.js";
import { ManagerSession } from "./manager/manager-session.js";
import { OpenCodeGateway } from "./opencode/gateway.js";
import type { RuntimeDescriptor } from "./types.js";

async function main(): Promise<void> {
  const runtimeFile = requiredEnv("OCVM_OPENLIVE_RUNTIME");
  const managerFile = requiredEnv("OCVM_OPENLIVE_MANAGER_FILE");
  const socketPath = requiredEnv("OCVM_OPENLIVE_CONTROL_SOCKET");
  const projectHash = requiredEnv("OCVM_OPENLIVE_PROJECT_HASH");
  const runtime = await loadRuntime(runtimeFile);
  process.env.OCVM_OPENLIVE_PROJECT = runtime.project;
  const ownership = new ProjectOwnership(socketPath);
  await ownership.acquire();

  try {
    const gateway = new OpenCodeGateway(runtime);
    const manager = new ManagerSession(gateway, runtime, managerFile);
    const startup = await withTimeout(
      (async () => {
        await gateway.health();
        await gateway.requireTool("voice_sessions");
        const managerSessionId = await manager.ensure();
        const models = await gateway.modelCatalog(managerSessionId);
        if (!models.current) {
          throw new Error(
            "The OpenLive manager has no initial OpenCode model.",
          );
        }
        await gateway.requireManagerTool(
          "voice_sessions",
          models.current,
          managerSessionId,
          "openlive-manager",
        );
        return { managerSessionId, models };
      })(),
      8_000,
      "OpenLive adapter startup timed out while checking the central runtime.",
    );
    const { managerSessionId, models } = startup;
    if (models.current) {
      process.stderr.write(
        `[openlive] initial model=${models.current.providerID}/${models.current.modelID}\n`,
      );
    }
    const inspector = new SessionInspector(gateway, managerSessionId);
    const controller = new CallController(
      gateway,
      inspector,
      managerSessionId,
      projectHash,
      models,
    );
    const control = new ControlServer(socketPath, controller);
    await control.start();

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () => {
      shutdownPromise ??= controller
        .shutdown()
        .finally(() => control.close())
        .finally(() => ownership.release());
      return shutdownPromise;
    };
    const signalShutdown = () => {
      void shutdown().finally(() => process.exit(0));
    };
    process.once("SIGINT", signalShutdown);
    process.once("SIGTERM", signalShutdown);
    try {
      await startAcp(controller);
    } finally {
      await shutdown();
    }
  } finally {
    await ownership.release();
  }
}

async function loadRuntime(file: string): Promise<RuntimeDescriptor> {
  const runtime = JSON.parse(await readFile(file, "utf8")) as RuntimeDescriptor;
  if (
    runtime.schema !== 1 ||
    typeof runtime.project !== "string" ||
    typeof runtime.backendUrl !== "string" ||
    typeof runtime.generation !== "string" ||
    typeof runtime.opencodeVersion !== "string"
  ) {
    throw new Error(`Invalid OpenLive runtime descriptor: ${basename(file)}`);
  }
  return runtime;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing required OpenLive adapter environment: ${name}`);
  return value;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "Unexpected OpenLive adapter startup error";
  process.stderr.write(`[openlive] ${message}\n`);
  process.exit(1);
});
