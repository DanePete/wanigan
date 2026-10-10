// Record's main-process side against stand-ins: a view's webContents that
// hands over frames and events, a page script that answers with steps, and an
// encoder that makes no video (the real one is a hidden window of Electron's).
// What is checked is what lands on disk, in Wanigan's data folder: the clip,
// the key frames, the log, and what is never in it. Made-up site (acme).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LiveRecordState, LiveRecording } from '../shared/bridge.ts';
import { pruneRecordings, recordingsFolder, wireLiveRecord, type EncodeJob } from './live-record.ts';

const T0 = 1_760_000_000_000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** A frame as Electron's NativeImage gives it: twice the CSS size, as on a Retina screen. */
const image = (width = 2400, height = 1600) => ({
  isEmpty: () => false,
  getSize: () => ({ width, height }),
  resize: (o: { width: number }) => image(o.width, Math.round((height * o.width) / width)),
  toJPEG: () => JPEG,
});

class View extends EventEmitter {
  id = 7;
  destroyed = false;
  frame: ((img: unknown) => void) | null = null;
  ended = 0;
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return 'https://acme.example.test/book'; }
  beginFrameSubscription(_dirty: boolean, cb: (img: unknown) => void): void { this.frame = cb; }
  endFrameSubscription(): void { this.frame = null; this.ended++; }
  capturePage(): Promise<unknown> { return Promise.resolve(image()); }
}

