Task-ID: task_d9944c0e-5acb-5d73-8030-4fbc0c025be0
Title: MCP – additive Low-Risk Task Writes für Management Notes und Task-Dokumente
Status: active
Last-concept-update: 2026-09-30
Implementation-state: fully-integrated; locally-accepted; DONE-ready
Board-status-at-review: in_progress (final GET-only verification; no production status mutation)
Review-mode: authorized final integration and disposable acceptance

`Status: active` bezeichnet den gepflegten Konzeptstand, nicht den Board-Status oder einen Implementierungsstart. Diese Datei ist der kanonische Detailplan; der Compact Context unter `.opencode/tasks/task-task_d9944c0e-5acb-5d73-8030-4fbc0c025be0.compact.md` bleibt die kurze Fortsetzungszusammenfassung. Board = Outcome/Scope, korrelierte Session-/Ergebnis-Historie = Evidence.

## Current assignment and reconciliation

### Final integration authorization (2026-09-30)

The new completion assignment authorizes all remaining skill/contract/test/version/local-artifact integration and a bounded disposable MCP smoke. Historical initialization-only restrictions and future-tense evidence below describe the starting snapshot, not today's scope. The separate agent-managed-sessions task, remote writes/tags/publication and production Board fixtures remain excluded.

- Management explicitly accepts the non-cooperating UI/general-edit race on the description-only GET/PUT. No global CAS/append guarantee, new CAS infrastructure or blind note retry is required or allowed.
- r20 handoff gate is satisfied: the exact original terminal result for the linked verification submission was read via backend GET, with matching parent message, `finish:stop` and completion time. It confirms local/synthetic r20 acceptance and package digest, and explicitly leaves Hosted/Voice behavior open. Existing r20 sources/tests are preserved as the integration baseline; ownership is transferred by this completion assignment.
- Current free local candidates are adapter 0.1.18, script 0.6.4 and skill 2026-09-30-r21; no separate-task product/version changes were found at reconciliation.
- Integration correction: an uncertain Board move may already have committed. Client text/tests must read actual status instead of claiming rollback or guaranteed `todo`. This follows the existing no-blind-retry/no-cross-store-transaction decision; it does not add a new checkpoint or server primitive.
- Acceptance will distinguish source/package tests, real disposable upstream/MCP calls and Hosted ChatGPT behavior. Live connector discovery does not alone prove that the hosted model loaded the updated ZIP or that approval UI is suppressed.

### Completion evidence (2026-09-30)

All authorized local implementation/integration acceptance is complete. The adapter methods, strict MCP schemas/dispatch/annotations/diagnostics and regression tests are integrated with skill r21, its references/flow model and the public contract. `CONCEPT_READY` -> preferred bundle -> available/exact-path/revision readback -> `REGISTERED` -> separate Board move/status readback -> `BOARD_MOVED` remains mandatory. Fallback only occurs on absent bundle capability, never on conflict/error; Notes remain separately authorized and non-idempotent. No global CAS or approval-suppression promise was added.

| Acceptance area | Final verified evidence |
|---|---|
| Notes / field isolation / budgets / uncertain delivery | Service/Wire tests and real MCP smoke check multiple append, exact prefix, description-only PUT, unknown task, Unicode/character limits and a real committed PUT whose response is deliberately lost, with one PUT and normal readback. |
| Add-only single/bundle/replay/conflicts/file validation | Service tests check atomic single publication, no-op replay inode/bytes, mixed existing+add, concurrent requests, all-or-nothing conflicts/second-file failure, safe file checks and legacy schema upgrade. Real MCP smoke checks the corresponding bundle/reference/readback path against pinned upstream. Existing deliberate register retarget stays compatible. |
| Orchestrator / recovery | 16 passing skill/package tests include preferred bundle call ordering, missing-tool register fallback/partial-resume, orphan reuse, conflict/no-fallback, uncertain binding commit + authorized exact replay, bad availability/path/revision readbacks, separate move and already-committed uncertain move readback. The synthetic client model is not Hosted model-behavior evidence. |
| Adapter / backend compatibility | Final full adapter suite 97 pass, 0 fail, 0 skip with Taskboard v0.6.0 binary; typecheck/build green. Existing real OpenCode integration on pinned 1.18.21 passes. Dedicated source and production-package MCP smokes use OpenCode 1.18.33 + pinned Taskboard v0.6.0, no model turns. |
| Packaging / release integrity | Script 0.6.4, adapter 0.1.18, skill 2026-09-30-r21. All release tags/pins match. Three archives built twice identically; production-only MCP package installed and executed. Skill inventory/ZIP/checksum/latest/build-check pass; dist/SHA256SUMS verifies all archives. |
| Supporting checks | Release metadata 5, release state 5, Taskboard state/migration/restart 7 tests pass; MCP/Hub/OpenLive lifecycle and lock tests pass; actionlint, Bash syntax, ShellCheck severity=error and git diff --check pass. Full ShellCheck has pre-existing warnings/info, including indirect fixture variables, not new runtime edits. |
| Current live connector / remaining external adoption | Existing project connector was probed via authenticated MCP discovery only and lacks the new tools until coordinated restart/restaging. All smoke writes used disposable temporary DB/project/credential/services and were cleaned up. No production Board fixture, runtime restart, remote push/tag/release, or separate agent-managed-task edit. Hosted ChatGPT/Voice/approval behavior and macOS-host lifecycle/rebuild remain external acceptance, not claimed by VM/package checks. |

Local artifacts: `dist/opencode-vm-mcp-adapter-0.1.18.tar` SHA-256 `fc105244698aae3d673f73038ff6507a5667fdda4e244012020d660240c7cca7`; r21 ZIP SHA-256 `5df8fff1aacacf40b1b05d7b125628a0fa181a54d2853f4c24f0f01a5df160dc`. Unchanged OpenLive 0.1.6 and Hub archives are rebuilt beside it with `dist/SHA256SUMS`; the script pins are verified, not guessed.

The reproducible real-MCP harness is `adapters/mcp/tests/taskboard-integration.mjs` / `npm run test:taskboard`; environment options are documented in `docs/RELEASING.md`. It also supports an extracted production package and optional discovery-only current connector probe. Exact scenario-level details stay in tests and Compact Context rather than copying full result logs here.

**Verdict: fachlich-technisch DONE-ready for the authorized final integration and bounded local/connector acceptance scope.** No code/architecture blocker remains. Product deployment/Hosted adoption and Management's actual Board closure are distinct steps; this agent left the production task `in_progress`.

### Historical initialization record

- Beide vorgeschlagenen Dateien existierten bereits. Ihre erste Zeile wurde tatsaechlich gelesen und enthielt jeweils exakt `Task-ID: task_d9944c0e-5acb-5d73-8030-4fbc0c025be0`. Keine Pfad-/Task-ID-Collision; Wiederverwendung und gezielte Reconciliation statt Neuanlage/Umbenennung.
- Der Auftrag umfasst nur diese zwei Dokumente: Ist-Stand, Konzept, Abhaengigkeiten und Implementierungs-/Testplan. Alle nachfolgenden Feature- und Release-Schritte sind Zukunftsplanung, keine aktuelle Ausfuehrungsfreigabe. Keine Registrierung, keine Board-/Session-Mutation durch diesen Agenten.
- Pflegepolitik: Compact Context Ziel ~5k Tokens, Warnung ~7.5k, vor ~10k verdichten, nie splitten. Concept Plan Ziel ~20k, Warnung ~30k, ab ~40k ggf. task-ID-benannte Detaildateien; Hauptdatei bleibt kanonischer Index. Diese Initialisierung braucht keinen Split und keine kuenstliche Auffuellung auf die Zielgroesse.
- Im Review wurden nur lokale Sources/Vertraege/Tests und GET-only Runtime-/Board-Daten gelesen. Bestehende fremde r20-Produkt-/Test-/Bundle-Aenderungen bleiben deren Arbeitsstand. Es wurde kein neuer Feature-Testlauf oder Artefakt-Build ausgefuehrt.

## Problem and target outcome

Der optionale project-local Taskboard-Adapter besitzt derzeit allgemeine Task-Mutationen und semantische Dokumentreferenzen, aber keine eng annotierten Low-Risk Writes fuer die zwei vom Board autorisierten Faelle:

1. Kurzfristige Management-Anschlussnotizen muessen in der nativen Task-Beschreibung sichtbar sein. `update_project_task` kann diese Beschreibung ersetzen, ist aber ein allgemeiner Write fuer Titel, Beschreibung, Prioritaet und Status. `add_task_comment` ist keine Alternative, weil sein Sidecar-Inhalt laut bestehendem Vertrag nicht in der Taskboard-UI erscheint.
2. Vorhandene `compact_context`-/`concept_plan`-Dateien muessen nach `CONCEPT_READY` registriert werden. `register_task_document` validiert Dateien bereits sicher, erlaubt mit `expected_path` aber auch bewusstes Replace/Retarget. Der r20-Orchestrator braucht fuer beide Hauptrollen zwei Calls und muss partielle Registrierung als Recovery-Zustand verwalten.

Ziel ist eine additive Erweiterung des MCP-Adapters um zwei klar begrenzte technische Mutationen:

- `add_task_management_note`: haengt einen Management-Note-Block an die bestehende native Beschreibung an und beruehrt kein anderes Task-Feld.
- `add_task_document_bindings`: bindet eine oder beide Hauptrollen strukturiert und ausschliesslich add-only. Beide Dateien koennen in einem Call vor einer einzigen Sidecar-Publikation validiert werden. Exakte Wiederholungen sind sichere No-op-Erfolge; Hauptrollen-Konflikte schlagen fehl.

Beide Tools bleiben ehrlich als Writes markiert, werden aber von allgemeinen Edit-/Move-/Delete-/Transfer-Pfaden unterscheidbar: `readOnlyHint:false`, `destructiveHint:false`, `openWorldHint:false`, mit passendem `idempotentHint`. Annotationen sind Metadaten fuer Clients und Approval-Policies, keine serverseitige Autorisierung und keine Garantie ueber eine bestimmte Freigabe-UI.

