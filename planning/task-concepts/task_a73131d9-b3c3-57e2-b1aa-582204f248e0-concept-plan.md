Task-ID: task_a73131d9-b3c3-57e2-b1aa-582204f248e0
Title: MCP – persistentes Management-Journal pro Task statt Description-Append
Status: active
Last-concept-update: 2026-10-02T12:05:19+02:00

# Canonical Concept Plan

## 1. Authority, preparation state and execution order

This plan covers the existing Board task; it does not create new product scope. Current Board readback: MCP-15 in workstream `board_project_1bdf1737-f1ca-323e-7a7d-3025c99f2cb4`, status `in_progress`, priority `high`, last Board update `2026-10-02T02:06:36.59360841+02:00`. Both registered document roles read back `available` at the exact C/P paths and were updated only after Task A implementation passed and was integrated. The full Board description remains the scope authority. This plan is now `active` (concept lifecycle), not Board status.

Board = outcome, scope and acceptance. This P = canonical requirements/design/decisions/implementation/test concept within that scope. C (`.opencode/tasks/task-task_a73131d9-b3c3-57e2-b1aa-582204f248e0.compact.md`) = one terse current working-state file. Original session results, Git/content reads and test reports = evidence of execution. A plan, Board state or technical turn completion cannot substitute for implementation evidence.

Task A implementation was prepared in an isolated worktree, committed locally, then integrated onto current `main` after the disk-resize commit. No Board mutation, connector restart, infrastructure action, remote publication or release occurred. This plan's status records the concept/implementation lifecycle only; it does not change the Board state.

**Fixed execution order:**

1. Implement, regression-check and integrate this task's Management Journal foundation — completed in `62869f68fc2ccbea302d34c2bd39900dbc813090` on current main.
2. Then initialize and execute Orchestrator QC/acceptance task `task_160e0556-f3a8-5e12-a877-ed22e7bb2360`, whose canonical plan is `planning/task-concepts/task_160e0556-f3a8-5e12-a877-ed22e7bb2360-concept-plan.md`. Its QC-3 is unblocked for review but remains unreviewed/PENDING until Task B performs actual acceptance.

Task B's document preparation or QC-3 result is separate from Task A implementation, integration, registration and Board status.

## 2. Problem and target outcome

Current `add_task_management_note` adds another `Management Note:` block to the native task Description. Repeated management cycles therefore enlarge both the canonical task order and normal serialized task output. The current implementation stops at 32,000 UTF-16 codeunits for Description and 40,000 UTF-8 bytes for a normal task response including comments, links and documents. A 48+ hourly-cycle monitor can exhaust those budgets even though each individual checkpoint is short. Reading the whole accumulated Description on every wakeup also repeats irrelevant history.

The target is persistent, deterministic, task-specific management history separate from native Description, usable by **any Board task**, created only on the first authorized management append. Keep the established append call practical for existing callers; add explicit read-efficient history/checkpoint access; preserve legacy notes; and stop dependent management on storage/parse/coverage uncertainty. The canonical task order remains on the Board. This task changes the management/task-metadata storage path, not monitor business semantics.

## 3. Verified baseline and evidence boundaries

