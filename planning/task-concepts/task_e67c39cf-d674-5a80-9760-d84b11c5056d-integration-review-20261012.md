Task-ID: task_e67c39cf-d674-5a80-9760-d84b11c5056d

# Unabhängige Integrationsprüfung — lokaler Main-Merge des Pakets Monitor-Fortschrittsstrategie (2026-10-12)

Gate: **LOCAL_MAIN_INTEGRATION_PASS** — Main `c426e287d9f020c0bfa1aa8787abd166399800e6`
(Tree `6431bb2039e55e8c9fae36602d9c88583e2d6754`) ist die exakte, vollständige
Integration meines QC-PASS-Kandidaten `d7765e8` plus Mode-Restore plus
Integrationsdokument. Keine Produktänderung, kein Push/Tag/Release/Deploy/Restart/
Liveeingriff durch diese Prüfung.

## 1 Main-Identität und Ancestry (frisch verifiziert)

| Prüfung | Ergebnis |
|---|---|
| Main-HEAD | `c426e287d9f020c0bfa1aa8787abd166399800e6` ✓ (msg `1303f973…`-Kontext: Autororiginal in `ses_ed0961445ffeccdpXJugPcKgCT`) |
| Tree | `6431bb2039e55e8c9fae36602d9c88583e2d6754` ✓ |
| Basis | `b7aa264` unverändert; Kette `b7aa264 → … → 960cb41 → 8fca026 → d7765e8 → 93a7c18 → c426e28`, `d7765e8` (QC-PASS-Kandidat, Tree `ba0e6ea…`) ist Ancestor ✓ |
| FF-Charakter | `b7aa264..d7765e8` war Fast-Forward des Kandidaten (kein Merge-Commit, Commits unverändert) ✓ |
| Delta d7765e8→HEAD | **exakt 2 Dateien**: (a) `opencode-vm.sh` Mode 100644→100755 **0 Inhaltsbytes geändert** (beide Commits zeigen denselben Blob `dfbadc4432a268f7100443936d6ca0d99eedb889`, SHA `98ddc13c…` inhaltsgleich verifiziert); (b) neu: Integrations-Handback-Doc (+91 Z.) ✓ |
| `93a7c18` | reiner Exec-Bit-Restore, Präzedenz-konform (`55d6044`/`338f26a`); Head behält 100755 ✓ |
| Versionen/Pins | `OCVM_VERSION 0.7.35`, `MCP_ADAPTER_VERSION 0.1.44`, `MCP_ADAPTER_SHA256 c211da15…` (`opencode-vm.sh:47-50,290`), `adapters/mcp/package.json` 0.1.44 ✓ |

## 2 Reproduzierbarer Archivpin (RUN/PASS, Isolation)

Doppelbuild am Main (`scripts/build-mcp-adapter.sh` ×2, `/tmp/opencode`):
`cmp` **byte-identisch**, SHA-256 beider Bauten
`c211da15ec452a3aed4bd6e49511884ae55a08747165e9fe8e4ed9bba4275236` **= Script-Pin** ✓.

## 3 Isolierte Testläufe am exakten Main (eigene Detach-Isolation `/tmp/opencode/qc4-main`)

