import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { runGit, head, repoState, scopeOf } from './git';
import { shellPath } from './providers';
import { assertManagedRoot, assertOpenablePath } from './roots';

const exec = promisify(execFile);

/* ── editors ─────────────────────────────────────────────────────────── */

const EDITORS = [
  { id: 'code',    label: 'VS Code',  bin: 'code' },
  { id: 'cursor',  label: 'Cursor',   bin: 'cursor' },
  { id: 'windsurf',label: 'Windsurf', bin: 'windsurf' },
  { id: 'subl',    label: 'Sublime',  bin: 'subl' },
  { id: 'zed',     label: 'Zed',      bin: 'zed' },
];

export type Editor = { id: string; label: string; path: string };

function isExecutableFile(full: string): boolean {
  try {
    // `access(X_OK)` alone accepts a directory. execFile will reject it later,
    // but an editor entry should always be something we can actually execute.
    if (!fs.statSync(full).isFile()) return false;
    fs.accessSync(full, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectEditors(): Promise<Editor[]> {
  const p = await shellPath();
  const found: Editor[] = [];
  for (const e of EDITORS) {
    for (const dir of p.split(':').filter(Boolean)) {
      const full = path.join(dir, e.bin);
      if (isExecutableFile(full)) { found.push({ ...e, path: full }); break; }
    }
  }
  return found;
}

const MAX_EDITOR_TARGET_CHARS = 32_768;
const MAX_EDITOR_PATH_CHARS = 8_192;
const MAX_EDITOR_LINE = 1_000_000;

/**
 * The code panel receives filenames from git and hook events, both of which
 * originate outside the renderer. Make the argument unambiguously a local,
 * absolute path before it becomes a CLI argument. Besides rejecting malformed
 * IPC, this prevents a value beginning with `-` from being interpreted as an
 * editor option.
 */
function normalizeEditorTarget(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EDITOR_TARGET_CHARS || value.includes('\0')) {
    throw new Error('Choose a valid local file or folder to open.');
  }
  return path.resolve(value);
}

function normalizeEditorLine(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_EDITOR_LINE) {
    throw new Error(`Choose a line number between 1 and ${MAX_EDITOR_LINE.toLocaleString()}.`);
  }
  return value;
}

/**
 * The renderer may choose among the launchers this process found, but never
 * supply a program to execute. Keep the returned spelling from discovery, not
 * the renderer's input, so `execFile` is always handed an allowlisted binary.
 */
function approvedEditorPath(requested: unknown, editors: Editor[]): string {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > MAX_EDITOR_PATH_CHARS || requested.includes('\0')) {
    throw new Error('Choose an editor detected by Wanigan.');
  }
  const normalized = path.resolve(requested);
  const editor = editors.find((candidate) => path.resolve(candidate.path) === normalized);
  if (!editor) throw new Error('That editor is no longer available. Refresh the editor list and choose one Wanigan detected.');
  return editor.path;
}

/**
 * Opens a project (and optionally a file, at a line) in an external editor.
 * Falls back to Finder when no CLI launcher is installed — a `code` shim is not
 * installed by default on macOS.
 */
export async function openInEditor(editorPath: string | null, target: string, line?: number) {
  const safeTarget = normalizeEditorTarget(target);
  const safeLine = normalizeEditorLine(line);
  if (editorPath === null) {
    // shell.openPath hands the path to LaunchServices, which decides what
    // "open" means for it. Confine it the way every other renderer-named path
    // in this module is confined.
    assertOpenablePath(safeTarget);
    const error = await shell.openPath(safeTarget);
    if (error) throw new Error(error);
    return { opened: 'finder' };
  }

  const safeEditorPath = approvedEditorPath(editorPath, await detectEditors());
  const args = safeLine === undefined ? [safeTarget] : ['--goto', `${safeTarget}:${safeLine}`];
  await exec(safeEditorPath, args, { env: { ...process.env, PATH: await shellPath() } });
  return { opened: safeEditorPath };
}

// Pure boundary helpers stay testable without launching Finder or a real editor.
export const __test = { isExecutableFile, normalizeEditorTarget, normalizeEditorLine, approvedEditorPath };

/* ── path safety ─────────────────────────────────────────────────────── */

/**
 * Every path from the renderer is resolved and confined to the project root.
 * Without this, `../../.ssh/id_rsa` is a readable file.
 */
