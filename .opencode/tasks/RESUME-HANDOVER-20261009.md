# RESUME-HANDOVER — opencode-vm (2026-10-09T00:28+02:00, Kontextsicherung vor VM-Abräumen)

Zweck: Der Operator entfernt die VM und **alle Sessions/History**. Dieses Dokument hält die wesentlichen, für die Weiterarbeit nötigen Erkenntnisse **repo-persistent** (host-gemountet) fest, damit verlorene Sessions kein Hindernis sind. Es wird **kein neuer Boardtask erfunden**; nicht boardgebundene Erkenntnisse sind hier zugeordnet. Nur Dokumentation, keine Produkt-/Test-/Deploy-/Policy-/Board-/Monitoränderung.

## Persistenzbeleg
- Repo-Root `/Users/admin/Documents/github/opencode-vm` ist ein **virtiofs-Hostmount** (`findmnt -T`: FSTYPE `virtiofs`, SOURCE `lima-3ce9b76e4e2e8e56`) ⇒ Schreibvorgänge in diesem Pfad liegen auf dem Host und überleben das VM-Abräumen. Owner `lima:lima`.
- Git: HEAD `019d25649a1283d4413e891bb8983c48f6307e8f`, Tree `c4067f86a9da4d04eb7b753bdcc51043ba0e75ba`, Branch `main`, git-dir/common-dir `.git`, **kein staged diff**, tracked-dirty 14 + untracked 65 (fremde Einträge unangetastet), 31 Worktrees.
- Zusätzliche host-persistente Sicherung: `/Users/admin/.opencode-vm/sessions/66370db6a9e3f88af333b4d90620d90b/reboot-checkpoint-20261008/` (7 Dateien: QC-Berichte/-Orders beider Fallback-/Monitor-Stufen).
- **Grenze:** Kein Remote-Push (kein Credential im VM, nicht autorisiert). Persistenz ist lokaler Host-Mount, kein Off-Site-Backup.

