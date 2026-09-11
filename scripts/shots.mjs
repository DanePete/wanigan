#!/usr/bin/env node
// Screenshot every Wanigan view from the real Electron build into docs/shots/.
//
// Why this exists: the renderer has no UI tests, so a change to a view is
// only ever seen by whoever happens to open it. This drives the built app
// headlessly through Playwright, seeds one project, one docket and one
// learning candidate over the real IPC surface (so the same validation a user
// hits runs), and writes 1440x900 captures of every view in both themes plus a
// 960px window. Attach before/after shots to any UI change (CONTRIBUTING.md).
//
// Usage:  npm run build && node scripts/shots.mjs [--out docs/shots] [--light]
// Requires playwright-core to be resolvable (it ships as a transitive
// dependency today; `npm i -D playwright-core` if that ever changes). Never
// touches the real user-data directory: it launches with a temp one.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchWanigan } from './electron-harness.mjs';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const require = createRequire(import.meta.url);

let electron;
try { ({ _electron: electron } = require('playwright-core')); }
catch { console.error('playwright-core is not resolvable from this repo; run `npm i -D playwright-core` and retry.'); process.exit(2); }

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : 'docs/shots');
const themes = args.includes('--light') ? ['dark', 'light'] : ['dark'];
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'runtime-log.txt');
writeFileSync(LOG, '');
const log = (s) => { appendFileSync(LOG, s + '\n'); console.log(s); };

if (!existsSync(path.join(REPO, 'out/main/index.js'))) { console.error('No build in out/. Run `npm run build` first.'); process.exit(2); }

// Same environment scrub as scripts/launch.sh: a VS Code shell exports
// ELECTRON_RUN_AS_NODE, which makes the binary run as plain Node and die.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];
const udd = mkdtempSync(path.join(tmpdir(), 'wanigan-shots-'));

// `--wanigan-automation` is the launch marker src/main/automation.ts reads.
// It is the only mode in which the raw projects:add channel answers: a
// headless run cannot click the folder picker that registers a root for a
// person, and the marker cannot be reached from the page, only from argv.
// An installed build refuses it outright (app.isPackaged).
const errors=[];
const layoutMeasurements=[];
const {app,page}=await launchWanigan(electron,{root:REPO,userData:udd,env});
try {
log('Electron connected');
log('Window opened: ' + page.url());
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) log(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => { errors.push(e.message); log(`[pageerror] ${e.message}`); });
await page.waitForSelector('.nav-tabs, .sidebar, nav', { timeout: 120_000 });
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.show(); });
await page.waitForTimeout(800);
await page.waitForSelector('.mission-room');
await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
const canvas=page.locator('.wanigan-orb canvas');
await page.evaluate(()=>{document.documentElement.dataset.motion='full';});
await page.getByRole('textbox',{name:'Talk to Wanigan',exact:true}).focus();
await page.waitForFunction(()=>document.querySelector('.wanigan-orb canvas')?.dataset.expression==='attend');
await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
await page.getByRole('button',{name:'Spin Wanigan',exact:true}).click();
await page.keyboard.press('Escape');
await page.waitForFunction(()=>Number(document.querySelector('.wanigan-orb canvas')?.dataset.yaw)>3);
await page.waitForTimeout(1700);
// Main-owned native visibility stops the GPU even when automation leaves
// document.hidden false. Test actual hide/show and actual preload subscription.
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
await page.waitForFunction(()=>document.querySelector('.wanigan-orb canvas')?.dataset.nativeVisibility==='hidden');
assert.equal(await page.evaluate(()=>window.wanigan.windowVisibility.current()),false);
// One already-submitted GPU frame may finish after the window is hidden.
// Count submissions, rather than treating its delayed completion as new work.
const paused=await canvas.getAttribute('data-submissions');await page.waitForTimeout(500);
assert.equal(await canvas.getAttribute('data-submissions'),paused,'native hide must stop GPU submissions');
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
await page.waitForFunction(prior=>document.querySelector('.wanigan-orb canvas')?.dataset.submissions!==prior,paused);
await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
await page.getByRole('button',{name:'Ember & flame',exact:true}).click();
await page.keyboard.press('Escape');
await setTheme('dark');
await page.waitForTimeout(6000);
assert(await page.evaluate(()=>document.querySelector('.mission-orb-caption').getBoundingClientRect().bottom<=document.querySelector('.mission-stage').getBoundingClientRect().bottom),'orb controls fit inside the stage');
await page.screenshot({path:path.join(OUT,'companion-ember-dark.png')});
await setTheme('light');
await page.screenshot({path:path.join(OUT,'companion-ember-light.png')});
assert.equal(await page.evaluate(()=>localStorage.getItem('wanigan.orb.temperament')),'ember');
await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
await page.getByRole('button',{name:'Water & mist',exact:true}).click();
await page.keyboard.press('Escape');
log('Real main/preload checks passed: composer attention, globe spin, native hide/pause/show, temperament persistence.');

