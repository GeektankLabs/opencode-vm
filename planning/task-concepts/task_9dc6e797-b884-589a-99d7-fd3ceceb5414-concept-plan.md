Task-ID: task_9dc6e797-b884-589a-99d7-fd3ceceb5414
Title: Orchestrator Skill – agent-managed Worktree-Isolation und persistente Arbeitspakete
Status: active
Last-concept-update: 2026-09-30T21:54:33+02:00

# Kanonischer Concept Plan

## 1. Problem, Ziel und Dokumentrollen

Agent-managed Sessions dürfen innerhalb ihres autorisierten Scopes Änderungen und lokale Commits autonom ausführen. Eine eigene Session isoliert jedoch weder Working Tree noch Git-Index. Mehrere Session-/Agent-Aufträge können deshalb denselben Tree verändern. Ein Session-Ergebnis, eine Boardkarte und ein Commit sind zudem keine ausreichende Darstellung eines länger laufenden Mehrtask-Laufs mit Abhängigkeiten, Integration und Wiederaufnahme.

Ziel ist eine generische Orchestrator-Skill-Konvention für eindeutige Git-/Worktree-Ownership bei agent-managed Schreibarbeit und ein separates persistentes Board-Arbeitspaket für Nightly- und andere Mehrtask-Läufe. Die Skill-Konvention koordiniert; sie verspricht keine native OpenCode-Worktree-Sandbox, keine Board-/Git-Transaktion und keine automatische Überwachung.

Boardkarte = Outcome und Scope. Dieser Plan = vollständiges, kanonisches Design innerhalb dieses Scopes. Compact Context = knapper aktueller Zustand. Originale Sessionresultate, Datei-/Git- und Testergebnisse = Ausführungsevidence. Diese Dokumente überschreiben weder Scope noch Autorisierung.

## 2. Verifizierte Basis und Abhängigkeiten

### 2.1 Agent-managed Sessions V1

Die zuvor explizit erwartete Abhängigkeit ist lokal implementiert und terminal abgeschlossen. Verifiziertes Originalresultat: Session `ses_f10559f87ffeE11x7hm34rzgT1`, Assistant `msg_0f36a7083001QHYgOYrMRgJgx8`, `finish:stop`, Completion-Zeit vorhanden, Fehler null, Textmarker `LOCALLY_IMPLEMENTATION_COMPLETE`.

- Runtime-/Integrationscommit: `4d3c37ae58511e84e801d78c289bfe2157859e7b`.
- Dokumentations-/Acceptance-Commit: `d6f41cc8832895a5edbc181d1b6cd764f53ea65c`.
- Exakter lokaler Endstand während der Konzeptaufnahme: `d6f41cc8832895a5edbc181d1b6cd764f53ea65c`.
- Gemeldete/aufgenommene Versionen: Script 0.6.7, MCP 0.1.21, OpenLive 0.1.7, Skill r24.
- Kein Push, Release oder Deployment; der aktive Produktivconnector wurde nicht neu gestartet/restaged. Lokale Implementierung ist daher kein Nachweis einer bereits produktiv aktivierten Runtime.

`docs/MANAGED-SESSIONS.md`, `runtime/managed-policy.mjs`, `runtime/managed-core.mjs`, MCP/A2A/OpenLive-Ingresscode sowie Maintained-Tests belegen: Backend-Workadmission adoptiert serverseitig ohne Clientflag; Reads/pure Management bleiben neutral; Reuse/Children werden vor Work vorbereitet; normale lokale Gitoperationen/-commits sind innerhalb Taskscope autonom; fachliche Rückfragen enden über den echten Runner als normales terminales `INPUT_REQUIRED`; Remote-Publishing bleibt operator-only. Echte Sicherheits-Permissions bleiben separat.

Die Policy führt **keine** Worktree-, Paketmitglieds-, Basis- oder Integrationspersistenz ein. Mehrere Sessions teilen in einer Runtime das Verzeichnis. Die lokale Git-Autonomie gestattet keine Scopeausweitung.

### 2.2 Bestehende Board-/Session-/Dokumentgrenzen

- `adapters/mcp/src/opencode.ts` exponiert Root-Work-Sessions nur für das beim Runtime-Start festgelegte Projekt und dessen exaktes Directory. `create_session` hat kein Directory-/Worktree-Argument (`docs/MCP-INTERFACE.md`, Abschnitt `create_session`).
- A2A beschreibt einen fixierten Workspace und eine gemeinsame Working Tree für Web, REST und A2A (`docs/A2A-INTERFACE.md` §§1, 8).
- Projekt-Taskboard ist project-local. Es bietet Task-/Board-Reads, Task-Dokumentbindungen und Links auf Session/Message/Result/Artefakte; keine eingebaute Worktree-Relation, Batch-Mitgliedschaft oder Implementierungs-/Integrationssynchronisation (`adapters/mcp/src/taskboard.ts`, `docs/MCP-INTERFACE.md`, Taskboard-Abschnitte).
- C/P werden über feste task-ID-markierte Pfade, `add_task_document_bindings`, `get_task_documents` und revisionierte Reads identifiziert. Bundle-Write, Board-Move und Dateiinhalte teilen keine gemeinsame Transaktion. Vorhandene Regeln zu `CONCEPT_READY` → `REGISTERED` → `BOARD_MOVED`, Header-Evidence und Unsicherheitsreadback bleiben bindend.
- Ein neues Paket verwendet dieselben Projekt-Task-/Dokumentfähigkeiten. Zunächst weder MCP-Schema noch Board-Sidecar um Paketfelder erweitern.

### 2.3 Nightly Run 2026-09-30 als Referenz

Die fünf bestehenden Mitglieds-IDs werden wiederverwendet, nicht dupliziert:

