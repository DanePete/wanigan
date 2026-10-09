#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE REAL-APP SCENARIO. WITH --spend IT SPENDS REAL MODEL TURNS on your own
// Claude Code and Codex accounts (their defaults): about 15–25 agent turns,
// one AI review, one Draft with Claude and two Talk to Wanigan messages, with
// Claude on Sonnet at low effort and Codex at low effort. It is never part of
// `npm test`. Without --spend it rehearses everything that costs nothing (the
// app, cards, sessions up to their prompts, shells, pause, search, merge,
// skills, MCP, quit) and says which steps it skipped.
//
//   npm run scenario                 # rehearse: no model is called
//   npm run scenario -- --spend      # the real thing
//   npm run scenario -- --spend --keep   # keep the data folder and the test site
//
// It builds a small shop site in a temporary folder, opens it in the real app
// with a throwaway WANIGAN_DATA_DIR, and drives the real interface with
// Playwright: buttons, dialogs, and typing into the agents' own terminals. The
// bridge is used only to read state and check outcomes. Screenshots land in
// .artifacts/scenario/run-<time>/; look at them.
//
// What it never does: open your real Wanigan data, sign anything in or out,
// change an account's settings, add or remove an MCP server, copy a skill
// anywhere but the test site, push, or open a pull request (it opens the
// confirm and cancels). Agents are asked only for small work in the test site,
// and every permission it approves is checked against a short allowlist; it
// refuses one on purpose. An agent may do things in another order than asked:
// such a step is a NOTE, not a failure.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEND = process.argv.includes('--spend');
const KEEP = process.argv.includes('--keep');
const shots = join(root, '.artifacts', 'scenario', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'wg-scenario-'));
const env = { ...process.env, WANIGAN_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (/^(VSCODE_|CLAUDECODE$|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED)$|CLAUDE_PID$|CLAUDE_EFFORT$|AI_AGENT$)/.test(k)) delete env[k];

/* ── the test site ─────────────────────────────────────────────────────── */

function makeSite() {
  const dir = join(mkdtempSync(join(tmpdir(), 'wg-scenario-site-')), 'corner-shop');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  mkdirSync(join(dir, 'scripts'));
  const write = (path, text) => writeFileSync(join(dir, path), text);
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Scenario', GIT_AUTHOR_EMAIL: 'scenario@example.com', GIT_COMMITTER_NAME: 'Scenario', GIT_COMMITTER_EMAIL: 'scenario@example.com' } });
  write('package.json', `${JSON.stringify({ name: 'corner-shop', private: true, type: 'module', scripts: { test: 'node --test', setup: 'node scripts/setup.mjs' } }, null, 2)}\n`);
  write('.gitignore', 'node_modules/\n.env\n');
  write('README.md', '# Corner Shop\n\nA tiny shop page: products, a cart, and a coupon box. `npm test` runs the cart tests.\n');
  write('scripts/setup.mjs', "import { PRODUCTS } from '../src/products.js';\nconsole.log(`Setup done: ${PRODUCTS.length} products in the catalogue.`);\n");
  write('src/products.js', "export const PRODUCTS = [\n  { id: 'mug', name: 'Enamel mug', price: 14 },\n  { id: 'tote', name: 'Canvas tote', price: 22 },\n  { id: 'map', name: 'Lake map print', price: 35 },\n];\n");
  write('index.html', '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Corner Shop</title><link rel="stylesheet" href="styles.css"></head>\n<body>\n  <h1>Corner Shop</h1>\n  <ul id="products"></ul>\n  <aside id="cart"><h2>Your cart</h2><ul id="cart-lines"></ul><p>Subtotal: <span id="subtotal">$0</span></p><label>Coupon <input id="coupon"></label></aside>\n  <script type="module" src="src/app.js"></script>\n</body>\n</html>\n');
  write('styles.css', 'body { font-family: system-ui, sans-serif; margin: 2rem; }\n#cart { border: 1px solid #ddd; padding: 1rem; }\n');
  write('src/app.js', "import { PRODUCTS } from './products.js';\nimport { addItem, createCart, subtotal } from './cart.js';\n\nconst cart = createCart();\nfor (const p of PRODUCTS) {\n  const li = document.createElement('li');\n  li.textContent = `${p.name} — $${p.price} `;\n  const add = document.createElement('button');\n  add.textContent = 'Add';\n  add.onclick = () => { addItem(cart, p); document.querySelector('#subtotal').textContent = `$${subtotal(cart)}`; };\n  li.append(add);\n  document.querySelector('#products').append(li);\n}\n");
  write('src/cart.js', "// Cart logic for the shop page. Prices are whole dollars.\n\nexport function createCart() {\n  return { lines: [], coupon: null };\n}\n\nexport function addItem(cart, product, qty = 1) {\n  const line = cart.lines.find((l) => l.id === product.id);\n  if (line) line.qty += qty;\n  else cart.lines.push({ id: product.id, name: product.name, price: product.price, qty });\n  return cart;\n}\n\nexport function removeItem(cart, id) {\n  cart.lines = cart.lines.filter((l) => l.id !== id);\n  return cart;\n}\n\nexport function subtotal(cart) {\n  return cart.lines.reduce((sum, line) => sum + line.price, 0);\n}\n\nconst COUPONS = { SAVE10: 0.1 };\n\nexport function applyCoupon(cart, code) {\n  if (!(code in COUPONS)) return false;\n  cart.coupon = code;\n  return true;\n}\n\nexport function total(cart) {\n  const sub = subtotal(cart);\n  const off = cart.coupon ? sub * COUPONS[cart.coupon] : 0;\n  return Math.round((sub - off) * 100) / 100;\n}\n");
  write('test/cart.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { addItem, applyCoupon, createCart, removeItem, subtotal, total } from '../src/cart.js';\n\nconst mug = { id: 'mug', name: 'Enamel mug', price: 14 };\nconst tote = { id: 'tote', name: 'Canvas tote', price: 22 };\n\ntest('adding the same product twice adds to its quantity', () => {\n  const cart = addItem(addItem(createCart(), mug), mug);\n  assert.equal(cart.lines[0].qty, 2);\n});\n\ntest('removing a product takes its line out', () => {\n  const cart = removeItem(addItem(addItem(createCart(), mug), tote), 'mug');\n  assert.deepEqual(cart.lines.map((l) => l.id), ['tote']);\n});\n\ntest('subtotal multiplies each price by its quantity', () => {\n  const cart = addItem(addItem(createCart(), mug, 3), tote);\n  assert.equal(subtotal(cart), 3 * 14 + 22);\n});\n\ntest('SAVE10 takes ten percent off the total', () => {\n  const cart = addItem(createCart(), tote);\n  assert.equal(applyCoupon(cart, 'SAVE10'), true);\n  assert.equal(total(cart), 19.8);\n});\n");
  git('init', '-q', '-b', 'main');
  git('add', 'package.json', '.gitignore', 'README.md', 'index.html', 'styles.css', 'src/products.js', 'src/app.js');
  git('commit', '-qm', 'Shop page and product list');
  git('add', '-A');
  git('commit', '-qm', 'Cart logic, coupon and tests');
  return dir;
}

/* ── harness ───────────────────────────────────────────────────────────── */

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/[ \t]+/g, ' ');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sh = (cmd, cwd) => execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const corePid = () => { try { return JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid; } catch { return 0; } };
class Note extends Error {}
const note = (message) => { throw new Note(message); };

