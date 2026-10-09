// The one place the core runs git, and what changed in a project folder.
//
// Every git the core starts goes through `runGit`: an argument array, never a
// shell; the login shell's PATH, as every other tool the core runs (an app
// opened from the Dock has launchd's PATH, where a Homebrew git is invisible);
// and an environment that can never sit on a prompt nobody can see — no
// terminal password prompt, no askpass helper, ssh in batch mode, no editor,
// no pager. A git that is not installed is told apart from a folder that is
// not a repository, and a git that took too long from a git that said no.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Changes, ChangedFile } from '../shared/model.ts';
import type { RepoProblem } from '../shared/git.ts';
import { CoreError } from '../shared/protocol.ts';
import { notInstalledMessage } from '../shared/clis.ts';
import { readBoundedFile } from './bounded-file.ts';
import { cleanEnv, loginPath, notInstalled } from './environment.ts';

const MAX_DIFF = 400_000;
const MAX_UNTRACKED = 200_000;
/** Untracked files listed; past this (an unignored build folder) the rest are counted, not listed. */
const MAX_LISTED = 2_000;
/** Untracked files whose lines are counted. Each is a file read; the rest show no count. */
const MAX_COUNTED = 300;

/** git's own variables that would point it at another repository, index or object store. */
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];

export interface GitRun {
  ok: boolean;
  out: string;
  err: string;
  /** git's exit status; null when it was killed or never started. */
  code: number | null;
  /** Stopped at its time limit. */
  killed: boolean;
  /** git itself was not found. */
  missing: boolean;
  /** Either output stream printed more than its buffer holds. */
  truncated: boolean;
  /** Specifically stdout exceeded its buffer; `out` is a bounded prefix. */
  stdoutTruncated: boolean;
}

export interface GitRunOptions {
  timeout?: number;
  maxBuffer?: number;
  /** Extra variables (a scratch index, say). The no-prompt rules always win. */
  env?: Record<string, string>;
  /** Written to git's stdin, which is then closed. */
  input?: string;
}

let overlay: Record<string, string> = {};

/**
 * Variables every git this core runs gets, under the no-prompt rules: the
 * demo's (no global config, its own identity) and the tests'. The owner's own
 * core sets none, so their commits carry their name and their signature.
 */
export function setGitEnvironment(env: Record<string, string>): void {
  overlay = { ...env };
}

/** The environment a git runs in. */
export async function gitEnvironment(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env = cleanEnv(process.env);
  for (const key of GIT_REDIRECTS) delete env[key];
  // git's messages in English, so a refusal can be read; file names keep the owner's encoding.
  const ctype = env.LC_ALL || env.LC_CTYPE || env.LANG;
  delete env.LC_ALL;
  if (ctype) env.LC_CTYPE = ctype;
  return {
    ...env,
    PATH: await loginPath(),
    ...overlay,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
    GIT_EDITOR: ':',
    GIT_SEQUENCE_EDITOR: ':',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    LC_MESSAGES: 'C',
    LANGUAGE: '',
  };
}

/**
 * Run git and say what happened. Never throws: half of what the core asks git
 * is a question where "no" is the answer, and the caller decides which.
 */
