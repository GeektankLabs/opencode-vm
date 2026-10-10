Task-ID: task_be951293-e41a-5d69-a394-b0d9c944c960
Titel: Unabhängige Konzeptprüfung — Monitor-Zuverlässigkeit und Diagnose (Concept-Plan)
Stand: 2026-10-09 · Prüfer: unabhängige Session (GLM5.3 high, frisch) · Quelle: Main 8936f621f86e4ff96b69bcc8c849a996d8ba26c0

## Revisionsprüfung

Beide Artefakte hash- und größengenau wie beauftragt; Main-Stand identisch:
- Concept-Plan `planning/task-concepts/task_be951293-e41a-5d69-a394-b0d9c944c960-concept-plan.md` — SHA256 `4427cc1d11e42ff0abb8df80d5327c73accadbc1b00365fefe705bf8c892d43c`, 17480 B ✓
- Compact-Context `.opencode/tasks/task-task_be951293-e41a-5d69-a394-b0d9c944c960.compact.md` — SHA256 `6f2ce279c682cc5653051604a7710d9b8c3f1f768529041ed0e2ab785daab2fc`, 2859 B ✓
- Beide kanonische Member-Tickets zusätzlich vollständig aus der Board-DB gelesen (read-only; `01M4H08X…`, `01M4H4VF…`, Anker `01M4H4X1…`, alle Status todo — stimmt mit Plan §2 überein).

## Ergebnis: CHANGES_REQUIRED

Struktur, Ist-Stand-Belege, Matrizenkonsolidierung und Entscheidungskultur (Erschöpfung offen, Tail-Grenzen als Vorschläge, Logsink server.log) sind tragfähig. Es stehen aber belegte Spezifikationslücken in genau den vom Auftrag betonten Punkten. Alle Korrekturen sind minimal (Sätze, keine Neuzeichnung).

## Befunde (priorisiert)

### P1 — Hoch

**B1. §4.4/§5: `candidateOrder` ist nur Reihenfolge — zentrale Identitäts-/Skip-/Availability-Logik ist nicht vorhanden und nicht verortet.**
Beleg: `adapters/mcp/src/agent-control.ts:182–192` liefert `string[] | null` (Stage-Labels wie `Deep.main`); Doku explizit: Runtime-Filterung (bereits fehlgeschlagene Identitäten, Provider-Skip-Evidenz, Availability) „stays a documented management-layer step"; `null` im Legacy-Regime. Spiegel `hub/policy.py:163` gleichlautend. Der Plan sagt „Identitäts-/Skip-Evidenz zentral, nicht monitorlokal abweichend", spezifiziert aber weder die neue geteilte Filter-/Auflösungslogik (Stage-Label → vollständiges Tupel, Katalogverfügbarkeit, Attempted-Filter, Provider-Skip-Gate) noch ihren Ort; §5 Welle B begrenzt `agent-control.ts` zugleich auf „nur Export/Wiederverwendung, keine Semantikänderung" — das ist mit neuer zentraler Logik dort unvereinbar, und monitor-lokale Implementierung verletzte den Auswahlvertrag (Ziffer 3: zentral und gleich, nicht monitorlokal abweichend). Auch der Legacy-Fall (`candidateOrder → null`): heute gilt `fallbackChain`-Semantik (monitor-engine.ts:1186–1205) — muss als unverändert benannt werden.
Minimale Korrektur: §4.4 Bullet 2 präzisieren (candidateOrder = Kandidatenfolge; Auflösung/Filterung als neue geteilte, additiv exportierte Helper in agent-control.ts bzw. benanntes Shared-Modul) und §5 Welle B entsprechend anpassen.

