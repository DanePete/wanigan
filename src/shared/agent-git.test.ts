/**
 * Joining an agent's git commands to the reflog entries and commits they produced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentGitCalls, gitVerbsIn, joinAgentGit, parseReflog, reflogVerb } from './agent-git.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('verbs: history-moving git commands through wrappers and global options; reads are not verbs', () => {
  assert.deepEqual(gitVerbsIn('git add -A && git commit -m "fix: retries"'), ['commit']);
  assert.deepEqual(gitVerbsIn('git -C ../repo switch -c feature'), ['checkout']);
  assert.deepEqual(gitVerbsIn('bash -c "git stash && git rebase main && git stash pop"'), ['stash', 'rebase', 'stash']);
  assert.deepEqual(gitVerbsIn('git push --force-with-lease origin feat'), ['push']);
  assert.deepEqual(gitVerbsIn('git cherry-pick abc123; git revert --no-edit HEAD'), ['cherry-pick', 'revert']);
  for (const cmd of ['git status', 'git log --oneline', 'git diff HEAD', 'git stash list', 'echo git commit', 'npm test']) assert.deepEqual(gitVerbsIn(cmd), [], cmd);
});

test('reflog: parse git’s own output and read the verb off each subject', () => {
  const out = [
    `${A}\trefs/heads/feat@{1789449076}\tcommit: two`,
    `${B}\tHEAD@{1789449077}\tcheckout: moving from feat to main`,
    `${C}\trefs/stash@{1789449078}\tWIP on main: 34b5e3f two`,
    'garbage line',
  ].join('\n');
  const entries = parseReflog(out);
  assert.deepEqual(entries.map((e) => [e.ref, e.at]), [['refs/heads/feat', 1789449076000], ['HEAD', 1789449077000], ['refs/stash', 1789449078000]]);
  const verbs = (subject: string, ref = 'HEAD') => reflogVerb({ ref, subject });
  assert.equal(verbs('commit (amend): x'), 'commit');
  assert.equal(verbs('commit (initial): one'), 'commit');
  assert.equal(verbs('merge feat: Fast-forward'), 'merge');
  assert.equal(verbs('rebase (finish): returning to refs/heads/feat'), 'rebase');
  assert.equal(verbs('reset: moving to HEAD~1'), 'reset');
  assert.equal(verbs('cherry-pick: two'), 'cherry-pick');
  assert.equal(verbs('revert: Revert "two"'), 'revert');
  assert.equal(verbs('update by push', 'refs/remotes/origin/feat'), 'push');
  assert.equal(verbs('WIP on main: x', 'refs/stash'), 'stash');
  assert.equal(verbs('branch: Created from HEAD'), null);
});

test('join: a reflog entry of the same kind inside the call’s window marks the SHA and the branch', () => {
  const calls = agentGitCalls({ id: 's1', title: 'checkout retries' }, [
    { id: 1, at: 1789449075400, event: 'PreToolUse', summary: 'git commit -am two', durationMs: null },
    { id: 2, at: 1789449076300, event: 'PostToolUse', summary: 'git commit -am two', durationMs: 900 },
    { id: 3, at: 1789449080000, event: 'PostToolUse', summary: 'git status', durationMs: 20 },
    { id: 4, at: 1789449090500, event: 'PostToolUse', summary: 'git switch main', durationMs: 100 },
  ]);
  assert.deepEqual(calls.map((c) => [c.eventId, c.verbs, c.startAt]), [[2, ['commit'], 1789449075400], [4, ['checkout'], 1789449090400]]);
  const reflog = parseReflog([
    `${A}\tHEAD@{1789449076}\tcommit: two`,
    `${A}\trefs/heads/feat@{1789449076}\tcommit: two`,
    `${B}\tHEAD@{1789449090}\tcheckout: moving from feat to main`,
    // The operator's own commit ten seconds later is in no window and stays unmarked.
    `${C}\tHEAD@{1789449100}\tcommit: operator fix`,
  ].join('\n'));
  const marks = joinAgentGit(calls, reflog, [{ hash: C, at: 1789449100000 }]);
  assert.equal(marks.commits[A]?.[0].join, 'reflog');
  assert.equal(marks.commits[A]?.[0].eventId, 2);
  assert.equal(marks.commits[A]?.length, 1, 'the HEAD and branch entries for one commit are one mark');
  assert.equal(marks.branches.feat?.[0].verb, 'commit');
  assert.equal(marks.branches.main?.[0].verb, 'checkout');
  assert.equal(marks.commits[B], undefined, 'a checkout marks the branch it moved to, not the commit it landed on');
  assert.equal(marks.commits[C], undefined);
});

test('join: a different kind of entry in the window is not a match, and no reflog falls back to a labelled time join', () => {
  const calls = agentGitCalls({ id: 's1', title: 't' }, [{ id: 9, at: 1789449076500, event: 'PostToolUse', summary: 'git commit -m x', durationMs: 400 }]);
  const onlyCheckout = parseReflog(`${B}\tHEAD@{1789449076}\tcheckout: moving from a to b`);
  const byTime = joinAgentGit(calls, onlyCheckout, [{ hash: A, at: 1789449076000 }, { hash: C, at: 1789449000000 }]);
  assert.deepEqual(Object.keys(byTime.commits), [A]);
  assert.equal(byTime.commits[A][0].join, 'time');
  assert.equal(byTime.commits[B], undefined, 'a checkout entry is not credited to a commit command');
  assert.deepEqual(byTime.branches, {});
});

test('join: a push marks the remote-tracking branch, not a commit row', () => {
  const calls = agentGitCalls({ id: 's2', title: 'push it' }, [{ id: 5, at: 1789449200800, event: 'PostToolUse', summary: 'git push origin feat', durationMs: 700 }]);
  const marks = joinAgentGit(calls, parseReflog(`${A}\trefs/remotes/origin/feat@{1789449200}\tupdate by push`), []);
  assert.equal(marks.branches['origin/feat']?.[0].verb, 'push');
  assert.deepEqual(marks.commits, {});
});
