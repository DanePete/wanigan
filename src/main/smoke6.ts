import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './git';
import { addProject } from './store';
import * as checkpoints from './checkpoints';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Offline contract tests for per-turn checkpoints, against a real temp git
 * repository. Turn boundaries are driven through the module's own test hooks
 * rather than a live agent, so this exercises the same capture queue, refs,
 * diff and revert paths the app uses — no PTY, no network, no provider.
 */
export async function runCheckpointSmoke(check: Check, say: Say): Promise<void> {
  say('── per-turn checkpoints · capture, diff, revert, cleanup');

  const probe = await runGit(os.tmpdir(), ['--version'], { timeout: 8_000 });
  if (!probe.ok) {
    check(false, 'git is available for the checkpoint suite', probe.err);
    return;
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-checkpoints-'));
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
  const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
  const git = async (...args: string[]) => {
    const r = await runGit(repo, args, { timeout: 15_000 });
    if (!r.ok) throw new Error(`git ${args[0]}: ${r.err}`);
    return r.out;
  };
  const sessionId = `cp-smoke-${Date.now()}`;
  const rowsOf = () => checkpoints.listCheckpoints(sessionId);
  const refNames = async () => (await git('for-each-ref', '--format=%(refname)', 'refs/wanigan/'))
    .split('\n').filter(Boolean);

  try {
    await git('init');
    write('a.txt', 'committed\n');
    write('.gitignore', 'ignored.txt\n');
    await git('add', '-A');
    await git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'fixture');
    const head = (await git('rev-parse', 'HEAD')).trim();
    // Pre-session dirty state plus an ignored file the snapshot must not see.
    write('a.txt', 'dirty before the session\n');
    write('ignored.txt', 'never captured\n');
    await addProject(repo);

    // ── launch snapshot ────────────────────────────────────────────────
    checkpoints.__test.registerSessionCheckpoints({ sessionId, cwd: repo, hooksCapable: true, gitHead: head });
    await checkpoints.__test.awaitIdle(sessionId);
    let rows = rowsOf();
    const launch = rows.find((r) => r.kind === 'session-start');
    check(rows.length === 1 && launch?.status === 'ok' && !!launch.commitHash,
      'registration captures a launch snapshot as a real commit', JSON.stringify(rows));
    const launchTree = await git('ls-tree', '-r', '--name-only', launch!.commitHash!);
    check(launchTree.includes('a.txt') && !launchTree.includes('ignored.txt'),
      'the snapshot holds tracked state and respects .gitignore', launchTree);
    check((await refNames()).length === 1,
      'one hidden ref keeps the chain alive, outside refs/heads', (await refNames()).join());
    const status = await git('status', '--porcelain');
    check(status.includes('a.txt'),
      'capture leaves the real index and working tree untouched', status);

    // ── turn boundaries ────────────────────────────────────────────────
    checkpoints.__test.enqueueBoundary(sessionId, 'turn-start');
    await checkpoints.__test.awaitIdle(sessionId);
    checkpoints.__test.enqueueBoundary(sessionId, 'turn-end');
    await checkpoints.__test.awaitIdle(sessionId);
    rows = rowsOf();
    const t1end = rows.find((r) => r.turn === 1 && r.kind === 'turn-end');
    check(t1end?.status === 'skipped-unchanged' && t1end.commitHash === launch!.commitHash,
      'an unchanged tree records a dedup row instead of a new commit', JSON.stringify(t1end));

    // Turn 2 edits a file and creates one — the agent's work.
    checkpoints.__test.enqueueBoundary(sessionId, 'turn-start');
    await checkpoints.__test.awaitIdle(sessionId);
    write('a.txt', 'the agent rewrote this\n');
    write('b.txt', 'the agent created this\n');
    checkpoints.__test.enqueueBoundary(sessionId, 'turn-end');
    await checkpoints.__test.awaitIdle(sessionId);
    rows = rowsOf();
    const t2start = rows.find((r) => r.turn === 2 && r.kind === 'turn-start');
    const t2end = rows.find((r) => r.turn === 2 && r.kind === 'turn-end');
    check(t2end?.status === 'ok' && t2end.filesChanged === 2,
      'a turn that changed two files records exactly two', JSON.stringify(t2end));

    const diff = await checkpoints.checkpointDiff(sessionId, t2start!.id, t2end!.id);
    const diffPaths = diff.files.map((f) => f.path).sort().join(',');
    check(diffPaths === 'a.txt,b.txt' && diff.patch.includes('the agent rewrote this') && !diff.truncated,
      'the per-turn diff names the turn\u2019s files and carries the patch', diffPaths);

    // ── revert to before turn 2 ────────────────────────────────────────
    const plan = await checkpoints.checkpointRevertPlan(sessionId, t2start!.id);
    const planned = plan.files.map((f) => `${f.action}:${f.path}`).sort().join(',');
    check(plan.ok && planned === 'delete:b.txt,restore:a.txt',
      'the revert plan says restore a.txt and delete b.txt before touching anything', planned);

    const result = await checkpoints.applyCheckpointRevert(sessionId, t2start!.id);
    check(result.ok && result.reverted === 1 && result.deleted === 1,
      'the revert restores one file and deletes one', JSON.stringify(result));
    check(read('a.txt') === 'dirty before the session\n' && !fs.existsSync(path.join(repo, 'b.txt')),
      'pre-session dirty content is back and the created file is gone');
    check(result.preRevertCheckpointId != null
        && rowsOf().some((r) => r.id === result.preRevertCheckpointId && r.kind === 'pre-revert' && r.commitHash),
      'a pre-revert snapshot was captured first, so the revert is itself undoable');

    const again = await checkpoints.checkpointRevertPlan(sessionId, t2start!.id);
    check(again.ok && again.totalFiles === 0,
      'a second plan against the same checkpoint reports nothing to do', JSON.stringify(again));

    // ── shutdown and honesty gates ─────────────────────────────────────
    await checkpoints.__test.finalizeSessionCheckpoints(sessionId);
    check(rowsOf().some((r) => r.kind === 'session-end') && !checkpoints.__test.isLive(sessionId),
      'finalize records a session-end snapshot and releases the live state');

    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-nogit-'));
    try {
      checkpoints.__test.registerSessionCheckpoints({ sessionId: `${sessionId}-nogit`, cwd: nonGit, hooksCapable: true, gitHead: null });
      await checkpoints.__test.awaitIdle(`${sessionId}-nogit`);
      check(checkpoints.listCheckpoints(`${sessionId}-nogit`).length === 0 && !checkpoints.__test.isLive(`${sessionId}-nogit`),
        'a session outside a git repo gets an honest absence, not a simulation');
      checkpoints.__test.registerSessionCheckpoints({ sessionId: `${sessionId}-nohooks`, cwd: repo, hooksCapable: false, gitHead: head });
      await checkpoints.__test.awaitIdle(`${sessionId}-nohooks`);
      check(checkpoints.listCheckpoints(`${sessionId}-nohooks`).length === 0,
        'a provider without proven hooks captures nothing rather than guessing turn boundaries');
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }

    // ── cleanup paths ──────────────────────────────────────────────────
    checkpoints.forgetSessionCheckpoints(sessionId);
    // The ref delete is fire-and-forget; give it one tick to land.
    await new Promise((r) => setTimeout(r, 250));
    check(rowsOf().length === 0 && (await refNames()).length === 0,
      'forgetting the session removes its rows and its hidden ref', (await refNames()).join());

    const counted = await checkpoints.removeRepoCheckpoints(repo, false);
    check(counted.refs === 0 && !counted.applied,
      'the repo-wide cleanup counts before it deletes, and finds the repo already clean', JSON.stringify(counted));
  } catch (e) {
    check(false, `checkpoint smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