- Initial implementation base: `8c3b1d66652653b287e56652c4fef197e038ef3b` (r27). Isolated task branch `task/a73131d9-management-journal` commit: `9d486431a16b6d9d329a6113a7d11fc281c16192`. Current `main` already contained Disk-Resize integration `e6acbb97adb530caf73163f7ae2b010a81e6e54d`; Task A source/docs were reconciled and integrated in commit `62869f68fc2ccbea302d34c2bd39900dbc813090`. No foreign worktree artifacts were integrated.
- Integrated versions: MCP package / `ADAPTER_VERSION` **0.1.22**, `opencode-vm.sh` **0.7.2** (patch increment on the combined main base), companion skill **2026-10-02-r28**. These local source versions do not prove an external connector was restarted or deployed.
- `adapters/mcp/src/taskboard.ts`: `ProjectBoardService`, metadata schemas 1/2/3, deterministic public task IDs, bounded native reads, `addManagementNote`, `getManagementHistory`, `withMetadataLock`, atomic/fsynced sidecar publication and stable ID across Board Project reclassification.
- `adapters/mcp/src/tools.ts`: strict append receipt output and strict `get_task_management_history` modes (`recent`, `after`, `after_checkpoint`, `latest_checkpoint`), metadata-only diagnostics and registration/dispatch. Normal task schemas remain free of journal contents. Write/read annotations are hints, not authorization guarantees.
- `adapters/mcp/src/content.ts`: existing UTF-8/JSON response budgeting and authenticated adapter-lifetime read references. Current payload/envelope bounds are 48 KiB/64 KiB, with routine text reads 8,192 bytes and maximum text budget 16,384 bytes. Do not conflate these with native Description or Board scan bounds.
- `adapters/mcp/src/taskboard.test.ts`, `http.test.ts`, `diagnostics.test.ts`, `tests/taskboard-integration.mjs`: focused lazy-create, 64-cycle, bounded-read, legacy, captured-head cursor, four-process append, fault/parse/lock and MCP wire/schema coverage. Old Description-growth expectations were replaced only where the new journal contract required it.
- `docs/MCP-INTERFACE.md`: nineteen optional Board tools, explicit append/history contract, no upstream UI/general-edit CAS, full-list scan bounded to 1 MiB/500 tasks, 50 matches and 40,000-byte normal task output.
- Existing persistent Taskboard runtime for this project is `.opencode-vm/taskboard/`, identified by its `runtime.json` and configured metadata path. Taskboard DB/metadata live on the mounted project, rather than in ephemeral VM-only `/tmp`.
- Current companion marker is `2026-10-01-r27`. Read `SKILL.md`, `references/board-workflow.md`, `monitor-tasks.md`, `integration-test-monitor.md`, task-document instructions and predecessor task C/P. Prior local r27 package/test PASS is reported evidence from that prior work, not rerun here. Existing Work Package/r26 and Monitor/r27 concept histories are referenced, not copied.

The preceding r27 marker describes the initialization snapshot; the integrated companion skill is now **2026-10-02-r28** with its reproducibly checked local bundle. No hosted client import is claimed.

Relevant predecessor plans:

- `planning/task-concepts/task_9dc6e797-b884-589a-99d7-fd3ceceb5414-concept-plan.md`: ownership, persistent packages, evidence/base/integration and handoff.
- `planning/task-concepts/task_80f79e83-7493-5fb4-8131-3ddb072a2071-concept-plan.md`: existing monitor loop, lifecycle, sequential Waves, fingerprint/reserved-cycle policy and deferred operator-resume provenance. Later effective implementation decisions there take precedence over its historical open proposals.

## 4. Requirements and acceptance mapping

| ID | Requirement / acceptance | Required later demonstration |
|---|---|---|
| A-1 | Any task can have deterministic task-specific persistent history; no master-only restriction. | Two distinct task IDs, a normal non-master task, restart/reopen and stable-path identity tests. |
| A-2 | Lazy creation on the first valid management append; reads alone create nothing. | Absent files before read/invalid append, one initialized journal after first successful append. |
| A-3 | Retain practical compatibility of `add_task_management_note(task_id, note)` while stopping new Description growth. | Same strict basic input; native Description/title/status/priority unchanged after appends; documented output/readback change. |
| A-4 | Durable, ordered, inspectable appends; no silent overwrite/history loss. | Distinct records for repeated identical notes, monotonic sequence, concurrent processes, interrupted/uncertain write evidence. |
| A-5 | Explicit bounded history: whole history when it fits, last N and continuation from a cursor/checkpoint; efficient latest-checkpoint lookup. | Empty/small/full traversal, tail, continuation, latest checkpoint despite newer ordinary notes, response-budget/performance assertions. |
| A-6 | Normal task reads do not automatically include journal contents. | Size/content stability with 48+ checkpoints and much longer fixtures; list/exact task reads remain independent of journal growth. |
| A-7 | Recover Board order + latest relevant checkpoint + newer decisions + older history when needed. | Fresh manager reconstruction with loop history, newer notes after checkpoint, missing/partial history fail-safe. |
| A-8 | Existing Description-based notes remain traceable; no destructive migration. | Exact legacy Description preservation, explicit source/coverage, legacy-only and mixed legacy/journal tasks. |
| A-9 | Native Board, MCP schema/response and journal storage/read limits are distinct. | Boundary fixtures including Unicode/JSON escaping; user docs name each bound and error. |
| A-10 | Size/I/O/parse errors cannot become empty history, successful persistence or permission to proceed blindly. | Fault injection before/during/after publication, corruption and incomplete-page scenarios; manager stops/escalates without blind append. |
| A-11 | At least 48 hourly management cycles over a two-day logical timeline are no longer limited by Description append growth. | Deterministic 48+ cycle simulation plus restart/readback; separately label any real elapsed-time acceptance. |
| A-12 | Preserve r27 management-loop semantics without unrelated product features. | Concept↔source↔skill↔tests mapping; no storage-based authority or new scheduler/dispatch semantics. |

