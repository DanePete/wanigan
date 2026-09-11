#!/usr/bin/env node
// Real renderer, isolated Electron, deterministic evidence. No live agents or provider calls.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/fleet-ledgers', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-fleet-ledgers-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const errors = [], checks = [];
const record = message => { checks.push(message); console.log(message); };
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan;
    window.__ledgerCalls = [];
    window.__ledgerFailure = false;
    window.__fleetReordered = false;
    const budgets = [{scopeId:null,scopeName:'All projects',monthlyUsd:240,spentUsd:62.7,sessionUsd:49.9,batchUsd:12.8,warnAt:0.8,projectedUsd:188.1,daysElapsed:10,daysInMonth:30}];
    const overrides = {
      teams:{read:async()=>({enabled:false,teams:[],note:null})},
      attention:{list:async()=>{const rows=await original.attention.list();return rows.map(r=>window.__fleetReordered && r.sessionId==='s2'?{...r,kind:'permission',label:'Asking',since:Date.now()-900000}:r);}},
      sessions:{list:async()=>{const rows=(await original.sessions.list()).map(s=>({...s,displayTitle:s.id==='s1'?'Checkout bug':s.id==='s2'?'Workspace redesign':'Review checkout changes'}));return window.__largeFleet?[...rows,...Array.from({length:18},(_,i)=>({...rows[1],id:'extra-'+i,displayTitle:'Additional session '+(i+1),createdAt:Date.now()-120000-i*1000}))]:rows;},interrupt:async(...a)=>{window.__ledgerCalls.push(['interrupt',...a]);return true;},kill:async(...a)=>{window.__ledgerCalls.push(['kill',...a]);return true;}},
      usage:{snapshot:async({days,force})=>{
        window.__ledgerCalls.push(['snapshot',days,force]);
        if(window.__ledgerFailure) throw new Error('Fixture refresh unavailable');
        const snap=await original.usage.snapshot();
        const consumption=snap.limits.slice(0,3).map((a,i)=>({accountId:a.accountId,accountLabel:a.accountLabel,harness:a.harness,model:i===2?'gpt-5-codex':'claude-sonnet-5',requests:41+i*13,inTokens:128400+i*18200,outTokens:19200+i*2400,cacheRead:91000,costUsd:i===2?0:4.82+i,costStatus:i===2?'unreported':'reported'}));
        const daily=consumption.flatMap((a,i)=>Array.from({length:14},(_,d)=>({...a,day:new Date(Date.now()-(13-d)*86400000).toISOString().slice(0,10),tokens:Math.round(7200+(d%4)*3200+i*1100),costUsd:i===2?0:0.32})));
        const result={...snap,days,consumption,daily};
        if(window.__holdUsageDays===days) return new Promise(resolve=>{window.__releaseUsage=()=>resolve(result)});
        return result;
      }},
      batch:{insights:async()=>({totals:{runs:3,cost:12.8,in_tokens:90000,out_tokens:18000,cache_read:52000,cache_write:14000},byModel:[],outcomes:[],perRun:[]})},
      spend:{
        unified:async(days)=>{window.__ledgerCalls.push(['unified',days]);return Array.from({length:days},(_,d)=>({day:new Date(Date.now()-(days-d-1)*86400000).toISOString().slice(0,10),sessionUsd:1.1+(d%5)*0.4,batchUsd:d%3===0?0.9:0,headlessUsd:0.15,pricedRequests:15,unpricedRequests:d===days-1?11:0,pricedHeadlessRows:1,unpricedHeadlessRows:0}));},
        sync:async()=>[],effort:async()=>[],cache:async()=>[],byProject:async()=>[{projectId:'p1',projectName:'storefront',sessionUsd:36.1,batchUsd:8,total:44.1},{projectId:'p2',projectName:'platform',sessionUsd:13.8,batchUsd:4.8,total:18.6}],
      },
      codex:{usageSummary:async()=>null},
      budgets:{list:async()=>budgets,breached:async()=>[],accuracy:async()=>[],set:async(...a)=>{window.__ledgerCalls.push(['budget',...a]);return budgets;},reconcile:async(...a)=>{window.__ledgerCalls.push(['reconcile',...a]);return {};}}
    };
    window.wanigan=new Proxy(original,{get(target,key){if(!(key in overrides))return target[key];return new Proxy(target[key],{get(service,method){return overrides[key][method]??service[method]}})}});
  });
  await page.goto(rendererURL); await page.waitForSelector('.mission-room');
  await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
  await page.evaluate(()=>document.documentElement.dataset.motion='off');
  const go=async(name,key)=>{await page.locator('.space-dock button').first().focus();await page.keyboard.press(key);await page.getByRole('heading',{name,exact:true}).waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  for(const theme of ['dark','light']) {
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    for(const [name,key,ready] of [['Fleet','Meta+2','.fleet-card'],['Usage','Meta+Shift+U','.u-chart'],['Insights','Meta+5','.ins-filters']]) {
      await go(name,key);await page.waitForSelector(ready);await page.waitForTimeout(200);
      await page.screenshot({path:path.join(out,`${name.toLowerCase()}-${theme}.png`),scale:'css'});
    }
  }
  if(!before) {
    await go('Fleet','Meta+2');
    const roster=page.getByRole('region',{name:'Session roster'}), inspector=page.locator('#fleet-inspector');
    assert.equal(await roster.getByRole('button').count(),3);
    assert((await page.locator('.fleet-workspace').boundingBox()).height>300,'roster must not collapse in the flex frame');
    await roster.getByRole('button').filter({hasText:'Checkout bug'}).click();
    await inspector.getByRole('button',{name:/interrupt$/}).click();
    assert.equal((await page.evaluate(()=>window.__ledgerCalls.filter(c=>c[0]==='interrupt'))).length,0);
    await page.evaluate(()=>window.__fleetReordered=true);
    await page.waitForFunction(()=>document.querySelector('.fleet-entry')?.textContent.includes('Workspace redesign'));
    assert.match(await inspector.locator('h2').innerText(),/Checkout bug/);
    await inspector.getByRole('button',{name:'interrupt the turn',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.__ledgerCalls.filter(c=>c[0]==='interrupt')),[['interrupt','s1']]);
    record('live attention reordering retains selection; interrupt requires confirmation and reaches only the selected session');
    await inspector.getByRole('button',{name:/stop$/}).click();
    await roster.getByRole('button').filter({hasText:'Workspace redesign'}).click();
    assert.equal(await inspector.getByRole('button',{name:'end the session',exact:true}).count(),0);
    assert.match(await inspector.innerText(),/Not reported/);
    assert.equal((await page.evaluate(()=>window.__ledgerCalls.filter(c=>c[0]==='kill'))).length,0);
    await page.getByRole('group',{name:'Sort sessions by'}).getByRole('button',{name:'Age',exact:true}).click();
    assert.match(await roster.getByRole('button').first().innerText(),/Review checkout changes/);
    assert.match(await inspector.locator('h2').innerText(),/Workspace redesign/);
    await page.locator('.fleet-ledger > summary').click();
    assert.equal(await page.locator('.fleet-ledger tbody tr').count(),3);
    record('changing session clears stop confirmation; sorting preserves inspector; full metric table remains available and missing costs stay unreported');
    await page.getByRole('group',{name:'Filter by status'}).getByRole('button',{name:/Idle/}).click();
    assert.equal(await roster.getByRole('button').count(),1);
    await page.getByRole('group',{name:'Filter by status'}).getByRole('button',{name:/All/}).click();
    await page.evaluate(()=>window.__largeFleet=true);
    await page.waitForFunction(()=>document.querySelectorAll('.fleet-entry').length===21);
    const rosterSize=await roster.evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}));
    assert(rosterSize.height<=560&&rosterSize.scroll>rosterSize.height,'large fleets scroll inside the bounded roster');
    assert((await inspector.boundingBox()).height<700,'many sessions must not stretch the inspector');
    await roster.evaluate(el=>new Promise(resolve=>{el.addEventListener('scroll',()=>resolve(),{once:true});el.scrollTop=200;}));
    await go('Usage','Meta+Shift+U');
    await go('Fleet','Meta+2');
    await page.waitForFunction(()=>document.querySelectorAll('.fleet-entry').length===21);
    await page.waitForFunction(()=>Math.abs(document.querySelector('.fleet-roster')?.scrollTop-200)<2);
    assert.equal(await roster.evaluate(el=>el.scrollTop),200,'roster scroll survives route changes');
    await page.evaluate(()=>window.__largeFleet=false);
    await page.waitForFunction(()=>document.querySelectorAll('.fleet-entry').length===3);
    record('21-session fleet stays bounded and retains roster scroll across route changes');
    await go('Usage','Meta+Shift+U');
    const accounts=page.getByRole('navigation',{name:'Usage accounts'});
    const callsBefore=await page.evaluate(()=>window.__ledgerCalls.filter(c=>c[0]==='snapshot').length);
    await accounts.getByRole('button',{name:'Work Claude Code',exact:true}).click();
    assert.match(await page.locator('.u-account-title').innerText(),/Work/);
    assert.match(await page.locator('.u-consumption').innerText(),/54/);
    assert.equal(await page.evaluate(()=>window.__ledgerCalls.filter(c=>c[0]==='snapshot').length),callsBefore);
    await accounts.getByRole('button',{name:'Personal Codex',exact:true}).click();
    assert.match(await page.locator('.u-consumption').innerText(),/gpt-5-codex/);
    assert.match(await page.locator('.u-capacity').innerText(),/spend control/);
    assert.equal((await page.locator('.u-consumption > .u-scroll tbody tr').last().locator('td').last().innerText()).trim(),'—');
    await accounts.getByRole('button',{name:'Personal gemini-cli',exact:true}).click();
    assert.match(await page.locator('.u-capacity').innerText(),/no way to ask/);
    assert.match(await page.locator('.u-consumption').innerText(),/No recorded requests/);
    await accounts.getByRole('button',{name:'All accounts Combined local records',exact:true}).click();
    assert.equal(await page.locator('.u-consumption > .u-scroll tbody tr').count(),3);
    record('account selection uses identity across duplicate labels, never probes again, retains unsupported limits and never invents a zero cost');
    await accounts.getByRole('button',{name:'Work Claude Code',exact:true}).click();
    await page.evaluate(()=>window.__holdUsageDays=7);
    await page.getByRole('combobox',{name:'Consumption window'}).selectOption('7');
    await page.waitForFunction(()=>typeof window.__releaseUsage==='function');
    await page.getByRole('combobox',{name:'Consumption window'}).selectOption('30');
    await page.waitForFunction(()=>document.querySelector('.u-account-title')?.textContent.includes('last 30 days'));
    await page.evaluate(()=>window.__releaseUsage());
    assert.match(await page.locator('.u-account-title').innerText(),/last 30 days/);
    await page.evaluate(()=>window.__ledgerFailure=true);
    await page.getByRole('button',{name:'Refresh limits',exact:true}).click();
    await page.getByText('Fixture refresh unavailable',{exact:true}).waitFor();
    assert.match(await page.locator('.u-consumption').innerText(),/54/);
    await page.evaluate(()=>window.__ledgerFailure=false);
    record('a late window response cannot replace the current window; a failed refresh retains the last account records');
    await go('Insights','Meta+5');
    const reports=page.getByRole('navigation',{name:'Insights reports'});
    await reports.getByRole('button',{name:'Budgets Month-to-date limits',exact:true}).click();
    await page.getByRole('button',{name:'Set a budget',exact:true}).click();
    await page.getByRole('spinbutton',{name:'Monthly cap (USD)',exact:true}).fill('173');
    await page.getByRole('spinbutton',{name:'Warn at (%)',exact:true}).fill('73');
    await reports.getByRole('button',{name:'Batch reports Outcomes and reconciliation',exact:true}).click();
    await page.getByLabel('From',{exact:true}).fill('2026-08-01');
    await reports.getByRole('button',{name:'Budgets Month-to-date limits',exact:true}).click();
    assert.equal(await page.getByRole('spinbutton',{name:'Monthly cap (USD)',exact:true}).inputValue(),'173');
    assert.equal(await page.getByRole('spinbutton',{name:'Warn at (%)',exact:true}).inputValue(),'73');
    await page.getByRole('button',{name:'Update',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.__ledgerCalls.filter(c=>c[0]==='budget')),[['budget',null,173,0.73]]);
    await reports.getByRole('button',{name:'Batch reports Outcomes and reconciliation',exact:true}).click();
    assert.equal(await page.getByLabel('From',{exact:true}).inputValue(),'2026-08-01');
    assert.equal((await page.evaluate(()=>window.__ledgerCalls.filter(c=>c[0]==='reconcile'))).length,0);
    record('budget and reconciliation drafts survive report switches; only the deliberate budget save writes; navigation never reconciles');
    await reports.getByRole('button',{name:'Tokens & pace Activity, effort and cache',exact:true}).click();
    assert.match(await page.locator('#ins-report-activity').innerText(),/Claude.*own transcripts/);
    for(const theme of ['dark','light']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.locator('.insights').evaluate(el=>el.scrollTop=0);
      await page.screenshot({path:path.join(out,`insights-activity-${theme}.png`),scale:'css'});
    }
    await reports.getByRole('button',{name:'Spending Trends and projects',exact:true}).click();
    await page.getByRole('combobox',{name:'Reporting window in days'}).selectOption('7');
    await page.waitForFunction(()=>document.querySelector('.ins-intro')?.textContent.includes('last 7 days') && window.__ledgerCalls.some(c=>c[0]==='unified'&&c[1]===7));
    const meter=page.getByRole('group',{name:'Which meter the totals below are read from'});
    await meter.getByRole('button',{name:'CLI-reported',exact:true}).click();
    assert.match(await page.locator('.ins-filters').innerText(),/other meter reads zero by choice/);
    await meter.getByRole('button',{name:'Both meters',exact:true}).click();
    assert.equal(await page.locator('.ins-report:visible').count(),1);
    record('report visibility is exclusive; reporting window and meter controls remain functional and explain their scope');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,960));
    await page.waitForFunction(()=>window.innerWidth===820);
    for(const [name,key,selector] of [['Fleet','Meta+2','.fleet-view'],['Usage','Meta+Shift+U','.usage-view'],['Insights','Meta+5','.insights']]) {
      await go(name,key);await page.locator(selector).waitFor();
      if(name==='Fleet') {
        await page.locator('.fleet-entry').first().waitFor();
        assert((await page.locator('.fleet-workspace').boundingBox()).height>300);
      }
      if(name==='Usage') {
        await page.locator('.u-chart').waitFor();
        assert.match(await page.locator('.u-account-title').innerText(),/Work/);
        assert.equal(await page.getByRole('combobox',{name:'Consumption window'}).inputValue(),'30');
      }
      if(name==='Insights') assert.equal(await page.getByRole('combobox',{name:'Reporting window in days'}).inputValue(),'7');
      const size=await page.locator(selector).evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
      assert(size.scroll<=size.width+1,`${name} overflows: ${JSON.stringify(size)}`);
      for(const theme of ['dark','light']) {
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await page.locator(selector).evaluate(el=>el.scrollTop=0);
        await page.screenshot({path:path.join(out,`${name.toLowerCase()}-narrow-${theme}.png`),scale:'css'});
      }
    }
    record('all three workspaces fit an 820px desktop window in both themes; selected account and reporting windows survive route changes');
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Actual Electron renderer; synthetic account and session evidence; no real operations',checks,errors},null,2)+'\n');
  console.log(JSON.stringify({before,checks,errors},null,2));
} finally {await app.close();rmSync(dir,{recursive:true,force:true});}
