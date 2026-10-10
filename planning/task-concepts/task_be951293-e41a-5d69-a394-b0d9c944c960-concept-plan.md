Task-ID: task_be951293-e41a-5d69-a394-b0d9c944c960
Title: Work Package: Monitor-Zuverlässigkeit und Diagnose vorbereiten (Konzept, reviewbar)
Stand: 2026-10-10 · Status: LOKALE MAIN-INTEGRATION DURCHGEFÜHRT — main FF 8936f621→65e73c6040be5a7b148f02b7ea9bcee2ceaf26f2 (GESAMT-QC_PASS, Bericht SHA51c9c00e…, D1/D2 eingearbeitet); unabhängige Integrations-QC ausstehend · Implementierungs-Go erteilt · Historie: CONCEPT_PASS (Rev. 3), Welle A/B/C jeweils QC_PASS
Last-concept-update: 2026-10-09T20:53 UTC (historisch: Abschlussmetadaten Rev3-CONCEPT_PASS; Inhaltsrevision unverändert SHA1386d074…; die damit offene Produktentscheidung 4.6/§8a ist mit dem Go vom 2026-10-10 entschieden, siehe §11) · Last-implementation-update: 2026-10-10 (Kette auf Branch task/be951293-wave-a: Welle A e0c5ce3→738efe1→c6bd261 QC_PASS; Welle B 38eeb80→c2b2808→28ff295 QC_PASS; Welle C 8e9650b→bf1939b, Delta-Fix 5bf4408, Doku 00523c2 QC_PASS; Welle D: Abnahmezusatz (AITL-Ketten-Fixture, Matrix-A-Identität, Dupletten-/Cross-Writer-Tests, README-Bedienhinweise) als Folcommit(s); §11 aktueller Stand)

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
- **Welle A — implementiert und QC-Korrektur ausgeführt (lokal kandidatenbereit,
  Delta-QC steht aus):**
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
- **QC (unabhängig):** Bericht
  `planning/task-concepts/task_be951293-e41a-5d69-a394-b0d9c944c960-waveA-qc.md`
  (SHA256 `765c4f03f6eb40825ae0654ccbddc8ebce166068ead1e64c71577122d443e401`,
  Reviewerterminal `msg_12353dffb001pL58w1P874LY94`): Scope/Privacy/Receipt/Wake
  sowie tsc/build, 229 pass/0 fail/2 skip und 34/34 bestätigt; CHANGES_REQUIRED
  nur für F1 (Stale-`last_error` über reuse/rebind) und F2 (Merge-Key-Konflation
  der beiden noop-Ursachen). Beide Befunde reproduktionsfest bestätigt.
- **QC-Korrektur (Autor, lokal, nur F1+F2+Tests):** Fix-Commit
  `738efe1b26aed500024dd49c742f16794f4951aa` (Tree `5a211208e0a3ecbf8c5dff17af1421056084723a`)
  auf `fdc8ad5adfabe0a509b46a2bcd37bc041707f4d3`: F1 — `reuseWorker`/`rebindWorker`
  (gemeinsames `rebindOwnWorker`) setzen `last_error = null` beim Reaktivieren;
  die lebende Record-Zeige beschreibt nur die aktuelle Episode, die Beobachtung
  bleibt in der Registry-History auditierbar, das Wake-Prompt rendert einen
  frischen active-Dispatch nie mit alter Kategorie. F2 — noop-Merge-Keys sind
  ursachenspezifisch (`noop-unchanged:<reason>`), Ursachen zählen und erscheinen
  getrennt mit eigenem first/last/count. Regressionstests ergänzt (reuse+rebind
  inkl. Promptdarstellung; Cause-Splitting mit Counts), bisherige Hold-Erwartungen
  auf die Clear-Semantik aktualisiert. Neu verifiziert: tsc clean; Monitor-Suite
  **36/36**; Adapter-Gesamtsuite **231 pass / 0 fail / 2 env-gated skips**.
  Keine anderen Stellen angefasst; keine Mainintegration/kein Release/Push/Live.
  **Abschluss (unabhängige QC, Original `msg_12360c71a001Qw9PTBuUeAc0TT`
  vollständig gelesen, Bericht aktuell SHA256
  `3241dc22f77db3f988fcf7328223038367d692a7052a35e294f8a645132b34f3`):
  Delta-QC bestätigt F1/F2 behoben, Monitor 36/36 und Adapter 231 pass/0 fail/2
  skip in erfolgreichen Läufen — Welle A: QC_PASS auf `c6bd261`.
  Wahrheitstreue: der vorbestehende lastabhängige `dashboard-bootstrap`-Flake
  (in der QC 2 von 8 Volläufen) — **Zählkorrektur durch die
  Wellen-B-QC (`waveB-qc.md`, SHA256 `effd6d1c67eb76b9c22a41774afa0e0a0882929eb87aae3e677c3895cb1d9b15`):
  Welle A tatsächlich 6/8 grüne Läufe und 2/8 Läufe mit je einem Flake
  (Läufe 1 und 4); die ältere Formulierung „7 von 8" war inkonsistent und ist
  hiermit durch die belegten Runzahlen ersetzt. Welle B: 4/4 grüne Läufe, Flake
  trat dort in keinem Lauf auf.** Er wird ausdrücklich NICHT als durchgehend
  grün dokumentiert; er liegt außerhalb von Welle A/B und ist dem Autor als
  späteres Cleanup vermerkt. Keine Selbstabnahme durch den Autor.
