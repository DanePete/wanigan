import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FindItem } from './live-find.ts';
import {
  HALF_LIFE_MS, MAX_VISITS, addressOf, directJump, editDistance, frecency, frecencyBoost, groupRanked, guessKind, hereItem,
  idsFromClasses, idsFromPath, kindGroup, matchItem, prepare, rank, readVisits, remember, withoutNoise, type Visit,
} from './live-goto.ts';

// A made-up site: Acme's pages, admin and structure, as a helper would list them.
const ACME: FindItem[] = [
  { id: 'route:system.admin_content', kind: 'admin', label: 'Content', url: '/admin/content', trail: ['Content'] },
  { id: 'route:entity.node_type.collection', kind: 'structure', label: 'Content types', url: '/admin/structure/types', trail: ['Structure', 'Content types'], tags: ['bundles'] },
  { id: 'route:entity.taxonomy_vocabulary.collection', kind: 'structure', label: 'Taxonomy', url: '/admin/structure/taxonomy', trail: ['Structure', 'Taxonomy'], tags: ['vocabularies', 'terms'] },
  { id: 'route:system.site_information_settings', kind: 'setting', label: 'Basic site settings', url: '/admin/config/system/site-information', trail: ['Configuration', 'System'], tags: ['site name', 'front page'] },
  { id: 'route:system.performance_settings', kind: 'setting', label: 'Performance', url: '/admin/config/development/performance', trail: ['Configuration', 'Development'], tags: ['cache', 'aggregation'] },
  { id: 'node:12', kind: 'content', label: 'Spring open house', url: '/events/spring-open-house', type: 'Event', status: 'published', edit: '/node/12/edit',
    actions: [{ label: 'Layout', url: '/node/12/layout' }, { label: 'Revisions', url: '/node/12/revisions' }] },
  { id: 'node:7', kind: 'content', label: 'About Acme', url: '/about', type: 'Basic page', status: 'published', edit: '/node/7/edit' },
  { id: 'node:31', kind: 'content', label: 'Careers at Acme', url: '/careers', type: 'Basic page', status: 'draft', edit: '/node/31/edit', tags: ['jobs'] },
  { id: 'template:page--front', kind: 'template', label: 'page--front.html.twig', url: '/admin/appearance', tags: ['front page'] },
];

const prepared = new Map(ACME.map((i) => [i, prepare(i)]));
const opts = (visits: Visit[] = [], now = 1_800_000_000_000) => ({
  prepared: (i: FindItem) => prepared.get(i) ?? prepare(i),
  visits: new Map(visits.map((v) => [v.id, v])),
  now,
});
const labels = (q: string, visits: Visit[] = [], now?: number): string[] => rank(ACME, q, opts(visits, now)).map((r) => r.item.label);

test('a label match ranks above a match on the words it goes by', () => {
  // "front" is in Basic site settings' tags and in the template's label: the label wins.
  assert.equal(labels('front')[0], 'page--front.html.twig');
  // "jobs" is only a tag: it still finds Careers.
  assert.deepEqual(labels('jobs'), ['Careers at Acme']);
  const m = matchItem('jobs', prepare(ACME[7] as FindItem));
  assert.deepEqual(m?.via, { field: 'tags', text: 'jobs' });
});

test('word starts and acronyms score high; letters in the middle of a word less', () => {
  const q = (query: string, label: string): number => matchItem(query, prepare({ label, url: '/x' }))?.quality ?? 0;
  assert.ok(q('types', 'Content types') > q('ntent', 'Content types'), 'a word start beats the middle of a word');
  assert.ok(q('ct', 'Content types') > 70, 'an acronym is a strong match');
  assert.equal(labels('ct')[0], 'Content types');
  assert.equal(labels('bss')[0], 'Basic site settings');
  assert.ok(q('content', 'Content') > q('content', 'Content types'), 'exact beats prefix');
  // Every word of the query must match: "acme careers" is Careers at Acme, not About Acme.
  assert.deepEqual(labels('acme careers'), ['Careers at Acme']);
});

test('a typo or two is forgiven, but not noise', () => {
  assert.equal(labels('perfromance')[0], 'Performance', 'a swapped pair of letters');
  assert.equal(labels('taxonmy')[0], 'Taxonomy', 'a missing letter');
  assert.deepEqual(labels('zzqx'), []);
  assert.equal(editDistance('artcile', 'article'), 1);
  assert.equal(editDistance('kitten', 'sitting', 2), 3);
});

