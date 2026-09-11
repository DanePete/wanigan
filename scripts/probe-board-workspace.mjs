#!/usr/bin/env node
// Actual renderer in isolated Electron. All records and mutations are fixtures.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/board-workspace', before ? 'before' : 'after');
mkdirSync(out, {recursive:true});
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-board-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks = [], errors = [], dimensions = [];
const record = text => {checks.push(text); console.log(text);};
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan, now = Date.now();
    const row = (id,title,status,extra={}) => ({
      docketId:'g1',docketTitle:'A smoother checkout',projectId:'p1',projectName:'storefront',risk:'elevated',
      ...extra,
      node:{id,docketId:extra.docketId??'g1',title,status,kind:'implement',instructions:'Improve checkout reliability while keeping the successful purchase flow unchanged. Add focused coverage for the failure case.',
        dependsOn:[],claimPath:'src/checkout.ts',providerId:null,model:null,sessionId:null,worktree:null,startedAt:null,endedAt:null,detail:null,deferUntil:null,queued:false,...extra.node},
    });
    window.__boardRows = [
      row('n1','Make checkout retries safe','ready'),
      row('n2','Restore the cart on refresh','ready'),
      row('n3','Refine the search experience','running',{docketId:'g2',docketTitle:'Find the right product',projectId:'p2',projectName:'platform',node:{sessionId:'s2',providerId:'codex',model:'gpt-5-codex',startedAt:now-900000}}),
      row('n4','Verify the new search ranking','pending',{docketId:'g2',docketTitle:'Find the right product',projectId:'p2',projectName:'platform',node:{kind:'verify',dependsOn:['n3']}}),
      row('n5','Review retry handling','blocked',{node:{kind:'review',dependsOn:['n6']}}),
      row('n6','Protect against duplicate charges','failed',{risk:'high',node:{detail:'The retry test still creates a second charge after a timeout.',endedAt:now-240000}}),
      row('n7','Refresh account preferences','pending',{docketId:'g3',docketTitle:'A calmer account area',node:{deferUntil:now+604800000}}),
      row('n8','Record the payment audit trail','completed',{node:{endedAt:now-3600000}}),
      row('n9','Retire the legacy webhook','canceled',{node:{detail:'Superseded by the provider migration.',endedAt:now-7200000}}),
      row('n10','Regenerate the search index','ready',{docketId:'g2',docketTitle:'Find the right product',projectId:'p2',projectName:'platform',node:{queued:true}}),
      row('n11','Check receipt accessibility','pending',{node:{kind:'verify',dependsOn:['n1','n2']}}),
      row('n12','Map the account settings','completed',{docketId:'g3',docketTitle:'A calmer account area',node:{kind:'plan',endedAt:now-4200000}}),
    ];
    window.__boardCalls = [];
    window.__boardReads = [];
    const change = (id, values) => {window.__boardRows = window.__boardRows.map(row=>row.node.id===id?{...row,node:{...row.node,...values}}:row);};
    window.wanigan = new Proxy(original,{get(api,service){
      if(service === 'control') return new Proxy(api.control,{get(control,method){
        if(method==='board') return async scope => {
          window.__boardReads.push(scope);
          if(window.__boardFailure===scope) throw new Error('Fixture board unavailable');
          const rows=window.__boardRows.filter(row=>!scope||row.projectId===scope);
          if(window.__holdBoard && window.__holdBoard.scope===scope) return new Promise(resolve=>window.__releaseBoard=()=>resolve(rows));
          return rows;
        };
        if(method==='start') return async (id,options)=>{window.__boardCalls.push(['start',id,options]); if(window.__boardActionFailure)throw new Error('Fixture launch refused'); if(window.__holdStart)await new Promise(resolve=>window.__releaseStart=resolve); change(id,{status:'running',startedAt:Date.now(),providerId:options.providerId}); return {sessionId:null};};
        if(method==='retry') return async id=>{window.__boardCalls.push(['retry',id]);change(id,{status:'ready',detail:null});};
        if(method==='defer') return async (id,until)=>{window.__boardCalls.push(['defer',id,until]);change(id,{status:until?'pending':'ready',deferUntil:until});};
        if(method==='list') return async()=>[];
        return control[method];
      }});
      if(service==='interview') return new Proxy(api.interview,{get(iv,method){
        if(method==='models')return async()=>[{id:'claude-sonnet-5',label:'Sonnet 5',costPerQuestion:0.02}];
        if(method==='list')return async()=>[];
        if(method==='start')return async(...args)=>{window.__boardCalls.push(['interview.start',...args]);throw new Error('Fixture refuses model calls');};
        return iv[method];
      }});
      return api[service];
    }});
  });
  await page.goto(rendererURL);
  await page.waitForSelector('.mission-room');
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
  const go = async chord => {await page.locator('.space-dock button').first().focus();await page.keyboard.press(chord);};
  await go('Meta+Shift+B'); await page.getByRole('heading',{name:'Board',exact:true}).waitFor();
  await page.waitForSelector('.brd-card');
  await page.waitForFunction(()=>Number(document.querySelector('.companion-presence .wanigan-orb canvas')?.dataset.frames)>0);
  await page.evaluate(()=>document.activeElement?.blur());
  for(const theme of ['dark','light']) {
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await page.screenshot({path:path.join(out,`board-${theme}.png`),scale:'css'});
  }
  if(!before) {
    const tile=id=>page.locator(`.brd-card[data-node-id="${id}"]`);
    const sheet=page.getByRole('dialog');
    const open=async id=>{await tile(id).click();await sheet.waitFor();};
    const close=async()=>{await sheet.getByRole('button',{name:'Close task details',exact:true}).click();await sheet.waitFor({state:'hidden'});};
    const refresh=async()=>{const n=await page.evaluate(()=>window.__boardReads.length);await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(n=>window.__boardReads.length>n,n);};
    const scopes=page.getByRole('combobox',{name:'Filter the board by project'});
    const filters=page.getByRole('group',{name:'Filter tasks by state'});
    const search=page.getByRole('searchbox',{name:'Search board tasks'});
    assert.equal(await page.locator('.brd-col').count(),6);
    assert.equal(await page.getByRole('region',{name:'Waiting tasks',exact:true}).locator('.brd-card').count(),2);
    assert.equal(await page.getByRole('region',{name:'Blocked tasks',exact:true}).locator('.brd-card').count(),2);
    assert.match(await tile('n9').innerText(),/canceled/);
    assert.match(await tile('n6').innerText(),/second charge/);
    assert.equal(await page.locator('.brd-card button').count(),0);
    record('six lanes separate waiting dependencies from failures, retain cancellation labels and failure reasons, and render each task as one keyboard button');

    await open('n1');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Close task details');
    assert.deepEqual(await page.evaluate(()=>window.__boardCalls),[]);
    await page.keyboard.press('Shift+Tab');
    assert(await sheet.evaluate(el=>el.contains(document.activeElement)));
    await page.keyboard.press('Escape');
    await sheet.waitFor({state:'hidden'});
    assert(await tile('n1').evaluate(el=>el===document.activeElement));
    await open('n4');
    assert.match(await sheet.innerText(),/Refine the search experience/);
    await sheet.getByRole('button',{name:/Refine the search experience running/}).click();
    await sheet.getByRole('heading',{name:'Refine the search experience',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'brd-task-title');
    const sheetRect=await sheet.boundingBox();
    assert(Math.abs(1440-sheetRect.x-sheetRect.width-16)<1,'desktop sheet must sit against the right inset');
    assert.equal(await sheet.getByRole('button',{name:'Start task',exact:true}).count(),0);
    for(const theme of ['dark','light']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.screenshot({path:path.join(out,`task-detail-${theme}.png`),scale:'css'});
    }
    await sheet.getByRole('button',{name:'Open session',exact:true}).click();
    await page.locator('.sessions-view').waitFor();
    assert.equal(await page.locator('.session-item.active').getAttribute('title'),'codex · platform');
    await sheet.waitFor({state:'hidden'});
    await go('Meta+Shift+B');await page.getByRole('heading',{name:'Board',exact:true}).waitFor();
    assert.equal(await scopes.inputValue(),'p2');
    await scopes.selectOption('');await tile('n1').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.__boardCalls),[]);
    record('task sheets trap focus, restore their opener, follow prerequisites by identity, and open the recorded session without launching anything');

    await open('n10');
    assert.match(await sheet.innerText(),/Queued for autopilot/);
    assert.equal(await sheet.getByRole('button',{name:'Start task',exact:true}).count(),0);
    assert.equal(await sheet.locator('.brd-park-menu').count(),0);
    await close();
    await open('n7');
    assert.equal(await sheet.getByRole('button',{name:'Start task',exact:true}).count(),0);
    await sheet.getByRole('button',{name:'Bring back now',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.brd-col[data-column="ready"] [data-node-id="n7"]'));
    assert.deepEqual(await page.evaluate(()=>window.__boardCalls),[['defer','n7',null]]);
    await close();
    record('queued tasks cannot race the dispatcher; parked tasks must be brought back before Start appears');

    await open('n2');
    await sheet.locator('.brd-park-menu > summary').click();
    const parkBefore=Date.now();
    await sheet.getByRole('button',{name:'Tomorrow',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.brd-col[data-column="parked"] [data-node-id="n2"]'));
    const parkedCall=await page.evaluate(()=>window.__boardCalls.at(-1));
    assert.equal(parkedCall[0],'defer');assert.equal(parkedCall[1],'n2');
    assert(parkedCall[2]>=parkBefore+86400000 && parkedCall[2]<=Date.now()+86400000);
    assert.equal(await sheet.getByRole('button',{name:'Start task',exact:true}).count(),0);
    await sheet.getByRole('button',{name:'Bring back now',exact:true}).click();
    await sheet.getByRole('button',{name:'Start task',exact:true}).waitFor();
    await close();
    await open('n6');
    await sheet.getByRole('button',{name:'Retry task',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.brd-col[data-column="ready"] [data-node-id="n6"]'));
    assert.deepEqual(await page.evaluate(()=>window.__boardCalls.at(-1)),['retry','n6']);
    await close();
    record('parking sends the selected task and future timestamp; bring-back and retry follow refreshed graph state without inventing completion');

    await open('n1');
    await sheet.getByRole('combobox',{name:'Which agent Start launches on'}).selectOption('codex');
    await sheet.getByRole('button',{name:'Start task',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.brd-col[data-column="running"] [data-node-id="n1"]'));
    assert.deepEqual(await page.evaluate(()=>window.__boardCalls.at(-1)),['start','n1',{providerId:'codex'}]);
    await close();
    await open('n2');
    assert.equal(await sheet.getByRole('combobox',{name:'Which agent Start launches on'}).inputValue(),'codex');
    await page.evaluate(()=>window.__boardActionFailure=true);
    await sheet.getByRole('button',{name:'Start task',exact:true}).click();
    await sheet.getByText('Fixture launch refused',{exact:true}).waitFor();
    assert(await page.locator('.brd-col[data-column="ready"] [data-node-id="n2"]').count());
    await page.evaluate(()=>window.__boardActionFailure=false);
    await close();
    record('Start routes the selected task and provider exactly once; a refused launch keeps its recorded Ready state and reports the error');

    await page.evaluate(()=>window.__holdBoard={scope:'p1'});
    await scopes.selectOption('p1');
    await page.waitForFunction(()=>typeof window.__releaseBoard==='function');
    assert.equal(await page.locator('.brd-card').count(),0);
    await scopes.selectOption('p2');
    await tile('n3').waitFor();
    await page.evaluate(()=>{window.__holdBoard=null;window.__releaseBoard();});
    assert.equal(await page.locator('.brd-card').count(),3);
    assert.equal(await tile('n1').count(),0);
    await page.evaluate(()=>window.__boardFailure='p1');
    await scopes.selectOption('p1');
    await page.getByText(/Try Refresh to read this project again/).waitFor();
    assert.equal(await page.locator('.brd-card').count(),0);
    await page.evaluate(()=>window.__boardFailure=undefined);
    await scopes.selectOption('');await tile('n1').waitFor();
    record('project changes withhold old-scope tasks; late reads cannot replace the current scope and failed switches never relabel old data');

    await open('n2');
    await page.evaluate(()=>window.__holdStart=true);
    await sheet.getByRole('button',{name:'Start task',exact:true}).click();
    await page.waitForFunction(()=>typeof window.__releaseStart==='function');
    assert.equal(await sheet.getByRole('combobox',{name:'Which agent Start launches on'}).isDisabled(),true);
    await close();
    await scopes.selectOption('p2');await tile('n3').waitFor();
    await page.evaluate(()=>{window.__holdStart=false;window.__releaseStart();});
    await page.waitForFunction(()=>window.__boardRows.find(row=>row.node.id==='n2').node.status==='running');
    assert.equal(await page.locator('.brd-card').count(),3);
    assert.equal(await scopes.inputValue(),'p2');
    await scopes.selectOption('');await tile('n2').waitFor();
    record('a pending launch locks its controls and its late completion cannot replace a newly selected project');

    await page.evaluate(()=>window.__boardFailure=null);await refresh();
    await page.getByText(/Last recorded tasks remain visible/).waitFor();
    assert.equal(await page.locator('.brd-card').count(),12);
    await open('n7');
    assert.equal(await sheet.getByRole('button',{name:'Start task',exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.__boardFailure=undefined);
    await sheet.getByRole('button',{name:'Refresh board',exact:true}).click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.brd-sheet button')).some(button=>button.textContent==='Start task'&&!button.disabled));
    await close();
    await open('n7');
    await page.evaluate(()=>window.__boardRows=window.__boardRows.filter(row=>row.node.id!=='n7'));
    // Poll the same bridge refresh through visibility, as the running view does.
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await sheet.getByText(/This task is no longer/).waitFor();
    assert.equal(await sheet.getByRole('button',{name:'Start task',exact:true}).count(),0);
    await close();
    record('failed refreshes retain readable records but disable mutations; removed selected tasks expose no stale actions');

    await search.fill('search');
    await filters.getByRole('button',{name:/^Waiting/}).click();
    assert.equal(await page.locator('.brd-card').count(),1);
    await go('Meta+2');await page.getByRole('heading',{name:'Fleet',exact:true}).waitFor();
    await go('Meta+Shift+B');await tile('n4').waitFor();
    assert.equal(await search.inputValue(),'search');
    assert.equal(await filters.getByRole('button',{name:/^Waiting/}).getAttribute('aria-pressed'),'true');
    await search.fill('not-a-task');
    await page.getByRole('heading',{name:'No tasks match this view.',exact:true}).waitFor();
    await page.getByRole('button',{name:'Show all tasks',exact:true}).click();
    assert.equal(await page.locator('.brd-card').count(),11);
    record('search and state filters survive navigation; an empty filter has a working path back to every task');

    await page.evaluate(()=>document.documentElement.dataset.motion='full');
    await open('n4');
    assert.notEqual(await sheet.evaluate(el=>getComputedStyle(el).animationDuration),'0s');
    await close();
    await page.evaluate(()=>window.__boardRows=window.__boardRows.map(row=>row.node.id==='n4'?{...row,node:{...row.node,status:'ready'}}:row));
    await refresh();
    await page.waitForFunction(()=>document.querySelector('.brd-col[data-column="ready"] [data-node-id="n4"]'));
    assert.equal(await page.locator('.brd-card.mo-enter').count(),1);
    assert.equal(await tile('n4').evaluate(el=>getComputedStyle(el).animationName),'mo-in');
    await page.evaluate(()=>document.documentElement.dataset.motion='off');
    await open('n4');
    assert.equal(await sheet.evaluate(el=>getComputedStyle(el).animationDuration),'0s');await close();
    await page.evaluate(()=>document.documentElement.dataset.motion='auto');
    await open('n4');
    assert.equal(await sheet.evaluate(el=>getComputedStyle(el).animationDuration),'0s');await close();
    record('only an observed lane change animates a task; the detail sheet and task motion respect Off and system Reduce Motion');

    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,960));
    await page.waitForFunction(()=>window.innerWidth===820);
    const size=await page.locator('.board-view').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,height:el.clientHeight}));
    assert(size.scroll<=size.width+1);
    const boardSize=await page.locator('.brd').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,height:el.clientHeight}));
    assert(boardSize.scroll>boardSize.width && boardSize.height>=250);
    dimensions.push({viewport:820,page:size,board:boardSize});
    for(const theme of ['dark','light']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.locator('.brd').evaluate(el=>el.scrollLeft=0);
      await page.screenshot({path:path.join(out,`board-narrow-${theme}.png`),scale:'css'});
    }
    await page.locator('.brd').evaluate(el=>el.scrollLeft=el.scrollWidth);
    await open('n9');
    assert((await sheet.boundingBox()).width<=820);
    for(const theme of ['dark','light']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.screenshot({path:path.join(out,`task-detail-narrow-${theme}.png`),scale:'css'});
    }
    await close();
    record('narrow desktop keeps overflow inside the board, retains the final lane, and fits the task sheet in both themes');

    await page.evaluate(()=>window.__boardRows=[]);await refresh();
    await page.getByRole('heading',{name:'Your next goal starts here.',exact:true}).waitFor();
    await page.getByRole('button',{name:'Plan a goal',exact:true}).first().click();
    await page.getByRole('heading',{name:'Plan with Wanigan',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.__boardCalls.filter(call=>call[0]==='interview.start')),[]);
    await page.getByRole('button',{name:'Back to the board',exact:true}).click();
    await page.getByRole('heading',{name:'Your next goal starts here.',exact:true}).waitFor();
    record('empty Board retains the planning flow; opening or leaving the planner makes no model call');
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Actual Electron renderer with synthetic tasks; no real agents or operations',checks,dimensions,errors},null,2)+'\n');
} finally {await app.close();rmSync(dir,{recursive:true,force:true});}
