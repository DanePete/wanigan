// The voice engine's work on one stream, without the model: audio in, spoken
// stretches found (src/shared/voice-vad.ts), each transcribed as it ends (a
// final) and, while it is still going and the engine is free, what it has so
// far (volatile words). The voice worker (voice-worker.ts) gives it Whisper;
// the tests give it a stand-in. Every message from the window is checked by
// readVoiceIn() before anything in it is used.
//
// Bounded: one transcription at a time across every stream (the worker shares
// one queue), an audio message over a second refused, audio waiting capped at
// two minutes, a stretch cut at 25 s, a stream at ten minutes.
// Design: docs/design/2026-10-10-voice-input.md.
import { VOICE_PENDING_MAX, VOICE_RATE, VOICE_STREAM_MAX, cleanHeard, hasWords, readVoiceIn, type VoiceOut } from '../shared/voice.ts';
import { Segmenter, type VadOptions } from '../shared/voice-vad.ts';

/** Speech to text for one stretch of 16 kHz audio. The language is a code, or null to detect it. */
export type Transcriber = (audio: Float32Array, options: { language: string | null }) => Promise<string>;

/** Partials are tried when this much more audio has come since the last (ms). */
const PARTIAL_EVERY_MS = 800;
/** A stretch is this long (ms) before a partial of it is worth a model's time. */
const PARTIAL_MIN_MS = 600;

const msOf = (samples: number): number => Math.round((samples * 1000) / VOICE_RATE);

/** One transcription at a time, finals before partials, shared by every stream the worker runs. */
export class TranscribeQueue {
  private running = false;
  private finals: (() => Promise<void>)[] = [];
  private partials = new Map<object, () => Promise<void>>();
  /** Model calls made, finals and partials. */
  calls = 0;

  constructor(private readonly transcribe: Transcriber) {}

  /** A final: queued in order, always run. */
  final(run: (t: Transcriber) => Promise<void>): void {
    this.finals.push(() => run(this.counted));
    this.pump();
  }

  /** A partial for an owner (a stream): only the newest is kept, and it runs only when no final waits. */
  partial(owner: object, run: (t: Transcriber) => Promise<void>): void {
    this.partials.set(owner, () => run(this.counted));
    this.pump();
  }

  /** Forget an owner's waiting partial (its stream ended, or its stretch did). */
  drop(owner: object): void { this.partials.delete(owner); }

  get busy(): boolean { return this.running; }

  private readonly counted: Transcriber = (audio, options) => { this.calls++; return this.transcribe(audio, options); };

  private pump(): void {
    if (this.running) return;
    let job = this.finals.shift();
    if (!job) {
      const first = this.partials.entries().next();
      if (first.done) return;
      this.partials.delete(first.value[0]);
      job = first.value[1];
    }
    this.running = true;
    void job().catch(() => {}).finally(() => { this.running = false; this.pump(); });
  }
}

/**
 * One stream: what one press of a mic hears. `send` answers the window. Once it has said done (after end, cancel,
 * or a failure) it takes nothing more.
 */
export class VoiceStream {
  private readonly vad: Segmenter;
  /** Audio kept, as chunks from an absolute sample position. */
  private chunks: { at: number; samples: Float32Array }[] = [];
  private heard = 0;
  private ended = false;
  private finished = false;
  private cancelled = false;
  private waiting = 0;
  /** Samples held by finals waiting for the engine. */
  private queued = 0;
  private finals = 0;
  private lastPartialAt = 0;
  /** The open stretch's partials are for this stretch only: a later one's partial never shows an earlier one's words. */
  private stretch = 0;
  private speaking = false;

  constructor(
    private readonly send: (msg: VoiceOut) => void,
    private readonly queue: TranscribeQueue,
    private readonly language: string | null,
    vad: Partial<VadOptions> = {},
    private readonly onDone: () => void = () => {},
  ) {
    this.vad = new Segmenter(vad);
  }

  get done(): boolean { return this.finished; }

  /** A message from the window, as it came: checked here. */
  receive(raw: unknown): void {
    if (this.finished) return;
    const read = readVoiceIn(raw);
    if (!read.ok) { this.send({ type: 'error', code: read.code, message: read.message }); return; }
    const msg = read.msg;
    if (msg.type === 'cancel') { this.cancel(); return; }
    if (this.ended) {
      if (msg.type === 'audio') this.send({ type: 'error', code: 'after-end', message: 'Audio came after the stream ended; it was not heard.' });
      return;
    }
    if (msg.type === 'end') { this.end(); return; }
    this.audio(msg.samples);
  }

  /** The engine failed under this stream: say so, and stop. */
  fail(message: string): void {
    if (this.finished) return;
    this.send({ type: 'error', code: 'engine', message });
    this.cancel();
  }

