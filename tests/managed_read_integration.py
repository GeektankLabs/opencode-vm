"""Real OpenCode/MCP/strict-Zod single-file Read regressions in disposable state."""
import json
from pathlib import Path
import subprocess
from helpers.managed_runtime import ROOT, Runtime, wait


BRIDGE = r"""
import assert from 'node:assert/strict';
import { OpenCodeGateway } from '__GATEWAY__';
import { McpHttpServer } from '__HTTP__';
import { Client } from '__CLIENT__';
import { StreamableHTTPClientTransport } from '__TRANSPORT__';
const input = JSON.parse(process.argv[2]);
const runtime = {schema:1,project:input.project,projectHash:'fixture',projectName:'fixture',backendUrl:input.url,
 generation:'fixture',opencodeVersion:'1.19.0',listenHost:'127.0.0.1',listenPort:40960,credentialFile:'/not-used',activityJournalEnabled:false};
const gateway = new OpenCodeGateway(runtime);
const token = 'fixture-token-' + 'x'.repeat(48);
const server = new McpHttpServer(runtime, token, gateway);
const client = new Client({name:'managed-read-fixture',version:'1'});
try {
 const port = await server.start();
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
  {requestInit:{headers:{'X-OCVM-MCP-Token':token}}}));
 const declaration = input.files ? {scope_read_files:input.files} : {};
 let sid = input.session;
 if (!sid) {
  if (input.worker) {
   const inventory = await client.callTool({name:'list_monitors',arguments:{}});
   let mid = inventory.structuredContent.monitors[0]?.monitor_id;
   if (!mid) {
    const monitor = await client.callTool({name:'create_monitor',arguments:{title:'Disposable Read monitor',task_id:'task_11111111-1111-4111-8111-111111111111'}});
    assert.notEqual(monitor.isError,true,JSON.stringify(monitor)); mid=monitor.structuredContent.monitor.monitor_id;
   }
   const worker = await client.callTool({name:'create_monitor_worker',arguments:{monitor_id:mid,
    title:'Disposable Read worker',scope:'Free text is metadata, not a Read grant',...declaration}});
   assert.notEqual(worker.isError,true,JSON.stringify(worker));
   sid = worker.structuredContent.worker.runtime_session_id;
  } else {
   const created = await client.callTool({name:'create_session',arguments:{title:'Disposable Read root',...declaration}});
   if (input.invalid) { assert.equal(created.isError,true); console.log(JSON.stringify({invalid:true})); process.exitCode=0; }
   else { assert.notEqual(created.isError,true,JSON.stringify(created)); sid = created.structuredContent.session_id; }
  }
 }
 if (sid) {
  const sent = await client.callTool({name:'send_message',arguments:{session_id:sid,message:'CASE:'+input.case,...declaration}});
  assert.notEqual(sent.isError,true,JSON.stringify(sent));
  for (let n=0;n<600;n++) {
   const status = await client.callTool({name:'get_session_status',arguments:{session_id:sid,message_id:sent.structuredContent.message_id}});
   assert.notEqual(status.isError,true,JSON.stringify(status));
   if (status.structuredContent.state==='completed') break;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const result = await gateway.getTaskResult(sid,sent.structuredContent.message_id);
  assert.equal(result.state,'completed',JSON.stringify(result));
  console.log(JSON.stringify({session:sid,receipt:sent.structuredContent.message_id,agent:(await gateway.getSessionDetails(sid)).agent}));
 }
} finally { await client.close(); await server.close(); await gateway.close(); }
"""


