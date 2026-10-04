import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { SessionGateway } from "./opencode.js";
import { createMcpServer, dispatchMcp2ToolMethod } from "./tools.js";
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
    try {
      if (!this.validHost(request)) {
        writeJson(response, 403, { error: "Invalid Host header." });
        return;
      }
      const location = requestLocation(request);
      const pathname = location.pathname;
      if (
        location.search !== "" ||
        (pathname !== "/mcp" && pathname !== "/healthz")
      ) {
        writeJson(response, 404, { error: "Not found." });
        return;
      }
      if (!this.validOrigin(request)) {
        writeJson(response, 403, { error: "Invalid Origin header." });
        return;
      }
      if (!this.validToken(request)) {
        response.setHeader("www-authenticate", 'Token realm="opencode-vm-mcp"');
        writeJson(response, 401, { error: "Authentication required." });
        return;
      }

      if (pathname === "/healthz") {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return;
        }
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
        });
        return;
      }

      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }
      const contentType = request.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        contentType.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/json"
      ) {
        writeJson(response, 415, {
          error: "Content-Type must be application/json.",
        });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          writeJson(response, 413, { error: "Request body is too large." });
        } else {
          writeJson(response, 400, { error: "Malformed JSON request." });
        }
        return;
      }
      const requestProtocol = request.headers["mcp-protocol-version"];
      if (typeof requestProtocol === "string" && requestProtocol !== "2026-07-28" &&
        !SUPPORTED_PROTOCOL_VERSIONS.includes(requestProtocol)) {
        writeJson(response, 400, { jsonrpc: "2.0", id: isRecord(body) ? body.id ?? null : null,
          error: { code: -32022, message: "Unsupported protocol version.", data: { requested: requestProtocol, supported: [...SUPPORTED_PROTOCOL_VERSIONS, "2026-07-28"] } } });
        return;
      }
      if (requestProtocol === "2026-07-28" &&
        isRecord(body) && typeof body.method === "string" && !validModernRequestHeaders(request, body)) {
        writeJson(response, 400, { jsonrpc: "2.0", id: body.id ?? null,
          error: { code: -32020, message: "Header mismatch: standard MCP request headers must match the request metadata." } });
        return;
      }

      // A reflected, arbitrarily large JSON-RPC ID would defeat bounded read
      // responses even if their content is empty. Reject without reflecting it.
      if (
        isRecord(body) &&
        body.id !== undefined &&
        Buffer.byteLength(JSON.stringify(body.id)) > 1024
      ) {
        writeJson(response, 400, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Request ID exceeds 1024 serialized bytes.",
          },
        });
        return;
      }
      if (pathname === "/mcp" && isRecord(body) && typeof body.method === "string" &&
        (body.method === "server/discover" || body.method.startsWith("events/"))) {
        await this.handleEventRequest(request, response, body);
        return;
      }
      if (pathname === "/mcp" && request.headers["mcp-protocol-version"] === "2026-07-28" &&
        isRecord(body) && typeof body.method === "string") {
        if ((body.method === "tools/list" || body.method === "tools/call") && isRecord(body.params))
          await this.handleModernToolRequest(response, body);
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
        writeJson(response, 400, { error: "Invalid request." });
      else if (!response.writableEnded) response.end();
    } finally {
      this.activeRequests -= 1;
    }
  }

  private async handleEventRequest(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ): Promise<void> {
    const method = body.method as string;
    const id = body.id;
    if (id === undefined || id === null || (typeof id !== "string" && typeof id !== "number") ||
      (typeof id === "number" && !Number.isFinite(id)) || body.jsonrpc !== "2.0" ||
      (body.params !== undefined && !isRecord(body.params))) {
      writeJson(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request." } });
      return;
    }
    const methodHeader = request.headers["mcp-method"];
    const protocolHeader = request.headers["mcp-protocol-version"];
    const metadata = isRecord(body.params) && isRecord(body.params._meta) ? body.params._meta : undefined;
    const bodyVersion = metadata?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof methodHeader !== "string" || methodHeader !== method ||
      typeof protocolHeader !== "string" || bodyVersion !== protocolHeader) {
      writeJson(response, 400, { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch: Mcp-Method and MCP-Protocol-Version must match the request metadata." } });
      return;
    }
    if (protocolHeader !== "2026-07-28") {
      writeJson(response, 400, { jsonrpc: "2.0", id, error: {
        code: -32022,
        message: "Unsupported protocol version.",
        data: { requested: protocolHeader, supported: ["2026-07-28"] },
      } });
      return;
    }
    if (method === "server/discover") {
      writeJson(response, 200, { jsonrpc: "2.0", id, result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, events: {} },
      } });
      return;
    }
    if (!this.gateway.handleMcpEventMethod) {
      writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32014, message: "MCP Events are unavailable." } });
      return;
    }
    try {
      const result = await this.gateway.handleMcpEventMethod(method, body.params ?? {});
      writeJson(response, 200, { jsonrpc: "2.0", id, result });
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const code = String((error as { code: unknown }).code);
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
    const method = body.method as "tools/list" | "tools/call";
    try {
      const result = await dispatchMcp2ToolMethod(this.gateway, this.runtime, method, id, body.params as Record<string, unknown>);
      if (!isRecord(result)) throw new Error("MCP tool handler returned an invalid result.");
      writeJson(response, 200, { jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
    } catch {
      writeJson(response, 200, { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal server error." } });
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

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  writeJson(response, 405, {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
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
