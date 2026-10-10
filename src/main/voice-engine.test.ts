// The voice engine's protocol on a stream, with a stand-in for Whisper: what
// the window is answered for speech, silence, noise, a message it does not
// know, one too big, audio after the end, a cancel, and the model failing
// under it. Made-up audio; no model is loaded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VoiceOut } from '../shared/voice.ts';
import { TranscribeQueue, VoiceStream, type Transcriber } from './voice-engine.ts';

const RATE = 16_000;

/** Speech-like: a tone (its pitch tells the stand-in which sentence it is) whose loudness rises and falls four times a second. */
function speech(sec: number, pitch = 180): Float32Array {
  const out = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = 0.15 * Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 0.6 * Math.sin(2 * Math.PI * pitch * t);
  }
  return out;
}

/** The pitch of a stretch, from its zero crossings. */
function pitchOf(audio: Float32Array): number {
  let crossings = 0; let last = 0;
  for (const v of audio) { if (v !== 0) { if (last !== 0 && Math.sign(v) !== Math.sign(last)) crossings++; last = v; } }
  return crossings / 2 / (audio.length / RATE);
}
const silence = (sec: number): Float32Array => new Float32Array(Math.round(sec * RATE));
function noise(sec: number, amp = 0.05): Float32Array {
  let x = 7; let y = 0;
  const out = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) % 2147483648; y = 0.7 * y + 0.3 * ((x / 2147483648) * 2 - 1); out[i] = amp * y; }
  return out;
}
const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** A stand-in transcriber: answers what it is told for what it hears, and records how long each piece of audio was. */
function standIn(words: string | ((audio: Float32Array) => Promise<string>)) {
  const heard: number[] = [];
  const t: Transcriber = async (audio) => {
    heard.push(audio.length);
    return typeof words === 'function' ? words(audio) : words;
  };
  return { t, heard };
}

/** A stream, its answers, and a promise for its done. */
function stream(t: Transcriber, queue = new TranscribeQueue(t)) {
  const out: VoiceOut[] = [];
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => { finish = r; });
  const s = new VoiceStream((m) => { out.push(m); if (m.type === 'done') finish(); }, queue, null);
  const feed = (audio: Float32Array): void => { for (let i = 0; i < audio.length; i += 1600) s.receive({ type: 'audio', samples: audio.slice(i, i + 1600) }); };
  /** As the window sends it: a chunk, then a turn for the engine, as a microphone's 100 ms do. */
  const live = async (audio: Float32Array): Promise<void> => {
    for (let i = 0; i < audio.length; i += 1600) { s.receive({ type: 'audio', samples: audio.slice(i, i + 1600) }); await new Promise((r) => setImmediate(r)); }
  };
  return { s, out, done, feed, live, queue };
}

const of = <T extends VoiceOut['type']>(out: VoiceOut[], type: T) => out.filter((m): m is Extract<VoiceOut, { type: T }> => m.type === type);

test('silence, steady noise, and noise that starts after silence reach no model and give no text', async () => {
  const w = standIn('thank you');
  const st = stream(w.t);
  st.feed(join(silence(2), noise(3), silence(1)));
  st.s.receive({ type: 'end' });
  await st.done;
  assert.deepEqual(w.heard, [], 'the model was never called');
  assert.deepEqual(of(st.out, 'final'), []);
  assert.deepEqual(of(st.out, 'done'), [{ type: 'done', finals: 0, transcribed: 0 }]);
});

test('each spoken stretch is transcribed once it ends, as a final with its times from the first sample', async () => {
  const w = standIn(async (audio) => (pitchOf(audio) < 100 ? ' Move the northwind banner. ' : 'Below the search box.'));
  const st = stream(w.t);
  await st.live(join(silence(0.5), speech(1.4, 180), silence(1.2), speech(1.2, 320), silence(1.2)));
  st.s.receive({ type: 'end' });
  await st.done;
  const finals = of(st.out, 'final');
  assert.deepEqual(finals.map((f) => f.text), ['Move the northwind banner.', 'Below the search box.']);
  assert.ok(finals[0]!.start >= 200 && finals[0]!.start <= 500, `first starts at ${finals[0]!.start} ms`);
  assert.ok(finals[1]!.start >= 2_800 && finals[1]!.start <= 3_300, `second starts at ${finals[1]!.start} ms`);
  assert.ok(finals[0]!.end <= finals[1]!.start);
  // Each final heard its own stretch, not the silence around it.
  assert.ok(finals.every((f) => f.end - f.start < 2_200), JSON.stringify(finals));
  const speechMsgs = of(st.out, 'speech').map((m) => m.speaking);
  assert.deepEqual(speechMsgs, [true, false, true, false]);
});

