# Proxmox API tokens

Tokens live under **Datacenter → Permissions → API Tokens**. A token is bound to a user and inherits that user's PVE role assignments unless "Privilege Separation" is on (then you must grant roles to the token itself).

## One-time setup (recommended shape)

1. **Datacenter → Permissions → Users → Add**
   - User: `automation`
   - Realm: `pve` (Proxmox VE authentication, not PAM — PAM users tie to OS accounts)
   - Enabled: yes
2. **Datacenter → Permissions → API Tokens → Add**
   - User: `automation@pve`
   - Token ID: `claude`
   - Privilege Separation: **off** (simpler: token inherits user's permissions)
   - Copy the token secret **immediately** — PVE shows it once and never again.
3. **Datacenter → Permissions → Add → User Permission**
   - Path: `/` (or narrower, e.g. `/pool/lab`)
   - User: `automation@pve`
   - Role: `PVEAdmin` (full VM/LXC/storage) or a narrower built-in (`PVEVMAdmin`, `PVEDatastoreUser`, …)

The full token identifier is then: `automation@pve!claude`, and the value is the secret UUID.

## Token fields in `proxmox.env`

```
PROXMOX_USER="automation@pve"
PROXMOX_TOKEN_NAME="claude"          # NOT the full "user!tokenname"
PROXMOX_TOKEN_VALUE="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## Rotation

1. In PVE UI: regenerate or add a new token with a fresh name.
2. On the OCVM host: `opencode-vm skills off proxmox` (wipes the stored token), then `opencode-vm skills on proxmox` (re-prompts, saves the new one).

## Least privilege cheat sheet

| Use case                          | Role              |
|-----------------------------------|-------------------|
| List/inspect only                 | `PVEAuditor`      |
| VM lifecycle + snapshot           | `PVEVMAdmin`      |
| VM + storage (attach/resize disk) | `PVEVMAdmin` + `PVEDatastoreUser` on the store |
| Full admin                        | `PVEAdmin`        |
| Only a specific pool              | any of above, scoped to `/pool/<name>` |

Scope in PVE is *path-based* — assigning a role at `/pool/lab` silently denies everything outside that pool.

## Self-signed certs

Homelab PVE nodes usually use the auto-generated self-signed cert. Set `PROXMOX_VERIFY_SSL=0` in `proxmox.env` for those. For production clusters with a real CA-signed cert, flip it to `1`.
