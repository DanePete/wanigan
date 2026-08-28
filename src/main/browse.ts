import { dialog, shell, app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSetting, setSetting } from './settings';
import { listProjects } from './store';

/**
 * The file explorer behind "attach a file".
 *
 * Two ways in, because they fail differently. The native dialog is the one
 * people reach for and it is the only one that can see the whole disk; the
 * in-app browser exists because the native dialog on macOS cannot be filtered
 * to "things Claude can actually read" in a way that explains *why* something
 * is greyed out. Here a rejected file is listed and labelled, which is the
 * difference between "this app is broken" and "that format is not supported".
 */

/* ── what Claude can actually open ──────────────────────────────────────
   Images are the strict list: the API accepts JPEG, PNG, GIF and WebP and
   nothing else. HEIC is the one that catches people, because it is what an
   iPhone produces and it looks like an image in every other tool. ---------- */

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const;
export const DOC_EXTS = ['pdf'] as const;
export const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml',
  'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'php', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cpp', 'sh', 'sql', 'log', 'diff', 'patch',
] as const;
export const NOTEBOOK_EXTS = ['ipynb'] as const;

/** Formats people try that Claude will refuse, so the refusal can be specific. */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  heic: 'HEIC is what an iPhone camera produces, and the API does not accept it. Export as PNG or JPEG first.',
  heif: 'HEIF is not accepted by the API. Export as PNG or JPEG first.',
  tiff: 'TIFF is not accepted by the API. Convert to PNG first.',
  tif:  'TIFF is not accepted by the API. Convert to PNG first.',
  bmp:  'BMP is not accepted by the API. Convert to PNG first.',
  svg:  'SVG is not accepted as an image. Rasterise it to PNG, or attach it as text to have the markup read instead.',
  avif: 'AVIF is not accepted by the API. Convert to PNG or WebP first.',
  psd:  'Photoshop files cannot be read. Export a flattened PNG.',
  docx: 'Word documents cannot be read directly. Export to PDF first.',
  xlsx: 'Spreadsheets cannot be read directly. Export to CSV first.',
  pptx: 'Slide decks cannot be read directly. Export to PDF first.',
  zip:  'Archives cannot be read. Extract it and attach the files you want.',
};

export type BrowseEntry = {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: number;
  /** Null for directories and for anything Wanigan has no opinion about. */
  kind: 'image' | 'pdf' | 'text' | 'notebook' | 'unsupported' | null;
  /** Why this one cannot be attached, when it cannot. */
  note: string | null;
  hidden: boolean;
};

export type BrowseResult = {
  dir: string;
  parent: string | null;
  entries: BrowseEntry[];
  /** Set when the directory could not be read at all. */
  error: string | null;
};

export function extOf(p: string): string {
  return path.extname(p).replace('.', '').toLowerCase();
}

export function kindOf(p: string): BrowseEntry['kind'] {
  const e = extOf(p);
  if ((IMAGE_EXTS as readonly string[]).includes(e)) return 'image';
  if ((DOC_EXTS as readonly string[]).includes(e)) return 'pdf';
  if ((NOTEBOOK_EXTS as readonly string[]).includes(e)) return 'notebook';
  if ((TEXT_EXTS as readonly string[]).includes(e)) return 'text';
  if (e in KNOWN_UNSUPPORTED) return 'unsupported';
  return null;
}

export function noteFor(p: string): string | null {
  return KNOWN_UNSUPPORTED[extOf(p)] ?? null;
}

/* ── native picker ───────────────────────────────────────────────────── */

/**
 * The filter list leads with everything attachable rather than with images,
 * so the default selection is not silently narrower than what the app accepts.
 */
const FILTERS = [
  { name: 'Everything Claude can read', extensions: [...IMAGE_EXTS, ...DOC_EXTS, ...NOTEBOOK_EXTS, ...TEXT_EXTS] },
  { name: 'Images', extensions: [...IMAGE_EXTS] },
  { name: 'PDF', extensions: [...DOC_EXTS] },
  { name: 'Text and code', extensions: [...TEXT_EXTS] },
  { name: 'All files', extensions: ['*'] },
];