Der bestehende r20-Ablauf `CONCEPT_READY` -> `REGISTERED` -> `BOARD_MOVED` bleibt erhalten. Nach `CONCEPT_READY` bevorzugt der Orchestrator den neuen gebuendelten add-only Binding-Call, liest beide Rollen weiterhin via `get_task_documents` zurueck und fuehrt den Board-Move erst danach separat aus.

## Scope and non-goals

### In scope

- Zwei neue optionale Taskboard-MCP-Tools samt Service-Methoden, Input-/Output-Schemas, Katalogregistrierung, Fallback-Dispatch und Diagnostics-Allowlist.
- Native append-only Management Notes in `BackendTask.description`.
- Add-only Bindings ausschliesslich fuer `compact_context` und `concept_plan`, einzeln oder gebuendelt.
- Wiederverwendung der vorhandenen Dokumentpfad-, Dateisicherheits-, Task-ID-, Lock- und atomaren Sidecar-Publikationsregeln.
- Praezise Tool-Annotations und Dokumentation ihrer Grenzen.
- Service-, Wire-/Katalog- und r20-Orchestrator-Integrationstests.
- Erforderliche Adapter-/Script-Versionierung, Release-Metadaten und Skill-Bundle-Aktualisierung.

### Out of scope

- Datei erstellen, editieren, ersetzen, verschieben oder loeschen durch die neuen Tools. Die autorisierte Pflege der zwei Task-Dokumente ist davon getrennt.
- Dokumentreferenzen ersetzen, retargeten, entfernen oder `concept_detail` ueber das neue enge Tool verwalten.
- Board-Status-Move mit Dokumentbindung in einen scheinbar atomaren Server-Call kombinieren.
- Allgemeine Task-Patches, Delete/Transfer, automatische Statuswechsel oder automatische PLAN-Synchronisierung.
- Sidecar-Kommentare in Management Notes migrieren oder beide Konzepte vereinheitlichen.
- Ein neuer Hintergrundprozess, Retry-Worker, Scheduler oder verstecktes Polling.
- Eine Garantie, dass MCP-Annotations Client-Freigaben deaktivieren.
- Eine neue globale UI/MCP-Revision oder ein CAS, das der Upstream v0.6.0 nicht anbietet.

## Verified starting state

Die bereits vorhandene Hauptdatei wurde fuer diesen Initialisierungsschritt wiederverwendet. Ihre Task-ID und der Compact-Context-Verweis stimmen mit dem angeforderten Task ueberein; die folgenden Aussagen wurden erneut gegen den aktuellen Repository-Stand geprueft. In diesem Schritt wurden keine Feature-, Test-, Vertrags-, Versions- oder Release-Dateien geaendert.

### Taskboard service and persistence

- `adapters/mcp/src/taskboard.ts` definiert `DocumentRole = "compact_context" | "concept_plan" | "concept_detail"` und Schema-3-Metadaten mit `documents: Record<string, TaskDocument[]>`.
- `validDocumentPath()` erlaubt fuer Compact Context die kanonischen Varianten `.opencode/tasks/task-<task_id>.compact.md` und `.opencode/tasks/<task_id>.compact.md`, fuer Concept Plan nur `planning/task-concepts/<task_id>-concept-plan.md`.
- `documentBytes()` prueft Projektgrenze, alle Verzeichniskomponenten, Symlinks, regulaere Datei, Groesse <= 1 MiB, stabilen Descriptor, valides UTF-8 und die exakte erste Zeile `Task-ID: <task_id>`.
- `registerDocument()` arbeitet unter `withMetadataLock()`, laedt Metadaten im Lock neu und publiziert atomar. Exakte Rolle/Pfad-Wiederholungen werden nicht dupliziert. Bei Hauptrollen erlaubt ein passendes `expectedPath` jedoch den Austausch des registrierten Pfads.
- `saveMetadata()` nutzt eine mode-0600 Temp-Datei, `fsync`, atomisches Rename und Directory-`fsync`. Schema 1/2 wird lesekompatibel behandelt und erst bei einem Write als Schema 3 publiziert.
- `updateTask()` sendet bereits nur die im Patch enthaltenen nativen Felder per PUT. Es gibt aber keine spezialisierte Append-Methode und keine Upstream-Revision/CAS.
- `addComment()` ist unter dem Sidecar-Lock append-orientiert, aber UI-unsichtbar und fuer diesen Task nicht die richtige Datensenke.

### MCP surface

- `adapters/mcp/src/tools.ts` registriert Taskboard-Tools sowohl ueber `server.registerTool(...)` als auch im `CallToolRequestSchema`-Dispatch. Neue Tools muessen in beiden Pfaden dieselben Schemas und Resultate verwenden.
- `readOnlyAnnotations` ist lokal/read-only. Das generische `writeAnnotations` ist aktuell `destructiveHint:true`, `idempotentHint:false`, `openWorldHint:true` und passt fuer die neuen engen Tools nicht.
- `adapters/mcp/src/diagnostics.ts` fuehrt eine feste Tool-Allowlist; neue Namen muessen aufgenommen werden, ohne Request-/Result-Body zu loggen.
- `adapters/mcp/src/http.test.ts` zaehlt aktuell 16 optionale Board-Tools und prueft einige Annotationen. Die neue Oberflaeche erhoeht diesen Katalog auf 18 Tools.

### Orchestrator r20

- `integrations/chatgpt/bundle.json` steht auf `2026-09-29-r20`.
- `references/initialization-follow-through.md` definiert `CONCEPT_READY`, `REGISTERED` und `BOARD_MOVED`. Heute bindet der Orchestrator beide Hauptrollen mit zwei `register_task_document`-Calls, liest beide zurueck und bewegt erst danach den Board-Task.
- Orphan-Files-Recovery verwendet dieselbe Sequenz und bewahrt partielle erfolgreiche Registrierungen fuer einen spaeteren autorisierten Retry.
- `tests/chatgpt_skill_test.py` modelliert diesen Ablauf mit FakeConnector/FakeFilesystem, deckt aber den neuen gebuendelten add-only Call noch nicht ab.

### Live Board and evidence boundary (review snapshot)

Der GET auf das projektlokale `/api/tickets` wurde gegen die im Adapter implementierte deterministische Task-ID-Ableitung und vorhandene Sidecar-Zuordnungen ausgewertet, ohne Read-side-Writes:

| Task | Verifizierter Board-Stand | Relevanz |
|---|---|---|
| `task_d9944c0e-5acb-5d73-8030-4fbc0c025be0` | MCP-5, angeforderter Titel, `todo`, `high` | Vollstaendige Board-Beschreibung gelesen: zwei dedizierte additive Writes, enge Annotationen, normales Readback, Orchestrator-Integration und Regressionen. |
| `task_cce3a196-9611-5cf6-9f74-c98720211548` | MCP-6, Orchestrator-Follow-through, `in_progress`, `high` | Abschlussverifikation laeuft parallel; kein neuer Adapter-Tool-/Datenmodell-Scope in dieser Board-Beschreibung. |

Das Sidecar hatte Schema 3 und nur fuer den r20-Task die zwei Hauptdokumente registriert; fuer MCP-5 waren beim Read noch keine Dokumentreferenzen vorhanden. Der Task bleibt durch seine deterministische ID lesbar, ohne dafuer Metadaten anzulegen. r20-Board-Links identifizieren eine separate Abschlussverifikations-Session; ein exakter Session-GET bestaetigte deren Projekt/Titel und der Status-GET `busy`. Das ist aktuelle Aktivitaetsevidence, kein Abschlussresultat. Session-/Message-IDs bleiben in der Board-/Session-Historie, hier werden keine langen Ergebnisberichte dupliziert.

Verifizierte Checkout-Basis: HEAD `6d2efde`, `OCVM_VERSION=0.6.3`, `MCP_ADAPTER_VERSION` und `ADAPTER_VERSION=0.1.17`; `@modelcontextprotocol/sdk=1.30.1`, `zod=4.6.5`, Node-Anforderung `>=22`. Keine der vorgeschlagenen neuen Service-/Tool-Methoden existiert im gelesenen Produktstand. Die r20-Quellen, Paketmetadaten, ZIP/SHA/latest und `tests/chatgpt_skill_test.py` waren bereits lokal geaendert; `references/initialization-follow-through.md` war bereits untracked. Diese Aenderungen werden nicht diesem Konzeptauftrag zugerechnet.

Die vorhandenen fremden r20-Taskdateien berichten einen frueheren gruenen synthetischen Teststand. Das wurde hier nicht als neue Abschlussverifikation uebernommen. Test-Sources wurden inspiziert; das abschliessende korrelierte Ergebnis der laufenden Verifikation sowie Live-/Hosted-Smoke bleiben **verification pending**.

## Dependency assessment and conflict boundaries

### Recommendation: B

**B — Konzept und Adapter/Tests koennen parallel vorbereitet bzw. in einem spaeter autorisierten Implementierungsauftrag umgesetzt werden; Orchestrator-Skill-Integration erst nach bestaetigtem r20-Stand.**

- **Keine harte fachliche Abhaengigkeit fuer die Adapter-Erweiterung:** r20 schliesst das bereits autorisierte Follow-through nach `CONCEPT_READY` mit den bestehenden Tools. Dieser Task erweitert deren enge Schreibfaehigkeiten und reduziert optional zwei Registrierungswrites auf einen. Keiner braucht die neuen Tools, um r20 abzunehmen; Management Notes sind unabhaengig vom r20-Init-Flow.
- **Keine harte technische Adapter-Abhaengigkeit:** Schema-3-Dokumentreferenzen, sichere Datei-Reads, Lock/atomare Publikation, MCP-Schemas und Dispatch sind bereits im Produktstand vorhanden. r20 fuehrt laut Board/Dateiscope weder neue Adapter-Schemas noch Server-Transaktionen ein. Die alten Tools bleiben kompatibel und werden nicht umannotiert.
- **Reale Integrations-/Dateikollision:** Beide Arbeiten beruehren denselben Skill-Vertrag, dieselben Init-/Board-Referenzen, Regressionen, Fake-Flow-Test und Paketartefakte. Ein neuer Preferred-Bundle-Pfad waehrend r20-Verifikation wuerde deren zu pruefende Texte, Szenarien und Paketrevision austauschen und kann Findings/Build-Artefakte vermischen.
- **Kein globales Warten erforderlich:** C waere fuer Notes und Adapter unnoetig. A waere fuer den ganzen Task zu weit, solange r20 dieselbe Integrationsschicht aktiv verifiziert. B trennt die vorhandenen Speicher-/Komponentengrenzen und haelt den r20-Zwei-Call-Pfad pruefbar.

