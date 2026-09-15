import fs from 'node:fs';
import { db } from './db';
import { runGit, runGitBuffer } from './git';
import { listCheckpoints } from './checkpoints';
import { driftFor, languageOf, parseHunks, type DriftFile, type MaintainabilityView } from '../shared/maintainability';

/**
 * Maintainability drift for one session: the files changed between the commit
 * its checkpoints started from and its latest checkpoint, read out of git's
 * object store (never the working tree, which may have moved on), and handed to
 * the heuristics in shared/maintainability.ts.
 *
 * Checkpoints are real commits under refs/wanigan/checkpoints/, so both sides
 * are exact snapshots. A session with no checkpoints has nothing to compare
 * and says so; nothing is estimated in their place.
 */

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const cache = new Map<string, MaintainabilityView>();

function sessionIdArg(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Choose a session to review.');
  return value;
}

async function rootFor(sessionId: string, repoRoot: string): Promise<string | null> {
  if (fs.existsSync(repoRoot)) return repoRoot;
  const row = db().prepare('SELECT project_path FROM session_log WHERE id = ?').get(sessionId) as { project_path?: string } | undefined;
  const projectPath = row?.project_path;
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  const top = await runGit(projectPath, ['rev-parse', '--show-toplevel'], { timeout: 8_000 });
  return top.ok && top.out.trim() ? top.out.trim() : null;
}

async function blob(root: string, commit: string, rel: string): Promise<{ text: string | null; skip: string | null }> {
  const size = await runGit(root, ['cat-file', '-s', `${commit}:${rel}`], { timeout: 8_000 });
  if (!size.ok) return { text: null, skip: 'not readable at that commit' };
  if (Number(size.out.trim()) > MAX_FILE_BYTES) return { text: null, skip: 'larger than 512 KB' };
  const read = await runGitBuffer(root, ['cat-file', 'blob', `${commit}:${rel}`], { timeout: 8_000 });
  if (!read.ok) return { text: null, skip: 'not readable at that commit' };
  if (read.out.includes(0)) return { text: null, skip: 'binary' };
  return { text: read.out.toString('utf8'), skip: null };
}

/** `diff --git` sections of a -U0 patch, keyed by the new path (the old one for a deletion). */
function sectionsByPath(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m);
  for (const part of parts) {
    const plus = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/m.exec(part);
    const minus = /^--- (?:a\/(.+)|\/dev\/null)$/m.exec(part);
    const rel = plus?.[1] ?? minus?.[1];
    if (rel) out.set(rel.replace(/\t$/, ''), part);
  }
  return out;
}

export async function maintainabilityFor(sessionIdIn: unknown, opts: { exclude?: (rel: string) => boolean } = {}): Promise<MaintainabilityView> {
  const sessionId = sessionIdArg(sessionIdIn);
  const empty = (state: MaintainabilityView['state'], detail: string, extra: Partial<MaintainabilityView> = {}): MaintainabilityView =>
    ({ state, detail, base: null, latest: null, latestTurn: null, latestAt: null, changedFiles: 0, report: null, ...extra });
  const rows = listCheckpoints(sessionId).filter((c) => c.commitHash && SHA.test(c.commitHash) && c.status !== 'failed');
  const start = rows.find((c) => c.kind === 'session-start') ?? rows[0];
  const latest = rows[rows.length - 1];
  if (!start || !latest) return empty('no-checkpoints', 'This session has no checkpoints, so there is no base and no latest snapshot to compare.');
  const extra = { base: start.commitHash, latest: latest.commitHash, latestTurn: latest.turn, latestAt: latest.at };
  if (start.commitHash === latest.commitHash) return empty('unchanged', 'The latest checkpoint is the same snapshot the session started from.', extra);
  const root = await rootFor(sessionId, latest.repoRoot);
  if (!root) return empty('unreadable', 'The repository these checkpoints were captured in is no longer on disk.', extra);

  const key = `${root}|${start.commitHash}|${latest.commitHash}`;
  const hit = cache.get(key);
  if (hit && !opts.exclude) return hit;

  const names = await runGit(root, ['diff', '--name-status', '--no-renames', '-z', start.commitHash!, latest.commitHash!, '--'], { timeout: 20_000 });
  if (!names.ok) return empty('unreadable', `git could not compare the two snapshots: ${names.err.slice(0, 200)}`, extra);
  const tokens = names.out.split('\0').filter(Boolean);
  const changed: { status: string; rel: string }[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) changed.push({ status: tokens[i], rel: tokens[i + 1] });
  const skipped: { path: string; reason: string }[] = [];
  const considered = changed.filter((c) => {
    if (opts.exclude?.(c.rel)) { skipped.push({ path: c.rel, reason: 'scratch file' }); return false; }
    if (!languageOf(c.rel)) { skipped.push({ path: c.rel, reason: 'no heuristic for this language' }); return false; }
    return true;
  });
  if (considered.length > MAX_FILES) {
    for (const c of considered.splice(MAX_FILES)) skipped.push({ path: c.rel, reason: `past the first ${MAX_FILES} files` });
  }
  const patch = considered.length
    ? await runGit(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', start.commitHash!, latest.commitHash!, '--', ...considered.map((c) => `:(literal)${c.rel}`)], { timeout: 30_000 })
    : { ok: true, out: '', err: '' };
  const sections = sectionsByPath(patch.ok ? patch.out : '');
  const files: DriftFile[] = [];
  for (const c of considered) {
    const before = c.status.startsWith('A') ? { text: null, skip: null } : await blob(root, start.commitHash!, c.rel);
    const after = c.status.startsWith('D') ? { text: null, skip: null } : await blob(root, latest.commitHash!, c.rel);
    const skip = before.skip ?? after.skip;
    if (skip) { skipped.push({ path: c.rel, reason: skip }); continue; }
    const section = sections.get(c.rel);
    if (!section) { skipped.push({ path: c.rel, reason: 'its diff could not be read' }); continue; }
    files.push({ path: c.rel, before: before.text, after: after.text, hunks: parseHunks(section) });
  }
  // driftFor re-checks the language and adds nothing new to `skipped` here.
  const view: MaintainabilityView = { state: 'ready', detail: null, ...extra, changedFiles: changed.length, report: driftFor(files, skipped) };
  if (!opts.exclude) {
    if (cache.size > 50) cache.clear();
    cache.set(key, view);
  }
  return view;
}
