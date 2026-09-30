Task-ID: task_ac329f45-aa82-5c86-825a-6205aac38ee1
Title: Orchestrator – Task-Dokument-Header vor Registrierung verlässlich validieren
Status: active
Last-concept-update: 2026-09-30T07:09:34+02:00

## 1. Ausgangslage und Ziel
Quelle des Scopes ist die übermittelte Originalboard-Beschreibung: Beim realen RaspiBlitz-Flow `todo` → `in_progress` meldete der Agent richtige Task-ID und geprüfte Dateien, dennoch scheiterte `register_task_document` für beide Rollen mit `TASK_DOCUMENT_MISMATCH`. Die historischen Dateibytes liegen dieser Initialisierung nicht vor; eine konkrete damalige Formatursache ist deshalb nicht bewiesen.

Ziel ist eine verlässliche exakte Headerform plus tatsächliche Evidence vor Registrierung. Generisch ist die erste Zeile `Task-ID: <stable_task_id>`, wobei der Platzhalter durch die exakte stabile Board-ID ersetzt wird. Für diesen Task lautet die gesamte erste Zeile:

```text
Task-ID: task_ac329f45-aa82-5c86-825a-6205aac38ee1
```

Die Codeblockdarstellung hier ist Erläuterung; in den tatsächlichen Dateien steht die Zeile als Plaintext an Byteanfang, ohne Markdownheading, Backticks, Einrückung, Leerzeile davor, BOM oder alternative Schreibweise. Genau ein Leerzeichen folgt auf den Doppelpunkt; keine zusätzlichen Leerzeichen an der Zeile. Neu erstellte Dokumente verwenden UTF-8 und LF. Der bestehende Adapter akzeptiert LF oder CRLF; diese Kompatibilität wird nicht unnötig verändert.

## 2. Autorisierung und Arbeitsisolation
**Aktuelle Integrationsfreigabe:** Header-Quellcommit `13694bd6400eee8c07fadc44c3849a484b50d406` manuell auf bestaetigter konsolidierter main/r21-Basis `39f975ad0b693c2841cb4aa4fa82c2f3a10da24d` integrieren, relevante kombinierte Regression und genau einen lokalen Commit ausfuehren. Die folgenden isolierten Arbeitsstandsangaben sind historische Evidence, keine aktuelle main-Sperre. Fremde Taskdateien, agent-managed-Spike, dist-Buildausgaben und r21-SHA-Nachtrag sind explizit ausgeschlossen. Keine Remote-Writes/Tags/Releases/Deployments/Connector-Restarts oder produktiven Boardmutationen. Konzeptentscheidungen bleiben unveraendert; `Last-concept-update` wird nicht fuer reine Integrations-/Testevidence neu gesetzt.

Historischer isolierter Auftrag: kleinste Produktumsetzung auf isolierter Basis, Tests, Artefaktpflege und ein lokaler Quellcommit. Manager berichtete beide Rollen available und Board `in_progress`; Worker schrieb keinen Boardstatus. Damals erhielt main nur C/P-Spiegel. Diese Ausfuehrungsgrenze wurde fuer die jetzige konsolidierte Integration durch die Freigabe oben ersetzt.

Eigener detached Worktree `/tmp/opencode/header-night-20260930` ab `6d2efdeeed5fc4faf8b4b8b1df929a3d39a8acab`, bei Anlage sauber und vor Produktarbeit nur C/P neu; tracked/staged Diffs leer. Hauptcheckout auf `main` mit 29 fremden tracked r21/Taskboard-Änderungen erhält nur diese zwei taskeigenen Dokumente als Spiegel. Fremde Produktdiffs werden nicht kopiert, gestasht, zurückgesetzt oder committed. ACH1-Worktree und Worker `ses_f0fb4cbaeffeZSJDgIC9fKG778` werden nicht verwendet oder unterbrochen.

Keine Remote-Git-Writes, Tags, Releases, Deployments, Credentialeinrichtung oder Änderung einer Produkt-/Sicherheitsgrenze. Vollständiges atomisches r20-Follow-through ist außerhalb dieses Tasks.

