import { createHash, randomUUID } from "node:crypto";
import { AdapterError } from "./types.js";

export const MAX_ATTACHMENT_COUNT = 4;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_STAGED_ATTACHMENT_COUNT = 32;
const MAX_STAGED_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 10 * 60 * 1000;
const MAX_FILENAME_BYTES = 255;
const ATTACHMENT_ID = /^att_[a-f0-9]{32}$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const SUPPORTED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
] as const;

export type AttachmentMimeType = (typeof SUPPORTED_ATTACHMENT_TYPES)[number];

export type AttachmentDescriptor = {
  attachment_id: string;
  filename: string;
  mime_type: AttachmentMimeType;
  size_bytes: number;
  sha256: string;
  expires_at: string;
};

export type SubmittedAttachment = Omit<AttachmentDescriptor, "expires_at">;

export type StoredAttachment = AttachmentDescriptor & {
  sessionId: string;
  expiresAt: number;
  data: Buffer;
};

export class AttachmentStore {
  private readonly entries = new Map<string, StoredAttachment>();
  private stagedBytes = 0;
  private closed = false;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.sweepTimer = setInterval(() => this.sweepExpired(), 60_000);
    this.sweepTimer.unref();
  }

  upload(
    sessionId: string,
    filename: string,
    mimeType: string,
    dataBase64: string,
  ): AttachmentDescriptor {
    this.requireOpen();
    this.sweepExpired();
    const mime = mimeType.trim().toLowerCase();
    if (!isSupportedMimeType(mime)) {
      throw new AdapterError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Only PNG, JPEG, WebP, plain-text and Markdown attachments are supported.",
      );
    }
    validateFilename(filename);
    if (
      dataBase64.length >
      Math.ceil((MAX_IMAGE_ATTACHMENT_BYTES + 2) / 3) * 4
    ) {
      throw new AdapterError(
        "ATTACHMENT_TOO_LARGE",
        "An attachment exceeds the 5 MiB per-file limit.",
      );
    }
    if (
      !dataBase64 ||
      dataBase64.length % 4 !== 0 ||
      !BASE64.test(dataBase64)
    ) {
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "data_base64 must contain canonical padded Base64 data.",
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.toString("base64") !== dataBase64) {
      data.fill(0);
      throw new AdapterError(
        "INVALID_ARGUMENT",
        "data_base64 must contain canonical padded Base64 data.",
      );
    }
    const maximum = mime.startsWith("text/")
      ? MAX_TEXT_ATTACHMENT_BYTES
      : MAX_IMAGE_ATTACHMENT_BYTES;
    if (data.length === 0 || data.length > maximum) {
      data.fill(0);
      throw new AdapterError(
        "ATTACHMENT_TOO_LARGE",
        mime.startsWith("text/")
          ? "Text attachments must contain 1 byte to 512 KiB."
          : "Image attachments must contain 1 byte to 5 MiB.",
      );
    }
    validateContent(mime, data);
    if (
      this.entries.size >= MAX_STAGED_ATTACHMENT_COUNT ||
      this.stagedBytes + data.length > MAX_STAGED_ATTACHMENT_BYTES
    ) {
      data.fill(0);
      throw new AdapterError(
        "ATTACHMENT_TOO_LARGE",
        "The adapter's temporary attachment capacity is full; wait for pending references to expire.",
      );
    }

    const expiresAt = this.now() + ATTACHMENT_TTL_MS;
    const attachment: StoredAttachment = {
      attachment_id: `att_${randomUUID().replaceAll("-", "")}`,
      filename,
      mime_type: mime,
      size_bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      expires_at: new Date(expiresAt).toISOString(),
      sessionId,
      expiresAt,
      data,
    };
    this.entries.set(attachment.attachment_id, attachment);
    this.stagedBytes += data.length;
    return descriptor(attachment);
  }

  resolve(sessionId: string, attachmentIds: string[]): StoredAttachment[] {
    this.requireOpen();
    this.sweepExpired();
    if (attachmentIds.length > MAX_ATTACHMENT_COUNT) {
      throw new AdapterError(
        "ATTACHMENT_TOO_LARGE",
        `A message can contain at most ${MAX_ATTACHMENT_COUNT} attachments.`,
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw invalidReference();
    }
    const attachments: StoredAttachment[] = [];
    let totalBytes = 0;
    for (const id of attachmentIds) {
      if (!ATTACHMENT_ID.test(id)) throw invalidReference();
      const attachment = this.entries.get(id);
      if (!attachment) {
        throw new AdapterError(
          "ATTACHMENT_NOT_FOUND",
          "The attachment reference is absent, expired or already used.",
        );
      }
      if (attachment.sessionId !== sessionId) {
        throw new AdapterError(
          "ATTACHMENT_ACCESS_DENIED",
          "The attachment reference belongs to a different session.",
        );
      }
      totalBytes += attachment.size_bytes;
      attachments.push(attachment);
    }
    if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new AdapterError(
        "ATTACHMENT_TOO_LARGE",
        "Attachments in one message may total at most 10 MiB.",
      );
    }
    return attachments;
  }

  consume(sessionId: string, attachments: StoredAttachment[]): void {
    this.requireOpen();
    for (const attachment of attachments) {
      if (this.entries.get(attachment.attachment_id) !== attachment) {
        throw new AdapterError(
          "ATTACHMENT_NOT_FOUND",
          "An attachment expired before it could be submitted.",
        );
      }
      if (attachment.sessionId !== sessionId) {
        throw new AdapterError(
          "ATTACHMENT_ACCESS_DENIED",
          "The attachment reference belongs to a different session.",
        );
      }
      if (attachment.expiresAt <= this.now()) {
        this.remove(attachment.attachment_id, true);
        throw new AdapterError(
          "ATTACHMENT_NOT_FOUND",
          "The attachment reference expired before it could be submitted.",
        );
      }
    }
    for (const attachment of attachments) {
      this.remove(attachment.attachment_id, false);
      attachment.data.fill(0);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    for (const id of this.entries.keys()) this.remove(id, true);
  }

  private sweepExpired(): void {
    if (this.closed) return;
    const now = this.now();
    for (const [id, attachment] of this.entries) {
      if (attachment.expiresAt <= now) this.remove(id, true);
    }
  }

  private remove(id: string, wipe: boolean): void {
    const attachment = this.entries.get(id);
    if (!attachment) return;
    this.entries.delete(id);
    this.stagedBytes -= attachment.size_bytes;
    if (wipe) attachment.data.fill(0);
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new AdapterError(
        "ATTACHMENT_NOT_FOUND",
        "The attachment store is no longer available.",
      );
    }
  }
}

