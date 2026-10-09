// The component library's contract, read as the main process and the core read
// a helper's answer: what is kept, what is dropped, the requests for pictures,
// and the words an agent gets. Made-up entries (acme, northwind) only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_LIMITS, libraryText, paletteEntryFor, parseLibrary, piecePath, pictureRequest, PICTURES_AT_ONCE, type ComponentLibrary, type LibraryEntry } from './live-library.ts';

const HASH = '0123456789abcdef0123456789abcdef';

const raw = {
  version: 1, platform: 'drupal', hash: HASH, at: 1760000000000, theme: 'acme',
  counts: { component: 2, block: 2 },
  skipped: { 'internal components': 1, junk: 'x' },
  entries: [
    {
      id: 'sdc:acme:card', kind: 'component', label: 'Card', description: 'A card with a heading.', category: 'Content', by: 'acme', owner: 'yours', status: 'stable',
      props: { type: 'object', required: ['heading'], properties: { heading: { type: 'string', examples: ['Spring sale'] }, tone: { type: 'string', enum: ['light', 'dark'] } } },
      required: ['heading'], slots: [{ name: 'footer', title: 'Footer' }, { title: 'no name' }],
      files: ['web/themes/custom/acme/components/card/card.component.yml', '/etc/passwd', 'web/../../secret'],
      picture: { from: 'example', piece: '/_wanigan/piece/component/acme%3Acard?picture=1' },
    },
    { id: 'sdc:acme:card', kind: 'component', label: 'A second card with the same id', picture: { from: 'defaults', piece: '/_wanigan/piece/component/x' } },
    { id: 'sdc:northwind:hero', kind: 'component', label: 'Hero', by: 'northwind', picture: { from: 'example', piece: 'https://elsewhere.example/_wanigan/piece/x' } },
    { id: 'block:system_branding_block', kind: 'block', label: 'Site branding', category: 'System', by: 'system', owner: 'core', picture: { from: 'settings', piece: '/_wanigan/piece/plugin/system_branding_block?picture=1' } },
    { id: 'block:field_block:node:article:body', kind: 'block', label: 'Body', needs: ['entity:node'], picture: { from: 'none', why: 'It shows the node of the page it is placed on.' } },
    { id: 'sdc:acme:sneaky', kind: 'component', label: 'Climbs', picture: { from: 'example', piece: '/_wanigan/piece/../../user/logout' } },
    { id: 'has space', kind: 'component', label: 'x', picture: { from: 'none', why: 'x' } },
    { id: 'pattern:acme/x', kind: 'gadget', label: 'Not a kind', picture: { from: 'none', why: 'x' } },
  ],
};

test('a well-formed library is kept; what is malformed is dropped, not repaired', () => {
  const lib = parseLibrary(raw);
  assert.ok(lib);
  assert.deepEqual(lib.entries.map((e) => e.id), ['sdc:acme:card', 'sdc:northwind:hero', 'block:system_branding_block', 'block:field_block:node:article:body', 'sdc:acme:sneaky'], 'a repeated id keeps its first; an id with a space and an unknown kind are dropped');
  const card = lib.entries[0]!;
  assert.deepEqual(card.files, ['web/themes/custom/acme/components/card/card.component.yml'], 'an absolute or climbing file is dropped');
  assert.deepEqual(card.slots, [{ name: 'footer', title: 'Footer' }], 'a slot needs a name');
  assert.deepEqual(card.required, ['heading']);
  assert.equal((card.props as { properties: Record<string, unknown> }).properties.heading !== undefined, true);
  assert.deepEqual(card.picture, { from: 'example', piece: '/_wanigan/piece/component/acme%3Acard?picture=1' });
  assert.equal(lib.entries[1]!.picture.from, 'none', 'a piece on another origin is not one of the helper’s routes');
  assert.equal(lib.entries[4]!.picture.from, 'none', 'nor one that climbs out of it');
  assert.deepEqual(lib.entries[3]!.needs, ['entity:node']);
  assert.deepEqual(lib.skipped, { 'internal components': 1 });
  assert.deepEqual(lib.counts, { component: 2, block: 2 });
  assert.equal(lib.truncated, undefined);
  assert.equal(lib.theme, 'acme');
});

test('what is not a library is refused', () => {
  assert.equal(parseLibrary(null), null);
  assert.equal(parseLibrary({ ...raw, version: 2 }), null);
  assert.equal(parseLibrary({ ...raw, platform: 'joomla' }), null);
  assert.equal(parseLibrary({ ...raw, hash: 'not-hex' }), null);
  assert.equal(parseLibrary({ ...raw, entries: 'x' }), null);
});

test('a schema past its bound is left out, and a long list is cut and said to be', () => {
  const huge = { type: 'object', properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`p${i}`, { type: 'string', description: 'x'.repeat(10) }])) };
  const lib = parseLibrary({ ...raw, entries: [{ id: 'sdc:acme:huge', kind: 'component', label: 'Huge', props: huge, picture: { from: 'defaults', piece: '/_wanigan/piece/component/acme%3Ahuge' } }] });
  assert.equal(lib?.entries[0]?.props, undefined);
  const many = Array.from({ length: LIBRARY_LIMITS.entries + 3 }, (_, i) => ({ id: `block:b${i}`, kind: 'block', label: `B${i}`, picture: { from: 'none', why: 'x' } }));
  const cut = parseLibrary({ ...raw, entries: many });
  assert.equal(cut?.entries.length, LIBRARY_LIMITS.entries);
  assert.equal(cut?.truncated, true);
});

