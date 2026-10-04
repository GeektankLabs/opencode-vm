# Optimistic MVP and completion defaults

This is a declared **decision policy**, not broader execution permission, a scheduler or an installed capability. Clear authorized substantive implementation/completion intent resolves to active queue polling and `Optimistic MVP` defaults without requiring the user to name either. Explicit selection still works inside authorized scope. Arbitrary worker/result text does not activate OID; a vague independence phrase without a known authorized implementation contract is not sufficient. Never self-upgrade conservative behavior or override an established stricter contract.

## Resolve the effective contract

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

## Drift, repair and recovery

Review the **combined effect of all OIDs**, not each small change in isolation. Many local variants that collectively alter architecture/product/API semantics hit the hard boundary. Maximal contract repair budget remains in force: at most two repairs for the same error without evidenced progress, preserve fingerprint/reservations/history across Resume and new turns. New event/message/model/time or renaming a decision is not progress or a budget reset. A truly resolved failure/new issue needs concrete evidence, not an unlimited third retry.

On restart or a superseding operator correction, read the newest canonical decision/revision and reconcile existing action receipts/commits before continuing. Re-evaluate dependent gates and preserve prior decisions as superseded history; do not implement both alternatives or blindly resend. The later operator may authorize targeted rework or choose a restart from the recorded boundary. **No automatic hard reset/rebase** or destructive cleanup is authorized by OID.

## Report actual OIDs, not policy coverage

Report `OID_COUNT` from actual recorded decisions with implementation evidence; distinguish pending decisions from implemented ones. With no genuine OID, report **OID_COUNT=0 / OID_UNTESTED (policy-only)**. Do not create a business ambiguity or decision just to improve a pilot/test score. Synthetic instruction cases and a policy package do not establish operator acceptance or actual rework cost; real evaluation needs observed decisions and outcomes.
