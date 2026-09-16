#!/usr/bin/env node
// Production renderer with explicit synthetic bridge responses. This verifies
// interaction/state, not main-process launch, provider behavior or persistence.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const { _electron } = createRequire(import.meta.url)('playwright-core');
const out = path.join(root, 'docs/visuals/workbench-2026-09-15/home');
mkdirSync(out, { recursive: true });
const temp = mkdtempSync(path.join(tmpdir(), 'wanigan-workbench-home-'));
writeFileSync(path.join(temp, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:940,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(temp, 'main.cjs'), `--user-data-dir=${temp}/profile`], env });
const checks = [], errors = [];
let page;
try {
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + `
    (() => {
      const base=window.wanigan, now=Date.now(), setup=localStorage.getItem('qa.scenario')==='setup';
      const proxy=(target,overrides)=>new Proxy(target,{get:(t,p)=>p in overrides?overrides[p]:t[p]});
      const projects=[{id:'p1',name:'storefront',path:'/example/storefront',branch:'main'},{id:'p2',name:'platform',path:'/example/platform',branch:'feature/rail'}];
      const titles=['Checkout validation · preserve keyboard focus after a failed payment','Repair deployment configuration','Review the new account settings','Investigate cache invalidation','Improve search results'];
      const sessions=titles.map((title,i)=>({id:'s'+(i+1),projectId:i===1?'p2':'p1',projectName:i===1?'platform':'storefront',projectPath:i===1?'/example/platform':'/example/storefront',providerId:'codex',harnessId:'codex',title:'codex · repository',displayTitle:title,status:'running',createdAt:now-(i+1)*300000,endedAt:null,exitCode:null,pid:100+i,unread:0,worktree:null,capabilities:{hooks:false}}));
      const att=[{sessionId:'s1',kind:'permission',label:'Permission requested',detail:'Edit src/checkout/PaymentForm.tsx',tool:'Edit',since:now-60000,transitionId:'first'},
        {sessionId:'s2',kind:'error',label:'Needs help',detail:'Build stopped: a required environment variable was not found.',tool:'Bash',since:now-600000,transitionId:'second'},
        {sessionId:'s3',kind:'finished',label:'Ready to inspect',detail:'Agent turn finished. Changes have not been accepted.',tool:null,since:now-300000,transitionId:'third'},
        {sessionId:'s5',kind:'idle',label:'Waiting for your next task',detail:null,tool:null,since:now-10000,transitionId:'fourth'}];
      const state=window.__home={projects:setup?[]:projects,sessions:setup?[]:sessions,attention:setup?[]:att,attFail:false,createCalls:[],askCalls:0,createFail:true,pick:'cancel',preflightReads:0,readyAgent:true,listeners:[],focus:[]};
      const focus=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(...args){state.focus.push({tag:this.tagName,id:this.id,className:this.className,stack:new Error().stack});return focus.apply(this,args);};
      const providers=[{id:'codex',label:'Codex',harnessId:'codex',backendId:'openai',path:'/example/bin/codex',version:'fixture',supports:{model:false,effort:false,permissionMode:false,resume:true},capabilities:{hooks:false},launchFields:[]}];
      const sessionApi=proxy(base.sessions,{list:async()=>state.sessions,buffer:async()=>'',create:async opts=>{state.createCalls.push(opts);if(state.createFail)throw Error('Synthetic launch failure; no process started');if(state.holdCreate)await new Promise(resolve=>state.resolveCreate=resolve);return sessions[0];},baseline:async()=>null});
      const projectApi=proxy(base.projects,{list:async()=>state.projects,refresh:async()=>state.projects,pick:async()=>{if(state.pick==='cancel')return null;if(state.pick==='error')throw Error('Synthetic folder registration failure');state.projects=[projects[0]];return projects[0];}});
      const on=proxy(base.on,{sessions:cb=>{state.listeners.push(cb);return()=>{state.listeners=state.listeners.filter(f=>f!==cb);};}});
      const preflight=proxy(base.preflight,{read:async()=>{state.preflightReads++;return {agents:[{id:'codex',label:'Codex',harnessId:'codex',found:state.readyAgent,path:state.readyAgent?'/example/bin/codex':null,version:'fixture',signedIn:'unknown',credential:'harness-login'}],searched:['/example/bin'],projects:state.projects.length,sessionsStarted:state.sessions.length};}});
      const companion=proxy(base.companion,{ask:async()=>{state.askCalls++;throw Error('No model calls allowed in fixture');}});
      window.wanigan=proxy(base,{sessions:sessionApi,projects:projectApi,on,preflight,companion,
        providers:proxy(base.providers,{list:async()=>providers,modelCatalogue:async()=>({rows:[],source:'unavailable'})}),
        attention:proxy(base.attention,{list:async()=>{if(state.attFail)throw Error('Synthetic attention unavailable');return state.attention;}}),
        prefs:proxy(base.prefs,{all:async()=>({...await base.prefs.all(),motion:'off'})}),
        policy:proxy(base.policy,{trust:async()=>'project'}),key:proxy(base.key,{missingFor:async()=>[]}),
        accounts:proxy(base.accounts,{listForProvider:async()=>[],resolveForLaunch:async()=>({account:null,source:'none',override:null,reason:'Uses the CLI login'})}),
        code:proxy(base.code,{editors:async()=>[],changes:async()=>({isRepo:true,branch:'main',files:[],headMoved:false,commits:0,attributed:false,unreadable:null})}),
        review:proxy(base.review,{recipe:async()=>({commands:[]}),history:async()=>[]}),handoff:proxy(base.handoff,{plan:async()=>({targets:[]})})});
    })();
  `);
  const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS '+name); };
  const go = async key => { await page.evaluate(()=>document.activeElement?.blur()); await page.keyboard.press(key); };
  const capture = async name => {
    for (const theme of ['dark','light']) {
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;if(!document.getElementById('qa-provenance')){const el=document.createElement('div');el.id='qa-provenance';el.textContent='SYNTHETIC WORKFLOW FIXTURES · NO REAL AGENTS';el.style.cssText='position:fixed;right:8px;bottom:3px;z-index:999999;background:#111;color:#fff;padding:3px 6px;font:10px monospace;pointer-events:none';document.body.append(el);}},theme);
      await page.screenshot({path:path.join(out,name+'-'+theme+'.png'),animations:'disabled',scale:'css'});
    }
  };
  await page.goto(rendererURL); await page.locator('.home-work-row').first().waitFor();
  await check('Home preserves main attention priority and uses readable session titles',async()=>{
    const names=await page.locator('.home-work-name').allTextContents();assert.equal(names.length,3);assert.match(names[0],/^Checkout validation/);assert.equal(names[1],'Repair deployment configuration');
    assert.equal(await page.locator('.mission-stage').count(),0);assert.equal(await page.locator('.wanigan-orb').count(),1);
  });
  await check('Selecting work reveals reason and relevant next action without launches',async()=>{
    await page.locator('.home-work-row').nth(1).click();assert.equal(await page.locator('#home-work-detail h2').innerText(),'Repair deployment configuration');
    assert.match(await page.locator('#home-work-detail').innerText(),/required environment/);
    assert.deepEqual(await page.evaluate(()=>({launches:window.__home.createCalls.length,asks:window.__home.askCalls})),{launches:0,asks:0});
  });
  await capture('home-attention-wide');
  await page.locator('.home-work-row').first().click();
  await page.getByRole('button',{name:'Open terminal',exact:true}).click();await page.locator('.sessions-view').waitFor();
  await go('Meta+Shift+H');await page.locator('.home-work').waitFor();
  await check('Opening the existing terminal starts no new session or model call',async()=>assert.deepEqual(await page.evaluate(()=>({launches:window.__home.createCalls.length,asks:window.__home.askCalls})),{launches:0,asks:0}));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,600));await page.waitForTimeout(180);
  await check('Home has no horizontal overflow in compact window',async()=>assert(await page.locator('.home-room').evaluate(el=>el.scrollWidth<=el.clientWidth+1)));
  await capture('home-attention-compact');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,940));
  await page.evaluate(()=>{window.__home.attFail=true;document.dispatchEvent(new Event('visibilitychange'));});
  await page.getByText('Session status could not refresh.',{exact:false}).waitFor();
  await check('Failed activity refresh is visibly stale and keeps the observed task',async()=>assert.match(await page.locator('.home-work-name').first().innerText(),/^Checkout validation/));
  await capture('home-stale');
  await page.evaluate(()=>{window.__home.attFail=false;document.dispatchEvent(new Event('visibilitychange'));});

  // Drafts belong to projects, survive closing/navigation, and only the
  // successfully submitted project's draft is consumed.
  await go('Meta+t');const dialog=page.getByRole('dialog',{name:'New session',exact:true});await dialog.waitFor();
  const message=dialog.getByRole('textbox',{name:'First message',exact:true});
  await check('New session initially focuses the task',async()=>{await page.waitForTimeout(150);assert(await message.evaluate(el=>el===document.activeElement),JSON.stringify(await page.evaluate(()=>({active:document.activeElement?.outerHTML,focus:window.__home.focus.slice(-8)}))));});
  await message.fill('Keep checkout focus when validation fails.');
  await dialog.getByRole('combobox',{name:'Project',exact:true}).selectOption('p2');assert.equal(await message.inputValue(),'');
  await message.fill('Document deployment prerequisites.');
  await dialog.getByRole('combobox',{name:'Project',exact:true}).selectOption('p1');
  await check('Switching projects preserves separate drafts',async()=>assert.equal(await message.inputValue(),'Keep checkout focus when validation fails.'));
  await capture('launch-task-first-wide');await page.keyboard.press('Escape');
  await go('Meta+2');await go('Meta+t');await dialog.waitFor();
  await check('Closing and navigating retains the unfinished task',async()=>assert.equal(await message.inputValue(),'Keep checkout focus when validation fails.'));
  await dialog.getByRole('button',{name:'Start session',exact:true}).click();await page.getByText('Synthetic launch failure; no process started',{exact:false}).waitFor();
  await check('A failed launch preserves the draft',async()=>assert.equal(await message.inputValue(),'Keep checkout focus when validation fails.'));
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(760,600));await page.waitForTimeout(100);await capture('launch-task-first-compact');
  await check('Compact launch keeps the task and resolved execution values accessible',async()=>{assert(await dialog.locator('.launch-resolved').isVisible());assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));});
  await page.evaluate(()=>{window.__home.createFail=false;window.__home.holdCreate=true;});await dialog.getByRole('button',{name:'Start session',exact:true}).click();
  await page.waitForFunction(()=>typeof window.__home.resolveCreate==='function');
  await check('An in-flight launch cannot erase a newer draft or close a replacement dialog',async()=>{assert(await message.isDisabled());assert(await dialog.getByRole('combobox',{name:'Project',exact:true}).isDisabled());assert(await dialog.getByRole('button',{name:'Cancel',exact:true}).isDisabled());await page.keyboard.press('Escape');assert(await dialog.isVisible());});
  await page.evaluate(()=>window.__home.resolveCreate());await dialog.waitFor({state:'detached'});
  await go('Meta+t');await dialog.waitFor();
  await check('Only a successful launch clears its project draft',async()=>{assert.equal(await message.inputValue(),'');await dialog.getByRole('combobox',{name:'Project',exact:true}).selectOption('p2');assert.equal(await message.inputValue(),'Document deployment prerequisites.');});
  await dialog.getByRole('button',{name:'Discard draft',exact:true}).click();assert.equal(await message.inputValue(),'');await page.keyboard.press('Escape');

  await page.evaluate(()=>{localStorage.setItem('qa.scenario','setup');localStorage.removeItem('wanigan.project');});await page.reload();await page.locator('.mission-setup').waitFor();
  const start=page.locator('.mission-setup').getByRole('button',{name:'Start a session',exact:true});
  await check('First-run setup is visible before the first fold and needs a project',async()=>{assert(await start.isDisabled());assert(await page.locator('.mission-setup-title').evaluate(el=>el.getBoundingClientRect().bottom<innerHeight));});
  await capture('setup-no-project-compact');
  await page.getByRole('button',{name:'Choose a folder instead',exact:true}).click();
  await check('Canceling folder selection keeps setup incomplete',async()=>assert(await start.isDisabled()));
  await page.evaluate(()=>window.__home.pick='add');await page.getByRole('button',{name:'Choose a folder instead',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.mission-setup button:last-child')?.disabled);
  await check('Adding a folder refreshes setup readiness without reopening Home',async()=>{await page.waitForFunction(()=>Array.from(document.querySelectorAll('.mission-setup button')).some(el=>el.textContent==='Start a session'&&!el.disabled));assert(await start.isEnabled());});
  await capture('setup-project-ready-compact');
  await page.evaluate(()=>{window.__home.readyAgent=false;window.dispatchEvent(new Event('focus'));});await page.getByText('Needs an agent first.',{exact:true}).waitFor();
  await check('Returning to the window rechecks external agent readiness',async()=>assert(await start.isDisabled()));
  await page.reload();await page.locator('.mission-setup').waitFor();await go('Meta+t');await dialog.waitFor();
  await message.fill('Review my first project before changing it.');await page.evaluate(()=>window.__home.pick='add');
  await dialog.getByRole('button',{name:'Choose a folder to work in',exact:true}).click();
  await dialog.getByRole('combobox',{name:'Project',exact:true}).waitFor();
  await check('A task written before the first folder is chosen follows that folder',async()=>assert.equal(await message.inputValue(),'Review my first project before changing it.'));
  await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);assert(!await page.getByText('This view hit an error',{exact:false}).count());
} catch(error) {errors.push(String(error.stack??error));if(page)await page.screenshot({path:path.join(out,'failure.png'),scale:'css'}).catch(()=>{});}
finally {writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Production renderer, synthetic bridge, isolated Electron profile; no real main/preload, processes, agents or model calls. One successful create response is a fixture only.',checks,errors},null,2)+'\n');console.log(JSON.stringify({checks,errors},null,2));await app.close();}
if(errors.length)process.exitCode=1;