function confine(root: string, rel: string): string {
  // The base is checked first: confining a relative path inside a root the
  // caller invented proves nothing about where the read lands.
  assertManagedRoot(root, 'That folder');
  const base = path.resolve(root);
  const full = path.resolve(base, rel || '.');
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Path is outside the project.');
  }
  return full;
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Files-panel reads are stricter than a lexical `..` check. A repository can
 * contain `secret -> ~/.ssh/id_rsa`; stat/readFile follow it and would turn a
 * harmless-looking in-project row into a local-file disclosure. Resolve both
 * ends and reject every symlink segment rather than promising a boundary that
 * a repo controls.
 */
function confineExisting(root: string, rel: string): string {
  const base = path.resolve(root);
  const full = confine(base, rel);
  const relative = path.relative(base, full);
  let cursor = base;
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error('Symlinked paths are not available in the Files panel. Open the target in your editor instead.');
    }
  }

  const realRoot = fs.realpathSync(base);
  const realTarget = fs.realpathSync(full);
  if (!isWithin(realRoot, realTarget)) throw new Error('Path is outside the project.');
  return realTarget;
}

/* ── git ─────────────────────────────────────────────────────────────── */

export type ChangedFile = {
  path: string; index: string; work: string; staged: boolean; untracked: boolean;
  /**
   * Already dirty when the session launched — not this agent's work. Left
   * undefined when there is no baseline to compare against: "we do not know
   * who changed this" and "the agent changed this" are different claims.
   */
  preexisting?: boolean;
  /** Committed since launch, so it no longer appears in git status. */
  committed?: boolean;
};

/**
 * The launch baseline, as it reaches this module.
 *
 * It arrives from the session accessor, which reads a live session while one
 * is running and its persisted row once it is not — so `dirty` can be absent
 * (an older row, a column that was never written) even when `head` is there.
 * This module treats that as unknown rather than as an empty list, because an
 * empty list silently attributes every pre-existing edit to the agent.
 */
export type ChangeBaseline = { head: string | null; dirty?: string[] | null } | null | undefined;

export type GitChanges = {
  isRepo: boolean; branch: string | null; files: ChangedFile[]; headMoved: boolean; commits: number;
  /** False when no baseline was available, so `preexisting` is unset throughout. */
  attributed: boolean;
  /** Set when git could not be read; the empty file list is not evidence of a clean tree. */
  unreadable: string | null;
};

/** Null means "no list", which is not the same as a list with nothing in it. */
function baselineDirty(baseline: ChangeBaseline): Set<string> | null {
  const dirty = baseline?.dirty;
  if (!Array.isArray(dirty)) return null;
  return new Set(dirty.filter((f): f is string => typeof f === 'string'));
}

