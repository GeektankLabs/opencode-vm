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
- Die Standard-In-VM-Sessions erhalten den Tool-Namen
  `add_task_management_note` nicht über die Registry-MCPs (Adapter-Tools sind
  primär externe MCP-Clients). Einschränkung (QC F3): Konfigurationen wie
  ocvm-self können In-VM-Sessions sehr wohl Zugriff auf die Board-Tools
  verschaffen — „in-VM nie verfügbar" ist keine gültige Allgemeinheit. Der
  mgmt-v2-Priming-Text (`monitor-engine.ts`, `buildPrimingBlock`) forderte
  „journal checkpoints … current" halten, ohne den einzigen legalen Writer zu
  nennen; für Sessions ohne Tool-Zugang blieb nur der direkte Dateipfad als
  scheinbare Erfüllung — Worker-Behauptungen („Journal geschrieben") sind
  Agenten-Claims, keine Tool-Receipts.

Evidenzgrenze (QC F2-Korrektur, präzisiert): Die physischen Repro-Dateien der
Projekte bi-mcrepo und admin-in-the-loop liegen in fremden Host-Projekt-
verzeichnissen und sind in dieser VM nicht gemountet; die tatsächlichen
mode/uid-Werte der konkreten Dateien task_14c21b4f…/task_c4fbb2a8… konnten
nicht physisch verifiziert werden. Belegt ist: (a) die exakten Fehlerbedingungen
aus dem Code, (b) dass kein unterstützter Writer solche Dateien erzeugen kann,
(c) eine lokal getreue Repro des Fehlerbilds aus dem Codepfad. Ein späteres
chmod oder Fremdersatz durch Dritte ist damit nicht ausgeschlossen. Die
direkte Fremderzeugung (plausibel Shell-Umleitung, umask 022 → 0644) ist
damit eine **plausible, lokal reproduzierte Repro**, nicht die bewiesene
Produktionsursache der konkreten Vorfälle. Kein OpenCode-Upstream-Bug
behauptet. Die Instruktionstests beweisen die Vertragsauslieferung im
Priming-Text, keine Agent-Compliance im Betrieb.

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

### 5a. Ursprünglicher Einzelkandidat (unverändert erhalten)

- Branch `task/monitor-journal-writer-contract`, Tip 338f26a0e25330e516e20addea8632d985b2e559,
  Worktree `.opencode-vm/worktrees/task_278d4136-8d7b-559b-80fe-3e9ae7282140`.
- Bekannter Mainblocker (QC F1 major, behoben in 5b): VERSION 0.1.43, aber
  FILENAME/SHA256/TAGs standen noch auf 0.1.42/v0.7.31 — RELEASING.md Schritt 4
  verletzt; release.yml metadata-Asserts würden failen.
- Adapter: `package.json`/`package-lock.json`/`src/types.ts ADAPTER_VERSION`
  0.1.42 → 0.1.43; Script-Pin `MCP_ADAPTER_VERSION="0.1.43"`.
- `OCVM_VERSION` 0.7.31 → **0.7.33** (0.7.32 ist vom unabhängig QC_PASS
  Cleanup-Kandidaten belegt; kein zweiter widersprüchlicher Pin).

### 5b. Konsolidierter Paketkandidat (dieser Stand, autorisiert)

Konsolidierung: Cleanup-Commit 01070210af58f4122d4c0374d500d6c273f7be3f als
Parent übernommen, Journal-Fix als Cherry-Picks darauf; einziger Konflikt
`OCVM_VERSION` semantisch aufgelöst → 0.7.33 (von QC vorab geprüfte
Entscheidung, kein blind ours/theirs). Original-Branches/Worktrees und
QC-Belege unverändert; neuer eindeutig getaggter Worktree/Branch.

Paket-Fix (F1): `MCP_ADAPTER_FILENAME="opencode-vm-mcp-adapter-0.1.43.tar"`,
`MCP_ADAPTER_SHA256="52f405716fb6e0d2d6575d1f95da9da52c9309b23b982b4fcdcf4ed0f43425ff"`,
alle drei Asset-Tags (`OPENLIVE_ADAPTER_TAG`, `MCP_ADAPTER_TAG`, `HUB_ASSET_TAG`)
auf `v0.7.33` gemäß RELEASING.md Schritt 2. OpenLive 0.1.7 und Hub unverändert
(Filename/Hash bestehende Pins, reproduzierbar bestätigt). Keine CI-Assert-
Abschwächung, keine Versionsausnahme: 0.7.33 ist die nächste freie Patch-Version
nach dem belegten 0.7.32.

Doppelbuild-Nachweis (deterministisch, GNU tar 1.35, SOURCE_DATE_EPOCH-Default):
- mcp-a.tar == mcp-b.tar, SHA-256 52f405716fb6e0d2d6575d1f95da9da52c9309b23b982b4fcdcf4ed0f43425ff
  (= Script-Pin), Archivname opencode-vm-mcp-adapter-0.1.43.tar
- ol-a.tar == ol-b.tar, SHA-256 39a50c5127b0a577b54e4790b5c3c1f463b35a52b42c4343aa639dcea53bad47
  (= bestehender Pin)
- hub-a.tar == hub-b.tar, SHA-256 deaf12ef80599cd5fb603f0ab5491e799adc47a01ce7597cde19f8a494224368
  (= bestehender Pin)

Version-/Tag-Metadaten als Dateiangaben (keine tatsächlichen Git-Tag-Writes,
kein Push/Release): Release-Tag-Feld v0.7.33 in allen drei Tag-Pins; Git-Tags
werden ausschließlich vom Release-Workflow nach Validierung erzeugt.

Validierung des konsolidierten Kandidaten (RELEASING.md-Liste vollständig):
- adapters/openlive-acp: check/build/test 47/0, test:integration PASS
- adapters/mcp: check (tsc) PASS, test 257 pass / 0 fail / 2 skipped, test:integration PASS
- tests/provider_lifecycle_test.sh (26 Lifecycle-Tests inkl. Cleanup-Fix): 26 ok / 0 fail
- tests/release_metadata_test.py: 5/5 OK; tests/release_state_test.py: 5/5 OK
- bash -n (7 Dateien) OK; shellcheck --severity=error (7 Dateien) OK
- tests/hub_release_test.sh PASS; tests/mcp_adapter_test.sh PASS (Standalone-
  Install-/Metadata-Pfad); tests/mcp_lock_test.sh PASS (Linux; macOS-Bash-3.2-Job
  bleibt CI); tests/openlive_test.sh PASS (nach Working-Copy-chmod 755; Index-
  Mode war korrekt 100755, virtiofs-Schreibartifact)
- actionlint release.yml OK (actionlint 1.7.7)
- scripts/build-chatgpt-skill.py --check OK (r51); python3 -B tests/chatgpt_skill_test.py OK
- git diff --check OK
- UNVERIFIED bleibt: echter GitHub-Release-Run/Assets (Operator-push-abhängig),
  macOS-nativer Bash-3.2-Lock-Job, gehostete ChatGPT/Voice-Akzeptanz.

### 5c. Nächster Mainintegrationsweg

1. Erneute unabhängige QC genau auf diesem konsolidierten Kandidaten (separat).
2. Operator pusht den exakten Kandidaten-Commit nach `main` (host-seitig);
   Release-Workflow erstellt Tag v0.7.33 und published die fünf Assets.
3. Release-Completion-Gate gemäß RELEASING.md gegen exakt diesen Commit prüfen.
4. Ausgeschlossen: Fremddeltas jenseits Cleanup+Journal (keine weiteren
   Änderungen enthalten; `.opencode/tasks/`-Main-Dirty bleibt unberührt).

## 6. Exakte Artefakte

- Base: bdedc9a575ff1b4831b7cabbe0613d10600d2b47
- Branch (konsolidiert): task/monitor-journal-package-consolidated
- Worktree (konsolidiert): .opencode-vm/worktrees/task_278d4136-consolidated-20261012-main
- Commit-Kette: 01070210 (Cleanup, unverändert übernommen) → 09c7348 (Journal-Fix,
  Cherry-Pick mit OCVM_VERSION-Konfliktlösung 0.7.33) → 55d6044 (exec-bit) →
  finaler Paketcommit (siehe `git log -1`).
- Ursprünglicher Journal-Kandidat: task/monitor-journal-writer-contract,
  Tip 338f26a0e25330e516e20addea8632d985b2e559 (unverändert erhalten).
