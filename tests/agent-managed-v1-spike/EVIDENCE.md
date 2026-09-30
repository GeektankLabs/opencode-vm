# V1 spike evidence and integration gates

Historical spike findings below remain unchanged. Product/security decisions and
current implementation/acceptance are canonical in the task plan §§17–18 and
`docs/MANAGED-SESSIONS.md`; the old external-G3 selection gate is superseded. No
prototype in this directory is shipped or a maintained test dependency.

Task-ID: `task_25b3af4f-e97f-5707-b523-13bcc99ed03c`
Recorded: 2026-09-30T00:39:59Z

## Result

**25 live/synthetic cases passed: OpenCode 1.18.33 V1 / Git 2.43.0.**
`completed:true`, `actual_remote_writes:0`, `fixture_refs_unchanged:true`.
Passing includes expected negative controls demonstrating security gaps.
Final full-run evidence: `/tmp/opencode/managed-v1-xald85fe`.

Successful checks:

```sh
python3 -B tests/agent-managed-v1-spike/probe.py
node --check tests/agent-managed-v1-spike/policy.mjs
node --check tests/agent-managed-v1-spike/plugin.mjs
shellcheck /tmp/opencode/managed-v1-xald85fe/bin/git-send-pack /tmp/opencode/managed-v1-xald85fe/bin/git-http-push
git diff --check
```

The main repository was not committed. Real commits are disposable: primary
commit changes exactly `local.txt`; separate empty commits verify prepared child
reuse and agent-Deny precedence. No tags/releases/real publishing were attempted.

## Actual runtime observations

| Probe | Observed result |
|---|---|
| Native direct Deny, no saved grant | Native tool error; no Git-canary execution. |
| Actual V1 `always` reply, later managed session Deny | New session reaches fake Git without Ask. Cache is instance-wide and wins over native Deny. |
| Forced model call to hidden `question` | Catalog lacks Question; runtime repairs call to `invalid`; no Question executor. This resolves the earlier source-only concern for this particular path. |
| `tools:{question:true}`, no plugin | Ruleset replaced; Question enters native pending without Permission pending; old Deny does not protect executor. Fixture rejection cleans up. |
| Guard with preexisting Always-Allow | `REMOTE_WRITE_DENIED` before fake Git; no Permission Ask. |
| Managed local Git | Actual status/diff/log/add/commit/cached-diff check; SHA changes; exactly `local.txt` committed; no input events. |
| 13 direct write forms | Push, dry-run, `-C`, `-c`, absolute **stub**, env, chain, tab, send-pack/http-push, helper **stubs**, LFS push string all denied before execution. No actual helper/transport/LFS acceptance. |
| Remote reads | Actual local bare-fixture ls-remote/fetch exit 0; refs unchanged. No external transport/user-origin probe. |
| Visible Question with guard | Tool error `INPUT_REQUIRED`; zero Asked/pending inputs; deterministic model emits normal final text with `finish:stop`; backend idle. |
| Business follow-up | Ordinary next turn on same ID; no native Question reply/permission answer needed. |
| Repeated Questions | Two attempts blocked in one turn; executor error does not itself stop the loop. |
| Manual regression | Native Question Asked/pending still available; commit asks and does not execute after synthetic rejection. |
| Independent restrictions | Native session commit/read Denies preserved; independent managed read Ask retained, no blanket approval. |
| Outbound instructions | Global AGENTS → root AGENTS → explicit instructions; nested AGENTS loaded after read. Managed primer present in managed/lineage child, absent in manual. Baseline shell sentence actually present; plugin changes model-visible definition conditionally. |
| Native new task child | Parent Denies inherited, metadata/local commit Allow absent; child commit asks. Parent-lineage primer resolves correctly. |
| Prepared reused child | Fixture operator appends local Allows preserving task/todo Denies; real commit executes without input on same child ID. |
| Reused child drift | PATCH appends Question Allow; task reuse does not refresh rules. Correct lineage guard still blocks executor. |
| Managed task reuses manual-lineage child | Child's parent stays manual; native Question reaches pending. Lineage-only guard misses adoption. |
| Agent Deny | Session commit Allow overrides explicit primary-agent commit Deny; disposable commit executes. |
| REST shell | `/session/{id}/shell` runs fake Git with zero tool-before calls; native tool rules and this guard bypassed. |
| Script/generic HTTP | Python subprocess reaches fake Git; curl POST reaches local synthetic sink. Zero real remote writes, but incomplete mediation proven. |
| Runtime restart | Same ID, metadata/rules persist; guard again blocks direct canary. Not a macOS/Lima reattach check. |
| Marker mutation | PATCH metadata replaces map/drops unrelated fields; marker 0 disables guard, fake Git executes under earlier broad tools replacement. Metadata is not protected authority. |

V1 **bash** grants were dynamically seeded via the actual V1 reply API. V2 saved
grants were not tested. Question does not use that Ask path; catalog visibility
and exposed executor were checked separately. Backend zero Asked events/pending
objects establish absence of the corresponding native dialog in guarded fixtures;
there was no browser/hosted-client acceptance.

## Acceptance mapping