let app;
let page;
let n = 0;
async function launch() {
  app = await _electron.launch({ args: [root], env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForSelector('.rail', { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
}
const call = (method, params = {}) => page.evaluate(([m, p]) => window.wanigan.call(m, p), [method, params]);
const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(1200); };
const shot = async (name) => { const file = join(shots, `${String(++n).padStart(3, '0')}-${name}.png`); await page.screenshot({ path: file }).catch(() => {}); return file; };
const screen = async (id) => plain((await call('sessions.watch', { id })).replay);
async function waitFor(fn, ms, label, every = 500) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${String(last).slice(0, 120)})` : ''}`);
}
async function step(name, fn, { spends = false } = {}) {
  if (spends && !SPEND) { results.push(`SKIP ${name} (spends model turns: run with --spend)`); return; }
  try {
    const said = await fn();
    results.push(`PASS ${name}${said ? ` — ${said}` : ''}`);
  } catch (e) {
    results.push(`${e instanceof Note ? 'NOTE' : 'FAIL'} ${name} — ${String(e.message).split('\n')[0]}`);
    await shot(`${e instanceof Note ? 'note' : 'fail'}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`);
  }
}
const drawer = () => page.locator('aside.drawer');
const openCard = (key) => go(`#/p/CS/board?card=${key}`);

/** A session's turn has ended, or it asks for permission. */
const settle = (id, ms = 240_000) => waitFor(async () => {
  const { session, events } = await call('sessions.get', { id });
  if (session.state === 'permission') return { state: 'permission', asks: session.asks ?? [] };
  const last = events.at(-1)?.event;
  if (session.state === 'waiting' && (last === 'Stop' || last === 'Interrupted')) return { state: 'waiting', last };
  if (!['working', 'waiting', 'permission', 'starting', 'running'].includes(session.state)) return { state: session.state };
  return null;
}, ms, 'the turn to end or ask', 1000);

