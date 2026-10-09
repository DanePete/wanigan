import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  branchNameProblem, cardKeyOfBranch, cardKeyOfMerge, commitMessage, explainFailure, layoutGraph, parseRefs, parseStatus, refProblem, reviewOf, splitMessage,
  summarizeChecks,
} from './git.ts';

const z = (...fields: string[]): string => `${fields.join('\0')}\0`;

test('status: the branch, its upstream and how far apart they are', () => {
  const s = parseStatus(z('# branch.oid 1234567890abcdef', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3', '# stash 4'));
  assert.deepEqual([s.head, s.branch, s.upstream, s.ahead, s.behind, s.stashes, s.detached, s.unborn, s.upstreamGone],
    ['1234567890abcdef', 'main', 'origin/main', 2, 3, 4, false, false, false]);
});

test('status: detached, unborn, and an upstream whose branch is gone', () => {
  assert.deepEqual(((s) => [s.detached, s.branch])(parseStatus(z('# branch.oid abc', '# branch.head (detached)'))), [true, null]);
  assert.deepEqual(((s) => [s.unborn, s.head, s.branch])(parseStatus(z('# branch.oid (initial)', '# branch.head main'))), [true, null, 'main']);
  // git prints no ahead/behind line when the upstream's branch no longer exists.
  assert.equal(parseStatus(z('# branch.oid abc', '# branch.head topic', '# branch.upstream origin/topic')).upstreamGone, true);
});

test('status: one file can be staged and changed; untracked and conflicted are their own lists', () => {
  const s = parseStatus(z(
    '# branch.oid abc', '# branch.head main',
    '1 MM N... 100644 100644 100644 aaa bbb src/app file.ts',
    '1 A. N... 000000 100644 100644 000 ccc new.ts',
    '1 .D N... 100644 100644 000000 ddd ddd gone.ts',
    '2 R. N... 100644 100644 100644 eee eee R100 lib/new name.ts', 'lib/old name.ts',
    'u UU N... 100644 100644 100644 100644 f1 f2 f3 both.ts',
    'u DU N... 100644 000000 100644 100644 g1 g2 g3 ours-deleted.ts',
    '? notes/todo list.md',
  ));
  assert.deepEqual(s.staged, [
    { path: 'src/app file.ts', status: 'M' }, { path: 'new.ts', status: 'A' }, { path: 'lib/new name.ts', status: 'R', from: 'lib/old name.ts' },
  ]);
  assert.deepEqual(s.changed, [{ path: 'src/app file.ts', status: 'M' }, { path: 'gone.ts', status: 'D' }]);
  assert.deepEqual(s.conflicted, [
    { path: 'both.ts', code: 'UU', conflict: 'both modified' }, { path: 'ours-deleted.ts', code: 'DU', conflict: 'deleted by us' },
  ]);
  assert.deepEqual(s.untracked, ['notes/todo list.md']);
});

test('refs from the window: a leading dash, whitespace and control characters are refused', () => {
  assert.equal(refProblem('main'), null);
  assert.equal(refProblem('feature/login'), null);
  assert.match(refProblem('-f') ?? '', /begins with a dash/);
  assert.match(refProblem('a b') ?? '', /space or a control/);
  assert.match(refProblem('a\u0007') ?? '', /control/);
  assert.match(refProblem('') ?? '', /needs a branch/);
  assert.match(refProblem(42) ?? '', /needs a branch/);
  assert.match(refProblem('x'.repeat(300)) ?? '', /300 characters/);
});

test('new branch names follow git’s rules, said in words', () => {
  for (const ok of ['feature/login', 'fix-12', 'wanigan/ns-3', 'release/2.0']) assert.equal(branchNameProblem(ok), null, ok);
  for (const bad of ['a..b', 'a~1', 'x^', 'a:b', 'what?', 'st*r', 'br[', 'back\\slash', 'end/', '/start', 'a//b', 'dot.', 'x.lock', '.hidden', 'a/.b', 'HEAD', '@', 'a@{1}']) {
    assert.notEqual(branchNameProblem(bad), null, bad);
  }
});

test('a card’s branch and a card’s merge are read back to its key', () => {
  assert.equal(cardKeyOfBranch('wanigan/ns-3'), 'NS-3');
  assert.equal(cardKeyOfBranch('origin/wanigan/oa-12'), 'OA-12');
  assert.equal(cardKeyOfBranch('refs/heads/wanigan/ns-3'), 'NS-3');
  assert.equal(cardKeyOfBranch('main'), null);
  assert.equal(cardKeyOfBranch('wanigan/notes'), null);
  assert.equal(cardKeyOfMerge('Merge wanigan/ns-3'), 'NS-3');
  assert.equal(cardKeyOfMerge("Merge branch 'wanigan/ns-14' into main"), 'NS-14');
  assert.equal(cardKeyOfMerge("Merge remote-tracking branch 'origin/wanigan/ns-2'"), 'NS-2');
  assert.equal(cardKeyOfMerge('Merge pull request #4 from someone/feature'), null);
  assert.equal(cardKeyOfMerge('Fix wanigan/ns-3 typo'), null);
});

test('decorations are read into the branch HEAD is on, other branches, remotes and tags', () => {
  assert.deepEqual(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0'), [
    { kind: 'branch', name: 'main', current: true }, { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'v1.0' },
  ]);
  assert.deepEqual(parseRefs('HEAD, refs/heads/wanigan/ns-3'), [{ kind: 'head', name: 'HEAD' }, { kind: 'branch', name: 'wanigan/ns-3' }]);
  assert.deepEqual(parseRefs(''), []);
});

test('commit messages: a summary, a blank line, a description; git’s comment lines are not part of one', () => {
  assert.equal(commitMessage('  Fix the pay button  ', ''), 'Fix the pay button');
  assert.equal(commitMessage('Fix it', 'Because.\n\n'), 'Fix it\n\nBecause.');
  assert.deepEqual(splitMessage('Merge branch x\n\n# Conflicts:\n#\tsrc/a.ts\nKept line\n'), { subject: 'Merge branch x', body: 'Kept line' });
  assert.deepEqual(splitMessage('One line'), { subject: 'One line', body: '' });
});

/** Rows as "lane:x1y1>x2y2,…" so a test reads like the picture. */
const drawn = (commits: { hash: string; parents: string[] }[]): string[] =>
  layoutGraph(commits).map((r) => `${r.lane}|${r.lines.map((l) => `${l.x1}${l.y1}>${l.x2}${l.y2}`).join(',')}`);

test('graph: a straight line of history is one lane', () => {
  assert.deepEqual(drawn([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }]), [
    '0|01>02', '0|00>01,01>02', '0|00>01',
  ]);
});

