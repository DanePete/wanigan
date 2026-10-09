#!/usr/bin/env node
// Use every control in Wanigan. Each surface (a view, a session, a drawer, a
// dialog, an overlay) gets its own freshly seeded demo core, so what one
// archives or stops never changes another. On each, every control is found and
// used: a button clicked, a field typed in, a dropdown opened and a choice
// made, a box ticked, a link followed. Then the surface is put back and the
// next control is found afresh; what a click reveals (a confirm step, a form)
// is used in turn. Every documented shortcut is pressed where it applies.
//
// A control fails when it throws, logs an error, has a call to the core
// refused, crashes a view, shows an error, or visibly does nothing (unless it
// is disabled and says why). Nothing that would leave the machine is used:
// the demo refuses those and must say so. Report: .artifacts/crawl/report.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { SHORTCUTS } from '../src/shared/shortcuts.ts';
import { PROJECT_VIEWS } from '../src/shared/views.ts';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { compareStub } from './ui-compare-stub.mjs';
import { pageHelpers } from './ui-crawl-page.mjs';
import { LIVE_STUB } from './ui-goto-stub.mjs';
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';
import { crawlTarget } from './ui-crawl-target.mjs';
import { qualifyStoppedResize } from './ui-crawl-refusals.ts';

const out = join(root, '.artifacts', 'crawl');
mkdirSync(out, { recursive: true });
const WORKERS = Math.max(1, Number(process.env.CRAWL_WORKERS ?? 4));
/** Crawl only the surfaces whose name matches (for working on one). */
const ONLY = process.env.CRAWL_ONLY ? new RegExp(process.env.CRAWL_ONLY, 'i') : null;
/** What goes in a text field: harmless if a shell session ever runs it. */
const TYPED = 'echo wanigan-crawl';
/** How many clicks deep a revealed control may be (Stop › Stop it). */
const MAX_DEPTH = 2;
const MAX_PER_SURFACE = 300;

/** What the demo refuses because it would leave the machine. It must say so on screen. */
const DEMO_REFUSES = [
  { method: 'accounts.signIn', message: /^The demo signs nothing in\./ },
  { method: 'mcp.terminal', message: /^The demo opens no terminal in your home\./ },
  { method: 'phone.enable', message: /^The demo serves nothing to phones\./ },
];

/** The real-world step itself, never used: what the crawler checks instead. */
const GUARDED = [{
  surface: /^Pull request/, label: /^Push and open$/,
  // The demo's stand-in gh opens nothing, but the push is real git: confirm it goes nowhere.
  check: async (page) => {
    const remote = await page.textContent('.pr-confirm .mono:nth-of-type(2)').catch(() => '');
    return /^\//.test(remote ?? '') && /origin\.git$/.test(remote ?? '')
      ? `not pushed: in the demo origin is ${remote.replace(/^.*\/(demo\/origin\.git)$/, '…/$1')}, a local bare repository, and gh is a stand-in`
      : null;
  },
}];

/**
 * Justified exceptions, each with its reason. A problem matching one is
 * reported, but does not fail the crawl. Keep this short.
 */
const ALLOW = [
  {
    surface: /^Running/, label: /^Typing into .+\. Escape to stop\.$/, problem: /^did nothing visible$/,
    reason: 'a tile that already has the keys keeps them when clicked again; Escape gives them back (the sweep checks that)',
  },
  {
    surface: /›.*(History|reader)/, label: /^Read Free shipping banner threshold$/, problem: /record of this conversation is gone/,
    reason: 'the demo seeds a Codex conversation whose record Codex no longer keeps; the reader says so in place',
  },
  {
    surface: /^MCP/, label: /^Add…$/, problem: /^showed an error: A server called .+ is already there\.$/,
    reason: 'the store offers a server already added; its plan says so and Add stays off, before anything runs',
  },
  {
    surface: /^Card drawer/, label: /^(Merge|Remove branch)$/, problem: /(uncommitted changes|has commits that are not in main)/,
    reason: 'the core will not merge into a folder with uncommitted work, or delete a branch whose commits are not merged, and says why; the demo’s Northstar has uncommitted work on purpose',
  },
  {
    surface: /› Changes › Branches$/, label: /^Name of the new branch$/, problem: /^showed an error: “echo wanigan-crawl” contains a space or a control character, which a git ref cannot\.$/,
    reason: 'the crawler types words with a space; the field says at once why git refuses that name, and Make the branch stays off',
  },
  {
    surface: /^Open a project$/, label: /^Open project$/, problem: /Give the full path to the project folder/,
    reason: 'the crawler types words, not a folder; the dialog says what a path needs (it never opens a real folder as a project)',
  },
];

/** Controls that change a lot go last on their surface, so the rest are found as seeded. */
const DESTRUCTIVE = /^(stop it|archive|withdraw|remove|close project|take back|merge|approve|send back|reopen|accept|dismiss|forget|undo turn|redo turn|pause project|resume|continue|make default|add and sign in|create card|leave the demo|abort|mark resolved|take (ours|theirs)|keep (ours|theirs|our|their|it|the markers)|delete|discard|drop|pop|apply|push|commit|complete the|stash|switch|stage all|unstage all)/i;

/* ── in the page ──────────────────────────────────────────────────────────── */

/** Installed before the app loads: records calls, refusals and what leaves the page; finds controls. */

/* ── surfaces ─────────────────────────────────────────────────────────────── */

const click = (selector) => async (page) => { await page.click(selector, { timeout: 8000 }); };
const press = (...keys) => async (page) => { for (const k of keys) await page.keyboard.press(k); };

/** Every surface, from what the demo holds (read once from a seeded core). */
function plan(w) {
  const ns = w.projects.find((p) => p.name.startsWith('Northstar'));
  const board = `#/p/${ns.key}/board`;
  const session = (title) => w.sessions.find((s) => s.title === title)?.ref;
  const shell = w.sessions.find((s) => s.provider === 'shell' && s.live && !s.cardKey)?.ref;
  const stock = session('Low-stock badge on product cards');
  // A drawer for a card in each column of each project, and the branch and pull request ones.
  const drawers = [];
  for (const p of w.projects) {
    for (const column of ['inbox', 'ready', 'working', 'review', 'done']) {
      const card = w.cards.find((c) => c.projectKey === p.key && c.status === column);
      if (card) drawers.push(card);
    }
  }
  for (const c of w.cards) if (c.worktree && !drawers.includes(c)) drawers.push(c);
  return [
    { name: 'Rail', hash: '#/needs', scope: 'nav.rail' },
    { name: 'Demo banner and chat button', hash: board, scope: '.demo-banner, .chat-fab' },
    { name: 'Needs you', hash: '#/needs', ready: '.needs-headline' },
    { name: 'Running › List', hash: '#/running', storage: { 'wanigan.running.layout': 'list' }, ready: '.srow' },
    { name: 'Running › Watch', hash: '#/running', storage: { 'wanigan.running.layout': 'watch' }, ready: '.watch-tile .xterm-rows' },
    ...w.projects.flatMap((p) => PROJECT_VIEWS.map((v) => ({
      name: `${p.name} › ${v.label}`, hash: `#/p/${p.key}/${v.view}`,
      // The project's own bar (its tabs, Pause, settings) is crawled once, with the board.
      scope: v.view === 'board' ? 'main .view' : 'main .view-body',
    }))),
    // The git workbench's other tabs, a card's own checkout, the merge stopped in NS-13's, and Push.
    { name: `${ns.name} › Changes › Commits`, hash: `#/p/${ns.key}/changes/commits`, scope: 'main .view-body', ready: '.commit-row' },
    { name: `${ns.name} › Changes › Branches`, hash: `#/p/${ns.key}/changes/branches`, scope: 'main .view-body', ready: '.branch-row' },
    { name: `${ns.name} › Changes › Stashes`, hash: `#/p/${ns.key}/changes/stashes`, scope: 'main .view-body', ready: '.stash-diffs .dl-add' },
    { name: `${ns.name} › Changes › ${ns.key}-3’s branch`, hash: `#/p/${ns.key}/changes?branch=${ns.key}-3`, scope: 'main .view-body', ready: '.pr-chip' },
    { name: `${ns.name} › Changes › ${ns.key}-13’s merge`, hash: `#/p/${ns.key}/changes?branch=${ns.key}-13`, scope: 'main .view-body', ready: '.resolver-hunk' },
    { name: 'Push', hash: `#/p/${ns.key}/changes`, open: click('.remote-actions button:has-text("Push")'), scope: '.dialog', ready: '.dialog .push-commits li' },
    ...w.sessions.map((s) => ({ name: `Session › ${s.title}${s.live ? '' : ' (ended)'}`, session: s.ref, ready: 'main .session .xterm-rows' })),
    { name: 'Accounts', hash: '#/accounts', ready: '.account' },
    { name: 'Settings', hash: '#/settings', ready: '#set-general' },
    { name: 'Skills', hash: '#/skills', ready: '.lib-row' },
    { name: 'MCP servers', hash: '#/mcp', ready: '.mcp-row' },
    { name: 'MCP store', hash: '#/mcp', open: click('.topbar-tools [role="radio"]:has-text("Store")'), ready: '.store-card' },
    { name: 'Search and commands', hash: board, open: press('Meta+k'), scope: '.palette' },
    { name: 'Keyboard shortcuts', hash: board, open: press('Shift+Slash'), scope: '.dialog', ready: '.shortcuts' },
    { name: 'How this works', hash: board, open: click('.how-btn'), scope: '.dialog', ready: '.how-flow' },
    { name: 'Saved views', hash: board, open: click('.views-trigger'), scope: '.views-panel', ready: '.views-panel .views-row' },
    { name: 'Talk to Wanigan', hash: board, open: click('.chat-fab'), scope: '.chat' },
    { name: 'Play with Wanigan', hash: '#/needs', open: click('.needs-orb .play-button'), scope: '.play-panel' },
    ...drawers.map((c) => ({
      name: `Card drawer › ${c.key} (${c.status}${c.worktree ? ', own branch' : ''})`,
      hash: `#/p/${c.projectKey}/board?card=${c.key}`, scope: '.drawer', ready: '.drawer .stages',
    })),
    { name: 'New card', hash: board, open: press('c'), scope: '.dialog' },
    { name: 'New session', hash: board, open: press('Meta+t'), scope: '.dialog', ready: '.dialog .model-row' },
    { name: 'Open a project', hash: board, open: click('.rail-add'), scope: '.dialog', ready: '.dialog .agent-folders li' },
    { name: 'Project settings', hash: board, open: click('.topbar-tools button[aria-label$=" settings"]'), scope: '.dialog' },
    { name: 'Pause a project', hash: board, open: click('.topbar-tools button:has-text("Pause")'), scope: '.dialog', ready: '.dialog .plain-list' },
    { name: 'Make a session a card', session: shell, open: click('.topbar-tools button:has-text("Make this a card")'), scope: '.dialog' },
    { name: 'Undo a turn', session: stock, open: click('.turn-change button:has-text("Undo this turn")'), scope: '.dialog', ready: '.dialog .undo-files li' },
    { name: 'A turn’s changes', session: stock, open: click('.turn-change .turn-diff'), scope: '.turn-panel', ready: '.turn-panel .dl-add' },
    { name: 'Pull request', hash: `${board}?card=${ns.key}-10`, open: click('.drawer button:has-text("Open a pull request")'), scope: '.drawer .pr-confirm' },
    { name: 'History › reader', hash: `#/p/${ns.key}/history`, open: click('.hrow .hrow-actions button:has-text("Read")'), scope: '.reader', ready: '.reader .turn' },
    { name: 'History › resume', hash: `#/p/${ns.key}/history`, open: click('.hrow:has-text("Expired coupon codes") button:has-text("Resume")'), scope: '.dialog', ready: '.dialog .choose-accounts' },
    { name: 'Skills › copy', hash: '#/skills', open: click('.lib-actions button:has-text("Copy to a project")'), scope: '.dialog', ready: '.dialog .plan-files li' },
    { name: 'MCP › add', hash: '#/mcp', open: async (page) => { await click('.topbar-tools [role="radio"]:has-text("Store")')(page); await click('.store-card:has-text("GitHub") button')(page); }, scope: '.dialog', ready: '.dialog .plan-command' },
    { name: 'Accounts › add', hash: '#/accounts', open: click('.account-group-head button:has-text("Add account")'), scope: '.dialog' },
    { name: 'Accounts › sign in', hash: '#/accounts', open: click('.account-actions button:has-text("Sign in")'), scope: '.dialog', ready: '.dialog .error-text' },
  ].map((s) => ({ scope: 'main .view', ...s }));
}

