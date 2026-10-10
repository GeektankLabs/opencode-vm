Task-ID: task_be951293-e41a-5d69-a394-b0d9c944c960
Title: Work Package: Monitor-Zuverlässigkeit und Diagnose vorbereiten (Konzept, reviewbar)
Stand: 2026-10-10 · Status: Welle A implementiert (lokal, isolierter Worktree, kandidatenbereit zur unabhängigen QC) · Implementierungs-Go erteilt · Historie: CONCEPT_PASS (Rev. 3, unabhängig geprüft), Entscheidungsvorbereitung abgeschlossen 2026-10-09
Last-concept-update: 2026-10-09T20:53 UTC (historisch: Abschlussmetadaten Rev3-CONCEPT_PASS; Inhaltsrevision unverändert SHA1386d074…; die damit offene Produktentscheidung 4.6/§8a ist mit dem Go vom 2026-10-10 entschieden, siehe §11) · Last-implementation-update: 2026-10-10 (Welle A commit e0c5ce3ce0c2362f253ef2a1488540227c0050e5 auf Branch task/be951293-wave-a; §11 aktueller Stand)

## 1 Ziel / Nichtziele

Ziel: Zusammenhängendes, schlankes Optimistic-MVP-Konzept, das (a) den failed-Worker-Fall
funktional (Receipt-/Digest-/Recovery-Kette, gemeinsame Schema-4-Policy) und (b) diagnostisch
(Entscheidungslogs, frische begrenzte kopierbare Textansicht) behandelt — bis reviewbar /
implementierungsreif, ohne Duplikation der kanonischen Tickets.

Nichtziele: keine Produktcodeimplementierung, keine Tests/Live-Faults, kein Main-Änderung/Merge,
kein Monitor-/Scheduler-/Policy-/Runtimeeingriff in laufende Sessions, kein Restart/Stop/Trigger,
keine AITL-Rettung, kein zweiter Owner für task_efbe63cf / TP88 / Demo-Arbeiten, keine
Retryzahlen/Wartezeiten/Budgets erfinden, keine ungebetene Featureausweitung (Filter, Download,
Auto-Follow, Dashboards).

## 2 Kanonische Tickets (nicht dupliziert, gelesen aus Board-DB)

- `task_be951293-…c960` (dieser Anker, Masterticket, Status todo): Wellen A–D, gemeinsame Abnahme.
- `task_ad26435f-…7667` „Monitor-Selbstrettung an gemeinsame Fallback-Policy anbinden“ (todo):
  kanonisch für Auswahlvertrag, Korrelation/Persistenz, Primary-Rückkehr, Abnahmematrix A–J,
  offene Erschöpfungsentscheidung, AITL-Policy-Snapshot (Schema4 rev36).
- `task_6679fb88-…41a8` „Monitor-Diagnose: Entscheidungslogs und kopierbare Textansicht“ (todo):
  kanonisch für Logging-/Privacy-/Refresh-/Begrenzungsanforderungen, Logsink-Klärung
  (server.log statt Journal), Abnahmematrix A–E, konkreten AITL-Fall.
- Unabhängige Prüfung: `planning/task-concepts/task_be951293-e41a-5d69-a394-b0d9c944c960-concept-review.md`
  (finale Fassung SHA256 `0a4a9989b4c5fe2917f7a710d9af4353ee0c0167d2d87ed570caa80b67a0cf95`:
  **Rev3 = CONCEPT_PASS** für Plan SHA `1386d074…` / Context SHA `0ed2e3d5…`; Reviewerterminal
  `msg_1226f567a0015GAG1kSzIgf9ZO`; historische Befunde B1–B9/R1/R2/K1/K2 erhalten;
  Auflösungen in Abschnitt 10). Keine weitere unabhängige Nachprüfung ausstehend.

## 3 Belegter Ist-Stand (Main 8936f621f86e4ff96b69bcc8c849a996d8ba26c0, CLI 0.7.30, Adapter 0.1.41; am 2026-10-09 lesend erneut verifiziert)

Alle Zeilenangaben diesmal direkt am Quellstand geprüft; Versionsgleichheit der Live-Deployments
bleibt davon unberührt (kein Byte-Nachweis).

`adapters/mcp/src/monitor-engine.ts`:
- :165 `if (this.waking) return "skipped"` — concurrent waking still (kein Log).
- :183 `no-due` ohne History/Log.
- :297–302 Entscheidungskerne: `summary.digest` vs. `state.last_seen_digest`,
  `workerIndexDigest(monitor)` vs. `state.worker_digest`, zusätzlich `wake_request`.
- :308–334 WAL-Reconcile vor Admission/noop; `dispatch-uncertain` parkt nach `parked_input_required`.
- :342 und :465 `noop-unchanged` ohne History-Eintrag (der stille Early-Return).
- :359,:375–378 `getSessionStatus(…, dispatch_wal?.message_id)`; Recovery wird aus
  klassifiziertem terminalem Fehler automatisch aufgerufen.
