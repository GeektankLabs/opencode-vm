Task-ID: task_25b3af4f-e97f-5707-b523-13bcc99ed03c
Title: OpenCode VM – agent-managed Sessions non-interactive betreiben, lokale Git-Arbeit erlauben, Remote-Push sperren
Status: full-scope-locally-implemented-and-tested; external-acceptance-separate
Last-concept-update: 2026-09-30T17:07:30Z
Implementation-state: full-supported-product-scope-locally-complete; implementation-committed; external-acceptance-separate
Compact-context: .opencode/tasks/task-task_25b3af4f-e97f-5707-b523-13bcc99ed03c.compact.md

## 1. Ergebnis und Leseschlüssel

**Neuer Auftrag: vollständige Implementation aller festgelegten Oberflächen ist autorisiert, einschließlich Tests/lokaler Pakete/Commits.** Frühere Planning-only-Freigaben unten sind historische Auftragsstände. Kein Remote-Push/Credentialprovisioning/Release/Deployment/externe Infrastruktur oder Board-Move. Aktuelle technische Implementation in §18; D1–D3 unverändert.

**Operatorentscheidungen sind kanonisch; koordinierte Produktintegrationsplanung ist ready.** Klassifikation erfolgt automatisch am tatsächlichen agentischen Work-WRITE-Ingress, einschließlich Worksession-Creation und Adoption/Fortsetzung; READ und reine Managementoperationen klassifizieren niemals um. Client/Skill sendet kein Managed-Flag. Managed-Children werden vor erstem Workprompt automatisch adoptiert.

**Primäre harte Remote-Write-Grenze ist das credential-/writable-originfreie VM-Design.** GitHub-/Origincredentials und Operatorprojekt-/Originsteuerung bleiben auf Host/Operatorseite. OpenCode-Denies/Guards sind Defense-in-Depth und Verhaltenspolicy. Die 25 Spike-Probes belegen Eigenschaften/Lücken dieser OpenCode-Schicht; sie widerlegen nicht das VM-Sicherheitsmodell. Die frühere Auswahl einer zweiten externen Repository-/Transport-/Capabilitygrenze ist als Produktentscheidung geschlossen und nicht mehr Integrationsvoraussetzung.

**§17 dokumentiert die Operatorentscheidungen; §§7–14 und §16 sind entsprechend reconciliert.** Quellen-/Runtimeangaben in §§3–6/15 sind historische Snapshots der Initialisierung, §16 ist die historische Spike-Evidence. Der aktuelle Auftrag ändert nur diesen Plan und den Compact Context. Umsetzung und Abnahme des gewählten Vertrags stehen aus; Produktcode/Deployment/Board-Move sind hier nicht autorisiert.

Die Sicherheitsinvariante lautet:

> **local repo autonomy; remote write operator-only**

Kennzeichnung im Plan:

- **Ist / verifiziert:** gelesener Repo-Code, lokale Runtime-Antwort oder installierter Toolstand.
- **Quellenbefund:** Implementierung des OpenCode-Tags `v1.18.33`, passend zur gemeldeten Binary-/Serverversion; kein dynamischer Exploit oder Feature-Smoke-Test.
- **Soll / Empfehlung:** spätere Implementierungsentscheidung; heute nicht aktiviert.
- **Operatorentscheidung / kanonisch:** festgelegter Produktvertrag, keine Behauptung einer neu ausgeführten Runtime-/Hostabnahme.
- **Implementierung / verification pending:** technische Umsetzung oder Nachweis fehlt. G1–G3 sind gemäß §17 Arbeits-/Abnahmepunkte, keine offenen Entscheidungen über ein zweites Sicherheitsmodell.

Der ursprüngliche Initialisierungsauftrag schrieb ausschließlich Concept Plan und Compact Context; der spätere Spikeauftrag autorisierte den isolierten Test-/Prototyppfad gemäß §16. Der jetzige Operator-Reconciliationauftrag ist erneut ausschließlich Dokumentation in diesen beiden Taskdateien. Keine Produkt-/Skill-/Wire-/Release-/Credentialänderung, keine neuen Probes/Infrastruktureingriffe oder Boardmutation.

## 2. Problem, Outcome und Scope

Extern gesteuerte OpenCode-Arbeits-Sessions teilen heute den normalen OpenCode-Server mit Web UI/TUI. Der Build-Agent kann das native `question`-Tool aufrufen; OpenCode-VM setzt lokale Commits auf `ask`. Damit kann ein agentischer Auftrag an einer UI-Frage hängenbleiben, obwohl ein Orchestrator den fachlichen Austausch bereits übernimmt.

Das Board nennt als reales Beispiel eine Proxmox-Testsession in einem anderen Repository mit `session.input_required`, `questions:1` am 2026-09-29. Diese Evidenz wurde aus der aktuellen Task-Beschreibung gelesen; die andere Session und deren Umgebung wurden hier nicht untersucht oder verändert. Sie dient als Fehlermotiv, nicht als heutiger reproduzierter Test.

Gewünschter Outcome:

1. Jeder tatsächliche agentische Work-WRITE-Ingress klassifiziert neue oder übernommene Arbeits-Sessions automatisch serverseitig als managed; reine READ-/Managementcalls lösen keine Umklassifikation aus. Kein Managed-Client-/Skillflag.
2. Fehlende fachliche Informationen führen zu einem normalen, terminalen, auslesbaren `INPUT_REQUIRED`-Bericht. Der Orchestrator klärt sie mit dem Nutzer und sendet ein gewöhnliches Follow-up in dieselbe Session.
3. Autorisierte Entwicklungsaufträge umfassen übliche lokale Git-Arbeit und sinnvolle lokale Zwischen-/Abschlusscommits, ohne gesonderte Commit-Frage.
4. Der credential-/writable-originfreie Guest besitzt keinen Pushzugang zum operatorverwalteten Projektorigin; Operator prüft/pusht auf dem Host. OpenCode-Push-/Equivalentwrite-Policy verweigert explizit ohne Ask als Defense-in-Depth.
5. Reuse, Agentwechsel, automatisch vor erstem Workprompt adoptierte Subagents und Neustart verlieren den Managed-Vertrag nicht. Manuell erzeugte/interaktiv genutzte Sessions bleiben bis zum tatsächlichen agentischen Work-WRITE manual.
6. Technische Policy, tatsächliche Tool-Instruktionen und geladene AGENTS-Texte widersprechen sich nicht.

### Scope der späteren Implementierung

- Operationsbezogene Erkennung tatsächlicher agentischer Work-Writes und automatische sessionbezogene Backendadoption; projektbezogene Serviceeligibility allein ist kein Trigger.
- Zentrale Policy-/Priming-Installation einschließlich Fresh Start und Reattach.
- Fragen-/Blockerbericht und fachlicher Follow-up-Vertrag.
- Lokale Git-Allow-Semantik, Remote-Write-Deny, Vererbungs-/Kompatibilitätsnachweise.
- Konsistenz der betroffenen Produktdokumentation und Transportadapter.

### Abgrenzung

- Keine pauschale Auto-Approval aller Host-, MCP-, Shell- oder Infrastrukturrechte.
- Keine Installation/Weiterleitung von Origin-Tokens, SSH-Schlüsseln, GitHub-Login oder Host-Credential-Helpern.
- Kein VM-seitiger Push, Release, Deployment oder Remote-Write-Approval-Endpunkt.
- Keine Änderung der bereits beantworteten Proxmox-Frage oder fremder Arbeitsaufträge.
- Kein automatischer Board-Move oder Zusammenhang zwischen fachlichem `INPUT_REQUIRED` und Boardstatus.
- Keine implizite Erlaubnis, fremde uncommittete Änderungen zu committen, lokale Tags für Releases zu pushen oder explizite Read-only-/Planungsaufträge zu implementieren.
- Kein globaler Ersatz aller Benutzeragents, Plugins oder Modellprofile.

## 3. Initialisierung und verifizierter Ausgangsstand

### 3.1 Dateien und Arbeitsbaum

Beide vorgeschlagenen Pfade waren bei Glob, Directory-Read und anschließendem exaktem Read nicht vorhanden. Die Elternverzeichnisse existierten. Es gab keine Task-ID-Collision; beide Dateien wurden unter den vorgeschlagenen Namen neu initialisiert. Wiederverwendung war für diesen Task nicht erforderlich.

Der Arbeitsbaum war bereits bei Beginn verändert: r20-Skill-Quellen, Bundle-/ZIP-/Hash-Dateien und `tests/chatgpt_skill_test.py`, außerdem Task-Dokumente anderer Tasks. Diese sind fremde laufende Arbeit und keine Änderungen dieses Auftrags.

### 3.2 Versionen und direkte Runtime-Evidence

| Gegenstand | Beobachteter Stand | Bedeutung |
|---|---|---|
| Repository HEAD | `6d2efde` | Arbeitsbaum zusätzlich dirty; keine saubere Release-Baseline behauptet. |
| `opencode-vm.sh` | `OCVM_VERSION="0.6.3"` | Produktstand vor diesem Feature. |
| OpenCode Binary | `/home/lima.guest/.opencode/bin/opencode`, `1.18.33` | Durch `--version` geprüft. |
| Laufender Server | GET `/global/health`: Version `1.18.33` | Aktive Runtime entspricht der gemeldeten Installation. |
| MCP-Adapter im Repo | `0.1.17`, SDK `@opencode-ai/sdk` `1.18.21` | SDK-Pin und Serverversion sind verschiedene Größen. |
| Laufender Projektmodus | Web-Backend auf VM-Loopback; MCP, A2A und OpenLive-Gateway vorhanden | Mehrere Clients bedienen denselben OpenCode-Projektkontext. |
| Installierter A2A-Adapter | `opencode-a2a` `1.2.0` | Mit `pip show` und installierten Python-Quellen geprüft. |
| Git | `2.43.0` | Lokale Git- und Plumbing-Binaries verfügbar. |
| Git LFS / `gh` | In dieser VM nicht verfügbar | Kein Installationsauftrag; zukünftige Verfügbarkeit trotzdem als Kompatibilitätsfall behandeln. |
| Aktive V2 Saved Permissions | GET `/api/permission/saved`: 0 Einträge | Sagt nichts über V1s separaten In-Memory-Approval-Cache. |
| Orchestrator-Quellen | Bundle-Revision `2026-09-29-r20` | Abschließender Originalbericht lokal/synthetisch done-ready; Hosted-/Voice-Acceptance offen. |

Lokale Board-GETs bestätigten `todo` für diesen Task und d994, `in_progress` für cce3. Die öffentlichen IDs dieses Tasks und d994 wurden mit der gelesenen deterministischen Abbildung aus `ProjectBoardService.taskId()` gegen die nativen Ticket-IDs verifiziert; kein Read-side-Write wurde ausgelöst. Es wurden keine Board-Mutationen ausgeführt.

Die lokale GET-Evidence betrifft nur dieses Projekt. Sie ist keine Abnahme der macOS/Lima-Hostseite, anderer Projekte oder hosted ChatGPT/Voice.

## 4. Tatsächlich wirksame OpenCode-VM-Architektur

### 4.1 Verbindungserkennung ist noch keine Sessionpolicy

Der Produktcode besitzt Lifecycle-/Transportflags, aber keinen verifizierten `agent-managed` Marker oder Modus:

| Pfad | Heutige Erkennung / Betrieb | Sessionverhalten heute | Konsequenz |
|---|---|---|---|
| Eingehendes Projekt-MCP | Web und `tui-mcp` aktivieren den Connector, sofern nicht invocation-local unterdrückt. `mcp_session_mode()` liest für Terminalstarts die projektbezogene OpenAI-Tunnelassignment. | `createSession()` erzeugt eine leere scoped Rootsession mit aufgelösten Agent-/Modellsettings; `sendMessage()` verwendet `promptAsync`. Kein Managed-Marker, keine eigene Policy, kein Primer. | Muss Creation **und** Übernahme bestehender Sessions abdecken. |
| OpenAI-MCP-Tunnel | Wiederverwendbare Keys/Tunnel und Projektassignment auf dem Host; Dienst startet nach MCP-Readiness. | Transport zum gleichen MCP; keine zweite Sessionengine. | Kein eigener Policytyp, kein Anlass zu Credential-Erweiterung. |
| Eingehendes A2A | `SESSION_A2A`, `OCVM_A2A`, `OC_A2A`; Web-Default aktiv, `--no-a2a` möglich. | Installierter Adapter erstellt `/session` mit Titel und nutzt Kontext-/Identity-Binding oder bevorzugte vorhandene Session. Sendepayload kann statischen Agent/Systemtext übernehmen. Keine Managed-Policy im VM-Script. | Creation, Context-Reuse und preferred-session adoption erfassen; upstream-nahes Integrationsgate. |
| OpenLive lokal / remote | Gepackter ACP-Adapter, projektgebundener Webruntime-Descriptor, Gateway und Ownership-Lock. Remote benutzt denselben Adapter. | Read-only Manager kann explizit eine Worksession erzeugen oder den Call an vorhandene Session hängen. Workturn erhält Voice-/Besprechungsprimer. | Worksession-Policy ergänzen; Manager nicht auf lokalen Schreibagenten aufweiten. |
| Web UI / TUI / direktes REST | Gemeinsamer OpenCode-Server; TUI hängt an Web oder `serve`. | Kein verlässlicher Agentenmodus aus Sessiontitel oder Prompttext ableitbar. | Reuse derselben Managed-Session bleibt managed, auch bei UI-Betrachtung; separate unmarkierte manuelle Sessions bleiben interaktiv. |
| VM-seitiges natives ACP | Binary kennt `opencode acp`; vom verwalteten OpenLive-Shim getrennt. | Für diesen unverwalteten Start kein projektbezogener VM-Policyvertrag verifiziert. | Nicht stillschweigend als abgesichert bewerben. Bei späterer Exposition explizit integrieren oder fail-closed ablehnen. |

Wichtige Unterscheidungen:

- `mcps/registry.json` beschreibt **ausgehende** Tools, die OpenCode konsumiert, etwa Playwright/Proxmox. Das ist keine eingehende Agentenverbindung und darf allein keinen Managed-Modus aktivieren.
- `.opencode-vm/agent-control.json` enthält die Modell-/Variantprofile `deep`, `standard`, `execution`. `adapters/mcp/src/agent-control.ts` validiert genau diesen Vertrag; dort leben keine Shell-, Question- oder Sessionpermissions.
- Projektfähig, transportbereit und session-managed sind drei unterschiedliche Zustände. Ein bloß installiertes OpenLive-Paket oder ein verfügbarer HTTP-Server sagt nicht, wer eine bestimmte Session steuert.
- Websessions exponieren standardmäßig eingehende MCP/A2A-Fähigkeiten. Der Name `web` ist deshalb kein zuverlässiges Synonym für eine ausschließlich manuelle Session.

### 4.2 Wo Konfiguration und State liegen

