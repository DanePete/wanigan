// Recording the live view: what its step log holds, how each step is made safe
// before it is kept, the key frames an agent is shown, and the words an agent
// reads. Pure, so the main process (which keeps a recording), the window (which
// shows it and sends it) and the tests read it alike.
//
// A step comes from the page script (clicks, keys, scrolls) or the main process
// (navigations, console errors, requests): either way it is untrusted until
// cleanStep() has it. What is never kept, whatever a step carries: a key or the
// words typed in a password field (or a one-time code or card field), a
// request's or a response's body, its headers or cookies, an address's query
// or credentials. Design: docs/design/2026-10-08-live-view.md, "Snap and Record".

/** The longest a recording runs; it stops itself there. */
export const RECORD_MAX_MS = 120_000;
/** About five frames a second: the fastest a frame is kept. */
export const RECORD_FRAME_MS = 200;
/** The most frames one recording keeps (two minutes at five a second, and a little room). */
export const RECORD_MAX_FRAMES = 620;
/** The most steps one recording keeps; past it, the log says it was cut. */
export const RECORD_MAX_STEPS = 400;
/** The most key frames an agent is sent. */
export const KEY_FRAMES_MAX = 8;
/** A request that took this long is logged as slow even when it worked. */
export const SLOW_REQUEST_MS = 1_000;
/** The recordings a project keeps in Wanigan's data; starting another takes the oldest away. */
export const RECORDINGS_KEPT = 5;

/**
 * One thing that happened while the view was recorded. `at` is milliseconds from the recording's start.
 * `said` is narration (voice input, when it is on): what the owner said, as they said it.
 */
export type LiveStep =
  | { type: 'click'; at: number; x: number; y: number; target: string; selector: string | null; part: string | null; made: string | null }
  | { type: 'key'; at: number; key: string | null; secret: boolean; target: string | null }
  | { type: 'typed'; at: number; text: string | null; secret: boolean; target: string | null }
  | { type: 'scroll'; at: number; y: number; height: number }
  | { type: 'navigate'; at: number; path: string; status: number | null; inPage: boolean }
  | { type: 'console'; at: number; text: string }
  | { type: 'request'; at: number; method: string; path: string; status: number | null; error: string | null; ms: number | null }
  | { type: 'said'; at: number; text: string };

export type LiveStepType = LiveStep['type'];

/** Named keys a step may name; any other key that is not one character is kept as "a key". */
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ']);

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : null); // eslint-disable-line no-control-regex
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const whole = (v: unknown, min: number, max: number): number | null => { const n = num(v); return n === null ? null : Math.max(min, Math.min(max, Math.round(n))); };

/**
 * An address as the log keeps it: its path, and its host only when it is not the site's own; never its query, its
 * fragment or any credentials in it (a query can carry a token). `site` is the site's host.
 */
export function pathOnly(raw: unknown, site: string | null): string {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const u = new URL(raw);
    if (!/^https?:$|^wss?:$/.test(u.protocol)) return u.protocol.replace(/:$/, '');
    const path = u.pathname.slice(0, 300);
    return site && u.host.toLowerCase() === site.toLowerCase() ? path : `${u.host}${path}`;
  } catch {
    // A path already: still no query.
    return raw.startsWith('/') ? raw.split(/[?#]/)[0]!.slice(0, 300) : '';
  }
}

/**
 * A step as it may be kept, or null for one that is not a step. `startedAt` turns an absolute time (the page's and
 * main's clock, `Date.now()`) into one from the recording's start; `site` is the site's host, for addresses.
 * Whatever else a raw step carries is dropped: only the fields of its type are read.
 */
export function cleanStep(raw: unknown, startedAt: number, site: string | null): LiveStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const when = num(r.time);
  const at = Math.max(0, Math.min(RECORD_MAX_MS, Math.round(when !== null ? when - startedAt : num(r.at) ?? 0)));
  const secret = r.secret === true;
  switch (r.type) {
    case 'click': {
      const x = whole(r.x, 0, 100_000); const y = whole(r.y, 0, 100_000);
      if (x === null || y === null) return null;
      return { type: 'click', at, x, y, target: str(r.target, 160) || 'the page', selector: str(r.selector, 300), part: str(r.part, 200), made: str(r.made, 300) };
    }
    case 'key': {
      const key = typeof r.key === 'string' ? r.key : null;
      // A secret field's keys are never kept, nor whether it was Enter: only that a key was pressed there.
      const kept = secret || !key ? null : NAMED_KEYS.has(key) ? key : key.length === 1 ? key : 'a key';
      return { type: 'key', at, key: kept, secret, target: str(r.target, 160) };
    }
    case 'typed':
      return { type: 'typed', at, text: secret ? null : str(r.text, 200), secret, target: str(r.target, 160) };
    case 'scroll': {
      const y = whole(r.y, 0, 10_000_000); const height = whole(r.height, 0, 10_000_000);
      return y === null ? null : { type: 'scroll', at, y, height: height ?? 0 };
    }
    case 'navigate': {
      const path = pathOnly(r.url ?? r.path, site);
      return path ? { type: 'navigate', at, path, status: whole(r.status, 0, 999) || null, inPage: r.inPage === true } : null;
    }
    case 'console': {
      const t = str(r.text, 400);
      return t ? { type: 'console', at, text: t } : null;
    }
    case 'request': {
      const method = typeof r.method === 'string' && /^[A-Z]{3,7}$/.test(r.method) ? r.method : 'GET';
      const path = pathOnly(r.url ?? r.path, site);
      if (!path) return null;
      const status = whole(r.status, 0, 999) || null;
      const error = typeof r.error === 'string' ? (/net::[A-Z_]+|ERR_[A-Z_]+/.exec(r.error)?.[0] ?? 'failed') : null;
      return { type: 'request', at, method, path, status, error, ms: whole(r.ms, 0, 3_600_000) };
    }
    case 'said': {
      const t = str(r.text, 2_000);
      return t ? { type: 'said', at, text: t } : null;
    }
    default:
      return null;
  }
}

