import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AdapterError, type RuntimeDescriptor } from "./types.js";

/**
 * Durable, project-specific single-order recovery store (task_68085480 part 2).
 *
 * One JSON document at `<project>/.opencode-vm/recovery-orders.json`, guarded by
 * an OS `flock` at `<project>/.opencode-vm/recovery-orders.lock` and written
 * atomically (private temp file + same-directory rename + directory fsync), the
 * same convention as the agent-control policy. It records the minimal provenance
 * of adapter-admitted single orders so an explicitly requested recovery can act
 * on exactly the original order: identifiers, runtime identities and outcomes
 * only — never prompts, payloads or secrets.
 */

export type RecoveryOrderStatus = "pending" | "final_attempted" | "escalated" | "completed";

export type RecoveryAttempt = { at: string; identity: string; outcome: string };

export type RecoveryOrder = {
  session_id: string;
  message_id: string;
  profile: string | null;
  created_at: string;
  updated_at: string;
  status: RecoveryOrderStatus;
  final_attempted: boolean;
  new_receipt: string | null;
  attempts: RecoveryAttempt[];
};

type RecoveryStore = { schema: 1; orders: Record<string, RecoveryOrder> };

export const RECOVERY_STORE_SCHEMA = 1;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_ORDERS = 200;
export const MAX_RECOVERY_ATTEMPTS = 16;
const LOCK_TIMEOUT_SECONDS = 10;

const orderKey = (sessionId: string, messageId: string): string => `${sessionId}\u0000${messageId}`;

export function recoveryStorePath(project: string): string {
  return join(project, ".opencode-vm", "recovery-orders.json");
}
function recoveryLockPath(project: string): string {
  return join(project, ".opencode-vm", "recovery-orders.lock");
}
function directory(project: string): string {
  return join(project, ".opencode-vm");
}

function fail(code: string, message: string): never {
  throw new AdapterError(code as AdapterError["code"], message);
}

const emptyStore = (): RecoveryStore => ({ schema: RECOVERY_STORE_SCHEMA, orders: {} });

function validOrder(value: unknown): value is RecoveryOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.session_id !== "string" || typeof v.message_id !== "string") return false;
  if (v.profile !== null && typeof v.profile !== "string") return false;
  if (typeof v.created_at !== "string" || typeof v.updated_at !== "string") return false;
  if (!["pending", "final_attempted", "escalated", "completed"].includes(v.status as string)) return false;
  if (typeof v.final_attempted !== "boolean") return false;
  if (v.new_receipt !== null && typeof v.new_receipt !== "string") return false;
  if (!Array.isArray(v.attempts) || v.attempts.length > MAX_RECOVERY_ATTEMPTS) return false;
  for (const a of v.attempts) {
    if (!a || typeof a !== "object") return false;
    const r = a as Record<string, unknown>;
    if (typeof r.at !== "string" || typeof r.identity !== "string" || typeof r.outcome !== "string") return false;
  }
  return true;
}

export async function readRecoveryStore(runtime: RuntimeDescriptor): Promise<RecoveryStore> {
  const path = recoveryStorePath(runtime.project);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) fail("UNSUPPORTED_CONFIGURATION", "Recovery store is unsafe.");
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("UNSUPPORTED_CONFIGURATION", "Recovery store is invalid.");
    const value = parsed as Record<string, unknown>;
    if (value.schema !== RECOVERY_STORE_SCHEMA || !value.orders || typeof value.orders !== "object" || Array.isArray(value.orders))
      fail("UNSUPPORTED_CONFIGURATION", "Recovery store is invalid.");
    for (const entry of Object.values(value.orders as Record<string, unknown>)) if (!validOrder(entry)) fail("UNSUPPORTED_CONFIGURATION", "Recovery store is corrupt.");
    return value as RecoveryStore;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    fail("UNSUPPORTED_CONFIGURATION", "Recovery store is invalid or unsupported.");
  }
}

export function getOrder(store: RecoveryStore, sessionId: string, messageId: string): RecoveryOrder | undefined {
  return store.orders[orderKey(sessionId, messageId)];
}

