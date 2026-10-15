import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { defaultMonitorRecord, ensureManagerAlias, monitorHistory, readRegistrySnapshot, validateInvestigationConfigInput, withRegistry } from "./monitor.js";
import type { MonitorInvestigationConfig } from "./monitor.js";

const investigation = z.object({
  schema: z.literal(1),
  config: z.object({ first_check_s: z.number(), cooldown_s: z.number(), ladder_s: z.array(z.number()).length(3),
    budget: z.object({ max_duration_ms: z.number(), max_calls: z.number(), max_bytes: z.number(),
      call_timeout_ms: z.number(), daily_budget: z.number() }).strict() }).strict(),
  task: z.object({ task_type: z.enum(["default", "long_runner", "milestoned"]),
    expected_milestone: z.string().nullable(), milestone_due_at: z.string().nullable() }).strict(),
}).strict();
const entry = z.object({
  reference_id: z.string(), title: z.string().min(1).max(160), task_id: z.string().regex(/^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  interval_seconds: z.number().int().min(5).max(86400),
  autonomy_profile: z.enum(["conservative", "sandbox", "mvp", "yolo"]),
  runtime_profile: z.enum(["deep", "standard", "execution", "design", "review"]),
  expiry_at: z.number().nullable(), investigation_config: investigation.nullable(),
}).strict();
const description = z.object({
  schema: z.literal(1), project: z.string(), captured_at: z.string(), source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  monitors: z.array(entry).max(500),
}).strict();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Unpacked configs revalidate against the canonical create_monitor limits. */
function normalizeInvestigationConfig(value: z.output<typeof investigation>): MonitorInvestigationConfig {
  return validateInvestigationConfigInput({
    first_check_s: value.config.first_check_s,
    cooldown_s: value.config.cooldown_s,
    ladder_s: value.config.ladder_s,
    budget: value.config.budget,
    daily_budget: value.config.budget.daily_budget,
    task_type: value.task.task_type,
    expected_milestone: value.task.expected_milestone,
    milestone_due_at: value.task.milestone_due_at,
  });
}

async function safePersistentPath(project: string, file: string): Promise<string> {
  const target = resolve(file);
  const root = resolve(project);
  if (!target.startsWith(root + sep)) throw new Error("handover must stay inside the persistent project");
  const parents: string[] = [];
  for (let p = dirname(target); p !== dirname(p); p = dirname(p)) parents.unshift(p);
  for (const p of [...parents, target]) {
    try {
      const s = await lstat(p);
      if (s.isSymbolicLink() || (p !== target && !s.isDirectory()) || (p === target && (!s.isFile() || s.uid !== process.getuid?.() || s.size > 1_048_576)))
        throw new Error("unsafe handover path (symlink/foreign type)");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

export async function packMonitors(project: string, destination = join(project, ".opencode-vm/handover/monitor-restart.json")) {
  const { registry, path } = await readRegistrySnapshot(project);
  const raw = await readFile(path, "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
  if (raw && JSON.stringify(JSON.parse(raw)) !== JSON.stringify(registry)) throw new Error("monitor registry changed during pack; retry after secure boundary");
  // This is the only durable export: explicit declarative allowlist. No
  // history/logs, sessions, workers, heartbeat, wake/WAL state, locks or PIDs.
  const value = description.parse({ schema: 1, project: resolve(project), captured_at: new Date().toISOString(),
    source_sha256: sha(raw),
    monitors: registry.monitors.map(m => ({ reference_id: m.id, title: m.title, task_id: m.anchor.task_id,
      interval_seconds: m.scheduler.interval_seconds, autonomy_profile: m.autonomy_profile,
      runtime_profile: m.runtime_profile, expiry_at: m.scheduler.expiry_at,
      investigation_config: m.investigation_config ?? null })) });
  const file = await safePersistentPath(project, destination);
  const text = JSON.stringify(value, null, 2) + "\n";
  // Explicit pack owns only its own description, never arbitrary existing
  // files: an existing file must be a complete owned pair (this project's
  // description plus its manifest describing exactly those bytes). Anything
  // else is retained untouched instead of overwritten.
  let existingText: string | undefined;
  try { existingText = await readFile(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (existingText !== undefined) {
    try {
      const old = description.parse(JSON.parse(existingText));
      if (old.project !== resolve(project)) throw new Error("foreign project");
    } catch {
      throw new Error("existing handover file retained (not owned)");
    }
  }
  const manifest = await safePersistentPath(project, file + ".manifest.json");
  let manifestRaw: string | undefined;
  try { manifestRaw = await readFile(manifest, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if ((existingText === undefined) !== (manifestRaw === undefined))
    throw new Error("existing foreign manifest retained");
  if (manifestRaw !== undefined) {
    try {
      const old = JSON.parse(manifestRaw);
      if (old.schema !== 1 || old.files?.[0]?.path !== file || old.files?.[0]?.sha256 !== sha(existingText!))
        throw new Error("foreign manifest");
    } catch {
      throw new Error("existing foreign manifest retained");
    }
  }
  const temp = file + `.tmp-${process.pid}`;
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  await rename(temp, file);
  await writeFile(manifest, JSON.stringify({ schema: 1, files: [{ path: file, sha256: sha(text) }] }) + "\n", { mode: 0o600 });
  return { path: file, sha256: sha(text), monitors: value.monitors.length };
}

export async function unpackMonitors(project: string, source: string, decision?: "yes" | "no") {
  const file = await safePersistentPath(project, source);
  const text = await readFile(file, "utf8");
  const value = description.parse(JSON.parse(text));
  if (value.project !== resolve(project)) throw new Error("handover project identity mismatch");
  const manifestPath = await safePersistentPath(project, file + ".manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.files?.[0]?.sha256 !== sha(text) || manifest.files?.[0]?.path !== file)
    throw new Error("handover manifest changed");
  if (!decision) return { decision_required: true, question: "Monitore aus dieser Beschreibung neu anlegen und aktivieren? Ja/Nein",
    monitors: value.monitors.map(m => ({ title: m.title, task_id: m.task_id, interval_seconds: m.interval_seconds })) };
  // Revalidate every entry against the canonical rules BEFORE any side effect.
  const entries = value.monitors.map(item => ({ item,
    investigation: item.investigation_config ? normalizeInvestigationConfig(item.investigation_config) : null }));
  const receipt = await safePersistentPath(project, file + ".decision.json");
  try {
    const old = JSON.parse(await readFile(receipt, "utf8"));
    if (old.schema !== 1 || !["accepted", "rejected"].includes(old.decision)) throw new Error("foreign receipt");
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("existing foreign decision receipt retained"); }
  const created: string[] = [];
  const retained: string[] = [];
  if (decision === "yes") {
    await withRegistry(project, registry => {
      for (const { item, investigation: config } of entries) {
        // Master-task binding is authoritative; title is additional duplicate protection.
        if (registry.monitors.some(m => m.anchor.task_id === item.task_id || m.title === item.title)) {
          retained.push(item.task_id); continue;
        }
        const monitor = defaultMonitorRecord(item.title, item.task_id, item, Date.now());
        ensureManagerAlias(registry, monitor);
        if (config) monitor.investigation_config = config;
        monitorHistory(monitor, "created", { source: "operator-approved-declarative-handover" });
        registry.monitors.push(monitor);
        created.push(monitor.id);
      }
    });
  }
  await writeFile(receipt, JSON.stringify({ schema: 1, source_sha256: sha(text),
    decision: decision === "no" ? "rejected" : "accepted", created, retained, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
  return { decision, created, retained };
}
