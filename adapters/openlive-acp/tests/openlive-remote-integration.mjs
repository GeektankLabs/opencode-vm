import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

const root = await mkdtemp(join(tmpdir(), "ocvm-openlive-remote-integration-"));
const packageRoot = process.env.OCVM_OPENLIVE_PACKAGE_ROOT || process.cwd();
const localProject = join(root, "local stub");
const remoteProject = join(root, "remote project");
await mkdir(localProject);
await mkdir(remoteProject);

let managerCreated = false;
const backendAuth = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
const backend = http.createServer(async (request, response) => {
  assert.equal(request.headers.authorization, backendAuth);
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let body;
  if (request.method === "GET" && url.pathname === "/global/health") {
    body = { healthy: true, version: "integration" };
  } else if (
    request.method === "GET" &&
    url.pathname === "/experimental/tool/ids"
  ) {
    body = ["voice_sessions"];
  } else if (request.method === "POST" && url.pathname === "/session") {
    managerCreated = true;
    body = session();
  } else if (request.method === "GET" && url.pathname === "/session") {
    body = [session()];
  } else if (request.method === "GET" && url.pathname === "/provider") {
    body = {
      all: [
        {
          id: "test",
          name: "Test",
          models: {
            model: {
              id: "model",
              name: "Model",
              capabilities: {
                toolcall: true,
                reasoning: false,
                attachment: true,
                input: {
                  text: true,
                  image: true,
                  audio: false,
                  video: false,
                  pdf: false,
                },
                output: {
                  text: true,
                  image: false,
                  audio: false,
                  video: false,
                  pdf: false,
                },
              },
            },
          },
        },
      ],
      connected: ["test"],
      default: { test: "model" },
    };
  } else if (
    request.method === "GET" &&
    url.pathname === "/session/manager/message"
  ) {
    body = [];
  } else if (
    request.method === "GET" &&
    url.pathname === "/experimental/tool"
  ) {
    body = [
      {
        id: "voice_sessions",
        description: "Manage sessions",
        parameters: { type: "object", properties: {} },
      },
    ];
  } else if (request.method === "GET" && url.pathname === "/agent") {
    body = [
      {
        name: "openlive-manager",
        mode: "primary",
        hidden: false,
        permission: [
          { permission: "*", action: "deny" },
          { permission: "voice_sessions", action: "allow" },
        ],
      },
    ];
  } else if (request.method === "GET" && url.pathname === "/session/manager") {
    body = session();
  } else {
    response.writeHead(404);
    response.end(
      JSON.stringify({ error: `${request.method} ${url.pathname}` }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
});

const readyFile = join(root, "gateway-ready.json");
const tlsPort = await unusedPort();
await listen(backend);
const backendPort = addressPort(backend);
const runtimeFile = join(root, "runtime.json");
const managerFile = join(root, "manager.json");
const socketPath = join(root, "socket", "control.sock");
await mkdir(join(root, "socket"));
await writeFile(
  runtimeFile,
  JSON.stringify({
    schema: 1,
    project: remoteProject,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    generation: "integration-generation",
    opencodeVersion: "integration",
  }),
);

const gateway = spawn(
  process.execPath,
  [join(packageRoot, "dist/remote/server.js")],
  {
    env: {
      ...process.env,
      OCVM_OPENLIVE_RUNTIME: runtimeFile,
      OCVM_OPENLIVE_MANAGER_FILE: managerFile,
      OCVM_OPENLIVE_CONTROL_SOCKET: socketPath,
      OCVM_OPENLIVE_PROJECT_HASH: "remote-project-id",
      OCVM_OPENLIVE_GATEWAY_PORT: "0",
      OCVM_OPENLIVE_GATEWAY_READY: readyFile,
      OCVM_OPENLIVE_SCRIPT_VERSION: "integration-script",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "secret",
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let gatewayError = "";
gateway.stderr.setEncoding("utf8");
gateway.stderr.on("data", (chunk) => {
  gatewayError += chunk;
});

const certFile = join(root, "cert.pem");
const keyFile = join(root, "key.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
  { stdio: "ignore" },
);
const cert = await readFile(certFile);
const key = await readFile(keyFile);
let gatewayPort;
const tunnel = tls.createServer({ cert, key }, (client) => {
  const upstream = net.createConnection(gatewayPort, "127.0.0.1");
  client.pipe(upstream).pipe(client);
});

try {
  await waitFor(() => gatewayError.includes("gateway ready"));
  gatewayPort = JSON.parse(await readFile(readyFile, "utf8")).port;
  assert(Number.isInteger(gatewayPort) && gatewayPort > 0);
  await listen(tunnel, tlsPort);
  const mappingFile = join(root, "mapping.json");
  await writeFile(
    mappingFile,
    JSON.stringify({
      schema: 1,
      protocol: "ocvm-openlive.v1",
      localProject,
      origin: `https://127.0.0.1:${tlsPort}`,
      projectId: "remote-project-id",
      displayName: "Remote project",
      username: "opencode",
      password: "secret",
      adapterVersion: "0.1.5",
      adapterSha256: "integration-artifact",
      nodePath: process.execPath,
      clientPath: join(packageRoot, "dist/remote/client.js"),
      tlsFingerprint: new X509Certificate(cert).fingerprint256
        .replaceAll(":", "")
        .toLowerCase(),
    }),
    { mode: 0o600 },
  );
  const client = spawn(
    process.execPath,
    [join(packageRoot, "dist/remote/client.js"), mappingFile, localProject],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let clientError = "";
  client.stdout.setEncoding("utf8");
  client.stderr.setEncoding("utf8");
  client.stdout.on("data", (chunk) => {
    output += chunk;
  });
  client.stderr.on("data", (chunk) => {
    clientError += chunk;
  });
  client.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
  );
  client.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: localProject, mcpServers: [] } })}\n`,
  );
  client.stdin.end();
  const code = await exitCode(client);
  assert.equal(code, 0, `${clientError}\n${gatewayError}`);
  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(responses.some((message) => message.id === 1 && message.result));
  const created = responses.find((message) => message.id === 2)?.result;
  assert.match(created?.sessionId ?? "", /^ocvm:remote-project-id:/);
  assert.equal(managerCreated, true);
  process.stdout.write("Remote OpenLive packaged TLS round trip passed.\n");
} finally {
  gateway.kill("SIGTERM");
  await Promise.all([
    closeServer(tunnel),
    closeServer(backend),
    exitCode(gateway),
  ]);
  await rm(root, { recursive: true, force: true });
}

function session() {
  return {
    id: "manager",
    projectID: "project",
    directory: remoteProject,
    title: "OpenLive Manager",
    version: "integration",
    time: { created: Date.now(), updated: Date.now() },
    permission: [],
  };
}

async function unusedPort() {
  const server = net.createServer();
  await listen(server);
  const port = addressPort(server);
  await closeServer(server);
  return port;
}

function addressPort(server) {
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function exitCode(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function waitFor(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`gateway did not start: ${gatewayError}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
