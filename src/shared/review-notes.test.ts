import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewMessage } from './review-notes.ts';

test('notes become one message, in file and line order, each with its place and its code', () => {
  const message = reviewMessage([
    { file: 'src/b.ts', line: 3, side: 'new', quote: '  const total = sum(items);  ', text: 'Round to cents here.' },
    { file: 'src/a.ts', line: 40, side: 'old', quote: 'legacyCheckout();', text: 'Was this still used?' },
    { file: 'src/a.ts', line: 12, side: 'new', quote: '', text: '  Name this better.  ' },
  ], 'NS-6’s branch');
  assert.equal(message, [
    'Review notes on NS-6’s branch, from the owner (3 notes). Please address each, then say what you changed.',
    '',
    'src/a.ts:12',
    'Name this better.',
    '',
    'src/a.ts:40 (a removed line)',
    '> legacyCheckout();',
    'Was this still used?',
    '',
    'src/b.ts:3',
    '> const total = sum(items);',
    'Round to cents here.',
  ].join('\n'));
  assert.match(reviewMessage([{ file: 'x', line: 1, side: 'new', quote: 'y', text: 'z' }], 'the project folder'), /\(one note\)/);
});
