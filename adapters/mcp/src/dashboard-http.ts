import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import type { DashboardCollector } from "./dashboard.js";

export type DashboardConfig = {
  projectHash: string; generation: string; listenPort: number;
  authEnabled: boolean; auth: { username: string; password: string } | null;
  cert: string; key: string; assets: string;
  navigation?: { web_port: number; board_port: number; opencode_version: string };
};
// The LAN is an explicitly trusted operator surface reached through the host
// forward; the guest listener itself stays loopback-bound. Accept any
// private-network Host so LAN browsers reach the dashboard exactly like the
// local browser, while public or foreign Host values stay rejected.
function privateHostName(value: string): boolean {
  if (value === "localhost") return true;
  const version = isIP(value);
  if (version === 4) {
    const [a = -1, b = -1] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    const v = value.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  return false;
}
export function dashboardHandler(config: DashboardConfig, collector: DashboardCollector) {
  const auth = config.authEnabled && config.auth ? `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString("base64")}` : null;
  if (config.authEnabled && (!config.auth?.username || !config.auth.password)) throw new Error("Dashboard authentication unavailable");
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(data);
    };
    try {
      const hostHeader = request.headers.host ?? "";
      const colon = hostHeader.lastIndexOf(":");
      const hostName = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : colon > 0 ? hostHeader.slice(0, colon) : "";
      if (colon <= 0 || hostHeader.slice(colon + 1) !== String(config.listenPort) || !privateHostName(hostName)) return send(403, { error: "HOST_REJECTED" });
      if (request.headers.origin && request.headers.origin !== `https://${request.headers.host}`) return send(403, { error: "ORIGIN_REJECTED" });
      if (auth) {
        const given = Buffer.from(request.headers.authorization ?? "");
        const want = Buffer.from(auth);
        if (given.length !== want.length || !timingSafeEqual(given, want)) {
          response.setHeader("www-authenticate", 'Basic realm="opencode-vm dashboard"');
          return send(401, { error: "AUTH_REQUIRED" });
        }
      }
      if (request.method !== "GET") return send(405, { error: "READ_ONLY" });
      if ((request.url?.length ?? 0) > 1024 || request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) > 0) return send(400, { error: "INVALID_REQUEST" });
      const url = new URL(request.url ?? "/", "https://localhost");
      if (url.pathname === "/healthz" && !url.search) {
        const snapshot = collector.snapshot(true);
        const ready = snapshot.generation === config.generation && snapshot.sources.sessions?.state === "fresh" && snapshot.sources.discovery?.state === "fresh";
        return send(ready ? 200 : 503, { schema: 1, status: ready ? "ok" : "not_ready", service: "repo-dashboard", readOnly: true,
          projectHash: config.projectHash, generation: config.generation, authEnabled: config.authEnabled });
      }
      if (url.pathname === "/api/v1/status") {
        if ([...url.searchParams.keys()].some(k => k !== "view") || url.searchParams.getAll("view").length > 1 ||
          (url.searchParams.has("view") && !["detail", "summary"].includes(url.searchParams.get("view")!))) return send(400, { error: "INVALID_VIEW" });
        const snapshot = collector.snapshot(url.searchParams.get("view") === "summary");
        if (!snapshot.sources.sessions?.last_success_at) return send(503, { error: "STATUS_UNAVAILABLE" });
        const text = JSON.stringify({ ...snapshot, navigation: config.navigation ?? null });
        if (Buffer.byteLength(text) > 512 * 1024) return send(503, { error: "READ_BUDGET_EXCEEDED" });
        return send(200, text);
      }
      const asset = new Map([["/", ["index.html", "text/html; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript"]], ["/styles.css", ["styles.css", "text/css"]]]).get(url.pathname);
      if (!asset || url.search) return send(404, { error: "NOT_FOUND" });
      const bytes = await readFile(`${config.assets}/${asset[0]}`);
      if (bytes.length > 256 * 1024) throw new Error("Asset budget");
      send(200, bytes, asset[1]);
    } catch { send(503, { error: "DASHBOARD_UNAVAILABLE" }); }
  };
}
export async function dashboardServer(config: DashboardConfig, collector: DashboardCollector) {
  const server = createServer({ cert: await readFile(config.cert), key: await readFile(config.key), handshakeTimeout: 3000 }, dashboardHandler(config, collector));
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 32;
  return server;
}
