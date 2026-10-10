// Voice input in the window: what the main process says of it (settings,
// models, the engine), listening (the microphone through getUserMedia, an
// AudioContext at 16 kHz, an AudioWorklet's 100 ms chunks, sent to the voice
// worker over the MessagePort the main process hands this window), and the
// chords that reach the control of the box being typed in.
//
// One microphone, one listener at a time: starting another finishes the first.
// Nothing is sent anywhere but the voice worker on this computer, and the words
// it hears go into the box as ordinary text: nothing reaches an agent until
// the owner sends it.
// Design: docs/design/2026-10-10-voice-input.md.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { VoiceBridge } from '@shared/bridge';
import { endsVoiceHold, isVoiceHoldKey, isVoiceToggleKey, joinSpoken, type VoiceOut, type VoiceState } from '@shared/voice';
import workletUrl from '../voice/capture.worklet.ts?worker&url';
import { bridge } from './api';

export const voiceBridge = (): VoiceBridge | undefined => {
  try { return bridge().voice; } catch { return undefined; }
};

const isMac = (): boolean => { try { return bridge().platform === 'darwin'; } catch { return false; } };

/* ── what the main process says ─────────────────────────────────────────── */

let state: VoiceState | null = null;
const stateListeners = new Set<() => void>();
let subscribed = false;

function setState(next: VoiceState | null): void {
  if (!next) return;
  const before = state;
  state = next;
  for (const l of stateListeners) l();
  // The engine stopped by itself (a crash, its memory ceiling, a model that would not load) under a listener.
  if (run && run.port && before?.engine !== 'failed' && next.engine === 'failed') {
    const r = run;
    setProblem(r.owner, { kind: 'engine', message: next.engineError ?? 'The speech engine stopped.' });
    finishRun(r);
  }
}

function subscribe(): void {
  if (subscribed) return;
  const vb = voiceBridge();
  if (!vb) return;
  subscribed = true;
  vb.onState(setState);
  void vb.state().then(setState, () => {});
}

/** Voice input's state as the main process last told it; null before it has (or where there is no voice bridge). */
export function useVoiceState(): VoiceState | null {
  subscribe();
  return useSyncExternalStore((l) => { stateListeners.add(l); return () => stateListeners.delete(l); }, () => state);
}

/** Run a bridge call that answers the new state, and keep it. */
export async function voiceAct(act: (vb: VoiceBridge) => Promise<VoiceState | null>): Promise<VoiceState | null> {
  const vb = voiceBridge();
  if (!vb) return null;
  const next = await act(vb);
  setState(next);
  return next;
}

/* ── listening ──────────────────────────────────────────────────────────── */

/** What a control can say the owner can act on. */
export type ListenProblem =
  | { kind: 'no-model' }
  /** The microphone was refused: by the OS (`system`), or by the window's own answer. */
  | { kind: 'denied'; system: boolean }
  | { kind: 'no-mic' }
  /** It could not be opened: in use elsewhere, or (on Windows) turned off for desktop apps. */
  | { kind: 'busy' }
  | { kind: 'engine'; message: string }
  /** Listening stopped by itself, for a reason worth a sentence. */
  | { kind: 'notice'; message: string };

export interface Listening {
  owner: symbol;
  phase: 'starting' | 'listening' | 'finishing';
  /** The voice's loudness now, 0 to 1. */
  level: number;
  /** The engine hears speech now. */
  speaking: boolean;
  /** Words heard so far in the stretch still being spoken: shown, not yet in the box. */
  volatile: string;
}

let listening: Listening | null = null;
const problems = new Map<symbol, ListenProblem>();
const listenListeners = new Set<() => void>();
let listenVersion = 0;
const emitListen = (): void => { listenVersion++; for (const l of listenListeners) l(); };

function setListening(next: Listening | null): void { listening = next; emitListen(); }
function patchListening(owner: symbol, patch: Partial<Listening>): void {
  if (listening?.owner !== owner) return;
  listening = { ...listening, ...patch };
  emitListen();
}
function setProblem(owner: symbol, p: ListenProblem | null): void {
  if (p) problems.set(owner, p); else problems.delete(owner);
  emitListen();
}
export const clearProblem = (owner: symbol): void => setProblem(owner, null);

