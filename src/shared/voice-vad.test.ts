// Pause detection on made-up audio: syllable-like bursts for speech, digital
// silence, steady noise, a click. What is checked is where each spoken stretch
// begins and ends, and that silence and noise make none at all (every Whisper
// model invents words for them).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Segmenter, frameDb, type VadEvent } from './voice-vad.ts';

const RATE = 16_000;
const s = (sec: number): number => Math.round(sec * RATE);

/** A seeded random source, the same every run. */
function rng(seed = 7): () => number {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

/** Speech-like: a voiced tone whose loudness rises and falls four times a second (syllables), about -20 dBFS. */
function speech(sec: number, amp = 0.15): Float32Array {
  const out = new Float32Array(s(sec));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.6;
    out[i] = amp * syllable * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t));
  }
  return out;
}

/** Steady noise, a little low-passed (a room's hum or a fan), at an amplitude. */
function noise(sec: number, amp: number, seed = 7): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(s(sec));
  let y = 0;
  for (let i = 0; i < out.length; i++) { y = 0.7 * y + 0.3 * (r() * 2 - 1); out[i] = amp * y; }
  return out;
}

const silence = (sec: number): Float32Array => new Float32Array(s(sec));

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/** Feed audio in 100 ms chunks, as the window sends it; flush at the end. */
function run(audio: Float32Array, options = {}): VadEvent[] {
  const v = new Segmenter(options);
  const events: VadEvent[] = [];
  for (let i = 0; i < audio.length; i += 1600) events.push(...v.push(audio.subarray(i, i + 1600)));
  events.push(...v.flush());
  return events;
}

const ends = (events: VadEvent[]) => events.filter((e): e is Extract<VadEvent, { type: 'end' }> => e.type === 'end');
const sec = (n: number): number => Math.round((n / RATE) * 100) / 100;

test('digital silence makes no stretch at all', () => {
  assert.deepEqual(run(silence(5)), []);
});

test('steady noise, quiet or loud, makes no stretch: it sits on the floor', () => {
  for (const amp of [0.002, 0.02, 0.2]) assert.deepEqual(run(noise(6, amp)), [], `noise at ${amp}`);
});

test('a click or a tap is too short to count', () => {
  const click = join(silence(1), speech(0.06, 0.5), silence(1.5));
  assert.equal(ends(run(click)).length, 0);
});

test('one spoken stretch begins and ends where the voice does, with a little room either side', () => {
  const e = ends(run(join(silence(1), speech(2), silence(1.5))));
  assert.equal(e.length, 1);
  const one = e[0]!;
  assert.ok(sec(one.start) >= 0.7 && sec(one.start) <= 1.0, `starts at ${sec(one.start)}`);
  assert.ok(sec(one.end) >= 2.8 && sec(one.end) <= 3.3, `ends at ${sec(one.end)}`);
});

test('speech from the very first sample is heard from its start', () => {
  const e = ends(run(join(speech(1.5), silence(1.2))));
  assert.equal(e.length, 1);
  assert.equal(e[0]!.start, 0);
});

test('a pause of a second splits two sentences; the gaps between syllables do not', () => {
  const e = ends(run(join(silence(0.5), speech(1.8), silence(1.1), speech(1.6), silence(1.2))));
  assert.equal(e.length, 2, JSON.stringify(e.map((x) => [sec(x.start), sec(x.end)])));
  assert.ok(e[0]!.end <= e[1]!.start, 'in order, not overlapping');
  assert.ok(sec(e[1]!.start) >= 3.0 && sec(e[1]!.start) <= 3.5, `the second starts at ${sec(e[1]!.start)}`);
});

test('speech over steady noise is still found, and the noise around it is not', () => {
  const quietRoom = noise(5, 0.01, 3);
  const e = ends(run(mix(join(silence(1.5), speech(2), silence(1.5)), quietRoom)));
  assert.equal(e.length, 1);
  assert.ok(sec(e[0]!.start) >= 1.1 && sec(e[0]!.end) <= 4.0, JSON.stringify([sec(e[0]!.start), sec(e[0]!.end)]));
});

test('a stretch longer than Whisper hears is cut, and the voice goes on in the next', () => {
  const e = ends(run(speech(12), { maxSamples: s(5) }));
  assert.ok(e.length >= 2, `${e.length} parts`);
  assert.ok(e.slice(0, -1).every((x) => x.cut && x.end - x.start <= s(5) + 480), 'the full parts were cut at the limit');
  for (let i = 1; i < e.length; i++) assert.equal(e[i]!.start, e[i - 1]!.end, 'no audio lost between parts');
});

test('a stretch still open when the stream ends is closed by flush', () => {
  const v = new Segmenter();
  for (const c of [speech(1)]) v.push(c);
  const events = v.flush();
  assert.ok(events.some((e) => e.type === 'end'), JSON.stringify(events));
  assert.equal(v.speaking, false);
});

test('frame energy is in dBFS', () => {
  const full = new Float32Array(480).fill(1);
  assert.ok(Math.abs(frameDb(full, 0, 480)) < 0.01);
  assert.ok(frameDb(new Float32Array(480), 0, 480) < -100);
});