| Task | Gelesener Stand | Bedeutung fürs Paket |
|---|---|---|
| `task_cce3a196-9611-5cf6-9f74-c98720211548` | Board done; atomarer Dokument-Follow-through | Dokumentregistrierung/Boardstatus sind unterschiedliche Übergänge. |
| `task_d9944c0e-5acb-5d73-8030-4fbc0c025be0` | Board done; r21 lokal integriert als `39f975ad…` | Done-Mitglied kann weiterhin notwendige Integrationsbasis sein. |
| `task_ac329f45-aa82-5c86-825a-6205aac38ee1` | Board in_progress; isolierter Quellcommit `13694bd…`, integrierter Stand `ce5c85c…`; separater Worktree | Isolierte Entwicklung, Reconciliation und nachfolgende Integration getrennt erfassen. |
| `task_4bae0002-9e0e-5722-b287-a5b4338c1ba3` | Board in_progress; Quellcommit `a196a172…`, Integration `7406030…`; Worktree enthält geänderten Compact Context | Produktcommit-Integration allein erlaubt kein Cleanup. |
| `task_25b3af4f-e97f-5707-b523-13bcc99ed03c` | Board in_progress; zwei lokale Commits, lokaler Abschluss, externe Abnahme offen | Nachgelagerte Integration startete nach konsolidierter Basis; Board/Session/Integration/Abnahme bleiben getrennte Wahrheiten. |

Vorhandene Worktrees unter `/tmp/opencode/` sind temporäre historische Evidence, kein persistenter Morgen-Handoff. Aufnahmen der C/P und gelesene Board-/Sidecarzustände zeigen außerdem, dass der Paketkontext direkte Links und beobachtete Zustände braucht; Boardstatus allein genügt nicht.

## 3. Entscheidungen und Begründung

1. **Worktree-Ownership gilt für jede agent-managed Schreibarbeit**, nicht nur für Batch-Mitglieder. Ein einzelner sequenzieller Task kann im explizit freigegebenen Integration-Tree arbeiten; parallele Schreibarbeit nutzt getrennte Arbeitskopien. Pro Working Tree/Index gibt es höchstens einen aktiven schreibenden Owner.
2. **Task-Worktrees sind kurzlebig, taskbezogen und persistent abgelegt;** Branches sind optional. Detached Worktrees sind erlaubt. Im opencode-vm-Projekt ist `.opencode-vm/worktrees/<vollständige task_id>` der vorgeschlagene Standard, da `.opencode-vm/` bereits ignoriert ist und unterhalb des gemounteten Projektroots liegt. Der Skill prüft Persistenz, Git-Worktreezuordnung, Mount-/Toolzugänglichkeit und Ignoreverhalten; für andere Repositories wird kein Pfad vorausgesetzt.
3. **Keine Behauptung nativer Session-Worktree-Bindung.** Gegenwärtige MCP-/A2A-Sessions sind projektpfadgebunden. Ein Worker muss für tatsächliche Schreibwerkzeuge den effektiven Worktree prüfen. Wo eine getrennte/scoped Runtime erforderlich ist, braucht sie eine vom Operator vorbereitete passende Projektverbindung. Wo die gewählte Tooloberfläche den vorgesehenen Tree nicht zuverlässig targeten kann, stoppt die Schreibwelle; weder Prompttext noch ein separater Shell-`workdir` beweist, dass alle Edit-Tools im selben Tree arbeiten.
4. **Minimaler persistenter Paketspeicher ist Board-Management-Task + C/P.** Paket-Mitgliedschaft, Gitbelege und Wellenplan werden als task-ID-markiertes Markdown geführt. Kein neues natives MCP-Datenmodell, solange der dokumentierte Vertrag und belegbare Wiederaufnahme genügen.
5. **`WORK_PACKAGE_READY`** ist das Readiness-Gate für eine explizit benannte erste beziehungsweise nächste Welle, nicht für alle späteren Paketmitglieder. Es bleibt von `CONCEPT_READY`, `REGISTERED`, `BOARD_MOVED`, Taskabschluss und externer Abnahme getrennt.
6. **Integration hat einen serialisierten Owner.** Quellen werden nach Basisvergleich über gezieltes Cherry-pick oder semantische Reconciliation eingebracht. Gemeinsame Version-/Bundle-/Release-Hunks werden nicht parallel im Integrations-Tree editiert.
7. **Cleanup ist fail-safe.** Keine automatische Löschung bei Dirty-State, fehlender Evidence, unklarer Integration, offener Arbeit oder benötigter externer Abnahme.
8. **Work ist eine Managementoberfläche, OpenCode-VM die Repositorylaufzeit.** Im normalen Chat wird geplant/besprochen; tatsächliche länger laufende Paketkoordination geht sichtbar in ChatGPT Work. Der Skill startet Work nicht automatisch und behauptet keine API dafür. Aktuelle ChatGPT-Work-Verfügbarkeit ist konto-/plan-/workspaceabhängig.
9. **Runtimeempfehlungen bleiben projektbasiert und dynamisch.** `execution` für vollständig geplante deterministische Steuerung, `standard` für gewöhnliche Mehrtaskkoordination, `deep` für erhebliche Konflikte/Architekturdiagnose. Die konkrete äußere Work-Runtime ist eine Anzeige-/Auswahlhilfe; OpenCode-MCP-Runtimewechsel ändert ChatGPT Work nicht.
10. **Autonomie ist planbegrenzt.** Kleine/mittlere technische Details werden eigenständig gelöst. Fehlende grundlegende Produkt-, Architektur-, Schema-, Datenmodell- oder Sicherheitsentscheidung wird terminal als `INPUT_REQUIRED` zurückgegeben; betroffene Arbeit parkt sauber, unabhängige Wellen können auf verifizierter Basis fortfahren.

## 4. Allgemeiner Git-/Worktree-Vertrag

### 4.1 Auswahl und Vorbereitung

Vor substantieller Schreibarbeit klassifiziert der Orchestrator den Task als read-only oder mutierend. Reine Reads/Reviews benötigen keinen separaten Worktree. Schreibarbeit erhält explizite Tree-Ownership:

- sequenziell und allein im Integration-Tree nur bei bestätigter Exklusivität, ohne fremden aktiven Indexowner oder unerklärte/überlappende Änderungen; bekannte unabhängige Leftovers bleiben über eine explizite Task-Pfad-Allowlist geschützt;
- parallel standardmäßig in je eigenen Task-Worktrees;
- gemeinsam berührte Versionen, Packages, Adapter, Skillbundle, Launcher, Submodule, Generated Files oder Shared-Hunks entweder sequenziert oder isoliert mit später geplanter Reconciliation;
- unklarer Index/Owner, fehlende Persistenz oder nicht verifizierbare Session-/Toolpfadbindung verhindert den Start der betroffenen Write-Welle.