- Host-Konfiguration wird über `pick_host_cfg`, Projektstate und Sessionkopie verarbeitet.
- Fresh Start kopiert `project-state/<hash>/config/opencode/opencode.json` bzw. Hostconfig nach `<session-share>/config/opencode/opencode.json`.
- OpenCode läuft mit `XDG_CONFIG_HOME=<session-share>/config`; das ist sein effektives globales Configverzeichnis innerhalb dieses Projekt-VMLaufs.
- Sessiondata/-state liegen VM-lokal unter `/tmp/oc-xdg-data` bzw. `/tmp/oc-xdg-state`, nicht als Live-SQLite auf dem Projektmount.
- Das Projekt kann zusätzliche `opencode.json`-/`opencode.jsonc`-/`.opencode`-Konfiguration, Agents, Commands, Skills und Plugins beisteuern.
- Fresh Start injiziert in `opencode-vm.sh:15782–15818` aktuell ein rekursiv gemergtes Top-level-Permissionobjekt mit `* allow`, Shell `* allow`, Commit `ask`, Push `deny`. Die Injection ist weder session- noch managed-spezifisch.
- Reattach nutzt die vorhandene Sessionconfig und aktualisiert einzelne Lifecycle-Bestandteile; die Fresh-Start-Permissioninjection wird dort nicht gleichartig neu ausgeführt. Ein Feature nur im Fresh-Start-JQ würde alte/reused Sessions nicht zuverlässig erfassen.
- Geladene Plugins, native Sessionrules und spätere Configquellen können die tatsächlich wirksame Policy verändern. Maßgeblich ist das gelesene effektive Ruleset, nicht ein einzelner JSON-Ausschnitt.

### 4.3 Aktive Permission-Evidence

GET `/config` zeigt:

```text
permission: * allow
bash: * allow; git commit ask; git commit * ask;
      git push deny; git push * deny
instructions: nicht gesetzt
default_agent: nicht gesetzt
agent override: openlive-manager
plugins: ECC index.ts und ecc-hooks.ts aus der Sessionconfig
```

GET `/agent` bestätigt geordnete V1-Rulesets:

- `build`: nativer Question-Allow und danach globales `* allow`; Commit ask, Push deny.
- `general`/`explore`: native Restrictions stehen vor dem injizierten `* allow`. Dieses Allow kann native Restrictions neutralisieren; nicht ungeprüft auf typische Built-in-Agentfähigkeiten vertrauen.
- `plan`: Edit-Deny/Planfile-Ausnahmen stehen ebenfalls vor dem globalen Allow. „Plan-Agent“ ist in diesem Stand kein ausreichender Read-only-Beweis.
- `openlive-manager`: finaler eigener `* deny`, Ausnahme `voice_sessions allow`; bestehende read-only Managergrenze bewahren.

Diese Feststellungen sind taskrelevant, weil ein neuer globaler Allow-Block dieselben Restriktionen erneut überfahren könnte. Eine allgemeine Reparatur sämtlicher Built-in-Agentdefaults ist kein automatischer Zusatzscope.

## 5. OpenCode 1.18.33: Permission-, Question- und Agentsemantik

### 5.1 V1 und V2 nicht verwechseln

Die laufende CLI heißt `opencode`; die Repo-Adapter verwenden Legacy-Session-Requests neben SDK-v2-Reads. Das ist **nicht** gleichbedeutend mit OpenCode-V2-Permissionen.

Verifiziert durch den installierten HTTP-Vertrag und den passenden Quelltag:

| Ebene | Syntax / Semantik | Bewertung für dieses Feature |
|---|---|---|
| Aktive V1-Config | Singular `permission`, Toolschlüssel, Actions `allow/ask/deny`; Shellpatterns als geordnetes Objekt. | Gültige Ausgangssyntax. |
| Native V1-Sessionrules | Array `{permission, pattern, action}`. GET `/doc` bietet es bei `/session` POST und `/session/{sessionID}` PATCH an. | Tragfähiger Spike-Kandidat für scoped/sticky Policy; noch nicht geschrieben/getestet. |
| V2 native Permission | Rules `{action, resource, effect}` und `permissions`. | Andere Engine; nicht in die aktive V1-Config schreiben. |
| V1-Kompatibilitätsloader | `config/v2-compat.ts` lehnt `permissions` ausdrücklich mit „Use V1 permission rules or run opencode2“ ab. | Blind kopierte V2-Beispiele würden Startup brechen. |
| `experimental.policies` | Im gelesenen Schema Action `provider.use`; allgemeiner Policyservice existiert. | Kein verifizierter harter `git.remote.write`-/Shell-Deny-Vertrag. Nicht erfinden. |

Die öffentlich gelesene JSON-Schema-URL ist `https://opencode.ai/config.json`; sie ist beweglich. Für spätere Änderungen erneut mit tatsächlich eingesetztem Schema/Server abgleichen. Dieser Plan schreibt kein Konfigurationsbeispiel in eine Produktdatei.

### 5.2 Reihenfolge und Always-Allow: Defense-in-Depth-Kompatibilität

V1 `Permission.evaluate()` verwendet den **letzten** passenden Eintrag. Konfiguration wird in Rulesets umgewandelt; Agentdefaults, Userconfig und Agentoverride werden hintereinander gemergt. Für Tool-Aufrufe kombiniert `SessionTools` Agentpermission und anschließend native Sessionpermission.

Kritischer Quellenbefund in `packages/opencode/src/permission/index.ts` des Tags `v1.18.33`:

```text
ask(input): evaluate(permission, pattern, ruleset, approved)
always reply: approved.push({ permission, pattern, action: allow })
```

`approved` ist dort ein instanceweiter In-Memory-Cache. Er wird hinter dem konfigurierten Ruleset ausgewertet. Ein passendes späteres Approval kann deshalb die erwartete Deny-Priorität verändern. Die aktive V2-Saved-Liste mit null Einträgen widerlegt diesen getrennten V1-Pfad nicht.

V2 `packages/core/src/permission.ts` prüft demgegenüber konfigurierte Denies **vor** dem Zusammenführen mit gespeicherten Allows. Dieses Verhalten darf dem laufenden V1-Pfad nicht zugeschrieben werden. Die tatsächliche Wirkung muss später in einer isolierten Runtimefixture mit realem Always-Allow nachgewiesen werden; heute wurde keine Approvalentscheidung erzeugt.

**G1, reconciliert:** OpenCode-Verhaltenspolicy soll erkannte Push-/Equivalentwrite-Versuche ohne Ask und unabhängig von remembered Grants verweigern; der frühe Guardpfad wurde im Spike belegt. Native V1-Regeln allein sind keine harte Grenze. Die primäre harte Grenze ist der in §7 festgelegte VM-Vertrag; keine zusätzliche Transportgrenze oder V2-Migration ist deswegen als Produktentscheidung offen. Integration/Kompatibilität/Policyregression sind nachzuweisen.

### 5.3 Shellpatterns

Der V1-Shelltool-Quellstand liegt inzwischen in `packages/opencode/src/tool/shell.ts`; Tool-ID bleibt `bash`. Er nutzt Tree-sitter, sammelt die Quelltexte einzelner Shellcommands und fragt mit diesen Mustern sowie reduzierten Always-Präfixen. Ketten werden damit teilweise in einzelne Commands zerlegt, aber die konkrete Semantik ist kein Git-Protokollparser.

Die aktuelle Prefixregel `git push *` erfasst nicht verlässlich beispielsweise:

- Git-Globaloptionen vor dem Subcommand (`git -C … push`, `git -c … push`);
- absolute Git-Binaries, Plumbing-Aufrufe oder Shell-/Environmentwrapper;
- Aliasexpansion, dynamisch zusammengesetzte Kommandos oder Skripte;
- native Clients, Customtools, MCP-Tools oder direkte HTTP-/SSH-Schreibvorgänge.

V2 `packages/core/src/tool/bash.ts` prüft dagegen den gesamten Commandstring und dokumentiert Parser-/Präfixreduktion noch als TODO. Deshalb müssen spätere Pattern-/Kettenfixtures beide tatsächlich beworbenen Runtimepfade getrennt testen. Die V1-Shellimplementierung ist keine Zusage über V2.

### 5.4 Questions: Filter ist nicht dasselbe wie eine Execution-Grenze

- Built-in `build` und `plan` erlauben Questions in den Agentdefaults. Der aktuelle globale Allow erweitert die effektive Freigabe nochmals.
- V1s `Permission.disabled()`/`LLMRequestPrep.resolveTools()` entfernt bei einem finalen `question * deny` das Tool aus der Modellsicht.
- V1 `tool/question.ts` ruft im Executor direkt `Question.ask()` auf, ohne eigenes `ctx.ask` vor dem Ask. Deshalb darf Tool-Unsichtbarkeit nicht ungetestet als Deny jedes erzwungenen Executionpfads gelten.
- Die generische V1-Toolausführung in `session/tools.ts` ruft `tool.execute.before` **vor** dem jeweiligen Executor auf. Ein zentraler managed-aware Question-Guard ist ein verifizierbarer Integrationspunkt für einen zusätzlichen non-interactive Schutz.
- V2 `core/src/tool/question.ts` führt dagegen zuerst `PermissionV2.assert(question)` aus und ruft danach die Frage auf.

**G2:** In der späteren Fixture nicht nur „Tool fehlt im Katalog“ prüfen, sondern einen absichtlichen/erzwungenen Questionpfad, dessen Fehler und ausbleibende Pending-Question-/Asked-Events. Ein versehentlicher Wiederholungsloop nach Tooldeny darf nicht als erfolgreicher Blockerbericht gelten.

### 5.5 Subagentvererbung

`agent/subagent-permissions.ts` des passenden Quelltags übernimmt für **neu erzeugte** Childsessions:

- native Parent-Sessionrules mit `action:deny`;
- native Parent-Sessionrules für `external_directory`;
- bestimmte zusätzliche Task-/Todo-Denies.

Parent-**Agent**restriktionen sind ausdrücklich nicht die Childcapabilities. Der Subagent hat seine eigene Agentpolicy. Parent-Allow für lokale Commits wird ebenfalls nicht automatisch vollständig als Child-Session-Allow übernommen.

`tool/task.ts` verwendet bei `task_id`-Reuse eine bereits bestehende Childsession; der Creationpfad installiert dann nicht automatisch neu berechnete Regeln. Default-Nesting ist `subagent_depth ?? 1`.

Folgen:

1. Ein dedizierter Primaryagent allein genügt nicht.
2. Session-Denies sind für neue Kinder hilfreich, müssen aber mit Child-Local-Allow, Marker/Primer und eigener Agentconfig abgeglichen werden.
3. Bestehende Kinder, Agentwechsel und spätere Toolpermissions dürfen keinen Escape eröffnen.
4. Kein Subagent wird in diesem Initialisierungsauftrag gestartet. Die Vererbungsprüfung ist Source-/Read-Evidence, keine Live-Delegationsabnahme.

### 5.6 Persistenz und `tools`-Override

V1 `SessionPrompt.prompt()` baut bei einem nichtleeren `input.tools`-Objekt ein **neues** Sessionruleset und persistiert es via `setPermission`; es ersetzt dabei bisherige native Sessionpermission. Das ist kein temporärer Tooltoggle.

MCP `sendMessage()` setzt heute kein `tools`-Objekt; OpenLive-Workprompt ebenfalls nicht. Dennoch muss die spätere Managed-Policy gegen andere Clients, Agentwechsel und Altzustände geprüft werden. Sicherheitsinvarianten dürfen nicht an der Annahme hängen, jeder Client halte sich an denselben Promptbuilder.

## 6. Instruction-Hierarchie und gefundene Konflikte

### 6.1 Geladene Quellen und tatsächliche Reihenfolge

Der passende `session/instruction.ts`-Quellstand lädt:

1. Das erste vorhandene globale Dokument: `<global.config>/AGENTS.md`, sonst erlaubter Claude-Fallback.
2. Projektinstruktionen mit bevorzugtem Dateinamen `AGENTS.md`, danach Fallbacks `CLAUDE.md`/`CONTEXT.md`; Projektfindung bis Worktreegrenze.
3. Explizite `config.instructions` (lokale Pfade/Globs oder URLs).
4. Beim Read zusätzlich nähere Subdirectory-Instruktionen, soweit noch nicht geladen/beansprucht.

Die Systemzusammenstellung nutzt Providerprompt **oder** Agentprompt, dann Environment/Instructions/MCP-/Skillhinweise und optional den am Userturn gespeicherten `system`-Primer; System-transform-Plugins können ergänzen. Ein eigener `agent.prompt` ersetzt den Providerprompt, nicht nur einen kleinen Zusatz. Deshalb ist ein dedizierter Agent mit kopiertem riesigem Providerprompt nicht die bevorzugte minimale Lösung.

Diese Reihenfolge ist eine Lade-/Konkatenationslogik, keine technische Deny-Hierarchie für freie Prosa. „Projekt gewinnt immer gegen global“ oder „letzter Text gewinnt sicher“ wäre kein belastbarer Sicherheitsbeweis.

### 6.2 Konkretes Inventar dieser Session

| Quelle | Verifizierter Inhalt / Rolle | Relevanz |
|---|---|---|
| `opencode-vm.sh` eingebetteter `~/AGENTS.md`-Text, ab Zeile 10233 | VM-Prinzipien: bei Unklarheit fragen, ohne verfügbaren Nutzer minimale Annahme; hohe lokale Tool-/sudo-Autonomie; Originzugriff verboten. | Quelle des VM-globalen Dokuments; später managed-spezifische Blockerregel ergänzen. |
| `<session-share>/config/opencode/AGENTS.md` | Aktuell aus VM-AGENTS plus Host-LAN-/MCP-/Websidecars zusammengesetzt und im Kontext tatsächlich geladen. | Nicht den Hostglobalpfad raten oder nur die Basetemplate editieren; Reattach-Komposition beachten. |
| `<workspace>/AGENTS.md` | Repositoryarchitektur, Isolation, Scope/YAGNI, no-origin-access; keine explizite allgemeine „Commit nur nach Nachfrage“-Regel gefunden. | Origin-/Fetch-Verbot darf nicht still durch neue lokale Autonomie entfernt werden. |
| `AGENTS.mcps.md`, `AGENTS.web.md` | Optionale angehängte Sidecars; Webhinweise zu Attachments. | Keine eigene Commitfreigabe; Konditionalisierung zentral halten. |
| Aktive `config.instructions` | Nicht gesetzt. | Kein zusätzlicher konfigurierter Instructionpfad in dieser Runtime. |
| Unterverzeichnis-AGENTS im Repo | Repo-Glob fand nur Root-`AGENTS.md`. | Andere Projekte müssen separat inventarisiert werden. |
| OpenLive `OPENLIVE_WORK_TURN_SYSTEM` | Voice-/Besprechungsstil; kein managed Question-/Gitvertrag. | Kurzen zentralen Policyprimer additiv mit dem Stilprimer kombinieren. |
| A2A `OPENCODE_SYSTEM` / `OPENCODE_AGENT` | Installierter Client unterstützt statischen Systemtext/Agent; VM-Script setzt dafür keinen managed Primer. | Kann Einstieg unterstützen, löst aber Sessionadoption/-vererbung nicht allein. |
| OpenCode-Shelltool-Instruktion `tool/shell/shell.txt` | „Only commit, amend, push, or create PRs when explicitly requested.“ Im tatsächlich sichtbaren Shelltooltext vorhanden. | Konkrete Commit-Kollision liegt **auch außerhalb** von AGENTS.md. |
| Modellprompt `gpt-astra.txt` im passenden Tag | Unklarheit ansprechen/fragen; keine autonome Commitausnahme. | Managed-Primer muss fachliche Klärung als Ergebnisbericht präzisieren. |

