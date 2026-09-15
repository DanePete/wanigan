import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runGit, type GitRun } from './git';
import { listWorktrees, repoRootFor } from './worktrees';
import { projectById } from './store';
import { assertManagedRoot } from './roots';
import {
  classifyPair, gitVersionSupportsMergeTree, MAX_FORECAST_WORKTREES, nulList, orderPairs, parseMergeTree, peerPairs,
  type CollisionForecast, type CollisionPair, type CollisionSide, type CollisionWorktree,
} from '../shared/collisions';

/**
 * Would the agents' work combine? Asked of git while it is still in flight.
 *
 * Each linked worktree's current state — uncommitted and untracked files
 * included, because that is where an agent's work usually sits — is read into
 * a scratch index and written as a tree, then `git merge-tree --write-tree`
 * performs the merge against the worktree's base and against every other
 * worktree, entirely in the object database. No working tree, index, branch or
 * ref is touched: the scratch index lives in the temp directory and is deleted,
 * and the snapshot commits are unreferenced objects git collects on its own.
 *
 * git is run with its filesystem monitor off. An agent can write repository
 * config, and `core.fsmonitor` is a command git runs; a question asked on the
 * operator's behalf must not be the thing that executes it.
 */

const SAFE = ['-c', 'core.fsmonitor=false'];
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'Wanigan', GIT_AUTHOR_EMAIL: 'wanigan@localhost',
  GIT_COMMITTER_NAME: 'Wanigan', GIT_COMMITTER_EMAIL: 'wanigan@localhost',
};
const POOL = 4;

function lastLine(r: GitRun): string {
  const lines = (r.err || r.out).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? (r.killed ? 'git timed out' : 'no output');
}

async function pool<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, lane));
  return out;
}

type Snapshot = { ok: true; commit: string } | { ok: false; detail: string };

/** The worktree as it is on disk right now, as a commit whose parent is its HEAD. */
async function snapshot(worktree: string): Promise<Snapshot> {
  if (!fs.existsSync(worktree)) return { ok: false, detail: 'The worktree directory is gone.' };
  const head = await runGit(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], { timeout: 8_000 });
  const headSha = head.out.trim();
  if (!head.ok || !headSha) return { ok: false, detail: 'The worktree has no commit to compare from.' };

  const scratch = path.join(os.tmpdir(), `wanigan-forecast-${randomBytes(6).toString('hex')}.index`);
  try {
    // Seeding from the real index keeps its stat cache, so only files that
    // changed are hashed. A copy, never the file itself: the agent's index is
    // not Wanigan's to write.
    const real = await runGit(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { timeout: 8_000 });
    try { if (real.ok) fs.copyFileSync(real.out.trim(), scratch); } catch { /* no index yet: add builds one */ }
    const env = { GIT_INDEX_FILE: scratch };
    const add = await runGit(worktree, [...SAFE, 'add', '-A', '.'], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env });
    if (!add.ok) return { ok: false, detail: `git could not read its files: ${lastLine(add)}` };
    const wt = await runGit(worktree, ['write-tree'], { timeout: 60_000, env });
    const tree = wt.out.trim();
    if (!wt.ok || !tree) return { ok: false, detail: `git could not write its tree: ${lastLine(wt)}` };
    const headTree = (await runGit(worktree, ['rev-parse', 'HEAD^{tree}'], { timeout: 8_000 })).out.trim();
    if (tree === headTree) return { ok: true, commit: headSha };
    const ct = await runGit(worktree, ['commit-tree', tree, '-p', headSha, '-m', 'wanigan collision forecast snapshot'],
      { timeout: 20_000, env: AUTHOR_ENV });
    const commit = ct.out.trim();
    return ct.ok && commit ? { ok: true, commit } : { ok: false, detail: `git could not record a snapshot: ${lastLine(ct)}` };
  } finally {
    try { fs.rmSync(scratch, { force: true }); } catch { /* temp file */ }
  }
}

