import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/*
 * Helper sweep · P3 — reviewing the work. Real repositories, real git, the real
 * database and the real hook listener; no PTY, no provider, no network, no spend.
 */

function repoFixture(prefix: string): { dir: string; git: (...args: string[]) => string; write: (rel: string, text: string) => void; read: (rel: string) => string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  return { dir, git, write, read };
}

function insertSession(id: string, projectId: string, projectPath: string, base: string, opts: { worktree?: string | null; dirty?: string[]; exited?: boolean; conversationId?: string | null } = {}) {
  const now = Date.now();
  db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_id, project_path, project_name, started_at, ended_at, exit_code, worktree, baseline_head, baseline_dirty_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, opts.conversationId ?? null, 'claude', 'claude-code', projectId, projectPath, path.basename(projectPath),
    now - 60_000, opts.exited === false ? null : now - 1_000, opts.exited === false ? null : 0, opts.worktree ?? null, base, JSON.stringify(opts.dirty ?? []));
}

function insertEvent(sessionId: string, event: string, over: { tool?: string; paths?: string[]; summary?: string; ok?: number | null; at?: number } = {}): number {
  const res = db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json) VALUES (?,?,?,?,?,?,?,?)')
    .run(sessionId, over.at ?? Date.now(), event, over.tool ?? null, over.summary ?? null, null, over.ok ?? null, over.paths ? JSON.stringify(over.paths) : null);
  return Number(res.lastInsertRowid);
}

