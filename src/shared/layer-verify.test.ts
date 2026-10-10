// The verification's comparisons on made-up pixels and element snapshots: what differs, where, which edit it belongs
// to, and the order the steps decide in. No window: the renders are bitmaps built here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  against, applyMask, compareElements, comparePixels, diffBitmaps, diffPicture, editsAt, judge, maskedOf, masksAmong, noiseFloor, parseVerdict, traceMasks,
  unionDiff, varyWhy, verdictNoise, verifyWidths, withinNoise, zonesOf, type Bitmap, type ElementSnap, type PixelArea, type RenderMask, type WidthFindings,
} from './layer-verify.ts';
import type { TracePart } from './live-trace.ts';

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

test('a verdict’s later fields are read when well formed, refused when not, and a verdict kept before them still reads', () => {
  const old = {
    at: 5, ok: true, failed: null, widths: [390, 1440], noise: { maxDiff: 0, pixels: 0 }, differences: [],
    pictures: [{ width: 390, design: '/data/live-layer/p/e1/390-design.png', result: '/data/live-layer/p/e1/390-result.png', diff: null }],
  };
  assert.deepEqual(parseVerdict(old), old, 'none of them: as it was kept');
  // One kept on the base before the cut had a field of its own: its statement was a difference, and still reads as one.
  const cutAsDifference = { ...old, differences: [{ kind: 'style', edit: 'e1', width: 1440, element: 'The page', property: 'compared', design: 'down to 6,000 px', result: 'not below that: …' }] };
  assert.deepEqual(parseVerdict(cutAsDifference), cutAsDifference);
  const full = {
    ...old, ok: false, failed: 'rest',
    differences: [{ kind: 'leak', width: 390, rect: { x: 0, y: 150, width: 64, height: 20 }, pixels: 1280, maxDiff: 90, against: { edit: 'e1', at: 1_700_000_000_000 } }],
    pictures: [{ ...old.pictures[0], before: '/data/live-layer/p/e1/before/390-page.png' }],
    masked: [{ label: 'Who’s online (block)', why: 'made for each user', widths: [390], nearEdit: false }],
    before: { ran: true, at: 1_700_000_000_000, widths: [390] }, held: { at: 1_700_000_000 }, cut: [{ width: 1440, to: 6_000, full: 9_412 }],
  };
  assert.deepEqual(parseVerdict(full), full);
  assert.deepEqual(parseVerdict({ ...full, before: { ran: false, why: 'No page from before was kept for it.' }, held: null }), { ...full, before: { ran: false, why: 'No page from before was kept for it.' }, held: null });
  const refused: [string, unknown][] = [
    ['a leak against an edit that is not one', { differences: [{ ...full.differences[0], against: { edit: 'E 1', at: 1 } }] }],
    ['a leak against nothing said', { differences: [{ ...full.differences[0], against: null }] }],
    ['a mask with no name', { masked: [{ label: '', why: 'x', widths: [390], nearEdit: false }] }],
    ['a mask at no width', { masked: [{ label: 'x', why: 'x', widths: [], nearEdit: false }] }],
    ['a mask not saying whether it was near an edit', { masked: [{ label: 'x', why: 'x', widths: [390] }] }],
    ['too many masks', { masked: Array.from({ length: 101 }, () => full.masked[0]) }],
    ['a step 3 that ran at no width', { before: { ran: true, at: 1, widths: [] } }],
    ['a step 3 that did not run, without why', { before: { ran: false, why: '' } }],
    ['a step 3 that is neither', { before: { ran: 'yes' } }],
    ['a hold at no time', { held: { at: -1 } }],
    ['a cut below the page', { cut: [{ width: 1440, to: 6_000, full: 5_000 }] }],
    ['a cut that is not one', { cut: { width: 1440 } }],
    ['a picture of the page before that is not a path', { pictures: [{ ...full.pictures[0], before: 7 }] }],
  ];
  for (const [what, over] of refused) assert.equal(parseVerdict({ ...full, ...(over as object) }), null, what);
});

test('step 3 against the page from before fails the rest of the page, and its leaks go back to that edit', () => {
  const quiet: PixelArea = { maxDiff: 0, pixels: 0, differences: [] };
  const leak: PixelArea = { maxDiff: 90, pixels: 40, differences: [{ kind: 'leak', width: 390, rect: { x: 0, y: 150, width: 64, height: 20 }, pixels: 40, maxDiff: 90 }] };
  const w = (before: PixelArea[]): WidthFindings => ({ width: 390, noise: { maxDiff: 0, pixels: 0 }, elements: [], pixels: { near: quiet, rest: quiet }, before });
  assert.deepEqual(judge([w([quiet])]), { ok: true, failed: null, differences: [] });
  const failed = judge([w([quiet, against(leak, 'e2', 1_700_000_000_000)])]);
  assert.equal(failed.failed, 'rest');
  assert.deepEqual(failed.differences, [{ ...leak.differences[0], against: { edit: 'e2', at: 1_700_000_000_000 } }]);
  assert.deepEqual(editsAt({ ok: false, differences: failed.differences }, ['e1', 'e2']), ['e2'], 'only the edit whose page from before it was');
  assert.equal(judge([w([{ ...leak, maxDiff: 1, pixels: 1 }])]).ok, false, 'held to the same floor as the rest');
});