## 5. Settled constraints and safe technical assumptions

1. Scope includes journal append/read storage and the necessary MCP schemas/docs/client readback integration. It does not introduce task status coupling, a scheduler, new package membership, operator authentication or automatic retries.
2. Storage follows the configured persistent Taskboard metadata directory. Do not use host-specific session paths or a second persistence service. Derive paths from the validated runtime and exact public task ID; callers do not supply arbitrary filesystem paths.
3. Preserve stable public task IDs across Board Project moves. Resolve the actual task and existing unresolved-transfer boundary before append/read. Do not key history to mutable title/native key or a backend ticket that reclassification replaces.
4. Existing cooperating-writer locking is sufficient for this initial storage scope. Reuse it for mapping/transfer/journal coordination; do not turn it into a claimed scheduler lock or protection from non-cooperating raw filesystem writers.
5. Existing non-idempotent semantics remain: identical text may be deliberately appended twice. An uncertain response is reconciled by exact journal readback, not resent. Correlation labels in r27 checkpoints do not become an idempotency service.
6. Preservation means no loss/pruning of old native notes, not making arbitrary legacy text automatically structured or trustworthy. No fabricated legacy timestamps, sequence chronology across unrelated sources, or human actor identity.
7. Ordinary task-read stability means journal growth adds no full-history body. It does not erase pre-existing oversized Descriptions/comments/links or remove the existing bounded Board scan contract.
8. The storage/API details in §6 were finalized within Board scope, implemented and integrated. The journal marker/index remain storage locators only, not a new authentication, scheduler-lock or product-state mechanism.

## 6. Architecture and persistence design

### 6.1 One canonical journal and a small derived head

Integrated runtime layout beneath `dirname(taskboardMetadataFile)`:

```text
management-journal/<full task_id>.jsonl
management-journal/<full task_id>.head.json
```

These are runtime data artifacts, not C/P documents or registered task-document roles. The 0700 directory and 0600 regular files are created lazily by the first valid append only; reads do not create them. Journal identity binds schema version, project identity, full stable task ID and a UUID generation. Each entry retains a monotonic sequence, append timestamp, UUID entry identity and complete trimmed note text. Sequence, not wall-clock timestamp, defines journal order. Timestamp is not operator authority.

The append-only UTF-8 JSONL file is canonical history. A small derived head descriptor records committed byte boundary, entry count/last sequence, last-record offset and latest recognized checkpoint sequence/offset. It is a seek aid, not a second semantic truth or a growing copy of all notes. Validate it against journal identity and referenced record/boundary; mismatches cannot silently serve stale management state.

Use exact r27 `MONITOR-CHECKPOINT v1` framing only to locate checkpoint records. Retain arbitrary ordinary note text without guessing lifecycle or fingerprint semantics in the adapter. A checkpoint locator is not a general parser/authenticator of operator directives. Unknown framing remains ordinary note text and must not be promoted to trusted structured state.

### 6.2 Append/publication contract

Under the existing cooperating-writer lock:

1. Validate exact task ID/nonempty bounded note, resolve current task, read metadata and enforce transfer/identity boundaries. Preflight the response shape and serialized entry bounds before committing.
2. For an existing journal, validate its identity, committed boundary/head and relevant tail; for absent storage, prepare identity plus the first entry without modifying Description. Foreign identity, unexpected file type/path, incompatible schema or uncertain prior tail fails closed.
3. Assign one new sequence/entry identity, append one complete bounded record, flush the canonical file, then publish the derived head atomically using the repository's temporary-file/fsync/rename pattern. Persist directory entries on initial creation. Return success only after the intended durable state and bounded receipt/readback are confirmed.
4. Do not overwrite, truncate, normalize or silently skip old records. A partial append, flush error, interrupted initial creation or head-publication failure reports an explicit failure/uncertain outcome and leaves evidence for reconciliation.
5. A committed record followed by failed head publication is potentially delivered, not proven non-admission. A controlled reconciliation may validate the complete suffix and rebuild only derived metadata under the lock; it must not append again. A malformed/incomplete suffix is not repaired by deleting it. Escalate with the precise storage gap and preserve bytes.

The two files do not share a filesystem transaction. The implementation fsyncs complete canonical log bytes before atomically publishing the derived head. Missing heads may be reconstructed in memory by a bounded full-log scan (≤64 MiB) and are reported `rebuilt_index`; complete suffixes beyond a stale head are validated within 1 MiB and surfaced as `recovered_suffix`. Reads do not rewrite/rebuild the head; a later append republishes only the derived index under the lock. A malformed/incomplete suffix, corrupt head, identity mismatch, or non-regular/unsafe file path fails closed and preserves bytes. If data may have committed but head publication fails, return `TASK_MANAGEMENT_JOURNAL_UNCERTAIN` and reconcile history before a retry.

### 6.3 Efficient bounded reads and consistency

History reads capture journal generation and high-water byte/sequence boundary. Responses distinguish the current journal head from a page's captured head, return only complete records within the whole-response UTF-8/JSON budget, and provide coverage/continuation. Appends after a captured cursor do not extend its prefix; before action based on latest state, refresh the head. Detect replacement/truncation/identity mismatch rather than mixing generations.

- **Small complete history:** one bounded response can return it all, explicitly marked complete.
- **Full long history:** page from the beginning with a cursor until that captured head is reached; never pretend a page is the whole history.
- **Recent / last N:** bounded reverse/tail scan of at most 1 MiB, not `readFile` of the entire journal. Return ordering and an omitted-older-history flag. Response byte budget may reduce the returned count but never truncates note bodies.
- **Full/after history:** `mode:"after"` starts at the first record or follows an opaque cursor. Cursors bind project/task/generation, previous record boundary, next sequence and captured high-water bytes/sequence; changed generation/truncation fails. Page until that captured head is reached. If older fingerprint history is required, the manager must page from the start; `recent` is not an absence proof.
- **After latest checkpoint:** `mode:"after_checkpoint"` seeks from the validated checkpoint offset and returns later entries to the captured head. If no checkpoint exists, the bounded cursor starts at the beginning. A later append needs a fresh head read.
- **Latest checkpoint:** seek via the validated small head. Return the checkpoint's identity/sequence and the captured journal head, making any later notes visible through bounded tail/continuation. No checkpoint means explicitly none in that source, not proof no historical checkpoint/decision exists.
- **Large single note / size boundaries:** keep the existing ≤32,000 UTF-16-codeunit client input maximum and require JSON-serialized note text ≤40 KiB (including JSON escaping), so one entry is readable as a whole record. The whole per-task journal is capped at 64 MiB; a recent tail scan and recovered unindexed suffix each have a 1 MiB bound. MCP envelope and normal task JSON limits remain distinct and are checked separately.

The manager must inspect notes newer than the latest checkpoint and retrieve older per-fingerprint history when the next action depends on it. A last-N sample is not proof that an older attempt/decision is absent. If required coverage cannot be established, stop that action and report/escalate.

### 6.4 Legacy preservation and read contract

The integrated non-destructive compatibility contract leaves native Description and all old `Management Note:` blocks character-for-character unchanged. New notes go only to the journal. Do not import/delete old text, duplicate it into the new store, or create a journal on read.

`get_task_management_history` identifies both sources: journal entries/coverage and a `legacy_description` UTF-8 byte range with a SHA-derived revision. It returns legacy text raw rather than parsing marker blocks; ambiguous embedded markers, absent timestamps and actor provenance are not synthesized. A nonzero legacy offset requires the same revision; if Description changes, restart at byte zero. Ordinary `get_project_task` and list responses never copy journal content.

