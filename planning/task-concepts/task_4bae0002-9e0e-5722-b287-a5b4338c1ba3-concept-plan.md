Task-ID: task_4bae0002-9e0e-5722-b287-a5b4338c1ba3
Title: Agent Control Hub – Informationsarchitektur vereinfachen und Design-/Review-Profile ergänzen
Status: implementation_candidate — consolidated integration locally validated; operator acceptance pending
Last-concept-update: 2026-09-30T04:16:03Z
# ACH-1 — Kanonischer Concept Plan

Stand: 2026-09-30 · ACH-1 vollständig auf konsolidierter main/r21+Header-Basis integriert und kombiniert lokal verifiziert. Reales Safari/VoiceOver/Mac-Operatorreview bleibt offen; kein Boardabschluss. Aktuelle Integrations-/Paket-/Testevidence in §17, Compact Context und Terminalresultat; ältere isolierte Angaben bleiben historische Evidence.

## 1. Auftrag, Scope und Dokumentrollen

**Aktuelle Integrationsfreigabe:** Quellcommit `a196a17251dac0d4122e6a9ec2cbe979b95c10a1` inhaltlich auf bestaetigtem `ce5c85c64fc35ba6693f007acc98e0d300de0741` (r21 + Header) konsolidieren, kombinierte Regression und genau einen lokalen Integrationscommit ausfuehren. Unveraenderte Quelldateien nach Basisvergleich uebernehmen; ueberlappende Versionen/Skill/MCP-Hunks semantisch reconciliieren. Keine fremden C/P/Spike/dist-Ausgaben oder r21-SHA-Nachtragsnotiz aufnehmen. Kein Remote-Write/Tag/Release/Deployment/Connectorrestart oder Board-done-Write. Konzepte/Fallback-/Wahrheits-/Migrationsentscheidungen bleiben unveraendert; `Last-concept-update` wird nicht fuer reine Integrationsevidence neu gesetzt. Die folgenden Nachtlaufgrenzen sind historische Isolation, nicht aktuelle main-Sperre.

Outcome: „Agent Control Hub – Informationsarchitektur vereinfachen und Design-/Review-Profile ergänzen“.
Dieses Dokument ist die kanonische Requirements-/Design-/Entscheidungs-/Implementierungs-/Testplanung. Aktueller Arbeitsstand: `.opencode/tasks/task-task_4bae0002-9e0e-5722-b287-a5b4338c1ba3.compact.md`. Board beschreibt Outcome/Scope; Sessionresultate sind Ausführungsevidenz.
Die beiden Zieldateien wurden im Konzeptpass nach Pfad-/Identitätsprüfung initialisiert. Der neue autorisierte Nachtlauf ersetzt dessen Nur-Konzept-Schreibgrenzen: ACH-1-Produktcode, passende Skills/Dokumentation/Paketmetadaten, lokale Tests und genau ein sauberer lokaler Implementierungscommit nach bestandener relevanter Suite sind freigegeben. Ausschließlich im detached Worktree auf `6d2efdeeed5fc4faf8b4b8b1df929a3d39a8acab`; keine Integration des fremden r21/Taskboard/MCP-0.1.18-WIP. Kein Remote-Write, Tag/Release, Deployment, Credentialsetup, Live-Connectorrestart/-restaging oder Board-Move. Nur C/P werden am Abschluss in den Hauptcheckout gespiegelt. Reales Safari/VoiceOver und separate Liveabnahmen bleiben ausdrücklich unbelegt, bis tatsächlich ausgeführt.
Hauptplan: etwa 20.000 Tokens Ziel, 30.000 Warnung, bei 40.000 in Task-ID-benannte Details aufteilen und diesen Plan als kanonischen Index erhalten. Keine Teilung derzeit erforderlich.

## 2. Bereits festgelegt

1. Hauptfluss Profiles → Connections → Logs.
2. Redundante Signals-/Statusflächen reduzieren; verbindungsspezifische Zustände und Hilfe bei der Verbindung.
3. Deep, Standard, Execution behalten; Design und Review optional ergänzen.
4. Design-Fallback → Standard; Review-Fallback → Deep → Standard.
5. Review ist unabhängige Bewertung und implementiert Findings nicht automatisch.
6. Reale LAN-/NetBird-/ChatGPT-v1-Abnahme ist eine separate Aufgabe.
7. Usage/Quota ist außerhalb des Scopes.

## 3. Technische Bestandsaufnahme und Wiederverwendung

| Bereich | Code / Vertrag | Befund |
| --- | --- | --- |
| UI | `hub/index.html:15–19`, `app.js`, `control.js` | Frameworkfreie Single-Page-Oberfläche: Verbindungen zuerst, danach Filter, Signals und Eventvorschau, danach Katalog/drei vollständig offene Profilformulare und globale Setup-/Skill-/Grenzen-Panels. |
| Diagnose | `hub/server.py:166–237` | Karten werden nur bei erkannten Konfigurationen erzeugt. Notices wiederholen Statusgründe. HTTP/TCP-/Runtime-Evidenz hat je Verbindung unterschiedliche Aussagekraft. |
| Katalog | `hub/catalog.py:28–69` | Authentifizierter MCP-Healthcheck prüft Projekt und Generation; danach bestehender Runtime-Options-Read; keine persistente Katalogkopie. |
| Policy | `hub/policy.py:13–149` | Schema 1 mit exakt Deep/Standard/Execution; virtuelle leere Revision 0; erwartete Revision, Host-Lock, atomarer profilweiser Write. |
| HTTP | `hub/server.py:240–246,312–344` | `/api/control` liest Policy/Katalog/Validierung; PUT verlangt exakte Profile und Payload. 409 Revision, 422 Auswahl, 503 Katalog; Löschen braucht keinen Katalog. |
| MCP | `adapters/mcp/src/agent-control.ts`, `tools.ts:1361–1388` | Strikter unabhängiger Schema-1-Reader; zwei read-only Policy-Tools; exakte Tuple-Auflösung ohne Fallback. |
| Clientworkflow | `integrations/chatgpt/opencode-session-orchestrator/SKILL.md:41–46` | Klassifikation Deep/Standard/Execution; Review bisher Standard; explizite Nutzerwahl geht vor; nur vor neu autorisierter Arbeit idle Runtime ändern und zurücklesen. |

`PLAN_AGENT_CONTROL_HUB.md` und `hub/README.md` definieren den v1-Bestand; konkrete ACH-1-Weiterentwicklung wird hier geführt. Kein `DESIGN.md` gefunden. Der Working Tree enthält viele bestehende Änderungen anderer Aufgaben; diese sind keine Leistung dieses Passes.

### 3.1 UI-Befunde

- `app.js:10–15`: Karten zeigen Health-Badge, Grund und vier Metadatenzeilen. Notices wiederholen dieselben Gründe. Der als Tabs gestaltete Bereich filtert Karten, scrollt aber bei jeder Auswahl zu globaler Hilfe; „Skill & Client Integration“ setzt den Filter auf alle zurück. Das ist keine echte Tabnavigation.
- `index.html:18`, `control.js:10–19`: großer Katalogblock vor Profilen; lange gemischtsprachige Statuszeile mit Revision und Transport-Capabilities. Das konkrete „Welche Runtime gilt?“ ist weniger prominent.
- `control.js:21–61`: drei gleichwertig offene Formulare mit Provider → Modell → Variante, verschachtelten Labels und gespeicherten, nicht mehr verfügbaren Optionen. Native Selects und DOM-Erzeugung sind wiederverwendbar.
- `control.js:64–77`: Erfolg lädt alles neu und ersetzt sämtliche Formulare. Dadurch gehen andere ungespeicherte Profileingaben und Fokus verloren. Refresh tut dasselbe; ein fehlgeschlagener GET leert die Formulare. Ein PUT-Fehler allein rerendert dagegen nicht und lässt die aktuelle Auswahl stehen.
- Noch keine profilbezogene Saving-/Saved-Rückmeldung, Dirty-Markierung, Doppelclick-Sperre oder Konfliktauflösung. Unvollständige Auswahl bekommt allgemeinen Text; Backendfehler erscheinen außerhalb der betroffenen Karte.
- `styles.css`: vorhandene dunkle Tokens, Systemfont-Fallback einschließlich `-apple-system`, Panels/Karten, responsive Grid-Basis und Select-Fokusstil wiederverwenden. Keine ungeprüfte WCAG-Konformitätsbehauptung; insbesondere kleine sekundäre Texte, lange IDs, Fokus aller Controls und schmale Formulare prüfen.

### 3.2 Verbindungs-Evidenz: konkrete Grenzen

| Verbindung | Konfigurationsnachweis im Istcode | Aktueller Laufzeitnachweis / Konsequenz |
| --- | --- | --- |
| Secure MCP Tunnel | Projektzuordnung in `mcp-tunnel/openai/registry.json` | `server.py:178–187` liest `mcp/runtime.json` und erwartet `connected`; Lima-Status separat. Producer `prepare_mcp_adapter`, `opencode-vm.sh:13335–13379`, schreibt Adapter-Metadaten, **kein** `connected`. Echter Tunnelzustand kommt aus `mcp_tunnel_guest_status:13254–13282` über Guest-Unix-Socket (`process/ready/controlPlane/connected/httpStatus`). Die heutige Hub-Datei beweist keine Tunnelverbindung. |
| Incoming MCP | Projekt-Session mit `SESS_MCP_ENABLED=1` | `server.py:191–196` prüft nur TCP-Port. Das beweist weder Dienstidentität noch Projekt/Backendbereitschaft. Stärkerer vorhandener authentifizierter `/healthz`-Read in `catalog.py:28–56` prüft `healthy`, Projekt-ID, Controller-Generation; wiederverwenden. |
| A2A | Projekt-Session im Webmodus | Agent Card + authentifizierter `/health`, `server.py:198–214`. Lokaler Auth-/Servicecheck, kein kompletter Send-/Client-/LAN-Test. Effektive URL aus Card statt nur gemerktem P+3-Port; Servicebody prüfen. Name allein ist keine Projektidentität (`docs/A2A-INTERFACE.md:68–121`). |
| OpenLive | Hostshim installiert | `server.py:216–220` erwartet `pid` in `openlive/runtime.json`. `prepare_openlive_adapter:14613–14649` und Reattach-Pendant schreiben Projekt, Backend-URL, Generation, Version, **keine PID**. Gateway-PID steht in separatem Readyfile (`adapters/openlive-acp/src/remote/server.ts:302–317`) und beweist ebenfalls keinen Voice-Call. |

