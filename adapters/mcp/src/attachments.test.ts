import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AttachmentStore,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
} from "./attachments.js";
import { AdapterError } from "./types.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

test("attachment references are hashed, session-bound, and consumed once", () => {
  const store = new AttachmentStore();
  try {
    const content = Buffer.from("# UI notes\nKeep the launcher compact.\n");
    const uploaded = store.upload(
      "ses_work",
      "design.md",
      "text/markdown",
      content.toString("base64"),
    );
    assert.match(uploaded.attachment_id, /^att_[a-f0-9]{32}$/u);
    assert.equal(uploaded.size_bytes, content.length);
    assert.equal(
      uploaded.sha256,
      createHash("sha256").update(content).digest("hex"),
    );
    assert.equal(
      store
        .resolve("ses_work", [uploaded.attachment_id])[0]
        ?.data.toString("utf8"),
      content.toString("utf8"),
    );

    assert.throws(
      () => store.resolve("ses_other", [uploaded.attachment_id]),
      errorCode("ATTACHMENT_ACCESS_DENIED"),
    );
    const [resolved] = store.resolve("ses_work", [uploaded.attachment_id]);
    assert.ok(resolved);
    store.consume("ses_work", [resolved]);
    assert.ok(resolved.data.every((byte) => byte === 0));
    assert.throws(
      () => store.resolve("ses_work", [uploaded.attachment_id]),
      errorCode("ATTACHMENT_NOT_FOUND"),
    );
  } finally {
    store.close();
  }
});

test("attachment upload rejects paths, arbitrary references, wrong MIME and unsupported types", () => {
  const store = new AttachmentStore();
  try {
    const png = pngBytes(16);
    assert.throws(
      () =>
        store.upload(
          "ses_work",
          "../secret.png",
          "image/png",
          png.toString("base64"),
        ),
      errorCode("INVALID_ATTACHMENT_REFERENCE"),
    );
    assert.throws(
      () => store.resolve("ses_work", ["/etc/passwd"]),
      errorCode("INVALID_ATTACHMENT_REFERENCE"),
    );
    assert.throws(
      () =>
        store.upload(
          "ses_work",
          "image.png",
          "image/jpeg",
          png.toString("base64"),
        ),
      errorCode("UNSUPPORTED_MEDIA_TYPE"),
    );
    assert.throws(
      () =>
        store.upload("ses_work", "report.pdf", "application/pdf", "JVBERi0="),
      errorCode("UNSUPPORTED_MEDIA_TYPE"),
    );
    assert.throws(
      () => store.upload("ses_work", "notes.txt", "text/plain", "/w=="),
      errorCode("UNSUPPORTED_MEDIA_TYPE"),
    );
    assert.throws(
      () =>
        store.upload(
          "ses_work",
          "large.txt",
          "text/plain",
          Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES + 1, 0x61).toString("base64"),
        ),
      errorCode("ATTACHMENT_TOO_LARGE"),
    );
  } finally {
    store.close();
  }
});

test("per-file, per-message and count limits are enforced", () => {
  const store = new AttachmentStore();
  try {
    const oversized = Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1);
    oversized.set(PNG_SIGNATURE);
    assert.throws(
      () =>
        store.upload(
          "ses_work",
          "large.png",
          "image/png",
          oversized.toString("base64"),
        ),
      errorCode("ATTACHMENT_TOO_LARGE"),
    );

    const ids = Array.from({ length: 3 }, (_, index) => {
      const uploaded = store.upload(
        "ses_work",
        `part-${index}.png`,
        "image/png",
        pngBytes(4 * 1024 * 1024).toString("base64"),
      );
      return uploaded.attachment_id;
    });
    assert.throws(
      () => store.resolve("ses_work", ids),
      errorCode("ATTACHMENT_TOO_LARGE"),
    );
    assert.throws(
      () =>
        store.resolve("ses_work", [
          ...ids,
          "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "att_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ]),
      errorCode("ATTACHMENT_TOO_LARGE"),
    );
  } finally {
    store.close();
  }
});

test("expired attachment references are removed from the temporary store", () => {
  let now = 1_000;
  const store = new AttachmentStore(() => now);
  try {
    const uploaded = store.upload(
      "ses_work",
      "note.txt",
      "text/plain",
      Buffer.from("temporary").toString("base64"),
    );
    assert.equal(
      uploaded.expires_at,
      new Date(now + 10 * 60 * 1000).toISOString(),
    );
    now += 10 * 60 * 1000 + 1;
    assert.throws(
      () => store.resolve("ses_work", [uploaded.attachment_id]),
      errorCode("ATTACHMENT_NOT_FOUND"),
    );
  } finally {
    store.close();
  }
});

function pngBytes(size: number): Buffer {
  const data = Buffer.alloc(size, 0x41);
  PNG_SIGNATURE.copy(data);
  return data;
}

function errorCode(code: string) {
  return (error: unknown) =>
    error instanceof AdapterError && error.code === code;
}
