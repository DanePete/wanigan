#!/usr/bin/env node
// Actual built renderer, synthetic services. No production data or deletion.
import { STUB } from './renderer-harness.mjs';
import { _electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const before = process.argv.includes('--before');
const bundle = before ? '/private/tmp/wanigan-feature-fixes-before-renderer' : path.join(root, 'out/renderer');
const out = path.join(root, 'docs/visuals/existing-feature-fixes-2026-09-15', before ? 'before' : 'after');
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(bundle, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(bundle + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-backup-ui-'));
fs.writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1040,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const errors = []; const checks = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan;
    const now = Date.now();
    const candidates = ['unused-inputs', 'second-unused-session'].map((sessionId, index) => ({ sessionId, dir: '/fixture/' + sessionId, endedAt: now - 90 * 86400000, files: 2, bytes: (index + 1) * 4096 }));
    const plan = { enabled: true, windowDays: 30, cutoff: now - 30 * 86400000, scanned: 4, candidates, filesEligible: 4, bytesEligible: 12288, skipped: [{sessionId:'generated-report',reason:'holds-agent-output',detail:'report.md is generated output.'},{sessionId:'live-session',reason:'session-still-open',detail:'This session has not ended.'}] };
    window.__retention = { days: 0, calls: [], cancel: true, fail: false };
    const state = window.__retention;
    const overrides = {
      attachmentStorage: {
        settings: async () => ({ enabled: false, days: state.days }),
        preview: async days => { state.calls.push(['preview',days]); if (state.fail) throw Error('Fixture directory unavailable'); return {...plan,windowDays:days}; },
        setDays: async days => { state.days=days;state.calls.push(['save',days]);return {enabled:days>0,days}; },
        reclaim: async ids => { state.calls.push(['reclaim',ids]);return state.cancel ? null : { ...plan, ranAt:now, reclaimed:[], filesRemoved:2, bytesFreed:4096, errors:[] }; },
      },
      transcripts: { list: async () => [] }, uploads: { list: async () => [] },
      backup: {
        create: async () => ({ dir:'/fixture/backup',manifestPath:'/fixture/backup/wanigan-backup.json',createdAt:now,appVersion:'fixture',database:{bytes:20000,sha256:'fixture'},transcripts:{files:2,bytes:4000},attachments:{files:3,bytes:12000},totalBytes:37000,latestEvidenceAt:now,durationMs:8,excluded:['Machine credentials and execution approvals are excluded.'] }),
        inspect: async () => ({dir:'/fixture/older-backup',createdAt:now,appVersion:'fixture',database:{bytes:20000,sha256:'fixture'},transcripts:{files:2,bytes:4000},attachments:null,latestEvidenceAt:now,currentLatestEvidenceAt:now,wouldDiscardNewer:false,problems:[]}),
      },
    };
    window.wanigan = new Proxy(original,{ get(target,service) { return service in overrides ? new Proxy(target[service] ?? {},{get(api,method){return overrides[service][method] ?? api[method];}}) : target[service]; } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForSelector('.mission-room');
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Meta+,');
  await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
  const select = async id => { await page.locator(`#settings-tab-${id}`).click(); };
  const shots = async name => {
    for (const theme of ['dark','light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme=value;document.documentElement.style.colorScheme=value; },theme);
      await page.screenshot({path:path.join(out,`${name}-${theme}.png`)});
    }
  };
  await select('privacy');
  if (before) {
    await page.getByText('Session attachment directories',{exact:true}).scrollIntoViewIfNeeded();
    await shots('attachment-retention');
  } else {
    await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();
    await page.getByRole('button',{name:'Remove selected unused files…'}).waitFor();
    assert(await page.getByRole('button',{name:'Remove selected unused files…'}).isDisabled());
    await page.getByRole('button',{name:'Save window',exact:true}).click();
    await page.getByRole('checkbox',{name:'Clean unused attachments for second-unused-session'}).uncheck();
    await page.locator('.attachment-storage').scrollIntoViewIfNeeded();
    await shots('attachment-retention');
    await page.getByRole('button',{name:'Remove selected unused files…'}).click();
    await page.getByText('Cleanup canceled. Files were kept.',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__retention.calls.at(-1)),['reclaim',['unused-inputs']]);
    checks.push('preview is read-only; saved window required; only selected session sent; canceled cleanup preserves preview');
    await page.evaluate(() => window.__retention.cancel=false);
    await page.getByRole('button',{name:'Remove selected unused files…'}).click();
    await page.getByText(/2 files removed; 4,096 bytes freed/).waitFor();
    checks.push('cleanup displays measured removal result');
    await page.evaluate(() => window.__retention.fail=true);
    await page.getByRole('button',{name:'Preview cleanup',exact:true}).click();
    await page.getByText('Fixture directory unavailable',{exact:true}).waitFor();
    checks.push('preview failure is visible');
  }
  await select('backup');
  await page.getByRole('button',{name:'Back up now',exact:true}).click();
  await page.getByText('Backup written.',{exact:true}).waitFor();
  await shots('backup-artifacts');
  await page.getByRole('button',{name:'Check a backup folder',exact:true}).click();
  await page.getByText('This backup verified: every file matches the digest recorded in its manifest.',{exact:true}).waitFor();
  await page.locator('[data-section-title="Check a backup"]').scrollIntoViewIfNeeded();
  await shots('backup-legacy');
  if (!before) {
    assert.match(await page.locator('[data-section-title="Check a backup"]').innerText(),/Not included in this older backup/);
    assert.doesNotMatch(await page.locator('[data-section-title="Check a backup"]').innerText(),/drop no recorded work/);
    checks.push('legacy backup discloses missing artifacts and avoids claiming full database equivalence');
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'backup-retention-checks.json'),JSON.stringify({before,provenance:'Actual renderer, synthetic bridge. No main/native deletion exercised.',checks,errors},null,2)+'\n');
  console.log(JSON.stringify({before,checks,errors}));
} finally { await app.close(); server.close(); fs.rmSync(dir,{recursive:true,force:true}); }
