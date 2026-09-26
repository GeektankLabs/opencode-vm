# Provider-Verwaltung: Umsetzungsplan

Status: Funktionale MVP-Ergaenzungen in `opencode-vm` 0.5.53 implementiert; automatisierte Integrationstests vorhanden. Gesamt-Abnahme bleibt bis zur realen macOS/Lima- und Provider-Pruefung offen.

Dieses Dokument beschreibt die Vereinheitlichung der Provider-Bedienung sowie die strukturierte Rueckfuehrung von Zugangsdaten aus wegwerfbaren Projekt-VMs. Die MVP-Implementierung folgt den verbindlichen Entscheidungen unten; offene manuelle Abnahmen bleiben als solche markiert.

### Aktueller MVP-Stand

Dieser Abschnitt ersetzt ueberholte Planungsannahmen unten. Logout-Schutz und Lifecycle-Ownership wurden bestaetigt. Der Folgeauftrag verlangt minimale funktionale Vervollstaendigung; Dry-run-Nachbesserungen sind ausdruecklich ausgenommen. Bestehende Dry-run-Optionen bleiben unveraendert.

- Implementiert: providerweiser Auth-Merge, Abschlussreihenfolge, gesicherte Kandidaten, Logout-Schutz und Wiederanlaufmetadaten.
- Implementiert: kontrolliertes Beenden eigener VM-Schreiber, direkte Endstanderfassung vor Zerstoerung, verifizierter Host-Snapshot fuer Keep/Resume und Erhaltung bei Erfassungsfehlern. Gestoppte Sessions ohne verifizierten Snapshot werden nicht automatisch ersetzt.
- Implementiert: Live-Provider-Anzeige ueber den vorhandenen Server, authentifiziertes Web-Login/Logout mit dynamischer Methodenwahl und Zustandspruefung, getrennt von OpenLive.
- Bewusste MVP-Grenzen: keine festgeschriebene OpenCode-Version (Laufzeitpruefung der Schnittstellen, Gesamtkopie-Fallback bei unbekanntem Auth-Format — siehe Nachtrag in 10.2); Web-Login fuer automatische Headless-/Device-Verfahren ohne Zusatzprompts, sonst WebUI. TUI verwendet `/connect`; CLI-Auth nur in einer Shell-VM ohne laufende OpenCode-Schreiber. Keine eigene OAuth-Implementierung oder Polling-Schleife.
- Web-Mutationen und Reload pruefen den Idle-Zustand. Unabhaengige Clients muessen waehrenddessen ruhen; eine atomare Sperre fuer fremde WebUI-Aktionen wird nicht versprochen. Ein Callback-Timeout gilt nicht als Abbruchbestaetigung.
- Implementiert: persistente Provider-Konfigurationsentfernung auch bei alten Session-Kopien und `--fresh`; ausdrueckliches Wiederhinzufuegen erfolgt hostseitig.
- Automatisierte Abdeckung: `tests/provider_test.sh`, `tests/provider_lifecycle_test.sh` (einschliesslich PTY-/Signaltests) und `tests/provider_config_test.sh`, ergaenzt um bestehende Regressionstests.
- Offen und Abnahmeblocker: echte macOS/Lima-Dateirechte, virtiofs, Stop/Resume/Delete und ausdruecklich freigegebener realer Provider-Login. Die historische Detailcheckliste unten ist keine vollstaendige Erledigt-Erklaerung.

Recherchegrundlage: `opencode-vm.sh` Version `0.5.51` und die in der Untersuchung festgestellte OpenCode-Version `1.18.29`. Vor der Implementierung sind die dann eingesetzte Version und ihre Schnittstellen erneut zu pruefen. Quellcode und Dokumentation wurden untersucht; ein realer Login- oder Mehrprojekt-Dauertest wurde nicht durchgefuehrt.

## 1. Ziel

Kommerzielle Subscriptions, API-Zugaenge und lokale Modell-Endpunkte sollen aus Anwendersicht nachvollziehbar verwaltet werden koennen. Schwerpunkt der ersten Umsetzung ist OpenAI-Subscription-OAuth im Zusammenspiel mit OpenCode innerhalb der VM.

OpenCode bleibt fuer Provider-Anmeldung, providerabhaengige OAuth-Verfahren und automatische Token-Erneuerungen verantwortlich. OpenCode VM uebernimmt die Auswahl der Projekt-VM, die Bedienung von aussen, die Rueckspeicherung an definierten Lebenszykluspunkten und die Zusammenfuehrung zurueckkommender Aenderungen.

Der bisherige Komfort gemeinsamer Zugangsdaten fuer mehrere Projekte bleibt erhalten. Eine separate Anmeldung pro Projekt wird nicht vorausgesetzt. Rueckfuehrung aus WebUI und VM-Terminal bleibt gleichwertig unterstuetzt.

Erfolg bedeutet nicht, dass jede Anmeldung unbegrenzt gueltig bleibt. Erfolg bedeutet, dass OpenCode VM keine unveraenderten alten Kopien ueber neuere Aenderungen schreibt, unabhaengige Provider-Aenderungen kombiniert und bewusst akzeptierte Fehlergrenzen transparent behandelt.

## 2. Verbindliche Entscheidungen

- Produktivimplementierung wurde nach der Planerstellung gesondert beauftragt; der aktuelle MVP-Umfang ist oben festgehalten.
- Keine regelmaessige Hintergrundsicherung: kein Timer, kein Dateiwaechter, kein zusaetzlicher Daemon und keine eigene Polling-Schleife.
- Rueckspeicherung erfolgt an vorhandenen, kontrollierten Lebenszykluspunkten, insbesondere beim geordneten Beenden und vor einer durch OpenCode VM veranlassten Loeschung oder Neuerstellung.
- Bei harten Prozess- oder VM-Abstuerzen duerfen Aenderungen seit der letzten erfolgreichen Rueckspeicherung verloren gehen. Das kann einen erneuten Login erforderlich machen und ist ausdruecklich akzeptiert.
- Eine fehlgeschlagene regulaere Rueckspeicherung darf nicht anschliessend durch normale Bereinigung die letzte noch vorhandene brauchbare Kopie vernichten.
- Provider-Eintraege werden strukturiert und einzeln zusammengefuehrt, nicht durch pauschalen Austausch der gesamten Auth-Datei.
- Unveraenderte alte VM-Eintraege ueberschreiben niemals einen zwischenzeitlich geaenderten Host-Stand.
- Bei zwei konkurrierend geaenderten OAuth-Eintraegen gewinnt der Eintrag der zuletzt kontrolliert abgeschlossenen Session.
- Abschlussprioritaet ist eine Produktregel, kein Nachweis der Token-Gueltigkeit. Datei-Mtime, Access-Token-Ablaufzeit und VM-Laufdauer bestimmen diese Prioritaet nicht.
- OpenCode wird nicht geforkt; ein eigener OAuth-Client und eine zentrale Refresh-Vermittlung sind nicht Teil der Umsetzung.
- Die SQLite-Daten und die laufende OpenCode-Datenablage bleiben VM-lokal. Kein Zurueckverlegen des gesamten Datenverzeichnisses auf virtiofs.
- Bestehende Anmeldemoeglichkeiten in WebUI und Terminal bleiben bestehen. Ein neuer Host-Befehl bedient dieselbe Projektumgebung statt eine zweite Host-Anmeldung zu erzeugen.

