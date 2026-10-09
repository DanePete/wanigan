#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE LOCAL-MODEL CHECK. Runs Claude Code on Qwen3-Coder through LM Studio on
// this Mac, in the real app, the way the owner would: New session, "On this
// Mac", Start, answer the folder question, ask for a file to be read. It spends
// nothing (the model is local) but needs LM Studio with the model on disk, and
// it is never part of `npm test`.
//
//   npm run local:check
//
// What it proves, from Wanigan's own record: the session started on the local
// model, LM Studio loaded it with the module's context, the agent's hooks
// reported a turn with a Read tool call, and the answer came back. A throwaway
// WANIGAN_DATA_DIR and test site are used; screenshots land in
// .artifacts/local-model/.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.artifacts', 'local-model');
mkdirSync(shots, { recursive: true });
const LMS = join(homedir(), '.lmstudio', 'bin', 'lms');
const KEY = 'qwen/qwen3-coder-30b';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/[ \t]+/g, ' ');

if (!existsSync(LMS)) { console.log('LM Studio is not installed: nothing to check.'); process.exit(2); }
const onDisk = JSON.parse(execFileSync(LMS, ['ls', '--llm', '--json'], { encoding: 'utf8' }));
if (!onDisk.some((m) => m.modelKey === KEY)) { console.log(`${KEY} is not on this Mac yet: get it first.`); process.exit(2); }

const dataDir = mkdtempSync(join(tmpdir(), 'wg-local-'));
const site = join(mkdtempSync(join(tmpdir(), 'wg-local-site-')), 'corner-shop');
mkdirSync(site, { recursive: true });
writeFileSync(join(site, 'README.md'), '# Corner Shop\n\nA tiny shop page.\n');
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: site });
execFileSync('git', ['-c', 'user.name=Check', '-c', 'user.email=check@example.com', 'commit', '-qm', 'start', '--allow-empty'], { cwd: site });

const env = { ...process.env, WANIGAN_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (/^(VSCODE_|CLAUDECODE$|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|SESSION_ATTENDED)$|CLAUDE_PID$|CLAUDE_EFFORT$|AI_AGENT$)/.test(k)) delete env[k];

