"""Maintained real-runner regression; no origin, credentials or real publishing."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import urllib.error
from helpers.managed_runtime import ROOT, Runtime, run, wait

QUESTION = ("question", {"questions": [{"question": "Which fixture direction?", "header": "Decision", "options": [{"label": "A", "description": "Keep local scope"}, {"label": "B", "description": "Pause dependent work"}]}]})


def check(binary=None, sdk="@ai-sdk/openai-compatible"):
    fixture = Runtime(binary, sdk)
    try:
        fixture.cfg["agent"]["restricted"] = {"description": "Explicit read-only Git restriction", "mode": "primary", "permission": {"bash": {"git commit *": "deny"}}}
        fixture.start()
        manual = fixture.session()
        managed = fixture.session(metadata={"unrelated": "preserved"})
        fixture.adopt(managed)
        first = fixture.api("GET", f"/session/{managed}")
        fixture.adopt(managed)
        assert fixture.api("GET", f"/session/{managed}")["permission"] == first["permission"], "adoption must be idempotent"
        assert first["metadata"] == {"unrelated": "preserved"}
        # Model never supplies a final answer: native runner must terminate itself.
        result = fixture.finish(fixture.prompt(managed, "question-loop", [QUESTION]), managed)
        report = "\n".join(part.get("text", "") for part in result["parts"])
        assert "INPUT_REQUIRED:" in report and "Which fixture direction?" in report and "Keep local scope" in report, report
        assert fixture.calls["question-loop"] == 1, "question must not reach a retry loop"
        assert not any(part["type"] == "tool" and part.get("tool") == "question" for msg in fixture.api("GET", f"/session/{managed}/message") for part in msg["parts"])
        fixture.finish(fixture.prompt(managed, "follow-up", ["Decision A received; work can continue."]), managed)
        request = fixture.requests[0]
        system = str(request.get("instructions", "")) + str(request.get("system", "")) + "\n".join(str(m.get("content", "")) for m in request.get("messages", request.get("input", [])) if m.get("role") in ("system", "developer"))
        assert "agent-managed by its backend ingress" in system
        assert "surface them and ask before implementing" not in system
        shell = next(t.get("function", t)["description"] for t in request["tools"] if t.get("function", t)["name"] == "bash")
        # Stage 2 removes the shared Git-specific prompt replacement entirely;
        # local commit authority is verified through actual execution below.
        assert "Only commit, amend, push, or create PRs when explicitly requested." not in shell
        assert "ordinary local commits are already authorized" not in shell
        assert "In manual sessions only commit when explicitly requested." not in shell
        print("PASS real terminal handback and same-session follow-up", flush=True)
        (fixture.project / "work.txt").write_text("authorized local work\n")
        fixture.finish(fixture.prompt(managed, "commit", [("bash", {"command": "git add work.txt && git commit -m 'managed local work'", "description": "Authorized local fixture commit"}), "Committed locally"]), managed)
        assert run(fixture.git, "rev-parse", "HEAD", cwd=fixture.project, env=fixture.env) != fixture.baseline
        assert not any(item["sessionID"] == managed for item in fixture.api("GET", "/permission"))
        fixture.finish(fixture.prompt(managed, "push", [("bash", {"command": "git -C . push fixture-only", "description": "Publishing canary"}), "Publishing denied"]), managed)
        assert not fixture.canary.exists()
        fixture.finish(fixture.prompt(managed, "reads", [("bash", {"command": f"git fetch {fixture.bare} HEAD && git ls-remote {fixture.bare}", "description": "Allowed disposable read-only Git"}), "Remote reads completed"]), managed)
        print("PASS local commit, no-Ask remote deny and permitted Git reads", flush=True)
        # Native REST shell has a separate runner path; it must also deny before
        # spawn without opening a permission dialog.
        try:
            fixture.api("POST", f"/session/{managed}/shell", {"agent": "build", "command": "git push fixture-only"})
            raise AssertionError("native shell publishing was not denied")
        except urllib.error.HTTPError as error:
            assert error.code >= 400
        assert not fixture.canary.exists()
        print("PASS direct REST shell no-Ask deny", flush=True)
        # Direct metadata replacement must not remove backend authority.
        fixture.api("PATCH", f"/session/{managed}", {"metadata": {"different": True}})
        fixture.finish(fixture.prompt(managed, "drift", [QUESTION], tools={"question": True, "bash": True}), managed)
        fixture.start()
        fixture.finish(fixture.prompt(managed, "restart", [QUESTION]), managed)
        print("PASS metadata/tools drift and persistent restart", flush=True)
        fixture.scripts["child"] = [QUESTION]
        fixture.finish(fixture.prompt(managed, "parent-child", [("task", {"description": "Managed child regression", "subagent_type": "fixture-child", "prompt": "CASE:child"}), "Child returned its handback"]), managed)
        children = fixture.api("GET", f"/session/{managed}/children")
        assert children
        child = children[0]["id"]
        assert not any(item["sessionID"] == child for item in fixture.api("GET", "/question"))
        previously_manual = fixture.session(parentID=manual)
        fixture.scripts["reused"] = [QUESTION]
        fixture.finish(fixture.prompt(managed, "reuse", [("task", {"description": "Manual-lineage child regression", "subagent_type": "fixture-child", "prompt": "CASE:reused", "task_id": previously_manual}), "Reused child returned handback"]), managed)
        assert not any(item["sessionID"] == previously_manual for item in fixture.api("GET", "/question"))
        print("PASS new and manual-lineage reused children", flush=True)
        # Local branch/tag/restore work and child commits remain autonomous.
        fixture.scripts["child-local"] = [("bash", {"command": "git switch -c managed-local && git tag managed-local-tag && git commit --allow-empty -m 'child local commit'", "description": "Authorized disposable branch, tag and commit"}), "Child local work complete"]
        fixture.finish(fixture.prompt(managed, "child-local-parent", [("task", {"description": "Child local Git regression", "subagent_type": "fixture-child", "prompt": "CASE:child-local", "task_id": previously_manual}), "Child committed locally"]), managed)
        assert run(fixture.git, "branch", "--show-current", cwd=fixture.project, env=fixture.env) == "managed-local"
        assert run(fixture.git, "tag", "--list", cwd=fixture.project, env=fixture.env) == "managed-local-tag"
        (fixture.project / "work.txt").write_text("discard fixture change\n")
        fixture.finish(fixture.prompt(managed, "restore", [("bash", {"command": "git restore work.txt", "description": "Authorized local restore"}), "Restored"]), managed)
        assert (fixture.project / "work.txt").read_text() == "authorized local work\n"
        print("PASS child commit, branch/tag and restore autonomy", flush=True)
        restricted = fixture.session(agent="restricted", permission=[{"permission": "edit", "pattern": "*", "action": "deny"}])
        fixture.adopt(restricted)
        head = run(fixture.git, "rev-parse", "HEAD", cwd=fixture.project, env=fixture.env)
        fixture.finish(fixture.prompt(restricted, "scope-deny", [("bash", {"command": "git commit --allow-empty -m 'must not commit'", "description": "Explicit scope denial regression"}), "Scope denial retained"], agent="restricted", tools={"question": True}), restricted)
        assert run(fixture.git, "rev-parse", "HEAD", cwd=fixture.project, env=fixture.env) == head
        assert not any(q["sessionID"] == restricted for q in fixture.api("GET", "/permission"))
        print("PASS agent/session scope restrictions despite tools replacement", flush=True)
        # Manual Questions and independent security asks remain native, not
        # autoanswered or converted into business-handback text.
        future = fixture.prompt(manual, "manual-question", [QUESTION, "manual continuation"])
        pending = wait(lambda: [q for q in fixture.api("GET", "/question") if q["sessionID"] == manual])
        fixture.api("POST", f"/question/{pending[0]['id']}/reject", {})
        future.result(timeout=15)
        security = fixture.session(permission=[{"permission": "read", "pattern": "*", "action": "ask"}])
        fixture.adopt(security)
        future = fixture.prompt(security, "security", [("read", {"filePath": str(fixture.project / "work.txt")}), "security continuation"])
        pending = wait(lambda: [q for q in fixture.api("GET", "/permission") if q["sessionID"] == security])
        assert pending[0]["permission"] == "read"
        fixture.api("POST", f"/permission/{pending[0]['id']}/reply", {"reply": "reject"})
        future.result(timeout=15)
        print("PASS manual Question and independent security permission", flush=True)
        # A real V1 Always-Allow approval is seeded only for the fake Git binary.
        seed = fixture.session(permission=[{"permission": "bash", "pattern": "git push *", "action": "ask"}])
        future = fixture.prompt(seed, "always-seed", [("bash", {"command": "git push fixture-only", "description": "Disposable Always-Allow canary"}), "seed complete"])
        pending = wait(lambda: [q for q in fixture.api("GET", "/permission") if q["sessionID"] == seed])
        fixture.api("POST", f"/permission/{pending[0]['id']}/reply", {"reply": "always"})
        fixture.finish(future, seed)
        canaries = fixture.canary.read_text()
        fixture.finish(fixture.prompt(managed, "deny-after-always", [("bash", {"command": "git push fixture-only", "description": "Deny despite prior approval"}), "denied"]), managed)
        assert fixture.canary.read_text() == canaries
        assert not any(q["sessionID"] == managed for q in fixture.api("GET", "/permission"))
        print("PASS deny despite remembered Always-Allow", flush=True)
        nested = fixture.project / "nested"
        nested.mkdir()
        (nested / "AGENTS.md").write_text("NESTED_MANAGED_FIXTURE\n")
        (nested / "data.txt").write_text("fixture nested content\n")
        fixture.finish(fixture.prompt(managed, "hierarchy", [("read", {"filePath": str(nested / "data.txt")}), "Hierarchy read complete"]), managed)
        assert "NESTED_MANAGED_FIXTURE" in str(fixture.requests[-1])
        assert "GLOBAL_MANAGED_FIXTURE" in system and "PROJECT_MANAGED_FIXTURE" in system
        print("PASS actual global/project/nested instruction hierarchy", flush=True)
        # Enabled native background notification/continuation must also stay
        # managed; test in an owned restarted runtime, never the live project.
        fixture.env["OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"] = "true"
        fixture.start()
        fixture.scripts["background-child"] = [QUESTION]
        fixture.finish(fixture.prompt(managed, "background-parent", [("task", {"description": "Background managed regression", "subagent_type": "fixture-child", "prompt": "CASE:background-child", "background": True}), "Parent independent work complete"]), managed)
        def background_finished():
            children = fixture.api("GET", f"/session/{managed}/children")
            for info in children:
                messages = fixture.api("GET", f"/session/{info['id']}/message")
                if any("CASE:background-child" in str(m["parts"]) for m in messages):
                    return any(m["info"].get("finish") == "stop" and "INPUT_REQUIRED" in str(m["parts"]) for m in messages)
            return False
        wait(background_finished)
        assert not fixture.api("GET", "/question")
        print("PASS enabled native background child/continuation", flush=True)
        # external_directory noninteractive regression (1.19.0 incidents
        # Task88/E2E50). Under the incident configuration (project blanket
        # "*" allow) the adoption must not leak the OpenCode default
        # external ask into child sessions: the child's own agent rules decide.
        dispatch = fixture.root / "bi-dispatch"
        dispatch.mkdir(exist_ok=True)
        (dispatch / "needle.txt").write_text("bi-dispatch needle\n")
        archive = fixture.root / "bi-archive"
        archive.mkdir(exist_ok=True)
        (archive / "needle.txt").write_text("bi-archive needle\n")
        (archive / "needle_test.py").write_text("def test_needle():\n    assert True\n")

        def child_report(parent, case):
            for info in fixture.api("GET", f"/session/{parent}/children"):
                messages = fixture.api("GET", f"/session/{info['id']}/message")
                if any(case in str(m["parts"]) for m in messages):
                    terminal = [m for m in messages if m["info"].get("finish") == "stop"]
                    assert terminal, "external ask must end the child turn terminally"
                    return "\n".join(str(m["parts"]) for m in terminal)
            return None

        # F0: blanket-allow project (incident shape) — no ask at all anymore.
        fixture.scripts["child-ext"] = [("bash", {"command": "grep -rn needle ../bi-dispatch ../bi-archive", "description": "External grep under project allow"}), "External child work complete"]
        fixture.finish(fixture.prompt(managed, "ext-parent", [("task", {"description": "External directory regression", "subagent_type": "fixture-child", "prompt": "CASE:child-ext"}), "Parent continued"]), managed)
        assert not fixture.pending_permissions()
        print("PASS no inherited external ask under project blanket allow (F0, incident shape)", flush=True)
    finally:
        fixture.close()
    # Restrictive-project phase: own disposable fixture outside the OpenCode
    # tmp whitelist, without the project blanket "*" allow — an unauthorized
    # external ask must end as a stored terminal blocker in that turn, never a
    # hidden UI wait; operator-authorized scope runs without any ask; explicit
    # denies keep winning; manual sessions stay interactive.
    ext = Runtime(prefix="/tmp/opencode-ext")
    try:
        del ext.cfg["permission"]["*"]
        ext.start()

        def child_report(parent, case):
            for info in ext.api("GET", f"/session/{parent}/children"):
                messages = ext.api("GET", f"/session/{info['id']}/message")
                if any(case in str(m["parts"]) for m in messages):
                    terminal = [m for m in messages if m["info"].get("finish") == "stop"]
                    assert terminal, "external ask must end the child turn terminally"
                    return "\n".join(str(m["parts"]) for m in terminal)
            return None

        dispatch = ext.root / "bi-dispatch"
        dispatch.mkdir()
        (dispatch / "needle.txt").write_text("bi-dispatch needle\n")
        archive = ext.root / "bi-archive"
        archive.mkdir()
        (archive / "needle.txt").write_text("bi-archive needle\n")
        (archive / "needle_test.py").write_text("def test_needle():\n    assert True\n")
        restricted_root = ext.session()
        ext.adopt(restricted_root)
        # Repro A (Task88): managed child greps sibling directories via the
        # native grep tool (the actual incident path; bash grep is not in
        # OpenCode's FILES set and does not trigger the directory ask).
        ext.scripts["child-block"] = [("grep", {"pattern": "needle", "path": "../bi-dispatch"}), "child continuation"]
        ext.finish(ext.prompt(restricted_root, "ext-parent", [("task", {"description": "External directory regression", "subagent_type": "fixture-child", "prompt": "CASE:child-block"}), "Parent continued after blocked child"]), restricted_root)
        blocked = wait(lambda: child_report(restricted_root, "CASE:child-block"))
        assert "INPUT_REQUIRED:" in blocked and "bi-dispatch" in blocked and "not approved automatically" in blocked, blocked
        assert not any(item["permission"] == "external_directory" for item in ext.pending_permissions()), "rejected ask must not stay pending"
        print("PASS repro A unauthorized child external grep ends terminal (Task88)", flush=True)
        # Repro B (E2E50): task-owned stash/external pytest/stash-pop flow.
        ext.scripts["child-stash"] = [("bash", {"command": "git stash -u >/dev/null; cd ../bi-archive && python3 -m pytest -q needle_test.py; cd - >/dev/null; git stash pop", "description": "Task stash and external pytest"}), "child stash continuation"]
        ext.finish(ext.prompt(restricted_root, "stash-parent", [("task", {"description": "External stash regression", "subagent_type": "fixture-child", "prompt": "CASE:child-stash"}), "Parent continued after blocked stash child"]), restricted_root)
        blocked = wait(lambda: child_report(restricted_root, "CASE:child-stash"))
        assert "INPUT_REQUIRED:" in blocked and "bi-archive" in blocked, blocked
        assert not any(item["permission"] == "external_directory" for item in ext.pending_permissions())
        print("PASS repro B stash/external pytest/pop ends terminal (E2E50)", flush=True)
        # Operator-authorized scope: same flows run without any ask, including
        # fresh and reused children; active authorized children finish normally.
        scoped = ext.session()
        ext.adopt(scoped, scope_dirs=[str(ext.root)])
        ext.scripts["child-scope"] = [("grep", {"pattern": "needle", "path": "../bi-dispatch"}), "Authorized child work complete"]
        ext.finish(ext.prompt(scoped, "scope-parent", [("task", {"description": "Authorized external scope", "subagent_type": "fixture-child", "prompt": "CASE:child-scope"}), "Authorized child returned"]), scoped)
        assert not ext.pending_permissions()
        reused_child = None
        for info in ext.api("GET", f"/session/{scoped}/children"):
            if any("CASE:child-scope" in str(m["parts"]) for m in ext.api("GET", f"/session/{info['id']}/message")):
                reused_child = info["id"]
        assert reused_child, "authorized child must exist"
        ext.scripts["child-scope-reuse"] = [("grep", {"pattern": "needle", "path": "../bi-archive"}), "Reused authorized child complete"]
        ext.finish(ext.prompt(scoped, "scope-reuse", [("task", {"description": "Authorized reuse", "subagent_type": "fixture-child", "prompt": "CASE:child-scope-reuse", "task_id": reused_child}), "Reused child returned"]), scoped)
        assert not ext.pending_permissions()
        print("PASS authorized scope without ask for fresh and reused children", flush=True)
        # Explicit agent deny still wins: denied tool error, no ask, no blocker.
        ext.cfg["agent"]["fixture-denied-child"] = {"description": "External-denied child", "mode": "subagent", "permission": {"question": "allow", "external_directory": {f"{ext.root}/bi-*": "deny"}}}
        ext.start()
        scoped = ext.session()
        ext.adopt(scoped, scope_dirs=[str(ext.root)])
        ext.scripts["child-deny"] = [("grep", {"pattern": "needle", "path": "../bi-archive"}), "Denied child complete"]
        ext.finish(ext.prompt(scoped, "deny-parent", [("task", {"description": "External deny regression", "subagent_type": "fixture-denied-child", "prompt": "CASE:child-deny"}), "Denied child returned"]), scoped)
        assert not ext.pending_permissions()
        denied = wait(lambda: child_report(scoped, "CASE:child-deny"))
        assert "INPUT_REQUIRED" not in denied and "not approved automatically" not in denied, "explicit deny must not be converted into a permission blocker report"
        print("PASS explicit external deny wins over authorized scope", flush=True)
        # Manual sessions keep the native interactive ask; nothing is answered.
        manual_ext = ext.session()
        future = ext.prompt(manual_ext, "manual-ext", [("grep", {"pattern": "needle", "path": "../bi-archive"}), "manual continuation"])
        pending = wait(lambda: [item for item in ext.pending_permissions() if item["sessionID"] == manual_ext and item["permission"] == "external_directory"])
        ext.reject_permission(pending[0]["id"])
        future.result(timeout=15)
        print("PASS manual session external ask stays interactive", flush=True)
        # B1 real-ingress proof: the operator-authorized scope flows through the
        # actual MCP admission path (tool schema -> gateway validation -> managed
        # socket /adopt -> plugin rules -> native child) — not a mock and not a
        # direct /adopt call. The gateway talks to the same live fixture server.
        ingress = ext.root / "ingress.mjs"
        ingress.write_text("import assert from 'node:assert/strict';\n"
                           "import { OpenCodeGateway } from " + json.dumps((Path(__file__).resolve().parents[1] / "adapters/mcp/dist/opencode.js").as_uri()) + ";\n"
                           "const runtime = {schema:1,project:" + json.dumps(str(ext.project)) + ",projectHash:'fixture',projectName:'fixture',backendUrl:" + json.dumps(ext.url) + ",generation:'fixture',opencodeVersion:'1.19.0',listenHost:'127.0.0.1',listenPort:40960,credentialFile:'/not-used'};\n"
                           "const gateway = new OpenCodeGateway(runtime);\n"
                           "const created = await gateway.createSession('Scoped ingress work', [" + json.dumps(str(ext.root)) + "]);\n"
                           "const receipt = await gateway.sendMessage(created.session_id, 'CASE:ingress-scope');\n"
                           "for (let i = 0; i < 200; i++) { const status = await gateway.getSessionStatus(created.session_id, receipt.message_id); if (status.state === 'completed') break; await new Promise(r => setTimeout(r, 50)); }\n"
                           "const result = await gateway.getTaskResult(created.session_id, receipt.message_id);\n"
                           "assert.equal(result.state, 'completed');\n"
                           "assert.doesNotMatch(JSON.stringify(result), /INPUT_REQUIRED/);\n"
                           "await gateway.close();\n"
                           "console.log('INGRESS-SCOPE-OK');\n")
        ext.scripts["ingress-scope"] = [("task", {"description": "Authorized ingress child", "subagent_type": "fixture-child", "prompt": "CASE:ingress-child"}), "Ingress parent continued"]
        ext.scripts["ingress-child"] = [("grep", {"pattern": "needle", "path": "../bi-archive"}), "Ingress child authorized work complete"]
        import subprocess as sp
        outcome = sp.check_output(["node", str(ingress)], env=ext.env, text=True)
        assert "INGRESS-SCOPE-OK" in outcome, outcome
        assert not ext.pending_permissions()
        print("PASS real MCP ingress scope_dirs admission (authorized child, no ask)", flush=True)
    finally:
        ext.close()


    # R2+R5 real fault regression (disposable, outside the /tmp/opencode
    # whitelist): a transient isManaged API error on the intact event path
    # must NOT hang the ask until some future resubscribe — the bounded
    # delayed re-check sweeps it — and the sweep must process the managed ask
    # first even when it sits behind 65 foreign/manual pending asks. Product
    # code stays clean: the one-shot fault is injected into a test-local copy
    # of the plugin.
    fault = Runtime(prefix="/tmp/opencode-ext")
    try:
        del fault.cfg["permission"]["*"]
        fault_dir = fault.root / "fault-plugin"
        fault_dir.mkdir()
        (fault_dir / "managed-core.mjs").write_text((ROOT / "runtime/managed-core.mjs").read_text())
        policy = (ROOT / "runtime/managed-policy.mjs").read_text()
        anchor = "try { managed = await isManaged(info.sessionID); }"
        injected = anchor.replace(
            "try {",
            "try { if (!globalThis.__ocvmFaultOnce && JSON.stringify(info.patterns ?? []).includes('bi-archive')) { globalThis.__ocvmFaultOnce = true; throw new Error('injected transient isManaged fault'); }",
            1,
        )
        assert anchor in policy
        (fault_dir / "managed-policy.mjs").write_text(policy.replace(anchor, injected, 1))
        fault.cfg["plugin"] = [(fault_dir / "managed-policy.mjs").as_uri()]
        archive = fault.root / "bi-archive"
        archive.mkdir()
        (archive / "needle.txt").write_text("needle\n")
        manual_dir = fault.root / "bi-manual"
        manual_dir.mkdir()
        (manual_dir / "needle.txt").write_text("needle\n")
        fault.start()
        # 65 manual sessions block on their own interactive external asks
        # (separate directory so the injected fault stays bound to the
        # managed child's ask patterns). Blocked turns never return, so they
        # need their own executor — the fixture's 8-worker pool would starve.
        # Each session gets a unique CASE name: the fixture model server
        # counts script steps globally, so a shared name would hand later
        # sessions the follow-up text instead of the grep tool call.
        volume_pool = concurrent.futures.ThreadPoolExecutor(max_workers=70)
        manual_futures = []
        try:
            for i in range(65):
                manual = fault.session()
                name = f"manual-volume-{i}"
                fault.scripts[name] = [("grep", {"pattern": "needle", "path": "../bi-manual"}), "manual continuation"]
                manual_futures.append(volume_pool.submit(
                    fault.api, "POST", f"/session/{manual}/message",
                    {"agent": "build", "model": {"providerID": "fixture", "modelID": "gpt-fixture"}, "parts": [{"type": "text", "text": f"CASE:{name}"}]},
                ))
            wait(lambda: len([item for item in fault.pending_permissions() if item["permission"] == "external_directory"]) >= 65, 180)
            # Managed child ask last: its event-path lineage check fails once
            # (injected fault), so only the bounded delayed re-check sweep can
            # reach it — behind 65 foreign pendings.
            fault_root_session = fault.session()
            fault.adopt(fault_root_session)
            fault.scripts["fault-child"] = [("grep", {"pattern": "needle", "path": "../bi-archive"}), "fault child continuation"]
            fault.finish(fault.prompt(fault_root_session, "fault-parent", [("task", {"description": "Fault regression", "subagent_type": "fixture-child", "prompt": "CASE:fault-child"}), "Fault parent continued"]), fault_root_session)
            for info in fault.api("GET", f"/session/{fault_root_session}/children"):
                messages = fault.api("GET", f"/session/{info['id']}/message")
                if any("CASE:fault-child" in str(m["parts"]) for m in messages):
                    terminal = [m for m in messages if m["info"].get("finish") == "stop"]
                    assert terminal, "delayed re-check sweep must terminate the faulted managed child turn"
                    assert "INPUT_REQUIRED:" in str(terminal) and "not approved automatically" in str(terminal)
            remaining = [item for item in fault.pending_permissions() if item["permission"] == "external_directory"]
            assert all(item["sessionID"] != fault_root_session and not any(item["sessionID"] == c["id"] for c in fault.api("GET", f"/session/{fault_root_session}/children")) for item in remaining), "no managed-lineage ask may remain pending"
            assert len(remaining) >= 65, "manual asks stay untouched and interactive"
            print("PASS transient event-path lineage fault and 65+ pending sweep fairness (R2/R5)", flush=True)
        finally:
            volume_pool.shutdown(wait=False, cancel_futures=True)
    finally:
        fault.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--opencode")
    parser.add_argument("--sdk", default="@ai-sdk/openai-compatible")
    args = parser.parse_args()
    check(args.opencode, args.sdk)
