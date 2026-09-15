/**
 * What a session edited, read and referenced, rolled up per file.
 *
 * The hook timeline already records each Read, Write and Edit as its own row,
 * which answers "what happened at 14:02" and not "did it even look at the test
 * before it changed the handler". This groups the same record by file
 * (f-desktop-apps.md §6, after Nimbalyst's Edited / Referenced / Read panel):
 *
 *   · Edited — Write, Edit, MultiEdit and NotebookEdit calls that completed.
 *   · Read — Read calls, and `cat`, `head` and `sed -n` in a Bash command when
 *     the command is simple enough to say for certain which file it read.
 *   · Referenced — files a Grep or Glob returned, and paths named in a prompt.
 *
 * A file sits in the strongest group it earned (edited, then read, then
 * referenced), and carries every count, so a file that was read three times and
 * then edited shows under Edited with "3 reads" beside it.
 *
 * The Bash reader is deliberately narrow. A glob, a variable, a command after a
 * `cd`, `sed` without `-n` or with `-i`: each is skipped rather than guessed, so
 * "read by Bash" is only ever said about a file the command certainly read.
 */

import { parseShell, programOf, type ShellSegment } from './shell-parse.ts';
import { dirname, isAbsolute, normalize, resolve } from './posix-path.ts';

export type FileRefKind = 'grep-hit' | 'glob-hit' | 'prompt-path' | 'bash-read';
export type SessionFileGroup = 'edited' | 'read' | 'referenced';

export const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
const EDIT_SET = new Set<string>(EDIT_TOOLS);

/** How many hits one Grep or Glob result may contribute. The CLI caps Glob at 100. */
export const MAX_HITS = 200;

const GLOBBY = /[*?[\]{}]/;

function staticWords(seg: ShellSegment): string[] | null {
  const out: string[] = [];
  for (const w of seg.argv.slice(1)) {
    if (w.dynamic) return null;
    out.push(w.text);
  }
  return out;
}

/** File operands of `head`, after its flags. Null when a flag is one this reader does not know. */
function headFiles(args: string[]): string[] | null {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { files.push(...args.slice(i + 1)); break; }
    if (a === '-n' || a === '-c') { i++; continue; }
    if (/^-(?:n|c)?\d+$/.test(a) || /^--(?:lines|bytes)=\d+$/.test(a) || a === '-q' || a === '-v') continue;
    if (a.startsWith('-')) return null;
    files.push(a);
  }
  return files;
}

/** File operands of `sed -n '<range>p'`. Null for any other sed. */
function sedFiles(args: string[]): string[] | null {
  let quiet = false;
  let script: string | null = null;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' || a === '--quiet' || a === '--silent') { quiet = true; continue; }
    if (a === '-e') { if (script !== null) return null; script = args[++i] ?? null; continue; }
    if (a.startsWith('-')) return null; // -i edits in place; anything else is not a plain print
    if (script === null) { script = a; continue; }
    files.push(a);
  }
  if (!quiet || script === null) return null;
  return /^\s*(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?\s*p\s*$/.test(script) ? files : null;
}

/**
 * Files a Bash command line certainly read with cat, head or sed -n. Relative
 * paths resolve against `cwd`; after any `cd` on the line a relative path is
 * no longer certain and is skipped.
 */
export function bashReads(command: string, cwd: string | null): string[] {
  if (typeof command !== 'string' || !command.trim()) return [];
  const parsed = parseShell(command);
  const out: string[] = [];
  let moved = false;
  for (const seg of parsed.segments) {
    const program = programOf(seg);
    if (program === 'cd' || program === 'pushd' || program === 'popd') { moved = true; continue; }
    if (program !== 'cat' && program !== 'head' && program !== 'sed') continue;
    const args = staticWords(seg);
    if (!args) continue;
    const files = program === 'cat'
      ? (args.some((a) => a.startsWith('-') && a !== '-') ? null : args)
      : program === 'head' ? headFiles(args) : sedFiles(args);
    if (!files) continue;
    for (const f of files) {
      if (!f || f === '-' || GLOBBY.test(f) || f.includes('$') || f.startsWith('~')) continue;
      if (isAbsolute(f)) { out.push(normalize(f)); continue; }
      if (moved || !cwd) continue;
      out.push(resolve(cwd, f));
    }
  }
  return [...new Set(out)];
}