### Expected future file / component touch map

| Schicht / voraussichtliche Dateien | Geplante Aenderung | Ueberschneidung mit r20 / Startgrenze |
|---|---|---|
| `adapters/mcp/src/taskboard.ts` | Note-Methode; add-only Bundle-Writer; vorhandene Validierung/Locks wiederverwenden | Keine in r20 festgestellte Codeaenderung; erste Implementierungsschicht. Bestehende Register/Readback-Semantik erhalten. |
| `adapters/mcp/src/tools.ts`, `diagnostics.ts` | Zwei neue strikte Inputs, explizite Annotationen, Katalog/Raw-Dispatch, Namens-Allowlist | Keine direkte r20-Dateiueberschneidung; kein Auth-/Policy-Umbau. |
| `adapters/mcp/src/taskboard.test.ts`, `http.test.ts`, `diagnostics.test.ts` | Append-/Isolation-/Bundle-/Katalog-/Privacy-Tests | Adaptertests zuerst; nicht den r20-Fake-Test vorziehen. |
| `docs/MCP-INTERFACE.md`, relevante Stellen in `TASKBOARD-INTEGRATION.md` | Enge Write-Vertraege und Grenzen | Vertragsdokumentation parallel moeglich; konkrete Skill-Flowaussagen erst mit bestaetigter Basis reconciliieren. |
| `integrations/chatgpt/opencode-session-orchestrator/SKILL.md` | Neue Tools nach Discovery bevorzugen; Note-Verwendung explizit autorisiert | Direkte r20-Ueberschneidung; Handoff-Gate. |
| `references/initialization-follow-through.md`, `board-workflow.md`, `task-concept-plan.md`, `task-compact-context.md`, `regression-scenarios.md` im Skill | Preferred Bundle/Fallback, unveraenderte Checkpoints, Recovery und Management-Note-Regeln | Direkte r20-Ueberschneidung; dieselben Abschnitte/Szenarien. Erst nach Gate. |
| `tests/chatgpt_skill_test.py` | Bundle-Fake mit echten Erfolgs-/Konfliktzustandsassertions und Note-Regressionsfaellen | Laufende r20-Pruefgrundlage; nach Gate auf deren akzeptiertem Teststand aufbauen. |
| Skill `CHANGELOG.md`, `integrations/chatgpt/bundle.json`, `latest.json`, `opencode-session-orchestrator.zip`, `.zip.sha256` | Naechste freie Revision und konsistentes Paket | Direkte Artefakt-/Revisionskollision; erst nach Gate gemeinsam regenerieren. |
| `adapters/mcp/package.json`, `package-lock.json`, `src/types.ts`, `opencode-vm.sh`, `tests/mcp_adapter_test.sh`, `tests/release_metadata_test.py`; ggf. unmittelbar betroffene README/AGENTS-Zaehler | Adapterversion, Tarball-Pins und obligatorischer Script-Patchbump | Kein r20-Adapter-Scope; Versionen bei Start neu lesen, Paket-/Release-Schicht spaeter serialisieren. Keine Veroeffentlichung in diesem Auftrag. |

### Skill integration handoff gate

Vor dem ersten Write in der gemeinsamen Skill-/Paket-/Python-Testschicht:

1. Das korrelierte Original-Abschlussresultat der r20-Verifikation lesen; nicht aus `busy`/`idle`, altem Compact Context, Paketmarker oder Board-Link-Text ableiten.
2. Die damit verifizierte Quellen-/Test-/Bundle-Basis feststellen und laufende Aenderungen an dieser Schicht beenden bzw. deren Ownership-Uebergabe bestaetigen. Es wird keine fremde Session beendet und kein fremder Task geschlossen.
3. r20-Findings und offene Hosted-/Recovery-Smoke-Gaps eindeutig zuordnen. Deren fachlicher Rest wird nicht durch neue Low-Risk-Tools als geloest erklaert. Ein dokumentierter Hosted-Gap ist nicht automatisch ein Adapterblocker; die Skill-Basis muss dennoch bestaetigt sein.
4. Quellen/Revision erneut lesen, dann eine additive Folgerevision und neue Tests auf genau dieser Basis planen. Uncertain Move heisst Status erneut lesen; ein bereits ausgefuehrter Move wird nicht als sicher `todo` oder als zurueckgerollt behauptet.
5. Der Bundle-Pfad behaelt `CONCEPT_READY` -> Bindings -> `get_task_documents` -> `REGISTERED` -> separater Board-Move -> Status-Readback -> `BOARD_MOVED`. Das Gate verlangt keinen vom Agenten erzwungenen Board-Done-Status fuer r20.

Test-Inspection und parallele Drift: Beim ersten Read zaehlte der r20-Fake Registrierungsversuche als Referenzliste und pruefte beim Dokumentread primaer nichtleere Rollenarrays. Ein spaeterer read-only Diff waehrend dieser Dokumentarbeit zeigte bereits fremde Erweiterungen: getrennte `registration_calls`/erfolgreiche Referenzen, Retry nur der fehlenden Rolle, Pruefungen von `available`/Pfad/Revision und ein Board-Readback-Negativfall. Diese Zwischenkorrekturen werden r20 zugerechnet, nicht hier implementiert oder als abgenommen erklaert. Der Fake bleibt ein synthetisches Referenzmodell; der unklare Move wird weiterhin als nicht ausgefuehrt modelliert. Die spaetere Bundle-Integration muss die dann akzeptierte Basis uebernehmen und Unsicherheit nach moeglich erfolgtem Write ehrlich pruefen. Das sichtbare Weiterarbeiten an derselben Testdatei bestaetigt Empfehlung B.

## Assumptions and constraints

- Board-Beschreibung ist der autorisierte Zielumfang; Toolnamen und Markdown-Marker sind dort Beispiele. Die zwei hier gewaehlten Namen/der feste `Management Note:`-Block sind Konzeptentscheidungen, kein behaupteter vorhandener Wire-Vertrag.
- Optionaler `concept_detail`-Support ist keine Pflicht des Boards. Bewusste Minimalentscheidung: neuer Low-Risk-Writer nur fuer die zwei Hauptrollen; Details bleiben ueber das bestehende Tool verfuegbar.
- Der lokale Taskboard-Vertrag dokumentiert den gepinnten Upstream v0.6.0 ohne gemeinsame Revision/CAS und native atomare Append-Route. Das Review hat dessen Code/API nicht durch mutierende Probes erweitert. Ein description-only PUT ist ein Read-modify-write, kein atomarer Datenbank-Append.
- Note-Serialisierung ueber den vorhandenen Prozess-Lock erfasst nur kooperierende neue Note-Writes. UI, allgemeines `update_project_task` und andere native API-Clients nehmen an diesem Lock nicht teil; deren gleichzeitiger Beschreibungstext kann zwischen GET und PUT verloren gehen. Management hat diese Restgrenze im Abschlussauftrag ausdruecklich akzeptiert; kein neuer CAS-Unterbau oder blinder Retry.
- `destructiveHint:false` beschreibt den beabsichtigten eng additiven Write, keine Race-Freiheit oder Sicherheitsgarantie. `openWorldHint:false` ist hier wegen des geschlossenen projektlokalen Board-/Dateisystems angemessen, nicht weil keinerlei Backend-HTTP stattfindet.
- 32.000 in bestehenden Zod-Strings ist ein JavaScript-Stringlaengenlimit (UTF-16-Codeunits), keine UTF-8-Bytegarantie. Der nachfolgende normale Task-Read hat zusaetzlich eine 40.000-Byte-JSON-Grenze; Unicode, Kommentare/Links und Dokumentreferenzen muessen mitzaehlen.
- Reads duerfen Bindings nicht lazy anlegen; unbekannte IDs duerfen bei ueberschrittenem Vollscan nicht als `TASK_NOT_FOUND` missinterpretiert werden. Bestehendes `TASK_SEARCH_INCOMPLETE` bleibt eine Coverage-Grenze.
- Sidecar-Bundle-Atomizitaet gilt fuer die Referenzpublikation, nicht fuer native Task-DB, den Board-Move oder die Zukunft der Dateiinhalte. Datei-Aenderungen nach Validierung koennen das obligatorische Readback scheitern lassen; bestehende Revision/Hash-Regeln bleiben die Lesegrenze.
- SDK/Transport bleiben auf dem vorhandenen gepinnten Stand; keine Protokollmigration, neue Permission-Flags oder hostseitige Approval-Policy-Aenderung.

## Requirements and acceptance criteria

### A. Management Note

