const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync("opencode-vm.sh", "utf8");
const launcher = source.split('LAUNCHER_JS = r"""\n')[1].split('\n"""\n\nLAUNCHER_CSS', 1)[0];
const css = source.split('LAUNCHER_CSS = b"""\\\n')[1].split('\n"""\n', 1)[0];

class Node {
  constructor(tag, ownerRoot = null) {
    this.tagName = tag;
    this.ownerRoot = ownerRoot;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.classSet = new Set();
    this.classList = {
      add: name => this.classSet.add(name),
      contains: name => this.classSet.has(name),
      toggle: (name, force) => {
        const value = force === undefined ? !this.classSet.has(name) : Boolean(force);
        value ? this.classSet.add(name) : this.classSet.delete(name);
        return value;
      },
    };
    this.hidden = false;
    this.textContent = "";
    this.href = "";
    this.rel = "";
    this.target = "";
    this.tabIndex = 0;
  }
  set className(value) { this.classSet = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classSet].join(" "); }
  appendChild(child) {
    const root = this.tagName === "shadow-root" ? this : this.ownerRoot;
    const assignRoot = node => { node.ownerRoot = root; node.children.forEach(assignRoot); };
    assignRoot(child);
    this.children.push(child);
    return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); }
  dispatch(name, event = {}) {
    event.key ??= "";
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    event.composedPath ??= () => [this];
    for (const handler of this.listeners[name] ?? []) handler(event);
    return event;
  }
  focus() { if (this.ownerRoot) this.ownerRoot.activeElement = this; }
}

function fixture(apps, { mobile = false } = {}) {
  const host = new Node("div");
  host.dataset.apps = JSON.stringify(apps);
  const documentListeners = {};
  const document = {
    activeElement: null,
    getElementById(id) { return id === "ocvm-vm-launcher" ? host : null; },
    createElement(tag) { return new Node(tag); },
    createElementNS(_namespace, tag) { return new Node(tag); },
    addEventListener(name, handler) { (documentListeners[name] ??= []).push(handler); },
    dispatch(name, event) {
      event.composedPath ??= () => [];
      for (const handler of documentListeners[name] ?? []) handler(event);
    },
  };
  const mediaListeners = [];
  const viewportListeners = [];
  const window = {
    location: { href: "https://192.0.2.12:4096/project/session?id=ses_test" },
    innerHeight: 800,
    matchMedia() { return { matches: mobile, addEventListener(_name, handler) { mediaListeners.push(handler); } }; },
    visualViewport: { height: 800, addEventListener(_name, handler) { viewportListeners.push(handler); } },
  };
  vm.runInNewContext(launcher, { document, window, URL, Object });
  const root = host.shadowRoot;
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const all = descendants(root);
  const trigger = all.find(node => node.tagName === "button");
  const menu = all.find(node => node.getAttribute("role") === "menu");
  const links = all.filter(node => node.getAttribute("role") === "menuitem");
  return { host, root, trigger, menu, links, document, window, mediaListeners, viewportListeners };
}

// Install attachShadow after class definition so the root can retain its focus.
Node.prototype.attachShadow = function () {
  const root = new Node("shadow-root");
  root.host = this;
  this.shadowRoot = root;
  return root;
};

