Task-ID: task_a234c341-06c5-5489-be11-0ef637080fe1

# Task task_a234c341 — Monitor-Bearbeitungsstrategie: adaptive Fortschrittsprüfung und begrenzte Investigation (Vorkonzept)

Status Board: **todo** (bleibt nach diesem Vorkonzept bewusst stehen; `todo` ist hier der
vereinbarte Dokumentstand, kein Implementierungsbeginn).
Vorkonzept autorisiert am **2026-10-12**. Umsetzung erst nach gesondertem Auftrag in einer
**späteren Versionsrevision**; **keine Release-Version festgelegt** — dieses Dokument erfindet
bewusst keine Versionsnummer.
Vorgeschlagene Priorität: **high** (zur Planung; keine Ausführung dadurch autorisiert).

Concept-Plan: **V2** (Implementierungsvertrag für Paket task_e67c39cf, §13; V1 mit
Korrekturpass 1 bleibt als Historie vollständig erhalten)
Status: **CONCEPT_READY_FOR_REVIEW** (V2-Teil) / CONCEPT_READY (V1-Historie) —
Dokumentstand, nicht implementiert.
Last-concept-update: **2026-10-12** (V2: Zustandsprimat je Worker-Episode,
Erstdispatch-Anker statt null-Sofortuntersuchung, Budget ohne starres Taglimit,
Longwork-Kriterien präzisiert, Overrides ohne Progress-Reset, Observer-Claim).

Quellenstand dieses Dokuments: Main-Checkout `b7aa2640aa328ee5705ffb51de2cbac10db0705a`
(2026-10-12 04:09:57 +0200), `OCVM_VERSION="0.7.34"` (`opencode-vm.sh:290`),
MCP-Adapter-Quelle und gestagte Runtime beide **0.1.43**
(`adapters/mcp/package.json`; Script-Pin `opencode-vm.sh:47-50`, SHA-256 `52f40571…`).
Alle Codeangaben (Datei:Zeile) beziehen sich auf diesen Stand und wurden am 2026-10-12
lesend verifiziert. Die **Produktquellen** wurden ausschließlich gelesen; geschrieben
wurden nur die beiden eigenen Auftragsdokumente (dieser Concept-Plan und der
zugehörige Compact Context). Keine Produktdatei verändert, kein Testlauf, kein
Monitor-/Runtime-Eingriff.

---

## 0 Zusammenfassung

Der Monitor-Engine (`adapters/mcp/src/monitor-engine.ts`) wacht heute in festem Takt
(Default 60 s, `monitor.ts:24`), erkennt aber **fachlichen Stillstand nicht als eigenes
Ereignis**: Ein unveränderter Board-Digest führt in den No-op-Kurzpfad
(`monitor-engine.ts:416-435`), `busy` wird pauschal als Warten gedeutet
(`monitor-engine.ts:472-479`), und eine beliebig lange Phase ohne belegten Fortschritt
erzeugt keine strukturierte, begrenzte Untersuchung. Dieses Vorkonzept definiert eine
**zweistufige, konfigurierbare Strategie**:

1. **Stufe 1 — billige Checks** bei jedem normalen Wake: Status-, Receipt- und
   Meilensteinprüfung aus bereits vorhandener, read-only Evidenz.
2. **Stufe 2 — begrenzte Investigation**: nach anfänglich **1 Stunde** ohne belegten
   fachlichen Fortschritt eine zeit-/lese-/kostenbegrenzte read-only Untersuchung.
   Ist legitime Langläuferarbeit **positiv belegt**, folgen weitere Tiefenprüfungen nach
   **2 h, 4 h, danach maximal 8 h** — jeweils gemessen ab dem **Ende** (`finished_at`)
   der vorigen Untersuchung. Ohne belegte Langarbeit gilt nach jeder Untersuchung eine
   separate, konfigurierbare **Cooldown-Frist ab `finished_at`** (Vorschlag 1 h) — nie
   eine bereits vergangene Frist, kein Due-Loop; `last_progress_at` bleibt dabei
   unverändert. Kurzchecks laufen ungehindert weiter. Fehler, Prozessverlust oder ein
   quellenbelegter Generationswechsel lösen unabhängig von dieser Uhr sofortige
   begrenzte Reconciliation über die bereits existierenden Pfade aus.

Zentraler Vertrag: `last_progress_at` und `last_investigation_at` sind **getrennte Uhren**;
eine Untersuchung setzt die Fortschrittsuhr nicht zurück. Nur belegter fachlicher
Fortschritt setzt den Backoff zurück (auf Stufe 0, **mit Vorrang vor jeder
Langläufer-Leiter**). Uhren und Fälligkeiten werden **pro stabilem `worker_key` plus
`dispatch_receipt`-Episode** geführt; monitorweiter Fortschritt darf einen hängenden
anderen Worker nicht maskieren. Alles sind **konfigurierbare Ausgangswerte
(dieses Projekts), kein universeller Produktstandard**.

---

## 1 Ziel und Nichtziele

### 1.1 Ziel

Monitor-Missionen (MANAGEMENT-Manager + eigene Worker) **bis zum belegten Ziel**
voranbringen, ohne legitime lange Arbeit falsch abzubrechen und ohne fehlenden
Fortschritt unbegrenzt unbemerkt zu lassen:

- Fehlender Fortschritt wird **rechtzeitig, aber begrenzt** untersucht (read-only,
  Budget, eine Untersuchung je Worker/Episode).
- Legitime Langläuferarbeit wird **positiv belegt** und respektiert (Backoff-Leiter).
- Hänger, tote Prozesse, nach Neustart verlorene Subagenten, stale-busy und späte
  Resultate erhalten **deterministische, evidenzbasierte** Behandlungswege auf Basis
  der vorhandenen Engine-Mechanik (Receipts, WAL, Recovery, Parks).
- Kein Logspam, keine parallelen Recoverys, keine ungebremsten Wiederholungen.

### 1.2 Nichtziele (Scope-Grenze dieses Vorkonzepts)

- **Keine Implementierung** in diesem Auftrag; keine Produktcodeänderung, keine Tests,
  keine Deployments/Commits/Pushes, keine Monitor-/Runtime-/Infrastrukturänderung,
  kein Eingriff in bestehende Sessions.
- **Task88 nicht reparieren** (`task_88e85a41-099c-53e6-a310-53f549a674cf`, fremdes
  Projekt-Board — in diesem Board nicht auffindbar, per `get_project_task` am
  2026-10-12 verifiziert). Der Task88-Befund ist **Motivation, kein Ursachenbeweis**
  (§9).
- Keine erneute Implementierung des Journalfixes (`task_278d4136-…`, läuft separat in
  `in_progress`); keine Neudiagnose „Hello World" (`task_4ce92f38-…`, `in_progress`);
  keine technische Absicherung der kooperativen Grenzen (`task_c9148add-…`, `todo`);
  keine OID-/Scheduler-Beschlussfindung (`task_82df255f-…`, `todo`) — deren Scope und
  Status bleiben unberührt (§8).
- Keine harte technische Durchsetzung (BLOCKED-Garantie, Caller-Authentifizierung) —
  bewusst bei `task_c9148add` angesiedelt.
- Kein universeller Produktstandard: die Zeitwerte sind projekt-konfigurierbare
  Ausgangswerte.

---

## 2 Belegter Ist-Stand: relevante Bausteine im aktuellen Code

Alle folgenden Punkte wurden am Quellenstand (Kopf dieses Dokuments) lesend verifiziert.

### 2.1 Engine-Takt und Wake-Fluss

