#!/usr/bin/env node
// Isolated renderer fixtures only. No real scheduler, accounts, agents or models.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const before=process.argv.includes('--before'),rendererAt=process.argv.indexOf('--renderer');
const renderer=rendererAt<0?path.join(root,'out/renderer'):path.resolve(process.argv[rendererAt+1]);
const out=path.join(root,'docs/visuals/ux-audit-2026-09-15/implementation/schedules',before?'before':'after');
mkdirSync(out,{recursive:true});
const temp=mkdtempSync(path.join(tmpdir(),'wanigan-schedule-execution-'));
writeFileSync(path.join(temp,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(temp,'main.cjs'),`--user-data-dir=${temp}/profile`],env});
const checks=[],errors=[],dimensions=[];
let page;
try {
  page=await app.firstWindow();page.setDefaultTimeout(15000);await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(rendererURL.replace('/index.html','/**'),route=>{
    const file=path.join(renderer,new URL(route.request().url()).pathname);
    return route.fulfill({body:readFileSync(file),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]??'application/octet-stream'});
  });
  await page.addInitScript(STUB+`
    (()=>{
      const base=window.wanigan,now=Date.now();
      const proxy=(target,changes)=>new Proxy(target,{get:(t,p)=>p in changes?changes[p]:t[p]});
      const capabilities={probed:true,hooks:true,telemetry:true,mcp:true,policy:true,transcript:true,namedResume:true,headlessJson:true,headlessBudget:true,note:null};
      window.__agents=[
        {id:'claude',label:'Claude Code',bin:'claude',path:'/fixture/claude',version:'fixture',harnessId:'claude-code',backendId:'anthropic',profileFingerprint:'claude-reviewed',capabilities,supports:{model:true,effort:true,permissionMode:true,resume:true},launchFields:[]},
        {id:'codex',label:'Codex',bin:'codex',path:'/fixture/codex',version:'fixture',harnessId:'codex',backendId:'openai',profileFingerprint:'codex-reviewed',capabilities:{...capabilities,headlessBudget:false},supports:{model:true,effort:true,permissionMode:true,resume:true},launchFields:[]},
        {id:'missing',label:'Team agent',bin:'agent',path:null,version:null,profileFingerprint:'missing',capabilities,supports:{model:false,effort:false,permissionMode:false,resume:false},launchFields:[]}
      ];
      const row=(id,name,payload,kind='headless')=>({id,name,cron:'7 9 * * 1-5',kind,payload,projectId:'p1',enabled:true,createdAt:now-86400000,nextAt:now+3600000,lastAt:null,lastStatus:null,lastDetail:null,runs:0,describe:'weekdays at 09:07'});
      const prompt='Review checkout changes and report regressions. Do not modify source files.';
      window.__schedules=[
        row('pinned','Morning checkout review',{prompt,executionVersion:1,providerId:'claude',providerProfileFingerprint:'claude-reviewed',providerLabel:'Claude Code'}),
        row('legacy','Earlier dependency review',{prompt}),
        row('codex','Accessibility review',{prompt,executionVersion:1,providerId:'codex',providerProfileFingerprint:'codex-reviewed',providerLabel:'Codex'}),
        row('missing','Team agent review',{prompt,executionVersion:1,providerId:'retired',providerProfileFingerprint:'retired',providerLabel:'Retired team profile'}),
        row('batch','Catalog descriptions',{runId:'batch-one',runName:'Catalog descriptions'},'batch')
      ];
      window.__scheduleCalls=[];window.__daemonOn=false;window.__providerError=false;
      window.wanigan=proxy(base,{
        prefs:proxy(base.prefs,{all:async()=>({...await base.prefs.all(),motion:'off',navSidebar:'closed'})}),
        providers:proxy(base.providers,{list:async()=>{if(window.__providerError)throw new Error('Fixture provider read unavailable');return structuredClone(window.__agents);}}),
        settings:proxy(base.settings,{get:async()=>({spendCapUsd:5})}),
        batch:proxy(base.batch,{runs:async()=>[{id:'batch-one',name:'Catalog descriptions',kind:'batch',model:'fixture-model',status:'completed',total_requests:120,est_cost_usd:1,cost_usd:1.2,created_at:now}]}),
        schedule:{
          list:async()=>structuredClone(window.__schedules),
          daemon:async()=>({supported:true,installed:window.__daemonOn,detail:window.__daemonOn?'Background scheduler installed.':'Schedules run while Wanigan is open.'}),
          history:async()=>[],
          preview:async cron=>{if(cron==='invalid')throw new Error('Invalid timing fixture');return {describe:'weekdays at 09:07',fires:[1,2,3].map(n=>now+n*86400000)};},
          create:async input=>{window.__scheduleCalls.push(['create',structuredClone(input)]);if(window.__saveFailure)throw new Error('Fixture save refused');const saved={...row('created',input.name,input.payload,input.kind),...input};window.__schedules.push(saved);return structuredClone(saved);},
          update:async(id,patch)=>{window.__scheduleCalls.push(['update',id,structuredClone(patch)]);const saved=window.__schedules.find(row=>row.id===id);Object.assign(saved,patch);return structuredClone(saved);},
          setEnabled:async(id,enabled)=>{window.__scheduleCalls.push(['setEnabled',id,enabled]);const saved=window.__schedules.find(row=>row.id===id);saved.enabled=enabled;return structuredClone(saved);},
          installDaemon:async()=>{window.__scheduleCalls.push(['installDaemon']);window.__daemonOn=true;return {supported:true,installed:true,detail:'Background scheduler installed.'};},
          uninstallDaemon:async()=>{window.__scheduleCalls.push(['uninstallDaemon']);window.__daemonOn=false;return {supported:true,installed:false,detail:'Schedules run while Wanigan is open.'};},
          tick:async()=>{window.__scheduleCalls.push(['tick']);return 0;},
          remove:async id=>{window.__scheduleCalls.push(['remove',id]);window.__schedules=window.__schedules.filter(row=>row.id!==id);return true;}
        }
      });
    })();`);
  await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
  await page.keyboard.press('Meta+8');await page.locator('.sc-wrap').waitFor();
  const view=page.locator('.sc-wrap'),detail=view.locator('.sc-inspector'),form=view.locator('.sc-editor');
  const choose=async id=>{await view.locator('.sc-agenda [data-schedule-id="'+id+'"]').click();await detail.locator('h2[data-schedule-id="'+id+'"]').waitFor();};
  const capture=async name=>{
    await page.evaluate(()=>{if(document.querySelector('#fixture-provenance'))return;const tag=document.createElement('div');tag.id='fixture-provenance';tag.textContent='SYNTHETIC SCHEDULE FIXTURES · NO AGENTS LAUNCHED';tag.style.cssText='position:fixed;bottom:3px;right:8px;z-index:99999;background:#111;color:#fff;font:10px monospace;padding:3px 6px;pointer-events:none';document.body.append(tag);});
    for(const theme of ['dark','light']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:path.join(out,name+'-'+theme+'.png'),scale:'css',animations:'disabled'});}
  };
  await choose('pinned');await capture('selected');
  await choose('legacy');await capture('legacy');
  await view.getByRole('button',{name:'New schedule',exact:true}).click();
  await form.getByLabel('Schedule name',{exact:true}).fill('Nightly release review');await form.getByLabel('Prompt',{exact:true}).fill('Review release notes and report missing changes.');
  if(before){await capture('create');await form.getByRole('button',{name:'Back to schedules',exact:true}).click();}
  else {
    assert(await form.getByRole('button',{name:'Create schedule',exact:true}).isDisabled());
    assert.equal(await form.getByLabel('Scheduled agent').inputValue(),'');
    assert(await form.getByLabel('Scheduled agent').locator('option').filter({hasText:'Team agent'}).evaluate(option=>option.disabled));
    await form.getByLabel('Scheduled agent').selectOption(JSON.stringify(['codex','codex-reviewed']));
    await form.getByText(/this agent has no dollar spending limit/).waitFor();await capture('create-uncapped');
    await form.getByLabel('Scheduled agent').selectOption(JSON.stringify(['claude','claude-reviewed']));
    await form.getByText(/agent’s budget flag/).waitFor();await capture('create');
    await page.evaluate(()=>window.__saveFailure=true);await form.getByRole('button',{name:'Create schedule',exact:true}).click();
    await form.getByText('Fixture save refused',{exact:true}).waitFor();assert.equal(await form.getByLabel('Scheduled agent').inputValue(),JSON.stringify(['claude','claude-reviewed']));
    await page.evaluate(()=>window.__saveFailure=false);await form.getByRole('button',{name:'Create schedule',exact:true}).click();
    await detail.getByRole('heading',{name:'Nightly release review',exact:true}).waitFor();
    const submitted=await page.evaluate(()=>window.__scheduleCalls.filter(row=>row[0]==='create').at(-1)[1]);
    assert.equal(submitted.payload.providerId,'claude');assert.equal(submitted.payload.providerProfileFingerprint,'claude-reviewed');assert.equal(submitted.payload.executionVersion,1);
    checks.push('New schedules require explicit agent selection, persist the chosen fingerprint, and retain selection and drafts after failure.');
    await choose('legacy');await detail.getByText('Provider chosen at run time',{exact:true}).waitFor();
    await detail.getByRole('button',{name:'Review agent',exact:true}).click();
    assert.equal(await form.getByLabel('Scheduled agent').inputValue(),'');assert(await form.getByRole('button',{name:'Save changes',exact:true}).isDisabled());
    await form.getByLabel('Scheduled agent').selectOption(JSON.stringify(['codex','codex-reviewed']));await form.getByRole('button',{name:'Save changes',exact:true}).click();
    await detail.getByText('Codex',{exact:true}).waitFor();assert((await detail.innerText()).includes('no dollar spending limit'));
    checks.push('Legacy schedules disclose runtime selection and need an explicit current agent before an edit can save.');
    await choose('missing');await detail.getByText('Blocked',{exact:true}).waitFor();await capture('unavailable');
    await choose('pinned');await page.evaluate(()=>window.__agents[0].profileFingerprint='claude-changed');await view.getByRole('button',{name:'Refresh schedules',exact:true}).click();
    await detail.getByText('Blocked',{exact:true}).waitFor();assert((await detail.innerText()).includes('profile changed'));await capture('changed-profile');
    await detail.getByRole('button',{name:'Review agent',exact:true}).click();assert(await form.getByRole('button',{name:'Save changes',exact:true}).isDisabled());
    await form.getByLabel('Scheduled agent').selectOption(JSON.stringify(['claude','claude-changed']));await form.getByRole('button',{name:'Save changes',exact:true}).click();await detail.getByText('Profile selected',{exact:true}).waitFor();
    await page.evaluate(()=>window.__providerError=true);await view.getByRole('button',{name:'Refresh schedules',exact:true}).click();await detail.getByText('Not checked',{exact:true}).waitFor();
    await page.evaluate(()=>window.__providerError=false);await view.getByRole('button',{name:'Refresh schedules',exact:true}).click();await detail.getByText('Profile selected',{exact:true}).waitFor();
    checks.push('Missing and changed profiles do not fall back; failed availability reads remain unknown and recover on refresh.');
    await choose('batch');await detail.getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await form.getByLabel('Scheduled agent').count(),0);
    await form.getByLabel('Schedule name',{exact:true}).fill('Reviewed catalog batch');await form.getByRole('button',{name:'Save changes',exact:true}).click();await detail.getByRole('heading',{name:'Reviewed catalog batch',exact:true}).waitFor();
    const batch=await page.evaluate(()=>window.__scheduleCalls.filter(row=>row[0]==='update'&&row[1]==='batch').at(-1)[2]);assert.deepEqual(batch.payload,{runId:'batch-one',runName:'Catalog descriptions'});await capture('batch');
    checks.push('Batch schedules retain API re-submission semantics without an agent selector or invented profile.');
    assert((await view.locator('.sc-availability').innerText()).includes('Runs while Wanigan is open'));
    await view.getByRole('button',{name:'Scheduler settings',exact:true}).click();await view.getByRole('button',{name:'Fire schedules while Wanigan is closed',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.sc-availability')?.textContent?.startsWith('Background scheduler installed'));
    await view.locator('.sc-support summary').click();await choose('pinned');
    checks.push('Closed-app behavior is visible; background installation occurs only on its deliberate action.');
  }
  await choose('pinned');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,900));await page.waitForFunction(()=>innerWidth===960);
  const dimension=await view.evaluate(el=>({width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth}));dimensions.push(dimension);assert(dimension.scroll<=dimension.client+1);await capture('compact');
  assert.deepEqual(errors,[]);
} catch(error) {errors.push(String(error.stack??error));if(page)await page.screenshot({path:path.join(out,'failure.png'),scale:'css'}).catch(()=>{});}
finally {
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),renderer,checks,errors,dimensions,provenance:'Built renderer in isolated Electron with synthetic bridge. No live user data, provider calls, agents or real scheduler changes.'},null,2)+'\n');
  console.log(JSON.stringify({before,checks,errors,dimensions,out},null,2));await app.close();
}
if(errors.length)process.exitCode=1;
