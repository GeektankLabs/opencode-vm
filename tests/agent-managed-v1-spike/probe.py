"""Deterministic live OpenCode V1 probes; no model service, auth or real push.

Run: python3 -B tests/agent-managed-v1-spike/probe.py
All state lives in a fresh /tmp/opencode directory. A Git stub delegates local
commands but intercepts publishing commands BEFORE invoking real Git. Synthetic
Always-Allow answers apply only to this disposable runtime. Evidence is retained
there, with the path printed on completion/failure.
"""

import concurrent.futures
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


HERE = Path(__file__).resolve().parent
GIT = shutil.which("git")
OPENCODE = shutil.which("opencode")
MARKER = "ocvmAgentManagedSpike"
QUESTION = {"questions": [{"question": "Choose fixture option", "header": "Fixture", "options": [{"label": "A", "description": "Synthetic"}]}]}
HAND_BACK = "INPUT_REQUIRED:\n- decision: choose A or B\n- context: disposable fixture needs a decision\n- safe_options: A or B\n- completed: guard probe\n- paused: decision-dependent work"


def run(*args, cwd=None, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True, stderr=subprocess.STDOUT).strip()


def wait_until(callback, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = callback()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("bounded wait expired")


class Fixture:
    def __init__(self):
        self.scripts = {}
        self.requests = []
        self.posts = []
        self.lock = threading.Lock()
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.path == "/write-canary":
                    fixture.posts.append(body.decode())
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"synthetic sink only")
                    return
                data = json.loads(body)
                with fixture.lock:
                    fixture.requests.append(data)
                messages = data["messages"]
                user_index = max(i for i, msg in enumerate(messages) if msg["role"] == "user")
                text = json.dumps(messages[user_index]["content"])
                match = re.search(r"SPIKE:([a-zA-Z0-9_-]+)", text)
                if match and data.get("tools"):
                    name = match[1]
                    offset = sum(len(msg.get("tool_calls", [])) for msg in messages[user_index + 1:])
                    script = fixture.scripts[name]
                    action = script[offset] if offset < len(script) else "fixture completed"
                else:
                    action = "fixture summary"
                identifier = f"fixture-{len(fixture.requests)}"
                delta = {"content": action} if isinstance(action, str) else {"tool_calls": [{
                    "index": 0, "id": identifier, "type": "function",
                    "function": {"name": action[0], "arguments": json.dumps(action[1])},
                }]}
                finish = "stop" if isinstance(action, str) else "tool_calls"
                base = {"id": identifier, "object": "chat.completion.chunk", "created": 1, "model": "fixture"}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for chunk in [
                    {**base, "choices": [{"index": 0, "delta": {"role": "assistant", **delta}, "finish_reason": None}]},
                    {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}},
                ]:
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"


