// The site's own colours, checked as untrusted and ranked: a declared palette by origin, theme tokens by name, and the
// colours a page uses merged perceptually and ranked by how much of the page each covers. Made-up colours only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MERGE_DISTANCE, SITE_COLOUR_LIMITS, colourShaped, oklabOf, parseSitePalette, rankUsed, siteColoursOf, srgbOf, themeTokens, usedWords,
} from './site-colours.ts';

test('a value is a colour by its shape: hex, colour functions and names, never a keyword, a length or a way out of a rule', () => {
  for (const ok of ['#1d2a3a', '#abc', '#1d2a3a80', 'rgb(59, 130, 196)', 'rgb(59 130 196 / 50%)', 'oklch(62% 0.14 150)', 'color(srgb 0.1 0.2 0.3)', 'white']) assert.ok(colourShaped(ok), ok);
  for (const no of ['transparent', 'currentcolor', 'inherit', '16px', '', 'red; } body { display: none', 'rgb(0 0 0 / url(x))', 'url(https://example.test/x.png)', 42, null]) assert.ok(!colourShaped(no), String(no));
});

test('WordPress’s palette is read by origin, each written as the preset’s custom property; a slug in two origins is the last origin’s, as core prints it', () => {
  const answer = parseSitePalette({
    version: 1, platform: 'wordpress',
    palette: [
      { slug: 'black', name: 'Black', color: '#000000', origin: 'default' },
      { slug: 'pine', name: 'Pine', color: '#2f5d50', origin: 'theme' },
      { slug: 'black', name: 'Ink', color: '#14181c', origin: 'theme' },
      { slug: 'sand', name: '', color: 'rgb(231, 220, 196)', origin: 'custom' },
      { slug: 'Bad Slug', name: 'No', color: '#123456', origin: 'theme' },
      { slug: 'clear', name: 'Clear', color: 'transparent', origin: 'theme' },
      { slug: 'mixed', name: 'Mixed', color: 'color-mix(in srgb, red, blue)', origin: 'theme' },
      { slug: 'sky', name: 'Sky', color: '#3b82c4', origin: 'blocks' },
      { slug: 'evil', name: 'Evil', color: 'red; } body {', origin: 'theme' },
    ],
    notYet: [{ id: 'acme-builder', name: 'Acme Builder', why: 'Its global colours are not read yet.' }, { id: 'Bad Id', name: 'x', why: 'y' }],
  });
  assert.ok(answer && answer.state === 'ok');
  assert.deepEqual(answer.colours, [
    { slug: 'black', name: 'Ink', value: '#14181c', origin: 'theme', ref: '--wp--preset--color--black' },
    { slug: 'pine', name: 'Pine', value: '#2f5d50', origin: 'theme', ref: '--wp--preset--color--pine' },
    { slug: 'sand', name: null, value: 'rgb(231, 220, 196)', origin: 'custom', ref: '--wp--preset--color--sand' },
  ], 'a slug core would not print, a colour that is not one, an origin outside the palette’s three and anything the layer refuses are left out; no name is made up');
  assert.deepEqual(answer.notYet, [{ id: 'acme-builder', name: 'Acme Builder', why: 'Its global colours are not read yet.' }]);
  for (const no of [null, {}, { version: 2, platform: 'wordpress', palette: [] }, { version: 1, platform: 'drupal', palette: [] }, 'palette']) assert.equal(parseSitePalette(no), null, JSON.stringify(no));
  const many = { version: 1, platform: 'wordpress', palette: Array.from({ length: 300 }, (_, i) => ({ slug: `c${i}`, name: `C${i}`, color: '#123456', origin: 'theme' })) };
  const big = parseSitePalette(many);
  assert.equal(big?.state === 'ok' ? big.colours.length : 0, SITE_COLOUR_LIMITS.palette);
});

test('theme tokens are custom properties that hold a colour, each name once, Wanigan’s own left out, said where each is set', () => {
  assert.deepEqual(themeTokens([
    { name: '--ns-pine', value: '#2f5d50', on: 'root' },
    { name: '--ns-gap', value: '16px', on: 'root' },
    { name: '--ns-pine', value: '#000000', on: 'body' },
    { name: '--ns-paper', value: ' rgb(247, 244, 238) ', on: 'body' },
    { name: '--ns-card', value: '#ffffff', on: 'container' },
    { name: '--ns-odd', value: '#ffffff', on: 'elsewhere' },
    { name: '--wl-try-color', value: '#c0392b', on: 'root' },
    { name: 'color', value: '#111111', on: 'root' },
    { name: '--ns-clear', value: 'transparent', on: 'root' },
  ]), [
    { name: '--ns-pine', value: '#2f5d50', on: 'root' },
    { name: '--ns-paper', value: 'rgb(247, 244, 238)', on: 'body' },
    { name: '--ns-card', value: '#ffffff', on: 'container' },
    { name: '--ns-odd', value: '#ffffff', on: 'root' },
  ]);
  assert.deepEqual(themeTokens('not a list'), []);
  assert.equal(themeTokens(Array.from({ length: 100 }, (_, i) => ({ name: `--t${i}`, value: '#123456', on: 'root' }))).length, SITE_COLOUR_LIMITS.tokens);
});