## 3. Dokumentvertrag und Akzeptanz
- C (`compact_context`): `.opencode/tasks/task-task_ac329f45-aa82-5c86-825a-6205aac38ee1.compact.md`. Erste drei Zeilen: exakte Task-ID, `Title: Orchestrator – Task-Dokument-Header vor Registrierung verlässlich validieren`, `Last-updated: <ISO8601 mit Offset>`.
- P (`concept_plan`): `planning/task-concepts/task_ac329f45-aa82-5c86-825a-6205aac38ee1-concept-plan.md`. Erste vier Zeilen: exakte Task-ID, identischer Title, aktueller Konzeptstatus (jetzt `active`), `Last-concept-update: <ISO8601 mit Offset>`.
- Agent liest vor Arbeit bestehende Dateien und ihre Identität. Matching Dokumente werden wiederverwendet; abweichende Task-ID am erwarteten Pfad wird niemals überschrieben/umbenannt. Kollisionsmeldung und ausdrückliche Pfadentscheidung sind erforderlich.
- Vor `CONCEPT_READY` liest der Agent die tatsächlichen ersten Zeilen und Metadaten beider Dateien zurück und gibt sie im Terminal mit Rolle und tatsächlichem Pfad aus. Schreibabsicht, Promptreceipt, Timestamp oder „geprüft“ sind kein Ersatz für die Evidence.
- Manager prüft das korrelierte Ergebnis, registriert beide Rollen und bestätigt per Readback je `available`, den richtigen project-relativen Pfad und aktuelle Revision (SHA-256 soweit geliefert). Erst danach darf der Boardmove erfolgen; dessen Status wird separat zurückgelesen.
- Jede fehlende Datei, falscher Pfad, unlesbare/unbeschreibbare Datei oder Mismatch wird präzise gemeldet. Bei Registrierungsmismatch bleibt Board `todo`; weder ein erfolgreiches Einzelbinding noch ein lokal guter Header autorisiert den Move.

## 4. Aktuelle Orte und beobachteter Basisstand
Die folgenden Orte wurden im sauberen Basisworktree read-only geprüft:
- `adapters/mcp/package.json`: Adapter 0.1.17; Build/Check/Test-Scripts vorhanden.
- `adapters/mcp/src/taskboard.ts`: `registerDocument` (ab Zeile 273) validiert Pfad und ruft vor Sidecar-Publikation `documentBytes`; `getDocuments` (307) liefert `available`, SHA-256 und Revision; `readDocument` (326) liest registrierte Rollen revisionsgebunden.
- Gemeinsames `documentBytes` (361–412) prüft project-relative erlaubte Pfade, reguläre Dateien, Symlinkgrenzen, UTF-8, Größe und Read-Stabilität. Zeilen 407–408 verlangen den exakten Präfix mit LF/CRLF, sonst `TASK_DOCUMENT_MISMATCH`. Die Meldung „belongs to another task“ differenziert derzeit falsche ID und falsches Headerformat nicht.
- `adapters/mcp/src/tools.ts`: Schemas/Handler für `register_task_document`, `get_task_documents`, `read_task_document`; `src/types.ts`: bestehende Dokumentfehlercodes.
- `adapters/mcp/src/taskboard.test.ts`: vorhandene Dokumentregistrierung/Reads, falsche Task-ID, missing, unsafe paths, UTF-8 und Revisionen. `src/http.test.ts`: bestehende dokumentbezogene Transportfälle.
- `integrations/chatgpt/opencode-session-orchestrator/references/task-concept-plan.md`: Headerbeispiel sowie Initialisierungssequenz ab Abschnitt „Mandatory initialization on todo -> in_progress“; fordert Identitätsprüfung, aber dort noch keine explizite Terminal-Evidence beider tatsächlichen ersten Zeilen.
- `references/task-compact-context.md`: Header-/Pflegevertrag für C; `references/board-workflow.md`: geordnete Transition/Recovery; `references/regression-scenarios.md`: Ort für synthetische Workflowfälle. Hauptquelle `SKILL.md` und `tests/chatgpt_skill_test.py` sind Integrations-/Paketprüforte für die spätere Umsetzung.
- Paketpflege: `integrations/chatgpt/bundle.json`, `CHANGELOG.md`, `scripts/build-chatgpt-skill.py`, ZIP/SHA-256 und `latest.json` nach geltenden Repo-Vorgaben konsistent aktualisieren, falls der Skill geändert wird.

