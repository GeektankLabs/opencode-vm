# Task task_278d4136 — Monitor-Management-Journal „not a private regular file": Ursache, Fix, Tests, Paketplan

Status: IMPLEMENTED_READY_FOR_INDEPENDENT_QC (lokaler Kandidat, keine Main-Integration)

## 1. Bewiesene Ursache (vs. Hypothese)

Bewiesen aus Code und reproduzierbarem Verhalten:

- Die Fehlermeldung entsteht ausschließlich in `TaskManagementJournal.openRegular`
  (`adapters/mcp/src/management-journal.ts:391-402`). Sie feuert nur, wenn nach
  erfolgreichem `O_NOFOLLOW`-Open einer existierenden, regulären Datei einer von
  drei Bedingungen gilt: (a) `mode & 0o077 != 0`, (b) `uid != process.getuid()`,
  (c) `realpath(/proc/self/fd/N) != path`. Symlink/Nicht-Regulär-Fälle werfen
  bereits vorher andere Meldungen (`exists()`, Zeile 380-389).
- Alle unterstützten Writer erzeugen ausschließlich 0600-Dateien im Besitz des
  laufenden Users: `createInitialJournal` (O_CREAT|O_EXCL, 0600), `appendLine`
  (openRegular W), `writeHead` (0600-Tmp + rename). Der Monitor-Engine-Prozess
  läuft als derselbe User wie der Adapter mit `UMask=0077`
  (`opencode-vm.sh`, `start_monitor`). Ein umask kann keine Bits setzen —
  0600 kann durch umask niemals zu 0644 werden.
- Das Journalverzeichnis liegt unter `<project>/.opencode-vm/taskboard/`
  (virtiofs-Mount). Verifiziert in der laufenden Session-VM: alle 58
  Journale/Heads dieses Projekts sind `-rw------- lima lima`; der unterstützte
  Writer ist auf diesem Mount funktional (Smoke task_4ce92f38 green).
- Folglich kann eine Datei, die diesen Fehler auslöst, nicht vom unterstützten
  Journalwriter stammen. Der einzig konsistente Entstehungspfad: die Datei wurde
  außerhalb des Writers direkt erzeugt/verändert — plausibel per Shell-Umleitung
  eines Agenten mit Default-Umask 022 (→ 0644, erfüllt exakt Bedingung (a)).
