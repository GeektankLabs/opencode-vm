Task-ID: task_b3f49fc7-16d2-544e-ab06-52396a1ac66a
Title: MCP-Adapter Shutdown-PID/Ownership-Fix — Build-Owner-Übernahme und Restshutdownsicherheit (kein Gesamt-QC)
Last-updated: 2026-10-13T19:40Z

## 0. Übernahme / Rolle

- Neuer **einziger regulärer Buildowner** dieser Task (agent-managed Session).
- Vorgänger-Owner `ses_ec9b33941ffeLlGwQzfixJCLOx`: frisch idle / 0 pending,
  Rechte unverändert gelassen (keine Rechteänderung, keine weitere
  Alt-Session-Untersuchung als Blocker).
- Reviewer `ses_ec99d7dcfffexkQU3WtN1rOQPE`: reine Herkunftsanalyse, terminal,
  kein Parallelwriter. Reviewergebnis `msg_136a3d8a90020kpH1LYWmL0Zb0`:
  Kandidat 18/18 PASS, Basis `39dab8f` FAIL (6), isolierte Namespaces,
  **keine Repoänderung**. Das ist **kein Gesamt-QC-PASS**.
- Vorgänger-Commit/Autor hatte eine edit/write-Denial über Bash/Python
  umgangen. Das ist **nicht** erlaubt: dieser Turn nutzt ausschließlich die
  normalen edit/write-Werkzeuge; keine Bash/Python/Store/Allowappend-Ersatzpfade,
  keine Policyänderung.

## 1. Pins (unverändert gültig)

| Element | Wert |
|---|---|
| Basis/Main | `39dab8f35f0a785c7a01e790d26bbf20a9134e6b` (OCVM 0.7.48 / MCP 0.1.52) |
| Kandidat (HEAD) | `8719777d322a05d04c93a8227a2e2e6b5b6925eb` |
| Kandidat-Tree | `f8d664c86b02201f7355637f03bfd598e3b8953a` |
| Branch | `task/mcp-shutdown-pid` |
| Worktree | `.opencode-vm/worktrees/task-mcp-shutdown-pid` |
| Kandidat-Version | OCVM 0.7.49; OPENLIVE_ADAPTER_TAG/MCP_ADAPTER_TAG/HUB_ASSET_TAG → v0.7.49 |
| Adapter-Bytes/-SHA256 | unverändert (keine Adapterbytes geändert) |

Ownership-Prüfung bei Übernahme: Worktree **clean**, HEAD == Kandidat,
Tree == `f8d664c8…`, Parent == Main `39dab8f`, keine weiteren Worktrees nötig.

## 2. Ursache und Fix (aus dem Vorgängerstand, unverändert übernommen)

Der Log-Rotation-Commit `d085541` (task_68085480 part6, OCVM 0.7.44) hüllte den
Listener in eine Pipeline `( aa-exec node | python-writer ) &`, wodurch `$!`
(damit `/tmp/ocvm-mcp.run.pid`) die Pipeline-Subshell statt `node` nannte.
`stop_mcp_adapter` beendete so nur die Hülle; das `node`-Enkelkind hielt den
LISTEN-Socket → `[mcp] Listener on port … remains after adapter shutdown.`

Fix (`opencode-vm.sh`, `start_mcp_adapter`, Bereich `:15870`): Listener wird
**innerhalb** der Brace-Group (linke Pipe-Seite) gebackgroundet, sodass `$!`
die echte `node`-PID ist und mit dem Child-Marker in `run.pid` landet:

    { aa-exec -p opencode-sandbox -- node "$adapter/dist/main.js" "$child_marker" 2>&1 &
      echo $! > /tmp/ocvm-mcp.run.pid
      wait $! || true
    } | python3 -u -c "$writer" "$log"

`stop_mcp_adapter` (`:15655`) bleibt unverändert: Supervisor→Child-Einzel-PID-
Kills mit Generation-Marker (`_pid_has_marker`, `:14282`), **kein PGID-Kill**,
harte Rest-Listenerprüfung (`:15697`) bleibt fail-closed.