Fachliche Abhängigkeit: Hauptcheckout-AGENTS beschreibt fremden Adapter 0.1.18/Skill r21 mit `add_task_document_bindings` (gemeinsame Prevalidation beider Rollen, additive Konfliktregeln, exakte Replay-Revalidation) und verfügbarkeits-/pfad-/revisionsgebundenem Readback. Dieser Bundle-Stand und `references/initialization-follow-through.md` sind auf HEAD nicht vorhanden. Die spätere Integration muss auf dem freigegebenen r21-Stand reconciliieren; er darf nicht aus dem dirty Checkout in diesen Task kopiert oder als hier implementiert/testbestanden ausgegeben werden. Die Headerregel selbst benötigt fachlich keine neue Bundle-API.

## 5. Umgesetzter kleinster Scope und Entscheidungen
1. Bestehende Skillanweisungen zur C/P-Erstellung präzisieren: vollständige Plaintext-Erstzeile exakt, unerlaubte Varianten benennen, beide realen Header/Metadaten unter ihren Rollen und Pfaden vor Ready zurücklesen und als Evidence liefern. Workflow bleibt generisch über `stable_task_id`, keine fest verdrahtete Task-ID im Produkt.
2. Bestehende Ordered-Recovery-Anweisung auf Headerfehler konkretisieren: `todo` halten; Pfad/Datei/Identität diagnostizieren; nur sicher taskeigene Dateien minimal am selben Pfad reparieren; Header erneut sichtbar lesen; Registration erneut durchführen; beide Rollen `available` mit Pfad/Revision verifizieren; erst dann Move und Statusreadback.
3. Regressionen ergänzen, die richtigen Header, falsche ID und falsches Format unterscheiden und den Recovery-/No-early-move-Vertrag abdecken. Bestehende gemeinsame Adapterprüfung wird wiederverwendet.
4. Die bisherige Meldung „belongs to another task“ war bei Formatschäden tatsächlich irreführend. Umgesetzt ist deshalb die kleinste Klarstellung im bestehenden `ProjectBoardService.documentBytes`: derselbe Fehlercode `TASK_DOCUMENT_MISMATCH`, versuchter erlaubter Pfad und exakte erwartete Erstzeile, ID **oder** Headerformat als Ursache. Keine neue Fehlerhierarchie, Metadatenform oder Änderung der Path-/Sicherheitsregeln.

Entscheidung vom 2026-09-30: Keine zusätzliche Klassifikation durch einen zweiten Parser. Die bestehende gemeinsame Akzeptanzprüfung bleibt identisch; eine neutrale präzise Fehlermeldung plus Inspektion der echten Erstzeile trennt die Recoveryfälle, ohne Formatfehler als fremde Besitzerschaft zu behaupten. Ein kanonischer fremder Header wird nicht automatisch korrigiert, sondern erfordert `INPUT_REQUIRED`.

Entscheidung zum optionalen Vorabvalidator: Default ist kein neues Tool und keine duplizierte Parserlogik. Ein read-only Vorabvalidator kommt nur infrage, wenn dieselbe bestehende `documentBytes`-Logik vor Registrierung wiederverwendet werden kann und einen belegten Flowvorteil bringt. Er ersetzt niemals die Registrierung und das frische `available`-Readback; eine Vorabprüfung kann spätere Dateiänderungen nicht ausschließen. Aktuell reicht der kleinste dokumentierte Workflowfix, daher keine Validator-Implementierung geplant.

