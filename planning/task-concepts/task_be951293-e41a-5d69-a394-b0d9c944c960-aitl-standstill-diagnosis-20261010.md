# Diagnosebericht: AITL Monitor-Recovery-Stillstand (2026-10-10) — Rev. 2

Auftrag: begrenzte kausale Diagnose, strikt read-only; doc-only Abschluss.
Kein Wake, Reset, Fix, Trigger, Recovery, Restart, keine Produktcodeänderung,
keine Tests, kein Commit/Mainänderung, kein Deploy. Gegenstand: Master
`task_187995a9…`, Monitor `monitor_9d136952…`, Manager `ses_edabea627…`,
letzter Dispatch 2026-10-10T12:05:10.544Z, Receipt `msg_e2668186…`
(terminal failed 12:12:33, `ProviderHeaderTimeoutError`).

**Zuordnung:** Konkretes offenes Bugfinding für WP
`task_be951293-e41a-5d69-a394-b0d9c944c960` (Monitor-Zuverlässigkeit/Diagnose).
Keine neue Doppelaufgabe; Board-Verknüpfung übernimmt der Orchestrator separat.
Dieser Bericht enthält eine Korrekturoption, **keine Implementierungsfreigabe**.

**Evidenzquellen:** (1) Codeanalyse des lokalen Main-Checkout (Integration
`13eea502`); (2) verifizierte Livebelege aus der AITL-Diagnosesession
`ses_ed9c6c5adffe6XN0p0lddkSuKb` (Abschlussreceipt
`msg_bbacae7af1b7426aa6e8443ec1e8b352`, Terminaloriginal
`msg_126491e71001y576hEqZWxdQZQ`, vollständig 13572 B durch den Orchestrator
gelesen, SHA256
`576f10b468bf868f16cc127b3a2268af314bc0acf802993cd0c9693ec9606123`;
Livebeobachtung 14:32:10–14:39:43 UTC, strikt read-only). Die frühere
Zugriffslücke (Rev. 1 §4) ist damit durch diese **zweite unabhängige
Untersuchung** geschlossen — nicht durch eigenen Livezugriff dieser Session.

## 1. Zeitlinie (Belege)

| Zeit (UTC) | Ereignis | Quelle |
|---|---|---|
| 09:51:45.210 | Live-Engine-Prozess PID 47913 startet (Node 22.23.3); Engine-Dist mtime 09:18:24.482Z, SHA256 `d3f21030…3b22b1`, Source-SHA `9487bb27…060f6a5` stimmt `.files.sha256` überein | Live (2) |
| 10:01:01.921 | Erster `noop-unchanged`-Merge-Eintrag (`first_at`) | Live (2), korrigiert Rev. 1 |
| 10:23 / 10:34 / 10:45 / 11:05 / 11:40 / 11:53 | 6 frühere Recovery-Episoden — jeweils **konkrete Digeständerung nach Dispatch** (M1-A idle/M1-B create+rebind+failed; M1-B complete 10:26; M1-C complete 10:39; M1-D create 10:49; M1-E create 11:31; M1-E complete 11:46); letzter Recovery-Fingerprint 11:53:09.768 | Live (2) |
| 12:05:10.544 | Wake → Dispatch admitted, Receipt `msg_e2668186…`; Release setzt `last_seen_digest`, `worker_digest`, `dispatch_wal.message_id`; History `dispatched`. M1-F im selben Tick idle; danach kein Workerereignis, übrige Worker idle/archived | Code `monitor-engine.ts:536-554` + Live (1)(2) |
| 12:12:32.997–12:12:33.094 | Manager-Turn terminal failed: idle 12:12:32.997, message.failed 12:12:33.094, Receipt terminal failed 12:12:33.049; `ProviderHeaderTimeout` 60000 ms, retryable, Fingerprint `1407eefc…29674bc`; Assistant-Error `msg_125b430f…`; kein pending input | Live (1)(2) |
| 12:13 → 14:39+ | Jeder 60s-Tick: `observeWorkers` ohne Delta (candidate_count 0) → WAL i.O. (`message_id` gesetzt) → **Noop-Gate** → `noop-unchanged`, `next_run_at += 60 s` | Code + Live (2) |
| 14:32:27.636 / 14:34:27.786 / 14:39:28.174 | Merge-Eintrag `canonical-and-worker-index-unchanged` count 174/gen 2363, count 176/gen 2367 (next 14:35:27.786), count 181/gen 2377 (next 14:40:28.174); scheduler enabled, `run.active` false | Live (2) |
| — | `recovery.active` false, `recovery_episode` null, kein Recovery seit 12:05; `no_progress` 0, acht Budgeteinträge alle `excluded` — keine Budget-/Policyerschöpfung; Status-Read/`recover()` unerreicht | Live (2) |

