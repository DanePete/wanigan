/**
 * Terminal links, the parsing half. The lines below are the shapes agents
 * actually print: an edit summary with a line number, a path in parentheses at
 * the end of a sentence, a URL with a bracket of its own, a colour code a pipe
 * left behind. A wrong offset underlines the wrong cells; a wrong trim opens a
 * file that does not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinks, linkAt, splitLineColumn, stripAnsi } from './terminal-links.ts';

const paths = (line: string) => findLinks(line).filter((l) => l.kind === 'path').map((l) => l.kind === 'path' ? [l.path, l.line, l.column] : null);
const urls = (line: string) => findLinks(line).filter((l) => l.kind === 'url').map((l) => l.text);

test('an absolute path, a relative path and a bare file name are found, with line and column', () => {
  assert.deepEqual(paths('Edited /Users/me/repo/src/Checkout.php:42:7 and src/cart.ts:12'), [
    ['/Users/me/repo/src/Checkout.php', 42, 7],
    ['src/cart.ts', 12, null],
  ]);
  assert.deepEqual(paths('Updated README.md.'), [['README.md', null, null]]);
  assert.deepEqual(paths('see ./scripts/probe.mjs and ../other/file.txt'), [['./scripts/probe.mjs', null, null], ['../other/file.txt', null, null]]);
  assert.deepEqual(paths('config at ~/.claude/settings.json'), [['~/.claude/settings.json', null, null]]);
});

test('offsets point at the path itself, not the punctuation around it', () => {
  const line = 'The bug is in (src/lib/money.ts:88), I think.';
  const [link] = findLinks(line);
  assert.equal(link.kind, 'path');
  assert.equal(line.slice(link.start, link.end), 'src/lib/money.ts:88');
  assert.deepEqual(linkAt(findLinks(line), line.indexOf("money")), link);
  assert.equal(linkAt(findLinks(line), 0), null);
});

test('trailing sentence punctuation, quotes and backticks are not part of a path', () => {
  assert.deepEqual(paths('Wrote `src/a.ts`, "src/b.ts" and \'src/c.ts\'; then src/d.ts!'), [
    ['src/a.ts', null, null], ['src/b.ts', null, null], ['src/c.ts', null, null], ['src/d.ts', null, null],
  ]);
  assert.deepEqual(paths('Check lib/x.py:10:'), [['lib/x.py', 10, null]]);
});

test('ordinary words, versions, numbers and abbreviations are not paths', () => {
  assert.deepEqual(paths('Run npm test with node v22.23.2 in 3.5 seconds, e.g. now / then'), []);
  assert.deepEqual(paths('ratio 1/2 and a // comment'), []);
});

test('a URL keeps a bracket it opened and drops one the sentence opened', () => {
  assert.deepEqual(urls('See https://en.wikipedia.org/wiki/Foo_(bar).'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(urls('(docs: https://code.claude.com/docs/en/hooks)'), ['https://code.claude.com/docs/en/hooks']);
  assert.deepEqual(urls('<https://example.com/a?b=1&c=2>, and "http://localhost:3000/x"'), ['https://example.com/a?b=1&c=2', 'http://localhost:3000/x']);
});

test('a path is never found inside a URL', () => {
  const links = findLinks('open https://github.com/org/repo/blob/main/src/a.ts:10 now');
  assert.deepEqual(links.map((l) => l.kind), ['url']);
});

test('ANSI escapes and the remnants a pipe leaves are not part of a link', () => {
  const coloured = '\x1b[1msrc/a.ts\x1b[0m changed';
  assert.deepEqual(paths(coloured), [['src/a.ts', null, null]]);
  const remnant = 'Edited [1msrc/b.ts:3[0m and [36mhttps://example.com/x[0m';
  assert.deepEqual(paths(remnant), [['src/b.ts', 3, null]]);
  assert.deepEqual(urls(remnant), ['https://example.com/x']);
  const [first] = findLinks(remnant);
  assert.equal(remnant.slice(first.start, first.end), 'src/b.ts:3');
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('a line and column split refuses a zero line and keeps a colon that is not a number', () => {
  assert.deepEqual(splitLineColumn('a.ts:0'), { path: 'a.ts', line: null, column: null });
  assert.deepEqual(splitLineColumn('a.ts:5:0'), { path: 'a.ts', line: 5, column: null });
  assert.deepEqual(splitLineColumn('C:thing'), { path: 'C:thing', line: null, column: null });
});
