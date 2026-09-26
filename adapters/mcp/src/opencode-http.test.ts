import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { OpenCodeGateway } from "./opencode.js";
import type { RuntimeDescriptor } from "./types.js";

test("generated OpenCode client uses the expected scoped routes and 204 admission", async () => {
  const requests: Array<{
    method: string;
    url: string;
    authorization?: string;
    body?: unknown;
  }> = [];
  const project = "/tmp/project with spaces";
  const exposed = {
    id: "ses_wire",
    projectID: "project-id",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1, updated: 2 },
    title: "Wire session",
    location: { directory: project },
    agent: "build",
    model: { providerID: "provider", id: "model", variant: "high" },
  };
  const backend = http.createServer(async (request, response) => {
    const bodyText = await readBody(request);
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      ...(typeof request.headers.authorization === "string"
        ? { authorization: request.headers.authorization }
        : {}),
      ...(body !== undefined ? { body } : {}),
    });
    const path = new URL(request.url ?? "", "http://127.0.0.1").pathname;
    if (path === "/global/health") return json(response, { healthy: true });
    if (path === "/config")
      return json(response, {
        default_agent: "build",
        model: "provider/model",
      });
    if (path === "/api/model")
      return json(response, {
        data: [
          {
            id: "model",
            providerID: "provider",
            name: "Model",
            enabled: true,
            variants: [{ id: "high" }],
          },
        ],
      });
    if (path === "/agent")
      return json(response, [
        { name: "build", mode: "primary", variant: "high" },
      ]);
    if (path === "/provider")
      return json(response, {
        all: [
          { id: "provider", models: { model: { variants: { high: {} } } } },
        ],
        connected: ["provider"],
        default: { provider: "model" },
      });
    if (path === "/session" && request.method === "POST")
      return json(response, { id: "ses_wire" });
    if (path === "/project/current") {
      return json(response, {
        id: "project-id",
        worktree: project,
        time: { created: 1, updated: 2 },
        sandboxes: [],
      });
    }
    if (path === "/api/session" && request.method === "GET") {
      return json(response, { data: [exposed], cursor: {} });
    }
    if (path === "/api/session/ses_wire" && request.method === "GET") {
      return json(response, { data: exposed });
    }
    if (path === "/session/status") return json(response, {});
    if (path === "/api/session/ses_wire/permission") {
      return json(response, { data: [] });
    }
    if (path === "/api/session/ses_wire/question") {
      return json(response, { data: [] });
    }
    if (path === "/session/ses_wire/message") {
      return json(response, [
        {
          info: {
            id: "msg_existing",
            sessionID: "ses_wire",
            role: "user",
            time: { created: 3 },
            agent: "build",
            model: {
              providerID: "provider",
              modelID: "model",
              variant: "high",
            },
          },
          parts: [
            {
              id: "part_existing",
              sessionID: "ses_wire",
              messageID: "msg_existing",
              type: "text",
              text: "existing",
            },
          ],
        },
      ]);
    }
    if (
      path === "/session/ses_wire/prompt_async" &&
      request.method === "POST"
    ) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(backend);
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const previousUsername = process.env.OPENCODE_SERVER_USERNAME;
  process.env.OPENCODE_SERVER_PASSWORD = "backend-password";
  process.env.OPENCODE_SERVER_USERNAME = "backend-user";
  const runtime: RuntimeDescriptor = {
    schema: 1,
    project,
    projectHash: "hash",
    projectName: "project",
    backendUrl: `http://127.0.0.1:${port}`,
    generation: "generation",
    opencodeVersion: "1.18.21",
    listenHost: "127.0.0.1",
    listenPort: 40960,
    credentialFile: "/credential",
  };
  try {
    const gateway = new OpenCodeGateway(runtime);
    await gateway.compatibilityCheck();
    const created = await gateway.createSession("Wire session");
    assert.equal(created.session_id, "ses_wire");
    assert.equal((await gateway.listSessions()).sessions[0]?.id, "ses_wire");
    assert.equal(
      (await gateway.getSessionHistory("ses_wire")).messages[0]?.text,
      "existing",
    );
    const receipt = await gateway.sendMessage("ses_wire", "wire prompt");
    assert.match(receipt.message_id, /^msg_[a-f0-9]{32}$/u);

    const expectedAuthorization = `Basic ${Buffer.from("backend-user:backend-password").toString("base64")}`;
    const creations = requests.filter(
      (request) =>
        request.method === "POST" &&
        new URL(request.url, "http://127.0.0.1").pathname === "/session",
    );
    assert.equal(creations.length, 1);
    assert.equal(
      new URL(creations[0]!.url, "http://127.0.0.1").searchParams.get(
        "directory",
      ),
      project,
    );
    assert.deepEqual(creations[0]!.body, {
      title: "Wire session",
      agent: "build",
      model: { providerID: "provider", id: "model", variant: "high" },
    });
    assert.ok(requests.length > 8);
    assert.ok(
      requests.every(
        (request) => request.authorization === expectedAuthorization,
      ),
    );
    assert.ok(
      requests.some((request) => {
        const url = new URL(request.url, "http://127.0.0.1");
        return (
          url.pathname === "/api/session" &&
          url.searchParams.get("directory") === project
        );
      }),
    );
    const admission = requests.find((request) =>
      request.url.startsWith("/session/ses_wire/prompt_async"),
    );
    assert.equal(admission?.method, "POST");
    assert.deepEqual(admission?.body, {
      messageID: receipt.message_id,
      model: { providerID: "provider", modelID: "model" },
      agent: "build",
      variant: "high",
      parts: [{ type: "text", text: "wire prompt" }],
    });
  } finally {
    if (previousPassword === undefined)
      delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
    if (previousUsername === undefined)
      delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = previousUsername;
    await close(backend);
  }
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No TCP port"));
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function json(response: http.ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return body;
}