test('two comparisons pictured as one: the larger difference per pixel, masked only where both left it out', () => {
  const a = applyMask(diffBitmaps(paint(page(4, 2), { x: 0, y: 0, width: 1, height: 1 }, [0, 0, 0]), page(4, 2)), [{ x: 0, y: 1, width: 4, height: 1 }]);
  const b = applyMask(diffBitmaps(paint(page(4, 2), { x: 3, y: 0, width: 1, height: 1 }, [200, 200, 200]), page(4, 2)), [{ x: 2, y: 1, width: 2, height: 1 }]);
  const u = unionDiff(a, b);
  assert.deepEqual([u.pixels, u.maxDiff, [...u.diff]], [2, 255, [255, 0, 0, 55, 0, 0, 0, 0]]);
  assert.deepEqual([...(u.masked ?? [])], [0, 0, 0, 0, 0, 0, 1, 1]);
});

/* ── masks ── */

test('what is left out is compared nowhere, a touched element is compared all the same, and the floor is measured over what is left', () => {
  const once = page(100, 100);
  // A block that changes between renders (a random order) at the top of the page, and the edited heading inside it.
  const again = paint(once, { x: 0, y: 0, width: 100, height: 30 }, [40, 40, 40]);
  const block = { x: 0, y: 0, width: 100, height: 30 };
  const heading = { x: 10, y: 10, width: 20, height: 10 };
  assert.deepEqual(noiseFloor(once, again), { maxDiff: 215, pixels: 3000 }, 'unmasked, the whole block is noise');
  assert.deepEqual(noiseFloor(once, again, [block], [heading]), { maxDiff: 215, pixels: 200 }, 'masked, only the heading inside it still counts');
  assert.deepEqual(noiseFloor(once, again, [block]), { maxDiff: 0, pixels: 0 });
  const d = applyMask(diffBitmaps(again, once), [block], [heading]);
  assert.equal(d.masked?.[0], 1, 'left out');
  assert.equal(d.masked?.[10 * 100 + 10], 0, 'the touched element is not');
  assert.equal(d.diff[0], 0);
  // A leak far from the block is still a leak, and no longer forgiven by the block's noise.
  const leaked = paint(again, { x: 0, y: 80, width: 10, height: 2 }, [200, 200, 200]);
  const floor = noiseFloor(once, again, [block], [heading]);
  const rest = comparePixels(applyMask(diffBitmaps(leaked, again), [block], [heading]), zonesOf([snap('e1', heading)], [], 0), 100).rest;
  assert.ok(!withinNoise(rest, { ...floor, pixels: 0, maxDiff: 0 }) && rest.pixels === 20, 'only the leak is counted');
  assert.equal(applyMask(d, []), d, 'nothing to leave out: the comparison as it was');
});

test('what a verdict says it left out: by name and why, at the widths, near an edit or not, and nothing that left nothing out', () => {
  const m = (label: string, rects: RenderMask['rects']): RenderMask => ({ label, why: 'made for each user', rects, held: false });
  const masked = maskedOf([
    { width: 390, masks: [m('Who’s online (block)', [{ x: 0, y: 0, width: 50, height: 20 }]), m('Cart (block)', [{ x: 0, y: 100, width: 10, height: 10 }])], keep: [{ x: 0, y: 95, width: 40, height: 40 }] },
    { width: 1440, masks: [m('Who’s online (block)', [{ x: 0, y: 0, width: 50, height: 20 }]), m('Who’s online (block)', [{ x: 0, y: 0, width: 50, height: 20 }]), m('Empty (block)', [{ x: 0, y: 0, width: 0, height: 20 }])], keep: [{ x: 40, y: 10, width: 40, height: 40 }] },
  ]);
  assert.deepEqual(masked, [{ label: 'Who’s online (block)', why: 'made for each user', widths: [390, 1440], nearEdit: true }],
    'the cart wholly inside an edited element is compared, an empty box left nothing out, and one overlapping an edited element says so');
});

