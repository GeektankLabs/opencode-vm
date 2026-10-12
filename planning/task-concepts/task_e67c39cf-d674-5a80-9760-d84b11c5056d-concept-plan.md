Task-ID: task_e67c39cf-d674-5a80-9760-d84b11c5056d

# Task task_e67c39cf — Release-Paket: Monitor-Fortschrittsstrategie und verlässliche Rückmeldungen (Konzept-/Readiness-Gate)

Concept-Plan: **V1.1** — **ABGESCHLOSSEN (2026-10-12)**: Konzept (C1–C6, Delta-
Review PASS) → Implementierung (Kandidat `d7765e8`, 18 neue Testfälle) →
Candidate-QC **QC_PASS** → lokale Main-Integration (FF; Exec-Bit-Restore
`93a7c18`; Receipt `c426e28`) → unabhängige Integrationsprüfung
**LOCAL_MAIN_INTEGRATION_PASS** (Main `c426e28`/Tree `6431bb20` verifiziert) →
Cleanup ausgeführt (Autoren-Worktree ohne Force entfernt, Branch als Historie
erhalten) → Board-Tasks abgeschlossen. **Offen (bewusst separat,
operatorseitig):** Push/Tag/Release/Publish/Deploy und Liveabnahme.
Paketmaster-Status: `in_progress` (Board). Dieser Turn erzeugt **keinen** Produktcode,
keine Tests, keine Commits im Paketbranch, keinen Push/Tag/Release/Deploy/Restart.

Quellenstand dieses Dokuments: **HEAD `b7aa2640aa328ee5705ffb51de2cbac10db0705a`**
(= identisch zum V1-Lesestand der Monitorstrategie; Ancestry frisch verifiziert),
`OCVM_VERSION="0.7.34"` (`opencode-vm.sh:290`), MCP-Adapter 0.1.43 (Script-Pin
`opencode-vm.sh:47-50`, Tags mit 0.7.34 aligned durch `d98cd54`). Produktquellen
wurden ausschließlich gelesen; geschrieben wurden nur eigene Paket-/Konzeptdokumente
plus task-eigene Worktree-Vorbereitung.

---

## 1 Paketzusammensetzung: enthalten / vorhanden / ausgeschlossen

**Enthalten (neu in diesem Paket):**
1. Monitorstrategie **V2** (Implementierungsvertrag §13 im Strategieplan, Slices
   S1–S3 + S5-Kern; task_a234c341).
2. Orchestrator-Delta für verlässliche Fortschritts-/Monitoringzusagen
   (task_4ae1d182, Restumfang nach r51 — §5 dieses Dokuments).