## 6. Diagnose und Recovery-Design
| Beobachtung | Diagnose / nächster Schritt | Board-Gate |
| --- | --- | --- |
| Datei am erwarteten erlaubten Pfad fehlt | `TASK_DOCUMENT_MISSING`; exakten erwarteten Pfad nennen, autorisierte Erstellung oder Wiederherstellung | `todo` |
| Falscher/unerlaubter Pfad, Rolle oder unsicheres Dateiziel | `TASK_DOCUMENT_PATH_INVALID`; Rolle und project-relative Pfadentscheidung prüfen, keine Pfadgrenzen umgehen | `todo` |
| Datei existiert unter anderem erlaubten Pfad | Nicht als Headerfehler ausgeben; erwarteter Pfad fehlt. Bestehende Binding-/Pfadentscheidung klären | `todo` |
| Task-ID stimmt nicht | `TASK_DOCUMENT_MISMATCH`; fremde Identität nicht überschreiben, `INPUT_REQUIRED` für Pfad-/Zuordnungsentscheidung | `todo` |
| Sicher taskzugeordnete Datei hat Heading/Backticks/Spacing/anderes Label | Headerformat-Mismatch; minimal tatsächliche Erstzeile korrigieren, Evidence erneuern | `todo` |
| Binding fehlt oder kollidiert | `TASK_DOCUMENT_REF_NOT_FOUND` / `TASK_DOCUMENT_CONFLICT`; bestehende Referenzen prüfen, nicht blind retargeten | `todo` |
| Datei nicht les-/schreibbar oder während Read verändert | Zugriffsproblem exakt melden bzw. neuen vollständigen Read beginnen; keine Erfolgsaussage | `todo` |

Recovery führt keine Neuerstellung eines zweiten Tasks und keine alternativen Ersatzdokumente ein. Korrektur derselben Dateien ist nur bei gesicherter Taskzuordnung autorisiert. Ist C gebunden und P scheitert im Register-Fallback, bleibt C erhalten, Board `todo`; P korrigieren und danach beide Rollen gemeinsam zurücklesen. Bei verfügbarem r21-Bundle dessen additive Prevalidation nutzen; Tool-Fallback nur bei tatsächlicher Abwesenheit, nicht nach fachlichem Fehler. Bei fehlgeschlagenem späterem Boardmove bleiben gute Dateien/Bindings erhalten und werden reconciliiert.

## 7. Test- und Akzeptanzmatrix
| Fall | Erwartung |
| --- | --- |
| Exakter Header mit LF, kompatibler CRLF-Fall | Registration + `available`/Revision erfolgreich für C/P |
| Andere synthetische stabile Task-ID | Mismatch, kein frühes Binding/Move; keine Überschreibung fremder Identität |
| Heading, Backticks, anderes Label, zusätzliche/fehlende Leerzeichen, Leerzeile vor Header | Mismatch, Board `todo`; einzelne Varianten synthetisch prüfen |
| Fehlende Datei vs erlaubter aber falscher Pfad vs unerlaubter Rollenpfad | Diagnose unterscheidet missing von path-invalid und header-mismatch |
| C korrekt, P falsch; dann Korrektur derselben P-Datei | Erstes Ergebnis hält `todo`; frische Evidence → Registration → beide `available` → Move → Statusreadback |
| Agent meldet nur „Header geprüft“ ohne echte Zeilen | Kein `CONCEPT_READY`-/Transition-Gate-Pass |
| Gute lokale Evidence, Registration-/Readbackfehler oder geänderte Revision | Keine Transition; Reconcile bzw. erneuter Read |

Gezielte Prüforte: `taskboard.test.ts` für gemeinsame bestehende Headerprüfung/Recovery, nur nötige `http.test.ts`-Vertragsfälle; `references/regression-scenarios.md` und `tests/chatgpt_skill_test.py` für Skill-Evidence und Fail-closed-Recovery. Statische Paketprüfungen ersetzen keine echte Orchestrator-/Hosted-Verhaltensakzeptanz; synthetischen Boardstatusverlauf explizit beobachten, nicht aus Adapter-Erfolg ableiten.