`status_card` setzt `lastCheck=now()` auch bei Marker-/Dateibefunden. Das ist Hub-Beobachtungszeit, kein Verbindungsheartbeat. Logereignisse bekommen ebenfalls `now()` statt sicher geparster Originalzeit (`server.py:90–107`). „Abgerufen/Beobachtung“ nennen, keine Echtzeit-/Chronologie-/Freshness-Garantie daraus ableiten.

Fehlende/ungültige JSON werden durch `read_json` beide `None`; eine neue „Nicht eingerichtet“-Behauptung muss fehlende Konfiguration von unlesbarer/ungültiger Quelle unterscheiden. Kein „VM gestoppt“ aus einem fehlgeschlagenen `limactl`-Aufruf ableiten: Exitstatus und bekannter Status müssen positiven Stop-Nachweis liefern.

### 3.3 Natürliche Änderungsorte

- IA/Markup: `hub/index.html`; Verbindungsansicht/Hilfe/Logs: `hub/app.js`; Profildraft/Feedback: `hub/control.js`; Layout-/Fokusregeln: `hub/styles.css`.
- Diagnose/HTTP: `hub/server.py`; bounded MCP-Health-/Katalogprimitive: `hub/catalog.py`.
- Python-Policy/Resolver: `hub/policy.py`; TypeScript-Reader/Resolver: `adapters/mcp/src/agent-control.ts`; Schemas/Handler/Toolbeschreibungen: `adapters/mcp/src/tools.ts`.
- Workflow: Orchestrator-`SKILL.md`, `references/clarification-sessions.md`, `references/regression-scenarios.md`; Verträge: `hub/README.md`, `docs/MCP-INTERFACE.md`, `docs/CHATGPT.md`, `PLAN_AGENT_CONTROL_HUB.md`.
- Vorhandener Launcher/Hostlifecycle (`opencode-vm.sh:12233–12395`) bleibt geeignete Basis; keine neue Anwendung nötig. Produktpatches unterliegen später den Repository-Version-/Release-Vorgaben.

## 4. Recherche, Quellenqualität und projektspezifische Ableitung

Alle folgenden Primärseiten wurden am **2026-09-30** direkt abgerufen und inhaltlich gelesen. Externe Webrecherche war verfügbar. Empfehlungen sind eine heuristische Designanalyse, keine mit ACH-Nutzern durchgeführte Usabilitystudie.

