// Finding the spoken stretches in a stream of 16 kHz audio, so that silence and
// noise never reach the speech model (every Whisper model invents words for
// them: "you", "thank you"). Energy-based, with a floor that follows the
// quietest moment around each frame (a second and a half before it, a third of
// a second after): speech is modulated (syllables, the gaps between words) and
// rises well above that floor, while steady noise (a fan, the hum of a room)
// sits on it, and digital silence is under an absolute floor. A stretch must
// hold for a fifth of a second of voiced frames to count, so a click or a tap
// does not, and its loud and quiet moments must differ as speech's do (noise
// that starts after silence rises over the old floor, but is steady once it
// has: Phase 1's speech held 12 to 27 dB between its loud and quiet frames,
// room noise under 4).
//
// Pure: it is given samples and answers events with sample positions; the
// engine (src/main/voice-engine.ts) keeps the audio and transcribes. Each frame
// is decided a third of a second after it is heard, so that the floor can see
// a little past it.
// Design: docs/design/2026-10-10-voice-input.md, "Silence and noise".
import { VOICE_RATE, VOICE_SEGMENT_MAX } from './voice.ts';

export interface VadOptions {
  /** Samples in a frame: 480 is 30 ms. */
  frame: number;
  /** A frame this far over the floor (dB) is voiced. */
  onDb: number;
  /** In a stretch, a frame under the floor plus this (dB) is quiet. */
  offDb: number;
  /** The floor never goes under this (dBFS): digital silence and a very quiet room are not a floor to rise over. */
  floorMinDb: number;
  /** Frames before a frame that its floor looks over for the quietest one. */
  floorFrames: number;
  /** Frames after a frame that its floor looks over too: how long a decision waits. */
  aheadFrames: number;
  /** Of the last five frames, this many voiced starts a stretch. */
  onFrames: number;
  /** Quiet this long (ms) ends a stretch. */
  hangMs: number;
  /** A stretch with fewer voiced milliseconds than this is dropped: a click, a tap, a breath. */
  minVoicedMs: number;
  /** A stretch whose loud frames (the 90th percentile) are fewer dB than this over its quiet ones (the 10th) is steady: noise, dropped. */
  minRangeDb: number;
  /** Audio kept before a stretch's first voiced frame (ms): a word's soft start. */
  prerollMs: number;
  /** Audio kept after a stretch's last loud frame (ms): a word's soft end. */
  padMs: number;
  /** The longest a stretch runs (samples) before it is cut, and a new one begins. */
  maxSamples: number;
}

export const VAD_DEFAULTS: VadOptions = {
  frame: 480, onDb: 10, offDb: 6, floorMinDb: -62, floorFrames: 50, aheadFrames: 10, onFrames: 3,
  hangMs: 650, minVoicedMs: 200, minRangeDb: 8, prerollMs: 200, padMs: 150, maxSamples: VOICE_SEGMENT_MAX,
};

/** A stretch began (at a sample), ended (its samples, start inclusive, end exclusive), or was too short to keep. */
export type VadEvent =
  | { type: 'start'; start: number }
  | { type: 'end'; start: number; end: number; voicedMs: number; cut: boolean }
  | { type: 'drop'; start: number; end: number; voicedMs: number };

/** A frame's energy in dBFS. */
export function frameDb(samples: Float32Array, from: number, length: number): number {
  let sum = 0;
  for (let i = from; i < from + length; i++) { const s = samples[i] as number; sum += s * s; }
  return 10 * Math.log10(sum / length + 1e-12);
}

export class Segmenter {
  private readonly o: VadOptions;
  /** Samples not yet a whole frame. */
  private carry = new Float32Array(0);
  /** Every frame's energy (dB) since the stream began: at most a stream's length (ten minutes is 20,000 numbers). */
  private readonly energies: number[] = [];
  /** The next frame to decide. */
  private next = 0;
  private recentLoud: boolean[] = [];
  /** The open stretch: its first sample, voiced and quiet frames, its last active sample, and its first loud frame. */
  private open: { start: number; voiced: number; quiet: number; lastActive: number; core: number } | null = null;
  /** Where the last stretch ended: the next one never starts before it. */
  private lastEnd = 0;

  constructor(options: Partial<VadOptions> = {}) {
    this.o = { ...VAD_DEFAULTS, ...options };
  }

  /** In a stretch now (as decided: a third of a second behind what was heard). */
  get speaking(): boolean { return this.open !== null; }
  /** The open stretch's first sample, or null. */
  get openStart(): number | null { return this.open?.start ?? null; }
  /** Samples decided so far. */
  get decided(): number { return this.next * this.o.frame; }
  /** The open stretch sounds like speech so far: voiced long enough, and its loud and quiet moments differ as speech's do. */
  get openSpeechLike(): boolean {
    const a = this.open;
    return !!a && this.ms(a.voiced) >= this.o.minVoicedMs && this.range(a.core, Math.ceil(a.lastActive / this.o.frame)) >= this.o.minRangeDb;
  }

