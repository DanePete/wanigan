// Files the owner opens in Wanigan's code editor: what the core sends and
// takes. Every path is relative to a root (the project folder, or a card's
// own worktree) and written with `/`. The core decides what may be read or
// written (src/core/files.ts); these are its shapes and the pure rules the
// window shares with it.
import type { Provider } from './model.ts';

/** A file larger than this is not opened: it is a dump, a build or a log, not code someone edits by hand. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
/** The most files quick open is given at once; more are counted as left out. */
export const MAX_LISTED = 40_000;
/** The most entries one folder lists for the breadcrumbs. */
export const MAX_DIR_ENTRIES = 1_000;

/** Which checkout a file is in: the project folder, or a card's own worktree. */
export interface FileRoot {
  projectId: string;
  cardId?: string | null;
}

/**
 * Why a file opens read-only. Someone else's code (`drupal-core` … `wordpress-plugin`)
 * can be edited anyway, on the owner's say-so; `unwritable` cannot.
 */
export type FileGuard = 'drupal-core' | 'contrib' | 'vendor' | 'node_modules' | 'wordpress-core' | 'wordpress-plugin' | 'unwritable';

/** The agent session that last wrote a file, as its own hooks reported it. */
export interface FileEditor {
  sessionId: string;
  title: string;
  provider: Provider;
  at: number;
}

/** A text file as the editor gets it. */
export interface FileText {
  /** Relative to the root, with `/`. */
  path: string;
  /** The root it is in, as an absolute path (for showing, and for matching an agent's edit). */
  root: string;
  /** The text, with every line ending as `\n` and no byte order mark: the core puts back what the file had. */
  text: string;
  /** sha256 of the bytes on disk: what a save must name to show it is not overwriting someone else's change. */
  hash: string;
  size: number;
  mtime: number;
  /** The file's line endings, written back on save; `mixed` files are saved with the commoner one. */
  eol: 'lf' | 'crlf';
  mixedEol: boolean;
  bom: boolean;
  finalNewline: boolean;
  encoding: 'utf-8';
  /** Why it opens read-only, in a sentence; null when it is the owner's to change. */
  readOnly: string | null;
  guard: FileGuard | null;
  /** The agent session that last wrote it, if any did. */
  lastEdit: FileEditor | null;
}

/** What a save did: written, or refused because the file changed since it was read (with what it is now). */
export type FileSave =
  | { saved: true; hash: string; size: number; mtime: number }
  | { saved: false; current: FileText };

/** A file's state on disk, for noticing that something else changed it. `hash` is null when it is gone. */
export interface FileStat {
  hash: string | null;
  size: number;
  mtime: number;
}

/** Files for quick open, relative to the root. */
export interface FileList {
  files: string[];
  /** More were there than `MAX_LISTED`, or the walk ran out of time. */
  cut: boolean;
  /** Whether git's ignore rules chose them (a repository), or a walk of the folder did. */
  source: 'git' | 'walk';
  /** Folders of installed code (vendor, node_modules) were included. */
  installed: boolean;
}

/** One entry of a folder, for the breadcrumbs' menus. */
export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export interface DirList {
  /** The folder, relative to the root ('' is the root). */
  path: string;
  entries: DirEntry[];
  cut: boolean;
}

/**
 * A path as the owner or a caller wrote it, made safe to join to a root: `/`
 * separated, relative, with no `.`, `..` or empty segment and nothing of
 * git's own. Null when it is not one. The core resolves links separately.
 */
export function cleanPath(raw: unknown, { allowRoot = false } = {}): string | null {
  if (typeof raw !== 'string' || raw.length > 4096 || raw.includes('\0')) return null;
  const trimmed = raw.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return allowRoot ? '' : null;
  if (trimmed.startsWith('/')) return null;
  const parts = trimmed.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p === '.git')) return null;
  return parts.join('/');
}

/** Line endings of some text: the commoner one, and whether both appear. */
export function lineEndings(text: string): { eol: 'lf' | 'crlf'; mixed: boolean } {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++; else lf++;
  }
  return { eol: crlf > lf ? 'crlf' : 'lf', mixed: crlf > 0 && lf > 0 };
}

/** Text with every line ending as `\n` (a lone `\r` too, as old Mac files end lines). */
export const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');

/** Indentation a file already uses, so new lines match it: a tab, or a number of spaces. */
export function detectIndent(text: string): { unit: string; tabSize: number } {
  const counts = new Map<number, number>();
  let tabs = 0;
  let spaced = 0;
  let previous = 0;
  let lines = 0;
  for (const line of text.split('\n')) {
    if (++lines > 5_000) break;
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (lead.startsWith('\t')) { tabs++; previous = 0; continue; }
    const n = lead.length;
    // A line inside a block comment (` * text`) is one space off its neighbours: not indentation.
    if (/^ +\*/.test(line)) continue;
    if (n > 0) spaced++;
    const step = Math.abs(n - previous);
    if (step >= 2 && step <= 8) counts.set(step, (counts.get(step) ?? 0) + 1);
    previous = n;
  }
  if (tabs > spaced) return { unit: '\t', tabSize: 4 };
  let best = 0;
  let size = 0;
  for (const [step, count] of counts) if (count > best || (count === best && step < size)) { best = count; size = step; }
  const width = size === 2 || size === 4 || size === 8 || size === 3 ? size : 2;
  return { unit: ' '.repeat(spaced ? width : 2), tabSize: spaced ? width : 2 };
}
