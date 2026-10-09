import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editedPaths, patchFiles } from './edits.ts';

/** A patch as Codex writes one (codex-rs/apply-patch grammar). */
const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const a = 1;',
  '*** Update File: web/themes/custom/acme/templates/paragraph--hero.html.twig',
  '@@',
  '-<h2>{{ title }}</h2>',
  '+<h2 class="hero__title">{{ title }}</h2>',
  '*** Update File: old/name.css',
  '*** Move to: new/name.css',
  '@@',
  '-a{}',
  '+b{}',
  '*** Delete File: /abs/gone.php',
  '*** End Patch',
].join('\n');

test('a Codex patch names every file it adds, updates, moves or deletes', () => {
  assert.deepEqual(patchFiles(PATCH), [
    'src/new.ts', 'web/themes/custom/acme/templates/paragraph--hero.html.twig', 'old/name.css', 'new/name.css', '/abs/gone.php',
  ]);
  assert.deepEqual(patchFiles(PATCH.replace(/\n/g, '\r\n')), patchFiles(PATCH), 'Windows line endings read the same');
  assert.deepEqual(patchFiles('*** Begin Patch\n+*** Update File: inside/a/line.ts\n*** End Patch'), [], 'a hunk line that only looks like a header is not one');
});

test('apply_patch reads as the files it changed, under the session’s folder', () => {
  assert.deepEqual(editedPaths('PostToolUse', 'apply_patch', { command: PATCH }, '/work/site'), [
    '/work/site/src/new.ts', '/work/site/web/themes/custom/acme/templates/paragraph--hero.html.twig',
    '/work/site/old/name.css', '/work/site/new/name.css', '/abs/gone.php',
  ]);
  assert.deepEqual(editedPaths('PreToolUse', 'apply_patch', { command: PATCH }, '/work/site'), [], 'before it ran, nothing has changed');
  assert.deepEqual(editedPaths('PostToolUse', 'apply_patch', { command: 42 }, '/work/site'), []);
  assert.deepEqual(editedPaths('PostToolUse', 'apply_patch', { command: PATCH }, null).filter((p) => !p.startsWith('/abs')), [],
    'relative paths with no folder to resolve against are left out');
});

test('Claude Code’s edit tools name their one file; anything else names none', () => {
  assert.deepEqual(editedPaths('PostToolUse', 'Edit', { file_path: '/work/site/a.ts' }, '/elsewhere'), ['/work/site/a.ts']);
  assert.deepEqual(editedPaths('PostToolUse', 'Write', { file_path: 'b.ts' }, '/work/site/'), ['/work/site/b.ts']);
  assert.deepEqual(editedPaths('PostToolUse', 'NotebookEdit', { notebook_path: '/n.ipynb' }, null), ['/n.ipynb']);
  assert.deepEqual(editedPaths('PostToolUse', 'Edit', { file_path: '/work/site/./x/../a.ts' }, null), ['/work/site/a.ts']);
  assert.deepEqual(editedPaths('PostToolUse', 'Bash', { command: PATCH }, '/work/site'), [], 'a shell command is not read as a patch');
  assert.deepEqual(editedPaths('PostToolUse', 'Read', { file_path: '/a' }, null), []);
  assert.deepEqual(editedPaths('PostToolUse', 'Edit', { file_path: '/a\nb' }, null), [], 'a path with a newline in it is not a path');
});
