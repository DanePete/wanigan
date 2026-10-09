// The code editor's side in the core: reading and writing the owner's files
// by hand. Every path is relative to a root, the project folder or a card's
// own worktree, and is refused when it leaves that root (by `..` or through a
// link), names anything of git's own, is not UTF-8 text, or is larger than an
// editor should open. A save names the version it was made from; if anything
// else wrote the file since (an agent, another editor), nothing is written and
// the file as it is now comes back, so the owner can reconcile the two. A save
// is atomic (a temporary file renamed over the old one), keeps the file's line
// endings, byte order mark and mode, is recorded in the project's activity and
// is announced exactly as an agent's edit is, so the live view follows it.
// Someone else's code (Drupal core, contributed projects, vendor folders,
// WordPress itself and its plugins) opens read-only with the reason, and is
// written only when the owner says to edit it anyway.
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync, chmodSync, closeSync, constants, existsSync, fsyncSync, openSync, readdirSync, realpathSync, renameSync, statSync,
  unlinkSync, writeSync, type Dirent,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  MAX_DIR_ENTRIES, MAX_EDIT_BYTES, MAX_LISTED, cleanPath, lineEndings, toLf,
  type DirList, type FileEditor, type FileGuard, type FileList, type FileRoot, type FileSave, type FileStat, type FileText,
} from '../shared/files.ts';
import { OWNER, type Provider } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Board } from './board.ts';
import { readBoundedFile } from './bounded-file.ts';
import type { Ctx } from './context.ts';
import { runGit } from './git.ts';
import { within } from './safe-fs.ts';

/** How long quick open's list of a folder is reused before it is read again. */
const LIST_TTL_MS = 5_000;
/** A walk of a folder that is not a repository stops after this long, and says the list was cut. */
const WALK_MS = 3_000;
/** Folders of code someone else installed: left out of quick open unless asked for. */
const INSTALLED = new Set(['node_modules', 'vendor']);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HASH = /^[0-9a-f]{64}$/;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Located {
  /** The root as recorded (the project folder or the worktree): agents' edits are reported under it. */
  root: string;
  rel: string;
  /** The file's real path, inside the real root. */
  real: string;
  projectId: string;
  cardId: string | null;
}

interface Decoded { text: string; eol: 'lf' | 'crlf'; mixedEol: boolean; bom: boolean; finalNewline: boolean }

/**
 * Whose a file is, by where it sits in the root: someone else's code says why
 * it should not be changed in place. Markers on disk decide (Drupal's
 * core/lib/Drupal.php, WordPress's wp-includes/version.php), so a folder that
 * merely happens to be called `core` is the owner's.
 */
export function guardOf(root: string, rel: string): { guard: FileGuard; reason: string } | null {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i] as string;
    const above = join(root, ...parts.slice(0, i));
    if (name === 'core' && existsSync(join(above, 'core', 'lib', 'Drupal.php'))) {
      return { guard: 'drupal-core', reason: 'Drupal core: changes here are lost when Drupal updates. Override it in your theme or a module instead.' };
    }
    if (name === 'contrib' && i > 0 && /^(modules|themes|profiles)$/.test(parts[i - 1] as string)) {
      return { guard: 'contrib', reason: 'A contributed project: changes here are lost when it updates. Override it in your theme, or patch it through Composer.' };
    }
    if (name === 'vendor') {
      return {
        guard: 'vendor',
        reason: existsSync(join(above, 'composer.json'))
          ? 'Composer’s vendor folder: changes here are lost on the next composer install.'
          : 'A vendor folder: installed code, replaced the next time it is installed.',
      };
    }
    if (name === 'node_modules') return { guard: 'node_modules', reason: 'Installed by npm: changes here are lost on the next npm install.' };
    if ((name === 'wp-includes' || name === 'wp-admin') && existsSync(join(above, 'wp-includes', 'version.php'))) {
      return { guard: 'wordpress-core', reason: 'WordPress core: changes here are lost when WordPress updates. Use a child theme or a plugin instead.' };
    }
    // A plugin's own folder (not mu-plugins, which hold the site's own code).
    if (name === 'plugins' && i > 0 && parts[i - 1] === 'wp-content' && i < parts.length - 2) {
      return { guard: 'wordpress-plugin', reason: 'A WordPress plugin: if it came from WordPress.org or a vendor, its next update replaces these changes.' };
    }
  }
  return null;
}