| Baustein | Ort | Relevanz |
|---|---|---|
| Scheduler-Loop, 5-s-`setInterval` → `engine.tick()` | `adapters/mcp/src/monitor-main.ts:125-130` | Ein einziger Treiber; `tick()`-Überschneidungen werden via `waking`-Flag mit `"skipped"` abgewiesen (`monitor-engine.ts:226-231`). |
| Due-Auswahl: abort/wake-Request vor `next_run_at`, ein Monitor je Wake | `monitor-engine.ts:236-256` | Priorisierung existiert (abort 0, trigger 1, planmäßig 2); eine Investigation-Prüfung muss hier sauber einordenbar sein. |
| Run-Claim (`run.active`, CAS via `withRegistry`) | `monitor-engine.ts:266-298`, `monitor.ts:479-503` | Registry-Schreibpfad mit mkdir-Lock + Generation-CAS + atomarem Rename — der einzige legale Persistenzweg. |
| `runWake`-Reihenfolge | `monitor-engine.ts:331-575` | `observeWorkers` → Abort → kanonischer Snapshot → WAL → **No-op-Shortcut** → Receipt-Watch → Busy-Gate → Dispatch. |
| No-op-Shortcut | `monitor-engine.ts:416-432` | `unchangedBoard = digest gleich ∧ workerDigest gleich ∧ kein Trigger` → `noop-unchanged` **vor** jeder tieferen Prüfung. Ausnahme heute nur: ungensparter Dispatch-Receipt → `observeUnchangedReceipt` (`monitor-engine.ts:433-435`). |
| Receipt-Watch (Gate-Fix be951293) | `monitor-engine.ts:754-854`, Typ `monitor.ts:216-220` | Einmalig je Receipt; **verifizierte terminale Gesundheit** (idle, keine Pending-Inputs, `completed`, keine Provider-Evidenz) setzt `healthy`; `unknown/submitted/aborted/bare-failed` setzen nie (QC G1). Wichtiger Präzedenzfall: „unchanged ≠ no-op, wenn eine offene Beobachtung existiert". |
| Busy-Gate | `monitor-engine.ts:437-479` | `pending.permissions/questions > 0` → `busy-held`; `backend_activity !== "idle"` → `busy-held`. **busy beweist keine Gesundheit, idle keinen terminalen Erfolg** — genau die Lücke, die die adaptive Prüfung schließt. |
| Worker-Beobachtung (`observeWorkers`) | `monitor-engine.ts:598-721` | Bis zu 5 aktive eigene Worker, korreliert über `dispatch_receipt`; markiert `mark-complete`/`mark-failed` (lifecycle → `idle`, `result_receipt`, `last_error`) oder hält ehrlich als `note` (Merge-Key, kein Wachstum). |
| Kanonischer Snapshot | `monitor-engine.ts:894-1018` | Board-Task + Management-History (recent 20 + latest checkpoint) + Documents (max. 4) → `CanonicalSummary` mit Digest; `decisionsSince` gegen `state.watermark`. Read-Failures: endliche Episode `read_episodes` mit Backoff 15/45/120 s (`monitor.ts:25`, `monitor.ts:606-628`). |
| Recovery | `monitor-engine.ts:1114-1374` | Nur bei **evidenzbasierter blocked-Kategorie** (`classifyEvidence`, `monitor-engine.ts:1612-1621`) und nur für Provider-Admission-Set (`agent-control.ts:255-269`); persistente endliche Episode (`RecoveryEpisode`, `monitor.ts:65-77`); Parks mit sichtbarem Grund (`recovery-chain-exhausted`, `final-fallback-unconfigured/unavailable`, `profile-fallback-unconfigured`, `dispatch-uncertain`, `repair-budget-exhausted`, `runtime-unavailable`). |
| Dispatch-WAL + Reconciliation | `monitor-engine.ts:380-408, 1486-1506`, `monitor.ts:256-261` | Nicht-idempotente Sends werden vor jeder No-op-/Admission-Entscheidung reconciled (`[MONITOR-ACTION|RECOVERY|COMPACT <id>]`-Marker im Verlauf); unsicher → `parked_input_required` mit `dispatch-uncertain`. **Keine doppelten
Recovery-Dispatches**: vorhandene Bausteine (WAL, persistente Episode, uncertain-Park)
tragen diese Zusicherung heute; die verbleibende Acceptance für die NEUEN
Untersuchungspfade (keine Umgehung dieser Mechanik) ist im späteren Teststand zu
erbringen (§5.4, §10) — die Investigation darf daran nichts ändern. |
| Priming / Missionsvertrag | `PRIMING_CONTRACT = "mgmt-v3"` (`monitor-engine.ts:147`), `buildPrimingBlock` 1526-1543, `buildWakePrompt` 1571-1587, `primingDigest` 1513-1521 | Digest-gebunden, einmalig je Änderung; Wake-Prompt trägt Delta-Zeilen (Checkpoint, neueste Decision, decisions since, Worker-Index). Änderungen am Missionstext ⇒ bewusster Contract-Bump (Präzedenz: mgmt-v2→v3 im Journalfix). |
| Heartbeat + Ownership-Watch | `monitor-main.ts:106-118, 137-145` | `<project>/.opencode-vm/monitor/heartbeat.json` mit `schema/projectHash/generation/pid/at`, 30-s-Takt; Stop bei abweichender Runtime-Input-Datei. |
| Registry | `monitor.ts:222-280` (`MonitorRecord`), `.opencode-vm/monitor/registry.json` (`monitor.ts:282-287`) | Fail-closed Formvalidierung (`shapeOk`, `monitor.ts:346-390`); additives Feldmuster ist etabliert (`recovery_episode`/`recovery_resolution` mit QC-F-B2-Validierung `monitor.ts:101-139`; `state.receipt_observation` `monitor.ts:216-243`; `worker.last_error` `monitor.ts:190-200`). |
| Worker-Registry + Kontexte | `monitor.ts:159-200, 657-665, 727-830` (`reserveWorker`/`reconcileWorkerCreate`), `.opencode-vm/monitor/workers/<monitor_id>/<worker_key>.md` | Lifecycle `reserved/active/idle/archived`; Aliase nie wiederverwendet; Receipts (`creation_receipt`, `dispatch_receipt`, `result_receipt`) sind die Korrelationsanker. |
| Budgets/Entscheidungsbuchung | `monitorDecision` (`monitor.ts:526-550`), `recordRepair`/W2 (`monitor.ts:552-594`, Limit `monitor.ts:23`) | Merge-Key-Entscheidungen zählen in-place hoch statt History zu fluten — direktes Mittel gegen Logspam. |
| Tools-Oberfläche | `tools.ts:2671-2830` (Monitor-Tools), `tools.ts:1061-1082` (Interval 5..86400 s, expiry) | `update_monitor` mit `expected_generation`-CAS; Hub liest dieselbe Registry (kein zweiter Store). |

### 2.2 Evidenzquellen, die die Engine **heute** hat — und Grenzen

Read-only Belege laut Auftrag, gemappt auf tatsächliche Verfügbarkeit:

| Beleg | Verfügbar? | Wo |
|---|---|---|
| Exakte Receipts (Dispatch/Result/Creation) | **Ja** | `MonitorWorkerRecord` (`monitor.ts:160-191`), `dispatch_wal` (`monitor.ts:256-261`), `state.receipt_observation` (`monitor.ts:216-220`), `getSessionStatus(sessionId, receipt)`-Korrelation (`monitor-engine.ts:613, 771`). |
| Commit-/Artefaktfortschritt (kanonisch) | **Ja, begrenzt** | `CanonicalSummary.digest` über Task-Status/-updated_at, Checkpoint-Pointer, neueste Journal-Decision, Document-Revisionen (`monitor-engine.ts:941-959`); `decisionsSince` gegen Watermark (`monitor-engine.ts:936-940`). Grenze ehrlich benennen: Board-`updated_at` ist Letztbearbeitungszeit, kein Arbeitsnachweis (dokumentiert in `docs/MCP-INTERFACE.md`, Taskboard-Abschnitt). |
| Subagentzustand | **Ja, Status-Ebene** | `observeWorkers` (`monitor-engine.ts:598-721`). Zusätzlich existiert `getSessionProgress` (In-Flight-Tools, `last_finished_tool`, `last_activity_at`, Coverage — `opencode.ts:124/1230`, Typ `types.ts:167-188`) — **aber nicht** in `MonitorGatewayLike` (`monitor-engine.ts:81-94`). Konkrete, additive Lücke (§5.2). |
| Generationsquelle | **Ja, mit benannter Quelle** | `runtime.generation` (validiert `monitor-main.ts:44-56`; im Heartbeat `monitor-main.ts:114`) ist die **Session-/Engine-Unit-Generation** (`oc-…`), **nicht zwingend** ein Nachweis über die Identität des OpenCode-Backend-Prozesses. Aktiv verifiziert in dieser Session: `heartbeat.json` trägt `generation oc-20261011-235327-…`. Eine Änderungserkennung existiert in der Engine noch nicht — Lücke (§5.4); ein Quellenwechsel allein begründet keinen „Backend-Neustart"-Claim, eine unerreichbare Quelle wird als `generation_source_unavailable` behandelt. |
| PID plus Startzeit | **Teilweise, ehrlich begrenzt** | Beobachtbar sind nur Prozesse mit Engine-Sichtbarkeit: eigener Engine-Prozess (Heartbeat-PID) und via Dateisystem grundsätzlich `/proc`. Worker-Turns sind **keine eigenen Prozesse**, sondern Turns auf dem gemeinsamen Backend-Server; ein „held-status-Bashpart ohne Trägerprozess" (Task88-Bild) ist aus der Engine heraus mit heutigen Mitteln **nicht** prozesslevel-beobachtbar. Der Fortschrittsklassifizierer muss Prozess-Evidenz deshalb als „nicht verfügbar, sofern nicht explizit ergänzt" behandeln (§4.3, §7-F2). |
| Logwachstum und Semantik | **Nein (heute)** | Engine liest keine OpenCode-Logs; Activity-Journal ist Adapter-seitig. Zugang wäre ein neuer Read-Flächen-Entscheid (§7-F1), kein vorhandener Baustein. |

### 2.3 Was es **noch nicht gibt** (Lücken, keine Parallelarchitektur)

1. **Keine Fortschritts-/Investigationsuhr**: `MonitorRecord` trägt keine Felder wie
   `last_progress_at`/`last_investigation_at`; es gibt keinen wall-clock-getriggerten
   Tiefenpfad. (`budget` zählt Repairs je Fehler-Fingerprint; `read_episodes` backofft
   nur Lesefehler — beides andere Semantik.)
2. **No-op-Shortcut unterdrückt fällige Prüfungen**: eine fällige Investigation würde
   heute am `unchangedBoard`-Pfad (`monitor-engine.ts:416-432`) spurlos als
   `noop-unchanged` vorbeilaufen. Der Receipt-Watch (`433-435`) zeigt das korrekte
   Muster: due-Pfade müssen **vor** dem Shortcut geprüft werden.
3. **Keine unabhängigen Cheap-Checks während blockierender Aufrufe**: `waking`-Guard
   (`monitor-engine.ts:227-231`) macht jede überschneidende `tick()`-Ausführung zu
   `"skipped"`; ein lang laufender Dispatch/Recovery-Await blockiert damit alle
   Beobachtung. (Node-I/O würde Nebenläufigkeit technisch zulassen — das Flag
   verbietet sie bewusst; jede Änderung ist Architektur-Entscheid, §7-F3.)
4. **Keine Tasktyp-/Meilenstein-Deklaration**: weder Registry noch Board tragen
   `expected_milestone`/`task_type`/Zeitbudget je Task. Vorhandene Anknüpfungspunkte:
   `update_monitor`-Felder (additiv, `tools.ts:1079-1082`), Management-Journal-Marker
   `MONITOR-CHECKPOINT v1` (Locator, `docs/MCP-INTERFACE.md` Journal-Abschnitt),
   Documents-Binding mit Revisionen.
5. **Keine Generationsänderungs-Erkennung**: die Session-/Engine-Unit-Generation ist
   bekannt (`runtime.json`/`heartbeat.json`), wird aber nicht auf Veränderung geprüft;
   eine echte Backend-Prozessidentität wird heute gar nicht erhoben.

---

## 3 Soll-Konzept: Zustandsmaschine

### 3.1 Neue additive Felder (Vorschlag, QC-F-B2-Muster)

Ergänzung an `MonitorRecord.state` (oder eigenes additives Top-Level-Feld analog
`recovery_episode`; Empfehlung: eigenes Feld `investigation`, um `state` nicht weiter
aufzublähen — finale Platzierung ist eine Umsetzungsentscheidung):

