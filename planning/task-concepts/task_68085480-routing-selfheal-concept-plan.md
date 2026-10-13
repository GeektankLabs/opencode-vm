Task-ID: task_68085480-3223-5cea-ad30-f89911613e59
Title: Routing-/Monitor-Selfheal-Nacharbeitung — Skill + reale Monitorpriming (Phase 1)
Last-updated: 2026-10-13T20:30Z

## 0. Einordnung
Autorisierte **Nacharbeitung** unter dem bestehenden Paketanker
`task_68085480-3223-5cea-ad30-f89911613e59`. **Kein neues Ticket.** Das
abgeschlossene Basispaket wird hier **nicht** als neuer Patch neu „fertig"
deklariert; dies ist eine additive, schmale Nacharbeit (Phase 1: Skill + Priming/
Selfheal), freigegeben durch den Nutzerauftrag vom 13.10.2026.

## 1. Basis / Pins
- Basis-HEAD: `3dfb71a20d4df24d7eca1cdfd6dba60ef10b84c0` (geprüfter Shutdown-Docs-HEAD).
- Branch `task/68085480-routing-selfheal`, Worktree
  `.opencode-vm/worktrees/task-68085480-routing-selfheal`.
- Main unverändert `39dab8f`; Shutdown-Worktree unverändert.
- Ergebnis-Versionen: OCVM `0.7.50`, MCP-Adapter `0.1.53` (Tags v0.7.50),
  Skill-Revision `2026-10-13-r55`.
- Adapter-Archiv `dist/opencode-vm-mcp-adapter-0.1.53.tar`, SHA256
  `8552b133961520c2eb484dde5ccbe821b1651f3089687ca9638e3db662391aca`.

## 2. Umfang (implementiert)
- **Priming (real):** `adapters/mcp/src/monitor-engine.ts` `buildPrimingBlock`
  um die Routing-/Selfheal-Disziplin erweitert; `PRIMING_CONTRACT` `mgmt-v3` →
  `mgmt-v4`. Der `primingDigest` enthält die Contract-Version → einmaliges
  Repriming bestehender Monitore (durch Test belegt).
- **Skill:**
  - `references/agent-preparation.md`: neuer Abschnitt „Pre-dispatch runtime gate".
  - `references/fallback-routing.md`: „Before a recovery: correlate, then continue the same order".
  - `references/monitor-manager-rules.md`: Wake-Duty-Loop Schritt 5.
  - `references/monitor-tasks.md` (runtime-Primerfeld), `references/monitor-reporting.md` (busy≠stall / unknown≠retry).
  - `SKILL.md` (Marker r55 + Verweis), `CHANGELOG.md` (r55), `bundle.json` (r55); ZIP + sha256 + latest.json neu gebaut.

## 3. Encodierte Regeln (Kern)
- Vor **jedem** neuen Dispatch (auch Follow-up): passendes **enabled** Profil frisch
  aus der **aktuellen** Policy, Runtime explizit gesetzt + vollständiger
  Provider/Modell/Varianten-Readback **vor** dem Send; der Session-Default ist
  nie Beleg; keine gecachte/historische Revision.
- Ein gesunder, aktiv arbeitender Worker wird nicht mid-turn umgestellt; bei
  abweichender Wunsch-Runtime kontrollierte Idle-Grenze statt Busy-Send bzw.
  nicht unterstütztem mid-turn-switch.
- Generische/inconclusive Antwort → nur begrenzter unterstützter Read-Retry, sonst
  benannter Blocker.
- Vor Recovery: korrelierter Receipt/Output/Fehler/Aktivität; bestätigter
  Timeout/Quota → aktuelle erlaubte Fallbackkette + Runtime-Readback → derselbe
  autorisierte Auftrag ohne Doppelwirkung; `unknown` nie blinder Retry, Busy allein
  kein Stall.
- Security-/Fachparks respektieren; ein evidenzbelegter falscher vererbter Default
  wird nach Fehlstart explizit korrigiert.
- Sticky Monitor-Final nur über spätere reguläre Wakes; interaktive
  Single-Order-Recovery behält Final-once; keine Hotloops, keine erfundenen Finals,
  keine Budget-/Rechteänderungen.

