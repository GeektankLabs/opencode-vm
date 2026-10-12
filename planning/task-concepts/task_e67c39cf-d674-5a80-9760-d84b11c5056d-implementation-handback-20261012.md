Task-ID: task_e67c39cf-d674-5a80-9760-d84b11c5056d

# Implementation Handback — Release-Paket Monitor-Fortschrittsstrategie + verlässliche Rückmeldungen

Status: **CORRECTED_CANDIDATE_READY_FOR_INDEPENDENT_QC** (2026-10-12; QC-F1–F4 + Z1
eingearbeitet — Delta zum geprüften Kandidaten 960cb41, siehe §6)
Implementierer: alleiniger Produktcode-Writer dieses Pakets (diese Session);
Author-Verifikation ist **keine** unabhängige QC — die exakte Kandidaten-QC
erfolgt danach in einer eigenen Reviewsession.

## 0 Korrigierter Kandidat (nach Candidate-QC CHANGES_REQUIRED + Z1-Addendum)

| Feld | Wert |
|---|---|
| Kandidat-Commit (Tip) | **`d7765e8e7303d7bb8cb45abb64e06fc64abd3169`** |
| Kandidaten-Tree | **`ba0e6ea83009e032e9a2d001f28f3dca33a0bc33`** |
| Base / erster geprüfter Kandidat | `b7aa264…` (unverändert) / `960cb41d7577f8729840e40dcf622a6677d20fee` (Ancestor) |
| Delta zum geprüften Kandidaten | 7 Dateien, +782/−51; 2 Commits: `8fca026` fix(monitor) F1–F4+Z1 · `d7765e8` chore(release) Pin+Doku |
| Neuer Archiv-Pin | MCP-Adapter 0.1.44 (Version unverändert), SHA-256 `c211da15ec452a3aed4bd6e49511884ae55a08747165e9fe8e4ed9bba4275236` (Doppelbuild byte-identisch, `cmp`) |

**F1:** `milestoned`-Vertrag operational — unerreichter überfälliger Meilenstein
zieht genau EINE begrenzte Untersuchung je Deadline-Wert
(`milestone.overdue_handled_for/at`; kein Due-Loop; nur echtes A erreicht den
Meilenstein, `achieved_at`). `daily_budget` zählt EXECUTIERTE Untersuchungen im
rollierenden 24-h-Fenster (`recent_investigations`); Überschreitung ⇒ DEFER (nie
ausgeführt/gezählt) mit transparenter neuer Frist (Fensterende) + sichtbarer
`investigation-deferred`-Decision (`next_check`/`limit`); billige Checks laufen
weiter. Checkpoint-Evidenz (b) ist jetzt **technisch ausgewertet**: begrenzter
Journal-Scan (≤20 Einträge × 2000 Zeichen, 1 admission-geprüfter Board-Call) auf
die eigenen Receipt-Token → `receipt_correlated_checkpoint`; ohne Text-Zugang
`checkpoint_evidence_unavailable`, kein Claim.
**F2:** Budgets werden **vor jedem Read** durchgesetzt (Dauer/Calls/Bytes
Admission → `aborted_budget` + `budget_exhausted`, kein Call over budget) und
jeder Call ist per `call_timeout_ms` (neu, 250–15000, Default 3000) gebunden
(`call_timeout`-Evidenz; bindet das Engine-WARTEN, das Backend behält seinen
Transport-Timeout). Bytes werden je Antwort nachgezählt und vor dem NÄCHSTEN
Call admitted — die aufgerufenen Endpoints sind vertraglich begrenzte
Metadaten-Snapshots; die Byte-Garantie ist Admission-Control, kein Stream-Cap
(präzise dokumentiert).
**F3:** Handback-Testzahl korrigiert (der erste Kandidat enthielt **10** neue
Testfälle, nicht 11; dieser korrigierte Kandidat kommt mit **8 weiteren**
Regressionen auf 18 neue Untersuchs-Fälle insgesamt, Suite jetzt 277 Tests).
**F4:** `MonitorWorkerRecord.dispatch_at` (additiv) wird beim Rebind nur bei
genuin NEUEM `dispatch_receipt` erfasst; Anker bevorzugt `dispatch_at` (source
`dispatch`), Creation nur belegter Legacy-Fallback (source `creation`);
Same-Receipt-Rebind resetted nie.
**Z1:** Observer Phase 2 — während ein Wake in-flight ist (`run.active`):
begrenzte, receipt-korrelierte Status-Probes der eigenen aktiven Worker
(≤3/Batch, 30-s-Throttle `observer_probe_at`, pro Call `call_timeout_ms`),
persistiert als Merge-Key-`observer-probe`-Decisions **trotz blockiertem
vorherigem Wake**; Fremdattribution ausgeschlossen (nur own active worker am
eigenen Receipt); keine Sends/Recovery/Abort; lebender Owner wird nie
freigegeben; Phase 1 (Due/Handover/Stuck-Visibility) weiter registry-only.
Nutzervertrag nicht auf registry-only reduziert; Produktions-Transport-Timeouts
(3 s/Call) unverändert, F2-Gesamtzeitbudget separat.