Das aktuelle Laden der globalen und Root-AGENTS ist auch im Sessionkontext sichtbar. Eine vollständige Provenienz aller Provider-/Plugintransformationen wurde nicht per Modellrequestexport nachgewiesen; entsprechende Acceptance bleibt offen.

### 6.3 Empfohlene spätere Korrektur

- VM-weite Prinzipien konditional formulieren: manuell fragen; managed bei entscheidungsbedürftiger Unklarheit sicheren terminalen Blockerbericht liefern. Reversible Details dürfen innerhalb klaren Scopes mit dokumentierter Annahme bearbeitet werden.
- Lokale Commits für **autorisierte Entwicklungsaufträge** im Managed-Modus als bereits autorisierten Arbeitsbestandteil ausdrücken. Eine separate Commit-Nachfrage entfällt; explizite Scopeverbote bleiben bindend.
- Den Shelltooltext an einem bestätigten Definitions-/Kompositionshook konditionalisieren: managed lokale Commits erlauben, generelle Amend-/Remote-/PR-Grenzen nicht aufweichen. Reines Anhängen eines widersprechenden AGENTS-Satzes ist keine konsistente Lösung.
- Einen kurzen zentralen Systemzusatz verwenden und bei Childsessions/Reattach wieder anwenden; keinen neuen langen Boilerplateabsatz in jedem Orchestratorauftrag.
- Projektdateien anderer Benutzer nicht automatisch umschreiben. Widersprüche inventarisieren und den konkreten betroffenen Text gemäß Produktvertrag korrigieren oder Sessionadoption präzise fail-closed verweigern.
- Tatsächlich geladenen finalen Instruction-/Tooldefinitionsstand in isolierten Fixtures prüfen; keine Prompt-/Credentialpayloads produktiv loggen.

## 7. Sicherheitsmodell und Remote-Write-Inventar

### 7.1 Kanonische primäre Grenze und Nachweisstatus

Operatorentscheidung: **Der Guest enthält weder GitHub-/Origincredentials noch einen konfigurierten schreibfähigen Zugang zum operatorverwalteten Projektorigin.** Credentials und die Kontrolle über Operatorprojekt/Origin liegen außerhalb des Guest auf Host/Operatorseite. Damit bleibt Remote-Publishing operator-only, während lokale Repositoryarbeit im Taskscope autonom möglich ist.

Diese Festlegung ist das gewählte VM-Sicherheitsmodell, keine zweite Schicht hinter einer OpenCode-Policy. Keine Credential-/SSH-Agent-/Hosthelperweiterleitung, kein VM-Push-/Publish-Approvalpfad und keine Verlagerung der Host-Originsteuerung in den Guest. Die konkrete Guest-/Mount-/Config-/Agentzugangsabnahme dieses Vertrags ist Implementierungs-/Verifikationsarbeit; sie wurde durch diesen Dokumentationsauftrag nicht neu ausgeführt.

Historisch gelesene AppArmor-/nftables-Angaben und die verweigerte nftables-Inspektion bleiben Evidence. Sie machen aber eine zusätzliche originbezogene Firewall-/Brokergrenze nicht zur offenen Produktentscheidung. Fehler in Permissionregex/Plugin/Metadata oder ein synthetischer HTTP-Sink beweisen nur, dass die jeweilige **OpenCode-Schicht allein** keine harte Grenze ist; sie beweisen keinen Zugang zum operatorverwalteten Origin und widerlegen nicht dessen credential-/writable-originfreien VM-Vertrag.

Der Task führt keine allgemeine Blockade beliebiger Netzwerk-/Infrastrukturwrites ein. Der gewählte harte Vertrag betrifft den operatorverwalteten Projektorigin; bereits separat autorisierte Tool-/Infrastrukturrechte behalten ihren Scope. Erkannte Git-/Forge-/Equivalent-Publishing-Versuche werden zusätzlich als OpenCode-Verhaltenspolicy denied, ohne Freigabedialog.

### 7.2 Zu erfassende Schreibwege

| Kategorie | Tatsächlich vorhanden / relevante Erweiterung | Integrations-/Verifikationszweck im gewählten VM-Vertrag |
|---|---|---|
| Git-Porcelain | `git push`; Optionen, `-C`, `-c`, `--git-dir`, `--work-tree`, `--exec-path`, Wrapper/Ketten. | Erkannte Publikationsversuche als Defense-in-Depth denied, kein Ask; VM-Originvertrag separat abnehmen. |
| Git-Plumbing/Binaries | `git-send-pack`, `git-push`, `git-http-push`, `git-receive-pack`, `git-http-backend`. | Äquivalente Publikationspolicy/Canaries und Credential-/Writable-Origin-Abwesenheit prüfen, keine Vollprozessvermittlung neu fordern. |
| Alias-/Script-/Hookwege | Git-/Shellaliases, Funktionen, Skripte, npm/make, Commit-/Pushhooks. | Lokale Arbeit bewahren; Policyabdeckung/Limits dokumentieren; kein mitgebrachter Operator-Pushzugang im Guest. |
| Transporte | SSH/HTTP(S), git://, ext::, FD-/Remotehelper. | Keine Operatorcredentials/-Helper-/Writable-Origin-Konfiguration via Guestzugang; erlaubte Reads erhalten. |
| Lokale/file-Remotes | Fremde Bare Repos, weitere Mounts/Worktrees. | Task-/Repositoryscope bewahren; unterscheiden von operatorverwaltetem Remote-Publishing. Kein neuer allgemeiner Fremdrepo-Brokerauftrag. |
| LFS-/Forge-Clients | Git LFS / gh ggf. verfügbar. | Keine GitHub-/Origincredentials/-Weiterleitung; Publikationspolicy für exponierte äquivalente Aktionen prüfen. |
| Generische Clients | curl, Python/Node, SSH/SCP/rsync, libgit/HTTP. | Alternative Zugriffspfade auf Operatorcredentials/Originsteuerung ausschließen; generische HTTP-Writefähigkeit ist kein Gegenbeweis zur gewählten Origingrenze. |
| Zusätzliche Tools/Services | Customtools/ECC, konsumierte MCPs, Browser, Editor, Docker. | Tatsächliche Agentzugänge dürfen keinen Operatororigin-Pushzugang bereitstellen; unabhängige autorisierte Tools nicht pauschal sperren. |
| Control-Plane-Änderung | Prompt-tools, Session-/Agent-/Configupdate, Neustart. | Backendklassifikation/Non-interactive-Vertrag/Policy gegen Drift bewahren; Metadata nicht als primäre Remote-Sicherheitsgrenze behandeln. |

Ein `receive-pack`-Deny darf lokale legitime Gitoperationsprimitive nicht versehentlich mit normalen Commitobjektwrites gleichsetzen. Entscheidend ist die autorisierte Repositorygrenze und die Veröffentlichung nach außen.

### 7.3 Geschlossenes Sicherheitsdesign, verbleibende Abnahme

1. **Primär: VM-/Hosttrennung gemäß §7.1.** Guest credential-/writable-originfrei, Operatorpublikation ausschließlich Hostseite. Dieses Modell ist entschieden.
2. **Zusätzlich: OpenCode-Verhaltenspolicy/Defense-in-Depth.** Lokale Git-Allows im Taskscope, Push-/Equivalentwrite-Deny ohne Ask, frühzeitiger Questionguard, konsistente Instructions und zuverlässige Backendklassifikation.

Shellregex, Wrapper, Hooks und native Permissions werden nicht als harte Grenze beworben. Die Spike-Limits begründen Implementierungs-/Policytests, aber keine zusätzliche Firewall-/Broker-/vollständige Arbitrary-Capabilityvermittlung als Produktvoraussetzung. Erlaubte Remote-Reads werden nicht als Nebenwirkung eingeschränkt.

**G3 ist jetzt VM-Vertragsabnahme:** Fresh/Attach/Reuse prüfen tatsächlich gelieferte Guestconfig, Environment, Credential-/Helper-/Mount-/Agentzugänge sowie Operatororigin-Konfiguration. Bei Abweichung wird der festgelegte VM-Vertrag korrigiert; es ist nicht erneut über ein zweites Sicherheitsmodell zu entscheiden. Diese Dokumentationsreconciliation ersetzt keinen Live-Nachweis und aktiviert keine Produktpolicy.

### 7.4 Remote-Reads und bestehende Originregel

Das Board erlaubt read-only Remoteaktionen, **sofern sonst sicher**. Aktuelle Root-/VM-AGENTS verbieten den Zugriff auf den Benutzerorigin auch für Fetch/PR-Arbeit. Das ist ein konkreter fachlicher Schnittpunkt:

- Lokale Gitfreigabe ändert dieses Verbot nicht automatisch.
- Read-only Zugriffe auf ausdrücklich erlaubte, vom Benutzerorigin getrennte Quellen können unabhängig davon vorgesehen werden.
- Ein neues Fetchrecht am Benutzerorigin wäre separate optionale Scopefreigabe mit Abnahme des Readvertrags, keine Voraussetzung dieses Tasks und kein obligatorischer neuer Broker. Bestehende Originregel unverändert lassen; sonst erlaubte Reads erhalten.
- Keine echte Remote-/Originprobe in diesem Auftrag; spätere Deny-/Readtests benutzen ausschließlich disposables und operatorseitig bereitgestellte Fixtures.

## 8. Empfohlenes Session-/Policy-Design

### 8.1 Backend-Ingress ist Klassifikationsautorität

Jeder unterstützte agentische Ingress, der tatsächlich Arbeit schreibt, setzt/adoptiert die betroffene Arbeits-Session serverseitig als agent-managed: neue Worksession-Creation und Fortsetzung/Übernahme bestehender Session. Ein installierter WRITE-fähiger Client, aktive MCP-/A2A-/OpenLive-Verbindung oder Projekteligibility allein klassifiziert nichts um.

**READ und reine Managementcalls klassifizieren niemals um.** Das gilt auch für Management-Writes wie Rename/Archive/Modellverwaltung, Boardpflege, Attachment-Staging oder reines Call-Binding ohne Arbeits-Prompt. Agentische Worksession-Creation ist dagegen ein Work-WRITE-Trigger, auch wenn noch kein Modellturn startet. Der Client/Skill braucht weder ein Managed-Flag noch ein wiederholtes Initialisierungsprompt; der Backend-Ingress ist die Autorität. Manuelle Sessions bleiben bis zum tatsächlichen agentischen Work-WRITE manual.

Operationsvertrag:

1. Ingress klassifiziert die Operation als Work-WRITE versus READ/Management und validiert vorhandene Projekt-/Sessiongrenzen. Nur Work-WRITE löst automatische serverseitige Managed-Creation/Adoption aus; abgelehnte Busy-/Pending-/Scopeoperationen mutieren keine Session.
2. Agentische Worksession-Creation erhält Managedstate/Policy vor Rückgabe/erstem Prompt; Adoption bestehender Session vor zugelassenem Workprompt, nur idle und ohne Pending Input. Gleiche ID/History/Runtime bewahren.
3. Managed-Zustand wird persistent an die Session gebunden; bloßes `--no-mcp` oder ein UI-Reconnect entfernt ihn nicht.
4. Bei bereits laufender/fachlich oder sicherheitstechnisch blockierter Session erfolgt keine heimliche Umstellung, Antwort oder Abbruch. Der Sender erhält den bestehenden präzisen Busy-/Input-/Uncertain-Fehler.
5. Backend-Preflight verifiziert sticky Managedstate und effektive Regeln vor jedem zugelassenen Workturn, statt Clientflag/Promptprosa zu vertrauen; inkompatible Zustände werden präzise verweigert.
6. Agent-/Modellwechsel verändern das Leistungsprofil, nicht die Klassifikation oder den VM-Vertrag. Reine Modellverwaltung adoptiert eine bisher manuelle Session nicht.
7. Children aus einem Managed-Workstream werden automatisch synchron vor erstem/reused Workprompt adoptiert/vorbereitet. Auch ein bisher manuell gebundener reused task_id benötigt Backendadoption nach Scopevalidierung; Parentlinie allein genügt nicht.

Native metadata/permission wurden im Spike geprüft; PATCH-Metadata ersetzt, PATCH-Permission hängt an, Prompt-tools ersetzt das Ruleset. Persistenz/Idempotenz/Readback sind Implementierungsarbeit. Beispielname metadata.ocvm.agentManaged bleibt ein Entwurf; niemals Client-/Skillflag oder Credentialcontainer. Backend-owned Klassifikation muss zuverlässig bleiben, aber ist keine zweite primäre Remote-Write-Sicherheitsgrenze und erzwingt keine neue externe Securityregistry.

Kein neuer allgemeiner MCP-Permissioneditor wird benötigt. Die Managedinitialisierung ist eine enge server-/adapterseitige Eigenschaft des autorisierten Agentenpfades. Ein eigener zusätzlicher Registry/Daemon ist nur zu rechtfertigen, wenn der native Statevertrag nachweislich nicht ausreicht.

### 8.2 Policykomposition

- Bestehende benutzerspezifische Denies für Read-only-, Infrastruktur- oder Credentialscope bewahren; nicht durch einen neuen Top-level `* allow` überfahren.
- `question` explizit deny, zusätzlich V1-Executionguard.
- Die bestehenden Commit-Ask-Regeln im Managedscope durch lokale Allow-Regeln ablösen; keine Session-wide Auto-Approval unabhängiger asks.
- Gewöhnliche lokale Gitoperationen/Commits innerhalb des autorisierten Repositorys ohne Bestätigung zulassen; explizite Read-only-/Task-/Agentrestriktionen bewahren. Allowkomposition ist Implementierungsdetail innerhalb des festgelegten VM-Vertrags.
- Spezifische Push-/Equivalentwrite-Denies als Defense-in-Depth nach lokalen Allows installieren; G1 prüft no-Ask/Always-Allow-Kompatibilität, nicht eine primäre harte OpenCode-Grenze.
- Globale und eigene Agentoverrides sowie alle exponierten Subagents gegen die Invariante prüfen. OpenLive-Manager bleibt deny-by-default/read-only.
- Ein Policyupdate darf vorhandene unrelated Regeln nicht verlieren. Native `tools`-Replacement erkennen/verhindern oder vor Admission die korrekte Policy sicher wiederherstellen; unbekannte Stateübergänge fail-closed.

Keine Blanket-Allows für unrelated Tools oder explizite Scope-Denies. Die Git-Allow-Komposition muss übliches lokales Arbeiten ohne Commit-Ask ermöglichen; Remote-Deny bleibt explizite Verhaltenspolicy. Eine vollständige neue Prozess-/Transportvermittlung ist kein zusätzliches Freigabegate für diesen entschiedenen Vertrag.

### 8.3 Zentraler Primer

Zielinhalt, zentral und kurz; Wortlaut vor Integration mit den tatsächlichen Toolinstruktionen abgleichen:

> Diese Arbeits-Session wurde vom Backend als agent-managed klassifiziert. Bearbeite den autorisierten Auftrag im Scope; gewöhnliche lokale Git-Arbeit/Commits benötigen keine separate Bestätigung. Keine direkten fachlichen Questions/UI-Prompts. Fehlt eine Entscheidung, liefere einen terminalen INPUT_REQUIRED-Bericht mit konkreter Frage, Kontext und sicheren Optionen; der Orchestrator antwortet als normaler Folgeturn derselben Session. Remote-Publishing ist operator-only: der Guest hat keine GitHub-/Origincredentials und keinen schreibfähigen Operatororigin; Push-/Equivalentwrite-Policy denied zusätzlich ohne Ask. Keine Credentials einrichten oder Scope/Policy umgehen.

