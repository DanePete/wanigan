#!/usr/bin/env node
// Built renderer, synthetic Control fixture, isolated Electron profile. No real agents.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { createReadStream, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const { _electron } = createRequire(import.meta.url)('playwright-core');
const before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/existing-feature-fixes-2026-09-15', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-control-recovery-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const checks = [], failures = [], errors = [];
let page, fixtureServer;
const check = async (name, run) => {
  try { await run(); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ name, error: String(error) }); console.log('FAIL ' + name + ': ' + String(error)); }
};
try {
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + `
    (() => {
      localStorage.setItem('wanigan.project','p1');
      const api=window.wanigan,now=Date.now(),proxy=(base,overrides)=>new Proxy(base,{get:(t,p)=>p in overrides?overrides[p]:t[p]});
      const node=(id,kind,title,status,dependsOn)=>({id,docketId:'recovery-fixture',kind,title,status,dependsOn,instructions:kind==='verify'?'Run the saved review commands against the implementation checkout.':title,claimPath:null,providerId:null,model:null,sessionId:null,worktree:null,startedAt:now-90000,endedAt:status==='completed'?now-30000:null,detail:null,deferUntil:null,reopenedAt:null,gateRunningSince:null,gateReturns:0,queued:false});
      const proof={id:'proof-one',docketId:'recovery-fixture',nodeId:'verify',kind:'test',status:'passed',summary:'Earlier commands passed. The checkout was edited afterward.',detail:{reviewRunId:'review-one'},createdAt:now-30000};
      const goal={id:'recovery-fixture',projectId:'p1',projectName:'storefront',title:'Repair checkout validation',objective:'Review the updated checkout and refresh its verification evidence before approval.',acceptance:['Empty carts are rejected.','Current checkout passes the saved review gate.'],risk:'low',budgetUsd:null,baseCommit:'a1b2c3d4',status:'review',gate:{onStop:false,returnFailures:false},reviewCommands:2,createdAt:now-120000,updatedAt:now-30000,autopilot:{enabled:false,providerId:null,model:null,budgetUsd:null,spendUsd:0,spendStatus:'none',haltedReason:null,haltedAt:null},nodes:[node('plan','plan','Plan the repair','completed',[]),node('implement','implement','Update validation','completed',['plan']),node('verify','verify','Verify the change','completed',['implement']),node('review','review','Review and decide','ready',['verify'])],claims:[],proofs:[proof],checkpoints:[]};
      window.__controlRecovery={goal,runCalls:[],failRun:false};const state=window.__controlRecovery;
      const control=proxy(api.control,{list:async()=>[structuredClone(goal)],get:async()=>structuredClone(goal),outcomes:async()=>[],events:async()=>[],mcpTasks:async()=>[],resumeReceipts:async()=>[],traces:async()=>[],runProof:async id=>{state.runCalls.push(id);if(state.failRun)throw Error('Synthetic checkout unavailable. Restore it before rerunning.');const refreshed={...proof,id:'proof-two',summary:'Current checkout passed the saved review gate.',createdAt:Date.now()};goal.proofs.unshift(refreshed);return structuredClone(refreshed);}});
      window.wanigan=proxy(api,{control,prefs:proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})})});
    })();
  `);
  let url = rendererURL;
  if (before) {
    const fixtureRoot = '/private/tmp/wanigan-control-fixes-before-renderer-20260915';
    fixtureServer = http.createServer((req, res) => {
      const file = path.join(fixtureRoot, (req.url ?? '/').split('?')[0]);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      createReadStream(file).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
    });
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
    fixtureServer.unref(); url = 'http://127.0.0.1:' + fixtureServer.address().port + '/index.html';
  }
  const shots = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        if (!document.getElementById('control-fixture-provenance')) {
          const label=document.createElement('div');label.id='control-fixture-provenance';label.textContent='SYNTHETIC CONTROL FIXTURE · NO REAL AGENTS';
          label.style.cssText='position:fixed;right:8px;bottom:3px;z-index:999999;background:#111;color:#fff;padding:3px 6px;font:10px monospace;pointer-events:none';document.body.append(label);
        }
      }, theme);
      await page.screenshot({ path: path.join(out, name + '-' + theme + '.png'), scale: 'css', animations: 'disabled' });
    }
  };
  await page.goto(url); await page.locator('.shell').waitFor();
  await page.keyboard.press('Meta+3');
  await page.locator('.control-detail').waitFor();
  await page.locator('[data-node-id="verify"]').click();
  await page.getByRole('heading', { name: 'Verify the change', exact: true }).waitFor();
  const rerun = page.getByRole('button', { name: 'Rerun review gate', exact: true });
  await check('Completed verification retains its task and recorded proof', async () => {
    assert.match(await page.locator('.control-node').innerText(), /completed/);
    assert.equal(await page.locator('[data-node-id="verify"][aria-selected="true"]').count(), 1);
  });
  if (before) await check('Baseline has no rerun action on a completed verification task', async () => assert.equal(await rerun.count(), 0));
  else await check('Completed verification offers an explicit rerun action', async () => {
    assert.equal(await rerun.count(), 1);
    assert.match(await page.locator('.control-node').innerText(), /Rerun after checkout or command changes/);
  });
  await shots('control-completed-verify');
  if (!before) {
    await page.evaluate(() => { window.__controlRecovery.failRun = true; });
    await rerun.click();
    await check('A refused rerun displays the refusal without adding proof', async () => {
      await page.getByText('Synthetic checkout unavailable. Restore it before rerunning.', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__controlRecovery.runCalls), ['verify']);
      assert.equal(await page.evaluate(() => window.__controlRecovery.goal.proofs.length), 1);
    });
    await page.evaluate(() => { window.__controlRecovery.failRun = false; });
    await rerun.click();
    await check('Rerun targets the completed verifier and reloads its new evidence', async () => {
      await page.getByText('Review gate recorded as evidence.', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__controlRecovery.runCalls), ['verify', 'verify']);
      assert.equal(await page.evaluate(() => window.__controlRecovery.goal.proofs.length), 2);
      assert.match(await page.locator('.control-facts').innerText(), /2\s+proof records/);
    });
    await shots('control-refreshed-verify');
  }
} catch (error) {
  failures.push({ name: 'Probe orchestration', error: String(error.stack ?? error) });
  if (page) await page.screenshot({ path: path.join(out, 'control-failure.png') }).catch(() => {});
} finally {
  writeFileSync(path.join(out, 'control-verification.json'), JSON.stringify({ at: new Date().toISOString(), provenance: 'Built renderer in isolated Electron, synthetic Control bridge; no real main process, agent calls, or user-data writes.', checks, failures, errors }, null, 2) + '\n');
  await app.close(); fixtureServer?.close();
}
if (failures.length || errors.length) process.exitCode = 1;
