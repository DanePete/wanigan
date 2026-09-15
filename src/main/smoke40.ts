import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/*
 * Helper sweep · P11 — dependencies, finished. Real repositories, real git and
 * real per-turn checkpoints for which turn added a package; a loopback HTTP
 * server standing in for OSV and the two registries for the advisory lookup,
 * added with it.
 * Nothing here reaches the network, and no agent runs.
 */

function repoFixture(prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@wanigan.test');
  git('config', 'user.name', 'Smoke');
  return { dir, git, write };
}

function insertSession(id: string, projectId: string, projectPath: string, base: string) {
  const now = Date.now();
  db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, harness_id, project_id, project_path, project_name, started_at, ended_at, exit_code, worktree, baseline_head, baseline_dirty_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, null, 'claude', 'claude-code', projectId, projectPath, path.basename(projectPath),
    now - 60_000, now - 1_000, 0, null, base, JSON.stringify([]));
}

function bash(sessionId: string, command: string, ok = 1) {
  db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json) VALUES (?,?,?,?,?,?,?,?)')
    .run(sessionId, Date.now(), 'PostToolUse', 'Bash', command, null, ok, null);
}

const tick = () => new Promise((r) => setTimeout(r, 12));
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'app', version: '1.0.0', dependencies: deps }, null, 2) + '\n';

