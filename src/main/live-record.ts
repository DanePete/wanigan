// Record, the main process's side: a recording of the live view and nothing
// else. Frames come from the view's own frame subscription
// (webContents.beginFrameSubscription: Chromium's compositor hands over what it
// drew), never from a screen capture, so no system permission is asked on any
// operating system, and nothing outside the view is ever in a frame. At most
// two minutes, about five frames a second; a page that sits still gives no
// frames, and the clip shows the last one until it moves.
//
// While it records, the step log is kept from two sides: the page script
// (live-page-record.ts: clicks with the element and the part under it, keys,
// typing, scrolls), asked in turn as a pick is, and this process (navigations,
// console errors, and requests that failed or were slow, from the view's
// session as live-view.ts reports them). Every step goes through cleanStep()
// (src/shared/live-record.ts): no password field's keys, no body, header,
// cookie or query is ever kept.
//
// When it stops (its control or key, Escape on the page, the two-minute limit,
// the view going away or showing another project), the frames are encoded into
// a WebM clip by Chromium's own VP8 encoder (WebCodecs) in a hidden window that
// loads a blank page from the recording's folder (a file page is a secure
// context, which WebCodecs needs; about:blank is not), muxed by
// src/shared/webm.ts; up to eight key frames are chosen and the click on each
// is ringed; the step log is written beside them. All of it lives in Wanigan's
// data for the project, <data>/live-recordings/<project>/<id>/, never in the
// site's files: clip.webm, frame-1.jpg … frame-8.jpg, recording.json. The same
// limits as attachments hold (a file at most 20 MB, ten files and 50 MB in
// all), and a project keeps its last five recordings. An agent gets the key
// frames and the log only, through the note composer, on the owner's click.
// Design: docs/design/2026-10-08-live-view.md, "Snap and Record".
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, NativeImage, WebContents } from 'electron';
import { ATTACH_MAX_BYTES } from '../shared/attachments.ts';
import type { LiveRecordState, LiveRecordStop, LiveRecording } from '../shared/bridge.ts';
import {
  KEY_FRAMES_MAX, RECORDINGS_KEPT, RECORD_FRAME_MS, RECORD_MAX_FRAMES, RECORD_MAX_MS, RECORD_MAX_STEPS,
  chooseKeyFrames, cleanStep, requestWorthKeeping, type LiveStep,
} from '../shared/live-record.ts';
import { webm } from '../shared/webm.ts';
import { deadline, folderOf } from './live-capture.ts';
import type { LiveCurrent, LiveRequestSeen } from './live-view.ts';

/** The frames waiting to be encoded, at most: a page that never stops moving reaches it before two minutes do. */
const RAW_MAX_BYTES = 150 * 1024 * 1024;
/** The widest a frame is kept: a wider view is scaled down to it. */
const FRAME_MAX_WIDTH = 1280;
/** What the clip may spend: 800 kbit/s is at most 12 MB for two minutes, under an attachment's 20 MB. */
const CLIP_BITRATE = 800_000;
/** A key frame every few seconds, so the clip can be seeked. */
const KEY_EVERY_MS = 4_000;
/** One step of the encoder's work, and the whole of it. */
const ENCODE_STEP_MS = 20_000;
const ENCODE_ALL_MS = 300_000;
const ID = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{6}$/;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A frame kept while recording: when, and the JPEG in the recording's raw folder. */
interface Frame { at: number; file: string; width: number; height: number }

interface Active {
  /** Recording now: frames and steps are taken. Once stopped, only the page's last steps are. */
  open: boolean;
  id: string;
  projectId: string;
  wc: WebContents;
  url: string;
  /** The site's host, for the paths of addresses. */
  site: string | null;
  startedAt: number;
  viewWidth: number | null;
  folder: string;
  raw: string;
  frames: Frame[];
  steps: LiveStep[];
  cut: boolean;
  /** The last frame kept, and the newest one waiting for its turn. */
  lastAt: number;
  waiting: NativeImage | null;
  waitTimer: ReturnType<typeof setTimeout> | null;
  limitTimer: ReturnType<typeof setTimeout> | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  /** Requests begun, by id: when, so a slow one can be told. */
  requests: Map<number, number>;
  writes: Promise<unknown>[];
  bytes: number;
  off: (() => void)[];
}

