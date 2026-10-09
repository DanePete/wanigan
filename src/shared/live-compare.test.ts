// Comparing two renders of a page: lining up pages of different heights, the
// pixels that differ, boxes and their names, and the viewer's keys. The pages
// are made here, row by row; no screenshot of any site is involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveRegion } from './live.ts';
import { SHORTCUTS } from './shortcuts.ts';
import {
  ALIKE, DIFFERS, IGNORED, ONE_SIDE, alignRows, alignedRect, alignedRow, changeBoxes, changesOf, colourDelta, compareKey, compareSummary,
  difference, matchRows, maxDelta, pageRect, partAt, rowHashes, scrollFor, sourceRow, stepChange, type Pixels,
} from './live-compare.ts';

const W = 40;

/**
 * A made-up page, described row by row: 0 is a blank white row, any other
 * number a row of "content" whose pixels depend on that number (so rows with
 * different numbers differ, and each is unique unless repeated on purpose).
 */
function page(rows: readonly number[], width = W): Pixels {
  const data = new Uint8ClampedArray(width * rows.length * 4).fill(255);
  rows.forEach((id, y) => {
    if (!id) return;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = (id * 37 + x * 11 + ((id * x) % 7) * 23) % 200;
      data[i] = v; data[i + 1] = (v * 3) % 200; data[i + 2] = (v * 7) % 200;
    }
  });
  return { data, width, height: rows.length };
}

const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i);
const blank = (count: number): number[] => Array(count).fill(0);
const kinds = (al: ReturnType<typeof alignRows>): string[] => al.bands.map((b) => `${b.kind}:${b.rows}`);

test('the same page lines up as one run of matching rows, and nothing differs', () => {
  const rows = [...range(1, 30), ...blank(10), ...range(100, 30)];
  const a = page(rows);
  const al = alignRows(rowHashes(a), rowHashes(page(rows)));
  assert.deepEqual(kinds(al), ['same:70']);
  const diff = difference(a, page(rows), al);
  assert.equal(diff.pixels, 0);
  assert.deepEqual(changesOf(diff, al), []);
  assert.match(compareSummary({ diff, al, changes: [], a: { label: 'Local', height: 70 }, b: { label: 'Live', height: 70 } }), /No pixels differ/);
});

test('a section only the hosted page has is a band beside nothing, and what follows still lines up', () => {
  const top = range(1, 40);
  const bottom = [...blank(6), ...range(200, 40)];
  const extra = range(500, 24);
  const a = page([...top, ...bottom]);
  const b = page([...top, ...extra, ...bottom]);
  const al = alignRows(rowHashes(a), rowHashes(b));
  assert.deepEqual(kinds(al), ['same:40', 'only-b:24', 'same:46']);
  assert.equal(al.height, 110, 'as tall as the taller page');
  assert.equal(sourceRow(al, 50, 'a'), null, 'Local has nothing beside the extra section');
  assert.equal(sourceRow(al, 50, 'b'), 50);
  assert.equal(sourceRow(al, 64, 'a'), 40, 'below it, Local’s rows carry on from where they stopped');
  assert.equal(alignedRow(al, 40, 'a'), 64);
  const diff = difference(a, b, al);
  assert.equal(diff.pixels, 0, 'the extra rows are not counted as changed pixels');
  assert.equal(diff.marks[50 * W], ONE_SIDE);
  assert.deepEqual(changesOf(diff, al).map((c) => [c.kind, c.rect.y, c.rect.height]), [['only-b', 40, 24]]);
  const said = compareSummary({ diff, al, changes: changesOf(diff, al), a: { label: 'Local', height: 86 }, b: { label: 'Live', height: 110 } });
  assert.match(said, /Live is 24 px taller \(110 px against 86 px\)/);
  assert.match(said, /24 px only on Live, striped/);
});

