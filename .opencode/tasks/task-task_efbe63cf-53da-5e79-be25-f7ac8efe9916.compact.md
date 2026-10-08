Task-ID: task_efbe63cf-53da-5e79-be25-f7ac8efe9916
Title: Nachbearbeitung – nutzerseitiges Final-Fallback (Hub-UI + MCP) und Monitor-UX/Engine-History-Fix
Last-updated: 2026-10-09T00:28:00+02:00

## Rolle/Stand (implementiert; historische INITONLY-Marker supersediert)

- Ein Build-Owner, keine Subagenten, keine große Konzept-/Reviewkaskade; Umsetzung A→B→C erfolgt, QC_FAIL-Korrektur erfolgt, Kandidat eingefroren. Historische INITONLY-/„noch keine Produktcodeänderung"-Marker aus der Initialisierungsphase sind damit aufgehoben (keine aktuelle Sperre). Externe targeted QC und danach lokale Main-Integration folgen seriell.
- Board wird von diesem Strand nicht bewegt; kein Workerstart/Trigger in bi-mcrepo; keine Live-Konfigurations-, Service- oder Deploymentänderung. Jüngste Operatorpräzisierungen supersedieren frühere „nur Sammlung"-Aussagen; das No-Code-Profil betrifft nur den bi-mcrepo-Testmonitor, nicht diesen Task.

## Repo-/Worktree-Evidenz

- Root: `/Users/admin/Documents/github/opencode-vm`, git-dir = common-dir = `.git`; Main-Branch `main`, aktuelle Integration **`4330c7d8…`** / Tree `74fcce22…` (Base war `54647c1a…`). Fremde Root-Dirty-Einträge (74, inkl. fremder Task-C/P, `.playwright-mcp/`, `dist/`) bleiben unangetastet; keine fremde ID überschrieben.
- Eigener Worktree `.opencode-vm/worktrees/task_efbe63cf-53da-5e79-be25-f7ac8efe9916`, Branch `task/efbe63cf-fallback-monitor-ux`, ab verifiziertem Base-HEAD, clean; Persistenz im read-write gemounteten Projektverzeichnis. Einzige kanonische C/P sind die Root-Dateien (Worktreekopien nur Spiegel); Produktcode liegt im Worktree, Main-Integration separat; kein Push/Tag/Release/Deploy.

## Wiederverwendung vorhandener Arbeit

- Recovery-/Fallback-Semantik FINAL (Total/Degrading, `INPUT_REQUIRED` bei unkonfiguriert) aus `task_fa86d673…`; Policy-Store/Backup/Capability-Vertrag aus `task_d3d903f8…`; Monitor-Engine/UI-MVP `task_3a2ed31a…` (in Base integriert) — nicht neu gebaut. Vorgänger-Sessions idle → keine Ownershipfreigabe daraus.

## Umfang (konsolidiert, drei Blöcke — Details: P §3 + Detaildatei §9)

- **A:** deterministischen History-limit-Fehler der Monitor-Engine (`latest_checkpoint` ohne gültiges `limit`) zuerst beheben; deterministische Validierungsfehler ehrlich als solche melden; Read-/Retry-Budgets, Admission und Single-flight ohne Doppelworker erhalten.
- **B:** vorhandenes Schema-3-`finalFallback` nutzerseitig im Hub (Provider/Modell/Variante, Strategie total/degrading, speichern/ändern/zurücksetzen) und über einen autorisierten MCP-Schreibpfad mit unmittelbarem Readback nutzbar machen; dieselbe persistente Projekt-Policy, katalogvalidiert, reguläre Profile bei partiellen Updates erhalten, CAS/Backup/Migration minimal korrekt.
- **C:** konsolidierter Monitor-UX-Umfang (Mastertask-Select offen/deklariert/ungebunden mit Auto-Titel, sichtbarer Refresh mit Board+Registry, Create-Collapse nach Readback, Auto-Save statt Speicherbutton, Details über Bearbeiten mit eigenem Refresh, ein Scheduler-Badge, entfernte Abbrechen-/Vergleichsaktionen, volle Breite, Markertext-/Layout-Bereinigung).

## Abgrenzung/Boundaries