/** Whether a request step is worth keeping: it failed, or it was slow. */
export function requestWorthKeeping(status: number | null, error: string | null, ms: number | null): boolean {
  if (error && !/ERR_ABORTED/.test(error)) return true;
  if (status !== null && status >= 400) return true;
  return ms !== null && ms >= SLOW_REQUEST_MS;
}

/** A step that is an error: a console error, or a request that failed. */
export const isErrorStep = (s: LiveStep): s is Extract<LiveStep, { type: 'console' | 'request' }> =>
  s.type === 'console' || (s.type === 'request' && (s.error !== null || (s.status ?? 0) >= 400));

/** A time from the start as the log writes it: m:ss.s */
export function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

/** How long, as the review and the message say it: 0:42, 1:05. */
export function length(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const grouped = (n: number): string => n.toLocaleString('en-US');

/** What a part is called in a step: the trace's own name for it when the window knows the trace. */
export type PartNamer = (partId: string) => { label: string; kind?: string } | null;

/** One step as a line of the log. */
export function stepText(s: LiveStep, partName: PartNamer = () => null): string {
  switch (s.type) {
    case 'click': {
      const part = s.part ? partName(s.part) : null;
      const what = [part ? `${part.label}${part.kind ? `, ${part.kind}` : ''}` : null, s.made].filter(Boolean).join('; ');
      return `Clicked ${s.target}${what ? ` (in ${what})` : ''} at ${s.x}, ${s.y}`;
    }
    case 'key':
      return s.secret ? `Pressed a key in a password field${s.target ? ` (${s.target})` : ''}; the key is not kept`
        : `Pressed ${s.key === ' ' ? 'Space' : s.key ?? 'a key'}${s.target ? ` in ${s.target}` : ''}`;
    case 'typed':
      return s.secret ? `Typed in a password field${s.target ? ` (${s.target})` : ''}; the keys are not kept`
        : `Typed “${s.text ?? ''}”${s.target ? ` in ${s.target}` : ''}`;
    case 'scroll':
      return s.height ? `Scrolled to ${grouped(s.y)} px of ${grouped(s.height)}` : `Scrolled to ${grouped(s.y)} px`;
    case 'navigate':
      return s.inPage ? `The address became ${s.path} (on the same page)` : `Went to ${s.path}${s.status ? ` (${s.status})` : ''}`;
    case 'console':
      return `Console error: ${s.text}`;
    case 'request': {
      const took = s.ms !== null ? `${grouped(s.ms)} ms` : null;
      if (s.error) return `Request failed: ${s.method} ${s.path}, ${s.error}${took ? ` after ${took}` : ''}`;
      if ((s.status ?? 0) >= 400) return `Request failed: ${s.method} ${s.path} answered ${s.status}${took ? ` in ${took}` : ''}`;
      return `Slow request: ${s.method} ${s.path} answered ${s.status ?? 'ok'} in ${took ?? 'a long time'}`;
    }
    case 'said':
      return `Said: “${s.text}”`;
  }
}

/** The step log as text, one line per step: its time from the start, then what happened. */
export function stepLogText(steps: readonly LiveStep[], partName: PartNamer = () => null): string {
  return steps.map((s) => `${clock(s.at)}  ${stepText(s, partName)}`).join('\n');
}

/** A key frame: which of the recording's frames, the step that chose it (null for the first or last frame), and why. */
export interface KeyFrameChoice { frame: number; at: number; step: number | null; why: string }

/**
 * The key frames an agent is shown, at most `max`: at each click (the frame the owner clicked on), each navigation
 * (the page once it came) and each error (as it happened). With more moments than room, errors first, then
 * navigations, then clicks, each kind spread evenly over the recording; in time order. With no such moment, the
 * first frame and the last. `frames` are the recording's frames in time order.
 */
export function chooseKeyFrames(steps: readonly LiveStep[], frames: readonly { at: number }[], max = KEY_FRAMES_MAX): KeyFrameChoice[] {
  if (!frames.length || max <= 0) return [];
  /** The frame showing the page at a time: the last one taken at or before it (the first when none was). */
  const before = (t: number): number => { let f = 0; for (let i = 0; i < frames.length; i++) if ((frames[i] as { at: number }).at <= t) f = i; return f; };
  /** The first frame taken at or after a time (the last when none was). */
  const after = (t: number): number => { const i = frames.findIndex((f) => f.at >= t); return i < 0 ? frames.length - 1 : i; };
  type Moment = { frame: number; step: number; rank: number; why: string };
  const moments: Moment[] = [];
  steps.forEach((s, i) => {
    if (s.type === 'click') moments.push({ frame: before(s.at), step: i, rank: 1, why: `clicked ${s.target}` });
    else if (s.type === 'navigate') moments.push({ frame: after(s.at + (s.inPage ? 200 : 800)), step: i, rank: 2, why: s.inPage ? `the address became ${s.path}` : `went to ${s.path}` });
    else if (isErrorStep(s)) moments.push({ frame: after(s.at), step: i, rank: 3, why: s.type === 'console' ? 'a console error' : `a request failed (${s.path})` });
  });
  if (!moments.length) {
    const ends = [0, frames.length - 1].filter((f, i, all) => all.indexOf(f) === i);
    return ends.slice(0, max).map((f) => ({ frame: f, at: (frames[f] as { at: number }).at, step: null, why: f === 0 ? 'as it began' : 'as it ended' }));
  }
  // One moment per frame: the highest-ranked reason names it.
  const byFrame = new Map<number, Moment>();
  for (const m of moments) {
    const was = byFrame.get(m.frame);
    if (!was || m.rank > was.rank) byFrame.set(m.frame, m);
  }
  const unique = [...byFrame.values()];
  let chosen: Moment[];
  if (unique.length <= max) chosen = unique;
  else {
    chosen = [];
    for (const rank of [3, 2, 1]) {
      const room = max - chosen.length;
      if (room <= 0) break;
      const these = unique.filter((m) => m.rank === rank).sort((a, b) => a.frame - b.frame);
      chosen.push(...spread(these, room));
    }
  }
  return chosen.sort((a, b) => a.frame - b.frame)
    .map((m) => ({ frame: m.frame, at: (frames[m.frame] as { at: number }).at, step: m.step, why: m.why }));
}

/** `n` of a list, spread evenly from its first to its last. */
function spread<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  if (n === 1) return [list[0] as T];
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))] as T);
}

/** What the composer is filled with for a recording: where, how long, the key frames attached, and the step log. */
export function recordContext(r: {
  url: string; viewWidth: number | null; ms: number; steps: readonly LiveStep[];
  keyFrames: readonly { at: number; why: string }[]; cut: boolean; partName?: PartNamer;
}): string {
  const lines = [
    `Recorded in the live view of ${r.url}${r.viewWidth ? ` (the view ${r.viewWidth} px wide)` : ''}, ${length(r.ms)} long.`,
  ];
  if (r.keyFrames.length) {
    lines.push(`Key frames attached, in order: ${r.keyFrames.map((k, i) => `${i + 1} at ${clock(k.at)} (${k.why})`).join('; ')}.`);
  }
  lines.push('The video stays with the owner: an agent gets these pictures and this log, not the video.');
  lines.push('', r.steps.length ? 'Steps, from the start:' : 'No steps were logged: nothing was clicked, typed, loaded or reported.');
  if (r.steps.length) lines.push(stepLogText(r.steps, r.partName));
  if (r.cut) lines.push(`(The log stops at ${RECORD_MAX_STEPS} steps.)`);
  return lines.join('\n');
}