export function submittedAttachment(
  attachment: StoredAttachment,
): SubmittedAttachment {
  return {
    attachment_id: attachment.attachment_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256,
  };
}

function descriptor(attachment: StoredAttachment): AttachmentDescriptor {
  return {
    attachment_id: attachment.attachment_id,
    filename: attachment.filename,
    mime_type: attachment.mime_type,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256,
    expires_at: attachment.expires_at,
  };
}

function isSupportedMimeType(value: string): value is AttachmentMimeType {
  return (SUPPORTED_ATTACHMENT_TYPES as readonly string[]).includes(value);
}

function validateFilename(filename: string): void {
  if (
    !filename ||
    filename.trim() !== filename ||
    filename === "." ||
    filename === ".." ||
    Buffer.byteLength(filename, "utf8") > MAX_FILENAME_BYTES ||
    /[\\/\x00-\x1f\x7f]/u.test(filename)
  ) {
    throw new AdapterError(
      "INVALID_ATTACHMENT_REFERENCE",
      "filename must be a single safe name, not a path, and at most 255 UTF-8 bytes.",
    );
  }
}

function validateContent(mime: AttachmentMimeType, data: Buffer): void {
  let matches = false;
  switch (mime) {
    case "image/png":
      matches =
        data.length >= PNG_SIGNATURE.length &&
        data.subarray(0, 8).equals(PNG_SIGNATURE);
      break;
    case "image/jpeg":
      matches =
        data.length >= 4 &&
        data[0] === 0xff &&
        data[1] === 0xd8 &&
        data[2] === 0xff;
      break;
    case "image/webp":
      matches =
        data.length >= 12 &&
        data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WEBP";
      break;
    case "text/plain":
    case "text/markdown":
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
        matches = !data.includes(0);
      } catch {
        matches = false;
      }
      break;
  }
  if (!matches) {
    data.fill(0);
    throw new AdapterError(
      "UNSUPPORTED_MEDIA_TYPE",
      "The attachment bytes do not match the declared supported media type.",
    );
  }
}

function invalidReference(): AdapterError {
  return new AdapterError(
    "INVALID_ATTACHMENT_REFERENCE",
    "attachments must contain unique attachment IDs returned by upload_attachment; paths and other references are not accepted.",
  );
}
