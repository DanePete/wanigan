#!/usr/bin/env node
// Failure and race checks against the built renderer and a disposable demo.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { pageHelpers } from './ui-crawl-page.mjs';
import { crawlTarget } from './ui-crawl-target.mjs';

const out = join(root, '.artifacts', 'regressions');
mkdirSync(out, { recursive: true });
const failures = [];
// Optional exact names keep a focused check runnable without weakening the full gate.
const selected = new Set((process.env.WANIGAN_UI_CHECKS ?? '').split(',').filter(Boolean));
const matched = new Set();
const { base, gateway } = await startGateway({ demo: true, quiet: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['dark', 'light']) {
    const check = async (name, init, action, initArg) => {
      if (selected.size && !selected.has(name)) return;
      matched.add(name);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      await context.addInitScript(BRIDGE);
      if (init) await context.addInitScript(init, initArg);
      const page = await context.newPage();
      try { await action(page); console.log(`✓ ${theme}/${name}`); }
      catch (error) { failures.push(`${theme}/${name}: ${error.message}`); console.error(`✗ ${theme}/${name}: ${error.message}`); }
      finally {
        await page.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled' }).catch(() => {});
        await context.close();
      }
    };

    await check('history-search-beyond-loaded-results', () => {
      const original = window.wanigan.call;
      window.__historyQueries = [];
      window.wanigan.call = async (method, params) => {
        if (method !== 'history.list') return original(method, params);
        window.__historyQueries.push(params.query ?? '');
        const item = { provider: 'claude', conversationId: 'fixture', title: 'Recent conversation', firstPrompt: null,
          description: null, startedAt: 1, updatedAt: 1, branch: null, cwd: '/fixture', cardKey: null,
          model: null, accountId: 'claude', accountLabel: 'Default', via: null, sources: ['claude'], sessionId: null, live: false };
        if (params.query === 'older needle') return [{ ...item, id: 'older-fixture', title: 'Older needle beyond the first 500' }];
        if (params.query) return [];
        return Array.from({ length: 500 }, (_, i) => ({ ...item, id: `recent-${i}` }));
      };
    }, async (page) => {
      await page.goto(`${base}#/p/NS/history`);
      const search = page.getByRole('textbox', { name: 'Search conversations' });
      await search.fill('older needle');
      await page.waitForFunction(() => document.querySelector('.history-list')?.textContent.includes('Older needle beyond the first 500'));
      assert.ok((await page.evaluate(() => window.__historyQueries)).includes('older needle'), 'the core searches beyond the initial result window');
      assert.equal(await search.evaluate(node => node === document.activeElement), true, 'a reply preserves the search input and focus');
      await search.fill('no matching conversation');
      await page.waitForFunction(() => document.querySelector('.history-list')?.textContent.includes('Nothing matches'));
      assert.equal(await search.isVisible(), true, 'an empty search result does not remove its own search control');
      await search.fill('');
      await page.waitForFunction(() => document.querySelectorAll('.hrow').length === 500);
    });

    await check('crawl-target-survives-replacement', null, async (page) => {
      await page.addInitScript(`(${pageHelpers})();`);
      await page.goto(`${base}#/needs`);
      await page.waitForSelector('.rail');
      const signature = await page.evaluate(() => {
        const box = document.createElement('section');
        box.className = 'crawl-fixture';
        const button = document.createElement('button');
        button.textContent = 'Pick added line 3';
        box.append(button);
        document.body.append(box);
        const [item] = window.__crawl.items('.crawl-fixture');
        window.__crawl.mark('.crawl-fixture', item);
        // A completed query can replace a React subtree after observation but
        // before Playwright resolves the click. The control still exists.
        const replacement = document.createElement('button');
        replacement.textContent = button.textContent;
        replacement.onclick = () => { window.__crawlPicked = (window.__crawlPicked ?? 0) + 1; };
        button.replaceWith(replacement);
        return item.sig;
      });
      await crawlTarget(page, '.crawl-fixture', signature).click({ timeout: 3_000 });
      assert.equal(await page.evaluate(() => window.__crawlPicked), 1, 'the current control gets exactly one click');
    });

    for (const change of ['earlier neighbor removed', 'target removed', 'ambiguous replacement']) {
      await check(`crawl-target-${change.replaceAll(' ', '-')}`, null, async (page) => {
        await page.addInitScript(`(${pageHelpers})();`);
        await page.goto(`${base}#/needs`);
        await page.waitForSelector('.rail');
        const signature = await page.evaluate((change) => {
          const box = document.createElement('section');
          box.className = 'crawl-fixture';
          for (const line of [1, 2, 3]) {
            const button = document.createElement('button');
            button.textContent = `Pick added line ${line}`;
            button.onclick = () => { window.__crawlPicked = line; };
            box.append(button);
          }
          document.body.append(box);
          const item = window.__crawl.items('.crawl-fixture')[1];
          window.__crawl.mark('.crawl-fixture', item);
          if (change === 'earlier neighbor removed') box.firstChild.remove();
          else {
            box.children[1].remove();
            if (change === 'ambiguous replacement') {
              for (let i = 0; i < 2; i++) {
                const duplicate = document.createElement('button');
                duplicate.textContent = 'Pick added line 2';
                duplicate.onclick = () => { window.__crawlPicked = 99; };
                box.append(duplicate);
              }
            }
          }
          return item.sig;
        }, change);
        const target = crawlTarget(page, '.crawl-fixture', signature);
        if (change === 'earlier neighbor removed') {
          await target.click({ timeout: 3_000 });
          assert.equal(await page.evaluate(() => window.__crawlPicked), 2, 'the marked control keeps its identity when a neighbor disappears');
        } else {
          assert.equal(await target.count(), 0, 'a missing or ambiguous control cannot be replaced by a neighbor');
          assert.equal(await page.evaluate(() => window.__crawlPicked), undefined);
        }
      });
    }

    for (const change of ['removed before marking', 'identical old sibling']) {
      await check(`crawl-target-${change.replaceAll(' ', '-')}`, null, async (page) => {
        await page.addInitScript(`(${pageHelpers})();`);
        await page.goto(`${base}#/needs`);
        await page.waitForSelector('.rail');
        const signature = await page.evaluate((change) => {
          const box = document.createElement('section');
          box.className = 'crawl-fixture';
          for (const line of [1, 2, 3]) {
            const button = document.createElement('button');
            button.textContent = change === 'identical old sibling' ? 'Remove' : `Pick added line ${line}`;
            button.onclick = () => { window.__crawlPicked = line; };
            box.append(button);
          }
          document.body.append(box);
          const item = window.__crawl.items('.crawl-fixture')[1];
          if (change === 'removed before marking') box.firstChild.remove();
          window.__crawl.mark('.crawl-fixture', item);
          if (change === 'identical old sibling') { box.children[1].remove(); box.firstChild.remove(); }
          return item.sig;
        }, change);
        const target = crawlTarget(page, '.crawl-fixture', signature);
        if (change === 'removed before marking') {
          await target.click({ timeout: 3_000 });
          assert.equal(await page.evaluate(() => window.__crawlPicked), 2, 'discovery identity survives until marking');
        } else {
          assert.equal(await target.count(), 0, 'an old sibling cannot masquerade as a new replacement');
          assert.equal(await page.evaluate(() => window.__crawlPicked), undefined);
        }
      });
    }

    await check('crawl-target-after-reload', null, async (page) => {
      await page.addInitScript(`(${pageHelpers})();`);
      const fixture = () => {
        const box = document.createElement('section');
        box.className = 'crawl-fixture';
        for (const name of ['Pick added line 2', 'Remove', 'Remove']) {
          const button = document.createElement('button');
          button.textContent = name;
          button.onclick = () => { window.__crawlPicked = name; };
          box.append(button);
        }
        document.body.append(box);
        return window.__crawl.items('.crawl-fixture');
      };
      await page.goto(`${base}#/needs`);
      await page.waitForSelector('.rail');
      const [unique, duplicate] = await page.evaluate(fixture);
      await page.reload();
      await page.waitForSelector('.rail');
      await page.evaluate(fixture);
      assert.equal(await page.evaluate(item => window.__crawl.mark('.crawl-fixture', item), duplicate), null, 'ambiguous identities after reload are refused');
      assert.ok(await page.evaluate(item => window.__crawl.mark('.crawl-fixture', item), unique));
      await crawlTarget(page, '.crawl-fixture', unique.sig).click({ timeout: 3_000 });
      assert.equal(await page.evaluate(() => window.__crawlPicked), 'Pick added line 2');
    });

    for (const chosen of [false, true]) {
      await check(`terminal-late-replay-${chosen ? 'keeps-composer-focus' : 'initial-focus'}`, () => {
        const call = window.wanigan.call;
        window.__terminalInputs = 0;
        window.wanigan.call = async (method, params) => {
          if (method === 'sessions.input') window.__terminalInputs++;
          const reply = await call(method, params);
          if (method === 'sessions.watch' && location.hash.includes('/s/')) await new Promise(resolve => { window.__finishReplay = resolve; });
          return reply;
        };
      }, async page => {
        await page.goto(`${base}#/needs`);
        const id = await page.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find(s => s.provider === 'claude').id);
        await page.evaluate(id => { location.hash = `#/p/NS/s/${id}`; }, id);
        await page.waitForFunction(() => typeof window.__finishReplay === 'function');
        const input = page.locator('#composer');
        if (chosen) await input.fill('My new draft');
        await page.evaluate(() => window.__finishReplay());
        await page.evaluate(() => new Promise(requestAnimationFrame));
        if (chosen) {
          assert.equal(await input.evaluate(el => el === document.activeElement), true, 'a late terminal replay must not take focus from the chosen composer');
          await page.keyboard.type(' stays here');
          assert.equal(await input.inputValue(), 'My new draft stays here');
          assert.equal(await page.evaluate(() => window.__terminalInputs), 0, 'composer typing never reaches terminal input');
        } else {
          assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')), 'an untouched session still starts with terminal focus');
        }
      });
    }

    await check('segmented-keyboard', null, async page => {
      await page.goto(`${base}#/needs`);
      await page.locator('.rail-action').filter({ hasText: 'New card' }).click();
      const group = page.locator('.dialog [role="radiogroup"]').first();
      const options = group.getByRole('radio');
      const count = await options.count();
      assert.ok(count > 1);
      const selected = await options.evaluateAll(nodes => nodes.findIndex(el => el.getAttribute('aria-checked') === 'true'));
      await options.nth(selected).focus();
      await page.keyboard.press('ArrowRight');
      const next = (selected + 1) % count;
      assert.equal(await options.nth(next).getAttribute('aria-checked'), 'true');
      assert.equal(await options.nth(next).evaluate(el => el === document.activeElement), true);
      assert.equal(await group.locator('[role="radio"][tabindex="0"]').count(), 1);
      await page.keyboard.press('End');
      assert.equal(await options.last().getAttribute('aria-checked'), 'true');
      await page.keyboard.press('ArrowRight');
      assert.equal(await options.first().getAttribute('aria-checked'), 'true', 'arrow navigation wraps');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await options.last().getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Home');
      assert.equal(await options.first().getAttribute('aria-checked'), 'true');
    });

    await check('keyboard-focus-visible', null, async page => {
      await page.goto(`${base}#/p/NS/board?card=NS-7`);
      await page.waitForSelector('.drawer .btn-primary');
      const visual = el => {
        const style = getComputedStyle(el);
        const canvas = document.createElement('canvas');
        const paint = canvas.getContext('2d');
        paint.fillStyle = style.outlineColor;
        paint.fillRect(0, 0, 1, 1);
        return {
          style: style.outlineStyle, width: parseFloat(style.outlineWidth),
          color: style.outlineColor, alpha: paint.getImageData(0, 0, 1, 1).data[3],
        };
      };
      for (const [kind, selector] of [
        ['primary', '.drawer .btn-primary'],
        ['selected-radio', '.drawer [role="radio"][aria-checked="true"]'],
        ['secondary', '.drawer .btn:not(.btn-primary):not(.btn-icon)'],
      ]) {
        const control = page.locator(selector).first();
        await control.evaluate(el => el.blur());
        const before = await control.evaluate(visual);
        await page.keyboard.press('Tab');
        await control.focus();
        assert.equal(await control.evaluate(el => el.matches(':focus-visible')), true);
        await page.screenshot({ path: join(out, `${theme}-keyboard-focus-${kind}.png`), animations: 'disabled' });
        const after = await control.evaluate(visual);
        assert.notDeepEqual(after, before, `${kind} needs a visible keyboard focus indicator`);
        assert.ok(after.width > 0 && !['none', 'hidden'].includes(after.style) && after.alpha > 0,
          `${kind} needs an outline that paints, not merely a computed-style change`);
      }
    });

    await check('update-disclosure', () => {
      window.__wgApp.settings.updateChecks = 'ask';
    }, async page => {
      await page.goto(`${base}#/settings`);
      const settings = page.locator('[aria-labelledby="set-updates"]');
      await settings.waitFor();
      const text = await settings.textContent();
      assert.doesNotMatch(text, /sends nothing else|coming soon|working with Apple|macOS requires/i);
      assert.match(text, /connection metadata/i);
      assert.match(text, /manual|download.*install/i);
      const rail = await page.locator('.rail-update-ask').textContent();
      assert.doesNotMatch(rail, /sends nothing else/i);
      assert.match(rail, /connection metadata/i);
      await settings.scrollIntoViewIfNeeded();
    });

    await check('checkpoint-read-error', () => {
      const call = window.wanigan.call;
      window.__checkpointReads = 0;
      window.wanigan.call = async (method, params) => {
        if (method !== 'sessions.checkpoints') return call(method, params);
        if (++window.__checkpointReads === 1) throw new Error('Checkpoint history could not be read');
        const reply = await call(method, params);
        window.__checkpointCount = reply.checkpoints.length;
        return reply;
      };
    }, async (page) => {
      await page.goto(`${base}#/needs`);
      const id = await page.evaluate(async () => (await window.wanigan.call('sessions.list', {})).find(session => session.title === 'Low-stock badge on product cards').id);
      await page.evaluate(id => { location.hash = `#/p/NS/s/${id}`; }, id);
      await page.waitForSelector('.timeline');
      await page.waitForFunction(() => window.__checkpointReads > 0);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.match(await page.locator('.timeline').textContent(), /Checkpoint history could not be read/);
      await page.locator('.timeline').screenshot({ path: join(out, `${theme}-checkpoint-error.png`) });
      await page.locator('.timeline').getByRole('button', { name: 'Retry', exact: true }).click();
      await page.waitForSelector('.timeline .turn-change');
      assert.ok(await page.evaluate(() => window.__checkpointCount > 0));
      assert.doesNotMatch(await page.locator('.timeline').textContent(), /Checkpoint history could not be read/);
    });

    for (const action of ['undo', 'redo']) {
      await check(`checkpoint-cached-${action}-read-error`, (action) => {
        const call = window.wanigan.call;
        const state = window.__cachedCheckpoints = { fail: false, failures: 0, replies: [], actions: [], turnFiles: [] };
        window.wanigan.call = async (method, params) => {
          if (method === 'sessions.undoTurn' || method === 'sessions.redoTurn') {
            state.actions.push({ method, params });
            throw new Error('This read-failure fixture must not change the worktree');
          }
          if (method === 'sessions.checkpoints' && state.fail) {
            state.failures++;
            throw new Error(`Cached ${action} checkpoints could not be read`);
          }
          const reply = await call(method, params);
          if (method === 'sessions.turnChanges') state.turnFiles = reply.files.map(file => file.path);
          if (method !== 'sessions.checkpoints') return reply;
          state.replies.push(reply);
          // The redo view uses the same real checkpoints/diff, with only its
          // action changed. No actual Undo is needed to seed this read test.
          return action === 'redo' && reply.last ? { ...reply, last: { ...reply.last, action } } : reply;
        };
      }, async (page) => {
        const label = action === 'undo' ? 'Undo this turn' : 'Redo';
        const verb = action === 'undo' ? 'Undo' : 'Redo';
        const error = `Cached ${action} checkpoints could not be read`;
        await page.goto(`${base}#/needs`);
        const session = await page.evaluate(async () => (await window.wanigan.call('sessions.list', {}))
          .find(session => session.title === 'Low-stock badge on product cards'));
        assert.ok(session, 'the actual seeded low-stock session exists');
        await page.evaluate(id => { location.hash = `#/p/NS/s/${id}`; }, session.id);
        const timeline = page.locator('.timeline');
        const timelineAction = timeline.getByRole('button', { name: label, exact: true });
        await timelineAction.waitFor({ state: 'visible' });
        const before = await page.evaluate(() => window.__cachedCheckpoints.replies.at(-1));
        assert.ok(before.checkpoints.length > 0, 'checkpoint data was loaded successfully before the failure');
        assert.ok(before.last?.files > 0 && !before.last.refusal, 'the real last turn is actionable');
        assert.equal(before.last.action, 'undo', 'the base fixture is a real turn that has not been undone');
        assert.ok(before.checkpoints.some(checkpoint => checkpoint.id === before.last.turnCheckpointId));
        const turn = timeline.locator('.turn-change').filter({ has: page.getByRole('button', { name: label, exact: true }) });
        await turn.locator('.turn-diff').click();
        const panel = page.locator('.turn-panel');
        const panelAction = panel.getByRole('button', { name: label, exact: true });
        await panelAction.waitFor({ state: 'visible' });
        await panelAction.click();
        const dialog = page.getByRole('dialog', { name: `${verb} turn ${before.last.turn}?`, exact: true });
        const confirm = dialog.getByRole('button', { name: `${verb} turn ${before.last.turn}`, exact: true });
        await page.waitForFunction(() => document.querySelector('.undo-files')?.children.length > 0);
        assert.equal(await confirm.isEnabled(), true, 'the cached confirmation really was callable before failure');
        assert.deepEqual(await dialog.locator('.undo-files .fpath').evaluateAll(nodes => nodes.map(node => node.title)),
          await page.evaluate(() => window.__cachedCheckpoints.turnFiles), 'the confirmation lists the actual checkpoint files');
        const cachedConfirm = await confirm.elementHandle();
        assert.ok(cachedConfirm);
        await page.screenshot({ path: join(out, `${theme}-checkpoint-cached-${action}-before.png`), animations: 'disabled' });
        let renameAttempted = false;
        try {
          // A real core event refreshes useQuery after a cached success. The
          // stand-in affects only that later read, not the event or seed data.
          renameAttempted = true;
          await page.evaluate(async ({ id, title }) => {
            window.__cachedCheckpoints.fail = true;
            await window.wanigan.call('sessions.rename', { id, title });
          }, { id: session.id, title: `${session.title} — cached ${action} failure` });
          await timeline.getByRole('alert').getByText(error, { exact: true }).waitFor({ state: 'visible' });
          assert.equal(await timeline.getByRole('alert').locator('.error-text').textContent(), error);
          assert.ok(await page.evaluate(() => window.__cachedCheckpoints.failures > 0));
          assert.equal(await page.getByRole('button', { name: /^(Undo this turn|Redo|Undo turn \d+|Redo turn \d+)$/ }).count(), 0,
            'a failed refresh removes stale timeline, panel and confirmation actions');
          assert.equal(await dialog.count(), 0, 'an already-open cached confirmation disappears on the error');
          assert.equal(await cachedConfirm.evaluate(button => button.isConnected), false);
          await cachedConfirm.evaluate(button => button.click());
          assert.deepEqual(await page.evaluate(() => window.__cachedCheckpoints.actions), [],
            'neither action was sent, including through the detached cached confirmation');
          await page.screenshot({ path: join(out, `${theme}-checkpoint-cached-${action}-error.png`), animations: 'disabled' });
          const repliesBeforeRetry = await page.evaluate(() => window.__cachedCheckpoints.replies.length);
          await page.evaluate(() => { window.__cachedCheckpoints.fail = false; });
          await timeline.getByRole('button', { name: 'Retry', exact: true }).click();
          await page.waitForFunction(count => window.__cachedCheckpoints.replies.length > count, repliesBeforeRetry);
          await timeline.getByRole('alert').waitFor({ state: 'detached' });
          const after = await page.evaluate(() => window.__cachedCheckpoints.replies.at(-1));
          assert.deepEqual(after.checkpoints.map(checkpoint => checkpoint.id), before.checkpoints.map(checkpoint => checkpoint.id),
            'Retry returns the same positive actual checkpoint data');
          assert.deepEqual(after.last, before.last);
          assert.equal(await timelineAction.isVisible(), true, 'Retry restores the timeline action');
          assert.equal(await panelAction.isVisible(), true, 'Retry restores the open panel action');
          // The user had opened this dialog before the read failed. If it is
          // restored, wait for its new actual diff before recording recovery.
          if (await dialog.count()) {
            await page.waitForFunction(() => document.querySelector('.undo-files')?.children.length > 0);
            assert.equal(await confirm.isEnabled(), true, 'a restored confirmation uses successfully reloaded diff data');
            assert.deepEqual(await dialog.locator('.undo-files .fpath').evaluateAll(nodes => nodes.map(node => node.title)),
              await page.evaluate(() => window.__cachedCheckpoints.turnFiles));
          }
          assert.deepEqual(await page.evaluate(() => window.__cachedCheckpoints.actions), []);
          await page.screenshot({ path: join(out, `${theme}-checkpoint-cached-${action}-recovered.png`), animations: 'disabled' });
        } finally {
          if (renameAttempted) await page.evaluate(async ({ id, title }) => {
            window.__cachedCheckpoints.fail = false;
            await window.wanigan.call('sessions.rename', { id, title });
          }, { id: session.id, title: session.title });
          await cachedConfirm.dispose();
        }
      }, action);
    }

    await check('undo-dialog-cached-diff-error', () => {
      const call = window.wanigan.call;
      const onStatus = window.wanigan.onStatus;
      const listeners = new Set();
      window.wanigan.onStatus = listener => {
        listeners.add(listener);
        const off = onStatus(listener);
        return () => { listeners.delete(listener); off(); };
      };
      // BRIDGE has no native reconnect control. Exercise the same subscription
      // useQuery receives when its transport reports that it is connected again.
      window.__diffReconnect = () => { for (const listener of [...listeners]) listener('connected'); };
      const state = window.__undoDiff = { fail: false, failures: 0, replies: [], actions: [] };
      window.wanigan.call = async (method, params) => {
        if (method === 'sessions.undoTurn' || method === 'sessions.redoTurn') {
          state.actions.push({ method, params });
          throw new Error('This read-failure fixture must not change the worktree');
        }
        if (method === 'sessions.turnChanges' && state.fail) {
          state.failures++;
          throw new Error('Cached turn changes could not be read');
        }
        const reply = await call(method, params);
        if (method === 'sessions.turnChanges') state.replies.push(reply);
        return reply;
      };
    }, async page => {
      await page.goto(`${base}#/needs`);
      const id = await page.evaluate(async () => (await window.wanigan.call('sessions.list', {}))
        .find(session => session.title === 'Low-stock badge on product cards')?.id);
      assert.ok(id, 'the actual seeded low-stock session exists');
      await page.evaluate(id => { location.hash = `#/p/NS/s/${id}`; }, id);
      await page.locator('.timeline').getByRole('button', { name: 'Undo this turn', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /^Undo turn \d+\?$/ });
      const confirm = dialog.getByRole('button', { name: /^Undo turn \d+$/ });
      await page.waitForFunction(() => document.querySelector('.undo-files')?.children.length > 0);
      const before = await page.evaluate(() => window.__undoDiff.replies.at(-1));
      assert.ok(before.files.length > 0 && before.gone === null, 'real checkpoint changes loaded before the reconnect');
      assert.deepEqual(await dialog.locator('.undo-files .fpath').evaluateAll(nodes => nodes.map(node => node.title)),
        before.files.map(file => file.path));
      assert.equal(await confirm.isEnabled(), true, 'Undo is enabled after the successful diff read');
      await page.screenshot({ path: join(out, `${theme}-undo-dialog-diff-before.png`), animations: 'disabled' });
      await page.evaluate(() => { window.__undoDiff.fail = true; window.__diffReconnect(); });
      await dialog.getByText('Cached turn changes could not be read', { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await dialog.locator('.error-text').textContent(), 'Cached turn changes could not be read');
      assert.ok(await page.evaluate(() => window.__undoDiff.failures > 0));
      await page.screenshot({ path: join(out, `${theme}-undo-dialog-diff-error.png`), animations: 'disabled' });
      assert.equal(await confirm.isDisabled(), true, 'an error after a cached diff must disable its confirmation');
      await confirm.evaluate(button => button.click());
      assert.deepEqual(await page.evaluate(() => window.__undoDiff.actions), [], 'a failed diff cannot send an Undo/Redo request');
      const repliesBeforeRetry = await page.evaluate(() => window.__undoDiff.replies.length);
      await page.evaluate(() => { window.__undoDiff.fail = false; window.__diffReconnect(); });
      await page.waitForFunction(count => window.__undoDiff.replies.length > count, repliesBeforeRetry);
      await dialog.getByText('Cached turn changes could not be read', { exact: true }).waitFor({ state: 'detached' });
      const after = await page.evaluate(() => window.__undoDiff.replies.at(-1));
      assert.deepEqual(after, before, 'retry reads the same actual checkpoint diff');
      assert.equal(await confirm.isEnabled(), true, 'a successful retry restores the confirmation');
      assert.deepEqual(await page.evaluate(() => window.__undoDiff.actions), []);
      await page.screenshot({ path: join(out, `${theme}-undo-dialog-diff-recovered.png`), animations: 'disabled' });
    });

    await check('jev-estimated-cost', () => {
      const call = window.wanigan.call;
      window.wanigan.call = async (method, params) => {
        const reply = await call(method, params);
        return method === 'jev.status' ? { ...reply, online: true, calls: 2, errors: 1, costUsd: 0.0123 } : reply;
      };
    }, async (page) => {
      await page.goto(`${base}#/settings`);
      const jev = page.locator('[aria-labelledby="set-jev"]');
      await page.waitForFunction(() => document.querySelector('[aria-labelledby="set-jev"]')?.textContent.includes('0.0123'));
      const text = await jev.textContent();
      assert.match(text, /estimated/i);
      assert.doesNotMatch(text, /spent|million words|under a second/i);
      assert.match(text, /project name/i);
      await jev.scrollIntoViewIfNeeded();
    });

    for (const fixture of [
      { name: 'jev-unknown-cost', calls: 2, knownCostUsd: 0, unknownUsageCalls: 2 },
      { name: 'jev-partial-cost', calls: 3, knownCostUsd: 0.042, unknownUsageCalls: 1 },
    ]) {
      await check(fixture.name, (fixture) => {
        const call = window.wanigan.call;
        window.wanigan.call = async (method, params) => {
          const reply = await call(method, params);
          return method === 'jev.status' ? {
            ...reply, configured: 'env', online: true, errors: 0, costUsd: null,
            calls: fixture.calls, callsToday: fixture.calls, knownCostUsd: fixture.knownCostUsd, unknownUsageCalls: fixture.unknownUsageCalls,
          } : reply;
        };
      }, async (page) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewportSize({ width: 960, height: 700 });
        await page.goto(`${base}#/settings`);
        const jev = page.locator('[aria-labelledby="set-jev"]');
        await page.waitForFunction(() => document.querySelector('[aria-labelledby="set-jev"]')?.textContent.includes('Total cost unknown.'), undefined, { timeout: 8_000 });
        const text = await jev.textContent();
        assert.match(text, /Total cost unknown\./);
        assert.ok(text.includes(`$${fixture.knownCostUsd.toFixed(4)} estimated from calls with usable token counts.`));
        assert.ok(text.includes(`${fixture.unknownUsageCalls} successful call${fixture.unknownUsageCalls === 1 ? ' has' : 's have'} no usable token count.`));
        assert.doesNotMatch(text, /estimated from reported usage in all|NaN|Infinity|\$-/);
        await jev.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(out, `${theme}-${fixture.name}-settings.png`), animations: 'disabled' });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Settings has no horizontal overflow');
        await page.goto(`${base}#/p/NS/board`);
        const health = page.locator('.jev-strip .jev-health');
        const cost = health.getByText('Cost unknown', { exact: true });
        await cost.waitFor({ state: 'visible', timeout: 8_000 });
        const healthBox = await health.boundingBox();
        const costBox = await cost.boundingBox();
        assert.ok(healthBox && costBox && costBox.x >= healthBox.x - 1 && costBox.x + costBox.width <= healthBox.x + healthBox.width + 1,
          'the board does not clip the unknown-cost label');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the board has no horizontal overflow');
        assert.deepEqual(errors, []);
      }, fixture);
    }

    await check('crash-does-not-claim-core-health', () => {
      const call = window.wanigan.call;
      window.wanigan.status = async () => 'unavailable';
      window.wanigan.call = (method, params) => method === 'sessions.list' ? Promise.resolve({ broken: true }) : call(method, params);
    }, async (page) => {
      await page.goto(`${base}#/running`);
      await page.waitForSelector('.view-crash');
      const text = await page.locator('.view-crash').textContent();
      assert.doesNotMatch(text, /sessions and your data are fine/);
      assert.match(text, /core status/i);
      assert.ok(await page.locator('.view-crash').getByRole('button', { name: 'Reload this view' }).count());
    });

    await check('settings-late-response', () => {
      window.__initialApp = [];
      window.wanigan.appState = () => new Promise((resolve) => window.__initialApp.push(resolve));
    }, async (page) => {
      await page.goto(`${base}#/settings`);
      await page.waitForSelector('#set-general');
      await page.evaluate(() => window.__wgSetApp({ ...window.__wgApp, settings: { ...window.__wgApp.settings, keepAwake: false } }));
      const awake = page.getByRole('checkbox', { name: /Keep the Mac awake/ });
      await page.waitForFunction(() => document.querySelector('#set-general')?.parentElement.parentElement.querySelector('input')?.checked === false);
      await page.evaluate(() => { for (const resolve of window.__initialApp) resolve({ ...window.__wgApp, settings: { ...window.__wgApp.settings, keepAwake: true } }); });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await awake.isChecked(), false, 'a late snapshot must not overwrite a newer setting');
    });

    await check('comment-completion-race', () => {
      const call = window.wanigan.call;
      window.__commentCalls = 0;
      window.wanigan.call = async (method, params) => {
        if (method !== 'cards.comment') return call(method, params);
        window.__commentCalls++;
        const reply = await call(method, params);
        if (window.__commentCalls === 1) {
          // A second submit after the RPC completes but before React commits
          // the cleared draft: reproduce the CI failure without timing luck.
          let remaining = 10;
          const again = () => { if (--remaining) queueMicrotask(again); else document.querySelector('.comment-new')?.requestSubmit(); };
          queueMicrotask(again);
        }
        return reply;
      };
    }, async (page) => {
      await page.goto(`${base}#/p/NS/board?card=NS-1`);
      const input = page.locator('#comment-new');
      await input.fill('Completion race');
      await input.press('Meta+Enter');
      await page.waitForFunction(() => window.__commentCalls > 0 && document.querySelector('#comment-new')?.value === '');
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await page.evaluate(() => window.__commentCalls), 1, 'one comment even between RPC completion and render');
    });

    for (const retyped of [false, true]) {
      await check(retyped ? 'comment-retyped-draft' : 'comment-next-draft', () => {
        const call = window.wanigan.call;
        window.wanigan.call = async (method, params) => {
          const reply = await call(method, params);
          if (method === 'cards.comment') await new Promise((resolve) => { window.__finishComment = resolve; });
          return reply;
        };
      }, async (page) => {
        await page.goto(`${base}#/p/NS/board?card=NS-1`);
        const input = page.locator('#comment-new');
        await input.fill('First comment');
        await input.press('Meta+Enter');
        await page.waitForFunction(() => typeof window.__finishComment === 'function');
        await input.fill('My next draft');
        if (retyped) await input.fill('First comment');
        await page.evaluate(() => window.__finishComment());
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(await input.inputValue(), retyped ? 'First comment' : 'My next draft', 'a completed send must not erase words typed while it was pending');
      });
    }

    await check('branch-read-error', () => {
      const call = window.wanigan.call;
      window.__branchReads = 0;
      window.wanigan.call = async (method, params) => {
        if (method !== 'projects.changes' || !params.cardId) return call(method, params);
        if (++window.__branchReads === 1) throw new Error('Git could not read this folder');
        const reply = await call(method, params);
        window.__branchFiles = reply.files.length;
        return reply;
      };
    }, async (page) => {
      await page.goto(`${base}#/p/NS/board?card=NS-13`);
      await page.waitForSelector('.drawer .branch-line');
      const branch = page.locator('.drawer .branch-line').locator('..');
      await page.waitForFunction(() => !document.querySelector('.drawer .branch-line')?.parentElement.textContent.includes('Reading changes'));
      const text = await branch.textContent();
      assert.match(text, /Git could not read this folder/);
      assert.doesNotMatch(text, /0 files changed/);
      await page.screenshot({ path: join(out, `${theme}-branch-read-error-before-retry.png`) });
      await branch.getByRole('button', { name: 'Retry', exact: true }).click();
      await branch.locator('.changes-pointer').waitFor();
      assert.equal(await branch.getByRole('alert').count(), 0, 'a successful retry clears the error');
      const files = await page.evaluate(() => window.__branchFiles);
      assert.ok(files > 0, 'the demo branch supplies actual changes');
      assert.match(await branch.locator('.changes-pointer').textContent(), new RegExp(`^${files} files? changed on this branch`));
    });

    for (const kind of ['criterion', 'session', 'chat']) for (const retyped of [false, true]) {
      await check(`${kind}-${retyped ? 'retyped' : 'next'}-draft`, () => {
        const call = window.wanigan.call;
        window.wanigan.call = async (method, params) => {
          if (method === 'chat.send') return new Promise((resolve) => { window.__finishDraft = () => resolve({ accepted: true }); });
          const reply = await call(method, params);
          if (['criteria.add', 'sessions.queue'].includes(method)) await new Promise((resolve) => { window.__finishDraft = resolve; });
          return reply;
        };
      }, async (page) => {
        await page.goto(`${base}#/p/NS/board?card=NS-1`);
        await page.waitForSelector('#criterion-new');
        let input = page.locator('#criterion-new');
        if (kind === 'session') {
          const id = await page.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find((s) => s.provider === 'claude').id);
          await page.evaluate((id) => { location.hash = `#/p/NS/s/${id}`; }, id);
          input = page.locator('#composer');
        } else if (kind === 'chat') {
          await page.locator('.chat-fab').click();
          input = page.locator('.chat textarea');
        }
        await input.fill('First draft');
        await input.press('Enter');
        await page.waitForFunction(() => typeof window.__finishDraft === 'function');
        await input.fill('My next draft');
        if (retyped) await input.fill('First draft');
        await page.evaluate(() => window.__finishDraft());
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(await input.inputValue(), retyped ? 'First draft' : 'My next draft');
      });
    }

    await check('core-status-late-response', () => {
      window.__statusListeners = [];
      window.wanigan.status = () => new Promise((resolve) => { window.__initialStatus = resolve; });
      window.wanigan.onStatus = (listener) => { window.__statusListeners.push(listener); return () => {}; };
    }, async (page) => {
      await page.goto(base);
      await page.waitForSelector('.core-status');
      await page.evaluate(() => { for (const listener of window.__statusListeners) listener('unavailable'); });
      await page.waitForSelector('.core-unavailable');
      await page.evaluate(() => window.__initialStatus('connected'));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await page.locator('.core-unavailable').count(), 1, 'a stale snapshot cannot call a disconnected core healthy');
    });

    await check('modal-focusable-links', null, async (page) => {
      await page.goto(base);
      await page.locator('.rail-action').filter({ hasText: 'New card' }).click();
      await page.waitForSelector('.dialog');
      await page.evaluate(() => {
        const box = document.querySelector('.dialog');
        const link = document.createElement('a');
        link.href = '#'; link.textContent = 'More information'; link.id = 'regression-link';
        const hidden = document.createElement('button'); hidden.hidden = true;
        const excluded = document.createElement('input'); excluded.tabIndex = -1; excluded.setAttribute('aria-label', 'Not in the tab order');
        box.append(link, hidden, excluded);
        link.focus();
      });
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.activeElement === document.querySelector('.dialog button')), 'Tab from the final link wraps to the first visible control');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'regression-link', 'reverse Tab includes links and skips hidden or excluded inputs');
    });

    await check('project-changes-error', () => {
      const call = window.wanigan.call;
      window.wanigan.call = (method, params) => method === 'projects.changes'
        ? (window.__changesRead = true, Promise.reject(new Error('Project changes could not be read'))) : call(method, params);
    }, async (page) => {
      await page.goto(`${base}#/p/NS/board?card=NS-7`);
      await page.waitForSelector('#criterion-new');
      await page.waitForFunction(() => window.__changesRead);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.match(await page.locator('.drawer').textContent(), /Project changes could not be read/);
      assert.ok(await page.locator('.drawer').getByRole('button', { name: 'Retry', exact: true }).count());
      await page.locator('.drawer [role="alert"]').scrollIntoViewIfNeeded();
    });

    await check('remove-branch-confirmation', () => {
      const call = window.wanigan.call;
      window.__removeBranchCalls = 0;
      window.wanigan.call = (method, params) => {
        if (method !== 'cards.removeWorktree') return call(method, params);
        window.__removeBranchCalls++;
        return Promise.resolve({ ok: true });
      };
    }, async (page) => {
      await page.goto(`${base}#/p/NS/board?card=NS-13`);
      await page.locator('.drawer').getByRole('button', { name: 'Remove branch', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__removeBranchCalls), 0, 'opening confirmation must not remove anything');
      const confirm = page.getByRole('dialog', { name: 'Remove branch and worktree?' });
      await confirm.screenshot({ path: join(out, `${theme}-remove-branch-dialog.png`), animations: 'disabled' });
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__removeBranchCalls), 0);
      await page.locator('.drawer').getByRole('button', { name: 'Remove branch', exact: true }).click();
      await confirm.getByRole('button', { name: 'Remove branch and worktree', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__removeBranchCalls), 1);
    });
  }
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}
for (const name of selected) if (!matched.has(name)) failures.push(`Unknown UI check: ${name}`);
if (failures.length) throw new Error(`${failures.length} UI regressions failed:\n${failures.join('\n')}`);