## 3. Arbeitsannahmen und Klaerungen

Die folgenden Details konkretisieren das Konzept als Umsetzungsvorschlag. Sie sind von den ausdruecklich getroffenen Entscheidungen zu unterscheiden und vor Implementierung des jeweiligen Verhaltens zu bestaetigen.

### 3.1 Abmeldung und Wechsel der Anmeldeart

Empfohlener Default: Eine erfasste bewusste Abmeldung oder ein Wechsel von OAuth auf einen API-Key erhaelt Vorrang gegenueber Ruecklieferungen aelterer Sessions. Ein neuer ausdruecklicher Login kann diese Sperre aufheben. Eine alte VM darf einen bereits global erfassten Logout nicht allein durch ihren spaeteren Abschluss rueckgaengig machen.

Der globale Logout-Schutz wurde vor Implementierung bestaetigt. Die Ausnahme ist nicht stillschweigend auf alle Konfliktarten auszuweiten.

Das betrifft eine bereits erfasste Entscheidung. Ohne Beobachtung oder Rueckfuehrung kann der Host von einem WebUI-Logout nichts wissen. Die Architektur verspricht keine sofortige globale Wirkung unbeobachteter VM-Aktionen.

### 3.2 Befehls- und Konfliktdefaults

- Ziel einer Provider-Aktion ist das aktuelle Projekt; keine automatische Auswahl einer fremden VM.
- Ohne laufende passende Umgebung darf `list` einen klar gekennzeichneten gespeicherten Stand zeigen. `login` und `logout` geben einen Start- beziehungsweise Wiederaufnahmehinweis, statt heimlich eine VM oder Host-Anmeldung zu erzeugen.
- Bei laufender Arbeit wird ein fuer Login/Logout notwendiges Neuladen nicht unangekuendigt erzwungen. Initial lieber nachvollziehbar ablehnen beziehungsweise auf einen ruhenden Zustand verweisen, als eine neue Warteschlange einzufuehren.
- Ein expliziter Adapterbefehl kann nach erfolgreicher Aenderung synchron eine Wiederherstellungskopie sichern. Das ist kein Hintergrundprozess und kein kuenstlicher Session-Abschluss.
- Die globale Uebernahme solcher noch laufenden Session-Aenderungen erfolgt grundsaetzlich bei der kontrollierten Rueckfuehrung. Die Ausgabe unterscheidet VM-Wirkung, Sicherung und globale Uebernahme.
- Echte Konflikte zwischen zwei unterschiedlichen API-Keys, unbekannten Auth-Typen oder widerspruechlichen Endpunkt-Konfigurationen erhalten nicht automatisch die OAuth-Abschlussregel. Default: Host erhalten, Kandidat sichern, Konflikt melden.

Diese Defaults halten den ersten Umfang klein. Neue Optionen nur hinzufuegen, wenn ein konkreter benoetigter Ablauf sonst nicht abbildbar ist.

## 4. Umfang und Nichtziele

### 4.1 Im Umfang

- Providerbezogene Zusammenfuehrung von Auth-Daten mit Ausgangsstand und Uebernahmebestaetigung.
- Einheitlicher synchroner Rueckfuehrungsweg fuer Start/Abschluss, Attach, Shell und kontrollierte Bereinigung.
- Schutz vor Wiederholung alter Ruecklieferungen und vor Rueckschreiben aus einer ueberholten Session-Generation.
- Host-seitige Provider-Liste sowie Login/Logout als Adapter zum vorhandenen VM-OpenCode.
- Klare Abgrenzung von Subscription-Login, API-Key und Einrichtung eigener oder lokaler Endpunkte.
- Gezielte Anpassung der Provider-Konfigurationszusammenfuehrung, soweit sie fuer neue Provider und stabile Entfernung erforderlich ist.
- Migration vorhandener Daten ohne voraussetzungslose Loeschung alter Sicherungen.
- Isolierte automatisierte Tests, dokumentierte manuelle macOS/Lima-Abnahme und Aktualisierung der Bedienhinweise.

### 4.2 Nicht im Umfang

- Jeder regelmaessige oder dateiereignisgesteuerte Auth-Hintergrundprozess.
- Zentrale OAuth-Refresh-Koordination zwischen VMs oder Garantie stoerungsfreier gleichzeitiger Nutzung derselben Refresh-Kette.
- Automatisches Verteilen neuer Tokens in bereits arbeitende VMs.
- Automatische Login/Logout-Schleifen bei 401-, 429- oder Netzwerkfehlern.
- Multi-Account-Pooling, automatische Auswahl verschiedener Abos oder Erhoehung von Nutzungskontingenten.
- Ein generischer Secret-Manager oder eine neue Erweiterungsregistry.
- Vollstaendige Neugestaltung von SQLite-, Chat-Historien-, Konfigurations- oder OpenLive-Architektur.
- Ungefragte Bereinigung aller historischen Credential-Kopien.
- Weitergabe von Git-Zugangsdaten oder Veraenderung der Host/VM-Sicherheitsgrenze.

## 5. Bestehende Integrationspunkte

Die Zeilenangaben beschreiben den untersuchten Stand und koennen sich verschieben; die Funktionsnamen sind massgeblich.

- `auth_collect_freshest_oauth`, ab etwa Zeile 4830: aktueller globaler Vergleich nach `expires`, einschliesslich gespeicherter und laufender VM-Kopien.
- `auth_cmd`, ab etwa Zeile 4944: vorhandene Befehle `auth status` und `auth resync`.
- `provider_cmd`, ab etwa Zeile 4970: Endpunkt-Einrichtung, Modell-Refresh, breite Provider-Entfernung und bisherige reine Host-Credential-Liste.
- `_cfg_merge` und `sync_cfg_between_host_and_project`, ab etwa Zeile 752: rekursive Vereinigung und Mtime-basierte Konfliktauswahl; Loeschungen koennen zurueckkehren.
- `enter_session_shell`, ab etwa Zeile 9793: passende XDG-Umgebung, bisher eigene Rueckkopie nach Shell-Rueckkehr.
- `attach_session`, ab etwa Zeile 9853: bislang Auth-Ueberschreibung vor dem spaeteren Stoppen des alten Web-Runtimes; anderer Host-Abschluss als beim frischen Start.
- `_destroy_prev_session`, ab etwa Zeile 10474: bisher Verarbeitung des Shares vor dem Stoppen und Loeschen der alten VM.
- `start_session`, ab etwa Zeile 10793: History-Vorbereitung, globale Auth-Startkopie, Share-Neuerstellung, VM-Start und Host-Cleanup.
- Host-Cleanup ab etwa Zeile 11303: vollstaendige Auth-Rueckkopie anhand des Datei-Alters.
- VM-Start und Exit-Sync ab etwa Zeile 11651: lokale Datenablage, globale rsync-Rueckkopie und unterdrueckte Fehler.
- `cleanup_sessions`, ab etwa Zeile 5639: gemeinsame destruktive Bereinigung fuer unter anderem `prune` und `init`, einschliesslich verwaister VMs.
- `doctor_cmd`, CLI-Hilfe, `README.md` und `AGENTS.md`: bestehende Dokumentation und Diagnoseaussagen aktualisieren.

