"""Disposable real OpenCode/model/Git fixture used by maintained managed tests."""
import concurrent.futures
import http.client
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

ROOT = Path(__file__).resolve().parents[2]


def run(*args, cwd=None, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True, stderr=subprocess.STDOUT).strip()


def wait(callback, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = callback()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("fixture deadline expired")


class Runtime:
    def __init__(self, binary=None, sdk="@ai-sdk/openai-compatible"):
        self.binary = binary or shutil.which("opencode")
        self.git = shutil.which("git")
        self.root = Path(tempfile.mkdtemp(prefix="ocvm-managed-", dir="/tmp/opencode"))
        self.project = self.root / "project"
        self.project.mkdir()
        self.config = self.root / "config" / "opencode"
        self.config.mkdir(parents=True)
        self.socket = str(self.root / "control.sock")
        self.scripts = {}
        self.requests = []
        self.calls = {}
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=8)
        self.process = None
        self.log = None
        fixture = self

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.requests.append(body)
                texts = [json.dumps(m.get("content", "")) for m in body.get("messages", body.get("input", [])) if m.get("role") == "user"]
                matches = re.findall(r"CASE:([a-zA-Z0-9_-]+)", " ".join(texts))
                name = matches[-1] if matches else "internal"
                step = fixture.calls.get(name, 0)
                fixture.calls[name] = step + 1
                script = fixture.scripts.get(name, ["fixture summary"])
                action = script[min(step, len(script) - 1)]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                if "/messages" in self.path:
                    message = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": "gpt-fixture", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
                    content = {"type": "text", "text": ""} if isinstance(action, str) else {"type": "tool_use", "id": "fixture-call", "name": action[0], "input": {}}
                    delta = {"type": "text_delta", "text": action} if isinstance(action, str) else {"type": "input_json_delta", "partial_json": json.dumps(action[1])}
                    events = [{"type": "message_start", "message": message}, {"type": "content_block_start", "index": 0, "content_block": content}, {"type": "content_block_delta", "index": 0, "delta": delta}, {"type": "content_block_stop", "index": 0}, {"type": "message_delta", "delta": {"stop_reason": "end_turn" if isinstance(action, str) else "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 10}}, {"type": "message_stop"}]
                    for event in events:
                        self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
                elif "/responses" in self.path:
                    if isinstance(action, str):
                        item = {"id": "answer", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": action, "annotations": []}]}
                        events = [{"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}}, {"type": "response.content_part.added", "item_id": "answer", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}}, {"type": "response.output_text.delta", "item_id": "answer", "output_index": 0, "content_index": 0, "delta": action}, {"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": {"id": "fixture", "status": "completed", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 10, "total_tokens": 20}}}]
                    else:
                        item = {"id": "fc_fixture", "type": "function_call", "status": "completed", "call_id": "fixture-call", "name": action[0], "arguments": json.dumps(action[1])}
                        events = [{"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "arguments": ""}}, {"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": item["arguments"]}, {"type": "response.function_call_arguments.done", "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]}, {"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": {"id": "fixture", "status": "completed", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 10, "total_tokens": 20}}}]
                    for event in events:
                        self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
                else:
                    delta = {"content": action} if isinstance(action, str) else {"tool_calls": [{"index": 0, "id": "fixture-call", "type": "function", "function": {"name": action[0], "arguments": json.dumps(action[1])}}]}
                    base = {"id": "fixture", "object": "chat.completion.chunk", "created": 0, "model": "fixture"}
                    events = [{**base, "choices": [{"index": 0, "delta": {"role": "assistant", **delta}, "finish_reason": None}]}, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop" if isinstance(action, str) else "tool_calls"}], "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}]
                    for event in events:
                        self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")

        self.model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=self.model.serve_forever, daemon=True).start()
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.root / "home"), "SHELL": "/bin/bash", "LANG": "C.UTF-8", "OCVM_MANAGED_POLICY_SOCKET": self.socket}
        for key, folder in [("CONFIG", "config"), ("DATA", "data"), ("CACHE", "cache"), ("STATE", "state")]:
            self.env[f"XDG_{key}_HOME"] = str(self.root / folder)
        for flag in ["DISABLE_DEFAULT_PLUGINS", "DISABLE_MODELS_FETCH", "DISABLE_EXTERNAL_SKILLS", "DISABLE_CLAUDE_CODE_SKILLS", "ENABLE_QUESTION_TOOL"]:
            self.env["OPENCODE_" + flag] = "true"
        run(self.git, "init", "-q", str(self.project), env=self.env)
        run(self.git, "config", "user.name", "Managed Fixture", cwd=self.project, env=self.env)
        run(self.git, "config", "user.email", "fixture@example.invalid", cwd=self.project, env=self.env)
        (self.project / "work.txt").write_text("baseline\n")
        run(self.git, "add", "work.txt", cwd=self.project, env=self.env)
        run(self.git, "commit", "-qm", "fixture baseline", cwd=self.project, env=self.env)
        self.baseline = run(self.git, "rev-parse", "HEAD", cwd=self.project, env=self.env)
        self.bare = self.root / "read-fixture.git"
        run(self.git, "clone", "--bare", "-q", str(self.project), str(self.bare), env=self.env)
        self.remote_refs = run(self.git, "--git-dir", str(self.bare), "show-ref", env=self.env)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.canary = self.root / "git-canary"
        (self.bin / "git").write_text(f'''#!/usr/bin/python3
import os,sys
if any(a in ("push", "send-pack", "http-push", "receive-pack") for a in sys.argv[1:]):
    with open({str(self.canary)!r}, "a") as f: f.write("publishing canary\\n")
    sys.exit(73)
os.execv({self.git!r}, [{self.git!r}] + sys.argv[1:])
''')
        (self.bin / "git").chmod(0o700)
        self.env["PATH"] = str(self.bin) + ":" + self.env["PATH"]
        self.cfg = {"$schema": "https://opencode.ai/config.json", "model": "fixture/gpt-fixture", "small_model": "fixture/gpt-fixture", "autoupdate": False, "snapshot": False, "formatter": False, "lsp": False, "enabled_providers": ["fixture"], "permission": {"*": "allow", "bash": {"*": "allow", "git commit *": "ask", "git push *": "deny"}}, "plugin": [(ROOT / "runtime/managed-policy.mjs").as_uri()], "provider": {"fixture": {"npm": sdk, "options": {"baseURL": f"http://127.0.0.1:{self.model.server_port}/v1", "apiKey": "synthetic-fixture"}, "models": {"gpt-fixture": {"name": "Fixture", "limit": {"context": 100000, "output": 8192}}}}}, "agent": {"fixture-child": {"description": "Managed regression child", "mode": "subagent", "permission": {"question": "allow"}}}}
        (self.config / "AGENTS.md").write_text("GLOBAL_MANAGED_FIXTURE\nIf the request is ambiguous or you see multiple reasonable interpretations, surface them and ask before implementing. If no user is available to ask (autonomous or A2A runs), choose the most minimal interpretation consistent with the request and state the assumption in your report.\n")
        (self.project / "AGENTS.md").write_text("PROJECT_MANAGED_FIXTURE\n")
        run(shutil.which("npm"), "install", "--prefix", str(self.config), "--ignore-scripts", "--no-audit", "--no-fund", "@opencode-ai/plugin@" + run(self.binary, "--version"), env=self.env)

    def start(self):
        self.stop()
        (self.config / "opencode.json").write_text(json.dumps(self.cfg))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        self.log = (self.root / "runtime.log").open("a")
        self.process = subprocess.Popen([self.binary, "serve", "--hostname", "127.0.0.1", "--port", str(port)], cwd=self.project, env=self.env, stdout=self.log, stderr=self.log)

        def ready():
            assert self.process.poll() is None
            try:
                return self.api("GET", "/global/health")
            except (OSError, urllib.error.URLError):
                return False
        wait(ready, 60)
        self.api("GET", "/config")
        wait(lambda: Path(self.socket).exists())

    def api(self, method, path, body=None):
        query = "" if path == "/global/health" else "?directory=" + urllib.parse.quote(str(self.project))
        request = urllib.request.Request(self.url + path + query, json.dumps(body).encode() if body is not None else None, {"Content-Type": "application/json"} if body is not None else {}, method=method)
        with urllib.request.urlopen(request, timeout=1 if path == "/global/health" else 45) as response:
            value = response.read()
            return json.loads(value) if value else None

    def adopt(self, sid, ingress="mcp"):
        connection = http.client.HTTPConnection("localhost", timeout=10)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.connect(self.socket)
        connection.request("POST", "/adopt", json.dumps({"session_id": sid, "ingress": ingress}), {"Content-Type": "application/json"})
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        assert response.status == 200, data
        return data

    def session(self, **changes):
        return self.api("POST", "/session", {"title": "Managed regression", **changes})["id"]

    def prompt(self, sid, name, actions, **changes):
        self.scripts[name] = actions
        return self.pool.submit(self.api, "POST", f"/session/{sid}/message", {"agent": "build", "model": {"providerID": "fixture", "modelID": "gpt-fixture"}, "parts": [{"type": "text", "text": "CASE:" + name}], **changes})

    def finish(self, future, sid):
        answer = future.result(timeout=50)
        assert answer["info"].get("finish") == "stop", answer
        assert not answer["info"].get("error"), answer
        wait(lambda: self.api("GET", "/session/status").get(sid, {"type": "idle"})["type"] == "idle")
        assert not any(item["sessionID"] == sid for item in self.api("GET", "/question"))
        return answer

    def stop(self):
        if self.process:
            self.process.terminate()
            try: self.process.wait(timeout=10)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()
            self.process = None
        if self.log: self.log.close(); self.log = None

    def close(self):
        self.stop()
        self.model.shutdown()
        self.pool.shutdown(wait=False, cancel_futures=True)
        assert run(self.git, "--git-dir", str(self.bare), "show-ref", env=self.env) == self.remote_refs
        print("Fixture evidence:", self.root, flush=True)
