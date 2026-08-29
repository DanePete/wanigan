import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir } from './db';
import { uploadFile, isUploadable } from './batch/files';
import { modelFor, DEFAULT_MODEL } from './batch/pricing';

/**
 * Attachments — files a person hands to an agent.
 *
 * Two destinations that look alike and are not. A LIVE SESSION never touches
 * the API from here: Claude Code opens the file with its own Read tool, so
 * Wanigan's whole job is to put the bytes somewhere the agent is allowed to
 * read and then name that place in the prompt. A BATCH RUN is the opposite —
 * Wanigan is the one calling the API, so the file goes through the Files API
 * and travels as a file_id. Uploading is not reimplemented here; batch/files.ts
 * already owns the upload, the content-hash cache and the content-block
 * mapping, and a second implementation would drift from it.
 */

/* ── what the API actually accepts ───────────────────────────────────── */

/*
 * Every constant in this block is a Claude API limit, not a Wanigan
 * preference. They are encoded here so a file that breaks one is refused with
 * a sentence naming the limit, instead of surfacing as an opaque API error
 * three steps later — after the file was staged, or after it was paid for and
 * uploaded.
 */

/** The only four image formats the API accepts. Not HEIC, TIFF, SVG or BMP. */
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Said in full whenever an image is refused, because "unsupported" is not actionable. */
const IMAGE_FORMATS_SENTENCE =
  'Claude accepts only JPEG, PNG, GIF and WebP images. Convert it to PNG and attach that instead.';

/** API limit: 8000 px on either edge. */
const MAX_IMAGE_EDGE_PX = 8000;

/** API limit: 10 MB per image, measured on the base64 payload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** API limit: a request carrying a PDF may not exceed 32 MB in total. */
const MAX_PDF_REQUEST_BYTES = 32 * 1024 * 1024;

/** API limits: 600 pages per PDF, or 100 on a 200k-context model. */
const MAX_PDF_PAGES = 600;
const MAX_PDF_PAGES_200K = 100;

/** Claude views images in 28x28 patches; one patch is one visual token. */
const PATCH_PX = 28;

/**
 * Oversized images are downscaled before they are counted, preserving aspect
 * ratio. Two tiers, and the tier decides both the long edge and the ceiling on
 * the resulting token count.
 */
const HIGH_RES_LONG_EDGE_PX = 2576; // Claude 4.7 and later
const HIGH_RES_TOKEN_CAP = 4784;
const STANDARD_LONG_EDGE_PX = 1568; // everything earlier
const STANDARD_TOKEN_CAP = 1568;

/**
 * Above 20 images in one request a stricter per-image dimension limit applies
 * to EVERY image in that request, not just the ones past the twentieth.
 */
const MANY_IMAGES_PER_REQUEST = 20;
const MANY_IMAGES_MAX_EDGE_PX = 2000;

/** The high-resolution vision tier arrived with Claude 4.7. */
const HIGH_RES_SINCE = 407; // major * 100 + minor

/* ── Wanigan's own thresholds ────────────────────────────────────────── */

/**
 * Enough of a file to identify it and read its dimensions. A JPEG can carry a
 * megabyte of EXIF and an embedded thumbnail before its SOF marker, and
 * readFileSync on a 30 MB PDF just to look at five header bytes is waste.
 */
const HEADER_BYTES = 512 * 1024;

/** Wanigan does not parse PDFs, so it warns about the page ceiling by size. */
const PDF_PAGE_WARN_BYTES = 2 * 1024 * 1024;

/** Roughly 64k tokens of prose. Worth saying out loud before it eats a context window. */
const TEXT_CONTEXT_WARN_BYTES = 256 * 1024;

/** Longest stored filename. Some filesystems stop at 255 bytes; leave room for a counter. */
const MAX_STORED_NAME = 120;

/** pricing.ts holds *batch* rates, which are already half the synchronous price. */
const BATCH_DISCOUNT = 0.5;

export type AttachKind = 'image' | 'pdf' | 'text' | 'notebook' | 'unsupported';

export type AttachmentCheck = {
  ok: boolean;
  kind: AttachKind;
  mediaType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  visualTokens: number | null;
  estimatedUsd: number | null;
  warnings: string[];
  error: string | null;
};

export type Attachment = {
  id: string;
  sessionId: string | null;
  name: string;
  storedPath: string;
  kind: AttachKind;
  mediaType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  visualTokens: number | null;
  addedAt: number;
  fileId: string | null;
};

/* ── storage ─────────────────────────────────────────────────────────── */

/**
 * Phase 21 arrives after the phases 1-20 migration in db.ts, and this module
 * does not own that file. Creating its own table is the exception that keeps
 * the two independent; CREATE TABLE IF NOT EXISTS costs one statement on first
 * use and nothing afterwards.
 */
