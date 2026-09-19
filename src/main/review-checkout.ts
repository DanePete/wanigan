import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ReviewCheckoutSnapshot } from '../shared/types';

const exec = promisify(execFile);
const LIMITS = { files: 20_000, bytes: 1024 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, gitBytes: 8 * 1024 * 1024, ms: 15_000 };
type Inventory = { head: string | null; index: string; untracked: string; files: string[] };
type Budget = { deadline: number; expired: boolean };
type Content = { digest: string; identities: Map<string, string | null> };

function check(budget: Budget): void {
  if (budget.expired || Date.now() >= budget.deadline) throw new Error('Checkout fingerprint exceeded its 15-second time limit.');
}

/** No Git environment redirection, pager, lazy fetch, optional index writes, or fsmonitor hook. */
async function git(cwd: string, args: string[], budget: Budget, allowAbsent = false): Promise<string | null> {
  check(budget);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat',
  });
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', '-c', 'core.preloadIndex=false', '-C', cwd, ...args], {
      env, encoding: 'buffer', timeout: Math.max(1, budget.deadline - Date.now()),
      maxBuffer: LIMITS.gitBytes, killSignal: 'SIGKILL', windowsHide: true,
    });
    check(budget);
    const text = stdout.toString('utf8');
    if (!Buffer.from(text).equals(stdout)) throw new Error('Checkout contains a Git path that is not valid UTF-8.');
    return text;
  } catch (error) {
    check(budget);
    if (allowAbsent && (error as { code?: unknown }).code === 1) return null;
    // Never return Git stderr: it can contain repository contents or config values.
    if (error instanceof Error && error.message.startsWith('Checkout contains')) throw error;
    throw new Error('Git could not read bounded checkout metadata. The repository may be unavailable or exceed the output limit.');
  }
}

async function readHead(root: string, budget: Budget): Promise<string | null> {
  const value = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], budget, true);
  if (value !== null) {
    const head = value.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error('Git returned an unsupported HEAD identity.');
    return head;
  }
  const branch = (await git(root, ['symbolic-ref', '--quiet', 'HEAD'], budget))?.trim();
  if (!branch?.startsWith('refs/heads/') || /[\r\n\0]/.test(branch)) throw new Error('The checkout has no readable HEAD.');
  if (await git(root, ['show-ref', '--verify', '--quiet', branch], budget, true) !== null) {
    throw new Error('The checkout HEAD changed while it was being read.');
  }
  return null; // A verified unborn branch, not an arbitrary failed HEAD read.
}

function entries(value: string): string[] {
  if (!value) return [];
  if (!value.endsWith('\0')) throw new Error('Git returned incomplete checkout metadata.');
  return value.slice(0, -1).split('\0');
}

function safeName(name: string): void {
  const parts = name.split('/');
  if (!name || path.isAbsolute(name) || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    || (process.platform === 'win32' && /[\\:]/.test(name))) {
    throw new Error('The checkout contains an unsupported file path.');
  }
}

async function inventory(root: string, budget: Budget): Promise<Inventory> {
  const head = await readHead(root, budget);
  const index = await git(root, ['ls-files', '--cached', '--stage', '-v', '--full-name', '-z'], budget) ?? '';
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], budget) ?? '';
  const files = new Set<string>();
  for (const row of entries(index)) {
    const match = /^[A-Za-z?] ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Git returned an unsupported index entry.');
    if (match[1] === '160000') throw new Error('Checkout fingerprints do not support submodules.');
    if (match[1] === '120000') throw new Error('Checkout fingerprints do not follow symbolic links.');
    if (match[1] !== '100644' && match[1] !== '100755') throw new Error('Checkout contains an unsupported indexed file type.');
    safeName(match[4]); files.add(match[4]);
  }
  for (const name of entries(untracked)) { safeName(name); files.add(name); }
  if (files.size > LIMITS.files) throw new Error('Checkout fingerprint exceeds the 20,000-file limit.');
  return { head, index, untracked, files: [...files].sort() };
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function statOrMissing(file: string): Promise<BigIntStats | null> {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if ((error as { code?: unknown }).code === 'ENOENT') return null; throw error; }
}

/** Check every ancestor, including absent parents of a tracked deletion, before opening a file. */
async function checkedPath(root: string, name: string, budget: Budget): Promise<BigIntStats | null> {
  let current = root;
  const parts = name.split('/');
  for (let n = 0; n < parts.length; n++) {
    check(budget);
    current = path.join(current, parts[n]);
    const stat = await statOrMissing(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw new Error('Checkout fingerprints do not follow symbolic links.');
    if (n < parts.length - 1 && !stat.isDirectory()) throw new Error('A checkout file parent is not a directory.');
    if (await realpath(current) !== current) throw new Error('A checkout path changed or resolves outside its recorded location.');
    if (n === parts.length - 1) return stat;
  }
  return null;
}

function add(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value))); hash.update(':'); hash.update(value);
}

