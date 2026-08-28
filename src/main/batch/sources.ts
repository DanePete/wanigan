import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceConfig, UploadedFile } from '../../shared/types';
import type { Row } from './template';
import { FILE_REF_COLUMN, isUploadable, mediaTypeFor, uploadMany } from './files';

const exec = promisify(execFile);

export type Dataset = { rows: Row[]; columns: string[]; note?: string };

export async function loadSource(src: SourceConfig): Promise<Dataset> {
  // The upload flag is additive and not part of SourceConfig, so it is read
  // defensively: a source saved before uploads existed must behave exactly as
  // it did, and a run config round-trips through JSON either way.
  const upload = (src as { upload?: boolean }).upload === true;
  switch (src.kind) {
    case 'csv':     return fromCsv(src.text, src.delimiter ?? ',');
    case 'jsonl':   return fromJsonl(src.text);
    case 'glob':    return await fromGlob(src.root, src.pattern, src.maxBytes ?? 200_000, upload);
    case 'files':   return await fromFileList(src.root, src.paths, src.maxBytes ?? 200_000, upload);
    case 'command': return await fromCommand(src.cwd, src.command, src.format);
  }
}

/**
 * Uploads every file the Files API can be given a matching content block for,
 * keyed by absolute path. Anything unclassifiable is left out of the map on
 * purpose — the caller inlines it instead, because a content block whose type
 * does not match the file fails per request, and a batch only reports that
 * when the whole batch ends.
 */
async function uploadPass(files: string[], notes: string[]): Promise<Map<string, UploadedFile>> {
  const eligible = files.filter((f) => isUploadable(mediaTypeFor(f)));
  const map = new Map<string, UploadedFile>();
  const skipped = files.length - eligible.length;
  if (skipped) {
    notes.push(`${skipped} file(s) inlined instead of uploaded — Foreman cannot classify their type`);
  }
  if (!eligible.length) return map;

  const { uploaded, failed } = await uploadMany(eligible);
  for (const u of uploaded) map.set(u.path, u);
  if (uploaded.length) notes.push(`${uploaded.length} file(s) sent by reference`);
  if (failed.length) {
    notes.push(`${failed.length} upload(s) failed and were inlined instead (first: ${failed[0].error})`);
  }
  return map;
}

/** RFC4180-ish: handles quoted fields, embedded delimiters, doubled quotes, CRLF. */
export function fromCsv(text: string, delimiter = ','): Dataset {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; continue; }
    if (c === delimiter) { record.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { record.push(field); records.push(record); record = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return { rows: [], columns: [] };

  const columns = nonEmpty[0].map((h, i) => h.trim() || `col${i}`);
  const rows = nonEmpty.slice(1).map((r) =>
    Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])) as Row
  );
  return { rows, columns };
}

export function fromJsonl(text: string): Dataset {
  const rows: Row[] = [];
  const bad: number[] = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try { rows.push(JSON.parse(t)); } catch { bad.push(i + 1); }
  });
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const note = bad.length ? `${bad.length} unparseable line(s) skipped (first at line ${bad[0]})` : undefined;
  return { rows, columns, note };
}

/**
 * One row per matching file: { path, relpath, ext, size, content }.
 * Files over maxBytes are truncated rather than dropped, with a marker, so a
 * repo audit never silently skips the biggest file in the tree.
 *
 * With `upload` on, a classifiable file is sent to the Files API once and the
 * row carries it in `fileRef` with an empty `content` — which is what keeps a
 * whole-repo audit under the 256 MB batch ceiling.
 */
async function fromGlob(root: string, pattern: string, maxBytes: number, upload = false): Promise<Dataset> {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) throw new Error(`Source root does not exist: ${abs}`);

  const re = globToRegExp(pattern);
  const found: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '.next', 'vendor', 'dist', 'build', '.cache']);

  (function walk(dir: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue; }
      const rel = path.relative(abs, full);
      if (re.test(rel)) found.push(full);
    }
  })(abs);

  found.sort();
  const notes: string[] = [];
  const uploads = upload ? await uploadPass(found, notes) : null;
  let truncated = 0;
  const rows: Row[] = found.map((f) => {
    const size = fs.statSync(f).size;
    const ref = uploads?.get(f);
    // An uploaded file is never read here: reading it would undo the point of
    // uploading it, and for a PDF or a PNG the utf8 decode is meaningless.
    if (ref) {
      return { path: f, relpath: path.relative(abs, f), ext: path.extname(f).slice(1), size, content: '', [FILE_REF_COLUMN]: ref };
    }
    let content = fs.readFileSync(f, 'utf8');
    if (content.length > maxBytes) { content = content.slice(0, maxBytes) + `\n\n[... truncated at ${maxBytes} chars of ${size} bytes ...]`; truncated++; }
    return { path: f, relpath: path.relative(abs, f), ext: path.extname(f).slice(1), size, content };
  });

  if (truncated) notes.push(`${truncated} file(s) truncated at ${maxBytes} chars`);
  return {
    rows,
    columns: upload
      ? ['path', 'relpath', 'ext', 'size', 'content', FILE_REF_COLUMN]
      : ['path', 'relpath', 'ext', 'size', 'content'],
    note: notes.length ? notes.join(' · ') : undefined,
  };
}

