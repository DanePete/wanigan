import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveRegion } from './live.ts';
import type { TracePart } from './live-trace.ts';
import { blurBlock, clampRect, partLine, partsInArea, pixelate, rectFrom, snapContext } from './live-snap.ts';

const region = (index: number, rect: [number, number, number, number], extra: Partial<LiveRegion> = {}): LiveRegion => ({
  index, file: null, hook: null, suggestions: [], component: null, entity: null, block: null, view: null, element: null, piece: null, field: null,
  parent: null, order: index, rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, ...extra,
});

// The made-up page: a sidebar holding search, news and opening hours.
const sidebar = region(0, [900, 400, 300, 900], { hook: 'region', file: 'themes/custom/acme/templates/region--sidebar.html.twig', part: 'p-sidebar' });
const search = region(1, [912, 416, 276, 120], { block: 'search_form_block@acme_search', part: 'p-search' });
const news = region(2, [912, 548, 276, 200], { block: 'views_block:news-block_1@acme_news', part: 'p-news' });
const hours = region(3, [912, 760, 276, 140], { block: 'block_content:hours@acme_hours', file: 'themes/custom/acme/templates/block--hours.html.twig', part: 'p-hours' });
const regions = [sidebar, search, news, hours];

test('an area covers the parts at least half inside it, in page order, and names the part holding it all', () => {
  const got = partsInArea(regions, { x: 905, y: 540, width: 290, height: 380 });
  assert.deepEqual(got.inside.map((r) => r.index), [2, 3]);
  assert.equal(got.around?.index, 0, 'the sidebar holds the whole area');
  assert.equal(got.more, 0);
  // A sliver of a part is not that part.
  assert.deepEqual(partsInArea(regions, { x: 920, y: 700, width: 200, height: 30 }).inside, []);
  assert.equal(partsInArea(regions, { x: 920, y: 700, width: 200, height: 30 }).around?.index, 2, 'a sliver inside news is inside news');
  // Past the most listed, the rest are counted.
  const many = Array.from({ length: 20 }, (_, i) => region(i, [0, i * 10, 100, 10]));
  assert.deepEqual([partsInArea(many, { x: 0, y: 0, width: 100, height: 200 }, 12).inside.length, partsInArea(many, { x: 0, y: 0, width: 100, height: 200 }, 12).more], [12, 8]);
  assert.deepEqual(rectFrom({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 40, height: 60 });
  assert.deepEqual(clampRect({ x: -10, y: 5, width: 50, height: 500 }, 30, 100), { x: 0, y: 5, width: 30, height: 95 });
  assert.equal(clampRect({ x: 40, y: 5, width: 50, height: 5 }, 30, 100), null);
});

test('what made a part: its template and file, block or component, and the module or plugin it comes from', () => {
  const part: TracePart = { id: 'p-hours', kind: 'block', label: 'Opening hours', source: { file: 'web/themes/custom/acme/templates/block--hours.html.twig', line: 3, owner: 'yours', package: 'acme' } };
  assert.equal(partLine(hours, part),
    'Opening hours (block): template web/themes/custom/acme/templates/block--hours.html.twig:3, block block_content:hours@acme_hours, from acme (your code)');
  const plugin: TracePart = { id: 'p-x', kind: 'block', label: 'Testimonial', source: { file: 'wp-content/plugins/northwind-blocks/build/render.php', owner: 'plugin', package: 'northwind-blocks' } };
  assert.match(partLine(region(9, [0, 0, 10, 10], { block: 'northwind/testimonial' }), plugin), /from northwind-blocks \(a plugin\)$/);
  // Without a trace, what the page's marks say.
  assert.match(partLine(region(8, [0, 0, 10, 10], { component: 'acme:hero' }), null, 'Hero'), /^Hero \(.+\): component acme:hero$/);
});

test('the composer’s words for a snap: the address and width, what was pictured, what made it, and the console’s errors', () => {
  const text = snapContext({
    url: 'https://acme.example.test/', viewWidth: 1180, scope: 'area', area: { x: 905, y: 540, width: 290, height: 380 },
    parts: ['Latest news (block): block views_block:news-block_1@acme_news', 'Opening hours (block): template block--hours.html.twig'], more: 0,
    around: 'Sidebar (region): template themes/custom/acme/templates/region--sidebar.html.twig', traced: true,
    errors: ['Uncaught TypeError: menu is null (/themes/custom/acme/js/menu.js:12)'],
  });
  assert.equal(text, [
    'Page: https://acme.example.test/ (the view 1180 px wide)',
    'Pictured: An area of the page, 290 × 380 px at 905, 540 of the page (CSS pixels). The picture is attached, marked up.',
    '',
    'What made it, from the site’s trace:',
    '- Latest news (block): block views_block:news-block_1@acme_news',
    '- Opening hours (block): template block--hours.html.twig',
    'All of it inside: Sidebar (region): template themes/custom/acme/templates/region--sidebar.html.twig',
    '',
    'Console errors on this page:',
    '- Uncaught TypeError: menu is null (/themes/custom/acme/js/menu.js:12)',
  ].join('\n'));
  const bare = snapContext({ url: 'https://acme.example.test/', viewWidth: null, scope: 'page', area: null, parts: [], more: 0, around: null, traced: false, errors: [], cut: true });
  assert.match(bare, /^Page: https:\/\/acme\.example\.test\/\nPictured: The whole page, down to where a picture stops\./);
  assert.match(bare, /Nothing on this page says what made that area\.\n\nThe page logged no console errors\.$/);
});

test('a blur replaces the pixels under it, so none of what was there is left', () => {
  // A 40 × 20 picture of distinct pixels: every value differs from its neighbours.
  const w = 40, h = 20;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = (i * 7) % 256; px[i * 4 + 1] = (i * 13) % 256; px[i * 4 + 2] = (i * 29) % 256; px[i * 4 + 3] = 255; }
  const before = Uint8ClampedArray.from(px);
  const r = { x: 8, y: 4, width: 16, height: 8 };
  const changed = pixelate(px, w, h, r, 8);
  assert.ok(changed > 100);
  // Inside: each 8 × 8 block is one colour, and no original pixel survives in it.
  for (const bx of [8, 16]) {
    const first = ((4 * w) + bx) * 4;
    const colour = [px[first], px[first + 1], px[first + 2]];
    let kept = 0;
    for (let y = 4; y < 12; y++) {
      for (let x = bx; x < bx + 8; x++) {
        const i = (y * w + x) * 4;
        assert.deepEqual([px[i], px[i + 1], px[i + 2]], colour);
        if (px[i] === before[i] && px[i + 1] === before[i + 1] && px[i + 2] === before[i + 2]) kept++;
      }
    }
    assert.ok(kept <= 1, `block at ${bx} kept ${kept} original pixels`);
  }
  // Outside: untouched.
  for (const [x, y] of [[0, 0], [7, 4], [24, 4], [8, 12], [39, 19]] as const) {
    const i = (y * w + x) * 4;
    assert.deepEqual([px[i], px[i + 1], px[i + 2]], [before[i], before[i + 1], before[i + 2]]);
  }
  // About 16 CSS pixels a block, at the picture's scale.
  assert.equal(blurBlock({ x: 0, y: 0, width: 60, height: 20 }, 2), 32);
});
