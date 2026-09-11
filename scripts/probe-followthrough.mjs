#!/usr/bin/env node
// Real Electron renderer; authored fixtures. No provider, shell or repository action.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/followthrough',before?'before':'after');mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-followthrough-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
let app,page;const checks=[],errors=[];
try {
 app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
 page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMedia({reducedMotion:'reduce'});await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  localStorage.setItem('wanigan.code','1');localStorage.setItem('wanigan.composer','1');
  const now=Date.now();const api=window.wanigan;const listeners=new Map();window.__calls=[];
  window.__emit=(event,payload)=>listeners.get(event)?.forEach(fn=>fn(payload));
  window.__setup={agents:[{id:'claude',label:'Claude Code',harnessId:'claude-code',found:true,path:'/example/bin/claude',version:'fixture',signedIn:'unknown',credential:'harness-login'}],searched:['/example/bin'],projects:0,sessionsStarted:0};
  window.__discovered={scanned:64,truncated:false,projects:Array.from({length:14},(_,i)=>({path:'/example/'+(i===13?'archive/':'work/')+(i===12?'storefront':`project-${i+1}`),name:i===12?'storefront':`Project ${i+1}`,remote:'https://example.com/repo',conversations:i+1,lastActiveAt:now-i*86400000,known:i===2,sources:['claude']}))};
  window.__team={teams:[{name:'checkout-reliability',configPath:'/example/team',members:[{name:'lead',isLead:true,agentId:null,agentType:'claude-code'},{name:'builder',isLead:false,agentId:null,agentType:'claude-code'},{name:'reviewer',isLead:false,agentId:null,agentType:'claude-code'}],tasks:Array.from({length:30},(_,i)=>({id:'t'+i,title:i===29?'Verify the final retry boundary':i===0?'Add an idempotency check before creating a second payment':`Review checkout case ${i+1}`,status:i===0?'in_progress':i<5?'completed':'pending',assignee:i===0?'builder':i<5?'reviewer':null,dependsOn:i>4?['t0','t1']:[],blocked:i>4,blockedBy:i>4?1:0,updatedAt:now-90000})),pending:Array.from({length:10},(_,i)=>({to:'reviewer',from:'builder',at:now-60000,kind:'message',preview:i===9?'The final message stays reachable after the first eight.':'The retry check is ready. Please inspect the response when a payment was already recorded; the original request should be returned without creating another payment.'})),counts:{pending:25,inProgress:1,completed:4,blocked:25},updatedAt:now-90000}],enabled:true,note:'Read from the shared task list and inbox files. These are recorded observations.'};
  window.__recipe={p1:['npm test','git diff --check'],p2:['npm run verify:platform']};
  window.__runs=[{id:'r1',projectId:'p1',startedAt:now-180000,endedAt:now-150000,status:'failed',results:[{command:'npm test',exitCode:1,output:'FAIL checkout retry\nExpected one payment, received two.\n\nInspect src/checkout.ts:42 before recording approval.',durationMs:3200}]},{id:'r2',projectId:'p1',startedAt:now-86400000,endedAt:now-86400000+1200,status:'passed',results:[{command:'npm test',exitCode:0,output:'24 tests passed',durationMs:1200}]}];
  window.__ledger={sessionId:'s1',briefings:[{sessionId:'s1',at:now-900000,delivery:'argv',providerId:'claude',projectId:'p1',entries:[{itemId:'k1',versionId:'v1',kind:'rule',title:'Preserve the original payment when checkout is retried with the same key',estimatedTokens:72,checked:2,skipped:0}],estimatedTokens:72,maxTokens:1200,omittedStale:1,omittedBudget:0,omittedUnsynthesized:0,omittedUnverified:0,sessionStartAt:null}],signals:Array.from({length:18},(_,i)=>({id:'l'+i,sessionId:'s1',kind:i===0?'tool-failure':'tool-success',summary:i===0?'The repeated checkout request created a second payment. The failure was reproduced with the same idempotency key and needs a regression check before acceptance.':`Verified checkout condition ${i+1}`,detail:{toolName:'Read',ok:i!==0},createdAt:now-i*10000})),contributions:[{itemId:'k2',title:'Retain the first successful response for a repeated payment key',kind:'memory',status:'active',evidenceCount:2}],candidates:[{candidateId:'c1',title:'Document the checkout retry boundary',status:'pending',targetKind:'rule'}],skillToolCalls:{observed:0,identifiers:[],unrecorded:0},transcriptCitations:{}};
  window.wanigan=new Proxy(api,{get(target,service){
   if(service==='on')return new Proxy(target.on,{get(obj,key){return fn=>{const set=listeners.get(key)??new Set();set.add(fn);listeners.set(key,set);return()=>set.delete(fn);};}});
   if(service==='preflight')return {read:async()=>{if(window.__setupError)throw Error('Fixture readiness unavailable');return structuredClone(window.__setup);},discover:async()=>structuredClone(window.__discovered),importProjects:async paths=>{window.__calls.push(['import',paths]);return [];}};
   if(service==='teams')return {read:async()=>{if(window.__teamError)throw Error('Fixture team read unavailable');return structuredClone(window.__team);}};
   if(service==='review')return {recipe:async id=>{if(window.__recipeError)throw Error('Fixture recipe unavailable');return {projectId:id,commands:window.__recipe[id]??[],updatedAt:now};},history:async id=>structuredClone(window.__runs).map(run=>({...run,projectId:id})),saveRecipe:async(id,commands)=>{window.__calls.push(['saveRecipe',id,commands]);if(window.__saveHold)await new Promise((resolve,reject)=>{window.__saveResolve=resolve;window.__saveReject=reject;});window.__recipe[id]=commands;return {projectId:id,commands,updatedAt:Date.now()};},run:async id=>{window.__calls.push(['run',id]);return window.__runs[0];}};
   if(service==='learning')return new Proxy(target.learning,{get(obj,key){if(key==='sessionLedger')return async id=>{if(window.__ledgerError)throw Error('Fixture ledger unavailable');return {...structuredClone(window.__ledger),sessionId:id};};return obj[key];}});
   if(service==='sessions')return new Proxy(target.sessions,{get(obj,key){if(key==='write'||key==='create')return async(...args)=>window.__calls.push([key,...args]);if(key==='scrollback')return async()=> 'Renderer fixture — no live provider\r\nChecking the checkout retry boundary.\r\n';return obj[key];}});
   return target[service];
  }});
 });
 const go=async key=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
 const capture=async name=>{if(process.argv.includes('--checks-only'))return;for(const theme of ['dark','light']){await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;window.dispatchEvent(new CustomEvent('wanigan:theme-changed',{detail:{preference:t,resolved:t}}));},theme);await page.waitForTimeout(150);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css',animations:'disabled'});}console.log('Captured',name);};
 const ok=name=>{checks.push(name);console.log('PASS',name);};
 await page.goto(rendererURL);await page.locator('.mission-setup').waitFor();await page.locator('.mission-setup').scrollIntoViewIfNeeded();await capture('setup');
 await page.getByRole('button',{name:'Find my projects',exact:true}).click();await page.locator('.mission-setup-candidates').waitFor();await page.locator('.mission-setup-found').scrollIntoViewIfNeeded();await capture('discovery');
 await go('Meta+9');await page.locator('.gt-review-controls').waitFor();await page.locator('.gt-review-controls > summary').click();await page.getByRole('textbox',{name:'Review gate commands'}).waitFor();await capture('review-checks');
 await page.locator('.gt-review-controls details > summary').first().click();await capture('review-output');
 await go('Meta+2');await page.getByRole('button',{name:'Show tasks',exact:true}).click();await page.getByText('checkout-reliability',{exact:true}).scrollIntoViewIfNeeded();if(!before)await page.locator('.team-workspace').evaluate(el=>{el.scrollIntoView({block:'start'});el.closest('.pane').scrollTop-=100;});await capture('team');
 await go('Meta+1');await page.getByRole('button',{name:'Learning',exact:true}).click();await page.getByRole('region',{name:'Session learning ledger'}).waitFor();await capture('learning');
 if(before){await page.getByRole('button',{name:'recent',exact:true}).click();await capture('learning-signals');}
 if(before && process.argv.includes('--diagnose')) {
  await go('Meta+9');await page.locator('.gt-review-controls').evaluate(el=>el.open=true);
  await page.getByRole('combobox',{name:'Repository',exact:true}).selectOption('p1');
  const commands=page.getByRole('textbox',{name:'Review gate commands'});
  await page.waitForFunction(()=>document.querySelector('[aria-label="Review gate commands"]').value==='npm test\ngit diff --check');
  await commands.fill('echo fixture A');await page.evaluate(()=>window.__saveHold=true);
  await page.getByRole('button',{name:'Save recipe',exact:true}).click();await page.waitForFunction(()=>!!window.__saveResolve);
  await page.getByRole('combobox',{name:'Repository',exact:true}).selectOption('p2');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Review gate commands"]').value==='npm run verify:platform');
  await page.evaluate(()=>window.__saveResolve());await page.waitForTimeout(150);
  console.log('DIAGNOSIS: project B after project A save:',await commands.inputValue());
  assert.equal(await commands.inputValue(),'echo fixture A','Reproduced: a late save loads the old recipe into the new project.');
  await page.evaluate(()=>window.__recipeError=true);await page.getByRole('combobox',{name:'Repository',exact:true}).selectOption('p1');
  await page.getByText('Fixture recipe unavailable',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Save recipe',exact:true}).isEnabled(),true,'Reproduced: failed recipe read still enables saving empty text.');
  console.log('DIAGNOSIS: failed recipe read enables saving.');
 }
 if(!before) {
  const resize=async(width,height)=>{await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);await page.waitForFunction(w=>innerWidth===w,width);};
  const noOverflow=async selector=>assert.equal(await page.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth+2),true,`${selector} has no horizontal overflow`);
  await go('Meta+Shift+h');await page.locator('.mission-setup').waitFor();
  assert.equal(await page.locator('.mission-setup-item[aria-current="step"]').count(),1);assert.match(await page.locator('.mission-setup-item[aria-current="step"]').innerText(),/A project/);
  assert.equal(await page.getByRole('button',{name:'Start a session',exact:true}).isDisabled(),true);assert.doesNotMatch(await page.locator('.mission-setup').innerText(),/not signed in|signed out/i);
  await page.getByRole('button',{name:'Find my projects',exact:true}).click();const projectSearch=page.getByRole('searchbox',{name:'Search discovered projects'});
  const selected=await page.locator('.mission-setup-candidates input:checked').count();assert.ok(selected>0);
  await projectSearch.fill('/archive/');assert.equal(await page.locator('.mission-setup-candidates li').count(),1);assert.match(await page.locator('.mission-setup-candidate-path').innerText(),/archive/);
  await page.locator('.mission-setup-candidates input').uncheck();await projectSearch.fill('');assert.equal(await page.locator('.mission-setup-candidates input:checked').count(),selected-1);
  await page.locator('.mission-setup-candidate-actions').getByRole('button',{name:/^Add /}).click();await page.getByText('No projects added. Your choices are still here.').waitFor();assert.equal(await page.locator('.mission-setup-candidates input:checked').count(),selected-1);
  await projectSearch.fill('not-a-project');await page.getByRole('button',{name:'Clear search',exact:true}).click();assert.equal(await page.locator('.mission-setup-candidates li').count(),14);
  await resize(800,900);await page.locator('.mission-setup').scrollIntoViewIfNeeded();await noOverflow('.mission-setup');await capture('discovery-compact');await resize(1440,1000);
  ok('Setup follows observed readiness; discovery searches paths and preserves hidden selections after cancellation');

  await go('Meta+9');await page.locator('.gt-review-controls').evaluate(el=>el.open=true);
  const repository=page.getByRole('combobox',{name:'Repository',exact:true});const commands=page.getByRole('textbox',{name:'Review gate commands'});
  await repository.selectOption('p1');await page.waitForFunction(()=>document.querySelector('[aria-label="Review gate commands"]').value==='npm test\ngit diff --check');
  await commands.fill('echo fixture A');await page.evaluate(()=>window.__saveHold=true);await page.getByRole('button',{name:'Save & run checks',exact:true}).click();await page.waitForFunction(()=>!!window.__saveResolve);
  await repository.selectOption('p2');await page.waitForFunction(()=>document.querySelector('[aria-label="Review gate commands"]').value==='npm run verify:platform');await page.evaluate(()=>window.__saveResolve());await page.waitForTimeout(100);
  assert.equal(await commands.inputValue(),'npm run verify:platform');assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='run').length),0);
  await page.evaluate(()=>{window.__recipeError=true;window.__saveHold=false;});await repository.selectOption('p1');await page.getByText('Fixture recipe unavailable',{exact:true}).waitFor();assert.equal(await commands.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Save recipe',exact:true}).isDisabled(),true);await capture('review-unavailable');
  await page.evaluate(()=>window.__recipeError=false);await page.getByRole('button',{name:'Retry recipe read',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="Review gate commands"]').disabled);
  await commands.fill('npm test');await page.evaluate(()=>{window.__saveHold=true;window.__saveResolve=null;});await page.getByRole('button',{name:'Save & run checks',exact:true}).click();await page.waitForFunction(()=>!!window.__saveResolve);await page.evaluate(()=>window.__saveReject(Error('Fixture consent cancelled')));await page.getByText('Fixture consent cancelled',{exact:true}).waitFor();assert.equal(await commands.inputValue(),'npm test');assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='run').length),0);
  await page.evaluate(()=>window.__saveHold=false);await page.getByRole('button',{name:'Save & run checks',exact:true}).click();await page.getByText('Checks failed. Read the recorded output below.').waitFor();assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='run').length),1);
  await page.locator('.review-result > summary').first().click();await page.locator('.review-command pre').first().focus();assert.equal(await page.locator('.review-command pre').first().evaluate(el=>el===document.activeElement),true);
  await resize(800,900);await noOverflow('.review-checks');await capture('review-compact');await resize(1440,1000);
  ok('Review checks reject late cross-project state, block unread recipes, preserve refused edits and record explicit runs');

  await go('Meta+2');await page.getByRole('button',{name:'Show tasks',exact:true}).click();const team=page.getByRole('region',{name:'Agent teams'});
  await team.getByRole('button',{name:'Show more tasks',exact:true}).click();assert.equal(await team.locator('.team-tasks > li').count(),30);
  const teamSearch=team.getByRole('searchbox',{name:'Search team tasks'});await teamSearch.fill('final retry');assert.equal(await team.locator('.team-tasks > li').count(),1);assert.match(await team.locator('.team-tasks').innerText(),/final retry boundary/);
  await teamSearch.fill('');await team.getByRole('group',{name:'Team task status'}).getByRole('button',{name:'Blocked',exact:true}).click();assert.match(await team.locator('.team-blocker').first().innerText(),/1 of 2/);assert.equal(await team.locator('.team-tasks > li').count(),24);
  await team.getByRole('group',{name:'Team task status'}).getByRole('button',{name:'Blocked',exact:true}).press('ArrowRight');assert.equal(await team.getByRole('button',{name:'Completed',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await team.locator('.team-tasks > li').count(),4);
  await team.locator('.team-mail > summary').click();assert.equal(await team.locator('.team-mail article').count(),10);await team.locator('.team-mail article').last().scrollIntoViewIfNeeded();await capture('team-messages');
  await page.evaluate(()=>{window.__teamError=true;document.dispatchEvent(new Event('visibilitychange'));});await team.getByText(/Showing the last successful read/).waitFor();assert.equal(await team.locator('.team-tasks > li').count(),4);
  await page.evaluate(()=>window.__teamError=false);await team.getByRole('button',{name:'Retry team read',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.team-workspace .note'));
  await resize(800,900);await team.evaluate(el=>{el.scrollIntoView({block:'start'});el.closest('.pane').scrollTop-=100;});await noOverflow('.team-workspace');await capture('team-compact');await resize(1440,1000);
  ok('Team tasks and all stored message previews stay reachable; filters, dependency counts and stale-read recovery hold');

  await go('Meta+1');await page.getByRole('button',{name:'Learning',exact:true}).click();const ledger=page.getByRole('region',{name:'Session learning ledger'});
  await ledger.getByRole('group',{name:'Session learning area'}).getByRole('button',{name:'Signals 18',exact:true}).click();await ledger.locator('.sl-signal summary').first().click();assert.match(await ledger.locator('.sl-signal-copy:visible').innerText(),/needs a regression check before acceptance/);await capture('learning-signals');
  await ledger.getByRole('button',{name:'Show more signals',exact:true}).click();assert.equal(await ledger.locator('.sl-signal').count(),18);
  await ledger.getByRole('checkbox',{name:'Failures and denials only'}).check();assert.equal(await ledger.locator('.sl-signal').count(),1);
  await ledger.getByRole('searchbox',{name:'Search learning signals'}).fill('missing-signal');await ledger.getByRole('button',{name:'Clear signal filters',exact:true}).click();assert.equal(await ledger.getByRole('checkbox').isChecked(),false);
  await ledger.getByRole('searchbox',{name:'Search learning signals'}).fill('condition 18');assert.equal(await ledger.locator('.sl-signal').count(),1);
  await page.evaluate(()=>{window.__ledgerError=true;window.__emit('learningChanged');});await ledger.getByText(/Showing the last successful read/).waitFor();assert.equal(await ledger.getByRole('searchbox').inputValue(),'condition 18');assert.equal(await ledger.locator('.sl-signal').count(),1);await capture('learning-stale');
  await page.evaluate(()=>window.__ledgerError=false);await ledger.getByRole('button',{name:'Retry ledger update',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.sl-panel .note'));
  await ledger.getByRole('button',{name:'Briefing',exact:true}).click();
  await page.evaluate(()=>{const earlier=structuredClone(window.__ledger.briefings[0]);earlier.at-=600000;earlier.entries[0].title='Earlier recorded briefing';window.__ledger.briefings.push(earlier);window.__emit('learningChanged');});
  const briefings=ledger.getByRole('combobox',{name:'Recorded briefing'});await briefings.waitFor();await briefings.selectOption({index:2});await ledger.getByText('Earlier recorded briefing',{exact:true}).waitFor();const selectedBriefing=await briefings.inputValue();
  await page.evaluate(()=>{const newest=structuredClone(window.__ledger.briefings[0]);newest.at+=10000;newest.entries[0].title='A newer briefing arrived';window.__ledger.briefings.unshift(newest);window.__emit('learningChanged');});
  await page.waitForFunction(()=>document.querySelector('[aria-label="Recorded briefing"]').options.length===4);assert.equal(await briefings.inputValue(),selectedBriefing);assert.equal(await ledger.getByText('Earlier recorded briefing',{exact:true}).isVisible(),true);await capture('learning-history');
  await ledger.getByRole('button',{name:'Contributions 2',exact:true}).click();assert.equal(await ledger.locator('.sl-contribution').count(),2);await capture('learning-contributions');
  await resize(800,900);await page.locator('.session-side-panel-toggle').click();await noOverflow('.sl-panel');await capture('learning-compact');await resize(1440,1000);
  ok('Learning exposes full summaries, retained signals and contribution states; failed refreshes preserve the filtered view');
  assert.equal(await page.evaluate(()=>window.__calls.filter(call=>call[0]==='write'||call[0]==='create').length),0);ok('No provider launch or terminal write occurred');
 }
 // CHECKS_INSERT
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,provenance:'Isolated Electron renderer with authored fixtures. All actions terminate at fixture methods.'},null,2)+'\n');
} catch(error){if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.log((await page.locator('body').innerText()).slice(-4500));}throw error;}
finally{if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
