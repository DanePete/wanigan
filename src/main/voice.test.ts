// Voice input's main process against stand-ins: a fake utilityProcess, a fake
// port pair, a fake window. What is checked is what the worker is sent, what
// the window is told, what is on disk, and who may use the microphone: the
// worker crashing mid-stream, stopping when unused or past its memory ceiling,
// a model that will not load, settings kept clean, and media only for
// Wanigan's own page, audio only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { VOICE_MODELS, type VoiceStart, type VoiceState } from '../shared/voice.ts';
import { guardMicrophone, mediaAllowed, micSettingsUrl, wireVoice, type VoiceWorker } from './voice.ts';

class FakeWorker extends EventEmitter implements VoiceWorker {
  pid = 4242;
  sent: { message: unknown; transfer: unknown[] }[] = [];
  killed = 0;
  readonly stderr = new EventEmitter();
  postMessage(message: unknown, transfer: unknown[] = []): void { this.sent.push({ message, transfer }); }
  kill(): boolean { this.killed++; return true; }
}

/** A model's files on disk at their pinned sizes (sparse: nothing is written), with the marker a download leaves. */
function placeModel(data: string, id: 'fast' | 'accurate'): string {
  const m = VOICE_MODELS.find((x) => x.id === id)!;
  const dir = join(data, 'voice', 'models', ...m.repo.split('/'));
  for (const f of m.files) {
    mkdirSync(join(dir, f.path, '..'), { recursive: true });
    writeFileSync(join(dir, f.path), '');
    truncateSync(join(dir, f.path), f.bytes);
  }
  writeFileSync(join(dir, '.wanigan-model.json'), JSON.stringify({ repo: m.repo, revision: m.revision, files: m.files }));
  return dir;
}

