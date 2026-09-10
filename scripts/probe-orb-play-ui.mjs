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
const out=path.join(root,'docs/visuals/orb-play',before?'before':'after');
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-presence-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,titleBarStyle:'hiddenInset',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const errors=[],checks=[];
try{
 const page=await app.firstWindow();
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const original=window.wanigan;let history=[],state=null;const listeners=new Set();window.__askCalls=0;
  window.wanigan=new Proxy(original,{get(target,key){
   if(key==='on')return new Proxy(original.on,{get(events,event){if(event==='sessionEvent')return cb=>{listeners.add(cb);return ()=>listeners.delete(cb);};return events[event];}});
   if(key==='attention')return {list:async()=>state??await original.attention.list()};
   if(key==='companion')return new Proxy(original.companion,{get(companion,method){
    if(method==='history')return async()=>history;
    if(method==='ask')return args=>{window.__askCalls++;return new Promise(resolve=>{window.__finishAnswer=()=>{const turn={id:'fixture-answer',projectId:null,at:Date.now(),question:args.question,answer:'Fixture answer: your project overview.',status:'answered',model:'fixture',costUsd:0,sources:[]};history=[turn];resolve(turn);};});};
    return companion[method];
   }});
   return target[key];
  }});
  window.__finished=async transition=>{
   const sessions=await original.sessions.list();state=[{sessionId:sessions[0].id,kind:'finished',since:Date.now(),transitionId:transition,label:'Turn finished',detail:null,tool:null}];
   for(const listener of listeners)listener({id:1,sessionId:sessions[0].id,at:Date.now(),event:'Stop',toolName:null,summary:null,durationMs:null,ok:null,paths:[]});
  };
 });
 await page.goto(rendererURL);await page.waitForSelector('.mission-room');
 await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.motion='full';},theme);
  await page.waitForTimeout(600);
  await page.screenshot({path:path.join(out,'mission-'+theme+'.png')});
  await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
  await page.screenshot({path:path.join(out,'play-'+theme+'.png')});
  await page.keyboard.press('Escape');
 }
 if(!before){
  const canvas=page.locator('.wanigan-orb canvas');
  const menu=async()=>{await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();};
  await menu();await page.getByRole('button',{name:'Lava lamp',exact:true}).click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>Number(document.querySelector('.wanigan-orb canvas').dataset.lava)>.98);
  await page.waitForTimeout(6500);
  for(const theme of ['dark','light']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(100);
   await page.screenshot({path:path.join(out,'lava-'+theme+'.png')});
  }
  await menu();await page.getByRole('button',{name:'Water & mist',exact:true}).click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>Number(document.querySelector('.wanigan-orb canvas').dataset.lava)<.02);
  await menu();await page.getByRole('button',{name:'Little rainstorm',exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('.wanigan-orb canvas').dataset.weather)>.9);
  await page.waitForTimeout(2500);await page.screenshot({path:path.join(out,'rain-light.png')});
  await menu();await page.getByRole('button',{name:'Bubble burst',exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('.wanigan-orb canvas').dataset.bursts)>0);
  const bursts=Number(await canvas.getAttribute('data-bursts'));await page.waitForTimeout(1000);
  assert.equal(Number(await canvas.getAttribute('data-bursts')),bursts,'play action emits only once');
  const box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();
  await page.mouse.move(box.x+box.width+50,box.y+box.height*.7,{steps:12});
  assert.equal(await canvas.getAttribute('data-grabbed'),'true');await page.mouse.up();
  assert.equal(await canvas.getAttribute('data-grabbed'),'false','release works outside the vessel');
  assert.equal(await page.locator('.mission-room').count(),1);
  await page.getByRole('textbox',{name:'Talk to Wanigan'}).fill('Fixture: what needs me?');
  assert.equal(await page.evaluate(()=>window.__askCalls),0,'appearance and play make no model calls');
  await page.getByRole('button',{name:'Send question to Wanigan',exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('.wanigan-orb canvas').dataset.vortex)>.5);
  assert.equal(await page.evaluate(()=>window.__askCalls),1,'only an explicit send invokes the fixture companion');
  await page.screenshot({path:path.join(out,'thinking-light.png')});
  const beforeAnswer=Number(await canvas.getAttribute('data-bursts'));await page.evaluate(()=>window.__finishAnswer());
  await page.waitForFunction(n=>Number(document.querySelector('.wanigan-orb canvas').dataset.bursts)===n+1,beforeAnswer);
  await page.waitForFunction(()=>Number(document.querySelector('.wanigan-orb canvas').dataset.vortex)<.01);
  await page.waitForTimeout(500);assert.equal(Number(await canvas.getAttribute('data-bursts')),beforeAnswer+1);
  await menu();await page.getByRole('button',{name:'Lava lamp',exact:true}).click();await page.keyboard.press('Escape');
  await page.locator('.space-dock button').first().focus();await page.keyboard.press('Meta+2');
  await page.waitForFunction(()=>document.querySelector('.companion-presence .wanigan-orb')?.dataset.physics==='ready');
  const small=page.locator('.companion-presence canvas');assert.equal(Number(await small.getAttribute('data-lava')),1,'small companion retains the same material');
  await page.waitForTimeout(300);const smallBox=await small.boundingBox();console.log('Small hit',await page.evaluate(box=>({box,hit:document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.outerHTML.slice(0,250),motion:document.documentElement.dataset.motion}),smallBox));await page.mouse.move(smallBox.x+smallBox.width/2,smallBox.y+smallBox.height/2);await page.mouse.down();
  await page.mouse.move(smallBox.x+100,smallBox.y-30,{steps:10});await page.mouse.up();
  assert.equal(await page.locator('.mission-room').count(),0,'dragging the small companion does not navigate');
  console.log('Small released',await small.evaluate(c=>({...c.dataset})));assert.equal(await small.getAttribute('data-grabbed'),'false');
  await page.locator('.companion-presence button').focus();await page.keyboard.press('r');
  await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas').dataset.weather)>.1);
  await page.evaluate(()=>window.__finished('fixture-finish-1'));
  await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas').dataset.bursts)>0);
  const finished=Number(await small.getAttribute('data-bursts'));
  await page.evaluate(()=>window.__finished('fixture-finish-1'));await page.waitForTimeout(700);
  assert.equal(Number(await small.getAttribute('data-bursts')),finished,'a repeated session event cannot replay the celebration');
  await page.evaluate(()=>{document.documentElement.dataset.motion='off';});await page.waitForTimeout(400);
  const frozen=await small.getAttribute('data-submissions');
  await page.keyboard.press('b');await page.waitForTimeout(400);assert.equal(await small.getAttribute('data-submissions'),frozen);
  await page.evaluate(()=>window.__finished('fixture-finish-2'));await page.waitForTimeout(600);
  await page.evaluate(()=>{document.documentElement.dataset.motion='full';});await page.waitForTimeout(600);
  assert.equal(Number(await small.getAttribute('data-bursts')),finished,'frozen session events do not replay on resume');
  for(const theme of ['dark','light']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);
   await page.screenshot({path:path.join(out,'fleet-'+theme+'.png')});
  }
  checks.push('Shared lava material','Play controls','Captured drag/release at both sizes','Pending request vortex','Exactly one answer burst','No replayed session events','Motion off','No automatic model calls');
 }
 assert.deepEqual(errors,[]);
 writeFileSync(path.join(out,'ui-verification.json'),JSON.stringify({recordedAt:new Date().toISOString(),errors,checks,scope:'Isolated Electron GPU, synthetic project fixtures'},null,2)+'\n');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
