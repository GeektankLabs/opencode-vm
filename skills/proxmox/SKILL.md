---
name: proxmox
description: Manage a Proxmox VE cluster (VMs, LXC containers, nodes, storage, snapshots, backups) through the Proxmox MCP server. Use when the user asks to list, inspect, create, start/stop, clone, snapshot, back up, or delete VMs/containers on Proxmox, or when they mention PVE, pvesh, qm, or pct.
---

# Proxmox VE operations

You are helping manage a Proxmox Virtual Environment (PVE) via the `proxmox` MCP server. The server authenticates with an API token bound to a PVE user; scope is whatever PVE role that user has.

## Core reflex: read before you write

Before any state-changing call (`start`, `stop`, `reboot`, `shutdown`, `clone`, `create`, `delete`, `restore`, `migrate`, snapshot delete, config change):

1. List nodes → confirm which node you're targeting.
2. Show the target VM/LXC status and config.
3. State what you're about to do in one sentence and wait for confirmation, unless the user has explicitly pre-authorised the action in this session.

Read operations (`get`, `list`, `status`, `version`) do not need confirmation.

## Safe-by-default posture

- **Never** delete a VM, container, snapshot, or backup without explicit user confirmation naming the resource.
- **Never** run destructive operations on nodes marked as part of an HA group without re-confirming — HA will try to resurrect a VM you just shut down.
- Prefer `shutdown` over `stop`; `stop` is a hard power-off and risks FS corruption.
- When cloning or creating, default `full=0` (linked clone) only if the user explicitly asked for it; otherwise `full=1` is safer.
- For LXC: default `unprivileged=1` unless the user needs privileged for a clear reason.
- On migrations: use `online=1` only when the storage is shared; otherwise it will fail mid-flight.

## Naming discipline

- VMIDs: respect the user's numbering scheme. If unsure, list existing IDs first and pick the next free one in the same hundred-block.
- Hostnames/names: lowercase, no spaces. Match the user's convention (look at neighbours first).

## Typical task recipes

See [references/common-tasks.md](references/common-tasks.md) for worked examples (clone a VM, create an LXC, snapshot + rollback, schedule a backup, attach a disk, resize a volume).

See [references/api-tokens.md](references/api-tokens.md) if the user needs to create or rotate a token, or if authentication is failing.

See [references/safe-defaults.md](references/safe-defaults.md) for the full list of conservative defaults and the rationale.

## When tools aren't enough

The MCP covers VM/LXC/node/storage/cluster/task surfaces. If the user asks for something beyond that (e.g. `pvesm` storage provisioning edge cases, Ceph ops, cluster join), fall back to telling them the exact `pvesh` / `qm` / `pct` command to run on a node shell — do not silently attempt it.
