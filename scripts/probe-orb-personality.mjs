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
const out=outputArg?path.resolve(root,outputArg):path.join(root,'docs/visuals/orb-personality',before?'before':'after');
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
  const original=window.wanigan;let history=[],state=null;const listeners=new Set();window.__askCalls=0;
  window.wanigan=new Proxy(original,{get(target,key){
   if(key==='preflight')return {read:async()=>({agents:[{id:'claude',label:'Claude Code',harnessId:'claude-code',found:true,path:'/example/bin/claude',version:'fixture',signedIn:'yes',credential:'harness-login'}],searched:[],projects:2,sessionsStarted:2})};
   if(key==='on')return new Proxy(original.on,{get(events,event){if(event==='sessionEvent')return cb=>{listeners.add(cb);return ()=>listeners.delete(cb);};return events[event];}});
   if(key==='attention')return {list:async()=>state??await original.attention.list()};
   if(key==='companion')return new Proxy(original.companion,{get(companion,method){
    if(method==='history')return async()=>history;
    if(method==='ask')return args=>{window.__askCalls++;return new Promise(resolve=>{window.__finishAnswer=()=>{const turn={id:'fixture-answer',projectId:null,at:Date.now(),question:args.question,answer:'Fixture answer: your project overview.',status:'answered',model:'fixture',costUsd:0,sources:[]};history=[turn];resolve(turn);};});};
    return companion[method];
   }});
   return target[key];
  }});
  window.__signal=async(kind,transition)=>{
   const sessions=await original.sessions.list();state=kind?[{sessionId:sessions[0].id,kind,since:Date.now(),transitionId:transition,label:kind,detail:null,tool:null}]:[];
   for(const listener of listeners)listener({id:1,sessionId:sessions[0].id,at:Date.now(),event:'Stop',toolName:null,summary:null,durationMs:null,ok:null,paths:[]});
  };
 });
 await page.goto(rendererURL);await page.waitForSelector('.mission-room');
 await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.motion='full';},theme);
  await page.waitForTimeout(600);
  await shot({path:path.join(out,'mission-'+theme+'.png')});
  await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
  await shot({path:path.join(out,'play-'+theme+'.png')});
  await page.keyboard.press('Escape');
 }
 if(before){
  await page.locator('.space-dock button').first().focus();await page.keyboard.press('Meta+2');
  await page.waitForFunction(()=>document.querySelector('.companion-presence .wanigan-orb')?.dataset.physics==='ready');
  for(const theme of ['dark','light']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);await shot({path:path.join(out,`fleet-${theme}.png`)});}
 }
 if(!before){
  const canvas=page.locator('.mission-room .wanigan-orb canvas');
  const gesture=async(selector,value)=>page.waitForFunction(({selector,value})=>document.querySelector(selector)?.dataset.gesture===value,{selector,value});
  const hero='.mission-room .wanigan-orb canvas',mini='.companion-presence .wanigan-orb canvas';
  const capture=async(name,selector=hero)=>{
   await page.evaluate(()=>document.documentElement.dataset.motion='off');
   for(const theme of ['dark','light']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(150);
    await shot({path:path.join(out,`${name}-${theme}.png`)});
    await page.locator(selector).screenshot({path:path.join(out,`${name}-detail-${theme}.png`),scale:'css'});
   }
   await page.evaluate(()=>document.documentElement.dataset.motion='full');
  };
  await page.getByRole('button',{name:'Give Wanigan a nudge',exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.wink)>.7);
  assert.equal(await canvas.getAttribute('data-gesture'),'playful');await capture('wink');
  await gesture(hero,'rest');
  const question=page.getByRole('textbox',{name:'Talk to Wanigan'});
  await question.fill('What needs me?');await gesture(hero,'listening');
  await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.roll)>.06);
  assert.match(await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).innerText(),/You have my attention/);
  assert.equal(await page.evaluate(()=>window.__askCalls),0);await capture('listening');
  checks.push('Play produces a visible wink and tilt; conversation takes priority; all gestures so far made zero model calls.');

  await page.getByRole('button',{name:'Send question to Wanigan',exact:true}).click();await gesture(hero,'thinking');
  assert.equal(await page.evaluate(()=>window.__askCalls),1);await capture('thinking');
  const beforeAnswer=Number(await canvas.getAttribute('data-bursts'));await page.evaluate(()=>window.__finishAnswer());
  await gesture(hero,'pleased');await page.waitForFunction(n=>Number(document.querySelector('.mission-room canvas').dataset.bursts)===n+1,beforeAnswer);
  await page.waitForTimeout(250);await capture('answer');
  await page.waitForTimeout(2600);assert.equal(Number(await canvas.getAttribute('data-bursts')),beforeAnswer+1);
  checks.push('Only explicit Send calls the fixture; answering acknowledges once and preserves the existing bounded waiting behavior.');

  await page.evaluate(()=>window.__signal('permission','notice-one'));await gesture(hero,'notice');
  await page.waitForFunction(()=>Number(document.querySelector('.mission-room canvas').dataset.surprise)>.55);await capture('attention');
  await page.waitForTimeout(2600);const bursts=Number(await canvas.getAttribute('data-bursts'));
  await page.evaluate(()=>window.__signal('permission','notice-one'));await page.waitForTimeout(700);
  assert.notEqual(await canvas.getAttribute('data-gesture'),'notice');assert.equal(Number(await canvas.getAttribute('data-bursts')),bursts);
  checks.push('A fresh permission request gets a double-take; a repeated poll does not replay it or celebrate.');

  await page.locator('.space-dock button').first().focus();await page.keyboard.press('Meta+2');
  await page.waitForFunction(()=>document.querySelector('.companion-presence .wanigan-orb')?.dataset.physics==='ready');
  const small=page.locator(mini);await page.waitForTimeout(500);assert.equal(Number(await small.getAttribute('data-bursts')),0);await capture('fleet',mini);
  await page.evaluate(()=>window.__signal('finished','finish-one'));await gesture(mini,'pleased');
  await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas').dataset.bursts)===1);
  await capture('mini-finished',mini);await page.waitForTimeout(2700);
  await page.evaluate(()=>window.__signal('finished','finish-one'));await page.waitForTimeout(700);assert.equal(Number(await small.getAttribute('data-bursts')),1);
  await page.locator('.companion-presence button').focus();await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas').dataset.wink)>.7);await capture('mini-wink',mini);
  assert.equal(await page.locator('.mission-room').count(),0);
  checks.push('The miniature shares completion and play expressions; navigation establishes a baseline and repeated completions stay quiet.');

  await page.waitForTimeout(2500);await page.evaluate(()=>document.documentElement.dataset.motion='off');await page.waitForTimeout(400);
  const frozen=await small.getAttribute('data-submissions');await page.keyboard.press('ArrowLeft');await page.waitForTimeout(400);
  assert.equal(await small.getAttribute('data-submissions'),frozen);
  await page.evaluate(()=>window.__signal('finished','finish-while-paused'));await page.waitForTimeout(600);
  await page.evaluate(()=>document.documentElement.dataset.motion='full');await page.waitForTimeout(700);
  assert.equal(Number(await small.getAttribute('data-bursts')),1);
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>document.documentElement.dataset.motion='auto');await page.waitForTimeout(400);
  const reduced=await small.getAttribute('data-submissions');await page.waitForTimeout(400);assert.equal(await small.getAttribute('data-submissions'),reduced);
  assert.equal(await page.evaluate(()=>window.__askCalls),1);
  checks.push('Off freezes motion, Auto respects reduced motion, paused events do not replay, and incidental interactions never send a question.');
 }
 assert.deepEqual(errors,[]);
 writeFileSync(path.join(out,'ui-verification.json'),JSON.stringify({recordedAt:new Date().toISOString(),errors,checks,scope:'Isolated Electron GPU, synthetic project fixtures; one explicit fixture answer, zero real model calls'},null,2)+'\n');
 console.log('Personality UI checks passed:',checks.length);
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