## 2. Harte Code-Belege (Checkout Main, Integration 13eea502; src≡dist verifiziert)

Live (2): src-Zeilen = dist-Zeilen — Gate `monitor-engine.ts:413-425` =
`dist/monitor-engine.js:269-276`; Status-Read `:442` = dist 291; `classifyEvidence`
`:458` = dist 306-310; WAL-Bedingung `:380` = dist 236; `observeWorkers`
`:589-592` = dist 432-435.

1. **Noop-Gate vor Status-Read:** `runWake` kehrt bei unverändertem Digest
   unverändert mit `noop-unchanged` zurück (`monitor-engine.ts:413-426`) —
   **bevor** der Manager-Session-Status mit Receipt-Korrelation gelesen wird
   (`:442`) und bevor `classifyEvidence` Recovery auslöst (`:458-461`).
2. **Dispatch verankert den Digest:** Erfolgreicher Dispatch setzt
   `last_seen_digest`/`worker_digest` auf den Stand des Dispatch-Zeitpunkts
   (`:536-539`). Ein späterer terminaler Manager-Fehler ändert beides nicht.
3. **WAL-Reconciliation greift nicht:** nur für `message_id === null`
   (`:380`); hier seit 12:05 gesetzt (`msg_e2668186…`).
4. **observeWorkers deckt nur Worker, nicht den Manager:** Kandidaten sind
   `monitor.workers` mit `runtime_session_id`+`dispatch_receipt`
   (`:589-592`); live `candidate_count` 0. Welle A (e0c5ce3) adressierte
   ausdrücklich nur failed-**Worker**-Beobachtung.
5. **Policy/Chain wäre nicht der Blocker:** `provider_header_timeout` ist
   Provider-Admission (`agent-control.ts:256,264`). Live Policy40
   (14:34:27): deep `alibaba-token-plan/qwen3.8-max/xhigh`, deepFallback
   `zai-coding-plan/glm-5.3/low`, degrading/providerSkip true (frühere
   Episoden Rev 37; Policyänderung von anderer Stelle, Diagnose änderte die
   Policy nicht). Kette hätte gewählt — Recovery wurde nie erreicht.
6. **Blindspot ungetestet:** Der Noop-Test (`monitor.test.ts:330-363`)
   kombiniert nie terminal fehlgeschlagenen Manager-Turn mit unverändertem
   Digest; der Wave-A-Fall (`monitor.test.ts:2062 ff.`) betrifft einen
   dedizierten Worker.

**Live bestätigt (2):** WorkerDigest eigenständig berechnet
`3b5e04e078813102da46ff4fb0917f17172edcdd596d6fff793081cbff322317` =
`state.worker_digest`; `wake_request`/`abort_request` null; `read_episodes`
{}; Board-unchanged durch Engine-Grund belegt (nicht separat nachgerechnet).

## 3. Kausale Ursache (nachgewiesen; Confidence hoch)