Bereits vorhandene Web-Authentifizierung, Laufzeiterkennung und sichere VM-Aufrufe wiederverwenden, ohne Provider-Verwaltung an eine aktivierte OpenLive-Erweiterung zu binden.

## 6. Zustandsmodell

### 6.1 Rollen der Daten

Der globale Host-Auth-Stand bleibt der uebernommene gemeinsame Stand fuer neue Sessions. Die Live-Datei in der VM ist deren Arbeitskopie. Eine synchron angelegte Ruecklieferung ist zunaechst ein gesicherter Kandidat, nicht automatisch ein global ausgewaehlter Stand.

Es gibt keine periodischen Checkpoints. Gesicherte Kandidaten entstehen ausschliesslich durch explizite Aktionen, abgefangene Abschluesse oder Wiederherstellung an einem Lifecycle-Punkt.

### 6.2 Host-eigene Metadaten

Minimal benoetigt werden:

- Eine eigene Schemaversion fuer die Verwaltungsdaten.
- Projektidentitaet und Session-/Laufzeitgeneration; eine Wiederaufnahme mit neuem kontrolliertem Lauf erhaelt eine neue Generation.
- Pro Provider der strukturell verglichene Ausgangsstand oder sein kanonischer Fingerabdruck, einschliesslich ausdruecklicher Abwesenheit.
- Pro Provider die zu diesem Ausgangsstand gehoerende Host-Revision.
- Ein Uebernahmebeleg fuer bereits verarbeitete Ruecklieferungen.
- Eine hostseitig geordnete Abschlusskennung fuer einen kontrolliert beendeten Lauf.
- Revisionierte Loesch- und Typwechselvermerke gemaess bestaetigter Schutzregel.
- Geschuetzte gesicherte Kandidaten fuer fehlgeschlagene oder nicht automatisch aufloesbare Rueckfuehrungen.

Moegliche Ablage: globale Verwaltungsdaten unter `~/.opencode-vm/auth-sync/`, laufbezogene Daten unter `~/.opencode-vm/project-state/<hash>/auth-sync/`. Die genaue Dateiaufteilung ist ein Implementierungsdetail; keinen allgemeinen Journal- oder Datenbankdienst bauen.

Die Ausgangs- und Uebernahmemetadaten sind hostseitig gefuehrt, nicht aus einer von der VM beliebig veraenderbaren Statusdatei als Autoritaet zu uebernehmen. Rueckgelieferte Daten werden validiert. Sie werden niemals als Shell-Code geladen.

### 6.3 Unteilbare Eintraege

Bei OAuth bilden `access`, `refresh`, `expires`, optionale Konto-/Enterprise-Angaben und weitere unterstuetzte Felder einen vollstaendigen Provider-Eintrag. Keine feldweise Kombination verschiedener Anmeldungen.

Vergleiche beruhen auf strukturellem JSON, nicht auf Einrueckung, Schluesselreihenfolge oder Mtime. Geheime Werte beziehungsweise ihre Fingerabdruecke erscheinen nicht in regulaeren Ausgaben.

Zusaetzliche nicht interpretierte Felder bleiben beim Uebernehmen des vollstaendigen Eintrags erhalten. Unbekannte oder strukturell unpassende Typen werden nicht als geloeschter Provider behandelt. Bei nicht sicher unterstuetztem Format bleiben Quelle und Kandidat erhalten; automatische Mutation wird begrenzt beziehungsweise abgelehnt.

## 7. Zusammenfuehrungsregeln

### 7.1 Drei-Wege-Vergleich

Fuer jeden Provider werden Ausgangsstand `B`, aktueller Host-Stand `H` und VM-Ruecklieferung `V` betrachtet. Abwesenheit ist ein eigener Zustand. Die folgenden Regeln gelten nach der Formatpruefung sowie der Pruefung von Generation, Wiederholung und Schutzvermerken.

1. `V == B`: Keine beobachtbare VM-Aenderung. `H` bleibt bestehen.
2. `H == V`: Kein erneutes Schreiben erforderlich. Eine Bestaetigung erfolgt nur mit passender Herkunft/Revision, nicht durch blindes Hochsetzen des VM-Ausgangsstands.
3. `H` ist noch dieselbe Revision wie `B`: Nur die VM hat geaendert. `V` kann uebernommen werden, einschliesslich einer gueltig erfassten Entfernung.
4. Beide Seiten sind unterschiedlich geaendert: Konfliktregel nach Datentyp und Schutzvermerken anwenden.

Ein Konflikt fuer einen Provider blockiert nicht die sichere Uebernahme eines anderen Providers. Ein scheiternder atomarer Dateischreibvorgang ist dagegen ein Fehler der gesamten betreffenden Publikation und darf nicht als Erfolg bestaetigt werden.

### 7.2 Konkurrierende OAuth-Aenderungen

Bei zwei geaenderten OAuth-Eintraegen ohne vorrangigen Schutzvermerk gewinnt der spaeter kontrolliert abgeschlossene Lauf. Das gilt nicht fuer unveraenderte oder bereits uebernommene Ruecklieferungen.

Der Abschluss wird hostseitig nach Beendigung der relevanten Schreiber und Aufnahme eines gueltigen Endstands registriert. Die Host-Registrierungsreihenfolge definiert die total geordnete Abschlussreihenfolge; keine verteilten VM-Uhrzeiten vergleichen.

Ein Wiederholungsversuch nach einem Fehler behaelt seine urspruengliche Abschlusskennung. Er darf sich nicht durch spaeteres erneutes Ausfuehren vor einen inzwischen abgeschlossenen anderen Lauf setzen. Eine nachtraeglich gefundene Crash-Kopie erhaelt nicht automatisch die Prioritaet eines heute sauber beendeten Laufs.

`expires`, Kontoangaben und gegebenenfalls Token-Metadaten dienen hoechstens der Diagnose. Sie begruenden keine abweichende automatische Rangfolge. Unterschiedliche Kontoangaben duerfen nicht durch einen Feld-Merge vermischt werden; eine nach der festgelegten OAuth-Regel erfolgende Ersetzung ist als Kontoaenderung kenntlich zu machen, ohne Tokens auszugeben.

### 7.3 Abmeldung, Typwechsel und erneuter Login

Nach Bestaetigung der Schutzregel wird eine global uebernommene Entfernung mit Revision gespeichert. Aeltere laufende Generationen koennen diese Entfernung nicht durch ein altes oder erneuertes OAuth-Objekt aufheben.

