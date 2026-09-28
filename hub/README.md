# Agent Connectivity Hub

Eigenständiger, read-only Webdienst für die nachweisbaren OpenCode-VM-Agent- und MCP-Verbindungen.

## Start

Aus dem Repository-Root:

```bash
python3 hub/server.py --port 4180
```

Danach ist die Seite unter `http://127.0.0.1:4180/` erreichbar. `HUB_PROJECT=/absolute/project/path` bindet die Anzeige explizit an ein Projekt; standardmäßig wird das aktuelle Arbeitsverzeichnis verwendet. Für Tests kann `OCVM_SHARE_ROOT` auf eine Fixture-Struktur zeigen. Der Dienst bindet standardmäßig nur an Loopback.

## Read-only-Vertrag

- `GET /healthz` liefert die Launcher-Readiness.
- `GET /api/read-model` liefert ausschließlich sichere, begrenzte Status- und Diagnosefelder.
- `GET /api/status` ist ein Alias.
- Erlaubte Logquellen sind nur `<session-share>/mcp/tunnel.log` und `backend.log`; Inhalte werden begrenzt und serverseitig redigiert.
- Es gibt keine Schreibroute, Credential-Verwaltung, Mutation oder Start-/Stop-Aktion.

## Launcher-Vertrag

Späterer Label: `Agenten & Verbindungen` (zentral änderbar im Launcher). Ziel-URL: `http://127.0.0.1:4180/` oder die vom Launcher bereitgestellte same-origin Proxy-Route. Readiness: HTTP 200 von `/healthz` und JSON `{ "status": "ok", "service": "agent-connectivity-hub", "readOnly": true }`. Startup dependency: Hub-Prozess muss vor dem Launcher-Link gestartet sein; die Seite selbst benötigt keine OpenCode-Runtime. Der Hub verändert keine Launcher-Dateien.
