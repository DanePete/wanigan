// Shared argument validation and failure handling for the git workbench.
import { accessSync, constants, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { explainFailure, refProblem, type CommitLine, type GitFailure } from '../shared/git.ts';
import { CoreError } from '../shared/protocol.ts';
import { runGit, type GitRun } from './git.ts';

/** Reads never run a filesystem monitor a repository's config names. */
export const SAFE = ['-c', 'core.fsmonitor=false'];
/** Diff-read configuration goes before the subcommand. Git 2.40 has no
 * --default-prefix; config also avoids Git 2.55's stash-show use-after-free
 * with string prefix arguments. These values never change the owner's config. */
export const DIFF_CONFIG = [...SAFE, '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.srcPrefix=a/', '-c', 'diff.dstPrefix=b/'];
/** Plain diff output, paired with DIFF_CONFIG before the subcommand. */
export const PLAIN = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative'];
export const MAX_TOTAL_DIFF = 2_000_000;
export const SEP = '\x1f';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const refused = (message: string): never => { throw new CoreError('refused', message); };

/** The same folder, however it was reached (/var and /private/var on a Mac). */
export function same(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** A ref from the window, checked before it becomes an argument. */
export function ref(value: unknown): string {
  const problem = refProblem(value);
  if (problem) throw new CoreError('invalid', problem);
  return value as string;
}

/** A file path from the window: relative, inside the checkout, no NUL. */
export function filePath(checkout: string, value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096) throw new CoreError('invalid', 'Which file?');
  const full = resolve(checkout, value);
  if (value.startsWith('/') || !full.startsWith(`${resolve(checkout)}/`)) throw new CoreError('forbidden', 'That path is outside the project.');
  return value;
}

/** A pathspec git reads as exactly this file: no globbing, from the top of the repository. */
export const literal = (path: string): string => `:(top,literal)${path}`;

export function failed(r: GitRun, what: string, hooks = false): GitFailure {
  return explainFailure({ stderr: r.err, stdout: r.out, killed: r.killed, missing: r.missing, what, hooks });
}

/** The answer, or a refusal that says what git said. */
export async function must(cwd: string, args: string[], what: string, options: Parameters<typeof runGit>[2] = {}): Promise<string> {
  const r = await runGit(cwd, args, options);
  if (!r.ok) refused(failed(r, what).message);
  return r.out;
}

/** Whether the repository has one of these hooks, where its config says hooks live. */
export async function hasHook(cwd: string, names: string[]): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--git-path', 'hooks'], { timeout: 8_000 });
  if (!r.ok) return false;
  const dir = resolve(cwd, r.out.trim());
  return names.some((n) => {
    try { accessSync(join(dir, n), constants.X_OK); return true; } catch { return false; }
  });
}

/** Commits a range names, newest first, bounded. */
export async function commitsIn(cwd: string, range: string[], max = 50): Promise<CommitLine[]> {
  const out = await must(cwd, ['log', `--max-count=${max}`, `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%at`, ...range, '--'], 'the history');
  return out.split('\n').filter(Boolean).map((l) => {
    const [hash = '', short = '', subject = '', author = '', at = '0'] = l.split(SEP);
    return { hash, short, subject, author, at: Number(at) * 1000 };
  });
}

/** Remote branches that have a commit, without a remote's own HEAD (which git now makes on fetch, and names only "origin"). */
export async function remotesContaining(cwd: string, commit: string): Promise<string[]> {
  const r = await runGit(cwd, ['branch', '-r', '--contains', commit, `--format=%(refname:short)${SEP}%(symref)`]);
  if (!r.ok) refused(failed(r, 'the remote branches containing this commit').message);
  return r.out.split('\n').flatMap((l) => {
    const [name = '', symref = ''] = l.split(SEP);
    return name.trim() && !symref.trim() && !name.endsWith('/HEAD') ? [name.trim()] : [];
  });
}

export async function count(cwd: string, range: string[]): Promise<number> {
  const r = await runGit(cwd, ['rev-list', '--count', ...range, '--'], { timeout: 20_000 });
  if (!r.ok) refused(failed(r, 'the commit count').message);
  const value = r.out.trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) refused('Git returned an unreadable commit count. Try again.');
  return Number(value);
}

export const resolves = async (cwd: string, rev: string): Promise<string | null> => {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeout: 8_000 });
  return r.ok ? r.out.trim() || null : null;
};
