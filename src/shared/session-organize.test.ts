/**
 * Tags and Recent sections, the pure half. The rules that matter are the ones a
 * person notices when they break: the same word must be one tag whatever its
 * case, a colour must come from the palette, a pin must still win over a
 * section, and a section that was deleted must not take its conversations with
 * it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeRecent, defaultTagColor, filterByTag, hasControlCharacter, isTagColor, moveInOrder, normaliseSectionName,
  normaliseTag, parseTagInput, TAG_COLORS, TAG_MAX_CHARS, tagCounts,
} from './session-organize.ts';

test('a tag keeps its case for display and folds it for identity', () => {
  const a = normaliseTag('  Waiting   on CI ');
  assert.deepEqual(a, { ok: true, value: { tag: 'Waiting on CI', norm: 'waiting on ci' } });
  const b = normaliseTag('#release-blocker');
  assert.equal(b.ok && b.value.tag, 'release-blocker');
});

test('an empty, overlong or control-character tag is refused with a sentence', () => {
  for (const bad of ['', '   ', '#', 'x'.repeat(TAG_MAX_CHARS + 1), 'bad\x1b[31m', 42]) {
    const r = normaliseTag(bad);
    assert.equal(r.ok, false, String(bad));
    assert.ok(!r.ok && r.reason.length > 5);
  }
  assert.equal(normaliseTag('x'.repeat(TAG_MAX_CHARS)).ok, true);
  assert.equal(hasControlCharacter('tab\there'), true);
  assert.equal(hasControlCharacter('plain words'), false);
});

test('several tags typed at once fold duplicates and report what they refused', () => {
  const r = parseTagInput('spike, Spike ,  , release-blocker, ' + 'y'.repeat(40));
  assert.deepEqual(r.tags.map((t) => t.norm), ['spike', 'release-blocker']);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0], /at most/);
});

test('a default colour is stable, from the palette, and never grey', () => {
  for (const word of ['spike', 'release-blocker', 'waiting on ci', 'a', 'z'.repeat(30)]) {
    const colour = defaultTagColor(word);
    assert.equal(colour, defaultTagColor(word));
    assert.ok(isTagColor(colour));
    assert.notEqual(colour, 'grey');
  }
  assert.equal(isTagColor('#ff0000'), false);
  assert.equal(isTagColor('grey'), true);
  assert.equal(TAG_COLORS.length, 8);
});

test('a section name is trimmed and bounded', () => {
  assert.deepEqual(normaliseSectionName('  This   week '), { ok: true, name: 'This week' });
  assert.equal(normaliseSectionName('').ok, false);
  assert.equal(normaliseSectionName('n'.repeat(41)).ok, false);
});

test('moving past either end is no move, and says so by identity', () => {
  const order = ['a', 'b', 'c'] as const;
  assert.deepEqual(moveInOrder(order, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveInOrder(order, 'b', 1), ['a', 'c', 'b']);
  assert.equal(moveInOrder(order, 'a', -1), order);
  assert.equal(moveInOrder(order, 'c', 1), order);
  assert.equal(moveInOrder(order, 'x' as 'a', 1), order);
});

test('Recent is arranged pinned, sections in order, unfiled, settled — and a lost section files nothing', () => {
  const row = (id: string, over: Partial<{ pinnedAt: number | null; settledAt: number | null }> = {}) =>
    ({ id, pinnedAt: null, settledAt: null, ...over });
  const rows = [row('p', { pinnedAt: 1 }), row('a'), row('b'), row('c'), row('d', { settledAt: 2 }), row('e'), row('ghost')];
  const placements: Record<string, { sectionId: string; position: number }> = {
    a: { sectionId: 's2', position: 1 },
    b: { sectionId: 's2', position: 0 },
    c: { sectionId: 's1', position: 0 },
    p: { sectionId: 's1', position: 1 },
    ghost: { sectionId: 'deleted', position: 0 },
  };
  const out = arrangeRecent(rows, [
    { id: 's2', name: 'Later', position: 1 },
    { id: 's1', name: 'Now', position: 0 },
  ], (r) => placements[r.id] ?? null);
  assert.deepEqual(out.pinned.map((r) => r.id), ['p'], 'a pin wins over its section');
  assert.deepEqual(out.sections.map((s) => [s.section.name, s.rows.map((r) => r.id)]), [['Now', ['c']], ['Later', ['b', 'a']]]);
  assert.deepEqual(out.unfiled.map((r) => r.id), ['e', 'ghost']);
  assert.deepEqual(out.settled.map((r) => r.id), ['d']);
});

test('a tag filter keeps only rows carrying it, and counts rows not occurrences', () => {
  const rows = [
    { id: '1', tags: [{ tag: 'Spike', norm: 'spike' }, { tag: 'spike', norm: 'spike' }] },
    { id: '2', tags: [{ tag: 'release', norm: 'release' }] },
    { id: '3', tags: [{ tag: 'Spike', norm: 'spike' }, { tag: 'release', norm: 'release' }] },
    { id: '4', tags: [] },
  ];
  assert.deepEqual(filterByTag(rows, 'spike', (r) => r.tags).map((r) => r.id), ['1', '3']);
  assert.equal(filterByTag(rows, null, (r) => r.tags).length, 4);
  assert.deepEqual(tagCounts(rows, (r) => r.tags), [
    { tag: 'release', norm: 'release', count: 2 },
    { tag: 'Spike', norm: 'spike', count: 2 },
  ]);
});
