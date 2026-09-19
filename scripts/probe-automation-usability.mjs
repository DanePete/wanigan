#!/usr/bin/env node
// Isolated production renderer, fictional data, no real schedule/provider/API calls.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/usability-2026-09-19/automation',before?'before':'after');
mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-automation-usability-'));
writeFileSync(path.join(dir,'main.cjs'),"const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));");
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const errors=[],checks=[];
let page;
try{
  page=await app.firstWindow();page.setDefaultTimeout(15000);await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(STUB);
  await page.addInitScript(()=>{
    localStorage.setItem('wanigan.navigation.visible','closed');
    const api=window.wanigan,now=Date.now();window.__automationCalls=[];window.__timingReads=[];
    const proxy=(target,changes)=>new Proxy(target,{get:(object,key)=>key in changes?changes[key]:object[key]});
    const record=(name,result)=>async(...args)=>{window.__automationCalls.push([name,...args]);return result;};
    const config={name:'',projectId:'p1',preset:'blank',model:'fixture-model',source:{kind:'csv',text:'name\nMaple\nBirch'},system:[{text:'Classify each tree name.',cache:true}],userTemplate:'Classify {{name}}.',maxTokens:256,cacheTtl:'1h',effort:'medium',thinking:'off',extendedOutput:false};
    const model={id:'fixture-model',label:'Example model',maxTokens:4096,maxInputTokens:200000,batchInput:1,batchOutput:4,pricingKnown:true,extendedOutput:false,supportsStructuredOutputs:false,efforts:['low','medium'],thinkingAdaptive:false};
    window.__scheduleRows=[{id:'custom',name:'Custom weekly audit',cron:'0  9 * * 7',kind:'headless',payload:{prompt:'Review this repository without changing files.',executionVersion:1,providerId:'claude',providerProfileFingerprint:'fixture-claude'},projectId:'p1',enabled:false,createdAt:now,lastAt:null,nextAt:null,lastStatus:null,lastDetail:null,runs:0,describe:'Custom Sunday pattern'}];
    window.wanigan=proxy(api,{
      key:proxy(api.key,{status:async()=>({present:true,fromEnv:false,fingerprint:'fixture'})}),
      prefs:proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})}),
      providers:proxy(api.providers,{list:async()=>(await api.providers.list()).map(provider=>({...provider,profileFingerprint:'fixture-'+provider.id,capabilities:{...provider.capabilities,headlessJson:true,headlessBudget:true}}))}),
      settings:proxy(api.settings,{get:async()=>({spendCapUsd:5})}),
      schedule:{
        list:async()=>structuredClone(window.__scheduleRows),daemon:async()=>({supported:true,installed:false,detail:'Fixture: runs while the app is open.'}),history:async()=>[],
        preview:async cron=>{
          window.__timingReads.push(cron);
          const fields=cron.trim().split(/\s+/);
          if(!cron||fields.length!==5)throw new Error('A cron expression needs five fields.');
          const [minute,hour,,,days]=fields,at=new Date(now),fires=[];
          at.setHours(Number(hour),Number(minute),0,0);
          while(fires.length<3){
            const weekday=at.getDay(),matches=days==='*'||days==='1-5'&&weekday>=1&&weekday<=5||Number(days)%7===weekday;
            if(matches&&at.getTime()>now)fires.push(at.getTime());
            at.setDate(at.getDate()+1);
          }
          return {describe:`${days==='1-5'?'Weekdays':days==='*'?'Every day':'Weekly'} at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`,fires};
        },
        create:record('schedule.create',null),
        update:async(id,patch)=>{window.__automationCalls.push(['schedule.update',id,patch]);Object.assign(window.__scheduleRows.find(row=>row.id===id),patch);return structuredClone(window.__scheduleRows.find(row=>row.id===id));},
      },
      notify:proxy(api.notify,{resultsExpiring:async()=>[]}),
      evals:proxy(api.evals,{golden:async()=>[]}),
      batch:proxy(api.batch,{
        runs:async()=>[],presets:async()=>({presets:[{id:'blank',label:'Start from a prompt',blurb:'A fictional CSV classification task.',config}],models:[model],modelsFetchedAt:now,modelsStale:false}),
        preview:record('batch.preview',{rowCount:2,columns:['name'],rows:[{name:'Maple'},{name:'Birch'}],missingSlots:[]}),
        estimate:record('batch.estimate',{estimate:{requests:2,chunks:1,costLowUsd:.01,costHighUsd:.03,totalInputTokens:100,meanInputTokens:50,sampledRows:2,worstCaseOutputTokens:512,cachedPrefixTokens:0,syncCostHighUsd:.06,notes:[]},warnings:[],errors:[]}),
        dryRun:record('batch.dryRun',{result:{ok:false,message:'Fictional validation issue. Nothing was sent.'}}),
        submit:record('batch.submit',{runId:'refused-fixture'}),
      }),
    });
  });
  const go=async chord=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(chord);};
  const shoot=async name=>{
    for(const theme of ['dark','light']){
      await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
      await page.waitForTimeout(150);
      await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css',animations:'disabled'});
    }
  };
  const calls=()=>page.evaluate(()=>window.__automationCalls);
  await page.goto(rendererURL);await page.locator('.mission-room').waitFor();await go('Meta+8');
  await page.getByRole('button',{name:'New schedule',exact:true}).click();
  const form=page.locator('.sc-editor');
  await form.getByLabel('Schedule name',{exact:true}).fill('Weekday repository check');
  await form.getByLabel('Scheduled agent').selectOption(JSON.stringify(['claude','fixture-claude']));
  await form.getByLabel('Prompt',{exact:true}).fill('Review the latest changes and report risks. Make no edits.');
  if(before){await form.getByLabel('Cron expression').fill('30 10 * * 1-5');await form.getByLabel('Cron expression').scrollIntoViewIfNeeded();}
  else{
    assert.equal(await form.getByLabel('Schedule repeat').inputValue(),'daily');
    await form.getByLabel('Schedule repeat').selectOption('weekdays');await form.getByLabel('Schedule time').fill('10:30');
    await page.waitForFunction(()=>window.__timingReads.includes('30 10 * * 1-5'));
    assert(await form.getByText(/Times use this Mac’s local time/).isVisible());
    await form.getByLabel('Schedule time').fill('');await form.getByText('A cron expression needs five fields.').waitFor();
    assert(await form.getByRole('button',{name:'Create schedule',exact:true}).isDisabled());
    await form.getByLabel('Schedule time').fill('10:30');
    await form.getByLabel('Schedule repeat').scrollIntoViewIfNeeded();
    checks.push('Daily and weekday controls produce the same cron input for the authoritative preview; an empty time blocks saving.');
  }
  await page.waitForFunction(()=>!document.querySelector('.sc-inspector')?.textContent.includes('Reading next occurrences'));
  await page.locator('.sc-inspector').evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await shoot('schedule-weekdays');
  if(!before){
    await form.getByLabel('Schedule repeat').selectOption('weekly');await form.getByLabel('Schedule weekday').selectOption('0');
    await page.waitForFunction(()=>window.__timingReads.includes('30 10 * * 0'));
    await form.getByRole('button',{name:'Back to schedules',exact:true}).click();
    await page.locator('.sc-inspector').getByRole('button',{name:'Edit',exact:true}).click();
    assert.equal(await form.getByLabel('Schedule repeat').inputValue(),'custom');
    assert.equal(await form.getByLabel('Cron expression').inputValue(),'0  9 * * 7');
    await form.getByRole('button',{name:'Save changes',exact:true}).click();
    await page.getByRole('heading',{name:'Custom weekly audit',exact:true}).waitFor();
    assert.equal((await calls()).find(call=>call[0]==='schedule.update')[2].cron,'0  9 * * 7');
    checks.push('Sunday 0 is generated for a chosen weekly cadence. Existing Sunday 7 with internal spacing stays Custom and is submitted unchanged.');
  }
  await go('Meta+4');await page.getByRole('button',{name:'New batch',exact:true}).click();
  await page.getByRole('heading',{name:'Prepare a batch',exact:true}).waitFor();
  const builder=page.locator('.bx-builder');await builder.getByLabel('Run name',{exact:true}).waitFor();
  await shoot('batch-start');
  if(!before){
    const startCalls=await calls();
    await builder.getByRole('button',{name:'Next: Dataset',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Dataset rows');
    await builder.getByRole('button',{name:'Back to start',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.id==='batch-run-name');
    await builder.getByRole('button',{name:'Next: Dataset',exact:true}).click();
    await builder.locator('.bx-blockers').getByRole('button',{name:'Name the run',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.id==='batch-run-name');
    assert.deepEqual(await calls(),startCalls);
    await builder.getByLabel('Run name',{exact:true}).fill('Tree classification');
    await builder.locator('.bx-blockers').getByRole('button',{name:'Load the dataset',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.id==='batch-load-dataset');
    assert.deepEqual(await calls(),startCalls);
    await builder.getByRole('button',{name:'Load dataset',exact:true}).click();
    await builder.locator('.bx-blockers').getByRole('button',{name:'Review the cost estimate',exact:true}).waitFor();
    const loadedCalls=await calls();
    await builder.locator('.bx-blockers').getByRole('button',{name:'Review the cost estimate',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.id==='batch-estimate');
    assert.deepEqual(await calls(),loadedCalls);
    await shoot('batch-estimate');
    await builder.getByRole('button',{name:'Estimate',exact:true}).click();
    await builder.getByRole('button',{name:/Submit — up to/}).waitFor();
    assert.equal((await calls()).filter(call=>call[0]==='batch.estimate').length,1);
    await builder.getByRole('button',{name:'Dry run',exact:true}).click();
    await builder.locator('.bx-blockers').getByRole('button',{name:'Review the failed test request',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.id==='batch-dry-result');
    assert(await builder.getByRole('button',{name:/Submit — up to/}).isDisabled());
    assert.equal((await calls()).filter(call=>call[0]==='batch.submit').length,0);
    checks.push('Back/Next and blocker links select and focus the destination, preserving draft fields. Navigation makes no API/estimate/dry-run/submission call. Explicit Estimate runs once; failed test request remains a submission blocker.');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,1000));
    await page.waitForFunction(()=>innerWidth===960);await shoot('batch-compact');
    const width=await builder.evaluate(element=>({client:element.clientWidth,scroll:element.scrollWidth}));assert(width.scroll<=width.client+1);
    checks.push('Batch preparation fits a 960px window without horizontal page overflow.');
  }else{
    await builder.getByLabel('Run name',{exact:true}).fill('Tree classification');
    await builder.getByRole('button',{name:'2 · Dataset',exact:true}).click();
    await builder.getByRole('button',{name:'Load dataset',exact:true}).click();
    await builder.getByRole('button',{name:'4 · Model',exact:true}).click();await shoot('batch-estimate');
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),before,rendererRoot:process.env.WANIGAN_RENDERER_ROOT??'out/renderer',checks,errors,calls:await calls(),provenance:'Production renderer with fictional API fixtures in an isolated Electron profile. No main-process integration, real scheduler mutation, provider, estimate, or API request.'},null,2)+'\n');
  console.log(`${before?'Before capture':'After probe'} complete: ${checks.length} checks.`);
}catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{await app.close();rmSync(dir,{recursive:true,force:true});}
