#!/usr/bin/env node
// Resume a session: the header's joined New session / Resume control, ⌘⇧T, and
// the history dialog — banded Recent, instant filter, archive search, Turns &
// restore, pin and settle, and an exact resume on ⌘↵.
//
// Real built renderer; synthetic bridge data. No main process, PTY, Git work or
// provider launch. `--before` serves a renderer built before this change from
// WANIGAN_BEFORE_RENDERER and captures the same views for comparison.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/resume-session', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-evidence-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:940,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const checks = [], failures = [], errors = [];
let page;
const check = async (name, run) => {
  try { await run(); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ name, error: String(error) }); console.log('FAIL ' + name + ': ' + String(error)); }
};

// Every fixture is generic and every time is relative to the probe's own clock.
// "Today" rows are clamped past local midnight so a run at 00:05 still bands them.
const FIXTURES = `
(()=>{
  localStorage.setItem('wanigan.project','p1');
  const api=window.wanigan, now=Date.now(), proxy=(base,overrides)=>new Proxy(base,{get:(t,p)=>p in overrides?overrides[p]:t[p]});
  const midnight=new Date(now); midnight.setHours(0,0,0,0);
  const today=ms=>Math.max(midnight.getTime()+60000, now-ms), day=86400000;
  const base={providerId:'claude',projectId:'p1',projectPath:'/example/storefront',projectName:'storefront',worktree:null,model:'opus',effort:'high',permissionMode:'default',exitCode:0,continuationCount:1,live:true,pinnedAt:null,settledAt:null,titleSource:'named'};
  const recent=[
    {...base,id:'past-checkout',conversationId:'exact-checkout-handle',title:'Repair checkout validation',startedAt:today(80*60000),endedAt:today(4*60000),continuationCount:2},
    {...base,id:'past-invoice',conversationId:'invoice-handle',providerId:'codex',model:'gpt-5.5',effort:'medium',title:'Invoice PDF totals drift after tax change',worktree:'/example/storefront-invoice',startedAt:today(5*3600000),endedAt:today(3*3600000)},
    {...base,id:'past-cart',conversationId:'cart-handle',model:'sonnet',title:'Migrate cart to server actions',startedAt:now-day-2*3600000,endedAt:now-day-3600000,exitCode:1},
    {...base,id:'past-grid',conversationId:'grid-handle',title:'Accessibility pass on the product grid',startedAt:now-4*day,endedAt:now-4*day+2400000,pinnedAt:now-3600000},
    {...base,id:'past-sdk',conversationId:'sdk-handle',providerId:'codex',model:'gpt-5.5',title:'Upgrade payment SDK',projectPath:'/example/storefront-archived',startedAt:now-20*day,endedAt:now-20*day+900000,live:false},
    {...base,id:'past-ranking',conversationId:'ranking-handle',title:'Spike: search ranking signals',startedAt:now-2*day,endedAt:now-2*day+600000,settledAt:now-day},
    {...base,id:'past-rail',conversationId:'rail-handle',providerId:'codex',model:'gpt-5.5',projectId:'p2',projectPath:'/example/platform',projectName:'platform',title:'Rail layout regression on narrow windows',startedAt:today(30*60000),endedAt:today(20*60000)},
  ];
  const state=window.__history={creates:[],reads:[],pastScopes:[],flags:[],flagsRecent:recent};
  const noLive=localStorage.getItem('probe.noLive')==='1';
  const sessions=proxy(api.sessions,{
    past:async scope=>{state.pastScopes.push(scope);return recent.filter(r=>scope==null||r.projectId===scope).map(r=>({...r}));},
    setConversationFlag:async(id,flag,on)=>{state.flags.push([id,flag,on]);const r=recent.find(x=>x.id===id);if(r){if(flag==='pin')r.pinnedAt=on?now:null;else r.settledAt=on?now:null;}return recent;},
    list:async()=>noLive?[]:(await api.sessions.list()).map(s=>({...s,projectPath:s.projectId==='p1'?'/example/storefront':'/example/platform',worktree:s.id==='s1'?'/example/storefront-isolated':null,displayTitle:s.id==='s1'?'Checkout review':null})),
    create:async opts=>{state.creates.push(opts);return {...(await api.sessions.list())[0],id:'resumed-checkout'};},
    baseline:async()=>null,
  });
  const conversation=id=>{
    if(id==='past-checkout')return Array.from({length:205},(_,i)=>({at:now-(205-i)*1000,role:i%2?'assistant':'user',text:i===204?'Latest checkout outcome is preserved':i===203?'Can you confirm the validation fix holds for guest checkout too?':'Synthetic recorded turn '+i}));
    if(id==='older-record')return [{at:now-600000,role:'assistant',text:'Older archive: nebula-keyword recovered'}];
    return [
      {at:now-900000,role:'user',text:'Look into why this is happening and propose a fix before changing anything.'},
      {at:now-880000,role:'tool',toolName:'Read',text:'src/example/module.ts (212 lines)'},
      {at:now-860000,role:'assistant',text:'The value is computed before the adjustment is applied, so the stored total is stale by one step. Two options: recompute on read, or move the adjustment earlier. I recommend the second; it is one call site.'},
      {at:now-840000,role:'user',text:'Go with the second option and add a regression test.'},
      {at:now-600000,role:'assistant',text:'Done. The adjustment now runs first, and a test covers the case that failed. All suites pass locally.'},
    ];
  };
  const transcripts=proxy(api.transcripts,{
    list:async()=>[{sessionId:'past-checkout',bytes:1234,turns:205,archivedAt:now-5000},{sessionId:'older-record',bytes:200,turns:2,archivedAt:now-40*day},{sessionId:'older-record-2',bytes:900,turns:14,archivedAt:now-60*day}],
    get:async id=>{state.reads.push(id);return {bytes:1234,note:null,turns:conversation(id)};},
    search:async q=>/nebula/i.test(q)?[
      {sessionId:'older-record',projectName:'platform',projectPath:'/example/platform',providerId:'codex',startedAt:now-40*day,snippet:'Older «nebula-keyword» recovered from the migration notes',role:'assistant',at:now-40*day},
      {sessionId:'past-rail',projectName:'platform',projectPath:'/example/platform',providerId:'codex',startedAt:now-3600000,snippet:'the «nebula-keyword» flag still hides the rail below 960px',role:'user',at:now-3600000},
    ]:[],
  });
  const cp=(id,turn,kind,files)=>({id,sessionId:'past-checkout',turn,kind,at:now-(40-id)*60000,repoRoot:'/example/storefront',commitHash:'c0ffee'+id,treeHash:'7ree'+id,filesChanged:files,status:'ok',detail:null});
  const checkpoints=proxy(api.checkpoints,{
    list:async id=>id==='past-checkout'?[cp(1,0,'session-start',null),cp(2,1,'turn-start',null),cp(3,1,'turn-end',3),cp(4,2,'turn-start',null),cp(5,2,'turn-end',1),cp(6,3,'turn-start',null),cp(7,3,'turn-end',2)]:[],
    diff:async()=>({from:'c0ffee2',to:'c0ffee3',files:[{path:'src/Checkout/Validator.php',status:'M'},{path:'tests/CheckoutValidatorTest.php',status:'A'}],totalFiles:2,patch:'',truncated:false}),
  });
  const code=proxy(api.code,{editors:async()=>[],changes:async()=>({isRepo:true,branch:'main',headMoved:false,commits:0,files:[],attributed:false,unreadable:null})});
  const review=proxy(api.review,{recipe:async()=>({projectId:'p1',commands:['npm test'],updatedAt:now}),history:async()=>[]});
  window.wanigan=proxy(api,{sessions,transcripts,checkpoints,code,review,prefs:proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})}),handoff:proxy(api.handoff,{plan:async()=>({targets:[]})}),policy:proxy(api.policy,{trust:async()=>'project'})});
})();
`;