test('computed colours are read as sRGB from the forms a browser writes, and OKLab measures how different two look', () => {
  assert.deepEqual(srgbOf('rgb(255, 0, 0)'), { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(srgbOf('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(srgbOf('rgb(0 0 0 / 0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(srgbOf('#fff'), { r: 1, g: 1, b: 1, a: 1 });
  assert.deepEqual(srgbOf('color(srgb 1 0 0 / 0.5)'), { r: 1, g: 0, b: 0, a: 0.5 });
  assert.equal(srgbOf('oklch(62% 0.14 150)'), null, 'a form it cannot convert is not guessed at');
  assert.equal(srgbOf('rgb(300, 0, 0)'), null);
  const [L] = oklabOf({ r: 1, g: 1, b: 1 });
  assert.ok(Math.abs(L - 1) < 1e-3, 'white is L 1');
  const d = (a: string, b: string): number => { const x = oklabOf(srgbOf(a)!), y = oklabOf(srgbOf(b)!); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  assert.ok(d('rgb(29, 42, 58)', 'rgb(30, 43, 59)') < MERGE_DISTANCE, 'one step apart looks the same');
  assert.ok(d('rgb(29, 42, 58)', 'rgb(47, 93, 80)') > MERGE_DISTANCE, 'ink and pine do not');
});

test('the colours a page uses are merged where they look the same, the transparent left out, and ranked by how much of the page each covers', () => {
  const used = rankUsed([
    { value: 'rgb(247, 244, 238)', as: 'background', weight: 900_000, elements: 1 },
    { value: 'rgb(29, 42, 58)', as: 'text', weight: 40_000, elements: 30 },
    { value: 'rgb(30, 43, 59)', as: 'text', weight: 5_000, elements: 4 },
    { value: 'rgb(29, 42, 58)', as: 'border', weight: 2_000, elements: 6 },
    { value: 'rgb(47, 93, 80)', as: 'background', weight: 60_000, elements: 3 },
    { value: 'rgba(0, 0, 0, 0)', as: 'background', weight: 2_000_000, elements: 400 },
    { value: 'rgba(29, 42, 58, 0.5)', as: 'border', weight: 1_000, elements: 2 },
    { value: 'oklch(62% 0.14 150)', as: 'text', weight: 3_000, elements: 1 },
    { value: 'oklch(62% 0.14 150)', as: 'text', weight: 1_000, elements: 1 },
    { value: '16px', as: 'text', weight: 99_000_000, elements: 1 },
    { value: 'rgb(1, 2, 3)', as: 'shadow', weight: 99_000_000, elements: 1 },
    { value: 'rgb(1, 2, 3)', as: 'text', weight: 0, elements: 1 },
  ]);
  assert.deepEqual(used.map((u) => [u.value, u.as, u.elements]), [
    ['rgb(247, 244, 238)', ['background'], 1],
    ['rgb(47, 93, 80)', ['background'], 3],
    ['rgb(29, 42, 58)', ['text', 'border'], 40],
    ['oklch(62% 0.14 150)', ['text'], 2],
    ['rgba(29, 42, 58, 0.5)', ['border'], 2],
  ], 'near-identical ink merged into the heaviest, its uses and elements added; half-transparent ink kept apart; a form it cannot read merged only with the same value');
  const total = 900_000 + 60_000 + 47_000 + 4_000 + 1_000;
  assert.ok(Math.abs((used[0]?.share ?? 0) - 900_000 / total) < 1e-9);
  assert.equal(usedWords(used[2]!), 'text and border, on 40 elements');
  assert.equal(usedWords(used[0]!), 'background, on 1 element');
  const lots = Array.from({ length: 40 }, (_, i) => ({ value: `rgb(${i * 6}, ${255 - i * 6}, 128)`, as: 'background', weight: 1000 - i, elements: 1 }));
  assert.equal(rankUsed(lots).length, SITE_COLOUR_LIMITS.used, 'a short list');
  assert.deepEqual(rankUsed('not a list'), []);
});

test('together: a token that is a palette entry’s own custom property is shown once, as the palette’s', () => {
  const palette = parseSitePalette({ version: 1, platform: 'wordpress', palette: [{ slug: 'pine', name: 'Pine', color: '#2f5d50', origin: 'theme' }] })!;
  const got = siteColoursOf({
    tokens: [{ name: '--wp--preset--color--pine', value: '#2f5d50', on: 'root' }, { name: '--ns-accent', value: '#e0a526', on: 'root' }],
    used: [{ value: 'rgb(47, 93, 80)', as: 'text', weight: 10, elements: 1 }],
  }, palette);
  assert.deepEqual(got.tokens.map((t) => t.name), ['--ns-accent']);
  assert.equal(got.used.length, 1);
  assert.deepEqual(siteColoursOf(null, { state: 'none', platform: 'drupal' }), { palette: { state: 'none', platform: 'drupal' }, tokens: [], used: [] });
});
