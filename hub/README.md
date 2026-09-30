# Agent Control Hub

Projektgebundene Verbindungsdiagnose und portable Runtime-Präferenzen. Reihenfolge **Profile → Verbindungen → Logs** mit Sprunglinks, Inlineeditoren und lokaler Hilfe. Fünf Profile sind änderbar; Provider-Credentials und Verbindungsverwaltung bleiben außerhalb der UI.

## Start und Netzwerk

`opencode-vm web` beziehungsweise `attach` startet je Projekt einen Hub auf dem ersten freien Port `4180..4199`. Für einen manuellen Start im Projektverzeichnis: `python3 hub/server.py --port 4180`. `HUB_PROJECT` und `OCVM_SHARE_ROOT` wählen Projekt und Test-Share explizit. Der Hub bindet an alle Host-Interfaces, beantwortet aber ausschließlich Requests von Loopback, RFC1918-, Link-local-, ULA- oder CGNAT/NetBird-Peers. Exposition zum öffentlichen Internet ist nicht vorgesehen; ein authentifizierter Proxy bleibt ein späteres Vorhaben.

## HTTP- und Projektvertrag

- `GET /healthz`: projektgebundene Launcher-Readiness. `GET /api/read-model` und `/api/status`: begrenzte, sanitierte Verbindungsdiagnose.
- `GET /api/control`: normalisierte Policy, aktueller MCP-Katalog, `validation`, `resolutions`, `fallbacks`, aktive `capabilities.optionalProfiles` und additiver `readModel` für denselben UIrefresh. MCP-Health wird dabei einmal geprüft und zwischen Katalog/Diagnose geteilt; keine Katalogkopie persistiert. Bei Policy-/Transportfehlern kann die UI Diagnose separat read-only laden. Discovery prüft Inputenum und Schema-2-/Resolver-Outputfelder im tatsächlichen Toolkatalog, nicht nur eine Versionsnummer. A2A/OpenLive bleiben `unsupported`. Bei `--no-mcp` bleibt die Policy sichtbar, Katalog und Optionalfreigabe fehlen.
- `PUT /api/control/profiles/{deep|standard|execution|design|review}`: JSON `{ "revision": 0, "selection": {"provider_id":"…","model_id":"…","variant":"…"} }` oder `selection:null`. Origin/JSON/private Peer werden geprüft. 409 `POLICY_REVISION_CONFLICT` ist getrennt von `POLICY_FORMAT_UNSUPPORTED` / `POLICY_CAPABILITY_UNAVAILABLE`; 422 `SELECTION_UNAVAILABLE` enthält `reason`; 503 `CATALOG_UNAVAILABLE` / `POLICY_SAVE_UNCONFIRMED` unterscheidet fehlenden Katalog und unbestätigten Write. Löschen braucht keinen Katalog. Speichern schaltet keine Session um.
- `<Projekt>/.opencode-vm/agent-control.json`: Schema 1 enthält genau Deep/Standard/Execution; Schema 2 genau zusätzlich Design/Review. Beide Reader normalisieren fünf Rollen, ohne Readwrite. Basiswrites bleiben Format 1. Erster expliziter Optionalmapping-Save verlangt aktive Capability, sichert Originalbytes privat als `agent-control.schema1-rev<N>.backup.json`, dann ersetzt er unter Lock atomar mit Format 2 und genau einem Revisionsschritt. Ein abweichendes/unsicheres Backup wird nicht überschrieben; Backupfehler stoppen den Write. Missingfile hat kein Originalbackup. Format 2 bleibt nach Clear erhalten. Alte Reader können Format 2 nicht lesen.

Design → Standard und Review → Deep → Standard sind feste **Abwesenheitsfallbacks**: nur null überspringen. Erster konfigurierter Tuple wird exakt geprüft; unavailable/unprüfbar/incomplete stoppt. Alles null lässt bestehende geeignete Session-Runtime / Backend-Default. Review bewertet unabhängig und setzt eigene Findings ohne neuen Implementierungsauftrag nicht automatisch um.

