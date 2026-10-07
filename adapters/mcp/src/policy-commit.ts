import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readPolicy, PROFILE_NAMES, type AgentControlPolicy, type PolicyFinalFallback, type PolicySelection } from "./agent-control.js";
import { AdapterError, type AdapterErrorCode, type RuntimeDescriptor } from "./types.js";

/**
 * Canonical final-fallback commit for the adapter-side policy write tool.
 *
 * The Hub (Python) and this adapter write the same project file
 * `.opencode-vm/agent-control.json`. Both serialize on the same OS flock at
 * `.opencode-vm/agent-control.lock`; Node has no flock syscall binding, so the
 * lock is acquired by running `flock -x <fd>` on an inherited descriptor of the
 * lock file — the lock stays held by this process's open descriptor until it is
 * closed. Commit semantics mirror hub/policy.py update_fallback: revision CAS,
 * exact-bytes backup on the first schema 1/2 -> 3 upgrade, clearing never
 * downgrades, atomic publication with a private temp file. A missing lock tool
 * fails closed; an unlocked write is never performed.
 */

const VALUE = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;
const PRIVATE_VALUE = /^(?:\/|\\|file:|bearer|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,})|:\/\//iu;
const MAX_POLICY_BYTES = 16 * 1024;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 10;

function fail(code: AdapterErrorCode, message: string): never {
  throw new AdapterError(code, message);
}

function validateSelectionValue(selection: unknown): PolicySelection {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) fail("INVALID_ARGUMENT", "An exact provider, model and variant are required.");
  const value = selection as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "model_id,provider_id,variant") fail("INVALID_ARGUMENT", "An exact provider, model and variant are required.");
  for (const key of ["provider_id", "model_id", "variant"] as const) {
    const item = value[key];
    if (typeof item !== "string" || !VALUE.test(item) || PRIVATE_VALUE.test(item)) fail("INVALID_ARGUMENT", "Invalid provider, model or variant ID.");
  }
  return { provider_id: value.provider_id as string, model_id: value.model_id as string, variant: value.variant as string };
}

export function validateFinalFallbackValue(fallback: unknown): PolicyFinalFallback {
  if (fallback === null || fallback === undefined) return null;
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) fail("INVALID_ARGUMENT", "A fallback needs an exact selection and an optional mode.");
  const value = fallback as Record<string, unknown>;
  const keys = Object.keys(value).sort().join();
  if (keys !== "mode,selection" && keys !== "selection") fail("INVALID_ARGUMENT", "A fallback needs an exact selection and an optional mode.");
  const mode = value.mode ?? "total";
  if (mode !== "total" && mode !== "degrading") fail("INVALID_ARGUMENT", "Fallback mode must be total or degrading.");
  return { mode, selection: validateSelectionValue(value.selection) };
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("POLICY_COMMIT_UNAVAILABLE", "Unsafe policy directory.");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("POLICY_COMMIT_UNAVAILABLE", "Unsafe policy directory.");
}

type PolicyLock = { release: () => Promise<void> };

async function acquirePolicyLock(project: string, timeoutSeconds: number): Promise<PolicyLock> {
  const directory = join(project, ".opencode-vm");
  await ensureDirectory(directory);
  const lockPath = join(directory, "agent-control.lock");
  let handle;
  try {
    handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      fail("POLICY_COMMIT_UNAVAILABLE", "Unsafe policy lock.");
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    fail("POLICY_COMMIT_UNAVAILABLE", "The project policy lock is unavailable; no write was performed.");
  }
  const exit = await new Promise<{ code: number | null; failed: boolean }>((resolve) => {
    let settled = false;
    const child = spawn("flock", ["-x", "-w", String(timeoutSeconds), "3"], {
      stdio: ["ignore", "ignore", "pipe", handle.fd],
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolve({ code: null, failed: true });
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code, failed: false });
      }
    });
  }).catch(() => ({ code: null, failed: true }));
  if (exit.failed || exit.code !== 0) {
    await handle.close().catch(() => undefined);
    fail("POLICY_COMMIT_UNAVAILABLE", "The project policy lock could not be acquired; no write was performed.");
  }
  return {
    release: async () => {
      await handle.close().catch(() => undefined);
    },
  };
}

