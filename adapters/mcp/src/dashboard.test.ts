import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { DashboardCollector, prepareAttention, PREPARED_ATTENTION_LIMIT } from "./dashboard.js";
import type { DashboardReader, Inventory, Session, Tasks } from "./dashboard.js";
import type { PreparedAttentionEntry } from "./types.js";
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
  let attentionEntries: PreparedAttentionEntry[] = [];
  let attentionFail: string | null = null;
  const reader: DashboardReader = { inventory: async () => inventory,
    session: async s => { calls++; if(sessionFail)throw new Error(); return { ...rows.get(s.id)!, observed_at:new Date(time).toISOString() }; },
    board: async () => { if(boardFail)throw new Error(); return tasks; }, activity: async () => ({ epoch:"epoch",recent:[] }),
    attention: async () => { if(attentionFail) throw Object.assign(new Error("activity"), { code: attentionFail }); return attentionEntries; } };
  const collector = new DashboardCollector({ id:"project",name:"Test" },"generation",reader,()=>time);
  return { collector, reader, inventory, rows, tasks, native, row, advance:(n:number)=>time+=n,
    boardFail:()=>boardFail=true, sessionFail:()=>sessionFail=true, calls:()=>calls,
    setAttention:(entries: PreparedAttentionEntry[])=>{ attentionEntries = entries; },
    attentionFail:(code: string | null)=>{ attentionFail = code; } };
}