```text
investigation?: {
  schema: 1,
  last_progress_at: ISO | null,        // NUR semantisch belegter, korrelierter Fachfortschritt (§4.1)
  last_investigation_at: ISO | null,   // eigene Uhr (gesetzt bei INVESTIGATION_DONE);
                                       // setzt last_progress_at NIEMALS zurück
  cooldown_until: ms | null,           // separate Frist ab episode.finished_at (Vorschlag 1 h);
                                       // last_progress_at bleibt dabei UNVERÄNDERT
  backoff_stage: 0 | 1 | 2 | 3,        // 0 = 1h-Anker, 1 = 2h, 2 = 4h, 3 = 8h-Cap;
                                       // Reset auf 0 ausschließlich durch echtes A (§4.1)
  next_deep_check_at: ms | null,
  episode: {                            // eine laufende/letzte Untersuchung
    started_at: ISO, finished_at: ISO | null,
    outcome: "long_work_evidenced" | "no_progress_evidenced" | "inconclusive" | "aborted_budget" | null,
    evidence: [ max 6 Einträge { kind, source, at, digest } ],   // Art/Quelle/Zeit/Beleg-Hash
    expected_milestone: string | null,
    wait_reason: string | null,        // begründeter Wartegrund bei belegter Langarbeit
    budget: { max_ms, max_calls, max_bytes, timeout_ms },         // eingefrorene Konfiguration
    worker_key: string | null,         // Untersucher-Bezug (höchstens eine Untersuchung je Worker)
    dispatch_receipt: string | null,   // Korrelation zum Admissions-Zeitpunkt
    generation_source: "runtime_json" | "heartbeat" | null,      // benannte Quelle
    generation_value: string | null    // Wert der benannten Quelle; aus einem Quellenwechsel
                                       // wird KEIN „Backend-Neustart" behauptet (§5.4)
  } | null,
  workers: [ max 8 {                   // Uhren/Fälligkeiten je stabilem Worker
    worker_key: string,
    dispatch_receipt: string | null,   // Episoden-Anker; Wechsel = neue Episode
    last_progress_at: ISO | null,      // nur ein A-Signal, das DIESEN Worker korreliert
    next_deep_check_at: ms | null,
    backoff_stage: 0 | 1 | 2 | 3
  } ],
  counters: { investigations_total, inconclusive_total }          // Merge-Key-Diagnostik
}
```

Validierung strikt nach dem existierenden additiven Muster (bei Anwesenheit
vollständig prüfen, fehlend = legacy-ok; `monitor.ts:101-139` als Vorlage). Jede
Mutation ausschließlich via `withRegistry` (`monitor.ts:479-503`).

### 3.2 Zustände (feingranular, orthogonal zu bestehenden States)

Die Strategie führt **keine neuen work-States** ein (`active`/`parked_input_required`/
`complete_pass`/`stopped` bleiben unverändert, `monitor.ts:28-32`). Sie overlayt
folgenden Beobachtungszustand in `investigation`:

| Zustand | Bedeutung | Übergänge |
|---|---|---|
| `WATCHING` (implizit, backoff_stage beliebig) | Kurzchecks laufen; Deep-Check evtl. fällig | siehe Ereignisse |
| `INVESTIGATING` | begrenzte read-only Untersuchung läuft | → `WATCHING` mit neuem `next_deep_check_at` oder Eskalation |
| `HELD-RECONCILE` | Fehler/Prozessverlust/Generationwechsel übernehmen | → bestehende Pfade (recover/receipt-watch/WAL), Backoff-Logik pausiert |

### 3.3 Ereignisse und Prioritäten je Wake

Reihenfolge im `runWake`-Fluss (Einfügepunkte markiert):

```text
P0 observeWorkers (bestehend, monitor-engine.ts:334)          — Ergebnis kann PROGRESS setzen
P1 abort_request (bestehend)                                   — unverändert vor allem anderen
P2 WAL-Reconciliation (bestehend, 380-408)                     — unverändert; unsichere Writes
                                                                 zuerst abgleichen, NIE parallel recovern
P3 NEU: Generation/Prozessverlust-Check (billig)               — bei Wechsel: sofortige begrenzte
                                                                 Reconciliation, Backoff-Reset auf
                                                                 Watch-Modus (kein Auto-Park)
P4 kanonischer Snapshot (bestehend)                            — liefert digest/decisionsSince
P5 NEU: Deep-Check fällig?  (VOR dem No-op-Shortcut)           — wenn nicht fällig: weiter wie heute
P6 No-op-Shortcut (bestehend, 416-432)                         — unverändert, außer P5 hat geöffnet
P7 Receipt-Watch / Busy-Gate / Dispatch (bestehend)
```

**Ereignisse:**

| Ereignis | Erkennung (Evidenz) | Wirkung |
|---|---|---|
| `PROGRESS` (A) | NUR semantisch belegter, korrelierter Fachfortschritt (§4.1): neuer terminaler Worker-`result_receipt` mit Manager-Synthese, receipt-korrelierter Meilensteinabschluss oder ein dadurch belegtes Artefakt. Document-Revision / Checkpoint-Pointer / `decisionsSince > 0` / Task-Statusänderung **allein** sind KEIN `PROGRESS` (→ Stufe B); eigene Untersuchungsnotizen sind nie A | `last_progress_at = Ereigniszeit`; `backoff_stage = 0` (Reset, überall konsistent); `next_deep_check_at = Ereigniszeit + T_first`; **Vorrang vor jeder Leiter** |
| `ERROR_EVIDENCED` | `classifyEvidence` blocked (bestehend) | unverändert: `recover()`/`compactionContinue()`; Investigation-Episode ggf. abbrechen (budget-safe) |
| `PROCESS_LOSS_SUSPECTED` | Receipt/Status-Read persistent fehlgeschlagen ODER Session-Details verschwunden (Rebind in `ensureSession`, `monitor-engine.ts:1022-1055`) | sofortige **begrenzte** Reconciliation (bestehende Pfade); nie als sicherer Hang deklariert, wenn Beleg fehlt (§4.3) |
| `GENERATION_CHANGED` | Wert einer **benannten Quelle** (`runtime_json`/`heartbeat`) ≠ bei Episode-Start verzeichnet; Quelle unerreichbar ⇒ `generation_source_unavailable`, kein Claim | begrenzte Reconciliation; `episode.generation_source/value` aktualisieren; **kein** unbewiesener „Backend-Neustart"-Claim (§5.4) |
| `DEEP_DUE` | `now ≥ next_deep_check_at` ∧ kein offener unsicherer Write ∧ keine laufende Recovery | P5 öffnet Stufe 2 (§5); No-op-Shortcut wird für diesen Wake umgangen |
| `INVESTIGATION_DONE(outcome)` | Budget erreicht oder Schlussfolgerung feststehen | `cooldown_until = finished_at + T_cooldown` (Vorschlag 1 h; `last_progress_at` unverändert); nur bei `long_work_evidenced` Leiter hochschalten, jeweils gemessen ab `finished_at` (§3.4); echtes A hat jederzeit Vorrang |
| `MILESTONE_EXPECTED(m, due)` | Tasktyp deklariert Meilenstein mit Zielzeit | Fälligkeit ohne Beleg ⇒ verfrühter Deep-Check (vor 1 h), Ergebnis wie oben |

Alle ereignisgesteuerten Aktionen laufen im bestehenden `runWake`-Claim (`run.active`).
Ein separater Beobachter (§5.6) benötigt einen **eigenen, expliziten Claim/CAS/Lease** —
das `waking`-Flag schützt ihn nicht automatisch — und sendet/Recovered nie selbst.

### 3.4 Zeitformeln (konfigurierbare Ausgangswerte)

```text
PROGRESS_T            := Zeitpunkt des letzten echten A-Ereignisses (nur §4.1-A setzt)
T_first               := 1 h (Vorschlag)
T_cooldown            := 1 h ab Untersuchungs-ENDE (Vorschlag, konfigurierbar)
stage_ladder          := [T1=2 h, T2=4 h, T3=8 h (Cap)]

next_deep_check_at    := PROGRESS_T + T_first                    (nach echtem A; stage := 0)
                      | episode(n).finished_at + stage_ladder[min(n,3)]
                                                                 (outcome(n) = long_work_evidenced;
                                                                  gemessen ab ENDE der vorigen
                                                                  Untersuchung)
                      | episode(n).finished_at + T_cooldown      (outcome(n) ≠ long_work_evidenced;
                                                                  last_progress_at bleibt UNVERÄNDERT —
                                                                  nie eine bereits vergangene Frist,
                                                                  kein wiederholtes Due)
Initialanker          := last_progress_at = null (Erstbeobachtung/Upgrade/Registry-Neuaufbau)
                      → genau EINE überfällige Prüfung (due sofort), danach Anker =
                        finished_at dieser Untersuchung; kein wiederholtes Overdue.
Eine Untersuchung setzt NIE last_progress_at zurück.
Echtes A hat Vorrang vor jeder Leiter: stage := 0, Anker neu (§10 A8).
ERROR/PROCESS_LOSS/GENERATION überholen die Uhr jederzeit (sofortige Reconciliation,
unabhängig von next_deep_check_at); Kurzchecks (Scheduler-Intervall) laufen immer.
```

Alle Werte (`T_first`, Leiter, Budgets) als **konfigurierbare Ausgangswerte** an
`create_monitor`/`update_monitor` (additiv, optionale Felder mit Defaults) — kein
universeller Produktstandard; fehlende Konfiguration = dokumentierte Defaults.

---

## 4 Fortschrittsklassifizierer (evidenzbasiert, konservativ)

### 4.1 Evidenzstufen

| Stufe | Signal | Quellenpfad (heute) | Einstufung |
|---|---|---|---|
| A — belegter fachlicher Fortschritt (streng) | NUR semantisch belegter, zum Worker/Receipt/Meilenstein **korrelierter** Fortschritt: neuer terminaler Worker-`result_receipt` nach `mark-complete` + Manager-Synthese (`last_synthesis_at` frischer als vorher); receipt-korrelierter Meilensteinabschluss; ein im Terminalresultat referenzierter, verifizierbarer Artefakt-/Commitfortschritt. **Nicht A:** Document-Revision, Checkpoint-Pointer, `decisionsSince > 0`, Task-Statusänderung für sich allein; eigene Untersuchungsnotizen nie | `observeWorkers` (`monitor-engine.ts:684-695`); Korrelationsanker `dispatch_receipt`/`result_receipt` (`monitor.ts:160-191`) | PROGRESS |
| B — belegte Aktivität/Buchhaltung (kein Fortschritt) | `backend_activity != idle`, `state == running`, aktive Tools; **auch**: Document-Revision, Checkpoint-Pointer, `decisionsSince > 0`, Task-Statusänderung **ohne** Worker-/Receipt-/Meilensteinkorrelation | `monitor-engine.ts:472-479`; `snapshotCanonical` (`894-974`); `getSessionProgress` (nicht im Engine-Gateway, §5.2) | Warten mit Grund; **kein** Backoff-Reset, keine Leiter-Begründung allein |
| C — belegter Fehler | `classifyEvidence` blocked inkl. `unknown`-Kategorie | `monitor-engine.ts:1612-1621` | bestehende Recovery-Pfade |
| D — fehlende Telemetrie | Read-Failures, Coverage `partial`, `task_status_reason ∈ {outside_history_or_not_observed, non_terminal_evidence}`, unattributable Turns | `types.ts:151-154`, `monitor-engine.ts:655-661` | **konservativ**: kein Fortschritt, kein Hang-Urteil; transparente Merge-Key-Notiz, Uhr läuft weiter |

