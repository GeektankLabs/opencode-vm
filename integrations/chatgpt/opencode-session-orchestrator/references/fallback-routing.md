# Error-fallback routing and context recovery

Route a **confirmed** runtime failure of an authorized worker step through the project's Agent Control policy. This is management-layer routing on existing discovered tools (status/result reads, runtime update, `send_message`): no daemon, no new platform, no scheduler, no quota platform and no specific local-model-server prerequisite. Keep this **error fallback** strictly separate from the profile-resolution `fallbacks` map (design/review resolution), which stays unchanged.

## Evidence-bound error classes

Classify only from the actually exposed terminal evidence after native retries completed (the final assistant/error message with its safe error-detail projection). Never infer from busy state, empty text or episode context, and never invent a provider-wide failure cause.

1. **Timeout** — a confirmed provider timeout class (e.g. `provider_header_timeout` / `provider_timeout`). A timeout is not proof of a provider-wide outage; provider skip is conservative routing, not a causal claim.
2. **Quota/budget exhaustion** — an explicit exhaustion class (e.g. `provider_quota`). A plain rate limit is **not** proven exhaustion and does not trigger routing by itself; any other invalid-request error never triggers it.
3. **Context/input length** — the exact structured input-length rejection (e.g. `context_input_length` carrying the provider-reported allowed range). The reported cap is provider metadata, not a measured input length. All other invalid-request errors are not this class.

Effective provider/quota identity = provider ID plus the credential/account-scoped quota identity as far as actually provable from the error and the configured IDs — without secrets or raw dumps. When the identity stays unknown, construct no provider-wide causal or skip claim; the candidate is simply not attempted again.

## Routing on timeout/quota (classes 1–2)

- Read the project policy through the discovered policy read. The additive final-fallback slot (`final_fallback` with mode `total` — the default — or `degrading`, plus its availability status) is the configured last resort. **Unconfigured final fallback means no automatic provider/model choice of any kind: report a precise `INPUT_REQUIRED`.**
- **Total (standard):** from any regularly chosen starting profile — explicitly including Design and Review — switch directly to the configured final fallback, then exactly one correlated aligned continuation (§ Recovery prompt) in the same session at the last secured state. No intermediate stage, no own retry counters, no backoff/budget layer; native backend retries stay untouched.
- **Degrading (selectable option):** finite chains with role entry points — Deep → Standard → Execution → Fallback; Design → Standard → Execution → Fallback; Review → Deep → Standard → Execution → Fallback. Start at the actually affected profile; a special profile already resolved to a regular one enters the remaining chain without retrying failed stages. Skip missing regular profiles and candidates whose effective provider/quota identity already failed; never retry the same runtime; no upward switches and no loops — the fallback stays the last attempt.
- **Role truth:** technical profiles never change the business role. Design requirements stay design requirements; a reviewer stays independent (no self-implementation, no self-acceptance).
- If the final fallback's identity equals an already failed identity, that is a configuration finding: report it as `INPUT_REQUIRED` instead of a pretended attempt.
- **Per-step return:** the fallback applies only to the concrete failed step. After its completion, the next separately started order resolves its regular profile (provider/model/thinking stage) fresh from the current policy, sets it and verifies exact readback (model-switch evidence). No blanket reset, no permanent profile change, no switch-back during a running fallback step. If the fresh regular attempt fails again on class 1/2, route to the fallback again; if that fails too → `INPUT_REQUIRED`.

## Context-error recovery (class 3, separate)

- After the request completed and the class-3 finding is confirmed, rely on the installed backend's **native compaction**; verify the behavior against the actually installed version and claim no unsupported compaction capability without evidence. Do not build a second general compaction mechanism, and do not immediately resubmit the same rejected request.
- Then exactly one correlated, aligned continuation of the same work step in the **previous regular profile including its thinking stage** — applying to the actually active runtime (including a fallback runtime), not jumping back to the originally failed profile.
- Success requires evidence: an observable compaction/summary effect and a completed continuation (effective shortening proven by outcome). A compaction or continuation error, or a repeated context failure, yields a documented `INPUT_REQUIRED` — no infinite compaction/retry loop and no additional counters.
- Task identity, secured state, worktree and ownership are preserved; no double execution and no parallel compaction/continuation.

## Alignment/recovery prompt (mandatory)

Every automatic resumption (after a runtime switch **or** compaction) carries one short explicit re-initialization prompt: exact task ID, package/synthesis revision when present, and the canonical compact-context/concept-plan paths; instruct to read the current C first, then the relevant P sections and needed originals; adopt order/decisions/scope/security limits, actual worktree/owner/base/HEAD and existing receipts/results; continue at the last secured state; clarify uncertain earlier side effects against evidence instead of repeating them blindly. No new task/session, no task/repair-budget reset; keep C/P current; read large plan files targeted (ranges). If the failure may have prevented the latest task-document maintenance, reconcile the documented state against Git/receipts/originals — never assume C/P freshness.

## INPUT_REQUIRED contract

On fallback/compaction/repeated failure, document durably: the original error (redacted class + structured core data), the original profile/provider/model/thinking stage, the fallback runtime used, the concrete fallback/compaction error, correlated message/evidence references, the last secured state and the required operator decision. No secrets, no raw responses. No further automatic continuation afterwards.
