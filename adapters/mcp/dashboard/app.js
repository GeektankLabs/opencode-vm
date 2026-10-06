"use strict";
const byId = id => document.getElementById(id);
const labels = { running: "Läuft", retry: "Retry", input_required: "Input erforderlich", idle: "Leerlauf", submitted: "Eingereicht", unknown: "Unbekannt", completed: "Turn abgeschlossen", aborted: "Turn abgebrochen", failed: "Turn fehlgeschlagen" };
let snapshot, filter = "all", busy = false, timer, lastAttention = "";
const rows = new Map();
function node(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text) value.textContent = text; return value; }
function runtimeText(runtime) { return runtime ? `${runtime.provider_id || "Provider unbekannt"} / ${runtime.model_id || "Modell unbekannt"} / ${runtime.variant ?? "Denkstufe unbekannt"}` : "Runtime unbekannt"; }
function sessionLink(s) {
  const n = snapshot.navigation;
  if (!n || !Number.isInteger(n.web_port)) return null;
  const base = `https://${location.hostname}:${n.web_port}`;
  if (n.opencode_version !== "1.18.34") return { href: base, text: "OpenCode (Route unverifiziert)" };
  const key = btoa(base).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return { href: `${base}/server/${key}/session/${encodeURIComponent(s.session_id)}`, text: "Session öffnen" };
}
function renderSession(s, key, parent) {
  let row = rows.get(key);
  if (!row) {
    row = node("div", "session"); row.dataset.key = key; row.dataset.sessionId = s.session_id;
    for (const name of ["title", "status", "runtime", "meta", "turns"]) { const child = node("p", name === "title" ? "" : name); child.dataset.field = name; row.append(child); }
    const link = node("a"); link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link);
    parent.append(row); rows.set(key, row);
  }
  const field = name => row.querySelector(`[data-field=${name}]`);
  field("title").textContent = `${s.title} · ${s.kind === "child" ? "Child" : s.kind === "manager" ? "Managementsession" : "Session"}`;
  field("status").textContent = `${labels[s.state] ?? s.state}${s.freshness !== "fresh" ? " · veraltet / letzter Stand" : ""}${s.anomaly ? " · archiviert und aktiv!" : ""}`;
  field("status").dataset.state = s.state;
  const latest = s.turns.at(-1);
  field("runtime").textContent = `Einstellung: ${runtimeText(s.current_runtime)} · ${s.state === "idle" ? "Zuletzt belegt" : "Turn belegt"}: ${runtimeText(latest?.runtime)}${s.freshness !== "fresh" ? " · stale" : ""}`;
  const other = [...new Set(s.associations.map(a => a.task_id))];
  field("meta").textContent = `${s.session_id}${s.parent_session_id ? ` · Parent ${s.parent_session_id}` : ""}${s.binding_state === "unknown" ? " · Taskzuordnung unbekannt" : s.binding_state === "unbound" ? " · Ohne Task" : other.length > 1 ? ` · Mehrfachbindung: ${other.join(", ")}` : ""}${s.associations.some(a => a.scope === "parent_indirect") ? " · indirekte Parentbindung" : ""}${s.current_turn_unbound ? " · aktueller Turn nicht zugeordnet" : ""}`;
  field("turns").textContent = s.turns.map(t => `${t.user_message_id}: ${labels[t.state] ?? t.state}${t.finish ? ` (${t.finish})` : ""}`).join(" · ");
  const link = row.querySelector("a"), target = sessionLink(s);
  if (target) { link.href = target.href; link.textContent = target.text; link.hidden = false; } else { link.removeAttribute("href"); link.textContent = "Navigation unbekannt"; }
  row.hidden = filter === "attention" ? !["input_required", "unknown"].includes(s.state) && !s.anomaly : filter === "running" ? !["running", "retry", "submitted"].includes(s.state) : false;
  return key;
}
function render() {
  const focused = document.activeElement;
  const focusedKey = focused?.closest(".session")?.dataset.sessionId;
  const scroll = window.scrollY;
  const keys = new Set(), active = snapshot.sessions.filter(s => s.operational);
  byId("project").textContent = `${snapshot.project.name} · Repo Live`;
  const c = snapshot.counts;
  byId("counts").textContent = `${c.active_sessions ?? `≥${c.known_active_sessions} (Coverage unvollständig)`} aktive Sessions · ${c.active_tasks ?? "?"} Tasks · ${c.attention_sessions ?? "?"} Attention`;
  byId("error").textContent = Object.entries(snapshot.sources).filter(([,s]) => s.state !== "fresh").map(([name,s]) => `${name}: ${s.state} (${s.error ?? "Datenalter"})`).join(" · ");
  for (const task of snapshot.tasks) {
    const matching = active.filter(s => s.associations.some(a => a.task_id === task.task_id));
    if (!matching.length) continue;
    const key = `task:${task.task_id}`;
    let card = rows.get(key);
    if (!card) { card = node("article"); card.append(node("h2"), node("p", "meta")); byId("work").append(card); rows.set(key,card); }
    keys.add(key);
    card.querySelector("h2").textContent = task.title;
    card.querySelector(".meta").textContent = `${task.task_id} · Board: ${task.board_status}${task.board_status === "done" ? " · aktive Session trotz Done" : ""}`;
    for (const s of matching) keys.add(renderSession(s,`${key}:${s.session_id}`,card));
    card.hidden = [...card.querySelectorAll(".session")].every(row => row.hidden);
  }
  for (const s of snapshot.sessions) {
    if (s.archived && !s.operational) continue;
    if (s.operational && s.associations.length) continue;
    keys.add(renderSession(s,`${s.operational ? "standalone" : "idle"}:${s.session_id}`,byId(s.operational ? "work" : "idle")));
  }
  for (const s of snapshot.unknown_sessions ?? []) {
    keys.add(renderSession({ ...s, kind:s.parent_session_id ? "child" : "root", state:"unknown", freshness:"stale",
      turns:[], current_runtime:null, associations:[], binding_state:"unknown", current_turn_unbound:null },`unknown:${s.session_id}`,byId("work")));
  }
  for (const [key,row] of rows) if (!keys.has(key)) { row.remove(); rows.delete(key); }
  byId("others").querySelector("summary").textContent = `Weitere Sessions (${snapshot.sessions.filter(s => !s.operational && !s.archived).length})`;
  const recent = snapshot.sessions.flatMap(s => s.turns.filter(t => ["completed","failed","aborted"].includes(t.state)).map(t => `${s.title}: ${labels[t.state]} · ${t.user_message_id}`)).slice(-10);
  byId("recent").textContent = recent.join(" · ") || "Keine belegte jüngste Aktivität im Lesefenster";
  if (snapshot.navigation?.board_port) { byId("board").href = `http://${location.hostname}:${snapshot.navigation.board_port}`; byId("board").target = "_blank"; byId("board").rel = "noopener noreferrer"; }
  const attention = JSON.stringify(snapshot.attention);
  if (attention !== lastAttention) { byId("announcement").textContent = `${c.attention_sessions ?? "Unbekannte Anzahl"} Sessions benötigen Aufmerksamkeit`; lastAttention = attention; }
  age();
  if (focusedKey && !focused.isConnected) {
    const replacement = [...document.querySelectorAll(".session")].find(row => row.dataset.sessionId === focusedKey);
    replacement?.querySelector("a")?.focus({preventScroll:true});
    window.scrollTo(0,scroll);
  }
}
function age() {
  if (!snapshot) return;
  byId("freshness").textContent = ["sessions","board"].map(name => {
    const s=snapshot.sources[name];return `${name}: ${s.observed_at ? `${Math.max(0,Math.round((Date.now()-Date.parse(s.observed_at))/1000))} s` : "unbekannt"}`;
  }).join(" · ");
  byId("source-details").textContent = Object.entries(snapshot.sources).map(([name,s]) => `${name}: ${s.observed_at ?? "unbekannt"} · ${s.state} · ${s.complete ? "vollständig" : "Coverage unvollständig"}`).join(" · ");
}
async function poll() {
  if (busy) return; busy = true; clearTimeout(timer);
  try { const response = await fetch("/api/v1/status", { cache:"no-store", signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error("Quellen nicht erreichbar"); snapshot = await response.json(); render(); }
  catch { byId("error").textContent = "Verbindung unterbrochen · letzter bekannter Stand, kein aktueller Laufclaim"; if(!byId("counts").textContent.startsWith("Letzter"))byId("counts").textContent="Letzter bekannter Stand · "+byId("counts").textContent; document.querySelectorAll(".status").forEach(p => p.textContent = "Unbekannt · Verbindung unterbrochen"); }
  finally {
    busy = false;
    // Align visible cache reads just after the producer's next 5s observation;
    // independent 5s phases otherwise add almost 10s end-to-end latency.
    const observed = Date.parse(snapshot?.sources.sessions.observed_at ?? "");
    const delay = Number.isFinite(observed) ? 5100 - ((Date.now()-observed) % 5000) : 5000;
    timer = setTimeout(poll,document.hidden ? 30000 : Math.max(100,delay));
  }
}
for (const id of ["all","attention","running"]) byId(id).addEventListener("click",()=> { filter=id; for (const n of ["all","attention","running"]) byId(n).setAttribute("aria-pressed",String(n===id)); if(snapshot)render(); });
document.addEventListener("visibilitychange",()=> { if(!document.hidden)void poll(); }); window.addEventListener("focus",()=>void poll());
setInterval(age,1000); void poll();
