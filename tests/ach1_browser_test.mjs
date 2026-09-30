// Run with PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/ach1_browser_test.mjs.
// Disposable fixture only; no live project/session or connector mutation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = spawn("python3", ["-B", "tests/ach1_browser_fixture.py"], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: "." }, stdio: ["ignore", "pipe", "inherit"] });
const lines = createInterface({ input: fixture.stdout });
const [line] = await once(lines, "line"); const { port, project } = JSON.parse(line);
const base = `http://127.0.0.1:${port}`;
let browser;
const tuple = { provider_id: "fixture", model_id: "family/model", variant: "high" };
try {
  for (const [name, engine] of [[process.env.BROWSER || "chromium", process.env.BROWSER === "webkit" ? webkit : chromium]]) {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(base); await page.waitForSelector("#profile-review");
    assert.deepEqual(await page.locator("section[id]").evaluateAll(items => items.map(i => i.id)), ["profiles", "connections-section", "logs"]);
    assert.equal(await page.locator(".profile-card").count(), 5);
    assert.equal(await page.locator(".connection-card").count(), 4);
    assert.equal(await page.locator("#notices, #tabs, #show-logs").count(), 0);
    const contrast = await page.evaluate(() => {
      const luminance = c => c.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
      const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
      const rgb = value => value.match(/\d+/g).slice(0, 3).map(Number);
      const style = selector => getComputedStyle(document.querySelector(selector));
      const panel = [23, 32, 43]; // Brightest endpoint of the existing dark panel gradient (conservative).
      return { text: ratio(rgb(style(".profile-summary").color), panel), muted: ratio(rgb(style(".profile-effective").color), panel),
        link: ratio(rgb(style("summary").color), panel), border: ratio(rgb(style("select").borderColor), panel) };
    });
    for (const key of ["text", "muted", "link"]) assert.ok(contrast[key] >= 4.5, `${name} ${key} contrast ${contrast[key]}`);
    assert.ok(contrast.border >= 3, `${name} control boundary ${contrast.border}`);
    for (const role of ["deep", "standard", "design", "review"]) await page.locator(`#profile-${role} .profile-editor summary`).click();
    const select = async (role, variant = "high", model = "family/model") => {
      await page.locator(`#${role}-provider_id`).selectOption("fixture");
      await page.locator(`#${role}-model_id`).selectOption(model);
      await page.locator(`#${role}-variant`).selectOption(variant);
    };
    const save = role => page.locator(`#profile-${role} button[type=submit]`).click();
    await save("deep"); await page.locator("#profile-deep .error-summary").waitFor({ state: "visible" });
    assert.equal(await page.locator("#profile-deep .error-summary").evaluate(e => e === document.activeElement), true);
    await page.locator("#profile-deep .error-summary a").first().click();
    assert.equal(await page.locator("#deep-provider_id").evaluate(e => e === document.activeElement), true);
    await select("deep"); await select("standard", "default");
    await page.locator("#standard-variant").focus();
    // Programmatic submit keeps another draft's focused element through the response.
    await page.locator("#profile-deep form").evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("#profile-deep .profile-feedback").textContent.includes("gespeichert · Revision"));
    assert.equal(await page.locator("#standard-variant").inputValue(), "default");
    assert.equal(await page.locator("#standard-variant").evaluate(e => e === document.activeElement), true);
    await page.locator("#refresh-control").evaluate(e => e.click());
    await page.waitForFunction(() => document.querySelector("#control-status").textContent.includes("Revision"));
    assert.equal(await page.locator("#standard-variant").inputValue(), "default");
    assert.equal(await page.locator("#standard-variant").evaluate(e => e === document.activeElement), true);
    // GET errors preserve policy/drafts/focus; incomplete catalog keeps clear possible.
    await page.route("**/api/control", route => route.fulfill({ status: 503, body: "offline" }));
    await page.locator("#refresh-control").evaluate(e => e.click());
    await page.waitForFunction(() => document.querySelector("#control-status").textContent.includes("Letzte bekannte"));
    assert.equal(await page.locator("#standard-variant").inputValue(), "default");
    await page.unroute("**/api/control");
    await page.locator("#refresh-control").click();
    await page.waitForFunction(() => !document.querySelector("#control-status").textContent.includes("Letzte bekannte"));
    await select("design"); assert.match(await page.locator("#design-hint").innerText(), /Format 2 erweitert/);
    await save("design"); await page.waitForFunction(() => document.querySelector("#profile-design .profile-feedback").textContent.includes("gespeichert · Revision"));
    assert.equal(JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`)).schemaVersion, 2);
    assert.equal(JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.schema1-rev1.backup.json`)).schemaVersion, 1);
    // Concurrent tab changes deep; dirty draft stays and a deliberate comparison is required.
    const response = await page.request.get(`${base}/api/control`); const current = await response.json();
    await select("deep", "default");
    await page.request.put(`${base}/api/control/profiles/deep`, { headers: { Origin: base }, data: { revision: current.policy.revision, selection: { ...tuple, variant: "default" } } });
    await save("deep"); await page.waitForFunction(() => document.querySelector("#profile-deep .profile-feedback").textContent.includes("anderweitig"));
    assert.equal(await page.locator("#deep-variant").inputValue(), "default");
    await page.getByRole("button", { name: "Aktuellen Stand vergleichen", exact: true }).first().click();
    await page.getByRole("button", { name: "Entwurf nach Abgleich freigeben", exact: true }).first().click();
    await save("deep"); await page.waitForFunction(() => document.querySelector("#profile-deep .profile-feedback").textContent.includes("gespeichert · Revision"));
    // Unknown save: accepted PUT + lost response, and unaccepted PUT + lost response.
    for (const accepted of [true, false]) {
      await select("review", accepted ? "high" : "default");
      let writes = 0;
      await page.route("**/api/control/profiles/review", async route => { writes++; if (accepted) await route.fetch(); await route.abort("failed"); });
      await save("review"); await page.waitForFunction(() => document.querySelector("#profile-review .profile-feedback").textContent.includes("nicht bestätigt"));
      assert.equal(writes, 1); assert.equal(await page.locator("#profile-standard button[type=submit]").isDisabled(), true);
      if (accepted) await page.route("**/api/control", async route => {
        const r = await route.fetch(), value = await r.json(), stored = value.policy.profiles.review;
        value.policy.profiles.review = { variant: stored.variant, model_id: stored.model_id, provider_id: stored.provider_id };
        await route.fulfill({ json: value });
      });
      await page.getByRole("button", { name: "Speicherstand zurücklesen" }).click();
      await page.waitForFunction(() => !document.querySelector("#profile-review .profile-feedback").textContent.includes("automatischer"));
      assert.equal(writes, 1);
      if (!accepted) {
        assert.equal(await page.locator("#review-variant").inputValue(), "default");
        await page.locator("#profile-review").getByRole("button", { name: "Entwurf nach Abgleich freigeben", exact: true }).click();
      } else assert.match(await page.locator("#profile-review .profile-feedback").innerText(), /Urheberschaft nicht bewiesen/);
      if (accepted) await page.unroute("**/api/control");
      await page.unroute("**/api/control/profiles/review");
    }
    // Explicit server refusals: 422, 503, non-JSON and format conflict preserve draft.
    for (const [status, body] of [[422, { code: "SELECTION_UNAVAILABLE", reason: "variant_unavailable" }], [503, { code: "CATALOG_UNAVAILABLE" }]]) {
      await page.route("**/api/control/profiles/standard", route => route.fulfill({ status, json: body }));
      await save("standard"); await page.waitForFunction(() => document.querySelector("#profile-standard .profile-feedback").textContent.includes("nicht gespeichert") || document.querySelector("#profile-standard .profile-feedback").textContent.includes("Nicht gespeichert"));
      assert.equal(await page.locator("#standard-variant").inputValue(), "default"); await page.unroute("**/api/control/profiles/standard");
    }
    // Slow save serializes writes while the other profile remains editable.
    let release, admit; const held = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { admit = resolve; });
    await page.route("**/api/control/profiles/deep", async route => { admit(); await held; await route.continue(); });
    await select("deep", "high"); await save("deep"); await started;
    assert.equal(await page.locator("#deep-variant").isDisabled(), true);
    assert.equal(await page.locator("#standard-variant").isEnabled(), true);
    assert.equal(await page.locator("#profile-standard button[type=submit]").isDisabled(), true);
    await page.locator("#standard-variant").selectOption("high"); release();
    await page.waitForFunction(() => document.querySelector("#profile-deep .profile-feedback").textContent.includes("gespeichert · Revision"));
    assert.equal(await page.locator("#standard-variant").inputValue(), "high");
    await page.unroute("**/api/control/profiles/deep");
    // Non-JSON PUT error is uncertain. Failed readback leaves all writes blocked.
    await page.route("**/api/control/profiles/standard", route => route.fulfill({ status: 500, body: "<html>Unknown service failure</html>" }));
    await save("standard"); await page.waitForFunction(() => document.querySelector("#profile-standard .profile-feedback").textContent.includes("nicht bestätigt"));
    await page.route("**/api/control", route => route.fulfill({ status: 503, body: "offline" }));
    await page.locator("#profile-standard").getByRole("button", { name: "Speicherstand zurücklesen" }).click();
    await page.waitForFunction(() => document.querySelector("#control-status").textContent.includes("Letzte bekannte"));
    assert.equal(await page.locator("#profile-deep button[type=submit]").isDisabled(), true);
    assert.equal(await page.locator("#standard-variant").inputValue(), "high");
    await page.unroute("**/api/control"); await page.unroute("**/api/control/profiles/standard");
    await page.locator("#profile-standard").getByRole("button", { name: "Speicherstand zurücklesen" }).click();
    await page.locator("#profile-standard").getByRole("button", { name: "Entwurf nach Abgleich freigeben" }).click();
    // Unsupported format differs from revision conflict, locks writes and keeps draft.
    await page.route("**/api/control/profiles/standard", route => route.fulfill({ status: 409, json: { code: "POLICY_FORMAT_UNSUPPORTED" } }));
    await save("standard"); await page.waitForFunction(() => document.querySelector("#profile-standard .profile-feedback").textContent.includes("Policyformat"));
    assert.equal(await page.locator("#profile-design button[type=submit]").isDisabled(), true);
    assert.equal(await page.locator("#standard-variant").inputValue(), "high");
    await page.unroute("**/api/control/profiles/standard");
    await page.locator("#refresh-control").click(); await page.waitForFunction(() => !document.querySelector("#profile-standard button[type=submit]").disabled);
    // Old/offline adapter leaves optional roles/fallbacks visible, but mapping saves blocked.
    await page.route("**/api/control", async route => { const r = await route.fetch(); const value = await r.json(); value.capabilities.optionalProfiles = false; await route.fulfill({ json: value }); });
    await page.locator("#refresh-control").click(); await page.waitForFunction(() => document.querySelector("#design-hint").textContent.includes("bestätigt Format 2 / Optionalprofile nicht"));
    assert.equal(await page.locator("#profile-design button[type=submit]").isDisabled(), true);
    assert.equal(await page.locator("#profile-review .profile-summary").isVisible(), true);
    assert.equal(await page.locator("#profile-review").getByRole("button", { name: "Eigene Zuordnung entfernen" }).isEnabled(), true);
    await page.unroute("**/api/control");
    // Catalog loss doesn't prevent clear; absence fallback becomes visible.
    await page.route("**/api/control", async route => { const r = await route.fetch(); const value = await r.json(); value.catalog = null; value.catalogStatus = "unavailable"; await route.fulfill({ json: value }); });
    await page.locator("#refresh-control").click(); await page.waitForFunction(() => document.querySelector("#control-status").textContent.includes("nicht verfügbar"));
    await page.locator("#profile-design").getByRole("button", { name: "Eigene Zuordnung entfernen" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-design .profile-feedback").textContent.includes("gespeichert · Revision"));
    assert.match(await page.locator("#profile-design .profile-effective").innerText(), /Design → Standard/);
    await page.unroute("**/api/control");
    await page.locator("#refresh-control").click();
    await page.waitForFunction(() => document.querySelector("#control-status").textContent.includes("geprüft"));
    const long = "family/long-" + "model-name-".repeat(15); await select("design", "high", long);
    // Four state labels/local help, source filter and disclosure/focus survive status refresh.
    await page.route("**/api/control", async route => {
      const r = await route.fetch(); const snapshot = await r.json(); const value = snapshot.readModel;
      value.integrations.forEach((item, i) => { item.state = ["not_configured", "unverified", "not_ready", "ready"][i]; item.configured = i !== 0; });
      value.events = [{ source: "incoming-mcp", severity: "info", message: "Bounded fixture event", timestamp: value.generatedAt }];
      value.security.allowedLogSources = ["incoming-mcp"]; await route.fulfill({ json: snapshot });
    });
    await page.locator("#refresh").click(); await page.waitForFunction(() => document.querySelector("#connection-openlive .badge").textContent.includes("lokal geprüft"));
    assert.match(await page.locator("#connection-incoming-mcp .badge").innerText(), /nicht bestätigt/);
    assert.match(await page.locator("#connection-a2a .badge").innerText(), /eingeschränkt/);
    await page.locator("#connection-incoming-mcp .log-link").click(); assert.equal(await page.locator("#log-source").inputValue(), "incoming-mcp");
    assert.match(await page.locator("#events").innerText(), /Bounded fixture event/);
    await page.locator("#connection-incoming-mcp .connection-help summary").focus();
    const open = await page.locator("#connection-incoming-mcp .connection-help").evaluate(e => e.open);
    await page.locator("#refresh").evaluate(e => e.click()); await page.waitForTimeout(100);
    assert.equal(await page.locator("#connection-incoming-mcp .connection-help").evaluate(e => e.open), open);
    assert.equal(await page.locator("#connection-incoming-mcp .connection-help summary").evaluate(e => e === document.activeElement), true);
    // Reflow, zoom equivalent, text resize, keyboard and target sizes on real DOM.
    for (const width of [1280, 700, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) console.log(await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll("*")].filter(e => e.scrollWidth>e.clientWidth+2).map(e=>[e.tagName,e.id,e.className,e.scrollWidth,e.clientWidth]).slice(-15)})));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} ${width}px overflow`);
    }
    await page.addStyleTag({ content: "html{font-size:200%} p,button,summary,label,select{font-size:1rem!important}" });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) console.log(await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll("*")].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>[e.tagName,e.id,e.className,e.scrollWidth,e.clientWidth]).slice(-15)})));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} text resize overflow`);
    await page.locator("#design-provider_id").focus(); await page.keyboard.press("Tab");
    assert.equal(await page.locator("#design-model_id").evaluate(e => e === document.activeElement), true);
    assert.equal(await page.locator("#profile-design button[type=submit]").evaluate(e => e.getBoundingClientRect().height >= 44), true);
    assert.deepEqual(errors, []);
    await browser.close(); browser = null;
    console.log(`PASS ${name}: IA, validation/focus, drafts, refresh/error, migration, conflict, lost-response recovery, clear/fallback, reflow, keyboard`);
  }
} finally { if (browser) await browser.close(); fixture.kill("SIGTERM"); lines.close(); }
