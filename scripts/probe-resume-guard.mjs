#!/usr/bin/env node
/*
 * A conversation Wanigan offers to resume is one the harness can actually open.
 *
 * Wanigan chooses the Claude CLI's conversation id at launch and passes it as
 * --session-id, so the id is recorded before the CLI has created anything under
 * it. The CLI files projects/<slug>/<id>.jsonl when the session takes its first
 * turn, and a session that exits without one leaves the id naming nothing. On
 * 2026-09-18 such a session was offered as resumable three times; each attempt
 * built a worktree, answered "No conversation found with session ID", exited 1,
 * and wrote another row chained to the last.
 *
 * Unit coverage asserts the predicate. This asserts the product: a session is
 * started and killed without ever taking a turn — which is the defect's own
 * setup, reproduced rather than simulated — and then resumed.
 *
 *   1. NO TRANSCRIPT. The resume must be refused, in words that say the session
 *      ended before it took a turn rather than blaming the conversation.
 *   2. TRANSCRIPT PRESENT (control). With a transcript filed under the id, the
 *      same resume must no longer be refused for that reason. Without this, a
 *      guard that refuses everything would pass case 1, and a resume nobody can
 *      perform is the same defect wearing the other mask.
 *
 * Everything happens under a named account whose directory lives inside the
 * isolated user-data root, so the transcript written for the control — and the
 * folder it sits in — belong to the probe and not to the operator's own
 * ~/.claude. A Wanigan already open on this machine is untouched. No prompt is
 * submitted, so no turn is taken and nothing is spent.
 *
 * Usage:  npm run build && node scripts/probe-resume-guard.mjs
 * Exit 0 when both cases pass, 1 otherwise.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchWanigan } from './electron-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');
const tag = randomUUID();
const say = (...a) => console.log(...a);
const unwrap = (v) => (v && typeof v === 'object' && 'data' in v ? v.data : v);
/** Claude Code's folder name for a directory; the rule is in src/shared/claude-slug.ts. */
const slugFor = (dir) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-resume-ud-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-resume-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# probe\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', 'commit', '-qm', 'init'], { cwd: repo });

const env = { ...process.env, WANIGAN_PROBE_TAG: tag };
delete env.CLAUDE_CONFIG_DIR;

let app, page, failures = 0;
const check = (ok, what, detail) => {
  say(`${ok ? '  ok ' : ' FAIL'}  ${what}`);
  if (detail !== undefined) say(`        ${detail}`);
  if (!ok) failures += 1;
};
/** Attempt the resume and report the refusal, if there is one. */
const tryResume = async (opts) => page.evaluate(async (o) => {
  try { return { ok: true, session: await window.wanigan.sessions.create(o) }; }
  catch (e) { return { ok: false, message: String(e?.message ?? e) }; }
}, opts);

try {
  ({ app, page } = await launchWanigan(electron, { root: ROOT, userData, env }));
  const waniganData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const accountDir = fs.mkdtempSync(path.join(waniganData, 'probe-acct-'));
  const account = unwrap(await page.evaluate((d) => window.wanigan.accounts.create(
    { harness: 'claude-code', label: 'ProbeResume', configDir: d }), accountDir));
  const projectId = unwrap(await page.evaluate((dir) => window.wanigan.projects.add(dir), repo)).id;

  // The defect's own setup: a session that starts and never takes a turn.
  const started = unwrap(await page.evaluate((o) => window.wanigan.sessions.create(o),
    { providerId: 'claude', projectId, accountId: account.id }));
  await new Promise((r) => setTimeout(r, 3000));
  await page.evaluate((id) => window.wanigan.sessions.kill(id), started.id);
  await new Promise((r) => setTimeout(r, 1500));

  const past = unwrap(await page.evaluate((p) => window.wanigan.sessions.past(p), projectId));
  const row = past.find((s) => s.id === started.id);
  if (!row) throw new Error('the killed session never reached Recent, so there is nothing to resume');
  say(`recorded id    : ${row.conversationId}`);
  const filed = path.join(accountDir, 'projects', slugFor(fs.realpathSync.native(repo)));
  say(`transcript     : ${fs.existsSync(path.join(filed, `${row.conversationId}.jsonl`)) ? 'present' : 'none, as expected'}\n`);

  const refused = await tryResume({ providerId: 'claude', projectId, accountId: account.id,
    resumeFrom: { sessionId: row.id, conversationId: row.conversationId } });
  check(!refused.ok && /took a turn/.test(refused.message ?? ''),
    'a conversation the harness never created is refused, and the refusal says the session ended before it took a turn',
    refused.ok ? 'the resume was allowed' : refused.message);
  if (refused.ok) await page.evaluate((id) => window.wanigan.sessions.kill(id), unwrap(refused.session).id);

  // The control: file the transcript the CLI would reopen, and the same resume
  // must stop being refused for that reason.
  fs.mkdirSync(filed, { recursive: true });
  fs.writeFileSync(path.join(filed, `${row.conversationId}.jsonl`),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'a turn' }, timestamp: new Date().toISOString() })}\n`);
  const allowed = await tryResume({ providerId: 'claude', projectId, accountId: account.id,
    resumeFrom: { sessionId: row.id, conversationId: row.conversationId } });
  check(allowed.ok || !/took a turn/.test(allowed.message ?? ''),
    'with the transcript filed under that id the same resume is no longer refused, so the guard reads evidence rather than refusing every resume',
    allowed.ok ? 'allowed' : allowed.message);
  if (allowed.ok) await page.evaluate((id) => window.wanigan.sessions.kill(id), unwrap(allowed.session).id);
} catch (error) {
  say(` FAIL  the probe could not complete: ${error?.message ?? error}`);
  failures += 1;
} finally {
  try { await app?.close(); } catch { /* already gone */ }
  try { execFileSync('/usr/bin/pkill', ['-f', `WANIGAN_PROBE_TAG=${tag}`]); } catch { /* none left */ }
  for (const dir of [userData, repo]) fs.rmSync(dir, { recursive: true, force: true });
}

say(failures ? `\n${failures} failed` : '\nboth cases passed');
process.exit(failures ? 1 : 0);
