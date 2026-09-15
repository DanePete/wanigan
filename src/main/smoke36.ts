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

function repoFixture(prefix: string): { dir: string; git: (...args: string[]) => string; write: (rel: string, text: string) => void } {
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

/** Item 2: goal loop budgets hold a dispatch with a named reason, halt autopilot, and nothing loops. */
export async function runGoalBudgetSmoke(check: Check, say: Say): Promise<void> {
  say('── depth · goal loop budgets hand the work back to a person');
  const repo = repoFixture('wanigan-p7-budgets-');
  const { addProject, removeProject } = await import('./store');
  const control = await import('./control');
  const queue = await import('./queue');
  let worktreeDir: string | null = null;
  try {
    repo.write('README.md', '# budgets\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const project = await addProject(repo.dir);
    const plan = [
      { kind: 'implement' as const, title: 'Build it', instructions: 'Implement.', dependsOn: [], claimPath: null },
      { kind: 'verify' as const, title: 'Check it', instructions: 'Verify.', dependsOn: [0], claimPath: null },
      { kind: 'review' as const, title: 'Decide', instructions: 'Review.', dependsOn: [1], claimPath: null },
    ];
    const goal = control.createDocket({ projectId: project.id, title: 'Budgeted goal', objective: 'Loop no further than allowed.', acceptance: ['Held.'], budgetUsd: 5, plan });
    const implement = goal.nodes.find((n) => n.kind === 'implement')!;
    const verify = goal.nodes.find((n) => n.kind === 'verify')!;
    check(goal.loopBudgets?.maxRounds === null && goal.loopBudgets.maxChangedLines === null, 'budgets: a new goal has no loop limits until a person sets one');

    let refused = false;
    try { control.setLoopBudgets(goal.id, { maxRounds: 0 }); } catch { refused = true; }
    check(refused, 'budgets: a limit that is not a whole number in range is refused, not clamped');

    const limited = control.setLoopBudgets(goal.id, { maxRounds: 2, maxChangedLines: null });
    check(limited.loopBudgets?.maxRounds === 2, 'budgets: the rounds limit is stored on the goal');

    // Two implementation rounds already ran (seeded: a real dispatch would start a paid session).
    db().prepare('INSERT INTO work_node_sessions (node_id, docket_id, session_id, at) VALUES (?,?,?,?)').run(implement.id, goal.id, 'p7-round-1', Date.now() - 60_000);
    db().prepare('INSERT INTO work_node_sessions (node_id, docket_id, session_id, at) VALUES (?,?,?,?)').run(implement.id, goal.id, 'p7-round-2', Date.now() - 30_000);
    control.setAutopilot(goal.id, { enabled: true, providerId: 'claude' });
    const queuedBefore = queue.listQueue(500).filter((q) => q.kind === 'node').length;
    const swept = control.sweepAutopilot();
    const afterSweep = control.docket(goal.id);
    const heldImplement = afterSweep.nodes.find((n) => n.id === implement.id)!;
    check(swept === 0 && queue.listQueue(500).filter((q) => q.kind === 'node').length === queuedBefore,
      'budgets: the sweep dispatches nothing once the rounds limit is reached', { swept });
    check(heldImplement.hold?.reason === 'needs-human: attempts' && /2 implementation rounds have run and this goal allows 2/.test(heldImplement.hold.detail),
      'budgets: the implementation task is held with reason needs-human: attempts and the observed numbers', heldImplement.hold);
    check(!afterSweep.autopilot.enabled && (afterSweep.autopilot.haltedReason ?? '').startsWith('needs-human: attempts'),
      'budgets: autopilot halts and records the reason in the goal’s evidence', afterSweep.autopilot);
    check(control.sweepAutopilot() === 0 && control.docket(goal.id).nodes.find((n) => n.id === implement.id)?.status === 'ready',
      'budgets: a later sweep does nothing, so nothing loops');
    let manual: string | null = null;
    try { await control.startNode(implement.id, { providerId: 'claude' }); } catch (e) { manual = e instanceof Error ? e.message : String(e); }
    check(!!manual && manual.includes('needs-human: attempts') && control.docket(goal.id).nodes.find((n) => n.id === implement.id)?.sessionId === null,
      'budgets: a person’s Start is refused too, with the reason, and no session is created', manual);
    const card = control.boardCards({ projectId: project.id }).find((c) => c.node.id === implement.id);
    check(card?.node.hold?.reason === 'needs-human: attempts', 'budgets: the Board reads the hold from the same rows');

    // Raising the limit clears the hold; the next dispatch decides again.
    const raised = control.setLoopBudgets(goal.id, { maxRounds: 3, maxChangedLines: null });
    check(raised.nodes.every((n) => !n.hold), 'budgets: changing the limits clears every hold on the goal');

    // Diff size: a real worktree with changes against the goal's base.
    worktreeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-p7-impl-')));
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    repo.git('worktree', 'add', '-q', '-b', 'p7-impl', worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'README.md'), '# budgets\nline two\nline three\n');
    fs.writeFileSync(path.join(worktreeDir, 'new.ts'), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
    db().prepare("UPDATE work_nodes SET status='completed', worktree=?, ended_at=? WHERE id=?").run(worktreeDir, Date.now(), implement.id);
    const measured = await control.loopBudgetMeasure(goal.id);
    check(measured.changedLines === 12 && measured.implementRounds === 2,
      'budgets: changed lines are numstat against the goal’s base plus untracked lines, measured in the implementation worktree', measured);
    control.setLoopBudgets(goal.id, { maxRounds: 3, maxChangedLines: 5 });
    control.setAutopilot(goal.id, { enabled: true, providerId: 'claude' });
    db().prepare("UPDATE work_nodes SET dispatch_state='queued' WHERE id=?").run(verify.id);
    await control.startQueuedNode(verify.id);
    const afterDiff = control.docket(goal.id);
    const heldVerify = afterDiff.nodes.find((n) => n.id === verify.id)!;
    check(heldVerify.hold?.reason === 'needs-human: diff size' && /12 changed lines .* limit of 5/.test(heldVerify.hold.detail) && heldVerify.sessionId === null && !heldVerify.queued,
      'budgets: a verify dispatch over the changed-lines limit is held with reason needs-human: diff size, unstarted and unqueued', heldVerify);
    check(!afterDiff.autopilot.enabled && (afterDiff.autopilot.haltedReason ?? '').startsWith('needs-human: diff size'),
      'budgets: autopilot halts on the diff-size hold and records it', afterDiff.autopilot.haltedReason);

    const src = await source('main/control.ts');
    check(src.indexOf('const held = await considerLoopBudgets(nodeId);') > src.indexOf('export async function startNode(')
      && src.indexOf('const held = await considerLoopBudgets(nodeId);') < src.indexOf('session = await createSession('),
      'budgets: startNode asks the budgets before any session is created');
  } finally {
    for (const item of queue.listQueue(500).filter((q) => q.kind === 'node' && q.label.startsWith('Budgeted goal'))) queue.cancelQueued(item.id);
    if (worktreeDir) { try { repo.git('worktree', 'remove', '--force', worktreeDir); } catch { /* best effort */ } }
    try { const { listProjects } = await import('./store'); const p = listProjects().find((x) => x.path === repo.dir); if (p) removeProject(p.id); } catch { /* best effort */ }
  }
}

/** Item 3: maintainability drift between a session's base and latest checkpoint, from real git objects. */
export async function runMaintainabilitySmoke(check: Check, say: Say): Promise<void> {
  say('── depth · maintainability drift per checkpoint (heuristic)');
  const repo = repoFixture('wanigan-p7-drift-');
  const { maintainabilityFor } = await import('./maintainability');
  const block = [
    '  const response = await fetch(url, { headers });',
    '  if (!response.ok) throw new Error(`status ${response.status}`);',
    '  const body = await response.json();',
    '  validateBody(body, schema);',
    '  cache.set(url, body);',
    '  metrics.increment("fetch.ok");',
    '  return body;',
  ];
  repo.write('src/one.ts', ['export async function one(url, headers) {', ...block, '}', ''].join('\n'));
  repo.write('src/two.ts', ['export async function two(url) {', '  return get(url);', '}', ''].join('\n'));
  repo.write('README.md', '# drift\n');
  repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
  const base = repo.git('rev-parse', 'HEAD').trim();
  // The session's turn: copies the block into two.ts, adds comments and blank lines, touches one.ts, and changes the README.
  repo.write('src/one.ts', ['// Shared fetch pipeline.', 'export const retries = 3;', 'export async function one(url, headers) {', ...block, '}', ''].join('\n'));
  repo.write('src/two.ts', ['// Fetches with the shared pipeline.', '', 'export async function two(url, headers) {', ...block, '}', ''].join('\n'));
  repo.write('README.md', '# drift\n\nmore words\n');
  repo.git('add', '-A'); repo.git('commit', '-qm', 'turn one');
  const turn = repo.git('rev-parse', 'HEAD').trim();
  const sid = `p7-drift-${Date.now()}`;
  insertSession(sid, null, repo.dir, base);
  const cp = db().prepare('INSERT INTO session_checkpoints (session_id, turn, kind, at, repo_root, commit_hash, tree_hash, files_changed, status, detail) VALUES (?,?,?,?,?,?,?,?,?,?)');
  cp.run(sid, 0, 'session-start', Date.now() - 60_000, repo.dir, base, null, null, 'ok', null);

  const unchanged = await maintainabilityFor(sid);
  check(unchanged.state === 'unchanged' && unchanged.report === null, 'drift: a session whose only checkpoint is its base reports no change rather than zeros', unchanged.state);

  cp.run(sid, 1, 'turn-end', Date.now() - 30_000, repo.dir, turn, null, 3, 'ok', null);
  const view = await maintainabilityFor(sid);
  const r = view.report;
  check(view.state === 'ready' && view.base === base && view.latest === turn && view.latestTurn === 1 && view.changedFiles === 3,
    'drift: the base and latest checkpoint are read as real commits', { state: view.state, changed: view.changedFiles });
  // one.ts: one code line and one comment added; two.ts: the header and seven copied lines replace two.
  check(r?.codeAdded === 9 && r.codeRemoved === 2, 'drift: code lines added and removed exclude the comment and blank lines the turn added', JSON.stringify(r && { added: r.codeAdded, removed: r.codeRemoved }));
  check(r?.longestBefore?.lines === 9 && r.longestBefore.name === 'one' && r.longestAfter?.lines === 9,
    'drift: the longest function before and after is measured by the brace heuristic', JSON.stringify(r && { before: r.longestBefore, after: r.longestAfter }));
  check(r?.duplicatedBlocks.length === 1 && r.duplicatedBlocks[0].occurrences.map((o) => o.path).sort().join() === 'src/one.ts,src/two.ts',
    'drift: the copied block is one new duplicate across both changed files', JSON.stringify(r?.duplicatedBlocks));
  check(r?.skipped.some((s) => s.path === 'README.md' && s.reason === 'no heuristic for this language') === true, 'drift: a file with no heuristic is listed as not analysed, not silently dropped');
  const none = await maintainabilityFor(`p7-drift-none-${Date.now()}`);
  check(none.state === 'no-checkpoints', 'drift: a session with no checkpoints says so');
}

type HookHandler = { url: string; authorization: string };

function hookHandlerOf(file: string | null): HookHandler | null {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ url?: unknown; headers?: { Authorization?: unknown } }> }> } };
    const h = parsed.hooks?.PreToolUse?.[0]?.hooks?.[0];
    return typeof h?.url === 'string' && typeof h.headers?.Authorization === 'string' ? { url: h.url, authorization: h.headers.Authorization } : null;
  } catch { return null; }
}

