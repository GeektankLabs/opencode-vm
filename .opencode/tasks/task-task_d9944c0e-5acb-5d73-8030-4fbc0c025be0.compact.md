Task-ID: task_d9944c0e-5acb-5d73-8030-4fbc0c025be0
Title: MCP – additive Low-Risk Task Writes für Management Notes und Task-Dokumente
Last-updated: 2026-09-30T02:13:00Z
Implementation-state: fully-integrated; locally-accepted; DONE-ready
Board-status-at-review: in_progress (final GET-only readback); this agent did not move the production task

## Concept Plan

Detailed requirements/design/decisions/test plan: `planning/task-concepts/task_d9944c0e-5acb-5d73-8030-4fbc0c025be0-concept-plan.md`

## Current completion / acceptance evidence

- Vollstaendiger Abschlussauftrag umgesetzt: beide additiven Service-/MCP-Tools, strikte Schemas/beide Dispatch-Pfade/Diagnostics, Orchestrator r21, Vertrag/Zähler, lokale Release-Pins und Artefakte. r20-Handoff durch Lesen des korrelierten Original-Terminalresultats bestaetigt; dessen vorhandene Quellen/Testverbesserungen uebernommen. Separater agent-managed-Task blieb unberuehrt.
- Notes: frischer Read + description-only PUT unter vorhandenem Lock; exaktes Praefix, keine Deduplikation/Retry/Sidecar-Save; 32.000 UTF-16-Codeunits und voller 40.000-UTF-8-JSON-Taskread vor PUT. Fehlercode `TASK_DESCRIPTION_LIMIT`. Management hat die nicht kooperierende UI-/Edit-CAS-Restgrenze ausdruecklich akzeptiert.
- Bindings: eine/beide Hauptrollen mit vollstaendiger Vorvalidierung vor hoechstens einem atomaren Schema-3-Save; exact replay revalidiert ohne Publikation. Konflikt/Mismatch/Filefehler erzeugen keine Teilmutation. Kein Replace/Retarget/Dateiwrite/Statuswrite. Bestehendes Register-Replace bleibt kompatibel.
- Skill r21: Preferred-Bundle, Register-Fallback ausschliesslich bei absentem Tool (ohne `expected_path`), mandatory available/exact-path/revision Readback, separater Board-Move/Status-Readback. Unsicherer Move kann schon committed sein: Status lesen, nie Rollback/`todo` behaupten. Expliziter Note-Pfad mit Taskread/Append/Readback; keine automatischen Notes oder Generic-Edit-Fallbacks.
- Finaler Adaptercheck/build + ganze Suite mit gepinntem Binary: **97 pass / 0 fail / 0 skip**; Taskboard-Service-Suite darin 13 pass. Skill/Paket: **16 pass**, Build `--check` gruen. Reale OpenCode-Integration auf gepinntem 1.18.21 gruen. Release-Metadaten 5, Release-State 5, Taskboard-State inkl. SQL-Migration/Restart 7 Tests gruen; MCP-/Hub-/OpenLive-Lifecycle, Locktests und actionlint gruen.
- Reproduzierbare Doppelbuilds aller drei Archive, Production-only `npm ci` des extrahierten MCP-Pakets und `dist/SHA256SUMS`-Pruefung gruen. Bash-Syntax und ShellCheck severity=error gruen; voller ShellCheck zeigt bestehende Hinweise/Warnungen (u. a. indirekt verwendete Testvariablen), keine hier behobenen Nebenbaustellen. `git diff --check` gruen.
- Realer MCP-Smoke aus Source **und Produktionspaket**: eigenes temp Projekt/DB/Token, gepinntes Taskboard v0.6.0, OpenCode 1.18.33, keine Modellturns. Single/Bundle/Replay/Conflict/Missing/Mismatch/all-or-nothing + available/revision/content Readbacks, Notes/Mehrfachappend/Praefix/Feldisolation/Unicode-/Zeichenlimits/unknownTask und verlorene Antwort nach echtem PUT-Commit (genau ein Write), dann separater Move/Statusreadback. Prozesse/Tempdaten bereinigt. Harness: `adapters/mcp/tests/taskboard-integration.mjs` (`npm run test:taskboard`).
- Bestehender Projekt-Connector nur per MCP-Discovery gelesen: neue Tools fehlen noch im laufenden alten Adapter. Kein produktiver Runtime-Restart/Deployment oder Task-Mutation durch Smoke. Hosted ChatGPT/Voice-Modellverhalten/Approval-UI und macOS-Host-VM-Rebuild sind nicht durch diese lokalen/VM-Connector-Tests bewiesen.

## Versions / local artifacts