test("launcher opens as an accessible menu and builds a safe new-tab editor URL", () => {
  const ui = fixture([
    { id: "editor", label: "Editor", icon: "editor", scheme: "https", port: 4100 },
    { id: "taskboard", label: "Project Management", icon: "board", scheme: "http", port: 4101 },
  ]);
  assert.equal(ui.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(ui.menu.hidden, true);
  ui.trigger.dispatch("click");
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(ui.root.activeElement, ui.links[0]);
  const [icon, label] = ui.links[0].children;
  assert.equal(icon.children[0].tagName, "svg");
  assert.equal(icon.children[0].getAttribute("viewBox"), "0 0 32 32");
  assert.equal(label.textContent, "Editor");
  assert.equal(ui.links[0].href, "https://192.0.2.12:4100/");
  assert.equal(ui.links[0].target, "_blank");
  assert.equal(ui.links[0].rel, "noopener noreferrer");
  const down = ui.root.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(down.defaultPrevented, true);
  assert.equal(ui.root.activeElement, ui.links[1]);
  ui.root.dispatch("keydown", { key: "Escape" });
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(ui.root.activeElement, ui.trigger);
});

test("brand, editor, and board entries use distinct compact SVG icons", () => {
  const ui = fixture([
    { id: "editor", label: "Editor", icon: "editor", scheme: "https", port: 4100 },
    { id: "taskboard", label: "Project Management", icon: "board", scheme: "http", port: 4101 },
  ]);
  const triggerIcon = ui.trigger.children[0].children[0];
  assert.equal(triggerIcon.tagName, "svg");
  assert.equal(triggerIcon.children[0].getAttribute("fill"), "#172126");
  assert.equal(ui.links[0].children[0].children[0].children[0].tagName, "path");
  assert.equal(ui.links[1].children[0].children[0].children[0].tagName, "rect");
  assert.match(css, /\.icon-svg/);
});

test("agent control hub opens the current private browser host in a new tab", () => {
  const ui = fixture([{ id: "agent-hub", label: "Agent Control", icon: "hub", scheme: "http", port: 4182 }]);
  ui.trigger.dispatch("click");
  assert.equal(ui.links.length, 1);
  assert.equal(ui.links[0].children[1].textContent, "Agent Control");
  assert.equal(ui.links[0].href, "http://192.0.2.12:4182/");
  assert.equal(ui.links[0].target, "_blank");
  assert.equal(ui.links[0].rel, "noopener noreferrer");
  assert.equal(ui.links[0].children[0].children[0].children[0].tagName, "circle");
});

test("launcher rejects untrusted hostname overrides", () => {
  const ui = fixture([
    { id: "agent-hub", label: "Hub", icon: "hub", scheme: "http", port: 4182, host: "example.org" },
    { id: "editor", label: "Editor", icon: "editor", scheme: "https", port: 4100, host: "127.0.0.1" },
  ]);
  assert.equal(ui.links.length, 0);
});

test("apps appear in Editor, Project Management, Agent Control order", () => {
  const ui = fixture([
    { id: "editor", label: "Editor", icon: "editor", scheme: "https", port: 4100 },
    { id: "taskboard", label: "Project Management", icon: "board", scheme: "http", port: 4101 },
    { id: "agent-hub", label: "Agent Control", icon: "hub", scheme: "http", port: 4182 },
  ]);
  ui.trigger.dispatch("click");
  assert.equal(ui.links.length, 3);
  assert.deepEqual(ui.links.map(link => link.children[1].textContent),
    ["Editor", "Project Management", "Agent Control"]);
  assert.equal(ui.links[1].href, "http://192.0.2.12:4101/");
  assert.equal(ui.links[1].target, "_blank");
  assert.equal(ui.links[1].rel, "noopener noreferrer");
  assert.equal(ui.links[1].children[0].children[0].children[0].tagName, "rect");
  assert.equal(ui.links[2].href, "http://192.0.2.12:4182/");
});

test("an unavailable Project Management entry keeps its place above Agent Control", () => {
  const ui = fixture([
    { id: "editor", label: "Editor", icon: "editor", scheme: "https", port: 4100 },
    { id: "taskboard", label: "Project Management", icon: "board", scheme: "http", port: 4101, ready: false },
    { id: "agent-hub", label: "Agent Control", icon: "hub", scheme: "http", port: 4182 },
  ]);
  ui.trigger.dispatch("click");
  assert.equal(ui.links[0].children[1].textContent, "Editor");
  assert.equal(ui.links[1].children[1].textContent, "Project Management");
  assert.equal(ui.links[2].children[1].textContent, "Agent Control");
  assert.equal(ui.links[1].getAttribute("aria-disabled"), "true");
  assert.equal(ui.links[2].href, "http://192.0.2.12:4182/");
});

test("outside click closes, internal click stays open, and mobile keyboard hides the launcher", () => {
  const ui = fixture([{ id: "editor", label: "Editor", icon: "editor", scheme: "https", port: 4100 }], { mobile: true });
  ui.trigger.dispatch("click");
  ui.document.dispatch("pointerdown", { composedPath: () => [ui.host, ui.trigger] });
  assert.equal(ui.menu.hidden, false, "inside pointer must not dismiss the menu");
  ui.document.dispatch("pointerdown", { composedPath: () => [new Node("outside")] });
  assert.equal(ui.menu.hidden, true);
  ui.window.visualViewport.height = 570;
  ui.viewportListeners.forEach(listener => listener());
  assert.equal(ui.host.classList.contains("keyboard-open"), true);
  ui.window.visualViewport.height = 800;
  ui.viewportListeners.forEach(listener => listener());
  assert.equal(ui.host.classList.contains("keyboard-open"), false);
  assert.match(css, /safe-area-inset-left/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /pointer-events: none/);
});

test("empty registry keeps the launcher button but exposes no dead app link", () => {
  const ui = fixture([]);
  assert.ok(ui.trigger);
  assert.equal(ui.links.length, 0);
  assert.equal(ui.menu.children[0].textContent, "No project apps are ready");
});
