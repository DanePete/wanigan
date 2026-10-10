// The Studio tokens read at WCAG AA in both themes: every text-on-surface pair
// the spec lists, measured from the stylesheet the window loads.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CONTRAST_PAIRS, measure, parseColour, ratio, shortfalls, themeTokens } from './contrast.ts';

const css = readFileSync(new URL('../renderer/src/styles/tokens.css', import.meta.url), 'utf8');

test('every text-on-surface pair in tokens.css meets WCAG AA, dark and light', () => {
  assert.deepEqual(shortfalls(css), []);
  // Every pair was really measured in both themes, not skipped.
  const measured = measure(css);
  assert.equal(measured.length, CONTRAST_PAIRS.length * 2);
  assert.ok(measured.every((m) => m.ratio !== null));
});

test('a value under AA is caught, and named', () => {
  // The light theme's tertiary text pushed paler: still "grey", no longer readable on the canvas.
  const paler = css.replace(/(:root\[data-theme='light'\][\s\S]*?--faint: )#[0-9A-Fa-f]{6};/, '$1#8D98A4;');
  assert.notEqual(paler, css, 'the light --faint was found to change');
  const short = shortfalls(paler);
  assert.ok(short.some((s) => s.startsWith('light: --faint on --bg-canvas is ')), short.join('\n'));
  assert.ok(short.every((s) => s.startsWith('light: --faint')), 'only the pairs that use the changed token fail');
  // A primary fill too pale for white words fails as the primary button.
  const pale = css.replace(/(:root\[data-theme='light'\][\s\S]*?--water-fill: )#[0-9A-Fa-f]{6};/, '$1#5A9BEA;');
  assert.ok(shortfalls(pale).some((s) => /^light: --water-ink on --water-fill is .*the primary button/.test(s)));
});

test('the light theme inherits what it does not set, and a reference is followed', () => {
  const themes = themeTokens(':root { --a: #000000; --b: var(--a); } :root[data-theme=\'light\'] { --a: #ffffff; } @media (x) { :root { --a: #ff0000; } }');
  assert.equal(themes.dark.get('--a'), '#000000');
  assert.equal(themes.light.get('--a'), '#ffffff');
  assert.equal(themes.light.get('--b'), 'var(--a)');
  assert.deepEqual(parseColour('var(--b)', themes.light), [255, 255, 255, 1]);
  assert.deepEqual(parseColour('rgb(30 111 217 / 0.1)', themes.dark), [30, 111, 217, 0.1]);
  assert.equal(parseColour('var(--missing)', themes.dark), null);
});

test('the ratio is WCAG 2’s: black on white is 21:1, and a colour on itself 1:1', () => {
  assert.equal(Math.round(ratio([0, 0, 0], [255, 255, 255]) * 100) / 100, 21);
  assert.equal(ratio([30, 111, 217], [30, 111, 217]), 1);
});
