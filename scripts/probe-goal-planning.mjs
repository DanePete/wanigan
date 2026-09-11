#!/usr/bin/env node
// Actual Electron/GPU renderer, isolated profile, deterministic bridge fixtures.
// No live provider, repository or session is touched by this probe.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url), {_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'), before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/goal-planning',before?'before':'after');
mkdirSync(out,{recursive:true});
if(before)for(const theme of ['dark','light']){
  const previous=path.join(root,`docs/visuals/review-workspace/before/new-goal-${theme}.png`);
  if(existsSync(previous))copyFileSync(previous,path.join(out,`new-goal-${theme}.png`));
}
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-plan-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks=[],errors=[],dimensions=[];
const record=text=>{checks.push(text);console.log(text);};
try {
  const page=await app.firstWindow();page.setDefaultTimeout(20000);
  const archiveAt=process.argv.indexOf('--archive');
  if(archiveAt>=0){const archive=process.argv[archiveAt+1],asar=require('@electron/asar');await page.route(rendererURL.replace('/index.html','/**'),route=>{const name='out/renderer'+new URL(route.request().url()).pathname;return route.fulfill({body:asar.extractFile(archive,name),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(name)]??'application/octet-stream'});});}
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'&&/Wanigan (GPU|orb initialization)/.test(message.text()))errors.push(message.text());});
  await page.addInitScript(STUB);
  await page.addInitScript(()=>{
    const api=window.wanigan, now=Date.now();
    window.__planCalls=[];window.__planGoals=[];window.__planRecords=[];
    const proposal=()=>({title:'A checkout you can trust',objective:'Make payment retries safe when a response never reaches the customer.',acceptance:['A repeated callback creates one charge.','The timeout case has a passing regression test.'],risk:'elevated',plan:[
      {kind:'implement',title:'Make retries safe',instructions:'Reuse the original payment result on a repeated callback.',dependsOn:[],claimPath:null},
      {kind:'verify',title:'Prove it under pressure',instructions:'Exercise timeouts and repeated callbacks.',dependsOn:[0],claimPath:null},
      {kind:'review',title:'Bring the evidence back',instructions:'Compare the evidence with each acceptance check.',dependsOn:[1],claimPath:null},
    ]});
    const create=input=>{
      const id='g'+(window.__planGoals.length+1);
      const goal={...input,id,projectName:input.projectId==='p1'?'storefront':'platform',status:'draft',baseCommit:null,createdAt:now,updatedAt:now,claims:[],proofs:[],checkpoints:[],autopilot:{enabled:false,providerId:null,model:null,budgetUsd:input.budgetUsd,spendUsd:0,spendStatus:'none',haltedReason:null,haltedAt:null},nodes:input.plan.map((node,index)=>({...node,id:id+'n'+index,docketId:id,status:node.dependsOn.length?'blocked':'ready',dependsOn:node.dependsOn.map(dep=>id+'n'+dep),providerId:null,model:null,sessionId:null,worktree:null,startedAt:null,endedAt:null,detail:null,deferUntil:null,queued:false}))};
      window.__planGoals.push(goal);return structuredClone(goal);
    };
    const action=async(method,args,work)=>{
      window.__planCalls.push([method,...args]);
      if(window.__planHold===method)await new Promise(resolve=>window.__planRelease=resolve);
      if(window.__planFail===method)throw new Error('Fixture: the request could not finish. Your draft is safe.');
      return structuredClone(work());
    };
    const iv=id=>window.__planRecords.find(row=>row.id===id);
    window.wanigan=new Proxy(api,{get(api,service){
      if(service==='control')return new Proxy(api.control,{get(control,method){
        if(method==='list')return async()=>structuredClone(window.__planGoals);
        if(method==='get')return async id=>structuredClone(window.__planGoals.find(goal=>goal.id===id));
        if(['board','events','outcomes','mcpTasks','resumeReceipts','traces'].includes(method))return async()=>[];
        if(method==='create')return async input=>action('create',[input],()=>create(input));
        return async(...args)=>{window.__planCalls.push(['unexpected:'+method,...args]);throw new Error('Unexpected operation: '+method);};
      }});
      if(service==='interview')return {
        models:async()=>window.__noModels?[]:[{id:'fixture-model',label:'Planning model',costPerQuestion:.02}],
        list:async()=>structuredClone(window.__planRecords),get:async id=>structuredClone(iv(id)),
        start:async input=>action('start',[input],()=>{
          const row={id:'iv'+(window.__planRecords.length+1),projectId:input.projectId,seed:input.seed,model:input.model,status:'asking',turns:[{question:'What would a safe retry look like to the customer?',why:'The visible outcome tells us what the implementation must preserve.',answer:null,at:now}],proposal:null,docketId:null,spendUsd:.018,budgetUsd:.6,maxQuestions:input.maxQuestions,calls:1,detail:null,createdAt:now,updatedAt:now};
          window.__planRecords.push(row);return row;
        }),
        answer:async(id,answer)=>action('answer',[id,answer],()=>{
          const row=iv(id);row.turns.at(-1).answer=answer;row.calls++;row.spendUsd+=.019;
          if(row.turns.length===1)row.turns.push({question:'What is the failure we absolutely cannot allow?',why:'One concrete failure gives us a useful acceptance check.',answer:null,at:now+1});
          else {row.status='proposed';row.proposal=proposal();}
          return row;
        }),
        conclude:async id=>action('conclude',[id],()=>{const row=iv(id);row.status='proposed';row.proposal=proposal();return row;}),
        commit:async(id,edits)=>action('commit',[id,edits],()=>{const row=iv(id),goal=create({projectId:row.projectId,...row.proposal,...edits});row.status='committed';row.docketId=goal.id;row.proposal={...row.proposal,...edits};return goal;}),
      };
      return api[service];
    }});
  });
  await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
  const go=async key=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
  const stage=name=>page.locator(`.planning-table[data-stage=${name}]`);
  const calls=()=>page.evaluate(()=>window.__planCalls);
  const capture=async name=>{
    if(!before)await page.waitForFunction(()=>document.querySelector('.planning-table .wanigan-orb')?.dataset.physics==='ready'&&Number(document.querySelector('.planning-table canvas')?.dataset.frames)>2);
    for(const theme of ['dark','light']){
      const frame=Number(await page.locator('.planning-table canvas').getAttribute('data-frames').catch(()=>0));
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      if(!before)await page.waitForFunction(frame=>Number(document.querySelector('.planning-table canvas')?.dataset.frames)>frame,frame);
      await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css',animations:'disabled'});
    }
  };
  if(before){
    await go('Meta+Shift+B');await page.getByRole('button',{name:'Plan a goal',exact:true}).first().click();
    await page.getByRole('heading',{name:'Plan a goal',exact:true}).waitFor();await capture('plan-a-goal');
  }else{
    await go('Meta+3');await page.getByRole('button',{name:'New goal',exact:true}).click();await stage('idea').waitFor();
    const planner=page.locator('.planning-table'),canvas=planner.locator('canvas');
    await page.waitForFunction(()=>Number(document.querySelector('.planning-table canvas')?.dataset.frames)>0);
    assert.equal(await page.getByRole('dialog').count(),0);assert.deepEqual(await calls(),[]);
    assert(await planner.getByRole('button',{name:'Plan together',exact:true}).isDisabled());
    assert(await planner.getByLabel('Your goal idea',{exact:true}).evaluate(el=>el===document.activeElement));
    await capture('idea');
    const ripple=Number(await canvas.getAttribute('data-listening-ripples')??0);
    await planner.getByLabel('Your goal idea',{exact:true}).fill('Make checkout retries safe, even when the payment response is lost.');
    await page.waitForFunction(n=>Number(document.querySelector('.planning-table canvas')?.dataset.listeningRipples)>n,ripple);
    await page.waitForFunction(()=>document.querySelector('.planning-table canvas')?.dataset.gesture==='listening');
    assert(Number(await canvas.getAttribute('data-gaze-x'))>0,'eyes turn toward the idea');
    assert.equal(await page.locator('.companion-presence').isVisible(),false);
    record('Both entry points use an open planning page; idea focus, typing ripples and intentional gaze work with the full GPU companion, without a model call.');
    await planner.getByRole('button',{name:'I’ll write the plan',exact:true}).click();await stage('plan').waitFor();
    const title=planner.getByLabel('Title',{exact:true}).first();
    await title.fill('A receipt worth keeping');await planner.getByRole('textbox',{name:'Objective',exact:true}).fill('Make receipts readable with keyboard and screen reader.');
    await planner.getByRole('textbox',{name:'Acceptance checks · one per line',exact:true}).fill('Every action is keyboard accessible.\nContrast meets the project standard.');
    await planner.getByLabel('Goal project',{exact:true}).selectOption('p2');
    await planner.getByLabel('Goal budget · USD',{exact:true}).fill('-1');assert(await planner.getByRole('button',{name:'Create goal',exact:true}).isDisabled());
    await planner.getByLabel('Goal budget · USD',{exact:true}).fill('12');
    await planner.getByRole('button',{name:'Back to goals',exact:true}).click();await page.getByRole('button',{name:'New goal',exact:true}).click();
    assert.equal(await title.inputValue(),'A receipt worth keeping');assert.equal(await planner.getByLabel('Goal project',{exact:true}).inputValue(),'p2');
    await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+3');await stage('plan').waitFor();assert.equal(await title.inputValue(),'A receipt worth keeping');
    await capture('editable-plan');
    await planner.locator('.control-plan-summary').first().click();await planner.locator('.control-plan-row').first().getByLabel('Title',{exact:true}).fill('Understand the receipt');
    await capture('task-instructions');
    await planner.getByRole('button',{name:'Add task',exact:true}).click();
    const added=planner.locator('.control-plan-row[open]');
    await added.getByRole('textbox',{name:'Title',exact:true}).fill('Check the keyboard path');
    await added.getByRole('textbox',{name:'Instructions',exact:true}).fill('Reach every receipt action using only the keyboard.');
    assert.equal(await planner.locator('.control-plan-row').count(),5);
    assert(await planner.getByRole('button',{name:'Create goal',exact:true}).isEnabled());
    await added.getByRole('button',{name:'Remove',exact:true}).click();
    assert.equal(await planner.locator('.control-plan-row').count(),4);
    await page.evaluate(()=>window.__planFail='create');await planner.getByRole('button',{name:'Create goal',exact:true}).click();
    await planner.locator('.note.tone-error').waitFor();assert.equal(await title.inputValue(),'A receipt worth keeping');await capture('save-error');
    await page.evaluate(()=>{window.__planFail=null;window.__planHold='create';});
    await planner.getByRole('button',{name:'Create goal',exact:true}).click();await page.waitForFunction(()=>typeof window.__planRelease==='function');
    assert.equal(await stage('saved').count(),0);assert(await title.isDisabled());
    await page.evaluate(()=>{window.__planHold=null;window.__planRelease();delete window.__planRelease;});await stage('saved').waitFor();
    await page.waitForFunction(()=>document.querySelector('.planning-table canvas')?.dataset.gesture==='spin');
    await capture('saved');await planner.getByRole('button',{name:'Open goal',exact:true}).click();await page.locator('#goal-g1').waitFor();
    const created=(await calls()).filter(call=>call[0]==='create');assert.equal(created.length,2);assert.equal(created[1][1].budgetUsd,12);assert.equal(created[1][1].plan[0].title,'Understand the receipt');assert.equal(created[1][1].projectId,'p2');
    record('Manual planning retains edits across navigation, validates budgets, edits task instructions, preserves a failed save and celebrates only a confirmed goal.');

    await go('Meta+Shift+B');await page.getByRole('button',{name:'Plan a goal',exact:true}).first().click();await stage('idea').waitFor();
    await planner.getByLabel('Your goal idea',{exact:true}).fill('Make checkout retries safe when a payment response never arrives.');
    await page.evaluate(()=>window.__planHold='start');await planner.getByRole('button',{name:'Plan together',exact:true}).click();await page.waitForFunction(()=>typeof window.__planRelease==='function');
    assert(await planner.getByLabel('Your goal idea',{exact:true}).isDisabled());
    await page.waitForFunction(()=>document.querySelector('.planning-table canvas')?.dataset.gesture==='thinking');await capture('thinking');
    await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+Shift+B');await stage('idea').waitFor();
    assert(await planner.getByRole('button',{name:'Thinking it through…',exact:true}).isDisabled(),'pending request stays locked across navigation');
    assert.equal((await calls()).filter(call=>call[0]==='start').length,1);
    await page.evaluate(()=>{window.__planHold=null;window.__planRelease();delete window.__planRelease;});await stage('conversation').waitFor();
    const answer=planner.getByLabel('Your planning answer',{exact:true});await answer.fill('They see their original order and are never charged again.');await capture('conversation');
    await page.evaluate(()=>window.__planHold='answer');await answer.press('Meta+Enter');await page.keyboard.press('Meta+Enter');await page.waitForFunction(()=>typeof window.__planRelease==='function');
    assert.equal((await calls()).filter(call=>call[0]==='answer').length,1);assert(await answer.isDisabled());
    await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();
    await page.evaluate(()=>{window.__planHold=null;window.__planRelease();delete window.__planRelease;});await go('Meta+Shift+B');await planner.getByRole('heading',{name:'What is the failure we absolutely cannot allow?',exact:true}).waitFor();
    await answer.fill('A duplicate charge, even after multiple retries.');
    await page.evaluate(()=>window.__planFail='answer');await planner.getByRole('button',{name:'Continue together',exact:true}).click();await planner.locator('.note.tone-error').waitFor();assert.equal(await answer.inputValue(),'A duplicate charge, even after multiple retries.');
    await page.evaluate(()=>window.__planFail=null);await planner.getByRole('button',{name:'Continue together',exact:true}).click();await stage('plan').waitFor();assert.equal(await title.inputValue(),'A checkout you can trust');
    await title.fill('Retry without regret');await planner.getByLabel('Goal budget · USD',{exact:true}).fill('8');
    await planner.getByRole('button',{name:'Back to the board',exact:true}).click();await page.getByRole('button',{name:'Plan a goal',exact:true}).first().click();await stage('plan').waitFor();assert.equal(await title.inputValue(),'Retry without regret');
    assert.equal((await calls()).filter(call=>call[0]==='start').length,1);
    await capture('proposed-plan');
    await planner.getByRole('button',{name:'Create goal',exact:true}).click();await stage('saved').waitFor();
    assert.equal((await calls()).find(call=>call[0]==='commit')[2].budgetUsd,8);assert.equal((await calls()).find(call=>call[0]==='commit')[2].title,'Retry without regret');
    assert.equal((await calls()).filter(call=>call[0].startsWith('unexpected:')).length,0);
    record('The existing AI interview drives questions, recorded spend and editable proposals; duplicate shortcuts make one request, errors retain answers, and saving never launches tasks.');
    await planner.getByRole('button',{name:'Open goal',exact:true}).click();await page.locator('#goal-g2').waitFor();
    await page.evaluate(()=>window.__noModels=true);await page.getByRole('button',{name:'New goal',exact:true}).click();await stage('idea').waitFor();
    await planner.getByLabel('Your goal idea',{exact:true}).fill('An idea without an available planning model.');
    assert(await planner.getByRole('button',{name:'Plan together',exact:true}).isDisabled());assert(await planner.getByRole('button',{name:'I’ll write the plan',exact:true}).isEnabled());
    for(const width of [960,720]){
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);await page.waitForFunction(width=>innerWidth===width,width);
      const geometry=await planner.evaluate(el=>({width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth}));dimensions.push(geometry);assert(geometry.scroll<=geometry.client+1);await capture('idea-'+width);
    }
    await page.evaluate(()=>document.documentElement.dataset.motion='off');await page.waitForTimeout(400);const stopped=await canvas.getAttribute('data-frames');await page.waitForTimeout(400);assert.equal(await canvas.getAttribute('data-frames'),stopped);
    await page.evaluate(()=>document.documentElement.dataset.motion='auto');await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(400);const reduced=await canvas.getAttribute('data-frames');await page.waitForTimeout(400);assert.equal(await canvas.getAttribute('data-frames'),reduced);
    record('No-model state keeps manual planning available; 960 and 720 layouts fit both themes, and Off / system Reduce Motion stop continuous GPU animation.');
  }
  assert.deepEqual(errors,[]);
  rmSync(path.join(out,'failure.png'),{force:true});
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Real Electron renderer and GPU with deterministic synthetic bridge; no paid model calls or agent launches',checks,errors,dimensions},null,2)+'\n');
}catch(error){try{await (await app.firstWindow()).screenshot({path:path.join(out,'failure.png'),scale:'css'});}catch{}throw error;}
finally{await app.close();rmSync(dir,{recursive:true,force:true});}
