#!/usr/bin/env node
// Five things that existed and worked but could not be found, each checked in
// the built renderer: every view listed in the sidebar, the worktree strip out
// of its fold, a session-limit refusal that opens its setting, the phone's
// Repository review switch, and Apply kept on screen after Learning approval.
//
// Real built renderer; synthetic bridge data. No main process, PTY, Git work or
// provider launch. `--before` serves a renderer built before this change from
// WANIGAN_BEFORE_RENDERER and captures the same views.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/hidden-features', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-hidden-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:940,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const checks = [], failures = [], errors = [];
let page;
const check = async (name, run) => {
  if (before) { try { await run(); } catch { /* the before build is captured, not graded */ } return; }
  try { await run(); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ name, error: String(error) }); console.log('FAIL ' + name + ': ' + String(error)); }
};

const LIMIT = before
  ? '4 of 4 interactive sessions are already running. Stop one, or raise the "Interactive sessions" limit in Settings › Dispatcher, then start this one again.'
  : '4 of 4 interactive sessions are already running. Stop one, or raise the "Interactive sessions" limit in Settings › Automation › Dispatcher, then start this one again.';

const FIXTURES = `
(()=>{
  localStorage.setItem('wanigan.project','p1');
  const api=window.wanigan, now=Date.now(), proxy=(base,overrides)=>new Proxy(base,{get:(t,p)=>p in overrides?overrides[p]:t[p]});
  const state=window.__probe={prefWrites:[],learning:[],creates:0};
  const noLive=localStorage.getItem('probe.noLive')==='1';
  const recent=[{id:'past-checkout',conversationId:'exact-checkout-handle',providerId:'claude',projectId:'p1',projectPath:'/example/storefront',projectName:'storefront',worktree:null,model:'opus',effort:'high',permissionMode:'default',startedAt:now-3600000,endedAt:now-600000,exitCode:0,continuationCount:1,live:true,pinnedAt:null,settledAt:null,title:'Repair checkout validation',titleSource:'named'}];
  const prefsBase=async()=>({...await api.prefs.all(),motion:'off',navSidebar:'open',mobileRepositoryReview:state.repoReview===true});
  const prefs=proxy(api.prefs,{all:prefsBase,set:async(k,v)=>{state.prefWrites.push([k,v]);if(k==='mobile_repository_review')state.repoReview=v==='1';return prefsBase();}});
  const sessions=proxy(api.sessions,{
    list:async()=>noLive?[]:(await api.sessions.list()).map(s=>({...s,projectPath:s.projectId==='p1'?'/example/storefront':'/example/platform',worktree:s.id==='s1'?'/example/storefront-checkout':null,displayTitle:s.id==='s1'?'Checkout review':null})),
    past:async()=>recent.map(r=>({...r})),
    create:async()=>{state.creates++;throw new Error(${JSON.stringify(LIMIT)});},
    baseline:async()=>null,
  });
  const worktrees=proxy(api.worktrees,{status:async p=>({path:p,branch:'wanigan/checkout-review',head:'abc1234',repoRoot:'/example/storefront',sessionId:'s1',dirty:2,ahead:3})});
  const mobileStatus={config:{dashboardEnabled:false,remoteControlEnabled:false,port:47831,dashboardUrl:'',pushEnabled:false,pushServer:'https://ntfy.sh',pushTopic:'',webPushEnabled:true},running:false,localUrl:'http://127.0.0.1:47831',pairingUrl:'',pairingCode:'',tokenFingerprint:'',error:null,lastPushAt:null,lastPushError:null,pushDevices:[],webPush:{ready:false,blocked:null,lastAt:null,lastError:null}};
  const mobile=proxy(api.mobile,{status:async()=>mobileStatus,alertChannels:async()=>null});
  const candidate=(id,title,status='pending')=>({id,itemId:null,targetKind:'instruction',scope:'project',providerId:'claude',projectId:'p1',pathScope:null,title,proposedText:'Preserve the original order identifier when retrying a timed-out payment callback. Check for a completed payment before creating another charge.',rationale:'Two independent tasks found the same retry boundary.',status,confidence:0.86,evidenceCount:3,taskCount:2,estimatedTokenDelta:40,conflicts:[],createdAt:now-86400000,updatedAt:now-3600000,reviewedAt:null,snoozedAt:null});
  const candidates=window.__candidates=[candidate('c1','Remember the checkout retry boundary'),candidate('c2','Prefer focused verification before handoff')];
  const learningReads={
    settings:{enabled:true,contentMode:'local-same-provider',automation:'hybrid',allowModelAssistance:false,monthlyBudgetUsd:0,briefingMaxTokens:1200,consolidationEnabled:true},
    overview:()=>({pending:candidates.filter(c=>c.status==='pending').length,activeKnowledge:1,quarantined:0,activeSkills:0,experiments:0,signals:12,projectedTokenDelta:0}),
    signals:[],knowledge:[],diagnostics:[],experiments:[],relations:[],unactionableCount:0,candidateSignals:[],
    candidates:()=>candidates,
    pipeline:(a)=>({windowDays:a?.windowDays??30,signals:12,signalsAllTime:12,eligibleSignals:4,candidatesCreated:2,awaitingDecision:2,autoPromoted:0,reviewed:0,itemsPromoted:0,projectionsApplied:0,briefingsServed:0,consolidationRuns:[],consolidationRunsTotal:0,signalsByDay:[]}),
    candidateExplain:(id)=>({candidateId:id,decision:'review',reason:'Project instructions require a human decision.',claimPossible:true,checks:[{label:'Independent tasks',ok:true,actual:'2',required:'2'}]}),
  };
  const learning=new Proxy(api.learning,{get(base,method){
    if(method==='reviewCandidate')return async(id,decision)=>{state.learning.push([method,id,decision]);const c=candidates.find(x=>x.id===id);c.status=({approve:'approved',reject:'rejected',snooze:'snoozed',reopen:'pending'})[decision];c.reviewedAt=Date.now();return c;};
    if(method==='promoteCandidate')return async id=>{state.learning.push([method,id]);candidates.find(x=>x.id===id).status='promoted';return {};};
    if(method==='applyCandidate')return async(id,target)=>{state.learning.push([method,id,target]);candidates.find(x=>x.id===id).status='applied';return {};};
    if(method in learningReads)return async(...args)=>{const v=learningReads[method];return structuredClone(typeof v==='function'?v(...args):v);};
    return base[method];
  }});
  window.wanigan=proxy(api,{prefs,sessions,worktrees,mobile,learning,handoff:proxy(api.handoff,{plan:async()=>({targets:[]})}),policy:proxy(api.policy,{trust:async()=>'project',chain:async()=>{throw new Error('Not read in this fixture');}})});
})();
`;

