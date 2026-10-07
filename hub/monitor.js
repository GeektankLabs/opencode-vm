"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const workLabels = { active: "Aktiv", parked_input_required: "Parked · Input erforderlich", complete_pass: "Abgeschlossen", stopped: "Gestoppt" };
  const autonomyLabels = { conservative: "Conservative", sandbox: "Sandbox (Autonomie, keine Isolation)", mvp: "MVP (Standard)", yolo: "YOLO" };
  const runtimeLabels = { deep: "Deep", standard: "Standard", execution: "Execution", design: "Design", review: "Review" };
  let snapshot = null, nextCursor = null, loading = false, writing = false, uncertain = null, expired = false;
  const cards = new Map();
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
  const msToLocal = value => value ? new Date(Number(value)).toLocaleString("de-DE") : "—";

  function freshness(monitor) {
    if (!monitor.last_run_at) return "unknown";
    const age = Date.now() - Date.parse(monitor.last_run_at);
    return age <= monitor.scheduler.interval_seconds * 2 * 1000 ? "fresh" : "stale";
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, ok: response.ok, body };
  }

  function renderList() {
    const container = $("monitor-cards");
    container.replaceChildren();
    cards.clear();
    for (const monitor of snapshot.monitors) container.append(buildCard(monitor));
    const summary = `${snapshot.monitors.length} von ${snapshot.total} Monitor(en) · Registry-Generation ${snapshot.generation}`;
    $("monitor-status").textContent = expired
      ? `${summary} · Abruf abgelaufen; MCP als Wahrheit lesen.`
      : summary;
    $("monitor-more").hidden = !nextCursor;
  }

  function buildCard(monitor) {
    const card = node("article", "", "card monitor-card");
    card.id = `monitor-${monitor.monitor_id}`;
    const state = cards.get(monitor.monitor_id) || {
      monitor_id: monitor.monitor_id,
      draft: null, dirty: false, conflict: false, compared: false, saving: false,
    };
    cards.set(monitor.monitor_id, state);
    if (!state.draft) {
      state.draft = {
        title: monitor.title,
        interval_seconds: monitor.scheduler.interval_seconds,
        autonomy_profile: monitor.autonomy_profile,
        runtime_profile: monitor.runtime_profile,
      };
    }
    const title = node("h3", monitor.title);
    const badges = node("p");
    badges.append(node("span", monitor.scheduler.enabled ? "Takt aktiv" : "Takt deaktiviert", `badge ${monitor.scheduler.enabled ? "healthy" : "unknown"}`));
    badges.append(document.createTextNode(" "));
    badges.append(node("span", workLabels[monitor.work_state] || monitor.work_state, `badge ${monitor.work_state === "active" ? "healthy" : monitor.work_state === "parked_input_required" ? "warning" : "unknown"}`));
    if (monitor.run_active) { badges.append(document.createTextNode(" ")); badges.append(node("span", "Lauf aktiv", "badge warning")); }
    if (monitor.abort_requested) { badges.append(document.createTextNode(" ")); badges.append(node("span", "Abort angefordert", "badge warning")); }
    card.append(title, badges);
    card.append(node("p", `Anker: ${monitor.anchor_task_id}`, "muted"));
    if (monitor.parked_reason) card.append(node("p", `Parkgrund: ${monitor.parked_reason}`, "muted"));
    card.append(node("p", `Takt ${monitor.scheduler.interval_seconds} s · ${autonomyLabels[monitor.autonomy_profile]} · Runtime ${runtimeLabels[monitor.runtime_profile]}`, "muted"));
    card.append(node("p", `Nächster Lauf: ${msToLocal(monitor.scheduler.next_run_at)} · Letzter Lauf: ${monitor.last_run_at ? new Date(monitor.last_run_at).toLocaleString("de-DE") : "unbekannt"} · Frische: ${freshness(monitor)}${monitor.scheduler.expiry_at ? ` · Expiry ${msToLocal(monitor.scheduler.expiry_at)}` : ""}`, "muted"));
    card.append(node("p", `Session: ${monitor.session_id || "noch nicht primed"}`, "muted"));

    const editor = node("details", "monitor-editor");
    editor.append(node("summary", "Bearbeiten"));
    const form = node("form"); form.noValidate = true;
    const fields = [
      ["title", "Titel", "text"],
      ["interval_seconds", "Intervall (Sekunden)", "number"],
      ["autonomy_profile", "Autonomieprofil", "select"],
      ["runtime_profile", "Monitor-Runtime", "select"],
    ];
    const inputs = {};
    for (const [field, caption, kind] of fields) {
      const label = node("label", caption);
      let input;
      if (kind === "select") {
        input = node("select");
        const options = field === "autonomy_profile" ? autonomyLabels : runtimeLabels;
        for (const [value, text] of Object.entries(options)) input.add(new Option(text, value));
      } else {
        input = node("input"); input.type = kind;
        if (kind === "number") { input.min = "5"; input.max = "86400"; }
      }
      input.value = String(state.draft[field]);
      input.addEventListener("input", () => {
        state.draft[field] = kind === "number" ? Number(input.value) : input.value;
        state.dirty = true;
        feedback.textContent = "Ungespeicherte Änderung.";
      });
      label.append(input); form.append(label);
      inputs[field] = input;
    }
    const feedback = node("p", "", "monitor-feedback muted");
    const actions = node("div", "monitor-actions");
    const save = node("button", "Speichern (CAS)", "button"); save.type = "submit";
    const reload = node("button", "Aktuellen Stand vergleichen", "button secondary"); reload.type = "button";
    const enable = node("button", monitor.scheduler.enabled ? "Takt deaktivieren" : "Takt aktivieren", "button secondary"); enable.type = "button";
    const trigger = node("button", "Jetzt auslösen", "button secondary"); trigger.type = "button";
    const cancel = node("button", "Nächsten Lauf abbrechen", "button secondary"); cancel.type = "button";
    const abort = node("button", "Laufenden Turn abbrechen", "button secondary"); abort.type = "button";
    const remove = node("button", "Löschen", "button secondary"); remove.type = "button";
    const history = node("button", "Verlauf laden", "button secondary"); history.type = "button";
    actions.append(save, reload, enable, trigger, cancel, abort, remove, history);
    form.append(feedback, actions); editor.append(form); card.append(editor);

    form.addEventListener("submit", event => { event.preventDefault(); void saveDraft(state); });
    reload.addEventListener("click", async () => { if (await load(true)) { state.conflict = state.compared = false; state.dirty = false; state.draft = null; renderList(); } });
    enable.addEventListener("click", () => void act(monitor.monitor_id, monitor.scheduler.enabled ? "disable" : "enable"));
    trigger.addEventListener("click", () => void act(monitor.monitor_id, "trigger"));
    cancel.addEventListener("click", () => void act(monitor.monitor_id, "cancel"));
    abort.addEventListener("click", () => {
      if (window.confirm("Abort des laufenden Worker-Turns anfordern? Der Engine verifiziert den tatsächlichen Abbruch; bereits ausgeführte Änderungen bleiben bestehen."))
        void act(monitor.monitor_id, "abort");
    });
    remove.addEventListener("click", () => {
      if (window.confirm("Monitor wirklich löschen? Der Verlauf wird mit entfernt.")) void act(monitor.monitor_id, "delete");
    });
    history.addEventListener("click", () => void loadHistory(monitor.monitor_id));
    if (state.conflict) feedback.textContent = "Registry anderweitig geändert; Entwurf bleibt. Aktuellen Stand vergleichen und bewusst erneut speichern.";
    return card;
  }

  async function load(force) {
    if (loading || writing) return false;
    if (force) { expired = false; }
    loading = true;
    try {
      const { ok, body } = await api("/api/monitor?limit=50");
      if (!ok || !body) throw new Error(body?.error || "Monitorregistry nicht lesbar.");
      snapshot = body;
      nextCursor = body.next_cursor || null;
      renderList();
      return true;
    } catch (error) {
      if (snapshot) { expired = true; $("monitor-status").textContent = `Abruf fehlgeschlagen (${esc(error.message)}); letzte Beobachtung bleibt sichtbar.`; }
      else $("monitor-status").textContent = `Monitorregistry nicht verfügbar: ${esc(error.message)}`;
      return false;
    } finally { loading = false; }
  }

  async function loadMore() {
    if (!nextCursor || loading || writing) return;
    loading = true;
    try {
      const { ok, body } = await api(`/api/monitor?limit=50&cursor=${encodeURIComponent(nextCursor)}`);
      if (!ok || !body) throw new Error(body?.error || "Seite nicht lesbar.");
      snapshot.monitors = snapshot.monitors.concat(body.monitors);
      snapshot.generation = body.generation;
      snapshot.total = body.total;
      snapshot.completeness = body.completeness;
      nextCursor = body.next_cursor || null;
      renderList();
    } finally { loading = false; }
  }

  async function saveDraft(state) {
    if (writing || loading || state.conflict) return;
    const previousFocus = document.activeElement;
    writing = true; state.saving = true;
    try {
      const { ok, body } = await api(`/api/monitor/${state.monitor_id.slice(8)}`, {
        method: "PUT",
        body: JSON.stringify({ generation: snapshot.generation, ...state.draft }),
      });
      if (ok && body?.monitor) {
        state.dirty = false; state.draft = null; expired = false;
        await load(true);
      } else if (body?.code === "MONITOR_REVISION_CONFLICT") {
        state.conflict = true;
        await load(true);
        state.conflict = true; renderList();
      } else {
        uncertain = state.monitor_id;
        $("monitor-status").textContent = `Speichern nicht bestätigt (${esc(body?.code || "Netzwerk")}); zurücklesen und vergleichen, kein automatischer Wiederholungswrite.`;
      }
    } finally {
      writing = false; state.saving = false; renderList();
      if (document.activeElement === document.body && previousFocus?.isConnected) previousFocus.focus();
    }
  }

  async function act(monitorId, action) {
    if (writing || loading) return;
    writing = true;
    try {
      const { ok, body } = await api(`/api/monitor/${monitorId.slice(8)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ generation: snapshot.generation }),
      });
      if (ok) {
        $("monitor-status").textContent = action === "abort"
          ? "Abort angefordert; der Engine verifiziert den nativen Abbruch und schreibt das Ergebnis in den Verlauf."
          : `Aktion ${action} bestätigt (Generation ${body?.generation}).`;
        await load(true);
      } else if (body?.code === "MONITOR_REVISION_CONFLICT") {
        await load(true);
        $("monitor-status").textContent = "Registry anderweitig geändert; aktueller Stand geladen. Aktion bewusst wiederholen.";
      } else {
        $("monitor-status").textContent = `Aktion nicht bestätigt: ${esc(body?.code || body?.error || "unbekannt")}.`;
      }
    } finally { writing = false; }
  }

  async function loadHistory(monitorId) {
    const panel = $("monitor-history");
    panel.hidden = false;
    panel.replaceChildren(node("p", "Verlauf wird geladen …", "muted"));
    const { ok, body } = await api(`/api/monitor/${monitorId.slice(8)}/history?limit=50&include_logs=1`);
    if (!ok || !body) { panel.replaceChildren(node("p", "Verlauf nicht lesbar.", "muted")); return; }
    const head = node("div");
    head.append(node("h3", `Verlauf ${monitorId}`));
    head.append(node("p", `Letzter Lauf: ${body.last_run_at || "unbekannt"} · Nächster Lauf: ${msToLocal(body.next_run_at)} · Frische: ${body.freshness} · Abdeckung: ${body.coverage}`, "muted"));
    panel.replaceChildren(head);
    const list = node("div", "events");
    for (const entry of body.history.slice().reverse()) {
      const item = node("div", `${entry.at} · ${entry.type}${entry.detail ? ` · ${esc(JSON.stringify(entry.detail))}` : ""}`, "event");
      list.append(item);
    }
    if (body.logs?.length) {
      for (const log of body.logs.slice().reverse()) list.append(node("div", `${log.at} · ${log.level} · ${log.message}`, `event ${log.level === "error" ? "error" : ""}`));
    }
    panel.append(list);
  }

  $("monitor-refresh").addEventListener("click", () => void load(true));
  $("monitor-more").addEventListener("click", () => void loadMore());
  window.addEventListener("beforeunload", event => {
    if (uncertain || [...cards.values()].some(state => state.dirty)) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("hub-control-loaded", () => { void load(false); });
  void load(false);
})();