1. Das Tool akzeptiert genau `task_id` und `note`; keine allgemeinen Patch-Felder.
2. `task_id` muss die stabile UUID-foermige `task_<UUID>`-Form erfuellen. Eine syntaktisch gueltige, bei vollstaendiger Aufloesung unbekannte ID endet mit `TASK_NOT_FOUND`, bevor ein PUT erfolgt. Ein ueberschrittener bestehender Scan bleibt `TASK_SEARCH_INCOMPLETE`, nicht vermeintlicher Abwesenheitsbeweis.
3. `note` ist nach Trim nicht leer. Input und resultierende Beschreibung bleiben innerhalb der bestehenden 32.000-Zeichen-Grenze. Zusaetzlich muss die voraussichtliche komplette Task-Read-JSON-Ausgabe inklusive vorhandener Sidecar-Felder in 40.000 UTF-8-Bytes passen. Ueberschreitung schlaegt vor dem PUT mit einem praezisen Fehler fehl; es wird nie gekuerzt. Keine nachtraegliche Budgetablehnung erst nach erfolgreichem Append.
4. Der bestehende Beschreibungstext bleibt byte-/zeichengetreu als Praefix erhalten. Ein Call fuegt am Ende einen klar markierten Block hinzu:

   ```text
   Management Note:
   <note>
   ```

   Bei nichtleerer Beschreibung wird genau `\n\n` angehaengt, auch wenn das unveraenderte Praefix bereits mit Newlines endet; bestehende Endzeichen werden nicht normalisiert. Bei leerer Beschreibung beginnt der Block direkt. Der Note-Inhalt wird nicht als Markdown-Liste umgeschrieben.
5. Jeder erfolgreiche Call fuegt genau einen Block hinzu. Zwei sequenziell ausgefuehrte Calls fuegen zwei Bloecke in Aufrufreihenfolge hinzu; identischer Text wird nicht dedupliziert. Fuer gleichzeitige kooperierende Calls gilt die Lock-/Commit-Reihenfolge aus Kriterium 10.
6. Der Upstream-PUT enthaelt ausschliesslich `{ description: <appended> }`. Titel, Status, Prioritaet, Position, Labels, Subtasks, Links, Kommentare und Dokumentbindings werden durch den Adapter nicht geschrieben.
7. Der Rueckgabewert ist der normale `taskOutput`; dadurch kann der Client die sichtbare Beschreibung unmittelbar pruefen.
8. Bei Taskboard-/Netzwerkunsicherheit erfolgt kein automatischer oder versteckter Retry. Weil derselbe Call erneut anhaengen wuerde, ist die Operation nicht idempotent.
9. Annotationen sind exakt `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:false`, `openWorldHint:false`.
10. Konkurrierende Calls des neuen Note-Tools werden prozessgeteilt ueber den vorhandenen Lock serialisiert, mit frischem Task-Read erst im Lock. Erfolgreiche kooperierende Writes verlieren keine Note; deren Reihenfolge ist Commit-/Lock-Reihenfolge, keine zugesagte Netzwerkankunftsreihenfolge. Kein `saveMetadata()` oder anderer Sidecar-Inhaltswrite. Nicht kooperierende UI-/Edit-Writes bleiben die dokumentierte CAS-Restgrenze.

### B. Add-only document bindings

1. Das Tool akzeptiert `task_id` sowie mindestens eines der optionalen strukturierten Felder `compact_context` und `concept_plan`; jedes Feld enthaelt den projekt-relativen Pfad fuer genau diese Rolle. Unbekannte Felder und ein Request ohne irgendeine der beiden Rollen werden abgelehnt.
2. `concept_detail` und `expected_path` sind absichtlich nicht Teil dieses Interfaces.
3. Die bestehende Task muss aufloesbar und project-local exponiert sein. Jede angegebene Datei muss alle bestehenden `validDocumentPath()`-/`documentBytes()`-Pruefungen bestehen, einschliesslich der passenden ersten `Task-ID`-Zeile.
4. Bei einem gebuendelten Request werden alle angegebenen Dateien und alle bestehenden Bindings geprueft, bevor Metadaten mutiert oder gespeichert werden.
5. Ist eine Rolle ungebunden, wird das angegebene Binding hinzugefuegt. Ist exakt dieselbe Rolle/Pfad-Kombination vorhanden, ist sie ein No-op-Erfolg.
6. Zeigt eine angegebene Hauptrolle bereits auf einen anderen Pfad, schlaegt der gesamte Call mit `TASK_DOCUMENT_CONFLICT` fehl. Dasselbe gilt, wenn der angegebene Pfad bereits einer anderen Rolle zugeordnet ist.
7. Bei einem Bundle aus einer exakten Wiederholung und einem fehlenden Binding wird nur das fehlende Binding addiert. Bei irgendeinem Konflikt wird keines der neuen Bindings publiziert.
8. Sind alle angeforderten Bindings bereits exakt vorhanden, gibt die Methode den aktuellen Zustand ohne `saveMetadata()` zurueck. Exakte Replays sind bezogen auf Dokumentreferenzen/Sidecar-Publikation No-op; Task und Dateien werden trotzdem sicher revalidiert. Ein Replay bei inzwischen fehlender/fremder Datei ist kein behaupteter Erfolg.
9. Ein erfolgreicher mutierender Call schreibt `metadata.tasks[task_id]` und `metadata.documents[task_id]` genau einmal unter dem vorhandenen Lock und publiziert das Sidecar genau einmal. Keine Datei wird geoeffnet zum Schreiben.
10. Das bestehende `register_task_document` bleibt unveraendert fuer kompatible Consumer und bewusste `expected_path`-Replacements. Die neue Methode ruft nicht den bestehenden Writer zweimal auf, weil dies die gebuendelte All-or-nothing-Eigenschaft verlieren wuerde.
11. Annotationen sind exakt `readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`.

### C. Orchestrator integration

1. Der r20-Checkpoint-Vertrag bleibt unveraendert: `CONCEPT_READY` ist Agenten-Ende, `REGISTERED` erfordert erfolgreichen Readback beider Rollen, `BOARD_MOVED` erfordert separaten Move plus Board-Readback.
2. Wenn `add_task_document_bindings` im entdeckten Katalog vorhanden ist, registriert der Orchestrator vorhandene und verifizierte Compact-Context-/Concept-Plan-Dateien mit einem gebuendelten add-only Call.
3. Danach bleibt `get_task_documents(task_id)` verpflichtend; beide Rollen muessen mit richtigen Pfaden, `state:available` und Revisionen sichtbar sein.
4. Der Board-Move wird nicht in den Binding-Call aufgenommen. Er folgt erst nach `REGISTERED`, und der Taskstatus wird weiterhin separat zurueckgelesen.
5. Orphan-Files-Recovery nutzt denselben Bundle-Call. Exakte Wiederholung ist erlaubt; ein abweichendes Hauptrollen-Binding oder fremde Datei-Task-ID stoppt fail-closed ohne Board-Move.
6. Fuer reale Versionsuebergaenge darf die Skill-Anweisung bei fehlendem neuen Tool auf den bestehenden r20-Zwei-Call-Pfad mit `register_task_document` zurueckfallen, sofern dieses Tool vorhanden ist. Der neue Pfad ist bei Verfuegbarkeit zwingend bevorzugt; Generic Artifact Links bleiben verboten.
7. Management Notes bleiben ein separater, explizit angeforderter Management-Pfad und werden nicht automatisch in die Init-Sequenz eingeschoben.
8. Fuer eine konkrete autorisierte Anschlussnotiz entdeckt der Orchestrator das Note-Tool, liest die bekannte Task und haengt ausschliesslich diese Note an; `get_project_task` prueft den sichtbaren Text. Reine Executive-Summary-/Remainder-/Status-Reads erzeugen keine Note. Dauerhafter Kontext wird vom ausfuehrenden Agenten in den Taskdateien gepflegt, nicht als wachsende Board-Historie dupliziert.

### D. Documentation and release integrity

1. `docs/MCP-INTERFACE.md` beschreibt beide Tools, Annotationen, Idempotenz, Speichergrenzen und den fehlenden UI/MCP-CAS. Die Zahl optionaler Board-Tools wird 16 -> 18 aktualisiert.
2. Taskboard-/README-/AGENTS-Dokumentation wird nur dort angepasst, wo sie die Tool-Oberflaeche oder den neuen Orchestrator-Pfad konkret beschreibt; bestehende Zaehlerdrift wird nicht in eine allgemeine Dokumentationsbereinigung ausgeweitet.
3. Adapter-Version wird bei kuenftiger Auslieferung gegen den dann aktuellen Stand erhoeht (`package.json`, Lockfile, `src/types.ts`, Script-Pin/Dateiname/Hash und zugehoerige Release-Tests). Auf der gelesenen Basis waere 0.1.17 -> 0.1.18 der naechste Schritt; diese Nummer wird nicht parallel reserviert.
4. Jede kuenftige Aenderung an `opencode-vm.sh` erhoeht `OCVM_VERSION` patchweise; auf der gelesenen Basis 0.6.3 -> 0.6.4. Der neue Adapter-Tarball-Digest wird ueber den bestehenden Build-Prozess erzeugt, nicht geraten. Jetzt wird weder Version noch Pin geaendert.
5. Der Orchestrator-Skill erhaelt erst nach dem r20-Handoff-Gate die naechste freie Revision (bei unveraendertem Stand r21), aktualisierte Quellen, Changelog, Bundle-Inventar falls noetig, ZIP, SHA-256 und `latest.json`.

## Architecture and design

### 1. Management-note service method

`ProjectBoardService.addManagementNote(taskId, note)` bleibt bewusst klein und verwendet einmal `withMetadataLock()` fuer kooperierende Note-Writes:

1. Den Note-Input validieren; dann Metadaten im Lock frisch laden und `requireNoPendingTransfer()` anwenden.
2. Task mit `resolveTask()` aufloesen; unbekannte ID vor jeder Mutation ablehnen.
3. Den getrimmten Note-Text in den festen Block `Management Note:\n${note}` rendern.
4. `existing.description ?? ""` unveraendert als Praefix verwenden; bei nichtleerem Praefix `\n\n` und danach den Block anhaengen.
5. Stringlaenge und die prospektive vollstaendige normale Task-Read-JSON-Groesse vor dem PUT pruefen. 32.000-Codeunits allein genuegen fuer Unicode/umfangreiche Sidecar-Daten nicht. Vorhandene Links/Dokumentreferenzen im `getTask`-View mitzaehlen; keinen ueberschrittenen Read erst nach Mutation entdecken.
6. Genau einen PUT auf `/api/tickets/<native-id>` mit Body `{ description }` senden.
7. Das Resultat ueber `publicTask()` zurueckgeben.