/** The listener now and, for an owner, its problem. `mine` is the listener when it is this owner's. */
export function useListening(owner: symbol): { mine: Listening | null; any: Listening | null; problem: ListenProblem | null } {
  useSyncExternalStore((l) => { listenListeners.add(l); return () => listenListeners.delete(l); }, () => listenVersion);
  return { mine: listening?.owner === owner ? listening : null, any: listening, problem: problems.get(owner) ?? null };
}

interface Run {
  owner: symbol;
  onFinal: (text: string, at: number) => void;
  stream: MediaStream | null;
  ctx: AudioContext | null;
  node: AudioWorkletNode | null;
  port: MessagePort | null;
  queue: Float32Array[];
  /** The wall-clock time of the stream's first sample. */
  t0: number | null;
  level: number;
  doneTimer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
  resolve: () => void;
}

let run: Run | null = null;

/* Ports from the main process, by stream id: one may arrive before the call that asked for it has answered. */
const arrived = new Map<string, MessagePort>();
const waiting = new Map<string, (port: MessagePort) => void>();
let portsHeard = false;
function hearPorts(): void {
  if (portsHeard) return;
  portsHeard = true;
  window.addEventListener('message', (e) => {
    const data = e.data as { wanigan?: unknown; id?: unknown } | null;
    if (e.source !== window || !data || data.wanigan !== 'voice-port' || typeof data.id !== 'string') return;
    const port = e.ports[0];
    if (!port) return;
    const id = data.id;
    const take = waiting.get(id);
    if (take) { waiting.delete(id); take(port); return; }
    arrived.set(id, port);
    // A port nobody claims (its listener was cancelled first) is closed, not kept.
    setTimeout(() => { if (arrived.get(id) === port) { arrived.delete(id); port.postMessage({ type: 'cancel' }); port.close(); } }, 10_000);
  });
}

function portFor(id: string, ms: number): Promise<MessagePort | null> {
  const there = arrived.get(id);
  if (there) { arrived.delete(id); return Promise.resolve(there); }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, ms);
    waiting.set(id, (port) => { clearTimeout(timer); resolve(port); });
  });
}

/** What getUserMedia's refusal means for the owner. */
export function micProblem(error: unknown, platform: string): ListenProblem {
  const name = (error as { name?: string })?.name ?? '';
  const message = String((error as { message?: string })?.message ?? '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return { kind: 'denied', system: /system/i.test(message) };
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return { kind: 'no-mic' };
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return platform === 'win32' ? { kind: 'denied', system: true } : { kind: 'busy' };
  return { kind: 'engine', message: `The microphone could not start${message ? `: ${message}` : '.'}` };
}

function stopCapture(r: Run): void {
  for (const t of r.stream?.getTracks() ?? []) t.stop();
  r.stream = null;
  try { r.node?.disconnect(); } catch { /* gone */ }
  if (r.node) r.node.port.onmessage = null;
  r.node = null;
  void r.ctx?.close().catch(() => {});
  r.ctx = null;
}

function finishRun(r: Run): void {
  if (r.doneTimer) clearTimeout(r.doneTimer);
  r.doneTimer = null;
  stopCapture(r);
  if (r.port) { r.port.onmessage = null; r.port.close(); }
  r.port = null;
  if (run === r) { run = null; setListening(null); }
  r.resolve();
}

function chunk(r: Run, samples: Float32Array): void {
  if (run !== r) return;
  if (r.t0 === null) r.t0 = Date.now() - (samples.length * 1000) / 16_000;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] as number) ** 2;
  const db = 10 * Math.log10(sum / samples.length + 1e-12);
  r.level = Math.max(Math.min(1, Math.max(0, (db + 55) / 45)), r.level * 0.6);
  patchListening(r.owner, { level: Math.round(r.level * 20) / 20 });
  if (r.port) r.port.postMessage({ type: 'audio', samples }, [samples.buffer]);
  else if (r.queue.length < 100) r.queue.push(samples);
}

function heard(r: Run, raw: unknown): void {
  if (run !== r && listening?.owner !== r.owner) return;
  const msg = raw as VoiceOut | null;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'speech': patchListening(r.owner, { speaking: msg.speaking }); return;
    case 'partial': patchListening(r.owner, { volatile: msg.text }); return;
    case 'final': {
      patchListening(r.owner, { volatile: '' });
      try { r.onFinal(msg.text, (r.t0 ?? Date.now()) + msg.start); } catch { /* the box went away */ }
      return;
    }
    case 'error':
      if (msg.code === 'engine') { setProblem(r.owner, { kind: 'engine', message: msg.message }); finishRun(r); }
      else if (msg.code === 'too-long' || msg.code === 'too-much-audio') { setProblem(r.owner, { kind: 'notice', message: msg.message }); stopCapture(r); patchListening(r.owner, { phase: 'finishing' }); }
      return;
    case 'done': finishRun(r); return;
  }
}

