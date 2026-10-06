import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { DashboardCollector } from "./dashboard.js";
import type { DashboardReader, Inventory, Session, Tasks } from "./dashboard.js";
import { dashboardHandler } from "./dashboard-http.js";
import { OpenCodeGateway } from "./opencode.js";
import type { RuntimeDescriptor } from "./types.js";

export function fixture() {
  let time = 100000;
  const native = (id: string): Inventory["sessions"][number] => ({ id, title: id, projectID: "native",
    time: { created: 1, updated: 2 }, location: { directory: "/project" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  const inventory = { sessions: [native("ses_A"), native("ses_child"), native("ses_free")], complete: true, observed_at: new Date(time).toISOString() };
  const row = (id: string): Session => ({ session_id: id, title: id, parent_session_id: null, kind: "root", archived: false,
    backend_activity: "busy", pending_input: { permissions: 0, questions: 0, scope: "session" }, observed_at: new Date(time).toISOString(), last_activity_at: time,
    current_runtime: { provider_id: "new", model_id: "setting", variant: "medium", source: "session_setting" },
    turns: [{ user_message_id: "msg_new", state: "running", active: true, finish: null, completed_at: null,
      runtime: { provider_id: "old", model_id: "used", variant: "high", source: "assistant_message", message_id: "assistant" } }], turns_truncated: false, history_has_more: false });
  const rows = new Map(inventory.sessions.map(s => [s.id,row(s.id)]));
  rows.get("ses_child")!.parent_session_id = "ses_A"; rows.get("ses_child")!.kind = "child";
  const tasks: Tasks = ["task_A","task_B"].map(task_id => ({ task_id, title: task_id, board_status: "done", board_project_id: "workstream", links: [{ session_id: "ses_A", message_id: "msg_old" }] }));
  let boardFail = false, sessionFail = false, calls = 0;
  const reader: DashboardReader = { inventory: async () => inventory,
    session: async s => { calls++; if(sessionFail)throw new Error(); return { ...rows.get(s.id)!, observed_at:new Date(time).toISOString() }; },
    board: async () => { if(boardFail)throw new Error(); return tasks; }, activity: async () => ({ epoch:"epoch",recent:[] }) };
  const collector = new DashboardCollector({ id:"project",name:"Test" },"generation",reader,()=>time);
  return { collector, reader, inventory, rows, tasks, native, row, advance:(n:number)=>time+=n,
    boardFail:()=>boardFail=true, sessionFail:()=>sessionFail=true, calls:()=>calls };
}

test("ALL, multi-task IDs, indirect child provenance, unbound turns and runtime separation",async()=>{
  const f=fixture(); await f.collector.tick(); const s=f.collector.snapshot(false);
  assert.ok("sessions" in s);
  assert.equal(s.counts.active_sessions,3); assert.equal(s.counts.active_tasks,2);
  assert.equal(s.sessions[0]?.associations.length,2);
  assert.equal(s.sessions.find(x=>x.session_id==="ses_child")?.associations[0]?.scope,"parent_indirect");
  assert.equal(s.sessions.find(x=>x.session_id==="ses_free")?.binding_state,"unbound");
  assert.equal(s.sessions[0]?.current_turn_unbound,true);
  assert.notDeepEqual(s.sessions[0]?.current_runtime,s.sessions[0]?.turns[0]?.runtime);
  assert.deepEqual(f.collector.snapshot(true).counts,s.counts);
  assert.equal(f.collector.snapshot(true).snapshot_id,s.snapshot_id);
  assert.ok(!JSON.stringify(s).includes("description"));
});
test("idle parent does not hide busy child; archived busy remains anomaly",async()=>{
  const f=fixture(); const parent=f.rows.get("ses_A")!;
  parent.backend_activity="idle"; parent.turns=[];
  f.rows.get("ses_child")!.archived=true;
  await f.collector.tick();const s=f.collector.snapshot(false);assert.ok("sessions" in s);
  assert.equal(s.counts.active_sessions,2);
  assert.equal(s.sessions.find(x=>x.session_id==="ses_A")?.state,"idle");
  assert.equal(s.sessions.find(x=>x.session_id==="ses_child")?.anomaly,"ARCHIVED_ACTIVE");
});
test("an idle backend with older active turn evidence is unknown, not deceptively idle",async()=>{
  const f=fixture(),s=f.rows.get("ses_A")!;s.backend_activity="idle";
  s.turns.push({...s.turns[0]!,user_message_id:"latest",state:"completed",active:false,finish:"stop"});
  await f.collector.tick();const snapshot=f.collector.snapshot(false);assert.ok("sessions" in snapshot);
  assert.equal(snapshot.sessions.find(s=>s.session_id==="ses_A")?.state,"unknown");
});
test("Input, retry, terminal and idle are independent of Board Done",async()=>{
  const f=fixture(); f.rows.get("ses_A")!.pending_input.questions=1;
  f.rows.get("ses_child")!.backend_activity="retry";
  const free=f.rows.get("ses_free")!;free.backend_activity="idle";free.turns[0]!.state="aborted";free.turns[0]!.active=false;
  await f.collector.tick();const s=f.collector.snapshot(false);assert.ok("sessions" in s);
  assert.deepEqual(s.sessions.map(x=>x.state),["input_required","retry","idle"]);
  assert.equal(s.sessions[2]?.turns[0]?.state,"aborted");
  assert.equal(s.tasks[0]?.board_status,"done");
});
test("cache reads never refresh source time; error is immediate, bindings unknown and stale counts null",async()=>{
  const f=fixture();await f.collector.tick();const before=f.collector.snapshot(true).sources.sessions!.observed_at;
  f.advance(16000);assert.equal(f.collector.snapshot(true).sources.sessions!.state,"stale");
  assert.equal(f.collector.snapshot(true).sources.sessions!.observed_at,before);
  f.boardFail();await f.collector.tick();const s=f.collector.snapshot(false);assert.ok("sessions" in s);
  assert.equal(s.sources.board!.state,"degraded");assert.equal(s.sessions[0]?.binding_state,"unknown");
  f.sessionFail();f.advance(5000);await f.collector.tick();assert.equal(f.collector.snapshot(true).counts.active_sessions,null);
  f.collector.resetGeneration("next");assert.equal(f.collector.snapshot(true).counts.active_sessions,null);
  assert.equal(f.collector.snapshot(true).counts.known_active_sessions,0);
});
test("first-read gaps retain admitted identities as unknown, not hidden or falsely idle",async()=>{
  const f=fixture();f.sessionFail();await f.collector.tick();
  const s=f.collector.snapshot(false);assert.ok("sessions" in s);
  assert.equal(s.sessions.length,0);assert.equal(s.unknown_sessions.length,3);
  assert.equal(s.counts.active_sessions,null);assert.equal(s.sources.sessions?.state,"degraded");
});
test("200 sessions are not cut to 20; >50 active and discovery overflow are honest",async()=>{
  const f=fixture(); f.inventory.sessions=Array.from({length:200},(_,i)=>f.native(`s${i}`));
  for(const s of f.inventory.sessions){const r=f.row(s.id);r.backend_activity="idle";r.turns=[];f.rows.set(s.id,r);}
  f.rows.get("s199")!.backend_activity="retry";
  await f.collector.tick();const s=f.collector.snapshot(false);assert.ok("sessions" in s);
  assert.equal(s.sessions.length,200);assert.equal(s.counts.active_sessions,1);
  for(let i=0;i<51;i++)f.rows.get(`s${i}`)!.backend_activity="busy";
  f.advance(15000);await f.collector.tick();assert.equal(f.collector.snapshot(true).counts.active_sessions,null);
  f.inventory.complete=false;f.advance(15000);await f.collector.tick();assert.equal(f.collector.snapshot(true).coverage.sessions_complete,false);
});
test("GET boundary rejects mutation/view/foreign/Host/Origin/auth; detail and summary use one cache",async t=>{
  const f=fixture();await f.collector.tick();
  const config={projectHash:"project",generation:"generation",listenPort:0,authEnabled:true,auth:{username:"u",password:"p"},cert:"",key:"",assets:"/missing"};
  const server=createServer(dashboardHandler(config,f.collector));server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>server.close());config.listenPort=(server.address() as {port:number}).port;
  const base=`http://127.0.0.1:${config.listenPort}`;
  const headers={authorization:"Basic dTpw"};
  assert.equal((await fetch(base+"/api/v1/status")).status,401);
  assert.equal((await fetch(base+"/api/v1/status",{headers,method:"POST"})).status,405);
  for(const q of ["?view=wrong","?project=foreign","?view=summary&view=detail"])assert.equal((await fetch(base+"/api/v1/status"+q,{headers})).status,400);
  assert.equal((await fetch(base+"/foreign",{headers})).status,404);
  assert.equal((await fetch(base+"/healthz",{headers:{...headers,origin:"https://evil"}})).status,403);
  const hostStatus = await new Promise(resolve => { const r=request(base+"/healthz",{headers:{...headers,host:"evil"}},response=>{response.resume();resolve(response.statusCode);});r.end(); });
  assert.equal(hostStatus,403);
  const parse = async (x: Response) => await x.json() as ReturnType<DashboardCollector["snapshot"]>;
  const [a,b]=await Promise.all([fetch(base+"/api/v1/status",{headers}).then(parse),fetch(base+"/api/v1/status?view=summary",{headers}).then(parse)]);
  assert.deepEqual(a.counts,b.counts);assert.equal(a.snapshot_id,b.snapshot_id);assert.equal(f.calls(),3);
  assert.equal("sessions" in b,false);assert.equal(JSON.stringify(a).includes("password"),false);
});
test("native project/worktree/parent evidence admits children/managers while public filter is unchanged",async()=>{
  const f=fixture();const sessions=[f.native("root"),{...f.native("child"),parentID:"root",location:{directory:"/unlisted-child"}},
    {...f.native("manager"),agent:"openlive-manager"},{...f.native("worktree"),location:{directory:"/worktree"}},
    {...f.native("foreign"),projectID:"other"},{...f.native("unproven"),location:{directory:"/neighbor"}}];
  const client={global:{health:async()=>({data:{healthy:true}})},project:{current:async()=>({data:{id:"native"}}),directories:async()=>({data:[{directory:"/project"},{directory:"/worktree"}]})},
    session:{status:async()=>({data:{}})},v2:{session:{list:async()=>({data:{data:sessions,cursor:{}}})}}};
  const runtime={schema:1,project:"/project",projectHash:"p",projectName:"p",backendUrl:"http://127.0.0.1:1",generation:"g",opencodeVersion:"1.18.34",listenHost:"127.0.0.1",listenPort:2,credentialFile:""} as RuntimeDescriptor;
  const gateway=new OpenCodeGateway(runtime,client as unknown as ConstructorParameters<typeof OpenCodeGateway>[1]);
  const internal=await gateway.readDashboardInventory();assert.deepEqual(internal.sessions.map(x=>x.id),["root","manager","worktree","child"]);assert.equal(internal.complete,false);
  const external=await gateway.listSessions();assert.deepEqual(external.sessions.map(x=>x.id),["root"]);
  sessions.splice(0,sessions.length,...Array.from({length:201},(_,i)=>f.native(`overflow_${i}`)));
  const over=await gateway.readDashboardInventory();assert.equal(over.complete,false);assert.equal(over.sessions.length,200);
  let healthy=false;
  client.global.health=async()=>({data:{healthy}});
  const booting=new OpenCodeGateway(runtime,client as unknown as ConstructorParameters<typeof OpenCodeGateway>[1]);
  await assert.rejects(booting.readDashboardInventory());
  healthy=true;assert.equal((await booting.readDashboardInventory()).sessions.length,200);
});
test("internal read rejects rebound session identity and foreign history; worktree status/history use its admitted directory",async()=>{
  const f=fixture(),s={...f.native("s"),location:{directory:"/worktree"}};
  let wrongId=false,wrongHistory=false;
  const directories:string[]=[];
  const client={global:{health:async()=>({data:{healthy:true}})},project:{current:async()=>({data:{id:"native"}}),directories:async()=>({data:[{directory:"/worktree"}]})},
    v2:{session:{list:async()=>({data:{data:[s],cursor:{}}}),get:async()=>({data:{data:wrongId?{...s,id:"rebound"}:s}}),permission:{list:async()=>({data:{data:[]}})},question:{list:async()=>({data:{data:[]}})}}},
    session:{status:async(q:{directory:string})=>{directories.push(q.directory);return {data:{s:{type:"busy"}}};},
      messages:async(q:{directory:string})=>{directories.push(q.directory);return {data:[{info:{id:"u",role:"user",sessionID:wrongHistory?"foreign":"s",time:{created:1}},parts:[]}],response:new Response()};}}};
  const runtime={schema:1,project:"/project",projectHash:"p",projectName:"p",backendUrl:"http://127.0.0.1:1",generation:"g",opencodeVersion:"1.18.34",listenHost:"127.0.0.1",listenPort:2,credentialFile:""} as RuntimeDescriptor;
  const gateway=new OpenCodeGateway(runtime,client as unknown as ConstructorParameters<typeof OpenCodeGateway>[1]);
  await gateway.readDashboardInventory();
  assert.equal((await gateway.readDashboardSession(s)).backend_activity,"busy");
  assert.deepEqual(directories,["/worktree","/worktree"]);
  wrongId=true;await assert.rejects(gateway.readDashboardSession(s));wrongId=false;
  wrongHistory=true;await assert.rejects(gateway.readDashboardSession(s));
});
