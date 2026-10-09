import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { SessionGateway } from "./opencode.js";
import { createMcpServer, dispatchMcp2Method } from "./tools.js";
import { lastToolRoundtrips, traceRejection } from "./diagnostics.js";
import type { CorrelationBase, RejectionPhase } from "./diagnostics.js";
import { ADAPTER_VERSION, MCP_TRANSPORT, isRecord } from "./types.js";
import type { RuntimeDescriptor } from "./types.js";

export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;

class BodyTooLargeError extends Error {}
class MalformedBodyError extends Error {}

export class McpHttpServer {
  private readonly server: Server;
  private readonly activeMcpServers = new Set<McpServer>();
  private activeRequests = 0;
  private actualPort: number | undefined;
  private closing = false;

  constructor(
    private readonly runtime: RuntimeDescriptor,
    private readonly token: string,
    private readonly gateway: SessionGateway,
    private readonly maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
  }

  async start(): Promise<number> {
    if (this.actualPort !== undefined) return this.actualPort;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.runtime.listenPort, this.runtime.listenHost);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("The MCP listener did not publish a TCP address.");
    }
    this.actualPort = address.port;
    return address.port;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const closing = [...this.activeMcpServers].map((server) =>
      server.close().catch(() => undefined),
    );
    await Promise.all(closing);
    this.activeMcpServers.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.server.closeAllConnections();
      }, 2_000);
      timer.unref();
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      this.server.closeIdleConnections();
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.closing) {
      writeJson(response, 503, { error: "Service unavailable." });
      return;
    }
    if (this.activeRequests >= this.maxConcurrentRequests) {
      response.setHeader("retry-after", "1");
      writeJson(response, 503, { error: "Too many concurrent requests." });
      return;
    }
    this.activeRequests += 1;
    const correlationBase: CorrelationBase = {
      request: randomUUID(),
      time: new Date().toISOString(),
      generation: this.runtime.generation,
      adapterVersion: ADAPTER_VERSION,
    };
    try {
      if (!this.validHost(request)) {
        this.rejectWith(response, correlationBase, 403, { error: "Invalid Host header." }, "header", "invalid_host");
        return;
      }
      const location = requestLocation(request);
      const pathname = location.pathname;
      if (
        location.search !== "" ||
        (pathname !== "/mcp" && pathname !== "/healthz")
      ) {
        this.rejectWith(response, correlationBase, 404, { error: "Not found." }, "method", "not_found");
        return;
      }
      if (!this.validOrigin(request)) {
        this.rejectWith(response, correlationBase, 403, { error: "Invalid Origin header." }, "header", "invalid_origin");
        return;
      }
      if (!this.validToken(request)) {
        response.setHeader("www-authenticate", 'Token realm="opencode-vm-mcp"');
        this.rejectWith(response, correlationBase, 401, { error: "Authentication required." }, "auth", "authentication_required");
        return;
      }

      if (pathname === "/healthz") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          this.rejectWith(response, correlationBase, 405, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
          }, "method", "method_not_allowed");
          return;
        }
        const roundtrips = lastToolRoundtrips();
        const backend = this.gateway.backendConnectivity
          ? await this.gateway.backendConnectivity()
          : "unverified";
        writeJson(response, 200, {
          healthy: true,
          schema: 1,
          project: {
            id: this.runtime.projectHash,
            name: this.runtime.projectName,
          },
          generation: this.runtime.generation,
          adapterVersion: ADAPTER_VERSION,
          transport: MCP_TRANSPORT,
          preferredProtocolVersion: LATEST_PROTOCOL_VERSION,
          granularity: {
            configuration: "validated",
            process: "up",
            listener: "bound",
            backend_connectivity: backend,
            events_channel: this.runtime.activityJournalEnabled === false ? "disabled" : this.gateway.handleMcpEventMethod ? "enabled" : "disabled",
            activity_journal: this.gateway.activityJournalStatus?.() ?? {
              enabled: this.runtime.activityJournalEnabled !== false,
              state: this.runtime.activityJournalEnabled === false ? "disabled" : "unavailable",
            },
            last_tool_success: roundtrips.last_success,
            last_tool_error: roundtrips.last_error,
          },
        });
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        this.rejectWith(response, correlationBase, 405, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }, "method", "method_not_allowed");
        return;
      }
      const contentType = request.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        contentType.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
      ) {
        this.rejectWith(response, correlationBase, 415, {
          error: "Content-Type must be application/json.",
        }, "transport", "invalid_content_type");
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          this.rejectWith(response, correlationBase, 413, { error: "Request body is too large." }, "transport", "body_too_large");
        } else {
          this.rejectWith(response, correlationBase, 400, { error: "Malformed JSON request." }, "transport", "malformed_json");
        }
        return;
      }
      const requestProtocol = request.headers["mcp-protocol-version"];
      if (typeof requestProtocol === "string" && requestProtocol !== "2026-07-28" &&
        !SUPPORTED_PROTOCOL_VERSIONS.includes(requestProtocol)) {
        this.rejectWith(response, correlationBase, 400, { jsonrpc: "2.0", id: isRecord(body) ? body.id ?? null : null,
          error: { code: -32022, message: "Unsupported protocol version.", data: { requested: requestProtocol, supported: [...SUPPORTED_PROTOCOL_VERSIONS, "2026-07-28"] } } },
          "protocol", "unsupported_protocol_version");
        return;
      }
      if (requestProtocol === "2026-07-28" &&
        isRecord(body) && typeof body.method === "string" && !validModernRequestHeaders(request, body)) {
        this.rejectWith(response, correlationBase, 400, { jsonrpc: "2.0", id: body.id ?? null,
          error: { code: -32020, message: "Header mismatch: standard MCP request headers must match the request metadata." } },
          "header", "header_mismatch");
        return;
      }

      // A reflected, arbitrarily large JSON-RPC ID would defeat bounded read
      // responses even if their content is empty. Reject without reflecting it.
      if (
        isRecord(body) &&
        body.id !== undefined &&
        Buffer.byteLength(JSON.stringify(body.id)) > 1024
      ) {
        this.rejectWith(response, correlationBase, 400, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Request ID exceeds 1024 serialized bytes.",
          },
        }, "protocol", "request_id_too_large");
        return;
      }
      if (pathname === "/mcp" && isRecord(body) && typeof body.method === "string" &&
        (body.method === "server/discover" || body.method.startsWith("events/"))) {
        await this.handleEventRequest(request, response, body, correlationBase);
        return;
      }
      if (pathname === "/mcp" && request.headers["mcp-protocol-version"] === "2026-07-28" &&
        isRecord(body) && typeof body.method === "string") {
        const modernParams = isRecord(body.params) ? body.params
          : body.method === "resources/list" ? {} : undefined;
        if (["tools/list", "tools/call", "resources/list", "resources/read"].includes(body.method) && modernParams)
          await this.handleModernToolRequest(response, { ...body, params: modernParams });
        else
          writeJson(response, 404, { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not found." } });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      });
       const mcp = createMcpServer(this.gateway, this.runtime);
      this.activeMcpServers.add(mcp);
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch {
        if (!response.headersSent) {
          writeJson(response, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error." },
            id: null,
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      } finally {
        this.activeMcpServers.delete(mcp);
        await mcp.close().catch(() => undefined);
      }
    } catch {
      if (!response.headersSent)
        this.rejectWith(response, correlationBase, 400, { error: "Invalid request." }, "transport", "invalid_request");
      else if (!response.writableEnded) response.end();
    } finally {
      this.activeRequests -= 1;
    }
  }

  /**
   * Pre-dispatch rejection with a bounded redacted correlation set (STARTREST
   * P3): phase, time, request/generation/adapter identifiers and a safe reason
   * token — never headers, bodies, URLs, or tokens. The correlation is an
   * additive field; existing error codes/messages stay byte-compatible.
   */
  private rejectWith(
    response: ServerResponse,
    base: CorrelationBase,
    status: number,
    payload: Record<string, unknown>,
    phase: RejectionPhase,
    reason: string,
  ): void {
    const error = isRecord(payload.error) ? payload.error : undefined;
    const code =
      error && (typeof error.code === "number" || typeof error.code === "string")
        ? String(error.code)
        : String(status);
    const correlation = { ...base, phase, code, reason };
    traceRejection(correlation);
    if (error) error.data = { ...(isRecord(error.data) ? error.data : {}), correlation };
    else payload.correlation = correlation;
    writeJson(response, status, payload);
  }

  private async handleEventRequest(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
    base: CorrelationBase,
  ): Promise<void> {
    const method = body.method as string;
    const id = body.id;
    if (id === undefined || id === null || (typeof id !== "string" && typeof id !== "number") ||
      (typeof id === "number" && !Number.isFinite(id)) || body.jsonrpc !== "2.0" ||
      (body.params !== undefined && !isRecord(body.params))) {
      this.rejectWith(response, base, 200, { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } }, "protocol", "invalid_jsonrpc");
      return;
    }
    const methodHeader = request.headers["mcp-method"];
    const protocolHeader = request.headers["mcp-protocol-version"];
    const metadata = isRecord(body.params) && isRecord(body.params._meta) ? body.params._meta : undefined;
    const bodyVersion = metadata?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof methodHeader !== "string" || methodHeader !== method ||
      typeof protocolHeader !== "string" || bodyVersion !== protocolHeader) {
      this.rejectWith(response, base, 400, { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch: Mcp-Method and MCP-Protocol-Version must match the request metadata." } }, "header", "header_mismatch");
      return;
    }
    if (protocolHeader !== "2026-07-28") {
      this.rejectWith(response, base, 400, { jsonrpc: "2.0", id, error: {
        code: -32022,
        message: "Unsupported protocol version.",
        data: { requested: protocolHeader, supported: ["2026-07-28"] },
      } }, "protocol", "unsupported_protocol_version");
      return;
    }
    if (method === "server/discover") {
      writeJson(response, 200, { jsonrpc: "2.0", id, result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, resources: {}, ...(this.runtime.activityJournalEnabled === false ? {} : { events: {} }) },
      } });
      return;
    }
    if (this.runtime.activityJournalEnabled === false) {
      if (method === "events/list") {
        writeJson(response, 200, { jsonrpc: "2.0", id, result: { events: [] } });
      } else {
        writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32014,
          message: "Activity journal is disabled for this session.", data: { code: "ACTIVITY_DISABLED" } } });
      }
      return;
    }
    if (!this.gateway.handleMcpEventMethod) {
      this.rejectWith(response, base, 200, { jsonrpc: "2.0", id, error: { code: -32014, message: "MCP Events are unavailable." } }, "method", "events_unavailable");
      return;
    }
    try {
      const result = await this.gateway.handleMcpEventMethod(method, body.params ?? {});
      writeJson(response, 200, { jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const code = String((error as { code: unknown }).code);
        if (code === "ACTIVITY_DISABLED" || code === "ACTIVITY_UNAVAILABLE") {
          writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32014,
            message: code === "ACTIVITY_DISABLED" ? "Activity journal is disabled." : "Activity journal is unavailable.", data: { code } } });
          return;
        }
        if (code === "INVALID_ARGUMENT") {
          writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: error.message } });
          return;
        }
        if (code === "EVENT_CALLBACK_ERROR") {
          const reason = "callbackReason" in error && typeof (error as { callbackReason?: unknown }).callbackReason === "string"
            ? (error as { callbackReason: string }).callbackReason : "challenge_failed";
          writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32015, message: "CallbackEndpointError", data: { reason } } });
          return;
        }
        if (code === "EVENT_SUBSCRIPTION_NOT_FOUND") {
          writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32011, message: "NotFound", data: { kind: "subscription" } } });
          return;
        }
        if (code === "EVENT_SUBSCRIPTION_LIMIT") {
          writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32013, message: "ResourceExhausted", data: { limit: "subscriptions", max: 32 } } });
          return;
        }
        if (code === "UNSUPPORTED_CONFIGURATION") {
          writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32014, message: "Unsupported", data: { feature: "event_method", method } } });
          return;
        }
      }
      writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal server error." } });
    }
  }

  private async handleModernToolRequest(response: ServerResponse, body: Record<string, unknown>): Promise<void> {
    const id = body.id as string | number;
    const method = body.method as "tools/list" | "tools/call" | "resources/list" | "resources/read";
    try {
      const result = await dispatchMcp2Method(this.gateway, this.runtime, method, id, body.params as Record<string, unknown>);
      if (!isRecord(result)) throw new Error("MCP tool handler returned an invalid result.");
      writeJson(response, 200, { jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
    } catch (error) {
      // Map rejection codes without exposing internal or foreign error texts.
      const code = isRecord(error) && typeof error.code === "number" ? error.code : -32603;
      const message = code === -32602 ? "Invalid params." : code === -32601 ? "Method not found." : "Internal server error.";
      writeJson(response, 200, { jsonrpc: "2.0", id, error: { code, message } });
    }
  }

  private validToken(request: IncomingMessage): boolean {
    const supplied = request.headers["x-ocvm-mcp-token"];
    if (typeof supplied !== "string") return false;
    const expectedDigest = createHash("sha256").update(this.token).digest();
    const suppliedDigest = createHash("sha256").update(supplied).digest();
    return timingSafeEqual(expectedDigest, suppliedDigest);
  }

  private validHost(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (typeof host !== "string") return false;
    const port = this.actualPort ?? this.runtime.listenPort;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  private validOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (typeof origin !== "string") return false;
    const port = this.actualPort ?? this.runtime.listenPort;
    return (
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://localhost:${port}`
    );
  }
}

function requestLocation(request: IncomingMessage): URL {
  const host =
    typeof request.headers.host === "string" ? request.headers.host : "invalid";
  return new URL(request.url ?? "", `http://${host}`);
}

function validModernRequestHeaders(request: IncomingMessage, body: Record<string, unknown>): boolean {
  const method = request.headers["mcp-method"];
  const version = request.headers["mcp-protocol-version"];
  const params = isRecord(body.params) ? body.params : undefined;
  const metadata = params && isRecord(params._meta) ? params._meta : undefined;
  if (method !== body.method || version !== metadata?.["io.modelcontextprotocol/protocolVersion"]) return false;
  if (["tools/call", "resources/read", "prompts/get"].includes(String(body.method))) {
    const nameHeader = request.headers["mcp-name"];
    const name = body.method === "resources/read" ? params?.uri : params?.name;
    if (typeof nameHeader !== "string" || nameHeader !== name) return false;
  }
  return true;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (Array.isArray(declared) || (declared && !/^\d+$/u.test(declared))) {
    return Promise.reject(new MalformedBodyError());
  }
  if (declared && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    request.resume();
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    request.on("data", (part: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        fail(new BodyTooLargeError());
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      if (total === 0) {
        fail(new MalformedBodyError());
        return;
      }
      try {
        const parsed = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as unknown;
        settled = true;
        resolve(parsed);
      } catch {
        fail(new MalformedBodyError());
      }
    });
    request.on("aborted", () => fail(new MalformedBodyError()));
    request.on("error", () => fail(new MalformedBodyError()));
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function supportedProtocolVersions(): string[] {
  return [...SUPPORTED_PROTOCOL_VERSIONS];
}
