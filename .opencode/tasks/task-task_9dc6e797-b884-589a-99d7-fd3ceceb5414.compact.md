Task-ID: task_9dc6e797-b884-589a-99d7-fd3ceceb5414
Title: Orchestrator Skill – agent-managed Worktree-Isolation und persistente Arbeitspakete
Last-updated: 2026-09-30T22:43:41+02:00

## Concept Plan

Kanonischer Plan: `planning/task-concepts/task_9dc6e797-b884-589a-99d7-fd3ceceb5414-concept-plan.md`.

## Verifizierter Startstand

- Boardtask ist nach ausdrücklicher Umsetzungsfreigabe `in_progress`; Statusreadback bestätigt Titel und beide Dokumentrollen.
- Die zuvor erwartete Agent-managed Sessions V1-Abhängigkeit ist lokal abgeschlossen. Originalterminal: Session `ses_f10559f87ffeE11x7hm34rzgT1`, Assistant `msg_0f36a7083001QHYgOYrMRgJgx8`, `LOCALLY_IMPLEMENTATION_COMPLETE`, `finish:stop`, kein Fehler. Commits: `4d3c37ae58511e84e801d78c289bfe2157859e7b` und `d6f41cc8832895a5edbc181d1b6cd764f53ea65c`.
- Konsolidierte Sourcebasis `d6f41cc8832895a5edbc181d1b6cd764f53ea65c`; Skill r24. Bereits implementiertes Managed-Verhalten wird nicht neu aufgerollt.
- Lokale Taskboard/MCP-Runtime meldet Connector 0.1.17. `get_task_documents` lieferte für diese Task-ID keine Bindings; `add_task_document_bindings` ist nicht im aktuellen Toolkatalog, `register_task_document` und `get_task_documents` sind vorhanden. Bestehender Register-Fallback ist deshalb der verwendbare Vertrag.
- Initialisierung abgeschlossen: `register_task_document` band beide Rollen. Readback meldete beide `available` mit den exakten Pfaden und Inhaltsrevisionen; Boardmove und Statusreadback danach separat bestätigt.
- Kanonische Boardkarte und Taskbeschreibung geprüft. Keine Paket-C/P vor dieser Initialisierung. Fremde geänderte Taskdateien und vorhandene `dist/`-Artefakte bleiben unangetastet.

## Entschiedener Umfang

1. Agent-managed Write-Tasks erhalten eindeutige Git-/Worktree-Ownership; parallele Schreibarbeit isoliert, sequenzielle Einzelarbeit kann exklusiv im Integration-Tree laufen.
2. Persistente Paketverwaltung bleibt skill-first in Board-Management-Task + task-ID-markierten C/P; keine neue MCP-Datenstruktur.
3. `WORK_PACKAGE_READY` benennt die startbare Welle, nicht automatisch alle Paketmitglieder oder einen Boardstatus.
4. Basis-HEAD, Owner, Dirty-State, Commits und Integrationsziel werden festgehalten; abhängige Starts brauchen bestätigten integrierten HEAD. Unklare Arbeit wird erhalten, nicht automatisch gelöscht.
5. Innerhalb des Plans autonom technische Details; echte planüberschreitende Entscheidungen ergeben terminales `INPUT_REQUIRED`. Unabhängige sichere Mitglieder können fortfahren.
6. Morning-Handoff trennt Board-, Session-, Implementierungs-, Commit-, Integrations- und externe Abnahmezustände.
7. Normaler Chat plant und bespricht; ChatGPT Work führt sichtbare Mehrschritt-Koordination, OpenCode-VM bleibt Repositorylaufzeit. Keine automatische Work-Aktivierung.
8. `execution`/`standard`/`deep` folgt der Paketkomplexität und aktueller Projektpolicy; keine hartcodierten Runtime-IDs.

## Implementiert / aktueller Integrationsstand