export function attentionEntry(overrides: Partial<PreparedAttentionEntry> = {}): PreparedAttentionEntry {
  return { event_id: "evt_1", source_revision: "r1", classification: "ready", lifecycle: "new",
    session_id: "ses_A", task_id: "task_A", master_task_id: null, work_package_id: null,
    hierarchy_status: "resolved", occurred_at: "2026-10-09T10:00:00.000Z", observed_at: "2026-10-09T10:00:00.000Z",
    prepared_summary: "result available", next_safe_step: "review the result", resolution: "unverified",
    evidence_complete: true, superseded_by: null, ...overrides };
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
test("activity disabled/unavailable never reads stale journal data or claims fresh coverage", async () => {
  for (const state of ["disabled", "unavailable"] as const) {
    const f = fixture(); let reads = 0;
    f.reader.activityJournalStatus = () => ({ enabled: state !== "disabled", state });
    f.reader.activity = async () => { reads++; throw new Error("must not read"); };
    await f.collector.tick();
    const s = f.collector.snapshot(false);
    assert.ok("recent" in s);
    assert.equal(reads, 0);
    assert.equal(s.recent, null);
    assert.equal(s.sources.activity?.state, state === "disabled" ? "disabled" : "degraded");
    assert.equal(s.sources.activity?.complete, false);
    assert.equal(s.sources.sessions?.state, "fresh");
  }
  const f = fixture();
  f.reader.activity = async () => ({ recent: [], updated_at: new Date(1).toISOString() });
  await f.collector.tick();
  assert.equal(f.collector.snapshot(false).sources.activity?.state, "stale", "file read time is not writer freshness");
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
  const lan=`192.168.16.155:${config.listenPort}`;
  const lanStatus = await new Promise(resolve => { const r=request(base+"/healthz",{headers:{...headers,host:lan,origin:`https://${lan}`}},response=>{response.resume();resolve(response.statusCode);});r.end(); });
  assert.equal(lanStatus,200);
  const publicStatus = await new Promise(resolve => { const r=request(base+"/healthz",{headers:{...headers,host:`93.184.216.34:${config.listenPort}`}},response=>{response.resume();resolve(response.statusCode);});r.end(); });
  assert.equal(publicStatus,403);
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

// OCVM-DASHBOARD-READINESS-CORRECTION-20261006-2258: real-start evidence showed the service
// running the full 20s window (started, CPU used, clean scripted stop, empty server.log) while
// the pre-fix health contract refused readiness for partial coverage. Corrected contract:
// service readiness (valid generation + demonstrated backend + HTTP serving) is separated from
// data coverage, which stays honest (degraded/incomplete + timestamps). Undemonstrated backend,
// unticked collector and revoked generation remain refused; a socket alone is never ok.
test("readiness separates demonstrated service from data coverage; partial stays ready, undemonstrated stays refused",async t=>{
  const native=(id:string):Inventory["sessions"][number]=>({id,title:id,projectID:"native",
    time:{created:1,updated:2},location:{directory:"/project"},cost:0,
    tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}}});
  const row=(id:string):Session=>({session_id:id,title:id,parent_session_id:null,kind:"root",archived:false,
    backend_activity:"idle",pending_input:{permissions:0,questions:0,scope:"session"},observed_at:new Date(100000).toISOString(),
    last_activity_at:100000,current_runtime:null,turns:[],turns_truncated:false,history_has_more:false});
  const health=async(collector:DashboardCollector)=>{
    const config={projectHash:"project",generation:"generation",listenPort:0,authEnabled:false,auth:null,cert:"",key:"",assets:"/missing"};
    const server=createServer(dashboardHandler(config,collector));server.listen(0,"127.0.0.1");await once(server,"listening");
    t.after(()=>server.close());config.listenPort=(server.address() as {port:number}).port;
    const response=await fetch(`http://127.0.0.1:${config.listenPort}/healthz`);
    const body=await response.json() as {status:string,coverage:string,
      sources:Record<string,{state:string,complete:boolean,error:string|null,observed_at:string|null,last_success_at:string|null}>};
    return {status:response.status,body};
  };
  // A: discovery coverage gap (inventory scale/unadmitted remainder) although every read succeeded.
  const partialDiscovery=new DashboardCollector({id:"project",name:"T"},"generation",{
    inventory:async()=>({sessions:[native("ses_A")],complete:false,observed_at:new Date(100000).toISOString()}),
    session:async s=>row(s.id),board:async()=>[],activity:async()=>({epoch:"e",recent:[]})},()=>100000);
  await partialDiscovery.tick();
  const a=await health(partialDiscovery);
  assert.equal(a.status,200);assert.equal(a.body.status,"ok");assert.equal(a.body.coverage,"partial");
  assert.equal(a.body.sources.discovery!.state,"degraded");
  assert.equal(a.body.sources.discovery!.complete,false);
  assert.equal(a.body.sources.discovery!.error,"READ_COVERAGE_INCOMPLETE");
  assert.notEqual(a.body.sources.discovery!.observed_at,null);
  assert.equal(a.body.sources.sessions!.state,"fresh");
  assert.equal(a.body.sources.sessions!.complete,true);
  // B: one per-session read races (churn) while the sweep itself succeeds.
  const partialSessions=new DashboardCollector({id:"project",name:"T"},"generation",{
    inventory:async()=>({sessions:[native("ses_A"),native("ses_B")],complete:true,observed_at:new Date(100000).toISOString()}),
    session:async s=>{if(s.id==="ses_B")throw new Error("rebind race");return row(s.id);},
    board:async()=>[],activity:async()=>({epoch:"e",recent:[]})},()=>100000);
  await partialSessions.tick();
  const b=await health(partialSessions);
  assert.equal(b.status,200);assert.equal(b.body.coverage,"partial");
  assert.equal(b.body.sources.sessions!.state,"degraded");
  assert.equal(b.body.sources.sessions!.complete,false);
  assert.notEqual(b.body.sources.sessions!.last_success_at,null);
  // C: backend never demonstrated — both sources unavailable; a listening socket is not a valid app.
  const down=new DashboardCollector({id:"project",name:"T"},"generation",{
    inventory:async()=>{throw new Error("backend down");},
    session:async s=>row(s.id),board:async()=>[],activity:async()=>({epoch:"e",recent:[]})},()=>100000);
  await down.tick();
  const c=await health(down);
  assert.equal(c.status,503);assert.equal(c.body.status,"not_ready");assert.equal(c.body.coverage,"unknown");
  assert.equal(c.body.sources.discovery!.error,"SOURCE_UNAVAILABLE");
  // D: unticked collector — nothing observed yet.
  const unticked=new DashboardCollector({id:"project",name:"T"},"generation",{
    inventory:async()=>({sessions:[native("ses_A")],complete:true,observed_at:new Date(100000).toISOString()}),
    session:async s=>row(s.id),board:async()=>[],activity:async()=>({epoch:"e",recent:[]})},()=>100000);
  const d=await health(unticked);
  assert.equal(d.status,503);assert.equal(d.body.coverage,"unknown");
  assert.equal(d.body.sources.sessions!.observed_at,null);
  // E: revoked/mismatched generation never serves ok even with demonstrated sources.
  const revoked=new DashboardCollector({id:"project",name:"T"},"unverified",{
    inventory:async()=>({sessions:[native("ses_A")],complete:true,observed_at:new Date(100000).toISOString()}),
    session:async s=>row(s.id),board:async()=>[],activity:async()=>({epoch:"e",recent:[]})},()=>100000);
  await revoked.tick();
  const e=await health(revoked);
  assert.equal(e.status,503);assert.equal(e.body.status,"not_ready");assert.equal(e.body.coverage,"unknown");
  // F: healthy complete coverage stays ok/complete.
  const f=fixture();await f.collector.tick();
  const g=await health(f.collector);
  assert.equal(g.status,200);assert.equal(g.body.status,"ok");assert.equal(g.body.coverage,"complete");
  assert.equal(g.body.sources.discovery!.state,"fresh");
  assert.equal(g.body.sources.sessions!.complete,true);
});

test("W3 prepared attention: existing queue surfaced, ordered, discussed is never resolved", async () => {
  const f = fixture();
  f.setAttention([
    attentionEntry({ event_id: "evt_ready", classification: "ready", occurred_at: "2026-10-09T10:00:00.000Z" }),
    attentionEntry({ event_id: "evt_input", classification: "action_required", lifecycle: "new", occurred_at: "2026-10-09T09:00:00.000Z" }),
    attentionEntry({ event_id: "evt_err", classification: "attention", lifecycle: "discussed", occurred_at: "2026-10-09T11:00:00.000Z" }),
    attentionEntry({ event_id: "evt_unlinked", session_id: null, task_id: null, hierarchy_status: "unlinked" }),
  ]);
  await f.collector.tick();
  const s = f.collector.snapshot(false) as any;
  assert.equal(s.capabilities.prepared_attention, true);
  const pa = s.prepared_attention;
  assert.equal(pa.available, true); assert.equal(pa.reason, null);
  assert.deepEqual(pa.entries.map((e: any) => e.event_id), ["evt_input", "evt_err", "evt_ready", "evt_unlinked"]);
  assert.deepEqual(pa.ordering, ["input_required", "error_abort", "ready_result"]);
  assert.equal(pa.total, 4); assert.equal(pa.omitted, 0); assert.equal(pa.coverage, "complete");
  assert.equal(pa.entries.find((e: any) => e.event_id === "evt_err").resolution, "unverified");
  assert.ok(pa.entries.every((e: any) => e.resolution === "unverified"), "no entry claims resolved");
  const unlinked = pa.entries.find((e: any) => e.event_id === "evt_unlinked");
  assert.equal(unlinked.hierarchy_status, "unlinked"); assert.equal(unlinked.task_id, null);
  assert.equal(s.sources.prepared.state, "fresh");
});

test("W3 prepared attention: >10 capped honestly and a newer event revision updates in place", () => {
  const many = Array.from({ length: 13 }, (_, i) => attentionEntry({ event_id: `evt_${i}`,
    occurred_at: `2026-10-09T00:00:${String(i).padStart(2, "0")}.000Z` }));
  const first = prepareAttention(many);
  assert.equal(first.total, 13); assert.equal(first.omitted, 3);
  assert.equal(first.entries.length, PREPARED_ATTENTION_LIMIT); assert.equal(first.coverage, "paged");
  const few = many.slice(0, 5);
  const updated = prepareAttention([...few, attentionEntry({ event_id: "evt_0", source_revision: "r2",
    observed_at: "2026-10-09T12:00:00.000Z", lifecycle: "discussed" })]);
  assert.equal(updated.total, 5, "revision update is not a duplicate");
  const evt0 = updated.entries.find(e => e.event_id === "evt_0");
  assert.equal(evt0?.lifecycle, "discussed"); assert.equal(evt0?.source_revision, "r2");
  assert.equal(updated.entries.filter(e => e.event_id === "evt_0").length, 1);
});

test("W3 prepared attention: disabled/unavailable is honest with reason and preserves last data", async () => {
  const f = fixture();
  f.attentionFail("ACTIVITY_DISABLED");
  await f.collector.tick();
  const s1 = f.collector.snapshot(false) as any;
  assert.equal(s1.capabilities.prepared_attention, false);
  assert.equal(s1.prepared_attention.available, false);
  assert.equal(s1.prepared_attention.reason, "ACTIVITY_DISABLED");
  assert.deepEqual(s1.prepared_attention.entries, []);
  assert.equal(s1.sources.prepared.error, "ACTIVITY_DISABLED");
  assert.ok(Array.isArray(s1.sessions), "direct slices are not blocked by a disabled attention source");
  f.setAttention([attentionEntry({ event_id: "evt_x" })]); f.attentionFail(null);
  f.advance(5000); await f.collector.tick();
  const s2 = f.collector.snapshot(false) as any;
  assert.equal(s2.prepared_attention.entries[0]?.event_id, "evt_x");
  const observed = s2.sources.prepared.observed_at;
  f.attentionFail("ACTIVITY_UNAVAILABLE"); f.advance(5000); await f.collector.tick();
  const s3 = f.collector.snapshot(false) as any;
  assert.equal(s3.prepared_attention.available, false);
  assert.equal(s3.prepared_attention.reason, "ACTIVITY_UNAVAILABLE");
  assert.equal(s3.prepared_attention.entries[0]?.event_id, "evt_x", "last data preserved on outage");
  assert.equal(s3.sources.prepared.observed_at, observed, "last observed time preserved on outage");
  assert.equal(s3.sources.prepared.state, "degraded");
  f.attentionFail(null); f.advance(5000); await f.collector.tick();
  const s4 = f.collector.snapshot(false) as any;
  assert.equal(s4.prepared_attention.available, true);
  assert.equal(s4.prepared_attention.entries.length, 1, "reconnect does not duplicate entries");
});

test("snapshot session order follows inventory order regardless of reader resolution order",async()=>{
  // CI release-run 38323154598: completion-order pushes made /api/v1/status
  // rows nondeterministic between refreshes when parallel readers resolved
  // out of order. Rows must be placed by inventory index instead.
  const inventory: Inventory = { observed_at: new Date(1).toISOString(), sessions: ["ses_A","ses_B","ses_C"].map(id=>({
    id, projectID:"p", title:id, location:{directory:"/d"}, parentID:undefined, time:{created:1,updated:2},
    cost:0, tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}} })), complete:true };
  const row=(id:string):Session=>({ session_id:id, title:id.slice(0,240), parent_session_id:null, kind:"root",
    archived:false, backend_activity:"idle",
    pending_input:{scope:"session",permissions:0,questions:0}, observed_at:new Date(1).toISOString(),
    last_activity_at:2, current_runtime:null, turns:[], turns_truncated:false, history_has_more:false });
  const deferred:{id:string;resolve:(value:Session)=>void}[]=[];
  const reader:DashboardReader={ inventory:async()=>inventory,
    session:s=>new Promise(resolve=>{ deferred.push({id:s.id,resolve}); }),
    board:async()=>[], activity:async()=>({epoch:"e",recent:[]}) };
  const collector=new DashboardCollector({id:"p",name:"P"},"generation",reader,()=>1);
  const running=collector.tick();
  // Let all three readers be in flight, then resolve in REVERSE order.
  await new Promise(r=>setTimeout(r,20));
  assert.equal(deferred.length,3);
  for(const entry of [...deferred].reverse()) entry.resolve(row(entry.id));
  await running;
  const snapshot=collector.snapshot(false);
  assert.ok("sessions" in snapshot);
  assert.deepEqual(snapshot.sessions.map(s=>s.session_id),["ses_A","ses_B","ses_C"]);
});
