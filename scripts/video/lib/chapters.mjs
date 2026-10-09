// The story, as things a person does in the app. Each chapter runs in either
// mode: the demo (the app's own sample world, stand-in agents) or real (a
// throwaway shop site, the real Claude Code and Codex). Where the two differ,
// the difference is said in the code, beside it.
//
// The rule for every step: drive the real UI the way a person would. Calls
// straight to the core (take.api) only *watch* (what state is a session in?),
// set things up before the recording starts, or answer a CLI's start-up
// questions during footage the edit cuts.
import { SHOP_CARDS } from './shop.mjs';

const DEMO = {
  project: 'Northstar Storefront',
  key: 'NS',
  main: {
    type: 'feature',
    title: 'Remember the shipping address at checkout',
    body: 'Returning customers type their address every time. Offer the last one they used.',
    criteria: ['A returning customer sees their last address filled in', 'They can change it before paying'],
  },
  /** A card already in Ready, for Codex. */
  side: 'NS-5',
  /** The card the demo's stand-in already submitted, with evidence and an AI review. */
  review: 'NS-7',
  /** The stand-in session the demo has stopped on a permission prompt. */
  asking: 'NS-6',
};

/** Claude Code's folder-trust question, and Codex's. */
const TRUST = /trust (the files in )?this folder|do you trust|allow codex to work in this folder|trust the contents/i;
const CODEX_UPDATE = /Update available!.*Skip until next version/i;

/* ── set-up, before the recording starts ─────────────────────────────────── */

