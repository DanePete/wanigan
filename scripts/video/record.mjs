#!/usr/bin/env node
// Record a take of the launch video: the real app, driven at a person's pace,
// captured to .artifacts/video/takes/<take>/master.mp4 with take.json marks.
//
//   node scripts/video/record.mjs --demo            the built-in demo: stand-in agents, free
//   node scripts/video/record.mjs --real            real Claude Code and Codex: spends real turns
//
// Options:
//   --take <name>        folder name under .artifacts/video/takes (default: <mode>-<time>)
//   --chapters a,b,c     record only these chapters (default: all of a–f)
//   --app <path.app>     record a packaged build instead of ./out (npm run build first otherwise)
//   --jev-pause          real mode: if Jev has no key, stop in Settings › Jev, off camera,
//                        until a person pastes one (the recording is paused meanwhile)
//   --keep               keep the throwaway data and test site in /tmp/wanigan-video/<take>
//
// Needs `npm run build` (or --app), ffmpeg on PATH, and a display: the window
// must stay on screen while it records (it is kept on top).
import { basename, join, resolve } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { _electron } from 'playwright-core';
import { ARTIFACTS, ROOT, WORK_ROOT, appEnv, arg, ensureDir, flag, sleep, stopCore } from './lib/env.mjs';
import { ScreenRecorder } from './lib/capture.mjs';
import { CURSOR, guardScript } from './lib/page-scripts.mjs';
import { Human } from './lib/human.mjs';
import { Take } from './lib/take.mjs';
import { makeShop } from './lib/shop.mjs';
import { privateTerms } from './lib/privacy.mjs';
import { EDGE } from './lib/timeline.mjs';
import { CHAPTER_RUNNERS, setupDemo, setupReal } from './lib/chapters.mjs';

const mode = flag('--real') ? 'real' : 'demo';
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
const takeName = arg('--take', `${mode}-${stamp}`);
const chapters = (arg('--chapters', 'a,b,c,d,e,f')).split(',').map((s) => s.trim()).filter(Boolean);
const packaged = arg('--app') ? resolve(arg('--app')) : null;
const takeDir = ensureDir(join(ARTIFACTS, 'takes', takeName));
const work = join(WORK_ROOT, takeName);
const dataDir = join(work, 'data');
const started = Date.now();
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