function rig(data: string, over: Partial<Parameters<typeof wireVoice>[0]> = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const told: VoiceState[] = [];
  const workers: FakeWorker[] = [];
  const ports: { channel: string; data: unknown; transfer: unknown[] }[] = [];
  const opened: string[] = [];
  let trusted = true;
  const wired = wireVoice({
    ipc: { handle: (name: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(name, fn); } } as never,
    trusted: () => trusted,
    dataDir: data,
    send: (channel, payload) => { if (channel === 'voice:state') told.push(payload as VoiceState); },
    fork: () => { const w = new FakeWorker(); workers.push(w); return w; },
    channel: () => ({ port1: { name: 'port1' } as never, port2: { name: 'port2' } as never }),
    fetch: (() => { throw new Error('no network in this test'); }) as never,
    micAccess: () => 'granted',
    openExternal: async (url) => { opened.push(url); },
    platform: 'darwin',
    ...over,
  });
  const sender = { postMessage: (channel: string, d: unknown, transfer: unknown[]) => ports.push({ channel, data: d, transfer }) };
  const call = (name: string, ...args: unknown[]) => (handlers.get(name) as (e: unknown, ...a: unknown[]) => unknown)({ sender }, ...args);
  return { wired, told, workers, ports, opened, call, untrust: () => { trusted = false; } };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('without its model, voice input does not start, and asks for nothing to be forked', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    const r = rig(data);
    const s = await r.call('voice:start') as VoiceStart;
    assert.deepEqual(s, { ok: false, code: 'no-model', message: 'Voice input needs its speech model first.' });
    assert.equal(r.workers.length, 0);
    const state = await r.call('voice:state') as VoiceState;
    assert.deepEqual(state.models.map((m) => [m.id, m.ready]), [['fast', false], ['accurate', false]]);
    assert.equal(state.engine, 'off');
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('a stream forks the worker once, loads the chosen model, and hands one port to the worker and the other to the window', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    placeModel(data, 'fast');
    const r = rig(data);
    const s = await r.call('voice:start') as VoiceStart;
    assert.ok(s.ok);
    assert.equal(r.workers.length, 1);
    const w = r.workers[0]!;
    const load = w.sent[0]!.message as { type: string; root: string; repo: string; threads: number };
    assert.equal(load.type, 'load');
    assert.equal(load.root, join(data, 'voice', 'models'));
    assert.equal(load.repo, 'onnx-community/whisper-base');
    assert.ok(load.threads >= 1 && load.threads <= 4);
    assert.deepEqual(w.sent[1], { message: { type: 'stream', id: s.ok && s.id, language: null }, transfer: [{ name: 'port2' }] });
    assert.deepEqual(r.ports, [{ channel: 'voice:port', data: { id: s.ok && s.id }, transfer: [{ name: 'port1' }] }]);
    assert.equal(r.wired.state().engine, 'loading');
    w.emit('message', { type: 'loaded', repo: 'onnx-community/whisper-base', ms: 700 });
    assert.equal(r.wired.state().engine, 'ready');
    // A second stream reuses the worker and its model.
    const again = await r.call('voice:start') as VoiceStart;
    assert.ok(again.ok);
    assert.equal(r.workers.length, 1);
    assert.equal(w.sent.filter((x) => (x.message as { type: string }).type === 'load').length, 1);
    // The language chosen goes with each stream.
    await r.call('voice:setSettings', { language: 'pt' });
    await r.call('voice:start');
    assert.deepEqual((w.sent[w.sent.length - 1]!.message as { language: string }).language, 'pt');
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('the worker crashing mid-stream is said to the window with its exit code and last words, and the next press starts a new one', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    placeModel(data, 'fast');
    const r = rig(data);
    await r.call('voice:start');
    const w = r.workers[0]!;
    w.emit('message', { type: 'loaded', repo: 'onnx-community/whisper-base', ms: 700 });
    w.stderr.emit('data', 'RuntimeError: memory access out of bounds\n');
    w.emit('exit', 133);
    const s = r.wired.state();
    assert.equal(s.engine, 'failed');
    assert.match(s.engineError ?? '', /stopped unexpectedly \(exit code 133\): RuntimeError: memory access out of bounds/);
    assert.equal(r.told[r.told.length - 1]?.engine, 'failed', 'the window was told');
    const next = await r.call('voice:start') as VoiceStart;
    assert.ok(next.ok);
    assert.equal(r.workers.length, 2, 'a new worker');
    assert.equal(r.wired.state().engine, 'loading');
    assert.equal(r.wired.state().engineError, null);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('a model that will not load stops the worker and says what to do', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    placeModel(data, 'fast');
    const r = rig(data);
    await r.call('voice:start');
    r.workers[0]!.emit('message', { type: 'load-failed', repo: 'onnx-community/whisper-base', message: 'protobuf parsing failed' });
    const s = r.wired.state();
    assert.equal(s.engine, 'failed');
    assert.match(s.engineError ?? '', /could not be loaded: protobuf parsing failed.*download it again/);
    assert.deepEqual(r.workers[0]!.sent[r.workers[0]!.sent.length - 1]!.message, { type: 'stop' });
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('unused, the worker is stopped; past its memory ceiling, it is stopped and the window told why', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    placeModel(data, 'fast');
    const r = rig(data, { idleMs: 20 });
    const s = await r.call('voice:start') as VoiceStart;
    const w = r.workers[0]!;
    w.emit('message', { type: 'loaded', repo: 'onnx-community/whisper-base', ms: 1 });
    w.emit('message', { type: 'stream-done', id: s.ok ? s.id : '' });
    await wait(60);
    assert.deepEqual(w.sent[w.sent.length - 1]!.message, { type: 'stop' });
    assert.equal(r.wired.state().engine, 'off');
    assert.equal(r.wired.state().engineError, null, 'stopping when unused is not a failure');

    let bytes = 400 * 1024 ** 2;
    const m = rig(data, { memory: () => bytes, watchMs: 10 });
    await m.call('voice:start');
    m.workers[0]!.emit('message', { type: 'loaded', repo: 'onnx-community/whisper-base', ms: 1 });
    await wait(30);
    assert.equal(m.wired.state().engine, 'ready', 'under the ceiling it runs');
    bytes = 3 * 1024 ** 3;
    await wait(40);
    assert.equal(m.wired.state().engine, 'failed');
    assert.match(m.wired.state().engineError ?? '', /used 3\.0 GB of memory/);
    m.wired.release();
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('settings are kept clean in Wanigan’s data; removing the model in use stops the worker and takes its files away', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    const dir = placeModel(data, 'fast');
    const r = rig(data);
    const s = await r.call('voice:setSettings', { model: 'accurate', language: 'de', narrate: true, root: '/etc' }) as VoiceState;
    assert.deepEqual(s.settings, { model: 'accurate', language: 'de', narrate: true });
    await r.call('voice:setSettings', { model: '../../x', language: 'xx' });
    assert.deepEqual(JSON.parse(readFileSync(join(data, 'voice', 'settings.json'), 'utf8')), { model: 'accurate', language: 'de', narrate: true });
    assert.deepEqual(rig(data).wired.state().settings, { model: 'accurate', language: 'de', narrate: true }, 'read back by the next launch');
    await r.call('voice:setSettings', { model: 'fast' });
    await r.call('voice:start');
    await r.call('voice:remove', 'fast');
    assert.equal(existsSync(dir), false);
    assert.deepEqual(r.workers[0]!.sent[r.workers[0]!.sent.length - 1]!.message, { type: 'stop' });
    // A name that is not a model removes nothing.
    await r.call('voice:remove', '../../');
    assert.ok(existsSync(join(data, 'voice')));
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('an untrusted sender gets nothing, starts nothing and opens nothing', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    placeModel(data, 'fast');
    const r = rig(data);
    r.untrust();
    assert.equal(await r.call('voice:state'), null);
    assert.equal((await r.call('voice:start') as VoiceStart).ok, false);
    assert.equal(await r.call('voice:openMicSettings'), false);
    assert.equal(await r.call('voice:setSettings', { narrate: true }), null);
    assert.equal(r.workers.length, 0);
    assert.deepEqual(r.opened, []);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('the microphone settings open where the OS has a page for them, and nowhere else', async () => {
  assert.equal(micSettingsUrl('darwin'), 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  assert.equal(micSettingsUrl('win32'), 'ms-settings:privacy-microphone');
  assert.equal(micSettingsUrl('linux'), null);
  const data = mkdtempSync(join(tmpdir(), 'wanigan-voice-'));
  try {
    const mac = rig(data);
    assert.equal(await mac.call('voice:openMicSettings'), true);
    assert.deepEqual(mac.opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
    const linux = rig(data, { platform: 'linux', micAccess: () => 'unknown' });
    assert.equal(await linux.call('voice:openMicSettings'), false);
    assert.equal(linux.wired.state().micSettings, false);
    assert.equal(linux.wired.state().mic, 'unknown');
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('media is granted only to Wanigan’s own page, and only audio; other permissions keep the answer they had', () => {
  assert.equal(mediaAllowed('media', { mediaTypes: ['audio'] }, true), true);
  assert.equal(mediaAllowed('media', { mediaTypes: ['audio'] }, false), false, 'never a site');
  assert.equal(mediaAllowed('media', { mediaTypes: ['video'] }, true), false, 'never the camera');
  assert.equal(mediaAllowed('media', { mediaTypes: ['audio', 'video'] }, true), false);
  assert.equal(mediaAllowed('media', { mediaTypes: [] }, true), false);
  assert.equal(mediaAllowed('clipboard-sanitized-write', {}, true), null);

  const handlers: { request?: (...a: unknown[]) => void; check?: (...a: unknown[]) => boolean } = {};
  guardMicrophone({
    setPermissionRequestHandler: (h: unknown) => { handlers.request = h as never; },
    setPermissionCheckHandler: (h: unknown) => { handlers.check = h as never; },
  } as never, (wc, url) => wc !== null && url.startsWith('file:///app/index.html'));
  const own = { getURL: () => 'file:///app/index.html#/settings' };
  const site = { getURL: () => 'https://acme.example.test/' };
  const answer = (wc: unknown, permission: string, details: unknown): boolean => {
    let got: boolean | null = null;
    handlers.request!(wc, permission, (ok: boolean) => { got = ok; }, details);
    return got as unknown as boolean;
  };
  assert.equal(answer(own, 'media', { mediaTypes: ['audio'], requestingUrl: 'file:///app/index.html#/p/NS/live' }), true);
  assert.equal(answer(own, 'media', { mediaTypes: ['video'], requestingUrl: 'file:///app/index.html' }), false);
  assert.equal(answer(site, 'media', { mediaTypes: ['audio'], requestingUrl: 'https://acme.example.test/' }), false);
  assert.equal(answer(own, 'clipboard-sanitized-write', { requestingUrl: 'file:///app/index.html' }), true, 'unchanged');
  assert.equal(handlers.check!(own, 'media', 'file:///', { mediaType: 'audio' }), true);
  assert.equal(handlers.check!(own, 'media', 'file:///', { mediaType: 'video' }), false);
  assert.equal(handlers.check!(site, 'media', 'https://acme.example.test', { mediaType: 'audio' }), false);
  assert.equal(handlers.check!(null, 'media', 'file:///', { mediaType: 'audio' }), false);
});