try {
  page = await app.firstWindow(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + FIXTURES);
  let url = rendererURL;
  if (before) {
    const { default: http } = await import('node:http'); const { default: fs } = await import('node:fs');
    const fixtureRoot = process.env.WANIGAN_BEFORE_RENDERER ?? '/private/tmp/wanigan-workflow-before-renderer';
    const server = http.createServer((req, res) => { const rel = (req.url ?? '/').split('?')[0]; const file = path.join(fixtureRoot, rel === '/' ? 'index.html' : rel); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html'); fs.createReadStream(file).on('error', () => res.end()).pipe(res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); server.unref(); url = 'http://127.0.0.1:' + server.address().port + '/index.html';
  }
  const open = async () => {
    await page.goto(url); await page.locator('.shell').waitFor();
    await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Meta+1');
    await page.getByRole('button', { name: /^Switch project space:/ }).click();
    await page.getByRole('option').filter({ hasText: 'storefront' }).click();
    await page.locator('.past-main').first().waitFor();
  };
  const shots = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; if (!document.getElementById('fixture-provenance')) { const label = document.createElement('div'); label.id = 'fixture-provenance'; label.textContent = 'SYNTHETIC FIXTURES · NO REAL AGENTS'; label.style.cssText = 'position:fixed;bottom:2px;right:8px;z-index:999999;background:#111;color:white;font:10px monospace;padding:3px 6px'; document.body.append(label); } }, theme);
      await page.waitForTimeout(60);
      await page.screenshot({ path: path.join(out, name + '-' + theme + '.png'), animations: 'disabled' });
    }
  };
  await open();
  await shots('sessions');

  if (before) {
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('dialog', { name: 'Conversation history' }).waitFor();
    await page.getByText('Latest checkout outcome is preserved', { exact: true }).waitFor().catch(() => {});
    await shots('history-dialog');
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('probe.noLive', '1'));
    await open(); await shots('sessions-empty');
  } else {
    const dialog = page.getByRole('dialog', { name: 'Resume a session' });
    await check('The header pairs Resume with New session and names its chord', async () => {
      const pair = page.getByRole('group', { name: 'Sessions', exact: true });
      assert.equal(await pair.getByRole('button').count(), 2);
      const resume = pair.getByRole('button', { name: /^Resume a saved conversation/ });
      assert.match(await resume.getAttribute('aria-keyshortcuts'), /Meta\+Shift\+T/);
    });
    await page.getByRole('group', { name: 'Sessions', exact: true }).getByRole('button', { name: /^Resume a saved conversation/ }).click();
    await check('Opening Resume reads history and launches nothing', async () => {
      await dialog.waitFor();
      assert.equal(await page.evaluate(() => window.__history.creates.length), 0);
    });
    await check('Recent is banded Pinned, Today, Yesterday, Previous 7 days, Earlier, Settled with the settled shelf closed', async () => {
      await page.locator('.session-history-row').first().waitFor();
      const heads = await page.locator('.session-history-band > .sec-head .label').allInnerTexts();
      assert.deepEqual(heads.slice(0, 6).map(h => h.toLowerCase()), ['pinned', 'today', 'yesterday', 'earlier', 'settled', 'older archives']);
      assert.equal(await dialog.getByRole('button', { name: /Spike: search ranking/ }).count(), 0);
    });
    await check('The newest conversation is chosen and its last turn is in view', async () => {
      assert.equal(await page.locator('.session-history-row[aria-pressed="true"]').innerText().then(t => t.includes('Repair checkout validation')), true);
      await dialog.getByText('Latest checkout outcome is preserved', { exact: true }).waitFor();
      assert.equal(await dialog.getByText('Latest checkout outcome is preserved', { exact: true }).isVisible(), true);
      const facts = await page.locator('.session-history-facts').innerText();
      assert.match(facts, /Claude Code/); assert.match(facts, /opus/); assert.match(facts, /Launches\s+2/);
    });
    await shots('resume-dialog');

    const search = dialog.getByRole('searchbox', { name: 'Search saved conversations' });
    await check('The search box has focus when the dialog opens', async () => assert.equal(await search.evaluate(el => el === document.activeElement), true));
    await search.press('ArrowDown');
    await check('Arrow keys from the search box move the selection', async () => {
      assert.match(await page.locator('.session-history-row[aria-pressed="true"]').innerText(), /Invoice PDF totals/);
    });
    await search.fill('cart');
    await check('Typing filters names instantly and selects the first match', async () => {
      await page.waitForFunction(() => document.querySelectorAll('.session-history-band .session-history-row').length === 1);
      assert.match(await page.locator('.session-history-row[aria-pressed="true"]').innerText(), /Migrate cart/);
    });
    await search.fill('nebula-keyword');
    await check('Three letters or more also search what was said, with the match marked', async () => {
      await page.locator('.session-history-hit').first().waitFor();
      assert.equal(await page.locator('.session-history-hit').first().innerText(), 'nebula-keyword');
    });
    await shots('resume-search');
    await dialog.getByRole('button', { name: /Older nebula-keyword recovered/ }).click();
    await check('An archive outside Recent is readable and cannot be resumed', async () => {
      await dialog.getByText('Older archive: nebula-keyword recovered', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Resume session', exact: true }).isDisabled(), true);
      assert.match(await page.locator('.session-history-consequence').innerText(), /Read-only/);
    });
    await search.fill('');
    await dialog.getByRole('button', { name: 'All projects', exact: true }).click();
    await check('All projects reads Recent unscoped and shows another project', async () => {
      await dialog.getByRole('button', { name: /Rail layout regression/ }).waitFor();
      assert((await page.evaluate(() => window.__history.pastScopes)).includes(null));
    });
    await dialog.getByRole('button', { name: 'storefront', exact: true }).click();
    await dialog.getByRole('button', { name: /Upgrade payment SDK/ }).click();
    await check('A conversation whose folder is missing reads but does not resume', async () => {
      await dialog.getByText(/The project folder is missing/).first().waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Resume session', exact: true }).isDisabled(), true);
    });
    await dialog.getByRole('button', { name: /Show 1 settled conversation/ }).click();
    await dialog.getByRole('button', { name: /Spike: search ranking/ }).click();
    await dialog.getByRole('button', { name: '⤒ Restore to Recent', exact: true }).click();
    await check('A settled conversation restores to Recent through the lifecycle flag', async () => {
      await page.waitForFunction(() => window.__history.flags.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__history.flags[0]), ['past-ranking', 'settle', false]);
    });
    await dialog.getByRole('button', { name: /Repair checkout validation/ }).click();
    await dialog.getByRole('button', { name: '☆ Pin', exact: true }).click();
    await check('Pin writes the flag and the row moves into Pinned', async () => {
      await page.waitForFunction(() => window.__history.flags.length === 2);
      assert.deepEqual(await page.evaluate(() => window.__history.flags[1]), ['past-checkout', 'pin', true]);
      await dialog.getByRole('button', { name: '★ Pinned', exact: true }).waitFor();
    });
    await dialog.getByRole('button', { name: 'Turns & restore', exact: true }).click();
    await check('Turns & restore shows the finished run’s turns without launching', async () => {
      await page.locator('.session-history-evidence .code-panel').waitFor();
      await dialog.getByText('Turn 3', { exact: false }).first().waitFor();
      assert.equal(await page.evaluate(() => window.__history.creates.length), 0);
    });
    await shots('resume-turns');
    await dialog.getByRole('button', { name: 'Conversation', exact: true }).click();
    await dialog.getByText('Latest checkout outcome is preserved', { exact: true }).waitFor();
    await page.keyboard.press('Meta+Enter');
    await check('⌘↵ resumes the exact durable handle and closes the dialog', async () => {
      await page.waitForFunction(() => window.__history.creates.length === 1);
      const value = await page.evaluate(() => window.__history.creates[0]);
      assert.deepEqual(value.resumeFrom, { sessionId: 'past-checkout', conversationId: 'exact-checkout-handle' });
      assert.equal(value.projectId, 'p1'); assert.equal(value.permissionMode, 'default'); assert.equal(value.model, 'opus');
      await dialog.waitFor({ state: 'detached' });
    });

    // A resumed session's terminal takes focus a frame or two later, and shell
    // chords are dead inside a terminal by design — so let it land, then leave it.
    await page.waitForTimeout(400);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Meta+Shift+T');
    // Mounted is not ready: focus and the dialog's key handler land in effects
    // after the first paint, and a key sent inside that frame reaches neither.
    const settled = () => page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search saved conversations');
    await check('⌘⇧T opens Resume from the shell', async () => { await dialog.waitFor(); await settled(); });
    await page.keyboard.press('Escape');
    await check('Escape closes Resume', async () => { await dialog.waitFor({ state: 'detached' }); });

    await page.setViewportSize({ width: 960, height: 560 });
    await page.getByRole('button', { name: /^Resume a saved conversation/ }).last().click();
    await dialog.waitFor();
    await page.locator('.session-history-row').first().waitFor();
    await settled();
    await shots('resume-960x560');
    await check('A short window keeps the list, the choice and the Resume button on screen', async () => {
      for (const selector of ['.session-history-list', '.session-history-reading', '.session-history-resume']) {
        const box = await page.locator(selector).boundingBox();
        assert(box && box.height > 20 && box.y + 10 < 560, selector + ' ' + JSON.stringify(box));
      }
    });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 940 });

    await page.evaluate(() => localStorage.setItem('probe.noLive', '1'));
    await open();
    await check('With nothing running, Sessions offers the newest live conversations to pick up', async () => {
      const pickup = page.getByRole('region', { name: 'Pick up where you left off' });
      await pickup.waitFor();
      assert.equal(await pickup.locator('.sessions-pickup-row').count(), 3);
      assert.match(await pickup.locator('.sessions-pickup-row').first().innerText(), /Accessibility pass/);
    });
    await shots('sessions-empty');
    await page.getByRole('button', { name: 'Resume Repair checkout validation', exact: true }).click();
    await check('A pick-up row resumes on its own button', async () => {
      await page.waitForFunction(() => window.__history.creates.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__history.creates[0].resumeFrom), { sessionId: 'past-checkout', conversationId: 'exact-checkout-handle' });
    });
  }
} catch (error) { failures.push({ name: 'Probe orchestration', error: String(error.stack ?? error) }); if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally { await page?.evaluate(() => localStorage.removeItem('probe.noLive')).catch(() => {}); writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), provenance: 'Isolated Electron renderer and synthetic bridge. No real main, providers, PTY, or archive writes.', checks, failures, errors }, null, 2) + '\n'); await app.close(); }
if (failures.length || errors.length) process.exitCode = 1;