- Keine Änderung fremder Livekonfigurationen (u. a. bi-mcrepo-Monitor/Board/Policy), kein Workerstart, kein Trigger, kein Boardmove.
- Keine Recovery-Engine-Neuimplementierung; Kontextfehler/Compaction bleiben beim bestehenden nativen Vertrag.
- Kein Git-Push/Tag/Release/Deployment, keine Serviceänderung; Ergebnis ist ein überprüfbarer lokaler Kandidat mit Tests und benannten Update-/Integrationsschritten.
- Ungültige Provider-/Modell-/Variantkombinationen werden abgewiesen; keine stille Ersatzwahl; unkonfigurierter Fallback bleibt eindeutig (INPUT_REQUIRED in der Management-Routing-Semantik).

## Umsetzungsstand A→B→C (integriert)

History-limit-Fix + ehrliche deterministische Fehlerklassifikation (A), Fallback-UI-Karte + MCP-Tool `set_project_model_policy_fallback` (B), Monitor-UX (C): Kandidat `82332524…` → QC_FAIL-Korrektur **`4330c7d8…`** (Tree `74fcce22…`) mit unabhängigem QC_PASS, FF-only in lokales Main integriert; Script 0.7.18/MCP 0.1.31/Skill r44. Details (Änderungen, Tests, Pins, Integration): `…-concept-plan-details.md` §9–§11.

## `jq_inplace` (Diagnose → behoben)

Read-only-Diagnose: web.sh nutzte das host-only `jq_inplace` in Guest-`vm_exec`-Kontexten (`|| true` maskierte Exit 127, kein Crash, nur Self-MCP-Cleanup entfallen; vorbestehend aus W4 `b92eab2`). **Behoben in S1 (4)** durch `web_jq_inplace` in web.sh + Guest-Kontext-Test. Belege: `…-concept-plan-details-management-execution.md` §12.

## Konsolidierte Konzeptprüfung Journal #18–#25 (PARTIAL, konzept-only)

Operatorantworten Q2–Q5, #21–#25 übernommen; entschiedene Fragen nicht erneut geöffnet. Kernstatus: Hierarchie rückwärts IMPLEMENTIERT+GETESTET (`opencode.ts:546–655`), vorwärts FEHLT (Q7); Pause/Resume `1bd025db` erfüllt Q3 nicht (Q6); VM-Verlust-Persistenz belegt, Reconciliation FEHLT (S5); J24 terminale Error-Evidenz vorhanden, Timeout/Quota ohne terminalen Fehler FEHLT (Q8/S6); Q1 Provenienz NOT_FEASIBLE ⇒ minimaler Unfall-Guard empfohlen (Q1c/Q1b). Volltext: `…-concept-plan-details-consolidation.md`.

## Bestandskorrekturen S1 (integriert)

Heartbeat-Pfadvertrag, Kandidaten-Lesebudget/Vollständigkeit, Session-Links, guest-sicherer `web_jq_inplace`: Kandidat `3b9a66fa999318f06bb98d9322cb6f4edc02c372` (Tree `a905216e…`) FF-only in lokales Main integriert, gezielte Tests grün (neu `monitor_service_test.sh` 5 ok, hub 23, Browser 18/18), Script 0.7.20 / Hub-Pin `506a9895…`. Nachweis: `…-concept-plan-details.md` §18.

## S2 MANAGEMENT-Priming/Wake + Activity-Diagnosefix (QC_PASS, in Main integriert)

Umgesetzt auf Branch `task/efbe63cf-s2-manager-priming` ab Main `3b9a66fa…`: Wake als MANAGEMENT-Auftrag (Delegation statt Eigenausführung, ein nächster Schritt, Journal-first statt Voll-Read-Zwang), einmaliger Priming-Block `[MANAGEMENT-PRIMING mgmt-v1]` (Rolle, Master-Anchor, Member→Ticket→Session über vorhandene Tools ohne zweiten Store, Anker als Pfad+Revision, Pflegepflicht, Autonomie-/Sandbox-Scope, Worker-Fehleranalyse mit konfigurierten Fallback-Regeln, delegierte Operatorfreigabe ohne Umgehung echter Security-Grenzen, Selbststeuerungsverbot als Prompt-Pflicht, bounded no-op), digest-gesteuertes Re-Priming (neue/rekonstruierte Session, Anchor-/Profil-/Dokumentänderung, Contract-Bump, nach Compaction) mit Aufzeichnung erst nach bestätigtem Send; dazu der bestätigte Diagnosefix `ActivityJournal.commit()` (bounded metadata-only Fehlerklasse bei unverändertem Fail-closed-Latch, kein `setMaxListeners`). Budget real gemessen: Ist 1242 Z./~311 Tok. → Mission 1176 Z./~294 Tok. wiederkehrend, Priming 2701 Z./~675 Tok. einmalig; busy 0 Tok. Erster Kandidat `58de5fbd…` (Tree `f8520449…`, 12 Dateien +291/−38).

