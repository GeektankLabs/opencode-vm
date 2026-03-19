# opencode-vm

<sub><em>Run OpenCode inside an isolated Lima VM on macOS while keeping your normal host workflow (VS Code, Git, project files) fast and local. Maximum freedom for the AI agent (YOLO mode) — minimal risk for your personal development environment.</em></sub>

![Placeholder: add screenshot of OpenCode running in VM](opencode-vm.png)


## Why this project?

OpenCode runs in a VM, not directly on host.

- System Isolation 
    - You share just project files, not your personal system & user space.
    - OpenCode cannot commit to git, so you have final control over your project files.

- Network Isolation
    - The AI can access the internet to load rescources and research.
    - Not your host or local network (except for chosen ports).

- Familiar workflow
    - Start Opencode-VM in a terminal in VisualStudio Code with `opencode-vm start`
    - Let the AI start up docker containers in the VM on host ports (localhost:port)

## Requirements

- macOS (Apple Silicon recommended)
- [Homebrew](https://brew.sh)

## Quick Start

1) Install opencode-vm (installs Lima automatically if Homebrew is available):

```bash
curl -fsSL https://raw.githubusercontent.com/GeektankLabs/opencode-vm/main/opencode-vm.sh -o opencode-vm.sh && bash opencode-vm.sh install
```

2) Reload your shell (if prompted by the installer):

```bash
source ~/.zshrc
```

3) Create the base VM (one-time):

```bash
opencode-vm init
```

4) Start from any project directory:

```bash
cd /path/to/project
opencode-vm start
```

or simply in your VS Code open terminal and type `opencode-vm start`

## Best Practices

The VM can run docker. So your AI agent can now start up your project in a docker container and run any tests and debug on it.

## Daily Usage

- See all the options:

```bash
opencode-vm
```

- Open additional shell into running project session:

```bash
opencode-vm shell
```

If no session is running yet, `opencode-vm shell` now starts a fresh session automatically and opens the shell directly.

- Stop/clean old sessions:

```bash
opencode-vm prune
```

## Web Mode

Instead of running OpenCode as a terminal TUI inside the VM, you can start it as a web server. This gives you browser-based access — including from your phone or tablet on the same network.

```bash
opencode-vm web
```

This starts OpenCode's web server inside the VM and prints connection URLs using your host's local IP address. By default it uses port 4096.

What you get from a single command:

- **Web UI** — full OpenCode interface in your browser
- **REST API** — programmatic access with OpenAPI docs at `/doc`
- **TUI attach** — connect a terminal TUI from the host via `opencode attach http://<ip>:4096`

All clients share the same sessions and state, so you can switch between browser and terminal seamlessly.

Options:

```bash
opencode-vm web --port 3000         # use a custom port
opencode-vm web --password secret   # set a server password
opencode-vm web --tui               # also start TUI in terminal (experimental)
```

The `--tui` flag starts the web server in the background, then lets you press Enter to launch a terminal TUI that connects to the same server — giving you both interfaces at once.

## Config & State Sync (important)

This project syncs OpenCode user data between local host and VM sessions, including:
- config (`~/.config/opencode/...`),
- data (`~/.local/share/opencode/...`),
- state (`~/.local/state/opencode/...`, e.g. model recents/favorites).

Result: model selection/favorites and related preferences persist across:
- local OpenCode ↔ VM sessions,
- repeated VM sessions.

First run without a local OpenCode setup is supported — missing host directories are created automatically.

You can inspect synced provider/auth/model/database state at any time:

```bash
opencode-vm doctor
```

This reports, among other things:
- providers connected via `/connect` (from `auth.json`),
- recent/favorite provider+model selections (from `model.json`),
- provider usage markers found in `opencode.db` message metadata.

## Provider Commands

Provider management is a first-class top-level command — no `doctor` prefix needed:

```bash
opencode-vm provider list
opencode-vm provider new                 # interactive wizard
opencode-vm provider rm <provider-id> [--dry-run]
```

**Model discovery:** When no `--model` flags are given, `provider add` automatically calls the `/models` endpoint and adds all returned models. If the endpoint is unreachable or returns no models, the provider is **not** added. Pass `--model` flags explicitly to skip auto-discovery. Where available (e.g. LM Studio), the context window size is read from the API and stored automatically.

**`--model` flag** (repeatable) — `id[:name[:context_tokens]]`:
- `--model gpt-4o` — ID and display name both `gpt-4o`, no context limit stored
- `--model gpt-4o:GPT-4o` — ID `gpt-4o`, display name `GPT-4o`
- `--model gpt-4o:GPT-4o:128000` — additionally stores context window of 128k tokens

**`--vision` flag** — marks all models of this provider as supporting image/vision input. This enables the image upload button in OpenCode and allows sending screenshots or images to the model. Required for Playwright/screenshot workflows. The interactive wizard (`provider new`) will ask about this.

**`--reasoning` flag** — enables extended reasoning/thinking for all models (`options.thinking.type: "enabled", budgetTokens: 8192`). OpenCode gates reasoning behavior based on this flag — without it, the model will not use extended thinking even if it supports it. The wizard will ask about this.

> **Note on missing context (`Kontextlimit 0`):** A context limit of 0 means OpenCode skips compaction and overflow protection entirely. For long sessions this can cause API errors when the model's real context window is exceeded. Always set a context limit, either via auto-discovery or `--model id:name:TOKENS`.

**Real world examples:**

