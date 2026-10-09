Task-ID: task_efbe63cf-53da-5e79-be25-f7ac8efe9916
Title: Management-MCP-Bindung und Orchestrator – aktueller Wiederaufnahmekontext
Status: CONCEPT_REVISED_RE_REVIEW_PENDING; kein Implementierungs-Go
Last-updated: 2026-10-09T01:29:55Z
Konzeptrevision: EFBE-MVP-COOPERATIVE-J59-R1

## Aktueller Auftrag und maßgebliche Dokumente

Nur bestehende task-eigene Konzept-/P-/C-Dokumentation überarbeiten, Review F1–F8 und Journal #52–#59 tatsächlich einarbeiten. Keine Feature-/Skill-/MCP-/Policy-/UID-/Token-/Permissionänderung, Tests, Live-Mutation, Worker/Subagents, Deploy oder laufende Session-/Dateibereinigung. Autorenruntime vom Operator GPT-6.1 Sol über OpenCode Zen/high gewählt; kein Alibaba, kein eigener Profilwechsel.

P (kanonischer Design-/Entscheidungs-/Testplan): `planning/task-concepts/task_efbe63cf-53da-5e79-be25-f7ac8efe9916-concept-plan.md`.
Hauptkonzept: `.opencode-vm/worktrees/task_efbe63cf-monitor-mcp-konzept/planning/task-concepts/task_efbe63cf-53da-5e79-be25-f7ac8efe9916-monitor-mcp-konzept.md`.
Gesicherter Hauptkonzeptstand: `c7c630a5f00c4f6e83954f448d40cb025c9b3b8f`, SHA-256 `455617cf8a276b1c9c1aa9e7cf0a2769b253b05f49a06520df2122cde87e73f6` (Doku-only, keine Main-Produktintegration).
Review (unverändert): `planning/task-concepts/task_efbe63cf-53da-5e79-be25-f7ac8efe9916-final-concept-review-20261009.md`, SHA-256 `2071d8f3b570c70681eef7e73d9072f013f5838065d9828ebc69a92fdbdd95e3`, Urteil **ÜBERARBEITEN**, kein Autoren-PASS.
Journal: `.opencode-vm/taskboard/management-journal/task_efbe63cf-53da-5e79-be25-f7ac8efe9916.jsonl`; maßgeblich gelesen #52–#59, zuletzt #59 `0c07a7a8-0456-424c-b02d-fe00bb604c00`. Keine Journal-/Boardmutation hier.

## Verbindlicher Current-Stand