let schemaReady = false;

function store(): ReturnType<typeof db> {
  const d = db();
  if (schemaReady) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id            TEXT PRIMARY KEY,
      session_id    TEXT,
      name          TEXT NOT NULL,
      stored_path   TEXT NOT NULL,
      kind          TEXT NOT NULL,
      media_type    TEXT NOT NULL,
      bytes         INTEGER NOT NULL,
      width         INTEGER,
      height        INTEGER,
      visual_tokens INTEGER,
      added_at      INTEGER NOT NULL,
      file_id       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, added_at);
  `);
  schemaReady = true;
  return d;
}

// Eager, so the table exists before the first IPC call rather than on whichever
// call happens to land first. Wrapped because dataDir() needs Electron's
// userData path: importing this module outside the main process must not throw,
// and every entry point re-runs store() anyway.
try { store(); } catch { /* the first real call creates it */ }

type Row = {
  id: string;
  session_id: string | null;
  name: string;
  stored_path: string;
  kind: string;
  media_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  visual_tokens: number | null;
  added_at: number;
  file_id: string | null;
};

function toAttachment(r: Row): Attachment {
  return {
    id: r.id,
    sessionId: r.session_id,
    name: r.name,
    storedPath: r.stored_path,
    kind: asKind(r.kind),
    mediaType: r.media_type,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    visualTokens: r.visual_tokens,
    addedAt: r.added_at,
    fileId: r.file_id,
  };
}

function asKind(v: string): AttachKind {
  return v === 'image' || v === 'pdf' || v === 'text' || v === 'notebook' ? v : 'unsupported';
}

function insert(a: Attachment): Attachment {
  store().prepare(`
    INSERT INTO attachments (id, session_id, name, stored_path, kind, media_type, bytes,
                             width, height, visual_tokens, added_at, file_id)
    VALUES (@id,@sessionId,@name,@storedPath,@kind,@mediaType,@bytes,
            @width,@height,@visualTokens,@addedAt,@fileId)
  `).run(a);
  return a;
}

function newId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/* ── where staged files live ─────────────────────────────────────────── */

function attachmentsRoot(): string {
  return path.join(dataDir(), 'attachments');
}

/**
 * Staged attachments live under Wanigan's own data directory, one directory per
 * session.
 *
 * Wanigan stages a COPY rather than pointing the agent at the original, for two
 * reasons. The original may be on a volume that disappears mid-session — an
 * ejected card, an unmounted network share — or in a folder the agent has no
 * business reading at all. And a screenshot on the Desktop sits outside the
 * project root, where phase 19's 'project' trust level would correctly deny
 * reading it. Staging into a directory Wanigan controls and passes to the agent
 * with --add-dir is what makes an attachment legible to the policy gate
 * (isAttachmentPath below) instead of a hole punched through it.
 */
export function attachmentsDir(sessionId: string): string {
  const id = String(sessionId ?? '').trim();
  // The session id becomes a path segment, so it is checked rather than
  // trusted: a crafted id must not be able to write outside the root.
  if (!id || id !== path.basename(id) || id === '.' || id === '..' || /[/\\]/.test(id)) {
    throw new Error(
      `"${sessionId}" is not a usable session id, so Wanigan cannot pick a directory to stage attachments in.`
    );
  }
  return path.join(attachmentsRoot(), id);
}

/**
 * Make the per-session directory before the agent starts. Both Claude Code and
 * Codex are launched with this directory as an additional allowed root, so a
 * file attached later in the session is readable without relaxing access to
 * the whole Wanigan data directory.
 */
export function prepareAttachmentDir(sessionId: string): string {
  const dir = attachmentsDir(sessionId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Wanigan could not prepare the attachment folder ${dir} (${msg}).`);
  }
  return dir;
}

function contained(base: string, full: string): boolean {
  return full === base || full.startsWith(base + path.sep);
}

/**
 * Resolve to the nearest existing ancestor's real location. The data directory
 * can sit behind a symlinked path, and comparing a real path against a lexical
 * root would report every staged file as being outside the root.
 */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...[...rest].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/**
 * Whether an absolute path is a staged attachment. Phase 19's policy gate calls
 * this to allow a read that would otherwise be outside the project root.
 *
 * The comparison is separator-aware on purpose: a plain startsWith would let
 * /Users/x/attachments-evil pass as /Users/x/attachments, which turns an
 * allowance for Wanigan's own directory into an allowance for any sibling an
 * agent can create next to it.
 */