| Concept cases | Evidence / remaining condition |
|---|---|
| T01–T03 | Native create/PATCH/readback/reuse exercised; MCP admission, idle adoption atomicity, busy/pending rejection unintegrated. |
| T04 | Isolated manual Question/Commit-Ask covered. |
| T05 | Hidden catalog/exposed executor/event negatives covered; manual-lineage reused child is an explicit failing boundary case. |
| T06–T07 | Original final text, finish stop, idle, same-session follow-up covered **with deterministic model**; mandatory handback with uncooperative model open. |
| T08 | Independent security Ask retained. Synthetic rejection cleans up fixture only. |
| T09 | Ordinary actual local Git/primary/prepared-child commits covered; branch/restore untested, tags outside authorized phase. |
| T10 | Native session Denies preserved; semantic narrower/read-only instruction adherence not proved by scripted model; agent-Deny preservation fails. |
| T11 | Actual outbound Shell/global/root/explicit/nested fixture texts covered; product ECC/co-plugin/provider/AGENTS composition open. |
| T12–T13 | 13 no-Ask/pre-execution canary forms; no real publishing or complete transport boundary acceptance. |
| T14 | Script/HTTP/REST negative controls. Actual aliases/hooks/helpers/Docker/custom/MCP/libgit/SSH/foreign-repo mediation open. |
| T15 | Local fixture reads covered; network read-broker/transport and user-origin policy untouched. |
| T16 | Native V1 Deny fails after actual remembered grant; early guard succeeds for covered path; V2 untested. |
| T17–T19 | Agent-Deny override, new/prepared/drifted/manual-lineage children, tools/PATCH drift and marker mutation covered positively/negatively. |
| T20 | Owned runtime restart persistence covered; real VM fresh/reattach/--no-mcp open. |
| T21–T23, T25 | No A2A/OpenLive/MCP trigger/skill integration in this phase. |
| T24 | Runner refuses unsupported versions; product schema/guard-load/readiness failure behavior unintegrated. |

## Proposed coordinated hooks / interfaces

No shared integration file was changed. Evidence identifies these interfaces:

1. **Trusted `ensureManagedWorkSession(sessionID, ingress, parentInvocation?)`:**
   validate project/idle/pending/adoption, establish protected sticky authority,
   preserve/read back full metadata and effective agent/session restrictions.
   Native metadata is only an operational mirror. Return verified readiness or
   fail before admission. PATCH metadata replaces, permission appends; avoid
   lost fields and unbounded duplicate rules. Disallow/reconcile prompt tools drift.
2. **Child admission before `TaskPromptOps.prompt`:** validate task_id lineage/
   scope, adopt or reject unrelated reused children, prepare local Allows without
   overriding unrelated Denies, read back. `tool.execute.before(task)` can inspect
   reused IDs; new child needs a hook after selection/creation and before first
   prompt. Async `session.created` handling alone is racy.
3. **Approval-independent execution denial:** native `SessionTools.resolve`
   tool-before is verified for Bash/Question/Task. It is an early defense/UX layer.
   `SessionPrompt.shellImpl` requires equivalent mediation before spawn; existing
   `shell.env` lacks the command. Arbitrary processes/other tools/outside-guest
   writers need a complete capability boundary.
4. **Controlled handback outcome:** Question suppression is proved; ordinary
   errors can retry. Guaranteed non-interactive handback needs a backend-owned
   terminal INPUT_REQUIRED outcome or bounded stop signal producing stored visible
   final text. Preserve independent security permissions.
5. **Instruction composition:** tool.definition rewrites the real shell sentence
   but has **no sessionID**. Use valid conditional wording or a real session-aware
   hook; no shared current-session variable. System transform adds the short
   primer; real VM-global conflicts/other plugins still require integration.
6. **Operator-controlled repository/transport boundary:** scripts, HTTP/SSH,
   helpers, Docker, custom/MCP tools, local foreign repos/control-plane need
   mediation. Effective firewall protection remains unverified from this sandbox;
   no policy change or user-origin probe was attempted. Preserve permitted Reads.

Concrete upstream anchors, tag `v1.18.33`:

- `packages/opencode/src/permission/index.ts`: ask/reply/evaluate/disabled.
- `packages/opencode/src/session/tools.ts`: resolve/pre-executor hooks.
- `packages/opencode/src/session/prompt.ts`: prompt tools replacement,
  createUserMessage, shellImpl/native subtask paths.
- `packages/opencode/src/tool/task.ts`: nextSession selection, TaskPromptOps.prompt.
- `packages/opencode/src/tool/registry.ts`, `packages/plugin/src/index.ts`: hook
  signatures, tool.definition lacks session input.
- `packages/opencode/src/plugin/index.ts`: plugin load/config errors may be
  reported/ignored; configured plugin is not proof of loaded enforcement.

## Gate decision

- **G1:** native hard-Deny claim disproven; early guard grant-independent only on
  covered path. Immutable/full enforcement still open.
- **G2:** hidden/exposed suppression demonstrated; mandatory terminal business
  handback and unrelated-lineage child adoption remain open.
- **G3:** lexical/tool-guard insufficiency positively demonstrated; complete
  capability boundary/host acceptance remain open.

**Ready for coordinated integration design/hook implementation: yes.**
**Production-ready isolated security core/complete feature acceptance: no.**
Broad managed Git Allows/hard remote-write readiness require effective scope,
protected authority, child admission, deterministic handback and complete mediation.
