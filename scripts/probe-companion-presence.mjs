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
const out=path.join(root,'docs/visuals/companion-presence',before?'before':'after');
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-presence-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,titleBarStyle:'hiddenInset',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const errors=[],checks=[];
try{
  const page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.addInitScript(STUB);
  await page.addInitScript(()=>{
    const original=window.wanigan;
    let state=null,fail=false;const eventListeners=new Set(),fixtureSince=Date.now()-120000;
    window.__presenceCalls=0;
    window.wanigan=new Proxy(original,{get(target,key){
      if(key==='attention')return {list:async()=>{if(fail)throw new Error('Fixture status read failed');return state??await original.attention.list();}};
      if(key==='on')return new Proxy(original.on,{get(events,event){
        if(event==='sessionEvent')return callback=>{eventListeners.add(callback);return ()=>eventListeners.delete(callback);};
        return events[event];
      }});
      if(key==='companion')return new Proxy(original.companion,{get(companion,method){
        if(method==='ask')return (...args)=>{window.__presenceCalls++;return companion.ask(...args);};
        return companion[method];
      }});
      return target[key];
    }});
    window.__setPresence=async kind=>{
      const sessions=await original.sessions.list();
      fail=kind==='unavailable';
      state=kind==='quiet'?[]:[{sessionId:sessions[0].id,kind,since:fixtureSince,transitionId:'fixture-'+kind,
        label:kind==='finished'?'Turn finished':kind==='permission'?'Permission needed':kind==='error'?'Error':'Working',detail:null,tool:null}];
      for(const callback of eventListeners)callback({id:123,sessionId:sessions[0].id,at:Date.now(),
        event:kind==='finished'?'Stop':'Notification',toolName:null,summary:null,durationMs:null,ok:null,paths:[]});
    };
  });
  const views=[['sessions','Meta+1'],['fleet','Meta+2'],['control','Meta+3'],['settings','Meta+,']];
  for(const theme of ['dark','light']){
    mkdirSync(path.join(out,theme),{recursive:true});
    await page.goto(rendererURL);await page.waitForSelector('.mission-room');
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.motion='full';},theme);
    await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
    for(const [name,chord] of views){
      await page.locator('.space-dock button').first().focus();
      await page.keyboard.press(chord);
      await page.waitForSelector(name==='sessions'?'.session-main':'.pane:not(.mission-room)');
      if(!before){
        await page.waitForFunction(()=>document.querySelector('.companion-presence .wanigan-orb')?.dataset.physics==='ready');
        assert.equal(await page.locator('.wanigan-orb').count(),1);
      }
      await page.waitForTimeout(650);
      await page.screenshot({path:path.join(out,theme,name+'.png')});
      console.log(`${theme}/${name}`);
    }
    if(before)continue;
    for(const signal of ['permission','error','finished','working','quiet','unavailable']){
      await page.evaluate(signal=>window.__setPresence(signal),signal);
      await page.waitForFunction(signal=>document.querySelector('.companion-presence')?.getAttribute('data-signal')===signal,signal);
      await page.waitForTimeout(1000);
      await page.locator('.companion-presence').screenshot({path:path.join(out,theme,signal+'.png')});
    }
    await page.evaluate(()=>window.__setPresence('permission'));
    await page.waitForFunction(()=>document.querySelector('.companion-presence')?.getAttribute('data-signal')==='permission');
    const trigger=page.locator('.companion-presence button');
    await trigger.click();
    const dialog=page.getByRole('dialog',{name:'Sessions that need you'});
    await dialog.waitFor();
    const box=await dialog.boundingBox();
    assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=1440&&box.y+box.height<=900);
    await page.screenshot({path:path.join(out,theme,'attention-open.png')});
    await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>{window.__presenceCanvas=document.querySelector('.companion-presence canvas');});
    await page.keyboard.press('Meta+2');
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(()=>window.__presenceCanvas===document.querySelector('.companion-presence canvas')),true);
    for(const chord of ['Meta+4','Meta+5','Meta+6','Meta+7','Meta+8','Meta+9','Meta+0','Meta+Shift+S','Meta+Shift+C','Meta+Shift+I','Meta+Shift+U','Meta+Shift+B']){
      await page.locator('.space-dock button').first().focus();await page.keyboard.press(chord);await page.waitForTimeout(150);
      assert.equal(await page.evaluate(()=>window.__presenceCanvas===document.querySelector('.companion-presence canvas')),true,chord+' keeps the same character');
      assert.equal(await page.locator('.wanigan-orb').count(),1);
      assert.equal((await page.locator('body').innerText()).includes('This view hit an error'),false,chord+' has no error boundary');
    }
    await page.evaluate(()=>{document.documentElement.dataset.motion='off';});
    await page.waitForTimeout(400);
    const frames=await page.locator('.companion-presence canvas').getAttribute('data-frames');
    await page.waitForTimeout(450);assert.equal(await page.locator('.companion-presence canvas').getAttribute('data-frames'),frames);
    await page.evaluate(()=>window.__setPresence('finished'));
    await page.waitForFunction(()=>document.querySelector('.companion-presence')?.getAttribute('data-signal')==='finished');
    await page.waitForTimeout(250);
    const stopped=await page.locator('.companion-presence canvas').getAttribute('data-frames');
    await page.waitForTimeout(350);assert.equal(await page.locator('.companion-presence canvas').getAttribute('data-frames'),stopped);
    await page.evaluate(()=>window.__setPresence('quiet'));
    await page.waitForFunction(()=>document.querySelector('.companion-presence')?.getAttribute('data-signal')==='quiet');
    await trigger.click();await page.waitForSelector('.mission-room');
    assert.equal(await page.locator('.companion-presence').count(),0);assert.equal(await page.locator('.wanigan-orb').count(),1);
    checks.push(theme+': status colors and labels, bounded attention dialog, Escape/focus, same canvas across all 16 other destinations, motion off, quiet opens Mission, one orb');
  }
  if(!before){
    await page.keyboard.press('Meta+2');
    await page.waitForSelector('.companion-presence');
    for(const width of [960,720]){
      await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,850),width);
      await page.evaluate(()=>window.__setPresence('permission'));
      await page.waitForFunction(()=>document.querySelector('.companion-presence')?.getAttribute('data-signal')==='permission');
      await page.waitForTimeout(500);
      const bounds=await page.locator('.companion-presence').boundingBox();
      assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
      await page.locator('.companion-presence button').click();
      const box=await page.getByRole('dialog',{name:'Sessions that need you'}).boundingBox();
      assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=850);
      await page.screenshot({path:path.join(out,`compact-${width}.png`)});
      await page.keyboard.press('Escape');
    }
    assert.equal(await page.evaluate(()=>window.__presenceCalls),0);
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({capturedAt:new Date().toISOString(),provenance:'Actual Electron and GPU; synthetic bridge/session fixtures; no agent or model calls',checks,errors},null,2)+'\n');
  console.log(before?'Before screenshots captured.':'Companion presence checks passed.');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
