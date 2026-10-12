# Konzeptplan task_f2d0ccc6-6212-5470-a7bd-ce2d6b086154
## Laufzeitprofile: Primary-Belegung manuell pausieren und reaktivieren

## Revision EXTENDED-IMPLEMENTED-20261012 (supersede CONCEPT-READY-20261012, wo abweichend)

Basis: Main `a071245fbf717a3ad6f8038d67820166ea6c4a49` · Script 0.7.35 · Adapter 0.1.44 · Skill r52 · Worktree/Branch `.opencode-vm/worktrees/task_f2d0ccc6-primary-pause-concept` / `task/f2d0ccc6-primary-pause` · Boardticket `01M4R4F6AHE193E7MT4CPATM9T` (INBOX #19).

**Nutzerklarstellung (msg-Folgeauftrag, Implementierungs-Go):** slotbezogene Sicht — nicht nur der Primary, sondern **jeder vorhandene Fallback-Eintrag** (eigene Profilfallbacks je Profil **und** der Legacy-Finalfallback, wo dessen UI/Regime sichtbar ist) ist einzeln aktivier-/deaktivierbar; kleiner An/Aus-Schalter; ausgeschaltet sind die Auswahlfelder ausgegraut; gespeicherte Belegung bleibt erhalten, Reaktivierung stellt sie wieder bereit. MCP liest/setzt expliziten gespeicherten Zustand **plus** wirksame Auflösung wahrheitsgemäß. Deaktiviert = effektiv nicht auswählbar, aber nicht gelöscht/null und kein Providerfehler. Kein globaler Provider-/Account-/Modellbann; identische Runtime in anderem aktiven Slot bleibt möglich; kein Ablaufdatum/Auto-Reaktivierung; fehlendes Flag bei alten Policies = aktiviert.

**Korrektur zum CONCEPT-READY-Entwurf:** Der Satz „Neue Aufträge verwenden heute nie finalFallback/eigene Profilfallbacks — die Pause darf diesen Kandidatenraum nicht erweitern" beschrieb nur den Ist-Zustand und ist als Beschneidung des Auftrags **zurückgezogen**. Autorisiert ist die Funktion: neue Aufträge nutzen bei pausiertem Primary sofort den bereits konfigurierten erlaubten Fallback ohne Primaryrequest oder provozierten Fehler. Umsetzung: **eine gemeinsame zentrale Kandidatenbildung** (`newStartCandidates`/`recoveryCandidates` in `agent-control.ts`, keine zweite Implementierung; Hub bleibt Nur-Leser): per_profile-Regime eigener aktivierter Fallback zuerst, weitere reguläre Stufen nur nach explizit aktivierter Degradierung (`STAGE_ORDER`); Legacy-Regime korrekt ohne unerlaubte Mischung — Eintrags-Primary plus feste Design/Review-Auflösungsmap, **nie** der Legacy-Finalstufe (die bleibt Fehler-Endstufe, ist aber als Slot einzeln pausierbar). Deaktivierte Slots werden übersprungen, Reihenfolge aktiver Slots erhalten; alles aus/kein zulässiger Kandidat ⇒ präziser Hold (`hold_disabled` bzw. Park mit sichtbarem Grund), keine Backenddefaultwahl, keine erfundenen Modelle. Optional-Profile/Null bleiben unterschieden. Kein Request/Attempt/failed-provider-Eintrag für ausgeschaltete Slots.

**Schema 5 (implementiert):** additiv auf 4 — `disabled: {profiles:{5×bool}, profileFallbacks:{5×bool}, finalFallback:bool}`; fehlend bei Schema 1–4 = alles aktiv; Setzen von `true` upgraded mit Exact-Bytes-Backup (`schema4`-Label bzw. `schema1/2/3`), Clear senkt nie ab; `routing.regime`/`candidate_order` unbeeinflusst (Regime-Regel `>= 4` in TS **und** Hub); Key-Order-Parität Python/TS (`disabled` letzter Key).

**Implementierungsstand (dieser Worktree, Bereit für unabhängige QC):**
- Adapter (Commit `9316b86`): `agent-control.ts` (Schema-5-Leser `parseDisabled`/`EXPECTED_KEYS[5]`, `SlotDisabled`-Typen, `slotDisabled`/`newStartCandidates`/`recoveryCandidates`, `resolveRecoveryChain` mit `skipped_disabled` nach current/attempted und vor unavailable/provider-scope, `resolveProfile` deaktiviert-bewusst mit `hold_disabled`+`candidates`+`resolved_label`, `describePolicy` mit `disabled` je Slot + `resolution`-Block, `fallbackChain` pausengefiltert, `routingRegime >= 4`), `policy-commit.ts` (`commitSlotDisabled`, Upgrade-Checks `< 4`/`< 5` gegen Schema-5-Dokumente, `disabled` in allen Planern), `tools.ts` (`set_project_model_policy_slot_disabled`, additiver Output inkl. `hold_disabled`), `monitor-main.ts` (policyView+disabled), `monitor-engine.ts` (`resolveRuntime` über geteilte Kandidatenbildung — deaktivierte Slots vor jedem Request übersprungen; Parkgründe mit wahrheitsgemäßem Reason-Text; `recovery-chain-disabled` nicht restartable; `runtime-unavailable` in die Resume-Menge aufgenommen, damit das Parklabel nach Reaktivierung+gesundem Dispatch ehrlich endet; `monitor.ts` Statusvokabular +`skipped_disabled`).
- Hub (Commit `0abc435`): `hub/policy.py` (`KEY_SETS`+5, `validate_disabled`/`disabled_view`/`slot_disabled`, `update_slot_disabled` mit Schema-2/4/5-Fähigkeitsprüfung, `new_start_candidates`/`resolve_profile` Parität, alle Writer reichen `disabled` durch), `hub/server.py` (Routen `PUT /api/control/profiles/<name>/disabled`, `/profiles/<name>/fallback/disabled`, `/fallback/disabled`; Snapshot `disabled`+`resolutions`+`capabilities.slotDisabled` tolerant), `hub/catalog.py` (`_supports_slot_disabled`/`read_slot_disabled_capabilities`, Flags aus EINER tools/list-Discovery), `hub/control.js`/`styles.css` (An/Aus-Schalter je gespeichertem Slot, Ausgrauen via `.slot-off`+fieldset-disabled, gespeichertes Tupel sichtbar, ehrliche Konflikt-/Unbestätigt-Texte, kein `loading`-Term im Disabled-Ausdruck weil `load()`-finally kein updateAll macht).
- Tests: Adapter 288/286+2 SKIP grün (`agent-control.test.ts` Schema-5-Leser/Regime/Kandidaten/Resolver/describePolicy, `policy-commit.test.ts` Upgrade/Backup/CAS/Clear/Validierung, `monitor.test.ts` Dispatch auf Fallback/Reaktivierung/All-off-Park/Recovery-chain-disabled ohne Requests/Attempts, `http.test.ts` 45 Tools + Wire-Readback), Python 62 grün (`agent_control_test.py` Store/Router/Capability/Vektoren — Fixture `ach1-resolution.json` um Deaktiviert-Vektoren erweitert, Python/TS-Parität), `hub_test.py` 45 grün, crosswriter/dashboard grün, **echter Browser-UI-Test** (`ach1_browser_test.mjs`, Disposable-Fixture): Schalter klicken → Schema-5-Persistenz+Backup, Ausgrauen, `pausiert`-Sichtbarkeiten, Reload-Persistenz, wirksame Auflösung auf den eigenen Fallback (`resolved_label: deep.fallback`), Reaktivierung mit bytegleichem Tupel, Regime unverändert.
- Grenzen/Offen für gemeinsame Integration mit dem Noninteractive-Strang (`task/external-dir-noninteractive`, Kandidat 0.7.36/Adapter 0.1.45, Korrekturrunde): überlappende Dateien `monitor-engine.ts`, `tools.ts` (Registrierungszählung 44→45), Docs (`docs/MCP-INTERFACE.md`, `AGENTS.md` Zähl-/Oberflächensätze), Fixture. Kein eigener Versionsbump (geteilter Bump beim parallelen Owner); Live-Browser-/Engine-Abnahme am installierten Stack bleibt separate externe Abnahme; `runtime-unavailable`-Parks historischer Monitore bleiben bis zum nächsten gesunden Dispatch gelabelt (bestehendes Verhalten, jetzt resume-fähig).

Die ursprüngliche Analyse (§0–§10) bleibt als Begründungshistorie gültig; abweichend gilt ausschließlich diese Revision.

---

## 0. Auftragsgrenzen dieses Dokuments

Technische Untersuchung und Konzept im isolierten Worktree. Keine Featureimplementierung, kein Versionsbump, keine Integration/Push/Veröffentlichung/Deployment, keine Live-Policy-/Profil-/Monitoränderung, kein Schreiben in Main oder in den Baum des parallelen Noninteractive-Owners (`ses_ecf9566a1ffeuYwMQg3luq7cHr`, Worktree `task_25b3af4f-external-dir-noninteractive`, mögliche Überlappung: `runtime/managed-core.mjs`, `runtime/managed-policy.mjs`, `adapters/mcp/src/opencode.ts`, `monitor-engine.ts`, Tests/Docs). Der Nutzer entscheidet gerade über die Semantikfragen D1–D3 (§7); alle dortigen Regeln sind **Vorschläge**, keine Entscheidungen.

Nicht verhandelbare Rahmenbedingungen (aus Ticket und Auftrag, codeverifiziert umsetzbar):
- Gespeicherte Runtime (`profiles[x]`, `profileFallbacks[x]`, `finalFallback`) bleibt bytegleich erhalten; Pause ist ein separater Zustand, keine Löschung/Neukonfiguration.
- Kein Provider-/Account-globaldisable; die Pause gilt (Empfehlung D1) nur für den konkreten Primary-Slot eines Profils.
- Keine synthetischen Providerfehler, keine erfundenen Ersatzmodelle, keine Guardumgehung: Pausiert wird **vor dem ersten Request übersprungen** (Skip in der Kandidatenbildung), nicht durch einen fingierten Fehler.
- Fehlender/ungeeigneter/erschöpfter zulässiger Fallback → verständlicher Input-/Hold-Zustand (parked/INPUT_REQUIRED), keine Ersatzwahl, keine Endlosschleife.
- Keine automatische Ablaufsteuerung, keine Cooldown-/Zeitsteuerung, keine Quotaerkennung. Reaktivierung ausschließlich explizit (UI/MCP).

---

## 1. Befund: Was ist die „Primary-Belegung" und wer konsumiert sie

### 1.1 Persistenz (der Schaltzustand muss hier leben)

Die Primary-Belegung eines Profils ist `Policy.profiles[<name>]` — Persistenz in `.opencode-vm/agent-control.json` mit `schemaVersion` 1–4, `revision`-CAS, `flock` unter `.opencode-vm/agent-control.lock`, Exact-Bytes-Backup beim Schemaupgrade und atomarer Rename-Publikation.

| Leser/Schreiber | Ort |
|---|---|
| TS-Leser (strenge Schlüsselmengen) | `adapters/mcp/src/agent-control.ts:51-56` (`EXPECTED_KEYS`), `readPolicy` `agent-control.ts:80-138` |
| TS-CAS-Schreiber | `adapters/mcp/src/policy-commit.ts:231-287` (`commitPolicyMutation`: Lock → Revision-CAS → Backup → Publish) |
| Hub-Leser/Schreiber (Python, derselbe Lock) | `hub/policy.py:28-31` (`KEY_SETS`), `PolicyStore._write` `hub/policy.py:333-359` |
| Schlüsselreihenfolge-Parität | `_document`/`_persisted` `hub/policy.py:55-69` ↔ `persisted`-Objekt `policy-commit.ts:262-272` |

Ein neuer persistenter Zustand **muss** therefore als additive `schemaVersion 5` in derselben Datei abgelegt werden (Alternative Sidecar-Datei verworfen: zweites Lock/CAS-Surface, Bruch mit dem Ein-Datei-Design, das UI/MCP-Parität über denselben Lock herstellt).

### 1.2 New-Start-Konsumenten der Primary-Belegung (die Anschlussstellen)

1. **Monitor-Arbeitsdispatch (der eigentliche New-Start-Pfad):** `MonitorEngine` liest pro Wake die Policy und erzwingt die Primary-Belegung des Monitorprofils auf der wiederverwendeten Session:
   - `adapters/mcp/src/monitor-engine.ts:537` — `resolveRuntime(monitor)` im Dispatchpfad (nach Busy-/Pending-Checks, vor WAL+`sendMessage`).
   - `monitor-engine.ts:1713-1756` — `resolveRuntime`: `readPolicy()` → `resolveProfileSelection` → Katalogverfügbarkeit → `updateSessionRuntime` → **verifiziertes Readback** (inkl. Variantenprüfung :1748-1752); `kind: unavailable` → `parked_input_required`/`runtime-unavailable` (:538-545).
   - `monitor-engine.ts:1758-1764` — `resolveProfileSelection`: liest **nur** `policy.profiles[profile]`. Genau hier greift die Pause für neue Aufträge.
   - Policy-Projektion zur Engine: `adapters/mcp/src/monitor-main.ts:80-94` (`policyView` → `MonitorPolicyView`, `readPolicy`-Dep `monitor-engine.ts:126/205/251`).
2. **Management-Lese-/Empfehlungspfad (MCP):** `get_recommended_runtime` → `resolveProfile` (`agent-control.ts:216-227`; feste Auflösungsmap `FALLBACKS` :7: design→standard, review→deep→standard). Nur `null` wird übersprungen; konfiguriert-unverfügbar stoppt. Zweiter New-Start-Anschluss (Orchestratoren vor Auftragserteilung).
3. **Recovery-Kandidatenbildung (gemeinsame Resolver, genau eine Implementierung):** `resolveRecoveryChain` (`agent-control.ts:353-435`), benutzt von `recover` (`monitor-engine.ts:1843-1884`), erzeugt pro Stufe `<stage>.main` bzw. `<stage>.fallback` (per_profile) bzw. `degrade.*`/`final.main` (Legacy) mit Statusen `selected|skipped_current_failure|skipped_attempted|skipped_provider_scope|skipped_unavailable` (:324-329). Die pausierte Primary-Belegung ist hier als neuer Skip-Grund `skipped_paused` zu integrieren — **vor** Verfügbarkeits-/Attempt-Prüfung der Semantik nach als eigener Status.
4. **Konfigurationsprojektionen (nur Lesart, keine Auswahl):** `candidateOrder` (`agent-control.ts:182-192`) und Hub-Gegenstück (`hub/policy.py:163-183`), `describePolicy` (`agent-control.ts:194-214`), `profileState` (`agent-control.ts:140-148`), Hub-Snapshot (`hub/server.py:267-278`), `resolve_profile` (`hub/policy.py:440-452`).

### 1.3 Was die Primary-Belegung heute NICHT tut (wichtig für die Pausenwirkung)

- Neue Aufträge verwenden **nie** `finalFallback` oder eigene Profilfallbacks: `resolveProfileSelection` liest ausschließlich `profiles[profile]`; `finalFallback` ist eine **Fehler**-Endstufe (Recovery), `profileFallbacks` sind Recovery-Kettenkandidaten. Die Pause darf diesen Kandidatenraum für neue Aufträge **nicht erweitern** („keine beliebige Modellwahl"): zulässig sind nach Pausierung nur die Kandidaten, die der reguläre Auswahlweg ohnehin kennt — im per_profile-Regime eigener Fallback zuerst, weitere reguläre Stufen nur bei explizit aktiviertem Degrading (`STAGE_ORDER` `agent-control.ts:14-20`, `strategies_effective` :168); im Legacy-Regime nur die feste Auflösungsmap design→standard, review→deep→standard.
- Provider-Skip-Evidenzregeln (`providerFailureScope` :271-273, Admission-Set :255-262) bleiben unverändert; die manuelle Pause ist **kein** Evidenzereignis und schreibt keine `recovery_episode`-Attempts.

---

## 2. Schema-5-Entwurf (additiv, minimal)

Neuer Schlüssel nur bei Bedarf (YAGNI, strikte Schlüsselmengen bleiben):

```
schemaVersion: 5   // additiv auf 4; 1–4 bleiben gültig und unverändert
primaryPaused: { deep: bool, standard: bool, execution: bool, design: bool, review: bool }
```

- **Vollständig besetzte 5-Key-Map mit `false`-Defaults im Dokument** (kein Sparse-MAP): die bestehenden Leser validieren mit exakten Schlüsselmengen und Maps über alle Profile (`agent-control.ts:99-101/121`, `hub/policy.py:110-111/201`); ein voll besetztes Objekt folgt exakt dem `profileFallbacks`-Muster und hält beide Implementierungen symmetrisch.
- **`EXPECTED_KEYS[5]`** (`agent-control.ts:51-56`) und **`KEY_SETS`** (`hub/policy.py:28-31`) um Eintrag 5 erweitern; `validate_policy` (`hub/policy.py:186-211`) und `readPolicy` (`agent-control.ts:80-138`) um `primaryPaused`-Validierung (nur bool). Schema 1–4 werden unverändert gelesen; fehlender Schlüssel ⇒ effektiv alles `false` (aktive Primary-Belegung, exakt heutiges Verhalten).
- **CAS-Schreiber:** TS `commitPrimaryPaused(runtime, expectedRevision, profile, paused)` nach dem Muster `commitProfileFallback` (`policy-commit.ts:316-338`): Schreiben von `true` auf Schema <5 ⇒ Upgrade auf 5 mit Exact-Bytes-Backup `agent-control.schema4-rev<n>.backup.json` (`backupLabel: "schema4"`); Clear (`false`) senkt nie ab; alle anderen Schlüssel bytegleich erhalten (`profiles`, `profileFallbacks`, `strategies`, `finalFallback` unverändert). Hub-Gegenstück `update_primary_paused` nach Muster `update_strategies` (`hub/policy.py:305-331`) inkl. `_backup`-Label und Canonical-Key-Order (`_document` :55-64: `primaryPaused` nach `strategies`).
- **Downgrade/Alter-Leser:** Alte Adapter (<Implementierungsversion) können Schema 5 nicht lesen → bestehendes Fail-closed (`UNSUPPORTED_CONFIGURATION`) und Hub-Capability-Gate (§5.3). Ein Schema-5-Dokument wird von alten Hub-Versionen mit `PolicyError("Unsupported Agent Control policy format.")` (`hub/policy.py:188`) abgelehnt — gleiches Verhalten wie beim Schema-4-Release, dokumentiert, kein stiller Fallback.
- **Explizit kein Feld:** keine Zeitstempel, Ablauf-, Cooldown- oder Quotadaten (§0, D3).
- **Capability-Discovery:** neue Flag in `read_policy_capabilities` (`hub/catalog.py:171-183`) via `tools/list`-Erkennung des neuen Write-Tools (Muster `_supports_profile_fallbacks`); ältere Adapter ⇒ Hub-UI sperrt den Schalter mit bestehendem Hinweistext-Muster (`hub/control.js:188/361-362`).

### 2.1 Warum kein `paused`-Feld in der Selection selbst

`Selection` (`{provider_id, model_id, variant}`, `agent-control.ts:22/58-65`) wird an vielen Stellen identitätsrelevant verwendet (`runtimeIdentityKey` :276-278, Attempts, Recovery-Views `RecoveryRuntimeTuple` :237). Ein Feld dort würde jede Vergleichs-/Bytegleichheitsstelle berühren und „gespeicherte Runtime bytegleich" gefährden. Getrennter Top-Level-Schlüssel hält die Runtime unverändert (Anforderung) und die Migrationsfläche minimal.

---

## 3. Resolver-Integration (genau eine Implementierung, im gemeinsamen Resolver)

### 3.1 `resolveRecoveryChain` (Recovery, `agent-control.ts:353-435`)

- Neuer Kandidatenstatus **`skipped_paused`** (Enum `RecoveryCandidateStatus` :324-329 additiv erweitern). Filterreihenfolge pro Kandidat: `currentIdentity` → `attempted` → **`primaryPaused[stage]` bei Label `<stage>.main`** → Verfügbarkeit → Provider-Skip. `skipped_paused` wird **vor** `skipped_unavailable` geprüft, damit der wahre Grund (manuell pausiert) nicht als Katalogproblem misslesbar ist; Reihenfolge `current/attempted` davor bleibt (eine identische, wirklich gescheiterte Runtime bleibt `skipped_attempted`/`skipped_current_failure` — der Attempt-Verlauf ist das stärkere Ereignis).
- **Nur `<stage>.main`-Kandidaten sind pausierbar.** `<stage>.fallback`-, `degrade.*`- und `final.main`-Kandidaten haben keinen Pausezustand (D1-Minimalbereich). In `resolveRecoveryChain` sind therefore nur per_profile-`stage.main` und Legacy-`degrade.<profile>.main` betroffen (`final.main` nie).
- Legacy-Regime: `degrade.<p>.main` entsteht nur bei `finalFallback.mode==="degrading"`; pausierte Profile werden dort übersprungen, `final.main` läuft unverändert. `fallbackChain` (`agent-control.ts:303-322`) bleibt als Legacy-Projektion bestehen und erhält dieselbe Pausefilterung (eine Code Stelle je Funktion, keine zweite Resolverimplementierung — Vertrag „shared recovery-policy resolution" :229-235).
- `reason`-Bild unverändert (`chain_empty|chain_exhausted|selected`); ein nur durch Pausen erschöpfter Chain endet im bestehenden sichtbaren Park-Pfad (`monitor-engine.ts:1919-1935`) mit erweitertem Grundvokabular (§6).
- Persistente Resolution-Projektion (`resolutionEntry`, `monitor-engine.ts:1888-1896`) enthält bereits `policy_revision` und Kandidatenstatusen — `skipped_paused` fließt dort automatisch ein (nachvollziehbarer Skipgrund, Anforderung 6).

### 3.2 `resolveProfile` / `get_recommended_runtime` (Management-Resolution, `agent-control.ts:216-227`)

- Walk `[profile, ...FALLBACKS[profile]]`: **pausierte Kandidaten werden übersprungen** (statt nur `null`), `resolution_path` protokolliert den weiteren Weg. Paused ist kein Abbruchgrund im Walk (anders als konfiguriert-unverfügbar, das weiterhin stoppt — bestehende Semantik „nur null wird übersprungen" wird um „null **oder pausiert** wird übersprungen" präzisiert; Ticketforderung 3).
- Neues Ergebnissvokabular additiv am Result-Objekt (kein Umbau bestehender Felder): wenn kein Kandidat auflösbar ist, unterscheidet der Terminalzustand `hold_primary_paused` (mindestens ein Kandidat existierte, aber alle sind pausiert/ungen allowable) von `unconfigured`. Kein `runtime`-Feld in Hold-Fällen. MCP-Output-Schema (`tools.ts:512-516`) additiv erweitern; bestehende Statuswerte unverändert.
- `profileState` bleibt **unverändert** (Katalogstatus); Pausiert ist eine orthogonale Dimension, kein Katalogstatus — „Pausiert, unkonfiguriert, katalogseitig unverfügbar und bestätigter Laufzeitfehler" bleiben vier unterscheidbare Zustände (Pausiert = Policy-Flag; unkonfiguriert = `selection:null`; katalogseitig = `profileState`; Laufzeitfehler = Recovery-Evidenzkategorien :255-262).

### 3.3 Monitor-Arbeitsdispatch (`resolveRuntime`, `monitor-engine.ts:1713-1764`)

Heutige Logik: Primary konfiguriert ⇒ auf Session erzwingen; unkonfiguriert ⇒ `unavailable/not configured` ⇒ parked. Mit Pause:

- `resolveProfileSelection` wird zur pfadbewussten Auswahl: pausierter Primary ⇒ nächster **erlaubter** Kandidat laut §1.3 (per_profile: eigener Fallback derselben Stufe, dann nur bei `strategies_effective.degrading` die `STAGE_ORDER`-Stufen — jeweils Stufe.main vor Stufe.fallback, identisch zur `resolveRecoveryChain`-Kandidatenordnung; Legacy: Auflösungsmap). Der ausgewählte Kandidat durchläuft unverändert Katalogprüfung, `updateSessionRuntime` und verifiziertes Readback.
- **Kein eigener zweiter Resolver im Engine-Code:** die erlaubte Kandidatenbildung wird als Funktion im gemeinsamen Modul (`agent-control.ts`) ergänzt (z. B. `resolveProfileCandidates(policy, profile): {label, tuple, paused}[]` bzw. eine `resolveEffectiveRuntime(policy, profile, {catalog})`-Variante, die `resolveRecoveryChain`-Filterung ohne Failure-Evidenz nutzt) und von `resolveProfile`, `resolveRuntime` und (mit Evidenz) `resolveRecoveryChain` geteilt. Der bestehende Vertrag „keine zweite Implementierung in monitor-engine.ts oder Hub" (:229-235) bleibt gewahrt; der Hub bleibt Nur-Leser der Engine-Projektion.
- Unauflösbar (alles pausiert/ungen allowable) ⇒ bestehender Park-Pfad :538-545 mit neuem, wahrheitsgemäßem Grund (§6), **nicht** `runtime-unavailable` (das wäre katalogseitig missverständlich).
- Wiederaufnahme nach Reaktivierung: nächster Dispatch findet aktive Primary-Belegung, `updateSessionRuntime` schaltet die Session zurück (identischer verifizierter Pfad). Kein gesonderter Rückwechsel-Code nötig.

---

## 4. Race-sicherer Dispatchschnitt (Umschaltzeitpunkt explizit definiert)

Fakten: Policy-Schreibungen erfolgen unter `flock` + atomarem Rename (`policy-commit.ts:191-213`, `hub/policy.py:373-391`); `readPolicy` liest **ohne** Lock, aber Rename ist atomar — kein gerissener Read, nur alt-oder-neu.

**Definierter Umschaltmoment (Vorschlag, verträglich mit „neue Starts erhalten aktuelle Pause, laufende Arbeit unverändert"):** Für einen Dispatch/Recovery ist die **bei der Resolution gelesene Policy-Revision** verbindlich (`resolveRuntime`: Read in :1716 vor WAL+Send; `recover`: Read in :1843 vor Runtime-Switch+Prompt). Eine nach dieser Read kommittierte Pause/Reaktivierung betrifft den laufenden Dispatch nicht und wirkt beim **nächsten** Resolutionzeitpunkt. Konkret:

1. Neuer Auftrag in wiederverwendeter Session: Pause wirkt, wenn sie vor dem Resolution-Read des Wakes sichtbar war; ein Auftrag, dessen Read vor der Pause lag, startet regulär auf dem Primary (kein Abbruch, kein Mid-Flight-Umschalten — „laufende Arbeit unverändert").
2. Recovery-Episode: laufende Fallbackversuche (bereits `selected` und gesendeter Kandidat) laufen zu Ende; **jede** neue Resolution liest Policy neu (:1843) ⇒ Pausierung wird beim nächsten Recovery-Schritt als `skipped_paused` respektiert; Episode-Attempts bleiben erhalten (`monitor-engine.ts:1861-1871`), Pausen schreiben keine Attempts (§1.3).
3. Zwischen Resolution-Read und `sendMessage` verkleinerte Option: erneuter Read direkt vor dem Send im selben serialisierten Wake (Engine-Wake ist bereits single-flight pro Monitor). **Empfehlung: nicht implementieren** (YAGNI) — das definierte Read-at-Resolution-Semantik ist wahrheitsgemäß, über `policy_revision` in History/Projection (:1905-1911) rekonstruierbar und verlangt keine zweite Konsistenzstelle. Diese Stelle wird im Konzept als bewusste Grenze dokumentiert, nicht als Lücke.

Konfliktfreiheit der Writes: UI und MCP serialisieren auf demselben `agent-control.lock` mit Revisions-CAS (`POLICY_REVISION_CONFLICT` :246; Hub `PolicyConflict` :351) — bestehende Mechanik, keine neue.

---

## 5. UI/MCP-Parität

### 5.1 MCP (Adapter, additive Erweiterung)

- Neues Write-Tool **`set_project_model_policy_primary_paused({revision, profile, paused})`** (Namensfamilie `set_project_model_policy_*` folgt `tools.ts:2505/2524/2538`): `profile ∈ PROFILE_NAMES`, `paused: boolean`; Revision-CAS + Schema-5-Upgrade-Backup; keine Katalogvalidierung nötig (Pause ist unabhängig von Verfügbarkeit — gerade dann sinnvoll, wenn der Primary nicht mehr geht); Response = committed Policy-Readback (bestehendes Muster).
- Read-Parität: `get_project_model_policy` (`tools.ts:2481-2484`) additiv: je Profil `paused: boolean` (effektiv, Schema<5 ⇒ `false`) und als effektive Sicht ein neues `routing`-unabhängiges Feld **`resolution[profile]`** mit dem effektiven nächsten erlaubten Kandidaten samt Weg/Gründen (`skipped_paused|skipped_unavailable|selected|hold_*`, geformt nach `RecoveryChainCandidate`, ohne Evidenzfilter). `routing.candidate_order` bleibt die reine **Konfigurations**projektion (Vertrag :172-181 bleibt unverändert, kein stilles Umdeuten); die Pausensicht lebt im neuen Feld. Schema des Outputs (`tools.ts:493-510`) additiv erweitern.
- `get_recommended_runtime` entsprechend §3.2; Fehlercodes: keine neuen Codes nötig — Hold-Zustände sind Erfolgsantworten mit Status (kein Fehlerfake), CAS-/Lock-Fehler nutzen bestehende `POLICY_REVISION_CONFLICT`/`POLICY_COMMIT_UNAVAILABLE`.

### 5.2 Hub (UI)

- Profilkarte (erzeugt `hub/control.js:50`) erhält einen verständlichen **Aktiv/Pausiert-Schalter** neben der Primary-Zuordnung; gespeichertes Provider/Modell/Variant-Tupel bleibt vollständig sichtbar (Anforderung 1). Zustandsanzeige unterscheidet: aktiv / pausiert / unkonfiguriert / katalogseitig `<status>` (`profileState`) / (im Recovery-Kontext) letzter bestätigter Laufzeitfehler aus der Engine-Projektion — keine Vermischung.
- Write-Pfad: neuer Route **`PUT /api/control/profiles/<name>/primary-paused`** (`{revision, paused}`) neben den bestehenden Routes (`hub/server.py:395-400` Muster) → `PolicyStore.update_primary_paused` (§2). Readback-Pflicht: UI behauptet Erfolg erst nach Readback (bestehendes `pendingUncertain()`/Konfliktmuster `hub/control.js:361-362`).
- Snapshot: `GET /api/control` (`hub/server.py:267-278`) additiv um `primaryPaused` + `resolution`-Projektion; Snapshot-Quelle ist die Policy-Datei bzw. die Engine-Projektion (Hub bleibt laut Vertrag :229-235 **kein** zweiter Resolver — die `resolution`-Sicht im Snapshot kommt aus `describePolicy`-äquivalenter Adapterlogik bzw. wird von Hub aus den additiven Policyfeldern **rein projiziert**; exakte Aufteilung im Implementierungszyklus festlegen, Option A: Hub ruft die gleiche TS-Funktion nicht, sondern zeigt die von `GET /api/control` gelieferte, adapterberechnete `resolution`).
- CSS/Texte folgen bestehenden Kartenmustern; Modellpicker-Alphabetregel bleibt unberührt.

### 5.3 Capability-Gate (Alter Adapter/Hub)

`read_policy_capabilities` (`hub/catalog.py:171-183`) um Flag `primaryPaused` (Erkennung: neues Tool in `tools/list`). Fehlt es: Schalter im UI deaktiviert mit bestehendem Hinweismuster („Aktiver MCP-Adapter bestätigt … nicht", `control.js:188`); MCP-seitig existiert das Tool schlicht nicht (alte Versionen). Ein Schema-5-Dokument mit altem Stack ⇒ Fail-closed beidseitig (§2). Kein stiller Downgrade, kein Verlust des Tupels.

### 5.4 Berechtigungen

UI und MCP respektieren bestehende Policy-Schreibrechte: Hub-Route hinter bestehender Hub-Auth, MCP-Tool hinter Token+bestehenden Write-Annotations (`tools.ts:2508` Muster). Kein Agent gewinnt neue Rechte; Runtimeauswahl bleibt keine Dispatch-/Implementierungsfreigabe (Auftragsrand 6). Änderungsquelle/Revision aus `revision`/`updatedAt` + History-Einträgen nachvollziehbar; keine Credentials/Secrets im Spiel (Policy-Datei enthält ohnehin nur IDs).

---

## 6. Zustands-, Fallback-, Null- und Sonderfälle

### 6.1 Zustandsvokabular (wahrheitsgemäß, vier getrennte Dimensionen)

| Zustand | Quelle | Sichtbar in |
|---|---|---|
| `paused` (manuell) | `primaryPaused[profile]=true` | UI-Schalter, `profiles[x].paused`, `skipped_paused`, Hold-Grund |
| `unconfigured` | `profiles[x]===null` | bestehend (`profileState`, `status:"unconfigured"`) |
| katalogseitig unverfügbar | `profileState` ≠ available | bestehend (provider/model/variant_unavailable, catalog_*) |
| bestätigter Laufzeitfehler | Recovery-Evidenz (`PROVIDER_ERROR_ADMISSION`) | Recovery-History/-Projektion, `skipped_current_failure`/Attempts |

Pausiert wird **nie** als `null` kaschiert und nie als Katalogfehler ausgegeben (Anforderung, Ticket „nicht Pausiert als null kaschieren").

### 6.2 Fallback- und Kettenfälle

- **Eigener Fallback zuerst** (per_profile): pausierter `x.main` ⇒ `x.fallback` (wenn konfiguriert) ⇒ nur bei `strategies_effective.degrading` weitere `STAGE_ORDER`-Stufen (jeweils main vor fallback), übrige Filter (Verfügbarkeit, Attempt, Provider-Skip-Evidenz) unverändert.
- **Degradierung an/aus/null:** `null` = nicht aktiviert ⇒ effektiv aus (`routingRegime` :168 bleibt die einzige Wahrheit); Pause ändert nichts an dieser Semantik.
- **Legacy-Regime:** pausierter Primary ⇒ Auflösungsmap (design→standard, review→deep→standard; deep/standard/execution: keine) — deren eigene Pausezustände werden im Walk ebenfalls respektiert; danach Hold. `finalFallback` bleibt **Fehler**-Endstufe und wird **nicht** zum New-Start-Kandidaten (kein Regimewechsel durch Pause; `routing.regime` bleibt von `primaryPaused` unbeeinflusst — Pause ist kein Schema-4-Merkmal und macht ein Schema-1/2/3-Policy nicht zum per_profile-Regime).
- **Design/Review-Fachrollen:** Fachrollenwahrheit erhalten — die Auflösungsmap ist eine vorhandene Kandidatenbildung, kein neues Routing; `design`/`review`-Pause pausiert nur deren eigene Slots, nicht die der Auflösungsziele (dort greift deren eigener Pausezustand).
- **Fehlender/unzulässiger Fallback:** Monitor-Dispatch ⇒ `parked_input_required` mit neuem Grund `primary-paused-unresolvable` (+ sichtbare Kandidatenliste mit Gründen in der History, Muster :1928-1932); Management-Resolution ⇒ `hold_primary_paused` (§3.2); Recovery ⇒ bestehender `chain_exhausted`-Parkpfad. **Keine** Ersatzwahl, **kein** stiller Loop: Engine-Wake endet im Park (bestehendes Verhalten), kein Retry-Timer; ein Reaktivierungs-Weckruf ist operatorseitig (UI/MCP), keine Automatik. Der neue Parkgrund wird **nicht** in `RESTARTABLE_EXHAUSTION_REASONS` aufgenommen (Reaktivierung ist bewusst manuell; automatischer Restart wäre eine verdeckte Ablaufsteuerung).
- **Konkurrierende CAS-Änderung:** bestehende Konfliktantwort; UI zeigt Konflikt + Reload-Pflicht (bestehendes Muster).
- **Fremde Profile unverändert:** `commitPrimaryPaused` berührt ausschließlich `primaryPaused[profile]`; Bytegleichheit der übrigen Schlüssel im Test verankern (§8).
- **Neustart/Reload:** Zustand lebt in der Policy-Datei ⇒ Restart-persistent per Konstruktion; Engine/Adapter lesen pro Resolution frisch (keine Cache-Invalidierung nötig).
- **Kein Provider-/Account-globaldisable:** gleiche `provider_id` in anderen Slots/Profilen bleibt wählbar (D2-Empfehlung); der Resolver filtert **Slot**, nie Identität (Ausnahme: bestehender Provider-Skip mit account_scope-Evidenz — davon unberührt).

### 6.3 D2-Interaktion (explizit zu dokumentieren, keine Codeerfindung)

Wenn dieselbe Runtime (Identität provider/model/variant) als pausierter `x.main` **und** als `x.fallback` (oder anderer Slot) konfiguriert ist, springt die Kette bei D2=„andere Slots erlaubt" auf die identische Runtime via Fallbackslot — die Budgetpause wäre für dieses Profil wirkungslos. Das ist **Konfigurationsverantwortung des Operators** (keine implizite Identitätssperre im Code), sofern der Nutzer nicht D2 anders entscheidet. Das Konzept stellt beide Varianten bereit: Variante A (Empfehlung) filtert nur den konkreten Slot; Variante B würde zusätzlich eine Identitätssperre je Pause benötigen (`skipped_paused_identity`), was die Filterreihenfolge in §3.1 erweitert. **Entscheidung steht aus — Implementierung beginnt erst nach Nutzerantwort.**

---

## 7. Offene echte Semantikfragen (beim Nutzer in Klärung; Vorschläge, nicht entschieden)

| # | Frage | Empfehlung dieses Konzepts | Konsequenz bei Gegenentscheidung |
|---|---|---|---|
| D1 | Nur konkreter Primary-Slot vs. zusätzlich provider-/accountweit | Nur konkreter Primary-Slot (Ticketempfehlung; „gleiche provider_id allein ist kein Beleg gemeinsamer Quota") | Provider-weite Sperre wäre ein zweiter Filtertyp (identitäts-/providerscope) mit eigenem Status `skipped_provider_paused` und klarem Widerspruchspotenzial zum Evidenzkonzept (manuell ohne Evidenz) — deutlich größere Fläche |
| D2 | Dasselbe Runtime-Tupel in anderen Slots bei pausiertem konkreten Slot | Erlaubt (Auftragsvorschlag); Interaktion §6.3 dokumentiert, Operator konfiguriert verantwortlich | Identitätssperre je Pause: zusätzliche Filterstufe + Status, Tests zu Identitätsäquivalenz über alle Slotarten |
| D3 | Pause bis expliziter Reaktivierung vs. spätere Ablaufoption | Bis expliziter Reaktivierung; keine Ablauf-/Zeitfelder (YAGNI, Ticket „keine automatische Ablaufsteuerung") | Späteres Ablaufdatum = Schema-6-ähnliche additive Erweiterung, dann mit eigenem Auftrag |

Zusätzlich bestätigt im Auftrag (als Vorschlag behandelt, deckungsgleich mit §4): neue Starts erhalten die aktuelle Pause; laufende Arbeit und laufende Fallbackversuche bleiben unverändert.

---

## 8. Gezielte Testmatrix (Implementierungsumfang, nicht in diesem Turn ausgeführt)

**T1 Persistenz/CAS (TS `policy-commit.test.ts` + Hub-Test):**
1. `set paused=true` auf Schema 1/2/3/4: Upgrade → 5, Exact-Bytes-Backup existiert und enthält Originalbytes, `profiles`/`profileFallbacks`/`strategies`/`finalFallback` bytegleich, Revision +1.
2. `paused=false` (Clear) senkt Schema nie ab; erneutes true/false-Toggling erhält Tupel bytegleich (Round-Trip-Test).
3. Revisionskonflikt ⇒ `POLICY_REVISION_CONFLICT`, kein Write; Lock nicht akquirierbar ⇒ `POLICY_COMMIT_UNAVAILABLE`, kein unlocked Write.
4. Python/TS Key-Order-Parität für Schema-5-Dokument (bestehendes Paritätstestmuster fortführen).
5. Ungültige Eingaben (falsches Profil, nicht-bool) ⇒ `INVALID_ARGUMENT`, kein Write.

**T2 Leser/Legacy (`agent-control.test.ts`):** Schema 1–4 unverändert lesbar, `primaryPaused` effektiv `false`; Schema-5-Schlüsselmengen strikt; `describePolicy` additiv (bestehende Felder bytegleich), `candidate_order` unbeeinflusst von Pause; `routing.regime` unbeeinflusst.

**T3 Resolver (`agent-control.test.ts`):**
6. `resolveRecoveryChain`: pausierter Entry-`x.main` ⇒ `skipped_paused`, eigener Fallback `selected`; Degrading aus ⇒ danach `chain_exhausted`; Degrading an ⇒ nächste Stufe; `x.fallback` nie `skipped_paused`; `final.main` nie; Pausen ignorieren Attempt-/Evidenzlogik nicht (Reihenfolge §3.1); Legacy `degrade.<p>.main` pausiert ⇒ übersprungen.
7. `resolveProfile`: Pause-Skip im Walk, `resolution_path` vollständig, Hold-Grund `hold_primary_paused` vs. `unconfigured` getrennt; design/review-Ketten über pausierte Zwischenstufen.
8. Neue gemeinsame Kandidatenfunktion: per_profile-Ordnung (main→fallback, Degrading-Stufen) und Legacy-Ordnung, ohne Evidenzfilter — eine Implementierung, von Resolution/Dispatch/Recovery genutzt.

**T4 Engine (`monitor.test.ts`):**
9. Dispatch mit pausiertem Primary: Session wird auf erlaubten Kandidaten geschaltet (verifiziertes Readback inkl. Variante); Kandidat katalog-unverfügbar ⇒ nächster erlaubter; alle unzulässig ⇒ `parked_input_required`/`primary-paused-unresolvable`, kein Send, kein neuer `RESTARTABLE`-Grund.
10. Reaktivierung: nächster Dispatch schaltet auf Primary zurück (identischer Tupel bytegleich aus Policy gelesen).
11. Pause nach Resolution-Read: laufender Dispatch unverändert (Read-at-Resolution-Semantik, §4); laufender Recovery-Kandidat wird nicht abgebrochen; nächste Resolution ⇒ `skipped_paused`; Episode-Attempts bleiben erhalten, Pause schreibt keine Attempts.
12. Recovery-Park bei nur-pausiert erschöpfter Kette mit sichtbarem Grund + Kandidatenliste in History/Projection.

**T5 UI/MCP-Parität:** Hub `PUT …/primary-paused` und MCP-Tool erzeugen **identische** persistierte Bytes (Dual-Write-Paritätstest wie bestehend); Snapshot/`get_project_model_policy` zeigen `paused`/`resolution` konsistent; Capability-Flag: alter Adapter ⇒ UI-Schalter gesperrt mit Hinweistext, kein Write; Hub-Auth/Write-Annotations unverändert.

**T6 Regression:** vollständige bestehende Adapter-/Hub-Testsuite; Schema-1- bis 4-Policies verhalten sich in allen bestehenden Tests byte- und semantikidentisch (keine Pausefelder ⇒ kein Verhaltenunterschied); Browser-Smoke der Profilkarte (bestehendes Hub-Browser-Testmuster).

**Explizit getestet (Negativ):** kein synthetischer Providerfehler (Pausierter erzeugt **keinen** Request und **keinen** Attempt-/Evidenzeintrag); kein Provider-/Account-Disable (gleicher Provider in anderem Slot bleibt `selected`); keine Automatik (kein Zeitfeld, kein Auto-Reenable nach Restart).

---

## 9. Vorgeschlagener Implementierungsumfang (nach Nutzerentscheid D1–D3)

Flächen (alles im eigenen Worktree, eigener Kandidat, eigener QC-Zyklus):

1. **Adapter TS:** `agent-control.ts` (Schema-5-Leser, Pausenfeld in Views, gemeinsame Kandidatenfunktion, `resolveRecoveryChain`/`resolveProfile`-Erweiterung), `policy-commit.ts` (`commitPrimaryPaused`), `tools.ts` (neues Write-Tool, additiver Output), `monitor-main.ts` (policyView-Feld), `monitor-engine.ts` (resolveRuntime über gemeinsame Funktion, Parkgrund), Typen/Zod-Schemas.
2. **Hub:** `hub/policy.py` (KEY_SETS, Validator, `update_primary_paused`, Projektionen), `hub/server.py` (Route, Snapshot), `hub/catalog.py` (Capability), `hub/control.js`/`styles.css` (Schalter, Zustandsanzeige, Konfliktmuster).
3. **Tests:** §8-Matrix (neue Testfälle + bestehende Regression).
4. **Docs:** `docs/MCP-INTERFACE.md` (Policy-Abschnitt :678ff additiv), AGENTS.md-Kurzabschnitt, ggf. Hub-README; Versionsbumps (Script-Patch, Adapter-Version, Pins) erst im Implementierungskandidaten nach eigenem Regelwerk.
5. **Kein** Eingriff in `runtime/managed-*` (kein Berührungspunkt mit der Pausenfunktion), **kein** opencode-vm.sh-Verhaltenscode außer Versionsstring/Pins im Implementierungskandidaten.

Abhängigkeiten zum parallelen Noninteractive-Owner (`ses_ecf9566a1ffeuYwMQg3luq7cHr`): überlappende Dateien laut Koordination sind `runtime/managed-core.mjs`, `runtime/managed-policy.mjs`, `adapters/mcp/src/opencode.ts`, `monitor-engine.ts`, Tests/Docs. Dieses Konzept berührt potenziell nur `monitor-engine.ts` (resolveRuntime/§3.3) und Docs — Integrationsreihung (wer zuerst integriert) ist Teil des späteren Integrationszyklus, nicht dieses Turns; kein Schreiben in dessen Baum.

---

## 10. Ergebnis

**Konzeptbereitschaft** (technisch): alle Anschlussstellen verifiziert (§1), Schema-/CAS-/Migrationsweg folgt exakt dem etablierten additiven Muster (§2), eine gemeinsame Resolverimplementierung (§3), definierter race-sicherer Umschaltmoment (§4), UI/MCP-Parität inkl. Capability-Gate (§5), vollständige Fallunterscheidung (§6), Testmatrix (§8). **Kein Feature-Done**: Implementierung und die Semantikentscheidungen D1–D3 (§7) stehen aus; D2-Interaktion (§6.3) ist in beiden Varianten konzipiert. Kein Blocker — der nächste zulässige Schritt ist die Nutzerentscheidung, danach der Implementierungsauftrag.
