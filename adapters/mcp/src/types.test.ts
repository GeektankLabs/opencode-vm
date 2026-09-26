import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeOwnedReadyFile, writeReadyFile } from "./main.js";
import { loadCredential, loadRuntimeDescriptor } from "./types.js";
import type { ReadyDescriptor } from "./types.js";

test("runtime and credential loading require canonical private files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-mcp-runtime-"));
  try {
    const project = join(directory, "project");
    const credential = join(directory, "credential");
    const runtime = join(directory, "runtime.json");
    await mkdir(project);
    await writeFile(credential, `${"a".repeat(43)}\n`, { mode: 0o600 });
    await writeFile(
      runtime,
      JSON.stringify({
        schema: 1,
        project,
        projectHash: "hash",
        projectName: "project",
        backendUrl: "http://127.0.0.1:4095",
        generation: "generation",
        opencodeVersion: "1.18.21",
        listenHost: "127.0.0.1",
        listenPort: 40960,
        credentialFile: credential,
      }),
      { mode: 0o600 },
    );

    assert.equal((await loadRuntimeDescriptor(runtime)).project, project);
    assert.equal(await loadCredential(credential), "a".repeat(43));

    await chmod(credential, 0o644);
    await assert.rejects(
      loadRuntimeDescriptor(runtime),
      /credential must have mode 600/u,
    );
    await chmod(credential, 0o600);
    const link = join(directory, "credential-link");
    await symlink(credential, link);
    const linked = JSON.parse(await readFile(runtime, "utf8")) as Record<
      string,
      unknown
    >;
    linked.credentialFile = link;
    await writeFile(runtime, JSON.stringify(linked), { mode: 0o600 });
    await assert.rejects(
      loadRuntimeDescriptor(runtime),
      /credential must be a regular file/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime validation rejects public backend origins and loose descriptor modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-mcp-runtime-invalid-"));
  try {
    const project = join(directory, "project");
    const credential = join(directory, "credential");
    const runtime = join(directory, "runtime.json");
    await mkdir(project);
    await writeFile(credential, "b".repeat(43), { mode: 0o600 });
    await writeFile(
      runtime,
      JSON.stringify({
        schema: 1,
        project,
        projectHash: "hash",
        projectName: "project",
        backendUrl: "https://example.com",
        generation: "generation",
        opencodeVersion: "1.18.21",
        listenHost: "127.0.0.1",
        listenPort: 40960,
        credentialFile: credential,
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      loadRuntimeDescriptor(runtime),
      /loopback HTTP origin/u,
    );
    await chmod(runtime, 0o644);
    await assert.rejects(
      loadRuntimeDescriptor(runtime),
      /descriptor must have mode 600/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness publication is private, atomic, and ownership-aware", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocvm-mcp-ready-"));
  try {
    const path = join(directory, "ready.json");
    const ready: ReadyDescriptor = {
      schema: 1,
      projectHash: "hash",
      generation: "generation",
      adapterVersion: "0.1.2",
      pid: process.pid,
      host: "127.0.0.1",
      port: 40960,
      transport: "streamable-http-stateless",
      preferredProtocolVersion: "2025-11-25",
      supportedProtocolVersions: ["2025-11-25"],
      negotiatedProtocolVersion: null,
    };
    await writeReadyFile(path, ready);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await removeOwnedReadyFile(path, "other-generation", process.pid);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).generation,
      "generation",
    );
    await removeOwnedReadyFile(path, "generation", process.pid);
    await assert.rejects(readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