test('while a long stretch goes on, the words so far come as partials, and never after its final', async () => {
  const w = standIn(async (audio) => `${(audio.length / RATE).toFixed(1)} seconds heard`);
  const st = stream(w.t);
  await st.live(join(silence(0.3), speech(4), silence(1.2)));
  st.s.receive({ type: 'end' });
  await st.done;
  const partials = of(st.out, 'partial');
  assert.ok(partials.length >= 1, 'volatile words came');
  const lastFinal = st.out.findIndex((m) => m.type === 'final');
  assert.ok(lastFinal > st.out.findIndex((m) => m.type === 'partial'));
  assert.ok(!st.out.slice(lastFinal).some((m) => m.type === 'partial'), 'no partial after its final');
});

test('a message the worker does not know, or audio over a second, is refused by name and the stream goes on', async () => {
  const w = standIn('Make it blue.');
  const st = stream(w.t);
  st.s.receive({ type: 'shout', samples: new Float32Array(10) });
  st.s.receive('end');
  st.s.receive({ type: 'audio', samples: new Float32Array(RATE + 1) });
  st.s.receive({ type: 'audio', samples: [0, 0.1, 0.2] });
  st.feed(join(silence(0.4), speech(1.2), silence(1.2)));
  st.s.receive({ type: 'end' });
  await st.done;
  assert.deepEqual(of(st.out, 'error').map((e) => e.code), ['unknown-message', 'unknown-message', 'oversized', 'bad-audio']);
  assert.deepEqual(of(st.out, 'final').map((f) => f.text), ['Make it blue.']);
});

test('audio after the end is not heard; a cancel stops at once and drops what was still to be written', async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => { release = r; });
  const w = standIn(async () => { await slow; return 'Too late.'; });
  const st = stream(w.t);
  st.feed(join(silence(0.3), speech(1.2), silence(1.2)));
  st.s.receive({ type: 'cancel' });
  st.s.receive({ type: 'audio', samples: new Float32Array(1600) });
  await st.done;
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(of(st.out, 'final'), [], 'a cancelled stream sends no final');
  assert.equal(of(st.out, 'done').length, 1);
  assert.equal(st.out[st.out.length - 1]!.type, 'done', 'nothing after done');

  const w2 = standIn('One.');
  const st2 = stream(w2.t);
  st2.feed(join(silence(0.3), speech(1), silence(1)));
  st2.s.receive({ type: 'end' });
  st2.s.receive({ type: 'audio', samples: new Float32Array(1600) });
  await st2.done;
  assert.ok(of(st2.out, 'error').some((e) => e.code === 'after-end'));
});

test('the model failing mid-stream is said, the stream ends, and the next stream on the same engine still works', async () => {
  let broken = true;
  const t: Transcriber = async () => { if (broken) throw new Error('wasm memory access out of bounds'); return 'Works again.'; };
  const queue = new TranscribeQueue(t);
  const st = stream(t, queue);
  st.feed(join(silence(0.3), speech(1.2), silence(1.2), speech(1.2)));
  await st.done;
  broken = false;
  const err = of(st.out, 'error');
  assert.equal(err.length, 1);
  assert.equal(err[0]!.code, 'engine');
  assert.match(err[0]!.message, /out of bounds/);
  assert.equal(st.s.done, true);
  const again = stream(t, queue);
  again.feed(join(silence(0.3), speech(1.2), silence(1.2)));
  again.s.receive({ type: 'end' });
  await again.done;
  assert.deepEqual(of(again.out, 'final').map((f) => f.text), ['Works again.']);
});

test('one transcription at a time across streams, finals before any waiting partial', async () => {
  const order: string[] = [];
  let running = 0; let most = 0;
  const t: Transcriber = async (audio) => {
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    order.push(`${audio.length}`);
    return 'words';
  };
  const queue = new TranscribeQueue(t);
  const a = stream(t, queue);
  const b = stream(t, queue);
  a.feed(join(silence(0.3), speech(1.2), silence(1.2)));
  b.feed(join(silence(0.3), speech(1.2), silence(1.2)));
  a.s.receive({ type: 'end' });
  b.s.receive({ type: 'end' });
  await Promise.all([a.done, b.done]);
  assert.equal(most, 1, 'never two at once');
  assert.equal(of(a.out, 'final').length + of(b.out, 'final').length, 2);
});

test('what Whisper says for silence inside a stretch is dropped, not sent as words', async () => {
  const w = standIn(async (audio) => (pitchOf(audio) < 100 ? '[BLANK_AUDIO]' : ' ... '));
  const st = stream(w.t);
  st.feed(join(silence(0.3), speech(1.2, 180), silence(1.2), speech(1.2, 320), silence(1.2)));
  st.s.receive({ type: 'end' });
  await st.done;
  assert.ok(w.heard.length >= 2);
  assert.deepEqual(of(st.out, 'final'), []);
});