Vor Write werden `git rev-parse --show-toplevel`, `--git-dir`, `--git-common-dir`, aktueller HEAD, `git status --short` inklusive untracked Dateien, Branch/Detached-Zustand, benötigte Submodule und Zielpfad verifiziert. Der Orchestrator protokolliert Initialzustand und speichert den Start-Basis-HEAD unveränderlich. Ein vorhandener Nutzer-/Fremd-Diff wird weder gestasht noch zurückgesetzt/committed. Änderungen werden nur in task-eigene Pfade integriert.

Ownership gilt repositoryweit auch gegenüber anderen Paketen und manuellen/Editorschreibern. Dieselbe Mitglieds-ID in mehreren Paketen bedeutet eine vorhandene Ausführung mit gemeinsam konsumierter Evidence, nicht mehrere Worker. Physische Tree-/Git-Identität entscheidet; Aliasnamen, idle oder verschwundener Manager und veraltete Contextzeit beweisen keine Freigabe. Unvollständige Ownershipevidence stoppt betroffene Writes. Kein nativer Lease/CAS wird dadurch eingeführt.

### 4.2 Pflichtmetadaten im Compact Context

Je Write-Task: stabile `task_id`; Projekt/Connector; Owner-Session und aktueller Verantwortlicher; Worktreepfad; Git-Directory und Common-Git-Directory; Startbasis-HEAD; aktueller HEAD; Branch/Detached; Commit-SHAs oder bewusst uncommitteter Status; vollständiger relevante Dirty-/Index- und Untracked-Status; Scope-/Subsystem- und Shared-Dateiüberschneidung; Integrationsziel samt Voraussetzung; letzte Verifikationszeit und Quellen.

Commitnachrichten referenzieren Task-ID, wenn das Repositorymuster es zulässt. Das ist Audit-Hilfe, keine alleinige Ownershipgarantie. Ein Commit beweist nur lokalen Gitzustand, nicht Integration oder Boardabschluss.

### 4.3 Persistenz, Reuse und Grenzen gemeinsamer Gitdaten

Task-Worktrees liegen unter einer dauerhaften, gemounteten und vom übergeordneten Worktree ignorierten Ablage. `/tmp` ist nur mit expliziter Disposal-/Snapshot-Evidenz zulässig. Worktree, Git- und Common-Git-Verzeichnisse müssen für den Operator nach Sessionende erreichbar sein. Der Orchestrator behauptet keine Persistenz, bis Pfad und Gitzuordnung geprüft wurden.

Für Wiederaufnahme desselben Tasks werden C/P, konkrete Sessionresultate und aktuelle Gitdaten neu gelesen. Ein Worktree wird nicht wegen gleicher Task-ID automatisch als sauber/eigen angenommen. Reuse setzt fortbestehende Identität, bekannte Basis und geklärte Ownership voraus. Wechsel der Owner-Session wird dokumentiert.

Linked Worktrees teilen Git-Objekte und einige Repositorymetadaten/Refs. Taskbranches und Ref-Namen sind kollisionsfrei. Keine gleichzeitige Änderung derselben Branch, globaler Gitkonfiguration, gemeinsamer Tags, Worktreeverwaltung oder Garbage Collection. Submodules und gemeinsame Build-/Testausgaben sind gesonderte Konfliktflächen.

Der kanonische Dokumentroot des Connectors und der Code-Worktree werden im tatsächlichen Member-Handoff getrennt benannt. Worker lesen die registrierten C/P samt Revision, pflegen task-eigene unveröffentlichte Arbeitsfassungen und liefern einen darauf basierenden Delta. Der Dokument-/Integrationsowner publiziert seriell nur diesen Delta auf unveränderte reguläre kanonische Taskpfade nach frischem Inhalts-/Revisionsvergleich und Header-/available-Readback. Stale Copy, Symlink und stilles Retarget sind keine Publikation. Paket-C/P haben einen Schreibowner. Nach Unterbrechung/Ungewissheit werden vorhandene Bytes und Worker-Delta geprüft, kein blinder Retry. Der Worker bleibt Inhaltsverantwortlicher; dies konkretisiert die bereits ausgearbeitete zentrale Publikationsstrategie.

### 4.4 Integration, Sequenzierung und Cleanup

Ein Integrator besitzt den gemeinsamen Ziel-Tree allein. Vor Übernahme werden Quellcommit, dessen Parent/Basis, Ziel-HEAD, tatsächlicher Diff, Scope und aktuelle Dirty-Dateien geprüft. Saubere, unabhängige Diffs können gezielt integriert werden. Überlappende Dateien/Hunks/Metadaten werden semantisch reconciliiert, nicht durch blindes Cherry-pick, `ours`/`theirs` oder Dateikopie ersetzt. Kombinierte passende Regression läuft danach. Gemeinsame Skill-/MCP-/Release-Artefakte werden auf Zielbasis regeneriert/verifiziert.

Jeder Integrationsdatensatz hält Quelltask, Quellcommit, Quellbasis, Zielbasis davor, Zielcommit/-HEAD danach, integrierte Bereiche, bewusst ausgeschlossene Bereiche und Acceptance-Evidence fest. Ein Source-Commit muss nicht Vorfahr des Ziel-HEAD sein, wenn seine Änderungen nachweisbar semantisch portiert wurden.

Abhängige Wellen starten erst nach Readback des tatsächlichen integrierten Ziel-HEAD und Abgleich gegen den in ihrem Plan erwarteten Stand. Ein neuerer Commit allein genügt nicht, wenn die erforderlichen Changes fehlen. Ein geparkter Task hält nicht unabhängige Wellen auf.

Worktree bleibt erhalten bei Work-in-progress, Dirty-/Untracked-Daten, ungeklärten Outputs, fehlender Integration, unerledigtem Ergebnisreview oder benötigter Abnahme. Entfernen nur nach verifiziertem Ownerstillstand, explizit autorisiertem Cleanup, Sicherung/Integration relevanter Arbeit und persistentem Nachweis. Kein force-remove, Reset, stilles Stashen oder Löschen fremder Dateien.

Auch relevante ignorierte Outputs werden vor Entfernung geprüft; normales clean `git status` genügt dafür nicht. Ein nach semantischer Integration nicht vom Ziel erreichbarer detached Quellcommit wird vor Cleanup durch eine verifizierte eindeutige taskeigene lokale Referenz oder ein dauerhaftes Gitbundle erhalten. Eine SHA-Notiz allein erhält kein Objekt über GC. Die retained Ref wird weder überschrieben noch implizit mitgelöscht; bei unklarer Erhaltung bleibt der Worktree.

