import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import https, { type RequestOptions } from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import {
  MAX_ACP_MESSAGE_BYTES,
  MAX_QUEUE_BYTES,
  REMOTE_PROTOCOL,
  type RemoteError,
  type RemoteReady,
} from "./protocol.js";

export type RemoteMapping = {
  schema: 1;
  protocol: typeof REMOTE_PROTOCOL;
  localProject: string;
  origin: string;
  projectId: string;
  displayName: string;
  username: string;
  password: string;
  adapterVersion: string;
  adapterSha256: string;
  nodePath: string;
  clientPath: string;
  tlsFingerprint?: string;
};

export async function runRemoteClient(
  mappingFile: string,
  localProject: string,
  probe = false,
): Promise<void> {
  const mapping = await loadMapping(mappingFile);
  if (mapping.localProject !== localProject) {
    throw new Error(
      "Remote OpenLive mapping does not belong to this stub folder.",
    );
  }
  const endpoint = new URL("/openlive/acp", mapping.origin);
  if (endpoint.protocol !== "https:") {
    throw new Error("Remote OpenLive requires an HTTPS/WSS endpoint.");
  }
  endpoint.protocol = "wss:";
  const authorization = `Basic ${Buffer.from(`${mapping.username}:${mapping.password}`).toString("base64")}`;
  const options: ClientOptions = {
    headers: {
      Authorization: authorization,
      "X-OCVM-OpenLive-Project": mapping.projectId,
    },
    followRedirects: false,
    handshakeTimeout: 12_000,
    maxPayload: MAX_ACP_MESSAGE_BYTES,
    perMessageDeflate: false,
  };
  if (mapping.tlsFingerprint) {
    options.ca = await pinnedCertificate(endpoint, mapping.tlsFingerprint);
  }

  const ws = new WebSocket(endpoint, REMOTE_PROTOCOL, options);
  const ready = await waitForReady(ws, mapping);
  if (probe) {
    ws.close(1000, "Setup probe complete");
    await waitForClose(ws);
    return;
  }

  let inputEnded = false;
  let pending = Buffer.alloc(0);
  let queuedBytes = 0;
  const failInput = (error: unknown) => {
    process.stderr.write(`[openlive-remote] ${errorMessage(error)}\n`);
    ws.close(1009, "ACP input rejected");
  };
  const sendLine = (line: Buffer) => {
    try {
      if (line.length > MAX_ACP_MESSAGE_BYTES) {
        throw new Error("ACP message exceeds the 12 MiB limit.");
      }
      const rewritten = rewriteAcpCwd(
        line.toString("utf8"),
        mapping.localProject,
        ready.cwd,
      );
      const bytes = Buffer.byteLength(rewritten);
      queuedBytes += bytes;
      if (queuedBytes > MAX_QUEUE_BYTES) {
        throw new Error("Remote OpenLive output queue exceeded its limit.");
      }
      if (queuedBytes > MAX_ACP_MESSAGE_BYTES) process.stdin.pause();
      ws.send(rewritten, (error) => {
        queuedBytes -= bytes;
        if (queuedBytes <= MAX_ACP_MESSAGE_BYTES && !inputEnded)
          process.stdin.resume();
        if (error) failInput(error);
      });
    } catch (error) {
      failInput(error);
    }
  };
  process.stdin.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_ACP_MESSAGE_BYTES && !pending.includes(0x0a)) {
      failInput(new Error("ACP message exceeds the 12 MiB limit."));
      process.stdin.pause();
      return;
    }
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length) sendLine(line);
    }
  });
  process.stdin.once("end", () => {
    inputEnded = true;
    if (pending.length) sendLine(pending);
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "eof" }));
  });
  process.stdin.once("error", failInput);

  let remoteError: string | undefined;
  ws.on("message", (data, isBinary) => {
    try {
      if (isBinary) throw new Error("Remote gateway sent a binary message.");
      const line = rawText(data);
      if (Buffer.byteLength(line) > MAX_ACP_MESSAGE_BYTES) {
        throw new Error("Remote ACP message exceeds the 12 MiB limit.");
      }
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "error") {
        remoteError = String((value as RemoteError).message);
        process.stderr.write(`[openlive-remote] ${remoteError}\n`);
        return;
      }
      if (!process.stdout.write(`${line}\n`)) {
        ws.pause();
        process.stdout.once("drain", () => ws.resume());
      }
    } catch (error) {
      remoteError = errorMessage(error);
      process.stderr.write(`[openlive-remote] ${remoteError}\n`);
      ws.close(1002, "Invalid remote ACP message");
    }
  });
  await waitForClose(ws);
  process.stdin.pause();
  if (remoteError) throw new Error(remoteError);
  if (!inputEnded) {
    throw new Error(
      "The remote OpenLive connection ended; check the Web UI before retrying uncertain work.",
    );
  }
}

