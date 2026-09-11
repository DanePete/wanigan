#!/usr/bin/env node
// Real Electron renderer; all runs, launches and mutations are fixtures.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/runs-workspace',before?'before':'after');mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-runs-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks=[],errors=[],dimensions=[];const record=text=>{checks.push(text);console.log(text);};
try{
 const page=await app.firstWindow();page.setDefaultTimeout(15000);await page.emulateMedia({reducedMotion:'reduce'});
 const archiveAt=process.argv.indexOf('--archive');if(archiveAt>=0){const archive=process.argv[archiveAt+1],asar=require('@electron/asar');await page.route(rendererURL.replace('/index.html','/**'),route=>{const file='out/renderer'+new URL(route.request().url()).pathname;return route.fulfill({body:asar.extractFile(archive,file),contentType:({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'})[path.extname(file)]??'application/octet-stream'});});}
 page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const api=window.wanigan,now=Date.now();
  const run=(id,name,extra={})=>({id,name,model:'Claude · review',status:'ended',costUsd:1.25,costStatus:'partial',totalRequests:2,createdAt:now-3600000,submittedAt:now-3600000,endedAt:now-3000000,error:null,succeeded:2,failed:0,blocked:0,open:0,filesChanged:3,...extra});
  window.__runs=[run('r1','A calmer checkout release'),run('r2','Readiness across the platform',{status:'in_progress',succeeded:1,open:1,endedAt:null,costStatus:'reported'}),run('r3','Dependency drift review',{status:'failed',succeeded:0,failed:2,error:'One or more workers could not complete.'}),run('r4','Review the migration path',{succeeded:0,blocked:2,costStatus:'unreported',costUsd:0}),...Array.from({length:7},(_,i)=>run('old'+i,['Release notes, checked','Keep the catalog tidy','Accessibility pass','A quieter Monday','Check the build scripts','Read the deployment changes','Configuration audit'][i],{createdAt:now-(i+1)*86400000,costStatus:'reported'}))];
  const row=(runId,projectId)=>({runId,projectId,projectName:projectId==='p1'?'storefront':'platform',projectPath:'/example/'+projectId,status:runId==='r4'?'blocked':runId==='r2'&&projectId==='p2'?'running':'succeeded',costUsd:projectId==='p1'?1.25:0,costReported:projectId==='p1',durationMs:180000,exitCode:0,output:null,error:null,filesChanged:projectId==='p1'?2:1,worktree:runId==='r4'?null:'/example/worktrees/'+runId+'/'+projectId,startedAt:now-3600000,endedAt:now-3000000,hasOutput:runId!=='r4',hasError:runId==='r4'});
  window.__runCalls=[];window.__runReads=[];
  const action=async(method,args,work)=>{window.__runCalls.push([method,...args]);if(window.__holdRunAction===method)await new Promise(resolve=>window.__releaseRunAction=resolve);if(window.__failRunAction===method)throw new Error('Fixture action refused');return work();};
  window.wanigan=new Proxy(api,{get(api,service){
   if(service==='providers')return new Proxy(api.providers,{get(providers,method){if(method==='list')return async()=>{const rows=await api.providers.list();return rows.map(p=>({...p,capabilities:{...p.capabilities,headlessJson:true,headlessBudget:p.id==='claude',policy:p.id==='claude'},launchFields:[{id:'model',label:'Model',kind:'text',required:false,defaultValue:''}]}));};return providers[method];}});
   if(service==='worktrees')return new Proxy(api.worktrees,{get(worktrees,method){if(method==='merge')return async(...args)=>action('merge',args,()=>({merged:true,detail:'Fixture merge recorded.'}));return worktrees[method];}});
   if(service!=='headless')return api[service];
   return {
    runs:async()=>{window.__runReads.push(['runs']);if(window.__failRunList)throw new Error('Fixture run history unavailable');return structuredClone(window.__runs);},
    rows:async id=>{window.__runReads.push(['rows',id]);const failure=window.__failRows===id;const rows=['p1','p2'].map(p=>row(id,p));if(window.__holdRows===id)await new Promise(resolve=>window.__releaseRows=resolve);if(failure)throw new Error('Fixture repository read unavailable');return rows;},
    rowDetail:async(id,p)=>{window.__runReads.push(['detail',id,p]);if(window.__failDetail)throw new Error('Fixture output unavailable');return {runId:id,projectId:p,output:'Recorded output for '+id+' / '+p+'\n\nReviewed checkout validation, the catalog changes, and the build scripts. Two files changed; the reported checks are attached to this run.',error:null};},
    start:async input=>action('start',[input],()=>{window.__runs.unshift(run('created',input.name,{status:'in_progress',open:input.projectIds.length,succeeded:0,costUsd:0,costStatus:'unreported'}));return {runId:'created'};}),
    cancel:async id=>action('cancel',[id],()=>{Object.assign(window.__runs.find(r=>r.id===id),{open:0,status:'ended'});return true;}),
   };
  }});
 });
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
 const go=async key=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(key);};
 await go('Meta+0');await page.getByRole('heading',{name:'Runs',exact:true}).waitFor();
 const view=page.locator('.hr-view'),detail=page.locator('.hr-detail'),form=page.locator('.hr-compose');
 const choose=async id=>{await page.locator(`.hr-history [data-run-id="${id}"]`).click();await detail.getByRole('heading',{name:await page.evaluate(id=>window.__runs.find(r=>r.id===id).name,id),exact:true}).waitFor();};
 const calls=()=>page.evaluate(()=>window.__runCalls);
 const capture=async name=>{
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb-small')?.dataset.physics==='ready'&&Number(document.querySelector('.wanigan-orb-small canvas')?.dataset.frames)>0);
  for(const theme of ['dark','light']){const frame=Number(await page.locator('.wanigan-orb-small canvas').getAttribute('data-frames'));await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForFunction(frame=>Number(document.querySelector('.wanigan-orb-small canvas')?.dataset.frames)>frame,frame);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css',animations:'disabled'});}
 };
 if(before){await view.getByRole('heading',{name:'Start a fan-out',exact:true}).waitFor();await capture('runs');await detail.scrollIntoViewIfNeeded();await capture('review');}
 else {
  await detail.getByRole('heading',{name:'A calmer checkout release',exact:true}).waitFor();await detail.locator('.hr-row').first().waitFor();assert.equal(await form.count(),0);assert.deepEqual(await calls(),[]);assert.equal(await page.evaluate(()=>window.__runReads.filter(r=>r[0]==='detail').length),0);await capture('review');
  assert((await detail.innerText()).includes('≥ $1.25'));await detail.locator('.hr-output').first().locator('summary').click();await detail.getByText(/Recorded output for r1 \/ p1/).waitFor();await capture('output');
  await detail.locator('.hr-output').first().locator('summary').click();await detail.locator('.hr-output').first().locator('summary').click();assert.equal(await page.evaluate(()=>window.__runReads.filter(r=>r[0]==='detail').length),1);
  await page.evaluate(()=>window.__failRows='r3');await choose('r3');await detail.getByRole('heading',{name:"Could not read this run's repositories",exact:true}).waitFor();assert.equal(await detail.locator('.hr-row').count(),0);assert((await detail.innerText()).includes('—'));await capture('rows-error');
  await page.evaluate(()=>window.__failRows=null);await detail.getByRole('button',{name:'Try again',exact:true}).click();await detail.locator('.hr-row').first().waitFor();
  await page.evaluate(()=>window.__holdRows='r1');await choose('r1');await page.waitForFunction(()=>typeof window.__releaseRows==='function');await choose('r2');await detail.locator('.hr-row').first().waitFor();await page.evaluate(async()=>{window.__holdRows=null;window.__releaseRows();await Promise.resolve();});assert((await detail.innerText()).includes('running'));
  record('Review leads with recorded work; partial cost stays qualified, output loads on demand, and failed or late reads cannot show another run’s repositories.');
  await choose('r1');await detail.getByRole('button',{name:'Squash merge…',exact:true}).first().click();assert.equal((await calls()).length,0);await choose('r2');assert.equal(await detail.getByRole('button',{name:'Squash merge',exact:true}).count(),0);
  await choose('r1');await detail.getByRole('button',{name:'Squash merge…',exact:true}).first().click();await page.evaluate(()=>window.__holdRunAction='merge');await detail.getByRole('button',{name:'Squash merge',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseRunAction==='function');assert(await detail.getByRole('button',{name:'Squash merge',exact:true}).isDisabled());await page.evaluate(()=>{window.__holdRunAction=null;window.__releaseRunAction();});await page.waitForFunction(()=>!document.querySelector('.hr-detail .confirm-note'));assert.equal((await calls()).filter(c=>c[0]==='merge').length,1);assert.equal((await calls()).find(c=>c[0]==='merge')[2].message,'wanigan: A calmer checkout release · storefront');
  await choose('r2');await detail.getByRole('button',{name:'Cancel run…',exact:true}).click();assert.equal((await calls()).filter(c=>c[0]==='cancel').length,0);await detail.getByRole('button',{name:'Cancel run',exact:true}).click();await page.waitForFunction(()=>window.__runs.find(r=>r.id==='r2').open===0);assert.deepEqual((await calls()).filter(c=>c[0]==='cancel'),[['cancel','r2']]);
  await view.getByLabel('Search runs',{exact:true}).fill('migration');assert.equal(await page.locator('.hr-run').count(),1);await view.getByRole('button',{name:'Clear filters',exact:true}).click();
  record('Search narrows the ledger; merge and cancellation require named confirmations, and merge targets stay bound to the reviewed run.');
  await view.getByRole('button',{name:'New run',exact:true}).click();await form.waitFor();assert(await form.getByRole('button',{name:'Run in 0 repos',exact:true}).isDisabled());
  await form.getByLabel('Run name optional',{exact:true}).fill('Review the release, quietly');await form.getByLabel('Task for every repository',{exact:true}).fill('Review the release notes and report gaps. Do not edit files.');await form.getByLabel('Model',{exact:true}).fill('fixture-custom');
  await form.getByRole('button',{name:'storefront',exact:true}).click();await capture('prepare');
  await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+0');assert.equal(await form.getByLabel('Model',{exact:true}).inputValue(),'fixture-custom');assert.equal(await form.getByLabel('Run name optional',{exact:true}).inputValue(),'Review the release, quietly');assert.equal(await form.getByRole('button',{name:'storefront',exact:true}).getAttribute('aria-pressed'),'true');
  await form.getByRole('button',{name:'Select all projects',exact:true}).click();assert(await form.getByRole('button',{name:'Run in 2 repos',exact:true}).isDisabled());await form.getByRole('checkbox',{name:/Run in every registered repository/}).check();
  await form.getByLabel('Provider',{exact:true}).selectOption('codex');assert((await form.locator('.hr-declare').innerText()).includes('not its cost'));assert.equal(await form.getByRole('textbox',{name:'CLI budget / repository',exact:true}).count(),0);await capture('provider-limits');
  await form.getByLabel('Provider',{exact:true}).selectOption('claude');await form.getByLabel('CLI budget / repository',{exact:true}).fill('-1');assert(await form.getByRole('button',{name:'Run in 2 repos',exact:true}).isDisabled());await form.getByLabel('CLI budget / repository',{exact:true}).fill('3');
  await page.evaluate(()=>window.__failRunAction='start');await form.getByRole('button',{name:'Run in 2 repos',exact:true}).click();await view.getByText('Fixture action refused',{exact:true}).waitFor();assert.equal(await form.getByLabel('Run name optional',{exact:true}).inputValue(),'Review the release, quietly');
  await page.evaluate(()=>{window.__failRunAction=null;window.__holdRunAction='start';window.__releaseRunAction=null;});await form.getByRole('button',{name:'Run in 2 repos',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseRunAction==='function');assert(await form.getByRole('button',{name:'Starting…',exact:true}).isDisabled());
  await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+0');assert(await form.getByRole('button',{name:'Starting…',exact:true}).isDisabled());await page.evaluate(()=>{window.__holdRunAction=null;window.__releaseRunAction();});await detail.getByRole('heading',{name:'Review the release, quietly',exact:true}).waitFor();assert.equal((await calls()).filter(c=>c[0]==='start').length,2);const submitted=(await calls()).filter(c=>c[0]==='start').at(-1)[1];assert.equal(submitted.allProjects,true);assert.equal(submitted.maxBudgetUsd,3);assert.equal(submitted.isolate,true);
  record('Preparation persists across navigation, defaults to no repositories, requires explicit full scope, respects provider budget capability, and keeps failed or pending launches from duplicating.');
  await choose('r1');await page.evaluate(()=>window.__failRunList=true);await view.getByRole('button',{name:'Refresh runs',exact:true}).click();await view.getByText(/Recent runs could not refresh/).waitFor();assert(await detail.getByRole('button',{name:'Squash merge…',exact:true}).first().isDisabled());await page.evaluate(()=>window.__failRunList=false);await view.getByRole('button',{name:'Refresh runs',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.hr-view > .note'));
  for(const width of [960,720]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1000),width);await page.waitForFunction(width=>innerWidth===width,width);const size=await view.evaluate(el=>({width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth}));dimensions.push(size);assert(size.scroll<=size.client+1);await capture('review-'+width);}
  await view.getByRole('button',{name:'New run',exact:true}).click();
  for(const width of [960,720]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1000),width);await page.waitForFunction(width=>innerWidth===width,width);const size=await view.evaluate(el=>({surface:'prepare',width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth}));dimensions.push(size);assert(size.scroll<=size.client+1);await capture('prepare-'+width);}
  await view.getByRole('button',{name:'Back to runs',exact:true}).click();
  await page.evaluate(()=>document.documentElement.dataset.motion='off');assert.equal(await detail.locator('.hr-reading').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.waitForFunction(()=>innerWidth===1440);await page.evaluate(()=>window.__runs=[]);await view.getByRole('button',{name:'Refresh runs',exact:true}).click();await view.getByRole('heading',{name:'Nothing has run yet',exact:true}).waitFor();await capture('empty');
  record('Read failures preserve evidence and disable unsafe actions; both themes fit narrow windows, Off disables the reveal, and verified emptiness has a preparation path.');
 }
 assert.deepEqual(errors,[]);rmSync(path.join(out,'failure.png'),{force:true});writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,dimensions,provenance:'Packaged renderer with synthetic runs; no real agent launch, cancellation, merge or provider call'},null,2)+'\n');
}catch(error){await (await app.firstWindow()).screenshot({path:path.join(out,'failure.png'),scale:'css'}).catch(()=>{});throw error;}
finally{await app.close();rmSync(dir,{recursive:true,force:true});}
