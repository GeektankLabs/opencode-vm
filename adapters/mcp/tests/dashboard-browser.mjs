import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const out=process.env.WC_ARTIFACT_DIR ?? '/tmp/opencode/wc-browser';await mkdir(out,{recursive:true});
const cert=resolve(out,'cert.pem'),key=resolve(out,'key.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',key,'-out',cert],{stdio:'ignore'});
const here=dirname(fileURLToPath(import.meta.url));
const child=spawn(process.execPath,[resolve(here,'dashboard-browser-fixture.mjs')],{env:{...process.env,WC_CERT:cert,WC_KEY:key},stdio:['ignore','pipe','pipe']});
const events=[];let wire='';child.stderr.on('data',c=>wire+=c);
let url;
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{wire+=line+'\n';try{const v=JSON.parse(line);if(v.url)url=v.url;else events.push(v);}catch{}});
let browser;
try {
  const deadline=Date.now()+5000;while(!url&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.ok(url,wire);
  browser=await chromium.launch({headless:true});const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(url);await page.waitForSelector('.session');
  await page.evaluate(()=>{
    window.renderObserved={};
    const pending=new Set();
    const rendered=key=>{
      if(window.renderObserved[key]||pending.has(key))return;pending.add(key);
      // Observe the following painted frame, not only the DOM mutation callback.
      requestAnimationFrame(()=>requestAnimationFrame(()=>{window.renderObserved[key]=Date.now();pending.delete(key);}));
    };
    const observe=()=>{
      for(let i=0;i<20;i++){
        const id=`ses_${i}`,row=[...document.querySelectorAll('.session')].find(x=>x.dataset.sessionId===id);
        const title=row?.querySelector('[data-field=title]')?.textContent,state=row?.querySelector('.status')?.dataset.state;
        if(title?.startsWith(`Measured ${i} ·`)&&state===(i%2?'retry':'input_required')&&row.querySelector('.runtime').textContent.includes('setting-switched'))rendered(`session:${id}`);
      }
      for(let i=190;i<200;i++){if(document.querySelector(`[data-session-id=ses_${i}]`))rendered(`new:ses_${i}`);}
      for(let i=0;i<10;i++){if([...document.querySelectorAll('article h2')].some(x=>x.textContent===`Measured Board ${i}`))rendered(`board:task_${i}`);}
    };
    new MutationObserver(observe).observe(document.querySelector('main'),{subtree:true,childList:true,characterData:true,attributes:true});observe();
  });
  const layouts=[];
  for(const width of [320,390,512,768,1280]){
    await page.setViewportSize({width,height:844});
    const info=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
      touch:[...document.querySelectorAll('button,a,summary')].filter(x=>x.getBoundingClientRect().height>0).every(x=>x.getBoundingClientRect().height>=44),
      runtime:document.querySelector('.runtime')&&{color:getComputedStyle(document.querySelector('.runtime')).color,size:getComputedStyle(document.querySelector('.runtime')).fontSize},
      oneRuntime:[...document.querySelectorAll('.session')].every(s=>s.querySelectorAll('.runtime').length===1)}));
    assert.ok(info.scroll<=width,JSON.stringify(info));assert.ok(info.touch,JSON.stringify(info));assert.ok(info.oneRuntime);
    layouts.push(info);await page.screenshot({path:resolve(out,`layout-${width}.png`),fullPage:false});
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('#others').evaluate(e=>e.open=true);
  await page.locator('[data-session-id=ses_10] a').first().focus();
  await page.evaluate(()=>window.scrollTo(0,600));
  const before=await page.evaluate(()=>({key:document.activeElement.closest('.session')?.dataset.sessionId,scroll:scrollY,details:document.querySelector('#others').open}));
  // Only the directly spawned owned fixture is signalled; no existing process.
  child.kill('SIGUSR1');
  await page.waitForFunction(()=>Object.keys(window.renderObserved).length===40,{},{timeout:35000});
  const observed=await page.evaluate(()=>window.renderObserved);
  const after=await page.evaluate(()=>({key:document.activeElement.closest('.session')?.dataset.sessionId,scroll:scrollY,details:document.querySelector('#others').open}));
  assert.deepEqual(after,before);assert.deepEqual(errors,[]);
  const timings=events.map(e=>({...e,rendered_at:observed[`${e.kind}:${e.id}`],latency_ms:observed[`${e.kind}:${e.id}`]-e.at}));
  const stats={};
  for(const kind of ['session','new','board']){const values=timings.filter(t=>t.kind===kind).map(t=>t.latency_ms).sort((a,b)=>a-b);assert.equal(values.length,kind==='session'?20:10);assert.ok(values.every(v=>Number.isFinite(v)&&v>=0));stats[kind]={samples:values.length,p95_ms:values[Math.ceil(values.length*.95)-1],max_ms:values.at(-1)};assert.ok(stats[kind].p95_ms<=(kind==='session'?8000:20000),JSON.stringify(stats));}
  await page.screenshot({path:resolve(out,'updated-390.png'),fullPage:false});
  await writeFile(resolve(out,'observations.json'),JSON.stringify({method:'real wall-clock source mutation to production UI status+runtime DOM update observed in the following painted frame (MutationObserver plus double requestAnimationFrame); private healthy HTTPS collector fixture, final 200 sessions/50 active/500 tickets',stats,timings,layouts,before,after,errors},null,2));
  console.log(JSON.stringify({stats,layouts,focusScroll:after,artifact_dir:out}));
} finally {
  await writeFile(resolve(out,'producer.log'),wire);
  if(browser)await browser.close();child.kill('SIGTERM');await once(child,'exit').catch(()=>{});
}