/**
 * Listen for an owner (a control): each final goes to `onFinal` with the wall-clock time its words began. Answers once
 * listening has started, or failed (the owner's problem then says why).
 */
export async function startListening(owner: symbol, onFinal: (text: string, at: number) => void): Promise<void> {
  if (run?.owner === owner) return;
  if (run) await stopListening(run.owner, 'finish');
  const vb = voiceBridge();
  if (!vb) return;
  hearPorts();
  setProblem(owner, null);
  const s = state ?? await vb.state().catch(() => null);
  setState(s);
  const model = s?.models.find((m) => m.id === s.settings.model);
  if (!model?.ready) { setProblem(owner, { kind: 'no-model' }); return; }

  let resolve = (): void => {};
  const done = new Promise<void>((r) => { resolve = r; });
  const r: Run = { owner, onFinal, stream: null, ctx: null, node: null, port: null, queue: [], t0: null, level: 0, doneTimer: null, done, resolve };
  run = r;
  setListening({ owner, phase: 'starting', level: 0, speaking: false, volatile: '' });

  const media = navigator.mediaDevices?.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      .then((stream) => ({ ok: true as const, stream }), (error: unknown) => ({ ok: false as const, error }))
    : Promise.resolve({ ok: false as const, error: Object.assign(new Error('This window has no microphone API.'), { name: 'NotFoundError' }) });
  const started = vb.start().catch((e: Error) => ({ ok: false as const, code: 'engine' as const, message: e?.message ?? String(e) }));
  const [mic, stream] = await Promise.all([media, started]);
  const drop = (): void => {
    if (mic.ok) for (const t of mic.stream.getTracks()) t.stop();
    if (stream.ok) void portFor(stream.id, 2_000).then((p) => { p?.postMessage({ type: 'cancel' }); p?.close(); });
  };
  if (run !== r) { drop(); r.resolve(); return; }
  if (!stream.ok) {
    drop();
    setProblem(owner, stream.code === 'no-model' ? { kind: 'no-model' } : { kind: 'engine', message: stream.message });
    finishRun(r);
    return;
  }
  if (!mic.ok) {
    drop();
    setProblem(owner, micProblem(mic.error, s?.platform ?? bridge().platform));
    finishRun(r);
    return;
  }
  r.stream = mic.stream;
  try {
    const ctx = new AudioContext({ sampleRate: 16_000 });
    r.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl);
    if (run !== r) { finishRun(r); return; }
    const source = ctx.createMediaStreamSource(mic.stream);
    // No outputs: a node that only listens, pulled by the context on its own.
    const node = new AudioWorkletNode(ctx, 'wanigan-voice-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    node.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => chunk(r, e.data.samples);
    source.connect(node);
    r.node = node;
    if (ctx.state === 'suspended') await ctx.resume();
  } catch (e) {
    drop();
    setProblem(owner, { kind: 'engine', message: `The microphone's audio could not be read: ${(e as Error)?.message ?? String(e)}` });
    finishRun(r);
    return;
  }
  patchListening(owner, { phase: 'listening' });
  const port = await portFor(stream.id, 10_000);
  if (run !== r) { port?.postMessage({ type: 'cancel' }); port?.close(); return; }
  if (!port) {
    setProblem(owner, { kind: 'engine', message: 'The speech engine did not answer.' });
    finishRun(r);
    return;
  }
  r.port = port;
  port.onmessage = (e) => heard(r, e.data);
  port.start();
  for (const samples of r.queue.splice(0)) port.postMessage({ type: 'audio', samples }, [samples.buffer]);
}

/** Stop listening for an owner: `finish` writes what was still being said; `cancel` drops it. */
export function stopListening(owner: symbol, how: 'finish' | 'cancel' = 'finish'): Promise<void> {
  const r = run;
  if (!r || r.owner !== owner) return Promise.resolve();
  stopCapture(r);
  if (how === 'cancel' || !r.port) {
    r.port?.postMessage({ type: 'cancel' });
    // Still starting: the start sees it is no longer the listener and lets its port go.
    finishRun(r);
    return r.done;
  }
  r.port.postMessage({ type: 'end' });
  patchListening(owner, { phase: 'finishing', level: 0 });
  r.doneTimer = setTimeout(() => { r.port?.postMessage({ type: 'cancel' }); finishRun(r); }, 30_000);
  return r.done;
}