async function contentHash(root: string, cwd: string, state: Inventory, budget: Budget): Promise<Content> {
  const hash = createHash('sha256');
  add(hash, 'wanigan-review-checkout-v1'); add(hash, cwd); add(hash, root);
  add(hash, state.head ?? 'unborn'); add(hash, state.index); add(hash, state.untracked);
  let bytes = 0;
  const buffer = Buffer.alloc(64 * 1024);
  const identities = new Map<string, string | null>();
  for (const name of state.files) {
    check(budget);
    add(hash, name);
    const before = await checkedPath(root, name, budget);
    identities.set(name, before ? identity(before) : null);
    if (!before) { add(hash, 'missing'); continue; }
    if (!before.isFile()) throw new Error('Checkout contains a nonregular file or an embedded repository.');
    if (before.size > BigInt(LIMITS.fileBytes)) throw new Error('A checkout file exceeds the 16 MiB fingerprint limit.');
    bytes += Number(before.size);
    if (bytes > LIMITS.bytes) throw new Error('Checkout content exceeds the 1 GiB fingerprint limit.');
    // O_NOFOLLOW protects the final component; ancestry and descriptor identity
    // are checked again before reading and afterward to reject detected races.
    const handle = await open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      const named = await checkedPath(root, name, budget);
      if (!named || identity(before) !== identity(opened) || identity(named) !== identity(opened)) {
        throw new Error('Checkout files changed while the fingerprint was being read.');
      }
      add(hash, String(before.mode & 0o777n)); add(hash, String(before.size));
      let offset = 0;
      for (;;) {
        check(budget);
        const read = await handle.read(buffer, 0, buffer.length, offset);
        check(budget);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
        if (offset > Number(before.size)) throw new Error('A checkout file grew while its fingerprint was being read.');
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await checkedPath(root, name, budget);
      if (offset !== Number(before.size) || !after || identity(before) !== identity(after)
        || identity(before) !== identity(await handle.stat({ bigint: true }))) {
        throw new Error('Checkout files changed while the fingerprint was being read.');
      }
    } finally { await handle.close(); }
  }
  return { digest: hash.digest('hex'), identities };
}

/**
 * Fingerprint the entire Git checkout, even when cwd is a project subdirectory.
 * Includes HEAD, index entries/flags, tracked bytes and nonignored untracked bytes;
 * ignored files, dependencies, outside-root inputs and tool versions are excluded.
 * Two matching reads detect ordinary concurrent edits, not an atomic filesystem
 * snapshot. Unsupported paths/types, submodules and exhausted bounds fail closed.
 * Only the digest and identity leave this module; no file contents are retained.
 */
export async function checkoutSnapshot(cwd: string): Promise<ReviewCheckoutSnapshot> {
  let canonical = cwd;
  let head: string | null = null;
  const budget: Budget = { deadline: Date.now() + LIMITS.ms, expired: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async (): Promise<ReviewCheckoutSnapshot> => {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\r\n\0]/.test(cwd)) throw new Error('Checkout needs an absolute local directory path.');
      canonical = await realpath(cwd); check(budget);
      if (!(await lstat(canonical)).isDirectory()) throw new Error('Checkout path is not a directory.');
      const top = await git(canonical, ['rev-parse', '--show-toplevel'], budget);
      const root = top?.endsWith('\n') ? top.slice(0, -1) : top;
      if (!root || /[\r\n\0]/.test(root) || await realpath(root) !== root) throw new Error('Git did not identify a canonical checkout root.');
      const relative = path.relative(root, canonical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Checkout directory is outside its Git root.');
      const first = await inventory(root, budget); head = first.head;
      const firstContent = await contentHash(root, canonical, first, budget);
      const second = await inventory(root, budget);
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error('Checkout changed while the fingerprint was being read.');
      }
      const secondContent = await contentHash(root, canonical, second, budget);
      if (firstContent.digest !== secondContent.digest) throw new Error('Checkout changed while the fingerprint was being read.');
      for (const [name, observed] of secondContent.identities) {
        const final = await checkedPath(root, name, budget);
        if (firstContent.identities.get(name) !== observed || (final ? identity(final) : null) !== observed) {
          throw new Error('Checkout files changed while the fingerprint was being read.');
        }
      }
      if (JSON.stringify(second) !== JSON.stringify(await inventory(root, budget)) || await realpath(cwd) !== canonical) {
        throw new Error('Checkout changed while the fingerprint was being read.');
      }
      check(budget);
      return { cwd: canonical, head, fingerprint: firstContent.digest, unavailableReason: null };
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { budget.expired = true; reject(new Error('Checkout fingerprint exceeded its 15-second time limit.')); }, LIMITS.ms);
    });
    return await Promise.race([work(), timeout]);
  } catch (error) {
    const reason = error instanceof Error && !('code' in error) ? error.message : 'Checkout files could not be read safely.';
    return { cwd: canonical, head, fingerprint: null, unavailableReason: reason };
  } finally { if (timer) clearTimeout(timer); }
}
