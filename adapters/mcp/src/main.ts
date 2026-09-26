import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { McpHttpServer, supportedProtocolVersions } from "./http.js";
import { OpenCodeGateway } from "./opencode.js";
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

  const server = new McpHttpServer(runtime, token, gateway);
  const readyPath = join(dirname(runtimePath), "ready.json");
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await removeOwnedReadyFile(readyPath, runtime.generation, process.pid);
  };

  try {
    const port = await server.start();
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