/** What encoding is given and gives back: a hidden window in the app, a stand-in in a test. */
export interface EncodeJob {
  folder: string;
  frames: readonly Frame[];
  ms: number;
  /** For each key frame: the frame, and where to ring a click on it (in the frame's pixels), if one chose it. */
  marks: readonly { frame: number; ring: { x: number; y: number } | null }[];
}
export interface Encoded {
  clip: { bytes: Uint8Array; width: number; height: number; frames: number } | null;
  clipWhy: string | null;
  /** The key frames as JPEG, in the order of `marks` (null: copy the frame as it is). */
  marked: (Uint8Array | null)[];
}
export type Encoder = (job: EncodeJob) => Promise<Encoded>;

/** A recording's id: when it began, and six random hex digits. Names its folder, so oldest sorts first. */
function newId(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${randomBytes(3).toString('hex')}`;
}

/** Where a project's recordings are kept: in Wanigan's data, never in the project. */
export function recordingsFolder(dataDir: string, projectId: string): string {
  return join(dataDir, 'live-recordings', folderOf(projectId));
}

/** Take a project's oldest recordings away so that `keep` remain. Answers the ids taken. */
export function pruneRecordings(dataDir: string, projectId: string, keep: number): string[] {
  const root = recordingsFolder(dataDir, projectId);
  let ids: string[];
  try { ids = readdirSync(root).filter((n) => ID.test(n)).sort(); } catch { return []; }
  const gone = ids.slice(0, Math.max(0, ids.length - keep));
  for (const id of gone) rmSync(join(root, id), { recursive: true, force: true });
  return gone;
}

/** Make a folder (and its parents) private to the owner. */
function privateFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function wireLiveRecord(options: {
  ipc: Pick<IpcMain, 'handle'>;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  enabled: () => boolean;
  dataDir: string;
  window: () => BrowserWindow | null;
  current: () => LiveCurrent | null;
  run: <T>(code: string, fallback: T) => Promise<T>;
  /** The view's width in CSS pixels, as the window laid it out. */
  width: (projectId: string) => number | null;
  /** Show a file in the system's file manager (Electron's shell.showItemInFolder). */
  reveal: (path: string) => void;
  /** The encoder: a hidden window by default. */
  encode?: Encoder;
  now?: () => number;
}): {
  hooks: { view(wc: WebContents | null, projectId: string | null): void; request(seen: LiveRequestSeen): void };
  stop(why: LiveRecordStop): Promise<LiveRecording | null>;
} {
  const { ipc } = options;
  const now = options.now ?? Date.now;
  const encode = options.encode ?? encodeInWindow;
  let active: Active | null = null;
  /** The recording being saved, while it is. */
  let saving: Promise<LiveRecording | null> | null = null;
  let done: LiveRecording | null = null;
  let error: string | null = null;

  const state = (): LiveRecordState => ({
    on: !!active, projectId: active?.projectId ?? done?.projectId ?? null, startedAt: active?.startedAt ?? null, limitMs: RECORD_MAX_MS,
    frames: active?.frames.length ?? 0, steps: active?.steps.length ?? 0, saving: !!saving, done: active ? null : done, error,
  });
  const tell = (): void => {
    const w = options.window();
    if (w && !w.isDestroyed()) w.webContents.send('live:record', state());
  };

  /** One step, checked; `late`: the page's last steps, taken after the recording stopped. */
  const step = (a: Active, raw: unknown, late = false): void => {
    if (!a.open && !late) return;
    const s = cleanStep(raw, a.startedAt, a.site);
    if (!s) return;
    if (a.steps.length >= RECORD_MAX_STEPS) { a.cut = true; return; }
    a.steps.push(s);
  };

  /** Keep a frame: at the view's own CSS size (a Retina frame is halved), at most FRAME_MAX_WIDTH, as a JPEG. */
  const keep = (a: Active, image: NativeImage, at: number, late = false): void => {
    if ((!a.open && !late) || a.frames.length >= RECORD_MAX_FRAMES || image.isEmpty()) return;
    const size = image.getSize();
    const css = a.viewWidth && a.viewWidth > 0 && a.viewWidth < size.width ? a.viewWidth : size.width;
    const width = Math.min(css, FRAME_MAX_WIDTH);
    const scaled = width < size.width ? image.resize({ width, quality: 'good' }) : image;
    const jpeg = scaled.toJPEG(80);
    const s = scaled.getSize();
    if (a.bytes + jpeg.length > RAW_MAX_BYTES) { a.cut = true; return; }
    const file = join(a.raw, `${String(a.frames.length).padStart(4, '0')}.jpg`);
    a.frames.push({ at, file, width: s.width, height: s.height });
    a.bytes += jpeg.length;
    a.writes.push(writeFile(file, jpeg, { mode: 0o600 }).catch(() => {}));
    a.lastAt = at;
  };

  /** A frame from the subscription: kept now if its turn has come, else held until it has (a newer one replaces it). */
  const frame = (a: Active, image: NativeImage): void => {
    if (!a.open) return;
    const at = now() - a.startedAt;
    if (!a.frames.length || at - a.lastAt >= RECORD_FRAME_MS) { keep(a, image, at); return; }
    a.waiting = image;
    if (a.waitTimer) return;
    a.waitTimer = setTimeout(() => {
      a.waitTimer = null;
      const held = a.waiting;
      a.waiting = null;
      if (held) keep(a, held, Math.min(RECORD_MAX_MS, now() - a.startedAt));
    }, Math.max(1, RECORD_FRAME_MS - (at - a.lastAt)));
  };

  /** The page script's steps, asked in turn while recording: it answers at once when it has some, or within a second. */
  const listen = async (a: Active): Promise<void> => {
    while (a.open) {
      const got = await deadline(options.run<unknown>(`window.__wl && window.__wl.recordWait ? window.__wl.recordWait(${a.startedAt}) : null`, null), 1_600, () => null);
      if (!got || typeof got !== 'object') { if (a.open) await pause(400); continue; }
      const { steps, stop } = got as { steps?: unknown; stop?: unknown };
      // Steps the page took before it heard the recording stopped are still the recording's.
      if (Array.isArray(steps)) for (const s of steps.slice(0, 100)) step(a, s, true);
      if (stop === true && a.open) { void end('escape'); break; }
    }
  };

  const start = async (): Promise<LiveRecordState> => {
    if (active) return state();
    if (saving) { error = 'The last recording is still being saved.'; return state(); }
    const c = options.current();
    if (!c || c.webContents.isDestroyed()) { error = 'The live view shows no page to record.'; tell(); return state(); }
    const startedAt = now();
    const id = newId(startedAt);
    const root = recordingsFolder(options.dataDir, c.projectId);
    // The oldest go first, so that this one makes the project's last RECORDINGS_KEPT.
    pruneRecordings(options.dataDir, c.projectId, RECORDINGS_KEPT - 1);
    const folder = join(root, id);
    const raw = join(folder, 'raw');
    try { privateFolder(raw); } catch (e) { error = `The recording could not be kept: ${(e as Error).message}`; tell(); return state(); }
    let site: string | null = null;
    try { site = new URL(c.base).host; } catch { site = null; }
    const wc = c.webContents;
    const a: Active = {
      open: true, id, projectId: c.projectId, wc, url: wc.getURL() || c.base, site, startedAt, viewWidth: options.width(c.projectId), folder, raw,
      frames: [], steps: [], cut: false, lastAt: 0, waiting: null, waitTimer: null, limitTimer: null, tickTimer: null,
      requests: new Map(), writes: [], bytes: 0, off: [],
    };
    active = a;
    error = null;
    done = null;
    // What this process sees of the page: navigations, console errors, and the view going away.
    const on = <A extends unknown[]>(name: string, fn: (...args: A) => void): void => {
      wc.on(name as 'destroyed', fn as unknown as () => void);
      a.off.push(() => { if (!wc.isDestroyed()) wc.off(name as 'destroyed', fn as unknown as () => void); });
    };
    on('did-navigate', (_e: unknown, url: string, status: number) => step(a, { type: 'navigate', time: now(), url, status, inPage: false }));
    on('did-navigate-in-page', (_e: unknown, url: string, main: boolean) => { if (main) step(a, { type: 'navigate', time: now(), url, inPage: true }); });
    on('console-message', (details: { level: string; message: string; sourceId?: string; lineNumber?: number }) => {
      if (details.level !== 'error' || details.message.includes('Electron Security Warning')) return;
      const where = details.sourceId ? ` (${details.sourceId.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0]}:${details.lineNumber})` : '';
      step(a, { type: 'console', time: now(), text: `${details.message.slice(0, 380)}${where}` });
    });
    // A new page keeps steps from the moment its script is in, not from the next ask.
    on('dom-ready', () => { void options.run(`window.__wl && window.__wl.recordOn ? window.__wl.recordOn(${startedAt}) : false`, false); });
    on('render-process-gone', () => { void end('view'); });
    on('destroyed', () => { void end('view'); });
    try {
      wc.beginFrameSubscription(false, (image) => frame(a, image));
      a.off.push(() => { if (!wc.isDestroyed()) wc.endFrameSubscription(); });
    } catch (e) {
      active = null;
      a.open = false;
      for (const off of a.off) off();
      rmSync(folder, { recursive: true, force: true });
      error = `This view cannot be recorded: ${(e as Error).message}`;
      tell();
      return state();
    }
    // The first frame now: a page that sits still sends none until it moves.
    void wc.capturePage().then((image) => { if (!a.frames.length) keep(a, image, Math.max(0, now() - startedAt)); }, () => {});
    a.limitTimer = setTimeout(() => { void end('limit'); }, RECORD_MAX_MS);
    // The window counts the seconds itself; this keeps its frame and step counts current.
    a.tickTimer = setInterval(tell, 1_000);
    void listen(a);
    tell();
    return state();
  };

  /** Stop, then save: the page's last steps, the clip, the key frames and the log. */
  const end = (why: LiveRecordStop): Promise<LiveRecording | null> => {
    const a = active;
    if (!a) return saving ?? Promise.resolve(null);
    active = null;
    a.open = false;
    if (a.waitTimer) clearTimeout(a.waitTimer);
    if (a.limitTimer) clearTimeout(a.limitTimer);
    if (a.tickTimer) clearInterval(a.tickTimer);
    for (const off of a.off) { try { off(); } catch { /* the view went away first */ } }
    const ms = Math.min(RECORD_MAX_MS, Math.max(1, now() - a.startedAt));
    if (a.waiting) { const held = a.waiting; a.waiting = null; keep(a, held, ms, true); }
    saving = save(a, ms, why).catch((e: Error) => { error = `The recording could not be saved: ${e.message}`; return null; })
      .then((r) => { saving = null; done = r; tell(); return r; });
    tell();
    return saving;
  };

  const save = async (a: Active, ms: number, why: LiveRecordStop): Promise<LiveRecording | null> => {
    // What the page script still held. The page may be gone (a navigation, the view closed): then it held nothing.
    if (!a.wc.isDestroyed()) {
      const last = await deadline(options.run<unknown>('window.__wl && window.__wl.recordOff ? window.__wl.recordOff() : null', null), 1_500, () => null);
      const steps = last && typeof last === 'object' ? (last as { steps?: unknown }).steps : null;
      if (Array.isArray(steps)) for (const s of steps.slice(0, 100)) step(a, s, true);
    }
    await Promise.all(a.writes);
    a.steps.sort((x, y) => x.at - y.at);
    const frames = a.frames.filter((f) => existsSync(f.file));
    const chosen = chooseKeyFrames(a.steps, frames, KEY_FRAMES_MAX);
    const marks = chosen.map((k) => {
      const s = k.step !== null ? a.steps[k.step] : null;
      const f = frames[k.frame] as Frame;
      const scale = a.viewWidth && a.viewWidth > 0 ? f.width / a.viewWidth : 1;
      return { frame: k.frame, ring: s?.type === 'click' ? { x: Math.round(s.x * scale), y: Math.round(s.y * scale) } : null };
    });
    let encoded: Encoded = { clip: null, clipWhy: frames.length ? null : 'No frame came from the view while it recorded.', marked: marks.map(() => null) };
    if (frames.length) {
      encoded = await deadline(encode({ folder: a.folder, frames, ms, marks }), ENCODE_ALL_MS, () => ({ clip: null, clipWhy: 'Encoding the clip took longer than five minutes, so it was stopped.', marked: marks.map(() => null) }))
        .catch((e: Error) => ({ clip: null, clipWhy: `The clip could not be encoded: ${e.message}`, marked: marks.map(() => null) }));
    }
    // The key frames, each a JPEG an agent can be sent.
    const keyFrames: LiveRecording['keyFrames'] = [];
    for (const [i, k] of chosen.entries()) {
      const file = join(a.folder, `frame-${i + 1}.jpg`);
      const bytes = encoded.marked[i] ?? await readFile((frames[k.frame] as Frame).file).catch(() => null);
      if (!bytes) continue;
      writeFileSync(file, bytes, { mode: 0o600 });
      keyFrames.push({ n: i + 1, file, at: k.at, why: k.why, step: k.step });
    }
    // The clip, for the owner: held to an attachment's limit.
    let clip: LiveRecording['clip'] = null;
    let clipWhy = encoded.clipWhy;
    if (encoded.clip) {
      if (encoded.clip.bytes.length > ATTACH_MAX_BYTES) clipWhy = `The clip came to ${Math.round(encoded.clip.bytes.length / 1024 / 1024)} MB, over the 20 MB a file may be, so it was not kept.`;
      else {
        const file = join(a.folder, 'clip.webm');
        writeFileSync(file, encoded.clip.bytes, { mode: 0o600 });
        clip = { file, bytes: encoded.clip.bytes.length, width: encoded.clip.width, height: encoded.clip.height, frames: encoded.clip.frames };
      }
    }
    rmSync(a.raw, { recursive: true, force: true });
    const recording: LiveRecording = {
      id: a.id, projectId: a.projectId, url: a.url, startedAt: a.startedAt, ms, viewWidth: a.viewWidth, folder: a.folder,
      clip, clipWhy, keyFrames, steps: a.steps, cut: a.cut, stopped: why,
    };
    writeFileSync(join(a.folder, 'recording.json'), `${JSON.stringify({ version: 1, ...recording }, null, 1)}\n`, { mode: 0o600 });
    return recording;
  };

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();
  /** A kept recording's folder, from ids the window names: checked, never a path it gives. */
  const folderFor = (rawProject: unknown, rawId: unknown): string | null => {
    if (typeof rawProject !== 'string' || !rawProject || rawProject.length > 200 || typeof rawId !== 'string' || !ID.test(rawId)) return null;
    const folder = join(recordingsFolder(options.dataDir, rawProject), rawId);
    return existsSync(folder) ? folder : null;
  };

  ipc.handle('live:recordStart', async (event) => (ok(event) ? start() : state()));
  ipc.handle('live:recordStop', async (event) => (options.trusted(event) ? end('owner') : null));
  // Narration (voice input): `at` is when the words began, on the window's clock; kept inside the recording.
  ipc.handle('live:recordSay', (event, text: unknown, at: unknown) => {
    if (!options.trusted(event) || !active || typeof text !== 'string') return false;
    const before = active.steps.length;
    const t = now();
    const time = typeof at === 'number' && Number.isFinite(at) ? Math.min(t, Math.max(active.startedAt, at)) : t;
    step(active, { type: 'said', time, text });
    return active.steps.length > before;
  });
  ipc.handle('live:recordFile', async (event, rawProject: unknown, rawId: unknown, rawFile: unknown) => {
    if (!options.trusted(event)) return null;
    const folder = folderFor(rawProject, rawId);
    const name = rawFile === 'clip' ? 'clip.webm' : typeof rawFile === 'string' && /^frame-[1-8]$/.test(rawFile) ? `${rawFile}.jpg` : null;
    if (!folder || !name) return null;
    try {
      const bytes = await readFile(join(folder, name));
      return bytes.length <= ATTACH_MAX_BYTES ? bytes.toString('base64') : null;
    } catch { return null; }
  });
  ipc.handle('live:recordReveal', (event, rawProject: unknown, rawId: unknown) => {
    if (!options.trusted(event)) return false;
    const folder = folderFor(rawProject, rawId);
    if (!folder) return false;
    const clip = join(folder, 'clip.webm');
    options.reveal(existsSync(clip) ? clip : join(folder, 'recording.json'));
    return true;
  });
  ipc.handle('live:recordDelete', (event, rawProject: unknown, rawId: unknown) => {
    if (!options.trusted(event)) return false;
    const folder = folderFor(rawProject, rawId);
    if (!folder || active?.folder === folder) return false;
    rmSync(folder, { recursive: true, force: true });
    if (done?.folder === folder) done = null;
    return true;
  });

  return {
    hooks: {
      // The view went away, or another project's took its place: a recording of it ends there.
      view: (wc) => { if (active && wc !== active.wc) void end('view'); },
      request: (seen) => {
        const a = active;
        if (!a || seen.webContentsId !== a.wc.id) return;
        if (seen.phase === 'start') {
          if (a.requests.size < 2_000) a.requests.set(seen.id, seen.at);
          return;
        }
        const began = a.requests.get(seen.id);
        a.requests.delete(seen.id);
        const ms = began !== undefined ? Math.max(0, Math.round(seen.at - began)) : null;
        if (!requestWorthKeeping(seen.status, seen.error, ms)) return;
        step(a, { type: 'request', time: seen.at, method: seen.method, url: seen.url, status: seen.status, error: seen.error, ms });
      },
    },
    stop: end,
  };
}

/* ── encoding, in a hidden window ──────────────────────────────────────── */

/**
 * The encoder's page script: VP8 (or VP9) through WebCodecs onto a canvas of one size (a frame of another size is
 * fitted inside it), each frame at its own time; and a key frame drawn with a ring where a click was. Runs in a
 * hidden window of the app's own, which loads nothing but a blank page from the recording's folder.
 */
const ENCODER = `(() => {
  if (window.__enc) return true;
  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const t = atob(s); const out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; };
  const bitmap = (s) => createImageBitmap(new Blob([unb64(s)], { type: 'image/jpeg' }));
  let enc = null, cv = null, g = null, W = 0, H = 0, chunks = [], err = null, lastKey = -1e12, count = 0;
  window.__enc = {
    async start(w, h, bitrate, keyEvery) {
      W = w; H = h; cv = new OffscreenCanvas(W, H); g = cv.getContext('2d'); window.__keyEvery = keyEvery;
      for (const codec of ['vp8', 'vp09.00.10.08']) {
        const config = { codec, width: W, height: H, bitrate, framerate: 5, bitrateMode: 'variable' };
        const ok = await VideoEncoder.isConfigSupported(config).then((s) => s.supported, () => false);
        if (!ok) continue;
        enc = new VideoEncoder({
          output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ data: b64(b), at: c.timestamp / 1000, key: c.type === 'key' }); },
          error: (e) => { err = String(e && e.message || e); },
        });
        enc.configure(config);
        return codec;
      }
      return null;
    },
    async frame(jpeg, at, ms) {
      if (err) return err;
      const bmp = await bitmap(jpeg);
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const s = Math.min(W / bmp.width, H / bmp.height);
      const dw = Math.round(bmp.width * s), dh = Math.round(bmp.height * s);
      g.drawImage(bmp, Math.round((W - dw) / 2), Math.round((H - dh) / 2), dw, dh);
      bmp.close();
      const f = new VideoFrame(cv, { timestamp: Math.round(at * 1000), duration: Math.max(1, Math.round(ms * 1000)) });
      const key = count === 0 || at - lastKey >= window.__keyEvery;
      if (key) lastKey = at;
      enc.encode(f, { keyFrame: key });
      f.close();
      count++;
      while (enc.encodeQueueSize > 4) await new Promise((done) => setTimeout(done, 5));
      return err;
    },
    async finish() {
      if (enc && !err) { await enc.flush(); enc.close(); }
      const out = chunks; chunks = [];
      return { chunks: out, err };
    },
    async mark(jpeg, ring) {
      const bmp = await bitmap(jpeg);
      const c = new OffscreenCanvas(bmp.width, bmp.height); const k = c.getContext('2d');
      k.drawImage(bmp, 0, 0); bmp.close();
      if (ring) {
        // Wanigan's water blue (the --water token) around a dark line, so it reads on a light page and a dark one.
        const r = Math.max(14, Math.round(c.width / 60));
        k.lineWidth = 6; k.strokeStyle = '#06131c'; k.beginPath(); k.arc(ring.x, ring.y, r, 0, Math.PI * 2); k.stroke();
        k.lineWidth = 3; k.strokeStyle = '#63b3e4'; k.beginPath(); k.arc(ring.x, ring.y, r, 0, Math.PI * 2); k.stroke();
      }
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
      return b64(new Uint8Array(await blob.arrayBuffer()));
    },
  };
  return true;
})()`;

/** The default encoder: a hidden window of the app's own, on a blank page in the recording's folder. */
async function encodeInWindow(job: EncodeJob): Promise<Encoded> {
  const { BrowserWindow } = await import('electron');
  const page = join(job.folder, 'raw', 'encode.html');
  writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Wanigan encoder</title>\n', { mode: 0o600 });
  const w = new BrowserWindow({
    show: false, width: 64, height: 64,
    // Its own in-memory session: nothing it does is kept, and it shares nothing with the site's view.
    webPreferences: { partition: 'wanigan-record-encoder', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const wc = w.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const js = <T>(code: string, ms = ENCODE_STEP_MS): Promise<T> => deadline(wc.executeJavaScript(code, true) as Promise<T>, ms, () => { throw new Error('the encoder stopped answering'); });
  const marked: (Uint8Array | null)[] = job.marks.map(() => null);
  try {
    await w.loadFile(page);
    await js(ENCODER);
    // The key frames first: they matter more than the clip, and they do not wait on it.
    for (const [i, m] of job.marks.entries()) {
      const f = job.frames[m.frame];
      if (!f) continue;
      const jpeg = (await readFile(f.file)).toString('base64');
      const out = await js<string | null>(`window.__enc.mark(${JSON.stringify(jpeg)}, ${JSON.stringify(m.ring)})`).catch(() => null);
      marked[i] = out ? Buffer.from(out, 'base64') : null;
    }
    const first = job.frames[0] as Frame;
    // VP8 wants even sides.
    const width = Math.max(2, first.width - (first.width % 2));
    const height = Math.max(2, first.height - (first.height % 2));
    const codec = await js<string | null>(`window.__enc.start(${width}, ${height}, ${CLIP_BITRATE}, ${KEY_EVERY_MS})`);
    if (!codec) return { clip: null, clipWhy: 'This copy of Chromium has no VP8 or VP9 encoder, so no clip was made; the key frames and the log are kept.', marked };
    for (const [i, f] of job.frames.entries()) {
      const next = job.frames[i + 1]?.at ?? job.ms;
      const jpeg = (await readFile(f.file)).toString('base64');
      const failed = await js<string | null>(`window.__enc.frame(${JSON.stringify(jpeg)}, ${f.at}, ${Math.max(1, next - f.at)})`);
      if (failed) return { clip: null, clipWhy: `The clip could not be encoded: ${failed}`, marked };
    }
    const out = await js<{ chunks: { data: string; at: number; key: boolean }[]; err: string | null }>('window.__enc.finish()', 60_000);
    if (out.err || !out.chunks.length) return { clip: null, clipWhy: `The clip could not be encoded${out.err ? `: ${out.err}` : ''}.`, marked };
    const chunks = out.chunks.map((c) => ({ data: Buffer.from(c.data, 'base64'), at: c.at, key: c.key })).sort((x, y) => x.at - y.at);
    const bytes = webm({ codec: codec === 'vp8' ? 'V_VP8' : 'V_VP9', width, height }, chunks, job.ms);
    return { clip: { bytes, width, height, frames: chunks.length }, clipWhy: null, marked };
  } finally {
    w.destroy();
  }
}