Die Methode nimmt absichtlich keinen allgemeinen Patch und schreibt keine Sidecar-Metadaten. Der vorhandene Lock kann Betriebszustand (`.lock`/Verzeichnis) anlegen; er ist keine neue Datenablage fuer Notes. Der frische native GET und der eine PUT liegen fuer alle neuen Note-Writers innerhalb derselben Lock-Lebensdauer. Dies ersetzt die fruehere Konzeptannahme eines vollstaendig lockfreien Note-Pfads: Zwei gleichzeitig lesende Note-Writers koennten sonst trotz enger Inputs die Note des jeweils anderen verlieren. Der Lock serialisiert weiterhin weder Taskboard-UI noch allgemeine Task-Edits und schafft kein globales CAS.

Der sichtbare Block bekommt keinen automatisch erzeugten Zeitstempel und keine Request-ID. Das haelt den Vertrag minimal und deterministisch. Falls spaeter idempotente Note-Replays benoetigt werden, ist das ein eigener Task mit einer belastbaren nativen oder journalbasierten Identitaet; dieser Task behauptet sie nicht.

### 2. Add-only binding service method

`ProjectBoardService.addDocumentBindings(taskId, bindings)` akzeptiert intern ein Objekt mit optionalem `compactContext` und `conceptPlan`. Die Methode laeuft einmal unter `withMetadataLock()`:

1. Mindestens eine Hauptrolle auch auf Service-Ebene verlangen; Metadaten im Lock laden und offene Transfers ablehnen.
2. Task exakt aufloesen.
3. Eingaben in eine geordnete Liste (`compact_context`, dann `concept_plan`) normalisieren.
4. Fuer jede Eingabe rollenabhaengigen Pfad pruefen und `documentBytes(taskId, path)` vollstaendig ausfuehren.
5. Erst danach den aktuellen `metadata.documents[taskId]`-Stand gegen alle Eingaben pruefen:
   - gleicher Pfad unter anderer Rolle -> Konflikt;
   - gleiche Hauptrolle mit anderem Pfad -> Konflikt;
   - gleiche Rolle und gleicher Pfad -> No-op;
   - ungebundene Rolle -> in einen lokalen `updated`-Array aufnehmen.
6. Bei Konflikt ohne Mutation abbrechen.
7. Wenn `updated` dem bestehenden Array entspricht, aktuellen Zustand ohne Save zurueckgeben.
8. Sonst stabile Task-Zuordnung und `documents` einmal setzen, einmal `saveMetadata()` aufrufen und den resultierenden Referenzsatz zurueckgeben.

Diese Methode verwendet dieselben Pfad-/Dateipruefungen wie `registerDocument()`, aber nicht dessen `expectedPath`-Branch. Ein kleiner privater reiner Validator darf extrahiert werden, wenn er Duplikation verhindert; die Writer bleiben getrennt, damit Replace und Add-only semantisch sichtbar bleiben.

### 3. MCP schemas and annotations

Vorgesehene Wire-Schemas:

```text
add_task_management_note:
  input  { task_id: projectTaskId, note: string(1..32000 after trim) }
  output taskOutput

add_task_document_bindings:
  input  { task_id: projectTaskId,
           compact_context?: documentPath,
           concept_plan?: documentPath }
         refine: at least one role
  output { task_id, documents: [{ role, path }] }
```

`projectTaskId` ist fuer diese neuen Inputs die strikte UUID-foermige Form `^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`. Eine globale Verschaerfung des bestehenden permissiven `taskId`-Schemas ist nicht erforderlich und waere eine unnoetige Kompatibilitaetsaenderung.

Beide Tools erhalten explizite Annotation-Objekte statt `writeAnnotations`. Die Beschreibungen nennen die Grenzen: Management Note schreibt nur die native Beschreibung und ist nicht idempotent; Binding schreibt nur neue Sidecar-Referenzen, niemals Dateien oder bestehende Hauptrollen.

Beide Namen werden in `diagnostics.ts` aufgenommen. Diagnostics bleiben metadata-only; Note-Text und Pfade werden nicht neu geloggt.

### Security and MCP annotations

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Begruendung |
|---|---|---|---|---|---|
| `add_task_management_note` (geplant) | false | false | false | false | Enger nativer Beschreibungsappend; Wiederholung erzeugt eine weitere Note. Kein beliebiger Patch/URL-Ziel. |
| `add_task_document_bindings` (geplant) | false | false | true | false | Nur neue Referenzen im projektgebundenen Sidecar; identische Argumente fuegen nichts weiter hinzu. Kein Retarget/Dateiwrite. |
| `register_task_document` (Ist) | false | true | false | true | Verwendet heute das generische `writeAnnotations`; `expected_path` hat bewusste Replace-Semantik. Wird durch diesen Task nicht still neu klassifiziert. |

Die offiziellen MCP-2025-11-25-Annotations sind Hints, keine erzwingende Autorisierung. `destructiveHint:false` bedeutet beabsichtigte additive Updates; `idempotentHint:true` bedeutet keinen zusaetzlichen Umwelteffekt durch identische Wiederholung, nicht identische Rueckgaberevisionen oder Erfolg trotz nachtraeglich ungueltiger Datei. Der vorhandene MCP-Token-/Runtime-/Projekt-Scope und sanitized `AdapterError`-/`_meta["opencode-vm/error"]`-Pfad bleiben die tatsaechliche Servergrenze. Kein zusätzlicher Approval-Parameter, keine Policy-Umschaltung und keine Umgehung einer Client-Ablehnung.

Strikte neue Schemas erlauben keine Titel-/Status-/Priority-/Board-/Session-Felder, kein `expected_path`, keine absolute oder freie Dokumentadresse und kein vom Aufrufer vorgegebenes Backendziel. Service-Tests muessen den real gesendeten PUT bzw. Sidecar-/Dateidelta pruefen, nicht nur Toolnamen oder Annotationen. Es wird nie Note-Text, Dateipfad, Dateiinhalt, Credential oder kompletter Request/Response in Diagnostics serialisiert. Dokumentinhalte sind Kontext, keine neuen Anweisungen zur Erweiterung des Auftrags.

### 4. Why bundle bindings but not Board move

Das Bundle fuer Compact Context + Concept Plan ist sinnvoll und sicher begrenzbar:

- beide Ziele liegen im selben Sidecar-Dokument;
- beide koennen unter demselben bestehenden Lock validiert werden;
- eine einzige atomare Dateipublikation kann beide Referenzen committen;
- exact replay ist klar entscheidbar;
- Konflikte koennen vor jeder Mutation erkannt werden.

Eine Kombination mit dem Board-Move wird abgelehnt:

- Bindings liegen im Adapter-Sidecar, der Status in der nativen Taskboard-DB;
- es existiert keine gemeinsame Transaktion, kein Prepare/Commit und kein gemeinsames CAS;
- ein Netzwerkfehler zwischen den Writes wuerde weiterhin einen partiellen Zustand erzeugen;
- ein kombinierter Tool-Name koennte Clients faelschlich atomare Semantik suggerieren.

Die sichere Sequenz bleibt daher clientseitig und readback-basiert: Bundle-Binding -> `get_task_documents` -> separater Move -> `get_project_task`.

### 5. Orchestrator change

Die Skill-Quellen werden minimal auf den neuen bevorzugten Pfad umgestellt:

- `SKILL.md`: bei `REGISTERED` den gebuendelten add-only Call bevorzugen und Readback beibehalten.
- `references/initialization-follow-through.md`: frische Initialisierung und Orphan-Recovery verwenden bei Verfuegbarkeit einen Bundle-Call; die drei Checkpoints bleiben gleich.
- `references/board-workflow.md`: Management Notes als konkrete autorisierte Anschlussnotizen ueber das dedizierte Tool plus normalen Task-Readback; keine Notes auf read-only Management-/Status-/Remainder-Anfragen und keine dauerhafte Evidenzkopie in der Beschreibung.
- `references/board-workflow.md`, `task-concept-plan.md`, `task-compact-context.md`: denselben Preferred/Fallback-Vertrag ohne doppelte neue Semantik spiegeln.
- `references/regression-scenarios.md`: neue Zeilen fuer Bundle-Erfolg, exact replay und Binding-Konflikt vor Board-Move.
- `tests/chatgpt_skill_test.py`: FakeConnector erhaelt `add_task_document_bindings`; Clean Run und Orphan-Recovery muessen genau einen Binding-Write vor dem Readback verwenden. Konflikt erzeugt keinen Board-Move und keine Dateiaenderung.

Der vorhandene Zwei-Call-Pfad bleibt als expliziter Version-Skew-Fallback fuer bereits veroeffentlichte Adapter erhalten. Sobald der neue Toolname im Katalog vorhanden ist, darf der Orchestrator nicht freiwillig den allgemeineren Replace-faehigen Pfad waehlen. Ein Fehler oder Konflikt des vorhandenen neuen Tools berechtigt aber nicht zum Fallback auf Replace. Alle Skill-Aenderungen beginnen erst nach dem oben definierten r20-Handoff-Gate.

### Interfaces and data flow

```text
Autorisierte kurzfristige Anschlussnotiz
  -> Discovery + task_id/note (strikter MCP-Input)
  -> vorhandener Prozess-Lock -> Metadata-/Transfer-Pruefung
  -> nativen Task frisch aufloesen -> Praefix + Note -> Zeichen-/Bytebudget
  -> genau ein description-only PUT -> normales taskOutput
  -> get_project_task: sichtbare Note pruefen
  Fehler nach moeglicher PUT-Annahme: Outcome unsicher, kein blindes Replay.

Agent erstellt/reconciliiert Dateien -> CONCEPT_READY
  -> Orchestrator prueft Task-ID, Pfade und autorisierten Init-Umfang
  -> add_task_document_bindings(task_id, compact_context, concept_plan)
  -> ein Lock -> Task/Transfers -> beide Dateien -> alle Konflikte
  -> kein Save bei exaktem Replay, sonst eine atomare Schema-3-Publikation
  -> get_task_documents: beide available + exakte Pfade/Revisionen
  -> REGISTERED -> separater move_project_task -> get_project_task
  -> BOARD_MOVED erst mit bestaetigtem in_progress-Readback
```

