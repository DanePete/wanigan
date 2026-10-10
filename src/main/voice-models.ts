// Voice input's speech models on disk: downloaded once, only on the owner's
// click, into Wanigan's own data (<data>/voice/models/<repo>/), from the
// Hugging Face commit each file is pinned to (src/shared/voice.ts).
//
// Resumable: a file arrives as <name>.part, and a stopped or failed download
// carries on from what is there with an HTTP range request. Checksum-verified:
// each file's SHA-256 is checked against the pinned one before it takes its
// name, and a file that does not match is deleted, never used. A model is
// ready when its marker names the pinned commit and every file is there at its
// size (a file only ever gets its name after its hash matched). Free disk
// space is checked first.
// Design: docs/design/2026-10-10-voice-input.md, "The model download".
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { fileUrl, modelBytes, type VoiceModel, type VoiceModelFile } from '../shared/voice.ts';

const MARK = '.wanigan-model.json';
/** Room left on the disk after a download, besides the model itself. */
const SPARE_BYTES = 64 * 1024 * 1024;
const PROGRESS_MS = 200;

/** A model's folder: its repository's path under the models folder. */
export const modelDir = (root: string, m: VoiceModel): string => join(root, ...m.repo.split('/'));

/** Whether every file of a model is on disk as pinned. */
export function modelReady(root: string, m: VoiceModel): boolean {
  const dir = modelDir(root, m);
  try {
    const mark = JSON.parse(readFileSync(join(dir, MARK), 'utf8')) as { revision?: unknown };
    if (mark.revision !== m.revision) return false;
    return m.files.every((f) => statSync(join(dir, f.path)).size === f.bytes);
  } catch {
    return false;
  }
}

/** Take a model off the disk, its partial files too. */
export function removeModel(root: string, m: VoiceModel): void {
  rmSync(modelDir(root, m), { recursive: true, force: true });
}

/** Bytes already on disk for a model: whole files and parts. */
export function bytesOnDisk(root: string, m: VoiceModel): number {
  const dir = modelDir(root, m);
  let n = 0;
  for (const f of m.files) {
    const path = join(dir, f.path);
    try { n += Math.min(f.bytes, statSync(path).size); continue; } catch { /* not whole yet */ }
    try { n += Math.min(f.bytes, statSync(`${path}.part`).size); } catch { /* not begun */ }
  }
  return n;
}

/** Only Hugging Face and its file hosts are downloaded from. */
export function isHuggingFace(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (/(^|\.)huggingface\.co$/.test(u.hostname) || /(^|\.)hf\.co$/.test(u.hostname));
  } catch { return false; }
}

export class ChecksumError extends Error {}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface DownloadOptions {
  fetch: typeof fetch;
  signal?: AbortSignal;
  /** Bytes on disk for the whole model, and its size: at most every fifth of a second, and at the end. */
  onProgress?: (done: number, total: number) => void;
  /** Where a file comes from: Hugging Face at the pinned commit, unless a test says otherwise. */
  url?: (m: VoiceModel, f: VoiceModelFile) => string;
  /** Which final addresses (after redirects) a file may come from. */
  hostAllowed?: (url: string) => boolean;
  /** Free bytes on the disk that holds the models folder. */
  freeBytes?: (path: string) => number;
}

function freeOn(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

const mb = (n: number): string => `${Math.ceil(n / 1_000_000)} MB`;

/** Download a model's files that are missing, carrying on from any part already there, each checked as it lands. */
export async function downloadModel(root: string, m: VoiceModel, o: DownloadOptions): Promise<void> {
  const dir = modelDir(root, m);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const total = modelBytes(m);
  let done = bytesOnDisk(root, m);
  const need = total - done;
  const free = (o.freeBytes ?? freeOn)(dir);
  if (need > 0 && free < need + SPARE_BYTES) {
    throw new Error(`The disk has ${mb(free)} free; the ${m.label.toLowerCase()} model needs ${mb(need + SPARE_BYTES)} (with room to spare).`);
  }
  let told = 0;
  const tell = (force = false): void => {
    const now = Date.now();
    if (!force && now - told < PROGRESS_MS) return;
    told = now;
    o.onProgress?.(done, total);
  };
  tell(true);
  for (const f of m.files) {
    const path = join(dir, f.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size === f.bytes) continue;
    rmSync(path, { force: true });
    const part = `${path}.part`;
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > f.bytes) { rmSync(part, { force: true }); done -= f.bytes; have = 0; }
    if (have < f.bytes) {
      const url = (o.url ?? fileUrl)(m, f);
      const res = await o.fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: o.signal, redirect: 'follow' });
      if (!(o.hostAllowed ?? isHuggingFace)(res.url || url)) throw new Error(`A model file was redirected to ${new URL(res.url).host}, which is not Hugging Face, so it was not downloaded.`);
      let append = false;
      if (res.status === 206 && have > 0 && (res.headers.get('content-range') ?? '').startsWith(`bytes ${have}-`)) append = true;
      else if (res.status === 200 || res.status === 206) { done -= have; have = 0; }
      else throw new Error(`Hugging Face answered ${res.status} for ${f.path}.`);
      if (!res.body) throw new Error(`Hugging Face sent no body for ${f.path}.`);
      const out = await open(part, append ? 'a' : 'w', 0o600);
      try {
        for await (const chunk of Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)) {
          const bytes = chunk as Uint8Array;
          if (have + bytes.length > f.bytes) throw new ChecksumError(`${f.path} came larger than its ${f.bytes} bytes, so it was deleted.`);
          await out.write(bytes);
          have += bytes.length;
          done += bytes.length;
          tell();
        }
      } catch (error) {
        if (error instanceof ChecksumError) { await out.close().catch(() => {}); rmSync(part, { force: true }); throw error; }
        throw error;
      } finally {
        await out.close().catch(() => {});
      }
      if (have !== f.bytes) throw new Error(`${f.path} stopped at ${have} of ${f.bytes} bytes; Download carries on from there.`);
    }
    const sum = await sha256Of(part);
    if (sum !== f.sha256) {
      rmSync(part, { force: true });
      done -= f.bytes;
      tell(true);
      throw new ChecksumError(`${f.path} did not match its checksum, so it was deleted and will download again.`);
    }
    renameSync(part, path);
  }
  writeFileSync(join(dir, MARK), `${JSON.stringify({ repo: m.repo, revision: m.revision, files: m.files }, null, 1)}\n`, { mode: 0o600 });
  tell(true);
}