/** Bytes as editor text, or why they are not text the editor opens. */
export function decodeText(bytes: Buffer): Decoded {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new CoreError('refused', 'This file is UTF-16 text; the editor opens UTF-8 only.');
  }
  const bom = bytes.subarray(0, 3).equals(BOM);
  const body = bom ? bytes.subarray(3) : bytes;
  if (body.includes(0)) throw new CoreError('refused', 'This is a binary file, not text the editor can open.');
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new CoreError('refused', 'This file is not UTF-8 text (it may be binary, or in another encoding), so the editor will not open it.');
  }
  const { eol, mixed } = lineEndings(raw);
  return { text: toLf(raw), eol, mixedEol: mixed, bom, finalNewline: /\r?\n$|\r$/.test(raw) };
}

/** Editor text as the bytes the file had: its line endings and byte order mark put back. */
export function encodeText(text: string, how: { eol: 'lf' | 'crlf'; bom: boolean }): Buffer {
  const lf = toLf(text);
  const body = Buffer.from(how.eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
  return how.bom ? Buffer.concat([BOM, body]) : body;
}

export class Files {
  private readonly ctx: Ctx;
  private readonly board: Board;
  /** Hashes of files by what their stat said, so polling an open file reads it only when it changed. */
  private readonly hashes = new Map<string, { key: string; hash: string }>();
  private readonly lists = new Map<string, { at: number; list: FileList }>();

  constructor(ctx: Ctx, board: Board) {
    this.ctx = ctx;
    this.board = board;
  }

  /** A file to edit: its text, how to write it back, and whether it should be changed here. */
  read(where: FileRoot, rawPath: unknown): FileText {
    const at = this.locate(where, rawPath);
    return this.textOf(at, this.bytes(at));
  }

  /**
   * Write a file the owner changed by hand, if it is still what they read
   * (`baseHash`). Otherwise nothing is written, and the file as it is now comes
   * back. Someone else's code needs `anyway`.
   */
  write(where: FileRoot, rawPath: unknown, text: unknown, baseHash: unknown, anyway: boolean): FileSave {
    if (typeof text !== 'string') throw new CoreError('invalid', 'Missing the text to save.');
    if (typeof baseHash !== 'string' || !HASH.test(baseHash)) throw new CoreError('invalid', 'A save names the version of the file it was made from.');
    const at = this.locate(where, rawPath);
    const before = statSync(at.real, { bigint: true });
    const bytes = this.bytes(at);
    const hash = sha256(bytes);
    if (hash !== baseHash) return { saved: false, current: this.textOf(at, bytes) };
    const guard = guardOf(at.root, at.rel) ?? (writable(at.real) ? null : { guard: 'unwritable' as const, reason: 'This file is read-only on disk.' });
    if (guard?.guard === 'unwritable') throw new CoreError('refused', `${guard.reason} Wanigan will not change its permissions to write it.`);
    if (guard && !anyway) throw new CoreError('refused', `${guard.reason} Choose Edit anyway to change it regardless.`);
    const was = decodeText(bytes);
    const next = encodeText(text, was);
    if (next.length > MAX_EDIT_BYTES) throw new CoreError('refused', `That is more than ${MAX_EDIT_BYTES / 1024 / 1024} MB, larger than the editor writes.`);

    // Next to the file, so the rename stays on one volume and replaces it in one step.
    const tmp = join(dirname(at.real), `.${basename(at.real)}.wanigan-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    const mode = Number(before.mode) & 0o7777;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      try {
        for (let off = 0; off < next.length;) off += writeSync(fd, next, off, next.length - off);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // The umask may have taken bits the file had (group write, say): it gets exactly its old mode.
      chmodSync(tmp, mode);
      // Something wrote the file while this was being written: theirs stays, and the owner sees it.
      const now = statSync(at.real, { bigint: true });
      if (now.mtimeNs !== before.mtimeNs || now.size !== before.size || now.ino !== before.ino) {
        unlinkSync(tmp);
        return { saved: false, current: this.textOf(at, this.bytes(at)) };
      }
      renameSync(tmp, at.real);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* already renamed or never made */ }
      throw error;
    }
    const after = statSync(at.real);
    const saved = { saved: true as const, hash: sha256(next), size: next.length, mtime: Math.round(after.mtimeMs) };
    this.hashes.set(at.real, { key: statKey(after), hash: saved.hash });

    this.board.log({ projectId: at.projectId, cardId: at.cardId, actor: OWNER, verb: 'edited', detail: `${at.rel}${guard ? ' (someone else’s code, edited anyway)' : ''}` });
    // The live view follows the owner's edits exactly as it follows an agent's.
    this.ctx.emit('live', { projectId: at.projectId, sessionId: null, cardId: at.cardId, paths: [join(at.root, at.rel)], kind: 'edit', at: this.ctx.now() });
    this.ctx.emit('files', { projectId: at.projectId, cardId: at.cardId, path: at.rel });
    this.ctx.emit('git', { projectId: at.projectId });
    return saved;
  }

  /** A file's state now: what the editor polls to notice another hand changing it. */
  stat(where: FileRoot, rawPath: unknown): FileStat {
    let at: Located;
    try {
      at = this.locate(where, rawPath);
    } catch (error) {
      if (error instanceof CoreError && error.code === 'not_found') return { hash: null, size: 0, mtime: 0 };
      throw error;
    }
    const s = statSync(at.real);
    const key = statKey(s);
    const known = this.hashes.get(at.real);
    if (known?.key === key) return { hash: known.hash, size: s.size, mtime: Math.round(s.mtimeMs) };
    const hash = sha256(this.bytes(at));
    this.remember(at.real, key, hash);
    return { hash, size: s.size, mtime: Math.round(s.mtimeMs) };
  }

  /**
   * Files for quick open. In a repository, what git tracks plus what it does
   * not ignore; elsewhere, a bounded walk. Installed code (vendor,
   * node_modules) is left out unless `installed`, which walks everything on
   * disk but git's own folder.
   */
  async list(where: FileRoot, installed: boolean): Promise<FileList> {
    const root = this.root(where);
    const cacheKey = `${root.path}\0${installed ? 1 : 0}`;
    const cached = this.lists.get(cacheKey);
    if (cached && this.ctx.now() - cached.at < LIST_TTL_MS) return cached.list;
    let list: FileList | null = null;
    if (!installed) {
      const tracked = await runGit(root.path, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
      if (tracked.ok) {
        const gone = await runGit(root.path, ['ls-files', '--deleted', '-z'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
        const deleted = new Set(gone.ok ? gone.out.split('\0') : []);
        const files = [...new Set(tracked.out.split('\0'))]
          .filter((f) => f && !deleted.has(f) && !f.split('/').some((p) => INSTALLED.has(p)) && cleanPath(f) !== null)
          .sort();
        list = { files: files.slice(0, MAX_LISTED), cut: files.length > MAX_LISTED || tracked.stdoutTruncated, source: 'git', installed: false };
      }
    }
    list ??= walk(root.path, installed);
    this.lists.set(cacheKey, { at: this.ctx.now(), list });
    if (this.lists.size > 20) this.lists.delete(this.lists.keys().next().value as string);
    return list;
  }

  /** One folder's entries, folders first, for the breadcrumbs. Nothing of git's own. */
  dir(where: FileRoot, rawPath: unknown): DirList {
    const root = this.root(where);
    const rel = cleanPath(rawPath, { allowRoot: true });
    if (rel === null) throw new CoreError('invalid', 'That is not a folder in this project.');
    const realRoot = realpathSync(root.path);
    let real: string;
    try { real = realpathSync(rel ? join(root.path, rel) : root.path); } catch { throw new CoreError('not_found', 'That folder is not there.'); }
    if (!within(realRoot, real)) throw new CoreError('refused', 'That folder leads outside the project through a link.');
    let entries: Dirent[];
    try { entries = readdirSync(real, { withFileTypes: true }); } catch { throw new CoreError('not_found', 'That folder cannot be read.'); }
    const out = entries
      .filter((e) => e.name !== '.git' && e.name !== '.DS_Store')
      .map((e) => ({ name: e.name, kind: kindOf(real, e) }))
      .filter((e): e is { name: string; kind: 'file' | 'dir' } => e.kind !== null)
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.kind === 'dir' ? -1 : 1));
    return { path: rel, entries: out.slice(0, MAX_DIR_ENTRIES), cut: out.length > MAX_DIR_ENTRIES };
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  /** The checkout a call names. */
  private root(where: FileRoot): { path: string; projectId: string; cardId: string | null } {
    if (!where || typeof where.projectId !== 'string' || !where.projectId) throw new CoreError('invalid', 'Which project?');
    const project = this.board.project(where.projectId);
    if (!where.cardId) return { path: project.path, projectId: project.id, cardId: null };
    if (typeof where.cardId !== 'string') throw new CoreError('invalid', 'Which card?');
    const card = this.board.card(where.cardId);
    if (card.projectId !== project.id) throw new CoreError('invalid', 'That card belongs to another project.');
    if (!card.worktree) throw new CoreError('refused', `${card.key} has no worktree of its own; its files are the project folder’s.`);
    return { path: card.worktree.path, projectId: project.id, cardId: card.id };
  }

  /** A file inside the root, by its real path: never through `..`, a link out, or git's own folder. */
  private locate(where: FileRoot, rawPath: unknown): Located {
    const root = this.root(where);
    const rel = cleanPath(rawPath);
    if (rel === null) throw new CoreError('invalid', 'That is not a file in this project.');
    let realRoot: string;
    try { realRoot = realpathSync(root.path); } catch { throw new CoreError('not_found', `The folder ${root.path} is gone.`); }
    let real: string;
    try { real = realpathSync(join(root.path, rel)); } catch { throw new CoreError('not_found', `${rel} is not there.`); }
    if (!within(realRoot, real)) throw new CoreError('refused', `${rel} leads outside the project through a link. Wanigan will not open it.`);
    if (relative(realRoot, real).split(sep).includes('.git')) throw new CoreError('refused', 'That is part of git’s own records, which Wanigan does not edit.');
    const s = statSync(real);
    if (!s.isFile()) throw new CoreError('refused', `${rel} is not a file.`);
    return { root: root.path, rel, real, projectId: root.projectId, cardId: root.cardId };
  }

  private bytes(at: Located): Buffer {
    try {
      return readBoundedFile(at.real, MAX_EDIT_BYTES, true);
    } catch (error) {
      const message = (error as Error).message;
      if (/too large/.test(message)) throw new CoreError('refused', `${at.rel} is larger than ${MAX_EDIT_BYTES / 1024 / 1024} MB, more than the editor opens.`);
      if (/changed while/.test(message)) throw new CoreError('conflict', `${at.rel} changed while it was being read. Try again.`);
      throw new CoreError('not_found', `${at.rel} could not be read.`);
    }
  }

  private textOf(at: Located, bytes: Buffer): FileText {
    const decoded = decodeText(bytes);
    const s = statSync(at.real);
    const hash = sha256(bytes);
    this.remember(at.real, statKey(s), hash);
    const guard = guardOf(at.root, at.rel) ?? (writable(at.real) ? null : { guard: 'unwritable' as const, reason: 'This file is read-only on disk.' });
    return {
      path: at.rel, root: at.root, hash, size: bytes.length, mtime: Math.round(s.mtimeMs), encoding: 'utf-8', ...decoded,
      readOnly: guard?.reason ?? null, guard: guard?.guard ?? null, lastEdit: this.lastEdit(at),
    };
  }

  /** The agent session whose hooks last reported writing this file. */
  private lastEdit(at: Located): FileEditor | null {
    const row = this.ctx.db.prepare(`SELECT e.session_id, e.at, s.title, s.provider FROM session_edits e JOIN sessions s ON s.id = e.session_id
      WHERE e.path IN (?, ?) ORDER BY e.at DESC, e.id DESC LIMIT 1`).get(join(at.root, at.rel), at.real) as { session_id: string; at: number; title: string; provider: Provider } | undefined;
    return row ? { sessionId: row.session_id, title: row.title, provider: row.provider, at: row.at } : null;
  }

  private remember(real: string, key: string, hash: string): void {
    this.hashes.set(real, { key, hash });
    if (this.hashes.size > 500) this.hashes.delete(this.hashes.keys().next().value as string);
  }
}

const statKey = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

/** A folder entry as a file or a folder; a link counts as what it points to, and a broken one is left out. */
function kindOf(dir: string, e: Dirent): 'file' | 'dir' | null {
  if (e.isDirectory()) return 'dir';
  if (e.isFile()) return 'file';
  if (!e.isSymbolicLink()) return null;
  try {
    const s = statSync(join(dir, e.name));
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
  } catch { return null; }
}

/** Every file under a folder but git's own, bounded in count and time; installed code only when asked. */
function walk(root: string, installed: boolean): FileList {
  const files: string[] = [];
  const started = Date.now();
  let cut = false;
  const queue: string[] = [''];
  while (queue.length) {
    if (files.length >= MAX_LISTED || Date.now() - started > WALK_MS) { cut = true; break; }
    const rel = queue.shift() as string;
    let entries: Dirent[];
    try { entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.DS_Store') continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      // Links are not followed: a link to a folder elsewhere would list someone else's files.
      if (e.isDirectory()) { if (installed || !INSTALLED.has(e.name)) queue.push(path); } else if (e.isFile()) files.push(path);
    }
  }
  files.sort();
  return { files: files.slice(0, MAX_LISTED), cut: cut || files.length > MAX_LISTED, source: 'walk', installed };
}