/** What a seeded core holds, named the same way in every seeding (ids differ; keys and titles do not). */
async function readWorld(page) {
  const w = await page.evaluate(async () => {
    const call = (m, p) => window.wanigan.call(m, p);
    const projects = await call('projects.list', {});
    const keyOf = new Map(projects.map((p) => [p.id, p.key]));
    const sessions = (await call('sessions.list', {})).sort((a, b) => a.startedAt - b.startedAt);
    const cards = [];
    for (const p of projects) for (const c of await call('cards.list', { projectId: p.id })) cards.push({ key: c.key, status: c.status, projectKey: p.key, worktree: !!c.worktree });
    return {
      projects: projects.map((p) => ({ key: p.key, name: p.name })),
      sessions: sessions.map((s) => ({ id: s.id, projectKey: keyOf.get(s.projectId), title: s.title, live: s.endedAt === null, provider: s.provider, cardKey: s.cardKey })),
      cards,
    };
  });
  const seen = new Map();
  for (const s of w.sessions) {
    const k = `${s.projectKey}/${s.title}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    s.ref = `${k}/${seen.get(k)}`;
  }
  return w;
}

/* ── crawling one surface ─────────────────────────────────────────────────── */

/** Each surface's own demo core; all of them go when the crawl does, however it ends. */
const gateways = new Set();
process.on('exit', () => { for (const g of gateways) g.kill('SIGTERM'); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
async function seeded(label, phase = 'initial') {
  const g = await startGateway({ demo: true, quiet: !process.env.CRAWL_VERBOSE, label, phase });
  gateways.add(g.gateway);
  g.gateway.on('exit', () => gateways.delete(g.gateway));
  return g;
}

const firstLine = (s) => String(s ?? '').split('\n')[0].slice(0, 240);
/** Why Playwright could not click, from its call log: what covered the control, or what it waited for. */
const whyNot = (e) => {
  const lines = String(e?.message ?? e).split('\n').map((l) => l.trim().replace(/^- /, ''));
  const covered = lines.filter((l) => /intercepts pointer events/.test(l)).pop();
  const waiting = lines.filter((l) => /^element is (not|outside)/.test(l)).pop();
  return [firstLine(e?.message ?? e), covered ?? waiting].filter(Boolean).join(': ');
};

function startupFailure(error, surface) {
  if (!error?.gatewayStartup) throw error;
  return { surface, kind: 'surface', label: 'opening it', path: [], action: 'started its demo core', effects: [],
    problems: [error.message], result: 'fail', note: '', startup: error.gatewayStartup };
}

/** A page on the core at `base`; `standIns` are init scripts that play what the browser lacks (the live view). */
async function openPage(browser, base, standIns = []) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await context.addInitScript(BRIDGE);
  await context.addInitScript(`(${pageHelpers})();`);
  for (const s of standIns) await context.addInitScript(s);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${firstLine(e.message)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${firstLine(m.text())}`); });
  await page.goto(`${base}#/needs`);
  await page.waitForSelector('.rail-projects a', { timeout: 20_000 });
  return { context, page, errors };
}

const settle = (page, min = 250) => page.evaluate((m) => window.__crawl.settled(m), min);

function verdict(rec) {
  const allowed = [];
  rec.problems = rec.problems.filter((p) => {
    const a = ALLOW.find((x) => (!x.surface || x.surface.test(rec.surface)) && x.label.test(rec.label) && x.problem.test(p));
    if (a) allowed.push(`${p} (allowed: ${a.reason})`);
    return !a;
  });
  rec.allowed = allowed;
  if (rec.problems.length) rec.result = 'fail';
  else if (allowed.length) rec.result = 'allowed';
  return rec;
}

/** What changed between two observations, in words. */
function effectsOf(before, after, log) {
  const e = [];
  if (after.hash !== before.hash) e.push(`went to ${after.hash || '#/'}`);
  if (after.modals > before.modals) e.push('opened a dialog or list');
  if (after.modals < before.modals) e.push('closed a dialog or list');
  const calls = [...new Set(log.calls.slice(before.calls))];
  if (calls.length) e.push(`called ${calls.join(', ')}`);
  for (const b of new Set(log.bridge.slice(before.bridge))) e.push(b);
  if (after.storage !== before.storage) e.push('remembered a choice');
  if (after.focus && after.focus !== before.focus) e.push(`moved focus to ${after.focus.slice(0, 60)}`);
  if (after.snap !== before.snap && !e.some((x) => /^(went to|opened|closed)/.test(x))) e.push('changed the page');
  // A restarted animation or a repeated cue leaves the page as it was, but it moved.
  else if (!e.length && after.mutations > before.mutations) e.push('moved something on the page');
  return e;
}

/** Errors that arrived during an action, refusals the demo is meant to make aside. */
async function problemsOf(before, after, log, errors, errorsAt, rec, page) {
  const problems = [];
  rec.refusals = log.rejected.slice(before.rejected);
  for (const r of rec.refusals) {
    const qualified = await qualifyStoppedResize(r, { kind: rec.kind, label: rec.label, firstCall: before.calls }, log.stopped ?? [],
      id => page.evaluate(async sessionId => (await window.wanigan.call('sessions.get', { id: sessionId })).session, id));
    if (qualified) {
      (rec.resizeQualifications ??= []).push({ refusal: r, ...qualified });
      rec.note = [rec.note, qualified.reason].filter(Boolean).join('; ');
      continue;
    }
    const demo = DEMO_REFUSES.find((d) => d.method === r.method && d.message.test(r.message));
    if (!demo) { problems.push(`the core refused ${r.method}: ${firstLine(r.message)}`); continue; }
    if (after.errors.includes(firstLine(r.message).replace(/\s+/g, ' ')) || after.errors.some((t) => t.includes(r.message.slice(0, 40)))) rec.note = `the demo refuses it, and says so: “${firstLine(r.message)}”`;
    else problems.push(`the demo refused ${r.method}, but the window does not say so`);
  }
  for (const c of after.crashes) if (!before.crashes.includes(c)) problems.push(`crashed: ${c}`);
  const was = new Set(before.errors);
  for (const t of after.errors) {
    if (was.has(t) || DEMO_REFUSES.some((d) => d.message.test(t))) continue;
    problems.push(`showed an error: ${t.slice(0, 200)}`);
  }
  problems.unshift(...errors.slice(errorsAt));
  return problems;
}

/**
 * Crawl one surface on its own seeded core. With `retry`, use only those
 * controls: the ones an earlier action on the first pass took away.
 */