async function postHook(handler: HookHandler, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(handler.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: handler.authorization }, body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
}

async function settle(read: () => boolean, ms = 4000): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (read()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return read();
}

/** Item 4: a session's files grouped Edited / Read / Referenced, through the real hook listener. */
export async function runSessionFilesSmoke(check: Check, say: Say): Promise<void> {
  say('── depth · what the session edited, read and referenced');
  const repo = repoFixture('wanigan-p7-files-');
  const hooks = await import('./hooks');
  const { startDepthServices } = await import('./depth');
  const { sessionFiles } = await import('./session-files');
  repo.write('src/cart.ts', 'export const total = 1;\n');
  repo.write('README.md', '# files\n');
  repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
  startDepthServices();
  await hooks.startHookServer();
  const sid = `p7-files-${Date.now()}`;
  insertSession(sid, null, repo.dir, null);
  const handler = hookHandlerOf(hooks.writeHookSettings(sid, repo.dir));
  check(handler !== null, 'files: the session gets a hook capability to post through');
  if (!handler) return;
  const d = repo.dir;
  await postHook(handler, { hook_event_name: 'UserPromptSubmit', cwd: d, prompt: 'Fix the total in src/cart.ts and check docs/guide.md' });
  await postHook(handler, { hook_event_name: 'PostToolUse', tool_name: 'Grep', cwd: d, tool_input: { pattern: 'total', path: 'src' }, tool_response: { mode: 'files_with_matches', numFiles: 1, filenames: ['cart.ts'] } });
  await postHook(handler, { hook_event_name: 'PostToolUse', tool_name: 'Glob', cwd: d, tool_input: { pattern: '**/*.md' }, tool_response: { numFiles: 1, filenames: [`${d}/README.md`], truncated: false } });
  await postHook(handler, { hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: d, tool_input: { file_path: `${d}/src/cart.ts` }, tool_response: { type: 'text' } });
  await postHook(handler, { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: d, tool_input: { command: "cat README.md && sed -n '1,5p' src/cart.ts" }, tool_response: { stdout: '', stderr: '' } });
  await postHook(handler, { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: d, tool_input: { command: 'cat src/*.ts' }, tool_response: { stdout: '', stderr: '' } });
  await postHook(handler, { hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: d, tool_input: { file_path: `${d}/src/cart.ts`, old_string: '1', new_string: '2' }, tool_response: {} });

  const ready = await settle(() => sessionFiles(sid).edited.length === 1 && (db().prepare('SELECT COUNT(*) AS n FROM session_file_refs WHERE session_id = ?').get(sid) as { n: number }).n >= 5);
  const files = sessionFiles(sid);
  check(ready, 'files: the hook bodies reached the panel', JSON.stringify(files));
  const cart = files.edited.find((f) => f.rel === 'src/cart.ts');
  check(!!cart && cart.edits === 1 && cart.reads === 1 && cart.bashReads === 1 && cart.searchHits === 1 && cart.promptMentions === 1 && cart.firstAt <= cart.lastAt,
    'files: a file read, searched, named and then edited sits under Edited with every count and its first and last time', JSON.stringify(cart));
  check(files.read.some((f) => f.rel === 'README.md' && f.bashReads === 1 && f.searchHits === 1),
    'files: a file a Bash cat read is under Read, with the Glob hit that found it', JSON.stringify(files.read));
  check(files.referenced.some((f) => f.rel === 'docs/guide.md' && f.promptMentions === 1),
    'files: a path named only in the prompt is Referenced', JSON.stringify(files.referenced));
  const refs = db().prepare('SELECT kind, path FROM session_file_refs WHERE session_id = ?').all(sid) as { kind: string; path: string }[];
  check(!refs.some((r) => r.path.includes('*')), 'files: a globbed cat is not guessed into a read');
  const stored = db().prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND event = 'UserPromptSubmit' AND summary IS NULL").get(sid) as { n: number };
  check(stored.n === 1 && !refs.some((r) => r.path.includes('Fix the total')), 'files: the prompt itself is not stored, only the paths it named');
  hooks.cleanupHookSettings(sid);
}

