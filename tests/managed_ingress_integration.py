"""Actual MCP/OpenLive gateways and pinned A2A service against disposable runtime."""
import json
import os
from pathlib import Path
import socket
import subprocess
import urllib.error
import urllib.request
from uuid import uuid4
from helpers.managed_runtime import Runtime, ROOT, wait
from managed_policy_integration import QUESTION


def main():
    fixture = Runtime()
    a2a = None
    log = None
    try:
        fixture.cfg["command"] = {"managed-test": {"template": "CASE:a2a-command", "agent": "build"}}
        fixture.start()
        for name in ("mcp-work", "voice-work", "a2a-first", "a2a-preferred", "a2a-async", "a2a-command"):
            fixture.scripts[name] = [QUESTION]
        for name in ("mcp-follow", "a2a-follow", "voice-follow"):
            fixture.scripts[name] = ["Normal same-session follow-up completed"]
        script = fixture.root / "gateways.mjs"
        script.write_text(f'''
import assert from 'node:assert/strict';
import {{ OpenCodeGateway as MCP }} from {json.dumps((ROOT / "adapters/mcp/dist/opencode.js").as_uri())};
import {{ OpenCodeGateway as Voice }} from {json.dumps((ROOT / "adapters/openlive-acp/dist/opencode/gateway.js").as_uri())};
const project = {json.dumps(str(fixture.project))};
const url = {json.dumps(fixture.url)};
const runtime = {{schema:1,project,projectHash:'fixture',projectName:'fixture',backendUrl:url,generation:'fixture',opencodeVersion:'1.18.33',listenHost:'127.0.0.1',listenPort:40960,credentialFile:'/not-used'}};
const mcp = new MCP(runtime);
const created = await mcp.createSession('Actual MCP work');
const receipt = await mcp.sendMessage(created.session_id, 'CASE:mcp-work');
for (let i=0;i<100;i++) {{
 const status = await mcp.getSessionStatus(created.session_id, receipt.message_id);
 if(status.state==='completed') break;
 await new Promise(r=>setTimeout(r,50));
}}
const result = await mcp.getTaskResult(created.session_id, receipt.message_id);
assert.equal(result.state,'completed');
assert.match(JSON.stringify(result),/INPUT_REQUIRED/);
assert.equal((await mcp.getSessionStatus(created.session_id)).pending_input.questions,0);
await mcp.sendMessage(created.session_id,'CASE:mcp-follow');
const voice = new Voice(runtime);
const manager = await voice.ensureManager(undefined,'Neutral manager');
const settings = {{agent:'build',model:{{providerID:'fixture',modelID:'gpt-fixture'}}}};
const work = await voice.createSession('Actual voice work',settings);
const updates=[];
await voice.prompt(work.id,'CASE:voice-work',settings,'msg_'+Date.now(),new AbortController().signal,async u=>updates.push(u),{{onSubmitted(){{}},onAssistantMessage(){{}},preserveBackend(){{}}}});
assert.match(updates.filter(u=>u.type==='text').map(u=>u.text).join(''),/INPUT_REQUIRED/);
await voice.prompt(work.id,'CASE:voice-follow',settings,'msg_'+(Date.now()+1),new AbortController().signal,async ()=>{{}},{{onSubmitted(){{}},onAssistantMessage(){{}},preserveBackend(){{}}}});
console.log(JSON.stringify({{manager,work:work.id,mcp:created.session_id}}));
await mcp.close();
''')
        outcome = subprocess.check_output(["node", str(script)], env=fixture.env, text=True)
        ids = json.loads(outcome.strip().splitlines()[-1])
        state = json.loads(next((fixture.root / "data/opencode/managed-sessions").glob("*.json")).read_text())
        assert ids["manager"] not in state["sessions"]
        assert ids["mcp"] in state["sessions"] and ids["work"] in state["sessions"]
        print("PASS actual MCP and OpenLive creation/continuation plus neutral manager", flush=True)

        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0)); port = port_socket.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        venv = Path(os.environ.get("OCVM_MANAGED_A2A_BIN", str(Path.home() / ".local/share/opencode-a2a-venv/bin")))
        assert (venv / "python").exists(), "pinned A2A runtime required for this gate"
        env = {**fixture.env, "A2A_HOST": "127.0.0.1", "A2A_PORT": str(port), "A2A_PUBLIC_URL": url, "A2A_STATIC_AUTH_CREDENTIALS": json.dumps([{"scheme": "bearer", "token": "local-fixture-only", "principal": "fixture"}]), "OPENCODE_BASE_URL": fixture.url, "OPENCODE_WORKSPACE_ROOT": str(fixture.project), "A2A_ALLOW_DIRECTORY_OVERRIDE": "false", "A2A_ENABLE_SESSION_SHELL": "false", "A2A_ENABLE_WORKSPACE_MUTATIONS": "false", "A2A_TASK_STORE_BACKEND": "memory"}
        log = (fixture.root / "a2a.log").open("w")
        a2a = subprocess.Popen([str(venv / "python"), str(ROOT / "runtime/a2a-managed.py"), str(venv / "opencode-a2a"), "serve"], env=env, cwd=fixture.project, stdout=log, stderr=log)

        def ready():
            assert a2a.poll() is None, "inspect owned A2A fixture log"
            try:
                with urllib.request.urlopen(url + "/.well-known/agent-card.json", timeout=1) as response:
                    return response.status == 200
            except (OSError, urllib.error.URLError): return False
        wait(ready, 60)

        def rpc(method, params, extension="session-binding:v1"):
            request = urllib.request.Request(url + "/", json.dumps({"jsonrpc": "2.0", "id": str(uuid4()), "method": method, "params": params}).encode(), {"Content-Type": "application/json", "Authorization": "Bearer local-fixture-only", "A2A-Extensions": "urn:opencode-a2a:extension:" + extension})
            with urllib.request.urlopen(request, timeout=45) as response: result = json.loads(response.read())
            assert "error" not in result, result
            return result["result"]

        def work(text, context, preferred=None):
            message = {"messageId": str(uuid4()), "role": "ROLE_USER", "parts": [{"text": "CASE:" + text}], "contextId": context}
            if preferred: message["metadata"] = {"shared": {"session": {"id": preferred}}}
            return rpc("SendMessage", {"message": message})["task"]

        first = work("a2a-first", "same-context")
        sid = first["metadata"]["shared"]["session"]["id"]
        assert "INPUT_REQUIRED" in json.dumps(first)
        follow = work("a2a-follow", "same-context")
        assert follow["metadata"]["shared"]["session"]["id"] == sid
        manual = fixture.session()
        preferred = work("a2a-preferred", "preferred-context", manual)
        assert preferred["metadata"]["shared"]["session"]["id"] == manual
        assert "INPUT_REQUIRED" in json.dumps(preferred)
        print("PASS actual A2A creation/context/preferred-session adoption", flush=True)
        rpc("opencode.sessions.prompt_async", {"session_id": sid, "request": {"parts": [{"type": "text", "text": "CASE:a2a-async"}]}}, "session-management:v1")
        def async_finished():
            messages = fixture.api("GET", f"/session/{sid}/message")
            users = {m["info"]["id"] for m in messages if m["info"]["role"] == "user" and any(p.get("text") == "CASE:a2a-async" for p in m["parts"])}
            return any(m["info"].get("parentID") in users and m["info"].get("finish") == "stop" and m["info"].get("time", {}).get("completed") for m in messages)
        wait(async_finished)
        command = rpc("opencode.sessions.command", {"session_id": sid, "request": {"command": "managed-test", "arguments": "fixture"}}, "session-management:v1")
        assert "INPUT_REQUIRED" in json.dumps(command)
        assert not fixture.api("GET", "/question")
        print("PASS actual A2A prompt_async/command without native Questions", flush=True)
    finally:
        if a2a:
            a2a.terminate()
            try: a2a.wait(timeout=10)
            except subprocess.TimeoutExpired: a2a.kill(); a2a.wait()
        if log: log.close()
        fixture.close()


if __name__ == "__main__": main()