**Das Noop-Gate (`monitor-engine.ts:413-425`) short-circuited jeden Tick, bevor
der receipt-korrelierte Manager-Status-Read (`:442`) und die
Evidence-Klassifikation/`recover()` (`:458 ff.`) erreicht werden.** Ein
terminaler Manager-Fehler, der weder Board-Digest noch Worker-Index ändert und
kein `wake_request` setzt, wird als `noop-unchanged` konsumiert: keine
Recovery-Dispatch, kein transparentes Park, stiller Stillstand bei laufendem
Scheduler. Die 6 früheren Recovery-Episoden hatten jeweils konkrete
Digeständerungen nach dem Dispatch (Workerereignisse, §1) — damit war das
Gate geöffnet; diesmal (Dispatch erfolgreich → Turn terminal fehlerhaft →
Board 2,5 h unverändert, kein Workerereignis, M1-F im selben Tick idle)
bleibt es zu. Konsistenzbeweis: Der abgebrochene manuelle `trigger_monitor`
würde `wake_request` setzen und das Gate passieren (Nutzer-Veto, nicht
ausgeführt).

**Korrektur der Rev.-1-Prognose (Wahrheitstreue):** Der Merge-Eintrag trägt
`first_at` 2026-10-10T10:01:01.921Z, **nicht** ≈12:13 — `monitorDecision`
(`src/monitor.ts:495-519` / dist 348–366) aktualisiert den bestehenden Eintrag
an alter Position in place, weshalb der History-Tail weiterhin 12:05
(`dispatched`) zeigt; „≈12:13 erster Tick nach Fehler" ist eine Ableitung,
kein eigener Einzeltrace.

**Lautloser Pfad live bestätigt (2):** Registry `logs` [] leer;
Zielmonitor-stderr nur 6 Zeilen, alle vor 12:05, keine neue Zeile — der
Gate-Pfad produziert keinerlei Operational-Logzeile. Attention failed/ready
deliveries []; die Engine liest Attention nicht — **kein** eigener
Attention-Architekturfehler behauptet.

## 4. Ursache vs. Hypothese (nach Liveschließung)

- **Nachgewiesen:** §2/§3, Code (src≡dist, SHA-gepinnt) und Live (2).
- **Geschlossen:** Rev.-1-Zugriffslücke (Live-Registry/History) durch die
  zweite unabhängige Diagnosesession; Rev.-1-Hypothese zu früheren Episoden
  (Digeständerung nach Dispatch) ist jetzt Livebefund.
- **Verbleibend dünn:** genaue Einzeltrace-Zuordnung des ersten Post-Fehler-
  Ticks (abgeleitet, s. o.); keine Auswirkung auf die Ursachenkette.

## 5. Kleinste spätere Korrekturoption (NICHT implementiert/gestartet; keine Freigabe)

Empfehlung (übereinstimmend mit Live-Diagnose (2)): **eigenen
Manager-Receipt-Zustand vor dem Gate bzw. in der Änderungsdetektion prüfen**
(receipt-korrelierter Status-Read wie `:442`, read-only; Gate passieren lassen
oder — analog Welle A beim Worker — einen Receipt-Outcome-Marker in die
Änderungsdetektion falten) **plus idempotente Verarbeitung des klassifizierten
Fehlers**, damit `classifyEvidence → recover()` bzw. das transparente Parken
erreicht wird, ohne Doppel-Dispatch. Genaue Implementierung, Tests und
Release sind ein separater, explizit zu beauftragender Schritt im WP
task_be951293 (Diagnose-Buildsession beibehalten; Autor-Session idle).
Dieser Bericht enthält keine Implementierungsfreigabe.

## 6. Sicherheitsgrenzen eingehalten

Beide Untersuchungen strikt read-only; kein Schreibzugriff auf Live-Registry,
Scheduler, Policy, Prozesse, Sessions; keine Tests, Trigger, Wake/Reset/
Recovery, Restarts, Monitor- oder Codeänderungen; kein Commit/Mainänderung,
Deploy oder Push; kein wiederholter Trigger-Versuch; keine Secrets; keine
fremden Projektdaten über die übergebenen IDs hinaus. Einzige Persistenz:
dieser redigierte Bericht (doc-only) und ein additiver Verweis im
CompactContext des WPs ohne Verdrängung vorhandener Informationen.
