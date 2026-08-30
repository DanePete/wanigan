import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { shellPath } from './providers';

const exec = promisify(execFile);

/* ── editors ─────────────────────────────────────────────────────────── */

const EDITORS = [
  { id: 'code',    label: 'VS Code',  bin: 'code' },
  { id: 'cursor',  label: 'Cursor',   bin: 'cursor' },
  { id: 'windsurf',label: 'Windsurf', bin: 'windsurf' },
  { id: 'subl',    label: 'Sublime',  bin: 'subl' },
  { id: 'zed',     label: 'Zed',      bin: 'zed' },
];

export async function detectEditors(): Promise<{ id: string; label: string; path: string }[]> {
  const p = await shellPath();
  const found: { id: string; label: string; path: string }[] = [];
  for (const e of EDITORS) {
    for (const dir of p.split(':').filter(Boolean)) {
      const full = path.join(dir, e.bin);
      try { fs.accessSync(full, fs.constants.X_OK); found.push({ ...e, path: full }); break; } catch { /* next */ }
    }
  }
  return found;
}

/**
 * Opens a project (and optionally a file, at a line) in an external editor.
 * Falls back to Finder when no CLI launcher is installed — a `code` shim is not
 * installed by default on macOS.
 */
export async function openInEditor(editorPath: string | null, target: string, line?: number) {
  if (!editorPath) { shell.openPath(target); return { opened: 'finder' }; }
  const args = line ? ['--goto', `${target}:${line}`] : [target];
  await exec(editorPath, args, { env: { ...process.env, PATH: await shellPath() } });
  return { opened: editorPath };
}

/* ── path safety ─────────────────────────────────────────────────────── */

/**
 * Every path from the renderer is resolved and confined to the project root.
 * Without this, `../../.ssh/id_rsa` is a readable file.
 */
function confine(root: string, rel: string): string {
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
  /** Already dirty when the session launched — not this agent's work. */
  preexisting?: boolean;
  /** Committed since launch, so it no longer appears in git status. */
  committed?: boolean;
};

export async function gitChanges(
  root: string,
  baseline?: { head: string | null; dirty: string[] } | null
): Promise<{ isRepo: boolean; branch: string | null; files: ChangedFile[]; headMoved: boolean; commits: number }> {
  try {
    const { stdout: br } = await exec('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
    const { stdout } = await exec('git', ['-C', root, 'status', '--porcelain=v1', '-z'], {
      timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    });
    const files: ChangedFile[] = [];
    // -z output is NUL-separated; renames carry a second NUL-separated path.
    const parts = stdout.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      const index = entry[0] ?? ' ';
      const work = entry[1] ?? ' ';
      let file = entry.slice(3);
      if (index === 'R' || index === 'C') { i++; file = parts[i] ?? file; }
      files.push({
        path: file, index, work,
        staged: index !== ' ' && index !== '?',
        untracked: index === '?',
        // Dirty before the session started, so not this session's doing.
        preexisting: Boolean(baseline?.dirty?.includes(file)),
      });
    }

    // Commits made since launch also belong to the session, and no longer show
    // up in `status` at all.
    let headMoved = false;
    let commits = 0;
    if (baseline?.head) {
      try {
        const { stdout: nowHead } = await exec('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 5000 });
        headMoved = nowHead.trim() !== baseline.head;
        if (headMoved) {
          const { stdout: log } = await exec('git', ['-C', root, 'rev-list', '--count', `${baseline.head}..HEAD`], { timeout: 5000 });
          commits = Number(log.trim()) || 0;
          const { stdout: names } = await exec('git', ['-C', root, 'diff', '--name-only', '-z', `${baseline.head}..HEAD`], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
          for (const f of names.split('\0').filter(Boolean)) {
            if (!files.some((x) => x.path === f)) {
              files.push({ path: f, index: 'C', work: ' ', staged: true, untracked: false, preexisting: false, committed: true });
            }
          }
        }
      } catch { /* shallow clone or detached head */ }
    }

    return { isRepo: true, branch: br.trim() || null, files, headMoved, commits };
  } catch {
    return { isRepo: false, branch: null, files: [], headMoved: false, commits: 0 };
  }
}

export async function gitDiff(root: string, file: string): Promise<string> {
  confine(root, file);
  try {
    // Staged and unstaged together, so the pane shows the whole change.
    const { stdout } = await exec('git', ['-C', root, 'diff', 'HEAD', '--', file], {
      timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (stdout.trim()) return stdout;
    const { stdout: untracked } = await exec('git', ['-C', root, 'diff', '--no-index', '/dev/null', file], {
      timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
    return untracked || '';
  } catch (e) {
    const err = e as { stdout?: string };
    return err.stdout ?? '';
  }
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
