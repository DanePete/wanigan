import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzzyFind, fuzzyScore, parseQuery } from './fuzzy.ts';

const PATHS = [
  'web/core/modules/system/templates/page.html.twig',
  'web/themes/custom/acme/templates/layout/page.html.twig',
  'web/themes/custom/acme/templates/block/block--hero.html.twig',
  'web/themes/custom/acme/css/hero.css',
  'web/modules/custom/northwind_checkout/css/pay-button.css',
  'web/modules/custom/northwind_checkout/templates/northwind-pay-button.html.twig',
  'web/modules/custom/northwind_checkout/src/Controller/CheckoutController.php',
  'src/checkout/PayButton.tsx',
  'package.json',
];

test('what was typed: the words, and a line after a colon', () => {
  assert.deepEqual(parseQuery('Hero  Twig'), { terms: ['hero', 'twig'], line: null });
  assert.deepEqual(parseQuery('hero.css:42'), { terms: ['hero.css'], line: 42 });
  assert.deepEqual(parseQuery('   '), { terms: [], line: null });
});

test('the file’s own name, the start of words and letters together rank first', () => {
  assert.equal(fuzzyFind('hero tw', PATHS)[0]?.path, 'web/themes/custom/acme/templates/block/block--hero.html.twig');
  assert.equal(fuzzyFind('hero.css', PATHS)[0]?.path, 'web/themes/custom/acme/css/hero.css');
  assert.equal(fuzzyFind('pay css', PATHS)[0]?.path, 'web/modules/custom/northwind_checkout/css/pay-button.css');
  assert.equal(fuzzyFind('chkctl', PATHS)[0]?.path, 'web/modules/custom/northwind_checkout/src/Controller/CheckoutController.php', 'camel case humps count');
  assert.equal(fuzzyFind('PayButton', PATHS)[0]?.path, 'src/checkout/PayButton.tsx');
  // The owner's page template before core's: the same name, but fewer folders deep in the theme is not the point; the theme path matches "acme".
  assert.equal(fuzzyFind('acme page', PATHS)[0]?.path, 'web/themes/custom/acme/templates/layout/page.html.twig');
});

test('a folder typed with a slash is matched along the path', () => {
  const hits = fuzzyFind('checkout/css', PATHS).map((h) => h.path);
  assert.equal(hits[0], 'web/modules/custom/northwind_checkout/css/pay-button.css');
});

test('every letter must be there, in order; the positions are the letters matched', () => {
  assert.equal(fuzzyScore('package.json', ['zz']), null);
  assert.equal(fuzzyScore('package.json', ['nosj']), null, 'order matters');
  const hit = fuzzyScore('package.json', ['pkg']);
  assert.deepEqual(hit?.positions.map((p) => 'package.json'[p]).join(''), 'pkg');
  assert.deepEqual(fuzzyFind('', PATHS, 3).map((h) => h.path), PATHS.slice(0, 3), 'nothing typed: the list as given');
});

test('forty thousand paths, each matching part of what was typed, are ranked in well under a second', () => {
  const many = Array.from({ length: 40_000 }, (_, i) => `web/modules/contrib/module_${i % 400}/src/Plugin/Field/FieldFormatter/Formatter${i}.php`);
  const started = performance.now();
  fuzzyFind('fmtr 3999', many);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
});