test('blank rows anchor nothing, so they cannot pull the pages out of line', () => {
  const a = [...range(1, 10), ...blank(20), ...range(30, 10), ...blank(20), ...range(60, 10)];
  const b = [...range(1, 10), ...blank(20), ...range(700, 10), ...blank(20), ...range(30, 10), ...blank(20), ...range(60, 10)];
  const al = alignRows(rowHashes(page(a)), rowHashes(page(b)));
  // Rows 30.. and 60.. are unique: they anchor, and the new block (with its blank rows) is one band.
  const pairs = matchRows(rowHashes(page(a)), rowHashes(page(b)));
  assert.ok(pairs.some(([i, j]) => i === 30 && j === 60), 'the block after the insertion is matched where it moved to');
  assert.deepEqual(kinds(al), ['same:30', 'only-b:30', 'same:40']);
});

test('a changed block of the same height is compared pixel by pixel and boxed where it is', () => {
  const a = page([...range(1, 32), ...range(100, 16), ...range(200, 32)]);
  const b = page([...range(1, 32), ...range(300, 16), ...range(200, 32)]);
  const al = alignRows(rowHashes(a), rowHashes(b));
  assert.deepEqual(kinds(al), ['same:32', 'changed:16', 'same:32']);
  const diff = difference(a, b, al);
  assert.ok(diff.pixels > 16 * W * 0.5, `most of the block differs (${diff.pixels})`);
  const changes = changesOf(diff, al);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'changed');
  const r = changes[0]!.rect;
  assert.ok(r.y <= 32 && r.y + r.height >= 48 && r.y >= 16, `the box covers rows 32–48 (${JSON.stringify(r)})`);
});

test('a taller block pairs its rows and leaves the rest beside nothing', () => {
  const a = page([...range(1, 20), ...range(100, 10), ...range(200, 20)]);
  const b = page([...range(1, 20), ...range(300, 16), ...range(200, 20)]);
  assert.deepEqual(kinds(alignRows(rowHashes(a), rowHashes(b))), ['same:20', 'changed:10', 'only-b:6', 'same:20']);
});

test('an item added to a list whose items look alike at their edges: the band could sit anywhere between two titles, and says so', () => {
  // Each item: two rows of its background, its own title row, background, a subtitle every item shares, background.
  const item = (title: number): number[] => [7, 7, title, 7, 8, 7];
  const a = [...range(1, 10), ...item(101), 0, 0, ...item(102), 0, 0, ...item(103), ...range(300, 10)];
  const b = [...range(1, 10), ...item(101), 0, 0, ...item(109), 0, 0, ...item(102), 0, 0, ...item(103), ...range(300, 10)];
  const al = alignRows(rowHashes(page(a)), rowHashes(page(b)));
  const band = al.bands.find((x) => x.kind === 'only-b');
  assert.equal(band?.rows, 8);
  const top = band!.a - band!.slack!.up;
  const bottom = band!.a + band!.slack!.down;
  assert.ok(top <= 13 && bottom >= 18, `it could sit anywhere from after the first title (row 12) to the second (row 18): ${top}–${bottom}`);
});

test('pages with nothing in common are compared from the top, the longer one’s rest beside nothing', () => {
  const al = alignRows(rowHashes(page(range(1, 30))), rowHashes(page(range(400, 50))));
  assert.deepEqual(kinds(al), ['changed:30', 'only-b:20']);
});

test('an ignored area is not compared, and does not stop rows lining up', () => {
  const rows = range(1, 40);
  const a = page(rows);
  const b = page(rows);
  // Something in rows 10–19, columns 5–14, differs (a carousel's slide).
  for (let y = 10; y < 20; y++) for (let x = 5; x < 15; x++) b.data[(y * W + x) * 4] = (a.data[(y * W + x) * 4]! + 120) % 256;
  const mask = { x: 4, y: 9, width: 12, height: 12 };
  assert.deepEqual(kinds(alignRows(rowHashes(a, [mask]), rowHashes(b, [mask]))), ['same:40'], 'the rows match once the area is left out');
  const plain = alignRows(rowHashes(a), rowHashes(b));
  assert.ok(difference(a, b, plain).pixels > 0, 'without the mask the slide differs');
  const ignored = difference(a, b, plain, [alignedRect(plain, mask)]);
  assert.equal(ignored.pixels, 0);
  assert.equal(ignored.marks[12 * W + 8], IGNORED);
});