export async function pickFiles(
  win: BrowserWindow | null,
  opts: { multi?: boolean; startIn?: string } = {}
): Promise<string[]> {
  const props: ('openFile' | 'multiSelections')[] = ['openFile'];
  if (opts.multi !== false) props.push('multiSelections');
  const res = win
    ? await dialog.showOpenDialog(win, {
        title: 'Attach files',
        buttonLabel: 'Attach',
        defaultPath: opts.startIn ?? lastDir(),
        properties: props,
        filters: FILTERS,
      })
    : await dialog.showOpenDialog({ properties: props, filters: FILTERS });
  if (res.canceled || !res.filePaths.length) return [];
  rememberDir(path.dirname(res.filePaths[0]));
  return res.filePaths;
}

export async function pickDirectory(win: BrowserWindow | null, title = 'Choose a folder'): Promise<string | null> {
  const res = win
    ? await dialog.showOpenDialog(win, {
        title, buttonLabel: 'Choose', defaultPath: lastDir(),
        properties: ['openDirectory', 'createDirectory'],
      })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  rememberDir(res.filePaths[0]);
  return res.filePaths[0];
}

/* ── in-app browser ──────────────────────────────────────────────────── */

/** Directories worth one click: the usual suspects plus every known project. */
export function places(): { label: string; path: string; kind: 'home' | 'project' | 'recent' }[] {
  const home = os.homedir();
  const std: { label: string; path: string; kind: 'home' }[] = [
    { label: 'Home', path: home, kind: 'home' },
    { label: 'Desktop', path: path.join(home, 'Desktop'), kind: 'home' },
    { label: 'Downloads', path: path.join(home, 'Downloads'), kind: 'home' },
    { label: 'Documents', path: path.join(home, 'Documents'), kind: 'home' },
    { label: 'Pictures', path: path.join(home, 'Pictures'), kind: 'home' },
  ];
  // A screenshot usually lands wherever macOS was told to put it, which is not
  // always Desktop; surfacing the configured location saves a hunt.
  const shots = app.getPath('pictures');
  if (shots && !std.some((s) => s.path === shots)) {
    std.push({ label: 'Screenshots', path: shots, kind: 'home' });
  }
  const projects = listProjects().map((p) => ({ label: p.name, path: p.path, kind: 'project' as const }));
  const recents = recentDirs().map((d) => ({ label: path.basename(d) || d, path: d, kind: 'recent' as const }));
  return [...std.filter((s) => exists(s.path)), ...projects, ...recents.filter((r) => exists(r.path))];
}