## 1 Kandidaten-Identität (erster geprüfter Stand — historisch)

| Feld | Wert |
|---|---|
| Repository | `/Users/admin/Documents/github/opencode-vm` (Lima-VM-Mount des Host-Checkouts) |
| Base | `b7aa2640aa328ee5705ffb51de2cbac10db0705a` (= Main-HEAD bei Umsetzungsbeginn und bis Übergabe; main+3 Kandidat) |
| Branch | `task/monitor-progress-package` (task-eigen, Worktree `.opencode-vm/worktrees/task_e67c39cf-d674-5a80-9760-d84b11c5056d`) |
| Kandidat-Commit (Tip) | **`960cb41d7577f8729840e40dcf622a6677d20fee`** |
| Kandidaten-Tree | **`be0fc85ab7cb94c3d505807f49b4c2174768cea5`** |
| Commits (3, chronologisch) | `cb28047` feat(monitor): adaptive per-worker progress/investigation with claim recovery · `9ed3411` feat(skill): r52 shared communication-states vocabulary + monitoring regressions · `960cb41` chore(release): 0.7.35 / adapter 0.1.44 pins + changelog + contract docs |
| Diff | 23 Dateien, +1754/−27 (`git diff --stat b7aa264..HEAD`); Dateiliste = §3 |
| Working Copy | sauber (0 Einträge); keine fremden Deltas berührt; Main-Checkout/andere Worktrees unberührt; kein Push/Tag/Release/Deploy; kein Mainmerge |

Versionen (nach frischer Base-Prüfung bestätigt): `OCVM_VERSION 0.7.35`
(`opencode-vm.sh:290`), MCP-Adapter **0.1.44** (`package.json`,
`package-lock.json`, `ADAPTER_VERSION` in `src/types.ts`, Script-Pin
`opencode-vm.sh:47-50`), Skill **2026-10-12-r52** (Marker + `bundle.json`
revision + `latest.json`). Tags alle drei auf `v0.7.35` aligned; OpenLive- und
Hub-Archive **inhaltlich unverändert** (Pins unverändert, keine Neubauten).

## 2 Enthaltene Vertragserfüllung (Mapping zum geprüften Vertrag)

- **§13.1–13.4 Uhren/Anker/Evidenz/Budget** (`monitor.ts`, `monitor-engine.ts`):
  `investigation`-Zustand strikt je `worker_key`+`dispatch_receipt`-Episode;
  Anker = Creation-Fallback (`worker.created_at`), `anchor_source`
  creation/reconciled; Unbekannt-Zähler + Merge-Key-Decision
  `investigation-anchor-unknown`; Monitorfelder nur abgeleitete Projektionen
  (`refreshInvestigationProjections`, most-stale Worker maskiert nicht).
  Konfigfläche (C4): additive optionale `investigation`-Eingaben an bestehenden
  `create_monitor`/`update_monitor` (first/cooldown ≥60 s ≤7 d, Leiter exakt 3
  streng steigend, Budgets positiv mit dokumentierten Caps, `daily_budget` ≥
  ⌈86400/cooldown_s⌉; degeneriert → `INVALID_ARGUMENT`, nie geclamped); Defaults
  3600/3600/[7200,14400,28800]/300000/10/262144; **keine neue Autonomie**.
- **P5 vor No-op **und** Busy-Gate** (`runWake`, C1b): fällige Investigation ist
  die eine begrenzte Aktion des Wakes — read-only, null Sends; Ergebnisse
  `long_work_evidenced` (Leiter ab Investigations-**Ende**, Cap Stage 3) /
  `no_progress_evidenced` / `inconclusive` / `aborted_budget`; Cooldown ab Ende;
  **Investigation setzt nie `last_progress_at`**; A ausschließlich über
  receipt-korreliertes terminales Worker-Ergebnis (`observeWorkers`
  mark-complete → Stage 0 + T_first-Reanchor).
