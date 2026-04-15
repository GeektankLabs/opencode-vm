# Safe defaults on Proxmox

These are the defaults to apply unless the user has explicitly asked for something different.

## Power operations

- **Shutdown, don't stop.** `shutdown` sends ACPI to the guest OS; `stop` is a hard pull-the-plug. Only fall back to `stop` if `shutdown` has been pending >60 s.
- **Reboot ≠ reset.** `reboot` is graceful; `reset` is a hardware reset button. Never use `reset` without explicit ask.

## HA gotchas

- Any VM under an HA group will be restarted by the cluster manager after `stop`/`shutdown`. Move it out of HA first, or the user's "stop this VM" will turn into a ping-pong.
- `migrate` on an HA-managed VM goes through the HA manager, not directly — expect different error shapes.

## Clones & templates

- `full=1` (full clone, independent disks) is the safe default. `full=0` (linked clone) only when the user explicitly asks, and only when the source is already a template — otherwise the linked clone breaks the moment you touch the source.
- When cloning from a template, default to a new VMID in the same hundred-block as sibling VMs.

## LXC defaults

- `unprivileged=1` unless the user needs features that require privileged (fuse, nested containers, certain kernel modules). Privileged LXC is root on the host if compromised.
- `features: nesting=1,keyctl=1` only when specifically needed (Docker-in-LXC, systemd-user-sessions).

## Storage & disks

- `discard=on,ssd=1` for VMs on SSD-backed storage (NVMe/ZFS-on-SSD/local-lvm on SSD) — frees space back to the store on guest TRIM.
- `backup=1` on the root disk only, `backup=0` on scratch/cache disks.
- Default disk format: `raw` on LVM/block, `qcow2` on file/dir storage.

## Snapshots

- Always name with a timestamp or task reason: `pre-upgrade-2026-04-15`, not `snap1`.
- Include memory state (`vmstate=1`) only when the user needs crash-consistent application state; it makes snapshots much larger.
- Rollback is destructive to state between snapshot and now — confirm before rolling back.

## Backups

- Mode: `snapshot` (default, live + crash-consistent) on ZFS/Ceph/qcow2; `suspend` on LVM-thin without snapshot support; `stop` only when the user explicitly wants offline-consistent.
- Compression: `zstd` (fast + small). Skip `gzip` — slower, no benefit.

## Networking

- `firewall=1` on the NIC if PVE firewall is used cluster-wide — leave it alone otherwise (turning it on silently drops traffic if no rules are defined).
- `bridge=vmbr0` unless the user names another bridge. Validate the bridge exists on the target node before creating a NIC.

## Destructive ops checklist

Before `delete`, `destroy`, `purge`, or snapshot/`backup` removal, confirm out loud:

- Resource ID + name
- Node it's on
- Whether it's running
- Whether a recent backup exists

If any of those four is unknown, list first, delete second.