Diese Matrix wurde lokal umgesetzt: Zwei funktionale Adaptertests betreiben echte Dokumentdateien und den Service mit synthetischem Board. Zwanzig negative Rollen/Header-Kombinationen (fremde ID, Heading, inline/fenced Backticks, anderes Label, fehlendes/doppeltes/führendes/abschließendes Space, führende Leerzeile) verändern weder Dateien noch Bindings und halten `todo`. Der Recoverytest bewahrt den Body und das gute C, korrigiert dieselbe P-Datei, registriert erneut, prüft auch einen späteren Headerwechsel bei Readback, verlangt beide available/Pfade und SHA-256/Revision gegen die tatsächlichen Dateibytes und führt erst dann einen Move mit getrenntem Statusreadback aus. LF/CRLF bleiben kompatibel.

Die Skilltests prüfen den statischen Anweisungsvertrag einschließlich Ablehnung von Agent-success ohne Evidence, tatsächlicher Agentenabschluss-Zeilen, foreign-ID/INPUT_REQUIRED und Same-file-Recovery-Reihenfolge. Dies ist kein automatischer Lauf eines Hosted-Orchestrators und keine neue technische Boardmove-Sperre im Adapter. Die synthetische Reihenfolge ist ausführbar geprüft; ihr Befolgen durch ein Hosted-Modell bleibt extern offen.

## 8. Offene Punkte, Übergabe und Pflege
- r21-Reconciliation ist jetzt abgeschlossen; §10 dokumentiert die aktuelle kombinierte lokale Abnahme. Hosted-/RaspiBlitz-Evidence bleibt getrennt und unverifiziert; historische Isolation-/Versions-/Testangaben in §9 ersetzen diese aktuelle Evidence nicht.
- Manager hat nach eigener Meldung beide Dokumente registriert/available samt Revisionen und den Task `in_progress` zurückgelesen; Worker führt keinen Move aus.
- Der isolierte Quellstand bleibt erhalten; die freigegebene Integration auf konsolidiertem main/r21 ist gemaess §10 lokal abgeschlossen. Fremde Diffs wurden nicht uebernommen.
- Historischen RaspiBlitz-Header nur bei verfügbarer Original-Evidence präzise zuordnen; andernfalls synthetische Reproduktion als solche kennzeichnen.
- C ist aktuelle kurze Arbeitszustandsdatei (~5k Tokens Ziel/~7.5k Warnung/vor ~10k verdichten, niemals splitten). P ist kanonisches Requirements-/Design-/Entscheidungs-/Implementierungs-/Testkonzept (~20k/~30k/~40k, nötigenfalls task-ID-Details mit Hauptindex). Beide bleiben deutlich unter ihren Schwellen.
- Vor neuer Arbeit beide Dokumente/Task-IDs read; C nach substanziellen Phasen, P bei echten Konzeptbefunden aktualisieren. Board enthält den Outcome/Scope, Sessionresultate die Evidence; keine duplizierte Chronologie.

## 9. Lokale Validierung, Artefakt-/Git-Evidence und verbleibende Akzeptanz
Dieser Abschnitt dokumentiert den historischen isolierten Quellcommit, einschließlich seiner damaligen Versionskollisionen und offenen r21-Integration. Aktuelle kombinierte Ergebnisse und Versionen stehen in §10.

Implementierung auf der freigegebenen Basis ist lokal vollständig. Änderungen: Skill plus vier Workflowreferenzen und Changelog; gemeinsame Adapterfehlermeldung plus zwei Regressiontests; statischer Skillvertrag; erforderliche Versions-/Pin-/Bundlepflege und zugehörige Metadatentests; C/P. Kein Vorabtool, keine Produkt-/Sicherheits-/Board-Admissionsemantik hinzugefügt.

