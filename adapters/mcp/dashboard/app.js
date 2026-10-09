"use strict";
(() => {
  const main = () => {
  const byId = id => document.getElementById(id);
  const labels = { running: "Läuft", retry: "Retry", input_required: "Input erforderlich", idle: "Leerlauf",
    submitted: "Eingereicht", unknown: "Unbekannt", completed: "Turn abgeschlossen", aborted: "Turn abgebrochen", failed: "Turn fehlgeschlagen" };
  const boardLabels = { todo: "To-do", in_progress: "In Arbeit", done: "Abgeschlossen" };
  const activityLabels = { "message.submitted": "Eingereicht", "message.running": "Läuft", "message.completed": "Turn abgeschlossen",
    "message.failed": "Turn fehlgeschlagen", "message.aborted": "Turn abgebrochen", "session.input_required": "Input erforderlich",
    "session.permission_required": "Freigabe erforderlich", "session.idle": "Leerlauf" };
  const kindLabel = s => s.kind === "child" ? "Child" : s.kind === "manager" ? "Managementsession" : "Session";
  const time = value => { if (!value) return "unbekannt"; const date = new Date(value); return Number.isNaN(+date) ? "unbekannt" : date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium" }); };
  const safeError = error => String((error && error.message) || "unbekannter Fehler").slice(0, 200);
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };

  // One render kernel, two thin host shims: the browser reads the existing
  // same-origin status contract; the MCP app calls the adapter's read tools
  // through the MCP Apps host bridge (JSON-RPC over postMessage).
  const embedded = window.parent !== window;
  let requestId = 0;
  const pending = new Map();
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Keine Antwort vom MCP-Host.")); }, 30000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }
  function unwrap(result) {
    if (result && result.isError) {
      const meta = result._meta && result._meta["opencode-vm/error"];
      const error = new Error(meta && meta.code ? `${meta.code}: ${meta.message || "Datenabruf abgewiesen."}`
        : "Der Datenabruf wurde abgewiesen.");
      if (meta && meta.code) error.code = meta.code;
      throw error;
    }
    if (!result || !result.structuredContent) throw new Error("Leere Antwort des Datenabrufs.");
    return result.structuredContent;
  }
  window.addEventListener("message", event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || "MCP-Fehler.")); else request.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      const content = message.params && message.params.structuredContent;
      if (content && content.counts && content.sources) { acceptSnapshot(content); setStatus(`Stand: ${time(content.generated_at)}`); age(); }
    }
  });
  const transport = embedded ? {
    mode: "bridge",
    async init() {
      try {
        await rpc("ui/initialize", { appInfo: { name: "repo-live", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
        window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
        return true;
      } catch { return false; }
    },
    async snapshot() { return unwrap(await rpc("tools/call", { name: "refresh_repo_live", arguments: {} })); },
    async sessionDetail(sessionId) { return unwrap(await rpc("tools/call", { name: "get_repo_live_session", arguments: { session_id: sessionId } })); },
  } : {
    mode: "browser",
    async init() { return true; },
    async snapshot() {
      const response = await fetch("/api/v1/status", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      return response.json();
    },
    async sessionDetail(sessionId) {
      const response = await fetch("/api/v1/status", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Status ${response.status}`);
      const data = await response.json();
      const session = (data.sessions || []).find(value => value.session_id === sessionId);
      if (!session) throw new Error("Session nicht im Projekt-Scope.");
      const events = data.recent && Array.isArray(data.recent.recent) ? data.recent.recent : [];
      return { found: true, observed_at: data.generated_at, session, recent: events.filter(event => event.session_id === sessionId).slice(-10).reverse() };
    },
  };

  let snapshot = null, filter = "all", busy = false, ready = false, timer = null, lastAttention = "";
  const rows = new Map(), cards = new Map();

  function setStatus(text) { byId("status-line").textContent = text; }
  function acceptSnapshot(data) { snapshot = data; render(); }
  function runtimeText(runtime) {
    return runtime ? `${runtime.provider_id || "Provider unbekannt"} / ${runtime.model_id || "Modell unbekannt"} / ${runtime.variant ?? "Denkstufe unbekannt"}` : "Runtime unbekannt";
  }
  function sessionLink(s) {
    if (transport.mode !== "browser" || !snapshot) return null;
    const navigation = snapshot.navigation;
    if (!navigation || !Number.isInteger(navigation.web_port)) return null;
    const base = `https://${location.hostname}:${navigation.web_port}`;
    if (navigation.opencode_version !== "1.18.34") return { href: base, text: "OpenCode (Route unverifiziert)" };
    const key = btoa(base).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    return { href: `${base}/server/${key}/session/${encodeURIComponent(s.session_id)}`, text: "Session öffnen" };
  }
  function turnText(turn) {
    return `${labels[turn.state] ?? turn.state}${turn.finish ? ` (${turn.finish})` : ""} · ${turn.user_message_id}`;
  }

  function renderSession(s, key, parent) {
    let row = rows.get(key);
    if (!row) {
      row = node("div", "session"); row.dataset.key = key; row.dataset.sessionId = s.session_id;
      const head = node("div", "session-head");
      const title = node("strong", "title"); title.dataset.field = "title";
      const status = node("span", "status"); status.dataset.field = "status";
      head.append(title, status); row.append(head);
      row.append(node("p", "runtime"), node("p", "meta"), node("p", "turns"));
      if (transport.mode === "browser") { const link = node("a", "session-link"); link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link); }
      const detail = node("details", "session-detail");
      const body = node("div", "detail-body");
      detail.append(node("summary", null, "Details & Belege"), body); row.append(detail);
      detail.addEventListener("toggle", () => { if (detail.open) void loadDetails(s.session_id, body, row); });
      parent.append(row); rows.set(key, row);
    }
    const field = name => row.querySelector(`[data-field=${name}]`);
    field("title").textContent = `${s.title} · ${kindLabel(s)}`;
    field("status").textContent = `${labels[s.state] ?? s.state}${s.freshness !== "fresh" ? " · veraltet / letzter Stand" : ""}${s.anomaly ? " · archiviert und aktiv!" : ""}`;
    field("status").dataset.state = s.state;
    const turns = s.turns || [];
    const latest = turns.length ? turns[turns.length - 1] : null;
    const evidenced = turns.length ? ([...turns].reverse().find(t => t.active) || latest) : null;
    row.querySelector(".runtime").textContent = `Einstellung: ${runtimeText(s.current_runtime)} · ${s.state === "idle" ? "Zuletzt belegt" : "Turn belegt"}: ${runtimeText(evidenced && evidenced.runtime)}${s.freshness !== "fresh" ? " · stale" : ""}`;
    const other = [...new Set(s.associations.map(a => a.task_id))];
    row.querySelector(".meta").textContent = `${s.session_id}${s.parent_session_id ? ` · Parent ${s.parent_session_id}` : ""}${s.binding_state === "unknown" ? " · Taskzuordnung unbekannt" : s.binding_state === "unbound" ? " · Ohne Task" : other.length > 1 ? ` · Mehrfachbindung: ${other.join(", ")}` : ""}${s.associations.some(a => a.scope === "parent_indirect") ? " · indirekte Parentbindung" : ""}${s.current_turn_unbound ? " · aktueller Turn nicht zugeordnet" : ""}`;
    const turnLine = turns.length ? `Turns (neueste zuerst): ${[...turns].reverse().map(turnText).join(" · ")}` : "Kein Turn im Lesefenster";
    row.querySelector(".turns").textContent = turnLine + ((s.turns_truncated || s.history_has_more) ? " · Weitere Turnhistorie in der Session (Lesefenster begrenzt)" : "");
    if (transport.mode === "browser") {
      const link = row.querySelector("a.session-link"), target = sessionLink(s);
      if (target) { link.href = target.href; link.textContent = target.text; link.hidden = false; }
      else { link.removeAttribute("href"); link.textContent = "Navigation unbekannt"; }
    }
    row.hidden = filter === "attention" ? !(["input_required", "unknown"].includes(s.state) || Boolean(s.anomaly))
      : filter === "running" ? !["running", "retry", "submitted"].includes(s.state) : false;
    return key;
  }

  async function loadDetails(sessionId, body, row) {
    const loadedAt = Date.parse(row.dataset.detailObserved || "");
    if (Number.isFinite(loadedAt) && Date.now() - loadedAt < 10000) return;
    body.replaceChildren(node("p", "empty", "Details werden frisch geladen …"));
    try {
      const detail = await transport.sessionDetail(sessionId);
      row.dataset.detailObserved = detail.observed_at || new Date().toISOString();
      body.replaceChildren();
      const head = node("div", "detail-head");
      head.append(node("p", "caption", `Frisch abgerufen: ${time(detail.observed_at)}`));
      const refreshButton = node("button", "refresh-detail", "Details aktualisieren");
      refreshButton.type = "button";
      refreshButton.addEventListener("click", () => { row.dataset.detailObserved = ""; void loadDetails(sessionId, body, row); });
      head.append(refreshButton); body.append(head);
      const session = detail.session;
      const kv = node("div", "kv");
      const rowsKv = [
        ["Status", `${labels[session.state] ?? session.state}${session.freshness !== "fresh" ? " · veraltet / letzter Stand" : ""}`],
        ["Turnbelege (neueste zuerst)", (session.turns || []).length ? [...session.turns].reverse().map(turn =>
          `${turnText(turn)}${turn.completed_at ? ` · ${time(turn.completed_at)}` : ""}`).join("\n") : "keine belegten Turns im Lesefenster"],
        ["Rückfragen / Freigaben", `${session.pending_input ? session.pending_input.questions : "unbekannt"} / ${session.pending_input ? session.pending_input.permissions : "unbekannt"} (sessionweit; ohne konkrete Turnzuordnung)`],
        ["Einstellung (aktuell)", runtimeText(session.current_runtime)],
        ["Letzte Änderung", time(session.last_activity_at)],
        ["Session-ID", session.session_id],
      ];
      for (const [label, value] of rowsKv) kv.append(node("span", "kv-key", label), node("span", "kv-value", String(value)));
      body.append(kv);
      body.append(node("p", "caption", "Turn abgeschlossen ≠ Taskabnahme ≠ QC ≠ Main-Integration. Aktuelle Einstellung ≠ belegte Turnruntime."));
      body.append(node("p", "kv-key", "Letzte Metadatenereignisse (neueste zuerst)"));
      const events = detail.recent || [];
      if (!events.length) body.append(node("p", "empty", "Keine belegten Metadatenereignisse für diese Session im Lesefenster."));
      for (const event of events) body.append(node("p", "detail-line",
        `${time(event.timestamp)} · ${activityLabels[event.type] ?? event.type}${event.message_id ? ` · ${event.message_id}` : ""}`));
    } catch (error) {
      body.replaceChildren(node("p", "notice", `Details konnten nicht abgerufen werden (${safeError(error)}).`));
      const retry = node("button", "refresh-detail", "Erneut versuchen");
      retry.type = "button";
      retry.addEventListener("click", () => { row.dataset.detailObserved = ""; void loadDetails(sessionId, body, row); });
      body.append(retry);
    }
  }

  function boardSummary() {
    if (!snapshot.tasks || !snapshot.tasks.length) return "keine belegte Taskbindung sichtbar";
    const counts = new Map();
    for (const task of snapshot.tasks) counts.set(task.board_status, (counts.get(task.board_status) || 0) + 1);
    return [...counts.entries()].map(([status, count]) => `${boardLabels[status] ?? status}: ${count}`).join(" · ");
  }
  function latestTerminal() {
    const terminal = [];
    for (const session of snapshot.sessions) for (const turn of session.turns || [])
      if (["completed", "failed", "aborted"].includes(turn.state))
        terminal.push({ at: turn.completed_at || session.last_activity_at, state: turn.state, session: session.title });
    if (!terminal.length) return "kein belegter Abschluss im Lesefenster";
    terminal.sort((a, b) => (b.at || 0) - (a.at || 0));
    const first = terminal[0];
    return `${labels[first.state]} · ${first.session} · ${time(first.at)} (kein QC-/Abnahmenachweis)`;
  }
  function serviceLabel() {
    const service = snapshot.service;
    if (!service) return "unbekannt (keine Prozessangabe im Payload); installierter Projektstand bleibt außerhalb dieser Ansicht";
    return `${service.kind} · Generation ${String(service.generation).slice(0, 8)}… · Adapter ${service.adapterVersion ?? "unbekannt"} (installierter Projektstand außerhalb dieser Ansicht)`;
  }
  function renderFacts() {
    const counts = snapshot.counts || {}, coverage = snapshot.coverage || {};
    const partial = !(coverage.sessions_complete && coverage.bindings_complete);
    const facts = [
      ["board", "Boardstatus (fachlich)", boardSummary()],
      ["sessions", "Sessions (Backend)", `${counts.active_sessions ?? `≥${counts.known_active_sessions ?? "?"} (Coverage unvollständig)`} aktiv · ${counts.attention_sessions ?? "?"} Input/Attention${partial ? " · Abdeckung eingeschränkt" : ""}`],
      ["turn", "Turnabschluss (korreliert)", latestTerminal()],
      ["qc", "QC-Befund", "unbekannt — keine kanonische Live-Quelle in dieser Ansicht"],
      ["integration", "Main-Integration", "unbekannt — Git-/Integrationsnachweis außerhalb dieser Ansicht"],
      ["service", "Servierender Prozess", serviceLabel()],
    ];
    const container = byId("facts"); container.replaceChildren();
    for (const [id, label, value] of facts) {
      const item = node("div", "fact"); item.dataset.fact = id;
      item.append(node("p", "kv-key", label), node("p", "fact-value", value));
      container.append(item);
    }
  }

  function renderPreparedAttention() {
    const host = byId("prepared-attention");
    if (!host) return;
    host.replaceChildren();
    const prepared = snapshot.prepared_attention;
    if (!prepared) { host.append(node("p", "empty", "Prepared-Attention-Quelle nicht vorhanden.")); return; }
    if (!prepared.available) {
      host.append(node("p", "empty", `Prepared Attention nicht verfügbar (${prepared.reason || "unbekannt"}).`));
      if (Array.isArray(prepared.entries) && prepared.entries.length) {
        host.append(node("p", "caption", `Letzter bekannter Stand, nicht frisch: ${prepared.entries.length} Einträge.`));
      }
      return;
    }
    const entries = Array.isArray(prepared.entries) ? prepared.entries : [];
    if (!entries.length) { host.append(node("p", "empty", "Keine vorbereiteten Attention-Einträge.")); return; }
    const classLabel = { action_required: "Input erforderlich", attention: "Fehler/Abort", ready: "Ergebnis bereit" };
    const lifecycleLabel = { new: "neu", ready: "bereit", offered: "angeboten", discussed: "diskutiert", superseded: "abgelöst" };
    const orderingLabel = { input_required: "Input erforderlich", error_abort: "Fehler/Abort", ready_result: "Ergebnis bereit" };
    for (const entry of entries) {
      const link = entry.task_id ? ` · ${entry.task_id}` : entry.hierarchy_status === "unlinked" ? " · unverknüpft" : "";
      const resolved = entry.resolution === "resolved" ? "abgenommen" : "zur Prüfung unverifiziert";
      const superseded = entry.superseded_by ? ` · abgelöst von ${entry.superseded_by}` : "";
      const summary = entry.prepared_summary ? ` · ${entry.prepared_summary}` : "";
      const next = entry.next_safe_step ? ` · Nächster Schritt: ${entry.next_safe_step}` : "";
      host.append(node("p", "detail-line",
        `${classLabel[entry.classification] || entry.classification} · ${lifecycleLabel[entry.lifecycle] || entry.lifecycle}` +
        `${entry.session_id ? ` · ${entry.session_id}` : ""}${link} · ${resolved}${superseded}${summary}${next}`));
    }
    if (prepared.omitted) host.append(node("p", "caption", `Weitere ${prepared.omitted} von ${prepared.total} Einträgen ausgelassen (begrenzte Queue).`));
    if (prepared.ordering) host.append(node("p", "caption", `Reihenfolge: ${prepared.ordering.map((name) => orderingLabel[name] || name).join(" → ")}.`));
  }

  function render() {
    if (!snapshot) return;
    const focused = document.activeElement;
    const focusedKey = focused && focused.closest(".session") ? focused.closest(".session").dataset.sessionId : undefined;
    const scroll = window.scrollY;
    const placeholder = byId("placeholder"); if (placeholder) placeholder.remove();
    byId("project").textContent = `${snapshot.project.name} · Repo Live`;
    const counts = snapshot.counts || {};
    byId("counts").textContent = `${counts.active_sessions ?? `≥${counts.known_active_sessions ?? "?"} (Coverage unvollständig)`} aktive Sessions · ${counts.active_tasks ?? "?"} Tasks · ${counts.attention_sessions ?? "?"} Attention`;
    byId("error").textContent = Object.entries(snapshot.sources || {}).filter(([, source]) => source.state !== "fresh" && source.state !== "disabled")
      .map(([name, source]) => `${name}: ${source.state} (${source.error ?? "Datenalter"})`).join(" · ");
    renderFacts();
    renderPreparedAttention();
    const keys = new Set();
    const active = snapshot.sessions.filter(session => session.operational);
    for (const task of snapshot.tasks || []) {
      const matching = active.filter(session => session.associations.some(association => association.task_id === task.task_id));
      if (!matching.length) continue;
      const key = `task:${task.task_id}`;
      let card = cards.get(key);
      if (!card) {
        card = node("article"); card.dataset.taskId = task.task_id;
        card.append(node("h2"), node("p", "meta"));
        byId("work").append(card); cards.set(key, card);
      }
      keys.add(key);
      card.querySelector("h2").textContent = task.title;
      card.querySelector(".meta").textContent = `${task.task_id} · Board: ${boardLabels[task.board_status] ?? task.board_status}${task.board_status === "done" ? " · Board abgeschlossen — kein Lauf-/QC-Nachweis" : ""}`;
      for (const session of matching) keys.add(renderSession(session, `${key}:${session.session_id}`, card));
      card.hidden = [...card.querySelectorAll(".session")].every(row => row.hidden);
    }
    for (const session of snapshot.sessions) {
      if (session.archived && !session.operational) continue;
      if (session.operational && session.associations.length) continue;
      keys.add(renderSession(session, `${session.operational ? "standalone" : "idle"}:${session.session_id}`,
        byId(session.operational ? "work" : "idle")));
    }
    for (const session of snapshot.unknown_sessions || []) {
      keys.add(renderSession({ ...session, kind: session.parent_session_id ? "child" : "root", state: "unknown", freshness: "stale",
        turns: [], current_runtime: null, associations: [], binding_state: "unknown", current_turn_unbound: null },
        `unknown:${session.session_id}`, byId("work")));
    }
    for (const [key, row] of rows) if (!keys.has(key)) { row.remove(); rows.delete(key); }
    for (const [key, card] of cards) if (!keys.has(key)) { card.remove(); cards.delete(key); }
    byId("others").querySelector("summary").textContent = `Weitere Sessions (${snapshot.sessions.filter(session => !session.operational && !session.archived).length})`;
    const events = snapshot.recent && Array.isArray(snapshot.recent.recent) ? [...snapshot.recent.recent].reverse() : [];
    const recent = byId("recent"); recent.replaceChildren();
    if (!events.length) recent.append(node("p", "empty", snapshot.recent ? "Keine belegten Metadatenereignisse im Lesefenster." : "Aktivitätsjournal nicht verfügbar (Quelle degraded/unknown)."));
    for (const event of events) recent.append(node("p", "detail-line",
      `${time(event.timestamp)} · ${activityLabels[event.type] ?? event.type}${event.message_id ? ` · ${event.message_id}` : ""}${event.session_id ? ` · ${event.session_id}` : ""}`));
    const truncation = snapshot.truncation;
    byId("truncation").textContent = truncation ? `Antwortbudget: ausgelassen ${truncation.sessions} Sessions, ${truncation.tasks} Tasks, ${truncation.unknown_sessions} unbekannte Zeilen, ${truncation.recent} Ereignisse.` : "";
    if (transport.mode === "browser" && snapshot.navigation && snapshot.navigation.board_port) {
      const board = byId("board");
      board.hidden = false; board.href = `http://${location.hostname}:${snapshot.navigation.board_port}`;
      board.target = "_blank"; board.rel = "noopener noreferrer";
    }
    const attention = JSON.stringify(snapshot.attention);
    if (attention !== lastAttention) {
      byId("announcement").textContent = `${counts.attention_sessions ?? "Unbekannte Anzahl"} Sessions benötigen Aufmerksamkeit`;
      lastAttention = attention;
    }
    age();
    if (focusedKey && !focused.isConnected) {
      const replacement = [...document.querySelectorAll(".session")].find(row => row.dataset.sessionId === focusedKey);
      const anchor = replacement && replacement.querySelector("a.session-link");
      if (anchor) anchor.focus({ preventScroll: true });
      window.scrollTo(0, scroll);
    }
  }

  function age() {
    if (!snapshot) return;
    const parts = ["sessions", "board", "discovery", "activity"].map(name => {
      const source = snapshot.sources[name];
      if (!source) return null;
      if (source.state === "disabled") return `${name}: Journal deaktiviert`;
      const seconds = source.observed_at ? Math.max(0, Math.round((Date.now() - Date.parse(source.observed_at)) / 1000)) : null;
      return `${name}: ${seconds === null ? "unbekannt" : `${seconds} s`} (${source.state})`;
    }).filter(Boolean);
    byId("freshness").textContent = `${parts.join(" · ")} · Stand ${time(snapshot.generated_at)}`;
    const details = byId("source-details"); details.replaceChildren();
    for (const [name, source] of Object.entries(snapshot.sources || {})) details.append(node("p", "detail-line",
      source.state === "disabled" ? `${name}: Journal deaktiviert` :
      `${name}: ${source.observed_at ?? "unbekannt"} · ${source.state} · ${source.complete ? "vollständig" : "Coverage unvollständig"}${source.error ? ` · ${source.error}` : ""}`));
  }

  async function refresh() {
    if (busy || !ready) return;
    busy = true;
    const button = byId("refresh"); button.disabled = true; button.textContent = "Wird aktualisiert …";
    setStatus("Aktuelle Daten werden abgerufen …");
    try {
      const data = await transport.snapshot();
      acceptSnapshot(data);
      setStatus(`Abruf abgeschlossen · Stand ${time(data.generated_at)}`);
      byId("error").textContent = "";
    } catch (error) {
      setStatus("Aktualisierung fehlgeschlagen. Der vorherige Stand bleibt sichtbar.");
      byId("error").textContent = `Datenabruf fehlgeschlagen (${safeError(error)}). ${snapshot ? "Letzter bekannter Stand bleibt oben sichtbar." : "Noch kein Stand verfügbar."}`;
    } finally {
      busy = false; button.disabled = false; button.textContent = "Aktualisieren";
      if (snapshot) age();
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (transport.mode !== "browser" || !ready) return;
    const observed = Date.parse((snapshot && snapshot.sources && snapshot.sources.sessions && snapshot.sources.sessions.observed_at) || "");
    const delay = Number.isFinite(observed) ? 5100 - ((Date.now() - observed) % 5000) : 5000;
    timer = setTimeout(() => void refresh(), document.hidden ? 30000 : Math.max(100, delay));
  }

  for (const id of ["all", "attention", "running"]) byId(id).addEventListener("click", () => {
    filter = id;
    for (const name of ["all", "attention", "running"]) byId(name).setAttribute("aria-pressed", String(name === id));
    if (snapshot) render();
  });
  byId("refresh").addEventListener("click", () => void refresh());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  window.addEventListener("focus", () => void refresh());
  setInterval(age, 1000);

  void (async () => {
    ready = await transport.init();
    byId("refresh").disabled = !ready;
    if (!ready) { setStatus("Kein MCP-Apps-Host verbunden. Diese Ansicht wird über das installierte Plugin geöffnet."); return; }
    await refresh();
  })();
  };
  // The same file is served deferred by the dashboard and inlined into the MCP
  // app resource; starting after DOM readiness keeps both deliveries identical.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main, { once: true });
  else main();
})();
