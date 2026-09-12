import * as acp from "@agentclientprotocol/sdk";
import { Readable, Transform, Writable } from "node:stream";
import type { CallController } from "../core/call-controller.js";
import type { PromptImage } from "../types.js";

const OPENLIVE_PREAMBLE_PREFIX =
  "[You're being used through OpenLive, a hands-free VOICE interface";
const MODEL_CONFIG_ID = "model";
const ADAPTER_VERSION = "0.1.5";
const MAX_PROMPT_IMAGES = 2;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ACP_LINE_BYTES = 12 * 1024 * 1024;

type PromptBlock = {
  type: string;
  text?: string | null;
  data?: string | null;
  mimeType?: string | null;
};

export async function startAcp(
  controller: CallController,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const app = acp
    .agent({ name: "opencode-vm-openlive" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {} },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: false,
        },
      },
      agentInfo: { name: "opencode-vm OpenLive", version: ADAPTER_VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, async (context) => {
      validateSessionScope(context.params);
      const sessionId = controller.newCall();
      return {
        sessionId,
        configOptions: modelConfigOptions(controller, sessionId),
      };
    })
    .onRequest(acp.methods.agent.session.load, async (context) => {
      validateSessionScope(context.params);
      controller.loadCall(context.params.sessionId);
      for (const message of await controller.replayManager()) {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate:
              message.role === "user"
                ? "user_message_chunk"
                : "agent_message_chunk",
            content: { type: "text", text: message.text },
            messageId: message.id,
          },
        });
      }
      return {
        configOptions: modelConfigOptions(controller, context.params.sessionId),
      };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async (context) => {
      if (
        context.params.configId !== MODEL_CONFIG_ID ||
        typeof context.params.value !== "string"
      ) {
        throw new Error("Unsupported OpenLive session configuration option.");
      }
      controller.setModel(context.params.sessionId, context.params.value);
      return {
        configOptions: modelConfigOptions(controller, context.params.sessionId),
      };
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      const started = Date.now();
      process.stderr.write("[openlive] prompt accepted\n");
      const { text: rawText, images } = parsePromptContent(
        context.params.prompt,
      );
      const text = stripOpenLivePreamble(rawText);
      if (!text.trim())
        throw new Error("An OpenLive prompt must include text.");
      const cancel = () => {
        void controller.cancel(context.params.sessionId);
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        const stopReason = await controller.prompt(
          context.params.sessionId,
          text,
          async (update) => {
            await context.client.notify(acp.methods.client.session.update, {
              sessionId: context.params.sessionId,
              update: {
                sessionUpdate:
                  update.type === "thought"
                    ? "agent_thought_chunk"
                    : "agent_message_chunk",
                content: { type: "text", text: update.text },
                messageId: update.messageId,
              },
            });
          },
          images,
        );
        process.stderr.write(
          `[openlive] prompt ${stopReason} after ${Date.now() - started}ms\n`,
        );
        return { stopReason };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unexpected prompt error";
        process.stderr.write(
          `[openlive] prompt failed after ${Date.now() - started}ms: ${message.slice(0, 500)}\n`,
        );
        throw error;
      } finally {
        context.signal.removeEventListener("abort", cancel);
      }
    })
    .onNotification(acp.methods.agent.session.cancel, async (context) => {
      await controller.cancel(context.params.sessionId);
    })
    .onRequest(acp.methods.agent.session.close, async (context) => {
      await controller.close(context.params.sessionId);
      return {};
    });

  const stream = acp.ndJsonStream(
    Writable.toWeb(output),
    Readable.toWeb(limitNdjsonLines(input)) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  try {
    await connection.closed;
  } finally {
    await controller.shutdown();
  }
}

export function limitNdjsonLines(
  input: Readable,
  maxBytes = MAX_ACP_LINE_BYTES,
): Readable {
  let lineBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        if (byte === 0x0a) lineBytes = 0;
        else if (++lineBytes > maxBytes) {
          callback(
            new Error(
              `OpenLive ACP message exceeds the ${maxBytes}-byte limit.`,
            ),
          );
          return;
        }
      }
      callback(null, chunk);
    },
  });
  return input.pipe(limiter);
}

export function parsePromptContent(prompt: readonly PromptBlock[]): {
  text: string;
  images: PromptImage[];
} {
  const text = prompt
    .filter(
      (content): content is PromptBlock & { text: string } =>
        content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text)
    .join("\n");
  const imageBlocks = prompt.filter((content) => content.type === "image");
  if (imageBlocks.length > MAX_PROMPT_IMAGES) {
    throw new Error(
      `OpenLive sent ${imageBlocks.length} images; at most ${MAX_PROMPT_IMAGES} camera/screen frames are supported per turn.`,
    );
  }

  let totalBytes = 0;
  const images = imageBlocks.map((content): PromptImage => {
    if (content.mimeType !== "image/jpeg") {
      throw new Error(
        `Unsupported OpenLive image type: ${content.mimeType ?? "missing"}. Only image/jpeg screen frames are supported.`,
      );
    }
    if (typeof content.data !== "string") {
      throw new Error("OpenLive sent an invalid base64 JPEG frame.");
    }
    if (content.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
      throw new Error("An OpenLive JPEG frame exceeds the 5 MiB limit.");
    }
    if (!isBase64(content.data)) {
      throw new Error("OpenLive sent an invalid base64 JPEG frame.");
    }
    const bytes = Buffer.byteLength(content.data, "base64");
    if (bytes === 0 || bytes > MAX_IMAGE_BYTES) {
      throw new Error("An OpenLive JPEG frame exceeds the 5 MiB limit.");
    }
    totalBytes += bytes;
    if (totalBytes > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error("OpenLive image data exceeds the 8 MiB per-turn limit.");
    }
    return { data: content.data, mimeType: "image/jpeg" };
  });
  return { text, images };
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    const base64Character =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!base64Character) return false;
  }
  for (let index = value.length - padding; index < value.length; index++) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

type SessionScope = {
  cwd: string;
  additionalDirectories?: unknown[] | null;
  mcpServers?: unknown[];
};

export function validateSessionScope(params: SessionScope): void {
  if (params.cwd !== process.env.OCVM_OPENLIVE_PROJECT) {
    throw new Error("OpenLive workspace does not match the running project.");
  }
  if (params.additionalDirectories?.length) {
    throw new Error("Additional OpenLive workspaces are not supported.");
  }
  // The central OpenCode runtime already owns its MCP configuration. ACP-side
  // definitions are intentionally ignored rather than executed inside the VM.
}

export function stripOpenLivePreamble(text: string): string {
  if (!text.startsWith(OPENLIVE_PREAMBLE_PREFIX)) return text;
  const end = text.indexOf("]");
  return end === -1 ? text : text.slice(end + 1).trimStart();
}

export function modelConfigOptions(
  controller: CallController,
  sessionId: string,
): acp.SessionConfigOption[] {
  const state = controller.modelState(sessionId);
  if (!state) return [];
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.current,
      options: state.options.map((option) => ({
        value: option.id,
        name: option.name,
      })),
    },
  ];
}
