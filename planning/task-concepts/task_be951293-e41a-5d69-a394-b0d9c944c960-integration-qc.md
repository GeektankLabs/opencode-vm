Task-ID: task_be951293-e41a-5d69-a394-b0d9c944c960
Titel: Unabhängige Integrations-QC — LOKALE Mainintegration (kein Release/Push/Deploy)
Stand: 2026-10-10 · Prüfer: unabhängige QC-Session (GLM5.3 high) · Basis `8936f621f86e4ff96b69bcc8c849a996d8ba26c0` · GESAMT-QC_PASS-Kandidat `65e73c6040be5a7b148f02b7ea9bcee2ceaf26f2`

## Ergebnis: QC_PASS (lokale Integration; Versionsschritt/Release/Deploy ausdrücklich separat)

## Kandidat exakt verifiziert (OIDs/Tree/Ancestry)

- **main = `13eea5026943f6e618c8213289b73517bacd9462`**, Tree `5c8ad4762d1b4fae0826ef27dfbee482a42dfe8f`, Parent `65e73c6040be5a7b148f02b7ea9bcee2ceaf26f2` — Reflog belegt Fast-forward 8936f62→65e73c6 (10:09:08 +0200) + Doku-Commit 13eea50 (10:16:23); `8936f621` ist Vorfahr; `13eea50` ist **dokumentationseinzig** (nur Concept-Plan + Compact, +94/−11 — kein Code/Test) ✓.
- **origin/main = `33528bb7639e353ea2841d032f0431cc212d5d40` unverändert** (Vorfahr von main; kein Push/Tag erfolgt; Remote reachable-Definition nur lesend geprüft) ✓.
- Versionen bewusst unverändert: `opencode-vm.sh:290 OCVM_VERSION 0.7.30`, `adapters/mcp/package.json 0.1.41` ✓ (EFBE-Präzedenz; RELEASING-Flow bleibt separater Auftrag).

## Widerspruch 978f5f9 transparent geklärt

`978f5f9` ist **kein gültiges Objekt** im Repository (`git cat-file -t` → fatal; Reflog von main enthält es nicht). Die atomare Historie kennt nur 8936f62 → FF 65e73c6 → 13eea50. Der Widerruf („veraltetes 978f5f9-Lesen zu Sitzungsbeginn, durch Reflog widerlegt") ist damit konsistent; maßgeblich ist ausschließlich die aktuelle Git-Evidenz. Kein ungeprüfter Nachvollzug des Anfangsreports.

## Fremdhalte-Backup und Dirty-Behauptung belastbar

- Backup `.opencode-vm/integration-backups/be951293-mainintegration-20261010/`: beide Dateien hashgenau laut `BACKUP-SHA256.txt` verifiziert — `compact.preintegration-8936f621.md` = `25f9a381f0ba…17e4a1176e`, `concept-plan…md` = `94ea1da08907…8d68a8be62` ✓. Inhaltlich sind es die Pre-Go-Vorläufer (79/404 Zeilen), deren Inhalt in den offiziellen committierten Versionen (267/744 Zeilen) aufgegangen ist ✓.
- **92→90-Behauptung:** aktueller Status exakt **90 Einträge** (76 untracked + 14 modified). Die einzigen verbliebenen be951293-Dirty-Einträge sind die fünf QC-Berichte des Reviewers (unverändert erhalten). Schnittmenge Branch-Diff (17 Dateien) ∩ modifizierte Tracked-Dirty-Dateien = **0** — der Fast-forward hat keine fremde Dirty-Datei angefasst; bitgleicher Erhalt aller 90 ist durch Git-Checkout-Semantik strukturell garantiert und stimmt mit dem Befund überein ✓.

## Unabhängig reproduzierte Tests — exakt main `13eea50` im sauberen Test-Worktree (/tmp/opencode/be951293-intqc, npm ci, clean)

tsc/build ok · `node --test dist/monitor.test.js` **46/46** · `dist/agent-control.test.js` **14/14** · `npm test` **248 pass / 0 fail / 2 skip** · `PYTHONPATH=. python3 -B tests/hub_test.py` **45 OK** · `agent_control_test.py` **57 OK** · Browser-Fixture **19/19** · `tests/monitor_service_test.sh` **5× ok, Exit 0** — alle Autorenzahlen (msg_124e3e413001nYRoNjg1fgXDZK) exakt bestätigt; Primary-Checkout wurde für Tests nicht benutzt.

## Persistenz-Downgrade unabhängig geprüft (isolierte Fixture, kein Live-Zugriff)

Eigene Temp-Worktree `8936f621` (gebaut: alter TS-Adapter + altes `hub/monitor.py`):
- **Alter TS-Writer:** liest Registry mit `recovery_episode`/`recovery_resolution`/`last_error`; Mutation (Worker-Reuse) erhält alle drei Felder **byte-gleich**; `last_error` bleibt beim Reuse stehen — erwartete Downgradegrenze (F1-Fix existiert im alten Stand nicht), dokumentiert, **kein Datenverlust**.
- **Alter Python-Writer (hub/monitor.py 8936f621):** `snapshot` liest alle neuen Felder; `mutate` (Scheduler-Update + History) erhält sie byte-gleich in der Datei.
- **Gegenrichtung:** neuer Reader auf altgeschriebener Registry — Felder intakt.
- **UI/API-Grenze:** altes `hub/server.py` hat die `/log`-Route nicht (0 Treffer) — Diagnoseansanke erst ab neuem Stand; Rollback-Anker `8936f621` über gezieltes Revert (hartes Reset des Primary wegen 90 fremder Dirty-Einträge ungeeignet — Bewertung teile ich).

## REMOTE_POLICY_COMMAND_INVALID (zwei abgelehnte Dokuaufrufe)

Exakte Tool-Belege der Autorseite sind aus dieser QC-Session **nicht zugreifbar** (Sitzungsanteile hostseitig, hier nicht exponiert) — die Behauptung ist nicht einzeln verifizierbar, aber plausibel und ersthand kongruent: dieselbe Policy hat in der Rev2-Review-Session einen eigenen Heredoc-Append dieses Reviewers mit identischem Fehler abgelehnt; ein Umgehungsvorwurf ist nicht begründet — die Enddokumente liegen regulär im Git-Commit (verifiziert), nicht über einen blockierten Pfad. Keine eigene Umgehung versucht; keine Berechtigungsablehnung gegen diese QC aufgetreten (hätte sofort als Blocker gemeldet werden müssen).

## Quellgrenzen / Grenzen der Prüfung

Nur read-only Git-/Dateiprüfungen + isolierte /tmp-Fixtures; kein Live-Registryzugriff, keine Produkt-/Main-Änderung, kein Push/Tag/Release/Deploy/Restart; Live-AITL/Hardware weiter außerhalb Scope. Beide QC-Worktrees nach Prüfung entfernt (`git worktree list` wieder Ausgangsstand).

## Schluss

Lokale Mainintegration `13eea50` ist exakt, reversibel dokumentiert (Backup + Revert-Anker), fremdschonend (90 Dirty bit-gleich, strukturell belegt), vollständig getestet (alle Zahlen unabhängig reproduziert) und in beiden Persistenzrichtungen downgrade-sicher. **INTEGRATIONS-QC: QC_PASS** — als lokale Integration; Release-Flow (Versionsschritt), Hardware-/Session-Abnahme und optionaler AITL-Livebeweis bleiben separate, ausdrücklich zu erteilende Schritte.