| Ref | Quelle / Evidenzqualität | Anwendung auf ACH-1 |
| --- | --- | --- |
| R1 | [NN/g: Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/), Aurora Harley, 2018. Etablierte Expertenheuristik, keine Studie von 2026. | Zustandsgrund, Nachweisumfang und nächste Aktion anzeigen; sofortiges Savefeedback; verschwundene gespeicherte Modelle nicht still entfernen. |
| R2 | [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/), Jakob Nielsen, 2006. Etablierte Methode, kein direkter ACH-Vergleich. | Kerninformationen sichtbar, seltene Details/Hilfe auf Anfrage, klare Labels; keine dreistufige Verschachtelung. |
| R3 | [GOV.UK: Recover from validation errors](https://design-system.service.gov.uk/patterns/validation/). Offizielles, in Services verwendetes Pattern; trennt Nutzerfehler von Service-/Berechtigungsfehlern. | Eingaben erhalten, spezifisch erklären/Korrektur ermöglichen; beim Speichern validieren, nicht voreilig auf Blur. Serverseitige Validierung maßgeblich. |
| R4 | [GOV.UK: Error summary](https://design-system.service.gov.uk/components/error-summary/). Offizielle Komponentenpraxis; Änderungshistorie bis Juni 2026. | Konsistente Inlinefehler + verlinkte fokussierbare Summary. Auf profilweise asynchrone Formulare übertragen, nicht jeden Statuswechsel global alarmieren. |
| R5 | [GOV.UK: Details](https://design-system.service.gov.uk/components/details/). Offizielle Anleitung, ausdrücklich keine häufig benötigten Informationen verstecken; bekannte Assistive-Tech-Fragen. | Diagnose-/Setup-/Betriebshilfe einklappbar, Status/Fallback/nächste Aktion sichtbar; native Details mit Safari/VoiceOver prüfen. |
| R6 | [GOV.UK: Tabs](https://design-system.service.gov.uk/components/tabs/). Offizielle Empfehlung; Seite benennt offene Komponenten-/Small-Screen-Research. | Zuerst Überschriften/Inhaltsnavigation und Inhaltsreduktion prüfen. Nicht gemeinsam benötigte Inhalte unnötig verstecken; Tabsalternative bleibt plausibel. |
| R7 | [WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/), abgerufene Fassung 12.12.2024. Normativer Standard, Umsetzungstechniken separat informativ. | Prüfbasis: 1.3.1/1.3.2, 1.4.1/1.4.3/1.4.11, 2.1.1/2.4.3/2.4.7/2.4.11, 3.3.1/3.3.2/3.3.3, 4.1.2/4.1.3. Keine Konformitätsbehauptung ohne Prüfung. |
| R8 | [WAI: Understanding 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), aktualisiert 11.05.2026. Offizielle informative Erläuterung. | Saving/Saved/Fehler zugänglich ankündigen, gewöhnlichen Erfolg ohne Fokuswechsel; keine ständig vorlesenden Log-/Refresh-Live-Regions. |
| R9 | [WAI: Understanding 1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), aktualisiert 10.08.2026. Offizielle informative Erläuterung. | Bei 320 CSS-px bzw. äquivalentem 400%-Zoom keine zweidimensionale Seitenbedienung; 200%-Textvergrößerung; lange IDs/Formulartexte umbrechen. |
| R10 | [WAI: Understanding 2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), aktualisiert 11.05.2026. Offizielle informative Erläuterung. | Mindestens 24×24 CSS-px bzw. zulässige Ausnahmen; zentrale Aktionen praktisch größer gestalten. 44 px als Komfortempfehlung, nicht AA-Minimum. |

**Transfergrenzen:** GOV.UK ist kein Dark-Mode-Designsystem für diesen Hub; Farben, Typography, Seitenreload-/Titelkonvention und komplettes Framework werden nicht übernommen. WAI-Understanding-Seiten sind erläuternd, nicht zusätzliche normative Anforderungen. IA ist durch Auftrag und Code gestützt; Häufigkeit von Profilbearbeitung vs. Diagnose bleibt ohne Beobachtungsdaten Annahme, beim ersten UIreview zu prüfen. Keine erfundenen aktuellen Quellen oder Account-/Quota-Recherche.

## 5. Anforderungen und verifizierbare Ziele

### 5.1 Nutzeraufgaben

1. Schnell sehen, welcher Tuple je Rolle gespeichert ist oder welcher dokumentierte Fallback greift.
2. Ein Profil konfigurieren/ändern/entfernen, ohne andere Drafts zu verlieren oder laufende Sessions umzuschalten.
3. Erkennen: fehlt Setup, fehlt nur Nachweis, liegt ein konkretes Betriebsproblem vor, oder ist eine lokale Fähigkeit bestätigt?
4. An jeder Verbindung passenden nächsten Schritt und Setup-/Betriebshilfe finden.
5. Begrenzte Logs und Abdeckung prüfen; aus Logabwesenheit weder Health noch Fehlerfreiheit folgern.

### 5.2 Pflichtverhalten

- Physische/DOM-Reihenfolge Profile → Verbindungen → Logs; keine separate Signals-Schnellübersicht mit denselben Meldungen.
- Drei bestehende Profile plus zwei optionale Rollen. Fehlende Optionalzuordnung normal, nicht gelb/rot.
- Effektiver Fallback sichtbar, einschließlich unkonfigurierter Basis/Blockade; keine stille Runtimeersetzung.
- Diagnose bleibt lesend. „Einrichten“ öffnet Anleitung, führt keine CLI-Kommandos aus. Profil-Save speichert Präferenz, startet keine Arbeit/Sessionänderung.
- Policy/Draft getrennt; Refresh, Validierungsfehler, Konflikt und Teilfehler erhalten Eingaben.
- Schmale Fenster, lange Modellnamen, Tastatur und Screenreader sind funktionale Abnahmebestandteile.
- MCP unterstützt Profile / A2A und OpenLive noch nicht; Hostprüfung ist keine externe Clientabnahme. Grenzen lokal lesbar ohne Statuswand.

## 6. Drei plausible Designrichtungen

| Richtung | Konkretes Interaktionsmuster | Vorteile | Kosten / Nachteile |
| --- | --- | --- | --- |
| **A — Geordnete Einzelseite mit Summary und Inline-Disclosure** | Header + Sprunglinks; fünf kurze Profilzusammenfassungen mit „Konfigurieren/Bearbeiten“, Basisrollen vor Optionalrollen; darunter stabile Verbindungskarten mit lokaler Hilfe; Logs zuletzt. | Bestehende Panels/Selects/Server/Assets wiederverwendbar; Zustände gemeinsam vergleichbar; klare Lesereihenfolge, einfache Keyboard-/Reflowlogik. | Längere Seite als Tabs; mehrere offene Editoren brauchen gutes Spacing. Vier Verbindungstypen/fünf Rollen rechtfertigen derzeit keinen großen Navigationsoverhead. |
| **B — Drei echte Bereichs-Tabs** | „Profile“, „Verbindungen“, „Logs“ als getrennte Panels; Profile initial, URL-Fragmente und korrektes Tab-Keymodell; Hilfe im jeweiligen Panel. | Kürzere sichtbare Fläche, schneller wiederholter Wechsel, bestehende Taboptik anschlussfähig. | Profil-/MCP-Abhängigkeit nur durch Wechsel sichtbar; versteckte Fehler, Deep-Link/Fokus/History zusätzlich bauen. Heutige Filter sind keine echten Tabs. |
| **C — Kompakte Rollen-/Verbindungsliste mit Detailbereich** | Summaryzeilen; Auswahl öffnet daneben Editor/Details, schmal Inline. | Sehr scanbar, weniger wiederholte Felder; geeignet bei später deutlich mehr Einträgen. | Größerer Umbau, Selection-/Fokus-/Dirtykomplexität, zwei responsive Modelle. Kein belegter Skalierungsbedarf. |

**Empfehlung erster Schnitt: A.** Sie erfüllt den fixierten Fluss mit minimalem Architekturbruch. Hauptverbesserung entsteht durch Reihenfolge, lokale Statuskommunikation, Fallbacksichtbarkeit und verlustfreies Bearbeiten; Frameworkwechsel/Sidebar lösen diese Probleme nicht. B bleibt spätere Reaktion auf beobachtete Navigationsprobleme, C auf tatsächliche Listenskalierung. Kein Setup-Wizard: Setup/Diagnose sind wiederkehrend, Connectionmanagement bleibt CLI.

## 7. Empfohlene Informationsarchitektur und Disclosure-Vertrag

### 7.1 Textuelle Wireflow-Skizze

```text
Agent Control Hub · <Projektname>                  [Status aktualisieren] [Doku]
[Profile] [Verbindungen] [Logs]  ← Sprunglinks, keine vorgetäuschten Tabs

Profile
Projektpräferenzen für neue autorisierte Arbeit. Speichern schaltet keine Session um.
Katalog: geprüft / unvollständig / nicht verfügbar  [Katalog aktualisieren]
  Deep       Zweck · Tuple / Session-Default · Validierung [Bearbeiten]
  Standard   Zweck · Tuple / Session-Default · Validierung [Bearbeiten]
  Execution  Zweck · Tuple / Session-Default · Validierung [Bearbeiten]
Optionale Profile
  Design     Keine eigene Zuordnung → Standard · effektiver Tuple/Blockade [Konfigurieren]
  Review     Keine eigene Zuordnung → Deep → Standard · effektives Ziel [Konfigurieren]
             Unabhängige Bewertung; keine automatische Umsetzung von Findings.
  (Offener Editor: Provider → Modell → Variante, Draftstatus, Save/Abbrechen,
   sekundär eigene Zuordnung entfernen; Fehler: lokale Summary/Inlinehinweise.)

Verbindungen
  Secure MCP Tunnel / Incoming MCP / A2A / OpenLive
  Name · Zustand · Ursache · Nachweisumfang · [passender nächster Schritt]
  [Einrichtung / Betrieb & Diagnose aufklappen] · [zu passenden Logs]
  Tunnelkarte: [Client & Skill] inkl. Version/Download/Installhinweis

Logs
  Verfügbare Quellen · begrenzter Auszug · Abrufzeit [Quelle wählen]
  Auszug / Abdeckungs-Empty-State
```

### 7.2 Immer sichtbar vs. sekundär

| Element | Immer sichtbar | Aufklappbar / sekundär |
| --- | --- | --- |
| Profil | Rolle/Zweck, eigene Zuordnung/Abwesenheit, effektiver Fallback, Blockade/unprüfbare Verfügbarkeit, Bearbeitung | Selects, technische IDs, Effort-/Katalogerläuterungen |
| Optionalrolle | „Optional“, Zweck, Fallback, Reviewbegrenzung | Eigenes Mappingformular; nicht Existenz der Rolle verstecken |
| Verbindung | Zustand, Ursache, Prüfumfang/-zeit oder fehlender Nachweis, nächste Aktion | Setup-/Betriebsanleitung, Endpointklasse, sichere gekürzte ID, technische Details |
| Problem | Störung und unmittelbar nötiger Korrekturschritt | vertiefte Ursachen/Doku; nie Fehler selbst verstecken |
| Skill | Tunnelkarte: sichtbarer „Client & Skill“-Link; Instruction-only, getrennt vom Connector | Download, Revision, Checksumme, Importhilfe; keine installierte Clientrevision behaupten |
| Katalog | kurze Coverage-/Savefähigkeitsinfo und Refresh | Providerliste/Katalogdetails; LM-Studio-Setup bei Modell-/Providerhilfe, nicht als Agentenverbindung |
| Logs | Quellen-/Abdeckungsinfo, verfügbarer Auszug | längerer Auszug innerhalb bestehender Limits, Quellenfilter; kein zweiter Eventfeed |

Globale Hilfe-/Boundaries-Panels auflösen: Profilregeln bei Profilen, Verbindungsregeln bei Verbindungen. Nur kurze globale Dokuverweise im Header/Footer. Lade-/Policyformatfehler prominent im betroffenen Abschnitt sind kein Ersatz-Signals-Dashboard.

## 8. Kleinstes brauchbares Verbindungszustandsmodell

### 8.1 Vier Zustände, keine künstliche Zustandsmaschine

Drei Zustände würden „nicht geprüft“ mit „kaputt“ verwechseln. Architektur braucht zusätzlich konfigurierte, unbestätigte Bereitschaft. **Vier präsentationsbezogene Zustände** genügen; keine getrennten enums für jede Prozess-/Auth-/Tunnelphase, keine Persistenz in der Projektpolicy.

| Key / Formulierung | Kriterium | Nächste Aktion und Hilfe |
| --- | --- | --- |
| `not_configured` · **Nicht eingerichtet** (automatisch webgebunden: „Nicht aktiviert“) | Quelle zuverlässig gelesen/als fehlend erkannt; Konfiguration/Aktivierung fehlt. | „Einrichtung anzeigen“; erster nötiger Schritt sichtbar, kurze Setuphilfe offen. Keine Reparatur-/Authfehlermeldung. |
| `unverified` · **Konfiguriert · nicht bestätigt** | Konfiguration/Installation existiert, aber kein verlässlicher aktueller Check; nur Marker/TCP/alte Evidenz. | Bei Prüffähigkeit „Erneut prüfen“, sonst „Statusprüfung anzeigen“; Betriebsvoraussetzung/Prüfgrenze sichtbar, Diagnose sekundär. Keine Neuinstallation nahelegen. |
| `not_ready` · **Nicht bereit**, bei belegter Teilfähigkeit „Eingeschränkt“ | Relevante Probe schlägt konkret fehl, notwendige Runtime bestätigt gestoppt oder Capability explizit unterdrückt. | Konkrete „Session starten“-/„MCP aktivieren“-/Diagnosehilfe als Host-CLI-Anleitung; Betriebsschritte offen. Grund + betroffene Fähigkeit, nicht „ungesund“. |
| `ready` · **Bereit · lokal geprüft** | Aktuelle positive Probe bestätigt benannte lokale Fähigkeit mit passenden Dienst-/Projekt-/Generationmerkmalen soweit vertraglich vorhanden. | Betriebshilfe sekundär, Setup geschlossen; „Erneut prüfen“ sekundär, „Externer Client nicht geprüft“ als Scopehinweis. |

„Wird geprüft“ ist Requestfeedback, kein fünfter Betriebszustand. Nichtkonfiguriert/unverified neutral; gelb für tatsächliche Einschränkung, rot für bestätigten Fehlergrund, nicht Optionalität. Bedeutung immer als Text.

Unlesbare Quelle: `configured:null`, neutral „Konfiguration nicht lesbar – Status nicht bestätigt“, Diagnosehilfe. Fällt in `unverified`, ohne Installation zu behaupten; niemals „nicht eingerichtet“ aus JSON-/I/O-Fehler.

### 8.2 Anwendung je Verbindung

- **Stabile Typenkarten:** auch nicht eingerichtete Typen als Setup-Einstiege, nicht als erkannt/aktiv zählen. Vier bekannte Typen, keine Pluginverwaltung. Mehrere Sessionmarker: eindeutige Projekt-/Controllerbeziehung; Mehrdeutigkeit unverified statt erster Treffer. Normalvertrag bleibt eine aktive Projekt-VM.
- **Tunnel:** Zuordnung fehlt → Setup; vorhandene Zuordnung ohne gesicherte Runtime → unverified; positiv gestoppte VM → not_ready. Adapterruntime **nie** Tunnelhealth. Für ersten Schnitt ohne neue Healthpublikation bleibt aktive Zuordnung unverified mit `opencode-vm provider mcp status openai`-Hilfe. Kein neuer Collector/Proxy. `ready` nur bei künftig tatsächlich geprüfter Tunnelevidenz, nicht Marker/Logs.
- **Incoming MCP:** enabled allein → unverified; bounded authentifizierter Health für Projekt/Generation → ready **unabhängig** von Katalogcoverage. Healthfehler → not_ready; fehlende Credential-/Transportprüffähigkeit → unverified. `--no-mcp` als bewusste aktuelle Unterdrückung erklären, nicht Neusetup oder Löschung empfehlen.
- **A2A:** keine Websession → „Nicht aktiviert · benötigt Websession“. Card + validierter authentifizierter Servicehealth → lokales Ready; negative erreichbare Probe → not_ready; Format-/Zuordnung unsicher → unverified. Effektive Card-URL beachten; Name kein kryptografischer Projektbeleg. Credentials nur serverseitig, keine Tasksubmission als Probe.
- **OpenLive:** Shim fehlt → Setup; Shim vorhanden → „Bridge installiert · Projektbereitschaft nicht bestätigt“. PID-/Runtime-/Gatewaymarker kein Voice-Callbeweis. Positiv fehlende nötige Websession kann not_ready sein; Call wird nicht überwacht. Hilfe `opencode-vm openlive status`/`doctor`, Websession bereitstellen und Call im Client starten. Profilcapability unsupported.

### 8.3 Minimale API-Projektion

`/api/read-model` und Alias `/api/status` bleiben. Empfehlung: `schema:2`, gleiche vier IDs plus nicht eingerichtete Typen; pro Karte `configured:boolean|null`, `state`, `statusReason`, `lastCheck`, `checkScope` (z.B. `local-mcp-health`, `local-a2a-health`, `configuration-only`), `setupRef`. Alte Runtime-/Healthfelder ggf. konservativ für Übergang erhalten; neue UI liest `state`, nicht Stringpräfixe. Neue Schema-/Nullsemantik dokumentieren, nicht als unveränderten Schema-1-Vertrag ausgeben.

Zustand/Evidenz serverseitig zentral ableiten; kleiner typbezogener Frontend-Descriptor für Hilfe/Aktionen genügt. Kein Managementendpoint. `notices` ggf. kompatibel behalten, nicht mehr als zweite UI-Statusquelle rendern.

`catalog.py`: kleine gemeinsame authentifizierte Healthprimitive; Health getrennt von Katalogcoverage. **Nicht** kompletter Katalog als MCP-Readyvoraussetzung: truncation ist separate Einschränkung. Timeouts/Antwortbudgets erhalten, denselben Probe nicht mehrfach je Refresh ausführen; keine Katalogkopie in Projektstate.

## 9. Profilpräsentation, Rollen und deterministische Fallbacks

### 9.1 Rollen und Darstellung

| Profil | Zweck / Klassifikation | Ohne eigene Zuordnung |
| --- | --- | --- |
| Deep | Architektur, schwierige Diagnose, hartnäckige Fehler | Bestehende geeignete Session-Runtime/Backend-Default; kein neuer Basisfallback |
| Standard | Gewöhnliche Entwicklung und allgemeine Planung | Bestehende geeignete Session-Runtime/Backend-Default |
| Execution | Autorisierte Ausführung eines bekannten Plans, Tests, Routineoperationen | Bestehende geeignete Session-Runtime/Backend-Default |
| Design (optional) | Explizite UX/UI-/Interaktions-/visuelle Konzeptarbeit und entsprechende Ausarbeitung | Standard |
| Review (optional) | Eigenständige Prüfung/Bewertung von Konzept, Code oder Ergebnis | Deep, dann Standard |

Basisprofile als Kernrollen, nicht obligatorisch auszufüllende Felder: v1 erlaubt alle `null`. Design/Review immer als kurze Summary sichtbar. „Optional“ heißt **keine eigene Runtimezuordnung nötig**, nicht Feature-disabled; kein Enable-Toggle.

Friendly Modelname + Provider + Variante zeigen; genaue IDs über technische Details, nicht nur Tooltip. „Keine eigene Zuordnung“ neutral. `available` heißt „Im aktuellen Katalog verfügbar“, keine Laufzeit-/Qualitätsgarantie. Katalog fehlt → „Gespeichert · derzeit nicht prüfbar“; Tuple bleibt sichtbar, nicht definitiv verschwunden labeln.

Beispiele:
- `Design · Optional · Keine eigene Zuordnung → Standard · <Provider>/<Modell> · <Variante>`.
- `Review · Optional · Keine eigene Zuordnung → Deep → Standard · aktuell Standard` (Deep auch null).
- `Review · nutzt Deep; gespeicherte Deep-Variante derzeit nicht verfügbar. Vor neuer Arbeit Auswahl klären.`
- `Design · Standard ebenfalls nicht konfiguriert; bestehende Session-Runtime / Backend-Default.` Keinen konkreten effektiven Modellnamen erfinden, bevor die Zielsession bekannt ist.

### 9.2 Resolverregel — empfohlenes verbindliches Verhalten

Festgelegte Ketten als **Abwesenheitsfallbacks** interpretieren, begründet durch v1 „keine stille Ersetzung konfigurierter, fehlender Modelle“. Das ist ein implementierbarer Default, keine vorsorgliche neue Nutzerentscheidung.

1. Explizite Provider-/Modell-/Variantenwahl geht vor Rollenklassifikation; ihre Fehlverfügbarkeit nicht durch Profile heilen. Explizit gewünschtes Profil nutzt seine dokumentierte Auflösung.
2. Design Kandidaten `[design, standard]`, Review `[review, deep, standard]`, Basisrolle nur sich selbst.
3. Nur `selection:null` überspringen. Ersten **konfigurierten** Kandidaten exakt gegen denselben aktuellen Katalog prüfen.
4. `available` → exakter Tuple mit angefragter Rolle, aufgelöster Rolle und Pfad. Keine „ähnlichen“ Modell-/Effort-IDs.
5. Konfiguriert mit `provider_unavailable`, `model_unavailable`, `variant_unavailable`, `catalog_unavailable` oder `catalog_incomplete` → **Stop**, kein späterer Kandidat. Kein Outage-/Quota-Routing.
6. Alle Kandidaten null → `unconfigured`, keine Empfehlung; bestehender geeigneter Sessionruntime/Backenddefaultworkflow. Bei folgenreicher expliziter Modellwahl ggf. Klärung im ausführenden Client.
7. Resolver read-only, Fallback niemals in Policy kopieren. Standardänderung wirkt bei nächster Auflösung, nicht rückwirkend auf laufende Arbeit.

Gleiche Regeln in Hubpreview und MCP. Kleine native Python-/TS-Implementierungen mit gemeinsamen Testvektoren statt neuer Shared-Library-Abstraktion.

### 9.3 Unabhängige Reviewrolle

Review ist **Arbeitsintention**, nicht bloß Modellkosten/Effort. Reviewauftrag benennt Gegenstand/Revision, Kriterien, Scope und Ergebnisformat. Ergebnis trennt Findings, Belege, Schwere/Unsicherheit und Empfehlungen. Ohne weiteren autorisierten Implementierungsauftrag keine automatischen Produktedits/Fixes eigener Findings.

Independence bedeutet unabhängige Bewertung/Argumentation und nachvollziehbare Quellen, nicht garantiert anderes Modell oder eigene Sicherheitsidentität. Derselbe Tuple darf mehreren Rollen dienen. Nötige getrennte Reviewcontext-/Sessiongrenzen über bestehende autorisierte Sessionfunktionen; ACH-1 erzeugt keine Sessions automatisch und führt keine generelle Read-only-Permissionklasse ein. Reviewresultat ist nicht automatisch Boardabschluss oder Implementierungsfreigabe.

Gemischte Aufträge nach aktuellem autorisiertem Paket klassifizieren: Designkonzept/Review, danach getrennt autorisierte Ausführung. Allgemeine Architekturplanung nicht allein wegen des Wortes „Design“ aus Deep/Standard umklassifizieren; Mini-Followups wechseln nicht ständig die Runtime.

## 10. Formularverhalten, Speichern und Fehlererholung

### 10.1 Bearbeitungsmodell

- Summary bleibt; „Konfigurieren/Bearbeiten“ öffnet Inlineformular. Mehrere offene Profile erlaubt; keine automatische Schließung mit Draftverlust. Kleine Statebasis: `savedPolicy`, `draftByProfile`, Dirtymarker, Requestzustand, betroffene Fehler; kein Framework nötig.
- Native Selects, Provider → Modell → Variante. Providerwechsel löscht inkompatibles Modell/Variante bewusst, Modellwechsel inkompatible Variante. Keine anderen Profile betroffen. „default“ als konkrete Katalogvariante, nie leerer String als Default.
- Fehlender/inkompletter Katalog: gespeicherte Zuordnung und vorhandene Drafts bleiben; Auswahl-Save gesperrt mit sichtbarer Begründung/nächster Aktion. Teiloptionen beweisen keine vollständige Verfügbarkeit. Gespeicherte Option „derzeit nicht prüfbar“; erst vollständiger Katalog erlaubt „nicht verfügbar“.
- „Profil speichern“, „Abbrechen“ (nur eigenen Draft auf gespeicherten Stand setzen), sekundär „Eigene Zuordnung entfernen“. Remove beschreibt sofortigen Policywrite, nicht bloß Formularleeren. Optional: Wirkung „Danach nutzt Design Standard“ / Reviewkette. Bei null kein wirkungsloser Remove-Write.
- „Ungespeicherte Änderungen“ lokal. Refresh/Sprunglinks/Disclosure erhalten Drafts/Fokus. Bei Browser-Reload/Verlassen Dirty über übliche bedingte `beforeunload`-Warnung; keine dauerhafte Draftspeicherung oder allgemeine Bestätigungsmodale.

### 10.2 Save-/Readbackvertrag

1. Validieren bei Save, nicht Blur: spezifische fehlende Felder, Markierung/Inlinehinweis und lokale verlinkte Summary; Draft bleibt. Server validiert Tuple gegen frischen vollständigen Katalog.
2. Ein Browser-Policywrite zur Zeit wegen globaler Revision; Schreibaktionen kurz sperren, andere Drafts erhalten. „Wird gespeichert …“ sofort am aktiven Profil mit `role=status`. Kein Blindretry.
3. Bestehender PUT `{revision,selection}` bleibt. Erfolg liefert ganze Policy: Snapshot/Revision übernehmen, nur betroffenen Draft clean setzen; andere Dirty-Drafts nicht ersetzen. Eigene Controls während Save sperren, andere Profilcontrols editierbar lassen.
4. „Profil gespeichert · Revision N. Laufende Sessions unverändert.“ am Profil. Getrennte Katalognachlese optional; fehlgeschlagener GET danach darf belegten Save nicht als gescheitert darstellen.
5. `selection:null` weiterhin katalogunabhängig und revisionsgebunden. Basiseffekt „keine Projektzuordnung“ vs. Optionalfallback sichtbar.

### 10.3 Fehler-/Konfliktmatrix

| Situation | Reaktion / Recovery |
| --- | --- |
| Fehlender Provider/Modell/Variante | Konkretes „Wähle …“ am Feld und gleichlautend in Summary; nach Submit Summary fokussieren, Link setzt Feldfokus. |
| 422 Tuple im frischen Katalog nicht verfügbar | Auswahl erhalten. Betroffenen Provider-/Modell-/Variantenfehler aus strukturiertem Code zeigen; Katalogrefresh und neue Auswahl ermöglichen. |
| 503 Katalog fehlt/unvollständig | Kein Nutzerfehler. „Aktuell kein vollständiger Katalog; Zuordnung nicht gespeichert“; Draft erhalten, nötigen MCPbetrieb verlinken. |
| 409 `POLICY_REVISION_CONFLICT` | „Policy anderweitig geändert; dein Entwurf bleibt.“ Aktuelle Policy lesen, Saved/Draft vergleichen; erst bewusster neuer Save mit neuer Revision. Kein automatischer Overwrite. |
| 409 ungültiges/neueres Policyformat | Eigenen Fehlercode statt Revisionskonflikt. Unverändert lassen, Bearbeitung sperren, Format-/Versionshilfe; Reload keine scheinbare Reparatur. |
| 403/415/400 | Service-/Requestmeldung, nicht Provider als falsch markieren. Begründung/Doku und sinnvolle Recovery; keine Credentialanzeige. |
| Timeout/Netzabbruch beim PUT | „Speicherergebnis nicht bestätigt“, nicht sicher „nicht gespeichert“. GET anbieten: passender Tuple + fortgeschrittene Revision zeigt aktuell gespeicherten Stand, nicht exklusive Urheberschaft. Bei Nichtmatch/weiterem Konflikt Draft erhalten, Abgleich; kein zweiter PUT ohne bewusste Aktion. |
| GET-/Refreshfehler | Vorhandenen Snapshot als letzte bekannte Beobachtung erhalten, ebenso Drafts/Fokus. Erster GET ohne Daten → echter Ladefehler/Retry, keine vermeintlich leeren Profile. |

HTTPcodes beibehalten; additive JSONfelder `code`, ggf. `field`/`reason` für deutsche UItexte. Rohenglische Texte sekundäre Diagnose. Revision/Katalogzeitpunkt/Policyversion getrennt. Bounded JSONfehler serverseitig; UI behandelt auch Nicht-JSON/Abbruch robust.

## 11. Policy/schema, MCP/API und Migration

### 11.1 Formatentscheidung

**Schema 2 plus Schema-1-Lesekompatibilität empfohlen.** Zwei unabhängige Drei-Key-Validatoren würden zusätzliche Keys unter Schema 1 schon heute ablehnen; stilles Erweitern verletzt Versionssemantik.

Schema 2: `{schemaVersion:2, revision:N, updatedAt:UTC-Z, profiles:{deep,standard,execution,design,review}}`. Genau fünf Keys, jeweils null oder exakter `{provider_id,model_id,variant}`. Keine editierbaren Fallbackgraphen, Agentennamen/Rollenprompts, Credentials, Pfade oder Katalogkopien; feste Ketten sind Resolver-/APIsemantik.

Neue Reader akzeptieren gültige Schema 1/2. Schema 1 im Speicher um Design/Review null ergänzen, ursprüngliche Version/Revision erkennbar; diese normalisierte UIprojektion nicht als validierte persistente Schema-1-Datei zurückschreiben. Missingfile virtuelle Revision 0, keine Schreibwirkung. Invalid/future/symlink/budget fail closed. Kein Policyreset.

### 11.2 Migrations-/Writervertrag

1. Zuerst beide Reader/Schemas/Resolver/Tests aktualisieren. Optionalmapping nicht vor kompatiblem aktivem MCPadapter freigeben. Fähigkeit im tatsächlichen Toolkatalog entdecken, z.B. Design/Review in Inputenum plus Schema-2-Outputunterstützung; nicht Versionsstring allein.
2. Schema-1-Datei bleibt bei Reads und Basisprofiländerungen Schema 1. Neue Drei-Profil-Projekte ebenso möglich. Erst erster expliziter Save eigener Design-/Reviewzuordnung schreibt Schema 2; bis Nutzung der Ergänzung bleibt alte Architektur kompatibel.
3. Vor Save lokaler Hinweis: „Projektpolicy wird auf Format 2 erweitert; Original gesichert. Ältere Connectoren können Format 2 nicht lesen.“ Aktion etwa „Design speichern und Policy erweitern“. Keine Readmigration/heimliches Update, kein zusätzlicher genereller Approvalflow.
4. Unter Hostlock Revision/Original rereaden. Originalbytes privat projektlokal sichern, etwa `agent-control.schema1-rev<N>.backup.json`; abweichende vorhandene Sicherung nicht überschreiben. Backup fsync/publish vor Policyreplace; Backupfehler → kein Write. Missingfile hat kein Original, keine fiktive Sicherung.
5. Upgrade erhält drei Basistuple exakt, setzt ungenutzte Optionalrolle null, schreibt angefragten Optionaltuple und erhöht Revision **einmal**. Atomic-/Mode0600-/Fsync-/Gitignore-Regeln bleiben. Unterbrechung vor Replace: alte Policy plus evtl. Backup; Retry mit gleicher Ausgangsrevision muss dies sicher erkennen.
6. Schema 2 bleibt nach Optionalclear Schema 2. Kein automatischer Downgrade/Restore; seit Backup können Änderungen existieren. Dokumentierter manueller Rollback prüft Unterschiede und benötigt spätere ausdrückliche Aktion.
7. Alter/offline Adapter: Rollen/Fallbackhinweise sichtbar, kein erfolgreicher Optionalmapping-Save. Core-Schema-1-Operationen soweit unterstützt erhalten; Clear bereits existierender Zuordnung bleibt katalogunabhängig. Keine Credential-/Lifecycleänderung aus Hub.

Das ist alte-Dateien-Lesekompatibilität durch neue Komponenten, **keine** alte-Reader-Kompatibilität mit Schema 2. Gestagter Guestadapter kann älter sein als Host-UI: ggf. normaler autorisierter Projektreconnect/Restart + Client-Toolkatalogrefresh vor Nutzung, als späterer Abnahmepunkt, nicht Maßnahme dieses Passes.

### 11.3 Bestehende Tools/API erweitern

- `get_project_model_policy({})`: weiterhin read-only/project-scoped; `schema_version` 1 oder 2; fünf normalisierte Profile, jeweils eigene `selection/status`. Additiv `fallbacks:{design:["standard"],review:["deep","standard"]}`. Eigenstatus bleibt eigene Mappingvalidierung, nicht „konfiguriert“ wegen Fallback.
- `get_recommended_runtime({profile})`: Enum + Design/Review; bekannte `profile`, `policy_revision`, `status`, optional `runtime` erhalten. Neu `resolution_path` (tatsächlich betrachtete Kandidaten), `resolved_profile` am ersten konfigurierten Kandidaten, auch bei Blockade. Runtime ausschließlich `available`; angefragte semantische Rolle bleibt `profile`.
- Beispiel Erfolg: `{profile:"review",policy_revision:8,status:"available",resolved_profile:"standard",resolution_path:["review","deep","standard"],runtime:{...}}`. Blockiertes Deep: `{profile:"review",...,status:"variant_unavailable",resolved_profile:"deep",resolution_path:["review","deep"]}` ohne Runtime.
- Basisrollensemantik bleibt. Neue Felder für permissive Clients additiv, nicht vollständig kompatibel mit externen strict-Outputvalidatoren; Update/discovery dokumentieren/testen. Keine parallele v2-Toolfamilie ohne Bedarf.
- `update_session_runtime` bleibt einziger MCPsession-runtime-write. Resolver schreibt keine Policy/Session/Agenten/Permissions, legt nichts an, sendet nichts. Kein neuer MCPpolicy-write.
- `/api/control`: vorhandene Policy-/Katalog-/Validierungsdaten; normalisierte fünf Profile, Optionalresolverpreview, aktive Policycapabilities und Migrationsbedarf. UIpreview nicht aus Badges zusammenraten; Python/TS gleicher Vertrag.
- PUT `/api/control/profiles/{name}`: bestehender Payload; fünf Rollen, vorhandene Revision-/Origin-/Peer-/Katalogchecks. Expliziter Optional-Save Migrationsauslöser, kein separater Upgradeendpoint.

## 12. Accessibility, macOS-Browser, Responsiveness und Wartbarkeit

- `lang=de`, ein H1, drei Bereiche H2, Kartenrollen H3 bzw. Fieldset-Legenden. `main`, sinnvoller Skiplink/Sprunglinks; DOMordnung = visuelle Ordnung.
- Native `<form>`/`<fieldset>/<legend>` pro Rolle; eindeutige IDs/Labels, Rollenname im Gruppenkontext. Hint/Fehler via `aria-describedby`, `aria-invalid` erst bei Fehler.
- Native `<details>/<summary>` für Hilfe oder echte Disclosurebuttons mit `aria-expanded`/`aria-controls`; keine ineinander verschachtelten Interaktionen. Fokus/Offenstatus/Draft bei Updates erhalten. „Bearbeiten“ nicht unscheinbar in Technikhilfe verstecken.
- Native Select-Tastatur, Tab/Shift-Tab logisch, Enter Submit; Escape keine willkürliche globale Resetaktion. Disclosure Enter/Space, nichts Mouse-only; keine pseudo-Tabs.
- Fokus sichtbar für alle Controls/Links. Nach Save nicht verlieren; nach Submitfehler Summary fokussieren. Refresh stiehlt keinen Fokus, sticky Inhalte verdecken keine fokussierten Controls.
- `role=status`/polite für kurze aktionsbezogene Saving/Savedtexte mit Profilnamen. Fehler ggf. assertive oder fokussierte Summary, nicht doppelt vorlesen. Ganze Karten/Logs keine pauschalen Live-Regions.
- Text + Farbe für Zustand. Kontraste an gerenderten Panels prüfen: normaler Text 4,5:1, großer 3:1, erforderliche Control-/Fokusgrenzen 3:1 nach zutreffender Norm. Darklook beibehalten, unlesbar graue wichtige Nebeninfo nicht.
- Desktop Shell/Paneltokens behalten; Summarykarten nebeneinander möglich, Editor ausreichend breit. Höchstens zwei breite Editor-/Connectionspalten erste Empfehlung; konkrete Breakpoints aus Inhalt. Schmal eine Spalte in gleicher Ordnung, CTAs wrappen.
- Reflow 320 CSS-px, 200%-Textresize, 400%-Zoomäquivalent. Lange IDs/URLs/Checksumme/Fehler umbrechen; Selectwerte ergänzend als vollständiger Summarytext lesbar. Kritische Namen nicht nur Ellipsis/Tooltip.
- MacBook-Fenster/Splitview, Chrome + reales Safari aktuell bei Abnahme, Safari/VoiceOver und Tastaturnavigation explizit prüfen. Playwright WebKit Vorprüfung, kein Safari/VoiceOverersatz. Browser-Back bei Sprunglinks nativ.
- Nach Netzwerkfehler/Hostsleep letzten Snapshot als alt erkennen; Refresh begrenzte Reads, kein Betriebsliveness-Versprechen.
- Kleine Profil-/Verbindungsdescriptoren statt Copy-Paste; State über IDs, nicht Buttontext (`show-logs` heute textabhängig). Gezielte CSS-/JS-Erweiterungen statt Frameworkwechsel. Logs bleiben bounded/redigiert, keine Rohconfig im Browser.

## 13. Entscheidungsregister und offene Punkte

Der finale UIrefresh verwendet additiv `readModel` aus `/api/control`: ein gemeinsamer authentifizierter MCPhealth für Katalog/Capability/Diagnose, ohne persistierten Cache oder neues Managementendpoint. Policy-/Transportfehler lassen die eigenständige read-only Diagnose weiter zu. Mehrdeutige Zuordnungen/Sessionmarker bleiben unverified/configured null. Diese minimalen Vertragspräzisierungen erfüllen den geplanten Probe-/Wahrheitsvertrag; kein neuer Architektur-/Securityentscheid. Logbytes werden jetzt wirklich bounded gelesen, nicht erst nach Vollread abgeschnitten. Technical IDs erscheinen nur bei eigener/effektiver Zuordnung; der vollständige Dirtytuple bleibt außerhalb des nativen, ggf. abgeschnittenen Selecttexts lesbar.

Implementierungsbefunde des isolierten Nachtlaufs: aktive Optionalcapability wird über `tools/list` (Inputenum plus Schema-2-/Resolver-Outputfelder) geprüft; keine neue Healthinfra. A2A verwendet den effektiven Card-Port am lokalen Hostloopback, nicht den Card-Host als Credentialziel. Ein erster Chromium-Renderpass bestätigte A und führte zu entduplizierter Nullsummary, separater Optionalgruppe und weniger Leerfläche; Chromium/WebKit-Reflow fand lange Selectoptionen/Textresize-Overflow, gezielt mit begrenzter Fieldsetoverflow-/Wrapregel behoben (Fokusrand bleibt im Padding). Keine neue Produktentscheidung. Metadaten bleiben lokale Kandidaten: Script 0.6.5, MCP 0.1.19, Skill r22 vermeiden die vorgefundenen fremden 0.6.4/0.1.18/r21-Bezeichner, übernehmen aber keine ihrer Produktdiffs; r22 basiert weiterhin auf r19. Integration/Versionsreconciliation ist nicht freigegeben. Der Skillbuilder verlangt das bestehende Datums-rN-Format, daher kein ACH-suffigierter Marker.

| Kategorie | Inhalt / Status |
| --- | --- |
| **Bereits entschieden (Auftrag)** | Fluss, weniger Signals, lokale Verbindungshilfe, fünf Rollen mit zwei optionalen, feste Ketten, unabhängiges Review, separate Live-v1-Abnahme, kein Usage/Quota. |
| **Technisch aus Code geklärt** | Strikte Drei-Key-Policies; kein Fallbackresolver; revisionsgebundene Writes; unterschiedliche Health-/Katalognachweise; kein Tunnel-`connected`/OpenLive-`pid` an gelesenen Dateipfaden; UIvollrerender verliert Drafts. |
| **UX-/Technikempfehlung, 2026-09-30** | Richtung A, vier Zustände mit unverified, neutrale Optionalrollen, Inlineeditor/Fehler, Schema 2/Dualreader mit spätem ausdrücklichem Upgrade, Abwesenheitsfallback, keine Collectorinfra. Implementierbare Defaults, keine Nutzerblocker. |
| **Bei Implementierung verifizieren** | Alte gestagte Adapter/discovery, positive Stop-/Servicebelege, Konflikt/Unsicherheitsflows, Python-/TS-Parität, gerenderte Kontraste/Reflow und Safari/VoiceOver. Technische Prüfaufgaben. |
| **Hands-on prüfen** | Editor-/Summarybreite, Spalten, lange Tuple, Auffindbarkeit Optionalrollen/Hilfe, Sprunglinks vs. realer Tabbedarf. Visuelle/Interaktionsfeinabstimmung nach erstem Schnitt. |
| **Genuin offene Produkt-/Nutzerentscheidung** | Keine, die empfohlenen ersten Schnitt blockiert. Nutzer entscheidet später Modellzuordnungen; keine konkreten Modelle hier vorgeschrieben. |

Ein späterer Wunsch nach **Fallback auch bei Fehlern** wäre bewusste Änderung des erhaltenen v1-Vertrags. Wird nicht vorsorglich als INPUT_REQUIRED oder zusätzliche aktuelle Option eröffnet.

## 14. Sequenzierte Implementierungsarbeitspakete

WP1–7 sind im isolierten Quellcommit umgesetzt und fuer die gemeinsame Basis gemaess §17 regressionsgeprueft. Die Integrationsfreigabe ersetzt die alte Nur-Worktree-Grenze; neue Produktentscheidungen wurden nicht eingefuehrt.

Der Produktpass ist durch den Nachtlaufauftrag autorisiert. Reihenfolge reduziert Schema-/Clientmismatch und macht UI früh reviewbar; Ausführungsevidenz wird im Compact Context und Terminalresultat geführt.

### WP1 — Vertragsbasis und repräsentative Fixtures

- Scope: Plan in Hand-off-Kriterien/Beispiele übersetzen; betroffene v1-/HTTP-/MCP-Verträge später aktualisieren; kleine gemeinsame Zustands-/Resolverfixtureliste.
- Voraussetzung: aktuellen Working Tree/Versionen erneut lesen, fremde Änderungen respektieren.
- Ergebnis: vier Connectionzustände, unlesbare Quellen, optionale Nullprofile, blocked fallback, alte Datei/Adapter; keine Pixelmockups nötig.
- Abnahme: Zustand/nächste Aktion/effektive Rolle aus Beispielen eindeutig. Kein Wachstum in Quota, Connectionmanagement oder LANauth.

### WP2 — Dualreader, Resolver und MCP zuerst

- Dateien: `hub/policy.py`, `adapters/mcp/src/agent-control.ts`, `tools.ts`, Python-/TS-Policytests, `http.test.ts`.
- Implementieren: fünf normalisierte Rollen, Schema-1-/2-Lesung, Abwesenheitsketten, MCPschemas/metadata; Python-/TS-Parität.
- Abnahme: alte Datei unverändert lesbar, Missingread schreibt nichts; alle Ketten/Failclosedfälle; Reads keine Runtime-/Policy-/Sessionwrites. Strict-Client-/Adaptermismatch korrekt berichten.

### WP3 — Hostwriter, Migration und Recoverycodes

- Dateien: `hub/policy.py`, `hub/server.py`, `hub/catalog.py`, `tests/agent_control_test.py`.
- Implementieren: Optional-Save mit Revision/Lock/Atomiclogik, Backup vor Upgrade, Basiswrite ohne unnötige Migration, Schema-2-Erhaltung; aktive Adaptercapability, kodierte HTTPfehler.
- Abnahme: exakte Basistuple, ein Revisionsschritt, Auswahl nur mit vollständigem Katalog, Clear ohne Katalog; Backup-/Unterbrechungs-/Concurrencyfälle, invalid/future unverändert; keine Optionalaktivierung gegen alten Adapter.

### WP4 — Wahrheitsgemäße Verbindungsprojektion

- Dateien: `hub/server.py`, `hub/catalog.py`, `tests/hub_test.py`; bestehende Lifecycle-/A2A-Verträge abgleichen.
- Implementieren: vier Typenkarten, fehlend/fehlerhafte Quelle trennen, zentrale Zustands-/Nachweislogik, bestehender authentifizierter MCPhealth; ehrliche Tunnel-/OpenLive-Copy, keine zweite UI-Noticesquelle; Logcoverage/-zeit.
- Abnahme: TCP/Marker/Log/Installation keine falsche Readybehauptung; negative Probe vs. fehlende Probe getrennt; --no-mcp verständlich; JSON secretfrei; Katalog/Health unabhängig. Keine neue Collectorinfrastruktur.

### WP5 — Erster funktionaler UI-Schnitt (A)

- Dateien: `hub/index.html`, `app.js`, `control.js`, `styles.css`.
- Implementieren: Sprunglinks/Reihenfolge, fünf Summaryprofile, lokale Hilfe/Skillplatzierung, ein Logsbereich; Inlineeditor/Draftbewahrung, Save-/Conflict-/Unknownresultfeedback; Keyboard-/Screenreader-/Reflowbasis aus §12.
- Abnahme: Kernflows im gerenderten UI mit deterministischen APIfixtures plus lokalem realen Backend; kein Draft-/Fokusverlust, kein Runtimeswitch aus UI, korrekte Hilfe/CTAziele. **Jetzt Reviewcheckpoint**, nicht erst am Releaseende.

### WP6 — Skill-/Workflow-/Dokumentationsintegration

- Dateien: Orchestrator-`SKILL.md`, Clarification-/Regressionreferences, `hub/README.md`, `docs/MCP-INTERFACE.md`, `docs/CHATGPT.md`, `PLAN_AGENT_CONTROL_HUB.md`; weitere generische Doku nur wenn betroffen.
- Implementieren: actual-capability discovery, Design-/Reviewklassifikation ohne Keywordsalone, angefragte/aufgelöste Rolle offenlegen, Abwesenheitsfallback; explizite Wahl/idle-/pending-/Readback-/Single-send-Regeln erhalten. Review keine automatische Findingsumsetzung.
- Abnahme: reine Reads, neue Design-/Reviewarbeit, explicit tuple, blocked fallback, busy/pending, Capabilityabsenz; keine erfundene Permissionklasse/Sessionautoerzeugung.
- Bei Skilländerungen Revision/Marker/Changelog/Inventory aktualisieren, reproduzierbare ZIP/SHA-Artefakte gemeinsam bauen/prüfen gemäß `AGENTS.md` des isolierten Basisstands.

### WP7 — Hands-on-Review, Verfeinerung, Regression

- Erste reale UI in Safari/Chrome mit repräsentativen Zuständen zeigen, Aufgaben §15 durchführen und Findings am Viewport/Workflow festhalten.
- Danach ausdrücklich zulässiger visueller/UX-Refinementpass: Spacing, Hierarchie, Gruppierung, Copy, Disclosure-/Fokusdetails. A bleibt Default; nur beobachtete Probleme rechtfertigen B/C.
- Kernflow-/Draft-/Statuswahrheitsfehler blockieren funktionale Abnahme. Subjektive Kosmetik darf nachgelagert iterieren. Kein „pixelperfekt“ vor Hands-on. Linux-Chromium/WebKit-Vorprüfung erlaubt; fehlende reale Mac-/VoiceOverprüfung bleibt Operatorabnahme, kein Ersatzclaim.
- Relevante Tests, Script-/Release-/Standaloneparität, Launcherregression nach betroffenem Umfang. Bei späterer Scriptänderung Patchversion erhöhen, Shellcheck/syntax; Pins/Assets konsistent nach Repoverfahren. Kein Deployment/Commit aus Planfreigabe ableiten.

## 15. Test- und Abnahmekonzept

### 15.1 Policy-/Resolver-/Migrationsfälle

| Fall | Erwartung |
| --- | --- |
| Missingfile | virtuelle leere Policy, fünf normalisierte Rollen; kein Readwrite/Backup |
| Schema 1 gültig | neue Reader akzeptieren; Optionalrollen null, Basisempfehlungen unverändert |
| Basis-Save auf Schema 1 | bleibt Schema 1, neue Revision, kein Upgradebackup |
| Erster Optional-Save | Original gesichert, Schema 2, Basistuple erhalten, andere Optionalrolle null, genau eine Revision |
| Schema 2 gemischt/null | fünf Keys geprüft, Clear bleibt Schema 2, keine Fallbackgraphs |
| Invalid/future/symlink/budget/secretlike | fail closed, unverändert, kein Reset/Upgrade |
| Backupfehler/Interruptedreplace/abweichendes Backup | keine zerstörerische Veröffentlichung, Ausgangsrevision sicher recoverbar |
| Zwei konkurrierende Writes | nur ein Erfolg je erwarteter Revision, anderer Konflikt, kein verlorener Tuple |
| Design null, Standard available | resolved Standard, Pfad Design→Standard, exakter Tuple |
| Review null, Deep available | resolved Deep, Standard nicht zusätzlich bewertet |
| Review/Deep null, Standard available | resolved Standard, kompletter betrachteter Pfad |
| Eigene Optionalzuordnung available | eigenes Mapping, keine Policyänderung durch Resolver |
| Review null, Deep unavailable, Standard available | Stop an Deep, Fehlerstatus, kein Runtime, kein Sprung zu Standard |
| Konfiguriert + Katalog fehlt/unvollständig | Stop/unprüfbar, keine falsche Missingbehauptung/Ersetzung |
| Alle Kandidaten null | unconfigured, kein Runtime; bestehender geeigneter Defaultworkflow |
| Python-/TS-Parität | gleiche Status-/Pfad-/Resolvedresultate für alle Vektoren |

### 15.2 Verbindungs-/APItests

- Ohne Zuordnungen/Session/Bridge vier echte Setup-/Aktivierungseinstiege, keine aktive Behauptung; Registry invalid anders als fehlt.
- MCP: beliebiger TCPserver, falsches Token/Projekt/Generation ≠ Ready; richtige Health ready auch mit inkomplettem Katalog. Bounded Fehler, secretfreier Auszug.
- Tunnel: Adapterruntime ohne und mit handgesetztem `connected:true` im falschen Descriptorpfad bestätigt keinen Tunnel; verifizierter Stop vs. unknown Lima getrennt; Logs kein Statusoracle.
- A2A: Card allein nicht ausreichend; Healthservicebody/Auth, effektive Card-URL und Mehrdeutigkeit; keine SendMessage-Probe.
- OpenLive: Shim/Runtime/Gatewaypid kein Callbeweis; fehlende Webvoraussetzung passende Hilfe. Unsupported-Profilcapability unabhängig vom Transportzustand.
- Zeit als Abrufzeit; logabsence = Coveragegap oder keine Einträge, nicht Fehlerfreiheit. Quellenfilter echte Quellen; A2A/OpenLive ohne Allowlistlogs „im Hub keine Logquelle“.
- HTTP 400/403/409-Konflikt/409-Format/422/503 eindeutig, Nicht-JSONfehler robust. PUT keine Runtime-/Session-/Connection-/Credentialwrites; MCP-Reads weiter read-only annotations.
- Altgestagter Adapter: Optional-/Schemafähigkeit vor Migration prüfen; fremdes Projekt nicht kompatibel. Schema 1 mit neuem Reader, Schema 2 mit altem Reader (bewusster Fehler), Schema 2 mit neuem Reader testen.

### 15.3 Browser-/Accessibilityflows

1. Frisches Projekt: Basisrollen konfigurierbar, Optionalrollen mit sichtbarer Kette, keine Alarmbadges; fehlender Katalog erklärt nächste Aktion.
2. Design zuordnen/speichern: Tuple/Erfolg sichtbar, Migrationswirkung vorher erkennbar. Reviewabhängigkeit richtig.
3. Zwei Drafts, einen speichern: zweiter Draft/Fokus bleiben. Danach Refresh, Disclosure schließen/öffnen, GETfehler: keine Verluste.
4. Fehlende Pflichtauswahl, unbekannte Variante, 422/503: konkrete Ursache, verlinkte Summary/Fokus, Eingaben erhalten.
5. Zweite Browsertab ändert Policy: 409 → Saved/Draftvergleich → bewusst neuer Save, kein Autooverwrite.
6. PUT angenommen und Response verloren / nicht angenommen und Response verloren: nicht bestätigt, GETabgleich, kein Doublewrite. GETfehler nach erfolgreichem PUT ändert Savedbeleg nicht.
7. Optionalclear ohne Katalog zeigt Fallback, Basisclear „keine Projektzuordnung“, kein erfundener Basisfallback.
8. Vier Connectionzustände: Copy/CTA/Setup-/Betriebshilfe/Loglink passend; kein zweiter Signals-/Eventfeed.
9. Vollständig Tastatur; Safari/VoiceOver Rolegruppe, Werte, expanded/collapsed, Save-/Errorfeedback verständlich. Refresh stiehlt keinen Fokus, Success entfernt kein fokussiertes Element.
10. Chrome/reales Safari: MacBookfenster/Splitview, 320 CSS-px, 200%-Textresize, 400%-Zoomäquivalent; lange Namen/IDs/Fehler/Checksumme, Darkkontrast, Fokus sichtbar/nicht verdeckt, Targetgrößen. WebKitautomation nur ergänzend.

### 15.4 Vorhandene Testeinstiegspunkte für Produktpass

- Python: `PYTHONPATH=. python3 -B tests/agent_control_test.py`, `PYTHONPATH=. python3 -B tests/hub_test.py`, `python3 -B tests/agent_hub_launcher_test.py`.
- MCP, Arbeitsverzeichnis `adapters/mcp/`: `npm run check`, `npm test` (pretest baut); relevante `agent-control.test.ts`/`http.test.ts`-Fälle und bounded Transportintegration. Breiter `npm run test:integration` wenn realer Backendvertrag betroffen.
- Launcher: `python3 -B tests/web_launcher_proxy_test.py`, `node --test tests/web_launcher_dom_test.cjs`; Lifecycle-/Editorchecks soweit berührt.
- Skill nach tatsächlicher Änderung: `python3 -B scripts/build-chatgpt-skill.py`, mit `--check`, `python3 -B tests/chatgpt_skill_test.py`; Artefakte/Metadaten gemäß Repovertrag.
- Neue Browserflowtests für Verlust-/Unsicherheitsfälle, kein Snapshot-only-Farbtest. Beobachtbares Verhalten statt nur Implementierung spiegeln.
- Paket-/Standalone/Metadatachecks erst bei echten Code-/Releaseänderungen nach `.github/workflows/release.yml`, `docs/RELEASING.md`. Kein Test/Build dieses Konzeptpasses als Produktevidenz ausgeben.

### 15.5 Gates und Iteration

**Gate A:** Vertragskorrektheit, keine Silentfallbacks/Draftverluste, Migration/Konflikt und ehrliche Zustände. **Gate B:** erste funktionierende Oberfläche hands-on im Macbrowser prüfen, priorisierte Findings. **Gate C:** funktionale UXblocker schließen, gezielte visuelle Anpassung nach Beobachtung, relevante Regression wiederholen.

ACH-1 kann nach A/B/C lokal abgenommen werden. Reale **LAN/NetBird/ChatGPT-v1**-Netzwerk-/Transport-/Hostedakzeptanz bleibt eigene Aufgabe außerhalb dieser Freigabe. Hub darf sie nicht als grünes End-to-End behaupten. Hosted Skillverhalten ist nicht durch ZIPkonsistenz/lokalen Resolver bewiesen.

## 16. Historische Evidenz des ursprünglichen Konzeptpasses

- Beide Zielpfade/Identität vor Erstellung geprüft, keine bestehenden Zieldokumente. Root-`AGENTS.md` gelesen; kein Projekt-/Hub-`DESIGN.md` oder weiteres `AGENTS.md` gefunden.
- UI-/Server-/Policy-/Katalog-/MCP-/Skill-/Test-/Lifecyclequellen gelesen, oben Fundstellen. Codeevidenz, keine Produktausführung.
- Zehn offizielle/ursprüngliche UX-/Accessibilityquellen direkt abgerufen; Alter/informativ/normativ in §4 getrennt.
- Vorhandener Hubdescriptor führte auf Hostport 4181; read-only Browsernavigation und bounded `/healthz`-Abruf aus VM Timeout. Kein Neustart/Netzpolicyänderung. **Kein erfolgreicher gerenderter Ist-UI-/Screenshotreview**, kein Safari-/VoiceOver-/Live-Transporttest.
- Keine Produkt-/Skill-/Paket-/Release-/Infrastruktur-/Boardänderung, kein Commit. Produkttests/Builds nicht ausgeführt: nur zwei Dokumente geschrieben; Testplanung ist kein Testergebnis.
- Dokumente vollständig zurückgelesen und Task-ID/Dateipfade geprüft; `git diff --no-index --check` gegen beide neuen Dateien ohne Befund. Gitstatusvergleich mit Beginn: ausschließlich diese beiden Taskdateien neu hinzugekommen; vorhandene Produktänderungen gehören zu anderen Arbeiten. Ein Compact Context, ein Hauptplan, keine Detailaufteilung nötig.

**Historisches Handoffurteil:** ACH-1 war konzeptionell bereit für den ersten Schnitt, ohne blockierenden INPUT_REQUIRED-Punkt. Der nachfolgende Nachtlaufauftrag autorisiert nun die Umsetzung (§1); aktueller Stand und verbleibende Abnahmegrenzen stehen im Header und Compact Context. Der erste gerenderte Linux-UIreview und begrenzte Refinementpass sind erfolgt; dies ersetzt keine reale Mac-/Safari-/VoiceOver- oder fremde-WIP-Integrationsabnahme.

## 17. Konsolidierte main-Integration und kombinierte Abnahme (2026-09-30)

Ausgangs-HEAD `ce5c85c64fc35ba6693f007acc98e0d300de0741` enthaelt r21 `39f975ad…` und Header. Quellcommit `a196a17251dac0d4122e6a9ec2cbe979b95c10a1` bleibt unveraendert im isolierten Worktree. Hub-/Policy-/Resolver-/Fixturesource wurde nach Vergleich gegen gemeinsame Basis exakt uebernommen; MCP-Schemas/Handler, HTTPtest, Skill/Vertrag und Release-/Bundlemetadaten manuell reconciliiert. Keine alten Source-Bundles/Pins ueber die neueren Hauptdateien kopiert.

ACH-1-Funktionalitaet vollstaendig erhalten: fuenf Rollen und null-only Fallbacks, Schema-1/2-Dualreader und explizite backed-up Erstoptional-Migration, feste ehrliche Connectionstates, Profiles → Connections → Logs, lokale Hilfe, Draft/Fokus/Conflict-/Unknown-save-Recovery und bounded/redacted Diagnose. r21 add-only/Replay/Annotationen/Note-Semantik und Header-Evidence/Same-file-Recovery bleiben erhalten; taskboard.ts/-Tests und Diagnostics unveraendert gegen Ausgangs-HEAD. Kein neues Permission-/Session-/CAS-/Fallback-bei-Outage-Konzept.

| Kombinierte Pruefung | Ergebnis |
| --- | --- |
| Policy/Migration/Capability/echter stateless MCP-Transport, Python | **39 PASS**; Erstversuch parallel zum TS-Build sah altes dist und fehlende Optionalcapability, nach abgeschlossenem Build einzelner Transporttest und ganze Suite PASS. Kein Produktfehler durch Tests kaschiert. |
| Hub Connectionwahrheit/Probeabdeckung/Redaction | **9 PASS** |
| MCP check/build/gesamte Suite mit gepinntem Taskboard-Binary | **102 PASS / 0 FAIL / 0 SKIP**, inkl. ACH-1-Policy/Wire und r21/Header |
| Skill/Bundle/ZIP/Checksummen/latest | **17 PASS**, Build `--check` PASS; r23 auf r21+Header, keine r19-Regressionuebernahme |
| Browser HTTP/Policyfixture Chromium und WebKit | beide **PASS** fuer UIordnung, Validation/Focus/Drafts/Refresh, Migration/Conflict/Unknown-save/Clear/Fallback, Keyboard/Reflow/Kontrast; kein Safari/VoiceOverclaim |
| Launcher/Editor | Hub **4 PASS** mit neuem Pin/Versionenv, realer Proxy **2 PASS**, DOM **8 PASS**; Editor **18 PASS + 1 bestehender opt-in Live-SKIP**, Extension **1 PASS** |
| Reale disposable Backendintegration | OpenCode **1.18.21** PASS; r21-Smoke aus Source und production-only MCP-Paket 0.1.20 gegen Taskboard v0.6.0/OpenCode 1.18.33 PASS, keine produktiven Daten/Connector-Restarts |
| Release/Standalone/Lifecycle | Metadata/State **5+5 PASS**, Hub-/MCP-/OpenLive-/Lock-/Install-/Besprechungtests PASS; Bash syntax, ShellCheck severity=error, actionlint, diff --check PASS |
| Reproduzierbare Archive/Production-only Install | alle drei Archive zwei byte-identische Builds, MCP-/OpenLive-Produktionsinstall und Entrypoint-Descriptor-Guards PASS; paketierter MCP-Smoke PASS |

Konsolidierte Kandidaten: Script **0.6.6**, Adapter **0.1.20**, Skill **2026-09-30-r23**. SDK-/Zod-/OpenLivepins bleiben; alle Asset-Tags v0.6.6. Hub SHA `2ef956152cb1141239b58cd379726873824136dee25baff42d16bed4934b6034` (identisch mit ACH-1-Quelle), MCP SHA `73eac51146d48335264f5759c55a3a1a68a00694ab01463df3dd4d1abc5d2a3e` (neu kombinierter Code), OpenLive SHA `06f461873b8b299de98220aa577824eb9807672b26cb069541acebcdd2d973b9`, Skill ZIP SHA `1e6b3e3ed2581a467d0e7044ad1c130d71cb80375289bebda596b07b26b22c37`. Neue Archive `/tmp/opencode/ach1-integrated-{hub,mcp,openlive}-{a,b}.tar`, paketierter Smoke `/tmp/opencode/ach1-integrated-package-smoke/`; bestehende dist-Ausgaben bleiben unveraendert und ausserhalb des Commits.

**Git-Konsolidierung technisch vollstaendig und lokal abnahmebereit, kein lokaler Funktions-/Integrationsblocker.** Reales macOS/Lima/Safari/VoiceOver/Operatorreview, LAN/NetBird/Hosted-ChatGPT-/Voice und produktive Aktivierung sind weiterhin separate externe Abnahmen. Keine Board-done-Mutation oder Approval-Unterdrueckung behauptet. Exakte neue Integrations-SHA/Subject und finaler Gitstatus im Terminalabschluss, kein zweiter Nachpflegecommit. Fachkonzept bleibt unveraendert; alte isolated-r22/r19-Versionsevidence in §13 ist Historie, keine Beschreibung des jetzt konsolidierten r23-Produkts.