| Suite | Ergebnis |
|---|---|
| `adapters/mcp` `npm test` (inkl. 3 eigener QC4-Integrationsgegenproben) | **14 Vollläufe: 12× 278 pass / 0 fail / 2 skipped; 2× 277 pass / 1 fail** — der Fail ist **beide Male** der bekannte präexistente `dashboard-bootstrap`-Timing-Flake („packaged bootstrap uses real SDK GETs…"; identisch zur QC-Beobachtung, Test nicht im Paketdiff, Präzedenz Journalfix-QC). Alle paketrelevanten 278 Tests inkl. Gegenproben in **jedem** Lauf grün. |
| `tsc --noEmit` | clean |
| `tests/chatgpt_skill_test.py` | 87/87 OK |
| `tests/hub_crosswriter_test.py` | 6/6, FAILURES: 0 |
| `tests/monitor_service_test.sh` | 5× ok |
| `bash -n opencode-vm.sh` | OK |
| Skill-Bundle `--check` | OK (r52, Inventory/ZIP/Checksum konsistent) |

**Eigene QC4-Integrationsgegenproben (je 3× grün, im Volllauf enthalten):**
(1) **Echte Probes bei blockiertem Wake:** während real hängender Investigation
(`getSessionProgress` never-resolves, Claim belegt) führt `observe()` echte
Statusprobes aus, persistiert `observer-probe`-Evidence, gibt den Claim nie frei,
null Sends; nächster `tick()` = `skipped`; nach Release genau eine Untersuchung,
WAL unverändert (kein Doppeldispatch). (2) **Receiptwechsel:** verzögerte
Probe-Response nach Rebind auf neuen Receipt wird ignoriert (keine
Fehlzuordnung, Write-time-Guard). (3) **Persistentes Budget:** registry-
persistiertes 24-h-Fenster übersteht Engine-Restart ⇒ transparentes
`investigation-deferred`.

## 4 Dokumentationslücke (gekennzeichnet, kein Blocker)

Das registrierte Autorhandback
`planning/task-concepts/task_e67c39cf-…-integration-handback-20261012.md`
(SHA `9b45d131f9b05105a87fde9eddc43abba6013154845bec3ade3bf01816dafd5f`, role
concept_detail) wurde **vor** dem Receipt-Commit geschrieben und nennt als Tip noch
`93a7c18` — der tatsächliche finale Integrations-Tip ist **`c426e28`** (Tree
`6431bb2…`). Diese Lücke ist hiermit dokumentiert und der exakte aktuelle Tip in
diesem Bericht gesichert; eine Nachpflege des Autorhandbacks ist optional und
bleibt dem Autor/Operator überlassen (kein QC-Blocker: Main-Kette und Inhalt sind
unabhängig verifiziert).

## 5 Cleanup-Eignung und Review-Reste (nichts jetzt entfernt)

- **Autorworktree** `.opencode-vm/worktrees/task_e67c39cf-…` @
  `task/monitor-progress-package` @ `d7765e8`: **0 dirty/untracked Einträge**
  (verifiziert), Branch vollständig in Main integriert (Ancestor) ⇒ **sicher
  cleanup-fähig** nach `docs/WORKTREES.md` (Entscheidung operatorseitig; keine
  retained branches nötig — keine detachten Commits).
- **Eigene temporäre Review-Reste** (bewusst NICHT entfernt, Liste für Cleanup):
  - registriertes Git-Worktree `/tmp/opencode/qc4-main` (Detach @ c426e28; einzige
    Modifikation: meine angehängten QC4-Probetests in `adapters/mcp/src/monitor.test.ts`
    der Arbeitskopie — nicht committet) → später `git worktree remove`;
  - `/tmp/opencode/`: `mcp-{a,b,c,d,e,f}.tar`, `adapter-test.log`, `t1-6.log`,
    `q4r*.log`, `hist.out`, `bind/note/reg/list/get/qcreg.json` (MCP-Payloads);
  - frühere QC-Worktrees (qc/qc2/qc3) wurden bereits entfernt; `/tmp` ist
    session-ephemer.
- **Fremde Main-Dirty-Deltas und andere Worktrees:** unberührt (nur Lesezugriff);
  meine einzigen Primär-Checkout-Schreibungen sind die task-eigenen Berichte unter
  `planning/task-concepts/task_e67c39cf-…*.md` (untracked, außerhalb jeglicher
  Worktree-Sweep-Grenze).

## 6 Gate

**LOCAL_MAIN_INTEGRATION_PASS.** Der autorisierte lokale Main-Merge integriert
exakt den QC-geprüften Kandidaten; Mode-Restore ist bytidentisch belegt,
Archivpin reproduzierbar, alle paketrelevanten Suiten und die drei
Integrationsgegenproben (blockierter Wake, Receiptwechsel, persistentes Budget)
am Main grün; bekannter Dashboard-Flake transparent (2/14 Vollläufe, präexistent,
paketfremd). Veröffentlichung/Push/Tag bleibt separat operatorseitig.

## 7 Nachtrag — ausgeführte eigene Cleanup-Phase (2026-10-12, akzeptiert)

Seriell vor dem Autor-Cleanup wurde ausschließlich der eigene Review-Worktree
`/tmp/opencode/qc4-main` gesichert und entfernt — **vorher gesichert, nie
`--force`/`rm -rf`, nichts ungesichert verloren**:

1. **Dauerhafte Evidence** (primärer Checkout, außerhalb temporärer Worktrees,
   task-eigen, kein Produktcode-Commit auf Main):
   `planning/task-concepts/evidence-task_e67c39cf-qc4/` mit
   - `qc4-integration-probes.patch` (exakter eigener Test-Diff, +129 Z., 3 Tests;
     SHA256 `64e06b25919153e8a7ee6d97cdb00bf747c567abdefa046c41942a0237972913`),
   - `qc4-worktree-status-before-cleanup.txt` (vollständige Änderungsliste vor
     Cleanup: genau 1 Datei; SHA256 `01e2d41d2f0ea7018c76915f4cb893dd217596246d22c07046e678b5755d62a4`),
   - `qc4-evidence.md` (Test-/Buildbelege, Replay-Anleitung, Cleanup-Protokoll;
     SHA256 `016b84e6350677b5cc765412d2a80b911b769f419f7276c169f410f383d58a1d`).
2. **Wiederherstellbarkeit gegen den exakten geprüften Main `c426e28`:**
   `git restore` → Status leer → `git apply --check` OK → voller Replay
   (apply → tsc clean → QC4-Tests 3/3 pass → restore); rekonstruierter Diff
   SHA-identisch zum gesicherten Patch (Roundtrip bewiesen).
3. **Bereinigung:** eigene Teständerung via normalem `git restore` entfernt
   (danach 0 Einträge), Worktree via `git worktree remove` **ohne Force** +
   `prune` entfernt; keine Worktree-Metadaten-Reste.
4. **Statusbelege nach Cleanup:** Main unverändert `c426e287…` / Tree
   `6431bb203…`; `git worktree list` zeigt nur noch Primary + 5 Projekt-Worktrees
   (Autor-Worktree `task_e67c39cf…` @ `d7765e8` unverändert, weiterhin sauber und
   cleanup-fähig für die Autor-Phase; 4 Fremdworktrees unberührt).
5. **Verbleibende Reste (bewusst erhalten, unklare/fremde Ownership):** generische
   `/tmp/opencode`-Dateien (`mcp-*.tar`, Logs, JSON-Payloads, fremde
   Sessiondateien) — kein pauschaler Sweep; `/tmp` ist session-ephemer.

Gate unverändert: **LOCAL_MAIN_INTEGRATION_PASS**; Cleanup der eigene Review-Rest
abgeschlossen. Kein Board-Done, keine Sessionarchivierung, kein Push/Tag/Release/
Deploy/Restart.