// Seed through the real IPC surface, then reload so the shell's project list
// refreshes. projects.add answers here only because of the launch marker above.
const seed = await page.evaluate(async (repo) => {
  const out = {};
  try {
    const p = await window.wanigan.projects.add(repo); out.project = p.id;
    try { const d = await window.wanigan.control.create({ projectId: p.id, title: 'Tighten the Fleet card hierarchy', objective: 'Make blocked sessions read first at a glance without colour carrying the state alone.', acceptance: ['Permission-blocked cards sort first', 'Every status has a glyph and a word', 'No layout shift on status change'], risk: 'low' }); out.docket = d?.docket?.id ?? d?.id ?? 'created'; } catch (e) { out.docketError = String(e?.message ?? e); }
    try { const c = await window.wanigan.learning.teach({ projectId: p.id, title: 'Run npm test before handing off', text: 'Run `npm test` (typecheck, package hooks, local install, smoke) before handing off any code change in this repo.', kind: 'instruction', scope: 'project', outcome: 'preference' }); out.candidate = c?.id ?? 'created'; } catch (e) { out.teachError = String(e?.message ?? e); }
  } catch (e) { out.projectError = String(e?.message ?? e); }
  return out;
}, REPO);
log('seed: ' + JSON.stringify(seed));
await page.reload();
await page.waitForSelector('.nav-tabs, .sidebar, nav', { timeout: 120_000 });
await page.waitForTimeout(1200);

const CHORDS = {
  Mission: 'Meta+Shift+H', Sessions: 'Meta+1', Fleet: 'Meta+2', Control: 'Meta+3',
  Batches: 'Meta+4', Insights: 'Meta+5', Learning: 'Meta+6', Plugins: 'Meta+7',
  Schedules: 'Meta+8', Git: 'Meta+9', Runs: 'Meta+0', Usage: 'Meta+Shift+U',
  Scout: 'Meta+Shift+I', Settings: 'Meta+,', Skills: 'Meta+Shift+S', Context: 'Meta+Shift+C', Board: 'Meta+Shift+B',
};
const VIEWS = Object.keys(CHORDS);

async function setTheme(theme) {
  await page.evaluate(async (t) => {
    try { await window.wanigan.prefs.setTheme(t); } catch {}
    document.documentElement.dataset.theme = t; document.documentElement.dataset.themePreference = t; document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
    window.dispatchEvent(new CustomEvent('wanigan:prefs-changed'));
  }, theme);
  await page.waitForTimeout(400);
}
async function goTo(label) {
  if (CHORDS[label]) {
    // The floating dock groups destinations; the keyboard contract reaches all
    // of them without depending on the drawer's remembered open state.
    await page.getByRole('button', { name: 'All destinations', exact: true }).focus();
    await page.keyboard.press(CHORDS[label].replace('Meta', process.platform === 'darwin' ? 'Meta' : 'Control'));
    return true;
  }
  // Works with the tab rail and with a sidebar: any button whose text starts with the label.
  const btn = page.locator('nav button, nav a', { hasText: new RegExp(`^\\s*${label}\\b`) }).first();
  if (await btn.count()) { await btn.click(); return true; }
  return false;
}
async function shot(theme, name) { const dir = path.join(OUT, theme); mkdirSync(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, `${name}.png`) }); assert(!(await page.locator('body').innerText()).includes('This view hit an error'),name+' error boundary');log(`shot ${theme}/${name}`); }

