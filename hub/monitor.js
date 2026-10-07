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
  const pad = value => String(value).padStart(2, "0");
  const epochToLocalInput = value => {
    if (!value) return "";
    const date = new Date(Number(value));
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const localInputToEpoch = value => value ? new Date(value).getTime() : null;

  function focusTarget() {
    const active = document.activeElement;
    if (!active || !active.name || !active.closest(".monitor-card")) return null;
    return { id: active.closest(".monitor-card").id, name: active.name };
  }

  function restoreFocus(target) {
    if (!target || document.activeElement !== document.body) return;
    const element = document.querySelector(`#${CSS.escape(target.id)} [name="${CSS.escape(target.name)}"]`);
    if (element) element.focus();
  }

  function fillOptions(select, labels, selected) {
    select.replaceChildren();
    for (const [value, text] of Object.entries(labels)) {
      const option = new Option(text, value);
      option.selected = value === selected;
      select.add(option);
    }
  }

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
    const alive = new Set();
    for (const monitor of snapshot.monitors) { alive.add(monitor.monitor_id); container.append(buildCard(monitor)); }
    for (const id of [...cards.keys()]) if (!alive.has(id)) cards.delete(id);
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
        expiry_at: monitor.scheduler.expiry_at ?? null,
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
    editor.open = Boolean(state.editorOpen);
    editor.addEventListener("toggle", () => { state.editorOpen = editor.open; });
    editor.append(node("summary", "Bearbeiten"));
    const form = node("form"); form.noValidate = true;
    const fields = [
      ["title", "Titel", "text"],
      ["interval_seconds", "Intervall (Sekunden)", "number"],
      ["autonomy_profile", "Autonomieprofil", "select"],
      ["runtime_profile", "Monitor-Runtime", "select"],
      ["expiry_at", "Expiry (optional)", "datetime-local"],
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
      input.name = field;
      input.value = kind === "datetime-local" ? epochToLocalInput(state.draft[field]) : String(state.draft[field] ?? "");
      input.addEventListener("input", () => {
        state.draft[field] = kind === "number" ? Number(input.value)
          : kind === "datetime-local" ? localInputToEpoch(input.value)
          : input.value;
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

  async function load(force, internal) {
    if (loading || (writing && !internal)) return false;
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
    const target = focusTarget();
    writing = true; state.saving = true;
    try {
      const { ok, body } = await api(`/api/monitor/${state.monitor_id.slice(8)}`, {
        method: "PUT",
        body: JSON.stringify({ generation: snapshot.generation, ...state.draft }),
      });
      if (ok && body?.monitor) {
        state.dirty = false; state.draft = null; state.conflict = false; expired = false;
        await load(true, true);
      } else if (body?.code === "MONITOR_REVISION_CONFLICT") {
        state.conflict = true;
        await load(true, true);
        state.conflict = true; renderList();
      } else {
        uncertain = state.monitor_id;
        $("monitor-status").textContent = `Speichern nicht bestätigt (${esc(body?.code || "Netzwerk")}); zurücklesen und vergleichen, kein automatischer Wiederholungswrite.`;
      }
    } finally {
      writing = false; state.saving = false; renderList(); restoreFocus(target);
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
        await load(true, true);
      } else if (body?.code === "MONITOR_REVISION_CONFLICT") {
        await load(true, true);
        $("monitor-status").textContent = "Registry anderweitig geändert; aktueller Stand geladen. Aktion bewusst wiederholen.";
      } else {
        $("monitor-status").textContent = `Aktion nicht bestätigt: ${esc(body?.code || body?.error || "unbekannt")}.`;
      }
    } finally { writing = false; renderList(); }
  }

  async function createMonitor(event) {
    event.preventDefault();
    if (writing || loading) return;
    const feedback = $("monitor-create-feedback");
    const form = $("monitor-create-form");
    const title = $("monitor-create-title").value.trim();
    const taskId = $("monitor-create-task").value.trim();
    const interval = Number($("monitor-create-interval").value || 60);
    const autonomy = $("monitor-create-autonomy").value;
    const runtime = $("monitor-create-runtime").value;
    const expiry = localInputToEpoch($("monitor-create-expiry").value);
    writing = true;
    try {
      const { ok, status, body } = await api("/api/monitor", {
        method: "POST",
        body: JSON.stringify({ title, task_id: taskId, interval_seconds: interval, autonomy_profile: autonomy, runtime_profile: runtime, expiry_at: expiry }),
      });
      if (ok && body?.monitor) {
        const monitorId = body.monitor.monitor_id;
        const detail = await api(`/api/monitor/${monitorId.slice(8)}`);
        const created = detail.ok ? detail.body?.monitor : null;
        await load(true, true);
        feedback.textContent = created
          ? `Erstellt und zurückgelesen: ${created.monitor_id} · Takt ${created.scheduler.interval_seconds} s · ${autonomyLabels[created.autonomy_profile]} · Runtime ${runtimeLabels[created.runtime_profile]}${created.scheduler.expiry_at ? ` · Expiry ${msToLocal(created.scheduler.expiry_at)}` : ""} · Generation ${snapshot.generation}.`
          : `Erstellt (${monitorId}); Rücklesen ausstehend.`;
        form.reset();
        fillOptions($("monitor-create-autonomy"), autonomyLabels, "mvp");
        fillOptions($("monitor-create-runtime"), runtimeLabels, "deep");
      } else {
        feedback.textContent = `Erstellen nicht bestätigt (${esc(body?.code || status || "Netzwerk")}); Eingaben bleiben stehen.`;
      }
    } finally { writing = false; renderList(); }
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
  fillOptions($("monitor-create-autonomy"), autonomyLabels, "mvp");
  fillOptions($("monitor-create-runtime"), runtimeLabels, "deep");
  $("monitor-create-form").addEventListener("submit", event => { void createMonitor(event); });
  window.addEventListener("beforeunload", event => {
    if (uncertain || [...cards.values()].some(state => state.dirty)) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("hub-control-loaded", () => { void load(false); });
  void load(false);
})();