async function crawlSurface(browser, surface, world0, retry = null) {
  const started = Date.now();
  const records = [];
  let context, gateway;
  try {
    const startedGateway = await seeded(surface.name, retry ? `recovery ${retry[0].kind}: ${retry[0].label}` : 'initial');
    gateway = startedGateway.gateway;
    const opened = await openPage(browser, startedGateway.base);
    context = opened.context;
    const { page, errors } = opened;
    const world = await readWorld(page);
    const s = { ...surface };
    if (s.session) {
      const target = world.sessions.find((x) => x.ref === s.session);
      s.hash = target ? `#/p/${target.projectKey}/s/${target.id}` : null;
    }
    if (!s.hash) throw new Error(`the demo has no ${s.session ?? 'such place'} (seeded ${world0.sessions.length} sessions before)`);
    const log = () => page.evaluate(() => ({ calls: window.__crawl.calls, rejected: window.__crawl.rejected, stopped: window.__crawl.stopped, bridge: window.__crawl.bridge }));

    let initialStorage = s.storage ?? {};
    const fresh = async () => {
      await page.evaluate(({ hash, storage }) => {
        try { localStorage.clear(); for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v); } catch { /* none */ }
        location.hash = hash;
      }, { hash: s.hash, storage: initialStorage });
      await page.reload();
      await page.waitForSelector('.rail-projects a', { timeout: 20_000 });
      await settle(page, 100);
      if (s.open) await s.open(page);
      await page.waitForSelector(s.ready ?? s.scope, { timeout: 10_000 });
      await settle(page);
    };
    const state = () => page.evaluate((scope) => window.__crawl.state(scope), s.scope);
    const items = () => page.evaluate((scope) => window.__crawl.items(scope), s.scope);
    let marked = '';
    const mark = (item) => { marked = item.sig; return page.evaluate(([scope, x]) => window.__crawl.mark(scope, x), [s.scope, item]); };
    const target = () => crawlTarget(page, s.scope, marked);

    await fresh();
    initialStorage = await page.evaluate(() => { try { return Object.fromEntries(Object.entries(localStorage)); } catch { return {}; } });
    const clean = await state();
    const errorsBefore = errors.length;
    if (errorsBefore) records.push(verdict({ surface: s.name, kind: 'surface', label: 'opening it', path: [], action: 'opened', effects: [], problems: errors.slice(0), result: 'pass', note: '' }));

    /** Do what a control is for; return what was done, in words. */
    const act = async (item, d) => {
      const t = target();
      switch (item.kind) {
        case 'text': {
          await t.click({ timeout: 3000 });
          await page.keyboard.press('ControlOrMeta+a');
          // Something other than what is there, so taking it shows.
          const typed = d.value === TYPED ? `${TYPED} again` : TYPED;
          await page.keyboard.type(typed);
          return `typed “${typed}”`;
        }
        case 'select': {
          await t.click({ timeout: 3000 });
          const list = await page.waitForSelector('.sel-list', { timeout: 2000 }).catch(() => null);
          if (!list) return 'clicked; no list opened';
          const choice = page.locator('.sel-list [role="option"][aria-selected="false"]:not([aria-disabled="true"])').first();
          if (!(await choice.count())) { await page.keyboard.press('Escape'); return 'opened; it has one choice'; }
          const label = (await choice.locator('.sel-text > span').first().textContent())?.trim();
          await choice.click({ timeout: 3000 });
          item.choice = label;
          return `opened, chose “${label}”`;
        }
        case 'native-select': {
          const values = await t.evaluate((el) => [...el.options].filter((o) => !o.selected && !o.disabled).map((o) => o.value));
          if (!values.length) return 'it has one choice';
          await t.selectOption(values[0]);
          return `chose “${values[0]}”`;
        }
        case 'link': {
          if (d.href && !d.href.startsWith('#')) return 'external';
          await t.click({ timeout: 3000 });
          return 'followed';
        }
        default:
          await t.click({ timeout: 3000 });
          return 'clicked';
      }
    };
    /** Do a step of a path again, to reach what it revealed. */
    const replay = async (step) => {
      let d = await mark(step);
      if (!d) return false;
      if (d.disabled && (await page.evaluate((x) => window.__crawl.prime(x), TYPED))) await settle(page);
      if (step.kind === 'text') { await target().click({ timeout: 3000 }); await page.keyboard.type(TYPED); }
      else if (step.kind === 'select' && step.choice) {
        await target().click({ timeout: 3000 });
        await page.locator('.sel-list [role="option"]', { hasText: step.choice }).first().click({ timeout: 3000 });
      } else await target().click({ timeout: 3000 });
      await settle(page);
      return true;
    };

    const first = (await items()).map((x) => ({ ...x, path: [] }));
    const queue = retry ? [...retry] : first;
    // Last what changes a lot, and just before it what is reached through such a
    // change, so a Cancel beside a Reopen is used before the Reopen.
    const later = (x) => (DESTRUCTIVE.test(x.name) ? 2 : x.path.some((step) => DESTRUCTIVE.test(step.name)) ? 1 : 0);
    queue.sort((a, b) => later(a) - later(b));
    const known = new Set([...first, ...queue].map((x) => x.sig));
    const enqueue = (x) => {
      const at = queue.findIndex((y) => later(y) > later(x));
      if (at < 0) queue.push(x); else queue.splice(at, 0, x);
    };
    /** Use one control, from the surface as opened (and the steps that reveal it). */
    const use = async (item, rec) => {
      let d = await mark(item);
      if (!d) {
        rec.result = 'unreached';
        rec.note = item.path.length ? 'what revealed it no longer does, after an earlier action here' : 'gone after an earlier action here';
        return;
      }
      if (!item.name) rec.problems.push('has no accessible name');
      const guard = GUARDED.find((g) => g.label.test(item.name) && (!g.surface || g.surface.test(s.name)));
      if (guard) {
        rec.action = 'not used';
        const said = await guard.check(page);
        if (said) { rec.result = 'guarded'; rec.note = said; } else rec.problems.push('a real-world step the demo does not stub');
        return;
      }
      if (d.disabled && !d.why && (await page.evaluate((x) => window.__crawl.prime(x), TYPED))) {
        // A submit that waits for its fields: fill them and look again.
        await settle(page);
        d = { ...d, ...(await page.evaluate(() => window.__crawl.disabled())) };
        if (!d.disabled) rec.note = 'enabled once the fields beside it were filled';
      }
      if (d.disabled) {
        rec.action = 'left alone: disabled';
        if (d.why) rec.note = `disabled: ${d.why}`;
        else rec.problems.push('disabled, and does not say why');
        return;
      }
      if (item.kind === 'link' && d.href && !d.href.startsWith('#')) {
        rec.action = 'not followed: external';
        if (!/^https:\/\//.test(d.href)) rec.problems.push(`an external link that is not https: ${d.href}`);
        else if (d.target !== '_blank' || !/noreferrer|noopener/.test(d.rel)) rec.problems.push('an external link that does not open in the browser (target=_blank, rel=noreferrer)');
        else rec.note = `opens ${d.href} in the browser`;
        return;
      }
      // Choosing what is already chosen, or following a link to where you are, rightly does nothing.
      const already = (item.kind === 'radio' && d.checked)
        || (item.kind === 'link' && d.href === (await page.evaluate(() => location.hash)))
        || (item.kind === 'button' && !!d.current);
      const before = await page.evaluate(() => window.__crawl.observe());
      const errorsAt = errors.length;
      try {
        rec.action = await act(item, d);
      } catch (e) {
        rec.action ||= 'tried to use it';
        rec.problems.push(`could not be used: ${whyNot(e)}`);
        // Keep Playwright's complete bounded action log, including whether the
        // target disappeared, moved, or was covered. A first-line timeout alone
        // cannot distinguish a broken control from a discovery race in CI.
        rec.actionLog = String(e?.message ?? e).slice(0, 12_000);
        rec.targetAtFailure = await target().count().catch(() => null);
        const file = `failure-${s.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 100)}-${records.length}.png`;
        await page.screenshot({ path: join(out, file) }).catch(() => {});
        rec.screenshot = file;
      }
      await settle(page);
      const after = await page.evaluate(() => window.__crawl.observe());
      const l = await log();
      rec.effects = effectsOf(before, after, l);
      rec.problems.push(...await problemsOf(before, after, l, errors, errorsAt, rec, page));
      if (item.kind === 'text' && !d.readOnly) {
        const value = await target().inputValue().catch(() => null);
        if (value !== null && value === d.value) rec.problems.push('did not take typing');
      }
      const oneChoice = /it has one choice$/.test(rec.action);
      if (already) rec.note ||= item.kind === 'radio' ? 'already the choice' : item.kind === 'button' ? 'already the current one' : 'already here';
      else if (!rec.effects.length && !oneChoice && !rec.problems.length) rec.problems.push('did nothing visible');

      // What it revealed on this surface is used too, after doing this again.
      if (item.path.length < MAX_DEPTH && after.hash === before.hash && item.kind !== 'link') {
        for (const x of await items()) {
          if (known.has(x.sig)) continue;
          known.add(x.sig);
          enqueue({ ...x, path: [...item.path, { sig: item.sig, kind: item.kind, name: item.name, identity: item.identity, observation: item.observation, choice: item.choice }] });
        }
      }
    };

    let dirty = false;
    let done = 0;
    /** Why the surface cannot be opened again, once an earlier action here has changed it for good. */
    let lost = null;
    while (queue.length && done++ < MAX_PER_SURFACE) {
      const item = queue.shift();
      const rec = { surface: s.name, kind: item.kind, label: item.name || '(no name)', path: item.path.map((p) => p.name), action: '', effects: [], problems: [], result: 'pass', note: '' };
      // Kept out of the report: what a second pass needs to find it again.
      Object.defineProperty(rec, 'item', { value: item });
      records.push(rec);
      const errorsAt = errors.length;
      try {
        if (lost) { rec.result = 'unreached'; rec.note = lost; continue; }
        if (dirty || item.path.length) {
          try {
            await fresh();
          } catch (e) {
            // Opened once already: what an earlier control here did (started, archived) has changed it.
            lost = `the surface could not be opened again after an earlier action here (${firstLine(e.message)})`;
            rec.result = 'unreached';
            rec.note = lost;
            continue;
          }
          // What a path revealed may be there already (a decision recorded, an answer arrived).
          if (item.path.length && !(await mark(item))) for (const step of item.path) if (!(await replay(step))) break;
          for (const e of errors.slice(errorsAt)) rec.problems.push(`on opening the surface again: ${e}`);
        }
        await use(item, rec);
      } catch (e) {
        rec.problems.push(`the crawler could not finish: ${whyNot(e)}`);
      } finally {
        verdict(rec);
      }
      // Put it back: close what opened over it; failing that, the next one reloads it.
      let now = await state().catch(() => '');
      if (now !== clean && Number(now.split('\n')[1]) > Number(clean.split('\n')[1])) {
        await page.keyboard.press('Escape').catch(() => {});
        await settle(page, 100).catch(() => {});
        now = await state().catch(() => '');
      }
      dirty = now !== clean;
    }
    if (queue.length) records.push(verdict({ surface: s.name, kind: 'surface', label: 'too many controls', path: [], action: '', effects: [], problems: [`stopped after ${MAX_PER_SURFACE}; ${queue.length} left`], result: 'pass', note: '' }));
  } catch (e) {
    if (!gateway) records.push(startupFailure(e, surface.name));
    else records.push(verdict({ surface: surface.name, kind: 'surface', label: 'opening it', path: [], action: 'tried to open it', effects: [], problems: [`could not be opened: ${firstLine(e.message)}`], result: 'pass', note: '' }));
  } finally {
    await context?.close().catch(() => {});
    gateway?.kill('SIGTERM');
  }
  return { records, ms: Date.now() - started };
}

