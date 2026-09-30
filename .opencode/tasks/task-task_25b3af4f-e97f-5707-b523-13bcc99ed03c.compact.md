Task-ID: task_25b3af4f-e97f-5707-b523-13bcc99ed03c
Title: OpenCode VM – agent-managed Sessions non-interactive betreiben, lokale Git-Arbeit erlauben, Remote-Push sperren
Last-updated: 2026-09-30T23:56:44+02:00
Implementation-state: full-scope-locally-implementation-complete; implementation-committed; external-acceptance-separate

## Concept Plan

Kanonischer Detailplan: `planning/task-concepts/task_25b3af4f-e97f-5707-b523-13bcc99ed03c-concept-plan.md`.

## Aktueller Auftrag

- Neuer Auftrag autorisiert den vollständigen Scope einschließlich Produktcode, dauerhafter Tests, lokaler Builds/Pakete und sinnvoller lokaler Commits. Kein Push/Remote-Credential/Release/Deployment/externe Infrastruktur oder Boardmutation.
- Implementationcommit: 4d3c37ae58511e84e801d78c289bfe2157859e7b — feat: enforce agent-managed work across MCP A2A and OpenLive. 52 task-owned Source-/Test-/Dokument-/Paketdateien; historische Spikefiles jetzt tracked, keine untracked Implementierungsabhängigkeit. Diese C/P-Abschlussdoku folgt als eigener lokaler Dokumentcommit.
- Operatorentscheidungen vom 2026-09-30 sind kanonisch in Plan §17; §§7–14 und §16 wurden entsprechend reconciliert. Frühere Forderungen nach einer zweiten externen Sicherheitsgrenze sind abgelöst.

## Geschlossene Produktentscheidungen

1. **Klassifikation durch tatsächlichen agentischen Work-WRITE-Ingress.** Jeder unterstützte Backendpfad erzeugt/adoptiert die Arbeits-Session automatisch serverseitig: neue Arbeits-Session und Fortsetzung bestehender Session, mindestens MCP; A2A/OpenLive/weitere tatsächliche Work-Writes im Integrationsinventar erfassen. Keine Client-/Skillparameter oder wiederholt mitzusendende Managed-Flags.
2. **READ und reine Managementoperationen klassifizieren niemals um**, auch nicht wegen eines generell WRITE-fähigen Clients. Manuelle Sessions bleiben bis zum tatsächlichen agentischen Work-WRITE manual. Session-/Boardreads, Rename/Archive/Modellverwaltung, Attachment-Staging oder bloßes Call-Binding sind kein Arbeits-Prompt; agentische Worksession-Creation ist dagegen ein Klassifikationstrigger.
3. **Children vor erstem Workprompt automatisch managed.** Neue/reused Kinder eines Managed-Workstreams erhalten Backendadoption/Policy vor Ausführung, auch bei bisher manueller Parentlinie; Scope-/Project-/Busy-/Pendinggrenzen bleiben bindend. Managed bleibt sticky über UI-Betrachtung/Reuse/Neustart/Transportabschaltung.
4. **Primäre harte Grenze ist das VM-Design:** keine GitHub-/Origincredentials und kein konfigurierter schreibfähiger Operatororigin im Guest. Credentials sowie Operatorprojekt-/Originsteuerung liegen auf Host/Operatorseite. OpenCode-Push-/Equivalentwrite-Deny ist Defense-in-Depth und explizite Verhaltenspolicy, kein Ersatz dieser Grenze. Invariante: **local repo autonomy; remote write operator-only**.
5. **Non-interactive und lokale Commits:** keine direkten fachlichen Question-/UI-Prompts. Fehlende Entscheidung führt zu normalem terminalem INPUT_REQUIRED mit Frage/Kontext/Optionen; Orchestrator klärt in Voice/Chat und liefert normalen Follow-up derselben Session. Lokale Git-Arbeit/Commits ohne Bestätigung innerhalb Taskscope. Unabhängige echte Securitypermissions werden nicht blanket-autoapproved.

## Relevante Spike-Evidence (historischer Nachweis, neu eingeordnet)