export function browse(dir: string, opts: { showHidden?: boolean } = {}): BrowseResult {
  const abs = path.resolve(dir);
  const parent = path.dirname(abs) === abs ? null : path.dirname(abs);

  let raw: fs.Dirent[];
  try {
    raw = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    return {
      dir: abs, parent, entries: [],
      error: code === 'EACCES'
        ? `macOS is not granting Wanigan access to ${path.basename(abs)}. Give it Files and Folders permission in System Settings → Privacy & Security.`
        : code === 'ENOENT'
          ? `${abs} no longer exists.`
          : `Could not read ${abs}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const entries: BrowseEntry[] = [];
  for (const d of raw) {
    const hidden = d.name.startsWith('.');
    if (hidden && !opts.showHidden) continue;
    const full = path.join(abs, d.name);
    let st: fs.Stats;
    // A broken symlink or a file that vanished mid-listing is normal, not an error.
    try { st = fs.statSync(full); } catch { continue; }
    const isDir = st.isDirectory();
    entries.push({
      name: d.name,
      path: full,
      dir: isDir,
      size: isDir ? 0 : st.size,
      modified: st.mtimeMs,
      kind: isDir ? null : kindOf(full),
      note: isDir ? null : noteFor(full),
      hidden,
    });
  }

  // Folders first, then newest — an attachment browser is almost always
  // looking for something taken in the last minute.
  entries.sort((a, b) =>
    a.dir !== b.dir ? (a.dir ? -1 : 1) : b.modified - a.modified
  );
  return { dir: abs, parent, entries, error: null };
}

/* ── handing off to the OS ───────────────────────────────────────────── */

/** Select the item in Finder, rather than opening it — different intent. */
export function revealInFinder(target: string): boolean {
  if (!exists(target)) return false;
  shell.showItemInFolder(path.resolve(target));
  return true;
}

export async function openExternally(target: string): Promise<string | null> {
  if (!exists(target)) return `${target} no longer exists.`;
  const err = await shell.openPath(path.resolve(target));
  return err || null;
}

/* ── small state ─────────────────────────────────────────────────────── */

const RECENT_KEY = 'browse_recent_dirs';
const RECENT_MAX = 6;

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function lastDir(): string {
  return recentDirs()[0] ?? os.homedir();
}

export function recentDirs(): string[] {
  try {
    const v = JSON.parse(getSetting(RECENT_KEY, '[]')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function rememberDir(dir: string) {
  const next = [dir, ...recentDirs().filter((d) => d !== dir)].slice(0, RECENT_MAX);
  setSetting(RECENT_KEY, JSON.stringify(next));
}


/* ── finding a repo by name ──────────────────────────────────────────────
   "Find the polaris project on my Mac" is a disk walk, and a disk walk with no
   ceiling is how a helpful feature becomes a spinning beachball. This one is
   bounded three ways — a fixed set of roots, a depth limit, and a hard cap on
   directories visited — and reports when it stopped early rather than implying
   it searched everywhere.
   ──────────────────────────────────────────────────────────────────────── */

export type FoundRepo = { name: string; path: string; depth: number; score: number };

const REPO_ROOTS = ['Projects', 'Code', 'src', 'Developer', 'Sites', 'work', 'repos', 'git', 'Documents', 'Desktop'];
const REPO_SKIP = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', 'out', 'target', 'Library',
  '.Trash', '.cache', 'Applications', '.npm', '.nvm', 'venv', '.venv', '__pycache__',
]);
const MAX_VISIT = 20_000;

function score(name: string, q: string): number {
  const n = name.toLowerCase(), s = q.toLowerCase();
  if (n === s) return 100;
  if (n.startsWith(s)) return 80;
  if (n.includes(s)) return 60;
  // Subsequence, so "lgh" still finds "lighthouse".
  let qi = 0;
  for (let i = 0; i < n.length && qi < s.length; i++) if (n[i] === s[qi]) qi++;
  return qi === s.length ? 30 : 0;
}

export function findRepos(
  query: string,
  opts: { roots?: string[]; limit?: number; maxDepth?: number } = {}
): { repos: FoundRepo[]; visited: number; truncated: boolean; roots: string[] } {
  const home = os.homedir();
  const roots = opts.roots?.length
    ? opts.roots.map((r) => path.resolve(r.replace(/^~/, home)))
    : [home, ...REPO_ROOTS.map((r) => path.join(home, r))].filter(exists);
  const limit = opts.limit ?? 20;
  const maxDepth = opts.maxDepth ?? 4;

  const found = new Map<string, FoundRepo>();
  let visited = 0;
  let truncated = false;

  const walk = (dir: string, depth: number) => {
    if (truncated || depth > maxDepth) return;
    if (++visited > MAX_VISIT) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // A directory containing .git is a repo; do not descend into it. Nested
    // repos exist, but walking into one turns a search for a project into a
    // search of its whole history of vendored dependencies.
    if (entries.some((e) => e.name === '.git')) {
      const name = path.basename(dir);
      const sc = score(name, query);
      if (sc > 0 && !found.has(dir)) found.set(dir, { name, path: dir, depth, score: sc });
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || REPO_SKIP.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.config') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  for (const r of roots) walk(r, 0);
  const repos = [...found.values()]
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { repos, visited, truncated, roots };
}
