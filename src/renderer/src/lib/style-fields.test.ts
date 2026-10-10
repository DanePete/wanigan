// Try a style's fields as numbers and words: ranges that widen and never clamp, steps with and without Shift, a
// weight's names, colours typed as hex or rgb(), and previews sent at most once a frame with the last always sent.
// Made-up values only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LENGTHS, allowed, anchorOf, colourText, colourValue, cssOf, fmt, fraction, hexOf, isClear, numberOf, previewPump, rangeOf, snap, stepped, swatchOf,
  typedNumber, valueText, varName, weightName, type LengthSpec, type PreviewSpec,
} from './style-fields.ts';

const size = LENGTHS['font-size'] as LengthSpec;
const spacing = LENGTHS['letter-spacing'] as LengthSpec;
const padding = LENGTHS['padding-top'] as LengthSpec;
const margin = LENGTHS['margin-top'] as LengthSpec;
const weight = LENGTHS['font-weight'] as LengthSpec;

test('every length the form offers has a sensible range: text size about 8–96, padding and margins 0–160, corners 0–48, gap 0–96, letter spacing below zero in half steps', () => {
  assert.deepEqual([size.min, size.max], [8, 96]);
  for (const p of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'] as const) {
    assert.deepEqual([LENGTHS[p]?.min, LENGTHS[p]?.max, LENGTHS[p]?.unit], [0, 160, 'px'], p);
  }
  assert.deepEqual([LENGTHS['border-radius']?.min, LENGTHS['border-radius']?.max], [0, 48]);
  assert.deepEqual([LENGTHS.gap?.min, LENGTHS.gap?.max], [0, 96]);
  assert.ok(spacing.min < 0 && spacing.step === 0.5);
  assert.equal(padding.floor, 0, 'a padding is never negative');
  assert.equal(margin.floor, null, 'a margin can be');
});

test('a value past the range widens it, never clamps it', () => {
  assert.deepEqual(rangeOf(size, 16, 16), { min: 8, max: 96 });
  assert.deepEqual(rangeOf(size, 120, 16), { min: 8, max: 120 }, 'the site’s 120px fits');
  assert.deepEqual(rangeOf(size, 16, 4), { min: 4, max: 96 }, 'a value typed below the range moves its start');
  assert.deepEqual(rangeOf(margin, -24, null), { min: -24, max: 160 }, 'a negative margin fits');
  assert.deepEqual(rangeOf(weight, 900, 400), { min: 300, max: 900 }, 'a Black weight fits');
  assert.equal(fraction(16, { min: 8, max: 96 }), 8 / 88);
  assert.equal(fraction(200, { min: 8, max: 96 }), 1);
  assert.equal(fraction(5, { min: 5, max: 5 }), 0);
});

test('computed values read as numbers of the field’s unit; a keyword, a percentage or a list is not one', () => {
  assert.equal(numberOf('16px', size), 16);
  assert.equal(numberOf('-0.5px', spacing), -0.5);
  assert.equal(numberOf('0', padding), 0);
  assert.equal(numberOf('600', weight), 600);
  for (const no of ['normal', 'auto', '50%', '8px 0px', '16', '', undefined]) assert.equal(numberOf(no, size), null, String(no));
  assert.equal(cssOf(22, size), '22px');
  assert.equal(cssOf(600, weight), '600');
  assert.equal(fmt(15.199999), '15.2');
  assert.equal(fmt(-0), '0');
});