## 5. Persistente Arbeitspakete

### 5.1 Paketidentität und Daten

Ein Arbeitspaket ist ein eigener project-local Board-Management-Task mit eigener stabiler ID. Es implementiert nicht selbst die Fachfeatures seiner Mitglieder. Mitglieder referenziert es ausschließlich per stabiler `task_id`; existierende IDs bleiben über Board-Project-Reklassifizierung gültig. Duplikate, Superseded-Karten und fremde Projekte werden erkannt und nicht still neu angelegt.

Board Taskstatus, MCP-Sessionzustand, fachlicher Taskzustand, Worktree/Git-Integration und externe Abnahme werden getrennt beobachtet. Paketmitgliedschaft bleibt bestehen, auch wenn ein Mitglied done/superseded/extern ausstehend ist; Statusgrund und Evidence werden aktualisiert, nicht Historie überschrieben.

### 5.2 Paket-Compact Context und Concept Plan

Paket-C enthält nur den aktuellen Fortsetzungsstand: Task-ID/Planpfad, Ziel/Status und Beobachtungszeit, Mitglieder mit tatsächlichem Boardzustand, aktive/letzte Session- und Message-IDs soweit erhalten, Welle/Blocker, Worktree/Basis/HEAD/Commit/Dirty-State, Implementierung/Integration/Abnahme, `INPUT_REQUIRED`, letzter Readback, nächster Managementschritt.

Paket-P enthält Ziel und Ausschlüsse, Membership-Rationale und Quellen, fachliche/technische Abhängigkeiten, betroffene Shared-Hunks und Komponenten, Wellen-/Parallel-/Sequenzplan mit erwarteten HEADs, Ownership/Worktree und Lifecycle, Integrations- und Regressionsplan, Autonomievertrag, Operatorgrenzen, Readinessentscheidung, Morning-Handoff und Abschluss-/Cleanupkriterien.

C bleibt eine knappe Ein-Datei-Arbeitsgedächtnisdatei (Ziel ~5k, warnen ~7.5k, vor ~10k kondensieren). P bleibt der kanonische detaillierte Plan (Ziel ~20k, warnen ~30k, ab ~40k in task-ID-benannte Details teilen). C dupliziert P nicht.

### 5.3 Paketbildung und Boardmutationen

Einstiege: konkrete Task-IDs; Ziel/Thema mit unterstützter Board-Suche; Muss-Tasks plus optionale Kandidaten. Der Skill prüft Existenz, Status, Duplikate/Superseded- und Transferstände, gemeinsame Zielsetzung, Tasktyp (Analyse/Konzept/Review/Implementierung), Dokumente, Abhängigkeiten und ersichtliche Konfliktflächen. `TASK_SEARCH_INCOMPLETE` ist kein Abwesenheitsbeleg.

Der Skill zeigt vorgeschlagene Mitgliedschaft, Ausschlüsse, Abhängigkeiten und Phasen an. Boardkarte, Management-Task, Dokumente, Links, Statusänderungen oder Notizen werden nur innerhalb des konkret autorisierten Pakets geschrieben. Vor Erstellung wird die Zusammenstellung durch Nutzerbestätigung autorisiert; vorhandener Task wird nicht dupliziert. Ein Paket darf `todo` sein, während Mitglieder noch Konzeptreife benötigen.

Das Todo-Paket zeigt fehlende Pläne/Entscheidungen als Readinesslücken. Für den Übergang gelten C/P-Initialisierung, tatsächliche Header-Evidence, bevorzugtes `add_task_document_bindings`, obligatorischer `available`/Pfad/Revision-Readback, `REGISTERED`, getrennter Boardmove und Statusreadback gemäß bestehendem Vertrag.

### 5.4 `WORK_PACKAGE_READY` und Wellensteuerung

`WORK_PACKAGE_READY` ist ein Paket-/Orchestratorcheckpoint, kein Board-/MCP-Serverstatus. Er benennt Paket-ID, startbare Welle, Basis-HEAD, zugehörige Task-/Dokumentrevisionen und ausdrücklich zurückgestellte Mitglieder.

Voraussetzungen für die benannte Welle:

1. Outcome, Member-/Scopegrenzen und benötigte lokale/Operatorrechte sind bekannt.
2. Jede startende Schreibaufgabe hat ausreichend geklärte Anforderungen/Akzeptanz und aktuelle C/P, soweit der bestehende Workflow sie erfordert.
3. Abhängigkeiten, Basis-HEADs und nötiger Integrationsstand sind belegt.
4. Gemeinsame Dateien/Hunks/Packages/Versionen sind als parallel, sequenziert oder für Reconciliation markiert.
5. Owner und tatsächliche Arbeitskopie sind festgelegt; Persistenz und Werkzeugzugriff darauf sind verifizierbar.
6. Blockierende Produkt-/Architektur-/Schema-/Sicherheitsentscheidungen sind geklärt oder Mitglied ausdrücklich aus der startenden Welle geparkt.
7. Operatorgrenze, Integrator und Prüf-/Handoffkriterien sind benannt.

Für jede abhängige Welle wird vor Start dieselbe Prüfung mit aktuellem Integrations-HEAD erneut durchgeführt. Paket-`in_progress` und `WORK_PACKAGE_READY` sind getrennte Fakten: vorhandene Todo-Pakete dürfen vorbereitet werden; ein ausführbarer Status wird erst nach Readiness und jeweiliger autorisierter Boardtransition behauptet.

Vor jedem tatsächlichen Dispatch/Resume/Move erfolgt ein Abgleich mit aktueller Mitgliedschaft, relevanten Paket-/Memberdokumentrevisionen, Basis/benötigtem Inhalt, Ownership und Pending-/Scopesituation. Fehlgeschlagene Reevaluation verwirft die alte Ready-Evidence. Leere/unbekannte Wellen und ungeklärte Abhängigkeitszyklen sind nicht ready. Schreibkopie-/Write-Target-Pflichten gelten nur für mutierende Member; Analyse/Review bleibt ihrem Read-only-Scope entsprechend startbar. Blockade einer späteren Welle belässt den echten `in_progress`-Boardstatus und autorisiert keine doppelte Submission, Abort oder Reset.

