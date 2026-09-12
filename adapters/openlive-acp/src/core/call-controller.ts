import { randomUUID } from "node:crypto";
import type { OpenCodeGateway } from "../opencode/gateway.js";
import type {
  ControlRequest,
  ModelCatalog,
  ModelOption,
  ModelSelection,
  PromptSettings,
  PromptImage,
  PromptUpdate,
  ReplayMessage,
} from "../types.js";
import type { SessionInspector } from "./session-inspector.js";

type ActiveTurn = {
  generation: number;
  sessionId: string;
  userMessageId: string;
  manager: boolean;
  submitted: boolean;
  preserveBackend: boolean;
  assistantMessageIds: Set<string>;
  pendingTargetSessionId?: string;
  pendingTargetSettings?: PromptSettings;
  createdTargetSessionId?: string;
  cancellation?: Promise<void>;
  abort: AbortController;
  done: Promise<void>;
  finish(): void;
};

type VoiceCall = {
  id: string;
  route: "manager" | "attached";
  targetSessionId?: string;
  targetSettings?: PromptSettings;
  model?: ModelSelection;
  generation: number;
  welcomePending: boolean;
  closing: boolean;
  active?: ActiveTurn;
};

const CLEANUP_TIMEOUT_MS = 5_000;
const FIRST_MANAGER_TURN_SYSTEM =
  "This is the first user turn of a new OpenLive call. First call voice_sessions with action list. Begin your answer with one short status sentence in the user's language stating the exact number of existing project sessions and how many are busy, then say that the user can switch to an existing session or start a new one. Continue by answering the user's request. Do not use Markdown.";

export class CallController {
  private readonly calls = new Map<string, VoiceCall>();

  constructor(
    private readonly gateway: OpenCodeGateway,
    private readonly inspector: SessionInspector,
    private readonly managerSessionId: string,
    private readonly projectHash: string,
    private readonly models: ModelCatalog = { options: [] },
    private readonly cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  ) {}

  newCall(): string {
    const id = `ocvm:${this.projectHash}:${randomUUID()}`;
    this.calls.set(id, {
      id,
      route: "manager",
      model: this.models.current,
      generation: 0,
      welcomePending: true,
      closing: false,
    });
    return id;
  }

  loadCall(id: string): void {
    if (!id.startsWith(`ocvm:${this.projectHash}:`)) {
      throw new Error("The ACP session belongs to another project.");
    }
    const current = this.calls.get(id);
    if (current?.active) {
      throw new Error(
        "Cannot load an OpenLive session while a prompt is running.",
      );
    }
    this.calls.set(id, {
      id,
      route: "manager",
      model: current?.model ?? this.models.current,
      generation: (current?.generation ?? 0) + 1,
      welcomePending: true,
      closing: false,
    });
  }

  async replayManager(): Promise<ReplayMessage[]> {
    return this.gateway.replayManager(this.managerSessionId);
  }

  modelState(
    id: string,
  ): { current: string; options: ModelOption[] } | undefined {
    const call = this.requireCall(id);
    if (!call.model || this.models.options.length === 0) return undefined;
    const current = this.models.options.find(
      (option) =>
        option.model.providerID === call.model?.providerID &&
        option.model.modelID === call.model.modelID,
    );
    return current
      ? { current: current.id, options: this.models.options }
      : undefined;
  }

  setModel(id: string, modelId: string): void {
    const call = this.requireCall(id);
    if (call.active)
      throw new Error("Cannot change model while a prompt is running.");
    const option = this.models.options.find((item) => item.id === modelId);
    if (!option) throw new Error(`Unknown OpenCode model: ${modelId}`);
    call.model = option.model;
    process.stderr.write(`[openlive] model selected=${option.id}\n`);
  }

