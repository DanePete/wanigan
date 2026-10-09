#!/usr/bin/env node
// Record Wanigan's animations in the real app. Launches the built app against a
// throwaway data directory, opens the hidden orb lab (#/orb-lab), and for each
// play action, mood and material captures a timed sequence of the orb, in both
// themes. Frames go to .artifacts/orb/<theme>/<scenario>-<ms>.png, one contact
// sheet per scenario to .artifacts/orb/<theme>-<scenario>.png, and what the
// fluid reported at each frame (whirl, lava, vortex, tint…) to
// .artifacts/orb/report.json. Then: that the fluid stops drawing off-screen;
// the rail and Needs you orbs as the app shows them (<theme>-app-needs.png);
// the lab with motion reduced; and with WebGPU taken away, so the still
// drawing has to stand in.
//
//   npm run build && node scripts/orb-probe.mjs [--only spin,rain] [--themes dark]
//
// Look at the sheets: the numbers say a performance ran, not that it looks right.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.artifacts', 'orb');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const only = arg('--only')?.split(',');
const themes = arg('--themes')?.split(',') ?? ['dark', 'light'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), 'wg-orb-'));
const env = { ...process.env, WANIGAN_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];

/** Each scenario: the lab's starting address, then what to do and when to look. */
const play = (action) => async (win) => { await win.locator(`[data-play="${action}"]`).dispatchEvent('click'); };
const choose = (group, label) => async (win) => {
  await win.locator(`[aria-label="${group}"] button`, { hasText: new RegExp(`^${label}$`) }).dispatchEvent('click');
};
const SCENARIOS = [
  { name: 'idle', at: [0, 1500, 3000] },
  { name: 'spin', act: play('spin'), at: [0, 70, 160, 300, 480, 700, 1000, 1500] },
  { name: 'splash', act: play('splash'), at: [0, 120, 300, 550, 900, 1400, 2200] },
  { name: 'burst', act: play('burst'), at: [0, 100, 300, 600, 1000, 1600, 2500] },
  { name: 'rain', act: play('rain'), at: [0, 1000, 2000, 3200, 4500, 6000, 8000, 11000, 15000] },
  { name: 'bloom', act: play('bloom'), at: [0, 700, 1600, 3000, 5000, 9000, 16000, 30000] },
  { name: 'shake', act: play('shake'), at: [0, 120, 300, 600, 1000, 1600, 2500] },
  { name: 'thinking', act: choose('Mood', 'thinking'), at: [0, 1000, 2500, 4500, 7000] },
  { name: 'celebrate', act: choose('Mood', 'celebrate'), at: [0, 80, 200, 400, 700, 1100, 1700, 2600] },
  { name: 'alarm', act: choose('Mood', 'alarm'), at: [0, 300, 700, 1300, 2500, 4000, 5500, 6800, 8500] },
  { name: 'recovered', hash: 'mood=alarm', settle: 1500, act: choose('Mood', 'recovered'), at: [0, 200, 500, 1000, 1700, 2500, 3500] },
  { name: 'wax', act: choose('Material', 'Lava lamp'), at: [0, 500, 1200, 3000, 6000, 10000, 16000, 24000, 34000] },
  { name: 'wax-shake', hash: 'material=wax', settle: 12000, act: play('shake'), at: [0, 400, 1000, 2000, 3500] },
  {
    name: 'listen', at: [0, 300, 700, 1200, 1800],
    act: async (win) => {
      await win.focus('#orb-lab-type');
      await win.keyboard.type('hello there', { delay: 60 });
    },
  },
  ...['working', 'finished', 'unavailable', 'failed'].map((signal) => ({ name: `signal-${signal}`, hash: `signal=${signal}`, at: [0] })),
  // The 30 px and 148 px orbs beside the controls, played through orbPlay().
  { name: 'sizes-burst', target: '.orb-lab-sizes', act: play('burst'), at: [0, 300, 900] },
].filter((s) => !only || only.includes(s.name));

/** What the fluid says it is doing, from the canvas's probe attributes. */
const readState = (win) => win.evaluate(() => {
  const orb = document.querySelector('.orb-lab-stage .orb');
  const canvas = orb?.querySelector('canvas');
  return { render: orb?.getAttribute('data-render'), cue: orb?.getAttribute('data-cue'), ...(canvas ? { ...canvas.dataset } : {}) };
});

async function open(win, base, theme, query = '') {
  await win.evaluate((t) => localStorage.setItem('wanigan.theme', t), theme);
  await win.goto(`${base}#/orb-lab?size=360${query ? `&${query}` : ''}`);
  await win.reload();
  await win.waitForSelector('.orb-lab-stage .orb[data-render="fluid"], .orb-lab-stage .orb[data-render="still"]', { timeout: 30_000 });
  await win.mouse.move(2, 2);
}