### 5.5 Autonomie und Parken

Worker entscheiden sichere technische Details selbständig, wenn sie innerhalb dokumentierter Architektur/Anforderungen/Akzeptanz, ohne neue Semantik, Scope-, Sicherheits- oder grundlegende Datenmodelländerung bleiben. Sie legen Annahmen im Ergebnis/C fest und treiben sichere unabhängige Arbeit bis zum implementierbaren Ziel.

Eine echte planüberschreitende Entscheidung stoppt die betroffene Arbeit in einem sauberen Zustand. Worker melden terminales `INPUT_REQUIRED` mit Entscheidung, Kontext, Optionen, erledigtem und pausiertem Umfang. Orchestrator liest Original, klärt im normalen Chat/Work-Gespräch und sendet nach Idle-/Permission-Prüfung einen normalen Follow-up an dieselbe geeignete Session. Kein Question-Reply oder künstlicher Turn. Paket dokumentiert den Blocker beim nächsten autorisierten Pflegepunkt. Unabhängige Mitglieder dürfen bei verifizierter isolierter Basis weiterarbeiten.

## 6. Morning-Handoff, Work-Surface und Runtime

### 6.1 Morning-Handoff

Wiederaufnahme ohne Chatgedächtnis nutzt Paket-Boardtask, registrierte C/P, Membertasks/-dokumente und Originalresultate. Der Manager unterscheidet erledigt, lokal verifiziert, committet, integriert, Board done und extern abgenommen. Er prüft aktuellen Boardstatus, Ergebnis-ID und Contentcoverage, Worktree-/Gitstatus, Source-/Target-HEAD, Dirty-State und offenen Permission-/`INPUT_REQUIRED`-Zustand. Session idle ist kein Erfolg; Board done ist keine Paketintegration.

Ein frischer opencode-vm-Start lädt History standardmäßig nicht erneut; `--keep-history` ist ein vorhandener Operatorpfad, keine Garantiezusage. Der Handoff behauptet nur erhaltene verifizierbare Evidence. Fehlende Resultate/History werden als Gap markiert und nicht durch kopierte Contextaussagen als neu verifiziert ausgegeben. Es gibt kein implizites Polling/automatische Morgenbenachrichtigung.

### 6.2 ChatGPT Work vs. OpenCode-VM

Normaler Chat ist für Zielklärung, Paketzusammenstellung, Readinessbesprechung und Review des Status geeignet. ChatGPT Work ist die empfohlene äußere Oberfläche für länger laufendes Management, sofern Konto/Plan/Workspace die Oberfläche freigibt. Die Repositoryarbeit bleibt im ausgewählten OpenCode-VM-Projekt über dessen tatsächliche MCP/A2A/OpenLive-Verbindung. Work ist nicht der VM-Worker und gibt weder origin credentials noch Dateizugriff dazu.

Der normale Chat kann Work nicht still aktivieren oder dessen Handoff automatisch starten. Der Skill erzeugt einen kurzen Copy/Paste-Bootstrap mit Paket-`task_id`, registrierten C/P-Pfaden, Projektverbindungsbezug, erster Welle/Basischeck, Managementrolle, Read-first-, Update-, Autonomie-, Integrations- und Remotegrenze. Voller Plan wird nicht dupliziert. In vorhandener geeigneter Work-Session direkt weiterarbeiten; andernfalls den Nutzer klar zum Wechsel/Aufruf von Work führen. Übernahmequittung nennt gelesene Dateien, Paket/Welle, Basis/Ownership, nächste Aktion.

### 6.3 Runtimeprofil

- `execution`: fertig definierter, deterministischer Managementplan ohne größere Konflikte;
- `standard`: übliches Multi-Task-Management und begrenzte Reconciliation;
- `deep`: schwer auflösbare Integrations-/Shared-Hunk-/Architekturdiagnose.

Diese Heuristik klassifiziert den Managementauftrag als Ganzes, nicht einzelne Schlüsselwörter. Der Skill liest die aktuelle empfohlene Policy-/Capability-Auflösung und nennt konkrete Runtime nur aus tatsächlich verfügbaren Rückgaben. Explizite Nutzerwahl geht vor. Schema-/Capability-limited Connectoren erhalten keine erfundenen Tools. Konfigurierte, nicht verfügbare/incomplete Zuordnungen blockieren stille Substitution; unkonfigurierte Rollen erlauben nur den etablierten geeigneten Sessiondefault nach bestehendem Vertrag.

Eine OpenCode-`update_session_runtime` wird ausschließlich für dieselbe OpenCode-Session, nach Idle-/Pending-Prüfung, bei passender autorisierter Auflösung und mit exaktem Readback ausgeführt. Sie setzt nicht das Modell der ChatGPT-Work-Oberfläche. Skill nennt die Profilbegründung und trennt äußere Managerempfehlung von Workerprofil.

## 7. Schnitt, Integration und Kompatibilität

### 7.1 Geplante Skill-/Dokumentänderungen

- `integrations/chatgpt/opencode-session-orchestrator/SKILL.md`: allgemeine Ownership-Pflicht bei Write-Tasks; neue Paketerstellung/Readiness; Workhandoff; Runtimeprofil.
- Neu `references/worktree-ownership.md`: Treeauswahl, Datenaufnahme, Reuse, Integration, Cleanup und Fehlerformen.
- Neu `references/work-packages.md`: Mitgliedschaft, Readiness, Wellen, Autonomie, Persistenz, Morning-Handoff, Workoberfläche und Runtime.
- `references/board-workflow.md`: nur bestätigte Paket-/Mitgliedsmutationen, Suche/Deduplizierung und Board-/Execution-Trennung.
- `references/task-compact-context.md` und `references/task-concept-plan.md`: Worktree-/Paket-Metadaten dort ergänzen, wo sie allgemeine Taskpflege betreffen, ohne bestehende Größen-/Header-/Registrierungsregeln abzuschwächen.
- `references/initialization-follow-through.md`: auf neu eingeführte Paket-WORK_PACKAGE_READY-Prerequisite verweisen, ohne die bestehende `CONCEPT_READY`-/`REGISTERED`-/`BOARD_MOVED`-Semantik umzudeuten.
- `references/regression-scenarios.md`: Ablauf- und Grenzfälle in tabellarische Szenarien aufnehmen.
- `docs/CHATGPT.md`: dokumentierte Work/Chat-/VM-Rollen und UI-/Kontoabhängigkeit nach aktueller Primärdokumentation.
- `integrations/chatgpt/opencode-session-orchestrator/CHANGELOG.md`, `integrations/chatgpt/bundle.json`, `SKILL.md` Revisionmarker, `latest.json`, ZIP und SHA: nächste freie Skillrevision, reproduzierbar generiert.
- `tests/chatgpt_skill_test.py`: echte semantische/flow-basierte Szenarien für den Textvertrag, keine Behauptung von Hosted-Verhalten.