/* ── keyboard shortcuts ───────────────────────────────────────────────────── */

const hashIs = (want) => (page) => page.waitForFunction((w) => location.hash === w, want, { timeout: 3000 });
const shows = (selector) => (page) => page.waitForSelector(selector, { timeout: 3000 });
const gone = (selector) => (page) => page.waitForSelector(selector, { state: 'detached', timeout: 3000 });
const focused = (fn, arg) => (page) => page.waitForFunction(fn, arg, { timeout: 3000 });
/** The key of the focused card, and its column. */
const focusCard = (column, index = 0) => async (page) => {
  const card = page.locator(`.column-${column} .card`).nth(index);
  await card.focus();
};
const cardIn = (column) => (page) => page.waitForFunction((c) => document.activeElement?.closest?.(`.column-${c}`) && document.activeElement.classList.contains('card'), column, { timeout: 3000 });
const nthCardFocused = (column, n) => (page) => page.waitForFunction(([c, i]) => document.activeElement === document.querySelectorAll(`.column-${c} .card`)[i], [column, n], { timeout: 3000 });

/**
 * The live view's keys need a live view, which the browser has not got: no
 * Electron view to lay over a page, and no site. A check naming one of these
 * gets a page with the sweeps' stand-in, which answers from made-up Acme pages
 * and loads none.
 */
const LIVE_STANDINS = {
  // Go to's launcher, answered by a stand-in Acme site (ui-goto-stub.mjs). It names the project it plays from the tab's storage.
  goto: {
    scripts: [LIVE_STUB, LIVE_DEFAULTS, `(() => { const id = sessionStorage.getItem('wanigan.crawl.live-project'); if (id && window.__wgLive) window.__wgLive.projectId = id; })();`],
    prepare: (page, key) => page.evaluate(async (k) => {
      sessionStorage.setItem('wanigan.crawl.live-project', (await window.wanigan.call('projects.list', {})).find((p) => p.key === k).id);
    }, key),
  },
  // Compare: Local and a hosted Live drawn on a canvas (ui-compare-stub.mjs). The core keeps the site and the environment.
  compare: {
    scripts: [compareStub, LIVE_DEFAULTS],
    prepare: (page, key) => page.evaluate(async (k) => {
      const call = (m, p) => window.wanigan.call(m, p);
      const project = (await call('projects.list', {})).find((p) => p.key === k);
      await call('live.setSite', { projectId: project.id, url: 'https://acme.ddev.site/', platform: 'drupal' });
      await call('live.setEnv', { projectId: project.id, name: 'Live', url: 'https://www.acme.example/' });
    }, key),
  },
};

/**
 * One check per key of every shortcut the sheet lists (shared/shortcuts.ts):
 * where it applies, what to press, and what must follow. The crawl fails if
 * the sheet lists a shortcut with no check here.
 */