- :476–505 `observeWorkers`: nur `state === "completed"` und `backend_activity === "idle"`
  werden übernommen (:489 `continue` für alles andere, :487 catch/continue bei Statusfehler);
  :498–499 setzt `lifecycle="idle"` + `result_receipt`. **Ein terminal failed Worker erzeugt
  keinen Digestwechsel und damit keinen Manager-Wake — das ist die plausible, noch nicht
  live bewiesene Ursache des AITL-Falls.**
- :698–749 `resolveRuntime`: liest Policy frisch pro Dispatch (Primary-Rückkehr grundsätzlich
  vorhanden); :735–737 Post-Update-Readback prüft Provider+Modell, **nicht die Variante**
  (der `already`-Vergleich vorher prüft Variante mit).
- :~798–849 `recover()`: Legacy-Kette via `fallbackChain()`; `attempted` lokal pro Aufruf —
  kein persistentes Gedächtnis, kein Profilfallback, keine Strategie-Schalter.
- :~1131–1155 `classifyEvidence` (`state==="failed"`, letzter Fehler; `aborted` → none;
  `unknown` operativ) + `OPERATIONAL_CATEGORIES`/`classifyRepairKind` (W2-Budget).
- :~1186–1206 `fallbackChain()`: nur `finalFallback.mode==="degrading"`-Abstieg plus globale
  Finalstufe — ignoriert Schema-4-`profileFallbacks`, `strategies`, Regime.

`adapters/mcp/src/monitor-main.ts`: :80–82 reduziert `policyView` auf `{finalFallback, profiles}`
— Schema-4-Felder fehlen der nativen Sicht. :~97–108 Heartbeat (projektlokal);
:~128–137 Ownership-Watch beendet still bei verändertem `runtime-input.json`.

`adapters/mcp/src/agent-control.ts`: :14 `STAGE_ORDER`, :182–185 `candidateOrder()` —
zentrale **Kandidatenfolge-Projektion** existiert bereits (ebenso `hub/policy.py:163 candidate_order`,
Spiegel in `hub/catalog.py:157`); die vollständige zentrale Auflösung/Filterung fehlt bisher
und wird in 4.4 als neue gemeinsame Fläche verortet (Rev2-Klarstellung).

`adapters/mcp/src/monitor.ts`: Registry `.monitors`/`.workers` Arrays, projektlokal
`.opencode-vm/monitor/registry.json` mit History/Logs (:62–74,:85,:97–143 lt. Diagnoseticket,
Struktur verifiziert).

`opencode-vm.sh`: :13813–13816 Monitor-Unit `ocvm-monitor` mit
`StandardOutput/StandardError=append:<session-share>/monitor/server.log`;
:~13826–13831 projektlokaler Heartbeat `.opencode-vm/monitor/heartbeat.json`. Journal nur
Unit-/systemd-Ebene. (Analog Dashboard :13930.)

`hub/`: `monitor.py`/`monitor.js`/`server.py` — Monitor-Detailbereich, Refresh und Workerstatus
existieren dort; konkrete Detailzeilen bei Implementierung erneut abgleichen.

## 4 Architektur / MVP

### 4.1 Failed-Worker-Übergang: Soll/Ist

Ist (belegt): `observeWorkers` übernimmt nur `completed`; ein terminal failed Worker bleibt
unbeobachtet, `workerIndexDigest` ändert sich nicht, der Scheduler-Tick endet in
`noop-unchanged` (:342/:465) ohne jeden Logeintrag. Der Manager erhält keine Information;
 Receipt `msg_299062e8…` (Worker-Dispatch) wird nicht mit dem Managerzustand korreliert.

Soll (MVP): `observeWorkers` erweitert — bei nachgewiesenem terminalem Fehler des Worker-Turns
(Beobachtungsklassifikation darf `classifyEvidence` nutzen, s. u.) wird der Workerrecord mit
Fehlerkategorie/Fingerprint/Zeit und Receipt (`assistant_message_ids` falls vorhanden, sonst
explizit `null`) **konservativ als `lifecycle="idle"` plus additivem Fehlermarker** geführt
(kein neuer Enum-Wert; Begründung Abschnitt 8 d). Der dadurch geänderte `workerIndexDigest`
weckt den Manager genau einmal über den existierenden W4-Mechanismus (kein neuer Timer).

Dabei gelten drei harte Trennungen:
1. **Digest-Wake-Invariante (B3):** `workerIndexDigest` hasht nur worker_key, alias,
   lifecycle, runtime_session_id, creation/dispatch/result_receipt, last_synthesis_at,
   updated_at (monitor.ts:766–780). Die Fehlermarkierung muss daher entweder ein gehashtes
   Feld ändern (Empfehlung: `updated_at` + `result_receipt=null`-bzw.-Receipt-Übergang bei
   lifecycle idle) oder `workerIndexDigest` additiv erweitert werden — nur additive
   Fehlerfelder ohne Digestreaktion reproduzieren stumm das AITL-Symptom. Zugleich
   idempotent: Wiederbeobachtung desselben Fehlerzustands schreibt den Marker nur beim
   Zustandsübergang, damit kein ewiger Delta-Wake entsteht.
