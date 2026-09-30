Task-ID: task_9dc6e797-b884-589a-99d7-fd3ceceb5414
Title: Orchestrator Skill – agent-managed Worktree-Isolation und persistente Arbeitspakete
Last-updated: 2026-09-30T21:08:53+02:00

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

## Implementiert und lokal geprüft

- Orchestrator-Skill auf **2026-09-30-r25** erweitert: generische agent-managed Git-/Worktree-Ownership, verifizierte Write-Targets, Basis-/Dirty-/Integrationsnachweis, serielle Integration und fail-safe Retention/Cleanup.
- Persistente Work Packages über bestehende Board-Managementtasks + C/P beschrieben: ID-/Goal-/Muss-Optional-Ermittlung, Todo-Readinesslücken, Wellenplanung, `WORK_PACKAGE_READY` nach `REGISTERED` und vor Boardmove, Autonomie/`INPUT_REQUIRED`, Morning-Handoff, Work-vs-Chat und getrennte Runtimewahl.
- Neue Skillreferenzen `references/worktree-ownership.md` und `references/work-packages.md`; Board-, Taskdokument-, Follow-through- und Regressionstexte sowie `docs/CHATGPT.md` aktualisiert. Keine MCP-Datenstruktur, Session-Policy oder Product Runtime geändert.
- `python3 -B tests/chatgpt_skill_test.py`: **20 Tests PASS**. Enthält static/client-flow Checks und einen echten temporären Git-Test für getrennte Worktree-Indizes, gemeinsames Git-Verzeichnis und Shared-Hunk-Mergekonflikt.
- `python3 -B scripts/build-chatgpt-skill.py --check`: PASS; Inventar/ZIP/Checksumme/latest konsistent. Aktuelle ZIP-SHA-256: `0850f5da2de9fc0ca64b3c2a9279a15108cf83a033122cbef5378d29685fc871`. `git diff --check`: PASS.
- Keine externe ChatGPT-Work-/Hosted-Abnahme, macOS/Lima-Mount-/Credentialabnahme oder aktive Skillinstallation/Connector-Restart durchgeführt. Tatsächliche Work-Tool-Treebindung bleibt vor realen isolierten Writes zu verifizieren.

## Nächster konkreter Schritt

Task-eigene Änderungen gegen den Ausgangsstatus prüfen, nur die freigegebenen Task-/Skill-/Test-/Artefaktdateien stagen und lokal committen. Unabhängige geänderte Taskdokumente sowie vorhandene `dist/`-Artefakte bleiben ausgeschlossen. Danach Commit-SHA und finalen Integrations-/Akzeptanzstatus berichten; keine Remotepublikation.

## Grenzen

Kein Push, Remote-Git-Write, Release, Deployment, aktiver Connectorrestart oder automatische Board-`done`-Änderung. Produktiver Connector wurde mit 0.1.17 entdeckt; lokale Agent-managed Commits belegen keine Aktivierung des neuen lokalen Runtime-Stands. Worktree-/Directory-Targeting, ChatGPT Work und Host-/Hosted-Abnahme müssen jeweils als tatsächliche Capability/Evidence geprüft werden.