test('the keyboard steps by the property’s step, ten with Shift, onto the grid from a value off it, never below the floor', () => {
  assert.equal(stepped(16, 1, false, size), 17);
  assert.equal(stepped(16, 1, true, size), 26);
  assert.equal(stepped(16, -1, true, size), 6);
  assert.equal(stepped(15.2, 1, false, size), 16, 'the site’s 15.2px steps up onto the grid');
  assert.equal(stepped(15.2, -1, false, size), 15);
  assert.equal(stepped(0, 1, false, spacing), 0.5, 'half steps');
  assert.equal(stepped(0, -1, true, spacing), -5, 'ten half steps down, below zero');
  assert.equal(stepped(4, -1, true, padding), 0, 'a padding stops at zero');
  assert.equal(stepped(-4, -1, true, margin), -14, 'a margin goes on below');
  assert.equal(stepped(600, 1, true, weight), 700, 'a weight steps by a hundred, Shift or not');
  assert.equal(stepped(450, -1, false, weight), 400);
  assert.equal(stepped(1000, 1, false, weight), 1000, 'no weight past 1000');
  assert.equal(snap(15.4, size), 15);
  assert.equal(snap(0.74, spacing), 0.5);
  assert.equal(snap(640, weight), 600);
});

test('a box takes a number with its unit or without; while it is not one yet, nothing is sent', () => {
  assert.equal(typedNumber('22', size), 22);
  assert.equal(typedNumber(' 22px ', size), 22);
  assert.equal(typedNumber('-1.5', spacing), -1.5);
  for (const partial of ['', '-', '1.', 'abc', '22em']) assert.equal(typedNumber(partial, size), null, partial);
  assert.equal(typedNumber('600px', weight), null, 'a weight has no unit');
  assert.equal(allowed(-2, padding), false);
  assert.equal(allowed(-2, margin), true);
  assert.equal(allowed(0, size), false, 'no text at size 0');
  assert.equal(allowed(1200, weight), false);
});

test('a weight is said by its name, and a slider says its value and unit', () => {
  assert.deepEqual([300, 400, 500, 600, 700, 800].map(weightName), ['Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Extra bold']);
  assert.equal(weightName(450), null);
  assert.equal(valueText(600, weight, null), 'Semibold, 600');
  assert.equal(valueText(450, weight, null), '450');
  assert.equal(valueText(16, size, null), '16 px');
  assert.equal(valueText(null, spacing, 'normal'), 'normal, the site’s');
});

test('a keyword is where a slider starts only where it means a number: normal spacing is none, normal line height near 1.2 of the text', () => {
  assert.equal(anchorOf('letter-spacing', 'normal', 16), 0);
  assert.equal(anchorOf('gap', 'normal', 16), 0);
  assert.equal(anchorOf('line-height', 'normal', 20), 24);
  assert.equal(anchorOf('line-height', 'normal', null), null);
  assert.equal(anchorOf('line-height', '24px', 20), null, 'a number is its own start');
});

test('a colour is typed as hex or rgb(), or names a site colour; anything else is refused, never guessed', () => {
  assert.equal(colourValue('#C0392B'), '#c0392b');
  assert.equal(colourValue('#abc'), '#abc');
  assert.equal(colourValue('#c0392b80'), '#c0392b80');
  assert.equal(colourValue('rgb(192, 57, 43)'), 'rgb(192, 57, 43)');
  assert.equal(colourValue('rgb(192 57 43 / 50%)'), 'rgb(192 57 43 / 50%)');
  assert.equal(colourValue('rgba(0,0,0,0.5)'), 'rgba(0,0,0,0.5)');
  assert.equal(colourValue('var(--acme-sky)'), 'var(--acme-sky)');
  for (const no of ['', '#c0392', 'rgb(300, 0, 0)', 'red; } body {', 'url(x)', 'banana']) assert.equal(colourValue(no), null, no);
  assert.equal(colourValue('rebeccapurple', (v) => v === 'rebeccapurple'), 'rebeccapurple', 'any colour the browser reads');
  assert.equal(varName(' var(--acme-ink) '), '--acme-ink');
  assert.equal(varName('#123456'), null);
});

