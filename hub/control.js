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
  const fallbackModes = { total: "Total Fallback (Standard)", degrading: "Degrading Fallback (Option)" };
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
  const blankFallback = () => ({ mode: "total", provider_id: "", model_id: "", variant: "" });
  const cards = {};
  let snapshot, writing = false, uncertain = null, fallbackUncertain = null, formatBlocked = false, loading = false;
  let fallbackCard = null, strategiesCard = null, strategiesUncertain = null, ownUncertain = null;
  const own = {};
  // Every model list in every picker is sorted alphabetically by displayed model
  // name: locale-aware, case-insensitive, stable, with a deterministic tie-breaker.
  // Provider separation, IDs, selection values, variants and routing stay untouched.
  const tieBreak = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byModelName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    || tieBreak(a.model_id, b.model_id) || tieBreak(a.provider_id, b.provider_id);
  const sortedModels = models => [...models].sort(byModelName);
  const pendingUncertain = () => !!(uncertain || fallbackUncertain || strategiesUncertain || ownUncertain);
  const storedOwn = profile => snapshot?.policy?.profileFallbacks?.[profile] || null;
  const storedStrategies = () => snapshot?.strategies || { degrading: null, providerSkip: null };
  const effectiveStrategies = () => snapshot?.routing?.strategiesEffective
    || { degrading: false, providerSkip: false };
  const perProfileRegime = () => snapshot?.routing?.regime === "per_profile";
  const schema4Capable = () => !!(snapshot?.capabilities?.profileFallbacks || snapshot?.policy?.schemaVersion === 4);
  const slotDisabledCapable = () => !!snapshot?.capabilities?.slotDisabled || snapshot?.policy?.schemaVersion === 5;
  // task_f2d0ccc6: per-slot manual pause. The stored selection is never deleted;
  // a disabled slot is skipped for new starts and shown greyed out with its
  // stored tuple intact. Missing flag (schema 1-4) means every slot is enabled.
  const disabledView = () => {
    const stored = snapshot?.policy?.disabled || {};
    const bools = map => ({ deep: false, standard: false, execution: false, design: false, review: false, ...(map || {}) });
    return { profiles: bools(stored.profiles), profileFallbacks: bools(stored.profileFallbacks),
      finalFallback: stored.finalFallback === true };
  };
  const isSlotOff = (kind, profile) => {
    const view = disabledView();
    return kind === "final" ? view.finalFallback : kind === "own" ? view.profileFallbacks[profile] : view.profiles[profile];
  };
  const noWriteWindow = () => writing || loading || pendingUncertain() || formatBlocked;
  const node = (tag, text, className) => {
    const element = document.createElement(tag); if (text) element.textContent = text;
    if (className) element.className = className; return element;
  };

  // task_f2d0ccc6: one small An/Aus switch per stored slot (primary, own
  // fallback, global final fallback). Off greys the editor fields out while the
  // stored tuple stays visible; re-enabling restores the identical selection.
  function makeSlotToggle(kind, profile) {
    const label = node("label", ""); label.className = "switch slot-switch";
    const input = node("input"); input.type = "checkbox"; input.name = `slot-${kind}-${profile}`;
    label.append(input, node("span", "Aktiv"));
    input.addEventListener("change", () => { void saveSlotDisabled(kind, profile, !input.checked); });
    return { label, input };
  }
  async function saveSlotDisabled(kind, profile, disabled) {
    if (noWriteWindow()) { updateAll(); return; }
    const route = kind === "final" ? "/api/control/fallback/disabled"
      : kind === "own" ? `/api/control/profiles/${profile}/fallback/disabled`
      : `/api/control/profiles/${profile}/disabled`;
    const feedback = (kind === "final" ? fallbackCard?.feedback : kind === "own" ? own[profile]?.feedback : cards[profile]?.feedback) ?? null;
    const revision = snapshot.policy.revision;
    writing = true; updateAll();
    try {
      const response = await fetch(route, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, disabled }), signal: AbortSignal.timeout(20000) });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (result?.code === "POLICY_REVISION_CONFLICT") {
          if (feedback) feedback.textContent = "Policy anderweitig geändert; Schalter nicht umgelegt. Neu laden und bewusst erneut schalten.";
        } else if (result?.code === "POLICY_FORMAT_UNSUPPORTED") {
          formatBlocked = true;
          if (feedback) feedback.textContent = "Policyformat nicht unterstützt. Bearbeitung gesperrt; Version/Format prüfen.";
        } else if (result?.code === "POLICY_CAPABILITY_UNAVAILABLE") {
          if (feedback) feedback.textContent = "Aktiver Adapter bestätigt das Slot-Pausieren (Format 5) nicht. Nicht gespeichert.";
        } else if (feedback) {
          feedback.textContent = `Schalter nicht umgelegt: Service-/Requestfehler ${response.status}. ${result?.error || ""}`;
        }
      } else {
        if (!result?.policy) throw new Error("Unconfirmed");
        snapshot.policy = result.policy;
        if (result.routing) snapshot.routing = result.routing;
        if (result.strategies) snapshot.strategies = result.strategies;
        if (feedback) feedback.textContent = disabled
          ? `Slot pausiert · Revision ${result.policy.revision}. Gespeicherte Belegung bleibt erhalten; neue Aufträge überspringen ihn, ohne ihn anzufragen.`
          : `Slot reaktiviert · Revision ${result.policy.revision}. Die gespeicherte Belegung ist wieder regulär wählbar.`;
        if (!pendingUncertain()) void load();
      }
    } catch {
      if (feedback) feedback.textContent = "Schalterergebnis nicht bestätigt. Ansicht neu laden und den gespeicherten Stand vergleichen; kein automatischer Wiederholungswrite.";
    } finally {
      writing = false; updateAll();
    }
  }

  function createCard(profile) {
    if (profile === "design") $("control-profiles").append(node("h3", "Optionale Profile", "optional-heading"));
    const card = node("article", "", "card profile-card"); card.id = `profile-${profile}`;
    const head = node("div", "", "card-head");
    head.append(node("h3", roles[profile][0]));
    const slotToggle = makeSlotToggle("primary", profile);
    head.append(slotToggle.label);
    card.append(head, node("p", roles[profile][1], "muted"));
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
    const c = cards[profile] = { card, summary, effective, ids, idText, draftPreview, form, fieldset, controls, save, cancel, remove, hint, feedback, errors, recovery, slotToggle,
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
    createOwnFallbackEditor(profile, card);
  }

  // Optional own fallback per profile card (additive schema 4). Separate editor,
  // separate CAS write, same draft/conflict/uncertain discipline as the main map.
  function createOwnFallbackEditor(profile, card) {
    const summary = node("p", "", "profile-fallback-summary muted");
    card.querySelector(".profile-effective").after(summary);
    const ownToggle = makeSlotToggle("own", profile);
    summary.after(ownToggle.label);
    const details = node("details", "", "profile-fallback-editor");
    details.append(node("summary", "Eigenes Fallback (optional)"));
    // Deliberately not a second <form> and not type=submit: the existing card
    // selectors (#profile-<role> form / button[type=submit]) must stay unique.
    const form = node("div", "", "profile-fallback-form");
    const errors = node("div", "", "fallback-error-summary"); errors.tabIndex = -1; errors.hidden = true;
    const fieldset = node("fieldset"); fieldset.append(node("legend", `Eigenes Fallback für ${roles[profile][0]}`));
    const hint = node("p", "", "muted"); hint.id = `${profile}-fallback-hint`;
    const controls = {};
    for (const [field, caption] of Object.entries(fields)) {
      const label = node("label", caption); label.htmlFor = `${profile}-fallback-${field}`;
      const select = node("select"); select.id = label.htmlFor; select.name = field;
      select.setAttribute("aria-describedby", hint.id); controls[field] = select; fieldset.append(label, select);
      select.addEventListener("change", () => {
        const c = own[profile]; c.draft[field] = select.value;
        if (field === "provider_id") { c.draft.model_id = ""; c.draft.variant = ""; }
        if (field === "model_id") c.draft.variant = "";
        c.dirty = !equal(c.draft, c.baseline || blank()); clearOwnErrors(profile); updateAll();
      });
    }
    const actions = node("div", "", "profile-actions");
    const save = node("button", "Eigenes Fallback speichern", "button"); save.type = "button";
    const cancel = node("button", "Abbrechen", "button secondary"); cancel.type = "button";
    const remove = node("button", "Eigenes Fallback entfernen", "button secondary"); remove.type = "button";
    actions.append(save, cancel, remove);
    const feedback = node("p", "", "profile-fallback-feedback"); feedback.setAttribute("role", "status");
    const recovery = node("button", "Aktuellen Stand vergleichen", "button secondary"); recovery.type = "button"; recovery.hidden = true;
    const draftPreview = node("p", "", "muted");
    form.append(errors, fieldset, draftPreview, hint, actions, feedback, recovery);
    details.append(form); card.append(details);
    const c = own[profile] = { summary, details, form, fieldset, controls, save, cancel, remove, hint, feedback, errors, recovery, draftPreview, ownToggle,
      draft: blank(), baseline: null, dirty: false, conflict: false, compared: false, saving: false };
    save.addEventListener("click", () => void saveOwnFallback(profile, c.draft));
    remove.addEventListener("click", () => void saveOwnFallback(profile, null));
    cancel.addEventListener("click", () => { c.draft = { ...(storedOwn(profile) || blank()) }; c.baseline = storedOwn(profile);
      c.dirty = c.conflict = c.compared = false; clearOwnErrors(profile); c.feedback.textContent = "Entwurf verworfen."; updateAll(); });
    recovery.addEventListener("click", async () => {
      if (c.compared && !ownUncertain) { c.conflict = c.compared = false; c.baseline = storedOwn(profile); c.recovery.hidden = true;
        c.recovery.textContent = "Aktuellen Stand vergleichen"; c.feedback.textContent = "Abgleich bestätigt. Ein neuer Save ist jetzt bewusst möglich."; updateAll(); return; }
      const wasUncertain = !!ownUncertain;
      if (await load()) {
        if (wasUncertain && !c.conflict) return;
        c.compared = true; c.conflict = true;
        c.feedback.textContent = `Aktuell gespeichert: ${tuple(storedOwn(profile))}. Dein Entwurf: ${tuple(c.draft)}. Vor erneutem Speichern bewusst abgleichen.`;
        c.recovery.textContent = "Entwurf nach Abgleich freigeben"; updateAll();
      }
    });
  }

  function clearOwnErrors(profile) {
    const c = own[profile]; if (!c) return;
    c.errors.hidden = true; c.errors.replaceChildren();
    Object.values(c.controls).forEach(select => { select.removeAttribute("aria-invalid"); select.setAttribute("aria-describedby", c.hint.id); });
  }
  function validateOwnDraft(profile) {
    const c = own[profile]; clearOwnErrors(profile);
    const missing = Object.keys(fields).filter(field => !c.draft[field]);
    if (!missing.length) return true;
    c.errors.append(node("p", "Bitte vervollständige das eigene Fallback:"));
    for (const field of missing) {
      const link = node("a", `Wähle ${fields[field]}.`); link.href = `#${c.controls[field].id}`;
      link.addEventListener("click", event => { event.preventDefault(); c.controls[field].focus(); });
      const error = node("p"); error.id = `${c.controls[field].id}-error`; error.append(link); c.errors.append(error);
      c.controls[field].setAttribute("aria-invalid", "true"); c.controls[field].setAttribute("aria-describedby", `${c.hint.id} ${error.id}`);
    }
    c.errors.hidden = false; c.errors.focus(); return false;
  }
  function updateOwnCard(profile) {
    const c = own[profile]; if (!c || !snapshot) return;
    const stored = storedOwn(profile);
    const off = stored ? isSlotOff("own", profile) : false;
    c.summary.textContent = stored
      ? `Eigenes Fallback: ${friendlyTuple(stored)} · ${states[snapshot.profileFallbackValidation?.[profile]] || "unconfigured"}${off ? " · pausiert" : ""}`
      : "Kein eigenes Fallback — ohne Degrading endet die Kette nach dem Hauptmodell mit einer auslesbaren INPUT_REQUIRED-Meldung.";
    c.summary.className = `profile-fallback-summary ${stored && !["available", "unconfigured"].includes(snapshot.profileFallbackValidation?.[profile]) ? "warning" : "muted"}`;
    c.ownToggle.label.hidden = !stored;
    c.ownToggle.input.checked = stored && !off;
    c.ownToggle.input.disabled = noWriteWindow() || !slotDisabledCapable() || !!c.conflict;
    c.details.classList.toggle("slot-off", off);
    c.draftPreview.textContent = c.dirty ? `Entwurf: ${tuple(c.draft)}` : "";
    populate(c.controls.provider_id, (snapshot.catalog?.providers || []).map(p => [p.provider_id, p.name]), c.draft.provider_id);
    const models = sortedModels((snapshot.catalog?.models || []).filter(m => m.provider_id === c.draft.provider_id));
    populate(c.controls.model_id, models.map(m => [m.model_id, m.name]), c.draft.model_id);
    const variants = models.find(m => m.model_id === c.draft.model_id)?.variants || [];
    populate(c.controls.variant, variants.map(v => [v, v]), c.draft.variant);
    const upgrade = snapshot.policy.schemaVersion < 4;
    c.hint.textContent = `${c.dirty ? "Ungespeicherte Änderungen. " : ""}${snapshot.catalogStatus !== "complete" ? "Kein vollständiger Katalog; ein eigenes Fallback kann nicht gespeichert werden (Entfernen bleibt möglich). " : ""}${upgrade && !snapshot.capabilities.profileFallbacks ? "Aktiver MCP-Adapter bestätigt Format 4 (profilbezogene Fallbacks/Strategien) nicht. Normalen autorisierten Reconnect und Tooldiscovery prüfen. " : ""}${upgrade ? "Beim ersten Speichern wird die Policy auf Format 4 erweitert; das vorhandene Original wird gesichert. Ältere Connectoren können Format 4 nicht lesen. " : ""}Das bisherige globale finale Fallback bleibt gespeichert und wird im profilbezogenen Modus nicht still als zusätzliche Endstufe angehängt.${stored && !slotDisabledCapable() ? " Aktiver MCP-Adapter bestätigt das Slot-Pausieren (Format 5) nicht; der Schalter bleibt gesperrt." : ""}`;
    c.save.textContent = upgrade ? "Eigenes Fallback speichern und Policy erweitern" : "Eigenes Fallback speichern";
    const compatible = schema4Capable();
    c.save.disabled = off || writing || pendingUncertain() || formatBlocked || c.conflict || !compatible || snapshot.catalogStatus !== "complete";
    c.remove.disabled = off || writing || pendingUncertain() || formatBlocked || c.conflict || !stored;
    c.cancel.disabled = c.saving || pendingUncertain();
    c.fieldset.disabled = !!c.saving || off;
    c.recovery.hidden = !c.conflict && ownUncertain?.profile !== profile;
    c.recovery.disabled = writing || loading || formatBlocked;
  }
  async function saveOwnFallback(profile, selection) {
    const c = own[profile];
    if (!c || writing || loading || pendingUncertain() || formatBlocked || c.conflict) return;
    if (selection && !validateOwnDraft(profile)) return;
    const submitted = selection ? { ...selection } : null, revision = snapshot.policy.revision;
    const previousFocus = document.activeElement;
    writing = true; c.saving = true;
    c.feedback.textContent = submitted ? "Eigenes Fallback wird gespeichert …" : "Eigenes Fallback wird entfernt …"; updateAll();
    try {
      const response = await fetch(`/api/control/profiles/${profile}/fallback`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, fallback: submitted }), signal: AbortSignal.timeout(20000) });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (result?.code === "POLICY_SAVE_UNCONFIRMED") throw new Error("Unconfirmed");
        if (result?.code === "POLICY_REVISION_CONFLICT") { c.conflict = true; c.compared = false; c.recovery.textContent = "Aktuellen Stand vergleichen"; c.feedback.textContent = "Policy anderweitig geändert; dein Entwurf bleibt. Aktuellen Stand vergleichen und bewusst erneut speichern."; }
        else if (result?.code === "POLICY_FORMAT_UNSUPPORTED") { formatBlocked = true; c.feedback.textContent = "Policyformat nicht unterstützt. Bearbeitung gesperrt; Version/Format prüfen."; }
        else c.feedback.textContent = result?.code === "SELECTION_UNAVAILABLE" ? `Nicht gespeichert: ${states[result.reason]}. Entwurf erhalten; Katalog aktualisieren.` :
          result?.code === "CATALOG_UNAVAILABLE" ? "Aktuell kein vollständiger Katalog; eigenes Fallback nicht gespeichert. Entwurf erhalten." :
          result?.code === "POLICY_CAPABILITY_UNAVAILABLE" ? "Aktiver Adapter bestätigt Format 4 nicht. Nicht gespeichert." :
          `Service-/Requestfehler ${response.status}; Entwurf erhalten. ${result?.error || ""}`;
      } else {
        if (!result?.policy) throw new Error("Unconfirmed");
        snapshot.policy = result.policy;
        if (result.routing) snapshot.routing = result.routing;
        if (result.strategies) snapshot.strategies = result.strategies;
        snapshot.profileFallbackValidation = { ...(snapshot.profileFallbackValidation || {}),
          [profile]: submitted ? "available" : "unconfigured" };
        c.draft = { ...(submitted || blank()) }; c.baseline = submitted; c.dirty = c.conflict = c.compared = false;
        c.feedback.textContent = submitted
          ? `Eigenes Fallback gespeichert · Revision ${result.policy.revision}. Laufende Sessions unverändert.`
          : `Eigenes Fallback entfernt · Revision ${result.policy.revision}.`;
      }
    } catch {
      ownUncertain = { profile, selection: submitted, revision };
      c.feedback.textContent = "Speicherergebnis nicht bestätigt. Zurücklesen und abgleichen; kein automatischer Wiederholungswrite.";
      c.recovery.textContent = "Speicherstand zurücklesen";
    } finally {
      writing = false; c.saving = false; updateAll();
      if (document.activeElement === document.body && previousFocus?.isConnected) previousFocus.focus();
    }
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
    const off = stored ? isSlotOff("primary", profile) : false;
    c.summary.textContent = stored ? `${friendlyTuple(stored)} · ${states[snapshot.validation[profile]]}${off ? " · pausiert" : ""}` : "Keine eigene Zuordnung";
    c.card.classList.toggle("slot-off", off);
    c.slotToggle.label.hidden = !stored;
    c.slotToggle.input.checked = stored && !off;
    // No `loading` term: load()'s finally clears the flag without an updateAll,
    // so a loading term would leave the switch stale-disabled after every load
    // (save buttons behave the same; the write guard rejects during a read).
    c.slotToggle.input.disabled = writing || pendingUncertain() || formatBlocked || !!c.conflict || !slotDisabledCapable();
    c.idText.textContent = tuple(stored);
    c.draftPreview.textContent = c.dirty ? `Entwurf: ${tuple(c.draft)}` : "";
    const resolution = snapshot.resolutions[profile];
    c.ids.hidden = !stored && !resolution?.resolved_profile;
    c.idText.textContent = `${tuple(stored)}${!stored && resolution?.resolved_profile ? ` · Effektiv: ${tuple(snapshot.policy.profiles[resolution.resolved_profile])}` : ""}`;
    const chain = [profile, ...(snapshot.fallbacks?.[profile] || [])].map(role => roles[role][0]).join(" → ");
    const resolutionText = resolution?.resolved_profile ? `${chain} · nutzt ${roles[resolution.resolved_profile][0]}: ${friendlyTuple(snapshot.policy.profiles[resolution.resolved_profile])} · ${resolution.status === "hold_disabled" ? "alle Slots pausiert" : states[resolution.status]}` :
      `${chain} · keine Projektzuordnung; bestehende geeignete Session-Runtime / Backend-Default.`;
    c.effective.textContent = off ? `Pausiert — neue Aufträge überspringen diese Belegung, ohne sie anzufragen. ${resolutionText}` : resolutionText;
    c.effective.className = `profile-effective ${off || (resolution && !["available", "unconfigured"].includes(resolution.status)) ? "warning" : "muted"}`;
    populate(c.controls.provider_id, (catalog?.providers || []).map(p => [p.provider_id, p.name]), c.draft.provider_id);
    const models = sortedModels((catalog?.models || []).filter(m => m.provider_id === c.draft.provider_id));
    populate(c.controls.model_id, models.map(m => [m.model_id, m.name]), c.draft.model_id);
    const variants = models.find(m => m.model_id === c.draft.model_id)?.variants || [];
    populate(c.controls.variant, variants.map(v => [v, v]), c.draft.variant);
    const optional = profile === "design" || profile === "review";
    const compatible = snapshot.capabilities.optionalProfiles || (!optional && snapshot.policy.schemaVersion === 1);
    c.hint.textContent = `${c.dirty ? "Ungespeicherte Änderungen. " : ""}${snapshot.catalogStatus !== "complete" ? "Kein vollständiger Katalog; Zuordnung kann nicht gespeichert werden. " : ""}${!compatible ? "Aktiver MCP-Adapter bestätigt Format 2 / Optionalprofile nicht. Normalen autorisierten Reconnect und Tooldiscovery prüfen. " : ""}${optional && snapshot.policy.schemaVersion === 1 ? "Beim ersten Zuordnungssave wird die Policy auf Format 2 erweitert; vorhandenes Original wird gesichert. Ältere Connectoren können Format 2 nicht lesen." : ""}${stored && !slotDisabledCapable() ? "Aktiver MCP-Adapter bestätigt das Slot-Pausieren (Format 5) nicht; der Schalter bleibt gesperrt. " : ""}`;
    c.save.textContent = optional && snapshot.policy.schemaVersion === 1 ? `${roles[profile][0]} speichern und Policy erweitern` : "Profil speichern";
    c.save.disabled = off || writing || pendingUncertain() || formatBlocked || c.conflict || !compatible || snapshot.catalogStatus !== "complete";
    c.remove.disabled = off || writing || pendingUncertain() || formatBlocked || c.conflict || !stored;
    c.cancel.disabled = c.saving || pendingUncertain();
    c.fieldset.disabled = !!c.saving || off;
    c.recovery.hidden = !c.conflict && uncertain?.profile !== profile;
    c.recovery.disabled = writing || loading || formatBlocked;
  }

  const storedFallback = () => snapshot?.policy?.finalFallback
    ? { mode: snapshot.policy.finalFallback.mode, ...snapshot.policy.finalFallback.selection } : null;
  // Shared "Fallback-Strategien" area below all profile cards: two independent
  // switches. Unset (null) means "not activated" and is never a hidden default;
  // saving writes both switches explicitly, reset writes both back to unset.
  const sameStrategies = (a, b) => !!a && !!b && a.degrading === b.degrading && a.providerSkip === b.providerSkip;
  const strategySwitches = [["degrading", "Degrading", "Nach dem eigenen Fallback zur nächsten regulären Stufe wechseln (Deep → Standard → Execution; Design → Standard → Execution; Review → Deep → Standard → Execution)."],
    ["providerSkip", "Provider-Skip", "Übrige Kandidaten einer als ausgefallen belegten Provideridentität überspringen — einschließlich profilbezogener Fallbacks. Aus: andere Modelle desselben Providers bleiben zulässig."]];
  function createStrategiesCard() {
    const card = node("article", "", "card strategies-card"); card.id = "fallback-strategies";
    card.append(node("h3", "Fallback-Strategien"), node("p",
      "Gemeinsame Routing-Schalter für bestätigte Provider-Timeouts/-Quota. Reihenfolge: Hauptmodell der Stufe → eigenes Fallback der Stufe → nur bei aktiviertem Degrading die nächste reguläre Stufe. Bereits gescheiterte identische Runtimes werden nie erneut versucht; die Kette ist endlich. Ohne zulässigen Kandidaten endet der Lauf mit einer auslesbaren INPUT_REQUIRED-Meldung statt eines Crashs.",
      "muted"));
    const summary = node("p", "", "strategies-summary muted"); card.append(summary);
    const details = node("details", "", "strategies-editor");
    details.append(node("summary", "Schalter bearbeiten"));
    const form = node("form"); form.noValidate = true;
    const fieldset = node("fieldset"); fieldset.append(node("legend", "Degrading und Provider-Skip"));
    const hint = node("p", "", "muted"); hint.id = "strategies-hint";
    const controls = {};
    for (const [key, caption, help] of strategySwitches) {
      const label = node("label", ""); label.className = "switch"; label.htmlFor = `strategies-${key}`;
      const input = node("input"); input.type = "checkbox"; input.id = label.htmlFor; input.name = key;
      input.setAttribute("aria-describedby", hint.id);
      label.append(input, node("span", caption));
      fieldset.append(label, node("p", help, "muted")); controls[key] = input;
    }
    const actions = node("div", "", "profile-actions");
    const save = node("button", "Strategien speichern", "button"); save.type = "submit";
    const reset = node("button", "Auf „nicht gesetzt“ zurücksetzen", "button secondary"); reset.type = "button";
    actions.append(save, reset);
    const feedback = node("p", "", "profile-feedback"); feedback.setAttribute("role", "status");
    const recovery = node("button", "Speicherstand zurücklesen", "button secondary"); recovery.type = "button"; recovery.hidden = true;
    form.append(fieldset, hint, actions, feedback, recovery);
    details.append(form); card.append(details); $("control-profiles").append(card);
    strategiesCard = { summary, form, fieldset, controls, save, reset, hint, feedback, recovery,
      draft: { degrading: false, providerSkip: false }, baseline: { degrading: false, providerSkip: false },
      dirty: false, conflict: false, compared: false, saving: false };
    for (const [key, input] of Object.entries(controls)) {
      input.addEventListener("change", () => {
        strategiesCard.draft[key] = input.checked;
        strategiesCard.dirty = !sameStrategies(strategiesCard.draft, strategiesCard.baseline);
        strategiesCard.conflict = strategiesCard.compared = false; updateAll();
      });
    }
    form.addEventListener("submit", event => { event.preventDefault(); void saveStrategies("save"); });
    reset.addEventListener("click", () => void saveStrategies("reset"));
    recovery.addEventListener("click", async () => {
      const c = strategiesCard;
      if (c.compared && !strategiesUncertain) { c.conflict = c.compared = false; c.baseline = { ...effectiveStrategies() };
        c.dirty = !sameStrategies(c.draft, c.baseline); c.recovery.hidden = true; c.recovery.textContent = "Speicherstand zurücklesen";
        c.feedback.textContent = "Abgleich bestätigt. Ein neuer Save ist jetzt bewusst möglich."; updateAll(); return; }
      const wasUncertain = !!strategiesUncertain;
      if (await load()) {
        if (wasUncertain && !c.conflict) return;
        c.compared = true; c.conflict = true;
        c.feedback.textContent = `Aktuell gespeichert: ${describeStrategies(storedStrategies())}. Dein Entwurf: ${describeStrategies(c.draft)}. Vor erneutem Speichern bewusst abgleichen.`;
        c.recovery.textContent = "Entwurf nach Abgleich freigeben"; updateAll();
      }
    });
  }
  const describeStrategies = value => `Degrading ${value?.degrading === null ? "nicht gesetzt" : value?.degrading ? "an" : "aus"} · Provider-Skip ${value?.providerSkip === null ? "nicht gesetzt" : value?.providerSkip ? "an" : "aus"}`;
  function updateStrategiesCard() {
    const c = strategiesCard; if (!c || !snapshot) return;
    const stored = storedStrategies(), effective = effectiveStrategies();
    c.summary.textContent = `${perProfileRegime() ? "Profilbezogener Modus aktiv" : "Bisheriger Modus (globale Endstufe)"} · ${describeStrategies(stored)} · wirksam: Degrading ${effective.degrading ? "an" : "aus"}, Provider-Skip ${effective.providerSkip ? "an" : "aus"}`;
    c.controls.degrading.checked = c.dirty || c.conflict ? c.draft.degrading : effective.degrading;
    c.controls.providerSkip.checked = c.dirty || c.conflict ? c.draft.providerSkip : effective.providerSkip;
    const upgrade = snapshot.policy.schemaVersion < 4;
    c.hint.textContent = `${c.dirty ? "Ungespeicherte Änderungen. " : ""}${!snapshot.capabilities.profileFallbacks && upgrade ? "Aktiver MCP-Adapter bestätigt Format 4 (profilbezogene Fallbacks/Strategien) nicht. Normalen autorisierten Reconnect und Tooldiscovery prüfen. " : ""}${upgrade ? "Beim ersten expliziten Speichern wird die Policy auf Format 4 erweitert; das vorhandene Original wird gesichert. " : ""}${stored.degrading === null && stored.providerSkip === null ? "Beide Schalter sind derzeit nicht explizit gesetzt; das ist keine still gewählte Voreinstellung, sondern bedeutet „nicht aktiviert“. Speichern setzt beide Werte explizit. " : ""}${perProfileRegime() ? "Profilbezogener Modus: Die bisherige globale Endstufe unten ist nicht Teil der Kette, bleibt aber gespeichert und lesbar. " : "Bisheriger Modus: Das globale finale Fehler-Fallback unten bleibt die konfigurierte Endstufe (Total/Degrading). "}`;
    c.save.disabled = writing || pendingUncertain() || formatBlocked || c.conflict || (upgrade && !snapshot.capabilities.profileFallbacks);
    c.reset.disabled = writing || pendingUncertain() || formatBlocked || c.conflict || (stored.degrading === null && stored.providerSkip === null);
    c.fieldset.disabled = !!c.saving;
    c.recovery.hidden = !c.conflict && !strategiesUncertain;
    c.recovery.disabled = writing || loading || formatBlocked;
  }
  async function saveStrategies(kind) {
    const c = strategiesCard;
    if (!c || writing || loading || pendingUncertain() || formatBlocked || c.conflict) return;
    const submitted = kind === "reset" ? { degrading: null, providerSkip: null } : { ...c.draft };
    const revision = snapshot.policy.revision;
    const previousFocus = document.activeElement;
    writing = true; c.saving = true;
    c.feedback.textContent = kind === "reset" ? "Schalter werden auf „nicht gesetzt“ zurückgesetzt …" : "Strategien werden gespeichert …"; updateAll();
    try {
      const response = await fetch("/api/control/fallback-strategies", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, strategies: submitted }), signal: AbortSignal.timeout(20000) });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (result?.code === "POLICY_SAVE_UNCONFIRMED") throw new Error("Unconfirmed");
        if (result?.code === "POLICY_REVISION_CONFLICT") { c.conflict = true; c.compared = false; c.recovery.textContent = "Speicherstand zurücklesen"; c.feedback.textContent = "Policy anderweitig geändert; dein Entwurf bleibt. Aktuellen Stand vergleichen und bewusst erneut speichern."; }
        else if (result?.code === "POLICY_FORMAT_UNSUPPORTED") { formatBlocked = true; c.feedback.textContent = "Policyformat nicht unterstützt. Bearbeitung gesperrt; Version/Format prüfen."; }
        else c.feedback.textContent = result?.code === "POLICY_CAPABILITY_UNAVAILABLE" ? "Aktiver Adapter bestätigt Format 4 nicht. Nicht gespeichert." :
          `Service-/Requestfehler ${response.status}; Entwurf erhalten. ${result?.error || ""}`;
      } else {
        if (!result?.policy) throw new Error("Unconfirmed");
        snapshot.policy = result.policy;
        if (result.routing) snapshot.routing = result.routing;
        snapshot.strategies = result.strategies || storedStrategies();
        c.baseline = { ...effectiveStrategies() }; c.draft = { ...c.baseline };
        c.dirty = c.conflict = c.compared = false;
        c.feedback.textContent = kind === "reset"
          ? `Beide Schalter auf „nicht gesetzt“ zurückgesetzt · Revision ${result.policy.revision}. Wirksam ist damit nichts aktiviert.`
          : `Strategien gespeichert · Revision ${result.policy.revision}. ${describeStrategies(snapshot.strategies)}.`;
      }
    } catch {
      strategiesUncertain = { submitted, revision };
      c.feedback.textContent = "Speicherergebnis nicht bestätigt. Zurücklesen und abgleichen; kein automatischer Wiederholungswrite.";
      c.recovery.textContent = "Speicherstand zurücklesen";
    } finally {
      writing = false; c.saving = false; updateAll();
      if (document.activeElement === document.body && previousFocus?.isConnected) previousFocus.focus();
    }
  }
  const sameFallback = (a, b) => {
    if (!a || !b) return a === b;
    return a.mode === b.mode && Object.keys(fields).every(field => a[field] === b[field]);
  };
  function fillModes(select, value) {
    select.replaceChildren(...Object.entries(fallbackModes).map(([id, name]) => new Option(name, id)));
    select.value = value in fallbackModes ? value : "total";
  }
  function createFallbackCard() {
    const card = node("article", "", "card fallback-card"); card.id = "profile-final-fallback";
    card.append(node("h3", "Finales Fehler-Fallback"), node("p",
      "Abschließende Runtime bei bestätigtem Provider-Timeout/-Quota (Total oder Degrading). Strikt getrennt von der regulären Design-/Review-Auflösung; nicht konfiguriert bedeutet eine präzise INPUT_REQUIRED-Meldung statt automatischer Providerwahl.",
      "muted"));
    const summary = node("p", "", "profile-summary"); card.append(summary);
    const finalToggle = makeSlotToggle("final", null);
    summary.after(finalToggle.label);
    const details = node("details", "", "profile-editor");
    details.append(node("summary", "Fallback konfigurieren"));
    const form = node("form"); form.noValidate = true;
    const fieldset = node("fieldset"); fieldset.append(node("legend", "Strategie und Runtime"));
    const hint = node("p", "", "muted"); hint.id = "fallback-hint";
    const errors = node("div", "", "error-summary"); errors.tabIndex = -1; errors.hidden = true;
    const controls = {};
    for (const [field, caption] of [["mode", "Strategie"], ["provider_id", "Provider"], ["model_id", "Modell"], ["variant", "Variante / Effort"]]) {
      const label = node("label", caption); label.htmlFor = `fallback-${field}`;
      const select = node("select"); select.id = label.htmlFor; select.name = field;
      select.setAttribute("aria-describedby", hint.id);
      controls[field] = select; fieldset.append(label, select);
    }
    const actions = node("div", "", "profile-actions");
    const save = node("button", "Fallback speichern", "button"); save.type = "submit";
    const clear = node("button", "Fallback entfernen", "button secondary"); clear.type = "button";
    actions.append(save, clear);
    const feedback = node("p", "", "profile-feedback"); feedback.setAttribute("role", "status");
    const recovery = node("button", "Speicherstand zurücklesen", "button secondary"); recovery.type = "button"; recovery.hidden = true;
    form.append(errors, fieldset, hint, actions, feedback, recovery);
    details.append(form); card.append(details); $("control-profiles").append(card);
    fallbackCard = { card, summary, form, fieldset, controls, save, clear, hint, feedback, errors, recovery, finalToggle,
      draft: blankFallback(), baseline: null, dirty: false, conflict: false, compared: false, saving: false };
    for (const [field, select] of Object.entries(controls)) {
      select.addEventListener("change", () => {
        fallbackCard.draft[field] = select.value;
        if (field === "provider_id") { fallbackCard.draft.model_id = ""; fallbackCard.draft.variant = ""; }
        if (field === "model_id") fallbackCard.draft.variant = "";
        fallbackCard.dirty = !sameFallback(fallbackCard.draft, fallbackCard.baseline);
        clearFallbackErrors(); updateFallbackCard();
      });
    }
    form.addEventListener("submit", event => { event.preventDefault(); void saveFallback("save"); });
    clear.addEventListener("click", () => void saveFallback("clear"));
    recovery.addEventListener("click", async () => {
      if (fallbackCard.compared && !fallbackUncertain) {
        fallbackCard.conflict = fallbackCard.compared = false; fallbackCard.baseline = storedFallback();
        fallbackCard.dirty = !sameFallback(fallbackCard.draft, fallbackCard.baseline);
        recovery.hidden = true; fallbackCard.feedback.textContent = "Abgleich bestätigt. Ein neuer Save ist jetzt bewusst möglich."; updateAll(); return;
      }
      const wasUncertain = !!fallbackUncertain;
      if (await load()) {
        if (wasUncertain && !fallbackCard.conflict) return;
        fallbackCard.compared = true; fallbackCard.conflict = true;
        const stored = storedFallback();
        fallbackCard.feedback.textContent = `Aktuell gespeichert: ${stored ? `${fallbackModes[stored.mode]} · ${tuple(stored)}` : "Kein Fallback"}. Dein Entwurf: ${sameFallback(fallbackCard.draft, blankFallback()) ? "Kein Fallback" : `${fallbackModes[fallbackCard.draft.mode]} · ${tuple(fallbackCard.draft)}`}. Vor erneutem Speichern bewusst abgleichen.`;
        recovery.textContent = "Entwurf nach Abgleich freigeben"; updateAll();
      }
    });
  }
  function clearFallbackErrors() {
    const c = fallbackCard; if (!c) return;
    c.errors.hidden = true; c.errors.replaceChildren();
    Object.values(c.controls).forEach(select => { select.removeAttribute("aria-invalid"); select.setAttribute("aria-describedby", c.hint.id); });
  }
  function validateFallbackDraft(c) {
    clearFallbackErrors();
    const missing = ["provider_id", "model_id", "variant"].filter(field => !c.draft[field]);
    if (!missing.length) return true;
    c.errors.append(node("p", "Bitte vervollständige die Fallback-Zuordnung:"));
    for (const field of missing) {
      const link = node("a", `Wähle ${fields[field]}.`); link.href = `#${c.controls[field].id}`;
      link.addEventListener("click", event => { event.preventDefault(); c.controls[field].focus(); });
      const error = node("p"); error.id = `${c.controls[field].id}-error`; error.append(link); c.errors.append(error);
      c.controls[field].setAttribute("aria-invalid", "true"); c.controls[field].setAttribute("aria-describedby", `${c.hint.id} ${error.id}`);
    }
    c.errors.hidden = false; c.errors.focus(); return false;
  }
  function updateFallbackCard() {
    const c = fallbackCard; if (!c || !snapshot) return;
    const stored = storedFallback();
    const off = stored ? isSlotOff("final") : false;
    c.summary.textContent = stored
      ? `${fallbackModes[stored.mode] || stored.mode} · ${friendlyTuple(stored)} · ${states[snapshot.finalFallbackStatus || "unconfigured"]}${off ? " · pausiert" : ""}`
      : "Nicht konfiguriert — das Management-Routing meldet eine präzise INPUT_REQUIRED-Anweisung; keine automatische Providerwahl.";
    c.card.classList.toggle("slot-off", off);
    c.finalToggle.label.hidden = !stored;
    c.finalToggle.input.checked = stored && !off;
    c.finalToggle.input.disabled = noWriteWindow() || !slotDisabledCapable() || !!c.conflict;
    const upgradeNeeded = snapshot.policy.schemaVersion === 1;
    const compatible = snapshot.capabilities.optionalProfiles || !upgradeNeeded;
    c.hint.textContent = `${c.dirty ? "Ungespeicherte Änderungen. " : ""}${snapshot.catalogStatus !== "complete" ? "Kein vollständiger Katalog; eine neue Fallback-Zuordnung kann nicht gespeichert werden (Entfernen bleibt möglich). " : ""}${upgradeNeeded && !snapshot.capabilities.optionalProfiles ? "Aktiver MCP-Adapter bestätigt die Erweiterung auf Format 3 nicht. Normalen autorisierten Reconnect und Tooldiscovery prüfen. " : ""}${upgradeNeeded ? "Beim ersten Fallback-Save wird die Policy auf Format 3 erweitert; das vorhandene Original wird gesichert. Ältere Connectoren können Format 3 nicht lesen. " : ""}${perProfileRegime() ? "Profilbezogener Modus aktiv: Diese globale Endstufe ist nicht Teil der neuen Kette, bleibt aber gespeichert und lesbar und wird nicht still angehängt. " : ""}${stored && !slotDisabledCapable() ? "Aktiver MCP-Adapter bestätigt das Slot-Pausieren (Format 5) nicht; der Schalter bleibt gesperrt. " : ""}`;
    fillModes(c.controls.mode, c.draft.mode);
    populate(c.controls.provider_id, (snapshot.catalog?.providers || []).map(p => [p.provider_id, p.name]), c.draft.provider_id);
    const models = sortedModels((snapshot.catalog?.models || []).filter(m => m.provider_id === c.draft.provider_id));
    populate(c.controls.model_id, models.map(m => [m.model_id, m.name]), c.draft.model_id);
    const variants = models.find(m => m.model_id === c.draft.model_id)?.variants || [];
    populate(c.controls.variant, variants.map(v => [v, v]), c.draft.variant);
    c.save.textContent = upgradeNeeded ? "Fallback speichern und Policy erweitern" : "Fallback speichern";
    c.save.disabled = off || writing || pendingUncertain() || formatBlocked || c.conflict || !compatible || snapshot.catalogStatus !== "complete";
    c.clear.disabled = off || writing || pendingUncertain() || formatBlocked || c.conflict || !stored;
    c.fieldset.disabled = !!c.saving || off;
    c.recovery.hidden = !c.conflict && !fallbackUncertain;
    c.recovery.disabled = writing || loading || formatBlocked;
  }
  async function saveFallback(kind) {
    const c = fallbackCard;
    if (!c || writing || loading || pendingUncertain() || formatBlocked || c.conflict) return;
    const submitted = kind === "clear" ? null
      : { mode: c.draft.mode, selection: { provider_id: c.draft.provider_id, model_id: c.draft.model_id, variant: c.draft.variant } };
    if (submitted && !validateFallbackDraft(c)) return;
    const revision = snapshot.policy.revision;
    const previousFocus = document.activeElement;
    writing = true; c.saving = true;
    c.feedback.textContent = kind === "clear" ? "Fallback wird entfernt …" : "Fallback wird gespeichert …"; updateAll();
    try {
      const response = await fetch("/api/control/fallback", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, fallback: submitted }), signal: AbortSignal.timeout(20000) });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (result?.code === "POLICY_SAVE_UNCONFIRMED") throw new Error("Unconfirmed");
        if (result?.code === "POLICY_REVISION_CONFLICT") { c.conflict = true; c.compared = false; c.feedback.textContent = "Policy anderweitig geändert; dein Entwurf bleibt. Aktuellen Stand vergleichen und bewusst erneut speichern."; }
        else if (result?.code === "POLICY_FORMAT_UNSUPPORTED") { formatBlocked = true; c.feedback.textContent = "Policyformat nicht unterstützt. Bearbeitung gesperrt; Version/Format prüfen."; }
        else c.feedback.textContent = result?.code === "SELECTION_UNAVAILABLE" ? `Nicht gespeichert: ${states[result.reason]}. Entwurf erhalten; Katalog aktualisieren.` :
          result?.code === "CATALOG_UNAVAILABLE" ? "Aktuell kein vollständiger Katalog; Fallback nicht gespeichert. Entwurf erhalten." :
          result?.code === "POLICY_CAPABILITY_UNAVAILABLE" ? "Aktiver Adapter bestätigt die Formaterweiterung nicht. Nicht gespeichert." :
          `Service-/Requestfehler ${response.status}; Entwurf erhalten. ${result?.error || ""}`;
      } else {
        if (!result?.policy) throw new Error("Unconfirmed");
        snapshot.policy = result.policy;
        c.baseline = storedFallback(); c.draft = c.baseline ? { ...c.baseline } : blankFallback();
        c.dirty = c.conflict = c.compared = false;
        snapshot.finalFallbackStatus = result.policy.finalFallback ? "available" : "unconfigured";
        c.feedback.textContent = kind === "clear"
          ? `Fallback entfernt · Revision ${result.policy.revision}. Das Management-Routing meldet bis zur Neukonfiguration INPUT_REQUIRED.`
          : `Fallback gespeichert · Revision ${result.policy.revision}. Strategie: ${fallbackModes[result.policy.finalFallback.mode]}.`;
      }
    } catch {
      fallbackUncertain = { submitted, revision };
      c.feedback.textContent = "Speicherergebnis nicht bestätigt. Zurücklesen und abgleichen; kein automatischer Wiederholungswrite.";
      c.recovery.textContent = "Speicherstand zurücklesen";
    } finally {
      writing = false; c.saving = false; updateAll();
      if (document.activeElement === document.body && previousFocus?.isConnected) previousFocus.focus();
    }
  }
  function updateAll() {
    if (!snapshot) return;
    $("control-status").textContent = `Katalog: ${ { complete: "geprüft", incomplete: "unvollständig", unavailable: "nicht verfügbar" }[snapshot.catalogStatus]} · Format ${snapshot.policy.schemaVersion} · Revision ${snapshot.policy.revision}`;
    $("control-catalog").textContent = snapshot.catalog ? `${snapshot.catalog.providers.length} Provider · ${snapshot.catalog.models.length} Modelle. ${snapshot.catalog.providers.map(p => p.name).join(" · ")}` : "Katalog nicht verfügbar. MCP bei den Verbindungen prüfen; gespeicherte Profile bleiben erhalten.";
    if (!strategiesCard) createStrategiesCard();
    if (!fallbackCard) createFallbackCard();
    Object.keys(roles).forEach(profile => { updateCard(profile); updateOwnCard(profile); });
    updateStrategiesCard();
    updateFallbackCard();
  }
  function accept(next) {
    for (const profile of Object.keys(roles)) {
      if (!cards[profile]) createCard(profile);
      const c = cards[profile], stored = next.policy.profiles[profile];
      if (!c.dirty && !c.conflict && uncertain?.profile !== profile) { c.draft = { ...(stored || blank()) }; c.baseline = stored; }
      else if (!equal(c.baseline, stored)) { c.conflict = true; c.compared = false; c.recovery.textContent = "Aktuellen Stand vergleichen"; }
    }
    if (!fallbackCard) createFallbackCard();
    if (!fallbackCard.dirty && !fallbackCard.conflict && !fallbackUncertain) {
      const stored = next.policy.finalFallback ? { mode: next.policy.finalFallback.mode, ...next.policy.finalFallback.selection } : null;
      fallbackCard.draft = stored ? { ...stored } : blankFallback();
      fallbackCard.baseline = stored;
    }
    snapshot = next; formatBlocked = false;
    for (const profile of Object.keys(roles)) {
      const c = own[profile]; if (!c) continue;
      const stored = storedOwn(profile);
      if (!c.dirty && !c.conflict && ownUncertain?.profile !== profile) { c.draft = { ...(stored || blank()) }; c.baseline = stored; }
      else if (!equal(c.baseline, stored)) { c.conflict = true; c.compared = false; c.recovery.textContent = "Aktuellen Stand vergleichen"; }
    }
    if (strategiesCard && !strategiesCard.dirty && !strategiesCard.conflict && !strategiesUncertain) {
      strategiesCard.baseline = { ...effectiveStrategies() }; strategiesCard.draft = { ...strategiesCard.baseline };
    }
    updateAll();
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
      if (fallbackUncertain) {
        const { submitted, revision } = fallbackUncertain, c = fallbackCard;
        fallbackUncertain = null;
        const stored = next.policy.finalFallback ? { mode: next.policy.finalFallback.mode, ...next.policy.finalFallback.selection } : null;
        if (next.policy.revision > revision && sameFallback(stored, submitted)) {
          c.baseline = stored; c.draft = stored ? { ...stored } : blankFallback(); c.dirty = c.conflict = c.compared = false;
          c.feedback.textContent = `Passender Fallback-Stand bei fortgeschrittener Revision ${next.policy.revision} gespeichert; Urheberschaft nicht bewiesen.`;
        } else { c.conflict = true; c.compared = false; c.feedback.textContent = "Fallback-Speicherergebnis nicht bestätigt. Aktuellen Stand und Entwurf vor erneutem Save vergleichen."; }
      }
      if (ownUncertain) {
        const { profile, selection, revision } = ownUncertain, c = own[profile];
        ownUncertain = null;
        const stored = storedOwn(profile);
        if (next.policy.revision > revision && equal(stored, selection)) {
          c.baseline = stored; c.draft = { ...(stored || blank()) }; c.dirty = c.conflict = c.compared = false;
          c.feedback.textContent = `Passendes eigenes Fallback bei fortgeschrittener Revision ${next.policy.revision} gespeichert; Urheberschaft nicht bewiesen.`;
        } else { c.conflict = true; c.compared = false; c.recovery.textContent = "Entwurf nach Abgleich freigeben";
          c.feedback.textContent = "Speicherergebnis nicht bestätigt. Aktuellen Stand und Entwurf vor erneutem Save vergleichen."; }
      }
      if (strategiesUncertain && strategiesCard) {
        const { submitted, revision } = strategiesUncertain, c = strategiesCard;
        strategiesUncertain = null;
        if (next.policy.revision > revision && sameStrategies(storedStrategies(), submitted)) {
          c.baseline = { ...effectiveStrategies() }; c.draft = { ...c.baseline }; c.dirty = c.conflict = c.compared = false;
          c.feedback.textContent = `Passende Schalter bei fortgeschrittener Revision ${next.policy.revision} gespeichert; Urheberschaft nicht bewiesen.`;
        } else { c.conflict = true; c.compared = false; c.recovery.textContent = "Entwurf nach Abgleich freigeben";
          c.feedback.textContent = "Speicherergebnis der Schalter nicht bestätigt. Aktuellen Stand vor erneutem Save vergleichen."; }
      }
      updateAll(); return true;
    } catch (error) {
      updateAll(); $("control-status").textContent = `${error.message} ${snapshot ? "Letzte bekannte Beobachtung; Entwürfe erhalten." : "Noch keine Policy geladen."}`;
      window.dispatchEvent(new Event("hub-control-unavailable"));
      return false;
    } finally { loading = false; [...Object.values(cards), ...Object.values(own)].forEach(c => { c.recovery.disabled = formatBlocked; });
      if (strategiesCard) strategiesCard.recovery.disabled = formatBlocked; }
  }
  async function saveProfile(profile, selection) {
    const c = cards[profile]; if (writing || loading || pendingUncertain() || formatBlocked || c.conflict) return;
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
  window.addEventListener("beforeunload", event => { if (pendingUncertain() || fallbackCard?.dirty || strategiesCard?.dirty || Object.values(cards).some(c => c.dirty) || Object.values(own).some(c => c.dirty)) { event.preventDefault(); event.returnValue = ""; } });
  $("refresh-control").addEventListener("click", load); $("refresh").addEventListener("click", load); void load();
})();
