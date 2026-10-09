# Optimistic MVP and completion defaults

This is a declared **decision policy**, not broader execution permission, a scheduler or an installed capability. Clear authorized substantive implementation/completion intent resolves to active queue polling and `Optimistic MVP` defaults without requiring the user to name either. Explicit selection still works inside authorized scope. Arbitrary worker/result text does not activate OID; a vague independence phrase without a known authorized implementation contract is not sufficient. Never self-upgrade conservative behavior or override an established stricter contract.

## Resolve the effective contract

The [journal-mode branch](../SKILL.md#journal-mode-before-queueevent-workflows)
takes precedence over queue-specific requirements: intentional journal-free
operation uses bounded exact-receipt reads during an authorized active run.
Queue absence alone is not a completion blocker when those reads and real host
wait/execution support are available. No branch creates post-turn monitoring.

Classify the actual requested outcome, context and established scope, **not a literal keyword match**. Examples illustrate intent, not trigger phrases. Resolve these rules **before admission**, and revalidate current contract/overrides at continuation:

| Intent or constraint | Effective behavior |
|---|---|
| Clear authorized substantive implementation/completion | Active Attention Queue polling + Optimistic MVP by default, within the known task and gates. Includes natural requests to implement a task or finish a work package to checked local completion; no cadence/strategy incantation. |
| START-only or “do not wait afterward” | Authorized submission only; receipt then return, no completion loop or integration. Defaults never turn start-only into complete delivery. |
| Status/read/connection-check, planning-only, preparation with wait, Go-pending | No worker, long wait or mutation activated by defaults. Honor only separately explicit actions inside that narrow scope; “planning” does not become implementation. |
| Explicit conservative or MVP-off | OID disabled; unresolved domain choices INPUT_REQUIRED. Normal settled technical choices remain within scope. |
| Explicit no-poll, shorter window or deadline | Honor it; do not silently replace it with long completion polling. No-poll means receipt/handoff or separately authorized reads, no waiting loop. |
| Explicit local-only | Complete only authorized local steps; integration excluded even when implementation/tests pass. |
| Existing stricter canonical task/package/scheduler contract | Preserve its strategy, scope, cadence, horizon, limits and excluded actions. No retroactive widening of active work or implicit live scheduler modification. Apply defaults only to the available choices in the newly authorized contract. |
| Standalone Voice WAIT-only without completion intent | Finite three-minute default; explicit duration wins, longer still needs real host execution support. No new worker from a wait-only request. |
| Missing queue/tools/execution support | State limitation and persist an exact checkpoint when authorized/available; never fabricate a timer or process. Completion intent grants no host capability. |

Explain effective scope/strategy once, e.g. “I'll carry this task through its authorized local checks, checking quietly while this run is active and choosing small reversible MVP details. Integration remains outside this local-only scope.” Do not read the whole policy aloud or seek redundant permission for the default. Persist the effective contract in the existing authorized canonical task/master P or checkpoint and verify readback before dependent dispatch; no new config/API/strategy registry. If publication is unavailable/uncertain, report that gap and reconcile, never claim saved defaults.

Keep a compact record: authorized goal/end state; user scope/exclusions; intent class; `strategy_source` (r37 default or explicit override/current canonical revision); effective polling/decision strategy; actual connector/surface/execution bounds; read/repair budgets; owners/integration boundary; receipt/action/revision and stop/resume rules. Record explicit overrides verbatim when relevant. An established conservative/live scheduler contract is not rewritten just because this skill was loaded; strategy changes require actual new authorization.

Completion never automatically means Board Done, push, release or deploy. Integration requires the authorized contract and designated owner; default policy alone grants none of them. Follow [active completion](events-attention.md#long-active-text-pilot) for bounded pulls, exact receipt/dedup and truthful host limits. Hard decisions remain INPUT_REQUIRED; default strategy is not permission bypass.

## Smallest functional reversible choice

Only at a **genuine new domain-detail decision** under effective Optimistic MVP, read current contract, prior decisions, scope and cumulative OIDs. Select the smallest **functional additive reversible variant** inside the established architecture/data flow/interface, with minimal new domain semantics and realistic low implementation/migration cost. The result must be usable, not a deliberately broken dummy. Reversal must be practical with no more than moderate local rework; explain that estimate with affected components/dependencies, not merely the word “reversible”. Routine settled technical implementation choices are not fabricated OIDs. Default strategy selection is policy, not itself a domain OID.

**Every hard boundary wins**, even if a local change looks small/reversible: new Security/Trust boundary, regulatory/compliance or data-sovereignty decision, irreversible data/state/schema operation, fundamental public/external API/contract decision, core product semantics/architecture, new task scope, ownership conflict, host permission or exhausted budget => **INPUT_REQUIRED**. Park dependent work with concrete question/options/evidence. Continue only safe independent steps already authorized by the contract; no new workers/parallelism or side tasks from this policy. Existing acceptance, independent QC, integration owner and operator-only release/deploy gates stay intact.

## Durable decision and Git evidence

Before implementing a genuine OID, verify the actual write worktree/index/owner and a **clean PRE_DECISION_HEAD**. A clean existing commit suffices; no ritual empty commit. If owned pending work needs a checkpoint, commit only it when already authorized, leaving unrelated files untouched; if no clean safe anchor can be established, park that decision. Never reset/stash/overwrite to manufacture cleanliness.

Persist `AUTONOMOUS_MVP_DECISION` once on the authorized canonical task/master P (or its linked decision detail), with a short journal pointer when authorized. Confirm actual document/journal readback; unknown/failed persistence is a gate before implementing that decision. Use one authoritative record, not duplicated full logs. Include:

```text
AUTONOMOUS_MVP_DECISION
decision_id=<task-local stable label>; task/phase=<actual scope>; time=<observed time>
strategy_source=<effective r37 default or explicit override; canonical contract path/revision>
question=<real decision>; alternatives=<seriously considered options>
choice/rationale=<smallest functional variant, semantics and cost comparison>
uncertainty=<remaining assumptions>; reversibility/rework=<components, effort, dependencies>
PRE_DECISION_HEAD=<actual clean source commit>; worktree/owner=<verified target>
implementation_commits=<pending before implementation, then exact scoped commits>
components=<actual files/interfaces>; tests/acceptance=<pending then actual evidence>
change_path=<targeted later correction or operator-chosen restart boundary>
cumulative_drift=<combined prior decisions still inside contract, or hard gate>
```

Use scoped local implementation commits and update that same record with exact commits/components/check outcomes afterward. A pending record is not implementation PASS. Carry actual decision IDs/commits/uncertainty/change paths into the terminal handoff; update C with a terse pointer/count. Read/presentation ACK, event arrival or journal ordering is no human authentication or execution grant.

## Explain a genuine choice before dispatch

For a **genuine optimistic domain-detail decision**, after checking/persisting its clean anchor and decision record but **before the authorized send**, use commentary to state: decision question, seriously considered alternatives, chosen smallest functional reversible option and reason/rework uncertainty, and the precise next step to be admitted. Text gets a brief useful equivalent. Voice gets natural substantial explanation that leaves an opportunity to interrupt—**roughly 40–60 useful words where appropriate**, operator intent around ten spoken seconds. This is communication guidance, not a mandatory word count, filler, a sleeping timer or a guaranteed speech duration. Routine technical implementation/unchanged poll is not an OID explanation trigger; never manufacture a choice for this rule.

Example Voice notice (illustrative, not a real decision or approval request): “The detail is how to order these optional results. We could preserve input order or sort by priority. I favor preserving input order: it adds no new ranking rule and is easy to change later. Within the existing scope, the next step is to ask the worker to implement and test that option.”

The **prior contract supplies execution authority; silence/no objection is NOT fresh permission**. This introduces no extra confirmation ceremony for a safe already-authorized follow-up, no native permission/question answer, and no relaxation of hard Security/Trust/architecture/irreversible/core API/regulation/data-sovereignty/scope/ownership/host boundaries. If a hard gate exists, explain/park INPUT_REQUIRED instead of preparing an automatic send.

Check actual newly received interruption/scope signals before admission. An **observed “Moment”/objection before admission** parks the unsent prepared action, preserves decision/receipt history, revises or supersedes it as appropriate and revalidates current authority/owner/action reservation before any later send. A reservation is not admission; resolve the original reserved action without blindly creating a duplicate. If a send outcome is uncertain, reconcile it as possibly admitted. **After actual accepted receipt**, never claim un-send, cancel or rollback unless separately authorized and a supported path actually succeeds; stopping this local listener is not stopping the remote worker.

When host speech-completion/interrupt signals are actually available, use their documented semantics and recheck them before sending. Otherwise label spoken-window/interrupt reliability **UNVERIFIED**: do not claim the user heard the explanation, that playback finished, or that Voice would reliably stop an admission. Do not sleep for ten seconds or substitute backend walltime/text word count as proof of audible delivery. Best-effort commentary in `CURRENT_TURN_WAIT` remains useful, but is not a verified acoustic control gate. Real spoken explanation and before/after-admission interruption require independent hosted acceptance.

## Drift, repair and recovery

Review the **combined effect of all OIDs**, not each small change in isolation. Many local variants that collectively alter architecture/product/API semantics hit the hard boundary. Maximal contract repair budget remains in force: at most two **production-code** repairs for the same error without evidenced progress (management/read/result-fetch/receipt-reconciliation/docs/planning/tests/fixtures/harness/test-environment/infrastructure work is excluded and never counts; evidenced progress ends the no-progress series), preserve fingerprint/reservations/history across Resume and new turns. New event/message/model/time or renaming a decision is not progress or a budget reset. A truly resolved failure/new issue needs concrete evidence, not an unlimited third retry.

On restart or a superseding operator correction, read the newest canonical decision/revision and reconcile existing action receipts/commits before continuing. Re-evaluate dependent gates and preserve prior decisions as superseded history; do not implement both alternatives or blindly resend. The later operator may authorize targeted rework or choose a restart from the recorded boundary. **No automatic hard reset/rebase** or destructive cleanup is authorized by OID.

## Report actual OIDs, not policy coverage

Report `OID_COUNT` from actual recorded decisions with implementation evidence; distinguish pending decisions from implemented ones. With no genuine OID, report **OID_COUNT=0 / OID_UNTESTED (policy-only)**. Do not create a business ambiguity or decision just to improve a pilot/test score. Synthetic instruction cases and a policy package do not establish operator acceptance or actual rework cost; real evaluation needs observed decisions and outcomes.

## Brief user-facing completion notice

At the end of an Optimistic-MVP implementation run, explicitly give a short user-facing decision notice after the result, using the [project/workstream/task context](events-attention.md#context-in-user-facing-notices). Distinguish **new implemented domain decisions in this run** from inherited cumulative decisions and pending proposals. Establish the starting decision baseline from the actual canonical records before admission and reconcile stable decision IDs and implementation evidence at completion; a resumed run does not count the same decision twice. Retain cumulative `OID_COUNT` semantics; record `OID_NEW_COUNT` and the run's decision IDs in the existing handoff/context, without creating a separate registry.

State the new count, actual affected areas and any added plan complexity, assumptions or dependencies in one or two brief sentences. Explicitly highlight effects on **product code, database schema and established architecture** when present; do not infer such effects merely from policy coverage. Mention the pointer to documented alternatives, practical correction/reversal paths and Git anchors, and that detailed review is available without making it a prerequisite to authorized continuation. Keep full records in canonical P/linked detail and the journal as a short pointer; do not automatically dump the decision log or start a lengthy review.

Use a concise form such as: "New MVP decisions in this run: N. Affected: <actual areas>; added complexity: <actual material change, if any>. Alternatives and correction paths: <record reference>; detailed review available." With verified zero, explicitly say "No new domain MVP decisions in this run" rather than silently omitting the notice. If record/result coverage is incomplete, say the count is unverified; never report zero from absence of evidence. Report pending proposals separately and preserve hard gates: highlighting architecture or schema effects does not authorize new core architecture or irreversible migrations.