/** Answer one permission prompt from Needs you: Answer in terminal, then Yes (or No). */
async function answer(id, yes) {
  await go('#/needs');
  const { session } = await call('sessions.get', { id });
  const row = page.locator('.need-permission .need-row').filter({ hasText: session.title.slice(0, 30) }).first();
  await row.waitFor({ timeout: 20_000 });
  await row.getByRole('link', { name: 'Answer in terminal' }).click();
  await page.waitForURL(/\/s\//);
  await sleep(1000);
  const text = await screen(id);
  const menu = text.slice(Math.max(text.lastIndexOf('Do you want to'), text.lastIndexOf('Would you like to')));
  if (!/❯\s*1\. Yes|›\s*1\. Yes/.test(menu)) throw new Error(`the prompt is not where expected: ${menu.slice(0, 160)}`);
  if (!yes) {
    const options = menu.match(/\d\. [^\r\n]*/g) ?? [];
    const no = options.findIndex((o) => /^\d\. No\b/.test(o));
    if (no < 0) throw new Error('no "No" option on the prompt');
    for (let i = 0; i < no; i++) { await page.keyboard.press('ArrowDown'); await sleep(200); }
  }
  await page.keyboard.press('Enter');
  await sleep(1500);
}

/** What the owner would approve without thinking twice, in the agent's own folder. */
function benign(asks, cwd) {
  return asks.length > 0 && asks.every((a) => {
    if (a.tool === 'Edit' || a.tool === 'Write') return a.text.startsWith(cwd);
    if (a.tool !== 'Bash') return false;
    if (/^wanigan [a-z]+ /.test(a.text.trim()) && !/[`$]/.test(a.text)) return true;
    return a.text.split(/\s*(?:&&|;|\|\||\|)\s*/).map((p) => p.trim()).filter(Boolean)
      .every((p) => /^(cd \S+|npm (test|run -s test)|node --test|git (add|commit|status|diff|log|show)\b|cat |ls\b|grep |tail |head |echo |[A-Z_]+=\S+|wanigan )/.test(p));
  });
}

/** Drive an agent's turn to its end, approving benign asks from Needs you. Returns what it asked. */
async function drive(id) {
  const asked = [];
  const { session } = await call('sessions.get', { id });
  for (let i = 0; i < 12; i++) {
    const r = await settle(id);
    if (r.state !== 'permission') return { end: r.state, asked };
    asked.push(r.asks.map((a) => `${a.tool} ${a.text}`).join(' | ').slice(0, 160));
    if (!benign(r.asks, session.cwd)) throw new Error(`it asked for something outside the allowlist: ${asked.at(-1)}`);
    await answer(id, true);
    await waitFor(async () => (await call('sessions.get', { id })).session.state !== 'permission' || null, 20_000, 'the answer to take').catch(() => {});
  }
  return { end: 'still going', asked };
}

async function newCard({ type, title, body, criteria = [], priority = 2, column = 'Inbox' }) {
  await page.locator('.rail').getByRole('button', { name: /New card/ }).click();
  await sleep(500);
  const dlg = page.locator('.dialog');
  await dlg.getByRole('radio', { name: type }).click();
  await dlg.getByLabel('Title').fill(title);
  if (body) await dlg.getByLabel('Description').fill(body);
  for (const c of criteria) { await dlg.getByLabel('Acceptance criteria').fill(c); await dlg.getByLabel('Acceptance criteria').press('Enter'); }
  await dlg.getByRole('radiogroup', { name: 'Priority' }).getByRole('radio', { name: `P${priority}` }).click();
  await dlg.getByRole('radiogroup', { name: 'Column' }).getByRole('radio', { name: column }).click();
  await dlg.getByRole('button', { name: 'Create card' }).click();
  await sleep(800);
}

async function startSession({ cardKey, agent, effort = 'Low', ownBranch = false, sonnet = false }) {
  if (cardKey) { await openCard(cardKey); await drawer().getByRole('button', { name: 'Start a session' }).click(); }
  else await page.locator('.rail').getByRole('button', { name: /New session/ }).click();
  await sleep(800);
  const dlg = page.locator('.dialog');
  await dlg.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio', { name: agent }).click();
  await sleep(1500);
  if (sonnet) {
    await dlg.getByLabel('Model', { exact: true }).click();
    await sleep(300);
    await page.getByRole('option').filter({ hasText: 'The newest Sonnet' }).click();
  }
  const efforts = dlg.getByRole('radiogroup', { name: 'Effort' });
  if (agent !== 'Shell' && await efforts.count()) await efforts.getByRole('radio', { name: effort }).click();
  const branch = dlg.getByRole('checkbox', { name: /On its own branch/ });
  if (ownBranch && await branch.count() && !(await branch.isChecked())) await branch.check();
  await dlg.getByRole('button', { name: new RegExp(`^Start ${agent}`) }).click();
  await page.waitForURL(/#\/p\/CS\/s\//, { timeout: 60_000 });
  return (await page.evaluate(() => location.hash)).split('/s/')[1];
}

/** Get an agent to its prompt the way an owner would: folder trust from Needs you. Never accepts an update. */
async function toPrompt(id, provider) {
  let answered = false;
  return waitFor(async () => {
    const s = await screen(id);
    // Codex's update question starts on "Update now": move to Skip, never press Enter on it.
    if (/Update available/.test(s.slice(-1500)) && /Press enter to continue/.test(s.slice(-600))) {
      await page.getByLabel('Terminal', { exact: true }).click();
      await page.keyboard.press('ArrowDown');
      await sleep(500);
      if (/›\s*2\. Skip/.test((await screen(id)).slice(-300))) await page.keyboard.press('Enter');
      return null;
    }
    const tail = s.slice(-1200);
    if (!answered && provider === 'claude' && /Quick safety check/.test(tail) && /❯\s*No, exit/.test(tail.slice(tail.lastIndexOf('Quick safety')))) {
      const needs = await call('needs.list');
      if (needs.some((x) => x.sessionId === id && x.kind === 'starting')) {
        await go('#/needs');
        await page.locator('.need-starting .need-row').first().getByRole('link', { name: 'Answer in terminal' }).click();
        await page.waitForURL(/\/s\//);
        await sleep(800);
        await page.keyboard.press('ArrowDown');
        await sleep(300);
        await page.keyboard.press('Enter');
        answered = 'from Needs you';
      }
      return null;
    }
    if (!answered && provider === 'codex' && /trust the contents of this directory/i.test(tail) && /›\s*1\. Yes, continue/.test(tail)) {
      await page.getByLabel('Terminal', { exact: true }).click();
      await page.keyboard.press('Enter');
      answered = 'in the terminal';
      return null;
    }
    const { session } = await call('sessions.get', { id });
    const atPrompt = provider === 'claude' ? session.state === 'waiting' : /Ask Codex to do anything|› /.test(tail) && !/Press enter to continue/.test(tail.slice(-300));
    return atPrompt ? (answered || 'no question asked') : null;
  }, 120_000, 'the agent at its prompt', 1000);
}

const typeIn = async (text) => { await page.getByLabel('Terminal', { exact: true }).click(); await page.keyboard.type(text, { delay: 3 }); await sleep(300); await page.keyboard.press('Enter'); };
const compose = async (text) => { await page.locator('#composer').fill(text); await page.getByRole('button', { name: /^(Send|Queue)$/ }).click(); await sleep(800); };

/* ── the run ───────────────────────────────────────────────────────────── */

const site = makeSite();
const keys = {};
let claude = null;
let codex = null;
let shell = null;
try {
  await launch();
  results.push(`NOTE run in ${dataDir}, site ${site}, screenshots ${shots}${SPEND ? ', spending model turns' : ', rehearsal: no model is called'}`);

  await step('1. open the project through the dialog', async () => {
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, site);
    await page.locator('.dialog').waitFor({ timeout: 10_000 });
    await shot('open-project');
    const choose = page.getByRole('button', { name: 'Choose…' });
    await choose.scrollIntoViewIfNeeded();
    await choose.click();
    await page.getByLabel('Name', { exact: true }).fill('Corner Shop');
    await page.getByRole('button', { name: 'Open project' }).click();
    await page.waitForURL(/#\/p\/CS\/board/, { timeout: 10_000 });
    const [p] = await call('projects.list');
    if (p?.key !== 'CS' || !p.git) throw new Error(`project not opened as CS: ${JSON.stringify(p)}`);
    return `${p.name} (${p.key})`;
  });

  await step('1. project settings: accounts and the worktree setup command', async () => {
    await page.getByRole('button', { name: 'Corner Shop settings' }).click();
    const dlg = page.locator('.dialog');
    const other = (await call('accounts.list')).find((a) => a.provider === 'claude' && !a.isDefault && a.signedIn === 'yes');
    if (other) {
      await dlg.getByLabel('Claude Code', { exact: true }).click();
      await page.getByRole('option').filter({ hasText: new RegExp(`^${other.label}`) }).first().click();
      await sleep(500);
      if ((await call('projects.list'))[0].accounts.claude !== other.id) throw new Error('choosing another Claude account did not stick');
      await dlg.getByLabel('Claude Code', { exact: true }).click();
      await page.getByRole('option').filter({ hasText: /^Your default/ }).click();
      await sleep(500);
    }
    await dlg.getByLabel('Setup command').fill('npm run -s setup');
    await shot('project-settings');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await sleep(600);
    const p = (await call('projects.list'))[0];
    if (p.setupCommand !== 'npm run -s setup' || p.accounts.claude) throw new Error(`settings not saved: ${JSON.stringify({ setup: p.setupCommand, accounts: p.accounts })}`);
    return other ? 'switched Claude to another account and back; setup command saved' : 'setup command saved (only one Claude account)';
  });

  await step('2. file a bug, a feature and an idea', async () => {
    await newCard({ type: 'Bug', title: 'Cart subtotal ignores quantity', body: 'subtotal() in src/cart.js adds each price but never multiplies by quantity; its test fails.', criteria: ['npm test passes', 'subtotal() multiplies price by quantity'], priority: 1 });
    await newCard({ type: 'Feature', title: 'Tell shoppers how far they are from free shipping', body: 'Add freeShippingRemaining(cart) to src/cart.js: dollars left until the subtotal reaches $50, never below 0.', criteria: ['freeShippingRemaining(cart) returns dollars left to $50, never below 0', 'A node --test test covers it'] });
    await newCard({ type: 'Idea', title: 'Dark mode for the shop page', priority: 3 });
    const cards = await call('cards.list', { projectId: (await call('projects.list'))[0].id });
    for (const c of cards) keys[c.type] = c.key;
    await shot('three-cards');
    if (cards.length !== 3 || cards.some((c) => c.status !== 'inbox')) throw new Error(`cards: ${cards.map((c) => `${c.key} ${c.status}`).join(', ')}`);
    return Object.entries(keys).map(([t, k]) => `${t} ${k}`).join(', ');
  });

  await step('2. Draft with Claude', async () => {
    await page.locator('.rail').getByRole('button', { name: /New card/ }).click();
    const dlg = page.locator('.dialog');
    await dlg.getByLabel('Title').fill('coupon codes are case sensitive?? save10 does nothing but SAVE10 works');
    await dlg.getByRole('button', { name: 'Draft with Claude' }).click();
    await waitFor(async () => !(await dlg.locator('.draft-row').textContent()).includes('reading the project'), 240_000, 'the draft', 2000);
    const title = await dlg.getByLabel('Title').inputValue();
    const criteria = await dlg.locator('.draft-criteria li').count();
    const said = await dlg.locator('.draft-row').textContent();
    await shot('drafted');
    if (!criteria || /coupon codes are case sensitive\?\?/.test(title)) throw new Error(`no draft: ${said}`);
    await dlg.getByRole('button', { name: 'Create card' }).click();
    await sleep(800);
    return `“${title}”, ${criteria} criteria; ${said.match(/reported \$[\d.]+/)?.[0] ?? 'no cost reported'}`;
  }, { spends: true });

  await step('2. a criterion in the drawer, and Inbox → Ready three ways', async () => {
    await openCard(keys.idea);
    await drawer().getByLabel('New criterion').fill('Colours follow prefers-color-scheme');
    await drawer().getByLabel('New criterion').press('Enter');
    await sleep(500);
    await openCard(keys.bug);
    await drawer().getByRole('button', { name: 'Accept to Ready' }).click();
    await sleep(600);
    await drawer().getByRole('button', { name: 'Close card' }).click();
    await page.locator(`.card[data-key="${keys.feature}"]`).focus();
    await page.keyboard.press('a');
    await sleep(800);
    const drafted = (await call('cards.list', { projectId: (await call('projects.list'))[0].id })).find((c) => !Object.values(keys).includes(c.key));
    if (drafted) { await page.locator(`.card[data-key="${drafted.key}"]`).dragTo(page.locator('.column-ready')); await sleep(1000); }
    await shot('board-ready');
    const status = async (k) => (await call('cards.get', { id: k })).status;
    const got = [await status(keys.bug), await status(keys.feature), drafted ? await status(drafted.key) : 'ready'];
    if (got.some((s) => s !== 'ready') || !(await call('cards.get', { id: keys.idea })).criteria.length) throw new Error(`statuses ${got.join(', ')}`);
    return drafted ? 'drawer, A key and drag' : 'drawer and A key (no drafted card to drag)';
  });

  await step('6. a one-off shell, renamed; an agent cannot claim from the Inbox', async () => {
    shell = await startSession({ agent: 'Shell' });
    await page.locator('#session-title button').click();
    await page.locator('#session-rename').fill('Poke at the coupon box');
    await page.keyboard.press('Enter');
    await sleep(600);
    await typeIn(`wanigan claim ${keys.idea}`);
    const out = await waitFor(async () => { const s = await screen(shell); return /Inbox/.test(s.slice(s.lastIndexOf('wanigan claim'))) ? s : null; }, 15_000, 'the claim answer');
    await shot('inbox-claim-refused');
    const title = (await call('sessions.get', { id: shell })).session.title;
    if (title !== 'Poke at the coupon box') throw new Error(`not renamed: ${title}`);
    if ((await call('cards.get', { id: keys.idea })).status !== 'inbox') throw new Error('the Inbox card was claimed');
    return out.slice(out.lastIndexOf('wanigan:')).split('\n')[0].trim();
  });

  await step('3. Claude Code on the bug, on its own branch: folder trust from Needs you', async () => {
    claude = await startSession({ cardKey: keys.bug, agent: 'Claude Code', sonnet: true, ownBranch: true });
    const how = await toPrompt(claude, 'claude');
    await shot('claude-ready');
    const { session } = await call('sessions.get', { id: claude });
    if (/Transcript saving is off/.test(await screen(claude))) throw new Error('Claude says transcript saving is off');
    // Ask before acting, so permission prompts show: manual mode, if the account starts in another.
    await page.getByLabel('Terminal', { exact: true }).click();
    for (let i = 0; i < 4 && !/manual mode on|\? for shortcuts/.test((await screen(claude)).slice(-300)); i++) { await page.keyboard.press('Shift+Tab'); await sleep(700); }
    return `trust ${how}; ${session.model} · ${session.effort}; worktree ${session.cwd.split('/').pop()}`;
  });

  await step('3. its first turn: claim, fix, permission prompts answered from Needs you', async () => {
    await go(`#/p/CS/s/${claude}`);
    await compose(`Work on ${keys.bug}: run \`wanigan claim ${keys.bug}\`, then fix subtotal() in src/cart.js so \`npm test\` passes. Do not commit yet.`);
    const r = await drive(claude);
    const card = await call('cards.get', { id: keys.bug });
    const diff = sh('git diff --stat', card.worktree.path);
    if (!/cart\.js/.test(diff)) note(`no change to cart.js yet (${r.end}; asked ${r.asked.length})`);
    return `${r.asked.length} prompts approved; ${diff.trim().split('\n').at(-1)}`;
  }, { spends: true });

  await step('3. the turn in the timeline: its diff, Undo and Redo', async () => {
    await go(`#/p/CS/s/${claude}`);
    const wt = (await call('cards.get', { id: keys.bug })).worktree.path;
    const before = sh('git status --short', wt);
    const diffButton = page.locator('.turn-diff').first();
    if (await diffButton.count()) { await diffButton.click(); await sleep(1000); await shot('turn-diff'); await page.keyboard.press('Escape'); }
    const { last } = await call('sessions.checkpoints', { id: claude });
    if (!last || last.refusal) note(`Undo not offered: ${last?.refusal ?? 'no last turn'}`);
    await page.locator('.timeline').getByRole('button', { name: 'Undo this turn' }).first().click();
    await page.locator('.dialog').getByRole('button', { name: /^Undo / }).click();
    await sleep(1500);
    const undone = sh('git status --short', wt);
    await page.locator('.timeline').getByRole('button', { name: 'Redo' }).first().click();
    await page.locator('.dialog').getByRole('button', { name: /^Redo / }).click();
    await sleep(1500);
    const redone = sh('git status --short', wt);
    await shot('after-redo');
    if (undone === before || redone !== before) throw new Error(`undo/redo did not round-trip: before ${before} undone ${undone} redone ${redone}`);
    return `undo put back ${before.trim().split('\n').length} file(s); redo restored them`;
  }, { spends: true });

  await step('3. a refused prompt leaves Claude waiting, not asking', async () => {
    await go(`#/p/CS/s/${claude}`);
    await compose(`Run \`wanigan show ${keys.bug}\` and tell me its title in one line.`);
    const r = await settle(claude);
    if (r.state !== 'permission') note(`it did not ask (${r.state}): its account may allow that command`);
    await answer(claude, false);
    const st = await waitFor(async () => { const s = (await call('sessions.get', { id: claude })).session; return s.state !== 'permission' ? s : null; }, 10_000, 'the state to leave permission');
    await shot('after-refusal');
    if (st.state !== 'waiting') throw new Error(`after No it is ${st.state}`);
    return st.activity;
  }, { spends: true });

  await step('3. reply from Needs you, with an image, to submit for review', async () => {
    await go(`#/p/CS/s/${claude}`);
    await compose('In one line, what did you change?');
    await go('#/needs');
    await waitFor(async () => (await call('needs.list')).some((x) => x.sessionId === claude && x.kind === 'waiting'), 180_000, 'Finished a turn', 1000);
    const image = join(shots, readdirOne(shots));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, image);
    const row = page.locator('.need-waiting .need-row').first();
    await row.getByRole('button', { name: 'Reply' }).click();
    await row.getByRole('button', { name: 'Attach images or files' }).click();
    await waitFor(async () => (await call('attachments.list', { to: { session: claude } })).length > 0, 15_000, 'the attachment');
    await row.locator('textarea').fill(`Run npm test, commit on this branch, then submit with \`wanigan review ${keys.bug} --evidence <a file with the test output> --note "..."\`. The screenshot is the board, for context.`);
    await shot('reply-with-image');
    await row.getByRole('button', { name: 'Send', exact: true }).click();
    const r = await drive(claude);
    const card = await call('cards.get', { id: keys.bug });
    if (card.status !== 'review') note(`card is ${card.status} after the reply (${r.asked.length} prompts)`);
    return `${card.key} in review with ${card.evidence.length} evidence; tokens ${JSON.stringify((await call('sessions.tokens', { id: claude })).usage?.output ?? null)} out`;
  }, { spends: true });

  await step('4. AI review', async () => {
    await openCard(keys.bug);
    const ai = drawer().locator('.ai-review');
    await ai.getByRole('button', { name: /Ask Claude to check it|Check again/ }).click();
    const r = await waitFor(async () => { const c = await call('cards.get', { id: keys.bug }); return c.reviews[0] && c.reviews[0].state !== 'running' ? c.reviews[0] : null; }, 300_000, 'the review', 3000);
    await shot('ai-review');
    if (r.state !== 'done') throw new Error(r.error);
    return `${r.result.verdict}; quotes found ${r.result.criteria.map((c) => c.quoteFound).join(', ')}; $${r.costUsd?.toFixed(2)}`;
  }, { spends: true });

  await step('4. send back with a note; the agent reads it with wanigan status', async () => {
    await openCard(keys.bug);
    await drawer().getByRole('button', { name: 'Send back…' }).click();
    await drawer().getByLabel('What should change?').fill('Also add a test that a negative quantity adds no line.');
    await drawer().getByRole('button', { name: 'Send back', exact: true }).click();
    await sleep(800);
    const actions = await drawer().locator('.drawer-actions').innerText();
    if (!/Open terminal/.test(actions)) throw new Error(`a sent-back card with its agent live offers: ${actions}`);
    await drawer().locator('.drawer-actions').getByRole('link', { name: 'Open terminal' }).click();
    await page.waitForURL(/\/s\//);
    await compose(`${keys.bug} was sent back. Run \`wanigan status\`, do what my note says, commit, and resubmit.`);
    const r = await drive(claude);
    const said = await screen(claude);
    const card = await call('cards.get', { id: keys.bug });
    if (card.status !== 'review') note(`card is ${card.status} (${r.asked.length} prompts)`);
    return /negative/i.test(said.slice(-3000)) ? 'it acted on the note' : 'resubmitted';
  }, { spends: true });

  await step('4. approve, then reopen with a new criterion', async () => {
    const card = await call('cards.get', { id: keys.bug });
    if (card.status !== 'review') note(`${card.key} is ${card.status}, not in review`);
    await openCard(keys.bug);
    await drawer().getByRole('button', { name: 'Approve' }).click();
    await sleep(800);
    await drawer().getByRole('button', { name: 'Reopen as not fixed…' }).click();
    await drawer().getByLabel('What is still wrong?').fill('removeItem with an unknown id should leave the cart as it was');
    await drawer().getByRole('button', { name: 'Reopen', exact: true }).click();
    await sleep(800);
    const after = await call('cards.get', { id: keys.bug });
    await shot('reopened');
    if (after.status !== 'ready' || !after.reopened) throw new Error(`after reopen: ${after.status}`);
    return `${after.criteria.length} criteria, the newest is what is still wrong`;
  }, { spends: true });

  await step('5. Codex on the feature, on its own branch: setup, hooks, the work', async () => {
    codex = await startSession({ cardKey: keys.feature, agent: 'Codex', ownBranch: true });
    const how = await toPrompt(codex, 'codex');
    const setup = (await call('cards.get', { id: keys.feature })).sessions.find((s) => s.title.startsWith('Setup'));
    const setupSaid = setup ? (await screen(setup.id)).match(/Setup done[^\r\n]*/)?.[0] : null;
    if (!setupSaid) note('the setup command did not print its line');
    if (!SPEND) return `trust ${how}; ${setupSaid}`;
    await typeIn(`Work on ${keys.feature}: run \`wanigan claim ${keys.feature}\`, add freeShippingRemaining(cart) to src/cart.js with a node --test test, run npm test, commit on this branch, then submit with \`wanigan review ${keys.feature} --evidence <file with the test output> --note "..."\`. Keep it small.`);
    const r = await drive(codex);
    const { events } = await call('sessions.get', { id: codex });
    const card = await call('cards.get', { id: keys.feature });
    await shot('codex-done');
    if (card.status !== 'review') note(`card is ${card.status} after Codex's turn`);
    return `trust ${how}; ${setupSaid}; ${events.some((e) => e.event === 'PreToolUse') ? 'its hooks reported tool calls' : 'OSC 9 only'}; ${r.asked.length} approvals`;
  });

  await step('5. the branch, merge refusals, merges, and the pull-request confirm', async () => {
    if (codex) { await call('sessions.stop', { id: codex }); }
    if (claude) { await call('sessions.stop', { id: claude }); }
    await sleep(2000);
    const card = await call('cards.get', { id: keys.feature });
    if (!card.worktree) throw new Error('the feature card has no branch');
    if (card.status === 'review') { await openCard(keys.feature); await drawer().getByRole('button', { name: 'Approve' }).click(); await sleep(800); }
    await go(`#/p/CS/changes?branch=${keys.feature}`);
    await shot('branch-changes');
    await openCard(keys.feature);
    const merge = async () => {
      await drawer().getByRole('button', { name: /^Merge into / }).click();
      await drawer().locator('.branch-actions').first().getByRole('button', { name: 'Merge', exact: true }).click();
      await sleep(2000);
      return (await page.locator('.toast').allTextContents()).at(-1) ?? '';
    };
    sh('printf "\\nWork in progress.\\n" >> README.md', site);
    const head = sh('git rev-parse HEAD', site);
    const refused = await merge();
    sh('git checkout -- README.md', site);
    if (!/uncommitted changes/.test(refused) || sh('git rev-parse HEAD', site) !== head) throw new Error(`a dirty folder did not refuse: ${refused}`);
    const merged = await merge();
    await page.locator('.toast').getByRole('button').first().click().catch(() => {});
    const done = (await call('cards.get', { id: keys.feature })).status === 'done';
    let pr = 'no confirm (card not done)';
    if (done) {
      sh('git -c user.email=s@example.com -c user.name=S commit -q --allow-empty -m "One more"', card.worktree.path);
      sh('git remote add origin git@github.com:example/corner-shop.git', site);
      await openCard(keys.bug); await openCard(keys.feature);
      await drawer().getByRole('button', { name: 'Open a pull request…' }).click();
      await sleep(1500);
      pr = await drawer().locator('.pr-confirm').innerText();
      await shot('pull-request-confirm');
      await drawer().locator('.pr-confirm').getByRole('button', { name: /^(Cancel|Close)$/ }).click();
      sh('git remote remove origin', site);
      if ((await call('cards.get', { id: keys.feature })).pullRequest) throw new Error('a pull request was recorded');
    }
    return `refused with a dirty folder; ${merged}; confirm: ${pr.split('\n')[0].slice(0, 120)}`;
  });

  await step('7. pause: agents asked to wrap up, claims and sessions blocked; resume', async () => {
    await go('#/p/CS/board');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const said = await page.locator('.dialog').innerText();
    await page.locator('.dialog').getByRole('button', { name: 'Pause project' }).click();
    await sleep(1000);
    const toast = (await page.locator('.toast').allTextContents()).at(-1) ?? '';
    await go(`#/p/CS/s/${shell}`);
    await typeIn(`wanigan claim ${keys.idea}`);
    await sleep(2000);
    const claim = (await screen(shell)).slice(-400);
    const start = await call('sessions.start', { projectId: (await call('projects.list'))[0].id, provider: 'shell' }).then(() => 'started', (e) => e.message);
    await shot('paused');
    await go('#/p/CS/board');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await sleep(800);
    if (!/paused/.test(claim) || !/paused/.test(start) || (await call('projects.list'))[0].pausedAt) throw new Error(`claim: ${claim.slice(-120)} start: ${start}`);
    return `${toast} ${/live agent/.test(said) ? '(the dialog offered to ask live agents)' : ''}`.trim();
  });

  await step('6. promote the one-off to a card', async () => {
    await go(`#/p/CS/s/${shell}`);
    await page.getByRole('button', { name: 'Make this a card' }).click();
    await page.locator('.dialog').getByRole('button', { name: 'Create card' }).click();
    await sleep(1000);
    const s = (await call('sessions.get', { id: shell })).session;
    if (!s.cardId) throw new Error('the session has no card');
    return (await page.locator('.toast').allTextContents()).at(-1);
  });

  await step('8. Talk to Wanigan: what needs me, and what the agents did', async () => {
    await go('#/p/CS/board');
    await page.getByRole('button', { name: /^Talk to Wanigan/ }).click();
    const chat = page.locator('.chat');
    const ask = async (q) => {
      await chat.locator('textarea').fill(q);
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await sleep(1500);
      await waitFor(async () => (await chat.locator('.chat-thinking').count()) === 0, 240_000, 'an answer', 2000);
      return chat.locator('.chat-turn').last().locator('button.linkish').allTextContents();
    };
    const one = await ask('What needs me here right now?');
    const two = await ask('Summarize what the agents did today, with card keys.');
    await shot('talk-to-wanigan');
    await chat.getByRole('button', { name: 'Close' }).click();
    if (!two.length) note('the summary named no card');
    return `card links: ${[...new Set([...one, ...two])].join(', ')}`;
  }, { spends: true });

  await step('9. search: a card, a session, what an agent said', async () => {
    const search = async (q) => {
      await page.keyboard.press('Meta+k');
      await page.locator('.palette').getByLabel('Search').fill(q);
      await sleep(2500);
      const text = await page.locator('.palette-results').innerText();
      await page.keyboard.press('Escape');
      return text;
    };
    const card = await search('free shipping');
    const session = await search('Poke at the coupon');
    const said = await search('Setup done');
    await shot('search');
    if (!card.includes(keys.feature) || !/Poke at the coupon box/.test(session) || !/Setup done/.test(said)) throw new Error('a search found nothing');
    return 'all three found';
  });

  await step('10. History: read and resume a conversation', async () => {
    await go('#/p/CS/history');
    await sleep(2500);
    const items = await call('history.list', { projectId: (await call('projects.list'))[0].id });
    if (!items.length) note('no conversation was saved here (a rehearsal sends no prompt, so there is none)');
    await page.getByRole('button', { name: /^Read / }).first().click();
    await sleep(1200);
    await shot('history-reader');
    await page.getByRole('button', { name: 'Close the conversation' }).click();
    await page.getByRole('button', { name: /^Resume / }).first().click();
    await sleep(1000);
    if (await page.locator('.dialog').count()) await page.locator('.dialog').getByRole('button', { name: /^Resume as / }).click();
    await page.waitForURL(/\/s\//, { timeout: 30_000 });
    const id = (await page.evaluate(() => location.hash)).split('/s/')[1];
    await sleep(3000);
    await call('sessions.stop', { id });
    return `${items.length} conversations; resumed ${items[0].title ?? items[0].firstPrompt} and stopped it`;
  });

  await step('11. activity, and a decision a new session is told', async () => {
    await go('#/p/CS/activity');
    const activity = await page.locator('.activity').innerText();
    await shot('activity');
    await go('#/p/CS/decisions');
    await page.getByLabel('Decision', { exact: true }).fill('Prices are whole dollars: never introduce cents in cart math');
    await page.getByRole('button', { name: 'Record decision' }).click();
    await sleep(800);
    if (!SPEND) return `${activity.split('\n').length} activity lines; decision recorded`;
    const told = await startSession({ agent: 'Claude Code', sonnet: true });
    await toPrompt(told, 'claude');
    await typeIn('Without running any tools, list the project decisions you were told at the start, in one line.');
    await waitFor(async () => (await call('sessions.get', { id: told })).events.at(-1)?.event === 'Stop', 120_000, 'the answer', 1000);
    claude = told;
    if (!/whole dollars/i.test((await screen(told)).slice(-1500))) throw new Error('the new session did not say the decision');
    return 'the new session repeated the decision';
  });

  await step('12. Watch, alerts or notifications, both themes', async () => {
    await go('#/running');
    await page.getByRole('radiogroup', { name: 'Layout' }).getByRole('radio', { name: /Watch/ }).click();
    await sleep(2500);
    const tiles = await page.locator('.watch-tile').count();
    await shot('watch');
    await app.evaluate(({ Notification }) => {
      globalThis.notes = [];
      const show = Notification.prototype.show;
      Notification.prototype.show = function () { globalThis.notes.push(this.title); return show.call(this); };
    });
    const doomed = await call('sessions.start', { projectId: (await call('projects.list'))[0].id, provider: 'shell', title: 'Doomed build' });
    await call('sessions.input', { id: doomed.id, data: 'exit 3\n' });
    await sleep(4000);
    const alert = await page.locator('.alert').count();
    const notes = await app.evaluate(() => globalThis.notes);
    for (const want of ['dark', 'light']) {
      for (let i = 0; i < 3 && !(await page.locator('.theme-switch').getAttribute('aria-label')).startsWith(`Theme: ${want}`); i++) { await page.locator('.theme-switch').click(); await sleep(300); }
      for (const hash of ['#/p/CS/board', '#/needs', '#/running']) { await go(hash); await shot(`${want}-${hash.replace(/\W+/g, '-')}`); }
    }
    for (let i = 0; i < 3 && !(await page.locator('.theme-switch').getAttribute('aria-label')).includes('match the system'); i++) { await page.locator('.theme-switch').click(); await sleep(300); }
    if (!alert && !notes.length) throw new Error('a failed session raised neither an alert nor a notification');
    return `${tiles} tiles; ${alert ? 'in-window alert' : `notification “${notes[0]}”`}`;
  });

  await step('13. skills: copy one to the test site; MCP list and store, cancelled', async () => {
    await go('#/skills');
    await sleep(2500);
    await page.locator('.lib-group').first().locator('button.lib-row').first().click();
    await sleep(800);
    await page.locator('.lib-detail').getByRole('button', { name: 'Copy to a project…' }).click();
    await sleep(1200);
    const plan = await page.locator('.dialog').innerText();
    await page.locator('.dialog').getByRole('button').filter({ hasText: /^Copy/ }).last().click();
    await sleep(1200);
    const copied = sh('find .claude -name SKILL.md | head -3', site).trim();
    await go('#/mcp');
    await sleep(2000);
    await page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio').filter({ hasText: /Store/ }).click();
    await sleep(800);
    await page.getByRole('button', { name: 'Add…' }).first().click();
    await sleep(1200);
    const add = await page.locator('.dialog').innerText();
    await shot('mcp-add-confirm');
    await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
    await go('#/accounts');
    await sleep(2000);
    await shot('accounts');
    if (!copied) throw new Error(`no skill copied: ${plan.slice(0, 200)}`);
    return `${copied}; MCP confirm shows “${(add.match(/claude mcp add[^\n]*|codex mcp add[^\n]*/) ?? ['a command'])[0].slice(0, 80)}”`;
  });

  await step('14. quit with a live session: asked, the core stays, the session is still live', async () => {
    const live = (await call('sessions.list', { live: true })).map((s) => s.id);
    if (!live.length) note('nothing live to keep');
    const pid = corePid();
    await app.evaluate(({ dialog }) => {
      globalThis.asked = [];
      globalThis.answers = [1, 0];
      dialog.showMessageBox = async (...args) => { const o = args.at(-1); globalThis.asked.push(o.message); return { response: globalThis.answers.shift() ?? 0, checkboxChecked: false }; };
    });
    await app.evaluate(({ app: a }) => a.quit());
    await sleep(1500);
    const asked = await app.evaluate(() => globalThis.asked);
    const closed = new Promise((r) => app.once('close', r));
    await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
    await Promise.race([closed, sleep(10_000)]);
    await sleep(1000);
    if (!alive(pid)) throw new Error('the core quit with the app');
    await launch();
    const still = (await call('sessions.list', { live: true })).map((s) => s.id);
    await shot('relaunched');
    if (corePid() !== pid || live.some((id) => !still.includes(id))) throw new Error('the relaunch did not find the same core and sessions');
    return `${asked[0]}; ${still.length} still live`;
  });
} catch (error) {
  results.push(`FAIL ${String(error.message).split('\n')[0]}`);
} finally {
  const pid = corePid();
  if (app && page) {
    for (const s of await call('sessions.list', { live: true }).catch(() => [])) await call('sessions.stop', { id: s.id }).catch(() => {});
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }); }).catch(() => {});
  }
  if (app) await app.close().catch(() => {});
  if (pid && alive(pid)) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  }
  if (!KEEP) {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(dirname(site), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

console.log(results.map((r) => `  ${r}`).join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);

/** The first screenshot of this run, to attach as an image. */
function readdirOne(dir) {
  return existsSync(dir) ? execFileSync('/bin/ls', [dir], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.png'))[0] : '';
}