try {
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + FIXTURES);
  let url = rendererURL;
  if (before) {
    const { default: http } = await import('node:http'); const { default: fs } = await import('node:fs');
    const fixtureRoot = process.env.WANIGAN_BEFORE_RENDERER;
    assert(fixtureRoot, 'Set WANIGAN_BEFORE_RENDERER to a renderer build from before this change.');
    const server = http.createServer((req, res) => { const rel = (req.url ?? '/').split('?')[0]; const file = path.join(fixtureRoot, rel === '/' ? 'index.html' : rel); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html'); fs.createReadStream(file).on('error', () => res.end()).pipe(res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); server.unref(); url = 'http://127.0.0.1:' + server.address().port + '/index.html';
  }
  const shots = async name => {
    await page.evaluate(() => document.activeElement?.blur());
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; if (!document.getElementById('fixture-provenance')) { const label = document.createElement('div'); label.id = 'fixture-provenance'; label.textContent = 'SYNTHETIC FIXTURES · NO REAL AGENTS'; label.style.cssText = 'position:fixed;bottom:2px;right:8px;z-index:999999;background:#111;color:white;font:10px monospace;padding:3px 6px'; document.body.append(label); } }, theme);
      await page.waitForTimeout(60);
      await page.screenshot({ path: path.join(out, name + '-' + theme + '.png'), animations: 'disabled' });
    }
  };
  const chord = async keys => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(keys); };

  await page.goto(url); await page.locator('.shell').waitFor();
  await chord('Meta+1');
  await page.locator('.session-toolbar').waitFor();
  await page.getByRole('button', { name: /^Switch project space:/ }).click();
  await page.getByRole('option').filter({ hasText: 'storefront' }).click();
  await page.locator('.session-config').first().waitFor();

  // 1 · the sidebar lists every view
  await check('The sidebar lists every area’s views while you are in Sessions', async () => {
    const knowledge = page.getByRole('navigation', { name: 'Knowledge views', exact: true });
    await knowledge.waitFor({ timeout: 3000 });
    for (const name of ['Learning', 'Skills', 'Scout', 'Plugins']) assert.equal(await knowledge.getByRole('button', { name, exact: true }).count(), 1, name);
    for (const area of ['Fleet', 'Automation']) assert.equal(await page.getByRole('navigation', { name: `${area} views`, exact: true }).count(), 1, area);
  });
  await check('Only the current area’s views are Tab stops', async () => {
    assert.equal(await page.getByRole('navigation', { name: 'Knowledge views', exact: true }).getByRole('button', { name: 'Skills', exact: true }).getAttribute('tabindex'), '-1');
    assert.equal(await page.getByRole('navigation', { name: 'Projects views', exact: true }).getByRole('button', { name: 'Changes', exact: true }).getAttribute('tabindex'), null);
  });

  // 2 · the worktree strip
  await check('Worktree Merge and Discard are on screen without opening Session controls', async () => {
    const strip = page.locator('.session-worktree-strip');
    await strip.waitFor({ timeout: 3000 });
    await strip.getByText('wanigan/checkout-review', { exact: true }).waitFor();
    assert.equal(await strip.getByRole('button', { name: 'Merge', exact: true }).isVisible(), true);
    assert.equal(await strip.getByRole('button', { name: 'Discard…', exact: false }).first().isVisible(), true);
    assert.equal(await page.locator('.session-controls[open]').count(), 0);
  });
  await shots('sessions-sidebar-worktree');

  // 3 · a limit refusal opens its setting
  await page.getByRole('button', { name: 'New session (Command T)', exact: true }).click();
  const launch = page.getByRole('dialog', { name: 'New session' });
  await launch.waitFor();
  await launch.getByRole('button', { name: /^Start (session|in a worktree)$/ }).click();
  await launch.getByText(/interactive sessions are already running/).waitFor();
  await shots('session-limit-refusal');
  await check('The refusal names the tab the setting is really on and offers to open it', async () => {
    assert.match(await launch.locator('.note').first().innerText(), /Settings › Automation › Dispatcher/);
    await launch.getByRole('button', { name: 'Open Dispatcher settings', exact: true }).click();
    await launch.waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: /Automation/ }).and(page.locator('[aria-selected="true"]')).waitFor();
    await page.getByRole('heading', { name: 'Dispatcher', exact: true }).first().waitFor();
  });
  if (!before) await shots('dispatcher-opened');
  // The old build offers no door, so its dialog is still open; close it by hand.
  if (before && await launch.count()) { await page.keyboard.press('Escape'); await launch.waitFor({ state: 'detached' }); }

  // 3b · a refused resume is said inside the Resume dialog, with the same door
  if (!before) {
    await chord('Meta+1');
    await page.locator('.session-toolbar').waitFor();
    await chord('Meta+Shift+T');
    const history = page.getByRole('dialog', { name: 'Resume a session' });
    await history.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search saved conversations');
    await history.getByRole('button', { name: 'Resume session', exact: true }).click();
    await check('A refused resume is shown inside the Resume dialog, not under its scrim', async () => {
      await history.getByText(/did not resume/).waitFor();
      assert.match(await history.locator('.session-history-error').innerText(), /Settings › Automation › Dispatcher/);
    });
    await shots('resume-refusal');
    await check('The Resume dialog’s refusal opens the Dispatcher section', async () => {
      await history.getByRole('button', { name: 'Open Dispatcher settings', exact: true }).click();
      await history.waitFor({ state: 'detached' });
      await page.getByRole('heading', { name: 'Dispatcher', exact: true }).first().waitFor();
    });
  }

  // 4 · the Repository review switch
  await chord('Meta+,');
  await page.getByRole('tab', { name: /Connections/ }).click();
  await page.getByRole('heading', { name: 'Phone monitor', exact: true }).first().waitFor();
  await page.getByRole('switch', { name: 'Allow paired iPad control', exact: true }).scrollIntoViewIfNeeded();
  await shots('phone-monitor');
  await check('Settings has a Repository review switch, and it writes the setting main gates on', async () => {
    const toggle = page.getByRole('switch', { name: 'Allow Repository review', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await page.waitForFunction(() => window.__probe.prefWrites.some(([k, v]) => k === 'mobile_repository_review' && v === '1'));
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Allow Repository review"]')?.getAttribute('aria-checked') === 'true');
  });

  // 5 · Apply stays after Learning approval
  await chord('Meta+6');
  await page.getByRole('heading', { name: 'Learning', exact: true }).first().waitFor();
  await page.getByRole('tab', { name: /^Inbox/ }).click();
  await page.getByRole('button', { name: /Remember the checkout retry boundary/ }).click();
  await page.getByRole('button', { name: 'Approve to knowledge', exact: true }).click();
  await page.waitForFunction(() => window.__probe.learning.some(([m]) => m === 'promoteCandidate'));
  await page.waitForTimeout(300);
  await shots('learning-after-approve');
  await check('An approved instruction stays on screen with Apply as its next step', async () => {
    const reader = page.getByLabel('Selected proposal');
    await reader.getByRole('heading', { name: 'Remember the checkout retry boundary', exact: true }).waitFor();
    const apply = reader.getByRole('button', { name: /^Apply to / });
    assert.equal(await apply.isVisible(), true);
    await apply.click();
    await page.waitForFunction(() => window.__probe.learning.some(([m]) => m === 'applyCandidate'));
    await reader.getByText(/^Applied to /).waitFor();
    await reader.getByRole('button', { name: 'Next proposal', exact: true }).click();
    await reader.getByRole('heading', { name: 'Prefer focused verification before handoff', exact: true }).waitFor();
  });

  // 6 · the shell toast carries the door too, for a refusal raised outside a dialog
  if (!before) {
    await page.evaluate(() => localStorage.setItem('probe.noLive', '1'));
    await page.reload(); await page.locator('.shell').waitFor();
    await chord('Meta+1');
    await page.getByRole('button', { name: 'Resume Repair checkout validation', exact: true }).click();
    await check('A refusal in the shell toast offers the Settings section it names', async () => {
      const toast = page.locator('.toast');
      await toast.getByText(/interactive sessions are already running/).waitFor();
      await shots('toast-refusal');
      await toast.getByRole('button', { name: 'Open Dispatcher settings', exact: true }).click();
      await page.getByRole('heading', { name: 'Dispatcher', exact: true }).first().waitFor();
      assert.equal(await page.locator('.toast').count(), 0);
    });
  }
} catch (error) { failures.push({ name: 'Probe orchestration', error: String(error.stack ?? error) }); if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally { await page?.evaluate(() => localStorage.removeItem('probe.noLive')).catch(() => {}); writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), provenance: 'Isolated Electron renderer and synthetic bridge. No real main, providers, PTY, git or settings writes.', checks, failures: before ? failures.filter(f => f.name === 'Probe orchestration') : failures, errors }, null, 2) + '\n'); await app.close(); }
if (failures.length || errors.length) process.exitCode = 1;