An absent journal on an old task does not mean absent management memory. Recovery must read the existing legacy source; a legacy checkpoint may be the only one. Mixed-source reconstruction documents the transition and any ordering ambiguity. A conflicting legacy edit or uncertain source coverage stops decisions that depend on precedence. This policy avoids a destructive migration while retaining all old notes, including Task B's existing QC-5 addendum.

## 7. MCP/client contract and data flow

### 7.1 Compatibility envelope

Keep the existing strict `{task_id,note}` append input and non-idempotent write annotation. Preserve trimmed text and the 32,000 UTF-16-codeunit cap, additionally reject a JSON-serialized note above 40 KiB before commit. The append output retains normal task fields with additive `{management_note:{entry_id,sequence,generation,head_sequence}}`; preflight includes that receipt in the existing 40,000-byte task-output limit. Do not loosen strict schemas globally. A normal task response never copies journal entries into Description, comments or links.

There is an unavoidable visible change: clients that verify a new note only through `get_project_task.description`, or expect the Taskboard UI to show it in Description, must use the new explicit history read. Document this instead of claiming perfect compatibility or dual-writing new notes into both stores. No general Board UI redesign is part of this foundation.

The implemented minimum read surface is `get_task_management_history`, registered and dispatched with strict schemas and read-only/idempotent hints. It accepts mode `recent` (default), `after`, `after_checkpoint`, or `latest_checkpoint`; `limit` 1–50; optional cursor only for after modes; and legacy UTF-8 `offset`, `revision`, `max_bytes` (≤8,192). It reports journal state/consistency, current and captured heads, entry count, newest checkpoint locator, complete entries, `has_more`/cursor, and a raw revision-bound legacy Description page. Tool diagnostics log metadata only, never note text or cursor contents. Unknown/partial/corrupt ranges return explicit errors rather than empty success.

### 7.2 Manager flow on top of the journal

`read exact Board task/order → read latest checkpoint plus newer management entries/legacy coverage → cheap lifecycle gate → if ACTIVE, obtain necessary older fingerprint history and live exact task/session/result/owner evidence → one bounded r27 management action → exact receipt/result readback → append at most one compact journal checkpoint → verify journal receipt/readback`.

Preserve the current rules:

- `ACTIVE`, `PARKED_INPUT_REQUIRED`, `COMPLETE_PASS`, `STOPPED` are unchanged.
- Parked/terminal without trusted new authority performs a cheap no-op, no deep worker scan, no dispatch and no checkpoint append.
- A running/uncertain worker is not a reason to create a second send or advance a Wave.
- Two same/practically-equivalent no-progress repairs, including reserved/interrupted attempts and A→B→A recurrence, remain the cap; storage restart cannot reset counters.
- Prompt delivery uncertainty and journal publication uncertainty are independent; reconcile both exact attempts. If a worker action may have happened before checkpoint failure, retrieve its exact action/message/result instead of repeating it.
- Journal sequence, text marker, `OPERATOR-DIRECTIVE` label and existing `operator_authorized:true` client attestation do not authenticate a human. Scheduled trusted-resume provenance remains Task B/QC-5; unauthenticated stored instructions remain fail-closed.
- Storage persistence failure cannot be reported as a durably saved park. Stop dependent mutation locally, report the actual gap in the original result, preserve action evidence, and reconcile on the next authorized continuation.

## 8. Boundaries, failure cases and alternatives

| Condition | Required behavior |
|---|---|
| Journal/head absent before first append | Return explicit absent/legacy coverage without creating files. |
| Unknown task, foreign project/identity, unresolved transfer | Reject before journal publication; preserve all existing artifacts. |
| Permission/disk/open/write/sync/rename failure | Explicit error with known-versus-uncertain commit state; no fallback Description append, no blind retry. |
| Invalid JSON/UTF-8/schema, partial line, gap/duplicate sequence, inconsistent head | No empty/partial-success fiction; preserve bytes, block dependent actions and reconcile/escalate. |
| Concurrent cooperating append/read/reclassification | One ordered append stream; stable task identity; reads see a documented captured prefix or explicit change/error. |
| Oversized output/record or incomplete required history | Bounded continuation or explicit limit/error; never drop history silently or infer absence. |
| Valid checkpoint followed by ordinary/new directive notes | Surface later sequence/coverage; latest-checkpoint shortcut cannot hide those notes. |
| Failed checkpoint after worker admission | Preserve/reconcile exact worker receipt and action key; no duplicate dispatch. |