for (const theme of themes) {
  await setTheme(theme);
  for (const label of VIEWS) {
    if (!(await goTo(label))) { log(`no nav control for ${label}`); continue; }
    await page.waitForTimeout(900);
    await shot(theme, label.toLowerCase());
    if(label==='Mission') layoutMeasurements.push(await page.evaluate(theme=>({
      theme,width:innerWidth,height:innerHeight,
      stageHeight:document.querySelector('.mission-stage').getBoundingClientRect().height,
      shelfBottom:document.querySelector('.mission-shelf')?.getBoundingClientRect().bottom,
      workspaceBottom:document.querySelector('.body').getBoundingClientRect().bottom,
    }),theme));
  }
  await goTo('Mission'); await page.waitForSelector('.mission-room');
  await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
  assert(await page.locator('#wanigan-personality').evaluate(el=>{
    const r=el.getBoundingClientRect();return r.width>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;
  }),'companion controls stay inside the window');
  await shot(theme,'companion-controls');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#wanigan-personality').isVisible(),false);
  await goTo('Control'); await page.waitForSelector('.control-detail');
  const newGoal=page.getByRole('button',{name:'New goal',exact:true});
  await newGoal.click();
  const sheet=page.locator('.planning-table');
  await sheet.waitFor();
  if(await sheet.getByRole('button',{name:'I’ll write the plan',exact:true}).count())await sheet.getByRole('button',{name:'I’ll write the plan',exact:true}).click();
  assert.equal(await sheet.getByLabel('Title',{exact:true}).first().evaluate(el=>el===document.activeElement),true,'planning page focuses Title');
  await sheet.getByLabel('Title',{exact:true}).first().fill('Review sheet draft');
  await sheet.getByRole('button',{name:'Back to goals',exact:true}).click();
  assert.equal(await newGoal.evaluate(el=>el===document.activeElement),true,'Back returns focus to New goal');
  await newGoal.click();
  assert.equal(await sheet.getByLabel('Title',{exact:true}).first().inputValue(),'Review sheet draft','closing retains the draft');
  await shot(theme,'goal-planning');
  await sheet.getByRole('button',{name:'Back to goals',exact:true}).click();
  assert.equal(await page.getByRole('dialog').count(),0);
  const reviewGeometry=await page.evaluate(()=>{
    const list=document.querySelector('.control-list').getBoundingClientRect();
    const detail=document.querySelector('.control-detail').getBoundingClientRect();
    return {listRight:list.right,detailLeft:detail.left,detailTop:detail.top,height:innerHeight};
  });
  assert(reviewGeometry.detailLeft>=reviewGeometry.listRight-1,'selected record stays beside its list');
  assert(reviewGeometry.detailTop<reviewGeometry.height/2,'selected record visible immediately');
  await page.keyboard.press('Meta+K'); await page.waitForTimeout(500); await shot(theme, 'overlay-palette'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.keyboard.press('Meta+T'); await page.waitForTimeout(700); await shot(theme, 'overlay-new-session'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await page.keyboard.press('Shift+Slash'); await page.waitForTimeout(500); await shot(theme, 'overlay-shortcuts'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
}

// Exercise the new form through the real typed bridge. Only a local draft
// goal is created: no session, model request or worktree is started.
await goTo('Control'); await page.waitForSelector('.control-detail');
await page.getByRole('button',{name:'New goal',exact:true}).click();
const creation=page.locator('.planning-table');
await creation.getByLabel('Title',{exact:true}).first().fill('Validate the review workspace');
await creation.getByRole('textbox',{name:'Objective',exact:true}).fill('Keep the selected work visible and the draft recoverable.');
await creation.getByRole('textbox',{name:'Acceptance checks · one per line',exact:true}).fill('Creation validates through main\nThe selected record opens beside the list');
await creation.getByLabel('Goal budget · USD',{exact:true}).fill('-1');
assert(await creation.getByRole('button',{name:'Create goal',exact:true}).isDisabled(),'invalid budget is rejected before submission');
assert((await creation.locator('#planning-problems').innerText()).includes('budget'),'budget correction is visible');
await creation.getByLabel('Goal budget · USD',{exact:true}).fill('2');
await creation.getByRole('button',{name:'Create goal',exact:true}).click();
await creation.getByRole('button',{name:'Open goal',exact:true}).click();
await creation.waitFor({state:'detached'});
await page.waitForFunction(()=>document.querySelector('.control-detail h2')?.textContent==='Validate the review workspace');
assert.equal(await page.locator('.control-docket').count(),2,'successful creation adds one goal');
assert.equal(await page.evaluate(async()=>(await window.wanigan.sessions.list()).filter(s=>s.status==='running').length),0,'creating a goal launches no agent');
log('Real review creation passed: main validation, visible error, correction, selected record, no agent launched.');

await setTheme('dark');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 760));
await page.waitForTimeout(600);
for (const label of ['Mission', 'Sessions', 'Control', 'Fleet', 'Learning', 'Settings']) { if (await goTo(label)) { await page.waitForTimeout(700); await shot('narrow', label.toLowerCase()); } }

assert.deepEqual(errors,[]);
writeFileSync(path.join(OUT,'verification.json'),JSON.stringify({
  capturedAt:new Date().toISOString(),realMainAndPreload:true,isolatedProfile:true,seededLocalRecords:true,
  tests:['composer-gaze','globe-spin','native-visibility-pause','temperament-persistence','popover-bounds-and-escape','review-adjacent-detail','planner-focus-return','planner-draft-retention','main-create-validation','main-create-success','creation-does-not-launch'],
  themes,views:VIEWS,layoutMeasurements,errors,
},null,2)+'\n');
log('Review checks passed: planning page, initial focus, Back, draft retention, adjacent detail, both themes.');
log('done');
}finally{await app.close();rmSync(udd, { recursive: true, force: true });}