async function common(take) {
  const { page } = take;
  // Nothing open: no dialog the app opened by itself, no drawer.
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[aria-modal="true"]').count())) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

/** Dismiss every in-window alert, so the take starts clean. */
async function clearAlerts(page) {
  for (let i = 0; i < 12; i++) {
    const x = page.locator('.alert .alert-x').first();
    if (!(await x.count())) break;
    await x.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

export async function setupDemo(take) {
  const { page } = take;
  await take.until(async () => (await take.api('projects.list')).length >= 3, { timeout: 90_000, what: 'the demo to seed its projects' });
  await common(take);
  const projects = await take.api('projects.list');
  const ns = projects.find((p) => p.key === DEMO.key);
  const accounts = await take.api('accounts.list');
  return {
    ...DEMO,
    projectId: ns.id,
    jevMode: ns.jev,
    accounts,
    before: async () => {
      await page.evaluate(() => { location.hash = '#/running'; });
      await page.waitForSelector('.topbar [role="radio"]');
      await page.locator('.topbar [role="radio"]', { hasText: 'Watch' }).click();
      await page.waitForSelector('.watch-tile .xterm-rows', { timeout: 15_000 });
      await page.waitForTimeout(1500);
      await clearAlerts(page);
      await take.human.place(1180, 700);
      await page.waitForTimeout(800);
    },
  };
}

/**
 * Real mode: open the shop, keep only each agent's default account in view,
 * and give the board a few days of history, all through the app's own API
 * and before the recording starts. Finished cards are submitted by a shell
 * session with `wanigan review`, as an agent would, then approved.
 */
export async function setupReal(take, { shop, jevPause }) {
  const { page } = take;
  await common(take);
  const accounts = await take.api('accounts.list');
  // Only the defaults stay listed in this throwaway data folder, so no other
  // account's name can turn up in a picker. Nothing on disk changes.
  for (const a of accounts) if (!a.isDefault) await take.api('accounts.remove', { id: a.id });
  const project = await take.api('projects.add', { path: shop, name: 'Corner Shop' });
  await common(take);
  const key = project.key;
  const create = async (c, status) => {
    const card = await take.api('cards.create', { projectId: project.id, type: c.type, title: c.title, body: c.body ?? '', priority: c.priority ?? 2, status });
    for (const text of c.criteria ?? []) await take.api('criteria.add', { cardId: card.id, text });
    return card;
  };
  // Two finished cards, worked and submitted by a shell, approved by the owner.
  for (const c of SHOP_CARDS.done) {
    const card = await create({ ...c, criteria: ['Checked by hand in the browser'] }, 'ready');
    const s = await take.api('sessions.start', { projectId: project.id, provider: 'shell', cardId: card.id, title: c.title, cols: 120, rows: 30 });
    await take.until(async () => /\S/.test(await take.screen(s.id)), { timeout: 20_000, what: 'a shell prompt' });
    await page.waitForTimeout(800);
    await take.api('sessions.input', { id: s.id, data: `wanigan review ${card.key} --evidence README.md --note "Done; checked in the browser."\n` });
    await take.until(async () => (await take.api('cards.get', { id: card.id })).status === 'review', { timeout: 20_000, what: `${card.key} to reach Review` });
    const detail = await take.api('cards.get', { id: card.id });
    for (const cr of detail.criteria) await take.api('criteria.update', { id: cr.id, done: true });
    await take.api('cards.approve', { id: card.id });
    await take.api('sessions.stop', { id: s.id });
  }
  const side = await create(SHOP_CARDS.side, 'ready');
  for (const c of SHOP_CARDS.ready) await create(c, 'ready');
  for (const c of SHOP_CARDS.inbox) await create(c, 'inbox');
  await take.until(async () => (await take.api('sessions.list', { live: true })).length === 0, { timeout: 20_000, what: 'the set-up shells to end' });

  let jev = await take.api('jev.status');
  if (!jev.configured && jevPause) {
    // A person pastes a key off camera; nothing of it is recorded or logged.
    take.log('  Jev has no key. Paste one in Settings › Jev in the window; the take waits (up to 10 minutes).');
    await page.evaluate(() => { location.hash = '#/settings'; });
    jev = await take.until(async () => { const s = await take.api('jev.status'); return s.configured ? s : null; }, { timeout: 600_000, every: 1500, what: 'a Jev key' });
  }
  take.note(jev.configured ? 'Jev: configured; chapter b shows the real Jev' : 'Jev: no key; chapter b shows Jev off (use the demo take for Jev)');
  await page.evaluate((k) => { location.hash = `#/p/${k}/board`; }, key);
  await page.waitForSelector('.card');
  // The seeded shells' "finished" needs are not this story's; settle them.
  for (const n of await take.api('needs.list')) if (n.sessionId && ['waiting', 'failed', 'interrupted'].includes(n.kind)) await take.api('sessions.seen', { id: n.sessionId });
  return {
    project: 'Corner Shop', key, projectId: project.id, jevMode: project.jev, jev: jev.configured, accounts,
    main: SHOP_CARDS.main, side: side.key,
    before: async () => {
      await page.waitForTimeout(1200);
      await clearAlerts(page);
      await take.human.place(1180, 700);
    },
  };
}

/* ── shared moves ────────────────────────────────────────────────────────── */

const railLink = (page, text) => page.locator('.rail a, .rail button').filter({ hasText: text }).first();
const dialog = (page) => page.locator('[role="dialog"][aria-modal="true"]').last();
const drawer = (page) => page.locator('aside.drawer').first();
const tile = (page, key) => page.locator(`.card[data-key="${key}"]`).first();

async function openBoard({ page, human, state }) {
  await human.click(railLink(page, state.project));
  await page.waitForSelector('.board .card');
  await page.waitForTimeout(500);
}

async function closeDrawer({ page, human }) {
  const close = drawer(page).getByRole('button', { name: 'Close card' }).first();
  if (await close.count()) await human.click(close);
  await page.waitForTimeout(400);
}

/**
 * Answer a CLI's start-up questions (folder trust; Codex's update offer) during
 * footage the edit cuts. Only output since the last answer is read: the
 * session's replay keeps the question's text after it is answered. Ready means
 * the agent says it is at its prompt and its output has gone quiet: Codex says
 * so as soon as it draws anything, even a question.
 */
async function throughStartup(take, sessionId, label, { from: start = 0 } = {}) {
  let from = start;
  let quiet = 0;
  let lastLength = -1;
  let waitingSince = null;
  return take.until(async () => {
    const { session } = await take.api('sessions.get', { id: sessionId });
    const { replay } = await take.api('sessions.watch', { id: sessionId });
    const fresh = plainText(replay.slice(from));
    if (CODEX_UPDATE.test(fresh)) {
      take.note(`${label}: skipped Codex's update offer (never updates during a take)`);
      from = await choose(take, sessionId, SKIP, label);
      quiet = 0;
      waitingSince = null;
      return false;
    }
    if (TRUST.test(fresh)) {
      take.note(`${label}: answered the folder-trust question`);
      from = await choose(take, sessionId, YES, label);
      quiet = 0;
      waitingSince = null;
      return false;
    }
    if (!['starting', 'running', 'waiting'].includes(session.state)) throw new Error(`${label} went to ${session.state} while starting`);
    quiet = session.state === 'waiting' && replay.length === lastLength ? quiet + 1 : 0;
    lastLength = replay.length;
    // An idle screen that keeps redrawing (a clock, a rotating tip) is never quiet: waiting for 10 s will do.
    waitingSince = session.state === 'waiting' ? waitingSince ?? Date.now() : null;
    return quiet >= 3 || (waitingSince && Date.now() - waitingSince > 10_000) ? session : false;
  }, { timeout: 150_000, every: 700, what: `${label} to reach its prompt` });
}

/** The safe answers in the CLIs' start-up menus: trust this folder; skip the update (and never "Skip until next version"). */
const YES = /^[❯›]\s*(\d+\.\s*)?Yes\b/;
const SKIP = /^[❯›]\s*(\d+\.\s*)?Skip\b(?! until)/;

/**
 * Move a start-up menu to the answer `wanted` matches, reading the screen after
 * every move, and press Enter only once it is the one selected. Claude Code's
 * trust question starts on "No, exit"; Codex's update offer starts on "Update
 * now", which would run brew. Nothing is chosen if the answer cannot be found.
 */
async function choose(take, sessionId, wanted, label) {
  for (let i = 0; i < 4; i++) {
    const { replay } = await take.api('sessions.watch', { id: sessionId });
    const tail = plainText(replay.slice(-4000));
    const at = Math.max(tail.lastIndexOf('❯'), tail.lastIndexOf('›'));
    if (at >= 0 && wanted.test(tail.slice(at, at + 80))) return answer(take, sessionId, '\r');
    await take.api('sessions.input', { id: sessionId, data: '\x1b[B' });
    await take.page.waitForTimeout(600);
  }
  throw new Error(`${label}: its start-up menu never showed the safe answer selected; nothing was chosen`);
}

/**
 * Send the key that answers a question, and return where the session's output
 * stood at that moment: whatever is drawn after it (the next question, say) is
 * new. Measured before any wait, or a question drawn meanwhile would be missed.
 */
async function answer(take, sessionId, key) {
  const { replay } = await take.api('sessions.watch', { id: sessionId });
  await take.api('sessions.input', { id: sessionId, data: key });
  await take.page.waitForTimeout(1500);
  return replay.length;
}

const plainText = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\s+/g, ' ');

/* ── chapters ────────────────────────────────────────────────────────────── */

/** (a) The problem: many agents, many terminals. */
async function chapterA(ctx) {
  const { take, page, human, mode, state } = ctx;
  if (mode === 'demo') {
    // Running › Watch: four live terminals at once.
    await take.focus('.watch-tile >> nth=0', 8);
    await human.glide('.watch-tile >> nth=0', { at: 'center' });
    await take.read('a1', 300);
    await take.focus('.watch-tile >> nth=3', 8);
    await human.glide('.watch-tile >> nth=3');
    await take.read('a2', 300);
    await openBoard(ctx);
  } else {
    await page.waitForTimeout(600);
    await take.focus('.board');
    await take.read('a1', 300);
    await human.glide('.column-done');
    await take.read('a2', 300);
  }
  await take.focus('.board');
  await take.read('a3', 400);
}

/** (b) Cards, criteria and Jev. */
async function chapterB(ctx) {
  const { take, page, human, state, mode } = ctx;
  const card = state.main;
  await take.focus('.column-inbox');
  await take.caption('b1');
  await human.click('button[aria-label="New card in Inbox"]');
  const d = dialog(page);
  await d.waitFor();
  await take.focus(d);
  await human.click(d.getByRole('radio', { name: card.type === 'bug' ? 'Bug' : card.type === 'task' ? 'Task' : 'Feature' }));
  await human.click(d.getByLabel('Title'));
  await human.type(card.title);
  await human.click(d.getByLabel('Description'));
  await human.type(card.body, { cps: 34 });
  await human.click(d.locator('#new-criterion'));
  for (const c of card.criteria) {
    await human.type(c, { cps: 30 });
    await human.press('Enter', 350);
  }
  await page.waitForTimeout(500);
  await human.click(d.getByRole('button', { name: 'Create card' }));
  const made = page.locator('.column-inbox .card').filter({ hasText: card.title }).first();
  await made.waitFor({ timeout: 10_000 });
  state.mainKey = await made.getAttribute('data-key');
  take.note(`the new card is ${state.mainKey}`);
  await take.focus(made);
  await page.waitForTimeout(400);

  const jevOn = mode === 'demo' || state.jev;
  if (jevOn) {
    const chip = made.locator('.jev-chip, .sev').first();
    await chip.waitFor({ timeout: 15_000 }).catch(() => take.note('no Jev chip appeared on the new card'));
    await take.caption('b2');
    await human.glide(chip);
    await page.waitForTimeout(1200);
    // Jev's read in the drawer: its suggestion, how sure, and the odds behind it.
    await human.click(made);
    await drawer(page).waitFor();
    const section = drawer(page).locator('.jev-section');
    await human.scrollTo(section, drawer(page), { margin: 120 });
    await take.focus(section);
    await take.caption('b3');
    await human.glide(section.locator('.jev-odds, .jev-line').first());
    await page.waitForTimeout(1600);
    await closeDrawer(ctx);
    // The project's switch: Off, Reads, Reads and accepts.
    const picker = page.locator('.jev-strip [role="radiogroup"]').first();
    await take.focus(page.locator('.jev-strip'));
    await take.caption('b4');
    await human.glide(picker);
    await page.waitForTimeout(800);
    await human.click(picker.getByRole('radio', { name: 'Off', exact: true }));
    await page.waitForTimeout(1200);
    await human.click(picker.getByRole('radio', { name: state.jevMode === 'accept' ? 'Reads and accepts' : 'Reads', exact: true }));
    await page.waitForTimeout(1000);
  } else {
    // No key: say Jev is optional, where the board offers to set it up.
    const hint = page.locator('.jev-strip').first();
    if (await hint.count()) {
      await take.focus(hint);
      await take.caption('b4off');
      await human.glide(hint);
      await page.waitForTimeout(1500);
    }
  }

  await take.caption('b5');
  await take.focus('.column-inbox');
  await human.click(tile(page, state.mainKey));
  await drawer(page).waitFor();
  await page.waitForTimeout(600);
  await human.click(drawer(page).getByRole('button', { name: 'Accept to Ready' }).first());
  await page.locator(`.column-ready .card[data-key="${state.mainKey}"]`).waitFor({ timeout: 10_000 });
  await take.focus('.column-ready');
  await page.waitForTimeout(1200);
}

/** Pick the agent, model and effort in the New session dialog, then start it. */
async function startSession(ctx, { cardKey, provider, model, effort, ownBranch, showOther, captions = [] }) {
  const { take, page, human } = ctx;
  const card = tile(page, cardKey);
  if (!(await drawer(page).count()) || !(await drawer(page).getAttribute('aria-label'))?.includes(cardKey)) {
    await human.click(card);
    await drawer(page).waitFor();
    await page.waitForTimeout(500);
  }
  await human.click(drawer(page).getByRole('button', { name: 'Start a session' }).first());
  const d = dialog(page);
  await d.waitFor();
  await take.focus(d);
  if (captions[0]) await take.caption(captions[0]);
  const agent = d.getByRole('radiogroup', { name: 'Agent' });
  const other = provider === 'claude' ? 'Codex' : 'Claude Code';
  const mine = provider === 'claude' ? 'Claude Code' : 'Codex';
  if (showOther) {
    // Show the choice: the other agent and its own models, then back.
    await human.click(agent.getByRole('radio', { name: other }));
    await page.waitForTimeout(900);
    const models = d.getByLabel('Model');
    if (await models.count()) {
      await human.click(models);
      await page.waitForTimeout(1600);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  }
  await human.click(agent.getByRole('radio', { name: mine }));
  await page.waitForTimeout(500);
  if (captions[1]) await take.caption(captions[1]);
  if (model) {
    await human.click(d.getByLabel('Model'));
    const option = page.locator('[role="listbox"] [role="option"]').filter({ hasText: model }).first();
    await human.click(option);
  }
  if (effort) await human.click(d.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: effort, exact: true }));
  const branch = d.locator('.check-row').filter({ hasText: 'On its own branch' }).locator('input');
  if (ownBranch !== undefined && (await branch.count()) && (await branch.isChecked()) !== ownBranch) await human.click(branch);
  await page.waitForTimeout(700);
  const before = new Set((await take.api('sessions.list', { live: true })).map((s) => s.id));
  await human.click(d.getByRole('button', { name: `Start ${mine}` }));
  const session = await take.until(async () => (await take.api('sessions.list', { live: true })).find((s) => !before.has(s.id)), { timeout: 20_000, what: `${mine} to start` });
  return session;
}

/** (c) Start a session on the card: Claude Code, and Codex on another card. */
async function chapterC(ctx) {
  const { take, page, human, state, mode } = ctx;
  await take.caption('c1');
  // The drawer is still open on the main card, now in Ready.
  const claude = await startSession(ctx, {
    cardKey: state.mainKey, provider: 'claude', model: 'Sonnet', effort: 'Low', ownBranch: false, showOther: true, captions: [null, 'c2'],
  });
  state.claude = claude.id;
  await page.waitForSelector('.xterm-rows', { timeout: 15_000 });
  if (mode === 'real') {
    // The CLI's start-up (folder trust) is cut from the edit.
    take.cut(true);
    await throughStartup(take, claude.id, 'Claude Code');
    take.cut(false);
  } else {
    await page.waitForTimeout(1500);
  }
  // Back on the board, the card has moved to Working.
  await openBoard(ctx);
  await take.focus('.column-working');
  await take.caption('c3');
  await human.glide(tile(page, state.mainKey));
  await page.waitForTimeout(1500);

  // Codex on another card, on its own branch.
  await take.caption('c4');
  const codex = await startSession(ctx, { cardKey: state.side, provider: 'codex', effort: 'Low', ownBranch: true });
  state.codex = codex.id;
  await page.waitForSelector('.xterm-rows', { timeout: 15_000 });
  if (mode === 'real') {
    take.cut(true);
    await throughStartup(take, codex.id, 'Codex');
    take.cut(false);
    watchCodex(take, codex.id, state.side);
  } else {
    await page.waitForTimeout(2000);
  }
}

/**
 * Codex works in the background of this story. If it stops for approval (its
 * sandbox refuses the socket the `wanigan` command talks to), the take answers
 * with its highlighted choice, Yes, so the story's one on-camera prompt stays
 * Claude Code's. Once its card is in Review its work is done, and the take
 * stops it, as a person would. Every answer and the stop are noted in take.json.
 *
 * Only a real approval is answered. Codex 0.155's turn-complete notification
 * carries its reply, which Wanigan reads as a permission prompt; that one is
 * left alone (and noted once), and stopping the finished session clears it.
 */
function watchCodex(take, id, cardKey) {
  let busy = false;
  let misread = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { session } = await take.api('sessions.get', { id });
      const card = await take.api('cards.get', { id: cardKey });
      if (card.status === 'review' && ['running', 'working', 'waiting', 'permission'].includes(session.state)) {
        take.note(`Codex submitted ${cardKey}; stopped its session off camera`);
        await take.api('sessions.stop', { id });
        clearInterval(timer);
      } else if (session.state === 'permission' && /^Approval requested/i.test(session.activity ?? '')) {
        take.note(`Codex asked approval (${(session.activity ?? '').slice(0, 60)}); answered Yes off camera`);
        await take.api('sessions.input', { id, data: '\r' });
        await take.page.waitForTimeout(1500);
      } else if (session.state === 'permission' && !misread) {
        misread = true;
        take.note(`Wanigan shows Codex as asking permission for a notification that is not an approval: "${(session.activity ?? '').slice(0, 60)}"`);
      }
      if (!['starting', 'running', 'working', 'waiting', 'permission'].includes(session.state)) clearInterval(timer);
    } catch { /* the window is between views */ }
    busy = false;
  }, 2000);
  take.timers = [...(take.timers ?? []), timer];
}

