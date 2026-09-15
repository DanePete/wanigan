/**
 * Worktree bootstrap's pure half. The filesystem, git and shell work is
 * exercised against real repositories in src/main/smoke16.ts; this is what is
 * decided and said about it.
 *
 * The subject, as in collisions.test.ts, is "can it lie": a port block that
 * walks off its range, a command list saved shorter than it was typed, a
 * failed read reported as "nothing matched", or a failed setup that reads as
 * the reason an agent is missing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PORT_BLOCKS, PORT_BLOCK_SIZE, PORT_FIRST, PORT_LAST, asDepsMode, bootstrapFacts, describeDeps, describeInclude,
  includePatternCount, isPortBlockBase, isSafeRelative, launchSetupNote, newCommands, outputTail, parseCommandInput,
  portBlockBase, portsText, runFacts, seedFromHex, summarizeRun,
  type IncludeOutcome, type WorktreeCommandRun,
} from './worktree-bootstrap.ts';

const read = (over: Partial<Extract<IncludeOutcome, { state: 'read' }>> = {}): IncludeOutcome => ({
  state: 'read', patterns: 3, copied: 0, bytes: 0, present: 0, notIgnored: 0, symlinks: 0, outside: 0,
  failed: 0, failure: null, stopped: null, cloneable: true, ...over,
});

const run = (over: Partial<WorktreeCommandRun> = {}): WorktreeCommandRun => ({
  id: 'wtr_1', projectId: 'p1', worktree: '/data/worktrees/app-abc123', phase: 'setup',
  startedAt: 1_000, endedAt: 3_300, status: 'passed', planned: 2,
  results: [
    { command: 'npm ci', exitCode: 0, output: 'added 812 packages\n', durationMs: 2_000 },
    { command: 'npm run build', exitCode: 0, output: 'built\n', durationMs: 300 },
  ],
  env: null, note: null, ...over,
});

test('the three dependency choices are the only ones accepted', () => {
  assert.equal(asDepsMode('link'), 'link');
  assert.equal(asDepsMode('clone'), 'clone');
  assert.equal(asDepsMode('skip'), 'skip');
  for (const bad of ['Link', 'copy', '', null, undefined, 1, ['clone']]) assert.equal(asDepsMode(bad), null);
});

test('every port block is ten ports inside 42000–48999, and the range holds exactly 700 of them', () => {
  assert.equal(PORT_BLOCKS, 700);
  for (const seed of [0, 1, 699, 700, 4_294_967_295, 123_456_789]) {
    for (const attempt of [0, 1, 31, 700]) {
      const base = portBlockBase(seed, attempt);
      assert.ok(isPortBlockBase(base), `${seed}/${attempt} → ${base}`);
      assert.ok(base + PORT_BLOCK_SIZE - 1 <= PORT_LAST);
    }
  }
  assert.equal(portBlockBase(0), PORT_FIRST);
  assert.equal(portBlockBase(PORT_BLOCKS - 1), PORT_LAST - PORT_BLOCK_SIZE + 1);
});

test('a seed always lands on the same block, and each attempt is the next block along, wrapping at the top', () => {
  assert.equal(portBlockBase(123_456), portBlockBase(123_456));
  assert.equal(portBlockBase(5, 1) - portBlockBase(5, 0), PORT_BLOCK_SIZE);
  assert.equal(portBlockBase(PORT_BLOCKS - 1, 1), PORT_FIRST, 'the block after the last is the first, not 49000');
});

test('nonsense seeds and attempts still name a real block rather than NaN', () => {
  assert.equal(portBlockBase(Number.NaN), PORT_FIRST);
  assert.equal(portBlockBase(-701, -3), portBlockBase(701, 0));
  assert.equal(isPortBlockBase(42_005), false);
  assert.equal(isPortBlockBase(49_000), false);
  assert.equal(isPortBlockBase('42000'), false);
});

test('a seed is read from the head of a hex digest, and anything else seeds zero', () => {
  assert.equal(seedFromHex('ffffffff00'), 4_294_967_295);
  assert.equal(seedFromHex('0000002a'), 42);
  assert.equal(seedFromHex('not-hex!'), 0);
  assert.equal(seedFromHex(''), 0);
});

test('the ports read as a range a person would type', () => {
  assert.equal(portsText({ base: 42_310, count: 10 }), '42310–42319');
});

test('only blank lines and lines that start with # are not patterns', () => {
  assert.equal(includePatternCount('.env\n\n# secrets\n  \n.env.local\r\n'), 2);
  assert.equal(includePatternCount('\\#literal\n  #indented is a pattern to git\n'), 2);
  assert.equal(includePatternCount(''), 0);
});

test('a path git listed is joined onto a worktree only when it cannot climb out of it', () => {
  for (const ok of ['.env', 'config/master.key', 'a b/[x] *.pem']) assert.equal(isSafeRelative(ok), true, ok);
  for (const bad of ['', '/etc/passwd', '../outside', 'a/../../b', 'dir/', 'a//b', 'nul\0byte']) {
    assert.equal(isSafeRelative(bad), false, JSON.stringify(bad));
  }
});

test('command lists are trimmed and blank lines dropped, but never silently shortened', () => {
  assert.deepEqual(parseCommandInput({ setup: ['  npm ci  ', '', '   '], teardown: ['docker compose down'] }),
    { setup: ['npm ci'], teardown: ['docker compose down'] });
  assert.deepEqual(parseCommandInput({ setup: ['true'] }), { setup: ['true'], teardown: [] });
  const many = parseCommandInput({ setup: Array.from({ length: 21 }, (_, i) => `echo ${i}`), teardown: [] });
  assert.ok('problem' in many && /at most 20 setup commands/.test(many.problem));
  const long = parseCommandInput({ setup: [], teardown: ['x'.repeat(2_001)] });
  assert.ok('problem' in long && /teardown command is too long/.test(long.problem));
});

test('anything but two lists of strings is refused by name', () => {
  for (const bad of [null, 'npm ci', ['npm ci'], { setup: 'npm ci' }, { setup: [1] }, { teardown: [null] }]) {
    assert.ok('problem' in parseCommandInput(bad), JSON.stringify(bad));
  }
});

test('a line moved between phases is new, and dropping or reordering adds nothing', () => {
  const stored = { setup: ['npm ci', 'npm run build'], teardown: ['docker compose down'] };
  assert.deepEqual(newCommands(stored, { setup: ['npm run build', 'npm ci'], teardown: [] }), { setup: [], teardown: [] });
  assert.deepEqual(newCommands(stored, { setup: ['npm ci', 'docker compose down'], teardown: ['docker compose down'] }),
    { setup: ['docker compose down'], teardown: [] });
  assert.deepEqual(newCommands(stored, { setup: [], teardown: ['npm ci'] }), { setup: [], teardown: ['npm ci'] });
});

test('an output tail keeps the last lines and says when it left some out', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n\n';
  const { tail, cut } = outputTail(text, 5);
  assert.equal(tail, 'line 26\nline 27\nline 28\nline 29\nline 30');
  assert.equal(cut, true);
  assert.deepEqual(outputTail('one\ntwo\n', 5), { tail: 'one\ntwo', cut: false });
  assert.deepEqual(outputTail('  \n\n'), { tail: '', cut: false });
});

test('a tail bounded by characters starts on a whole line and is marked cut', () => {
  const { tail, cut } = outputTail(`${'a'.repeat(50)}\n${'b'.repeat(50)}\nlast`, 12, 60);
  assert.equal(tail, `${'b'.repeat(50)}\nlast`);
  assert.equal(cut, true);
});

test('a failed run names the command that ended it, and its tail says which command printed what', () => {
  const summary = summarizeRun(run({
    status: 'failed', planned: 3,
    results: [
      { command: 'npm ci', exitCode: 0, output: 'added 812 packages', durationMs: 2_000 },
      { command: 'npm run migrate', exitCode: 3, output: 'no database at 127.0.0.1:42310\n', durationMs: 300 },
    ],
  }));
  assert.deepEqual(summary.stoppedAt, { command: 'npm run migrate', exitCode: 3 });
  assert.equal(summary.ran, 2);
  assert.equal(summary.tail, '$ npm ci\nadded 812 packages\n$ npm run migrate\nno database at 127.0.0.1:42310');
  assert.equal(runFacts(summary),
    'npm run migrate exited 3 · 2.3s · the worktree was kept and the launch was not held back');
});

test('a passed run states its facts, and a teardown never claims anything about a launch', () => {
  assert.equal(runFacts(summarizeRun(run())), '2 commands · 2.3s');
  const teardown = summarizeRun(run({ phase: 'teardown', status: 'failed', planned: 1,
    results: [{ command: 'docker compose down', exitCode: 1, output: 'Cannot connect to the Docker daemon', durationMs: 90 }] }));
  assert.equal(runFacts(teardown), 'docker compose down exited 1 · 2.3s');
});

test('a command that never exited is not reported as exiting with a code', () => {
  const summary = summarizeRun(run({ status: 'failed', results: [
    { command: 'sleep 900', exitCode: null, output: '[Wanigan stopped this command when the setup’s 10-minute limit ran out.]', durationMs: 600_000 },
  ] }));
  assert.match(runFacts(summary), /^sleep 900 did not finish/);
});

test('a run Wanigan itself cut short says so instead of blaming its last command', () => {
  const summary = summarizeRun(run({ status: 'failed', planned: 3, endedAt: null, note: 'Wanigan stopped while this was running',
    results: [{ command: 'npm ci', exitCode: 0, output: 'ok', durationMs: 10 }] }));
  assert.equal(summary.stoppedAt, null);
  assert.match(summary.tail, /Wanigan stopped while this was running$/);
  assert.equal(runFacts(summary), 'Wanigan stopped while this was running · the worktree was kept and the launch was not held back');
});

test('a still-running run is not given a duration or a verdict', () => {
  assert.equal(runFacts(summarizeRun(run({ status: 'running', endedAt: null, results: [] }))), '2 commands, still running');
});

test('an include file that could not be used is never reported as matching nothing', () => {
  assert.equal(describeInclude({ state: 'absent' }), null);
  const unreadable = describeInclude({ state: 'unreadable', detail: 'git could not list what it matches: fatal: bad pattern' });
  assert.ok(unreadable && /was not used/.test(unreadable) && !/0 files/.test(unreadable), unreadable ?? '');
  assert.equal(describeInclude(read({ patterns: 0 })), '.worktreeinclude has no patterns, so nothing was copied from it');
});

test('what was copied, left alone and refused is each counted in words', () => {
  assert.equal(describeInclude(read({ copied: 2, bytes: 4_200, present: 1, notIgnored: 2, symlinks: 1, outside: 1 })),
    '2 files (4.1 KB) copied from .worktreeinclude; 1 match already there; 2 matches left alone because git does not ignore them; '
    + '1 symlink not followed; 1 path refused for leading outside the worktree');
  assert.match(describeInclude(read({ copied: 1, bytes: 10, cloneable: false })) ?? '', /as full copies, because this disk cannot clone/);
  assert.equal(describeInclude(read({ copied: 0 })), '0 files copied from .worktreeinclude');
});

test('a copy that stopped at a limit says which limit and how much it did not look at', () => {
  assert.match(describeInclude(read({ copied: 5_000, bytes: 1, stopped: { by: 'files', limit: 5_000, unexamined: 1_204 } })) ?? '',
    /stopped at the 5,000-file limit; 1,204 more matches not examined$/);
  assert.match(describeInclude(read({ copied: 3, bytes: 1, stopped: { by: 'bytes', limit: 1024 ** 3, unexamined: 1 } })) ?? '',
    /stopped at the 1\.0 GB limit; 1 more match not examined$/);
  assert.match(describeInclude(read({ stopped: { by: 'git', limit: null, unexamined: 40 } })) ?? '',
    /stopped when git could not check the rest; 40 more matches not examined$/);
});

test('a branch row lists its ports, folders and copies, and says no setup ran only when none did', () => {
  const made = {
    depsMode: 'clone' as const,
    deps: [{ path: 'node_modules', requested: 'clone' as const, result: 'cloned' as const, detail: null, durationMs: 14_800 }],
    include: read({ copied: 2, bytes: 4_200 }),
    ports: { base: 42_310, count: 10 },
  };
  assert.deepEqual(bootstrapFacts({ ...made, setup: null }), [
    'ports 42310–42319', 'node_modules cloned in 15s', '2 files (4.1 KB) copied from .worktreeinclude', 'no setup ran',
  ]);
  const withSetup = bootstrapFacts({ ...made, setup: summarizeRun(run()) });
  assert.equal(withSetup.includes('no setup ran'), false, 'a setup that ran is never contradicted by "no setup ran"');
  assert.deepEqual(bootstrapFacts({ depsMode: 'link', deps: [], include: { state: 'absent' }, ports: null, setup: null }), ['no setup ran']);
});

test('the launch dialog names setup and the include file before the press, and says nothing when there is neither', () => {
  assert.equal(launchSetupNote({ setup: [], include: { state: 'absent' } }), null);
  assert.equal(launchSetupNote({ setup: [], include: { state: 'present', patterns: 0 } }), null);
  assert.equal(launchSetupNote({ setup: ['npm ci', 'npm run build'], include: { state: 'present', patterns: 3 } }),
    '2 setup commands run in it before the agent starts; if one fails, the worktree is kept and the session starts anyway. '
    + 'Gitignored files matching .worktreeinclude (3 patterns) are copied in.');
  assert.match(launchSetupNote({ setup: ['npm ci'], include: { state: 'unreadable', detail: 'it is not a regular file' } }) ?? '',
    /^1 setup command runs in it .* \.worktreeinclude cannot be read right now \(it is not a regular file\), so nothing would be copied from it\.$/);
});

test('each dependency folder says what it became, and a fallback says why', () => {
  assert.equal(describeDeps([]), null);
  assert.equal(describeDeps([
    { path: 'node_modules', requested: 'clone', result: 'cloned', detail: null, durationMs: 14_800 },
    { path: 'vendor', requested: 'link', result: 'linked', detail: null, durationMs: null },
    { path: '.venv', requested: 'skip', result: 'skipped', detail: null, durationMs: null },
  ]), 'node_modules cloned in 15s; vendor linked to the main checkout; .venv not made available');
  assert.equal(describeDeps([{ path: 'node_modules', requested: 'clone', result: 'linked',
    detail: 'it is not on the same APFS volume as the worktree, so cp -c would have made a full copy', durationMs: null }]),
  'node_modules linked instead of cloned: it is not on the same APFS volume as the worktree, so cp -c would have made a full copy');
  assert.match(describeDeps([{ path: 'target', requested: 'clone', result: 'failed', detail: 'the partial clone could not be removed', durationMs: null }]) ?? '',
    /^target missing: the partial clone could not be removed$/);
});