```bash
# 1) Fully interactive wizard (prompts for ID, URL, key, name, then auto-discovers models)
opencode-vm provider new

# 2) Local LM Studio — auto-discovers models from http://localhost:1234/v1/models
opencode-vm provider add lmstudio-local \
    --base-url http://localhost:1234/v1 \
    --api-key local \
    --name "LM Studio (host local)"

# 3) Local Ollama — auto-discovers models from http://localhost:11434/v1/models
opencode-vm provider add ollama-local \
    --base-url http://localhost:11434/v1 \
    --api-key local \
    --name "Ollama (host local)"

# 4) OpenRouter — auto-discovers all available models
opencode-vm provider add openrouter-custom \
    --base-url https://openrouter.ai/api/v1 \
    --api-key sk-or-v1-xxxx \
    --name "OpenRouter"

# 5) Self-hosted gateway with explicit model list + context limits + vision
opencode-vm provider add ai-gateway \
    --base-url https://ai.example.com/v1 \
    --api-key your-token \
    --name "Company AI Gateway" \
    --model "llama-3.1-70b:Llama 3.1 70B:131072" \
    --model "mistral-7b:Mistral 7B:32768" \
    --vision

# 6) Safe preview first (auto-discovers but writes nothing)
opencode-vm provider add myprovider \
    --base-url https://api.example.com/v1 \
    --api-key test-key \
    --dry-run

# 7) Remove a provider (cleans auth, config, model state, db metadata)
opencode-vm provider rm lmstudio-local --dry-run
opencode-vm provider rm lmstudio-local
```

After adding/updating a provider, restart the session so OpenCode reloads config/auth:

```bash
opencode-vm prune
opencode-vm start
```

Backups are created in `~/.opencode-vm/backups/provider-<timestamp>/` before each change.

## Network Policy Commands

Basic policy is: Your laptop can call the VM, but your VM can only call selected ports on your laptop .. for example to call Ollama or LMStudio.

By default, host ports `1234` (LM Studio) and `11434` (Ollama) are allowed and automatically forwarded inside the VM to `localhost`. That means these work inside the VM without extra setup:

```bash
curl http://localhost:1234/v1/models
curl http://localhost:11434/api/tags
```

Direct host access still works via `host.lima.internal`.

Show policy:

```bash
opencode-vm ports show
```

Allow additional host ports from VM:

```bash
opencode-vm ports host add 8080
```

Control localhost forwarding behavior:

```bash
opencode-vm ports hostfwd show
opencode-vm ports hostfwd enable
opencode-vm ports hostfwd disable
```

Allow specific LAN target from VM:

```bash
opencode-vm ports lan tcp add 192.168.178.10:443
```

If a docker container within the VM exposes a port its reachable from your laptops with: `localhost:[PORT]`

## Contributing

### Submitting Changes

After making local improvements to the script, generate a patch submission for upstream:

```bash
opencode-vm create-patch "short description of your change"
```

This fetches the current upstream script, computes a diff of your local changes (using intent-based 3-way merge by default), and outputs a ready-to-submit GitHub issue template. You can also use `--strategy=legacy` for a direct diff, or `export-patch` as an alias.

### Developer Setup

For active development on this project, clone the repository and symlink the script so changes are immediately reflected:

```bash
git clone https://github.com/GeektankLabs/opencode-vm.git
cd opencode-vm
mkdir -p "$HOME/bin"
rm -f "$HOME/bin/opencode-vm"
ln -sf "$PWD/opencode-vm.sh" "$HOME/bin/opencode-vm"
chmod +x "$HOME/bin/opencode-vm"
```

This creates a symbolic link from your `~/bin` directory to the script in your working copy, allowing you to edit and test changes without reinstalling.

#### Add `~/bin` to your PATH

If `opencode-vm` is not found after symlinking, make sure your local `~/bin` is in your shell `PATH`.

For macOS default shell (`zsh`):

```bash
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

For `bash`:

```bash
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Optional: if you prefer to hide the update-available hint on each command, set `OCVM_DISABLE_UPDATE_CHECK=1`. If you want updates and patch generation to use a different upstream, set `OCVM_UPDATE_URL`.

## Useful Commands

```bash
opencode-vm install      # install/update script to ~/bin
opencode-vm init         # create/recreate base VM
opencode-vm start        # start TUI session (same as opencode-vm run)
opencode-vm web          # start web server session (browser, API, TUI attach)
opencode-vm shell        # shell into session VM (auto-starts if none is running)
opencode-vm base         # shell into base VM
opencode-vm prune        # cleanup sessions, keep base
opencode-vm ports show   # show host/LAN policy and localhost-forwarding status
opencode-vm doctor       # inspect synced local auth/model/db state
opencode-vm doctor provider list
opencode-vm doctor provider add <id> --base-url <url> --api-key <key> [--name "Display Name"] [--dry-run]
opencode-vm doctor provider rm <id> [--dry-run]
opencode-vm update       # update script from upstream
opencode-vm create-patch # generate a patch submission for upstream
```

To update OpenCode or system packages in the base VM, simply re-run `opencode-vm init`.
To update the opencode-vm script itself, run `opencode-vm update`.

## Best Practices (short)

- Run `opencode-vm` from the project root.
- Keep one active VM session per project directory.
- Re-run `opencode-vm init` to update OpenCode or system packages in the base VM.
- Keep your OpenCode provider endpoints stable (e.g. LM Studio/Ollama host ports).

## Desktop Share Directory

You can share files with the VM by creating a folder called `opencode-share` on your macOS Desktop:

```bash
mkdir ~/Desktop/opencode-share
```

When this folder exists at session start, it is automatically mounted into the VM at the same path. This is useful for quickly sharing screenshots, images, PDFs, or any other files that OpenCode should be able to access or work with — without placing them in your project repository.

If you need OpenCode to process a file (e.g. "describe this screenshot"), just drop it into `~/Desktop/opencode-share` and reference the path in your prompt. If you don't need this feature, simply don't create the folder — nothing changes.

## License

[MIT](LICENSE)