Entwürfe, offene Editoren und Fokus bleiben bei Refresh/anderen Saves/GETfehlern erhalten. Ein Browserwrite zur Zeit. Revisionskonflikt verlangt bewussten Saved-/Draftabgleich. Verlorene PUTantwort wird zurückgelesen, nicht automatisch wiederholt; passender Tuple plus fortgeschrittene Revision belegt den aktuellen Stand, keine exklusive Urheberschaft. Formatfehler sperren Writes. Browserreload mit Dirtydraft nutzt die native Leave-Warnung.

Manueller Rollback ist keine Hubaktion: vor ausdrücklich autorisiertem Restore Originalbackup gegen aktuelle Policy vergleichen, spätere Änderungen sichern/reconciliieren und passende Reader sicherstellen. Niemals eine alte Sicherung blind zurückkopieren; die Revision ist kein automatischer Downgradepfad.

## Ehrliche Connectionzustände

Read-model **schema 2** liefert vier stabile Typenkarten mit `configured:boolean|null`, `state`, `statusReason`, `checkScope`, `lastCheck` (Hub-Beobachtung, kein Heartbeat) und `setupRef`. Zustände: `not_configured`, `unverified`, `not_ready`, `ready`. Unlesbare Quelle ist unverified/configured null. Kompatible alte Healthfelder bleiben konservativ, die UI verwendet `state`.

TCP/Descriptor/PID/Logs sind kein Readybeleg. Incoming-MCP-Ready verlangt authentifizierten Health mit Projekt/Generation, unabhängig von Katalogcoverage. A2A prüft Card und authentifizierten Servicebody am effektiven lokalen Port; kein SendMessage als Probe. Tunnelzuordnung und installierte OpenLivebridge bleiben ohne passenden Nachweis unverified, positiv gestoppte/fehlende nötige Runtime ist not_ready. Kein Voice-Call-/externer Clientclaim. Logs sind unten, bounded/redigiert; fehlende Einträge beweisen keine Fehlerfreiheit.

## Lokale Verifikation und Abnahmegrenze

`PYTHONPATH=. python3 -B tests/agent_control_test.py`, `PYTHONPATH=. python3 -B tests/hub_test.py`; im MCP-Paket `npm run check`, `npm test`, `npm run test:integration`. Browserfixture nutzt echtes HTTP/Policywrite mit deterministischem Testkatalog: `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/ach1_browser_test.mjs`, zusätzlich `BROWSER=webkit`. Playwright separat installieren; keine Produktabhängigkeit. Linux-Chromium/WebKit sind Vorprüfung, **kein reales Safari/VoiceOver**, keine Mac/Lima-, LAN/NetBird-/Hosted-ChatGPT-Abnahme. Lokale Buildmetadaten sind nicht veröffentlicht.

`.opencode-vm/` wird standardmäßig in der Projekt-`.gitignore` ignoriert. Soll **nur die Policy** absichtlich versioniert werden: `git add -f .opencode-vm/agent-control.json`; anschließend `git diff --cached` prüfen. Den gesamten Ordner niemals mit `git add -f .opencode-vm/` hinzufügen – dort können Datenbanken und Logs liegen.

Hub-Logvorschau liest nur erlaubte lokale MCP-Logs, begrenzt und redigiert; keine OAuth-/Provider-Credentials gelangen an den Browser. Usage/Quotas gehören nicht zu v1. Ein späteres Vorhaben setzt eine offiziell unterstützte Account-Usage-Schnittstelle voraus.

## Launcher

Der bestehende Button **Agent Control** (nach Editor und Project Management) öffnet die aktuelle private Host-Adresse auf dem effektiven Hub-Port in einem neuen Tab. `/healthz` liefert `status:"ok"`, `service:"agent-connectivity-hub"`, `readOnly:false` und den `projectHash`. Nur ein passender Healthcheck und ein frischer privater Runtime-Heartbeat machen den Eintrag ready.
