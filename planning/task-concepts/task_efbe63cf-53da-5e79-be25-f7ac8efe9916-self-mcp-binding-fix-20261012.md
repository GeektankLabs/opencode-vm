Task-ID: task_efbe63cf-53da-5e79-be25-f7ac8efe9916 (Folge-/Reparaturbeleg; kein neuer Task erfunden)
Datum: 2026-10-12 (Fix-Freigabe 03:36 Europe/Berlin, Nutzer: "Der Fix ist freigegeben")
Status: IMPLEMENTED_READY_FOR_INDEPENDENT_QC (Kandidatenbranch, keine Main-Integration)

# Self-MCP-Bindung folgt dem MCP-Connector statt dem Orchestrator-Skill-Opt-in (U1-Fix)

## Ursache (diagnostiziert, belegt)
- Interne Monitor-Manager-Sessions sind native OpenCode-Sessions; ihre Tools kommen aus der
  VM-`opencode.json`. Der Adapter (`ocvm-self`, Loopback 127.0.0.1 + `X-OCVM-MCP-Token`) war
  nur registriert, wenn der opt-in-Orchestrator-Skill gemountet war
  (`mcp_self_register`/`mcp_self_connect`, Gate auf
  `$SESS_SHARE/config/opencode/skills/orchestrator/opencode-session-orchestrator`).
- Konzeptdiagnose U1 ("Skill inaktiv → kein ocvm-self → fehlende Tools") traf im Einsatzfall
  zu: Priming mgmt-v3 nannte Toolnamen, der Katalog enthielt sie nicht.
- KEIN Mastertask-/WorkPackage-Marker-Defekt: `primingDigest` bindet nur anchor+contract+
  autonomy+runtime+documents; keine Typ-/Labelprüfung existiert oder ist erforderlich.

## Änderung (minimal)
- `opencode-vm.sh` (web lib, WEBLIB-Heredoc): Skill-Mount-Gate aus `mcp_self_register` und
  `mcp_self_connect` entfernt. Bindungsbedingungen jetzt: `OC_MCP_ENABLED=1`, reguläre
  nicht-symlinked Config, valides `mcp/credential` (0600 im 0700 Share, unverändert).
  `mcp_self_unregister` bei Adapterstop unverändert (Token-Rotation bleibt sauber).
- Doctor-Hinweis angepasst (Sichtbarkeit ≠ Befugnis; Skill ist optionales Wissen).
- Kein Adapter-/Skill-/Registry-/Permission-/Gate-Change. Version 0.7.33 → 0.7.34.
- Begründung gegenüber Konzept P Z.60: technische Sichtbarkeit war nie Autorisierung;
  kooperative Manager-/Worker-Regeln (Aktionsmatrix §5) gelten unverändert. Externe Grenze
  (Loopback, Token, fail-closed) unverändert; in-VM-Prozesse konnten die Credential-Datei
  und das Projektverzeichnis ohnehin bereits lesen — keine neue Security-Grenze.

## Tests (alle im Kandidatenworktree)
- `tests/mcp_self_connection_test.py`: PASS — reale OpenCode-Runtime meldet
  `ocvm-self: connected` jetzt **ohne** Skill-Verzeichnis; unauthentifizierter Request
  fail-closed (401/403); Token-Leak-Check in Logs negativ. (Extraktion vorab repariert:
  holt `web_jq_inplace` statt des umbenannten Host-`jq_inplace` — Defekt lag am Basis-
  Commit 0320c8d, identisch reproduziert.)
- `tests/monitor_service_test.sh`: PASS (Guest-Kontext register/unregister, invalid-config
  unverändert).
- `tests/skills_orchestrator_test.sh`: 1 Failure "SKILL.md revision marker missing"
  (erwartet r49, Quelle hat r48) — VORBESTEHEND am Basiscommit, außerhalb Scope.
- `shellcheck`: keine Findings in geänderten Funktionen; `bash -n` OK.

## Kandidat
- Branch: `fix/mgmt-self-mcp-connector-binding`, Basis `0320c8d` (v0.7.33/Adapter 0.1.43)
- Worktree: `.opencode-vm/worktrees/task_efbe63cf-self-mcp-binding-fix`

## Upgrade-Pfad bestehender VMs (belegt, kein Reset nötig)
- Script-Update (installierte Fassung ≥ 0.7.34) + ein normaler Reconnect
  (`opencode-vm web` Reconnect-Pfad): Gast-Payload läuft `stop_mcp_adapter`
  (unregister) → `prepare_mcp_adapter`/`start_mcp_adapter` (re-register, Reconnect
  behält Port/Token) → `mcp_watch_ready`/`mcp_self_connect` (POST
  `/mcp/ocvm-self/connect` an die laufende OpenCode-Runtime; OpenCode liest MCP-Server
  nur beim Start und retryt nicht — der Connect-POST ist der unterstützte Weg).
- Kein Base-Neuaufbau, kein VM-Neustart, keine OpenCode-Dienstneustart-Pflicht;
  Sessions/Taskdaten/Monitor-Registry bleiben erhalten; Monitor-Bindung
  (anchor+priming) wird unverändert wiederaufgenommen.
- Remote bi-mcrepo: LIVE_UNVERIFIED — keine lokale Evidenz als Beweis dort.

## Offen / Folge
- Unabhängige QC + Main-Integration/Release (Operator-Gates; RELEASING.md).
- Keine Enforcement-Erfindung (Self-Steering-Guard bleibt separater Folgeticket, s. Priming).