export async function runGit(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitRun> {
  const env = await gitEnvironment(options.env);
  return new Promise((resolvePromise) => {
    const child = execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, env, timeout: options.timeout ?? 30_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
      const code = e ? (typeof e.code === 'number' ? e.code : null) : 0;
      const truncated = !!e && (e.code as unknown) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      resolvePromise({
        ok: !e,
        out: String(stdout ?? ''),
        err: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''),
        code,
        killed: !!e && (e.killed === true || e.signal === 'SIGTERM'),
        // A folder that is gone fails to start the same way; only a folder that is there means git is missing.
        // So does the Mac's /usr/bin/git stub when Apple's command line tools are not installed.
        missing: !!e && existsSync(cwd) && gitMissing(e, String(stderr ?? '')),
        truncated,
        // execFile identifies the overflowing stream in its own error message,
        // not in stderr. Unknown overflow reasons must not authorize partial reads.
        stdoutTruncated: truncated && e?.message === 'stdout maxBuffer length exceeded',
      });
    });
    // A git that exits before reading its input closes the pipe; that is not this command's result.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

/**
 * git's answer, or an error carrying what it printed (for callers that only
 * want the answer). When git itself is missing, the refusal says how to install it.
 */
export async function git(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
  const r = await runGit(cwd, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (r.ok) return r.out;
  if (r.missing) throw notInstalled('git');
  const reason = r.killed ? 'git took too long' : r.err.trim() || `git exited with ${r.code}`;
  throw Object.assign(new Error(reason), { stderr: r.err, stdout: r.out, code: r.code, killed: r.killed, missing: r.missing });
}

/**
 * Why a folder cannot be worked on with git, or null when it can: the folder
 * is gone, git is not installed, it is not a repository, it is a bare one, it
 * is a folder inside a larger repository, or git could not read it.
 */
export async function repoProblem(path: string): Promise<RepoProblem | null> {
  if (!existsSync(path)) return { kind: 'missing' };
  const unreadable = (r: GitRun): RepoProblem => ({
    kind: 'unreadable',
    reason: r.killed ? 'git took too long to answer' : r.err.split('\n').find((l) => l.trim())?.replace(/^(?:fatal|error): /, '') ?? 'git gave no reason',
  });
  const r = await runGit(path, ['rev-parse', '--is-inside-work-tree'], { timeout: 10_000 });
  if (r.missing) return { kind: 'no-git' };
  if (!r.ok) return /not a git repository/i.test(r.err) ? { kind: 'not-repo' } : unreadable(r);
  if (r.out.trim() !== 'true') return { kind: 'bare' };
  const where = await runGit(path, ['rev-parse', '--show-prefix', '--show-toplevel'], { timeout: 10_000 });
  if (!where.ok) return unreadable(where);
  const [prefix = '', top = ''] = where.out.split('\n');
  if (prefix.trim()) return { kind: 'subfolder', top: top.trim(), prefix: prefix.trim().replace(/\/$/, '') };
  return null;
}

/** A problem, in words, for a refusal. */
export function problemText(p: RepoProblem, path: string): string {
  switch (p.kind) {
    case 'no-git': return notInstalledMessage('git');
    case 'missing': return `The folder ${path} is gone.`;
    case 'not-repo': return `${path} is not a git repository.`;
    case 'bare': return `${path} is a bare repository: it has no working tree to change.`;
    case 'subfolder': return `This project is the folder ${p.prefix} inside the repository at ${p.top}. Git commits, branches and pushes act on the whole repository, so open ${p.top} as a project to use them.`;
    case 'unreadable': return `Git could not read ${path}: ${p.reason}.`;
  }
}

/**
 * git is not there: not on the PATH at all, or the Mac's /usr/bin/git standing
 * in for Apple's command line tools, which are not installed (or were removed).
 */
export function gitMissing(error: { code?: unknown }, stderr: string): boolean {
  return error.code === 'ENOENT' || /xcrun: error|xcode-select: note|no developer tools were found|invalid active developer path/i.test(stderr);
}

/**
 * Changes in a working tree against `base`: committed and uncommitted edits to
 * tracked files since that commit, plus untracked files. With the default
 * `HEAD` that is the folder's uncommitted work; with a card branch's fork
 * point it is everything the card has done.
 */
export async function changes(projectPath: string, base = 'HEAD'): Promise<Changes> {
  try {
    await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    // git missing is not "not a repository": say what to install.
    if (error instanceof CoreError) throw error;
    return { git: false, branch: null, head: null, files: [], additions: 0, deletions: 0, omitted: 0 };
  }
  const [branch, head, names, numstat, porcelain] = await Promise.all([
    git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim()).catch(() => null),
    git(projectPath, ['rev-parse', '--short', 'HEAD']).then((s) => s.trim()).catch(() => null),
    git(projectPath, ['diff', '--name-status', '-z', base]).catch(() => ''),
    git(projectPath, ['diff', '--numstat', '-z', base]).catch(() => ''),
    git(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);

  const files = changedFiles(names, numstat);
  const untracked = porcelain.split('\0').filter((r) => r.startsWith('?? ')).map((r) => r.slice(3));
  const listed = untracked.slice(0, MAX_LISTED);
  const counted = await inBatches(listed.slice(0, MAX_COUNTED), 16, (path) => countUntracked(join(projectPath, path)));
  listed.forEach((path, i) => {
    const c = counted[i] ?? null;
    files.push({ path, status: '?', additions: c?.add ?? null, deletions: c?.del ?? null, binary: c?.binary ?? false });
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    git: true, branch, head, files, omitted: untracked.length - listed.length,
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}

/**
 * Files from `git diff --name-status -z` and `--numstat -z` run with the same
 * arguments. Renames and copies are listed by their new path; `from` is the
 * old one.
 */
export function changedFiles(names: string, numstat: string): (ChangedFile & { from?: string })[] {
  const counts = new Map<string, { add: number | null; del: number | null; binary: boolean }>();
  // numstat -z: "add\tdel\tpath\0", or for renames "add\tdel\t\0old\0new\0".
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const [add = '', del = '', path = ''] = entry.split('\t');
    const target = path || (i += 2, parts[i] ?? '');
    const binary = add === '-' && del === '-';
    counts.set(target, { add: binary ? null : Number(add), del: binary ? null : Number(del), binary });
  }

  const files: (ChangedFile & { from?: string })[] = [];
  // name-status -z: "M\0path\0", or for renames "R100\0old\0new\0".
  const fields = names.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const renamed = code.startsWith('R') || code.startsWith('C');
    const from = renamed ? fields[i + 1] : undefined;
    const path = renamed ? fields[i + 2] : fields[i + 1];
    i += renamed ? 2 : 1;
    if (!path) continue;
    const status: ChangedFile['status'] = code.startsWith('D') ? 'D' : code.startsWith('A') ? 'A' : renamed ? 'R' : 'M';
    const c = counts.get(path) ?? null;
    files.push({ path, status, additions: c?.add ?? null, deletions: c?.del ?? null, binary: c?.binary ?? false, ...(from ? { from } : {}) });
  }
  return files;
}

/** The unified diff of one changed file. Only a file git reports as changed can be read. */
export async function diff(projectPath: string, file: string, base = 'HEAD'): Promise<{ path: string; diff: string; truncated: boolean }> {
  const full = resolve(projectPath, file);
  if (!full.startsWith(`${resolve(projectPath)}/`)) throw new CoreError('forbidden', 'That path is outside the project.');
  // Ask git about this one path rather than listing every change again.
  const [tracked, status] = await Promise.all([
    git(projectPath, ['diff', '--name-only', '-z', base, '--', file]).catch(() => ''),
    git(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', file]).catch(() => ''),
  ]);
  const isTracked = tracked.split('\0').includes(file);
  const isUntracked = status.split('\0').includes(`?? ${file}`);
  if (!isTracked && !isUntracked) throw new CoreError('not_found', 'That file has no changes.');
  const text = isTracked
    ? await git(projectPath, ['diff', '--no-color', '--no-ext-diff', base, '--', file])
    : await untrackedDiff(full, file);
  const truncated = text.length > MAX_DIFF;
  return { path: file, diff: truncated ? text.slice(0, MAX_DIFF) : text, truncated };
}

type Count = { add: number | null; del: number | null; binary: boolean };

/**
 * An untracked file's text, or why there is none. A symbolic link is shown as
 * its target and never followed (it may point outside the project), and
 * anything that is not a regular file (a FIFO would block the read forever)
 * is not opened at all.
 */
export async function readUntracked(path: string): Promise<{ text: string } | { note: string; binary?: boolean }> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return { note: `Symbolic link to ${await readlink(path)}` };
  if (!info.isFile()) return { note: 'Not a regular file.' };
  if (info.size > MAX_UNTRACKED) return { note: 'Too large to show.' };
  const buffer = readBoundedFile(path, MAX_UNTRACKED);
  if (buffer.includes(0)) return { note: 'Binary file.', binary: true };
  return { text: buffer.toString('utf8') };
}

/** An untracked file's line count, or null when it cannot be read. */
export async function countUntracked(path: string): Promise<Count | null> {
  try {
    const read = await readUntracked(path);
    if ('note' in read) return { add: null, del: null, binary: read.binary ?? false };
    const { text } = read;
    return { add: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, del: 0, binary: false };
  } catch {
    return null;
  }
}

async function untrackedDiff(full: string, path: string): Promise<string> {
  try {
    const read = await readUntracked(full);
    if ('note' in read) return read.binary ? '' : `New ${path}: ${read.note}`;
    const lines = read.text.replace(/\n$/, '').split('\n');
    return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
  } catch {
    throw new CoreError('refused', 'Wanigan could not read this file’s diff. Check the file and try again.');
  }
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}
