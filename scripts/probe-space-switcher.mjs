#!/usr/bin/env node
// Real Electron/GPU, synthetic session signals. Never touches the installed app.
import {STUB,rendererURL} from './renderer-harness.mjs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const before=process.argv.includes('--before');
const outputArg=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
const out=outputArg?path.resolve(root,outputArg):path.join(root,'docs/visuals/space-switcher',before?'before':'after');
mkdirSync(out,{recursive:true});
// Which renderer this run actually drew, recorded rather than asserted. The
// harness serves out/renderer off disk; --archive routes those same paths out
// of a packaged asar instead. Both runs are "Electron with a synthetic bridge"
// and produce screenshots that look identical, so without these hashes the
// verification file cannot say which build it is evidence of — and a file that
// cannot tell them apart is a claim rather than a measurement. It was one:
// archiveSha256, rendererSha256 and source sat in committed JSON that no code
// here ever wrote, so the next honest run silently dropped all three.
const archiveAt=process.argv.indexOf('--archive');
const archive=archiveAt>=0?path.resolve(process.argv[archiveAt+1]):null;
const rendererFile=rel=>archive?require('@electron/asar').extractFile(archive,'out/renderer/'+rel):readFileSync(path.join(root,'out/renderer',rel));
const sha256=buf=>createHash('sha256').update(buf).digest('hex');
const provenance=()=>{const entry=String(rendererFile('index.html')).match(/src="\.?\/?(assets\/[^"]+\.js)"/)?.[1]??null;
 return {source:archive?`packaged renderer from ${path.basename(archive)}, isolated synthetic bridge`:'local out/renderer build, isolated synthetic bridge',
  ...(archive?{archiveSha256:sha256(readFileSync(archive))}:{}),rendererEntry:entry,rendererSha256:entry?sha256(rendererFile(entry)):null};};
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-presence-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,titleBarStyle:'hiddenInset',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const errors=[],checks=[];
try{
 const page=await app.firstWindow();
 if(archive){const asar=require('@electron/asar');await page.route(rendererURL.replace('/index.html','/**'),route=>{const name='out/renderer'+new URL(route.request().url()).pathname;return route.fulfill({body:asar.extractFile(archive,name),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.hdr':'application/octet-stream','.svg':'image/svg+xml'})[path.extname(name)]??'application/octet-stream'});});}
  page.on('pageerror',error=>errors.push(error.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const api=window.wanigan;
  const names=['storefront','platform','Billing and reconciliation services','Authentication','Customer experience','Data warehouse','Design system','Developer tools','Docs','Edge gateway','Fulfilment','Inventory','Marketing website','Mobile apps','Observability','Payments','Research','Search','Support tools','Warehouse operations'];
  const projects=localStorage.getItem('space-fixture-size')==='0'?[]:localStorage.getItem('space-fixture-size')==='80'?Array.from({length:80},(_,i)=>({id:'p'+(i+1),name:i===79?'The last project with a very long descriptive name':'Project '+String(i+1).padStart(2,'0'),path:'/example/repo-'+i,branch:'main',createdAt:Date.now()})):names.map((name,i)=>({id:'p'+(i+1),name,path:'/example/'+(i===18?'customer-support':name.toLowerCase().replaceAll(' ','-')),branch:i%2?'main':'feature/desktop',createdAt:Date.now()}));
  window.__projectRows=projects;window.__adds=0;
  window.wanigan=new Proxy(api,{get(target,key){
   if(key==='preflight')return {read:async()=>({agents:[{id:'fixture',label:'Example agent',harnessId:null,found:true,path:'/example/bin/agent',version:null,signedIn:'unknown',credential:'harness-login'}],searched:[],projects:projects.length,sessionsStarted:3})};
   if(key==='projects')return new Proxy(api.projects,{get(service,method){if(method==='list')return async()=>window.__projectRows;if(method==='pick')return async()=>{window.__adds++;return null;};return service[method];}});
   if(key==='companion')return new Proxy(api.companion,{get(service,method){if(method==='snapshot')return async scope=>{const old=await service.snapshot(scope);return {...old,totalProjects:projects.length,projects:scope?projects.filter(p=>p.id===scope).map(p=>({...p,running:0,needsYou:0,sessions:[]})):projects.map(p=>({...p,running:0,needsYou:0,sessions:[]}))};};return service[method];}});
   return target[key];
  }});
 });
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
 await page.waitForFunction(()=>document.querySelector('.project-spaces')?.textContent.includes('All spaces'));
 await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
 await page.waitForTimeout(800);
 await page.evaluate(()=>document.documentElement.dataset.motion='off');
 const capture=async name=>{for(const theme of ['dark','light']){await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.dataset.motion='off';window.dispatchEvent(new CustomEvent('wanigan:theme-changed',{detail:{preference:t,resolved:t}}));},theme);await page.waitForTimeout(120);await page.screenshot({path:path.join(out,name+'-'+theme+'.png'),scale:'css'});}};
 await capture('header-20');
 if(before){
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(960,850));await capture('header-960');
 }else{
  const trigger=page.getByRole('button',{name:/Switch project space/});
  const open=async()=>{await trigger.click();await page.getByRole('dialog',{name:'Switch project space',exact:true}).waitFor();};
  const options=()=>page.getByRole('listbox',{name:'Project spaces',exact:true}).getByRole('option');
  const search=()=>page.getByRole('combobox',{name:'Search project spaces',exact:true});
  const headerWidth=await page.locator('.project-spaces').evaluate(el=>el.getBoundingClientRect().width);
  assert.equal(await page.locator('.project-spaces button').count(),1,'one switcher replaces every project tab');
  await open();assert.equal(await search().evaluate(el=>el===document.activeElement),true);await capture('switcher-20');
  await search().fill('customer-support');assert.equal(await options().count(),1);
  await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Switch project space'}).waitFor({state:'detached'});
  assert.match(await trigger.innerText(),/Support tools/);assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  checks.push('Name/path search reaches hidden projects; Enter changes scope and restores focus to the header.');
  await open();await search().fill('no-such-space');assert.equal(await options().count(),0);await capture('no-match');
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'Switch project space'}).count(),0);
  await open();assert.equal(await search().inputValue(),'');await search().fill('all');await page.keyboard.press('Enter');
  assert.match(await trigger.innerText(),/All spaces/);
  await open();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert(!(await trigger.innerText()).includes('All spaces'),'arrows choose a project');
  await open();await page.getByRole('button',{name:'Close space switcher'}).click();assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  checks.push('No-match, clear-on-reopen, All spaces, arrow selection and close behavior work without changing scope accidentally.');
  await open();await search().fill('storefront');await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+1');await page.locator('.sessions-view').waitFor();
  await page.waitForFunction(()=>document.querySelector('.session-toolbar')?.textContent.includes('storefront'));
  assert(!(await page.locator('.session-toolbar').innerText()).includes('platform'));
  await open();await search().fill('platform');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.session-toolbar')?.textContent.includes('platform'));
  await page.getByRole('navigation',{name:'Projects views'}).getByRole('button',{name:'Changes',exact:true}).click();
  await page.getByRole('combobox',{name:'Repository',exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:'Repository',exact:true}).inputValue(),'p2');
  await page.keyboard.press('Meta+Shift+C');await page.getByRole('combobox',{name:'Context project',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Context project',exact:true}).inputValue(),'p2');
  await open();await search().fill('all');await page.keyboard.press('Enter');await page.locator('.mission-room').waitFor();
  checks.push('Space selection scopes Sessions, Changes and Context; All spaces returns project-only views to Mission room.');
  await page.evaluate(()=>localStorage.setItem('space-fixture-size','80'));
  await page.reload();await trigger.waitFor();await page.waitForFunction(()=>document.querySelector('.space-switch-count')?.textContent==='80');await open();await options().last().scrollIntoViewIfNeeded();await capture('switcher-80');
  assert.equal(await options().count(),81);
  assert(Math.abs(await page.locator('.project-spaces').evaluate(el=>el.getBoundingClientRect().width)-headerWidth)<2,'project count does not increase header width');
  await page.keyboard.press('Escape');
  for(const width of [1280,960,720]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,850),width);
   await open();await capture('switcher-'+width);
   assert(await page.getByRole('dialog',{name:'Switch project space'}).evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'switcher fits at '+width);
   await search().fill('last project');await page.keyboard.press('Enter');assert.match(await trigger.innerText(),/The last project/);
   assert(await trigger.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
   await open();await search().fill('all');await page.keyboard.press('Enter');
  }
  checks.push('80 projects stay reachable, header width stays bounded, and 1280/960/720 windows contain the panel and long names.');
  await open();await page.getByRole('button',{name:'Add a project space',exact:true}).click();
  await page.getByRole('dialog',{name:'Switch project space'}).waitFor({state:'detached'});await page.waitForFunction(()=>window.__adds===1);assert.equal(await page.evaluate(()=>window.__adds),1);
  checks.push('Add space calls the existing add flow exactly once after dismissing the switcher.');
  await open();await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Add a project space',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Close space switcher'}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await page.getByRole('button',{name:'Add a project space',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.mouse.click(10,100);assert.equal(await page.getByRole('dialog',{name:'Switch project space'}).count(),0);
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  await page.evaluate(()=>localStorage.setItem('space-fixture-size','0'));await page.reload();await trigger.waitFor();
  await page.waitForFunction(()=>document.querySelector('.space-switch-count')?.textContent==='0');await open();assert.equal(await options().count(),1);
  assert(await page.getByRole('button',{name:'Add a project space',exact:true}).isVisible());await page.keyboard.press('Escape');
  checks.push('Focus stays within the menu, backdrop dismissal restores focus, and an empty project list retains All spaces and Add space.');
 }
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,fixture:true,at:new Date().toISOString(),...provenance()},null,2)+'\n');console.log('Header checks passed:',checks.length);
}catch(error){const page=await app.firstWindow();await page.screenshot({path:path.join(out,'failure.png')});console.error({error:String(error),errors,focus:await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,600))});throw error;}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
