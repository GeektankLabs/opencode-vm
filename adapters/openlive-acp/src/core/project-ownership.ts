import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";

export class ProjectOwnership {
  private readonly lockName: string;
  private server?: net.Server;

  constructor(private readonly socketPath: string) {
    const scope = createHash("sha256")
      .update(socketPath)
      .digest("hex")
      .slice(0, 32);
    // Linux abstract Unix sockets are kernel-owned and disappear atomically
    // with the process, avoiding both stale files and create/write races.
    this.lockName = `\0ocvm-openlive-${scope}`;
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path: this.lockName }, resolve);
      });
    } catch {
      server.close();
      throw new Error(
        "Another OpenLive conversation is already using this project.",
      );
    }
    if (await socketAcceptsConnections(this.socketPath)) {
      server.close();
      throw new Error(
        "Another OpenLive conversation is already using this project.",
      );
    }
    this.server = server;
    await rm(this.socketPath, { force: true });
  }

  async release(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
