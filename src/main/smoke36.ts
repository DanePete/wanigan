import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/*
 * Helper sweep · P7 — review depth and goal budgets. Real repositories, real
 * git and the real database; no PTY, no provider, no network, no spend.
 */

export function repoFixture(prefix: string): { dir: string; git: (...args: string[]) => string; write: (rel: string, text: string) => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  return { dir, git, write };
}

function insertSession(id: string, projectId: string | null, projectPath: string, base: string | null, opts: { worktree?: string | null; title?: string } = {}) {
  const now = Date.now();
  db().prepare(`INSERT INTO session_log (id, provider_id, harness_id, project_id, project_path, project_name, started_at, ended_at, exit_code, worktree, baseline_head, baseline_dirty_json, title)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'claude', 'claude-code', projectId, projectPath, path.basename(projectPath),
    now - 600_000, null, null, opts.worktree ?? null, base, '[]', opts.title ?? null);
}

function insertEvent(sessionId: string, event: string, over: { tool?: string; paths?: string[]; summary?: string; ok?: number | null; at?: number; detail?: string } = {}): number {
  const res = db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json, detail) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sessionId, over.at ?? Date.now(), event, over.tool ?? null, over.summary ?? null, null, over.ok ?? null, over.paths ? JSON.stringify(over.paths) : null, over.detail ?? null);
  return Number(res.lastInsertRowid);
}

async function source(rel: string): Promise<string> {
  const { app } = await import('electron');
  try { return fs.readFileSync(path.join(app.getAppPath(), 'src', rel), 'utf8'); } catch { return ''; }
}

/** Item 1: an operator message split into asks, stored per turn, hinted from evidence at the Stop, and pruned. */
export async function runAskItemsSmoke(check: Check, say: Say): Promise<void> {
  say('── depth · did every ask get answered');
  const asks = await import('./ask-items');
  const { pruneDepthEvidence } = await import('./depth-retention');
  const sid = `p7-asks-${Date.now()}`;
  insertSession(sid, null, '/tmp/p7-asks', null);

  // One ask stores nothing: the message is the ask.
  check(asks.recordAsks(sid, 'Fix the flaky retry test in src/checkout.test.ts.', 'composer') === 0,
    'asks: a one-item message stores nothing and shows nothing extra');
  check(asks.asksFor(sid).length === 0, 'asks: a session with only one-item messages has no checklist');
  check(asks.recordAsks('no-such-session', '1. a thing\n2. another thing', 'composer') === 0, 'asks: a session Wanigan has no record of stores nothing');
  let threw = false;
  try { asks.recordAsks({ id: 'x' }, 'a; b', 'composer'); } catch { threw = true; }
  check(threw, 'asks: a malformed session id from the renderer is refused');

  const sent = Date.now() - 50_000;
  const stored = asks.recordAsks(sid, [
    '1. Update src/checkout.ts to reuse the stored payment',
    '2. run `npm test`',
    '3. Also document it in docs/retries.md',
  ].join('\n'), 'composer', sent);
  check(stored === 3, 'asks: a three-item message stores three items', stored);

  let listed = asks.asksFor(sid);
  check(listed.length === 1 && listed[0].state === 'unobserved', 'asks: a send with no hook events at all is unobserved, not waiting forever', listed[0]?.state);

  // The turn: prompt, an edit, a failing test run, then the Stop.
  insertEvent(sid, 'UserPromptSubmit', { at: sent + 400 });
  listed = asks.asksFor(sid);
  check(listed[0].state === 'running' && listed[0].items.every((i) => i.hints !== null), 'asks: after the prompt the turn is running and hints are read from its window', listed[0].state);
  insertEvent(sid, 'PostToolUse', { at: sent + 2_000, tool: 'Edit', paths: ['/tmp/p7-asks/src/checkout.ts'], summary: 'src/checkout.ts', ok: 1 });
  const failed = insertEvent(sid, 'PostToolUseFailure', { at: sent + 4_000, tool: 'Bash', summary: 'npm test', ok: 0 });
  db().prepare("INSERT INTO session_shell_results (event_id, session_id, at, outcome, exit_code, changed_paths_json, diff_state) VALUES (?,?,?,'failed',1,NULL,'absent')").run(failed, sid, sent + 4_000);
  insertEvent(sid, 'Stop', { at: sent + 6_000, ok: 1 });
  // Evidence after the Stop belongs to the next turn and must not count here.
  insertEvent(sid, 'PostToolUse', { at: sent + 9_000, tool: 'Write', paths: ['/tmp/p7-asks/docs/retries.md'], summary: 'docs/retries.md', ok: 1 });

  listed = asks.asksFor(sid);
  const [one, two, three] = listed[0].items;
  check(listed[0].state === 'ended' && listed[0].stopAt === sent + 6_000, 'asks: the Stop closes the turn and the checklist is due', listed[0]);
  check(one.hints?.files[0]?.touched === true && one.hints.files[0].via === 'changed by Edit', 'asks: a file the item names that the turn edited is hinted as changed', one.hints);
  check(two.hints?.commands[0]?.ran === true && two.hints.commands[0].latest?.exitCode === 1 && two.hints.commands[0].latest.ok === false,
    'asks: a command the item names that ran carries its exit code', two.hints);
  check(three.hints?.files[0]?.touched === false, 'asks: a file touched only after the Stop is not credited to the turn', three.hints);
  check(listed[0].items.every((i) => i.tickedAt === null), 'asks: nothing ticks an item except the operator');

  const ticked = asks.tickAsk(one.id, true);
  check(ticked.tickedAt !== null && asks.asksFor(sid)[0].items[0].tickedAt !== null, 'asks: the operator’s tick persists');
  asks.tickAsk(one.id, false);
  check(asks.asksFor(sid)[0].items[0].tickedAt === null, 'asks: a tick can be taken back');

  // A second message in the same session is its own turn.
  asks.recordAsks(sid, 'Rename the helper and also update its callers', 'phone', sent + 20_000);
  listed = asks.asksFor(sid);
  check(listed.length === 2 && listed[0].source === 'phone' && listed[1].stopAt === sent + 6_000,
    'asks: a later message is listed first and the earlier turn keeps its own window', listed.map((m) => [m.source, m.state]));

  // Retention on the event window.
  const before = (db().prepare('SELECT COUNT(*) AS n FROM session_ask_items WHERE session_id = ?').get(sid) as { n: number }).n;
  pruneDepthEvidence(40_000);
  const after = (db().prepare('SELECT COUNT(*) AS n FROM session_ask_items WHERE session_id = ?').get(sid) as { n: number }).n;
  check(before === 5 && after === 2, 'asks: retention removes items older than the window with their messages and keeps newer ones', { before, after });

  // The call sites: the composer records after it writes, the phone after it writes, and retention runs from the queue timer.
  const composer = await source('renderer/src/components/Composer.tsx');
  check((composer.match(/await submitMessage\(sessionId, /g) ?? []).length === 3 && composer.indexOf('await writePayload(sessionId, payload);') < composer.indexOf("window.wanigan.depth.asks.record(sessionId, text)"),
    'asks: every composer send path (send, send now, queue drain) records after the write');
  const index = await source('main/index.ts');
  check(index.indexOf('writeSession(sessionId, `${prompt}\\r`);') > 0 && index.indexOf('recordPhoneAsks(sessionId, prompt);') > index.indexOf('writeSession(sessionId, `${prompt}\\r`);'),
    'asks: the phone prompt path records after it writes');
  check((await source('main/queue.ts')).includes('pruneDepthEvidence(days * DAY_MS)'), 'asks: the retention pass prunes recorded asks on the event window');
}
