import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import { AdapterError, isRecord } from "./types.js";
import type { AttentionEntry, EventSubscription } from "./types.js";
import type { ActivityJournal } from "./activity.js";

const EVENT_NAMES = ["worker.completed", "worker.failed", "worker.aborted", "worker.input_required"] as const;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 6;

export const MCP_EVENT_DEFINITIONS = EVENT_NAMES.map((name) => ({
  name,
  description: `A correlated OpenCode worker ${name.slice("worker.".length)} result has been prefetched for this project. Event delivery does not authorize follow-up execution.`,
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Optional exact project task ID." },
      session_id: { type: "string", description: "Optional exact exposed session ID." },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      event_id: { type: "string" },
      task_id: { type: "string" },
      session_id: { type: "string" },
      message_id: { type: "string" },
      source_revision: { type: "string" },
      classification: { type: "string", enum: ["ready", "attention", "action_required"] },
      prepared_summary: { type: "string" },
      next_safe_step: { type: "string" },
      lifecycle: { type: "string", enum: ["ready", "offered", "discussed", "superseded"] },
      hierarchy_status: { type: "string", enum: ["resolved", "unlinked", "ambiguous", "unavailable"] },
    },
    required: ["event_id", "session_id", "source_revision", "classification", "prepared_summary", "next_safe_step", "lifecycle", "hierarchy_status"],
    additionalProperties: false,
  },
}));

type Delivery = { mode: "webhook"; url: string; secret?: string };
type SubscribeParams = {
  name: string;
  arguments?: unknown;
  delivery: Delivery;
  cursor?: string | null;
  ttlMs?: number | null;
};
type WebhookResponse = { status: number; body: string };
export type WebhookRequest = (url: URL, body: string, headers: Record<string, string>) => Promise<WebhookResponse>;

class CallbackEndpointError extends AdapterError {
  constructor(readonly callbackReason: string, message: string) {
    super("EVENT_CALLBACK_ERROR", message);
  }
}

export class McpEventBridge {
  constructor(
    private readonly journal: ActivityJournal,
    private readonly projectId: string,
    private readonly send: WebhookRequest = secureWebhookRequest,
  ) {}

  async handle(method: string, params: unknown): Promise<unknown> {
    if (method === "events/list") return { events: MCP_EVENT_DEFINITIONS };
    if (method === "events/subscribe") return this.subscribe(params);
    if (method === "events/unsubscribe") return this.unsubscribe(params);
    throw new AdapterError("UNSUPPORTED_CONFIGURATION", "Unsupported MCP Events method.");
  }

  async deliverPending(): Promise<void> {
    const pending = await this.journal.pendingDeliveries();
    for (const { entry, subscription } of pending) {
      try {
        const body = JSON.stringify(this.occurrence(entry));
        if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) {
          await this.journal.recordDelivery(entry.event_id, subscription.id, { state: "abandoned", http_status: 413 });
          continue;
        }
        const timestamp = String(Math.floor(Date.now() / 1000));
        const headers = this.headers(subscription, entry.event_id, timestamp, body);
        const response = await this.send(new URL(subscription.callback_url), body, headers);
        if (response.status >= 200 && response.status < 300) {
          await this.journal.recordDelivery(entry.event_id, subscription.id, { state: "delivered", http_status: response.status });
        } else if (response.status === 410 || response.status === 413 ||
          (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
          await this.journal.recordDelivery(entry.event_id, subscription.id, { state: "abandoned", http_status: response.status });
        } else {
          await this.recordRetry(entry, subscription, response.status);
        }
      } catch {
        await this.recordRetry(entry, subscription);
      }
    }
  }

