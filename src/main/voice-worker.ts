// The voice worker: an Electron utilityProcess the main process forks on the
// first use of voice input (src/main/voice.ts) and stops when it is unused.
// Whisper through transformers.js on onnxruntime-web's WebAssembly: the same
// files on every OS, no native code. The build bundles both into this entry
// and copies onnxruntime's .wasm and its loader beside it, into voice/
// (electron.vite.config.ts); transformers.js's own onnxruntime-node is never
// bundled, and it is handed onnxruntime-web instead.
//
// The main process sends `load` (a model's folder) and `stream` (an id, the
// language, and a MessagePort to the window); audio comes in and words go out
// over that port, never through the main process. Models are read from disk
// only: transformers.js is told never to fetch.
// Design: docs/design/2026-10-10-voice-input.md.
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';
import type { MessagePortMain } from 'electron';
import { TranscribeQueue, VoiceStream } from './voice-engine.ts';

type Control =
  | { type: 'load'; root: string; repo: string; threads?: number }
  | { type: 'stream'; id: string; language: string | null }
  | { type: 'stop' };

/** What the worker needs of transformers.js's speech pipeline (4.3.1, pinned): its model, processor and tokenizer. */
interface Asr {
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  tokenizer: { batch_decode: (ids: unknown, options: { skip_special_tokens: boolean }) => string[] };
  model: {
    generation_config: { lang_to_id?: Record<string, number>; decoder_start_token_id: number };
    generate: (options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;
    forward_params: string[];
    sessions: { model: { run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>; inputNames: string[]; outputNames: string[] } };
  };
  dispose?: () => Promise<void>;
}

/** Speech to text with one pass of the encoder: the language read from Whisper's first token when none is given. */
type Hear = (audio: Float32Array, language: string | null) => Promise<string>;

const parent = process.parentPort;
const say = (msg: Record<string, unknown>): void => parent.postMessage(msg);

const here = __dirname;
ort.env.wasm.wasmPaths = {
  mjs: pathToFileURL(join(here, 'voice', 'ort-wasm-simd-threaded.mjs')).href,
  wasm: pathToFileURL(join(here, 'voice', 'ort-wasm-simd-threaded.wasm')).href,
};
ort.env.wasm.proxy = false;
// transformers.js uses this onnxruntime when it finds it here, and never looks for onnxruntime-node.
(globalThis as Record<symbol, unknown>)[Symbol.for('onnxruntime')] = ort;

let asr: Asr | null = null;
let hear: Hear | null = null;
let loaded: string | null = null;
let loading: Promise<void> | null = null;
const streams = new Map<string, VoiceStream>();

// Listening starts at once; a stretch heard while the model still loads waits for it.
const queue = new TranscribeQueue(async (audio, { language }) => {
  await loading;
  if (!hear) throw new Error('No speech model is loaded.');
  return hear(audio, language);
});

/**
 * How the pipeline is asked, as Phase 1 measured it: the encoder runs once; with no language given, one decoder step
 * reads the language token Whisper chose (transformers.js would otherwise assume English); then it transcribes in it.
 */
function hearing(T: typeof import('@huggingface/transformers'), a: Asr): Hear {
  const gc = a.model.generation_config;
  const langOf = new Map(Object.entries(gc.lang_to_id ?? {}).map(([k, v]) => [v, k.slice(2, -2)]));
  const generate = a.model.generate.bind(a.model);
  // generate() keeps only the inputs it knows: let it take the encoder's output, computed once.
  if (!a.model.forward_params.includes('encoder_outputs')) a.model.forward_params = [...a.model.forward_params, 'encoder_outputs'];
  const encoder = a.model.sessions.model;
  return async (audio, language) => {
    const features = (await a.processor(audio)).input_features as { ort_tensor: unknown };
    const out = await encoder.run({ [encoder.inputNames[0] as string]: features.ort_tensor });
    const enc = new T.Tensor(out[encoder.outputNames[0] as string] as never);
    let lang = language;
    if (!lang) {
      const first = await generate({ inputs: features, encoder_outputs: enc, decoder_input_ids: [[gc.decoder_start_token_id]], max_new_tokens: 1 });
      lang = langOf.get(Number(first.tolist()[0]?.at(-1))) ?? 'en';
    }
    const ids = await generate({ inputs: features, encoder_outputs: enc, language: lang, task: 'transcribe' });
    return a.tokenizer.batch_decode(ids, { skip_special_tokens: true })[0] ?? '';
  };
}

async function load(root: string, repo: string, threads: number): Promise<void> {
  if (loaded === repo && asr) { say({ type: 'loaded', repo, ms: 0 }); return; }
  const t0 = performance.now();
  try {
    // Threads are fixed when the first model loads; one fewer than the cores, at most four.
    ort.env.wasm.numThreads = threads;
    const T = await import('@huggingface/transformers');
    T.env.allowRemoteModels = false;
    T.env.allowLocalModels = true;
    T.env.localModelPath = `${root.replace(/[/\\]+$/, '')}/`;
    T.env.useWasmCache = false;
    if (asr?.dispose) await asr.dispose().catch(() => {});
    asr = null;
    hear = null;
    loaded = null;
    asr = await T.pipeline('automatic-speech-recognition', repo, { dtype: 'q8', device: 'auto' }) as unknown as Asr;
    hear = hearing(T, asr);
    loaded = repo;
    say({ type: 'loaded', repo, ms: Math.round(performance.now() - t0) });
  } catch (error) {
    say({ type: 'load-failed', repo, message: (error as Error)?.message ?? String(error) });
  }
}

parent.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const msg = event.data as Control | null;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'load' && typeof msg.root === 'string' && typeof msg.repo === 'string') {
    const threads = Math.max(1, Math.min(4, Number.isInteger(msg.threads) ? msg.threads as number : cpus().length - 1));
    loading = (loading ?? Promise.resolve()).then(() => load(msg.root, msg.repo, threads));
    return;
  }
  if (msg.type === 'stream' && typeof msg.id === 'string') {
    const port = event.ports[0];
    if (!port) return;
    const id = msg.id;
    const stream = new VoiceStream((out) => port.postMessage(out), queue, typeof msg.language === 'string' ? msg.language : null, {}, () => {
      streams.delete(id);
      say({ type: 'stream-done', id });
      // Let the window read the last message before the port goes.
      setTimeout(() => port.close(), 200);
    });
    streams.set(id, stream);
    port.on('message', (e: { data: unknown }) => stream.receive(e.data));
    port.on('close', () => { if (!stream.done) stream.receive({ type: 'cancel' }); });
    port.start();
    return;
  }
  if (msg.type === 'stop') {
    for (const s of streams.values()) s.receive({ type: 'cancel' });
    process.exit(0);
  }
});

say({ type: 'hello' });
