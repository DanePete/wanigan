#!/usr/bin/env node
// Visit every view against a real, seeded core in both themes. Fails on console
// errors, error text reaching the screen, page-level horizontal overflow, or a
// view still loading. Screenshots go to .artifacts/ui/<theme>-<name>.png — look
// at them; the assertions only catch what was thought of in advance.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { liveStub } from './ui-live-stub.mjs';

const out = join(root, '.artifacts', 'ui');
mkdirSync(out, { recursive: true });
const { base, gateway } = await startGateway();

/*
 * Running › Watch. Tiles draw each session at its PTY's own size, scaled to
 * fit; watching must never resize a PTY, and keys reach a session only once
 * the owner hands them over. The spy records what the tiles ask of the core
 * and answers resize and input itself, so nothing here changes a session.
 */
async function spyOnCalls(page) {
  await page.evaluate(() => {
    if (window.__wgSpy) { window.__wgSpy.length = 0; return; }
    const real = window.wanigan.call.bind(window.wanigan);
    window.__wgSpy = [];
    window.__wgRealCall = real;
    window.wanigan.call = (method, params) => {
      if (/^sessions\.(resize|input|watch|unwatch)$/.test(method)) window.__wgSpy.push([method, params]);
      if (method === 'sessions.resize' || method === 'sessions.input') return Promise.resolve({ ok: true });
      return real(method, params);
    };
  });
}
async function stopSpying(page) {
  await page.evaluate(() => {
    if (!window.__wgRealCall) return;
    window.wanigan.call = window.__wgRealCall;
    delete window.__wgRealCall;
    delete window.__wgSpy;
  });
}
const spied = (page, method) => page.evaluate((m) => (window.__wgSpy ?? []).filter(([x]) => x === m).map(([, p]) => p), method);
/** Every live session's PTY size, as the core reports it. */
const ptySizes = (page) => page.evaluate(async () => {
  const call = window.__wgRealCall ?? window.wanigan.call.bind(window.wanigan);
  const sizes = {};
  for (const s of await call('sessions.list', { live: true })) {
    const { cols, rows } = await call('sessions.watch', { id: s.id });
    sizes[s.id] = `${cols}x${rows}`;
  }
  return sizes;
});
/** Tiles, each showing the session's real output. */
const tilesShowing = (page, count, timeout = 8000) => page.waitForFunction((n) => {
  const tiles = [...document.querySelectorAll('.watch-tile')];
  return tiles.length === n && tiles.every((t) => (t.querySelector('.xterm-rows')?.textContent ?? '').trim().length > 0);
}, count, { timeout });
/** Each rendered tile's drawing: inside its box, touching an edge (scaled to fit), and how big its text is. */
const tileFits = (page) => page.evaluate(() => [...document.querySelectorAll('.watch-tile')].flatMap((t) => {
  const host = t.querySelector('.terminal-fixed');
  const screen = t.querySelector('.xterm-screen');
  if (!host || !screen) return [];
  const box = host.getBoundingClientRect();
  const drawn = screen.getBoundingClientRect();
  const scale = drawn.width / screen.offsetWidth;
  return [{
    title: t.getAttribute('aria-label'),
    inside: drawn.width <= box.width + 1 && drawn.height <= box.height + 1,
    fills: scale > 0.999 || drawn.width >= box.width - 2 || drawn.height >= box.height - 2,
    px: Math.round(13 * scale * 10) / 10,
  }];
}));
const sameSizes = (a, b) => Object.keys(a).every((id) => b[id] === a[id]);