## Board-gebundene Tasks (kanonische C/P, Stand, HEAD)
| Task-ID | C / P | Stand | Haupt-HEAD/Worktree |
|---|---|---|---|
| `task_efbe63cf-53da-5e79-be25-f7ac8efe9916` (Hub-Nachbearbeitung Fallback-Konfig + Monitorformular) | `.opencode/tasks/task-task_efbe63cf-…compact.md` / `planning/task-concepts/task_efbe63cf-…concept-plan.md` | S2 QC_PASS, lokal in Main integriert `259454d3…`; danach Main `019d2564…` | Worktrees u. a. `-s2-manager-priming` `259454d3`, `-fallback-monitor-ux` `4330c7d8`, `-pause-resume` `1bd025db` |
| `task_6328d17e-1786-592d-b670-236f163ce8b1` (Repo Live – Dashboard + MCP-App) | `.opencode/tasks/task-task_6328d17e-…compact.md` / `planning/task-concepts/task_6328d17e-…concept-plan.md` | lokal integriert `afc4892…` (Tree `103c9e19…`, Parent `913ef83c…`), Ancestor von Main; extern NOT_RUN | Worktree `task_6328d17e-…` = `afc4892` |
| `task_fa86d673-e8d2-5a45-b82d-6ee0c733c415` (profilbezogene Fallback-Strategie + Compaction) | dieselben C/P-Muster | **LOCAL_MAIN_COMPLETE** `019d2564…`/`c4067f86…` (QC_PASS; Schema 4, 2 Schalter, Journal#5-Sortierung; Script 0.7.22, Adapter 0.1.34, MCP-Pin `2e09e5d8…`, Hub-Pin `7842dc31…`, Skill r45) | Worktree `task_fa86d673-fallback-per-profile` = `019d2564` |
| `task_7e6ce738-940c-5a15-b888-a13de94f8098` (WP2) | dito | LOCAL_COMPLETE_PASS, extern NOT_RUN; kein W1-Neustart | – |
| `task_f53c3e47-39a6-5777-8a14-6895019f081c` (Doctor) | dito | Worktree `task_f53c3e47-vm-doctor` = `79dd51f` | – |

## Geprüfte Sessions (native Session-Daten; Volltexte gehen mit der VM verloren)
- `ses_ee79db5afffe4Ik6tpeYNELwnK` — „OC-VM – schnelle Nachbearbeitung Fallback und Monitor-UI" — Autor/Integrator beider Stufen (S2 `259454d3`, fa86d673 `019d2564`); busy zum Sicherungszeitpunkt.
- `ses_ee76122d4ffeONomz0XBDdCeKw` — Reviewer; terminal **QC_PASS** `msg_11d56ef25001Gc0bz4EqgzvHCt` (1727 B, SHA `cdec57ba…`) für `019d2564…`; zuvor QC_PASS `msg_11c4bc6e30010swpJb2oo2A2Ib` für `259454d3…`.
- `ses_ee371ae17ffeovs46da27v48Lp` — „Monitor Fallback-Erweiterung – autonom bis unabhängige QC und lokale Main-Integration" — letzter Terminal: MANAGEMENT-REPORT `monitor_5e427218…`/`wake_492474…` (21:59Z), rein lesende Abschlussketten-Verifikation, kein Dispatch/Write. (Manager-Monitor; Journal#6: `MANAGER_CONNECTOR_NOT_BOUND`.)
- `ses_ee3631d31ffeMVOAtWnIiPpmxp` — „[KLÄRUNG] Monitor-Delegation: native Subagents und Tool-Bindung" — Klärung; letzter Terminal 10142 B, weist u. a. eine Lücke des Original-Rechercheauftrags aus.
- `ses_ee57216c4ffeQ244JqC75p7IZ0` — „Repo Live – unabhängige Exactcommit-QC Dashboard und MCP-App" — **QC_PASS** Delta RepoLive F1/F2, Target `afc4892…`/Tree `103c9e19…`/Parent `913ef83c…`.
- `ses_ee721b32bffeBodYXqMLu4iERZ` — „Repo Live – Concept: gemeinsames Dashboard und MCP-App" — „**Lokale Mainintegration – MAIN_LOCAL_INTEGRATED_PASS**" (QC-Grundlage `msg_11adc6333001Wqgkivi3gvDEZd`, Receipt `msg_300048f8662b4e7aa00e06eb0e2d3ebf`).
- `ses_ee45c06fbffenz1gDB1w9qIWZd` — „Zen-Modellauswahl – Codepfad und Free-only-Katalog klären" — lesende Diagnose abgeschlossen (7899 B), keine Writes/Credentials; **BI-MC-Live-State war unzugänglich** (als solches ausgewiesen).
- `ses_ee4b65151ffexYTNXPghuGgE2I` — „[KLÄRUNG] AITL MaxListeners und ACTIVITY_UNAVAILABLE" — Klärung (10955 B), Repro-Artefakt `/tmp/opencode/ocvm-journal-repro/repro.mjs` (**guest-lokal UNGESICHERT**, reproduzierbar); Produktdateien unberührt.

## Offene Themen (nur Referenzen, keine neuen Tasks)
- **Paketplanung:** Master-/Paketmarker `package_id=task_d3d903f8-5222-5d25-94bf-8160bad63b81`, SYNTHESIS_REVISION 7; WP2 `task_7e6ce738-…` LOCAL_COMPLETE_PASS/extern NOT_RUN; **kein W1-Neustart**.
- **VM-Hub / Agent Control Hub:** `task_efbe63cf-…` (S2, integriert) + `task_fa86d673-…` (Schema-4-Fallback, LOCAL_MAIN_COMPLETE).
- **Doctor:** `task_f53c3e47-39a6-5777-8a14-6895019f081c` (Worktree `79dd51f`).
- **Fallback/Compaction:** `task_fa86d673-…` (Fehlerklassen provider_timeout/provider_quota/context_input_length + Compaction-Recovery; Kalibrierung an echten Providerfehlern **unverified**).
- **Zen (Free-only-Katalog):** `ses_ee45c06f` (BI-MC live unzugänglich).
- **Timeout/Quota:** Bestandteil der Fallback-Fehlerklassen (Kalibrierung an realen Fehlertexten offen).

## Lücken / nicht erreichbare Quellen
- Deep-Inhalte der Klärungs-/Monitor-/Zen-Berichte nur als **Previews** gelesen; Kernaussagen hier zusammengefasst — Volltexte verlieren sich mit den Sessions.
- BI-MC-Live-State (Zen) unzugänglich; hosted ChatGPT/RepoLive-Rendering unverified; echte Mac/Safari/VoiceOver- und Langzeit-/Nachtlauf-Abnahmen offen.
- Guest-lokal **UNGESICHERT** (gehen mit der VM verloren, reproduzierbar): `/tmp/opencode/*` (Testlogs `fb-final`/`fb-main`/`fb-tests2`/`ocvm-s2-fix`, Prüfkopien `main-fb-verify`/`qc5-019d2564`/`pin-base`/`base-check`, Bundle-Tars `pin-cand-*`/`pin-base-*`/`fb-main-*`/`mv-*`, Journal-Repro `ocvm-journal-repro`).
- Kein Remote-Backup autorisiert/möglich (kein Credential im VM).

## Nächste Schritte (nur mit neuem Operatorauftrag)
1. Repo-Root/HEAD/Tree/Dirty + `git worktree list` frisch verifizieren (keine Annahme aus diesem Dokument).
2. Task-Journal `head_sequence` der betroffenen Tasks auf neue Vorgaben prüfen; Run/Connector-Status frisch lesen (Healthcheck allein ≠ E2E).
3. efbe63cf: Q1c/Q1b/Q6/Q7/Q8 entscheiden → S3 Hierarchie → S4 Pause/Resume (`1bd025db…` Reconcile) → S5 VM-Verlust → S6 Scheduler-Failure → S7 Guard.
4. fa86d673: Operator-Installation/Update für Nachtlaufwirksamkeit; echte Langzeit-/Native-/Live-Abnahme.
5. 6328d17e: externe RepoLive-Pilot-Abnahme (hosted ChatGPT/Safari).
6. F2-Main-Testdefekt (`tests/mcp_self_connection_test.py`) separat beauftragen.

## Diagnose zum Mitnehmen
Editor „Too many open files in system"; Tunnel „response already fulfilled or unknown request"; **lokale Healthchecks PASS beweisen keinen E2E-PASS**; ActivityJournal-Fail-closed-Latch (Ursache unverified; nach Operator-Adapterneustart wieder funktionsfähig); transient selbst geheilt: einmalige git-Meldung „dubious ownership" bei korrekter Ownership `lima:lima`/uid 501 (keine git-Config-Änderung).