export async function gitChanges(root: string, baseline?: ChangeBaseline): Promise<GitChanges> {
  // This one reaches git directly rather than through confine(), so it needs
  // the root check of its own.
  assertManagedRoot(root, 'That folder');
  const empty = { branch: null, files: [], headMoved: false, commits: 0 };

  const state = await repoState(root);
  if (state.kind === 'absent') return { isRepo: false, ...empty, attributed: false, unreadable: null };
  if (state.kind === 'unreadable') {
    // Not a repo and could-not-read used to be the same answer here, so a
    // timeout on a network share showed the panel's "Not a git repository".
    return { isRepo: true, ...empty, attributed: false, unreadable: state.reason };
  }
  const branch = state.kind === 'branch' ? state.branch : null;

  // A project can sit at a subdirectory of a bigger repository, and git answers
  // for the whole of it from anywhere inside. Unscoped, this panel listed every
  // other package's dirty files as though the session had touched them — and
  // offered a Revert button beside each one. The pathspec confines the read;
  // the prefix strip puts the paths back in the project's own terms, which is
  // what confine(), gitDiff() and revert all resolve against.
  const scope = await scopeOf(root);
  const sub = scope?.sub ? scope.sub.split(path.sep).join('/') : null;
  const scoped = (args: string[]) => (sub ? [...args, '--', '.'] : args);
  // git reports paths from the repository root whatever directory it was run
  // in, and the launch baseline was recorded in that same spelling — so the
  // match is made on git's path and only the returned one is rebased.
  const local = (file: string) => (sub && file.startsWith(sub + '/') ? file.slice(sub.length + 1) : file);

  const status = await runGit(root, scoped(['status', '--porcelain=v1', '-z']), { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  if (!status.ok) {
    return { isRepo: true, ...empty, branch, attributed: false, unreadable: status.err.split('\n')[0] || 'git status failed.' };
  }

  const dirty = baselineDirty(baseline);
  const files: ChangedFile[] = [];
  /** Paths as git spells them, so the committed pass does not list a file twice. */
  const seen = new Set<string>();
  // -z output is NUL-separated; renames carry a second NUL-separated path.
  const parts = status.out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const index = entry[0] ?? ' ';
    const work = entry[1] ?? ' ';
    const file = entry.slice(3);
    // A rename emits "XY <new>\0<old>\0". The extra part must be consumed so
    // the loop stays aligned, but the entry keeps the DESTINATION path: the
    // origin no longer exists, so listing or diffing it finds nothing.
    if (index === 'R' || index === 'C') i++;
    seen.add(file);
    files.push({
      path: local(file), index, work,
      staged: index !== ' ' && index !== '?',
      untracked: index === '?',
      // Dirty before the session started, so not this session's doing.
      preexisting: dirty ? dirty.has(file) : undefined,
    });
  }

  // Commits made since launch also belong to the session, and no longer show
  // up in `status` at all.
  let headMoved = false;
  let commits = 0;
  const base = baseline?.head;
  if (base && state.kind !== 'unborn') {
    const now = await head(root);
    headMoved = now !== null && now !== base;
    if (headMoved) {
      const count = await runGit(root, scoped(['rev-list', '--count', `${base}..HEAD`]), { timeout: 5_000, maxBuffer: 1024 * 1024 });
      commits = count.ok ? Number(count.out.trim()) || 0 : 0;
      const names = await runGit(root, scoped(['diff', '--name-only', '-z', `${base}..HEAD`]), { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
      // A baseline commit git cannot reach (a shallow clone, a rebased-away
      // head) leaves the committed files out rather than inventing them.
      for (const f of names.ok ? names.out.split('\0').filter(Boolean) : []) {
        if (seen.has(f)) continue;
        seen.add(f);
        files.push({ path: local(f), index: 'C', work: ' ', staged: true, untracked: false, preexisting: false, committed: true });
      }
    }
  }

  return { isRepo: true, branch, files, headMoved, commits, attributed: dirty !== null, unreadable: null };
}

export async function gitDiff(root: string, file: string): Promise<string> {
  confine(root, file);
  const opts = { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 };
  // Staged and unstaged together, so the pane shows the whole change.
  const tracked = await runGit(root, ['diff', 'HEAD', '--', file], opts);
  if (tracked.out.trim()) return tracked.out;
  // `--no-index` exits non-zero precisely when it found a difference, which is
  // the case this call exists for: the whole of a file git is not tracking yet.
  const untracked = await runGit(root, ['diff', '--no-index', '/dev/null', file], opts);
  return untracked.out || '';
}

/* ── file browsing ───────────────────────────────────────────────────── */

export type Entry = { name: string; rel: string; dir: boolean; size: number };

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'vendor', 'dist', 'build', '.cache', 'out']);

export function listDir(root: string, rel: string): Entry[] {
  // Keep the renderer-facing relative name on the path spelling the project
  // was added with. On macOS `/tmp` resolves to `/private/tmp`; returning the
  // latter as a relative path would make a safe project look like `../../…`
  // on the next click even though the realpath check is correct.
  const requested = confine(root, rel);
  const full = confineExisting(root, rel);
  const entries = fs.readdirSync(full, { withFileTypes: true });
  return entries
    // Do not render an entry that we would refuse to open. Besides making the
    // boundary obvious, this avoids a race where a directory entry becomes a
    // symlink between readdir and a later click.
    .filter((e) => !e.isSymbolicLink() && !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .map((e) => {
      const r = path.relative(path.resolve(root), path.join(requested, e.name));
      let size = 0;
      try { size = e.isFile() ? fs.statSync(path.join(full, e.name)).size : 0; } catch { /* race */ }
      return { name: e.name, rel: r, dir: e.isDirectory(), size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

const MAX_VIEW_BYTES = 1_500_000;

export function readProjectFile(root: string, rel: string): { text: string; truncated: boolean; size: number; binary: boolean } {
  const full = confineExisting(root, rel);
  const size = fs.statSync(full).size;
  const buf = fs.readFileSync(full, { encoding: null }).subarray(0, MAX_VIEW_BYTES);
  // A NUL byte in the first chunk is the cheap, reliable binary test.
  const binary = buf.subarray(0, 8000).includes(0);
  return {
    text: binary ? '' : buf.toString('utf8'),
    truncated: size > MAX_VIEW_BYTES,
    size,
    binary,
  };
}
