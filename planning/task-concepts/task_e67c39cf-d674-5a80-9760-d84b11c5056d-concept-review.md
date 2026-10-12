Task-ID: task_e67c39cf-d674-5a80-9760-d84b11c5056d
(unabhängiger Konzeptreview, kein Selbstfix)

# Concept-Review — Release-Paket Monitor-Fortschrittsstrategie + verlässliche Rückmeldungen

Gate-Entscheidung: **CHANGES_REQUIRED** — vier konzeptlevel Korrekturen (C1, C2, C3, C4),
danach PASS-fähig ohne weitere Reviewkaskade. Kein Produktcode, kein Testlauf, kein
Commit in dieser Session.

## Review-Scope und Subject-Verifikation (alles verifiziert 2026-10-12)

| Subject | Erwartet | Ist | OK |
|---|---|---|---|
| Paketplan `planning/task-concepts/task_e67c39cf-d674-5a80-9760-d84b11c5056d-concept-plan.md` | SHA256 `61934c978540653a9acb5ba2f7fbded53106cf22b8b5e5972586f72914dd0734` | identisch | ✓ |
| Compact `.opencode/tasks/task-task_e67c39cf-d674-5a80-9760-d84b11c5056d.compact.md` | SHA256 `4eb4b8f9f84dcd0d6ba421c28bc0ebcdd52c070cf4fb3a240f341e558408bb91` | identisch | ✓ |
| Strategieplan V2 §13 `planning/task-concepts/task_a234c341-06c5-5489-be11-0ef637080fe1-concept-plan.md` | SHA256 `e568adf543b5258dac5398f66d12cd821bf4d94dd31853efe7c0ae25ea3d2aa5` | identisch | ✓ |
| Main-HEAD | `b7aa2640aa328ee5705ffb51de2cbac10db0705a` | identisch (`git rev-parse HEAD`) | ✓ |
| Versionen | OCVM 0.7.34 / Adapter 0.1.43 | `opencode-vm.sh:290`, `opencode-vm.sh:47-50`, `adapters/mcp/package.json`+lock 0.1.43 | ✓ |
| Eigener Worktree | `.opencode-vm/worktrees/task_e67c39cf-…` @ `task/monitor-progress-package` @ b7aa264, sauber | verifiziert (`git worktree list`, Status clean) | ✓ |
| Ancestry | `0320c8d`, `4659b59`, `30ec6e6`, `09c7348`, `01070210` ⊆ HEAD | alle `merge-base --is-ancestor` OK | ✓ |
| Skill r51 | Bundle-Revision `2026-10-10-r51`, Marker SKILL.md:9, Vokabular :310-312, Regressionszeilen :170/:219/:455, `monitor-reporting.md` vorhanden, **keine** `communication-states.md` | alles bestätigt (Zeileninhalt geprüft, nicht nur Existenz) | ✓ |
| be951293-Integration | SafeHold in `observeUnchangedReceipt` | `adapters/mcp/src/monitor-engine.ts:730-737` (Watch-Vertrag, SafeHold, „No new fallback semantics") | ✓ |

Reviewer hat ausschließlich gelesen; geschrieben wurde nur dieser Bericht. Kein
Zugriff auf fremde Worktrees, keine Runtime-Änderung, kein Push/Tag/Release.

## Positiv verifizierter Kern (keine Änderung nötig)

1. **Zustandsprimat/Anker/Uhren (§13.1/13.2/13.5):** Uhren, Cooldown, Evidenz und
   Claims konsequent je `worker_key`+`dispatch_receipt`-Episode; Anker am
   tatsächlichen Dispatch (`dispatch_wal.at` existiert, `monitor.ts`-Feld verifiziert),
   nicht am Receipt-String als Zeit; einmalig begrenzte Unknown-Reconciliation mit
   `investigation-anchor-unknown`-Decision und Zähler — kein Overdue-Loop; Overrides
   (ERROR/Generation/Reconcile) überholen die Uhr ohne `last_progress_at`-Reset. Kein
   Maskieren hängender Worker durch monitorweiten Fortschritt (V1 §4.2.5, nicht
   superseded). Vertraglich sauber und codekonsistent.
2. **Evidenzstrenge (§13.4):** Longwork nur positiv belegt (Tool-Delta am eigenen
   Receipt / receipt-korrelierter Checkpoint / neu admissionierter Schritt +
   `wait_reason`); stale running/Inflight ohne Delta ⇒ `inconclusive`; generisches
   `unknown` autorisiert keine Recovery — konsistent mit `agent-control.ts`
   (`PROVIDER_ERROR_ADMISSION`). Untersuchungsergebnisse nie Fortschritt.
3. **Einfügepunkte stimmen mit dem Code überein:** No-op-Shortcut
   `monitor-engine.ts:416-435`, Busy-Gate `:459-479`, Receipt-Watch-Bypass als Muster;
   P5-Due-Check (V1 §3.3, nicht superseded) liegt vor dem Shortcut und damit auch vor
   dem Busy-Gate — die fällige read-only Untersuchung läuft damit auch während ein
   Worker busy ist (genau das Task88-Bild). Diese Position muss nur in §13 explizit
   zitiert werden (siehe C1b).
4. **Observer O1 minimal und begründet:** Registry-Lease mit TTL+Generation-CAS via
   `withRegistry`, kein Send/Recovery, `wake_request` als Übergabeweg; das
   `waking`-Flag schützt den Observer nicht automatisch (V1 §5.6 benennt das) — der
   Lease ist durch echte Nebenläufigkeit gerechtfertigt, kein Überdesign.
5. **Hub-Crosswriter-Erhaltung verifiziert:** `hub/monitor.py::mutate` (Z. 145-163)
   arbeitet auf einer Deep-Copy der ganzen Registry; `_valid_registry` (Z. 66 ff.)
   prüft nur bekannte Pflichtfelder und verwirft unbekannte Zusatzfelder weder beim
   Lesen noch beim Schreiben. Additive `investigation`-Felder überleben Hub-Mutationen
   unangetastet — **keine Hub-Änderung nötig** in diesem Paket (Klarstellung C4).
6. **Vorhandene Fixes werden korrekt wiederverwendet, nicht reimplementiert:**
   be951293 (SafeHold) und controller_id/mgmt-v3 (0320c8d) sind im Code belegt; das
   Paket behauptet zu Recht keine Live-/Browser-Abnahme und wertet Fixture-Existenz
   nicht als ausgeführte Abnahme. Skill-r51-Lücken sind real (Datei fehlt, aber
   Vokabular vorhanden — fehlender Dateiname allein wäre kein funktionaler Defekt;
   die Konsolidierung ist dennoch wertvoll, weil das 4ae1d182-Konzept genau ein
   gemeinsames Vokabularreferenz-Dokument fordert und die sechs dedizierten
   Regressionszeilen echte Restlücken sind).

## Findings (priorisiert, alle konzeptlevel — minimal korrigierbar ohne Code)

### C1 (BLOCKER) — Verwaister `run.active`-Wake-Claim: keine Recovery im Vertrag; §13.7-Übergabe kann dauerhaft absorbiert werden

**Befund:** `monitor-engine.ts:272-275` — ist `monitor.run.active` gesetzt, wird jeder
Wake als `wake-skipped/run-active` verworfen und nur neu terminiert; zurückgesetzt
wird der Claim ausschließlich durch `release()` (`:300-311`) bzw. den
Read-Failure-Pfad (`:997`). `monitor-main.ts` fährt **keinen** Boot-Sweep. Stirbt der
Engine-Prozess mitten in einem Wake (Crash, VM-Grenze, Kill), bleibt `run.active:true`
persistent in der Registry, und **jede spätere Wake-Terminierung wird für immer
absorbiert** — auch das `wake_request`, das der §13.7-Observer als Übergabeweg setzt.
Damit ist das Vertragsversprechen „Due-Signal darf von keinem der beiden absorbiert
werden" (§13.7) genau im Claim-Crash-Fall verletzt, und die Kriterien
„ClaimCrash sauber" / „wie wird dueInspection wirklich unabhängig ausgeführt, wenn
waking blockiert?" sind unbeantwortet: der Observer erkennt Fälligkeit, aber die
einzige Ausführungsbahn (regulärer Wake) hängt am verwaisten Claim.

**Minimale Korrektur (in §13/S5-Kern aufnehmen, before Implementierung):**
- Beim Engine-Start ( gleiche Registry-Generation bzw. Heartbeat-PID-Probe) werden
  verwaiste `run.active`-Claims der eigenen Monitore einmalig mit sichtbarem
  History-Eintrag (z. B. `wake-claim-recovered`) zurückgesetzt — bestehende
  `withRegistry`-CAS-Mechanik, kein neuer Store, keine parallele Recovery.
- Zusätzlich klärender Satz in §13.7: Die Unabhängigkeit des Due-Signals endet an der
  Übergabe an den nächsten regulären Wake; dessen Verfügbarkeit wird durch die
  Claim-Recovery garantiert. Observer selbst setzt den Claim nicht zurück, macht
  einen erkannten Stuck-Claim aber als Merge-Key-Decision sichtbar.
- (C1b) In §13 explizit zitieren, dass P5 (V1 §3.3) vor No-op-Shortcut **und**
  Busy-Gate liegt und die fällige Untersuchung damit auch bei laufendem/blocked
  Worker read-only ausgeführt wird.

### C2 (MAJOR) — Benachrichtigungskette: erster Hop ist unbelegt — Engine-Decisions speisen `get_project_attention` heute nicht

**Befund:** Paketplan §5.4 Ziff. 4 und Compact Ziff. 4 präsentieren die Kette
„Monitor-Engine Merge-Key-Decisions/`state` → bestehende `get_project_attention`
(queue-first, prepared attention)" als vorhandener Kanal. Verifikation:
`adapters/mcp/src/attention.ts:10-18` leitet Prepared Attention ausschließlich aus
**Activity-Events** ab (`message.failed`/`message.aborted`/…); die Monitor-Engine
schreibt nur Registry-Decisions/History und führt **nichts** ins Activity-Journal
(grep über `monitor-engine.ts`: keine Event-/Attention-Schreibungen). Der Hop
„Engine-Decision → Attention-Queue" existiert im heutigen Code nicht; neue
Verkabelung wäre aber nach Paketgrenze („keine neue Push-/Benachrichtigungsinfrastruktur")
verboten. Belegte heutige Pfade sind: (a) Untersuchungsergebnis additiv sichtbar über
`get_monitor`/Monitor-History, (b) durch Engine-Dispatch geweckte Manager-Session
eskalieriert selbst via Attention/Journal (Missionsvertrag `monitor-engine.ts:1540`).

**Minimale Korrektur:** Kette in Paketplan §5.4, Compact und Skill-Textanleitung
(§5.3-Punkt) ehrlich umformulieren zu den realen Hops:
`Investigation-Outcome (Registry-Decision, additiv lesbar)` + `Engine-Wake der
Manager-Session → Manager eskaliert via bestehende Attention-/Journal-Tools` →
bestehende Fair-Round/Webhook (0.1.23+) → User-Update. Ein Satz in §13.6: die
Untersuchung injiziert niemals direkt Attention/Events (keine neue Verkabelung);
PROACTIVE_MONITORING-Zusagen bleiben an die bereits existierende, namentlich
verifizierte Kette gebunden. Skill-seitig ist die Verifikationspflicht (SKILL.md:310)
bereits richtig — sie muss nur auf die korrigierte Hopliste zeigen.

### C3 (MAJOR) — Allowlist unvollständig für die geplanten Release-Mechanics

**Befund:** `docs/RELEASING.md` Schritt 4 verlangt für eine Adapter-Verhaltensänderung:
`adapters/mcp/package.json`-Bump, `package-lock.json`-Regeneration und
`ADAPTER_VERSION` in `adapters/mcp/src/types.ts` plus Pins in `opencode-vm.sh`. Die
Paket-Allowlist (§6) führt aber nur `monitor.ts`, `monitor-engine.ts`, `monitor-main.ts`,
`opencode.ts` („keine Änderung erwartet"), `tools.ts`, Skill-Dateien, `opencode-vm.sh`,
`docs/MCP-INTERFACE.md`, `docs/CHANGELOG.md` — `package.json`, `package-lock.json` und
`types.ts` **fehlen**. Ein Implementierer müßte die Allowlist verletzen oder
Versionsdrift in Kauf nehmen.

**Minimale Korrektur:** Allowlist additiv ergänzen: `adapters/mcp/package.json`
(Version), `adapters/mcp/package-lock.json` (regeneriert), `adapters/mcp/src/types.ts`
(nur `ADAPTER_VERSION`-Konstante). Keine weiteren Dateien.

### C4 (MEDIUM) — Konfigurierbarkeit/Tasktyp-Deklarationen vs. S4-Ausschluss: müssen als „Defaults-only in diesem Paket" explizit gemacht werden; Leitern-Anwendung klären

**Befund:** V1 §3.4 („Alle Werte … an create_monitor/update_monitor") und §4.3
(Tasktypen/Milestone-Deklaration via `update_monitor`) sind von §13 **nicht**
superseded, ihr Liefervehikel S4 ist aber ausgeschlossen; die Allowlist erlaubt keine
neuen create/update-Input-Felder. §13.3 referenziert zudem eine Budget-Konfiguration
(„Konfiguration prüft das fail-closed"), die im Paket nicht existiert, und V1 §4.3
limitiert die Leiter auf deklarierte `long_runner`, während §13.3/§13.4 die Leiter
unbedingt nennen. Wie ausgeliefert wären Konfigurationsfelder unerreichbar (toter
Konfigurationspfad) bzw. die Leiter-Anwendung mehrdeutig.

**Prüfung der S4-Abgrenzung (Reviewfrage 2):** Es fehlt **nur** optionale
Konfiguration/UI — der Missions-/Park-/Permission-Vertrag ist vollständig
engine-seitig + bestehendem Prompt-Missionsvertrag abgedeckt (§6/§13.6,
`buildWakePrompt`-Text unverändert ausreichend, da die Untersuchung engine-seitig
read-only läuft). Keine still abgeschnittenen Pflichtanforderungen. Die Ausschluss-
Entscheidung ist also korrekt, muss nur sauber dokumentiert werden.

**Minimale Korrektur (in §13/§6 Paketplan):**
- Feststellen: Dieses Paket liefert **feste dokumentierte Engine-Defaults**
  (T_first 1 h, T_cooldown 1 h, Leiter 2/4/8 h Cap) als Konstanten, sichtbar im
  `get_monitor`-Output; Konfigurationsoberfläche/Tasktyp-Deklaration (S4) bleibt
  ausdrücklich späteren Paketen vorbehalten.
- §13.3-Budgetklausel als „in diesem Paket nicht anwendbar (keine Konfiguration)"
  markieren; V1 §3.4-Konfigurierbarkeitsatz und §4.3 entsprechend für dieses Paket
  qualifizieren (Historie bleibt stehen).
- Klarstellen: In diesem Paket gilt die Leiter **universell ab positiv belegter
  Langarbeit** (Deklarationen existieren noch nicht); `default`-Typ-Verhalten
  (1-h-Fristen ohne Leiter) wird erst mit S4-Deklaration relevant.

### C5 (MINOR) — Evidenzregister-Fehler: `84b95f5` ist nicht in Main-Historie

**Befund:** Paketplan §9 („HEAD / Ancestry … `84b95f5` … in Historie") ist falsch:
`84b95f5` existiert nur auf Branch `task/monitor-journal-package-consolidated`
(fremder Worktree-Tip), nicht als Ancestor von `b7aa264`. §2 des Plans ist korrekt
(dort ist es als Worktree-Tip geführt).

**Minimale Korrektur:** §9-Zeile auf `0320c8d`/`4659b59`/`30ec6e6`/`09c7348` ⊆ HEAD
plus „`84b95f5` auf Branch/Worktree (nicht Main-Historie)" korrigieren.

### C6 (MINOR) — Hub-Formulierung mehrdeutig

§6 „Hub `_valid_registry` erhält alle bestehenden Felder unverändert (additive
Validierung nur für neue Felder)" liest sich wie eine Hub-Änderung, obwohl Hub-Dateien
nicht in der Allowlist stehen und das Hub-Archiv unverändert bleiben soll. Korrektur:
„Hub bleibt unberührt; additive Felder überleben Hub-Mutationen nachweislich (Deep-Copy
+ permissive Validierung, `hub/monitor.py:145-163/66`); fail-closed-Validierung der
neuen Felder erfolgt adapterseitig (`shapeOk`-Muster in `monitor.ts`)."

## Empfehlungen zu den offenen Operatorfragen (Paketplan §8 — als Entscheidungen vorgeschlagen, keine neuen Fragen nötig)

1. **Changelog-Träger: JA, `docs/CHANGELOG.md` erstellen** — ein Abschnitt je Release,
   Seed mit 0.7.35. Begründung: Receipts sind sessiongebunden und nicht dauerhaft
   auffindbar; eine dateigebundene, reviewbare Changelog ist repoangemessen, minimal
   und änderungsfreundlich (kein Werkzeug nötig).
2. **Hub-UI-Ausschluss: bestätigt** (C4 — nur optionale Anzeige/Konfiguration fehlt,
   kein Vertragsstück).
3. **`communication-states.md`: Englisch** wie die übrigen Referenzen, mit deutschen
   Beispielphrasen in den Beispielspalten — konsistent mit bestehendem Stil.

## Gate

**CHANGES_REQUIRED.** C1 (Claim-Recovery-Vertrag), C2 (Kette ehrlich umformulieren),
C3 (Allowlist ergänzen), C4 (Defaults-only festschreiben) sind vor dem
Implementierungsauftrag im Paketplan/§13 zu korrigieren; C5/C6 textlich mitzunehmen.
Alle Korrekturen sind Dokumentänderungen — kein Reviewcode, keine neue
Reviewkaskade: nach Einbau der C1-C4-Textkorrekturen gilt das Konzept als PASS-fähig
(dieser Reviewer sieht keine weiteren konzeptionellen Blocker; Umsetzungs-QC prüft
danach exakt den Kandidaten).

## Quellen (wesentliche, alle selbst gelesen/verifiziert)

- Paketplan + Compact + Strategieplan V2 §13/V1 §2-§11 (SHAs oben)
- `adapters/mcp/src/monitor-engine.ts` (tick 226, wakeOne-Claim 266-297, release 300,
  No-op 416-435, Busy-Gate 459-479, Receipt-Watch 730-760, Prompt 1526-1543)
- `adapters/mcp/src/monitor-main.ts` (Loop 125-130, Heartbeat, kein Boot-Sweep)
- `adapters/mcp/src/monitor.ts` (MonitorRecord/Felder), `adapters/mcp/src/tools.ts`
  (create/update/trigger-Monitor, keine Zeitwert-Inputfelder), 
  `adapters/mcp/src/attention.ts` (Event-Ableitung), `adapters/mcp/src/agent-control.ts`
- `hub/monitor.py` (`_valid_registry` 66, `mutate` 145, `snapshot` 165)
- `docs/RELEASING.md` (Schritt 3-4, Pins), `opencode-vm.sh:47-50,290`
- Skill r51: `bundle.json`, `SKILL.md:9,305-315`, `references/regression-scenarios.md`
  (:170/:219/:455), `references/monitor-reporting.md`, Referenzverzeichnis (keine
  `communication-states.md`)
- Git: HEAD b7aa264, Ancestry wie oben, Worktree-Liste, `84b95f5` nur auf Branch

---

# Addendum — Delta-Review der C1–C6-Korrekturen (2026-10-12, zweite Revision)

Auftrag: kurzer unabhängiger Delta-Review ausschließlich der C1–C6-Umsetzungen;
keine neue allgemeine Reviewrunde, kein Produktcode, keine Konzept-Selbstkorrektur.
Die ursprünglichen Findings C1–C6 oben bleiben unverändert Teil dieses Berichts.

## Geprüfte Subjects (alle Hashes voll verifiziert)

| Subject | SHA256 | Status |
|---|---|---|
| Paketplan V1.1 `planning/task-concepts/task_e67c39cf-…-concept-plan.md` | `1b7be6d1cacbfdda142aea633d1bbb8e3806de0746d1c333102c864b2eb391b9` | ✓ (20936 Bytes) |
| Paketcompact `.opencode/tasks/task-task_e67c39cf-….compact.md` | `17ee04cf5d718f6d36fcd4aeeb95016e7aa2e13b6ad8f7d9b29991900eb959f2` | ✓ |
| Strategieplan V2 `planning/task-concepts/task_a234c341-…-concept-plan.md` | `524de5c83f93d405111931ef8f6f002b662cdbb99142ce338f61bb1a9aa30be9` | ✓ |
| Strategiecompact `.opencode/tasks/task-task_a234c341-….compact.md` | `2f3dbe0ce162bd03d701c61015bb46865e73a795653788f9aff7cf2e0a8ddedd` | ✓ |

## Delta-Verifikation je Finding

- **C1 → §13.8 + §13.7 + A11 (Matrix-Zeile 576, Slice S1 594, §13.8:753-789):**
  Fencing `owner_pid` + `owner_generation` (Heartbeat/Runtime-Quelle
  `monitor-main.ts:106-118` benannt), Boot-Sweep mit **vorherigem** WAL/Receipt-
  Abgleich über den bestehenden Pfad (`reconcileDispatch :1486`),
  `dispatch-uncertain`-Park bleibt die Grenze — kein stilles Freigeben, keine
  parallele Recovery (§13.8.4), Observer gibt nie frei (§13.8.5) und bleibt bei
  blockiertem Wake über eigene Lease beobachtungsfähig. Hang≠Crash vertraglich
  getrennt (§13.8.3: frischer Heartbeat + gleiche Generation ⇒ aktiv; stuck-Claim
  einmalig/Episode, sichtbar, Release nur nach WAL/Evidenz). §13.7 zitiert P5 vor
  No-op-Shortcut **und** Busy-Gate — die fällige Untersuchung läuft damit real bei
  busy/blocked Worker, nicht nur theoretisch. **Erfüllt.**
- **C2 → Paketplan §5.4-4, §13.6:** unbelegter Hop entfernt; nur reale Hops
  (`get_monitor`/`get_monitor_history`-Reads; Manager-Eskalation über bestehende
  Attention-/Journal-Tools, `monitor-engine.ts:1540`); keine Engine→Attention-
  Verkabelung, keine PROACTIVE_MONITORING-Zusage aus Engine-Decisions allein.
  **Erfüllt.**
- **C3 → Paketplan §6 Allowlist:** `package.json`, `package-lock.json`,
  `src/types.ts` (nur `ADAPTER_VERSION`) ergänzt; Skill-Bundle-Manifest/Artefakte
  und CI-Fläche benannt. **Erfüllt.**
- **C4 → §13.3 + §11-S1 + Allowlist tools.ts:** bewusst abweichend von meiner
  defaults-only-Empfehlung (Operatorvorgabe konfigurierbare Werte/Taskverträge —
  legitim): kleinste optionale Fläche an den **bestehenden** create/update-Schemata,
  exakter Feldsatz (`investigation{…}`, `task_contract{…}`) mit Defaults, keine
  neuen Tools/UI/Autonomie, Leiter universell ab belegter Langarbeit, Hub später.
  Allowlist deckt die Schemaerweiterung (tools.ts) jetzt ein. **Erfüllt.**
- **C5 → Paketplan §9/§2 + Compact:** `84b95f5` korrekt als Branch-/Worktree-Tip
  geführt, explizit nicht Main-Historie. **Erfüllt.**
- **C6 → Paketplan §6 Migration:** Hub unberührt, Cross-Writer-Erhaltung per Test
  (Hub-Mutation erhält neue Felder byte-stabil) statt Hub-Änderung belegt. **Erfüllt.**

## Normative Festlegungen (PASS-bindend, keine neuen Findings)

1. **§13.8-Lebendigkeitslesart (eindeutig gepinnt):** „frischer Heartbeat + gleiche
   Generation ⇒ aktiv" heißt: Heartbeat-Generation == `owner_generation` des
   Claims (lebender Claim-Owner — unabhängig davon, welche Generation die prüfende
   Engine selbst hat). Der Boot-Sweep (§13.8.2) gibt einen Claim folglich nur
   frei, wenn die Generation abweicht **und** der Owner-Heartbeat nicht frisch
   ist (oder der PID tot) — eine noch lebende alte Engine wird nie freigegeben
   (die A11-Zeile ist genau so zu lesen). Als Testfall A11b in der Umsetzung zu
   verankern.
2. **Validierungsgrenzen der neuen Konfigfelder (§13.3, fail-closed in
   `shapeOk`/Tool-Schema):** `first_check_s`/`cooldown_s` ≥ 60 s, `ladder_s`
   Länge 3 und streng monoton steigend, `max_duration_ms`/`max_calls`/
   `max_bytes` > 0 mit Obergrenzen; degenerative Werte (insbesondere
   `cooldown_s = 0`, das eine Dauerdue-Schleife erzeugen würde) werden
   abgelehnt. Diese Grenzen sind QC-Akzeptanzkriterien, keine neue Verhandlung.

Beide Punkte sind Lese-Präzisierungen des bereits geschriebenen Vertrags
(A11/§13.8.3 bzw. „Formvalidierung"/„Kompatibilitätsprüfung fail-closed"), keine
inhaltlichen Änderungen — daher kein CHANGES_REQUIRED.

## Gate (Delta)

**CONCEPT_PASS.** C1–C6 sind vollständig und korrekt eingearbeitet; die zwei
normativen Pins oben sind für die Umsetzung verbindlich. Implementierung kann gemäß
vorliegender Paketfreigabe starten; die unabhängige exakte Kandidaten-QC prüft
danach den tatsächlichen Kandidaten (inkl. A11b-Lebendigkeitstest und
Config-Grenzen). Keine weitere Reviewrunde für diesen Scope.
