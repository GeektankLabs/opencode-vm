"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const workLabels = { active: "aktiv", parked_input_required: "Parked · Input erforderlich", complete_pass: "Abgeschlossen", stopped: "Gestoppt" };
  const autonomyLabels = { conservative: "Conservative", sandbox: "Sandbox (Autonomie, keine Isolation)", mvp: "MVP (Standard)", yolo: "YOLO" };
  const runtimeLabels = { deep: "Deep", standard: "Standard", execution: "Execution", design: "Design", review: "Review" };
  const fieldCaptions = { interval_seconds: "Intervall", autonomy_profile: "Autonomieprofil", runtime_profile: "Monitor-Runtime", expiry_at: "Expiry" };
  let snapshot = null, nextCursor = null, loading = false, writing = false, uncertain = null, expired = false;
  let candidates = [], candidateTitles = new Map(), candidatesStale = false;
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
  const readField = (kind, input) => kind === "number" ? Number(input.value)
    : kind === "datetime-local" ? localInputToEpoch(input.value)
    : input.value;

  function newState(id) {
    return { monitor_id: id, draft: null, pending: new Set(), conflict: false, saving: false,
      editorOpen: false, detailsOpen: false, touched: false, feedback: "", historyEntries: [], historyStatus: "" };
  }

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

  function setFeedback(state, text) {
    state.feedback = text;
    const card = document.getElementById(`monitor-${state.monitor_id}`);
    const element = card?.querySelector(".monitor-feedback");
    if (element) element.textContent = text;
  }

  function summaryText() {
    return `${snapshot.monitors.length} von ${snapshot.total} Monitor(en) · Registry-Generation ${snapshot.generation}`;
  }

  function renderList() {
    const container = $("monitor-cards");
    container.replaceChildren();
    const alive = new Set();
    for (const monitor of snapshot.monitors) { alive.add(monitor.monitor_id); container.append(buildCard(monitor)); }
    for (const id of [...cards.keys()]) if (!alive.has(id)) cards.delete(id);
    $("monitor-status").textContent = expired
      ? `${summaryText()} · Abruf abgelaufen; MCP als Wahrheit lesen.`
      : summaryText();
    $("monitor-more").hidden = !nextCursor;
  }

  function renderHistory(state, list) {
    list.replaceChildren();
    for (const entry of state.historyEntries.slice(0, 80)) {
      list.append(node("div", `${entry.at} · ${entry.text}`, `event${entry.error ? " error" : ""}`));
    }
    if (!state.historyEntries.length) list.append(node("p", "Keine Einträge.", "muted"));
  }

  function buildCard(monitor) {
    const state = cards.get(monitor.monitor_id) || newState(monitor.monitor_id);
    cards.set(monitor.monitor_id, state);
    if (!state.draft) {
      state.draft = {
        interval_seconds: monitor.scheduler.interval_seconds,
        autonomy_profile: monitor.autonomy_profile,
        runtime_profile: monitor.runtime_profile,
        expiry_at: monitor.scheduler.expiry_at ?? null,
      };
    }
    const card = node("article", "", "card monitor-card");
    card.id = `monitor-${monitor.monitor_id}`;
    card.append(node("h3", monitor.title));
    const badges = node("p", "", "monitor-badges");
    badges.append(node("span", monitor.scheduler.enabled ? "Aktiv" : "Pausiert", `badge ${monitor.scheduler.enabled ? "healthy" : "unknown"}`));
    badges.append(document.createTextNode(" "));
    badges.append(node("span", `Arbeitszustand: ${workLabels[monitor.work_state] || monitor.work_state}`, `badge ${monitor.work_state === "active" ? "healthy" : monitor.work_state === "parked_input_required" ? "warning" : "unknown"}`));
    if (monitor.run_active) { badges.append(document.createTextNode(" ")); badges.append(node("span", "Lauf aktiv", "badge warning")); }
    if (monitor.abort_requested) { badges.append(document.createTextNode(" ")); badges.append(node("span", "Abort angefordert", "badge warning")); }
    card.append(badges);
    card.append(node("p", `Anker: ${monitor.anchor_task_id}`, "muted"));
    if (monitor.parked_reason) card.append(node("p", `Parkgrund: ${monitor.parked_reason}`, "muted"));
    card.append(node("p", `Takt ${monitor.scheduler.interval_seconds} s · ${autonomyLabels[monitor.autonomy_profile]} · Runtime ${runtimeLabels[monitor.runtime_profile]}`, "muted"));
    card.append(node("p", `Nächster Lauf: ${msToLocal(monitor.scheduler.next_run_at)} · Letzter Lauf: ${monitor.last_run_at ? new Date(monitor.last_run_at).toLocaleString("de-DE") : "unbekannt"} · Frische: ${freshness(monitor)}${monitor.scheduler.expiry_at ? ` · Expiry ${msToLocal(monitor.scheduler.expiry_at)}` : ""}`, "muted"));
    card.append(node("p", `Session: ${monitor.session_id || "noch nicht primed"}`, "muted"));

    const actions = node("div", "", "monitor-actions");
    const toggle = node("button", monitor.scheduler.enabled ? "Takt deaktivieren" : "Takt aktivieren", "button secondary"); toggle.type = "button";
    const trigger = node("button", "Jetzt auslösen", "button secondary"); trigger.type = "button";
    const remove = node("button", "Löschen", "button secondary"); remove.type = "button";
    actions.append(toggle, trigger, remove);
    card.append(actions);
    const feedback = node("p", state.feedback || "", "monitor-feedback muted"); feedback.setAttribute("role", "status");
    card.append(feedback);

    const details = node("details", "", "monitor-details");
    details.open = Boolean(state.detailsOpen);
    details.addEventListener("toggle", () => {
      if (details.open === state.detailsOpen) return;
      state.detailsOpen = details.open;
      if (details.open) void loadHistory(state);
    });
    details.append(node("summary", "Details"));
    const detailsHead = node("div", "", "monitor-details-head");
    const historyStatus = node("span", state.historyStatus || "Verlauf wird beim Aufklappen geladen.", "muted monitor-history-status");
    const historyRefresh = node("button", "Aktualisieren", "button secondary monitor-details-refresh"); historyRefresh.type = "button";
    historyRefresh.addEventListener("click", () => void loadHistory(state));
    detailsHead.append(historyStatus, historyRefresh);
    const historyList = node("div", "", "events monitor-history");
    renderHistory(state, historyList);
    details.append(detailsHead, historyList);
    card.append(details);

    const editor = node("details", "", "monitor-editor");
    editor.open = Boolean(state.editorOpen);
    editor.addEventListener("toggle", () => { state.editorOpen = editor.open; });
    editor.append(node("summary", "Bearbeiten"));
    const form = node("form"); form.noValidate = true;
    const fieldset = node("fieldset"); fieldset.append(node("legend", "Änderungen speichern automatisch nach gültiger Eingabe."));
    const grid = node("div", "", "monitor-grid");
    const fields = [
      ["interval_seconds", "Intervall (Sekunden)", "number"],
      ["autonomy_profile", "Autonomieprofil", "select"],
      ["runtime_profile", "Monitor-Runtime", "select"],
      ["expiry_at", "Expiry (optional)", "datetime-local"],
    ];
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
        state.draft[field] = readField(kind, input);
        state.touched = true;
        setFeedback(state, "Ungespeicherte Änderung.");
      });
      input.addEventListener("change", () => {
        state.draft[field] = readField(kind, input);
        state.pending.add(field);
        state.conflict = false;
        state.touched = true;
        setFeedback(state, `${fieldCaptions[field]} wird gespeichert …`);
        void flush(state);
      });
      label.append(input); grid.append(label);
    }
    fieldset.append(grid); form.append(fieldset); editor.append(form); card.append(editor);

    toggle.addEventListener("click", () => void act(state, monitor.scheduler.enabled ? "disable" : "enable"));
    trigger.addEventListener("click", () => void act(state, "trigger"));
    remove.addEventListener("click", () => {
      if (window.confirm("Monitor wirklich löschen? Der Verlauf wird mit entfernt.")) void act(state, "delete");
    });
    return card;
  }

  async function flush(state) {
    if (writing || loading || state.saving || state.conflict || !state.pending.size) return;
    const fields = [...state.pending];
    const payload = {};
    for (const field of fields) payload[field] = state.draft[field];
    const target = focusTarget();
    writing = true; state.saving = true;
    try {
      const { status, ok, body } = await api(`/api/monitor/${state.monitor_id.slice(8)}`, {
        method: "PUT",
        body: JSON.stringify({ generation: snapshot.generation, ...payload }),
      });
      if (ok && body?.monitor) {
        for (const field of fields) state.pending.delete(field);
        state.conflict = false;
        await load(true, true);
        if (!state.pending.size && !state.conflict) {
          state.draft = null; state.touched = false; state.editorOpen = false;
          setFeedback(state, `Gespeichert · Generation ${snapshot.generation}.`);
        } else if (state.pending.size) {
          void flush(state);
        }
      } else if (body?.code === "MONITOR_REVISION_CONFLICT") {
        state.conflict = true;
        await load(true, true);
        state.conflict = true;
        setFeedback(state, "Registry anderweitig geändert; dein Entwurf bleibt. Eine weitere bewusste Änderung speichert erneut.");
      } else {
        uncertain = state.monitor_id;
        setFeedback(state, `Speichern nicht bestätigt (${esc(body?.code || status || "Netzwerk")}); zurücklesen und vergleichen, kein automatischer Wiederholungswrite.`);
      }
    } finally {
      writing = false; state.saving = false; renderList(); restoreFocus(target);
    }
  }

  async function act(state, action) {
    if (writing || loading) return;
    writing = true;
    try {
      const { ok, body } = await api(`/api/monitor/${state.monitor_id.slice(8)}/${action}`, {
        method: "POST",
        body: JSON.stringify({ generation: snapshot.generation }),
      });
      if (ok) {
        setFeedback(state, `Aktion ${action} bestätigt (Generation ${body?.generation}).`);
        await load(true, true);
      } else if (body?.code === "MONITOR_REVISION_CONFLICT") {
        await load(true, true);
        setFeedback(state, "Registry anderweitig geändert; aktueller Stand geladen. Aktion bewusst wiederholen.");
      } else {
        setFeedback(state, `Aktion nicht bestätigt: ${esc(body?.code || body?.error || "unbekannt")}.`);
      }
    } finally { writing = false; renderList(); }
  }

  async function loadHistory(state) {
    const card = document.getElementById(`monitor-${state.monitor_id}`);
    const status = card?.querySelector(".monitor-history-status");
    const list = card?.querySelector(".monitor-history");
    const button = card?.querySelector(".monitor-details-refresh");
    if (!card || !list || !button || button.disabled) return;
    button.disabled = true; button.textContent = "Aktualisiere …";
    state.historyStatus = "Verlauf wird geladen …";
    if (status) status.textContent = state.historyStatus;
    try {
      const { ok, body } = await api(`/api/monitor/${state.monitor_id.slice(8)}/history?limit=50&include_logs=1`);
      if (!ok || !body) throw new Error(body?.error || "Verlauf nicht lesbar.");
      const entries = [];
      for (const entry of body.history.slice().reverse()) {
        entries.push({ at: entry.at, text: `${entry.type}${entry.detail ? ` · ${JSON.stringify(entry.detail)}` : ""}`, error: false });
      }
      for (const log of (body.logs || []).slice().reverse()) {
        entries.push({ at: log.at, text: `${log.level} · ${log.message}`, error: log.level === "error" });
      }
      state.historyEntries = entries;
      state.historyStatus = `Stand ${new Date().toLocaleTimeString("de-DE")} · Abdeckung ${body.coverage} · Letzter Lauf ${body.last_run_at || "unbekannt"}`;
      if (status) status.textContent = state.historyStatus;
      renderHistory(state, list);
      button.textContent = "Aktualisieren";
    } catch (error) {
      state.historyStatus = `Verlauf nicht lesbar: ${error.message}`;
      if (status) status.textContent = state.historyStatus;
      button.textContent = "Aktualisieren";
    } finally { button.disabled = false; }
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
      return true;
    } finally { loading = false; }
  }

  function updateCreateState() {
    const select = $("monitor-create-task");
    const valid = Boolean(select.value) && (candidates.some(item => item.task_id === select.value) || candidatesStale);
    $("monitor-create-form").querySelector('button[type="submit"]').disabled = writing || !valid;
  }

  async function loadCandidates() {
    const select = $("monitor-create-task");
    const status = $("monitor-create-candidates-status");
    status.textContent = "Mastertasks werden geladen …";
    const previous = select.value;
    const previousTitle = candidateTitles.get(previous);
    try {
      const { ok, body } = await api("/api/monitor/candidates");
      if (!ok || !body || !Array.isArray(body.candidates)) throw new Error(body?.error || "Liste nicht lesbar.");
      candidates = body.candidates;
      candidatesStale = false;
      candidateTitles = new Map(candidates.map(item => [item.task_id, item.title]));
      select.replaceChildren(...(candidates.length
        ? [new Option("— Bitte wählen —", ""), ...candidates.map(item => new Option(`${item.title} · ${item.task_id}`, item.task_id))]
        : [new Option("Keine offenen deklarierten Mastertasks/Work Packages ohne Monitorbindung", "")]));
      const previousValid = Boolean(previous) && candidates.some(item => item.task_id === previous);
      if (previousValid) select.value = previous;
      if (previous && !previousValid) {
        status.textContent = `Die bisherige Auswahl${previousTitle ? ` „${previousTitle}“` : ""} ist nicht mehr verfügbar (inzwischen abgeschlossen oder an einen Monitor gebunden). Bitte eine gültige Auswahl treffen.`;
      } else {
        status.textContent = candidates.length
          ? `${candidates.length} offene deklarierte Mastertask(s) ohne Monitorbindung.`
          : "Keine offenen deklarierten Mastertasks/Work Packages ohne Monitorbindung gefunden.";
      }
      updateCreateState();
      return true;
    } catch (error) {
      candidatesStale = true;
      status.textContent = `Mastertask-Liste nicht aktuell: ${error.message}. Vorhandene Optionen bleiben sichtbar; die Anlage prüft die Bindung erneut.`;
      updateCreateState();
      return false;
    }
  }

  async function createMonitor(event) {
    event.preventDefault();
    if (writing || loading) return;
    const select = $("monitor-create-task");
    const taskId = select.value;
    const title = candidateTitles.get(taskId);
    const feedback = $("monitor-create-feedback");
    if (!taskId || !title) {
      feedback.textContent = "Bitte einen gültigen Mastertask/Work Package auswählen.";
      return;
    }
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
        await loadCandidates();
        $("monitor-create").open = false;
        $("monitor-status").textContent = `${summaryText()} · Monitor „${title}“ erstellt (Generation ${snapshot.generation}).`;
        feedback.textContent = created
          ? `Erstellt und zurückgelesen: ${created.monitor_id} · Takt ${created.scheduler.interval_seconds} s · ${autonomyLabels[created.autonomy_profile]} · Runtime ${runtimeLabels[created.runtime_profile]}${created.scheduler.expiry_at ? ` · Expiry ${msToLocal(created.scheduler.expiry_at)}` : ""}.`
          : `Erstellt (${monitorId}); Rücklesen ausstehend.`;
        $("monitor-create-form").reset();
        fillOptions($("monitor-create-autonomy"), autonomyLabels, "mvp");
        fillOptions($("monitor-create-runtime"), runtimeLabels, "deep");
        updateCreateState();
      } else if (body?.code === "MONITOR_TASK_BOUND") {
        feedback.textContent = `Dieser Mastertask ist bereits an einen Monitor gebunden${body.monitor_id ? ` (${body.monitor_id})` : ""}. Bitte „Aktualisieren“ und einen anderen Task wählen.`;
      } else {
        feedback.textContent = `Erstellen nicht bestätigt (${esc(body?.code || status || "Netzwerk")}); Eingaben bleiben stehen.`;
      }
    } finally { writing = false; }
  }

  async function refreshAll() {
    const button = $("monitor-refresh");
    if (button.disabled) return;
    button.disabled = true; button.textContent = "Aktualisiere …";
    try {
      const monitorsOk = await load(true);
      const candidatesOk = await loadCandidates();
      if (monitorsOk) {
        const stamp = new Date().toLocaleTimeString("de-DE");
        $("monitor-status").textContent = `${summaryText()} · Zuletzt erfolgreich aktualisiert ${stamp}${candidatesOk ? "" : " · Mastertask-Liste nicht aktuell"}`;
      }
    } finally {
      button.disabled = false; button.textContent = "Aktualisieren";
    }
  }

  $("monitor-refresh").addEventListener("click", () => void refreshAll());
  $("monitor-more").addEventListener("click", () => void loadMore());
  fillOptions($("monitor-create-autonomy"), autonomyLabels, "mvp");
  fillOptions($("monitor-create-runtime"), runtimeLabels, "deep");
  $("monitor-create-task").addEventListener("change", () => { updateCreateState(); $("monitor-create-feedback").textContent = "Der Titel wird beim Anlegen automatisch aus dem gewählten Mastertask übernommen."; });
  $("monitor-create-form").addEventListener("submit", event => { void createMonitor(event); });
  window.addEventListener("beforeunload", event => {
    if (uncertain || [...cards.values()].some(state => state.touched || state.pending.size)) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("hub-control-loaded", () => { void load(false); });
  void load(false);
  void loadCandidates();
})();