/** Item 5: git commands an agent ran, joined to the Git view's commit and branch rows through the real reflog. */
export async function runAgentGitSmoke(check: Check, say: Say): Promise<void> {
  say('── depth · git commands the agent ran, in the Git view');
  const { agentGitMarks } = await import('./agent-git');
  const repo = repoFixture('wanigan-p7-agentgit-');
  repo.write('a.txt', 'one\n');
  repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
  const sid = `p7-agentgit-${Date.now()}`;
  insertSession(sid, null, repo.dir, null, { title: 'Retry checkout' });
  const bash = (command: string, run: () => void) => {
    const pre = Date.now();
    insertEvent(sid, 'PreToolUse', { tool: 'Bash', summary: command, at: pre });
    run();
    return insertEvent(sid, 'PostToolUse', { tool: 'Bash', summary: command, at: Date.now(), ok: 1 });
  };
  repo.write('a.txt', 'two\n');
  const commitEvent = bash('git commit -am "agent: two"', () => repo.git('commit', '-qam', 'agent: two'));
  const agentSha = repo.git('rev-parse', 'HEAD').trim();
  const switchEvent = bash('git switch -c agent-branch', () => repo.git('switch', '-q', '-c', 'agent-branch'));
  bash('git status', () => repo.git('status'));
  // The operator's own commit, well outside any agent call's window.
  await new Promise((r) => setTimeout(r, 2_300));
  repo.write('a.txt', 'three\n');
  repo.git('commit', '-qam', 'operator: three');
  const operatorSha = repo.git('rev-parse', 'HEAD').trim();

  const marks = await agentGitMarks(repo.dir);
  check(marks.sessions === 1 && marks.commands === 2 && marks.reflogRead, 'agent git: the session in this repository and its two history-moving git calls are found; git status is not one', JSON.stringify({ sessions: marks.sessions, commands: marks.commands }));
  const onCommit = marks.commits[agentSha] ?? [];
  check(onCommit.length === 1 && onCommit[0].join === 'reflog' && onCommit[0].eventId === commitEvent && onCommit[0].sessionTitle === 'Retry checkout' && onCommit[0].verb === 'commit',
    'agent git: the commit the agent made is marked run by its session, joined through the reflog, with its timeline event', JSON.stringify(onCommit));
  check(!marks.commits[operatorSha], 'agent git: the operator’s own commit is unmarked');
  const onBranch = marks.branches['agent-branch'] ?? [];
  check(onBranch.some((m) => m.verb === 'checkout' && m.eventId === switchEvent && m.join === 'reflog'), 'agent git: the branch the agent switched to is marked on its branch row', JSON.stringify(marks.branches));

  // A repository whose reflog records nothing can only be joined by time, and says so.
  const quiet = repoFixture('wanigan-p7-agentgit-noreflog-');
  quiet.git('config', 'core.logAllRefUpdates', 'false');
  quiet.write('b.txt', 'one\n');
  const qsid = `p7-agentgit-quiet-${Date.now()}`;
  insertSession(qsid, null, quiet.dir, null, { title: 'No reflog' });
  const qpre = Date.now() - 1500;
  insertEvent(qsid, 'PreToolUse', { tool: 'Bash', summary: 'git commit -m first', at: qpre });
  quiet.git('add', '-A'); quiet.git('commit', '-qm', 'first');
  const qsha = quiet.git('rev-parse', 'HEAD').trim();
  insertEvent(qsid, 'PostToolUse', { tool: 'Bash', summary: 'git commit -m first', at: Date.now() + 500, ok: 1 });
  const qmarks = await agentGitMarks(quiet.dir);
  check(qmarks.commits[qsha]?.[0]?.join === 'time', 'agent git: with no reflog entry the join is labelled by time', JSON.stringify(qmarks.commits));

  const view = await source('renderer/src/views/Git.tsx');
  check(view.includes('<RunByInline marks={agentGit?.commits[c.hash]} />') && view.includes('<RunByList marks={agentGit?.branches[b.name]}'),
    'agent git: the Git view draws the marks on commit rows and branch rows');
}

