// A card's own branch in its own git worktree, so agents working on different
// cards in one repository never edit the same checkout, and what a card changed
// can be read on its own. Git does every write here, and every one is refused
// rather than forced: nothing is reset, stashed, checked out over, or deleted
// while it holds work.
import { constants, existsSync, mkdirSync } from 'node:fs';
import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { explainFailure, parseStatus } from '../shared/git.ts';
import { CoreError } from '../shared/protocol.ts';
import { git, runGit } from './git.ts';
import { hasHook } from './git-client.ts';

export interface Worktree {
  path: string;
  branch: string;
  /** The branch the card forked from, which it merges back into. */
  base: string;
}

/** A worktree as ensureWorktree left it: whether it made the folder just now, and what `.worktreeinclude` brought in. */
export interface EnsuredWorktree extends Worktree {
  made: boolean;
  included: string[];
}

/** The most files `.worktreeinclude` brings into one worktree. */
const MAX_INCLUDED = 5_000;

export const branchFor = (cardKey: string): string => `wanigan/${cardKey.toLowerCase()}`;

/** Whether a folder is in a git repository. Throws, rather than saying no, when git itself is missing. */
export async function isRepository(path: string): Promise<boolean> {
  try {
    return (await git(path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch (error) {
    if (error instanceof CoreError) throw error;
    return false;
  }
}

/** Make (or reuse) the worktree for a card. */
export async function ensureWorktree(repo: string, path: string, cardKey: string, keepBranch?: string): Promise<EnsuredWorktree> {
  if (!(await isRepository(repo))) throw new CoreError('refused', 'This project is not a git repository, so a card cannot have its own branch.');
  // A worktree is the whole repository. For a project that is one folder inside
  // a larger repository, the agent would start at the wrong root.
  const prefix = (await git(repo, ['rev-parse', '--show-prefix']).catch(() => '')).trim();
  if (prefix) {
    throw new CoreError('refused', `This project is the folder ${prefix.replace(/\/$/, '')} inside a larger repository, so a card cannot have its own branch here. Open the repository’s root as the project to use branches.`);
  }
  const branch = keepBranch ?? branchFor(cardKey);
  const base = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (base === 'HEAD') throw new CoreError('refused', 'The project is on a detached HEAD. Check out a branch first.');
  if (existsSync(path) && await isRepository(path)) {
    const current = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return { path, branch: current, base, made: false, included: [] };
  }
  mkdirSync(dirname(path), { recursive: true });
  const exists = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  await git(repo, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'HEAD']).catch((e: Error) => {
    throw new CoreError('refused', `Git could not make the worktree: ${firstLine(e)}`);
  });
  // A worktree without the repository's .env cannot run; copying is best effort.
  const included = await copyIncluded(repo, path).catch(() => []);
  return { path, branch, base, made: true, included };
}

/**
 * Copy the files the repository's own `.worktreeinclude` names into a new
 * worktree, as Claude Code does (read from 2.1.292): gitignore-style patterns
 * relative to the repository root, and only files git ignores, such as `.env`;
 * tracked files come with the checkout. Git matches the patterns, so the rules
 * are git's own. Nothing is copied from outside the repository, through a
 * symbolic link, past a committed link that leads out of the worktree, or over
 * a file already there. Returns what was copied, relative to the root.
 */
export async function copyIncluded(repo: string, worktree: string): Promise<string[]> {
  const list = join(repo, '.worktreeinclude');
  const listed = await lstat(list).catch(() => null);
  if (!listed?.isFile()) return [];
  const matched = splitZ(await git(repo, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${list}`]).catch(() => ''));
  if (!matched.length) return [];
  const ignored = new Set(splitZ(await gitWithInput(repo, ['check-ignore', '-z', '--stdin'], `${matched.join('\0')}\0`)));
  const roots = { repo: await realpath(repo), worktree: await realpath(worktree) };
  const copied: string[] = [];
  for (const rel of matched) {
    if (copied.length >= MAX_INCLUDED) break;
    if (!ignored.has(rel) || isAbsolute(rel) || rel.split('/').includes('..')) continue;
    const from = join(repo, rel);
    const to = join(worktree, rel);
    try {
      if (!(await lstat(from)).isFile()) continue; // links, folders and sockets stay behind
      if (!inside(await realpath(dirname(from)), roots.repo)) continue;
      if (!inside(await realpath(await nearestExisting(dirname(to))), roots.worktree)) continue;
      await mkdir(dirname(to), { recursive: true });
      if (!inside(await realpath(dirname(to)), roots.worktree)) continue;
      await copyFile(from, to, constants.COPYFILE_EXCL);
      copied.push(rel);
    } catch {
      // One file that cannot be copied does not stop the rest.
    }
  }
  return copied;
}

const splitZ = (out: string): string[] => out.split('\0').filter(Boolean);
const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

async function nearestExisting(path: string): Promise<string> {
  for (let p = path; ; p = dirname(p)) {
    if (await lstat(p).then(() => true, () => false)) return p;
    if (dirname(p) === p) return p;
  }
}

/** git with text on stdin. A non-zero exit with output (check-ignore's "none matched") is still an answer. */
async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return (await runGit(cwd, args, { input, maxBuffer: 16 * 1024 * 1024 })).out;
}

/** Where the card's branch forked from its base, for "what did this card change". */
export async function forkPoint(worktree: string, base: string): Promise<string> {
  return (await git(worktree, ['merge-base', base, 'HEAD'])).trim();
}

/**
 * Merge a card's branch into the branch the main checkout is on. Refuses unless
 * the main checkout is on that base branch with no uncommitted changes and the
 * card's worktree has none either. Any failure is undone, and said for what it
 * was: a conflict, a hook, a signature, a missing identity or a timeout.
 */
export async function mergeCard(repo: string, worktree: Worktree, options: { resolve?: boolean } = {}): Promise<{ commit: string | null; conflicts: string[] }> {
  const current = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (current !== worktree.base) {
    throw new CoreError('refused', `The project folder is on ${current}, not ${worktree.base}. Switch it back to merge.`);
  }
  if ((await git(repo, ['status', '--porcelain'])).trim()) {
    throw new CoreError('refused', `The project folder has uncommitted changes. Commit or put them aside before merging ${worktree.branch}.`);
  }
  if (existsSync(worktree.path) && (await git(worktree.path, ['status', '--porcelain'])).trim()) {
    throw new CoreError('refused', `The card’s worktree has uncommitted changes. Ask the agent to commit them, or commit them yourself, first.`);
  }
  const before = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const merged = await runGit(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${worktree.branch}`, worktree.branch, '--'], { timeout: 120_000 });
  if (!merged.ok) {
    // Asked to: a conflict stays, for the owner to resolve in the Changes view (or abort there).
    const conflicts = parseStatus((await runGit(repo, ['status', '--porcelain=v2', '-z'])).out).conflicted.map((c) => c.path);
    if (options.resolve && conflicts.length) return { commit: null, conflicts };
    // Undone whatever stopped it: a merge left half-done, or a commit a hook let through and git then failed to finish.
    const midway = await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false);
    if (midway) await git(repo, ['merge', '--abort']).catch(() => {});
    const failure = explainFailure({
      stderr: merged.err, stdout: merged.out, killed: merged.killed, missing: merged.missing, what: 'the merge',
      hooks: await hasHook(repo, ['pre-merge-commit', 'commit-msg', 'prepare-commit-msg']),
    });
    const now = (await git(repo, ['rev-parse', 'HEAD']).catch(() => before)).trim();
    const undone = now === before ? 'It was undone, and nothing changed.' : 'Git left the folder at a different commit than before; look before merging again.';
    const next = failure.kind === 'conflict'
      ? ` Resolve it in the project folder, or bring ${worktree.base} into the card’s branch (or ask its agent to), then merge again.${conflicts.length ? ` It conflicted in ${conflicts.slice(0, 8).join(', ')}${conflicts.length > 8 ? ` and ${conflicts.length - 8} more` : ''}.` : ''}`
      : '';
    throw new CoreError(failure.kind === 'conflict' ? 'conflict' : 'refused', `${failure.message} ${undone}${next}`);
  }
  return { commit: (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim(), conflicts: [] };
}

/**
 * Remove a card's worktree and its branch. Every refusal comes before anything
 * is removed, so a refused removal leaves the folder, the branch and the card
 * exactly as they were.
 */
export async function removeWorktree(repo: string, worktree: Worktree): Promise<void> {
  const folder = existsSync(worktree.path);
  if (folder && (await git(worktree.path, ['status', '--porcelain']).catch(() => '')).trim()) {
    throw new CoreError('refused', 'The card’s worktree has uncommitted changes, so nothing was removed. Commit or discard them first.');
  }
  const branch = await hasBranch(repo, worktree.branch);
  if (branch && !(await git(repo, ['merge-base', '--is-ancestor', worktree.branch, worktree.base]).then(() => true, () => false))) {
    throw new CoreError('refused', `${worktree.branch} has commits that are not in ${worktree.base}, so nothing was removed. Merge it first.`);
  }
  if (folder) {
    await git(repo, ['worktree', 'remove', worktree.path]).catch((e: Error) => {
      throw new CoreError('refused', `Git would not remove the worktree, so it was left in place: ${firstLine(e)}`);
    });
  } else {
    await git(repo, ['worktree', 'prune']).catch(() => {});
  }
  // Merged into its base was checked above. `-d` would check against whatever
  // the project folder has checked out instead, and refuse after the folder is gone.
  if (branch) await git(repo, ['branch', '-D', worktree.branch]);
}

/**
 * The card's worktree folder was removed outside Wanigan: make it again from
 * the card's branch (or a new one, if that is gone too).
 */
export async function restoreWorktree(repo: string, worktree: Worktree, cardKey: string): Promise<EnsuredWorktree> {
  await git(repo, ['worktree', 'prune']).catch(() => {});
  const kept = await hasBranch(repo, worktree.branch);
  // The card's own branch, by name: the project key may have changed since.
  const made = await ensureWorktree(repo, worktree.path, cardKey, kept ? worktree.branch : undefined);
  return kept ? { ...made, base: worktree.base } : made;
}

const hasBranch = (repo: string, branch: string): Promise<boolean> =>
  git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);

function firstLine(e: Error): string {
  const text = String((e as Error & { stderr?: string }).stderr || e.message || e);
  return text.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !/^Command failed/.test(l)) ?? text;
}
