// Bounded private fixture: production HTTPS handler, collector and unmodified UI.
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardCollector } from '../dist/dashboard.js';
import { dashboardServer } from '../dist/dashboard-http.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = id => ({id,title:id,projectID:'native',location:{directory:'/fixture'},time:{created:1,updated:2}});
let sessions = Array.from({length:190},(_,i)=>native(`ses_${i}`));
let events=[];
const tasks = Array.from({length:500},(_,i)=>({task_id:`task_${i}`,title:`Task ${i}`,board_status:'in_progress',board_project_id:'inbox',links:i<40?[{session_id:`ses_${i}`,message_id:'msg_old'}]:[]}));
const changed = new Map();
const collector = new DashboardCollector({id:'fixture',name:'Dashboard Fixture'},'fixture-generation',{
  inventory:async()=>({sessions:[...sessions],complete:true,observed_at:new Date().toISOString()}),
  session:async s=>({session_id:s.id,title:changed.get(s.id)?.title??s.title,parent_session_id:s.id==='ses_41'?'ses_0':null,
    kind:s.id==='ses_41'?'child':s.id==='ses_42'?'manager':'root',archived:s.id==='ses_43',backend_activity:changed.get(s.id)?.state==='retry'?'retry':Number(s.id.split('_')[1])<50?'busy':'idle',
    pending_input:{permissions:0,questions:changed.get(s.id)?.state==='input_required'||s.id==='ses_1'&&!changed.has(s.id)?1:0,scope:'session'},observed_at:new Date().toISOString(),last_activity_at:Date.now(),
    current_runtime:{provider_id:'openai',model_id:changed.has(s.id)?'setting-switched':'gpt-6.1-sol',variant:changed.has(s.id)?'low':'medium',source:'session_setting'},
    turns:Number(s.id.split('_')[1])<50?[{user_message_id:'msg_new',state:'running',active:true,finish:null,completed_at:null,
      runtime:{provider_id:'openai',model_id:'gpt-6.1-sol-fast',variant:'high',source:'assistant_message',message_id:'assistant'}}]:[],history_has_more:false}),
  board:async()=>structuredClone(tasks),activity:async()=>({epoch:'fixture',recent:[]}),
});
const config={projectHash:'fixture',generation:'fixture-generation',listenPort:0,authEnabled:false,auth:null,
  cert:process.env.WC_CERT,key:process.env.WC_KEY,assets:resolve(root,'dashboard'),navigation:{web_port:4096,board_port:4101,opencode_version:'1.18.34'}};
const server=await dashboardServer(config,collector);server.listen(0,'127.0.0.1');await once(server,'listening');config.listenPort=server.address().port;
collector.start();console.log(JSON.stringify({url:`https://127.0.0.1:${config.listenPort}`,pid:process.pid}));
// Delayed persistent changes cover multiple real 5s/15s polling phases.
process.once('SIGUSR1',()=>{
  for(let i=0;i<20;i++)setTimeout(()=>{const id=`ses_${i}`,at=Date.now(),title=`Measured ${i}`,state=i%2?'retry':'input_required';changed.set(id,{title,state});events.push({kind:'session',id,title,state,at});console.log(JSON.stringify(events.at(-1)));},1000+i*613);
  for(let i=0;i<10;i++)setTimeout(()=>{const at=Date.now(),id=`ses_${190+i}`;sessions.push(native(id));events.push({kind:'new',id,at});console.log(JSON.stringify(events.at(-1)));},2700+i*733);
  for(let i=0;i<10;i++)setTimeout(()=>{const at=Date.now(),title=`Measured Board ${i}`;tasks[i].title=title;events.push({kind:'board',id:`task_${i}`,title,at});console.log(JSON.stringify(events.at(-1)));},3000+i*733);
});
const shutdown=()=>{collector.stop();server.close();server.closeAllConnections();};
process.on('SIGTERM',shutdown);setTimeout(shutdown,90000).unref();
