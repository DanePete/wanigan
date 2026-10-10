// Downloading a speech model, against a local server standing in for Hugging
// Face with a made-up model (acme/whisper-test): what is checked is the files
// on disk. A file that does not match its SHA-256 is deleted and never takes
// its name; a stopped download carries on from its part with a range request;
// a server that ignores the range is started over; a redirect away from
// Hugging Face is refused; the disk's free space is checked first.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { VoiceModel } from '../shared/voice.ts';
import { ChecksumError, downloadModel, isHuggingFace, modelDir, modelReady, removeModel } from './voice-models.ts';

const bytes = (n: number, seed: number): Buffer => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) % 251; return b; };
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const FILES: Record<string, Buffer> = { 'onnx/encoder.onnx': bytes(300_000, 1), 'config.json': Buffer.from('{"model_type":"whisper"}\n') };

function model(over: Partial<Record<string, string>> = {}): VoiceModel {
  return {
    id: 'fast', label: 'Fast', name: 'Whisper test', repo: 'acme/whisper-test', revision: 'a'.repeat(40), licence: 'Apache-2.0', summary: '',
    files: Object.entries(FILES).map(([path, b]) => ({ path, bytes: b.length, sha256: over[path] ?? sha(b) })),
  };
}

interface Seen { path: string; range: string | null }

