# AGENTS.md

This file provides guidance to ai agents when working with code in this repository.

## Project Overview

**opencode-vm** is a single Bash script (`opencode-vm.sh`) that runs [OpenCode](https://opencode.ai) inside an isolated Lima VM on macOS. It provides a fresh-per-session workflow: a persistent base VM (`oc-base`) is cloned for each session, the user's project directory and OpenCode config are mounted in, and the session VM is deleted on exit.

Key design goals:
- Isolation via Lima VM with controlled network egress (nftables)
- Host project directory mounted read-write so IDE/Git workflow stays on host
- OpenCode config + user state synced via per-project host state and per-session working copy
- Host LLM servers (LM Studio :1234, Ollama :11434) reachable from VM via `host.lima.internal`
- LAN access restricted by default with opt-in allowlists

## Architecture

The entire tool is one file: `opencode-vm.sh` (~1800 lines of Bash).

**VM Lifecycle:** `oc-base` (provisioned once via `init`) → cloned per session → session deleted on exit.

**Host directories:**
- `~/.opencode-vm/project-state/` — persistent OpenCode config/data per project hash
- `~/.opencode-vm/sessions/` — per-project session working copy + running-session env tracker
- `~/.opencode-vm/backups/` — timestamped config backups
- `~/.opencode-vm/policy.env` — persisted firewall policy (host TCP ports, LAN allowlists)

**Script structure (top to bottom):**
1. Constants and defaults (lines 1-30)
2. Self-update metadata: `OCVM_VERSION`, `OCVM_UPDATE_REPO`, etc.
3. Utility functions: `need`, `ensure_dirs`, path helpers, cfg/data sync helpers, `pick_host_cfg`, `backup_host_cfg` (early section)
4. Policy management: `ensure_policy_file`, `load_policy`, `save_policy`
5. List helpers: `list_has`, `list_add`, `list_rm`
6. Self-update helpers: version parsing, remote fetch, resolve script path, passive update check
7. `ports_cmd` — CLI subcommand for managing firewall policy
8. Self-update commands: `update_cmd`, `export_patch_cmd`, `ocvm_post_update_migrate`
9. `provision_base` — creates base VM, installs OpenCode + nftables + Playwright
10. `apply_policy_in_vm` — translates `policy.env` into nft commands
11. `start_session` — main workflow: backup config → host/project sync → clone → mount → apply policy → run opencode → cleanup+sync-back
12. Top-level `case` dispatch

## Commands

```bash
# Install script to ~/bin (first-time setup)
opencode-vm install

# Provision base VM (one-time setup, requires: brew install lima)
opencode-vm init

# Start a session (run from project directory)
opencode-vm              # or: opencode-vm run

# Reconnect to a running session after terminal crash
opencode-vm attach

# Manage firewall policy
opencode-vm ports show
opencode-vm ports host add 8080
opencode-vm ports lan tcp add 192.168.178.10:443

# Maintenance
opencode-vm base         # shell into base VM
opencode-vm prune        # cleanup unused Lima data

# Self-update and contribution
opencode-vm update                       # update script from upstream
opencode-vm create-patch [topic]         # generate patch submission for upstream
opencode-vm export-patch [topic]         # alias for create-patch
```

## Version Bumping

Every change to `opencode-vm.sh` **must** increment the patch version in `OCVM_VERSION` (line ~40). The format is `MAJOR.MINOR.PATCH` — only bump the patch (rightmost) number. It can exceed 9 (e.g., `0.1.9` → `0.1.10` → `0.1.11` → ... → `0.1.100`). Example: if current version is `0.1.1`, change it to `0.1.2`.

## Conventions

- The script uses `set -euo pipefail` — all errors are fatal
- Policy is stored as space-separated lists in shell variables (sourced from `policy.env`)
- LAN allowlist entries use `IP:PORT` format (e.g., `192.168.178.10:443`)
- The nftables config lives at `/etc/nftables.conf` inside the base VM and uses the `inet ocfilter` table
- Network model is Lima's default user-mode/slirp: host at `192.168.5.2`, DNS at `192.168.5.3`
