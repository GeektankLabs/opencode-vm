"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const labels = { not_configured: "Nicht eingerichtet / aktiviert", unverified: "Konfiguriert · nicht bestätigt", not_ready: "Nicht bereit / eingeschränkt", ready: "Bereit · lokal geprüft" };
  const help = {
    "secure-mcp-tunnel": { setup: ["OpenAI Tunnel und eingeschränkten Tunnel API-Key anlegen.", "Im Projekt: opencode-vm provider mcp new openai"],
      operation: ["Projekt-Session bereitstellen: opencode-vm web", "Status prüfen: opencode-vm provider mcp status openai", "Adaptermarker bestätigen keine Tunnelverbindung; externer Client ist separat zu prüfen."] },
    "incoming-mcp": { setup: ["Projekt-Session mit opencode-vm web starten; MCP ist standardmäßig aktiviert."],
      operation: ["Bei bewusstem --no-mcp: normal neu verbinden, ohne diese Unterdrückung.", "Projekt, Generation und privaten authentifizierten MCP-Healthcheck prüfen; TCP allein genügt nicht.", "Kein Credential wird im Hub angezeigt."] },
    a2a: { setup: ["Projekt-Websession starten: opencode-vm web"], operation: ["Hostdiagnose: opencode-vm a2a status", "Vertrag bei Bedarf mit opencode-vm a2a check prüfen (enthält einen echten Auftrag).", "Profile werden von A2A noch nicht verwendet; lokaler Healthcheck ist keine LAN-/Clientabnahme."] },
    openlive: { setup: ["Hostbridge einrichten: opencode-vm openlive install"], operation: ["Projekt-Websession bereitstellen: opencode-vm web", "Hostdiagnose: opencode-vm openlive status / opencode-vm openlive doctor", "Call im OpenLive-Client starten. Der Hub überwacht keine Voice-Calls; Profile werden noch nicht verwendet."] }
  };
  let model, loading = false;
  const cards = {};
  function skillHtml(skill) {
    return skill.revision ? `<p>${esc(skill.name)} · Revision ${esc(skill.revision)}. Instruction-only Paket, getrennt vom Connector; installierte Clientrevision unbekannt.</p><p class="checksum">SHA-256: ${esc(skill.sha256)}</p><div class="skill-actions"><a href="${esc(skill.download)}" target="_blank" rel="noreferrer">Paket herunterladen</a><a href="${esc(skill.docs)}" target="_blank" rel="noreferrer">Importhilfe</a></div>` : "<p>Keine Skill-Metadaten verfügbar; siehe integrations/chatgpt im Repository.</p>";
  }
  function render() {
    $("updated").textContent = `Abgerufen ${new Date(model.generatedAt).toLocaleTimeString("de-DE")}`;
    $("connection-count").textContent = `${model.integrations.filter(item => item.configured === true).length} konfiguriert · 4 Typen`;
    for (const item of model.integrations) {
      let card = cards[item.id];
      if (!card) {
        card = cards[item.id] = document.createElement("article"); card.className = "card connection-card"; card.id = `connection-${item.id}`;
        card.innerHTML = `<h3>${esc(item.name)}</h3><p class="badge"></p><p class="reason"></p><p class="scope muted"></p><details class="connection-help"><summary></summary><div class="help-content"></div></details><a class="log-link" href="#logs">Passende Logs</a>${item.id === "secure-mcp-tunnel" ? '<details class="client-skill"><summary>Client &amp; Skill</summary><div class="skill-content"></div></details>' : ""}`;
        card.querySelector(".log-link").addEventListener("click", () => { $("log-source").value = item.id; renderEvents(); });
        $("connections").append(card);
      }
      const badge = card.querySelector(".badge"); badge.className = `badge ${item.state === "ready" ? "healthy" : item.state === "not_ready" ? "warning" : "unknown"}`;
      badge.textContent = item.configured === null ? "Status nicht bestätigt" : labels[item.state];
      card.querySelector(".reason").textContent = item.statusReason;
      card.querySelector(".scope").textContent = `Prüfumfang: ${item.checkScope} · Beobachtung ${new Date(item.lastCheck).toLocaleTimeString("de-DE")}`;
      const details = card.querySelector(".connection-help");
      details.querySelector("summary").textContent = item.state === "not_configured" ? "Einrichtung anzeigen" : item.state === "ready" ? "Betrieb & erneute Prüfung" : "Statusprüfung / nächste Schritte";
      const steps = item.state === "not_configured" ? help[item.id].setup : help[item.id].operation;
      details.querySelector(".help-content").innerHTML = `<ol>${steps.map(step => `<li>${esc(step)}</li>`).join("")}</ol><a href="https://github.com/GeektankLabs/opencode-vm/blob/main/${esc(item.setupRef)}" target="_blank" rel="noreferrer">Dokumentation</a>`;
      if (!card.dataset.initialized) { details.open = ["not_configured", "not_ready"].includes(item.state); card.dataset.initialized = "1"; }
      card.querySelector(".log-link").textContent = item.logCapability ? "Zu passenden Logs" : "Logabdeckung ansehen (keine Hubquelle)";
      if (item.id === "secure-mcp-tunnel") card.querySelector(".skill-content").innerHTML = skillHtml(model.skill);
    }
    const source = $("log-source"), selected = source.value;
    source.replaceChildren(new Option("Alle verfügbaren Quellen", "all"));
    for (const item of model.integrations) source.add(new Option(item.name, item.id));
    source.value = selected; renderEvents();
  }
  function renderEvents() {
    if (!model) return;
    const source = $("log-source").value;
    const events = model.events.filter(event => source === "all" || event.source === source);
    $("log-coverage").textContent = `Verfügbare Quellen: ${model.security.allowedLogSources.join(", ") || "keine"}. Begrenzter Auszug, maximal 12 Einträge. Zeiten sind Hub-Abrufzeiten, keine garantierten Originalzeitstempel.`;
    $("events").innerHTML = events.length ? events.map(event => `<div class="event ${event.severity === "error" ? "error" : ""}"><div class="event-head"><span>${esc(event.severity.toUpperCase())} · ${esc(event.source)}</span></div>${esc(event.message)}</div>`).join("") : '<p class="empty">Keine Einträge aus dieser Hub-Logabdeckung. Das beweist weder Bereitschaft noch Fehlerfreiheit.</p>';
  }
  async function load() {
    if (loading) return; loading = true;
    try { const response = await fetch("/api/read-model", { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(); model = await response.json(); render();
    } catch { $("updated").textContent = "Statusabruf fehlgeschlagen; letzte Beobachtung bleibt erhalten."; }
    finally { loading = false; }
  }
  // One control snapshot shares the MCP health probe with connection diagnosis.
  // Policy/transport failures still permit an independent read-only diagnostic read.
  window.addEventListener("hub-control-loaded", event => { if (event.detail) { model = event.detail; render(); } else void load(); });
  window.addEventListener("hub-control-unavailable", load);
  $("log-source").addEventListener("change", renderEvents);
})();
