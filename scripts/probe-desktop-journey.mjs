#!/usr/bin/env node
// End-to-end renderer journey. All provider actions below are isolated fixtures.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/desktop-journey',before?'before':'after');mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-journey-probe-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks=[],errors=[];const record=text=>{checks.push(text);console.log(text);};
let page;
try {
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 const archiveAt=process.argv.indexOf('--archive');
 if(archiveAt>=0){const archive=process.argv[archiveAt+1],asar=require('@electron/asar');await page.route(rendererURL.replace('/index.html','/**'),route=>{const name='out/renderer'+new URL(route.request().url()).pathname;return route.fulfill({body:asar.extractFile(archive,name),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(name)]??'application/octet-stream'});});}
 await page.emulateMedia({reducedMotion:'reduce'});await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const api=window.wanigan,now=Date.now(),listeners=new Map();
  localStorage.setItem('wanigan.code','0');
  window.__journeyGoals=[];window.__journeyCalls=[];window.__journeyAttention=[];window.__linkReads=[];
  const goal=()=>window.__journeyGoals[0],find=id=>goal().nodes.find(n=>n.id===id);
  const derive=()=>{
   const g=goal();for(const n of g.nodes)if(['blocked','ready'].includes(n.status))n.status=n.dependsOn.every(id=>find(id).status==='completed')?'ready':'blocked';
   g.status=g.nodes.some(n=>n.status==='failed')?'blocked':g.nodes.some(n=>n.kind==='review'&&n.status==='completed')?'accepted':g.nodes.some(n=>n.kind==='review'&&n.status==='ready')?'review':g.nodes.some(n=>['running','completed'].includes(n.status))?'executing':'draft';
   g.updatedAt=Date.now();
  };
  window.__journeyEmit=(name,event)=>{for(const callback of listeners.get(name)??[])callback(event);};
  const controls={
   list:async()=>structuredClone(window.__journeyGoals),get:async id=>{if(window.__goalFail)throw new Error('Fixture goal read unavailable');return structuredClone(window.__journeyGoals.find(g=>g.id===id));},
   events:async()=>[],outcomes:async()=>[],mcpTasks:async()=>[],resumeReceipts:async()=>[],traces:async()=>[],
   sessionGoal:async id=>{window.__linkReads.push(id);if(window.__linkFail)throw new Error('Fixture goal link unavailable');const n=goal()?.nodes.find(n=>n.sessionId===id);const value=n?{goalId:goal().id,goalTitle:goal().title,goalStatus:goal().status,nodeId:n.id,nodeTitle:n.title,nodeKind:n.kind,nodeStatus:n.status}:null;if(window.__holdLink===id)return new Promise(resolve=>window.__releaseLink=()=>resolve(value));return structuredClone(value);},
   create:async input=>{window.__journeyCalls.push(['create',input]);const g={...input,id:'journey-goal',projectName:'storefront',status:'draft',baseCommit:'a18f50cc937',createdAt:now,updatedAt:now,claims:[],proofs:[],checkpoints:[],autopilot:{enabled:false,providerId:null,model:null,budgetUsd:input.budgetUsd,spendUsd:0,spendStatus:'none',haltedReason:null,haltedAt:null},nodes:input.plan.map((n,i)=>({...n,id:'task-'+i,docketId:'journey-goal',dependsOn:n.dependsOn.map(d=>'task-'+d),status:n.dependsOn.length?'blocked':'ready',providerId:null,model:null,sessionId:null,worktree:null,startedAt:null,endedAt:null,detail:null,deferUntil:null,queued:false}))};window.__journeyGoals.push(g);return structuredClone(g);},
   start:async(id,input)=>{window.__journeyCalls.push(['start',id,input]);const n=find(id);n.status='running';goal().autopilot.spendStatus='unreported';n.sessionId='s1';n.startedAt=Date.now();derive();return structuredClone(n);},
   complete:async(id,input)=>{window.__journeyCalls.push(['complete',id,input]);if(window.__decisionFail)throw new Error('Fixture decision refused');const n=find(id);n.status=input.decision==='approve'?'completed':'failed';n.detail=input.detail??null;n.endedAt=Date.now();if(n.kind==='review')goal().proofs.unshift({id:'decision',docketId:goal().id,nodeId:id,kind:'decision',status:input.decision==='approve'?'passed':'failed',summary:input.detail??'Operator approved the goal.',createdAt:Date.now()});derive();return structuredClone(n);},
   retry:async id=>{window.__journeyCalls.push(['retry',id]);find(id).status='ready';derive();return structuredClone(find(id));},
   runProof:async id=>{window.__journeyCalls.push(['runProof',id]);goal().proofs.push({id:'proof',docketId:goal().id,nodeId:id,kind:'test',status:'passed',summary:'48 checkout tests passed, including duplicate callbacks and response timeouts.',createdAt:Date.now()});return structuredClone(goal().proofs.at(-1));},
  };
  window.wanigan=new Proxy(api,{get(api,service){
   if(service==='control')return new Proxy(api.control,{get(target,key){return controls[key]??target[key];}});
   if(service==='sessions')return new Proxy(api.sessions,{get(target,key){if(key==='list')return async()=> (await api.sessions.list()).slice(0,2).map(s=>({...s,projectId:'p1',projectName:'storefront',projectPath:'/example/storefront',displayTitle:s.id==='s1'?'Map the checkout boundary':'Independent notes',title:s.id==='s1'?'Map the checkout boundary':'Independent notes',label:s.id==='s1'?'Map the checkout boundary':'Independent notes'}));if(key==='scrollback')return async()=> '\x1b[36mWanigan renderer fixture · no live provider\x1b[0m\r\n\r\n> Make payment retries safe when the response is lost.\r\n\r\n  Reading src/checkout.ts and its current tests.\r\n  Checking the idempotency boundary before proposing changes.\r\n\r\n  Plan · Keep the original payment result on a repeated callback.\r\n  Verify · Cover timeouts and duplicate callbacks.\r\n  Review · Bring the proof back to the goal.\r\n';if(key==='write')return async(...args)=>window.__journeyCalls.push(['write',...args]);return target[key];}});
   if(service==='attention')return {list:async()=>structuredClone(window.__journeyAttention)};
   if(service==='on')return new Proxy(api.on,{get(target,key){return callback=>{if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(callback);return()=>listeners.get(key).delete(callback);};}});
   return api[service];
  }});
 });
 const capture=async name=>{await page.evaluate(()=>{document.activeElement?.blur();document.querySelector('.control-reading')?.scrollTo(0,0);});for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForFunction(()=>[...document.querySelectorAll('.wanigan-orb')].filter(el=>el.getBoundingClientRect().width>0).every(el=>el.dataset.physics==='ready'));await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css'});}};
 const go=async key=>{await page.locator('.space-dock button').first().focus();await page.keyboard.press(key);};
 const task=id=>page.locator(`.control-steps [data-node-id="task-${id}"]`);
 const panel=()=>page.getByRole('tabpanel');
 const refresh=async()=>{await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.control-reading')?.getAttribute('aria-busy')==='false');};
 const calls=()=>page.evaluate(()=>window.__journeyCalls);
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();await go('Meta+3');
 await page.getByRole('button',{name:'New goal',exact:true}).click();
 await page.getByRole('button',{name:'I’ll write the plan',exact:true}).click();
 const sheet=page.locator('.planning-table');await sheet.getByRole('textbox',{name:'Title',exact:true}).first().fill('A checkout you can trust');
 await sheet.getByRole('textbox',{name:'Objective',exact:true}).fill('Make payment retries safe, even when a response never reaches the customer.');
 await sheet.getByRole('textbox',{name:'Acceptance checks · one per line',exact:true}).fill('A repeated callback creates one charge.\nThe timeout case has a passing regression test.\nThe final diff is reviewed.');
 await capture('planning');await sheet.getByRole('button',{name:'Create goal',exact:true}).click();await sheet.getByRole('heading',{name:'Ready when you are.',exact:true}).waitFor();await capture('saved');
 assert.equal((await calls()).filter(c=>c[0]==='start').length,0);
 await sheet.getByRole('button',{name:'Open goal',exact:true}).click();await page.locator('#goal-journey-goal').waitFor();await capture('ready');
 if(!before){assert.match(await page.locator('.goal-companion').innerText(),/One small beginning/);await page.getByRole('button',{name:'Prepare this task'}).click();await page.waitForFunction(()=>document.activeElement?.id==='control-task-title');}
 await panel().getByRole('button',{name:'Start isolated task',exact:true}).click();await page.locator('.sessions-view').waitFor();await page.locator('.terminal-host:visible').waitFor();
 if(!before){await page.getByRole('navigation',{name:'This session’s goal'}).waitFor();assert.match(await page.locator('.session-goal-trail').innerText(),/A checkout you can trust/);}
 if(!before){assert.match(await page.getByRole('region',{name:'Attention queue'}).innerText(),/Waiting for an attention signal/);assert.doesNotMatch(await page.getByRole('region',{name:'Attention queue'}).innerText(),/No sessions running/);}
 await capture('session');
 await page.evaluate(()=>{window.__journeyAttention=[{sessionId:'s1',kind:'permission',transitionId:'ask1',label:'Permission needed',since:Date.now(),tool:'Edit',detail:'Edit src/checkout.ts'}];window.__journeyEmit('sessionEvent',{sessionId:'s1'});});
 await page.waitForFunction(()=>document.querySelector('.companion-presence')?.dataset.signal==='permission');
 await page.locator('.companion-presence > button').click();await page.getByRole('dialog',{name:'Sessions that need you'}).waitFor();await capture('attention');
 if(!before)assert.match(await page.locator('.need-row').innerText(),/Map the checkout boundary[\s\S]*Open the permission prompt/);
 await page.locator('.need-row').click();await page.getByRole('dialog').waitFor({state:'hidden'});
 if(!before)await page.locator('.session-goal-link').click();else await go('Meta+3');
 await page.locator('#goal-journey-goal').waitFor();assert.equal(await task(0).getAttribute('aria-selected'),'true');
 if(!before){assert.match(await page.locator('.goal-companion').innerText(),/Work is in motion/);assert.equal(new URL(await page.url()).hash,'#goal=journey-goal&task=task-0');}
 await panel().getByRole('button',{name:'Mark complete',exact:true}).click();await task(1).click();await panel().getByRole('button',{name:'Mark complete',exact:true}).click();await task(2).click();
 await panel().getByRole('button',{name:'Run review gate',exact:true}).click();await panel().getByRole('button',{name:'Mark complete',exact:true}).click();await task(3).click();await capture('review');
 record('planning saves an explicit contract, launch opens the recorded session, attention opens the exact prompt, and the return path restores its exact goal task');
 if(!before){
  await task(0).click();await page.getByRole('button',{name:'Review the decision'}).click();assert.equal(await task(3).getAttribute('aria-selected'),'true');
  await panel().locator('.control-note > summary').click();await panel().getByRole('textbox',{name:'Evidence or handoff note'}).fill('The retries are covered and the diff is ready.');
  await page.evaluate(()=>window.__decisionFail=true);await panel().getByRole('button',{name:'Approve',exact:true}).click();await page.getByText('Fixture decision refused',{exact:true}).waitFor();
  assert.equal(await page.locator('.goal-companion').getAttribute('data-completions'),'0');assert.equal(await page.locator('.control-finish').count(),0);
  await page.evaluate(()=>window.__decisionFail=false);
 }
 await panel().getByRole('button',{name:'Approve',exact:true}).click();await page.locator('.control-identity').getByText('accepted',{exact:true}).waitFor();await capture('accepted');
 if(!before){
  assert.equal(await page.locator('.goal-companion').getAttribute('data-completions'),'1');assert.match(await page.locator('.control-finish').innerText(),/retries are covered/);
  await refresh();assert.equal(await page.locator('.goal-companion').getAttribute('data-completions'),'1');
  assert.equal(await page.locator('.control-finish').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>document.documentElement.dataset.motion='full');
  assert.notEqual(await page.locator('.control-finish').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await page.evaluate(()=>document.documentElement.dataset.motion='off');assert.equal(await page.locator('.control-finish').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await page.getByRole('button',{name:'Read review record',exact:true}).click();assert.match(await panel().innerText(),/completed/);
  await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+3');await page.locator('#goal-journey-goal').waitFor();
  assert.equal(await page.locator('.goal-companion').getAttribute('data-completions'),'0');
  record('failed approval retains the draft without celebrating; recorded acceptance celebrates once, keeps evidence, respects reduced motion, and reopening history does not replay it');
  await page.getByRole('button',{name:'Plan the next goal',exact:true}).click();await sheet.waitFor();assert.equal(await sheet.getByRole('textbox',{name:'Title',exact:true}).count(),0);await sheet.getByRole('button',{name:'Back to goals',exact:true}).click();
  assert.equal((await calls()).filter(c=>c[0]==='create').length,1);assert.equal((await calls()).filter(c=>c[0]==='start').length,1);
  // A failed refresh must not leave a confident next-action link.
  await page.evaluate(()=>window.__goalFail=true);await refresh();assert.match(await page.locator('.goal-companion').innerText(),/Waiting for a fresh read/);assert.equal(await page.locator('.goal-companion-action').count(),0);await capture('unavailable');
  await page.evaluate(()=>window.__goalFail=false);await refresh();assert.equal(await page.locator('.goal-companion').getAttribute('data-completions'),'0');
  // Exact session ownership, read failure, retry, and a delayed answer after switching.
  await go('Meta+1');await page.locator('.session-goal-trail').waitFor();await page.evaluate(()=>{window.__linkFail=true;window.__journeyEmit('queueChanged');});await page.getByRole('button',{name:'Retry goal link'}).waitFor();assert.equal(await page.locator('.session-goal-link').count(),0);
  await page.evaluate(()=>window.__linkFail=false);await page.getByRole('button',{name:'Retry goal link'}).click();await page.locator('.session-goal-link').waitFor();
  await page.evaluate(()=>{window.__holdLink='s1';window.__journeyEmit('queueChanged');});await page.waitForFunction(()=>!!window.__releaseLink);
  await page.locator('.session-item').filter({hasText:'Independent notes'}).click();await page.waitForFunction(()=>document.querySelector('.session-item.active')?.textContent.includes('Independent notes') && window.__linkReads.at(-1)==='s2');
  await page.evaluate(()=>{window.__holdLink=null;window.__releaseLink();});await page.locator('.session-goal-link').waitFor({state:'hidden'});assert.equal(await page.locator('.session-goal-link').count(),0);
  assert.equal((await calls()).filter(c=>c[0]==='write').length,0);
  record('next-goal planning does not spend or launch; unavailable reads disable guidance, retry restores the exact link, and late answers cannot attach a goal to an unrelated session');
  // A freshly shown terminal owns keyboard focus after its two layout frames.
  // Use the visible destination here; keyboard routes are covered earlier.
  await page.locator('.space-dock').getByRole('button',{name:'Review',exact:true}).click();await page.locator('#goal-journey-goal').waitFor();
  await page.evaluate(()=>{const g=window.__journeyGoals[0];g.status='blocked';g.nodes[1].status='failed';g.nodes[1].title='InvestigateAnExceptionallyLongUnbrokenIdentifierThatMustNeverForceTheWorkspaceWiderThanTheWindow';g.nodes[1].detail='A retry still creates a second charge.';g.title='A checkout you can trust across international storefronts and enterprise account workspaces';});await refresh();await page.getByRole('button',{name:'Inspect the blocker'}).click();assert.equal(await task(1).getAttribute('aria-selected'),'true');await capture('blocked');
  for(const width of [1080,1280,1720]){await page.setViewportSize({width,height:1000});await capture('width-'+width);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert(await page.locator('.control-reading').evaluate(el=>el.scrollWidth<=el.clientWidth+1));}
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Give Wanigan a nudge',exact:true}).click();assert.match(await page.locator('.goal-companion').innerText(),/Supervising. Very seriously/);
  record('long goal and task names fit 1080, 1280 and 1720 pixel windows in both themes; Wanigan keeps detailed GPU rendering and responds to a deliberate nudge');
 }
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'checks.json'),JSON.stringify({checks,errors,calls:await calls()},null,2));
 console.log(`Desktop journey ${before?'before capture':'probe'} passed.`);
} catch(error) {if(page){console.error('DIAGNOSTIC',await page.evaluate(()=>({active:document.querySelector('.session-item.active')?.textContent,trail:document.querySelector('.session-goal-trail')?.outerHTML,reads:window.__linkReads,nodes:window.__journeyGoals?.[0]?.nodes,errors:document.querySelector('.error-boundary')?.textContent})));await page.screenshot({path:path.join(out,'failure.png')});}throw error;} finally {await app.close();rmSync(dir,{recursive:true,force:true});}
