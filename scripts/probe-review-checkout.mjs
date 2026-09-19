#!/usr/bin/env node
// Built renderer with a synthetic bridge. No real main process, Git, agents, or user data.
// node scripts/probe-review-checkout.mjs [--before] [--out /absolute/output/directory]
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
const outAt = process.argv.indexOf('--out');
if (outAt >= 0 && (!process.argv[outAt + 1] || process.argv[outAt + 1].startsWith('--'))) throw new Error('--out requires a directory');
const out = outAt < 0
  ? path.join(root, 'docs/visuals/review-checkout-2026-09-15', before ? 'before' : 'after')
  : path.resolve(root, process.argv[outAt + 1]);
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-review-checkout-'));
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
      localStorage.setItem('wanigan.code','1');localStorage.setItem('wanigan.project','p1');
      const api=window.wanigan,now=Date.now(),proxy=(base,overrides)=>new Proxy(base,{get:(t,p)=>p in overrides?overrides[p]:t[p]});
      const run={id:'review-one',projectId:'p1',startedAt:now-40000,endedAt:now-32000,status:'passed',results:[{command:'npm test',exitCode:0,durationMs:7800,output:'Synthetic fixture: 28 tests passed.'},{command:'git diff --check',exitCode:0,durationMs:20,output:'Synthetic fixture: no whitespace errors.'}]};
      const snapshot={cwd:'/example/storefront-isolated',head:'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',fingerprint:'abcdefgh1234567890abcdef1234567890abcdef1234567890abcdef1234567890',unavailableReason:null};
      const evidence={version:1,sessionId:'s1',commands:['npm test','git diff --check'],recipeHash:'1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',before:snapshot,after:snapshot};
      const current={state:'current',reason:'Git-visible content and the saved command recipe match this run.',checkedAt:now};
      const historical={state:'unavailable',reason:'This historical run has no recorded checkout comparison.',checkedAt:now};
      window.__reviewCheckout={run:${before} ? run : {...run,evidence,freshness:current},currentRun:{...run,evidence,freshness:current},sessionCwd:'/example/storefront-isolated',projectRun:${before} ? run : {...run,id:'project-review-one',evidence:null,freshness:historical},runCalls:[],historyCalls:[],historyFail:false};const state=window.__reviewCheckout;
      const sessions=proxy(api.sessions,{list:async()=>(await api.sessions.list()).filter(s=>s.id==='s1').map(s=>({...s,projectPath:'/example/storefront',worktree:state.sessionCwd,displayTitle:'Repair checkout validation',harnessId:'claude-code',capabilities:{hooks:false}})),baseline:async()=>({head:'a1b2c3d',dirty:[],at:now-90000}),buffer:async()=>''});
      const code=proxy(api.code,{editors:async()=>[],changes:async()=>({isRepo:true,branch:'wanigan/checkout-validation',headMoved:false,commits:0,files:[{path:'src/checkout.ts',index:' ',work:'M',staged:false,untracked:false,preexisting:false}],attributed:true,unreadable:null}),diff:async()=> ['diff --git a/src/checkout.ts b/src/checkout.ts','--- a/src/checkout.ts','+++ b/src/checkout.ts','@@ -12,3 +12,4 @@',' export function validateCheckout(cart) {','+  if (cart.items.length === 0) return { ok: false };','   return { ok: true };',' }'].join(String.fromCharCode(10))});
      const review=proxy(api.review,{recipe:async()=>({projectId:'p1',commands:['npm test','git diff --check'],updatedAt:now-50000}),history:async(projectId,limit,sessionId)=>{state.historyCalls.push([projectId,limit,sessionId??null]);if(state.historyFail)throw Error('Synthetic comparison temporarily unavailable');return [structuredClone(sessionId?state.run:state.projectRun)];},run:async(projectId,sessionId)=>{state.runCalls.push([projectId,sessionId??null]);return structuredClone(sessionId?state.run:state.projectRun);}});
      const worktrees=proxy(api.worktrees,{setup:async projectId=>({projectId,depsMode:'skip',setup:[],teardown:[],updatedAt:null,include:{state:'absent'}}),commandRuns:async()=>[]});
      window.wanigan=proxy(api,{sessions,code,review,worktrees,prefs:proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})}),handoff:proxy(api.handoff,{plan:async()=>({targets:[]})}),policy:proxy(api.policy,{trust:async()=>'project'})});
    })();
  `);
  let url = rendererURL;
  if (before) {
    const fixtureRoot = '/private/tmp/wanigan-review-checkout-before-renderer-20260915';
    fixtureServer = http.createServer((req, res) => {
      const file = path.join(fixtureRoot, (req.url ?? '/').split('?')[0]);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      createReadStream(file).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
    });
    await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
    fixtureServer.unref(); url = 'http://127.0.0.1:' + fixtureServer.address().port + '/index.html';
  }
  const go = async key => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(key); };
  const showSessionChecks = async () => {
    if (!before) await page.getByRole('group', { name: 'Session review section', exact: true })
      .getByRole('button', { name: 'Checks & evidence', exact: true }).click();
  };
  const shots = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        if (!document.getElementById('review-fixture-provenance')) {
          const label=document.createElement('div');label.id='review-fixture-provenance';label.textContent='SYNTHETIC REVIEW FIXTURE · NO REAL AGENTS';
          label.style.cssText='position:fixed;right:8px;bottom:3px;z-index:999999;background:#111;color:#fff;padding:3px 6px;font:10px monospace;pointer-events:none';document.body.append(label);
        }
      }, theme);
      await page.screenshot({ path: path.join(out, name + '-' + theme + '.png'), scale: 'css', animations: 'disabled' });
    }
  };
  await page.goto(url); await page.locator('.shell').waitFor();
  await go('Meta+1');
  await page.getByRole('button', { name: 'Review work', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review session work' }).waitFor();
  await page.locator('.session-review .code-panel').getByRole('button', { name: /src\/checkout.ts/ }).click();
  if (!before) await shots('session-review-changes');
  await showSessionChecks();
  await page.locator('.review-result > summary').first().click();
  await check('Session Review has code and recorded checks', async () => {
    assert.equal(await page.locator('.session-review .code-panel').count(), 1);
    assert.match(await page.locator('.session-review').innerText(), /Synthetic fixture: 28 tests passed/);
    assert.equal(await page.getByRole('textbox', { name: 'Review gate commands', exact: true }).count(), 1);
  });
  if (before) await check('Baseline identifies project-checkout checks separately', async () => assert.match(await page.locator('.session-review').innerText(), /not this session’s isolated worktree/));
  if (!before) {
    await check('Session history requests the recorded session scope', async () => {
      assert((await page.evaluate(() => window.__reviewCheckout.historyCalls)).some(args => args[0] === 'p1' && args[1] === 12 && args[2] === 's1'));
      assert.match(await page.locator('.session-review').innerText(), /Content matches/);
      assert.equal(await page.locator('.session-review-toolbar .session-history-identity').innerText(), '/example/storefront-isolated');
    });
    await page.getByRole('button', { name: 'Run checks', exact: true }).click();
    await check('Run checks sends project and session IDs without renderer cwd', async () => {
      await page.waitForFunction(() => window.__reviewCheckout.runCalls.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__reviewCheckout.runCalls[0]), ['p1', 's1']);
    });
  }
  await shots('session-review');
  if (!before) {
    await page.evaluate(() => { window.__reviewCheckout.run.freshness = { state: 'stale', reason: 'Git-visible content changed after these commands ran. Run checks again for the current checkout.', checkedAt: Date.now() }; });
    await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
    await check('A stale result cannot retain a current-content success notice', async () => {
      await page.locator('.review-result > summary').filter({ hasText: 'Stale' }).waitFor();
      assert.doesNotMatch(await page.locator('.review-notice').innerText(), /content.*match/i);
    });
    await page.getByRole('textbox', { name: 'Review gate commands', exact: true }).fill('npm run my-unsaved-check');
    await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
    await check('A stale comparison preserves passed commands and the unsaved recipe', async () => {
      await page.locator('.review-result > summary').filter({ hasText: 'Stale' }).waitFor();
      assert.match(await page.locator('.review-result > summary').innerText(), /passed/);
      assert.equal(await page.getByRole('textbox', { name: 'Review gate commands', exact: true }).inputValue(), 'npm run my-unsaved-check');
      assert.match(await page.locator('.review-result').innerText(), /Git-visible content changed/);
    });
    await shots('session-review-stale');
    await page.evaluate(() => { window.__reviewCheckout.historyFail = true; });
    await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
    await check('An unavailable comparison preserves evidence without a current badge', async () => {
      await page.getByText('Synthetic comparison temporarily unavailable', { exact: false }).waitFor();
      assert.match(await page.locator('.review-result > summary').innerText(), /Unverified/);
      assert.match(await page.locator('.review-result').innerText(), /Synthetic fixture: 28 tests passed/);
      assert.equal(await page.getByRole('textbox', { name: 'Review gate commands', exact: true }).inputValue(), 'npm run my-unsaved-check');
    });
    await shots('session-review-comparison-unavailable');
    await page.evaluate(() => { window.__reviewCheckout.historyFail = false; });
    await page.getByRole('button', { name: 'Retry results', exact: true }).click();
    await page.evaluate(() => { window.__reviewCheckout.run.evidence = null; window.__reviewCheckout.run.freshness = { state: 'unavailable', reason: 'This historical run has no recorded checkout comparison.', checkedAt: Date.now() }; });
    await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
    await check('Historical runs remain visible without a current-content claim', async () => {
      await page.locator('.review-result > summary').filter({ hasText: 'Unverified' }).waitFor();
      assert.match(await page.locator('.review-result > summary').innerText(), /passed/);
      assert.doesNotMatch(await page.locator('.review-result').innerText(), /Content matches|Checkout:/);
    });
    await shots('session-review-unverified');
  }
  await page.getByRole('button', { name: 'Back to session', exact: true }).click();
  await go('Meta+9'); await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
  await page.locator('.gt-review-controls > summary').filter({ hasText: 'Review gate' }).click();
  await page.locator('.review-result > summary').first().click();
  await check('Project ReviewGate remains available from Changes', async () => assert.match(await page.locator('.review-checks').innerText(), /Synthetic fixture: 28 tests passed/));
  if (!before) {
    await check('Switching to project scope does not retain the session draft', async () => {
      assert.equal(await page.getByRole('textbox', { name: 'Review gate commands', exact: true }).inputValue(), 'npm test\ngit diff --check');
      assert((await page.evaluate(() => window.__reviewCheckout.historyCalls)).some(args => args[0] === 'p1' && args[1] === 12 && args[2] === null));
      assert.match(await page.locator('.review-result').innerText(), /Unverified/);
    });
    await page.getByRole('button', { name: 'Run checks', exact: true }).click();
    await check('Project checks retain their project-only API scope', async () => {
      await page.waitForFunction(() => window.__reviewCheckout.runCalls.length === 2);
      assert.deepEqual(await page.evaluate(() => window.__reviewCheckout.runCalls[1]), ['p1', null]);
    });
  }
  await shots('project-review');
  if (!before) {
    await page.evaluate(() => {
      const state=window.__reviewCheckout;
      state.sessionCwd='/example/storefront-isolated/packages/checkout-validation-for-the-deliberately-long-worktree-path-regression/another-long-directory-name-without-shortening/fixture-worktree';
      state.run=structuredClone(state.currentRun);
      state.run.evidence.before.cwd=state.sessionCwd;
      state.run.evidence.after.cwd=state.sessionCwd;
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await go('Meta+1');
    await page.getByRole('button', { name: 'Review work', exact: true }).click();
    await page.getByRole('dialog', { name: 'Review session work' }).waitFor();
    await showSessionChecks();
    await page.locator('.review-result > summary').first().click();
    await page.locator('.review-result .review-caption').filter({ hasText: 'Checkout:' }).scrollIntoViewIfNeeded();
    await check('A 1024px desktop wraps long checkout provenance without horizontal overflow', async () => {
      const dimensions=await page.locator('.session-review-toolbar, .session-review-checks, .review-result, .review-result .review-caption').evaluateAll(elements => elements.map(element => ({ className:element.className, width:element.clientWidth, scrollWidth:element.scrollWidth })));
      assert(dimensions.every(value => value.scrollWidth <= value.width + 1), JSON.stringify(dimensions));
      assert.match(await page.locator('.session-review-toolbar .session-history-identity').innerText(), /deliberately-long-worktree-path-regression/);
      assert.match(await page.locator('.session-review-checks').innerText(), /deliberately-long-worktree-path-regression/);
    });
    await shots('session-review-1024-long-path');
  }
} catch (error) {
  failures.push({ name: 'Probe orchestration', error: String(error.stack ?? error) });
  if (page) for (const detail of await page.locator('.view-recovery-details').allTextContents()) {
    failures.push({ name: 'Renderer view recovery', error: detail });
  }
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), provenance: 'Built renderer in isolated Electron, synthetic bridge; no real main, Git commands, agent calls, or user-data writes.', checks, failures, errors }, null, 2) + '\n');
  await app.close(); fixtureServer?.close();
}
if (failures.length || errors.length) process.exitCode = 1;