/**
 * The paths a Grep or Glob result named, from the output schema carried in the
 * Claude Code 2.1.271 binary: both tools return `filenames: string[]`. Grep in
 * `content` mode returns matching lines instead, which are file contents and
 * are not read here, so a content-mode search contributes no hits. Relative
 * names resolve against the directory the search ran in.
 */
export function toolHits(toolName: string | null, toolInput: unknown, response: unknown, cwd: string | null): string[] {
  if (toolName !== 'Grep' && toolName !== 'Glob') return [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) return [];
  const names = (response as Record<string, unknown>).filenames;
  if (!Array.isArray(names)) return [];
  const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {};
  const searched = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : null;
  const base = searched ? (isAbsolute(searched) ? searched : cwd ? resolve(cwd, searched) : null) : cwd;
  const out: string[] = [];
  for (const n of names) {
    if (typeof n !== 'string' || !n || n.length > 1000) continue;
    if (isAbsolute(n)) out.push(normalize(n));
    else if (base) out.push(resolve(base, n));
    if (out.length >= MAX_HITS) break;
  }
  return [...new Set(out)];
}

/* ── the roll-up ─────────────────────────────────────────────────────── */

export type FileEventInput = { at: number; event: string; toolName: string | null; ok: boolean | null; paths: string[] };
export type FileRefInput = { at: number; kind: FileRefKind; path: string };

export type SessionFileEntry = {
  path: string;
  /** Relative to the session's root when inside it; null when the file is outside. */
  rel: string | null;
  group: SessionFileGroup;
  edits: number;
  reads: number;
  bashReads: number;
  searchHits: number;
  promptMentions: number;
  firstAt: number;
  lastAt: number;
};

export type SessionFiles = Record<SessionFileGroup, SessionFileEntry[]>;

function relativeTo(root: string | null, abs: string): string | null {
  if (!root) return null;
  const r = normalize(root).replace(/\/+$/, '');
  const p = normalize(abs);
  if (p === r) return null;
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

export function rollupSessionFiles(events: readonly FileEventInput[], refs: readonly FileRefInput[], root: string | null): SessionFiles {
  const byPath = new Map<string, SessionFileEntry>();
  const entry = (raw: string, at: number): SessionFileEntry => {
    const path = isAbsolute(raw) ? normalize(raw) : root ? resolve(root, raw) : raw;
    let e = byPath.get(path);
    if (!e) {
      e = { path, rel: relativeTo(root, path), group: 'referenced', edits: 0, reads: 0, bashReads: 0, searchHits: 0, promptMentions: 0, firstAt: at, lastAt: at };
      byPath.set(path, e);
    }
    e.firstAt = Math.min(e.firstAt, at);
    e.lastAt = Math.max(e.lastAt, at);
    return e;
  };
  for (const ev of events) {
    if (ev.event !== 'PostToolUse' || ev.ok === false || !ev.toolName) continue;
    if (EDIT_SET.has(ev.toolName)) for (const p of ev.paths) entry(p, ev.at).edits++;
    else if (ev.toolName === 'Read') for (const p of ev.paths) entry(p, ev.at).reads++;
  }
  for (const r of refs) {
    const e = entry(r.path, r.at);
    if (r.kind === 'bash-read') e.bashReads++;
    else if (r.kind === 'prompt-path') e.promptMentions++;
    else e.searchHits++;
  }
  const out: SessionFiles = { edited: [], read: [], referenced: [] };
  for (const e of byPath.values()) {
    e.group = e.edits > 0 ? 'edited' : e.reads + e.bashReads > 0 ? 'read' : 'referenced';
    out[e.group].push(e);
  }
  for (const g of Object.keys(out) as SessionFileGroup[]) out[g].sort((a, b) => b.lastAt - a.lastAt || (a.path < b.path ? -1 : 1));
  return out;
}

/** The directory a path's file sits in, for opening the code rail's file browser beside it. */
export function directoryOf(rel: string): string {
  const d = dirname(rel);
  return d === '.' ? '' : d;
}
