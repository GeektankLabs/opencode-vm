// UI evidence for the monitor surface: a real browser executes the production
// hub/monitor.js against a disposable Hub. The other surface is the canonical
// monitor store (hub.monitor), i.e. the same registry file the Monitor Engine
// and the MCP monitor tools use. Candidate master tasks come from the same
// declaration rule the Hub endpoint uses (registered compact_context/concept_plan
// document bindings), served through a deterministic fixture.
//
// Run: PLAYWRIGHT_MODULE=/abs/path/to/playwright/index.mjs node --test tests/hub_monitor_browser_test.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
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

const taskAA = "task_000000aa-0000-4000-8000-0000000000aa";
const taskAB = "task_000000ab-0000-4000-8000-0000000000ab";
const taskAC = "task_000000ac-0000-4000-8000-0000000000ac";
const defaultTasks = [
  { task_id: taskAA, title: "Open Declared WP", status: "in_progress", declared: true },
  { task_id: taskAB, title: "Second Declared WP", status: "todo", declared: true },
  { task_id: taskAC, title: "Normal Ticket", status: "in_progress", declared: false },
];
const writeFixtureTasks = tasks => writeFile(`${project}/.fixture-tasks.json`, JSON.stringify(tasks));

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
  const monitors = page.waitForResponse(r => r.url().includes("/api/monitor?limit=50") && r.request().method() === "GET");
  const candidates = page.waitForResponse(r => r.url().includes("/api/monitor/candidates") && r.request().method() === "GET");
  await page.locator("#monitor-refresh").click();
  await Promise.all([monitors.catch(() => {}), candidates.catch(() => {})]);
  await page.waitForTimeout(150);
}

async function openCreate() {
  await page.locator("#monitor-create").evaluate(element => { element.open = true; });
}

async function openEditor(title) {
  await card(title).locator("details.monitor-editor").evaluate(element => { element.open = true; });
}

async function openDetails(title) {
  await card(title).locator("details.monitor-details").evaluate(element => { element.open = true; });
}

const editorOpen = title => card(title).locator("details.monitor-editor").evaluate(element => element.open);

async function setInterval(title, value) {
  await openEditor(title);
  const input = card(title).locator('input[name="interval_seconds"]');
  await input.fill(String(value));
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await input.blur();
  const response = await done;
  await page.waitForTimeout(200);
  return response.status();
}

async function setProfile(title, name, value) {
  await openEditor(title);
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await card(title).locator(`select[name="${name}"]`).selectOption(value);
  const response = await done;
  await page.waitForTimeout(200);
  return response.status();
}

async function setExpiry(title, value) {
  await openEditor(title);
  const input = card(title).locator('input[name="expiry_at"]');
  await input.fill(value);
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await input.blur();
  const response = await done;
  await page.waitForTimeout(200);
  return response.status();
}

async function clickAction(title, label) {
  const done = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "POST");
  await card(title).locator("button", { hasText: label }).click();
  await done.catch(() => {});
  await page.waitForTimeout(200);
}

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
  assert.equal(await card("Disabled Monitor").locator(".badge", { hasText: /^Pausiert$/u }).count(), 1);
  assert.match(await card("Parked Monitor").locator(".badge", { hasText: /^Arbeitszustand: /u }).innerText(), /Parked/);
  assert.match(await card("Alpha Monitor").locator(".muted", { hasText: "Anker:" }).textContent(), /Anker: task_[0-9a-f]{8}/);
  assert.deepEqual(pageErrors, []);
});