Keine Änderungen an MCP-Toolkatalog, Taskboard-Schema, Managed-Policy oder Session-Ingress sind geplant. Falls während Implementierung das konkrete Worktree-Write-Target in der tatsächlichen unterstützten Tooloberfläche nicht sicher adressierbar ist, zuerst auf sicheren operatorvorbereiteten/scoped Projektkontext zurückfallen und das Scopehindernis konkret belegen; keinen MCP-Parameter oder Datenmodell erfinden.

### 7.2 Integrationsvorgehen / Kollisionskarte

Änderungsbasis ist der bestätigte lokale konsolidierte HEAD `d6f41cc…` und dessen r24/0.6.7/0.1.21/0.1.7-Verträge. Die bereits erledigte Agent-managed-Arbeit wird nicht neu implementiert/cherry-picked. Die zwei historischen Nightly-Worktrees haben Basis `6d2efde…`, enthalten divergierende ältere Taskstände, und ACH-1 hat uncommitteten C-Text. Sie werden nur als Read-only-Evidence behandelt, nicht zusammengeführt, bereinigt oder als Freigabe für Cherry-pick genommen.

Zentrale Kollisionsflächen: Skill-`SKILL.md`; Board-/Plan-/Context-/Follow-through-Referenzen; Regressionstabelle und `chatgpt_skill_test.py`; Bundle-/Changelog-/Revision-/ZIP-/SHA-/latest-Artefakte; `docs/CHATGPT.md`. Alles wird in einer serialisierten Integration auf der bestätigten Basis bearbeitet. Bestehende r21 add-only Bindings, Headerrevision, ACH-1 five-profile resolution und r24 Managed-Sessionregeln sind Invarianten.

Keine Remote-Operation, kein Push/Tag/Release/Deployment, kein aktiver Connectorrestart, keine externe Infrastrukturänderung und keine automatische Board-`done`-Mutation.

## 8. Implementierungssequenz

1. Task-C/P-Identität lesen, denselben Pfad verwenden, Scope und r24-/Managed-Basis nochmals verifizieren.
2. Concept Plan und Compact Context initialisieren. Beide Headblöcke und tatsächliche erste Zeilen prüfen. Eine formale Pakettransition bleibt bis Dokumentreadback `todo`.
3. Bevorzugt `add_task_document_bindings` für beide Rollen verwenden, nur bei Abwesenheit des Tools auf bestehendes Register-Fallback gehen; danach `get_task_documents` mit `available`, exakten Pfaden und Revisionen prüfen. Statusmove getrennt readbacken. Ungewisse Writes nicht blind wiederholen.
4. Die zwei neuen Referenzen entwerfen und in Bundle-Inventar aufnehmen; Quellen bleiben sprachlich abgestimmt.
5. Skill-Surface mit allgemeiner Ownership zuerst, dann Paket-/Readinessmodell, dann Work-/Runtimehandoff ändern. Bestehende Spezifikationen für Approval, Boardtransition, Responses, Runtimeprofile und Managed-Ingress erhalten.
6. Vollständigen Regresionstestkatalog ergänzen und jedes Szenario entweder im in-memory client flow modellieren oder als klar gekennzeichnete manuelle/Operator-Abnahme beschreiben.
7. Bundle/Marker/Changelog auf nächste freie Revision aktualisieren und Builder benutzen.
8. Relevante Skill-, Privacy-, Manifest-/ZIP- und vorhandene projektspezifische Tests ausführen; bei Findings nur dokumentierten Scope korrigieren.
9. Task-C mit lokal beobachteten Tests, Dateilisten, lokaler Commit- und Integrationsbasis pflegen. P nur bei einer echten Konzeptänderung fortschreiben.
10. Status/Diff/Log prüfen und nur task-eigene Dateien lokal committen. Ergebnis, lokaler Integrationsstatus und externe Abnahme getrennt melden.

## 9. Abnahmematrix / Szenarien