  private audio(samples: Float32Array): void {
    if (this.heard + samples.length > VOICE_STREAM_MAX) {
      this.send({ type: 'error', code: 'too-long', message: 'Voice input listens for ten minutes at a time; it stopped there.' });
      this.end();
      return;
    }
    // A copy: the window's buffer was transferred, but a stand-in may reuse its own.
    this.chunks.push({ at: this.heard, samples: samples.slice() });
    this.heard += samples.length;
    if (this.kept() > VOICE_PENDING_MAX) {
      this.send({ type: 'error', code: 'too-much-audio', message: 'The speech engine fell more than two minutes behind, so listening stopped. What it heard is still being written.' });
      this.end();
      return;
    }
    for (const e of this.vad.push(samples)) this.event(e);
    this.trim();
    this.maybePartial();
  }

  private event(e: ReturnType<Segmenter['push']>[number]): void {
    if (e.type === 'start') {
      this.stretch++;
      this.lastPartialAt = e.start;
      this.speaking = true;
      this.send({ type: 'speech', speaking: true, at: msOf(e.start) });
      return;
    }
    this.speaking = false;
    this.queue.drop(this);
    this.send({ type: 'speech', speaking: false, at: msOf(e.end) });
    if (e.type === 'drop') { this.trim(); return; }
    const audio = this.slice(e.start, e.end);
    this.waiting++;
    this.queued += audio.length;
    this.queue.final(async (transcribe) => {
      try {
        if (this.cancelled) return;
        const text = cleanHeard(await transcribe(audio, { language: this.language }));
        if (this.cancelled) return;
        if (hasWords(text)) { this.finals++; this.send({ type: 'final', text, start: msOf(e.start), end: msOf(e.end) }); }
      } catch (error) {
        this.fail(`The speech engine could not transcribe: ${(error as Error)?.message ?? String(error)}`);
      } finally {
        this.waiting = Math.max(0, this.waiting - 1);
        this.queued = Math.max(0, this.queued - audio.length);
        this.maybeDone();
      }
    });
    this.trim();
  }

  /** While a stretch goes on, what it holds so far, when the engine is free and enough more has come. */
  private maybePartial(): void {
    const start = this.vad.openStart;
    if (start === null || this.ended || this.queue.busy) return;
    const now = this.heard;
    if (msOf(now - start) < PARTIAL_MIN_MS || msOf(now - this.lastPartialAt) < PARTIAL_EVERY_MS) return;
    this.lastPartialAt = now;
    const stretch = this.stretch;
    const audio = this.slice(start, now);
    this.queue.partial(this, async (transcribe) => {
      if (this.cancelled || this.ended || stretch !== this.stretch || !this.speaking) return;
      const text = cleanHeard(await transcribe(audio, { language: this.language }).catch(() => ''));
      if (this.cancelled || this.ended || stretch !== this.stretch || !this.speaking || !hasWords(text)) return;
      this.send({ type: 'partial', text, start: msOf(start), end: msOf(now) });
    });
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.queue.drop(this);
    for (const e of this.vad.flush()) this.event(e);
    this.maybeDone();
  }

  private cancel(): void {
    this.cancelled = true;
    this.ended = true;
    this.queue.drop(this);
    this.chunks = [];
    this.waiting = 0;
    this.queued = 0;
    this.maybeDone();
  }

  private maybeDone(): void {
    if (this.finished || !this.ended || this.waiting > 0) return;
    this.finished = true;
    this.chunks = [];
    this.send({ type: 'done', finals: this.finals, transcribed: this.queue.calls });
    this.onDone();
  }

  /** Audio held now, in samples: what is kept for the open stretch, and what waits for the engine. */
  private kept(): number {
    const first = this.chunks[0];
    return (first ? this.heard - first.at : 0) + this.queued;
  }

  /**
   * Drop audio nothing needs: before the open stretch, or with none open, all but the last two seconds (a stretch is
   * decided a third of a second late and may begin a second and a fifth before that). A final has its own copy.
   */
  private trim(): void {
    const open = this.vad.openStart;
    const keepFrom = open !== null ? open : Math.max(0, this.heard - VOICE_RATE * 2);
    while (this.chunks.length) {
      const c = this.chunks[0] as { at: number; samples: Float32Array };
      if (c.at + c.samples.length > keepFrom) break;
      this.chunks.shift();
    }
  }

  /** The samples [from, to), copied out of the chunks kept. */
  private slice(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    for (const c of this.chunks) {
      const a = Math.max(from, c.at);
      const b = Math.min(to, c.at + c.samples.length);
      if (b > a) out.set(c.samples.subarray(a - c.at, b - c.at), a - from);
    }
    return out;
  }
}