  private async subscribe(raw: unknown): Promise<unknown> {
    const params = validateSubscribe(raw);
    const callback = validateCallbackUrl(params.delivery.url);
    const secret = validateSecret(params.delivery.secret);
    const args = canonicalArguments(params.arguments);
    const canonicalKey = JSON.stringify([this.projectId, callback.href, params.name, args]);
    const id = `sub_${createHash("sha256").update(canonicalKey).digest("hex").slice(0, 32)}`;
    const previous = await this.journal.subscription(id);
    const existing = previous && (previous.expires_at === null || Date.parse(previous.expires_at) > Date.now()) ? previous : undefined;
    const activeSubscriptions = await this.journal.subscriptions();
    if (!existing && activeSubscriptions.length >= 32)
      throw new AdapterError("EVENT_SUBSCRIPTION_LIMIT", "The project event subscription limit is 32.");
    const challenge = randomBytes(24).toString("base64url");
    const challengeBody = JSON.stringify({ type: "verification", challenge });
    const verificationId = `msg_verification_${randomBytes(16).toString("hex")}`;
    const verificationTimestamp = String(Math.floor(Date.now() / 1000));
    let verification: WebhookResponse;
    try {
      verification = await this.send(callback, challengeBody, this.signHeaders(
        secret, verificationId, verificationTimestamp, challengeBody, id,
      ));
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      const reason = /TIMEOUT|timed out/iu.test(error instanceof Error ? error.message : "") || errorCode === "ETIMEDOUT"
        ? "timeout" : errorCode === "ECONNREFUSED" ? "connection_refused" : "tls_error";
      throw new CallbackEndpointError(reason, "Webhook callback challenge request failed.");
    }
    if (verification.status < 200 || verification.status >= 300)
      throw new CallbackEndpointError(verification.status >= 500 ? "http_5xx" : "http_4xx", "Webhook callback returned a non-success status for its challenge.");
    if (!constantTimeChallenge(verification.body, challenge))
      throw new CallbackEndpointError("challenge_failed", "Webhook callback did not echo the signed challenge.");

    const suggested = params.ttlMs === undefined ? DEFAULT_TTL_MS : params.ttlMs;
    const ttl = suggested === null ? null : Math.min(MAX_TTL_MS, Math.max(60_000, suggested));
    const now = new Date();
    const subscription: EventSubscription = {
      id,
      event_name: params.name,
      arguments: args,
      callback_url: callback.href,
      secret,
      previous_secret: existing && existing.secret !== secret ? existing.secret :
        existing?.previous_secret && existing.previous_secret_expires_at && Date.parse(existing.previous_secret_expires_at) > Date.now() ? existing.previous_secret : undefined,
      previous_secret_expires_at: existing && existing.secret !== secret ? new Date(Date.now() + 5 * 60_000).toISOString() :
        existing?.previous_secret && existing.previous_secret_expires_at && Date.parse(existing.previous_secret_expires_at) > Date.now() ? existing.previous_secret_expires_at : undefined,
      expires_at: ttl === null ? null : new Date(now.getTime() + ttl).toISOString(),
      last_cursor: existing?.last_cursor ?? this.journal.cursor,
      created_at: existing?.created_at ?? now.toISOString(),
      active: true,
    };
    await this.journal.upsertSubscription(subscription);
    return {
      id,
      refreshBefore: subscription.expires_at,
      cursor: null,
      truncated: params.cursor !== undefined && params.cursor !== null,
    };
  }

  private async unsubscribe(raw: unknown): Promise<unknown> {
    if (!isRecord(raw) || typeof raw.name !== "string" || !EVENT_NAMES.includes(raw.name as typeof EVENT_NAMES[number]) ||
      !isRecord(raw.delivery) || typeof raw.delivery.url !== "string")
      throw invalidParams("Invalid webhook unsubscribe request.");
    const callback = validateCallbackUrl(raw.delivery.url);
    const args = canonicalArguments(raw.arguments);
    const canonicalKey = JSON.stringify([this.projectId, callback.href, raw.name, args]);
    const id = `sub_${createHash("sha256").update(canonicalKey).digest("hex").slice(0, 32)}`;
    if (!(await this.journal.removeSubscription(id)))
      throw new AdapterError("EVENT_SUBSCRIPTION_NOT_FOUND", "Webhook subscription was not found.");
    return {};
  }

  private occurrence(entry: AttentionEntry) {
    return {
      eventId: entry.event_id,
      name: eventName(entry.event_type),
      timestamp: entry.occurred_at,
      data: {
        event_id: entry.event_id,
        ...(entry.task_id ? { task_id: entry.task_id } : {}),
        session_id: entry.session_id,
        ...(entry.submitted_message_id ? { message_id: entry.submitted_message_id } : {}),
        source_revision: entry.source_revision,
        classification: entry.classification,
        prepared_summary: entry.prepared_summary,
        next_safe_step: entry.next_safe_step,
        lifecycle: entry.lifecycle,
        hierarchy_status: entry.hierarchy_status,
      },
      cursor: null,
    };
  }

  private headers(subscription: EventSubscription, eventId: string, timestamp: string, body: string): Record<string, string> {
    const values = [subscription.secret];
    if (subscription.previous_secret && subscription.previous_secret_expires_at &&
      Date.parse(subscription.previous_secret_expires_at) > Date.now()) values.push(subscription.previous_secret);
    return this.signHeaders(values, eventId, timestamp, body, subscription.id);
  }

  private signHeaders(secret: string | string[], eventId: string, timestamp: string, body: string, subscriptionId: string): Record<string, string> {
    const signatures = (Array.isArray(secret) ? secret : [secret]).map((key) => `v1,${signWebhook(key, eventId, timestamp, body)}`);
    return {
      "content-type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": signatures.join(" "),
      "X-MCP-Subscription-Id": subscriptionId,
    };
  }

  private async recordRetry(entry: AttentionEntry, subscription: EventSubscription, status?: number): Promise<void> {
    const attempt = (entry.deliveries[subscription.id]?.attempts ?? 0) + 1;
    if (attempt >= MAX_ATTEMPTS) {
      await this.journal.recordDelivery(entry.event_id, subscription.id, { state: "failed", ...(status !== undefined ? { http_status: status } : {}) });
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** (attempt - 1));
    await this.journal.recordDelivery(entry.event_id, subscription.id, {
      state: "failed",
      ...(status !== undefined ? { http_status: status } : {}),
      retry_at: new Date(Date.now() + delay).toISOString(),
    });
  }
}