def check():
    fixture = Runtime()
    try:
        fixture.cfg["permission"].pop("*")
        fixture.cfg["permission"]["read"] = {"*": "allow", "*.env": "ask", "*.env.*": "ask"}
        fixture.cfg["agent"]["fixture-reviewer"] = {"description": "Read-only fixture reviewer", "mode": "primary", "permission": {"edit": "deny"}}
        route = fixture.root / "e2e50-nrt-runtime.env"
        route.write_text("PORT=1234\nDB=fixture\nLANE=smoke\nCONTROL_PORT=1235\n")
        neighbour = fixture.root / "neighbour.env"
        neighbour.write_text("DB=neighbour\n")
        bridge = fixture.root / "read-bridge.mjs"
        replacements = {
            "__GATEWAY__": ROOT / "adapters/mcp/dist/opencode.js",
            "__HTTP__": ROOT / "adapters/mcp/dist/http.js",
            "__CLIENT__": ROOT / "adapters/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
            "__TRANSPORT__": ROOT / "adapters/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
        }
        source = BRIDGE
        for key, path in replacements.items():
            source = source.replace(key, path.as_uri())
        bridge.write_text(source)
        fixture.start()

        def ingress(case, actions, files=None, **options):
            fixture.scripts[case] = actions
            payload = {"project": str(fixture.project), "url": fixture.url, "case": case, **options}
            if files is not None:
                payload["files"] = [str(file) for file in files]
            try:
                reply = subprocess.check_output(["node", str(bridge), json.dumps(payload)], env=fixture.env, text=True, stderr=subprocess.PIPE, timeout=90)
            except subprocess.CalledProcessError as error:
                raise AssertionError(error.stderr) from error
            return json.loads(reply.strip().splitlines()[-1])

        def messages(sid):
            return fixture.api("GET", f"/session/{sid}/message")

        def read_completed(sid, file):
            return any(part.get("tool") == "read" and part.get("state", {}).get("status") == "completed"
                       and part["state"].get("input", {}).get("filePath") == str(file)
                       for message in messages(sid) for part in message["parts"])

        def blocker(sid):
            return any(message["info"].get("finish") == "stop" and "INPUT_REQUIRED:" in str(message["parts"])
                       for message in messages(sid))

        root = ingress("exact-root", [("read", {"filePath": str(route)}), "Exact route read complete"], [route])["session"]
        assert read_completed(root, route)
        assert not fixture.events, "declared native Read must emit no permission.asked"
        assert not fixture.pending_permissions()
        print("PASS actual MCP/Zod root exact Read, native relative rule, no Ask event", flush=True)

        missing = ingress("missing-declaration", [("read", {"filePath": str(route)})])["session"]
        assert blocker(missing) and not read_completed(missing, route)
        neighbour_root = ingress("neighbour-blocked", [("read", {"filePath": str(neighbour)})], [route])["session"]
        assert blocker(neighbour_root) and not read_completed(neighbour_root, neighbour)
        ingress("authorized-followup", [("read", {"filePath": str(route)}), "Authorized same-session follow-up"], [route], session=missing)
        assert read_completed(missing, route)
        print("PASS missing declaration/neighbour terminal blockers and authorized same-session follow-up", flush=True)

        child_actions = [("task", {"description": "Exact Read child", "subagent_type": "fixture-child", "prompt": "CASE:read-child"}), "Child completed"]
        fixture.scripts["read-child"] = [("read", {"filePath": str(route)}), "Child route complete"]
        parent = ingress("new-child", child_actions, [route])["session"]
        child = fixture.api("GET", f"/session/{parent}/children")[0]["id"]
        assert read_completed(child, route)
        fixture.scripts["read-reused"] = [("read", {"filePath": str(neighbour)}), "Reused child route complete"]
        ingress("reused-child", [("task", {"description": "Reused Read child", "subagent_type": "fixture-child", "prompt": "CASE:read-reused", "task_id": child}), "Reused child completed"], [route, neighbour], session=parent)
        assert read_completed(child, neighbour)
        print("PASS new/reused native children inherit fresh exact declarations", flush=True)

        worker = ingress("monitor-worker", [("read", {"filePath": str(route)}), "Worker route complete"], [route], worker=True)["session"]
        assert read_completed(worker, route)
        metadata_worker = ingress("worker-metadata", [("read", {"filePath": str(route)})], worker=True)["session"]
        assert blocker(metadata_worker) and not read_completed(metadata_worker, route)
        print("PASS structured Monitorworker ingress; free-text scope grants nothing", flush=True)

        assert ingress("invalid-glob", [], [str(route) + "*"], invalid=True)["invalid"]
        fixture.cfg["default_agent"] = "fixture-reviewer"
        fixture.start()
        reviewer = ingress("reviewer-root", [("read", {"filePath": str(route)}), "Reviewer route complete"], [route])
        assert reviewer["agent"] == "fixture-reviewer" and read_completed(reviewer["session"], route)
        rules = fixture.api("GET", f"/session/{reviewer['session']}")["permission"]
        assert any(rule["permission"] == "edit" and rule["action"] == "deny" for rule in rules)
        print("PASS separate reviewer root exact grant preserves read-only restriction", flush=True)

        denied = fixture.session(permission=[{"permission": "read", "pattern": "*.env", "action": "deny"}])
        fixture.adopt(denied, scope_read_files=[str(route)])
        fixture.finish(fixture.prompt(denied, "read-denied", [("read", {"filePath": str(route)})]), denied)
        assert blocker(denied) and not read_completed(denied, route)
        disabled = fixture.session()
        fixture.adopt(disabled, scope_read_files=[str(route)])
        fixture.finish(fixture.prompt(disabled, "read-disabled", [("read", {"filePath": str(route)})], tools={"read": False}), disabled)
        assert not read_completed(disabled, route)
        assert not fixture.pending_permissions()
        assert not fixture.events, "preconfigured read grants and blockers must not open native Ask dialogs"
        print("PASS explicit Read deny and tool disable win, zero managed Ask events", flush=True)

        unexpected = fixture.session(permission=[{"permission": "bash", "pattern": "*", "action": "ask"}])
        fixture.adopt(unexpected)
        result = fixture.finish(fixture.prompt(unexpected, "unexpected-bash", [("bash", {"command": "pwd", "description": "Unexpected managed permission canary"})]), unexpected)
        assert "INPUT_REQUIRED:" in str(result["parts"]) and "Permission bash" in str(result["parts"])
        wait(lambda: any(event["sessionID"] == unexpected and event["permission"] == "bash" for event in fixture.events))
        assert not any(item["sessionID"] == unexpected for item in fixture.pending_permissions())
        assert fixture.calls["unexpected-bash"] == 1, "watcher must stop an uncooperative permission retry loop"
        print("PASS unexpected managed Bash Ask rejected without approval and stored terminally", flush=True)

        manual = fixture.session()
        future = fixture.prompt(manual, "manual-read", [("read", {"filePath": str(route)}), "manual complete"])
        pending = wait(lambda: [item for item in fixture.pending_permissions() if item["sessionID"] == manual])
        assert pending[0]["permission"] == "read"
        fixture.reject_permission(pending[0]["id"])
        future.result(timeout=15)
        wait(lambda: fixture.api("GET", "/session/status").get(manual, {"type": "idle"})["type"] == "idle")
        assert not blocker(manual)
        print("PASS manual Read remains interactive and unadopted", flush=True)
    finally:
        fixture.close()


if __name__ == "__main__":
    check()
