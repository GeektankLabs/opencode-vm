import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One checked resolver for the engine, MCP, Hub and launchers. The release
// package and the standalone launcher carry the same repository-owned helper.
export function guestStateDirectory(project: string, create = false, child?: string): string {
  const candidates = [
    process.env.OCVM_GUEST_STATE_HELPER,
    fileURLToPath(new URL("../runtime/guest-state.py", import.meta.url)),
    fileURLToPath(new URL("../../../runtime/guest-state.py", import.meta.url)),
  ];
  const helper = candidates.find((p): p is string => !!p && existsSync(p));
  if (!helper) throw new Error("guest-state resolver unavailable; refusing host fallback");
  return execFileSync("python3", [helper, "resolve", project, "monitor", ...(child ? [child] : []), ...(create ? ["--create"] : [])],
    { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