- Die In-VM-Management-/Worker-Sessions haben den Tool-Namen
  `add_task_management_note` nicht (Adapter-Tools sind nur externen MCP-Clients
  zugänglich; In-VM-Opencode-Sessions erhalten nur Registry-MCPs). Der
  mgmt-v2-Priming-Text (`monitor-engine.ts`, `buildPrimingBlock`) fordert aber
  „journal checkpoints … current" halten, ohne den einzigen legalen Writer zu
  nennen. Ein gehorsamer In-VM-Agent erfüllt das Auftragswortlaut dann per
  direktem Dateischreib — Worker-Behauptungen („Journal geschrieben") sind
  Agenten-Claims, keine Tool-Receipts.

Evidenzgrenze: Die physischen Repro-Dateien der Projekte bi-mcrepo und
admin-in-the-loop liegen in fremden Host-Projektverzeichnissen und sind in
dieser VM nicht gemountet; ein physischer Nachweis von mode/uid der konkreten
Dateien task_14c21b4f…/task_c4fbb2a8… war nicht erreichbar. Die Ursachenkette
ist aus Code + gleichartiger Umgebung belegt; das konkrete 0644-Byte-Muster
der Fremddateien bleibt die einzige plausible, nicht physisch verifizierte
Schlussfolgerung. Kein OpenCode-Upstream-Bug behauptet.

## 2. Minimaler Fix

`adapters/mcp/src/monitor-engine.ts`:

- `PRIMING_CONTRACT` „mgmt-v2" → „mgmt-v3" (bewusster Contract-Bump; bestehende
  Monitor-Sessions erhalten den neuen Priming-Block einmalig).
- Priming-Zeile „Canonical context …": ergänzt die Journal-Writer-Regel:
  Einträge ausschließlich über die Board-Schnittstelle `add_task_management_note`;
  nie journal-dateien (create/edit/chmod/replace/delete) unter der
  management-journal-Directory per Shell oder Tool; sonst „persistence
  unverified" melden.

Keine Änderung an der Schutzprüfung selbst: Gates (Symlink, Typ, Mode, UID,
Ownership, Pfad) bleiben unverändert strikt; kein pauschales chmod, keine
Fehlermeldung weggepatcht.

## 3. Tests (RED/GREEN)

- RED: Mit Tests, ohne Fix (`monitor-engine.ts` auf Base zurückgesetzt):
  `dist/monitor.test.js` 3 FAIL (Priming-Tests 21/22/24 — neue Assertions auf
  die Writer-Regel und mgmt-v3).
- GREEN: `npm test` im Worktree: 257 pass / 0 fail / 2 skipped, zweimalig
  stabil; `tsc --noEmit` clean. Base (Main-Checkout): 258 pass / 0 fail —
  keine Regression.
- Neue Guard-Regression `taskboard.test.ts` „foreign-written journal files
  fail the private-file gate…": chmod 0644 auf ein gültiges Journal → read und
  append fail `TASK_MANAGEMENT_JOURNAL_ERROR`, Bytes unverändert; zurück auf
  0600 ist dasselbe, unveränderte Journal wieder lesbar. Dokumentiert:
  schädliche Typen/Symlinks (bestehende Tests) und private Rechte werden
  weiter abgewiesen, existierende gültige Journale bleiben lesbar.
- Priming-Budget bewusst von 5200 auf 5400 Zeichen rebaseliert (Regel-Zuwachs
  ~300 Zeichen; einmalig pro Digest, nie pro Tick).
- Umgebungshinweis: ein früherer Einzelrun zeigte einen Flake in
  `dashboard-bootstrap.test.js` (Port-/Timing-Konflikt), der auf Base und in
  allen Folgeläufen nicht reproduzierbar war — nicht durch diesen Fix bedingt.
- `tsc` war als Dev-Dependency verfügbar; keine separaten Tools nötig.

## 4. Bestehende beschädigte Journale

Von diesem Fix NICHT geheilt: bereits existierende Dateien mit 0644/fremder
Ownership bleiben lesbar-fehlgeschlagen (Gate unverändert). Sicherer,
dokumentierter Reparaturpfad für exakt task-eigene Daten (nicht ausgeführt):

1. Betroffenen Task/Session-Verkehr quiescen (kein Wake concurrently).
2. Metadaten prüfen: Task-ID, UID, Typ, mode der `<task>.jsonl` und
   `<task>.head.json` — verdächtige/Symlink/fremde Dateien nicht auto-übernehmen.
3. Wenn Bytes ein gültiges Journal sind (Besitzer = Runtime-User):
   `chmod 0600` auf beide Dateien, danach Lesbarkeit via
   `get_task_management_history` verifizieren.
4. Wenn Bytes ungültig/fremd: Datei beiseite verschieben (z. B.
   `<task>.jsonl.foreign-<date>`, 0600) — der unterstützte Writer erstellt ein
   sauberes Journal beim nächsten legalen Append; History-Verlust ehrlich melden.

## 5. Paket-/Versionsflächen und Konsolidierung mit controller-id-cleanup

- Adapter: `package.json`/`package-lock.json`/`src/types.ts ADAPTER_VERSION`
  0.1.42 → 0.1.43; Script-Pin `MCP_ADAPTER_VERSION="0.1.43"`.
- Script: `OCVM_VERSION` 0.7.31 → **0.7.33** (0.7.32 ist vom unabhängig
  QC_PASS Cleanup-Kandidaten `task/controller-id-cleanup`
  (Commit 01070210af58f4122d4c0374d500d6c273f7be3f) belegt; kein zweiter
  widersprüchlicher Pin).
- Kompatibilität: geänderte Dateien sind disjunkt (dieser Fix:
  monitor-engine.ts, monitor.test.ts, taskboard.test.ts, adapter-Versionen;
  Cleanup: opencode-vm.sh controller_id-Bereich, tests/provider_lifecycle_test.sh,
  OCVM_VERSION). Konsolidierung: Cleanup-Branch zuerst (0.7.32), dann dieser
  Branch — einziger Versionskonflikt ist OCVM_VERSION, dort 0.7.33 setzen.
- Release-Reihenfolge (später, nicht hier): MCP-Adapter-Archiv 0.1.43 bauen,
  SHA-256 ins Script-Pin übernehmen, unter `v0.7.33` publishen (RELEASING.md);
  bis dahin gilt der Fix für Source-Checkouts (bauen aus Source).
- Kombinierte Checks für die Konsolidierung: adapters/mcp `npm test` + `tsc`;
  `tests/provider_lifecycle_test.sh`; `tests/mcp_lock_test.sh` (macOS+Linux);
  shellcheck der geänderten Script-Regionen; ChatGPT-Skill-Konsistenz
  (`scripts/build-chatgpt-skill.py --check` + Skill-Test), falls Skill-Flächen
  berührt werden (hier: nein).

## 6. Exakte Artefakte

- Base: bdedc9a575ff1b4831b7cabbe0613d10600d2b47
- Branch: task/monitor-journal-writer-contract
- Worktree: .opencode-vm/worktrees/task_278d4136-8d7b-559b-80fe-3e9ae7282140
- Commit/Tree: siehe `git log -1` im Branch (nach Commit dieses Dokuments).
