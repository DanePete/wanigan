#!/usr/bin/env node
/** Actual Electron renderer and GPU, explicitly synthetic bridge data. Verifies
 * UI interactions only. Main/IPC contracts belong to npm test and shots.mjs. */
import {STUB,rendererURL} from './renderer-harness.mjs';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const require=createRequire(import.meta.url);
const {_electron}=require('playwright-core');const out=path.resolve(root,process.argv[2]??'docs/visuals/mission-room/after');
const compactOnly=process.argv.includes('--compact-only');
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-mission-ui-'));mkdirSync(out,{recursive:true});
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,titleBarStyle:'hiddenInset',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const binary=process.platform==='darwin'?'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron':'node_modules/electron/dist/electron';
const app=await _electron.launch({executablePath:path.join(root,binary),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(STUB);
 const selectSpace=async name=>{await page.getByRole('button',{name:/Switch project space/}).click();const input=page.getByRole('combobox',{name:'Search project spaces',exact:true});await input.fill(name);await page.keyboard.press('Enter');};
 const views=[['mission','Meta+Shift+H'],['sessions','Meta+1'],['fleet','Meta+2'],['control','Meta+3'],['batches','Meta+4'],['insights','Meta+5'],['learning','Meta+6'],['plugins','Meta+7'],['schedules','Meta+8'],['git','Meta+9'],['runs','Meta+0'],['settings','Meta+,'],['skills','Meta+Shift+S'],['context','Meta+Shift+C'],['scout','Meta+Shift+I'],['usage','Meta+Shift+U'],['board','Meta+Shift+B']];
 for(const theme of compactOnly?[]:['dark','light']){
  const themeOut=path.join(out,theme);mkdirSync(themeOut,{recursive:true});
  await page.goto(rendererURL);await page.waitForSelector('.mission-room');
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics!=='loading');
  assert.equal(await page.locator('.wanigan-orb').getAttribute('data-physics'),'ready');
  await page.waitForTimeout(600);
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.motion='off';window.dispatchEvent(new CustomEvent('wanigan:theme-changed',{detail:{preference:theme,resolved:theme}}));},theme);
  await page.waitForTimeout(150);
  const count=await page.locator('.wanigan-orb canvas').getAttribute('data-frames');await page.waitForTimeout(300);
  assert.equal(await page.locator('.wanigan-orb canvas').getAttribute('data-frames'),count,'motion off must stop the loop');
  // Native hide/show is verified through the real bridge by scripts/shots.mjs.
  await page.screenshot({path:path.join(themeOut,'mission.png')});
  // A project pick narrows the briefing and the active session together.
  await selectSpace('storefront');
  await page.waitForFunction(()=>document.querySelectorAll('.mission-space').length===1);
  assert.equal(await page.locator('.mission-space-title button').innerText(),'storefront');
  await page.keyboard.press('Meta+1');await page.waitForSelector('.sessions-view');await page.waitForTimeout(300);
  assert((await page.locator('.session-toolbar').innerText()).includes('storefront'));
  assert(!(await page.locator('.session-toolbar').innerText()).includes('platform'));
  await selectSpace('platform');
  await page.waitForTimeout(250);
  await page.getByRole('navigation',{name:'Projects views'}).getByRole('button',{name:'Changes',exact:true}).click();await page.waitForTimeout(300);
  assert.equal(await page.getByRole('combobox',{name:'Repository',exact:true}).inputValue(),'p2');
  await page.keyboard.press('Meta+Shift+C');await page.waitForTimeout(300);
  assert.equal(await page.getByRole('combobox',{name:'Context project',exact:true}).inputValue(),'p2');
  await selectSpace('All spaces');
  for(const [name,chord] of views){
   await page.getByRole('button',{name:'All destinations',exact:true}).focus();await page.keyboard.press(chord);await page.waitForTimeout(420);
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.motion='off';},theme);
   await page.waitForTimeout(80);await page.screenshot({path:path.join(themeOut,name+'.png')});
   assert(!(await page.locator('body').innerText()).includes('This view hit an error'),'view error: '+name);
  }
  await page.getByRole('button',{name:'All destinations',exact:true}).focus();await page.keyboard.press('Meta+K');await page.waitForTimeout(200);await page.screenshot({path:path.join(themeOut,'overlay-palette.png')});await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+T');await page.waitForTimeout(300);await page.screenshot({path:path.join(themeOut,'overlay-new-session.png')});await page.keyboard.press('Escape');
  console.log('Captured',theme);
 }
 if(compactOnly){
  await page.goto(rendererURL);await page.waitForSelector('.mission-room');
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(720,850));
 await page.getByRole('button',{name:'Mission room',exact:true}).click();await page.waitForSelector('.mission-room');await page.waitForTimeout(800);
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.motion='off';window.dispatchEvent(new CustomEvent('wanigan:theme-changed',{detail:{preference:theme,resolved:theme}}));},theme);
  await page.waitForTimeout(300);
  await page.screenshot({path:path.join(out,`mission-720-${theme}.png`)});
  assert.equal(await page.locator('.mission-room').count(),1,'compact capture is Mission room, not a shortcut consumed by a terminal');
  await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
  assert(await page.locator('#wanigan-personality').evaluate(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'compact companion controls fit in the viewport');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#wanigan-personality').isVisible(),false);
 }
 assert.equal(await page.getByRole('button',{name:'Mission room',exact:true}).count(),1,'compact dock keeps its accessible label');
 assert.deepEqual(errors,[]);
 writeFileSync(path.join(out,compactOnly?'compact-verification.json':'verification.json'),JSON.stringify({fixture:true,electron:true,gpu:true,themes:['dark','light'],views:compactOnly?['mission']:views.map(v=>v[0]),checks:compactOnly?['compact-dock-labels','compact-mission-destination','compact-popover-bounds']:['motion-off','project-scope','git-scope','context-scope','compact-dock-labels','compact-mission-destination','compact-popover-bounds'],errors},null,2)+'\n');
 console.log('Mission room renderer checks passed');
}catch(error){
 const page=await app.firstWindow();await page.screenshot({path:path.join(out,'failure.png')});
 console.log(JSON.stringify({error:String(error),errors,title:await page.title(),body:(await page.locator('body').innerText()).slice(0,7000)}));
 throw error;
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