test('a colour shows as hex where it is one, empty when it is clear, and a swatch paints the site colour a var() names', () => {
  assert.equal(hexOf('rgb(20, 20, 20)'), '#141414');
  assert.equal(hexOf('#ABC'), '#aabbcc');
  assert.equal(hexOf('rgba(0, 0, 0, 0)'), null);
  assert.equal(isClear('rgba(0, 0, 0, 0)'), true);
  assert.equal(isClear('transparent'), true);
  assert.equal(isClear('rgb(0, 0, 0)'), false);
  assert.equal(colourText('rgb(20, 20, 20)'), '#141414');
  assert.equal(colourText('rgba(0, 0, 0, 0)'), '', 'the placeholder says none');
  assert.equal(colourText('var(--acme-ink)'), 'var(--acme-ink)');
  const site = new Map([['--acme-ink', '#1d2a3a']]);
  assert.equal(swatchOf('var(--acme-ink)', site), '#1d2a3a');
  assert.equal(swatchOf('var(--acme-gone)', site), null, 'a name the page does not set paints nothing');
  assert.equal(swatchOf('rgba(0, 0, 0, 0)', site), null);
  assert.equal(swatchOf('#c0392b', site), '#c0392b');
});

/** A frame clock the test advances by hand, and a page whose answers the test settles. */
function harness() {
  const frames: (() => void)[] = [];
  const sent: PreviewSpec<Record<string, string>>[] = [];
  const answers: (() => void)[] = [];
  const pump = previewPump<Record<string, string>>((spec) => { sent.push(spec); return new Promise<void>((done) => answers.push(done)); }, (run) => { frames.push(run); });
  const tick = (): void => { const now = frames.splice(0); for (const run of now) run(); };
  const answer = async (): Promise<void> => { answers.shift()?.(); await new Promise((r) => setTimeout(r, 0)); };
  return { pump, sent, frames, tick, answer };
}

test('a slider dragged sends at most one preview a frame, one at a time, the newest winning and the last always sent', async () => {
  const h = harness();
  for (let px = 10; px <= 60; px++) h.pump.set({ values: { 'font-size': `${px}px` }, scope: 'this' });
  assert.equal(h.sent.length, 0, 'nothing is sent before the frame');
  assert.equal(h.frames.length, 1, 'fifty changes ask for one frame');
  h.tick();
  assert.deepEqual(h.sent.map((s) => s.values?.['font-size']), ['60px'], 'one preview, the newest value');
  for (let px = 61; px <= 90; px++) h.pump.set({ values: { 'font-size': `${px}px` }, scope: 'this' });
  h.tick();
  assert.equal(h.sent.length, 1, 'while the page has not answered, nothing more goes to it');
  await h.answer();
  h.tick();
  assert.deepEqual(h.sent.map((s) => s.values?.['font-size']), ['60px', '90px'], 'once it answers, the last value goes in the next frame');
  await h.answer();
  h.pump.set({ values: { 'font-size': '90px' }, scope: 'this' });
  h.tick();
  assert.equal(h.sent.length, 2, 'the same values are not sent twice');
  h.pump.set({ values: { 'font-size': '90px' }, scope: 'kind' });
  h.tick();
  assert.equal(h.sent.length, 3, 'the same values for another reach are another preview');
});

test('closing takes the preview away at once, after the call in flight, without waiting for a frame; nothing is sent after it', async () => {
  const h = harness();
  h.pump.set({ values: { color: '#c0392b' }, scope: 'this' });
  h.tick();
  h.pump.set({ values: { color: '#1e8449' }, scope: 'this' });
  h.pump.close({ values: null, scope: 'this' });
  assert.equal(h.sent.length, 1, 'the first is still in flight');
  await h.answer();
  assert.deepEqual(h.sent.map((s) => s.values), [{ color: '#c0392b' }, null], 'the preview taken away straight after, with no frame drawn; the colour never sent is dropped');
  h.pump.set({ values: { color: '#000000' }, scope: 'this' });
  h.tick();
  await h.answer();
  assert.equal(h.sent.length, 2, 'nothing after closing');
});