Der Primer ist keine Berechtigung für den aktuellen Planungsauftrag zu committen oder produktiv zu implementieren. Ein explizites „nur diese zwei Dateien“ bleibt enger als die generelle Modusfähigkeit.

Ein session-aware zentraler Plugin-/Kompositionspunkt ist gegenüber mehrfachen divergent kopierten Transportprimern bevorzugt. Der Spike belegt verfügbare Hooks und deren Limits; Integration bindet alle tatsächlichen Work-Ingress-/Childpfade an denselben Backendvertrag. Ein angebotener Workpfad darf nicht still als manual weiterlaufen, wenn Adoption/Policy noch fehlt; vor Workadmission präzise verweigern. Kein Primer-/Managedflag als Clientpflicht.

## 9. Fachlicher INPUT_REQUIRED-Vertrag

Fachlicher Blocker ist sichtbarer Assistanttext mit regulärem terminalem Ergebnis, **kein** natives Questionobjekt, keine versteckte Elicitation und keine laufende Toolfrage:

```text
INPUT_REQUIRED:
- decision: <konkrete fehlende Information oder Entscheidung>
- context: <warum sie für diesen Auftrag erforderlich ist>
- safe_options: <wenige sichere Optionen mit Konsequenzen>
- completed: <bereits verifizierter Teilstand>
- paused: <welche Arbeit ohne Antwort nicht fortgesetzt wird>
```

Regeln:

- Keine Entscheidung erfinden, deren Folgen den freigegebenen Scope/Outcome verändern.
- Unabhängige bereits autorisierte Arbeit darf fertiggestellt werden; terminaler Bericht nennt die Grenze eindeutig.
- Der Bericht wird als fachlich blockiert gelesen, auch wenn OpenCode den Assistantturn technisch `completed` nennt. Keine neue globale Taskstatemigration erforderlich.
- Der Orchestrator liest den korrelierten Originalbericht, klärt die konkrete Frage im normalen Chat-/Voicekanal, prüft dann die **gleiche** Session auf idle und Pending Input und sendet genau einen autorisierten normalen Follow-up.
- Kein Auto-Answer, kein `question.reply`, kein neuer MCP-Permissionantwortpfad und keine automatische Promptwiederholung.
- Echte Pending-Permissions behalten den existierenden `INPUT_REQUIRED`-Adapterfehler und Web/TUI-/Operatorauflösungsweg; sie werden nicht als fachlicher Textblocker umetikettiert oder mit einer fachlichen Antwort freigeschaltet.
- Überraschend auftretende native Questions in Managedsessions gelten als Policydrift, nicht als Einladung zur automatischen Antwort. Zustand/eindeutige Ursache melden; keine fremde Session mutieren.

MCP `get_task_result`/`get_message`/`read_message_content` können normale sichtbare Texte bereits lesen. A2A besitzt einen eigenen Interrupt-/Taskstatepfad; OpenLive erkennt Asked-Events und verweist heute auf Web/TUI. Dieses technische Verhalten für echte Permissions erhalten; fachliche Blocker sollen vorher als normaler Antworttext enden.

## 10. Abhängigkeiten und Konfliktmatrix

### 10.1 cce3 – r20-Abschlussverifikation

Task: `task_cce3a196-9611-5cf6-9f74-c98720211548`.

- Quellen-/Dokumentstand r20 vorhanden; Board-GET `in_progress`.
- Die verlinkte Abschlussverifikationssession wurde zuerst read-only anhand ihrer letzten fünf Nachrichten geprüft; damals war sie noch nicht terminal. Der abschließende Refresh lieferte den Originalbericht `msg_0ef9b20b4001FTOk1F8Wu2VPcB` mit `finish:stop`, ohne Fehler: r20 lokal/synthetisch **done-ready**, 15 Tests bestanden, Build-/Inventar-/Checksum-Check und `git diff --check` bestanden. Nur der synthetische Flowtest wurde um Partial-Retry und vollständige Dokument-/Boardreadbackbedingungen ergänzt; Paketinhalt blieb unverändert.
- Die notwendige **lokale/synthetische Integrationsbaseline liegt damit jetzt vor**. Vor gemeinsamem Edit den aktuellen Stand/Hunkbesitz erneut reconciliieren; dies ist keine Laufzeitabhängigkeit von Questions oder Gitpermissions.
- r20s Vertrag `CONCEPT_READY -> REGISTERED -> BOARD_MOVED` bleibt unverändert. Der neue Managedmodus verändert nicht die Initialisierungs- oder Boardzustandssemantik.
- Der terminale Bericht belegt weder reales Hosted-ChatGPT-/Voiceverhalten noch einen Live-Connector-Follow-through. Dieser ausdrücklich verbleibende Smoke-Gap blockiert die isolierte Managedpolicyarbeit nicht. Die berichteten Tests wurden hier nicht dupliziert; Quelle ist das korrelierte Originalergebnis.

### 10.2 d994 – additive Low-Risk Board-Writes

Task: `task_d9944c0e-5acb-5d73-8030-4fbc0c025be0`.

- Board-GET `todo`, Concept Plan/Compact Context bereits vorhanden und als `not-started` konzeptionell vorbereitet.
- Vorgesehener Scope: Management-Note-Append, add-only Hauptdokumentbinding, Bundle, MCP-Annotations, Orchestrator-Preferred/Fallback-Integration.
- Diese Writes sind keine Voraussetzung für Managedsession-Erkennung, fachliche Blockerberichte, lokale Commits oder Remote-Deny.
- MCP-Client-Approval-Reduktion durch ehrliche Low-Risk-Annotations ist von OpenCode-Backend-Questions und Shellpermissions getrennt. Keine Annotation garantiert non-interactive Backendverhalten.
- Sobald beide Tasks `tools.ts`, `types.ts`, `http.test.ts`, Vertragsdokumentation oder Releasepins berühren, gibt es Integrations-/Versionskonflikte; Taskboard-Servicecode bleibt fachlich getrennt.

### 10.3 Konkrete spätere Produktdateien

| Komponente / Datei | Erwartete Änderung dieses Tasks | Überschneidung / Timing |
|---|---|---|
| `opencode-vm.sh` | Transporteligibility, Fresh-/Attach-Policyinstallation, verwalteter Plugin-/Primerpayload, VM-AGENTS-Komposition, Enforcement/Readiness; Patchbump. | d994 ändert voraussichtlich Adapterpins/Version im selben Script. Hunk-/Releasekoordination, keine konkurrierenden Bumps. |
| Neuer gebündelter Policy-/Pluginpayload und Tests | Reine Komposition, Frageguard, managed-aware Tool-/Systemtext, Klassifikation; Standaloneparität wahren. | Isoliert parallel gut startbar; Ablage erst nach Spike konkret festlegen. |
| `adapters/mcp/src/opencode.ts` | Creation/Adoption/Send-/Runtime-Preflight und Readback. | Kein r20-Produktcodekontakt; d994 primär andere Servicedatei, gemeinsamer Adapterrelease. |
| `adapters/mcp/src/tools.ts`, `types.ts`, `http.test.ts`, `opencode.test.ts` | Nur falls Policyreporting/Fehler-/Runtimevertrag erweitert werden muss; kein allgemeiner Permissioneditor. | d994 gemeinsamer Katalog-/Wire-/Versionsbereich; Integration serialisieren. |
| `adapters/mcp/src/taskboard.ts` | Für Managedmodus voraussichtlich keine Änderung. | d994 besitzt diesen Featurebereich; nicht hineinrefaktorieren. |
| `adapters/mcp/src/agent-control.ts`, `hub/policy.py` | Modellprofile bleiben eigenes Konzept; nicht als Managedpolicy missbrauchen. | Keine Pflichtänderung ohne konkret nachgewiesenen Bedarf. |
| `adapters/openlive-acp/src/core/call-controller.ts`, `src/opencode/gateway.ts`, Sessionerzeugungs-/Inspectorpfade und Tests | Worksessionadoption/-creation, Primerkomposition, Managergrenze. | Keine fachliche d994-/r20-Abhängigkeit; eigener Adapterrelease/Standalonepayload. |
| A2A-Startpayload in `opencode-vm.sh`, ggf. definierte Upstream-/Bridgeintegration | Create/preferred-session-Reuse und statische Agent/Systemsettings an zentrale Policy anbinden. | Installierte site-packages sind Inspect-Evidence, keine dauerhafte Produktänderungsstelle. |
| `AGENTS.md`, `README.md`, `docs/MCP-INTERFACE.md`, `docs/A2A-INTERFACE.md`, OpenLive-/Editor-Doku soweit Vertrag betroffen | Effektive Regeln, manual vs managed, Denygrenze, Read-/Approvallimits. | d994 gemeinsame Root-/MCP-Dokumente; kleinste fachbezogene Hunks koordinieren. |
| `integrations/chatgpt/opencode-session-orchestrator/SKILL.md` und relevante Referenzen | Normalen fachlichen INPUT_REQUIRED lesen/klären/follow-up; keine blanket Approvalfreigabe. Klassifikation/Primer werden backendseitig installiert, kein Skillflag/Managedinitialisierungsritual. | Bei später autorisierter Skilldokumentation aktuelle r20-/d994-Baseline und Preferred/Fallback-Binding erhalten. |
| `tests/chatgpt_skill_test.py`, `bundle.json`, Changelog, `latest.json`, ZIP, SHA | Spätere Skillregression und nächste freie Bundle-Revision. | Hohe Dreifachüberlappung. Ein finaler gebündelter Integrations-/Buildslot, keine parallel generierten Artefakte. |
| Adapterpakete/-locks, `src/types.ts`, Releasebuildscripts/-tests, Scriptpins | Nur bei tatsächlichen Produktänderungen korrekt neu versionieren/builden. | Versionen beim Start neu lesen; d994s vorgeschlagene 0.1.18/0.6.4/r21 sind Reservierungsideen, nicht exklusiv zugesichert. |

### 10.4 Entscheidung A/B/C

- **A vollständig parallel:** verworfen, weil Shared Skill-/Tests-/Releaseartefakte und möglicherweise Wire-/Scriptdateien überlappen.
- **B Design/isolierte Teile parallel, Integration später:** empfohlen. Jetzt/bei gesondertem Implementierungsauftrag reine Policy-/Scope-/Instruction- und Compatibilityfixtures in eigenen Dateien; danach Ingress-/Lifecycleintegration nach Hunkkoordination; Skillintegration nach r20-Readback, mit d994-Abgleich.
- **C vollständig warten:** nicht begründet. Keine harte fachliche oder technische Vorbedingung zu r20/d994 für die isolierten Arbeiten. Eigene G1–G3 können isoliert untersucht werden.

## 11. Alternativen und Entscheidungen

| Alternative | Bewertung |
|---|---|
| Nur AGENTS/Prompt ergänzen | Zu schwach: Questions bleiben verfügbar, Commit ask bleibt aktiv, Deny wäre nicht technisch. |
| Global `permission:allow` plus Pushstrings | Verletzt native Scope-/Manualrestriktionen; keine ausreichende Verhaltenspolicy. Primäre VM-Origingrenze bleibt separat. |
| `opencode run --auto` | In installierter CLI vorhanden, aber client-/CLI-spezifisch; löst persistente MCP/A2A/Reuse-Verträge und Questions nicht zentral. Keine Empfehlung für Blanket-Autoapprove. |
| Ein dedizierter Managed-Primaryagent | Gut sichtbares Profil, aber Agentname/Providerprompt/Customagents/Childrules/Reuse müssten verändert werden. Allein keine Vererbungsgarantie. Als optionaler UI-Name erst bei realem Bedarf. |
| Nur native Sessionpermission | Hilfreich für Scoping; V1-Approval-/Tools-/Question-/Childkompatibilität benötigt Backendintegration. Keine primäre Remote-Securitygrenze. |
| Zentraler session-aware Policy-/Instructionlayer plus Ingressbinding | Bevorzugte funktionale Richtung: eine Semantik, Reuse/Childprüfung, keine globale manuelle Lockerung. Hookabdeckung zuerst verifizieren. |
| PATH-Gitwrapper / pre-push-Hook | Leicht umgehbar über Binary, `--no-verify`, Skript oder anderen Client. Nicht als harte Grenze akzeptieren. |
| Alle Git-Remoteendpoints sperren / neuer read-only Broker | Keine Voraussetzung des gewählten VM-Vertrags; würde erlaubte Reads unnötig einschränken. Primäre Grenze credential-/writable-originfrei, Policy zusätzlich deny. |
| V2 migrieren, weil Saved-Deny besser ist | Löst einige Semantikprobleme, aber ist eine größere Runtime-/Adaptermigration und keine vollständige Prozess-/Netzwerkgrenze. Nicht automatisch Bestandteil dieses Tasks. |
| Question automatisch beantworten/rejecten | Verworfen: erfundene Fachentscheidung oder Mutation eines laufenden Dialogs; verhindert die Ursache nicht. |

Festgehaltene Konzeptentscheidungen:

1. Automatische serverseitige Klassifikation an jedem tatsächlichen agentischen Work-WRITE-Ingress, Workcreation und Fortsetzung/Adoption. READ/Management ohne Umklassifikation; kein Client-/Skillflag. Manual bis zum tatsächlichen Work-WRITE, Manager bleibt eigener Scope.
2. Managedzustand sticky über Reuse, UI-Zugang, Agentwechsel und Neustart; kein stiller Downgrade durch Transportabschaltung.
3. Fachlicher Blocker als regulärer terminaler Bericht; echte Securitypermissions nicht umgehen.
4. Lokale Commits sind autorisierbarer Bestandteil von Entwicklung, keine neue Operatorfreigabe pro Commit. Enger Taskscope bleibt maßgeblich.
5. Primäre harte Grenze: keine GitHub-/Origincredentials/kein schreibfähiger Operatororigin im Guest; Host/Operator hält Credentials/Originsteuerung. OpenCode-Remote-Denies no-Ask als Defense-in-Depth, mit Always-Allow-Regressionsprüfung.
6. Neue/reused Children aus Managed-Workstream automatisch vor Workprompt backendseitig adoptieren; native Parentvererbung/Marker allein nicht als vollständige Implementation annehmen.
7. Shelltool-Instruktion ausdrücklich im Konfliktinventar; nur AGENTS anzupassen wäre unvollständig.
8. Kein produktiver Implementierungsstart oder Board-Move durch diesen Agentencheckpoint; Empfehlung B für einen später autorisierten Start.

## 12. Konfliktarme Phasenplanung

### Phase 0 – Initialisierung, jetzt abgeschlossen

- Zielpfade prüfen, Ist-/Versions-/Board-/Nachbartaskstand lesen.
- Beide kanonischen Dokumente mit Task-ID initialisieren und zurücklesen.
- `CONCEPT_READY` liefern. Orchestrator registriert/readbackt/bewegt nach seinem bestätigten Vertrag.

### Phase 1 – isolierter V1-Spike, abgeschlossen