if (!packaged && !existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('Build the app first: npm run build (or pass --app "release/mac-arm64/Wanigan 2.app").');
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
ensureDir(dataDir);

log(`Recording a ${mode} take "${takeName}" (chapters ${chapters.join(', ')})`);
if (mode === 'real') {
  log('  real mode: this starts the real Claude Code and Codex and spends real turns');
  makeShop(join(work, 'shop'), join(work, 'origin.git'));
}

// The real app asks before quitting with sessions running; the take ends them itself.
ensureDir(join(dataDir, 'electron'));
writeFileSync(join(dataDir, 'electron', 'quit-warning.json'), `${JSON.stringify({ ask: false })}\n`);
const env = appEnv({ WANIGAN_DATA_DIR: dataDir });
// 2x pixels on any display, so text is sharp in the master whatever screen it records on.
const switches = ['--force-device-scale-factor=2'];
const app = packaged
  ? await _electron.launch({ executablePath: join(packaged, 'Contents', 'MacOS', basename(packaged, '.app')), args: [...switches, ...(mode === 'demo' ? ['--demo'] : [])], env, timeout: 60_000 })
  : await _electron.launch({ args: [ROOT, ...switches, ...(mode === 'demo' ? ['--demo'] : [])], env, timeout: 60_000 });

let rec = null;
let take = null;
let failure = null;
try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1440, 810);
    w.center();
    // On top and never throttled: an occluded window stops painting, and the recording with it.
    w.setAlwaysOnTop(true, 'floating');
    w.webContents.setBackgroundThrottling(false);
    w.show();
    w.focus();
  });
  await page.waitForSelector('.rail', { timeout: 30_000 });
  await page.evaluate(() => { localStorage.setItem('wanigan.theme', 'dark'); });
  await page.reload();
  await page.waitForSelector('.rail', { timeout: 30_000 });
  // A cursor people can follow, survives any reload.
  await page.addInitScript(CURSOR);
  await page.evaluate(CURSOR);

  const human = new Human(page, { log });
  take = new Take({ page, rec: null, mode, dir: takeDir, human, log });

  const state = mode === 'demo' ? await setupDemo(take) : await setupReal(take, { shop: join(work, 'shop'), jevPause: flag('--jev-pause') });
  // What must never be seen, gathered from this machine and the running core.
  // Held in memory only; take.json records that something was seen, never what.
  take.terms = privateTerms({ accounts: state.accounts ?? [] });
  const guard = guardScript({ terms: take.terms, allowEmails: ['@example.com', '@agency.example'] });
  await page.addInitScript(guard);
  await page.evaluate(guard);

  rec = new ScreenRecorder({ page, file: join(takeDir, 'master.mp4'), encoder: arg('--encoder', 'x264') });
  take.rec = rec;
  await state.before?.();
  await rec.start();
  await take.startPrivacyScan(take.terms);
  log(`  recording to ${join(takeDir, 'master.mp4')}`);

  for (const id of chapters) {
    const run = CHAPTER_RUNNERS[id];
    if (!run) throw new Error(`no chapter ${id}`);
    log(`chapter ${id}`);
    // The last caption of the chapter before gets its reading time, clear of the crossfade.
    await take.settle(EDGE);
    take.chapter(id);
    await run({ take, human, page, app, mode, state });
  }
  await take.settle(EDGE);
  take.mark('end');
  await page.waitForTimeout(1500);
} catch (error) {
  failure = error;
  log(`FAILED: ${error.stack ?? error.message}`);
  if (take) take.note(`failed: ${error.message.split('\n')[0]}`);
  try { if (rec?.still()) writeFileSync(join(takeDir, 'failed.jpg'), rec.still()); } catch { /* best effort */ }
} finally {
  take?.stopPrivacyScan();
  for (const timer of take?.timers ?? []) clearInterval(timer);
  if (rec) await rec.stop().catch((e) => log(`  encoder: ${e.message}`));
  if (take) take.save({ take: takeName, recordedAt: new Date(started).toISOString(), seconds: rec ? Number(rec.t.toFixed(2)) : 0, failed: failure ? failure.message.split('\n')[0] : null });
  // End every session the take started (real agents too), then the app, then its core.
  if (take) {
    try {
      const live = await take.api('sessions.list', { live: true });
      for (const s of live) await take.api('sessions.stop', { id: s.id }).catch(() => {});
      for (let i = 0; i < 40 && (await take.api('sessions.list', { live: true })).length; i++) await sleep(250);
    } catch { /* the window is gone; the core's stop below ends them */ }
  }
  const closing = app.close().catch(() => {});
  if (await Promise.race([closing.then(() => true), sleep(15_000).then(() => false)]) === false) {
    log('  the app did not close in 15 s; ending it');
    try { app.process().kill('SIGKILL'); } catch { /* gone */ }
  }
  await stopCore(dataDir);
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  writeFileSync(join(takeDir, 'record.log'), `${lines.join('\n')}\n`);
}
const hits = take?.marks.filter((m) => m.type === 'privacy') ?? [];
if (hits.length) log(`PRIVACY: the scan saw ${hits.length} personal detail(s) on screen: ${[...new Set(hits.map((h) => h.kind))].join(', ')}. See take.json; the edit refuses those moments.`);
log(`take ${failure ? 'FAILED' : 'done'}: ${takeDir} (${rec ? rec.t.toFixed(1) : 0} s recorded in ${Math.round((Date.now() - started) / 1000)} s)`);
process.exit(failure ? 1 : 0);