  private ms(frames: number): number { return (frames * this.o.frame * 1000) / VOICE_RATE; }
  private samplesOf(ms: number): number { return Math.round((ms * VOICE_RATE) / 1000); }

  /** A frame's floor: the quietest frame around it, never under floorMinDb. */
  private floorAt(k: number): number {
    let min = Infinity;
    const to = Math.min(this.energies.length - 1, k + this.o.aheadFrames);
    for (let i = Math.max(0, k - this.o.floorFrames); i <= to; i++) min = Math.min(min, this.energies[i] as number);
    return Math.max(this.o.floorMinDb, min);
  }

  /** Hear more samples; answers what began and ended in what could be decided. */
  push(samples: Float32Array): VadEvent[] {
    const all = new Float32Array(this.carry.length + samples.length);
    all.set(this.carry);
    all.set(samples, this.carry.length);
    const f = this.o.frame;
    let i = 0;
    for (; i + f <= all.length; i += f) this.energies.push(frameDb(all, i, f));
    this.carry = all.slice(i);
    const events: VadEvent[] = [];
    while (this.next + this.o.aheadFrames < this.energies.length) this.decide(this.next++, events);
    return events;
  }

  /** The stream ended: the frames still waiting are decided, and an open stretch ends where the audio did. */
  flush(): VadEvent[] {
    const events: VadEvent[] = [];
    while (this.next < this.energies.length) this.decide(this.next++, events);
    if (this.open) this.close(Math.min(this.decided, this.open.lastActive + this.samplesOf(this.o.padMs)), events, false);
    return events;
  }

  private decide(k: number, events: VadEvent[]): void {
    const o = this.o;
    const db = this.energies[k] as number;
    const end = (k + 1) * o.frame;
    const floor = this.floorAt(k);
    const loud = db >= floor + o.onDb;
    this.recentLoud.push(loud);
    if (this.recentLoud.length > 5) this.recentLoud.shift();

    if (!this.open) {
      if (this.recentLoud.filter(Boolean).length < o.onFrames) return;
      // Begin where the voice began: back from the first loud frame of the five, across the short dips between
      // words, until a fifth of a second sits on the floor (a second back at most); then the pre-roll. Never before
      // the last stretch's end.
      const firstLoud = k - this.recentLoud.length + 1 + this.recentLoud.indexOf(true);
      const back = Math.ceil(VOICE_RATE / o.frame);
      const gap = Math.ceil(200 / this.ms(1));
      let first = firstLoud;
      let still = 0;
      for (let j = firstLoud - 1; j >= 0 && firstLoud - j <= back; j--) {
        if ((this.energies[j] as number) >= this.floorAt(j) + 3) { first = j; still = 0; } else if (++still >= gap) break;
      }
      const s = Math.max(this.lastEnd, first * o.frame - this.samplesOf(o.prerollMs), 0);
      this.open = { start: s, voiced: this.recentLoud.filter(Boolean).length, quiet: 0, lastActive: end, core: firstLoud };
      events.push({ type: 'start', start: s });
      return;
    }

    const a = this.open;
    if (loud) a.voiced++;
    if (db < floor + o.offDb) a.quiet++;
    else { a.quiet = 0; a.lastActive = end; }
    if (this.ms(a.quiet) >= o.hangMs) {
      this.close(Math.min(end, a.lastActive + this.samplesOf(o.padMs)), events, false);
      return;
    }
    if (end - a.start >= o.maxSamples) {
      // Too long for one hearing: this part ends here, and the voice goes on in a new stretch.
      this.close(end, events, true);
      this.open = { start: end, voiced: 0, quiet: 0, lastActive: end, core: k + 1 };
      events.push({ type: 'start', start: end });
    }
  }

  private close(at: number, events: VadEvent[], cut: boolean): void {
    const a = this.open;
    if (!a) return;
    this.open = null;
    this.recentLoud = [];
    const end = Math.max(a.start + 1, at);
    this.lastEnd = end;
    const voicedMs = this.ms(a.voiced);
    const keep = cut || (voicedMs >= this.o.minVoicedMs && this.range(a.core, Math.ceil(a.lastActive / this.o.frame)) >= this.o.minRangeDb);
    events.push(keep ? { type: 'end', start: a.start, end, voicedMs, cut } : { type: 'drop', start: a.start, end, voicedMs });
  }

  /**
   * How many dB a run of frames' loud ones (90th percentile) are over its quiet ones (10th): the stretch's voiced core,
   * never the quiet after it (noise that stops would otherwise look like speech against the silence that follows).
   */
  private range(from: number, to: number): number {
    const db = this.energies.slice(Math.max(0, from), Math.max(from + 1, to)).sort((x, y) => x - y);
    if (db.length < 2) return 0;
    const at = (q: number): number => db[Math.min(db.length - 1, Math.floor(q * db.length))] as number;
    return at(0.9) - at(0.1);
  }
}