- 25 Live-/synthetische Fälle gegen OpenCode **1.18.33 V1**, Git **2.43.0** bestanden; `/tmp/opencode/managed-v1-xald85fe/report.json`: completed, null tatsächliche Remote-Writes, Fixture-Refs unverändert. Echte Commits nur Disposable; keine Credentials/Pushes/Releases/Tags.
- Native V1 Always-Allow überstimmt Session-Deny. Früher Executionguard verweigert 13 erkannte direkte Writeformen ohne Ask; lokale Commits und lokale Bare-Fixture-Fetch/ls-remote funktionieren.
- Hidden Question wird zu invalid repariert; tools-Reexposure erreicht ohne Guard Pending, mit Guard null Asked/Pending. Synthetischer terminaler Handback/Folgeturn funktioniert, gewöhnlicher Toolfehler allein erzwingt aber keinen terminalen Turn.
- Native PATCH metadata ersetzt Map, PATCH permission hängt an, Prompt-tools ersetzt Rules. Neustart bewahrt State. Neue Children erben Denies, keinen Marker/Commit-Allow; Reuse und manuelle Childlinie benötigen explizite Backendadoption. Session-Allow kann Agent-Deny überstimmen.
- Tatsächliche Fixture-Instructions: global → Root → explizit; Subdir nach Read. Shell-Committext lässt sich konditional ersetzen, tool.definition hat keine sessionID. Produkt-Co-Plugin-/VM-AGENTS-Komposition noch zu verifizieren.
- REST-Shell/Skript/HTTP-/Marker-Canaries zeigen Grenzen der **OpenCode-Schicht allein**. Sie widerlegen nicht die credential-/writable-originfreie VM und lösen keinen zusätzlichen Broker-/Firewall-/allgemeinen Netzwerkblockadeauftrag aus.
- Spike-Dateien `tests/agent-managed-v1-spike/` werden task-owned als ausdrücklich historische Charakterisierung mit eingecheckt. Kein Produkt-/Maintainedtestimport; dauerhafte Infrastruktur/Szenarien in tests/helpers/managed_runtime.py und tests/managed_*. Alte G3-Interpretation durch Plan §17 abgelöst.

## Implementierter lokaler Stand

- Aktuelle Implementierungsbaseline HEAD 7406030 (r21+Header+ACH-1), ursprüngliche Metadaten 0.6.6 / MCP 0.1.20 / OpenLive 0.1.6 / Skill r23. Fremde d994-Contextnotiz und alte dist-/Taskleftovers werden nicht übernommen.
- Gemeinsamer Kern in runtime/managed-{core,policy}.mjs: plugin-owned Unixadoption, persistenter Backendstate unabhängig von nativer Metadata, idempotente native Ruleupdates, synchroner Child-/Reusepreflight, sessionaware Instructions und früher Remote-Deny. runtime/a2a-managed.py ist der persistente repository-owned Launcher; keine site-packages-Datei editiert.
- Kontrollierter Handback vor SDK-Tooldispatch am echten Provider-/Runnerstream: Question wird normaler terminaler Text, echter Runner speichert finish:stop/idle. Keine Aborts/DB-Finish-Manipulation/Replies/fake Userturns. Modellstep bounded 8 MiB; Managedtext nach Stepende statt tokenweise, manual unverändert. Chat/Responses/Anthropic real getestet, Google-Protokoll unitgeprüft; echte Anbieter-/OAuth-/Websocket-/Host-/Voiceabnahme separat.
- MCP Creation/Send/Supersede, OpenLive Workcreation/Workprompt und A2A Creation/Send/Context/Preferred/prompt_async/command angebunden. Manager/plain attach/READs/Management neutral. Kinder neu/reused/manual-lineage sowie aktivierte Backgroundcontinuation synchron vorbereitet; unabhängige Securityasks und expliziter Scope bleiben erhalten.
- Direkter Native-REST-Shellpfad wird vor Spawn über exakt korrelierten gespeicherten running Call geprüft. Gitoptionen/Wrapper/Aliases/Plumbing/LFS/erkanntes Forgepublishing no-Ask denied; normale lokale Gitops, Childcommit/Branch/Tag/Restore und erlaubte Fetch/ls-remote geprüft. Kein echter Remote-Push/Credentialimport.
- Fresh/Attach installieren denselben Payload; Standalone enthält deterministische eingebettete Bytes (kein neuer Offline-/Manualdownload), MCP-Artefakt enthält Sources zusätzlich. Root/VM/Shell/System/Voiceinstructions reconciliert; r24 unterscheidet Businessreport von echter Permission.
- Lokale Metadaten: Script 0.6.7 / MCP 0.1.21 / OpenLive 0.1.7 / Skill 2026-09-30-r24. Pins passen zu Doppelbuilds: MCP f6cba660… / OpenLive 39a50c51…; Skill 79039404…. Keine Veröffentlichung/Deployment/Boardmutation.

