import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWords, minimalChange } from './text.ts';

test('a reload replaces only what changed, so the cursor elsewhere stays put', () => {
  assert.deepEqual(minimalChange('a\nb\nc\n', 'a\nB\nc\n'), { from: 2, to: 3, insert: 'B' });
  assert.deepEqual(minimalChange('same', 'same'), { from: 4, to: 4, insert: '' });
  assert.deepEqual(minimalChange('', 'new'), { from: 0, to: 0, insert: 'new' });
  assert.deepEqual(minimalChange('aaa', 'aa'), { from: 2, to: 3, insert: '' }, 'a repeated letter is not counted twice');
  const before = '<h2>{{ title }}</h2>\n<p>Free shipping</p>\n';
  const after = '<h2 class="wide">{{ title }}</h2>\n<p>Free shipping</p>\n';
  const c = minimalChange(before, after);
  assert.equal(before.slice(0, c.from) + c.insert + before.slice(c.to), after);
});

test('words picked on the page are found in the template, exactly or across its line breaks', () => {
  const twig = '<section>\n  <h2>Don’t miss\n    our open house</h2>\n</section>\n';
  assert.equal(findWords(twig, '<h2>'), twig.indexOf('<h2>'));
  assert.equal(findWords(twig, 'Don’t miss our open house'), twig.indexOf('Don’t'));
  assert.equal(findWords(twig, 'DON’T MISS'), twig.indexOf('Don’t'), 'the page may show it in capitals');
  assert.equal(findWords(twig, 'Register (today)'), null, 'a word the template does not write, and nothing breaks on a bracket');
});
