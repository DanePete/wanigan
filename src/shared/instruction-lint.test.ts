/**
 * The stale-reference lint's extractor. Its subject is silence: every shape it
 * promises to leave alone is asserted to produce nothing, because a lint that
 * flags `and/or` or a URL is a lint people stop reading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { didYouMean, editDistance, extractReferences, looksLikeRepoPath, programOf } from './instruction-lint.ts';

test('backticked repository paths are extracted with their line', () => {
  const refs = extractReferences('Read `src/main/db.ts` first.\nThen `scripts/check-renderer-style.cjs`.');
  assert.deepEqual(refs, [
    { kind: 'path', text: 'src/main/db.ts', line: 1 },
    { kind: 'path', text: 'scripts/check-renderer-style.cjs', line: 2 },
  ]);
});

test('URLs, globs, home paths, variables, placeholders and prose slashes stay quiet', () => {
  for (const span of ['https://example.com/a/b', 'src/**/*.ts', '~/.claude/skills', '$HOME/x', '${ROOT}/y', '.claude/skills/<name>/SKILL.md',
    'and/or', 'read/write', 'owner/repo', '/etc/hosts', 'npm test', '--flag/x', 'MEMORY.md', '22.23.2', 'a...b']) {
    assert.equal(looksLikeRepoPath(span), false, span);
  }
  // Two bare words are prose until a trailing slash or an extension says otherwise.
  assert.equal(looksLikeRepoPath('docs/visuals'), false);
  for (const span of ['src/main/db.ts', '.claude/rules/', 'docs/visuals/', 'src/shared/x']) {
    assert.equal(looksLikeRepoPath(span), true, span);
  }
});

test('shell fences yield the program of every command, skipping prompts, env and builtins', () => {
  const md = [
    '```bash',
    '$ nvm use && npm test',
    'FOO=1 BAR=2 yarn build',
    'cd src; ls -la',
    'export X=1',
    './scripts/smoke.sh',
    'npx knip \\',
    '  --strict',
    '# a comment',
    '```',
    '```ts',
    'const x = run();',
    '```',
  ].join('\n');
  assert.deepEqual(extractReferences(md).map((r) => r.kind === 'command' ? r.program : r.text), ['nvm', 'npm', 'yarn', 'ls', 'npx']);
});

test('HTML comments are not read', () => {
  assert.deepEqual(extractReferences('<!--\n`src/gone.ts`\n-->\n`src/here.ts`'), [{ kind: 'path', text: 'src/here.ts', line: 4 }]);
});

test('programOf ignores what cannot be checked on PATH', () => {
  assert.equal(programOf('sudo env A=1 brew install x'), 'brew');
  assert.equal(programOf('$(which node) x'), null);
  assert.equal(programOf('~/bin/tool'), null);
  assert.equal(programOf('bin/tool'), null);
});

test('did-you-mean prefers a moved file with the same name, then the nearest path', () => {
  const tracked = ['src/main/database.ts', 'src/main/db.ts', 'lib/db.ts', 'src/renderer/src/views/Insights.tsx'];
  assert.equal(didYouMean('src/db.ts', tracked), 'lib/db.ts');
  assert.equal(didYouMean('src/renderer/src/views/Insight.tsx', tracked), 'src/renderer/src/views/Insights.tsx');
  assert.equal(didYouMean('totally/unrelated/thing.md', tracked), null);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});