async function clip(win, target = '.orb-lab-stage .orb') {
  const box = await win.locator(target).boundingBox();
  const pad = Math.min(box.width, box.height) * 0.12;
  return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
}

async function record(win, scenario, dir, area) {
  const frames = [];
  const start = Date.now();
  if (scenario.act) await scenario.act(win);
  for (const at of scenario.at) {
    const wait = start + at - Date.now();
    if (wait > 0) await sleep(wait);
    const ms = Date.now() - start;
    const file = join(dir, `${scenario.name}-${String(at).padStart(5, '0')}.png`);
    await win.screenshot({ path: file, clip: area });
    frames.push({ at, ms, file, state: await readState(win) });
  }
  return frames;
}

async function sheet(browser, title, frames, file) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 400 }, deviceScaleFactor: 1 });
  const cells = frames.map((f) => `<figure><img src="data:image/png;base64,${readFileSync(f.file).toString('base64')}"><figcaption>${f.label ?? `${(f.ms / 1000).toFixed(2)} s`}${f.note ? ` · ${f.note}` : ''}</figcaption></figure>`).join('');
  await page.setContent(`<!doctype html><style>
    body{margin:0;padding:16px;background:#5a6066;font:13px system-ui;color:#fff}
    h1{font-size:15px;margin:0 0 10px} main{display:flex;flex-wrap:wrap;gap:10px}
    figure{margin:0;width:220px} img{width:220px;height:220px;object-fit:contain;display:block;border-radius:6px}
    figcaption{padding-top:4px;font-variant-numeric:tabular-nums}</style><h1>${title}</h1><main>${cells}</main>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1600, height });
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

const note = (s) => [
  s.cue ? `cue ${s.cue}` : '',
  Number(s.whirl) > 0.01 ? `whirl ${Number(s.whirl).toFixed(2)}` : '',
  Number(s.recovery) > 0.01 ? `flame ${Number(s.recovery).toFixed(2)}` : '',
  Number(s.lava) > 0.01 ? `wax ${Number(s.lava).toFixed(2)}` : '',
  Number(s.vortex) > 0.01 ? `swirl ${Number(s.vortex).toFixed(2)}` : '',
].filter(Boolean).join(' ');

const report = { scenarios: {}, checks: [] };
mkdirSync(out, { recursive: true });
let app, corePid = 0;
const browser = await chromium.launch();
try {
  app = await _electron.launch({ args: [root], env, timeout: 60_000 });
  const win = await app.firstWindow({ timeout: 30_000 });
  win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { console.log(`console ${m.type()}: ${m.text()}`); (report.console ??= []).push(m.text()); } });
  win.on('pageerror', (e) => { console.log(`pageerror: ${e.message}`); (report.console ??= []).push(e.message); });
  await win.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 100 && !existsSync(join(dataDir, 'core.json')); i++) await sleep(200);
  corePid = existsSync(join(dataDir, 'core.json')) ? JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid : 0;
  const base = win.url().split('#')[0];
  report.webgpu = await win.evaluate(async () => {
    if (!('gpu' in navigator)) return 'navigator.gpu is missing';
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? `adapter: ${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}`.trim() : 'no adapter';
  });
  console.log(`WebGPU in the app window: ${report.webgpu}`);

  for (const theme of themes) {
    const dir = join(out, theme);
    mkdirSync(dir, { recursive: true });
    for (const scenario of SCENARIOS) {
      await open(win, base, theme, scenario.hash);
      await sleep(scenario.settle ?? 2500);
      const area = await clip(win, scenario.target);
      const frames = await record(win, scenario, dir, area);
      const render = frames[0]?.state.render;
      report.scenarios[`${theme}/${scenario.name}`] = frames.map(({ at, ms, state }) => ({ at, ms, ...state }));
      await sheet(browser, `${scenario.name} · ${theme} · ${render}`, frames.map((f) => ({ ...f, note: note(f.state) })), join(out, `${theme}-${scenario.name}.png`));
      console.log(`${theme} ${scenario.name}: ${frames.length} frames (${render})`);
    }
  }

  // Pausing: hidden or off-screen, the fluid stops drawing.
  if (!only) {
    await open(win, base, 'dark');
    await sleep(1500);
    const count = async () => Number((await readState(win)).frames ?? 0);
    const a = await count(); await sleep(1000); const b = await count();
    await win.evaluate(() => { document.querySelector('.orb-lab-stage').style.display = 'none'; });
    await sleep(400); const c = await count(); await sleep(1500); const d = await count();
    await win.evaluate(() => { document.querySelector('.orb-lab-stage').style.display = ''; });
    await sleep(800); const e = await count();
    report.checks.push({ check: 'pauses when off-screen', drawnPerSecondVisible: b - a, drawnWhileHidden: d - c, resumed: e > d });
    console.log(`visible: ${b - a} frames/s; hidden: ${d - c} frames in 1.5 s; resumed: ${e > d}`);

    // The orb as the rest of the app shows it: the rail at 30 px and Needs you at 148 px.
    for (const theme of themes) {
      await win.evaluate((t) => localStorage.setItem('wanigan.theme', t), theme);
      await win.goto(`${base}#/needs`);
      await win.reload();
      await win.waitForSelector('.needs-headline', { timeout: 20_000 });
      await win.waitForSelector('.needs-orb[data-render="fluid"]', { timeout: 20_000 }).catch(() => {});
      // A first run with no projects offers to open one; close that to see the view.
      await win.keyboard.press('Escape');
      await win.mouse.move(700, 450);
      await sleep(2500);
      await win.screenshot({ path: join(out, `${theme}-app-needs.png`) });
      const orbs = await win.evaluate(() => [...document.querySelectorAll('.orb')].map((o) => ({
        label: o.getAttribute('aria-label'), render: o.getAttribute('data-render'), size: o.getBoundingClientRect().width,
        frames: Number(o.querySelector('canvas')?.dataset.frames ?? 0) })));
      await sleep(1000);
      const later = await win.evaluate(() => [...document.querySelectorAll('.orb canvas')].map((c) => Number(c.dataset.frames)));
      report.checks.push({ check: `app orbs ${theme}`, orbs: orbs.map((o, i) => ({ ...o, framesPerSecond: (later[i] ?? 0) - o.frames })) });
    }

    // Reduced motion: play is a short change of light, and nothing keeps drawing.
    await win.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of themes) {
      await open(win, base, theme);
      await sleep(1200);
      const area = await clip(win);
      const frames = [];
      for (const [label, act] of [['spin', play('spin')], ['rain', play('rain')], ['celebrate', choose('Mood', 'celebrate')], ['alarm', choose('Mood', 'alarm')], ['wax', choose('Material', 'Lava lamp')]]) {
        const before = Number((await readState(win)).frames ?? 0);
        await act(win);
        await sleep(350);
        const file = join(out, theme, `reduced-${label}.png`);
        await win.screenshot({ path: file, clip: area });
        const state = await readState(win);
        await sleep(1400);
        const after = await readState(win);
        frames.push({ file, label: `${label}: cue ${state.cue ?? 'none'} → ${after.cue ?? 'gone'}, ${Number(after.frames) - before} draws`, ms: 0 });
        report.checks.push({ check: `reduced motion ${theme} ${label}`, cueDuring: state.cue ?? null, cueAfter: after.cue ?? null, draws: Number(after.frames) - before, lava: after.lava, tint: after.tint });
      }
      await sheet(browser, `reduced motion · ${theme}`, frames, join(out, `${theme}-reduced.png`));
    }
    await win.emulateMedia({ reducedMotion: 'no-preference' });

    // No WebGPU: the still drawing stands in, with CSS versions of spin and celebrate.
    await win.addInitScript(() => { delete Navigator.prototype.gpu; });
    for (const theme of themes) {
      const frames = [];
      for (const [label, query, act, at] of [
        ['still', '', null, 0], ['spin', '', play('spin'), 330], ['celebrate', '', choose('Mood', 'celebrate'), 300],
        ['thinking', 'mood=thinking', null, 0], ['alarm', '', choose('Mood', 'alarm'), 250], ['wax', 'material=wax', null, 0],
        ['finished', 'signal=finished', null, 0], ['unavailable', 'signal=unavailable', null, 0],
      ]) {
        await open(win, base, theme, query);
        await sleep(400);
        const area = await clip(win);
        if (act) await act(win);
        await sleep(at);
        const file = join(out, theme, `still-${label}.png`);
        await win.screenshot({ path: file, clip: area });
        const state = await readState(win);
        frames.push({ file, label: `${label} (${state.render}${state.cue ? `, cue ${state.cue}` : ''})`, ms: 0 });
      }
      await sheet(browser, `still drawing (no WebGPU) · ${theme}`, frames, join(out, `${theme}-still.png`));
    }
  }

} finally {
  await browser.close();
  if (app) await app.close().catch(() => {});
  if (corePid) { try { process.kill(corePid, 'SIGTERM'); } catch { /* already gone */ } }
  await sleep(500);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Orb probe done. Sheets and frames in ${out}`);
