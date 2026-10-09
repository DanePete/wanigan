import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PER_GROUP, arrange, paletteScore, step, type Arrangeable, type PaletteGroup } from './palette.ts';

const item = (group: PaletteGroup, text: string, more: Partial<Arrangeable> = {}): Arrangeable & { text: string } => ({ group, text, ...more });

test('a query matches letters in order; word starts and the whole phrase score higher', () => {
  assert.equal(paletteScore('', 'anything'), 0);
  assert.equal(paletteScore('xyz', 'Board'), null);
  assert.ok(paletteScore('brd', 'Board') !== null);
  assert.ok(paletteScore('nb', 'Needs you: board')! > paletteScore('nb', 'Unbounded')!, 'word starts win');
  assert.ok(paletteScore('order', 'Order history page')! > paletteScore('order', 'Open the raw doc errors')!, 'the phrase as typed wins');
});

test('results come in fixed groups, empty groups left out, best first within each', () => {
  const items = [
    item('Commands', 'New card'),
    item('Go to', 'Needs you'),
    item('Cards', 'NS-3 Order history page'),
    item('Go to', 'Running'),
    item('Cards', 'NS-9 Saved carts that survive a sign-out'),
  ];
  const typed = arrange(items, 'car');
  assert.deepEqual(typed.map((g) => g.group), ['Cards', 'Commands']);
  assert.deepEqual(arrange(items, 'or').find((g) => g.group === 'Cards')?.items.map((i) => i.text)[0], 'NS-3 Order history page');
  const untyped = arrange(items, '');
  assert.deepEqual(untyped.map((g) => g.group), ['Go to', 'Cards', 'Commands']);
  assert.deepEqual(untyped[0]?.items.map((i) => i.text), ['Needs you', 'Running'], 'declared order before anything is typed');
});

test('what is only for searching waits for a query, and what the core found is kept as found', () => {
  const items = [
    item('Projects', 'Northstar'),
    item('Projects', 'Northstar: Decisions', { whenTyped: true }),
    item('Said in sessions', 'unrelated words', { found: true }),
  ];
  assert.deepEqual(arrange(items, '').flatMap((g) => g.items.map((i) => i.text)), ['Northstar']);
  const typed = arrange(items, 'decis');
  assert.deepEqual(typed.map((g) => [g.group, g.items.map((i) => i.text)]), [
    ['Projects', ['Northstar: Decisions']],
    ['Said in sessions', ['unrelated words']],
  ]);
});

test('each group is capped: a few before typing, more once typed', () => {
  const cards = Array.from({ length: 20 }, (_, i) => item('Cards', `NS-${i} card`));
  assert.equal(arrange(cards, '')[0]?.items.length, 5);
  assert.equal(arrange(cards, 'card')[0]?.items.length, PER_GROUP);
  const goto = Array.from({ length: 12 }, (_, i) => item('Go to', `Place ${i}`));
  assert.equal(arrange(goto, '')[0]?.items.length, 12, 'places are few and all shown');
});

test('the arrow keys move across groups and wrap at either end', () => {
  assert.equal(step(0, 1, 3), 1);
  assert.equal(step(2, 1, 3), 0);
  assert.equal(step(0, -1, 3), 2);
  assert.equal(step(-1, 1, 3), 0);
  assert.equal(step(-1, -1, 3), 2);
  assert.equal(step(0, 1, 0), -1);
});
