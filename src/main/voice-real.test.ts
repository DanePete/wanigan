// The real transcription test: the OS's own text-to-speech says "Move the
// northwind banner below the search box", and the built voice worker, forked
// as a utilityProcess exactly as the app forks it (scripts/voice-harness.mjs
// drives it), writes those words. Silence and steady noise give no text and
// never reach the model.
//
// It runs when WANIGAN_VOICE_MODELS names a folder holding the models as the
// app keeps them (onnx-community/whisper-base/…, and whisper-small/… for the
// accurate one), and skips with its reason otherwise, or where the OS has no
// text-to-speech: `say` on macOS, System.Speech through PowerShell on
// Windows, espeak-ng on Linux. It needs `npm run build` first: it runs the
// built worker, never a test-only path. Nothing is downloaded and no hosted
// model is called.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { VOICE_MODELS } from '../shared/voice.ts';

const root = resolve(import.meta.dirname, '../..');
const SENTENCE = 'Move the northwind banner below the search box.';
const models = process.env.WANIGAN_VOICE_MODELS;

/** 16-bit mono PCM at a rate, as a WAV file. */
function wav(samples: Int16Array, rate: number): Buffer {
  const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + body.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(body.length, 40);
  return Buffer.concat([head, body]);
}

/** A WAV's samples, its rate and channels: any 16-bit PCM file the TTS made. */
function readPcm(file: string): { rate: number; channels: number; samples: Int16Array } {
  const b = readFileSync(file);
  let off = 12; let rate = 0; let channels = 0; let data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); }
    if (id === 'data') data = b.subarray(off + 8, off + 8 + len);
    off += 8 + len + (len & 1);
  }
  if (!data || !rate) throw new Error(`${file} is not a PCM WAV file`);
  return { rate, channels, samples: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) };
}

/** Down to 16 kHz mono, by linear interpolation: enough for speech. */
function to16k(file: string, out: string): void {
  const { rate, channels, samples } = readPcm(file);
  const mono = new Float32Array(samples.length / channels);
  for (let i = 0; i < mono.length; i++) { let s = 0; for (let c = 0; c < channels; c++) s += samples[i * channels + c] as number; mono[i] = s / channels; }
  const n = Math.floor((mono.length * 16_000) / rate);
  const res = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * rate) / 16_000; const a = Math.floor(x); const f = x - a;
    res[i] = Math.round((mono[a] ?? 0) * (1 - f) + (mono[a + 1] ?? mono[a] ?? 0) * f);
  }
  writeFileSync(out, wav(res, 16_000));
}

/** The sentence, spoken by the OS into a 16 kHz mono WAV file; null (with why) where there is no TTS here. */
function speak(dir: string): { file: string } | { skip: string } {
  const file = join(dir, 'sentence.wav');
  const raw = join(dir, 'raw.wav');
  if (process.platform === 'darwin') {
    const r = spawnSync('say', ['-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', SENTENCE], { encoding: 'utf8' });
    return r.status === 0 && existsSync(file) ? { file } : { skip: `macOS say failed: ${r.stderr || r.error?.message}` };
  }
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; `
      + `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); `
      + `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}', $f); $s.Speak('${SENTENCE}'); $s.Dispose()`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    return r.status === 0 && existsSync(file) ? { file } : { skip: `System.Speech could not speak: ${r.stderr || r.error?.message}` };
  }
  const r = spawnSync('espeak-ng', ['-w', raw, SENTENCE], { encoding: 'utf8' });
  if (r.error || r.status !== 0 || !existsSync(raw)) return { skip: 'no text-to-speech here: espeak-ng is not installed' };
  to16k(raw, file);
  return { file };
}

/** Words, compared without case or punctuation. */
const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Why the built worker cannot be used, or null: it must exist and be newer than its sources. */
function staleBuild(): string | null {
  const built = join(root, 'out/main/voice-worker.js');
  if (!existsSync(built) || !existsSync(join(root, 'out/main/voice/ort-wasm-simd-threaded.wasm'))) return 'out/main/voice-worker.js is not built: run npm run build first';
  const at = statSync(built).mtimeMs;
  const sources = ['src/main/voice-worker.ts', 'src/main/voice-engine.ts', 'src/shared/voice.ts', 'src/shared/voice-vad.ts'];
  const newer = sources.filter((s) => statSync(join(root, s)).mtimeMs > at);
  return newer.length ? `the built worker is older than ${newer.join(', ')}: run npm run build first` : null;
}

interface Clip { clip: string; finals: { text: string; start: number; end: number }[]; errors: unknown[]; done: { transcribed: number } }

function harness(job: object, dir: string): Promise<{ lines: Record<string, unknown>[]; code: number | null }> {
  const jobFile = join(dir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(job));
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];
  return new Promise((done) => {
    const child = spawn(electron, [join(root, 'scripts/voice-harness.mjs'), jobFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', () => {});
    child.on('close', (code) => done({ code, lines: out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>) }));
  });
}

for (const m of VOICE_MODELS) {
  const why = !models ? 'WANIGAN_VOICE_MODELS is not set (a folder holding the models as Wanigan keeps them)'
    : !existsSync(join(models, m.repo, 'onnx/encoder_model_quantized.onnx')) ? `${models} holds no ${m.repo}` : null;
  test(`the ${m.label.toLowerCase()} model (${m.name}) writes what the OS’s text-to-speech says, and silence and noise give no text`, { skip: why ?? false, timeout: 300_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'wanigan-voice-real-'));
    try {
      const stale = staleBuild();
      assert.equal(stale, null, stale ?? '');
      const spoken = speak(dir);
      if ('skip' in spoken) { t.skip(spoken.skip); return; }
      const run = await harness({
        userData: join(dir, 'electron'), models, repo: m.repo, threads: 4, language: null, paced: false,
        clips: [{ id: 'sentence', file: spoken.file }, { id: 'silence', silence: 3 }, { id: 'noise', noise: 3 }],
      }, dir);
      const loaded = run.lines.find((l) => 'loaded' in l)?.loaded as { type: string; ms: number } | undefined;
      assert.equal(loaded?.type, 'loaded', `the worker did not load the model: ${JSON.stringify(run.lines).slice(0, 600)}`);
      const clip = (id: string): Clip => run.lines.find((l) => l.clip === id) as unknown as Clip;
      const sentence = clip('sentence');
      const heard = sentence.finals.map((f) => f.text).join(' ');
      const want = words(SENTENCE);
      const got = words(heard);
      const missing = want.filter((w) => !got.includes(w));
      t.diagnostic(`${m.label}: loaded in ${loaded?.ms} ms; heard “${heard}” (${sentence.finals.map((f) => `${f.start}–${f.end} ms`).join(', ')})`
        + `; words differing: ${missing.length ? `${missing.join(', ')} heard as ${got.filter((w) => !want.includes(w)).join(' ') || 'nothing'}` : 'none'}`);
      // The words, in order, with spaces aside: "North Wind" is northwind (Phase 1 scored it the same way).
      assert.ok(got.join('').includes(want.join('')), `the final text “${heard}” does not say “${SENTENCE}”`);
      assert.deepEqual(sentence.errors, []);
      const before = sentence.done.transcribed;
      for (const id of ['silence', 'noise']) {
        const c = clip(id);
        assert.deepEqual(c.finals, [], `${id} gave text`);
        assert.equal(c.done.transcribed, before, `${id} reached the model`);
      }
      t.diagnostic(`${m.label}: silence and noise gave no text and made no model call (${before} calls, all for the sentence)`);
      assert.ok(run.lines.some((l) => l.done === true));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