function keyChecks(w) {
  const ns = w.projects.find((p) => p.name.startsWith('Northstar')).key;
  const board = `#/p/${ns}/board`;
  const changes = `#/p/${ns}/changes`;
  /** A file open in the code editor from Changes, the cursor in its text. */
  const editing = async (page) => {
    await page.locator('.diff-slot button:has-text("Edit")').first().click();
    await page.waitForSelector('.editor-code .cm-content', { timeout: 15_000 });
    await page.click('.editor-code .cm-content');
  };
  const shell = w.sessions.find((s) => s.provider === 'shell' && s.live);
  const inbox = w.cards.filter((c) => c.projectKey === ns && c.status === 'inbox');
  const live = `#/p/${ns}/live`;
  /** Local and Live compared, nothing ignored, the keys on the pictures: its changes are the hero, the news list and the footer. */
  const comparing = (...keys) => async (page) => {
    await page.evaluate(async (k) => {
      const call = (m, p) => window.wanigan.call(m, p);
      const project = (await call('projects.list', {})).find((p) => p.key === k);
      for (const m of (await call('live.envs', { projectId: project.id })).masks) await call('live.unmask', { projectId: project.id, id: m.id });
    }, ns);
    await page.click('.live-bar button:has-text("Compare")');
    await page.waitForSelector('.cmp-change', { timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.classList.contains('cmp-frame'), null, { timeout: 3000 });
    for (const k of keys) await page.keyboard.press(k);
  };
  const compareMode = (name) => focused((n) => document.querySelector('.cmp-bar [role="radio"][aria-checked="true"]')?.textContent === n, name);
  const showing = (side) => focused((s) => document.querySelector('.cmp-flip')?.textContent.includes(`Showing ${s}`), side);
  const atChange = (i) => focused((n) => [...document.querySelectorAll('.cmp-change')].findIndex((e) => e.getAttribute('aria-current') === 'true') === n, i);
  /** Both pages taken again at this width. */
  const takenAt = (px) => focused((w) => { const s = window.__wgLive.shots.slice(-2); return s.length === 2 && s.every((r) => r.width === w); }, px);
  const atWidth = (key, px) => async (page) => { await page.keyboard.press(key); await takenAt(px)(page); await page.waitForSelector('.cmp-change', { timeout: 10_000 }); };
  const checks = {
    'Search and commands': [{ at: board, keys: ['Meta+k'], expect: shows('.palette') }],
    'New session': [{ at: board, keys: ['Meta+t'], expect: shows('.dialog h2:text-is("New session")') }],
    'New card': [{ at: board, keys: ['c'], expect: shows('.dialog h2:text-is("New card")') }],
    'History of the open project': [{ at: board, keys: ['Meta+Shift+t'], expect: hashIs(`#/p/${ns}/history`) }],
    'Keyboard shortcuts': [{ at: board, keys: ['Meta+Slash'], expect: shows('.shortcuts') }, { at: board, keys: ['Shift+Slash'], expect: shows('.shortcuts') }],
    Settings: [{ at: board, keys: ['Meta+Comma'], expect: hashIs('#/settings') }],
    'Collapse or expand the sidebar': [{ at: board, keys: ['Meta+Backslash'], expect: shows('.rail.collapsed') }],
    'Close the open card': [{ at: `${board}?card=${ns}-1`, ready: '.drawer .stages', keys: ['Escape'], expect: gone('.drawer') }],
    'Needs you': [{ at: board, keys: ['g', 'n'], expect: hashIs('#/needs') }],
    Running: [{ at: board, keys: ['g', 'r'], expect: hashIs('#/running') }],
    ...Object.fromEntries(PROJECT_VIEWS.map((v) => [`${v.label} of the open project`, [{
      at: `#/p/${ns}/${v.view === 'board' ? 'list' : 'board'}`, keys: ['g', v.key], expect: hashIs(`#/p/${ns}/${v.view}`),
    }]])),
    'Your first nine projects, in order': w.projects.slice(0, 9).map((p, i) => ({ at: '#/needs', keys: [`Meta+${i + 1}`], expect: hashIs(`#/p/${p.key}/board`) })),
    'Next card down': [
      { at: board, setup: focusCard('inbox', 0), keys: ['j'], expect: nthCardFocused('inbox', 1) },
      { at: board, setup: focusCard('inbox', 0), keys: ['ArrowDown'], expect: nthCardFocused('inbox', 1) },
    ],
    'Next card up': [
      { at: board, setup: focusCard('inbox', 1), keys: ['k'], expect: nthCardFocused('inbox', 0) },
      { at: board, setup: focusCard('inbox', 1), keys: ['ArrowUp'], expect: nthCardFocused('inbox', 0) },
    ],
    'Next column right': [
      { at: board, setup: focusCard('inbox'), keys: ['l'], expect: cardIn('ready') },
      { at: board, setup: focusCard('inbox'), keys: ['ArrowRight'], expect: cardIn('ready') },
    ],
    'Next column left': [
      { at: board, setup: focusCard('ready'), keys: ['h'], expect: cardIn('inbox') },
      { at: board, setup: focusCard('ready'), keys: ['ArrowLeft'], expect: cardIn('inbox') },
    ],
    'Open the card': [{ at: board, setup: focusCard('ready'), keys: ['Enter'], expect: shows('.drawer .stages') }],
    'Next file': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', setup: click('.changes-files li:first-child button'), keys: ['j'], expect: shows('.changes-files li:nth-child(2) [aria-current="true"]') }],
    'Previous file': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', setup: click('.changes-files li:nth-child(2) button'), keys: ['k'], expect: shows('.changes-files li:first-child [aria-current="true"]') }],
    'Mark the file viewed, or not': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', setup: click('.changes-files li:first-child button'), keys: ['v'], expect: shows('.changes-files li.git-file.viewed') }],
    // The workbench: staging, committing, and git from anywhere in it. Pull is tried in NS-3's own
    // checkout, where no agent works; in the project folder the agents at work hold it back.
    'Stage the file, or unstage it': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', setup: click('.git-group-staged li:first-child button'), keys: ['s'],
      expect: focused(() => document.querySelectorAll('.git-group-staged .git-file').length === 2) }],
    'Commit (in the message box)': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', setup: async (page) => { await page.click('.commit-subject input'); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('Made by the crawler'); }, keys: ['Meta+Enter'],
      expect: shows('.dialog h2:text-is("Commit while an agent is working here?")') }],
    'Push the branch (shows what goes first)': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', keys: ['Meta+Alt+p'], expect: shows('.dialog .push-commits li') }],
    // The code editor: ⌘P and ⌘J anywhere in a project; the rest with a file open from Changes, the cursor in it.
    'Open a file of the open project': [{ at: board, keys: ['Meta+p'], expect: shows('.quick-open .quick-open-option') }],
    'Show or hide the code editor': [{ at: board, keys: ['Meta+j'], expect: shows('.editor-drawer:not([hidden])') }],
    'Save the file': [{ at: changes, ready: '.dl-add', setup: async (page) => { await editing(page); await page.keyboard.type(' '); }, keys: ['Meta+s'], expect: shows('.editor-tab.active:not(.unsaved)') }],
    'Find and replace': [{ at: changes, ready: '.dl-add', setup: editing, keys: ['Meta+f'], expect: shows('.cm-panel.cm-search') }],
    'Go to a line': [{ at: changes, ready: '.dl-add', setup: editing, keys: ['Control+g'], expect: shows('.cm-panel.cm-goto-line') }],
    'Back to where you were': [{ at: changes, ready: '.dl-add', setup: async (page) => { await editing(page); await page.keyboard.press('Meta+ArrowDown'); }, keys: ['Control+Minus'],
      expect: focused(() => /^Line 1,/.test(document.querySelector('.editor-status button')?.textContent ?? '')) }],
    'Forward again': [{ at: changes, ready: '.dl-add', setup: async (page) => { await editing(page); await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.press('Control+Minus'); }, keys: ['Control+Shift+Minus'],
      expect: focused(() => !/^Line 1,/.test(document.querySelector('.editor-status button')?.textContent ?? 'Line 1,')) }],
    'Move to the breadcrumbs': [{ at: changes, ready: '.dl-add', setup: editing, keys: ['Meta+Shift+Period'], expect: focused(() => document.activeElement?.classList.contains('crumb-button')) }],
    'Wrap long lines, or not': [{ at: changes, ready: '.dl-add', setup: editing, keys: ['Alt+z'], expect: focused(() => document.querySelector('.editor-status-toggle[title^="Wrap"]')?.getAttribute('aria-pressed') === 'true') }],
    'Leave the editor': [{ at: changes, ready: '.dl-add', setup: editing, keys: ['Escape', 'Tab'], expect: focused(() => !document.activeElement?.closest('.cm-editor')) }],
    'Pull, fast-forward only': [{ at: `#/p/${ns}/changes?branch=${ns}-3`, ready: '.pr-chip', keys: ['Meta+Shift+p'], expect: shows('.toast:has-text("Already up to date with origin/wanigan/ns-3")') }],
    Fetch: [{ at: `#/p/${ns}/changes`, ready: '.dl-add', keys: ['Meta+Shift+f'], expect: shows('.toast:has-text("Fetched from origin")') }],
    'Switch branch': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', keys: ['Meta+b'], expect: focused(() => location.hash.endsWith('/changes/branches') && document.activeElement?.closest('.branches-toolbar') !== null && document.activeElement?.tagName === 'INPUT') }],
    'New branch': [{ at: `#/p/${ns}/changes`, ready: '.dl-add', keys: ['Meta+Shift+b'], expect: focused(() => document.activeElement?.id === 'branch-new-name') }],
    'Next commit': [
      { at: `#/p/${ns}/changes/commits`, ready: '.commit-row', setup: click('.commit-row:nth-child(1)'), keys: ['j'], expect: shows('.commit-row:nth-child(2)[aria-selected="true"]') },
      { at: `#/p/${ns}/changes/commits`, ready: '.commit-row', setup: click('.commit-row:nth-child(1)'), keys: ['ArrowDown'], expect: shows('.commit-row:nth-child(2)[aria-selected="true"]') },
    ],
    'Previous commit': [
      { at: `#/p/${ns}/changes/commits`, ready: '.commit-row', setup: click('.commit-row:nth-child(2)'), keys: ['k'], expect: shows('.commit-row:nth-child(1)[aria-selected="true"]') },
      { at: `#/p/${ns}/changes/commits`, ready: '.commit-row', setup: click('.commit-row:nth-child(2)'), keys: ['ArrowUp'], expect: shows('.commit-row:nth-child(1)[aria-selected="true"]') },
    ],
    'Choose a result': [
      { at: board, setup: press('Meta+k'), then: '.palette-option', keys: ['ArrowDown'], expect: focused(() => document.querySelectorAll('.palette [role="option"]')[1]?.getAttribute('aria-selected') === 'true') },
      { at: board, setup: press('Meta+k'), then: '.palette-option', keys: ['ArrowUp'], expect: focused(() => [...document.querySelectorAll('.palette [role="option"]')].pop()?.getAttribute('aria-selected') === 'true') },
    ],
    'Create the card and open it': [{ at: board, setup: async (page) => { await page.keyboard.press('c'); await page.waitForSelector('.dialog input[data-autofocus]'); await page.keyboard.type('Made by the crawler'); }, keys: ['Meta+Enter'], expect: shows('.drawer .stages') }],
    'Send a message to the agent': [{ at: shell ? `#/p/${shell.projectKey}/s/${shell.id}` : null, ready: '#composer', setup: async (page) => { await page.click('#composer'); await page.keyboard.type(TYPED); }, keys: ['Enter'], expect: focused(() => document.querySelector('#composer')?.value === '') }],
    'New line in a message': [{ at: shell ? `#/p/${shell.projectKey}/s/${shell.id}` : null, ready: '#composer', setup: async (page) => { await page.click('#composer'); await page.keyboard.type('one'); }, keys: ['Shift+Enter'], expect: focused(() => document.querySelector('#composer')?.value === 'one\n') }],
    'Close a dialog': [{ at: board, setup: press('c'), then: '.dialog', keys: ['Escape'], expect: gone('.dialog') }],
    // Go to: ⌘⇧Space from anywhere in a project; Shift+Space in the live view, pressed on another of its buttons so a
    // button's own Space can never be what opened it.
    'A page of the project’s site': [{ standIn: 'goto', at: board, keys: ['Meta+Shift+Space'], expect: shows('.goto [role="option"]') }],
    'A page of the site, from the live view (not while typing)': [{ standIn: 'goto', at: live, ready: '.live-bar', setup: async (page) => { await page.focus('.live-bar button[aria-label="Site settings"]'); },
      keys: ['Shift+Space'], expect: shows('.goto [role="option"]') }],
    // Compare, opened from the live view. It starts on the slider, at the first change, at the view's 1440 px.
    'Show Local, or the hosted page': [
      { standIn: 'compare', at: live, ready: '.live-bar', setup: comparing(), keys: ['ArrowRight'], expect: showing('Live') },
      { standIn: 'compare', at: live, ready: '.live-bar', setup: comparing('ArrowRight'), keys: ['ArrowLeft'], expect: showing('Local') },
    ],
    'Flip to the other': [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing('ArrowLeft'), keys: ['Space'], expect: showing('Live') }],
    Slider: [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing('d'), keys: ['s'], expect: compareMode('Slider') }],
    'Onion skin': [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing(), keys: ['o'], expect: compareMode('Onion skin') }],
    Difference: [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing(), keys: ['d'], expect: compareMode('Difference') }],
    'Side by side': [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing(), keys: ['t'], expect: compareMode('Side by side') }],
    'Next change': [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing(), keys: ['j'], expect: atChange(1) }],
    'Previous change': [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing('j'), keys: ['k'], expect: atChange(0) }],
    'Phone, tablet or desktop width': [
      { standIn: 'compare', at: live, ready: '.live-bar', setup: comparing(), keys: ['1'], expect: takenAt(390) },
      { standIn: 'compare', at: live, ready: '.live-bar', setup: comparing(), keys: ['2'], expect: takenAt(768) },
      { standIn: 'compare', at: live, ready: '.live-bar', setup: async (page) => { await comparing()(page); await atWidth('2', 768)(page); }, keys: ['3'], expect: takenAt(1440) },
    ],
    // The footer's clock changes on its own, the change worth ignoring: K from the first change wraps round to it.
    'Ignore the change on this page': [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing('k'), keys: ['i'], expect: shows('.cmp-ignored li:has-text("This page")') }],
    'Ignore the change on every page': [{ standIn: 'compare', at: live, ready: '.live-bar', setup: comparing('k'), keys: ['Shift+I'], expect: shows('.cmp-ignored li:has-text("Every page")') }],
    // Last: these change the board.
    'Accept into Ready (Inbox)': [{ at: board, setup: focusCard('inbox'), keys: ['a'], expect: focused((k) => !!document.querySelector(`.column-ready .card[data-key="${k}"]`), inbox[0]?.key) }],
    'Archive (Inbox)': [{ at: board, setup: focusCard('inbox'), keys: ['x'], expect: focused((k) => !document.querySelector(`.card[data-key="${k}"]`), inbox[1]?.key) }],
    // After those: the board remembers the view it was set to, and the Inbox keys expect it as seeded.
    // The demo saves three views on Northstar's board; the first shows its bugs by priority.
    'Apply a saved view, by its number': [{ at: board, keys: ['1'], expect: shows('.views-trigger.on:has-text("Bugs by priority")') }],
  };
  return checks;
}

async function crawlKeys(browser) {
  const started = Date.now();
  const records = [];
  let gateway;
  /** One page for the plain window, and one for each live-view stand-in a check names, opened when first needed. */
  const pages = new Map();
  try {
    const startedGateway = await seeded('Keyboard', 'initial');
    gateway = startedGateway.gateway;
    pages.set('', await openPage(browser, startedGateway.base));
    const world = await readWorld(pages.get('').page);
    const ns = world.projects.find((p) => p.name.startsWith('Northstar')).key;
    const pageFor = async (standIn = '') => {
      if (!pages.has(standIn)) {
        const opened = await openPage(browser, startedGateway.base, LIVE_STANDINS[standIn].scripts);
        pages.set(standIn, opened);
        await LIVE_STANDINS[standIn].prepare(opened.page, ns);
      }
      return pages.get(standIn);
    };
    const checks = keyChecks(world);
    for (const s of SHORTCUTS) {
      const want = 1 + (s.alt?.length ?? 0);
      if ((checks[s.label]?.length ?? 0) < want) records.push(verdict({ surface: 'Keyboard', kind: 'key', label: s.label, path: [], action: '', effects: [], problems: [`listed on the sheet with ${want} key(s), but the crawler presses ${checks[s.label]?.length ?? 0}`], result: 'pass', note: '' }));
    }
    for (const [label, list] of Object.entries(checks)) {
      for (const c of list) {
        const rec = { surface: 'Keyboard', kind: 'key', label: `${label}: ${c.keys.join(' then ')}`, path: [], action: `pressed ${c.keys.join(' then ')}`, effects: [], problems: [], result: 'pass', note: '' };
        records.push(rec);
        try {
          if (!c.at) throw new Error('the demo has nowhere this applies');
          const { page, errors } = await pageFor(c.standIn);
          await page.evaluate((h) => { location.hash = h; }, c.at);
          await page.reload();
          await page.waitForSelector('.rail-projects a', { timeout: 20_000 });
          await page.waitForSelector(c.ready ?? (c.at.includes('/board') ? '.card' : 'main .view'), { timeout: 10_000 });
          await settle(page);
          if (c.setup) { await c.setup(page); await settle(page); }
          if (c.then) await page.waitForSelector(c.then, { timeout: 5000 });
          const errorsAt = errors.length;
          const before = await page.evaluate(() => window.__crawl.observe());
          for (const k of c.keys) await page.keyboard.press(k);
          await c.expect(page).then(() => { rec.effects.push('did what the sheet says'); }, () => { rec.problems.push('did not do what the sheet says'); });
          await settle(page);
          const after = await page.evaluate(() => window.__crawl.observe());
          const l = await page.evaluate(() => ({ calls: window.__crawl.calls, rejected: window.__crawl.rejected, stopped: window.__crawl.stopped, bridge: window.__crawl.bridge }));
          rec.problems.push(...await problemsOf(before, after, l, errors, errorsAt, rec, page));
        } catch (e) {
          rec.problems.push(`could not be tried: ${firstLine(e.message)}`);
        }
        verdict(rec);
      }
    }
  } catch (error) {
    records.push(startupFailure(error, 'Keyboard'));
  } finally {
    for (const { context } of pages.values()) await context.close().catch(() => {});
    gateway?.kill('SIGTERM');
  }
  return { records, ms: Date.now() - started };
}

