import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import { runGit } from './git';
import { projectById } from './store';
import { createWorktree, repoRootFor, worktreeStatus } from './worktrees';
import {
  RESTRICTED_FLAG, forgeOf, parsePrNumber, prFetchSpec, prNoun, prRefs, reviewPromptStub, type Forge,
} from '../shared/pr-review';

const exec = promisify(execFile);

/**
 * Reviewer sessions with no command tools, and "Review PR #N".
 *
 * `--restricted` is checked against the binary about to run, not assumed from
 * a version string: the flag is looked for in that binary's own `--help`, and
 * cached by path, size and modification time so an upgrade is re-read.
 */

const helpCache = new Map<string, { size: number; mtimeMs: number; supported: boolean }>();

export async function restrictedFlagSupported(bin: string): Promise<boolean> {
  let stat: fs.Stats;
  try { stat = fs.statSync(bin); } catch { return false; }
  const cached = helpCache.get(bin);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.supported;
  let supported = false;
  try {
    const { stdout, stderr } = await exec(bin, ['--help'], { timeout: 8_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' } });
    supported = new RegExp(`(^|\\s)${RESTRICTED_FLAG}(\\s|$)`, 'm').test(`${stdout}\n${stderr}`);
  } catch { supported = false; }
  helpCache.set(bin, { size: stat.size, mtimeMs: stat.mtimeMs, supported });
  return supported;
}

/**
 * The refusals a review-only launch answers before anything is prepared.
 * `harness` and `source` are the resolved profile's; only a built-in Claude
 * Code profile has a verified --restricted.
 */
export function reviewOnlyRefusal(input: { harness: string; source: string; permissionMode?: string | null }): string | null {
  if (input.harness !== 'claude-code' || input.source !== 'builtin') {
    return 'Review only (no command tools) is available for Claude Code sessions only; this profile has no verified way to remove its command tools.';
  }
  if (input.permissionMode === 'bypassPermissions') {
    return 'Review only (no command tools) cannot run with bypassPermissions; Claude Code refuses that combination too.';
  }
  return null;
}

/* ── the goal review task's toggle ──────────────────────────────────── */

/** Whether a goal's review task launches with no command tools. On unless the operator turned it off. */
export function goalReviewOnly(docketId: string): boolean {
  const row = db().prepare('SELECT enabled FROM goal_review_only WHERE docket_id=?').get(docketId) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function setGoalReviewOnly(docketId: unknown, enabled: unknown): boolean {
  if (typeof docketId !== 'string' || !docketId || docketId.length > 200) throw new Error('A goal is required.');
  if (typeof enabled !== 'boolean') throw new Error('Say whether the review task has command tools.');
  const exists = db().prepare('SELECT 1 FROM work_dockets WHERE id=?').get(docketId);
  if (!exists) throw new Error('That goal no longer exists.');
  db().prepare('INSERT INTO goal_review_only (docket_id, enabled, updated_at) VALUES (?,?,?) ON CONFLICT(docket_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at')
    .run(docketId, enabled ? 1 : 0, Date.now());
  return enabled;
}

/* ── Review PR #N ───────────────────────────────────────────────────── */

export type PreparedReview = {
  projectId: string;
  prNumber: number;
  forge: Forge;
  ref: string;
  head: string;
  worktree: string;
  branch: string;
  prompt: string;
  noun: string;
};

/**
 * Fetch a pull or merge request's head from origin into a new Wanigan-managed
 * worktree. Every git failure is reported in git's own words; nothing is
 * created until the fetch has succeeded.
 */
export async function preparePrReview(projectId: unknown, rawNumber: unknown): Promise<PreparedReview> {
  const n = parsePrNumber(rawNumber);
  if (n === null) throw new Error('Enter a pull request number, such as 128 or #128.');
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('That project is not registered with Wanigan.');
  const root = await repoRootFor(project.path);
  if (!root) throw new Error(`${project.name} is not a git repository.`);
  // The configured URL, not `remote get-url`, which applies url.insteadOf
  // rewrites: the forge is whatever the operator named, wherever git routes it.
  const remote = await runGit(root, ['config', '--get', 'remote.origin.url'], { timeout: 8_000 });
  if (!remote.ok) throw new Error(`git could not read origin: ${(remote.err || remote.out).trim() || 'no origin remote'}`);
  const forge = forgeOf(remote.out);
  let fetched: { ref: string; head: string } | null = null;
  const errors: string[] = [];
  for (const ref of prRefs(forge, n)) {
    // Into Wanigan's own ref namespace: no branch of the operator's is moved.
    const fetch = await runGit(root, ['fetch', '--no-tags', 'origin', prFetchSpec(ref, n)], { timeout: 5 * 60_000 });
    if (!fetch.ok) { errors.push(`git fetch origin ${ref}: ${(fetch.err || fetch.out).trim().split('\n').slice(-3).join(' ') || 'failed with no output'}`); continue; }
    const rev = await runGit(root, ['rev-parse', '--verify', `refs/wanigan/review/${n}^{commit}`], { timeout: 8_000 });
    if (!rev.ok) { errors.push(`git rev-parse: ${(rev.err || rev.out).trim()}`); continue; }
    fetched = { ref, head: rev.out.trim() };
    break;
  }
  if (!fetched) throw new Error(errors.join(' · ') || `Could not fetch ${prNoun(forge)} ${n}.`);
  const pseudoSession = `review_pr_${n}_${Date.now().toString(36)}`;
  const info = await createWorktree(root, `review-pr-${n}`, pseudoSession, fetched.head);
  db().prepare('INSERT INTO pr_review_worktrees (path, project_id, pr_number, forge, ref, head, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(info.path, project.id, n, forge, fetched.ref, fetched.head, Date.now());
  return {
    projectId: project.id, prNumber: n, forge, ref: fetched.ref, head: fetched.head,
    worktree: info.path, branch: info.branch ?? `review-pr-${n}`, prompt: reviewPromptStub(n, forge, info.branch ?? `review-pr-${n}`), noun: prNoun(forge),
  };
}

/**
 * A renderer-supplied review worktree is accepted only if Wanigan created it
 * for that project through preparePrReview and it still exists.
 */
export async function assertReviewWorktree(worktree: unknown, projectId: string): Promise<string> {
  if (typeof worktree !== 'string' || !worktree) throw new Error('No review worktree was given.');
  let real: string;
  try { real = fs.realpathSync.native(path.resolve(worktree)); } catch { throw new Error('The review worktree no longer exists.'); }
  const row = db().prepare('SELECT path, project_id FROM pr_review_worktrees WHERE path=?').get(real) as { path: string; project_id: string } | undefined;
  if (!row || row.project_id !== projectId) throw new Error('That folder is not a review worktree Wanigan prepared for this project.');
  const status = await worktreeStatus(real);
  if (!status) throw new Error('The review worktree is no longer a git worktree.');
  return real;
}
