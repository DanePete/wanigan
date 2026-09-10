#!/usr/bin/env node
// Real main/preload + native visibility in a fresh profile. No model/session launch.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {launchWanigan} from './electron-harness.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-presence-real-'));
const out=path.resolve(root,process.argv[2]??'docs/visuals/companion-presence/real');mkdirSync(out,{recursive:true});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const {app,page}=await launchWanigan(_electron,{root,userData:dir,env});
const errors=[],measurements=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try{
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(1440,900);window.show();});
  await page.waitForSelector('.mission-room');
  await page.keyboard.press('Meta+2');
  await page.waitForFunction(()=>document.querySelector('.companion-presence .wanigan-orb')?.dataset.physics==='ready');
  await page.waitForFunction(()=>document.querySelector('.companion-presence')?.getAttribute('data-signal')==='quiet');
  const canvas=page.locator('.companion-presence canvas');
  await page.evaluate(()=>{document.documentElement.dataset.motion='full';});
  for(const theme of ['dark','light']){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    await page.waitForTimeout(450);
    await page.screenshot({path:path.join(out,'fleet-'+theme+'.png')});
  }
  const start=Number(await canvas.getAttribute('data-frames'));
  const at=Date.now();await page.waitForTimeout(2000);
  const frames=Number(await canvas.getAttribute('data-frames'))-start;
  const seconds=(Date.now()-at)/1000;
  console.log('Idle cadence',{frames,seconds,framesPerSecond:frames/seconds});
  assert.ok(frames>0&&frames/seconds<=20,'small companion has a bounded idle rendering rate');
  measurements.push({frames,seconds,framesPerSecond:frames/seconds,canvas:await canvas.evaluate(el=>({width:el.width,height:el.height,cssWidth:el.clientWidth}))});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  // requestAnimationFrame polling stops with a hidden window; inspect IPC with
  // timer polling so the assertion does not depend on the animation it pauses.
  console.log('Native hide:',await page.evaluate(async()=>({documentHidden:document.hidden,nativeVisible:await window.wanigan.windowVisibility.current(),canvas:document.querySelector('.companion-presence canvas')?.dataset.nativeVisibility})));
  await page.waitForFunction(()=>document.querySelector('.companion-presence canvas')?.dataset.nativeVisibility==='hidden',null,{polling:100});
  await page.waitForTimeout(250);
  const paused=await canvas.getAttribute('data-submissions');await page.waitForTimeout(750);
  assert.equal(await canvas.getAttribute('data-submissions'),paused,'hidden native window stops GPU submissions');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  await page.waitForFunction(prior=>document.querySelector('.companion-presence canvas')?.dataset.submissions!==prior,paused);
  await page.evaluate(()=>{document.documentElement.dataset.motion='off';});
  await page.waitForTimeout(300);
  const stopped=await canvas.getAttribute('data-submissions');await page.waitForTimeout(500);
  assert.equal(await canvas.getAttribute('data-submissions'),stopped);
  await page.locator('.companion-presence button').click();await page.waitForSelector('.mission-room');
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
  assert.equal(await page.locator('.wanigan-orb').count(),1);
  assert.equal(await page.evaluate(async()=> (await window.wanigan.sessions.list()).length),0);
  assert.equal(await page.evaluate(async()=> (await window.wanigan.companion.history(null)).length),0);
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({capturedAt:new Date().toISOString(),
    provenance:'Actual main process, preload and GPU using the isolated test bootstrap; fresh empty profile; no model/session launch',
    checks:['quiet state from real IPC','native hide stops GPU submissions; show resumes','motion off freezes rendering','small companion opens Mission room','only one orb mounted','no session or conversation created'],measurements,errors},null,2)+'\n');
  console.log('Real companion presence checks passed.');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
