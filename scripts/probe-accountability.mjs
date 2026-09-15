#!/usr/bin/env node
// Git · secrets before they leave, Assisted-by trailers; Settings · the ledger's
// chain. Actual renderer, isolated Electron, synthetic git, policy and prefs, no
// real agent calls. The main-process checks themselves — the scan, the refusal
// without a matching digest, the chain, the signature, the offline verifier —
// run against real repositories and a real database in the smoke suite
// (smoke17.ts); this probe covers what a reader sees, including every state that
// is not a success.
//
//   npm run build && node scripts/probe-accountability.mjs [--before] [--out dir]
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const outArg = process.argv.indexOf('--out');
const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1])
  : path.join(root, 'docs/visuals/accountability', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-accountability-probe-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({
  executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env,
});
const checks = [], errors = [];
const record = (text) => { checks.push(text); console.log('✓', text); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    const original = window.wanigan, now = Date.now();
    window.__calls = [];
    window.__scan = 'findings'; window.__trailers = 'on'; window.__chain = 'verified';
    const call = (name, args) => window.__calls.push([name, ...JSON.parse(JSON.stringify(args))]);
    const file = (p, index, work) => ({ path: p, index, work, staged: index !== ' ', untracked: false, conflicted: false });
    const status = (root) => ({
      isRepo: true, root, repoRoot: root, subpath: null, branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 0,
      staged: [file('src/payments/config.ts', 'M', ' '), file('deploy/.env.production', 'A', ' ')],
      unstaged: [file('README.md', ' ', 'M')], untracked: [], conflicted: [], clean: false, operation: null,
    });
    const finding = (action, f) => ({ ...f, commit: action === 'push' ? 'a1b2c3d4e5f60718' : null });
    const report = (action) => {
      const scope = action === 'commit' ? 'the staged changes' : 'the commits not yet on origin/main (2 commits)';
      if (window.__scan === 'clean') {
        return { action, scope, findings: [], omitted: 0, suppressed: 1, addedLines: 48, partial: null, unreadable: null, digest: 'c'.repeat(64), needsAcknowledgement: false, at: now };
      }
      return {
        action, scope, omitted: 0, suppressed: 1, addedLines: 48, partial: null, unreadable: null,
        digest: 'd'.repeat(64), needsAcknowledgement: true, at: now,
        findings: [
          finding(action, { file: 'src/payments/config.ts', line: 13, rule: 'stripe-live-key',
            excerpt: 'export const stripe = new Stripe(process.env.STRIPE_OVERRIDE ?? "sk_live_[redacted]", { apiVersion: "2026-08-01", maxNetworkRetries: 3, telemetry: false });' }),
          finding(action, { file: 'deploy/.env.production', line: 4, rule: 'assigned-secret', excerpt: 'DATABASE_PASSWORD=[redacted]' }),
          finding(action, { file: 'deploy/.env.production', line: 7, rule: 'github-token', excerpt: 'DEPLOY_TOKEN=ghp_[redacted]' }),
        ],
      };
    };
    const chain = () => {
      const head = { id: 1242, hash: 'ab'.repeat(32), count: 1204 };
      const baseChain = { total: 1242, unchainedBefore: 38, chained: 1204, verifiedThrough: 1204, lastVerifiedId: 1242, firstBreak: null,
        head, watched: head, checkedAt: now - 4000, keyFingerprint: '1111222233334444'.padEnd(64, '5'),
        signature: { state: 'signed', lastId: 1242, count: 1204, signedAt: now - 60_000, unsignedAfter: 0 } };
      if (window.__chain === 'fail') throw new Error('Fixture database is locked');
      if (window.__chain === 'broken') {
        return { ...baseChain, verifiedThrough: 773, lastVerifiedId: 811, firstBreak: { id: 812, at: now - 86_400_000 * 2, toolName: 'Bash', kind: 'content' },
          signature: { state: 'mismatch', reason: 'Record #1242 no longer carries the hash that was signed, so the records up to it were rewritten.' } };
      }
      if (window.__chain === 'mismatch') {
        return { ...baseChain, signature: { state: 'mismatch', reason: 'Record #1242 no longer carries the hash that was signed, so the records up to it were rewritten.' } };
      }
      return baseChain;
    };
    let prefs = null;
    const overrides = {
      git: {
        status: async (root) => status(root),
        log: async () => [{ hash: 'e'.repeat(40), short: 'eeeeeee', parents: [], author: 'Fixture', at: now - 3_600_000, subject: 'Checkout retries keep one order id', body: '', refs: ['HEAD -> main'], head: true, lane: 0, color: 0 }],
        branches: async () => [], stashes: async () => [],
        scanSecrets: async (...args) => { call('scanSecrets', args); if (window.__scan === 'fail') throw new Error('Fixture git timed out'); return report(args[1].action); },
        assistedBy: async (...args) => {
          call('assistedBy', args);
          if (window.__trailers === 'fail') throw new Error('git could not say when the previous commit was made, so the Assisted-by window is unknown: fixture.');
          if (window.__trailers === 'off') return { enabled: false, trailers: [], sessions: 0, since: null, until: now };
          return { enabled: true, trailers: ['Assisted-by: Claude Code (claude-opus-5)', 'Assisted-by: Codex (gpt-5-codex)'], sessions: 3, since: now - 3_600_000, until: now };
        },
        commit: async (...args) => { call('commit', args); return '[main 1a2b3c4] Fixture commit'; },
        push: async (...args) => { call('push', args); return 'Pushed.'; },
      },
      worktrees: { list: async () => [] },
      policy: {
        chain: async () => { call('chain', []); return chain(); },
        summary: async () => ({ denied: 41, asked: 127, allowed: 1074, since: now - 86_400_000 * 40 }),
        trust: async () => 'project', defaultTrust: async () => 'project',
        ledger: async () => [
          { id: 1242, at: now - 90_000, sessionId: 's1', projectId: 'p1', projectName: 'storefront', trust: 'project', toolName: 'Bash', summary: 'npm test -- checkout', decision: 'allow', rule: 'project.command', reason: 'A shell command inside the project at Project trust.' },
          { id: 1241, at: now - 400_000, sessionId: 's1', projectId: 'p1', projectName: 'storefront', trust: 'project', toolName: 'Write', summary: '/etc/hosts', decision: 'deny', rule: 'project.outside', reason: 'A write outside the project is denied at Project trust.' },
          { id: 1240, at: now - 900_000, sessionId: 's2', projectId: 'p2', projectName: 'platform', trust: 'project', toolName: 'WebFetch', summary: 'https://registry.npmjs.org/left-pad', decision: 'ask', rule: 'project.network', reason: 'A network fetch asks at Project trust.' },
        ],
      },
      prefs: {
        all: async () => (prefs ??= { ...(await original.prefs.all()), assistedByTrailers: false }),
        set: async (key, value) => { call('prefs.set', [key, value]); prefs = { ...(prefs ?? await original.prefs.all()), assistedByTrailers: key === 'assisted_by_trailers' ? value === '1' : prefs?.assistedByTrailers }; return prefs; },
      },
    };
    window.wanigan = new Proxy(original, { get(api, service) {
      if (!(service in overrides)) return api[service];
      return new Proxy(api[service], { get(s, method) { return overrides[service][method] ?? s[method]; } });
    } });
  });

  const theme = async (t) => page.evaluate((value) => {
    // theme-boot.ts writes both; with only the attribute, native controls keep the other scheme.
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, t);
  const shoot = async (name) => {
    for (const t of ['dark', 'light']) {
      await theme(t);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: path.join(out, `${name}-${t}.png`), scale: 'css' });
    }
    await theme('dark');
  };
  const calls = (name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n), name);
  const clearCalls = () => page.evaluate(() => { window.__calls = []; });
  /** Readable, not merely present: a clipped line passes a visibility wait. */
  const unclipped = async (locator, what) => {
    const fits = await locator.evaluateAll((els) => els.map((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent.slice(0, 60) })));
    assert(fits.length > 0, `${what}: nothing to measure`);
    for (const fit of fits) assert(fit.scroll <= fit.client + 1, `${what} is clipped: ${JSON.stringify(fit)}`);
  };

  await page.goto(rendererURL); await page.waitForSelector('.mission-room');
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const views = page.getByRole('group', { name: 'Repository views' });
  await views.waitFor();
  await views.getByRole('button', { name: /^Changes/ }).click();
  const box = page.locator('.gt-commit');
  await box.waitFor();
  await page.getByLabel('Commit message').fill('Charge retries reuse the order id');

  if (before) {
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.pc-trailers').count(), 0, 'the pre-change build has no trailer preview');
    await shoot('commit-box');
    record('before: the commit box offers Commit with no word on what the staged changes carry and no attribution preview');
    await page.getByRole('button', { name: /^Push/ }).click();
    await page.locator('.confirm-note').waitFor();
    assert.match(flat(await page.locator('.confirm-note').innerText()), /Push 2 commits to origin\/main\. This leaves your machine\./);
    await shoot('push-confirm');
    record('before: Push asks one sentence of confirmation and nothing checks what is about to leave');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  } else {
    // ── the Assisted-by preview ─────────────────────────────────────────
    const trailers = page.getByRole('group', { name: 'Assisted-by trailers' });
    await trailers.waitFor();
    assert.match(flat(await trailers.innerText()), /^Assisted-by · only sessions Wanigan started and recorded in this checkout since the last commit, .+ Assisted-by: Claude Code \(claude-opus-5\) Assisted-by: Codex \(gpt-5-codex\)$/);
    assert.equal(await trailers.locator('pre').innerText(), 'Assisted-by: Claude Code (claude-opus-5)\nAssisted-by: Codex (gpt-5-codex)');
    await unclipped(trailers.locator('pre, p'), 'the trailer preview');
    record('the commit box shows the exact Assisted-by lines, labelled as only the sessions Wanigan started and recorded here since the last commit, unclipped');
    await shoot('trailer-preview');

    // ── commit blocked by findings ──────────────────────────────────────
    await clearCalls();
    await box.getByRole('button', { name: 'Commit 2 files', exact: true }).click();
    const blocked = box.locator('.confirm-note');
    await blocked.waitFor();
    const scanCalls = await calls('scanSecrets');
    // Whichever repository the view opened on, every later call must name the same one.
    const shownRoot = scanCalls[0]?.[1];
    assert(scanCalls.length === 1 && /^\/example\/[a-z]+$/.test(shownRoot), JSON.stringify(scanCalls));
    assert.deepEqual(scanCalls[0][2], { action: 'commit', all: false });
    assert.equal((await calls('commit')).length, 0, 'nothing is committed while findings are on screen');
    const blockedText = flat(await blocked.innerText());
    assert.match(blockedText, /^✕ 3 possible secrets in the staged changes\. Nothing has been committed\./);
    assert.equal(await blocked.locator('.pc-finding').count(), 3);
    assert.equal(flat(await blocked.locator('.pc-finding').first().innerText()),
      'src/payments/config.ts:13 Stripe live key export const stripe = new Stripe(process.env.STRIPE_OVERRIDE ?? "sk_live_[redacted]", { apiVersion: "2026-08-01", maxNetworkRetries: 3, telemetry: false });');
    assert.match(blockedText, /deploy\/\.env\.production:4 High-entropy value assigned to a secret name DATABASE_PASSWORD=\[redacted\]/);
    assert.match(blockedText, /1 line marked wanigan:allow-secret not reported\. Choose Commit anyway only if you have read them and none is a real credential\./);
    assert(!/\bundefined\b|\bNaN\b|\[object /.test(blockedText), 'no raw value reaches the screen');
    await unclipped(blocked.locator('.pc-where, .pc-excerpt, .pc-lead'), 'a finding');
    await blocked.getByRole('button', { name: 'Commit anyway', exact: true }).waitFor();
    record('pressing Commit scans first: three findings listed as file:line, rule and masked line, nothing committed, and the way past is a button named Commit anyway');
    await shoot('commit-blocked');

    await blocked.getByRole('button', { name: 'Commit anyway', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'commit'));
    const [commitCall] = await calls('commit');
    assert.deepEqual(commitCall.slice(1), [shownRoot, 'Charge retries reuse the order id',
      { all: false, acknowledge: 'd'.repeat(64), trailers: ['Assisted-by: Claude Code (claude-opus-5)', 'Assisted-by: Codex (gpt-5-codex)'] }]);
    record('Commit anyway hands main the digest of exactly the findings shown, with the trailer lines the box displayed');

    // ── clean scan, failed scan ─────────────────────────────────────────
    await page.evaluate(() => { window.__scan = 'clean'; });
    await clearCalls();
    await page.getByLabel('Commit message').fill('Second fixture commit');
    await box.getByRole('button', { name: 'Commit 2 files', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'commit'));
    assert.equal((await calls('commit'))[0][3].acknowledge, undefined, 'a clean scan commits without an acknowledgement');
    assert.equal(await box.locator('.confirm-note').count(), 0);
    record('a clean scan commits straight through, carrying no acknowledgement for main to accept');

    await page.evaluate(() => { window.__scan = 'fail'; });
    await clearCalls();
    await page.getByLabel('Commit message').fill('Third fixture commit');
    await box.getByRole('button', { name: 'Commit 2 files', exact: true }).click();
    await box.getByText('The secret check did not run, so nothing was committed: ', { exact: false }).waitFor();
    assert.equal((await calls('commit')).length, 0, 'a failed scan never falls through to a commit');
    record('a scan that fails says the check did not run and commits nothing, rather than reading as clean');

    // ── trailers off and unworkable ─────────────────────────────────────
    await page.evaluate(() => { window.__scan = 'clean'; window.__trailers = 'off'; });
    await box.getByRole('button', { name: 'Commit 2 files', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'commit'));
    await page.waitForFunction(() => !document.querySelector('.pc-trailers'));
    assert.deepEqual((await calls('commit')).at(-1)[3].trailers, ['Assisted-by: Claude Code (claude-opus-5)', 'Assisted-by: Codex (gpt-5-codex)'],
      'the commit sends the lines that were on screen when it was pressed');
    record('with the setting off the preview disappears after the next read, and nothing in the box claims attribution');
    await page.evaluate(() => { window.__trailers = 'fail'; });
    await page.getByLabel('Commit message').fill('Fourth fixture commit');
    await box.getByRole('button', { name: 'Commit 2 files', exact: true }).click();
    const unworkable = box.getByText(/The Assisted-by lines could not be worked out: .*A commit now is refused for the same reason\./);
    await unworkable.waitFor();
    record('when the lines cannot be worked out the box says so, and that a commit would be refused for the same reason');
    // Put the preview back before the push states, so their screenshots do not
    // carry this step's failure in the commit box beside them.
    await page.evaluate(() => { window.__trailers = 'on'; });
    await page.getByLabel('Commit message').fill('Fifth fixture commit');
    await box.getByRole('button', { name: 'Commit 2 files', exact: true }).click();
    await trailers.waitFor();
    await page.evaluate(() => { window.__scan = 'findings'; });

    // ── push blocked, push clean ────────────────────────────────────────
    await clearCalls();
    await page.getByRole('button', { name: 'Push 2', exact: true }).click();
    const confirm = page.locator('.gt-confirm .confirm-note');
    await confirm.waitFor();
    assert.deepEqual((await calls('scanSecrets')).map((c) => c.slice(1)), [[shownRoot, { action: 'push' }]]);
    const pushText = flat(await confirm.innerText());
    assert.match(pushText, /^✕ 3 possible secrets in the commits not yet on origin\/main \(2 commits\)\. Nothing has been pushed\./);
    assert.match(pushText, /src\/payments\/config\.ts:13 · a1b2c3d4 Stripe live key/);
    await confirm.getByRole('button', { name: 'Push anyway', exact: true }).waitFor();
    assert.equal((await calls('push')).length, 0);
    await unclipped(confirm.locator('.pc-where, .pc-excerpt'), 'a push finding');
    record('pressing Push scans the unpushed commits first, names the commit each finding came from, and offers Push anyway instead of the plain confirmation');
    await shoot('push-blocked');
    await confirm.getByRole('button', { name: 'Push anyway', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'push'));
    assert.deepEqual((await calls('push'))[0].slice(1), [shownRoot, { acknowledge: 'd'.repeat(64) }]);
    record('Push anyway sends the digest of the findings that were shown');

    await page.evaluate(() => { window.__scan = 'clean'; });
    await clearCalls();
    await page.getByRole('button', { name: 'Push 2', exact: true }).click();
    await confirm.waitFor();
    assert.match(flat(await confirm.innerText()), /^Push 2 commits to origin\/main\. This leaves your machine\. ✓ No credential shapes found in the commits not yet on origin\/main \(2 commits\) \(48 added lines read, 1 line marked wanigan:allow-secret\)\. Wanigan looks for known key shapes, so this is not proof there is none\./);
    await confirm.getByRole('button', { name: 'Push to origin/main', exact: true }).click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'push'));
    assert.equal((await calls('push'))[0][2].acknowledge, undefined);
    record('a clean push states what was read and that a clean result is not proof, and pushes without an acknowledgement');
  }

  // ── Settings: the ledger chain and commit attribution ─────────────────
  await page.locator('.space-dock button').first().focus();
  await page.keyboard.press('Meta+,');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.locator('#settings-tab-projects').click();
  await page.locator('#settings-projects').waitFor({ state: 'visible' });

  if (before) {
    const ledgerHead = page.locator('#settings-projects .set-sub').filter({ hasText: /^Ledger$/ });
    await ledgerHead.scrollIntoViewIfNeeded();
    assert.equal(await page.getByRole('button', { name: 'Verify now' }).count(), 0, 'the pre-change build has no chain check');
    await page.locator('.pane.set').evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 120); });
    await shoot('ledger');
    record('before: the ledger shows its counts and rows, with nothing that says whether a row was changed after it was written');
  } else {
    const chain = page.getByRole('group', { name: 'Ledger chain' });
    await chain.getByText(/Chain verified through/).waitFor();
    const verified = flat(await chain.innerText());
    assert.match(verified, /^✓ ?Verified Chain verified through 1,204 records · head signed Verify now 38 records from before the chain began are not verified: nothing was computed over them when they were written\. Checked \d+[sm] ago\. Signing key 1111 2222 3333 4444: an export carries its public key, and node scripts\/verify-ledger\.mjs <file> --fingerprint 1111222233334444 checks it without Wanigan\.$/);
    await unclipped(chain.locator('.set-chain-text, .set-chain-note'), 'the chain status');
    record('the ledger reads "Chain verified through 1,204 records · head signed", counts the 38 pre-chain records as unverified, and names the signing key');
    await chain.scrollIntoViewIfNeeded();
    await page.locator('.pane.set').evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 160); });
    await shoot('ledger-verified');

    await page.evaluate(() => { window.__chain = 'broken'; });
    await chain.getByRole('button', { name: 'Verify now', exact: true }).click();
    await chain.getByText(/Chain breaks at record #812/).waitFor();
    const broken = flat(await chain.innerText());
    assert.match(broken, /^✕ ?Chain broken Chain breaks at record #812 \(Bash, .+\): its contents no longer produce the hash written beside them, so it was changed after it was written\. 773 records before it verified\./);
    assert.match(broken, /Record #1242 no longer carries the hash that was signed/);
    assert(!/Chain verified/.test(broken), 'a broken chain never also reads as verified');
    record('Verify now re-reads the chain; a break names the record, the tool and what kind of change it was, and counts only the records before it as verified');
    await shoot('ledger-broken');

    await page.evaluate(() => { window.__chain = 'mismatch'; });
    await chain.getByRole('button', { name: 'Verify now', exact: true }).click();
    await chain.getByText(/Head does not match/).waitFor();
    assert.match(flat(await chain.innerText()), /Chain recomputes through 1,204 records, but head signature does not match\./);
    record('a chain that recomputes under a head it no longer matches is reported as a mismatch, not as verified');

    await page.evaluate(() => { window.__chain = 'fail'; });
    await chain.getByRole('button', { name: 'Verify now', exact: true }).click();
    await chain.getByText(/The chain was not checked: /).waitFor();
    assert(!/Chain verified|head signed/.test(flat(await chain.innerText())), 'a failed check shows nothing verified');
    record('a check that fails reads "Not verified" with the reason, and nothing from the earlier success stays on screen');

    const attribution = page.locator('[data-section-title="Commit attribution"]');
    const toggle = attribution.getByRole('switch', { name: 'Add Assisted-by trailers' });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.match(flat(await attribution.innerText()), /Only sessions Wanigan started count — an agent run in another terminal is never seen, so a commit without the line is not a statement that no agent helped\./);
    await clearCalls();
    await toggle.click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'prefs.set'));
    assert.deepEqual((await calls('prefs.set'))[0].slice(1), ['assisted_by_trailers', '1']);
    await page.waitForFunction(() => document.querySelector('[data-section-title="Commit attribution"] [role="switch"]')?.getAttribute('aria-checked') === 'true');
    record('Commit attribution is off by default, says what an absent line does not mean, and turning it on writes assisted_by_trailers');
  }
  assert.deepEqual(errors, []);
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
    at: new Date().toISOString(),
    provenance: 'Actual Electron renderer from out/renderer of the checkout this script ran in; synthetic git, policy and prefs; no real agent calls',
    mode: before ? 'before' : 'after', checks, errors,
  }, null, 2) + '\n');
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
