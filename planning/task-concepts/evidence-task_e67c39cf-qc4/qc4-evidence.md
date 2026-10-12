Task-ID: task_e67c39cf-d674-5a80-9760-d84b11c5056d

# QC4-Evidence — gesicherte eigene Integrationsgegenproben + Test-/Buildbelege (2026-10-12)

Status: dauerhaft gesichert **vor** dem Aufräumen des temporären Review-Worktrees
`/tmp/opencode/qc4-main` (Detach @ Main `c426e287d9f020c0bfa1aa8787abd166399800e6`).
Dieser Evidence-Bereich liegt im primären Checkout außerhalb jeglicher
temporären/zu entfernender Worktrees. Kein Produktcode-Commit auf Main; Main
unverändert.

## Gesicherte Dateien

| Datei | SHA256 | Inhalt |
|---|---|---|
| `qc4-integration-probes.patch` | `64e06b25919153e8a7ee6d97cdb00bf747c567abdefa046c41942a0237972913` | Der exakte uncommittete eigene Test-Diff (einzige Änderung des Review-Worktrees): +129 Zeilen, 3 `test()`-Blöcke in `adapters/mcp/src/monitor.test.ts` |
| `qc4-worktree-status-before-cleanup.txt` | `01e2d41d2f0ea7018c76915f4cb893dd217596246d22c07046e678b5755d62a4` | Vollständiger `git status --short` des Worktrees vor Cleanup: genau ` M adapters/mcp/src/monitor.test.ts`, nichts anderes |
| `qc4-evidence.md` | dieses Dokument | Test-/Buildbelege, Replay-Anleitung, Cleanup-Protokoll |

## Inhalt der Gegenproben (3 Tests, Präfix `QC4:`)

1. **Z1 blockierter Wake:** während real hängender Investigation (`getSessionProgress`
   never-resolves, Claim belegt) führt `observe()` echte Statusprobes aus,
   persistiert `observer-probe`-Evidence, gibt den Claim nie frei, null Sends;
   nächster `tick()` = `skipped`; nach Release genau eine Untersuchung, WAL
   unverändert (kein Doppeldispatch).
2. **Receiptwechsel:** verzögerte Probe-Response nach Rebind auf neuen Receipt wird
   ignoriert (keine Fehlzuordnung; Write-time-Guard).
3. **Persistentes Tagesbudget:** registry-persistiertes 24-h-Fenster übersteht
   Engine-Restart ⇒ transparentes `investigation-deferred`.

## Test-/Buildbelege (alle am exakten Main c426e28, Isolation qc4-main)

- `npm test` (inkl. der 3 Gegenproben): **14 Vollläufe — 12× 278 pass / 0 fail /
  2 skipped; 2× 277 pass / 1 fail**; beide Fails sind der bekannte präexistente
  `dashboard-bootstrap`-Timing-Flake („packaged bootstrap uses real SDK GETs…",
  nicht im Paketdiff, Präzedenz Journalfix-QC). Paketrelevante 278 Tests in jedem
  Lauf grün; Gegenproben allein zusätzlich 3× stabil grün
  (`node --test --test-name-pattern QC4`).
- `tsc --noEmit` clean; Skill 87/87; Crosswriter 6/6 (FAILURES: 0); Service 5× ok;
  `bash -n` OK; Bundle `--check` OK.
- Doppelbuild Adapter: `cmp` byte-identisch, SHA `c211da15ec452a3aed4bd6e49511884ae55a08747165e9fe8e4ed9bba4275236` = Script-Pin.

## Replay-Anleitung (Wiederherstellbarkeit)

```bash
git worktree add --detach /tmp/<dir> c426e287d9f020c0bfa1aa8787abd166399800e6
cd /tmp/<dir>/adapters/mcp && npm ci --no-audit --no-fund
git apply planning/task-concepts/evidence-task_e67c39cf-qc4/qc4-integration-probes.patch
npx tsc -p tsconfig.json
node --test --test-name-pattern "QC4" dist/monitor.test.js   # erwartete 3/3 pass
```

Wiederherstellbarkeit wurde vor dem Cleanup am exakten Main-Baum verifiziert
(`git apply --check` OK; voller Replay inkl. Testlauf grün, danach wieder
zurückgeräumt — siehe Cleanup-Protokoll unten).

## Cleanup-Protokoll (seriell, kein Force, kein Datenverlust)

1. Evidence-Patch + Status gesichert (Hashes oben/unten).
2. Replay-Verifikation am sauber wiederhergestellten Baum (apply → 3/3 pass → restore).
3. Eigene Teständerung über `git restore adapters/mcp/src/monitor.test.ts`
   bereinigt; danach `git status --short` leer.
4. `git worktree remove /tmp/opencode/qc4-main` (ohne `--force`), danach
   `git worktree prune`; `git worktree list` enthält den Worktree nicht mehr.
5. Main `c426e28…` / Tree `6431bb20…` unverändert; Autor-/Fremdworktrees unberührt.
6. Generische `/tmp/opencode`-Dateien mit unklarer Ownership (Tars, Logs fremder
   Sessions, JSON-Payloads) bleiben bewusst erhalten — kein pauschaler Sweep.

## Verbleibende Reste (bewusst nicht entfernt)

- `/tmp/opencode/`: `mcp-{a..f}.tar`, `adapter-test.log`, `t1-6.log`, `q4r*.log`,
  `hist.out`, `bind/note/reg/list/get/qcreg/intreg.json` sowie fremde Sessiondateien
  (`anchor-debug.mjs`, `comb-*.log`, `fin-*.log`, …) — `/tmp` ist session-ephemer.
- Keine weiteren registrierten Review-Worktrees dieses Task (qc/qc2/qc3 wurden
  bereits in früheren Phasen entfernt).

## Ausführungsbestätigung (2026-10-12, nach Durchlauf)

- Replay-Verifikation: `git apply --check` OK; voller Replay auf sauberem Baum
  (apply → tsc clean → QC4-Tests **3/3 pass** → restore). Der aus dem Patch
  rekonstruierte Diff ist SHA-identisch zum gesicherten Patch
  (`64e06b25…`, Roundtrip bewiesen).
- Cleanup ausgeführt: `git restore` (danach Status leer), `git worktree remove`
  **ohne Force** + `prune`; `git worktree list` enthält `/tmp/opencode/qc4-main`
  nicht mehr, kein Worktree-Metadaten-Rest.
- Main nach Cleanup unverändert: `c426e287…` / Tree `6431bb203…`; Autor- und
  Fremdworktrees unverändert (Liste im Integrationsreview).