export function isAttachmentPath(p: string): boolean {
  if (!p || typeof p !== 'string') return false;
  let root: string;
  try {
    root = attachmentsRoot();
  } catch {
    return false;
  }
  const full = path.resolve(p);
  return contained(path.resolve(root), full) || contained(realish(root), realish(full));
}

/* ── format detection, from magic bytes ──────────────────────────────── */

type Detected = { mediaType: string; kind: AttachKind; label: string };

function ascii(buf: Buffer, start: number, len: number): string {
  return buf.length >= start + len ? buf.toString('latin1', start, start + len) : '';
}

/**
 * Detection is by header bytes, never by extension. A .png that is really a
 * HEIC is exactly the case that produces a confusing API error three steps
 * later, and it is common — an iPhone photo renamed by hand, or a file saved
 * out of a chat app.
 */
function detect(buf: Buffer, name: string): Detected {
  if (ascii(buf, 0, 8) === '\x89PNG\r\n\x1a\n') return { mediaType: 'image/png', kind: 'image', label: 'PNG' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mediaType: 'image/jpeg', kind: 'image', label: 'JPEG' };
  }
  const gif = ascii(buf, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return { mediaType: 'image/gif', kind: 'image', label: 'GIF' };
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') {
    return { mediaType: 'image/webp', kind: 'image', label: 'WebP' };
  }
  if (ascii(buf, 0, 5) === '%PDF-') return { mediaType: 'application/pdf', kind: 'pdf', label: 'PDF' };

  // ISO base media container. The brand decides whether it is a HEIC photo, an
  // AVIF image or a video — all three are unsupported, and all three arrive
  // wearing a .png or .jpg extension often enough to be worth naming exactly.
  if (ascii(buf, 4, 4) === 'ftyp') {
    const brand = ascii(buf, 8, 4);
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) {
      return { mediaType: 'image/heic', kind: 'unsupported', label: 'HEIC' };
    }
    if (/^avi[fs]$/.test(brand)) return { mediaType: 'image/avif', kind: 'unsupported', label: 'AVIF' };
    return { mediaType: 'video/mp4', kind: 'unsupported', label: 'video' };
  }

  const tiff = ascii(buf, 0, 4);
  if (tiff === 'II\x2a\x00' || tiff === 'MM\x00\x2a') {
    return { mediaType: 'image/tiff', kind: 'unsupported', label: 'TIFF' };
  }
  if (ascii(buf, 0, 2) === 'BM') return { mediaType: 'image/bmp', kind: 'unsupported', label: 'BMP' };
  if (ascii(buf, 0, 4) === '\x00\x00\x01\x00') {
    return { mediaType: 'image/x-icon', kind: 'unsupported', label: 'ICO' };
  }
  if (ascii(buf, 0, 2) === 'PK') return { mediaType: 'application/zip', kind: 'unsupported', label: 'ZIP archive' };

  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { mediaType: 'image/svg+xml', kind: 'unsupported', label: 'SVG' };
  }

  // No magic bytes left to check. Text has none, so the extension and a binary
  // sniff decide — and only after every binary format above has been ruled out,
  // so a mislabelled HEIC can never reach this branch and be called text.
  if (looksTextual(buf)) return textualType(name);
  return { mediaType: 'application/octet-stream', kind: 'unsupported', label: 'binary file' };
}

/** A NUL byte or a crowd of control characters means bytes, not text. */
function looksTextual(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return true;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) odd++;
  }
  return odd / n < 0.05;
}

const TEXT_MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'text/xml',
  css: 'text/css',
};

function textualType(name: string): Detected {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === 'ipynb') {
    return { mediaType: 'application/x-ipynb+json', kind: 'notebook', label: 'Jupyter notebook' };
  }
  return { mediaType: TEXT_MEDIA_TYPES[ext] ?? 'text/plain', kind: 'text', label: 'text file' };
}

/* ── image dimensions, without a decoder ─────────────────────────────── */

type Size = { width: number; height: number };

/**
 * Header parsers for the four supported formats. Each returns null rather than
 * throwing on a truncated or malformed header: a picture Wanigan cannot measure
 * is still a picture Claude can read, so an unreadable size is a warning, not a
 * refusal.
 */
function dimensions(buf: Buffer, mediaType: string): Size | null {
  try {
    switch (mediaType) {
      case 'image/png': return pngSize(buf);
      case 'image/jpeg': return jpegSize(buf);
      case 'image/gif': return gifSize(buf);
      case 'image/webp': return webpSize(buf);
      default: return null;
    }
  } catch {
    return null;
  }
}

