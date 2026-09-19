#!/usr/bin/env node
// Built renderer + synthetic bridge only. No main process, Git, provider, or user data.
// WANIGAN_RENDERER_ROOT=/frozen/renderer node scripts/probe-checkpoint-restore.mjs --before
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';

const before = process.argv.includes('--before');
const output = path.resolve(import.meta.dirname, '../docs/visuals/relay-recovery-2026-09-19', before ? 'before' : 'after');
fs.mkdirSync(output, { recursive: true });
const checks = [], errors = [], environmentNotes = [];
const token = '11111111-2222-4333-8444-555555555555';
const instrument = `(() => {
  localStorage.setItem('wanigan.code','1');localStorage.setItem('wanigan.project','p1');
  const api=window.wanigan,now=Date.now(),proxy=(base,overrides)=>new Proxy(base,{get:(target,key)=>key in overrides?overrides[key]:target[key]});
  window.__checkpointRestore={calls:[],previews:[]};const state=window.__checkpointRestore;
  const checkpoint=(id,turn,kind,hash)=>({id,sessionId:'s1',turn,kind,at:now-90000+id*1000,repoRoot:'/example/storefront',commitHash:hash.repeat(40),treeHash:hash.repeat(40),filesChanged:turn?2:null,status:'ok',detail:null});
  const rows=[checkpoint(1,0,'session-start','a'),checkpoint(2,1,'turn-start','b'),checkpoint(3,1,'turn-end','c')];
  const sessions=proxy(api.sessions,{list:async()=>(await api.sessions.list()).filter(session=>session.id==='s1').map(session=>({...session,status:'exited',exitCode:0,endedAt:now-30000,projectPath:'/example/storefront',worktree:null,displayTitle:'Repair checkout validation',harnessId:'claude-code',capabilities:{hooks:true}})),baseline:async()=>({head:'a'.repeat(40),dirty:[],at:now-90000}),buffer:async()=>''});
  const code=proxy(api.code,{editors:async()=>[],changes:async()=>({isRepo:true,branch:'main',headMoved:false,commits:0,files:[{path:'src/checkout.ts',index:' ',work:'M',staged:false,untracked:false,preexisting:false}],attributed:true,unreadable:null})});
  const checkpoints=proxy(api.checkpoints,{
    list:async()=>rows,
    diff:async()=>({from:'b'.repeat(40),to:'c'.repeat(40),files:[{path:'src/checkout.ts',status:'M'},{path:'src/draft.ts',status:'A'}],totalFiles:2,patch:'diff --git a/src/checkout.ts b/src/checkout.ts\\n--- a/src/checkout.ts\\n+++ b/src/checkout.ts\\n@@ -1 +1,2 @@\\n export function checkout() {\\n+  return validateItems();\\n',truncated:false}),
    revertPlan:async(sessionId,checkpointId)=>{state.previews.push([sessionId,checkpointId]);return {ok:true,checkpointId,previewToken:${JSON.stringify(token)},commit:'b'.repeat(40),files:[{path:'src/checkout.ts',action:'restore'},{path:'src/draft.ts',action:'delete'}],totalFiles:2,detail:"Restores 1 file to turn 1's state and deletes 1 created since. A safety snapshot is taken first, so this is undoable."};},
    revert:async(...args)=>{state.calls.push(args);return {ok:false,reverted:0,deleted:0,failed:[],preRevertCheckpointId:4,detail:'The checkout changed after this preview. Preview it again to review the current files. Nothing was changed.'};}
  });
  const worktrees=proxy(api.worktrees,{setup:async projectId=>({projectId,depsMode:'skip',setup:[],teardown:[],updatedAt:null,include:{state:'absent'}}),commandRuns:async()=>[]});
  window.wanigan=proxy(api,{sessions,code,checkpoints,worktrees,prefs:proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})}),handoff:proxy(api.handoff,{plan:async()=>({targets:[]})}),policy:proxy(api.policy,{trust:async()=>'project'})});
})();`;
let renderer;
try {
  renderer = await openRenderer({ width: 1440, height: 1000, instrument, onError: error => {
    if (error.startsWith('Wanigan orb initialization: Error: A WebGPU adapter is unavailable')) environmentNotes.push('Headless Chromium has no WebGPU adapter; the existing orb fallback is shown.');
    else errors.push(error);
  } });
  const { page } = renderer;
  page.setDefaultTimeout(10000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Meta+1');
  await page.getByRole('button', { name: 'Review work', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review session work' }).waitFor();
  const panel = page.locator('.session-review .code-panel');
  await panel.getByRole('button', { name: /^Turns/ }).click();
  await panel.getByRole('button', { name: /Turn 1/ }).click();
  await panel.getByRole('button', { name: 'Restore to before turn 1…', exact: true }).click();
  await panel.getByRole('button', { name: 'Restore 2 files', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__checkpointRestore.previews), [['s1', 2]]);
  assert.match(await panel.innerText(), /src\/checkout.ts — restored/);
  assert.match(await panel.innerText(), /src\/draft.ts — deleted/);
  checks.push('Confirmation shows the recorded checkpoint and exact restore/delete actions.');
  const shots = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        if (!document.getElementById('checkpoint-fixture-provenance')) {
          const label = document.createElement('div'); label.id = 'checkpoint-fixture-provenance';
          label.textContent = 'SYNTHETIC CHECKPOINT FIXTURE · NO REAL FILE RESTORE';
          label.style.cssText = 'position:fixed;right:8px;bottom:3px;z-index:999999;background:#111;color:#fff;padding:3px 6px;font:10px monospace;pointer-events:none';
          document.body.append(label);
        }
      }, theme);
      await page.screenshot({ path: path.join(output, `${name}-${theme}.png`), scale: 'css', animations: 'disabled' });
    }
  };
  await shots('checkpoint-restore-confirmation');
  await panel.getByRole('button', { name: 'Restore 2 files', exact: true }).click();
  await page.waitForFunction(() => window.__checkpointRestore.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__checkpointRestore.calls[0]), before ? ['s1', 2] : ['s1', 2, token]);
  checks.push(before ? 'Frozen baseline sends session and checkpoint IDs without a preview token.'
    : 'Updated renderer sends the exact preview token as the third restore argument.');
  await panel.getByText(/The checkout changed after this preview/).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Restore 2 files', exact: true }).count(), 0);
  checks.push('A synthetic stale-preview refusal is visible and the consumed approval button is removed.');
  await shots('checkpoint-restore-stale');
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (renderer) await renderer.page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), before,
    rendererRoot: process.env.WANIGAN_RENDERER_ROOT ?? 'out/renderer',
    provenance: 'Built renderer in isolated Chromium with a synthetic preload bridge. Verifies rendering and bridge arguments only; no main-process restore, native IPC, provider calls, or real user data.',
    checks, errors, environmentNotes }, null, 2) + '\n');
  await renderer?.close();
}
for (const check of checks) console.log(`PASS ${check}`);
for (const error of errors) console.error(error);
if (errors.length) process.exitCode = 1;
