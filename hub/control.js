"use strict";
(() => {
  const names = { deep: "Deep · Architektur & schwierige Fehler", standard: "Standard · Entwicklungsarbeit", execution: "Execution · klare Ausführung" };
  const $ = (id) => document.getElementById(id);
  let snapshot;
  const add = (select, text, value) => select.add(new Option(text, value));

  function render() {
    const { policy, catalog, validation, capabilities, catalogStatus } = snapshot;
    $("control-status").textContent = `Katalog: ${catalogStatus} · Revision ${policy.revision} · Profil-Capability: Supported: MCP; A2A ${capabilities.a2a}; OpenLive ${capabilities.openlive}.`;
    const catalogBox = $("control-catalog"); catalogBox.replaceChildren();
    const heading = document.createElement("h3"); heading.textContent = "Verbundene Provider & Modelle"; catalogBox.append(heading);
    const description = document.createElement("p"); description.className = "muted";
    description.textContent = catalog ? `${catalog.providers.length} Provider · ${catalog.models.length} Modelle · Varianten aus OpenCode` : "Modellkatalog nicht verfügbar. Gespeicherte Profile bleiben unverändert.";
    catalogBox.append(description);
    if (catalog) {
      const providers = document.createElement("p"); providers.className = "muted";
      providers.textContent = catalog.providers.map(item => item.name).join(" · "); catalogBox.append(providers);
    }

    const container = $("control-profiles"); container.replaceChildren();
    for (const profile of Object.keys(names)) {
      const card = document.createElement("article"); card.className = "card profile-card";
      const title = document.createElement("h3"); title.textContent = names[profile]; card.append(title);
      const status = document.createElement("p"); status.className = `profile-status ${validation[profile] === "available" ? "healthy" : "warning"}`;
      status.textContent = `Gespeichert: ${validation[profile]}`; card.append(status);
      const stored = policy.profiles[profile];
      const provider = document.createElement("select"), model = document.createElement("select"), variant = document.createElement("select");
      for (const [caption, select] of [["Provider", provider], ["Modell", model], ["Variante / Effort", variant]]) {
        const label = document.createElement("label"); label.textContent = caption; label.append(select); card.append(label);
      }
      function variants() {
        variant.replaceChildren(); add(variant, "— Variante wählen —", "");
        const entry = (catalog?.models || []).find(item => item.provider_id === provider.value && item.model_id === model.value);
        for (const value of entry?.variants || []) add(variant, value, value);
        if (stored?.provider_id === provider.value && stored.model_id === model.value && ![...variant.options].some(item => item.value === stored.variant)) add(variant, `${stored.variant} (nicht verfügbar)`, stored.variant);
        if (stored?.model_id === model.value) variant.value = stored.variant;
      }
      function models() {
        model.replaceChildren(); add(model, "— Modell wählen —", "");
        for (const item of (catalog?.models || []).filter(entry => entry.provider_id === provider.value)) add(model, item.name, item.model_id);
        if (stored?.provider_id === provider.value && ![...model.options].some(item => item.value === stored.model_id)) add(model, `${stored.model_id} (nicht verfügbar)`, stored.model_id);
        if (stored?.provider_id === provider.value) model.value = stored.model_id;
        variants();
      }
      add(provider, "— Provider wählen —", "");
      for (const item of catalog?.providers || []) add(provider, item.name, item.provider_id);
      if (stored && ![...provider.options].some(item => item.value === stored.provider_id)) add(provider, `${stored.provider_id} (nicht verfügbar)`, stored.provider_id);
      if (stored) provider.value = stored.provider_id;
      provider.addEventListener("change", models); model.addEventListener("change", variants); models();
      const actions = document.createElement("div"); actions.className = "profile-actions";
      const save = document.createElement("button"); save.className = "button"; save.textContent = "Profil speichern";
      save.disabled = catalogStatus !== "complete";
      save.addEventListener("click", () => {
        if (!provider.value || !model.value || !variant.value) { status.textContent = "Provider, Modell und Variante wählen."; return; }
        void saveProfile(profile, { provider_id: provider.value, model_id: model.value, variant: variant.value });
      });
      const clear = document.createElement("button"); clear.className = "button secondary"; clear.textContent = "Auswahl entfernen";
      clear.disabled = !stored; clear.addEventListener("click", () => void saveProfile(profile, null));
      actions.append(save, clear); card.append(actions); container.append(card);
    }
  }

  async function load() {
    try {
      const response = await fetch("/api/control", { cache: "no-store" });
      if (!response.ok) throw new Error("Projektpolicy nicht lesbar oder nicht unterstützt.");
      snapshot = await response.json(); render();
    } catch (error) { $("control-status").textContent = error.message; $("control-profiles").replaceChildren(); }
  }
  async function saveProfile(profile, selection) {
    try {
      const response = await fetch(`/api/control/profiles/${profile}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: snapshot.policy.revision, selection }) });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || "Speichern fehlgeschlagen."); }
      await load();
    } catch (error) { $("control-status").textContent = error.message; }
  }
  $("refresh-control").addEventListener("click", load);
  $("refresh").addEventListener("click", load);
  load();
})();