- **Welle B — implementiert (lokal kandidatenbereit, unabhängige QC steht aus):**
  Gemeinsame Schema-4-Policy-Auflösung genau einmal in TypeScript in
  `agent-control.ts` (`resolveRecoveryChain`: Stage-Label→vollständiges Tupel
  provider/model/variant, `catalogAvailable`-Semantik, persistenter
  Attempted-Filter, zentrales Provider-Skip-Gate; `fallbackChain` dorthin
  verschoben, Engine re-exportiert nur — keine zweite Implementierung, kein
  neuer Python-Resolver; Hub bleibt später rein lesender Konsument der
  persistierten Projektion). `monitor-main` liefert die volle Policy-Sicht
  (profileFallbacks/strategies/routing/revision). Recovery-Admission exakt auf
  die sechs terminalen Providerfehlerkategorien beschränkt;
  unknown/fachlich/aborted/pending bleiben ehrliche benannte Holds ohne Abort,
  Switch oder Dispatch; W2-Budgetzählung für production-code unverändert
  (Matrix J). Provider-Skip nur bei explizit ON plus account-Scope-Beweis
  (quota/auth) — Einzel-Timeout oder provider_id-Alleintreffer skippt nie,
  Fremdprovider-Fallback bleibt nutzbar. Persistente endliche Episode im
  Monitorrecord (additiv, bounded): Attempted-Vollidentitäten überleben Wakes,
  Restart und Policyrevisionen (Vereinigung, nicht vergessen); Revision allein
  beendet die Episode nicht; ein gesunder admitted Wake schließt die Episode,
  das nächste Normalwake probiert das aktuelle Primary automatisch ohne
  Cooldown (§4.5 R1; resolveRuntime bleibt attempted-frei). Variant-Readback
  fail-closed in primary UND recovery; unbestätigte Switches sind
  Recorded-Attempts, nie stille Wiederholung. Erschöpfung = beschlossenem §4.6
  transparentem Park mit präzisen sichtbaren Gründen (profile-fallback-
  unconfigured / final-fallback-unconfigured / final-fallback-unavailable /
  recovery-chain-exhausted) plus begrenztem Entscheidungseintrag;
  Episode-Neustart nur per explizitem Operator-Trigger auf solch einen Park.
  Legacy-Regime (routing absent/legacy) verhält sich exakt wie bisher;
  Welle-A-Schutzinvarianten unverändert.
  Candidate: `38eeb809c42f8d70bd592fa736694502c305728d` (Tree
  `b0e5d00899891bd702c35027a7929d0c37a281ce`) auf `c6bd261` (Welle-A-QC_PASS).
  Dateien: agent-control.ts (+test), monitor.ts, monitor-engine.ts,
  monitor.test.ts, monitor-main.ts (+891/−72). Verifikation im THIS Lauf: tsc
  clean; monitor 43/43; agent-control 13/13; Adapter-Suite 244 pass / 0 fail /
  2 env-gated skips — der vorbestehende lastabhängige
  `dashboard-bootstrap`-Flake (QC-Beobachtung 2/8 unter Last) gilt ausdrücklich
  NICHT als behoben und wird nicht als durchgehend grün dokumentiert.
  Reversible MVP-Kleinentscheidungen (begründet): (1) Episode-Close nur bei
  admittedem healthy Dispatch, nicht bei Compaction (fehlerbehaftete Session
  bleibt episode-offen); (2) Operator-Restart nur auf Park mit
  Erschöpfungsgrund — wake_request ohne solchen Park vergisst nichts;
  (3) uncertain admission zählt als Attempt (`dispatch_uncertain`), niemals
  Blind-Resend (WAL-Reconcile bleibt vorgelagert); (4) unbestätigter
  Variant-Switch zählt als Attempt (`update_unverified`).