export async function runRemoteInfo(mappingFile: string): Promise<void> {
  const mapping = await loadMapping(mappingFile);
  const endpoint = new URL("/openlive/info", mapping.origin);
  if (endpoint.protocol !== "https:") {
    throw new Error("Remote OpenLive requires an HTTPS endpoint.");
  }
  const options: RequestOptions = {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${mapping.username}:${mapping.password}`).toString("base64")}`,
      Accept: "application/json",
    },
    timeout: 12_000,
  };
  if (mapping.tlsFingerprint) {
    options.ca = await pinnedCertificate(endpoint, mapping.tlsFingerprint);
  }
  const body = await new Promise<string>((resolve, reject) => {
    const request = https.request(endpoint, options, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          request.destroy(
            new Error("Remote OpenLive discovery response is too large."),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(
            new Error(
              `Remote OpenLive discovery failed (HTTP ${response.statusCode ?? "unknown"}).`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.once("timeout", () =>
      request.destroy(new Error("Remote OpenLive discovery timed out.")),
    );
    request.once("error", reject);
    request.end();
  });
  JSON.parse(body);
  process.stdout.write(`${body}\n`);
}

export function rewriteAcpCwd(
  line: string,
  localProject: string,
  remoteProject: string,
): string {
  const message = JSON.parse(line) as {
    method?: unknown;
    params?: { cwd?: unknown };
  };
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("ACP message must be a JSON object.");
  }
  if (message.method !== "session/new" && message.method !== "session/load") {
    return line;
  }
  if (!message.params || message.params.cwd !== localProject) {
    throw new Error(
      "OpenLive requested a cwd outside the configured stub folder.",
    );
  }
  message.params.cwd = remoteProject;
  return JSON.stringify(message);
}

async function waitForReady(
  ws: WebSocket,
  mapping: RemoteMapping,
): Promise<RemoteReady> {
  return new Promise<RemoteReady>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Remote OpenLive connection timed out."));
    }, 12_000);
    timer.unref();
    const fail = (error: unknown) => {
      clearTimeout(timer);
      reject(
        error instanceof Error
          ? error
          : new Error("Remote OpenLive connection failed."),
      );
    };
    ws.once("error", fail);
    ws.once("unexpected-response", (_request, response) => {
      fail(
        new Error(
          `Remote OpenLive endpoint rejected the connection (HTTP ${response.statusCode}).`,
        ),
      );
    });
    ws.once("message", (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary)
          throw new Error("Remote OpenLive ready frame is not text.");
        const value = JSON.parse(rawText(data)) as Partial<RemoteReady>;
        if (
          value.type !== "ready" ||
          value.protocol !== REMOTE_PROTOCOL ||
          value.projectId !== mapping.projectId ||
          typeof value.generation !== "string" ||
          typeof value.cwd !== "string" ||
          !value.cwd
        ) {
          throw new Error(
            "Remote OpenLive ready frame is invalid or belongs to another project.",
          );
        }
        clearTimeout(timer);
        ws.off("error", fail);
        resolve(value as RemoteReady);
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => ws.once("close", () => resolve()));
}

async function loadMapping(file: string): Promise<RemoteMapping> {
  const value = JSON.parse(
    await readFile(file, "utf8"),
  ) as Partial<RemoteMapping>;
  if (
    value.schema !== 1 ||
    value.protocol !== REMOTE_PROTOCOL ||
    typeof value.localProject !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.username !== "string" ||
    typeof value.password !== "string" ||
    typeof value.adapterVersion !== "string" ||
    typeof value.adapterSha256 !== "string" ||
    typeof value.nodePath !== "string" ||
    typeof value.clientPath !== "string" ||
    (value.tlsFingerprint !== undefined &&
      typeof value.tlsFingerprint !== "string")
  ) {
    throw new Error("Remote OpenLive mapping is invalid; run setup again.");
  }
  return value as RemoteMapping;
}

function fingerprint(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(":", "").toLowerCase();
}

async function pinnedCertificate(
  endpoint: URL,
  expectedFingerprint: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const host = endpoint.hostname.replace(/^\[|\]$/g, "");
    const socket = tls.connect({
      host,
      port: Number(endpoint.port || 443),
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy(
        new Error("Remote OpenLive TLS certificate probe timed out."),
      );
    }, 10_000);
    timer.unref();
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate(true);
      const actual = certificate.raw ? fingerprint(certificate.raw) : "";
      socket.end();
      if (
        !actual ||
        normalizeFingerprint(actual) !==
          normalizeFingerprint(expectedFingerprint)
      ) {
        reject(
          new Error("Remote OpenLive TLS certificate fingerprint changed."),
        );
        return;
      }
      resolve(new X509Certificate(certificate.raw).toString());
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function rawText(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data).toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unexpected remote OpenLive error";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mappingFile, localProject, mode] = process.argv.slice(2);
  if (!mappingFile || !localProject) {
    process.stderr.write(
      "Usage: client.js <mapping.json> <local-project> [--probe] | --info <mapping.json>\n",
    );
    process.exit(2);
  }
  const operation =
    mappingFile === "--info"
      ? runRemoteInfo(localProject)
      : runRemoteClient(mappingFile, localProject, mode === "--probe");
  operation.catch((error: unknown) => {
    process.stderr.write(`[openlive-remote] ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