**Vorhanden (wird wiederverwendet, NICHT dupliziert):**
- controller_id-Cleanup `01070210af58f4122d4c0374d500d6c273f7be3f` +
  mgmt-v3-Journal-Writer-Contract (Adapter 0.1.43) — gemeinsam integriert in
  **`0320c8ddbbbbdc15913230eab41de719a6dbdc22`** („release: pin the reproducibly
  rebuilt mcp adapter 0.1.43 for v0.7.33"); Ancestry verifiziert. Original-QC
  msg_12d844f86001t1JzoUGgj8SDT4 (Session ses_ed2cfa061ffeeFu8ITKzWEDG5e) und
  Integrationsbericht msg_12d87af600019hyn45Jxqq7R5G (Session
  ses_ed2978174ffeHyREAzPNsvyICL) sind überlieferte Belege; lokale Git-Evidenz
  bestätigt Integration (`09c7348` mgmt-v3 priming, `0320c8d` Release-Pin;
  `84b95f5` ist nur Taskbranch-/Worktree-Tip, kein Main-Beleg — C5).
- be951293-Fallback-/Log-/Receipt-Gate — integriert (`4659b59` Kandidat, `30ec6e6`
  Integration+QC-Record, dokumentiert in `docs/MCP-INTERFACE.md`, Code
  `monitor-engine.ts:733` SafeHold im `observeUnchangedReceipt`). Keine neuen
  Fallback-Features.
- Orchestrator-Skill **r51** (`integrations/chatgpt/bundle.json` revision
  `2026-10-10-r51`): Drei-Zustands-Vokabular
  (`CURRENT_TURN_WAIT`/`ON_DEMAND_STATUS`/`PROACTIVE_MONITORING`) existiert
  (`SKILL.md:310-312`, `references/optimistic-mvp.md`, `references/events-attention.md`,
  `references/regression-scenarios.md`), `monitor-reporting.md` seit r50.

**Ausgeschlossen (ausdrücklich):** ENFILE, RepoLive, neue Fallback-Features,
neue Push-/Benachrichtigungsinfrastruktur, heimliches Dauermonitoring, Hub-UI-
Investigationsanzeige (bleibt Strategie-S4/später), erneute Implementierung der
obigen Fixes, Journal-Reparaturen/Liveabnahmen alter Fixes (bleiben separat offen),
fremde Task-/Runtime-/Monitoränderungen, Push/Tag/Veröffentlichung/Deploy/Restarts.

## 2 Repo-Identität, HEAD, Worktree-Ownership (verifiziert 2026-10-12)

- Repo: `/Users/admin/Documents/github/opencode-vm`, Main-HEAD `b7aa264`
  („docs: integration receipt for the self-mcp binding main integration").
- Ancestry geprüft (`git merge-base --is-ancestor`): `b7aa264` ⊆ HEAD (Identität),
  `0320c8d` ⊆ HEAD, `01070210` existiert (Branch `task/controller-id-cleanup`,
  Worktree-Tip), `4659b59` in Historie. **Kein Versionsdrift seit V1.**
- Fremde Worktrees (unberührt, keine stage/reset/stash/delete):
  `controller-id-cleanup-20261012-main` (`task/controller-id-cleanup` @0107021),
  `task_278d4136-8d7b-559b-80fe-3e9ae7282140` (`task/monitor-journal-writer-contract`
  @338f26a), `task_278d4136-consolidated-20261012-main`
  (`task/monitor-journal-package-consolidated` @84b95f5),
  `task_efbe63cf-self-mcp-binding-fix` (`fix/mgmt-self-mcp-connector-binding`
  @d98cd54). Fremde Dirty-/Untracked-Deltas im Main-Checkout wurden nicht angefasst.
- **Eigener Paket-Worktree (neu, nach `docs/WORKTREES.md`):**
  `.opencode-vm/worktrees/task_e67c39cf-d674-5a80-9760-d84b11c5056d` auf neuem
  Branch **`task/monitor-progress-package`**, Base exakt `b7aa264`, Arbeitskopie
  sauber. Ownership: dieser Task; Löschentscheid folgt dem Integrations-Handback
  bzw. der Fresh-VM-Sweep-Grenze (WORKTREES.md). Kein Mainmerge, keine Retained-
  Branches berührt.

## 3 Statuskonflikt be951293 (SafeHold/Welle-D) — Auflösung aus vorhandenen Quellen

- **Claim „offen"** (11.10-Boardzusammenfassung, überliefert): SafeHold/Welle-D noch
  offen.
- **Claim „entschieden/integriert"** (be951293-Compact + Git + Code): Gate-Fix
  Kandidat `4659b59` am 2026-10-10 in Main integriert (FF, exakt geprüfter Baum),
  Release 0.7.31/Adapter 0.1.42 vorbereitet (`30ec6e6`, `6c8d32b`, `bdedc9a`); der
  fix liegt im heutigen Code (`observeUnchangedReceipt` mit SafeHold-Verweis,
  `monitor-engine.ts:733`); die lokale Welle-D-Fixture
  `tests/hub_monitor_browser_test.mjs` existiert im Baum.
- **Auflösung:** Code + Git + eingebaute Doku (`docs/MCP-INTERFACE.md` „Since the
  0.7.31/0.1.42 gate fix (be951293)…") belegen die **Integration**; die
  11.10-Zusammenfassung ist hier veraltet. **Offen bleibt allein die Live-/Browser-
  Fixture-Abnahme** (Compact-Grenze: Hub-Browser-Fixture in jener VM-Session nicht
  lauffähig; letzter grüner Nachweis für inhaltlich unveränderten Stand) — diese
  ist separat und **kein Teil dieses Pakets**; dieses Paket behauptet keine
  Liveabnahme.

## 4 Monitorstrategie V2 — Implementierungsvertrag (Kurzform)

Verbindlich ist **§13 des Strategieplans**
(`planning/task-concepts/task_a234c341-06c5-5489-be11-0ef637080fe1-concept-plan.md`,
Concept-Plan V2). Kern gegenüber V1:

1. Zustandsprimat: alle Uhren/Cooldown/Evidenz/Claims je `worker_key` +
   `dispatch_receipt`-Episode (`investigation.workers[]`); Monitoraggregate nur
   abgeleitet.
2. Erstdispatch-Anker: initial Anker am **tatsächlichen Dispatch** (Receipt-
   Admission/`dispatch_wal.at`, ersatzweise `creation_receipt`), `T_first` ab dort;
   unbekannte überfällige Restartfälle → **einmalig** begrenzte Reconciliation,
   danach Anker = Reconcile-Abschluss; kein null-Sofortuntersuchungs-Loop.
3. Budget/Fairness/Deferral ohne starre 4/Tag-Grenze: max. 1 laufend je Monitor,
   Rotation älteste-fällig-zuerst, jede Verschiebung mit transparenter neuer
   `next_deep_check_at`; optionale Tagesbudgets nur, wenn sie 1h-Cooldown bzw.
   2/4/8h nicht verunmöglichen (fail-closed Kompatibilitätsregel).
4. Untersuchung ist nie Fortschritt; A semantisch/korreliert (V1); Longwork-Evidenz
   präzise positiv ((a) attributierbarer Toolfortschritt-Delta am eigenen Receipt,
   (b) receipt-korrelierter Checkpoint, (c) neu admissionierter Schritt + begründete
   Wartefrist) und explizite Unknown-Kriterien (stale running/Inflight ohne Delta,
   Coverage partial ⇒ `inconclusive`).
5. ERROR/Generation/Reconcile überholen Backoff **ohne** falschen Progress-Reset
   (clock hold, Anker nach Reconcile, Stage unverändert).
6. Parkpflicht (A10/§6) konsistent; unbekannte Fehler kein freies Routing.
7. Minimaler unabhängiger cheap observer (O1) mit explizitem Registry-Lease-Claim;
   Due-Signal darf weder vom No-op-Shortcut noch vom Busy-Gate absorbiert werden;
   keine Sends/Recovery aus dem Observer, Übergabe via bestehenden `wake_request`.

## 5 Orchestrator-Delta (task_4ae1d182) — reale Lücken nach r51

Gelesen: r51-Skill (Bundle `2026-10-10-r51`, Marker SKILL.md:9), 4ae1d182-Konzept
(2026-09-29), CHANGELOG r49–r51. **Vorhanden:** Drei-Zustands-Vokabular, begrenzte
Current-Turn-Wait-Regeln, On-Demand-Lesemuster, bedingtes PROACTIVE_MONITORING nur
mit verifizierter Subscription (SKILL.md:310), Fair-Round-Kanalprotokoll
(events-attention.md), Monitor-Reporting-Contract (r50, `monitor-reporting.md`),
Regressionszeilen u. a. regression-scenarios.md:170/219/455.

**Reale Lücken (dieses Paket, nur diese):**
1. **`references/communication-states.md` fehlt** weiterhin (nicht im Bundle) — das
   im 4ae1d182-Konzept geforderte eine gemeinsame Vokabular-Referenzdokument;
   Vokabular ist derzeit auf SKILL.md:310-312 + drei Referenzen verstreut.
   Plan: Datei ergänzen, SKILL.md/progress-activity.md/regression-scenarios.md
   verweisen additiv darauf, Bundle `files` + Revisionsmarker + CHANGELOG-Eintrag +
   Rebuild (zip/sha256/latest.json via `scripts/build-chatgpt-skill.py`).
2. **Sechs dedizierte Regressionszeilen unvollständig** (4ae1d182-Konzept Ziffer 6):
   vorhanden sind bestätigt-extern (170), kein-Mechanismus (219), Status-only (455);
   zu ergänzen sind die dedizierten Zeilen für long-run-no-push,
   current-turn-wait-implies-no-push, manual-status-check-fresh-read,
   input/permission-pending-not-monitored, missing-monitoring-refusal.
3. **Neue Engine-Zustände im Reporting:** `monitor-reporting.md` (r50) kennt die
   V2-Investigationszustände noch nicht — additiv ergänzen: ehrliche Wording-
   beispiele für `investigation-inconclusive`, `long_work_evidenced` (Wartegrund),
   `no_progress_evidenced` (Eskalation), `investigation-anchor-unknown`, Park/`wait_reason`;
   Untersuchungsergebnisse nie als Fortschritt formulieren.
4. **Geprüfte Benachrichtigungskette (C2-korrigiert — nur reale Hops):** der
   heutige Code speist `get_project_attention` **nicht** aus Engine-Decisions
   (`attention.ts:10-18` leitet Prepared Attention ausschließlich aus
   Activity-Events ab; die Monitor-Engine schreibt nichts ins Activity-Journal).
   Belegte Hops: (a) Investigation-Outcome additiv lesbar via `get_monitor`/
   `get_monitor_history` (On-Demand-Read, kein Push); (b) der durch die Engine
   geweckte Manager eskaliert selbst über die bestehenden Attention-/Journal-Tools
   (Missionsvertrag, `monitor-engine.ts:1540`) → bestehende Fair-Round-/Webhook-
   Pfade (0.1.23+-Vertrag) → User-Update (Voice/Text). **Keine**
   Engine-Decision→Attention-Verkabelung, **keine** neue Push-Infrastruktur,
   **keine** PROACTIVE_MONITORING-Zusage aus Engine-Decisions allein; Skill-Texte
   verweisen auf genau diese Hopliste.

Skill-Revisionsnummer: **nächste freie rN nach aktuellem Main zur Umsetzungszeit**
(r51 ist belegt; Vorschlag r52 — keine Reservierung in diesem Dokument). Skill-Tests:
`python3 -B tests/chatgpt_skill_test.py` inkl. Row-Assertions; CI
`.github/workflows/chatgpt-skill.yml` bleibt verbindlich.

## 6 Begrenzter Implementierungs-/Testplan, Allowlist, Migration, Release-Planung

**Allowlist (Produktdateien, vollständig — C3/C4 ergänzt):**
- `adapters/mcp/package.json` (Adapter-Version), `adapters/mcp/package-lock.json`
  (regeneriert), `adapters/mcp/src/types.ts` (**nur** `ADAPTER_VERSION`-Konstante) —
  RELEASING Schritt 4 (C3).
- `adapters/mcp/src/monitor.ts` (+`monitor.test.ts`): additives
  `investigation`-Schema je Worker-Episode, Formvalidierung, Helper.
- `adapters/mcp/src/monitor-engine.ts` (+Tests): §13.2/13.5-Logik, Due-Check vor
  No-op-Shortcut und Busy-Gate, Observer-Takt + Lease-Claim, §13.8-Claim-Recovery,
  Merge-Key-Decisions.
- `adapters/mcp/src/monitor-main.ts`: Observer-Interval + §13.8-Boot-Sweep.
- `adapters/mcp/src/tools.ts`: additive `get_monitor`/`list_monitor_workers`-Felder
  plus **kleinste Konfig-/Taskvertragsfläche an den bestehenden
  `create_monitor`/`update_monitor`-Schemata** (§13.3 Strategieplan: additive
  optionale Felder, keine neuen Tools, keine UI) — keine neue Autonomie.
- `adapters/mcp/src/opencode.ts`: **keine** Änderung erwartet (`getSessionProgress`
  existiert; nur optionale Gateway-Delegation in `monitor-engine.ts`).
- `integrations/chatgpt/opencode-session-orchestrator/`: neue
  `references/communication-states.md` (**Englisch** wie die übrigen Referenzen,
  mit deutschen Voice/Text-Beispielphrasen wie üblich), additive Edits SKILL.md/
  progress-activity.md/regression-scenarios.md/monitor-reporting.md, CHANGELOG.md,
  `bundle.json` (revision + `files`); Rebuild-Artefakte (zip/sha256/latest.json via
  `scripts/build-chatgpt-skill.py`); CI `.github/workflows/chatgpt-skill.yml`.
- `opencode-vm.sh`: Versions-/Pin-Block (RELEASING Schritte 1-2, 7-8).
- `docs/MCP-INTERFACE.md`: additive Feld-/Vertragsbeschreibung.
- `docs/CHANGELOG.md`: **neu anlegen** (Entscheidung, schlank; ein Abschnitt je
  Release, Seed 0.7.35) — kein globaler Changelog-Ort existiert heute;
  Skill-CHANGELOG bleibt unberührt.

**Migration/altseitige Feld-Erhaltung (C6 präzisiert):** additive Registry-Felder
nach QC-F-B2-Muster (fehlend = legacy-ok, vorhanden fail-closed), Validierung
adapterseitig (`shapeOk`-Muster, `monitor.ts:346`). **Der Hub bleibt unberührt**
(keine Hub-Datei in der Allowlist, Hub-Archiv unverändert): additive Felder
überleben Hub-Mutationen nachweislich, weil `hub/monitor.py::mutate` (Z. 145-163)
auf einer Deep-Copy der ganzen Registry arbeitet und `_valid_registry` (Z. 66 ff.)
nur bekannte Pflichtfelder prüft — Cross-Writer-Erhaltung wird per Test belegt
(Hub-Mutation erhält neue Felder byte-stabil), nicht durch eine Hub-Änderung;
**keine fälschliche UI-Änderung**. Bestehende `recovery_episode`/
`receipt_observation`/`last_error`-Semantik wird nicht angetastet; kein
Datenmigrationsschritt nötig (leere Monitore starten mit §13.2-Anker-Regel).

**Testplan (begrenzt):** Fokusregressionen in `monitor.test.ts` je Abnahmezeile der
V2-Matrix (Anker/Cooldown/Leiter/Longwork-Kriterien/Overrides/Observer-Claim/
No-op-Resorption/Budget-Deferral-Transparenz); `monitor_service_test.sh`;
`npm test`-Adapter-Suite unverändert grün; Skill:
`tests/chatgpt_skill_test.py` + Bundle-Konsistenz (CI). Danach **eine** unabhängige,
exakte Kandidaten-QC (RED/GREEN, exakter Commit) — keine Reviewkaskade.

**Versions-/Changelog-/Pin-Planung nach aktueller RELEASING:** Nummern werden erst
nach Base-Prüfung am Umsetzungsbeginn bestimmt (Master-Vorgabe). Ausgangslage heute:
`0.7.34` belegt, Adapter `0.1.43` belegt → **Vorschlag** (keine Reservierung):
`OCVM 0.7.35`, `MCP_ADAPTER 0.1.44`; OpenLive unverändert; Hub-Archiv inhaltlich
unverändert (keine Hub-UI-Änderung im Paket) ⇒ Hub-Pin bleibt, drei Archive
doppelt bauen + cmp + SHA-Pins nach RELEASING Schritt 6-7, Commit lokal, Übergabe
an Operator. Veröffentlichung bleibt separat.

## 7 Gate-Plan (Stand nach Korrekturschleife)

1. **Erledigt:** Paketkonzept V1 + Strategie-V2 + Compacts registriert; Worktree
   vorbereitet; Konzeptreview durchgeführt → **CHANGES_REQUIRED** (Bericht
   `…-concept-review.md`).
2. **Erledigt (dieser Turn):** C1–C6 eingearbeitet — ausschließlich eigene
   Konzept-/Strategiedokumente; Delta-Mapping §10; **kein** Code.
3. **Nächster Schritt:** kurzer **Delta-Review** der C1–C6-Korrekturen (ein
   Reviewer, keine Reviewkaskade).
4. **Danach:** Implementierung im Paket-Worktree nach Allowlist **erst nach
   Operator-Freigabe im nächsten Prompt**, Fokusregressionen, dann unabhängige
   exakte Kandidaten-QC → reviewed lokaler Releasekandidat.

## 8 Entscheidungen (vormals offene Operatorfragen — laut Operatorprompt entschieden, keine neuen Fragen)

1. Changelog: **`docs/CHANGELOG.md` neu anlegen** (schlank, ein Abschnitt je
   Release, Seed 0.7.35); der Repo hat heute keinen globalen Changelog-Ort; das
   Skill-eigene CHANGELOG bleibt unberührt.
2. Hub-UI-Investigationsanzeige bleibt **ausdrücklich außerhalb** dieses Pakets
   (Strategie-S4/später) — bestätigt.
3. `communication-states.md` **Englisch** wie die übrigen Referenzen, mit
   deutschen Voice/Text-Beispielphrasen wie üblich.
4. Zusatz (Operator): Monitor-Typen/Budget-Grants sind **keine neue Autonomie** —
   die §13.3-Konfigfelder schärfen nur Betriebszeiten/Meilensteine der read-only-
   Untersuchung; Autonomieprofile, Grants und Berechtigungen bleiben unverändert.

## 9 Quellen-/Evidenzregister

| Evidenz | Wert/Ort |
|---|---|
| HEAD / Ancestry | `b7aa264` (Main); ⊆HEAD verifiziert: `0320c8d`, `4659b59`, `30ec6e6`, `09c7348`, `01070210`. **`84b95f5` liegt nur auf Branch `task/monitor-journal-package-consolidated` (fremder Worktree-Tip), NICHT in Main-Historie** (C5-Korrektur; §2 führt es korrekt als Worktree-Tip) |
| Konzeptreview | `planning/task-concepts/task_e67c39cf-d674-5a80-9760-d84b11c5056d-concept-review.md` (CHANGES_REQUIRED 2026-10-12; C1–C6; gelesen, nicht editiert) |
| Versionen | `OCVM_VERSION 0.7.34` (`opencode-vm.sh:290`), Adapter 0.1.43 (`opencode-vm.sh:47-50`, `adapters/mcp/package.json`), Tags aligned (`d98cd54`) |
| Worktree | `.opencode-vm/worktrees/task_e67c39cf-d674-5a80-9760-d84b11c5056d` @ `task/monitor-progress-package` @ `b7aa264`, sauber; 4 fremde Worktrees unverändert |
| Master-Task | `get_project_task task_e67c39cf…`: `in_progress`, high, `documents: []` (vor Registrierung) |
| Strategie V2 | `planning/task-concepts/task_a234c341-…-concept-plan.md` §13 (registrierte Datei) |
| Skill r51 | `bundle.json` revision `2026-10-10-r51`; SKILL.md:9,310-312; events-attention.md; regression-scenarios.md:170/219/455; monitor-reporting.md (r50); KEINE communication-states.md |
| Fixes-Belege | QC msg_12d844f86001t1JzoUGgj8SDT4 / ses_ed2cfa061ffeeFu8ITKzWEDG5e; Integration msg_12d87af600019hyn45Jxqq7R5G / ses_ed2978174ffeHyREAzPNsvyICL (überliefert); lokal in Main: `0320c8d`, `09c7348` (`84b95f5` nur Taskbranch — C5) |
| be951293 | Compact (Integration 4659b59, Welle-D-Grenze), `docs/MCP-INTERFACE.md` (0.7.31/0.1.42 gate fix), `monitor-engine.ts:733`, `tests/hub_monitor_browser_test.mjs` |
| RELEASING | `docs/RELEASING.md` (Schritte 1-8: Patch-Bump, Tag-Alignment, Doppelbuild, Pins, lokaler Kandidat) |
| Board-Verifikation | `get_project_task` für Master + verlinkte Detailtasks task_a234c341 / task_278d4136 / task_4ae1d182 (nur gelesen, nicht verändert) |

**Verlinkte vorhandene Detailtasks (nicht dupliziert):** task_a234c341 (Monitor-
strategie, V2 in registriertem Plan fortgeschrieben), task_278d4136 (Journal-/Cleanup-
Fix, integriert — nur Referenz), task_4ae1d182 (Orchestrator-Delta, eigenes Konzept
gelesen, Restumfang hier §5).

---

## 10 Delta-Mapping C1–C6 (für den kurzen Delta-Review; keine Reviewkaskade)

| Finding | Schwere | Korrekturort | Inhalt der Korrektur |
|---|---|---|---|
| C1 | Blocker | Strategieplan **§13.8 (neu)**, §13.7 (Übergabegrenze + P5-Zitat), §10-Zeile **A11**, §11-S1 | Verwaister `run.active`-Wake-Claim: Fencing (`owner_pid`/`owner_generation`), Boot-Sweep mit **vorherigem** WAL/Receipt-Abgleich (`reconcileDispatch`), `wake-claim-recovered` sichtbar; Hang≠Crash (frischer Heartbeat + gleiche Generation ⇒ aktiv; **Boot-Recovery gibt keine lebenden Worker frei**); inkonsistenter Claim → einmalig begrenzt + `wake-claim-stuck`; keine parallele Recovery; Observer bleibt bei blockiertem Call beobachtungsfähig (eigene Lease), gibt nie frei; Due-Check P5 liegt vor No-op-Shortcut **und** Busy-Gate |
| C2 | Major | Paketplan §5.4-4, Compact, Strategieplan §13.6 | Reale Hops ohne unbelegten Hop: Engine-Decisions speisen `get_project_attention` heute nicht (`attention.ts` = Activity-Events); lesbar via `get_monitor(_history)`, Eskalation nur durch geweckte Manager-Session; keine neue Verkabelung/Push-Infra; **keine Proaktivzusage aus Engine-Decision allein** |
| C3 | Major | Paketplan §6 Allowlist | `adapters/mcp/package.json` + `package-lock.json` + `src/types.ts` (nur `ADAPTER_VERSION`) ergänzt; RELEASING Schritt 4; Skill-Bundle-Manifest/Artefakte (bundle.json, zip/sha256/latest.json, CI) und Testflächen benannt |
| C4 | Medium | Strategieplan §13.3, §11-S1; Paketplan §6 | Kein „defaults-only": kleinste Konfig-/Taskvertragsfläche **jetzt** an bestehenden `create_monitor`/`update_monitor`-Schemata (additive optionale Felder, keine UI, keine neuen Tools); Defaults als projektspezifische Anfangswerte qualifiziert (keine universelle Produktanforderung); Leiter universell ab positiv belegter Langarbeit, auch ohne Deklaration; **keine neue Autonomie** (Grants/Autonomieprofile unverändert); Hub-Visualisierung bleibt später |
| C5 | Minor | Paketplan §9 (+Paket-Compact) | `84b95f5` als Branch-/Worktree-Tip korrigiert, explizit NICHT Main-Historie; Ancestry-Zeile bereinigt |
| C6 | Minor | Paketplan §6 Migration | Hub unberührt (keine Allowlist-Datei, Archiv unverändert); Cross-Writer-Erhaltung als Deep-Copy + permissive Validierung (`hub/monitor.py:145-163/66`) + Test belegt; keine fälschliche notwendige UI-Änderung behauptet |
