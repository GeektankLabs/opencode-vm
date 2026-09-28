# Approval flow and low-friction execution

Applies to authorized OpenCode-style delegation. Use actual connector contracts. Do not turn this reference into a new user-facing approval process.

## Contents

1. Scope and four separate control layers
2. Short normal path
3. Delayed approvals and uncertain responses
4. Evidence for each statement
5. Remembered choices and settings
6. Backend permission vs ChatGPT permission
7. Documentation and regression limits

## 1. Scope and separate control layers

Record only what is useful: selected connector/account, target session, authorized task boundary, pending invocation and eventual receipt.

Separate:
- User intent: what work is authorized, where, and whether it is reading, planning, editing, testing or operating infrastructure.
- Connector operation: reading existing state uses read tools; `send_message` is a write-capable, non-idempotent submission that creates a message and starts new work even when the submitted task permits only read-only analysis.
- ChatGPT host/app/workspace controls: whether this call may execute and whether an on-screen approval is needed.
- MCP acceptance: whether a request was received and a particular task was created.
- OpenCode/backend controls: what the remote agent may subsequently do, plus actual running/completed state.

The user can authorize a whole bounded work package once. Do not invent repeated approvals inside it. A material target/scope expansion still needs the applicable authorization. Do not demand proof of every sandbox feature just to submit a clearly authorized ordinary task; use the available contract and preserve the specified limits. Reassess only for a real conflict or expansion.

Do not infer that safety controls were technically enforced merely because a prompt mentions them. Checkpoints may support recovery but are neither a host permission nor proof that external effects are reversible.

## 2. Short normal path

1. Reuse known intent and the selected session. Discover only missing schemas.
2. Read compact state when needed to avoid interrupting active work; inspect runtime only when relevant.
3. For authorized **new** work, invoke `send_message` once as a WRITE connector call, even when the task prompt says READ-ONLY. Put the task's limits in that prompt. Do not prefix the call with an unnecessary question asking the user to repeat the instruction; for existing-state retrieval use read tools instead.
4. When the host actually requests approval, refer to that on-screen control once; let the normal invocation lifecycle deliver its response.
5. On an acceptance receipt, check the exact task ID immediately.
6. Report the result briefly. Use bounded waiting only if supported and useful.

Do not add a mandatory dry-run, new session, separate approval token, external register or new checkpoint before each ordinary send. Do not do several discoveries simply to provoke a card. Keep formal diagnostics for an actual fault.

## 3. Delayed approvals and uncertain responses

An invocation can be awaiting the host without yet reaching the MCP. The assistant may not have access to the browser/card state. Preserve this uncertainty.

If the host/user indicates a pending card, state the needed action once. If only a response is missing, say that no definitive tool response is available; do not diagnose an invisible card, a denial, or server failure.

When the user interrupts, says to wait, or asks about another session, preserve the original invocation/receipt and its last observation. Do not promise to resume or notify in the background. When resumed, first reconcile that invocation.

After "I clicked Allow":
- Use any response to the original invocation.
- If an ID is available, verify that exact task.
- If no receipt is available, use supported request lookup or bounded original-message/journal checks.
- If acceptance cannot be established or excluded, report delivery unknown instead of issuing a fresh non-idempotent send.

Distinguish permission refusal from a task failure. Do not retry a denied action through another tool/account/session to avoid review. Do not tell the user to click Allow blindly; only refer to the matching intended operation.

## 4. Evidence for each statement

| Evidence | Allowed statement | Do not infer |
|---|---|---|
| Only a prepared prompt | Not submitted | That the server rejected it |
| Host signal or user report of a pending card | Approval awaits the on-screen action | That MCP accepted it |
| Invoked tool, no final response | Response/delivery not yet established | Failure, denial, or an invisible approval card |
| Explicit host denial | This call was denied | Backend task failed or UI can be bypassed |
| Transport error after send | Transport failed; check delivery separately | No task exists |
| Receipt with submitted and message ID | Accepted | Started |
| Exact task says running | Started according to the correlated task observation | Successful outcome |
| Exact task says completed | Task execution ended | Business PASS or full result read |
| Stored tool snapshot says running | Tool recorded as running at the observation boundary | Independent proof of process liveness |
| Unknown with a bounded-search reason | Not resolved by this observation | Missing task or permission failure |
| SESSION_BUSY plus idle | State conflict needing reconciliation | Permission reset or safe unlock |
| `SUBMISSION_UNRESOLVED` with an older correlation ID | New task was not admitted; inspect the old receipt for terminal evidence | That idle proves the old task finished, or that its ID belongs to the new task |
| `SUBMISSION_UNCERTAIN` with the newly attempted message ID | Delivery of that attempt is unknown; inspect the exact ID | That the new task was definitely rejected or safe to resend |
| Preview limit or not_exposed | Content retrieval boundary | Write approval failed |