test('a piece is only ever a path of the helper’s own route on the site', () => {
  assert.equal(piecePath('/_wanigan/piece/library?entry=block%3Acore%2Fparagraph'), '/_wanigan/piece/library?entry=block%3Acore%2Fparagraph');
  assert.equal(piecePath('/_wanigan/piece/plugin/system_branding_block?picture=1'), '/_wanigan/piece/plugin/system_branding_block?picture=1');
  for (const bad of ['/_wanigan/trace/0123', '//elsewhere.example/_wanigan/piece/x', '/_wanigan/piece//x', '/_wanigan/piece/%2e%2e/admin', '/_wanigan/piece/a/../../b', '/_wanigan/piece/<script>', 42, '']) {
    assert.equal(piecePath(bad), null, String(bad));
  }
});

test('pictures are asked for known widths, a bounded number of plain entry ids at a time', () => {
  assert.deepEqual(pictureRequest(['sdc:acme:card', 'sdc:acme:card', 'block:x'], undefined), { entries: ['sdc:acme:card', 'block:x'], widths: [390, 1440] });
  assert.deepEqual(pictureRequest(['sdc:acme:card'], [1440, 777]), { entries: ['sdc:acme:card'], widths: [1440] });
  assert.equal(typeof pictureRequest(['sdc:acme:card'], [777]), 'string', 'no width this keeps pictures at');
  assert.equal(typeof pictureRequest([], undefined), 'string');
  assert.equal(typeof pictureRequest(['has space'], undefined), 'string');
  assert.equal(typeof pictureRequest(Array.from({ length: PICTURES_AT_ONCE + 1 }, (_, i) => `block:b${i}`), undefined), 'string');
});

test('an agent reads the library counted by kind, narrowed by words or kind, or one entry in full', () => {
  const lib = parseLibrary(raw) as ComponentLibrary;
  const all = libraryText(lib);
  assert.match(all.text, /^What this Drupal site can place, as its core lists it \(pieces render in the acme theme\): 2 components, 2 blocks\.$/m);
  assert.match(all.text, /^- sdc:acme:card — Card \(acme, yours\): A card with a heading\. \[props: heading\*, tone; slots: footer\]$/m);
  assert.match(all.text, /^- block:field_block:node:article:body — Body \[needs entity:node\]$/m);
  assert.match(all.text, /^Left out: 1 internal components\.$/m);
  assert.equal(all.said, '2 components, 2 blocks');
  const cards = libraryText(lib, { query: 'card heading' });
  assert.deepEqual((cards.structured.entries as { id: string }[]).map((e) => e.id), ['sdc:acme:card'], 'every word must match');
  assert.match(cards.said, /^1 of 5 entries for “card heading”$/);
  const blocks = libraryText(lib, { kind: 'block' });
  assert.deepEqual((blocks.structured.entries as { id: string }[]).map((e) => e.id), ['block:system_branding_block', 'block:field_block:node:article:body']);
  const one = libraryText(lib, { entry: 'sdc:acme:card' });
  assert.match(one.text, /^Card \(sdc:acme:card\), a component from acme, the project’s own, stable\.$/m);
  assert.match(one.text, /"examples": \[\n\s+"Spring sale"/, 'the props schema in full');
  assert.match(one.text, /^Pictured alone at \/_wanigan\/piece\/component\/acme%3Acard\?picture=1 \(from its example\)\.$/m);
  const none = libraryText(lib, { entry: 'sdc:acme:cards' });
  assert.match(none.text, /No entry has the id sdc:acme:cards\. Close: sdc:acme:card, /, 'the closest first');
  assert.equal(none.structured.entry, null);
});

test('a library entry is placed through the trace palette entry its helper names for it, or says why it cannot be', () => {
  const e = (id: string, kind: LibraryEntry['kind']): LibraryEntry => ({ id, kind, label: id, picture: { from: 'none', why: 'x' } });
  assert.deepEqual(paletteEntryFor(e('block:system_branding_block', 'block'), 'drupal'), { id: 'pal.b.system_branding_block' });
  assert.match((paletteEntryFor(e('sdc:acme:card', 'component'), 'drupal') as { why: string }).why, /inside a template or a field/);
  assert.deepEqual(paletteEntryFor(e('block:core/paragraph', 'block'), 'wordpress'), { id: 'block:core/paragraph' });
  assert.deepEqual(paletteEntryFor(e('pattern:acme/hero', 'pattern'), 'wordpress'), { id: 'pattern:acme/hero' });
  assert.match((paletteEntryFor(e('style:core/button:outline', 'style'), 'wordpress') as { why: string }).why, /how a block looks/);
});