Entsprechendes gilt fuer einen erfassten Wechsel weg von OAuth. Ein explizit neuer Login darf wieder eine neue Autorisierung begruenden. Bei zwei neu konkurrierenden OAuth-Anmeldungen bleibt die Abschlussregel bestehen.

Eine gueltige vollstaendige Auth-Datei ohne Eintrag kann eine Entfernung liefern. Eine fehlende Datei, ein fehlgeschlagener VM-Zugriff oder ungueltiges JSON ist kein Loeschsignal.

Snapshots koennen nicht alle zwischenzeitlichen Aktionen rekonstruieren. Insbesondere sind ein unbeobachteter Logout mit anschliessendem Login und ein vollstaendiger Wechsel zurueck auf identische Daten nicht stets erkennbar. Keine lueckenlose Absichtserkennung behaupten.

### 7.4 Bestaetigung und Wiederholung

Nach erfolgreicher Uebernahme wird der bestaetigte Ausgangsstand der betreffenden VM fuer diesen Provider fortgeschrieben. Nicht auf einen anderen Host-Stand fortschreiben, den die VM nie besessen oder uebernommen hat.

Beispiel: VM liefert `A1`, Host uebernimmt `A1`, anderer Lauf fuehrt Host auf `A2` weiter. Die erneute Lieferung desselben bereits bestaetigten `A1` ist ein No-op, kein spaeterer Gewinner.

Loeschvermerke und Herkunftsdaten muessen auch den Fall unterscheiden, dass ein Provider seit dem Ausgangsstand auf dem Host hinzugefuegt und wieder entfernt wurde. Gleiche Abwesenheit allein beweist keine unveraenderte Revision.

## 8. Synchroner Rueckfuehrungsweg

### 8.1 Gemeinsame Operation

Eine kleine gemeinsame Implementierung uebernimmt Erfassung, Pruefung, dauerhafte Kandidatensicherung, Zusammenfuehrung und Bestaetigung. Die bestehenden Aufrufer verwenden diese Operation, statt jeweils eigene Auth-Kopierregeln zu behalten.

Fuer einen kontrollierten Abschluss gilt:

1. Projekt und aktive Generation pruefen; alten und aktuellen Controller unterscheiden.
2. Relevante verwaltete OpenCode-Schreiber geordnet beenden und ihr Ende abwarten. Nicht pauschal fremde Prozesse beenden.
3. Auth-Datei als zusammenhaengenden Kandidaten lesen und validieren.
4. Kandidaten ausserhalb der zu loeschenden Session-Ablage sichern.
5. Unter hostseitiger Serialisierung die Abschlusskennung registrieren, den neuesten Host-Stand lesen und den Provider-Merge durchfuehren.
6. Ergebnis und Uebernahmebeleg dauerhaft schreiben oder den Kandidaten als nicht uebernommen erhalten.
7. Nur nach nachweisbarer Erhaltung der benoetigten Daten mit Stoppen/Loeschen und Share-Bereinigung fortfahren.

Ist eine konfliktfreie globale Uebernahme nicht moeglich, kann ein dauerhaft erhaltener, klar gemeldeter Kandidat die Wiederherstellbarkeit sichern. Ein nicht gelesener oder nicht gesicherter letzter Live-Stand ist dagegen kein erfolgreicher Abschluss.

### 8.2 Schreiben und Fehlerbehandlung

- Host-Schreibvorgaenge der Provider-/Auth-Verwaltung durch eine gemeinsame, kurz gehaltene Sperre serialisieren; macOS-kompatibel implementieren.
- Keine Sperre waehrend Browser-Login oder langen VM-Netzwerkoperationen halten. Beim eigentlichen Commit den Host-Stand erneut lesen.
- Temporaere Dateien im Zielverzeichnis erstellen, restriktive Rechte setzen, pruefen und durch Rename ersetzen.
- Atomare Sichtbarkeit nicht mit einer Garantie gegen Host-Stromausfall gleichsetzen.
- Bereits abgeschlossene Uebernahmen auch bei Abbruch zwischen Auth-Schreiben und Metadaten-Schreiben erkennen. Einen minimalen vorbereiteten Uebernahmebeleg mit Vorher-/Nachher-Zuordnung oder gleichwertige getestete Wiederanlaufbehandlung vorsehen.
- Bei unerklaerlichem Zustand nach Wiederanlauf keine alte Transaktion blind ueber neuere Daten schreiben. Kandidaten erhalten und Konflikt melden.
- Auch vorhandene repo-eigene Auth-Schreiber, etwa Provider-Einrichtung und OpenLive-Markerpflege, bei Bedarf in die Serialisierung einbeziehen. OpenLive-Funktionalitaet nicht umbauen.
- Direkt laufendes Host-OpenCode respektiert unsere Sperre nicht automatisch. Beobachtete externe Aenderungen erkennen; keine transaktionssichere Koordination nicht kooperierender Schreiber versprechen.
- Keine Ausgabe von Tokens in Prozessargumenten, Debug-Ausgaben oder Fehlermeldungen; Daten ueber geschuetzte Dateien beziehungsweise Standardinput uebergeben.

## 9. Lifecycle-Integration

### 9.1 Frischer Start

Vorhandene gesicherte Ruecklieferungen und Metadaten pruefen, bevor Projektcache oder Session-Share geloescht werden. Auth nicht von `--keep-history` abhaengig machen.

Den uebernommenen Host-Stand als Startgrundlage verwenden. Den Ausgangsstand exakt zu den tatsaechlich eingespielten Credentials erfassen, nicht zu einer vorher gelesenen abweichenden Kopie. Erst danach den Lauf starten.

Die automatische Auswahl nach hoechstem `expires` entfaellt als Autoritaet. Keine zusaetzlichen Hintergrundvorgaenge starten.

### 9.2 Attach und Wiederaufnahme

Bei laufendem alten Runtime zuerst dessen Zustand kontrolliert abschliessen beziehungsweise sichern, bevor Host-Auth in die VM geschrieben wird. Die heutige Reihenfolge mit Ueberschreiben vor dem Stoppen aendern.

Reines Verbinden eines weiteren Clients zu einer unveraenderten Laufzeit ist kein Session-Abschluss. Ein tatsaechlich ersetzter verwalteter Lauf wird dagegen einmalig abgeschlossen und der neue Lauf erhaelt einen passenden Ausgangsstand.

Bei gestoppter VM die bereits erhaltenen Daten vor dem Wiederanlauf beruecksichtigen. Nicht annehmen, dass ein Neustart eine einzigartige Datei aus `/tmp` zuverlaessig rettet.

Start, Attach und Wiederaufnahme muessen dieselbe Host-Rueckfuehrung verwenden. Ihre Korrektheit darf nicht von einem noch existierenden urspruenglichen Start-Terminal abhaengen.

### 9.3 Shell und zusaetzliche Clients