  async prompt(
    id: string,
    text: string,
    onUpdate: (update: PromptUpdate) => Promise<void>,
    images: PromptImage[] = [],
  ): Promise<"end_turn" | "cancelled"> {
    const call = this.requireCall(id);
    if (call.closing) throw new Error("The OpenLive call is closing.");
    if (call.active) throw new Error("A voice prompt is already running.");
    const manager = call.route === "manager";
    const sessionId = manager ? this.managerSessionId : call.targetSessionId;
    if (!sessionId) throw new Error("The voice call has no target session.");

    const turn = createActiveTurn(++call.generation, sessionId, manager);
    call.active = turn;
    try {
      const initialTargetSettings = manager ? undefined : call.targetSettings;
      const settings = manager
        ? this.managerSettings(call)
        : (initialTargetSettings ??
          (await this.inspector.promptSettings(sessionId)));
      if (manager) {
        if ((await this.gateway.status(sessionId)) !== "idle") {
          throw new Error(
            "The OpenLive manager is busy. Continue the pending interaction in Web UI or TUI.",
          );
        }
      } else {
        await this.inspector.requireAttachable(sessionId);
      }
      if (turn.abort.signal.aborted) return "cancelled";

      await this.gateway.prompt(
        sessionId,
        text,
        settings,
        turn.userMessageId,
        turn.abort.signal,
        onUpdate,
        {
          onSubmitted: () => {
            turn.submitted = true;
          },
          onAssistantMessage: (messageId) => {
            turn.assistantMessageIds.add(messageId);
          },
          preserveBackend: () => {
            turn.preserveBackend = true;
          },
        },
        images,
      );
      if (turn.abort.signal.aborted) return "cancelled";
      if (
        manager &&
        turn.pendingTargetSessionId &&
        call.active === turn &&
        call.generation === turn.generation
      ) {
        call.route = "attached";
        call.targetSessionId = turn.pendingTargetSessionId;
        call.targetSettings = turn.pendingTargetSettings;
        turn.createdTargetSessionId = undefined;
      }
      if (manager) call.welcomePending = false;
      if (!manager && initialTargetSettings) call.targetSettings = undefined;
      return "end_turn";
    } catch (error) {
      if (turn.abort.signal.aborted) return "cancelled";
      throw error;
    } finally {
      if (turn.createdTargetSessionId) {
        await this.removeUnconfirmed(turn.createdTargetSessionId);
      }
      turn.pendingTargetSessionId = undefined;
      turn.pendingTargetSettings = undefined;
      turn.createdTargetSessionId = undefined;
      if (call.active === turn && !turn.cancellation) call.active = undefined;
      turn.finish();
    }
  }

  async cancel(id: string): Promise<void> {
    const call = this.requireCall(id);
    const turn = call.active;
    if (!turn) return;
    if (!turn.cancellation) {
      turn.cancellation = (async () => {
        turn.abort.abort();
        turn.pendingTargetSessionId = undefined;
        if (turn.submitted && !turn.preserveBackend) {
          await this.gateway.abort(turn.sessionId).catch(() => undefined);
        }
      })();
    }
    await turn.cancellation;
    if (call.active === turn) call.active = undefined;
  }

