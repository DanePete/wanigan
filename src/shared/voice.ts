// Voice input, as data: the speech models Wanigan can download (each file
// pinned to a Hugging Face commit with its size and SHA-256), the owner's
// voice settings, the messages the window and the voice worker exchange, the
// keys, and how spoken words join the text already in a box. Pure, so the main
// process, the worker, the window and the tests read it alike.
// Design: docs/design/2026-10-10-voice-input.md.

/** The worker hears 16 kHz mono, as Whisper wants it. */
export const VOICE_RATE = 16_000;
/** The most samples one audio message may carry: one second. A bigger one is refused, never buffered. */
export const VOICE_CHUNK_MAX = VOICE_RATE;
/** The most audio a stream may hold waiting for the engine: two minutes. */
export const VOICE_PENDING_MAX = VOICE_RATE * 120;
/** The longest one spoken stretch is kept before it is cut and transcribed: Whisper hears 30 s at most. */
export const VOICE_SEGMENT_MAX = VOICE_RATE * 25;
/** The longest one stream (one press of the mic) listens: ten minutes. */
export const VOICE_STREAM_MAX = VOICE_RATE * 600;

export type VoiceModelId = 'fast' | 'accurate';

export interface VoiceModelFile {
  /** Its path in the repository, and under the model's folder on disk. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface VoiceModel {
  id: VoiceModelId;
  label: string;
  /** What it is, in a few words. */
  name: string;
  /** The Hugging Face repository, which is also its folder under the models folder. */
  repo: string;
  /** The commit every file is pinned to. */
  revision: string;
  licence: string;
  /** What the owner is told it is good for. */
  summary: string;
  files: readonly VoiceModelFile[];
}

/**
 * The two models: Whisper base and small, 8-bit, converted to ONNX by onnx-community. Commits, sizes and hashes were
 * read from the Hugging Face API on 10 October 2026 (the weights' LFS hashes; the small files' computed from them).
 */
