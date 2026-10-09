// The verification's comparisons on made-up pixels and element snapshots: what differs, where, which edit it belongs
// to, and the order the steps decide in. No window: the renders are bitmaps built here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareElements, comparePixels, diffBitmaps, diffPicture, editsAt, judge, noiseFloor, parseVerdict, verdictNoise, verifyWidths,
  withinNoise, zonesOf, type Bitmap, type ElementSnap, type PixelArea, type WidthFindings,
} from './layer-verify.ts';

/** A page of one colour, as a capture gives it. */
function page(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([...rgb, 255], p * 4);
  return { data, width, height };
}

/** Paint a rectangle of a page. */
function paint(b: Bitmap, r: { x: number; y: number; width: number; height: number }, rgb: [number, number, number]): Bitmap {
  const out = { ...b, data: new Uint8Array(b.data) };
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) out.data.set([...rgb, 255], (y * b.width + x) * 4);
  return out;
}

const snap = (edit: string, box: ElementSnap['box'], values: Record<string, string> = { color: 'rgb(0, 0, 0)', text: 'Paddling 101' }, n = 0): ElementSnap =>
  ({ edit, n, element: 'h2.card__title', values, box });

test('identical renders differ nowhere, and the noise floor of a render against itself is nothing', () => {
  const a = page(200, 300);
  const d = diffBitmaps(a, page(200, 300));
  assert.deepEqual([d.maxDiff, d.pixels], [0, 0]);
  assert.deepEqual(noiseFloor(a, a), { maxDiff: 0, pixels: 0 });
  const found = comparePixels(d, zonesOf([snap('e1', { x: 10, y: 10, width: 50, height: 20 })], []), 200);
  assert.deepEqual([found.near.pixels, found.rest.pixels, found.near.differences, found.rest.differences], [0, 0, [], []]);
});

test('a changed area inside a touched element is boxed and tied to that edit; one away from every element is a leak', () => {
  const result = page(320, 400);
  // The design paints the heading's box a different colour; the result also changes a footer nobody edited.
  const design = paint(result, { x: 20, y: 40, width: 100, height: 24 }, [200, 30, 30]);
  const leaked = paint(result, { x: 0, y: 360, width: 320, height: 20 }, [10, 10, 10]);
  const zones = zonesOf([snap('e1', { x: 20, y: 40, width: 100, height: 24 }), snap('e2', { x: 20, y: 200, width: 80, height: 20 })], []);

  const near = comparePixels(diffBitmaps(design, result), zones, 320);
  assert.equal(near.near.pixels, 100 * 24);
  assert.equal(near.near.maxDiff, 225);
  assert.equal(near.rest.pixels, 0);
  assert.equal(near.near.differences.length, 1);
  const [box] = near.near.differences;
  assert.ok(box?.kind === 'pixels' && box.edit === 'e1', 'tied to the edit whose element it is in');
  assert.ok(box.kind === 'pixels' && box.rect.x <= 20 && box.rect.y <= 40 && box.rect.x + box.rect.width >= 120 && box.rect.y + box.rect.height >= 64, 'the box holds the change');
  assert.equal(box.kind === 'pixels' && box.pixels, 2400);

  const leak = comparePixels(diffBitmaps(leaked, result), zones, 320);
  assert.equal(leak.near.pixels, 0);
  assert.equal(leak.rest.pixels, 320 * 20);
  assert.deepEqual(leak.rest.differences.map((d) => d.kind), ['leak']);
  assert.ok(leak.rest.differences[0]?.kind === 'leak' && leak.rest.differences[0].rect.y <= 360 && leak.rest.differences[0].width === 320);
});

test('a page of another height differs where only one has pixels', () => {
  const d = diffBitmaps(page(100, 120), page(100, 100));
  assert.deepEqual([d.width, d.height, d.pixels, d.maxDiff], [100, 120, 100 * 20, 255]);
});