const failures = [];
const browser = await chromium.launch();
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await context.addInitScript(BRIDGE);
    await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    // Pretend every project was last looked at an hour ago, so "since you looked" has something to say.
    await context.addInitScript(`try {
      const hour = Date.now() - 3600000;
      const orig = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) { return k.startsWith('wanigan.lastSeen.') && orig.call(this, k) === null ? String(hour) : orig.call(this, k); };
    } catch {}`);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    await page.goto(base);
    await page.waitForSelector('.rail-projects a');
    const nsHref = await page.$eval('.rail-projects a[title*="northstar"]', (a) => a.getAttribute('href'));
    const ns = nsHref.match(/#\/p\/([^/]+)/)[1];
    const sessionHref = await (async () => {
      await page.goto(`${base}#/running`);
      await page.waitForSelector('.srow');
      return page.$eval('.srow', (a) => a.getAttribute('href'));
    })();
    const limitedHref = await page.$eval('.srow:has-text("Rate limiter drops bursts")', (a) => a.getAttribute('href'));
    // Started with Remote Control, with a screenshot and a log waiting in its composer.
    const attachedHref = await page.$eval('.srow:has-text("Free shipping banner")', (a) => a.getAttribute('href'));

    // Needs you, answered in place. First, because opening a session settles its finished turn;
    // a fresh Stop makes the turn news again for each theme.
    const shipping = await page.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find((s) => s.title === 'Free shipping banner'));
    await page.evaluate(async (body) => { await fetch('/test/hook', { method: 'POST', body: JSON.stringify(body) }); }, { sessionId: shipping?.id, event: 'Stop', input: {} });
    await page.goto(`${base}#/needs`);
    await page.waitForSelector('.need-permission .ask-text', { timeout: 8000 }).catch(() => failures.push(`${theme}/needs: no permission row shows what it asks`));
    // Why a row offers no Reply comes from the live sessions, read after the needs: wait for it, not race it.
    await page.waitForSelector('.need-waiting .need-why', { timeout: 5000 }).catch(() => {});
    const asked = await page.evaluate(() => ({
      blocks: [...document.querySelectorAll('.need-permission .ask-text')].map((p) => p.textContent),
      warnings: [...document.querySelectorAll('.need-permission .ask-warning')].map((w) => w.textContent.trim()),
      marks: [...document.querySelectorAll('.need-permission .hidden-char')].map((m) => m.textContent),
      why: document.querySelector('.need-waiting .need-why')?.textContent ?? '',
    }));
    if (!asked.blocks.includes('pnpm exec axe http://localhost:3000/checkout')) failures.push(`${theme}/needs: the exact command is not shown (${asked.blocks.join(' | ')})`);
    if (asked.warnings.join() !== 'This command contains hidden characters') failures.push(`${theme}/needs: hidden-character warnings were ${JSON.stringify(asked.warnings)}`);
    if (asked.marks.join() !== '\u{27E8}U+200B\u{27E9}') failures.push(`${theme}/needs: the zero-width space was not spelled out (${asked.marks.join()})`);
    if (!/not yet seen Codex report when a message starts its turn/.test(asked.why)) failures.push(`${theme}/needs: a Codex row does not say why it offers no Reply`);
    await page.$eval('.need-permission .need-row:has(.ask-warning)', (el) => el.scrollIntoView({ block: 'nearest' })).catch(() => {});
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-needs-hidden.png`) });
    await page.click('.need-waiting .need-reply-open');
    await page.waitForSelector('.need-reply textarea');
    if (!(await page.evaluate(() => document.activeElement?.matches('.need-reply textarea')))) failures.push(`${theme}/needs: Reply did not put the cursor in its box`);
    await page.keyboard.type('Show it in the cart drawer too');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('and test $75.00 exactly');
    if ((await page.$eval('.need-reply textarea', (el) => el.value)) !== 'Show it in the cart drawer too\nand test $75.00 exactly') failures.push(`${theme}/needs: Shift+Enter did not start a new line in the reply`);
    await page.$eval('.need-reply', (el) => el.scrollIntoView({ block: 'nearest' }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-needs-reply.png`) });
    await page.keyboard.press('Escape');
    if (await page.$('.need-reply')) failures.push(`${theme}/needs: Escape did not close the reply`);
    await page.waitForTimeout(50);
    if (!(await page.evaluate(() => document.activeElement?.classList.contains('need-reply-open')))) failures.push(`${theme}/needs: closing the reply did not give focus back to Reply`);
    // The answer to a permission prompt is given in the terminal, which has the keys when it opens.
    await page.click('.need-permission .need-row:has(.ask-warning) a:has-text("Answer in terminal")');
    await page.waitForSelector('.xterm-rows');
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), null, { timeout: 5000 })
      .catch(() => failures.push(`${theme}/needs: Answer in terminal did not give the terminal the keys`));

    const routes = [
      ['needs', '#/needs', '.needs-headline'],
      ['running', '#/running', '.srow'],
      ['board', `#/p/${ns}/board`, '.card'],
      ['board-drawer-review', `#/p/${ns}/board?card=${ns}-7`, '.drawer .ai-result'],
      ['board-drawer-working', `#/p/${ns}/board?card=${ns}-6`, '.drawer .stages'],
      ['list', `#/p/${ns}/list`, '.table tbody tr'],
      ['sessions', `#/p/${ns}/sessions`, '.srow'],
      ['history', `#/p/${ns}/history`, '.hrow'],
      ['changes', `#/p/${ns}/changes`, '.dl-add'],
      ['changes-branch', `#/p/${ns}/changes?branch=${ns}-3`, '.dl-add'],
      ['git-commits', `#/p/${ns}/changes/commits`, '.commit-row .graph'],
      ['git-branches', `#/p/${ns}/changes/branches`, '.branch-row'],
      ['git-stashes', `#/p/${ns}/changes/stashes`, '.stash-diffs .dl-add'],
      ['git-card-pr', `#/p/${ns}/changes?branch=${ns}-3`, '.pr-chip .pr-number'],
      ['git-card-turns', `#/p/${ns}/changes?branch=${ns}-12`, '.who-line'],
      ['board-drawer-branch', `#/p/${ns}/board?card=${ns}-3`, '.drawer .branch-line'],
      ['decisions', `#/p/${ns}/decisions`, '.decision'],
      ['activity', `#/p/${ns}/activity`, '.activity-item'],
      ['accounts', '#/accounts', '.account'],
      ['settings', '#/settings', '#set-general'],
      ['skills', '#/skills', '.prose h3'],
      ['mcp', '#/mcp', '.mcp-row'],
      ['paused-project', '#/p/FIE/board', '.banner-paused'],
      ['session', sessionHref, '.xterm-rows'],
      ['session-limited', limitedHref, '.banner-limit button'],
      ['session-attached', attachedHref, '.composer .attach-chip img'],
    ];
    for (const [name, hash, ready] of routes) {
      await page.goto(`${base}${hash.startsWith('#') ? hash : `#${hash.replace(/^.*#/, '')}`}`);
      try {
        await page.waitForSelector(ready, { timeout: 8000 });
      } catch {
        failures.push(`${theme}/${name}: never showed ${ready}`);
      }
      await page.waitForTimeout(name === 'session' ? 900 : 350);
      const problems = await page.evaluate(() => {
        const text = document.body.innerText;
        const bad = text.match(/\b(undefined|NaN|\[object Object\]|Invalid Date)\b/g) ?? [];
        const loading = /Loading…|Opening the session…|Checking…/.test(text);
        const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        const crashed = [...document.querySelectorAll('.view-crash h2')].map((h) => h.textContent);
        // Clipped inside a column, where the page itself does not scroll: the commit box against its side.
        const side = document.querySelector('.changes-side')?.getBoundingClientRect();
        const clipped = side ? [...document.querySelectorAll('.commit-box input, .commit-box textarea, .commit-go')].some((el) => el.getBoundingClientRect().right > side.right + 1) : false;
        return { bad, loading, overflow, clipped, crashed, title: document.title, bg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme };
      });
      if (problems.clipped) failures.push(`${theme}/${name}: the commit box is wider than its column`);
      const titles = {
        needs: /^Needs you — Wanigan$/, running: /^Running — Wanigan$/, board: /^Northstar Storefront · Board — Wanigan$/,
        'board-drawer-review': new RegExp(`^Northstar Storefront · Board · ${ns}-7 — Wanigan$`), list: /^Northstar Storefront · List — Wanigan$/,
        settings: /^Settings — Wanigan$/, session: / · .+ — Wanigan$/,
      };
      if (titles[name] && !titles[name].test(problems.title)) failures.push(`${theme}/${name}: window title is "${problems.title}"`);
      if (problems.crashed.length) failures.push(`${theme}/${name}: crashed (${problems.crashed.join('; ')})`);
      if (problems.bad.length) failures.push(`${theme}/${name}: shows ${problems.bad.join(', ')}`);
      if (problems.loading) failures.push(`${theme}/${name}: still loading`);
      if (problems.overflow) failures.push(`${theme}/${name}: horizontal overflow`);
      if (problems.theme !== theme) failures.push(`${theme}/${name}: rendered with theme ${problems.theme}`);
      await page.screenshot({ path: join(out, `${theme}-${name}.png`) });
    }

    // The git workbench, read-only here (the live section at the end changes it, once).
    // Every expectation is the core's own answer, asked through the same bridge.
    {
      const nsId = await page.evaluate(async (key) => (await window.wanigan.call('projects.list', {})).find((p) => p.key === key).id, ns);
      const git = (method, params = {}) => page.evaluate(([m, p]) => window.wanigan.call(m, p), [method, { id: nsId, ...params }]);
      const status = await git('git.status');
      const want = [...status.conflicted, ...status.staged, ...status.changed, ...status.untracked].map((f) => f.path.split('/').pop());

      // Changes: the lists are the status, in order; who changed each file; the agents at work named.
      await page.goto(`${base}#/p/${ns}/changes`);
      await page.waitForSelector('.dl-add .syn-keyword');
      const order = await page.$$eval('.changes-files .fname', (n) => n.map((x) => x.textContent));
      if (order.join() !== want.join()) failures.push(`${theme}/git: the lists show ${order.join(', ')}, git says ${want.join(', ')}`);
      const groups = await page.$$eval('.git-group-head', (hs) => hs.map((h) => `${h.querySelector('span')?.textContent}:${h.querySelector('.git-group-count')?.textContent}`));
      const wantGroups = [['Conflicted', status.conflicted], ['Staged', status.staged], ['Changed', status.changed], ['Untracked', status.untracked]].filter(([, l]) => l.length).map(([t, l]) => `${t}:${l.length}`);
      if (groups.join() !== wantGroups.join()) failures.push(`${theme}/git: groups ${groups.join()} (git: ${wantGroups.join()})`);
      const marked = await page.$$eval('.git-file', (rows) => rows.filter((r) => r.querySelector('.who')).map((r) => r.querySelector('.fname')?.textContent));
      const wantMarked = [...status.staged, ...status.changed, ...status.untracked].filter((f) => f.who.length).map((f) => f.path.split('/').pop());
      if (marked.sort().join() !== [...new Set(wantMarked)].sort().join() || !wantMarked.includes('PayButton.tsx')) failures.push(`${theme}/git: who-changed marks on ${marked.join(', ')}, git says ${wantMarked.join(', ')}`);
      const banner = await page.textContent('.git-agents').catch(() => '');
      for (const a of status.agents) if (!banner.includes(a.title)) failures.push(`${theme}/git: the agents banner does not name ${a.title}`);
      const onBar = await page.textContent('.gitbar-name').catch(() => null);
      if (onBar !== status.branch) failures.push(`${theme}/git: the bar says ${onBar}, git says ${status.branch}`);
      const pushCount = await page.$eval('.remote-actions button:last-of-type', (b) => b.textContent).catch(() => '');
      if (!pushCount.includes(String(status.ahead))) failures.push(`${theme}/git: Push says "${pushCount}" with ${status.ahead} to push`);
      const discards = await page.$$eval('.diff-head button', (bs) => bs.filter((b) => /Discard|Delete/.test(b.textContent)).map((b) => b.disabled));
      if (status.agents.length && discards.some((d) => !d)) failures.push(`${theme}/git: a Discard is offered while an agent works in the folder`);

      // Syntax colour, side by side, J/K between files, viewed marks that fold a file away.
      const php = order.indexOf('CheckoutController.php');
      const yml = order.indexOf('northstar_checkout.routing.yml');
      if (php < 0 || yml < 0) failures.push(`${theme}/changes: the demo's changed files are ${order.join(', ')}`);
      const slot = (i) => `:nth-match(.diff-slot, ${i + 1})`;
      await page.click('.changes .toolbar [role="radio"]:has-text("Split")');
      await page.waitForSelector('.diff-split', { timeout: 3000 }).catch(() => failures.push(`${theme}/changes: Split did not show side by side`));
      await page.click('.changes-files .git-file-main');
      for (let i = 0; i < php; i++) await page.keyboard.press('j');
      const at = await page.$eval('.changes-files [aria-current="true"] .fname', (n) => n.textContent).catch(() => null);
      if (at !== 'CheckoutController.php') failures.push(`${theme}/changes: J ${php} times reached ${at}`);
      await page.waitForSelector(`${slot(php)} .diff-split .syn-variable`, { timeout: 4000 })
        .catch(() => failures.push(`${theme}/changes: the PHP diff shows no variables in colour`));
      const split = await page.$eval(slot(php), (s) => {
        const sides = [...s.querySelectorAll('tr.dl')].map((tr) => {
          const cells = [...tr.children];
          const half = cells.findIndex((c) => c.classList.contains('dl-half'));
          return { left: cells.slice(0, half), right: cells.slice(half) };
        });
        return {
          removedLeft: sides.filter((r) => r.left.some((c) => c.matches('.dl-text.dl-del'))).length,
          addedRight: sides.filter((r) => r.right.some((c) => c.matches('.dl-text.dl-add'))).length,
          comment: [...s.querySelectorAll('.syn-comment')].some((c) => c.textContent.includes('TRUE when the pay button should show')),
          hunks: s.querySelectorAll('.dl-hunk .hunk-btn').length,
        };
      });
      if (!split.removedLeft || !split.addedRight) failures.push(`${theme}/changes: split rows are not old-left, new-right (${JSON.stringify(split)})`);
      if (!split.comment) failures.push(`${theme}/changes: a hunk that starts inside a doc comment is not coloured as one`);
      if (split.hunks < 4) failures.push(`${theme}/git: the PHP file's two hunks do not each offer Stage and Discard (${split.hunks} buttons)`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-changes-split.png`) });

      // A note on a removed line, in split view, goes to the old side; J typed in it stays in it.
      await page.click(`${slot(php)} td.dl-del .dl-note-add`);
      await page.keyboard.type('jkvs');
      if ((await page.$eval('.dl-note-box textarea', (t) => t.value).catch(() => '')) !== 'jkvs') failures.push(`${theme}/changes: J, K, V or S were taken from a note being typed`);
      if (await page.$('.diff-is-viewed')) failures.push(`${theme}/changes: V while typing a note marked a file viewed`);
      await page.click('.dl-note-box button:has-text("Add note")');
      const note = await page.$eval('.notes-tray', (t) => t.textContent).catch(() => '');
      if (!/1 review note/.test(note)) failures.push(`${theme}/changes: the note on a removed line was not kept (${note})`);
      if (!(await page.$(`${slot(php)} .dl-note td:nth-child(2) .dl-note-box`))) failures.push(`${theme}/changes: a note on a removed line is not on the old side`);
      await page.click('.notes-tray button:has-text("Clear")');

      // Picked lines: a Shift-click picks the range between, and the header offers to stage just those.
      const boxes = await page.$$(`${slot(php)} td.dl-pick .dl-pick-box`);
      if (boxes.length < 3) failures.push(`${theme}/git: the PHP diff has ${boxes.length} line boxes`);
      else {
        await boxes[0].click();
        await boxes[2].click({ modifiers: ['Shift'] });
        const picked = await page.$eval(`${slot(php)} .pick-count`, (c) => c.textContent).catch(() => '');
        if (picked !== '3 lines picked') failures.push(`${theme}/git: a Shift-click range picked "${picked}"`);
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(out, `${theme}-git-pick-lines.png`) });
        await page.click(`${slot(php)} .pick-bar button:has-text("Clear")`);
      }

      // V marks the current file viewed; the box folds the first two; progress says so.
      await page.focus(`${slot(php)} .diff-head`);
      await page.keyboard.press('v');
      await page.waitForSelector(`${slot(php)} .diff-is-viewed`, { timeout: 3000 }).catch(() => failures.push(`${theme}/changes: V did not mark the file viewed`));
      for (const n of [0, 1]) {
        await page.click(`${slot(n)} .diff-viewed input`);
        await page.waitForSelector(`${slot(n)} .diff-is-viewed`, { timeout: 3000 }).catch(() => failures.push(`${theme}/changes: the Viewed box did not fold file ${n + 1}`));
      }
      const progress = await page.textContent('.changes-progress');
      if (progress?.trim() !== `3 of ${order.length} viewed`) failures.push(`${theme}/changes: progress says "${progress}"`);
      await page.click('.changes .toolbar [role="radio"]:has-text("Unified")');
      await page.click('.git-file[data-key$="routing.yml"] .git-file-main');
      await page.waitForSelector('.diff-slot[data-path$="routing.yml"] .syn-attr', { timeout: 4000 }).catch(() => failures.push(`${theme}/changes: the YAML keys are not coloured`));
      await page.click('.git-file[data-key$=".html.twig"] .git-file-main');
      await page.waitForSelector('.diff-slot[data-path$=".html.twig"] .syn-tag', { timeout: 4000 }).catch(() => failures.push(`${theme}/changes: the Twig template's tags are not coloured`));
      if (!(await page.$$eval('.diff-slot[data-path$=".html.twig"] .syn-comment', (c) => c.some((x) => x.textContent.includes('Available variables'))))) {
        failures.push(`${theme}/changes: a Twig hunk that opens inside {# … #} is not coloured as a comment`);
      }
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-changes-viewed.png`) });

      // A mark is for the diff it was given to: when the diff differs, the file unfolds.
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('wanigan.viewed.') && k.endsWith('.folder'));
        const marks = JSON.parse(localStorage.getItem(key));
        marks[Object.keys(marks).find((p) => p.endsWith('/PayButton.tsx'))] = 'a-diff-since-changed';
        localStorage.setItem(key, JSON.stringify(marks));
      });
      await page.reload();
      await page.waitForSelector('.changes-progress');
      await page.waitForFunction(() => document.querySelectorAll('.diff-is-viewed').length === 2, null, { timeout: 4000 })
        .catch(() => failures.push(`${theme}/changes: a mark on a diff that has since changed still folds the file`));
      if ((await page.textContent('.changes-progress'))?.trim() !== `2 of ${order.length} viewed`) failures.push(`${theme}/changes: progress counts a stale mark`);
      await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('wanigan.viewed.')) localStorage.removeItem(k); });

      // The commit box: the scan stops a commit holding the agent's key, and shows it redacted. Nothing is committed here.
      await page.fill('.commit-subject input', 'Give the pay button an accessible name');
      if ((await page.textContent('.commit-count'))?.trim() !== '38 characters') failures.push(`${theme}/git: the summary's length reads "${await page.textContent('.commit-count')}"`);
      await page.click('.commit-go');
      await page.waitForSelector('.dialog:has-text("Commit while an agent is working here?")', { timeout: 5000 }).catch(() => failures.push(`${theme}/git: committing beside a live agent did not ask first`));
      await page.click('.dialog button:has-text("Commit anyway")').catch(() => {});
      await page.waitForSelector('.secret-findings', { timeout: 8000 }).catch(() => failures.push(`${theme}/git: the staged key did not stop the commit`));
      const finding = {
        text: await page.textContent('.secret-findings').catch(() => ''),
        go: !!(await page.$('.commit-findings button:has-text("Commit anyway"):not(:disabled)')),
      };
      if (!/1 possible secret in the staged changes/.test(finding.text) || !/stripe\.ts:4/.test(finding.text) || !/sk_live_\[redacted\]/.test(finding.text)) failures.push(`${theme}/git: the finding reads "${finding.text}"`);
      if (/sk_live_51N[A-Za-z0-9]{6}/.test(finding.text)) failures.push(`${theme}/git: the finding shows the key itself`);
      if (finding.go) failures.push(`${theme}/git: Commit anyway works before the finding is acknowledged`);
      await page.$eval('.secret-findings', (el) => el.scrollIntoView({ block: 'end' }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-git-commit-secret.png`) });
      await page.click('.commit-findings button:has-text("Cancel")');
      await page.fill('.commit-subject input', '');
      if ((await git('git.log', { limit: 1 })).commits[0]?.hash !== status.head) failures.push(`${theme}/git: something was committed in a read-only check`);

      // Push: exactly the commits git would send, to where it says, after a scan.
      const plan = await git('git.pushPlan');
      await page.click('.remote-actions button:has-text("Push")');
      await page.waitForSelector('.dialog .push-commits li', { timeout: 8000 }).catch(() => failures.push(`${theme}/git: the push confirm listed no commits`));
      await page.waitForSelector('.dialog .push-clean, .dialog .secret-findings', { timeout: 8000 }).catch(() => failures.push(`${theme}/git: the push confirm did not say what the scan found`));
      const shown = await page.$$eval('.dialog .push-commits li .push-sha', (s) => s.map((x) => x.textContent));
      if (shown.join() !== plan.commits.map((c) => c.short).join()) failures.push(`${theme}/git: the push confirm lists ${shown.join()}, git would push ${plan.commits.map((c) => c.short).join()}`);
      if (!(await page.textContent('.dialog .dialog-head')).includes(`${plan.total} commits to ${plan.remote}/${plan.remoteBranch}`)) failures.push(`${theme}/git: the push confirm's title does not say ${plan.total} commits to ${plan.remote}/${plan.remoteBranch}`);
      if (await page.evaluate(() => document.querySelector('.dialog').scrollWidth > document.querySelector('.dialog').clientWidth + 1)) failures.push(`${theme}/git: the push confirm overflows`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-git-push.png`) });
      await page.keyboard.press('Escape');

      // Commits: the graph is the log; a filter finds by author; a merged card's commits carry its key.
      const all = await git('git.log', { all: true });
      await page.goto(`${base}#/p/${ns}/changes/commits`);
      await page.waitForSelector('.commit-row .graph');
      await page.click('.commits-toolbar [role="radio"]:has-text("All branches")');
      await page.waitForFunction((n) => document.querySelectorAll('.commit-row').length === n, all.commits.length, { timeout: 5000 })
        .catch(() => failures.push(`${theme}/git: All branches does not show the ${all.commits.length} commits git logs`));
      const merge = all.commits.find((c) => /^Merge wanigan\/ns-8/.test(c.subject));
      const badges = await page.$$eval('.commit-row', (rows) => rows.map((r) => r.querySelector('.card-key-badge')?.textContent ?? ''));
      const wantBadges = all.commits.map((c) => c.cardKey ?? '');
      if (badges.join() !== wantBadges.join() || !merge || merge.cardKey !== `${ns}-8`) failures.push(`${theme}/git: card keys on commits ${badges.join()} (git: ${wantBadges.join()})`);
      if (merge) await page.click(`.commit-row:has-text("${merge.subject}")`);
      await page.waitForSelector('.commit-view .dl-add', { timeout: 8000 }).catch(() => failures.push(`${theme}/git: a commit's diff never showed`));
      const view = await page.textContent('.commit-view-head');
      if (!merge || !view.includes(merge.short.slice(0, 7)) || !/Merge of/.test(view)) failures.push(`${theme}/git: the merge's detail reads "${view?.slice(0, 120)}"`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-git-commits-all.png`) });
      await page.keyboard.press('j');
      await page.waitForFunction((h) => document.querySelector('.commit-row.on .commit-hash')?.textContent !== h, merge?.short, { timeout: 3000 })
        .catch(() => failures.push(`${theme}/git: J did not move to the next commit`));
      await page.fill('.commits-filter input', 'sam okafor');
      const bySam = (await git('git.log', { all: true, query: 'sam okafor' })).commits.map((c) => c.subject);
      await page.waitForFunction((n) => document.querySelectorAll('.commit-row').length === n && !document.querySelector('.commit-row .graph'), bySam.length, { timeout: 5000 })
        .catch(() => failures.push(`${theme}/git: filtering by author did not show git's ${bySam.length} commits as a plain list`));
      await page.click('.commits-toolbar [role="radio"]:has-text("This branch")');
      await page.fill('.commits-filter input', '');

      // Branches: git's own list, the release branch a pull behind, merging previewed, switching off while agents work.
      const branches = await git('git.branches');
      await page.goto(`${base}#/p/${ns}/changes/branches`);
      await page.waitForSelector('.branch-row');
      const names = await page.$$eval('.branch-list .branch-name', (n) => n.map((x) => x.textContent));
      const wantNames = [...branches.local, ...branches.remote].map((b) => b.name);
      if (names.join() !== wantNames.join()) failures.push(`${theme}/git: branches ${names.join()} (git: ${wantNames.join()})`);
      const release = branches.local.find((b) => b.name === 'release/2026.10');
      const releaseRow = await page.$eval('.branch-row:has(.branch-name:text-is("release/2026.10")) .aheadbehind', (e) => e.textContent).catch(() => '');
      if (!release || releaseRow !== `↓${release.behind}`) failures.push(`${theme}/git: release/2026.10 reads "${releaseRow}" (git: ${release?.ahead} ahead, ${release?.behind} behind)`);
      if (status.agents.length && !(await page.$('.branch-row:not(.current) button:has-text("Switch"):disabled'))) failures.push(`${theme}/git: Switch is offered while an agent works in the folder`);
      await page.click('.branches-toolbar button:has-text("New branch")');
      await page.fill('#branch-new-name', 'feature/sticky..summary');
      if (!/cannot contain/.test(await page.textContent('#branch-new-why'))) failures.push(`${theme}/git: a bad branch name is not explained`);
      await page.fill('#branch-new-name', 'feature/sticky-summary');
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(out, `${theme}-git-new-branch.png`) });
      await page.click('.branches-toolbar button:has-text("New branch")');

      // Stashes: git's list, its files, and Save waiting while agents work.
      const stashes = await git('git.stashes');
      await page.goto(`${base}#/p/${ns}/changes/stashes`);
      await page.waitForSelector('.stash-diffs .diff');
      const stashText = await page.$$eval('.stash-row .stash-message', (n) => n.map((x) => x.textContent));
      if (stashText.join() !== stashes.map((s) => s.message).join()) failures.push(`${theme}/git: stashes ${stashText.join()} (git: ${stashes.map((s) => s.message).join()})`);
      const stashFiles = await git('git.stashShow', { index: stashes[0].index, sha: stashes[0].sha });
      if ((await page.$$('.stash-diffs .diff')).length !== stashFiles.files.length) failures.push(`${theme}/git: the stash shows a different number of files than git`);
      if (status.agents.length && !(await page.$('.stash-save button[type="submit"]:disabled'))) failures.push(`${theme}/git: Stash is offered while an agent works in the folder`);

      // A card's worktree: its commits since it forked, its pull request through gh.
      await page.goto(`${base}#/p/${ns}/changes?branch=${ns}-3`);
      await page.waitForSelector('.pr-chip .pr-number', { timeout: 8000 });
      const pr = await page.textContent('.pr-chip');
      if (!/#414/.test(pr) || !/Open/.test(pr) || !/Review required/.test(pr)) failures.push(`${theme}/git: NS-3's pull request reads "${pr}"`);
      const committed = await page.$$eval('.git-group-branch .fname', (n) => n.map((x) => x.textContent));
      if (committed.join() !== 'OrderHistory.tsx,Reorder.ts') failures.push(`${theme}/git: NS-3's committed files are ${committed.join()}`);
      // NS-12's: which turn changed which file, from its checkpoints.
      await page.goto(`${base}#/p/${ns}/changes?branch=${ns}-12`);
      await page.waitForSelector('.who-line');
      const turns = await page.$$eval('.diff-note .who-line', (n) => n.map((x) => x.textContent));
      if (!turns.some((t) => /in turn 2/.test(t)) || !turns.some((t) => /turns? (?:1|3)/.test(t))) failures.push(`${theme}/git: NS-12's files do not say which turns changed them (${turns.join(' | ')})`);

      // NS-13's worktree, stopped mid-merge: the banner, the files and every conflict are git's own.
      // Choices made here are the page's until Mark resolved, so nothing below changes the demo.
      const ns13 = await page.evaluate(async ([pid, key]) => (await window.wanigan.call('cards.list', { projectId: pid })).find((c) => c.key === key)?.id, [nsId, `${ns}-13`]);
      const mid = await git('git.status', { cardId: ns13 });
      await page.goto(`${base}#/p/${ns}/changes?branch=${ns}-13`);
      await page.waitForSelector('.resolver-hunk', { timeout: 8000 }).catch(() => failures.push(`${theme}/resolve: NS-13's conflicts never showed`));
      const opText = (await page.textContent('.git-operation').catch(() => '')) ?? '';
      if (mid.operation !== 'merge' || !opText.replace(' (checked out)', '').includes(`Merging ${mid.operationOf} into ${mid.branch} · ${mid.conflicted.length} files left`)) {
        failures.push(`${theme}/resolve: the banner reads "${opText}" (git: ${mid.operation} of ${mid.operationOf} into ${mid.branch}, ${mid.conflicted.length} conflicted)`);
      }
      if (!opText.includes(`Ask ${ns}-13’s agent`) || !opText.includes('Abort the merge')) failures.push(`${theme}/resolve: the banner offers "${opText}"`);
      const conflictedRows = await page.$$eval('.git-group-conflicted .git-file', (rows) => rows.map((r) => `${r.querySelector('.fname')?.textContent}:${r.querySelector('.fconflicts')?.textContent}`));
      const wantRows = mid.conflicted.map((f) => `${f.path.split('/').pop()}:${f.hunks ? `${f.hunks} conflict${f.hunks === 1 ? '' : 's'}` : f.conflict}`);
      if (conflictedRows.join() !== wantRows.join()) failures.push(`${theme}/resolve: the list shows ${conflictedRows.join(', ')}, git says ${wantRows.join(', ')}`);
      const go = (await page.textContent('.commit-go-label').catch(() => '')) ?? '';
      if (go !== `Resolve ${mid.conflicted.length} files to complete the merge`) failures.push(`${theme}/resolve: the commit button says "${go}"`);
      const prepared = await page.inputValue('.commit-subject input').catch(() => '');
      if (prepared !== mid.operationMessage?.split('\n')[0]) failures.push(`${theme}/resolve: the commit box holds "${prepared}", git prepared "${mid.operationMessage?.split('\n')[0]}"`);
      // copy.ts: one side by side per conflict in git's diff3 text, each side's lines exactly.
      const copyPath = mid.conflicted.find((f) => f.path.endsWith('copy.ts'))?.path;
      const copy = copyPath ? await git('git.conflict', { cardId: ns13, path: copyPath }) : null;
      const sides = [];
      for (const m of (copy?.merged ?? '').matchAll(/^<{7}.*\n([\s\S]*?)^\|{7}.*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}.*$/gm)) {
        const lines = (t) => t.replace(/\n$/, '').split('\n').filter((l, i, a) => !(a.length === 1 && l === ''));
        sides.push({ ours: lines(m[1]), base: lines(m[2]), theirs: lines(m[3]) });
      }
      const resolver = `.resolver[aria-label="Resolve ${copyPath}"]`;
      const hunks = await page.$$(`${resolver} .resolver-hunk`);
      if (!copy || copy.code !== 'UU' || sides.length < 2 || hunks.length !== sides.length) failures.push(`${theme}/resolve: copy.ts shows ${hunks.length} conflicts, git's text holds ${sides.length} (${copy?.code})`);
      const nth = (i) => page.locator(`${resolver} .resolver-hunk`).nth(i);
      // A blank line is drawn as one no-break space, so its row keeps its height.
      const sideText = async (hunk, sel) => (await hunk.locator(sel).allTextContents()).map((t) => t.replace(/^ $/, '')).join('\n');
      for (const side of ['ours', 'theirs']) {
        const seen = await sideText(nth(0), `.side-${side} .dl-text`);
        if (seen !== sides[0]?.[side].join('\n')) failures.push(`${theme}/resolve: conflict 1's ${side} shows ${JSON.stringify(seen)}, git's text has ${JSON.stringify(sides[0]?.[side])}`);
      }
      if (!(await nth(1).locator('.side-ours .syn-string').count())) failures.push(`${theme}/resolve: the sides are not in colour`);
      // Both, ours first: our lines then theirs. Ours on the second. The count follows.
      await nth(0).locator('[role="radio"]:text-is("Both, ours first")').click();
      if (await sideText(nth(0), '.resolver-result .dl-text') !== [...(sides[0]?.ours ?? []), ...(sides[0]?.theirs ?? [])].join('\n')) failures.push(`${theme}/resolve: Both, ours first did not give ours then theirs`);
      await nth(1).locator('[role="radio"]:text-is("Ours")').click();
      if (await sideText(nth(1), '.resolver-result .dl-text') !== sides[1]?.ours.join('\n')) failures.push(`${theme}/resolve: Ours did not give our lines`);
      const count = (await page.textContent(`${resolver} .resolver-count`).catch(() => '')) ?? '';
      if (count !== `${sides.length - 2} of ${sides.length} conflicts left`) failures.push(`${theme}/resolve: with two chosen the count says "${count}"`);
      // What both came from, as a third column.
      await page.check(`${resolver} .resolver-toggle:has-text("Show what both sides came from") input`);
      await nth(1).locator('.resolver-sides.three .side-base').waitFor({ timeout: 3000 }).catch(() => failures.push(`${theme}/resolve: the base column did not show`));
      if (await sideText(nth(1), '.side-base .dl-text') !== sides[1]?.base.join('\n')) failures.push(`${theme}/resolve: the base column is not git's`);
      await nth(0).evaluate((el) => el.closest('.diff-slot')?.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${theme}-git-resolve.png`) });
      // Marking it resolved with a conflict still open asks first, and Cancel changes nothing.
      await page.click(`${resolver} .resolver-head button:has-text("Mark resolved")`);
      await page.waitForSelector('.dialog:has-text("Keep the markers of 1 conflict")', { timeout: 3000 }).catch(() => failures.push(`${theme}/resolve: marking with a conflict open did not ask about its markers`));
      // A text-only dialog still owns the keyboard; its body has no field to focus.
      if (!(await page.evaluate(() => !!document.activeElement?.closest('.dialog')))) failures.push(`${theme}/resolve: the confirmation did not take keyboard focus`);
      for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        if (!(await page.evaluate(() => !!document.activeElement?.closest('.dialog')))) failures.push(`${theme}/resolve: ${key} escaped the confirmation`);
      }
      await page.click('.dialog-foot button:has-text("Cancel")');
      const markButton = page.locator(`${resolver} .resolver-head button:has-text("Mark resolved")`);
      await markButton.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('.dialog');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog', { state: 'detached' });
      if (!(await markButton.evaluate((el) => el === document.activeElement))) failures.push(`${theme}/resolve: Escape did not return focus to Mark resolved`);
      if ((await git('git.status', { cardId: ns13 })).conflicted.length !== mid.conflicted.length) failures.push(`${theme}/resolve: cancelling still resolved something`);
      // The file both sides added: both whole versions offered by name.
      const totalsPath = mid.conflicted.find((f) => f.path.endsWith('totals.ts'))?.path;
      const both = `.resolver[aria-label="Resolve ${totalsPath}"]`;
      await page.$eval(both, (el) => el.scrollIntoView({ block: 'start' })).catch(() => failures.push(`${theme}/resolve: totals.ts has no resolver`));
      await page.waitForSelector(`${both} .resolver-hunk`, { timeout: 5000 }).catch(() => failures.push(`${theme}/resolve: totals.ts showed no conflict`));
      const state = (await page.textContent(`${both} .resolver-state`).catch(() => '')) ?? '';
      if (!/added/i.test(state) || !(await page.$(`${both} button:has-text("Take ours (${mid.branch})")`))) failures.push(`${theme}/resolve: totals.ts reads "${state}" without Take ours (${mid.branch})`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-git-resolve-added.png`) });

      // A card's merge, from its drawer. With agents at work in the project folder it is not
      // offered, and says why.
      await page.goto(`${base}#/p/${ns}/board?card=${ns}-3`);
      await page.waitForSelector('.drawer .branch-line');
      const mergeIt = page.locator('.drawer button:has-text("Merge into main")');
      if (status.agents.length) {
        // The branch comes from cards.get; its refusal waits on a separate sessions.list.
        // Read the final disabled state and explanation together, not across two renders.
        await page.waitForFunction(() => [...document.querySelectorAll('.drawer button')].some((button) =>
          button.textContent.includes('Merge into main') && button.disabled && /working in the project folder, and merging would change the files under/.test(button.title)), null, { timeout: 8000 }).catch(() => {});
        const held = await mergeIt.evaluate((button) => ({ disabled: button.disabled, title: button.title }));
        if (!held.disabled || !/working in the project folder, and merging would change the files under/.test(held.title)) {
          failures.push(`${theme}/card-merge: with agents in the folder, Merge into main is ${held.disabled ? 'disabled' : 'offered'} and says "${held.title}"`);
        }
      }
      // A merge that conflicts, as the drawer takes the core's answer: the files named, then resolve,
      // ask, or leave it. Played: a folder nobody works in, and the core's answer to the merge.
      const folder = await page.evaluate(async (id) => (await window.wanigan.call('projects.list', {})).find((p) => p.id === id).path, nsId);
      await page.evaluate((path) => {
        const real = window.wanigan.call.bind(window.wanigan);
        window.__wgMerges = [];
        window.__wgUnplay = () => { window.wanigan.call = real; };
        window.wanigan.call = (m, p) => {
          if (m === 'sessions.list') return real(m, p).then((list) => list.filter((s) => s.cwd !== path));
          if (m !== 'cards.merge') return real(m, p);
          window.__wgMerges.push(p);
          return p.resolve ? Promise.resolve({ commit: null, conflicts: ['src/orders/OrderHistory.tsx'] })
            : Promise.reject(Object.assign(new Error('Git stopped the merge: both sides changed the same lines. It was undone, and nothing changed. Resolve it in the project folder, or bring main into the card’s branch (or ask its agent to), then merge again. It conflicted in src/orders/OrderHistory.tsx.'), { code: 'conflict' }));
        };
      }, folder);
      await page.goto(`${base}#/p/${ns}/board`);
      // A hash navigation can finish before React unmounts the old drawer. The
      // fixture's replacement sessions.list applies only after a fresh query.
      await page.waitForSelector('.drawer', { state: 'detached', timeout: 5000 });
      await page.goto(`${base}#/p/${ns}/board?card=${ns}-3`);
      await page.waitForSelector('.drawer .branch-line');
      try {
        await page.click('.drawer button:has-text("Merge into main"):not([disabled])', { timeout: 5000 });
        await page.locator('.drawer .branch-actions button').filter({ hasText: /^\s*Merge\s*$/ }).click({ timeout: 5000 });
        await page.waitForSelector('.drawer .merge-conflict', { timeout: 5000 });
      } catch (error) {
        const state = await page.evaluate(() => ({
          hash: location.hash,
          buttons: [...document.querySelectorAll('.drawer .branch-actions button')].map((button) => ({ text: button.textContent, disabled: button.disabled, title: button.title })),
          merges: window.__wgMerges,
        }));
        console.error(`${theme}/card-merge prerequisites failed: ${JSON.stringify({ failures, state })}`);
        throw error;
      }
      const offer = (await page.textContent('.drawer .merge-conflict').catch(() => '')) ?? '';
      for (const want of ['conflicts in src/orders/OrderHistory.tsx', 'Resolve the conflicts', 'Ask the agent', 'Leave the branch alone']) {
        if (!offer.includes(want)) failures.push(`${theme}/card-merge: the conflict box lacks "${want}" ("${offer}")`);
      }
      await page.$eval('.drawer .merge-conflict', (el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-git-card-merge-conflict.png`) });
      await page.click('.drawer .merge-conflict button:has-text("Resolve the conflicts")');
      await page.waitForFunction((k) => location.hash === `#/p/${k}/changes`, ns, { timeout: 5000 }).catch(() => failures.push(`${theme}/card-merge: resolving did not open Changes`));
      const merges = await page.evaluate(() => window.__wgMerges);
      if (merges.length !== 2 || merges[0].resolve !== false || merges[1].resolve !== true) failures.push(`${theme}/card-merge: the drawer asked ${JSON.stringify(merges)}`);
      await page.evaluate(() => window.__wgUnplay());

      await page.goto(`${base}#/p/${ns}/changes`);
      await page.waitForSelector('.dl-add');
      // Left on Split, so the narrow window below shows it falling back to unified.
      await page.click('.changes .toolbar [role="radio"]:has-text("Split")');
    }
    // The Remote Control session: its mark, and files pasted or dropped on its terminal join the composer.
    await page.goto(`${base}${attachedHref.replace(/^.*#/, '#')}`);
    await page.waitForSelector('.composer .attach-chip img');
    if (!(await page.$('.session-facts .remote-mark'))) failures.push(`${theme}: the Remote Control session does not say so`);
    if (!/Claude Code gets each image as its own attachment/.test(await page.textContent('.composer'))) failures.push(`${theme}: the composer does not say what Claude receives`);
    const chips = await page.$$eval('.composer .attach-chip', (c) => c.length);
    await page.evaluate(async () => {
      const png = await (await fetch(document.querySelector('.composer .attach-thumb').src)).blob();
      const files = (name) => { const dt = new DataTransfer(); dt.items.add(new File([png], name, { type: 'image/png' })); return dt; };
      document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: files('pasted.png'), bubbles: true, cancelable: true }));
      document.querySelector('.terminal').dispatchEvent(new DragEvent('drop', { dataTransfer: files('dropped.png'), bubbles: true, cancelable: true }));
    });
    await page.waitForFunction((n) => document.querySelectorAll('.composer .attach-chip img').length === n + 2, chips - 1, { timeout: 8000 })
      .catch(() => failures.push(`${theme}: an image pasted and one dropped on the terminal did not both join the composer`));
    for (const name of ['pasted.png', 'dropped.png']) await page.click(`.composer .attach-chip:has-text("${name}") .attach-x`).catch(() => failures.push(`${theme}: ${name} has no remove button`));
    await page.waitForFunction((n) => document.querySelectorAll('.composer .attach-chip').length === n, chips, { timeout: 8000 })
      .catch(() => failures.push(`${theme}: removing attached files did not take them out of the composer`));
    // Running › Watch: the four that most need you, real output, no PTY resized.
    await page.goto(`${base}#/running`);
    await page.waitForSelector('.srow');
    await spyOnCalls(page);
    const sizesBefore = await ptySizes(page);
    const runningCount = await page.$$eval('.srow', (rows) => rows.length);
    await page.click('.topbar [role="radio"]:has-text("Watch")');
    await tilesShowing(page, 4).catch(() => failures.push(`${theme}/running-watch: four tiles never showed their output`));
    await page.waitForTimeout(400);
    for (const f of await tileFits(page)) {
      if (!f.inside) failures.push(`${theme}/running-watch: "${f.title}" is drawn bigger than its tile`);
      if (!f.fills) failures.push(`${theme}/running-watch: "${f.title}" is shrunk past what its tile needs`);
      if (f.px < 6) failures.push(`${theme}/running-watch: "${f.title}" text is ${f.px}px, too small to read`);
    }
    const asking = await page.$$eval('.watch-tile.asking', (tiles) => tiles.map((t) => t.getAttribute('aria-label')));
    // Amber where the owner has to act: asking permission, a question on its card, its usage limit.
    const mustAsk = ['Checkout button has no accessible name', 'Free shipping banner', 'Rate limiter drops bursts at the minute boundary'];
    if (mustAsk.some((t) => !asking.some((a) => a?.includes(t)))) failures.push(`${theme}/running-watch: expected the permission, question and limit tiles amber, got ${JSON.stringify(asking)}`);
    const more = runningCount - 4;
    const moreText = (await page.textContent('.watch-more').catch(() => '')) ?? '';
    if (more > 0 && !new RegExp(`^${more} more sessions? running, not shown`).test(moreText)) failures.push(`${theme}/running-watch: says "${moreText}" with ${runningCount} running`);
    await page.screenshot({ path: join(out, `${theme}-running-watch.png`) });

    // Read-only until clicked; then keys go to that session; Escape takes them back.
    await page.keyboard.type('q');
    const first = page.locator('.watch-tile').first();
    const firstId = (await first.locator('a[aria-label^="Open"]').getAttribute('href')).split('/s/')[1];
    await first.locator('.watch-screen').click();
    await page.waitForSelector('.watch-tile.typing', { timeout: 2000 }).catch(() => failures.push(`${theme}/running-watch: clicking a tile did not hand it the keys`));
    await page.keyboard.type('x');
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${theme}-running-watch-typing.png`) });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    if (await page.$('.watch-tile.typing')) failures.push(`${theme}/running-watch: Escape did not take the keys back`);
    if (!(await page.evaluate(() => document.activeElement?.classList.contains('watch-screen')))) failures.push(`${theme}/running-watch: after Escape, focus is not on the tile`);
    await page.keyboard.type('y');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.watch-tile.typing', { timeout: 2000 }).catch(() => failures.push(`${theme}/running-watch: Enter on a tile did not hand it the keys`));
    await page.keyboard.press('Escape');
    const typed = await spied(page, 'sessions.input');
    if (typed.length !== 1 || typed[0].id !== firstId || typed[0].data !== 'x') failures.push(`${theme}/running-watch: keys reached sessions as ${JSON.stringify(typed)}, expected only "x" to ${firstId}`);

    // A hidden window draws nothing and watches nothing; coming back draws again.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => !document.querySelector('.watch-tile .xterm'), null, { timeout: 4000 })
      .catch(() => failures.push(`${theme}/running-watch: tiles kept drawing in a hidden window`));
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tilesShowing(page, 4).catch(() => failures.push(`${theme}/running-watch: tiles did not draw again when the window came back`));

    if (theme === 'dark') {
      // Pinned from the list, two sit side by side; unpinned from the tiles, Watch chooses again.
      await page.click('.topbar [role="radio"]:has-text("List")');
      await page.waitForSelector('.running-row');
      for (const n of [0, 1]) await page.locator('.running-row').nth(n).locator('button[aria-pressed]').click();
      await page.click('.topbar [role="radio"]:has-text("Watch")');
      await tilesShowing(page, 2).catch(() => failures.push(`${theme}/running-watch: two pinned sessions did not show as two tiles`));
      if (!(await page.$('.watch.watch-n2'))) failures.push(`${theme}/running-watch: two tiles are not side by side`);
      const pinnedMore = (await page.textContent('.watch-more').catch(() => '')) ?? '';
      if (!new RegExp(`^${runningCount - 2} more sessions? running, not shown\\.$`).test(pinnedMore)) failures.push(`${theme}/running-watch: pinned Watch says "${pinnedMore}" with ${runningCount} running`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${theme}-running-watch-pinned.png`) });
      for (let i = 0; i < 2; i++) await page.locator('.watch-tile button[aria-pressed="true"]').first().click();
      await tilesShowing(page, 4).catch(() => failures.push(`${theme}/running-watch: unpinning both did not go back to the four that need you most`));
    }

    if (!sameSizes(sizesBefore, await ptySizes(page))) failures.push(`${theme}/running-watch: a PTY changed size while it was watched`);
    if ((await spied(page, 'sessions.resize')).length) failures.push(`${theme}/running-watch: a tile asked to resize a PTY`);
    // Leaving Watch lets go of every terminal it watched.
    const watched = new Set((await spied(page, 'sessions.watch')).map((p) => p.id));
    await page.click('.topbar [role="radio"]:has-text("List")');
    await page.waitForSelector('.srow');
    await page.waitForTimeout(200);
    const released = new Set((await spied(page, 'sessions.unwatch')).map((p) => p.id));
    if (!watched.size || [...watched].some((id) => !released.has(id))) failures.push(`${theme}/running-watch: leaving Watch did not stop watching every tile`);
    await stopSpying(page);

    // A session's turns: what each changed in its worktree, the diff of one, and undo for the last.
    const stockId = await page.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find((s) => s.title === 'Low-stock badge on product cards')?.id);
    if (!stockId) failures.push(`${theme}/turns: no session with turns in the demo`);
    else {
      await page.goto(`${base}#/p/${ns}/s/${stockId}`);
      await page.waitForSelector('.turn-change .turn-diff', { timeout: 8000 }).catch(() => failures.push(`${theme}/turns: no turn shows what it changed`));
      const turnLines = await page.$$eval('.turn-change', (els) => els.map((e) => e.textContent));
      if (turnLines.length !== 3 || !/^2 files\+15−1/.test(turnLines[0] ?? '')) failures.push(`${theme}/turns: turn lines read ${JSON.stringify(turnLines)}`);
      if (!(await page.$('.turn-change button:has-text("Undo this turn")'))) failures.push(`${theme}/turns: the last turn offers no undo`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(out, `${theme}-session-turns.png`) });
      await page.click('.turn-change .turn-diff');
      await page.waitForSelector('.turn-panel .dl-add', { timeout: 8000 }).catch(() => failures.push(`${theme}/turns: the turn's diff never showed`));
      await page.click('.turn-panel .changes-files button:has(.fname:text-is("LowStockBadge.tsx"))');
      await page.waitForSelector('.turn-panel .dl-del', { timeout: 8000 }).catch(() => failures.push(`${theme}/turns: the edited file's diff never showed`));
      await page.waitForTimeout(300);
      if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) failures.push(`${theme}/turns: horizontal overflow`);
      await page.screenshot({ path: join(out, `${theme}-session-turn-diff.png`) });
      await page.click('.turn-panel-head button:has-text("Undo this turn")');
      await page.waitForSelector('.dialog .undo-files li', { timeout: 8000 }).catch(() => failures.push(`${theme}/turns: the undo confirmation lists no files`));
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${theme}-session-undo.png`) });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      if (await page.$('.dialog, .turn-panel')) failures.push(`${theme}/turns: Escape did not close the confirmation, then the diff`);
    }

    // An approved card's pull request: the confirm step says what is pushed where.
    await page.goto(`${base}#/p/${ns}/board?card=${ns}-10`);
    await page.waitForSelector('.drawer .branch-line');
    await page.click('.drawer button:has-text("Open a pull request")');
    await page.waitForSelector('.drawer .pr-confirm', { timeout: 8000 }).catch(() => failures.push(`${theme}: the pull request plan never showed`));
    if (await page.$('.drawer .pr-confirm .error-text')) failures.push(`${theme}: the pull request plan refused: ${await page.textContent('.drawer .pr-confirm .error-text')}`);
    await page.$eval('.drawer .pr-confirm', (el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-pull-request.png`) });

    // Play with Wanigan: the Play button opens his toys; a key plays one; Escape closes them.
    await page.goto(`${base}#/needs`);
    await page.waitForSelector('.needs-orb .play-button');
    await page.click('.needs-orb .play-button');
    await page.waitForSelector('.play-panel .play-toy', { timeout: 3000 }).catch(() => failures.push(`${theme}: the Play button did not open Wanigan's toys`));
    await page.keyboard.press('s');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-play.png`) });
    await page.keyboard.press('Escape');
    if (await page.$('.play-panel')) failures.push(`${theme}: Escape did not close Wanigan's toys`);

    // Since you looked: one line of counts that opens to the cards behind them, and goes when dismissed.
    // Away from the board, forget the last look, so the init script's "an hour ago" applies again.
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('wanigan.lastSeen.')) localStorage.removeItem(k); });
    await page.goto(`${base}#/p/${ns}/board`);
    await page.waitForSelector('.card');
    await page.waitForSelector('.since-toggle', { timeout: 5000 }).catch(() => failures.push(`${theme}/since: no line of what changed`));
    if (await page.$('.since-toggle')) {
      const line = await page.$eval('.since-line', (el) => ({ text: el.textContent, height: el.getBoundingClientRect().height }));
      if (line.height > 40) failures.push(`${theme}/since: the line is not one line (${line.height}px)`);
      await page.click('.since-toggle');
      await page.waitForSelector('.since-detail li', { timeout: 3000 }).catch(() => failures.push(`${theme}/since: clicking did not open the detail`));
      if ((await page.getAttribute('.since-toggle', 'aria-expanded')) !== 'true') failures.push(`${theme}/since: the line does not say it is open`);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(out, `${theme}-since.png`) });
      await page.click('.since button[aria-label="Dismiss until something new happens"]');
      if (await page.$('.since')) failures.push(`${theme}/since: dismissing left it on the board`);
    }

    // Mouse drop markers use the order without the dragged card. Cancel each
    // gesture: the real seeded board's status/ranks must remain unchanged.
    try {
      const projectId = await page.evaluate(async (key) => (await window.wanigan.call('projects.list', {})).find((p) => p.key === key)?.id, ns);
      if (!projectId) throw new Error('the seeded Board project is missing');
      const state = () => page.evaluate(async (id) => (await window.wanigan.call('cards.list', { projectId: id }))
        .map((c) => ({ id: c.id, status: c.status, rank: c.rank })).sort((a, b) => a.id.localeCompare(b.id)), projectId);
      const unchanged = JSON.stringify(await state());
      const keys = await page.locator('.column-ready .card').evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
      if (keys.length < 3) throw new Error(`expected at least three seeded Ready cards, found ${keys.length}`);
      const [a, b, c] = keys;
      for (const [name, moving, following] of [['forward', a, c], ['reverse', c, b], ['no-op', a, b], ['end', a, null]]) {
        try {
          const fromTile = page.locator(`.column-ready .card[data-key="${moving}"]`);
          const toTile = page.locator(`.column-ready .card[data-key="${following ?? keys.at(-1)}"]`);
          // Settle the source before dragging, then bring the actual destination
          // into view: the last Ready card may be below the scrollable viewport.
          await fromTile.hover({ timeout: 3000 });
          const from = await fromTile.boundingBox();
          if (!from) throw new Error(`${name}: the source card has no visible box`);
          const x = from.x + from.width / 2, y = from.y + from.height / 2;
          await page.mouse.move(x, y); await page.mouse.down();
          await page.mouse.move(x + 12, y + 6, { steps: 6 });
          await page.locator(`.column-ready .card.dragging[data-key="${moving}"]`).waitFor({ timeout: 3000 });
          await toTile.scrollIntoViewIfNeeded({ timeout: 3000 });
          const to = await toTile.boundingBox();
          if (!to) throw new Error(`${name}: the destination card has no visible box`);
          const targetY = to.y + to.height * (following ? 0.25 : 0.8);
          await page.mouse.move(to.x + to.width / 2, targetY, { steps: 16 });
          await page.mouse.move(to.x + to.width / 2 + 1, targetY);
          await page.locator(`.column-ready .card.dragging[data-key="${moving}"]`).waitFor({ timeout: 3000 });
          const markers = page.locator('.column-ready .drop-line');
          await markers.first().waitFor({ timeout: 3000 });
          if (await markers.count() !== 1) throw new Error(`${name}: expected exactly one drop marker`);
          const marker = await markers.evaluate((node) => ({
            following: node.parentElement.querySelector('.card')?.dataset.key ?? null,
            atEnd: node.parentElement === node.closest('.column-cards').lastElementChild,
          }));
          if (marker.following !== following || (following === null && !marker.atEnd)) {
            throw new Error(`${name}: marker ${JSON.stringify(marker)} did not precede ${following ?? 'the end'}`);
          }
        } catch (error) { failures.push(`${theme}/board-marker/${name}: ${error.message}`); }
        finally {
          await page.keyboard.press('Escape'); await page.mouse.up();
          await page.waitForFunction(() => !document.querySelector('.board .card.dragging, .board .drop-line'), null, { timeout: 3000 });
          if (JSON.stringify(await state()) !== unchanged) throw new Error(`${name}: a canceled drag changed stored card status/ranks`);
        }
      }
    } catch (error) { failures.push(`${theme}/board-marker: ${error.message}`); }

    // Interactions: board keys, palette, new card dialog.
    await page.focus('.column-ready .card');
    const before = await page.evaluate(() => document.activeElement?.getAttribute('data-key'));
    await page.keyboard.press('j');
    await page.keyboard.press('l');
    const after = await page.evaluate(() => document.activeElement?.getAttribute('data-key'));
    if (!before || !after || before === after) failures.push(`${theme}: board keys did not move focus (${before} → ${after})`);
    if (theme === 'dark') {
      // A card that changes column glides there (once: this accepts it for good).
      const moving = await page.$eval('.column-inbox .card', (c) => c.dataset.key);
      await page.focus('.column-inbox .card');
      await page.keyboard.press('a');
      const glided = await page.waitForFunction((k) => {
        const c = document.querySelector(`.column-ready .card[data-key="${k}"]`);
        return !!c && c.getAnimations().length > 0;
      }, moving, { timeout: 4000, polling: 16 }).then(() => true, () => false);
      if (!glided) failures.push(`dark: ${moving}, accepted from the Inbox, did not glide into Ready`);
    }
    await page.keyboard.press('Escape');
    await page.click('.how-btn');
    await page.waitForSelector('.how-flow .how-box');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-how.png`) });
    await page.click('.how-box[aria-label^="Review"]');
    await page.waitForSelector('.column-review.flash', { timeout: 3000 }).catch(() => failures.push(`${theme}: the explainer's Review box did not show its column`));
    if (await page.$('.how-flow')) failures.push(`${theme}: the explainer did not close on a box click`);
    // ⌘K: results in groups, key caps read from the shortcut table, the G-chords listed, and what agents said.
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('.palette .palette-group-head');
    await page.waitForTimeout(250);
    const untyped = await page.evaluate(() => ({
      groups: [...document.querySelectorAll('.palette-group-head')].map((h) => h.textContent),
      caps: [...document.querySelectorAll('.palette-option')].filter((o) => o.querySelector('.keycaps kbd'))
        .map((o) => `${o.querySelector('.palette-label')?.textContent}=${o.querySelector('.keycaps')?.textContent}`),
    }));
    for (const g of ['Go to', 'Projects', 'Cards', 'Commands']) if (!untyped.groups.includes(g)) failures.push(`${theme}/palette: no ${g} group (${untyped.groups.join(', ')})`);
    for (const want of ['Needs you=GthenN', 'Board=GthenB', 'New session=⌘T', 'Collapse or expand the sidebar=⌘\\']) {
      if (!untyped.caps.includes(want)) failures.push(`${theme}/palette: no key caps ${want} (${untyped.caps.join(' | ')})`);
    }
    await page.screenshot({ path: join(out, `${theme}-palette-empty.png`) });
    await page.keyboard.type('order');
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, `${theme}-palette.png`) });
    // The demo's stand-in Claude says this, in colour, in every session it runs.
    await page.fill('.palette-input input', 'PAY BUTTON');
    await page.waitForSelector('.palette-said mark', { timeout: 5000 }).catch(() => failures.push(`${theme}/palette: nothing an agent said was found`));
    await page.waitForTimeout(200);
    const said = await page.evaluate(() => {
      const box = document.querySelector('.palette-input input');
      return {
        groups: [...document.querySelectorAll('.palette-group-head')].map((h) => h.textContent),
        marks: [...document.querySelectorAll('.palette-said mark')].map((m) => m.textContent),
        text: [...document.querySelectorAll('.palette-said')].map((o) => o.textContent).join('\n'),
        role: box?.getAttribute('role'),
        active: box?.getAttribute('aria-activedescendant'),
        options: document.querySelectorAll('[role="listbox"] [role="group"] [role="option"]').length,
      };
    });
    if (!said.groups.includes('Said in sessions')) failures.push(`${theme}/palette: no "Said in sessions" group (${said.groups.join(', ')})`);
    if (!said.marks.length || !said.marks.every((m) => m.toLowerCase() === 'pay button')) failures.push(`${theme}/palette: marked ${JSON.stringify(said.marks)}`);
    if (/\x1b|\[\d+(;\d+)*m/.test(said.text)) failures.push(`${theme}/palette: escape codes reached a snippet`);
    if (said.role !== 'combobox' || !said.active || !said.options) failures.push(`${theme}/palette: not a combobox with an active option (${said.role}, ${said.active}, ${said.options})`);
    await page.screenshot({ path: join(out, `${theme}-palette-said.png`) });
    // Up from the first result wraps to the last group: what an agent said. Enter opens that session.
    await page.keyboard.press('ArrowUp');
    const chosen = await page.evaluate(() => document.getElementById(document.querySelector('.palette-input input')?.getAttribute('aria-activedescendant') ?? '')?.classList.contains('palette-said'));
    if (!chosen) failures.push(`${theme}/palette: the arrow keys did not reach the last group`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.xterm-rows', { timeout: 8000 }).catch(() => failures.push(`${theme}/palette: choosing what was said did not open its session`));
    if (!/\/s\//.test(page.url())) failures.push(`${theme}/palette: choosing what was said went to ${page.url()}`);
    await page.goto(`${base}#/p/${ns}/board`);
    await page.waitForSelector('.card');
    await page.keyboard.press('c');
    await page.waitForSelector('.dialog');
    await page.keyboard.type('coupon thing lets old codes through??');
    await page.click('.draft-row button');
    await page.waitForSelector('.draft-criteria li', { timeout: 8000 }).catch(() => failures.push(`${theme}: Draft with Claude never filled the card`));
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, `${theme}-new-card.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+t');
    await page.waitForSelector('.dialog .select');
    await page.waitForSelector('.dialog .model-row .segmented', { timeout: 4000 }).catch(() => failures.push(`${theme}: New session offers no model or effort`));
    await page.focus('.dialog .select');
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector('.sel-list [role="option"]', { timeout: 3000 }).catch(() => failures.push(`${theme}: a dropdown did not open from the keyboard`));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${theme}-select.png`) });
    await page.keyboard.press('Escape');
    if (await page.$('.sel-list')) failures.push(`${theme}: Escape did not close a dropdown`);
    if (!(await page.$('.dialog'))) failures.push(`${theme}: Escape in a dropdown closed its dialog too`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-new-session.png`) });
    // Each account says what its plan has left, in the picker and under it.
    const chosenLimits = await page.textContent('.dialog .account-limits').catch(() => '');
    if (!/\d+% left/.test(chosenLimits ?? '') || !/resets/.test(chosenLimits ?? '')) failures.push(`${theme}/limits: the chosen account does not say what it has left (${(chosenLimits ?? '').slice(0, 120)})`);
    await page.click('.dialog .field:has-text("Account") .select');
    const optionLimits = await page.$$eval('.sel-list [role="option"]', (os) => os.map((o) => ({ out: /signed out/.test(o.textContent ?? ''), limits: o.querySelector('.limits-left')?.textContent ?? '' })));
    if (optionLimits.length < 2 || !optionLimits.every((o) => (o.out ? !o.limits : /% left|used up|not read yet|Could not read/.test(o.limits)))) failures.push(`${theme}/limits: an account in the picker does not say what it has left, or a signed-out one does (${JSON.stringify(optionLimits)})`);
    if ((await page.$$eval('.sel-list [role="option"] .sel-detail', (ds) => ds.map((d) => d.textContent ?? ''))).some((t) => /% used/.test(t))) failures.push(`${theme}/limits: an account says what it used twice`);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${theme}-new-session-accounts.png`) });
    await page.keyboard.press('Escape');
    // A model on this Mac: offered under its own heading, explained when chosen.
    await page.click('.dialog .model-row .select');
    await page.waitForSelector('.sel-group:has-text("On this Mac")', { timeout: 3000 }).catch(() => failures.push(`${theme}/local: the model picker has no "On this Mac" group`));
    await page.click('.sel-list [role="option"]:has-text("Qwen3-Coder 30B")').catch(() => failures.push(`${theme}/local: Qwen3-Coder 30B is not offered`));
    await page.waitForSelector('.dialog .field-hint:has-text("Runs on this Mac through LM Studio")', { timeout: 3000 })
      .catch(() => failures.push(`${theme}/local: choosing a local model does not say where it runs`));
    if (await page.$('.dialog .model-row .segmented')) failures.push(`${theme}/local: a local model is offered an effort it does not take`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, `${theme}-new-session-local.png`) });
    // Gemini CLI is an agent too, with its own models.
    await page.click('.dialog [role="radio"]:has-text("Gemini CLI")').catch(() => failures.push(`${theme}/gemini: New session does not offer Gemini CLI`));
    await page.waitForSelector('.dialog .field-hint:has-text("Gemini CLI’s aliases")', { timeout: 3000 })
      .catch(() => failures.push(`${theme}/gemini: Gemini CLI’s models are not offered`));
    if (await page.$('.dialog .check-row:has-text("Remote Control")')) failures.push(`${theme}/gemini: Remote Control is offered for Gemini`);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${theme}-new-session-gemini.png`) });
    await page.click('.dialog [role="radio"]:has-text("Claude Code")');
    await page.keyboard.press('Escape');
    await page.click('.rail-add');
    await page.waitForSelector('.suggestions li');
    await page.waitForSelector('.agent-folders li', { timeout: 8000 }).catch(() => failures.push(`${theme}: no folders the agents worked in`));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-open-project.png`) });
    // Where the agents have worked: ranked, honest about git, and nothing already open, gone or too old.
    const folders = await page.$$eval('.agent-folders li', (rows) => rows.map((r) => r.textContent ?? ''));
    if (!/^ledger-servicegit/.test(folders[0] ?? '') || !/12 conversations, last /.test(folders[0] ?? '')) failures.push(`${theme}: the busiest folder is not first (${folders[0]})`);
    if (folders.some((f) => /old-prototype|spike-since-deleted|northstar-storefront/.test(f))) failures.push(`${theme}: an old, gone or open folder was offered`);
    if (!folders.some((f) => /design-tokens.*not a git repository/.test(f))) failures.push(`${theme}: a folder outside git does not say so`);
    if (folders.length !== 6) failures.push(`${theme}: ${folders.length} folders shown before Show all`);
    await page.click('.agent-folders button:has-text("Show all 7")').catch(() => failures.push(`${theme}: no Show all for the seventh folder`));
    await page.$eval('.agent-folders', (el) => el.scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-open-project-agents.png`) });
    await page.keyboard.press('Escape');
    await page.click(`button[aria-label$="settings"]`);
    await page.waitForSelector('.dialog .dialog-section');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-project-settings.png`) });
    await page.keyboard.press('Escape');
    await page.click('.topbar-tools button:has-text("Pause")');
    await page.waitForSelector('.dialog .plain-list');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-pause.png`) });
    await page.keyboard.press('Escape');

    // ⌘\ folds the rail to icons and back. The fold is remembered, every item keeps its name, and
    // pointing at one names it beside the rail.
    await page.goto(`${base}#/p/${ns}/board`);
    await page.waitForSelector('.card');
    await page.keyboard.press('Meta+Backslash');
    await page.waitForSelector('.rail.collapsed', { timeout: 3000 }).catch(() => failures.push(`${theme}/rail: ⌘\\ did not fold the rail`));
    await page.reload();
    await page.waitForSelector('.card');
    await page.waitForTimeout(400);
    const folded = await page.evaluate(() => {
      const rail = document.querySelector('.rail');
      return {
        collapsed: !!rail?.classList.contains('collapsed'),
        width: Math.round(rail?.getBoundingClientRect().width ?? 0),
        main: Math.round(document.querySelector('.main')?.getBoundingClientRect().left ?? 0),
        unnamed: [...(rail?.querySelectorAll('a, button') ?? [])].filter((el) => !(el.getAttribute('aria-label') || el.textContent?.trim())).map((el) => el.outerHTML.slice(0, 60)),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      };
    });
    if (!folded.collapsed) failures.push(`${theme}/rail: the fold was not remembered across a reload`);
    if (folded.width > 60 || folded.main !== folded.width) failures.push(`${theme}/rail: folded to ${folded.width}px with the view at ${folded.main}px`);
    if (folded.unnamed.length) failures.push(`${theme}/rail: folded items with no name: ${folded.unnamed.join(' ')}`);
    if (folded.overflow) failures.push(`${theme}/rail: horizontal overflow with the rail folded`);
    await page.hover(`.rail-projects a[href*="/p/${ns}/"]`);
    await page.waitForSelector('.rail-tip', { timeout: 2000 }).catch(() => failures.push(`${theme}/rail: pointing at a project did not name it`));
    if (!/Northstar/.test((await page.textContent('.rail-tip').catch(() => '')) ?? '')) failures.push(`${theme}/rail: the tip does not name the project`);
    await page.screenshot({ path: join(out, `${theme}-rail-collapsed.png`) });
    await page.mouse.move(700, 450);
    await page.keyboard.press('Meta+Backslash');
    await page.waitForSelector('.rail:not(.collapsed)', { timeout: 3000 }).catch(() => failures.push(`${theme}/rail: ⌘\\ did not open the rail again`));
    // Back to no choice made (forgotten, and the window reloaded), so a narrow window folds it on its own below.
    await page.evaluate(() => localStorage.removeItem('wanigan.rail'));
    await page.reload();
    await page.waitForSelector('.card');

    // History: ⌘⇧T from anywhere in a project, search, the reader, and continuing as another account.
    await page.goto(`${base}#/p/${ns}/board`);
    await page.waitForSelector('.card');
    await page.keyboard.press('Meta+Shift+t');
    await page.waitForSelector('.hrow', { timeout: 8000 }).catch(() => {});
    if (!page.url().endsWith(`#/p/${ns}/history`)) failures.push(`${theme}: ⌘⇧T did not open History (${page.url()})`);
    if (await page.$('.dialog')) failures.push(`${theme}: ⌘⇧T also opened a dialog`);
    await page.fill('.history-bar input', 'coupon');
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.hrow');
      return rows.length === 1 && rows[0]?.querySelector('.hrow-title')?.textContent === 'Expired coupon codes still apply';
    }, undefined, { timeout: 8000 }).catch(() => {});
    const found = await page.$$eval('.hrow', (rows) => rows.map((r) => r.querySelector('.hrow-title')?.textContent));
    if (found.length !== 1 || found[0] !== 'Expired coupon codes still apply') failures.push(`${theme}: History search for "coupon" showed ${JSON.stringify(found)}`);
    await page.fill('.history-bar input', '');
    await page.click('.hrow:first-of-type .hrow-actions button:has-text("Read")');
    await page.waitForSelector('.reader .turn', { timeout: 8000 }).catch(() => failures.push(`${theme}: the History reader never showed a turn`));
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(out, `${theme}-history-reader.png`) });
    await page.keyboard.press('Escape');
    if (await page.$('.reader')) failures.push(`${theme}: Escape did not close the History reader`);
    await page.click('.hrow:has-text("Expired coupon codes") button:has-text("Resume")');
    await page.waitForSelector('.dialog .choose-accounts', { timeout: 8000 }).catch(() => failures.push(`${theme}: Resume never offered to continue as another account`));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-history-resume.png`) });
    await page.keyboard.press('Escape');
    // Talk to Wanigan: the round button on the board opens the conversation,
    // the composer sends on Enter, and the stand-in answers with real card keys.
    await page.goto(`${base}#/p/${ns}/board`);
    await page.waitForSelector('.chat-fab');
    await page.click('.chat-fab');
    await page.waitForSelector('.chat textarea');
    if (await page.$('.chat .chat-turn')) await page.click('.chat button[aria-label="New conversation"]');
    await page.waitForSelector('.chat .chat-empty').catch(() => failures.push(`${theme}: the conversation did not start empty`));
    if (!(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.chat')))) {
      failures.push(`${theme}: opening the chat did not put the cursor in its composer`);
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${theme}-chat-empty.png`) });
    await page.keyboard.type('What needs me here?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.chat .chat-thinking', { timeout: 3000 }).catch(() => failures.push(`${theme}: no thinking state while Wanigan answered`));
    await page.screenshot({ path: join(out, `${theme}-chat-thinking.png`) });
    await page.waitForSelector('.chat .chat-a li', { timeout: 8000 }).catch(() => failures.push(`${theme}: the seeded answer never arrived`));
    await page.waitForTimeout(300);
    const chat = await page.evaluate(() => ({
      links: [...document.querySelectorAll('.chat .chat-a button.linkish')].map((b) => b.textContent),
      text: document.querySelector('.chat')?.textContent ?? '',
    }));
    if (!chat.links.includes(`${ns}-6`) || !chat.links.includes(`${ns}-7`)) failures.push(`${theme}: card keys in the answer are not links (${chat.links.join(', ')})`);
    if (!/Uses a turn of .+’s plan/.test(chat.text)) failures.push(`${theme}: the composer does not say whose plan it uses`);
    if (!/Claude Code reported \$0\.04/.test(chat.text)) failures.push(`${theme}: the answer does not show what it cost`);
    await page.screenshot({ path: join(out, `${theme}-chat.png`) });
    await page.keyboard.type('line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    if ((await page.$eval('.chat textarea', (el) => el.value)) !== 'line one\nline two') failures.push(`${theme}: Shift+Enter did not add a new line`);
    // An image pasted into the conversation waits as a chip, and says where it goes.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 150;
      const g = canvas.getContext('2d');
      g.fillStyle = '#f6f4ef'; g.fillRect(0, 0, 240, 150);
      g.fillStyle = '#2f7fb8'; g.fillRect(0, 20, 240, 26);
      g.fillStyle = '#cfc8bb'; g.fillRect(16, 62, 64, 70); g.fillRect(88, 62, 64, 70); g.fillRect(160, 62, 64, 70);
      const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([png], 'cart drawer.png', { type: 'image/png' }));
      document.querySelector('.chat textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('.chat-files .attach-chip img', { timeout: 8000 }).catch(() => failures.push(`${theme}: an image pasted into the chat did not wait as a chip`));
    if ((await page.$eval('.chat textarea', (el) => el.value)) !== 'line one\nline two') failures.push(`${theme}: pasting an image changed the text being written`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-chat-attach.png`) });
    await page.click('.chat-files .attach-x');
    await page.waitForSelector('.chat-files', { state: 'detached', timeout: 8000 }).catch(() => failures.push(`${theme}: removing the chat's image did not take it out`));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.chat', { state: 'detached', timeout: 3000 }).catch(() => failures.push(`${theme}: Esc did not close the chat`));
    if (!(await page.evaluate(() => document.activeElement?.classList.contains('chat-fab')))) failures.push(`${theme}: closing the chat did not return focus to its button`);
    await page.goto(`${base}${sessionHref.replace(/^.*#/, '#')}`);
    await page.waitForSelector('.xterm-rows');
    if (await page.$('.chat-fab')) failures.push(`${theme}: the chat button covers the session composer`);
    // Skills: pick one, plan a copy into a project (nothing is written), and search.
    await page.goto(`${base}#/skills`);
    await page.waitForSelector('.lib-row');
    await page.click('.lib-row:has-text("checkout-a11y")');
    await page.waitForSelector('.prose');
    await page.click('.lib-actions button:has-text("Copy to a project")');
    await page.waitForSelector('.dialog .plan-files li', { timeout: 8000 }).catch(() => failures.push(`${theme}: the skill copy plan never showed`));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-skills-copy.png`) });
    await page.keyboard.press('Escape');
    await page.fill('.topbar-tools .search-field input', 'debug');
    await page.waitForTimeout(200);
    if ((await page.$$('.lib-row')).length !== 2) failures.push(`${theme}: skills search did not narrow to the two debugging skills`);
    await page.screenshot({ path: join(out, `${theme}-skills-search.png`) });

    // MCP: no secret reaches the page; check connections (a stand-in CLI); the store; two add plans.
    await page.goto(`${base}#/mcp`);
    await page.waitForSelector('.mcp-row');
    const leaked = await page.evaluate(() => ['not-a-real-password-9f3a', 'acme_demo_not_a_real_key', 'fake_staging_token_8f2e1d0c9b'].filter((s) => document.body.innerText.includes(s)));
    if (leaked.length) failures.push(`${theme}: MCP page shows secrets: ${leaked.join(', ')}`);
    await page.click('.mcp-group:first-of-type .mcp-check button');
    await page.waitForSelector('.mcp-status.tone-ok', { timeout: 8000 }).catch(() => failures.push(`${theme}: Check connections never showed a status`));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-mcp-checked.png`) });
    await page.click('.topbar-tools [role="radio"]:has-text("Store")');
    await page.waitForSelector('.store-card');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-mcp-store.png`) });
    await page.click('.store-card:has-text("GitHub") button');
    await page.waitForSelector('.dialog .plan-command', { timeout: 8000 }).catch(() => failures.push(`${theme}: the GitHub add plan never showed`));
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-mcp-add-key.png`) });
    await page.keyboard.press('Escape');
    await page.click('.store-card:has-text("Notion") button');
    await page.waitForSelector('.dialog .plan-command', { timeout: 8000 }).catch(() => failures.push(`${theme}: the Notion add plan never showed`));
    await page.click('.dialog [role="radio"]:has-text("The repository")');
    await page.waitForSelector('.dialog .plan-command', { timeout: 8000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${theme}-mcp-add.png`) });
    await page.keyboard.press('Escape');

    // The window's minimum is 960 wide: the busiest screens must still fit at 1024.
    if (theme === 'dark') {
      await page.setViewportSize({ width: 1024, height: 700 });
      for (const [name, hash, ready] of [
        ['narrow-board', `#/p/${ns}/board?card=${ns}-7`, '.drawer .stages'],
        ['narrow-needs', '#/needs', '.needs-headline'],
        ['narrow-session', sessionHref.replace(/^.*#/, '#'), '.xterm-rows'],
        ['narrow-changes', `#/p/${ns}/changes`, '.dl-add'],
        ['narrow-git-commits', `#/p/${ns}/changes/commits`, '.commit-view .dl-add'],
        ['narrow-git-branches', `#/p/${ns}/changes/branches`, '.branch-row'],
        ['narrow-git-stashes', `#/p/${ns}/changes/stashes`, '.stash-diffs .dl-add'],
        ['narrow-git-card', `#/p/${ns}/changes?branch=${ns}-12`, '.who-line'],
        ['narrow-git-resolve', `#/p/${ns}/changes?branch=${ns}-13`, '.resolver-hunk .side-theirs .dl-text'],
        ['narrow-chat', '#/needs', '.needs-headline'],
        ['narrow-skills', '#/skills', '.prose h3'],
        ['narrow-mcp', '#/mcp', '.mcp-row'],
        // Last: the History reader below opens from this view.
        ['narrow-history', `#/p/${ns}/history`, '.hrow'],
      ]) {
        await page.goto(`${base}${hash}`);
        await page.waitForSelector(ready, { timeout: 8000 }).catch(() => failures.push(`narrow/${name}: never showed ${ready}`));
        if (name === 'narrow-chat') {
          await page.click('.chat-fab');
          await page.waitForSelector('.chat textarea');
        }
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        if (overflow) failures.push(`narrow/${name}: horizontal overflow`);
        const clipped = await page.evaluate(() => {
          const side = document.querySelector('.changes-side')?.getBoundingClientRect();
          return side ? [...document.querySelectorAll('.commit-box input, .commit-box textarea, .commit-go')].some((el) => el.getBoundingClientRect().right > side.right + 1) : false;
        });
        if (clipped) failures.push(`narrow/${name}: the commit box is wider than its column`);
        if (name === 'narrow-changes' && ((await page.$('.diff-split')) || !/Unified until the window is wider/.test(await page.textContent('.changes .toolbar')))) {
          failures.push('narrow/changes: Split did not fall back to unified, saying so');
        }
        if (!(await page.$('.rail.collapsed'))) failures.push(`narrow/${name}: the rail did not fold on its own below 1180px`);
        const hidden = await page.$$eval('.rail-projects a', (links) => links.filter((a) => {
          const r = a.getBoundingClientRect();
          return r.top < 0 || r.bottom > window.innerHeight;
        }).map((a) => a.textContent));
        if (hidden.length) failures.push(`narrow/${name}: projects out of sight in the folded rail: ${hidden.join(', ')}`);
        await page.screenshot({ path: join(out, `${name}.png`) });
        if (name === 'narrow-chat') await page.keyboard.press('Escape');
      }
      await page.click('.hrow:first-of-type .hrow-actions button:has-text("Read")');
      await page.waitForSelector('.reader .turn', { timeout: 8000 }).catch(() => failures.push('narrow: the History reader never showed a turn'));
      await page.waitForTimeout(350);
      if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) failures.push('narrow/history-reader: horizontal overflow');
      await page.screenshot({ path: join(out, 'narrow-history-reader.png') });
      await page.keyboard.press('Escape');

      // Watch on a narrow window: one column, tiles tall enough to read; the ones scrolled away are not drawn.
      await page.goto(`${base}#/running`);
      await page.waitForSelector('.srow');
      await spyOnCalls(page);
      const narrowBefore = await ptySizes(page);
      await page.click('.topbar [role="radio"]:has-text("Watch")');
      await page.waitForSelector('.watch-tile .xterm-rows', { timeout: 8000 }).catch(() => failures.push('narrow/running-watch: no tile showed'));
      const columns = await page.$eval('.watch', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      if (columns !== 1) failures.push(`narrow/running-watch: ${columns} columns on a narrow window`);
      await page.waitForTimeout(2200);
      const drawn = await page.$$eval('.watch-tile', (tiles) => tiles.filter((t) => t.querySelector('.xterm')).length);
      if (drawn >= 4) failures.push('narrow/running-watch: tiles scrolled out of sight are still drawn');
      if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) failures.push('narrow/running-watch: horizontal overflow');
      for (const f of await tileFits(page)) if (!f.inside || !f.fills) failures.push(`narrow/running-watch: "${f.title}" does not fit its tile`);
      await page.screenshot({ path: join(out, 'narrow-running-watch.png') });
      await page.$eval('.view-body', (el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(() => {
        const last = [...document.querySelectorAll('.watch-tile')].pop();
        return (last?.querySelector('.xterm-rows')?.textContent ?? '').trim().length > 0;
      }, null, { timeout: 4000 }).catch(() => failures.push('narrow/running-watch: the last tile did not draw when scrolled to'));
      if (!sameSizes(narrowBefore, await ptySizes(page)) || (await spied(page, 'sessions.resize')).length) failures.push('narrow/running-watch: a PTY was resized');
      await page.click('.topbar [role="radio"]:has-text("List")');
      await stopSpying(page);
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    // The core could not start, or is from another build: the shell says so, above any view.
    const trouble = await context.newPage();
    trouble.on('pageerror', (e) => errors.push(`core problem pageerror: ${e.message}`));
    trouble.on('console', (m) => { if (m.type() === 'error') errors.push(`core problem console: ${m.text()}`); });
    await trouble.goto(`${base}#/p/${ns}/board`);
    await trouble.waitForSelector('.card');
    await trouble.evaluate(() => window.__wgCoreProblem({
      kind: 'failed', reason: 'This database was not created by Wanigan 2. Refusing to open it.', log: '/Users/you/Library/Application Support/Wanigan 2/core.log', at: Date.now(),
    }));
    await trouble.waitForSelector('.core-problem:has-text("Wanigan’s core could not start")', { timeout: 3000 }).catch(() => failures.push(`${theme}/core: a core that could not start was not said`));
    if (!/Refusing to open it\..*core\.log/s.test(await trouble.textContent('.core-problem').catch(() => ''))) failures.push(`${theme}/core: the panel does not say why, or where the log is`);
    await trouble.waitForTimeout(250);
    await trouble.screenshot({ path: join(out, `${theme}-core-failed.png`) });
    await trouble.click('.core-problem button:has-text("Try again")');
    await trouble.evaluate(() => window.__wgCoreProblem({ kind: 'other-build', pid: 4242, live: 2 }));
    await trouble.waitForSelector('.core-problem:has-text("2 live sessions will be interrupted")', { timeout: 3000 }).catch(() => failures.push(`${theme}/core: a core from another build was not asked about`));
    await trouble.waitForTimeout(250);
    await trouble.screenshot({ path: join(out, `${theme}-core-other-build.png`) });
    await trouble.evaluate(() => window.__wgCoreProblem({ kind: 'other-build', pid: 4242, live: 0 }));
    const idleWarning = await trouble.textContent('.core-problem');
    if (!/No live sessions were reported/.test(idleWarning) || !/running reviews, answers, and Jev requests/.test(idleWarning) || !/unable to confirm it is idle/.test(idleWarning)) failures.push(`${theme}/core: a restart with no reported PTYs hides background work or unknown idle state`);
    await trouble.screenshot({ path: join(out, `${theme}-core-other-build-idle.png`) });
    await trouble.click('.core-problem button:has-text("Keep using it")');
    const answered = await trouble.evaluate(() => window.__wgCoreActions.join());
    if (answered !== 'retry,keep') failures.push(`${theme}/core: the panel answered ${answered}, wanted retry then keep`);
    await trouble.evaluate(() => window.__wgCoreProblem(null));
    await trouble.waitForTimeout(150);
    if (await trouble.$('.core-problem')) failures.push(`${theme}/core: the panel stayed after the problem was over`);
    await trouble.close();

    // An agent whose CLI is not installed: never "found", and how to install it, before Start too.
    const bare = await context.newPage();
    bare.on('pageerror', (e) => errors.push(`not installed pageerror: ${e.message}`));
    await bare.addInitScript(() => {
      const real = window.wanigan.call;
      window.wanigan.call = async (m, p) => {
        const r = await real(m, p);
        if (m === 'accounts.list') return r.map((a) => (a.provider === 'codex' ? { ...a, installed: false, signedIn: 'unknown', identity: null, plan: null, usage: null } : a));
        return m === 'needs.list' ? [] : r;
      };
    });
    await bare.goto(`${base}#/needs`);
    await bare.waitForSelector('.readiness li', { timeout: 8000 }).catch(() => failures.push(`${theme}/not installed: no readiness with nothing to do`));
    const readiness = await bare.$$eval('.readiness li', (rows) => rows.map((r) => ({ ok: r.classList.contains('ok'), text: r.textContent })));
    const codexRow = readiness.find((r) => r.text.startsWith('Codex'));
    if (!codexRow || codexRow.ok || !/^Codex · not installedInstall it with npm install -g @openai\/codex, or brew install --cask codex\.$/.test(codexRow.text)) {
      failures.push(`${theme}/not installed: Readiness says ${JSON.stringify(codexRow)}`);
    }
    await bare.screenshot({ path: join(out, `${theme}-needs-not-installed.png`) });
    await bare.goto(`${base}#/accounts`);
    await bare.waitForSelector('.account-status:has-text("Codex is not installed")', { timeout: 5000 }).catch(() => failures.push(`${theme}/not installed: Accounts does not say so`));
    if (await bare.$('section[aria-labelledby="acct-codex"] .account-list button:has-text("Sign in")')) failures.push(`${theme}/not installed: Accounts offers to sign in to a CLI that is not there`);
    await bare.screenshot({ path: join(out, `${theme}-accounts-not-installed.png`) });
    await bare.evaluate(() => window.__wgCommand('new-session'));
    await bare.click('.dialog [role="radio"]:has-text("Codex")');
    await bare.waitForSelector('.dialog .field-hint:has-text("Codex is not installed")', { timeout: 3000 }).catch(() => failures.push(`${theme}/not installed: the New session dialog does not say so before Start`));
    await bare.waitForTimeout(250);
    await bare.screenshot({ path: join(out, `${theme}-new-session-not-installed.png`) });
    await bare.close();

    // Start is the preferred focus target, but disabled while the project is paused.
    const paused = await context.newPage();
    await paused.goto(`${base}#/p/FIE/board`);
    await paused.waitForSelector('.banner-paused');
    await paused.locator('.rail-add').focus();
    await paused.evaluate(() => window.__wgCommand('new-session'));
    await paused.waitForSelector('.dialog');
    if (!(await paused.locator('.dialog [data-autofocus]').isDisabled())) failures.push(`${theme}/paused session: Start should be disabled`);
    if (!(await paused.evaluate(() => !!document.activeElement?.closest('.dialog')))) failures.push(`${theme}/paused session: a disabled preferred control left focus outside the dialog`);
    for (let i = 0; i < 6; i++) {
      await paused.keyboard.press('Tab');
      if (!(await paused.evaluate(() => !!document.activeElement?.closest('.dialog')))) failures.push(`${theme}/paused session: Tab escaped the dialog`);
    }
    await paused.screenshot({ animations: 'disabled', path: join(out, `${theme}-paused-new-session.png`) });
    await paused.keyboard.press('Escape');
    await paused.waitForSelector('.dialog', { state: 'detached' });
    if (!(await paused.locator('.rail-add').evaluate((el) => el === document.activeElement))) failures.push(`${theme}/paused session: Escape did not restore focus`);
    await paused.close();

    // The hint to set up Jev, where Jev is not set up: hidden by hand, it stays hidden for this viewer.
    const unset = await context.newPage();
    unset.on('pageerror', (e) => errors.push(`jev hint pageerror: ${e.message}`));
    await unset.addInitScript(() => {
      const real = window.wanigan.call;
      window.wanigan.call = async (m, p) => (m === 'jev.status' ? { ...(await real(m, p)), configured: null } : real(m, p));
    });
    await unset.goto(`${base}#/p/${ns}/board`);
    await unset.waitForSelector('.jev-strip a:has-text("Set up Jev")', { timeout: 8000 }).catch(() => failures.push(`${theme}/jev: no setup hint where Jev is not set up`));
    await unset.waitForTimeout(250);
    await unset.screenshot({ path: join(out, `${theme}-jev-hint.png`) });
    await unset.click('.jev-strip button[aria-label="Hide this hint"]').catch(() => failures.push(`${theme}/jev: the hint cannot be hidden`));
    if (await unset.$('.jev-strip')) failures.push(`${theme}/jev: hiding the hint left it on the board`);
    await unset.reload();
    await unset.waitForSelector('.card');
    await unset.waitForTimeout(400);
    if (await unset.$('.jev-strip')) failures.push(`${theme}/jev: the hidden hint came back`);
    await unset.close();

    // Local and Live: the live view's environment tabs and Compare. The browser has no view to lay over a page, so
    // the stub plays the main process (scripts/ui-live-stub.mjs) and answers Compare with two pictures of a made-up
    // page it draws itself. Everything it asks the core for is real: the environments, the ignored areas.
    {
      const cmp = await context.newPage();
      cmp.on('pageerror', (e) => errors.push(`compare pageerror: ${e.message}`));
      cmp.on('console', (m) => { if (m.type() === 'error') errors.push(`compare console: ${m.text()}`); });
      await cmp.addInitScript(liveStub);
      await cmp.goto(`${base}#/p/${ns}/board`);
      await cmp.waitForSelector('.card');
      const project = await cmp.evaluate(async (key) => (await window.wanigan.call('projects.list', {})).find((p) => p.key === key), ns);
      const rpc = (method, params) => cmp.evaluate(([m, p]) => window.wanigan.call(m, p), [method, params]);
      await rpc('live.setSite', { projectId: project.id, url: 'https://acme.ddev.site/', platform: 'drupal' });
      for (const [name, url] of [['Live', 'https://www.acme.example/'], ['Dev', 'https://dev-acme.pantheonsite.io/'], ['Test', 'https://test-acme.pantheonsite.io/']]) {
        await rpc('live.setEnv', { projectId: project.id, name, url });
      }
      // A file in the project naming one more, so the settings show what was found (taken away again below).
      const aliases = join(project.path, 'drush', 'sites', 'acme.site.yml');
      const hadDrush = existsSync(join(project.path, 'drush'));
      mkdirSync(join(project.path, 'drush', 'sites'), { recursive: true });
      writeFileSync(aliases, 'stage:\n  uri: https://stage.acme.example\n');
      try {
        await cmp.goto(`${base}#/p/${ns}/live`);
        await cmp.waitForSelector('.live-envs [role="radio"]:has-text("Live")', { timeout: 8000 }).catch(() => failures.push(`${theme}/live: no environment tabs`));
        const tabs = await cmp.$$eval('.live-envs [role="radio"]', (els) => els.map((e) => e.textContent));
        if (tabs.join() !== 'Local,Dev,Test,Live') failures.push(`${theme}/live: the tabs are ${tabs.join()}, wanted Local, Dev, Test, Live`);
        await cmp.waitForTimeout(250);
        await cmp.screenshot({ path: join(out, `${theme}-live-envs.png`) });

        await cmp.click('.live-envs [role="radio"]:has-text("Live")');
        await cmp.waitForSelector('.live-hosted', { timeout: 3000 }).catch(() => failures.push(`${theme}/live: a hosted tab does not say it is read-only`));
        const hostedShow = await cmp.evaluate(() => window.__wgLive.shows.at(-1));
        if (!hostedShow?.env || hostedShow.token !== null || !hostedShow.url.startsWith('https://www.acme.example/')) failures.push(`${theme}/live: the hosted tab was shown as ${JSON.stringify(hostedShow)}`);
        if (!/sends requests to that site, only when you do/.test(await cmp.textContent('.live-hosted'))) failures.push(`${theme}/live: the hosted tab does not say it sends requests to that site`);
        await cmp.waitForTimeout(200);
        await cmp.screenshot({ path: join(out, `${theme}-live-hosted.png`) });
        await cmp.click('.live-envs [role="radio"]:has-text("Local")');
        if ((await cmp.evaluate(() => window.__wgLive.shows.at(-1)))?.env !== null) failures.push(`${theme}/live: Local was not shown again as the local site`);

        // Compare: both sides taken at the view's width, the hosted one never with a token.
        await cmp.click('.live-bar button:has-text("Compare")');
        await cmp.waitForSelector('.cmp-frame canvas', { timeout: 10000 }).catch(() => failures.push(`${theme}/compare: the pictures never showed`));
        await cmp.waitForSelector('.cmp-summary', { timeout: 5000 }).catch(() => {});
        const asked = await cmp.evaluate(() => window.__wgLive.shots.slice(-2));
        const local = asked.find((r) => r.env === null);
        const hosted = asked.find((r) => r.env !== null);
        if (!local?.scan || local.width !== 1440 || !hosted || hosted.token !== null || hosted.scan || !hosted.url.startsWith('https://www.acme.example/')) {
          failures.push(`${theme}/compare: asked for ${JSON.stringify(asked)}`);
        }
        const summary = await cmp.textContent('.cmp-summary').catch(() => '');
        if (!/areas differ/.test(summary) || !/Live is 96 px taller/.test(summary) || !/96 px only on Live/.test(summary)) failures.push(`${theme}/compare: the summary says "${summary}"`);
        const changes = await cmp.$$eval('.cmp-change', (els) => els.map((e) => e.textContent));
        if (changes.length !== 3 || !/Hero/.test(changes[0]) || !/News list.*only on Live/.test(changes[1]) || !/Footer/.test(changes[2])) failures.push(`${theme}/compare: the changes are ${JSON.stringify(changes)}`);
        if (!/local database is older than Live’s/.test(await cmp.textContent('.dialog .cmp-note'))) failures.push(`${theme}/compare: no note that content differences are usually an older database`);
        if (!(await cmp.evaluate(() => document.activeElement?.classList.contains('cmp-frame')))) failures.push(`${theme}/compare: the keys are not on the pictures when they arrive`);
        const boxes = await cmp.$$eval('.cmp-box', (els) => els.map((e) => e.textContent));
        if (boxes.length !== 3 || boxes[0] !== '1 · Hero') failures.push(`${theme}/compare: the boxes are ${JSON.stringify(boxes)}`);
        await cmp.waitForTimeout(200);
        await cmp.screenshot({ path: join(out, `${theme}-live-compare-slider.png`) });
        const mode = () => cmp.$eval('.cmp-bar [role="radio"][aria-checked="true"]', (e) => e.textContent);
        for (const [key, name, shot] of [['d', 'Difference', 'difference'], ['o', 'Onion skin', 'onion'], ['t', 'Side by side', 'side'], ['ArrowRight', 'Flip', 'flip']]) {
          await cmp.keyboard.press(key);
          await cmp.waitForTimeout(150);
          if ((await mode()) !== name) failures.push(`${theme}/compare: ${key} gave ${await mode()}, wanted ${name}`);
          await cmp.screenshot({ path: join(out, `${theme}-live-compare-${shot}.png`) });
        }
        if (!/Showing Live/.test(await cmp.textContent('.cmp-flip'))) failures.push(`${theme}/compare: → did not show Live`);
        await cmp.keyboard.press(' ');
        if (!/Showing Local/.test(await cmp.textContent('.cmp-flip'))) failures.push(`${theme}/compare: Space did not flip back to Local`);
        await cmp.keyboard.press('ArrowLeft');
        if (!/Showing Local/.test(await cmp.textContent('.cmp-flip'))) failures.push(`${theme}/compare: ← did not show Local`);
        const at = () => cmp.$$eval('.cmp-change', (els) => els.findIndex((e) => e.getAttribute('aria-current') === 'true'));
        await cmp.keyboard.press('j');
        await cmp.keyboard.press('j');
        if ((await at()) !== 2) failures.push(`${theme}/compare: J J reached change ${await at()}, wanted the third`);
        await cmp.keyboard.press('k');
        if ((await at()) !== 1) failures.push(`${theme}/compare: K went to ${await at()}`);
        await cmp.keyboard.press('j');
        await cmp.keyboard.press('s');
        // The footer's clock changes on its own: ignored on this page, it is no longer a change, and the site remembers it.
        await cmp.keyboard.press('i');
        await cmp.waitForSelector('.cmp-ignored', { timeout: 5000 }).catch(() => failures.push(`${theme}/compare: ignoring the clock showed nothing`));
        const kept = await rpc('live.envs', { projectId: project.id });
        if (kept.masks.length !== 1 || kept.masks[0].width !== 1440 || kept.masks[0].label !== 'Footer' || kept.masks[0].path === null) failures.push(`${theme}/compare: the core keeps ${JSON.stringify(kept.masks)}`);
        const left = await cmp.$$eval('.cmp-change', (els) => els.map((e) => e.textContent));
        if (left.length !== 2 || left.some((t) => /Footer/.test(t))) failures.push(`${theme}/compare: after ignoring the clock the changes are ${JSON.stringify(left)}`);
        await cmp.waitForTimeout(200);
        await cmp.screenshot({ path: join(out, `${theme}-live-compare-ignored.png`) });
        // 2: both taken again at a tablet's width.
        await cmp.keyboard.press('2');
        await cmp.waitForFunction(() => window.__wgLive.shots.filter((r) => r.width === 768).length === 2, null, { timeout: 5000 }).catch(() => failures.push(`${theme}/compare: 2 did not take both at 768 px`));
        await cmp.waitForSelector('.cmp-change', { timeout: 8000 }).catch(() => {});
        await cmp.waitForTimeout(250);
        await cmp.screenshot({ path: join(out, `${theme}-live-compare-tablet.png`) });
        await cmp.keyboard.press('Escape');
        await cmp.waitForSelector('.dialog', { state: 'detached', timeout: 3000 }).catch(() => failures.push(`${theme}/compare: Escape did not close it`));

        // The site settings: environments kept, and the one the project's files name besides.
        await cmp.click('.live-bar button[aria-label="Site settings"]');
        await cmp.waitForSelector('.live-env-settings', { timeout: 5000 }).catch(() => failures.push(`${theme}/live: no environments in the site settings`));
        const found = await cmp.textContent('.live-env-found').catch(() => '');
        if (!/Stage/.test(found) || !/drush\/sites\/acme\.site\.yml: uri of @acme\.stage/.test(found)) failures.push(`${theme}/live: the settings found "${found}"`);
        await cmp.locator('.live-env-settings').scrollIntoViewIfNeeded();
        await cmp.waitForTimeout(200);
        await cmp.screenshot({ path: join(out, `${theme}-live-env-settings.png`), fullPage: true });
      } finally {
        rmSync(hadDrush ? aliases : join(project.path, 'drush'), { recursive: true, force: true });
        const left = await rpc('live.envs', { projectId: project.id });
        for (const m of left.masks) await rpc('live.unmask', { projectId: project.id, id: m.id });
        for (const e of left.envs) await rpc('live.removeEnv', { projectId: project.id, id: e.id });
        await rpc('live.setSite', { projectId: project.id, url: null });
        await cmp.close();
      }
    }

    for (const e of errors) failures.push(`${theme}: ${e}`);
    await context.close();
  }

  // What only arrives live, driven through the real core last, because it
  // changes the sessions every view above was checked against.
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
    await context.addInitScript(BRIDGE);
    await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const hook = (sessionId, event, input) => page.evaluate(async (body) => {
      const r = await fetch('/test/hook', { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
    }, { sessionId, event, input });

    // The shortcut sheet: ? and ⌘/ open it, it searches, and the menu opens it without toggling it shut.
    await page.goto(`${base}#/p/OA/board`);
    await page.waitForSelector('.card');
    await page.keyboard.press('Shift+Slash');
    await page.waitForSelector('.shortcuts', { timeout: 3000 }).catch(() => failures.push(`${theme}/shortcuts: ? did not open the sheet`));
    const rows = await page.$$eval('.shortcut', (r) => r.length);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-shortcuts.png`) });
    await page.fill('.shortcuts-search', 'board');
    const found = await page.$$eval('.shortcut dt', (d) => d.map((x) => x.textContent));
    if (!(found.length && found.length < rows && found.includes('Board of the open project'))) failures.push(`${theme}/shortcuts: searching did not narrow the sheet (${found.join(', ')})`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+Slash');
    await page.waitForSelector('.shortcuts', { timeout: 3000 }).catch(() => failures.push(`${theme}/shortcuts: ⌘/ did not open the sheet`));
    await page.evaluate(() => { window.__wgCommand('shortcuts'); window.__wgCommand('shortcuts'); });
    await page.waitForTimeout(150);
    if (!(await page.$('.shortcuts'))) failures.push(`${theme}/shortcuts: a menu command toggled the sheet shut`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__wgCommand('go-needs'));
    await page.waitForSelector('.needs-headline', { timeout: 3000 }).catch(() => failures.push(`${theme}/menu: Go › Needs You did not go there`));

    // ⌘K reaches the app from a focused terminal; Control-K stays with the terminal.
    const shellHref = await page.evaluate(async () => {
      const s = (await window.wanigan.call('sessions.list', { live: true })).find((x) => x.provider === 'shell');
      const p = (await window.wanigan.call('projects.list', {})).find((x) => x.id === s?.projectId);
      return s && p ? `#/p/${p.key}/s/${s.id}` : null;
    });
    await page.goto(`${base}${shellHref}`);
    await page.waitForSelector('.xterm-helper-textarea');
    await page.focus('.xterm-helper-textarea');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(250);
    if (await page.$('.palette')) failures.push(`${theme}/keys: Control-K was taken from the terminal`);
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('.palette', { timeout: 3000 }).catch(() => failures.push(`${theme}/keys: ⌘K did not reach the app from the terminal`));
    await page.keyboard.press('Escape');

    // Settings reach the app as patches.
    await page.goto(`${base}#/settings`);
    await page.waitForSelector('#set-general');
    await page.click('.settings-notify [role="radio"]:has-text("Only permission")');
    await page.click('.settings .check-row input');
    const app = await page.evaluate(() => window.__wgApp.settings);
    if (app.notifications !== 'urgent' || app.keepAwake !== false) failures.push(`${theme}/settings: patches did not reach the app (${JSON.stringify(app)})`);
    if (!/Off: the Mac sleeps/.test(await page.textContent('#set-general ~ *, .settings-group'))) failures.push(`${theme}/settings: turning keep-awake off is not said`);

    // Local models: LM Studio found, its server's real port, Qwen on this Mac; the demo downloads nothing.
    const localSection = await page.waitForSelector('section[aria-labelledby="set-local"] .local-module', { timeout: 5000 })
      .then(() => page.textContent('section[aria-labelledby="set-local"]'), () => '');
    if (!/Server running on port 1234/.test(localSection) || !/Qwen3-Coder 30B/.test(localSection) || !/On this Mac/.test(localSection)) {
      failures.push(`${theme}/local: Settings does not show LM Studio and Qwen (${localSection.slice(0, 160)})`);
    }
    await page.$eval('section[aria-labelledby="set-local"]', (el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${theme}-settings-local.png`) });
    // A session on Qwen says so in its header; stopped at once, so nothing after is disturbed.
    const localSession = await page.evaluate(async () => {
      const project = (await window.wanigan.call('projects.list', {})).find((p) => p.key === 'OA');
      return window.wanigan.call('sessions.start', { projectId: project.id, provider: 'claude', model: 'local/lmstudio/qwen/qwen3-coder-30b', cols: 100, rows: 30 });
    }).catch((e) => { failures.push(`${theme}/local: a session on Qwen did not start (${e.message})`); return null; });
    if (localSession) {
      await page.goto(`${base}#/p/OA/s/${localSession.id}`);
      const facts = await page.waitForSelector('.session-facts .remote-mark:has-text("On this Mac")', { timeout: 5000 })
        .then(() => page.textContent('.session-facts'), () => '');
      if (!/Qwen3-Coder 30B/.test(facts) || /local\/lmstudio/.test(facts)) failures.push(`${theme}/local: the session header does not say it runs Qwen on this Mac (${facts.slice(0, 160)})`);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(out, `${theme}-session-local.png`) });
      await page.evaluate((id) => window.wanigan.call('sessions.stop', { id }), localSession.id);
    }
    await page.goto(`${base}#/settings`);
    await page.waitForSelector('#set-general');

    // Updates: the rail asks once, nothing is checked before a yes, and a new version is news in the rail and in Settings.
    const calmApp = await page.evaluate(() => window.__wgApp);
    await page.evaluate(() => window.__wgSetApp({ ...window.__wgApp, settings: { ...window.__wgApp.settings, updateChecks: 'ask' }, updates: { state: 'never' } }));
    await page.waitForSelector('.rail-update-ask', { timeout: 3000 }).catch(() => failures.push(`${theme}/updates: the rail never asked whether to check daily`));
    const updateCopy = await page.textContent('section[aria-labelledby="set-updates"]') ?? '';
    if (!/install.*manually|manual.*install/i.test(updateCopy)) failures.push(`${theme}/updates: Settings does not explain manual installation`);
    if (/working with Apple|coming soon|macOS requires/i.test(updateCopy)) failures.push(`${theme}/updates: Settings promises an unimplemented installer`);
    await page.screenshot({ path: join(out, `${theme}-updates-ask.png`) });
    if ((await page.evaluate(() => window.__wgUpdateLog)).length) failures.push(`${theme}/updates: checked before the owner answered`);
    await page.click('.rail-update-ask button:has-text("Check daily")');
    await page.waitForSelector('.rail-update-ask', { state: 'detached', timeout: 3000 }).catch(() => failures.push(`${theme}/updates: answering did not put the question away`));
    if ((await page.evaluate(() => window.__wgApp.settings.updateChecks)) !== 'daily') failures.push(`${theme}/updates: "Check daily" did not reach the app`);
    if (!(await page.isChecked('section[aria-labelledby="set-updates"] .check-row input'))) failures.push(`${theme}/updates: Settings does not show the daily check as on`);
    await page.evaluate(() => {
      window.__wgUpdateAnswer = {
        state: 'available', checkedAt: Date.now(),
        release: {
          version: '2.0.0-alpha.3', name: '2.0.0-alpha.3: check for updates', publishedAt: Date.now() - 86_400_000, prerelease: true,
          page: 'https://github.com/DanePete/wanigan/releases/tag/v2.0.0-alpha.3',
          dmg: 'https://github.com/DanePete/wanigan/releases/download/v2.0.0-alpha.3/Wanigan-2-2.0.0-alpha.3-mac-arm64.dmg',
        },
      };
    });
    await page.click('section[aria-labelledby="set-updates"] button:has-text("Check now")');
    await page.waitForSelector('.update-found', { timeout: 3000 }).catch(() => failures.push(`${theme}/updates: a new version found by Check now is not shown`));
    if (!(await page.$('.rail-update'))) failures.push(`${theme}/updates: the rail does not say a new version is out`);
    if (!/Wanigan 2\.0\.0-alpha\.3 is available/.test(await page.textContent('.update-found') ?? '')) failures.push(`${theme}/updates: the new version is not named`);
    await page.screenshot({ path: join(out, `${theme}-updates-available.png`) });
    await page.click('.update-found button:has-text("Download")');
    await page.click('.update-found button:has-text("Release notes")');
    const updateLog = await page.evaluate(() => window.__wgUpdateLog);
    if (updateLog.join(',') !== 'check,open download,open notes') failures.push(`${theme}/updates: the window asked ${JSON.stringify(updateLog)}`);
    await page.evaluate((app) => window.__wgSetApp(app), calmApp);

    // Alerts while the window is in front: offered what is open now, while looking at another project.
    await page.goto(`${base}#/p/OA/board`);
    await page.waitForSelector('.card');
    const open = await page.evaluate(async () => {
      const all = await window.wanigan.call('needs.list', {});
      return ['permission', 'review'].map((kind) => all.find((n) => n.kind === kind)).filter(Boolean);
    });
    if (open.length < 2) failures.push(`${theme}/alerts: the seed has no permission and review to offer`);
    await page.evaluate((needs) => window.__wgOfferAlerts(needs), open);
    await page.waitForSelector('.alerts .alert:nth-child(2)', { timeout: 5000 }).catch(() => failures.push(`${theme}/alerts: two alerts never showed`));
    await page.waitForTimeout(400);
    const alerts = await page.evaluate(() => ({
      roles: [...document.querySelectorAll('.alert')].map((a) => a.getAttribute('role')).sort(),
      seen: window.__wgAlertLog.seen.length,
    }));
    if (alerts.roles.join() !== 'alert,status') failures.push(`${theme}/alerts: roles ${alerts.roles.join()}, wanted one urgent alert and one status`);
    if (alerts.seen !== open.length) failures.push(`${theme}/alerts: told the app it showed ${alerts.seen} of ${open.length}`);
    await page.screenshot({ path: join(out, `${theme}-alerts.png`) });
    await page.click('.alert[role="alert"] button:has-text("Open")');
    await page.waitForSelector('.xterm-rows', { timeout: 8000 }).catch(() => failures.push(`${theme}/alerts: Open did not go to the session asking`));
    if ((await page.evaluate(() => window.__wgAlertLog.dismissed.length)) !== 1) failures.push(`${theme}/alerts: opening an alert did not count as handling it`);
    // On screen already: shown nowhere, but accounted for.
    await page.goto(`${base}#/needs`);
    await page.waitForSelector('.needs-headline');
    await page.evaluate((needs) => window.__wgOfferAlerts(needs.map((n) => ({ ...n, since: n.since + 1 }))), open);
    await page.waitForTimeout(300);
    if (await page.$('.alerts .alert')) failures.push(`${theme}/alerts: an alert for something on screen`);

    // Agents messaging each other: a lead and its researcher, in the review card's session.
    await page.goto(`${base}#/running`);
    await page.waitForSelector('.srow');
    const lead = await page.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find((s) => s.title === 'Free shipping banner'));
    if (!lead) failures.push(`${theme}/chatter: no live session to talk`);
    else {
      const ns = (await page.evaluate(async () => (await window.wanigan.call('projects.list', {})).find((p) => p.name.startsWith('Northstar')))).key;
      await page.goto(`${base}#/p/${ns}/board`);
      await page.waitForSelector('.card');
      const send = (input, extra = {}) => hook(lead.id, 'PreToolUse', { tool_name: 'SendMessage', ...extra, tool_input: { ...input, message: 'SECRET-BODY never shown' } });
      await send({ to: 'researcher', summary: 'Does the cart drawer share the $75 check?' });
      await page.waitForTimeout(700);
      await send({ to: 'main', summary: 'Yes: both call freeShippingThreshold()' }, { agent_id: 'a91c', agent_type: 'researcher' });
      await page.waitForTimeout(700);
      await send({ to: 'researcher', summary: 'Thanks. Adding a drawer test now' });
      await page.waitForSelector('.chatter .chatter-line:nth-child(3)', { timeout: 8000 }).catch(() => failures.push(`${theme}/chatter: three messages never showed`));
      await page.waitForTimeout(900);
      const seen = await page.evaluate(() => {
        const card = document.querySelector('.chatter');
        return {
          role: card?.getAttribute('role'),
          live: card?.getAttribute('aria-live'),
          text: card?.textContent ?? '',
          left: document.querySelector('.actor-left .chatter-actor-name')?.textContent,
          right: document.querySelector('.actor-right .chatter-actor-name')?.textContent,
          link: document.querySelector('.chatter a.chatter-who')?.getAttribute('href'),
        };
      });
      if (seen.role !== 'log' || seen.live !== 'polite') failures.push(`${theme}/chatter: not a polite log (${seen.role}, ${seen.live})`);
      if (/SECRET-BODY/.test(seen.text)) failures.push(`${theme}/chatter: the message itself reached the screen`);
      if (!/never the message/.test(seen.text)) failures.push(`${theme}/chatter: no footer about labels`);
      if (!/freeShippingThreshold\(\)/.test(seen.text)) failures.push(`${theme}/chatter: a label containing its own separator did not survive`);
      if (seen.left !== 'Free shipping banner' || seen.right !== 'researcher') failures.push(`${theme}/chatter: cast as ${seen.left} / ${seen.right}`);
      if (!seen.link?.includes(`/s/${lead.id}`)) failures.push(`${theme}/chatter: the sender does not open its session (${seen.link})`);
      await page.screenshot({ path: join(out, `${theme}-chatter.png`) });
      await page.click('.chatter a.chatter-who');
      await page.waitForSelector('.xterm-rows', { timeout: 8000 }).catch(() => failures.push(`${theme}/chatter: clicking the sender did not open its session`));
    }
    // Reply from Needs you goes through the session's own queue. The row says it
    // was sent and stays until the agent's own event says its turn started.
    const shipping = await page.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find((s) => s.title === 'Free shipping banner'));
    await hook(shipping.id, 'Stop', {});
    await page.goto(`${base}#/needs`);
    if (await page.$('.chatter-x')) await page.click('.chatter-x');
    await page.waitForSelector('.need-waiting .need-reply-open');
    await page.click('.need-waiting .need-reply-open');
    await page.keyboard.type(`Show it in the cart drawer too (${theme})`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.need-waiting .need-sent', { timeout: 5000 }).catch(() => failures.push(`${theme}/reply: the row never said what happened`));
    if (!/Sent to Claude/.test((await page.textContent('.need-waiting .need-sent').catch(() => '')) ?? '')) failures.push(`${theme}/reply: the row does not say it was sent`);
    // The reply carries the files waiting for this session when their list has
    // loaded first, and then waits up to 8 s for Claude to show each image,
    // which the stand-in never does: wait past that, rather than race it.
    // It is also delivered only after the turn's checkpoint is recorded.
    const reached = await page.waitForFunction(async ({ id, text }) => (await window.wanigan.call('sessions.watch', { id })).replay.includes(text),
      { id: shipping.id, text: `Show it in the cart drawer too (${theme})` }, { timeout: 12_000, polling: 200 }).then(() => true, () => false);
    if (!reached) {
      const seen = await page.evaluate(async (id) => {
        const { session } = await window.wanigan.call('sessions.get', { id });
        const { replay } = await window.wanigan.call('sessions.watch', { id });
        return `${session.state}; ends ${JSON.stringify(replay.slice(-120))}`;
      }, shipping.id);
      failures.push(`${theme}/reply: the reply never reached the agent's terminal (${seen})`);
    }
    await page.$eval('.need-waiting .need-sent', (el) => el.scrollIntoView({ block: 'nearest' })).catch(() => {});
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${theme}-needs-replied.png`) });
    if (!(await page.$('.need-waiting .need-sent'))) failures.push(`${theme}/reply: the row cleared before the agent started`);
    await hook(shipping.id, 'UserPromptSubmit', {});
    await page.waitForFunction(() => !document.querySelector('.need-waiting .need-sent'), null, { timeout: 5000 })
      .catch(() => failures.push(`${theme}/reply: the row did not clear when the agent started its turn`));

    // Undo the last turn for real, then redo it (once: it changes the demo's worktree).
    const stock = theme === 'dark' && await page.evaluate(async () => (await window.wanigan.call('sessions.list', { live: true })).find((s) => s.title === 'Low-stock badge on product cards'));
    if (stock) {
      const nsKey = (await page.evaluate(async () => (await window.wanigan.call('projects.list', {})).find((p) => p.name.startsWith('Northstar')))).key;
      await page.goto(`${base}#/p/${nsKey}/s/${stock.id}`);
      await page.click('.turn-change button:has-text("Undo this turn")', { timeout: 8000 }).catch(() => failures.push('dark/undo: no Undo this turn'));
      await page.waitForSelector('.dialog .undo-files li', { timeout: 8000 });
      await page.click('.dialog-foot button:has-text("Undo turn 3")');
      await page.waitForSelector('.toast-info:has-text("Undone. Claude Code doesn’t know yet")', { timeout: 8000 }).catch(() => failures.push('dark/undo: no toast saying the agent does not know'));
      await page.waitForSelector('.tl-Undo:has-text("You undid turn 3: 2 files")', { timeout: 8000 }).catch(() => failures.push('dark/undo: the timeline does not record the undo'));
      await page.waitForSelector('.turn-change button:has-text("Redo")', { timeout: 8000 }).catch(() => failures.push('dark/undo: no Redo after undoing'));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, 'dark-session-undone.png') });
      await page.click('.turn-change button:has-text("Redo")');
      await page.click('.dialog-foot button:has-text("Redo turn 3")');
      await page.waitForSelector('.tl-Redo:has-text("You redid turn 3: 2 files")', { timeout: 8000 }).catch(() => failures.push('dark/undo: the redo was not recorded'));
      await page.waitForSelector('.turn-change button:has-text("Undo this turn")', { timeout: 8000 }).catch(() => failures.push('dark/undo: undo is not offered again after redo'));
    }

    // The git workbench for real (once): a hunk and picked lines staged, a message from Claude, a
    // commit past the secret finding, a push past its scan, a refusal, a branch made and deleted.
    if (theme === 'dark') {
      const nsKey = (await page.evaluate(async () => (await window.wanigan.call('projects.list', {})).find((p) => p.name.startsWith('Northstar')))).key;
      const nsId = await page.evaluate(async (key) => (await window.wanigan.call('projects.list', {})).find((p) => p.key === key).id, nsKey);
      const git = (method, params = {}) => page.evaluate(([m, p]) => window.wanigan.call(m, p), [method, { id: nsId, ...params }]);
      const gitFails = (method, params = {}) => page.evaluate(([m, p]) => window.wanigan.call(m, p).then(() => null, (e) => e.message), [method, { id: nsId, ...params }]);
      await page.goto(`${base}#/p/${nsKey}/changes`);
      await page.waitForSelector('.dl-add');
      await page.click('.changes .toolbar [role="radio"]:has-text("Unified")');

      // The PHP file's second hunk: staged alone, so the file is in both lists.
      const php = '.diff-slot[data-key="changed:web/modules/custom/northstar_checkout/src/Controller/CheckoutController.php"]';
      await page.click('.git-file[data-key$="CheckoutController.php"] .git-file-main');
      await page.waitForSelector(`${php} .hunk-btn`, { timeout: 8000 });
      await page.locator(`${php} .dl-hunk`).nth(1).locator('button:has-text("Stage hunk")').click();
      await page.waitForSelector('.diff-slot[data-key="staged:web/modules/custom/northstar_checkout/src/Controller/CheckoutController.php"]', { timeout: 8000 })
        .catch(() => failures.push('git/live: Stage hunk did not stage it'));
      let s = await git('git.status');
      const phpStaged = s.staged.find((f) => f.path.endsWith('CheckoutController.php'));
      const phpChanged = s.changed.find((f) => f.path.endsWith('CheckoutController.php'));
      if (!phpStaged || !phpChanged || phpStaged.additions !== 1 || phpStaged.deletions !== 1) failures.push(`git/live: after staging one hunk git has ${JSON.stringify([phpStaged, phpChanged])}`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, 'dark-git-stage-hunk.png') });

      // Two of the CSS file's added lines, picked and staged: exactly two lines go in.
      const css = '.diff-slot[data-key="changed:web/modules/custom/northstar_checkout/css/pay-button.css"]';
      await page.click('.git-file[data-key$="pay-button.css"] .git-file-main');
      await page.waitForSelector(`${css} .dl-pick-box`, { timeout: 8000 });
      const boxes = await page.$$(`${css} .dl-add .dl-pick-box`);
      await boxes[1]?.click();
      await boxes[2]?.click({ modifiers: ['Shift'] });
      await page.click(`${css} .pick-bar button:has-text("Stage lines")`);
      await page.waitForSelector('.toast-info:has-text("Staged 2 lines of pay-button.css")', { timeout: 8000 }).catch(() => failures.push('git/live: staging picked lines did not say so'));
      s = await git('git.status');
      if (s.staged.find((f) => f.path.endsWith('pay-button.css'))?.additions !== 2) failures.push(`git/live: picked lines staged ${JSON.stringify(s.staged.find((f) => f.path.endsWith('pay-button.css')))}`);

      // While agents work here, what would change their files is refused, with the reason.
      const refused = await gitFails('git.switch', { branch: 'release/2026.10' });
      if (!/(?:is|are) running in the project folder, so Wanigan will not switch branches there/.test(refused ?? '')) failures.push(`git/live: switching beside a live agent said "${refused}"`);

      // Write with Claude, then commit past the finding the scan made.
      await page.click('.commit-box button:has-text("Write with Claude")');
      await page.waitForFunction(() => document.querySelector('.commit-subject input')?.value === 'Give the pay button an accessible name', null, { timeout: 8000 })
        .catch(() => failures.push('git/live: Write with Claude did not fill the summary'));
      await page.click('.commit-go');
      await page.click('.dialog button:has-text("Commit anyway")');
      await page.waitForSelector('.secret-findings', { timeout: 8000 });
      await page.check('.secret-findings .secret-ack input');
      await page.click('.commit-findings button:has-text("Commit anyway")');
      await page.waitForSelector('.toast-info:has-text("Committed")', { timeout: 8000 }).catch(() => failures.push('git/live: the commit did not say it was made'));
      const log = await git('git.log', { limit: 1 });
      if (log.commits[0]?.subject !== 'Give the pay button an accessible name') failures.push(`git/live: the newest commit is "${log.commits[0]?.subject}"`);
      s = await git('git.status');
      if (s.staged.length) failures.push(`git/live: ${s.staged.length} files still staged after the commit`);

      // Push: the new commit carries the key, so the push's own scan stops it until acknowledged.
      const plan = await git('git.pushPlan');
      await page.click('.remote-actions button:has-text("Push")');
      await page.waitForSelector('.dialog .secret-findings', { timeout: 8000 }).catch(() => failures.push('git/live: the push scan did not find the key in the commit'));
      await page.check('.dialog .secret-ack input');
      await page.click('.dialog button:has-text("Push anyway")');
      await page.waitForSelector(`.toast-info:has-text("Pushed ${plan.total} commits to origin/main")`, { timeout: 15000 }).catch(() => failures.push('git/live: the push did not say what it pushed'));
      const after = await git('git.pushPlan');
      if (!/Nothing to push/.test(after.refusal ?? '')) failures.push(`git/live: after pushing, the plan says "${after.refusal}"`);
      if ((await git('git.status')).ahead !== 0) failures.push('git/live: still ahead of origin after pushing');

      // A branch made without switching (the agents stay put), then deleted: it was merged, so quietly.
      await page.goto(`${base}#/p/${nsKey}/changes/branches`);
      await page.waitForSelector('.branch-row');
      await page.click('.branches-toolbar button:has-text("New branch")');
      await page.fill('#branch-new-name', 'feature/sticky-summary');
      // Agents are at work in the folder, so the new branch is made without switching, and says so.
      if (await page.isEnabled('.branch-new-switch input')) failures.push('git/live: Switch to it is offered while agents work in the folder');
      else if (await page.isChecked('.branch-new-switch input')) failures.push('git/live: Switch to it is ticked but cannot be changed');
      await page.click('.branch-new button:has-text("Make the branch")');
      await page.waitForSelector('.branch-row:has(.branch-name:text-is("feature/sticky-summary"))', { timeout: 8000 }).catch(() => failures.push('git/live: the new branch is not listed'));
      if ((await git('git.status')).branch !== 'main') failures.push('git/live: making a branch without switching switched');
      await page.click('.branch-row:has(.branch-name:text-is("feature/sticky-summary")) button:has-text("Delete")');
      await page.waitForSelector('.dialog:has-text("Everything on it is already in main")', { timeout: 5000 }).catch(() => failures.push('git/live: deleting a merged branch did not say nothing is lost'));
      await page.click('.dialog-foot button:has-text("Delete")');
      await page.waitForSelector('.branch-row:has(.branch-name:text-is("feature/sticky-summary"))', { state: 'detached', timeout: 8000 }).catch(() => failures.push('git/live: the deleted branch is still listed'));
      const activity = await page.evaluate(async (id) => (await window.wanigan.call('activity.list', { projectId: id, limit: 20 })).map((a) => a.verb), nsId);
      for (const verb of ['committed', `pushed ${plan.total} commits to origin/main`, 'deleted the branch feature/sticky-summary']) {
        if (!activity.includes(verb)) failures.push(`git/live: the activity log has no "${verb}" (${activity.slice(0, 6).join('; ')})`);
      }

      // NS-13's merge, resolved for real: three choices written and staged, the added file
      // taken whole from the card's side, then the merge completed from the commit box.
      const ns13 = await page.evaluate(async ([pid, key]) => (await window.wanigan.call('cards.list', { projectId: pid })).find((c) => c.key === key)?.id, [nsId, `${nsKey}-13`]);
      const midway = await git('git.status', { cardId: ns13 });
      const copyPath = midway.conflicted.find((f) => f.path.endsWith('copy.ts'))?.path;
      const totalsPath = midway.conflicted.find((f) => f.path.endsWith('totals.ts'))?.path;
      await page.goto(`${base}#/p/${nsKey}/changes?branch=${nsKey}-13`);
      const copyHunks = page.locator(`.resolver[aria-label="Resolve ${copyPath}"] .resolver-hunk`);
      await copyHunks.first().waitFor({ timeout: 8000 }).catch(() => failures.push('resolve/live: copy.ts never showed its conflicts'));
      const picks = ['Both, ours first', 'Ours', 'Both, theirs first'];
      const n = await copyHunks.count();
      for (let i = 0; i < n; i++) await copyHunks.nth(i).locator(`[role="radio"]:text-is("${picks[i] ?? 'Ours'}")`).click();
      await page.click(`.resolver[aria-label="Resolve ${copyPath}"] .resolver-head button:has-text("Mark resolved")`);
      await page.waitForSelector(`.toast-info:has-text("Resolved ${copyPath}. 1 file still conflicts.")`, { timeout: 8000 }).catch(() => failures.push('resolve/live: marking copy.ts resolved did not say one file is left'));
      let r = await git('git.status', { cardId: ns13 });
      if (r.conflicted.map((f) => f.path).join() !== totalsPath || !r.staged.some((f) => f.path === copyPath)) failures.push(`resolve/live: after copy.ts, git has conflicted ${r.conflicted.map((f) => f.path)} and staged ${r.staged.map((f) => f.path)}`);
      const written = await git('git.diff', { cardId: ns13, path: copyPath, area: 'staged' });
      for (const want of ["+import { FREE_SHIPPING_OVER } from './settings';", "+  empty: 'Nothing in your cart yet.',", "+  checkout: 'Check out',"]) {
        if (!written.diff.includes(want)) failures.push(`resolve/live: the staged copy.ts lacks "${want}"`);
      }
      if (/^[+ ](?:<{7}|={7}|>{7}|\|{7})/m.test(written.diff)) failures.push('resolve/live: the staged copy.ts still holds conflict markers');
      // The added file: the card's own version, whole.
      await page.click(`.resolver[aria-label="Resolve ${totalsPath}"] button:has-text("Take ours (${midway.branch})")`);
      await page.waitForSelector('.toast-info:has-text("Nothing conflicts now")', { timeout: 8000 }).catch(() => failures.push('resolve/live: taking ours for totals.ts did not say nothing conflicts'));
      r = await git('git.status', { cardId: ns13 });
      if (r.conflicted.length || r.operation !== 'merge') failures.push(`resolve/live: after both files git has ${r.conflicted.length} conflicted, operation ${r.operation}`);
      await page.waitForFunction(() => document.querySelector('.commit-go-label')?.textContent === 'Complete the merge', null, { timeout: 8000 })
        .catch(() => failures.push('resolve/live: the commit box does not offer to complete the merge'));
      const message = await page.inputValue('.commit-subject input').catch(() => '');
      if (message !== (r.operationMessage ?? '').split('\n')[0]) failures.push(`resolve/live: the commit box has "${message}", git prepared "${r.operationMessage?.split('\n')[0]}"`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, 'dark-git-resolve-complete.png') });
      await page.click('.commit-go');
      await page.waitForSelector(`.toast-info:has-text("Committed")`, { timeout: 8000 }).catch(() => failures.push('resolve/live: completing the merge did not say it committed'));
      r = await git('git.status', { cardId: ns13 });
      const merged = await git('git.log', { cardId: ns13, limit: 1 });
      if (r.operation || r.conflicted.length || r.staged.length) failures.push(`resolve/live: after completing, git has operation ${r.operation}, ${r.conflicted.length} conflicted, ${r.staged.length} staged`);
      if (merged.commits[0]?.parents.length !== 2 || merged.commits[0]?.subject !== message) failures.push(`resolve/live: the newest commit is "${merged.commits[0]?.subject}" with ${merged.commits[0]?.parents.length} parents`);
      if (await page.$('.git-operation')) failures.push('resolve/live: the merge banner stayed after the merge was completed');
    }
    for (const e of errors) failures.push(`${theme}: ${e}`);

    // A view that throws: the core answers Running with something it cannot read.
    // Its own page, because React rightly logs the error it caught.
    const broken = await context.newPage();
    await broken.addInitScript(() => {
      const real = window.wanigan.call;
      window.__wgBreak = true;
      window.__wgFail = new Set();
      window.wanigan.call = async (m, p) => {
        if (window.__wgFail.has(m)) throw Object.assign(new Error('Wanigan’s core did not answer.'), { code: 'unavailable' });
        return m === 'sessions.list' && window.__wgBreak ? { broken: true } : real(m, p);
      };
    });
    await broken.goto(`${base}#/running`);
    const crashed = await broken.waitForSelector('.view-crash', { timeout: 8000 }).then(() => true, () => false);
    if (!crashed) failures.push(`${theme}/crash: a throwing view did not show the crash panel`);
    else {
      const shown = await broken.evaluate(() => ({ rail: !!document.querySelector('.rail-projects a'), text: document.querySelector('.view-crash')?.textContent ?? '' }));
      if (!shown.rail) failures.push(`${theme}/crash: the rest of the window went with the view`);
      if (!/Running stopped working/.test(shown.text) || !/TypeError/.test(shown.text)) failures.push(`${theme}/crash: the panel does not say what broke`);
      await broken.click('.view-crash button:has-text("Copy details")');
      await broken.waitForSelector('.view-crash [role="status"]:has-text("Copied.")', { timeout: 3000 }).catch(() => failures.push(`${theme}/crash: Copy details did not copy`));
      await broken.waitForTimeout(250);
      await broken.screenshot({ path: join(out, `${theme}-crash.png`) });
      await broken.evaluate(() => { window.__wgBreak = false; });
      await broken.click('.view-crash button:has-text("Reload this view")');
      await broken.waitForSelector('.srow', { timeout: 8000 }).catch(() => failures.push(`${theme}/crash: Reload this view did not bring the view back`));
    }

    // An error toast stays until it is dismissed, and can retry what failed.
    const shellSession = await broken.evaluate(async () => {
      const list = await window.wanigan.call('sessions.list', { live: true });
      const projects = await window.wanigan.call('projects.list', {});
      const s = list.find((x) => x.provider === 'shell');
      return s ? `#/p/${projects.find((p) => p.id === s.projectId).key}/s/${s.id}` : null;
    });
    if (!shellSession) failures.push(`${theme}/toast: no live shell session to message`);
    else {
      await broken.goto(`${base}${shellSession}`);
      await broken.waitForSelector('#composer');
      await broken.evaluate(() => window.__wgFail.add('sessions.queue'));
      await broken.fill('#composer', 'echo retried-$((40+2))');
      await broken.press('#composer', 'Enter');
      await broken.waitForSelector('.toast-error', { timeout: 3000 }).catch(() => failures.push(`${theme}/toast: no error toast`));
      await broken.waitForTimeout(4000);
      if (!(await broken.$('.toast-error'))) failures.push(`${theme}/toast: the error left before anyone dismissed it`);
      await broken.screenshot({ path: join(out, `${theme}-toast-error.png`) });
      await broken.evaluate(() => window.__wgFail.delete('sessions.queue'));
      await broken.click('.toast-error button:has-text("Retry")');
      await broken.waitForFunction(() => !document.querySelector('.toast-error') && document.querySelector('#composer')?.value === '', null, { timeout: 5000 })
        .catch(() => failures.push(`${theme}/toast: Retry did not send the message`));
      await broken.waitForSelector('.xterm-rows:has-text("retried-")', { timeout: 8000 }).catch(() => failures.push(`${theme}/toast: the retried message never reached the terminal`));
    }
    await context.close();
  }
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`UI sweep failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`UI sweep passed. Screenshots in ${out}`);
