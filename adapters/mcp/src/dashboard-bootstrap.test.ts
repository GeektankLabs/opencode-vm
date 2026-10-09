import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { request } from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("packaged bootstrap uses real SDK GETs, private webauth and ALL inventory; generation revocation invalidates claims", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dashboard-wire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir,"key.pem"),cert = join(dir,"cert.pem");
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=localhost","-addext","subjectAltName=IP:127.0.0.1,DNS:localhost","-keyout",key,"-out",cert],{stdio:"ignore"});
  const native = Array.from({length:200},(_,i)=>({id:`ses_${i}`,projectID:"native",title:`Session ${i}`,location:{directory:dir},time:{created:1,updated:2},agent:i===1?"openlive-manager":"build",...(i===2?{parentID:"ses_0"}:{}),model:{providerID:"openai",id:"setting",variant:"medium"}}));
  const calls: string[]=[];
  const backend=createServer((req,res)=>{
    calls.push(`${req.method} ${req.url}`);
    if(req.headers.authorization!=="Basic dTpw"){res.writeHead(401);res.end();return;}
    const url=new URL(req.url!,"http://localhost");
    let body:unknown;
    if(url.pathname==="/global/health")body={healthy:true,version:"1.18.34"};
    else if(url.pathname==="/project/current")body={id:"native",worktree:dir};
    else if(url.pathname==="/project/native/directories")body=[{directory:dir}];
    else if(url.pathname==="/api/session"){const offset=Number(url.searchParams.get("cursor")??0),limit=Number(url.searchParams.get("limit")??20);body={data:native.slice(offset,offset+limit),cursor:offset+limit<native.length?{next:String(offset+limit)}:{}};}
    else if(url.pathname==="/session/status")body=Object.fromEntries(native.slice(0,50).map(s=>[s.id,{type:"busy"}]));
    else if(/^\/api\/session\/ses_\d+$/.test(url.pathname))body={data:native.find(s=>url.pathname.endsWith(s.id))};
    else if(/\/(permission|question)$/.test(url.pathname))body={data:[]};
    else if(url.pathname.endsWith("/message")){
      const id=url.pathname.split("/")[2]!;
      body=Number(id.split("_")[1])<50?Array.from({length:id==="ses_0"?8:1},(_,i)=>[
        {info:{id:`user_${i}`,sessionID:id,role:"user",time:{created:i*10+1},model:{providerID:"requested",modelID:"requested"}},parts:[]},
        {info:{id:`assistant_${i}`,sessionID:id,role:"assistant",parentID:`user_${i}`,providerID:"openai",modelID:"used",variant:"high",time:i?{created:i*10+2,completed:i*10+3}:{created:2},...(i?{finish:"stop"}:{})},parts:[{type:"text",text:"PRIVATE_PROMPT_BODY"}]}
      ]).flat():[];
    } else if(url.pathname==="/api/projects")body=[{id:"board",prefix:"B",name:"Board",status:"active"}];
    else if(url.pathname==="/api/tickets")body=Array.from({length:500},(_,i)=>({id:`ticket${i}`,projectId:"board",title:`Task ${i}`,status:"in_progress",priority:"medium",description:"PRIVATE_DESCRIPTION"}));
    else {res.writeHead(404);res.end();return;}
    res.setHeader("content-type","application/json");res.end(JSON.stringify(body));
  });
  backend.listen(0,"127.0.0.1");await once(backend,"listening");t.after(()=>backend.close());
  // The Board source has no webauth; its canonical client sends no credential.
  const board=createServer((req,res)=>{const url=new URL(req.url!,"http://localhost");res.setHeader("content-type","application/json");res.end(JSON.stringify(url.pathname==="/api/projects"?[{id:"board",prefix:"B",name:"Board",status:"active"}]:Array.from({length:500},(_,i)=>({id:`ticket${i}`,projectId:"board",title:`Task ${i}`,status:"in_progress",priority:"medium",description:"PRIVATE_DESCRIPTION"}))));});
  board.listen(0,"127.0.0.1");await once(board,"listening");t.after(()=>board.close());
  const reservation=netServer();reservation.listen(0,"127.0.0.1");await once(reservation,"listening");const port=(reservation.address() as {port:number}).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const config={schema:1,projectHash:"a".repeat(32),generation:"wire",authEnabled:true,auth:{username:"u",password:"p"},key,cert,
    runtime:{schema:1,project:dir,projectHash:"a".repeat(32),projectName:"Wire",generation:"wire",backendUrl:`http://127.0.0.1:${(backend.address() as {port:number}).port}`,opencodeVersion:"1.18.34",listenHost:"127.0.0.1",listenPort:port,credentialFile:"",taskboardUrl:`http://127.0.0.1:${(board.address() as {port:number}).port}`,taskboardMetadataFile:join(dir,"metadata.json")}};
  const input=join(dir,"runtime.json");await writeFile(input,JSON.stringify(config),{mode:0o600});
  const entry=process.env.OCVM_DASHBOARD_ENTRY ?? new URL("./dashboard-main.js",import.meta.url).pathname;
  const child=spawn(process.execPath,[entry,input],{stdio:["ignore","ignore","pipe"]});let errors="";child.stderr.on("data",c=>errors+=c);
  t.after(()=>child.kill("SIGTERM"));
  const ca=await readFile(cert);
  const get=(path:string,auth=true)=>new Promise<{status:number;text:string}>((resolve,reject)=>{const req=request({host:"127.0.0.1",port,path,ca,headers:auth?{authorization:"Basic dTpw"}:{}},res=>{let text="";res.on("data",c=>text+=c);res.on("end",()=>resolve({status:res.statusCode!,text}));});req.on("error",reject);req.end();});
  let result;
  const start=Date.now();
  while(Date.now()-start<20000){try{result=await get("/healthz");if(result.status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(result?.status,200,errors);
  const bootedAt=Date.now();
  assert.equal((await get("/api/v1/status",false)).status,401);
  const detail=JSON.parse((await get("/api/v1/status")).text);
  assert.equal(detail.sessions.length,200);assert.equal(detail.counts.active_sessions,50);
  assert.ok(detail.sessions.some((s:{kind:string})=>s.kind==="manager"));
  assert.ok(detail.sessions.some((s:{kind:string})=>s.kind==="child"));
  assert.equal(detail.sessions[0].turns[0].runtime.model_id,"used");
  assert.equal(detail.sessions[0].turns[0].runtime.variant,"high");
  assert.equal(detail.sessions[0].turns[0].user_message_id,"user_0");
  assert.equal(detail.sessions[0].turns[0].active,true);
  assert.equal(detail.sessions[0].turns.length,6);assert.equal(detail.sessions[0].turns_truncated,true);
  assert.equal(detail.sessions[0].current_runtime.model_id,"setting");
  assert.ok(calls.every(call=>call.startsWith("GET ")));
  assert.ok(!JSON.stringify(detail).includes("PRIVATE_"));
  await writeFile(input,JSON.stringify({...config,generation:"revoked"}));
  // Poll for the child's next ownership check instead of racing a fixed sleep:
  // under parallel suite load the 5s interval plus an in-flight collection can
  // delay revocation beyond a constant wait. Same final assertions, bounded.
  const revokedAt=Date.now();let health=0;
  while(Date.now()-revokedAt<20000){try{health=(await get("/healthz")).status;if(health===503)break;}catch{}await new Promise(r=>setTimeout(r,250));}
  assert.equal(health,503,errors);
  assert.equal((await get("/api/v1/status")).status,503);
  console.log(JSON.stringify({bootstrap_ms:bootedAt-start,revocation_ms:Date.now()-revokedAt,sessions:200,active:50,tickets:500,backend_gets:calls.length}));
});