async function ensureIgnore(project: string): Promise<void> {
  const ignorePath = join(project, ".gitignore");
  let text = "";
  try {
    const info = await lstat(ignorePath);
    if (info.isSymbolicLink() || !info.isFile()) fail("POLICY_COMMIT_UNAVAILABLE", "Unsafe project ignore file.");
    text = await readFile(ignorePath, "utf8");
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text.split("\n").includes(".opencode-vm/")) return;
  const handle = await open(ignorePath, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
  try {
    const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    await handle.writeFile(`${prefix}.opencode-vm/\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function backupExactBytes(directory: string, label: string, revision: number, bytes: Buffer): Promise<void> {
  const backupPath = join(directory, `agent-control.${label}-rev${revision}.backup.json`);
  const temporary = join(directory, `.agent-control-backup-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(backupPath);
      const existing = await readFile(backupPath);
      if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || !existing.equals(bytes)) {
        fail("POLICY_COMMIT_UNAVAILABLE", "Existing migration backup differs or is unsafe; no write was performed.");
      }
    }
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publish(directory: string, path: string, persisted: Record<string, unknown>): Promise<void> {
  const data = `${JSON.stringify(persisted)}\n`;
  const temporary = join(directory, `.agent-control-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    await unlink(temporary).catch(() => undefined);
    fail("POLICY_SAVE_UNCONFIRMED", "Policy publication was not confirmed; read the policy back before another write.");
  }
}

export type FinalFallbackCommitOptions = { lockTimeoutSeconds?: number };

export async function commitFinalFallback(
  runtime: RuntimeDescriptor,
  expectedRevision: number,
  fallback: PolicyFinalFallback,
  options: FinalFallbackCommitOptions = {},
): Promise<AgentControlPolicy> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail("INVALID_ARGUMENT", "A nonnegative expected policy revision is required.");
  }
  const normalizedFallback = validateFinalFallbackValue(fallback);
  const directory = join(runtime.project, ".opencode-vm");
  const path = join(directory, "agent-control.json");
  const lock = await acquirePolicyLock(runtime.project, options.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS);
  try {
    const current = await readPolicy(runtime);
    if (current.revision !== expectedRevision) {
      fail("POLICY_REVISION_CONFLICT", "Policy changed since the revision you read; reload before saving.");
    }
    let exists = true;
    try {
      await lstat(path);
    } catch {
      exists = false;
    }
    if (normalizedFallback !== null && current.schemaVersion !== 3 && exists) {
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_POLICY_BYTES) fail("POLICY_COMMIT_UNAVAILABLE", "Policy file exceeds its bounded size; no write was performed.");
      await backupExactBytes(directory, `schema${current.schemaVersion}`, current.revision, bytes);
    }
    const version = normalizedFallback !== null && current.schemaVersion !== 3 ? 3 : current.schemaVersion;
    const names = version === 1 ? PROFILE_NAMES.slice(0, 3) : PROFILE_NAMES;
    const profiles = Object.fromEntries(names.map((name) => [name, current.profiles[name]]));
    const updatedAt = timestamp();
    const persisted: Record<string, unknown> = {
      schemaVersion: version,
      revision: current.revision + 1,
      updatedAt,
      profiles,
    };
    if (version === 3) persisted.finalFallback = normalizedFallback;
    await ensureIgnore(runtime.project);
    await publish(directory, path, persisted);
    return {
      schemaVersion: version,
      revision: current.revision + 1,
      updatedAt,
      profiles: current.profiles,
      finalFallback: version === 3 ? normalizedFallback : null,
    };
  } finally {
    await lock.release();
  }
}