## S2 QC_FAIL → F1-Korrektur → QC_PASS → in Main integriert (2026-10-08)

QC_FAIL vollständig gelesen (`msg_11bd08669001eBF2vL3bPAibze`, SHA `7d3bb2f0…`): ein Blocker F1 (Priming fehlte bei Session-Rebind im selben Wake; stale Claim-Snapshot `monitor-engine.ts:210/258/386` vs `:608`), sonst PASS. F1 in-scope korrigiert (frischer `primingDigest` aus `ensureSession`, Rebind ⇒ `null`, In-Wake-Sicht synchronisiert, `recover()` mit frischem Digest; engine-getriebene Rebind-Testklasse, Mutationsprobe 31/2→33/33; F5 `persistErrorClass` errno-förmig). F2 (`mcp_self_connection_test.py`-Fixture ohne `web_jq_inplace`, identisch am Base) bleibt separater Main-Defekt. Korrektur `259454d3238e0bd6f1fdd5682f450e3484d86e5d` (Tree `7e14f7e9…`, Parent `58de5fbd…`, Base `3b9a66fa…`). Dispatch-Blocker (`ACTIVITY_UNAVAILABLE`, vier Versuche, keine Zustellung, kein Bypass) endete durch Operator-seitigen Adapter-Neustart; Auftrag übergeben.

**Re-QC QC_PASS:** `msg_11c4bc6e30010swpJb2oo2A2Ib` (sichtbare Revision SHA `f2328172…` selbst rekonstruiert; Artefakt `e6e00f4e…`, Body `94f684b4…`, beide Hash-verifiziert): F1 engine-getrieben behoben (qc4-rebind 5/5 inkl. Send-Fehler/Uncertain/Recovery/Compaction), Mutation 31 PASS/2 FAIL → 33/33, F5-Negativfälle; Adapter 204/202/0/2, echte OpenCode-1.18.34-Integration PASS, 39 eigene Kontrollen, Python/Shell/Browser-Regression PASS; Pins reproduzierbar `d42ed946…`/`506a9895…`.

**Integration (FF-only):** Main `3b9a66fa…` → **`259454d3238e0bd6f1fdd5682f450e3484d86e5d`** (Tree `7e14f7e9fe67b8f48187ee9b48ab0e829794f371` = QC-Tree); 12 Dateien +377/−45; 78 fremde Dirty (14+64) vollständig erhalten; keine Locks; Quellblobs 12/12 identisch; `opencode-vm.sh` 100755 Blob `5a067c88…`. Main-Regression auf Archiv-HEAD: Adapter 204/202/0/2 + Integration PASS; release_metadata/state je 5; agent_control 46; hub 23; taskboard_state 7 (1 SKIP); chatgpt_skill 83; monitor_service/install/hub_release/mcp_adapter/mcp_lock ok; Browser 18+1 ok; `bash -n`/shellcheck exit 0; MCP-Doppelbuild cmp-gleich `d42ed946…`, Hub `506a9895…`. Kein Push/Tag/Release/Install/Deploy/Restart. Details: `…-details-s2.md` §2.

## PAUSED_FOR_REBOOT-Checkpoint (2026-10-08T21:57Z, DOCS_ONLY, kein Produktwrite)

**Status: PAUSED_FOR_REBOOT.** Operator rebootet; dieser Checkpoint ist reine Doku (alleiniger Doc-Owner dieser Strand, fremde Änderungen erhalten, nichts committet/gestaged/reset/gestash/gelöscht/verschoben). Keine Produktarbeit, keine Tests, keine Integration, keine neuen Worker, keine lange Inventur.

**Gesichertes Ergebnis dieses Tasks:** S2 (MANAGEMENT-Priming/Wake + Activity-Diagnosefix) nach QC_FAIL→F1-Korrektur→QC_PASS lokal FF-only in Main integriert: `259454d3238e0bd6f1fdd5682f450e3484d86e5d` / Tree `7e14f7e9fe67b8f48187ee9b48ab0e829794f371` (QC `msg_11c4bc6e30010swpJb2oo2A2Ib`, Revision `f2328172…`, Artefakt `e6e00f4e…`). **Aktueller Main-HEAD zum Checkpoint-Zeitpunkt:** `019d25649a1283d4413e891bb8983c48f6307e8f` / Tree `c4067f86a9da4d04eb7b753bdcc51043ba0e75ba` — der Nachfolgekandidat des separaten Tasks `task_fa86d673-…` (FALLBACK-PER-PROFILE-20261008, QC_PASS, LOCAL_MAIN_COMPLETE; nur Referenz, kein Restart/Re-Run hier). Fremde Dirty-Einträge 14 tracked + 65 untracked = 79 unverändert erhalten, keine Locks, Index leer.

