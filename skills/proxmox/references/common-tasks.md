# Common Proxmox tasks

Worked examples. The exact MCP tool names depend on the ProxmoxMCP server build — look them up via the tool list; the recipe shape stays the same.

## 1. Clone a VM from a template

1. List nodes → pick the target.
2. List VMs → find the template's VMID (templates are flagged `template=1`).
3. List VMs → pick the next free VMID in the same hundred-block.
4. Clone: source VMID, target VMID, target node, `full=1`, name.
5. Poll task status until done.
6. Optionally: set `cores`, `memory`, `net0` overrides; start.

## 2. Create a new LXC container

1. List storage → confirm a container-capable store (`content` includes `rootdir`).
2. List templates on that store (`content=vztmpl`) → pick an OS template.
3. Create container: VMID, node, ostemplate, storage, hostname, password or ssh-public-keys, `unprivileged=1`, `features=nesting=0`, `cores`, `memory`, `swap`, `net0=name=eth0,bridge=vmbr0,ip=dhcp` (or static).
4. Start.

Always ssh-key-first, password as fallback.

## 3. Snapshot before an upgrade, then rollback on failure

1. Read VM config and current state.
2. Take snapshot: `pre-<task>-<YYYY-MM-DD>`, no vmstate unless memory state matters.
3. Tell the user: *"snapshot `pre-upgrade-2026-04-15` taken on vm 104 — rollback with: `rollback vm 104 pre-upgrade-2026-04-15`"*.
4. After the upgrade: if user confirms success, delete the snapshot; if failure, rollback.

## 4. One-off backup to a datastore

1. List storage → pick one with `content` including `backup` (e.g. `pbs` or a `dir`/`nfs` with backup enabled).
2. Trigger `vzdump` on that VMID: `mode=snapshot`, `compress=zstd`, `storage=<store>`.
3. Poll task; return the resulting archive name.

## 5. Resize a disk

1. Read VM config → identify the disk (e.g. `scsi0`).
2. Resize (grow only; PVE refuses shrink): `+<size>G`.
3. Tell the user: resize only expanded the underlying volume; they must grow the filesystem inside the guest (`growpart` + `resize2fs`/`xfs_growfs`).

## 6. Live-migrate a VM to another node

Preconditions: shared storage (Ceph, NFS, shared LVM) or all involved disks on storage replicated between source and target.

1. List nodes → confirm target is online and in the same cluster.
2. Check VM disk storage → verify it's reachable from target.
3. Migrate: `online=1`, target node.
4. Poll task; return final state.

If storage isn't shared, use offline migration (`online=0`) — faster to execute, but the VM is stopped during the move.

## 7. Attach a new disk

1. List storage → pick the target store.
2. Read VM config → find the next free bus slot (scsi1, scsi2, …).
3. Set config: `scsi1=<store>:<size_in_GB>,discard=on,ssd=1` (SSD flag only if the underlying store is SSD-backed).
4. Tell the user the disk is attached but unformatted — they need to partition / `mkfs` inside the guest.

## 8. Find where something lives

- "Where is VM 104?" → list all nodes, query VMs per node, match by VMID. Report: node, status, uptime, memory, disk, last backup.
- "List everything on node pve-01" → VMs + LXCs on that node, with status + resource usage.

## 9. Rotate a stale lock

If the MCP returns `VM is locked (backup|migrate|clone|snapshot|rollback)` but the corresponding task is gone:

1. Read current task list on the node → confirm no active task for that VMID.
2. Ask the user for confirmation before unlocking.
3. Unlock via config reset (or `qm unlock <vmid>` on a node shell).

## 10. What *not* to do via the MCP

- Cluster join/leave — do this from the node shell, never remotely via API.
- Ceph OSD/monitor changes — too easy to wedge. Recommend the user log in to a node.
- Editing the root `datacenter.cfg` or `/etc/pve/corosync.conf` — manual only.