type Lock = { release: () => Promise<void> };
async function acquireLock(project: string): Promise<Lock> {
  const dir = directory(project);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("POLICY_COMMIT_UNAVAILABLE", "Unsafe recovery directory.");
  const handle = await open(recoveryLockPath(project), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const lockInfo = await handle.stat();
  if (!lockInfo.isFile() || lockInfo.uid !== process.getuid?.() || (lockInfo.mode & 0o077) !== 0) {
    await handle.close().catch(() => undefined);
    fail("POLICY_COMMIT_UNAVAILABLE", "Unsafe recovery lock.");
  }
  const exit = await new Promise<{ code: number | null; failed: boolean }>((res) => {
    let settled = false;
    const child = spawn("flock", ["-x", "-w", String(LOCK_TIMEOUT_SECONDS), "3"], { stdio: ["ignore", "ignore", "pipe", handle.fd] });
    child.once("error", () => { if (!settled) { settled = true; res({ code: null, failed: true }); } });
    child.once("close", (code) => { if (!settled) { settled = true; res({ code, failed: false }); } });
  }).catch(() => ({ code: null, failed: true }));
  if (exit.failed || exit.code !== 0) {
    await handle.close().catch(() => undefined);
    fail("POLICY_COMMIT_UNAVAILABLE", "The recovery store lock could not be acquired; no write was performed.");
  }
  return { release: async () => { await handle.close().catch(() => undefined); } };
}

async function publish(project: string, store: RecoveryStore): Promise<void> {
  const dir = directory(project);
  const path = recoveryStorePath(project);
  const data = `${JSON.stringify(store)}\n`;
  const temporary = join(dir, `.recovery-orders-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directoryHandle = await open(dir, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    await unlink(temporary).catch(() => undefined);
    fail("POLICY_SAVE_UNCONFIRMED", "Recovery store publication was not confirmed; read it back before another write.");
  }
}

function prune(store: RecoveryStore): void {
  const entries = Object.entries(store.orders);
  if (entries.length <= MAX_ORDERS) return;
  entries.sort((a, b) => (a[1].updated_at < b[1].updated_at ? 1 : -1));
  for (const [key] of entries.slice(MAX_ORDERS)) delete store.orders[key];
}

/** Atomic, locked mutation. `mutate` returns the next order to persist for the
 * given key (or null to leave the store unchanged) and must not throw for a
 * benign no-op. */
export async function mutateRecoveryOrder(
  runtime: RuntimeDescriptor,
  sessionId: string,
  messageId: string,
  mutate: (current: RecoveryOrder | undefined) => RecoveryOrder | null,
): Promise<RecoveryOrder | null> {
  const lock = await acquireLock(runtime.project);
  try {
    const store = await readRecoveryStore(runtime);
    const key = orderKey(sessionId, messageId);
    const next = mutate(store.orders[key]);
    if (next !== null) {
      if (!validOrder(next)) fail("INVALID_ARGUMENT", "Recovery order update is invalid.");
      store.orders[key] = next;
      prune(store);
      await publish(runtime.project, store);
    }
    return next;
  } finally {
    await lock.release();
  }
}

/** Records the provenance of an adapter-admitted single order (no prompt/secrets).
 * Idempotent per (session, message): an existing terminal entry is preserved. */
export async function recordAdmission(
  runtime: RuntimeDescriptor,
  input: { session_id: string; message_id: string; profile: string | null; now: string },
): Promise<void> {
  await mutateRecoveryOrder(runtime, input.session_id, input.message_id, (current) => {
    if (current) return null; // already known; never overwrite an episode
    return {
      session_id: input.session_id,
      message_id: input.message_id,
      profile: input.profile,
      created_at: input.now,
      updated_at: input.now,
      status: "pending",
      final_attempted: false,
      new_receipt: null,
      attempts: [],
    };
  });
}

export function nextOrder(order: RecoveryOrder, patch: Partial<RecoveryOrder>, now: string): RecoveryOrder {
  return { ...order, ...patch, updated_at: now };
}
