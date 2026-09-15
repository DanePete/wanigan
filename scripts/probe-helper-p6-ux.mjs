#!/usr/bin/env node
// The helper sweep's everyday conveniences, in the built renderer: tags on
// session tabs, Recent sections and the tag filter, tags in Fleet, the terminal's
// link and selection menu and the code reader it opens at a line, the status
// bar's copy menu, the side question, the code rail's pop-out and its window,
// shortcut search in the palette, and the transcript reader's Markdown copy,
// quote and mermaid source.
//
// Plain Chromium with the preload bridge stubbed (scripts/renderer-harness.mjs):
// evidence about layout, wording and focus, never about IPC, the database or
// PTYs — smoke35 covers those. One scenario, one file name; each shot is
// asserted to have rendered what its name promises.
//
// Usage:
//   npm run build && node scripts/probe-helper-p6-ux.mjs [--before] [--out docs/visuals/helper-p6-ux/after]
// --before shoots the same routes against a build that predates the feature and
// asserts only that each view rendered.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openRenderer, rendererURL } from './renderer-harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BEFORE = args.includes('--before');
const outArg = args.indexOf('--out');
const OUT = path.resolve(REPO, outArg >= 0 ? args[outArg + 1] : `docs/visuals/helper-p6-ux/${BEFORE ? 'before' : 'after'}`);
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results = [];
const check = (ok, label, detail) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!ok) { failures += 1; if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 600)}`); }
};
const expect = (ok, label, detail) => { if (!BEFORE) check(ok, label, detail); };
const errors = [];
const onError = (m) => { if (!/WebGPU|favicon|Untrusted/.test(m)) errors.push(m); };

// Generic example data only: this file is committed.
const INSTRUMENT = `
(() => {
  const api = window.wanigan, now = Date.now();
  localStorage.setItem('wanigan.code', '0');
  localStorage.setItem('wanigan.composer', '1');
  window.__copied = [];
  window.__revealed = [];
  const projects = [
    { id: 'p1', name: 'storefront', path: '/example/storefront', branch: 'main' },
    { id: 'p2', name: 'platform', path: '/example/platform', branch: 'main' },
  ];
  const caps = { hooks: true };
  const base = { unread: 0, worktree: null, pid: 4100, exitCode: null, endedAt: null, capabilities: caps };
  const sessions = [
    { ...base, id: 's1', providerId: 'claude', harnessId: 'claude-code', projectId: 'p1', projectName: 'storefront', projectPath: '/example/storefront', title: 'Claude Code · storefront', displayTitle: 'Checkout bug', status: 'running', createdAt: now - 900000, conversationId: 'c1', model: 'claude-opus-5' },
    { ...base, id: 's2', providerId: 'claude', harnessId: 'claude-code', projectId: 'p1', projectName: 'storefront', projectPath: '/example/storefront', title: 'Claude Code · storefront', displayTitle: 'Invoice rounding', status: 'running', createdAt: now - 600000, conversationId: 'c2', model: 'claude-opus-5' },
    { ...base, id: 's3', providerId: 'codex', harnessId: 'codex', projectId: 'p2', projectName: 'platform', projectPath: '/example/platform', title: 'Codex · platform', displayTitle: 'Release notes', status: 'running', createdAt: now - 300000, conversationId: 't3', model: 'gpt-5-codex' },
  ];
  const supports = { model: true, effort: true, permissionMode: true, resume: true };
  const providers = [
    { id: 'claude', label: 'Claude Code', harnessId: 'claude-code', backendId: 'anthropic', path: '/usr/local/bin/claude', version: '2.1.271 (Claude Code)', supports, capabilities: {}, launchFields: [] },
    { id: 'codex', label: 'Codex', harnessId: 'codex', backendId: 'openai', path: '/usr/local/bin/codex', version: 'codex-cli 0.154.0', supports, capabilities: {}, launchFields: [] },
  ];
  const attention = [
    { sessionId: 's1', kind: 'working', transitionId: 't1', since: now - 40000, label: 'Working', detail: null, tool: null, projectName: 'storefront' },
    { sessionId: 's2', kind: 'idle', transitionId: 't2', since: now - 60000, label: 'Idle', detail: null, tool: null, projectName: 'storefront' },
    { sessionId: 's3', kind: 'idle', transitionId: 't3', since: now - 30000, label: 'Idle', detail: null, tool: null, projectName: 'platform' },
  ];
  const pastRow = (id, over) => Object.assign({ id, conversationId: 'c-' + id, providerId: 'claude', projectId: 'p1', projectPath: '/example/storefront',
    projectName: 'storefront', worktree: null, model: 'claude-opus-5', effort: null, permissionMode: null, startedAt: now - 86400000,
    endedAt: now - 80000000, exitCode: 0, continuationCount: 1, live: true, pinnedAt: null, settledAt: null, title: null, titleSource: null }, over);
  const past = [
    pastRow('r1', { title: 'Discount codes stack twice', titleSource: 'agent', startedAt: now - 3600000 }),
    pastRow('r2', { title: 'Flaky checkout test', titleSource: 'agent', startedAt: now - 7200000 }),
    pastRow('r3', { title: 'Migrate orders table', titleSource: 'named', startedAt: now - 9000000 }),
    pastRow('r4', { title: 'Upgrade payment SDK', titleSource: 'agent', startedAt: now - 12000000, pinnedAt: now - 100000 }),
    pastRow('r5', { title: 'Tidy README', titleSource: 'prompt', startedAt: now - 20000000 }),
  ];
  const tag = (t, color) => ({ tag: t, norm: t.toLowerCase(), color });
  const organised = {
    s1: { key: 'k1', tags: [tag('release-blocker', 'red'), tag('checkout', 'blue')], placement: null },
    s2: { key: 'k2', tags: [tag('checkout', 'blue')], placement: null },
    s3: { key: 'k3', tags: [tag('docs', 'teal')], placement: null },
    r1: { key: 'kr1', tags: [tag('checkout', 'blue')], placement: { sectionId: 'sec_week00001', position: 0 } },
    r2: { key: 'kr2', tags: [tag('waiting on CI', 'yellow')], placement: { sectionId: 'sec_week00001', position: 1 } },
    r3: { key: 'kr3', tags: [], placement: { sectionId: 'sec_parked0001', position: 0 } },
    r4: { key: 'kr4', tags: [tag('release-blocker', 'red')], placement: null },
    r5: { key: 'kr5', tags: [], placement: null },
  };
  const sections = [
    { id: 'sec_week00001', name: 'This week', position: 0 },
    { id: 'sec_parked0001', name: 'Parked', position: 1 },
  ];
  const tagIndex = [
    { ...tag('checkout', 'blue'), count: 3 }, { ...tag('release-blocker', 'red'), count: 2 },
    { ...tag('docs', 'teal'), count: 1 }, { ...tag('waiting on CI', 'yellow'), count: 1 },
  ];
  const fileText = Array.from({ length: 80 }, (_, i) => i === 41 ? '    return Math.round(total * 100) / 100; // line 42' : '// storefront checkout source line ' + (i + 1)).join('\\n');
  const ux = {
    organise: async (ids) => ({ sessions: Object.fromEntries(ids.map((id) => [id, organised[id] ?? { key: null, tags: [], placement: null }])), sections, tags: tagIndex }),
    addTags: async (id) => organised[id], removeTag: async (id) => organised[id], setTagColor: async (_t, c) => c,
    createSection: async () => sections, renameSection: async () => sections, moveSection: async () => sections, deleteSection: async () => sections,
    placeInSection: async (id) => organised[id], moveInSection: async (id) => organised[id],
    resolvePath: async (sessionId, raw) => raw.startsWith('src/Checkout.php')
      ? { ok: true, absolute: '/example/storefront/src/Checkout.php', rel: 'src/Checkout.php', line: 42, column: null, directory: false }
      : raw.startsWith('/etc') ? { ok: false, reason: 'It is outside every project and worktree Wanigan manages, so it will not be opened or revealed.' }
      : { ok: false, reason: 'No such file or folder.' },
    revealPath: async (id, raw) => { window.__revealed.push(raw); return true; },
    copyText: async (text) => { window.__copied.push(text); return { chars: text.length }; },
    copyAvailability: async (id) => id === 's3'
      ? { lastResponse: { ok: false, reason: 'Codex has not reported a thread id for this session yet, so its rollout cannot be found.' }, conversationId: null }
      : { lastResponse: { ok: true, from: 'the Claude Code transcript' }, conversationId: 'c2' },
    copyLastResponse: async () => { window.__copied.push('last response'); return { chars: 812, from: 'the Claude Code transcript' }; },
    copyConversationId: async () => { window.__copied.push('c2'); return { chars: 2 }; },
    copyTranscriptMarkdown: async () => ({ chars: 5234, turns: 6, redacted: true, note: null }),
    liveSessionFor: async () => ({ sessionId: 's2', title: 'Invoice rounding' }),
    openCodeRail: async () => ({ opened: true }),
    railSession: async (id) => ({ id, projectName: 'storefront', root: '/example/storefront', title: 'Invoice rounding', live: true, checkpointsSupported: true }),
  };
  const transcriptTurns = [
    { at: now - 600000, role: 'user', text: 'How does an order move from cart to invoice?' },
    { at: now - 590000, role: 'tool', text: '', toolName: 'Read' },
    { at: now - 580000, role: 'assistant', text: 'Three steps, drawn below.\\n\\n\\u0060\\u0060\\u0060mermaid\\ngraph TD\\n  Cart --> Checkout\\n  Checkout --> Invoice\\n\\u0060\\u0060\\u0060\\n\\nThe rounding happens in Checkout.' },
  ];
  window.wanigan = new Proxy(api, { get(target, service) {
    if (service === 'ux') return ux;
    if (service === 'projects') return new Proxy(target.projects, { get(o, k) { return (k === 'list' || k === 'refresh') ? async () => projects : o[k]; } });
    if (service === 'providers') return new Proxy(target.providers, { get(o, k) { return k === 'list' ? async () => providers : o[k]; } });
    if (service === 'sessions') return new Proxy(target.sessions, { get(o, k) {
      if (k === 'list') return async () => sessions;
      if (k === 'past') return async () => past;
      if (k === 'scrollback') return async () => 'Edited src/Checkout.php:42 and ran the tests.\\r\\nSee https://example.com/docs/checkout for the flow.\\r\\nConfig lives in /etc/hosts (not a project file).\\r\\n';
      return o[k];
    } });
    if (service === 'attention') return { list: async () => attention };
    if (service === 'code') return new Proxy(target.code, { get(o, k) {
      if (k === 'read') return async () => ({ text: fileText, truncated: false, size: fileText.length, binary: false });
      if (k === 'list') return async () => [{ name: 'src', rel: 'src', dir: true, size: 0 }];
      if (k === 'changes') return async () => ({ isRepo: true, branch: 'main', files: [{ path: 'src/Checkout.php', index: ' ', work: 'M', staged: false, untracked: false }], headMoved: false, commits: 0 });
      if (k === 'diff') return async () => 'diff --git a/src/Checkout.php b/src/Checkout.php\\n@@ -40,3 +40,3 @@\\n-    return round($total);\\n+    return round($total, 2);\\n';
      if (k === 'editors') return async () => [];
      return o[k];
    } });
    if (service === 'transcripts') return new Proxy(target.transcripts, { get(o, k) {
      if (k === 'search') return async () => [{ sessionId: 'r1', projectName: 'storefront', projectPath: '/example/storefront', providerId: 'claude', startedAt: now - 3600000, snippet: 'How does an «order» move from cart to invoice?', role: 'user', at: now - 600000 }];
      if (k === 'get') return async () => ({ turns: transcriptTurns, note: null, bytes: 18234 });
      return o[k];
    } });
    return target[service];
  } });
})();
`;

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePreference = t;
    document.documentElement.style.colorScheme = t;
    window.dispatchEvent(new CustomEvent('wanigan:theme-changed', { detail: { preference: t, resolved: t } }));
  }, theme);
  await page.waitForTimeout(400);
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

const clipped = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)]
  .map((el) => ({ text: el.textContent?.trim().slice(0, 60), clipped: el.scrollWidth > el.clientWidth + 1 })), selector);

async function toView(page, key) {
  await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
}

async function shootBox(page, locator, file, pad = 8) {
  const box = await locator.boundingBox();
  if (!box) return false;
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const clip = { x, y, width: Math.min(vp.width - x, box.width + pad * 2), height: Math.min(vp.height - y, box.height + pad * 2) };
  await page.screenshot({ path: path.join(OUT, file), clip });
  return true;
}

/**
 * Client coordinates of a character in the visible terminal: a Range over the
 * DOM renderer's row text at that offset, so the point is the character's own
 * box rather than a column estimate.
 */
const cellPoint = (page, col, row) => page.evaluate(({ col, row }) => {
  const host = [...document.querySelectorAll('.terminal-host')].find((h) => h.offsetParent !== null);
  const line = host?.querySelectorAll('.xterm-rows > div')[row];
  if (!line) return null;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let remaining = col;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent.length;
    if (remaining < len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    remaining -= len;
  }
  return null;
}, { col, row });

for (const theme of ['light', 'dark']) {
  console.log(`\n── ${BEFORE ? 'before' : 'after'} · ${theme}`);
  const { page, close } = await openRenderer({ theme, width: 1440, height: 900, onError, instrument: INSTRUMENT });
  try {
    const bg = await setTheme(page, theme);
    check(true, `palette switched (${bg})`);

    /* ── 1 · tags on session tabs, and the tab's organise panel ─────── */
    await toView(page, 'Meta+1');
    await page.locator('.sessions-view').waitFor({ timeout: 8000 });
    await page.locator('.session-item', { hasText: 'Invoice rounding' }).first().click();
    await page.waitForTimeout(1200);
    const rail = page.locator('.session-rail').first();
    check(await rail.count() === 1 && (await rail.textContent()).includes('Checkout bug'), 'the session rail rendered its tabs');
    expect(await page.locator('.session-item', { hasText: 'Checkout bug' }).locator('.ux-tag').count() === 2,
      'the Checkout bug tab wears its two tags');
    const triage = page.locator('.past-row', { hasText: 'Checkout bug' }).locator('.session-tab-triage').first();
    if (await triage.count()) { await triage.click(); await page.waitForTimeout(500); }
    expect(await page.locator('.ux-organise').count() >= 1
      && await page.locator('.ux-organise select[aria-label^="Colour for the tag"]').count() === 2
      && await page.locator('.ux-organise input[aria-label^="Add tags to"]').count() === 1,
    'the tab menu carries the tag editor: a colour per tag, an add field, and the section choice');
    const tagClip = await clipped(page, '.session-rail .ux-tag');
    expect(tagClip.length >= 3 && tagClip.every((t) => !t.clipped), 'tag chips on the tabs are not clipped', tagClip);
    await shootBox(page, rail, `session-tabs-tags-${theme}.png`, 0);
    if (await triage.count()) { await triage.click(); await page.waitForTimeout(300); }

    /* ── 2 · Recent: sections, tag filter, organise panel on a row ──── */
    const recent = page.locator('.rail-scroll').first();
    await page.locator('.group-title', { hasText: 'Recent conversations' }).first().scrollIntoViewIfNeeded().catch(() => {});
    check((await recent.textContent()).includes('Recent conversations'), 'Recent conversations rendered');
    expect(await page.locator('.ux-section-name', { hasText: 'This week' }).count() === 1
      && await page.locator('.ux-section-name', { hasText: 'Parked' }).count() === 1,
    'Recent shows the two sections in the operator’s order');
    expect(await page.locator('button[aria-label="Move the section This week down"]').count() === 1
      && await page.locator('button[aria-label="Move the section This week up"]').isDisabled(),
    'each section has named move buttons, and the first cannot move up');
    const orderText = await page.evaluate(() => [...document.querySelectorAll('.rail-scroll .past-name, .rail-scroll .ux-section-name')].map((e) => e.textContent.trim()).join(' | '));
    expect(/Upgrade payment SDK.*This week.*Discount codes stack twice.*Flaky checkout test.*Parked.*Migrate orders table.*Tidy README/.test(orderText),
      'pinned first, then each section with its members in order, then the unfiled rows', orderText);
    expect(await page.locator('.ux-tag-filter[aria-label="Filter Recent conversations by tag"] .chip').count() === 4,
      'Recent offers a filter for each tag its rows carry, plus Any tag');
    const organiseBtn = page.locator('button[aria-label="Tags, section and more for Flaky checkout test"]').first();
    if (await organiseBtn.count()) { await organiseBtn.click(); await page.waitForTimeout(400); }
    expect(await page.locator('button[aria-label="Move Flaky checkout test up in This week"]').count() === 1,
      'a filed Recent row can be moved up and down within its section by named buttons');
    await page.locator('.ux-section-name', { hasText: 'This week' }).first().scrollIntoViewIfNeeded().catch(() => {});
    await shootBox(page, recent, `recent-sections-${theme}.png`, 0);
    if (await organiseBtn.count()) { await organiseBtn.click(); await page.waitForTimeout(200); }
    const filterChip = page.locator('.ux-tag-filter .chip', { hasText: 'waiting on CI' }).first();
    if (await filterChip.count()) {
      await filterChip.click();
      await page.waitForTimeout(400);
      const names = await page.evaluate(() => [...document.querySelectorAll('.rail-scroll .past-name')].map((e) => e.textContent.trim()));
      expect(names.length === 1 && names[0].includes('Flaky checkout test'), 'the tag filter narrows Recent to the rows carrying the tag', names);
      await filterChip.click();
      await page.waitForTimeout(300);
    } else {
      expect(false, 'the tag filter chip for “waiting on CI” exists');
    }

    /* ── 3 · the terminal menu on a path, a URL, and a selection ─────── */
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    await page.waitForTimeout(600);
    const termText = await page.evaluate(() => [...document.querySelectorAll('.terminal-host')].find((h) => h.offsetParent !== null)?.textContent ?? '');
    check(termText.includes('Edited src/Checkout.php:42'), 'the terminal rendered its scrollback', termText.slice(0, 120));
    const pathPoint = await cellPoint(page, 10, 0);
    if (pathPoint) {
      await page.mouse.click(pathPoint.x, pathPoint.y, { button: 'right' });
      await page.waitForTimeout(600);
    }
    const menu = page.locator('.ux-menu[aria-label="Terminal actions"]');
    expect(await menu.count() === 1, 'right-clicking a printed path opens the terminal menu', pathPoint);
    // The same right-click on a build without the menu, for the comparison.
    if (BEFORE) await shootBox(page, page.locator('.session-main').first(), `terminal-path-menu-${theme}.png`, 0);
    if (await menu.count()) {
      const menuText = await menu.textContent();
      expect(menuText.includes('Open in the code rail at line 42') && menuText.includes('Reveal in Finder') && menuText.includes('Copy path'),
        'the path menu offers the code rail at the printed line, Reveal in Finder and Copy path', menuText);
      await shootBox(page, page.locator('.session-main').first(), `terminal-path-menu-${theme}.png`, 0);
      await page.locator('.ux-menu-item', { hasText: 'Reveal in Finder' }).click();
      await page.waitForTimeout(300);
      expect((await page.evaluate(() => window.__revealed)).includes('src/Checkout.php:42'), 'Reveal in Finder asks main with the session and the printed path');
    }
    const urlPoint = await cellPoint(page, 12, 1);
    if (urlPoint) { await page.mouse.click(urlPoint.x, urlPoint.y, { button: 'right' }); await page.waitForTimeout(500); }
    if (!BEFORE) {
      const urlMenu = await menu.textContent().catch(() => '');
      expect(urlMenu.includes('https://example.com/docs/checkout') && urlMenu.includes('Open link') && urlMenu.includes('Copy link'),
        'right-clicking a URL offers Open link and Copy link', urlMenu);
      await page.locator('.ux-menu-item', { hasText: 'Copy link' }).click().catch(() => {});
      await page.waitForTimeout(300);
      expect((await page.evaluate(() => window.__copied)).includes('https://example.com/docs/checkout'), 'Copy link copies the link without trailing punctuation');
    }
    const outsidePoint = await cellPoint(page, 20, 2);
    if (outsidePoint && !BEFORE) {
      await page.mouse.click(outsidePoint.x, outsidePoint.y, { button: 'right' });
      await page.waitForTimeout(600);
      const why = await menu.textContent().catch(() => '');
      expect(why.includes('outside every project') && await page.locator('.ux-menu-item', { hasText: 'Reveal in Finder' }).isDisabled(),
        'a path outside every managed root is not actionable, and the menu says why', why);
      await shootBox(page, page.locator('.session-main').first(), `terminal-outside-root-${theme}.png`, 0);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }

    /* ── 4 · Open in the code rail at that line ───────────────────────── */
    if (pathPoint && !BEFORE) {
      await page.mouse.click(pathPoint.x, pathPoint.y, { button: 'right' });
      await page.waitForTimeout(500);
      await page.locator('.ux-menu-item', { hasText: 'Open in the code rail' }).click().catch(() => {});
      await page.waitForTimeout(1500);
      const jumped = page.locator('.code-inspector-line.ux-jump');
      expect(await jumped.count() === 1 && await jumped.getAttribute('data-line') === '42',
        'the code reader opens on the file with line 42 marked');
      const reader = page.locator('.code-reader').first();
      if (await reader.count()) await shootBox(page, reader, `code-reader-line-${theme}.png`, 0);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    /* ── 5 · the code rail's pop-out ──────────────────────────────────── */
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    if (await page.locator('.term-split').count() === 0) {
      await page.locator('.session-side-panel-toggle').first().click().catch(() => {});
      await page.waitForTimeout(800);
    }
    const codeHead = page.locator('.session-detail-reader .code-head').first();
    check(await codeHead.count() === 1, 'the side panel rendered its Code / Timeline / Learning bar');
    expect(await page.locator('.ux-popout', { hasText: 'Open in new window' }).count() === 1, 'the code rail offers Open in new window');
    if (await page.locator('.ux-popout').count()) {
      await page.locator('.ux-popout').click();
      await page.waitForTimeout(300);
      expect((await page.locator('.session-detail-reader .ux-flash').textContent().catch(() => '')).includes('own window'), 'opening it says so');
    }
    await shootBox(page, page.locator('.session-detail-reader').first(), `code-rail-popout-${theme}.png`, 0);

    /* ── 6 · the status bar's copy menu ───────────────────────────────── */
    const copyBtn = page.locator('.ux-status-copy').first();
    expect(await copyBtn.count() === 1, 'the status bar has a copy menu');
    if (BEFORE) await shootBox(page, page.locator('.session-main').first(), `status-copy-menu-${theme}.png`, 0);
    if (await copyBtn.count()) {
      await copyBtn.click();
      await page.waitForTimeout(500);
      const copyMenu = page.locator('.ux-menu[aria-label="Copy from this session"]');
      expect(await copyMenu.count() === 1 && (await copyMenu.textContent()).includes('Copy last response')
        && (await copyMenu.textContent()).includes('Copy conversation ID'), 'it offers Copy last response and Copy conversation ID');
      await shootBox(page, page.locator('.session-main').first(), `status-copy-menu-${theme}.png`, 0);
      await page.locator('.ux-menu-item', { hasText: 'Copy last response' }).click().catch(() => {});
      await page.waitForTimeout(400);
      expect((await page.locator('.announce-region').textContent()).includes('Copied the last response'),
        'copying says what was copied and where it was read from');
    }
    check(await page.locator('.statusbar').first().count() === 1, 'the status bar rendered');

    /* ── 7 · side questions: Claude /btw, Codex /side ─────────────────── */
    const sideBtn = page.locator('.composer-side').first();
    expect(await sideBtn.count() === 1, 'a Claude Code session’s composer offers Side question…');
    if (BEFORE) await shootBox(page, page.locator('.session-dock').first(), `side-question-claude-${theme}.png`, 0);
    if (await sideBtn.count()) {
      await sideBtn.click();
      await page.waitForTimeout(500);
      const panel = page.locator('#composer-side-question');
      expect((await panel.textContent()).includes("Claude answers from the session's context without adding it to the conversation (Claude Code /btw).")
        && await panel.locator('input[aria-label="Side question for the agent"]').count() === 1,
      'the side question carries its label and a single-line question field');
      await panel.locator('input').fill('What does roundTotal return for negative totals?');
      await page.waitForTimeout(200);
      await shootBox(page, page.locator('.session-dock').first(), `side-question-claude-${theme}.png`, 0);
    }
    check(await page.locator('.composer').count() === 1, 'the composer rendered');
    await page.locator('.session-item', { hasText: 'Release notes' }).first().click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    const codexSide = page.locator('.composer-side').first();
    if (await codexSide.count() && !BEFORE) {
      await codexSide.click();
      await page.waitForTimeout(400);
      const codexPanel = page.locator('#composer-side-question');
      expect((await codexPanel.textContent()).includes('Codex /side') && await codexPanel.locator('input').count() === 0
        && await codexPanel.locator('button', { hasText: 'Open /side' }).count() === 1,
      'a Codex session offers /side alone, with no question field, and says the question is asked in the fork');
      await shootBox(page, page.locator('.session-dock').first(), `side-question-codex-${theme}.png`, 0);
    }

    /* ── 8 · Fleet: tags on the roster and a tag filter ──────────────── */
    await toView(page, 'Meta+2');
    await page.waitForTimeout(1200);
    const roster = page.locator('.fleet-roster').first();
    check(await roster.count() === 1, 'Fleet rendered its roster');
    expect(await roster.locator('.ux-tag').count() >= 4, 'Fleet roster entries wear their tags');
    const fleetFilter = page.locator('.ux-tag-filter[aria-label="Filter sessions by tag"] .chip', { hasText: 'docs' }).first();
    if (await fleetFilter.count()) {
      await fleetFilter.click();
      await page.waitForTimeout(500);
      expect(await roster.locator('.fleet-entry').count() === 1, 'the Fleet tag filter narrows the roster');
      await shootBox(page, page.locator('.fleet-toolbar').first().locator('xpath=..'), `fleet-tags-${theme}.png`, 0);
      await fleetFilter.click();
      await page.waitForTimeout(300);
    } else {
      expect(false, 'the Fleet tag filter exists');
      await shootBox(page, roster, `fleet-tags-${theme}.png`, 0);
    }

    /* ── 9 · shortcut search in the palette ──────────────────────────── */
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(500);
    const palette = page.locator('.command-palette');
    check(await palette.count() === 1, 'the command palette opened');
    await page.locator('.command-palette input.field').first().fill('?');
    await page.waitForTimeout(500);
    const groups = await page.evaluate(() => [...document.querySelectorAll('.command-group-label')].map((e) => e.textContent.trim()));
    expect(groups.length === 1 && groups[0].startsWith('Shortcuts') && Number(groups[0].split('·')[1]) > 25,
      'typing ? narrows the palette to the Shortcuts group, listing every binding', groups);
    await shootBox(page, palette, `palette-shortcuts-${theme}.png`, 0);
    await page.locator('.command-palette input.field').first().fill('shortcut quote');
    await page.waitForTimeout(400);
    const quoteRows = await page.locator('.command-item').allTextContents();
    expect(quoteRows.length === 1 && quoteRows[0].includes('⌘>'), '"shortcut quote" finds the quote chord and prints it', quoteRows);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (!BEFORE) {
      // Running a row presses its chord where it works: ⌘B from Fleet goes to
      // Sessions and toggles the side panel, exactly as the key would.
      await toView(page, 'Meta+1');
      const splitBefore = await page.locator('.term-split').count();
      await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
      await page.keyboard.press('Meta+k');
      await page.waitForTimeout(400);
      await page.locator('.command-palette input.field').first().fill('? side panel');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      const splitAfter = await page.locator('.term-split').count();
      expect(splitBefore !== splitAfter, 'running a shortcut from the palette does what its chord does', { splitBefore, splitAfter });
    }

    /* ── 10 · the transcript reader: Markdown, quote, mermaid ─────────── */
    await page.evaluate(() => document.querySelector('.hdr-toggle')?.focus());
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(400);
    await page.locator('.command-palette input.field').first().fill('order');
    await page.waitForTimeout(900);
    const hit = page.locator('.command-item', { hasText: 'storefront — you' }).first();
    if (await hit.count()) { await hit.click(); await page.waitForTimeout(1500); }
    const reader = page.locator('.set-reader').first();
    check(await reader.count() === 1, 'the transcript reader opened from a palette hit');
    expect(await reader.locator('.ux-mermaid-title', { hasText: 'Mermaid diagram (source)' }).count() === 1
      && (await reader.textContent()).includes('Rendering is not available'),
    'a mermaid block is shown as labelled source with a note that rendering is not available');
    expect(await reader.locator('button', { hasText: 'Copy as Markdown' }).count() === 1, 'the reader offers Copy as Markdown');
    if (await reader.count()) {
      await reader.scrollIntoViewIfNeeded();
      await shootBox(page, reader, `transcript-reader-${theme}.png`, 0);
    }
    if (!BEFORE && await reader.count()) {
      await reader.locator('button', { hasText: 'Copy as Markdown' }).click();
      await page.waitForTimeout(400);
      expect((await page.locator('.announce-region').textContent()).includes('as Markdown'), 'Copy as Markdown reports turns, size and redaction');
      await page.evaluate(() => {
        const pre = [...document.querySelectorAll('.set-reader .set-turn pre')].find((p) => p.textContent.includes('rounding happens'));
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.querySelector('.hdr-toggle')?.focus();
      });
      await page.waitForTimeout(200);
      await page.keyboard.press('Meta+>');
      await page.waitForTimeout(600);
      const said = await page.locator('.announce-region').textContent();
      expect(said.includes('Quoted the transcript into “Invoice rounding”'), '⌘> quotes a transcript selection into the session that continues it', said);
    }
  } finally {
    await close();
  }

  /* ── 11 · the code rail window itself ───────────────────────────────── */
  if (!BEFORE) {
    const { page: railPage, close: closeRail } = await openRenderer({ theme, width: 1100, height: 780, onError, instrument: INSTRUMENT });
    try {
      await railPage.goto(`${rendererURL}?view=code-rail&session=s2`);
      await railPage.waitForTimeout(1800);
      await setTheme(railPage, theme);
      const railView = railPage.locator('.ux-rail-window');
      expect(await railView.count() === 1 && (await railView.textContent()).includes('Code · Invoice rounding')
        && await railPage.locator('.code-panel').count() === 1 && await railPage.locator('.app-header, .sessions-view').count() === 0,
      'the code rail window renders the rail alone, named for its session, with no shell around it');
      await railPage.screenshot({ path: path.join(OUT, `code-rail-window-${theme}.png`) });
    } finally {
      await closeRail();
    }
  }
}

check(errors.length === 0, 'no page errors while driving the views', errors.slice(0, 5));
writeFileSync(path.join(OUT, 'verification.json'), `${JSON.stringify({
  generator: 'scripts/probe-helper-p6-ux.mjs', mode: BEFORE ? 'before' : 'after',
  renderer: 'out/renderer served over http with the preload bridge stubbed', at: new Date().toISOString(), results,
}, null, 2)}\n`);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