/** A stand-in for Hugging Face: serves the files, honours a range unless told not to, and can stop part-way or corrupt one. */
async function server(o: { ignoreRange?: boolean; stopAfter?: number; corrupt?: string; redirect?: string } = {}) {
  const seen: Seen[] = [];
  const s: Server = createServer((req: IncomingMessage, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/[^/]+\/[^/]+\/resolve\/[0-9a-f]+\//, ''));
    seen.push({ path, range: req.headers.range ?? null });
    if (o.redirect) { res.writeHead(302, { location: o.redirect }); res.end(); return; }
    let body = FILES[path];
    if (!body) { res.writeHead(404); res.end(); return; }
    if (o.corrupt === path) { body = Buffer.from(body); body[10] = (body[10] as number) ^ 0xff; }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    let status = 200;
    let from = 0;
    if (m && !o.ignoreRange) { from = Number(m[1]); status = 206; }
    const part = body.subarray(from);
    res.writeHead(status, { 'content-length': String(part.length), ...(status === 206 ? { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
    // The connection drops part-way, once what was sent has arrived.
    if (o.stopAfter !== undefined && path === 'onnx/encoder.onnx') { res.write(part.subarray(0, o.stopAfter)); setTimeout(() => res.destroy(), 100); return; }
    res.end(part);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  return {
    seen,
    url: (m: VoiceModel, f: { path: string }) => `http://127.0.0.1:${port}/${m.repo}/resolve/${m.revision}/${f.path}`,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

const plenty = (): number => 10 * 1024 ** 3;
const local = (): boolean => true;

test('a model downloads into its folder, each file checked, and is ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wanigan-voice-models-'));
  const srv = await server();
  try {
    const m = model();
    const progress: number[] = [];
    await downloadModel(root, m, { fetch, url: srv.url, hostAllowed: local, freeBytes: plenty, onProgress: (done) => progress.push(done) });
    assert.equal(modelReady(root, m), true);
    for (const [path, b] of Object.entries(FILES)) assert.deepEqual(readFileSync(join(modelDir(root, m), path)), b);
    assert.equal(progress[progress.length - 1], 300_000 + FILES['config.json']!.length, 'progress reached the whole model');
    assert.ok(!existsSync(join(modelDir(root, m), 'onnx/encoder.onnx.part')), 'no part left behind');
    // A model pinned to another commit is not this one: it is not ready, and downloads again.
    assert.equal(modelReady(root, { ...m, revision: 'b'.repeat(40) }), false);
    removeModel(root, m);
    assert.equal(existsSync(modelDir(root, m)), false);
    assert.equal(modelReady(root, m), false);
  } finally { await srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a file that does not match its checksum is deleted, never used, and the model is not ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wanigan-voice-models-'));
  const srv = await server({ corrupt: 'onnx/encoder.onnx' });
  try {
    const m = model();
    await assert.rejects(downloadModel(root, m, { fetch, url: srv.url, hostAllowed: local, freeBytes: plenty }), (e: Error) => e instanceof ChecksumError && /did not match its checksum/.test(e.message));
    const dir = modelDir(root, m);
    assert.equal(existsSync(join(dir, 'onnx/encoder.onnx')), false, 'the bad file never took its name');
    assert.equal(existsSync(join(dir, 'onnx/encoder.onnx.part')), false, 'and its part is gone');
    assert.equal(modelReady(root, m), false);
  } finally { await srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a stopped download carries on from its part with a range request, and the file is whole and checked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wanigan-voice-models-'));
  const broken = await server({ stopAfter: 120_000 });
  const m = model();
  try {
    await assert.rejects(downloadModel(root, m, { fetch, url: broken.url, hostAllowed: local, freeBytes: plenty }));
  } finally { await broken.close(); }
  const part = join(modelDir(root, m), 'onnx/encoder.onnx.part');
  assert.equal(statSync(part).size, 120_000, 'what came is kept');
  const srv = await server();
  try {
    await downloadModel(root, m, { fetch, url: srv.url, hostAllowed: local, freeBytes: plenty });
    const asked = srv.seen.find((s) => s.path === 'onnx/encoder.onnx');
    assert.equal(asked?.range, 'bytes=120000-', 'it asked only for the rest');
    assert.deepEqual(readFileSync(join(modelDir(root, m), 'onnx/encoder.onnx')), FILES['onnx/encoder.onnx']);
    assert.equal(modelReady(root, m), true);
  } finally { await srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a server that ignores the range is read from the start, and the file is still whole', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wanigan-voice-models-'));
  const m = model();
  const part = join(modelDir(root, m), 'onnx/encoder.onnx.part');
  const srv = await server({ ignoreRange: true });
  try {
    await import('node:fs').then((fs) => fs.mkdirSync(join(modelDir(root, m), 'onnx'), { recursive: true }));
    writeFileSync(part, Buffer.alloc(50_000, 7));
    await downloadModel(root, m, { fetch, url: srv.url, hostAllowed: local, freeBytes: plenty });
    assert.deepEqual(readFileSync(join(modelDir(root, m), 'onnx/encoder.onnx')), FILES['onnx/encoder.onnx']);
  } finally { await srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a redirect away from Hugging Face is refused, and nothing is written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wanigan-voice-models-'));
  const target = await server();
  const srv = await server({ redirect: target.url(model(), { path: 'onnx/encoder.onnx' }) });
  try {
    const m = model();
    // Only Hugging Face's own hosts are allowed: the stand-ins are on 127.0.0.1.
    await assert.rejects(downloadModel(root, m, { fetch, url: srv.url, freeBytes: plenty }), /not Hugging Face/);
    assert.equal(existsSync(join(modelDir(root, m), 'onnx/encoder.onnx')), false);
    assert.ok(isHuggingFace('https://huggingface.co/onnx-community/whisper-base/resolve/x/config.json'));
    assert.ok(isHuggingFace('https://cas-bridge.xethub.hf.co/xet-bridge-us/abc'));
    assert.ok(isHuggingFace('https://cdn-lfs.huggingface.co/repos/x'));
    for (const no of ['http://huggingface.co/x', 'https://huggingface.co.example.test/x', 'https://evilhf.co/x', 'file:///etc/passwd']) assert.equal(isHuggingFace(no), false, no);
  } finally { await srv.close(); await target.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a disk without room says so before anything is fetched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wanigan-voice-models-'));
  const srv = await server();
  try {
    await assert.rejects(downloadModel(root, model(), { fetch, url: srv.url, hostAllowed: local, freeBytes: () => 1_000_000 }), /disk has 1 MB free/);
    assert.deepEqual(srv.seen, [], 'nothing was asked for');
  } finally { await srv.close(); rmSync(root, { recursive: true, force: true }); }
});
