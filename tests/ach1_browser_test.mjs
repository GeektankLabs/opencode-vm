// Run with PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/ach1_browser_test.mjs.
// Disposable fixture only; no live project/session or connector mutation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readdir, readFile } from "node:fs/promises";
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
    assert.deepEqual(await page.locator("section[id]").evaluateAll(items => items.map(i => i.id)), ["profiles", "connections-section", "monitors", "logs"]);
    assert.equal(await page.locator(".profile-card").count(), 5);
    assert.equal(await page.locator(".fallback-card").count(), 1);
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
    // Final error fallback: schema 3 upgrade with backup, readback, explicit refusal and reset.
    assert.match(await page.locator("#profile-final-fallback .profile-summary").innerText(), /Nicht konfiguriert/);
    await page.locator("#profile-final-fallback .profile-editor summary").click();
    await page.locator("#fallback-mode").selectOption("degrading");
    await page.locator("#fallback-provider_id").selectOption("fixture");
    await page.locator("#fallback-model_id").selectOption("family/model");
    await page.locator("#fallback-variant").selectOption("high");
    await page.locator("#profile-final-fallback button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#profile-final-fallback .profile-feedback").textContent.includes("gespeichert · Revision"));
    let storedPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.equal(storedPolicy.schemaVersion, 3);
    assert.deepEqual(storedPolicy.finalFallback, { mode: "degrading", selection: tuple });
    assert.ok((await readdir(`${project}/.opencode-vm`)).some(name => /^agent-control\.schema2-rev\d+\.backup\.json$/u.test(name)),
      "the schema 2 original must be backed up before the schema 3 upgrade");
    await page.locator("#refresh-control").click();
    await page.waitForFunction(() => document.querySelector("#profile-final-fallback .profile-summary").textContent.includes("Degrading Fallback"));
    assert.match(await page.locator("#profile-final-fallback .profile-summary").innerText(), /Im aktuellen Katalog verfügbar/);
    assert.equal(await page.locator("#fallback-mode").inputValue(), "degrading");
    assert.equal(await page.locator("#fallback-variant").inputValue(), "high");
    await page.locator("#fallback-variant").selectOption("default");
    const beforeRefusal = await readFile(`${project}/.opencode-vm/agent-control.json`, "utf8");
    await page.route("**/api/control/fallback", route => route.fulfill({ status: 422, json: { code: "SELECTION_UNAVAILABLE", reason: "variant_unavailable" } }));
    await page.locator("#profile-final-fallback button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#profile-final-fallback .profile-feedback").textContent.includes("Nicht gespeichert"));
    assert.equal(await page.locator("#fallback-variant").inputValue(), "default");
    assert.equal(await readFile(`${project}/.opencode-vm/agent-control.json`, "utf8"), beforeRefusal);
    await page.unroute("**/api/control/fallback");
    await page.locator("#profile-final-fallback").getByRole("button", { name: "Fallback entfernen" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-final-fallback .profile-feedback").textContent.includes("Fallback entfernt"));
    storedPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.equal(storedPolicy.schemaVersion, 3);
    assert.equal(storedPolicy.finalFallback, null);
    assert.match(await page.locator("#profile-final-fallback .profile-summary").innerText(), /Nicht konfiguriert/);
    // Journal#5: every model picker sorts alphabetically by displayed model name,
    // case-insensitively and deterministically, while IDs/variants stay untouched.
    const openDetails = async selector => {
      const details = page.locator(selector);
      if (!await details.evaluate(element => element.open)) await details.locator("summary").click();
    };
    const longId = "family/long-" + "model-name-".repeat(15);
    const expectedOrder = ["family/alpha", "family/beta", "family/dup-a", "family/dup-b", longId, "family/model"];
    const optionValues = async id => page.locator(`#${id}`).evaluate(el => [...el.options].slice(1).map(o => o.value));
    const optionLabels = async id => page.locator(`#${id}`).evaluate(el => [...el.options].slice(1).map(o => o.textContent));
    await openDetails("#profile-deep .profile-editor");
    await page.locator("#deep-provider_id").selectOption("fixture");
    assert.deepEqual(await optionValues("deep-model_id"), expectedOrder);
    assert.deepEqual((await optionLabels("deep-model_id")).slice(0, 3),
      ["Alpha reasoning model", "beta reasoning model", "duplicate display name"],
      "case-insensitive alphabetical order; equal display names tie-break on model_id (family/dup-a before family/dup-b)");
    await page.locator("#deep-provider_id").selectOption("other");
    assert.deepEqual(await optionValues("deep-model_id"), ["other/alpha", "other/zeta"], "sorted inside each provider list");
    await page.locator("#deep-provider_id").selectOption("fixture");
    await page.locator("#deep-model_id").selectOption("family/model");
    assert.deepEqual(await optionValues("deep-variant"), ["default", "high"], "variant order stays as delivered");
    await page.locator("#deep-variant").selectOption("high");
    await openDetails("#profile-deep .profile-fallback-editor");
    await page.locator("#deep-fallback-provider_id").selectOption("fixture");
    assert.deepEqual(await optionValues("deep-fallback-model_id"), expectedOrder, "own-fallback picker is sorted too");
    await openDetails("#profile-final-fallback .profile-editor");
    await page.locator("#fallback-provider_id").selectOption("fixture");
    assert.deepEqual(await optionValues("fallback-model_id"), expectedOrder, "final-fallback picker is sorted too");

    // Optional own fallback: additive schema-4 upgrade with an exact-bytes backup.
    const revisionBeforeOwn = (await (await page.request.get(`${base}/api/control`)).json()).policy.revision;
    await page.locator("#deep-fallback-model_id").selectOption("family/model");
    await page.locator("#deep-fallback-variant").selectOption("high");
    await page.locator("#profile-deep .profile-fallback-form").getByRole("button", { name: "Eigenes Fallback speichern und Policy erweitern" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-deep .profile-fallback-feedback").textContent.includes("Eigenes Fallback gespeichert · Revision"));
    storedPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.equal(storedPolicy.schemaVersion, 4);
    assert.deepEqual(storedPolicy.profileFallbacks.deep, tuple);
    assert.deepEqual(storedPolicy.strategies, { degrading: null, providerSkip: null }, "no switch is silently defaulted");
    assert.deepEqual(Object.keys(storedPolicy).sort(),
      ["finalFallback", "profileFallbacks", "profiles", "revision", "schemaVersion", "strategies", "updatedAt"]);
    assert.ok((await readdir(`${project}/.opencode-vm`)).some(name =>
      new RegExp(`^agent-control\\.schema3-rev${revisionBeforeOwn}\\.backup\\.json$`).test(name)),
      "the schema-3 original must be backed up before the schema-4 upgrade");
    assert.match(await page.locator("#profile-deep .profile-fallback-summary").innerText(), /Eigenes Fallback:.*Im aktuellen Katalog verfügbar/);
    assert.match(await page.locator("#fallback-strategies .strategies-summary").innerText(), /Profilbezogener Modus aktiv/);
    assert.match(await page.locator("#fallback-strategies .strategies-summary").innerText(),
      /Degrading nicht gesetzt · Provider-Skip nicht gesetzt · wirksam: Degrading aus, Provider-Skip aus/,
      "unset switches are shown as not activated instead of a hidden default");
    assert.match(await page.locator("#profile-final-fallback .profile-editor").innerText(), /nicht Teil der neuen Kette/,
      "the legacy global final stage relationship stays explicit");

    // Two independent switches: saving writes both explicitly, reset writes null.
    await openDetails("#fallback-strategies .strategies-editor");
    await page.locator("#strategies-degrading").check();
    await page.locator("#fallback-strategies button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#fallback-strategies .profile-feedback").textContent.includes("Strategien gespeichert · Revision"));
    storedPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.deepEqual(storedPolicy.strategies, { degrading: true, providerSkip: false });
    assert.deepEqual(storedPolicy.profileFallbacks.deep, tuple, "a strategy write preserves own fallbacks");
    await page.locator("#strategies-providerSkip").check();
    await page.locator("#fallback-strategies button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#fallback-strategies .strategies-summary").textContent.includes("Provider-Skip an"));
    assert.deepEqual(JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`)).strategies,
      { degrading: true, providerSkip: true });
    await page.locator("#fallback-strategies .profile-actions button.secondary").click();
    await page.waitForFunction(() => document.querySelector("#fallback-strategies .profile-feedback").textContent.includes("zurückgesetzt · Revision"));
    storedPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.deepEqual(storedPolicy.strategies, { degrading: null, providerSkip: null });
    assert.equal(storedPolicy.schemaVersion, 4, "resetting the switches never downgrades the schema");

    // Lost response on an own-fallback write: no blind retry, explicit readback.
    await page.route("**/api/control/profiles/standard/fallback", route => route.abort());
    await openDetails("#profile-standard .profile-fallback-editor");
    await page.locator("#standard-fallback-provider_id").selectOption("fixture");
    await page.locator("#standard-fallback-model_id").selectOption("family/beta");
    await page.locator("#standard-fallback-variant").selectOption("high");
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Eigenes Fallback speichern" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-standard .profile-fallback-feedback").textContent.includes("nicht bestätigt"));
    assert.match(await page.locator("#profile-standard .profile-fallback-feedback").innerText(), /kein automatischer Wiederholungswrite/);
    await page.unroute("**/api/control/profiles/standard/fallback");
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Speicherstand zurücklesen" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-standard .profile-fallback-feedback").textContent.includes("Aktuell gespeichert"));
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Entwurf nach Abgleich freigeben" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-standard .profile-fallback-feedback").textContent.includes("Abgleich bestätigt"));
    // Concurrent change: the draft survives and needs a deliberate comparison.
    const currentOwn = await (await page.request.get(`${base}/api/control`)).json();
    await page.request.put(`${base}/api/control/profiles/standard/fallback`, { headers: { Origin: base },
      data: { revision: currentOwn.policy.revision, fallback: { ...tuple, model_id: "family/alpha" } } });
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Eigenes Fallback speichern" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-standard .profile-fallback-feedback").textContent.includes("anderweitig"));
    assert.equal(await page.locator("#standard-fallback-model_id").inputValue(), "family/beta", "the draft is preserved");
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Aktuellen Stand vergleichen" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-standard .profile-fallback-feedback").textContent.includes("Aktuell gespeichert"));
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Entwurf nach Abgleich freigeben" }).click();
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Eigenes Fallback speichern" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-standard .profile-fallback-feedback").textContent.includes("Eigenes Fallback gespeichert · Revision"));
    assert.deepEqual(JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`)).profileFallbacks.standard,
      { ...tuple, model_id: "family/beta" });
    await page.locator("#profile-standard .profile-fallback-form").getByRole("button", { name: "Eigenes Fallback entfernen" }).click();
    await page.waitForFunction(() => document.querySelector("#profile-standard .profile-fallback-feedback").textContent.includes("Eigenes Fallback entfernt"));
    storedPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.equal(storedPolicy.profileFallbacks.standard, null);
    assert.equal(storedPolicy.schemaVersion, 4, "clearing an own fallback never downgrades the schema");
    assert.deepEqual(storedPolicy.profileFallbacks.deep, tuple, "other own fallbacks survive");
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
    // Slot pause (task_f2d0ccc6): the small An/Aus switch on a stored slot greys
    // the editor out, keeps the stored tuple visible, persists the pause, and
    // restores the identical selection when switched back on. A full reload first:
    // the pause state lives server-side and must survive restarts/reloads anyway.
    await page.unroute("**/api/control");
    await page.reload();
    await page.waitForSelector("#profile-deep .card-head .slot-switch input:not([disabled])");
    await page.locator("#profile-deep .card-head .slot-switch input").click();
    await page.waitForFunction(() => document.querySelector("#profile-deep .profile-feedback").textContent.includes("Slot pausiert"));
    assert.equal(await page.locator("#profile-deep .card-head .slot-switch input").isChecked(), false);
    assert.equal(await page.locator("#profile-deep .card-head .slot-switch").evaluate(e => e.offsetParent !== null), true, "the switch only exists on stored slots");
    assert.equal(await page.locator("#profile-deep").evaluate(e => e.classList.contains("slot-off")), true);
    assert.equal(await page.locator("#deep-variant").isDisabled(), true, "paused slot greys the selection fields out");
    assert.match(await page.locator("#profile-deep .profile-summary").innerText(), /pausiert/);
    assert.match(await page.locator("#profile-deep .profile-effective").innerText(), /Pausiert/);
    assert.match(await page.locator("#profile-deep .profile-summary").innerText(), /Representative development model · Fixture Provider · high · .* · pausiert/, "the stored tuple stays visible while paused");
    const pausedPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.equal(pausedPolicy.schemaVersion, 5, "the first pause upgrades to schema 5");
    assert.equal(pausedPolicy.disabled.profiles.deep, true);
    assert.deepEqual(pausedPolicy.profiles.deep, tuple, "the stored selection survives the pause byte-exact");
    assert.ok(JSON.stringify(pausedPolicy).includes("disabled"), "the pause flag is persisted");
    const regimeBefore = (await (await page.request.get(`${base}/api/control`)).json()).routing.regime;
    assert.equal(await page.evaluate(async regime => (await (await fetch("/api/control")).json()).routing.regime === regime, regimeBefore), true,
      "the disable state never changes the routing regime");
    // A fresh snapshot keeps the honest disabled state and the effective path.
    await page.locator("#refresh-control").click();
    await page.waitForFunction(() => document.querySelector("#control-status").textContent.includes("Format 5"));
    assert.equal(await page.locator("#deep-variant").isDisabled(), true);
    // The paused primary is skipped before any request; the configured own
    // fallback of the same profile becomes the effective next candidate.
    const pausedResolution = (await (await page.request.get(`${base}/api/control`)).json()).resolutions.deep;
    assert.equal(pausedResolution.status, "available");
    assert.equal(pausedResolution.resolved_label, "deep.fallback");
    // Re-enable restores the identical stored selection.
    await page.locator("#profile-deep .card-head .slot-switch input").click();
    await page.waitForFunction(() => document.querySelector("#profile-deep .profile-feedback").textContent.includes("reaktiviert"));
    assert.equal(await page.locator("#profile-deep .card-head .slot-switch input").isChecked(), true);
    assert.equal(await page.locator("#deep-variant").isDisabled(), false);
    const restoredPolicy = JSON.parse(await readFile(`${project}/.opencode-vm/agent-control.json`));
    assert.equal(restoredPolicy.disabled.profiles.deep, false);
    assert.deepEqual(restoredPolicy.profiles.deep, tuple, "reactivation restores the identical tuple");
    assert.equal(restoredPolicy.schemaVersion, 5, "clearing never downgrades");
    // Reflow, zoom equivalent, text resize, keyboard and target sizes on real DOM.
    for (const width of [1280, 700, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) console.log(await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll("*")].filter(e => e.scrollWidth>e.clientWidth+2).map(e=>[e.tagName,e.id,e.className,e.scrollWidth,e.clientWidth]).slice(-15)})));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} ${width}px overflow`);
    }
    await page.addStyleTag({ content: "html{font-size:200%} p,button,summary,label,select{font-size:1rem!important}" });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) console.log(await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll("*")].filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>[e.tagName,e.id,e.className,e.scrollWidth,e.clientWidth]).slice(-15)})));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} text resize overflow`);
    await page.locator("#profile-design .profile-editor summary").click();
    await page.locator("#design-provider_id").focus(); await page.keyboard.press("Tab");
    assert.equal(await page.locator("#design-model_id").evaluate(e => e === document.activeElement), true);
    assert.equal(await page.locator("#profile-design button[type=submit]").evaluate(e => e.getBoundingClientRect().height >= 44), true);
    assert.deepEqual(errors, []);
    await browser.close(); browser = null;
    console.log(`PASS ${name}: IA, validation/focus, drafts, refresh/error, migration, conflict, lost-response recovery, clear/fallback, reflow, keyboard`);
  }
} finally { if (browser) await browser.close(); fixture.kill("SIGTERM"); lines.close(); }
