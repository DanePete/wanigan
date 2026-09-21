#!/usr/bin/env node
// Real built renderer, isolated Electron profile, fictional bridge fixtures.
// No real provider, session, schedule, task, repository or model call is made.
// WANIGAN_RENDERER_ROOT=/path/to/frozen/renderer node scripts/probe-prompt-improve.mjs --before
// npm run build && node scripts/probe-prompt-improve.mjs
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..'), before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/prompt-improve', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-prompt-improve-'));
writeFileSync(path.join(dir, 'main.cjs'), "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));");
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const binary = process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' : 'node_modules/electron/dist/electron';
const app = await _electron.launch({ executablePath: path.join(root, binary), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const errors = [], checks = [], captures = [];
let page;
try {
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    localStorage.setItem('wanigan.project', 'p1');
    localStorage.setItem('wanigan.navigation.visible', 'closed');
    const api = window.wanigan;
    const proxy = (target, changes) => new Proxy(target, { get: (object, key) => key in changes ? changes[key] : object[key] });
    window.__promptProbeCalls = [];
    window.__promptImproveCalls = [];
    window.__promptImproveHold = false;
    window.__promptImproveFail = false;
    window.__promptImproveEnabled = true;
    window.__promptImproveNoKey = false;
    const improvementStatus = () => ({ enabled: window.__promptImproveEnabled, available: window.__promptImproveEnabled && !window.__promptImproveNoKey, reason: !window.__promptImproveEnabled ? 'Prompt improvement is disabled.' : window.__promptImproveNoKey ? 'Connect a Claude API key to improve prompts.' : null,
      providerLabel: 'Claude Platform API', models: [{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }],
      defaultModel: 'claude-haiku-4-5-20251001', maxPromptChars: 16000 });
    const interview = { id: 'fictional-interview', projectId: 'p1', seed: 'A saved fictional receipt idea', model: 'fixture-model', status: 'asking',
      turns: [{ question: 'What would make the receipt easier to use?', why: 'Describe the customer-visible outcome.', answer: null, at: Date.now() }],
      proposal: null, docketId: null, spendUsd: .02, budgetUsd: .6, maxQuestions: 10, calls: 1, detail: null, createdAt: Date.now(), updatedAt: Date.now() };
    const refuse = name => async (...args) => { window.__promptProbeCalls.push([name, ...args]); throw new Error('Fictional probe refuses real action: ' + name); };
    window.wanigan = proxy(api, {
      promptImprove: {
        status: async () => { window.__promptImproveCalls.push(['status']); return improvementStatus(); },
        setEnabled: async enabled => { window.__promptImproveCalls.push(['setEnabled', enabled]); window.__promptImproveEnabled = enabled; return improvementStatus(); },
        improve: async input => {
          window.__promptImproveCalls.push(['improve', structuredClone(input)]);
          if (window.__promptImproveHold) await new Promise(resolve => { window.__promptImproveRelease = resolve; });
          if (window.__promptImproveFail) throw new Error('Fictional rewrite failed. Your draft is safe.');
          return { requestId: input.requestId, prompt: 'Make checkout retries safe so one payment creates one order. Preserve successful checkout behavior and run the relevant tests.',
            questions: ['Which checkout behavior should the tests cover?'], model: input.model, inputTokens: 180, outputTokens: 65, estimatedCostUsd: .000505 };
        },
        cancel: async requestId => { window.__promptImproveCalls.push(['cancel', requestId]); return true; },
      },
      prefs: proxy(api.prefs, { all: async () => ({ ...await api.prefs.all(), motion: 'off', navSidebar: 'closed' }) }),
      providers: proxy(api.providers, { list: async () => (await api.providers.list()).map(provider => ({ ...provider, profileFingerprint: 'fixture-' + provider.id, capabilities: { ...provider.capabilities, headlessJson: true, headlessBudget: provider.id === 'claude' }, launchFields: [] })) }),
      accounts: proxy(api.accounts, { listForProvider: async () => [], resolveForLaunch: async () => ({ account: null, source: 'none', override: null, reason: 'Fictional fixture uses the CLI default login.' }) }),
      policy: proxy(api.policy, { trust: async () => 'project' }),
      key: proxy(api.key, { missingFor: async () => [] }),
      configPins: proxy(api.configPins, { check: async () => ({ state: 'none', summary: 'nothing', snapshot: { items: [], unreadable: [], digest: 'fictional' }, diff: null, lastAccepted: null }) }),
      sessions: proxy(api.sessions, { create: refuse('sessions.create'), write: refuse('sessions.write') }),
      terminal: proxy(api.terminal, { write: refuse('terminal.write') }),
      composer: proxy(api.composer, { skills: async () => [], saved: async () => [] }),
      companion: proxy(api.companion, { ask: refuse('companion.ask') }),
      relay: proxy(api.relay, { list: async () => [], create: refuse('relay.create'), preview: refuse('relay.preview') }),
      control: proxy(api.control, { list: async () => [], board: async () => [], events: async () => [], outcomes: async () => [], create: refuse('control.create') }),
      interview: proxy(api.interview, { models: async () => [{ id: 'fixture-model', label: 'Fictional planning model', costPerQuestion: .02 }], list: async () => [structuredClone(interview)], get: async () => structuredClone(interview), start: refuse('interview.start') }),
      headless: proxy(api.headless, { runs: async () => [], start: refuse('headless.start') }),
      attempts: proxy(api.attempts, { sets: async () => [], start: refuse('attempts.start') }),
      schedule: proxy(api.schedule, {
        list: async () => [], history: async () => [], daemon: async () => ({ supported: true, installed: false, detail: 'Fictional probe: while the app is open.' }),
        preview: async () => ({ describe: 'Every day at 09:00', fires: [Date.now() + 86400000] }), create: refuse('schedule.create'),
      }),
      batch: proxy(api.batch, { runs: async () => [] }),
    });
  });
  const go = async chord => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(chord); };
  const capture = async (name, field) => {
    await field.evaluate(element => element.scrollIntoView({ block: 'center' }));
    assert(await field.isVisible(), name + ' prompt is visible');
    if (!before && !name.startsWith('improve-')) {
      const action = field.locator('..').getByRole('button', { name: 'Improve prompt', exact: true });
      assert(await action.isVisible(), name + ' has the shared prompt action');
      const size = await action.evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, client: element.clientWidth, scroll: element.scrollWidth }; });
      assert(size.left >= 0 && size.right <= size.width && size.top >= 0 && size.bottom <= size.height && size.scroll <= size.client + 1, name + ' action is fully visible without text clipping');
    }
    await page.evaluate(() => document.activeElement?.blur());
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
        window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: theme, resolved: theme } }));
      }, theme);
      await page.waitForTimeout(160);
      const file = `${name}-${theme}.png`;
      await page.screenshot({ path: path.join(out, file), scale: 'css', animations: 'disabled' });
      captures.push(file);
    }
    checks.push(`${name}: prompt draft visible in both themes`);
    console.log(checks.at(-1));
  };
  await page.goto(rendererURL); await page.locator('.mission-room').waitFor();
  await page.waitForFunction(() => document.querySelector('.wanigan-orb')?.dataset.physics === 'ready');
  const improveCalls = () => page.evaluate(() => window.__promptImproveCalls.filter(call => call[0] === 'improve'));
  const dialog = () => page.getByRole('dialog', { name: 'Improve prompt', exact: true });
  const openImprovement = async field => {
    await field.locator('..').getByRole('button', { name: 'Improve prompt', exact: true }).click();
    await dialog().waitFor();
    await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).waitFor();
  };
  const orb = page.getByRole('textbox', { name: 'Talk to Wanigan', exact: true });
  if (!before) assert(await orb.locator('..').getByRole('button', { name: 'Improve prompt', exact: true }).isDisabled(), 'Empty drafts cannot request improvement');
  await orb.fill('help me understand what my agents need next'); await capture('orb', orb);
  if (!before) {
    await openImprovement(orb);
    assert.equal((await improveCalls()).length, 0, 'Opening the helper makes no model request');
    assert.match(await dialog().innerText(), /Claude Platform API/);
    assert.match(await dialog().innerText(), /token|cost|paid|billed/i);
    await capture('improve-review', dialog().getByRole('textbox', { name: 'Original prompt', exact: true }));
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
    assert.equal(await orb.inputValue(), 'help me understand what my agents need next');
    assert(await orb.locator('..').getByRole('button', { name: 'Improve prompt', exact: true }).evaluate(element => element === document.activeElement));
    checks.push('Opening the helper discloses the provider and token/cost use without a paid call; Escape preserves the draft and restores focus.');

    await page.evaluate(() => window.__promptImproveNoKey = true);
    await openImprovement(orb);
    await dialog().getByText('Connect a Claude API key to improve prompts.', { exact: true }).waitFor();
    assert(await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).isDisabled());
    await capture('improve-no-key', dialog().getByRole('textbox', { name: 'Original prompt', exact: true }));
    await dialog().getByRole('button', { name: 'Keep original', exact: true }).click();
    await page.evaluate(() => { window.__promptImproveNoKey = false; window.__promptImproveEnabled = false; });
    await openImprovement(orb);
    await dialog().getByText('Prompt improvement is disabled.', { exact: true }).waitFor();
    assert(await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).isDisabled());
    assert.equal(await dialog().getByRole('checkbox', { name: 'Enable prompt improvement', exact: true }).isChecked(), false);
    await capture('improve-disabled', dialog().getByRole('textbox', { name: 'Original prompt', exact: true }));
    await dialog().getByRole('checkbox', { name: 'Enable prompt improvement', exact: true }).check();
    await page.waitForFunction(() => [...document.querySelectorAll('.prompt-improve button')].some(button => button.textContent === 'Generate suggestion' && !button.disabled));
    assert.equal((await improveCalls()).length, 0);
    await dialog().getByRole('button', { name: 'Keep original', exact: true }).click();
    checks.push('Empty drafts, missing API credentials, and a disabled extension prevent generation. Enabling the extension restores availability without a rewrite request.');
  }

  await go('Meta+1'); await page.locator('.sessions-view').waitFor();
  const session = page.getByRole('textbox', { name: 'Message the agent', exact: true });
  if (!await session.isVisible()) await page.getByRole('tab').filter({ hasText: 'Checkout bug' }).click();
  if (!before) {
    await session.fill('x'.repeat(16001));
    assert(await session.locator('..').getByRole('button', { name: 'Improve prompt', exact: true }).isDisabled());
    assert.equal((await improveCalls()).length, 0);
    checks.push('An input above 16,000 characters disables prompt improvement and makes no request.');
  }
  await session.fill('fix checkout retries and test it'); await capture('sessions', session);
  if (!before) {
    await openImprovement(session);
    await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    const suggestion = dialog().getByRole('textbox', { name: 'Suggested prompt', exact: true });
    await suggestion.waitFor();
    assert.equal(await session.inputValue(), 'fix checkout retries and test it');
    assert.equal((await improveCalls()).length, 1);
    assert.match(await dialog().innerText(), /Which checkout behavior should the tests cover/);
    await capture('improve-suggestion', suggestion);
    await dialog().getByRole('button', { name: 'Keep original', exact: true }).click();
    assert.equal(await session.inputValue(), 'fix checkout retries and test it');
    await openImprovement(session); await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await suggestion.fill('Make checkout retries safe. Run the checkout tests and explain the result.');
    await dialog().getByRole('button', { name: 'Use suggestion', exact: true }).click();
    assert.equal(await session.inputValue(), 'Make checkout retries safe. Run the checkout tests and explain the result.');
    assert.deepEqual(await page.evaluate(() => window.__promptProbeCalls), []);
    checks.push('Only Generate suggestion requests a rewrite; questions stay visible, Keep original preserves the draft, and applying an edited suggestion changes the draft without sending.');

    await openImprovement(session); await page.evaluate(() => window.__promptImproveFail = true);
    await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await dialog().getByText('Fictional rewrite failed. Your draft is safe.', { exact: true }).waitFor();
    await capture('improve-failure', dialog().getByRole('textbox', { name: 'Original prompt', exact: true }));
    await dialog().getByRole('button', { name: 'Keep original', exact: true }).click();
    assert.equal(await session.inputValue(), 'Make checkout retries safe. Run the checkout tests and explain the result.');
    await page.evaluate(() => { window.__promptImproveFail = false; window.__promptImproveHold = true; });
    await openImprovement(session); await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await page.waitForFunction(() => typeof window.__promptImproveRelease === 'function');
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.__promptImproveHold = false; window.__promptImproveRelease(); delete window.__promptImproveRelease; });
    assert.equal(await session.inputValue(), 'Make checkout retries safe. Run the checkout tests and explain the result.');
    assert.equal(await page.evaluate(() => window.__promptImproveCalls.filter(call => call[0] === 'cancel').length), 1);
    checks.push('A failed rewrite retains the original draft; closing a pending rewrite cancels its request and ignores the late result.');

    await page.evaluate(() => window.__promptImproveHold = true);
    await openImprovement(session); await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await page.waitForFunction(() => typeof window.__promptImproveRelease === 'function');
    await session.fill('A newer draft that must survive a late rewrite.', { force: true });
    await page.evaluate(() => { window.__promptImproveHold = false; window.__promptImproveRelease(); delete window.__promptImproveRelease; });
    await dialog().getByRole('textbox', { name: 'Suggested prompt', exact: true }).waitFor();
    assert(await dialog().getByRole('button', { name: 'Use suggestion', exact: true }).isDisabled());
    assert.match(await dialog().innerText(), /original draft changed/);
    await dialog().getByRole('button', { name: 'Keep original', exact: true }).click();
    assert.equal(await session.inputValue(), 'A newer draft that must survive a late rewrite.');
    checks.push('A concurrent draft edit makes a late suggestion stale; applying is disabled and the newer draft survives.');
  }
  await go('Meta+T');
  const first = page.getByRole('textbox', { name: 'First message', exact: true });
  await first.fill('make checkout retries safe'); await capture('new-session', first);
  if (!before) {
    await openImprovement(first); await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await dialog().getByRole('textbox', { name: 'Suggested prompt', exact: true }).waitFor();
    await dialog().getByRole('textbox', { name: 'Suggested prompt', exact: true }).press('Meta+Enter');
    assert.deepEqual(await page.evaluate(() => window.__promptProbeCalls), [], 'A nested preview must contain the parent session launch shortcut');
    assert(await dialog().isVisible());
    await dialog().getByRole('button', { name: 'Keep original', exact: true }).click();
    checks.push('Cmd+Enter in a suggestion cannot trigger the enclosing new-session launch shortcut.');
    await page.evaluate(() => window.__promptImproveHold = true);
    await openImprovement(first); await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    await page.waitForFunction(() => typeof window.__promptImproveRelease === 'function');
    const project = page.locator('.session-launch').getByRole('combobox', { name: 'Project', exact: true });
    const currentProject = await project.inputValue();
    const canceledBefore = await page.evaluate(() => window.__promptImproveCalls.filter(call => call[0] === 'cancel').length);
    await project.selectOption(currentProject === 'p1' ? 'p2' : 'p1', { force: true });
    await dialog().waitFor({ state: 'hidden' });
    const nextDraft = await first.inputValue();
    await page.evaluate(() => { window.__promptImproveHold = false; window.__promptImproveRelease(); delete window.__promptImproveRelease; });
    assert.equal(await first.inputValue(), nextDraft);
    assert.equal(await page.evaluate(() => window.__promptImproveCalls.filter(call => call[0] === 'cancel').length), canceledBefore + 1);
    checks.push('Changing the originating project closes and cancels its pending improvement; the late result cannot overwrite the newly selected project’s draft.');
  }
  await page.getByRole('button', { name: 'Close new session', exact: true }).click();

  await go('Meta+Shift+R');
  const relay = page.getByRole('textbox', { name: 'What should this relay accomplish', exact: true });
  if (!await relay.isVisible()) await page.getByRole('button', { name: 'New relay', exact: true }).click();
  await relay.fill('make checkout safe if payment gets retried'); await capture('relay', relay);

  await go('Meta+3'); await page.getByRole('button', { name: 'New goal', exact: true }).click();
  const idea = page.getByRole('textbox', { name: 'Your goal idea', exact: true });
  await idea.fill('make receipts easier to use'); await capture('goal-idea', idea);
  await page.getByRole('button', { name: /A saved fictional receipt idea/ }).click();
  const answer = page.getByRole('textbox', { name: 'Your planning answer', exact: true });
  await answer.fill('make every receipt action work with the keyboard'); await capture('planning-answer', answer);
  await page.getByRole('button', { name: 'Continue without AI', exact: true }).click();
  const objective = page.getByRole('textbox', { name: 'Objective', exact: true });
  await objective.fill('make receipts accessible and easy to read'); await capture('goal-objective', objective);
  const acceptance = page.getByRole('textbox', { name: 'Acceptance checks · one per line', exact: true });
  await acceptance.fill('all receipt actions can be reached with keyboard\ntext is readable'); await capture('acceptance-checks', acceptance);
  await page.locator('.control-plan-summary').first().click();
  const instructions = page.locator('.control-plan-row').first().getByRole('textbox', { name: 'Instructions', exact: true });
  await instructions.fill('check every receipt action using the keyboard'); await capture('task-instructions', instructions);

  await go('Meta+0');
  const run = page.getByRole('textbox', { name: 'Task for every repository', exact: true });
  if (!await run.isVisible()) await page.getByRole('button', { name: 'New run', exact: true }).click();
  await run.fill('review release notes and tell me what is missing'); await capture('repository-run', run);
  await page.getByRole('button', { name: 'Back to runs', exact: true }).click();
  await page.getByRole('group', { name: 'Runs area', exact: true }).getByRole('button', { name: 'Compare attempts', exact: true }).click();
  await page.getByRole('button', { name: 'New attempt set', exact: true }).click();
  const attempt = page.getByRole('textbox', { name: 'Task for every attempt', exact: true });
  await attempt.fill('fix flaky checkout retry test without weakening assertions'); await capture('attempts', attempt);

  await go('Meta+8'); await page.getByRole('button', { name: 'New schedule', exact: true }).click();
  const scheduled = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await scheduled.fill('review changes and report risks. no edits'); await capture('schedule', scheduled);

  await go('Meta+Shift+H'); await page.locator('.mission-room').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
  await page.waitForFunction(() => innerWidth === 720);
  await capture('orb-compact', orb);
  if (!before) {
    await orb.fill('help me understand what my agents need next');
    await openImprovement(orb); await dialog().getByRole('button', { name: 'Generate suggestion', exact: true }).click();
    const suggestion = dialog().getByRole('textbox', { name: 'Suggested prompt', exact: true });
    await suggestion.waitFor(); await capture('improve-suggestion-compact', suggestion);
    const geometry = await dialog().evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: innerWidth }));
    assert(geometry.scroll <= geometry.client + 1 && geometry.left >= 0 && geometry.right <= geometry.width, 'Compact preview fits the viewport');
    await dialog().getByRole('button', { name: 'Keep original', exact: true }).click();
    checks.push('The 720px Orb and stacked suggestion preview fit the viewport in both themes.');
  }
  assert.deepEqual(await page.evaluate(() => window.__promptProbeCalls), []);
  assert.deepEqual(errors, []);
  checks.push('No live model call ran, and no session write, launch, run, relay, goal, or schedule mutation was attempted through the fictional bridge.');
  rmSync(path.join(out, 'failure.png'), { force: true });
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), before, rendererRoot: process.env.WANIGAN_RENDERER_ROOT ?? 'out/renderer', provenance: 'Built production renderer in an isolated Electron profile. All projects, sessions, accounts, models and bridge responses are fictional fixtures. These screenshots and checks establish DOM/layout behavior only; no main-process, IPC, persistence, live agent or provider claim.', checks, captures, errors, improveCalls: await page.evaluate(() => window.__promptImproveCalls) }, null, 2) + '\n');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(out, 'failure.png'), scale: 'css' }).catch(() => {}); console.error((await page.locator('body').innerText()).slice(0, 9000)); }
  throw error;
} finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