Ausgeführte Befehle (jeweils eigener Worktree; npm im Unterordner `adapters/mcp`):
- `npm ci --ignore-scripts`: PASS, 98 Pakete, 0 gemeldete Vulnerabilities.
- Erstes `npm run check && npm test`: FAIL im Check, TS2339 auf union-typisiertem `revision`/`sha256` im neuen Recoverytest; Testlauf noch nicht gestartet. Durch explizite `available`-Typprüfung behoben, keine Änderung an Produktsemantik.
- Wiederholung `npm run check && npm test`: PASS. Originalsummary: `tests 93`, `pass 91`, `fail 0`, `cancelled 0`, `skipped 2`, `todo 0`. Enthält HTTP-, Header-/Recovery-, Content-/Runtime- und restliche Adaptertests.
- Nach Erweiterung des Recoverytests um veränderte Header bei Readback und unabhängige SHA-Prüfung: `npm run check && npm run build && node --test --test-reporter=spec dist/taskboard.test.js`: PASS. Originalsummary: `tests 10`, `pass 8`, `fail 0`, `cancelled 0`, `skipped 2`, `todo 0`.
- `python3 -B scripts/build-chatgpt-skill.py`: PASS; ZIP gebaut. `python3 -B scripts/build-chatgpt-skill.py --check`: PASS, inventory/ZIP/checksum/latest konsistent. `python3 -B tests/chatgpt_skill_test.py`: PASS, `Ran 14 tests`, `OK`.
- `bash scripts/build-mcp-adapter.sh /tmp/opencode/header-mcp-a.tar` und entsprechender `header-mcp-b.tar`: PASS; `cmp /tmp/opencode/header-mcp-a.tar /tmp/opencode/header-mcp-b.tar`: PASS, byte-identisch.
- `python3 -B tests/release_metadata_test.py`: PASS, `Ran 5 tests`, `OK`.
- `bash -n opencode-vm.sh tests/mcp_adapter_test.sh` und `shellcheck --severity=error opencode-vm.sh tests/mcp_adapter_test.sh`: PASS.
- `bash tests/mcp_adapter_test.sh`: PASS, Originalabschluss `All MCP adapter lifecycle tests passed.` einschließlich gebautem Archiv gegen Script-Pin/Manifest/Production-only-Inhalt. Die gemeldeten Killed-Prozesse gehören zum expliziten bounded Shutdown-Test; Suite erfolgreich.
- `git diff --check`: PASS; Produktdiff/Status und letzte zehn Commit-Subjects vor Commit reviewed. Einzelner lokaler Commit/abschließender Status werden mit SHA/Subject im korrelierten Originalabschluss zurückgelesen; C/P sind Teil dieses Commits.

Die zwei SKIPs sind vorhandene unabhängige `pinned upstream binary`-Fälle (Writer-Prozesskonkurrenz und Multi-Project-Reclassification), deren optionales Binary-Fixture nicht aktiviert ist. Keine Header-/Recovery-Pflichtprüfung ist übersprungen; keine offenen lokalen Pflichtfehler und keine fremden Testfehler repariert. Die anfängliche Arbeitsverzeichnis-Vorabprüfung vor npm wurde mit korrigiertem ls-Pfad wiederholt; sie hatte keine Installation/Tests ausgeführt.

Lokale Versionswerte aus dieser isolierten Fortschreibung: Script `0.6.4`, Adapter `0.1.18`, Skill `2026-09-30-r20`. Sie sind keine Veröffentlichung und kein Nachweis identischen Inhalts mit dem fremden r21-/Adapter-0.1.18-Stand. Spätere Integration muss Versions-/Changelog-/Pin-Kollisionen sachgerecht reconciliieren, ohne den dortigen Additive-Writes-Vertrag zu verlieren.
- MCP-Tar-SHA-256 / Script-Pin: `4f05b3df1c599827cccb3dfeda4d2880863dcfc8320d70223f6c30f9a64fdb8e`.
- Skill-ZIP-SHA-256 / latest/checksum: `8c39ca816bb7d35e2617d92732b5c2532db0f86c1fa25b8d9e056c4de9a4995a`.
- Tracked Hauptcheckout-Diff vor Produktarbeit: SHA-256 `7ae805a18bcbf1b648b5425440aa7adf48df228888af6eda398b47c9022ab583`; abschließender Nachher-Vergleich und reale C/P-Header/Gleichheit im Sessionabschluss.

Akzeptanz getrennt: Headerfälle und Diagnose funktional lokal PASS; Recovery/No-early-move als synthetischer Clientflow PASS; Evidence-/foreign-ID-/Anweisungsvertrag statisch PASS; Artefakte/Version/Pins lokal PASS. Hosted ChatGPT/realer RaspiBlitz-Flow sowie spätere r21-Integration sind NICHT verifiziert. Daher bleibt P `active`, nicht pauschal `accepted`. Kein wesentlicher offener Produktentscheid, keine technische Permissionblockade und kein `INPUT_REQUIRED` in diesem Implementierungslauf; der Manager entscheidet über fachliche Gesamtakzeptanz anhand Originalevidence und externer Verifikation.

