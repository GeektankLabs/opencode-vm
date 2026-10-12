Task-ID: task_efbe63cf-53da-5e79-be25-f7ac8efe9916 (Folge-/Reparaturbeleg; kein neuer Task erfunden)
Datum: 2026-10-12 (Fix-Freigabe 03:36 Europe/Berlin, Nutzer: "Der Fix ist freigegeben")
Status: RELEASE_PREP_READY_FOR_INDEPENDENT_QC (Kandidatenbranch, keine Main-Integration,
kein Tag/Push/Release)

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

## Upgrade-Pfad bestehender VMs (belegt, kein Reset nötig) — KORRIGIERT 03:58+
- Script-Update (installierte Fassung ≥ 0.7.34) + **ein normales `opencode-vm attach`**
  auf der bestehenden Web-Session genügt; ein separates `web` ist NICHT nötig.
  Beleg: `attach_session` führt für web/tui-mcp dieselbe gemeinsame Guest-Payload aus
  (opencode-vm.sh:17787ff.; Payload ruft `prepare_mcp_adapter`/`start_mcp_adapter`
  → `mcp_self_register` :18053–18062 und `mcp_watch_ready` → `mcp_self_connect`);
  die vorherige Web/OpenLive-Runtime wird sicher gestoppt (:17595–17600, inkl.
  `stop_mcp_adapter`/Unregister). Ctrl-C läuft denselben bereinigenden EXIT-Pfad
  (:18014); attach re-registriert/reconnectet idempotent — keine Duplikate.
- Optionabhängig: reine TUI-Sessions ohne OpenAI-MCP-Zuweisung haben keinen Connector
  (attach = nur TUI-Attach, kein ocvm-self); `--no-mcp` unterdrückt aufruflokal.
- Kein Base-Neuaufbau, kein VM-Neustart, kein OpenCode-Dienstneustart-Pflicht;
  Sessions/Taskdaten/Monitor-Registry bleiben erhalten; Monitor-Bindung
  (anchor+priming) wird unverändert wiederaufgenommen.
- Remote bi-mcrepo: LIVE_UNVERIFIED — keine lokale Evidenz als Beweis dort.

## Release-Prep (QC-F1, Folgeauftrag 03:58)
- QC-F1 behoben: `OPENLIVE_ADAPTER_TAG`/`MCP_ADAPTER_TAG`/`HUB_ASSET_TAG`
  0.7.33 → v0.7.34 (opencode-vm.sh:37/48/55), Adapter 0.1.43 unverändert
  (keine Quelländerung → kein künstlicher Adapterbump).
- `tests/release_metadata_test.py`: 5/5 OK (identity assertions gegen v0.7.34).
- Lokaler Repro-Proxy: `scripts/build-mcp-adapter.sh` (SOURCE_DATE_EPOCH=0) liefert
  exakt den gepinnten SHA-256 `52f405…425ff` → Doppelbuild/Pin-Konsistenz vom
  CI-Workflow lokal vorbereitet; voller Doppelbuild läuft in release.yml (CI).
- F5 (vorbestehend, getrennt dokumentiert, NICHT bereinigt — out of scope):
  `tests/skills_orchestrator_test.sh` erwartet Skill-Revision `2026-10-09-r49`,
  die Quelle (integrations/chatgpt) trägt r48; am Basiscommit `0320c8d` identisch
  reproduziert. Betrifft den Skill-Bundle-Workflow, nicht diesen Kandidaten.
- Kein Git-Tag/Push/Release/Main-Integration/Installation ausgeführt.

## Offen / Folge
- Unabhängige QC + Main-Integration/Release (Operator-Gates; RELEASING.md).
- Keine Enforcement-Erfindung (Self-Steering-Guard bleibt separater Folgeticket, s. Priming).