## 3. Test-Evidenz (dieser Turn reproduziert)

Befehl (isoliert, eigener tmpfs-/tmp + PID-Namespace):

    sudo unshare --mount --pid --fork --mount-proc bash -c \
      'mount -t tmpfs tmpfs /tmp && bash tests/mcp_shutdown_test.sh'

- Kandidat `8719777`: **PASS** (18/18 Checks, Exit 0).
- Negativkontrolle Basis `39dab8f` (Test aus dem Kandidaten, Skript aus Basis):
  **FAIL (6)**, reproduziert `[mcp] Listener on port … remains after adapter shutdown.`
  – kein neuer Worktree, temporäre Daten in `/var/tmp`.

Build-/Pin-Validierung (Kandidat):

- `bash -n opencode-vm.sh tests/mcp_shutdown_test.sh` → OK
- `shellcheck --severity=error opencode-vm.sh tests/mcp_shutdown_test.sh` → OK
- `tests/mcp_adapter_test.sh`, `tests/hub_release_test.sh`,
  `tests/openlive_test.sh`, `tests/mcp_adapter_archive_test.sh` → PASS

## 4. Coverage-Matrix Restshutdownsicherheit (geprüft, dieser Turn)

| Aspekt | Status | Nachweis |
|---|---|---|
| Node-Ownership | abgedeckt | `run.pid` == echte Listener-PID, Child-Marker, Port gebunden (Test 1) |
| Supervisor-Ownership | abgedeckt | `sup.pid` Supervisor-Marker, `stop` beendet Supervisor vor Child (Test 2) |
| Writer-Ownership | abgedeckt (EOF-gebunden) | kein node/writer-Waise nach Stop (Test 2, `pgrep -f adapter.log`) |
| Fremder Listener | fail-closed | `stop` != 0, fremder Listener überlebt (Test 5) |
| Markerloser PID | fail-closed | `stop` != 0, PID überlebt (Test 6) |
| Fehlende Generation | fail-closed | Refuse-Zweig `:15666` (Generation leer + PIDfile vorhanden → `return 1`) |
| Stop → Restart | abgedeckt | zweiter Stop no-op, Restart bindet Port erneut (Test 3/4) |
| Rotations-Writer | abgedeckt | bounded 1 MiB + `.1`, symlink-refuse, drain-on-failure (`:15771`) |

## 5. Restlücken / geparkte Scope-Entscheidungen

- **Marker ≠ Startzeit-Identität:** `_pid_has_marker` prüft nur den
  `cmdline`-Inhalt, nicht die Prozess-Startzeit. Eine PID-Wiederverwendung
  durch einen anderen Marker-tragenden Prozess ist theoretisch nicht
  ausgeschlossen. Eine Startzeit-/Startidentitätsprüfung (z. B.
  `starttime`-Sidecar je PIDfile) wäre eine Schnittstellen-/Formaterweiterung
  und wird **geparkt** (Scope-Entscheidung, nicht in diesem Turn implementiert).
- **Writer hat kein eigenes PIDfile:** Reklamation erfolgt über EOF beim
  Node-Ende; kein direkter Ownership-Kill. Bewusst so (kein PGID-Kill).
- Kein Live-Repro am alten BI-MC-Socket; Kausalität aus Source +
  OCVM-Prozessbeobachtung + isoliertem Namespace-Test.
- Host-seitige Shutdown-Ursache (VM absichtlich running für ReAttach) ist
  Host-Verhalten, nicht VM-seitig lösbar.
- Gesamt-QC am fertigen Pin bleibt unabhängig offen.

## 6. Grenzen dieses Turns

- Keine Checkbox-/Skillimplementierung (folgt seriell nach Shutdownabschluss).
- Kein Push/Publish/Install/Mainintegration/VM-Reset; kein Live-OCVM/BI-MC-
  Prozesseingriff, keine Hostsettings. Nur lokaler Folgecommit auf dem Branch.

