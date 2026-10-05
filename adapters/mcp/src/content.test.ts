import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeAssistantErrorDetail,
  MAX_ERROR_DETAIL_MESSAGE_BYTES,
  safeAssistantErrorDetail,
} from "./content.js";

test("safe assistant error detail projects the demonstrated header timeout without provider payload", () => {
  const detail = safeAssistantErrorDetail({
    name: "APIError",
    data: {
      message: "PRIVATE_PROVIDER_MESSAGE",
      isRetryable: true,
      metadata: {
        code: "ProviderHeaderTimeoutError",
        timeoutMs: "300000",
        headers: { authorization: "Bearer PRIVATE_TOKEN" },
      },
    },
  });
  assert.deepEqual(detail, {
    category: "provider_header_timeout",
    name: "APIError",
    code: "ProviderHeaderTimeoutError",
    timeout_ms: 300000,
    message: "Provider response headers timed out after 300000ms.",
    detail_availability: "safe_template",
    source: "assistant_message_error",
    source_is_retryable: true,
  });
  assert.ok(isSafeAssistantErrorDetail(detail));
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE_/u);
});

test("safe assistant error detail redacts unknown or malformed provider evidence", () => {
  const privateUnicode = "PRIVATE秘密".repeat(1024);
  const unknown = safeAssistantErrorDetail({
    name: "UnexpectedProviderError",
    data: { message: privateUnicode, metadata: { code: privateUnicode } },
  });
  const malformedTimeout = safeAssistantErrorDetail({
    name: "APIError",
    data: {
      isRetryable: false,
      metadata: { code: "ProviderHeaderTimeoutError", timeoutMs: "00" },
      message: privateUnicode,
    },
  });
  assert.deepEqual(unknown, {
    category: "unknown",
    message: "The worker failed, but its stored error detail is not safe to expose.",
    detail_availability: "redacted",
    source: "assistant_message_error",
  });
  assert.deepEqual(malformedTimeout, {
    category: "provider_error",
    name: "APIError",
    message: "The worker failed, but its stored error detail is not safe to expose.",
    detail_availability: "redacted",
    source: "assistant_message_error",
    source_is_retryable: false,
  });
  for (const detail of [unknown, malformedTimeout]) {
    assert.ok(detail && isSafeAssistantErrorDetail(detail));
    assert.ok(
      Buffer.byteLength(detail?.message ?? "", "utf8") <=
        MAX_ERROR_DETAIL_MESSAGE_BYTES,
    );
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|秘密/u);
  }
});

test("safe assistant error detail handles known stream failures and rejects changed persisted evidence", () => {
  const detail = safeAssistantErrorDetail({
    name: "APIError",
    data: {
      isRetryable: true,
      metadata: { code: "ProviderResponseStreamError" },
    },
  });
  assert.deepEqual(detail, {
    category: "provider_response_stream_error",
    name: "APIError",
    code: "ProviderResponseStreamError",
    message: "The provider response stream failed.",
    detail_availability: "safe_template",
    source: "assistant_message_error",
    source_is_retryable: true,
  });
  assert.ok(isSafeAssistantErrorDetail(detail));
  assert.equal(
    isSafeAssistantErrorDetail({ ...detail, provider: "PRIVATE_PROVIDER" }),
    false,
  );
  assert.equal(
    isSafeAssistantErrorDetail({ ...detail, message: "PRIVATE_PROVIDER" }),
    false,
  );
});

test("safe assistant error detail preserves the established abort classification", () => {
  assert.deepEqual(safeAssistantErrorDetail({ name: "MessageAbortedError" }), {
    category: "aborted",
    name: "MessageAbortedError",
    message: "The worker turn was aborted.",
    detail_availability: "safe_template",
    source: "assistant_message_error",
  });
});