1. Runtime- und Schemafingerprint neu lesen; tatsächliche V1/V2-Pfade bestimmen.
2. In separaten temporären Projekten Regeln/Order, native Sessioncreate/update, Reuse, `tools`-Replacement, Always-Allow und Question-Execution untersuchen.
3. Parent-/Child-Neuerzeugung und bestehende `task_id`-Reuse mit widersprechenden Customagentregeln prüfen.
4. Final geladene globale/Root-/Subdirectory-/Shelltoolinstruktionen erfassen; session-aware Hooks für kompakten Primer und Konfliktauflösung beweisen.
5. OpenCode-Policy-/Hooklimits festhalten und vom primären VM-Vertrag unterscheiden; Operatorentscheidung in §17 übernimmt die Sicherheitsmodellwahl. Effektive VM-Vertragsabnahme bleibt späterer Implementierungscheck.

**Exit erreicht:** 25 Probes liefern konkrete V1-/Hook-/Child-/Instruction-Evidence. §17 schließt Produktentscheidungen; G1–G3 bleiben Implementierungs-/Abnahmepunkte. Keine produktive Permissionslockerung durch Spike oder Reconciliation.

### Phase 2 – gemeinsamer Backendvertrag und MCP-Workadmission, koordiniert

1. Aktuelle Hunk-/Versionslage reconciliieren; **Operationsinventar** erstellen: Work-WRITE versus READ/Management je actual MCP/A2A/OpenLive/ACP/REST-Agentenpfad (§17.2). Keine pauschale Klassifikation wegen Clientname/Toolannotation/aktivem Service.
2. Gemeinsames backendseitiges ensure/adopt in MCP Worksession-Creation, send_message und tatsächlichem supersede-Workprompt integrieren. Bestehende Project-/Idle-/Pending-/Uncertainchecks zuerst; klassifizieren/persistieren/policy-readbacken vor erlaubter Workadmission. Kein Clientflag, kein neuer Permissioneditor.
3. Native Metadata-/Permission-Preservation und idempotente Updates, Scope-/Agent-Denies und Toolsdrift behandeln. READ/Management dürfen keine klassifikationsbedingte Marker-/Managedpolicymutation auslösen; normale autorisierte Managementupdates behalten ihren eigenen Scope.
4. Non-interactive Questionguard **und kontrollierten terminalen Outcome** integrieren; gewöhnliche Toolfehler allein reichen nicht. INPUT_REQUIRED-Frage/Kontext/Optionen sichtbar speichern, idle/Folgeturn herstellen. Unabhängige echte Securitypermissions erhalten.
5. Lokale Git-/Commit-Allow-Semantik ohne Bestätigung im Scope, Remote-Deny no-Ask als Defense-in-Depth, konsistente VM-/Shell-/Agentinstructions. Keine blanket Grants für unrelated Rechte.

**Exit:** flaglose serverseitige Workcreation/-adoption plus READ-/Management-/Manualregression, wirklicher terminaler Handback/Folgeturn und lokale Commit-Autonomie; kompatible V1-Defense-in-Depth dokumentiert. Primärer VMvertrag wird separat in Phase 4 abgenommen, nicht durch eine neue externe Sicherheitsarchitektur ersetzt.

### Phase 3 – automatische Childadoption und weitere tatsächliche Work-Ingresspfade

1. Synchroner Hook nach TaskTool-Childauswahl/Creation vor TaskPromptOps.prompt: neue/reused Kinder automatisch managed adoptieren/policy-vorbereiten, einschließlich früherer manueller Parentlinie im autorisierten Scope. Nicht zulässige Project-/Busy-/Pending-/Scopezustände präzise ablehnen; keine async Eventrace als Ersatz.
2. A2A Workcreation, neue/reused Kontexte und preferred-session Workturns; OpenLive lokale/remote Workcreation und Workturns an denselben Backendvertrag anbinden. Read-only Manager nicht umklassifizieren/aufweiten; reines Call-Binding ohne Workprompt ist Management.
3. Weitere tatsächlich agentisch schreibende ACP/REST-/Shellpfade anhand Inventar integrieren; manuelle Web/TUI-Nutzung bleibt manual bis agentischem Write. Unerfasste tatsächlich angebotene Workpfade sind Implementierungsabdeckung, keine optionale Klassifikationsausnahme.
4. Echte Permissions-/Uncertain-/Ownership-/Project-Confinement-Regeln erhalten; Shared-Adapter-/Wireintegration mit Nachbartasks koordinieren.

**Exit:** jeder angebotene tatsächliche agentische Work-WRITE und alle Managed-Children haben automatische Adoption vor erstem Workprompt; Reads/Management allein haben keinen Seiteneffekt.

### Phase 4 – Lifecycle und Abnahme des festgelegten VM-Vertrags

1. Fresh-/Reattach-/Reconnect-/Restart-/Standalone-/--no-mcp-Parität; sticky backendseitiger Managedstate, separate manuelle Sessions und bestehende Daten bewahren.
2. Nachweisen: im Guest keine GitHub-/Origincredentials, Weiterleitung oder schreibfähiger Operatororigin über effektive Gitconfig (einschließlich .git/config und Configincludes), Environment/Githelper/Mounts/Agentzugänge; Credentials und Projekt-/Originsteuerung bleiben Host/Operatorseite. Auch tatsächlich verfügbare Tools dürfen diesen Operatorzugang nicht in den Guest zurückreichen.
3. Bei Vertragsdrift gezielt den gewählten VMvertrag korrigieren. **Kein zusätzlicher Broker, pauschaler Remote-Read-Deny oder neues externes Enforcementmodell als Voraussetzung.** Kein Produktionspush/Credentialimport als Test; zulässige disposable/synthetische Nachweise und Hostacceptance planen.
4. Erlaubte Read-only-Gitpfade erhalten; Policy-/Pluginload-/Scope-/Handbackreadiness verifizieren. Unsupported Runtime-/Schema-/Policyzustände präzise behandeln; keine Readiness aus bloßem Configeintrag ableiten.
5. Erforderliche spätere Script-/Releaseänderungen in einem gemeinsamen Slot koordinieren.

**Exit:** implementierter Managedvertrag und überprüfte credential-/writable-originfreie Guest-/Hosttrennung, funktionale erlaubte Reads, reale macOS/Lima-Lifecycleabnahme. Kein neuer allgemeiner Arbitrary-Write-Brokerauftrag.

### Phase 5 – Orchestrator und Abnahme nach r20

- Terminalen r20-Stand/Readback und aktuelle freie Skillrevision feststellen.
- d994s bereits vorhandenen/neuen Preferred/Fallback-Vertrag erhalten.
- Fachliches `INPUT_REQUIRED` klar von Adapter-/Pending-Permissionfehlern trennen; same-session Follow-up-Regressionsfälle.
- Skill/Client nutzt normale Work-/Readcalls ohne Managedflag oder wiederholtes Initprompt. Klassifikation/Primer bleiben Backendaufgabe; Voice/Chat liefert fachliche Antwort als normalen gleichen Sessionturn.
- Gemeinsame Skillquellenintegration, Changelog-/Inventar-/Bundlebuild in einem Slot.
- Live macOS/Lima/MCP/A2A/OpenLive-/ChatGPT-/Voice-Acceptance; Ergebnis nachweisbezogen melden.

**Exit:** vollständiger Taskoutcome mit Operator-only Remote-Write, manual Regression und tatsächlichem Instructionsmoke. Kein Hosted-Erfolg aus synthetischen Skilltests ableiten.

## 13. Test- und Acceptance-Plan

### 13.1 Matrix

| ID | Fixture / Aktion | Erforderlicher Nachweis |
|---|---|---|
| T01 | Agentische MCP-Worksession-Creation ohne Managedflag | Automatische serverseitige Klassifikation/Policy vor Rückgabe/erstem Prompt; Readback; keine Credentials. |
| T02 | Bestehende manuelle idle Session via MCP-Work-WRITE fortsetzen | Automatische Adoption vor Workadmission ohne Flag; gleiche ID/History/Runtime, sticky Persistenz; kein verdeckter Prompt/Retry. |
| T03 | Busy oder Pending Input bei Adoption | Keine Sessionmutation/Antwort/Abort; präziser bestehender Fehler. |
| T04 | Unmarkierte manuelle Session im selben Projekt | Questiondialog grundsätzlich nutzbar, interaktive normale Regeln nicht automatisch gelockert. |
| T05 | Absichtlicher Questionversuch in Managedsession | Tooldeny/Guard, kein Question-Asked-/Pending-Questionzustand und kein UI-Dialog; terminaler nachvollziehbarer Outcome. |
| T06 | Fachliche Entscheidung fehlt | Normaler vollständiger `INPUT_REQUIRED`-Originaltext, terminaler Turn, idle Backend, keine offene Question. |
| T07 | Orchestrator liefert Antwort | Ein normaler Follow-up in dieselbe Session; nachvollziehbare Fortsetzung, keine `question.reply`-/Approvalcalls. |
| T08 | Unabhängige echte Securitypermission | Keine blanket Allow-/Autoantwort-/Statusumdeutung; bestehender Sicherheits-/Operatorpfad bleibt wirksam. |
| T09 | `status`, `diff`, `log`, `add`, `restore`, Branching, lokaler Commit und lokaler Tag im disposable Repo | Echte lokale Gitänderung ohne Question/Permissiondialog; SHA und Diff stimmen; kein fremdes Repo berührt. |
| T10 | Read-only-/Zwei-Dateien-Auftrag in Managedsession | Allgemeine lokale Fähigkeiten erzeugen keine Scopeausweitung/automatischen Commits/Produktimplementation. |
| T11 | Geladene global/project/subdir AGENTS und Shelltool-Commitregel | Tatsächlich komposierter Text ist konditional konsistent; Agent committet autorisierte Entwicklung ohne Commit-Nachfrage. |
| T12 | Direkter Push-/Dry-run-Versuch über kontrollierte Canary-Fixture | OpenCode-Defense-in-Depth no-Ask denied; keine echte Publikation. Primäre VM-Originabnahme getrennt T28/T29. |
| T13 | Optionen, Absolute Binary, Wrapper/Kette/Whitespace, send-pack/http-push | Erkannte/exponierte äquivalente Publikationspolicy und Limits prüfen; no-Ask-Backend-/Canaryzustand, keine harte Garantie allein aus Regex. |
| T14 | Alias/Skript/Hook/Helper/anderer Client und lokale/file-Remotes | Policyabdeckung und Taskscope prüfen; keine Operatorcredentials/-Originsteuerung via alternativen Agentzugang. Generic-/Canarywrite ist kein VM-Origin-Gegenbeweis oder Auftrag zu allgemeiner Netzwerkblockade. |
| T15 | Read-only erlaubte Remote-Fixture (`fetch`, `ls-remote`) | Funktioniert ausschließlich gemäß freigegebenem Readvertrag; Benutzerorigin bleibt ohne neue Entscheidung gesperrt. |
| T16 | Always-Allow schon vorhanden; danach Managed-Adoption | Frühe no-Ask-Defense-in-Depth/Questiongrenze trotz Grant prüfen; V1-/V2-Pfade unterscheiden. Keine primäre OpenCode-Sicherheitsgarantie ableiten oder Produktapproval als Fixture nutzen. |
| T17 | Agentoverride setzt `question allow`/breites Shellallow | Effektive Managedpolicy/Guard verliert keine Invariante. |
| T18 | Neue/reused Children einschließlich manuell gebundener task_id im Managed-Workstream | Automatische Backendadoption/Policy vor erstem Workprompt ohne Clientflag; Scope bewahren, keine Questions, lokale Commits; kein Parentline-only-Gap. |
| T19 | tools-Replacement, Metadataupdate, Agentwechsel | Backendklassifikation/Non-interactive-Vertrag/effektiven Scope gegen Drift erhalten; Native-Policy nicht mit primärer VM-Origingrenze verwechseln. |
| T20 | Reattach, frischer Runtimeprozess, `--no-mcp` für einen Lauf | Sticky Managedsession bleibt; unmarkierte manual Session bleibt manual; keine implizite Grant-/Credentialänderung. |
| T21 | A2A neue Kontextsession, Context-Reuse, preferred-session | Identische Invarianten; Directory-/Identity-/Workspacegrenzen bleiben. |
| T22 | OpenLive lokal/remote Workattach/-creation und Manager | Workpolicy wirksam, Voiceprimer erhalten, Manager bleibt read-only. |
| T23 | Konfigurierte ausgehende Playwright-/Proxmox-MCPs allein | Kein falscher eingehender Managedtrigger; deren Rechte nicht unaufgefordert erweitern. |
| T24 | Unsupported Runtime-/Schema-/Policyzustand | Keine Managed-Readiness-/Securityerfolgsbehauptung; präziser fail-closed Compatibilitybericht. |
| T25 | Skillintegration auf aktueller r20-/d994-Baseline | Checkpoints unverändert; kein automatischer Boardmove, kein Managedflag/Initritual; normaler fachlicher Same-Session-Follow-up. |
| T26 | Nur READs an einer manuell erzeugten Session über WRITE-fähigen Ingress | Keine Umklassifikation/Policymutation: list/get/history/result/progress/activity und vergleichbare Reads. |
| T27 | Reine Managementcalls/Writes ohne Workprompt | Rename/Archive/Runtimeverwaltung, Attachment-Staging, Boardpflege/reines OpenLive-Binding klassifizieren nicht um; bereits managed bleibt managed. |
| T28 | Effektiver Guest bei Fresh/Attach/Reuse | Keine GitHub-/Origincredentials/-Weiterleitung/Hostcredentialhelper und kein konfigurierter schreibfähiger Operatororigin in Config/Env/Mount-/Agentzugängen. VMvertrag abnehmen, kein zweites Sicherheitsmodell wählen. |
| T29 | Host-/Operatorpublikation und alternative Guest-Agentzugänge | Credentials/Originsteuerung bleiben außerhalb VM, kein Tool/MCP/Editor-/Dockerzugang stellt Operatorpushfähigkeit bereit; ohne echten Produktionspush/Credentialimport nachweisen. |
| T30 | Gleicher manueller Chat: READ/Management, dann tatsächlicher agentischer WRITE, danach UI/Reuse | Zuerst manual, am Write serverseitig managed, danach sticky; vollständig ohne Managedflag/Skillparameter. |

### 13.2 Nachweisstufen

1. **Reine Unit-/Schemafixtures:** Klassifikation, Reihenfolge, Merge/Preservation, Reporttext, untrusted Marker-/Versionzustände. Keine neuen Runtimeprozesse oder realen Usergrants.
2. **Isolierte OpenCode-Integration:** kontrollierter Model-/Toolfixture, temporäre Session/Childstate, echte Gitcommits, Always-Allow-/Questionevents, realer Permission-/Instructionsreadback. Produktion niemals als mutable Testfixture verwenden.
3. **Isolierte Policy-/Readfixtures:** instrumentierte Canaries/lokale Bare-Repos prüfen Defense-in-Depth und erlaubte Reads; keine echte Publikation oder Benutzerorigincredentials. Keine neue allgemeine Transportvermittlung als Testvoraussetzung.
4. **VM-/Hostacceptance:** tatsächliche macOS/Lima-Fresh-/Reattachparität, credential-/writable-originfreier Guest-/Hostvertrag T28/T29 und angebotene Work-Ingressadapter.
5. **Hosted Client-/Voiceacceptance:** Nutzer hört fachliche Frage im Orchestrator, antwortet dort, gleiche Worksession führt fort; reale Tool-/Hostapprovals werden getrennt behandelt.