/* ── checks ───────────────────────────────────────────────────────────────── */

/** What an empty view says. From a core that did not answer, any of it would be a false all-clear. */
const EMPTY_WORDS = ['Nothing needs you', 'Open a project to begin', 'Nothing is running', 'This board is empty', 'No cards yet',
  'No sessions yet', 'Nothing running', 'can’t find', 'No decisions yet', 'Nothing has happened here yet', 'No projects yet',
  'No Claude Code accounts', 'No Codex accounts', 'No Claude Code or Codex conversation', '0 open cards'];
const DOWN = 'Wanigan’s core is not answering';

/** Open a place afresh, with the core failing the methods named ('*' for all) and the window on a platform. */
async function openAt(page, hash, { fail = '', platform = '', ready = 'main' } = {}) {
  await page.evaluate(({ h, f, p }) => {
    sessionStorage.clear();
    if (f) sessionStorage.setItem('wanigan.crawl.fail', f);
    if (p) sessionStorage.setItem('wanigan.crawl.platform', p);
    location.hash = h;
  }, { h: hash, f: fail, p: platform });
  await page.reload();
  await page.waitForSelector(ready, { timeout: 10_000 });
  await settle(page);
}
const failFrom = (page, methods) => page.evaluate((m) => sessionStorage.setItem('wanigan.crawl.fail', m), methods);
const callCount = (page, method) => page.evaluate((m) => window.__crawl.calls.filter((x) => x === m).length, method);
const xtermSays = (page, pattern) => page.waitForFunction((p) => new RegExp(p).test(document.querySelector('.session .xterm-rows')?.textContent ?? ''), pattern.source, { timeout: 5000 })
  .then(() => true, () => false);

/**
 * Bugs a code audit found, each fixed with one of these as its test: it opens
 * what it needs, does the one thing, and returns what went wrong.
 */