**Referenzen andere Stränge (nur referenziert, nicht bearbeitet):** WP2 `task_7e6ce738-940c-5a15-b888-a13de94f8098` = LOCAL_COMPLETE_PASS, extern NOT_RUN; **kein W1-Neustart**.

**Offene Schritte/Blocker dieses Tasks:** Q1c Guard-Variante, Q1b Monitor-/Link-Kontrollwrites, Q6 Pause-Zustandsspeicher, Q7 Hierarchie Ableitung vs. Index, Q8 Manager-Timeout-/Budget-Feld (alle konzept-offen, Empfehlungen in P); Stufen S3 Hierarchie+Fehlereskalation → S4 Pause/Resume-Q3 (Reconcile `1bd025db…`) → S5 VM-Verlust-Recovery → S6 Scheduler-Manager-Failure → S7 Guard; separater F2-Main-Testdefekt (`tests/mcp_self_connection_test.py`); echte Langzeit-/Native-/Live-Abnahme ausstehend; Nachtlaufwirksamkeit erst nach Operator-Installation behauptbar. Journal/Board unverändert (kein Done, keine Policy-, Deploy- oder Restart-Aktion).

**Diagnose zum Mitnehmen (Reboot-Umfeld):** Editor meldet „Too many open files in system"; Tunnel meldet „response already fulfilled or unknown request"; **lokale Healthchecks PASS beweisen keinen E2E-PASS**. Zusätzlich beobachtet (transient, selbst geheilt): einmalige git-Meldung „dubious ownership" im Main-Checkout bei korrekter Ownership `lima:lima`/uid 501 — keine git-Config-Änderung vorgenommen. Bekannte Altlast: ActivityJournal-Fail-closed-Latch des Adapters 0.1.32 (Ursache weiterhin unverified) war 2026-10-06→08 Auslöser für blockierte `send_message`-Dispatches; nach Operator-Adapterneustart funktionierten Journal-Reads/Writes wieder.

**Host-persistent gesichert (Session-Share `…/sessions/66370db6a9e3f88af333b4d90620d90b/reboot-checkpoint-20261008/`):** `qc-report-s2.txt` (10343 B), `qc4-report-v2.txt` (11414 B), `qc4-report-259454d3.txt` (11274 B), `qc5-report-019d2564.txt` (21512 B), `qc5-message.txt` (1727 B), `re-qc-order-s2.txt` (5265 B), `qc-order-fallback-per-profile.txt` (8313 B) — QC-Berichte und QC-Orders beider Stufen; dazu diese C und P sowie die fa86d673-C/P im Repo (host-gemountet).

**UNGESICHERT (guest-lokal unter `/tmp`, geht beim Reboot verloren, reproduzierbar):** Testlogs `/tmp/opencode/fb-final`, `fb-main`, `fb-tests2`, `ocvm-s2-fix`; Archiv-/Prüfkopien `/tmp/opencode/main-fb-verify`, `qc5-019d2564`, `pin-base`, `base-check`, `mv-logs`; Bundle-Builds `/tmp/opencode/pin-cand-*.tar`, `pin-base-*.tar`, `fb-main-*.tar`, `mv-*.tar`. Alle Pins/Digests und Test-Counts sind in C/P textlich gesichert (MCP `2e09e5d8…`, Hub `7842dc31…`, Base-MCP `d42ed946…`, Base-Hub `506a9895…`, Skill-ZIP `5aff28d5…`).

**Wiederaufnahme (nur mit neuem Operatorauftrag, kein automatisches Weiterarbeiten):** (1) Main-HEAD/Tree/Dirty und `git worktree list` frisch verifizieren, keine Annahme aus diesem Checkpoint; (2) Task-Journal `head_sequence` auf neue Vorgaben prüfen; (3) Runtime/Adapter nach Reboot neu lesen (Port/Token/Generation, Journal-Latch-Status), Healthcheck allein gilt nicht als E2E; (4) Worktrees `task_efbe63cf-s2-manager-priming` (`259454d3…`) und `task_fa86d673-fallback-per-profile` (`019d2564…`) bleiben unverändert stehen, kein Cleanup ohne Auftrag; (5) keine Integration/QC/Deploy/Restart-Aktion ohne explizite Freigabe. **PAUSED.**