/**
 * Before typing a prompt: if the terminal on screen still shows a start-up
 * question, a prompt typed into it would answer it (Codex's trust question
 * quits on "n"). Answer it first, off camera.
 */
async function clearQuestions(take, sessionId, label) {
  const visible = () => take.page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent).join(' '));
  let cut = false;
  // Only what is on screen now counts: the replay still holds questions already answered.
  for (let i = 0; i < 4; i++) {
    const rows = await visible();
    const update = CODEX_UPDATE.test(rows);
    if (!update && !TRUST.test(rows)) break;
    if (!cut) { take.cut(true); cut = true; }
    take.note(`${label} still showed a start-up question before its prompt; answered it off camera`);
    await choose(take, sessionId, update ? SKIP : YES, label);
  }
  if (cut) {
    await throughStartup(take, sessionId, label, { from: (await take.api('sessions.watch', { id: sessionId })).replay.length });
    take.cut(false);
  }
}

/** Give the terminal on screen the keyboard, clicking into it only if it does not have it. */
async function focusTerminal({ page, human }) {
  const has = await page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'));
  if (!has) await human.click('.xterm-screen', { at: 'center' });
}

const promptFor = (key) => `Work on ${key}. Keep the change small. When it works, run npm test, save its output to test-output.txt, and submit ${key} for review with that file as evidence.`;