Relevante vorhandene Checkfamilien für den späteren Patch, abhängig vom tatsächlich geänderten Bereich:

- MCP: `npm run check`, `npm test` in `adapters/mcp`; Integrationfixture nur explizit auf disposable Runtime.
- OpenLive: Paket-Check/Test nach dessen vorhandenen Scripts; existierende Manager-/Callroutingregressionen.
- VM: passende `tests/mcp_adapter_test.sh`, A2A-/OpenLive-/Lifecyclefixtures, neue eng benannte Managedpolicytests; native macOS Bash prüfen, soweit Hostscript geändert.
- Shell: `bash -n opencode-vm.sh` und `shellcheck` für betroffene Zeilen; keine unrelated Massenbereinigung.
- Release: deterministische Adapterbuilds/Pins und `tests/release_metadata_test.py`, wenn Paket/Script geändert.
- Skill: `python3 -B tests/chatgpt_skill_test.py`, `python3 scripts/build-chatgpt-skill.py --check`; Quellen plus Artefakte zusammen, nächste tatsächlich freie Revision.

Heute wurden keine dieser mutierenden Feature-/Runtime-/Gitfixtures und keine parallele r20-Testwiederholung ausgeführt. Die heutige Validierung ist Konzept-/Dokumenten- und read-only Istprüfung.

## 14. Risiken, geschlossene Entscheidungen und verbleibende Integrationsarbeit

| Risiko | Behandlung / Gate |
|---|---|
| V1 Always-Allow neutralisiert native Deny | G1: Defense-in-Depth-Guard/Kompatibilität nachweisen; primärer VMvertrag bleibt davon getrennt. |
| Question nur versteckt, Executor erreichbar | G2; Executionguard und Asked-/Pending-Negativnachweis. |
| Shellregex wird als primäre Remotegrenze dargestellt | G3: credential-/writable-originfreien VMvertrag abnehmen; keine neue vollständige Capabilityvermittlung aus Pattern-Spike ableiten. |
| Manuell genutzte Sessions verlieren Interaktivität | Sessionbezogene Adoption, nicht globaler `web => managed`-Schalter. |
| Neuer `* allow` entfernt vorhandene Restriktionen | Bestehende Denies bewahren; alle Agents/effective rules readbacken. |
| Native Sessionupdate/Toolsreplacement löscht Managedpolicy | Backend-owned Klassifikation/Preservation/Readback und Preflight; Marker kein Clientflag/primärer Remote-Securityanker. |
| Child reuse/anderer Agent verliert Marker/Local-Allow | Parentlinie, Childinitialisierung und Reusefixture. |
| Neues Agentprompt ersetzt gesamten Providerprompt | Kurzer additiver System-/Toolkompositionspunkt; tatsächliches Laden testen. |
| AGENTS erlaubt Commit, Shellinstruktion verbietet ihn | Beide Ebenen konsistent konditionalisieren, nicht nur Prosaoverride behaupten. |
| Userorigin-Fetch wird nebenbei erlaubt | Originregel bleibt bis expliziter Produktentscheidung; getrennte Readfixture. |
| Tests/Commits erfassen fremde laufende Änderungen | Disposable Policyfixtures, enge Dateiscope-/Hunkownership; keine allgemeinen Cleanup-/Gitaktionen. |
| r20/d994-Artefakte oder Versionen driften | Bestätigter r20-Readback, gemeinsame Integrationsslots und finale deterministische Builds. |

### Geschlossen versus noch zu erledigen

- **Geschlossene Produktentscheidungen:** Backendklassifikation am tatsächlichen Work-WRITE, READ-/Managementneutralität, automatische Managed-Childadoption, credential-/writable-originfreie VM als primäre harte Grenze, OpenCode-Deny als Defense-in-Depth, terminaler fachlicher Handback/Same-Session-Follow-up und lokale Commits ohne Bestätigung im Scope (§17).
- **Keine blockierende fachliche Entscheidung verbleibt.** Ein zweiter externer Broker/Perimeter oder allgemeine Arbitrary-Writevermittlung ist keine noch zu wählende Produktvoraussetzung.
- **Implementierungsdetails:** vorhandenen minimalen Backend-State-/Hookvertrag wählen, native PATCH-/tools-Semantik korrekt behandeln, effektiven Scope bewahren, neue/reused Children synchron adoptieren, verlässlich terminalen Outcome herstellen. V1-Kompatibilität/Pluginreadiness umsetzen, keine automatische V2-Migration.
- **Verifikation:** tatsächliches Operationsinventar, READ-/Managementnegativen, VM-/Hostcredential-/Originvertrag, Fresh/Attach/Reuse/Co-Pluginparität und echte MCP/A2A/OpenLive-/Hosted-/Voiceabnahme. Drift gegen den entschiedenen Vertrag ist zu beheben, keine neue Sicherheitsmodellwahl.
- **Optionale spätere Scopeentscheidungen:** neues Userorigin-Fetchrecht oder ausdrücklicher managed → manual Operatorworkflow. Beides ist für diesen Task nicht erforderlich; vorhandene Originregel/sticky Default gelten.
- **Koordination:** aktuellen Nachbartask-/Hunk-/Versionsstand vor Shared-Edits reconciliieren; keine Dateireservierung und keine Boardmutation in diesem Auftrag.

**Nächster Schritt nach gesonderter Implementierungsfreigabe:** Phase 2 starten: Operationsinventar/current Hunkbaseline, gemeinsame serverseitige Adoption und MCP-Workadmission, Non-interactive-Terminalität/lokale Gitpolicy; danach Child-/A2A-/OpenLiveintegration und Abnahme des bereits festgelegten VMvertrags. Der V1-Spike ist abgeschlossen; keine erneute Sicherheitsmodellwahl oder zusätzliche r20-Hosted-Smoke-Wartepflicht vor Integrationsplanung.

## 15. Evidence und Dokumentpflege

### Repositoryquellen

- `opencode-vm.sh`: Versionblock; `mcp_session_mode()` ab 5988; AppArmor-/nftables-/VM-AGENTS-Provisioning ab 10095/10152/10233; A2A-Setup ab 13620; Reattach ab 14200; Fresh-Start-MCPeligibility ab 15674; Configinjection ab 15782; AGENTS-Komposition ab 16533. Zeilen sind Snapshotanker, keine dauerhaften IDs.
- `adapters/mcp/src/opencode.ts`: `createSession`, `sendMessage`, `pending`, `requireIdle`/`assertIdle`; Legacy-Prompt und native v2 Reads getrennt.
- `adapters/mcp/src/agent-control.ts`, `.opencode-vm/agent-control.json`: Modellprofilvertrag, keine Permissionpolicy.
- `adapters/mcp/src/taskboard.ts:876–886`: deterministische Public-ID-Abbildung ohne Read-side-Write.
- `adapters/openlive-acp/src/core/call-controller.ts`: Workvoiceprimer; `src/opencode/gateway.ts`: Prompt-Systemtext und native Interactionhandoffs.
- `AGENTS.md`, `README.md`: bestehende Sicherheits-/Origin-/Scopebehauptungen.
- Kanonische Nachbartaskpläne: `planning/task-concepts/task_cce3a196-9611-5cf6-9f74-c98720211548-concept-plan.md`, `planning/task-concepts/task_d9944c0e-5acb-5d73-8030-4fbc0c025be0-concept-plan.md`; zugehörige Compact Contexts.
- `integrations/chatgpt/bundle.json` und `integrations/chatgpt/opencode-session-orchestrator/references/initialization-follow-through.md`: r20-Marker/Checkpointvertrag; Arbeitsbaumdirty-Status beachten.

### Installierter Stand / read-only Evidence

- Binary-/Serverversion, gefilterte GETs `/config`, `/agent`, `/doc`, `/api/permission/saved`.
- Lokale GETs der drei Boardtickets und ausschließlich des verlinkten r20-Verifikationsstands; keine Mutation.
- Aktuelles Sessionglobal-`AGENTS.md` und ECC-Pluginquellen. Der gelesene ECC-`permission.ask`-Hook verspricht Safe-Autoapprove in seinem Text, aber sein Rückgabeformat allein belegt keine tatsächlich wirksame native Freigabe. Nicht als Securitybasis verwenden.
- Installiertes A2A `execution/session_manager.py`, `opencode_upstream_client.py`: Create/Context-/Preferred-Reuse, optionaler statischer Primer und Question-/Permissionantwortmethoden; letztere in diesem Auftrag nicht aufgerufen.
- `/etc/apparmor.d/opencode-sandbox`, `/usr/lib/git-core`; fehlgeschlagene ausschließlich lesende nftables-Inspektion.

### Versionierte OpenCode-Quellen

Basis: `https://raw.githubusercontent.com/anomalyco/opencode/v1.18.33/` (öffentliche Upstreamquelle; keine Operation am Benutzer-Git-Origin).

- `packages/opencode/src/permission/index.ts`: V1 Evaluate/Approvedcache/Toolfilter.
- `packages/opencode/src/agent/agent.ts`, `agent/subagent-permissions.ts`, `tool/task.ts`: Agentmerge und Child-/Reuseverhalten.
- `packages/opencode/src/tool/shell.ts`, `tool/shell/shell.txt`, `tool/question.ts`: V1-Shell-/Questionexecutor und tatsächliche Commitinstruktion.
- `packages/opencode/src/config/config.ts`, `config/v2-compat.ts`: Configmerge-/Loadreihenfolge, V2-Permissionablehnung.
- `packages/opencode/src/session/instruction.ts`, `session/tools.ts`, `session/prompt.ts`, `session/llm/request.ts`, `session/system.ts`: Instruction-/Tool-/Permission-/Primingkomposition.
- `packages/core/src/permission.ts`, `tool/bash.ts`, `tool/question.ts`, `policy.ts`: separate V2-Semantik.
- `https://opencode.ai/config.json`: öffentliches aktuelles V1-Konfigurationsschema, einschließlich begrenzter `provider.use`-Policyaction.

Dokumentrollen bleiben getrennt: Board = Outcome/Scope, dieser Plan = kanonische Anforderungen/Architektur/Entscheidungen/Testkonzeption, Compact Context = aktuelle Fortsetzung, Session-/Ergebnishistorie = ausführliche Evidence. Keine vollständigen Boardbeschreibungen, Secrets oder fremden Promptverläufe duplizieren.

Größenpflege: Concept-Plan-Ziel ca. 20k Tokens, Warnung ab ca. 30k, ab ca. 40k bei Bedarf Task-ID-benannte Details und kanonischer Index hier. Nicht auf Zielgröße auffüllen. Compact Context ca. 5k, Warnung ab ca. 7.5k, vor ca. 10k verdichten, niemals splitten.

Initialisierungsvalidation: Beide Dateien wurden nach Erstellung vollständig zurückgelesen. Automatische Dokumentprüfung bestand für reguläre, nicht symlinkte UTF-8-Dateien, exakte einzelne erste Task-ID-Zeile, gegenseitige Pfadverweise, LF/Endnewline und fehlende Trailing Spaces. Grobe Zeichenschätzung: Compact Context ca. 3.2k, Concept Plan ca. 21.8k Tokens; kein Tokenizerzählwert und beide unter ihrer Warnschwelle. Git-Statusvergleich zeigt ausschließlich die zwei neuen Taskdateien zusätzlich zum bereits vorhandenen fremden Dirty-Stand; Produktimplementation weiterhin nicht begonnen.

## 16. Autorisierter isolierter V1-Spike – Abschluss und Konzeptkorrekturen

Historischer Spikeauftrag, Stand 2026-09-30T00:39:59Z. Dieser damalige Auftrag erlaubt ausschließlich den empfohlenen
isolierten V1-Kompatibilitäts-/Enforcement-Spike, reproduzierbare lokale/synthetische
Probes und Pflege dieser beiden Taskdokumente. Gemeinsame Adapter-/Wire-/Skill-/
Bundle-/Release-/Versionsdateien wurden nicht verändert. Keine Remote-Pushes,
Credentials, Releases, Tags oder Board-/fremden Sessionmutationen.

### 16.1 Isolierte Änderungen und Nachweisform

Neue Dateien unter `tests/agent-managed-v1-spike/`:

- `policy.mjs`: native Sessionrulekomposition, kurzer Primer, konditionale
  Commitinstruktion und ausdrücklich begrenzter direkter Git-Write-Recognizer.
- `plugin.mjs`: Parentline-Readback, sessionaware Systemprimer, tatsächliche
  Shelltooldefinition und früher Question-/Directwrite-Executionguard.
- `probe.py`: deterministischer Loopback-Modellserver, separate native OpenCode-
  Runtime/API-Probes mit neuem HOME/XDG/env-Whitelist, Disposable-Repositories,
  Native-Tasktool-/Childreuse-Fixtures und Event-/Pending-/Git-/Requestchecks.
- `README.md`: Ausführung/Scope/Limits; `EVIDENCE.md`: dauerhafter Befund,
  T01–T25-Nachweiszuordnung und konkret vorgeschlagene Integrationsschnittstellen.

Erfolgreicher Volllauf: `python3 -B tests/agent-managed-v1-spike/probe.py`,
**25 Fälle bestanden** gegen Binary/Health **1.18.33 V1**, Git **2.43.0**.
Raw-Evidence: `/tmp/opencode/managed-v1-xald85fe/{report.json,audit.jsonl,
model-requests.json,runtime-schema.json,git-canary.jsonl}` und Runtime-Logs.
`report.json`: `completed:true`, `actual_remote_writes:0`, Bare-Fixture-Refs
unverändert. Raw-Evidence ist VM-ephemer; dauerhafte Zusammenfassung liegt im
neuen Evidence-Dokument, nicht in gemeinsamen Vertragsdateien.

Publizierende Gitbefehle gehen ausschließlich an instrumentierte Stubs, die vor
echtem Git abbrechen. Auch Always-Allow-Seeding erzeugt keinen tatsächlichen Push.
Echte Commits nur im Disposable-Repo: Primarycommit verändert exakt `local.txt`,
leere Child-/Agentprecedence-Fixturecommits prüfen Native-Ausführung. Tatsächliches
Fetch/ls-remote nutzt nur eine lokale Bare-Fixture. Ein generischer HTTP-POST geht
an einen lokalen synthetischen Sink. Keine Benutzerorigin-/Netzwerktransportprobe.

Node-Syntaxchecks beider Module, ShellCheck erzeugter Helper-Shellstubs und
`git diff --check` bestanden. Fremde r20-Tests wurden nicht wiederholt. Source-/
Hookabgleich nutzt den passenden öffentlichen OpenCode-Tag; effektiver geschützter
Firewallstand ist aus der Sandbox weiter nicht operatorseitig verifiziert.

### 16.2 Neue belastbare Findings