### 4.2 Konservative Regeln (verbindlich)

1. `busy` beweist keine Gesundheit; `idle` beweist keinen terminalen Erfolg — beide
   setzen niemals `last_progress_at`.
2. Fehlender Beleg darf **nicht als sicherer Hang** gelten: Stufe D führt zu
   „weiter warten,transparent vermerkt", nie zu Abort/Park/Routing.
3. Worker-/Manager-Claims („arbeite noch", Journal-Texte) sind Agenten-Claims — zählen
   nur als B, niemals als A (Präzedenz: Journalfix-Konzept, „Worker-Behauptungen sind
   Agenten-Claims, keine Tool-Receipts").
4. Nur Stufe A setzt Uhren/Backoff zurück (auf Stufe 0). Kein Heartbeat/Logspam als
   Fortschritt; eigene Untersuchungsnotizen sind nie A.
5. A-Uhren werden pro `worker_key` + `dispatch_receipt`-Episode geführt; monitorweiter
   Fortschritt (z. B. der Abschluss eines anderen Workers) darf den Zustand eines
   **hängenden anderen Workers nicht maskieren** — dessen `next_deep_check_at`
   bleibt fällig.

### 4.3 Tasktypen (Vorschlag, drei Klassen)

| Typ | Deklaration | Verhalten |
|---|---|---|
| `default` | nichts deklariert | 1-h-Trigger; nach `inconclusive`/`no_progress_evidenced` erneute 1-h-Frist; **kein** automatisches Parken nur wegen Stillstand — Eskalation als Aufmerksamkeit/INPUT_REQUIRED-Vorschlag (§6) |
| `long_runner` | via `update_monitor` (additiv) oder Journal-Deklaration | Leiter 2/4/8 h ab dem **Ende** der vorigen Untersuchung, **nur nach positiv belegter Langarbeit**; Deklaration allein ist kein Beleg; echtes A bricht die Leiter jederzeit (Reset 0) |
| `milestoned` | `expected_milestone` + Zielzeit | verfrühter Deep-Check bei Zielzeitüberschreitung ohne Beleg; fehlender `expected_milestone` ⇒ Verhalten wie `default` (offene Entscheidung F4 verhindert hier Spekulation) |

### 4.4 Budget je Untersuchung (Vorschlag, konfigurierbar)

`max_duration_ms = 300_000` (5 min), `max_calls = 10`, `max_bytes = 262_144`
(256 KiB Content-Reads), `timeout_ms = 3_000` je Call (Gateway-Default,
`monitor-main.ts:71`). **Höchstens eine Untersuchung je Worker** (`worker_key` +
`dispatch_receipt`-Episode), ergänzt um ein **globales, faires Monitor-Budget**
(Vorschlag: max. 1 laufende Untersuchung je Monitor, max. 4/Tag, Fair-Share-Rotation
bei mehreren fälligen Workern). Diese Ausschlüsse sind **nicht automatisch** durch
`run.active`/`waking` garantiert: jeder Lauf (Wake-Pfad und separater Beobachter)
benötigt einen expliziten Claim — `episode`-Eintrag mit CAS via `withRegistry`
(`monitor.ts:479-503`) bzw. eine dedizierte Observer-Lease mit TTL (§5.6). Bei
Budgetausschöpfung ohne Schluss: `outcome = aborted_budget`, ehrlich vermerkt,
nächste Frist nach §3.4 (Cooldown ab `finished_at`).

---

## 5 Verifizierte Integrationsstellen (Reuse vs. Änderung)

### 5.1 Priming/Monitor-Missionsvertrag — **Reuse, plus bewusster Contract-Bump später**

Der deterministische Teil (Uhren, Fälligkeiten, Budgets) ist **Engine-Feld**, nie
Prompt-Regel — konsistent mit dem dokumentierten Grundsatz „W2-Budget, Read-Episodes
und Receipt-Reconciliation sind deterministische Engine-Felder, not prompt rules"
(`docs/MCP-INTERFACE.md`, Monitor-Abschnitt). Der Missions-/Wake-Text
(`buildPrimingBlock` `monitor-engine.ts:1526-1543`, `buildWakePrompt` `1571-1587`)
bekommt erst im Umsetzungsslice S4 additive Delta-Zeilen (z. B. „Deep-Check fällig:
führe die begrenzte read-only Untersuchung aus und berichte Evidenz"), optional als
Contract-Bump Richtung „mgmt-v4" — **nur Vorschlag, keine reservierte oder bereits
fixierte Version** (Präzedenz: Journalfix, bewusster Bump re-primet einmalig).
Bis dahin gilt der heutige Contract unverändert.

### 5.2 Evidence-Interface — **kleine additive Gateway-Erweiterung**

`getSessionProgress` existiert (`opencode.ts:1230`, Typ `types.ts:167-188`) und wird
bereits für das MCP-Tool `get_session_progress` genutzt; der Engine-Gateway-Contract
`MonitorGatewayLike` (`monitor-engine.ts:81-94`) enthält es **nicht**. Vorschlag:
optionale Methode `getSessionProgress?(sessionId)` analog zum bestehenden optionalen
`getSessionHistory?` (`monitor-engine.ts:86`) — reine Wiederverwendung des vorhandenen
Backends, keine zweite Implementierung. Fehlt sie, arbeitet der Klassifizierer ohne
Tool-Evidenz (Stufe D, konservativ).

### 5.3 Fälligkeitsprüfung vor dem No-op-Shortcut — **konkreter Einfügepunkt**

Nachweislich Lücke: `unchangedBoard` (`monitor-engine.ts:416`) returnt
`noop-unchanged` bevor irgendeine due-Logik läuft. Muster der korrekten Lösung
existiert (Receipt-Watch-Bypass `monitor-engine.ts:433-435`). Der Deep-Check muss
als zweite Ausnahme **vor** P6 geprüft werden; nicht fällig ⇒ Kosten Null (ein
Vergleich zweier Timestamps).

### 5.4 Neustart-/Late-Result-Reconciliation — **weitgehend vorhanden, Generation-Probe ergänzen**

- Spätes Resultat: `observeWorkers` (`monitor-engine.ts:598-721`) markiert terminal
  unabhängig vom Board-Digest; Worker-Index-Digest (`workerIndexDigest`,
  `monitor.ts:969-983`) weckt den Manager einmal je Delta. **Vorhandene Bausteine;
  verbleibende Acceptance:** der spätere Teststand muss belegen, dass ein spätes
  Resultat auch nach einer zwischenzeitlichen Untersuchung korrekt verarbeitet wird
  (Matrix A6) — „Reuse" heißt hier nicht „bereits bewiesen für die neuen Pfade".
- Neustart: `ensureSession`-Rebind (`monitor-engine.ts:1022-1055`), Heartbeat
  (`monitor-main.ts:106-118`), WAL-Reconciliation vor allem (`monitor-engine.ts:380-408`).
  Zu ergänzen: Vergleich der **benannten Generationsquelle** (P3) als explizites
  Ereignis — der Wert ist in Heartbeat und Runtime vorhanden; es fehlt nur der
  Vergleich, kein neuer Store. Klarstellung: die Session-/Engine-Unit-Generation
  (`oc-…`) ist **nicht zwingend** die Backend-Prozessidentität; ein Quellenwechsel
  allein begründet keinen „Backend-Neustart"-Claim, und eine unerreichbare Quelle
  wird als `generation_source_unavailable` konservativ behandelt (§3.3, §7).
- Kein zusätzlicher Recovery-Dispatch aus der Untersuchung: Sends/Recovery bleiben
  den bestehenden Pfaden vorbehalten (WAL, `recovery_episode`-Attempts,
  `dispatch-uncertain`-Park — vorhandene Bausteine gegen Duplikate); **verbleibende
  Acceptance:** A3/A4/A6 müssen im späteren Teststand belegen, dass die neuen
  Untersuchungspfade diese Garantien nicht umgehen.

### 5.5 Persistenz, Worker-Assoziation, Receipt-Korrelation — **Reuse im verifizierten Umfang**

Registry (`.opencode-vm/monitor/registry.json`, CAS+Lock, `monitor.ts:479-503`),
Worker-Records mit Receipts (`monitor.ts:160-191`), Receipt-Korrelation über
`getSessionStatus(sessionId, receipt)` (`monitor-engine.ts:613, 771`) und
`state.receipt_observation` — alle vorhanden. Die Investigation schreibt ausschließlich
in ihr additives `investigation`-Feld via `withRegistry`; Uhren/Fälligkeiten werden
zusätzlich **pro `worker_key` + `dispatch_receipt`-Episode** im `workers`-Map (§3.1)
geführt. **Verbleibende Acceptance:** Formvalidierung des neuen Felds (additives
Fail-closed-Muster) und Konkurrenzverhalten mit `observeWorkers`-Markierungen sind im
späteren Teststand zu belegen (Matrix A5/A6).

### 5.6 Scheduler-Unabhängigkeit der Cheap-Checks — **Architektur-Entscheid (offen, §7-F3)**

Heute blockiert `waking` alle Nebenläufigkeit (`monitor-engine.ts:226-231`). Optionen:

- **O1 (Empfehlung):** zweiter, eng begrenzter Beobachter-Takt **im selben
  Engine-Prozess** (eigener Interval, strikt read-only, **eigenes Claim/CAS/Lease** —
  z. B. `episode`-Claim via `withRegistry` oder dedizierte Lease mit TTL und
  Generation-CAS). Wichtig: das bestehende `waking`-Flag schützt einen separaten
  Observer **nicht automatisch** — der gegenseitige Ausschluss muss explizit
  implementiert werden. Kein Send, keine Recovery, kein Dispatch aus dem Observer.
- O2: Read-only-Carve-out innerhalb `tick()` (No-op-Pfad darf bei nicht-fälliger
  Untersuchung billige Status-Reads ausführen) — minimal, aber vermischt Pflichten.
- O3: rein kooperativ (Manager meldet Meilensteine im Journal/Prompt) — **keine
  technische Garantie**: prompt-gesteuerte Meldung scheitert exakt dann, wenn der
  Worker technisch blockiert ist (Task88-Bild). Als alleinige Basis ungeeignet; nur
  als zusätzliches B-Signal.

Abzulehnen ist jede Variante, die Sends/Recoverys aus dem Beobachter heraus startet.

### 5.7 Hub-/Monitor-UI: Ist-Anzeige und Soll-Verortung (read-only verifiziert)

Vorhandene Oberflächen (am Quellenstand geprüft, keine erfundenen Namen):

- `hub/monitor.py` liest/mutiert **dieselbe Registry** (Snapshot `snapshot` Z. 165,
  CAS-Mutator `mutate` Z. 145, Formvalidierung `_valid_registry` Z. 66,
  Heartbeat-Lesung `read_heartbeat` Z. 271) — kein zweiter Store.
- `hub/monitor.js` rendert je Monitor-Karte: Scheduler-Badges (Z. 136), Arbeitszustand
  (Z. 138), `parked_reason` (Z. 143), Takt-/Profil-Zeile (Z. 144) und die Termin-Zeile
  „Nächster Lauf / Letzter Lauf / Frische / Expiry" (Z. 145; `freshness` Z. 52-55,
  `fieldCaptions` Z. 8); Details-/History-Bereich ab Z. 167.

**Ist:** angezeigt werden heute Scheduler-Enabled, `work_state`, `parked_reason`,
Intervall/Profile/Expiry, Next-/Last-Run und Frische. **Noch nicht** angezeigt:
`last_progress_at`, `last_investigation_at`/`cooldown_until`, `next_deep_check_at`,
`wait_reason`, Evidenz. **Soll (additiv, Slice S4):** eine zusätzliche
Investigations-Zeile bzw. Aufklappendetail mit genau diesen Feldern; Datenpfad =
dasselbe additive `investigation`-Feld. Berührpunkte: `hub/monitor.py::_valid_registry`
(neue Felder fail-closed validieren, analog `shapeOk` in `monitor.ts:346`) und
`hub/monitor.js` (Kartenrenderer); derselbe Feldsatz additiv im MCP-Read-Pfad
(`get_monitor`/`get_monitor_history`, `tools.ts`-Monitor-Tools). Keine UI-Änderung in
diesem Auftrag.

---

## 6 Eskalation und Berechtigungsgrenzen

- **Korrekturen nur unter bestehenden Grants**: die Investigation ist read-only;
  jede Änderung am Arbeitsziel bleibt bei den bestehenden Determinismen (Recovery nur
  Provider-Admission-Set, `agent-control.ts:255-269`; Parks nur durch
  `repair-budget`/`chain-exhausted`/`dispatch-uncertain`/`runtime-unavailable`).
  **`unknown` allein autorisiert keine beliebige Recovery** (bestehende
  Admission-Regel, unverändert).
- **Fachliche Entscheidungen begründet parken / INPUT_REQUIRED — verpflichtend, nicht
  nur Empfehlung**: findet eine Untersuchung eine genuin fehlende Operator-/Fach-
  entscheidung, darf die Mission nicht unbegrenzt weiterlaufen. Auf dem erlaubten
  bestehenden Weg wird der Zustand sauber herbeigeführt: die Manager-Session parkt
  über die existierende INPUT_REQUIRED-/Pending-Input-Maschinerie (G3-Regel des
  Missionsvertrags, `monitor-engine.ts:1539`; Engine-seitig erscheint das als
  `busy-held`/`pending-input`, `monitor-engine.ts:459-464`) bzw. setzt einen
  begründeten Park mit sichtbarem `parked_reason`; die Untersuchung vermerkt
  `wait_reason` + Evidenz in ihrem Feld und eskaliert sichtbar (Attention-Klassen
  `attention.ts`, Management-Journal via `add_task_management_note` — letzteres nur im
  Manager-Session-Kontext). **Owner/Handback:** Scheduler/Expiry bleibt Operator-
  Eigentum (`update_monitor`/enable/disable, Hub); der Work-Park gehört der
  Manager-Session über die bestehenden Pfade; die Untersuchung besitzt nichts und
  übergibt nur. Die ausstehende technische Absicherung dieser kooperativen Grenzen
  bleibt offen bei `task_c9148add`.
- **Pending Security-Permission wird nie beantwortet/umgangen** (heutiger
  Missionsvertrag, `monitor-engine.ts:1538-1540`); die Strategie ändert das nicht.
- Keine Self-Autorisierung, kein Eigenschaftswechsel an Monitor/Scheduler durch die
  Untersuchung.

---

## 7 Offene Entscheidungen (bewusst nicht beschlossen)

| # | Entscheidung | Optionen | Empfehlung |
|---|---|---|---|
| F1 | Log-/`/proc`-Lese-Fläche für die Engine (Logwachstum, PID+Startzeit über eigene VM hinaus) | (a) nicht einführen — Receipts/Journal/Digest genügen; (b) eng whitelistierte Datei-Reads (heartbeat, /proc/<pid> stat) mit Byte-Budget | **(a) für Slice S1-S3**, (b) nur falls Evidenz nachweislich unzureichend; jeder Datei-Zugang ist neuer Vertrauensbereich |
| F2 | Prozess-Evidenz für Worker-Turns (Task88-Bild „Bashpart ohne Trägerprozess") | nicht abbildbar ohne Backend-API-Erweiterung; ehrlich als „außer Reichweite der Engine" dokumentieren | dokumentieren, nicht simulieren; Backend-seitige Beobachtbarkeit ist ggf. eigenständiger späterer Bedarf |
| F3 | Scheduler-Probing-Architektur (§5.6) | O1/O2/O3; Observer braucht in jeder Variante expliziten Claim/CAS/Lease | **O1** |
| F4 | Meilenstein-Quelle der Wahrheit | (a) `update_monitor`-Felder; (b) Journal-Marker-Konvention; (c) Board-Document | **(a)** für deterministische Auswertung; (b) als ergänzendes A-Signal |
| F5 | Verhalten bei überzogenem task-spezifischem Zeitbudget (Langläufer deklariert 8 h, Episode läuft länger) | (a) weiter warten, Deep-Checks im 8-h-Cap fortsetzen; (b) begrenzte Eskalation (Attention) ohne Eingriff | **(b)** — Sichtbarkeit ja, Eingriff nein; liegt dahinter eine fehlende Fachentscheidung, gilt zwingend §6 (begründetes Parken/INPUT_REQUIRED) |
| F6 | Verhalten bei nicht eindeutigem Prozessverlust (Stufe D + Rebind erfolgreich) | (a) als B werten; (b) eine begrenzte Reconciliation, danach Cooldown ab `finished_at` | **(b)** mit hartem Einmal-Zähler (`counters`); kein unbewiesener Verlust-Claim |
| F7 | `expected_milestone` fehlt, aber Stillstand > 1 h bei `default` | (a) still weiter warten; (b) nach n inconclusive Zyklen begrenzte Eskalation | **(b)** mit n=3 als Vorschlag (≈ Wartezeit-Eskalation, kein Abort) |
| F8 | Interaktion mit `expiry_at` und `complete_pass` | Deep-Check nie über Expiry hinaus; `complete_pass`/`stopped` friert Untersuchungszustand ein | so festlegen |

---

## 8 Abgrenzung / Abhängigkeiten (Status am 2026-10-12, per `get_project_task` verifiziert)

| Task | Titel (gekürzt) | Status | Verhältnis zu diesem Konzept |
|---|---|---|---|
| `task_278d4136-8d7b-559b-80fe-3e9ae7282140` | Fix: Monitor-Journal Dateischutz | `in_progress`, high | Liefert mgmt-v3 + Journal-Writer-Regel im Priming (`planning/task-concepts/task_278d4136-monitor-journal-writer-contract-20261012.md` gelesen). Dieses Konzept baut darauf auf (A-Signal „Checkpoint"), implementiert den Fix **nicht** erneut. Sein Scope/Status bleibt unberührt. |
| `task_4ce92f38-5c5a-5853-93aa-9fe3cc64d2d8` | Diagnose: Monitor Hello World — projektübergreifender Vergleich | `in_progress`, high | Diagnosekontext für Monitor-Zuverlässigkeit; keine Überschneidung mit dem hier definierten Vertrag. Wird abgewartet, nicht dupliziert. |
| `task_c9148add-9807-578f-ad25-3c689cfa133a` | Management-MCP: spätere technische Absicherung der Monitor-Grenzen | `todo`, low | Hard-Enforcement bleibt dort; dieses Konzept bleibt deterministisch/kooperativ und widerspricht nicht. |
| `task_82df255f-773e-590a-9bbf-7a5ae86d770e` | Scheduler-Strategie: Optimistic Implementation Decisions | `todo`, medium | Autonomie-/Scheduler-Beschlüsse dort; dieses Konzept benötigt **keine** OID-Entscheidung (Deep-Check ist read-only). |
| `task_88e85a41-…` / Master `task_a7b0aa7a-…` / `monitor_7631f7c175b3496d9ddfaaea4e478e0f` | (BI-MC, fremdes Projekt-Board) | — | Nur Motivation (§9); kein Zugriff, keine Reparatur, keine Aussage über deren Board hier. |

## 8a Dedupe

Gezielte Board-Suchen am 2026-10-12 (`list_project_tasks` mit `query`): „Investigation",
„Fortschrittsprüfung", „Langläufer" ⇒ **jeweils nur dieser Task**. „Backoff" (Filter
`status=todo`) ⇒ dieser Task + `task_9c9d5f33` (MCP-Ausfälle diagnostizierbar — anderer
Outcome) + `task_fa86d673` (Fallback-/Compaction-Recovery für Sessions — anderer
Outcome: Session-Fallback, nicht Monitor-Fortschrittsprüfung). **Kein inhaltlich
gleicher Treffer.** Offenlegung der Grenze: die breite Suche nach „Monitor" liefert
`TASK_SEARCH_INCOMPLETE` (Scan-/Resultatlimit; Adapter-Vertrag
`docs/MCP-INTERFACE.md`), daher ist **keine Vollständigkeit** der Dedupe behauptet.
Monitor-Suchen je Status wurden im Hauptboard durchgeführt; ein Folgeboard (`todo`)
wurde über den Status-Filter mit abgedeckt (projekt-lokaler Scan umfasst alle Board
Projects).

---

## 9 Motivation: Task88-Befund — ausdrücklich KEIN Ursachenbeweis

Überlieferte Quelle (vom koordinierenden Auftraggeber bereitgestellter frischer
Readback; **in diesem Repo nicht selbst verifiziert, keine Root-Cause-Behauptung**):

- BI-MC Task88 `task_88e85a41-099c-53e6-a310-53f549a674cf`, Master
  `task_a7b0aa7a-99e7-5588-b802-8091e281743c`, Monitor
  `monitor_7631f7c175b3496d9ddfaaea4e478e0f`.
- Ausgangspunkt: seit 02:45 UTC scheinbar ergebnislose native Recovery. Neuere
  read-only Diagnose: Recovery `EXIT 0` / `RESTORED_VERIFIED` bereits **02:49:40 UTC**;
  anschließend hängt ein held-status-Bashpart **ohne passenden Trägerprozess** (zwei
  Scans 09:12/09:16 UTC), während der Parent auf stale `running` wartet.
- Quelle: BI-MC-Diagnosesession `ses_ed09f4451ffePXjSIp9MmP4JXz`, Resultat
  `msg_12f68d760001aBxJtHb2ggmIRj`.
- Root Cause weiterhin **unbekannt**; ein Backend-Neustart als Ursache ist **nicht
  bewiesen**. Aus diesem Einzelbefund wird **kein allgemeiner Produktdefekt**
  behauptet.

Was daraus für dieses Konzept folgt (und nur das): Die heutige Engine-Sicht hätte
diese Konstellation (Parent wartet auf stale running, kein Trägerprozess beobachtbar,
kein Fehler-Evidence) als Dauern-`busy-held` ohne Tiefenpfad durchlaufen. Der
hier definierte adaptive Pfad hätte — unabhängig von der Ursache — nach 1 h eine
begrenzte read-only Untersuchung erzeugt und deren Ergebnis (Stufe D + B) transparent
als Merge-Key-Decision und begrenzte Eskalation sichtbar gemacht, ohne selbst zu
reparieren. Der Task88-Fall bleibt davon getrennt; aus ihm wird keine Verhaltens-
Sonderregel für diesen einen Fall abgeleitet.

---

## 10 Konzeptionelle Abnahmematrix

Jeder Fall: Vorbedingungen → Evidenz → erwartete Zustandsübergänge → **verbotene
Seiteneffekte**. (Abnahme später per Code-Review + Tests im Umsetzungsauftrag; hier
nur die konzeptionelle Matrix.)

| # | Fall | Vorbedingungen | Evidenz/Erkennung | Erwartete Übergänge | Verbotene Seiteneffekte |
|---|---|---|---|---|---|
| A1 | Legitimer Langläufer, kein Fehlabort | `long_work_evidenced` **ohne neues A-Ereignis**: die Untersuchung belegt legitime Aktivität über receipt-korrelierte B-Signale (attributierbare In-Flight-Turns am eigenen `dispatch_receipt`, bereits synthetisierte terminale Resultate) — explizit NICHT via Stufe A | Receipt-/Progress-Evidenz mit Worker-/Receipt-Bezug; Checkpoint-/Document-Änderungen allein genügen nicht | Leiter 2 h→4 h→8 h-Cap, jeweils ab `finished_at` der vorigen Untersuchung; `last_progress_at` bleibt unverändert; Kurzchecks unverändert | Leiter-Fortschritt setzt weder Fortschrittsuhr noch Backoff zurück (Reset nur durch echtes A, A8); kein Abort/Park/Abort-Send; kein Journal-Wachstum pro Tick |
| A2 | Hänger (kein Fortschritt, kein Fehler, busy-stale) | kein A-Signal ≥ 1 h; Status D/B; geprüft pro `worker_key`+`dispatch_receipt`-Episode | `DEEP_DUE` | Investigation (Budget §4.4: eine je Worker, globales faires Monitor-Budget, Claim) → `no_progress_evidenced`/`inconclusive` → begrenzte Eskalation; danach `cooldown_until = finished_at + T_cooldown` (keine bereits vergangene Frist, kein Due-Loop) | kein automatischer Abort des Turns; kein zweiter paralleler Dispatch; kein Park ohne deterministischen Grund; kein Observer-Lauf ohne expliziten Claim |
| A3 | Toter Child-Prozess (Receipt/Status tot, Session-Details weg) | Rebind nötig | `PROCESS_LOSS_SUSPECTED` + `ensureSession`-Rebind (`monitor-engine.ts:1022-1055`) | sofortige begrenzte Reconciliation über bestehende Pfade; Worker-Record bleibt konservativ (`reserved`-Reconciliation, `monitor.ts:807-830`) | keine Fallsenderklärung („sicher tot") ohne Beleg; kein Worker-Reuse ohne `reconcile`-Vertrag |
| A4 | Nach Neustart verlorener Subagent | Wechsel einer **benannten Generationsquelle** (`runtime_json`/`heartbeat`) ODER Session weg; Quelle unerreichbar ⇒ `generation_source_unavailable`, kein Neustart-Claim | Quellenvergleich P3; Rebind/Sessionverlust | Reconciliation via WAL/Rebind; Investigation-Zustand persistiert (Registry); Initialanker `null` ⇒ **genau eine** überfällige Prüfung nach Restart, dann neuer Anker; Backoff-Logik pausiert bis Reconciliation fertig | kein Fortschritts- oder Neustart-Claim aus Quellenwechsel allein; kein Verlust der Episode-Felder; kein Auto-Reset von Parks; kein wiederholtes Overdue |
| A5 | Stale busy (Parent wartet auf running ohne Substanz) | ≥ 1 h kein A-Signal trotz busy; **kein anderer Worker-Fortschritt maskiert diesen Worker** (pro `worker_key` geprüft) | Deep-Check liefert B/D-Mix ohne A | wie A2; zusätzlich transparente Merge-Key-Decision `investigation-inconclusive:busy-without-progress`; bei erkannter Fachentscheidungs-Lücke Eskalationspflicht §6 | busy allein setzt nie Uhren zurück; nie Abort auf busy allein (bestehende Regel, `monitor-engine.ts:472-479`); monitorweiter Fortschritt setzt die Uhr dieses Workers NICHT zurück |
| A6 | Spätes Resultat | Worker liefert nach Park/Investigation terminales Resultat | `observeWorkers` mark-complete → Worker-Index-Digest-Delta | normaler Manager-Wake mit Receipt (bestehend); `last_progress_at` setzt; offene Episode schließt sauber | keine Doppelverarbeitung; Resultat-Claim ohne Receipt zählt nicht |
| A7 | No-op-Digest würde fällige Prüfung unterdrücken | Board unverändert, Deep-Check fällig | P5 vor Shortcut | Shortcut wird für diesen einen Wake umgangen; danach wieder normale No-op-Ökonomie | keine dauerhafte Umgehung des No-op-Pfads; kein Wake-Storm (nur bei Fälligkeit) |
| A8 | Backoff-Reset | echtes A-Signal (§4.1 streng) — auch zwischen/mitts Untersuchungen | Stufe-A-Evidenz mit Worker-/Receipt-/Meilensteinkorrelation | `last_progress_at = Ereigniszeit`; `backoff_stage = 0` (konsistent mit §3.3); `next_deep_check_at = Ereigniszeit + T_first`; **Vorrang vor jeder Leiter** | Reset NUR durch A; Journal-Text/Heartbeat/Claims/eigene Untersuchungsnotizen resetten nie |
| A9 | Logspam-Schutz | lange Wartephase | `monitorDecision`-Merge-Key (`monitor.ts:526-550`) | wiederkehrende B/D-Notizen zählen in-place (first/last/count) | kein Append pro Tick; History-Limit 200 wird nicht durch Wiederholungen verbraucht |
| A10 | Berechtigungsgrenzen | Deep-Check findet Permission-/Fachentscheidungs-Lücke | pending input bzw. fehlende Grant-Abdeckung | Eskalation als INPUT_REQUIRED-Empfehlung/Aufmerksamkeit; Warten mit begründetem `wait_reason` | nie Permission beantworten/umgehen; nie Selbst-Autorisierung; keine Monitorkonfig-Änderung durch Untersuchung |
| A11 (V2, C1) | Wake-Claim-Crash (Engine-Prozess stirbt mitten im Wake) | `run.active` verwaist; `owner_generation`/`owner_pid` tot (Heartbeat-Probe) | Boot-Sweep §13.8 | einmaliger WAL/Receipt-Abgleich, dann `wake-claim-recovered`; danach normale Wake-/Observer-Übergabe; stuck-Claim bei frischem Heartbeat nur sichtbar (`wake-claim-stuck`), Release nach WAL/Evidenz | kein Release lebender Worker (frischer Heartbeat + gleiche Generation); kein stilles Freigeben bei unsicherem Dispatch (Park bleibt); keine parallele Recovery; Observer gibt nie frei |

**Priorisierung für die Umsetzung (V2):** P0 = A11, A2, A7, A8 (Kernvertrag:
Claim-Recovery, Hänger, No-op-Resorption, Backoff-Reset); P1 = A1, A4, A5; P2 =
A3, A6, A9, A10.

**Ehrliche Grenze der Matrix:** A3/A5 decken das Task88-Bild konzeptionell
(beobachtbare Symptome), nicht dessen unbekannte Ursache; ein „held-status-Bashpart
ohne Trägerprozess" ist mit heutiger Engine-Sicht nicht direkt erkennbar (F2) — die
Abnahme für A3 prüft deshalb das Verhalten bei den **erkennbaren** Facetten
(Rebind, Receipt-Verlust, Generation-Wechsel), nicht die Prozessdiagnose selbst.

---

## 11 Umsetzungsslices (späterer Auftrag; Reihenfolge und Patchplanung ohne Versionsnummern)

| Slice | Inhalt | Warum diese Reihenfolge |
|---|---|---|
| **S1 — Zustandsfelder + Fälligkeit** | additives `investigation`-Feld + Formvalidierung; `DEEP_DUE`-Check vor No-op-Shortcut (`monitor-engine.ts:416`); Zeitformeln §3.4; **kleinste Konfig-/Taskvertragsfläche an bestehenden `create_monitor`/`update_monitor`-Schemata (§13.3, additive optionale Felder, keine UI)**; **§13.8-Claim-Recovery (Fencing + Boot-Sweep)**; noch ohne Investigation-Lauf (Outcome nur `inconclusive`) | kleinster geschlossener Nutzen; beseitigt A7 und A11; reine Registry-/Engine-/Schema-Arbeit |
| **S2 — Klassifizierer + Cheap-Checks** | Evidenzstufen §4.1 (streng korrelierte A-Signale) auf bestehenden Quellen; pro-Worker-Uhren (`workers`-Map); O1-Beobachtertakt (F3) mit eigenem Claim/CAS/Lease | erst Uhren, dann zuverlässige Signale; A1/A5/A8/A9 abnahmereif |
| **S3 — Investigation-Lauf + Budgets** | begrenzter read-only Lauf (§4.4: eine je Worker + globales faires Budget + Claim); optionale Gateway-Erweiterung `getSessionProgress?` (§5.2); Eskalation inkl. §6-Park-/INPUT_REQUIRED-Pflicht | braucht S1+S2; A2/A3/A4/A6/A10 abnahmereif |
| **S4 — Deklarationen + optionaler Contract-Bump** | `update_monitor`-Felder (Tasktyp, Meilenstein, Zeitbudget-Overrides, `T_first`/`T_cooldown`); Wake-Prompt-Delta-Zeilen mit optionalem Contract-Bump („mgmt-v4" nur Vorschlag, keine reservierte Version); Hub-/MCP-Anzeige additiv (§5.7: `hub/monitor.py::_valid_registry`, `hub/monitor.js`-Karte, `get_monitor`-Felder) | Operator-Fläche zuletzt; Bump nur einmal und nur bei Missionstext-Änderung |
| **S5 — Generation-/Restart-Härtung** | expliziter P3-Generation-Vergleich; Episode-Überlebensprüfung nach Neustart | baut auf stabilem S1-S3 auf |

Patch-/Versionsplanung: jedes Slice = eigener Kandidat nach `docs/RELEASING.md`
(QC, exakter Commit-Nachweis, Adapter-/Script-Versionen konsistent — Muster
Journalfix-Paket, `task_278d4136`-Dokument §5). **Keine Release-Zuordnung wird hier
erfunden**; die Nummernvergabe erfolgt im späteren Auftrag nach dem dann aktuellen
Main-Stand.

## 11a Warum Priorität „high" (Vorschlag, zur Planung)

1. Direkt betriebene Blinder-Fleck-Beseitigung: Stillstand ohne Fehler-Evidence ist
   heute strukturell unsichtbar (No-op-Shortcut + Busy-Gate, §2.2/2.3).
2. Natürliche Fortführung zweier frisch integrierter Vorarbeiten (Gate-Fix be951293,
   mgmt-v3) — niedriges Integrationsrisiko durch etablierte additive Muster.
3. Der externe Befund (§9) zeigt die Betriebsrelevanz; die Planung sollte fertig sein,
   bevor der spätere Umsetzungsauftrag erteilt wird.
„High" autorisiert ausschließlich Voranstellung in der Planung; **keine Ausführung**.

---

## 13 V2 — Implementierungsvertrag für das Release-Paket task_e67c39cf (Operator-Go 2026-10-12)

Status dieses Abschnitts: **CONCEPT_READY_FOR_REVIEW** — Teil des Paket-Konzepts
(`planning/task-concepts/task_e67c39cf-d674-5a80-9760-d84b11c5056d-concept-plan.md`);
Umsetzung erst nach Review-PASS und Operator-Freigabe im gesonderten Schritt.
**Konzeptreview 2026-10-12: CHANGES_REQUIRED** (Bericht
`planning/task-concepts/task_e67c39cf-d674-5a80-9760-d84b11c5056d-concept-review.md`);
C1–C6 sind eingearbeitet: C1 → §13.8 + §13.7 + A11, C2 → §13.6, C4 → §13.3 (kleinste
Konfig-/Taskvertragsfläche je Operatorvorgabe, nicht „defaults-only"), Delta-Mapping
im Paketplan §10. V2 schärft V1 für die Umsetzung; wo V2 abweicht, gilt V2,
die V1-Kapitel bleiben als Historie unverändert stehen.

### 13.1 Zustandsprimat je Worker-Episode (ersetzt die gleichrangigen V1-Ebenen aus §3.1)

Primärer persistenter Zustand ist ausschließlich `investigation.workers[]` — je
`worker_key` + `dispatch_receipt`-Episode: `last_progress_at`, `cooldown_until`,
`next_deep_check_at`, `backoff_stage`, Episode-Evidenz. Die monitorweiten Felder
(`last_progress_at`/`backoff_stage`/`next_deep_check_at` auf Monitorebene) sind
**nur abgeleitete Projektionen** (Aggregat für Anzeige/`get_monitor`), nie
selbstständige zweite Uhren. Ein Episodenwechsel (neuer `dispatch_receipt`) beginnt
eine frische Worker-Uhr; alte Episoden bleiben als Historie im limits-Bereich
(begrenzt, max. 8 wie V1).

### 13.2 Erstdispatch-Anker statt null-Sofortuntersuchung (ersetzt V1 §3.4 „Initialanker")

- `last_progress_at = null` (Erstbeobachtung, Upgrade, Registry-Neuaufbau) führt
  **nicht** zu einer sofortigen/überfälligen Untersuchung. Anker ist der
  **tatsächliche Dispatch** der Episode: `worker.dispatch_receipt`-Admission bzw.
  `dispatch_wal.at`, ersatzweise der `creation_receipt`-Zeitpunkt; erste
  Deep-Prüfung erst `T_first` nach diesem Anker.
- Nicht ermittelbarer Dispatch (unbekannter überfälliger Restartfall, Episode ohne
  Receipt): **einmalig** begrenzte Reconciliation über die bestehenden Pfade
  (WAL/Rebind, §5.4); danach Anker = Reconcile-Abschluss. Keine
  Untersuchungsserie, kein Overdue-Loop. Liefert auch die Reconciliation keinen
  Anker: Anker = erste Beobachtung + `T_first`, transparent als Merge-Key-Decision
  `investigation-anchor-unknown` plus `counters.anchor_unknown_total`.

### 13.3 Budget/Fairness/Deferral ohne starres Taglimit (ersetzt V1 §4.4 „max. 4/Tag")

- Unverändert strikt: höchstens **eine** laufende Untersuchung je Monitor; höchstens
  eine je Worker-Episode zugleich.
- Fairness: pro Wake/Round höchstens eine Investigation, Rotation über fällige
  Worker (älteste Fälligkeit zuerst).
- **Kein starres 4/Tag-Limit**: Zurückstellen (Deferral) geschieht nur mit
  expliziter, transparenter neuer `next_deep_check_at` (z. B. verschoben um eine
  Backoff-Stufe oder `T_cooldown`) — nie stilles Fallenlassen; jede Verschiebung
  erscheint als Merge-Key-Decision mit Grund und nächster Due-Zeit. Optionale
  konfigurierbare Tages-/Gesamtbudgets sind nur zulässig, wenn sie den
  1-h-Cooldown bzw. die 2/4/8-h-Leiter nicht verunmöglichen (Kompatibilitätsprüfung
  fail-closed im Engine-Code).
- **Konfig-/Taskvertragsfläche (kleinste nötige, in diesem Paket, Slice S1 —
  Operatorvorgabe, ersetzt die „defaults-only"-Empfehlung des Reviews):** additive,
  optionale Eingabefelder an den **bestehenden** Tools `create_monitor`/
  `update_monitor` (tools.ts-Schema; keine neue UI, keine neuen Tools):
  `investigation { first_check_s, cooldown_s, ladder_s[3], max_duration_ms,
  max_calls, max_bytes }` sowie `task_contract { task_type: default|long_runner|
  milestoned, expected_milestone, milestone_due_at }`. Defaults (3600 / 3600 /
  [7200, 14400, 28800] / 300000 / 10 / 262144) sind **projektspezifische
  Anfangswerte, keine universelle Produktanforderung**; sichtbar im
  `get_monitor`-Output. **Keine neue Autonomie:** die Felder konfigurieren nur
  Betriebszeiten/Meilensteine der read-only-Untersuchung; Autonomieprofile, Grants
  und Berechtigungen bleiben unverändert (V1 §6, `agent-control.ts:255-269`).
  Die Leiter gilt **universell ab positiv belegter Langarbeit**, auch ohne
  `task_type`-Deklaration; Deklarationen schärfen nur Fristen/Meilensteine
  (V1 §4.3-Verhalten), nie Autorität. Hub-Visualisierung bleibt späteren Paketen
  vorbehalten (S4).

### 13.4 Evidenz (Verschärfung von V1 §4.1)

- Untersuchungsergebnisse — inklusive eigener Notes und Merge-Key-Entscheidungen —
  sind **nie** Fortschritt.
- **Longwork positiv** nur bei mindestens einem:
  - (a) attributierbarer Werkzeugfortschritt am eigenen `dispatch_receipt`: via
    `getSessionProgress` zeigen In-Flight-/fertige Tools dieser Episode ein Delta
    seit der letzten Beobachtung (neue `call_id`s, Statusübergänge, fortschreitende
    Zeitstempel);
  - (b) Journal-Checkpoint/Management-Eintrag mit **receipt-korrelierter**
    Meilensteinreferenz (Inhalt verweist auf Receipt/Taskfortschritt, nicht nur
    Text);
  - (c) ein nach der vorigen Untersuchung neu admissionierter Schritt mit frischem
    Dispatch-Receipt und begründeter `wait_reason` — Arbeit ist belegt in-flight.
- **Nicht ausreichend (→ `inconclusive`)**: stale `running` ohne Attribution,
  bloßes In-Flight ohne Delta, Coverage `partial`, fehlende Progress-Telemetrie,
  reine Board-Buchhaltungsänderungen. „Stale running"/bloßes Inflight allein
  begründet die Leiter nicht.
- A bleibt wie V1 §4.1: semantisch belegter, korrelierter Fachfortschritt.

### 13.5 Overrides ohne falschen Progress-Reset (präzisiert V1 §3.3/§10-A8)

`ERROR` (evidenzbasiert), `PROCESS_LOSS_SUSPECTED`, `GENERATION_CHANGED`/Reconcile
**überholen** die Uhr: Fälligkeit wird angehalten (clock hold), begrenzte
Reconciliation erzwungen — und `last_progress_at` wird **nicht** berührt. Nach
abgeschlossener Reconciliation gilt Anker = Reconcile-Abschluss (neue Episode),
`backoff_stage` unverändert. Nur echtes A setzt auf 0 und verankert neu. Damit ist
V1 §3.4 („überholen die Uhr jederzeit") mit der Reset-Regel (§10-A8) widerspruchsfrei.

### 13.6 Park-/Routing-Konsistenz (V1 §6/A10 unverändert, eine Klarstellung)

Unbekannte Fehler erhalten kein freies Routing (Provider-Admission-Set unverändert,
`agent-control.ts:255-269`); Parks nur auf bestehenden Pfaden; fehlende
Fachentscheidung → Pflicht nach V1 §6. Klarstellung V2: der Observer (13.7)
**bemerkt** Park/Recovery nur (Decision/Attention), löst sie aber nie aus.
**Kette ehrlich (C2):** die Untersuchung injiziert niemals direkt Attention/Events —
heutiger Code speist `get_project_attention` **nicht** aus Engine-Decisions
(`attention.ts:10-18` leitet Prepared Attention ausschließlich aus Activity-Events
ab). Belegte Hops: Engine-Decision additiv lesbar via `get_monitor`/
`get_monitor_history` (On-Demand) und Engine-Wake der Manager-Session → Manager
eskaliert selbst via bestehende Attention-/Journal-Tools (Missionsvertrag,
`monitor-engine.ts:1540`). PROACTIVE_MONITORING-Zusagen bleiben an diese bestehende,
namentlich verifizierte Kette gebunden — nie aus Engine-Decisions allein.

### 13.7 Minimaler unabhängiger cheap observer (präzisiert V1 §5.6/F3)

- O1: zweiter Takt im Engine-Prozess, strikt read-only, eigener Claim als
  **Lease-Eintrag in der Registry** (TTL + Generation-CAS via `withRegistry`; keine
  zweite Lock-Datei außerhalb der Registry).
- Zweck: Due-Ermittlung und billige Status-/Receipt-Reads unabhängig davon, ob der
  Wake-Pfad gerade im No-op-Shortcut (`monitor-engine.ts:416-432`) oder im
  Busy-Gate (`472-479`) endet — das Due-Signal darf von keinem der beiden absorbiert
  werden; Ergebnisse erscheinen immer als sichtbare Merge-Key-Decision.
- Kein Send/Recovery/Abort aus dem Observer; fällige Aktionen werden dem nächsten
  regulären Wake zugeführt (der bestehende `wake_request`-Mechanismus,
  `monitor-engine.ts:238-246`, ist der Übergabeweg).
- Minimalität: Registry-Write nur bei fälliger Prüfung oder offener Episode —
  sonst kein Write (kein Logspam).
- **Übergabegrenze ehrlich (C1):** die Unabhängigkeit des Due-Signals endet an der
  Übergabe an den nächsten regulären Wake; dessen Verfügbarkeit wird durch die
  Claim-Recovery (§13.8) garantiert. Der Observer setzt selbst keinen Claim
  zurück, macht einen erkannt stuck-Claim aber als Merge-Key-Decision sichtbar.
- **Position P5 (V1 §3.3), zitiert (C1b):** der Due-Check liegt vor dem No-op-
  Shortcut (`monitor-engine.ts:416-432`) **und** vor dem Busy-Gate (`:472-479`) —
  die fällige read-only Untersuchung wird damit auch bei busy/blocked Worker
  ausgeführt (Task88-Bild); keine Absorption durch `noop-unchanged` oder
  `busy-held`.

### 13.8 Wake-Claim-Recovery (C1, Blocker — verwaister `run.active`-Claim)

**Befund (Code):** `monitor-engine.ts:272-275` verwirft jeden Wake bei
`run.active` als `wake-skipped/run-active`; zurückgesetzt wird der Claim nur durch
`release()` (`:300-311`) bzw. den Read-Failure-Pfad (`:997`); `monitor-main.ts`
fährt keinen Boot-Sweep. Stirbt der Engine-Prozess mitten in einem Wake, bleibt
der Claim persistent in der Registry und absorbiert jede spätere Wake — inklusive
des Observer-`wake_request` (§13.7).

**Vertrag (minimal, ausschließlich bestehende Mechanik):**

1. **Claim-Identität/Fencing:** `run` erhält additive Felder `owner_pid` +
   `owner_generation` (Quelle: Heartbeat/Runtime, `monitor-main.ts:106-118`);
   Mutationen via `withRegistry`-CAS — ein fremder Writer kann einen fremden
   Claim nie blind überschreiben.
2. **Boot-Sweep beim Engine-Start:** für Monitore mit `run.active` und
   (`owner_generation` ≠ eigene Generation **oder** `owner_pid` nachweislich tot
   per Heartbeat-PID-Probe) genau ein Recovery-Durchgang: zuerst **unsicheren
   Dispatch reconcilieren** (bestehender WAL-Pfad, `monitor-engine.ts:380-408`,
   `reconcileDispatch` `:1486-1506`), dann Claim mit sichtbarem History-Eintrag
   `wake-claim-recovered` freigeben. Unauflösbar unsicherer Dispatch bleibt der
   bestehende `dispatch-uncertain`-Park — nie stilles Freigeben.
3. **Aktiver Hang ≠ Crash/Restart:** frischer Heartbeat + gleiche Generation ⇒
   der Claim gilt als aktiv; **Boot-Recovery gibt keinen blockierten, lebenden
   Worker frei.** Ein intern inkonsistenter Claim (frischer Heartbeat, aber
   Claim-Alter über einer konfigurierbaren Obergrenze, Default 10× Intervall)
   wird einmalig pro Episode begrenzt reconciliert und als
   `wake-claim-stuck`-Decision sichtbar gemacht; Release nur nach demselben
   WAL/Evidenz-Kriterium wie in 2.
4. **Keine parallele Recovery:** der Sweep läuft unter demselben
   `withRegistry`-CAS/Fencing; eine laufende fremde Recovery wird nie überholt.
5. **Observer-Interaktion:** der Observer bleibt bei blockiertem Call
   beobachtungsfähig (eigene Lease, strikt read-only, §13.7), erkennt und
   dokumentiert stuck Claims — die Freigabe übernimmt ausschließlich die
   §13.8-Recovery des Engine-Besitzprozesses.

---

## 12 Quellenregister (V1-Basis: read-only, Stand `b7aa264`, 2026-10-12; §13-Addenda am Ende)

| Quelle | Ort | Verwendung |
|---|---|---|
| Monitor-Engine | `adapters/mcp/src/monitor-engine.ts` (1653 Z.) — u. a. `PRIMING_CONTRACT`:147, `tick`:226, `runWake`:331, No-op-Shortcut:416-435, `observeWorkers`:598, Receipt-Watch:754-854, `snapshotCanonical`:894, `ensureSession`:1022, `recover`:1114, `compactionContinue`:1376, `reconcileDispatch`:1486, `buildPrimingBlock`:1526, `buildWakePrompt`:1571, `classifyEvidence`:1612, `classifyRepairKind`:1646 | Ist-Fluss, Einfügepunkte, Evidence |
| Registry/Datenstrukturen | `adapters/mcp/src/monitor.ts` (983 Z.) — `MonitorRecord`:222-271, `MonitorWorkerRecord`:159-200, `receipt_observation`:216-220, `shapeOk`:346, `withRegistry`:479, `monitorDecision`:526, `recordRepair`:552, `readEpisode`:606, `workerIndexDigest`:969, Defaults:24-25 | Persistenz-/Validierungsmuster, additive Felder |
| Engine-Service | `adapters/mcp/src/monitor-main.ts` (155 Z.) — Loop:125-130, Heartbeat:106-118, Runtime-Validierung:44-56, Gateway-Timeout:71 | Takt, Generation, Budgetgrenzen |
| Session-Evidenz-Typen | `adapters/mcp/src/types.ts` — `SessionStatusResult`:135-155, `SessionProgressResult`:167-188, `HistoryMessage`:204-218 | Klassifizierer-Grundlage, Gateway-Lücke |
| Gateway-Implementierung | `adapters/mcp/src/opencode.ts` — `getSessionProgress`:124/1230 | Wiederverwendungsbaustein (nicht im Engine-Contract) |
| Recovery-Policy | `adapters/mcp/src/agent-control.ts` — `PROVIDER_ERROR_ADMISSION`:255, `isRecoveryProviderAdmission`:264 | Grant-Grenzen der Recovery |
| Task-Dokumente/Board | `adapters/mcp/src/taskboard.ts` — `validDocumentPath`:181-190, Bindings:380-411, Task-ID-Prüfung:542-545; `docs/MCP-INTERFACE.md` (Monitor-Abschnitt ab Z. 816, Taskboard-/Journal-Abschnitte) | Registrierungsvertrag dieses Konzepts, Journal-/Checkpoint-Semantik |
| Aufmerksamkeit/Events | `adapters/mcp/src/attention.ts`, `events.ts` | Eskalationskanäle (bestehend) |
| Hub-/Monitor-UI (Ist-Anzeige) | `hub/monitor.py` (`snapshot` Z. 165, `mutate` Z. 145, `_valid_registry` Z. 66, `read_heartbeat` Z. 271), `hub/monitor.js` (Kartenrenderer Z. 136-145, `freshness` Z. 52-55, Details Z. 167) | §5.7 Anzeigeverortung, read-only geprüft |
| V2-Addenda (2026-10-12) | Paketmaster `task_e67c39cf-d674-5a80-9760-d84b11c5056d` (Board, `in_progress`); Skill r51 (`integrations/chatgpt/bundle.json` revision `2026-10-10-r51`; SKILL.md:310-312, `references/events-attention.md`, `references/regression-scenarios.md:170/219/455`, `references/monitor-reporting.md` r50, keine `communication-states.md`); Git-Evidenz (`0320c8d`, `01070210`, `09c7348`, `84b95f5`, `4659b59`, `30ec6e6` — alle Ancestors von `b7aa264`) | §13 Vertragsgrundlage |
| Verwandte Dokumente | `planning/task-concepts/task_278d4136-monitor-journal-writer-contract-20261012.md`; `planning/task-concepts/task_be951293-e41a-5d69-a394-b0d9c944c960-concept-plan.md` (Gate-Fix §12, QC-G1) | Präzedenzmuster, Abgrenzung |
| Live-Verifikation (read-only) | `get_project_task`/`list_project_tasks` über den MCP-Konnektor dieser Session (Port 40960, Token-Auth): Ziel-Task (`todo`, high, `documents: []`), vier Abgrenzungs-Tasks (§8), Dedupe-Suchen (§8a); `heartbeat.json` (Generation/PID) | Board-Status, Dedupe, Betriebsnachweis |
| Task88-Motivation | überlieferter Readback (§9): `ses_ed09f4451ffePXjSIp9MmP4JXz` / `msg_12f68d760001aBxJtHb2ggmIRj` | ausschließlich Motivation, keine Root-Cause |

**Dokumentverifikation:** Dieses Dokument (Concept-Plan **V2**; V1 + Korrekturpass 1
als Historie erhalten) wurde nach dem Schreiben per Readback geprüft — Dateiinhalt
plus registrierte Revisionen via `get_task_documents` — nicht durch Testlauf, gemäß
Auftrag. V1-Änderungsliste (Korrekturpass 1): Cooldown ab `finished_at` statt
vergangener Fristen; Leiter ab Untersuchungs-ENDE; PROGRESS/A überall „Reset auf
Stufe 0, Vorrang vor Leiter"; A-Evidenz streng korreliert; pro-Worker-Uhren +
Observer-Claim; Garantien qualifiziert; Generationsquelle benannt; §6-Eskalation
verpflichtend; §5.7 Hub-Anzeigeverortung; „ausschließlich gelesen" auf Produktquellen;
„mgmt-v4" nur Vorschlag. **V2 (§13) ersetzt für die Umsetzung: §3.1 Ebenengleichrang,
§3.4 Initialanker, §4.4 Taglimit; präzisiert §4.1 Longwork, §3.3/§10-A8 Overrides,
§5.6/F3 Observer.**