- **Unabhängige QC Welle B:** Bericht `waveB-qc.md` (SHA256
  `effd6d1c67eb76b9c22a41774afa0e0a0882929eb87aae3e677c3895cb1d9b15`, Terminal
  `msg_123840aa2001s83WSvBo5b7aQZ`) gegen Kandidat `326d243`: Matrix/Tests
  unabhängig bestätigt (tsc/build grün, monitor 43/43, agent-control 13/13,
  Suite 244 pass/0 fail/2 skip in 4/4 Läufen; Risiken R1–R8 und Scope PASS,
  Policy-Resume-Semantik reproduktionsfest verifiziert). CHANGES_REQUIRED nur
  für **F-B1** (sanktionierte Resumes — Policy-Resume, Operator-Neustart,
  gesunder Episodenschluss — ließen `work=parked_input_required`/`parked_reason`
  dauerhaft stale stehen: §4.6-Transparenz behauptete nach erfolgreicher
  Fortsetzung weiter einen Park) und **F-B2** (`recovery_episode`/
  `recovery_resolution` ohne fail-closed Shape-Validierung; korrupte Records
  crashten `recover()` erst zur Laufzeit).
- **QC-Korrektur Welle B (Autor, lokal, nur F-B1+F-B2+Tests):** Fix-Commit
  `c2b2808fbde4507b22cbe596324ebf00c18be410` (Tree
  `54a8db371d87586127662df33ef0e526c08acaf6`) auf `326d243`:
  F-B1 — die drei erfolgreichen Release-Mutatoren (`recovery-continued`,
  `dispatch-reconciled`, `dispatched`/healthy) setzen `work="active"` und
  löschen `parked_reason` ausschließlich bei den vier eigenen Recovery-Park-
  Gründen, mit `recovery-park-resumed`-Historieneintrag (resumed_from + via);
  fremde bewusste Parks (`dispatch-uncertain`, `repair-budget-exhausted`,
  grundlose manuelle Parks) und Schedulerstatus bleiben unberührt — kein
  falsches Unpark bei unsicherem Send, keine Attempt-Resets außerhalb der
  definierten sanktionierten Pfade. F-B2 — `shapeOk` validiert beide Felder
  beim Vorhandensein fail-closed (ISO-Zeiten, Bounds, Fingerprints 64-hex,
  Outcome-/Status-/Reason-Enums, Kappen 24/8/8); explizite null, Legacy-Records
  ohne Felder und gültige Round-Trips bleiben gültig (Präzedenz `last_error`).
  Regressionstests: Policy-Resume + Operator-Resume + healthy-close unparken
  nur eigene Parks; uncertain bleibt geparkt; acht fehlerhafte Episoden-/
  Resolution-Formate rejecten, null/legacy/valid akzeptiert. Verifikation THIS
  Lauf: tsc clean; monitor 45/45; Suite 246 pass/0 fail/2 env-gated skips in
  2/2 Läufen (Flake nicht als behoben deklariert).
- **Delta-QC Welle B: QC_PASS** auf `28ff295e5c33bb60dd060f0fcafe7fd394b3dfc3`
  (Originalterminal `msg_12391d0960011RouFULEGqdF09`, vollständig gelesen;
  Bericht `waveB-qc.md` final SHA256
  `a509e19da6ae4104ac7b2cd624cf24791a8adcddd1f5c45ef0418dd00d96cf53`): F-B1/F-B2
  unabhängig bestätigt und kehrt Repro-verifiziert; Runzahlen belegt (tsc/build
  1/1, monitor 45/45, agent-control 13/13, Suite 246/0/2 in 2/2);
  `runtime-unavailable`-Parks bleiben als bewusst gescopete Beobachtung für
  späteres Cleanup dokumentiert, kein Befund.