1. **V1 native Deny verliert gegen remembered Allow – dynamisch bestätigt.**
   Echter V1-`always`-Reply in manueller Fixture; spätere andere Session mit
   Managed-Deny erreicht Gitcanary ohne Ask. Instanceweiter Cache, kein V2-Saved-
   Beweis. `tool.execute.before` verweigert denselben erkannten direkten Aufruf
   vor Executor/Ask/Grant und verhindert Canaryausführung. Die ursprüngliche G1-
   Annahme einer harten nativen OpenCode-Denygrenze ist widerlegt; frühe unabhängige
   Defense-in-Depth ist konkret möglich. Der primäre VM-Vertrag bleibt davon unberührt.
2. **Questionfilter vs Executor präzisiert.** Versteckter erzwungener Modellcall
   wird tatsächlich zu `invalid` repariert; kein Questionexecutor in diesem Pfad.
   Nach `tools:{question:true}` ersetzt der Prompt native Regeln und Question
   erreicht ohne Guard direkt native Pending ohne Permission-Ask. Mit Guard null
   Question-/Permission-Asked/Pending und regulärer terminaler Bericht aus dem
   deterministischen Modell. Question selbst benutzt keinen remembered-Ask-Pfad;
   dynamisches V2-/Question-grant-Seeding wurde nicht behauptet.
3. **Toolfehler ist kein verpflichtender terminaler Handback.** Zwei absichtliche
   Questionversuche in einem Turn werden beide geblockt; Runtime ruft das Modell
   weiter auf. Synthetischer `finish:stop`/idle/Originaltext und normaler Same-
   Session-Follow-up funktionieren, beweisen aber keine garantierte Beendigung
   mit einem unkooperativen echten Modell. Terminaler Business-Outcome ist durch
   D3 fest gefordert; passende backendseitige Beendigung/Stopsemantik und deren
   Nachweis sind Implementierungsarbeit, keine offene Handback-Produktentscheidung.
4. **Native Stateupdate-Vertrag dynamisch:** Create speichert Metadata/Rules;
   Titelupdate und Runtime-Neustart bewahren sie. PATCH **metadata ersetzt die
   gesamte Map**, PATCH **permission hängt an**; Prompt `tools` **ersetzt das
   Ruleset**. Adoption muss vollständige Metadata mergen/readbacken, Regeln als
   verifizierte/idempotente Deltas handhaben und Toolsdrift kontrollieren.
5. **Metadata allein bewahrt Managed-Betriebsstate nicht zuverlässig.** PATCH kann Marker ändern und
   unrelated Felder verlieren. Mit zuvor broad tools-replaced Rules wird Guard
   abgeschaltet und Gitcanary erreicht. Integration muss sticky Backendklassifikation
   bei Workadmission/Reuse/Stateänderung bewahren; konkrete Persistenz ist ein
   Implementierungsdetail, keine neue externe Securityregistry als Produktvorgabe.
   Metadata-/Pluginstate ist nicht die primäre harte Remote-Write-Grenze.
6. **Native Childinheritance und Reuse dynamisch:** Neues echtes Tasktool-Child
   erbt Session-Denies, keinen Marker/Commit-Allow; Commit fragt. Parentlinie
   erlaubt Systemprimer/Guard. Explizit vorbereitetes reused Child committet ohne
   Input; Reuse mit neuer Question-Allow-Regel aktualisiert Native-Policy nicht,
   Parentlineguard wirkt aber. Zusätzlich akzeptiert Native Tasktool ein
   vorhandenes `task_id` mit manueller Parentlinie: keine Reparenting-/Managed-
   Adoption, native Question erreicht Pending. Parentline allein reicht nicht.
7. **Lokaler Scope nicht automatisch gewahrt:** Prototyp bewahrt vorhandene
   Session-Denies und unabhängige managed Read-Ask bleibt erhalten. Session-
   Commit-Allow überstimmt jedoch expliziten Agent-Commit-Deny, realer Fixture-
   Commit ausgeführt. Adoption muss effektive Agent-/Session-/Taskrestriktionen
   reconciliieren. Gescriptete Modelle beweisen keine semantische Read-only-
   Instruktionsbefolgung oder autonome Scopeentscheidung.
8. **Tatsächlich gesendete Instructions:** outbound Fixture-Requests enthalten
   global → Root → explicit Instructions; Subdir-AGENTS erscheint nach Read.
   Baseline-Shellsatz wurde direkt erfasst; `tool.definition` ersetzt ihn
   konditional für manual/managed. Hook hat **keine sessionID**; kein globales
   current-session Workaround. Systemtransform ist sessionaware; manual ohne
   Primer, Child über Parentlinie mit Primer. Produkt-VM-AGENTS/ECC/andere Plugins/
   Providerkomposition ist damit noch nicht akzeptiert.
9. **OpenCode-Guard allein ist keine harte Remotegrenze.** 13 direkte Varianten
   einschließlich Optionen/Stub-Absolutpfaden/Chain/Whitespace/Plumbing/LFSstring
   durch Guard no-Ask vor Executor denied. REST `/session/{id}/shell` führt
   dagegen ohne Tool-before/native Toolpermissions aus; indirektes Python-Skript
   erreicht Gitcanary; curl POST erreicht lokalen Sink. Andere transports,
   helpers/hooks/aliases/Docker/MCP/customtools/foreign-repo-Writes wurden nicht
   vollständig vermittelt. Diese Canaries sind Gegenbeispiele zur OpenCode-Schicht
   allein, **keine Widerlegung des credential-/writable-originfreien VM-Modells**.
   Vollständige neue Capabilityvermittlung ist nach §17 keine Produktvoraussetzung.
   Kein VM-Vertragserfolg aus unveränderten Bare-Refs ableiten: Canarydesign
   verbietet reale Publikation unabhängig vom getesteten Guard; VMabnahme separat.

### 16.3 Aktualisierter minimaler Integrationsentwurf

Diese Punkte benennen gemeinsame Hooks/Interfaces, die **nicht parallel editiert**
wurden. Die Produktintegration benötigt einen eigenen koordinierten Auftrag:

- **`ensureManagedWorkSession(sessionID, ingress, parentInvocation?)`**, vertrauens-
  würdiger backendseitiger Work-WRITE-Admissionpunkt: Project-/Idle-/Pending-/
  Scopevalidierung, automatische sticky Klassifikation ohne Client-/Skillflag,
  effektive Agent-/Sessionpolicy und Preservation/Readback vor Workadmission.
  READ und reine Managementcalls rufen keinen klassifizierenden Adoptpfad auf.
- **Synchroner Childadmissionhook** nach `TaskTool.nextSession`-Auswahl/Creation,
  vor `TaskPromptOps.prompt`: neue/reused/unrelated-lineage Children adoptieren
  oder ablehnen, lokale Policy ohne Scopeüberschreibung installieren/readbacken.
  Async session.created ist keine rennfreie Vor-Erstausführung-Garantie.
- **Approval-unabhängige Executiongrenze** an `SessionTools.resolve` plus vor
  `SessionPrompt.shellImpl`-Spawn. Bestehender `shell.env`-Hook kennt den Command
  nicht. Dies ist Defense-in-Depth-/Verhaltenspolicyintegration; die primäre harte
  Grenze bleibt der gewählte VM-/Hostcredential-/Originvertrag. Zusätzliche
  vollständige Process-/Transport-/outside-guest-Writevermittlung ist nicht als
  separate Architekturentscheidung oder zwingender neuer Mechanismus vorgesehen.
- **Terminaler fachlicher Outcome/Stopcontract**: kein nativer Questionzustand,
  kein Autoanswer/Autoapprove; sichtbares vollständiges INPUT_REQUIRED wird
  kontrolliert gespeichert, nächster autorisierter normaler Turn bleibt möglich.
  Unabhängige echte Securitypermissions bleiben eigener Operatorinputpfad.
- **Instructionkomposition**: konditional gültige Shelldefinition oder echter
  sessionaware Definitionshook, additive kurze Systemkomposition, tatsächliche
  VM-globalen Widersprüche/Co-Plugins nachweisen. V1-Pluginloader kann Fehler
  reporten/ignorieren; konfigurierte Pluginzeile allein ist kein Readinessbeweis.
- **VM-Vertrag/Readvertrag**: credential-/writable-originfreien Guest und Host-
  Operatorsteuerung abnehmen; kein zweites externes Enforcementmodell wählen.
  Erlaubte Reads bewahren, Benutzeroriginrecht nicht nebenbei erweitern.

### 16.4 Acceptance, Gates und Readiness

Historische Einzelfälle/T01–T25-Zuordnung: `tests/agent-managed-v1-spike/EVIDENCE.md`.
Die dortige frühere G3-/Readinessinterpretation wird durch §17 und diese
reconciliierte Bewertung ersetzt; das Evidence-Artefakt bleibt in diesem
Dokumentationsauftrag unverändert. Aktuelle Acceptance inklusive T26–T30 in §13.
Belegt sind isolierte native/manual/tool/commit/grant/Question-/instruction-/
child-/drift-/restart-Mechanik und synthetischer fachlicher Follow-up. Nicht
belegt sind MCP-/A2A-/OpenLive-Ingressintegration, tatsächliche macOS/Lima-Fresh/
Attach/--no-mcp, Hosted-/Voice-/realmodell-Handback und Abnahme der festgelegten
credential-/writable-originfreien VM-/Hosttrennung. Eine neue vollständige
Arbitrary-/Foreign-Repo-Writevermittlung ist keine Pflichtabnahme dieses Tasks.
Im damaligen Spike waren T09-Tags nicht autorisiert.

- **G1: Defense-in-Depth-Implementierung/Verifikation.** Native Deny/Always-Allow-
  Priorität ist belegt, frühe no-Ask-Policywirkung auf geprüftem Pfad bestanden;
  Integration/Scope/Kompatibilität nachweisen. Kein primärer OpenCode-Securityanker.
- **G2: Non-interactive-Implementierung/Verifikation.** Questionguard/synthetischer
  Handback belegt; fest geforderter terminaler Outcome und automatische Adoption
  aller Managed-Children vor Workprompt noch umzusetzen/abzunehmen.
- **G3: VM-Vertragsabnahme.** Primäre credential-/writable-originfreie VM-/Host-
  Grenze ist entschieden. Effektive Bereitstellung/Origin-/Credentialtrennung
  prüfen; kein zusätzliches externes Sicherheitsmodell als offener Entscheid.

**Phase 1 abgeschlossen; Produktentscheidungen geschlossen; koordinierte
Produktintegrationsplanung ready.** Der Spike ist ein isolierter Prototyp, keine
neue Produktabnahme. Verbleibend sind Umsetzung/Verifikation von Backendadoption,
effektivem Scope, Childadmission, terminalem Handback, Defense-in-Depth und
festgelegtem VMvertrag. Keine Version reserviert; Shared-Hunks/Artefakte vor
späterem Integrationsslot neu reconciliieren. Keine Produktaktivierung hier.

Abschließender Statusvergleich zeigt inzwischen zusätzliche parallele Änderungen
unter `adapters/mcp/src/` (Diagnostics/HTTP/Taskboard/Tools/Types) und neue fremde
Taskdokumente. Dieser Spike hat diese Dateien nicht editiert; die ursprüngliche
Nachbartask-/Hunkbaseline ist vor Integration erneut zu prüfen. Whitespacechecks
für alle sieben eigenen Dateien (einschließlich untracked Dokumente/Prototyp) und
den aktuellen tracked Diff bestanden; Task-ID/kanonische Verweise zurückgelesen.

## 17. Operatorentscheidungen – kanonisch, 2026-09-30

Diese Reconciliation ist **PLANNING/DOCUMENTATION ONLY** und schreibt nur die
zwei etablierten Taskdokumente. Sie führt keine neue Probe, Runtime-/Hostabnahme,
Infrastruktur-/Deploymentänderung, Produkt-/Adapter-/Skill-/Bundle-/Releaseänderung
oder Boardmutation aus. Historische Tatsachen aus §16 bleiben erhalten; ihre
Bewertung als offene externe Sicherheitsmodellwahl ist hier ausdrücklich abgelöst.

### 17.1 Geschlossene Entscheidungen

**D1 — Ingressklassifikation, nicht Client-/Skillflag.** Jeder tatsächliche
agentische Work-WRITE-Ingress erzeugt/adoptiert die Arbeits-Session automatisch
serverseitig: Worksession-Creation und Fortsetzung bestehender Sessions. Reine
READ-/Managementoperationen klassifizieren niemals um, auch wenn ihr Client
andere WRITE-Fähigkeiten besitzt. Eine manuelle Session bleibt bis zum tatsächlichen
agentischen Work-WRITE manual; danach ist der Managedzustand sticky. Der
Orchestrator sendet normale Workcalls, keinen speziellen oder wiederholten Flag.
Neue/reused Children aus Managed-Workstream müssen automatisch vor erstem
Workprompt adoptiert und mit demselben Verhaltensvertrag vorbereitet sein.

**D2 — VM als primäre harte Remote-Write-Grenze.** Im Guest gibt es keine
GitHub-/Origincredentials und keinen konfigurierten schreibfähigen Operatororigin;
Credentials und Operatorprojekt-/Originsteuerung liegen auf Host/Operatorseite.
OpenCode-Push-/Equivalentwrite-Deny ist explizite Verhaltenspolicy und
Defense-in-Depth. Always-Allow-/Plugin-/Metadata-/Skript-/REST-Canaries widerlegen
nur eine harte **OpenCode-layer-only** Grenze, nicht das VM-Sicherheitsmodell.
Keine zusätzliche externe Broker-/Firewall-/allgemeine Arbitrary-Capabilitygrenze
ist noch als Produktmodell zu entscheiden. Invariante bleibt:
**local repo autonomy; remote write operator-only**.

**D3 — Non-interactive, Handback, lokale Gitautonomie.** Keine direkten fachlichen
Question-/UI-Prompts an Endnutzer. Fehlende Business-/Produktentscheidung als
normaler terminaler INPUT_REQUIRED-Bericht mit konkreter Frage/Kontext/Optionen;
Orchestrator klärt in Voice/Chat und sendet normalen Follow-up derselben Session.
Lokale Git-Arbeit einschließlich Commits ohne Bestätigung im Taskscope. Engere
Read-only-/Task-/Agentrestriktionen und unabhängige echte Securitypermissions
werden nicht pauschal überschrieben/autoapproved. Terminalität ist eine feste
Anforderung, keine noch offene fachliche Entscheidung.

### 17.2 Konkretes Ingress-/Operationsinventar für Integration

Die bekannte Ausgangsarchitektur aus §4 dient als Planungssnapshot. Bei der
autorisierten Integration tatsächliche Methoden/Admissionstellen neu lesen und
die Matrix vervollständigen; das ist Implementierungsinventar, kein optionales
Auswahlrecht, angebotene agentische Work-Writes manual zu lassen.

| Backendpfad | Automatischer Managedtrigger | READ/Management ohne Umklassifikation |
|---|---|---|
| Incoming MCP | create_session für neue Worksession; send_message in neuer/bestehender Session; supersede_unresolved_submission beim zugelassenen neuen Workprompt | list/get/history/message/result/progress/activity/runtime-options; Rename/Archive/Runtimeverwaltung, Attachment-Staging und Boardpflege allein |
| A2A | Neue Worksession/Workturn; Context-Reuse und preferred-session-Workfortsetzung | Discovery/Card/Status/Task-/Historyreads oder reine Bindungsverwaltung ohne Workturn |
| OpenLive lokal/remote | Explizite Worksession-Creation über agentischen Pfad; erster/weiterer Workturn auf vorhandener Session | Manager list/read; reines attach/Call-Binding ohne Workprompt; Manager bleibt read-only Scope |
| Native Child-/Subagentpfade | Auswahl/Creation/Reuse aus Managed-Workstream vor TaskPromptOps.prompt; auch zuvor manuelle Childlinie im autorisierten Scope | Bloßer Read/Inspection vorhandener Childhistory |
| Weitere tatsächlich angebotene ACP-/REST-/Shell-Automation | Agentischer Work-WRITE anhand vertrauenswürdigem Backendpfad vor Workadmission | Manuelle Web/TUI-Nutzung und reine Reads/Management nicht aus API-/Clientnamen allein umklassifizieren |