/** (d) The agent at work, Needs you, and the answer in the terminal. */
async function chapterD(ctx) {
  const { take, page, human, state, mode } = ctx;
  // Codex first: its prompt, typed into its terminal (this is its view now).
  await take.focus('.xterm-screen');
  await take.caption('d0', { pos: 'top' });
  if (mode === 'real') {
    await clearQuestions(take, state.codex, 'Codex');
    await human.click('.xterm-screen');
    await human.type(promptFor(state.side), { cps: 40 });
    await human.press('Enter', 600);
  }
  // Then Claude Code's terminal, from the board's Working card.
  await openBoard(ctx);
  await human.click(tile(page, state.mainKey).locator('.claim-line'));
  await page.waitForSelector('.xterm-rows');
  await take.focus('.xterm-screen');
  await take.caption('d1', { pos: 'top' });
  if (mode === 'real') {
    await clearQuestions(take, state.claude, 'Claude Code');
    await human.click('.xterm-screen');
    await human.type(promptFor(state.mainKey), { cps: 30 });
    await human.press('Enter', 1200);
    await take.until(async () => (await take.api('sessions.get', { id: state.claude })).session.state === 'working', { timeout: 60_000, what: 'Claude Code to start working' });
    take.speed(6);
    await page.waitForTimeout(15_000);
  } else {
    await page.waitForTimeout(2000);
  }

  // Every live session at once.
  await human.click(railLink(page, 'Running'));
  await page.locator('.topbar [role="radio"]', { hasText: 'Watch' }).click().catch(() => {});
  await page.waitForSelector('.watch-tile', { timeout: 10_000 });
  await take.focus('.watch-tile >> nth=0', 8);
  await take.caption('d2');
  if (mode === 'real') {
    // Until Claude Code stops to ask: the edit plays this at 6x.
    await take.until(async () => {
      const { session } = await take.api('sessions.get', { id: state.claude });
      if (session.state === 'permission') return true;
      if (!['starting', 'running', 'working', 'waiting'].includes(session.state)) throw new Error(`Claude Code went to ${session.state}`);
      return false;
    }, { timeout: 8 * 60_000, every: 700, what: 'Claude Code to ask permission' });
    // Real time again, long enough to see its tile say so.
    take.speed(1);
    await page.waitForTimeout(2600);
  } else {
    await page.waitForTimeout(2500);
  }

  // Needs you: the prompt, with the exact command.
  await take.caption('d3');
  const alert = page.locator('.alert').first();
  if (await alert.count()) { await take.focus(alert); await human.glide(alert); await page.waitForTimeout(1600); }
  await human.click(railLink(page, 'Needs you'));
  const row = page.locator('.need-permission .need-row').filter({ hasText: mode === 'demo' ? state.asking : state.mainKey }).first();
  await row.waitFor({ timeout: 15_000 });
  await take.focus(row);
  await page.waitForTimeout(1000);
  await take.caption('d4');
  await human.glide(row.locator('.need-asks, .need-main').first());
  await page.waitForTimeout(1500);
  const answerButton = row.getByRole('link', { name: 'Answer in terminal' }).or(row.getByRole('button', { name: 'Answer in terminal' })).first();
  await take.focus(answerButton, 80);
  await human.click(answerButton);
  await page.waitForSelector('.xterm-rows');
  await take.focus('.xterm-screen');
  await page.waitForTimeout(1800);
  if (mode === 'real') {
    // Claude Code's own question, answered with its first choice: Yes. The
    // terminal takes the keyboard when a session opens on a prompt; click into
    // it only if it did not.
    await focusTerminal(ctx);
    await human.press('Enter', 1500);
    take.speed(6);
    await take.caption('d5', { pos: 'top' });
    // Until the card is in Review. Another prompt on the way is answered the same way, on camera.
    await take.until(async () => {
      if ((await take.api('cards.get', { id: state.mainKey })).status === 'review') return true;
      const { session } = await take.api('sessions.get', { id: state.claude });
      if (session.state === 'permission') {
        take.note('Claude Code asked permission again; answered Yes in its terminal');
        await page.waitForTimeout(1200);
        await focusTerminal(ctx);
        await human.press('Enter', 800);
      } else if (!['starting', 'running', 'working', 'waiting'].includes(session.state)) {
        throw new Error(`Claude Code went to ${session.state} before submitting`);
      }
      return false;
    }, { timeout: 8 * 60_000, every: 1000, what: `${state.mainKey} to be submitted for review` });
    // Real time again: its terminal says it submitted the card.
    take.speed(1);
    await page.waitForTimeout(2600);
    // End on the board, where chapter e begins, so the crossfade joins like with like.
    await openBoard(ctx);
    await take.focus('.column-review');
    await human.glide(tile(page, state.mainKey));
    await page.waitForTimeout(1500);
  } else {
    await page.waitForTimeout(1500);
    await take.caption('d5');
    await openBoard(ctx);
    await take.focus('.column-review');
    await human.glide(tile(page, state.review));
    await page.waitForTimeout(2000);
  }
}

