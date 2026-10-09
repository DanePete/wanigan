// Per-turn checkpoints against real temporary repositories: what a capture
// leaves alone, what a turn's diff says, and every reason undo refuses.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { snapshot } from './checkpoints.ts';
import type { Core } from './core.ts';
import { sh, testCore, waitFor, type TestCore } from './test-support.ts';

const ID = '-c user.email=t@t -c user.name=t';
/** Reading state must not refresh the index it is comparing. */
const READ = 'GIT_OPTIONAL_LOCKS=0';

interface Row { kind: string; turn: number; commit_sha: string | null; not_captured: string | null; shared: number; files: number | null }
const rows = (core: Core, sessionId: string): Row[] =>
  core.db.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY id').all(sessionId) as Row[];

async function repo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'old.txt'), 'remove me\n');
  writeFileSync(join(dir, '.gitignore'), '*.log\n');
  await sh(`git init -q -b main && git ${ID} add -A && git ${ID} commit -qm init`, dir);
}

/** One turn as the hooks report it, ending in Stop; `work` runs while the agent "works". */
async function turn(t: TestCore, sessionId: string, work: () => unknown): Promise<void> {
  t.core.sessions.hook(sessionId, 'UserPromptSubmit', {});
  await work();
  t.core.sessions.hook(sessionId, 'Stop', {});
  await t.core.checkpoints.settled();
}

/** A Claude stand-in on a card of its own, in the card's worktree, at its prompt with the baseline taken. */
async function cardSession(t: TestCore): Promise<{ projectId: string; sessionId: string; cardId: string; wt: string }> {
  await repo(t.projectDir);
  const project = await t.owner.call('projects.add', { path: t.projectDir });
  const card = await t.owner.call('cards.create', { projectId: project.id, type: 'task', title: 'Checkpointed work' });
  const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', cardId: card.id, isolate: true });
  const wt = (await t.owner.call('cards.get', { id: card.id })).worktree!.path;
  t.core.sessions.hook(session.id, 'SessionStart', {});
  await t.core.checkpoints.settled();
  return { projectId: project.id, sessionId: session.id, cardId: card.id, wt };
}

/** Compare the actual checkout and checkpoint ledger around a refused write. */
async function undoRefusesWithoutChanges(t: TestCore, sessionId: string, cwd: string, reason: RegExp): Promise<void> {
  await t.core.checkpoints.settled();
  const offered = (await t.owner.call('sessions.checkpoints', { id: sessionId })).last;
  assert.ok(offered);
  assert.match(offered.refusal ?? '', reason);
  const index = resolve(cwd, (await sh('git rev-parse --git-path index', cwd)).trim());
  const files = (dir: string): unknown[] => readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '.git').sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const path = join(dir, entry.name);
    const mode = statSync(path).mode;
    // The unreadable-file refusal intentionally contains a mode-000 file.
    const bytes = entry.isDirectory() ? files(path) : mode & 0o444 ? readFileSync(path) : 'unreadable';
    return { name: entry.name, mode, bytes };
  });
  const state = async () => ({
    files: files(cwd), index: readFileSync(index),
    head: await sh('git rev-parse HEAD', cwd), branch: await sh('git symbolic-ref --quiet HEAD', cwd), refs: await sh('git show-ref', cwd),
    checkpoints: rows(t.core, sessionId),
  });
  const before = await state();
  await assert.rejects(t.owner.call('sessions.undoTurn', { id: sessionId, checkpoint: offered.checkpointId }), reason);
  assert.deepEqual(await state(), before, 'refused undo preserves files, modes, index, HEAD, branch, refs and checkpoint rows');
}