/** Item 1 and 7: marks, staleness, the verdict, summaries, risk tiers and the gated merge. */
export async function runReviewMarksSmoke(check: Check, say: Say): Promise<void> {
  say('── review · per-file marks, needs review, risk tiers');
  const repo = repoFixture('wanigan-review-marks-');
  const { addProject, removeProject } = await import('./store');
  const work = await import('./review-work');
  const worktrees = await import('./worktrees');
  try {
    repo.write('src/cart.ts', 'export const total = 1;\n');
    repo.write('src/old.ts', 'export const old = true;\n');
    repo.write('README.md', '# cart\n');
    repo.write('mine.txt', 'operator\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const base = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);

    // The session changed a file, added one, deleted one; the operator had
    // already edited mine.txt before it launched.
    repo.write('mine.txt', 'operator edited before launch\n');
    const sid = `p3-marks-${Date.now()}`;
    insertSession(sid, project.id, repo.dir, base, { dirty: ['mine.txt'], exited: true });
    repo.write('src/cart.ts', 'export const total = 2;\nexport function addTax(n: number) { return n * 1.1; }\n');
    repo.write('src/tax.test.ts', "it('taxes', () => { expect(addTax(10)).toBe(11); });\n");
    fs.rmSync(path.join(repo.dir, 'src/old.ts'));
    insertEvent(sid, 'PostToolUse', { tool: 'Edit', paths: [path.join(repo.dir, 'src/cart.ts')], ok: 1 });
    insertEvent(sid, 'Stop', { ok: 1 });

    let review = await work.reviewWork(sid);
    const paths = review.files.map((f) => `${f.status}:${f.path}`).sort();
    check(JSON.stringify(paths) === JSON.stringify(['?:src/tax.test.ts', 'D:src/old.ts', 'M:mine.txt', 'M:src/cart.ts']),
      'the branch diff lists the modified, deleted and untracked files against the base commit', paths);
    check(review.files.find((f) => f.path === 'mine.txt')?.preexisting === true && review.verdict.counts.files === 3,
      'a file already dirty at launch is flagged as pre-existing and left out of the review count', review.verdict.counts);
    check(review.verdict.needsReview && review.verdict.reason === 'unapproved-files' && review.label === 'Needs review · 0 of 3 files',
      'an exited session with an unapproved diff needs review, and the chip says 0 of 3 files', review.label);
    const cart = review.files.find((f) => f.path === 'src/cart.ts');
    check(cart?.attribution === 'edit-tool' && review.files.find((f) => f.path === 'src/tax.test.ts')?.attributionLabel === 'changed outside edit tools',
      'an Edit PostToolUse attributes its file; a file no tool named is "changed outside edit tools"', review.files.map((f) => [f.path, f.attribution]));
    check(review.files.find((f) => f.path === 'src/tax.test.ts')?.kind === 'test' && cart?.added === 2 && cart.removed === 1,
      'files carry their review kind and line counts', cart);

    for (const f of ['src/cart.ts', 'src/old.ts']) await work.setReviewMark(sid, f, 'approved');
    await work.setReviewMark(sid, 'src/tax.test.ts', 'rejected', 'Test the rounding too.');
    review = await work.reviewWork(sid);
    check(review.verdict.counts.approved === 2 && review.verdict.counts.rejected === 1 && review.verdict.needsReview,
      'two approvals and a rejection leave the session needing review', review.verdict.counts);
    await work.setReviewMark(sid, 'src/tax.test.ts', 'approved');
    review = await work.reviewWork(sid);
    check(!review.verdict.needsReview && review.verdict.reason === 'all-approved',
      'approving every changed file clears needs review', review.verdict.reason);
    check(work.resolvedCount(sid, review.files.filter((f) => !f.preexisting), [{ path: 'src/tax.test.ts', state: 'approved', note: null, contentHash: review.files.find((f) => f.path === 'src/tax.test.ts')!.contentHash, worktree: repo.dir, baseCommit: base, markedAt: 1 }]) === 1,
      'a rejection later approved counts as resolved');

    repo.write('src/cart.ts', 'export const total = 3;\n');
    work.__test.clearCaches();
    review = await work.reviewWork(sid);
    const stale = review.files.find((f) => f.path === 'src/cart.ts');
    check(stale?.review.stale === true && stale.review.state === 'unreviewed' && review.verdict.needsReview,
      'editing an approved file makes its mark stale and the session needs review again', stale?.review);

    let refused = '';
    try { await work.setReviewMark(sid, '../../etc/passwd', 'approved'); } catch (e) { refused = String(e); }
    check(/not a changed file/.test(refused), 'a mark on a path outside the diff is refused', refused);
    refused = '';
    try { await work.setReviewMark(sid, 'src/cart.ts', 'commented', '   '); } catch (e) { refused = String(e); }
    check(/Write the comment first/.test(refused), 'a comment with no text is refused', refused);
    const stored = db().prepare('SELECT content_hash FROM review_marks WHERE session_id = ? AND path = ?').get(sid, 'src/cart.ts') as { content_hash: string };
    const hashNow = repo.git('hash-object', 'src/cart.ts').trim();
    check(stored.content_hash !== hashNow, 'the stored mark keeps the hash main computed when it was made, not the current one');

    const summaries = await work.reviewSummaries([sid, 'no-such-session']);
    check(summaries[sid]?.needsReview === true && !('no-such-session' in summaries),
      'summaries answer for a known session and leave an unknown one out rather than zeroing it', Object.keys(summaries));

    // Risk tiers: stored per project, validated, and gating a worktree merge.
    let badTier = '';
    try { work.saveRiskRules(project.id, [{ pattern: '../x', tier: 'high' }]); } catch (e) { badTier = String(e); }
    check(/outside the project/.test(badTier) && work.riskRules(project.id).length === 0, 'an invalid rule list is refused whole and nothing is stored', badTier);
    work.saveRiskRules(project.id, [{ pattern: '.github/workflows/**', tier: 'high' }, { pattern: 'package-lock.json', tier: 'medium' }]);
    check(work.riskRules(project.id).length === 2, 'a valid rule list is stored in Wanigan\'s database for the project');
    const gitignoreHits = fs.existsSync(path.join(repo.dir, '.wanigan')) || repo.git('status', '--porcelain').includes('risk');
    check(!gitignoreHits, 'nothing about the tiers is written into the repository');

    const wsid = `p3-merge-${Date.now()}`;
    const wt = await worktrees.createWorktree(repo.dir, 'ci fix', wsid);
    const wgit = (...args: string[]) => execFileSync('git', ['-C', wt.path, ...args], { stdio: 'pipe' }).toString();
    const wbase = wgit('rev-parse', 'HEAD').trim();
    insertSession(wsid, project.id, repo.dir, wbase, { worktree: wt.path, exited: true });
    fs.mkdirSync(path.join(wt.path, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(wt.path, '.github/workflows/ci.yml'), 'on: push\n');
    fs.writeFileSync(path.join(wt.path, 'src/cart.ts'), 'export const total = 9;\n');
    wgit('add', '-A'); wgit('-c', 'user.email=s@w.t', '-c', 'user.name=S', 'commit', '-qm', 'agent work');
    // The main checkout must be clean for the merge itself.
    repo.git('checkout', '--', '.'); repo.git('clean', '-fdq');
    let gate = await work.mergeCheck(wt.path);
    check(!gate.allowed && gate.highTier.join() === '.github/workflows/ci.yml',
      'a worktree whose diff touches a high-tier path cannot merge until that file is approved, and the check names it', gate);
    const blocked = await work.mergeWorktreeReviewed(wt.path, { squash: false });
    check(!blocked.merged && /high-tier/.test(blocked.detail) && repo.git('log', '--oneline').split('\n').filter(Boolean).length === 1,
      'the gated merge the IPC handler runs refuses, and the base branch is untouched', blocked.detail);
    await work.setReviewMark(wsid, '.github/workflows/ci.yml', 'approved');
    gate = await work.mergeCheck(wt.path);
    check(gate.allowed, 'approving the high-tier file enables the merge; the untiered file needs no approval for it', gate);
    const merged = await work.mergeWorktreeReviewed(wt.path, { squash: false });
    check(merged.merged, 'the gated merge then runs the worktree merge', merged.detail);

    await worktrees.removeWorktree(wt.path, true);
    removeProject(project.id);
  } catch (error) {
    check(false, 'the review-marks checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

/** Item 2, 3, 5 and 9: shell-reported paths through the real listener, dependencies, images, claims. */
export async function runReviewEvidenceSmoke(check: Check, say: Say): Promise<void> {
  say('── review · agent edits, bashEditDiffEnabled, dependencies, images, claims');
  const repo = repoFixture('wanigan-review-evidence-');
  const hooks = await import('./hooks');
  const shell = await import('./shell-results');
  const { addProject, removeProject } = await import('./store');
  const work = await import('./review-work');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-review-transcript-'));
  try {
    // The settings key rides the same version gate as hook events.
    const keys = (v: string | null) => hooks.hookSettingsKeysFor(v);
    check(!('bashEditDiffEnabled' in keys('2.1.268 (Claude Code)')) && keys('2.1.269 (Claude Code)').bashEditDiffEnabled === true
      && keys('2.1.271 (Claude Code)').bashEditDiffEnabled === true && Object.keys(keys(null)).length === 0,
      'bashEditDiffEnabled is asked for only from Claude Code 2.1.269 on, and never without a version reading');
    await hooks.startHookServer();
    const sid = `p3-evidence-${Date.now()}`;
    const file = hooks.writeHookSettings(sid, repo.dir, undefined, { cliVersion: '2.1.271 (Claude Code)' });
    const settings = file ? JSON.parse(fs.readFileSync(file, 'utf8')) as { bashEditDiffEnabled?: boolean; hooks: { PostToolUse?: { hooks: { url: string; headers: { Authorization: string } }[] }[] } } : null;
    check(settings?.bashEditDiffEnabled === true && !!settings.hooks.PostToolUse, 'a settings file written for 2.1.271 carries bashEditDiffEnabled beside its hooks');
    const old = hooks.writeHookSettings(`${sid}-old`, repo.dir, undefined, { cliVersion: '2.1.263 (Claude Code)' });
    check(!!old && !('bashEditDiffEnabled' in JSON.parse(fs.readFileSync(old, 'utf8'))), 'a settings file for 2.1.263 does not carry it');
    hooks.cleanupHookSettings(`${sid}-old`);

    repo.write('package.json', JSON.stringify({ name: 'app', dependencies: { react: '^18.2.0' } }, null, 2));
    repo.write('gen/schema.ts', 'export const v = 1;\n');
    fs.writeFileSync(path.join(repo.dir, 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const base = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);
    const conversationId = `conv-${Date.now()}`;
    insertSession(sid, project.id, repo.dir, base, { exited: true, conversationId });

    repo.write('package.json', JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0', 'p-retry': '6.2.0' } }, null, 2));
    repo.write('gen/schema.ts', 'export const v = 2;\n');
    repo.write('src/retry.ts', 'export function retryCheckout() { return 1; }\n');
    fs.writeFileSync(path.join(repo.dir, 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000208060000', 'hex'));

    const handler = settings?.hooks.PostToolUse?.[0]?.hooks?.[0];
    const post = (body: unknown) => fetch(handler!.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: handler!.headers.Authorization }, body: JSON.stringify(body) });
    const install = await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm install p-retry@6.2.0' },
      tool_response: { stdout: 'added 1 package', stderr: '', interrupted: false, bashEditDiff: { files: [], moreFiles: 1, changedFiles: [path.join(repo.dir, 'package.json')] } } });
    const gen = await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'node scripts/gen.js' },
      tool_response: { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files: [{ filePath: path.join(repo.dir, 'gen/schema.ts'), hunks: [] }], moreFiles: 0, changedFiles: [path.join(repo.dir, 'gen/schema.ts')] } } });
    const failed = await post({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'npm test' }, error: 'Exit code 1\nFAIL src/retry.test.ts' });
    const passed = await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't4', tool_input: { command: 'npm test -- retry' }, tool_response: { stdout: 'ok', stderr: '', interrupted: false } });
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 't5', tool_input: { file_path: path.join(repo.dir, 'src/retry.ts') }, tool_response: {} });
    await post({ hook_event_name: 'Stop' });
    check(install.ok && gen.ok && failed.ok && passed.ok, 'the listener accepted four Bash results, a Write and a Stop');

    const commands = shell.shellCommands(sid);
    check(commands.length === 4 && commands[2].ok === false && commands[2].exitCode === 1 && commands[3].ok === true && commands[3].exitCode === null,
      'the hook store recorded each Bash outcome; a failure\'s exit code is read from "Exit code N", a success is not given a number', commands);
    const reported = shell.shellChangedPaths(sid).sort();
    check(reported.length === 2 && reported[0].endsWith('gen/schema.ts') && reported[1].endsWith('package.json'),
      'the changed-file lists a Bash result reported are stored against the session', reported);
    check(shell.bashChangedFiles({ bashEditDiff: { files: [], moreFiles: 3, unavailable: true } }).state === 'unavailable'
      && shell.bashChangedFiles({ stdout: 'x' }).state === 'absent' && shell.exitCodeFromError('Command failed') === null,
      'an unavailable report, a response with none, and an error with no exit code are each kept as what they are');

    const review = await work.reviewWork(sid);
    const att = Object.fromEntries(review.files.map((f) => [f.path, f.attribution]));
    check(att['src/retry.ts'] === 'edit-tool' && att['gen/schema.ts'] === 'shell-reported' && att['logo.png'] === 'outside-edit-tools',
      'the review attributes a Write to its edit tool, a generated file to the shell command that reported it, and the image to neither', att);
    check(review.shellDiffReported && review.hooksRecorded, 'the review says a shell diff was reported for this session');

    const deps = await work.dependencyReview(sid);
    const pkg = deps.manifests.find((m) => m.path === 'package.json');
    check(!!pkg && pkg.lines.join('|') === 'added `p-retry` 6.2.0 (package.json dependencies)|upgraded `react` ^18.2.0 → ^19.0.0 (package.json dependencies)',
      'package.json on each side is read into an added and an upgraded dependency', pkg);
    check(deps.installs.length === 1 && deps.installs[0].command.startsWith('npm install'), 'the recorded install command is listed with the dependencies', deps.installs);
    repo.write('package.json', '{ "dependencies": ');
    const broken = await work.dependencyReview(sid);
    check(broken.manifests[0]?.error?.includes('not valid JSON') === true, 'a malformed manifest is reported as unreadable, not as no dependencies', broken.manifests[0]);
    repo.write('package.json', JSON.stringify({ name: 'app', dependencies: { react: '^19.0.0', 'p-retry': '6.2.0' } }, null, 2));

    const image = await work.reviewImage(sid, 'logo.png');
    check(!!image.before.dataUrl?.startsWith('data:image/png;base64,iVBORw0KGgo') && !!image.after.dataUrl?.startsWith('data:image/png;base64,')
      && image.before.dataUrl !== image.after.dataUrl,
      'an image\'s base version comes out of git\'s object store and its new version off disk, both as data URLs', [image.before.bytes, image.after.bytes]);
    let notImage = '';
    try { await work.reviewImage(sid, 'package.json'); } catch (e) { notImage = String(e); }
    check(/Only PNG/.test(notImage), 'a non-image path has no image view');

    const diff = await work.reviewFileDiff(sid, 'gen/schema.ts', { whitespace: true });
    check(diff.includes('+export const v = 2;'), 'a single file\'s branch diff comes back for the code rail');

    // Claims, from an archived transcript.
    const transcript = path.join(tmp, 'archived.jsonl');
    const message = [
      'Done. Summary:',
      '- Created `src/retry.ts` with a new `retryCheckout()` helper.',
      '- Updated `README.md`.',
      '- Added the `p-retry` dependency.',
      '',
      'All tests pass.',
    ].join('\n');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: message }] } }) + '\n');
    db().prepare('INSERT INTO transcripts (session_id, source_path, stored_path, bytes, turns, parsed, archived_at) VALUES (?,?,?,?,?,?,?)')
      .run(sid, transcript, transcript, fs.statSync(transcript).size, 1, 1, Date.now());
    const claims = await work.claimsReview(sid);
    const graded = claims.state === 'graded' ? Object.fromEntries(claims.claims.map((c) => [`${c.kind}:${c.subject ?? ''}`, c.grade])) : {};
    check(graded['file-added:src/retry.ts'] === 'verified' && graded['symbol-added:retryCheckout'] === 'verified'
      && graded['file-changed:README.md'] === 'unsupported' && graded['dependency-added:p-retry'] === 'verified' && graded['tests-pass:'] === 'verified',
      'the final message\'s claims are graded against the diff, the dependency list and the recorded test commands', graded);

    hooks.cleanupHookSettings(sid);
    removeProject(project.id);
  } catch (error) {
    check(false, 'the review-evidence checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    for (const d of [repo.dir, tmp]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  }
}

/** Item 2b: stage only the session's hunks, against real per-turn checkpoints. */
export async function runStageHunksSmoke(check: Check, say: Say): Promise<void> {
  say('── review · stage only the session\'s hunks');
  const repo = repoFixture('wanigan-stage-hunks-');
  const checkpoints = await import('./checkpoints');
  const stage = await import('./stage-hunks');
  const work = await import('./review-work');
  const { addProject, removeProject } = await import('./store');
  try {
    const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join('\n') + '\n';
    repo.write('a.txt', lines(100));
    repo.write('b.txt', 'b\n');
    repo.write('c.txt', lines(20));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const head = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);
    const sid = `p3-stage-${Date.now()}`;
    const edit = (rel: string, lineNo: number, text: string) => {
      const all = repo.read(rel).split('\n');
      all[lineNo - 1] = text;
      repo.write(rel, all.join('\n'));
    };

    checkpoints.__test.registerSessionCheckpoints({ sessionId: sid, cwd: repo.dir, hooksCapable: true, gitHead: head });
    await checkpoints.__test.awaitIdle(sid);
    checkpoints.__test.enqueueBoundary(sid, 'turn-start');
    await checkpoints.__test.awaitIdle(sid);
    edit('a.txt', 2, 'line 2 changed by the agent');
    edit('c.txt', 10, 'line 10 changed by the agent');
    repo.write('new.txt', 'created by the agent\n');
    checkpoints.__test.enqueueBoundary(sid, 'turn-end');
    await checkpoints.__test.awaitIdle(sid);
    await checkpoints.__test.finalizeSessionCheckpoints(sid);
    // After the turn: the operator edits far from the agent in a.txt, right next
    // to it in c.txt, and in b.txt, which no turn touched.
    edit('a.txt', 90, 'line 90 changed by the operator');
    edit('c.txt', 11, 'line 11 changed by the operator');
    repo.write('b.txt', 'b changed by the operator\n');

    let plan = await stage.stagePlan(sid);
    const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f]));
    check(plan.ok && byPath['a.txt']?.action === 'stage' && byPath['a.txt'].mixed && byPath['new.txt']?.action === 'stage' && !byPath['new.txt'].mixed,
      'a file the turn changed and the operator edited far away is staged apart; a file only the turn created is staged whole', plan.files.map((f) => [f.path, f.action]));
    check(byPath['c.txt']?.action === 'refuse' && /cannot be staged apart/.test(byPath['c.txt'].reason ?? ''),
      'an operator edit right next to the turn\'s change is refused with the reason, not guessed', byPath['c.txt']?.reason);
    check(plan.untouched.includes('b.txt') && !plan.patch.includes('operator'),
      'a file no turn touched is left out, and no operator line is in the patch', plan.untouched);
    check(repo.git('diff', '--cached', '--name-only').trim() === '', 'the preview wrote nothing to the index');

    let stale = '';
    try { await stage.stageApply(sid, 'f'.repeat(64)); } catch (e) { stale = String(e); }
    check(/changed since the preview/.test(stale), 'applying with a digest that is not the current plan\'s is refused', stale);

    const applied = await stage.stageApply(sid, plan.digest!);
    const cached = repo.git('diff', '--cached');
    const unstaged = repo.git('diff');
    check(applied.staged.sort().join() === 'a.txt,new.txt' && cached.includes('+line 2 changed by the agent') && cached.includes('+created by the agent')
      && !cached.includes('operator') && unstaged.includes('+line 90 changed by the operator') && unstaged.includes('b changed by the operator'),
      'staging puts exactly the turn\'s hunks in the index and leaves every operator hunk unstaged', applied.detail);
    check(repo.read('a.txt').includes('line 90 changed by the operator'), 'the working tree is untouched by staging');

    plan = await stage.stagePlan(sid);
    check(plan.files.find((f) => f.path === 'a.txt')?.action === 'already-staged' && plan.digest === null,
      'a second preview recognises the session\'s hunks as already staged and offers nothing to apply', plan.files.map((f) => [f.path, f.action]));

    const stats = await work.turnStats(sid);
    check(stats[1]?.files === 3 && stats[1].added === 3 && stats[1].removed === 2, 'turn 1\'s diff-stat badge counts its files and lines from the checkpoints', stats[1]);

    const none = await stage.stagePlan('no-such-session');
    check(!none.ok && /no launch snapshot/.test(none.refusal ?? ''), 'a session with no checkpoints is refused with the reason', none.refusal);
    checkpoints.forgetSessionCheckpoints(sid);
    removeProject(project.id);
  } catch (error) {
    check(false, 'the staging checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

/** Item 8 and 6: the regression proof and the PR body from recorded evidence. */
export async function runProofAndPrSmoke(check: Check, say: Say): Promise<void> {
  say('── review · fails before, passes after · PR body from evidence');
  const repo = repoFixture('wanigan-regression-');
  const { addProject, removeProject } = await import('./store');
  const control = await import('./control');
  const proof = await import('./regression-proof');
  const worktrees = await import('./worktrees');
  const { prDraft } = await import('./pr-evidence');
  const { app } = await import('electron');
  try {
    repo.write('README.md', '# proof\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const project = await addProject(repo.dir);
    const goal = control.createDocket({ projectId: project.id, title: 'Receipts exist', objective: 'Write a receipt.', acceptance: ['fixed.txt exists.'], risk: 'low' });
    const verify = goal.nodes.find((n) => n.kind === 'verify')!;
    const implement = goal.nodes.find((n) => n.kind === 'implement')!;
    repo.write('fixed.txt', 'the fix\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'fix');

    let refused = '';
    try { await proof.runRegressionProof(verify.id); } catch (e) { refused = String(e); }
    check(/Name the test command first/.test(refused), 'a proof cannot run before a command has been saved through its confirmation', refused);
    let wrongKind = '';
    try { proof.saveProofCommand(implement.id, 'true'); } catch (e) { wrongKind = String(e); }
    check(/verify task/.test(wrongKind), 'a regression proof belongs to a verify task only');

    proof.saveProofCommand(verify.id, 'test -f fixed.txt');
    const proved = await proof.runRegressionProof(verify.id);
    check(proved.verdict === 'proved' && proved.before.exitCode === 1 && proved.after.exitCode === 0,
      'a test that fails at the goal\'s base commit and passes at head is proved', [proved.before.exitCode, proved.after.exitCode, proved.because]);
    const scratch = path.join(app.getPath('userData'), 'proof-worktrees');
    const left = fs.existsSync(scratch) ? fs.readdirSync(scratch) : [];
    check(left.length === 0 && repo.git('worktree', 'list').trim().split('\n').length === 1,
      'the scratch checkout of the base commit is removed afterwards and git no longer lists it', left);
    const row = db().prepare("SELECT status, summary, detail_json FROM work_proofs WHERE node_id = ? AND kind = 'regression'").get(verify.id) as { status: string; summary: string; detail_json: string };
    check(row.status === 'passed' && !row.summary.includes(repo.dir) && JSON.parse(row.detail_json).before.exitCode === 1,
      'the pair is stored as one work_proofs row, and its phone-visible summary names no path', row.summary);
    let gate = '';
    control.completeNode(goal.nodes.find((n) => n.kind === 'plan')!.id, { detail: 'Planned.' });
    control.completeNode(implement.id, { detail: 'Implemented.' });
    try { control.completeNode(verify.id, { detail: 'Proved.' }); } catch (e) { gate = String(e); }
    check(/Run and pass the review gate/.test(gate), 'a regression proof does not stand in for the review gate\'s pass');

    proof.saveProofCommand(verify.id, 'test -f README.md');
    check((await proof.runRegressionProof(verify.id)).verdict === 'not-a-regression-proof', 'a test that already passed at base is not a regression proof');
    proof.saveProofCommand(verify.id, 'wanigan-no-such-command-xyz');
    const gap = await proof.runRegressionProof(verify.id);
    check(gap.verdict === 'could-not-run-before' && /could not be executed|could not find/.test(gap.because),
      'a command the shell cannot find is a proof gap said in words, not a failure before', gap.because);
    check(proof.latestRegressionProof(verify.id)?.verdict === 'could-not-run-before', 'the latest proof reads back from the database');

    // PR body: a worktree branch a session ran on, and a branch nobody did.
    const sid = `p3-pr-${Date.now()}`;
    const wt = await worktrees.createWorktree(repo.dir, 'receipts', sid);
    const wbase = execFileSync('git', ['-C', wt.path, 'rev-parse', 'HEAD'], { stdio: 'pipe' }).toString().trim();
    insertSession(sid, project.id, repo.dir, wbase, { worktree: wt.path, exited: true });
    fs.writeFileSync(path.join(wt.path, 'receipt.ts'), 'export const receipt = 1;\n');
    execFileSync('git', ['-C', wt.path, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', wt.path, '-c', 'user.email=s@w.t', '-c', 'user.name=S', 'commit', '-qm', 'receipt'], { stdio: 'pipe' });
    insertEvent(sid, 'UserPromptSubmit'); insertEvent(sid, 'UserPromptSubmit');
    db().prepare('UPDATE work_nodes SET session_id = ? WHERE id = ?').run(sid, implement.id);
    const draft = await prDraft(wt.path);
    check(draft.kind === 'draft' && draft.body.includes('## Goal: Receipts exist') && draft.body.includes('- fixed.txt exists.')
      && draft.body.includes('- 2 turns recorded in the session') && draft.body.includes('`receipt.ts` +1 −0')
      && draft.body.endsWith("Written from Wanigan's recorded evidence."),
      'a worktree branch a goal session ran on gets a body of goal, turns, files and the evidence footer, with no model call', draft.kind === 'draft' ? draft.body : draft);
    const plain = await prDraft(repo.dir);
    check(plain.kind === 'none' && /No Wanigan session was launched on main/.test(plain.reason), 'a branch no session ran on gets no body, and says why', plain);

    await worktrees.removeWorktree(wt.path, true);
    removeProject(project.id);
  } catch (error) {
    check(false, 'the proof and PR checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