test("one scheduler badge, separate business state and running turn", async () => {
  assert.equal(await card("Parked Monitor").locator(".badge", { hasText: /^Aktiv$/u }).count(), 1, "parking keeps the schedule enabled");
  assert.equal(await card("Parked Monitor").locator(".muted", { hasText: "Parkgrund:" }).count(), 1);
  assert.equal(await card("Running Monitor").locator(".badge", { hasText: "Lauf aktiv" }).count(), 1);
  assert.equal(await card("Abort Monitor").locator(".badge", { hasText: "Abort angefordert" }).count(), 1);
  assert.equal(await page.getByText("Takt aktiv", { exact: true }).count(), 0, "the duplicate generic badge is gone");
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

test("a committed field change autosaves partially, confirms and collapses the editor", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  await openEditor("Alpha Monitor");
  assert.equal(await editorOpen("Alpha Monitor"), true);
  assert.equal(await setInterval("Alpha Monitor", 300), 200);
  assert.ok(await waitStore(items => items[id].scheduler.interval_seconds === 300));
  await card("Alpha Monitor").locator(".monitor-feedback", { hasText: "Gespeichert" }).waitFor();
  assert.equal(await editorOpen("Alpha Monitor"), false, "a confirmed save collapses the editor");
  assert.equal(await setProfile("Alpha Monitor", "autonomy_profile", "yolo"), 200);
  assert.equal(await setProfile("Alpha Monitor", "runtime_profile", "standard"), 200);
  const stored = registryMonitors()[id];
  assert.equal(stored.scheduler.interval_seconds, 300, "unrelated fields are preserved by the partial write");
  assert.equal(stored.autonomy_profile, "yolo");
  assert.equal(stored.runtime_profile, "standard");
  assert.equal(await editorOpen("Alpha Monitor"), false);
  assert.match(await card("Alpha Monitor").textContent(), /Takt 300 s/);
});

test("external canonical write appears after an explicit refresh", async () => {
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
  assert.equal(await card("New Monitor").locator(".muted", { hasText: "Session noch nicht gestartet" }).count(), 1);
});

test("a stale write is rejected (409), keeps the draft and a later change retries deliberately", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  await openEditor("Alpha Monitor");
  const input = card("Alpha Monitor").locator('input[name="interval_seconds"]');
  await input.fill("111");
  storeCli("bump");
  const response = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await input.blur();
  assert.equal((await response).status(), 409);
  await card("Alpha Monitor").locator(".monitor-feedback", { hasText: "anderweitig geändert" }).waitFor();
  assert.equal(await editorOpen("Alpha Monitor"), true, "a conflict keeps the editor open");
  assert.equal(await input.inputValue(), "111", "the draft survives");
  assert.equal(registryMonitors()[id].scheduler.interval_seconds, 900, "the rejected write changed nothing");
  await input.fill("222");
  const retry = page.waitForResponse(r => r.url().includes("/api/monitor/") && r.request().method() === "PUT");
  await input.blur();
  assert.equal((await retry).status(), 200);
  assert.ok(await waitStore(items => items[id].scheduler.interval_seconds === 222));
  await card("Alpha Monitor").locator(".monitor-feedback", { hasText: "Gespeichert" }).waitFor();
  assert.equal(await editorOpen("Alpha Monitor"), false);
});

test("scheduler toggle and trigger act on the canonical registry; removed actions are gone", async () => {
  await refresh();
  const id = idByTitle("Disabled Monitor");
  const before = registryMonitors()[id].scheduler.enabled;
  await clickAction("Disabled Monitor", /Takt (de)?aktivieren/);
  assert.ok(await waitStore(items => items[id].scheduler.enabled === !before), "enable/disable toggles the canonical scheduler");

  await refresh();
  const target = idByTitle("Filler 10 Monitor");
  await clickAction("Filler 10 Monitor", "Jetzt auslösen");
  assert.ok(await waitStore(items => Boolean(items[target].wake_request)), "trigger records a wake request");
  assert.equal(await page.getByRole("button", { name: "Nächsten Lauf abbrechen" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Laufenden Turn abbrechen" }).count(), 0);
});

test("delete removes the monitor from the canonical registry", async () => {
  await refresh();
  const id = idByTitle("Deletable Monitor");
  await clickAction("Deletable Monitor", "Löschen");
  assert.ok(await waitStore(items => items[id] === undefined));
  assert.equal(idByTitle("Deletable Monitor"), undefined);
});

test("details starts closed, loads fresh history newest first and has its own refresh feedback", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  assert.equal(await card("Alpha Monitor").locator("details.monitor-details").evaluate(element => element.open), false);
  const history = page.waitForResponse(r => r.url().includes("/history") && r.request().method() === "GET");
  await openDetails("Alpha Monitor");
  await history;
  await card("Alpha Monitor").locator(".monitor-history .event").first().waitFor();
  const entries = registryMonitors()[id].history;
  const firstEvent = await card("Alpha Monitor").locator(".monitor-history .event").first().textContent();
  assert.ok(firstEvent.startsWith(entries[entries.length - 1].at), "newest entry first");
  assert.match(await card("Alpha Monitor").locator(".monitor-history-status").innerText(), /Stand .* Abdeckung/);
  // Own refresh button: visible reaction and explicit error instead of false success.
  await page.route("**/history**", route => route.fulfill({ status: 503, body: "offline" }));
  await card("Alpha Monitor").locator(".monitor-details-refresh").click();
  await card("Alpha Monitor").locator(".monitor-history-status", { hasText: "Verlauf nicht lesbar" }).waitFor();
  assert.equal(await card("Alpha Monitor").locator(".monitor-details-refresh").isEnabled(), true);
  await page.unroute("**/history**");
  const again = page.waitForResponse(r => r.url().includes("/history") && r.request().method() === "GET");
  await card("Alpha Monitor").locator(".monitor-details-refresh").click();
  await again;
  await card("Alpha Monitor").locator(".monitor-history-status", { hasText: "Stand" }).waitFor();
});

test("expiry is editable, commits on blur and clears back to null", async () => {
  await refresh();
  const id = idByTitle("Alpha Monitor");
  const value = "2030-01-02T03:04";
  assert.equal(await setExpiry("Alpha Monitor", value), 200);
  assert.ok(await waitStore(items => items[id].scheduler.expiry_at === new Date(value).getTime()));
  assert.match(await card("Alpha Monitor").textContent(), /Expiry /);
  assert.equal(await setExpiry("Alpha Monitor", ""), 200);
  assert.ok(await waitStore(items => items[id].scheduler.expiry_at === null));
});

test("create offers only open declared unbound tasks and derives the title automatically", async () => {
  await writeFixtureTasks(defaultTasks);
  await refresh();
  await openCreate();
  assert.equal(await page.locator("#monitor-create-title").count(), 0, "no manual title field");
  const options = await page.locator("#monitor-create-task option").evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })));
  const values = options.map(option => option.value);
  assert.ok(values.includes(taskAA) && values.includes(taskAB), "declared open tasks are offered");
  assert.ok(!values.includes(taskAC), "a normal ticket is not a master task");
  assert.ok(!values.includes("task_00000000-0000-4000-8000-000000000000"), "already bound tasks are excluded");
  const option = options.find(item => item.value === taskAA);
  assert.match(option.text, /Open Declared WP · task_000000aa-/);
  const submit = page.locator("#monitor-create-form button[type=submit]");
  assert.equal(await submit.isDisabled(), true, "no valid selection means no creation");
  await page.locator("#monitor-create-task").selectOption(taskAA);
  assert.equal(await submit.isEnabled(), true);
  assert.match(await page.locator("#monitor-create-candidates-status").innerText(), /offene deklarierte Mastertask/);
});