/**
 * Runs a shell command and parses stdout. This is how a Drupal dataset arrives:
 *   drush sql:query --extra=-B "SELECT nid,title FROM node_field_data" > tsv
 *   drush php:eval '...' | jq -c
 * Localhost-only tool, single operator — same trust boundary as your terminal.
 */
async function fromCommand(cwd: string, command: string, format: 'csv' | 'jsonl'): Promise<Dataset> {
  const abs = path.resolve(cwd);
  if (!fs.existsSync(abs)) throw new Error(`Working directory does not exist: ${abs}`);
  const { stdout } = await exec(process.env.SHELL || '/bin/zsh', ['-lc', command], {
    cwd: abs, maxBuffer: 256 * 1024 * 1024, timeout: 120_000,
  });
  const ds = format === 'csv' ? fromCsv(stdout) : fromJsonl(stdout);
  return { ...ds, note: [ds.note, `${stdout.length.toLocaleString()} bytes from command`].filter(Boolean).join(' · ') };
}

/**
 * One row per named file, same shape as the glob source. This is what a session
 * hands to a batch: "run this prompt over exactly the files the agent touched".
 * Deleted files are skipped rather than failing the whole run.
 *
 * With `upload` on, a classifiable file travels in `fileRef` instead of being
 * inlined, exactly as in the glob source.
 */
async function fromFileList(root: string, paths: string[], maxBytes: number, upload = false): Promise<Dataset> {
  const abs = path.resolve(root);
  const rows: Row[] = [];
  const extra: string[] = [];
  let missing = 0, truncated = 0;

  // The upload pass needs the candidate list up front, and only files that are
  // inside the root and still on disk — a path escaping the root, or deleted
  // since the session listed it, must not be sent anywhere.
  const uploads = upload ? await uploadPass(paths.reduce<string[]>((acc, rel) => {
    const full = path.resolve(abs, rel);
    if (full !== abs && !full.startsWith(abs + path.sep)) return acc;
    if (fs.existsSync(full)) acc.push(full);
    return acc;
  }, []), extra) : null;

  for (const rel of paths) {
    const full = path.resolve(abs, rel);
    if (full !== abs && !full.startsWith(abs + path.sep)) continue;
    let size: number;
    try { size = fs.statSync(full).size; } catch { missing++; continue; }
    const ref = uploads?.get(full);
    if (ref) {
      rows.push({ path: full, relpath: rel, ext: path.extname(full).slice(1), size, content: '', [FILE_REF_COLUMN]: ref });
      continue;
    }
    let content: string;
    try { content = fs.readFileSync(full, 'utf8'); } catch { missing++; continue; }
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + `\n\n[... truncated at ${maxBytes} chars of ${size} bytes ...]`;
      truncated++;
    }
    rows.push({ path: full, relpath: rel, ext: path.extname(full).slice(1), size, content });
  }

  const notes = [
    ...extra,
    missing ? `${missing} file(s) skipped (deleted or unreadable)` : '',
    truncated ? `${truncated} truncated at ${maxBytes} chars` : '',
  ].filter(Boolean);
  return {
    rows,
    columns: upload
      ? ['path', 'relpath', 'ext', 'size', 'content', FILE_REF_COLUMN]
      : ['path', 'relpath', 'ext', 'size', 'content'],
    note: notes.length ? notes.join(' · ') : undefined,
  };
}

/** Minimal glob: ** , * and ? . Enough for src/**\/*.php without a dependency. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else if (c === '/') out += '/';
    else out += c;
  }
  return new RegExp('^' + out + '$');
}