/* ── words into a box ───────────────────────────────────────────────────── */

export type VoiceBox = HTMLTextAreaElement | HTMLInputElement;

/**
 * Put spoken words in a box at its caret, as typing would: undoable where the box has focus, and seen by React as an
 * edit either way. False when the box cannot take them (gone, disabled, read-only, full).
 */
export function insertSpoken(el: VoiceBox, text: string): boolean {
  if (!el.isConnected || el.disabled || el.readOnly) return false;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  let piece = joinSpoken(el.value.slice(0, start), text, el instanceof HTMLInputElement);
  if (el.maxLength > 0) piece = piece.slice(0, Math.max(0, el.maxLength - (el.value.length - (end - start))));
  if (!piece) return false;
  // execCommand is the one way that keeps ⌘Z working; it needs the box focused.
  if (document.activeElement === el && document.execCommand('insertText', false, piece)) return true;
  el.setRangeText(piece, start, end, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/* ── the chords ─────────────────────────────────────────────────────────── */

export interface VoiceTarget {
  owner: symbol;
  /** The box it writes into (null: it writes elsewhere, as narration does). */
  box: () => HTMLElement | null;
  /** What it is, where nothing is typed into: narration while recording (2) beats a box (1). */
  rank: () => number;
  /** Whether it is shown now. */
  shown: () => boolean;
  toggle: () => void;
  hold: (down: boolean) => void;
}

const targets = new Map<symbol, { t: VoiceTarget; at: number; used: number }>();
let holding: VoiceTarget | null = null;
let keysOn = false;

const typingIn = (el: Element | null): boolean => !!el && el !== document.body
  && ((el as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest('.xterm, .cm-editor'));

/** The control a chord reaches: the one whose box is typed in; else, with nothing typed into, the one shown that ranks highest, used last. */
export function voiceTargetNow(options: { exclude?: symbol; boxes?: boolean } = {}): VoiceTarget | undefined {
  const active = document.activeElement;
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].pop() ?? null;
  const all = [...targets.values()].filter(({ t }) => t.owner !== options.exclude && (!options.boxes || t.box()));
  for (const { t } of all) {
    const box = t.box();
    if (box && active && (box === active || box.contains(active))) return t;
  }
  if (typingIn(active)) return undefined;
  return all
    .filter(({ t }) => t.shown() && (!modal || (t.box() !== null && modal.contains(t.box()))))
    .sort((a, b) => b.t.rank() - a.t.rank() || b.used - a.used || b.at - a.at)[0]?.t;
}

function installKeys(): void {
  if (keysOn) return;
  keysOn = true;
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const mac = isMac();
    const toggle = isVoiceToggleKey(e, mac);
    const hold = isVoiceHoldKey(e, mac);
    if (!toggle && !hold) return;
    if (e.repeat) { if (holding || toggle) e.preventDefault(); return; }
    const t = voiceTargetNow();
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const entry = targets.get(t.owner);
    if (entry) entry.used = Date.now();
    if (toggle) t.toggle();
    else { holding = t; t.hold(true); }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (!holding || !endsVoiceHold(e, isMac())) return;
    const t = holding;
    holding = null;
    t.hold(false);
  }, true);
  window.addEventListener('blur', () => { if (holding) { const t = holding; holding = null; t.hold(false); } });
}

let order = 0;
/** Make a control reachable by the chords while it is mounted. */
export function useVoiceTarget(target: VoiceTarget | null): void {
  const latest = useRef(target);
  latest.current = target;
  const owner = target?.owner ?? null;
  useEffect(() => {
    if (!owner) return undefined;
    installKeys();
    const proxy: VoiceTarget = {
      owner,
      box: () => latest.current?.box() ?? null,
      rank: () => latest.current?.rank() ?? 0,
      shown: () => latest.current?.shown() ?? false,
      toggle: () => latest.current?.toggle(),
      hold: (down) => latest.current?.hold(down),
    };
    targets.set(owner, { t: proxy, at: ++order, used: 0 });
    return () => { targets.delete(owner); if (holding?.owner === owner) holding = null; };
  }, [owner]);
}

/** Note that a control was used (pressed), so a chord with nothing typed into goes back to it. */
export function markVoiceUsed(owner: symbol): void {
  const entry = targets.get(owner);
  if (entry) entry.used = Date.now();
}
