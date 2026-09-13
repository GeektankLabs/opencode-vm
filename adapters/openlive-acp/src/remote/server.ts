import { timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { RuntimeDescriptor } from "../types.js";
import {
  MAX_ACP_MESSAGE_BYTES,
  MAX_QUEUE_BYTES,
  REMOTE_PROTOCOL,
  REMOTE_SCHEMA,
  type RemoteError,
  type RemoteInfo,
  type RemoteReady,
} from "./protocol.js";

const ADAPTER_VERSION = "0.1.6";
const HEARTBEAT_MS = 15_000;
const CHILD_GRACE_MS = 5_000;

type Connection = {
  ws: WebSocket;
  alive: boolean;
  child?: ChildProcessWithoutNullStreams;
  stopping?: Promise<void>;
  admissionTimer?: NodeJS.Timeout;
};

export async function runRemoteServer(): Promise<void> {
  const runtime = await loadRuntime(requiredEnv("OCVM_OPENLIVE_RUNTIME"));
  const projectId = requiredEnv("OCVM_OPENLIVE_PROJECT_HASH");
  const displayName = boundedDisplayName(
    process.env.OCVM_OPENLIVE_DISPLAY_NAME || runtime.project,
  );
  const port = Number(requiredEnv("OCVM_OPENLIVE_GATEWAY_PORT"));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Invalid OpenLive gateway port");
  }
  const expectedAuth = expectedAuthorization();
  const readyFile = process.env.OCVM_OPENLIVE_GATEWAY_READY;

  let active: Connection | undefined;
  let backendReady = await backendIsReady(runtime, expectedAuth);
  const sockets = new Set<Connection>();
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_ACP_MESSAGE_BYTES,
    handleProtocols(protocols) {
      return protocols.has(REMOTE_PROTOCOL) ? REMOTE_PROTOCOL : false;
    },
  });
  const server = http.createServer((request, response) => {
    handleHttp(request, response, expectedAuth, {
      schema: REMOTE_SCHEMA,
      protocol: REMOTE_PROTOCOL,
      scriptVersion: process.env.OCVM_OPENLIVE_SCRIPT_VERSION || "unknown",
      adapterVersion: ADAPTER_VERSION,
      projectId,
      displayName,
      ready: backendReady,
      busy:
        Boolean(active?.child) ||
        existsSync(requiredEnv("OCVM_OPENLIVE_CONTROL_SOCKET")),
      maxJpegFrameBytes: 5 * 1024 * 1024,
      acpPath: "/openlive/acp",
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const path = request.url?.split("?", 1)[0];
    if (path !== "/openlive/acp") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!authorized(request, expectedAuth)) {
      rejectUpgrade(socket, 401, "Unauthorized", [
        'WWW-Authenticate: Basic realm="opencode-vm"',
      ]);
      return;
    }
    if (!backendReady) {
      rejectUpgrade(socket, 503, "Remote OpenLive backend is not ready");
      return;
    }
    if (request.headers.origin) {
      rejectUpgrade(socket, 403, "Browser origins are not accepted");
      return;
    }
    if (request.headers["x-ocvm-openlive-project"] !== projectId) {
      rejectUpgrade(socket, 409, "Remote project does not match");
      return;
    }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (!protocols.includes(REMOTE_PROTOCOL)) {
      rejectUpgrade(socket, 426, "Unsupported OpenLive protocol", [
        `Sec-WebSocket-Protocol: ${REMOTE_PROTOCOL}`,
      ]);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    const connection: Connection = { ws, alive: true };
    connection.admissionTimer = setTimeout(() => {
      if (!connection.child) ws.close(1008, "ACP startup timed out");
    }, 12_000);
    connection.admissionTimer.unref();
    sockets.add(connection);
    const ready: RemoteReady = {
      type: "ready",
      protocol: REMOTE_PROTOCOL,
      projectId,
      generation: runtime.generation,
      cwd: runtime.project,
      busy: Boolean(active?.child),
    };
    ws.send(JSON.stringify(ready));
    ws.on("pong", () => {
      connection.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      void receive(connection, data, isBinary).catch((error: unknown) => {
        sendError(connection.ws, "transport", errorMessage(error));
        connection.ws.close(1011, "OpenLive transport failed");
      });
    });
    ws.once("close", () => {
      sockets.delete(connection);
      clearTimeout(connection.admissionTimer);
      if (active === connection) active = undefined;
      void stopChild(connection);
    });
    ws.once("error", () => {
      void stopChild(connection);
    });
  });

  async function receive(
    connection: Connection,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary)
      throw new Error("Binary WebSocket messages are not supported");
    const message = data.toString();
    if (Buffer.byteLength(message) > MAX_ACP_MESSAGE_BYTES) {
      throw new Error("ACP message exceeds the 12 MiB limit");
    }
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ACP message must be a JSON object");
    }
    if ((parsed as { type?: unknown }).type === "eof") {
      if (connection.child) connection.child.stdin.end();
      else connection.ws.close(1000, "ACP stdin closed");
      return;
    }
    if (!connection.child) {
      clearTimeout(connection.admissionTimer);
      if (active && active !== connection) {
        sendError(
          connection.ws,
          "busy",
          "Another OpenLive conversation is already using this project.",
        );
        connection.ws.close(1008, "Project is busy");
        return;
      }
      active = connection;
      connection.child = launchAdapter(connection);
    }
    if (
      connection.child.stdin.writableLength + Buffer.byteLength(message) + 1 >
      MAX_QUEUE_BYTES
    ) {
      throw new Error("ACP input queue exceeded its limit");
    }
    connection.child.stdin.write(`${message}\n`);
  }

  function launchAdapter(
    connection: Connection,
  ): ChildProcessWithoutNullStreams {
    const adapterMain = fileURLToPath(new URL("../main.js", import.meta.url));
    const child = spawn(process.execPath, [adapterMain], {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_ACP_MESSAGE_BYTES && !pending.includes(0x0a)) {
        connection.ws.close(1009, "ACP output exceeds its line limit");
        void stopChild(connection);
        return;
      }
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (
          line.length > MAX_ACP_MESSAGE_BYTES ||
          connection.ws.bufferedAmount + line.length > MAX_QUEUE_BYTES
        ) {
          connection.ws.close(1009, "ACP output queue exceeded its limit");
          void stopChild(connection);
          return;
        }
        if (connection.ws.readyState === WebSocket.OPEN)
          connection.ws.send(line.toString("utf8"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk.slice(0, 4_096));
    });
    child.once("close", (code) => {
      if (pending.length && connection.ws.readyState === WebSocket.OPEN) {
        if (pending.length <= MAX_ACP_MESSAGE_BYTES)
          connection.ws.send(pending.toString("utf8"));
        else
          sendError(
            connection.ws,
            "transport",
            "ACP output exceeds its line limit",
          );
      }
      if (active === connection) active = undefined;
      connection.child = undefined;
      if (connection.ws.readyState === WebSocket.OPEN) {
        if (code !== 0) {
          sendError(
            connection.ws,
            "adapter-exit",
            "The remote OpenLive adapter could not start or stopped unexpectedly.",
          );
        }
        connection.ws.close(code === 0 ? 1000 : 1011);
      }
    });
    child.once("error", (error) => {
      sendError(connection.ws, "adapter-start", error.message);
      connection.ws.close(1011, "OpenLive adapter failed to start");
    });
    return child;
  }

  const heartbeat = setInterval(() => {
    for (const connection of sockets) {
      if (!connection.alive) {
        connection.ws.terminate();
        continue;
      }
      connection.alive = false;
      connection.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const readiness = setInterval(() => {
    void backendIsReady(runtime, expectedAuth).then((value) => {
      backendReady = value;
    });
  }, 2_000);
  readiness.unref();

  const shutdown = async () => {
    clearInterval(heartbeat);
    clearInterval(readiness);
    for (const connection of sockets) {
      connection.ws.terminate();
      await stopChild(connection);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OpenLive gateway did not publish a TCP address");
  }
  if (readyFile) {
    const temporary = `${readyFile}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schema: 1,
        port: address.port,
        pid: process.pid,
        executable: process.execPath,
        script: fileURLToPath(import.meta.url),
        projectId,
        generation: runtime.generation,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, readyFile);
  }
  process.stderr.write(
    `[openlive-remote] gateway ready on 127.0.0.1:${address.port}\n`,
  );
}

function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  expectedAuth: string | undefined,
  info: RemoteInfo,
): void {
  if (request.method !== "GET" || request.url !== "/openlive/info") {
    jsonResponse(response, 404, { error: "not_found" });
    return;
  }
  if (!authorized(request, expectedAuth)) {
    response.setHeader("WWW-Authenticate", 'Basic realm="opencode-vm"');
    jsonResponse(response, 401, { error: "unauthorized" });
    return;
  }
  if (!info.ready) {
    jsonResponse(response, 503, {
      error: "remote_openlive_not_ready",
      protocol: info.protocol,
      projectId: info.projectId,
    });
    return;
  }
  jsonResponse(response, 200, info);
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    Connection: "close",
  });
  response.end(body);
}

function expectedAuthorization(): string | undefined {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function backendIsReady(
  runtime: RuntimeDescriptor,
  authorization: string | undefined,
): Promise<boolean> {
  const headers = authorization ? { Authorization: authorization } : undefined;
  try {
    const [healthResponse, toolsResponse] = await Promise.all([
      fetch(new URL("/global/health", runtime.backendUrl), {
        headers,
        signal: AbortSignal.timeout(1_500),
      }),
      fetch(
        new URL(
          `/experimental/tool/ids?directory=${encodeURIComponent(runtime.project)}`,
          runtime.backendUrl,
        ),
        { headers, signal: AbortSignal.timeout(1_500) },
      ),
    ]);
    if (!healthResponse.ok || !toolsResponse.ok) return false;
    const health = (await healthResponse.json()) as { healthy?: unknown };
    const tools = (await toolsResponse.json()) as unknown;
    return (
      health.healthy === true &&
      Array.isArray(tools) &&
      tools.includes("voice_sessions")
    );
  } catch {
    return false;
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "OCVM_OPENLIVE_RUNTIME",
    "OCVM_OPENLIVE_MANAGER_FILE",
    "OCVM_OPENLIVE_CONTROL_SOCKET",
    "OCVM_OPENLIVE_PROJECT_HASH",
    "OPENCODE_SERVER_USERNAME",
    "OPENCODE_SERVER_PASSWORD",
  ]) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

function authorized(
  request: IncomingMessage,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  const actual = request.headers.authorization ?? "";
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function rejectUpgrade(
  socket: NodeJS.WritableStream & { destroy(): void },
  status: number,
  message: string,
  headers: string[] = [],
): void {
  const body = Buffer.from(JSON.stringify({ error: message }));
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n${headers.map((header) => `${header}\r\n`).join("")}` +
      `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
  );
  socket.write(body);
  socket.destroy();
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const error: RemoteError = {
    type: "error",
    code,
    message: message.slice(0, 500),
  };
  ws.send(JSON.stringify(error));
}

async function stopChild(connection: Connection): Promise<void> {
  if (connection.stopping) return connection.stopping;
  const child = connection.child;
  if (!child) return;
  connection.stopping = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    if (!child.stdin.destroyed) child.stdin.end();
    const terminate = setTimeout(() => child.kill("SIGTERM"), CHILD_GRACE_MS);
    terminate.unref();
    const force = setTimeout(
      () => child.kill("SIGKILL"),
      CHILD_GRACE_MS + 2_000,
    );
    force.unref();
    child.once("exit", () => {
      clearTimeout(terminate);
      clearTimeout(force);
      resolve();
    });
  });
  return connection.stopping;
}

async function loadRuntime(file: string): Promise<RuntimeDescriptor> {
  const value = JSON.parse(await readFile(file, "utf8")) as RuntimeDescriptor;
  if (
    value.schema !== 1 ||
    typeof value.project !== "string" ||
    typeof value.backendUrl !== "string" ||
    typeof value.generation !== "string" ||
    typeof value.opencodeVersion !== "string"
  ) {
    throw new Error("Invalid OpenLive runtime descriptor");
  }
  return value;
}

function boundedDisplayName(value: string): string {
  const name = value.split(/[\\/]/).filter(Boolean).at(-1) || "Remote project";
  return name.slice(0, 120);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing required OpenLive gateway environment: ${name}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unexpected remote transport error";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runRemoteServer().catch((error: unknown) => {
    process.stderr.write(`[openlive-remote] ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
