#!/usr/bin/env node
// Isolated Electron with synthetic records. No production scans, settings, or Goals.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/scout-workspace',before?'before':'after');
mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-scout-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks=[],errors=[],dimensions=[];
const record=text=>{checks.push(text);console.log(text);};
try {
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 const archiveAt=process.argv.indexOf('--archive');
 if(archiveAt>=0){const archive=process.argv[archiveAt+1],asar=require('@electron/asar');await page.route(rendererURL.replace('/index.html','/**'),route=>{const name='out/renderer'+new URL(route.request().url()).pathname;return route.fulfill({body:asar.extractFile(archive,name),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(name)]??'application/octet-stream'});});}
 page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const original=window.wanigan,now=Date.now();window.__scoutCalls=[];window.__scoutReads=[];
  window.__scoutSettings={enabled:true,networkEnabled:false,weeklyEnabled:false,weekday:6,hour:9,providerId:null};
  window.__scoutSources=[
   {id:'anthropic',label:'Anthropic documentation',description:'Official agent documentation, capabilities, and release notes.',url:'https://docs.anthropic.com/',enabled:true},
   {id:'openai',label:'OpenAI documentation',description:'Official tooling documentation and integration changes.',url:'https://developers.openai.com/',enabled:true},
   {id:'electron',label:'Electron releases',description:'Desktop runtime releases and platform support.',url:'https://www.electronjs.org/releases/stable',enabled:true},
   {id:'mcp',label:'Model Context Protocol',description:'Protocol documentation and specification updates.',url:'https://modelcontextprotocol.io/',enabled:false},
  ];
  const evidence=(title,publisher,url,excerpt)=>({title,publisher,url,excerpt,publishedAt:now-86400000});
  window.__scoutRows=[
   {id:'proposal-1',title:'Make session handoffs easier to review',summary:'Keep the resumed session’s operating context close to its recorded evidence.',category:'Session continuity',status:'new',effort:'medium',risk:'low',confidence:.76,whyNow:'The local inventory shows a session resume path. Review the official guidance against the behavior Wanigan actually supports.',recommendation:'Inspect the current resume workflow and the evidence retained with a session.\n\nPropose a focused handoff view that names the source session, working branch, and last observed state. Validate the behavior before expanding provider support.',evidence:[evidence('Session continuity guidance','Anthropic','https://docs.anthropic.com/','Fixture excerpt: retained context and explicit handoffs help operators understand where a session resumes.'),evidence('Agent workflow documentation','OpenAI','https://developers.openai.com/','Fixture excerpt: a workflow should identify which state is observed and which action requires the operator.')],createdAt:now-3600000,goalId:null},
   {id:'proposal-2',title:'Review the desktop runtime baseline',summary:'Compare the packaged runtime with the official release channel and compatibility notes.',category:'Desktop platform',status:'new',effort:'small',risk:'medium',confidence:.62,whyNow:'The runtime inventory is available for a compatibility review.',recommendation:'Check the recorded runtime version against release notes. Document any required compatibility work before updating dependencies.',evidence:[evidence('Electron stable release notes','Electron','https://www.electronjs.org/releases/stable','Fixture excerpt: review platform compatibility alongside a runtime update.')],createdAt:now-7200000,goalId:null},
   {id:'proposal-3',title:'Clarify protocol capability boundaries',summary:'Make unsupported capabilities explicit before an operator starts a session.',category:'Interoperability',status:'reviewed',effort:'large',risk:'elevated',confidence:.58,whyNow:'The capability inventory includes several provider profiles.',recommendation:'Review declarations against verified behavior. Keep unsupported paths visibly unavailable.',evidence:[evidence('Protocol capability overview','MCP','https://modelcontextprotocol.io/','Fixture excerpt: capability negotiation should reflect the integration’s supported behavior.')],createdAt:now-86400000,goalId:null},
   {id:'proposal-4',title:'Tighten release-note provenance',summary:'Retain a clear publisher and date beside each source excerpt.',category:'Evidence quality',status:'snoozed',effort:'small',risk:'low',confidence:.7,whyNow:'Source metadata should stay visible through review.',recommendation:'Inspect retained source metadata.',evidence:[],createdAt:now-172800000,goalId:null},
   {id:'proposal-5',title:'Review source freshness before briefing',summary:'Track the age of retained evidence without presenting it as a new scan.',category:'Evidence quality',status:'dismissed',effort:'medium',risk:'low',confidence:null,whyNow:'A saved observation is different from a fresh observation.',recommendation:'Use the recorded timestamps.',evidence:[],createdAt:now-259200000,goalId:null},
  ];
  window.__scoutLatest={id:'run-1',mode:'manual',status:'completed',networkAllowed:true,startedAt:now-5400000,finishedAt:now-5300000,suggestionCount:3,detail:'Checked the enabled official sources and retained the matching proposals.',error:null};
  const read=async(method,value)=>{window.__scoutReads.push(method);if(window.__scoutReadFailure)throw new Error('Fixture Scout database unavailable');const copy=structuredClone(value);if(method==='suggestions'&&window.__holdRead)return new Promise(resolve=>window.__releaseRead=()=>resolve(copy));return copy;};
  const mutate=async(method,...args)=>{window.__scoutCalls.push([method,...args]);if(window.__scoutActionFailure)throw new Error('Fixture action refused');if(window.__holdAction)await new Promise(resolve=>window.__releaseAction=resolve);};
  window.wanigan=new Proxy(original,{get(api,service){if(service!=='scout')return api[service];return {
   overview:()=>read('overview',{...window.__scoutSettings,latestRun:window.__scoutLatest,lastRunAt:window.__scoutLatest?.finishedAt,nextRunAt:window.__scoutSettings.enabled&&window.__scoutSettings.networkEnabled&&window.__scoutSettings.weeklyEnabled?now+86400000:null,pendingSuggestions:window.__scoutRows.filter(x=>x.status==='new').length,sourceCount:4,enabledSourceCount:window.__scoutSources.filter(x=>x.enabled).length,analysisMethod:'deterministic-rules'}),
   settings:()=>read('settings',window.__scoutSettings),sources:()=>read('sources',window.__scoutSources),suggestions:()=>read('suggestions',window.__scoutRows),
   setSettings:async patch=>{await mutate('setSettings',patch);Object.assign(window.__scoutSettings,patch);return window.__scoutSettings;},
   setSourceEnabled:async(id,enabled)=>{await mutate('setSourceEnabled',id,enabled);window.__scoutSources.find(x=>x.id===id).enabled=enabled;},
   updateSuggestion:async(id,patch)=>{await mutate('updateSuggestion',id,patch);Object.assign(window.__scoutRows.find(x=>x.id===id),patch);},
   run:async input=>{await mutate('run',input);window.__scoutLatest={...window.__scoutLatest,...input,status:window.__scoutRunStatus??'completed',networkAllowed:!!input.allowNetwork,detail:window.__scoutRunDetail??'Fixture check recorded.',error:null};return window.__scoutLatest;},
   createGoal:async(id,input)=>{await mutate('createGoal',id,input);window.__scoutRows.find(x=>x.id===id).goalId='goal-scout-fixture';window.__scoutRows.find(x=>x.id===id).status='goal-created';if(window.__failGoalRefresh)window.__scoutReadFailure=true;return {goalId:'goal-scout-fixture'};},
  };}});
 });
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
 const navigate=async()=>{await page.locator('.space-dock button').first().focus();await page.keyboard.press('Meta+Shift+i');await page.getByRole('heading',{name:'Scout',exact:true}).waitFor();};
 await navigate();await page.waitForFunction(()=>document.querySelector('.scout-view')?.textContent.includes('Make session handoffs'));
 const capture=async name=>{await page.evaluate(()=>document.activeElement?.blur());for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css'});}};
 const waitText=async(selector,text)=>page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text});
 await capture('proposals');
 if(before){
  await page.getByRole('button',{name:'Inspect evidence',exact:true}).first().click();await page.locator('.scout-evidence').first().scrollIntoViewIfNeeded();await capture('evidence');
  await page.locator('.scout-scroll').evaluate(el=>el.scrollTop=0);await capture('watch');
 }else{
  const area=async name=>page.getByRole('group',{name:'Scout workspace',exact:true}).getByRole('button',{name,exact:true}).click();
  const reader=page.locator('.scout-reader');
  const readerArea=async name=>reader.getByRole('group',{name:'Proposal reader section'}).getByRole('button',{name}).click();
  const choose=async name=>{await page.locator('.scout-entry').filter({has:page.getByText(name,{exact:true})}).click();await waitText('.scout-reader h2',name);};
  const calls=()=>page.evaluate(()=>window.__scoutCalls);
  const refresh=async()=>{await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();};
  const search=page.getByRole('searchbox',{name:'Find proposals'});
  assert.deepEqual(await calls(),[]);assert.equal(await page.locator('.scout-entry').count(),5);
  await readerArea(/^Evidence/);await capture('evidence');assert.equal(await reader.locator('a[target="_blank"]').count(),2);
  await readerArea('Goal');await capture('goal');await area('Sources');await capture('sources');await area('Watch');await capture('watch');
  await area('Proposals');assert.equal(await reader.getByRole('button',{name:'Goal',exact:true}).getAttribute('aria-pressed'),'true');await readerArea('Brief');
  await search.fill('desktop');assert.equal(await page.locator('.scout-entry').count(),1);await waitText('.scout-reader h2','desktop');await capture('search');
  await search.fill('unfindable fixture');await waitText('.scout-directory','No matching proposals');await capture('no-match');await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await page.getByRole('combobox',{name:'Proposal order'}).selectOption('effort');assert.match(await page.locator('.scout-entry').first().innerText(),/desktop runtime/);await page.getByRole('combobox',{name:'Proposal order'}).selectOption('newest');
  await choose('Clarify protocol capability boundaries');await page.locator('.space-dock button').first().click();await navigate();await waitText('.scout-reader h2','Clarify protocol');
  await page.getByRole('group',{name:'Scout workspace'}).getByRole('button',{name:'Proposals',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('group',{name:'Scout workspace'}).getByRole('button',{name:'Sources',exact:true}).getAttribute('aria-pressed'),'true');await area('Proposals');
  record('Search, status/order controls, keyboard workspace navigation and selected reader survive page navigation. Evidence and Goal remain deliberate reader sections.');

  await page.getByRole('combobox',{name:'Proposal status'}).selectOption('new');await choose('Make session handoffs easier to review');await reader.getByRole('button',{name:'Mark reviewed'}).click();await waitText('.scout-reader h2','Review the desktop');await reader.getByRole('button',{name:'Mark reviewed'}).click();await page.waitForFunction(()=>document.querySelector('select[aria-label="Proposal status"]').value==='all');
  await choose('Clarify protocol capability boundaries');await reader.getByRole('button',{name:'Snooze',exact:true}).click();await reader.getByRole('button',{name:'Reopen',exact:true}).waitFor();await reader.getByRole('button',{name:'Reopen',exact:true}).click();await reader.getByRole('button',{name:'Mark reviewed'}).waitFor();
  await reader.getByRole('button',{name:'Dismiss proposal'}).click();await readerArea('Goal');await waitText('.scout-reader','Reopen this proposal');await reader.getByRole('button',{name:'Reopen',exact:true}).click();await reader.getByRole('button',{name:'Create linked Goal'}).waitFor();
  record('Review, snooze, reopen and dismiss use only proposal updates; the final status facet resets when it disappears.');

  await page.getByRole('button',{name:'Preview locally',exact:true}).click();await waitText('.scout-feedback','Local preview completed');assert.deepEqual((await calls()).at(-1),['run',{mode:'preview'}]);
  await page.getByRole('button',{name:'Run scout now',exact:true}).click();await waitText('.scout-feedback','Online check completed');assert.deepEqual((await calls()).at(-1),['run',{mode:'manual',allowNetwork:true}]);assert.equal(await page.evaluate(()=>window.__scoutSettings.networkEnabled),false);
  for(const outcome of ['blocked','failed','running','mystery']){
   await page.evaluate(status=>{window.__scoutRunStatus=status;window.__scoutRunDetail='Fixture recorded outcome: '+status;},outcome);await page.getByRole('button',{name:'Run scout now',exact:true}).click();await waitText('.scout-feedback',outcome==='running'?'still running':'Fixture recorded outcome: '+outcome);assert.doesNotMatch(await page.locator('.scout-feedback').innerText(),/completed/);
  }
  await capture('scan-outcome');await page.evaluate(()=>{window.__scoutRunStatus='completed';window.__scoutRunDetail='Fixture check recorded.';});
  record('Preview stays local; manual explicitly allows one online check without saved unattended consent. Blocked, failed, running and unknown outcomes never announce completion.');

  await area('Sources');await page.locator('.scout-source').first().getByRole('checkbox').uncheck();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();assert.deepEqual((await calls()).at(-1),['setSourceEnabled','anthropic',false]);
  assert.equal(await page.locator('.scout-source label a').count(),0);
  await page.evaluate(()=>window.__scoutSources[0].url='javascript:alert(1)');await refresh();assert.equal(await page.getByRole('link',{name:'Visit Anthropic documentation'}).count(),0);
  await area('Watch');assert(await page.getByRole('checkbox',{name:/Weekly watch/}).isDisabled());await page.getByRole('checkbox',{name:/Allow unattended/}).check();await page.getByRole('checkbox',{name:/Weekly watch/}).check();await page.getByRole('combobox',{name:'Weekly watch day'}).selectOption('2');await page.getByRole('combobox',{name:'Weekly watch time'}).selectOption('14');await waitText('.scout-feedback','Watch time updated');
  assert.deepEqual(await page.evaluate(()=>window.__scoutSettings),{enabled:true,networkEnabled:true,weeklyEnabled:true,weekday:2,hour:14,providerId:null});
  await page.getByRole('checkbox',{name:/Enable Scout workspace/}).uncheck();assert(await page.getByRole('button',{name:'Run scout now',exact:true}).isDisabled());await page.getByRole('checkbox',{name:/Enable Scout workspace/}).check();await waitText('.scout-feedback','Saved watch permissions');
  record('Source links cannot toggle consent; unsafe URL schemes are removed. Workspace, unattended permission, weekly watch and local schedule save independently.');

  await area('Proposals');await choose('Make session handoffs easier to review');await readerArea('Goal');await page.evaluate(()=>window.__holdAction=true);let count=(await calls()).length;await reader.getByRole('button',{name:'Create linked Goal'}).click();await page.waitForFunction(()=>!!window.__releaseAction);assert(await reader.getByRole('button',{name:'Creating Goal…'}).isDisabled());assert.equal((await calls()).length,count+1);
  await page.evaluate(()=>{window.__holdAction=false;window.__failGoalRefresh=true;window.__releaseAction();});await waitText('.scout-feedback','last successful read is still shown');await reader.getByRole('button',{name:'Open linked Goal →',exact:true}).waitFor();assert.equal(await reader.getByRole('button',{name:'Create linked Goal'}).count(),0);await capture('goal-refresh-unavailable');
  assert.deepEqual((await calls()).at(-1),['createGoal','proposal-1',{projectId:'p1'}]);await page.evaluate(()=>window.__scoutReadFailure=false);await page.getByRole('button',{name:'Read again',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
  await reader.getByRole('button',{name:'Open linked Goal →',exact:true}).click();await page.waitForFunction(()=>location.hash==='#goal=goal-scout-fixture');await page.locator('.control-view').waitFor();await navigate();
  await choose('Tighten release-note provenance');await readerArea('Goal');assert(await reader.getByRole('button',{name:'Create linked Goal'}).isDisabled());
  record('Goal creation is serialized, calls only the cited Scout endpoint and retains its receipt after a refresh fails. The handoff opens Review; uncited proposals cannot create Goals.');

  await page.evaluate(()=>window.__scoutReadFailure=true);await refresh();await waitText('.scout-feedback','last successful read is still shown');assert.equal(await page.locator('.scout-entry').count(),5);assert(await page.getByRole('button',{name:'Run scout now',exact:true}).isDisabled());await capture('read-unavailable');
  await page.locator('.space-dock button').first().click();await navigate();await waitText('.scout-view','Scout records could not be read');assert.equal(await page.locator('.scout-entry').count(),0);assert.doesNotMatch(await page.locator('.scout-view').innerText(),/Nothing proposed yet|No sources were returned/);await capture('first-read-unavailable');
  await page.evaluate(()=>window.__scoutReadFailure=false);await page.getByRole('button',{name:'Read again',exact:true}).click();await page.locator('.scout-entry').first().waitFor();
  await page.evaluate(()=>window.__holdRead=true);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>!!window.__releaseRead);await page.locator('.space-dock button').first().click();await page.evaluate(()=>{window.__holdRead=false;window.__releaseRead();window.__scoutRows[0].title='A freshly observed proposal';});await navigate();await choose('A freshly observed proposal');
  await page.evaluate(()=>window.__scoutActionFailure=true);await reader.getByRole('button',{name:'Mark reviewed'}).count().then(async n=>{if(n)await reader.getByRole('button',{name:'Mark reviewed'}).click();else{await page.getByRole('button',{name:'Preview locally'}).click();}});await waitText('.scout-feedback','Fixture action refused');await page.evaluate(()=>window.__scoutActionFailure=false);
  record('Failed refreshes retain the last observation and disable mutations; first-read failures never invent empty records. Late unmounted reads are discarded and action failures remain visible.');

  await page.evaluate(()=>{window.__savedScoutRows=structuredClone(window.__scoutRows);window.__scoutRows=[];});await refresh();await waitText('.scout-directory','Room for the next idea');await capture('empty');
  await page.evaluate(()=>{window.__scoutRows=window.__savedScoutRows;document.documentElement.dataset.motion='off';});await refresh();await choose('A freshly observed proposal');await readerArea('Brief');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,900));
  for(const name of ['Proposals','Sources','Watch']){await area(name);await capture(name.toLowerCase()+'-narrow');const sizes=await page.evaluate(()=>[document.documentElement,...document.querySelectorAll('.scout-workspace,.scout-scroll,.scout-reader,.scout-watch-settings')].map(el=>({class:el.className,width:el.clientWidth,scroll:el.scrollWidth})));dimensions.push({area:name,sizes});assert(sizes.every(size=>size.scroll<=size.width+1),JSON.stringify(sizes));}
  await area('Proposals');assert.equal(await page.locator('.scout-reading').evaluate(el=>getComputedStyle(el).animationDuration),'0s');await page.evaluate(()=>document.documentElement.dataset.motion='full');assert.equal(await page.locator('.scout-reading').evaluate(el=>getComputedStyle(el).animationDuration),'0.24s');await page.evaluate(()=>document.documentElement.dataset.motion='auto');assert.equal(await page.locator('.scout-reading').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  record('Observed emptiness has its own state. Off disables reader motion and Auto follows reduced motion. Populated views in both themes fit a 1024px desktop; workspace and content regions have no horizontal overflow.');
 }
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({synthetic:true,checks,errors,dimensions},null,2)+'\n');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