- **Welle C — implementiert (lokal kandidatenbereit, unabhängige QC ausstehend):**
  Sicher begrenzte Logread-API `GET /api/monitor/<id>/log` hinter dem
  bestehenden Peer-/Basic-Auth-Gate (keine MCP-Erweiterung, keine
  Auth-/Security-Abschwächung): klar getrennte Quellen in einer kopierbaren
  Monospace-Textansicht — Registry-Entscheidungslauf (Fenster default 24 h),
  Operational Logs, Engine-Recovery-Projektion WÖRTLICH durchgereicht (keine
  Python-Auflösung im Hub, §4.4-R2), Heartbeat als getrennte Liveness-Quelle
  mit Generation-Identitätscheck, sowie der Tail von
  `<session-share>/monitor/server.log`, bei jedem Request neu aus dem
  AKTUELLEN SESSION-ROOT bestimmt (Reconnect/Share-Wechsel; fremde
  Projekt-Logs strukturell unerreichbar). Sichtbar immer: Abrufzeitpunkt UTC,
  Datenzeitraum, Quellenstand (Share/Generation/Projekt-Hash), je Quelle
  ok/empty/not_configured/absent/mismatch/unsafe/corrupt, truncated/omitted,
  Gesamtabdeckung complete/partial/unavailable — Fehler oder Stale werden
  nie als frisch ausgewiesen. Serverseitige Bounds: Tail ≤256 KiB / ≤2000
  Zeilen (führende abgeschnittene Zeile verworfen), Fenster clamp 1..24 h,
  Antwort ≤512 KiB, sichtbare Kürzungsmarker verweisen auf die Quelldateien;
  Browser lädt nicht unbeschränkt (scrollbares `pre`, max-height).
  Fail-closed Pfadsicherheit: regular-file-/owner-/symlink-/mode-Checks;
  Symlink-Targets werden nie gelesen. Redaktion serverseitig mit der
  bestehenden SECRET_PATTERNS-Allowlist vor jeder Antwort; ein Pattern wurde
  präzisiert (`sk[-_]…`/`gh[pousr]_…` erzwingen Separator), echte
  Key-Formate redigieren weiterhin (bestehende Tunnel-Log-Tests grün),
  Engine-Tokens wie `skipped_attempted` werden nicht mehr verschluckt.
  UI: bestehende Grundstatusanzeige unverändert; große kopierbare Textbox im
  Detailbereich statt Kartenflut; obere Aktualisieren- UND
  Detail-/Status-Refresh-Pfade laden die Ansicht nachweislich frisch;
  Kopier-Interaktion mit ehrlichem Fallback. Keine Filter, kein Dashboard,
  kein Autofollow, kein MCP-Ausbau.
  Candidate: `8e9650bb634d61892c9452ab1fe9e9b3c32a2c1f` (Tree
  `bf52b8cb0da5c7ad7fb1a480418c7ce32d10a595`) auf `28ff295` — Dateien:
  `hub/monitor.py`, `hub/server.py`, `hub/monitor.js`, `hub/styles.css`,
  `tests/hub_test.py`, `tests/hub_monitor_fixture.py`,
  `tests/hub_monitor_browser_test.mjs` (+656/−6).
  Verifikation THIS Stand: hub_test 42 OK (inkl. 5 neuer
  Logread-/Privacy-/Auth-/Truncation-Tests); reale Browser-Suite gegen
  isolierte Fixture 19/19 (inkl. neuer Welle-C-Tests: frische Einträge nach
  beiden Refresh-Pfaden, Fehler-/Stale-Ehrlichkeit, Copy-Reaktion,
  scrollbare Begrenzung, Verbatim-Projektion); Adapter-Regression
  unberührt: tsc clean, monitor 45/45, Suite 246 pass/0 fail/2 env-gated
  skips. Welle-A/B-Schutzinvarianten unverändert; kein Main-Merge, kein
  Push/Release/Deploy/Restart, kein Live-/Produkteingriff (eigene isolierte
  Fixture). Der lastabhängige `dashboard-bootstrap`-Flake bleibt als
  vorbestehend vermerkt, nicht als behoben deklariert.
  Reversible MVP-Kleinentscheidungen (belegt): Fenster-Default 24 h +
  byte/line-Caps wie im Konzept vorgeschlagen, als starting values über die
  API `limits` sichtbar; Heartbeat `absent` → partial, `mismatch` → partial
  mit namentlicher Warnung, `unsafe/corrupt` → unavailable; leere, aber
  vorhandene Datei zählt als vollständig (ok, kein Inhalt); Tail zeigt keine
  Zeitfenster-Filterung (systemd-append-Zeilen tragen keine Zeitstempel —
  rein mengenbegrenzt, im Kopf der Ansicht benannt); Kopieren nutzt Clipboard
  mit Auswahl-Fallback (http-Origin ohne Clipboard-Berechtigung); keine
  Client-seitige Retention über den Request hinaus.