test('the noise floor is two numbers, and an area passes only within both', () => {
  const once = page(100, 100);
  // Rendered again, a few pixels of anti-aliasing came out one level off.
  const twice = paint(once, { x: 5, y: 5, width: 3, height: 1 }, [254, 254, 254]);
  const noise = noiseFloor(once, twice);
  assert.deepEqual(noise, { maxDiff: 1, pixels: 3 });
  assert.ok(withinNoise({ maxDiff: 1, pixels: 3 }, noise));
  assert.ok(!withinNoise({ maxDiff: 2, pixels: 1 }, noise), 'a larger difference fails however few pixels');
  assert.ok(!withinNoise({ maxDiff: 1, pixels: 4 }, noise), 'more pixels fail however slight');

  const findings = (design: Bitmap): WidthFindings => {
    const d = diffBitmaps(design, once);
    return { width: 100, noise, elements: [], pixels: comparePixels(d, zonesOf([snap('e1', { x: 0, y: 0, width: 40, height: 40 })], []), 100) };
  };
  assert.equal(judge([findings(twice)]).ok, true, 'the design within the noise of the result passes');
  const subtle = paint(once, { x: 60, y: 60, width: 30, height: 30 }, [254, 254, 254]);
  const verdict = judge([findings(subtle)]);
  assert.equal(verdict.failed, 'rest', 'a slight change over many pixels away from the edit is still a leak');
  assert.equal(verdict.differences[0]?.kind, 'leak');
});

test('step 1 says exactly which value or box of a touched element differs, and a missing element', () => {
  const box = { x: 20, y: 40, width: 100, height: 24 };
  const same = compareElements([snap('e1', box)], [snap('e1', box)], 390);
  assert.deepEqual(same, []);
  const off = compareElements(
    [snap('e1', box, { color: 'rgb(200, 30, 30)', text: 'Paddling 101' }), snap('e1', box, undefined, 1)],
    [snap('e1', { ...box, height: 48 }, { color: 'rgb(0, 0, 0)', text: 'Paddling 101' })],
    390,
  );
  assert.deepEqual(off, [
    { kind: 'style', edit: 'e1', width: 390, element: 'h2.card__title', property: 'color', design: 'rgb(200, 30, 30)', result: 'rgb(0, 0, 0)' },
    { kind: 'box', edit: 'e1', width: 390, element: 'h2.card__title', design: box, result: { ...box, height: 48 } },
    { kind: 'style', edit: 'e1', width: 390, element: 'h2.card__title', property: 'element', design: 'on the page', result: 'not on the page' },
  ]);
  assert.deepEqual(compareElements([snap('e1', box)], [snap('e1', { ...box, x: 20.004 })], 390), [], 'a box within a hundredth of a pixel is the same box');
});

test('the steps decide in order: styles before pixels before the rest, at any width', () => {
  const quiet: PixelArea = { maxDiff: 0, pixels: 0, differences: [] };
  const loud = (kind: 'pixels' | 'leak'): PixelArea => ({ maxDiff: 90, pixels: 40, differences: [kind === 'pixels'
    ? { kind, edit: 'e1', width: 1440, rect: { x: 0, y: 0, width: 16, height: 16 }, pixels: 40, maxDiff: 90 } as const
    : { kind, width: 1440, rect: { x: 0, y: 0, width: 16, height: 16 }, pixels: 40, maxDiff: 90 } as const] });
  const style = { kind: 'style', edit: 'e1', width: 390, element: 'h2', property: 'color', design: 'red', result: 'blue' } as const;
  const w = (width: number, elements: WidthFindings['elements'], near = quiet, rest = quiet): WidthFindings => ({ width, noise: { maxDiff: 0, pixels: 0 }, elements, pixels: { near, rest } });
  assert.deepEqual(judge([w(390, []), w(1440, [])]), { ok: true, failed: null, differences: [] });
  assert.equal(judge([w(390, [], quiet, loud('leak')), w(1440, [], loud('pixels'))]).failed, 'pixels', 'pixels near an edit at one width come before a leak at another');
  const first = judge([w(390, [style], quiet, loud('leak')), w(1440, [], loud('pixels'))]);
  assert.equal(first.failed, 'styles');
  assert.deepEqual(first.differences, [style], 'only the failing step’s differences are said');
  assert.deepEqual(verdictNoise([{ ...w(390, []), noise: { maxDiff: 3, pixels: 2 } }, { ...w(1440, []), noise: { maxDiff: 1, pixels: 9 } }]), { maxDiff: 3, pixels: 9 });
});