export const VOICE_MODELS: readonly VoiceModel[] = [
  {
    id: 'fast', label: 'Fast', name: 'Whisper base', repo: 'onnx-community/whisper-base', revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    licence: 'Apache-2.0 (from openai/whisper-base)',
    summary: 'About a second a sentence. Good English, fair in most other languages.',
    files: [
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 23_201_314, sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 53_693_315, sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b' },
      { path: 'config.json', bytes: 2_243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b' },
      { path: 'generation_config.json', bytes: 3_832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
      { path: 'preprocessor_config.json', bytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', bytes: 2_480_466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', bytes: 282_682, sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573' },
    ],
  },
  {
    id: 'accurate', label: 'Accurate', name: 'Whisper small', repo: 'onnx-community/whisper-small', revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    licence: 'Apache-2.0 (from openai/whisper-small)',
    summary: 'About three seconds a sentence. Better with noise, accents and languages other than English.',
    files: [
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 92_326_160, sha256: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 156_750_845, sha256: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9' },
      { path: 'config.json', bytes: 2_227, sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
      { path: 'generation_config.json', bytes: 3_893, sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
      { path: 'preprocessor_config.json', bytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', bytes: 2_480_466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', bytes: 282_683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
    ],
  },
];

export const voiceModel = (id: unknown): VoiceModel | undefined => VOICE_MODELS.find((m) => m.id === id);
export const modelBytes = (m: VoiceModel): number => m.files.reduce((n, f) => n + f.bytes, 0);
/** Where a pinned file is downloaded from. */
export const fileUrl = (m: VoiceModel, f: VoiceModelFile): string => `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.path}`;
/** Where the owner can read about a model. */
export const modelPage = (m: VoiceModel): string => `https://huggingface.co/${m.repo}`;

/** Languages Whisper names, the ones offered in Settings: Detect, or one of these. */
export const VOICE_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' }, { code: 'pt', label: 'Portuguese' }, { code: 'nl', label: 'Dutch' }, { code: 'pl', label: 'Polish' },
  { code: 'sv', label: 'Swedish' }, { code: 'da', label: 'Danish' }, { code: 'no', label: 'Norwegian' }, { code: 'fi', label: 'Finnish' },
  { code: 'tr', label: 'Turkish' }, { code: 'ru', label: 'Russian' }, { code: 'uk', label: 'Ukrainian' }, { code: 'cs', label: 'Czech' },
  { code: 'el', label: 'Greek' }, { code: 'ro', label: 'Romanian' }, { code: 'hu', label: 'Hungarian' }, { code: 'ar', label: 'Arabic' },
  { code: 'he', label: 'Hebrew' }, { code: 'hi', label: 'Hindi' }, { code: 'id', label: 'Indonesian' }, { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' }, { code: 'ja', label: 'Japanese' }, { code: 'ko', label: 'Korean' }, { code: 'zh', label: 'Chinese' },
];

export const isVoiceLanguage = (v: unknown): v is string => v === 'auto' || VOICE_LANGUAGES.some((l) => l.code === v);

export interface VoiceSettings {
  model: VoiceModelId;
  /** 'auto' to detect it, else a code from VOICE_LANGUAGES. */
  language: string;
  /** Listen from a recording's start to its stop and put what is said in its step log. */
  narrate: boolean;
}

export const VOICE_DEFAULTS: VoiceSettings = { model: 'fast', language: 'auto', narrate: false };

/** Settings as they may be kept: anything else in what was read or sent is dropped. */
export function cleanVoiceSettings(raw: unknown, base: VoiceSettings = VOICE_DEFAULTS): VoiceSettings {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    model: voiceModel(r.model)?.id ?? base.model,
    language: isVoiceLanguage(r.language) ? r.language : base.language,
    narrate: typeof r.narrate === 'boolean' ? r.narrate : base.narrate,
  };
}

/* ── state the window is told ───────────────────────────────────────────── */

export type VoiceDownload =
  | { state: 'idle' }
  | { state: 'downloading'; done: number; total: number }
  | { state: 'failed'; done: number; total: number; error: string };

export interface VoiceModelState {
  id: VoiceModelId;
  /** Every file on disk, checked against its hash when it came. */
  ready: boolean;
  download: VoiceDownload;
}

/** The engine: not running, starting and loading a model, ready, or stopped by a failure (said in `error`). */
export type VoiceEngineState = 'off' | 'loading' | 'ready' | 'failed';

/** What the OS says of the microphone, where it says (macOS, Windows); 'unknown' elsewhere. */
export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface VoiceState {
  settings: VoiceSettings;
  models: VoiceModelState[];
  engine: VoiceEngineState;
  engineError: string | null;
  mic: MicAccess;
  /** The OS has a settings page for the microphone that Wanigan can open. */
  micSettings: boolean;
  platform: string;
}

/** What starting a stream answers: an id (its port follows), or why it could not start. */
export type VoiceStart = { ok: true; id: string } | { ok: false; code: 'no-model' | 'engine' | 'busy'; message: string };

/* ── the stream: the window and the worker, over a MessagePort ──────────── */

/** The window's messages to the worker. */
export type VoiceIn =
  | { type: 'audio'; samples: Float32Array }
  /** No more audio: transcribe what is left, then say done. */
  | { type: 'end' }
  /** Stop now: nothing more is transcribed. */
  | { type: 'cancel' };

/** The worker's messages to the window. Times are milliseconds from the stream's first sample. */
export type VoiceOut =
  | { type: 'speech'; speaking: boolean; at: number }
  | { type: 'partial'; text: string; start: number; end: number }
  | { type: 'final'; text: string; start: number; end: number }
  | { type: 'error'; code: VoiceErrorCode; message: string }
  | { type: 'done'; finals: number; transcribed: number };

export type VoiceErrorCode = 'unknown-message' | 'oversized' | 'bad-audio' | 'too-much-audio' | 'too-long' | 'engine' | 'after-end';

/** A message from the window, checked: what it is, or why it is refused. Nothing else in it is read. */
export function readVoiceIn(raw: unknown): { ok: true; msg: VoiceIn } | { ok: false; code: VoiceErrorCode; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'unknown-message', message: 'A voice message must be an object.' };
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case 'audio': {
      const s = r.samples;
      if (!(s instanceof Float32Array)) return { ok: false, code: 'bad-audio', message: 'Audio must be 32-bit float samples.' };
      if (s.length > VOICE_CHUNK_MAX) return { ok: false, code: 'oversized', message: `An audio message may hold at most ${VOICE_CHUNK_MAX} samples (one second); this held ${s.length}.` };
      return { ok: true, msg: { type: 'audio', samples: s } };
    }
    case 'end': return { ok: true, msg: { type: 'end' } };
    case 'cancel': return { ok: true, msg: { type: 'cancel' } };
    default: return { ok: false, code: 'unknown-message', message: `Unknown voice message ${JSON.stringify(String(r.type)).slice(0, 40)}.` };
  }
}

/** Whisper's words for what was not speech, and stray whitespace: taken out of what it heard. */
export function cleanHeard(text: string): string {
  return text
    .replace(/\[[^\]]{0,40}\]|\((?:music|silence|applause|laughter|inaudible|noise|blank[_ ]audio|sound|static)[^)]{0,20}\)|♪+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether what was heard has a word in it (a letter or a digit), not only punctuation. */
export const hasWords = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * Spoken words as they join a box: a space before them when they follow a word, none when they start the box or a
 * line or follow a space; a box of one line (an input) takes no line breaks and no closing full stop.
 */
export function joinSpoken(before: string, spoken: string, singleLine: boolean): string {
  let s = spoken.trim();
  if (singleLine) s = s.replace(/\s*\n+\s*/g, ' ').replace(/[.。]+$/u, '');
  if (!s) return '';
  const last = before.slice(-1);
  const needsSpace = before.length > 0 && !/\s/.test(last) && !/^[,.;:!?)\]}%]/.test(s);
  return `${needsSpace ? ' ' : ''}${s}`;
}

/* ── keys ────────────────────────────────────────────────────────────────── */

interface VoiceKeyInput { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** The letter a press names: the key's own for a Latin layout, else the physical key's. */
function letterOf(e: VoiceKeyInput): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
}

const modShift = (e: VoiceKeyInput, mac: boolean): boolean =>
  (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && e.shiftKey && !e.altKey;

/** ⌘⇧M (Ctrl+Shift+M on Windows and Linux): start or stop listening. */
export const isVoiceToggleKey = (e: VoiceKeyInput, mac: boolean): boolean => modShift(e, mac) && letterOf(e) === 'm';

/** ⌘⇧H (Ctrl+Shift+H): held, listen until the keys are let go. */
export const isVoiceHoldKey = (e: VoiceKeyInput, mac: boolean): boolean => modShift(e, mac) && letterOf(e) === 'h';

/**
 * Whether a key let go ends a hold: the letter itself, or one of the chord's modifiers. A Mac sends no key-up for a
 * letter let go while ⌘ is still down, so letting go of ⌘ or ⇧ is what ends it there.
 */
export function endsVoiceHold(e: { key: string; code?: string }, mac: boolean): boolean {
  if (e.key === 'Shift' || e.key === (mac ? 'Meta' : 'Control')) return true;
  return letterOf({ ...e, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }) === 'h';
}
