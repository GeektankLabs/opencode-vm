## Browser Automation (MCP: `playwright`)

Playwright MCP is available as a tool for headless browser automation. Use it for:
- Testing UI flows end-to-end (navigation, form submission, clicking)
- Taking screenshots to verify visual state
- Inspecting page content and accessibility trees
- Debugging frontend issues by interacting with the running application

Start a dev server first (e.g. `npm run dev`), then use the Playwright tools to navigate to `http://localhost:<port>` and interact with the UI.

**Important:** Chrome for Testing is **already pre-installed** as an ARM64-native binary, bundled with the Playwright MCP. Everything is configured and works out of the box. Do **NOT** run `npx playwright install` or `playwright-mcp install-browser` — just use the MCP tools directly.

Pre-installed paths (do not change):
- MCP server binary: `~/.local/bin/playwright-mcp` (stable symlink, works with any NVM Node version)
- Browser cache:     `~/.cache/ms-playwright/chromium-<rev>/chrome-linux/chrome`
                     `~/.cache/ms-playwright/chromium_headless_shell-<rev>/chrome-linux/headless_shell`
                     (`<rev>` floats with the bundled Playwright MCP version)

There is no Chrome at `/opt/google/chrome/` — ignore that path. The bundled Chrome for Testing above is used automatically by the MCP tools (`browser_navigate`, `browser_click`, `browser_screenshot`, etc.).
