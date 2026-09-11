#!/usr/bin/env node
// Isolated renderer evidence. Fixtures do not prove main-process behavior.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/next-ten',before?'before':'after');mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-next-ten-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
let app,page;const checks=[],errors=[];
try{
 app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMedia({reducedMotion:'reduce'});await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  localStorage.setItem('wanigan.code','1');localStorage.setItem('wanigan.composer','1');
  localStorage.setItem('wanigan.promptStash', JSON.stringify([{id:1,text:'Review checkout retries and add a regression case.',at:Date.now()},{id:2,text:'Explain the changes before we merge.',at:Date.now()-1000}]));
  const api=window.wanigan;window.__nextTenCalls=[];const listeners=new Map();
  window.__searchRequests=[];const searchPending=new Map();
  window.__resolveSearch=(query,fail=false)=>{const task=searchPending.get(query);if(!task)throw Error('Search was not requested: '+query);if(fail)task.reject(Error('Fixture archive unavailable'));else task.resolve([{sessionId:'archive-'+query,projectName:query+' archive',projectPath:'/example/archive',providerId:'claude',startedAt:Date.now(),snippet:'Recorded '+query+' conversation',role:'assistant',at:Date.now()}]);};
  window.__emit=(event,payload)=>listeners.get(event)?.forEach(callback=>callback(payload));
  window.wanigan=new Proxy(api,{get(target,service){
   if(service==='on')return new Proxy(target.on,{get(obj,key){return callback=>{const set=listeners.get(key)??new Set();set.add(callback);listeners.set(key,set);return()=>set.delete(callback);};}});
   if(service==='policy')return new Proxy(target.policy,{get(obj,key){if(key==='trust')return async()=> 'project';return obj[key];}});
   if(service==='companion')return new Proxy(target.companion,{get(obj,key){if(key==='snapshot')return async(...args)=>{const result=await obj.snapshot(...args);if(window.__brokenView)result.projects[0].name={fixture:'intentional render failure'};return result;};return obj[key];}});
   if(service==='transcripts')return new Proxy(target.transcripts,{get(obj,key){if(key==='search')return query=>{window.__searchRequests.push(query);return window.__holdSearch?new Promise((resolve,reject)=>searchPending.set(query,{resolve,reject})):Promise.resolve([]);};return obj[key];}});
   if(service==='code')return new Proxy(target.code,{get(obj,key){
    if(key==='changes')return async()=>({isRepo:true,branch:'feature/checkout',files:[{path:'src/checkout.ts',index:' ',work:'M',staged:false,untracked:false,preexisting:false},{path:'tests/checkout.test.ts',index:' ',work:'A',staged:false,untracked:false,preexisting:false}],headMoved:false,commits:0});
    if(key==='diff')return async()=> 'diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1,4 +1,5 @@\n-export function checkout() {\n+export function checkout(key: string) {\n+  const existing = payments.get(key);\n+  if (existing) return existing;\n   return payments.create();\n }\n';
    if(key==='editors')return async()=>[];
    return obj[key];}});
   if(service==='sessions')return new Proxy(target.sessions,{get(obj,key){
    if(key==='scrollback')return async()=> 'Wanigan renderer fixture — no live provider\r\n\r\n> Make checkout retries safe.\r\n\r\nReading src/checkout.ts and its tests.\r\nChecking the idempotency boundary.\r\n';
    if(key==='write')return async(...args)=>window.__nextTenCalls.push(['write',...args]);
    if(key==='create')return async options=>{window.__nextTenCalls.push(['create',options]);throw Error('Fixture launch was refused. No process was started.');};
    return obj[key];}});
   return target[service];
  }});
 });
 const go=async key=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
 const capture=async name=>{if(process.argv.includes('--checks-only'))return;for(const theme of ['dark','light']){await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;window.dispatchEvent(new CustomEvent('wanigan:theme-changed',{detail:{preference:t,resolved:t}}));},theme);await page.waitForTimeout(200);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css',animations:'disabled'});}console.log('Captured',name);};
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
 await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');await capture('companion');
 await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();await capture('play');await page.keyboard.press('Escape');
 await go('Meta+k');await page.getByRole('dialog').waitFor();await capture('commands');await page.keyboard.press('Escape');
 await go('Meta+/');await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor();await capture('shortcuts');await page.keyboard.press('Escape');
 await go('Meta+t');await page.getByRole('dialog',{name:'New session',exact:true}).waitFor();await capture('launch');await page.keyboard.press('Escape');
 await go('Meta+1');await page.locator('.sessions-view').waitFor();await page.locator('.terminal-host:visible').waitFor();await capture('composer');
 await page.locator('.composer-stash').click();await capture('saved-prompts');
 if(before)await page.locator('.composer-stash').click();else await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Timeline',exact:true}).click();await page.locator('.tl').waitFor();await capture('timeline');
 await page.getByRole('button',{name:'Code',exact:true}).click();await page.locator('.code-panel').waitFor();await capture('code');
 await page.locator('.code-file').filter({hasText:'src/checkout.ts'}).click();
 await page.getByRole('button',{name:before?'Pop out':'Read code',exact:true}).click();await page.getByRole('dialog',{name:/Code inspector:/}).waitFor();await capture('reader');await page.keyboard.press('Escape');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(800,900));await page.waitForFunction(()=>innerWidth===800);await capture('compact');
 if(!before){await page.locator('.session-side-panel-toggle').click();await capture('compact-details');await page.getByRole('button',{name:'Back to terminal',exact:true}).click();}
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.waitForFunction(()=>innerWidth===1440);
 await go('Meta+,');await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();await capture('appearance');
 await page.evaluate(()=>window.__emit('notificationRaised',{at:Date.now(),title:'Checkout needs permission',body:'Claude is waiting for you to review a shell command.',urgent:true,target:{kind:'session',sessionId:'s1'}}));await page.locator('.alert-card').waitFor();await capture('alerts');await page.getByRole('button',{name:'Dismiss: Checkout needs permission',exact:true}).click();
 await page.evaluate(()=>window.__brokenView=true);await go('Meta+k');await page.getByRole('combobox',{name:'Search views, projects, live sessions, settings and archived transcripts'}).fill('Mission');await page.keyboard.press('Enter');await page.locator(before?'.empty[role="alert"]':'.view-recovery').waitFor();await capture('recovery');await page.evaluate(()=>window.__brokenView=false);await page.getByRole('button',{name:'Reload view',exact:true}).click();await page.locator('.mission-room').waitFor();
 if(!before){
  const ok=name=>{checks.push(name);console.log('PASS',name);};
  const resize=async(width,height)=>{await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);await page.waitForFunction(w=>innerWidth===w,width);};
  const fits=async selector=>assert.equal(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;}),true,`${selector} fits the window`);
  const palette=async()=>{await go('Meta+k');await page.getByRole('combobox',{name:'Search views, projects, live sessions, settings and archived transcripts'}).waitFor();};
  await palette();const search=page.getByRole('combobox',{name:'Search views, projects, live sessions, settings and archived transcripts'});
  await search.fill('store');await search.press('End');assert.equal(await search.evaluate(el=>el.selectionStart),5);await search.press('Home');assert.equal(await search.evaluate(el=>el.selectionStart),0);
  await page.locator('.command-scopes').getByRole('button',{name:'Projects',exact:true}).click();assert.match(await page.getByRole('listbox').innerText(),/storefront/);assert.equal(await page.getByRole('listbox').getByRole('group').count(),1);
  await page.keyboard.press('Escape');ok('Command search preserves caret keys and scopes projects');
  await page.evaluate(()=>{window.__holdSearch=true;window.__searchRequests=[];});await palette();await search.fill('store');await page.waitForFunction(()=>window.__searchRequests.includes('store'));
  const choice=page.getByRole('group',{name:/^Projects, /}).getByRole('option').first();await choice.hover();const chosen=await page.locator('.command-results').getByRole('option',{selected:true}).innerText();await page.mouse.move(20,20);
  await page.evaluate(()=>window.__resolveSearch('store'));await page.getByRole('option').filter({hasText:'Recorded store conversation'}).waitFor();assert.equal(await page.locator('.command-results').getByRole('option',{selected:true}).innerText(),chosen);
  await search.fill('older-query');await page.waitForFunction(()=>window.__searchRequests.includes('older-query'));await search.fill('newer-query');await page.waitForFunction(()=>window.__searchRequests.includes('newer-query'));
  await page.evaluate(()=>window.__resolveSearch('newer-query'));await page.getByRole('option').filter({hasText:'Recorded newer-query conversation'}).waitFor();await page.evaluate(()=>window.__resolveSearch('older-query'));await page.waitForTimeout(100);assert.doesNotMatch(await page.getByRole('listbox').innerText(),/Recorded older-query/);
  await search.fill('failed-query');await page.waitForFunction(()=>window.__searchRequests.includes('failed-query'));await page.evaluate(()=>window.__resolveSearch('failed-query',true));await page.getByText('Transcript search unavailable. Other results are still available.').waitFor();
  await page.keyboard.press('Escape');await page.evaluate(()=>window.__holdSearch=false);ok('Async transcript results retain selection, ignore stale replies and show failure honestly');

  await go('Meta+/');const shortcuts=page.getByRole('dialog',{name:'Keyboard shortcuts'});await shortcuts.getByRole('searchbox').fill('composer');assert.match(await shortcuts.locator('.shortcut-groups').innerText(),/composer/i);
  await shortcuts.getByRole('searchbox').fill('not-a-real-shortcut');await shortcuts.getByRole('button',{name:'Clear search'}).click();assert.ok(await shortcuts.locator('tbody tr').count()>25);
  await shortcuts.getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('.shortcut-browser')),true);
  await shortcuts.getByRole('searchbox').fill('composer');await capture('shortcuts-search');await page.keyboard.press('Escape');ok('Shortcut help filters canonical actions, clears empty results and contains focus');

  await go('Meta+t');const launch=page.getByRole('dialog',{name:'New session',exact:true});await launch.getByRole('combobox',{name:'Project',exact:true}).selectOption('p2');
  await launch.getByRole('button',{name:/^Codex/}).click();await launch.locator('#launch-first-message').fill('Check retries; show me the plan first.');assert.match(await launch.locator('.launch-summary').innerText(),/platform/);assert.match(await launch.locator('.launch-summary').innerText(),/Codex/);
  await resize(1100,700);await fits('.session-launch');await fits('.launch-submit');await capture('launch-short');
  await launch.getByRole('button',{name:'Start session',exact:true}).click();await launch.getByRole('alert').waitFor();assert.equal(await launch.locator('#launch-first-message').inputValue(),'Check retries; show me the plan first.');
  const call=await page.evaluate(()=>window.__nextTenCalls.find(c=>c[0]==='create'));assert.equal(call[1].projectId,'p2');assert.equal(call[1].providerId,'codex');assert.equal(call[1].initialPrompt,'Check retries; show me the plan first.');
  await page.keyboard.press('Escape');await resize(1440,1000);ok('Launch summary matches its payload; short windows keep Start visible; refused launch preserves input');

  await go('Meta+1');const draft=page.getByRole('textbox',{name:'Message the agent',exact:true});await draft.fill('Keep this draft while I inspect the code.');await draft.press('Meta+s');
  await page.getByRole('button',{name:'Saved prompts',exact:true}).click();await fits('.composer-stash-pop');await page.getByRole('searchbox',{name:'Search saved prompts'}).fill('checkout');assert.equal(await page.locator('.composer-stash-restore').count(),1);
  await page.locator('.composer-stash-restore').click();assert.equal(await draft.inputValue(),'Review checkout retries and add a regression case.');assert.equal(await page.evaluate(()=>window.__nextTenCalls.filter(c=>c[0]==='write').length),0);
  await page.getByRole('button',{name:'Saved prompts',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Saved prompts',exact:true}).evaluate(el=>el===document.activeElement),true);ok('Saved prompts search, restore without sending, fit above composer and return focus');

  await page.getByRole('button',{name:'Timeline',exact:true}).click();await page.locator('.tl-summary').waitFor();assert.equal(await page.locator('.tl-summary').getAttribute('open'),null);
  const timelineSearch=page.getByRole('searchbox',{name:'Filter timeline events'});await timelineSearch.fill('no-such-file');await page.getByRole('button',{name:'Clear filters',exact:true}).click();assert.equal(await timelineSearch.inputValue(),'');
  await page.locator('.tl-summary > summary').click();assert.notEqual(await page.locator('.tl-summary').getAttribute('open'),null);await page.locator('.tl-summary > summary').click();ok('Timeline leads with events and keeps timing and filter recovery available');
  await page.getByRole('button',{name:'Code',exact:true}).click();await page.locator('.code-file').filter({hasText:'src/checkout.ts'}).click();await page.getByRole('button',{name:'Read code',exact:true}).click();
  const find=page.getByRole('textbox',{name:'Find in code'});await find.fill('checkout');await page.waitForFunction(()=>!!document.querySelector('[data-active-match="true"]'));const first=await page.locator('[data-active-match="true"]').innerText();
  await find.press('Enter');assert.notEqual(await page.locator('[data-active-match="true"]').innerText(),first);await find.press('Shift+Enter');assert.equal(await page.locator('[data-active-match="true"]').innerText(),first);
  await find.press('Shift+Enter');assert.match(await page.locator('.code-reader-find [role="status"]').innerText(),/5 of 5/);await find.press('Enter');assert.match(await page.locator('.code-reader-find [role="status"]').innerText(),/1 of 5/);
  await page.getByRole('button',{name:'No wrap',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Wrapped',exact:true}).getAttribute('aria-pressed'),'true');await capture('reader-search');await fits('.code-reader');assert.ok((await page.locator('.code-reader').boundingBox()).width>1000,'desktop reader uses the available width');await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Read code',exact:true}).evaluate(el=>el===document.activeElement),true);ok('Code reader cycles and wraps matching lines, toggles wrapping and returns focus');

  await draft.fill('A draft stays with this session.');await resize(800,900);const terminal=await page.locator('.terminal-host:visible .xterm').elementHandle();
  await page.locator('.session-side-panel-toggle').click();await page.getByRole('button',{name:'Back to terminal',exact:true}).waitFor();assert.equal(await page.locator('.term-col:visible').count(),0);assert.equal(await page.getByRole('button',{name:'Read code',exact:true}).isEnabled(),true,'selected file survives a change to the compact layout');
  await page.getByRole('button',{name:'Timeline',exact:true}).click();await page.getByRole('button',{name:'Back to terminal',exact:true}).click();assert.equal(await draft.inputValue(),'A draft stays with this session.');assert.equal(await terminal.evaluate(el=>el.isConnected&&el.getClientRects().length>0),true);
  await go('Meta+b');await page.getByRole('button',{name:'Back to terminal',exact:true}).waitFor();await page.keyboard.press('Meta+b');await page.locator('.terminal-host:visible').waitFor();await resize(1440,1000);ok('Compact details and its shortcut preserve the mounted terminal and unsent draft');

  await draft.focus();await page.evaluate(()=>{window.__emit('notificationRaised',{at:Date.now()-13000,title:'Old ordinary update',body:'Fixture completed event.',urgent:false});window.__emit('notificationRaised',{at:Date.now()-13000,title:'Permission stays until dismissed',body:'Fixture permission request.',urgent:true});});
  await page.getByRole('alert').filter({hasText:'Permission stays until dismissed'}).waitFor();assert.equal(await draft.evaluate(el=>document.activeElement===el),true);assert.equal(await page.evaluate(()=>document.querySelector('.alert-stack').getBoundingClientRect().top>=document.querySelector('.app-header').getBoundingClientRect().bottom),true,'alerts clear the actual header');await page.waitForFunction(()=>![...document.querySelectorAll('.alert-card')].some(el=>el.textContent.includes('Old ordinary update')));
  assert.equal(await page.getByRole('alert').filter({hasText:'Permission stays until dismissed'}).count(),1);await page.getByRole('button',{name:'Dismiss: Permission stays until dismissed',exact:true}).click();ok('Notifications preserve focus and distinguish expiring updates from persistent urgent events');
  ok('Injected view error is contained; Reload remounts only the failed view');

  await page.emulateMedia({reducedMotion:'reduce',contrast:'more'});await page.evaluate(()=>document.documentElement.dataset.motion='auto');assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--mo-state').trim()),'0ms');
  await palette();await capture('contrast');await fits('.command-workspace');await page.keyboard.press('Escape');
  await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce',contrast:'no-preference'});await palette();assert.equal(await page.evaluate(()=>matchMedia('(forced-colors: active)').matches),true);assert.equal(await search.evaluate(el=>getComputedStyle(el).outlineStyle),'solid');await capture('forced-colors');await page.keyboard.press('Escape');
  await page.emulateMedia({forcedColors:'none',reducedMotion:'reduce',contrast:'no-preference'});const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-transparency: reduce)').matches),true);await palette();assert.equal(await page.locator('.command-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter),'none');await capture('opaque');await page.keyboard.press('Escape');await cdp.send('Emulation.setEmulatedMedia',{features:[]});await cdp.detach();ok('Reduced motion, increased contrast, forced colours and reduced transparency are exercised in Chromium');

  await palette();await search.fill('Mission');await page.keyboard.press('Enter');await page.locator('.mission-room').waitFor();await page.evaluate(()=>document.documentElement.dataset.motion='full');await page.waitForFunction(()=>document.querySelector('.mission-presence .wanigan-orb')?.dataset.physics==='ready');
  await resize(1440,900);await page.locator('.mission-room').evaluate(el=>el.scrollTop=374);const menu=async()=>page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();await menu();await fits('.mission-temperament');await fits('.mission-presence .wanigan-orb');
  assert.equal(await page.evaluate(()=>{const a=document.querySelector('.mission-temperament').getBoundingClientRect(),b=document.querySelector('.mission-presence .wanigan-orb').getBoundingClientRect();return a.left>=b.right||a.right<=b.left||a.top>=b.bottom||a.bottom<=b.top;}),true,'play panel leaves the character visible');
  await page.getByRole('button',{name:'Plasma globe',exact:true}).click();await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('.mission-presence canvas')?.dataset.material==='8');
  await menu();await page.getByRole('button',{name:'Little rainstorm',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mission-presence canvas')?.dataset.material==='0'&&Number(document.querySelector('.mission-presence canvas')?.dataset.weather)>.8);assert.match(await page.locator('.mission-play-response').innerText(),/Little rainstorm/);
  await menu();await page.getByRole('button',{name:'Drop some ink',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.mission-presence canvas')?.dataset.material==='4');await menu();await page.getByRole('button',{name:'Shake the globe',exact:true}).click();await menu();await fits('.mission-temperament');await page.getByRole('button',{name:'Lava lamp',exact:true}).click();await page.keyboard.press('Escape');await page.evaluate(()=>document.documentElement.dataset.motion='off');await page.waitForTimeout(250);const frames=await page.locator('.mission-presence canvas').getAttribute('data-submissions');await page.locator('.mission-presence .wanigan-orb').press('s');await page.waitForTimeout(300);assert.equal(await page.locator('.mission-presence canvas').getAttribute('data-submissions'),frames);ok('Visible play controls select real GPU materials, rain uses water, and motion-off stays still');
  assert.equal(await page.evaluate(()=>window.__nextTenCalls.filter(c=>c[0]==='write').length),0);ok('The entire renderer probe made no PTY writes');
 }
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,provenance:'Real Electron renderer with authored fixtures, including one deliberately invalid project name to exercise the error boundary. No live app session, provider call, or repository action.'},null,2)+'\n');
}catch(error){if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.log(await page.evaluate(()=>['.mission-temperament','.mission-presence','.mission-orb-caption','.mission-room','.body'].map(selector=>{const e=document.querySelector(selector);return e?{selector,rect:e.getBoundingClientRect().toJSON(),scroll:e.scrollTop,positionArea:getComputedStyle(e).positionArea}:null;})).catch(()=>null));}throw error;}
finally{if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
