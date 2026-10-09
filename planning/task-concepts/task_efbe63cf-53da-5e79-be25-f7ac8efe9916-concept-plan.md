Task-ID: task_efbe63cf-53da-5e79-be25-f7ac8efe9916
Title: Management-MCP-Bindung und Orchestrator – kanonischer konsolidierter MVP-Plan
Status: W4_IMPLEMENTED_PENDING_QC (EFBE-MVP-IMPLEMENTATION-20261009-R1) — W1/W2 unabhängig PASS; W4-Kandidat `64c9a83…` wartet auf unabhängige QC (Original-Subpunkt Preflight/Standalone-Honesty offen); kein Selbst-PASS; W3→W5 sequenziell offen
Last-concept-update: 2026-10-09T14:32:03Z
Konzeptrevision: EFBE-MVP-COOPERATIVE-J59-R1 (Konzeptbasis); Execution-Contract-Aktiv: EFBE-MVP-IMPLEMENTATION-20261009-R1
Entscheidungsstand: Journal #52–#59; #59 0c07a7a8-0456-424c-b02d-fe00bb604c00; Implementierungs-Freigabe #60; W1-QC_FAIL #63; Reset-Recovery #64–#65; W1-F1-Reparatur; W1_REQC_PASS; W2-Umsetzung; W2_QC_PASS; W4-Umsetzung (Ersatz-Autorensession)

# Kanonischer Design-, Entscheidungs- und Testplan

## 1 Scope, Dokument-Ownership und Revisionen

Aktueller Auftrag: tatsächliche Autorenkorrektur der bestehenden drei Konzept-/Plan-/Contextdateien nach unabhängiger Review F1–F8 und Operatorentscheidungen #52–#59. Kein Feature-/Skill-/MCP-/Policy-/UID-/Token-/Permission-Write, keine Tests/Live-Mutation, kein Deploy/Release/Sessioncleanup. Runtime vom Operator zuletzt GPT-6.1 Sol über OpenCode Zen/high gewählt; kein Alibaba, kein eigener Profilwechsel.

P ist kanonisch für aktuelles Design, Entscheidungen und Abnahme. C ist ein knappes current Dokument; Hauptkonzept ist die konsistente ausführliche Erläuterung, keine zusätzliche alternative Policy:
- C: `.opencode/tasks/task-task_efbe63cf-53da-5e79-be25-f7ac8efe9916.compact.md`.
- Hauptkonzept: `.opencode-vm/worktrees/task_efbe63cf-monitor-mcp-konzept/planning/task-concepts/task_efbe63cf-53da-5e79-be25-f7ac8efe9916-monitor-mcp-konzept.md`.
- Gesicherter aktueller Hauptkonzeptstand: Branch `task/efbe63cf-monitor-mcp-konzept`, Dokumentcommit `c7c630a5f00c4f6e83954f448d40cb025c9b3b8f`, SHA-256 `455617cf8a276b1c9c1aa9e7cf0a2769b253b05f49a06520df2122cde87e73f6` (41.398 B). Das ist eine Doku-Revision, kein dortiger neuer Produkt-/Mainstand.
- Unveränderter Review: `planning/task-concepts/task_efbe63cf-53da-5e79-be25-f7ac8efe9916-final-concept-review-20261009.md`.
- Entscheidungsquelle: `.opencode-vm/taskboard/management-journal/task_efbe63cf-53da-5e79-be25-f7ac8efe9916.jsonl`, generation `360c61d7-f38f-4b6c-8b28-9e23718e216c`, gelesen bis #59. Journal wird hier nicht geändert.

Schreibziel Hauptkonzept bleibt der bestehende Branch `task/efbe63cf-monitor-mcp-konzept` auf ursprünglicher Produktbasis `259454d3238e0bd6f1fdd5682f450e3484d86e5d`; C/P liegen kanonisch im Mainroot. Der vorherige vollständige Hauptkonzeptstand ist im selben Worktree als Historiencommit `7e9fa907c10b3b48fc9c82ba3f892cd846721127` gesichert (87.320 B, SHA-256 `4e1d3efb9680ab7d30a8a4d950f11ba04e587c294978cb5636920b011dcded2c`). Frühere kanonische C/P vollständig unter Maincommit `8a6a7f0a7d6c238568c43d23188231ee8d179aec`. Alte Abschnittsnummern §1–§30 dieser P betreffen ausschließlich jene historische Fassung.

**BELEGT:** Source/Git oder datierter früherer Live-Nachweis. **VORGESCHLAGEN:** noch nicht implementierter Sollpfad. **UNVERIFIED:** aktueller Laufzeit-/E2E-Beleg fehlt. Doku-Korrektur ist weder Implementierung noch unabhängiger QC_PASS.

## 2 Entscheidungen, Supersession und Scopegrenze

| Journal | Verbindlicher aktueller Inhalt |
|---|---|
| #45 | Alter Proxmox-MCP außerhalb Scope/Blockern; keine Löschung. Technische Werkzeug-/Transport-/Testdetails Expertensystem, keine erneuten D3/D5/D6-Fachfragen. |
| #46/#55 | Monitor darf eigene Konfiguration/Autonomie/Runtime/Freigabe-/Managementdaten nicht selbst ändern. INPUT_REQUIRED-Parken und beauftragte eigene Workersteuerung/Fallback erlaubt. |
| #47/#48 | Frische eigene oder verifiziert vom selben Manager erzeugte Root-Worker; keine fremde Sessionübernahme. Tasklose Worker möglich, kein Ticket nur für Context, keine interne automatische Task-Anlage/Umplanung. |
| #49/#50/#52 | Nach Schritten/Ergebnissen kontinuierliche Synthese. Endgültig: sicher übernehmen → Session archivieren → zugehörige Contextdatei abräumen. Archivierung ist entschieden; Git-Tracking technisch entschieden: nein. |
| #53 | M1/M1-A plus kurzer Inhalt, volle IDs im Hintergrund. S1 nur soweit Sichtbarkeit kurz/eindeutig bleibt. |
| #54/#55 | Kooperative verbindliche Skill-Regeln sind bewusst das MVP. Auth extern erhalten; missachtbare Regeln und begrenzte Auditabdeckung ehrlich benennen. Spätere technische Absicherung separat. |
| #56/#57 | Manager niemals native Subtasks, auch nicht read-only. Steuerung seriell über eigene Root-Worker. Worker entscheiden selbst über ihre Subtasks innerhalb vorhandener Auftrag/Scope/Permissions, ohne Zusatzfreischaltung. |
| #58/#59 | Aktive Entwicklungsmission, acht Wake-Pflichten, leichter Skill-Einstieg mit vorhandenen Autonomie-/Eskalations-Detailreferenzen; keine Statusloops als Auftragserfüllung. |

**Explizit supersediert:** historische D2-/read-only-Manager-Ausnahmen und Subtask-Matrix einschließlich Manager-Child-Fallback-/Background-/Custom-Agent-Smoke-Gates. Die Matrix bleibt ausschließlich im historischen Hauptkonzept/Commit, nicht aktuelle Regelquelle für W1/W4.

**MVP-Pflicht entfällt:** harte TWO-TOKEN-/UID-/Secret-Isolation, R3+-Caller-/Spoof-Hardblocks, Alias-Toollisten und zweiter Listener, legacy-ambiguous-Migration sowie zugehörige harte W1-/EACCES-/ptrace-/Authklassen-Gates. Frühere E1–E4/E14-Adapter-Sperrpläne sind insoweit nicht umzusetzen.

**Zurückgestelltes Folgeticket:** task_c9148add-9807-578f-ad25-3c689cfa133a. Dorthin gehören belastbare Caller-/Rollen-/Scope-Durchsetzung, vollständige Isolation einschließlich privilegiertem Shellharness, Tunnel-Config/Keys/Healthsocket/Logs unter passender Ownership, Spoofschutz und ggf. Zwei-Token-/Migrationstests. F3/F4 sind dort offen, kein heutiger MVP-Blocker und kein beauftragter Sicherheitsfix.

## 3 BELEGT: Ist-Datenfluss und Secret-Inventar

Quellenstände: ursprüngliche Diagnose `259454d` (Script 0.7.21 / Adapter 0.1.33 / Bundle r44 / damaliges OpenCode 1.18.34); geprüfte Produktbasis `019d2564`/`f28898a` und docs-only-Main `8a6a7f0` (Script 0.7.22 / Adapter 0.1.34 / Bundle r45). Keine Versionszeile bedeutet aktuelle Live-Abnahme. Sourcezeilen nach Symbol verifizieren.

| Material | Quelle/Ort/Konsument | Abgrenzung |
|---|---|---|
| MCP-Bearer, `X-OCVM-MCP-Token` | `ensure_mcp_credential` ca. Script 17277–17296 → 0600 `mcp/credential` im 0700 Share; `mcp_self_register` ca. 14753–14766 schreibt **Klartextliteral** in `opencode.json`-Header. Tunnel-Headermaps verwenden denselben Bearer via `file:…/mcp/credential`. | Kein `file:`-Header in OpenCode-Config; intern/extern identischer Bearer, keine verifizierte Callerklasse. Digestvergleich in http.ts ist nicht Digest-only-Speicherung des Secrets. |
| OpenAI-Tunnel-API-Key | Bestehende Host-Connection-Registry; stdin-Provisionierung → `mcp/tunnel-key`; `tunnel.yaml.control_plane.api_key` als file:-Referenz, Script ca. 14496–14522. | Control-Plane-Secret, nicht MCP-Bearer. Lokaler File-Cleanup bei Tunnelstop revokiert nicht den Remote-API-Key in der Hostregistry. |
| Tunnel-ID | `control_plane.tunnel_id` aus Projektassignment | Routing-ID, weder Bearer noch API-Key; keine Vollmacht durch Providername. |

`http.ts:401–424` authentifiziert den vorgelegten gemeinsamen Bearer, validiert Host/Origin, nicht behauptete interne Rolle. Config-/Tokenzugriff unter gleicher Session-UID/default-allow-AppArmor (Script ca. 10709–10784, 14567, 14782, 14829) ist keine harte Secret-Isolation, insbesondere nicht bei privilegierten Shellmöglichkeiten. Konkreter proc-/ptrace-/Mountschutz ist live ungeprüft. Ein Modell kann Skillregeln missachten; Audit kann nicht jede Umgehung erkennen. Genau dieses Restrisiko ist durch #54/#55 bewusst akzeptiert.

Bestehende externe Auth, loopback/TLS/Scope-/Credential-/Admission-/Pending-/CAS-Prüfungen bleiben. Keine neuen Tokenklassen/UIDs/Listener/Aliaslisten im MVP. Fresh-/Attach-Lifecycle verwendet vorhandene validierte Credentials; kein ungeprüftes All-Session-Revokeversprechen.