Die Shell verwendet weiterhin dieselben XDG-Pfade und denselben VM-Benutzer. Eine zusaetzliche Shell darf nicht stillschweigend eine zweite globale Auth-Instanz erzeugen.

Das Ende einer zusaetzlichen Shell ist nicht automatisch das Ende des gesamten parallel laufenden OpenCode-Runtimes. Eine dort synchron gesicherte Kopie darf daher keine neue Abschlussprioritaet erhalten. Ein allein durch den Shell-Modus gefuehrter, tatsaechlich beendeter Lauf nutzt den gemeinsamen Abschlussweg.

Insbesondere den vorhandenen Umgang mit gestoppten getrackten VMs pruefen: nicht Tracker oder Share verwerfen, bevor Auth-Wiederherstellung und Generation geklaert sind.

### 9.4 Normales Beenden und destruktive Befehle

Den gemeinsamen Abschluss in normales Keep/Delete, `_destroy_prev_session`, `cleanup_sessions`, `prune` und den ueber `init` beziehungsweise Rebuild ausgeloesten Abbau integrieren.

Ein alter Cleanup-Aufruf darf weder Daten noch Tracker eines neueren Laufs entfernen. Vor jeder destruktiven Aktion die Generation erneut pruefen.

Bei verwaisten oder nicht eindeutig zuordenbaren VMs nicht behaupten, deren Auth-Zustand sei erfolgreich gesichert. Sichere Zuordnung beziehungsweise Erhaltung versuchen; andernfalls automatische destruktive Bereinigung fuer diesen Fall abbrechen und die Unsicherheit melden.

### 9.5 Harte Fehler

Kein Recovery-Daemon und keine neue periodische Sicherung. Bei `SIGKILL`, VM-Absturz oder Verlust noch nicht zurueckgefuehrter Daten bleibt nur der letzte tatsaechlich gespeicherte Stand.

Wenn die VM nach einem Terminalabbruch noch erreichbar ist, kann bei der naechsten expliziten Aktion ein vorhandener Live-Stand synchron gesichert werden. Das ist eine Gelegenheit zur Rettung, keine Garantie.

Eine beim Absturz verlorene Token-Rotation kann einen erneuten Login erfordern. Das ist kein Grund, kuenftig heimlich wieder Hintergrundlogik einzufuehren.

## 10. Provider-Adapter und Anzeige

### 10.1 Geplante Oberflaeche

```text
opencode-vm provider list
opencode-vm provider login [provider]
opencode-vm provider logout [provider]
```

Die konkreten optionalen Argumente an das bestehende CLI-Muster anpassen. Keine umfangreiche neue Profil- oder Session-Auswahlsprache einfuehren.

`provider add/new/refresh/rm` bleiben fuer ihre bereits ausgelieferten Aufgaben erreichbar. `refresh` bedeutet Modelllistenaktualisierung, nicht OAuth-Erneuerung. `rm` ist nicht mit Logout gleichzusetzen und darf nicht als dessen Implementierung wiederverwendet werden.

Nachtrag (Umsetzung, Oberflaeche revidiert): Der CLI-OAuth-Login (headless/device im Web-Modus, CLI-Fallback in der Shell-VM) wurde bewusst zurueckgenommen. `provider` gliedert sich jetzt in zwei Klassen: **Custom Endpoints** (`provider custom new|add|sync|rm`; hostseitig, keine Session) und **Subscriptions** (`provider subscription new` gibt die WebUI-Schritte aus, `provider subscription rm <id>` entfernt das gespeicherte OAuth-Credential hostseitig und setzt einen Logout-Tombstone). `provider new` fragt zuerst die Klasse. `provider refresh` heisst jetzt `provider custom sync` (Modellliste, kein Token-Refresh; OAuth-Tokens erneuert OpenCode automatisch). Alte flache Befehle wurden ohne Aliase entfernt. `provider list` gruppiert nach Klasse; Live-Verfuegbarkeit (`RUNTIME`) nur mit erreichbarem Web-Server, sonst benigne `unknown`.

`auth status` und `auth resync` nicht kommentarlos entfernen. Auf die neue Diagnose beziehungsweise kontrollierte Rueckfuehrung umstellen und geaenderte Semantik dokumentieren. `resync` darf keine laufende oder historische Kopie allein wegen eines groesseren Ablaufdatums als neuesten Abschluss ausgeben. Nicht abgeschlossene oder baseline-lose Kandidaten nur mit ausdruecklicher Auswahl uebernehmen; nicht interaktiv unbegruendet raten.

### 10.2 Laufzeitanbindung

- Fuer Web-Sessions denselben OpenCode-Server und Projektkontext wie die WebUI verwenden.
- Effektiven internen Endpunkt feststellen; keine fest angenommene Portnummer und keine Abhaengigkeit von einem aktivierten OpenLive-Adapter.
- Vorhandene Server-Authentifizierung respektieren. Keine neuen anonymen Auth-Endpunkte oder Firewall-Freigaben.
- Version und benoetigte Schnittstellen pruefen. Bei nicht unterstuetztem Protokoll gezielt abbrechen, statt gegen ein anderes Datenmodell zu schreiben.
- Keine neue Laufzeit starten, nur weil ein Auth-Befehl keine Verbindung bekommt.

Nachtrag (Umsetzung): Keine exakte OpenCode-Version festschreiben. OpenCode liefert laufend Patch-Releases (Semver; Bruchstellen sind bei Major-/Minor-Spruengen zu erwarten, z. B. Quellbaum-Umbau in 2.0). Die Kompatibilitaet wird zur Laufzeit ueber die tatsaechlich genutzten Schnittstellen (Health/Version, Projektkontext, Provider- und Auth-Methoden-Schema) geprueft; eine nicht unterstuetzte Schnittstelle bricht gezielt ab und nennt die erkannte Version. Kann die gespeicherte Auth-Datei nicht mehr drei-Wege-zusammengefuehrt werden (unbekanntes Eintragsformat nach einem OpenCode-Update), wird der neueste Laufzeitstand als Gesamtkopie veroeffentlicht und ausdruecklich gewarnt, dass Merge beziehungsweise OpenCode-Kompatibilitaet anzupassen sind.

### 10.3 Gepruefter V1-Ablauf

Die Untersuchung von OpenCode `1.18.29` ergab folgende nutzbare Schnittstellen:

- `GET /provider` fuer Provider und laufzeitseitige Verfuegbarkeit.
- `GET /provider/auth` fuer die angebotenen Auth-Methoden.
- `POST /provider/{id}/oauth/authorize` und `/callback` fuer OAuth.
- `PUT /auth/{id}` fuer unterstuetzte direkte Credential-Eintraege.
- `DELETE /auth/{id}` fuer das Entfernen gespeicherter Zugangsdaten.
- Gezielte Instanz-Neuladung entsprechend dem unterstuetzten WebUI-Ablauf nach einer Auth-Aenderung.

Authorize und Callback muessen denselben Server und Projektkontext erreichen. Dazwischen keine Instanz verwerfen. Methoden dynamisch ermitteln, keine festen numerischen Indizes fuer OpenAI annehmen.