test('a mask the helper held still is compared when every render was held alike, and left out otherwise', () => {
  const held: RenderMask = { label: 'Recent (view)', why: 'kept 60 seconds at most', rects: [{ x: 0, y: 0, width: 10, height: 10 }], held: true };
  const user: RenderMask = { label: 'Account menu (block)', why: 'made for each user', rects: [{ x: 0, y: 20, width: 10, height: 10 }], held: false };
  const at = (t: number) => ({ t, s: 7, views: [] });
  assert.deepEqual(masksAmong([{ masks: [held, user], steady: at(1) }, { masks: [held, user], steady: at(1) }]), [user, user]);
  assert.deepEqual(masksAmong([{ masks: [held, user], steady: at(1) }, { masks: [held], steady: at(2) }]), [held, user, held], 'held at two times: what changes with time is left out');
  assert.deepEqual(masksAmong([{ masks: [held], steady: at(1) }, { masks: [], steady: null }]), [held], 'one render the helper did not hold');
});

test('a Drupal part is left out by its own cache metadata, innermost first: what core bubbled up from a part inside is that part’s', () => {
  const part = (id: string, label: string, parent: string | null, cache: TracePart['cache'] | null, more: Partial<TracePart> = {}): TracePart =>
    ({ id, kind: 'block', label, ...(parent ? { parent } : {}), ...(cache ? { cache } : {}), ...more });
  const req = ['languages:language_interface', 'theme', 'user.permissions', 'headers:X-Wanigan-Live'];
  const parts: TracePart[] = [
    part('p1', 'Content', null, { tags: [], contexts: [...req, 'user'], maxAge: 60 }),
    part('p2', 'Article', 'p1', { tags: [], contexts: [...req, 'user'], maxAge: 60 }, { kind: 'entity' }),
    part('p3', 'Posted', 'p2', { tags: [], contexts: req, maxAge: 60 }, { kind: 'field' }),
    part('p4', 'Comments', 'p2', { tags: [], contexts: [...req, 'user'], maxAge: 'permanent' }, { kind: 'field' }),
    part('p5', 'Branding', null, { tags: [], contexts: req, maxAge: 'permanent' }),
    part('p6', 'Messages', null, { tags: [], contexts: req, maxAge: 'permanent', status: 'placeholder' }),
    part('p7', 'Random picks', null, { tags: [], contexts: req, maxAge: 0, status: 'placeholder' }),
    part('p8', 'Picks', 'p7', { tags: [], contexts: req, maxAge: 0, status: 'uncacheable' }, { kind: 'view', identity: { kind: 'config', type: 'view', id: 'picks:block_1' } }),
    part('p9', 'Pager', null, { tags: [], contexts: [...req, 'url.query_args:page', 'cookies:acme', 'headers:Accept', 'ip', 'session'], maxAge: 'permanent' }),
    part('p10', 'Footer', null, null),
  ];
  const masks = traceMasks({ parts }, null);
  assert.deepEqual(masks, [
    { part: 'p3', label: 'Posted (field)', why: 'kept 60 seconds at most', held: false },
    { part: 'p4', label: 'Comments (field)', why: 'made for each user', held: false },
    { part: 'p6', label: 'Messages (block)', why: 'built late, apart from the page (a placeholder)', held: false },
    { part: 'p8', label: 'Picks (view)', why: 'built afresh for every request (never cached)', held: false },
    { part: 'p9', label: 'Pager (block)', why: 'made for the address’s query; made for a cookie; made for a request header; made for the visitor’s address; made for each session', held: false },
  ], 'the article and the content around the field are not left out; the placeholder around the view is put off for the view’s reason');
  // Held at one time with the view's order seeded: a kept-for-a-while part and that view are compared against renders held alike.
  const heldMasks = traceMasks({ parts }, { t: 1, s: 7, views: ['picks:block_1'] });
  assert.deepEqual(heldMasks.map((m) => [m.part, m.held]), [['p3', true], ['p4', false], ['p6', false], ['p8', true], ['p9', false]]);
  assert.equal(traceMasks({ parts }, { t: 1, s: 7, views: [] }).find((m) => m.part === 'p8')?.held, false, 'a view the helper did not seed stays left out');
});

test('a WordPress block the helper marked says why in words, and an unknown reason is still said', () => {
  assert.equal(varyWhy('random-order'), 'shows its items in a random order');
  assert.equal(varyWhy('relative-date'), 'shows a date relative to now');
  assert.equal(varyWhy('weather'), 'changes between renders, its site helper says (weather)');
});

test('the difference picture shows what was left out in pale green, the same in either channel order', () => {
  const result = page(3, 1, [0, 0, 0]);
  const d = applyMask(diffBitmaps(result, result), [{ x: 2, y: 0, width: 1, height: 1 }]);
  const pic = diffPicture(result, d, { maxDiff: 0, pixels: 0 });
  assert.deepEqual([...pic.data.slice(8, 12)], [200, 232, 200, 255]);
});
