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

/* ── git ─────────────────────────────────────────────────────────────── */

export type ChangedFile = { path: string; index: string; work: string; staged: boolean; untracked: boolean };

export async function gitChanges(root: string): Promise<{ isRepo: boolean; branch: string | null; files: ChangedFile[] }> {
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
      });
    }
    return { isRepo: true, branch: br.trim() || null, files };
  } catch {
    return { isRepo: false, branch: null, files: [] };
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
  const full = confine(root, rel);
  const entries = fs.readdirSync(full, { withFileTypes: true });
  return entries
    .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .map((e) => {
      const r = path.relative(path.resolve(root), path.join(full, e.name));
      let size = 0;
      try { size = e.isFile() ? fs.statSync(path.join(full, e.name)).size : 0; } catch { /* race */ }
      return { name: e.name, rel: r, dir: e.isDirectory(), size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

const MAX_VIEW_BYTES = 1_500_000;

export function readProjectFile(root: string, rel: string): { text: string; truncated: boolean; size: number; binary: boolean } {
  const full = confine(root, rel);
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
