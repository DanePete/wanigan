// Drives the built voice worker as the app does: Electron forks
// out/main/voice-worker.js as a utilityProcess, sends it `load` and `stream`
// with a MessagePort, and feeds that port 16 kHz audio in 100 ms chunks, as the
// window's AudioWorklet does. Used by the real transcription test
// (src/main/voice-real.test.ts); test-only, never shipped.
//
//   electron scripts/voice-harness.mjs <job.json>
//
// The job names the models folder, the model's repository, the language (or
// null) and the clips (each a 16 kHz mono 16-bit WAV, or `silence` seconds, or
// `noise` seconds of steady noise). One JSON line goes to stdout per clip, then
// {"done":true}.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, MessageChannelMain, utilityProcess } from 'electron';

const job = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8'));
const root = resolve(import.meta.dirname, '..');
app.setPath('userData', job.userData);
const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

function readWav16(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`not a WAV file: ${file}`);
  let off = 12; let fmt; let data;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + len);
    off += 8 + len + (len & 1);
  }
  if (!fmt || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16 || !data) throw new Error(`want 16 kHz mono 16-bit: ${JSON.stringify(fmt)}`);
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

/** Audio for a clip: a file, padded with the half second before and the second after a person presses and lets go. */
function audioOf(clip) {
  if (clip.silence) return new Float32Array(Math.round(clip.silence * 16000));
  if (clip.noise) {
    // Steady noise, low-passed a little (a room's hum), about -32 dBFS: seeded, the same every run.
    let seed = 7; let y = 0;
    const out = new Float32Array(Math.round(clip.noise * 16000));
    for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) % 2147483648; y = 0.7 * y + 0.3 * ((seed / 2147483648) * 2 - 1); out[i] = y * 0.09; }
    return out;
  }
  const speech = readWav16(clip.file);
  const out = new Float32Array(8000 + speech.length + 16000);
  out.set(speech, 8000);
  return out;
}

const timeout = setTimeout(() => { print({ error: 'the harness timed out' }); app.exit(2); }, (job.timeoutSec ?? 240) * 1000);

app.whenReady().then(async () => {
  // The built worker, or (job.worker) the same file inside a packed app.asar, as a packaged app forks it.
  const worker = utilityProcess.fork(job.worker ?? join(root, 'out/main/voice-worker.js'), [], { serviceName: 'Wanigan Voice (test)', stdio: 'pipe' });
  let stderr = '';
  worker.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  worker.stdout?.on('data', () => {});
  const fromWorker = [];
  let wake = null;
  worker.on('message', (m) => { fromWorker.push(m); wake?.(); });
  worker.on('exit', (code) => { print({ exit: code, stderr }); clearTimeout(timeout); app.exit(code === 0 ? 0 : 3); });
  const next = async (type) => {
    for (;;) {
      const i = fromWorker.findIndex((m) => m.type === type || m.type === 'load-failed');
      if (i >= 0) return fromWorker.splice(i, 1)[0];
      await new Promise((r) => { wake = r; });
    }
  };
  await next('hello');
  worker.postMessage({ type: 'load', root: job.models, repo: job.repo, threads: job.threads });
  const loaded = await next('loaded');
  print({ loaded });
  if (loaded.type !== 'loaded') { clearTimeout(timeout); app.exit(4); return; }
  for (const [n, clip] of job.clips.entries()) {
    const { port1, port2 } = new MessageChannelMain();
    const got = [];
    const done = new Promise((r) => { port1.on('message', (e) => { got.push(e.data); if (e.data?.type === 'done') r(); }); });
    port1.start();
    worker.postMessage({ type: 'stream', id: `clip-${n}`, language: job.language ?? null }, [port2]);
    const audio = audioOf(clip);
    const t0 = Date.now();
    for (let i = 0; i < audio.length; i += 1600) {
      port1.postMessage({ type: 'audio', samples: audio.slice(i, i + 1600) });
      // A little faster than real time: the window sends as the microphone hears.
      if (job.paced) await new Promise((r) => setTimeout(r, 25));
    }
    port1.postMessage({ type: 'end' });
    await done;
    port1.close();
    print({ clip: clip.id, ms: Date.now() - t0, finals: got.filter((m) => m.type === 'final'), partials: got.filter((m) => m.type === 'partial').length, errors: got.filter((m) => m.type === 'error'), done: got.find((m) => m.type === 'done') });
  }
  worker.postMessage({ type: 'stop' });
  print({ done: true });
});