  async close(id: string): Promise<void> {
    const call = this.calls.get(id);
    if (!call) return;
    call.closing = true;
    const turn = call.active;
    if (turn) {
      await this.cancel(id);
      await settleWithin(turn.done, this.cleanupTimeoutMs);
    }
    this.calls.delete(id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.calls.keys()].map((id) => this.close(id)));
  }

  async control(
    request: ControlRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    if (request.callerSessionId !== this.managerSessionId) {
      throw new Error(
        "voice_sessions is available only to the OpenLive manager session.",
      );
    }
    if (!request.callerMessageId) {
      throw new Error("The manager tool caller message is missing.");
    }
    const entry = [...this.calls.values()].find(
      (call) => call.active?.manager && !call.active.abort.signal.aborted,
    );
    const turn = entry?.active;
    if (!entry || !turn) {
      throw new Error("No active manager voice call is available.");
    }
    if (!turn.assistantMessageIds.has(request.callerMessageId)) {
      const owned = await this.gateway.isAssistantForPrompt(
        this.managerSessionId,
        request.callerMessageId,
        turn.userMessageId,
      );
      if (!owned) {
        throw new Error(
          "The manager tool call does not belong to the active OpenLive turn.",
        );
      }
      turn.assistantMessageIds.add(request.callerMessageId);
    }

    switch (request.action) {
      case "list":
        return JSON.stringify(await this.inspector.list());
      case "status":
        return await this.inspector.status(request.sessionId ?? "");
      case "read":
        return await this.inspector.read(
          request.sessionId ?? "",
          request.limit,
        );
      case "attach": {
        const targetSessionId = request.sessionId ?? "";
        await this.inspector.requireAttachable(targetSessionId);
        assertCurrentControl(entry, turn, request, signal);
        turn.pendingTargetSessionId = targetSessionId;
        turn.pendingTargetSettings = undefined;
        return "Attachment accepted. Finish this response, then the next voice prompt will continue in the requested work session.";
      }
      case "create": {
        if (!entry.model) {
          throw new Error(
            "The OpenLive manager has no selected model for the new session.",
          );
        }
        assertCurrentControl(entry, turn, request, signal);
        const operationSignal = boundedControlSignal(request, signal);
        const created = await this.inspector.create(
          request.title,
          entry.model,
          operationSignal,
        );
        try {
          assertCurrentControl(entry, turn, request, signal);
        } catch (error) {
          await this.removeUnconfirmed(created.sessionId);
          throw error;
        }
        turn.pendingTargetSessionId = created.sessionId;
        turn.pendingTargetSettings = created.settings;
        turn.createdTargetSessionId = created.sessionId;
        return `Created work session ${created.sessionId}. Finish this response, then the next voice prompt will continue there.`;
      }
    }
  }

  private async removeUnconfirmed(sessionId: string): Promise<void> {
    await this.inspector
      .delete(sessionId, AbortSignal.timeout(this.cleanupTimeoutMs))
      .catch((error) => {
        process.stderr.write(
          `[openlive] failed to remove unconfirmed work session: ${String(error).slice(0, 500)}\n`,
        );
      });
  }

  private managerSettings(call: VoiceCall): PromptSettings {
    if (!call.model) {
      throw new Error("The OpenLive manager has no selected OpenCode model.");
    }
    return {
      agent: "openlive-manager",
      model: call.model,
      system: call.welcomePending ? FIRST_MANAGER_TURN_SYSTEM : undefined,
    };
  }

  private requireCall(id: string): VoiceCall {
    const call = this.calls.get(id);
    if (!call) throw new Error("Unknown ACP session.");
    return call;
  }
}

function assertCurrentControl(
  call: VoiceCall,
  turn: ActiveTurn,
  request: ControlRequest,
  signal?: AbortSignal,
): void {
  if (
    signal?.aborted ||
    (request.expiresAt !== undefined && Date.now() >= request.expiresAt) ||
    call.active !== turn ||
    turn.abort.signal.aborted ||
    call.generation !== turn.generation
  ) {
    throw new Error("The manager control request expired or changed.");
  }
}

function boundedControlSignal(
  request: ControlRequest,
  signal?: AbortSignal,
): AbortSignal | undefined {
  if (request.expiresAt === undefined) return signal;
  const deadline = AbortSignal.timeout(
    Math.max(1, request.expiresAt - Date.now()),
  );
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function createActiveTurn(
  generation: number,
  sessionId: string,
  manager: boolean,
): ActiveTurn {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    generation,
    sessionId,
    userMessageId: `msg_${randomUUID().replaceAll("-", "")}`,
    manager,
    submitted: false,
    preserveBackend: false,
    assistantMessageIds: new Set(),
    abort: new AbortController(),
    done,
    finish,
  };
}

async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