test('accents and case are ignored, and matched letters are given for showing', () => {
  const m = matchItem('cafe', prepare({ label: 'Café menu', url: '/cafe' }));
  assert.ok(m && m.quality >= 90);
  assert.deepEqual(m?.positions, [0, 1, 2, 3]);
  const t = matchItem('types', prepare({ label: 'Content types', url: '/x' }));
  assert.deepEqual(t?.positions, [8, 9, 10, 11, 12]);
});

test('once something matches well, scattered letters elsewhere are left out', () => {
  const all = rank(ACME, 'cont', opts());
  assert.ok(all.some((r) => r.item.label === 'Performance'), '"cont" is strewn through Configuration in its trail');
  assert.deepEqual(withoutNoise(all).map((r) => r.item.label), ['Content', 'Content types']);
  // With nothing good, the weak are all there is, and are kept.
  const weak = rank(ACME, 'cnfg', opts());
  assert.equal(withoutNoise(weak).length, weak.length);
});

test('trail and path match too, below the label', () => {
  // "structure" is in the trail of Content types and Taxonomy, and in their paths, never a label.
  assert.deepEqual(new Set(labels('structure')), new Set(['Content types', 'Taxonomy']));
  assert.equal(labels('site-information')[0], 'Basic site settings');
});

test('frecency: how often and how lately each was chosen lifts it, and it decays', () => {
  const now = 1_800_000_000_000;
  let visits: Visit[] = [];
  for (let i = 0; i < 4; i++) visits = remember(visits, { id: 'node:7', label: 'About Acme', url: '/about', kind: 'content' }, now - i * 1000);
  // "a" matches About Acme, Careers at Acme, Content… About Acme, chosen four times, comes first.
  assert.equal(labels('ac', visits, now)[0], 'About Acme');
  const v = visits[0] as Visit;
  assert.equal(v.count, 4);
  assert.ok(Math.abs(frecency(v, now) - 4) < 0.01);
  assert.ok(Math.abs(frecency(v, now + HALF_LIFE_MS) - 2) < 0.01, 'half after a week');
  assert.ok(frecencyBoost(frecency(v, now)) <= 24, 'never more than a class of match');
  assert.ok(frecencyBoost(0) === 0);
  // A strong label match still beats a weak favourite: "perf" is Performance, whatever was chosen before.
  assert.equal(labels('perf', visits, now)[0], 'Performance');
});

test('the visit list keeps the most used when it is full, and reads back only what is well formed', () => {
  const now = 1_800_000_000_000;
  let visits: Visit[] = [];
  for (let i = 0; i < MAX_VISITS + 20; i++) visits = remember(visits, { id: `node:${i}`, label: `Page ${i}`, url: `/p/${i}`, kind: 'content' }, now + i);
  visits = remember(visits, { id: 'node:0', label: 'Page 0', url: '/p/0', kind: 'content' }, now + 500);
  assert.equal(visits.length, MAX_VISITS);
  assert.ok(visits.some((v) => v.id === 'node:0'), 'chosen twice is kept');
  const read = readVisits([...visits.slice(0, 2), { id: 'x', label: 'Elsewhere', url: 'https://elsewhere.example/', count: 1, last: 1 }, null, 'nope']);
  assert.equal(read.length, 2);
  assert.deepEqual(readVisits('not a list'), []);
});

test('a path or an id jumps straight there', () => {
  assert.deepEqual(directJump('/about', 'drupal', null), { url: '/about', why: 'a path', ids: [] });
  assert.deepEqual(directJump('12', 'drupal', null), { url: '/node/12', why: 'node 12', ids: ['node:12'] });
  assert.deepEqual(directJump('44', 'wordpress', null), { url: '/?p=44', why: 'post 44', ids: ['post:44', 'page:44'] });
  assert.equal(directJump('44', 'site', null), null, 'a plain site has no ids');
  assert.deepEqual(directJump('node/12', 'drupal', null), { url: '/node/12', why: 'node 12', ids: ['node:12'] });
  assert.equal(directJump('node/12/edit', 'drupal', null)?.url, '/node/12/edit');
  assert.deepEqual(directJump('taxonomy/term/5', 'drupal', null)?.ids, ['taxonomy_term:5', 'term:5']);
  assert.deepEqual(directJump('?p=44', 'wordpress', null), { url: '/?p=44', why: 'post 44', ids: ['post:44', 'page:44'] });
  assert.equal(directJump('page_id=7', 'wordpress', null)?.url, '/?page_id=7');
  assert.equal(directJump('admin/content', 'drupal', null)?.url, '/admin/content');
  assert.equal(directJump('https://acme.example.test/about?x=1', 'drupal', 'https://acme.example.test')?.url, '/about?x=1');
  assert.equal(directJump('/node/12', 'drupal', null)?.ids[0], 'node:12');
});

