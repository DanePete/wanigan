// Built renderer with a synthetic recovery bridge; native behavior is tested separately.
import { STUB } from './renderer-harness.mjs';
import { _electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const before = process.argv.includes('--before');
const bundle = before ? '/private/tmp/wanigan-recovery-maintenance-before-renderer' : path.join(root, 'out/renderer');
const out = path.join(root, 'docs/visuals/relay-recovery-completion-2026-09-19', before ? 'before' : 'after');
fs.mkdirSync(out, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-recovery-ui-'));
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(bundle, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(bundle + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1100,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', WANIGAN_PROVIDER_PACKS_DIR: path.join(directory, 'provider-packs') };
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(directory, 'main.cjs'), `--user-data-dir=${directory}/profile`, '--use-mock-keychain'], env });
const errors = [], checks = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const base = window.wanigan;
    const now = Date.now();
    const confirmed = { key: 'review:interrupted', module: 'review', operationId: 'review-interrupted-before-spawn', cwd: '/isolated/project',
      execution: 'confirmed finished', checkout: 'held', billing: 'independent', source: 'Owning runtime: preparation finalized without attempting a command spawn',
      observedAt: now - 60000, reason: 'The exact retained claims can be released. The failed review result and independent billing evidence remain.', revision: 'fixture-one', canReconcile: true };
    const unknown = { ...confirmed, key: 'headless:legacy', module: 'headless', operationId: 'historical-unresolved-run', cwd: '/isolated/other-project',
      execution: 'unknown', source: 'Persisted owner; descendant state unproven', observedAt: null,
      reason: 'A missing owner, expired lease or completed shell cannot prove that escaped descendants stopped.', canReconcile: false };
    const liability = { ...unknown, key: 'suggest:pending', module: 'suggest', operationId: 'request-awaiting-reconciliation', cwd: null,
      billing: 'unresolved', checkout: 'not claimed', source: 'TypeSafe request liability', observedAt: now - 120000,
      reason: 'Local process completion cannot settle this submitted request’s bill.' };
    const state = window.__recoveryProbe = { mode: 'active', rows: [confirmed, unknown, liability], calls: [], resolutions: [], fail: false };
    const recovery = {
      inspect: async () => ({ generation: 'fixture-generation-2026-09-19', storageMode: state.mode,
        storageReason: state.mode === 'active' ? 'Current storage generation. Execution ownership and financial exposure remain separate checks.'
          : 'Restored history is read-only. Archived jobs and older spending totals cannot authorize automatic or paid work. Spending reconciliation is not supported in this phase.',
        observations: state.rows, resolutions: state.resolutions }),
      preview: async key => { state.calls.push(['preview', key]); return { token: 'opaque-main-issued-fixture-token', expiresAt: now + 300000,
        generation: 'fixture-generation-2026-09-19', observation: confirmed,
        decision: 'Release only these validated execution claims. Preserve the original outcome and all billing evidence. No retry is scheduled.' }; },
      apply: async token => {
        state.calls.push(['apply', token]);
        if (state.fail) throw Error('Recovery evidence, checkout identity or storage generation changed. Inspect again.');
        state.rows = state.rows.filter(row => row.key !== confirmed.key);
        const result = { id: 'resolution-one', operationId: confirmed.operationId, module: 'review', at: now,
          generation: 'fixture-generation-2026-09-19', decision: 'Validated execution claims released. Prior outcome and billing evidence preserved. No retry scheduled.' };
        state.resolutions.push(result); return result;
      },
    };
    window.wanigan = new Proxy(base, { get(target, property) { return property === 'recovery' ? recovery : target[property]; } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForSelector('.mission-room');
  const shots = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.style.colorScheme = value; }, theme);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`) });
    }
  };
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Meta+,');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.locator('#settings-tab-backup').click(); await shots('backup');
  await page.getByRole('heading', { name: 'Restore a backup', exact: true }).scrollIntoViewIfNeeded();
  await shots('backup-restore');
  if (!before) {
  await page.keyboard.press('Meta+Shift+Y');
  await page.getByRole('heading', { name: 'Recovery', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review supported release' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review supported release' }).count(), 1);
  await shots('recovery');
  await page.getByRole('button', { name: 'Review supported release' }).click();
  await page.getByRole('button', { name: 'Apply reviewed release' }).scrollIntoViewIfNeeded(); await shots('release-preview');
  await page.evaluate(() => { window.__recoveryProbe.fail = true; });
  await page.getByRole('button', { name: 'Apply reviewed release' }).click();
  await page.getByText('Recovery evidence, checkout identity or storage generation changed. Inspect again.').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__recoveryProbe.calls.at(-1)), ['apply', 'opaque-main-issued-fixture-token']);
  assert.equal(await page.getByRole('button', { name: 'Apply reviewed release' }).count(), 0);
  checks.push('Only the supported claim offers release; exact token is forwarded; a failed apply consumes the displayed preview.');
  await page.evaluate(() => { window.__recoveryProbe.fail = false; });
  await page.getByRole('button', { name: 'Review supported release' }).click();
  await page.getByRole('button', { name: 'Apply reviewed release' }).click();
  await page.getByText('Validated execution claims released. Prior outcome and billing evidence preserved. No retry scheduled.').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Review supported release' }).count(), 0);
  checks.push('Successful release preserves displayed unknown execution and unresolved billing, and records the decision.');
  await page.evaluate(() => { window.__recoveryProbe.mode = 'inspection'; });
  await page.getByRole('button', { name: 'Refresh evidence' }).click();
  await page.getByText(/Restored history is read-only/).waitFor();
  await page.locator('.pane.recovery').evaluate(element => { element.scrollTop = 0; }); await shots('restored-inspection');
  checks.push('Restored inspection clearly holds archived automation and paid admission.');
  } else checks.push('Baseline Backup overview and restore operator flow render in both themes.');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version,
    provenance: 'Actual renderer with synthetic bridge; native recovery and restore tested separately.', dataRoot: directory,
    providerPacksDir: env.WANIGAN_PROVIDER_PACKS_DIR, checks, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ out, checks, errors }));
} finally { await app.close(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