## Tests / Evidence

- MCP Typecheck/Build + gesamte Suite mit Taskboard 0.6.0: 104 PASS / 0 FAIL / 0 SKIP; r21/Header/ACH-1 erhalten. Gepinnte reale MCP-Integration OpenCode 1.18.21 PASS; disposable Board/MCP-Smoke 0.1.21 / 1.18.33 PASS.
- OpenLive Typecheck/Build 47 PASS; native Managertool-Integration 1.18.21 und packaged TLS/Remote-roundtrip PASS; tatsächliche 1.18.33 Workcreation/-continuation im neuen Ingressharness PASS.
- Neue Policyunits 4, A2Ahooks 2, Lifecycle/Source-/Embedded-Standaloneparität 3 PASS. Echte 1.18.33 Chat/Responses/Anthropic-Gates für terminalen Loopstop/Folgeturn, no Questions, Gitautonomie/Scope, Drift/Restart/Child/Background/Always-Allow/Hierarchie PASS. Echte A2A 1.2.0 service creation/context/preferred/prompt_async/command PASS.
- AgentControl 39, Hub 9, Launcher 4 + DOM 8 PASS; Launcherproxy 1 PASS/1 bestehender Opt-in SKIP, Editor 18 PASS/1 bestehender Live-SKIP + Extension PASS. Skill 17, Release Metadata/State 5+5 PASS.
- MCP-Adapter-/Lock-/Tunnel-, OpenLive-/Install-/Besprechung-Lifecycle PASS; Bash syntax, ShellCheck error level, actionlint, diff --check und eingebetteter Payloadcheck PASS. Fixture-/Buildrawdaten in /tmp/opencode/ocvm-managed-* und managed-{mcp,openlive}-{a,b}.tar, VM-ephemer.

## CI-Nachkorrektur: Python-unabhängiger Payloadcheck

- CI-Fehler auf Basis `da0cb55af87271c3cd8199d6f5fe96536185b81f` lokal reproduziert: Builder `--check` bestand mit Python 3.13.15, scheiterte mit Python 3.12.3. Die entpackten Tar-/Runtimebytes sind exakt gleich; nur GZIP-Headerbyte 9 unterscheidet sich (`255` vs. Unix `3`) durch `gzip.compress(mtime=0)` auf Python 3.11/3.12.
- `scripts/build-managed-runtime.py` erzeugt nun mit `gzip.GzipFile(filename="", compresslevel=9, mtime=0)` den kanonischen Header. Bereits eingebetteter Payload bleibt byteidentisch; `opencode-vm.sh`, Runtime-Sources und Version/Pins bleiben unverändert. Komprimierter Payload-SHA-256 auf beiden Interpretern: `ba3d46993087110b5f61afb79f361b3c3f2f8d43787ac366e5e0bfa6c94b113e`.
- Maintained Lifecycle-Suite um zwei Builderregressionen erweitert: altes GZIP-OS-Verhalten simulieren, exakte Bytes/Member/Metadata, read-only Check, echte Source-Drift verweigern und idempotent regenerieren. Suite **5 PASS** jeweils mit Python 3.12.3 und 3.13.15; Builder `--check` auf beiden PASS; Policy **4 PASS**, A2A-Hooks **2 PASS**, actionlint und diff --check PASS.
- CI-Pathfilter nimmt den Builder selbst auf. Fix, Regressionen und dieser Context werden als taskbegrenzter lokaler Commit festgehalten; der GitHub-Lauf wurde hier nicht manuell gestartet. Kein Push/Release/Deployment, Runtime-/Connectorrestart oder Boardwrite. Keine Konzept-/Policyänderung, daher P unverändert.

