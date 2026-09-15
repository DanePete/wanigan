/**
 * Recognising history rewrites, and telling a rewrite from a fast-forward.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMoves, parseRefSnapshot, refMoves, rewriteCommandsIn } from './git-rewrite.ts';

const kinds = (cmd: string) => rewriteCommandsIn(cmd).map((r) => r.kind);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('every rewriting command is recognised, through wrappers and global options', () => {
  assert.deepEqual(kinds('git push --force origin feature'), ['force-push']);
  assert.deepEqual(kinds('git push -uf origin feature'), ['force-push']);
  assert.deepEqual(kinds('git push origin +feature:feature'), ['force-push']);
  assert.deepEqual(kinds('git push --force-with-lease'), ['force-push']);
  assert.deepEqual(kinds('git -C ../repo push --delete origin old'), ['force-push']);
  assert.deepEqual(kinds('git reset --hard HEAD~3'), ['reset-hard']);
  assert.deepEqual(kinds('git rebase -i main'), ['rebase']);
  assert.deepEqual(kinds('git -c core.editor=true commit --amend --no-edit'), ['amend']);
  assert.deepEqual(kinds('git branch -D spike'), ['branch-delete']);
  assert.deepEqual(kinds('git branch --delete --force spike'), ['branch-delete']);
  assert.deepEqual(kinds('git tag -d v1.0'), ['tag-delete']);
  assert.deepEqual(kinds('git filter-branch --tree-filter "rm secrets" HEAD'), ['filter-branch']);
  assert.deepEqual(kinds('git filter-repo --path secrets --invert-paths'), ['filter-repo']);
  assert.deepEqual(kinds('git update-ref -d refs/heads/x'), ['update-ref-delete']);
  assert.deepEqual(kinds('bash -c "git reset --hard && git push -f"'), ['reset-hard', 'force-push']);
});

test('ordinary git is not a rewrite', () => {
  for (const cmd of ['git push origin main', 'git reset HEAD file', 'git reset --soft HEAD~1', 'git commit -m "amend the docs"', 'git branch -d merged', 'git tag v2', 'git log --grep="rebase"']) {
    assert.deepEqual(kinds(cmd), [], cmd);
  }
});

test('snapshots ignore Wanigan’s own refs and keep a detached HEAD', () => {
  const snap = parseRefSnapshot(`${A} refs/heads/main\n${B} refs/tags/v1\n${C} refs/wanigan/checkpoints/s1\n`, `${C}\n`);
  assert.deepEqual(snap.refs, { 'refs/heads/main': A, 'refs/tags/v1': B, HEAD: C });
  assert.deepEqual(parseRefSnapshot('', null).refs, {});
});

test('a deletion and a non-fast-forward move are rewrites; a fast-forward is not; an unanswered one is said to be unanswered', () => {
  const prev = parseRefSnapshot(`${A} refs/heads/main\n${A} refs/heads/feature\n${B} refs/tags/v1\n${A} refs/heads/wip\n`, null);
  const next = parseRefSnapshot(`${B} refs/heads/main\n${C} refs/heads/feature\n${C} refs/heads/wip\n${C} refs/heads/new\n`, null);
  const moves = refMoves(prev, next);
  assert.deepEqual(moves.map((m) => m.ref).sort(), ['refs/heads/feature', 'refs/heads/main', 'refs/heads/wip', 'refs/tags/v1']);
  const rewrites = classifyMoves(moves, (_from, to) => (to === B ? true : null));
  assert.ok(!rewrites.some((r) => r.ref === 'refs/heads/main'), 'main fast-forwarded');
  assert.equal(rewrites.find((r) => r.ref === 'refs/tags/v1')?.kind, 'deleted');
  assert.equal(rewrites.find((r) => r.ref === 'refs/heads/feature')?.kind, 'cannot confirm');
  const strict = classifyMoves(moves, (_from, to) => to === B);
  assert.equal(strict.find((r) => r.ref === 'refs/heads/feature')?.kind, 'non-fast-forward');
});
