// Inspect and resolve Git's conflict stages without overwriting unseen edits.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { conflictCount, parseConflicts, resolveConflicts, type ConflictCode } from '../shared/conflict.ts';
import { gitSaid, parseStatus, type ConflictFile } from '../shared/git.ts';
import { CoreError } from '../shared/protocol.ts';
import { gitEnvironment, readUntracked, runGit, type GitRun } from './git.ts';
import { filePath, literal, must, refused } from './git-commands.ts';

/* ── conflicts ───────────────────────────────────────────────────────────── */

/** Past this a conflicted file is not merged here: take a side, or resolve it in an editor. */
const MAX_CONFLICT_BYTES = 1_000_000;

/** git's versions of a conflicted file: 1 what both came from, 2 ours, 3 theirs, by blob. */
async function stagesOf(cwd: string, file: string): Promise<Partial<Record<1 | 2 | 3, string>>> {
  const out = await must(cwd, ['ls-files', '-u', '-z', '--', literal(file)], 'the conflict');
  const stages: Partial<Record<1 | 2 | 3, string>> = {};
  for (const entry of out.split('\0').filter(Boolean)) {
    const m = entry.match(/^\d+ ([0-9a-f]+) ([123])\t/);
    if (m) stages[Number(m[2]) as 1 | 2 | 3] = m[1] as string;
  }
  return stages;
}

