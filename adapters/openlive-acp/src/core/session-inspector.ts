import type { OpenCodeGateway } from "../opencode/gateway.js";
import type {
  ModelSelection,
  PromptSettings,
  SessionListing,
} from "../types.js";

export class SessionInspector {
  constructor(
    private readonly gateway: OpenCodeGateway,
    private readonly managerSessionId: string,
  ) {}

  async list(): Promise<SessionListing> {
    return this.gateway.listSessions(this.managerSessionId);
  }

  async create(
    title: string | undefined,
    model: ModelSelection,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; settings: PromptSettings }> {
    const agent = await this.gateway.defaultWorkAgent();
    const settings = { agent, model };
    const session = await this.gateway.createSession(title, settings, signal);
    return {
      sessionId: session.id,
      settings,
    };
  }

  async delete(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.gateway.deleteSession(sessionId, signal);
  }

  async status(sessionId: string): Promise<string> {
    await this.requireTarget(sessionId);
    return this.gateway.status(sessionId);
  }

  async read(sessionId: string, limit?: number): Promise<string> {
    await this.requireTarget(sessionId);
    return this.gateway.readSession(sessionId, limit);
  }

  async promptSettings(sessionId: string): Promise<PromptSettings> {
    await this.requireTarget(sessionId);
    return this.gateway.promptSettings(sessionId);
  }

  async requireAttachable(sessionId: string): Promise<void> {
    await this.requireTarget(sessionId);
    if ((await this.gateway.status(sessionId)) !== "idle") {
      throw new Error(
        "The requested work session is busy. Wait for it to become idle before attaching.",
      );
    }
  }

  private async requireTarget(sessionId: string): Promise<void> {
    if (!sessionId) throw new Error("A session ID is required.");
    if (sessionId === this.managerSessionId)
      throw new Error(
        "The manager session cannot be attached as a work session.",
      );
    await this.gateway.getSession(sessionId);
  }
}
