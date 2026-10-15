# Lean pack/unpack protocol (offer-only)

Use when a recognised situation calls for moving a project's working runtime across a
discontinuity. The skill **offers** this protocol and helps apply it; it never derives an
autonomous delete, rebuild, reset or wipe release from a situation alone. Without an
explicit operator start release, stop at the offer. This is a lean operational protocol,
**not** a product feature and **not** a framework.

Two covered situations (same protocol, different urgency):

- **Emergency recovery** — the running runtime is unusable and must be re-established.
- **Planned discontinuity** — a deliberately authorised version or base-image change
  (e.g. a new OpenCode version or a new base image).

## Lean pack (what to secure)

- Pack **only** the current, restart-critical code state, open findings, problem evidence
  and required artifacts. Source/host code stays in place — the host mount survives a VM rebuild.
- Inventory host-persistent worktrees by **path/repo/branch/HEAD/dirty/registration/references**;
  never wholesale-duplicate host worktrees.
- Secure **C/P, task documents, receipts, pins and non-ephemeral important evidence**.
  Guest-volatile data and caches are not blindly copied.
- Keep a **package manifest with hashes** (per-file SHA-256) so unpack can verify integrity.
- Retained host objects/branch refs prove neither the worktree directory nor its
  registration exists — inventory both, and re-check both after unpack.

## Secure worker boundary + scheduler pause

- Take a **secure worker boundary** first (verified idle/no-pending; never a mid-turn
  switch) and **pause the scheduler** before packing.
- **Scheduler restart is the very last resume question** — not part of packing.
- Monitors resume has its **own gate**: re-check owner/root/worker/receipt consistency,
  then a separately authorised re-enable. A worker rebind is **not** a monitor-root rebind;
  never edit monitor state directly.

## Shutdown, doctor and state checks (current tooling)

A secure worker boundary (above) is not yet a *verified stop*. Pack only from a state whose
ownership-guarded teardown actually completed, or whose failure was read and recorded:

- The incoming-MCP adapter stop refuses to run **without its ownership generation**. When
  pidfiles are missing or stale (a legacy/pipe start or corrupted state), it recovers the
  real process by the listening-socket owner, verified by generation marker **and** adapter
  path **and** UID **and** start time, and fails closed on any foreign or ambiguous process.
  It reports success only after confirming **no listener remains on the port**, and only then
  releases the staged `mcp/ready.json` / `mcp/runtime.json` descriptors.
- The resource sampler (`resmon`) is stopped **cooperatively** through its stop sentinel —
  never a signal or kill. A still-live sampler keeps its ownership markers and is reported;
  that is an honest incomplete stop, not a clean one.
- Chat-history sync runs in the session **exit trap** (`sync_vm_to_share`), whose rsync
  **excludes `auth.json`**. Provider-auth finalization is separate and host-side in
  `lifecycle_finalize_runtime` (stops the owned guest runtime and requires a **verified
  host-retained final snapshot**). A forced kill of the session shell skips the trap, so a
  killed session is not a secured stop and auth must never come from a **share seed** copied
  while the VM was still running.

Doctor evidence is read-only; use the shipped commands, never an invented one:

- Host: `opencode-vm doctor [show]` — host sync/auth/model/db, skills, MCPs, connector, plus a
  **"Resources (ENFILE time protocol, host history)"** section (host file-table/FD/watcher history).
- Guest (inside the session VM): `doctor` (or `doctor show|tunnel|mcp|services|resources|help`)
  — identity first, each service split into `config | process | readiness | last-success`, a
  *completed* adapter tool trace as the only proven roundtrip, bounded redacted excerpts, and
  `PASS/FAIL/UNVERIFIED` counts (exit codes `0`..`4`).

Run the host doctor **before packing** (pre-discontinuity evidence) and again **after unpack**
(compare the same sections). `doctor resources` / the Resources section shows the ENFILE time
series: a low current value never clears a historical peak and is **not** a PASS, and a
missing/unknown guest probe is reported as **not healthy**.

Secure state by persistence class:

- **Host-persistent** (survives a VM rebuild): the per-project state under
  `~/.opencode-vm/project-state/<hash>/` (including the resmon host history
  `resmon/host.jsonl`), the per-session working copy under `~/.opencode-vm/sessions/<hash>/`,
  the project's `.opencode-vm/taskboard/` state, the registered C/P and task
  documents, the provider-auth baseline, and host worktrees (by reference).
  **`.opencode-vm/monitor/` is no longer host-persistent** — the scheduler/
  monitor management (registry, heartbeat, workers, history, logs) now lives
  on the guest artifact dir (`$OCVM_MONITOR_STATE_DIR`, Phase 2).  A
  declarative restart description is persisted separately (see below).
- **Guest-volatile** (do not blindly copy): `/proc`-derived data, adapter pidfiles, proxy
  markers, in-VM caches and the guest resmon history are VM-local.

Reassign and re-verify after unpack: the controlled reattach (below) *is* the session
boundary. Re-run the host and guest doctors and compare with the pre-pack record, and
reconcile the sampler's **guest-probe record** — it is host-project-persistent and
deliberately blocks a new probe while a hung transport's record is live, so a live or unknown
record is reported, never silently treated as a fresh sample. Existing worktree-restore and
monitor-resume gates remain unchanged.

## Local unpublished update + controlled reattach

- A **local, unpublished** update needs the matching **local assets** and a **controlled
  reattach** (a session boundary) — never a live restart of a running runtime.
- **Source checkout path:** with the script run from the checkout, the adjacent
  `<checkout>/adapters/mcp` is staged and built in-VM (`mcp_adapter_source_dir` →
  `$SCRIPT_DIR/adapters/mcp`). The checked-in archive
  `<checkout>/dist/opencode-vm-mcp-adapter-<version>.tar` matches the script pin.
- The installed `~/bin` **standalone** copy has no adjacent source; it would instead
  require the **published** `v<OCVM_VERSION>` release archive (`mcp_adapter_cache_dir` /
  default GitHub release URL). An unpublished candidate must therefore **not** be routed
  through the standalone `~/bin` copy — that path would demand an archive that does not exist yet.

## After unpack: verify the ACTUAL state (never assume)

Report these **separately and honestly** — a lower stage never implies a higher one:

- checkout pin; **staged** artifact; the **actually loaded** runtime/version (loaded
  process ≠ staged artifact); and the **actually reachable** capability (unknown stays unknown).
- Before the first `send_message`: resolve the current **model-readable** policy
  (`get_project_model_policy` / `get_recommended_runtime`) and available runtime, set the
  target runtime explicitly, and require an exact readback.
- Missing worktrees: restore them from retained **host refs/objects** when needed
  (`git worktree add`, no force/reset), then verify registration + cleanliness.

## Test estates and data

- A **fresh ITE is expected empty**; do not reconstruct the old synthetic test state by default.
- The **external test estate** is a deliberate operator choice with **protected baselines** —
  no blanket wipe, and no automatic cleanup as a side effect of a VM reset.
- Guest-volatile, host-persistent and external (e.g. Proxmox/PVE) resources are inventoried
  and handled **separately**. External reachability failure (timeout/HTTP401) is not proof a
  VM/resource was deleted.

## Result staging (no single PASS)

Stage the outcome: `CODE_RESTORED` / `CONTEXT_RESTORED` are separate from `OPERATIV_READY`
/ `TEST_READY` / `MONITOR_READY`. **Monitor resume:** after a full unpack and check, ask the
operator concretely whether the affected old monitors should be deleted and correctly
assigned new ones created (creating has a start effect), naming the affected monitors and
the loss of run history.  **Operator explicitly Yes/No required** — without concrete restart
release, the old monitors stay off: no delete, no create, no start.  **IDs only as
reference:** the declarative restart description records the old monitor configuration as
historical reference; at recreation, the regular create flow generates **new monitor IDs** —
no ID copy, no reuse of old IDs.  **No silent adoption:** old runtime state, session
bindings and worker records from a different VM lifecycle are never silently reactivated.
**Duplicate protection:** before creation, check the live registry for same-name/same-ID
monitors; existing entries (e.g. from a kept VM) are never duplicated — report instead.
Code/context restoration implies no new full/test/recovery run.