- **§13.5 Overrides:** Recovery aktiv hält die Due-Prüfung (clock hold);
  Reconciliation-Abschlüsse (recovery-continued, dispatch-reconciled,
  receipt-healthy) re-anchoren OHNE Progress-Reset und OHNE Stage-Rücksetzung.
- **§13.7 Observer:** Registry-only (`observe()` — null Gateway-Calls), Lease
  (TTL 15 s + Registry-Generation), Übergabe via bestehenden `wake_request`,
  stuck-own-claim als sichtbare `wake-claim-stuck`-Decision; keine
  Sends/Recovery/Release aus dem Observer; beobachtungsfähig während
  blockierendem Wake (Test im Block).
- **§13.8 Claim-Recovery (C1):** Claims tragen `owner_pid`/`owner_generation`;
  Boot-Sweep gibt nur frei bei **Heartbeat-Evidenz** (Claim-Generation ==
  Heartbeat-Generation **und** Heartbeat stale), vorheriger WAL/Receipt-Abgleich
  (`dispatch-reconciled`), unauflösbar → `dispatch-uncertain`-Park (nie stilles
  Freigeben); **A11b**: frischer Heartbeat der Owner-Generation wird nie
  freigegeben (möglicherweise lebende alte Engine); identitätslose Legacy-Claims
  nie auf Identitätsgrundlage freigegeben (PID ohne Generation ist keine
  hinreichende Prozessidentität); genau ein Sweep unter Registry-CAS vor der
  Wake-Loop (`monitor-main.ts`), keine parallele Recovery.
- **C2-Kette (Skill):** `communication-states.md` mit verified-hops-only
  (Engine-Decisions = On-Demand-Reads `get_monitor(_history)`; Attention
  ausschließlich aus Activity-Events; PROACTIVE_MONITORING nur mit benannter,
  verifizierter Webhook-Kette); sechs dedizierte Monitoring-Regressionsszeilen +
  Investigations-Zeile in `regression-scenarios.md`; `monitor-reporting.md`
  lernt die 0.7.35-Investigationszustände mit ehrlicher Nicht-Fortschritt-
  Formulierung; deutsche Voice/Text-Beispiele; **keine** neue
  Push-/Scheduler-Infrastruktur.
- **C6 Cross-Writer:** Hub **unberührt** (keine Hub-Datei im Diff,
  Hub-Archiv-Pin unverändert); Erhaltung durch
  `tests/hub_crosswriter_test.py` über den echten `hub/monitor.py`
  mutate/_valid_registry-Pfad belegt (byte-stabil inkl. Lease/Config).
- **Versions-/Release-Mechanik (RELEASING):** Doppelbuild MCP-Adapter
  byte-identisch (`cmp`), SHA-256 `c817debdccb9ce3e28f5318ddc539fe5d9996cb8549414a9087a70ec329e7e14`
  = Script-Pin; `bash -n` OK; `docs/CHANGELOG.md` neu (Seed 0.7.35);
  `docs/MCP-INTERFACE.md` additiver Vertragsabschnitt.

## 3 Dateiliste (exakt, `git diff --name-status b7aa264..HEAD`)

```text
M  adapters/mcp/package-lock.json
M  adapters/mcp/package.json
M  adapters/mcp/src/monitor-engine.ts
M  adapters/mcp/src/monitor-main.ts
M  adapters/mcp/src/monitor.test.ts
M  adapters/mcp/src/monitor.ts
M  adapters/mcp/src/tools.ts
M  adapters/mcp/src/types.ts
A  docs/CHANGELOG.md
M  docs/MCP-INTERFACE.md
M  integrations/chatgpt/bundle.json
M  integrations/chatgpt/latest.json
M  integrations/chatgpt/opencode-session-orchestrator.zip
M  integrations/chatgpt/opencode-session-orchestrator.zip.sha256
M  integrations/chatgpt/opencode-session-orchestrator/CHANGELOG.md
M  integrations/chatgpt/opencode-session-orchestrator/SKILL.md
A  integrations/chatgpt/opencode-session-orchestrator/references/communication-states.md
M  integrations/chatgpt/opencode-session-orchestrator/references/monitor-reporting.md
M  integrations/chatgpt/opencode-session-orchestrator/references/progress-activity.md
M  integrations/chatgpt/opencode-session-orchestrator/references/regression-scenarios.md
M  opencode-vm.sh
M  tests/chatgpt_skill_test.py
A  tests/hub_crosswriter_test.py
```