/** A version of both the index's conflict and the working file, without following links or reading an unbounded file. */
async function conflictDigest(cwd: string, file: string, stages: Partial<Record<1 | 2 | 3, string>>): Promise<string> {
  const st = await lstat(join(cwd, file), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // ctime cannot be restored by an editor that preserves the old mtime. atime
  // is excluded: merely reading a file must not make its resolution stale.
  const version = st ? [st.dev, st.ino, st.mode, st.size, st.mtimeNs, st.ctimeNs].map(String) : null;
  return createHash('sha256').update(JSON.stringify({ stages, version })).digest('hex');
}

async function blob(cwd: string, sha: string): Promise<Buffer> {
  const env = await gitEnvironment();
  return new Promise((ok, fail) => execFile('git', ['cat-file', 'blob', sha], { cwd, env, encoding: 'buffer', maxBuffer: MAX_CONFLICT_BYTES * 4 },
    (error, stdout) => (error ? fail(error) : ok(stdout as Buffer))));
}

/** A conflicted file as the resolver reads it: which versions git has, and the three merged with diff3 markers. */
export async function conflictFile(cwd: string, file: string, labels: { ours: string; theirs: string }): Promise<ConflictFile> {
  filePath(cwd, file);
  const listed = parseStatus((await runGit(cwd, ['status', '--porcelain=v2', '-z', '--', literal(file)])).out).conflicted.find((c) => c.path === file);
  if (!listed) throw new CoreError('not_found', `${file} is not conflicted.`);
  const stages = await stagesOf(cwd, file);
  const out: ConflictFile = {
    path: file, digest: await conflictDigest(cwd, file, stages), code: listed.code as ConflictCode, stages: { base: !!stages[1], ours: !!stages[2], theirs: !!stages[3] },
    oursLabel: labels.ours, theirsLabel: labels.theirs, binary: false, tooLarge: false, merged: null, inFile: null, edited: false,
  };
  const texts: Partial<Record<1 | 2 | 3, Buffer>> = {};
  for (const n of [1, 2, 3] as const) {
    const sha = stages[n];
    if (!sha) continue;
    const size = Number((await runGit(cwd, ['cat-file', '-s', sha])).out.trim());
    if (size > MAX_CONFLICT_BYTES) { out.tooLarge = true; continue; }
    const bytes = await blob(cwd, sha);
    if (bytes.subarray(0, 8000).includes(0)) out.binary = true;
    texts[n] = bytes;
  }
  const working = await readUntracked(join(cwd, file)).catch(() => null);
  if (working && 'text' in working) out.inFile = conflictCount(working.text);
  if (out.binary || out.tooLarge || !texts[2] || !texts[3]) return out;
  // git merge-file on copies, so the working file (and any edit made to it) is never touched.
  const dir = await mkdtemp(join(tmpdir(), 'wanigan-merge-'));
  try {
    const paths = { ours: join(dir, 'ours'), base: join(dir, 'base'), theirs: join(dir, 'theirs') };
    await Promise.all([writeFile(paths.ours, texts[2]), writeFile(paths.base, texts[1] ?? ''), writeFile(paths.theirs, texts[3])]);
    const merge = (style: string): Promise<GitRun> =>
      runGit(cwd, ['merge-file', '-p', style, '-L', labels.ours, '-L', 'base', '-L', labels.theirs, paths.ours, paths.base, paths.theirs]);
    // zdiff3 (git 2.35) keeps lines both sides share out of the conflict; diff3 before it.
    let r = await merge('--zdiff3');
    if (r.code === 129) r = await merge('--diff3');
    // Its exit status is how many conflicts it left (or above 127, a failure).
    if (r.code === null || r.code > 127) refused(`Git could not merge the three versions of ${file}: ${gitSaid(r.err)}`);
    out.merged = r.out;
    // Edited after git marked it: whatever style git wrote the markers in, and however it grouped
    // the conflicts, taking every conflict's ours (then theirs) gives git's own merge favouring that side.
    if (working && 'text' in working) {
      const [ours, theirs] = await Promise.all([merge('--ours'), merge('--theirs')]);
      const marked = parseConflicts(working.text);
      const every = (side: 'ours' | 'theirs'): string => resolveConflicts(marked, new Map(marked.hunks.map((h) => [h.index, side]))).text;
      out.edited = !ours.ok || !theirs.ok || every('ours') !== ours.out || every('theirs') !== theirs.out;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return out;
}

/**
 * How many conflicts the resolver will show in a file: those of git's three
 * versions merged as it merges them, or, once the file was edited, those still
 * in it. Null for a file with no text to count.
 */
export async function conflictHunks(cwd: string, file: string): Promise<number | null> {
  const c = await conflictFile(cwd, file, { ours: 'ours', theirs: 'theirs' }).catch(() => null);
  if (!c) return null;
  return c.merged !== null && !c.edited ? conflictCount(c.merged) : c.inFile;
}

export type Resolution ={ side: 'ours' | 'theirs' } | { content: string; keepMarkers: boolean } | { asIs: true; keepMarkers: boolean } | { remove: true };

/**
 * Resolve one conflicted file and stage it: one side whole, text the owner
 * wrote (refused while it still holds markers, unless they said to keep them),
 * or the file removed. A side git has no version of means the file goes.
 */
export async function resolveConflict(cwd: string, file: string, how: Resolution, digest?: string): Promise<{ left: number }> {
  filePath(cwd, file);
  const conflicted = parseStatus((await runGit(cwd, ['status', '--porcelain=v2', '-z'])).out).conflicted;
  if (!conflicted.some((c) => c.path === file)) throw new CoreError('conflict', `${file} is not conflicted any more. Look again.`);
  if (!('asIs' in how)) {
    const stages = await stagesOf(cwd, file);
    if (typeof digest !== 'string' || digest !== await conflictDigest(cwd, file, stages)) {
      throw new CoreError('conflict', `${file} changed since its conflict was shown, so nothing was overwritten. Look again before resolving it.`);
    }
  }
  const spec = literal(file);
  const markersLeft = (left: number, keep: boolean): void => {
    if (left && !keep) refused(`${file} still has ${left} conflict${left === 1 ? '' : 's'} with ${left === 1 ? 'its' : 'their'} markers in. Resolve ${left === 1 ? 'it' : 'them'}, or say you mean to keep the markers.`);
  };
  if ('remove' in how) {
    await must(cwd, ['rm', '-q', '--', spec], `removing ${file}`);
  } else if ('asIs' in how) {
    // Resolved by hand, in an editor: the file as it is now (gone, if it was deleted).
    const existing = await lstat(join(cwd, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!existing) await must(cwd, ['rm', '-q', '--', spec], `removing ${file}`);
    else {
      const read = await readUntracked(join(cwd, file)).catch(() => null);
      if ((!read || ('note' in read && !read.binary && !existing.isSymbolicLink())) && !how.keepMarkers) {
        refused(`Wanigan could not check ${file} for conflict markers. Resolve it in an editor and explicitly allow keeping markers, or take a side.`);
      }
      markersLeft(read && 'text' in read ? conflictCount(read.text) : 0, how.keepMarkers);
      await must(cwd, ['add', '--', spec], `staging ${file}`);
    }
  } else if ('side' in how) {
    const stages = await stagesOf(cwd, file);
    const has = how.side === 'ours' ? stages[2] : stages[3];
    if (!has) await must(cwd, ['rm', '-q', '--', spec], `removing ${file}`);
    else {
      await must(cwd, ['checkout', how.side === 'ours' ? '--ours' : '--theirs', '--', spec], `taking ${how.side === 'ours' ? 'our' : 'their'} side of ${file}`);
      await must(cwd, ['add', '--', spec], `staging ${file}`);
    }
  } else {
    if (typeof how.content !== 'string' || how.content.length > 5 * MAX_CONFLICT_BYTES) throw new CoreError('invalid', 'That is too much text for one file.');
    markersLeft(conflictCount(how.content), how.keepMarkers);
    const full = resolve(cwd, file);
    const parent = await realpath(dirname(full)).catch(() => null);
    const root = await realpath(cwd);
    if (!parent || (parent !== root && !parent.startsWith(`${root}/`))) throw new CoreError('forbidden', 'That path is outside the project.');
    const existing = await lstat(full).catch(() => null);
    if (existing?.isSymbolicLink()) refused(`${file} is a symbolic link; take a side instead.`);
    await writeFile(full, how.content);
    await must(cwd, ['add', '--', spec], `staging ${file}`);
  }
  const now = parseStatus((await runGit(cwd, ['status', '--porcelain=v2', '-z'])).out).conflicted.length;
  return { left: now };
}
