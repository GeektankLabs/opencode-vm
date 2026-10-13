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
the loss of run history. Without a concrete restart release, the old monitors stay off —
no delete, no create, no start. Code/context restoration implies no new full/test/recovery run.
