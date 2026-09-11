#!/usr/bin/env node
// Real Electron/GPU, synthetic session signals. Never touches the installed app.
import {STUB,rendererURL} from './renderer-harness.mjs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const before=process.argv.includes('--before');
const outputArg=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
const out=outputArg?path.resolve(root,outputArg):path.join(root,'docs/visuals/orb-signatures','ui');
mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-presence-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,titleBarStyle:'hiddenInset',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const errors=[],checks=[];
try{
 const page=await app.firstWindow();
 const archiveAt=process.argv.indexOf('--archive');
 if(archiveAt>=0){const asar=require('@electron/asar'),archive=process.argv[archiveAt+1];await page.route(rendererURL.replace('/index.html','/**'),route=>{const name='out/renderer'+new URL(route.request().url()).pathname;return route.fulfill({body:asar.extractFile(archive,name),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.hdr':'application/octet-stream','.svg':'image/svg+xml'})[path.extname(name)]??'application/octet-stream'});});}
 const shot=options=>page.screenshot({...options,scale:'css'});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const original=window.wanigan,listeners=new Set();let history=[],attention=[],sequence=0;
  window.__calls=0;window.__reading={kind:'ok',tokens:188000,window:200000,percent:94,model:'fixture',at:Date.now(),windowSource:'assumed-200k',conversationMatch:'exact'};
  window.__event=(event,id=++sequence,sessionId='s1')=>{for(const callback of listeners)callback({id,sessionId,event,at:Date.now(),ok:true,paths:[]});};
  window.__failSession=()=>{attention=[{sessionId:'s1',kind:'error',transitionId:'fixture-failure',since:Date.now()}];window.__event('StopFailure');};
  window.wanigan=new Proxy(original,{get(api,key){
   if(key==='on')return new Proxy(api.on,{get(events,key){if(key==='sessionEvent')return cb=>{listeners.add(cb);return ()=>listeners.delete(cb);};return events[key];}});
   if(key==='attention')return {list:async()=>attention};
   if(key==='transcripts')return new Proxy(api.transcripts,{get(service,key){return key==='context'?async id=>id==='s1'?structuredClone(window.__reading):{kind:'unsupported'}:service[key];}});
   if(key==='companion')return new Proxy(api.companion,{get(service,key){
    if(key==='history')return async()=>history;
    if(key==='ask')return args=>new Promise(resolve=>{window.__calls++;const id='fixture-'+window.__calls;history=[{id,status:'pending',question:args.question,at:Date.now(),model:'fixture',sources:[],costUsd:null}];
      window.__finish=status=>{const turn={...history[0],status,answer:status==='answered'?'Fixture response: the next request answered.':null,error:status==='failed'?'Fixture provider request failed':null};history=[turn];resolve(turn);};});
    return service[key];
   }});
   return api[key];
  }});
 });
 await page.goto(rendererURL);await page.waitForSelector('.mission-room');
 const canvas=page.locator('.mission-room .wanigan-orb canvas');
 await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
 const capture=async name=>{
  await page.evaluate(()=>document.documentElement.dataset.motion='off');
  for(const theme of ['dark','light']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);await page.screenshot({path:path.join(out,name+'-'+theme+'.png'),scale:'css'});}
  await page.evaluate(()=>document.documentElement.dataset.motion='full');
 };
 const appearance=()=>page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
 await appearance();await page.getByRole('button',{name:'Let the water float'}).click();
 await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.gravity)<1);
 assert.equal(await page.getByRole('button',{name:'Bring gravity back'}).getAttribute('aria-pressed'),'true');await capture('float-controls');
 await page.getByRole('button',{name:'Bring gravity back'}).click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.gravity)>9.5);
 checks.push('Float and restore drive solver gravity, expose a toggle state and make no provider call.');
 await page.getByRole('textbox',{name:'Talk to Wanigan'}).fill('What needs me?');
 await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.listeningRipples)>0);
 await page.getByRole('button',{name:'Send question to Wanigan',exact:true}).click();
 await page.waitForFunction(()=>!!window.__finish);await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.vortex)>.5);
 await page.evaluate(()=>window.__finish('failed'));
 await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.whirl)>.7);await page.waitForTimeout(1800);await capture('request-failure');
 await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.whirl)<.01);
 assert.equal(await canvas.getAttribute('data-alarm'),'true');assert.equal(await canvas.getAttribute('data-material'),'0');
 await page.getByRole('textbox',{name:'Talk to Wanigan'}).fill('Try another question');
 await page.getByRole('button',{name:'Send question to Wanigan',exact:true}).click();await page.waitForFunction(()=>window.__calls===2);
 await page.evaluate(()=>window.__finish('answered'));await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.recovery)>.7);await capture('request-recovery');
 checks.push('Typing disturbs water; an observed failure fires once and leaves an alarm; a later answered request gets a blue recovery.');
 await appearance();await page.getByRole('combobox',{name:'Session whose context Wanigan follows'}).selectOption('s1');
 await page.waitForFunction(()=>document.querySelector('.mission-temperament').textContent.includes('estimated window'));
 assert.equal(Number(await canvas.getAttribute('data-pressure')),0);
 await page.evaluate(()=>{window.__reading.windowSource='cli-reported';window.__reading.at=Date.now();});
 await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.pressure)>.85);await page.keyboard.press('Escape');await capture('context-crowding');
 await page.evaluate(()=>window.__event('PreCompact',20));await page.waitForFunction(()=>document.querySelector('.mission-room canvas').dataset.story==='gathering');
 await page.evaluate(()=>window.__event('PostCompact',21));await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.memories)===1);
 await page.evaluate(()=>window.__event('PostCompact',21));await page.waitForTimeout(300);assert.equal(Number(await canvas.getAttribute('data-memories')),1);
 await capture('compaction-keepsake');
 await appearance();await page.getByRole('combobox',{name:'Session whose context Wanigan follows'}).selectOption('s2');
 await page.waitForFunction(()=>document.querySelector('.mission-temperament').textContent.includes('isn’t supported'));
 await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.memories)===0);await page.keyboard.press('Escape');
 checks.push('Estimated windows stay quiet; reported fresh context crowds only the chosen session; hooks add one keepsake; scope changes clear it and unsupported telemetry stays explicit.');
 await page.locator('.space-dock button').first().focus();await page.keyboard.press('Meta+2');
 await page.waitForFunction(()=>document.querySelector('.companion-presence .wanigan-orb')?.dataset.physics==='ready');await page.waitForTimeout(300);
 await page.evaluate(()=>window.__failSession());await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas').dataset.whirl)>.7);await page.waitForTimeout(1800);await capture('mini-failure');
 await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas').dataset.whirl)<.01);
 await page.evaluate(()=>document.documentElement.dataset.motion='off');await page.waitForTimeout(300);
 const submissions=await page.locator('.companion-presence canvas').getAttribute('data-submissions');await page.waitForTimeout(350);
 assert.equal(await page.locator('.companion-presence canvas').getAttribute('data-submissions'),submissions);
 assert.equal(await page.evaluate(()=>window.__calls),2);
 checks.push('The miniature shares the fire scene; motion off freezes submissions; exactly two explicit fixture sends occurred.');
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,scope:'Synthetic preload in isolated Electron. No agent/provider calls, no installed profile.',at:new Date().toISOString()},null,2)+'\n');
 console.log('Signature UI checks passed:',checks.length);
}catch(error){console.error('Renderer errors:',errors);throw error;}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