| Kriterien | Szenario und Erfolgsevidence |
|---|---|
| Allgemeines Ownership / AC 1–3 | Einzelner sequenzieller Write-Task erhält exklusiven Integration-Tree oder Task-Worktree; zwei unabhängige parallele Tasks erhalten verschiedene Git-Worktrees/Indizes. Context führt Task-ID, Pfad, Startbasis, Commit/Dirty-State und Integrationsziel. Keine Remote-Writes. |
| Unveränderte gemeinsame Konfiguration | Worker darf fremde vorhandene Dirty-/Untracked-Dateien nicht stagen, überschreiben, zurücksetzen oder in Commit aufnehmen. |
| Reuse / AC 4 | Folgeauftrag derselben Task-ID prüft denselben Worktree und tatsächlichen HEAD. Ein stale/falscher abhängiger Basisstand blockiert, bis Integrations-HEAD/Änderungen verifiziert sind. |
| Retention/Cleanup / AC 5, 13 | Dirty/untracked, laufender Worker, fehlende Ergebnisreview oder unklare Integration verhindert Cleanup. Nach verifizierter Integration/Ownerstillstand und autorisiertem Cleanup kann das Worktree gezielt entfernt werden; keine automatische Entfernung. |
| Arbeitspaket / AC 6–8 | Eigene Managementkarte referenziert echte Task-IDs; eigener C/P dokumentiert Mitglied, Board-/Session-/Git-/Integrations-/Abnahmezustand, Wellen und Ziel. Done-Mitglied bleibt als Basisevidence erhalten. |
| Planung / AC 9–10, 13 | Unabhängige parallele Tasks; Shared-Hunk-/Versionskonflikt wird sequenziert oder isoliert reconciliiert. Nachfolgetask startet ausschließlich mit neuer bestätigter Integrationsbasis. Combined regression läuft nach Reconciliation. |
| Parken / AC 11, 19 | Ein Task benötigt echte Produktentscheidung und endet mit terminalem `INPUT_REQUIRED`; betroffene Welle parkt, unabhängige Task auf unabhängiger Basis läuft weiter. Kein Question-Reply, Board-Done oder Paketintegration wird erfunden. |
| Morning-Handoff / AC 12, 13 | Frische Managementsession ohne Chatgedächtnis rekonstruiert aus Board+C/P+Originalresultaten commits, Basis, Dirty/Worktree, Test-/Integration-/Abnahmezustand und next safe action. Fehlende History wird Gap, nicht als Erfolg angenommen. |
| Nightly-Referenz / AC 14 | r21 done als Input erhalten; Header-/ACH-Worktrees getrennt; Task-25b3 nur nach konsolidierter Basis; divergierende Source-/Integrationcommits dokumentiert; ACH dirty Context verhindert Cleanup; lokale Abnahme von externer unterscheidbar. |
| Skill-first / AC 15 | keine neue MCP-Struktur. Vorhandene Board-Reads, Dokumentbindungen/Reads, Sessionstatus/Resultat und Links werden nur nach tatsächlicher Schemaentdeckung verwendet. Fehlende Fähigkeiten erzeugen ehrliche Grenzen. |
| Paketbildung / AC 16–18 | Tests für konkrete IDs, Thema plus Board-Suche, Muss-/optionale Kandidaten, Duplikat/Superseded und unvollständige Suche. Todo-Paket mit nicht concept-ready Mitglied ist zulässig und sichtbar. Gate lehnt betroffene Welle ab und wird nach aktueller Konzept-/Basis-/Ownershipevidence passierbar. |
| Autonomie / AC 19 | Worker führt einen kleinen technischen Detailentscheid innerhalb des Plans ohne Rückfrage aus und dokumentiert ihn; planüberschreitende Semantik/Security/Schema liefert INPUT_REQUIRED und parkt nur abhängige Arbeiten. |
| Handoff / AC 20–21, 24–27 | Kompakte Übergabe mit Paket-ID und registrierten C/P stellt Read-first-/Rekonstruktionsfähigkeit in frischer passender Work-Session fest. Normaler Chat endet mit klarer Work-Wechsel-/Paste-Anweisung, kein falscher automatischer Start; existierende geeignete Work-Session wird genutzt. |
| Runtime / AC 22–23 | Deterministisches Paket empfiehlt execution; normaler Multi-Tasklauf standard; komplexe Konflikte deep. Begründungen verschieden; aktuelle Policy/Capabilities aufgelöst, explicit user override, keine harte Modell-ID, keine stille unavailable-Zuordnung. |

Statische Skill-/Fake-Flow-Tests beweisen keine tatsächliche Git-Tool-Directorybindung, Hosted ChatGPT Work-Verfügbarkeit, OpenCode-VM Mountpersistenz, macOS/Lima Credential-/Origintrennung oder Operatorakzeptanz. Diese separaten Abnahmen werden als solche ausgewiesen.

## 10. Genuine offene Fragen und Entscheidungsstand

Es gibt keine blockierende Konzeptentscheidung. Bewusste Betriebsgrenzen statt offener Featureentscheidungen:

- Die bestehende MCP Session lässt kein Worktree-Directory bei `create_session` konfigurieren. Worktree-Writes sind nur sicher, wenn die tatsächliche ausgewählte OpenCode-Tooloberfläche die Arbeitskopie durchgängig targetet oder eine vom Operator passend vorbereitete scoped Verbindung benutzt wird. Ein konkreter Runtimebefund, dass dies nicht möglich ist, wäre ein separater, belegter Implementation Blocker; die skill-only-Vertragstexte dürfen keine Garantie behaupten.
- ChatGPT Work rollt konten-/workspaceabhängig aus. Der Skill kann hinweisen/übergeben, nicht automatisch starten.
- Cross-client Ownership ist kooperativer Managementvertrag, kein neuer serverseitiger Lease/CAS. Ein späterer native MCP-Relationstask braucht belegte Wiederaufnahmefehler durch Board+C/P, keine prophylaktische Erweiterung.
- macOS/Lima/Hosted ChatGPT/Voice, produktive Connectoraktivierung und reale Operatorabnahme sind nicht Bestandteil des lokalen Skilltests.

## 11. Abschlusskriterien

Lokale Konzept-/Implementierungsarbeit ist für den autorisierten Scope abschließbar, wenn taskgebundene C/P valide persistiert und semantisch gebunden sind; alle skill-first Anforderungen aus §3–9 und die Regressionen enthalten sind; Bundle/Revision/ZIP/SHA konsistent sind; lokale vorgeschriebene Tests bestehen; und Commit-/Diffzustand taskgenau dokumentiert ist. Das behauptet weder Remote-Publishing noch Deployment, aktive Connector-/Skillinstallation, Hosted Verhalten oder externe Operatorakzeptanz. Task `done` setzt verifizierten Business-Outcomenachweis und eine getrennte autorisierte Boardmutation voraus.

Zusätzlich verlangt die gelesene Board-Ergänzung **L** einen separaten Deep-Quality-Review vor Abnahme/Done: Board + registrierte C/P + Source + Testevidence prüfen, nur kleine in-scope-Korrekturen, deren Nachprüfung und Nutzung der zur Reviewzeit verfügbaren Deep-Projektpolicy. Keine dauerhafte Modellzuordnung. Der QA-Auftrag dieser Session autorisiert diese Prüfung/Korrekturen, keinen Board-Done-/Remote-/Deploymentschritt.

## 12. Deep-QA – Prüfstand und nachvollziehbare Findings

Reviewbasis: `d46b8c15f589760bcfb6e7a7dc8247744e6451dc` mit Implementation `06af861f…`, Contextabschluss `955f8780…` und Gatekorrektur `d46b8c15…`. Der Kontext hatte nur den ersten Implementationcommit erwähnt; die QA-Reconciliation ergänzt den vollständigen lokalen Integrationsstand.