- **Mission:** Entwicklung innerhalb eingestelltem Autonomieprofil aktiv bis vereinbartes Ergebnis treiben; zulässige Entscheidungen selbst treffen, eigene Worker betreuen, Hindernisse bearbeiten, nächste Schritte veranlassen – kein reiner Statusloop.
- **MVP kooperativ (#54/#55):** verbindliche Skillgrenzen, externe Auth unverändert. Keine harte interne/externe Zwei-Token-/UID-Isolation, Caller-/Aliaslisten-/Spoof-Hardblocks oder technische BLOCKED-Garantien. Modell kann Regeln missachten; Audit nur tatsächliche Managementänderungen/erkennbare Verstöße, Rollenangaben unknown/declared wenn nicht authentifiziert.
- **Zwei Adressaten:** extern beauftragte Operator-/ChatGPT-Orchestrierung; intern ausdrücklich eingesetzte OpenCode-Monitore/Manager. Gewöhnliche Implementierungssessions nutzen Management-MCP nicht. Gemeinsame technische Toolsichtbarkeit beweist keine Befugnis.
- **Manager nie native Subtasks (#56/#57):** auch keine read-only-Recherche. Serielle Managementführung über frische eigene oder belegbar eigene wiederverwendete Root-Worker; fremde Sessions nicht übernehmen. Worker entscheiden selbst über Subtasks im vorhandenen Auftrag/Scope/Permissions, keine neue Freischaltung/Mikrosteuerung.
- **Eigene Steuerung verboten:** Monitor-/Autonomie-/Runtime-/Expiry-/Scheduler-/Approval-/Freigabe-/Management-/Taskboard-Tooldaten nicht selbst ändern; keine Taskanlage/Umplanung/Taskflut oder Eigenautorisierung. Zulässig: Reads, Originalprüfung, eigener Context/Journal, append-only nicht autorisierende Notizen/Ergebnisbelege, eigene Workersteuerung/konfigurierter Fallback, echte INPUT_REQUIRED-Eskalation/Parken. Parken ändert Scheduler nicht. Keine pauschale Board-Lese-/Notizsperre.
- **Wake (#58):** Context/Index laden → tatsächliche Zustände/Receipts/Uncertain abgleichen → Originalresultate prüfen und Key Findings laufend synthetisieren → Fehler/Blocker/Fallback/Sideeffects bearbeiten → nächste erlaubte Schritte seriell beauftragen/echte Entscheidungen eskalieren → endgültige eigene Worker sicher archivieren/Contextfiles abräumen → Resumecontext/Journal/Index readbackpflegen. Keine Doppelaufträge oder erfundene Completion-Subscription.
- **Autonomie getrennt von Modellprofil:** conservative/sandbox/mvp/yolo aus bestehenden Verträgen konkret erklärt (P §6); Execution/Standard/Deep/Design/Review aus aktueller Policy+Readback sind Arbeitstyp-/Runtimeprofile, keine Autonomie/Leistungsrangfolge. Eigenes Monitorprofil bleibt Operatorbereich.
- **Kurzkennung:** M1/M1-A plus kurzer Inhalt; volle monitor/worker/session IDs im Hintergrund. Minimaler Alias-/Workerordinal im bestehenden Registry-Lock/CAS-Vertrag, volle monitor_id als Pfadbasis; Titel ≠ Auth. Keine Live-Renames.
- **Context/Lifecycle:** eigene hostprojektpersistente Worker-Contextdatei ohne neues Boardticket; Git-Tracking=no technische Entscheidung. Kontinuierliche Synthese nach Schritten/Ergebnissen, auch bei Reuse. Abschluss entschieden: sichere Übernahme/readback → idle/no-pending/no-uncertain → archive bestätigt → exakt eigene Contextdatei abräumen, Dauerbelege behalten. Reset: ID/Receipts/Effects prüfen, ggf. frische eigene Runtime aus erhaltenem Context, kein Blind-Replay.
- **Attention:** vorhandene RepoLive-Karten/Queue/Polling wiederverwenden. Neu/Offen, Taskbezug/Grund/Entscheidung, stale/Disconnected/Replay/Dedup ehrlich. `discussed`/Rendern/Delivery-ACK ≠ fachlich gelöst; letzteres nur kanonischer Entscheidungs-/Resultatbeleg. Planziel ca. 10 s sichtbar/35 s hidden, Erkennung/Preparation/UI getrennt messen; hosted ChatGPT-App bleibt UNVERIFIED. Keine Webhook-/Chat-Wake-Aktivierung.

## Ist-Belege, Reviewbehandlung und sichere Fortsetzung

**F1/F5 korrigiert:** MCP-Bearer wird als **Klartextliteral** in OpenCode-MCP-Headerconfig geschrieben; file:-Referenzen nur in Tunnel-Headermaps. MCP-Bearer, OpenAI-Tunnel-API-Key und Tunnel-ID strikt getrennt (P §3). Share ist VM-/Projektruntime-Konfiguration, keine belegte per-OpenCode-Chat-MCP-Isolation. Gleiches UID/default-allow/privilegierte Shell ≠ harte Secret-/Callertrennung.
**F2 ersetzt:** eine rollenspezifische Regel, kein Manager-Subtask, kein D2/read-only-Rest. **F3/F4-Isolationsarchitektur zurückgestellt:** task_c9148add-9807-578f-ad25-3c689cfa133a; kein MVP-Gate, keine Umsetzung hier. **F6/F7 geschlossen:** Archiv entschieden/Gittracking technisch; Queueauswahl gesetzt, diskutiert/gelöst nicht verwechselt. **F8 bereinigt:** monotone aktuelle Nummerierung/Quellenstandindex; Registry-r43/Bundler45 bleibt dokumentierter Source-Altbefund, kein heimlicher Fix.

Vorleistungen bleiben getrennt: A→B→C `4330c7d8`, S1 `3b9a66fa`, S2 QC_PASS+Main `259454d3238e0bd6f1fdd5682f450e3484d86e5d`; Schema-4-Fallback separat `019d25649a1283d4413e891bb8983c48f6307e8f`; Sicherungscommit `f28898a`. Operator bestätigt Fallback installiert/live/in Main – **keine** neue unabhängige vollständige Timeout/Quota-/Langzeitprüfung. P §16 erhält Historie/Receipts/Test-/Pinbelege. Historischer Share-Checkpoint und /tmp-Logs nicht als heute vorhanden behaupten.

P1-Kandidat `5ebd0d66c1c79756d605ba32e161f471cd9d733f`, Branch `task/efbe63cf-skill-source-resume`, Script 0.7.23; fehlt noch unabhängige QC/Mainintegration, hier nicht erneut ausgeführt. Bekannte baseidentische Self-MCP-Helperfixture-/r43-Loadertest-/Registrydescription-Altbefunde getrennt. Keine Behauptung installiertes System bereits mgmt-v2.

Historie: vollständige vorherige C/P am selben Pfad unter Main `8a6a7f0`; Hauptkonzept vollständig in Historiensnapshot `7e9fa907c10b3b48fc9c82ba3f892cd846721127` (SHA `4e1d3efb…`, 87.320 B). Aktuelle Schreibziele: C/P Mainroot, Hauptkonzept bestehender task/efbe63cf-monitor-mcp-konzept-Worktree; fremde dirty unberührt. Keine alternative Hauptdatei.

**Nächster Schritt:** gezielte unabhängige Konzept-Re-Review gemäß P §15 auf exakt übergebener neuer Commit-/SHA-Revision, vorhandenen Bericht und #52–#59 lesen; vier Achsen Widersprüche/technische Lücken/Fachabläufe/Vereinfachung. Aktuelles Reviewprofil separat auflösen, kein Alibaba, keine Autoren-Selbstabnahme. Review oder zukünftige W1–W5-Umsetzung hier nicht starten.

**UNVERIFIED:** aktuelle reale Skill-/MCP-Bindung, Modell-Regelbefolgung/Wakefortschritt, Worker-/Fallback-/Compaction-/Sideeffect-Kette, Context-/Archive-/Cleanup-Resetpfad, Audit-/Log-Secretfreiheit, Frischeziel und hosted/Native/Langlauf. Harte UID-/proc-/Zweit-Token-/Caller-/Spoof-/Migrationsnachweise nur Folgeticket, kein MVP-Gate. Keine neue echte Fachfrage aus #52–#59; fehlende technische Belege später gezielt prüfen.