class Probe:
    def __init__(self):
        assert OPENCODE and GIT
        self.root = Path(tempfile.mkdtemp(prefix="managed-v1-", dir="/tmp/opencode"))
        self.project = self.root / "project"
        self.project.mkdir()
        self.global_config = self.root / "config" / "opencode"
        self.global_config.mkdir(parents=True)
        self.home = self.root / "home"
        self.home.mkdir()
        self.fixture = Fixture()
        self.audit_path = self.root / "audit.jsonl"
        self.stub_log = self.root / "git-canary.jsonl"
        self.results = []
        self.completed = False
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        self.process = None
        self.log_handle = None
        self.version = run(OPENCODE, "--version")
        assert self.version == "1.18.33", f"unsupported runtime for this spike: {self.version}"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        stub = self.bin / "git"
        stub.write_text(f'''#!/usr/bin/python3
import json, os, sys
args = sys.argv[1:]
if any(x in ("push", "send-pack", "http-push", "publish-fixture") for x in args):
    with open({str(self.stub_log)!r}, "a") as f:
        f.write(json.dumps(args) + "\\n")
    print("CANARY_ONLY: publishing intercepted before real Git")
    sys.exit(73)
os.execv({GIT!r}, [{GIT!r}] + args)
''')
        stub.chmod(0o700)
        for helper in ["git-send-pack", "git-http-push"]:
            (self.bin / helper).write_text("#!/bin/sh\nexit 73\n")
            (self.bin / helper).chmod(0o700)
        self.env = {
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
            "HOME": str(self.home), "USER": "spike", "SHELL": "/bin/bash", "LANG": "C.UTF-8",
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_DATA_HOME": str(self.root / "data"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
            "OPENCODE_DISABLE_MODELS_FETCH": "true",
            "OPENCODE_DISABLE_EXTERNAL_SKILLS": "true",
            "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS": "true",
            "OPENCODE_ENABLE_QUESTION_TOOL": "true",
            "OCVM_SPIKE_AUDIT": str(self.audit_path),
        }
        run(GIT, "init", "-q", str(self.project), env=self.env)
        run(GIT, "config", "user.name", "Disposable Fixture", cwd=self.project, env=self.env)
        run(GIT, "config", "user.email", "fixture@example.invalid", cwd=self.project, env=self.env)
        (self.project / "local.txt").write_text("baseline\n")
        run(GIT, "add", "local.txt", cwd=self.project, env=self.env)
        run(GIT, "commit", "-qm", "fixture baseline", cwd=self.project, env=self.env)
        # No actual remote configured anywhere. Read probes use a local disposable bare clone.
        self.remote = self.root / "read-only-fixture.git"
        run(GIT, "clone", "--bare", "-q", str(self.project), str(self.remote), env=self.env)
        self.refs = run(GIT, "--git-dir", str(self.remote), "show-ref", env=self.env)
        self.base_config = {
            "$schema": "https://opencode.ai/config.json", "model": "fixture/gpt-fixture",
            "small_model": "fixture/gpt-fixture", "share": "disabled", "autoupdate": False,
            "snapshot": False, "formatter": False, "lsp": False,
            "enabled_providers": ["fixture"],
            "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Disposable model",
                "options": {"baseURL": self.fixture.url + "/v1"},
                "models": {"gpt-fixture": {"name": "Synthetic", "limit": {"context": 100000, "output": 8192}}}}},
            "permission": {"*": "allow", "bash": {"*": "allow", "git commit": "ask", "git commit *": "ask", "git push": "deny", "git push *": "deny"}},
            "agent": {
                "fixture-child": {"description": "Synthetic inheritance fixture", "mode": "subagent", "permission": {"question": "allow"}},
                "fixture-restricted": {"description": "Agent deny preservation fixture", "mode": "primary", "permission": {"bash": {"git commit *": "deny"}}},
            },
            "instructions": [str(self.project / "extra.md")],
        }
        (self.global_config / "AGENTS.md").write_text("GLOBAL_SPIKE_INSTRUCTION: global source\n")
        (self.project / "AGENTS.md").write_text("ROOT_SPIKE_INSTRUCTION: root source\n")
        (self.project / "extra.md").write_text("EXPLICIT_SPIKE_INSTRUCTION: configured source\n")
        (self.project / "nested").mkdir()
        (self.project / "nested" / "AGENTS.md").write_text("NESTED_SPIKE_INSTRUCTION: nested read source\n")
        (self.project / "nested" / "data.txt").write_text("nested fixture\n")
        # Preinstall the actual pinned plugin dependency. V1's asynchronous
        # bootstrap installer can stall in this sandbox; no fake dependency tree.
        run(shutil.which("npm"), "install", "--prefix", str(self.global_config),
            "--ignore-scripts", "--no-audit", "--no-fund", "@opencode-ai/plugin@1.18.33", env=self.env)

    def start(self, plugin=False):
        self.stop()
        config = dict(self.base_config)
        if plugin:
            config["plugin"] = [(HERE / "plugin.mjs").as_uri()]
        (self.global_config / "opencode.json").write_text(json.dumps(config))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.log_handle = (self.root / f"runtime-{time.time_ns()}.log").open("w")
        self.process = subprocess.Popen([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", str(port)], cwd=self.project, env=self.env, stdout=self.log_handle, stderr=subprocess.STDOUT)
        def ready():
            assert self.process.poll() is None, "disposable server exited; inspect runtime log"
            try:
                return self.api("GET", "/global/health")
            except (OSError, urllib.error.URLError):
                return None
        assert wait_until(ready, timeout=60)["version"] == self.version
        self.api("GET", "/config")  # initialize this project instance

    def stop(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        if self.log_handle:
            self.log_handle.close()
            self.log_handle = None

    def api(self, method, path, body=None):
        url = self.url + path
        if path not in ("/global/health", "/doc"):
            url += ("&" if "?" in path else "?") + "directory=" + urllib.parse.quote(str(self.project))
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        request = urllib.request.Request(url, data, headers, method=method)
        with urllib.request.urlopen(request, timeout=1 if path == "/global/health" else 60) as response:
            content = response.read()
            return json.loads(content) if content else None

    def session(self, rules=None, managed=False, parent=None):
        payload = {"title": "Disposable spike", "metadata": {"unrelated": "preserved"}}
        if managed:
            payload["metadata"][MARKER] = 1
        if rules is not None:
            payload["permission"] = rules
        if parent:
            payload["parentID"] = parent
        return self.api("POST", "/session", payload)["id"]

    def prompt(self, sid, name, script, **fields):
        self.fixture.scripts[name] = script
        return self.pool.submit(self.api, "POST", f"/session/{sid}/message", {
            "model": {"providerID": "fixture", "modelID": "gpt-fixture"},
            "agent": "build", "parts": [{"type": "text", "text": "SPIKE:" + name}], **fields,
        })

    def pending(self, path, sid):
        return [item for item in self.api("GET", path) if item["sessionID"] == sid]

    def audit(self):
        return [json.loads(line) for line in self.audit_path.read_text().splitlines()] if self.audit_path.exists() else []

    def canaries(self):
        return self.stub_log.read_text().splitlines() if self.stub_log.exists() else []

    def record(self, name, **facts):
        self.results.append({"case": name, **facts})
        print("PASS", name, flush=True)

    def finish(self, future, sid, terminal=True):
        result = future.result(timeout=35)
        if terminal:
            assert result["info"].get("finish") == "stop", result
        assert not result["info"].get("error"), result
        wait_until(lambda: self.api("GET", "/session/status").get(sid, {"type": "idle"})["type"] == "idle")
        return result

    def history(self, sid):
        return self.api("GET", f"/session/{sid}/message")

    def errors(self, sid):
        return [part["state"]["error"] for msg in self.history(sid) for part in msg["parts"] if part["type"] == "tool" and part["state"]["status"] == "error"]

    def tools(self, sid):
        return [part for msg in self.history(sid) for part in msg["parts"] if part["type"] == "tool"]

    def model_requests(self, name):
        return [request for request in self.fixture.requests if any(
            "SPIKE:" + name in json.dumps(msg.get("content")) for msg in request["messages"] if msg["role"] == "user"
        ) and request.get("tools")]

    def no_input(self, sid, since):
        assert not self.pending("/question", sid)
        assert not self.pending("/permission", sid)
        assert not any(row.get("sessionID") == sid and row.get("type") in ("question.asked", "permission.asked") for row in self.audit()[since:])

    def rules(self, previous=None):
        # Use the real prototype composition, not a Python copy of its rules.
        return json.loads(run("node", "--input-type=module", "-e", f"import {{sessionRules}} from {json.dumps((HERE / 'policy.mjs').as_uri())}; console.log(JSON.stringify(sessionRules({json.dumps(previous or [])})))"))

    def execute(self):
        self.start()
        doc = self.api("GET", "/doc")
        (self.root / "runtime-schema.json").write_text(json.dumps(doc))
        assert "metadata" in json.dumps(doc["paths"]["/session"]["post"])
        sid = self.session(self.rules())
        result = self.finish(self.prompt(sid, "native-deny", [("bash", {"command": "git push publish-fixture", "description": "Canary, no real push"})]), sid)
        assert self.errors(sid) and not self.canaries()
        self.record("native direct deny without remembered grant", errors=self.errors(sid))

        # Grant only a fake publishing invocation; the stub never delegates a push.
        seed = self.session([{"permission": "bash", "pattern": "git push *", "action": "ask"}])
        future = self.prompt(seed, "seed-allow", [("bash", {"command": "git push publish-fixture", "description": "Synthetic approval cache seed"})])
        pending = wait_until(lambda: self.pending("/permission", seed))
        assert pending[0]["always"] == ["git push *"], pending
        self.api("POST", f"/permission/{pending[0]['id']}/reply", {"reply": "always"})
        self.finish(future, seed)
        before = len(self.canaries())
        other = self.session(self.rules(), managed=True)
        self.finish(self.prompt(other, "native-after-grant", [("bash", {"command": "git push publish-fixture", "description": "Deny versus remembered allow"})]), other)
        assert len(self.canaries()) == before + 1, "expected V1 deny bypass did not reproduce"
        assert not self.pending("/permission", other)
        self.record("V1 instance-wide Always-Allow overrides later session deny", canary_executions=1, actual_remote_writes=0)

        # Baseline native question remains pending even when a model forcibly calls a hidden tool.
        hidden = self.session(self.rules(), managed=True)
        question = self.prompt(hidden, "hidden-question", [("question", QUESTION), HAND_BACK])
        pending = wait_until(lambda: self.pending("/question", hidden) or question.done())
        if question.done():
            self.finish(question, hidden, terminal=False)
            hidden_tools = self.tools(hidden)
            assert hidden_tools and all(part["tool"] != "question" for part in hidden_tools), hidden_tools
            assert all("question" not in [tool["function"]["name"] for tool in req["tools"]] for req in self.model_requests("hidden-question"))
            self.record("native forced hidden question repaired to invalid tool before executor", actual_tool_ids=[part["tool"] for part in hidden_tools])
        else:
            assert pending
            self.api("POST", f"/question/{pending[0]['id']}/reject", {})
            self.finish(question, hidden)
            self.record("native forced hidden question reaches Question.ask despite deny", pending_questions=1)

        # Re-exposure by another client replaces native rules; executor itself
        # does not ask Permission. No product session is involved.
        exposed = self.session(self.rules(), managed=True)
        question = self.prompt(exposed, "exposed-native-question", [("question", QUESTION), HAND_BACK], tools={"question": True})
        pending = wait_until(lambda: self.pending("/question", exposed))
        assert not self.pending("/permission", exposed)
        self.api("POST", f"/question/{pending[0]['id']}/reject", {})
        self.finish(question, exposed, terminal=False)
        assert self.api("GET", f"/session/{exposed}")["permission"] == [{"permission": "question", "action": "allow", "pattern": "*"}]
        self.record("tools replacement exposes native Question.ask without permission check", pending_questions=1)

        self.start(plugin=True)  # cache reset; persistent sessions retained
        # Re-seed the instance approval cache with the plugin active, manual session.
        seed = self.session([{"permission": "bash", "pattern": "git push *", "action": "ask"}])
        future = self.prompt(seed, "guard-seed", [("bash", {"command": "git push publish-fixture", "description": "Manual canary grant"})])
        pending = wait_until(lambda: self.pending("/permission", seed))
        self.api("POST", f"/permission/{pending[0]['id']}/reply", {"reply": "always"})
        self.finish(future, seed)
        guarded = self.session(self.rules(), managed=True)
        before = len(self.canaries())
        self.finish(self.prompt(guarded, "guard-deny", [("bash", {"command": "git push publish-fixture", "description": "Guard versus remembered allow"})]), guarded)
        assert len(self.canaries()) == before
        assert any("REMOTE_WRITE_DENIED" in error for error in self.errors(guarded))
        assert not self.pending("/permission", guarded)
        self.record("execution guard denies before remembered approval", canary_executions=0)

        self.additional_probes(guarded)
        self.completed = True

    def additional_probes(self, guarded):
        # A real Git commit, scoped to one disposable file; no release or tag.
        (self.project / "local.txt").write_text("managed development\n")
        old_sha = run(GIT, "rev-parse", "HEAD", cwd=self.project, env=self.env)
        since = len(self.audit())
        commands = ["git status --short", "git diff -- local.txt", "git log -1 --oneline",
                    "git add local.txt", "git commit -m 'managed fixture commit'", "git diff --cached --exit-code"]
        self.finish(self.prompt(guarded, "local-git", [("bash", {"command": cmd, "description": "Disposable local Git"}) for cmd in commands]), guarded)
        new_sha = run(GIT, "rev-parse", "HEAD", cwd=self.project, env=self.env)
        assert new_sha != old_sha
        assert run(GIT, "show", "--pretty=format:", "--name-only", "HEAD", cwd=self.project, env=self.env) == "local.txt"
        self.no_input(guarded, since)
        self.record("managed local commit executes without approval", commit=new_sha, changed_files=["local.txt"])

        before = len(self.canaries())
        since = len(self.audit())
        variants = [
            "git push publish-fixture", "git push --dry-run publish-fixture",
            "git -C . push publish-fixture", "git -c core.pager=cat push publish-fixture",
            f"{self.bin}/git push publish-fixture", "env git push publish-fixture",
            "git status --short && git push publish-fixture", "git\tpush publish-fixture",
            "git send-pack publish-fixture", f"{self.bin}/git-send-pack publish-fixture",
            "git http-push publish-fixture", f"{self.bin}/git-http-push publish-fixture", "git lfs push publish-fixture",
        ]
        self.finish(self.prompt(guarded, "direct-variants", [("bash", {"command": cmd, "description": "Recognized direct-write canary"}) for cmd in variants]), guarded)
        errors = [part["state"].get("error", "") for part in self.tools(guarded)[-len(variants):]]
        assert len(errors) == len(variants) and all("REMOTE_WRITE_DENIED" in error for error in errors), errors
        assert len(self.canaries()) == before
        self.no_input(guarded, since)
        self.record("13 direct-write variants denied before execution", variants=variants, canary_executions=0)

        since = len(self.audit())
        self.finish(self.prompt(guarded, "read-git", [
            ("bash", {"command": f"git ls-remote {self.remote}", "description": "Read-only disposable Git fixture"}),
            ("bash", {"command": f"git fetch {self.remote} HEAD", "description": "Read-only disposable fetch"}),
        ]), guarded)
        assert all(part["state"]["status"] == "completed" and part["state"].get("metadata", {}).get("exit") == 0 for part in self.tools(guarded)[-2:]), self.tools(guarded)[-2:]
        self.no_input(guarded, since)
        self.record("disposable ls-remote and fetch remain functional", fixture_refs_unchanged=True)

        since = len(self.audit())
        result = self.finish(self.prompt(guarded, "guard-question", [("question", QUESTION), HAND_BACK], tools={"bash": True, "question": True}), guarded)
        assert any("INPUT_REQUIRED" in error for error in self.errors(guarded))
        assert any(part.get("text") == HAND_BACK for part in result["parts"])
        self.no_input(guarded, since)
        drift = self.api("GET", f"/session/{guarded}")
        assert drift["metadata"][MARKER] == 1
        assert drift["permission"] == [{"permission": tool, "action": "allow", "pattern": "*"} for tool in ("bash", "question")]
        self.record("forced visible question guarded after tools replacement", terminal_finish="stop", native_input_events=0)
        self.finish(self.prompt(guarded, "same-session-follow-up", ["decision A received; continued in same session"]), guarded)
        assert self.api("GET", f"/session/{guarded}")["id"] == guarded
        self.record("terminal handback followed by normal same-session turn", pending_questions=0)

        since = len(self.audit())
        self.finish(self.prompt(guarded, "repeated-question", [("question", QUESTION), ("question", QUESTION), HAND_BACK]), guarded)
        blocked = [row for row in self.audit()[since:] if row.get("kind") == "before" and row.get("tool") == "question" and row.get("sessionID") == guarded]
        assert len(blocked) == 2
        self.no_input(guarded, since)
        self.record("guard errors do not themselves force terminal handback", repeated_attempts=2, deterministic_model_emits_final_report=True)

        manual = self.session()
        future = self.prompt(manual, "manual-question", [("question", QUESTION), "manual fixture continued"])
        pending = wait_until(lambda: self.pending("/question", manual))
        self.api("POST", f"/question/{pending[0]['id']}/reject", {})
        self.finish(future, manual, terminal=False)
        assert any(row.get("type") == "question.asked" and row.get("sessionID") == manual for row in self.audit())
        self.record("manual question remains interactive", question_asked_events=1)

        future = self.prompt(manual, "manual-commit", [("bash", {"command": "git commit --allow-empty -m 'manual canary'", "description": "Manual commit must still ask"})])
        pending = wait_until(lambda: self.pending("/permission", manual))
        self.api("POST", f"/permission/{pending[0]['id']}/reply", {"reply": "reject"})
        self.finish(future, manual, terminal=False)
        assert run(GIT, "rev-parse", "HEAD", cwd=self.project, env=self.env) == new_sha
        self.record("manual local commit still asks", commit_executed=False)

        protected = self.session(self.rules([{"permission": "bash", "pattern": "git commit *", "action": "deny"}, {"permission": "read", "pattern": "secret*", "action": "deny"}]), managed=True)
        self.finish(self.prompt(protected, "session-restriction", [("bash", {"command": "git commit --allow-empty -m 'denied fixture'", "description": "Preserved session deny"})]), protected)
        assert self.errors(protected)
        assert run(GIT, "rev-parse", "HEAD", cwd=self.project, env=self.env) == new_sha
        assert {"permission": "read", "pattern": "secret*", "action": "deny"} in self.api("GET", f"/session/{protected}")["permission"]
        self.record("prototype preserves unrelated native session denies", local_commit_denied=True)

        # Existing independent asks are not blanket-approved in managed mode.
        security = self.session(self.rules([{"permission": "read", "pattern": "*", "action": "ask"}]), managed=True)
        future = self.prompt(security, "security-ask", [("read", {"filePath": str(self.project / "local.txt")})])
        pending = wait_until(lambda: self.pending("/permission", security))
        assert pending[0]["permission"] == "read"
        self.api("POST", f"/permission/{pending[0]['id']}/reply", {"reply": "reject"})
        self.finish(future, security, terminal=False)
        self.record("independent managed security ask retained", permission="read", auto_approved=False)

        # Request-level evidence of the complete model-visible composition.
        self.finish(self.prompt(guarded, "instructions", [("read", {"filePath": str(self.project / "nested" / "data.txt")})]), guarded)
        request = self.model_requests("instructions")[0]
        system = "\n".join(json.dumps(msg["content"]) for msg in request["messages"] if msg["role"] == "system")
        positions = [system.index(marker) for marker in ["GLOBAL_SPIKE_INSTRUCTION", "ROOT_SPIKE_INSTRUCTION", "EXPLICIT_SPIKE_INSTRUCTION"]]
        assert positions == sorted(positions)
        assert "This session is agent-managed" in system
        assert "NESTED_SPIKE_INSTRUCTION" not in system
        assert "NESTED_SPIKE_INSTRUCTION" in json.dumps(self.model_requests("instructions")[-1]["messages"])
        shell = next(tool["function"]["description"] for tool in request["tools"] if tool["function"]["name"] == "bash")
        assert "Only commit, amend, push, or create PRs when explicitly requested." not in shell
        assert "ordinary local commits without separate confirmation" in shell
        baseline_shell = next(tool["function"]["description"] for tool in self.model_requests("native-deny")[0]["tools"] if tool["function"]["name"] == "bash")
        assert "Only commit, amend, push, or create PRs when explicitly requested." in baseline_shell
        manual_system = json.dumps(self.model_requests("manual-question")[0]["messages"])
        assert "This session is agent-managed" not in manual_system
        self.record("actual model-visible global root explicit subdirectory and shell instructions", initial_source_order=["global", "root", "explicit"], nested_loaded_after_read=True, conditional_shell_definition=True)

        # Native TaskTool creation, not a fabricated copy of the inheritance rules.
        parent = self.session(self.rules(), managed=True)
        self.fixture.scripts["child-commit"] = [("bash", {"command": "git commit --allow-empty -m 'child canary'", "description": "Does child inherit local commit allow?"})]
        future = self.prompt(parent, "new-child", [("task", {"description": "Synthetic child inheritance", "prompt": "SPIKE:child-commit", "subagent_type": "fixture-child"})])
        pending = wait_until(lambda: [item for item in self.api("GET", "/permission") if item["sessionID"] != parent])
        child = pending[0]["sessionID"]
        child_info = self.api("GET", f"/session/{child}")
        assert child_info["parentID"] == parent
        assert not child_info.get("metadata", {}).get(MARKER)
        assert {"permission": "question", "pattern": "*", "action": "deny"} in child_info["permission"]
        assert not any(rule["permission"] == "bash" and rule["action"] == "allow" for rule in child_info["permission"])
        self.api("POST", f"/permission/{pending[0]['id']}/reply", {"reply": "reject"})
        self.finish(future, parent)
        assert any(row.get("kind") == "system" and row.get("sessionID") == child and row.get("managed") for row in self.audit())
        self.record("native new child inherits denies but not marker or commit allow", child_commit_asked=True, parent_lineage_primer=True)

        # Reused child is prepared explicitly by the fixture operator, preserving
        # native todo/task denies. Product integration needs this same preflight.
        self.api("PATCH", f"/session/{child}", {"permission": self.rules(child_info["permission"])})
        self.fixture.scripts["child-reuse-commit"] = [("bash", {"command": "git commit --allow-empty -m 'reused child fixture'", "description": "Explicitly prepared reused child"})]
        since = len(self.audit())
        self.finish(self.prompt(parent, "reuse-child", [("task", {"description": "Synthetic reused child", "prompt": "SPIKE:child-reuse-commit", "subagent_type": "fixture-child", "task_id": child})]), parent)
        assert run(GIT, "rev-parse", "HEAD", cwd=self.project, env=self.env) != new_sha
        self.no_input(child, since)
        self.record("explicit child preflight permits reused-child local commit", same_child_id=True)

        # Native reused children are NOT automatically policy-refreshed.
        self.api("PATCH", f"/session/{child}", {"permission": [{"permission": "question", "pattern": "*", "action": "allow"}]})
        self.fixture.scripts["child-reuse-question"] = [("question", QUESTION), HAND_BACK]
        since = len(self.audit())
        self.finish(self.prompt(parent, "reuse-child-question", [("task", {"description": "Synthetic reuse drift", "prompt": "SPIKE:child-reuse-question", "subagent_type": "fixture-child", "task_id": child})]), parent)
        reused_rules = self.api("GET", f"/session/{child}")["permission"]
        assert reused_rules[-1] == {"permission": "question", "pattern": "*", "action": "allow"}, reused_rules
        assert any("INPUT_REQUIRED" in error for error in self.errors(child))
        self.no_input(child, since)
        self.record("reused child drift not refreshed natively but lineage guard holds", inherited_native_rules_refreshed=False, native_patch_permission_appends=True)

        # TaskTool also accepts a task_id whose actual parent is a manual root.
        # Parent-lineage recognition alone cannot cover this adoption path.
        foreign_child = self.session([{"permission": "question", "pattern": "*", "action": "allow"}], parent=manual)
        self.fixture.scripts["foreign-child-question"] = [("question", QUESTION)]
        future = self.prompt(parent, "foreign-child-reuse", [("task", {"description": "Synthetic unrelated child reuse", "prompt": "SPIKE:foreign-child-question", "subagent_type": "fixture-child", "task_id": foreign_child})])
        pending = wait_until(lambda: self.pending("/question", foreign_child))
        self.api("POST", f"/question/{pending[0]['id']}/reject", {})
        self.finish(future, parent)
        assert self.api("GET", f"/session/{foreign_child}")["parentID"] == manual
        self.record("managed task can reuse manual-lineage child outside lineage-only guard", native_question_reached=True, automatic_reparenting=False)

        # Local allow composition must account for the chosen agent's denies.
        # The prototype composes native session rules only, so expose this gap.
        restricted = self.session(self.rules(), managed=True)
        old = run(GIT, "rev-parse", "HEAD", cwd=self.project, env=self.env)
        self.finish(self.prompt(restricted, "agent-deny", [("bash", {"command": "git commit --allow-empty -m 'agent override fixture'", "description": "Synthetic agent-deny precedence"})], agent="fixture-restricted"), restricted)
        assert run(GIT, "rev-parse", "HEAD", cwd=self.project, env=self.env) != old
        self.record("session commit allow overrides explicit agent commit deny", agent_deny_preserved=False)

        before = len(self.canaries())
        since = len(self.audit())
        self.api("POST", f"/session/{parent}/shell", {"command": "git push publish-fixture", "agent": "build", "model": {"providerID": "fixture", "modelID": "gpt-fixture"}})
        assert len(self.canaries()) == before + 1
        assert not any(row.get("kind") == "before" and row.get("sessionID") == parent for row in self.audit()[since:])
        self.record("direct REST shell bypasses tool.execute.before and native rules", tool_before_calls=0, canary_executions=1, actual_remote_writes=0)

        # Known counterexamples demonstrate the incomplete remote-write boundary,
        # using harmless execution and local HTTP sink canaries, never a push.
        script = self.project / "indirect.py"
        script.write_text("import subprocess\nsubprocess.run(['git', 'push', 'publish-fixture'])\n")
        before = len(self.canaries())
        self.finish(self.prompt(guarded, "indirect-script", [("bash", {"command": "python3 indirect.py", "description": "Harmless nested execution canary"})]), guarded)
        assert len(self.canaries()) == before + 1
        self.finish(self.prompt(guarded, "generic-http", [("bash", {"command": f"curl -sS -X POST --data 'fixture-only' {self.fixture.url}/write-canary", "description": "Local synthetic HTTP write sink"})]), guarded)
        assert self.fixture.posts == ["fixture-only"]
        self.record("script and generic HTTP bypass lexical guard", nested_git_canary_executions=1, local_synthetic_http_posts=1, actual_remote_writes=0)

        self.api("PATCH", f"/session/{guarded}", {"title": "Reused managed fixture"})
        info = self.api("GET", f"/session/{guarded}")
        assert info["metadata"] == {"unrelated": "preserved", MARKER: 1}
        before = len(self.canaries())
        self.start(plugin=True)
        restored = self.api("GET", f"/session/{guarded}")
        assert restored["metadata"] == info["metadata"] and restored["permission"] == info["permission"]
        self.finish(self.prompt(guarded, "restart-guard", [("bash", {"command": "git push publish-fixture", "description": "Restart sticky guard canary"})]), guarded)
        assert len(self.canaries()) == before
        self.record("native metadata rules and managed guard survive runtime restart", same_session=True)

        # Writable metadata is not an authority boundary, regardless of merge.
        self.api("PATCH", f"/session/{guarded}", {"metadata": {MARKER: 0}})
        modified_metadata = self.api("GET", f"/session/{guarded}")["metadata"]
        assert modified_metadata[MARKER] == 0, modified_metadata
        before = len(self.canaries())
        self.finish(self.prompt(guarded, "marker-cleared", [("bash", {"command": "git push publish-fixture", "description": "Mutable-marker authority canary"})]), guarded)
        assert len(self.canaries()) == before + 1
        self.record("metadata mutation defeats marker-only guard", unrelated_metadata_preserved=modified_metadata.get("unrelated") == "preserved", canary_executions=1, actual_remote_writes=0)

    def close(self):
        self.stop()
        self.fixture.server.shutdown()
        self.pool.shutdown(wait=False, cancel_futures=True)
        assert run(GIT, "--git-dir", str(self.remote), "show-ref", env=self.env) == self.refs
        report = {"completed": self.completed, "runtime": self.version, "git": run(GIT, "--version"), "actual_remote_writes": 0, "fixture_refs_unchanged": True, "cases": self.results}
        (self.root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        (self.root / "model-requests.json").write_text(json.dumps(self.fixture.requests, indent=2))
        print("Evidence:", self.root, flush=True)


if __name__ == "__main__":
    probe = Probe()
    try:
        probe.execute()
    finally:
        probe.close()
