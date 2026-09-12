import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import type { CallController } from "../core/call-controller.js";
import type { ControlRequest } from "../types.js";

export class ControlServer {
  private server?: net.Server;
  private ownsSocket = false;

  constructor(
    private readonly socketPath: string,
    private readonly controller: CallController,
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    this.server = net.createServer((socket) => {
      let input = "";
      const disconnected = new AbortController();
      socket.once("close", () => disconnected.abort());
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const line = input.slice(0, newline);
        void this.respond(socket, line, disconnected.signal);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, () => resolve());
    });
    this.ownsSocket = true;
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.ownsSocket) {
      this.ownsSocket = false;
      await rm(this.socketPath, { force: true });
    }
  }

  private async respond(
    socket: net.Socket,
    line: string,
    signal: AbortSignal,
  ): Promise<void> {
    const started = Date.now();
    let action = "invalid";
    try {
      const request = JSON.parse(line) as ControlRequest;
      action = request.action;
      process.stderr.write(`[openlive] control ${action} accepted\n`);
      const output = await this.controller.control(request, signal);
      process.stderr.write(
        `[openlive] control ${action} completed after ${Date.now() - started}ms\n`,
      );
      socket.end(`${JSON.stringify({ ok: true, output })}\n`);
    } catch (error) {
      process.stderr.write(
        `[openlive] control ${action} failed after ${Date.now() - started}ms: ${errorMessage(error).slice(0, 500)}\n`,
      );
      socket.end(
        `${JSON.stringify({ ok: false, error: errorMessage(error) })}\n`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unexpected control request error";
}