/** IHDR is the first chunk by spec: width then height, big-endian, at 16..24. */
function pngSize(buf: Buffer): Size | null {
  if (buf.length < 24 || ascii(buf, 12, 4) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Walk the segment markers to the start-of-frame, which carries the size.
 * SOF0/SOF1/SOF2 are the baseline, extended and progressive cases; the rest of
 * the 0xC0-0xCF range is the same header for rarer codings and reading them too
 * costs nothing. DHT (0xC4), JPG (0xC8) and DAC (0xCC) sit inside that range
 * and are not frames.
 */
function jpegSize(buf: Buffer): Size | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; } // resync past padding
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    // Start of scan: entropy-coded data follows and there is no frame header
    // left to find. Stop, rather than misread compressed bytes as markers.
    if (marker === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** Logical screen descriptor: width then height, little-endian, at 6..10. */
function gifSize(buf: Buffer): Size | null {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/**
 * RIFF container with three chunk variants, and a file written by any of the
 * three is just "a .webp" to whoever attached it.
 */
function webpSize(buf: Buffer): Size | null {
  const chunk = ascii(buf, 12, 4);
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, then the 0x9d 0x01 0x2a sync code.
    if (buf.length < 30) return null;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: signature byte, then 14 bits of width and 14 of height, each
    // stored one less than the real value.
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: canvas size as two 24-bit little-endian values, minus one.
    if (buf.length < 30) return null;
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/* ── token cost ──────────────────────────────────────────────────────── */

/**
 * Tier from the model id rather than a second hard-coded model list, so a model
 * added to pricing.ts cannot silently end up counted on the wrong tier.
 * 'claude-sonnet-4-6' reads as 4.6, 'claude-opus-5' as 5.0.
 */
function highResTier(modelId: string): boolean {
  const m = /^claude-[a-z]+-(\d+)(?:-(\d+))?/.exec(modelId);
  if (!m) return true;
  return Number(m[1]) * 100 + Number(m[2] ?? 0) >= HIGH_RES_SINCE;
}

/**
 * Visual tokens for an image, AFTER the downscale the API applies on the way
 * in. Counting the raw pixels would over-report a 4000 px screenshot by more
 * than double, and an estimate that is wrong in the expensive direction is the
 * one people learn to ignore.
 */
export function visualTokensFor(width: number, height: number, highRes: boolean): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0;

  const longEdge = highRes ? HIGH_RES_LONG_EDGE_PX : STANDARD_LONG_EDGE_PX;
  const cap = highRes ? HIGH_RES_TOKEN_CAP : STANDARD_TOKEN_CAP;

  let w = width;
  let h = height;
  const longest = Math.max(w, h);
  if (longest > longEdge) {
    const scale = longEdge / longest;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const tokens = Math.ceil(w / PATCH_PX) * Math.ceil(h / PATCH_PX);
  return Math.min(tokens, cap);
}

export function estimateImageUsd(visualTokens: number, inputRatePerMTok: number): number {
  if (!Number.isFinite(visualTokens) || !Number.isFinite(inputRatePerMTok)) return 0;
  if (visualTokens <= 0 || inputRatePerMTok <= 0) return 0;
  return (visualTokens / 1_000_000) * inputRatePerMTok;
}

/**
 * An attachment to a live session is billed at the synchronous rate, and
 * pricing.ts stores the batch rate, which is half of it. Quoting half the real
 * cost is worse than quoting none.
 */
function sessionInputRate(modelId: string): number {
  return modelFor(modelId).batchInput / BATCH_DISCOUNT;
}

/* ── inspection ──────────────────────────────────────────────────────── */

function bad(kind: AttachKind, mediaType: string, bytes: number, error: string): AttachmentCheck {
  return {
    ok: false,
    kind,
    mediaType,
    bytes,
    width: null,
    height: null,
    visualTokens: null,
    estimatedUsd: null,
    warnings: [],
    error,
  };
}

/**
 * Read only what identification needs. The whole file is never held in memory
 * here — a 30 MB PDF and a 9 MB screenshot both cost one bounded header read.
 */
function readHeader(abs: string, size: number): Buffer {
  const want = Math.min(size, HEADER_BYTES);
  const buf = Buffer.allocUnsafe(want);
  const fd = fs.openSync(abs, 'r');
  try {
    const n = fs.readSync(fd, buf, 0, want, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function inspect(absPath: string): AttachmentCheck {
  const abs = path.resolve(absPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return bad(
      'unsupported', 'application/octet-stream', 0,
      `Wanigan cannot read ${abs}. Check that the file still exists and that you have permission to open it.`
    );
  }
  if (stat.isDirectory()) {
    return bad(
      'unsupported', 'inode/directory', 0,
      `${path.basename(abs)} is a folder, not a file. Attach the files inside it individually.`
    );
  }
  if (!stat.isFile()) {
    return bad(
      'unsupported', 'application/octet-stream', 0,
      `${abs} is not a regular file, so Wanigan cannot attach it.`
    );
  }
  if (stat.size === 0) {
    return bad(
      'unsupported', 'application/octet-stream', 0,
      `${path.basename(abs)} is empty. Attaching it would tell Claude nothing — check that it saved correctly.`
    );
  }

  let header: Buffer;
  try {
    header = readHeader(abs, stat.size);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(
      'unsupported', 'application/octet-stream', stat.size,
      `Wanigan could not read the start of ${path.basename(abs)} (${msg}). Check the file's permissions.`
    );
  }
  return evaluate(header, path.basename(abs), stat.size);
}

/**
 * The pasted-screenshot path. Electron's clipboard hands over a buffer with no
 * filename and nothing on disk, so there is nothing to stat and the same checks
 * have to run against bytes already in memory.
 */
export function inspectBuffer(buf: Buffer, name: string): AttachmentCheck {
  if (!buf || buf.length === 0) {
    return bad(
      'unsupported', 'application/octet-stream', 0,
      'There is nothing to attach — the clipboard held no image data. Copy the screenshot again and retry.'
    );
  }
  return evaluate(buf, name || defaultScreenshotName(), buf.length);
}

function evaluate(header: Buffer, name: string, bytes: number): AttachmentCheck {
  const d = detect(header, name);
  const warnings: string[] = [];

  if (d.kind === 'unsupported') {
    const claimed = path.extname(name).slice(1).toUpperCase();
    // Naming the mismatch matters more than naming the format: someone looking
    // at a file called shot.png needs to be told it is not one.
    const lie = claimed && d.label.toUpperCase() !== claimed
      ? ` It is named .${claimed.toLowerCase()}, but its contents are ${d.label}.`
      : '';
    const fix = d.mediaType.startsWith('image/')
      ? ` ${IMAGE_FORMATS_SENTENCE}`
      : ' Attach an image (JPEG, PNG, GIF or WebP), a PDF, or a text file instead.';
    return bad('unsupported', d.mediaType, bytes, `${name} is a ${d.label}, which Claude cannot read.${lie}${fix}`);
  }

  if (d.kind === 'image') return imageCheck(header, name, bytes, d, warnings);

  if (d.kind === 'pdf') {
    if (bytes > MAX_PDF_REQUEST_BYTES) {
      return bad(
        'pdf', d.mediaType, bytes,
        `${name} is ${mb(bytes)}, over the ${mb(MAX_PDF_REQUEST_BYTES)} ceiling for a request carrying a PDF. ` +
        `Split it, or extract the pages you need and attach those.`
      );
    }
    if (bytes > PDF_PAGE_WARN_BYTES) {
      // Counting pages would mean parsing the PDF, which this module does not
      // do; size is the honest proxy, and the ceiling is worth stating.
      warnings.push(
        `${name} is ${mb(bytes)}, so it may be long. Claude reads at most ${MAX_PDF_PAGES} pages per PDF, ` +
        `and only ${MAX_PDF_PAGES_200K} on a 200k-context model.`
      );
    }
    return okCheck('pdf', d.mediaType, bytes, null, warnings);
  }

  // Text and notebooks need no format negotiation for a live session — Claude
  // Code opens them with its own Read tool.
  if (bytes > TEXT_CONTEXT_WARN_BYTES) {
    warnings.push(
      `${name} is ${mb(bytes)} of text, which will fill a large share of the context window. ` +
      `Consider attaching only the part you want read.`
    );
  }
  if (d.mediaType === 'text/plain' && !path.extname(name)) {
    warnings.push(
      `Wanigan could not identify ${name} from its header and is treating it as plain text, because it contains no binary bytes.`
    );
  }
  return okCheck(d.kind, d.mediaType, bytes, null, warnings);
}

function imageCheck(
  header: Buffer,
  name: string,
  bytes: number,
  d: Detected,
  warnings: string[]
): AttachmentCheck {
  if (!IMAGE_MEDIA_TYPES.has(d.mediaType)) {
    return bad('unsupported', d.mediaType, bytes, `${name} is a ${d.label}. ${IMAGE_FORMATS_SENTENCE}`);
  }
  if (bytes > MAX_IMAGE_BYTES) {
    return bad(
      'image', d.mediaType, bytes,
      `${name} is ${mb(bytes)}, over the ${mb(MAX_IMAGE_BYTES)} limit for a single image. ` +
      `Save it at a lower quality or a smaller size and attach that.`
    );
  }

  const size = dimensions(header, d.mediaType);
  if (!size || size.width <= 0 || size.height <= 0) {
    // Not fatal. Claude will still read the image; Wanigan just cannot price it.
    warnings.push(
      `Wanigan could not read the dimensions of ${name}, so it cannot estimate what viewing it will cost.`
    );
    return okCheck('image', d.mediaType, bytes, null, warnings);
  }
  if (size.width > MAX_IMAGE_EDGE_PX || size.height > MAX_IMAGE_EDGE_PX) {
    return bad(
      'image', d.mediaType, bytes,
      `${name} is ${size.width}x${size.height} px, over the ${MAX_IMAGE_EDGE_PX}x${MAX_IMAGE_EDGE_PX} px limit. ` +
      `Resize it so neither edge exceeds ${MAX_IMAGE_EDGE_PX} px and attach that.`
    );
  }

  if (Math.max(size.width, size.height) > MANY_IMAGES_MAX_EDGE_PX) {
    // The set-level rule, stated per image because that is where it is
    // actionable: this is the image that would have to shrink.
    warnings.push(
      `${name} is ${size.width}x${size.height} px. A request carrying more than ${MANY_IMAGES_PER_REQUEST} images ` +
      `enforces a stricter dimension limit on every image in it — resize this one to ` +
      `${MANY_IMAGES_MAX_EDGE_PX} px or fewer on its long edge before attaching that many.`
    );
  }
  if (isAnimated(header, d.mediaType)) {
    warnings.push(
      `${name} is animated, and Claude reads only its first frame. Export the frame you mean if it is not the first.`
    );
  }

  return okCheck('image', d.mediaType, bytes, size, warnings);
}

/**
 * Animation is a warning, not a refusal — the first frame is often exactly what
 * someone meant to show. A GIF loops via the NETSCAPE2.0 application extension;
 * a WebP announces it with the ANIM flag in its VP8X chunk.
 */
function isAnimated(header: Buffer, mediaType: string): boolean {
  if (mediaType === 'image/gif') return header.includes('NETSCAPE2.0', 0, 'latin1');
  if (mediaType === 'image/webp') {
    return ascii(header, 12, 4) === 'VP8X' && header.length > 20 && (header[20] & 0x02) !== 0;
  }
  return false;
}

function okCheck(
  kind: AttachKind,
  mediaType: string,
  bytes: number,
  size: Size | null,
  warnings: string[]
): AttachmentCheck {
  const highRes = highResTier(DEFAULT_MODEL);
  const visualTokens = size ? visualTokensFor(size.width, size.height, highRes) : null;
  return {
    ok: true,
    kind,
    mediaType,
    bytes,
    width: size?.width ?? null,
    height: size?.height ?? null,
    visualTokens,
    // Priced against the default model, because inspect() is a preflight and
    // does not yet know which session or run the file is headed for.
    estimatedUsd:
      visualTokens === null ? null : estimateImageUsd(visualTokens, sessionInputRate(DEFAULT_MODEL)),
    warnings,
    error: null,
  };
}

function mb(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/* ── destination A: a live session ───────────────────────────────────── */

const CANONICAL_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

function defaultScreenshotName(): string {
  return `screenshot-${Math.floor(Date.now() / 1000)}.png`;
}

/**
 * Never trust the incoming name for a path. It arrives from a drag-and-drop, a
 * clipboard payload or an IPC message, and a name like "../../.claude/settings"
 * would otherwise decide where Wanigan writes.
 */
function safeName(raw: string, check: AttachmentCheck): string {
  let base = path.basename(String(raw ?? '').replace(/\\/g, '/'));
  // Control characters first: a newline inside a filename would make the
  // prompt Wanigan types into the PTY look like two lines, and the agent
  // would receive half a sentence.
  base = base.replace(/[\u0000-\u001f\u007f]/g, '');
  base = base.replace(/[:*?"<>|]/g, '-');
  base = base.replace(/\s+/g, ' ').trim();
  base = base.replace(/^\.+/, '');
  if (!base || base === '.' || base === '..') base = 'attachment';

  let ext = path.extname(base);
  let stem = base.slice(0, base.length - ext.length) || 'attachment';

  // Make the stored extension match what the bytes actually are. A staged
  // photo.png that is really a JPEG would otherwise reach the agent's Read tool
  // wearing the wrong type — the same confusion this module exists to prevent,
  // just one step further downstream.
  const canonical = CANONICAL_EXT[check.mediaType];
  const lower = ext.toLowerCase();
  if (canonical && lower !== canonical && !(canonical === '.jpg' && lower === '.jpeg')) {
    ext = canonical;
  }
  if (!ext && check.kind === 'notebook') ext = '.ipynb';

  if (stem.length + ext.length > MAX_STORED_NAME) {
    stem = stem.slice(0, Math.max(1, MAX_STORED_NAME - ext.length));
  }
  return `${stem}${ext}`;
}

/** Two screenshots pasted a second apart must not overwrite one another. */
function uniqueName(dir: string, desired: string): string {
  const ext = path.extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  let candidate = desired;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) {
    if (n > 9999) {
      throw new Error(
        `There are already thousands of files named like "${desired}" staged for this session. ` +
        `Remove some attachments, or rename the file before attaching it.`
      );
    }
    candidate = `${stem}-${n}${ext}`;
  }
  return candidate;
}

function stage(
  sessionId: string,
  name: string,
  check: AttachmentCheck,
  write: (dest: string) => void
): Attachment {
  if (!check.ok) throw new Error(check.error ?? `Wanigan cannot attach ${name}.`);

  const dir = prepareAttachmentDir(sessionId);
  const stored = uniqueName(dir, safeName(name, check));
  const dest = path.join(dir, stored);

  try {
    write(dest);
    const written = fs.statSync(dest);
    if (!written.isFile() || written.size !== check.bytes) {
      throw new Error(
        `the staged file is ${written.size} bytes; expected ${check.bytes} bytes. Please attach it again.`
      );
    }
  } catch (e) {
    // A failed paste used to leave an empty session directory behind. That
    // looked like a successful attachment path even though there was no image
    // for the agent to read.
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Wanigan could not stage ${name} into ${dir} (${msg}). Check that the disk is writable and not full.`
    );
  }

  try {
    return insert({
      id: newId(),
      sessionId,
      name: stored,
      storedPath: dest,
      kind: check.kind,
      mediaType: check.mediaType,
      bytes: check.bytes,
      width: check.width,
      height: check.height,
      visualTokens: check.visualTokens,
      addedAt: Date.now(),
      fileId: null,
    });
  } catch (e) {
    // Never show a file as staged when its durable record was not written.
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Wanigan staged ${name}, but could not record it (${msg}). Attach it again.`);
  }
}

export function attachToSession(sessionId: string, absPath: string): Attachment {
  const abs = path.resolve(absPath);
  const check = inspect(abs);
  return stage(sessionId, path.basename(abs), check, (dest) => fs.copyFileSync(abs, dest));
}

/**
 * A pasted screenshot. Electron's clipboard gives a buffer and no filename, and
 * this is the single most common way anyone attaches an image, so it is a
 * first-class entry point rather than a wrapper someone has to go looking for.
 */
export function attachBufferToSession(sessionId: string, buf: Buffer, name: string): Attachment {
  const desired = (name ?? '').trim() || defaultScreenshotName();
  const check = inspectBuffer(buf, desired);
  return stage(sessionId, desired, check, (dest) => fs.writeFileSync(dest, buf));
}

/** Oldest first: the order they were attached is the order the prompt lists them. */
export function sessionAttachments(sessionId: string): Attachment[] {
  const rows = store()
    .prepare('SELECT * FROM attachments WHERE session_id = ? ORDER BY added_at ASC, rowid ASC')
    .all(sessionId) as Row[];
  return rows.map(toAttachment);
}

/** A prompt must never name a stale attachment row whose file has gone away. */
export function promptableSessionAttachments(sessionId: string): Attachment[] {
  return sessionAttachments(sessionId).filter((attachment) => {
    try { return fs.statSync(attachment.storedPath).isFile(); }
    catch { return false; }
  });
}

/**
 * Removing an attachment deletes the staged copy, never the original. A batch
 * attachment's stored_path is the user's own file, still sitting wherever they
 * keep it; unlinking that would turn "remove this from the run" into "delete my
 * document", so the path is checked against Wanigan's own directory first.
 */
export function removeAttachment(id: string): boolean {
  const d = store();
  const row = d.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Row | undefined;
  if (!row) return false;
  if (isAttachmentPath(row.stored_path)) {
    try {
      fs.rmSync(row.stored_path, { force: true });
    } catch { /* already gone is the outcome we wanted */ }
  }
  d.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  return true;
}

/**
 * Explicitly discard everything a session staged. This is intentionally not
 * normal exit cleanup: the directory is also the agent's granted artifact
 * directory, and reports or generated images linked from a saved conversation
 * must survive the PTY that created them. Call this only for a launch that
 * never started or an explicit removal action.
 */
export function cleanupSessionAttachments(sessionId: string): number {
  let dir: string;
  try {
    dir = attachmentsDir(sessionId);
  } catch {
    return 0;
  }

  let removed = 0;
  try {
    removed = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch { /* nothing was ever staged for this session */ }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* something still holds it open; the rows go regardless */ }

  store().prepare('DELETE FROM attachments WHERE session_id = ?').run(sessionId);
  return removed;
}

/**
 * The text Wanigan types into the PTY.
 *
 * Deliberately ends WITHOUT a trailing newline. The integrator decides when to
 * submit, because typing Enter on someone's behalf is how a half-written prompt
 * gets sent — the person usually still wants to say what to do with the file.
 */
export function promptReferenceFor(a: Attachment[]): string {
  const list = (a ?? []).filter(Boolean);
  if (list.length === 0) return '';

  if (list.length === 1) return `${leadIn(list, 1)} ${quoted(list[0].storedPath)}`;

  const lines = list.map((att, i) => `${i + 1}. ${quoted(att.storedPath)}`);
  return `${leadIn(list, list.length)}\n${lines.join('\n')}`;
}

function leadIn(list: Attachment[], count: number): string {
  if (count === 1) {
    if (list[0].kind !== 'image') return 'Please read this file:';
    // A pasted screenshot is named by this module, so the word is accurate.
    return list[0].name.startsWith('screenshot-')
      ? 'Please look at this screenshot:'
      : 'Please look at this image:';
  }
  return list.every((x) => x.kind === 'image')
    ? `Please look at these ${count} images:`
    : `Please look at these ${count} attached files:`;
}

/** An absolute path with a space in it reads as one thing only if it is quoted. */
function quoted(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/**
 * Launch-time file arguments, for attachments that already carry a file_id. The
 * flag takes `file_id:path`, which gives the agent a stable name for a file it
 * never downloaded. Attachments staged on disk are deliberately not passed this
 * way — they are reached through --add-dir and named in the prompt instead.
 */
export function launchFileArgs(a: Attachment[]): string[] {
  const out: string[] = [];
  for (const att of a ?? []) {
    if (!att?.fileId) continue;
    out.push('--file', `${att.fileId}:${att.name}`);
  }
  return out;
}

/* ── destination B: a batch run ──────────────────────────────────────── */

/**
 * batch/files.ts maps every text-ish file to text/plain on purpose: the
 * document content block accepts text/plain everywhere, and a media type the
 * API rejects is a per-request failure, which inside a batch is a failure you
 * learn about a day late. Notebooks ride the same path — application/x-ipynb+json
 * is descriptive locally and unacceptable on the wire.
 */
function batchMediaType(check: AttachmentCheck): string {
  return check.kind === 'image' || check.kind === 'pdf' ? check.mediaType : 'text/plain';
}

/**
 * Upload files for a batch run and record them.
 *
 * Unsupported formats are rejected BEFORE any upload: paying to send bytes the
 * API will refuse on every request that references them is pure waste, and the
 * refusal would arrive far too late to act on. Nothing throws for a single bad
 * file either — one HEIC in a set of thirty must not lose the twenty-nine
 * uploads that already succeeded and were already paid for.
 */
export async function uploadForBatch(
  absPaths: string[]
): Promise<{ attached: Attachment[]; failed: { path: string; error: string }[] }> {
  const attached: Attachment[] = [];
  const failed: { path: string; error: string }[] = [];

  // Sequential on purpose. Attachments arrive in handfuls — a few screenshots
  // and a PDF — not the 900-file globs uploadMany's worker pool exists for, and
  // uploadFile carries the content-hash cache and in-flight de-duplication that
  // are what actually matter at this size.
  for (const p of absPaths ?? []) {
    const abs = path.resolve(p);
    const check = inspect(abs);
    if (!check.ok) {
      failed.push({ path: abs, error: check.error ?? `Wanigan cannot attach ${path.basename(abs)}.` });
      continue;
    }

    const mediaType = batchMediaType(check);
    if (!isUploadable(mediaType)) {
      failed.push({
        path: abs,
        error:
          `${path.basename(abs)} is ${check.mediaType}, which has no content block Claude accepts, ` +
          `so uploading it would only buy a failed request. Convert it to an image, a PDF or text first.`,
      });
      continue;
    }

    try {
      const uploaded = await uploadFile(abs, mediaType);
      attached.push(
        insert({
          id: newId(),
          // No session owns a batch attachment, and stored_path is the user's
          // own file: nothing was staged, because the bytes went to the API.
          sessionId: null,
          name: path.basename(abs),
          storedPath: abs,
          kind: check.kind,
          mediaType: check.mediaType,
          bytes: check.bytes,
          width: check.width,
          height: check.height,
          visualTokens: check.visualTokens,
          addedAt: Date.now(),
          fileId: uploaded.fileId,
        })
      );
    } catch (e) {
      failed.push({ path: abs, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { attached, failed };
}
