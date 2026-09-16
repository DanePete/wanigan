import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { runGit } from './git';
import { addProject } from './store';
import * as review from './review';

type Check = (ok: boolean, label: string, detail?: unknown) => void;

/** Real Git/worktrees and shell commands, isolated from user data and providers. */
export async function runReviewSmoke(check: Check, say: (text: string) => void): Promise<void> {
  say('── review evidence · session checkout, content and recipe freshness');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-review-'));
  const repo = path.join(dir, 'project'); const tree = path.join(dir, 'session');
  fs.mkdirSync(repo);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runGit(cwd, args, { timeout: 15_000 });
    if (!result.ok) throw new Error(result.err);
    return result.out;
  };
  const refused = async (action: () => Promise<unknown>) => {
    try { await action(); return ''; } catch (error) { return String(error); }
  };
  try {
    await git(repo, 'init');
    fs.writeFileSync(path.join(repo, 'fixture.txt'), 'primary\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-m', 'fixture');
    await git(repo, 'worktree', 'add', '-b', 'review-fixture', tree);
    fs.writeFileSync(path.join(tree, 'fixture.txt'), 'isolated\n');
    const project = await addProject(repo);
    const sessionId = `review-session-${Date.now()}`;
    db().prepare(`INSERT INTO session_log (id,provider_id,project_id,project_path,project_name,worktree,started_at)
      VALUES (?,?,?,?,?,?,?)`).run(sessionId, 'codex', project.id, project.path, project.name, tree, Date.now());
    const commands = ['test "$(cat fixture.txt)" = isolated', 'printf "session checkout verified"'];
    review.saveRecipe(project.id, commands);
    const primary = await review.run(project.id);
    const isolated = await review.run(project.id, sessionId);
    check(primary.status === 'failed' && primary.results.length === 1 && isolated.status === 'passed'
      && isolated.results[1]?.output === 'session checkout verified',
    'session review runs the real commands in its isolated checkout; the same recipe fails in the primary checkout');
    check(isolated.evidence?.sessionId === sessionId && isolated.evidence.before.cwd === fs.realpathSync(tree)
      && !!isolated.evidence.before.head && isolated.evidence.commands.join('\n') === commands.join('\n')
      && isolated.freshness.state === 'current', 'a run records session, canonical cwd, revision, recipe and matching content', isolated);
    check(review.history(project.id).every(run => run.id !== isolated.id)
      && review.history(project.id, 12, sessionId).every(run => run.id !== primary.id),
    'session and project histories cannot borrow one another’s passes');
    check(await review.isCurrentPass(isolated.id, project.id, tree)
      && !await review.isCurrentPass(isolated.id, project.id, repo), 'only the tested checkout can use a recorded pass');

    const file = path.join(tree, 'fixture.txt'); const times = fs.statSync(file);
    fs.writeFileSync(file, 'modified\n'); fs.utimesSync(file, times.atime, times.mtime);
    check(!await review.isCurrentPass(isolated.id, project.id, tree),
      'same-size content edits invalidate evidence even when the timestamp is restored');
    fs.writeFileSync(file, 'isolated\n');
    fs.writeFileSync(path.join(tree, 'new.bin'), Buffer.from([0, 1, 2]));
    check((await review.historyWithFreshness(project.id, 12, sessionId))[0]?.freshness.state === 'stale',
      'new nonignored binary content marks a recorded result stale');
    fs.unlinkSync(path.join(tree, 'new.bin'));
    fs.writeFileSync(path.join(tree, 'ignored.txt'), 'excluded by design');
    check(await review.isCurrentPass(isolated.id, project.id, tree), 'ignored content stays outside the stated comparison');
    await git(tree, 'add', 'fixture.txt');
    check(!await review.isCurrentPass(isolated.id, project.id, tree), 'staging changes invalidate the recorded index identity');
    await git(tree, 'reset', 'HEAD', '--', 'fixture.txt');
    review.saveRecipe(project.id, ['true']);
    check(!await review.isCurrentPass(isolated.id, project.id, tree), 'changed saved commands invalidate a prior pass');
    review.saveRecipe(project.id, ['printf "changed during checks" > fixture.txt']);
    const changing = await review.run(project.id, sessionId);
    check(changing.status === 'passed' && changing.freshness.state === 'stale',
      'successful commands that change checked content retain their exit status but are stale immediately');
    fs.writeFileSync(file, 'isolated\n');
    review.saveRecipe(project.id, ['true']);
    const restored = await review.run(project.id, sessionId);
    check(restored.freshness.state === 'current', 'rerunning against stable content records a usable comparison');
    await git(tree, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '--allow-empty', '-m', 'new head');
    check(!await review.isCurrentPass(restored.id, project.id, tree), 'a new HEAD invalidates evidence even with identical file bytes');

    const legacyId = `review-legacy-${Date.now()}`;
    db().prepare('INSERT INTO review_runs (id,project_id,started_at,ended_at,status,results_json) VALUES (?,?,?,?,?,?)')
      .run(legacyId, project.id, Date.now() + 10, Date.now() + 11, 'passed', '[]');
    const legacy = (await review.historyWithFreshness(project.id)).find(run => run.id === legacyId);
    check(legacy?.status === 'passed' && legacy.evidence === null && legacy.freshness.state === 'unavailable'
      && !await review.isCurrentPass(legacyId, project.id, repo), 'legacy passes remain readable without invented provenance or approval authority');
    check(!!await refused(() => review.run(project.id, 'missing-session'))
      && !!await refused(() => review.run(project.id, { cwd: repo } as unknown as string)),
    'missing sessions and forged cwd objects are refused by the main-process boundary');

    const other = await addProject(dir);
    check(!!await refused(() => review.run(other.id, sessionId)), 'a session cannot run another project’s recipe');
    fs.renameSync(tree, `${tree}-held`);
    check((await review.historyWithFreshness(project.id, 12, sessionId))[0]?.freshness.state === 'unavailable'
      && /missing or unreadable/.test(await refused(() => review.run(project.id, sessionId))),
    'a vanished worktree keeps its history and refuses execution without falling back to the primary checkout');
    fs.mkdirSync(tree); await git(tree, 'init');
    check(/no longer belongs/.test(await refused(() => review.run(project.id, sessionId)))
      && (await review.historyWithFreshness(project.id, 12, sessionId))[0]?.freshness.state === 'unavailable',
      'a replacement repository at the saved worktree path is not the session checkout');

    review.saveRecipe(project.id, ['while [ ! -f ignored.txt ]; do sleep 0.01; done']);
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'release the check');
    const previous = await review.run(project.id);
    fs.unlinkSync(path.join(repo, 'ignored.txt'));
    const pending = review.run(project.id);
    try {
      check(review.history(project.id).some(run => run.status === 'running'),
        'starting a project run records its running receipt before asynchronous fingerprinting');
      const duplicate = await refused(() => review.run(project.id));
      check(!await review.isCurrentPass(previous.id, project.id, repo),
        'a rerun in progress cannot be outvoted by a previous passing run');
      let finalGuardRefused = false;
      try { review.assertPassNotSuperseded(previous.id, project.id, repo); } catch { finalGuardRefused = true; }
      check(finalGuardRefused, 'the synchronous approval guard refuses a rerun without another filesystem await');
      check(/already running/.test(duplicate), 'a second launch cannot overlap checks in the same checkout');
    } finally {
      fs.writeFileSync(path.join(repo, 'ignored.txt'), 'release the check');
      await pending;
      fs.unlinkSync(path.join(repo, 'ignored.txt'));
    }

    review.saveRecipe(project.id, ['test ! -f ignored.txt']);
    const earlierPass = await review.run(project.id);
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'test input outside the fingerprint');
    const laterFailure = await review.run(project.id);
    check(earlierPass.status === 'passed' && laterFailure.status === 'failed'
      && earlierPass.evidence?.before.fingerprint === laterFailure.evidence?.before.fingerprint
      && !await review.isCurrentPass(earlierPass.id, project.id, repo),
    'a newer standalone failure supersedes an older pass even with unchanged Git-visible content');
    fs.unlinkSync(path.join(repo, 'ignored.txt'));
    const latestPass = await review.run(project.id);
    check(await review.isCurrentPass(latestPass.id, project.id, repo),
      'a fresh successful rerun restores usable verification after a standalone failure');
    review.saveRecipe(other.id, ['true']);
    const nonGit = await review.run(other.id);
    check(nonGit.status === 'passed' && nonGit.freshness.state === 'unavailable',
      'non-Git projects can run commands without claiming a content fingerprint');
  } catch (error) { check(false, 'review evidence smoke completed', String(error)); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