2. **Beobachtung vs. Recovery-Admission (B2):** Beobachtung/Markierung darf `classifyEvidence`
   (inkl. `unknown`) verwenden. Die **Recovery-Admission** (Provider-Routing) erlaubt nur eine
   explizit definierte terminale Providerfehlermenge: `provider_header_timeout`,
   `provider_response_stream_error`, `provider_error`, `provider_timeout`, `provider_quota`,
   `provider_auth`. Kategorie `unknown`, fachliche Fehler, pending permissions/questions,
   INPUT_REQUIRED, aborted → **kein Provider-Routing**, sondern ehrlicher Hold/Park mit
   benanntem Grund (bestehende SafeHold-Pfade).
3. **Turn-Attribution (B4):** Die Worker-Statusabfrage erfolgt mit dem eigenen
   `dispatch_receipt` als Korrelationsargument (analog Manager :359); ein fremder oder
   handgesteuerter Turn derselben Session wird nie als Fehler des Worker-Dispatches
   gewertet. Stellt das Gateway keine Receipt-Korrelation bereit, ist die Annahme
   „dedizierte Single-Purpose-Worker-Session“ explizit zu dokumentieren und im
   Abnahmetest zu belegen.

Rollentrennung Fehlermarker / Manager-Synthese / eigene Manager-Recovery: Der Digestübergang
durch die Fehlermarkierung erzeugt **genau einen** Synthese-Wake des Managers; der Manager
verarbeitet den Workerfehler evidenzbasiert im Syntheseschritt (bzw. über die bestehende
Worker-Surface). Die eigene Manager-Recovery (Policy-Fallback) greift ausschließlich bei
nachgewiesenem terminalem Providerfehler am **eigenen, korrelierten** Dispatch-Receipt
(`dispatch_wal.message_id`, :308–334), nie aufgrund des Workerfehlers. Kein Schluss aus
fehlender History; Unbeobachtbarkeit bleibt Unbeobachtbarkeit (`catch → continue` wird geloggt).

### 4.2 Receipt-Korrelation und Digest-Wakeup

- Manager-Dispatches: `dispatch_wal` (WAL-Reconcile :308–334 bleibt unverändert).
- Worker-Dispatches: existierendes `worker.dispatch_receipt`; Beobachtung über
  `worker.runtime_session_id` **mit `dispatch_receipt`-Korrelationsargument** (Turn-Attribution,
  s. 4.1 Ziffer 3; gebundene Kandidatenliste :476–481, Cap 5 bleibt).
- Wake-Indikator: ausschließlich Digestwechsel (`workerIndexDigest`) bzw. `wake_request` —
  kein Polling-Feature, kein Listener.

### 4.3 Manager-/Worker-Recoveryzuständigkeit

Manager-Recovery (Policy-Fallback) betrifft ausschließlich Manager-Session-Dispatches.
Worker-Fehler fließen als Evidenz in den Manager-Syntheseschritt; eine Worker-Neudisposition
erfolgt nur über die bestehende Worker-Surface (create/update/reconcile) durch den Manager oder
Operator — kein automatischer Worker-Neustart im MVP. Ownership-, Budget- (W2) und
Reparaturgrenzen bleiben unangetastet.

### 4.4 Gemeinsame Schema-4-Policy statt zweiter Kette

- `monitor-main.ts:80–82`: `policyView` auf volle Schema-4-Sicht erweitern
  (`profileFallbacks`, `strategies`, `routing` — Felder liegen in `readPolicy` bereits an).