function checks(w) {
  const ns = w.projects.find((p) => p.name.startsWith('Northstar')).key;
  const board = `#/p/${ns}/board`;
  const changes = `#/p/${ns}/changes`;
  /** A file open in the code editor from Changes, the cursor in its text. */
  const editing = async (page) => {
    await page.locator('.diff-slot button:has-text("Edit")').first().click();
    await page.waitForSelector('.editor-code .cm-content', { timeout: 15_000 });
    await page.click('.editor-code .cm-content');
  };
  const shell = w.sessions.find((s) => s.provider === 'shell' && s.live);
  const shellAt = `#/p/${shell.projectKey}/s/${shell.id}`;
  const limited = w.sessions.find((s) => s.title.startsWith('Rate limiter'));
  const list = [];

  for (const [where, fail, hash, ready, expectedHeading = DOWN] of [
    ['Needs you', '*', '#/needs'],
    ['a project', '*', board],
    ['the board', 'cards.list', board, '.rail-projects a'],
    ['the list of cards', 'cards.list', `#/p/${ns}/list`, '.rail-projects a'],
    ['a project’s sessions', 'sessions.list', `#/p/${ns}/sessions`, '.rail-projects a'],
    ['Running', 'sessions.list', '#/running', '.rail-projects a'],
    ['Decisions', 'decisions.list', `#/p/${ns}/decisions`, '.rail-projects a'],
    ['Activity', 'activity.list', `#/p/${ns}/activity`, '.rail-projects a'],
    ['Accounts', 'accounts.list', '#/accounts', '.rail-projects a'],
    ['History', 'history.list', `#/p/${ns}/history`, '.rail-projects a', 'History could not be loaded'],
  ]) {
    list.push([`A core that does not answer is not an empty app: ${where}`, async (page) => {
      await openAt(page, hash, { fail, ...(ready ? { ready } : {}) });
      const said = await page.textContent('main');
      const problems = EMPTY_WORDS.filter((x) => said.includes(x)).map((x) => `says “${x}”`);
      if (!said.includes(expectedHeading)) problems.push('does not show the expected failure heading');
      // Once it answers again, Retry brings the view back.
      await failFrom(page, '');
      const retry = page.locator('main .empty button:has-text("Retry")').first();
      if (!(await retry.count())) return [...problems, 'offers no Retry'];
      await retry.click();
      await settle(page);
      if ((await page.textContent('main')).includes(expectedHeading)) problems.push('Retry did not bring it back');
      return problems;
    }]);
  }

  list.push(['Typing in a dialog keeps its place while the core sends news', async (page) => {
    await openAt(page, board, { ready: '.card' });
    await page.click('.topbar-tools button[aria-label$=" settings"]');
    const field = page.locator('.dialog input[placeholder^="npm install"]');
    await field.click();
    // ⌘→, the Mac's end of line: End moves the caret only while nothing around the field can
    // scroll, and the settings dialog scrolls once it has more to say (a local model, say).
    await page.keyboard.press('Meta+ArrowRight');
    await page.keyboard.type(' && echo typed');
    // A session renamed elsewhere: the projects are read again and the view draws again.
    await page.evaluate((id) => window.wanigan.call('sessions.rename', { id, title: 'Renamed while typing' }), shell.id);
    await page.waitForTimeout(600);
    const kept = await field.evaluate((el) => document.activeElement === el);
    await page.keyboard.type('!');
    const value = await field.inputValue();
    return [...(kept ? [] : ['a redraw took focus out of the field being typed in']), ...(value.endsWith('echo typed!') ? [] : [`the field reads “${value}”`])];
  }]);

  list.push(['Escape while an input method is composing leaves the dialog open', async (page) => {
    await openAt(page, board, { ready: '.card' });
    await page.keyboard.press('c');
    await page.waitForSelector('.dialog input[data-autofocus]');
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(200);
    return (await page.$('.dialog')) ? [] : ['the composing Escape closed the dialog, and its draft'];
  }]);

  const once = (name, at, ready, type, keys, method) => list.push([name, async (page) => {
    await openAt(page, at, { ready });
    await type(page);
    const before = await callCount(page, method);
    for (const k of keys) await page.keyboard.press(k);
    await page.waitForTimeout(800);
    await settle(page);
    const n = (await callCount(page, method)) - before;
    return n === 1 ? [] : [`${method} was called ${n} times`];
  }]);
  const typeInto = (selector, text) => async (page) => { await page.click(selector); await page.keyboard.type(text); };
  once('A double Enter in the composer sends once', shellAt, '#composer', typeInto('#composer', 'echo once'), ['Enter', 'Enter'], 'sessions.queue');
  once('A double Enter adds one account', '#/accounts', '.account', async (page) => {
    await page.click('.account-group-head button:has-text("Add account")');
    await page.waitForSelector('.dialog input');
    await page.keyboard.type('Twice');
  }, ['Enter', 'Enter'], 'accounts.add');
  once('A double Enter records one decision', `#/p/${ns}/decisions`, '.decision', typeInto('#decision-title', 'Only once'), ['Enter', 'Enter'], 'decisions.add');
  once('A double Enter adds one criterion', `${board}?card=${ns}-1`, '.drawer .stages', typeInto('#criterion-new', 'Only once'), ['Enter', 'Enter'], 'criteria.add');
  once('A double ⌘Enter comments once', `${board}?card=${ns}-1`, '.drawer .stages', typeInto('#comment-new', 'Only once'), ['Meta+Enter', 'Meta+Enter'], 'cards.comment');
  once('A double Enter saves one board view', board, '.card', async (page) => {
    await page.click('.views-trigger');
    await page.waitForSelector('.views-panel .views-save input');
    await typeInto('.views-panel .views-save input', 'Only once')(page);
  }, ['Enter', 'Enter'], 'boardViews.save');

  list.push(['Saved views that cannot be read say so, and Retry reads them', async (page) => {
    await openAt(page, board, { ready: '.card', fail: 'boardViews.list' });
    await page.click('.views-trigger');
    await page.waitForSelector('.views-panel');
    const problems = [];
    const said = await page.textContent('.views-panel');
    if (!/could not be read/.test(said)) problems.push(`the panel says “${said.trim().slice(0, 120)}”`);
    if (/No views saved/.test(said)) problems.push('a list that could not be read reads as empty');
    if (!(await page.$('.views-save button[type="submit"]:disabled'))) problems.push('Save is offered before the views are known');
    await failFrom(page, '');
    await page.click('.views-problem button:has-text("Retry")');
    if (!(await page.waitForSelector('.views-panel .views-row', { timeout: 3000 }).then(() => true, () => false))) problems.push('Retry did not bring the views back');
    return problems;
  }]);

  list.push(['A saved view keeps its words when the core refuses a rename', async (page) => {
    await openAt(page, board, { ready: '.card' });
    await page.click('.views-trigger');
    await page.click('.views-row:first-child button[aria-label^="Rename"]');
    const input = page.locator('.views-panel .views-edit input');
    await input.fill('Kept words');
    await failFrom(page, 'boardViews.update');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    return (await input.count()) && (await input.inputValue()) === 'Kept words' ? [] : ['the rename closed, and its words were lost'];
  }]);
  list.push(['A double click runs a button’s action once', async (page) => {
    await openAt(page, '#/accounts', { ready: '.account' });
    const before = await callCount(page, 'accounts.makeDefault');
    await page.locator('.account-actions button:has-text("Make default")').first().dblclick();
    await page.waitForTimeout(800);
    const n = (await callCount(page, 'accounts.makeDefault')) - before;
    return n === 1 ? [] : [`accounts.makeDefault was called ${n} times`];
  }]);

  list.push(['Escape leaves an edited card title as it was', async (page) => {
    await openAt(page, `${board}?card=${ns}-1`, { ready: '.drawer .stages' });
    const title = page.locator('.drawer textarea[aria-label="Title"]');
    const was = await title.inputValue();
    await title.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Changed my mind');
    const before = await callCount(page, 'cards.update');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const now = await title.inputValue();
    return [...((await callCount(page, 'cards.update')) === before ? [] : ['Escape saved the edit']), ...(now === was ? [] : [`the title reads “${now}”`])];
  }]);

  list.push(['A decision edit the core refuses stays open with its words', async (page) => {
    await openAt(page, `#/p/${ns}/decisions`, { ready: '.decision' });
    await page.locator('.decision-actions button:has-text("Edit")').first().click();
    const input = page.locator('.decision-edit input').first();
    await input.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' (kept)');
    await failFrom(page, 'decisions.update');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    return (await page.$('.decision-edit')) && (await input.inputValue()).endsWith('(kept)') ? [] : ['the edit closed, and its words were lost'];
  }]);

  list.push(['A card in a column this window does not know leaves the board standing', async (page) => {
    await openAt(page, '#/needs', { ready: '.needs-headline' });
    await page.evaluate(() => {
      window.__crawl.rewrite['cards.list'] = (cards) => (cards.length ? [...cards, { ...cards[0], id: 'odd', key: 'NS-999', title: 'From a newer core', status: 'someday' }] : cards);
    });
    await page.evaluate((h) => { location.hash = h; }, board);
    await page.waitForSelector('.card, .view-crash', { timeout: 6000 }).catch(() => {});
    return (await page.$('.view-crash')) ? ['the board crashed'] : (await page.$('.card')) ? [] : ['the board shows no cards'];
  }]);

  list.push(['A terminal says when it cannot watch, and watches again when the core is back', async (page) => {
    await openAt(page, '#/needs', { ready: '.needs-headline' });
    await failFrom(page, 'sessions.watch');
    await page.evaluate((h) => { location.hash = h; }, shellAt);
    const problems = [];
    if (!(await xtermSays(page, /could not show this session/))) problems.push('a terminal that could not watch says nothing');
    await page.evaluate(() => { sessionStorage.removeItem('wanigan.crawl.fail'); window.__crawl.setStatus('unavailable'); window.__crawl.setStatus('connected'); });
    if (!(await xtermSays(page, /rate limit: 120/))) problems.push('the terminal did not watch again when the core came back');
    await failFrom(page, 'sessions.input');
    const beforeInput = await callCount(page, 'sessions.input');
    const rejectedBefore = await page.evaluate(() => window.__crawl.rejected.filter((r) => r.method === 'sessions.input').length);
    await page.click('.session .terminal');
    await page.keyboard.type('x');
    if (!(await xtermSays(page, /\[Session input: Wanigan’s core did not answer\.\]/))) problems.push('the terminal did not show the injected input error');
    if ((await callCount(page, 'sessions.input')) - beforeInput !== 1) problems.push('typing did not attempt exactly one input call');
    const rejected = await page.evaluate(() => window.__crawl.rejected.filter((r) => r.method === 'sessions.input'));
    if (rejected.length - rejectedBefore !== 1 || rejected.at(-1)?.message !== 'Wanigan’s core did not answer.') problems.push('the input did not receive the injected rejection');
    if ((await page.locator('.session .xterm-rows').textContent()).includes('Keys did not reach the session')) problems.push('the terminal claimed definite non-delivery');
    return problems;
  }]);

  list.push(['Resume in History asks which account even when the accounts cannot be listed', async (page) => {
    await openAt(page, `#/p/${ns}/history`, { ready: '.hrow' });
    // The project uses the default account; the conversation lives in another.
    await page.evaluate(async (key) => {
      const project = (await window.wanigan.call('projects.list', {})).find((p) => p.key === key);
      const account = (await window.wanigan.call('accounts.list', {})).find((a) => a.provider === 'claude' && a.isDefault);
      await window.wanigan.call('projects.setAccount', { id: project.id, provider: 'claude', accountId: account.id });
    }, ns);
    await openAt(page, `#/p/${ns}/history`, { ready: '.hrow', fail: 'accounts.list' });
    await page.click('.hrow:has-text("Expired coupon codes") button:has-text("Resume")');
    return (await page.waitForSelector('.dialog .choose-accounts', { timeout: 3000 }).then(() => true, () => false)) ? [] : ['Resume did nothing'];
  }]);

  list.push(['A session at its usage limit says when the accounts cannot be listed', async (page) => {
    await openAt(page, `#/p/${limited.projectKey}/s/${limited.id}`, { ready: '.banner-limit', fail: 'accounts.list' });
    const said = await page.textContent('.banner-limit');
    return /could not list your accounts/.test(said) && (await page.$('.banner-limit button:has-text("Wait for the reset")')) ? [] : [`the banner says “${said.trim()}”`];
  }]);

  list.push(['A card’s links name its project before the projects are known', async (page) => {
    await openAt(page, `#/needs?card=${ns}-7`, { ready: '.drawer .stages', fail: 'projects.list' });
    const bad = await page.$$eval('.drawer a[href]', (as) => as.map((a) => a.getAttribute('href')).filter((h) => h.includes('#/p//')));
    return bad.map((h) => `links to ${h}`);
  }]);

  list.push(['Away from a Mac, no ⌘ is shown', async (page) => {
    const found = [];
    const look = async (where) => {
      const said = await page.evaluate(() => document.body.innerText
        + [...document.querySelectorAll('[title], [placeholder]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('placeholder') ?? ''}`).join(' '));
      if (said.includes('⌘')) found.push(where);
    };
    await openAt(page, `#/p/${ns}/sessions`, { platform: 'linux', ready: '.srow' });
    await look('a project’s sessions, or the rail');
    await page.keyboard.press('Shift+Slash');
    await page.waitForSelector('.shortcuts');
    await look('the shortcut sheet');
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await page.waitForSelector('.dialog');
    await look('a new card');
    await page.keyboard.press('Escape');
    await openAt(page, `${board}?card=${ns}-7`, { platform: 'linux', ready: '.drawer .stages' });
    await look('a card');
    await openAt(page, `#/p/${ns}/changes`, { platform: 'linux', ready: '.dl-add' });
    await page.locator('.dl-note-add').first().click();
    await look('a note on a line');
    return found.map((w) => `⌘ in ${w}`);
  }]);

  list.push(['Open a project shows each folder’s path as it is', async (page) => {
    await openAt(page, board, { ready: '.card' });
    await page.evaluate(() => {
      window.__crawl.rewrite['projects.agentFolders'] = (r) => ({ ...r, folders: [{ path: '/Users/Shared/site', name: 'site', conversations: 3, lastAt: Date.now(), git: true, agents: ['claude'] }, ...r.folders] });
    });
    await page.click('.rail-add');
    await page.waitForSelector('.agent-folders li', { timeout: 8000 });
    return (await page.textContent('.agent-folders')).includes('/Users/Shared/site') ? [] : ['/Users/Shared/site is shown as another folder'];
  }]);

  list.push(['Staging a new file tolerates a diff refresh before status moves it out of Untracked', async (page) => {
    const path = 'docs/a11y-audit-2026-09.md';
    await openAt(page, `#/p/${ns}/changes`, { ready: '.dl-add' });
    const diff = page.locator(`.diff[aria-label="Changes to ${path}"]`);
    await diff.scrollIntoViewIfNeeded();
    await diff.locator('.dl-add').first().waitFor({ timeout: 8000 });
    // Hold the refreshed file list until the still-mounted Untracked diff has answered.
    // This reproduces the two subscribers' race without relying on which git call is faster.
    await page.evaluate((path) => {
      const real = window.wanigan.call.bind(window.wanigan);
      let release;
      const gate = new Promise((done) => { release = done; });
      window.__untrackedRefresh = { done: false, error: null, restore: () => { release(); window.wanigan.call = real; } };
      window.wanigan.call = (method, params) => {
        if (method === 'git.status') return gate.then(() => real(method, params));
        const answer = real(method, params);
        if (method === 'git.diff' && params.path === path && params.area === 'untracked') {
          answer.then(
            (result) => { window.__untrackedRefresh.done = true; window.__untrackedRefresh.diff = result.diff; release(); },
            (error) => { window.__untrackedRefresh.done = true; window.__untrackedRefresh.error = error.message; release(); },
          );
        }
        return answer;
      };
    }, path);
    try {
      await page.getByRole('checkbox', { name: `Stage ${path}`, exact: true }).click();
      await page.waitForFunction(() => window.__untrackedRefresh.done, null, { timeout: 8000 });
      await page.getByRole('checkbox', { name: `Unstage ${path}`, exact: true }).waitFor();
      const result = await page.evaluate(() => ({ error: window.__untrackedRefresh.error, diff: window.__untrackedRefresh.diff }));
      return result.error ? [`staging refreshed a stale area with an error: ${result.error}`]
        : result.diff ? ['the newly staged file still reports an untracked diff'] : [];
    } finally {
      await page.evaluate(() => window.__untrackedRefresh.restore());
    }
  }]);

  list.push(['A conflict resolved hunk by hunk is written once, staged, and leaves no marker', async (page) => {
    await openAt(page, `#/p/${ns}/changes?branch=${ns}-13`, { ready: '.resolver-hunk' });
    const copy = page.locator('.resolver[aria-label$="/copy.ts"]');
    const hunks = copy.locator('.resolver-hunk');
    for (let i = 0, n = await hunks.count(); i < n; i++) await hunks.nth(i).locator('[role="radio"]:text-is("Both, ours first")').click();
    const before = await callCount(page, 'git.resolve');
    await copy.locator('.resolver-head button:has-text("Mark resolved")').dblclick();
    await page.waitForTimeout(800);
    await settle(page);
    const problems = [];
    const calls = (await callCount(page, 'git.resolve')) - before;
    if (calls !== 1) problems.push(`git.resolve was called ${calls} times`);
    const git = await page.evaluate(async (key) => {
      const project = (await window.wanigan.call('projects.list', {})).find((p) => p.key === key);
      const card = (await window.wanigan.call('cards.list', { projectId: project.id })).find((c) => c.key === `${key}-13`);
      const where = { id: project.id, cardId: card.id };
      const status = await window.wanigan.call('git.status', where);
      const path = status.staged.find((f) => f.path.endsWith('/copy.ts'))?.path ?? null;
      const staged = path ? (await window.wanigan.call('git.diff', { ...where, path, area: 'staged' })).diff : '';
      return { conflicted: status.conflicted.map((f) => f.path), path, staged, operation: status.operation };
    }, ns);
    if (git.conflicted.some((p) => p.endsWith('/copy.ts'))) problems.push('copy.ts is still conflicted');
    if (!git.path) problems.push('copy.ts was not staged');
    if (/^[+ ](<{7}|={7}|>{7}|\|{7})/m.test(git.staged)) problems.push('the staged copy.ts holds conflict markers');
    if (git.operation !== 'merge') problems.push(`the merge is ${git.operation ?? 'gone'}, with totals.ts still to resolve`);
    return problems;
  }]);
  return list;
}

async function crawlChecks(browser) {
  const started = Date.now();
  const records = [];
  let context, gateway;
  try {
    const startedGateway = await seeded('Checks', 'initial');
    gateway = startedGateway.gateway;
    const opened = await openPage(browser, startedGateway.base);
    context = opened.context;
    const { page, errors } = opened;
    for (const [label, run] of checks(await readWorld(page))) {
      const rec = { surface: 'Checks', kind: 'check', label, path: [], action: 'checked', effects: [], problems: [], result: 'pass', note: '' };
      records.push(rec);
      const errorsAt = errors.length;
      try {
        rec.problems.push(...await run(page));
      } catch (e) {
        rec.problems.push(`could not be checked: ${whyNot(e)}`);
      }
      rec.problems.push(...errors.slice(errorsAt));
      verdict(rec);
    }
  } catch (error) {
    records.push(startupFailure(error, 'Checks'));
  } finally {
    await context?.close().catch(() => {});
    gateway?.kill('SIGTERM');
  }
  return { records, ms: Date.now() - started };
}

/* ── run ──────────────────────────────────────────────────────────────────── */

/**
 * What an earlier control took away (a Stop, an Archive, opening the session a
 * need was about, the first of two Opens) is used again, each on a core of its
 * own, freshly seeded, so nothing is left out for the order controls came in.
 */
async function crawlFully(browser, surface, world) {
  const result = await crawlSurface(browser, surface, world);
  for (const gone of result.records.filter((r) => r.result === 'unreached' && r.item)) {
    const again = await crawlSurface(browser, surface, world, [gone.item]);
    result.ms += again.ms;
    const now = again.records.find((r) => r.item?.sig === gone.item.sig);
    if (now && now.result !== 'unreached') {
      now.note = [now.note, 'on a fresh core: an earlier action here had taken it away'].filter(Boolean).join('; ');
      result.records[result.records.indexOf(gone)] = now;
    }
    // What only it revealed is reported too.
    result.records.push(...again.records.filter((r) => r !== now && r.result !== 'unreached'));
  }
  return result;
}

const browser = await chromium.launch();
const results = [];
let world;
try {
  {
    const started = Date.now();
    let gateway;
    try {
      const startedGateway = await seeded('World discovery');
      gateway = startedGateway.gateway;
      const { context, page } = await openPage(browser, startedGateway.base);
      world = await readWorld(page);
      await context.close();
    } catch (error) {
      results.push({ name: 'World discovery', records: [startupFailure(error, 'World discovery')], ms: Date.now() - started });
    } finally {
      gateway?.kill('SIGTERM');
    }
  }
  const surfaces = world ? plan(world).filter((s) => !ONLY || ONLY.test(s.name)) : [];
  const todo = (world ? [
    ...surfaces.map((s) => ({ name: s.name, run: () => crawlFully(browser, s, world) })),
    { name: 'Keyboard', run: () => crawlKeys(browser) },
    { name: 'Checks', run: () => crawlChecks(browser) },
  ] : []).filter((job) => !ONLY || ONLY.test(job.name) || surfaces.some((s) => s.name === job.name));
  const total = todo.length;
  let finished = 0;
  await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, async () => {
    for (let job = todo.shift(); job; job = todo.shift()) {
      const r = await job.run();
      const { name } = job;
      results.push({ name, ...r });
      const failed = r.records.filter((x) => x.result === 'fail').length;
      finished++;
      console.log(`${failed ? '✗' : '✓'} [${finished}/${total}] ${name}: ${r.records.length} controls${failed ? `, ${failed} failed` : ''} (${(r.ms / 1000).toFixed(1)}s)`);
    }
  }));
} finally {
  await browser.close();
}

