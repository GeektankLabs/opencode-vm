# Project web editor

Since script **0.5.69**, code-server **4.139.1** can accompany web sessions; since **0.5.71** it starts by default. It opens the same mounted project as OpenCode and the host IDE. No project copy or file-transfer extension is required.

## Start and reconnect

Run on the Mac host, in the project directory:

```bash
opencode-vm web
opencode-vm attach
opencode-vm web --no-editor
opencode-vm web --reconnect --editor
```

Web sessions start the editor by default, including reconnecting an older session that has no explicit opt-out. `--no-editor` disables it for the session and that choice is retained by reconnect/attach; `--editor` re-enables it. Fresh web sessions start with the editor again. Switching to a terminal session stops the editor. Its URL appears under **Project editor** in the console service listing after local readiness; startup failures are shown explicitly while OpenCode continues.

The editor uses HTTPS on **P+4**: with an available default base of `4096`, the editor is on `https://<host-ip>:4100`. The host reserves all five public forwards in one SSH process. Collisions move the entire block through the same incrementing base-port search. Browser-blocked ports, the reserved incoming MCP port and an occupied guest editor port are skipped. A failed LAN tunnel is reported and the banner switches to the host-loopback fallback. Real host reachability still depends on Lima forwarding.

The first enabled fresh start installs the SHA-256-pinned ARM64/AMD64 release in the base VM before cloning. Reconnecting an older VM installs it there if needed. Editor installation and startup failures do not stop OpenCode. An owned transient systemd service runs code-server, extensions and terminals under the existing sandbox profile. Reconnect/finalization stops the whole service control group, including its terminals.

## Login and self-signed HTTPS

The editor reuses the web session's password. Its login page asks for **only the password**, not the Web UI's Basic-auth username. `--no-auth` deliberately disables authentication for both. The incoming MCP token is separate. Editor HTTPS stays enabled even when the OpenCode web listener uses `--no-tls`.

The certificate is the existing session certificate at:

```text
~/.opencode-vm/sessions/<project-hash>/tls/cert.pem
```

On first browser access, a self-signed certificate warning is expected. **Webviews, including Markdown preview, require actual certificate trust. Clicking through the warning alone is insufficient in Chrome** because service-worker registration still rejects the certificate. File upload/download, ordinary editing, Git, terminal and text Output channels work with the browser exception in the tested Chrome build.

For full functionality on macOS, open that project's `cert.pem` in Keychain Access, import it into the login keychain, and explicitly trust it for SSL. Restart the browser if needed. On another client device, import the same public certificate using that device/browser's certificate settings. Only distribute `cert.pem`; `key.pem` is the server's private key. A fresh session or changed host IP can generate a different certificate, requiring a new trust decision. No certificate is automatically added to host trust stores.

## Baseline

- Explorer, search/replace, tabs, split editors, comparisons, syntax highlighting and built-in Markdown preview.
- Built-in local Git: diffs, staging, commits, branches and merge editing. Automatic fetch and publish/sync action buttons are disabled. The existing no-origin-access boundary still applies.
- Upload through a folder's **Upload…** action or drag-and-drop into the Explorer. Download through **Download…**. Direct directory transfers depend on browser support; archives transfer as ordinary files.
- Terminal in the project VM, sharing its tools and working tree.
- Dark Modern as the default theme (also added to older generated profiles without a theme choice); an explicitly selected theme is preserved. Manual saving, no startup welcome page, AI features disabled and extension recommendations/automatic extension updates disabled in the initial profile. Ordinary built-in Run/Debug and Extensions views remain available through VS Code's normal UI.

The single added extension is the embedded `ocvm.project-tools`. Use **F1 → opencode-vm** for its commands, or click **VM** in the status bar. The lower panel remains closed until requested; the normal **Terminal**, **Output** and **Problems** tabs are available. Problems means language/file diagnostics, not service health.

## Status and logs

Select a channel in **Output**, or open it through the command palette:

- **opencode-vm: Status**: timestamped, explicitly refreshed VM uptime, memory, free project-disk space, local TCP reachability and tunnel service state. TCP reachability does not prove authentication, backend health or external-client connectivity.
- **MCP: Communication**: existing `mcp/adapter.log`, including adapter 0.1.5's correlated tool-call start/end, duration and error-code records. It observes the incoming connector used by external clients, not OpenCode's outgoing extension MCPs. A successful `send_message` call means admission; agent completion is separate.
- **OpenCode: Activity**: the latest 200 stored metadata events from the existing activity journal. Events can originate through multiple frontends; this is not a claim of MCP origin. Epoch and bounded/downtime coverage are explicit. With MCP disabled, activity collection is unavailable.
- **MCP: Tunnel**: retained `mcp/tunnel.log`, when available.
- **opencode-vm: Editor**: the editor's service log.

Log views refresh every two seconds, read at most the latest 128 KiB per text log, and handle rotation/truncation. They can contain entries from before a reconnect. The extension does not create a second activity collector or call the MCP tools itself. Tool-call diagnostics record known metadata only: no prompt/answer bodies, credentials, references, cursors, arbitrary tool names or raw exceptions. Existing logs remain session-scoped.

## State and file lifetime

The editor's `user-data/User` directory is copied to `~/.opencode-vm/project-state/<hash>/editor/user-data/User` during controlled finalization and restored for fresh enabled sessions. Existing settings are preserved; defaults are written only for a new profile. The editor never writes baseline settings into the project's `.vscode` directory. Extra extensions installed manually are session-local in this first version.

Files uploaded or saved into the mounted project persist on the host immediately, including local commits and branch changes. Downloads go to the device running the browser. Files created only in the VM follow its ephemeral lifetime. A file readable by OpenCode is also available to the agent; placing a credential in a file avoids sending it as a chat message but does not create agent-private storage.

## Validation

Automated checks:

```bash
python3 -B tests/web_editor_test.py
node --test tests/web_editor_extension_test.cjs
# Linux VM with systemd and the existing sandbox profile:
OCVM_EDITOR_INTEGRATION=1 python3 -B tests/web_editor_test.py EditorTest.test_real_editor
```

The first suite exercises flags/tracking, host and guest port collisions, private MCP overlap, browser port exclusions, range limits, embedded payload syntax, preferences and service ownership. The Node test exercises bounded log reads, rotation, project-bound metadata and extension commands. The opt-in integration uses the actual pinned binary and systemd unit; it does not start a second OpenCode or require model credentials.

Local ARM64 VM/Chrome evidence (2026-09-27): pinned download/checksum, HTTPS startup/restart, profile preservation, password login and explicit no-auth, HTTPS retained with web TLS disabled, browser upload/download with identical UTF-8 content, Explorer/Git staging and a local commit in a disposable project, project terminal and VM status Output. Stopping the service removed its entire control group, including the browser-opened terminal. The Markdown webview certificate-trust requirement was reproduced. Full macOS/Lima acceptance remains: concurrent projects with shifted ports, host/LAN reachability, keep/attach/fresh transitions and a trusted-certificate Markdown preview on the user's browser.
