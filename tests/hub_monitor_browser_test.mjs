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

async function openCreate() {
  await page.locator("#monitor-create").evaluate(element => { element.open = true; });
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
  await clickAction("Alpha Monitor", "Aktuellen Stand vergleichen");
  await card("Alpha Monitor").locator(".monitor-feedback", { hasText: "Registry anderweitig geändert" }).waitFor({ state: "detached" });
});

test("conflict notice and draft survive a rejected write", async () => {
  await refresh();
  await openEditor("Alpha Monitor");
  await card("Alpha Monitor").locator('input[name="interval_seconds"]').fill("444");
  storeCli("bump");
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card("Alpha Monitor").locator('button[type=submit]').click();
  assert.equal((await done).status(), 409);
  await card("Alpha Monitor").locator(".monitor-feedback", { hasText: "Registry anderweitig geändert" }).waitFor();
  assert.equal(await card("Alpha Monitor").locator('input[name="interval_seconds"]').inputValue(), "444", "the draft survives");
  await clickAction("Alpha Monitor", "Aktuellen Stand vergleichen");
  await card("Alpha Monitor").locator(".monitor-feedback", { hasText: "Registry anderweitig geändert" }).waitFor({ state: "detached" });
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
// Positive regressions for the W5 UI findings (fixed in this correction).
// ---------------------------------------------------------------------------

test("post-write readback keeps UI and store generation identical and shows the new value", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  await saveEditor("Alpha Monitor", 333);
  assert.ok(await waitStore(items => items[id].scheduler.interval_seconds === 333));
  await page.locator(".monitor-card", { hasText: "Takt 333 s" }).first().waitFor();
  const statusGeneration = Number((await page.locator("#monitor-status").textContent()).match(/Generation (\d+)/)[1]);
  assert.equal(statusGeneration, registryGeneration());
});

test("a follow-up UI action after a UI write succeeds without conflict", async () => {
  const id = idByTitle("Alpha Monitor");
  const before = registryMonitors()[id].scheduler.enabled;
  await clickAction("Alpha Monitor", /Takt (de)?aktivieren/);
  assert.ok(await waitStore(items => items[id].scheduler.enabled === !before));
});

test("create form creates a monitor with defaults and a confirmed readback", async () => {
  await refresh();
  await openCreate();
  await page.locator("#monitor-create-title").fill("UI Created Monitor");
  await page.locator("#monitor-create-task").fill("task_0000ffff-0000-4000-8000-00000000ffff");
  const done = page.waitForResponse(r => r.url().endsWith("/api/monitor") && r.request().method() === "POST");
  await page.locator("#monitor-create-form button[type=submit]").click();
  assert.equal((await done).status(), 201);
  await page.locator("#monitor-create-feedback", { hasText: /Erstellt und zurückgelesen/ }).waitFor();
  await openAll();
  await page.locator(".monitor-card", { hasText: "UI Created Monitor" }).first().waitFor();
  const text = await card("UI Created Monitor").textContent();
  assert.match(text, /Takt 60 s/);
  assert.match(text, /MVP \(Standard\)/);
  assert.match(text, /Runtime Deep/);
  const stored = Object.values(registryMonitors()).find(item => item.title === "UI Created Monitor");
  assert.equal(stored.scheduler.interval_seconds, 60);
  assert.equal(stored.autonomy_profile, "mvp");
  assert.equal(stored.runtime_profile, "deep");
  assert.equal(stored.anchor.task_id, "task_0000ffff-0000-4000-8000-00000000ffff");
});

test("duplicate master-task binding is rejected honestly", async () => {
  await refresh();
  await openCreate();
  const task = "task_0000fffe-0000-4000-8000-00000000fffe";
  const submit = async title => {
    await page.locator("#monitor-create-title").fill(title);
    await page.locator("#monitor-create-task").fill(task);
    const done = page.waitForResponse(r => r.url().endsWith("/api/monitor") && r.request().method() === "POST");
    await page.locator("#monitor-create-form button[type=submit]").click();
    return (await done).status();
  };
  assert.equal(await submit("Duplicate A"), 201);
  assert.equal(await submit("Duplicate B"), 409);
  assert.match(await page.locator("#monitor-create-feedback").textContent(), /MONITOR_REVISION_CONFLICT/);
  const bound = Object.values(registryMonitors()).filter(item => item.anchor.task_id === task);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].title, "Duplicate A");
});

test("expiry is editable and clears back to null", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  const value = "2030-01-02T03:04";
  await openEditor("Alpha Monitor");
  await card("Alpha Monitor").locator('input[name="expiry_at"]').fill(value);
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card("Alpha Monitor").locator('button[type=submit]').click();
  assert.equal((await done).status(), 200);
  assert.ok(await waitStore(items => items[id].scheduler.expiry_at === new Date(value).getTime()));
  assert.match(await card("Alpha Monitor").textContent(), /Expiry /);
  await openEditor("Alpha Monitor");
  await card("Alpha Monitor").locator('input[name="expiry_at"]').fill("");
  const done2 = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card("Alpha Monitor").locator('button[type=submit]').click();
  assert.equal((await done2).status(), 200);
  assert.ok(await waitStore(items => items[id].scheduler.expiry_at === null));
});

test("focus and draft survive a save", async () => {
  await refresh();
  await openEditor("Alpha Monitor");
  const input = card("Alpha Monitor").locator('input[name="interval_seconds"]');
  await input.focus();
  await input.fill("654");
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card("Alpha Monitor").locator("form").evaluate(form => form.requestSubmit());
  assert.equal((await done).status(), 200);
  await page.waitForTimeout(200);
  const active = await page.evaluate(() => ({ name: document.activeElement?.name || "", value: document.activeElement?.value || "" }));
  assert.equal(active.name, "interval_seconds");
  assert.equal(active.value, "654");
});

test("pending writes are single-flight", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  let puts = 0;
  await page.route("**/api/monitor/*", async route => {
    if (route.request().method() === "PUT") { puts += 1; await new Promise(resolve => setTimeout(resolve, 700)); }
    await route.continue();
  });
  await openEditor("Alpha Monitor");
  await card("Alpha Monitor").locator('input[name="interval_seconds"]').fill("765");
  const submit = card("Alpha Monitor").locator('button[type=submit]');
  await submit.click();
  await submit.click().catch(() => {});
  await page.waitForTimeout(1600);
  await page.unroute("**/api/monitor/*");
  assert.equal(puts, 1);
  assert.equal(registryMonitors()[id].scheduler.interval_seconds, 765);
});