/** Item 6: compaction boundaries from the hook bus and the transcript, on the Timeline and in the reader. */
export async function runCompactionSmoke(check: Check, say: Say): Promise<void> {
  say('── depth · compaction boundaries');
  const hooks = await import('./hooks');
  const { compactionsFor } = await import('./compactions');
  const transcripts = await import('./transcripts');
  await hooks.startHookServer();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-p7-compact-')));
  const sid = `p7-compact-${Date.now()}`;
  insertSession(sid, null, dir, null);
  const handler = hookHandlerOf(hooks.writeHookSettings(sid, dir));
  check(handler !== null, 'compaction: the session gets a hook capability');
  if (!handler) return;
  await postHook(handler, { hook_event_name: 'PreCompact', cwd: dir, trigger: 'manual', custom_instructions: 'keep the retry notes private-words-1' });
  await postHook(handler, { hook_event_name: 'PostCompact', cwd: dir, trigger: 'manual', compact_summary: 'model summary private-words-2' });
  const rows = db().prepare("SELECT event, summary FROM session_events WHERE session_id = ? AND event IN ('PreCompact','PostCompact') ORDER BY id").all(sid) as { event: string; summary: string | null }[];
  check(rows.length === 2 && rows.every((r) => r.summary === 'manual'), 'compaction: PreCompact and PostCompact rows record the trigger', JSON.stringify(rows));
  const everything = JSON.stringify(db().prepare('SELECT * FROM session_events WHERE session_id = ?').all(sid));
  check(!everything.includes('private-words-1') && !everything.includes('private-words-2'), 'compaction: the operator’s /compact instructions and the model’s summary are not stored');

  // An archived transcript with one boundary near the hook pair and one with no hook at all.
  const postAt = (db().prepare("SELECT at FROM session_events WHERE session_id = ? AND event = 'PostCompact'").get(sid) as { at: number }).at;
  const file = path.join(dir, 'archived.jsonl');
  const line = (o: unknown) => JSON.stringify(o);
  fs.writeFileSync(file, [
    line({ type: 'user', message: { role: 'user', content: 'Refactor the checkout.' }, timestamp: new Date(postAt - 600_000).toISOString() }),
    line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 412_000, postTokens: 18_500 }, timestamp: new Date(postAt - 400_000).toISOString() }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing.' }] }, timestamp: new Date(postAt - 300_000).toISOString() }),
    line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 96_000, postTokens: 9_100 }, timestamp: new Date(postAt - 1_000).toISOString() }),
    '',
  ].join('\n'));
  db().prepare('INSERT INTO transcripts (session_id, source_path, stored_path, bytes, turns, parsed, archived_at) VALUES (?,?,?,?,?,?,?)').run(sid, file, file, fs.statSync(file).size, 2, 1, Date.now());
  const result = compactionsFor(sid);
  const paired = result.marks.find((m) => m.source === 'hook+transcript');
  const alone = result.marks.find((m) => m.source === 'transcript');
  check(result.transcript === 'archived' && result.marks.length === 2, 'compaction: one divider per compaction, read from the archived transcript', JSON.stringify(result));
  check(paired?.preTokens === 96_000 && paired.postTokens === 9_100 && paired.trigger === 'manual', 'compaction: the hook pair carries the pre-compaction token count the transcript recorded', JSON.stringify(paired));
  check(alone?.preTokens === 412_000 && alone.eventId === null, 'compaction: a transcript boundary with no hook row still draws a divider');
  const read = transcripts.transcriptFor(sid);
  const dividers = read.turns.filter((t) => t.compact);
  check(dividers.length === 2 && dividers[0].compact?.preTokens === 412_000 && read.turns.some((t) => t.role === 'assistant'),
    'compaction: the transcript reader gets a divider at each boundary, in order, between the real turns', JSON.stringify(read.turns.map((t) => t.compact ? 'divider' : t.role)));
  hooks.cleanupHookSettings(sid);
}