test('a capture leaves the status, index, HEAD, refs and stash exactly as they were', async () => {
  const t = await testCore();
  try {
    await repo(t.projectDir);
    // Something in every place a careless snapshot would disturb.
    writeFileSync(join(t.projectDir, 'stashed.txt'), 'kept aside\n');
    await sh(`git add stashed.txt && git ${ID} stash push -q -m aside`, t.projectDir);
    await sh(`git branch topic && echo staged >> app.txt && git add app.txt && echo unstaged >> app.txt`, t.projectDir);
    writeFileSync(join(t.projectDir, 'new.txt'), 'untracked\n');
    writeFileSync(join(t.projectDir, 'debug.log'), 'ignored\n');
    const state = async () => ({
      index: readFileSync(join(t.projectDir, '.git', 'index')).toString('base64'),
      status: await sh(`${READ} git status --porcelain=v1 --untracked-files=all`, t.projectDir),
      head: readFileSync(join(t.projectDir, '.git', 'HEAD'), 'utf8') + await sh('git rev-parse HEAD', t.projectDir),
      refs: await sh('git for-each-ref --format="%(refname) %(objectname)"', t.projectDir),
      stash: await sh('git stash list', t.projectDir),
      reflog: readFileSync(join(t.projectDir, '.git', 'logs', 'HEAD'), 'utf8'),
      objects: await sh('git count-objects', t.projectDir),
    });
    const before = await state();

    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    await t.core.checkpoints.settled();
    t.core.sessions.hook(session.id, 'Stop', {});
    assert.equal(rows(t.core, session.id).filter((r) => r.kind === 'turn').length, 0, 'the hook is answered before git runs');
    await t.core.checkpoints.settled();

    assert.deepEqual(await state(), before);
    const [start, end] = rows(t.core, session.id);
    assert.equal(start?.kind, 'start');
    assert.equal(end?.kind, 'turn');
    assert.ok(start?.commit_sha, 'the baseline was captured');
    // The checkpoint lives in Wanigan's own store, reading the repository's objects as an alternate.
    const stores = join(t.dir, 'data', 'checkpoint-objects');
    const store = `GIT_OBJECT_DIRECTORY='${join(stores, readdirSync(stores)[0] as string)}' GIT_ALTERNATE_OBJECT_DIRECTORIES='${join(t.projectDir, '.git', 'objects')}'`;
    assert.match(await sh(`git cat-file -t ${start!.commit_sha} 2>&1 || true`, t.projectDir), /(bad|not a valid|could not get)/i, 'not in the repository’s own .git');
    const tree = await sh(`${store} git ls-tree -r --name-only ${start!.commit_sha}`, t.projectDir);
    assert.deepEqual(tree.trim().split('\n').sort(), ['.gitignore', 'app.txt', 'new.txt', 'old.txt'], 'untracked files are in, ignored ones are not');
    assert.equal(await sh(`${store} git show ${start!.commit_sha}:app.txt`, t.projectDir), 'one\ntwo\nthree\nstaged\nunstaged\n', 'the working tree, not the index');
    assert.equal((await sh('git for-each-ref', t.projectDir)).includes(start!.commit_sha!), false, 'no ref points at a checkpoint');
    assert.equal(readFileSync(join(t.projectDir, 'debug.log'), 'utf8'), 'ignored\n');
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('a turn shows what changed in the folder, file by file', async () => {
  const t = await testCore();
  try {
    await repo(t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    await t.core.checkpoints.settled();
    await turn(t, session.id, () => {
      writeFileSync(join(t.projectDir, 'app.txt'), 'one\nTWO\nthree\n');
      rmSync(join(t.projectDir, 'old.txt'));
      writeFileSync(join(t.projectDir, 'added.txt'), 'a\nb\n');
      writeFileSync(join(t.projectDir, 'noise.log'), 'ignored\n');
    });
    await turn(t, session.id, () => writeFileSync(join(t.projectDir, 'added.txt'), 'a\nb\nc\n'));

    const listed = await t.owner.call('sessions.checkpoints', { id: session.id });
    assert.deepEqual(listed.checkpoints.map((c) => [c.kind, c.turn, c.files, c.additions, c.deletions]), [
      ['start', 0, null, null, null], ['turn', 1, 3, 3, 2], ['turn', 2, 1, 1, 0],
    ]);
    const first = listed.checkpoints[1]!;
    assert.ok(first.eventId, 'the turn is tied to the Stop that ended it');
    const changes = await t.owner.call('sessions.turnChanges', { id: session.id, checkpoint: first.id });
    assert.equal(changes.gone, null);
    assert.deepEqual(changes.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
      ['added.txt', 'A', 2, 0], ['app.txt', 'M', 1, 1], ['old.txt', 'D', 0, 1],
    ]);
    const app = changes.files.find((f) => f.path === 'app.txt')!;
    assert.match(app.diff ?? '', /^-two$/m);
    assert.match(app.diff ?? '', /^\+TWO$/m);
    assert.match(changes.files[0]!.diff ?? '', /^\+b$/m);
    const second = await t.owner.call('sessions.turnChanges', { id: session.id, checkpoint: listed.checkpoints[2]!.id });
    assert.deepEqual(second.files.map((f) => f.path), ['added.txt'], 'the second turn is only its own change');
    assert.match(second.files[0]!.diff ?? '', /^\+c$/m);
    // Shown in the project folder, undo is never offered there.
    assert.match(listed.last?.refusal ?? '', /only in a card’s own worktree/);
    await t.owner.call('sessions.stop', { id: session.id });
  } finally {
    await t.close();
  }
});

test('a folder that is not a repository, or a capture that runs out of time, says it was not captured', async () => {
  const t = await testCore();
  try {
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const session = await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude' });
    await t.core.checkpoints.settled();
    await turn(t, session.id, () => writeFileSync(join(t.projectDir, 'a.txt'), 'a\n'));
    const listed = await t.owner.call('sessions.checkpoints', { id: session.id });
    assert.deepEqual(listed.checkpoints.map((c) => [c.kind, c.notCaptured]), [['start', 'not a git repository'], ['turn', 'not a git repository']]);
    const changes = await t.owner.call('sessions.turnChanges', { id: session.id, checkpoint: listed.checkpoints[1]!.id });
    assert.match(changes.gone ?? '', /not captured: not a git repository/);
    await t.owner.call('sessions.stop', { id: session.id });

    await repo(join(t.dir, 'slow'));
    assert.deepEqual(await snapshot(join(t.dir, 'slow'), join(t.dir, 'data', 'checkpoints'), 1, true), { reason: 'it took longer than 1 ms' });
  } finally {
    await t.close();
  }
});

test('an edit the same size as before, made in the second the index was written, is in a checkpoint taken a second later', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wg-racy-')));
  const folder = join(dir, 'repo');
  const nextSecond = (): Promise<void> => new Promise((r) => setTimeout(r, 1_005 - (Date.now() % 1_000)));
  const second = (ms: number): number => Math.floor(ms / 1_000);
  try {
    // Commit, then edit within that same second, as a quick agent can. A second
    // boundary falling in between would not show the problem, so that is retried.
    for (let attempt = 1; ; attempt++) {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder);
      await nextSecond();
      writeFileSync(join(folder, 'app.txt'), 'one\ntwo\nthree\n');
      await sh(`git init -q -b main && git ${ID} add -A && git ${ID} commit -qm init`, folder);
      writeFileSync(join(folder, 'app.txt'), 'one\nTWO\nthree\n');
      if (second(statSync(join(folder, 'app.txt')).ctimeMs) === second(statSync(join(folder, '.git', 'index')).mtimeMs) || attempt === 5) break;
    }
    mkdirSync(join(dir, 'tmp'));
    await nextSecond();
    const shot = await snapshot(folder, join(dir, 'tmp'), 5_000, false);
    assert.ok(!('reason' in shot), JSON.stringify(shot));
    assert.equal((await sh(`git rev-parse ${shot.tree}:app.txt`, folder)).trim(), (await sh('git hash-object app.txt', folder)).trim(),
      'the checkpoint holds the file as it is, as `git status` sees it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex’s “turn complete” takes a checkpoint too, and another session in the folder is noted', async () => {
  const t = await testCore();
  try {
    await repo(t.projectDir);
    const project = await t.owner.call('projects.add', { path: t.projectDir });
    const shell = await t.owner.call('sessions.start', { projectId: project.id, provider: 'shell' });
    const codex = await t.owner.call('sessions.start', { projectId: project.id, provider: 'codex' });
    await waitFor('codex up', () => t.core.sessions.replay(codex.id).replay.includes('codex ready'));
    await t.core.checkpoints.settled();
    writeFileSync(join(t.projectDir, 'app.txt'), 'changed\n');
    await t.owner.call('sessions.input', { id: codex.id, data: 'done\r' });
    await waitFor('turn checkpoint', () => rows(t.core, codex.id).some((r) => r.kind === 'turn'));
    await t.core.checkpoints.settled();
    const [, end] = rows(t.core, codex.id);
    assert.deepEqual([end?.files, end?.shared], [1, 1], 'one file, and the shell was live in the same folder');
    assert.equal(rows(t.core, shell.id).length, 0, 'a shell has no turns to checkpoint');
    await t.owner.call('sessions.stop', { id: codex.id });
    await t.owner.call('sessions.stop', { id: shell.id });
  } finally {
    await t.close();
  }
});

test('undo puts the last turn back, redo puts it forward again, and both are in the timeline', async () => {
  const t = await testCore();
  try {
    const { sessionId, wt } = await cardSession(t);
    await turn(t, sessionId, () => writeFileSync(join(wt, 'first.txt'), 'turn one\n'));
    const indexFile = resolve(wt, (await sh('git rev-parse --git-path index', wt)).trim());
    const index = (): string => readFileSync(indexFile).toString('base64');
    const status = (): Promise<string> => sh(`${READ} git status --porcelain=v1 --untracked-files=all`, wt);
    const afterFirst = await status();
    const indexBefore = index();
    const binary = Buffer.from([0, 1, 2, 3, 255, 0, 7]);
    await turn(t, sessionId, () => {
      writeFileSync(join(wt, 'app.txt'), 'one\n2\nthree\n');
      rmSync(join(wt, 'old.txt'));
      writeFileSync(join(wt, 'new.txt'), 'brand new\n');
      writeFileSync(join(wt, 'pixel.bin'), binary);
    });

    const offered = await t.owner.call('sessions.checkpoints', { id: sessionId });
    assert.deepEqual([offered.last?.action, offered.last?.turn, offered.last?.files, offered.last?.refusal], ['undo', 2, 4, null]);
    const undone = await t.owner.call('sessions.undoTurn', { id: sessionId, checkpoint: offered.last!.checkpointId });
    assert.deepEqual(undone, { turn: 2, files: ['app.txt', 'new.txt', 'old.txt', 'pixel.bin'] });
    assert.equal(await status(), afterFirst, 'the folder is as turn 1 left it');
    assert.equal(readFileSync(join(wt, 'app.txt'), 'utf8'), 'one\ntwo\nthree\n');
    assert.equal(readFileSync(join(wt, 'old.txt'), 'utf8'), 'remove me\n');
    assert.ok(!existsSync(join(wt, 'new.txt')) && !existsSync(join(wt, 'pixel.bin')));
    assert.equal(readFileSync(join(wt, 'first.txt'), 'utf8'), 'turn one\n', 'turn 1 is untouched');
    assert.equal(index(), indexBefore, 'the working tree only: the index is as it was');
    const { events } = await t.owner.call('sessions.get', { id: sessionId });
    assert.deepEqual(events.slice(-1).map((e) => [e.event, e.summary]), [['Undo', 'You undid turn 2: 4 files']]);
    assert.ok((await t.owner.call('activity.list', { limit: 5 })).some((a) => a.verb === 'undid a turn'));

    await assert.rejects(t.owner.call('sessions.undoTurn', { id: sessionId, checkpoint: offered.last!.checkpointId }), /moved on/, 'a stale button is refused');
    const redo = await t.owner.call('sessions.checkpoints', { id: sessionId });
    assert.deepEqual([redo.last?.action, redo.last?.turn, redo.last?.refusal], ['redo', 2, null]);
    assert.equal(redo.last?.turnCheckpointId, offered.last!.checkpointId, 'the confirmation lists the turn’s own changes');
    await t.owner.call('sessions.redoTurn', { id: sessionId, checkpoint: redo.last!.checkpointId });
    assert.equal(readFileSync(join(wt, 'app.txt'), 'utf8'), 'one\n2\nthree\n');
    assert.ok(!existsSync(join(wt, 'old.txt')));
    assert.equal(readFileSync(join(wt, 'new.txt'), 'utf8'), 'brand new\n');
    assert.deepEqual(readFileSync(join(wt, 'pixel.bin')), binary, 'binary files come back byte for byte');
    const again = await t.owner.call('sessions.checkpoints', { id: sessionId });
    assert.deepEqual([again.last?.action, again.last?.refusal], ['undo', null], 'and it can be undone again');
    assert.equal((await t.owner.call('sessions.get', { id: sessionId })).events.at(-1)?.summary, 'You redid turn 2: 4 files');

    // The next turn starts from where the folder really is.
    await t.owner.call('sessions.undoTurn', { id: sessionId, checkpoint: again.last!.checkpointId });
    await turn(t, sessionId, () => writeFileSync(join(wt, 'third.txt'), 'three\n'));
    const third = (await t.owner.call('sessions.checkpoints', { id: sessionId })).checkpoints.at(-1)!;
    const changes = await t.owner.call('sessions.turnChanges', { id: sessionId, checkpoint: third.id });
    assert.deepEqual(changes.files.map((f) => f.path), ['third.txt']);
  } finally {
    await t.close();
  }
});

test('undo refuses whenever it could lose or misplace work', async () => {
  const t = await testCore();
  try {
    const { projectId, sessionId, wt } = await cardSession(t);
    const refusal = async (): Promise<string> => (await t.owner.call('sessions.checkpoints', { id: sessionId })).last?.refusal ?? '';
    assert.equal((await t.owner.call('sessions.checkpoints', { id: sessionId })).last, null, 'no turn yet, nothing to offer');
    await turn(t, sessionId, () => writeFileSync(join(wt, 'one.txt'), '1\n'));
    assert.equal(await refusal(), '');

    // Working.
    t.core.sessions.hook(sessionId, 'UserPromptSubmit', {});
    assert.match(await refusal(), /Claude is working/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /Claude is working/);
    t.core.sessions.hook(sessionId, 'PermissionRequest', { tool_name: 'Bash' });
    assert.match(await refusal(), /asking for permission/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /asking for permission/);
    t.core.sessions.hook(sessionId, 'Stop', {});
    await t.core.checkpoints.settled();
    assert.match(await refusal(), /changed no files/, 'a turn that changed nothing has nothing to undo');
    await undoRefusesWithoutChanges(t, sessionId, wt, /changed no files/);
    await turn(t, sessionId, () => writeFileSync(join(wt, 'two.txt'), '2\n'));
    assert.equal(await refusal(), '');

    // Another live session in the same folder.
    const other = await t.core.sessions.start({ projectId, provider: 'shell', cwd: wt, title: 'Poking around' });
    assert.match(await refusal(), /Poking around is also running in this folder/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /Poking around is also running in this folder/);
    await t.owner.call('sessions.stop', { id: other.id });
    await waitFor('other ended', async () => (await t.owner.call('sessions.get', { id: other.id })).session.state === 'ended');
    assert.equal(await refusal(), '');

    // The folder changed after the turn, by anyone.
    writeFileSync(join(wt, 'mine.txt'), 'the owner’s edit\n');
    assert.match(await refusal(), /folder has changed since turn 3 ended/);
    const stale = (await t.owner.call('sessions.checkpoints', { id: sessionId })).last!;
    await assert.rejects(t.owner.call('sessions.undoTurn', { id: sessionId, checkpoint: stale.checkpointId }), /folder has changed/);
    assert.equal(readFileSync(join(wt, 'mine.txt'), 'utf8'), 'the owner’s edit\n', 'nothing was touched');
    assert.ok(existsSync(join(wt, 'two.txt')));
    rmSync(join(wt, 'mine.txt'));
    assert.equal(await refusal(), '');

    // A commit since the turn.
    await sh(`git ${ID} commit -q --allow-empty -m "empty"`, wt);
    assert.match(await refusal(), /A commit was made since turn 3 ended/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /A commit was made since turn 3 ended/);

    // An agent that commits during its turn.
    await turn(t, sessionId, () => sh(`echo 4 > four.txt && git add four.txt && git ${ID} commit -qm four`, wt));
    assert.match(await refusal(), /Claude made a commit during turn 4/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /Claude made a commit during turn 4/);

    // A turn git could not read.
    await turn(t, sessionId, () => { writeFileSync(join(wt, 'locked.txt'), 'x\n'); chmodSync(join(wt, 'locked.txt'), 0o000); });
    assert.match(await refusal(), /Turn 5 was not captured \(git could not read the folder/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /Turn 5 was not captured \(git could not read the folder/);
    chmodSync(join(wt, 'locked.txt'), 0o644);
    assert.equal(readFileSync(join(wt, 'locked.txt'), 'utf8'), 'x\n');
    await turn(t, sessionId, () => writeFileSync(join(wt, 'six.txt'), '6\n'));
    assert.match(await refusal(), /The turn before turn 6 was not captured/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /The turn before turn 6 was not captured/);
    const six = (await t.owner.call('sessions.checkpoints', { id: sessionId })).checkpoints.at(-1)!;
    assert.match((await t.owner.call('sessions.turnChanges', { id: sessionId, checkpoint: six.id })).includes ?? '', /Turn 5 was not captured/);

    // An ended session is not working: only the gap still stands. The project folder never offers undo.
    await t.owner.call('sessions.stop', { id: sessionId });
    await waitFor('ended', async () => (await t.owner.call('sessions.get', { id: sessionId })).session.state === 'ended');
    assert.match(await refusal(), /The turn before turn 6 was not captured/);
    const inProject = await t.owner.call('sessions.start', { projectId, provider: 'claude' });
    await t.core.checkpoints.settled();
    await turn(t, inProject.id, () => writeFileSync(join(t.projectDir, 'p.txt'), 'p\n'));
    assert.match((await t.owner.call('sessions.checkpoints', { id: inProject.id })).last?.refusal ?? '', /only in a card’s own worktree/);
    await undoRefusesWithoutChanges(t, inProject.id, t.projectDir, /only in a card’s own worktree/);
    await t.owner.call('sessions.stop', { id: inProject.id });
  } finally {
    await t.close();
  }
});

test('a checkpoint git no longer has reads as gone, and cannot be undone', async () => {
  const t = await testCore();
  try {
    const { sessionId, wt } = await cardSession(t);
    await turn(t, sessionId, () => writeFileSync(join(wt, 'one.txt'), '1\n'));
    const listed = await t.owner.call('sessions.checkpoints', { id: sessionId });
    assert.equal(listed.last?.refusal, null);
    // Wanigan's store for the repository is gone (cleared by hand, say).
    rmSync(join(t.dir, 'data', 'checkpoint-objects'), { recursive: true, force: true });
    const changes = await t.owner.call('sessions.turnChanges', { id: sessionId, checkpoint: listed.checkpoints.at(-1)!.id });
    assert.match(changes.gone ?? '', /Git no longer has this checkpoint/);
    assert.deepEqual(changes.files, []);
    assert.match((await t.owner.call('sessions.checkpoints', { id: sessionId })).last?.refusal ?? '', /Git no longer has turn 1’s checkpoint/);
    await undoRefusesWithoutChanges(t, sessionId, wt, /Git no longer has turn 1’s checkpoint/);
    assert.ok(existsSync(join(wt, 'one.txt')), 'and nothing in the folder changed');
  } finally {
    await t.close();
  }
});

test('undo is refused when the turn changed .gitignore and would delete a file', async () => {
  const t = await testCore();
  try {
    const a = await cardSession(t);
    writeFileSync(join(a.wt, '.gitignore'), '*.local\n');
    writeFileSync(join(a.wt, '.env.local'), 'SECRET=owner_only\n');
    await turn(t, a.sessionId, () => writeFileSync(join(a.wt, 'x.txt'), 'x\n'));
    // The turn drops the *.local line, so git sees .env.local for the first time.
    await turn(t, a.sessionId, () => writeFileSync(join(a.wt, '.gitignore'), 'node_modules/\n'));
    const listed = await t.owner.call('sessions.checkpoints', { id: a.sessionId });
    assert.match(listed.last?.refusal ?? '', /changed \.gitignore/);
    await assert.rejects(t.owner.call('sessions.undoTurn', { id: a.sessionId, checkpoint: listed.last!.checkpointId }), /changed \.gitignore/);
    assert.equal(readFileSync(join(a.wt, '.env.local'), 'utf8'), 'SECRET=owner_only\n');
  } finally {
    await t.close();
  }
});

test('undo keeps a file that was there before the turn, though git could not see it then', async () => {
  const t = await testCore();
  try {
    const b = await cardSession(t);
    // Hidden by .git/info/exclude, which no diff shows.
    const exclude = join(resolve(b.wt, (await sh('git rev-parse --git-common-dir', b.wt)).trim()), 'info', 'exclude');
    writeFileSync(exclude, 'data.db\n');
    writeFileSync(join(b.wt, 'data.db'), 'owner data\n');
    await turn(t, b.sessionId, () => writeFileSync(join(b.wt, 'y.txt'), 'y\n'));
    await turn(t, b.sessionId, () => writeFileSync(exclude, ''));
    const listed = await t.owner.call('sessions.checkpoints', { id: b.sessionId });
    assert.match(listed.last?.refusal ?? '', /would delete data\.db, which was there before/);
    await undoRefusesWithoutChanges(t, b.sessionId, b.wt, /would delete data\.db, which was there before/);
    assert.ok(existsSync(join(b.wt, 'data.db')));
  } finally {
    await t.close();
  }
});

test('a large untracked file is left out of a checkpoint, and its turn still records', async () => {
  const t = await testCore();
  try {
    const { sessionId, wt } = await cardSession(t);
    await turn(t, sessionId, async () => {
      writeFileSync(join(wt, 'small.txt'), 'small\n');
      await sh('truncate -s 21m dev.sqlite3', wt); // sparse: 21 MB on paper, nothing on disk
    });
    const listed = await t.owner.call('sessions.checkpoints', { id: sessionId });
    const changes = await t.owner.call('sessions.turnChanges', { id: sessionId, checkpoint: listed.checkpoints.at(-1)!.id });
    assert.deepEqual(changes.files.map((f) => f.path), ['small.txt'], 'the 21 MB file is not copied into the checkpoint');
  } finally {
    await t.close();
  }
});

test('a same-size edit in the same second as the index is captured with its new content', async () => {
  const t = await testCore();
  try {
    const dir = join(t.dir, 'racy');
    mkdirSync(dir);
    await sh(`git init -q -b main && git config core.trustctime false`, dir);
    // Git trusts an entry whose cached stat matches, unless the index was written
    // in the same second as the file (racy). A copy with a fresh time loses that.
    const past = new Date(Date.now() - 100_000);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    utimesSync(join(dir, 'a.txt'), past, past);
    await sh(`git ${ID} add a.txt`, dir);
    writeFileSync(join(dir, 'a.txt'), 'TWO\n');
    utimesSync(join(dir, 'a.txt'), past, past);
    utimesSync(join(dir, '.git', 'index'), past, past);
    const shot = await snapshot(dir, t.dir, 15_000, false);
    assert.ok('tree' in shot, `captured (${'reason' in shot ? shot.reason : ''})`);
    assert.equal(await sh(`git cat-file -p ${shot.tree}:a.txt`, dir), 'TWO\n');
  } finally {
    await t.close();
  }
});

test('undo refuses while another project has an agent in a subfolder of the worktree', async () => {
  const t = await testCore();
  try {
    const { sessionId, wt } = await cardSession(t);
    await turn(t, sessionId, () => writeFileSync(join(wt, 'app.txt'), 'changed by the turn\n'));
    assert.equal((await t.owner.call('sessions.checkpoints', { id: sessionId })).last?.refusal, null);
    const nested = join(wt, 'nested');
    mkdirSync(nested);
    const project = await t.owner.call('projects.add', { path: nested });
    await t.owner.call('sessions.start', { projectId: project.id, provider: 'claude', title: 'Nested editor' });
    const offered = (await t.owner.call('sessions.checkpoints', { id: sessionId })).last!;
    assert.match(offered.refusal ?? '', /Nested editor is also running/);
    await assert.rejects(t.owner.call('sessions.undoTurn', { id: sessionId, checkpoint: offered.checkpointId }), /Nested editor is also running/);
    assert.equal(readFileSync(join(wt, 'app.txt'), 'utf8'), 'changed by the turn\n');
  } finally {
    await t.close();
  }
});

test('an unreadable deletion safety check refuses undo and preserves pre-existing data', async () => {
  const t = await testCore();
  const priorPath = process.env.PATH;
  try {
    const b = await cardSession(t);
    const exclude = join(resolve(b.wt, (await sh('git rev-parse --git-common-dir', b.wt)).trim()), 'info', 'exclude');
    writeFileSync(exclude, 'data.db\n');
    writeFileSync(join(b.wt, 'data.db'), 'owner data\n');
    await turn(t, b.sessionId, () => writeFileSync(join(b.wt, 'y.txt'), 'y\n'));
    await turn(t, b.sessionId, () => writeFileSync(exclude, ''));
    const bin = join(t.dir, 'git-fault');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor arg do\n  if [ "$arg" = "--name-status" ] && [ -f "$0.once" ]; then rm "$0.once"; echo "injected read failure" >&2; exit 1; fi\ndone\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const index = resolve(b.wt, (await sh('git rev-parse --git-path index', b.wt)).trim());
    const beforeIndex = readFileSync(index);
    const beforeRows = rows(t.core, b.sessionId);
    const beforeFiles = ['app.txt', 'y.txt', 'data.db'].map((name) => readFileSync(join(b.wt, name)));
    const listed = await t.owner.call('sessions.checkpoints', { id: b.sessionId });
    process.env.PATH = `${bin}:${priorPath}`;
    writeFileSync(join(bin, 'git.once'), 'fail only the safety read, not the later patch read');
    await assert.rejects(t.owner.call('sessions.undoTurn', { id: b.sessionId, checkpoint: listed.last!.checkpointId }), /could not check.*delete/i);
    assert.equal(existsSync(join(bin, 'git.once')), false, 'the injected safety failure was exercised');
    assert.deepEqual(['app.txt', 'y.txt', 'data.db'].map((name) => readFileSync(join(b.wt, name))), beforeFiles);
    assert.deepEqual(readFileSync(index), beforeIndex, 'undo refusal preserves the real index bytes');
    assert.deepEqual(rows(t.core, b.sessionId), beforeRows, 'undo refusal adds no checkpoint');
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    await t.close();
  }
});
