#!/usr/bin/env node
// Real renderer in isolated Electron. Every record and action below is synthetic.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/learning-workspace',before?'before':'after');
mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-learning-'));
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
 page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const original=window.wanigan,now=Date.now();window.__learningCalls=[];window.__learningReads=[];
  window.__learningSettings={enabled:true,contentMode:'local-same-provider',automation:'hybrid',allowModelAssistance:false,monthlyBudgetUsd:0,briefingMaxTokens:1200,consolidationEnabled:true};
  const item=(id,title,kind,scope='project',projectId='p1',status='active')=>({id,title,kind,scope,projectId,pathScope:scope==='path'?'src/payments/**':null,canonicalText:'Keep the order identity stable across retries. A successful payment callback must reuse the original order, even when the customer never received the response.',status,confidence:0.86,sourceCount:3,currentVersion:2,contentHash:'fixture-hash',createdAt:now-604800000,updatedAt:now-3600000,lastValidatedAt:now-7200000,expiresAt:null,supersededBy:null});
  window.__items=[item('k1','A retry must never charge twice','instruction'),item('k2','Prefer focused verification','memory','personal',null),item('k3','Payment boundaries','rule','path'),item('k4','The old checkout contract','instruction','project','p1','quarantined'),item('k5','Search ranking rules','rule','path','p2'),item('k6','Legacy response shape','memory','project','p1','retired')];
  window.__items[1].canonicalText='Run the tests that exercise the behavior you changed, then the repository’s required checks. Record the results with the handoff.';
  window.__items[2].canonicalText='Validate callback signatures before recording a payment event. Keep provider errors outside the public order response.';
  window.__items[4].canonicalText='An exact product match should rank ahead of partial matches after every catalog refresh.';
  const candidate=(id,title,status='pending',projectId='p1')=>({id,itemId:null,targetKind:'instruction',scope:'project',providerId:'claude',projectId,pathScope:null,title,proposedText:'Preserve the original order identifier when retrying a timed-out payment callback. Check for a completed payment before creating another charge.',rationale:'Two independent tasks found the same retry boundary. This proposal keeps the correction available to future checkout work.',confidence:0.82,status,evidenceCount:4,taskCount:2,estimatedTokenDelta:48,conflicts:[],signalIds:['sig1','sig2'],createdAt:now-10800000,updatedAt:now-1800000,reviewedAt:null,reviewerNote:null,clusterKey:null,snoozedAt:null,wake:null});
  window.__candidates=[candidate('c1','Remember the checkout retry boundary'),candidate('c2','Review receipt accessibility','snoozed'),candidate('c3','Keep search ranking stable','pending','p2'),candidate('c4','Prefer focused verification','promoted')];
  window.__candidates[3].reviewedAt=now-3600000;window.__candidates[1].snoozedAt=now-7200000;
  window.__signals=[1,2,3].map(i=>({id:'sig'+i,kind:i===1?'gate-failed':'gate-passed',providerId:'claude',backendId:'anthropic',sessionId:'s1',taskHash:'task'+i,projectId:'p1',projectPath:'/example/storefront',pathScope:'src/payments/**',summary:i===1?'The retry test created a second charge after a timeout.':'Checkout regression tests passed after preserving the original order identity.',detail:{},contentHash:'fixture'+i,semanticEligible:false,createdAt:now-i*3600000,processedAt:now}));
  const matches=(row,scope)=>scope===undefined||scope===null?scope===undefined||row.projectId===null:row.projectId===scope||row.projectId===null;
  window.__scopeMatches=matches;
  window.wanigan=new Proxy(original,{get(api,service){if(service!=='learning')return api[service];return new Proxy(api.learning,{get(learning,method){
   const reads=new Set(['overview','settings','signals','candidates','knowledge','diagnostics','experiments','pipeline','item','relations','freshness','search','candidateExplain','candidateSignals','unactionableCount','briefing']);
   if(!reads.has(method)){
    if(method==='modelAssistStatus'||method==='backups')return learning[method];
    return async(...args)=>{window.__learningCalls.push([method,...args]);if(window.__actionFailure)throw new Error('Fixture learning action refused');if(window.__holdAction)await new Promise(resolve=>window.__releaseAction=resolve);
     if(method==='reviewCandidate'){const c=window.__candidates.find(c=>c.id===args[0]);c.status=({approve:'approved',reject:'rejected',snooze:'snoozed',reopen:'pending'})[args[1]];c.reviewedAt=Date.now();return c;}
     if(method==='promoteCandidate'){window.__candidates.find(c=>c.id===args[0]).status='promoted';return {};}
     if(method==='updateCandidate'){Object.assign(window.__candidates.find(c=>c.id===args[0]),args[1]);return {};}
     if(method==='applyCandidate'){window.__candidates.find(c=>c.id===args[0]).status='applied';return {};}
     if(method==='retireItem'){window.__items.find(i=>i.id===args[0]).status='retired';return {};}
     if(method==='setSettings'){Object.assign(window.__learningSettings,args[0]);return window.__learningSettings;}
     if(method==='teach'){window.__candidates.unshift({...candidate('taught',args[0].title),proposedText:args[0].text,scope:args[0].scope,projectId:args[0].projectId});return {};}
     if(method==='consolidate')return {ran:true,signals:3,candidates:1,promoted:0,skipped:2};
     if(method==='undoProjection')return {};
     throw new Error('Unexpected fixture mutation '+method);
    };
   }
   return async(...args)=>{
    window.__learningReads.push([method,...args]);let scope=['overview','diagnostics'].includes(method)?args[0]:args[0]?.projectId;
    if(window.__scopeFailure!==undefined&&window.__scopeFailure===scope&&method==='overview')throw new Error('Fixture scope unavailable');
    const items=window.__items.filter(i=>matches(i,scope)),candidates=window.__candidates.filter(i=>matches(i,scope));
    let value;
    if(method==='settings')value=window.__learningSettings;
    if(method==='overview')value={pending:candidates.filter(c=>c.status==='pending').length,activeKnowledge:items.filter(i=>i.status==='active').length,quarantined:items.filter(i=>i.status==='quarantined').length,activeSkills:0,experiments:0,signals:240,projectedTokenDelta:0};
    if(method==='signals')value=window.__signals.filter(i=>matches(i,scope));
    if(method==='candidates')value=candidates;
    if(method==='knowledge')value=items;
    if(method==='diagnostics')value=[{kind:'drift',severity:'warning',itemIds:['k4'],title:'The checkout source has changed',detail:'Recheck the cited contract before relying on the older instruction.',estimatedTokenDelta:0}];
    if(method==='experiments')value=window.__experiments??[];
    if(method==='pipeline')value={windowDays:args[0].windowDays,signals:240,signalsAllTime:400,eligibleSignals:22,candidatesCreated:8,awaitingDecision:3,autoPromoted:0,reviewed:5,itemsPromoted:4,projectionsApplied:2,briefingsServed:18,consolidationRuns:[],consolidationRunsTotal:0,signalsByDay:Array.from({length:30},(_,i)=>({day:new Date(now-(29-i)*86400000).toISOString().slice(0,10),total:2+(i*7)%15,failures:i%4===0?2:0,teachings:i%7===0?1:0}))};
    if(method==='item'){const item=window.__items.find(i=>i.id===args[0]);value={item,versions:[{id:'v2',itemId:item.id,version:2,canonicalText:item.canonicalText,metadata:{},contentHash:'hash2',createdBy:'operator',previousVersionId:'v1',createdAt:now-3600000},{id:'v1',itemId:item.id,version:1,canonicalText:'An earlier recorded version.',metadata:{},contentHash:'hash1',createdBy:'operator',previousVersionId:null,createdAt:now-604800000}],evidence:[{id:'ev-'+item.id,itemId:item.id,versionId:'v2',candidateId:null,signalId:'sig2',sourceType:'file',sourceId:'/example/storefront/src/payments/retry.ts',citation:'src/payments/retry.ts · verified retry branch',contentHash:'fixture',weight:1,observedAt:now-7200000}],projections:[],roi:{samples:0,metricCounts:{tokensLoaded:0,uses:0,tokensSaved:0},tokensLoaded:0,successfulUses:0,failedUses:0,tokensSaved:0,evidenceLevel:'estimate'}};if(window.__itemFailure===args[0])throw new Error('Fixture item unavailable');if(window.__holdItem===args[0])return new Promise(resolve=>window.__releaseItem=()=>resolve(value));}
    if(method==='relations')value=[];
    if(method==='freshness')value={itemId:args[0],fresh:true,checkedAt:now,checked:1,skipped:0,issues:[]};
    if(method==='search'){if(window.__searchFailure)throw new Error('Fixture search unavailable');value=window.__items.filter(i=>matches(i,args[1]?.projectId)&&i.status==='active'&&i.title.toLowerCase().includes(args[0].toLowerCase())).map(item=>({item}));if(window.__holdSearch)return new Promise(resolve=>window.__releaseSearch=()=>resolve(value));}
    if(method==='candidateExplain')value={candidateId:args[0],decision:'review',reason:'Project instructions require a human decision.',claimPossible:true,checks:[{label:'Independent tasks',ok:true,actual:'2',required:'2'},{label:'Scope permits automatic promotion',ok:false,actual:'project',required:'personal memory'}]};
    if(method==='candidateSignals')value=window.__signals;
    if(method==='unactionableCount')value=0;
    if(method==='briefing'){const query=args[0].query,profile=args[0].providerId;value={text:query?'Keep the order identity stable across retries.':'',entries:query?[{itemId:'k1',versionId:'v2',kind:'instruction',title:'A retry must never charge twice',text:'Keep the order identity stable across retries.',citations:['src/payments/retry.ts'],estimatedTokens:42,checked:1,skipped:0}]:[],estimatedTokens:query?42:0,omitted:query?1:0,omittedStale:query?1:0,omittedBudget:0,omittedUnsynthesized:0,omittedUnverified:0,queryProvided:!!query,learningEnabled:window.__learningSettings.enabled,harnessId:profile==='codex'?'codex':'claude-code',launchDelivery:profile==='codex'?'developer-instructions':'append-system-prompt',harnessProof:'builtin'};if(window.__holdBriefing===profile)return new Promise(resolve=>window.__releaseBriefing=()=>resolve(value));}
    if(window.__holdScope!==undefined&&window.__holdScope===scope&&method==='overview')return new Promise(resolve=>window.__releaseScope=()=>resolve(value));
    return structuredClone(value);
   };
  }});}});
 });
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
 await page.locator('.space-dock button').first().focus();await page.keyboard.press('Meta+6');
 await page.getByRole('heading',{name:'Learning',exact:true}).first().waitFor();
 await page.getByRole('combobox',{name:before?'Scope':'Learning scope',exact:true}).selectOption('p:p1');
 await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas')?.dataset.frames)>0);
 const capture=async name=>{await page.evaluate(()=>document.activeElement?.blur());for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css'});}};
 const tab=async name=>{await page.getByRole('tab',{name:new RegExp('^'+name)}).click();};
 for(const name of ['Overview','Inbox','Knowledge','Context']){await tab(name);await capture(name.toLowerCase());}
 await tab('Knowledge');await page.locator('.knowledge-row').first().click();await page.locator('.learning-detail h2').waitFor();await capture('item');
 await page.getByRole('button',{name:'Teach Wanigan',exact:true}).click();await page.getByRole('dialog').waitFor();await capture('teach');await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
 if(!before){
  const scope=page.getByRole('combobox',{name:'Learning scope',exact:true});
  const reader=page.locator('.learning-detail');
  const item=async id=>{await page.locator(`[data-item-id="${id}"]`).click();await reader.locator('h2').waitFor();};
  const readerSection=async name=>{await reader.getByRole('button',{name,exact:true}).click();};
  const waitText=async (selector,text)=>page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text});
  const calls=()=>page.evaluate(()=>window.__learningCalls);
  assert.equal((await calls()).length,0,'browsing and previews must be read-only');
  await item('k1');await readerSection('Evidence');await waitText('.learning-reading','src/payments/retry.ts');await capture('evidence');
  await reader.getByRole('button',{name:'Re-check citations now'}).click();await waitText('.learning-reading','verified just now');
  await readerSection('History');await waitText('.learning-reading','first version');await capture('history');
  await tab('Inbox');await tab('Knowledge');await waitText('.learning-detail','A retry must never charge twice');await waitText('.learning-reading','first version');
  await readerSection('Text');
  await page.getByRole('tab',{name:/^Knowledge/}).focus();await page.keyboard.press('ArrowUp');assert.equal(await page.getByRole('tab',{name:/^Inbox/}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('ArrowDown');await waitText('.learning-detail','A retry must never charge twice');
  record('Knowledge selection, evidence, version history, citation checks and keyboard navigation retain their context.');

  await page.evaluate(()=>{window.__holdItem='k1';});await item('k2');
  await page.locator('[data-item-id="k1"]').click();await page.waitForFunction(()=>!!window.__releaseItem);
  await item('k3');await page.evaluate(()=>{window.__releaseItem();window.__holdItem=null;});await waitText('.learning-detail','Payment boundaries');
  assert.match(await reader.innerText(),/Validate callback signatures/);assert.doesNotMatch(await reader.innerText(),/A retry must never charge twice/);
  await page.evaluate(()=>window.__itemFailure='k4');await page.locator('[data-item-id="k4"]').click();await waitText('.learning-detail','Fixture item unavailable');await capture('item-unavailable');
  await page.evaluate(()=>window.__itemFailure=null);await reader.getByRole('button',{name:'Retry',exact:true}).click();await waitText('.learning-detail','The old checkout contract');
  record('Late item responses are discarded; a failed item read exposes a working Retry.');

  const search=page.getByRole('searchbox',{name:'Search canonical knowledge'});
  await search.fill('retry');await page.locator('.learning-search').getByRole('button',{name:'Search',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===1);
  await tab('Overview');await tab('Knowledge');await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===1);assert.equal(await search.inputValue(),'retry');
  await page.evaluate(()=>window.__searchFailure=true);await search.fill('boundary');await page.locator('.learning-search').getByRole('button',{name:'Search',exact:true}).click();await waitText('.learning-list-pane','Fixture search unavailable');
  await page.evaluate(()=>{window.__searchFailure=false;window.__holdSearch=true;});await search.fill('retry');await page.locator('.learning-search').getByRole('button',{name:'Search',exact:true}).click();await page.waitForFunction(()=>!!window.__releaseSearch);
  await page.getByRole('button',{name:'Clear search',exact:true}).click();await page.evaluate(()=>{window.__releaseSearch();window.__holdSearch=false;});await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===5);
  await page.getByRole('combobox',{name:'Status',exact:true}).selectOption('quarantined');await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===1);assert.match(await page.locator('.knowledge-row').innerText(),/old checkout/);
  await page.getByRole('combobox',{name:'Status',exact:true}).selectOption('all');
  record('Scoped search survives navigation, reports failures, ignores a canceled search and combines with status filters.');

  await scope.selectOption('personal');await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===1);assert.match(await page.locator('.knowledge-row').innerText(),/Prefer focused verification/);
  await page.evaluate(()=>window.__holdScope='p2');await scope.selectOption('p:p2');await waitText('.learning-scroll','Reading this learning scope');assert.equal(await page.locator('.knowledge-row').count(),0);
  await scope.selectOption('p:p1');await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===5);await page.evaluate(()=>{window.__releaseScope();window.__holdScope=null;});assert.equal(await page.locator('[data-item-id="k5"]').count(),0);
  await page.evaluate(()=>window.__scopeFailure='p2');await scope.selectOption('p:p2');await waitText('.learning-scroll','Could not read this learning scope');assert.equal(await page.locator('.knowledge-row').count(),0);await capture('scope-unavailable');
  await page.evaluate(()=>window.__scopeFailure=null);await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===2);
  await scope.selectOption('p:p1');await page.waitForFunction(()=>document.querySelectorAll('.knowledge-row').length===5);
  record('Personal and project scope changes clear prior records immediately; delayed and failed scopes never impersonate an empty store.');

  await tab('Inbox');await page.locator('[data-candidate-id="c1"]').click();
  const decision=await page.getByRole('button',{name:'Approve to knowledge',exact:true}).boundingBox();const frame=await page.locator('.learning-scroll').boundingBox();assert(decision.y+decision.height<=frame.y+frame.height,'primary decision is visible with the proposal at desktop size');
  const proposal=page.locator('.learning-proposal-reader');await proposal.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('textbox',{name:'Candidate text',exact:true}).fill('Preserve the original order identifier. Verify the retry before recording another charge.');
  await page.locator('[data-candidate-id="c2"]').click();await page.locator('[data-candidate-id="c1"]').click();assert.match(await page.getByRole('textbox',{name:'Candidate text',exact:true}).inputValue(),/Verify the retry/);
  await page.evaluate(()=>window.__actionFailure=true);await proposal.getByRole('button',{name:'Save edit',exact:true}).click();await waitText('.learning-view','Fixture learning action refused');assert.match(await page.getByRole('textbox',{name:'Candidate text',exact:true}).inputValue(),/Verify the retry/);
  await page.evaluate(()=>window.__actionFailure=false);await proposal.getByRole('button',{name:'Save edit',exact:true}).click();await page.getByRole('textbox',{name:'Candidate text',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('searchbox',{name:'Search proposals'}).fill('zzzz');await waitText('.learning-inbox','No proposal matches your search');assert.doesNotMatch(await page.locator('.learning-inbox').innerText(),/The Inbox is clear/);await page.getByRole('button',{name:'Clear search',exact:true}).click();
  await proposal.getByRole('button',{name:/why this needs review/i}).click();await waitText('.why-panel','Project instructions require a human decision.');await proposal.getByRole('button',{name:/Evidence \(/}).click();await waitText('.evidence-drawer','Checkout regression tests passed');await capture('proposal-evidence');
  await proposal.getByRole('button',{name:/why this needs review/i}).click();await proposal.getByRole('button',{name:/Evidence \(/}).click();
  let beforeCalls=(await calls()).length;await page.evaluate(()=>window.__holdAction=true);await proposal.getByRole('button',{name:'Approve to knowledge',exact:true}).click();await page.waitForFunction(()=>!!window.__releaseAction);
  assert.equal((await calls()).length,beforeCalls+1);assert(await proposal.getByRole('button',{name:'Working…',exact:true}).isDisabled());
  await page.evaluate(()=>{window.__holdAction=false;window.__releaseAction();});await page.waitForFunction(()=>window.__candidates.find(c=>c.id==='c1').status==='promoted');await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
  assert.deepEqual((await calls()).slice(beforeCalls).map(c=>c[0]),['reviewCandidate','promoteCandidate']);
  await page.getByRole('combobox',{name:'Status',exact:true}).selectOption('all');await page.locator('[data-candidate-id="c1"]').click();await proposal.getByRole('button',{name:'Apply to Claude Code',exact:true}).click();await page.waitForFunction(()=>window.__candidates.find(c=>c.id==='c1').status==='applied');
  assert.equal((await calls()).at(-1)[0],'applyCandidate');
  record('Proposal drafts survive selection and failed saves; approval is serialized and writing a provider file still requires its separate Apply action.');

  await page.getByRole('button',{name:'Teach Wanigan',exact:true}).click();let dialog=page.getByRole('dialog');const title=dialog.getByRole('textbox',{name:'Title',exact:true});await title.pressSequentially('Remember the retry fixture');assert.equal(await title.inputValue(),'Remember the retry fixture');assert(await title.evaluate(el=>el===document.activeElement));
  await dialog.getByRole('textbox',{name:'Knowledge',exact:true}).fill('A fixture teaching preserves the original order identity.');beforeCalls=(await calls()).length;await dialog.getByRole('button',{name:'Close',exact:true}).click();assert.equal((await calls()).length,beforeCalls);
  await page.getByRole('button',{name:'Teach Wanigan',exact:true}).click();dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('textbox',{name:'Title',exact:true}).inputValue(),'Remember the retry fixture');await dialog.getByRole('button',{name:'Add to Inbox',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal((await calls()).at(-1)[0],'teach');
  record('Teaching retains input focus and its draft; closing is read-only and submitting creates one explicit proposal.');

  await tab('Knowledge');await item('k1');await readerSection('Text');await reader.getByRole('button',{name:'Retire this item…'}).click();dialog=page.getByRole('dialog');beforeCalls=(await calls()).length;assert(await dialog.getByRole('button',{name:/Retire 1 item/}).isDisabled());await dialog.getByRole('button',{name:'Close',exact:true}).click();assert.equal((await calls()).length,beforeCalls);
  await reader.getByRole('button',{name:'Retire this item…'}).click();dialog=page.getByRole('dialog');await dialog.getByRole('textbox').fill('Superseded by the fixture retry contract.');await capture('retire');await dialog.getByRole('button',{name:/Retire 1 item/}).click();await dialog.waitFor({state:'hidden'});await waitText('.learning-detail','Already retired');assert.equal((await calls()).at(-1)[0],'retireItem');
  record('Retirement names the selected item, requires a reason and retains its record after the explicit status change.');

  beforeCalls=(await calls()).length;
  // Both preview tools must discard a response from a previously selected backend.
  await page.getByRole('button',{name:/Show: Preview a session briefing/}).click();const payload=page.locator('.knowledge-tab').getByRole('button',{name:'Show the payload'});await payload.waitFor();
  await page.getByRole('textbox',{name:'Task a session would start with'}).fill('retry the callback');await page.evaluate(()=>window.__holdBriefing='claude');await payload.click();await page.waitForFunction(()=>!!window.__releaseBriefing);
  await page.getByRole('combobox',{name:'Provider profile',exact:true}).selectOption('codex');await page.waitForFunction(()=>document.querySelector('.payload-delivery')?.textContent.includes('developer_instructions'));
  await page.evaluate(()=>{window.__releaseBriefing();window.__holdBriefing=null;});assert.equal(await page.locator('.payload-text').count(),0);await payload.click();await waitText('.payload-text','Keep the order identity stable');await capture('payload');await page.locator('#explainer-learning-payload').getByRole('button',{name:'Hide',exact:true}).click();
  await tab('Context');const context=page.locator('.learning-scroll');const prompt=context.getByRole('textbox').first();await prompt.fill('retry the callback');await context.getByRole('button',{name:'Preview retrieval'}).click();await waitText('.learning-scroll','~42');await capture('briefing');
  assert.equal((await calls()).length,beforeCalls,'preview tools must not write or launch');
  record('Briefing previews show exact payloads and estimated token costs; delayed responses cannot cross provider selections.');

  await page.evaluate(()=>{window.__scopeFailure='p1';});await page.getByRole('button',{name:'Refresh',exact:true}).click();await waitText('.learning-scroll','Could not read this learning scope');
  assert(await page.getByRole('checkbox',{name:'Record signals, consolidate, and inject briefings'}).isDisabled());await capture('refresh-unavailable');
  await page.evaluate(()=>window.__scopeFailure=null);await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.learning-scroll').textContent.includes('Could not read this learning scope'));
  await tab('Overview');await page.getByRole('button',{name:'7 days',exact:true}).click();await page.waitForFunction(()=>window.__learningReads.some(r=>r[0]==='pipeline'&&r[1].windowDays===7));
  await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.learning-toolbar select')?.value==='open');
  await page.getByRole('combobox',{name:'Status',exact:true}).selectOption('all');await tab('Knowledge');await tab('Inbox');assert.equal(await page.getByRole('combobox',{name:'Status',exact:true}).inputValue(),'all');
  await scope.selectOption('p:p2');await scope.selectOption('p:p1');await tab('Overview');await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.learning-toolbar select')?.value==='open');
  record('A failed refresh disables controls until Retry; window changes and one-shot Inbox links retain the intended filter across remounts.');

  // Motion respects both the application preference and the operating system.
  await tab('Knowledge');await item('k2');await readerSection('Text');
  for(const [setting,expected] of [['off',0],['auto',0],['full',1]]){await page.evaluate(v=>document.documentElement.dataset.motion=v,setting);await readerSection('History');await readerSection('Text');const duration=await page.locator('.learning-reading').evaluate(el=>parseFloat(getComputedStyle(el).animationDuration));assert.equal(duration>0?1:0,expected);}
  await page.evaluate(()=>document.documentElement.dataset.motion='off');
  const window=await app.browserWindow(page);await window.evaluate(win=>win.setSize(1024,900));await capture('library-narrow');
  const sizes=await page.evaluate(()=>({width:innerWidth,page:document.documentElement.scrollWidth,panel:document.querySelector('.learning-scroll').clientWidth,panelScroll:document.querySelector('.learning-scroll').scrollWidth}));dimensions.push(sizes);assert(sizes.page<=sizes.width);assert(sizes.panelScroll<=sizes.panel+1);
  await tab('Inbox');await capture('inbox-narrow');await window.evaluate(win=>win.setSize(1440,1000));
  record('Motion follows Off, Auto and Full preferences; the narrow desktop stays within its viewport.');
  await page.evaluate(()=>{window.__items=[];window.__candidates=[];window.__signals=[];});await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.learning-inbox')?.textContent.includes('No proposals have ever been created'));await capture('inbox-empty');
  await tab('Knowledge');await page.waitForFunction(()=>document.querySelector('.learning-list-pane')?.textContent.includes('No canonical knowledge yet'));await capture('library-empty');
  record('Observed empty libraries and Inbox lists have distinct, actionable empty states.');

 }
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,dimensions},null,2)+'\n');console.log('Learning captures complete.');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