Fuer OpenAI die angebotene Headless-/Geraetecode-Methode bevorzugen. Nutzer bestaetigt im Host-Browser; der OAuth-Ablauf bleibt VM-seitig. Keine eigene Token-Endpoint-Implementierung. Browser-Callback-Verfahren anderer Provider nur unterstuetzen, wenn deren Transport sauber verifiziert ist; sonst den vorhandenen OpenCode-Weg klar benennen.

Gleichzeitige Login-Versuche fuer denselben Provider nicht unkontrolliert starten. Einen Client-Timeout nicht als Nachweis werten, dass die serverseitige OAuth-Aktion abgebrochen wurde. Vor erneutem Versuch Ergebniszustand pruefen; keine automatischen Login-Schleifen.

### 10.4 Terminal-Fallback

CLI-Aufrufe nur innerhalb der passenden VM, mit identischem Benutzer, Arbeitsverzeichnis und XDG-Kontext. In der untersuchten Version ist beispielsweise `opencode auth login --provider openai` moeglich; die aktuelle Syntax bei Umsetzung erneut pruefen.

Ein zweiter CLI-Prozess neben einem laufenden Server ist kein unsichtbar gleichwertiger Ersatz fuer die Server-API. Schreibkonkurrenz und erforderliche Neuladung beruecksichtigen. Falls ein sicherer Ablauf im reinen TUI-Modus nicht moeglich ist, vorhandenes `/connect` beziehungsweise einen ruhenden VM-Zustand verwenden, statt eine zusaetzliche Serverarchitektur zu bauen.

### 10.5 Darstellung und Erfolgspruefung

Die Liste soll konfigurationsbasierte und credentialbasierte Provider gemeinsam darstellen, inklusive konfigurationsbasierter lokaler Endpunkte ohne eigenen Auth-Eintrag. Bekannte interne Marker bleiben ausgeblendet.

Mindestens unterscheiden: Provider-ID/Name, Anmeldeart, live oder gespeichert, Zugangsdaten vorhanden und laufzeitseitig verfuegbar. Ein ausgewaehltes Modell ist kein eigener Auth-Status.

Keine ungefilterten API-Antworten ausgeben; sie koennen Schluessel oder sensible Optionen enthalten. Fuer Anmeldeart oder Speichermetadaten gegebenenfalls eine gezielte, geheimnisfreie Projektion innerhalb der VM verwenden, da V1 keine allgemeine Auth-Export-GET-Schnittstelle liefert.

Nach Login/Logout Schreib-/Callback-Ergebnis und den danach beobachtbaren Zustand pruefen. Erfolgreiche Speicherung nicht als erfolgreiche Modellanfrage oder gueltiges Abo ausgeben. Logout entfernt lokale Credentials; keine unbelegte providerseitige Token-Widerrufsgarantie. Environment-/Konfigurationszugang kann einen Provider trotz entferntem Dateieintrag weiterhin verfuegbar machen.

## 11. Provider-Konfiguration und Migration

### 11.1 Provider-Konfiguration

Neue eigene Endpunkte benoetigen sowohl Credentials als auch die zugehoerige Provider-Definition. Diese Aenderungen gezielt unter `.provider` verarbeiten; nicht das gesamte bestehende Konfigurationssystem neu schreiben.

Die heutige reine Vereinigungslogik darf eine erfasste Provider-Entfernung nicht wiederherstellen. Gleichzeitig duerfen sitzungsspezifische VM-Umschreibungen von Host-Adressen oder Laufzeitoptionen nicht ungeprueft als dauerhafte Host-Einstellungen gespeichert werden. Vorhandene Normalisierung wiederverwenden.

`provider add` darf OAuth nicht unbeabsichtigt durch einen API-Key ersetzen. Einen erkannten Typwechsel ausdruecklich machen und in der Verwaltung erfassen. Vorhandene `--dry-run`-Pfade muessen ohne Auth-/Konfigurationsmutation bleiben.

### 11.2 Bestehende Installationen

- Host, Projektcache, Session-Share und vorhandene History-Kopien zuerst inventarisieren, ohne Credential-Inhalte auszugeben.
- Neue baseline-gefuehrte Laeufe erst nach kontrollierter Initialisierung der Verwaltungsdaten starten.
- Fuer bereits laufende Alt-Sessions fehlt ein verlaesslicher Ausgangsstand. Nicht den aktuellen Host-Stand rueckwirkend als deren Startzustand erfinden.
- Alte Kandidaten sicher erhalten und Unterschiede anzeigen. Uebernahme ohne Herkunft nur ausdruecklich bestaetigt; keine neue automatische `expires`-Heuristik als Migrationsersatz.

Nachtrag (Umsetzung): Fuer baseline-lose Alt-Sessions fragt `attach` interaktiv (nur TTY) mit geheimnisfreiem Provider-Vergleich: Session (Union, Session gewinnt pro Provider, host-only bleibt) oder Host. Identische Staende laufen ohne Frage weiter; nicht-interaktive Aufrufe brechen ab. Nach der Wahl ist die neue Generation baseline-verwaltet. Zusaetzlich entfernt `attach` die doppelte Kandidaten-Meldung, indem der Kandidat nur einmal gesichert wird.
- Auth kuenftig aus allgemeinen History-Seed-/rsync-Autoritaeten herausnehmen, damit eine alte Unterhaltung keine neuere Anmeldung zuruecksetzt.
- Alte History-Dateien nicht ungefragt massenhaft umschreiben oder loeschen. Sie werden lediglich nicht mehr automatisch als aktuelle Autoritaet verwendet.
- `OCVM_AUTH_AUTORESYNC` und dokumentierte bestehende Befehle auf konkrete Kompatibilitaetsanforderungen pruefen. Geaenderte Bedeutung klar beschreiben; keine zweite alte Konfliktlogik parallel aktiv lassen.

## 12. Arbeitspakete

### AP 0: Vertrag und Fixtures

- [ ] Schutzregel fuer Logout/Typwechsel und die Defaults aus Abschnitt 3 bestaetigen.
- [ ] Aktuelle OpenCode-Version, Protokoll, Auth-Schema, CLI und notwendige Neuladung erneut pruefen.
- [ ] Alle Auth-Schreib- und Zerstoerungspfade anhand der aktuellen Datei erfassen, inklusive Markerpflege und Rebuild.
- [ ] Kleine synthetische Ausgangs-, Host- und VM-Fixtures fuer OAuth, API, Abwesenheit und unbekannte Daten erstellen.

Abnahme: Der Verhaltensvertrag ist testbar; es gibt keine implizite Wiedereinfuehrung einer Hintergrundsicherung oder unbekannte automatische Konfliktregel.

### AP 1: Merge und Verwaltungsdaten

