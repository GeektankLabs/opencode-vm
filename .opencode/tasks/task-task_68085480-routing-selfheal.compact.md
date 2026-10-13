Task-ID: task_68085480-3223-5cea-ad30-f89911613e59
Title: Routing-/Monitor-Selfheal-Nacharbeitung — Compact (Phase 1)
Last-updated: 2026-10-13T20:30Z

Autorisierte **Nacharbeitung** unter Paketanker `task_68085480-3223-5cea-ad30-f89911613e59`
(kein neues Ticket; Basispaket bleibt wie abgeschlossen). Vollständiger Plan:
`planning/task-concepts/task_68085480-routing-selfheal-concept-plan.md`.

## Basis / Pins
Basis-HEAD `3dfb71a`; Branch `task/68085480-routing-selfheal`; Main `39dab8f`
unverändert. Ergebnis: OCVM `0.7.51`, MCP-Adapter `0.1.54` (Tags v0.7.51),
Skill `2026-10-13-r55`; Archiv `dist/opencode-vm-mcp-adapter-0.1.54.tar`
SHA256 `ca65208366f399e4e3d5083249766e0c78ddeec8e1843b531e319c9d1ac481be`.

## Umfang
- Folgefix (nach Impl-QC_PASS): `get_project_model_policy` / `get_recommended_runtime` /
  `update_session_runtime` spiegeln kompakte nicht-geheime Kernmetadaten in
  `content[0].text` (Revision/Profil/ProviderID/ModellID/Variant/Enabled-/Auflösestatus/
  SessionID, Slots+Fallbacks+Strategie); `structuredContent` unverändert, keine Secrets.
- `monitor-engine.ts` `buildPrimingBlock` + `PRIMING_CONTRACT` `mgmt-v3`→`mgmt-v4`
  (Digest enthält Contract → einmaliges Repriming).
- Skill: `agent-preparation.md` (Pre-dispatch runtime gate), `fallback-routing.md`
  (pre-recovery correlate + same order), `monitor-manager-rules.md` (Wake-Loop 5),
  `monitor-tasks.md`, `monitor-reporting.md`, `SKILL.md`/`CHANGELOG.md`/`bundle.json`
  (r55) + ZIP/sha256/latest.json neu.

## Regeln
Vor jedem Dispatch (auch Follow-up): enabled Profil frisch aus aktueller Policy →
Runtime explizit + Readback vor Send, Session-Default nie Beleg, keine historische
Revision. Kein mid-turn-Umstellen gesunder aktiver Worker (kontrollierte Idle-Grenze).
Generische Antwort: begrenzter Read-Retry sonst Blocker. Recovery: korrelierter
Receipt/Output/Fehler, bestätigter Timeout/Quota → aktuelle Fallbackkette + Readback →
derselbe Auftrag ohne Doppelwirkung; unknown kein blinder Retry, Busy kein Stall.
Sticky Monitor-Final vs. interaktives Final-once getrennt; keine Hotloops/invented Finals.

## Tests
Adapter-Unit 311 pass/0 fail/2 skip; hub_test 45, agent_control_test 65,
agent_hub_launcher_test 12; release_metadata/state, mcp_adapter, mcp_adapter_archive,
hub_release, openlive PASS; build-chatgpt-skill --check OK, chatgpt_skill_test 87 OK;
`bash -n` + `shellcheck --severity=error opencode-vm.sh` OK.

## Restrisiko
Kein harter Adapter-API-/Runtime-Guard (nicht freigegeben); externer `send_message`
sendet weiter unter Session-Runtime (kooperative Regel). Hosted-ChatGPT-Abnahme separat.

## Grenzen
Kein Push/Publish/Install/Mainmerge/Liveprofile/BI; native edit/write, bei Denial STOP.
