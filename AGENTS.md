# AGENTS.md

This file provides guidance to ai agents when working with code in this repository.

## Project Overview

**opencode-vm** is a single Bash script (`opencode-vm.sh`) that runs [OpenCode](https://opencode.ai) inside an isolated Lima VM on macOS. It provides a fresh-per-session workflow: a persistent base VM (`oc-base`) is cloned for each session, the user's project directory and OpenCode config are mounted in, and the session VM is deleted on exit.

Key design goals:
- Isolation via Lima VM with controlled network egress (nftables)
- Host project directory mounted read-write so IDE/Git workflow stays on host
- OpenCode config + user state synced via per-project host state and per-session working copy
- Host LLM servers (LM Studio :1234, Ollama :11434) reachable from VM via `host.lima.internal`. Provider configs are managed via `opencode-vm provider {add|new|refresh|rm}`. Since v0.4.12, every `opencode-vm start` auto-runs `provider_refresh_all_quiet` against host-local providers (`localhost`/`127.0.0.1`/`192.168.5.2`/`host.lima.internal`) so newly-loaded LM Studio / Ollama models surface immediately in the next session — disable with `OCVM_PROVIDER_AUTOREFRESH=0`. Capability tagging for newly-discovered models lives in `_provider_cap_heuristics`: tries `/v1/models` JSON metadata first (`capabilities[]`, `modalities.input`, `vision`/`thinking` booleans), falls back to id-pattern matching (`llava|qwen*-vl|pixtral|gemma3|...` for vision; `qwq|deepseek-r1|o1|o3|*-thinking` for reasoning). User-set per-model flags are preserved verbatim — refresh never silently downgrades them.
- LAN access restricted by default with opt-in allowlists
- **No git credentials inside the VM.** The session VM intentionally has no SSH keys, no SSH-agent forwarding, no HTTPS tokens, and no access to the user's git origin. All `git push`, `git fetch`, and PR operations happen on the host (the IDE workflow that stays outside the VM). This is a hard design boundary: a YOLO-mode AI agent inside the sandbox must not be able to reach the user's origin remote. Do not add credential-forwarding, even as an opt-in — if a workflow seems to require it, the correct answer is to move that workflow to the host. **Note on SSH tooling:** the base VM ships `openssh-client`, `sshpass`, `autossh`, `mosh`, `sshfs`, plus standard network-discovery tools (`nmap`, `arp-scan`, `arping`, `tcptraceroute`, `tshark`, …) so agents can perform legitimate SSH and network operations to **non-origin** targets (lab hosts, LAN devices, Proxmox nodes, customer servers) without per-session installs. Having the binaries available does **not** weaken the boundary — credentials are still never copied or forwarded into the VM. If a target requires authentication, the user provides it explicitly per session (env var, MCP credential prompt, manual paste into `~/.ssh/`) and it is never persisted across sessions.

## Architecture

The entire tool is one Bash script: `opencode-vm.sh`. Two small JSON registries live beside it: [`skills/registry.json`](skills/registry.json) and [`mcps/registry.json`](mcps/registry.json). The script remains the single source of truth — registries are data that the script reads at runtime, not independent modules.

**VM Lifecycle:** `oc-base` (provisioned once via `init`) → cloned per session → session deleted on exit.

**Host directories:**
- `~/.opencode-vm/project-state/` — persistent OpenCode config/data per project hash
- `~/.opencode-vm/sessions/` — per-project session working copy + running-session env tracker
- `~/.opencode-vm/backups/` — timestamped config backups
- `~/.opencode-vm/policy.env` — persisted firewall policy (host TCP ports, LAN allowlists)
- `~/.opencode-vm/ecc.env` — ECC integration state (opt-in; absent or `ECC_ENABLED=0` means no ECC)
- `~/.opencode-vm/ecc/` — clone of the everything-claude-code repo (only when ECC is enabled)
- `~/.opencode-vm/project-state/<hash>/homunculus/` — per-project ECC learning store (only when ECC is enabled; survives session restarts)
- `~/.opencode-vm/skills.env` — skills subsystem state (field: `SKILLS_PACKAGES` — space-separated active skill packages)
- `~/.opencode-vm/mcps.env` — MCPs subsystem state (field: `MCPS_PACKAGES` — space-separated active MCP names; seeded from registry defaults on first use)
- `~/.opencode-vm/proxmox.env` — Proxmox MCP credentials (mode 0600; only when Proxmox MCP is enabled)
- `~/.opencode-vm/proxmox-mcp/` — host-side clone of ProxmoxMCP (only when Proxmox MCP is enabled)

**Extensions split into two subsystems (since v0.4.4):** `skills/` is for knowledge packages (pure markdown mounted as agent context); `mcps/` is for Model Context Protocol servers (tools the agent can call). Two separate registries, two separate CLIs, two separate state files. The distinction is deliberate: skills and MCPs have different lifecycles, different token-cost curves, and different security surfaces (credentials apply only to MCPs). A unified abstraction was rejected as perpetuating the debt of conflating "context" with "capability".

**ECC integration (implicit, driven by skills):** ECC is implicit infrastructure activated by any `ecc-*` skill package. `skills_pkg_on ecc-auto` / `ecc-all` auto-clones [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) into `~/.opencode-vm/ecc/` on first enable and sets `ECC_ENABLED=1`. `skills_pkg_off` flips `ECC_ENABLED=0` once no `ecc-*` package is active anymore. When enabled, `start_session` copies the `.opencode/` payload, seeds the per-project homunculus store, links it into the VM, and auto-injects per-language rule sets. `CLAUDE_PROJECT_DIR` is exported to the host project path. All ECC code paths remain gated on `ECC_ENABLED=1`.

**Skills subsystem (registry-driven since v0.4.5):** `opencode-vm skills {status|on|off|list}` is the CLI. Source of truth is [`skills/registry.json`](skills/registry.json) — declares each package with a `resolver` type (`single_bundled`, `ecc_filtered`, `ecc_all`), `default_active` / `always_active` flags, `mutually_exclusive_with` list, and (for ECC-style packages) filter data (universal_whitelist, language_prefixes, exclude). Three packages today: `webimg` (always-active built-in — image-optimization CLI tools pre-installed in base VM), `ecc-auto` (language-filtered ~30 skills, mutually exclusive with ecc-all), `ecc-all` (~180 skills, heavy). Resolver functions (`skills_resolve_ecc_filtered`, `skills_resolve_ecc_all_pkg`, `skills_resolve_single_bundled`) all read filter data from the registry — no hardcoded whitelists in the script. `skills_resolve_pkg <pkg> <langs>` is the generic dispatch used by `skills_mount_for_session`, `doctor`, and the CLI. State: `~/.opencode-vm/skills.env` (`SKILLS_PACKAGES`). Legacy `proxmox` in state is silently stripped on load (was migrated to MCPs in v0.4.4).

**MCPs subsystem (registry-driven since v0.4.3):** `opencode-vm mcps {status|list|on|off|purge}` is the CLI. Source of truth is [`mcps/registry.json`](mcps/registry.json) — declares each MCP with `default_active`, `mcp_config` (type, command, optional `environment_from_credentials`), `credential_schema` (field/prompt/secret/required/default per field), `install` info (bundled/git), optional `skill_doc` path (for companion knowledge docs), and optional `agents_md_snippet` (since v0.4.12: `{source: "inline", content: ...}` or `{source: "file", path: ...}` — markdown auto-appended to the session AGENTS.md when this MCP is active). Four MCPs today: `playwright` (default on, bundled), `repomapper` (default off, bundled), `graphify` (default off, bundled via pipx — code knowledge-graph from [safishamsi/graphify](https://github.com/safishamsi/graphify); per-project graph persisted at `~/.opencode-vm/project-state/<hash>/graphify/graph.json`, MCP server is read-only and makes zero LLM calls; **mcrepo auto-activation since v0.4.19** — when `mcrepo.yaml` is at the project root, `start_session` exports `MCPS_FORCE_ON=graphify` / `MCPS_FORCE_OFF=repomapper` (session-only, never persisted), redirects `{GRAPH_PATH}` to `<workspace>/docs/graphify/graph.json` via a `<workspace>/.graphify-out` symlink — graphifyy 0.4.x hardcodes the output dir relative to the project (in-VM install is sed-patched at base-image build time to write to `.graphify-out` instead of upstream's `graphify-out`, so the entry stays hidden alongside `.playwright-mcp` etc.; existing `graphify-out` symlinks are auto-migrated on next session start) — and spawns `graphify watch` in the session VM so the graph rebuilds incrementally during the session; the graph plus a `GRAPH_REPORT.md` summary live committed in the mcrepo's docs folder so they ship with the rest of the documentation; the `_mcps_resolve_snippet` helper picks an mcrepo-specific `agents_md_snippet.path_mcrepo` variant when present, so the agent gets mcrepo-tailored guidance), `proxmox` (default off, interactive credential prompt, clones [canvrno/ProxmoxMCP](https://github.com/canvrno/ProxmoxMCP) host-side, installs Python venv in base VM on first session, mounts companion SKILL.md). Session injection is fully data-driven: `mcps_build_config_json <vm_home> <sess_share> <proj>` iterates `MCPS_PACKAGES`, reads `mcp_config` from registry, substitutes placeholder tokens via `_mcps_substitute_tokens` (`{VM_HOME}`, `{PROJ_HASH}`, `{SESS_SHARE}`, `{GRAPH_PATH}`), materializes credentials for MCPs with `environment_from_credentials: true`, and returns a ready-to-merge `mcp` object for `opencode.json`. `mcps_mount_skill_docs_for_session` mounts any `skill_doc` directories from active MCPs. `mcps_build_agents_sidecar <sess_share> <vm_home> <proj>` (since v0.4.12) writes `AGENTS.mcps.md` from active MCPs' `agents_md_snippet` declarations — VM-side AGENTS.md composition cats it after the Host LAN IP block and before any ECC rules sidecar. Default-active MCPs are seeded into `~/.opencode-vm/mcps.env` on first use. `mcps off <name>` wipes credentials for MCPs that have them (Proxmox); `mcps purge <name>` wipes per-project cached state (graphify graph today; extensible).

**Script structure (top to bottom):**
1. Constants and defaults (top of file)
2. Self-update metadata: `OCVM_VERSION`, `OCVM_UPDATE_REPO`, etc.
3. Utility functions: `need`, `ensure_dirs`, path helpers, cfg/data sync helpers, `pick_host_cfg`, `backup_host_cfg`
4. Policy management: `ensure_policy_file`, `load_policy`, `save_policy` + `list_has`/`list_add`/`list_rm`
5. ECC infrastructure: `ecc_load`/`ecc_save`, clone, `ecc_apply_to_session`, homunculus, rules-injection
6. Proxmox helpers: `proxmox_load`/`save`/`setup_interactive`/`mcp_clone_or_update`/`ensure_installed_in_base`/`skill_ensure` — all infrastructure; triggered by the MCPs subsystem
7. Skills subsystem (registry-driven): `_skills_registry_path/read/ensure`, `skills_registry_has/field/list/always_active`, `skills_load/save/pkg_is_active/pkg_on/pkg_off`, resolvers (`skills_resolve_ecc_filtered`, `skills_resolve_ecc_all_pkg`, `skills_resolve_single_bundled`, generic `skills_resolve_pkg`), `skills_mount_for_session`
8. MCPs subsystem (registry-driven): `_mcps_registry_path/read/ensure`, `mcps_registry_has/defaults/list`, `mcps_load/save/pkg_is_active/pkg_on/pkg_off`, `mcps_build_config_json`, `mcps_mount_skill_docs_for_session`, `mcps_cmd`
9. Self-update helpers + commands: `update_cmd`, `export_patch_cmd`, `ocvm_post_update_migrate`
10. `ports_cmd` — CLI subcommand for managing firewall policy
11. `provision_base` — creates base VM, installs OpenCode + nftables + Playwright + RepoMapper + all CLI tooling
12. `apply_policy_in_vm` — translates `policy.env` into nft commands
13. `start_session` — main workflow: backup config → host/project sync → clone → mount → apply policy → inject MCPs → mount skill docs → run opencode → cleanup+sync-back
14. `doctor_cmd` / `skills_cmd` / top-level `case` dispatch

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
- Shell scripts authored or modified in a session should be validated with `shellcheck` (pre-installed in the base VM). Focus on the lines you changed — do **not** mass-fix unrelated warnings in the rest of the file unless the user asked for a cleanup pass. If `shellcheck` surfaces a **critical** pre-existing issue outside your change (e.g. SC2086 in a security-sensitive context, SC2068 around argument passing, an unquoted `rm`/`eval`), flag it in the final report and let the user decide whether to fix it now, defer it, or accept it — never silently rewrite it.