- Originaler Implementierungsstand **r25**, nach autorisierter Deep-QA korrigierte Quellen und lokales Paket **2026-09-30-r26**: generische agent-managed Git-/Worktree-Ownership, verifizierte Write-Targets, Basis-/Dirty-/Integrationsnachweis, serielle Integration und fail-safe Retention/Cleanup.
- Persistente Work Packages über bestehende Board-Managementtasks + C/P beschrieben: ID-/Goal-/Muss-Optional-Ermittlung, Todo-Readinesslücken, Wellenplanung, `WORK_PACKAGE_READY` nach `REGISTERED` und vor Boardmove, Autonomie/`INPUT_REQUIRED`, Morning-Handoff, Work-vs-Chat und getrennte Runtimewahl.
- Neue Skillreferenzen `references/worktree-ownership.md` und `references/work-packages.md`; Board-, Taskdokument-, Follow-through- und Regressionstexte sowie `docs/CHATGPT.md` aktualisiert. `WORK_PACKAGE_READY` ist explizit zusätzliches Boardmove-Gate nach `REGISTERED`. Keine MCP-Datenstruktur, Session-Policy oder Product Runtime geändert.
- Vorherige Commitkette: `06af861f3a77b6e502368fc4f74562aee199aab9` (Skill-first Implementation), `955f8780eda5da3209ceeb81949c326ce16b3ac6` (Contextabschluss), `d46b8c15f589760bcfb6e7a7dc8247744e6451dc` (Package-Boardmove-Gate). Full-Commit-Datum 2026-09-30: geprüfter r26-QA-Delta plus kanonische registrierte Nightly-Taskdokumente von D994/CCE/ACH und finale skill-/Paketartefakte; finale SHA in lokaler Git-Historie und Terminalabschluss.
- QA-Write-Ownership: freigegebener sequenzieller Haupttree `/Users/admin/Documents/github/opencode-vm`, Branch `main`, Git-/Common-Git-Dir `.git`, Owner-Session `ses_f0c8bd82effehrn7eEsIVme66V`; QA-Startbasis `d46b8c15…`, ursprüngliche Taskbasis `d6f41cc…`. Der ausdrückliche Full-Commit-Auftrag nimmt das aktuelle registrierte D994-Contextreadback mit auf; ungebundene Todo-/disposable Dokumente, die abweichende ACH-`/tmp`-Kopie und lokale alte `dist/`-Buildarchive bleiben geschützt.
- Full-Commit-Allowlist: Task 9 C/P + r26-Quelle/Tests/ZIP; registrierte C/P von abgeschlossenem Follow-through CCE und registrierter kanonischer ACH-Context; D994-Context mit aktuellem `done`-Boardreadback. Die separate ACH-`/tmp`-Contextkopie, ungebundene `todo`-Konzeptpaare, der ausdrücklich disposable Smoke-Task und alte `dist/`-Buildarchive sind kein Teil dieses Commits.
- Keine externe ChatGPT-Work-/Hosted-Abnahme, macOS/Lima-Mount-/Credentialabnahme oder aktive Skillinstallation/Connector-Restart durchgeführt. Tatsächliche Work-Tool-Treebindung bleibt vor realen isolierten Writes zu verifizieren.

## Deep-QA: PASS für den lokalen Skill-first-Scope

- Vollständiger aktueller Boardtask einschließlich Ergänzung L, registrierte C/P und finaler r25-Codezustand abgeglichen. Deep-Profil zur Reviewzeit: Policyrevision 18, available, `openai / gpt-6.1-sol / xhigh`; laufende Session stimmt exakt überein.
- Fünf in-scope-Findings geschlossen: repositoryweite Ownership zwischen Paketen; kanonische C/P-Delta-Publikation statt paralleler Worktreekopien; Invalidierung alter Wavegates bei Drift; Schutz ignorierter Outputs/detached Gitobjekte bei Cleanup; vollständige Wiederaufnahme-/Member-Handoff-Regeln. Details und Coverageabgleich im Plan §12. Keine neue MCP-Struktur/Sicherheitsgrenze.
- Alter Fake akzeptierte einen Boardmove nach fehlgeschlagener Ready-Reevaluation; neuer Negativtest reproduzierte dies. Nach Korrektur scheitern stale Rev-/HEAD-/Member-/Inputfälle, doppelte Tasks/Tree-Aliase, leere/unbekannte/zyklische Wellen und unsichere Cleanupbedingungen. Read-only-Wellen brauchen keine Schreibkopie, späterer Blocker rollt Board nicht zurück. Fake ist Testmodell, keine Produktengine.
- `python3 -B tests/chatgpt_skill_test.py -v`: **22 PASS / 0 FAIL / 0 SKIP**. Fokuslauf mit vier Lifecycle-/Ownership-/Publikations-/Gitfällen ebenfalls PASS. Echte Disposable-Gittests: verschiedene Indizes, gemeinsames Gitdir, parallele nested/detached Commits, Wiederaufnahme, Shared-Hunk-Konflikt, untracked Removal-Deny und Source-Ref-/Resultaterhalt nach Cleanup+GC.
- `python3 -B scripts/build-chatgpt-skill.py --check` und `git diff --check`: PASS. Aktuelle lokale r26-ZIP-SHA-256: `c1e93f7e27551c02724a006bd5c06f91884aa5918cdb1d2c9a149e8f6d16cba5`. Paket/Inventar/Privacy/Reproduzierbarkeit geprüft; Python-Coverage ist keine Hosted-Verhaltenscoverage.
- Kein verbleibender lokaler Produkt-/Architektur-/Schema-/Securityentscheid. Technisch zur Abnahme des dokumentierten Skill-first-Schnitts bereit; echte Host-/Tooltarget-/Hosted-Nachweise bleiben separat, keine vollumfängliche Deployment-/Live-Safetyabnahme behauptet. Board bleibt `in_progress`.

## Nächster konkreter Schritt

Der lokale Full-Commit dieses Arbeitsgangs ist nach dieser Kontextrevision in der Git-Historie nachvollziehbar. Danach bleibt als nächste technische Evidence separat autorisierte echte OpenCode-Tool-Worktree-Targeting-/Hostpersistenz- und ChatGPT Work/Hosted-Akzeptanz. Management entscheidet über fachliche Abnahme/Board-Done; der Commit setzt den Task nicht auf done. Keine Remotepublikation.

## Grenzen

Kein Push, Remote-Git-Write, Release, Deployment, aktiver Connectorrestart oder automatische Board-`done`-Änderung. Produktiver Connector wurde mit 0.1.17 entdeckt; lokale Agent-managed Commits belegen keine Aktivierung des neuen lokalen Runtime-Stands. Worktree-/Directory-Targeting, ChatGPT Work und Host-/Hosted-Abnahme müssen jeweils als tatsächliche Capability/Evidence geprüft werden.
