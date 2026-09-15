import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as accounts from './accounts';
import { getSetting, setSetting } from './settings';
import { classifyRollout, isRolloutName, type CodexReaderHealth, type LineTally, type RolloutFormat } from '../shared/rollout-format';

/**
 * What the Codex rollout readers could not read, counted where they read it.
 *
 * Two kinds of evidence meet here. The readers themselves (codex-usage's token
 * snapshot, codex-sessions' identity and recovery reads) report every file they
 * opened: its format, and how many lines JSON.parse refused. And a cheap walk of
 * each account's `sessions/` tree reads the first eight bytes of every rollout,
 * so a compressed thread nobody has asked about yet is still counted — the
 * question "how many of my sessions can Wanigan not read" should not depend on
 * which ones a view happened to open.
 *
 * Nothing here decompresses anything. Reading a zstd rollout would mean a new
 * native dependency and a guess about a format Codex has not documented; the
 * honest state is to count them and say so.
 */

const HEAD_BYTES = 8;
const WALK_DEPTH = 4;
const WALK_TTL_MS = 60_000;
const VERSION_KEY = 'codex_reader_cli_version';

type ReadNote = { format: RolloutFormat['kind']; unparsed: number; at: number };
/** Keyed by absolute path; what the most recent read of that file found. */
const reads = new Map<string, ReadNote>();
/** Head classification keyed by path, reused while size and mtime are unchanged. */
const heads = new Map<string, { size: number; mtimeMs: number; format: RolloutFormat }>();
let walked: { at: number; files: Map<string, RolloutFormat> } | null = null;

/** Read and classify a file's first bytes. Never throws: an unreadable file is `binary`. */
export function rolloutFormatOf(file: string): RolloutFormat {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { kind: 'empty' }; }
  const cached = heads.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.format;
  let fd: number | null = null;
  let format: RolloutFormat;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
    const read = head.length ? fs.readSync(fd, head, 0, head.length, 0) : 0;
    format = classifyRollout(path.basename(file), head.subarray(0, read));
  } catch {
    format = { kind: 'binary' };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  heads.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, format });
  return format;
}

/** A reader opened a file it could not parse as JSONL at all. */
export function noteUnreadable(file: string, format: RolloutFormat): void {
  reads.set(file, { format: format.kind, unparsed: 0, at: Date.now() });
}

/** A reader parsed a file; record how many lines it refused. */
export function noteTally(file: string, tally: LineTally): void {
  reads.set(file, { format: 'jsonl', unparsed: tally.unparsed, at: Date.now() });
}

function walk(dir: string, depth: number, out: Map<string, RolloutFormat>): void {
  if (depth > WALK_DEPTH) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    // Never follow a link out of a sessions tree.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, depth + 1, out); continue; }
    if (entry.isFile() && isRolloutName(entry.name)) out.set(full, rolloutFormatOf(full));
  }
}

function homes(): { accountId: string | null; label: string; home: string }[] {
  const out: { accountId: string | null; label: string; home: string }[] = [];
  const seen = new Set<string>();
  let listed: ReturnType<typeof accounts.list> = [];
  try { listed = accounts.list('codex'); } catch { /* accounts table unavailable */ }
  for (const account of listed) {
    const home = path.resolve(account.configDir);
    if (seen.has(home)) continue;
    seen.add(home);
    out.push({ accountId: account.id, label: account.label, home });
  }
  const ambient = path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'));
  if (!seen.has(ambient)) out.push({ accountId: null, label: 'Default Codex home', home: ambient });
  return out;
}

function inside(home: string, file: string): boolean {
  const rel = path.relative(home, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Record which Codex CLI the readers are running against. Called with the
 * detected version whenever the health is read; a change keeps the previous
 * value so the surface can say the format may have moved with it.
 */
export function recordReaderCliVersion(version: string | null): { version: string | null; previous: string | null; at: number | null } {
  let stored: { version?: unknown; previous?: unknown; at?: unknown } = {};
  try { stored = JSON.parse(getSetting(VERSION_KEY, '{}')) as typeof stored; } catch { stored = {}; }
  const current = typeof stored.version === 'string' ? stored.version : null;
  const previous = typeof stored.previous === 'string' ? stored.previous : null;
  const at = typeof stored.at === 'number' ? stored.at : null;
  if (!version) return { version: current, previous, at };
  if (version === current) return { version, previous, at };
  const next = { version, previous: current, at: Date.now() };
  try { setSetting(VERSION_KEY, JSON.stringify(next)); } catch { /* evidence, never a dependency */ }
  return next;
}

/**
 * `onlyHomes` exists for the offline suite, which must never walk a real
 * `~/.codex`: given, it replaces the account list entirely.
 */
export function codexReaderHealth(cliVersion: string | null, force = false, onlyHomes?: string[]): CodexReaderHealth {
  const now = Date.now();
  const scope = onlyHomes
    ? onlyHomes.map((home) => ({ accountId: null, label: path.basename(home), home: path.resolve(home) }))
    : homes();
  let files: Map<string, RolloutFormat>;
  if (onlyHomes) {
    files = new Map();
    for (const { home } of scope) walk(path.join(home, 'sessions'), 0, files);
  } else {
    if (force || !walked || now - walked.at > WALK_TTL_MS) {
      const fresh = new Map<string, RolloutFormat>();
      for (const { home } of scope) walk(path.join(home, 'sessions'), 0, fresh);
      walked = { at: now, files: fresh };
    }
    files = walked.files;
  }
  // A file a reader opened outside the walk (a state-database path somewhere
  // else) still counts, under whichever home contains it.
  const all = new Map<string, RolloutFormat['kind'] | 'compressed'>();
  const codecs = new Map<string, string>();
  for (const [file, format] of files) {
    all.set(file, format.kind);
    if (format.kind === 'compressed') codecs.set(file, format.codec);
  }
  for (const [file, note] of reads) if (!all.has(file)) all.set(file, note.format);

  const version = recordReaderCliVersion(cliVersion);
  return {
    checkedAt: now,
    accounts: scope.map(({ accountId, label, home }) => {
      let rollouts = 0; let unreadable = 0; let unparsedLines = 0; let filesWithUnparsed = 0;
      const seenCodecs = new Set<string>();
      for (const [file, kind] of all) {
        if (!inside(home, file)) continue;
        rollouts += 1;
        if (kind === 'compressed' || kind === 'binary') {
          unreadable += 1;
          seenCodecs.add(codecs.get(file) ?? (kind === 'binary' ? 'not JSONL' : 'unknown'));
        }
        const note = reads.get(file);
        if (note && note.unparsed > 0) { unparsedLines += note.unparsed; filesWithUnparsed += 1; }
      }
      return { accountId, label, home, rollouts, unreadable, codecs: [...seenCodecs], unparsedLines, filesWithUnparsed };
    }),
    cliVersion: version.version,
    previousCliVersion: version.previous,
    versionRecordedAt: version.at,
  };
}

/** For the offline suite. */
export function resetCodexReaderHealth(): void {
  reads.clear();
  heads.clear();
  walked = null;
}