- `candidateOrder()` (agent-control.ts:182) liefert **nur die Stage-Label-Reihenfolge**
  (`Deep.main`-Art, `string[] | null`; Doku agent-control.ts:176–181: Runtime-Filterung ist
  „a documented management-layer step“). Das MVP ergänzt daher **neue geteilte, additiv
  exportierte Auflösungs-/Filter-Helper** — bevorzugt in `agent-control.ts` (bzw. einem
  benannten geteilten Modul `adapters/mcp/src/policy-resolution.ts`), benutzt von Adapter
  und Monitor-Engine (Hub-Integration s. u. Enginekanon-Vertrag):
  1. Stage-Label → vollständiges Tupel (provider/model/**variant**),
  2. Katalogverfügbarkeitsprüfung (bestehende `catalogAvailable`-Semantik),
  3. Attempted-Filter (persistente Episode, s. 4.5),
  4. Provider-Skip-Gate mit zentraler Evidenzsemantik (Area-/Quota-Beweis, kein
     Einzelrequesttimeout, gleiche provider_id allein kein Area-Schluss — Auswahlvertrag
     Ziffer 3, zentral und gleich für Hub/Agenten/Monitor).
  `recover()`/`fallbackChain()` werden durch diese gemeinsame Auflösung ersetzt.
  **Legacy-Regime:** `candidateOrder → null` (Regime ≠ per_profile) behält die heutige
  `fallbackChain`-Semantik (monitor-engine.ts:1186–1205) unverändert bei.

  **MVP-Integrationsvertrag TS↔Hub (R2, begründet entschieden — Enginekanon, kein
  Operatorfrage):** Die Auflösungs-/Filterlogik existiert **genau einmal**, in TypeScript
  (Adapter+Engine). Die Engine persistiert je Recovery-Entscheidung die aufgelöste
  Kandidatenliste inkl. je Skipgrund und Policyrevision als begrenzten projektlokalen
  Snapshot im bestehenden Registry-Muster (wie registry.json/heartbeat.json); der Hub ist
  **rein lesender Konsument** dieser Projektion und reimplementiert keine Filtersemantik in
  Python. Begründung: Der Hub (hub/policy.py liest agent-control.json direkt, hub/server.py
  ruft den TS-Adapter nicht) kann TS-Helper nicht importieren; eine Python-Neuimplementierung
  der Filter wäre die verbotene dritte/divergente Fläche (Auswahlvertrag Ziffer 3), ein
  Microservice/Listener wäre unerwünschte neue Steuerung. Aufgabenteilung: Kandidatenlabels
  liefert `candidateOrder` (unverändert), Laufzeit-/Evidenzfilter (Tupel, Availability,
  Attempted, Provider-Skip-Gate) die neuen TS-Helper; der Hub zeigt nur das persistierte
  Ergebnis. Testfläche in Welle D: TS-Helper-Unit- und Kombinationstests plus
  Konsistenzprüfung Hub-Anzeige = persistierte Projektion/Logeintrag.

### 4.5 Primary-Rückkehr, Variant-Readback, persistente endliche Versuche

- Primary-Rückkehr: vorhanden (:698–749 liest frisch pro Dispatch) — bleibt; nach erfolgreichem
  Fallbackschritt gilt der nächste normale Wake automatisch wieder dem aktuellen Primary.
  Kein Cooldown.
- Variant-Readback: Post-Update-Verifikation (:735–737, analog :836–845) um Variante erweitern;
  bei Mismatch kein Senden unter ungeprüfter Runtime (`recovery-update-unverified`-Pfad bleibt).
- Persistente Versuche: pro Recovery-Episode attempted vollständige Runtime-Identitäten
  (provider/model/**variant**) + Kategorie/Fingerprint/Grund **im Monitorrecord** (registry.json,
  additiv) — survives Wakes/Neustarts; endliche Folge ohne Wiederanspringen des ersten
  gescheiterten Kandidaten; **kein automatisches wiederholtes Probieren derselben Identität**.
  Policyänderung zwischen Wakes: entfernte Kandidaten entfallen; ein neuer Episodenschnitt
  **übernimmt die attempted-Identitäten der alten Episode für weiter zulässige Kandidaten**
  (Vereinigung, dedupliziert — unveränderte gescheiterte Kandidaten werden nicht vergessen,
  neue zulässige Kandidaten kommen hinzu); eine bewusste Neuauflage bereits gescheiterter
  Identitäten erfolgt nur per explizitem Operator-Trigger. **Scoping (R1):** Die
  No-Retry-/Neuauflage-Regel gilt ausschließlich für die Kandidatenwahl innerhalb der
  **erfolglosen laufenden Recovery-Episode**. Ein erfolgreicher Fallbackschritt schließt
  die Episode ab; danach probieren normale Wakes das aktuelle Primary automatisch erneut
  (kein Cooldown; `resolveRuntime` :698–749 bleibt vom Attempted-Filter unberührt), und bei
  erneuter Primary-Fehlerevidenz darf eine neue Episode mit erlaubter Fallbackfolge beginnen.
  Eine Policyrevision allein beendet keine erfolglose Episode und vergisst unveränderte
  Fehleridentitäten nicht.

### 4.6 Offene Retry/Park-/Erschöpfungssemantik — Empfehlung (NICHT beschlossen)

**Konservative reversible MVP-Empfehlung:** Bei fehlendem Fallback oder erschöpfter Kette:
`parked_input_required` mit präzisem `parked_reason` (z. B. `recovery-chain-exhausted`,
`profile-fallback-unconfigured`) plus Entscheidungslag-Eintrag und sichtbarer Diagnose —
also genau das bestehende SafeHold/INPUT_REQUIRED-Muster (`final-fallback-unconfigured`/
`-unavailable`, :~810–849, und `dispatch-uncertain`, :328–334). Keine automatische
Retryfolge, kein Reset-Loop, keine erfundenen Budgets; Neustart einer Episode nur durch Operator-Trigger oder nach Policyänderung mit neuen
zulässigen Kandidaten (dann neuer Episodenschnitt mit Attempted-Übernahme gemäß 4.5, kein
automatisches Wiederholen derselben Identität **innerhalb der erfolglosen laufenden
Episode**; erfolgreicher Schritt schließt die Episode ab und gibt Primary frei, s. 4.5
Scoping). Diese Empfehlung ist explizit als
Vorschlag an den Operator markiert; die produktpolitische Grenze bleibt die offene Entscheidung aus
task_ad26435f.

### 4.7 Wechselwirkung mit laufendem Monitor (kein Liveeingriff jetzt)

Konzeptionell: Upgrade wirkt erst über neue Session-/Adaptergeneration (transiente Unit,
Ownership-Watch monitor-main.ts:128–137 beendet alte Instanz sauber). Registry-Felder sind
rein additiv → älterer Adapter ignoriert sie (Rollback-sicher); neuer Adapter toleriert
alte Records ohne Episodendaten. Kein Eingriff in die aktuell laufende AITL-Instanz; der
konkrete Abnahmefall wird später mit einer kontrollierten Fixture reproduziert, nicht durch
Live-Manipulation.

### 4.8 Logging (Developerphase bewusst verbose)

- Pro relevante Entscheidung (dispatch/noop/skip/busy/recovery/park/failed-Beobachtung/
  wake-exception): UTC-Zeit, monitor-/wake-/session-/worker-/dispatch-receipt-Korrelation,
  maschinenlesbarer Grund + kurze Klartextbeschreibung; fehlende/unklare Evidenz explizit
  gekennzeichnet. **Recovery-Entscheidungen zusätzlich (Auswahlvertrag Ziffer 6):**
  Policyrevision, evaluierte Kandidaten inkl. je Skipgrund, und das tatsächlich gewählte
  vollständige Runtime-Tupel provider/model/variant. Stille Pfade :165,:183,:342,:465,:487–491
  bekommen Einträge.
- Sinks (belegt): (1) strukturierte Entscheidungseinträge in Registry-History/-Logs
  (monitor.ts, bounded), (2) `[monitor]`-Zeilen nach `<session-share>/monitor/server.log`
  (opencode-vm.sh:13813–13816), (3) Heartbeat `.opencode-vm/monitor/heartbeat.json` als
  Liveness (getrennt halten). Journal nur Unit-Ebene. Keine Secrets, Tokens,
  Config-/Umgebungsdaten, Promptpayloads, Privatschlüssel, fremde Projektlogs; Redaktion
  serverseitig vor Antwort.
- Keine Verdichtung im MVP außer: wiederholte `noop-unchanged` dürfen aggregiert werden,
  wenn erster/letzter Zeitpunkt und Anzahl sichtbar bleiben (Anforderung Diagnoseticket).

### 4.9 UI: große kopierbare Textdiagnose

Im Monitor-Detail (hub) eine große scrollbare, kopierbare Textansicht (z. B. `<pre>`/Monospace)
statt weiterer Einzelelemente; bestehende Grundstatusanzeige bleibt. Kanonische Readquelle ist
eine neue begrenzte serverseitige Logread-API: strukturierter Entscheidungslauf (Registry) plus
begrenzter `server.log`-Tail, Quellen deutlich getrennt und bezeichnet. Oberer
Aktualisieren-Button **und** Workerstatus-Refresh laden diese Ansicht frisch; sichtbar:
Abrufzeitpunkt (UTC), Datenzeitraum, Quellenstand, Teilabdeckung/Trunkierung, Lade-/Fehlerstatus
— fehlgeschlagene oder stale Reads nie als „frisch“ ausgeben. **Quellenstand/Lifetime (B8):**
`server.log` liegt pro Session-Share (`<session-share>/monitor/server.log`,
opencode-vm.sh:13811–13813), die Registry projektlokal, der Hub ist generationsgebunden
(hub_runtime_dir `$SESS_SHARE/hub`, opencode-vm.sh:13993–13996); die Ansicht zeigt an,
welcher Share/Generation-Stand gelesen wurde, und bei Reconnect/Share-Wechsel wird die
Tail-Quelle neu bestimmt (alte Shares können endenden Zugriff haben). Begrenzung serverseitig;
**Vorschlag zu validieren (keine Pflicht): Tail max. 256 KiB / 2.000 Zeilen; 24 h Historie als
Idee.** Browser bleibt responsiv; kein unbemerkter Verlust (Trunkierungsmarker mit
Hinweis auf ältere Inhalte am Log selbst). Logging ändert keine Schedulerentscheidung und
löst selbst keinen Dispatch aus.

## 5 Minimale Dateiflächen (Implementierungsvorbereitung, kein Go)

Welle A — failed-Worker + Entscheidunglogs:
- `adapters/mcp/src/monitor-engine.ts` (observeWorkers, stille Returns, Entscheidungseinträge)
- `adapters/mcp/src/monitor.ts` (additive Record-/Logfelder, Bounds)

Welle B — gemeinsame Policy/Recovery:
- `adapters/mcp/src/monitor-main.ts` (policyView Schema-4)
- `adapters/mcp/src/monitor-engine.ts` (recover auf gemeinsame Auflösungs-Helper umstellen, Legacy-Regime unverändert, Episodenpersistenz, Variant-Readback)
- `adapters/mcp/src/agent-control.ts` bzw. neues geteiltes Modul `adapters/mcp/src/policy-resolution.ts` (additiv exportierte Stage-Auflösungs-/Availability-/Attempted-/Provider-Evidence-Helper, s. 4.4; `candidateOrder` selbst unverändert)

Welle C — Logread + UI:
- `hub/server.py` bzw. `hub/monitor.py` (begrenzte, redigierende Logread-API)
- `hub/monitor.js` (+ ggf. `hub/app.js`-Detalleinbindung: Textansicht, Refresh-Anbindung)

Welle D — Abnahme (nach separatem Go): `adapters/mcp/src/monitor.test.ts`, Hub-Tests
(inkl. Konsistenz Hub-Anzeige = persistierte Engine-Projektion), TS-Helper-Unit- und
Kombinationstests (Labels × Filter × Legacy-Regime), `opencode-vm.sh` (nur Version-Bump +
ggf. Unit-Anpassung, keine Verhaltensänderung).

## 6 Gemeinsame Abnahmematrix (konsolidiert aus beiden kanonischen Tickets)

Aus task_ad26435f (A–J, unverändert kanonisch): identische Kandidaten/Skipgründe Resolver vs.
Monitor bei gleicher Revision/Evidenz; alle degrading×provider_skip-Kombinationen + null/unset;
beide aus: nur eigener Fallback; Quota-Evidenz: gezielter Skip, Fremdprovider-Fallback bleibt;
Primary↔Fallback-Zyklus ohne Cooldown; kein Doppelversuch über Restart/doppelte Runtimes;
erschöpfte Kette transparent; busy/retry/unknown/aborted/pending/input-required/fachlicher
Fehler → kein Provider-Ausfallrouting; Policyänderung zwischen Wakes + WAL-Reconcile +
Provider/Modell/**Variant**-Readback inkl. Mismatch; Compaction- und Budgetgrenzen unverändert.

Aus task_6679fb88 (A–E, unverändert kanonisch): reproduzierbare Fixture Workerdispatch →
terminaler Fehler → nächster Wake zeigt Zustand/Receipt/Digests/Entscheidungsgrund wahrheitsgemäß
(Fortsetzung, bewusster Hold oder Recovery nötig); no-due/concurrent-wake/busy/
unveränderter Digest/WAL-uncertain/Recovery/Exception einzeln erklärbar, ohne erfundene
Ereignisse und ohne zusätzlichen Dispatch durch Logging; Refresh zeigt tatsächlich neue Zeilen
mit neuem Abrufstand, Fehler/stale/teilweise unterscheidbar; server-/browserseitige Begrenzung,
scroll-/kopierbar, Trunkierung sichtbar; Secret-/Prompt-Redaktion und Projektgrenze, History vs.
Operational-Logs vs. Heartbeat klar getrennt.

Paket-spezifisch (dieser Anker): Der konkrete AITL-Fall (Abschnitt 7) wird mit der Fixture
erklärt — beobachtete Zustände, korrelierte Receipts, exakte Entscheidung und begründete
zulässige Fortsetzung oder Hold.

## 7 Konkreter Abnahmefall (AITL, kein Liveeingriff)

Monitor `monitor_9d136952eaab49daad1f8b2a49b040e2`; Manager `ses_ede074f94ffeBLMdgcWLD6eCuU`;
Worker `ses_ede046263ffe5RZ6PJrlAs9RUr`; Receipt `msg_299062e8349b46bb9c700b4bbe034f40`;
Worker-Timeout ~19:14:50 UTC; History-Ende 18:58:49 UTC; `include_logs` → `logs=[]`.
Plausible, noch unbewiesene Kette: Worker terminal failed → `observeWorkers` :489 überspringt
`state!="completed"` → kein Digestwechsel → `noop-unchanged` (:342/:465) still. Der künftige
Test muss zeigen: beobachteter Zustand, Entscheidung(sgrund) und zulässige Fortsetzung oder
Hold — nicht mehr Behauptung aus fehlender History.

## 8 Risiken / Restentscheidungen / begründete technische MVP-Empfehlungen

Risiken: (1) `unknown`-Fehlerkategorie operativ breit — durch die Admission-Trennung (4.1,
Ziffer 2) kein Provider-Routing mehr, aber Hold-Flut möglich; (2) Katalogverfügbarkeit ≠
Gesundheitsnachweis; (3) Live-Deployments trotz Adapter-0.1.41-Angabe nicht byteverifiziert;
(4) Logwachstum/Rotation von `server.log` unbegrenzt — Begrenzungs-/Rotationsmodell erst mit
realen Datenmengen finalisieren; (5) Registry-Wachstum durch verbose Phase (Bounds nötig);
(6) Registry-/Schemakompatibilität bei Rollback (additive Felder sind sicher, Enum-Erweiterung
wäre es nicht — daher vermieden); (7) Browserlast bei großen Logs (serverseitige Begrenzung
mitigiert); (8) belegbares Livebeweis-Defizit für den AITL-Fall bleibt bis zur Fixture bestehen.

Echte offene Produktgrenze (Operator-Entscheidung, kanonisch in task_ad26435f):
a) **Erschöpfungs-/Retry-/Park-/Resetsemantik** bei fehlendem Fallback oder vollständig
erschöpfter Kette — Empfehlung 4.6 (SafeHold/INPUT_REQUIRED, kein Auto-Retry, Episodenschnitt
nur per Operator-Trigger oder Policyänderung mit Attempted-Übernahme) bleibt Empfehlung.

Technische MVP-Empfehlungen (vom Konzept begründet entschieden, reversibel, kein
Operatorentscheid nötig; Implementierung weiterhin nur mit ausdrücklichem Go):
- b) Tail-/Retentionsgrenzen: Start mit **256 KiB / 2.000 Zeilen serverseitigem Tail** und
  24 h Anzeigefenster als Initialwerte — begründet durch Browserresponsiveness und
  Diagnoseticket-Anforderung 5; an realen Datenmengen validieren und justieren, keine
  festgeschriebene Pflicht.
- c) Episoden-Resetregeln: wie 4.5 (Übernahme-Vereinigung bei Policyänderung, Neuauflage nur
  per Operator-Trigger) — direkt aus dem Auswahlvertrag abgeleitet.
- d) Failed-Worker-Darstellung: **`lifecycle="idle"` + additiver Fehlermarker** (Kategorie/
  Fingerprint/Zeit/Receipt) statt neuem Enum-Wert — rollback-sicher, weil
  `monitorWorkerLifecycleSchema = z.enum(["reserved","active","idle","archived"])`
  (tools.ts:1123) strikt validiert und ein neuer Wert ältere Adapter/Clients brechen würde;
  Digestreaktion über `updated_at`/`result_receipt`-Übergang sichergestellt (4.1).
- e) Logread-Exposition MVP: **nur Hub-API** — Diagnose ist UI-Anliegen; MCP-Exposition wäre
  Featureausweitung ohne belegten Bedarf.

## 9 Artefaktnachweis / Abschluss

Unabhängiger **CONCEPT_PASS** (Rev3) für exakt diese Inhaltsrevision: Plan SHA256
`1386d074a3f44badd6414d756e3dfc6a8a0b22c3ff9dd369c672d83b2c5cfdec` (27888 B), Context SHA256
`0ed2e3d5204c7653cff129d1fd50823629102dd039d5580bc3d22c8a2a28b437` (4016 B); Reviewbericht
finale SHA256 `0a4a9989b4c5fe2917f7a710d9af4353ee0c0167d2d87ed570caa80b67a0cf95`,
Reviewerterminal `msg_1226f567a0015GAG1kSzIgf9ZO`. Konzeptentscheidungsvorbereitung ist
geprüft und abgeschlossen; ausstehend sind ausschließlich (a) die Operator-Produktentscheidung
zur Erschöpfungs-/Park-/Resetgrenze (Empfehlung 4.6/§8a) und (b) ein separates
Implementierungs-Go für die Wellen A–D. Kein Boardstatusübergang, kein Done, keine
Selbstumsetzung; diese Header-/Abschlussmetadatenänderung ist rein dokumentarisch — die
geprüften Architektur-/Anforderungsabschnitte (§3–§8, §10) sind unverändert.

## 10 Auflösung der Prüfbefunde B1–B9

Quelle: `planning/task-concepts/task_be951293-e41a-5d69-a394-b0d9c944c960-concept-review.md`
(SHA256 `8082d0fb32415564b4cd111aec9f6f577950589cf8297ab73184a96e7922386e`), CHANGES_REQUIRED.

- **B1** → §4.4 präzisiert: `candidateOrder` nur Reihenfolge; neue additive geteilte
  Auflösungs-/Filter-Helper (Tupel-Auflösung, Availability, Attempted, Provider-Evidence)
  in agent-control.ts bzw. `policy-resolution.ts` verortet; §5 Welle B angepasst;
  Legacy-Regime (`candidateOrder → null`) behält `fallbackChain`-Semantik explizit unverändert.
- **B2** → §4.1 Ziffer 2: Beobachtung (klassische `classifyEvidence`) von Recovery-Admission
  getrennt; Admission nur für die sechs expliziten terminalen Providerfehlerkategorien;
  `unknown`/fachlich/pending/aborted → Hold/Park, nie Provider-Routing.
- **B3** → §4.1 Ziffer 1: Digest-Wake-Invariante (Hashfelder monitor.ts:766–780 benannt;
  Markierung muss gehashtes Feld ändern oder Digest additiv erweitern) plus
  Idempotenz/Gegenrichtung: kein ewiger Delta-Wake bei Wiederbeobachtung.
- **B4** → §4.1 Ziffer 3: Turn-Attribution über `dispatch_receipt`-Korrelation analog
  Manager :359; sonst dokumentierte Single-Purpose-Worker-Annahme mit Abnahmebeleg;
  fremde Turns gelten nie als eigener Fehler.
- **B5** → §8 d: Empfehlung auf `idle` + additiven Fehlermarker geändert (Enum
  tools.ts:1123 bleibt unverändert, strikte Clients/Rollback geschützt).
- **B6** → §4.5/§4.6: Episodenschnitt übernimmt attempted-Identitäten weiter zulässiger
  Kandidaten (Vereinigung, dedupliziert); Neuauflage nur per Operator-Trigger; kein
  automatisches Wiederholen derselben Identität.
- **B7** → §4.8: Recovery-Entscheidungseinträge enthalten Policyrevision, evaluierte
  Kandidaten inkl. Skipgründe und gewähltes vollständiges Tupel provider/model/variant.
- **B8** → §4.9: Quellenstand/Lifetime von `server.log` (pro Session-Share) vs. projektlokale
  Registry vs. generationsgebundener Hub benannt; Anzeige von Share/Generation-Stand,
  Neubestimmung der Tail-Quelle bei Reconnect/Share-Wechsel.
- **B9** → §3: `:361` auf `:359` korrigiert.

Rev2-Blocker (Prüfung SHA92a3ff59…, Rev2-Sektion): **R1** → §4.5/§4.6 Scoping-Sätze
(No-Retry nur innerhalb der erfolglosen laufenden Episode; erfolgreicher Schritt schließt
ab und gibt Primary ohne Cooldown frei; Policyrevision allein beendet keine erfolglose
Episode). **R2** → §4.4 Enginekanon-Integrationsvertrag (TS-Auflösung genau einmal; Hub
rein lesender Konsument der persistierten Projektion; keine Python-Filterreimplementation,
kein Microservice; Testflächen Welle D). K1 → §3 umformuliert; K2 → Metadatenzeit aus
tatsächlicher UTC-Zeit.

Der Reviewbericht selbst wurde nicht verändert.

## 11 Implementierungs-Go und aktueller Umsetzungsstand (2026-10-10)

- **Go:** Christian hat am 2026-10-10 00:23 UTC das geprüfte Konzept (Rev. 3,
  CONCEPT_PASS, SHA1386d074…) ausdrücklich inklusive der transparenten Parkung bei
  erschöpfter Fallbackkette gemäß §4.6 freigegeben. Damit ist die bislang offene
  Produktgrenze §8 a) entschieden: Erschöpfung oder fehlender Fallback enden in
  `parked_input_required` mit präziser Begründung und sichtbarer Diagnose — kein
  automatisches Retry, kein Reset-Loop, Episodenneuauflage nur per Operator-Trigger
  oder Policyänderung mit neuen zulässigen Kandidaten (Attempted-Übernahme nach 4.5).
  Die alten „kein Go"-Metadaten von 2026-10-09 sind hierdurch überholt; historisch
  bleiben sie in §2/§9/§10 unverändert erhalten.
- **Welle A — implementiert (lokal kandidatenbereit, nicht QC-abgenommen):**
  failed-Worker-Beobachtung receipt-korreliert über das eigene `dispatch_receipt`
  (Turn-Attribution B4), konservative Markierung `lifecycle="idle"` plus additiver
  Fehlermarker `last_error` (Kategorie/Fingerprint/Zeit/Receipt oder explizit null,
  §8 d — kein Enum-Wechsel, tools.ts:1123 unverändert), Digestwechsel über die
  bereits gehashten Felder mit genau einem Synthese-Wake je distinktem terminalem
  Fehler und idempotenter Wiederbeobachtung (B3). Beobachtungsklassifikation nutzt
  `classifyEvidence` inkl. `unknown`; Recovery-Admission bleibt davon getrennt —
  Welle A führt keinerlei Provider-Routing ein; aborted/fachlich/pending/
  fehlende-Evidenz halten ehrlich mit benanntem Grund (B2). Stille Pfade
  (:165 concurrent-skip, :183 no-due, :342/:465 noop-unchanged, Statuslesefehler
  und nicht übernehmbare Terminalzustände der Worker-Beobachtung) werden sicher
  und begrenzt geloggt: strukturierte, gleichschlüssel-aggregierte
  Entscheidungseinträge (first/last/count sichtbar) plus je eine `[monitor]`-
  Service-Log-Zeile; niemals Rohtextgeheimnisse. Laufender Scheduler/Monitoren
  wurden nicht angefasst; kein Liveeingriff, kein Main-Merge, kein Push/Release.
  Candidate: `e0c5ce3ce0c2362f253ef2a1488540227c0050e5` (Tree 7ad08dd8…) auf
  Branch `task/be951293-wave-a`, Base Main `8936f621f86e4ff96b69bcc8c849a996d8ba26c0`;
  Dateien: `adapters/mcp/src/monitor-engine.ts`, `adapters/mcp/src/monitor.ts`,
  gezielte Tests in `adapters/mcp/src/monitor.test.ts`, kleine notwendige
  Begleitfläche `adapters/mcp/src/tools.ts` (additive `last_error`-Sicht auf der
  bestehenden Worker-Surface; Schema unverändert streng, Enum unverändert).
  Verifikation: `tsc` check clean; Adapter-Suite 229 pass / 0 fail / 2 env-gated
  skips (vorbestehend); 6 neue Welle-A-Tests belegen Receipt-Attribution,
  Idempotenz, failed→Digest→genau ein Managerwake, fehlende Evidenz, additive
  Alt-/Zukunfts-Records (korrupte Marker fail-closed) und Logbounds.
- **Offen:** Welle B (gemeinsame Schema-4-Policy/Recovery, Episodenpersistenz,
  Variant-Readback), Welle C (Logread-API + Hub-Textansicht), Welle D
  (Abnahmetests inkl. AITL-Fixture, Hub-Konsistenz, Version-Bump); unabhängige QC
  zu Welle A wird separat beauftragt — dieser Eintrag ist keine Selbstabnahme.
