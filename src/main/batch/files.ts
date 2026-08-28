import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { toFile } from '@anthropic-ai/sdk';
import { db } from '../db';
import { client, isMock, explainApiError } from './anthropic';
import type { UploadedFile } from '../../shared/types';

/**
 * Rows as uploaded files.
 *
 * A repo-wide audit that inlines every file into the request body hits the
 * 256 MB batch ceiling long before it hits 100,000 requests — 2,000 files at
 * 130 KB each is already over. Uploading once and referencing the file by id
 * makes the request body a constant ~120 bytes per row, so the request count
 * becomes the only ceiling that matters.
 */

/**
 * Required on the upload AND on every request that references a file_id. A
 * batch created without it fails every uploaded row, and a batch reports that
 * only when the whole thing ends.
 */
export const FILES_BETA = 'files-api-2025-04-14';

/** The row column an uploaded file travels in. Named once so sources and build cannot drift. */
export const FILE_REF_COLUMN = 'fileRef';

/** Files API hard limit. A vendored archive in a glob will find it. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/**
 * The Files API is rate limited per organisation. Firing 500 uploads at once
 * earns 429s that cost more wall-clock than the serialisation ever saved.
 */
const UPLOAD_CONCURRENCY = 4;

/**
 * Extension → media type, and media type → content block, are the same
 * decision made twice. Only types that have a content block Claude accepts
 * appear here; everything else is deliberately unclassifiable and gets inlined
 * by the caller instead of uploaded.
 *
 * Every text-ish extension maps to text/plain rather than a more precise type
 * (text/x-php, text/markdown): the document block accepts text/plain
 * everywhere, and a rejected media type is a per-request failure, which in a
 * batch is a failure you learn about 24 hours late.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'html', 'htm', 'xml', 'svg', 'css', 'scss', 'sass', 'less', 'twig', 'tpl',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte',
  'php', 'inc', 'module', 'theme', 'install', 'profile', 'engine',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql', 'patch', 'diff',
]);

/** application/octet-stream is the "Wanigan cannot classify this" answer — never uploadable. */
const UNCLASSIFIED = 'application/octet-stream';

export function mediaTypeFor(absPath: string): string {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext in IMAGE_TYPES) return IMAGE_TYPES[ext];
  if (TEXT_EXTS.has(ext)) return 'text/plain';
  return UNCLASSIFIED;
}

/** True when this media type has a content block Claude will accept for it. */
export function isUploadable(mediaType: string): boolean {
  return blockKindFor(mediaType) !== null;
}

function blockKindFor(mediaType: string): 'document' | 'image' | null {
  const t = mediaType.toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf' || t.startsWith('text/')) return 'document';
  return null;
}

/**
 * The content block type must match the file's media type — a PDF sent as an
 * `image` block, or a PNG sent as a `document`, is rejected per request. That
 * mapping lives here and nowhere else so it can only be wrong in one place.
 */
export function contentBlockFor(u: UploadedFile): Record<string, unknown> {
  const kind = blockKindFor(u.mediaType);
  if (kind === 'image') {
    return { type: 'image', source: { type: 'file', file_id: u.fileId } };
  }
  if (kind === 'document') {
    return {
      type: 'document',
      source: { type: 'file', file_id: u.fileId },
      title: path.basename(u.path),
    };
  }
  throw new Error(
    `${path.basename(u.path)} was uploaded as ${u.mediaType}, which has no matching content block ` +
    `(only PDFs, text and images can be referenced by id). Re-run this source with uploads off so the file is inlined instead.`
  );
}

/**
 * sha256 of the bytes, read in chunks. readFileSync would hold a 400 MB PDF in
 * memory just to fingerprint it, and a glob hashes every match before deciding
 * whether it already knows the file.
 */