Backendkontext/Admissionpfad ist die Klassifikationsquelle. Ein frei setzbarer
Model-/Clientparameter, Toolannotation oder Titel ist keine Autorität. Abgelehnte
Busy-/Pending-/Scopeoperationen verursachen keine heimliche Mutation, Antwort oder
Abort. Workcreation ist ein Trigger; reine Management-Writes sind keiner.

### 17.3 Umsetzungspaket und Nachweise

Der konkrete Ablauf ist in §12 reconciliert: (1) Hunk-/Operationsinventar,
(2) gemeinsamer ensure/adopt und MCP Workadmission, (3) terminaler Non-interactive-
Outcome/lokale Gitpolicy/Instructions, (4) synchrone Childadoption und alle weiteren
Work-Ingresspfade, (5) Lifecycle/VM-Vertragsabnahme, (6) normale Orchestrator-
Same-Session-Follow-up-/Hosted-/Voiceabnahme. §13 ergänzt T26–T30 für READ-/
Managementneutralität, flaglose Transition und Guest-/Host-Origintrennung.

Native Statekomposition, Hookauswahl/Kompatibilität, Idempotenz, Cross-client-
Adoption/Drift und garantierter terminaler Turn sind technische Implementierungs-
und Verifikationsaufgaben. Der VMnachweis umfasst effektive Guestconfig/Env,
Githelper/Credentialweiterleitung, Mounts und tatsächliche Agentzugänge: kein
Operatororigin-Pushzugang im Guest; Host hält Credentials/Originsteuerung. Eine
entdeckte Abweichung ist Drift gegen das gewählte Modell und gezielt zu beheben,
keine neue Entscheidung für ein zweites Sicherheitsmodell. Bestehende zulässige
Remote-Reads bewahren; keine Userorigin-Fetchausweitung als Nebenwirkung.

### 17.4 Entscheidungslage / Ready

- **Geschlossen:** D1–D3 einschließlich Childadoption und primärem VMmodell; G1–G3
  sind jetzt Policy-/Verhaltens-/VM-Abnahmearbeit, keine offenen Produktentscheidungen.
- **Keine blockierende fachliche Entscheidung übrig.** Optional neu gewünschtes
  Userorigin-Fetchrecht oder expliziter managed → manual Operatorworkflow wäre
  separater Scope, nicht Voraussetzung dieses Outcomes.
- **Noch nicht erledigt:** technische Produktintegration und Live-/Lifecycle-/
  Hosted-/Voiceverifikation. Dokumentreconciliation ist keine produktive Abnahme.
- **Ready für koordinierte Produktintegrationsplanung: ja.** Implementierung erst
  nach eigenem Auftrag, mit neu abgeglichener Shared-Hunk-/Versionslage; keine
  Releaseversion reserviert und kein Board-Move durch diesen Checkpoint.

## 18. Vollimplementierung – aktueller technischer Stand

Autorisierter Scope: vollständig gemäß neuem Auftrag, kein MCP-only-Abschluss.
Baseline 7406030 enthält r21/Header/ACH-1; deren Produktcode tracked-clean,
fremde Task-/dist-Leftovers werden ausgeschlossen. Tatsächliche lokale Versionen
nach neuen Codeänderungen: Script 0.6.7 / MCP 0.1.21 / OpenLive 0.1.7; lokale
Build-/Pin-/Regressionsabschlussarbeit noch pending, nichts veröffentlicht.

### 18.1 Gemeinsamer Backend-/Runnervertrag

runtime/managed-policy.mjs ist ein repository-owned OpenCode-Plugin. Ein eigener
plugin-owned privater Unixsocket nimmt ausschließlich interne Workadoption von
MCP/OpenLive/A2A entgegen. Vorher Project/Session/Idle/Pending/Manager prüfen;
persistenter atomar geschriebener Backendstate im OpenCode-XDG-Datastore, nicht
native Metadata als alleinige Autorität. Repeated Adoption macht keine neuen
Regelwrites; Metadata-/tools-Drift wird bei Work/Childprompt reconciliert.
Synchronous chat.message vorbereitet neue Managed-lineage Children;
tool.execute.before(task) adoptiert existierende reused Targets vor Childwork.

**Terminalität über tatsächliche Completion statt Exceptionloop:** Der Plugin-
Completiongate korreliert interne Providerrequests mit Session/Userturn, entfernt
lokale Korrelationsheader vor Upstream und prüft einen bounded Modellstep vor
SDK-Tooldispatch. Native question/business-input Toolantworten werden in einen
regulären terminalen Textstream mit Frage/Kontext/Optionen umgewandelt. Der echte
OpenCode-Runner persistiert/completiert den Assistant normal. Keine direkte DB-
Manipulation, Abort, Questionreply, Modellretry oder zusätzliche Usernachricht.
Ein Step ist auf 8 MiB begrenzt; Transport-/Auth-/Co-Plugin-Kompatibilität und
Streaminglatenz werden als explizite Implementierungs-/Abnahmeeigenschaften geprüft.
Unabhängige echte Permissionasks werden nicht beantwortet oder umetikettiert.

Chat-Completions und OpenAI Responses mit realem OpenCode 1.18.33 bestanden im
neuen dauerhaften Integrationharness: unkooperatives Questionmodell endet nach
einer Providerantwort mit normalem finish:stop/idle/INPUT_REQUIRED, null nativen
Questions; normaler Folgeturn derselben Session funktioniert. Ebenfalls bestanden:
lokaler Commit, erlaubte lokale Bare-Fixture-Reads, no-Ask-Pushcanarydeny,
Metadata/tools-Drift, Runtime-Neustart, neue und manual-lineage reused Children.
Das ist lokale technische Evidence, keine produktive/Hosted-/Hostabnahme.

### 18.2 Vollständige lokale Integration

MCP work creation/send/supersede ruft interne Adoption vor Workprompt/Sideeffects
auf; OpenLive Workcreation/Workprompt ebenfalls, Manager/Attach neutral. A2A läuft
über runtime/a2a-managed.py mit process-local Admissionhooks für creation/send/
prompt_async/command; keine dauerhafte Änderung an installierten site-packages.
Fresh/Attach materialisieren den gemeinsamen Payload; Standalone bekommt ihn
als deterministisch eingebettete gzip/Base64-Payloadbytes direkt aus dem Script.
Kein neuer Manual-/Offlinedownload und kein externer Policydaemon. Das zusätzliche
MCP-Artefakt enthält dieselben Sources; scripts/build-managed-runtime.py --check
und Source-/Standalone-Installerfixtures prüfen exakte Byteparität.

Task-/Agentrestriktionen einschließlich erlaubter Permissionausnahmen werden
geordnet erhalten. Basisscope/owned native Writes sind getrennt; Agentwechsel
übernehmen alte eigene Regeln nicht als neue unabhängige Restriktionen. Native
tools-Replacement wird im echten chat.message-Input verhindert; sichtbare Controls
bleiben auf dem Userturn und explizite Disables persistieren im Backendstate.
Native REST-Shell nutzt den korrelierten gespeicherten running Call vor Spawn,
weil sie tool.execute.before nicht aufruft. Kein globales current-command Race.

Remote Defense-in-Depth umfasst bekannte Gitoptionen/Absolutpfade/Chains/escaped
Newlines/Shellwrapper, gelesene Git-Aliases, send-pack/http-push/receive-pack,
LFSpublishing und erkanntes Forgepublishing/Origincredentialprovisioning. Lokale
Gitops und sonst erlaubte Read-only-Calls werden nicht blanketgesperrt. Primärer
VM-/Hostcredential-/Originvertrag bleibt unverändert, keine credential forwarding-
oder Loginprovisionierung hinzugefügt. Keine allgemeine Arbitrary-Processgrenze
aus diesem Guard behauptet; D2 unverändert.

### 18.3 Lokale Matrix / dauerhafte Evidence

- Policyunits **4**, A2A process-local hooks **2**, Fresh/Attach/source/embedded-
  Standalone-/Symlink-Installerfixtures **3** bestanden.
- Reale **OpenCode 1.18.33** Chat Completions/Responses/Anthropic-Gates: Modell
  versucht ausschließlich Questions, echter Runner endet nach einer Providerantwort
  normal mit finish:stop/idle, gespeicherter vollständiger Report/Folgeturn,
  null nativen Questions. Lokaler Parent-/Childcommit, Branch/Tag/Restore,
  no-Ask-Write-Deny einschließlich nativer REST-Shell, erlaubte Fetch/ls-remote,
  expliziter Agent-/Sessionscope trotz tools, native Independent-Securityasks,
  manual Question, remembered Always-Allow, Metadata/tools-Drift und Restart,
  neue/manual-lineage reused/aktivierte Backgroundchildren sowie echte global/
  project/nested Instructions bestanden. Google-Terminalprotokoll unitgeprüft.
- Wirkliche kompilierten **MCP-/OpenLive-Gateway-Adoption/Workfortsetzung** gegen
  1.18.33 bestanden, Managercreation neutral. Echter gepinnter **A2A 1.2.0**
  Service via repository-owned Launcher: Creation, Context-Reuse, Preferredsession,
  prompt_async und command mit normalem Handback/null Questions bestanden.
- MCP Typecheck/Build und gesamte Suite **104 PASS / 0 FAIL / 0 SKIP** mit
  Taskboard 0.6.0: replay/uncertainty/management neutrality/r21/Header/ACH-1
  erhalten. Bestehende reale MCP-Integration **OpenCode 1.18.21** bestanden.
  Zusätzlicher disposable Board/MCP-Smoke 0.1.21 / 1.18.33 bestanden.
- OpenLive Typecheck/Build **47 PASS**, Managertool-Integration 1.18.21 und
  packaged TLS/Remote-roundtrip bestanden. OpenLive-/MCP-Adapter-/Lock-/Tunnel-/
  Install-/Besprechung-Lifecycle bestanden.
- AgentControl **39**, Hub **9**, Launcher **4** und DOM **8**, Skill **17**,
  Release-Metadata/-State **5 + 5** bestanden. Launcherproxy **1 PASS / 1
  bestehender Opt-in SKIP**, Editor **18 PASS / 1 bestehender Live-SKIP** und
  Extension **1 PASS**. Kein neues Featuregate stillschweigend übersprungen.
- Bash syntax, ShellCheck error-level für geänderte Shelloberflächen, actionlint,
  vollständige Payload-/Skill-Inventar-/Byteparität und diff --check bestanden.
  Neue managed-sessions-CI prüft maintained Units und reale 1.18.33-Gates.

Ephemere Fixture-/Rawdaten `/tmp/opencode/ocvm-managed-*`, einschließlich aktueller
voller Chat-/Scope-/Backgroundevidence `ocvm-managed-ejxxlgm_`, Responses
`ocvm-managed-18oljp0p`, Anthropic `ocvm-managed-j6yhpn2v` und tatsächlicher
Ingresssuite `ocvm-managed-_3s2k_w7`. Dauerhafte Szenarien sind neue tests/managed_*
und helpers/managed_runtime.py; keine Raw-Promptexporte produktiv hinzugefügt.

Historischer tests/agent-managed-v1-spike ist explizit als Versioncharakterisierung
markiert und wird task-owned eingecheckt. Kein Produkt-/Maintainedtest importiert
seine Prototype-/Audit-/Marker-only-/Exception-only-Implementierung. Alte
G3-Auswahlinterpretation durch §17 ersetzt. Fremde C/P/d994-Notiz/alte dist-Dateien
bleiben untracked/unstaged; nicht löschen oder absorbieren.

### 18.4 Metadaten / Ready / externe Abnahme

Script **0.6.7**, MCP **0.1.21**, OpenLive **0.1.7**, Skill **2026-09-30-r24**.
Doppelbuilds byteidentisch; aktuelle Pins:

- MCP f6cba6609f895e75e9e1e8d022f7ca667012802b1332e1b78674ddb6bf816c70
- OpenLive 39a50c5127b0a577b54e4790b5c3c1f463b35a52b42c4343aa639dcea53bad47
- Skill 7903940429d0ae5dcf40aff3fe9530e1237711be96ae4e3003ae057a5ab73553
- Hubpayload unverändert 2ef956152cb1141239b58cd379726873824136dee25baff42d16bed4934b6034

**Vollständiger angebotener Produkt-Scope lokal implementiert und geprüft.** Keine
neue echte Produkt-/Architektur-/Securityentscheidung und keine geparkte Portion.
Noch ausstehend ist externe/manuelle Gesamtakzeptanz: reale macOS/Lima-/Host-
Credential-/Origintrennung, Operatorprovider-/OAuth-/Websocketvarianten,
Hosted ChatGPT/Voice und UXwirkung des 8-MiB/buffered-step Gates. Diese wird nicht
als lokaler Testerfolg behauptet. Native bare ACP ist kein neu exponierter
Produkt-ingress; die verwaltete lokale/remote ACP-Verbindung ist OpenLive.
Manuelle REST/Web/TUI-Nutzung wird nicht blanket als agentisch klassifiziert;
bereits Managed-Sessions behalten den Vertrag auch dort.

Aktive Produktivsession/Connector nicht restarted oder restaged. Neue Policy wird
erst bei normalem zukünftigem Start/Attach/Restart geladen. Keine Pushes,
Remote-Credentials, Releases, externen Deployments/Infrastrukturänderungen oder
Boardmutationen. Lokale Commits nach abschließender intended-file-/Diffprüfung;
exakte SHAs im terminalen Originalbericht, kein Remote-Publishing.

### 18.5 Lokaler Commitabschluss

Implementationcommit **4d3c37ae58511e84e801d78c289bfe2157859e7b**, Subject
`feat: enforce agent-managed work across MCP A2A and OpenLive`: 52 beabsichtigte
Source-/Test-/Doku-/Paketdateien einschließlich eindeutig historischer Spike-
Charakterisierung. Vor Commit status/diff/log geprüft; kein fremder d994-/Task-
Diff oder alter dist-Buildleftover gestaged. Diese zwei task-owned C/P werden
danach als eigener lokaler Dokumentabschluss committet; dessen tatsächliche SHA
steht im terminalen Ergebnis, nicht als vorweg erfundener Selfhash hier.

Keine lokale Scopeportion unimplementiert wegen neuer Produktentscheidung; kein
Push/Tag/Remote-Credential/Release/Deployment/Board-Move. Ausstehend bleibt die
klar benannte externe/manuelle Akzeptanz aus §18.4, keine erneute Sicherheits-
modellwahl. Lokale Build-/Test-/Instruction-/Standalone-Evidence oben ist geprüft;
aktiver alter Connector bleibt unangetastet, spätere Aktivierung ist Operatorworkflow.