Speichergrenzen: Notes liegen nur in der nativen Taskboard-Beschreibung; Bindings nur unter `metadata.documents[task_id]` (samt notwendiger stabiler Taskzuordnung); Markdown bleibt Agenten-/Dateisystemarbeit. Detaildokumente bleiben beim alten Registrierungsweg. Ein Sidecar-Commit mit unklarem Rename-/fsync-Ausgang wird read-only reconciliiert; ein identischer add-only Replay ist danach sicher, ein Konflikt kein Anlass zum Retarget. Kein Tool fuehrt automatisch den naechsten Flow-Schritt aus.

## Alternatives considered

### Management notes

- **Sidecar `add_task_comment` wiederverwenden.** Abgelehnt: nicht in der Upstream-UI sichtbar und vom Board explizit als anderes kurzfristiges Management-Instrument getrennt.
- **`update_project_task` nur anders annotieren.** Abgelehnt: das Tool bleibt ein allgemeiner Replace-/Mehrfeld-Pfad; seine Annotation wuerde die tatsaechliche Risikobreite falsch darstellen.
- **Textgleiche Notes deduplizieren.** Abgelehnt: zwei gleiche Anschlussnotizen koennen zwei bewusste Managementereignisse sein. Ohne Request-Identitaet ist Deduplikation semantisch nicht verlaesslich.
- **Request-ID/Journaling fuer Note-Idempotenz.** Fuer diesen Task abgelehnt: wuerde ein neues Cross-Store-Protokoll und Schema benoetigen, ohne Upstream-CAS weiterhin keine volle Atomizitaet liefern und ist nicht gefordert. `idempotentHint:false` ist ehrlicher.
- **Lockfreier nativer Read-modify-write.** Im Review verworfen fuer parallele neue Note-Writers: zwei frische Leser koennten denselben Praefix schreiben und eine Note verlieren. Den vorhandenen Lock wiederverwenden, ohne Metadaten-Save oder neue Lock-Infrastruktur. Weiterhin abgelehnt ist die Behauptung, dieser Lock garantiere UI/MCP-CAS.

### Document bindings

- **Bestehendes `register_task_document` auf add-only umstellen.** Abgelehnt: `expected_path` ist eine bestehende Replace-Faehigkeit; eine stille Semantikaenderung koennte externe Consumer brechen.
- **Zwei neue rollenbezogene Tools.** Abgelehnt: mehr Katalogflaeche und weiterhin partieller Zwei-Write-Zustand im Atomic-Init-Fall.
- **Array beliebiger Rollen akzeptieren.** Abgelehnt: der Task fordert die zwei Hauptrollen. `concept_detail` hat absichtlich andere Multi-Value-Semantik und wuerde Konfliktregeln verbreitern.
- **Bundle plus Board-Move.** Abgelehnt wegen getrennter Speichergrenzen und nicht begruendbarer Fail-Closed-Atomizitaet.
- **Dateien im Binding-Tool erzeugen.** Abgelehnt: verletzt den klaren Add-only-Referenzvertrag und die r20-Trennung zwischen Agenten-Dateiarbeit und Orchestrator-Registrierung.

## Decisions and rationale

- **Decision 2026-09-29: Management Notes sind native Beschreibungsbloecke, nicht Sidecar-Kommentare.**
  - Rationale: Nur die native Beschreibung ist im Board sichtbar und als autorisierter Outcome benannt.
- **Decision 2026-09-29: Management Note ist non-destructive, aber nicht idempotent.**
  - Rationale: Sie fuegt nur Inhalt hinzu, doch jeder Call ist ein bewusstes neues Append; eine Wiederholung kann duplizieren.
- **Decision 2026-09-29: Hauptrollen erhalten einen neuen strukturierten Bundle-Call.**
  - Rationale: Beide Rollen koennen vor einem einzigen Sidecar-Commit validiert werden; dies minimiert Calls und partielle Registrierungszustaende.
- **Decision 2026-09-29: Das Bundle ist strikt add-only und exact-replay-idempotent.**
  - Rationale: Die vorhandene Rolle/Pfad-Menge liefert eine eindeutige Replay- und Konfliktentscheidung ohne Request-Journal.
- **Decision 2026-09-29: `concept_detail` bleibt beim bestehenden Tool.**
  - Rationale: Detaildokumente sind multi-valued und nicht Teil des Atomic-Init-Hauptrollenfalls.
- **Decision 2026-09-29: Board-Move bleibt separat.**
  - Rationale: Native DB und Sidecar koennen nicht atomar gemeinsam committen; Readback-Ordering ist die ehrliche Fail-Closed-Grenze.
- **Decision 2026-09-29: Bestehende Tools bleiben unveraendert.**
  - Rationale: Die neuen engen Faehigkeiten sind additiv und muessen keine bestehenden Consumer oder bewusste Retarget-Workflows brechen.
- **Decision 2026-09-29: Annotationen beschreiben Risiko, nicht Approval-Verhalten.**
  - Rationale: MCP-Hints koennen Client-Policies informieren, erzwingen aber keine konkrete UI-Entscheidung.
- **Reconciliation 2026-09-30 (lokales Datum): Empfehlung B und verbindliches Skill-Handoff-Gate.**
  - Rationale: r20 verifiziert aktuell die exakt gemeinsame Skill-/Test-/Bundle-Schicht; die Adapter-Voraussetzungen bestehen bereits. Ein bestaetigter Baseline-Uebergang reicht, es wird kein kuenstliches Adapter-Warten auf Board-Done eingefuehrt.
- **Reconciliation 2026-09-30: Note-Writers serialisieren und normales Read-Bytebudget vorab pruefen.**
  - Rationale: Additivitaet darf nicht schon zwischen kooperierenden Note-Writern verloren gehen; 32k JavaScript-Zeichen garantieren keinen 40k-UTF-8-Taskread. Keine neue Datenbank-/UI-CAS-Zusage.

## Error and boundary semantics

| Situation | Expected result |
|---|---|
| Unbekannte syntaktisch gueltige Task-ID | `TASK_NOT_FOUND`; kein Write. |
| Management Note leer nach Trim | `INVALID_ARGUMENT`; kein GET/PUT nach Schemafehler. |
| Resultierende Beschreibung > 32.000 Zeichen | `TASK_DESCRIPTION_LIMIT`; kein PUT, keine Trunkierung. |
| Prospektiver normaler Task-Read > 40.000 UTF-8-JSON-Bytes | Bestehende Coverage-/Budgetgrenze (`TASK_SEARCH_INCOMPLETE`) vor PUT; keine Note erzeugen, die anschliessend nicht normal lesbar ist. |
| Taskboard-PUT unklar/timeout | `TASKBOARD_UNAVAILABLE`/`TASKBOARD_ERROR`; kein automatischer Retry, Outcome nicht als idempotent darstellen. |
| Binding-Pfad ausserhalb Rollenregel | `TASK_DOCUMENT_PATH_INVALID`; kein Sidecar-Write. |
| Datei fehlt | `TASK_DOCUMENT_MISSING`; kein Sidecar-Write. |
| Erste `Task-ID` gehoert anderer Task | `TASK_DOCUMENT_MISMATCH`; kein Sidecar-Write. |
| Hauptrolle bereits mit anderem Pfad gebunden | `TASK_DOCUMENT_CONFLICT`; gesamtes Bundle unveraendert. |
| Pfad bereits unter anderer Rolle | Defensive Konfliktgrenze; im heutigen gueltigen Schema sind Rollenpfade disjunkt. Ein korruptes Sidecar wird bereits als `TASKBOARD_METADATA_ERROR` abgelehnt, nicht als kuenstlich erreichbarer Bundle-Konflikt dargestellt. |
| Eine Bundle-Datei gueltig, zweite ungueltig | Gesamter Call scheitert; keine neue Referenz. |
| Beide Bindings exakt vorhanden | Erfolg, kein Save, identische Referenzmenge. |
| Eine Rolle exakt, eine fehlt | Erfolg; nur fehlende Rolle wird in einem Save hinzugefuegt. |
| Transfer unresolved | bestehendes `TASK_TRANSFER_UNRESOLVED`; weder Note noch Binding wird begonnen. |

## Implementation plan

Alle Phasen beginnen erst in einem separat autorisierten Implementierungsauftrag. Die aktuelle Initialisierung endet mit `CONCEPT_READY`; Registrierung/Readback/Board-Move gehoeren zum Orchestrator.

**Phase I — parallel-faehige Adapter-/Testschicht:** Schritte 1–7, ohne Skill-/Bundle-/Python-Flow-Test-Aenderungen oder laufenden Runtime-Restart. Erst Service-/Wire-Semantik beweisen; Dokumentbindings sind der konservativere Einstieg, danach Note-Append mit offengelegter nativer CAS-Grenze.

**Phase II — nach r20-Handoff-Gate:** Schritt 8 auf bestaetigter Quellen-/Testbasis. Readbacks/Checkpoint-Namen bleiben erhalten; Note-Management-Pfad separat integrieren.

**Phase III — serialisierte Paket-/Auslieferungsvorbereitung:** Schritte 9–10; aktuelle Versionsnummern erneut lesen. Builds/Pins/Checks sind geplante Implementierungsverifikation, kein Release-/Push-/Deploy-Auftrag.

1. **Service tests zuerst ergaenzen** in `adapters/mcp/src/taskboard.test.ts`:
   - Fake-Backend-PUT-Body erfassen und Management-Note-Faelle abbilden.
   - Add-only Einzel-/Bundle-Erfolg, exact replay/no duplicate, gemischter Replay+Add, Task-ID-Mismatch, Rollen-/Pfadkonflikt und All-or-nothing pruefen.