- [ ] Kanonische Provider-Vergleiche und Drei-Wege-Regeln implementieren.
- [ ] Ausgangsstaende, Revisionen, Generationen und Uebernahmebelege speichern.
- [ ] Abschlussreihenfolge, Idempotenz und bestaetigte Schutzvermerke umsetzen.
- [ ] Geschuetzte Kandidatenspeicherung, atomare Publikation und kurze Host-Serialisierung implementieren.
- [ ] Wiederanlauf bei teilweise abgeschlossener Publikation testen.

Abnahme: Die Merge-Tests laufen mit isoliertem HOME ohne Lima, echte Provider oder persoenliche Credentials.

### AP 2: Lifecycle-Rueckfuehrung

- [ ] Gemeinsamen synchronen Erfassungs-/Abschlussweg integrieren.
- [ ] Start, Attach und Shell auf denselben Ausgangs- und Uebernahmestand bringen.
- [ ] Alte Mtime-Komplettkopien und automatische Hoechst-`expires`-Auswahl fuer Auth ersetzen.
- [ ] Endstand vor Ueberschreiben, Cache-Leeren oder Share-Neuerstellung sichern.
- [ ] `--fresh`, Keep/Delete, `prune`, `init` und Rebuild gegen Sicherungsfehler und alte Controller absichern.
- [ ] Historienkopien duerfen Auth nicht am neuen Weg vorbei ueberschreiben.

Abnahme: Kontrollierte Beendigung verliert keine beobachtbaren Auth-Aenderungen; Fehler verhindern unbeabsichtigte Datenvernichtung; harte Abbrueche behalten die vereinbarte Verlustgrenze.

### AP 3: Provider-Bedienung

- [ ] Live-/gespeicherte Provider-Liste mit sicheren Ausgabefeldern erstellen.
- [ ] VM-Zielaufloesung und geschuetzte API-Anbindung umsetzen.
- [ ] OpenAI-OAuth-Login und Logout einschliesslich Statuspruefung/Neuladung integrieren.
- [ ] Unterstuetzte CLI-/TUI-Wege und Nichtverfuegbarkeitsmeldungen definieren.
- [ ] `auth status/resync` auf neue Daten und Regeln umstellen.
- [ ] Endpunkt-Einrichtung, Typwechsel und Provider-Entfernung mit dem neuen Datenvertrag verbinden.

Abnahme: Host-Befehl und WebUI verwenden dieselbe VM-Authentifizierung; es entsteht keine Host-Ersatzanmeldung und kein Hintergrunddienst.

### AP 4: Migration und Dokumentation

- [ ] Legacy-Daten ohne erfundene Baseline behandeln und Wiederherstellung dokumentieren.
- [ ] CLI-Hilfe, README und relevante AGENTS-Architekturbeschreibung aktualisieren.
- [ ] `prune && start` als normale Auth-Reparaturempfehlung entfernen.
- [ ] Bedeutung von Ablaufzeit, Live-Verfuegbarkeit, Logout und akzeptiertem Crash-Verlust erklaeren.
- [ ] Bei spaeterer Aenderung von `opencode-vm.sh` die Patch-Version vom dann aktuellen Stand erhoehen; fuer diese Plan-Datei allein kein Versionsbump.

Abnahme: Dokumentation beschreibt nur nachgewiesenes Verhalten und trennt Anmelden, Endpunkt-Einrichten und globale Uebernahme.

### AP 5: Gesamtvalidierung

- [ ] Automatisierte Tests und ShellCheck ausfuehren.
- [ ] macOS/Lima-Lifecycle mit synthetischen Auth-Daten testen.
- [ ] Reale Provider-Anmeldung nur nach ausdruecklicher Freigabe manuell abnehmen.
- [ ] Verbleibende Grenzen und nicht ausfuehrbare Tests im Abschlussbericht nennen.

## 13. Testplan

### 13.1 Testorganisation

Ein fokussiertes `tests/provider_test.sh` kann dem vorhandenen Muster mit isoliertem `HOME`, `OCVM_INTERNAL_SOURCE_ONLY=1`, ausgeschaltetem Update-Check und gemocktem `limactl` folgen. Zusaetzliche Testdateien nur bei einem tatsaechlich getrennten Bedarf.

Produktionsfunktionen testen, nicht eine separate Test-Nachimplementierung der Merge-Regeln. Fuer HTTP-Verhalten synthetische Antworten oder einen lokalen Testserver verwenden; keine echten Tokens oder automatisch kostenpflichtigen Modellaufrufe.

### 13.2 Merge-Abnahme

- [ ] Neuer Provider nur in VM wird ergaenzt; neue Host-Provider bleiben erhalten.
- [ ] Aenderungen verschiedener Provider aus zwei Sessions werden kombiniert.
- [ ] Unveraenderte alte VM-Kopie ueberschreibt weder erneuerten Token noch neuen API-Key.
- [ ] Nur VM geaendert: vollstaendiger Eintrag wird uebernommen.
- [ ] Identisches Ergebnis ist ein No-op; JSON-Reihenfolge und Formatierung sind irrelevant.
- [ ] Zwei geaenderte OAuth-Eintraege: spaeterer kontrollierter Abschluss gewinnt, auch bei kleinerem `expires` oder irrefuehrender Mtime.
- [ ] Ein wiederholter beziehungsweise verspaetet erneut angewandter Abschluss wird nicht zum neuen Gewinner.
- [ ] Erfolgreiche Uebernahme schreibt nur den tatsaechlich bestaetigten VM-Ausgangsstand fort.
- [ ] Kein Mischen von Access-/Refresh-Token oder Kontoangaben verschiedener Eintraege.
- [ ] Bestaetigter Logout und Typwechsel werden nicht durch aeltere Generationen aufgehoben.
- [ ] Add/Delete-Zyklus auf dem Host wird trotz erneut gleicher Abwesenheit erkannt.
- [ ] Explizit neue Anmeldung kann einen Schutzvermerk nach definierter Regel aufheben.
- [ ] Fehlende, abgeschnittene und ungueltige Dateien loeschen nichts; gueltiges leeres Objekt wird getrennt behandelt.
- [ ] Unbekannte Auth-Typen/Felder gehen nicht stillschweigend verloren.
- [ ] Konflikt bei einem Provider verhindert nicht die sichere Verarbeitung anderer Provider.
- [ ] Schreibfehler und Abbruch zwischen Auth- und Metadaten-Commit erzeugen keine falsche Erfolgsbestaetigung.

### 13.3 Lifecycle-Abnahme

- [ ] WebUI-/CLI-Aenderung wird bei normalem Ende auf den Host zurueckgefuehrt.
- [ ] Attach sichert den alten Live-Stand vor einer Ersetzung und benoetigt keinen alten Start-Controller.
- [ ] Reines Client-Attach oder Ende einer zusaetzlichen Shell erzeugt keinen falschen Session-Abschluss.
- [ ] Keep/Resume erhaelt Auth unabhaengig von frischer Chat-Historie.
- [ ] `--fresh` und Share-Neuerstellung erfolgen erst nach erfolgreicher Sicherung oder Erhaltung eines Wiederherstellungskandidaten.
- [ ] `prune`, `init` und Rebuild loeschen nicht trotz fehlgeschlagener kontrollierter Rueckfuehrung.
- [ ] Alter Cleanup kann neueren Tracker, Share und Auth-Stand nicht entfernen.
- [ ] Allgemeiner rsync ueberschreibt keine zuvor gepruefte Auth-Ruecklieferung.
- [ ] Harte Beendigung zeigt ausschliesslich den letzten vorhandenen Stand; keine Behauptung vollstaendiger Rettung.
- [ ] Es werden keine Timer, Watcher, Polling-Prozesse oder Auth-Daemons angelegt.

