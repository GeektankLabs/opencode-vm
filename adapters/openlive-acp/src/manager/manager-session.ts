import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { OpenCodeGateway } from "../opencode/gateway.js";
import type { ManagerDescriptor, RuntimeDescriptor } from "../types.js";

export class ManagerSession {
  constructor(
    private readonly gateway: OpenCodeGateway,
    private readonly runtime: RuntimeDescriptor,
    private readonly file: string,
  ) {}

  async ensure(): Promise<string> {
    const existing = await this.read();
    const sessionId = await this.gateway.ensureManager(
      existing?.project === this.runtime.project
        ? existing.sessionId
        : undefined,
      `OpenLive Manager: ${basename(this.runtime.project)}`,
    );
    await this.write({ schema: 1, project: this.runtime.project, sessionId });
    return sessionId;
  }

  private async read(): Promise<ManagerDescriptor | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.file, "utf8"),
      ) as ManagerDescriptor;
      if (
        parsed.schema !== 1 ||
        typeof parsed.project !== "string" ||
        typeof parsed.sessionId !== "string"
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async write(value: ManagerDescriptor): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