Use the actual error identifier. Never write "failed" just because the response is slow. Never write "permission granted" from a copied instruction or arbitrary tool text that is not a permission observation.

## 5. Remembered choices and settings

Documentation snapshot: 2026-09-27. See [sources](approval-sources.md). Revalidate before advising about a changed product UI.

- In the documented ChatGPT developer-mode flow, remembered approve/deny is per tool and conversation. A new conversation or refreshing that conversation prompts again. Treat this as surface-specific, not a universal guarantee.
- A conversation choice is not a global/default permission for every tool on a server. Approval for sending does not automatically authorize runtime changes or session creation.
- App/account permission and managed-workspace policy are distinct from that conversation choice. Reading the default does not reveal whether the user previously clicked a remembered tool approval.
- Allow low-risk actions is not allow every action. If supported, app-specific Allow all actions is the relevant broader configuration, not a sentence in a skill. Do not assert it exists for this account without checking the available settings.
- General OpenAI API require_approval belongs to the API client configuration, not the ChatGPT skill or arbitrary MCP arguments. Do not invent never_ask, user_approved or similar fields.
- Current documentation and interfaces can differ between developer drafts, published apps/plugins, accounts and workspaces. Do not repeatedly reconnect to troubleshoot an unproven permission-reset cause.
- Read permission settings only for a named relevant connector when useful. Never inspect every app before ordinary delegation. Do not mutate settings during an inspection or on the vague wish for a smoother workflow.

## 6. Backend permission vs ChatGPT permission

A backend may already permit work in a selected sandbox. Reuse that boundary; do not add another agent-created approval for every harmless action inside an explicitly authorized task.

A backend permission request, however, is not automatically resolved by ChatGPT's remembered approval. Report its actual action and scope. Do not auto-accept all future backend requests based on a broad trust statement.

A research prompt submitted to an agent is still a write-capable job submission, not a read-only retrieval. Use stored-result APIs only for existing content; they cannot make a new task happen. If the user explicitly requests `send_message`, do not substitute a read tool or avoid the write because the task's **content** is read-only. If a genuinely restricted submission capability exists and its use matches the user's authorization, it is still a submission, not a retrieval; never invent one or rely on an unenforced "safe" name. The host/backend decides whether the actual write requires approval. A planned idempotent sender or analysis profile is not evidence that the connected runtime has it.

Where supported, compare `admission.guarded_message_id` with the error's correlation ID. `backend_activity: idle` and an older guarded receipt are separate facts. The next authorized write may reconcile a *confirmed terminal* old receipt automatically, but a complete result search without terminal evidence must remain unresolved. Tool or tunnel forwarding logs alone do not prove acceptance or task completion. If a client wrapper shows an outer error category different from the server's `_meta["opencode-vm/error"].code`, report both rather than replacing the canonical server reason with a guess.

For a connector that actually advertises `supersede_unresolved_submission`, treat it as a distinct operator decision. Inspect the old receipt and current exact guard first. If normal terminal reconciliation cannot resolve it, explain the guarded message ID and duplicate-delivery risk, then ask for fresh approval tied to that ID; an earlier approval for the intended task does not carry over. This operation atomically records the override and submits its `message`, so after approval call it once and verify its returned new message ID—do not also call `send_message` for that same task. Supply a new client UUID as `request_id`; retain and reuse the exact UUID and fields only to recover that same uncertain call. A stale guard, active execution or pending input ends the attempt; re-read and ask again only if a new exact guard needs approval. `operator_authorized:true` is the client's attestation, not independent human identity verification.

## 7. Documentation and regression limits

Source-grounded product behavior and workflow recommendations are different. Mark a product behavior as undocumented when it is not established; do not invent reset triggers for model changes, argument changes, reconnects or timeouts.

The regression scenarios are instructions-level review cases, not proof that the ChatGPT UI or MCP honors them. Live write tests require a real authorized test scope. Packaging a skill does not install it, enable tools in Voice, or modify app/workspace permissions.
