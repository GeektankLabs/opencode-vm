// W5 UI evidence: a real browser executes the production hub/monitor.js against a
// disposable Hub. The other surface is the canonical monitor store (hub.monitor),
// i.e. the same registry file the Monitor Engine and the MCP monitor tools use.
//
// Run: PLAYWRIGHT_MODULE=/abs/path/to/playwright/index.mjs node --test tests/hub_monitor_browser_test.mjs
//
// The suite intentionally contains three FINDING tests that encode binding
// acceptance items which the current production UI does not satisfy. They are
// expected to stay red until the Root-admitted correction wave; they are the
// exact reproducers.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test, { before, after } from "node:test";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

let fixture, browser, page, base, project;
const pageErrors = [];

const storeCli = (cmd, ...rest) =>
  JSON.parse(execFileSync("python3", ["-B", "tests/hub_monitor_store_cli.py", cmd, project, ...rest], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: "." },
  }).toString());

const registryMonitors = () => storeCli("snapshot").monitors;
const registryGeneration = () => storeCli("snapshot").generation;
const idByTitle = title => Object.values(registryMonitors()).find(item => item.title === title)?.id;
const card = title => page.locator(".monitor-card", { hasText: title }).first();

async function openAll() {
  while (await page.locator("#monitor-more").isVisible()) {
    const before = await page.locator(".monitor-card").count();
    await page.locator("#monitor-more").click();
    await page.waitForFunction(count => document.querySelectorAll(".monitor-card").length > count, before);
  }
}

async function waitStore(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(registryMonitors())) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function refresh() {
  const done = page.waitForResponse(r => r.url().includes("/api/monitor?limit=50") && r.request().method() === "GET");
  await page.locator("#monitor-refresh").click();
  await done.catch(() => {});
  await page.waitForTimeout(150);
}

async function openEditor(title) {
  await card(title).locator("details").first().evaluate(element => { element.open = true; });
}

async function openAllEditorsAfterRefresh() { await openAll(); }

async function saveEditor(title, interval, autonomy, runtime) {
  await openEditor(title);
  await card(title).locator("input[type=number]").fill(String(interval));
  if (autonomy) await card(title).locator("select").first().selectOption(autonomy);
  if (runtime) await card(title).locator("select").nth(1).selectOption(runtime);
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card(title).locator('button[type=submit]').click();
  await done.catch(() => {});
  await page.waitForTimeout(200);
}

async function clickAction(title, label) {
  await openEditor(title);
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "POST");
  await card(title).locator("button", { hasText: label }).click();
  await done.catch(() => {});
  await page.waitForTimeout(200);
}

async function submitDraft(title, interval) { return saveEditor(title, interval); }

before(async () => {
  fixture = spawn("python3", ["-B", "tests/hub_monitor_fixture.py"], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: "." },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [line] = await once(createInterface({ input: fixture.stdout }), "line");
  const parsed = JSON.parse(line);
  base = `http://127.0.0.1:${parsed.port}`;
  project = parsed.project;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(base);
  await page.locator("#monitor-cards .monitor-card").first().waitFor();
});

after(async () => {
  if (browser) await browser.close();
  if (fixture) { fixture.kill("SIGTERM"); await once(fixture, "exit").catch(() => {}); }
});

test("inventory lists disabled and parked monitors with stable ids and master binding", async () => {
  assert.equal(await page.locator(".monitor-card").count(), 50, "first page holds the 50-item limit");
  const ids = await page.locator(".monitor-card").evaluateAll(items => items.map(item => item.id));
  assert.equal(new Set(ids).size, 50, "monitor ids are unique");
  assert.match(await page.locator("#monitor-status").textContent(), /50 von 52 Monitor\(en\) · Registry-Generation \d+/);
  assert.equal(await card("Disabled Monitor").locator(".badge", { hasText: "Takt deaktiviert" }).count(), 1);
  assert.equal(await card("Parked Monitor").locator(".badge", { hasText: "Parked" }).count(), 1);
  assert.match(await card("Alpha Monitor").locator(".muted", { hasText: "Anker:" }).textContent(), /Anker: task_[0-9a-f]{8}/);
  assert.deepEqual(pageErrors, []);
});