test('a lone differing pixel is noise; a one-pixel line is a change', () => {
  const rows = range(1, 30);
  const a = page(rows);
  const lone = page(rows);
  lone.data[(10 * W + 10) * 4] = (lone.data[(10 * W + 10) * 4]! + 150) % 256;
  const same = alignRows(rowHashes(page(rows)), rowHashes(page(rows)));
  const forced = { ...same, bands: [{ kind: 'changed' as const, a: 0, b: 0, rows: 30 }] };
  assert.equal(difference(a, lone, forced).pixels, 0);
  const line = page(rows);
  for (let x = 4; x < 30; x++) { const i = (20 * W + x) * 4; line.data[i] = 0; line.data[i + 1] = 0; line.data[i + 2] = 0; }
  const d = difference(a, line, forced);
  assert.ok(d.pixels >= 20, `the line is counted (${d.pixels})`);
  assert.equal(d.marks[20 * W + 15], DIFFERS);
  assert.equal(d.marks[5 * W + 15], ALIKE);
});

test('colour distance: the same colour is nothing, black and white are far, a step of one is under the threshold', () => {
  assert.equal(colourDelta(10, 20, 30, 10, 20, 30), 0);
  assert.ok(colourDelta(0, 0, 0, 255, 255, 255) > maxDelta(0.1));
  assert.ok(colourDelta(100, 100, 100, 101, 101, 100) < maxDelta(0.1));
});

test('touching cells are one box, kept inside the picture; separate areas are boxed apart, top first', () => {
  const w = 100;
  const h = 100;
  const marks = new Uint8Array(w * h);
  for (let x = 0; x < 20; x++) marks[60 * w + x] = DIFFERS;
  for (let x = 80; x < 100; x++) marks[5 * w + x] = DIFFERS;
  const boxes = changeBoxes(marks, w, h);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { x: 74, y: 0, width: 26, height: 22 });
  assert.equal(boxes[1]?.x, 0, 'a box at the edge stays inside');
});

test('a change is named by the local part it overlaps most, the smallest of equals', () => {
  const region = (index: number, component: string, rect: LiveRegion['rect']): LiveRegion => ({
    index, file: null, entity: null, block: null, view: null, element: null, component, piece: null, hook: null, field: null, suggestions: [], parent: null, order: index, rect,
  });
  const regions = [
    region(0, 'acme:page', { x: 0, y: 0, width: 1440, height: 3000 }),
    region(1, 'acme:hero', { x: 0, y: 80, width: 1440, height: 400 }),
    region(2, 'acme:cards', { x: 0, y: 600, width: 1440, height: 500 }),
    region(3, 'acme:card', { x: 40, y: 620, width: 420, height: 460 }),
    region(4, 'acme:card', { x: 500, y: 620, width: 420, height: 460 }),
    region(5, 'acme:empty', { x: 0, y: 0, width: 0, height: 0 }),
  ];
  assert.equal(partAt({ x: 100, y: 200, width: 300, height: 40 }, regions, 1440)?.component, 'acme:hero');
  assert.equal(partAt({ x: 300, y: 700, width: 400, height: 100 }, regions, 1440)?.component, 'acme:cards', 'across two cards: the list holding both');
  assert.equal(partAt({ x: 60, y: 700, width: 100, height: 40 }, regions, 1440)?.index, 3);
  assert.equal(partAt({ x: 0, y: 1090, width: 1440, height: 1 }, regions, 1440, true)?.component, 'acme:cards', 'a band added to a list is named by the list');
  assert.equal(partAt({ x: 0, y: 620, width: 1440, height: 1 }, regions, 1440, true)?.component, 'acme:cards', 'not by the item that begins where it was added');
  assert.equal(partAt({ x: 0, y: 0, width: 1440, height: 1 }, regions, 1440, true)?.component, 'acme:page', 'at the very top, the part that starts there');
  assert.equal(partAt({ x: 0, y: 5000, width: 10, height: 10 }, regions, 1440), null);
});