## 4. Quellen (actual priming / admission)
- **Primingsource:** `monitor-engine.ts` `buildPrimingBlock` (Contract `mgmt-v4`),
  geliefert über `buildWakePrompt` / `buildRecoveryPrompt`, Digest-Gate
  `primingDigest` / `recordPriming`.
- **Admissionsource:** Monitor `resolveRuntime` (`monitor-engine.ts`) → WAL →
  `sendMessage`; extern `opencode.ts sendMessage` (sendet unter der aktuellen
  Session-Runtime — das Pre-Dispatch-Gate ist hier kooperative Client-/Contract-
  Regel, **keine** technische Erzwingung); explizite Recovery
  `tools.ts recover_session_order`; Monitor-Recovery `monitor-engine.ts recover`.

## 5. Tests (tatsächlich gelaufen)
- Adapter-Unit (`node --test dist/*.test.js`): **311 pass / 0 fail / 2 skip**.
  - Priming/Reprime/Contractversion: `engine: MANAGEMENT priming is sent once, later wakes stay short and single-message` (inkl. Assertion Contract `mgmt-v4`), `engine: wake prompt stays inside its token budget and names the bounded mission`, `engine: compaction continuation repeats the MANAGEMENT role block once`, `engine: a session rebind inside the same wake primes the brand-new session immediately`.
  - Sticky Final: `task_68085480 sticky final: an exhausted unattended monitor retries exactly the global final stage on each suitable wake`.
  - Slot/Policyswitch: `slot disabled: new dispatch skips the paused primary to its own fallback before any request…`, `slot disabled: every stored slot paused parks honestly without any provider request`, `slot disabled: a recovery chain exhausted only by paused slots parks as recovery-chain-disabled…`.
  - Busy/receipt-unknown/Park: `engine: busy/pending holds, WAL reconciliation without blind resend, uncertain parks`, `gate fix QC-G1: unknown on an unchanged board does not settle; a later terminal header-timeout of the same receipt recovers on the next tick`.
  - Budget/Provider-Skip: `Welle B: quota evidence with Provider-Skip ON bypasses the failing provider…`, `budget: production-code max 2 without progress parks…`.
  - Recovery Final-once: `recover-order.test.ts` `recover_session_order: dispatches the final stage exactly once, then refuses the replay (escalated)`.
- Python: `tests/hub_test.py` 45 OK, `tests/agent_control_test.py` 65 OK, `tests/agent_hub_launcher_test.py` 12 OK.
- Pin/Release: `tests/release_metadata_test.py` PASS, `tests/release_state_test.py` PASS, `tests/mcp_adapter_test.sh` PASS, `tests/mcp_adapter_archive_test.sh` PASS, `tests/hub_release_test.sh` PASS, `tests/openlive_test.sh` PASS.
- Skill: `scripts/build-chatgpt-skill.py --check` OK, `tests/chatgpt_skill_test.py` 87 OK.
- Shell: `bash -n opencode-vm.sh` OK, `shellcheck --severity=error opencode-vm.sh` OK.

## 6. Restrisiko / bewusst NICHT freigegeben
- **Keine neue harte Adapter-API und kein automatisch überschreibender
  Runtime-Guard** (nicht freigegeben). Der externe `send_message`-Pfad sendet
  weiterhin unter der aktuellen Session-Runtime; das Pre-Dispatch-Gate ist eine
  kooperative Client-/Priming-Regel, keine technische Erzwingung. Ein späterer
  harter Guard wäre ein eigenes, ausdrücklich zu autorisierendes Vorhaben.
- Hosted-ChatGPT-Import/Verhalten bleibt separate externe Abnahme; hier nur
  lokale Paket-/Contract-Evidenz.
- Das Basispaket `task_68085480` gilt unverändert als abgeschlossen; diese
  Nacharbeit erklärt es nicht neu für fertig.

## 7. Grenzen
Kein Push/Publish/Install/Mainmerge/Liveprofile/BI. Native edit/write; bei
Denial STOP, keine Bash/Python-Schreibumgehung.
