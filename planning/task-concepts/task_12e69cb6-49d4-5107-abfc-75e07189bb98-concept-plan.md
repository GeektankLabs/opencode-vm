Task-ID: task_12e69cb6-49d4-5107-abfc-75e07189bb98

# Emergency-Fix: Monitor-Löschung, Bindungen, Recovery

## Autorisierung und Basis

Neuester Operatorauftrag: direkt am kanonischen lokalen Main, exklusiver Mainwriter; Build `opencode/gpt-6.1-sol/high`, Session `ses_ec332f966ffewq39g36eFkeRN1`. Basis `01352a8814a2312acd5869c0aecabf35c0435df2`. Fremde Task-/Planänderungen, Skill-r58, ENFILE-/Doctor- und Gast-Worktree-Arbeit erhalten. Keine neuen Worktrees/Implementierer, kein Push/Release, keine BI-MC-Mutation, kein VM-Neuaufbau oder Liveupdate.

Vollständige sichtbare Berichte der alten Session gelesen. Kein vorheriger Patch/Commit vorhanden; geerbtes `edit:deny` blockierte vor Ausführung. Neue Session: keine Session-Permissions; tatsächlich geladener Build-Agent erlaubt Edits, reguläre `apply_patch`-Aufrufe erfolgreich. Historische Worktree-/Xiaomi-Anweisungen im Boardtext sind durch den aktuellen Auftrag ersetzt; keine externe Toolfreigabe als abschaltbaren Produktcode behandeln.

## Belegte Ursache und minimale Änderungen

- Hub `monitor.js:act`: globaler Generation-CAS im Delete-Request macht bereits einen fremden Observer-Write zu einem 409 vor Löschung. Regression reproduziert den alten Request, dann erfolgreichen ID-basierten Delete. Hub `server.py:mutate_action` und MCP `tools.ts:deleteMonitorHandler` entfernen bereits atomisch ausschließlich das Objekt. Fehlender historischer HTTP-Receipt bedeutet: keine Behauptung, eine bestätigte Löschung sei später wiederhergestellt worden. UI-Readback/Netzwerk-Catch und Kandidaten-Reload ergänzen; kein spekulativer Lock-Umbau.
- MCP `update_monitor`: getrennte Task-/Manager-Felder; Projekt-, Idle-/Pending-/Receipt-/WAL-Prüfung und lock-interne Uniqueness, gesamtes Update per CAS. Keine zweite Registry/Neuanlage, keine Boardstatusänderung.
- Engine: Operatorwake vor Investigation; reine Investigation quittiert keine Manager-Digests und löscht keinen konkurrierenden Trigger. Alte Worker-Clocks nur für aktuelle Dispatch-Episoden; Archiv/rezeptlose Rebinds feuern nicht. Receipt-Provenienz bleibt im Verlauf, Worker/Ergebnisse bleiben bestehen. Manager-Recreation ausschließlich nach bestätigtem `SESSION_NOT_FOUND`.

## Separate Managed-Worker-Permissions

Gezielte Boardreads abgeglichen: Vorgänger `task_25b3af4f-e97f-5707-b523-13bcc99ed03c` (done) mit Diagnose-/Konzeptnachtrag; offene Regression `task_ec21807a-dd52-55b4-a9da-24c113707e56` – „Autorisierte Worktree-Reads ohne interaktive Freigabe“ (todo). Dieser Monitorfix startet dafür keine Implementierung oder zweite Main-Schreibrunde. Neue Plan-/Build-Vererbungsbeobachtung und nichtinteraktive Policy sind dort seriell gegen echten Scope und unabhängige Securitypermissions abzugleichen. Kein blanket ask→allow, keine externe Freigabeumgehung.

## Validierung / unabhängige QC

- MCP: `npm run check`, `npm run build`; `node --test dist/monitor.test.js dist/http.test.js` prüft UI-unabhängigen MCP-Delete, persistente freie Taskbindung, Task-/Manager-CAS, Uniqueness, Busy/Pending/WAL, Missing-Manager, Trigger/Investigation und alte Worker-Clocks.
- Browser: `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test tests/hub_monitor_browser_test.mjs`; echte disposable Hub-HTTP-/Storefixture, Delete/Reload/Kandidaten, alter Generation-Request, Run-Konflikt, Netzwerk und falsches 200 ohne Persistenz.
- Lokale Pakete/Script: Adapter 0.1.55, Script 0.7.55, reproduzierbare MCP-/Hubarchive und aktualisierte Pins; keine Veröffentlichung. Shell-Syntax/Shellcheck und Metadatenprüfungen.
- Unabhängige QC erhält exakten Diff und Testergebnisse; liest nur, keine eigenen Korrekturen, Liveaufrufe oder konkurrierenden Mainwrites. Endgültige Receipts/Commit im Handback/Managementjournal.

