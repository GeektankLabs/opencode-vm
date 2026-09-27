# Expert decision-preparation template

Use this template when the user requests enough evidence to decide several remaining topics. Adapt labels and language to the user; include the full pattern for every independent topic, not just once at the top.

## Before submission

Read the relevant original result including closing questions. Compare it with the latest conversation decisions. Classify each remaining item as:

- A real user/product choice.
- A fact the expert can resolve from code, plans or prior evidence.
- A live verification needing an explicitly authorized target.
- Implementation work already agreed in principle.
- Deferred/out-of-scope work.

A code/foreign-key inventory is normally expert work, not a question asking the user to invent database facts. A hypothetical missing historical case is not an observed production record. A planned gate is not automatically a demonstrated blocker.

## Delegation body

### Objective and scope

Prepare decision-ready findings for [named topics] in [identified project/session]. Use current code, contracts, authoritative plans and existing evidence. Do not implement features or run tests. Do not edit files unless the user has separately requested planning/documentation changes.

List the already agreed decisions and remaining assumptions. Do not reopen settled choices without a concrete contradiction, missing prerequisite or operational counterexample.

For live checks, specify [authorized environment and permitted non-mutating reads]. If no live target is authorized, report the required inventory steps without performing them. Do not disclose secrets, payloads or personal data in the report.

### Required format for EACH topic

1. **Architecture and purpose:** Name the system/component, its role, upstream/downstream boundaries and anything explicitly unaffected. Explain abbreviations and issue IDs.
2. **Operational example:** Describe an actor's action, the processing sequence and visible outcome. Mark invented numbers and scenarios as illustrations.
3. **Current evidence:** Separate documented intent, implemented code, deployed configuration and actual test/live evidence. Supply precise source locations and confidence limits.
4. **Options and recommendation:** Offer the smallest sufficient approach, material tradeoffs, dependencies and why it serves the agreed goal. Identify whether the item affects initial setup, release acceptance or later improvements.
5. **Decision owner and remaining question:** Resolve technical facts yourself where authorized. Ask the user only for genuine choices. If a decision is already made, state its implementation consequence instead of asking again.

### Cross-topic check

Identify relevant contradictions between the updated concept and existing plans, code or contracts. State which earlier statement is superseded, which remains technically unimplemented and whether an unresolved issue truly prevents the agreed next step.

Finish with a compact matrix:

`Topic | confirmed fact | user decision needed | technical check/work | recommendation | dependency`

End with only real unanswered questions. If none remain, state that no user decisions remain; do not imply implementation or acceptance is complete.

## Optional documentation/planning extension

Include this only when requested:

Update the existing authoritative concept, plan and playbook files with the agreed decisions. A dedicated implementation plan may be created if linked from those files. Avoid duplicate sources of truth. Preserve unrelated changes and check cross-references for contradictions.

For each work package specify component/file/contract scope, prerequisites, order, acceptance criteria, test plan, risks and remaining decisions. Keep product implementation, deployments and test execution out of scope unless separately authorized. Report changes and performed checks; do not imply a commit/push or acceptance evidence that does not exist.

## Carry decisions across session switches

Record the latest agreed rule in the working registry, task/report IDs, what is still unproven and the exact next action. Keep pending research and prepared-but-unsent follow-ups distinct. Revisit evidence before describing an old recommendation as a current decision.

## Authorized work package and approvals

Reuse the user's stated environment, outcome and permitted changes. State meaningful exclusions once in the delegated task; do not require a new conversational approval for each ordinary step in that scope. Keep backend-mandated approvals separate. Do not convert an operator-only action into automation merely to obtain more checkable evidence. Do not create a new checkpoint/attestation architecture unless actually requested or a demonstrated technical need is accepted.