let app;
let page;
let corePid = 0;
const call = (method, params = {}) => page.evaluate(([m, p]) => window.wanigan.call(m, p), [method, params]);
const screen = async (id) => plain((await call('sessions.watch', { id })).replay);
async function waitFor(read, ms, what, every = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

try {
  app = await _electron.launch({ args: [root], env, timeout: 60_000 });
  page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForSelector('.rail', { timeout: 30_000 });
  corePid = existsSync(join(dataDir, 'core.json')) ? JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')).pid : 0;
  const project = await call('projects.add', { path: site, name: 'Corner Shop', key: 'CS' });
  results.push(`project ${project.key} opened`);

  // The owner's way in: the project in the rail, then New session, Claude Code, the model "On this Mac".
  await page.evaluate(() => { location.hash = '#/p/CS/board'; });
  await page.waitForSelector('.rail-projects a:has-text("Corner Shop")', { timeout: 15_000 });
  await page.keyboard.press('Meta+t');
  const dlg = page.locator('.dialog');
  await dlg.waitFor();
  await dlg.getByRole('radio', { name: 'Claude Code' }).click();
  await dlg.locator('.model-row .select').click();
  await page.waitForSelector('.sel-group:has-text("On this Mac")', { timeout: 15_000 });
  await page.getByRole('option').filter({ hasText: 'Qwen3-Coder 30B' }).click();
  await page.screenshot({ path: join(shots, 'new-session.png') });
  const startedAt = Date.now();
  await dlg.getByRole('button', { name: /^Start Claude Code/ }).click();
  await page.waitForURL(/#\/p\/CS\/s\//, { timeout: 240_000 });
  const id = (await page.evaluate(() => location.hash)).split('/s/')[1];
  results.push(`session started on the local model in ${Math.round((Date.now() - startedAt) / 1000)} s (LM Studio started and the model loaded first)`);

  const loaded = JSON.parse(execFileSync(LMS, ['ps', '--json'], { encoding: 'utf8' }));
  const qwen = loaded.find((m) => m.modelKey === KEY || m.identifier === KEY);
  results.push(qwen ? `LM Studio has ${KEY} loaded${qwen.contextLength ? ` with a ${qwen.contextLength}-token context` : ''}` : `FAIL: ${KEY} is not loaded: ${JSON.stringify(loaded).slice(0, 200)}`);

  // Folder trust, answered in the terminal as the owner would, then its prompt.
  let answered = false;
  await waitFor(async () => {
    const s = await screen(id);
    const tail = s.slice(-1500);
    if (!answered && /Quick safety check|trust (the files|this folder)/i.test(tail) && /Yes, I trust|Yes, proceed/.test(tail)) {
      await page.getByLabel('Terminal', { exact: true }).click();
      // "No, exit" is listed first and chosen; move to "Yes, I trust this folder".
      if (/❯\s*(\d\.\s*)?No/.test(tail.slice(tail.search(/Quick safety check|trust (the files|this folder)/i)))) { await page.keyboard.press('ArrowDown'); await sleep(300); }
      await page.keyboard.press('Enter');
      answered = true;
      return null;
    }
    const { session } = await call('sessions.get', { id });
    return session.state === 'waiting' ? true : null;
  }, 180_000, 'Claude Code at its prompt', 1000);
  results.push(`Claude Code reached its prompt${answered ? ' after the folder question was answered' : ''}`);
  await page.screenshot({ path: join(shots, 'at-prompt.png') });

  // A turn that needs a tool: the answer is only in the file.
  const asked = Date.now();
  await page.locator('#composer').fill('Use the Read tool to read README.md, then reply with only its first heading text and nothing else.');
  await page.getByRole('button', { name: /^(Send|Queue)$/ }).click();
  const events = await waitFor(async () => {
    const { session, events: ev } = await call('sessions.get', { id });
    const stopped = ev.some((e) => e.event === 'Stop' && e.at >= asked) && session.state === 'waiting';
    return stopped ? ev : null;
  }, 1_800_000, 'the turn to end', 2000);
  const turn = events.filter((e) => e.at >= asked);
  const names = turn.map((e) => (e.tool ? `${e.event}(${e.tool})` : e.event));
  results.push(`the turn took ${Math.round((Date.now() - asked) / 1000)} s; hooks reported: ${names.join(', ')}`);
  results.push(turn.some((e) => e.event === 'UserPromptSubmit') ? 'the prompt was reported (UserPromptSubmit)' : 'FAIL: no UserPromptSubmit');
  results.push(turn.some((e) => e.event === 'PreToolUse' && e.tool === 'Read') && turn.some((e) => e.event === 'PostToolUse' && e.tool === 'Read')
    ? 'the model called a tool: Read, before and after' : 'FAIL: no Read tool call was reported');
  const tail = (await screen(id)).slice(-2500);
  results.push(/Corner Shop/.test(tail.slice(tail.lastIndexOf('README'))) ? 'the answer, read from the file, came back: "Corner Shop"' : `FAIL: the answer did not show: ${tail.slice(-400)}`);
  await page.screenshot({ path: join(shots, 'after-turn.png') });

  const { session } = await call('sessions.get', { id });
  results.push(session.model === `local/lmstudio/${KEY}` ? 'the session’s record keeps the local model' : `FAIL: the session's model is ${session.model}`);
  await call('sessions.stop', { id });
} catch (error) {
  results.push(`FAIL: ${error.message.split('\n')[0]}`);
  if (page) await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
} finally {
  if (app) await app.close().catch(() => {});
  if (corePid) { try { process.kill(corePid, 'SIGTERM'); } catch { /* gone */ } }
  await sleep(1500);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(dirname(site), { recursive: true, force: true });
}
for (const r of results) console.log(`  ${r}`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
