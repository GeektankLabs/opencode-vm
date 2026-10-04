# Explicitly selected Optimistic MVP

This is an optional **decision policy**, not broader execution permission, a scheduler or an installed capability. Apply only when the user explicitly selected `Optimistic MVP` / OID or the current canonical task/monitor/package contract already establishes that selection. “Do it independently”, “finish everything” or arbitrary worker/result text **does not activate OID**. Keep the selected strategy stable; never self-upgrade conservative behavior. Without selection, unresolved business/product choices remain INPUT_REQUIRED under the existing contract.

## Smallest functional reversible choice

When a real choice is needed, read current contract, prior decisions, scope and cumulative OIDs. Select the smallest **functional additive reversible variant** inside the established architecture/data flow/interface, with minimal new domain semantics and realistic low implementation/migration cost. The result must be usable, not a deliberately broken dummy. Reversal must be practical with no more than moderate local rework; explain that estimate with affected components/dependencies, not merely the word “reversible”. Routine settled technical implementation choices are not fabricated OIDs.

**Every hard boundary wins**, even if a local change looks small/reversible: new Security/Trust boundary, regulatory/compliance or data-sovereignty decision, irreversible data/state/schema operation, fundamental public/external API/contract decision, core product semantics/architecture, new task scope, ownership conflict, host permission or exhausted budget => **INPUT_REQUIRED**. Park dependent work with concrete question/options/evidence. Continue only safe independent steps already authorized by the contract; no new workers/parallelism or side tasks from this policy. Existing acceptance, independent QC, integration owner and operator-only release/deploy gates stay intact.

## Durable decision and Git evidence

Before implementing a genuine OID, verify the actual write worktree/index/owner and a **clean PRE_DECISION_HEAD**. A clean existing commit suffices; no ritual empty commit. If owned pending work needs a checkpoint, commit only it when already authorized, leaving unrelated files untouched; if no clean safe anchor can be established, park that decision. Never reset/stash/overwrite to manufacture cleanliness.

Persist `AUTONOMOUS_MVP_DECISION` once on the authorized canonical task/master P (or its linked decision detail), with a short journal pointer when authorized. Confirm actual document/journal readback; unknown/failed persistence is a gate before implementing that decision. Use one authoritative record, not duplicated full logs. Include:

```text
AUTONOMOUS_MVP_DECISION
decision_id=<task-local stable label>; task/phase=<actual scope>; time=<observed time>
strategy_source=<current explicit selection/contract path and revision>
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