/* ── report ───────────────────────────────────────────────────────────────── */

const records = results.flatMap((r) => r.records);
const count = (result) => records.filter((x) => x.result === result).length;
const controls = records.filter((x) => x.kind !== 'surface' && x.kind !== 'check');
const crawled = results.filter((r) => r.name !== 'Keyboard' && r.name !== 'Checks');
const totals = {
  surfaces: crawled.length,
  surfacesOpened: crawled.filter((r) => !r.records.some((x) => x.kind === 'surface' && x.label === 'opening it' && x.result === 'fail')).length,
  controls: controls.filter((x) => x.kind !== 'key').length,
  shortcuts: controls.filter((x) => x.kind === 'key').length,
  checks: records.filter((x) => x.kind === 'check').length,
  actions: controls.filter((x) => x.action && !/^(not used|not followed|left alone)/.test(x.action)).length,
  passed: count('pass'), failed: count('fail'), allowed: count('allowed'), guarded: count('guarded'), unreached: count('unreached'),
  rpcRefusals: records.reduce((n, x) => n + (x.refusals?.length ?? 0), 0),
  qualifiedResizeRefusals: records.reduce((n, x) => n + (x.resizeQualifications?.length ?? 0), 0),
  byKind: Object.fromEntries([...new Set(controls.map((x) => x.kind))].sort().map((k) => [k, controls.filter((x) => x.kind === k).length])),
};
writeFileSync(join(out, 'report.json'), `${JSON.stringify({ when: new Date().toISOString(), totals, allow: ALLOW.map((a) => ({ ...a, label: String(a.label), problem: String(a.problem), surface: a.surface ? String(a.surface) : null })), surfaces: results.map((r) => ({ name: r.name, seconds: r.ms / 1000, controls: r.records })) }, null, 2)}\n`);

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const md = [
  '# Wanigan crawl',
  '',
  `${new Date().toISOString()}. Every control on every surface, used against a freshly seeded demo core.`,
  '',
  `**${totals.failed ? `${totals.failed} failed` : 'Nothing failed'}.** ${totals.surfaces} surfaces, ${totals.controls} controls, ${totals.shortcuts} shortcut keys and ${totals.checks} checks; ${totals.actions} actions taken.`,
  '',
];
const failing = records.filter((x) => x.result === 'fail');
if (failing.length) {
  md.push('## Failures', '', '| Surface | Control | What happened | Problem |', '|---|---|---|---|');
  for (const x of failing) md.push(`| ${cell(x.surface)} | ${cell(`${x.kind}: ${x.label}`)} | ${cell([x.action, ...x.effects].filter(Boolean).join('; '))} | ${cell(x.problems.join('; '))} |`);
  md.push('');
}
for (const r of results) {
  md.push(`## ${r.name}`, '', `${r.records.length} controls, ${(r.ms / 1000).toFixed(1)}s.`, '', '| Control | Reached by | Did | Result |', '|---|---|---|---|');
  for (const x of r.records) {
    const did = [x.action, ...x.effects].filter(Boolean).join('; ');
    const result = x.result === 'pass' ? `pass${x.note ? ` (${x.note})` : ''}` : x.result === 'fail' ? `**fail**: ${x.problems.join('; ')}` : `${x.result}: ${x.note || x.allowed?.join('; ')}`;
    md.push(`| ${cell(`${x.kind}: ${x.label}`)} | ${cell(x.path.join(' › '))} | ${cell(did)} | ${cell(result)} |`);
  }
  md.push('');
}
md.push('## Totals', '', '| | |', '|---|---|',
  `| Surfaces | ${totals.surfaces} (${totals.surfacesOpened} opened) |`,
  `| Controls | ${totals.controls} |`,
  ...Object.entries(totals.byKind).map(([k, n]) => `| · ${k} | ${n} |`),
  `| Shortcut keys | ${totals.shortcuts} |`,
  `| Checks | ${totals.checks} |`,
  `| Actions taken | ${totals.actions} |`,
  `| Passed | ${totals.passed} |`,
  `| Failed | ${totals.failed} |`,
  `| Allowed, with a reason | ${totals.allowed} |`,
  `| Guarded (the real-world step, not used) | ${totals.guarded} |`,
  `| Gone before their turn | ${totals.unreached} |`, '');
md.push(`RPC refusals recorded during actions: ${totals.rpcRefusals}. Of these, ${totals.qualifiedResizeRefusals} were explicitly qualified as background resizes after a successful stop of the same session and an authoritative ended-state read. Raw refusals and qualifications remain in report.json.`, '');
writeFileSync(join(out, 'report.md'), md.join('\n'));

console.log(`\n${totals.surfaces} surfaces, ${totals.controls} controls, ${totals.shortcuts} shortcut keys, ${totals.checks} checks, ${totals.actions} actions: ${totals.passed} passed, ${totals.failed} failed, ${totals.allowed} allowed, ${totals.guarded} guarded, ${totals.unreached} gone before their turn.`);
console.log(`Report: ${join(out, 'report.md')}`);
console.log(`RPC refusals recorded: ${totals.rpcRefusals}; stopped-session resize qualifications: ${totals.qualifiedResizeRefusals}.`);
if (totals.failed) {
  console.error(`\nUI crawl failed:\n  ${failing.map((x) => `${x.surface} › ${x.kind}: ${x.label}: ${x.problems.join('; ')}`).join('\n  ')}`);
  process.exit(1);
}
