import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { AdapterError, isRecord } from "./types.js";
import type { ContentDescriptor, HistoryMessage } from "./types.js";

// Leave room for the concise content block and JSON-RPC envelope. The HTTP
// boundary also bounds request IDs; tools.ts checks the actual final envelope.
export const READ_PAYLOAD_BYTES = 48 * 1024;
export const READ_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_CONTENT_BYTES = 8192;
export const MAX_CONTENT_BYTES = 16384;
export const PREVIEW_BYTES = 1024;

export type StoredMessage = { info: Message; parts: Part[] };
export type ContentReference = {
  kind: "content";
  session: string;
  message: string;
  revision: string;
};

/** Authenticated, adapter-lifetime references, never file paths or authority.
 * No conversation copy is retained. Restart recovery is get_message again. */
export class ReadReferences {
  private readonly key = randomBytes(32);
  private readonly epoch = randomBytes(16).toString("hex");

  encode(value: object): string {
    const body = Buffer.from(
      JSON.stringify({ ...value, epoch: this.epoch }),
    ).toString("base64url");
    return `${body}.${this.mac(body).toString("base64url")}`;
  }

  decode<T extends { kind: string }>(token: string, kind: T["kind"]): T {
    try {
      if (
        token.length > 16384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
      )
        throw new Error();
      const [body, signature] = token.split(".") as [string, string];
      const value: unknown = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      );
      if (!isRecord(value) || value.kind !== kind) throw new Error();
      const actual = Buffer.from(signature, "base64url");
      const expected = this.mac(body);
      if (value.epoch !== this.epoch) {
        throw new AdapterError(
          "READ_REFERENCE_EXPIRED",
          "Read reference is from another adapter lifetime. Restart the read using session/message IDs.",
        );
      }
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      return value as T;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "Read reference or cursor is invalid.",
      );
    }
  }

  private mac(body: string): Buffer {
    return createHmac("sha256", this.key).update(body).digest();
  }
}

export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function utf8Prefix(text: string, maximum: number): string {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, maximum);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function visibleContent(message: StoredMessage): {
  text: string;
  omitted: ContentDescriptor["omitted_parts"];
  availability: ContentDescriptor["availability"];
} {
  const texts: string[] = [];
  const omitted = new Map<string, number>();
  for (const part of message.parts) {
    if (part.type === "text" && !part.synthetic && !part.ignored) {
      if (typeof part.text !== "string" || !part.text.isWellFormed()) {
        throw new AdapterError(
          "BACKEND_INCOMPATIBLE",
          "Stored visible text is not valid Unicode text.",
        );
      }
      texts.push(part.text);
    } else {
      const type = ["text", "reasoning", "tool", "file"].includes(part.type)
        ? part.type
        : "other";
      omitted.set(type, (omitted.get(type) ?? 0) + 1);
    }
  }
  const text = texts.join("");
  return {
    text,
    availability: text.length
      ? "available"
      : texts.length || !omitted.size
        ? "empty"
        : "not_exposed",
    omitted: [...omitted].map(([type, count]) => ({
      type,
      count,
      reason: "part_not_exposed" as const,
    })),
  };
}

export function describeMessage(
  message: StoredMessage,
  references: ReadReferences,
  previewBytes = PREVIEW_BYTES,
): HistoryMessage {
  const { info } = message;
  const visible = visibleContent(message);
  const sha256 = digest(visible.text);
  const revision = `visible-text-v1:${sha256}`;
  const text = utf8Prefix(visible.text, previewBytes);
  const truncated = text !== visible.text;
  return {
    id: info.id,
    role: info.role,
    ...(info.role === "assistant" ? { parent_id: info.parentID } : {}),
    text,
    created: info.time.created,
    ...(info.role === "assistant" && typeof info.time.completed === "number"
      ? { completed: info.time.completed }
      : {}),
    ...(info.role === "assistant" && info.finish
      ? { finish: info.finish }
      : {}),
    ...(info.role === "assistant" && info.error
      ? {
          error:
            info.error.name === "MessageAbortedError"
              ? ("aborted" as const)
              : ("failed" as const),
        }
      : {}),
    text_truncated: truncated,
    content_complete: !truncated,
    ...(truncated ? { truncation_reason: "preview_limit" as const } : {}),
    content: {
      content_ref: references.encode({
        kind: "content",
        session: info.sessionID,
        message: info.id,
        revision,
      }),
      revision,
      unit: "utf8_bytes",
      total_bytes: Buffer.byteLength(visible.text),
      sha256,
      availability: visible.availability,
      omitted_parts: visible.omitted,
    },
  };
}

export function fitPreviews<T>(result: T, messages: HistoryMessage[]): T {
  while (jsonBytes(result) > READ_PAYLOAD_BYTES) {
    const longest = messages.reduce<HistoryMessage | undefined>(
      (best, item) =>
        item.text.length > (best?.text.length ?? 0) ? item : best,
      undefined,
    );
    if (!longest?.text)
      throw new AdapterError(
        "RESPONSE_BUDGET_EXCEEDED",
        "Read metadata exceeds the response budget. Use a smaller page limit.",
      );
    longest.text = utf8Prefix(
      longest.text,
      Math.floor(Buffer.byteLength(longest.text) / 2),
    );
    longest.text_truncated = true;
    longest.content_complete = false;
    longest.truncation_reason = "response_budget";
  }
  return result;
}