Lokale Ergebnisse vor QC: volle MCP-Suite 324/324 (`env -u OCVM_WORKTREE_ROOT` nur für den Testprozess), Browser 20/20, Hub Python 45/45, Release-Metadaten 5/5. Anfangs fünf Creation-Fixtures durch geerbte Live-Worktree-Root abgelehnt; kein Produktpatch daran, unter fixture-neutraler Umgebung grün. MCP-/Hubarchive zweimal bytegleich; Archive-Import/Hubs-Staging/Monitor-Service, Bash-Syntax und Shellcheck `--severity=error` erfolgreich. Python-Socket-ResourceWarnings sind bestehende Fixture-Diagnostik; Tests erfolgreich.

### Gezielte unabhängige QC-Korrekturen

QC `ses_ec32657bbffehilaie913UV7dq` meldete vier Blocker; alle gezielt mit Regression korrigiert: (1) Receipt-Omission am tatsächlichen MCP-Rebind behalten und vorherige Episode in History sichern; (2) WAL- und unterschiedliche Admissionreceipts einzeln verifizieren; (3) Status-/Investigation-Commits nur auf die weiterhin identische Runtime+Receipt+Lifecycle anwenden, überholte Reads allein als History sichern; (4) explizite Generation zuerst an internem Snapshot validieren und stets genau diesen Stand als Commit-CAS verwenden. Volle MCP-Suite danach 326/326, Typprüfung/Build grün. Korrigiertes MCP-Archiv zweimal bytegleich, SHA256 `8959f3c478189ae7c03516d2fa4853cca02611cfa48deeeccc4ad3d6511454e4`; Hub unverändert gegenüber erstem grünen Browserlauf. Unabhängige gezielte Re-QC PASS: keine verbleibenden Blocker oder notwendigen direkten Nebenregressionen, Quellcode/Archive/Pins bytegleich geprüft. Exakter Commitnachweis folgt im Managementjournal/Handback. Keine Liveabnahme.

## Kleinste Aktivierungsfolge nach QC und gesondertem Operator-Go

1. Lokal geprüften Mainstand auf dem Host verwenden. Für diesen unveröffentlichten Fix ist kein Remote-`opencode-vm update` erforderlich/geeignet: es kann das lokale Paket nicht installieren. Der lokale Code-/Launcherstand ist 0.7.55 mit MCP 0.1.55 und neuen Hub-Pins.
2. Wenn die Arbeit in diesem Lauf gesichert und alle Writer/Receipts abgeglichen sind, auf dem **Host** im Projekt `bash ./opencode-vm.sh attach` aus dem geprüften Checkout aufrufen. Das nutzt die bestehende VM. Kontrollierter Re-Attach stoppt die bisherigen Runtime-/Dienstinstanzen, staged beide Adapterkopien (`mcp/adapter` und `dashboard/adapter`, letzterer liefert die Monitor-Engine), baut sie und startet die Dienste neu; Hub wird in das neue `hub/assets-<HUB_ASSET_SHA256>` staged. Ein reiner Browser-Reload oder nur MCP-Neustart lädt nicht zugleich die neue Engine/UI. Kein Fresh-Start/Prune/Reset.
3. Geladenen Code nachweisen: authentifiziertes MCP `/healthz` → Adapter 0.1.55 und richtige Projekt-/Runtimegeneration; `tools/list` → `update_monitor` mit `task_id`/`manager_session_id`. Beide staged Adapterpakete/-Module mit geprüftem Checkout vergleichen; `ocvm-monitor` ExecStart zeigt `dashboard/adapter/dist/monitor-main.js`, frischer Prozessstart/Heartbeat in derselben Generation. Hubprozess zeigt neuen digestgebundenen Assetpfad; ausgeliefertes `/monitor.js` hasht gleich `hub/monitor.js` des geprüften Commits.
4. Hub hart neu laden. In einer separat autorisierten disposable Smoke-Fixture Delete→404→Reload→freie Masterbindung sowie Manager-Rebind/Triggerhistory (`session-primed`, `manager-primed`, `noop-trigger`/`dispatched`) prüfen. Reale BI-MC-Monitore bleiben außerhalb dieser Aktivierungsprüfung. Die hier ausgeführten Tests belegen lokale Fixtures, nicht die noch unaktivierte Liveinstallation.

Diese Aktivierungsfolge ist dokumentiert, nicht ausgeführt. macOS/Lima-/Hosted-Abnahme bleibt separat; ein lokaler Commit ist keine Freigabe/Releasebehauptung.