**Bindungsdiagnose:** U1: Skill inaktiv → kein ocvm-self → fehlende Tools; U2: undefiniertes Cachevar/stilles Standalone-Skip; U4: Primingtext ≠ geladener Skill/Tools; U5: Startmount ≠ nachgewiesener Attach-Mount; U6: historische stale Erstlesung; U7: `/experimental/tool/ids` kein MCP-Client-Inventar. Historische Ports/PIDs und Berichte verbleiben im Hauptkonzept-Snapshot. **U3/Proxmox ist außerhalb Scope**, kein Cleanup.

`$SESS_SHARE/config/opencode/opencode.json` ist gemeinsame VM-/Projektruntime-Konfiguration, kein belegter separat autorisierter MCP-Client für jede OpenCode-Chat-Session. Frühere „per-Session selektiv belegt“-Aussage zurückgenommen. Rolle/Nutzung im MVP durch Skill geregelt; allgemeine technische Sichtbarkeit beweist keine Zulässigkeit. `/mcp` connected plus tatsächlich gelistete Kern-Tools und echte Skillladung sind der Preflight, nicht Config-/Healthcheck allein.

## 4 Mission, Geltungsbereich und Regelquelle

**Mission (#59):** „Der Monitor-Manager treibt die beauftragte Entwicklung innerhalb seines eingestellten Autonomieprofils aktiv bis zum vereinbarten Ergebnis voran. Er trifft zulässige Entscheidungen selbst, beauftragt und betreut eigene Worker-Sessions, beseitigt Hindernisse und veranlasst die nächsten Schritte; reine Beobachtung ist nicht sein Auftrag.“

Zwei Adressaten: (a) externe beauftragte Operator-/ChatGPT-/Agentenumgebung innerhalb echter Auth-/Auftragsgrenzen; (b) interne ausdrücklich eingesetzte Monitor-/Management-Root-Sessions für WP/Mastertask. Normale OpenCode-Implementierungssessions verwenden dieses Management-MCP **nicht**. Worker oder deren Subtasks erben keine Managementbefugnisse durch bloße Tool-/Skill-Sichtbarkeit.

Manager nutzt nie native `task`-Subtasks; serieller Manager, keine parallelen Sub-Manager. Er erzeugt neue eigene Root-Worker oder setzt nach beweisbarer Ownership eigene fort. Unabhängiger Reviewer ist separat, nicht eigener Implementierungs-Fixer. Worker bestimmen Subtaskeinsatz autonom im bestehenden Vertrag und technischen Permissions; keine extra Operatorfreigabe, kein Manager-Mikromanagement. Bestehende serielle Monitor-v1-/Wave-Grenzen bleiben; geklärte fachliche Workerparallelität ist kein neuer paralleler Management-Go.

Spätere Skillgestaltung: kurzer Einstieg mit Mission/Geltung/Aktionsmatrix/Wakecheckliste; bedarfsgerechte Referenzen für Profile, Receipts/Fallback, Ownership/Worktrees, Workercontext/Lifecycle und Attention. Vorhandene `references/optimistic-mvp.md`, `work-packages.md`, `integration-test-monitor.md`, `monitor-tasks.md`, `fallback-routing.md`, `task-done-archive.md` wiederverwenden. Hier keine Skill-/Bundleänderung oder erfundener zukünftiger Dateiname als heutige Capability.

## 5 Kooperative Aktionsmatrix

Verbindliche „darf/soll nicht“-Regeln, **kein garantiertes Adapterverbot**. Vorhandene technische Toolguards gelten unabhängig. Lesen/Schreiben im Auftrag bleibt von eigener Autorisierungs-/Konfigmutation getrennt.

| Bereich | Interner Manager | Legitimer Gegenpfad/Abnahme |
|---|---|---|
| Task/WP/Policy/Monitor/Session/Attention lesen, Originalbelege prüfen | Beauftragter Projekt-/Taskscope; keine fremde Sessionsteuerung aus Read ableiten | Reads/Verifikation dürfen nicht pauschal durch Taskboardverbot entfallen. |
| Journal, eigener Context, additive Notes/Ergebnisreferenzen | Erlaubt/Pflicht; append-only Taskanforderungen, beleggebunden, keine neue Freigabe/Scope-Erweiterung | Neue Vorschläge kennzeichnen, keine OPERATOR-DIRECTIVE-Autorität erfinden. |
| Eigene Root-Worker create/send/followup/reuse | Neue erzeugen oder Erstellungs-/Receipt-/Scope-/Idle-/Pending-Evidenz eigener Session prüfen; kein Selbstsend | Uncertain-Abgleich statt Doppelauftrag; `SESSION_NOT_BUSY` heißt Nichtadmission, kein Retry per Followup-Bypass. |
| Worker-Runtime, konfigurierte Fallback-/Compaction-Fortsetzung | Eigene Worker, aktueller Auftrag/Policy/Katalog/readback; kein busy/pending Switch, keine freie Ersatzwahl | Nach Schritt neue reguläre Rolepolicy lesen, Sideeffects prüfen, ursprüngliche Taskidentität/Budgets erhalten. |
| Eigene Monitoring-/Autonomie-/Runtime-/Approval-/Freigabe-/Steuerdaten | Nicht selbst verändern; `update/enable/disable/cancel/trigger/delete`, eigenes Profil-/Expiry-Upgrading etc. bleiben Operatorbereich | Empfehlung/Attention; INPUT_REQUIRED ist keine Konfigmutation. |
| Taskboard-/Management-Toolconfig, Taskanlage, selbst erteilte Freigabe, eigenmächtige Umplanung | Nicht zulässig; kein `create_project_task`/Spawn-/Umplanungsloop durch Manager | Taskvorschlag an Operator, bestehende Tasks nutzen; externe Befugnisse nicht pauschal entfernen. |
| Evidenzgestützte Task-Statusfortschreibung/Done | Ausschließlich bereits existierende autorisierte Transition und Ergebnis-/Abnahmebeleg, keine neue Umplanung | Turn-stop/Review/Rendern allein ist nicht Done; keine eigene Approvalveränderung. |
| INPUT_REQUIRED/Eskalation/Parken | Pflicht bei echter außerhalb Profil/Scope liegender Grenze; Scheduler-/Monitorconfig unverändert | Wiederaufnahme aus neuem kanonischem Entscheidungsbeleg, keine wiederholte Routine-Go-Frage. |
| Eigener Worker-Abort | Nur beauftragte evidenzgebundene Recovery, Outcome verifizieren, kein Rollback behaupten | Keine pauschale Scheduler-Recoverygarantie, unknown hält nächste Aktion an. |
| Eigener finaler Worker archive/contextcleanup | Erlaubt erst nach gesicherter Synthese/Übergabe, idle/no-pending/no-uncertain, bestätigtem Archive | Keine Sessionlöschung, keine Cleanup-Globs, keine fremden/Dauerbelege entfernen. |
| `supersede_unresolved_submission`/operator_authorized-Attestierung | Keine Selbstautorisierung; ohne echte exakte Operatorentscheidung halten | Vorhandener Operator-/Guardvertrag bleibt erforderlich. |

Extern bleibt tatsächlicher Auftrag und vorhandene Auth maßgeblich, kein Vollzugriff durch „OpenAI“ oder Rollenname. Aktionsmatrix-Szenarien sollen erlaubte Reads/Notes/Workersteuerung genauso prüfen wie Unterlassen unerlaubter Eigensteuerung. Modellbefolgung kann scheitern; ein Missachtungsversuch ist keine technische `BLOCKED`-Garantie.

## 6 Bestehende Autonomie- und Modellprofile

Quellen: `planning/task-concepts/task_3a2ed31a-abce-5375-992b-abfc2b06e51e-concept-plan.md` §2/§5/§6 (Conservative/Sandbox/MVP/YOLO); #13/S2-Sandbox-Text; vorhandene `references/optimistic-mvp.md` §§ Effective contract/Smallest functional reversible choice/Drift; `work-packages.md` §§ Minimal-functional autonomy/Repair; `integration-test-monitor.md` Counter-Vertrag. Keine neue Profile-/Permission-Policy.

| Registrynamen / Verhalten | Konkreter Auftrag / Rücksetzbarkeit / INPUT_REQUIRED |
|---|---|
| conservative | Entschiedene beauftragte Schritte aktiv ausführen, gewöhnliche bereits geklärte technische Details selbst lösen. MVP-off: keine automatische Domain-OID; offene Fachentscheidungen früher eskalieren, normale technische Kleinschritte nicht blockieren. |
| sandbox | Autonom nur ausdrücklich zugewiesenes Test-Estate: Harness/Fixtures/Testcode/-tests/Testservices/DB/Container/Images, beauftragter Cleanup/Neuaufbau. Produktquellcode/-semantik/-schema und Production/fremde/unbekannte Ziele außerhalb; Teststate/Belege vor reset sichern. Kein Isolationsversprechen. |
| mvp / Optimistic MVP | Kleinste funktionale additive reversible Wahl innerhalb Architektur/Scope/Akzeptanz. Annahme, Alternativen, materiellen Rework-/Rücknahmepfad dokumentieren. Hardboundaries (neue Security/Trust/Core-API-/Architektur-/irreversible Daten-/Scope-/Ownership-/Permissionwahl oder definierter erschöpfter Produktions-Reparaturpfad) gewinnen → INPUT_REQUIRED; keine redundante Go-Frage im vorhandenen Spielraum. |
| yolo | Beste Lösung im tatsächlichen Auftrag eigenständig vorantreiben, Dokumentations-/Rücknahmepflicht; nur echte harte Blocker/fehlende Entscheidbarkeit nach bestehendem Profil eskalieren. Kein eigener Scope-/Permission-/Monitorupgrade, kein stilles Irreversibilitätsrisiko, keine neuen Deployrechte. |

Alle tragen Fortschritts-/Fehler-/Contextpflichten. Rücksetzbarkeit ist konkrete Beleg-/Reworkfrage, kein Etikett. Bestehende Fingerprint-/No-Progress-/Reservierungs- und Native-Retry-Semantik bleibt, keine neuen globalen Budgets. Werkzeuge/Sicherheitspermissions/Scope bleiben echte Grenzen; YOLO ist kein automatisches Antworten auf fremde Permissiondialoge.

**Modellprofile Execution/Standard/Deep/Design/Review sind eine getrennte Achse:** Arbeitstyp bestimmt Profil, aktuelle Projektpolicy bestimmt Provider/Modell/Variant, Katalog/Runtime-Readback beweist Wirksamkeit. Keine feste Anbieterwahl/Leistungsrangfolge, keine Umdeutung Review zu „mehr Denken“. Autonomieprofil ist Operatorwahl; interne Manager verändern es nicht. Keine autonome Umstellung der laufenden Autorenruntime.

## 7 Wiederkehrender Wake-Vertrag (#58)

1. Persistenten Managercontext, kanonische neueste Aufgaben-/Entscheidungsrevision und Workerindex laden. Details nur bei Delta/Bedarf, keine C/P-Vollreads pro unverändertem Tick.
2. Tatsächliche Session-/Auftragszustände, aktive/Pending-/Uncertain-Receipts und Ownership prüfen. Bereits admittiert beobachten, unknown nicht doppelt senden.
3. Neue Ergebnisse vollständig korrelieren/lesen, Fortschritt/Key Findings/Entscheidungen/Belege laufend synthetisieren, auch bei Worker-Reuse. Summary/technical finish allein keine Abnahme.
4. Fehler/Blocker/Fortschritt analysieren, innerhalb erlaubtem Profil/Scope beheben oder separaten eigenen Korrektur-**Workerauftrag**, nicht neuen Board-Task, veranlassen. Bestätigten Timeout/Quota von RateLimit/Kontextfehler unterscheiden; konfigurierte profilspezifische Recovery/Compaction/readback/Sideeffects einsetzen, keine freie Runtimewahl.
5. Abhängigkeiten/next allowed step seriell entscheiden/reservieren/dispatchen. Bestehende bounded Single-flight-Regel: ein logischer Mutationsschritt, danach Beleg/Checkpoint, keine parallelen Sub-Manager.
6. Echte fehlende Fachentscheidung/harte Grenze als INPUT_REQUIRED mit konkretem Kontext/Optionen/Erledigt/Pausiert eskalieren; eigener Monitor/Scheduler unverändert. Unveränderter Park billig/no-op; neue belegte Antwort/Resultat weiterbearbeiten.
7. Eigene noch benötigte Worker wiederverwenden; endgültig fertige nach sicherer Übergabe archivieren und Contextfiles zielgenau abräumen.
8. Journal/Compact Context/Workerindex/offene Receipts/Synthese-/Next-step-Stand aktualisieren und readbackprüfen.

Manager treibt Entwicklung aktiv, Statusabgleich ist Grundlage, kein Ersatz für Mission. Wakechecks gelten bei tatsächlichen Engine-/Chat-Wakes, nicht als behaupteter Hintergrundtimer. Vorhandene Event-/Attention-Queue ist **keine** belegte Completion-Subscription an den Manager; Root-Dispatch → Receipt bedeutet keine automatische Parentfortsetzung. Ob Worker-Receipt-/Resultatdelta den vorhandenen No-op-Digest erreicht, bleibt späterer funktionaler Nachweis. Bestehender 60-s-Engine-Default unverändert; #43 diskutierte Cadencebereiche, aber keinen neuen exakten Takt beschlossen.

Manager stellt eigenes Runtime-/Autonomie-/Monitorprofil nicht um. Eigene Worker-Recovery im Auftrag bleibt; der bereits separate nichtagentische Engine-Recovery-Pfad ist von einer Skill-Selbststeuerung zu unterscheiden und nicht pauschal als E2E-PASS deklariert.

## 8 Registry-/Naming-/Ownership-Design

**VORGESCHLAGENE technische Minimalentscheidung S1/#53:** vollständige `monitor_id` ist vorhandene stabile Index-/Pfadidentität; kurzer M-Alias wird am bestehenden Monitorrecord geführt. Nicht die lange Monitor-ID sichtbar als Titel verwenden, kein Hashstring-Alias und keine zweite Alias-/Toollistenplattform.

Ein persistenter projektlokaler M-High-water-Wert plus Workerordinal pro Monitor (A…Z, AA…) genügt; Vergabe/Reserve unter bestehendem **mkdir-Lock + Generation-CAS + temporäre Datei/rename** (BELEGT `monitor.ts:13–14,203–233`). Keine falsche Beschreibung als Registry-`flock`; Policy- und Journal-Locks sind andere Verträge. Codes nie neu belegen; kleiner High-water-Stand erhält Kollisionsfreiheit auch wenn archivierte Contextdateien später entfernt werden.

Titel `M1 · Monitor: <kurzer WP-Inhalt>`, `M1-A · Umsetzung: <kurzer Inhalt>`, `M1-B · Review: <kurzer Inhalt>`; lange IDs in Details/Index. S1 ist nur für technische ID-/Pfadwiederverwendung übernommen; kurze lesbare eindeutige Oberfläche hat Vorrang. Kein Live-Rename jetzt.

Workerrecord additiv konzeptionell: stabile worker_key/alias, monitor_id/manager_alias, tatsächliche creator_manager_session_id und Zeit, aktuelle runtime_session_id, creation-/dispatch-Receipt, Scope/Worktree, task_id optional, context_path, letzter Synthesestand und Lifecycle. Kein vorhandenes taskloses Registry-/MCP-Servicefeld behauptet. Zukünftige Metadatenpflege muss den vorhandenen Registry-Mutationsvertrag benutzen; keine ungelockten nativen Registry-Writes im Skill.

**Creation/Reuse:** Kennung/Aktion vor nicht-idempotentem Create reservieren; Erstellungs-ID/Receipt erst nach tatsächlicher Antwort speichern. Create ungewiss → readback/Reconciliation, kein zweiter Create als vermeintlicher Recoveryversuch. Reuse nur persistente eigene Erstellungs- und Scope-/Receipt-/Idle-/Pending-Evidenz, Titel nie Beweis. Fremde existierende Sessions nicht nachträglich „eigene“ labeln/linken.

**Reset:** Registry → Context; alte Session-ID frisch prüfen. Fehlt die eigene Runtime, vorher Effects/Locks/Source/extern laufende Arbeit abgleichen, dann frische selbst erzeugte Runtime unter derselben stabilen Workeridentität/Context fortsetzen. Alter Laufzeitbezug mit Erstellungsnachweis als Historie, kein blinder Replay. Neuer Manager-Rebind desselben Monitors überträgt nur belegte Ownershipkette, keine fremde Managerinstanz. Unklare Effekte halten abhängige Arbeit an.

## 9 Context, kontinuierliche Synthese und entschiedene Abschlussfolge

**Technisch entschieden: Worker-Context nicht git-tracken.** Hostprojektbereich `.opencode-vm/monitor/workers/<monitor_id>/<worker_key>.md` mit kleinem eigenen Managercontext neben vorhandenen State-Daten. Kein neues Boardticket oder zusätzliche JSON-Zweitablage nötig. Quelle BELEGT: `.gitignore:1`, historische hostgemountete Registry-/Journalpersistenz; keine Off-Site-/Backup-Garantie. Taskgebundene MCP-Dokumentrollen bleiben taskgebunden; geplante tasklose Contextpflege erfolgt via erlaubter normaler Dateitools, nicht erfundener MCP-Persistenz.

Workerprompt nennt Contextpfad, tatsächliche IDs/Owner/Task optional, Auftrag/Scope, Autonomie- versus Runtimeprofil, Worktree/Base/HEAD/Artefakte, Receipts, letzte Änderung und nächsten Schritt. Explizite Pflegepflicht nach Schritten/vor Ergebnissen; compact/current, lange Belege referenzieren, Provenienz BELEGT/VORGESCHLAGEN/UNVERIFIED erhalten. Taskanforderungen nur additiv, keine stille Description-Umschreibung. Workerbenutzung von Subtasks im eigenen fachlichen Scope ist seine Entscheidung.

Manager synthetisiert Key Findings kontinuierlich an beobachtbaren Schritten und bei jedem gelieferten Ergebnis; nicht bis Workerende warten. Ergebnisse/Tests vollständig original-/artifactgebunden prüfen; Workerbericht nicht als unabhängige Verifikation umetikettieren. Bei laufendem Worker unsichtbare Zwischenschritte als Coverage-Lücke kennzeichnen. Synthese in dauerhaften Managercontext und bei taskgebundener Arbeit zusätzlich autorisierte append-only Journalnotiz.

**Abschluss fest entschieden (#50/#52):**
1. Erkenntnisse/Entscheidungen/Fortschritt/offene Punkte/Belege in dauerhaftem Managercontext/Journal/Artefakten sichern; Readback/Revisions-/Receipt-/Handoffnachweis aufnehmen. Nicht nur auf bald zu löschende Contextdatei verweisen.
2. Endgültiges Worker-Ende und idle/no-pending/no-uncertain-Receipt frisch bestätigen. Keine Erledigung allein aus abgeschlossenem Turn; keine laufende Arbeit beenden/aborten, nur um Cleanup zu ermöglichen.
3. Bestehendes `archive_session` auf eigenen eligible Root-Worker, Archivreadback bestätigen. Archive uncertain → exact-ID/include_archived-Abgleich, keine Blindretry-/Delete-Aktion. Keine behauptete Unarchive-Funktion.
4. Erst nach sicherer Synthese und bestätigtem Archiv registrierte eigene Contextdatei abräumen. Projektlokaler exakter Pfad/Owner, keine Symlinks/Glob-/Fremd-/Dauerartefaktlöschung. Index active→archived/done bzw. kleiner Abschlussbeleg; keine unendliche Sammlung aktiver Files/Sessionrollen.
5. Next-resume-Context/Index/Journal sichern. Crash zwischen Schritten: ohne Archivbestätigung Datei behalten; mit Bestätigung und gesichertem Handoff später zielgenau fortsetzen, keinen Erfolg aus fehlender Datei allein ableiten.

Archivierung und Git-Tracking sind **keine erneuten fachlichen Operatorfragen**. Hier keine tatsächliche Archivierung/Dateibereinigung.

## 10 Attention, Frische, Diskutiert versus gelöst

BELEGT RepoLive-Ist: `capabilities.prepared_attention:false`, Session-Input/unknown/anomaly-Slice max zehn (`dashboard.ts:203–212`); `/api/v1/status`, Assets, kein Dashboard-SSE/WebSocket (`dashboard-http.ts:60–88`); Browser-Poll ca. 5 s/hidden 30 s plus Fokus/Visibility (`dashboard/app.js:310–346`). Quellenfreshness, stale/degraded und letzte sichtbare Daten existieren. Hosted ChatGPT-MCP-App: Bridge transportiert `refresh_repo_live`; wirkliche Timer-/Repeated-call-/Renderingfähigkeit bleibt UNVERIFIED.

**Keine überhöhte Queuefähigkeit:** bestehende Attention-Klassen `ready/attention/action_required`, lifecycle `new/ready/offered/discussed/superseded` (`attention.ts:10–42`, `activity.ts:186–305`). Transport- oder `discussed`-Receipt ist weder Entscheidung noch fachlich gelöst/Done/QC. Frühere P-§27/E6-Behauptung eines vorhandenen allgemeinen Resolution-State wird hier korrigiert. Admission-Resolution ist anderer Sachverhalt.

Zukunftsmvp nutzt dieselbe bounded Queue und vorhandene RepoLive-Liste/Karten, max zehn + ehrliche omitted/coverage-Hinweise, keine zweite Queue oder neues Dashboard. Task-/WP-/Session-/Managerbezug, event_id/source_revision, sanitized Grund/benötigte Entscheidung/next_safe_step, Zeit/Frische/Neu-/Offenmarkierung. Taskloser Worker nur über belegten Managerindex zuordnen; unlinked bleibt ehrlich unbekannt, kein Ersatz-Ticket.

Alle offenen Queuepunkte; Sortierung InputRequired vor Fehler/Abort vor bereitstehendem Ergebnis. Formale offene Abnahme nur mit Auftrags-/Journalbeleg, ansonsten „Ergebnis zur Prüfung/Abnahme unverifiziert“. Neue Karte nach event_id, neue source_revision aktualisiert sie; Cursorablauf/superseded/prefetch partial anzeigen, keine Doppelalarme. Client-local seen Marker ist keine serverseitige Quittierung. „Diskutiert“ explizit getrennt von „Gelöst“: nur aktuell nachgelesener kanonischer Entscheidung/Resultatbeleg trägt Letzteres; fehlender Beleg → unverifiziert, nicht heimlich geschlossen. Keine neue Resolution-/Ackmutation durch UI-Rendering.

Read-Polling bleibt Transport, kein Webhook-/Chat-/Manager-Subscription-Go. Stale/disconnected bewahrt letzte Daten+Zeit statt leerem Erfolg; Reconnect dedupliziert, manueller Refresh nicht zum normalen Browserpfad erforderlich. **Unverifiziertes Planziel:** ungefähr ≤10 s sichtbar/≤35 s hidden nach vorbereitetem Queueeintrag, nur bei aktivem Browser. Fehlererkennung/Preparation/Read/UI-Latenzen getrennt messen; Timer-/Collector-Harddeadline nicht behaupten. F7-Abfrage technisch geschlossen, keine erneute fachliche Grundsatzfrage.

## 11 Minimaler Audit und Diagnoserückmeldung

VORGESCHLAGEN für zukünftige Umsetzung: vorhandene metadata-only Tooldiagnostik und Request-Korrelation um tatsächlich verfügbare Tool/Ziel/Outcome/Zeit/Request-ID und belegte Registry-/Receipt-Zuordnung ergänzen. Unauthentifizierte Rollen-/Sessionangabe explizit `declared/unknown`, nie `verified_role` erfinden. Identitätsnachweis im Folgeticket, nicht MVP-Auditversprechen.

Tatsächliche Managementänderung oder vorhandene technische Ablehnung nachvollziehbar aufzeichnen, erkannte Regelabweichung mit Regel/Grund/Belegstatus und Attention-/Journalhinweis. Kein Secret/Rawbody/Argumentdump. Es gibt keine vollständige Erkennung der Shell-/Datei-/Authumgehungen. Skillregel-Unterlassen liefert verständliche Erklärung, **kein fingiertes serverseitiges BLOCKED-Event**. Reale Tools müssen vorhandene strukturierte Fehlerrückgaben statt leerer Erfolgsmeldungen behalten. Modellbewertung aus konkreten Verstößen, kein neues automatisches Modellranking.

## 12 Umsetzungsplan – nur zukünftiger Auftrag

| Phase | Kleinster Gegenstand | Prüfbare Grenze |
|---|---|---|
| W1 neu | Mission/leichtgewichtiger Skill-/Priming-Einstieg, zwei Adressaten, kooperative Aktionsmatrix, Root-only-Manager, Wake/Pflichten und bestehende Autonomie-Detailreferenzen | Keine neue UID/Token/Aliasliste, keine technischen BLOCKED-Garantien; zulässige Reads/Notes/Workersteuerung/INPUT_REQUIRED bleiben. |
| W2 | Minimale Owner-/M-Alias-/Worker-/Contextmetadaten auf bestehendem Registry mkdir-Lock/Generation-CAS/rename; Receipt-/Reset-/Archive-Reconciliation | Kein fremder Worker, keine neue Taskflut, kurzer Titel ≠ Auth, kein ungelockter Zweitstore. |
| W3 | Prepared Attention in vorhandenen RepoLive-Karten, Poll-/Freshness-/Neu-/Diskutiert-/Belegstatus | Kein Render-Ack/Turn=Abnahme/Chatwake, Grenzen bei partieller Queue und hosted App ehrlich. |
| W4 | Preflight/Doctor/Start-Attach-Standaloneehrlichkeit, mgmt-v2-Digest/Wakefortschritt, minimaler tatsächlicher Toolaudit | P1 `5ebd0d6` getrennt QCen, nicht wieder ausführen; kein tool/ids-MCP-Inventarfehler; Auth bleibt. |
| W5 | Relevante funktionale Regression, Skillbundle/Doku/Pins nach echten künftigen Sourceänderungen, unabhängige Exactrevision-QC | Keine Selbstabnahme, keine Produkt-/Versionsänderung durch diesen Plan; Live/hosted separat, Release/Deploy nur Operator. |

Planphasen sind kein paralleler Wave-/Worker-Go. Zukünftige Skillquellenänderung benötigt passende neue Bundle-Revision/Marker/Changelog/Build/check; Ausgangsbundle r45, Registrydescription nennt noch r43 (Altbefund). Keine Registry-/Skillbeschreibung heimlich in diesem Docs-only-Auftrag ändern. Zukünftiger Scriptpatch folgt Patchbump-Regel, Adapterversion nur bei tatsächlicher Adapteränderung; alte Token-Bumpvorgabe supersediert.

## 13 Kanonische Abnahme-/Testmatrix (nicht ausgeführt)

| ID | Geplanter Nachweis | Wahrheit/Grenze |
|---|---|---|
| A1 | Start mit aktivem Orchestrator: Skillcatalog+Ladung, `/mcp` connected, tatsächliche Managementtools und Register-/Connectreadback; absent/down/Alt-Attach-Fälle zeigen eindeutigen ehrlichen Zustand | **JSON-Bearer als Klartextliteral** im 0700 Share ist Ist, kein file-backed-Kriterium; nur Tunnel-Headermaps file:. Keine Secretwerte in Ausgaben. |
| A2 | Checkout/Standalone/offline-source/Opt-out/P1-Failpfad und Skill-Bundle-/Registry-Versionsbeschreibungen abgleichen | Fehlende Quelle explizit, kein stilles Skip, kein neuer Download-Erfolg behauptet. Baseidentische r43-Test-/Registry-Altbefunde getrennt behandeln. |
| A3 | Rollenszenarien: Manager sendet keinen nativen task, serieller nächster Rootauftrag; Worker bestimmt eigenen Subtaskeinsatz | Keine zusätzliche Worker-Freigabe/-read-only-/Custom-Agentregel; Engine-Prompt und Skill stimmen überein. |
| A4 | Erlaubte Journal-/Context-/additive Note-/Read-/Workersteuerungsfälle und Eigenmonitor-/Approval-/Taskspawn-/Fremdsession-Verzicht | Verzicht ist kooperative Modellbefolgung, kein Security-Hardblocktest; Regelmissachtung ehrlich als Verstoß, nicht als technisch verhindert berichten. |
| A5 | Vollständiger Wake: State/Receipts → Originalresultat/Synthese → Fehler/Recovery → nächster Schritt/Eskalation → Contextreadback | Keine reine Statusloop, kein doppelter send/create; ungeklärte Reads halten abhängige Aktion, Fehlerklasse nicht raten. |
| A6 | Eigene Workerprofile/Variant readback, belegter Timeout/Quota → konfigurierte Fallbackfortsetzung; Kontextfehler separat Compaction; neues reguläres Profil vor neuem Auftrag | Keine eigene Monitor-/Autonomieumstellung; bestehender in-process Engine-Recoverypfad nicht pauschal garantieren; keine neuen Retries/Budgetresets. |
| A7 | Concurrent M-/Workeralias-Vergabe, Titeländerung, bekannte-/fremde-session-Negativ, uncertain-create nach Reset | Registry mkdir-Lock/CAS/rename, stabile IDs+Receipt statt Titelauth; kein Blindspawning. |
| A8 | Taskloser Context im Hostrepo, Schritte/Ergebnisse kontinuierlich synthetisiert, Manager-/Worker-Rebind mit Effekt-/Receiptprüfung | Kein neues Boardticket/MCP-taskloser-Service/Gittracking nötig; alte runtime ID nicht blind benutzen. |
| A9 | Vollständiger Handoffreadback → idle/no-pending/no-uncertain → archive readback → gezielte Contextbereinigung; Crash zwischen jedem Schritt | Kein Sessiondelete/unarchive-Versprechen; benötigte Artefakte bleiben, ungewisses Archiv/fehlender Handoff hält Cleanup. |
| A10 | Input/Fehler/Resultat ohne manuellen Boardrefresh; Taskbezug/Frische, Zeitmessung getrennt für Erkennung/Preparation/UI | Planziel ≤~10/35 s keine Capability; diskutiert/rendered/Delivery-ACK ≠ gelöst/abgenommen. |
| A11 | Queuebudget>10, Cursorablauf, neue source_revision, outage/stale/disconnected/reconnect | Omitted/partial sichtbar, keine Fehler=Leerlisten; event_id-Dedup, keine neuen Subscriptions. |
| A12 | Hostbrowser vs. Bridge-App-Parität plus echte hosted ChatGPT-/Mac/Safari-/Langlauf-Abnahme | Lokaler Fixturecheck ist kein hosted PASS; fehlende Plattformbelege UNVERIFIED. |
| A13 | Tatsächlich ausgeführte Managementtools/erkennbare Regelverletzung: bounded Audit, Request-ID/Ziel/Outcome/Regel/Grund/Ownerbeleg, Rolle unknown/declared | Keine unbewiesene Calleridentität, kein fingiertes BLOCKED-Event, keine vollständige Angriffserkennung. |
| A14 | Ausgabe-/Log-Secretfreiheit und bestehende unauthenticated→401/externe Authregression | MCP-Bearer und Tunnel-API-Key separat behandeln; Tunnel-ID kein Key; keine UID-/Zweit-Token-Isolation als MVP-Gate. |

Unit-/Fixtures, disposable Backend-/Engine-/Browserintegration und echte hosted-/Native-Abnahme getrennt. Diese Dokumentarbeit führt **keinen** Test, Smoke, Browser-/Liveflow oder neues Workerprompt aus.

## 14 F1–F8-Mapping und vereinfachte Entscheidungen

| Finding | Status Autorenkorrektur | Begründung/aktueller Ort |
|---|---|---|
| F1 HOCH | **Erledigt (Dok)** | §3 und A1: Literal in OpenCode-Header, file: nur Tunnel; keine falsche File-backed-Abnahme. |
| F2 HOCH | **Supersediert/ersetzt** | #56/#57; §4/§5/A3: kein Manager-Subtask, keine D2/read-only-Reste oder Zusatzfreischaltung für Worker. |
| F3 HOCH | **Aus MVP supersediert; Folgeticket offen** | task_c9148add-9807-578f-ad25-3c689cfa133a muss komplettes Tunnelarbeitsverzeichnis/Secrets/Config/Healthsocket/Logs/Ownership/privilegierten Harness planen; keine bloße UID-Zusage. |
| F4 MITTEL | **Erledigt für bewusst kooperatives MVP; Härtung vertagt** | §3/§5/§11/A4/A13: behaupteter Caller/Zielcheck kein Identitätsnachweis, mögliche Missachtung/partial Audit, keine fingierten BLOCKED-Garantien. |
| F5 MITTEL | **Erledigt (Dok)** | §3 separates Inventar Bearer/API-Key/ID; hypothetischer externer Zweit-Bearer nur Folgeticket, local file revoke ≠ Remote-Keyrevocation. |
| F6 MITTEL | **Erledigt** | §9: Archivierung fachlich entschieden, Gittracking=no technisch begründet, keine erneuten Operatorfragen. |
| F7 NIEDRIG | **Erledigt/präzisiert** | §10: Queueauswahl technisch gesetzt; discussed≠gelöst, keine erfundene resolved-State-Capability, formale Abnahme nur mit Beleg. |
| F8 NIEDRIG | **Dok-Hygiene erledigt; Source-Altbefund unverändert** | Monotone Nummerierung/current C, Quellenstandindex §3/§16, alte Registry-r43/Bundler45-Beschreibung ausdrücklich Altbefund; kein unerlaubter Sourcefix. |

S1 teilweise vereinfacht übernommen: vollständige monitor_id für Pfad/Zuordnung; bestehender Registryrecord plus kleiner M-High-water-/Workerordinal für kurze Anzeige statt langer IDs oder neuem Register. S2/zweiter Listener nicht MVP: zusätzliche Port-/Lifecyclefläche ohne Bedarf bei kooperativem Ziel. MVP-Komplexität sinkt durch Wegfall W1-Isolation/Caller-/Toolaliaslisten/Manager-Subtask-Tests, nicht durch Aufgabe der Mission/Ownership/Context-/Attentionpflichten.

Historische D1–D8-Disposition: D1 zwei Adressaten kooperativ; D2/D4-Manager-Subtask-Regeln ersetzt; D3 keine neue Backgroundaktivierung/Workersteuerung; D5 kein nicht existentes orchestrate-Kommando mounten; D6 baseidentischen Self-MCP-Testfixturedefekt separat; D7 aus Scope; D8 Skillgrenzen konkret, harte Durchsetzung Folgeticket. Alte Q1b/Q1c-Wahlen keine MVP-Operatorfragen. Q6–Q8/alte S3–S7 markieren separate Hierarchie-/Pause-/VMRecovery-/Watchdog-Restarbeit aus damaliger Planung, kein stilles neues MVP-Go oder Pflichtgate für den hier überarbeiteten Skill-/Bindungs-/Attentionvertrag.

## 15 Verbleibende Nachweise und gezielte unabhängige Re-Review

**UNVERIFIED funktional:** tatsächlicher installierter Skill-/MCP-Preflight/Startup/Attach; modellseitige Geltungs-/Wake-/Aktionsmatrixbefolgung; Resultatdelta erreicht No-op-/Schedulerpfad; eigene Workerprofile-/Timeout-/Quota-/Compaction-/Sideeffect-Kette; Context-/Index-/Archiv-/Cleanup-Reconciliation nach echtem Reset; realer Auditumfang/Output- und Tunnel-Log-Secretfreiheit; Frischeziel; hosted ChatGPT-MCP-App Timer/Bridge/Rendering; Mac/Lima/Safari/VoiceOver und Langlauf. Operator bestätigt Live-Fallback läuft/in Main; das ist **keine** neue unabhängige vollständige Timeout/Quota-/Langzeit-Abnahme.

**Nicht aktive MVP-Gates, nur Folgeticket:** fremde Tunnel-UID-Machbarkeit, komplette File/proc/ptrace/sudo-Secretschutzkette, externe Zweit-Bearer-Klassen/Rollen-/Caller-Spoof-/Legacy-Revoke-Design. Manager-Subtask-Smoke ist obsolet durch #56/#57 und kein neuer Workerauftrag.

Keine verbliebene neue Fachentscheidung aus #52–#59. Technische offenen Implementierungsbelege später targeted klären; keine künstliche Operatorfrage über bereits entschiedene Archiv-/Naming-/Transportthemen. Autorenkorrektur beansprucht **kein Selbst-PASS**.

**Re-Review-Briefing:** unabhängigen ursprünglichen Bericht unverändert lesen, danach exakt übergebene aktuelle C/P/Hauptkonzeptrevision mit Journal #52–#59 abgleichen. Aktuelles tatsächlich konfiguriertes Reviewprofil frisch auflösen, catalog-/variant-/runtime-readbackprüfen; kein Alibaba, keine höhere Denkstufe aus Rollenname unterstellen; Autorenruntime nicht wechseln. Separater unabhängiger Reviewer, keine Review-Ausführung in diesem Auftrag.

Vier Achsen aus #52: (1) harte Widersprüche intern/Operatorleitplanken; (2) technische Lücken/ungesicherte Capabilities/Livebelege; (3) Fachabläufe/Grenzfälle/Abnahme; (4) konkrete einfachere Alternative mit gleichen Zielen/Grenzen. Focus: F1-Literal/Inventar, F2-Root-only-Manager/Workerfreiheit, F3/F4 keine obsolete Isolation-Gates, kooperative aktionsgenaue Grenzen ohne blanket Boardban, positive Mission/Wake/Autonomie versus Runtime, kurze Alias-/Receipt-Ownership, secure handover→Archive→Cleanup, Queue discussed≠gelöst und Browser versus Chat-Wake. Je Finding Stelle/Quelle/Auswirkung/Priorität/Belegstatus/konkrete Abhilfe. Review ohne Code-/Skill-/Livewrite, Tests, Sessions/Deploy oder eigene Findingsfixes; Outcome getrennt von Implementierungs-Go.

## 16 Historie, Integration und Erhaltung der Belege

Die vollständigen alten Texte sind über `8a6a7f0` (C/P) und `7e9fa90` (Hauptkonzept) am selben Pfad erhalten; keine alternative aktuelle Konzeptdatei erstellt. Historische Diagnose-/Operator-/Reviewtexte sind nicht rückwirkend geändert. Das folgende Register erhält die wesentlichen Entwicklungsergebnisse und Originalbelege:

| Stand | Historische Bedeutung / Beleg |
|---|---|
| `82332524…` → `4330c7d8b84dc8a0e0155ba5305ec44c084a3ed0` | A→B→C: History-limit-Fix, Final-Fallback-UI/MCP und Monitor-UX nach QC-Korrektur lokal integriert; damaliges Script 0.7.18 / Adapter 0.1.31. Details in bestehender `…-concept-plan-details.md` §§9–11. Kein Replay. |
| `3b9a66fa999318f06bb98d9322cb6f4edc02c372` | S1: Heartbeat-Pfad, Candidates-Budget/Vollständigkeit, Sessionlinks, guest-sicherer web_jq_inplace integriert. Details `…-concept-plan-details.md` §18. |
| `58de5fbd960dec0e0627ed90b925ec06654fc2d3` → `259454d3238e0bd6f1fdd5682f450e3484d86e5d` | S2 Priming/Wake+Activity-Diagnosefix; QC_FAIL F1 stale Rebind-Digest → korrigiert → QC_PASS `msg_11c4bc6e30010swpJb2oo2A2Ib` (SHA sichtbarer Revision `f2328172…`) → FF-Main. Tree `7e14f7e9fe67b8f48187ee9b48ab0e829794f371`, MCP-Pin `d42ed946…`, Hub `506a9895…`; damalige Adapter 204/202/0/2 und integrierte Regression im vorhandenen `…-concept-plan-details-s2.md` §2. Historische Prüfung, hier kein neuer Test. |
| `afc48926561f5b521c50e9dc3a73f5a242cf4262` | Separate RepoLive-Integration mit Exactcommit-QC; hosted Abnahme weiterhin getrennt. Kein Reimplementierungsauftrag. |
| `019d25649a1283d4413e891bb8983c48f6307e8f` | Separate task_fa86d673 Schema-4-Per-Profil-Fallback-Integration, Tree `c4067f86…`, Script 0.7.22/Adapter 0.1.34/Bundle r45; MCP `2e09e5d8…`, Hub `7842dc31…`; damaliger Reviewer `msg_11d56ef25001Gc0bz4EqgzvHCt`. Operator bestätigt installiert/live funktioniert; keine neue Fehlerkalibrierungsabnahme. |
| `f28898a783ded7f2c02cda5d340b9b43150bff9e` | Hostrepo-Sicherungscommit; `.opencode/tasks/RESUME-HANDOVER-20261009.md`. Aktuelle Reboot-Reconciliation: historisch zugesagter Share-Checkpoint ist nicht auffindbar; RESUME-REPORTS meldet MISSING, /tmp-Logs/Reprokopien nicht als wiederhergestellte Dateien behaupten. |
| `5ebd0d66c1c79756d605ba32e161f471cd9d733f` | P1-Kandidat, task/efbe63cf-skill-source-resume, Parent f28898; 2 Dateien; Script 0.7.23, 5 focused source-Mount-Fälle + release metadata/state damals grün. Noch keine unabhängige P1-QC/Mainintegration; hier unangetastet. Source-Altbefunde: r43 hardcodierter Loader-Test, `mcp_self_connection_test.py`-Helperfixture. |
| `25e23df` → `4c9529a` → `25f586f` → `dfe6aff` → `9307397` → `8a6a7f0` | Docs-only-Kontextpflege bis J51: Operatorfeedback, damalige Guard-/Token-/Subtask-Varianten, Attention und Lifecycle. Veraltete Varianten sind mit J52–59 ersetzt; dies erhält ihre Entstehung, nicht zwei aktuelle Policies. |
| `1bd025db4af99721027496b5dc84e0dd8de17c25` | Historischer nicht integrierter Pause/Resume-Kandidat, Q3-Vertrag unvollständig, kein blinder Merge. Alte S3–S7-Restarbeit nur auf eigenem Auftrag. |

Weitere unveränderte Historienpfade im selben taskbezogenen Namensraum: `…-concept-plan-details-management-execution.md` (Journal #15–#17/Q1feasibility, J13-Sandbox), `…-concept-plan-details-consolidation.md` (Journal #18–#25, S0–S7/Q1b/Q1c/Q6/Q7/Q8), `…-concept-plan-details-s2.md` (voller Re-QC/Integration), `…-concept-plan-details.md` (UX/Fallback/Pause/S1). Sie sind Quellen früherer Stände, keine konkurrierende aktuelle Regel. Die neuen normativen Abschnitte §2–§13 dieser P haben Vorrang für den aktuellen MVP-Plan.

Unabhängiger Reviewbericht bleibt unverändert, SHA-256 `2071d8f3b570c70681eef7e73d9072f013f5838065d9828ebc69a92fdbdd95e3`, Urteil ÜBERARBEITEN. Neue SHA-/Dokumentcommits im Abschlussreceipt; keine Secretwerte, keine zyklischen Dokument-Selbsthashes, keine Review-Freigabe durch Autor.

## 17 Synthesized Execution Contract — EFBE-MVP-IMPLEMENTATION-20261009-R1 (active)

Operatorfreigabe Journal #60: autonome Umsetzung des konsolidierten Management-MCP/Orchestrator-MVP bis unabhängig geprüft integrationsbereit; Optimistic MVP. Readiness msg_11e93a5ea001zhbYgoZy4gU4ik vollständig gelesen und revalidiert (main `1aba9e7f…`, 14 tracked/61 untracked/0 staged nur fremd, `opencode-vm.sh` identisch `f28898a`↔HEAD, P1-NOT-IN-MAIN, Runtime-Lock/PID 11677 einzige aktive Session, Monitor scheduler `false`, Writer-Pfad/Branch frei).

| Feld | Wert |
|---|---|
| phase/revision | **W1** aktiv; SYNTHESIS_REVISION EFBE-MVP-IMPLEMENTATION-20261009-R1; Phasenreihenfolge **P1→W1→W2→W4→W3→W5**, seriell, kein paralleler Wave-Go. |
| scope | W1-W5 nach §12/§13. W1 jetzt: Skill-/Priming-Regeln (Mission #59, zwei Adressaten, kooperative Aktionsmatrix §5, Root-only-Manager ohne native Subtasks #56/#57, serielle Managementführung, acht Wake-Pflichten #58, Autonomie- versus Modellprofile §6, Ownership/Receipt/Context/Lifecycle-Verweise §8–§10, G3-Regelfall, Restrisiko ohne Block-/Isolationsgarantien §2/§3). W2/3/4/5 noch nicht begonnen; künftige Capabilities nicht behaupten. |
| writer | alleiniger Produkt-Writer und kanonischer C/P-Publisher: diese Autor-Session (Build/`opencode`/`qwen3.8-flash`/`xhigh`, verifiziert; kein Runtime-/Profil-/Policywechsel durch Autor). |
| reviewer/dispatch | unabhängiger Reviewer getrennt `ses_ee19af651ffeLTL8BX4XnYvRFc`; externe Orchestrierung/Dispatch ausschließlich beim Operator; keine Selbstabnahme, keine Management-MCP-Selbstdispatches, keine neuen Worker/Subagenten durch Autor. |
| base/import | Writer-Worktree `.opencode-vm/worktrees/task_efbe63cf-mvp-impl`, Branch `task/efbe63cf-mvp-impl` auf Main `1aba9e7fcdc9286e724cf7323ee17d45932b2ef5`; **P1-Import** Cherry-Pick `5ef58d204d5f1f41711dcab92dfbe23bf5817daf` von `5ebd0d66c1c79756d605ba32e161f471cd9d733f` (2 Dateien, Script 0.7.23) — keine Reimplementierung, kein Main-Merge, kein Rerun. Vorleistungen `259454d3`/`019d2564`/`afc4892` bleiben importierte Ancestors, nicht erneut ausgeführt. |
| boundaries | **No** Main-Merge/Push/Tag/Release/Deploy/Hostinstallation/Live-Restart/Live-Config-/Monitor-/Profil-/Permission-/Archiv-/Cleanupaktion; keine Secret-/Credentialwerte in Ausgaben; fremde 14 tracked-modified + 61 untracked + alle übrigen Worktrees bleiben byte-/statusgleich; kein Reset/Stash/Stage fremder Änderungen; Produktwrites ausschließlich über explizite absolute Worktree-Pfade mit verifizierter Git-Zieländerung; C/P nur taskeeigene Dateipflege im canonical Mainroot (dort keine Produktwrites, keine alternative C/P-Autorität, keine Symlinks). |
| versionierung | nur kohärent nach realen Änderungen: Skillbundle `r45→r46` (Marker/Changelog/bundle.json/ZIP+SHA/`--check`), Scriptpatchregel durch P1-Import erfüllt (`0.7.22→0.7.23`, Tags v0.7.23), Adapterbump **0.1.34→0.1.35** nur wegen echtem Priming-Text-/Regelverhalten, Repin aus reproduzierbarem Doppelbuild; Hub/OpenLive ohne Änderung unverändert gepinnt; Publikation bleibt Operator-Gate. |
| acceptance | §13 A1–A14; W1-Szenarien A3/A4/A5 plus G3 explizit: Worker-`input_required` ⇒ nach tatsächlich vorliegender fachlicher Entscheidung im vorhandenen Profil/Scope normaler same-session Followup (Preconditions wie sonst auch); echte Operatorentscheidung ⇒ INPUT_REQUIRED-Eskalation; Pending-Security-Input niemals umgangen. Regelbefolgung bleibt kooperativ; Verstoß wird als Verstoß gemeldet, nicht als technisch verhindert. |
| repair budget | maximal **zwei** same-fingerprint Production-no-progress-Reparaturen; Reservierung bei Admission, A→B→A-/Modell-/Session-/Restart-Wechsel **setzen Zähler nie zurück**; management/read/docs/test/harness/infra-Arbeit zählt nie; dokumentierte Altfehler getrennt führen: `skills_orchestrator_test.sh` r43-Erwartung (durch echte Bundleänderung auf aktuellen Stand ziehbar, Basis bereits rot), `mcp_self_connection_test.py`-Helperfixture-Defekt (strikt separater Strand), Registrydescription-r43-Altbestand. |
| autonomy decisions | AUTONOMOUS_MVP_DECISION-Einträge in diesem Abschnitt mit PRE_DECISION_HEAD und Rücknahmepfad; keine künstlichen Detail-Go-Fragen für profilkonforme reversible technische Wahlen. |

```text
AUTONOMOUS_MVP_DECISION
decision_id=W1-D1-skill-reference-file; task/phase=efbe63cf W1; time=2026-10-09T03:00Z
strategy_source=Operator-J59/Freigabe J60; P §17 (dieser Contract)
question=neue Referenzdatei vs. Erweiterung monitor-tasks.md fuer interne Monitor-/Managerregeln
alternatives=monitor-tasks.md anreichern (vermischt externen Scheduler-Bootstrap mit internen Managerregeln); SKILL.md-only (sprengt lightweight-Einstieg)
choice/rationale=neues references/monitor-manager-rules.md plus ein SKILL.md-Referenzbullet und Querverweis monitor-tasks.md; kleinste additive, querschnittsfreie Variante
uncertainty=hosted Skill-Verhalten weiterhin UNVERIFIED; reversibility=Rücknahme per git revert der Bundle-/Dokucommits ohne Produktcode-/Adapterfolgen; Aufwand minimal
PRE_DECISION_HEAD=5ef58d204d5f1f41711dcab92dfbe23bf5817daf
worktree/owner=.opencode-vm/worktrees/task_efbe63cf-mvp-impl, task/efbe63cf-mvp-impl, Autor-Session
implementation_commits=0bc2fd8da413ff29e71b17e8f974514c3b016c6a (skill r46)
components=integrations/chatgpt/{bundle.json,latest.json,SKILL.md,CHANGELOG.md,references/{monitor-manager-rules.md,monitor-tasks.md,regression-scenarios.md}},skills/registry.json,tests/{chatgpt_skill_test.py,skills_orchestrator_test.sh},ZIP+sha256
tests/acceptance=build --check OK (inventory/ZIP/checksum r46); chatgpt_skill_test 85 OK; orchestrator-source 5/5; loader r46-marker pass bis Schritt 5 (bekanntes Helperfixture-Altproblem, main-root-identisch)
change_path=git revert 0bc2fd8 + Bundle-Rebuild r45; keine Adapter-/Skript-Kopplung
```

```text
AUTONOMOUS_MVP_DECISION
decision_id=W1-D2-priming-contract-bump; task/phase=efbe63cf W1; time=2026-10-09T03:00Z
strategy_source=Journal #56–#59; P §4/§5/§7
question=Priming-Text der Monitor-Engine auf Mission/Wake-/Root-only-Regeln aktualisieren und Contract mgmt-v1→mgmt-v2 heben
alternatives=Text austauschen ohne Contract-Bump (veraltete Primings blieben wirksam, stiller Regelversatz); volle W4-Wake-Mechanik jetzt (Scopevorgriff)
choice/rationale=buildPrimingBlock-Inhalt um Mission/zwei Adressaten/Aktionsmatrixkurz/Wake-Checkliste/Root-only+seriell/Autonomie-vs-Modellprofile/Restrisiko ohne Garantien ergänzen; PRIMING_CONTRACT mgmt-v2 nutzt bestehendes digest-gated Re-Priming einmalig automatisch aus; keine neue Digest-/Auditmechanik (W4)
uncertainty=modellseitige Befolgung UNVERIFIED; Re-Priming-Lebendnachweis W4; reverse=Rücknahme per git revert (alter Contractstring/Digest führt zu erneutem einmaligem Re-Priming)
PRE_DECISION_HEAD=5ef58d204d5f1f41711dcab92dfbe23bf5817daf
worktree/owner=wie oben
implementation_commits=a94b68eacfc8c264e9a937636a32e5550a910b7e (engine, adapter 0.1.35, Pin d8a98ad56f7c4d59b15965d482490560eb82cb1f9524b5e7183c2c3f53d690ff, AGENTS/MCP-INTERFACE)
components=adapters/mcp/src/{monitor-engine.ts,monitor.test.ts,types.ts},adapters/mcp/package{.json,-lock.json},opencode-vm.sh,AGENTS.md,docs/MCP-INTERFACE.md
tests/acceptance=Adapter-Suite 211: 209 pass/0 fail/2 bekannte Skips; Doppelbuild byteidentisch; mcp_adapter/install/monitor_service/release_metadata/release_state OK; bash -n/shellcheck(error) OK; Priming-Budget-Guard dokumentiert auf ≤5200 Zeichen (~1300 Tokens, einmalig pro Digest) erhöht statt der früheren ~330 — Mission/Mehrheit neuer Pflichten sind inhaltlich mandatiert, wiederholter Wake bleibt ≤1100
change_path=git revert a94b68e; Digest-Wechsel löst einmaliges Re-Priming auf alte Regeln aus; keine Daten-/Formatänderung
```

```text
AUTONOMOUS_MVP_DECISION
decision_id=W1-D3-registry-marker-coherence; task/phase=efbe63cf W1; time=2026-10-09T03:00Z
strategy_source=P §12 Versionskohärenzregel; reale Bundleänderung r46
question=skills/registry.json Orchestratorbeschreibung nennt fest r43 (Altbestand, bereits bei r45 falsch); Loader-/Source-Test erwartet r43
alternatives=erneut nur dokumentieren (nach echter r46-Änderung aktiv irreführend); dynamische Registryauflösung (überdimensioniert)
choice/rationale=Beschreibung auf revisionsfrei ("revision per integrations/chatgpt/bundle.json") und skills_orchestrator_test.sh r43-Referenzen auf die echte neue Bundle-Revision r46 ziehen; minimal, driftfrei, separater Commit hierfür; Basisaltfehler bleibt als solcher dokumentiert
uncertainty=none lokal; reverse git revert
PRE_DECISION_HEAD=5ef58d204d5f1f41711dcab92dfbe23bf5817daf
worktree/owner=wie oben
implementation_commits=0bc2fd8da413ff29e71b17e8f974514c3b016c6a (mit W1-D1)
components=skills/registry.json, tests/skills_orchestrator_test.sh
tests/acceptance=Schritte 1–4 grün (r46-Kohärenz); Schritt 5 scheitert am dokumentierten Helperfixture-Altproblem (web_jq_inplace nicht im extrahierten Subset) — in main-root byteidentisch reproduziert, bewusst nicht mitgezogen (D6 separat)
change_path=git revert der beiden Zeilen; keine Runtime-Auswirkung (Beschreibungstext)
```

**W1-Ergebnis (2026-10-09T05:40Z, superseded durch W1_QC_FAIL/Nachtrag unten):** Writer-Branch `task/efbe63cf-mvp-impl` = `a94b68eacfc8c264e9a937636a32e5550a910b7e` (Base `1aba9e7f…`, P1-Import `5ef58d20…`, Skill `0bc2fd8d…`, Engine `a94b68ea…`), Arbeitsbaum clean. Kanonisches Hauptkonzept-Update: Branch `task/efbe63cf-monitor-mcp-konzept` `df1ca005…`. Kein Main-Merge, kein Push/Release (Operator-Gates). **Nächster sequentieller Schritt W2:** Registry-Alias-/Owner-/Contextindex + G1-Speicherort (additive Root-Felder im bestehenden mkdir-Lock/CAS/rename-Vertrag) + G4-Managerkontext-Layout; A7/A8-Tests; erst nach unabhängiger W1-QC durch `ses_ee19af651ffe…` bzw. Operator-Freigabe. W1-Verifikation durch Autor ersetzt keine unabhängige QC; Modellbefolgung/Wake-Fortschritt bleiben UNVERIFIED bis W4/Abnahme.

**Nachtrag 2026-10-09T14:00Z — W1_QC_FAIL und W1-F1-Reparatur (aktueller Stand, ersetzt den 05:40Z-Autorenstand oben):** Der unabhängige Reviewer `ses_ee19af651ffeLTL8BX4XnYvRFc` bestätigte W1 am 09:58Z als **W1_QC_FAIL** (Receipt `msg_56f55029560f4439aa1161eb12f092d2` → Terminal `msg_120198411001P9jh96ICgNwzZu`, SHA-256 `a2c7fc0bdd8acccd43d44382c6fb3d1d3f000a91c1965af5907b74cf42797510`, 3155 B). Genau ein blockierendes Finding **W1-F1**: `a94b68e` nimmt `opencode-vm.sh` das Execute-Bit (`100755→100644`, einzige Modeänderung des Diffs), `install_test.sh` EXIT 1; `chmod +x` im Review-Isolat allein macht sie grün. **W1-F2** (Registry-Reformatierung fremder `commands`-Arrays in `0bc2fd8`) rein kosmetisch, kein Gate. Alle übrigen Flächen am `a94b68e` bereits unabhängig grün: Adapter 209/0/2, Skill 85, P1-Source 5/5, Doppelbuild-Pin `d8a98ad5…`. Bericht `…-w1-independent-review-20261009.md` (SHA-256 `2caa02da749b0a43f3ab38bd68c123c4531f0e685c4811f513e8d0c757e8dc65`) bleibt unverändert.

Nach VM-Reset (ursprüngliche Autorensession `ses_ee242a27fffezjq7kitLNoyGpc` `SESSION_NOT_FOUND`; Zwischenadmission `ses_edf147f5dffe7uzRDFk0II1eP7` endete 13:50Z mit leerer Assistant-Nachricht/Provider-Fehler ohne Write; Originale + Contract aus Reset-Handoff `task_083bc1b8` J1–2 gelesen, kein zweiter Master) reconcilierte die Ersatz-Autorensession (EFBE-W1-RESET-RECOVERY-FIX1-20261009-1348) read-only: Branch `task/efbe63cf-mvp-impl` auf `a94b68e`/Tree `0f8c1497` intakt, `opencode-vm.sh` `100644`/Blob `d7b0ef40`, kein Folgecommit, kein fremder Owner, kein bestehender Fix/Konflikt; Worktree sweeps-bedingt aus überlebendem Branch re-etabliert. **Erste W1-F1-Reparatur (mode-only, taskrein):** ein Folgecommit `d2b5a1b49166ac684c101af9509fbbdead58e5a5` (Parent `a94b68e`, neuer Tree `a386127e3690420fa897a43c3674d399a4e65255`), `opencode-vm.sh` `100755`, Blob byte-identisch `d7b0ef40…`; Diff ausschließlich Modus, kein weiterer Tree-Eintrag geändert, kein W1-F2/Fremdfixture mitgezogen. Isolierter `git archive`-Export: `a94b68e` `install_test.sh` EXIT 1 → `d2b5a1b` EXIT 0; Mode/Commit/Tree/Blob verifiziert; `bash -n` OK. Fremdinventar erhalten: 14 tracked-modified + 62 untracked (61 historisch + Reviewbericht), 0 staged. Runtime/Policy Build + Execution rev61 `opencode/deepseek-v4-flash/high`; Journal-frei beabsichtigt. Produktions-No-Progress-Zähler max 2 über Reset/Runtime erhalten, Doku/Read/Test ausgenommen. **Nächster Schritt FIXED_READY_FOR_INDEPENDENT_REQC:** unabhängige Re-QC exakt `d2b5a1b`/Tree `a386127e` (Modus-/Install-/Blob-Check genügt), danach W2→W4→W3→W5. Kein Main-Merge/Push/Tag/Release/Live-Aktion; W2 nicht gestartet.

**Nachtrag 2026-10-09T14:14Z — W1_REQC_PASS und W2-Umsetzung (aktueller Stand):** Der unabhängige Re-QC `ses_edf07a6e0fferQF9lnwg9pyvnK` (Receipt `msg_753113a077d444e0a31366a82aa0b419` → Terminal `msg_120fbfbdb001odM8XDJ9fyy0Tp`, SHA-256 `305beed6738f6c3f86167c37eb84630822b1bdfddac9ed0f9a32777a71e2f94c`, 1625 B) bestätigte **W1_REQC_PASS** auf `d2b5a1b`/Tree `a386127e`; W1-F1 geschlossen. Die Ersatz-Autorensession (W2, Execution rev63 `opencode/deepseek-v4.1-flash/low`) hat darauf den W2-Kandidaten umgesetzt.

**W2-Kandidat:** `f1644ce0dc26c140636e65b5cd8d5835e8182fc5` / Tree `2683f647b399242feded97cfc75a79d181ba93cb` (Parent `d2b5a1b…`, Base-Tree `a386127e…`) auf `task/efbe63cf-mvp-impl`, Arbeitsbaum clean; 8 Dateien, +601/−17 (`monitor.ts`, `monitor.test.ts`, `tools.ts`, `types.ts`, `package.json`, `package-lock.json`, `opencode-vm.sh`, `AGENTS.md`). Inhalte nach §8/§9 (G1/G4): additive Identitäts-/Ownermetadaten auf dem bestehenden mkdir-Lock/Generation-CAS/rename (kein Zweitstore, keine ungelockten Registry-Writes) — monotones Registry-`alias_high_water`, per-Monitor `worker_high_water`/Workerrecords (Owner/Creator-Session, Runtime-Referenz, Creation-/Dispatch-Receipt, Scope/Worktree, optional Task, Context-Pfad, Lifecycle, letzte Synthese); `reserveWorker` reserviert Alias+Contextpfad vor nicht-idempotentem Create; `confirmWorkerCreation`/`reconcileWorkerCreate`/`reuseWorker`/`rebindWorker`/`setWorkerLifecycle`/`setWorkerSynthesis` bewahren volle Evidenz hinter kurzen Aliassen; fremde Worker per Key verweigert (known-vs-foreign); tasklose Worker ohne Boardticket bzw. erfundenen MCP-Dokumentservice; Manager-/Worker-Kontexte unter ignoriertem `.opencode-vm/monitor/workers/<monitor_id>/<worker_key>.md` (`manager.md`). Monitor-Create vergibt den Manager-Alias. Alias = kooperative Identität, keine authentifizierte Caller-Isolation; bestehende Permissions/Auth unverändert.

**Version/Pin:** Adapter `0.1.35→0.1.36`, Repin aus zwei byte-identischen GNU-tar-Builds `532c91f1485b273c412db1a5a4fd17fda1bc56eda701175198c4775f29007a7e`; Script `0.7.23→0.7.24`, Tags `MCP_ADAPTER_TAG`/`HUB_ASSET_TAG`/`OPENLIVE_ADAPTER_TAG` = `v0.7.24`; `ADAPTER_VERSION`/package(-lock) kohärent; AGENTS auf 0.1.36. **Tests (Author):** Adapter-Suite 215 → **213 pass/0 fail/2 bekannte Skips** (Basis 209/0/2 + 4 neue W2-Tests, A7/A8); `install_test.sh` EXIT0 (Exec-Bit erhalten); `mcp_adapter_test.sh` EXIT0 (Tar-SHA = Pin); `release_metadata_test` 5 OK; `release_state_test` 5 OK; `monitor_service_test.sh` EXIT0; `bash -n` + `shellcheck --severity=error` sauber. Fremdstand erhalten: Main `c08bfa7`, 14 tracked-modified/63 untracked, 0 staged. **Nächster Schritt W2_IMPLEMENTED_PENDING_QC:** unabhängige QC exakt `f1644ce0`/Tree `2683f647`, danach W4→W3→W5. Kein Main-Merge/Push/Tag/Release/Live-Aktion; W4 nicht gestartet.

```text
AUTONOMOUS_MVP_DECISION
decision_id=W2-D1-additive-schema1-identity; task/phase=efbe63cf W2; time=2026-10-09T14:10Z
strategy_source=P §8/§9 G1; ADR-ähnliche bounded choice
question=neue Identitätsfelder als Schema-Bump (2) mit Migration vs. additiv-optionale Felder auf Schema 1
alternatives=Schema-2-Bump (zwingt Migration/Reparatur bestehender Registries, mehr Risiko); separater Zweitstore (explizit verboten)
choice/rationale=additiv-optionale Felder (registry.alias_high_water, monitor.alias/worker_high_water/workers) mit Validierung nur wenn vorhanden; alte Registries bleiben lesbar, keine Migration
uncertainty=spätere Phasen können bei Bedarf einen Bump beschließen; reversibility=git revert des Commits; Aufwand minimal
PRE_DECISION_HEAD=d2b5a1b49166ac684c101af9509fbbdead58e5a5
worktree/owner=.opencode-vm/worktrees/task_efbe63cf-mvp-impl, task/efbe63cf-mvp-impl
implementation_commits=f1644ce0dc26c140636e65b5cd8d5835e8182fc5
components=adapters/mcp/src/{monitor.ts,monitor.test.ts,tools.ts}
tests/acceptance=Adapter 215 (213/0/2); W2-A7/A8-Tests in monitor.test.ts
change_path=git revert f1644ce
```

```text
AUTONOMOUS_MVP_DECISION
decision_id=W2-D2-identity-in-existing-module; task/phase=efbe63cf W2; time=2026-10-09T14:10Z
strategy_source=P §8/§9; Release-/Build-Kohärenz
question=neue Datei monitor-workers.ts + build-script-Kopie vs. Erweiterung des bereits veröffentlichten monitor.ts
alternatives=neue Datei (zusätzliche Release-Kopierliste/build-mcp-adapter.sh-Änderung, mehr Kopplung); Erweiterung monitor.ts
choice/rationale=alles in monitor.ts/monitor.test.ts (bereits im Release-Tar bzw. Testlauf), damit keine Build-Skript-Änderung nötig ist; kleinster kohärenter Fußabdruck
uncertainty=none lokal; reversibility=git revert; Aufwand minimal
PRE_DECISION_HEAD=d2b5a1b49166ac684c101af9509fbbdead58e5a5
worktree/owner=wie oben
implementation_commits=f1644ce0dc26c140636e65b5cd8d5835e8182fc5
components=adapters/mcp/src/monitor.ts (nur)
tests/acceptance=Adapter 215 grün; keine Build-Skript-Änderung
change_path=git revert f1644ce
```

```text
AUTONOMOUS_MVP_DECISION
decision_id=W2-D3-no-new-tool-surface; task/phase=efbe63cf W2; time=2026-10-09T14:10Z
strategy_source=P §8/§9; YAGNI/POLA
question=neue MCP-Tools für Worker/Alias vs. interne Source-APIs ohne Oberflächenänderung
alternatives=neue Tools + Output-Schema-Änderung (kein belegter Konsument, bricht strikte Schemata); interne exportierte APIs + Manager-Alias bei create
choice/rationale=keine neuen Tools/Tool-Output-Felder (Tool-Output-Schemata bleiben unverändert); die Metadaten-APIs sind die gelockten Source-APIs; Monitor-Create nutzt `ensureManagerAlias`
uncertainty=spätere Phase (W4/W5) kann bei echtem Konsumenten eine Oberfläche ergänzen; reversibility=git revert
PRE_DECISION_HEAD=d2b5a1b49166ac684c101af9509fbbdead58e5a5
worktree/owner=wie oben
implementation_commits=f1644ce0dc26c140636e65b5cd8d5835e8182fc5
components=adapters/mcp/src/{monitor.ts,tools.ts}
tests/acceptance=Adapter 215 grün; Tool-Schemata unverändert
change_path=git revert f1644ce
```

**Nachtrag 2026-10-09T14:32Z — W2_QC_PASS und W4-Umsetzung (aktueller Stand):** Der unabhängige W2-QC `ses_edf07a6e0fferQF9lnwg9pyvnK` (Receipt `msg_1563810d3dc64430b8afa51d0ee5212d` → Terminal `msg_1210c89d0001I8VguD6bpzOhq0`, SHA-256 `8c475f8340aad1ad8827c26bd882becea662a05a73895d37baf85a4a1ab8475b`, 2245 B) bestätigte **W2_QC_PASS** auf `f1644ce`/Tree `2683f647`; W2-F1 (kein Produktionskonsument) und W2-F2 (kein Tool-level-Alias-Test) waren nichtblockierend und für W4 verbindlich.

**W4-Kandidat:** `64c9a832fa4707deae597c5e9ec95ef6eea8b910` / Tree `05f195aa89057e8489624af2bba835f759faf478` (Parent `f1644ce…`) auf `task/efbe63cf-mvp-impl`, clean; 11 Dateien, +529/−18. **W2-F1-Konsumenten-Verdrahtung:** additive MCP-Oberfläche `create_monitor_worker` (Reserve-vor-Create über `reserveWorker`, Confirm über `confirmWorkerCreation` nach beobachteter Antwort), `list_monitor_workers` (begrenzte Index-Read), `update_monitor_worker` (reconcile_created/absent, reuse, rebind, idle, archive, synthesis) — alle über die gelockten W2-Helfer; fremde Worker per Key verweigert; unsichere Create bleibt `reserved` und wird reconciled, nie blind wiederholt; tasklose Worker ohne Boardticket. **W4-Wake-Fortschritt:** die Engine faltet `workerIndexDigest` in die No-op-Prüfung und trägt den begrenzten Worker-Index in den Wake-Prompt, sodass ein Worker-Creation-/Receipt-/Lifecycle-/Synthesis-Delta einen begrenzten Wake auslöst statt unchanged-status-Schleife (Cadence/Config unverändert). **Minimaler Audit:** tatsächliche metadata-only Management-Toolaufrufe ergänzen begrenzte Monitor-History-Einträge (Tool/Ziel/Outcome/Zeit; keine Rohargumente/Secrets; Identität declared/unknown). **W2-F2:** Tool-level-Test belegt `create_monitor`→M1/M2 + `created`-Detail-Alias plus vollen Worker-Lebenszyklus.

**Version/Pin:** Adapter `0.1.36→0.1.37`, Repin `d48ac3f54ea48e5c7b400e7eaa45e77ec8c72607550a81aee5cc83db686a069a` (zwei byte-identische GNU-tar-Builds); Script `0.7.24→0.7.25`, Tags `v0.7.25`; AGENTS 0.1.37/44 Tools; docs/MCP-INTERFACE Worker-Abschnitt. **Tests:** Adapter 217 → **215 pass/0 fail/2 bekannte Skips**; install/mcp_adapter/monitor_service EXIT0; release_metadata/release_state 5 OK; bash -n/shellcheck sauber. Fremdstand: Main `80c2227`, 14/64/0; `task_053e2e55` `aa2bd96` unberührt.

**Offen/nicht in diesem Slice (ehrlich):** die ursprüngliche W4-Fläche „binding preflight/Doctor/start-attach/standalone honesty" (P §3 U1/U2/U4/U5/U6/U7; `/experimental/tool/ids` kein MCP-Client-Inventar; connected nur mit geladenem Skill + gelisteten Management-Tools) ist im Script nicht vorhanden und nicht implementiert; ebenso keine neue mgmt-v2-Re-Priming-Änderung (bestehendes digest-gated Re-Priming unverändert; Re-Priming-Lebendnachweis bleibt UNVERIFIED). W4-D3 (W2) „keine neuen Tools" war W2-Scope; W4 ergänzt bewusst die kleine begrenzte Oberfläche gemäß W2-F1.

**Nächster Schritt W4_IMPLEMENTED_PENDING_QC:** unabhängige QC exakt `64c9a83`/Tree `05f195aa`, danach W3→W5. Kein Main-Merge/Push/Tag/Release/Live-Aktion; W3 nicht gestartet.

```text
AUTONOMOUS_MVP_DECISION
decision_id=W4-D1-worker-consumer-surface; task/phase=efbe63cf W4; time=2026-10-09T14:30Z
strategy_source=W2-QC W2-F1-Anforderung; P §8/§9; YAGNI
question=W2-Worker-Metadaten konsumierbar machen: additiv begrenzte MCP-Oberfläche vs. Engine-Auto-Create vs. breite Plattform
alternatives=Engine erzeugt selbst Worker (vermischt Manager-/Workersession, kein realer Managerpfad); größere Oberfläche (verboten); path-only (W2-QC blockiert)
choice/rationale=drei begrenzte Tools (create/list/update) auf den vorhandenen gelockten Helfern; realer Manager-ruft-MCP-Pfad; keine neue Security/Trust-Schicht
uncertainty=Skill-Nutzung/Konsumentenverhalten bleibt UNVERIFIED; reversibility=git revert; Aufwand minimal
PRE_DECISION_HEAD=f1644ce0dc26c140636e65b5cd8d5835e8182fc5
worktree/owner=.opencode-vm/worktrees/task_efbe63cf-mvp-impl, task/efbe63cf-mvp-impl
implementation_commits=64c9a832fa4707deae597c5e9ec95ef6eea8b910
components=adapters/mcp/src/{tools.ts,monitor.ts}
tests/acceptance=Adapter 217 (215/0/2); http.test Worker-Lebenszyklus + W2-F2
change_path=git revert 64c9a83
```

```text
AUTONOMOUS_MVP_DECISION
decision_id=W4-D2-worker-delta-wake; task/phase=efbe63cf W4; time=2026-10-09T14:30Z
strategy_source=P §7 Wake-Vertrag; W4 „receipt/result-delta wake progress"
question=Worker-Delta erreicht den Manager: No-op-Digest um Worker-Index erweitern vs. neuer Timer/Subscription
alternatives=separate Completion-Subscription/Timer (nicht belegt, neue Mechanik); Worker-Delta ignorieren (unchanged-status-Schleife)
choice/rationale=begrenzter `workerIndexDigest` in die bestehende No-op-Prüfung + Worker-Index im Wake-Prompt; Cadence/Config unverändert, keine neue Subscription
uncertainty=echter Live-Wake-Fortschritt UNVERIFIED; reversibility=git revert; Aufwand minimal
PRE_DECISION_HEAD=f1644ce0dc26c140636e65b5cd8d5835e8182fc5
worktree/owner=wie oben
implementation_commits=64c9a832fa4707deae597c5e9ec95ef6eea8b910
components=adapters/mcp/src/{monitor.ts,monitor-engine.ts}
tests/acceptance=monitor.test W4-Wake: Worker-Delta → dispatched, danach noop-unchanged
change_path=git revert 64c9a83
```

```text
AUTONOMOUS_MVP_DECISION
decision_id=W4-D3-defer-preflight-honesty; task/phase=efbe63cf W4; time=2026-10-09T14:30Z
strategy_source=P §3 Bindungsdiagnose; bounded slice
question=„binding preflight/Doctor/start-attach/standalone honesty" jetzt implementieren vs. als Rest-scope ausweisen
alternatives=neue Preflight-Mechanik ohne Live-/VM-Beleg (breit, nicht isoliert verifizierbar); ehrlich als nicht implementiert ausweisen
choice/rationale=im Script existiert keine solche Preflightfläche; kein halbfertiger, unbelegter Claim; Rest-scope offen benannt für Freigabe/QC
uncertainty=Rest-scope bleibt offen; reversibility=kein Code (nur Dokument); Aufwand--
PRE_DECISION_HEAD=f1644ce0dc26c140636e65b5cd8d5835e8182fc5
worktree/owner=wie oben
implementation_commits=keine (bewusst ausgewiesen)
components=keine
tests/acceptance=keine
change_path=n/a
```