Alternatives:

- **Keep Description appends and enlarge limits:** rejected; merely delays growth, repeats history on normal reads and leaves upstream/serialization ceilings coupled.
- **Put all notes in the existing task metadata JSON:** rejected as primary log; rewrites/loads a growing shared document and shifts the same long-history problem to another normal path.
- **Rewrite/prune legacy Description or compact away journal records:** rejected; destructive migration/history loss is neither required nor authorized.
- **Dual-write Description and journal:** rejected; retains Description growth and adds cross-store uncertainty.
- **Scan the whole journal on every latest/tail read:** rejected as normal path; does not meet read-efficiency acceptance. Bounded seek/tail plus derived head is the preferred small design.
- **A new database service, scheduler engine, ownership lease or authenticated operator-role system:** outside this storage task. The current persistent directory and cooperating-writer lock are enough for the stated foundation.

## 9. Implementation and integration record

Task A was implemented in isolated worktree `/Users/admin/Documents/github/opencode-vm/.opencode-vm/worktrees/task_a73131d9-b3c3-57e2-b1aa-582204f248e0`, branch `task/a73131d9-management-journal`, from base `8c3b1d66652653b287e56652c4fef197e038ef3b`. Its local implementation commit is `9d486431a16b6d9d329a6113a7d11fc281c16192`. Current main already contained Disk-Resize commit `e6acbb97adb530caf73163f7ae2b010a81e6e54d`; only Task A's source/documentation delta was applied and reconciled, yielding integration commit `62869f68fc2ccbea302d34c2bd39900dbc813090`.

Implemented surfaces include `adapters/mcp/src/management-journal.ts`, `taskboard.ts`, `tools.ts`, `types.ts`, `diagnostics.ts`; unit/wire/process tests; the production-only archive allowlist; `docs/MCP-INTERFACE.md`; Taskboard/README/AGENTS guidance; the companion r28 skill, scenarios and reproducible ZIP/SHA/latest; and adapter/script version pins. No Taskboard schema, Board behavior, scheduler, authentication, Operator Override/Resume authority, or release was added.

The integrated main candidate is script 0.7.2 / adapter 0.1.22 / skill r28. The MCP archive is reproducible at SHA-256 `bdd7c8b1ee97f425869ec181d8749df65d7cc6057011acbf163e52aa2de57cb6`. This is local archive/pin evidence, not a published release. The Disk-Resize commit and Task A both changed `opencode-vm.sh`; the integration reconciled their script-version/tag changes to 0.7.2 and retained the Disk-Resize implementation. Do not take the isolated worktree's implementation-delta copy or unrelated ignored/untracked artifacts into main.

## 10. Test and acceptance concept

Meaningful tests must demonstrate the storage/manager invariants, not merely echo implementation text:

| Test group | Essential cases / observable assertions |
|---|---|
| Lazy/identity | Read-only absence, invalid/unknown task no artifact, first valid note, non-master task, deterministic paths for different IDs, incompatible/foreign identity rejection. |
| Persistence | Repeated notes (including identical bodies), fresh service/process restart, preserved generation/order/text, no native PUT or Description change for new writes. |
| Bounded reading | Empty/small complete history, last N, cursor continuation without gaps/duplicates, latest checkpoint with newer non-checkpoint notes, captured-head concurrent append, wrong task/generation/offset rejection, large note readability, escaped/multibyte payload bounds. |
| Long run | At least 48 simulated hourly checkpoints over two logical days and a much longer fixture; normal task JSON unchanged by history growth; instrument latest/tail bytes/work so a full-file scan cannot accidentally pass as efficient. No two-day sleep is required for the deterministic test. |
| Legacy | Byte-identical old Description notes, legacy-only/mixed sources, absent/ambiguous timestamp/marker, paged legacy revision change, near-native/output-limit tasks with no new Description growth. |
| Concurrency | Separate cooperating processes append to the same task; complete unique ordered records, no lost append; append/read and transfer boundary; locking failure yields explicit error. |
| Faults | Failure before write, partial write, after canonical fsync, during head/initial publication, permission/disk faults, malformed JSON/UTF-8/schema/head, replacement/truncation; no deletion/reset/fallback or false success. Recoverable complete suffix reconciles once, never double-appends. |
| Manager | Fresh-context order/checkpoint/newer-note recovery, required older fingerprint history outside tail, parked/no-op no write, interrupted post-send checkpoint and lost append response reconcile without duplicate worker/note. No provenance promotion. |

