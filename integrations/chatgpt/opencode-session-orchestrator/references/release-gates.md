# Repository Release Gates

Use this workflow when preparing or reviewing a release candidate, investigating release CI/publication, or advising maintenance while a release is not verified.

## Discover the target repository's policy

Read the target repository's own release policy by starting with its root agent/project instructions and following their release-policy references. If the repository provides no direct link, locate and read its designated release policy before advising release actions. When direct project-file reads are unavailable, include policy discovery and exact source readback in the authorized task before any repair or maintenance recommendation. Do not infer workflow names, hosting services, version formats, assets, commands or success criteria from another repository.

The target repository's current policy defines which run, jobs, release record and artifacts are expected. Use this reference for the generic management boundary; do not replace or expand the project's technical acceptance contract.

## Keep the candidate and publication distinct

- Record the exact local candidate commit and relevant local checks. A clean local build, local commit, branch name or successful handoff is not proof that a remote release exists.
- Pushes, tag writes, release publication/uploads and deployment stay with the authorized operator. Do not push, tag or publish for the operator, request credentials, or change permissions/boundaries to make the action possible.
- After an operator push, inspect the expected workflow/run and release evidence using an authorized read surface. Require the run's commit to equal the exact intended candidate, terminal success for all policy-required checks/publication steps, and the policy-required release/tag/artifact evidence for that same commit. A different newer green run, successful push receipt, matching version text or tag name alone is insufficient.
- A queued/running, failed, cancelled, inaccessible, missing, incomplete, contradictory or wrong-commit result leaves the gate red or unverified. Report the exact candidate, observed run/commit/status, missing evidence and remaining step; do not call the release complete.

## Repair without moving the gate

When a failed gate has actionable evidence, identify the failing job/step and propose the smallest repair. Implement and test only when that repair is already within the active task's scope. Preserve local and unrelated changes; do not redesign CI, publication, credentials or security boundaries as an improvised repair.

If a repair produces a new candidate commit, the old successful run cannot verify it. Record the new exact SHA, hand it to the operator for push, then repeat verification against a successful run and release evidence for that exact SHA. Do not infer operator action, blindly repeat a non-idempotent write, or claim an unobserved push/tag/publication.

## Preserve the working runtime while the gate is unresolved

While the expected release gate is red or unverified, preserve the working runtime and its recovery state. Do not recommend routine prune, stop, restart, reconnect/reattach, recreation, fresh start, install/update, or Ctrl+C followed by attach as release troubleshooting. Continue evidence gathering and authorized local repair without interrupting the working runtime when possible.

An interruption is exceptional: it is justified only when an explicitly authorized in-scope repair demonstrably requires that specific interruption. State the evidence, technical necessity, exact interruption and retained recovery state. A green gate permits a separate authorized maintenance decision; it does not automatically authorize cleanup, restart, deployment, task completion or acceptance.

Report local candidate/check results, operator publication (observed or reported), exact-commit CI/release verification and external acceptance separately. A packaging check or this instruction reference does not establish hosted skill behavior.