## Release-Vorbereitung v0.7.0

- Nutzer hat Version `0.7.0` als Releasekandidat freigegeben. `OCVM_VERSION` und die drei gemeinsamen Release-Tags stehen auf `0.7.0` / `v0.7.0`; adapter package/code versions bleiben getrennt und unverändert bei OpenLive `0.1.7` und MCP `0.1.21`, da deren Runtimecode nicht geändert wurde.
- Alle drei bestehenden Adapter/Hub-Archive wurden je zweimal reproduzierbar gebaut; SHA blieb identisch zu den Pins (OpenLive `39a50c51…`, MCP `f6cba660…`, Hub `2ef95615…`). Paketversionen/Dateinamen bleiben unverändert, da kein Adapterverhalten geändert wurde.
- Adapter checks/builds/unit/integration suites bestanden mit unveränderten Paketversionen. Nach Script-Tag-/Versionsanpassung: `release_metadata_test.py` 5/5, `release_state_test.py` 5/5, Agent Control 39/39, Web Editor 18 pass/1 existing opt-in skip, launcher proxy 1 pass/1 existing skip, extension 1/1, launcher DOM 8/8, actionlint, ShellCheck error-level, Bash syntax und Managed-Runtime-Checks unter Python 3.12/3.13 grün.
- `.github/workflows/release.yml` remains the mechanism that creates `v0.7.0` and publishes assets after the operator's later push. No local tag was created; no push/manual CI/release/deployment/restart was run. This is only a local candidate commit. Task-P is unchanged because there was no concept change; Board remains `in_progress`.

## Entscheidungslage / Readiness

- **Keine blockierende Produktentscheidung offen.** G1 ist Defense-in-Depth-Implementierung/Verifikation; G2 ist Umsetzung des festgelegten Non-interactive-Vertrags; G3 ist Abnahme des gewählten credential-/originfreien VM-Vertrags, keine externe-Enforcementmodell-Auswahl.
- Keine technische Scopeportion wegen neuer Entscheidung geparkt. Lokal implementiert/geprüft; reale macOS/Lima-/Hostcredential-/Origin-/Provider-/Hosted-/Voiceabnahme separat, nicht aus synthetischen Daten ableiten. Aktive Produktionssession/Connector unverändert; neue Policy erst bei normalem späteren Start/Attach/Restart.
- Userorigin-Fetchausweitung oder ausdrücklicher managed → manual Downgrade wären spätere optionale Scopeentscheidungen, keine Voraussetzungen dieses Tasks. Bestehende Defaults gelten.
- Produktimplementation bleibt lokal abgeschlossen. Fremde Todo-/disposable C/P und alte untracked `dist/`-Archive bleiben unangetastet. Nächster Operator-Schritt ist ein späterer Push des Releasecandidate gemäß bestehendem Prozess; erst GitHub Actions erstellt Tag/Release. Reale Host-/Provider-/Hosted-/Voice-Akzeptanz ist separat und kein manueller Release-Schritt dieses Auftrags.

## Pflege / Evidence

Plan §17 enthält Operatorentscheidungen; §12 den aktualisierten Integrationsablauf, §13 Acceptance, §16 die historisch belegten Spike-Findings mit korrigierter Einordnung. Ausführliche Raw-/Probe-Evidence bleibt referenziert; Board bleibt Outcome/Scope.

Compact Context kurz halten: Ziel ca. 5k Tokens, Warnung ab ca. 7.5k, vor ca. 10k verdichten; niemals splitten. Concept Plan: Ziel ca. 20k, Warnung ab ca. 30k, Split erst bei Bedarf ab ca. 40k mit Task-ID-Detaildokumenten und kanonischem Hauptindex.