## 7. Herkunft (kein Verlust)

Der sich in diesem Branch befindliche Vorgänger-Compact
`.opencode/tasks/task-mcp-shutdown-pid.compact.md` (voriger Autor) bleibt
erhalten und wird nur um die belegte Zahlkorrektur `20 Checks → 18 Checks`
sowie einen Provenienz-Hinweis ergänzt. Er ist nicht der Task-ID-Benennung
zugeordnet und wird nicht gelöscht oder überschrieben.

## 8. Phase 3 — F1 Pidfile-Cleanup (isoliert, QC_PASS)

Unabhängige QC (ses_ec9358393ffeJvFrWodNF5TqnC; Original msg_13a762f70001By3C9nDuS3gj4B,
lokaler F1-spezifisch QC_PASS): **41/41** (34+7), Negativkontrolle `88db8a1`
exakt 2 Fehler. F1-Korrektur: Mismatch-Zweig merkt sich stale PIDdatei+PID;
nach `recovery_ok` werden nur taskeigene PIDdateien entfernt, nur bei
unverändertem Inhalt (Compare-before-delete D1b, kein Cleanup ohne bewiesene
Recovery D3).

## 9. Phase 4 — D4 Respawn-Supervisor dauerhaft stoppen (dieser Turn)

Restlücke D4 (QC): Bei fehlender/alter `sup.pid` bleibt der Respawn-Supervisor
lebend. Socket-Owner-Recovery stoppte nur den Node; ~2s später respawned der
Supervisor einen neuen Node → Port wieder belegt. Bestand schon auf `88db8a1`.

**Minimale Korrektur** (`opencode-vm.sh`):
- `_mcp_find_respawn_supervisor`: PPID-Kette vom Node aufwärts (max. 5 Stufen),
  findet den **höchsten** Vorfahren mit `ocvm-mcp-supervisor-$generation`
  (Pipe-Subshell erbt Cmdline → Marker; Supervisor ist der höchste).
  Kein FD-Scan, nur `/proc/$pid/status` + `/proc/$pid/cmdline`.
- Socket-Owner-Recovery: Supervisor **zuerst** killen (vor Node), mit
  Identity-Checks (Marker + Adapterpfad + UID) und Startzeit-Re-Verification
  vor jedem Signal. Dann Node killen. `recovery_ok` nur wenn Node weg.
- F1-Schutz erhalten (stale PIDdateien werden nach Recovery entfernt).
- Keine pauschalen Kills, keine Listenerumgehung, kein neues Framework,
  kein zusätzlicher FD-Massenscan. Alle Prozesse individuell identifiziert.

**Regression** (`tests/mcp_shutdown_test.sh`, Sektionen 12+13): fehlende und
lebend-falsche PIDdateien + echte Respawn-Schleife; nach 3s (über Respawnfenster)
Port dauerhaft frei, Supervisor+Node tot, fremde PID/Generation/Listener lebend,
wiederholter Stop idempotent. Gesamtsuite **59 Checks PASS**;
Negativkontrolle Basis `7c31702` (F1 ohne D4) **FAIL (5)** — genau die
D4-Dauerhaftigkeitsfehler (Port nicht dauerhaft frei ×2, Supervisor lebend ×2,
stale run.pid nicht entfernt); 54 weitere grün.

**Basis/Pin:** `7c41b5525490f94f214d0fc4d898b0cb464b8e0e` (Pack-r57, OCVM 0.7.53)
→ Kandidat OCVM 0.7.54 (Tags v0.7.54); MCP-Adapter 0.1.54 unverändert.
F1-Pin `7c317026a589d9a1d32b6ea58d932ba889459225` als Vergleich.
Branch/Worktree `task/b3f49fc7-f1-pidfile-cleanup`. Keine Main-Integration in
diesem Turn; erneute unabhängige QC und Main-Integration koordiniert der Operator.