### 13.4 Adapter-Abnahme

- [ ] Liste enthaelt OAuth, API und konfigurierte lokale Endpunkte und blendet interne Marker aus.
- [ ] Live-/gespeicherte Quelle sowie vorhanden/verfuegbar sind unterscheidbar.
- [ ] Keine Token-, Passwort- oder unbereinigte Provider-Ausgabe.
- [ ] Falsche, fehlende, gestoppte und nicht erreichbare Zielumgebung erzeugt keinen Host-Fallback oder versteckten VM-Start.
- [ ] Vorhandene Basic-Authentifizierung und effektive Ports werden respektiert.
- [ ] OAuth-Methoden werden dynamisch ausgewaehlt; Authorize/Callback bleiben im gleichen Kontext.
- [ ] Abgebrochener Login, Callback-Fehler und Timeout erzeugen keine automatische Logout/Login-Schleife.
- [ ] Erforderliche Neuladung unterbricht keine Arbeit unangekuendigt.
- [ ] Logout ist nicht `provider rm` und entfernt keine Favoriten oder Chat-Modellreferenzen.
- [ ] Ein gespeicherter Zugang wird nicht als erfolgreich getestete Modellverbindung ausgegeben.
- [ ] Provider-Add warnt vor OAuth-Ersetzung; Dry-run bleibt ohne Mutation.

### 13.5 Auszufuehrende Pruefungen

Diese Befehle sind fuer die spaetere Implementierung vorgesehen und wurden bei der Planerstellung nicht als Produktvalidierung ausgefuehrt:

```bash
bash -n opencode-vm.sh
bash -n tests/provider_test.sh
shellcheck opencode-vm.sh tests/provider_test.sh
bash tests/provider_test.sh
bash tests/openlive_test.sh
bash tests/besprechung_test.sh
bash tests/vscode_trust_test.sh
python3 -m unittest discover -s tests -p '*_test.py'
git diff --check
```

ShellCheck auf neu eingefuehrte beziehungsweise beruehrte Probleme auswerten. Keine massenhaften fachfremden Korrekturen. Bestehende kritische Befunde getrennt berichten.

Manuelle macOS/Lima-Abnahme ist erforderlich fuer Benutzerrechte, virtiofs-Dateiersetzung, echte Beendigungsreihenfolge und Wiederaufnahme. Linux-Mocks allein belegen diese Eigenschaften nicht.

Ein realer Mehrprojekt-Refresh-Test ist eine zusaetzliche Beobachtung des akzeptierten Restrisikos, kein Nachweis einer unbegrenzten OpenAI-Sessionzahl. Nur freigegeben, mit kleinem Umfang und ohne Login-Stresstest ausfuehren.

## 14. Grenzen der Zusagen

OpenCode VM kennt die von ihm erfassten Daten und Uebernahmen, nicht die serverseitige Gueltigkeit jeder Autorisierung. Es kann aus `expires` oder einer Konto-ID keine verlaessliche Refresh-Token-Abstammung ableiten.

OpenAI erlaubt mehrere eigene Geraete. Eine belastbare oeffentliche Hoechstzahl unabhaengiger Codex-/OpenCode-OAuth-Anmeldungen oder eine feste Verdraengungsregel wurde nicht gefunden. Daraus folgt keine Garantie unbegrenzter Parallelitaet.

Die letzte abgeschlossene Session liefert nach Produktentscheidung den bevorzugten konkurrierenden OAuth-Stand. Dieser Stand kann dennoch abgelaufen, widerrufen oder durch eine andere VM serverseitig ueberholt sein. In diesem Fall bleibt eine nachvollziehbare erneute Anmeldung der vorgesehene Wiederherstellungsweg.

Ohne Hintergrundsicherung gibt es absichtlich keine Garantie fuer noch nicht zurueckgefuehrte Aenderungen bei harten Abbruechen. Die Implementierung darf dieses akzeptierte Risiko weder verschweigen noch als Anlass fuer zusaetzliche ungefragte Hintergrundarchitektur nehmen.

## 15. Definition of Done

- Alle verbindlichen Entscheidungen sind implementiert und die Arbeitsannahmen fuer die umgesetzten Teile bestaetigt.
- Auth-Rueckfuehrung hat einen gemeinsamen synchronen Ablauf; keine parallele alte Mtime-/Expiry-Gewinnerlogik bleibt aktiv.
- Die festgelegten Merge-, Abschluss-, Wiederholungs- und Schutzregeln sind automatisiert getestet.
- Vor kontrollierter Zerstoerung werden Daten gesichert; Fehler verhindern deren unbeabsichtigte Vernichtung.
- Provider-Liste sowie unterstuetzter Login/Logout arbeiten gegen die richtige VM und bleiben mit WebUI-Aenderungen vereinbar.
- Migration erhaelt bestehende Wiederherstellungsmoeglichkeiten; Auth ist von Chat-History-Autoritaet getrennt.
- Es existiert kein neuer Auth-Hintergrundprozess.
- Versionsbump, Dokumentation, gezielte Regressionstests und macOS/Lima-Abnahme sind abgeschlossen. Nicht ausgefuehrte Pflichtpruefungen bleiben ausdrueckliche Abnahmeblocker; betroffene Arbeitspakete gelten nicht als vollstaendig abgeschlossen.

## 16. Recherchequellen

- Repository: `opencode-vm.sh`, `README.md`, `AGENTS.md` und bestehende Tests unter `tests/`.
- OpenCode Auth-Schema und Speicherung: https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/auth/index.ts
- OpenCode CLI: https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/cli/cmd/providers.ts
- OpenCode Provider-API: https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts
- OpenCode OAuth-Abwicklung: https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/provider/auth.ts
- OpenCode OpenAI-Plugin: https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/openai/codex.ts
- WebUI-Kompatibilitaetsablauf: https://github.com/anomalyco/opencode/blob/v1.18.29/packages/app/src/utils/server-compat.ts
- OpenAI Mehrgeraetenutzung: https://help.openai.com/en/articles/10471989-openai-account-sharing-policy
- OpenAI Auth-Persistenz fuer den eigenen Codex-Client, nicht als OpenCode-Garantie: https://developers.openai.com/codex/auth/ci-cd-auth
- OpenAI-Kommentar zum zeitlich begrenzten Refresh-Wiederverwendungsfenster, keine dauerhafte Schnittstellengarantie: https://github.com/openai/codex/issues/10332#issuecomment-3831635259