test('graph: a merge opens a lane for the branch it brought in, and the fork closes it', () => {
  // m merges f into main; f and b both come from a.
  const rows = drawn([
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(rows, [
    '0|01>02,01>12', // the merge: first parent straight down, the branch off to lane 1
    '1|00>01,01>02,10>11,11>12', // f on lane 1; main passes on lane 0
    '0|00>01,10>11,11>12,01>02', // b on lane 0; f’s line to a passes on lane 1
    '0|00>01,10>01', // a: both lines end at its dot
  ]);
  assert.deepEqual(layoutGraph([{ hash: 'm', parents: ['b', 'f'] }, { hash: 'f', parents: ['a'] }]).map((r) => r.width), [2, 2]);
});

test('graph: a lane freed by a branch’s first commit is reused, and colours follow their line', () => {
  const rows = layoutGraph([
    { hash: 'x', parents: ['w'] }, // branch tip, lane 0
    { hash: 'y', parents: ['v'] }, // another tip, lane 1
    { hash: 'w', parents: [] }, // root of the first: lane 0 frees
    { hash: 'v', parents: ['u'] },
    { hash: 'z', parents: ['u'] }, // a new tip takes the freed lane 0
    { hash: 'u', parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 1, 0, 0]);
  assert.equal(rows[3]?.color, rows[1]?.color, 'v keeps y’s colour: one line');
  assert.notEqual(rows[4]?.color, rows[0]?.color, 'a new line gets a new colour');
});

test('graph: parents outside the loaded commits draw no line to nowhere', () => {
  assert.deepEqual(drawn([{ hash: 'c', parents: ['b', 'off-page'] }, { hash: 'b', parents: ['also-off'] }]), ['0|01>02', '0|00>01']);
});

test('a pull request’s checks are counted by outcome, and its review said in words', () => {
  assert.equal(summarizeChecks([]), null);
  assert.equal(summarizeChecks(undefined), null);
  assert.deepEqual(summarizeChecks([
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'PENDING' },
    { __typename: 'StatusContext', state: 'ERROR' },
  ]), { passed: 2, failed: 2, pending: 2, other: 1 });
  assert.deepEqual(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', '', null].map(reviewOf), ['approved', 'changes', 'required', null, null]);
});

test('failures are named: conflict, hook, signing, identity, timeout, no git, and the rest', () => {
  const kind = (stderr: string, extra: Partial<Parameters<typeof explainFailure>[0]> = {}) => explainFailure({ stderr, what: 'the merge', ...extra }).kind;
  assert.equal(kind('', { stdout: 'Auto-merging a.ts\nCONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed; fix conflicts and then commit the result.' }), 'conflict');
  assert.equal(kind('error: gpg failed to sign the data\nfatal: failed to write commit object'), 'signing');
  assert.equal(kind("Committer identity unknown\n\n*** Please tell me who you are."), 'identity');
  assert.equal(kind('lint failed: 3 problems', { hooks: true }), 'hook');
  assert.equal(kind('husky - pre-commit hook exited with code 1'), 'hook');
  assert.equal(kind('', { killed: true }), 'timeout');
  assert.equal(kind('', { missing: true }), 'no-git');
  assert.equal(kind(' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs'), 'non-fast-forward');
  assert.equal(kind('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'), 'auth');
  assert.equal(kind('error: Your local changes to the following files would be overwritten by merge:\n\ta.ts'), 'overwrite');
  assert.equal(kind("fatal: Unable to create '/r/.git/index.lock': File exists."), 'locked');
  assert.equal(kind('fatal: refusing to merge unrelated histories'), 'other');
  const said = explainFailure({ stderr: 'fatal: refusing to merge unrelated histories', what: 'the merge' });
  assert.equal(said.message, 'Git refused the merge. Git said: refusing to merge unrelated histories');
  assert.match(explainFailure({ stderr: '', stdout: 'CONFLICT (content): x', what: 'the merge' }).message, /^The merge conflicted/);
});