- **QC Welle C (CHANGES_REQUIRED) und Delta-Fix (Autor, lokal):** Bericht
  `waveC-qc.md` (SHA256
  `6040ddf04c14805db65be0780ecc8ef285bddfb82b43fb3e0471b6b17642bae6`, Terminal
  `msg_123bf4442001bv8O8INW8JCkcF`) gegen `bf1939b`: Autorenzahlen bestätigt
  (hub 42 OK, Browser 19/19, Adapter 246/0/2, monitor 45/45, tsc grün);
  SECRET_PATTERNS-Präzisierung ausdrücklich ohne Befund (15 eigene Fälle,
  dokumentierte Altformat-Grenze akzeptiert); Auth/Symlink/Owner/Share/
  Refresh-Pfade PASS. Zwei Befunde: **F-C1** — die strukturierte
  `recovery_projection` wurde unredigiert serialisiert, synthetische
  ghp_/sk-proj-Werte in Label/Identity leaken im JSON, obwohl der Text
  redigiert war; **F-C3** — eine Einzelzeile über der Tail-Grenze (400 KiB,
  mit/ohne Abschlussnewline) erzeugte fälschlich „Datei vorhanden, aber leer"
  und ggf. `complete`. **Delta-Fix `5bf4408f71196e9e232cc35bd004c526f64b4c2e`**
  (Tree `ef57bc4969e56fc9f9617c7755ba7d96f2ce15c1` auf `bf1939b`):
  F-C1 — `redact_structure()` redigiert jeden String-Schlüssel/-Zweig der
  sicheren Antwort-Kopie (`recovery_projection`, `sources`) mit derselben
  Allowlist; legitime Engine-Tokens matchen keine Patterns und bleiben
  byte-identisch; keine Resolver-Neuberechnung, persistierte Engine-Daten
  unverändert. F-C3 — neuer Tail-Zustand `truncated_only` (Datei nicht leer,
  Bytefenster ohne vollständige Zeile) mit TRUNKIERT-Marker und
  `partial`-Einordnung; „empty" nur bei 0 Byte; in-Bounds-100-KiB-Zeile
  bleibt lesbar `ok`. Negative Regressionstests für beide: komplettes
  JSON ohne synthetische Secrets bei byte-exakter Bypass-Kopie harmloser
  Projektion; Riesenzeile mit und ohne Newline (truncated_only, nie
  „complete", kein Content-Leak) plus Empty-/In-Bounds-Kontrollen.
  THIS-Lauf-Verifikation: hub_test 44 OK (davon 21 Log-Tests, +2 neu),
  Browser-Fixture 19/19, Adapter tsc clean, monitor 45/45, Suite 246/0/2
  (env-gated). Die unabhängige Delta-QC zu `5bf4408` steht aus — keine
  Selbstabnahme; Welle D wird nicht vor der Delta-QC gestartet.
- **Welle C: Delta-QC QC_PASS** auf `00523c2` (Original `msg_123ce6010001WYsCyj4P2SHv25`
  zur Kenntnis genommen; Bericht final SHA256
  `b2f4dec47bee98bfaa524a2750c8db95b4b0b87290bb94332fc3399853683841`):
  F-C1/F-C3 Repro-kehrend bestätigt, legitime Projektion byte-identisch,
  Runzahlen hub 44 OK / Browser 19/19 / Adapter 246/0/2 / monitor 45/45.
- **Welle D — Gesamtabnahme (isoliert, ohne Mainintegration):** Kumulativer
  Diff `8936f621..HEAD` ausschließlich autorisierte Flächen (A/B/C + Tests/Doku).
  Abnahmematrix §6 mit Belegen (Testnamen; alle Läufe THIS Durchgang, exakte
  Zahlen unten):
  task_ad26435f A–J: (A) Resolver≡Monitor-Identität — „Welle D AITL-Fixture“
  assertiert persistierte `recovery_resolution` == `resolveRecoveryChain`
  gleicher Revision/Evidenz Eintrag-für-Eintrag; (B) alle
  degrading×providerSkip-Kombinationen inkl. null/unset — resolver-Matrix-Units
  260–315 + Engine-Tests 1691/1914; (C) beide aus → nur eigener Fallback —
  noDegrade-Fall; (D) Quota-Skip gezielt, Fremdprovider bleibt — Resolver-Test
  307 + Engine 1914 + Kette (4); (E) Primary↔Fallback ohne Cooldown —
  1778 + Kette (6); (F) kein Doppelversuch über Restart/doppelte Runtimes —
  1751 (Restart) + Dedupletten-Unit „matrix F doppelte Runtimes“;
  (G) Erschöpfung transparent + Park-Anhebung — 1691/1949 + Kette (5);
  (H) busy/unknown/aborted/pending/fachlich ohne Provider-Routing —
  Admission-Unit + 1817 + Kette (1) updates=0 bei Workerfehler;
  (I) Policywechsel + WAL + Variant-Readback inkl. Mismatch — 1751/1853/1879;
  (J) Compaction-/Budgetgrenzen unverändert — bestehende Compaction-Tests +
  1817-Budgetpfad. task_6679fb88 A–E: (A) Fixture-Workerdispatch →
  terminaler Fehler → Wake zeigt Zustand/Receipt/Digest/Grund — Welle-A-Tests
  + AITL-Kette (exakter Receipt `msg_2990…`, Marker, ein Wake); (B) stille
  Pfade einzeln erklärbar ohne Extradispatch — Streak-/noop-/error-Tests
  1413/1509 + Kette-Historie; (C) Refresh zeigt tatsächlich neue Zeilen,
  Fehler/stale/teilweise trennbar — Hub-Log-Tests + Browser 19 (beide
  Refresh-Pfade, 503-Fall); (D) Bounds/Truncierung sichtbar scroll-/
  kopierbar — Bounds-/Truncation-/Riesenzeilen-Tests + Browser
  overflow-Assertion; (E) Secret-/Prompt-Redaktion, Projektgrenze,
  History/Logs/Heartbeat getrennt — Voll-JSON-Secret-Scan, Symlink/
  Share-Wechsel-Tests, Kettentrennung im Text. Anker-spezifisch: der
  AITL-Fall §7 ist als isolierte Fixture-Kette reproduziert und erklärt —
  beobachtete Zustände, korrelierte Receipts, exakte Entscheidung,
  zulässige Fortsetzung/Hold; der Livebeweis an der alten Instanz bleibt
  bewusst ausstehend (kein Liveeingriff, §4.7). Cross-Writer-Rollback-
  sicherheit: neuer Test „hub writer preserves engine additive recovery
  fields“ (PUT-Reset verliert Episode/Projektion/Workermarker nicht).
  Versionierung: KEIN Bump in dieser Delegation — Mainintegration ist nicht
  freigegeben; Skript bleibt 0.7.30, Adapter 0.1.41, Tags v0.7.30. Der
  reguläre Release-Flow (RELEASING.md 1./2./4.: OCVM_VERSION, Adapter-
  package.json/types.ts `ADAPTER_VERSION`, Pin-Update im Skript) ist Teil
  des späteren, separat zu beauftragenden Mainintegrations-/Release-
  schritts; dieser Kandidat ist ausdrücklich keine Veröffentlichung.
  Limitierungen/Bedienhinweise: diagnostische Tail-/Fenster-Grenzen sind
  Initialwerte (256 KiB/2000 Zeilen/24 h), Antwort-Deckel 512 KiB,
  Heartbeat-Streaks prozesslokal; `server.log`-Rotation bleibt unbegrenzt
  (Konzept-Risiko 4, Cleanup vermerkt); `runtime-unavailable`-Parks
  behalten ihr Label bewusst (Scope-Entscheidung F-B1, Cleanup vermerkt);
  Bedienung: Monitor-Details öffnen → Diagnose-Textfeld, Kopier-Button,
  beide Aktualisieren-Pfade; API nur Hub, nicht MCP (§8 e).
- **Welle-D-Zahlen (D1-Nachtrag, verbindlich THIS Durchgang, von der Gesamt-QC
  unabhängig reproduziert):** Adapter-Suite 248 pass / 0 fail / 2 env-gated skips in
  3/3 Läufen; monitor 46/46; agent-control 14/14; hub_test 45 OK;
  agent_control_test.py 57 OK; Browser-Fixture 19/19; monitor_service_test.sh 5× ok.
  D2: die §11-Zeilenreferenzen waren ±1 gedriftet; korrekt
  1692/1752/1779/1818/1854/1880/1915 (Testnamen eindeutig).
- **Lokale Main-Integration (autorisiert, ohne Veröffentlichung):** Christian
  erteilte die Freigabe der Main-Integration. Vorher: main bei
  8936f621f86e4ff96b69bcc8c849a996d8ba26c0 (origin/main 33528bb, lokal drei Commits
  voraus; ein veraltetes 978f5f9-Lesen zu Sitzungsbeginn wurde durch das Reflog
  widerlegt — dieser Commit existiert nicht). Aktion: Fast-forward des Kandidaten
  65e73c6040be5a7b148f02b7ea9bcee2ceaf26f2 auf main im Primary-Checkout — main
  steht exakt auf dem gesamt-QC_PASS-Kandidaten; dieser Doku-Commit ist der reine
  Integrationsnachweis. Einzige Überlappung: zwei ungetrackte Predecessor-Kopien
  der Paket-Dokumente (Pre-Go-Stand, sha256 25f9a381…/94ea1da0…), byte-treu
  gesichert unter .opencode-vm/integration-backups/be951293-mainintegration-20261010/
  (inkl. BACKUP-SHA256.txt); ihr Inhalt ist vollständig in die offizielle Version
  aufgegangen. Fremderhalt: 90 fremde Dirty-Einträge unberührt; die Schnittmenge
  der Kandidatenpfade mit den verbleibenden Dirties ist leer (92 vorher = 90 plus
  die zwei gesicherten). Versionierung: kein Bump — EFBE-Präzedenz (3844f2e hielt
  0.7.30/0.1.41 bei lokaler Integration); die RELEASING-Schritte 1–4 (Version,
  Pins, package.json/types.ts, Tag/Assets) bleiben ein separater, ausdrücklich zu
  beauftragender Veröffentlichungsschritt; diese Integration impliziert weder
  Release noch Push noch Tag.
  Integrationstests auf dem exakten Maincommit im eigenen sauberen Test-Worktree
  (/tmp/opencode/be951293-inttest, da der Primary fremde Dirty-Tracked-Dateien
  trägt): tsc/build ok; monitor 46/46; agent-control 14/14; Suite 248/0/2;
  hub_test 45 OK; agent_control_test 57 OK; Browser-Fixture 19/19;
  monitor_service 5× ok — deckungsgleich mit der Gesamt-QC.
  Persistenz-Downgrade real geprüft: der gebaute Alt-Adapter von 8936f621 liest
  eine Registry mit recovery_episode/recovery_resolution/Worker-last_error;
  altseitige Schreiboperationen (Synthesis-Set, Titel-Reset über die
  Registry-Mutation) werden angewendet und alle additiven Felder bleiben
  byte-identisch erhalten (Neulesung durch die neue Version verifiziert); der
  alte hub/monitor.py von 8936f621 validiert und mutiert dieselbe Datei, das neue
  Hub bestätigt danach Episode/Projektion/Marker intakt. Semantische Grenzen bei
  Rückstufung: alter Code ignoriert die neuen Felder (Legacy-Routing ohne
  Episoden-/Admissionsfilter, Beobachtung ohne Receipt-Korrelation, alter Rebind
  räumt last_error nicht — unter neuem Code erledigt der nächste reuse/rebind das
  wieder); alte UI/Server haben keine Logread-Route und zeigen die Projektion
  nicht. Die Felder sind für alte Leser inert und nach einem Vor-Restore nahtlos
  weiter nutzbar. Rückkehrmöglichkeit: Anker ist der Vorher-Stand 8936f621;
  sicherer Weg ist ein gezieltes Revert des Integrationsbereichs — ein hartes
  Zurücksetzen des Primary-Worktrees scheitert am Schutz der fremden geänderten
  Dateien; Registry-Daten überleben beide Richtungen (belegt), Dokument-Backups
  liegen am obigen Pfad.
- **Offen:** unabhängige GesamtQC über dem main-Endstand (Code 65e73c6 + Doku-Commit); danach separat:
  Release-Flow gemäß RELEASING.md (Versionsschritt als eigener Auftrag) und die
  Hardware-/Session-Abnahme inkl. optionalem AITL-Livebeweis (extern, nicht durch
  lokale Tests ersetzbar).

## 12 Gate-Fix-Kandidat: Noop-Gate verschluckt korrelierte Managerterminalfehler (2026-10-10, Operator-Go)

Grundlage: Diagnosebericht Rev. 2
(`task_be951293-…-aitl-standstill-diagnosis-20261010.md`, SHA256
`d55dd001…f795fa`) mit Code- und Livebelegen (stiller `noop-unchanged`-Loop,
`monitor-engine.ts`-Gate vor receipt-korreliertem Statusread; Livefall
`provider_header_timeout` 12:12:33 UTC ohne Recovery/Park). Der Operator-Go für
diesen begrenzten Kandidaten ersetzt ausdrücklich die frühere reine
Diagnosefreigabe; keine AITL-Runtime-Berührung, kein Trigger, kein Deploy.

**Umsetzung (minimal, keine neue Fallbacksemantik):**
- `state.receipt_observation` (additiv, `{receipt, outcome: healthy|held, at}`,
  fail-closed-Validierung nach QC-F-B2-Muster) beobachtet den aktuellen
  admitted Dispatch-Receipt genau einmal.
- Das Noop-Gate wird nur noch durchlaufen, wenn der Receipt kein
  unbeobachtetes Terminaloutcome hat; sonst läuft der neue
  `observeUnchangedReceipt`-Watch: receipt-korrelierter Statusread, SafeHold
  bei Pending-Input, danach unverändert `classifyEvidence` →
  `compactionContinue()`/`recover()` (W2-Budget, Admission, Abort-Verify,
  Schema-4-Kette, WAL/Idempotenz bleiben unangetastet).
- Konvergenz: echtes Park/ Hold settled den Watch (sichtbar, kein Loop);
  Recovery-Dispatch verschiebt den Watch auf den neuen Receipt;
  `update-unverified`/`send-failed` bleiben ungeasettet und lassen die
  endliche Episode bis zur Erschöpfungsparkung fortschreiten; gesunder
  Receipt schließt eine offene Episode exakt wie ein Healthy-Wake (§4.5 R1);
  Active-Turn/Pending bleiben zusammengeführte Bounded-Decisions ohne
  History-Wachstum. Bewusste Abweichung dokumentiert: Auf dem unveränderten
  Board wiederholt der Watch keine side-effectvollen Abort-Versuche pro
  Intervall (der geänderte Board-Pfad behält sein Retry-Verhalten).
- Beweisgrenze: der Watch korreliert ausschließlich über den eigenen
  Dispatch-Receipt; fremde Turns werden nie attributiert.

**Skill-Nacharbeit übernommen (Herkunft dokumentiert):** Commit
`ac772e0aeb6f7d497e292419c815c79d42b63576` (Branch
`task/be951293-skill-reporting`, r50, 87/87 OK dort) als `ca7108d` per
Cherry-Pick in diesen Kandidaten übernommen — instruction-only
`monitor-reporting.md` (evidenzierte Fehlerklassen bleiben in Monitorberichten
sichtbar, Fundstelle nennen, keine Fehlerfreiheit aus Deckungslücken).
Keine Inkompatibilität zum Gate-Fix; Cloud/install bleibt separat.

**Versionierung (Repositoryverfahren, RELEASING 1–4):** Skript 0.7.30 →
**0.7.31**; MCP-Adapter 0.1.41 → **0.1.42** (package.json, package-lock,
`ADAPTER_VERSION`, Dateiname/Pin). MCP-Archiv zweifach reproduktiv gebaut
(byte-identisch, SHA256 `a15302c5…e85b72` gepinnt); OpenLive-/Hub-Archive
inhaltlich unverändert (nur TAG-Referenzen auf v0.7.31). Kein Push/Tag/Release.

**Verifikation THIS Lauf (Kandidat):** tsc clean; Adapter-Suite 253 pass /
0 fail / 2 env-gated skips (+5 neue Gate-Fix-Regressionen: Recovery aus
unverändertem Board, Healthy-Settlement, Erschöpfungsparkung ohne wiederholte
Aborts, Pending-Input-merged-hold, Feldvalidierung); agent-control 14/14;
hub_test 45 OK; agent_control_test 57 OK; ChatGPT-Skill-Test 87/87 OK. Der
vorbestehende lastabhängige dashboard-bootstrap-Flake trat in 1 von 3 Läufen
auf (dokumentiert, nicht neu). Zwei QC-bezogene Welle-A-Tests wurden
minimal an die neue ehrliche Settlement-Entscheidung angepasst
(`receipt-observed-healthy` als eigener Cause-specific-Mergekey); QC-Intention
(kausspezifische Mergekeys) bleibt erhalten.

**Offen:** unabhängige QC dieses Kandidaten (separat beauftragt, keine
Selbstabnahme); Mainintegration/Release/Push bleiben explizite
Operator-Schritte. Integrations-/Rollouthinweise: Kandidat via Fast-Forward
auf main (Host), Release-Flow gemäß RELEASING.md baut/published v0.7.31 mit
den gepinnten Archiven; laufende Sessions übernehmen 0.1.42 mit dem nächsten
update/Sessionsync — Registry-Downgrade/Upgrade bleibt durch das rein additive
Feld in beiden Richtungen bewahrt (altes Code ist inert gegenüber
`receipt_observation`).