test("scheduler, business state and running turn stay separate", async () => {
  assert.equal(await card("Parked Monitor").locator(".badge", { hasText: "Takt aktiv" }).count(), 1, "parking keeps the schedule enabled");
  assert.equal(await card("Parked Monitor").locator(".muted", { hasText: "Parkgrund:" }).count(), 1);
  assert.equal(await card("Running Monitor").locator(".badge", { hasText: "Lauf aktiv" }).count(), 1);
  assert.equal(await card("Abort Monitor").locator(".badge", { hasText: "Abort angefordert" }).count(), 1);
});

test("freshness never fakes health from an active schedule", async () => {
  assert.match(await card("Stale Monitor").textContent(), /Frische: stale/);
  assert.match(await card("Unknown Monitor").textContent(), /Letzter Lauf: unbekannt/);
  assert.match(await card("Unknown Monitor").textContent(), /Frische: unknown/);
});

test("pagination completeness keeps stable ids", async () => {
  await page.locator("#monitor-more").click();
  await page.locator(".monitor-card").nth(51).waitFor();
  assert.equal(await page.locator(".monitor-card").count(), 52);
  assert.match(await page.locator("#monitor-status").textContent(), /52 von 52 Monitor\(en\)/);
  assert.equal(await page.locator("#monitor-more").isHidden(), true);
});

test("UI update reaches the canonical registry (UI -> store)", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  await saveEditor("Alpha Monitor", 300, "yolo", "standard");
  assert.ok(await waitStore(items => items[id].scheduler.interval_seconds === 300));
  const stored = registryMonitors()[id];
  assert.equal(stored.autonomy_profile, "yolo");
  assert.equal(stored.runtime_profile, "standard");
});

test("external canonical write appears after an explicit refresh (store -> UI)", async () => {
  const id = idByTitle("Alpha Monitor");
  storeCli("update", id, JSON.stringify({ scheduler: { interval_seconds: 900 } }));
  await refresh();
  await page.locator(".monitor-card", { hasText: "Takt 900 s" }).first().waitFor();
  assert.equal(registryMonitors()[id].scheduler.interval_seconds, 900);
});

test("default interval 60 is surfaced for a new canonical monitor", async () => {
  const created = storeCli("create", "New Monitor", "task_000000ff-0000-4000-8000-0000000000ff", "60", "mvp", "deep");
  assert.match(created.id, /^monitor_[0-9a-f]{32}$/);
  await refresh();
  await openAll();
  await page.locator(".monitor-card", { hasText: "New Monitor" }).first().waitFor();
  const text = await card("New Monitor").textContent();
  assert.match(text, /Takt 60 s/);
  assert.match(text, /MVP \(Standard\)/);
  assert.match(text, /Runtime Deep/);
  assert.equal(await card("New Monitor").locator(".muted", { hasText: "Session: noch nicht primed" }).count(), 1);
});

test("a stale write is rejected (409) and changes nothing", async () => {
  const id = idByTitle("Alpha Monitor");
  await refresh();
  await openEditor("Alpha Monitor");
  await card("Alpha Monitor").locator("input[type=number]").fill("111");
  storeCli("bump");
  const response = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card("Alpha Monitor").locator('button[type=submit]').click();
  assert.equal((await response).status(), 409);
  await page.waitForTimeout(200);
  assert.equal(registryMonitors()[id].scheduler.interval_seconds, 900, "the rejected write changed nothing");
});

test("FINDING: conflict feedback and draft preservation after a rejected write", async () => {
  await refresh();
  await openEditor("Alpha Monitor");
  await card("Alpha Monitor").locator("input[type=number]").fill("444");
  storeCli("bump");
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card("Alpha Monitor").locator('button[type=submit]').click();
  await done.catch(() => {});
  await page.waitForTimeout(300);
  const feedback = await card("Alpha Monitor").locator(".monitor-feedback").textContent();
  const field = await card("Alpha Monitor").locator("input[type=number]").inputValue();
  assert.fail(`problemFingerprint=hub-monitor-ui-conflict-state-lost: after a 409 neither the conflict notice nor the draft survive (renderList() clears the per-card state map, so state.conflict and state.draft are discarded before buildCard reads them). feedback=${JSON.stringify(feedback)} field=${JSON.stringify(field)}`);
});

