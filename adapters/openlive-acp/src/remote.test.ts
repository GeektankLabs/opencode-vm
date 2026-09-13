import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { ProjectOwnership } from "./core/project-ownership.js";
import { rewriteAcpCwd } from "./remote/client.js";
import { REMOTE_PROTOCOL } from "./remote/protocol.js";

test("remote client rewrites only scoped session cwd values", () => {
  const original = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { cwd: "/local/stub" },
  });
  assert.equal(
    rewriteAcpCwd(original, "/local/stub", "/remote/project"),
    original,
  );
  assert.deepEqual(
    JSON.parse(
      rewriteAcpCwd(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: "/local/stub", mcpServers: [] },
        }),
        "/local/stub",
        "/remote/project",
      ),
    ),
    {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/remote/project", mcpServers: [] },
    },
  );
  assert.throws(
    () =>
      rewriteAcpCwd(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/load",
          params: { cwd: "/another/project" },
        }),
        "/local/stub",
        "/remote/project",
      ),
    /outside the configured stub folder/,
  );
});

test("VM project ownership rejects a live owner and permits later acquisition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-openlive-owner-"));
  const socketPath = join(directory, "control.sock");
  const first = new ProjectOwnership(socketPath);
  const second = new ProjectOwnership(socketPath);
  try {
    await writeFile(socketPath, "stale");
    await first.acquire();
    await assert.rejects(access(socketPath));
    await assert.rejects(second.acquire(), /already using this project/);
    await first.release();
    await second.acquire();
  } finally {
    await second.release();
    await first.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("VM project ownership preserves a live legacy control socket", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "ocvm-openlive-legacy-owner-"),
  );
  const socketPath = join(directory, "control.sock");
  const legacy = net.createServer();
  const ownership = new ProjectOwnership(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      legacy.once("error", reject);
      legacy.listen(socketPath, resolve);
    });
    await assert.rejects(ownership.acquire(), /already using this project/);
    await access(socketPath);
  } finally {
    await ownership.release();
    await new Promise<void>((resolve) => legacy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote gateway authenticates discovery and a probe creates no adapter state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-openlive-remote-"));
  const runtimeFile = join(directory, "runtime.json");
  const managerFile = join(directory, "manager.json");
  const socketPath = join(directory, "socket", "control.sock");
  const readyFile = join(directory, "gateway-ready.json");
  const backend = http.createServer((request, response) => {
    assert.equal(
      request.headers.authorization,
      `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    );
    const body = request.url?.startsWith("/global/health")
      ? { healthy: true }
      : ["voice_sessions"];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.address();
  assert(backendAddress && typeof backendAddress === "object");
  await mkdir(join(directory, "socket"));
  await writeFile(
    runtimeFile,
    JSON.stringify({
      schema: 1,
      project: "/remote/project",
      backendUrl: `http://127.0.0.1:${backendAddress.port}`,
      generation: "test-generation",
      opencodeVersion: "test",
    }),
  );
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "dist/remote/server.js")],
    {
      env: {
        ...process.env,
        OCVM_OPENLIVE_RUNTIME: runtimeFile,
        OCVM_OPENLIVE_MANAGER_FILE: managerFile,
        OCVM_OPENLIVE_CONTROL_SOCKET: socketPath,
        OCVM_OPENLIVE_PROJECT_HASH: "project-id",
        OCVM_OPENLIVE_GATEWAY_PORT: "0",
        OCVM_OPENLIVE_GATEWAY_READY: readyFile,
        OCVM_OPENLIVE_SCRIPT_VERSION: "test-script",
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: "secret",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await waitFor(() => stderr.includes("gateway ready"));
    const readyState = JSON.parse(await readFile(readyFile, "utf8")) as {
      port: number;
      pid: number;
    };
    assert.equal(readyState.pid, child.pid);
    const port = readyState.port;
    const denied = await fetch(`http://127.0.0.1:${port}/openlive/info`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/openlive/info`, {
      headers: {
        Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
      },
    });
    assert.equal(allowed.status, 200);
    const info = (await allowed.json()) as Record<string, unknown>;
    assert.equal(info.projectId, "project-id");
    assert.equal(info.protocol, REMOTE_PROTOCOL);
    assert.equal(info.scriptVersion, "test-script");

    const ready = await websocketProbe(port);
    assert.equal(ready.projectId, "project-id");
    assert.equal(ready.cwd, "/remote/project");
    await assert.rejects(access(managerFile));
    await assert.rejects(access(socketPath));
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const stoppedState = JSON.parse(await readFile(readyFile, "utf8")) as {
      pid: number;
    };
    assert.equal(stoppedState.pid, child.pid);
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote gateway follows an unprotected web backend without requiring auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-openlive-no-auth-"));
  const runtimeFile = join(directory, "runtime.json");
  const managerFile = join(directory, "manager.json");
  const socketPath = join(directory, "socket", "control.sock");
  const readyFile = join(directory, "gateway-ready.json");
  const backend = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    const body = request.url?.startsWith("/global/health")
      ? { healthy: true }
      : ["voice_sessions"];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.address();
  assert(backendAddress && typeof backendAddress === "object");
  await mkdir(join(directory, "socket"));
  await writeFile(
    runtimeFile,
    JSON.stringify({
      schema: 1,
      project: "/remote/project",
      backendUrl: `http://127.0.0.1:${backendAddress.port}`,
      generation: "test-generation",
      opencodeVersion: "test",
    }),
  );
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "dist/remote/server.js")],
    {
      env: {
        ...process.env,
        OCVM_OPENLIVE_RUNTIME: runtimeFile,
        OCVM_OPENLIVE_MANAGER_FILE: managerFile,
        OCVM_OPENLIVE_CONTROL_SOCKET: socketPath,
        OCVM_OPENLIVE_PROJECT_HASH: "project-id",
        OCVM_OPENLIVE_GATEWAY_PORT: "0",
        OCVM_OPENLIVE_GATEWAY_READY: readyFile,
        OCVM_OPENLIVE_SCRIPT_VERSION: "test-script",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await waitFor(() => stderr.includes("gateway ready"));
    const readyState = JSON.parse(await readFile(readyFile, "utf8")) as {
      port: number;
    };
    const infoResponse = await fetch(
      `http://127.0.0.1:${readyState.port}/openlive/info`,
    );
    assert.equal(infoResponse.status, 200);
    const ready = await websocketProbe(readyState.port, undefined);
    assert.equal(ready.projectId, "project-id");
    await assert.rejects(access(managerFile));
    await assert.rejects(access(socketPath));
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function websocketProbe(
  port: number,
  password: string | undefined = "secret",
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/openlive/acp`,
    REMOTE_PROTOCOL,
    {
      headers: {
        ...(password
          ? {
              Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
            }
          : {}),
        "X-OCVM-OpenLive-Project": "project-id",
      },
    },
  );
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      const ready = JSON.parse(data.toString()) as Record<string, unknown>;
      ws.close();
      ws.once("close", () => resolve(ready));
    });
    ws.once("error", reject);
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("gateway did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