- Script `0.6.4` (alle drei Release-Tags `v0.6.4`), MCP `0.1.18`, Skill `2026-09-30-r21`; SDK-/Zod-Pins unveraendert. 18 optionale Board-Tools.
- `dist/opencode-vm-mcp-adapter-0.1.18.tar`: SHA-256 `fc105244698aae3d673f73038ff6507a5667fdda4e244012020d660240c7cca7`, passender Script-Pin.
- Skill ZIP: SHA-256 `5df8fff1aacacf40b1b05d7b125628a0fa181a54d2853f4c24f0f01a5df160dc`; `bundle.json`, `latest.json`, ZIP und `.sha256` konsistent.
- Unveraenderte OpenLive 0.1.6-/Hub-Archive lokal erneut gebaut, Pins bestaetigt; drei Archive und `SHA256SUMS` unter `dist/`. Keine Commits, Tags, Remote-Writes oder veroeffentlichten Releases.

## Durable decisions

- Neues Management-Note-Tool: ein Call haengt genau einen klar markierten `Management Note:`-Block an das Ende der aktuell gelesenen nativen Beschreibung. Der bestehende Text bleibt unveraendertes Praefix; der PUT enthaelt ausschliesslich `description`. Kein Titel-, Status-, Prioritaets-, Positions- oder Sidecar-Write.
- Management Notes werden nicht nach Text dedupliziert. Mehrere autorisierte Calls erzeugen mehrere Bloecke; unklare PUT-Ausgaenge werden nicht blind wiederholt. Annotationen: `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:false`, `openWorldHint:false`.
- Neuer enger Binding-Call fuer die Hauptrollen `compact_context` und `concept_plan`: mindestens eine, optional beide Rollen in einem strukturierten Request. Bei zwei Rollen werden Task, beide Pfade/Dateien/Task-IDs und alle Konflikte validiert, bevor genau eine Sidecar-Publikation erfolgt.
- Exakt bereits vorhandene Rolle/Pfad-Bindings sind No-op-Erfolg. Fehlende Bindings werden addiert. Eine Hauptrolle mit anderem bestehenden Pfad oder ein Pfad unter einer anderen Rolle wird fail-closed abgelehnt. Kein `expected_path`, kein Replace/Retarget, keine Datei-Aenderung und kein `concept_detail` in diesem engen Tool.
- Binding-Annotationen: `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`.
- Der gebuendelte Zwei-Rollen-Endpunkt ist sinnvoll, weil er beide Validierungen vor einer atomaren Sidecar-Publikation ermoeglicht und den r20-Init-Pfad von zwei Writes auf einen reduziert. Der Board-Move bleibt separat: native Board-DB und Sidecar/Dateisystem haben keine gemeinsame Transaktion oder CAS; eine Kombination wuerde eine nicht haltbare Atomizitaetsgarantie suggerieren.
- Tool-Annotations sind ehrliche Client-Hinweise, keine Autorisierung und keine Zusage, dass eine UI keine Freigabe abfragt.
- Bestehende `register_task_document`-Replace-Semantik bleibt fuer bestehende Consumer erhalten. Der r20-Nachfolger bevorzugt den neuen add-only Bundle-Call und behaelt Readback sowie den separaten Board-Move bei.
- Konzeptkorrektur: Note-Writes ueber das neue Tool sollen unter dem vorhandenen prozessgeteilten Lock serialisiert werden, ohne `saveMetadata()`. Das verhindert verlorene Notes zwischen kooperierenden Note-Writern, aber kein UI/MCP- oder allgemeines Edit-CAS. Zusaetzlich zum 32.000-Zeichenlimit muss der zukuenftige `get_project_task`-Read innerhalb 40.000 UTF-8-JSON-Bytes bleiben.

## Remaining external adoption

- Fachlich-technisch DONE-ready fuer den freigegebenen Integrations-/lokalen Abnahmescope; kein Implementierungsblocker. Board bleibt bis Management-Abschluss `in_progress`.
- Nach koordinierter Aktivierung Connector-Katalog aktualisieren und Skill r21 importieren; Hosted ChatGPT/Voice-Verhalten separat akzeptieren. Keine Approval-Unterdrueckung behaupten. MacOS/Host-Rebuild und Release-Veroeffentlichung sind separate Maintainer-/Umgebungsaktionen, nicht hier ausgefuehrt.

## Next concrete step

Jetzt: Abschlussresultat und lokale Artefakte an Management uebergeben; keine weiteren Feature-/Integrationsarbeiten erforderlich. Remote-Push/Release und produktive Aktivierung erfolgen separat. Kein produktiver Board-Move durch diesen Agenten.

## Essential references

- Kanonischer Detailplan: `planning/task-concepts/task_d9944c0e-5acb-5d73-8030-4fbc0c025be0-concept-plan.md`
- Service/Datenmodell: `adapters/mcp/src/taskboard.ts`
- Schemas, Katalog, Annotationen und Dispatch: `adapters/mcp/src/tools.ts`
- Diagnostik-Allowlist: `adapters/mcp/src/diagnostics.ts`
- Adapter-Tests: `adapters/mcp/src/taskboard.test.ts`, `adapters/mcp/src/http.test.ts`
- Vertrag: `docs/MCP-INTERFACE.md`
- r20-Workflow: `integrations/chatgpt/opencode-session-orchestrator/references/initialization-follow-through.md`
- Skill-Integrationstest: `tests/chatgpt_skill_test.py`
