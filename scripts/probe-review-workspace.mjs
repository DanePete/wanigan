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
const out=path.join(root,'docs/visuals/review-workspace',before?'before':'after');
mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-review-'));
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
  const original=window.wanigan,now=Date.now();
  const goal=(id,title,status,projectId='p1')=>({id,title,status,projectId,projectName:projectId==='p1'?'storefront':'platform',objective:'Make checkout retries safe, even when a payment succeeds but the response never reaches the customer.',acceptance:['Repeated callbacks never create a second charge.','A timeout can be retried without losing the order.','The checkout suite passes and the diff is reviewed.'],risk:'elevated',budgetUsd:20,baseCommit:'a18f50cc937',createdAt:now-86400000,updatedAt:now-180000,autopilot:{enabled:false,providerId:null,model:null,budgetUsd:20,spendUsd:4.28,spendStatus:'partial',haltedReason:null,haltedAt:null},claims:[],checkpoints:[],proofs:[],nodes:[]});
  const node=(id,g,kind,title,status,deps=[])=>({id,docketId:g,kind,title,status,instructions:kind==='review'?'Read the verification evidence against the acceptance checks. Record your decision and anything the next pass needs to address.':'Keep successful checkout unchanged. Cover the timeout path and record the result before handing off.',dependsOn:deps,claimPath:null,providerId:'claude',model:null,sessionId:kind==='implement'?'s1':null,worktree:null,startedAt:now-3600000,endedAt:status==='completed'?now-360000:null,detail:null,deferUntil:null,queued:false});
  const g1=goal('g1','A checkout you can trust','review');
  g1.nodes=[node('n1','g1','plan','Map the retry boundary','completed'),node('n2','g1','implement','Protect every payment','completed',['n1']),node('n3','g1','verify','Prove retries are safe','completed',['n2']),node('n4','g1','review','The final review','ready',['n3'])];
  g1.proofs=[{id:'proof1',docketId:'g1',nodeId:'n3',kind:'test',status:'passed',summary:'Checkout suite · 48 tests passed. Timeout and duplicate callback cases are covered.',createdAt:now-240000},{id:'proof2',docketId:'g1',nodeId:'n2',kind:'diff',status:'recorded',summary:'Payment handler and focused regression tests. No checkout styling changes.',createdAt:now-600000}];
  g1.checkpoints=[{id:'cp1',docketId:'g1',nodeId:'n2',sessionId:'s1',conversationId:'fixture-conversation-42',repoCommit:'a18f50cc937',worktree:'/example/worktrees/retry',note:'Implementation complete. The timeout now returns the original order.',createdAt:now-600000}];
  const g2=goal('g2','Search that finds the right thing','blocked','p2');g2.objective='Keep ranking consistent when the catalog changes.';g2.nodes=[node('b1','g2','implement','Update search ranking','failed'),node('b2','g2','verify','Check result ordering','blocked',['b1']),node('b3','g2','review','Review search relevance','blocked',['b2'])];g2.nodes[0].detail='Catalog reorder still moves an exact match below a partial match.';g2.autopilot={...g2.autopilot,haltedReason:'The verification task failed.',haltedAt:now-300000};
  const g3=goal('g3','A calmer account area','executing');g3.nodes=[node('c1','g3','implement','Refine account preferences','running'),node('c2','g3','review','Review the preferences','blocked',['c1'])];g3.claims=[{id:'claim1',docketId:'g3',nodeId:'c1',path:'src/account/preferences.tsx',createdAt:now-600000,releasedAt:null}];
  const g4=goal('g4','An accessible receipt','draft');g4.nodes=[node('d1','g4','verify','Check receipt accessibility','ready'),node('d2','g4','review','Review accessibility','blocked',['d1'])];g4.nodes[0].queued=true;g4.autopilot={...g4.autopilot,enabled:true,providerId:'claude'};
  const g5=goal('g5','A faster catalog','accepted','p2');g5.nodes=[node('e1','g5','review','Review the catalog','completed')];g5.autopilot={...g5.autopilot,spendStatus:'reported'};
  window.__reviewGoals=[g1,g2,g3,g4,g5];window.__reviewCalls=[];window.__reviewReads=[];
  window.__reviewEvents=[{id:'ev1',projectId:'p1',source:'manual',kind:'CI failure',summary:'Checkout workflow timed out during the retry test.',status:'new',createdAt:now-480000,updatedAt:now-480000,docketId:null}];
  const get=id=>window.__reviewGoals.find(g=>g.id===id),find=id=>window.__reviewGoals.flatMap(g=>g.nodes).find(n=>n.id===id);
  window.wanigan=new Proxy(original,{get(api,service){if(service!=='control')return api[service];return new Proxy(api.control,{get(control,method){
   if(method==='sessionGoal')return async()=>null;
   if(method==='list')return async()=>{window.__reviewReads.push(['list']);if(window.__listFailure)throw new Error('Fixture goal list unavailable');return window.__reviewGoals;};
   if(method==='get')return async id=>{window.__reviewReads.push(['get',id]);const value=structuredClone(get(id));if(window.__goalFailure===id)throw new Error('Fixture goal unavailable');if(window.__holdGoal===id)return new Promise(resolve=>window.__releaseGoal=()=>resolve(value));return value;};
   if(method==='mcpTasks')return async id=>id==='g3'?[{id:'mcp1',docketId:'g3',nodeId:'c1',title:'Refine account preferences',status:'working',createdAt:now,updatedAt:now}]:[];
   if(method==='resumeReceipts')return async id=>id==='g1'?[{nodeId:'n2',docketId:'g1',sessionId:'s1',conversationId:'fixture-conversation-42',providerId:'claude',model:null,baseCommit:'a18f50cc937',worktree:'/example/worktrees/retry',createdAt:now,updatedAt:now,state:'exact',detail:'The recorded conversation and worktree are available.'}]:[];
   if(method==='traces')return async id=>id==='g1'?[{id:'trace1',docketId:'g1',nodeId:'n3',sessionId:'s1',source:'hook',kind:'tool',status:'recorded',toolName:'Bash',summary:'Review command completed.',durationMs:1382,costUsd:0,inTokens:0,outTokens:0,createdAt:now-200000}]:[];
   if(method==='events')return async()=>window.__reviewEvents;
   if(method==='outcomes')return async()=>[{providerId:'claude',model:'fixture-model',taskKind:'implement',samples:5,accepted:4,testsPassed:4,totalCostUsd:12.5,reportedSamples:3,acceptedRate:0.8,testPassRate:0.8}];
   return async(...args)=>{window.__reviewCalls.push([method,...args]);if(window.__actionFailure)throw new Error('Fixture action refused');if(window.__holdAction)await new Promise(resolve=>window.__releaseAction=resolve);
    if(method==='complete'){find(args[0]).status=args[1].decision==='approve'?'completed':'failed';return;}
    if(method==='retry'){find(args[0]).status='ready';return;}
    if(method==='start'){find(args[0]).status='running';return {sessionId:null};}
    if(method==='setBudget'){get(args[0]).budgetUsd=args[1];get(args[0]).autopilot.budgetUsd=args[1];return;}
    if(method==='setAutopilot'){Object.assign(get(args[0]).autopilot,args[1]);return;}
    if(method==='cancelMcpTask'){find('c1').status='canceled';return {outcome:'canceled',sessionStopped:true,nodeStatus:'running',claimsReleased:1};}
    if(method==='dismissEvent'){window.__reviewEvents.find(e=>e.id===args[0]).status='dismissed';return;}
    if(method==='create'){const created=goal('new-goal',args[0].title,'draft',args[0].projectId);window.__reviewGoals.push(created);return created;}
    if(method==='claim'||method==='checkpoint'||method==='releaseClaim'||method==='runProof'||method==='addEvent')return;
    throw new Error('Unexpected fixture mutation: '+method);
   };
  }});}});
 });
 await page.goto(rendererURL+'#goal=g1');await page.getByRole('heading',{name:'Review',exact:true}).waitFor();
 await page.getByRole('heading',{name:'A checkout you can trust',exact:true}).waitFor();
 await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas')?.dataset.frames)>0);
 const capture=async name=>{await page.evaluate(()=>document.activeElement?.blur());for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css'});}};
 await capture('review');
 await page.getByRole('button',{name:'New goal',exact:true}).click();await page.locator(before?'[role=dialog]':'.planning-table').waitFor();await capture('new-goal');await page.getByRole('button',{name:before?'Close new goal':'Back to goals',exact:true}).click();
 if(!before){
  const goal=id=>page.locator(`.control-docket[data-goal-id="${id}"]`);
  const taskTab=id=>page.locator(`.control-steps [data-node-id="${id}"]`);
  const choose=async id=>{await goal(id).click();await page.locator(`#goal-${id}`).waitFor();await page.waitForFunction(()=>document.querySelector('.control-reading')?.getAttribute('aria-busy')==='false');};
  const refresh=async()=>{const n=await page.evaluate(()=>window.__reviewReads.length);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(n=>window.__reviewReads.length>n,n);await page.waitForFunction(()=>document.querySelector('.control-reading')?.getAttribute('aria-busy')==='false');};
  const active=()=>page.getByRole('tabpanel');
  const evidence=()=>page.getByRole('complementary',{name:'Goal evidence',exact:true});
  const area=async name=>{await evidence().getByRole('button',{name,exact:true}).click();};
  const calls=()=>page.evaluate(()=>window.__reviewCalls);
  const go=async key=>{await page.locator('.space-dock button').first().focus();await page.keyboard.press(key);};
  const summary=page.locator('.control-support > summary');
  const openNote=async()=>{const note=active().getByRole('textbox',{name:'Evidence or handoff note'});if(!await note.isVisible())await active().locator('.control-note > summary').click();return note;};
  assert.equal(await taskTab('n4').getAttribute('aria-selected'),'true');
  assert.match(await page.locator('.control-facts').innerText(),/partly reported spend/);
  assert.equal(await page.locator('.control-acceptance li').count(),3);
  assert.equal(await evidence().locator('.control-record').count(),2);
  assert.deepEqual(await calls(),[]);
  await page.locator('.control-reading').evaluate(el=>el.scrollTop=210);await capture('decision');await page.locator('.control-reading').evaluate(el=>el.scrollTop=0);
  const approval=await active().getByRole('button',{name:'Approve',exact:true}).boundingBox(),reading=await page.locator('.control-reading').boundingBox();
  assert(approval.y+approval.height<=reading.y+reading.height,'the default decision must fit inside the first desktop screen');
  record('the first screen selects the ready human review, shows goal-wide verification beside acceptance checks, and keeps Approve visible without any mutation');

  await taskTab('n4').focus();await page.keyboard.press('Home');assert.equal(await taskTab('n1').getAttribute('aria-selected'),'true');
  await page.keyboard.press('ArrowRight');assert.equal(await taskTab('n2').getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');assert.equal(await taskTab('n4').getAttribute('aria-selected'),'true');
  await active().getByRole('button',{name:/Prove retries are safe/}).click();
  assert.equal(await taskTab('n3').getAttribute('aria-selected'),'true');
  await page.waitForFunction(()=>document.activeElement?.id==='control-task-title');
  await taskTab('n4').click();await (await openNote()).fill('The verification covers each acceptance check.');
  await taskTab('n1').click();await taskTab('n4').click();assert.equal(await (await openNote()).inputValue(),'The verification covers each acceptance check.');
  await area('Handoffs');assert.match(await evidence().innerText(),/fixture-conversation-42/);assert.match(await evidence().innerText(),/exact/);
  await capture('handoffs');await area('Activity');assert.match(await evidence().innerText(),/Review command completed/);await capture('activity');
  await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+3');await page.locator('#goal-g1').waitFor();
  assert.equal(await taskTab('n4').getAttribute('aria-selected'),'true');assert.equal(await evidence().getByRole('button',{name:'Activity',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await (await openNote()).inputValue(),'The verification covers each acceptance check.');
  await area('Proof');await evidence().getByRole('button',{name:'Protect every payment',exact:true}).click();assert.equal(await taskTab('n2').getAttribute('aria-selected'),'true');
  record('keyboard journey, prerequisite and proof attribution navigation preserve task identity, focus and drafts; selected task, evidence area and note survive a route change');

  const search=page.getByRole('searchbox',{name:'Search goals'}),scope=page.getByRole('combobox',{name:'Filter goals by project'});
  await scope.selectOption('p2');assert.equal(await page.locator('.control-docket').count(),2);
  await search.fill('no-such-goal');await page.getByRole('heading',{name:'No matching goals',exact:true}).waitFor();
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();assert.equal(await page.locator('.control-docket').count(),5);
  await page.getByRole('group',{name:'Filter goals by status'}).getByRole('button',{name:/blocked/}).click();assert.equal(await page.locator('.control-docket').count(),1);
  await choose('g2');assert.match(await active().innerText(),/exact match below a partial match/);
  await taskTab('b2').click();assert.match(await active().innerText(),/failed/);assert.equal(await active().getByRole('button',{name:'Mark complete',exact:true}).count(),0);
  await capture('blocked');
  await page.getByRole('group',{name:'Filter goals by status'}).getByRole('button',{name:/^All/}).click();
  record('project, text and state filters can be cleared; blocked work names its failed prerequisite and exposes no completion action');

  await choose('g1');await page.evaluate(()=>window.__holdGoal='g2');await goal('g2').click();
  await page.waitForFunction(()=>typeof window.__releaseGoal==='function');
  assert.equal(await page.locator('#goal-g1').count(),0);assert.equal(await page.getByRole('button',{name:'Approve',exact:true}).count(),0);
  await choose('g3');await page.evaluate(()=>{window.__holdGoal=null;window.__releaseGoal();});
  await page.waitForFunction(()=>document.querySelector('#goal-g3'));
  await page.evaluate(()=>window.__holdAction=true);await active().getByRole('button',{name:'Save checkpoint',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseAction==='function');
  await page.evaluate(()=>window.location.hash='#goal=g1');await page.locator('#goal-g1').waitFor();
  await page.evaluate(()=>{window.__holdAction=false;window.__releaseAction();});await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.pane-actions button')?.disabled);assert.equal(await page.locator('#goal-g3').count(),0);
  await page.evaluate(()=>window.__goalFailure='g2');await goal('g2').click();await page.getByRole('heading',{name:'This goal could not be read',exact:true}).waitFor();
  assert.equal(await page.locator('#goal-g3').count(),0);
  await page.evaluate(()=>window.__goalFailure=null);await page.getByRole('button',{name:'Try again',exact:true}).last().click();await page.locator('#goal-g2').waitFor();
  await page.evaluate(()=>window.__reviewGoals=window.__reviewGoals.filter(g=>g.id!=='g2'));await refresh();await page.locator('#goal-g1').waitFor();
  record('a delayed goal cannot replace a newer selection, a failed goal never retains another goal’s actions, and a removed selection falls back to an existing record');

  await choose('g4');assert.match(await active().innerText(),/queued by autopilot/);assert.equal(await active().getByRole('button',{name:'Start isolated task',exact:true}).count(),0);
  await active().getByRole('button',{name:'Run review gate',exact:true}).click();assert((await calls()).some(c=>c[0]==='runProof'&&c[1]==='d1'));
  await choose('g3');await active().getByRole('textbox',{name:'Evidence or handoff note'}).fill('Keep the same account conversation.');
  await active().getByRole('button',{name:'Save checkpoint',exact:true}).click();assert((await calls()).some(c=>c[0]==='checkpoint'&&c[1]==='c1'&&c[2]==='Keep the same account conversation.'));
  await active().getByRole('textbox',{name:'Path to claim'}).fill('src/account/new.ts');await active().getByRole('button',{name:'Claim',exact:true}).click();
  assert((await calls()).some(c=>c[0]==='claim'&&c[1]==='c1'&&c[2]==='src/account/new.ts'));
  await area('Handoffs');await evidence().getByRole('button',{name:'Release',exact:true}).click();assert((await calls()).some(c=>c[0]==='releaseClaim'&&c[1]==='claim1'));
  await active().getByRole('button',{name:'Open session',exact:true}).click();await page.locator('.sessions-view').waitFor();assert.equal(await page.locator('.session-item.active').getAttribute('title'),'claude · storefront');
  await go('Meta+3');await page.locator('#goal-g3').waitFor();
  record('queued work cannot be launched twice; review gate, checkpoint, path claim, release and session navigation retain their exact typed targets');

  await choose('g1');await taskTab('n4').click();
  await (await openNote()).fill('Please add the missing retry assertion.');
  await page.evaluate(()=>window.__actionFailure=true);await active().getByRole('button',{name:'Request changes',exact:true}).click();
  await page.getByText('Fixture action refused',{exact:true}).waitFor();assert.equal(await (await openNote()).inputValue(),'Please add the missing retry assertion.');
  await page.evaluate(()=>{window.__actionFailure=false;window.__holdAction=true;});
  await active().getByRole('button',{name:'Request changes',exact:true}).click();
  await page.waitForFunction(()=>typeof window.__releaseAction==='function');assert(await active().getByRole('button',{name:'Approve',exact:true}).isDisabled());
  await page.evaluate(()=>{window.__holdAction=false;window.__releaseAction();});
  await active().getByRole('button',{name:'Reopen task',exact:true}).waitFor();
  const decisions=(await calls()).filter(c=>c[0]==='complete');assert.equal(decisions.length,2);assert.deepEqual(decisions[1],['complete','n4',{detail:'Please add the missing retry assertion.',decision:'request_changes'}]);
  await active().getByRole('button',{name:'Reopen task',exact:true}).click();await active().getByRole('button',{name:'Approve',exact:true}).waitFor();
  await active().getByRole('button',{name:'Approve',exact:true}).click();await page.getByText('Decision recorded: approved.',{exact:true}).waitFor();
  assert.equal((await calls()).filter(c=>c[0]==='complete').at(-1)[2].decision,'approve');
  record('a failed decision keeps the note; pending actions disable duplicates; request-changes, retry and approval preserve the recorded decision payload');

  await page.locator('.control-execution > summary').click();await page.getByRole('button',{name:'Arm autopilot',exact:true}).click();
  assert.equal((await calls()).filter(c=>c[0]==='setAutopilot').length,0);
  assert.match(await page.locator('.control-autopilot').innerText(),/spend money with nobody watching/);
  await choose('g3');await page.locator('.control-execution > summary').click();assert.equal(await page.getByText(/Arming lets this goal spend money/).count(),0);
  await page.getByRole('textbox',{name:'Spend cap · USD',exact:true}).fill('12.50');await page.getByRole('button',{name:'Update cap',exact:true}).click();
  assert((await calls()).some(c=>c[0]==='setBudget'&&c[1]==='g3'&&c[2]===12.5));
  await page.getByRole('button',{name:'Arm autopilot',exact:true}).click();await page.getByRole('button',{name:'Arm autopilot',exact:true}).click();
  assert.deepEqual((await calls()).filter(c=>c[0]==='setAutopilot').at(-1),['setAutopilot','g3',{enabled:true,providerId:'claude',model:undefined}]);
  await page.getByRole('button',{name:'Disarm autopilot',exact:true}).click();assert.deepEqual((await calls()).filter(c=>c[0]==='setAutopilot').at(-1),['setAutopilot','g3',{enabled:false}]);
  await capture('execution');await page.locator('.control-execution > summary').click();
  record('autopilot still requires deliberate confirmation with provider and cap, goal switching dismisses that confirmation, and disarming remains a separate explicit action');

  await summary.click();await page.getByRole('button',{name:'Cancel task',exact:true}).click();assert.equal((await calls()).filter(c=>c[0]==='cancelMcpTask').length,0);
  await page.getByRole('button',{name:'Cancel task and stop the agent',exact:true}).click();await page.getByText(/Task canceled and its agent session stopped/).waitFor();
  assert((await calls()).some(c=>c[0]==='cancelMcpTask'&&c[1]==='mcp1'));
  assert.match(await page.locator('.control-table').innerText(),/3 of 5 reported/);
  await page.getByRole('button',{name:'Dismiss',exact:true}).click();assert((await calls()).some(c=>c[0]==='dismissEvent'&&c[1]==='ev1'));assert.equal(await page.locator('.control-event').count(),0);
  await page.getByRole('combobox',{name:'Event project',exact:true}).selectOption('p2');await page.getByRole('textbox',{name:'Event summary',exact:true}).fill('Search ranking changed after the catalog refresh.');await page.getByRole('button',{name:'Add event',exact:true}).click();
  assert((await calls()).some(c=>c[0]==='addEvent'&&c[1].projectId==='p2'));await capture('events');await summary.click();
  record('live task cancellation still requires confirmation and reports its receipt; event scope and dismissal stay explicit, while model cost states partial reporting');

  await page.getByRole('button',{name:'New goal',exact:true}).click();const sheet=page.locator('.planning-table');
  await sheet.getByRole('button',{name:'I’ll write the plan',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.hasAttribute('data-planning-initial'));
  assert(await sheet.getByRole('button',{name:'Create goal',exact:true}).isDisabled());
  await sheet.getByRole('combobox',{name:'Goal project',exact:true}).selectOption('p2');
  await sheet.getByRole('textbox',{name:'Title',exact:true}).first().fill('Preserve this draft');
  await sheet.getByRole('textbox',{name:'Objective',exact:true}).fill('Make the next receipt easier to read.');
  await sheet.getByRole('textbox',{name:'Acceptance checks · one per line',exact:true}).fill('Contrast meets the project standard.\nKeyboard navigation reaches every action.');
  await capture('task-graph');
  await sheet.getByRole('button',{name:'Back to goals',exact:true}).click();await sheet.waitFor({state:'hidden'});assert(await page.getByRole('button',{name:'New goal',exact:true}).evaluate(el=>el===document.activeElement));
  await page.getByRole('button',{name:'New goal',exact:true}).click();assert.equal(await sheet.getByRole('textbox',{name:'Title',exact:true}).first().inputValue(),'Preserve this draft');
  assert.equal(await page.getByRole('dialog').count(),0);
  await sheet.getByRole('button',{name:'Create goal',exact:true}).click();await sheet.getByRole('button',{name:'Open goal',exact:true}).click();await page.locator('#goal-new-goal').waitFor();
  const created=(await calls()).find(c=>c[0]==='create')[1];assert.equal(created.plan.length,4);assert.equal(created.acceptance.length,2);assert.equal(created.title,'Preserve this draft');assert.equal(created.projectId,'p2');
  await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+3');await page.locator('#goal-new-goal').waitFor();
  record('goal planning returns focus to its entry point, keeps its draft across navigation, validates required fields, and submits the explicit project, acceptance checks and four-task plan');

  await choose('g1');await taskTab('n4').click();await area('Proof');
  await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>document.documentElement.dataset.motion='off');
  assert.equal(await active().locator('.control-node').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await page.evaluate(()=>document.documentElement.dataset.motion='full');assert.notEqual(await active().locator('.control-node').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await page.evaluate(()=>document.documentElement.dataset.motion='auto');await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await active().locator('.control-node').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,960));
  await page.waitForFunction(()=>window.innerWidth===820);await page.locator('.control-reading').evaluate(el=>el.scrollTop=0);await capture('review-narrow');
  const dimensionsNow=await page.evaluate(()=>{const pane=document.querySelector('.control-view'),reading=document.querySelector('.control-reading');return {width:innerWidth,paneClient:pane.clientWidth,paneScroll:pane.scrollWidth,readingClient:reading.clientWidth,readingScroll:reading.scrollWidth};});
  dimensions.push(dimensionsNow);assert(dimensionsNow.paneScroll<=dimensionsNow.paneClient+1);assert(dimensionsNow.readingScroll<=dimensionsNow.readingClient+1);
  await evidence().scrollIntoViewIfNeeded();await capture('evidence-narrow');
  await page.getByRole('button',{name:'New goal',exact:true}).click();await capture('new-goal-narrow');await page.getByRole('button',{name:'Back to goals',exact:true}).click();
  record('Off and OS Reduce Motion remove reveal animation; the narrow desktop keeps every task and evidence area reachable without horizontal page overflow');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.waitForFunction(()=>innerWidth===1440);
  await choose('g4');await page.evaluate(()=>window.__goalFailure='g4');await refresh();assert(await active().getByRole('button',{name:'Run review gate',exact:true}).isDisabled());
  await page.evaluate(()=>{window.__goalFailure=null;window.__reviewGoals=[];});await refresh();await page.getByRole('button',{name:'Create your first goal',exact:true}).waitFor();assert.equal(await page.locator('.control-detail').count(),0);await capture('empty');
  await page.evaluate(()=>window.__listFailure=true);await refresh();assert.equal(await page.getByRole('button',{name:'Create your first goal',exact:true}).count(),0);assert.equal(await page.locator('.control-detail').count(),0);await capture('unavailable');
  record('failed refresh disables decisions based on stale evidence; a confirmed empty list and an unavailable list have distinct recovery states');


 }
 assert.deepEqual(errors,[]);
 writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,dimensions},null,2)+'\n');
 console.log('Review captures complete.');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