function setup(data: string, page: (code: string) => unknown) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const states: LiveRecordState[] = [];
  const jobs: EncodeJob[] = [];
  const revealed: string[] = [];
  let t = T0;
  const view = new View();
  const wired = wireLiveRecord({
    ipc: { handle: (name: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(name, fn); } } as never,
    trusted: () => true, enabled: () => true, dataDir: data,
    window: () => ({ isDestroyed: () => false, webContents: { send: (_c: string, s: LiveRecordState) => states.push(s) } }) as never,
    current: () => ({ projectId: 'acme-project', webContents: view as never, base: 'https://acme.example.test/', token: 'stand-in', env: null }),
    run: async <T>(code: string, fallback: T) => (page(code) ?? fallback) as T,
    width: () => 1200,
    reveal: (p) => revealed.push(p),
    now: () => t,
    encode: async (job) => {
      jobs.push(job);
      return { clip: { bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), width: 1200, height: 800, frames: job.frames.length }, clipWhy: null, marked: job.marks.map(() => Uint8Array.from(JPEG)) };
    },
  });
  const call = (name: string, ...args: unknown[]) => (handlers.get(name) as (e: unknown, ...a: unknown[]) => unknown)({}, ...args);
  return { wired, view, states, jobs, revealed, call, tick: (ms: number) => { t += ms; } };
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test('a recording keeps its clip, key frames and log in Wanigan’s data, never a password, body, header or query', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-record-'));
  try {
    // Five older recordings: a project keeps five, so starting a sixth takes the oldest away.
    const root = recordingsFolder(data, 'acme-project');
    const old = ['20260101T000000-aaaaaa', '20260102T000000-bbbbbb', '20260103T000000-cccccc', '20260104T000000-dddddd', '20260105T000000-eeeeee'];
    for (const id of old) mkdirSync(join(root, id), { recursive: true });
    let asked = 0;
    const r = setup(data, (code) => {
      if (code.includes('recordWait') && asked++ === 0) {
        // What the page script hands over: a click on a part, and a password typed (as a page that tried to keep it would send it).
        return { steps: [
          { type: 'click', time: T0 + 250, x: 300, y: 200, target: 'button “Book”', selector: 'main > button', part: 'p-hours', made: 'template block--hours.html.twig' },
          { type: 'typed', time: T0 + 1_500, text: 'hunter2', secret: true, target: 'password field “Password”' },
        ], stop: false };
      }
      if (code.includes('recordOff')) return { steps: [{ type: 'key', time: T0 + 1_600, key: 'Enter', secret: true, target: 'password field “Password”' }] };
      return null;
    });
    const started = await r.call('live:recordStart') as LiveRecordState;
    assert.equal(started.on, true);
    assert.deepEqual(readdirSync(root).filter((n) => old.includes(n)), old.slice(1), 'the oldest went, four stayed');
    // Frames: the first from capturePage, then the subscription's, at most one every 200 ms.
    await wait(10);
    for (let i = 0; i < 6; i++) { r.tick(100); r.view.frame?.(image()); }
    // What the main process sees: a request that failed and one that was fine, another view's, a console error, a navigation.
    r.wired.hooks.request({ webContentsId: 7, id: 1, phase: 'start', method: 'POST', url: 'https://acme.example.test/book?token=abc', status: null, error: null, at: T0 + 2_000 });
    r.wired.hooks.request({ webContentsId: 7, id: 1, phase: 'done', method: 'POST', url: 'https://acme.example.test/book?token=abc', status: 500, error: null, at: T0 + 2_310 });
    r.wired.hooks.request({ webContentsId: 7, id: 2, phase: 'start', method: 'GET', url: 'https://acme.example.test/a.css', status: null, error: null, at: T0 + 2_000 });
    r.wired.hooks.request({ webContentsId: 7, id: 2, phase: 'done', method: 'GET', url: 'https://acme.example.test/a.css', status: 200, error: null, at: T0 + 2_020 });
    r.wired.hooks.request({ webContentsId: 99, id: 3, phase: 'failed', method: 'GET', url: 'https://acme.example.test/x', status: null, error: 'net::ERR_FAILED', at: T0 + 2_000 });
    r.view.emit('console-message', { level: 'error', message: 'TypeError: booking is null', sourceId: 'https://acme.example.test/js/book.js?v=3', lineNumber: 12 });
    r.view.emit('did-navigate', {}, 'https://acme.example.test/booked?session=xyz', 200);
    assert.equal(await r.call('live:recordSay', 'It hangs after this.'), true);
    await wait(50);
    r.tick(400);
    const rec = await r.call('live:recordStop') as LiveRecording;

    assert.ok(rec.folder.startsWith(join(data, 'live-recordings')), 'kept in Wanigan’s data');
    assert.equal(r.view.ended, 1, 'the frame subscription ended');
    assert.equal(rec.stopped, 'owner');
    assert.deepEqual(rec.steps.map((s) => s.type).sort(), ['click', 'console', 'key', 'navigate', 'request', 'said', 'typed']);
    const files = readdirSync(rec.folder).sort();
    assert.deepEqual(files, ['clip.webm', ...rec.keyFrames.map((k) => `frame-${k.n}.jpg`), 'recording.json'].sort(), 'the raw frames are gone');
    assert.ok(rec.keyFrames.length >= 2 && rec.keyFrames.length <= 8);
    // The frames were kept at the view's CSS width, not the screen's, and the click is ringed where it was.
    const job = r.jobs[0] as EncodeJob;
    assert.ok(job.frames.length >= 3 && job.frames.length <= 6, `${job.frames.length} frames`);
    assert.ok(job.frames.every((f) => f.width === 1200));
    assert.ok(job.marks.some((m) => m.ring?.x === 300 && m.ring?.y === 200));
    // What is on disk says nothing it must not.
    const kept = readFileSync(join(rec.folder, 'recording.json'), 'utf8');
    for (const leak of ['hunter2', 'token=abc', 'session=xyz', '?v=3', 'stand-in']) assert.ok(!kept.includes(leak), `recording.json holds ${leak}`);
    const typed = rec.steps.find((s) => s.type === 'typed');
    assert.deepEqual(typed && { text: typed.text, secret: typed.secret }, { text: null, secret: true });
    const key = rec.steps.find((s) => s.type === 'key');
    assert.equal(key?.type === 'key' && key.key, null, 'not even which key, in a password field');
    assert.ok(rec.steps.some((s) => s.type === 'request' && s.path === '/book' && s.status === 500 && s.ms === 310));
    assert.ok(!rec.steps.some((s) => s.type === 'request' && s.path === '/a.css'), 'a request that was fine and quick is not a step');
    // The window reads a kept file by ids, never by a path it names.
    assert.equal(typeof await r.call('live:recordFile', 'acme-project', rec.id, 'frame-1'), 'string');
    assert.equal(await r.call('live:recordFile', 'acme-project', '../../etc', 'clip'), null);
    assert.equal(await r.call('live:recordFile', 'acme-project', rec.id, '../recording.json'), null);
    assert.equal(await r.call('live:recordReveal', 'acme-project', rec.id), true);
    assert.equal(r.revealed[0], join(rec.folder, 'clip.webm'));
    assert.equal(await r.call('live:recordDelete', 'acme-project', rec.id), true);
    assert.equal(existsSync(rec.folder), false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('a recording ends when its view goes away, and Escape on the page ends it too', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-record-'));
  try {
    let stop = false;
    const r = setup(data, (code) => (code.includes('recordWait') && stop ? { steps: [], stop: true } : null));
    await r.call('live:recordStart');
    await wait(10);
    r.wired.hooks.view(null, null);
    await wait(30);
    const last = r.states[r.states.length - 1] as LiveRecordState;
    assert.equal(last.on, false);
    assert.equal(last.done?.stopped, 'view');

    await r.call('live:recordStart');
    stop = true;
    await wait(500);
    const after = r.states[r.states.length - 1] as LiveRecordState;
    assert.equal(after.on, false);
    assert.equal(after.done?.stopped, 'escape');
    // Narration with nothing recording is refused.
    assert.equal(await r.call('live:recordSay', 'hello'), false);
    // Pruning keeps what it is asked to keep, by age.
    assert.equal(pruneRecordings(data, 'acme-project', 1).length, 1);
    assert.equal(readdirSync(recordingsFolder(data, 'acme-project')).length, 1);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('narration is kept at the moment the words began, inside the recording, and as words only', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-record-'));
  try {
    const r = setup(data, () => null);
    await r.call('live:recordStart');
    await wait(10);
    r.tick(5_000);
    // Voice input says when each sentence began, on the window's clock: 1.2 s in, though it arrived at 5 s.
    assert.equal(await r.call('live:recordSay', 'The banner covers the search box.', T0 + 1_200), true);
    // A time before the recording began, or after now, is held inside it; none at all is now.
    assert.equal(await r.call('live:recordSay', 'Before it began.', T0 - 60_000), true);
    assert.equal(await r.call('live:recordSay', 'From the future.', T0 + 999_000), true);
    assert.equal(await r.call('live:recordSay', 'As it arrived.'), true);
    assert.equal(await r.call('live:recordSay', 'Not a time.', 'soon'), true);
    // Control characters go; an empty line is not a step.
    assert.equal(await r.call('live:recordSay', '  \u0007 '), false);
    const rec = await r.call('live:recordStop') as LiveRecording;
    const said = rec.steps.filter((s) => s.type === 'said');
    assert.deepEqual(said.map((s) => [s.at, s.type === 'said' ? s.text : '']), [
      [0, 'Before it began.'], [1_200, 'The banner covers the search box.'],
      [5_000, 'From the future.'], [5_000, 'As it arrived.'], [5_000, 'Not a time.'],
    ]);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('the sentence heard just after Stop still joins the recording while it is saved, in time order', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-record-'));
  try {
    const r = setup(data, () => null);
    await r.call('live:recordStart');
    await wait(10);
    r.tick(3_000);
    assert.equal(await r.call('live:recordSay', 'First this.', T0 + 500), true);
    const stopping = r.call('live:recordStop') as Promise<LiveRecording>;
    // Voice input finishes the last sentence a moment later: it began at 2.6 s, before the stop.
    assert.equal(await r.call('live:recordSay', 'And then it breaks.', T0 + 2_600), true);
    const rec = await stopping;
    assert.deepEqual(rec.steps.filter((s) => s.type === 'said').map((s) => s.at), [500, 2_600]);
    assert.deepEqual(rec.steps.map((s) => s.at), [...rec.steps.map((s) => s.at)].sort((a, b) => a - b), 'the log stays in time order');
    const kept = JSON.parse(readFileSync(join(rec.folder, 'recording.json'), 'utf8')) as LiveRecording;
    assert.equal(kept.steps.filter((s) => s.type === 'said').length, 2, 'written to disk with it');
    // Once it is saved, narration has nowhere to go.
    assert.equal(await r.call('live:recordSay', 'Too late.', T0 + 2_900), false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