/** (e) Review with evidence and the AI review, approve, Done. */
async function chapterE(ctx) {
  const { take, page, human, state, mode } = ctx;
  const key = mode === 'demo' ? state.review : state.mainKey;
  if (!(await page.locator('.board').count())) await openBoard(ctx);
  await take.focus('.column-review');
  await take.caption('e1');
  await human.click(tile(page, key));
  const dr = drawer(page);
  await dr.waitFor();
  await page.waitForTimeout(800);
  const evidence = dr.locator('.drawer-section').filter({ has: page.locator('h3', { hasText: 'Evidence' }) }).first();
  await human.scrollTo(evidence, dr, { margin: 140 });
  await take.focus(evidence);
  await page.waitForTimeout(1500);

  // The AI review: Claude Code, read-only, against each criterion.
  const review = dr.locator('.ai-review');
  await human.scrollTo(review, dr, { margin: 100 });
  await take.focus(review);
  await take.caption('e2');
  const ask = review.getByRole('button', { name: /Ask Claude to check it|Check again/ }).first();
  const before = (await take.api('cards.get', { id: key })).reviews?.[0]?.id ?? null;
  await human.click(ask);
  if (mode === 'real') take.speed(6);
  await take.until(async () => {
    const r = (await take.api('cards.get', { id: key })).reviews?.[0];
    return r && r.id !== before && r.state !== 'running' ? r : null;
  }, { timeout: 6 * 60_000, every: 800, what: 'the AI review to finish' });
  if (mode === 'real') take.speed(1);
  await page.waitForTimeout(1200);
  await human.scrollTo(review.locator('.ai-criteria'), dr, { margin: 160 });
  await take.caption('e3');
  await human.glide(review.locator('.ai-quote, .ai-c').first());
  await page.waitForTimeout(2000);

  // Tick what the evidence proves, then approve.
  const criteria = dr.locator('ul.criteria');
  await human.scrollTo(criteria, dr, { margin: 160 });
  for (const box of await criteria.locator('input[type="checkbox"]').all()) {
    if (!(await box.isChecked())) await human.click(box, { after: 350 });
  }
  await take.caption('e4');
  await human.scrollTo(dr.locator('.drawer-actions'), dr, { margin: 40 });
  await take.focus(dr.locator('.drawer-actions'), 40);
  await human.click(dr.getByRole('button', { name: 'Approve' }).first());
  await page.waitForTimeout(1200);
  await closeDrawer(ctx);
  await take.focus('.column-done');
  await human.glide(page.locator(`.column-done .card[data-key="${key}"]`));
  await page.waitForTimeout(2200);
}

/**
 * (f) Git. Today: the project's Changes view. When the git workbench lands
 * (stage, commit, history, push), drive it here; the captions f2 is waiting
 * for it in story.mjs.
 */
async function chapterF(ctx) {
  const { take, page, human } = ctx;
  if (!(await page.locator('.tabs').count())) await openBoard(ctx);
  await human.click(page.locator('.tabs a', { hasText: 'Changes' }));
  await page.waitForSelector('.changes', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await take.focus('.changes');
  await take.caption('f1');
  const added = page.locator('.dl-add').first();
  if (await added.count()) await human.glide(added);
  await page.waitForTimeout(1800);
  const split = page.locator('.changes .toolbar [role="radio"]', { hasText: 'Split' });
  if (await split.count()) {
    await human.click(split);
    await page.waitForTimeout(2400);
  }
  // Placeholder until the git workbench exists: say only what is on screen.
  await page.waitForTimeout(800);
}

export const CHAPTER_RUNNERS = { a: chapterA, b: chapterB, c: chapterC, d: chapterD, e: chapterE, f: chapterF };