test('a rectangle of the aligned picture in each side’s own page', () => {
  const al = alignRows(rowHashes(page([...range(1, 40), ...range(200, 40)])), rowHashes(page([...range(1, 40), ...range(500, 24), ...range(200, 40)])));
  assert.deepEqual(pageRect(al, { x: 0, y: 70, width: 10, height: 10 }, 'a'), { x: 0, y: 46, width: 10, height: 10 });
  assert.deepEqual(pageRect(al, { x: 0, y: 45, width: 40, height: 10 }, 'a'), { x: 0, y: 40, width: 40, height: 1 }, 'a gap on Local sits before its next row');
  assert.deepEqual(pageRect(al, { x: 0, y: 45, width: 40, height: 10 }, 'b'), { x: 0, y: 45, width: 40, height: 10 });
  assert.deepEqual(alignedRect(al, { x: 3, y: 46, width: 5, height: 10 }), { x: 3, y: 70, width: 5, height: 10 });
});

test('the viewer’s keys', () => {
  const k = (key: string, more: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
    compareKey({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...more });
  assert.deepEqual(k('ArrowLeft'), { flip: 'a' });
  assert.deepEqual(k('ArrowRight'), { flip: 'b' });
  assert.deepEqual(k(' '), { flip: 'other' });
  assert.deepEqual(k('s'), { mode: 'slider' });
  assert.deepEqual(k('O'), { mode: 'onion' });
  assert.deepEqual(k('d'), { mode: 'difference' });
  assert.deepEqual(k('t'), { mode: 'side' });
  assert.deepEqual(k('j'), { step: 1 });
  assert.deepEqual(k('k'), { step: -1 });
  assert.deepEqual(k('1'), { width: 390 });
  assert.deepEqual(k('2'), { width: 768 });
  assert.deepEqual(k('3'), { width: 1440 });
  assert.deepEqual(k('i'), { ignore: 'page' });
  assert.deepEqual(k('I', { shiftKey: true }), { ignore: 'site' });
  assert.equal(k('s', { metaKey: true }), null, '⌘S is not the slider');
  assert.equal(k('k', { ctrlKey: true }), null);
  assert.equal(k('x'), null);
  assert.equal(k('Enter'), null);
});

test('stepping through changes wraps, and scrolling puts one a quarter of the way down', () => {
  assert.equal(stepChange(-1, 3, 1), 0);
  assert.equal(stepChange(-1, 3, -1), 2);
  assert.equal(stepChange(2, 3, 1), 0);
  assert.equal(stepChange(0, 3, -1), 2);
  assert.equal(stepChange(0, 0, 1), -1);
  assert.equal(scrollFor({ x: 0, y: 1000, width: 10, height: 10 }, 0.5, 400), 400);
  assert.equal(scrollFor({ x: 0, y: 10, width: 10, height: 10 }, 1, 400), 0);
});

test('the shortcut sheet lists exactly the viewer’s keys, and each does what it says', () => {
  const listed = SHORTCUTS.filter((s) => s.group === 'Comparing pages');
  const press = (keys: string[]) => {
    const shift = keys[0] === 'Shift';
    const k = keys[keys.length - 1] as string;
    const key = ({ '←': 'ArrowLeft', '→': 'ArrowRight', Space: ' ' } as Record<string, string>)[k] ?? (shift ? k.toUpperCase() : k.toLowerCase());
    return compareKey({ key, shiftKey: shift, metaKey: false, ctrlKey: false, altKey: false });
  };
  const said = listed.flatMap((s) => [s.keys, ...(s.alt ?? [])].map((keys) => [s.label, press(keys)] as const));
  assert.ok(said.every(([, action]) => action !== null), 'every listed key does something');
  assert.deepEqual(said.map(([label, action]) => `${label}: ${JSON.stringify(action)}`), [
    'Show Local, or the hosted page: {"flip":"a"}', 'Show Local, or the hosted page: {"flip":"b"}', 'Flip to the other: {"flip":"other"}',
    'Slider: {"mode":"slider"}', 'Onion skin: {"mode":"onion"}', 'Difference: {"mode":"difference"}', 'Side by side: {"mode":"side"}',
    'Next change: {"step":1}', 'Previous change: {"step":-1}',
    'Phone, tablet or desktop width: {"width":390}', 'Phone, tablet or desktop width: {"width":768}', 'Phone, tablet or desktop width: {"width":1440}',
    'Ignore the change on this page: {"ignore":"page"}', 'Ignore the change on every page: {"ignore":"site"}',
  ]);
});