export function signWebhook(secret: string, eventId: string, timestamp: string, body: string): string {
  const key = validateSecret(secret);
  return createHmac("sha256", Buffer.from(key.slice("whsec_".length), "base64"))
    .update(`${eventId}.${timestamp}.${body}`, "utf8")
    .digest("base64");
}

export function validateCallbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidParams("Callback URL must be an absolute HTTPS URL."); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
    (url.port !== "" && url.port !== "443") || !hostname || url.href.length > 2048 ||
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || hostname.endsWith(".lan"))
    throw invalidParams("Callback URL must use HTTPS on the default port without credentials or a fragment.");
  if (isIP(url.hostname) && !isPublicAddress(url.hostname)) throw invalidParams("Callback URL resolves to a non-public address.");
  return url;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets as [number, number, number, number];
    const blocked = a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a === 255;
    return !blocked;
  }
  if (version !== 6 || address.startsWith("::ffff:")) return false;
  const normalized = address.toLowerCase();
  const groups = normalized.split(":");
  const first = Number.parseInt(groups[0] || "0", 16);
  const second = Number.parseInt(groups[1] || "0", 16);
  return (first & 0xe000) === 0x2000 &&
    !(first === 0x2001 && second <= 0x01ff) &&
    !normalized.startsWith("2001:db8:") && !normalized.startsWith("2002:") &&
    !normalized.startsWith("3fff:");
}

function validateSubscribe(raw: unknown): SubscribeParams {
  if (!isRecord(raw) || typeof raw.name !== "string" || !EVENT_NAMES.includes(raw.name as typeof EVENT_NAMES[number]) ||
    !isRecord(raw.delivery) || raw.delivery.mode !== "webhook" || typeof raw.delivery.url !== "string" ||
    typeof raw.delivery.secret !== "string" ||
    (raw.ttlMs !== undefined && raw.ttlMs !== null && (!Number.isSafeInteger(raw.ttlMs) || (raw.ttlMs as number) < 1)))
    throw invalidParams("Invalid webhook subscribe request.");
  return raw as unknown as SubscribeParams;
}

function canonicalArguments(value: unknown): EventSubscription["arguments"] {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => !["task_id", "session_id"].includes(key)) ||
    (value.task_id !== undefined && (typeof value.task_id !== "string" || !/^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.task_id))) ||
    (value.session_id !== undefined && (typeof value.session_id !== "string" || !/^[^\s\x00-\x1f\x7f]{1,256}$/u.test(value.session_id)))
  ) throw invalidParams("Only an exact task_id or session_id event filter is supported.");
  return {
    ...(typeof value.task_id === "string" ? { task_id: value.task_id } : {}),
    ...(typeof value.session_id === "string" ? { session_id: value.session_id } : {}),
  };
}

function validateSecret(value: string | undefined): string {
  if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(value))
    throw invalidParams("Webhook secret must use the Standard Webhooks whsec_ format.");
  const encoded = value.slice(6);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, ""))
    throw invalidParams("Webhook secret must encode 24 to 64 random bytes.");
  return value;
}

function constantTimeChallenge(body: string, expected: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || typeof value.challenge !== "string") return false;
    const actual = Buffer.from(value.challenge);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  } catch { return false; }
}

function invalidParams(message: string): AdapterError {
  return new AdapterError("INVALID_ARGUMENT", message);
}

function eventName(type: AttentionEntry["event_type"]): string {
  switch (type) {
    case "message.completed": return "worker.completed";
    case "message.failed": return "worker.failed";
    case "message.aborted": return "worker.aborted";
    default: return "worker.input_required";
  }
}

export const secureWebhookRequest: WebhookRequest = async (url, body, headers) => {
  const addresses = await boundedLookup(url.hostname);
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address)))
    throw invalidParams("Callback hostname must resolve only to public IP addresses.");
  const selected = addresses[0]!;
  const options: RequestOptions = {
    protocol: "https:",
    hostname: url.hostname,
    port: 443,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers: { ...headers, host: url.host, "content-length": Buffer.byteLength(body, "utf8") },
    servername: isIP(url.hostname) ? undefined : url.hostname,
    agent: false,
    timeout: 5000,
    lookup: (_hostname, lookupOptions, callback) => {
      if (typeof lookupOptions === "object" && lookupOptions.all) {
        callback(null, [{ address: selected.address, family: selected.family }]);
      } else callback(null, selected.address, selected.family);
    },
  };
  return new Promise((resolve, reject) => {
    const request = httpsRequest(options, (response) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.resume();
        reject(new Error("Webhook redirects are not followed."));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) request.destroy(new Error("Webhook response exceeded its limit."));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(new Error("Webhook callback timed out.")));
    request.on("error", reject);
    request.end(body);
  });
};

function boundedLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Webhook DNS lookup timed out.")), 5000);
    timer.unref();
    void lookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => { clearTimeout(timer); resolve(addresses); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
