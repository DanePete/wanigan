#!/usr/bin/env node
// Actual renderer, synthetic usage and conversation fixtures, no provider calls.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/companion-usage', before ? 'before' : 'after');
mkdirSync(out, { recursive:true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-companion-usage-ui-'));
writeFileSync(path.join(dir,'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank')});`);
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if(key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const errors = [];
try {
  const page = await app.firstWindow(); page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(STUB);
  await page.addInitScript(({before})=>{
    const original=window.wanigan;
    const turn={id:'usage-fixture',question:'What is our Claude Work usage?',answer:before
      ?'This overview has no usage metrics.'
      :'Work has used 37% of its Claude session window. Wanigan recorded 12,000 input and 900 output tokens over the last 14 days; cost was not reported.',
      sources:before?[]:[{id:'usage:overview',kind:'usage',targetId:'usage',projectId:null,label:'Usage & limits'}],
      model:'claude-sonnet-5',at:Date.now(),status:'answered',error:null,inputTokens:100,outputTokens:25,costUsd:null};
    const overrides={
      companion:{history:async()=>[turn]},
      usage:{snapshot:async()=>({days:14,limits:[],daily:[],consumption:[]})},
    };
    window.wanigan=new Proxy(original,{get(target,key){if(!(key in overrides))return target[key];return new Proxy(target[key],{get(service,method){return overrides[key][method]??service[method]}})}});
  },{before});
  await page.goto(rendererURL); await page.waitForSelector('.mission-room');
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
  await page.evaluate(()=>document.documentElement.dataset.motion='off');
  await page.getByText('What I can see',{exact:true}).click();
  for(const theme of ['dark','light']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.screenshot({path:path.join(out,`mission-${theme}.png`),scale:'css'});
  }
  if(!before) {
    assert.match(await page.locator('.mission-connection details').innerText(),/account limits.*14 days/i);
    await page.getByRole('button',{name:'Usage & limits',exact:true}).click();
    await page.getByRole('heading',{name:'Usage',exact:true}).waitFor();
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Electron renderer with synthetic conversation and usage; no API calls',checks:before?['before screenshots in both themes']:['usage disclosure matches context','usage citation opens Usage','screenshots in both themes'],errors},null,2)+'\n');
  console.log('Companion usage renderer checks passed.');
} finally {await app.close();rmSync(dir,{recursive:true,force:true});}
