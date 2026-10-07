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

test("derived timeout/quota/input-length classes are safe, round-trip the allowlist and never leak raw text", () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ["504 timeout", { statusCode: 504, message: "upstream gateway blew up" }, "provider_timeout", "The provider request timed out."],
    ["408 timeout", { statusCode: 408, message: "request timeout" }, "provider_timeout", "The provider request timed out."],
    ["quota exceeded", { statusCode: 429, message: "You have exceeded your current quota" }, "provider_quota", "The provider reported quota or budget exhaustion."],
    ["insufficient_quota", { statusCode: 429, message: "insufficient_quota" }, "provider_quota", "The provider reported quota or budget exhaustion."],
    ["budget exhausted", { statusCode: 402, message: "budget exceeded for this account" }, "provider_quota", "The provider reported quota or budget exhaustion."],
    ["input range in message", { statusCode: 400, message: "invalid_request_error: Range of input length should be [1, 128000]" }, "context_input_length", "Provider rejected the input length; reported allowed range is [1, 128000]."],
    ["input range in responseBody", { statusCode: 400, responseBody: { error: { message: "Range of input length should be [1, 65536]" } } }, "context_input_length", "Provider rejected the input length; reported allowed range is [1, 65536]."],
  ];
  for (const [label, data, category, message] of cases) {
    const detail = safeAssistantErrorDetail({ name: "APIError", data });
    assert.equal(detail?.category, category, label);
    assert.equal(detail?.message, message, label);
    assert.equal(detail?.detail_availability, "safe_template", label);
    assert.ok(isSafeAssistantErrorDetail(detail), label);
    assert.doesNotMatch(JSON.stringify(detail), /upstream gateway|blew up|exceeded your current quota|budget exceeded for this account/u, label);
  }
  const leaky = safeAssistantErrorDetail({ name: "APIError", data: { statusCode: 400, message: "Range of input length should be [1, 983616] SECRET-CONTEXT" } });
  assert.equal(leaky?.category, "context_input_length");
  assert.ok(!JSON.stringify(leaky).includes("SECRET-CONTEXT"));
});

test("rate limits and unrelated invalid requests stay redacted provider_error", () => {
  for (const data of [
    { statusCode: 429, message: "Rate limit reached for requests" },
    { statusCode: 429, message: "slow down please" },
    { statusCode: 400, message: "invalid_request_error: something else entirely" },
    { statusCode: 500, message: "internal error" },
    { message: "Range of input length should be [1, 100]" },
    { statusCode: 500, message: "Range of input length should be [1, 100]" },
  ]) {
    const detail = safeAssistantErrorDetail({ name: "APIError", data });
    assert.equal(detail?.category, "provider_error", JSON.stringify(data));
    assert.equal(detail?.detail_availability, "redacted", JSON.stringify(data));
    assert.ok(isSafeAssistantErrorDetail(detail), JSON.stringify(data));
  }
});

test("derived classes preserve retryability, keep metadata precedence and reject tampered persisted details", () => {
  const retryable = safeAssistantErrorDetail({ name: "APIError", data: { statusCode: 504, isRetryable: true } });
  assert.equal(retryable?.source_is_retryable, true);
  assert.ok(isSafeAssistantErrorDetail(retryable));
  const nonRetryable = safeAssistantErrorDetail({ name: "APIError", data: { statusCode: 429, message: "insufficient_quota", isRetryable: false } });
  assert.equal(nonRetryable?.source_is_retryable, false);
  assert.ok(isSafeAssistantErrorDetail(nonRetryable));
  const ranged = safeAssistantErrorDetail({ name: "APIError", data: { statusCode: 400, message: "Range of input length should be [1, 983616]" } });
  for (const tampered of [
    { ...(retryable as object), message: "The provider request timed out badly." },
    { ...(retryable as object), category: "provider_quota" },
    { ...(ranged as object), message: "Provider rejected the input length; reported allowed range is [1, 983616]. EXTRA" },
    { ...(ranged as object), detail_availability: "redacted" },
  ]) {
    assert.equal(isSafeAssistantErrorDetail(tampered), false, JSON.stringify(tampered));
  }
  const headerTimeout = safeAssistantErrorDetail({ name: "APIError", data: { statusCode: 504, metadata: { code: "ProviderHeaderTimeoutError", timeoutMs: "30000" } } });
  assert.equal(headerTimeout?.category, "provider_header_timeout", "explicit metadata codes keep precedence over status-derived classes");
});
