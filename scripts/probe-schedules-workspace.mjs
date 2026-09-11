#!/usr/bin/env node
// Real Electron renderer; all schedules, launches and mutations are fixtures.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/schedules-workspace',before?'before':'after');mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-schedules-'));
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
  const row=(id,name,hours,extra={})=>{const at=new Date(now+hours*3600000);at.setSeconds(0,0);const schedule={id,name,cron:'3 3 * * *',kind:'headless',payload:{prompt:'Review the current changes and report findings. Do not edit files.',allProjects:false},projectId:'p1',enabled:true,createdAt:now-86400000*9,nextAt:now+hours*3600000,lastAt:now-86400000,lastStatus:'ok',lastDetail:'Run finished and its results were recorded.',runs:8,describe:'every day at 03:03',...extra};if(!extra.cron){schedule.cron=at.getMinutes()+' '+at.getHours()+' * * *';schedule.describe='every day at '+String(at.getHours()).padStart(2,'0')+':'+String(at.getMinutes()).padStart(2,'0');}schedule.nextAt=at.getTime();return schedule;};
  window.__schedules=[row('s1','Keep checkout honest',1),row('s2','Refresh the product catalog',4,{kind:'batch',projectId:'p2',payload:{runId:'b1',runName:'Catalog descriptions'},lastStatus:'queued',lastDetail:'Waiting for a batch slot.'}),row('s3','Look for dependency drift',14,{lastStatus:'failed',lastDetail:'The agent could not read the lockfile.'}),row('s4','A quieter Monday release',96,{cron:'7 8 * * 1',describe:'every Monday at 08:07',projectId:'p2',lastStatus:'unknown',lastDetail:'No terminal outcome was recorded.'}),row('s5','Retired accessibility check',24,{enabled:false}),row('s6','Legacy repository audit',26,{projectId:null,payload:{prompt:'Read-only audit.'}}),row('s7','Legacy terminal schedule',30,{kind:'session',enabled:false}),row('s8','An unfinished batch schedule',48,{kind:'batch',payload:{prompt:'Old shape.'}})];
  window.__scheduleCalls=[];window.__scheduleReads=[];
  const action=async(method,args,work)=>{window.__scheduleCalls.push([method,...args]);if(window.__holdScheduleAction===method)await new Promise(resolve=>window.__releaseScheduleAction=resolve);if(window.__scheduleActionFailure===method)throw new Error('Fixture action refused');return work();};
  window.wanigan=new Proxy(api,{get(api,service){
   if(service==='settings')return new Proxy(api.settings,{get(settings,method){if(method==='get')return async()=>({spendCapUsd:5});return settings[method];}});
   if(service==='batch')return new Proxy(api.batch,{get(batch,method){if(method==='runs')return async()=>[{id:'b1',name:'Catalog descriptions',kind:'batch',model:'fixture-model',status:'completed',total_requests:240,est_cost_usd:.8,cost_usd:1.2,created_at:now},{id:'h1',name:'Not a batch',kind:'headless',model:'fixture-model',status:'completed',total_requests:1,est_cost_usd:1,cost_usd:1,created_at:now}];return batch[method];}});
   if(service!=='schedule')return api[service];
   return {
    list:async()=>{window.__scheduleReads.push(['list']);if(window.__scheduleReadFailure)throw new Error('Fixture schedule list unavailable');return structuredClone(window.__schedules);},
    daemon:async()=>({supported:true,installed:!!window.__daemonOn,detail:window.__daemonOn?'Background scheduler installed.':'Schedules run while Wanigan is open.'}),
    preview:async cron=>{window.__scheduleReads.push(['preview',cron]);if(cron==='broken')throw new Error('A cron expression needs five fields.');const [minute,hour,,,weekday]=cron.split(' ');const at=new Date(now);at.setHours(Number(hour),Number(minute),0,0);if(at.getTime()<=now)at.setDate(at.getDate()+1);if(weekday==='1')while(at.getDay()!==1)at.setDate(at.getDate()+1);const value={describe:weekday==='1'?'every Monday at 08:07':'every day at '+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0'),fires:[0,1,2,3,4].map(n=>{const date=new Date(at);date.setDate(date.getDate()+n*(weekday==='1'?7:1));return date.getTime();})};if(window.__holdPreview===cron)await new Promise(resolve=>window.__releasePreview=resolve);return value;},
    history:async id=>{window.__scheduleReads.push(['history',id]);if(window.__historyFailure===id)throw new Error('Fixture history unavailable');const rows=[{at:now-86400000,status:window.__schedules.find(row=>row.id===id)?.lastStatus??'unknown',detail:'Recorded outcome for '+id},{at:now-172800000,status:'ok',detail:'Recorded earlier result for '+id}];if(window.__holdHistory===id)await new Promise(resolve=>window.__releaseHistory=resolve);return rows;},
    create:async input=>action('create',[input],()=>{const created=row('new',input.name,3,input);window.__schedules.push(created);return structuredClone(created);}),
    update:async(id,patch)=>action('update',[id,patch],()=>{Object.assign(window.__schedules.find(row=>row.id===id),patch);return structuredClone(window.__schedules.find(row=>row.id===id));}),
    setEnabled:async(id,on)=>action('setEnabled',[id,on],()=>{window.__schedules.find(row=>row.id===id).enabled=on;return structuredClone(window.__schedules.find(row=>row.id===id));}),
    remove:async id=>action('remove',[id],()=>{window.__schedules=window.__schedules.filter(row=>row.id!==id);return true;}),
    tick:async()=>action('tick',[],()=>0),
    installDaemon:async()=>action('installDaemon',[],()=>{window.__daemonOn=true;return {supported:true,installed:true,detail:'Background scheduler installed.'};}),
    uninstallDaemon:async()=>action('uninstallDaemon',[],()=>{window.__daemonOn=false;return {supported:true,installed:false,detail:'Schedules run while Wanigan is open.'};}),
   };
  }});
 });
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
 const go=async chord=>{await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press(chord);};
 await go('Meta+8');await page.getByRole('heading',{name:'Schedules',exact:true}).waitFor();
 const capture=async name=>{
  if(!before)await page.waitForFunction(()=>![...document.querySelectorAll('.sc-inspector')].some(el=>el.innerText.includes('Reading next occurrences…')));
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb-small')?.dataset.physics==='ready'&&Number(document.querySelector('.wanigan-orb-small canvas')?.dataset.frames)>0);
  for(const theme of ['dark','light']){
   const frame=Number(await page.locator('.wanigan-orb-small canvas').getAttribute('data-frames'));
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.waitForFunction(frame=>Number(document.querySelector('.wanigan-orb-small canvas')?.dataset.frames)>frame,frame);
   await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css',animations:'disabled'});
  }
 };
 if(before){await page.locator('.sc-item').first().waitFor();await capture('schedules');await page.locator('.sc-list').scrollIntoViewIfNeeded();await capture('saved-schedules');}
 else {
  const view=page.locator('.sc-wrap'),detail=page.locator('.sc-inspector'),item=id=>page.locator(`.sc-agenda [data-schedule-id="${id}"]`);
  const choose=async id=>{await item(id).click();await detail.locator(`h2[data-schedule-id="${id}"]`).waitFor();};
  const calls=()=>page.evaluate(()=>window.__scheduleCalls);
  await detail.getByRole('heading',{name:'Keep checkout honest',exact:true}).waitFor();await detail.getByText('Recorded outcome for s1',{exact:true}).waitFor();await capture('agenda');assert.deepEqual(await calls(),[]);
  assert.equal(await view.getByLabel('Schedule name',{exact:true}).count(),0);
  await choose('s2');await detail.getByText('Waiting for a batch slot.',{exact:true}).waitFor();assert(await detail.getByText('queued — nothing has picked it up yet',{exact:true}).count());await capture('batch');
  await detail.getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await page.locator('.sc-editor select[aria-label="Run to re-submit"] option').filter({hasText:'Not a batch'}).count(),0);await page.getByRole('button',{name:'Cancel edit',exact:true}).click();
  await page.evaluate(()=>window.__holdHistory='s6');await choose('s6');await page.waitForFunction(()=>typeof window.__releaseHistory==='function');await choose('s2');await detail.getByText('Recorded outcome for s2',{exact:true}).waitFor();await page.evaluate(async()=>{window.__holdHistory=null;window.__releaseHistory();await Promise.resolve();});assert.equal(await detail.getByText('Recorded outcome for s6',{exact:true}).count(),0);
  await choose('s6');assert((await detail.innerText()).includes('Needs attention'));await capture('legacy');
  record('The agenda leads with the next due schedule and adjacent evidence; queued, failed and legacy states remain distinct, and selection makes no mutation.');
  await view.getByLabel('Search schedules',{exact:true}).fill('dependency');assert.equal(await page.locator('.sc-agenda [data-schedule-id]').count(),1);await view.getByRole('button',{name:'Clear filters',exact:true}).click();
  await choose('s3');await detail.getByRole('button',{name:'Edit',exact:true}).click();const form=page.locator('.sc-editor');await form.getByLabel('Schedule name',{exact:true}).fill('Dependency drift, without surprises');
  await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+8');assert.equal(await form.getByLabel('Schedule name',{exact:true}).inputValue(),'Dependency drift, without surprises');
  await form.getByLabel('Project',{exact:true}).selectOption('');assert(await form.getByRole('button',{name:'Save changes',exact:true}).isDisabled());
  await form.getByRole('checkbox',{name:/Run in every registered repository/}).check();await form.getByRole('button',{name:'Save changes',exact:true}).click();await detail.getByRole('heading',{name:'Dependency drift, without surprises',exact:true}).waitFor();
  assert((await calls()).some(call=>call[0]==='update'&&call[1]==='s3'&&call[2].payload.allProjects===true));
  await detail.getByRole('button',{name:'Delete…',exact:true}).click();assert.equal((await calls()).filter(call=>call[0]==='remove').length,0);await choose('s1');assert.equal(await detail.getByRole('button',{name:'Delete schedule',exact:true}).count(),0);
  await page.evaluate(()=>window.__holdScheduleAction='setEnabled');await detail.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseScheduleAction==='function');assert(await detail.getByRole('button',{name:/Pausing/}).isDisabled());
  await page.evaluate(()=>{window.__holdScheduleAction=null;window.__releaseScheduleAction();});await detail.getByRole('button',{name:'Resume',exact:true}).waitFor();assert.equal((await calls()).filter(call=>call[0]==='setEnabled').length,1);
  record('Search, selection and edit drafts survive navigation; removing a project pin requires explicit fan-out intent, deletion stays confirmed, and a pending pause cannot repeat.');
  await view.getByRole('button',{name:'New schedule',exact:true}).click();await form.getByLabel('Schedule name',{exact:true}).fill('Read the release notes');await form.getByLabel('Prompt',{exact:true}).fill('Read the release notes and report anything missing.');await capture('create');
  await page.evaluate(()=>window.__holdPreview='4 4 * * *');await form.getByLabel('Cron expression',{exact:true}).fill('4 4 * * *');await page.waitForFunction(()=>typeof window.__releasePreview==='function');
  await form.getByLabel('Cron expression',{exact:true}).fill('broken');await form.getByText('A cron expression needs five fields.',{exact:true}).waitFor();await page.evaluate(async()=>{window.__holdPreview=null;window.__releasePreview();await Promise.resolve();});assert(await form.getByRole('button',{name:'Create schedule',exact:true}).isDisabled());
  await form.getByLabel('Cron expression',{exact:true}).fill('7 8 * * 1');await page.waitForFunction(()=>!document.querySelector('.sc-editor button[type=submit]')?.disabled);
  await page.evaluate(()=>window.__scheduleActionFailure='create');await form.getByRole('button',{name:'Create schedule',exact:true}).click();await form.getByText('Fixture action refused',{exact:true}).waitFor();assert.equal(await form.getByLabel('Schedule name',{exact:true}).inputValue(),'Read the release notes');
  await page.evaluate(()=>{window.__scheduleActionFailure=null;window.__holdScheduleAction='create';});await form.getByRole('button',{name:'Create schedule',exact:true}).click();await page.waitForFunction(()=>typeof window.__releaseScheduleAction==='function');
  await go('Meta+Shift+H');await page.locator('.mission-room').waitFor();await go('Meta+8');assert(await form.getByRole('button',{name:'Creating…',exact:true}).isDisabled());
  await page.evaluate(()=>{window.__holdScheduleAction=null;window.__releaseScheduleAction();});await detail.getByRole('heading',{name:'Read the release notes',exact:true}).waitFor();assert.equal((await calls()).filter(call=>call[0]==='create').length,2);
  await detail.getByRole('button',{name:'Delete…',exact:true}).click();await detail.getByRole('button',{name:'Delete schedule',exact:true}).click();await page.waitForFunction(()=>!window.__schedules.some(row=>row.id==='new'));assert.deepEqual((await calls()).filter(call=>call[0]==='remove'),[['remove','new']]);
  record('The inline composer renders the cron preview response, retains failed and pending drafts, and saves only on explicit submission.');
  await choose('s4');await page.evaluate(()=>window.__historyFailure='s4');await detail.getByRole('button',{name:'Refresh history',exact:true}).click();await detail.getByText('Fixture history unavailable',{exact:true}).waitFor();await capture('history-error');
  await page.evaluate(()=>{window.__historyFailure=null;window.__scheduleReadFailure=true;});await view.getByRole('button',{name:'Refresh schedules',exact:true}).click();await view.getByText(/^Fixture schedule list unavailable/).waitFor();assert(await detail.getByRole('button',{name:'Pause',exact:true}).isDisabled());
  await page.evaluate(()=>{window.__scheduleReadFailure=false;});await view.getByRole('button',{name:'Refresh schedules',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.sc-wrap .sc-read-error'));
  await view.getByText('Scheduler settings',{exact:true}).click();await view.getByRole('button',{name:'Run anything due now',exact:true}).click();await view.getByText(/No new occurrences queued/).waitFor();await view.getByRole('button',{name:'Fire schedules while Wanigan is closed',exact:true}).click();await view.getByRole('button',{name:'Stop background scheduler',exact:true}).waitFor();await capture('scheduler-settings');
  await view.getByText('Scheduler settings',{exact:true}).click();await choose('s2');
  record('History and list failures have explicit recovery; stale records disable mutations. Scheduler ticks and background setup occur only on their named actions.');
  for(const width of [960,720]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1000),width);await page.waitForFunction(width=>innerWidth===width,width);const size=await view.evaluate(el=>({width:innerWidth,client:el.clientWidth,scroll:el.scrollWidth}));dimensions.push(size);assert(size.scroll<=size.client+1);await capture('agenda-'+width);}
  await page.evaluate(()=>{document.documentElement.dataset.motion='off';});assert.equal(await detail.locator('.sc-reading').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000));await page.waitForFunction(()=>innerWidth===1440);
  await page.evaluate(()=>{window.__schedules=[];});await view.getByRole('button',{name:'Refresh schedules',exact:true}).click();await view.getByRole('heading',{name:'Give the work a rhythm.',exact:true}).waitFor();await capture('empty');
  await page.evaluate(()=>window.__scheduleReadFailure=true);await view.getByRole('button',{name:'Refresh schedules',exact:true}).click();await view.getByRole('heading',{name:'Schedule details unavailable',exact:true}).waitFor();assert.equal(await view.getByRole('heading',{name:'Give the work a rhythm.',exact:true}).count(),0);await capture('read-error');
  record('Both themes fit 960/720 windows, reduced motion disables the reader reveal, and confirmed emptiness has its own creation path.');
 }
 assert.deepEqual(errors,[]);rmSync(path.join(out,'failure.png'),{force:true});writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),checks,errors,dimensions,provenance:'Actual renderer with synthetic schedules; no real scheduler tick, agent launch, provider call or daemon change'},null,2)+'\n');
}catch(error){await (await app.firstWindow()).screenshot({path:path.join(out,'failure.png'),scale:'css'}).catch(()=>{});throw error;}
finally{await app.close();rmSync(dir,{recursive:true,force:true});}
