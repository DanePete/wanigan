import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL, changedAreas, diffSummary } from './live-diff.ts';

/** A white image, four bytes a pixel, with rectangles painted in a colour. */
function image(w: number, h: number, paint: { x: number; y: number; width: number; height: number; rgb: [number, number, number] }[] = []): Uint8Array {
  const data = new Uint8Array(w * h * 4).fill(255);
  for (const p of paint) {
    for (let y = p.y; y < p.y + p.height; y++) {
      for (let x = p.x; x < p.x + p.width; x++) {
        const i = (y * w + x) * 4;
        [data[i], data[i + 1], data[i + 2]] = p.rgb;
      }
    }
  }
  return data;
}

test('two separate changes are two areas, top to bottom, each with its own pixel count', () => {
  const before = image(200, 400);
  const after = image(200, 400, [
    { x: 150, y: 300, width: 10, height: 10, rgb: [0, 0, 0] },
    { x: 10, y: 20, width: 40, height: 5, rgb: [200, 0, 0] },
  ]);
  const d = changedAreas(before, after, 200, 400);
  assert.equal(d.pixels, 300);
  assert.equal(d.total, 80_000);
  assert.equal(d.areas.length, 2);
  assert.deepEqual(d.areas.map((a) => a.pixels), [200, 100], 'the upper change first');
  const [top, low] = d.areas;
  assert.ok(top!.x <= 10 && top!.x + top!.width >= 50 && top!.y <= 20 && top!.y + top!.height >= 25, 'the box holds the change, padded');
  assert.ok(low!.y <= 300 && low!.y + low!.height >= 310);
});

test('touching cells are one area; antialiasing noise is not a change; channel order does not matter', () => {
  const before = image(64, 64);
  const after = image(64, 64, [{ x: CELL - 2, y: 4, width: 4, height: 4, rgb: [0, 0, 0] }]);
  assert.equal(changedAreas(before, after, 64, 64).areas.length, 1, 'a change across a cell border is one area');
  const faint = image(64, 64, [{ x: 0, y: 0, width: 64, height: 64, rgb: [250, 250, 250] }]);
  assert.equal(changedAreas(before, faint, 64, 64).pixels, 0, 'a shift of 15 summed over the channels is noise');
  const swapped = image(64, 64, [{ x: 0, y: 0, width: 8, height: 8, rgb: [0, 0, 255] }]);
  const swappedBack = image(64, 64, [{ x: 0, y: 0, width: 8, height: 8, rgb: [255, 0, 0] }]);
  assert.equal(changedAreas(before, swapped, 64, 64).pixels, changedAreas(before, swappedBack, 64, 64).pixels, 'RGBA or BGRA alike');
  assert.throws(() => changedAreas(before, image(10, 10), 64, 64), /width × height/);
});

test('the summary says how much differs, or that nothing does', () => {
  assert.equal(diffSummary({ pixels: 0, total: 100, areas: [] }), 'No pixels differ: the page looks the same.');
  assert.equal(diffSummary({ pixels: 1234, total: 246_800, areas: 2 }), '1,234 pixels differ (0.50% of the page), in 2 areas');
  assert.equal(diffSummary({ pixels: 1, total: 1_000_000, areas: [1] }), '1 pixel differs (<0.1% of the page), in one area');
});