/** Item 1: which turn added each package, from real checkpoints in a real repository. */
export async function runDependencyTurnsSmoke(check: Check, say: Say): Promise<void> {
  say('── dependencies · which turn added each package');
  const repo = repoFixture('wanigan-dep-turns-');
  const checkpoints = await import('./checkpoints');
  const work = await import('./review-work');
  const { addProject, removeProject } = await import('./store');
  const sid = `p11-turns-${Date.now()}`;
  try {
    repo.write('package.json', pkg({ react: '^19.0.0' }));
    repo.write('README.md', '# app\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'base');
    const base = repo.git('rev-parse', 'HEAD').trim();
    const project = await addProject(repo.dir);
    insertSession(sid, project.id, repo.dir, base);

    // Before launch: the operator's own uncommitted edit adds left-pad.
    repo.write('package.json', pkg({ react: '^19.0.0', 'left-pad': '1.3.0' }));
    checkpoints.__test.registerSessionCheckpoints({ sessionId: sid, cwd: repo.dir, hooksCapable: true, gitHead: base });
    await checkpoints.__test.awaitIdle(sid);

    // Turn 1 touches the README and runs an install that is not the one turn 2 needs.
    checkpoints.__test.enqueueBoundary(sid, 'turn-start');
    await checkpoints.__test.awaitIdle(sid); await tick();
    bash(sid, 'pip install requests');
    repo.write('README.md', '# app\n\nNow with retries.\n');
    await tick();
    checkpoints.__test.enqueueBoundary(sid, 'turn-end');
    await checkpoints.__test.awaitIdle(sid); await tick();

    // Turn 2 adds p-retry with an install command.
    checkpoints.__test.enqueueBoundary(sid, 'turn-start');
    await checkpoints.__test.awaitIdle(sid); await tick();
    bash(sid, 'npm install p-retry@6.2.0');
    repo.write('package.json', pkg({ react: '^19.0.0', 'left-pad': '1.3.0', 'p-retry': '6.2.0' }));
    await tick();
    checkpoints.__test.enqueueBoundary(sid, 'turn-end');
    await checkpoints.__test.awaitIdle(sid); await tick();
    await checkpoints.__test.finalizeSessionCheckpoints(sid);

    // After the last snapshot: zod, by hand, and a test run that is no install.
    repo.write('package.json', pkg({ react: '^19.0.0', 'left-pad': '1.3.0', 'p-retry': '6.2.0', zod: '3.23.8' }));
    bash(sid, 'npm test', 0);

    const rows = checkpoints.listCheckpoints(sid);
    check(rows.filter((r) => r.commitHash).length >= 5 && rows.some((r) => r.turn === 2 && r.kind === 'turn-end'),
      'the session captured a launch snapshot and a start and end snapshot for each of two turns', rows.map((r) => `${r.turn}:${r.kind}:${r.status}`));

    const deps = await work.dependencyReview(sid);
    const manifest = deps.manifests.find((m) => m.path === 'package.json');
    const byName = Object.fromEntries((manifest?.changes ?? []).map((c, i) => [c.name, manifest?.attributions?.[i] ?? null]));
    check(!!manifest && manifest.changes.map((c) => c.name).sort().join() === 'left-pad,p-retry,zod',
      'the branch diff finds three added packages', manifest?.changes);
    const pRetry = byName['p-retry'];
    const turn2Start = rows.find((r) => r.turn === 2 && r.kind === 'turn-start');
    const turn2End = rows.find((r) => r.turn === 2 && r.kind === 'turn-end');
    check(pRetry?.state === 'turn' && pRetry.turn === 2 && pRetry.fromCheckpoint === turn2Start?.id && pRetry.toCheckpoint === turn2End?.id,
      'p-retry is attributed to turn 2, between the two checkpoints the Turns tab opens for turn 2', pRetry);
    check(pRetry?.state === 'turn' && pRetry.install.state === 'ran' && pRetry.install.commands.length === 1
      && pRetry.install.commands[0].command === 'npm install p-retry@6.2.0',
      'turn 2 records that its own install command ran, and not turn 1\'s pip install', pRetry?.state === 'turn' ? pRetry.install : null);
    check(byName['left-pad']?.state === 'before-first-checkpoint',
      'left-pad, already in the working tree at launch, is "before the first checkpoint", not turn 1', byName['left-pad']);
    check(byName.zod?.state === 'outside-turns' && /since the last snapshot, after turn 2/.test(byName.zod.detail),
      'zod, added after the last snapshot, is "outside the recorded turns" and says where', byName.zod);

    const lean = await work.dependencyReview(sid, { turns: false });
    check(lean.manifests.every((m) => m.attributions === null), 'the advisory lookup reads the same review without paying for attribution');

    // A session with no checkpoints names no turn.
    const bare = `p11-bare-${Date.now()}`;
    insertSession(bare, project.id, repo.dir, base);
    const none = await work.dependencyReview(bare);
    check(none.manifests[0]?.attributions?.every((a) => a.state === 'no-checkpoints') === true,
      'a session with no checkpoints says so on every row instead of guessing a turn', none.manifests[0]?.attributions);

    // A snapshot whose manifest is broken stops the search rather than skipping past it.
    const broken = `p11-broken-${Date.now()}`;
    repo.write('package.json', pkg({ react: '^19.0.0' }));
    repo.git('add', '-A'); repo.git('commit', '-qm', 'reset');
    const base2 = repo.git('rev-parse', 'HEAD').trim();
    insertSession(broken, project.id, repo.dir, base2);
    checkpoints.__test.registerSessionCheckpoints({ sessionId: broken, cwd: repo.dir, hooksCapable: true, gitHead: base2 });
    await checkpoints.__test.awaitIdle(broken);
    checkpoints.__test.enqueueBoundary(broken, 'turn-start'); await checkpoints.__test.awaitIdle(broken); await tick();
    repo.write('package.json', '{ "dependencies": ');
    checkpoints.__test.enqueueBoundary(broken, 'turn-end'); await checkpoints.__test.awaitIdle(broken); await tick();
    checkpoints.__test.enqueueBoundary(broken, 'turn-start'); await checkpoints.__test.awaitIdle(broken); await tick();
    repo.write('package.json', pkg({ react: '^19.0.0', ms: '2.1.3' }));
    checkpoints.__test.enqueueBoundary(broken, 'turn-end'); await checkpoints.__test.awaitIdle(broken);
    await checkpoints.__test.finalizeSessionCheckpoints(broken);
    const unreadable = await work.dependencyReview(broken);
    const ms = unreadable.manifests[0]?.attributions?.[0];
    check(ms?.state === 'unknown' && /could not be read at the turn-end snapshot of turn 1/.test(ms.detail),
      'a manifest that could not be parsed at turn 1\'s end makes turn 2 unknown rather than first', ms);

    for (const id of [sid, bare, broken]) checkpoints.forgetSessionCheckpoints(id);
    removeProject(project.id);
  } catch (error) {
    check(false, 'the dependency-turn checks ran without throwing', error instanceof Error ? error.stack : String(error));
  } finally {
    try { fs.rmSync(repo.dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