2. **Service implementieren** in `adapters/mcp/src/taskboard.ts`:
   - Beschreibungsgrenze als benannte Konstante passend zum Wire-Schema.
   - `addManagementNote()` mit einem description-only PUT.
   - Vorhandenen Lock fuer kooperierende Note-Writes und 40.000-Byte-Preflight wiederverwenden; kein Sidecar-Inhaltswrite fuer Notes.
   - `addDocumentBindings()` unter einem Lock, vollstaendige Vorvalidierung, Konfliktpruefung, No-op-Replay und maximal ein Save.
   - Bestehendes `registerDocument()` nur minimal refaktorieren, falls ein reiner gemeinsamer Validator Duplikation vermeidet; Replace-Verhalten nicht aendern.
3. **Wire-Schemas definieren** in `adapters/mcp/src/tools.ts`:
   - striktes neues `projectTaskId`-Input-Schema;
   - Management-Note-Input;
   - Hauptrollen-Bundle-Input mit mindestens einer Rolle;
   - bestehende Output-Schemas wiederverwenden.
4. **Tools zweimal verdrahten** in `tools.ts`:
   - `server.registerTool(...)` fuer beide;
   - `CallToolRequestSchema`-Dispatch fuer beide;
   - explizite Low-Risk-Annotations je Tool;
   - klare Beschreibungen ohne Approval-Versprechen.
5. **Diagnostics aktualisieren** in `adapters/mcp/src/diagnostics.ts`; nur Namen, keine Payload-Inhalte.
6. **MCP-Wire-/Katalogtests aktualisieren** in `adapters/mcp/src/http.test.ts`:
   - Board-Toolzahl 18;
   - alle vier Annotationen beider Tools exakt pruefen;
   - mindestens je einen erfolgreichen Call und strukturierte Fehlercodes pruefen;
   - Feld-Isolation ueber aufgezeichneten Backend-Request pruefen.
7. **Vertragsdokumentation aktualisieren**:
   - `docs/MCP-INTERFACE.md` Tooltabelle, Toolzahl, Idempotenz, native-/Sidecar-Grenzen, kein CAS, kein Approval-Versprechen;
   - `TASKBOARD-INTEGRATION.md` und knappe README/AGENTS-Stellen nur soweit die aktuelle Oberflaeche direkt beschrieben wird.
8. **Nach bestaetigtem r20-Handoff Orchestrator-Quellen auf Preferred Bundle umstellen**:
   - `SKILL.md` und die relevanten Referenzen;
   - Regressionstabellen;
   - `tests/chatgpt_skill_test.py` mit einem gebuendelten Call fuer Clean Run/Orphan-Recovery und einem Konfliktfall ohne Board-Move;
   - Management-Note-Discovery/Autorisierung/Readback und Read-only-Negativfaelle;
   - naechste Skill-Revision, Changelog und Bundle-Artefakte.
9. **Versionen und Release-Pins aktualisieren**:
   - naechste freie MCP Adapterversion (auf der Reviewbasis 0.1.18) in `package.json`, `package-lock.json`, `src/types.ts`;
   - Adapter-Tarball bauen und Script-Pin/Dateiname/SHA aktualisieren;
   - naechster `OCVM_VERSION`-Patchbump (auf der Reviewbasis 0.6.3 -> 0.6.4) wegen `opencode-vm.sh`-Aenderung;
   - Release-Metadaten-Tests angleichen.
10. **Gesamtverifikation ausfuehren** und nur taskbezogene Fehler beheben. Pre-existing, nicht erforderliche Zaehler-/Dokumentationsdrift lediglich berichten.

## Test strategy and acceptance matrix

### Service-level management-note tests

1. **Append to existing description**: Beschreibung `Original` -> `Original\n\nManagement Note:\nFollow up`; Rueckgabe zeigt den neuen Text.
2. **Append to empty description**: kein fuehrender Separator; Block beginnt direkt.
3. **Multiple append**: zwei Calls erzeugen zwei Bloecke in Reihenfolge; erster Block bleibt unveraendert.
4. **Preserve existing text**: mehrzeiliger Text inklusive bestehender Ueberschriften/Trailing Content ist exaktes Praefix.
5. **Field isolation**: aufgezeichneter PUT-Body besitzt exakt den Key `description`; bestehende title/status/priority-Daten werden nicht gesendet oder adapterseitig veraendert.
6. **Unknown task ID**: `TASK_NOT_FOUND`; kein PUT.
7. **Bounds**: leere Note und Beschreibungsoverflow scheitern vor PUT; keine Trunkierung.
8. **Unresolved transfer**: bestehender Fail-Closed-Fehler; kein PUT.
9. **Concurrent cooperating writers**: zwei ueberlappende Calls derselben/neuer Serviceinstanz behalten beide Bloecke; frischer GET im Lock, genau ein PUT pro erfolgreichem Call, keine Sidecar-Publikation. Kein behaupteter UI-Lock.
10. **Unicode/read byte limit**: prospektive Task-JSON > 40.000 Bytes trotz Beschreibung <= 32.000 Codeunits wird vor PUT abgelehnt; Sidecar-/Link-Overhead mitpruefen. Im erlaubten Grenzfall zeigt `getTask()` die Note normal.
11. **Uncertain outcome**: Fake nimmt PUT an, laesst danach Response/Timeout scheitern; Note kann vorhanden sein, keine zweite PUT-Ausfuehrung, kein behauptetes Rollback und kein automatisches Deduplizieren nach Text.

### Service-level binding tests

1. **Single role success**: Compact Context wird addiert, Datei bleibt byteidentisch.
2. **Bundled success**: beide Hauptrollen werden in Rollenreihenfolge mit genau einer Sidecar-Publikation sichtbar.
3. **Exact replay**: identischer Bundle-Call gibt Erfolg, keine Duplikate und kein erneutes Save.
4. **Partial existing plus add**: eine exakte Rolle bleibt, zweite wird addiert.
5. **Task-ID mismatch**: eine Datei mit fremdem Header erzeugt `TASK_DOCUMENT_MISMATCH`; keine Rolle aus demselben Bundle wird addiert. Auch Replay revalidiert die Datei und akzeptiert keinen inzwischen fremden Header.
6. **Role conflict**: bestehendes `compact_context` auf der anderen erlaubten kanonischen Pfadvariante erzeugt `TASK_DOCUMENT_CONFLICT`; keine Retargeting-Moeglichkeit. Die eine kanonische `concept_plan`-Adresse bleibt exact replay.
7. **Cross-role/path corruption**: heutige Rollenpfade sind disjunkt; ein dafuer manipuliertes Sidecar muss bereits mit `TASKBOARD_METADATA_ERROR` fail-closed bleiben. Keine unmoegliche gueltige Fixture oder Lockerung des Parsers nur fuer den neuen Test.
8. **Path validation**: Traversal, falscher kanonischer Name, Symlink-Komponente, nicht regulaere Datei, invalid UTF-8, zu grosse oder fehlende Datei verwenden die bestehenden Fehlercodes; kein Sidecar-Write.
9. **Field isolation**: `comments`, `links`, `transfers`, andere Tasks und bestehende `concept_detail`-Referenzen bleiben unveraendert.
10. **Unknown task ID and pending transfer**: bestehende Fehler, keine Metadatenpublikation.
11. **Legacy metadata**: Schema-2 Read bleibt write-frei; erster erfolgreicher neuer Binding-Write publiziert valides Schema 3 wie bisher.
12. **Concurrent bundle writers**: zwei identische Requests behalten einen Referenzsatz; widersprechende Compact-Pfadvarianten gewinnen nicht still, eine Publikation und ein Konflikt. Nicht nur Zeitstempel beobachten: atomare Publikation/exaktes Replay anhand Bytes und Dateiidentitaet bzw. vorhandenem Testbeobachtungspunkt belegen, ohne produktive Testabstraktion einzufuehren.

### MCP wire/catalog tests

1. Beide Tools sind nur bei aktivierter Taskboard-Runtime discoverable.
2. Management Note: exakt `false/false/false/false` fuer `readOnly/destructive/idempotent/openWorld`.
3. Binding: exakt `false/false/true/false`.
4. Invalid Inputs liefern `INVALID_ARGUMENT` und kein `structuredContent`.
5. Servicefehler behalten `_meta["opencode-vm/error"].code`.
6. Katalogzaehler und Dokumentation stimmen mit 18 optionalen Board-Tools ueberein.
7. Diagnostics erkennen beide Namen und loggen keine Note-/Dateiinhalte.

### Orchestrator integration test

Der bestehende Flow-Fake in `tests/chatgpt_skill_test.py` wird um den neuen Pfad erweitert:

1. Agent liefert `CONCEPT_READY` mit beiden vorhandenen kanonischen Dateien.
2. Orchestrator entdeckt `add_task_document_bindings` und ruft es genau einmal mit beiden Rollen auf.
3. FakeConnector prueft Task-ID/Pfade und publiziert beide Referenzen add-only.
4. Orchestrator ruft `get_task_documents` auf und verlangt beide `available`-Eintraege samt Revision.
5. Erst danach erfolgen Board-Move und Board-Readback; Endzustand `BOARD_MOVED`.
6. Es gibt keinen `update_project_task`-, Replace-/Retarget- oder Datei-Edit-Call.
7. Exact-replay-/Orphan-Fall nutzt denselben einen Bundle-Call sicher.
8. Rollen-Konflikt oder Task-ID-Mismatch stoppt vor `REGISTERED`; Board bleibt `todo`, Dateien und bestehende Bindings bleiben unveraendert.
9. Ein separater Version-Skew-Fall ohne Bundle-Tool, aber mit `register_task_document`, behaelt den r20-Zwei-Call-Fallback und denselben Readback bei.
10. Fehlendes/falsches `available`, Pfad oder Revision verhindert `REGISTERED` und den Board-Move. Erfolgreiche Referenzen sind nicht bloss die Liste aller Registrierungsversuche im Fake.
11. Ein nach Annahme unklarer Binding-Commit wird read-only gelesen; identisches Replay dupliziert nichts. Ein unbekannter Ausgang des nicht-idempotenten Board-Moves wird als unbekannt behandelt, nicht als sicheres `todo`; keine zweite Mutation ohne Reconciliation.
12. Autorisierte Note verwendet ein dediziertes Note-Tool plus normalen Task-Readback; Executive Summary/Status/Remainder/Initialisierung ohne Notizauftrag erzeugen keine Note. Fehlendes neues Note-Tool wird nicht automatisch durch einen allgemeinen Description-Replace ersetzt.

