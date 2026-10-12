Task-ID: task_e67c39cf-d674-5a80-9760-d84b11c5056d

# Integrations-Handback — Lokale Main-Integration Monitor-Paket (2026-10-12)

Status: **LOKAL INTEGRIERT + UNABHÄNGIG ABGENOMMEN + CLEANUP AUSGEFÜHRT (Abschluss 2026-10-12)**
Integrations-Gate: LOCAL_MAIN_INTEGRATION_PASS (registriertes
`…-integration-review-20261012.md`, SHA `3fa45b0145b17ca8db5b0035886f65661e9ea85effde3a444f03c1f2ed491b56`;
unabhängiges Original `ses_ed04c2e41ffe6196JY82WyZd2q` / `msg_13044e2e2001XuwpqpdosaWDBZ`).
Kein Push/Tag/Release/Publish/Deploy/Neustart/Live-Monitor-Eingriff.

## 0 Abschluss (finale Korrektur dieses Receipts)

- **Unabhängig geprüfte Integrationsbaseline ist `c426e287d9f020c0bfa1aa8787abd166399800e6`**
  (Tree `6431bb2039e55e8c9fae36602d9c88583e2d6754`) — nicht der spätere
  Dokument-Tip: diesem Receipt folgten ausschließlich task-eigene docs-only
  Sicherungscommits (zuletzt `78ef744` vor dieser Korrektur).
- **Unabhängige Integrationsprüfung:** LOCAL_MAIN_INTEGRATION_PASS —
  verifiziert exakt Main `c426e28`/Tree `6431bb20`, nur Mode-Restore `93a7c18`
  + Docs `c426e28` gegenüber `d7765e8`, Pin `c211da15…`, 14 isolierte Läufe
  mit 3 Gegenproben (12×278 pass/0 fail/2 skip; 2×277 pass/1 fail bekannter
  Dashboard-Flake); QC4-Teständerungen des Reviewers sind dauerhaft als
  Patch+Evidence gesichert (`planning/task-concepts/evidence-task_e67c39cf-qc4/`,
  Patch-SHA `64e06b25919153e8a7ee6d97cdb00bf747c567abdefa046c41942a0237972913`),
  eigener /tmp-Replay-Worktree sauber ohne Force entfernt.
- **Cleanup ausgeführt (2026-10-12):** Autoren-Worktree
  `.opencode-vm/worktrees/task_e67c39cf-…` über normales `git worktree remove`
  **ohne Force** entfernt (vorher sauber, vollständig integriert); Branch
  `task/monitor-progress-package` bleibt als erreichbare Historie erhalten.
  Fremde Worktrees/Dateien/Tasks unberührt; generische /tmp-Reste bewusst
  erhalten (teils unklare Ownership).
- Spätere Trennung: **Veröffentlichung (Push/Tag/Release) und Liveabnahme**
  bleiben separate, operatorseitige Schritte — durch die Integration nicht
  abgedeckt.

## 1 Exakte Identität (Vorher/Nachher)

| Feld | Vorher | Nachher |
|---|---|---|
| Main-HEAD | `b7aa2640aa328ee5705ffb51de2cbac10db0705a` | **Integrationsbaseline `c426e287d9f020c0bfa1aa8787abd166399800e6`** (geprüft); danach ausschließlich task-eigene docs-only Commits (siehe §0) |
| Main-Tree | `9e69a…` (Base-Baum) | direkt nach FF verifiziert (= `ba0e6ea8…`); RestORE-Chore/Docs-Commits ändern danach bewusst Mode/Docs |
| Integrationsart | — | **Fast-forward** `b7aa264..d7765e8` (`--ff-only`, kein Merge-Commit), danach 1 Restore-Chore-Commit + 1 Docs-Commit |
| Kandidat | `d7765e8e7303d7bb8cb45abb64e06fc64abd3169`, Tree `ba0e6ea83009e032e9a2d001f28f3dca33a0bc33` | exakt integriert (Tree des FF = Kandidaten-Baum; danach nur Mode-Restore + Docs) |
| Gate | QC_PASS laut registriertem `…-candidate-qc-20261012.md` (Addendum 2, Delta-QC d7765e8; unabhängiges Original `ses_ed04c2e41ffe6196JY82WyZd2q` / `msg_1302a767700155lZCPzbZmrxBv` — überlieferte Quelle, frisch gegen die registrierte Datei abgeglichen) | unverändert übernommen |
| Commits neu auf Main | — | `cb28047`, `9ed3411`, `960cb41`, `8fca026`, `d7765e8` (Kandidat), **`93a7c18`** (Exec-Bit-Restore), **`c426e28`** (dieses Receipt) = geprüfte Integrationsbaseline; danach task-eigene docs-only Commits |

Erhaltene Versionen/Pins: `OCVM_VERSION 0.7.35` (`opencode-vm.sh:290`),
MCP-Adapter **0.1.44** (`opencode-vm.sh:47-50`, `package.json`/lock,
`ADAPTER_VERSION`), Archiv-Pin **`c211da15ec452a3aed4bd6e49511884ae55a08747165e9fe8e4ed9bba4275236`**,
Tags `v0.7.35`, Skill **2026-10-12-r52** (bundle/latest/zip/sha256).