test('a failed verdict goes back to the edits it names, or to all of them when a leak names none', () => {
  const style = { kind: 'style', edit: 'e2', width: 390, element: 'h2', property: 'color', design: 'red', result: 'blue' } as const;
  assert.deepEqual(editsAt({ ok: false, differences: [style] }, ['e1', 'e2']), ['e2']);
  assert.deepEqual(editsAt({ ok: false, differences: [{ kind: 'leak', width: 390, rect: { x: 0, y: 0, width: 1, height: 1 }, pixels: 1, maxDiff: 9 }] }, ['e1', 'e2']), ['e1', 'e2']);
  assert.deepEqual(editsAt({ ok: true, differences: [] }, ['e1']), []);
});

test('the difference picture marks what differs past the noise, the same in either channel order', () => {
  const result = page(4, 1, [0, 0, 0]);
  const design = paint(result, { x: 1, y: 0, width: 1, height: 1 }, [9, 9, 9]);
  const pic = diffPicture(result, diffBitmaps(design, result), { maxDiff: 0, pixels: 0 });
  assert.deepEqual([...pic.data.slice(4, 8)], [255, 0, 255, 255]);
  assert.deepEqual([...pic.data.slice(0, 4)], [166, 166, 166, 255], 'the rest faded');
  const lenient = diffPicture(result, diffBitmaps(design, result), { maxDiff: 9, pixels: 1 });
  assert.notDeepEqual([...lenient.data.slice(4, 8)], [255, 0, 255, 255], 'within the noise it is not marked');
});

test('widths are whole CSS pixels, each once, at most four; none asked means a phone and a desktop', () => {
  assert.deepEqual(verifyWidths(undefined), [390, 1440]);
  assert.deepEqual(verifyWidths([768, 768, 1280]), [768, 1280]);
  assert.match(verifyWidths([100]) as string, /320 to 2560/);
  assert.match(verifyWidths([390, 768, 1024, 1280, 1440]) as string, /at most 4/);
  assert.match(verifyWidths([]) as string, /Name the widths/);
});

test('a verdict from outside is checked: consistent, bounded, with well-formed differences', () => {
  const good = {
    at: 5, ok: false, failed: 'pixels', widths: [390], noise: { maxDiff: 1, pixels: 3 },
    differences: [{ kind: 'pixels', edit: 'e1', width: 390, rect: { x: 0, y: 0, width: 16, height: 16 }, pixels: 4, maxDiff: 80 }],
    pictures: [{ width: 390, design: '/data/live-layer/p/e1/390-design.png', result: '/data/live-layer/p/e1/390-result.png', diff: null }],
  };
  assert.deepEqual(parseVerdict(good), good);
  assert.equal(parseVerdict({ ...good, ok: true }), null, 'a verdict that passed fails no step');
  assert.equal(parseVerdict({ ...good, failed: 'hover' }), null);
  assert.equal(parseVerdict({ ...good, noise: { maxDiff: 300, pixels: 0 } }), null);
  assert.equal(parseVerdict({ ...good, differences: [{ kind: 'style', edit: 'E 1', width: 390, element: 'h2', property: 'color', design: 'a', result: 'b' }] }), null);
  assert.equal(parseVerdict({ ...good, differences: Array.from({ length: 301 }, () => good.differences[0]) }), null);
  assert.equal(parseVerdict({ ...good, pictures: [{ width: 390, design: 'x'.repeat(2001), result: 'y', diff: null }] }), null);
});