test("create collapses the form, keeps the readback and removes the bound task from the list", async () => {
  await openCreate();
  await page.locator("#monitor-create-task").selectOption(taskAA);
  const done = page.waitForResponse(r => r.url().endsWith("/api/monitor") && r.request().method() === "POST");
  await page.locator("#monitor-create-form button[type=submit]").click();
  assert.equal((await done).status(), 201);
  await page.locator("#monitor-status", { hasText: /erstellt \(Generation/ }).waitFor();
  assert.match(await page.locator("#monitor-create-feedback").textContent(), /Erstellt und zurückgelesen/);
  assert.equal(await page.locator("#monitor-create").evaluate(element => element.open), false, "a confirmed creation collapses the form");
  await openAll();
  await page.locator(".monitor-card", { hasText: "Open Declared WP" }).first().waitFor();
  const stored = Object.values(registryMonitors()).find(item => item.anchor.task_id === taskAA);
  assert.equal(stored.title, "Open Declared WP", "the title comes from the selected master task");
  await openCreate();
  const values = await page.locator("#monitor-create-task option").evaluateAll(items => items.map(item => item.value));
  assert.ok(!values.includes(taskAA), "the newly bound task is removed from the create list");
});

test("duplicate binding is rejected honestly in the shared creation path", async () => {
  const body = {
    title: "Second Try", task_id: taskAA, interval_seconds: 60, autonomy_profile: "mvp", runtime_profile: "deep", expiry_at: null,
  };
  const response = await page.request.post(`${base}/api/monitor`, { headers: { Origin: base }, data: body });
  assert.equal(response.status(), 409);
  const result = await response.json();
  assert.equal(result.code, "MONITOR_TASK_BOUND");
  assert.match(result.monitor_id || "", /^monitor_[0-9a-f]{32}$/);
  const bound = Object.values(registryMonitors()).filter(item => item.anchor.task_id === taskAA);
  assert.equal(bound.length, 1, "at most one monitor per master task");
});

test("refresh re-reads the board list: vanished selections are explicit and errors are never an empty list", async () => {
  await refresh();
  await openCreate();
  await page.locator("#monitor-create-task").selectOption(taskAB);
  // The task disappears upstream (for example it became done); the selection must be reported.
  await writeFixtureTasks([{ task_id: taskAA, title: "Open Declared WP", status: "in_progress", declared: true }]);
  await refresh();
  await page.locator("#monitor-create-candidates-status", { hasText: "nicht mehr verfügbar" }).waitFor();
  assert.match(await page.locator("#monitor-create-candidates-status").innerText(), /Second Declared WP/);
  assert.equal(await page.locator("#monitor-create-form button[type=submit]").isDisabled(), true);
  // A board read error is an explicit error, and retained options are marked stale.
  await writeFixtureTasks(defaultTasks);
  await refresh();
  await page.locator("#monitor-create-task").selectOption(taskAB);
  await page.route("**/api/monitor/candidates", route => route.fulfill({ status: 503, body: "offline" }));
  await refresh();
  await page.locator("#monitor-create-candidates-status", { hasText: "nicht aktuell" }).waitFor();
  assert.equal(await page.locator("#monitor-create-task").inputValue(), taskAB, "the previous selection survives a failed board read");
  await page.unroute("**/api/monitor/candidates");
  await refresh();
  await page.locator("#monitor-create-candidates-status", { hasText: "offene deklarierte Mastertask" }).waitFor();
});

test("session links follow the existing route schema and incomplete candidate lists stay honest", async () => {
  await refresh();
  await openAll();
  await card("Session Monitor").locator("p.muted a[target='_blank']").waitFor();
  const link = card("Session Monitor").locator("p.muted a[target='_blank']");
  const expectedKey = Buffer.from("https://127.0.0.1:4096").toString("base64")
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  assert.equal(await link.getAttribute("href"),
    `https://127.0.0.1:4096/server/${expectedKey}/session/ses_fixture_session`,
    "the bound session opens through the same route schema as the project dashboard");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert.match(await card("Session Monitor").innerText(), /Session: ses_fixture_session/);
  // Without a bound session there is no link, only the honest text.
  assert.match(await card("Alpha Monitor").innerText(), /Session noch nicht gestartet/);
  assert.equal(await card("Alpha Monitor").locator("p.muted a[target='_blank']").count(), 0);

  // An allowed scan budget is reported as incomplete — never as an empty list.
  await writeFixtureTasks({ tasks: [], completeness: "partial", reason: "task-scan-budget",
    missing_statuses: ["in_progress"], truncated: false, scanned: 0 });
  await refresh();
  await openCreate();
  await page.locator("#monitor-create-candidates-status", { hasText: "Liste unvollständig" }).waitFor();
  assert.match(await page.locator("#monitor-create-candidates-status").innerText(), /in_progress/,
    "the unread status is named instead of hiding the gap");
  assert.match(await page.locator("#monitor-create-task option").first().innerText(), /Liste unvollständig/);
  assert.equal(await page.locator("#monitor-create-form button[type=submit]").isDisabled(), true);
  // A capped list says that it is capped (taskAB is still unbound here).
  await writeFixtureTasks({ tasks: [{ task_id: taskAB, title: "Second Declared WP", status: "todo" }],
    completeness: "complete", reason: null, missing_statuses: [], truncated: true, scanned: 80 });
  await refresh();
  await page.locator("#monitor-create-candidates-status", { hasText: "Liste gekürzt" }).waitFor();
  await writeFixtureTasks(defaultTasks);
  await refresh();
  await page.locator("#monitor-create-candidates-status", { hasText: "offene deklarierte Mastertask" }).waitFor();
});

test("refresh reacts visibly, monitors use the full content width and narrow views do not overflow", async () => {
  await refresh();
  assert.match(await page.locator("#monitor-status").innerText(), /Zuletzt erfolgreich aktualisiert \d{2}:\d{2}:\d{2}/);
  assert.equal(await page.locator("#monitor-refresh").isEnabled(), true);
  const widths = await page.evaluate(() => {
    const container = document.getElementById("monitor-cards").getBoundingClientRect().width;
    const cardWidth = document.querySelector(".monitor-card").getBoundingClientRect().width;
    return { container, cardWidth };
  });
  assert.ok(Math.abs(widths.container - widths.cardWidth) < 2, `monitor card uses the full content width (${JSON.stringify(widths)})`);
  const markerText = await page.evaluate(() => ({
    editor: document.body.innerText.includes("monitor-editor"),
    actions: document.body.innerText.includes("monitor-actions"),
  }));
  assert.deepEqual(markerText, { editor: false, actions: false }, "internal marker class names are not rendered as user text");
  for (const width of [1280, 700, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px overflow`);
  }
  assert.deepEqual(pageErrors, []);
});