test('words are searched, not jumped to; another site and odd paths are refused', () => {
  for (const words of ['about', 'content types', 'spring open house', '']) assert.equal(directJump(words, 'drupal', 'https://acme.example.test'), null, words);
  assert.equal(directJump('https://elsewhere.example/about', 'drupal', 'https://acme.example.test'), null);
  assert.equal(directJump('//elsewhere.example/x', 'drupal', null), null);
  assert.equal(directJump('/\\elsewhere.example', 'drupal', null), null);
  assert.equal(directJump('javascript:alert(1)', 'drupal', null), null);
});

test('the page shown is found by the entity it names, its address, or its edit form', () => {
  const here = (path: string, ids: string[] = [], paths: string[] = []) => ({ path, title: '', heading: null, ids, paths });
  assert.equal(hereItem(ACME, here('/events/spring-open-house'))?.id, 'node:12');
  assert.equal(hereItem(ACME, here('/events/spring-open-house/'))?.id, 'node:12', 'a trailing slash is the same page');
  assert.equal(hereItem(ACME, here('/some-alias', ['node:12']))?.id, 'node:12');
  assert.equal(hereItem(ACME, here('/x', [], ['/about']))?.id, 'node:7', 'by its canonical address');
  assert.equal(hereItem(ACME, here('/node/12/edit'))?.id, 'node:12', 'its edit form');
  assert.equal(hereItem(ACME, here('/node/12/revisions'))?.id, 'node:12', 'one of its tasks');
  assert.equal(hereItem(ACME, here('/nowhere')), null);
  assert.equal(hereItem(ACME, null), null);
  assert.deepEqual(idsFromPath('/node/12/edit'), ['node:12']);
  assert.deepEqual(idsFromPath('/?p=44'), ['post:44', 'page:44']);
  assert.deepEqual(idsFromPath('/wp-admin/post.php?post=44&action=edit'), ['post:44', 'page:44']);
  assert.deepEqual(idsFromPath('/blog?p=44'), [], 'only WordPress’s own front controller');
  assert.deepEqual(idsFromClasses(['home', 'postid-44', 'page-id-7']), ['post:44', 'page:44', 'post:7', 'page:7']);
});

test('results are grouped by kind, the group with the best result first, each cut to its limit', () => {
  assert.equal(kindGroup('term'), 'Content');
  assert.equal(kindGroup('view'), 'Structure');
  assert.equal(kindGroup('setting'), 'Settings');
  const ranked = rank(ACME, 'c', opts());
  const groups = groupRanked(ranked, (r) => kindGroup(r.item.kind));
  assert.equal(groups[0]?.rows[0], ranked[0], 'the best result is the first row of the first group');
  for (const g of groups) for (let i = 1; i < g.rows.length; i++) assert.ok((g.rows[i - 1]?.score ?? 0) >= (g.rows[i]?.score ?? 0));
  const many: FindItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `node:${i}`, kind: 'content', label: `News item ${i}`, url: `/news/${i}` }));
  const g = groupRanked(rank(many, 'news', { prepared: prepare, visits: new Map(), now: 0 }), (r) => kindGroup(r.item.kind));
  assert.equal(g[0]?.rows.length, 8);
  assert.equal(g[0]?.more, 4);
});

test('a path without a kind is admin under the admin, a page elsewhere; addresses stay on the site', () => {
  assert.equal(guessKind('/admin/structure'), 'admin');
  assert.equal(guessKind('/wp-admin/edit.php'), 'admin');
  assert.equal(guessKind('/administrators'), 'content');
  assert.equal(guessKind('/about'), 'content');
  assert.equal(addressOf('https://acme.example.test', '/about'), 'https://acme.example.test/about');
  assert.equal(addressOf('https://acme.example.test', '//elsewhere.example'), null);
  assert.equal(addressOf(null, '/about'), null);
});