## Nächster Schritt

Angehalten (Auftrag erfüllt); seit 2026-10-08T21:57Z zusätzlich PAUSED_FOR_REBOOT (oben). Offen bleiben **Q1c** Guard-Variante (Empfehlung R3+ Unfall-Guard), **Q1b** Monitor-/Link-Kontrollwrites (Empfehlung nur selbstreferentielle blocken), **Q6** Pause-Zustandsspeicher (Empfehlung additives `control`), **Q7** Hierarchie Ableitung vs. Index (Empfehlung Ableitung first), **Q8** Manager-Timeout-/Budget-Feld (Empfehlung per-Monitor mit Default). Nächste Stufen S3 Hierarchie+Fehlereskalation → S4 Pause/Resume-Q3 (inkl. Reconcile von `1bd025db…`) → S5 VM-Verlust-Recovery → S6 Scheduler-Manager-Failure → S7 Guard sowie separater F2-Testdefekt und echte Langzeit-/Native-/Live-Abnahme — nur mit separatem Auftrag.

## Kontextsicherung vor VM-Abräumen (2026-10-09T00:28+02:00, DOCS_ONLY)

**Persistenzbeleg:** Repo-Root `/Users/admin/Documents/github/opencode-vm` ist ein **virtiofs-Hostmount** (`findmnt`: FSTYPE `virtiofs`, SOURCE `lima-3ce9b76e4e2e8e56`) ⇒ Dateien in diesem Pfad überleben das VM-Abräumen; Owner `lima:lima`. Kein /tmp-/VM-only-Pfad für diese Sicherung.
**Git-Zustand zum Sicherungszeitpunkt:** HEAD `019d25649a1283d4413e891bb8983c48f6307e8f`, Tree `c4067f86a9da4d04eb7b753bdcc51043ba0e75ba`, Branch `main`, git-dir/common-dir `.git`, **kein staged diff**, tracked-dirty 14 + untracked 65 (fremde Einträge unangetastet), 31 Worktrees.
**Dieser Task (S2 / Hub-Monitor-UX + Fallback-Konfiguration):** Kandidat `259454d3238e0bd6f1fdd5682f450e3484d86e5d`/Tree `7e14f7e9fe67b8f48187ee9b48ab0e829794f371` wurde **nach QC_PASS lokal FF-only in Main integriert** (QC-Bericht `msg_11c4bc6e30010swpJb2oo2A2Ib`, sichtbare Revision SHA `f2328172…`, Artefakt `e6e00f4e…`; QC_FAIL→F1 mutationsgetestet behoben, 0 Restblocker) — Ancestor des aktuellen Main. Belegte Worktrees: `task_efbe63cf-s2-manager-priming` (`259454d3`), `-fallback-monitor-ux` (`4330c7d8`), `-pause-resume` (`1bd025db`), `-stock-fixes` (`3b9a6`).
**Nachfolger (separater Task, nur Referenz):** `task_fa86d673-e8d2-5a45-b82d-6ee0c733c415` FALLBACK-PER-PROFILE-20261008 = **QC_PASS ⇒ LOCAL_MAIN_COMPLETE** `019d2564…`/`c4067f86…` (pro Profilkarte eigenes Fallback + Schalter Degrading/Provider-Skip, Schema 4, Journal#5-Sortierung; MCP-Pin `2e09e5d8…`, Hub-Pin `7842dc31…`, Script 0.7.22/Adapter 0.1.34/Skill r45).
**Repo Live (task_6328d17e, separat):** lokal integriert; `afc4892…` (Tree `103c9e19…`) und `913ef83c…` sind Ancestors des Main-HEAD (git-verifiziert); extern NOT_RUN.
**WP2 `task_7e6ce738-…`:** LOCAL_COMPLETE_PASS, extern NOT_RUN; kein W1-Neustart.
**Review-Ergebnisse:** S2 QC_FAIL→F1 korrigiert→QC_PASS (ein Blocker behoben); fa86d673 QC_PASS 0 Blocker/4 INFO; RepoLive QC_PASS `ses_ee57216c` (Delta F1/F2) + „MAIN_LOCAL_INTEGRATED_PASS" `ses_ee721b32`.
**Offene Blocker/Risiken/unverified:** Q1c/Q1b/Q6/Q7/Q8 (Konzeptentscheidungen, Empfehlungen in P), Stufen S3→S7, separater F2-Main-Testdefekt (`tests/mcp_self_connection_test.py`, am Base identisch reproduziert), echte Langzeit-/Native-/Live-Abnahme, hosted ChatGPT-Import r45; Diagnose: Editor „Too many open files in system", Tunnel „response already fulfilled or unknown request", **lokale Healthchecks PASS ≠ E2E-PASS**, ActivityJournal-Fail-closed-Latch (Ursache unverified, nach Operator-Adapterneustart wieder nutzbar).
**Nächste konkrete Schritte:** (1) nach neuem Operatorauftrag Main-HEAD/Tree/Dirty + Worktrees frisch prüfen; (2) Q1c/Q1b/Q6/Q7/Q8 entscheiden, dann S3 Hierarchie → S4 Pause/Resume (`1bd025db…` Reconcile) → S5 VM-Verlust → S6 Scheduler-Failure → S7 Guard; (3) F2 separat beauftragen; (4) Operator-Installation für Nachtlaufwirksamkeit; (5) RepoLive-Externabnahme. **Kein Deploy/Restart/Policy-/Board-Done.**
**Artefakte/HEADs:** S2 `259454d3…`; Fallback `019d2564…`; RepoLive `afc4892…` (Tree `103c9e19…`, Parent `913ef83c…`). Host-persistente QC-Sicherung: `…/sessions/66370db6…/reboot-checkpoint-20261008/` (7 Dateien) + `RESUME-HANDOVER-20261009.md`.
**Session-/Result-Referenzen (nur Zusatz, Kern steht oben im Text):** Author/Integrator `ses_ee79db5afffe4Ik6tpeYNELwnK`; Reviewer `ses_ee76122d4ffeONomz0XBDdCeKw` (QC_PASS `msg_11d56ef25001Gc0bz4EqgzvHCt`); Monitor-Stränge `ses_ee371ae17ffe…` (Report `monitor_5e427218…`, `wake_492474…`), `ses_ee3631d31ffe…` (Monitor-Delegation).

## Wiederaufnahme 2026-10-09 (nach VM-Neustart) — Operator-Rückmeldung, HP-Folgeticket, P1

**Operator-Rückmeldung (bestätigt, keine unabhängige Testaussage):** Der Nutzer bestätigt, dass die installierte/live Version läuft, das Fallback funktioniert und in Main ist. Das wird hier als **Operator-Rückmeldung** festgehalten — **nicht** als unabhängiger vollständiger Timeout/Quota-/Langzeit-Test. Die in C/P dokumentierten externen Abnahme- und Kalibrierungslücken (echte Providerfehlertexte, Langlauf, Native) bleiben daher **UNVERIFIED**. Kein erneuter Installations-/Fallback-Einstieg aus diesem Anlass.

**High-Priority-Folgeticket (im Übergabeindex f28898 noch nicht erfasst, aus lokalem Management-Journal belegt):** Journal #37 (`entry_id 1555228e…`) und #38 (`79b7ba61…`, appended 2026-10-08T18:51Z) beauftragen ein **Korrekturkonzept – Management-MCP-Bindung, Orchestrator-Skill-Bereitstellung und native Subtask-Delegation der Monitor-Manager** (Priorität High; Journal #38: „Priorität High bleibt"). Vollständiges, CONCEPT_ONLY-Dokument liegt erhalten im task-eigenen Worktree: `.opencode-vm/worktrees/task_efbe63cf-monitor-mcp-konzept/planning/task-concepts/task_efbe63cf-53da-5e79-be25-f7ac8efe9916-monitor-mcp-konzept.md` (SHA-256 `fad92f3efbde6eef6e2f4dd64984921785fc0b706c1484b3aa13e36b36ec7993`, 37050 B, Branch `task/efbe63cf-monitor-mcp-konzept`, Base `259454d3`). Kanonische Verlinkung in C/P war noch offen — hiermit gebunden (P §22). Belegter Kernbefund (U1): `orchestrator`-Paket inaktiv ⇒ Skill nicht gemountet ⇒ `mcp_self_register`-Gate false ⇒ kein `ocvm-self` in der Session-Config ⇒ Manager ohne Board-/Dispatch-Tools (`MANAGER_CONNECTOR_NOT_BOUND`). Offene echte Entscheidungen des Konzepts: D1–D8 (u. a. Aktivierungs-Policy, Subtask-Kriterien, Background-Flag, Modell-Pinning, F2-Testdefekt, Self-Steering-Guard Q1c/Q1b).

**Aufgenommener unabhängiger Schritt P1 (Skill-Provisioning-Fix) — UMGESETZT, Kandidat (nicht integriert):**
- Ursache (belegt): `ORCHESTRATOR_SKILL_CACHE` wurde in `skills_source_root_for` referenziert, war aber nirgends definiert; bei Standalone-`~/bin`-Installation ohne adjacentes Checkout maskierte `2>/dev/null || continue` den Fehler ⇒ das aktivierte Paket wurde **still übersprungen** (POLA-Verstoß).
- Fix (kleinster Fußabdruck, keine Produktentscheidung vorweggenommen): `ORCHESTRATOR_SKILL_CACHE` definiert; in `skills_mount_for_session` bricht ein aktiviertes `orchestrator`-Paket ohne lesbare, nichtleere `SKILL.md`-Quelle mit klarer Meldung ab (`return 1`) statt still zu überspringen. Checkout- und vorhandener Offline-Cache-Pfad bleiben unverändert; Opt-out bleibt unberührt.
- Kandidat: Branch `task/efbe63cf-skill-source-resume` (Worktree `.opencode-vm/worktrees/task_efbe63cf-skill-source-resume`), Commit `5ebd0d66c1c79756d605ba32e161f471cd9d733f`, Parent/Base Main `f28898a783ded7f2c02cda5d340b9b43150bff9e`; 2 Dateien (`opencode-vm.sh` +6/−4, neu `tests/orchestrator_skill_source_test.sh`); Script 0.7.22→**0.7.23**, drei Asset-Tags `v0.7.23`; keine Adapter-/Hub-/Pin-Änderung.
- Tests/Belege (grün): neu `tests/orchestrator_skill_source_test.sh` 5/5 (Checkout mountet + Manifest; fehlende Standalone-Quelle bricht explizit ab, kein falscher Mount; leerer Cache abgewiesen; vorhandener Cache mountet offline; Opt-out braucht keine Quelle); `besprechung_test.sh` grün; `bash -n`, `shellcheck --severity=error`, `release_metadata` 5/5, `release_state` 5/5.
- Vorbestehender Fremdbefund (nicht durch diesen Patch verursacht, unangetastet): `tests/skills_orchestrator_test.sh` erwartet Skill-Revision **r43**, der erhaltene Bundle-Stand ist **r45** ⇒ Test scheitert identisch am Base (`f28898`) und ist ein separater Bestandsdefekt außerhalb dieses Scopes.
- **Nicht getan:** keine Main-Integration, kein Push/Tag/Release/Install/Deploy/Restart, keine Produkt-/Board-/Policy-/Live-/Monitor-Änderung, fremde dirty Dateien unangetastet.

**Nächster Schritt:** (a) P1-Kandidat unabhängig QCen (exakt `5ebd0d6`), dann lokale Main-Integration durch den bestehenden Owner; (b) danach HP-Konzept `monitor-mcp-konzept` in Phasen P2–P6 (Preflight, mgmt-v2-Priming, Alt-Session-Doku, Skill r45, Abnahme) — **nur mit Operatorauftrag** und nach Entscheidung der offenen D1–D8; (c) der bestehende F2-Testdefekt `tests/mcp_self_connection_test.py` bleibt separat (D6). Keine automatische Fortsetzung.

**Offene echte Entscheidungen (unverändert, blockieren P2+):** D1 Aktivierungs-Policy (default_active vs. Opt-in), D2 Subtask-Kriterien (schreibend in zugewiesener Test-Estate vs. strikt read-only), D3 Background-Subagents, D4 Modell-Pinning, D5 `commands/orchestrate.md`, D6 F2-Testdefekt, D7 Proxmox `-32000`, D8 Self-Steering-Guard Q1c/Q1b. Empfehlungen je D liegen im Konzeptdokument §9; P1 war von keiner dieser Entscheidungen abhängig und daher vorab umsetzbar.

## Operator-Präzisierung D1/D8 (2026-10-09, DOCS_ONLY, verbindlich)

**D1 (Aktivierungs-/Adressatenmodell) — fachlich präzisiert:** Der Skill hat **zwei Adressaten**: (a) **externe Agentenumgebungen** (z. B. ChatGPT) für die beauftragte OpenCode-Orchestrierung; (b) **innerhalb OpenCode nur Monitor-/Manager-Sessions**, die ein Work Package oder Mastertask begleiten. **Einstieg lightweight, Details bedarfsgerecht.** Das MCP-Angebot soll **möglichst selektiv** diesen internen Sessions bereitgestellt werden. Ist selektive Bereitstellung technisch nicht möglich, ist **gemeinsame Sichtbarkeit zulässig — aber das MCP MUSS serverseitig Rechte prüfen**. Externe Aufrufer nur **innerhalb bestehender Auftrags-/Auth-Berechtigung**, **kein pauschaler Vollzugriff** allein durch den Namen „OpenAI". Damit ist D1 nicht mehr „default_active vs. Opt-in" als reine Komfortfrage, sondern: **opt-in/lightweight + selektive interne MCP-Bereitstellung + serverseitige Rechteprüfung**.

**D8 (Guard) — jetzt verbindliche fachliche Anforderung (nicht mehr bloß Prompt-Pflicht/optional nachrangig):**
- Gewisse **Selbststeuerungs-/Managementaktionen sind für ALLE internen OpenCode-Aufrufer zu sperren — einschließlich Mastertasks.**
- Die **übrigen** internen Managementaktionen sind **nur an die autorisierte Monitor-/Mastertask-Rolle UND den zugeordneten Task-/WP-Scope** gebunden.
- Externe Aufrufer: nur im Rahmen bestehender Auftrags-/Auth-Berechtigung.
- **Vom Agenten behauptete Herkunft/Rolle ist KEIN Vertrauensnachweis.**
- **Die konkrete Verbotsliste ist noch OFFEN** — nicht erfinden. **Implementierung noch offen**; der Guard ist ab jetzt Pflichtbestandteil, nicht optional.

**Technische Klärung (belegt aus Konzept U1–U7/A–D/§5 + Source `opencode-vm.sh:14726–14766`, `adapters/mcp/src/http.ts:401–424`):**
- **Belegt — per-Session-Sichtbarkeit:** `mcp_self_register` schreibt `ocvm-self` **nur** in die Session-Share-`config/opencode/opencode.json` und nur wenn `OC_MCP_ENABLED=1` **und** das kanonische `orchestrator`-Skill in dieser Share gemountet ist (`:14753–14766`). Also ist die **Tool-Sichtbarkeit bereits per-Session und opt-in über Skill-Präsenz** steuerbar; ein MCP-aktivierter frischer Start rotiert Token, Port je Session. **Sichtbarkeit ≠ Autorisierung.**
- **Fehlt/unverified — vertrauenswürdige Aufruferidentität:** `validToken` prüft nur ein **statisches geteiltes Bearer-Token** (`timingSafeEqual`), `validHost` nur `Host ∈ {127.0.0.1, localhost}`, `validOrigin` nur falls Origin gesetzt (`http.ts:401–424`). **Keine** `remoteAddress`/`X-Forwarded`/Caller-Feld/Per-Rolle-Token. Konzept §5: **identisches Token** in Agent-Config und Tunnel, Loopback, gleiche UID, Confinement default-allow ⇒ **interner Self-MCP vs. externer Tunnel vs. Scheduler sind serverseitig nicht unterscheidbar** (NOT_FEASIBLE).
- **Heute vorhandene technische Sperren:** geteiltes Bearer-Token + Loopback-Hostcheck + optionaler Origin-Check + AppArmor-Confinement (default-allow); Scheduler-Pfad läuft real getrennt (in-process, kein MCP/Token). **Keine** Selbstreferenz-/Zielklassen-Prüfung im Adapter.
- **Minimaler nächster Entwurf (Empfehlung, nicht implementiert):** (a) R3+ deklarierter Caller + **serverseitige Zielauflösung**, fail-closed nur für Selbstziel/unbestimmten Caller bei geschützten Writes (kleines Adapter-Delta + Audit + Tests), ergänzt um (b) delegierenden Tool-Wrapper als Prompt-Pflicht. Deckt „behauptete Herkunft reicht nicht" ab, weil die **Zielauflösung serverseitig** erfolgt.
- **Exakt benötigte Operatorentscheidung:** (1) die **konkrete Verbotsliste** (welche Aktionen für ALLE internen Aufrufer inkl. Mastertasks gesperrt; welche nur rollen-/scope-gebunden) — offen, Operator-eigen; (2) Guard-Variante (a) vs. (b) zuerst; (3) Bestätigung der selektiven internen MCP-Bereitstellung über die bestehende config-/skill-gated Registrierung.

**Status:** D1 fachlich präzisiert; D8 als verbindliche Anforderung dokumentiert, **Implementierung offen**. Keine Skill-/Code-/Policy-/Live-Änderung; fremde dirty Dateien unangetastet.
