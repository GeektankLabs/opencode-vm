"""Maintained real-runner regression; no origin, credentials or real publishing."""
import argparse
import urllib.error
from helpers.managed_runtime import Runtime, run, wait

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
    finally:
        fixture.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--opencode")
    parser.add_argument("--sdk", default="@ai-sdk/openai-compatible")
    args = parser.parse_args()
    check(args.opencode, args.sdk)
