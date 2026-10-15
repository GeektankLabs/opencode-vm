import { join } from "node:path";
import { packMonitors, unpackMonitors } from "./monitor-handover.js";

const [action, project, file, answer] = process.argv.slice(2);
try {
  if (!project || !action || !["pack", "unpack"].includes(action)) throw new Error("usage: monitor pack|unpack <project> [description] [--yes|--no]");
  if (answer && !["--yes", "--no"].includes(answer)) throw new Error("explicit --yes or --no required");
  const path = file || join(project, ".opencode-vm/handover/monitor-restart.json");
  const result = action === "pack" ? await packMonitors(project, path)
    : await unpackMonitors(project, path, answer === "--yes" ? "yes" : answer === "--no" ? "no" : undefined);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`[monitor-handover] ${error instanceof Error ? error.message : "failed"}`);
  process.exitCode = 1;
}