Der aktuelle Connector löste das Deep-Profil mit Policyrevision **18** als available auf. Die laufende Reviewsession `ses_f0c8bd82effehrn7eEsIVme66V` verwendet exakt den zurückgegebenen Tuple `openai / gpt-6.1-sol / xhigh`; kein Busy-Session-Modellwechsel wurde versucht. Dies ist Reviewevidence dieses Zeitpunktes, keine fest kodierte Workflowwahl.

### 12.1 In-scope-Korrekturen

| Finding | Korrektur / Nachweisart |
|---|---|
| Paketlokale Sicht konnte dasselbe Task-/Tree-Ziel zwischen zwei Paketen doppelt vergeben; keine operative Aussage zur unbekannten Ownership. | Repositoryweite kooperative Ownership einschließlich manueller Writer/physischer Aliase, Evidence teilen statt doppelt ausführen, bei unvollständigem Read stoppen. Kein Lock-/Lease-Unterbau. Negativfälle im Testfixture ergänzt. |
| Isolierte C/P-Kopie war nicht ausreichend vom kanonischen Connector-Dokumentroot getrennt; laufende Worker könnten zentrale Docs parallel verändern. | Bestehende serielle taskgebundene Delta-Publikation mit Ausgangsrevision/Conflict-/Uncertain-Readback ergänzt. Reguläre bestehende Bindings bleiben, keine Symlinks/Retargets. Filesystemfixture prüft Stale-Publikation, fremden Header, Symlink und verlorene Antwort ohne zweiten Write. |
| Readiness-Negativtests betrachteten keine ehemals passierte Welle nach Drift; das Testmodell behielt einen Ready-Marker nach fehlgeschlagener Reevaluation. | Neuer Negativtest reproduzierte den falschen Boardmove im alten Fake; Testfixture bindet Ready an aktuelle Inputs/Revisions/Basis und invalidiert Fehlschlag. Skill-Vertrag präzisiert dieselbe bestehende Pre-dispatch-/Resume-Pflicht, Read-only-Ausnahmen und unveränderten Boardstatus bei späterer Wellenblockade. |
| Cleanup konnte wichtige ignorierte Resultate übersehen; SHA-Text garantiert keine Erreichbarkeit eines detached Quellcommits nach semantischer Integration. | Ignored-Outputprüfung und expliziter Gitobjekterhalt vor Entfernung. Echter Disposable-Gittest mit nested/detached Worktrees, untracked Removal-Deny, gesichertem Resultat/Source-Ref und anschließendem GC. |
| Recovery-/Handofftexte und Package-only Gate waren nicht an allen konkreten Wiederaufnahme-/Memberdispatchpfaden sichtbar. | Packagegate auch in Plan-/Orphan-Follow-through, Member-Handoff mit beiden Roots/exakten Taskpfaden und Runtimebegründung vor Workübergabe. Bestehender r21/Header/Managed-Vertrag bleibt erhalten. |

### 12.2 Anforderungs- und Coverageabgleich

Alle 27 bestehenden Akzeptanzkriterien und die neue Board-Ergänzung L wurden gegen tatsächliche r25-Quellen geprüft; QA-Präzisierungen liegen als Skillrevision r26 auf derselben Architektur vor.

- **AC 1–5:** allgemeine Ownership, verschiedene Trees/Indizes, Pflichtmetadaten, Reuse, Cleanup. Dokumentvertrag + Fake-Negativfälle; echte Gitfixtures belegen isolierte Indizes, Shared-Hunk-Konflikt, nested/detached Wiederaufnahme und Source-Erhaltung.
- **AC 6–12:** Managementkarte/stabile Member, getrennte C/P-/Zustandsrollen, Wellen/HEAD/Integration, unabhängige Weiterarbeit und Morning-Handoff. Skill-/Registrierungsvertrag; repräsentative Client-Decision-Fakes für Ready/Unready/Blocked/Done/Missing-Evidence, keine behauptete native Engine.
- **AC 13–15:** verlangter Szenarienkatalog, konkreter Nightlyfall in §2.3 und keine neue MCP-Komplexität. Git-Szenarien und Textvertrag werden geprüft; externe/Gast-Tool- und Hostedlevel getrennt.
- **AC 16–23:** IDs/Goal-/Muss-Optional-Suche, Todo-Lücken, benannte Wavegates, minimalfunktionale Autonomie, kurzer Bootstrap und dynamische Runtime. Pflichtszenarien/Textvertrag plus repräsentativer Membership-/Readiness-/Runtime-Fake; Goal-Suche und Promptbefolgung durch Hostedmodelle bleiben externe Verhaltensabnahme.
- **AC 24–27:** sichtbares Chat→Work, Erklärung/Startschritt/Reuse; Quellen/Bootstrap geprüft. Eine Work-UI-API, ein Modellpickerwechsel oder Hosted-Toolverfügbarkeit wird nicht behauptet.
- **L:** verfügbare Deep-Policy exakt mit Reviewruntime abgeglichen, kleiner Korrekturscope und geforderte Nachprüfung; Business-Done bleibt Managemententscheidung.

Das Produkt ist ein instruction-only Skill, daher ist eine Prozentzahl aus der Python-Testcodecoverage keine Feature-/Safetyabdeckung. Statische Inhalts-/Paketprüfungen, explizit testlokale Clientwalks, tatsächliches Disposable-Gitverhalten und externe OpenCode-/Hosted-/Host-Abnahme werden getrennt ausgewiesen. Python-Fakes sind keine Produktimplementierung und beweisen nicht, dass ein Hostedmodell den Vertrag befolgt.

### 12.3 Abschließende Evidence

Nachprüfung der korrigierten r26-Quellen: vollständige Skill-/Paketregression **22 PASS / 0 FAIL / 0 SKIP**, Fokuslauf mit vier Ownership-/Publikations-/Gitfällen PASS, Builder `--check` und `git diff --check` PASS. QA-Urteil für den lokalen Skill-first-Scope: **PASS**, technisch abnahmebereit ohne verbleibendes internes Finding. Abschließender Registrierungs-/Inhaltsreadback und Revisionen werden im terminalen QA-Ergebnis berichtet. Kein offener Produktentscheid ist für diese bestehenden Vertragskorrekturen erforderlich; externe Host-/Tooltarget-/Hosted-Akzeptanz bleibt unverändert ein separater Nachweis. Der QA-Delta baut auf `d46b8c15…` auf; Commit-/Board-/Deploymentevidence folgt getrennt im Compact Context/Git-Verlauf.