**B2. §4.1 „genau dieselbe classifyEvidence-Klassifikation" vs. §6/Matrix H „unknown → kein Provider-Ausfallrouting" — Widerspruch ungelöst.**
Beleg: `classifyEvidence` (monitor-engine.ts:1131–1140) liefert für Kategorie `unknown` `blocked`; `classifyRepairKind("unknown")` → operational/excluded (OPERATIONAL_CATEGORIES enthält `unknown`, :1142–1156, :1165–1167); heutiger Wake-Pfad ruft damit `recover()` → Provider-Wechsel auf (:379–381). Der Auswahlvertrag („Fehlerkategorie unknown nicht pauschal als providerweit ausgefallen behandeln") und Matrix H verlangen das Gegenteil fürs Routing. Der Plan trennt Beobachtungsklassifikation und Recovery-Admission nicht: „nachgewiesener terminaler Providerfehler" (§4.1) bleibt ohne Kategoriendefinition.
Minimale Korrektur: in §4.1/§4.4 die Admission-Kategorienmenge explizit von der Beobachtung trennen (unknown/fachlich/pending → ehrlicher Hold/Park mit Grund, kein Provider-Routing; Beobachtung/Markierung darf dieselbe Klassifikation nutzen).

### P2 — Mittel

**B3. §4.1 Digest-Wake-Invariante fehlt — Digest enthält keinen Fehlerfingerprint.**
Beleg: `workerIndexDigest` (monitor.ts:766–780) hasht nur worker_key, alias, lifecycle, runtime_session_id, creation/dispatch/result_receipt, last_synthesis_at, updated_at. Der Wake greift ausschließlich, wenn die Failed-Markierung ein gehashtes Feld ändert (lifecycle und/oder updated_at). Eine Implementierung, die nur neue additive Fehlerfelder schreibt, erzeugt keinen Digestwechsel und reproduziert stumm das AITL-Symptom.
Minimale Korrektur: explizite Invariante in §4.1/§4.2 (Markierung muss lifecycle/updated_at verändern oder workerIndexDigest additiv erweitern).

**B4. Worker-Failed-Korrelation nur sessionweit, nicht an dispatch_receipt gebunden.**
Beleg: Manager fragt Status mit `dispatch_wal.message_id` ab (monitor-engine.ts:359; Plan nennt :361 — 2-Zeilen-Drift), Worker-Beobachtung ohne Korrelationsargument (:485). `classifyEvidence` bewertet sessionweiten `state==="failed"` plus letzten Fehler — ein fremder/handgesteuerter Turn könnte falsch dem Worker-Dispatch zugeordnet werden. §4.2 benennt „Beobachtung nur über worker.runtime_session_id", löst die Turn-Attribution aber nicht.
Minimale Korrektur: entweder Receipt-/Turn-Attribution fordern (z. B. Statusabfrage mit dispatch_receipt-Korrelation analog :359) oder die Annahme „dedizierte Single-Purpose-Worker-Session" explizit als solche dokumentieren.

**B5. §4.7 Rollback-Behauptung ist für die empfohlene Lifecycle-Entscheidung (§8 d: eigener Wert `failed`) widerlegbar.**
Beleg: additive Felder werden toleriert (monitor.ts:266 permissive JSON.parse, :205 prüft nur schema===1, :330 Roundtrip erhält unbekannte Felder) — aber ein neuer Enum-Wert in einem bestehenden Feld ist nicht additiv-sicher: tools.ts:1123 `monitorWorkerLifecycleSchema = z.enum(["reserved","active","idle","archived"])` (strikte Deklaration/Validierung; Worker-Lifecycle fließt in Tool-Outputs :2058, :2221). Ein älterer Adapter bzw. schemavalidierende Clients sehen `lifecycle:"failed"` als ungültig.
Minimale Korrektur: §8-d-Empfehlung auf `idle`+Fehlermarker ändern (rollback-sicher) oder das Rollback-Caveat explizit benennen (alte Monitor-Read-Tools failen auf solchen Records; „Rollback-sicher" gilt dann nur für additive Felder, nicht Enum-Erweiterung).

**B6. §4.5/§4.6: Episodenschnitt bei Policyänderung — Attempted-Übernahme nicht ausformuliert (Vergessen/Duplizieren möglich).**
Attempted-Persistenz ist „pro Recovery-Episode" deklariert (§4.5); §4.6 startet bei Policyänderung mit neuen zulässigen Kandidaten einen neuen Episodenschnitt „mit Verweis auf die alte". Ob der neue Schnitt attempted-Identitäten für unverändert bleibende Kandidaten übernimmt, steht nicht dabei — Auswahlvertrag: „unveränderte gescheiterte Kandidaten nicht allein wegen neuer Policyrevision vergessen" und „ohne wiederholtes Anspringen des ersten bereits gescheiterten Fallbacks".
Minimale Korrektur: ein Satz — neuer Episodenschnitt übernimmt die attempted-Identitäten der alten Episode für weiter zulässige Kandidaten (Vereinigung, dedupliziert); bewusste Neuauflage nur per Operator-Trigger.

**B7. Ziffer-6-Entscheidungsfesthaltung im Logging nicht explizit (§4.8).**
Der Auswahlvertrag verlangt vor jeder Recovery-Entscheidung Policyrevision, Kandidaten/Skipgründe und gewähltes vollständiges Runtime-Tupel nachvollziehbar festzuhalten. §4.8 nennt Korrelation und maschinenlesbaren Grund, aber nicht diese drei Inhalte für Recovery-Entscheidungen.
Minimale Korrektur: Aufnahme in die §4.8-Entscheidungsliste (policy revision, evaluierte Kandidaten inkl. Skipgründe, gewähltes Tupel provider/model/variant).

### P3 — Niedrig

**B8. §4.9/Welle C: Quellen-Lifetime von `server.log` pro Session-Share nicht benannt.** server.log liegt pro Share (`opencode-vm.sh:13811–13813`, `$dir/server.log`), Registry projektlokal; Hub ist generationsgebunden (hub_runtime_dir `$SESS_SHARE/hub`, opencode-vm.sh:13993–13996). Pfadzugang ist gegeben; bei Reconnect/Share-Wechsel kann der Tail eine andere Datei betreffen. Ein Satz zu Quellenstand/Lifetime genügt (Diagnoseticket: „echtes Logsink-Discovery berücksichtigen").

**B9. Zeilendrift §3: `:361` ist tatsächlich :359.** Kosmetisch; §3 verpflichtet bereits zum Neuabgleich vor Umsetzung.

## Verifizierte Pass-Bereiche (Auszug)

- §3-Ist-Stand an Main 8936f62 Zeile für Zeile stichprobenfest verifizert: :165, :183, :297–302, :308–334, :342/:465, :476–505 (nur `completed`; :486–489 catch/continue), :698–749 (Primary frisch pro Dispatch, :701), :735–737/~:845 (Readback ohne Variante), attempted lokal ohne Variante (~:814), fallbackChain :1186–1205, monitor-main.ts:80–82 policyView-Reduktion, Heartbeat/Ownership-Watch, hub-Dateien und /api/monitor-Routen (server.py:322–329), Refresh-Flächen hub/monitor.js:166–168/:439–455.
- Matrizen A–J und A–E vollständig und unverändert konsolidiert (§6); AITL-Fall als plausibel-nicht-bewiesen geführt (§7) — korrekt kein Blocker.
- Erschöpfungs-/Retry-/Parksemantik nur als Empfehlung markiert (§4.6/§8a), Tail-/Retentionsgrenzen nur als Validierungsvorschläge (§4.9/§8b), Logread-Exposition MVP nur Hub (§8e) — entspricht den kanonischen Offenhaltungen; keine unnötige Operator-Eskalation der technischen MVP-Auswahl (Logread API, Lifecycle, Tailgrenzen) erkennbar.
- Variant-Fix (§4.5: vollständige Identität provider/model/variant inkl. Readback) deckt die belegte Lücke korrekt ab.

## Grenzen der Prüfung

Keine Tests, kein Livezugriff auf Monitor/Runtime, kein Byte-Nachweis deployter Builds (wie vom Plan selbst eingeordnet). Board-DB nur lesend konsultiert; kein Boardstatusübergang.

Empfehlung: B1–B7 vor Implementierungs-Go einarbeiten; danach ist das Konzept aus Reviewersicht entscheidungsreif. Die offenen Operator-Entscheidungen (§8 a–e) bleiben bewusst offen und sind korrekt als solche gekennzeichnet.

---

# Rev. 2 — Gezielte Nachprüfung (2026-10-09, gleiche unabhängige Prüfreihe)

## Revisionsprüfung Rev2

- Concept-Plan Rev2: SHA256 `0f9fb966c0daa556128eae7896fcbe2ddb135ca2783ee6ec539ae74c08ac8538`, 25155 B ✓ (beauftragt, direkt vollständig gelesen)
- Compact-Context Rev2: SHA256 `2e67f0191427bf262d037f3907ac26b3f2d136a442e0f83cccdb5342bad05331`, 3905 B ✓
- Quelle Main `8936f621…` unverändert; kanonische Tickets unverändert (todo). Originalbefunde Rev1 oben bleiben unverändert historisch erhalten.

## Ergebnis Rev2: CHANGES_REQUIRED (schmal — 2 verbleibende Blocker, 2 Kosmetik)

## Auflösungsprüfung B1–B9 (alle adressiert, keine Regression gefunden)

- **B1 ✓ aufgelöst:** §4.4 präzisiert candidateOrder als reine Stage-Label-Reihenfolge (Dokubeleg agent-control.ts:176–181), verortet neue additive geteilte Auflösungs-/Filter-Helper (agent-control.ts bzw. `policy-resolution.ts`), Legacy-`null`-Pfad behält fallbackChain-Semantik explizit bei; §5 Welle B konsistent („candidateOrder selbst unverändert"). Rest siehe R2 (Hub-Integrationspfad).
- **B2 ✓ aufgelöst:** §4.1 Ziffer 2 trennt Beobachtung (classifyEvidence inkl. unknown) von Recovery-Admission; die sechs Provider-Kategorien sind vollständig bezogen auf OPERATIONAL_CATEGORIES (monitor-engine.ts:1142–1156); unknown/fachlich/pending/INPUT_REQUIRED/aborted → Hold/Park, nie Provider-Routing — deckungsgleich mit Matrix H. Compaction-Carve-out bleibt über Matrix J unberührt.
- **B3 ✓ aufgelöst:** §4.1 Ziffer 1 benennt die Hashfelder (monitor.ts:766–780), fordert Digestreaktion über gehashte Felder oder additive Digest-Erweiterung, plus Idempotenz (Marker nur beim Zustandsübergang — kein ewiger Delta-Wake).
- **B4 ✓ aufgelöst (Orchestrator-Anmerkung a erfüllt):** Turn-Attribution primär über `dispatch_receipt`-Korrelationsargument analog Manager :359; das Gateway ist receiptfähig (Interface monitor-engine.ts:67 `getSessionStatus(sessionId, messageId?)`, Manager nutzt es :359), damit ist die Single-Purpose-Fallback-Klausel faktisch schlummernd, keine Ersetzung durch bloße Annahme; unklares Attributionsergebnis bleibt über Ziffer 2 konservativ (keine Evidenz → kein Provider-Routing, ehrlicher Hold).
- **B5 ✓ aufgelöst:** §4.1/§8 d: `lifecycle="idle"` + additiver Fehlermarker; Enum tools.ts:1123 bleibt unverändert; Risiko (6) korrekt umformuliert („Enum-Erweiterung wäre es nicht — daher vermieden"). §4.7-Aussage ist damit auf additive Felder gescoped und durch Rev1-Belege (monitor.ts:266/:205/:330) gedeckt.
- **B6 teilweise aufgelöst — siehe R1 (Attempted-Scoping).** Die Übernahme-Vereinigung bei Policyänderung ist korrekt spezifiziert.
- **B7 ✓ aufgelöst:** §4.8 nennt Policyrevision, evaluierte Kandidaten inkl. je Skipgrund, gewähltes vollständiges Tupel provider/model/variant.
- **B8 ✓ aufgelöst:** §4.9 Quellenstand/Lifetime (server.log pro Share, Registry projektlokal, Hub generationsgebunden, Neubestimmung der Tail-Quelle bei Share-Wechsel).
- **B9 ✓ aufgelöst:** §3 nennt :359.

Empfehlungskultur: §8 trennt jetzt sauber die einzige echte offene Produktgrenze a) (Erschöpfungs-/Retry-/Park-/Reset, kanonisch in task_ad26435f) von begründeten reversiblen technischen MVP-Empfehlungen b)–e) mit Belegen — entspricht der Rev1-Empfehlung; keine neuen Wunschfeatures in Rev2 erkennbar.

## Verbleibende Blocker

### R1 (hoch) — §4.5/§4.6: Attempted-No-Retry-Regel unzureichend gescoped; kollidiert bei unqualifizierter Lesart mit kanonischer Primary-Rückkehr.

Beleg: §4.5 „**kein automatisches wiederholtes Probieren derselben Identität**", „eine bewusste Neuauflage bereits gescheiterter Identitäten erfolgt nur per explizitem Operator-Trigger"; §4.6 „kein automatisches Wiederholen bereits gescheiterter Identitäten". Kanonisch (task_ad26435f, Primary-Rückkehr): „Der Nutzer akzeptiert ausdrücklich auch bei anhaltender Quota wiederholte erfolglose Primary-Proben; kein stiller Cooldown als Ersatz" und „Scheitert Primary erneut, wieder erlaubte Fallbackfolge"; Matrix E („Primary↔Fallback-Zyklus ohne Cooldown"). Die gescheiterte Primary steht selbst als attempted Identität in der Episodenliste; liest man die No-Retry-/Neuauflage-Regel epistenübergreifend (inkl. Übernahme-Vereinigung), sperrt sie die automatische Primary-Neuprobe und erzeugt Fallback-Lock-in — im Widerspruch zu §4.5 Bullet 1 („nächster normale Wake automatisch wieder Primary, kein Cooldown").
Minimale Korrektur (1–2 Sätze in §4.5/§4.6): Die No-Retry-/Neuauflage-Regel gilt ausschließlich für die Kandidatenwahl innerhalb der **erfolglosen laufenden Recovery-Episode**. Ein **erfolgreicher** Fallbackschritt schließt die Episode ab; danach probieren normale Wakes das aktuelle Primary automatisch erneut (kein Cooldown; resolveRuntime :698–749 bleibt vom Attempted-Filter unberührt), und bei erneuter Primary-Fehlerevidenz darf eine **neue Episode** mit erlaubter Fallbackfolge beginnen.

### R2 (hoch) — §4.4: „von Hub-Management und Monitor gleichermaßen benutzt" ist eine sprachübergreifende Behauptung ohne konkreten Integrationsweg.

Beleg: Der Hub ist eine eigenständige Python-Implementierung — `hub/policy.py:163–181 candidate_order` und PolicyStore lesen `agent-control.json` direkt (hub/policy.py:218); `hub/server.py` ruft den TS-Adapter nicht auf (`/api/monitor/candidates` :592ff. betrifft Board-Aufgabenkandidaten, nicht Runtime-Policy). Ein TS-Helper in `agent-control.ts`/`policy-resolution.ts` ist für den Hub nicht importierbar. Der Auswahlvertrag (Ziffer 3) verlangt Identitäts-/Evidenzsemantik „zentral und gleich für Hub/Agenten/Monitor"; ohne benannten Mechanismus entstünde eine dritte unabhängige Fläche neben TS-Helper und Python-Spiegel — genau die verbotene Divergenz.
Minimale Korrektur (ein kurzer Absatz in §4.4; eine Option genügt als Konzept): (i) **Enginekanon/Adapterread** — die Engine persistiert die je Recovery-Entscheidung aufgelöste Kandidatenliste inkl. Skipgründe als begrenzten projektlokalen Snapshot (Muster wie registry.json/heartbeat), den der Hub direkt liest; oder (ii) Hub liest die aufgelöste Projektion über die bestehende Adapter-MCP-Oberfläche (`get_project_model_policy` exponiert bereits `routing.candidate_order`, tools.ts:212/:506–507 — additiv um aufgelöste Kandidaten erweiterbar); oder (iii) **geteilte Contracttests**, die TS-Helper und hub/policy.py-Spiegel auf identische Fixtures/Ausgaben (Kandidaten + Skipgründe) verpflichten.

## Kosmetik (keine Implementierungsblocker)

- **K1:** §3 (Zeilen 64–67) behält die alte Übertreibung „**der gemeinsame Schema-4-Resolver existiert bereits** … Das MVP bindet den Monitor an genau diese Funktion" — widerspricht der eigenen Rev2-Korrektur in §4.4 und dem Compact-Context („liefert nur Stage-Reihenfolge … bisher nicht vorhanden/verortet"). Umformulieren zu „zentrale Kandidatenfolge-Projektion existiert; vollständige Auflösung/Filterung fehlt (s. 4.4)".
- **K2:** Metadatenzeit „20:47 UTC" (Plan Zeile 4, Compact Zeile 3) trotz Autorenfertigstellung ~20:42 — kosmetisch korrigieren, kein Blocker.

## Grenzen der Prüfung Rev2

Keine Tests, kein Livezugriff, kein Byte-Nachweis deployter Builds; Board nur lesend; eigener Bericht als einziger Schreibzugriff. Keine Bewertung von Featurewünschen jenseits des kanonischen Vertrags.

## Schluss Rev2

Nach Einarbeitung von R1 (Attempted-Scoping auf erfolglose laufende Episode, Primary-Rückkehr explizit frei) und R2 (benannter minimaler Hub-Integrationspfad) sowie K1/K2 ist das Konzept aus Reviewersicht CONCEPT_PASS-fähig; die übrige Substanz (Ist-Stand-Belege, Matrizen, Zuständigkeiten, Empfehlungskultur, Offenhaltung der Erschöpfungsgrenze) ist tragfähig und regressionsfrei überarbeitet.

---

# Rev. 3 — Letzte gezielte Nachprüfung R1/R2/K1/K2 (2026-10-09)

## Revisionsprüfung Rev3

- Concept-Plan Rev3: SHA256 `1386d074a3f44badd6414d756e3dfc6a8a0b22c3ff9dd369c672d83b2c5cfdec`, 27888 B ✓ (vollständig gelesen)
- Compact-Context Rev3: SHA256 `0ed2e3d5204c7653cff129d1fd50823629102dd039d5580bc3d22c8a2a28b437`, 4016 B ✓
- Quelle Main `8936f621…` unverändert; Board unverändert (todo). Keine neue Vollprüfungsschleife — nur R1/R2/K1/K2 und deren unmittelbare Änderungsflächen (§3, §4.4, §4.5, §4.6, §5 Welle D, §10, Header).

## Ergebnis Rev3: CONCEPT_PASS

- **R1 ✓ aufgelöst (§4.5 Scoping, :195–202; §4.6 angepasst):** No-Retry-/Neuauflage-Regel gilt ausdrücklich ausschließlich für die Kandidatenwahl innerhalb der erfolglosen laufenden Recovery-Episode; erfolgreicher Fallbackschritt schließt die Episode ab; danach automatische Primary-Neuprobe ohne Cooldown (`resolveRuntime` :698–749 explizit vom Attempted-Filter ausgenommen); bei erneuter Primary-Fehlerevidenz darf eine neue Episode mit erlaubter Fallbackfolge beginnen; „Policyrevision allein beendet keine erfolglose Episode und vergisst unveränderte Fehleridentitäten nicht" — deckungsgleich mit der kanonischen Primary-Rückkehr-Forderung („wiederholte erfolglose Primary-Proben; kein stiller Cooldown"; „Scheitert Primary erneut, wieder erlaubte Fallbackfolge") und widerspruchsfrei zum Policyänderungs-Schnitt (§4.6: Schnitt nur bei neuen zulässigen Kandidaten; das „allein" präzisiert genau diese Grenze). Kein Widerspruch zu §4.5 Bullet 1 / Matrix E; kein Fallback-Lock-in mehr möglich.
- **R2 ✓ aufgelöst (§4.4 Enginekanon-Vertrag, :165–178; §5 Welle D erweitert):** Auflösungs-/Filterlogik genau einmal in TS (Adapter+Engine); Engine persistiert je Recovery-Entscheidung die aufgelöste Kandidatenliste inkl. je Skipgrund und Policyrevision als begrenzten projektlokalen Snapshot im bestehenden Registry-Muster; Hub rein lesender Konsument, keine Python-Filterreimplementation, kein Microservice/Listener; Begründung nennt die verifizierten Fakten (hub/policy.py liest agent-control.json direkt, hub/server.py ruft den Adapter nicht). Aufgabenteilung candidateOrder (unverändert) vs. neue TS-Helper benannt; Testfläche Welle D (TS-Unit-/Kombinationstests Labels×Filter×Legacy + Konsistenz Hub-Anzeige = persistierte Projektion). Die Rev2-Sprachübergrenze-Behauptung („von Hub-Management gleichermaßen benutzt") ist entfernt. Auswahlvertrag Ziffer 3 damit konzeptionell erfüllt. (Beobachtung, keine Anforderung: der bestehende Python-Spiegel hub/policy.py:163 candidate_order bleibt als Ist-Stand für heutige Anzeige erhalten; neue Divergenz wird durch den Vertrag verhindert, Äquivalenz über Matrix A/Welle D abgesichert.)
- **K1 ✓ aufgelöst (§3 :64–67):** jetzt „zentrale Kandidatenfolge-Projektion existiert bereits … vollständige zentrale Auflösung/Filterung fehlt bisher und wird in 4.4 verortet" — konsistent mit §4.4 und Compact.
- **K2 ✓ aufgelöst:** Metadatenzeit 20:49 UTC (Plan Zeile 4, Compact Zeile 3) — echte Uhrzeit.

Keine Regressionen in den geänderten Flächen; alle übrigen Abschnitte substantiell unverändert zu Rev2 (B1–B9-Auflösungen, Matrizen A–J/A–E, §4.1–§4.3, §4.7–§4.9, §7–§9 unangetastet).

## Verbleibende offene Produktentscheidung (kein Konzeptmangel)

**§8 a) Erschöpfungs-/Retry-/Park-/Resetsemantik** bei fehlendem Fallback oder vollständig erschöpfter Kette — kanonisch offen in task_ad26435f; das Konzept hält korrekt nur die konservative MVP-Empfehlung (§4.6: SafeHold/INPUT_REQUIRED, kein Auto-Retry, Episodenschnitt nur per Operator-Trigger oder Policyänderung mit Attempted-Übernahme) bereit und stellt sie ausdrücklich NICHT als entschieden dar. Diese Operatorentscheidung plus das ausdrückliche Implementierungs-Go für Wellen A–D sind die verbleibenden Schritte vor Umsetzung; der AITL-Livebeweis folgt über die kontrollierte Fixture (§7).

Schluss: Konzept ist aus Reviewersicht entscheidungsreif (CONCEPT_PASS); keine Selbstumsetzung, kein Boardübergang, kein Code/Test/Live/Commit durch die Prüfung.