## 10. Konsolidierte Integration und lokale Abnahme (2026-09-30)

Manuelle semantische Integration statt Cherry-pick auf ueberlappende r21-/Versionshunks. Gemeinsame Diagnose, Header-Evidence-Anweisungen und isolierte Regressionen wurden portiert; r21 Bundle/Fallback/Annotations/Note-Semantik blieb erhalten. `initialization-follow-through.md` traegt jetzt dieselbe exakte reale Header-/Metadaten-Evidence vor `CONCEPT_READY`. Same-file-Formatreparatur ist kein Retarget und kein Anlass zum Bundle-Error-Fallback. Der weiterhin getrennte Board-Move wird nur nach frischem available/Pfad/Revision-Readback ausgefuehrt; unsicherer Move bleibt bis Statusreadback unsicher, nie pauschal `todo`/Rollback. Keine neue API, Parser-/Fehlercode-/CAS-/Admissionaenderung.

- TypeScript check/build und ganze Adapter-Suite: **100 PASS / 0 FAIL / 0 SKIP** mit gepinntem Upstream-Binary. Fokussierte Taskboard-Suite: **16 PASS / 0 FAIL / 0 SKIP**.
- Headernegative: 20 Rollen/Headerkombinationen jeweils ueber Register und Bundle (**40 fehlgeschlagene Writes**) lassen Files/Sidecar/Status unberuehrt. Beide Recoveryvarianten behalten Body/gutes C, akzeptieren LF/CRLF, lehnen spaeter beschaedigte Header auch auf exact replay ab und verlangen unabhängige Hash-/Revision-Readbacks vor separatem Test-Move.
- Skill/Paket: **17 Tests PASS**, Inventar/ZIP/SHA/latest Build `--check` PASS, r21-Szenarien bleiben erhalten. Header-Evidence-/Recovery-Anweisungsvertrag statisch PASS; das ist kein Hosted-Modelllauf.
- Release metadata **5 PASS**, release state **5 PASS**, MCP Lifecycle inkl. Pin/Production-only-Archiv, Lockchecks, Bash syntax/ShellCheck severity=error und diff --check PASS.
- Bestehender r21-Smoke gegen realen lokalen MCP auf 0.1.19 PASS: Taskboard v0.6.0, OpenCode 1.18.33, temp Projekt/DB/Token ohne Modellturns; additive Writes/Replay/Konflikte/Readbacks/Notes und unklarer PUT nach Commit ohne Retry, danach separater Testtask-Move/Readback. Keine produktiven Fixtures oder laufenden Connectorprozesse beruehrt.
- Konsolidierte Kandidaten: Script **0.6.5**, Adapter **0.1.19**, Skill **2026-09-30-r22**. ZIP-SHA `6cacda785bf88994fe8d5524bb861ec68165dabfd3a7ea4b1598e1b3f856ab68`; MCP-Tar SHA/Script-Pin `ac1fd3dd7c8fb518a4f5a46282f3f75b4aecac9ff6069463308a6bee7afc4629`, zwei identische Builds unter `/tmp/opencode/header-integrated-mcp-{a,b}.tar`. OpenLive/Hub-Pins unveraendert, Tags konsistent v0.6.5; alte dist-Ausgaben absichtlich erhalten.

Keine konzeptionelle Neuentwicklung; reine Reconciliation und kombinierte Abnahme des bereits freigegebenen Designs. Lokal ausreichend, um **Board done vorzuschlagen**, ohne selbst Boardstatus zu schreiben. Hosted ChatGPT/realer RaspiBlitz-Flow und menschliche fachliche Gesamtakzeptanz sind nicht bewiesen; P bleibt `active`. Integrationscommit-SHA/Subject und finaler Git-Status werden im korrelierten Terminalabschluss genannt, nicht durch einen zweiten Housekeeping-Commit nachgetragen.
