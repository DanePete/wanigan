/**
 * Edited, read and referenced: the Bash reader, search hits and the roll-up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashReads, directoryOf, rollupSessionFiles, toolHits } from './session-files.ts';

const CWD = '/repo';

test('bash reads: cat, head and sed -n on plain paths, resolved against the working directory', () => {
  assert.deepEqual(bashReads('cat src/a.ts README.md', CWD), ['/repo/src/a.ts', '/repo/README.md']);
  assert.deepEqual(bashReads('head -n 40 src/big.log', CWD), ['/repo/src/big.log']);
  assert.deepEqual(bashReads('head -20 /etc/hosts', CWD), ['/etc/hosts']);
  assert.deepEqual(bashReads("sed -n '120,180p' src/main/hooks.ts", CWD), ['/repo/src/main/hooks.ts']);
  assert.deepEqual(bashReads("sed -n -e '5p' a.txt", CWD), ['/repo/a.txt']);
  assert.deepEqual(bashReads('cat package.json | jq .scripts', CWD), ['/repo/package.json']);
  assert.deepEqual(bashReads('bash -c "cat notes.md"', CWD), ['/repo/notes.md']);
});

test('bash reads: anything uncertain is skipped rather than guessed', () => {
  for (const cmd of [
    'cat src/*.ts', 'cat $FILE', 'cat ~/notes.md', 'cat -n src/a.ts', "sed 's/a/b/' src/a.ts", "sed -i -n '1p' src/a.ts",
    "sed -n 's/x/y/p' src/a.ts", 'head --bytes src/a.ts', 'tail -n 5 src/a.ts', 'grep foo src/a.ts', 'cat > out.txt', 'cat -',
  ]) {
    assert.deepEqual(bashReads(cmd, CWD), [], cmd);
  }
  // After a cd, a relative path is no longer certain; an absolute one still is.
  assert.deepEqual(bashReads('cd packages/web && cat package.json /repo/README.md', CWD), ['/repo/README.md']);
  assert.deepEqual(bashReads('cat a.ts', null), []);
});

test('search hits: Glob and Grep filenames, relative to where the search ran; content mode names nothing', () => {
  assert.deepEqual(toolHits('Glob', { pattern: '**/*.ts' }, { filenames: ['/repo/src/a.ts', '/repo/src/b.ts'], numFiles: 2, truncated: false }, CWD), ['/repo/src/a.ts', '/repo/src/b.ts']);
  assert.deepEqual(toolHits('Grep', { pattern: 'TODO', path: 'src' }, { mode: 'files_with_matches', filenames: ['main/x.ts'], numFiles: 1 }, CWD), ['/repo/src/main/x.ts']);
  assert.deepEqual(toolHits('Grep', { pattern: 'TODO' }, { mode: 'content', filenames: [], content: 'src/a.ts:3:// TODO' }, CWD), []);
  assert.deepEqual(toolHits('Read', {}, { filenames: ['/x'] }, CWD), []);
  assert.deepEqual(toolHits('Glob', {}, 'not an object', CWD), []);
});

test('roll-up: each file in its strongest group with every count, first and last time', () => {
  const files = rollupSessionFiles([
    { at: 10, event: 'PostToolUse', toolName: 'Read', ok: true, paths: ['/repo/src/a.ts'] },
    { at: 20, event: 'PostToolUse', toolName: 'Edit', ok: true, paths: ['/repo/src/a.ts'] },
    { at: 25, event: 'PostToolUseFailure', toolName: 'Edit', ok: false, paths: ['/repo/src/c.ts'] },
    { at: 30, event: 'PostToolUse', toolName: 'Read', ok: true, paths: ['/repo/src/b.ts'] },
    { at: 35, event: 'PreToolUse', toolName: 'Write', ok: null, paths: ['/repo/src/d.ts'] },
  ], [
    { at: 5, kind: 'prompt-path', path: '/repo/src/a.ts' },
    { at: 40, kind: 'grep-hit', path: '/repo/src/e.ts' },
    { at: 41, kind: 'bash-read', path: '/repo/src/b.ts' },
    { at: 42, kind: 'glob-hit', path: '/tmp/outside.txt' },
  ], '/repo');
  assert.deepEqual(files.edited.map((f) => [f.rel, f.edits, f.reads, f.promptMentions, f.firstAt, f.lastAt]), [['src/a.ts', 1, 1, 1, 5, 20]]);
  assert.deepEqual(files.read.map((f) => [f.rel, f.reads, f.bashReads]), [['src/b.ts', 1, 1]]);
  assert.deepEqual(files.referenced.map((f) => [f.path, f.rel, f.searchHits]), [['/tmp/outside.txt', null, 1], ['/repo/src/e.ts', 'src/e.ts', 1]]);
  // A failed edit and a call that never finished touched nothing.
  assert.ok(![...files.edited, ...files.read, ...files.referenced].some((f) => f.path.endsWith('c.ts') || f.path.endsWith('d.ts')));
  assert.equal(directoryOf('src/a.ts'), 'src');
  assert.equal(directoryOf('README.md'), '');
});