test("scheduler enable/disable, trigger and cancel act on the canonical registry", async () => {
  await refresh();
  const id = idByTitle("Disabled Monitor");
  const before = registryMonitors()[id].scheduler.enabled;
  await clickAction("Disabled Monitor", /Takt (de)?aktivieren/);
  assert.ok(await waitStore(items => items[id].scheduler.enabled === !before), "enable/disable toggles the canonical scheduler");

  await refresh();
  const target = idByTitle("Filler 10 Monitor");
  await clickAction("Filler 10 Monitor", "Jetzt auslösen");
  assert.ok(await waitStore(items => Boolean(items[target].wake_request)), "trigger records a wake request");
  await refresh();
  await clickAction("Filler 10 Monitor", "Nächsten Lauf abbrechen");
  assert.ok(await waitStore(items => items[target].wake_request === null), "cancel clears the pending wake request");
});

test("abort running turn is confirm-gated and requests the verified native abort", async () => {
  await refresh();
  const id = idByTitle("Running Monitor");
  await clickAction("Running Monitor", "Laufenden Turn abbrechen");
  assert.ok(await waitStore(items => Boolean(items[id].abort_request)));
});

test("history panel shows bounded history and logs", async () => {
  await refresh();
  await openEditor("Alpha Monitor");
  const done = page.waitForResponse(r => r.url().includes("/history") && r.request().method() === "GET");
  await card("Alpha Monitor").locator("button", { hasText: "Verlauf laden" }).click();
  await done.catch(() => {});
  await page.locator("#monitor-history", { hasText: /Verlauf monitor_[0-9a-f]{32}/ }).waitFor();
  const text = await page.locator("#monitor-history").textContent();
  assert.match(text, /updated/);
  assert.match(text, /Frische:/);
  assert.match(text, /Abdeckung:/);
});

test("delete removes the monitor from the canonical registry", async () => {
  await refresh();
  const id = idByTitle("Deletable Monitor");
  await clickAction("Deletable Monitor", "Löschen");
  assert.ok(await waitStore(items => items[id] === undefined));
  assert.equal(idByTitle("Deletable Monitor"), undefined);
});

// ---------------------------------------------------------------------------
// FINDINGS: binding acceptance items the production UI does not satisfy yet.
// ---------------------------------------------------------------------------

test("FINDING: UI re-reads its own successful write (effective readback)", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  await submitDraft("Alpha Monitor", 333);
  const stored = registryMonitors()[id].scheduler.interval_seconds;
  assert.equal(stored, 333, "precondition: the write reached the canonical registry");
  const statusGeneration = Number((await page.locator("#monitor-status").textContent()).match(/Generation (\d+)/)[1]);
  assert.equal(
    statusGeneration,
    registryGeneration(),
    "problemFingerprint=hub-monitor-ui-postwrite-reload-blocked: after a successful save the UI never reloads (load(true) is a no-op while the `writing` guard is still set), so the list and generation stay stale and the operator sees no confirmed effective readback",
  );
});

test("FINDING: a follow-up UI action after a UI write does not conflict spuriously", async () => {
  const id = idByTitle("Alpha Monitor");
  const enabled = registryMonitors()[id].scheduler.enabled;
  await clickAction("Alpha Monitor", /Takt (de)?aktivieren/);
  assert.ok(
    await waitStore(items => items[id].scheduler.enabled === !enabled),
    "problemFingerprint=hub-monitor-ui-stale-generation-conflict: the stale UI generation makes the next action fail with MONITOR_REVISION_CONFLICT although nothing external changed; the UI must refresh after its own write",
  );
});

test("FINDING: UI exposes monitor create (A-F row E CRUD)", async () => {
  const control = page.locator("button, a, input[type=submit]", { hasText: /anlegen|neu(er|en)? monitor|monitor anlegen|^create$/i });
  const actions = await page.locator("form").evaluateAll(forms => forms.map(form => form.getAttribute("action") || ""));
  assert.fail(`problemFingerprint=hub-monitor-ui-create-missing: no create control and no form posts to /api/monitor; A-F row E requires full UI<->MCP parity incl. create (concept plan section 3 CRUD). createControls=${await control.count()} formActions=${JSON.stringify(actions)}`);
});

test("FINDING: editor exposes the planned expiry setting", async () => {
  await openEditor("Alpha Monitor");
  const inputs = await card("Alpha Monitor").locator("input, select").evaluateAll(items => items.map(item => `${item.tagName}:${item.type}:${item.name || item.id || ""}`));
  assert.fail(`problemFingerprint=hub-monitor-ui-expiry-missing: editor exposes no expiry field although PUT /api/monitor/{id} supports expiry_at and the W5 acceptance lists planned settings incl. expiry. fields=${JSON.stringify(inputs)}`);
});