## 4 Testbelege (RUN — deterministische lokale Fixtures, keine Live-Faults; Stand KORRIGIERTER Kandidat)

| Suite | Ergebnis |
|---|---|
| `adapters/mcp` `npm test` (inkl. `tsc`-Build; 18 neue Investigations-/Claim-/Observer-Tests: 10 aus dem ersten Kandidaten + 8 QC-Regressionen F4, F1-Meilenstein, F1-Daily, F1-Checkpoint, F2-Timeout, F2-Bytes/Calls, Z1-Probe, Z1-Timeout) | **277 Tests: 275 pass / 0 fail / 2 skipped** (vorhandene Skips); `tsc --noEmit` clean |
| `tests/chatgpt_skill_test.py` | **87/87 OK** (r52 unverändert) |
| `tests/hub_crosswriter_test.py` (neu) | **6/6 ok, FAILURES: 0** (echter Hub-Mutate-Pfad) |
| `tests/monitor_service_test.sh` | **5× ok** |
| Doppelbuild MCP-Adapter | `cmp` byte-identisch; neuer Pin `c211da15…` |
| `bash -n opencode-vm.sh` | OK |

Während der Umsetzung gefundene und korrigierte Produktfehler (alle in-scope,
vor Kandidat gefixt und getestet): (a) `runInvestigation` gab den Wake-Claim
nicht frei (dauerhafte `skipped`-Falle) — Release+Reschedule eingebaut;
(b) Re-Anchor hing fälschlich am **normalen** Dispatch-Pfad (hätte T_first bei
aktiver Mission endlos verschoben) — auf Reconciliation-Abschlüsse begrenzt;
(c) Klammerfehler in der Inconclusive-Klassifikation (Worker-Aktiv-Check im
`some()`-Callback). QC-Fix-Runde: F1–F4/Z1 wie §0; dabei in Tests korrigierte
falsche Testerwartungen (Seed-Tick-Statuszähler, fake-epoch-Meilensteindaten,
Daily-Minimum ⌈86400/cooldown⌉, Tool-Delta-vor-Checkpoint-Isolation,
Blocked-Wait-Synchronisation) — keine Testschwächung: jede Korrektur richtet
die Erwartung an das geprüfte Vertragverhalten aus und beweist es.

## 5 Grenzen — NOT_RUN (ehrlich, nicht PASS)

- **Live-Verhalten** der Investigation/Observer/Claim-Sweep gegen echten
  Backend/VM: NOT_RUN (deterministische Fixtures; kein Eingriff in laufende
  Sessions/Monitore gemäß Auftrag).
- **Standalone-Installationspfad** für 0.1.44 (Download + SHA-Verifikation im
  Script): NOT_RUN — keine Veröffentlichung; Pin gegen Doppelbuild verifiziert.
- **Hub-Browser-Fixture** (`tests/hub_monitor_browser_test.mjs`): NOT_RUN
  (Playwright-Modul/Browser in dieser Session nicht lauffähig — dokumentierte
  Grenze aus be951293; Hub unverändert).
- **Reproduzierbare Rebuilds** OpenLive/Hub: NOT_RUN (Archive/Pins
  unverändert, kein Neubau nötig).
- **GitHub-CI** (`chatgpt-skill.yml`, `release.yml`): NOT_RUN (kein Push);
  lokale Suiten grün.
- **Hosted-ChatGPT-Import/-Verhalten** des r52-Skills: NOT_RUN (externe
  Abnahme, separat).
- `dashboard-bootstrap`-„packaged bootstrap": bekannter Port-/Timing-Flake
  (Präzedenz Journalfix-QC); isoliert in Main **und** Worktree je PASS; im
  finalen Volllauf 0 fails.

## 6 Übergabe

Nächster Schritt: **unabhängige Delta-QC** des korrigierten Kandidaten
(`d7765e8…`, Delta `960cb41..d7765e8` = 7 Dateien +782/−51) durch denselben
unabhängigen Reviewer — keine Selbstabnahme. Nach QC-PASS:
Integrationsentscheid + Cleanup-Entscheid für den Worktree (WORKTREES.md);
Veröffentlichung bleibt separat operatorseitig.
