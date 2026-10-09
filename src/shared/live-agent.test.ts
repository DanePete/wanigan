// The rules between an agent's live view tools and the page: which addresses
// may be opened, widths, part ids that survive a reload, finding parts, and
// which edited file explains a changed area. Made-up pages only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acmePage, r } from './live-agent-fixture.ts';
import { cleanRegions, cleanRendered, explainAreas, findParts, liveWidth, partIds, regionById, sitePage } from './live-agent.ts';

const SITE = 'https://acme.ddev.site/';

test('only pages of the project’s own site: a path, or a full address on it; never another host', () => {
  assert.deepEqual(sitePage('/about', SITE), { url: 'https://acme.ddev.site/about' });
  assert.deepEqual(sitePage('about?tab=team', SITE), { url: 'https://acme.ddev.site/about?tab=team' });
  assert.deepEqual(sitePage('https://acme.ddev.site/node/12#top', SITE), { url: 'https://acme.ddev.site/node/12' }, 'the fragment is dropped');
  assert.deepEqual(sitePage('http://acme.ddev.site/contact', SITE), { url: 'https://acme.ddev.site/contact' }, 'http of the same site is the site, opened as the site is');
  for (const bad of ['https://acme.com/', '//northwind.example.test/x', 'javascript:alert(1)', 'https://user:pw@acme.ddev.site/', 'file:///etc/passwd',
    'https://acme.ddev.site.example.test/', '/a\\b', '/a\u0000b', '', 42, null]) {
    const out = sitePage(bad, SITE);
    assert.ok('refused' in out, String(bad));
    assert.match((out as { refused: string }).refused, /Only pages of this project's local site \(https:\/\/acme\.ddev\.site\/\)|cannot be read/);
  }
  assert.deepEqual(sitePage('/../../etc/passwd', SITE), { url: 'https://acme.ddev.site/etc/passwd' }, 'dots stay on the site');
  assert.ok('refused' in sitePage('https://localhost:8443/', 'https://localhost:3000/'), 'another port is another site');
});

test('widths are whole CSS pixels within bounds; none means the owner’s', () => {
  assert.equal(liveWidth(undefined), null);
  assert.equal(liveWidth(null), null);
  assert.equal(liveWidth(375), 375);
  for (const bad of [319, 2561, 375.5, '375', -1]) assert.ok(typeof liveWidth(bad) === 'object', String(bad));
});

test('a part keeps its id on the next load, at another width, and the second teaser stays the second', () => {
  const page = acmePage();
  const ids = partIds(page);
  assert.equal(new Set(ids.values()).size, page.length, 'every part has its own id');
  assert.match(ids.get(4)!, /^hero-[0-9a-z]{4}$/);
  assert.match(ids.get(6)!, /^store-12-[0-9a-z]{4}$/);
  // Narrower: the teasers stack and the scan lists them in another index order, but the page is written the same way.
  const narrow = acmePage().map((x) => ({ ...x, index: 100 - x.index, parent: x.parent === null ? null : 100 - x.parent, rect: { ...x.rect, width: 375 } }));
  const again = partIds(narrow);
  for (const x of page) assert.equal(again.get(100 - x.index), ids.get(x.index), `region ${x.index}`);
  assert.equal(regionById(narrow, ids.get(6)!)?.entity, 'node:store:12:teaser');
  assert.equal(regionById(page, 'nothing-0000'), null);
  // The same template three times is numbered in page order.
  const same = [r(0, null, 'block', 'b.html.twig'), r(1, null, 'block', 'b.html.twig')];
  const twice = [...partIds(same).values()];
  assert.equal(twice[1], `${twice[0]}-2`);
});

test('finding parts: an id, a name, a template or the words they show, smaller parts first', () => {
  const page = acmePage();
  const texts = { 4: 'Welcome to Acme Outdoor gear since 1987', 6: 'Northwind store Open late' };
  const ids = partIds(page);
  assert.equal(findParts(page, texts, ids.get(4)!)[0]?.region.index, 4, 'by id');
  assert.deepEqual(findParts(page, texts, 'hero', (id) => (id === 'acme:hero' ? 'Hero banner' : null)).map((f) => [f.region.index, f.by]), [[4, 'name']]);
  assert.deepEqual(findParts(page, texts, 'node--store--teaser').map((f) => f.region.index), [5, 6, 7], 'by template, in page order');
  assert.deepEqual(findParts(page, texts, 'open late').map((f) => [f.region.index, f.by]), [[6, 'text']]);
  assert.deepEqual(findParts(page, texts, 'branding').map((f) => f.region.index), [3]);
  assert.deepEqual(findParts(page, texts, '   '), []);
});

test('each changed area is explained by the edited file that made a part it overlaps, or said to be unexplained', () => {
  const page = acmePage();
  const areas = [
    { x: 10, y: 200, width: 300, height: 40, pixels: 900 }, // in the hero
    { x: 500, y: 850, width: 100, height: 20, pixels: 120 }, // in the second teaser
    { x: 30, y: 30, width: 50, height: 20, pixels: 60 }, // in the branding block
  ];
  const edited = ['/Users/x/acme/web/themes/custom/acme/components/hero/hero.css', '/Users/x/acme/web/themes/custom/acme/templates/content/node--store--teaser.html.twig'];
  const out = explainAreas(areas, page, edited, [{ id: 'acme:hero', dir: '/Users/x/acme/web/themes/custom/acme/components/hero' }]);
  assert.deepEqual(out[0]!.explainedBy, [edited[0]], 'a file in the component’s folder explains the hero');
  assert.equal(out[0]!.parts[0]!.title, 'Hero');
  assert.deepEqual(out[1]!.explainedBy, [edited[1]], 'the teaser template, matched at a folder boundary');
  assert.equal(out[1]!.parts[0]!.title, 'Store 12');
  assert.deepEqual(out[2]!.explainedBy, [], 'nothing this session edited made the branding block');
  assert.equal(out[2]!.parts[0]!.title, 'Acme branding');
  assert.ok(out.every((e) => e.parts.every((p) => p.title !== 'Document' && p.title !== 'Front page')), 'the page’s wrappers are never named as the part');
  assert.deepEqual(explainAreas(areas, page, ['/Users/x/acme/web/themes/custom/acme/templates/content/xnode--store--teaser.html.twig'])[1]!.explainedBy, [], 'not a suffix of another name');
});

test('what the app answers is bounded and checked before anything reads it', () => {
  const regions = cleanRegions([{ index: 0, file: 'x'.repeat(5000), rect: { x: 1e12, y: 'no', width: -5, height: 10 }, suggestions: ['a', 7, 'b'] }, { index: -1 }, 'junk', null]);
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.file!.length, 300);
  assert.deepEqual(regions[0]!.rect, { x: 1_000_000, y: 0, width: 0, height: 10 });
  assert.deepEqual(regions[0]!.suggestions, ['a', 'b']);
  const page = cleanRendered({ url: SITE, regions: [], texts: { 0: '  a   b  ', x: 'no', 1: 5 }, image: { data: '<script>', width: 10 }, source: 'elsewhere', problems: [{ text: 'boom', source: 'weird' }] });
  assert.deepEqual(page.texts, { 0: 'a b' });
  assert.equal(page.image, null, 'not base64: no picture');
  assert.equal(page.source, 'asked');
  assert.deepEqual(page.problems, [{ level: 'error', text: 'boom', source: 'console' }]);
});