### Commands

Zukuenftige Checks pro Schicht, nicht in dieser Konzeptinitialisierung ausgefuehrt. Fuer Adapterbefehle ist `adapters/mcp` das Arbeitsverzeichnis; die uebrigen Befehle laufen am Repo-Root. `npm test` baut `dist/` durch `pretest`, der Adapter-Build und Skill-Rebuild erzeugen Artefakte und sind deshalb jetzt keine schreibfreie Inspection.

```bash
npm run check
npm test
python3 -B tests/chatgpt_skill_test.py
python3 scripts/build-chatgpt-skill.py --check
bash tests/mcp_adapter_test.sh
python3 -B tests/release_metadata_test.py
python3 -B tests/taskboard_state_test.py
shellcheck opencode-vm.sh
```

Nach Adapter-/Script-Pin-Aenderungen ist ausserdem der bestehende Adapter-Build aus `scripts/build-mcp-adapter.sh` zu verwenden, damit der SHA-256-Pin reproduzierbar aktualisiert wird. Reale macOS/Lima- und hosted-ChatGPT-Acceptance wird separat als nicht lokal bewiesen ausgewiesen.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Gleichzeitiger UI-Edit der Beschreibung geht zwischen GET und PUT verloren | Keine falsche CAS-Zusage; engster description-only PUT; keine Auto-Retries; Grenze im Vertrag dokumentieren. Ein echtes Upstream-CAS ist separater Scope. |
| Zwei kooperierende Note-Writers verlieren gegenseitig Notes | Vorhandenen prozessgeteilten Lock um frischen GET/PUT wiederverwenden; Mehrinstanz-Regression. Allgemeine Edits/UI bleiben ausserhalb. |
| Unklarer Management-Note-PUT wird doppelt wiederholt | `idempotentHint:false`, Fehler als unklar behandeln, Client darf nicht blind retryen. |
| Management Note sprengt Task-/MCP-Ausgabegrenze | Stringlaenge und prospektiven vollstaendigen 40k-Byte-Taskread vor PUT pruefen; Unicode/Sidecar-Overhead; keine Trunkierung oder spaete Budgetablehnung. |
| Bundle validiert erste Datei, zweite scheitert | Keine Metadatenmutation vor Abschluss aller Validierungen; ein Save erst nach gesamter Konfliktpruefung. |
| Exact replay schreibt Sidecar dennoch neu | Expliziter Array-Gleichheits-/`changed`-Pfad; Bytes und Dateiidentitaet bzw. bestehender Publikationsbeobachtungspunkt, nicht ausschliesslich timing-abhaengige mtime. |
| Bestehendes Replace-Verhalten wird versehentlich entfernt | Separate neue Methode und bestehende `registerDocument()`-Regressionstests beibehalten. |
| Client deutet `destructiveHint:false` als read-only | `readOnlyHint:false` und Beschreibung nennen technischen Write; Doku verneint Approval-Garantie. |
| Bundle+Move wird spaeter faelschlich als atomar zusammengezogen | Architekturentscheidung und r20-Readback-Sequenz in Vertrag und Regressionstest festhalten. |
| Skill verwendet trotz neuem Tool den allgemeineren Pfad | Capability-Discovery-Test: bei vorhandenem Bundle genau ein Bundle-Call, keine `register_task_document`-Calls. |
| Toolnamen fehlen in einem der zwei Dispatch-Pfade | Wire-Test ruft beide Tools real ueber MCP auf; Katalog- und Raw-Dispatch-Abdeckung. |
| Version-/Artefaktpins driften | Bestehende Build-, `mcp_adapter_test.sh`- und `release_metadata_test.py`-Checks ausfuehren. |
| Neue Skill-Aenderungen veraendern laufende r20-Verifikation | Empfehlung B; Adaptertests zuerst, korreliertes Abschlussresultat/Ownership-Handoff vor Skill-/Fake-/Bundle-Writes; Versionsnummern neu lesen. |

## Open concept questions

- **r20-Integrationsgate geschlossen:** korreliertes Original gelesen und bestaetigte Quellen/Test-/Paketbasis uebernommen. Dessen Hosted-/Voice-Gap wird nicht durch synthetische Folgetests als geschlossen behauptet.
- **Note-Restgrenze akzeptiert:** Management bestaetigt den fehlenden globalen Append-Erhalt gegen nicht kooperierende UI-/Edit-Writes. Kein CAS-Unterbau und keine blinden Retries; der additive Hint bleibt eine eng begrenzte Absicht, keine Race-/Approval-Garantie.
- **Versions-Reconciliation abgeschlossen:** lokale Kandidaten Script 0.6.4, Adapter 0.1.18, Skill r21 gebaut/geprueft, nicht veroeffentlicht.
- Hauptrollen-Bundle ja, `concept_detail` im alten Pfad, Board-Move separat, Note non-idempotent, Bundle exact-replay-idempotent, alte Replace-API unveraendert. `TASK_DESCRIPTION_LIMIT` ist implementiert; bestehende Datei-/Coveragefehler bleiben erhalten. Keine offene Konzeptentscheidung fuer diesen Scope.

## Acceptance evidence levels

| Ebene | Was ein spaeterer Nachweis belegt | Aktueller Stand |
|---|---|---|
| Dokumentinitialisierung | Dateien vorhanden, richtige Head-IDs, task-spezifischer Plan und klare Grenzen | Reconciliiert und ueber Datei-Readback geprueft; Head-IDs stimmen exakt. Abschliessender Check vor terminalem Bericht, keine Produktumsetzung. |
| Adapter-Service-/Wire-/Diagnostics-Tests | Append/Feld-Isolation, sichere add-only Bindings, Bundle-Publikation, korrekte Annotationen/Fehler ohne Payload-Logs | Implementiert; finale Adapter-Suite 97/97 pass ohne skips. |
| Skill-Fake-/Pakettests nach r20 | Preferred/Fallback-Vertrag, synthetische Sequenz und konsistentes Bundle | r20-Handoff bestaetigt; r21 integriert, 16 Tests und Paketcheck gruen. |
| Reale macOS/Lima-/Taskboard-Acceptance | Native Beschreibung, normale Reads, Bindings und separater Init-Readback mit realem gepinnten Backend | Disposable VM-seitiger realer Taskboard/OpenCode/MCP-Smoke aus Source und Produktionspaket gruen; kein Hosted-/macOS-Host-Rebuild-/visueller UI-Nachweis daraus abgeleitet. |
| Hosted ChatGPT/Voice-/Approval-Acceptance | Tatsaechliche Discovery, Nutzung und Host-/Client-Policy-Verhalten | Separat offen; korrekte Hints garantieren keine unterdrueckte Approval und Packaging keinen Hosted-Erfolg. |

## Evidence / references

- `adapters/mcp/src/taskboard.ts:10-40` Dokumenttypen und Schema-3-Metadaten.
- `adapters/mcp/src/taskboard.ts:166-176` rollenbezogene Pfadregeln.
- `adapters/mcp/src/taskboard.ts:273-305` aktuelles Register/Replace-Verhalten.
- `adapters/mcp/src/taskboard.ts:361-412` sichere Datei-/Task-ID-Validierung.
- `adapters/mcp/src/taskboard.ts:445-483` allgemeiner Task-Update- und Sidecar-Comment-Pfad.
- `adapters/mcp/src/taskboard.ts:947-1059` Backend-Request, atomare Metadatenpublikation und Locking.
- `adapters/mcp/src/tools.ts:78-99` bestehende Task-/Dokumentschemas.
- `adapters/mcp/src/tools.ts:775-787` aktuelle Annotation-Konstanten.
- `adapters/mcp/src/tools.ts:807-979` Taskboard-Katalogregistrierung.
- `adapters/mcp/src/tools.ts:1753-1867` zweiter Tool-Dispatch-Pfad.
- `adapters/mcp/src/taskboard.test.ts:109-226` Dokument- und Init-Recovery-Tests.
- `adapters/mcp/src/http.test.ts:720-819` MCP-Wire-/Katalogtest.
- `docs/MCP-INTERFACE.md:686-715` kanonischer Taskboard-Vertrag und Grenzen.
- `integrations/chatgpt/opencode-session-orchestrator/references/initialization-follow-through.md` r20-Checkpoint-/Recovery-Vertrag.
- `integrations/chatgpt/opencode-session-orchestrator/references/board-workflow.md` geordnete Board-Sequenz.
- `tests/chatgpt_skill_test.py` r20-Flow-Fake und Skill-Pakettests.
- Live GET-/Read-Inspection: aktueller project-local Taskboard-Listenendpunkt, Schema-3-Sidecar und exakte verknuepfte r20-Verifikations-Session/status; IDs werden in Board/Session-Historie gehalten, keine Mutationen fuer Evidence.
- `adapters/mcp/src/tools.ts:1946-2070` Schema-/Error-/Result-/Readbudget-Verhalten: `success()` selbst hat keine pauschale Task-/64-KiB-Budgetpruefung; das Budget muss fuer den neuen Note-Pfad vor dem nativen Write beruecksichtigt werden.
- `adapters/mcp/src/diagnostics.test.ts` bestehende metadata-only Logging-Tests; spaeter mit den zwei neuen Namen ohne Note-/Pfadinhalt erweitern.
- Offizielle MCP-Baseline, gelesen im Review: https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations (Hints, additive/destructive, Replay-/Closed-world-Semantik). Kein SDK-/Protokollupgrade daraus abgeleitet.
- `adapters/mcp/package.json`, `adapters/mcp/src/types.ts`, `opencode-vm.sh`, `tests/mcp_adapter_test.sh`, `tests/release_metadata_test.py` Versions-/Release-Pins.