export function hashFile(absPath: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

type UploadRow = {
  hash: string;
  file_id: string;
  path: string;
  bytes: number;
  media_type: string;
  uploaded_at: number;
  last_used_at: number | null;
};

function toUploaded(r: UploadRow): UploadedFile {
  return {
    hash: r.hash,
    fileId: r.file_id,
    path: r.path,
    bytes: r.bytes,
    mediaType: r.media_type,
    uploadedAt: r.uploaded_at,
  };
}

function rowFor(hash: string): UploadRow | null {
  const r = db().prepare('SELECT * FROM uploads WHERE hash = ?').get(hash) as UploadRow | undefined;
  return r ?? null;
}

/**
 * A cache hit is the whole point: re-running the same audit next week must not
 * pay to send the same bytes again. last_used_at is stamped here because this
 * is the only place a hit happens, and it is what tells a prune what is cold.
 */
export function cachedUpload(hash: string): UploadedFile | null {
  const r = rowFor(hash);
  if (!r) return null;
  db().prepare('UPDATE uploads SET last_used_at = ? WHERE hash = ?').run(Date.now(), hash);
  return toUploaded(r);
}

/**
 * Two rows with byte-identical content would otherwise each pay for an upload,
 * because neither is in the table until the other finishes.
 */
const inFlight = new Map<string, Promise<UploadedFile>>();

export async function uploadFile(absPath: string, mediaType?: string): Promise<UploadedFile> {
  const abs = path.resolve(absPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`Cannot upload ${abs}: the file does not exist or is unreadable.`);
  }
  if (!stat.isFile()) throw new Error(`Cannot upload ${abs}: it is not a regular file.`);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${path.basename(abs)} is ${(stat.size / 1e6).toFixed(0)} MB, over the Files API limit of 500 MB. ` +
      `Exclude it from the source pattern, or split it before running.`
    );
  }

  const type = mediaType ?? mediaTypeFor(abs);
  if (!isUploadable(type)) {
    throw new Error(
      `Wanigan cannot classify ${path.basename(abs)} (${type}) as a document or an image, so it must not be uploaded — ` +
      `a content block that does not match the file fails per request. Inline it as text instead.`
    );
  }

  const hash = hashFile(abs);
  // The cache is keyed by content, so a hit is often a *different* path with
  // the same bytes — a duplicated stub, licence header or generated file
  // elsewhere in the same repo. Answer with the path that was asked about:
  // callers key their rows on it, and the row whose path came back as some
  // other file's would silently lose its attachment.
  const hit = cachedUpload(hash);
  if (hit) return { ...hit, path: abs };

  const pending = inFlight.get(hash);
  if (pending) return { ...(await pending), path: abs };

  const work = (async (): Promise<UploadedFile> => {
    const fileId = isMock()
      // Deterministic and offline: mock mode must never touch the network or spend.
      ? `file_mock${hash.slice(0, 24)}`
      : await uploadToApi(abs, type);

    const rec: UploadedFile = {
      hash,
      fileId,
      path: abs,
      bytes: stat.size,
      mediaType: type,
      uploadedAt: Date.now(),
    };
    db().prepare(`
      INSERT INTO uploads (hash, file_id, path, bytes, media_type, uploaded_at, last_used_at)
      VALUES (@hash,@fileId,@path,@bytes,@mediaType,@uploadedAt,@uploadedAt)
      ON CONFLICT(hash) DO UPDATE SET
        file_id=excluded.file_id, path=excluded.path, bytes=excluded.bytes,
        media_type=excluded.media_type, uploaded_at=excluded.uploaded_at,
        last_used_at=excluded.last_used_at
    `).run(rec);
    return rec;
  })().finally(() => inFlight.delete(hash));

  inFlight.set(hash, work);
  return work;
}

async function uploadToApi(abs: string, mediaType: string): Promise<string> {
  try {
    const uploaded = await client().beta.files.upload({
      file: await toFile(fs.createReadStream(abs), path.basename(abs), { type: mediaType }),
      betas: [FILES_BETA],
    });
    return uploaded.id;
  } catch (e) {
    throw new Error(`Upload of ${path.basename(abs)} failed: ${explainApiError(e)}`);
  }
}

/**
 * Uploads a whole source in one pass. Failures are collected rather than
 * thrown: one unreadable file in a 900-file audit must not lose the other 899
 * uploads, which have already been paid for.
 */
export async function uploadMany(
  paths: string[],
  onProgress?: (done: number, total: number) => void
): Promise<{ uploaded: UploadedFile[]; failed: { path: string; error: string }[] }> {
  const total = paths.length;
  const ok: (UploadedFile | null)[] = new Array(total).fill(null);
  const errs: (string | null)[] = new Array(total).fill(null);
  let next = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      try {
        ok[i] = await uploadFile(paths[i]);
      } catch (e) {
        errs[i] = e instanceof Error ? e.message : String(e);
      }
      onProgress?.(++done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, () => worker())
  );

  const uploaded: UploadedFile[] = [];
  const failed: { path: string; error: string }[] = [];
  for (let i = 0; i < total; i++) {
    const u = ok[i];
    if (u) uploaded.push(u);
    else failed.push({ path: paths[i], error: errs[i] ?? 'Upload did not complete.' });
  }
  return { uploaded, failed };
}

export function listUploads(): UploadedFile[] {
  const rows = db().prepare(
    'SELECT * FROM uploads ORDER BY COALESCE(last_used_at, uploaded_at) DESC'
  ).all() as UploadRow[];
  return rows.map(toUploaded);
}

export async function deleteUpload(hash: string): Promise<boolean> {
  const row = rowFor(hash);
  if (!row) return false;

  if (!isMock()) {
    try {
      await client().beta.files.delete(row.file_id, { betas: [FILES_BETA] });
    } catch (e) {
      // Already gone remotely is the outcome we wanted; anything else is real.
      // Dropping the local row on a 404 matters — a cached id the API no longer
      // has would be handed to the next run and fail every request using it.
      if (!isNotFound(e)) {
        throw new Error(`Could not delete uploaded file ${row.file_id}: ${explainApiError(e)}`);
      }
    }
  }
  db().prepare('DELETE FROM uploads WHERE hash = ?').run(hash);
  return true;
}

/**
 * Drops cache entries whose remote file no longer exists — deleted from the
 * Console, or expired with the organisation's storage. A stale id is worse
 * than a cache miss: it is accepted at build time and fails every request that
 * carries it, which a batch reports only when it ends.
 *
 * It deliberately does NOT delete remote files that have no local row. Wanigan
 * cannot prove it uploaded them, and the Files API is organisation-wide — a
 * "cleanup" here would destroy another application's files.
 */
export async function pruneOrphans(): Promise<number> {
  if (isMock()) return 0;

  const rows = db().prepare('SELECT * FROM uploads').all() as UploadRow[];
  const del = db().prepare('DELETE FROM uploads WHERE hash = ?');
  let pruned = 0;

  for (const r of rows) {
    try {
      await client().beta.files.retrieveMetadata(r.file_id, { betas: [FILES_BETA] });
    } catch (e) {
      // Only a definite "not there" prunes. A 429 or a dropped connection must
      // not throw away a cache that is still perfectly good.
      if (!isNotFound(e)) continue;
      del.run(r.hash);
      pruned++;
    }
  }
  return pruned;
}

/**
 * Rows survive a round trip through SQLite (requests.row_json) and back out
 * again on a retry, so a fileRef reaching build.ts is plain JSON, not the
 * object sources.ts created. Narrow it rather than trusting its shape.
 */
export function asUploadedFile(v: unknown): UploadedFile | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.fileId !== 'string' || !o.fileId) return null;
  if (typeof o.mediaType !== 'string' || !o.mediaType) return null;
  return {
    hash: typeof o.hash === 'string' ? o.hash : '',
    fileId: o.fileId,
    path: typeof o.path === 'string' ? o.path : '',
    bytes: typeof o.bytes === 'number' ? o.bytes : 0,
    mediaType: o.mediaType,
    uploadedAt: typeof o.uploadedAt === 'number' ? o.uploadedAt : 0,
  };
}

function isNotFound(e: unknown): boolean {
  return (e as { status?: number }).status === 404;
}