### Executed verification on integrated `main`

- In `adapters/mcp`: `npm run check` **PASS**; `npm test` **106 pass / 0 fail / 2 existing opt-in pinned-upstream tests skipped**. The Taskboard integration harness was syntax-checked but its live binary-backed run was unavailable because `OCVM_TASKBOARD_BIN` and the pinned Taskboard binary are absent.
- Journal fixtures: 64 ~16-KiB hourly checkpoint entries (>1 MiB); normal task response remains equal before/after; latest lookup byte-read assertion <64 KiB; recent history ≤1.1 MiB; full `after` cursor walk reconstructs all 64 at its captured head despite a later append; legacy Description page/revision remains readable. Four actual child Node processes each appended eight unique notes (32 contiguous sequences).
- Faults: injected post-log/pre-head uncertainty returned `TASK_MANAGEMENT_JOURNAL_UNCERTAIN`; history reconciled the complete suffix, a subsequent append did not duplicate. Corrupt head, partial suffix, unsafe journal-directory symlink and unsafe cooperating-lock symlink failed closed without rewriting canonical data or the symlink target.
- `bash tests/mcp_adapter_test.sh` **PASS**, including deterministic production-only archive/pin check and standalone cache/lifecycle. `python3 -B tests/release_metadata_test.py`: **5 PASS**. `bash tests/vm_config_test.sh`: **PASS**, rechecking the concurrent Disk-Resize change in the same script.
- Companion package: `python3 scripts/build-chatgpt-skill.py --check` **PASS**; `python3 -B tests/chatgpt_skill_test.py` **24 PASS**. `node --check adapters/mcp/tests/taskboard-integration.mjs`, `bash -n`, ShellCheck and `git diff --check` **PASS**.
- No real hosted Work/Scheduler, connector restart, two-day wall-clock monitor, deployment or operator acceptance is claimed. The local v0.7.2 candidate remains unreleased. Other required release blockers are the separate host/security dispatch investigation `task_ce242aa5-b674-5c39-b722-aa69228d3b06` and scheduled Work/Worker/operator-reporting follow-up `task_1bb4d21a-364c-5b28-88e5-4f503071e387`; the latter requires its own concept round before implementation.

Task B may use this integrated commit and evidence for its QC-3 and cross-surface checks; the local source/archive suite does not by itself satisfy hosted acceptance or QC-5 provenance.

## 11. Decisions, open questions and maintenance

Settled and integrated (2026-10-02): Board/task ownership, lazy per-task journal outcome, no new Description growth, explicit bounded history/checkpoint reads, non-destructive legacy compatibility, non-idempotent/no-blind-retry behavior and fixed A→B order. The JSONL/derived-head/cursor contract in §§6–7 is the implementation on integrated `main`, not merely a proposal. The local code, deterministic package checks and process/fault fixtures are verified as listed in §10; hosted connector/scheduler authority and runtime acceptance remain external and unclaimed.

No missing business choice blocks preparation. Before implementation finalizes code, verify record/page limits and crash/head reconciliation against the test matrix. If that exposes an actual out-of-scope product/architecture/schema/security decision, pause dependent work with terminal `INPUT_REQUIRED` naming context/options/completed/paused work. Do not invent a trust policy to solve deferred QC-5, and do not create a duplicate follow-up.

C remains one file: target ~5k tokens, warning ~7.5k, condense before ~10k. Main P targets ~20k, warns ~30k, splits by ~40k into task-ID-named detail docs while remaining canonical for outcome, decisions, current implementation/test plan and detail links. These are working budgets, not mandatory minimum lengths. Update C after substantial work; update this P/`Last-concept-update` on substantive conceptual findings. Keep histories in original evidence/journal, not copied into C/P.