/** Paths `to` changed since `from`, or null when git could not say. */
async function changedSince(repoRoot: string, from: string, to: string): Promise<string[] | null> {
  const r = await runGit(repoRoot, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', from, to], { timeout: 30_000 });
  return r.ok ? nulList(r.out) : null;
}

async function mergeBase(repoRoot: string, a: string, b: string): Promise<string | null> {
  const r = await runGit(repoRoot, ['merge-base', a, b], { timeout: 20_000 });
  const sha = r.out.trim();
  return r.ok && sha ? sha : null;
}

async function pairOf(repoRoot: string, kind: CollisionPair['kind'], a: CollisionSide, aRev: string, b: CollisionSide, bRev: string): Promise<CollisionPair> {
  const mt = await runGit(repoRoot, [...SAFE, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', aRev, bRev],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const merge = parseMergeTree(mt.out, mt.code);
  if (merge.outcome === 'unreadable') {
    return { kind, a, b, outcome: 'unreadable', conflicted: [], shared: [], detail: lastLine(mt) };
  }
  const base = await mergeBase(repoRoot, aRev, bRev);
  const [changedA, changedB] = base
    ? await Promise.all([changedSince(repoRoot, base, aRev), changedSince(repoRoot, base, bRev)])
    : [null, null];
  return { kind, a, b, ...classifyPair(merge, changedA, changedB), detail: null };
}

export async function forecastCollisions(projectId: string): Promise<CollisionForecast> {
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('That project is not registered with Wanigan.');
  const dir = assertManagedRoot(project.path, 'That project folder');
  const at = Date.now();
  const empty = (unsupported: string | null, repoRoot: string | null): CollisionForecast =>
    ({ projectId: project.id, repoRoot, at, unsupported, worktrees: [], pairs: [], omitted: 0 });

  const repoRoot = await repoRootFor(dir);
  if (!repoRoot) return empty(`${project.name} is not a git repository, so there is nothing to forecast.`, null);
  const version = (await runGit(repoRoot, ['--version'], { timeout: 8_000 })).out.trim();
  if (!gitVersionSupportsMergeTree(version)) {
    return empty(`The installed git (${version || 'version unknown'}) predates 2.38, which added the merge-tree mode this forecast needs.`, repoRoot);
  }

  const linked = await listWorktrees(repoRoot);
  const considered = linked.slice(0, MAX_FORECAST_WORKTREES);
  const current = (await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 8_000 })).out.trim() || null;

  const rows = await pool(considered.map((w) => async () => {
    const recorded = w.branch
      ? (await runGit(repoRoot, ['config', '--get', `branch.${w.branch}.waniganbase`], { timeout: 8_000 })).out.trim()
      : '';
    // A worktree Wanigan did not make has no recorded base. The branch the
    // repository itself is on is the likely target, and the row says it was
    // inferred rather than recorded.
    const base = recorded || (current && current !== w.branch ? current : null);
    const tip = base ? await runGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${base}^{commit}`], { timeout: 8_000 }) : null;
    const snap = await snapshot(w.path);
    const baseSha = tip?.ok ? tip.out.trim() : null;
    let changed: number | null = null;
    if (snap.ok && baseSha) {
      const mb = await mergeBase(repoRoot, baseSha, snap.commit);
      const list = mb ? await changedSince(repoRoot, mb, snap.commit) : null;
      changed = list ? list.length : null;
    }
    const row: CollisionWorktree = {
      worktree: w.path, branch: w.branch, sessionId: w.sessionId,
      base, baseRecorded: !!recorded, changed,
      snapshot: snap.ok ? 'ok' : 'failed',
      detail: snap.ok ? (base && !baseSha ? `${base} is not a branch in this repository any more.` : null) : snap.detail,
    };
    return { row, commit: snap.ok ? snap.commit : null, baseSha };
  }), POOL);

  const sideOf = (row: CollisionWorktree): CollisionSide => ({ worktree: row.worktree, branch: row.branch, sessionId: row.sessionId });
  // A worktree with nothing changed cannot collide with anything, and pairing
  // it would bury the pairs that matter under rows that say so.
  const active = rows.filter((r) => r.commit && r.row.changed !== 0);

  const jobs: Array<() => Promise<CollisionPair>> = [];
  for (const r of active) {
    if (!r.baseSha || !r.row.base) continue;
    const baseSide: CollisionSide = { worktree: null, branch: r.row.base, sessionId: null };
    jobs.push(() => pairOf(repoRoot, 'base', sideOf(r.row), r.commit!, baseSide, r.baseSha!));
  }
  for (const [i, j] of peerPairs(active.length)) {
    jobs.push(() => pairOf(repoRoot, 'peer', sideOf(active[i].row), active[i].commit!, sideOf(active[j].row), active[j].commit!));
  }
  const pairs = await pool(jobs, POOL);

  return {
    projectId: project.id, repoRoot, at, unsupported: null,
    worktrees: rows.map((r) => r.row),
    pairs: orderPairs(pairs),
    omitted: Math.max(0, linked.length - considered.length),
  };
}