/** Item 7: instruction files join the pinned config — shown by default, asked about only where the project opted in. */
export async function runInstructionPinSmoke(check: Check, say: Say): Promise<void> {
  say('── depth · instruction files beside the pinned config');
  const repo = repoFixture('wanigan-p7-instr-');
  const { addProject, removeProject } = await import('./store');
  const pins = await import('./config-pins');
  try {
    repo.write('CLAUDE.md', '@AGENTS.md\n');
    repo.write('AGENTS.md', '# Rules\n\nRun npm test before handing off.\n');
    repo.write('.claude/rules/testing.md', 'Tests live beside the code.\n');
    repo.write('packages/api/AGENTS.md', 'API errors are typed.\n');
    repo.write('node_modules/dep/AGENTS.md', 'not the project’s\n');
    repo.write('docs/notes.md', 'not an instruction file\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const project = await addProject(repo.dir);

    const first = await pins.checkConfig(project.id, repo.dir);
    const paths = first.instructions?.files.map((f) => f.path).sort();
    check(first.instructions?.state === 'first-use' && JSON.stringify(paths) === JSON.stringify(['.claude/rules/testing.md', 'AGENTS.md', 'CLAUDE.md', 'packages/api/AGENTS.md']),
      'instructions: CLAUDE.md, .claude/rules, AGENTS.md and a nested AGENTS.md are read; node_modules is not', JSON.stringify(paths));
    check(first.state === 'none' && first.snapshot.items.length === 0, 'instructions: they are kept out of the executable digest, so a repo with only instructions still runs nothing of its own');
    const firstGate = await pins.gateLaunch(project.id, repo.dir, null, true);
    check(firstGate.allowed && (firstGate.note ?? '').includes('instructions (not executable)'), 'instructions: the first attended launch records the baseline and says so', firstGate);

    repo.write('AGENTS.md', '# Rules\n\nRun npm test before handing off.\nNever push to main.\n');
    repo.write('CLAUDE.local.md', 'my own notes\n');
    const changed = await pins.checkConfig(project.id, repo.dir);
    const agents = changed.instructions?.diff.find((d) => d.path === 'AGENTS.md');
    check(changed.instructions?.state === 'changed' && agents?.added === 1 && agents.lines.some((l) => l.kind === 'add' && l.text === 'Never push to main.')
      && changed.instructions.diff.some((d) => d.path === 'CLAUDE.local.md' && d.status === 'added'),
      'instructions: a change since the last trusted launch comes with a line diff', JSON.stringify(changed.instructions?.diff.map((d) => [d.path, d.status, d.added, d.removed])));
    check(changed.state === 'none', 'instructions: an instruction change does not move the executable pin');

    const headlessShown = await pins.gateLaunch(project.id, repo.dir, null, false);
    check(headlessShown.allowed && /changed since the last trusted launch/.test(headlessShown.note ?? '') && (await pins.checkConfig(project.id, repo.dir)).instructions?.state === 'changed',
      'instructions: show-only by default — an unattended run goes ahead with a note and does not advance the baseline', headlessShown);
    const shownGate = await pins.gateLaunch(project.id, repo.dir, null, true);
    const afterShown = await pins.checkConfig(project.id, repo.dir);
    check(shownGate.allowed && afterShown.instructions?.state === 'same' && afterShown.instructions.lastTrusted?.how === 'shown',
      'instructions: an attended launch with the change on screen becomes the new baseline', afterShown.instructions?.lastTrusted);

    pins.setInstructionAsk(project.id, true);
    repo.write('.claude/rules/testing.md', 'Tests live beside the code.\nUse the real database.\n');
    const refused = await pins.gateLaunch(project.id, repo.dir, null, true);
    const refusedHeadless = await pins.gateLaunch(project.id, repo.dir, null, false);
    check(!refused.allowed && /asks before launching with changed instruction files/.test(refused.reason) && !refusedHeadless.allowed && /nobody to accept/.test(refusedHeadless.reason),
      'instructions: where the project opted in, a changed file asks again, and an unattended run is refused', { refused, refusedHeadless });
    const pending = await pins.checkConfig(project.id, repo.dir);
    let stale = false;
    try { await pins.acceptInstructions(project.id, repo.dir, first.instructions!.digest); } catch { stale = true; }
    check(stale, 'instructions: accepting a digest that is not what is on disk is refused');
    const accepted = await pins.acceptInstructions(project.id, repo.dir, pending.instructions!.digest);
    const allowed = await pins.gateLaunch(project.id, repo.dir, null, true);
    check(accepted.instructions?.state === 'same' && accepted.instructions.lastTrusted?.how === 'reviewed' && allowed.allowed,
      'instructions: once accepted the launch goes ahead, recorded as reviewed');

    // An executable change still gates as before, with instructions unchanged.
    repo.write('.mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['docs-mcp'] } } }));
    const execFirst = await pins.gateLaunch(project.id, repo.dir, null, true);
    check(execFirst.allowed && /Pinned this repository's executable config at first launch/.test(execFirst.note ?? ''), 'instructions: the executable pin still records its own first use', JSON.stringify(execFirst));
    const dialog = await source('renderer/src/components/NewSessionDialog.tsx');
    check(dialog.includes('<LaunchInstructionReview check={instructions}') && dialog.indexOf('window.wanigan.depth.instructions.accept(') < dialog.indexOf('await onCreate({'),
      'instructions: the launch dialog shows the review and records an acceptance before it creates the session');
  } finally {
    try { const { listProjects } = await import('./store'); const p = listProjects().find((x) => x.path === repo.dir); if (p) removeProject(p.id); } catch { /* best effort */ }
  }
}

/** Item 8: scratch files stay out of review counts, marks and the PR body, with a persistent promotion. */
export async function runScratchSmoke(check: Check, say: Say): Promise<void> {
  say('── depth · scratch files stay out of review counts');
  const repo = repoFixture('wanigan-p7-scratch-');
  const { addProject, removeProject } = await import('./store');
  const work = await import('./review-work');
  const { setScratchPromotion } = await import('./scratch');
  const { buildPrBody } = await import('../shared/pr-body');
  try {
    repo.write('src/cart.ts', 'export const total = 1;\n');
    repo.write('.gitignore', 'build/\n');
    repo.write('build/keep.txt', 'tracked under an ignored pattern\n');
    repo.git('add', '-A'); repo.git('add', '-f', 'build/keep.txt'); repo.git('commit', '-qm', 'base');
    const base = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);
    const sid = `p7-scratch-${Date.now()}`;
    insertSession(sid, project.id, repo.dir, base);
    repo.write('src/cart.ts', 'export const total = 2;\n');
    repo.write('scratch/probe.py', Array.from({ length: 40 }, (_, i) => `print(${i})`).join('\n') + '\n');
    repo.write('tmp/dump.json', '{"a":1}\n');
    repo.write('build/keep.txt', 'changed\n');
    repo.write('.claude/worktrees/agent-a/notes.md', 'x\n');
    const review = await work.reviewWork(sid);
    const scratch = Object.fromEntries(review.files.map((f) => [f.path, f.scratch ?? null]));
    check(scratch['src/cart.ts'] === null && scratch['scratch/probe.py'] === 'scratch-dir' && scratch['tmp/dump.json'] === 'tmp-dir' && scratch['build/keep.txt'] === 'gitignored',
      'scratch: scratch/, tmp/ and a tracked file under an ignored pattern are classified; the real change is not', JSON.stringify(scratch));
    check(review.verdict.counts.files === 1 && review.verdict.counts.added === 1 && review.label === 'Needs review · 0 of 1 file',
      'scratch: needs-review totals and the diff counts leave them out', JSON.stringify(review.verdict.counts));
    let refused = '';
    try { await work.setReviewMark(sid, 'tmp/dump.json', 'approved'); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(/scratch file/.test(refused), 'scratch: a review mark on a scratch file is refused until it is counted', refused);

    setScratchPromotion(project.id, 'scratch/probe.py', true);
    const promoted = await work.reviewWork(sid);
    check(promoted.files.find((f) => f.path === 'scratch/probe.py')?.scratch === null && promoted.verdict.counts.files === 2 && promoted.verdict.counts.added === 41,
      'scratch: "Count this file" puts it back into every count', JSON.stringify(promoted.verdict.counts));
    const mark = await work.setReviewMark(sid, 'scratch/probe.py', 'approved');
    check(mark.state === 'approved', 'scratch: a counted file can be marked');
    const again = await work.reviewWork(sid);
    check(again.files.find((f) => f.path === 'scratch/probe.py')?.scratch === null, 'scratch: the promotion persists for the project');

    const body = buildPrBody({ goal: null, turns: 1, files: [{ path: 'src/cart.ts', added: 1, removed: 1 }], checks: [], review: null, dependencies: [], scratchFiles: 2 });
    check(body.includes('1 file changed (+1 −1)') && body.includes('2 scratch files (temporary, ignored, or under scratch/ or tmp/) not listed or counted') && !body.includes('tmp/dump.json'),
      'scratch: the PR body lists and counts only real files and says how many scratch files it left out');
    const evidence = await source('main/pr-evidence.ts');
    check(evidence.includes('files: counted,') && evidence.includes('scratchFiles: classified.length - counted.length'), 'scratch: the PR draft passes only counted files to the body');
  } finally {
    try { const { listProjects } = await import('./store'); const p = listProjects().find((x) => x.path === repo.dir); if (p) removeProject(p.id); } catch { /* best effort */ }
  }
}
