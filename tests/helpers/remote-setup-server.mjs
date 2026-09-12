import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { pathToFileURL } from "node:url";

const [certFile, keyFile, stateFile, wsModule] = process.argv.slice(2);
if (!certFile || !keyFile || !stateFile || !wsModule) process.exit(2);
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-keyout", keyFile, "-out", certFile, "-subj", "/CN=localhost",
  "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
], { stdio: "ignore" });
const { WebSocketServer } = await import(pathToFileURL(wsModule));
const expected = `Basic ${Buffer.from("opencode:remote-password-42").toString("base64")}`;
const server = https.createServer(
  { cert: readFileSync(certFile), key: readFileSync(keyFile) },
  (request, response) => {
    if (request.url !== "/openlive/info") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="opencode-vm"' }).end();
      return;
    }
    const body = JSON.stringify({
      schema: 1,
      protocol: "ocvm-openlive.v1",
      scriptVersion: "0.5.46",
      adapterVersion: "0.1.5",
      projectId: "setup-project-id",
      displayName: "Setup Remote",
      ready: true,
      busy: false,
      maxJpegFrameBytes: 5 * 1024 * 1024,
      acpPath: "/openlive/acp",
    });
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  },
);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (
    request.url !== "/openlive/acp" ||
    request.headers.authorization !== expected ||
    request.headers["x-ocvm-openlive-project"] !== "setup-project-id"
  ) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "ready",
    protocol: "ocvm-openlive.v1",
    projectId: "setup-project-id",
    generation: "setup",
    cwd: "/remote/setup/project",
    busy: false,
  }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const fingerprint = new X509Certificate(readFileSync(certFile)).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  writeFileSync(stateFile, `${address.port}\n${fingerprint}\n`);
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
