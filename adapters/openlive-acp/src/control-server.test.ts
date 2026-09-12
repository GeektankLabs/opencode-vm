import assert from "node:assert/strict";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CallController } from "./core/call-controller.js";
import { ControlServer } from "./manager/control-server.js";

test("control socket is private and close is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-openlive-control-"));
  const socketPath = join(directory, "nested", "control.sock");
  const controller = {
    async control() {
      return "ok";
    },
  } as unknown as CallController;
  const server = new ControlServer(socketPath, controller);

  try {
    await server.start();
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let data = "";
      socket.setEncoding("utf8");
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({ callerSessionId: "manager", callerMessageId: "assistant", action: "list" })}\n`,
        ),
      );
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.deepEqual(JSON.parse(response), { ok: true, output: "ok" });
    await server.close();
    await server.close();
    await assert.rejects(access(socketPath));
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("control requests observe a disconnected socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-openlive-control-"));
  const socketPath = join(directory, "control.sock");
  let accepted!: () => void;
  const wasAccepted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let disconnected!: () => void;
  const sawDisconnect = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const controller = {
    async control(_request: unknown, signal: AbortSignal) {
      accepted();
      if (signal.aborted) disconnected();
      else signal.addEventListener("abort", disconnected, { once: true });
      await sawDisconnect;
      throw new Error("client disconnected");
    },
  } as unknown as CallController;
  const server = new ControlServer(socketPath, controller);

  try {
    await server.start();
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({ callerSessionId: "manager", callerMessageId: "assistant", action: "attach" })}\n`,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      socket.on("error", reject);
    });
    await wasAccepted;
    socket.destroy();
    await sawDisconnect;
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
