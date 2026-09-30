"use strict";
(() => {
  const roles = {
    deep: ["Deep", "Architektur & schwierige Fehler"], standard: ["Standard", "Entwicklungsarbeit & allgemeine Planung"],
    execution: ["Execution", "Autorisierte Ausführung eines bekannten Plans"],
    design: ["Design", "UX, Interaktion & visuelle Ausarbeitung · Optional"],
    review: ["Review", "Unabhängige Bewertung · Optional"]
  };
  const states = { available: "Im aktuellen Katalog verfügbar", unconfigured: "Keine eigene Zuordnung",
    catalog_unavailable: "Gespeichert · derzeit nicht prüfbar", catalog_incomplete: "Gespeichert · Katalog unvollständig",
    provider_unavailable: "Provider nicht verfügbar", model_unavailable: "Modell nicht verfügbar", variant_unavailable: "Variante nicht verfügbar" };
  const fields = { provider_id: "Provider", model_id: "Modell", variant: "Variante / Effort" };
  const $ = id => document.getElementById(id);
  const equal = (a, b) => !a || !b ? a === b : Object.keys(fields).every(field => a[field] === b[field]);
  const tuple = selection => selection ? `${selection.provider_id} / ${selection.model_id} · ${selection.variant}` : "Keine eigene Zuordnung";
  const friendlyTuple = selection => {
    if (!selection) return "Keine eigene Zuordnung";
    const provider = snapshot.catalog?.providers.find(p => p.provider_id === selection.provider_id);
    const model = snapshot.catalog?.models.find(m => m.provider_id === selection.provider_id && m.model_id === selection.model_id);
    return `${model?.name || selection.model_id} · ${provider?.name || selection.provider_id} · ${selection.variant}`;
  };
  const blank = () => ({ provider_id: "", model_id: "", variant: "" });
  const cards = {};
  let snapshot, writing = false, uncertain = null, formatBlocked = false, loading = false;
  const node = (tag, text, className) => {
    const element = document.createElement(tag); if (text) element.textContent = text;
    if (className) element.className = className; return element;
  };

  function createCard(profile) {
    if (profile === "design") $("control-profiles").append(node("h3", "Optionale Profile", "optional-heading"));
    const card = node("article", "", "card profile-card"); card.id = `profile-${profile}`;
    const title = node("h3", roles[profile][0]); card.append(title, node("p", roles[profile][1], "muted"));
    const summary = node("p", "", "profile-summary"), effective = node("p", "", "profile-effective"); card.append(summary, effective);
    const ids = node("details", "", "technical-ids"), idText = node("p", "", "muted"); ids.append(node("summary", "Technische IDs"), idText); card.append(ids);
    if (profile === "review") card.append(node("p", "Review bewertet; eigene Findings werden nicht automatisch umgesetzt.", "muted"));
    const details = node("details", "", "profile-editor"), disclosure = node("summary", "Bearbeiten / Konfigurieren"); details.append(disclosure);
    const form = node("form"); form.noValidate = true;
    const fieldset = node("fieldset"); fieldset.append(node("legend", `${roles[profile][0]} zuordnen`));
    const hint = node("p", "", "muted"); hint.id = `${profile}-hint`;
    const errors = node("div", "", "error-summary"); errors.tabIndex = -1; errors.hidden = true;
    const controls = {};
    for (const [field, caption] of Object.entries(fields)) {
      const label = node("label", caption); label.htmlFor = `${profile}-${field}`;
      const select = node("select"); select.id = label.htmlFor; select.name = field;
      select.setAttribute("aria-describedby", hint.id); controls[field] = select; fieldset.append(label, select);
      select.addEventListener("change", () => {
        const c = cards[profile]; c.draft[field] = select.value;
        if (field === "provider_id") { c.draft.model_id = ""; c.draft.variant = ""; }
        if (field === "model_id") c.draft.variant = "";
        c.dirty = !equal(c.draft, c.baseline || blank()); clearErrors(c); updateCard(profile);
      });
    }
    const actions = node("div", "", "profile-actions");
    const save = node("button", "Profil speichern", "button"); save.type = "submit";
    const cancel = node("button", "Abbrechen", "button secondary"); cancel.type = "button";
    const remove = node("button", "Eigene Zuordnung entfernen", "button secondary"); remove.type = "button";
    actions.append(save, cancel, remove);
    const feedback = node("p", "", "profile-feedback"); feedback.setAttribute("role", "status");
    const recovery = node("button", "Aktuellen Stand vergleichen", "button secondary"); recovery.type = "button"; recovery.hidden = true;
    const draftPreview = node("p", "", "muted");
    form.append(errors, fieldset, draftPreview, hint, actions, feedback, recovery); details.append(form); card.append(details); $("control-profiles").append(card);
    const c = cards[profile] = { summary, effective, ids, idText, draftPreview, form, fieldset, controls, save, cancel, remove, hint, feedback, errors, recovery,
      draft: blank(), baseline: null, dirty: false, conflict: false, compared: false };
    form.addEventListener("submit", event => { event.preventDefault(); void saveProfile(profile, c.draft); });
    remove.addEventListener("click", () => void saveProfile(profile, null));
    cancel.addEventListener("click", () => { c.draft = { ...(snapshot.policy.profiles[profile] || blank()) }; c.baseline = snapshot.policy.profiles[profile];
      c.dirty = c.conflict = c.compared = false; clearErrors(c); c.feedback.textContent = "Entwurf verworfen."; updateAll(); });
    recovery.addEventListener("click", async () => {
      if (c.compared && !uncertain) { c.conflict = c.compared = false; c.baseline = snapshot.policy.profiles[profile]; c.recovery.hidden = true;
        c.feedback.textContent = "Abgleich bestätigt. Ein neuer Save ist jetzt bewusst möglich."; updateAll(); return; }
      const wasUncertain = !!uncertain;
      if (await load()) {
        if (wasUncertain && !c.conflict) return;
        c.compared = true; c.conflict = true;
        c.feedback.textContent = `Aktuell gespeichert: ${tuple(snapshot.policy.profiles[profile])}. Dein Entwurf: ${tuple(c.draft)}. Vor erneutem Speichern bewusst abgleichen.`;
        c.recovery.textContent = "Entwurf nach Abgleich freigeben"; updateAll();
      }
    });
  }

  function clearErrors(c) {
    c.errors.hidden = true; c.errors.replaceChildren();
    Object.values(c.controls).forEach(select => { select.removeAttribute("aria-invalid"); select.setAttribute("aria-describedby", c.hint.id); });
  }
  function validate(c) {
    clearErrors(c); const missing = Object.keys(fields).filter(field => !c.draft[field]);
    if (!missing.length) return true;
    c.errors.append(node("p", "Bitte vervollständige die Zuordnung:"));
    for (const field of missing) {
      const link = node("a", `Wähle ${fields[field]}.`); link.href = `#${c.controls[field].id}`;
      link.addEventListener("click", event => { event.preventDefault(); c.controls[field].focus(); });
      const error = node("p"); error.id = `${c.controls[field].id}-error`; error.append(link); c.errors.append(error);
      c.controls[field].setAttribute("aria-invalid", "true"); c.controls[field].setAttribute("aria-describedby", `${c.hint.id} ${error.id}`);
    }
    c.errors.hidden = false; c.errors.focus(); return false;
  }
  function populate(select, options, value) {
    // Preserve the element itself (focus) and all drafts, including vanished options.
    select.replaceChildren(new Option("— Bitte wählen —", ""));
    for (const [id, name] of options) select.add(new Option(name, id));
    if (value && !options.some(([id]) => id === value)) select.add(new Option(`${value} (${snapshot.catalogStatus === "complete" ? "nicht verfügbar" : "nicht prüfbar"})`, value));
    select.value = value;
  }
  function updateCard(profile) {
    const c = cards[profile], stored = snapshot.policy.profiles[profile], catalog = snapshot.catalog;
    c.summary.textContent = stored ? `${friendlyTuple(stored)} · ${states[snapshot.validation[profile]]}` : "Keine eigene Zuordnung";
    c.idText.textContent = tuple(stored);
    c.draftPreview.textContent = c.dirty ? `Entwurf: ${tuple(c.draft)}` : "";
    const resolution = snapshot.resolutions[profile];
    c.ids.hidden = !stored && !resolution?.resolved_profile;
    c.idText.textContent = `${tuple(stored)}${!stored && resolution?.resolved_profile ? ` · Effektiv: ${tuple(snapshot.policy.profiles[resolution.resolved_profile])}` : ""}`;
    const chain = [profile, ...(snapshot.fallbacks?.[profile] || [])].map(role => roles[role][0]).join(" → ");
    c.effective.textContent = resolution?.resolved_profile ? `${chain} · nutzt ${roles[resolution.resolved_profile][0]}: ${friendlyTuple(snapshot.policy.profiles[resolution.resolved_profile])} · ${states[resolution.status]}` :
      `${chain} · keine Projektzuordnung; bestehende geeignete Session-Runtime / Backend-Default.`;
    c.effective.className = `profile-effective ${resolution && !["available", "unconfigured"].includes(resolution.status) ? "warning" : "muted"}`;
    populate(c.controls.provider_id, (catalog?.providers || []).map(p => [p.provider_id, p.name]), c.draft.provider_id);
    const models = (catalog?.models || []).filter(m => m.provider_id === c.draft.provider_id);
    populate(c.controls.model_id, models.map(m => [m.model_id, m.name]), c.draft.model_id);
    const variants = models.find(m => m.model_id === c.draft.model_id)?.variants || [];
    populate(c.controls.variant, variants.map(v => [v, v]), c.draft.variant);
    const optional = profile === "design" || profile === "review";
    const compatible = snapshot.capabilities.optionalProfiles || (!optional && snapshot.policy.schemaVersion === 1);
    c.hint.textContent = `${c.dirty ? "Ungespeicherte Änderungen. " : ""}${snapshot.catalogStatus !== "complete" ? "Kein vollständiger Katalog; Zuordnung kann nicht gespeichert werden. " : ""}${!compatible ? "Aktiver MCP-Adapter bestätigt Format 2 / Optionalprofile nicht. Normalen autorisierten Reconnect und Tooldiscovery prüfen. " : ""}${optional && snapshot.policy.schemaVersion === 1 ? "Beim ersten Zuordnungssave wird die Policy auf Format 2 erweitert; vorhandenes Original wird gesichert. Ältere Connectoren können Format 2 nicht lesen." : ""}`;
    c.save.textContent = optional && snapshot.policy.schemaVersion === 1 ? `${roles[profile][0]} speichern und Policy erweitern` : "Profil speichern";
    c.save.disabled = writing || !!uncertain || formatBlocked || c.conflict || !compatible || snapshot.catalogStatus !== "complete";
    c.remove.disabled = writing || !!uncertain || formatBlocked || c.conflict || !stored;
    c.cancel.disabled = c.saving || !!uncertain;
    c.fieldset.disabled = !!c.saving;
    c.recovery.hidden = !c.conflict && uncertain?.profile !== profile;
    c.recovery.disabled = writing || loading || formatBlocked;
  }
  function updateAll() {
    if (!snapshot) return;
    $("control-status").textContent = `Katalog: ${ { complete: "geprüft", incomplete: "unvollständig", unavailable: "nicht verfügbar" }[snapshot.catalogStatus]} · Format ${snapshot.policy.schemaVersion} · Revision ${snapshot.policy.revision}`;
    $("control-catalog").textContent = snapshot.catalog ? `${snapshot.catalog.providers.length} Provider · ${snapshot.catalog.models.length} Modelle. ${snapshot.catalog.providers.map(p => p.name).join(" · ")}` : "Katalog nicht verfügbar. MCP bei den Verbindungen prüfen; gespeicherte Profile bleiben erhalten.";
    Object.keys(roles).forEach(updateCard);
  }
  function accept(next) {
    for (const profile of Object.keys(roles)) {
      if (!cards[profile]) createCard(profile);
      const c = cards[profile], stored = next.policy.profiles[profile];
      if (!c.dirty && !c.conflict && uncertain?.profile !== profile) { c.draft = { ...(stored || blank()) }; c.baseline = stored; }
      else if (!equal(c.baseline, stored)) { c.conflict = true; c.compared = false; c.recovery.textContent = "Aktuellen Stand vergleichen"; }
    }
    snapshot = next; formatBlocked = false; updateAll();
  }
  async function load() {
    if (loading || writing) return false;
    loading = true;
    try {
      const response = await fetch("/api/control", { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (!response.ok) { formatBlocked = response.status === 409; throw new Error("Projektpolicy nicht lesbar oder Format nicht unterstützt."); }
      const next = await response.json(); accept(next);
      window.dispatchEvent(new CustomEvent("hub-control-loaded", { detail: next.readModel }));
      if (uncertain) {
        const { profile, selection, revision } = uncertain, c = cards[profile];
        uncertain = null;
        if (next.policy.revision > revision && equal(next.policy.profiles[profile], selection)) {
          c.draft = { ...(selection || blank()) }; c.baseline = selection; c.dirty = c.conflict = false;
          c.feedback.textContent = `Passender Tuple bei fortgeschrittener Revision ${next.policy.revision} aktuell gespeichert; Urheberschaft nicht bewiesen.`;
        } else { c.conflict = true; c.compared = false; c.feedback.textContent = "Speicherergebnis nicht bestätigt. Aktuellen Stand und Entwurf vor erneutem Save vergleichen."; }
      }
      updateAll(); return true;
    } catch (error) {
      updateAll(); $("control-status").textContent = `${error.message} ${snapshot ? "Letzte bekannte Beobachtung; Entwürfe erhalten." : "Noch keine Policy geladen."}`;
      window.dispatchEvent(new Event("hub-control-unavailable"));
      return false;
    } finally { loading = false; Object.values(cards).forEach(c => { c.recovery.disabled = formatBlocked; }); }
  }
  async function saveProfile(profile, selection) {
    const c = cards[profile]; if (writing || loading || uncertain || formatBlocked || c.conflict) return;
    if (selection && !validate(c)) return;
    const submitted = selection ? { ...selection } : null, revision = snapshot.policy.revision;
    const previousFocus = document.activeElement;
    writing = true; c.saving = true; c.feedback.textContent = `${roles[profile][0]} wird gespeichert …`; updateAll();
    try {
      const response = await fetch(`/api/control/profiles/${profile}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, selection: submitted }), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === "POLICY_SAVE_UNCONFIRMED") throw new Error("Unconfirmed");
        if (result.code === "POLICY_REVISION_CONFLICT") { c.conflict = true; c.compared = false; c.recovery.textContent = "Aktuellen Stand vergleichen"; c.feedback.textContent = "Policy anderweitig geändert; dein Entwurf bleibt. Aktuellen Stand vergleichen."; }
        else if (result.code === "POLICY_FORMAT_UNSUPPORTED") { formatBlocked = true; c.feedback.textContent = "Policyformat nicht unterstützt. Bearbeitung gesperrt; Version/Format prüfen."; }
        else c.feedback.textContent = result.code === "SELECTION_UNAVAILABLE" ? `Nicht gespeichert: ${states[result.reason]}. Entwurf erhalten; Katalog aktualisieren.` :
          result.code === "CATALOG_UNAVAILABLE" ? "Aktuell kein vollständiger Katalog; Zuordnung nicht gespeichert. Entwurf erhalten." :
          result.code === "POLICY_CAPABILITY_UNAVAILABLE" ? "Aktiver Adapter bestätigt Optionalprofile / Format 2 nicht. Nicht gespeichert." : `Service-/Requestfehler ${response.status}; Entwurf erhalten. ${result.error || ""}`;
        if (result.code === "SELECTION_UNAVAILABLE") {
          const field = { provider_unavailable: "provider_id", model_unavailable: "model_id", variant_unavailable: "variant" }[result.reason];
          if (field) {
            clearErrors(c); const link = node("a", `${states[result.reason]}. Wähle ${fields[field]} erneut.`);
            link.href = `#${c.controls[field].id}`; link.addEventListener("click", event => { event.preventDefault(); c.controls[field].focus(); });
            c.errors.append(link); c.errors.hidden = false; c.errors.id = `${profile}-selection-error`;
            c.controls[field].setAttribute("aria-invalid", "true"); c.controls[field].setAttribute("aria-describedby", `${c.hint.id} ${c.errors.id}`); c.errors.focus();
          }
        }
      } else {
        if (!result.policy) throw new Error("Unconfirmed");
        snapshot.policy = result.policy; c.draft = { ...(submitted || blank()) }; c.baseline = submitted; c.dirty = c.conflict = false;
        // Recompute previews from the unchanged catalog; a later GET cannot erase this save evidence.
        for (const role of Object.keys(roles)) {
          const path = [], chain = [role, ...(snapshot.fallbacks?.[role] || [])]; let resolved;
          for (const candidate of chain) { path.push(candidate); if (result.policy.profiles[candidate] !== null) { resolved = candidate; break; } }
          snapshot.validation[role] = role === profile ? (submitted ? "available" : "unconfigured") : snapshot.validation[role];
          snapshot.resolutions[role] = { resolution_path: path, resolved_profile: resolved,
            status: resolved ? snapshot.validation[resolved] : "unconfigured" };
        }
        c.feedback.textContent = `${roles[profile][0]} gespeichert · Revision ${result.policy.revision}. Laufende Sessions unverändert.`;
      }
    } catch {
      uncertain = { profile, selection: submitted, revision };
      c.feedback.textContent = "Speicherergebnis nicht bestätigt. Zurücklesen und abgleichen; kein automatischer Wiederholungswrite.";
      c.recovery.textContent = "Speicherstand zurücklesen";
    } finally { writing = false; c.saving = false; updateAll();
      if (document.activeElement === document.body && previousFocus?.isConnected) previousFocus.focus(); }
  }
  window.addEventListener("beforeunload", event => { if (uncertain || Object.values(cards).some(c => c.dirty)) { event.preventDefault(); event.returnValue = ""; } });
  $("refresh-control").addEventListener("click", load); $("refresh").addEventListener("click", load); void load();
})();
