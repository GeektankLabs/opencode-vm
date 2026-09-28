# Agent Control Hub

Projektgebundene Verbindungsdiagnose und portable Runtime-Präferenzen. Nur die drei Modellprofile sind hier änderbar; Provider-Credentials und Verbindungsverwaltung bleiben außerhalb der UI.

## Start und Netzwerk

`opencode-vm web` beziehungsweise `attach` startet je Projekt einen Hub auf dem ersten freien Port `4180..4199`. Für einen manuellen Start im Projektverzeichnis: `python3 hub/server.py --port 4180`. `HUB_PROJECT` und `OCVM_SHARE_ROOT` wählen Projekt und Test-Share explizit. Der Hub bindet an alle Host-Interfaces, beantwortet aber ausschließlich Requests von Loopback, RFC1918-, Link-local-, ULA- oder CGNAT/NetBird-Peers. Exposition zum öffentlichen Internet ist nicht vorgesehen; ein authentifizierter Proxy bleibt ein späteres Vorhaben.

## HTTP- und Projektvertrag

- `GET /healthz`: projektgebundene Launcher-Readiness. `GET /api/read-model` und `/api/status`: begrenzte, sanitierte Verbindungsdiagnose.
- `GET /api/control`: Policy, aktueller OpenCode-Katalog über den vorhandenen Incoming-MCP-Read, pro Profil Validierungsstatus und Transport-Capabilities. MCP unterstützt Policy-Reads; A2A/OpenLive melden `unsupported`. Bei `--no-mcp` bleibt die Policy sichtbar, der Katalog ist `unavailable`.
- `PUT /api/control/profiles/{deep|standard|execution}`: JSON `{ "revision": 0, "selection": {"provider_id":"…","model_id":"…","variant":"…"} }` oder `selection:null` zum Löschen. Nur passende Browser-Origin, JSON und private Peer-Adresse sind zugelassen. Konkurrierende Revision → 409; unbekannte Auswahl → 422; unvollständiger/fehlender Katalog → 503. Eine Änderung speichert sofort, schaltet aber keine Session um.
- `<Projekt>/.opencode-vm/agent-control.json` enthält `schemaVersion:1`, Revision, UTC-Zeitpunkt und ausschließlich portable, credential-freie Modellzuordnungen. Die Datei fehlt bei neuen Projekten, bis der Nutzer erstmals speichert. Ungültige oder neuere Formate bleiben unverändert und werden nicht automatisch überschrieben.

`.opencode-vm/` wird standardmäßig in der Projekt-`.gitignore` ignoriert. Soll **nur die Policy** absichtlich versioniert werden: `git add -f .opencode-vm/agent-control.json`; anschließend `git diff --cached` prüfen. Den gesamten Ordner niemals mit `git add -f .opencode-vm/` hinzufügen – dort können Datenbanken und Logs liegen.

Hub-Logvorschau liest nur erlaubte lokale MCP-Logs, begrenzt und redigiert; keine OAuth-/Provider-Credentials gelangen an den Browser. Usage/Quotas gehören nicht zu v1. Ein späteres Vorhaben setzt eine offiziell unterstützte Account-Usage-Schnittstelle voraus.

## Launcher

Der bestehende Button **Agent Control** (nach Editor und Project Management) öffnet die aktuelle private Host-Adresse auf dem effektiven Hub-Port in einem neuen Tab. `/healthz` liefert `status:"ok"`, `service:"agent-connectivity-hub"`, `readOnly:false` und den `projectHash`. Nur ein passender Healthcheck und ein frischer privater Runtime-Heartbeat machen den Eintrag ready.