## 2 Integrationsdefekt + Restore (transparent)

Der Kandidat verlor das Executable-Bit von `opencode-vm.sh`
(`mode change 100755 => 100644`, sichtbar im FF-Diff; bekanntes recurring
Problem dieser Datei — Präzedenz-Chores `55d6044` und `338f26a` „restore
executable bit"). Wiederherstellung als eigener Chore-Commit **`93a7c18`**
(nur Mode, kein Inhalt). Das ist die eine Abweichung vom exakten
Kandidaten-Baum; sie stellt die Base-Eigenschaft wieder her und folgt dem
etablierten Verfahren. Die unabhängige Prüfung wird gebeten, genau diesen
Punkt zu verifizieren (Kandidat `d7765e8` trägt den Defekt; Main nach
`93a7c18` die korrekte Base-Eigenschaft).

## 3 Frische Vorab-Verifikation (vor Integration)

- Main-HEAD exakt `b7aa264` (unverändert seit Handoff); Kandidaten-Commit/
  Tree via `git cat-file`/`rev-parse` verifiziert; `merge-base --is-ancestor`
  ⇒ FF-fähig; `merge-base` = `b7aa264`.
- Worktree-Zustand: Autoren-Worktree sauber (0 Einträge); Review-Isolation
  lag bei der QC (dessen temporäre Clones laut QC-Bericht entfernt).
- Dirty-Überlappung: Main-Checkout trägt fremde Dirty-/Untracked-Deltas
  (`.opencode/tasks/*` anderer Tasks, `planning/`-Dokumente, RESUME-Dateien)
  — **keine** Überlappung mit den Kandidatenpfaden
  (`adapters/ docs/ integrations/ opencode-vm.sh tests/`); FF ohne
  Überschreiben möglich; kein Force verwendet; keine Konkurrenzarbeit aktiv.

## 4 Integrationschecks (RUN, auf integriertem Main)

| Check | Ergebnis |
|---|---|
| FF-Tree = Kandidaten-Tree (`rev-parse HEAD^{tree}` direkt nach FF) | `ba0e6ea8…` ✓ |
| Ancestry | `b7aa264` ⊆ `d7765e8` ⊆ `93a7c18` (linear) ✓ |
| `bash -n opencode-vm.sh` + Exec-Bit `-rwxr-xr-x` | OK ✓ |
| Adapter-Suite auf Main (`npm test`, inkl. Build) | **277 Tests / 275 pass / 0 fail / 2 skipped** (vorhandene Skips) ✓ |
| Gezielte Vertrags-Regressionen am integrierten Baum: **Z1** blocked-investigation mit echten billigen Probes (`Z1: observer probes persist…`), **Receipt-Wechsel** (`F4: reused worker…`), **persistierendes Budget** (`F1: daily budget…`) | je **pass 1 / fail 0** ✓ |
| `tests/chatgpt_skill_test.py` | **87/87 OK** ✓ |
| `tests/hub_crosswriter_test.py` | **6/6 ok, FAILURES: 0** ✓ |
| `tests/monitor_service_test.sh` | **5× ok** ✓ |
| Archive-Reproducibility auf Main: `build-mcp-adapter.sh` → `cmp` gegen Kandidaten-Build | **byte-identisch**, SHA `c211da15…` = Pin ✓ |
| Versionen/Pins im integrierten Baum | 0.7.35 / 0.1.44 / r52 / `c211da15…` ✓ |

**Dashboard-Bootstrap-Timingflake:** bekannt und historisch dokumentiert
(Präzedenz Journalfix-QC; isoliert stets grün). In DIESEM Integrationslauf
trat er **nicht** auf (Volllauf 0 fail); kein selektives Berichten — der
sporadische Charakter bleibt als bekannte Grenze bestehen.

## 5 Cleanup (AUSGEFÜHRT am 2026-10-12)

- Autoren-Worktree `.opencode-vm/worktrees/task_e67c39cf-d674-5a80-9760-d84b11c5056d`
  via normales `git worktree remove` **ohne Force** entfernt (vorher sauber,
  vollständig integriert); Branch `task/monitor-progress-package` bleibt als
  erreichbare Historie.
- Review-Isolation: bereits durch die QC selbst entfernt (kein Worktree
  vorhanden); generische /tmp-Reste bewusst erhalten (teils unklare Ownership).
- Fremde Worktrees (controller-id-cleanup, task_278d4136 ×2, task_efbe63cf):
  **nicht paketzugehörig, unberührt.**
- Task-eigene Dokumente/Evidence dauerhaft außerhalb von Worktrees gesichert
  (docs-only Sicherungscommit auf Main; Liste im Receipt-Text).

## 6 Gates (Abschlussstand)

1. Unabhängige **Integrationsprüfung**: PASS (§0) — erledigt.
2. **Cleanup**: erledigt (§5).
3. **Board-Abschluss**: Paket-Task `task_e67c39cf` und Konzept-Task
   `task_a234c341` zum Integrationszeitpunkt abgeschlossen (Board-Move in
   Phase 3; Historie in den Compact-Kontexten).
4. **Offen (bewusst separat)**: Push/Tag/Release/Publish/Deploy und
   Liveabnahme — operatorseitig, durch diesen Abschluss NICHT abgedeckt.
